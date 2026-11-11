/**
 * Registers `RemoteEngineAdapter` with the gateway engine registry for `remote-driver-v4`.
 */
import { registerRemoteDriverAdapter } from '../engine/registry.js'
import { RemoteEngineAdapter } from './remoteEngineAdapter.js'

registerRemoteDriverAdapter((opts) => new RemoteEngineAdapter(opts))
