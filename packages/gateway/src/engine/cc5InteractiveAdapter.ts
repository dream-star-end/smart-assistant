/** Temporary one-round live personal web route; never constructs a pool selector. */
import { isCc5TestModel } from '@openclaude/protocol'
import { createCc5BridgePort } from '../cc5BridgePort.js'
import { cc5ResumeId } from './cc5ResumeId.js'
import { CcbAdapter } from './ccbAdapter.js'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineCreateOpts } from './registry.js'

export class Cc5InteractiveAdapter extends CcbAdapter {
  override readonly engineId = 'cursor'
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
      !isCc5TestModel(opts.model) ||
      opts.hermeticNoTools ||
      opts.advisorExecutionLock ||
      opts.delegationDepth ||
      opts.usageAttribution ||
      opts.executionTarget?.kind === 'remote' ||
      opts.resumeSessionId
    )
      throw new Error('CC5_TEST_PROFILE_UNSUPPORTED')
    const port = opts.cc5BridgePort ?? createCc5BridgePort(opts.sessionKey)
    super({
      ...opts,
      harness: 'official-cc',
      authorityEngine: 'cursor',
      boxResidentCc: true,
      cc5BridgePort: port,
      prepareBoxCc: undefined,
      providerEnvOverride: undefined,
      cursorCredentialSelection: undefined,
    })
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
  isResumeIdCompatible(_id: string): boolean {
    return false
  }
  override setResumeSessionId(_id: string): void {
    throw new Error('CC5_TEST_REMOTE_RESUME_UNSUPPORTED')
  }
  requiresReopenForModel(model: string | undefined): boolean {
    return !isCc5TestModel(model)
  }
  override setModel(model: string | undefined): void {
    if (!isCc5TestModel(model)) throw new Error('CC5_ROUTE_CHANGED_REOPEN_SESSION')
    super.setModel(model)
  }
  override submitTurn(params: TurnParams): EngineTurnRun {
    if (
      params.readOnly ||
      params.consultTurn ||
      !params.modelAuthority ||
      !params.turnKey ||
      typeof params.input !== 'string'
    )
      throw new Error('CC5_TEST_TURN_UNSUPPORTED')
    return super.submitTurn(params)
  }
}
