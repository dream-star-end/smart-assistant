/** Host-only read port: canonical channel/migration query plus Docker/remote inspect, never ensure. */
import { getV3ContainerStatus, type V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import type { SystemStateReadSources } from './stateReadOperations.js'
import { SystemOperationRejected } from './operations.js'
export function makeSystemRuntimeStatusRead(deps: V3SupervisorDeps | undefined, inspect = getV3ContainerStatus): SystemStateReadSources['readRuntimeStatus'] {
  return async userId => {
    const uid = Number(userId)
    if (!deps || !Number.isSafeInteger(uid) || uid <= 0 || String(uid) !== userId) throw new SystemOperationRejected('UNAVAILABLE')
    const status = await inspect(deps, uid)
    return status ? { state: status.state, lastWsActivity: status.lastWsActivity } : null
  }
}
