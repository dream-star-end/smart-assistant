import { MEMORY_USAGE_PATH } from '@openclaude/protocol'
import {
  type MemoryUsageEventRow,
  listPendingMemoryUsageEvents,
  markMemoryUsageEventsReported,
} from '@openclaude/storage'

import { createLogger } from './logger.js'

export const MEMORY_USAGE_REPORT_PATH = MEMORY_USAGE_PATH
const BATCH_SIZE = 100
const INTERVAL_MS = 30_000
const TIMEOUT_MS = 10_000

const log = createLogger({ module: 'memoryUsageReporter' })

export interface MemoryUsageReportConfig {
  masterBaseUrl: string
  containerToken: string
}

export function readMemoryUsageReportConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryUsageReportConfig | null {
  if (env.OC_MEMORY_USAGE_REPORTING === '0') return null
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return null
  return { masterBaseUrl: base.replace(/\/+$/, ''), containerToken: token }
}

function toWire(event: MemoryUsageEventRow) {
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    sessionHash: event.sessionHash,
    agentId: event.agentId,
    turnIndex: event.turnIndex,
    operation: event.operation,
    memoryType: event.memoryType,
    outcome: event.outcome,
    policyReason: event.policyReason,
    retrievalMode: event.retrievalMode,
    resultCount: event.resultCount,
    latencyMs: event.latencyMs,
    queryHash: event.queryHash,
    queryChars: event.queryChars,
    topMatchHash: event.topMatchHash,
    freshnessGap: event.freshnessGap,
    timestamp: event.timestamp,
  }
}

export async function sendMemoryUsageBatch(
  events: MemoryUsageEventRow[],
  config: MemoryUsageReportConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<'sent' | 'retry' | 'drop'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${config.masterBaseUrl}${MEMORY_USAGE_REPORT_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.containerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: events.map(toWire) }),
      signal: controller.signal,
    })
    if (response.ok) return 'sent'
    if (
      response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500
    )
      return 'retry'
    return 'drop'
  } catch {
    return 'retry'
  } finally {
    clearTimeout(timer)
  }
}

export function startMemoryUsageReporter(
  input: {
    config?: MemoryUsageReportConfig | null
    fetchImpl?: typeof fetch
    intervalMs?: number
  } = {},
): { stop(): void; drain(): Promise<void> } | null {
  const config = input.config === undefined ? readMemoryUsageReportConfig() : input.config
  if (!config) return null
  let running = false
  let stopped = false
  const drain = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const events = await listPendingMemoryUsageEvents(BATCH_SIZE)
      if (events.length === 0) return
      const result = await sendMemoryUsageBatch(events, config, input.fetchImpl)
      if (result === 'sent' || result === 'drop') {
        await markMemoryUsageEventsReported(events.map((event) => event.eventId))
      }
      if (result === 'drop') {
        log.warn('memory usage batch rejected; dropping privacy-safe metadata', {
          events: events.length,
        })
      }
    } catch (err) {
      log.warn('memory usage report failed', {}, err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void drain(), input.intervalMs ?? INTERVAL_MS)
  timer.unref?.()
  void drain()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    drain,
  }
}
