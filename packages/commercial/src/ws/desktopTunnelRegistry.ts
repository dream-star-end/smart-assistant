/**
 * Desktop reverse-tunnel registry (P1 C-stage + W-05 owner directory).
 *
 * Mux handles stay in-process. Owner rows in PG (or an injected store) make
 * cross-instance miss fail-loud as desktop_owned_elsewhere instead of a
 * false desktop_offline. Flag off → owners is not wired → zero owner SQL.
 *
 * Owner SQL for a given containerId is serialized on a per-container promise
 * chain. DELETE is keyed by ownerEpoch so a delayed same-generation DELETE
 * cannot wipe a newer UPSERT (W05-IMPL-01).
 */

import type { DesktopBridgedSocket, DesktopMuxSession, MuxHttpResponse } from "./desktopMux.js";
import { HEARTBEAT_MIN_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from "./desktopMux.js";
import { isDesktopOwnerSqlEnabled, readDesktopInstanceAddr, readDesktopInstanceId } from "../desktop/instance.js";
import {
  createPgDesktopTunnelOwnerStore,
  DESKTOP_OWNER_STALE_MS,
  type DesktopTunnelOwnerRow,
  type DesktopTunnelOwnerStore,
} from "./desktopTunnelOwnerStore.js";
import { rootLogger } from "../logging/logger.js";

export interface DesktopTunnelMeta {
  deviceId: string;
  uid: number;
  expiresAt: Date;
  /** Token generation at attach time. drop(g) rejects later attach with generation ≤ g. */
  generation?: number;
}

export class DesktopTunnelGenerationError extends Error {
  constructor(
    readonly generation: number,
    readonly fence: number,
  ) {
    super(`desktop tunnel generation ${generation} <= fence ${fence}`);
    this.name = "DesktopTunnelGenerationError";
  }
}

export interface DesktopTunnelHandle {
  close?: (code?: number, reason?: string) => void;
  mux?: DesktopMuxSession;
}

export interface DesktopTunnelSlot extends DesktopTunnelMeta {
  containerId: number;
  attachedAt: Date;
  lastHeartbeatAt: Date;
}

export interface DesktopTunnelRegistry {
  readonly instanceId: string;
  readonly instanceAddr: string;
  attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): Promise<void>;
  get(containerId: number): DesktopTunnelSlot | undefined;
  drop(containerId: number, reason?: string, fenceGeneration?: number): boolean;
  dropAll(reason?: string): number;
  markHeartbeat(containerId: number): void;
  size(): number;
  openWs(containerId: number, subpath: string): DesktopBridgedSocket;
  http(
    containerId: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | Buffer | null,
    timeoutMs: number,
  ): Promise<MuxHttpResponse>;
  lookupOwner(containerId: number): Promise<DesktopTunnelOwnerRow | null>;
  sweepOwnInstance(): Promise<number>;
  retryPendingOwnerDeletes(now?: number): Promise<void>;
}

export interface DesktopTunnelRegistryOpts {
  instanceId?: string;
  instanceAddr?: string;
  owners?: DesktopTunnelOwnerStore | null;
}

type PendingDelete = {
  containerId: number;
  instanceId: string;
  generation: number;
  epoch: number;
  until: number;
};

class MemoryDesktopTunnelRegistry implements DesktopTunnelRegistry {
  readonly instanceId: string;
  readonly instanceAddr: string;
  private readonly owners: DesktopTunnelOwnerStore | null;
  private readonly slots = new Map<number, DesktopTunnelSlot & {
    handle: DesktopTunnelHandle | null;
    timer: ReturnType<typeof setTimeout> | null;
    generation: number;
    ownerEpoch: number;
    lastOwnerTouchAt: number;
  }>();
  /** drop(g) fence: any later attach with generation ≤ fence is rejected. */
  private readonly fence = new Map<number, number>();
  private readonly ownerIo = new Map<number, Promise<void>>();
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private epochClock = 0;

  constructor(opts: DesktopTunnelRegistryOpts = {}) {
    this.instanceId = opts.instanceId ?? readDesktopInstanceId();
    this.instanceAddr = opts.instanceAddr ?? readDesktopInstanceAddr();
    this.owners = opts.owners ?? null;
  }

