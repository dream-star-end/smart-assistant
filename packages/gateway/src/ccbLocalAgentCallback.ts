/**
 * CCB LocalAgentTask completion callback: inject a new user turn into the
 * parent webchat conversation when the parent has no in-flight turn.
 *
 * Segment 1 (CCB mid-turn drain + emitTaskTerminatedSdk) covers the case
 * where the parent ask() is still running. This helper is only the idle-parent
 * origin-inject path. A dead parent CCB process is not covered.
 */
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'

export { parseOriginWebchatSessionKey }

const SUMMARY_MAX = 800

export type CcbLocalAgentNotification = {
  taskId: string
  status: string
  outputFile: string
  summary: string
  toolUseId?: string
}

export type CcbLocalAgentCallbackPlan = 'inject' | 'skip-inflight' | 'noop'

const seen = new Set<string>()

export function ccbLocalAgentCallbackClientMessageId(taskId: string): string {
  const compact = taskId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return `ccb-tn-${compact || 'task'}`
}

export function ccbLocalAgentCallbackIdempotencyKey(sessionKey: string, taskId: string): string {
  return `ccb-local-agent:${sessionKey}:${taskId}`
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

export function planCcbLocalAgentCallback(opts: {
  sessionKey: string
  taskId: string
  hasInFlightTurn: boolean
}): CcbLocalAgentCallbackPlan {
  const key = ccbLocalAgentCallbackIdempotencyKey(opts.sessionKey, opts.taskId)
  if (seen.has(key)) return 'noop'
  seen.add(key)
  if (opts.hasInFlightTurn) return 'skip-inflight'
  return 'inject'
}

export function handleCcbLocalAgentNotification(input: {
  sessionKey: string
  taskId: string
  hasInFlightTurn: boolean
  dispatch: () => void
}): CcbLocalAgentCallbackPlan {
  const plan = planCcbLocalAgentCallback(input)
  if (plan === 'inject') input.dispatch()
  return plan
}

export function sessionHasInFlightTurn(session: {
  _activeTurnCount?: number
  _activeClientTurnCount?: number
} | null | undefined): boolean {
  return (session?._activeTurnCount ?? 0) > 0 || (session?._activeClientTurnCount ?? 0) > 0
}

export function resetCcbLocalAgentCallbackDedupeForTest(): void {
  seen.clear()
}
