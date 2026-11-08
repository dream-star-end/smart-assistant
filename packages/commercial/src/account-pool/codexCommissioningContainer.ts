/**
 * Container identity for Codex commissioning.
 *
 * It must come from the same source the live remote lane uses when it admits a
 * lane, not from a bespoke query:
 *   - userChatBridge resolves the endpoint's `containerId` to `agent_containers.id`
 *     (ws/containerLinkEndpoint.ts:13-16) and hands it to cc5 admission
 *     (ws/userChatBridge.ts:3238);
 *   - v3 ensureRunning returns `status.containerId` and the tunnel's
 *     `containerInternalId` (agent-sandbox/v3ensureRunning.ts:744);
 *   - both are read by `getV3ContainerStatus` from the v3 row: `id` and
 *     `container_internal_id` while `state='active'` and `runtime_kind='docker'`
 *     (agent-sandbox/v3supervisor.ts:4128, 4244-4247), which is also how
 *     index.ts answers container-status reads for the same uid (index.ts:4478).
 *
 * The v2 columns `status` / `docker_id` are never written by the v5 provisioner
 * (provision writes `container_internal_id`, v3supervisor.ts:3692-3705), so
 * gating commissioning on them rejected every live selfhost container with
 * CODEX_COMMISSION_CONTAINER_NOT_RUNNING. The v2 `docker_id` column stays
 * empty on selfhost rows; `status` keeps its legacy default 'provisioning'.
 *
 * Fail-closed: an absent row, a non-running inspect state, a provisioning row
 * (empty docker id), or an incomplete identity all resolve to null, and the
 * caller rejects with CONTAINER_NOT_RUNNING. Nothing is taken from the request.
 */
import { getV3ContainerStatus, type V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'

export interface CommissionContainer {
  /** `agent_containers.id` as text — the same containerDbId the lane admission uses. */
  containerDbId: string
  /** Full docker container id — `agent_containers.container_internal_id`. */
  dockerId: string
}

export type CommissionContainerSource = () => Promise<CommissionContainer | null>

/** Selfhost admin container source backed by the authoritative v3 runtime status. */
export function makeAdminCommissionContainerSource(
  deps: V3SupervisorDeps,
  uid = 3,
): CommissionContainerSource {
  return async () => {
    const status = await getV3ContainerStatus(deps, uid)
    // state already folds in docker inspect: stopped/missing/provisioning are all unusable.
    if (!status || status.state !== 'running') return null
    if (!/^[1-9][0-9]*$/.test(String(status.containerId))) return null
    if (!/^[a-f0-9]{64}$/.test(status.dockerContainerId)) return null
    return { containerDbId: String(status.containerId), dockerId: status.dockerContainerId }
  }
}
