import type { PromptPrivacyPolicy } from '@openclaude/protocol'
import { withFreshPromptPrivacy, refreshRunnerPromptPrivacy, clearRunnerPromptPrivacy, type PromptPrivacyRunner } from '../promptPrivacyRuntime.js'
/** Stable cursor-engine facade. One account-pool credential is bound at a
 * time; its admin-authored Sand flag pins the session transport while
 * same-transport credential failover preserves native history. */
import { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  cursorCredentialModelFamily,
  cursorModelById,
  type GoalStateSnapshot,
  type JobTerminal,
} from '@openclaude/protocol'
import type { ExecutionTarget } from '../remoteTarget.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineTurnRun,
  TurnParams,
} from './engineAdapter.js'
import type { PartialSnapshot, PhantomSignals, TurnSummary } from './engineEvents.js'
import type { EngineCreateOpts } from './registry.js'
import {
  CursorAdapter,
  CURSOR_SAND_OFFICIAL_CC_RESUME_PREFIX,
  CURSOR_SAND_RESUME_PREFIX,
  cursorSandBoxCcResumeInnerId,
  cursorSandOfficialCcResumeInnerId,
  cursorSandResumeInnerId,
  CURSOR_SAND_BOX_CC_RESUME_PREFIX,
  isAnyCursorSandResumeId,
} from './cursorAdapter.js'
import { CursorSandAdapter } from './cursorSandAdapter.js'
import { CursorBoxCcAdapter } from './cursorBoxCcAdapter.js'
import { cursorBoxCcEnabled, cursorBoxCcFromMaster, cursorBoxCcSelectionEligible, isBoxInteractiveCatalogModel } from './cursorBoxCc.js'
import {
  cursorSandEnabledForSelection,
  masterBoxCredentialSelection,
  selectCursorCredential,
  type CursorCredentialSelection,
} from './cursorCredentialSelection.js'
import { createLogger } from '../logger.js'
import { _shutdownOriginFrames } from '../subprocessRunner.js'

const log = createLogger({ module: 'cursorRoutingAdapter' })

export type CursorVariant = 'native' | 'sand-ccb' | 'sand-official-cc' | 'sand-box-cc'

const FORWARDED_EVENTS = [
  'session_id',
  'spawn',
  'exit',
  'error',
  'parse_error',
  'overflow',
  'stderr',
  'activity',
  'external_billing',
  'task_notification',
  'task_notification_delivered',
] as const

const EMPTY_SNAPSHOT: PartialSnapshot = {
  assistantText: '', thinkingText: '', completedTools: [],
  assistantSegments: [], thinkingSegments: [], runtimeEvents: [],
}
const EMPTY_PHANTOM: PhantomSignals = { apiState: 'unknown', skipReason: null }
export function cursorOfficialCcEnabledForModel(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OC_CURSOR_SAND_OFFICIAL_CC !== '1') return false
  const family = cursorModelById(model)?.family
  return family === 'opus-5'
    || family === 'opus-4.8'
    || family === 'fable-5'
    || family === 'fable-5.1'
    || family === 'sonnet-5'
}

export function cursorVariantFor(
  model: string | undefined,
  selection: CursorCredentialSelection,
  executionTarget?: ExecutionTarget,
  env: NodeJS.ProcessEnv = process.env,
): CursorVariant {
  if (
    executionTarget?.kind !== 'remote'
    && cursorBoxCcEnabled(env)
    && cursorBoxCcSelectionEligible(selection)
    && isBoxInteractiveCatalogModel(model)
  ) return 'sand-box-cc'
  if (!cursorSandEnabledForSelection(model, selection)) return 'native'
  if (
    executionTarget?.kind !== 'remote'
    && cursorOfficialCcEnabledForModel(model, env)
  ) return 'sand-official-cc'
  return 'sand-ccb'
}

function resumeForVariant(resume: string | undefined, variant: CursorVariant): string | undefined {
  if (!resume) return undefined
  if (variant === 'sand-ccb') return cursorSandResumeInnerId(resume)
  if (variant === 'sand-official-cc') return cursorSandOfficialCcResumeInnerId(resume)
  if (variant === 'sand-box-cc') return cursorSandBoxCcResumeInnerId(resume)
  return isAnyCursorSandResumeId(resume) ? undefined : resume
}

