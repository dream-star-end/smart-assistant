/**
 * Desktop ensureRunning counterpart: registry presence only, never provision.
 *
 * Desktop endpoints have no PSK, so they do not use cloneResult/disposeSharedResult.
 * Docker still uses the existing sharedEnsureRunning singleflight instance (never a
 * new wrapper) so flag-off docker behavior stays on that same in-flight map.
 */

import { ContainerUnreadyError, type ResolveContainerEndpoint } from "../ws/userChatBridge.js";
import { getDesktopTunnelRegistry, type DesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { getDesktopFlagSnapshot, type DesktopFlagSnapshot } from "../desktop/flags.js";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import type { DesktopEndpointHint } from "../ws/containerTransportKind.js";
import { makeUidSingleflight } from "./ensureContainerSingleflight.js";
import { ownerHeartbeatIsFresh, type DesktopTunnelOwnerRow } from "../ws/desktopTunnelOwnerStore.js";
import { rootLogger } from "../logging/logger.js";
import {
  invalidateDesktopRowMiss,
  rememberDesktopRowMiss,
  resetDesktopEnsureCacheForTest,
  shouldSkipDesktopRowLookup,
} from "../desktop/desktopRowCache.js";

export { invalidateDesktopRowMiss, resetDesktopEnsureCacheForTest };

export type DesktopAttachedEndpoint = {
  host: string;
  port: number;
  containerId: number;
  desktop: DesktopEndpointHint;
  coldStart: false;
};

export interface DesktopEnsureAttachedDeps {
  flags?: () => Promise<DesktopFlagSnapshot>;
  findDesktopContainerId?: (uid: bigint) => Promise<number | null>;
  registry?: DesktopTunnelRegistry;
  now?: () => number;
  lookupOwner?: (containerId: number) => Promise<DesktopTunnelOwnerRow | null>;
  auditOwnedElsewhere?: (input: {
    uid: number;
    containerId: number;
    owner: DesktopTunnelOwnerRow;
    selfInstanceId: string;
  }) => Promise<void>;
}

async function defaultFindDesktopContainerId(uid: bigint): Promise<number | null> {
  const r = await query<{ id: string }>(
    `SELECT id::text AS id FROM agent_containers
      WHERE user_id = $1 AND state = 'active' AND runtime_kind = 'desktop' AND runtime_channel = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [uid.toString(), getRuntimeChannel()],
  );
  const id = r.rows[0] ? Number(r.rows[0].id) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function defaultAuditOwnedElsewhere(input: {
  uid: number;
  containerId: number;
  owner: DesktopTunnelOwnerRow;
  selfInstanceId: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO desktop_device_audit(user_id, event, container_id, extra)
       VALUES ($1,'desktop_owned_elsewhere',$2,$3::jsonb)`,
      [
        String(input.uid),
        input.containerId,
        JSON.stringify({
          ownerInstanceId: input.owner.instanceId,
          ownerInstanceAddr: input.owner.instanceAddr,
          selfInstanceId: input.selfInstanceId,
          generation: input.owner.generation,
        }),
      ],
    );
  } catch { /* best-effort */ }
}

export async function makeDesktopEnsureAttached(
  uid: bigint,
  deps: DesktopEnsureAttachedDeps = {},
): Promise<DesktopAttachedEndpoint | null> {
  const flags = await (deps.flags ?? getDesktopFlagSnapshot)();
  if (!flags.assembled || flags.killSwitch) return null;

  const now = deps.now ?? Date.now;
  const uidNum = Number(uid);
  if (shouldSkipDesktopRowLookup(uidNum, now())) return null;

  const find = deps.findDesktopContainerId ?? defaultFindDesktopContainerId;
  const id = await find(uid);
  if (id === null) {
    rememberDesktopRowMiss(uidNum, now());
    return null;
  }
  invalidateDesktopRowMiss(uidNum);

  const registry = deps.registry ?? getDesktopTunnelRegistry();
  const slot = registry.get(id);
  if (slot) {
    return {
      host: "desktop-reverse",
      port: 0,
      containerId: id,
      desktop: { containerId: id },
      coldStart: false,
    };
  }

  const owner = await (deps.lookupOwner ?? ((cid: number) => registry.lookupOwner(cid)))(id);
  if (owner && ownerHeartbeatIsFresh(owner, now()) && owner.instanceId !== registry.instanceId) {
    rootLogger.warn("desktop_owned_elsewhere", {
      uid: uidNum,
      containerId: id,
      ownerInstanceId: owner.instanceId,
      ownerInstanceAddr: owner.instanceAddr,
      selfInstanceId: registry.instanceId,
    });
    await (deps.auditOwnedElsewhere ?? defaultAuditOwnedElsewhere)({
      uid: uidNum,
      containerId: id,
      owner,
      selfInstanceId: registry.instanceId,
    });
    throw new ContainerUnreadyError(5, "desktop_owned_elsewhere");
  }

  throw new ContainerUnreadyError(5, "desktop_offline");
}

/**
 * Production composition root selector for **userChatBridge** (and other
 * surfaces that are allowed to prefer a live desktop tunnel).
 *
 * assembled + active desktop row → desktop (registry miss is desktop_offline,
 * never silent docker provision). Otherwise the caller-supplied docker ensure
 * (must be the existing sharedEnsureRunning instance).
 *
 * WeChat / QQ inbound must **not** use this. Design v2 §1.2 / §4.5.3: channel
 * inbound stays on the cloud docker container. Use `makeInboundChannelResolver`.
 */
export function makeDesktopOrDockerResolver(
  dockerEnsure: ResolveContainerEndpoint | undefined,
  desktopLookup: (uid: bigint) => Promise<DesktopAttachedEndpoint | null> = makeDesktopEnsureAttached,
): ResolveContainerEndpoint {
  const desktopEnsure = makeUidSingleflight(desktopLookup);
  return async (uid) => {
    const desktop = await desktopEnsure(uid);
    if (desktop) return desktop;
    if (dockerEnsure) return dockerEnsure(uid);
    throw new ContainerUnreadyError(5, "supervisor_not_wired");
  };
}

/**
 * Docker-only resolver for WeChat / QQ inbound (and container-local preview).
 *
 * Calls the existing sharedEnsureRunning singleflight instance (never a new
 * wrapper). A desktop endpoint is fail-closed: inbound must not be hijacked
 * onto `desktop-reverse` (SSRF) or `desktop_offline` (cold_start while docker
 * is healthy).
 */
export function makeInboundChannelResolver(
  dockerEnsure: ResolveContainerEndpoint | undefined,
): ResolveContainerEndpoint {
  const docker: ResolveContainerEndpoint = dockerEnsure
    ?? (async () => {
      throw new ContainerUnreadyError(5, "supervisor_not_wired");
    });
  return async (uid) => {
    const endpoint = await docker(uid);
    if (endpoint.desktop) {
      throw new ContainerUnreadyError(5, "desktop_not_allowed_for_inbound");
    }
    return endpoint;
  };
}