  private nextOwnerEpoch(): number {
    const t = Date.now();
    this.epochClock = t <= this.epochClock ? this.epochClock + 1 : t;
    return this.epochClock;
  }

  private enqueueOwnerIo(containerId: number, fn: () => Promise<void>): Promise<void> {
    const prev = this.ownerIo.get(containerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.ownerIo.set(containerId, next.catch(() => {}));
    return next;
  }

  private pendingKey(containerId: number, epoch: number): string {
    return `${containerId}:${epoch}`;
  }

  private enqueueDelete(
    containerId: number,
    generation: number,
    epoch: number,
    reason?: string,
  ): void {
    if (!this.owners) return;
    const instanceId = this.instanceId;
    void this.enqueueOwnerIo(containerId, async () => {
      try {
        await this.owners!.deleteIfMatch(containerId, instanceId, generation, epoch);
        this.pendingDeletes.delete(this.pendingKey(containerId, epoch));
      } catch (err) {
        this.pendingDeletes.set(this.pendingKey(containerId, epoch), {
          containerId,
          instanceId,
          generation,
          epoch,
          until: Date.now() + DESKTOP_OWNER_STALE_MS,
        });
        rootLogger.warn("desktop_owner_delete_failed", {
          containerId,
          reason,
          err: (err as Error)?.message,
        });
      }
    });
  }

  async retryPendingOwnerDeletes(now = Date.now()): Promise<void> {
    if (!this.owners) return;
    for (const [key, p] of [...this.pendingDeletes]) {
      if (now > p.until) {
        this.pendingDeletes.delete(key);
        continue;
      }
      try {
        await this.enqueueOwnerIo(p.containerId, async () => {
          await this.owners!.deleteIfMatch(p.containerId, p.instanceId, p.generation, p.epoch);
          this.pendingDeletes.delete(key);
        });
      } catch { /* keep pending until until/sweep */ }
    }
  }

  async attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): Promise<void> {
    const generation = meta.generation ?? 0;
    const fence = this.fence.get(containerId) ?? -1;
    if (generation <= fence) {
      try { handle?.close?.(1008, "stale_generation"); } catch { /* */ }
      throw new DesktopTunnelGenerationError(generation, fence);
    }
    this.drop(containerId, "replaced");
    const ms = Math.max(0, meta.expiresAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.drop(containerId, "expired");
    }, ms);
    timer.unref?.();
    const now = new Date();
    const ownerEpoch = this.nextOwnerEpoch();
    this.slots.set(containerId, {
      containerId,
      deviceId: meta.deviceId,
      uid: meta.uid,
      expiresAt: meta.expiresAt,
      attachedAt: now,
      lastHeartbeatAt: now,
      handle,
      timer,
      generation,
      ownerEpoch,
      lastOwnerTouchAt: Date.now(),
    });
    if (this.owners) {
      try {
        await this.enqueueOwnerIo(containerId, () => this.owners!.upsert({
          agentContainerId: containerId,
          instanceId: this.instanceId,
          instanceAddr: this.instanceAddr,
          generation,
          ownerEpoch,
          attachedAt: now,
          lastHeartbeatAt: now,
        }));
      } catch (err) {
        this.drop(containerId, "owner_upsert_failed");
        throw err;
      }
    }
  }

  get(containerId: number): DesktopTunnelSlot | undefined {
    const s = this.slots.get(containerId);
    if (!s) return undefined;
    if (Date.now() - s.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_MS + 1_000) {
      this.drop(containerId, "heartbeat_stale");
      return undefined;
    }
    const { handle: _h, timer: _t, generation: _g, ownerEpoch: _e, lastOwnerTouchAt: _o, ...slot } = s;
    return slot;
  }

  drop(containerId: number, reason?: string, fenceGeneration?: number): boolean {
    if (fenceGeneration !== undefined) {
      const prev = this.fence.get(containerId) ?? -1;
      this.fence.set(containerId, Math.max(prev, fenceGeneration));
    }
    const s = this.slots.get(containerId);
    if (!s) return false;
    this.slots.delete(containerId);
    if (s.timer) clearTimeout(s.timer);
    try {
      s.handle?.mux?.close(reason ?? "dropped");
    } catch { /* ignore */ }
    try {
      s.handle?.close?.(4001, reason ?? "desktop_tunnel_dropped");
    } catch { /* ignore */ }
    this.enqueueDelete(containerId, s.generation, s.ownerEpoch, reason);
    return true;
  }

  dropAll(reason = "killswitch"): number {
    const ids = [...this.slots.keys()];
    for (const id of ids) this.drop(id, reason);
    return ids.length;
  }

  size(): number {
    return this.slots.size;
  }

  openWs(containerId: number, subpath: string): DesktopBridgedSocket {
    const mux = this.requireMux(containerId);
    const path = subpath.startsWith("/") ? subpath : `/${subpath}`;
    return mux.openWs(path);
  }

  http(
    containerId: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | Buffer | null,
    timeoutMs: number,
  ): Promise<MuxHttpResponse> {
    const mux = this.requireMux(containerId);
    return mux.http({
      method,
      path,
      headers,
      body,
      deadlineMs: Date.now() + timeoutMs,
    }, timeoutMs);
  }

  markHeartbeat(containerId: number): void {
    const s = this.slots.get(containerId);
    if (!s) return;
    const now = Date.now();
    s.lastHeartbeatAt = new Date(now);
    if (!this.owners) return;
    if (s.lastOwnerTouchAt > 0 && now - s.lastOwnerTouchAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    s.lastOwnerTouchAt = now;
    const at = s.lastHeartbeatAt;
    const epoch = s.ownerEpoch;
    const generation = s.generation;
    void this.enqueueOwnerIo(containerId, async () => {
      await this.retryPendingOwnerDeletes();
      await this.owners!.touchHeartbeat(containerId, this.instanceId, generation, epoch, at);
    }).catch((err: unknown) => {
      rootLogger.warn("desktop_owner_heartbeat_failed", {
        containerId,
        err: (err as Error)?.message,
      });
    });
  }

  async lookupOwner(containerId: number): Promise<DesktopTunnelOwnerRow | null> {
    if (!this.owners) return null;
    return this.owners.get(containerId);
  }

  async sweepOwnInstance(): Promise<number> {
    await this.retryPendingOwnerDeletes();
    if (!this.owners) return 0;
    return this.owners.sweepInstance(this.instanceId);
  }

  private requireMux(containerId: number): DesktopMuxSession {
    const s = this.slots.get(containerId);
    const mux = s?.handle?.mux;
    if (!s || !mux) {
      throw new Error(`desktop tunnel not attached: ${containerId}`);
    }
    return mux;
  }
}

