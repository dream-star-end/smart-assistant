/**
 * send_to_agent background start: fire the async /delegate job and return
 * immediately. Completion is injected into the origin session by the gateway.
 */
import { interpretDelegateStartBody } from './delegateCursorFastPath.js'

export function formatSendToAgentRunning(input: {
  agentId: string
  jobId: string
  sessionKey?: string
  parentSessionKey?: string
  parentTurnKey?: string
}): string {
  return JSON.stringify({
    status: 'running',
    jobId: input.jobId,
    agentId: input.agentId,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.parentSessionKey ? { parentSessionKey: input.parentSessionKey } : {}),
    ...(input.parentTurnKey ? { parentTurnKey: input.parentTurnKey } : {}),
    message:
      `已把任务交给 ${input.agentId} 在后台执行。请结束本回合，不要让用户等它的回复。` +
      '子任务完成后系统会把结论注入本对话并叫醒你。',
  })
}

export function formatSendToAgentStart(
  statusCode: number,
  raw: string,
  agentId: string,
  lineage?: { parentSessionKey?: string; parentTurnKey?: string },
): string | { error: string } {
  const started = interpretDelegateStartBody(statusCode, raw)
  if ('error' in started) return { error: started.error.replace(/^委派失败/, '发送失败') }
  return formatSendToAgentRunning({
    agentId,
    jobId: started.jobId,
    sessionKey: started.sessionKey,
    parentSessionKey: started.parentSessionKey || lineage?.parentSessionKey,
    parentTurnKey: started.parentTurnKey || lineage?.parentTurnKey,
  })
}
