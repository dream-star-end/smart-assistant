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
}

const MAX_ENTRIES = 200

export class RunLog {
  private entries: RunLogEntry[] = []

  /** Start a new run, returns the entry for later update. */
  start(init: Pick<RunLogEntry, 'agentId' | 'sessionKey' | 'taskType'>): RunLogEntry {
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
