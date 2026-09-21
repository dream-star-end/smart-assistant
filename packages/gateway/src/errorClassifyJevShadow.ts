/**
 * OCV5-253 — shadow observer for classifyRunError() === 'unknown'.
 *
 * Fire-and-forget. Never changes the code, the CTA, or the retry decision.
 * OC_ERRORCLASSIFY_JEV_SHADOW default off. Missing OC_JEV_API_KEY is a no-op
 * (no log, no throw). The gateway installs a process-global EnvHttpProxyAgent,
 * so this call uses its own undici Agent and does not inherit that proxy.
 */
import { createHash } from 'node:crypto'

import { createLogger } from './logger.js'

export const JEV_SHADOW_FLAG = 'OC_ERRORCLASSIFY_JEV_SHADOW'
export const JEV_SHADOW_KEY = 'OC_JEV_API_KEY'
export const JEV_SHADOW_URL = 'https://ai-gateway.vercel.sh/v1/evaluate'
export const JEV_SHADOW_MODEL = 'typesafe-ai/jev'
export const JEV_SHADOW_CONFIDENCE_MIN = 0.9
export const JEV_SHADOW_TIMEOUT_MS = 1_500
export const JEV_SHADOW_MAX_INFLIGHT = 2
const STATE_TEXT_MAX = 12_000

const PLATFORM_NOTES = [
  'Platform semantics (do not ignore):',
  '- A "[non-retryable]" marker only stops the CCB in-request retry loop. It does not mean the user prompt is invalid.',
  '- CURSOR_SAND_BOX_* codes other than INFERENCE_TICKET_REJECTED are transport faults that can heal on their own.',
  '- INFERENCE_TICKET_REJECTED is an account-level terminal credential decision, not a transient transport blip.',
  '- Classify the failure only. Do not decide whether to automatically retry.',
].join('\n')

const CRITERIA: Record<string, string> = {
  model_config_changed_retry_turn:
    'the model configuration changed mid-turn and the turn must be re-sent; not an upstream fault',
  insufficient_credits: 'the account is out of credits or payment is required',
  auth_error: 'authentication or credentials failed, are missing, or were rejected',
  rate_limited: 'the request was throttled by a rate limit or per-period quota',
  context_too_long: 'the prompt exceeded the model context window',
  model_capacity: 'the model or serving pool is overloaded; the same model may work later',
  model_not_available:
    'this route, model, or provider configuration cannot succeed as-is; a different model is required',
  upstream_failed: 'a transport or server-side upstream failure that may heal on its own',
  bad_request: 'the request itself was rejected as invalid or unacceptable content',
  unknown: 'none of the above applies with high confidence, or the text is not an upstream API failure',
}

const ADOPTABLE = new Set(Object.keys(CRITERIA).filter((code) => code !== 'unknown'))

const log = createLogger({ module: 'errorClassifyJevShadow' })

export type JevShadowStatus = 'ok' | 'error' | 'timeout' | 'dropped'

export interface JevShadowRecord {
  status: JevShadowStatus
  textHash: string
  regexCode: 'unknown'
  jevCode: string | null
  confidence: number | null
  upstreamMs: number | null
  thresholdMet: boolean
  durationMs: number
  httpStatus: number | null
  errorName: string | null
}

type ShadowResponse = { status: number; json: () => Promise<unknown> }

export interface JevShadowDeps {
  fetchImpl?: (
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      body: string
      signal: AbortSignal
      dispatcher: object
    },
  ) => Promise<ShadowResponse>
  logInfo?: (msg: string, ctx: Record<string, unknown>) => void
  timeoutMs?: number
  undici?: {
    Agent: new (opts?: { connections?: number; pipelining?: number; keepAliveTimeout?: number }) => object
    fetch: (
      url: string,
      init: {
        method: string
        headers: Record<string, string>
        body: string
        signal: AbortSignal
        dispatcher: object
      },
    ) => Promise<ShadowResponse>
  }
}

let inflight = 0
let cachedAgent: object | null = null
let testDeps: JevShadowDeps | null = null
const pending = new Set<Promise<void>>()

export function jevShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[JEV_SHADOW_FLAG] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