function prefixResumeId(id: string, variant: CursorVariant): string {
  if (variant === 'sand-ccb') return `${CURSOR_SAND_RESUME_PREFIX}${id}`
  if (variant === 'sand-official-cc') return `${CURSOR_SAND_OFFICIAL_CC_RESUME_PREFIX}${id}`
  if (variant === 'sand-box-cc') return `${CURSOR_SAND_BOX_CC_RESUME_PREFIX}${id}`
  return id
}

export class CursorRoutingAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'cursor'
  private opts: EngineCreateOpts
  private inner: EngineAdapter
  private variant: CursorVariant
  private credentialSelection: CursorCredentialSelection
  private credentialNeedsRefresh = false
  private readonly selectCredential: typeof selectCursorCredential
  private goal: GoalStateSnapshot | null = null
  private promptPolicy: PromptPrivacyPolicy | undefined
  get promptPolicyFingerprint(): string | undefined { return (this.inner as EngineAdapter & PromptPrivacyRunner).promptPolicyFingerprint }
  get setPromptPrivacy(): ((policy: PromptPrivacyPolicy) => void) | undefined {
    return this.variant === 'native' ? undefined : this.applyPromptPrivacy
  }
  private readonly applyPromptPrivacy = (policy: PromptPrivacyPolicy): void => {
    this.promptPolicy = structuredClone(policy)
    const inner = this.inner as EngineAdapter & PromptPrivacyRunner
    if (!inner.setPromptPrivacy) throw new Error('常驻引擎缺少隐私刷新接口。')
    inner.setPromptPrivacy(policy)
  }
  clearPromptPrivacy(): void {
    this.promptPolicy = undefined
    ;(this.inner as EngineAdapter & PromptPrivacyRunner).clearPromptPrivacy?.()
  }
  assertPromptPrivacyStopped(): void {
    if (this.variant === 'native') return
    const inner = this.inner as EngineAdapter & PromptPrivacyRunner
    if (!inner.assertPromptPrivacyStopped) throw new Error('无法核验常驻引擎是否已停止。')
    inner.assertPromptPrivacyStopped()
  }
  private async withInnerPrivacy<T>(operation: (inner: EngineAdapter) => Promise<T>): Promise<T> {
    const inner = this.inner
    if (this.variant === 'native' || this.promptPolicy) return operation(inner)
    const generation = this.lifecycleGeneration
    return withFreshPromptPrivacy(inner, this.opts.sessionId, () => { this.assertLifecycle(generation); return operation(inner) })
  }

  private readonly innerListeners = new Map<string, (...args: unknown[]) => void>()
  private activeCancel: (() => boolean) | null = null
  private lifecycleGeneration = 0
  private lifecycleClosed = false
  private shutdownPromise: Promise<void> | null = null
  private readonly pendingLifecycle = new Set<Promise<unknown>>()
  private lifecycleTail: Promise<void> = Promise.resolve()

  constructor(
    opts: EngineCreateOpts,
    selector: typeof selectCursorCredential = selectCursorCredential,
  ) {
    super()
    this.selectCredential = selector
    // An interactive Box session (box-claude-*, local) gets its Box from the master; everything else
    // keeps a selection handed in, else selects from the pool.
    this.credentialSelection = cursorBoxCcFromMaster(opts.model, opts.executionTarget?.kind === 'remote')
      || opts.cursorCredentialSelection?.masterBox === true
      ? this.selectionFor(opts, opts.executionTarget, opts.cursorCredentialSelection)
      : opts.cursorCredentialSelection ?? selector({
        agentId: opts.agentId,
        sessionKey: opts.sessionKey,
        agentBaseDir: opts.agentBaseDir,
        model: opts.model,
      })
    this.opts = { ...opts, cursorCredentialSelection: this.credentialSelection }
    this.variant = cursorVariantFor(opts.model, this.credentialSelection, opts.executionTarget)
    this.inner = this.createInner(this.variant)
    this.bindInner()
  }

  /** An interactive Box session (box-claude-*, local) gets its Box from the master and selects no pool
   * slot; everything else selects from the pool. A selection handed in is kept while it is of the
   * kind this model and target need. */
  private selectionFor(
    opts: EngineCreateOpts,
    target: ExecutionTarget | undefined,
    given?: CursorCredentialSelection,
  ): CursorCredentialSelection {
    const fromMaster = cursorBoxCcFromMaster(opts.model, target?.kind === 'remote')
    if (given && (given.masterBox === true) === fromMaster) return given
    if (fromMaster) return masterBoxCredentialSelection()
    return this.selectCredential({
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      agentBaseDir: opts.agentBaseDir,
      model: opts.model,
    })
  }

  get currentVariant(): CursorVariant { return this.variant }
  get currentCredentialForTest(): CursorCredentialSelection { return { ...this.credentialSelection } }
  /** Deterministic test seam; production reaches the same gate through
   * start/preheat/submitTurn. */
  async refreshVariantForTest(): Promise<void> { await this.ensureVariant() }
  get capabilities(): EngineCapabilities { return this.inner.capabilities }

  private createInner(variant: CursorVariant): EngineAdapter {
    const innerOpts = {
      ...this.opts,
      resumeSessionId: resumeForVariant(this.opts.resumeSessionId, variant),
      harness: variant === 'sand-official-cc' || variant === 'sand-box-cc'
        ? 'official-cc' as const
        : 'ccb' as const,
      boxResidentCc: variant === 'sand-box-cc',
    }
    const inner = variant === 'native' ? new CursorAdapter(innerOpts)
      : variant === 'sand-box-cc' ? new CursorBoxCcAdapter(innerOpts) : new CursorSandAdapter(innerOpts)
    if (this.promptPolicy && variant !== 'native') {
      const setter = (inner as EngineAdapter & PromptPrivacyRunner).setPromptPrivacy
      if (!setter) throw new Error('常驻引擎缺少隐私刷新接口。')
      setter.call(inner, this.promptPolicy)
    }
    return inner
  }

  private bindInner(): void {
    for (const event of FORWARDED_EVENTS) {
      const listener = (...args: unknown[]): void => {
        if (event === 'external_billing') {
          const billing = args[0] as { status?: unknown; terminalCode?: unknown } | undefined
          // Re-select only when the credential itself was rejected. A plain
          // engine error (Sand 5xx, aborted stream, SIGKILL on restart, tool
          // failure) is not evidence against the account; re-selecting on it
          // used to hop the user's sessions between accounts every time the
          // wrapper cooldown flipped.
          if (billing?.status === 'unavailable') this.credentialNeedsRefresh = true
        }
        if (event === 'session_id' && this.variant !== 'native' && typeof args[0] === 'string') {
          this.emit(event, prefixResumeId(args[0], this.variant))
        } else {
          this.emit(event, ...args)
        }
      }
      this.innerListeners.set(event, listener)
      this.inner.on(event, listener)
    }
  }

  private unbindInner(): void {
    for (const [event, listener] of this.innerListeners) this.inner.off(event, listener)
    this.innerListeners.clear()
  }

  private assertLifecycle(generation: number): void {
    if (this.lifecycleClosed || generation !== this.lifecycleGeneration) {
      throw new Error('CURSOR_ROUTER_SHUTDOWN')
    }
  }

  private trackLifecycle<T>(promise: Promise<T>): Promise<T> {
    this.pendingLifecycle.add(promise)
    void promise.then(
      () => this.pendingLifecycle.delete(promise),
      () => this.pendingLifecycle.delete(promise),
    )
    return promise
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail
    let release!: () => void
    this.lifecycleTail = new Promise<void>((resolvePromise) => { release = resolvePromise })
    return previous.then(operation).finally(release)
  }

  private async ensureVariant(generation = this.lifecycleGeneration): Promise<void> {
    this.assertLifecycle(generation)
    if (this.credentialSelection.masterBox === true) {
      // No pool slot to re-observe or rotate: the master provides this session's Box when its control is prepared.
      this.credentialNeedsRefresh = false
    } else {
      let observedSelection: CursorCredentialSelection | null = null
      if (this.credentialSelection.poolGeneration !== 'legacy') {
        observedSelection = this.selectCredential({
          agentId: this.opts.agentId,
          sessionKey: this.opts.sessionKey,
          agentBaseDir: this.opts.agentBaseDir,
          model: this.opts.model,
        })
        if (
          observedSelection.poolGeneration !== this.credentialSelection.poolGeneration
          || observedSelection.keyName !== this.credentialSelection.keyName
          || observedSelection.slot !== this.credentialSelection.slot
          || observedSelection.accountId !== this.credentialSelection.accountId
          || observedSelection.keyFingerprint !== this.credentialSelection.keyFingerprint
          || observedSelection.sandEnabled !== this.credentialSelection.sandEnabled
        ) {
          this.credentialNeedsRefresh = true
        }
      }
      if (this.credentialNeedsRefresh) {
        const next = observedSelection ?? this.selectCredential({
          agentId: this.opts.agentId,
          sessionKey: this.opts.sessionKey,
          agentBaseDir: this.opts.agentBaseDir,
          model: this.opts.model,
        })
        const nextVariant = cursorVariantFor(this.opts.model, next, this.opts.executionTarget)
        if (nextVariant !== this.variant) {
          throw new Error('CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION')
        }
        this.credentialNeedsRefresh = false
        const sameCredential = next.accountId === this.credentialSelection.accountId
          && next.keyFingerprint === this.credentialSelection.keyFingerprint
          && next.credentialKind === this.credentialSelection.credentialKind
          && next.machineId === this.credentialSelection.machineId
        if (sameCredential) {
          // Same account, same secret bytes: only the pool projection moved
          // (a new immutable generation after an unrelated row update, a slot
          // renumbering after another account was removed). Pool generations
          // are never pruned, so the inner adapter can keep reading its bound
          // generation; adopt the new metadata without tearing down a live
          // CCB/Sand process mid-turn.
          if (
            next.poolGeneration !== this.credentialSelection.poolGeneration
            || next.slot !== this.credentialSelection.slot
            || next.keyName !== this.credentialSelection.keyName
          ) {
            log.info('cursor credential projection moved: adopting without recycle', {
              sessionKey: this.opts.sessionKey,
              accountId: next.accountId,
              from: { keyName: this.credentialSelection.keyName, poolGeneration: this.credentialSelection.poolGeneration },
              to: { keyName: next.keyName, poolGeneration: next.poolGeneration },
            })
            this.credentialSelection = next
            this.opts.cursorCredentialSelection = next
          }
        } else {
          const nativeId = this.inner.nativeSessionId
          log.info('cursor credential switch: recycling inner adapter', {
            sessionKey: this.opts.sessionKey,
            variant: this.variant,
            from: { keyName: this.credentialSelection.keyName, accountId: this.credentialSelection.accountId },
            to: { keyName: next.keyName, accountId: next.accountId },
            innerRunning: this.inner.isRunning,
          })
          await this.inner.shutdown()
          await this.inner.waitForOutputDrain()
          this.assertLifecycle(generation)
          this.unbindInner()
          this.credentialSelection = next
          this.opts.cursorCredentialSelection = next
          this.opts.resumeSessionId = nativeId ? prefixResumeId(nativeId, this.variant) : undefined
          this.inner = this.createInner(this.variant)
          this.bindInner()
          if (this.goal) await this.inner.setGoalState(this.goal)
          this.assertLifecycle(generation)
        }
      }
    }
    const desired = cursorVariantFor(this.opts.model, this.credentialSelection, this.opts.executionTarget)
    if (desired === this.variant) return
    // Neither native Cursor nor Sand exposes a side-effect-free, billable
    // compaction/export surface. Never swap a live session's underlying
    // protocol; the caller must reopen on the desired variant.
    throw new Error('CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION')
  }

  async start(): Promise<void> {
    const generation = this.lifecycleGeneration
    await this.trackLifecycle(this.withLifecycleLock(async () => {
      await this.ensureVariant(generation)
      this.assertLifecycle(generation)
      await this.withInnerPrivacy(inner => inner.start())
      this.assertLifecycle(generation)
    }))
  }

  async preheat(): Promise<void> {
    const generation = this.lifecycleGeneration
    await this.trackLifecycle(this.withLifecycleLock(async () => {
      await this.ensureVariant(generation)
      this.assertLifecycle(generation)
      if (this.inner.preheat) await this.withInnerPrivacy(inner => inner.preheat!())
      else await this.withInnerPrivacy(inner => inner.start())
      this.assertLifecycle(generation)
    }))
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    const generation = this.lifecycleGeneration
    let innerRun: EngineTurnRun | null = null
    let privacyLeaseInner: (EngineAdapter & PromptPrivacyRunner) | null = null
    const releasePrivacy = (): void => { if (privacyLeaseInner) clearRunnerPromptPrivacy(privacyLeaseInner); privacyLeaseInner = null }
    let ended = false
    let resolveSummary!: (summary: Awaited<EngineTurnRun['summary']>) => void
    const summary = new Promise<Awaited<EngineTurnRun['summary']>>((resolvePromise) => {
      resolveSummary = resolvePromise
    })
    const clearActiveCancel = (): void => {
      if (this.activeCancel === cancel) this.activeCancel = null
    }
    // Cooperative cancel only: never force-finalize a live inner run. A
    // synchronous end() would short-circuit the session's Stop grace window
    // and leave a hung CCB/Sand process alive for the next turn. Shutdown of
    // the inner adapter is what settles an unanswered run.
    const cancel = (): boolean => {
      ended = true
      if (!innerRun) return true
      return this.inner.interrupt()
    }
    this.activeCancel = cancel
    const submitted = this.trackLifecycle(this.withLifecycleLock(async () => {
      try {
        await this.ensureVariant(generation)
        this.assertLifecycle(generation)
        if (ended) {
          resolveSummary(null)
          clearActiveCancel()
          return
        }
        if (this.variant !== 'native' && !this.promptPolicy) {
          privacyLeaseInner = this.inner
          await refreshRunnerPromptPrivacy(privacyLeaseInner, this.opts.sessionId)
          this.assertLifecycle(generation)
        }
        if (ended) { releasePrivacy(); resolveSummary(null); clearActiveCancel(); return }
        innerRun = this.inner.submitTurn(params)
        void innerRun.summary.then((result) => {
          releasePrivacy()
          resolveSummary(result)
          clearActiveCancel()
        }, () => { releasePrivacy(); resolveSummary(null); clearActiveCancel() })
        await innerRun.submitted
      } catch (error) {
        releasePrivacy()
        resolveSummary(null)
        clearActiveCancel()
        throw error
      }
    }))
    return {
      submitted,
      summary,
      end(): void {
        ended = true
        innerRun?.end()
        if (!innerRun) {
          resolveSummary(null)
          clearActiveCancel()
        }
      },
      getPartialSnapshot: () => innerRun?.getPartialSnapshot() ?? structuredClone(EMPTY_SNAPSHOT),
      getPhantomSignals: () => innerRun?.getPhantomSignals() ?? { ...EMPTY_PHANTOM },
      get finalized(): boolean { return innerRun?.finalized ?? false },
      get pendingToolCalls(): number { return innerRun?.pendingToolCalls ?? 0 },
    }
  }

  interrupt(): boolean { return this.activeCancel?.() ?? this.inner.interrupt() }
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // Outermost engine-facade shutdown: this is the frame SessionManager /
    // server call into, so the synchronous stack here names the real trigger.
    log.info('cursor routing adapter shutdown requested', {
      sessionKey: this.opts.sessionKey,
      variant: this.variant,
      hasActiveRun: this.activeCancel !== null,
      origin: _shutdownOriginFrames(new Error().stack),
    })
    this.lifecycleClosed = true
    this.lifecycleGeneration++
    this.activeCancel?.()
    this.shutdownPromise = (async () => {
      try {
        await Promise.allSettled([...this.pendingLifecycle])
        await this.inner.shutdown()
      } finally {
        // shutdown is also used for same-session model/toolset recycle. Calls
        // that entered during the closed window remain stale (second bump),
        // while a later turn may restart the retained inner adapter.
        this.lifecycleGeneration++
        this.lifecycleClosed = false
        this.activeCancel = null
        this.shutdownPromise = null
      }
    })()
    return this.shutdownPromise
  }
  waitForOutputDrain(): Promise<void> { return this.inner.waitForOutputDrain() }

  get nativeSessionId(): string | null {
    if (cursorVariantFor(this.opts.model, this.credentialSelection, this.opts.executionTarget) !== this.variant) return null
    const id = this.inner.nativeSessionId
    return id ? prefixResumeId(id, this.variant) : id
  }
  isResumeIdCompatible(sessionId: string): boolean {
    return resumeForVariant(sessionId, this.variant) !== undefined
  }
  clearSessionId(): void {
    this.opts.resumeSessionId = undefined
    this.inner.clearSessionId()
  }
  setResumeSessionId(sessionId: string): void {
    // Prefixed id (sand-ccb:/sand-official-cc:/bare native) must match the
    // live variant; a foreign-variant id is a clear, not a steer.
    const inner = resumeForVariant(sessionId, this.variant)
    if (!inner) { this.clearSessionId(); return }
    this.opts.resumeSessionId = sessionId
    this.inner.setResumeSessionId?.(inner)
  }

  requiresReopenForModel(model: string | undefined): boolean {
    return cursorVariantFor(model, this.credentialSelection, this.opts.executionTarget) !== this.variant
  }
  isUserCancellationResult(summary: TurnSummary): boolean {
    return this.inner.isUserCancellationResult?.(summary) ?? false
  }
  setModel(model: string | undefined): void {
    if (this.requiresReopenForModel(model)) {
      throw new Error('CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION')
    }
    const familyChanged = cursorCredentialModelFamily(this.opts.model)
      !== cursorCredentialModelFamily(model)
    this.opts.model = model
    this.inner.setModel(model)
    if (familyChanged) this.credentialNeedsRefresh = true
  }
  get model(): string | undefined { return this.opts.model }
  setEffortLevel(level: string | undefined): void {
    this.opts.effortLevel = level
    this.inner.setEffortLevel(level)
  }
  get effortLevel(): string | undefined { return this.opts.effortLevel }
  setTraceId(traceId: string | undefined): void {
    this.opts.traceId = traceId
    this.inner.setTraceId(traceId)
  }
  async setGoalState(goal: GoalStateSnapshot | null): Promise<void> {
    this.goal = goal ? structuredClone(goal) : null
    await this.inner.setGoalState(this.goal)
  }
  updateConfig(config: OpenClaudeConfig): void {
    this.opts.config = config
    this.inner.updateConfig(config)
  }
  setToolsets(toolsets: string[] | undefined): void {
    this.opts.agentToolsets = toolsets
    this.inner.setToolsets(toolsets)
  }
  get toolsets(): string[] | undefined { return this.opts.agentToolsets }
  async setExecutionTarget(target: ExecutionTarget): Promise<void> {
    // Moving a box-claude-* session between local and remote changes where its Box comes from
    // (master vs pool). Select first: a failed pool selection throws before anything is torn down.
    const selection = this.selectionFor(this.opts, target, this.credentialSelection)
    const selectionChanged = selection !== this.credentialSelection
    const desired = cursorVariantFor(this.opts.model, selection, target)
    if (desired === this.variant && !selectionChanged) {
      this.opts.executionTarget = target
      await this.inner.setExecutionTarget(target)
      return
    }

    // Official Claude Code is deliberately local-only; remote Cursor Sand
    // uses CCB. SessionManager has already drained/shut down the old inner and
    // cleared its incompatible resume id before this setter runs. Replace the
    // transport atomically instead of throwing after that destructive cleanup.
    await this.inner.shutdown()
    await this.inner.waitForOutputDrain()
    this.unbindInner()
    this.opts.executionTarget = target
    this.opts.resumeSessionId = undefined
    this.credentialSelection = selection
    this.opts.cursorCredentialSelection = selection
    this.credentialNeedsRefresh = false
    this.variant = desired
    this.inner = this.createInner(desired)
    this.bindInner()
    if (this.goal) await this.inner.setGoalState(this.goal)
  }
  get executionTarget(): ExecutionTarget { return this.inner.executionTarget }
  sendPermissionResponse(requestId: string, response: unknown): boolean {
    return this.inner.sendPermissionResponse(requestId, response)
  }

  getPartialSnapshot(): PartialSnapshot { return this.inner.getPartialSnapshot() }
  get pendingToolCalls(): number { return this.inner.pendingToolCalls }
  get waitingForUserInput(): boolean | undefined { return this.inner.waitingForUserInput }
  get isRunning(): boolean { return this.inner.isRunning }
  get lastActivityAt(): number { return this.inner.lastActivityAt }
  set lastActivityAt(value: number) { this.inner.lastActivityAt = value }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this.inner.getBoundRepoBinding()
  }
  writeDelegateTerminal(
    event: JobTerminal,
    body: string,
  ): Promise<{ ok: boolean; processAlive: boolean; unknown?: boolean }> {
    return this.inner.writeDelegateTerminal
      ? this.inner.writeDelegateTerminal(event, body)
      : Promise.resolve({ ok: false, processAlive: this.inner.isRunning })
  }
}
