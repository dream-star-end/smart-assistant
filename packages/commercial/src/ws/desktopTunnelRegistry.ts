/**
 * In-process desktop reverse-tunnel registry (P1 C-stage).
 * WSS register attach + mux openWs/http; mint/revoke/expiry call drop().
 */

import type { DesktopBridgedSocket, DesktopMuxSession, MuxHttpResponse } from "./desktopMux.js";
import { HEARTBEAT_TIMEOUT_MS } from "./desktopMux.js";

export interface DesktopTunnelMeta {
  deviceId: string;
  uid: number;
  expiresAt: Date;
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
  attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): void;
  get(containerId: number): DesktopTunnelSlot | undefined;
  drop(containerId: number, reason?: string): boolean;
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
}

class MemoryDesktopTunnelRegistry implements DesktopTunnelRegistry {
  private readonly slots = new Map<number, DesktopTunnelSlot & {
    handle: DesktopTunnelHandle | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>();

  attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): void {
    this.drop(containerId, "replaced");
    const ms = Math.max(0, meta.expiresAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.drop(containerId, "expired");
    }, ms);
    timer.unref?.();
    this.slots.set(containerId, {
      containerId,
      deviceId: meta.deviceId,
      uid: meta.uid,
      expiresAt: meta.expiresAt,
      attachedAt: new Date(),
      lastHeartbeatAt: new Date(),
      handle,
      timer,
    });
  }

  get(containerId: number): DesktopTunnelSlot | undefined {
    const s = this.slots.get(containerId);
    if (!s) return undefined;
    if (Date.now() - s.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_MS + 1_000) {
      this.drop(containerId, "heartbeat_stale");
      return undefined;
    }
    const { handle: _h, timer: _t, ...slot } = s;
    return slot;
  }

  drop(containerId: number, reason?: string): boolean {
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
    if (s) s.lastHeartbeatAt = new Date();
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

export function getDesktopTunnelRegistry(): DesktopTunnelRegistry {
  singleton ??= new MemoryDesktopTunnelRegistry();
  return singleton;
}

export function resetDesktopTunnelRegistryForTest(): MemoryDesktopTunnelRegistry {
  singleton?.dropAll("reset");
  singleton = new MemoryDesktopTunnelRegistry();
  return singleton;
}

export function createMemoryDesktopTunnelRegistry(): DesktopTunnelRegistry {
  return new MemoryDesktopTunnelRegistry();
}

export function markDesktopTunnelHeartbeat(containerId: number): void {
  getDesktopTunnelRegistry().markHeartbeat(containerId);
}
