/**
 * Unified turn-usage emit. Every terminated turn (completed / error / crash /
 * abort / stop / timeout) goes through `createTurnUsageRecorder()` so
 * usage_log gets exactly one row. The recorder is the in-memory gate;
 * `idx_usage_log_dedup` is the durable one.
 */
import type { UsageInfo } from '@openclaude/protocol'
import { eventBus, createEvent } from './eventBus.js'

export const TURN_TERMINAL_STATUSES = [
  'completed',
  'error',
  'crashed',
  'aborted',
  'stopped',
  'timeout',
  'reconciled',
] as const

export type TurnTerminalStatus = (typeof TURN_TERMINAL_STATUSES)[number]

export function mapTurnTerminalStatus(input: {
  persistStatus?: 'interrupted' | 'crashed'
  errorCode?: string
  hasResult?: boolean
  resultIsError?: boolean
}): TurnTerminalStatus {
  if (input.persistStatus === 'crashed') return 'crashed'
  if (input.persistStatus === 'interrupted') {
    if (input.errorCode === 'USER_CANCELLED') return 'stopped'
    if (input.errorCode === 'IDLE_TIMEOUT') return 'timeout'
    return 'aborted'
  }
  if (input.hasResult) return input.resultIsError ? 'error' : 'completed'
  return 'aborted'
}

export interface TurnUsageRecordInput {
  agentId: string
  sessionKey: string
  turnIndex: number
  usage: UsageInfo
  toolCalls: number
  durationMs: number
  terminalStatus: TurnTerminalStatus
  requestId?: string
  traceId?: string
}

/** Single emit site for turn usage. eventPersist writes usage_log from this. */
export function emitTurnUsage(input: TurnUsageRecordInput): void {
  eventBus.emit('turn.completed', createEvent('turn.completed', input.agentId, {
    sessionKey: input.sessionKey,
    turnIndex: input.turnIndex,
    usage: input.usage,
    toolCalls: input.toolCalls,
    durationMs: input.durationMs,
    terminalStatus: input.terminalStatus,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  }))
}

export function createTurnUsageRecorder(): {
  readonly recorded: boolean
  record(input: TurnUsageRecordInput): boolean
} {
  let recorded = false
  return {
    get recorded() {
      return recorded
    },
    record(input: TurnUsageRecordInput): boolean {
      if (recorded) return false
      recorded = true
      emitTurnUsage(input)
      return true
    },
  }
}
