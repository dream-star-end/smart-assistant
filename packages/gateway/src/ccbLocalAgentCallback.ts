/**
 * CCB LocalAgentTask completion callback.
 *
 * CCB mid-turn drain is the only path allowed to consume a task-notification
 * inside an active ask(). When it does, it acks via task_notification_delivered.
 * This helper waits for that ack; if the parent turn finalizes (or is already
 * idle) with no ack, it origin-injects. A dead parent CCB process is not covered.
 *
 * State is three-valued, not a boolean: pending → injecting → delivered.
 * delivered is written only for: CCB ack, a truly applied inject, or an
 * observable abandon after max finalize rounds / pending TTL.
 * An in-round retry budget exhaust is not terminal — fail back to pending
 * so a later finalize can retry.
 */
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'

export { parseOriginWebchatSessionKey }

const SUMMARY_MAX = 800
const PENDING_MAX = 1024

/** Max finalize-time 12-retry windows before a pending inject is abandoned. */
export const CCB_LOCAL_AGENT_INJECT_MAX_FINALIZE_ROUNDS = 5
/** Max age of a pending inject before it is abandoned. */
export const CCB_LOCAL_AGENT_INJECT_PENDING_TTL_MS = 30 * 60_000

export type CcbLocalAgentNotification = {
  taskId: string
  status: string
  outputFile: string
  summary: string
  toolUseId?: string
}

export type CcbLocalAgentCallbackState = 'pending' | 'injecting' | 'delivered'

export type CcbLocalAgentCallbackDecision = 'wait' | 'inject' | 'noop' | 'acked'

export type CcbLocalAgentAbandonReason = 'max_finalize_rounds' | 'pending_ttl'

type PendingEntry = {
  state: CcbLocalAgentCallbackState
  sessionKey: string
  taskId: string
  payload: CcbLocalAgentNotification
  userId?: string
  firstSeenAt: number
  finalizeRetryRounds: number
  abandonReason?: CcbLocalAgentAbandonReason
}

const store = new Map<string, PendingEntry>()

export function ccbLocalAgentCallbackClientMessageId(taskId: string): string {
  const compact = taskId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return `ccb-tn-${compact || 'task'}`
}

export function ccbLocalAgentCallbackIdempotencyKey(sessionKey: string, taskId: string): string {
  return `ccb-local-agent:${sessionKey}:${taskId}`
}

export function ccbLocalAgentPendingKey(sessionKey: string, taskId: string): string {
  return `${sessionKey}:${taskId}`
}

export function buildCcbLocalAgentCallbackText(input: {
  taskId: string
  status?: string
  outputFile?: string
  summary?: string
}): string {
  const summary = (input.summary?.trim() || '子 agent 已结束').slice(0, SUMMARY_MAX)
  const outputFile = input.outputFile?.trim() || '(未提供 output_file)'
  const status = input.status?.trim() || 'completed'
  return [
    `🔄 本地子 Agent 已${status === 'failed' ? '失败' : status === 'stopped' || status === 'killed' ? '停止' : '完成'}`,
    '',
    `摘要：${summary}`,
    '',
    '完整结果见 output_file：',
    outputFile,
    '',
    '请读取该文件并综合结论继续回复用户。这是系统刚注入的完成回调，不要假装你早就看过。',
  ].join('\n')
}

export function sessionHasInFlightTurn(session: {
  _activeTurnCount?: number
  _activeClientTurnCount?: number
} | null | undefined): boolean {
  return (session?._activeTurnCount ?? 0) > 0 || (session?._activeClientTurnCount ?? 0) > 0
}

function evictIfNeeded(): void {
  while (store.size > PENDING_MAX) {
    let victim: string | undefined
    for (const [key, entry] of store) {
      if (entry.state === 'delivered') {
        victim = key
        break
      }
    }
    if (!victim) victim = store.keys().next().value
    if (!victim) break
    store.delete(victim)
  }
}

