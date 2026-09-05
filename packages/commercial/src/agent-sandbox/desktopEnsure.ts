/**
 * Desktop ensureRunning counterpart: registry presence only, never provision.
 *
 * Desktop endpoints have no PSK, so they do not use cloneResult/disposeSharedResult.
 * Docker still uses the existing sharedEnsureRunning singleflight instance (never a
 * new wrapper) so flag-off docker behavior stays on that same in-flight map.
 */

import { ContainerUnreadyError, type ResolveContainerEndpoint } from "../ws/userChatBridge.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { getDesktopFlagSnapshot } from "../desktop/flags.js";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import type { DesktopEndpointHint } from "../ws/containerTransportKind.js";
import { makeUidSingleflight } from "./ensureContainerSingleflight.js";

export type DesktopAttachedEndpoint = {
  host: string;
  port: number;
  containerId: number;
  desktop: DesktopEndpointHint;
  coldStart: false;
};

export async function makeDesktopEnsureAttached(uid: bigint): Promise<DesktopAttachedEndpoint | null> {
  const flags = await getDesktopFlagSnapshot();
  if (!flags.assembled || flags.killSwitch) return null;
  const r = await query<{ id: string }>(
    `SELECT id::text AS id FROM agent_containers
      WHERE user_id = $1 AND state = 'active' AND runtime_kind = 'desktop' AND runtime_channel = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [uid.toString(), getRuntimeChannel()],
  );
  const id = r.rows[0] ? Number(r.rows[0].id) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  const slot = getDesktopTunnelRegistry().get(id);
  if (!slot) {
    throw new ContainerUnreadyError(5, "desktop_offline");
  }
  return {
    host: "desktop-reverse",
    port: 0,
    containerId: id,
    desktop: { containerId: id },
    coldStart: false,
  };
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
