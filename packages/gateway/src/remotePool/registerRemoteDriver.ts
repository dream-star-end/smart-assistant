/**
 * Registers `RemoteEngineAdapter` with the gateway engine registry for `remote-driver-v4`.
 */
import '../engine/ccbFactory.js'
import '../engine/codexAdapter.js'
import { registerRemoteDriverAdapter } from '../engine/registry.js'
import { RemoteEngineAdapter } from './remoteEngineAdapter.js'

registerRemoteDriverAdapter((opts) => new RemoteEngineAdapter(opts))
