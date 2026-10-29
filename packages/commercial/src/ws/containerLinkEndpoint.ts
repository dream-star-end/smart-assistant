import type { Queryable } from '../dispatch/turnDispatchStore.js'
import { getHostById } from '../compute-pool/queries.js'
import { hostRowToTarget } from '../compute-pool/nodeAgentClient.js'
import type { ResolveContainerEndpoint } from './userChatBridge.js'
import { getDesktopTunnelRegistry } from './desktopTunnelRegistry.js'

/** Exact existing carrier only. Recovery must never provision or recycle. */
export async function resolveContainerLinkEndpoint(pool: Queryable, channel: string, uid: bigint, containerId: number): Promise<Awaited<ReturnType<ResolveContainerEndpoint>> | 'pending' | null> {
  const result = await pool.query<{
    bound_ip: string | null; port: number | null; runtime_kind: string
    host_uuid: string | null; host_name: string | null; container_internal_id: string | null
  }>(
    `SELECT host(ac.bound_ip) AS bound_ip,ac.port,ac.runtime_kind,ac.host_uuid,ch.name AS host_name,ac.container_internal_id
       FROM agent_containers ac LEFT JOIN compute_hosts ch ON ch.id=ac.host_uuid
      WHERE ac.id=$1 AND ac.user_id=$2 AND ac.state='active' AND ac.runtime_channel=$3`,
    [containerId, String(uid), channel],
  )
  const row = result.rows[0]
  if (!row) return null
  if (row.runtime_kind === 'desktop') {
    return getDesktopTunnelRegistry().get(containerId) ? { host: 'desktop-reverse', port: 0, containerId, desktop: { containerId } } : 'pending'
  }
  if (!row.bound_ip || row.port === null) return null
  if (row.host_uuid && row.host_name !== 'self') {
    if (!row.container_internal_id) return null
    const host = await getHostById(row.host_uuid)
    if (!host || host.status === 'revoked') return null
    const nodeAgent = hostRowToTarget(host)
    nodeAgent.requireFingerprint = true
    return { host: row.bound_ip, port: row.port, containerId,
      tunnel: { hostId: row.host_uuid, containerInternalId: row.container_internal_id, nodeAgent } }
  }
  return { host: row.bound_ip, port: row.port, containerId }
}