function emptyPayload(taskId: string): CcbLocalAgentNotification {
  return {
    taskId,
    status: 'completed',
    outputFile: '',
    summary: '',
  }
}

function limitReason(entry: PendingEntry, now: number): CcbLocalAgentAbandonReason | undefined {
  if (entry.finalizeRetryRounds >= CCB_LOCAL_AGENT_INJECT_MAX_FINALIZE_ROUNDS) {
    return 'max_finalize_rounds'
  }
  if (now - entry.firstSeenAt >= CCB_LOCAL_AGENT_INJECT_PENDING_TTL_MS) {
    return 'pending_ttl'
  }
  return undefined
}

function abandonWithReason(entry: PendingEntry, reason: CcbLocalAgentAbandonReason): void {
  entry.state = 'delivered'
  entry.abandonReason = reason
}

export function getCcbLocalAgentCallbackState(
  sessionKey: string,
  taskId: string,
): CcbLocalAgentCallbackState | undefined {
  return store.get(ccbLocalAgentPendingKey(sessionKey, taskId))?.state
}

export function getCcbLocalAgentAbandonReason(
  sessionKey: string,
  taskId: string,
): CcbLocalAgentAbandonReason | undefined {
  return store.get(ccbLocalAgentPendingKey(sessionKey, taskId))?.abandonReason
}

/**
 * Check TTL / accumulated finalize-round limits without incrementing.
 * Used at the start of a finalize inject so an already-expired item is
 * abandoned observably instead of spending another in-round budget.
 */
export function evaluateCcbLocalAgentInjectLimit(
  sessionKey: string,
  taskId: string,
  now = Date.now(),
): CcbLocalAgentAbandonReason | undefined {
  const existing = store.get(ccbLocalAgentPendingKey(sessionKey, taskId))
  if (!existing) return undefined
  if (existing.state === 'delivered') return existing.abandonReason
  const reason = limitReason(existing, now)
  if (!reason) return undefined
  abandonWithReason(existing, reason)
  return reason
}

/**
 * Record that one finalize-time 12-retry window exhausted. Caller must
 * failCcbLocalAgentInject first (back to pending). Returns an abandon
 * reason only when the cross-round or TTL cap is now hit.
 */
export function noteCcbLocalAgentFinalizeRoundExhausted(
  sessionKey: string,
  taskId: string,
  now = Date.now(),
): CcbLocalAgentAbandonReason | undefined {
  const existing = store.get(ccbLocalAgentPendingKey(sessionKey, taskId))
  if (!existing) return undefined
  if (existing.state === 'delivered') return existing.abandonReason
  existing.finalizeRetryRounds += 1
  const reason = limitReason(existing, now)
  if (!reason) return undefined
  abandonWithReason(existing, reason)
  return reason
}

/**
 * Completion bookend arrived. Never decide solely from "in-flight right now":
 * a notification can land after the mid-turn snapshot (or during the final
 * model answer) and CCB will never ack it. Record pending and wait for ack
 * or parent-turn finalize.
 */
export function noteCcbTaskNotification(opts: {
  sessionKey: string
  notification: CcbLocalAgentNotification
  hasInFlightTurn: boolean
  userId?: string
}): CcbLocalAgentCallbackDecision {
  const taskId = opts.notification.taskId.trim()
  if (!taskId) return 'noop'
  const key = ccbLocalAgentPendingKey(opts.sessionKey, taskId)
  const existing = store.get(key)
  if (existing?.state === 'delivered') return 'noop'
  if (existing?.state === 'injecting') return 'noop'
  if (!existing) {
    store.set(key, {
      state: 'pending',
      sessionKey: opts.sessionKey,
      taskId,
      payload: { ...opts.notification, taskId },
      userId: opts.userId,
      firstSeenAt: Date.now(),
      finalizeRetryRounds: 0,
    })
    evictIfNeeded()
  } else if (opts.userId && !existing.userId) {
    existing.userId = opts.userId
  }
  return opts.hasInFlightTurn ? 'wait' : 'inject'
}

