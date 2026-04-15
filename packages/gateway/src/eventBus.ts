/**
 * Lightweight in-process event bus for OpenClaude gateway.
 *
 * Now backed by the unified TypeBox event schemas from @openclaude/protocol.
 * Provides typed emit/on/off with a '*' catch-all for cross-cutting concerns.
 *
 * This is intentionally simple — just a typed EventEmitter wrapper.
 * No distributed messaging, no persistence, no replay.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  GatewayEvent,
  GatewayEventType,
  CronFiredEvent,
  WebhookReceivedEvent,
  TaskCreatedEvent,
  TaskDeletedEvent,
  AgentDelegatedEvent,
  AgentCompletedEvent,
  SessionCrashedEvent,
  TurnCompletedEvent,
  ToolCalledEvent,
  MemoryHitEvent,
  VerificationResultEvent,
  CostRecordedEvent,
} from '@openclaude/protocol'
import { EVENTS_SCHEMA_VERSION } from '@openclaude/protocol'

// ── Event type → payload mapping ────────────────
type EventPayloadMap = {
  'cron.fired': CronFiredEvent
  'webhook.received': WebhookReceivedEvent
  'task.created': TaskCreatedEvent
  'task.deleted': TaskDeletedEvent
  'agent.delegated': AgentDelegatedEvent
  'agent.completed': AgentCompletedEvent
  'session.crashed': SessionCrashedEvent
  'turn.completed': TurnCompletedEvent
  'tool.called': ToolCalledEvent
  'memory.hit': MemoryHitEvent
  'verification.result': VerificationResultEvent
  'cost.recorded': CostRecordedEvent
  /** Catch-all: receives every event */
  '*': GatewayEvent
}

export class GatewayEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  /** Emit a typed event. Also fires the '*' catch-all. */
  emit<K extends GatewayEventType>(
    type: K,
    event: Extract<GatewayEvent, { type: K }>,
  ): void {
    this.emitter.emit(type, event)
    this.emitter.emit('*', event)
  }

  /** Subscribe to a specific event type. */
  on<K extends keyof EventPayloadMap>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as any)
    return this
  }

  /** Subscribe once. */
  once<K extends keyof EventPayloadMap>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this {
    this.emitter.once(event, listener as any)
    return this
  }

  /** Unsubscribe. */
  off<K extends keyof EventPayloadMap>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as any)
    return this
  }

  /** Number of listeners for a given event. */
  listenerCount(event: keyof EventPayloadMap): number {
    return this.emitter.listenerCount(event)
  }
}

/** Singleton instance — shared across the gateway process. */
export const eventBus = new GatewayEventBus()

// ── Helper: create event with base fields pre-filled ──
export function createEvent<K extends GatewayEventType>(
  type: K,
  agentId: string,
  fields: Omit<Extract<GatewayEvent, { type: K }>, 'id' | 'type' | 'timestamp' | 'schemaVersion' | 'agentId'>,
): Extract<GatewayEvent, { type: K }> {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    schemaVersion: EVENTS_SCHEMA_VERSION,
    agentId,
    ...fields,
  } as Extract<GatewayEvent, { type: K }>
}

// Re-export for convenience (consumers don't need to import @openclaude/protocol directly)
export type { GatewayEvent, GatewayEventType }
