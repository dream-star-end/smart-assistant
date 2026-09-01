/** Stable cursor-engine facade that can replace the underlying native CLI or
 * Sand/CCB runner when the model or primary sidecar route changes. */
import { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { GoalStateSnapshot, JobTerminal } from '@openclaude/protocol'
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
import { CursorSandAdapter, cursorSandEnabledForModel } from './cursorSandAdapter.js'

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

function variantFor(model: string | undefined): CursorVariant {
  return cursorSandEnabledForModel(model) ? 'sand' : 'native'
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
  private goal: GoalStateSnapshot | null = null
  private readonly innerListeners = new Map<string, (...args: unknown[]) => void>()

  constructor(opts: EngineCreateOpts) {
    super()
    this.opts = { ...opts }
    this.variant = variantFor(opts.model)
    this.inner = this.createInner(this.variant)
    this.bindInner()
  }

  get currentVariant(): CursorVariant { return this.variant }
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

  private async ensureVariant(): Promise<void> {
    const desired = variantFor(this.opts.model)
    if (desired === this.variant) return
    await this.inner.shutdown()
    await this.inner.waitForOutputDrain()
    this.unbindInner()
    this.variant = desired
    this.opts.resumeSessionId = undefined
    this.inner = this.createInner(desired)
    this.bindInner()
    if (this.goal) await this.inner.setGoalState(this.goal)
  }

  async start(): Promise<void> {
    await this.ensureVariant()
    await this.inner.start()
  }

  async preheat(): Promise<void> {
    await this.ensureVariant()
    if (this.inner.preheat) await this.inner.preheat()
    else await this.inner.start()
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    let innerRun: EngineTurnRun | null = null
    let ended = false
    let resolveSummary!: (summary: Awaited<EngineTurnRun['summary']>) => void
    const summary = new Promise<Awaited<EngineTurnRun['summary']>>((resolvePromise) => {
      resolveSummary = resolvePromise
    })
    const submitted = (async () => {
      try {
        await this.ensureVariant()
        innerRun = this.inner.submitTurn(params)
        if (ended) innerRun.end()
        void innerRun.summary.then(resolveSummary)
        await innerRun.submitted
      } catch (error) {
        resolveSummary(null)
        throw error
      }
    })()
    return {
      submitted,
      summary,
      end(): void { ended = true; innerRun?.end() },
      getPartialSnapshot: () => innerRun?.getPartialSnapshot() ?? structuredClone(EMPTY_SNAPSHOT),
      getPhantomSignals: () => innerRun?.getPhantomSignals() ?? { ...EMPTY_PHANTOM },
      get finalized(): boolean { return innerRun?.finalized ?? false },
      get pendingToolCalls(): number { return innerRun?.pendingToolCalls ?? 0 },
    }
  }

  interrupt(): boolean { return this.inner.interrupt() }
  async shutdown(): Promise<void> { await this.inner.shutdown() }
  waitForOutputDrain(): Promise<void> { return this.inner.waitForOutputDrain() }

  get nativeSessionId(): string | null {
    const id = this.inner.nativeSessionId
    return id && this.variant === 'sand' ? `${SAND_RESUME_PREFIX}${id}` : id
  }
  clearSessionId(): void {
    this.opts.resumeSessionId = undefined
    this.inner.clearSessionId()
  }

  setModel(model: string | undefined): void {
    this.opts.model = model
    if (variantFor(model) === this.variant) this.inner.setModel(model)
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
