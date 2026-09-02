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
  cursorSandOfficialCcResumeInnerId,
  cursorSandResumeInnerId,
  isAnyCursorSandResumeId,
} from './cursorAdapter.js'
import { CursorSandAdapter } from './cursorSandAdapter.js'
import {
  cursorSandEnabledForSelection,
  selectCursorCredential,
  type CursorCredentialSelection,
} from './cursorCredentialSelection.js'

export type CursorVariant = 'native' | 'sand-ccb' | 'sand-official-cc'

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
}

export function cursorVariantFor(
  model: string | undefined,
  selection: CursorCredentialSelection,
  executionTarget?: ExecutionTarget,
  env: NodeJS.ProcessEnv = process.env,
): CursorVariant {
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
  return isAnyCursorSandResumeId(resume) ? undefined : resume
}

function prefixResumeId(id: string, variant: CursorVariant): string {
  if (variant === 'sand-ccb') return `${CURSOR_SAND_RESUME_PREFIX}${id}`
  if (variant === 'sand-official-cc') return `${CURSOR_SAND_OFFICIAL_CC_RESUME_PREFIX}${id}`
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
    this.credentialSelection = opts.cursorCredentialSelection ?? selector({
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
      harness: variant === 'sand-official-cc' ? 'official-cc' as const : 'ccb' as const,
    }
    return variant !== 'native'
      ? new CursorSandAdapter(innerOpts)
      : new CursorAdapter(innerOpts)
  }

  private bindInner(): void {
    for (const event of FORWARDED_EVENTS) {
      const listener = (...args: unknown[]): void => {
        if (event === 'external_billing') {
          const billing = args[0] as { status?: unknown; terminalCode?: unknown } | undefined
          if (
            billing?.status !== 'success'
            && billing?.terminalCode !== 'USER_CANCELLED'
          ) this.credentialNeedsRefresh = true
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
      if (
        next.keyName !== this.credentialSelection.keyName
        || next.slot !== this.credentialSelection.slot
        || next.poolGeneration !== this.credentialSelection.poolGeneration
        || next.accountId !== this.credentialSelection.accountId
        || next.keyFingerprint !== this.credentialSelection.keyFingerprint
      ) {
        const nativeId = this.inner.nativeSessionId
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
      await this.inner.start()
      this.assertLifecycle(generation)
    }))
  }

  async preheat(): Promise<void> {
    const generation = this.lifecycleGeneration
    await this.trackLifecycle(this.withLifecycleLock(async () => {
      await this.ensureVariant(generation)
      this.assertLifecycle(generation)
      if (this.inner.preheat) await this.inner.preheat()
      else await this.inner.start()
      this.assertLifecycle(generation)
    }))
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    const generation = this.lifecycleGeneration
    let innerRun: EngineTurnRun | null = null
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
        innerRun = this.inner.submitTurn(params)
        void innerRun.summary.then((result) => {
          resolveSummary(result)
          clearActiveCancel()
        })
        await innerRun.submitted
      } catch (error) {
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
    const desired = cursorVariantFor(this.opts.model, this.credentialSelection, target)
    if (desired === this.variant) {
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
