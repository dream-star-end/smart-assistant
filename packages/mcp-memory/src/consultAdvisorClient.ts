/**
 * Consumer wait for consult_advisor: same invocation + immutable turn token.
 * HTTP may return explicit pending (202) after one wait budget; the consumer
 * retries until advice or an overall deadline. Running JSON is never success.
 */

export const CONSULT_ADVISOR_OVERALL_MS = 10 * 60_000
export const CONSULT_ADVISOR_RETRY_GAP_MS = 50

export type ConsultGatewayResponse = { statusCode: number; body: string }

export type ConsultParsedBody = {
  advice?: string
  error?: string
  missing?: string[]
  reused?: boolean
  status?: string
  consultId?: string
  jobId?: string
  recoverable?: boolean
}

export type ConsultConsumeResult =
  | { kind: 'advice'; text: string; parsed: ConsultParsedBody }
  | { kind: 'error'; text: string }
  | { kind: 'pending'; parsed: ConsultParsedBody }

export function parseConsultAdvisorBody(text: string): ConsultParsedBody | null {
  try {
    return JSON.parse(text) as ConsultParsedBody
  } catch {
    return null
  }
}

export function isConsultInFlightStatus(status: string | undefined): boolean {
  return (
    status === 'pending' ||
    status === 'running' ||
    status === 'accepted' ||
    status === 'admission_attempt' ||
    status === 'admitted' ||
    status === 'spawned'
  )
}

export function consultAdvisorResultFromGateway(res: ConsultGatewayResponse): ConsultConsumeResult {
  const text = res.body || ''
  if (res.statusCode >= 400) {
    return { kind: 'error', text: `consult_advisor failed (${res.statusCode}): ${text.slice(0, 2000)}` }
  }
  const parsed = parseConsultAdvisorBody(text)
  if (!parsed) {
    if (res.statusCode === 202) return { kind: 'pending', parsed: { status: 'pending' } }
    return { kind: 'advice', text, parsed: {} }
  }
  if (parsed.error && !parsed.advice) return { kind: 'error', text: parsed.error }
  if (typeof parsed.advice === 'string' && parsed.advice) {
    const missing =
      Array.isArray(parsed.missing) && parsed.missing.length
        ? `\n【缺失证据】${parsed.missing.join(', ')}`
        : ''
    return { kind: 'advice', text: `${parsed.advice}${missing}`, parsed }
  }
  if (
    res.statusCode === 202 ||
    parsed.status === 'pending' ||
    isConsultInFlightStatus(parsed.status)
  ) {
    return { kind: 'pending', parsed }
  }
  if (parsed.status === 'failed' || parsed.status === 'cancelled') {
    return { kind: 'error', text: parsed.error || parsed.status }
  }
  if (parsed.status === 'settled' || parsed.status === 'settle_pending') {
    const missing =
      Array.isArray(parsed.missing) && parsed.missing.length
        ? `\n【缺失证据】${parsed.missing.join(', ')}`
        : ''
    return { kind: 'advice', text: `${parsed.advice || ''}${missing}`, parsed }
  }
  return { kind: 'error', text: `consult_advisor unexpected status ${parsed.status ?? res.statusCode}` }
}

export async function consultAdvisorUntilAdvice(input: {
  post: () => Promise<ConsultGatewayResponse>
  now?: () => number
  overallMs?: number
  sleep?: (ms: number) => Promise<void>
  retryGapMs?: number
}): Promise<{ ok: true; text: string } | { ok: false; text: string; pending?: boolean }> {
  const now = input.now ?? Date.now
  const overallMs = input.overallMs ?? CONSULT_ADVISOR_OVERALL_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const retryGapMs = input.retryGapMs ?? CONSULT_ADVISOR_RETRY_GAP_MS
  const deadline = now() + overallMs
  let lastPending: ConsultParsedBody | undefined
  while (now() <= deadline) {
    const res = await input.post()
    const result = consultAdvisorResultFromGateway(res)
    if (result.kind === 'advice') return { ok: true, text: result.text }
    if (result.kind === 'error') return { ok: false, text: result.text }
    lastPending = result.parsed
    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(retryGapMs, remaining))
  }
  const consultId = lastPending?.consultId ? ` consultId=${lastPending.consultId}` : ''
  return {
    ok: false,
    pending: true,
    text: `consult_advisor pending${consultId}；用同一 invocation 与原回合 token 续等，不能把 running JSON 当建议`,
  }
}
