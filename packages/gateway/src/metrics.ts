/**
 * Lightweight Prometheus-compatible metrics for the OpenClaude gateway.
 *
 * Zero dependencies — exposes /metrics in Prometheus text exposition format.
 * Feeds from the eventBus catch-all listener.
 */

import { eventBus } from './eventBus.js'
import { createLogger } from './logger.js'

const logger = createLogger({ module: 'metrics' })

// ── Counter ──
class Counter {
  private values = new Map<string, number>()

  inc(labels: Record<string, string> = {}, delta = 1): void {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + delta)
  }

  serialize(name: string, help: string): string {
    const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`]
    for (const [key, val] of this.values) {
      lines.push(`${name}${key} ${val}`)
    }
    return lines.join('\n')
  }
}

// ── Histogram (simple bucket-based) ──
class Histogram {
  private buckets: number[]
  private counts = new Map<string, number[]>()
  private sums = new Map<string, number>()
  private totals = new Map<string, number>()

  constructor(buckets: number[]) {
    this.buckets = buckets.sort((a, b) => a - b)
  }

  observe(value: number, labels: Record<string, string> = {}): void {
    const key = labelKey(labels)
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array(this.buckets.length + 1).fill(0))
      this.sums.set(key, 0)
      this.totals.set(key, 0)
    }
    const arr = this.counts.get(key)!
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) arr[i]++
    }
    arr[this.buckets.length]++ // +Inf bucket
    this.sums.set(key, this.sums.get(key)! + value)
    this.totals.set(key, this.totals.get(key)! + 1)
  }

  serialize(name: string, help: string): string {
    const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`]
    for (const [key, arr] of this.counts) {
      const labels = key // e.g. {agent="main"}
      const labelsInner = labels.slice(1, -1) // strip braces
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i]
        const sep = labelsInner ? ',' : ''
        lines.push(`${name}_bucket{${labelsInner}${sep}le="${le}"} ${arr[i]}`)
      }
      const sep = labelsInner ? ',' : ''
      lines.push(`${name}_bucket{${labelsInner}${sep}le="+Inf"} ${arr[this.buckets.length]}`)
      lines.push(`${name}_sum${key} ${this.sums.get(key)}`)
      lines.push(`${name}_count${key} ${this.totals.get(key)}`)
    }
    return lines.join('\n')
  }
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return '{}'
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}'
}

// ── Metrics instances ──

export const httpRequestsTotal = new Counter()
export const httpRequestDuration = new Histogram([10, 50, 100, 250, 500, 1000, 2500, 5000])

export const turnsTotal = new Counter()
export const turnDuration = new Histogram([500, 1000, 2500, 5000, 10000, 30000, 60000])
export const turnTokens = new Counter()

export const toolCallsTotal = new Counter()
export const costTotal = new Counter()

export const sessionsActive = { value: 0 }
export const sessionCrashesTotal = new Counter()

export const wsConnectionsTotal = new Counter()

// ── EventBus subscriber ──

let _metricsStarted = false

export function startMetricsCollection(): void {
  if (_metricsStarted) return
  _metricsStarted = true
  eventBus.on('turn.completed', (ev) => {
    const labels = { agent: ev.agentId }
    turnsTotal.inc(labels)
    turnDuration.observe(ev.durationMs ?? 0, labels)
    turnTokens.inc({ agent: ev.agentId, direction: 'input' }, ev.usage.inputTokens ?? 0)
    turnTokens.inc({ agent: ev.agentId, direction: 'output' }, ev.usage.outputTokens ?? 0)
    if (ev.usage.cacheReadTokens) turnTokens.inc({ agent: ev.agentId, direction: 'cache_read' }, ev.usage.cacheReadTokens)
  })

  // NOTE: tool.called events are not yet emitted by sessionManager.
  // toolCallsTotal will be wired when tool-level event emission is added.

  eventBus.on('cost.recorded', (ev) => {
    costTotal.inc({ agent: ev.agentId, model: ev.usage.model ?? 'unknown' }, ev.usage.costUsd ?? 0)
  })

  eventBus.on('session.crashed', (ev) => {
    sessionCrashesTotal.inc({ agent: ev.agentId })
  })

  logger.info('metrics collection started')
}

// ── Prometheus text exposition ──

export function serializeMetrics(): string {
  const sections: string[] = [
    httpRequestsTotal.serialize('oc_http_requests_total', 'Total HTTP requests'),
    httpRequestDuration.serialize('oc_http_request_duration_ms', 'HTTP request duration in ms'),
    turnsTotal.serialize('oc_turns_total', 'Total AI turns completed'),
    turnDuration.serialize('oc_turn_duration_ms', 'AI turn duration in ms'),
    turnTokens.serialize('oc_turn_tokens_total', 'Total tokens by direction'),
    toolCallsTotal.serialize('oc_tool_calls_total', 'Total tool calls by tool name'),
    costTotal.serialize('oc_cost_usd_total', 'Total cost in USD'),
    sessionCrashesTotal.serialize('oc_session_crashes_total', 'Total session crashes'),
    wsConnectionsTotal.serialize('oc_ws_connections_total', 'Total WebSocket connections'),
    `# HELP oc_sessions_active Currently active sessions`,
    `# TYPE oc_sessions_active gauge`,
    `oc_sessions_active ${sessionsActive.value}`,
  ]
  return sections.join('\n\n') + '\n'
}
