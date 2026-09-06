/**
 * send_to_agent completion callback: inject a new user turn into the parent
 * webchat conversation. Stamp + text live here; Gateway does persist +
 * dispatchInbound (same durability path as cron origin-session).
 */
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'

export { parseOriginWebchatSessionKey }

const OUTPUT_MAX = 8_000
// Master `/internal/v3/cron-origin-inject` rejects text > 32_000 chars; the
// callback now rides that route for billing parity, so every variable part
// must be bounded (goal used to be unbounded).
const GOAL_MAX = 4_000

export function buildSendToAgentCallbackText(input: {
  agentId: string
  goal: string
  output?: string
  error?: string
}): string {
  const goal = (input.goal.trim() || '(未提供任务描述)').slice(0, GOAL_MAX)
  const body = (input.error?.trim() || input.output?.trim() || '(子 agent 没有返回正文)').slice(
    0,
    OUTPUT_MAX,
  )
  const heading = input.error?.trim()
    ? `🔄 子 Agent「${input.agentId}」失败`
    : `🔄 子 Agent「${input.agentId}」已完成`
  return [
    heading,
    '',
    `任务：${goal}`,
    '',
    input.error?.trim() ? '错误：' : '结论：',
    body,
    '',
    '请综合这条结论继续回复用户。这是系统刚注入的完成回调，不要假装你早就看过。',
  ].join('\n')
}

export function sendToAgentCallbackClientMessageId(jobId: string): string {
  const compact = jobId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return `sta-cb-${compact || 'job'}`
}

export function sendToAgentCallbackIdempotencyKey(jobId: string): string {
  return `send-to-agent-callback:${jobId}`
}

export function isSendToAgentCallbackComplete(value: unknown): value is 'origin-inject' {
  return value === 'origin-inject'
}

/**
 * Consume-side receipt after persist.
 * - applied: first write, must dispatchInbound
 * - already_exists + turn already queued/ingest: ack, do not dispatch again
 * - already_exists + no turn yet: persist-then-crash, continue dispatch
 */
export function decideCallbackDispatchAfterPersist(opts: {
  persistApplied: boolean
  persistReason?: string
  turnAlreadyQueued: boolean
}): 'dispatch' | 'ack_injected' | 'unhandled' {
  if (opts.persistApplied) return 'dispatch'
  if (opts.persistReason === 'already_exists') {
    return opts.turnAlreadyQueued ? 'ack_injected' : 'dispatch'
  }
  return 'unhandled'
}

/** Rebuild inject payload from a durable terminal snapshot. */
export function callbackPayloadFromDurableJob(job: {
  state?: string
  failureClass?: string
  failureDetail?: string
  result?: { body?: Record<string, unknown> } | null
}): { output?: string; error?: string } {
  const body = job.result?.body ?? {}
  const bodyError = typeof body.error === 'string' ? body.error : undefined
  const bodyOutput = typeof body.output === 'string' ? body.output : undefined
  if (
    job.state === 'failed' ||
    job.state === 'killed_by_cutover' ||
    job.state === 'cancelled' ||
    job.failureClass ||
    body.ok === false
  ) {
    const error = job.failureDetail || bodyError || 'delegate failed'
    return { error }
  }
  if (bodyError && !bodyOutput) return { error: bodyError }
  return { output: bodyOutput }
}
