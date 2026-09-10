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
  advisorModel?: string
  usage?: Record<string, unknown>
}

export type ConsultConsumeResult =
  | { kind: 'advice'; text: string; parsed: ConsultParsedBody }
  | { kind: 'error'; text: string; parsed?: ConsultParsedBody }
  | { kind: 'pending'; parsed: ConsultParsedBody }

export function formatConsultAdvisorToolPayload(input: {
  ok: boolean
  text: string
  parsed?: ConsultParsedBody
}): string {
  const parsed = input.parsed ?? {}
  const missing =
    Array.isArray(parsed.missing) && parsed.missing.length
      ? `\n【缺失证据】${parsed.missing.join(', ')}`
      : ''
  const payload: Record<string, unknown> = {
    advice: typeof parsed.advice === 'string' && parsed.advice ? parsed.advice : input.ok ? input.text : undefined,
    status: parsed.status,
    advisorModel: parsed.advisorModel,
    consultId: parsed.consultId,
    jobId: parsed.jobId,
  }
  if (parsed.usage && typeof parsed.usage === 'object') payload.usage = parsed.usage
  if (!input.ok) payload.error = parsed.error || input.text
  if (missing) payload.missing = parsed.missing
  return JSON.stringify(payload)
}

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
  if (parsed.status === 'failed' || parsed.status === 'cancelled') {
    const missing =
      Array.isArray(parsed.missing) && parsed.missing.length
        ? `\n【缺失证据】${parsed.missing.join(', ')}`
        : ''
    const advice = typeof parsed.advice === 'string' && parsed.advice ? parsed.advice : ''
    return {
      kind: 'error',
      text: `${parsed.error || parsed.status}${advice ? `\n${advice}` : ''}${missing}`,
      parsed,
    }
  }
  if (parsed.status === 'settle_pending' && !(typeof parsed.advice === 'string' && parsed.advice)) {
    return { kind: 'pending', parsed }
  }
  if (parsed.error && !parsed.advice) return { kind: 'error', text: parsed.error, parsed }
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
  if (parsed.status === 'settled') {
    return { kind: 'error', text: 'consult settled without durable advice', parsed }
  }
  return { kind: 'error', text: `consult_advisor unexpected status ${parsed.status ?? res.statusCode}`, parsed }
}

const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

export function isRetryableConsultTransportError(err: unknown): boolean {
  const rec = err as { code?: string; cause?: { code?: string }; message?: string } | undefined
  const code = rec?.code || rec?.cause?.code
  if (code && RETRYABLE_TRANSPORT_CODES.has(code)) return true
  const message = String(rec?.message ?? err)
  return /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network timeout|socket disconnected/i.test(
    message,
  )
}

export async function consultAdvisorUntilAdvice(input: {
  post: () => Promise<ConsultGatewayResponse>
  now?: () => number
  overallMs?: number
  sleep?: (ms: number) => Promise<void>
  retryGapMs?: number
}): Promise<
  | { ok: true; text: string; parsed?: ConsultParsedBody }
  | { ok: false; text: string; pending?: boolean; parsed?: ConsultParsedBody }
> {
  const now = input.now ?? Date.now
  const overallMs = input.overallMs ?? CONSULT_ADVISOR_OVERALL_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const retryGapMs = input.retryGapMs ?? CONSULT_ADVISOR_RETRY_GAP_MS
  const deadline = now() + overallMs
  let lastPending: ConsultParsedBody | undefined
  while (now() <= deadline) {
    let res: ConsultGatewayResponse
    try {
      res = await input.post()
    } catch (err) {
      if (!isRetryableConsultTransportError(err)) {
        return { ok: false, text: String((err as Error)?.message ?? err) }
      }
      const remaining = deadline - now()
      if (remaining <= 0) break
      await sleep(Math.min(retryGapMs, remaining))
      continue
    }
    const result = consultAdvisorResultFromGateway(res)
    if (result.kind === 'advice') return { ok: true, text: result.text, parsed: result.parsed }
    if (result.kind === 'error') return { ok: false, text: result.text, parsed: result.parsed }
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
