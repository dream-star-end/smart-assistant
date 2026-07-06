/**
 * Run Log — lightweight in-memory ring buffer for recent agent runs.
 *
 * Records key metrics per run: agent, session, task type, tool calls,
 * duration, cost, result state. Provides the data backing for the
 * `/api/doctor` diagnostic endpoint and future observability views.
 *
 * Not persisted to disk — only the last N runs are kept in memory.
 */

export interface RunLogEntry {
  id: string
  agentId: string
  sessionKey: string
  taskType: 'chat' | 'cron' | 'delegate' | 'webhook' | 'task' | 'inter-agent' | 'openai-compat'
  startedAt: number
  completedAt?: number
  durationMs?: number
  status: 'running' | 'completed' | 'failed' | 'timeout'
  // Metrics
  cost?: number
  inputTokens?: number
  outputTokens?: number
  turn?: number
  // Tool usage summary
  toolCalls?: string[] // tool names used in this run
  // Error info
  error?: string
  // ── P2 债C — hidden reviewer 硬编排打标 ──
  /** true = 本 run 是 gateway 硬编排触发的隐藏审查员委派(非用户/队长自发委派)。
   *  仅 taskType='delegate' 且 target 为隐藏审查员的硬编排 run 打此标,便于 doctor
   *  区分"审查开销"与普通委派开销。 */
  isReview?: boolean
  /** 审查 run 的结构化裁决(PASS / NEEDS_FIX)。解析不出裁决(降级/超时)→ undefined。
   *  仅 isReview run 有值。 */
  verdict?: string
}

const MAX_ENTRIES = 200

export class RunLog {
  private entries: RunLogEntry[] = []

  /** Start a new run, returns the entry for later update. */
  start(
    init: Pick<RunLogEntry, 'agentId' | 'sessionKey' | 'taskType'> &
      Partial<Pick<RunLogEntry, 'isReview'>>,
  ): RunLogEntry {
    const entry: RunLogEntry = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ...init,
      startedAt: Date.now(),
      status: 'running',
    }
    this.entries.push(entry)
    // Trim ring buffer
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES)
    }
    return entry
  }

  /** Complete a run with final metrics. */
  complete(
    entry: RunLogEntry,
    result: {
      status: 'completed' | 'failed' | 'timeout'
      cost?: number
      inputTokens?: number
      outputTokens?: number
      turn?: number
      toolCalls?: string[]
      error?: string
      /** 审查 run 的结构化裁决(PASS / NEEDS_FIX);非审查 run 省略。 */
      verdict?: string
    },
  ): void {
    entry.completedAt = Date.now()
    entry.durationMs = entry.completedAt - entry.startedAt
    entry.status = result.status
    entry.cost = result.cost
    entry.inputTokens = result.inputTokens
    entry.outputTokens = result.outputTokens
    entry.turn = result.turn
    entry.toolCalls = result.toolCalls
    entry.error = result.error
    if (result.verdict !== undefined) entry.verdict = result.verdict
  }

  /** Get recent entries (newest first). */
  recent(limit = 50): RunLogEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  /** Summary statistics. */
  summary(): {
    totalRuns: number
    running: number
    completed: number
    failed: number
    totalCost: number
    avgDurationMs: number
  } {
    let running = 0
    let completed = 0
    let failed = 0
    let totalCost = 0
    let totalDuration = 0
    let durationCount = 0

    for (const e of this.entries) {
      if (e.status === 'running') running++
      else if (e.status === 'completed') completed++
      else failed++
      if (e.cost) totalCost += e.cost
      if (e.durationMs) {
        totalDuration += e.durationMs
        durationCount++
      }
    }

    return {
      totalRuns: this.entries.length,
      running,
      completed,
      failed,
      totalCost: Math.round(totalCost * 10000) / 10000,
      avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
    }
  }
}
