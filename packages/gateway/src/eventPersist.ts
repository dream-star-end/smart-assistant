/**
 * Event persistence layer — subscribes to eventBus and writes every event
 * to the event_log table in SQLite. Also writes usage_log for turn.completed
 * events (including abnormal terminals: crashed / stopped / timeout / …).
 *
 * Call `startEventPersistence()` once during gateway boot.
 */
import { insertEvent, insertUsageLog } from '@openclaude/storage'
import type { GatewayEvent, TurnCompletedEvent } from '@openclaude/protocol'
import { eventBus } from './eventBus.js'
import { createLogger } from './logger.js'
import {
  usageLogConflictTotal,
  usageLogDuplicateTotal,
  usageLogFailedTotal,
  usageLogInsertedTotal,
} from './metrics.js'

const log = createLogger({ module: 'eventPersist' })

/** User-facing channels — internal session types (cron, webhook, task, delegation) are excluded. */
const USER_CHANNELS = new Set(['webchat', 'telegram', 'wechat', 'feishu', 'openai'])

/**
 * Extract peerId and channel from a sessionKey.
 * Only parses user-facing session types (dm/group on known channels),
 * ignores internal keys (cron, webhook, task, delegation).
 */
function extractPeerFromSessionKey(sk?: string): { peerId?: string; channel?: string } {
  if (!sk) return {}
  const parts = sk.split(':')
  // agent:<id>:<channel>:<kind>:<peerId>
  if (parts.length >= 5 && parts[0] === 'agent'
    && USER_CHANNELS.has(parts[2])
    && (parts[3] === 'dm' || parts[3] === 'group')) {
    return { channel: parts[2], peerId: parts.slice(4).join(':') }
  }
  return {}
}

export function persistGatewayEvent(ev: GatewayEvent): void {
  const { peerId, channel } = extractPeerFromSessionKey(ev.sessionKey)

  insertEvent({
    id: ev.id,
    type: ev.type,
    timestamp: ev.timestamp,
    agentId: ev.agentId,
    sessionKey: ev.sessionKey,
    schemaVersion: ev.schemaVersion,
    payload: JSON.stringify(ev),
    peerId,
    channel,
  }).catch((err) => {
    log.warn('failed to insert event', { type: ev.type }, err)
  })

  if (ev.type === 'turn.completed') {
    void persistTurnCompletedUsage(ev as TurnCompletedEvent).catch(() => {
      /* persistTurnCompletedUsage already logs at error */
    })
  }
}

/** Awaitable usage_log write for tests and the reconcile path. */
export async function persistTurnCompletedUsage(te: TurnCompletedEvent): Promise<void> {
  const terminalStatus = te.terminalStatus ?? 'completed'
  try {
    const result = await insertUsageLog({
      id: te.id,
      sessionId: te.sessionKey,
      agentId: te.agentId,
      turnIndex: te.turnIndex,
      model: te.usage.model,
      inputTokens: te.usage.inputTokens,
      outputTokens: te.usage.outputTokens,
      cacheReadTokens: te.usage.cacheReadTokens ?? 0,
      cacheCreationTokens: te.usage.cacheCreationTokens ?? 0,
      costUsd: te.usage.costUsd ?? 0,
      durationMs: te.durationMs,
      toolCalls: te.toolCalls,
      timestamp: te.timestamp,
      terminalStatus,
    })
    if (result.status === 'inserted') {
      usageLogInsertedTotal.inc({ status: terminalStatus })
      return
    }
    if (result.conflict) {
      usageLogConflictTotal.inc({ status: terminalStatus })
      log.error('usage_log insert ignored: conflicting row already exists', {
        sessionId: te.sessionKey,
        turnIndex: te.turnIndex,
        terminalStatus,
      })
      return
    }
    usageLogDuplicateTotal.inc({ status: terminalStatus })
    log.info('usage_log insert ignored: idempotent duplicate', {
      sessionId: te.sessionKey,
      turnIndex: te.turnIndex,
      terminalStatus,
    })
  } catch (err) {
    usageLogFailedTotal.inc({ status: terminalStatus })
    log.error('failed to insert usage_log', {
      sessionId: te.sessionKey,
      turnIndex: te.turnIndex,
      terminalStatus,
    }, err)
    throw err
  }
}

export function startEventPersistence(): void {
  eventBus.on('*', persistGatewayEvent)
  log.info('event persistence started')
}
