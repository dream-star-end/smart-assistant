/** Stable cursor-engine facade. One account-pool credential is bound at a
 * time; its admin-authored Sand flag pins the session transport while
 * same-transport credential failover preserves native history. */
import { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  cursorCredentialModelFamily,
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
import type { PartialSnapshot, PhantomSignals } from './engineEvents.js'
import type { EngineCreateOpts } from './registry.js'
import { CursorAdapter } from './cursorAdapter.js'
import { CursorSandAdapter } from './cursorSandAdapter.js'
import {
  cursorSandEnabledForSelection,
  selectCursorCredential,
  type CursorCredentialSelection,
} from './cursorCredentialSelection.js'

type CursorVariant = 'native' | 'sand'

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
const SAND_RESUME_PREFIX = 'sand-ccb:'

function variantFor(
  model: string | undefined,
  selection: CursorCredentialSelection,
): CursorVariant {
  return cursorSandEnabledForSelection(model, selection) ? 'sand' : 'native'
}

function resumeForVariant(resume: string | undefined, variant: CursorVariant): string | undefined {
  if (!resume) return undefined
  if (variant === 'sand') return resume.startsWith(SAND_RESUME_PREFIX)
    ? resume.slice(SAND_RESUME_PREFIX.length)
    : undefined
  return resume.startsWith(SAND_RESUME_PREFIX) ? undefined : resume
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
    this.variant = variantFor(opts.model, this.credentialSelection)
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
    }
    return variant === 'sand'
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
        if (event === 'session_id' && this.variant === 'sand' && typeof args[0] === 'string') {
          this.emit(event, `${SAND_RESUME_PREFIX}${args[0]}`)
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
    if (this.credentialNeedsRefresh) {
      const next = this.selectCredential({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        agentBaseDir: this.opts.agentBaseDir,
        model: this.opts.model,
      })
      const nextVariant = variantFor(this.opts.model, next)
      if (nextVariant !== this.variant) {
        throw new Error('CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION')
      }
      this.credentialNeedsRefresh = false
      if (next.keyName !== this.credentialSelection.keyName || next.slot !== this.credentialSelection.slot) {
        const nativeId = this.inner.nativeSessionId
        await this.inner.shutdown()
        await this.inner.waitForOutputDrain()
        this.assertLifecycle(generation)
        this.unbindInner()
        this.credentialSelection = next
        this.opts.cursorCredentialSelection = next
        this.opts.resumeSessionId = nativeId
          ? this.variant === 'sand' ? `${SAND_RESUME_PREFIX}${nativeId}` : nativeId
          : undefined
        this.inner = this.createInner(this.variant)
        this.bindInner()
        if (this.goal) await this.inner.setGoalState(this.goal)
        this.assertLifecycle(generation)
      }
    }
    const desired = variantFor(this.opts.model, this.credentialSelection)
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
    const cancel = (): boolean => {
      ended = true
      if (!innerRun) return true
      this.inner.interrupt()
      innerRun.end()
      return true
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
    if (variantFor(this.opts.model, this.credentialSelection) !== this.variant) return null
    const id = this.inner.nativeSessionId
    return id && this.variant === 'sand' ? `${SAND_RESUME_PREFIX}${id}` : id
  }
  clearSessionId(): void {
    this.opts.resumeSessionId = undefined
    this.inner.clearSessionId()
  }

  setModel(model: string | undefined): void {
    if (variantFor(model, this.credentialSelection) !== this.variant) {
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
  setExecutionTarget(target: ExecutionTarget): void {
    this.opts.executionTarget = target
    this.inner.setExecutionTarget(target)
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
