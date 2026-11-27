/**
 * Registers `RemoteEngineAdapter` with the gateway engine registry for `remote-driver-v4`.
 */
import '../engine/ccbFactory.js'
import '../engine/codexAdapter.js'
import '../engine/antigravityAdapter.js'
import {
  isUnifiedPoolSelfhostEnabled,
  registerRemoteDriverAdapter,
  registerUnifiedPoolAdapterWrapper,
} from '../engine/registry.js'
import { wrapEngineWithUnifiedPoolDriver } from '../inferencePool/livePoolDriverRuntime.js'
import { RemoteEngineAdapter } from './remoteEngineAdapter.js'

registerRemoteDriverAdapter((opts) => new RemoteEngineAdapter(opts))

/**
 * Installs the unified dual-pool adapter wrapper ONLY on selfhost product deployments
 * (`OC_SELFHOST_ENGINE_LOCAL_TURNS=1`, OCV5-915 B05). On non-selfhost / commercial
 * deployments the registry wrapper remains `undefined` (zero behavioral change).
 */
export function syncSelfhostUnifiedPoolAdapterWrapper(env?: NodeJS.ProcessEnv): boolean {
  if (isUnifiedPoolSelfhostEnabled(env)) {
    registerUnifiedPoolAdapterWrapper((adapter, ctx) =>
      wrapEngineWithUnifiedPoolDriver(adapter, ctx),
    )
    return true
  }
  registerUnifiedPoolAdapterWrapper(undefined)
  return false
}

syncSelfhostUnifiedPoolAdapterWrapper()