let singleton: MemoryDesktopTunnelRegistry | null = null;

function defaultOwners(): DesktopTunnelOwnerStore | null {
  return isDesktopOwnerSqlEnabled() ? createPgDesktopTunnelOwnerStore() : null;
}

export function getDesktopTunnelRegistry(): DesktopTunnelRegistry {
  singleton ??= new MemoryDesktopTunnelRegistry({
    instanceId: readDesktopInstanceId(),
    instanceAddr: readDesktopInstanceAddr(),
    owners: defaultOwners(),
  });
  return singleton;
}

export function resetDesktopTunnelRegistryForTest(
  opts: DesktopTunnelRegistryOpts = {},
): MemoryDesktopTunnelRegistry {
  singleton?.dropAll("reset");
  singleton = new MemoryDesktopTunnelRegistry({
    instanceId: opts.instanceId ?? "test-self",
    instanceAddr: opts.instanceAddr ?? "127.0.0.1:18445",
    owners: opts.owners ?? null,
  });
  return singleton;
}

export function createMemoryDesktopTunnelRegistry(
  opts: DesktopTunnelRegistryOpts = {},
): DesktopTunnelRegistry {
  return new MemoryDesktopTunnelRegistry(opts);
}

export function markDesktopTunnelHeartbeat(containerId: number): void {
  getDesktopTunnelRegistry().markHeartbeat(containerId);
}

export async function sweepDesktopOwnersBeforeListen(
  registry: DesktopTunnelRegistry = getDesktopTunnelRegistry(),
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const n = await registry.sweepOwnInstance();
      if (n > 0) {
        rootLogger.info("desktop_owner_sweep", { swept: n, instanceId: registry.instanceId });
      }
      return;
    } catch (err) {
      lastErr = err;
      rootLogger.warn("desktop_owner_sweep_retry", {
        attempt: i + 1,
        attempts,
        err: (err as Error)?.message,
      });
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("desktop_owner_sweep_failed");
}
