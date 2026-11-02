/** Register after both classes initialize; the base adapter never imports its subclass. */
import { isCc5ExecutionBackend } from '@openclaude/protocol'
import { CcbAdapter } from './ccbAdapter.js'
import { Cc5InteractiveAdapter } from './cc5InteractiveAdapter.js'
import { registerEngine, type EngineCreateOpts } from './registry.js'

export function createCcbBackend(opts: EngineCreateOpts) {
  if (opts.executionBackend !== undefined) {
    if (!isCc5ExecutionBackend(opts.executionBackend)) throw new Error('CC5_BACKEND_SCOPE_INVALID')
    return new Cc5InteractiveAdapter(opts)
  }
  if (opts.cc5BridgePort) throw new Error('CC5_BACKEND_SCOPE_REQUIRED')
  return new CcbAdapter(opts)
}

registerEngine('ccb', createCcbBackend)
