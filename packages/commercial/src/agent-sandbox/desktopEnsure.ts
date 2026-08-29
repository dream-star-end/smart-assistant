/**
 * Desktop ensureRunning counterpart: registry presence only, never provision.
 */

import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { getDesktopFlagSnapshot } from "../desktop/flags.js";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import type { DesktopEndpointHint } from "../ws/containerTransportKind.js";

export async function makeDesktopEnsureAttached(uid: bigint): Promise<{
  host: string;
  port: number;
  containerId: number;
  desktop: DesktopEndpointHint;
  coldStart: false;
} | null> {
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
