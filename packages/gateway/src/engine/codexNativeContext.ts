import type { ContextObservation } from '@openclaude/protocol'
import { adoptCodexTurnTrace, bindCodexThreadTrace } from '../relayTrace.js'

type Measurement = { threadId: string; tokens: number; window: number }
type Pending = {
  threadId: string
  turnId?: string
  itemId?: string
  itemCompleted: boolean
  resolve: () => void
  reject: (error: Error) => void
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isCompaction = (item: Record<string, unknown> | undefined) =>
  item?.type === 'contextCompaction' || item?.type === 'context_compaction'

/** Current context is separate from the cumulative billing ledger. */
export class CodexNativeContext {
  private measured: Measurement | undefined
  private pending: Pending | undefined
  private retired: { threadId: string; turnId?: string } | undefined
  private automatic = new Map<string, number | undefined>()
  private completedItems = new Set<string>()

  constructor(private readonly emit: (event: ContextObservation) => void) {}

  get running(): boolean { return this.pending !== undefined }

  reset(): void {
    this.measured = undefined
    this.automatic.clear()
    this.completedItems.clear()
  }

  beginTurn(): void { this.automatic.clear(); this.completedItems.clear() }

  observeUsage(threadId: string | null, params: Record<string, unknown>): void {
    if (!threadId || params.threadId !== threadId) return
    const usage = record(params.tokenUsage)
    const last = record(usage?.last)
    const tokens = last?.totalTokens
    const window = usage?.modelContextWindow
    if (!count(tokens) || !count(window) || window === 0) {
      this.measured = undefined
      return
    }
    this.measured = { threadId, tokens, window }
    if (!this.running) this.pressure(this.measured)
  }

  private pressure(value: Measurement): void {
    const usedRatio = value.tokens / value.window
    if (usedRatio < 0.8) return
    this.emit({ kind: 'context_pressure', pressure: {
      engine: 'codex', scope: 'native_context', dimension: 'tokens',
      level: usedRatio >= 1 ? 'critical' : 'warning', usedRatio,
    } })
  }

  automaticItem(method: string, params: Record<string, unknown>, threadId: string | null): void {
    if (!threadId || params.threadId !== threadId) return
    const item = record(params.item)
    if (!isCompaction(item) || typeof item?.id !== 'string') return
    const key = `${params.turnId}:${item.id}`
    if (this.completedItems.has(key)) return
    if (method === 'item/started') {
      if (!this.automatic.has(key)) this.automatic.set(key, this.measured?.threadId === threadId ? this.measured.tokens : undefined)
    } else if (method === 'item/completed' && this.automatic.has(key)) {
      const beforeTokens = this.automatic.get(key)
      this.automatic.delete(key)
      this.completedItems.add(key)
      this.completed(beforeTokens)
    }
  }

  private completed(beforeTokens: number | undefined): void {
    this.measured = undefined
    this.emit({ kind: 'context_compacted', compaction: {
      engine: 'codex', scope: 'native_context', strategy: 'native_summary',
      ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    } })
  }

  /** Internal compaction turns must not resolve/adopt the user's turn. */
  notification(method: string, params: Record<string, unknown>): 'usage' | 'handled' | undefined {
    const turn = record(params.turn)
    const turnId = typeof params.turnId === 'string' ? params.turnId : turn?.id
    if (turnId && turnId === this.retired?.turnId && params.threadId === this.retired.threadId) return 'handled'
    const pending = this.pending
    if (!pending || params.threadId !== pending.threadId) return undefined
    if (method === 'turn/started' && typeof turnId === 'string') {
      pending.turnId = turnId
      adoptCodexTurnTrace(pending.threadId, turnId)
      return 'handled'
    }
    const item = record(params.item)
    if (method === 'item/started' && isCompaction(item) && typeof turnId === 'string') {
      if (pending.turnId && pending.turnId !== turnId) return 'handled'
      pending.turnId = turnId
      pending.itemId = typeof item?.id === 'string' ? item.id : undefined
      adoptCodexTurnTrace(pending.threadId, turnId)
    }
    if (!pending.turnId || turnId !== pending.turnId) return 'handled'
    if (method === 'thread/tokenUsage/updated') return 'usage'
    if (method === 'item/completed' && isCompaction(item) && pending.itemId && item?.id === pending.itemId) pending.itemCompleted = true
    if (method === 'turn/completed') {
      if (turn?.status === 'completed' && pending.itemCompleted) pending.resolve()
      else pending.reject(new Error(String(record(turn?.error)?.message ?? 'Native context compaction did not complete')))
    }
    return 'handled'
  }

  abort(error: Error): void { this.pending?.reject(error) }

  async compactIfNeeded(opts: {
    threadId: string | null
    traceId: string | undefined
    timeoutMs: number
    send: () => Promise<unknown>
    drainFailure: () => Promise<void>
  }): Promise<void> {
    const measured = this.measured
    if (!measured || measured.threadId !== opts.threadId || measured.tokens / measured.window < 0.8) return
    this.pressure(measured)
    const releaseTrace = bindCodexThreadTrace(measured.threadId, opts.traceId)
    let rejectWait!: (error: Error) => void
    const cancelled = new Promise<never>((_, reject) => { rejectWait = reject })
    const completed = new Promise<void>((resolve) => {
      this.pending = { threadId: measured.threadId, itemCompleted: false, resolve, reject: rejectWait }
    })
    const timer = setTimeout(() => rejectWait(new Error('Native context compaction timed out')), opts.timeoutMs)
    timer.unref?.()
    try {
      // Install both rejection handlers before sending. Timeout covers the ACK too.
      await Promise.race([Promise.all([completed, Promise.resolve().then(opts.send)]), cancelled])
      this.completed(measured.tokens)
    } catch (error) {
      // Keep routing usage until stdout closes; partial summary usage belongs to
      // this logical turn even when Stop or a timeout wins the race.
      await opts.drainFailure()
      throw error
    } finally {
      clearTimeout(timer)
      this.retired = this.pending ? { threadId: this.pending.threadId, turnId: this.pending.turnId } : undefined
      this.pending = undefined
      releaseTrace()
    }
  }
}
