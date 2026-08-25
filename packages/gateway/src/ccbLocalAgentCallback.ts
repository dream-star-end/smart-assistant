/**
 * CCB LocalAgentTask completion callback.
 *
 * CCB mid-turn drain is the only path allowed to consume a task-notification
 * inside an active ask(). When it does, it acks via task_notification_delivered.
 * This helper waits for that ack; if the parent turn finalizes (or is already
 * idle) with no ack, it origin-injects. A dead parent CCB process is not covered.
 *
 * State is three-valued, not a boolean: pending → injecting → delivered.
 * delivered is the only terminal success (CCB ack or inject really applied).
 * retryable inject failures stay pending/injecting and must be retried.
 */
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'

export { parseOriginWebchatSessionKey }

const SUMMARY_MAX = 800
const PENDING_MAX = 1024

export type CcbLocalAgentNotification = {
  taskId: string
  status: string
  outputFile: string
  summary: string
  toolUseId?: string
}

export type CcbLocalAgentCallbackState = 'pending' | 'injecting' | 'delivered'

export type CcbLocalAgentCallbackDecision = 'wait' | 'inject' | 'noop' | 'acked'

type PendingEntry = {
  state: CcbLocalAgentCallbackState
  sessionKey: string
  taskId: string
  payload: CcbLocalAgentNotification
  userId?: string
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

export function getCcbLocalAgentCallbackState(
  sessionKey: string,
  taskId: string,
): CcbLocalAgentCallbackState | undefined {
  return store.get(ccbLocalAgentPendingKey(sessionKey, taskId))?.state
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
    payload: existing?.payload ?? {
      taskId,
      status: 'completed',
      outputFile: '',
      summary: '',
    },
    userId: existing?.userId,
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
