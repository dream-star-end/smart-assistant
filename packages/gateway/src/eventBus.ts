/**
 * Lightweight in-process event bus for OpenClaude gateway.
 *
 * Provides a unified "event → route → execute" pattern so that cron,
 * webhook, inter-agent messaging, and standing orders don't each need
 * their own hard-coded wiring in server.ts.
 *
 * This is intentionally simple — just a typed EventEmitter wrapper.
 * No distributed messaging, no persistence, no replay.
 */
import { EventEmitter } from 'node:events'

// ── Event payload types ──

export interface CronFiredEvent {
  type: 'cron.fired'
  jobId: string
  agentId: string
  output: string
  label?: string
  deliver?: string
}

export interface WebhookReceivedEvent {
  type: 'webhook.received'
  webhookId: string
  agentId: string
  payload: unknown
}

export interface TaskCreatedEvent {
  type: 'task.created'
  taskId: string
  agentId: string
  schedule?: string
  prompt: string
  oneshot?: boolean
  source: 'user' | 'agent' | 'cron-bridge'
}

export interface TaskDeletedEvent {
  type: 'task.deleted'
  taskId: string
  agentId: string
}

export interface AgentDelegatedEvent {
  type: 'agent.delegated'
  sourceAgentId: string
  targetAgentId: string
  goal: string
  sessionKey: string
}

export interface AgentCompletedEvent {
  type: 'agent.completed'
  agentId: string
  sessionKey: string
  output: string
  error?: string
}

export type GatewayEvent =
  | CronFiredEvent
  | WebhookReceivedEvent
  | TaskCreatedEvent
  | TaskDeletedEvent
  | AgentDelegatedEvent
  | AgentCompletedEvent

// ── Typed EventBus ──

type EventMap = {
  'cron.fired': [CronFiredEvent]
  'webhook.received': [WebhookReceivedEvent]
  'task.created': [TaskCreatedEvent]
  'task.deleted': [TaskDeletedEvent]
  'agent.delegated': [AgentDelegatedEvent]
  'agent.completed': [AgentCompletedEvent]
  /** Catch-all: receives every event */
  '*': [GatewayEvent]
}

export class GatewayEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  /** Emit a typed event. Also fires the '*' catch-all. */
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.emitter.emit(event, ...args)
    if (event !== '*') {
      this.emitter.emit('*', ...args)
    }
  }

  /** Subscribe to a specific event type. */
  on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.on(event, listener as any)
    return this
  }

  /** Subscribe once. */
  once<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.once(event, listener as any)
    return this
  }

  /** Unsubscribe. */
  off<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
    this.emitter.off(event, listener as any)
    return this
  }

  /** Number of listeners for a given event. */
  listenerCount(event: keyof EventMap): number {
    return this.emitter.listenerCount(event)
  }
}

/** Singleton instance — shared across the gateway process. */
export const eventBus = new GatewayEventBus()
