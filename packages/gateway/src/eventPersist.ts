/**
 * Event persistence layer — subscribes to eventBus and writes every event
 * to the event_log table in SQLite. Also writes usage_log for turn.completed events.
 *
 * Call `startEventPersistence()` once during gateway boot.
 */
import { insertEvent, insertUsageLog } from '@openclaude/storage'
import type { GatewayEvent, TurnCompletedEvent, CostRecordedEvent } from '@openclaude/protocol'
import { eventBus } from './eventBus.js'
import { createLogger } from './logger.js'

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

export function startEventPersistence(): void {
  eventBus.on('*', (ev: GatewayEvent) => {
    // Extract peer/channel from sessionKey for audit trail
    const { peerId, channel } = extractPeerFromSessionKey(ev.sessionKey)

    // Fire-and-forget persist — don't block the event bus
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

    // For turn.completed, also write usage_log for per-turn cost tracking
    if (ev.type === 'turn.completed') {
      const te = ev as TurnCompletedEvent
      insertUsageLog({
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
      }).catch((err) => {
        log.warn('failed to insert usage_log', {}, err)
      })
    }
  })

  log.info('event persistence started')
}