/**
 * CCB mid-turn actually consumed this task-notification. Drop inject.
 * Safe if ack arrives before the bookend (creates a delivered tombstone).
 */
export function ackCcbTaskNotificationDelivered(opts: {
  sessionKey: string
  taskId: string
}): CcbLocalAgentCallbackDecision {
  const taskId = opts.taskId.trim()
  if (!taskId) return 'noop'
  const key = ccbLocalAgentPendingKey(opts.sessionKey, taskId)
  const existing = store.get(key)
  if (existing?.state === 'delivered') return 'noop'
  store.set(key, {
    state: 'delivered',
    sessionKey: opts.sessionKey,
    taskId,
    payload: existing?.payload ?? emptyPayload(taskId),
    userId: existing?.userId,
    firstSeenAt: existing?.firstSeenAt ?? Date.now(),
    finalizeRetryRounds: existing?.finalizeRetryRounds ?? 0,
    abandonReason: existing?.abandonReason,
  })
  evictIfNeeded()
  return 'acked'
}

export function takePendingInjectionsForSession(sessionKey: string): Array<{
  payload: CcbLocalAgentNotification
  userId?: string
}> {
  const out: Array<{ payload: CcbLocalAgentNotification; userId?: string }> = []
  for (const entry of store.values()) {
    if (entry.sessionKey !== sessionKey) continue
    if (entry.state !== 'pending') continue
    out.push({ payload: entry.payload, userId: entry.userId })
  }
  return out
}

export function beginCcbLocalAgentInject(sessionKey: string, taskId: string): boolean {
  const key = ccbLocalAgentPendingKey(sessionKey, taskId)
  const existing = store.get(key)
  if (!existing || existing.state !== 'pending') return false
  existing.state = 'injecting'
  return true
}

export function completeCcbLocalAgentInject(sessionKey: string, taskId: string): void {
  const key = ccbLocalAgentPendingKey(sessionKey, taskId)
  const existing = store.get(key)
  if (!existing) return
  if (existing.state === 'delivered') return
  existing.state = 'delivered'
}

export function failCcbLocalAgentInject(sessionKey: string, taskId: string): void {
  const key = ccbLocalAgentPendingKey(sessionKey, taskId)
  const existing = store.get(key)
  if (!existing) return
  if (existing.state === 'delivered') return
  existing.state = 'pending'
}

export function abandonCcbLocalAgentInject(sessionKey: string, taskId: string): void {
  const key = ccbLocalAgentPendingKey(sessionKey, taskId)
  const existing = store.get(key)
  if (!existing) return
  existing.state = 'delivered'
}

export function clearCcbLocalAgentPendingForSession(sessionKey: string): void {
  for (const [key, entry] of store) {
    if (entry.sessionKey === sessionKey) store.delete(key)
  }
}

export function resetCcbLocalAgentCallbackDedupeForTest(): void {
  store.clear()
}

export function ccbLocalAgentPendingSizeForTest(): number {
  return store.size
}

export function getCcbLocalAgentPendingMetaForTest(
  sessionKey: string,
  taskId: string,
): {
  state: CcbLocalAgentCallbackState
  finalizeRetryRounds: number
  firstSeenAt: number
  abandonReason?: CcbLocalAgentAbandonReason
} | undefined {
  const existing = store.get(ccbLocalAgentPendingKey(sessionKey, taskId))
  if (!existing) return undefined
  return {
    state: existing.state,
    finalizeRetryRounds: existing.finalizeRetryRounds,
    firstSeenAt: existing.firstSeenAt,
    abandonReason: existing.abandonReason,
  }
}

export function setCcbLocalAgentFirstSeenAtForTest(
  sessionKey: string,
  taskId: string,
  firstSeenAt: number,
): void {
  const existing = store.get(ccbLocalAgentPendingKey(sessionKey, taskId))
  if (existing) existing.firstSeenAt = firstSeenAt
}
