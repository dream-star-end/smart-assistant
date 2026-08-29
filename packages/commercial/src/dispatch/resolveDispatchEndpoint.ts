/**
 * Load the running container for a durable dispatch by bound agent_container_id.
 * desktop → registry; miss → null (unreachable). NULL id falls back to uid+docker.
 */

import { getPool } from "../db/index.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import type { DispatchIdentity, RunningContainerEndpoint } from "./containerDispatchClient.js";

export async function resolveDispatchEndpoint(id: DispatchIdentity): Promise<RunningContainerEndpoint | null> {
  const pool = getPool();
  const channel = getRuntimeChannel();
  if (id.agentContainerId && Number.isInteger(id.agentContainerId) && id.agentContainerId > 0) {
    const r = await pool.query<{
      id: string;
      bound_ip: string | null;
      port: number | null;
      host_name: string | null;
      runtime_kind: string;
    }>(
      `SELECT ac.id::text AS id, host(ac.bound_ip) AS bound_ip, ac.port,
              ch.name AS host_name, ac.runtime_kind
         FROM agent_containers ac
         LEFT JOIN compute_hosts ch ON ch.id = ac.host_uuid
        WHERE ac.id = $1 AND ac.state = 'active' AND ac.runtime_channel = $2
        LIMIT 1`,
      [id.agentContainerId, channel],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.runtime_kind === "desktop") {
      if (!getDesktopTunnelRegistry().get(Number(row.id))) return null;
      return {
        host: "desktop-reverse",
        port: 0,
        containerId: Number(row.id),
        desktop: { containerId: Number(row.id) },
      };
    }
    if (!row.bound_ip || row.port === null) return null;
    const isRemoteHost = row.host_name !== null && row.host_name !== "self";
    return {
      host: row.bound_ip,
      port: Number(row.port),
      containerId: Number(row.id),
      ...(isRemoteHost ? { tunnel: { kind: "remote-host" as const } } : {}),
    };
  }
  const r = await pool.query<{
    id: string;
    bound_ip: string | null;
    port: number | null;
    host_name: string | null;
  }>(
    `SELECT ac.id::text AS id, host(ac.bound_ip) AS bound_ip, ac.port,
            ch.name AS host_name
       FROM agent_containers ac
       LEFT JOIN compute_hosts ch ON ch.id = ac.host_uuid
      WHERE ac.user_id = $1 AND ac.state = 'active' AND ac.runtime_channel = $2
        AND ac.runtime_kind = 'docker'
        AND ac.bound_ip IS NOT NULL AND ac.port IS NOT NULL
      ORDER BY ac.updated_at DESC LIMIT 1`,
    [id.uid.toString(), channel],
  );
  const row = r.rows[0];
  if (!row || !row.bound_ip || row.port === null) return null;
  const isRemoteHost = row.host_name !== null && row.host_name !== "self";
  return {
    host: row.bound_ip,
    port: Number(row.port),
    containerId: Number(row.id),
    ...(isRemoteHost ? { tunnel: { kind: "remote-host" as const } } : {}),
  };
}