export function hashErrorText(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function buildJevShadowState(raw: string): string {
  const text = raw.length > STATE_TEXT_MAX ? raw.slice(0, STATE_TEXT_MAX) : raw
  return `${PLATFORM_NOTES}\n\nError text:\n${text}`
}

export function setErrorClassifyJevShadowDepsForTests(deps: JevShadowDeps | null): void {
  testDeps = deps
  cachedAgent = null
}

export function resetErrorClassifyJevShadowForTests(): void {
  inflight = 0
  cachedAgent = null
  testDeps = null
}

export function flushErrorClassifyJevShadowForTests(): Promise<void> {
  return Promise.all([...pending]).then(() => undefined)
}

/** Schedule a shadow call. Returns immediately. Never throws. */
export function observeUnknownRunError(raw: string): void {
  try {
    if (!raw || !raw.trim()) return
    if (!jevShadowEnabled()) return
    if (!(process.env[JEV_SHADOW_KEY] ?? '').trim()) return
    const task = runErrorClassifyJevShadow(raw).then(() => undefined, () => undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  } catch {
    // Shadow must not surface into classifyRunError.
  }
}

export async function runErrorClassifyJevShadow(raw: string): Promise<JevShadowRecord | null> {
  try {
    return await runInner(raw)
  } catch (error) {
    const record = blank(raw, {
      status: 'error',
      errorName: error instanceof Error ? error.name : 'Error',
    })
    emit(record)
    return record
  }
}

async function runInner(raw: string): Promise<JevShadowRecord | null> {
  if (!raw || !raw.trim()) return null
  if (!jevShadowEnabled()) return null
  const key = (process.env[JEV_SHADOW_KEY] ?? '').trim()
  if (!key) return null

  if (inflight >= JEV_SHADOW_MAX_INFLIGHT) {
    const dropped = blank(raw, { status: 'dropped' })
    emit(dropped)
    return dropped
  }

  inflight += 1
  const started = Date.now()
  const timeoutMs = testDeps?.timeoutMs ?? JEV_SHADOW_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const body = JSON.stringify({
      model: JEV_SHADOW_MODEL,
      state: buildJevShadowState(raw),
      questions: { code: { type: 'choice', criteria: CRITERIA } },
    })
    const res = await shadowFetch(key, body, signal)
    if (res.status !== 200) {
      const failed = blank(raw, {
        status: 'error',
        httpStatus: res.status,
        durationMs: Date.now() - started,
      })
      emit(failed)
      return failed
    }
    const parsed = parseEvaluateBody(await res.json())
    const record = blank(raw, {
      status: 'ok',
      httpStatus: 200,
      durationMs: Date.now() - started,
      jevCode: parsed.jevCode,
      confidence: parsed.confidence,
      upstreamMs: parsed.upstreamMs,
      thresholdMet: parsed.thresholdMet,
    })
    emit(record)
    return record
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    const timedOut = signal.aborted || name === 'AbortError' || name === 'TimeoutError'
    const record = blank(raw, {
      status: timedOut ? 'timeout' : 'error',
      errorName: name,
      durationMs: Date.now() - started,
    })
    emit(record)
    return record
  } finally {
    inflight -= 1
  }
}

function blank(raw: string, patch: Partial<JevShadowRecord> & { status: JevShadowStatus }): JevShadowRecord {
  return {
    status: patch.status,
    textHash: hashErrorText(raw),
    regexCode: 'unknown',
    jevCode: patch.jevCode ?? null,
    confidence: patch.confidence ?? null,
    upstreamMs: patch.upstreamMs ?? null,
    thresholdMet: patch.thresholdMet ?? false,
    durationMs: patch.durationMs ?? 0,
    httpStatus: patch.httpStatus ?? null,
    errorName: patch.errorName ?? null,
  }
}

function emit(record: JevShadowRecord): void {
  const ctx: Record<string, unknown> = { ...record }
  if (testDeps?.logInfo) testDeps.logInfo('errorclassify.jev_shadow', ctx)
  else log.info('errorclassify.jev_shadow', ctx)
}

async function shadowFetch(key: string, body: string, signal: AbortSignal): Promise<ShadowResponse> {
  const dispatcher = testDeps?.fetchImpl ? { direct: true } : await directDispatcher()
  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body,
    signal,
    dispatcher,
  }
  if (testDeps?.fetchImpl) return testDeps.fetchImpl(JEV_SHADOW_URL, init)
  const undici = testDeps?.undici ?? (await loadUndici())
  return undici.fetch(JEV_SHADOW_URL, init)
}

async function directDispatcher(): Promise<object> {
  if (cachedAgent) return cachedAgent
  const undici = testDeps?.undici ?? (await loadUndici())
  cachedAgent = new undici.Agent({
    connections: JEV_SHADOW_MAX_INFLIGHT,
    pipelining: 1,
    keepAliveTimeout: 30_000,
  })
  return cachedAgent
}

async function loadUndici(): Promise<NonNullable<JevShadowDeps['undici']>> {
  const mod = (await import('undici')) as unknown as NonNullable<JevShadowDeps['undici']>
  return mod
}

function parseEvaluateBody(body: unknown): {
  jevCode: string | null
  confidence: number | null
  upstreamMs: number | null
  thresholdMet: boolean
} {
  const root = asRecord(body)
  const answers = asRecord(root?.answers)
  const codeAnswer = asRecord(answers?.code)
  const choice = typeof codeAnswer?.choice === 'string' ? codeAnswer.choice : null
  const confidence =
    typeof codeAnswer?.confidence === 'number' && Number.isFinite(codeAnswer.confidence)
      ? codeAnswer.confidence
      : null
  return {
    jevCode: choice,
    confidence,
    upstreamMs: readUpstreamMs(root),
    thresholdMet:
      confidence !== null && confidence >= JEV_SHADOW_CONFIDENCE_MIN && choice !== null && ADOPTABLE.has(choice),
  }
}

function readUpstreamMs(root: Record<string, unknown> | null): number | null {
  const providerMetadata = asRecord(root?.providerMetadata)
  const gateway = asRecord(providerMetadata?.gateway)
  const routing = asRecord(gateway?.routing)
  const modelAttempts = routing?.modelAttempts
  const firstModel = Array.isArray(modelAttempts) ? asRecord(modelAttempts[0]) : null
  const providerAttempts = firstModel?.providerAttempts
  const firstProvider = Array.isArray(providerAttempts) ? asRecord(providerAttempts[0]) : null
  const start = firstProvider?.startTime
  const end = firstProvider?.endTime
  if (typeof start !== 'number' || typeof end !== 'number') return null
  return end - start
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
