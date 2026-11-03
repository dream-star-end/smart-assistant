/** Bound personal web route over one original interactive TUI; no pool selector. */
import { type Cc5ExecutionBackend, CC5_NATIVE_MODEL, isCc5ExecutionBackend, sameCc5ExecutionBackend } from '@openclaude/protocol'
import { createCc5BridgePort } from '../cc5BridgePort.js'
import { cc5ResumeId } from './cc5ResumeId.js'
import { CcbAdapter } from './ccbAdapter.js'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineCreateOpts } from './registry.js'

export class Cc5InteractiveAdapter extends CcbAdapter {
  override readonly engineId = 'ccb'
  declare readonly executionBackend: Cc5ExecutionBackend
  override readonly capabilities: EngineCapabilities = {
    billingMode: 'proxy',
    supportsEffort: false,
    resumeKind: 'ccb-session',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    supportsNativeCompact: false,
    multimodalInput: 'text-only',
  }
  private readonly cc5BindingId: string
  constructor(opts: EngineCreateOpts) {
    if (
      opts.model !== CC5_NATIVE_MODEL ||
      !isCc5ExecutionBackend(opts.executionBackend) ||
      opts.executionBackend.sessionKey !== opts.sessionKey ||
      opts.hermeticNoTools ||
      opts.advisorExecutionLock ||
      opts.delegationDepth ||
      opts.usageAttribution ||
      opts.executionTarget?.kind === 'remote' ||
      opts.resumeSessionId
    )
      throw new Error('CC5_TEST_PROFILE_UNSUPPORTED')
    const port = opts.cc5BridgePort ?? createCc5BridgePort(opts.sessionKey, opts.executionBackend!, opts.model!)
    super({
      ...opts,
      harness: 'official-cc',
      authorityEngine: 'ccb',
      boxResidentCc: true,
      cc5BridgePort: port,
      prepareBoxCc: undefined,
      providerEnvOverride: undefined,
      cursorCredentialSelection: undefined,
    })
    if (!sameCc5ExecutionBackend(port.executionBackend, opts.executionBackend) || port.canonicalModel !== opts.model) {
      throw new Error('CC5_BACKEND_BINDING_MISMATCH')
    }
    this.cc5BindingId = port.bindingId
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'session_id') {
      const native = args[0]
      if (typeof native !== 'string') throw new Error('CC5_NATIVE_SESSION_ID_INVALID')
      return super.emit(event, cc5ResumeId(this.cc5BindingId, native))
    }
    return super.emit(event, ...args)
  }
  override get nativeSessionId(): string | null {
    const id = super.nativeSessionId
    return id ? cc5ResumeId(this.cc5BindingId, id) : null
  }
  isResumeIdCompatible(id: string): boolean {
    return this.isRunning && id === this.nativeSessionId
  }
  override setResumeSessionId(id: string): void {
    if (this.isResumeIdCompatible(id)) return // Same live Writer; this does not restart or reattach.
    throw new Error('CC5_TEST_REMOTE_RESUME_UNSUPPORTED')
  }
  requiresReopenForModel(model: string | undefined): boolean {
    return model !== CC5_NATIVE_MODEL
  }
  override setModel(model: string | undefined): void {
    if (model !== CC5_NATIVE_MODEL) throw new Error('CC5_ROUTE_CHANGED_REOPEN_SESSION')
    super.setModel(model)
  }
  override preheat(): Promise<void> { return Promise.resolve() }
  override submitTurn(params: TurnParams): EngineTurnRun {
    if (
      params.readOnly ||
      params.consultTurn ||
      !params.modelAuthority ||
      !params.turnKey ||
      !sameCc5ExecutionBackend(params.modelAuthority.executionDescriptor.executionBackend, this.executionBackend) ||
      typeof params.input !== 'string'
    )
      throw new Error('CC5_TEST_TURN_UNSUPPORTED')
    return super.submitTurn(params)
  }
}
