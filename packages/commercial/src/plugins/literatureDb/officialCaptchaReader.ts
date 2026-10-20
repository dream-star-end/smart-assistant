/** Official image APIs; activation/route approval and durable platform metering belong to control plane. */
import { randomUUID } from 'node:crypto'
import {
  type SelectedApiKey,
  reportApiKeyOutcome,
  selectApiKey,
} from '../../account-pool/apiKeyPool.js'
import { type PoolOutcome, classifyHttpOutcome } from '../../account-pool/policy/outcome.js'
import type { ModelExecutionDescriptor } from '../../billing/modelCatalog.js'
import { getModelCatalogCache } from '../../billing/modelCatalogRuntime.js'
import {
  CAPTCHA_PROMPT,
  type CaptchaReader,
  captchaAnswer,
  normalizeCaptchaImage,
} from './captcha.js'
import { LiteratureError, abortable } from './errors.js'

type Provider = 'anthropic' | 'google'
export interface OfficialCaptchaBinding {
  provider: Provider
  model: string
  upstreamModel: string
  /** Explicit approval of this exact provider + official route + model + use. */
  usageApproved: boolean
}
/** A trusted projection of a fresh catalog AND server-owned route/use policy, not a raw catalog row.
 * Catalog descriptors alone have no official endpoint/use approval fields.
 */
export interface OfficialCaptchaRoute extends OfficialCaptchaBinding {
  active: boolean
  supportsVision: boolean
  transport: 'official-api'
}
export interface CaptchaTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  thoughtTokens: number
  totalTokens: number
}
export interface PlatformCaptchaUsage {
  requestId: string
  provider: Provider
  model: string
  outcome: 'success' | 'refused' | 'invalid' | 'http_error' | 'network_error' | 'cancelled'
  usage: CaptchaTokenUsage | null
}
export type PlatformCaptchaBegin = Pick<PlatformCaptchaUsage, 'requestId' | 'provider' | 'model'>
export interface OfficialCaptchaDependencies {
  /** Must assert catalog freshness and recheck the exact policy binding on EVERY call. */
  resolveRoute(signal: AbortSignal): Promise<OfficialCaptchaRoute | null>
  /** Must commit a NEW platform quota reservation before any provider request. */
  beginPlatformUsage(event: Readonly<PlatformCaptchaBegin>): Promise<void>
  /** Platform expense only. Never charge the installing user's model wallet. */
  recordPlatformUsage(event: Readonly<PlatformCaptchaUsage>): Promise<void>
  selectKey?: (service: 'claude' | 'gemini', stickyKey: string) => Promise<SelectedApiKey | null>
  reportOutcome?: (memberId: string, outcome: PoolOutcome) => Promise<void>
  fetchImpl?: typeof fetch
  /** Trusted test seam; cannot exceed the production limit. */
  timeoutMs?: number
}
/** Current catalog has an official Claude mechanism, but no official Gemini mechanism.
 * Protocol support below does not silently promote Gemini Go/Antigravity to a new route.
 */
export function createCatalogCaptchaResolver(
  input: OfficialCaptchaBinding,
  isUseApproved: (
    binding: Readonly<OfficialCaptchaBinding>,
    signal: AbortSignal,
  ) => Promise<boolean>,
  readDescriptor: (model: string) => Promise<ModelExecutionDescriptor | null> = async (model) =>
    (await (await getModelCatalogCache()).assertFresh()).resolve(model),
): OfficialCaptchaDependencies['resolveRoute'] {
  const binding = Object.freeze({ ...input })
  return async (signal) => {
    if (signal.aborted) throw new LiteratureError('CANCELLED')
    if (binding.provider !== 'anthropic' || !binding.usageApproved) return null
    const descriptor = await abortable(
      Promise.resolve().then(() => readDescriptor(binding.model)),
      signal,
    )
    if (
      !descriptor ||
      descriptor.engine !== 'ccb' ||
      descriptor.providerId !== 'anthropic' ||
      descriptor.canonicalModel !== binding.model ||
      descriptor.upstreamModelId !== binding.upstreamModel ||
      descriptor.capabilityProfile.supportsVision !== true ||
      !(await abortable(
        Promise.resolve().then(() => isUseApproved(binding, signal)),
        signal,
      ))
    )
      return null
    return { ...binding, active: true, supportsVision: true, transport: 'official-api' }
  }
}
const MAX_RESPONSE_BYTES = 64 * 1024
function modelValid(provider: Provider, model: string, upstream: boolean): boolean {
  const prefix = provider === 'anthropic' ? 'claude-' : 'gemini-'
  const value = !upstream ? model.replace(/^(?:anthropic|google)\//, '') : model
  return value.length <= 128 && value.startsWith(prefix) && /^[a-z0-9.-]+$/.test(value)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LiteratureError('RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function count(value: unknown, optional = false): number {
  if (value === undefined && optional) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000)
    throw new LiteratureError('RESPONSE_INVALID')
  return value
}
function usageOf(provider: Provider, data: Record<string, unknown>): CaptchaTokenUsage {
  if (provider === 'anthropic') {
    const u = record(data.usage)
    const inputTokens = count(u.input_tokens)
    const outputTokens = count(u.output_tokens)
    const cacheReadTokens = count(u.cache_read_input_tokens, true)
    const cacheWriteTokens = count(u.cache_creation_input_tokens, true)
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thoughtTokens: 0,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    }
  }
  const u = record(data.usageMetadata)
  const inputTokens = count(u.promptTokenCount)
  const outputTokens = count(u.candidatesTokenCount, true)
  const cacheReadTokens = count(u.cachedContentTokenCount, true)
  const thoughtTokens = count(u.thoughtsTokenCount, true)
  const totalTokens = count(u.totalTokenCount)
  if (cacheReadTokens > inputTokens || totalTokens < inputTokens + outputTokens + thoughtTokens)
    throw new LiteratureError('RESPONSE_INVALID')
  // Gemini prompt tokens INCLUDE cached tokens. Keep the subset separate; do not add it again.
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    thoughtTokens,
    totalTokens,
  }
}
const GEMINI_REFUSALS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'ESCALATION',
  'PUP_LIMITED_DISABLED',
])
function refused(provider: Provider, data: Record<string, unknown>): boolean {
  if (provider === 'anthropic')
    return (
      data.stop_reason === 'refusal' ||
      (data.stop_details !== null &&
        typeof data.stop_details === 'object' &&
        (data.stop_details as Record<string, unknown>).type === 'refusal')
    )
  const feedback = data.promptFeedback
  if (feedback && typeof feedback === 'object') {
    const reason = (feedback as Record<string, unknown>).blockReason
    if (typeof reason === 'string' && reason && reason !== 'BLOCK_REASON_UNSPECIFIED') return true
  }
  return (
    Array.isArray(data.candidates) &&
    data.candidates.some(
      (candidate) =>
        candidate && typeof candidate === 'object' && GEMINI_REFUSALS.has(candidate.finishReason),
    )
  )
}
function answerOf(provider: Provider, data: Record<string, unknown>): string {
  let parts: unknown[]
  if (provider === 'anthropic') {
    if (data.stop_reason !== 'end_turn' || !Array.isArray(data.content))
      throw new LiteratureError('RESPONSE_INVALID')
    parts = data.content.map((part: unknown) => {
      const p = record(part)
      if (p.type === 'thinking' || p.type === 'redacted_thinking') return ''
      if (p.type !== 'text' || typeof p.text !== 'string')
        throw new LiteratureError('RESPONSE_INVALID')
      return p.text
    })
  } else {
    if (!Array.isArray(data.candidates) || data.candidates.length !== 1)
      throw new LiteratureError('RESPONSE_INVALID')
    const candidate = record(data.candidates[0])
    if (candidate.finishReason !== 'STOP') throw new LiteratureError('RESPONSE_INVALID')
    const content = record(candidate.content)
    if (!Array.isArray(content.parts)) throw new LiteratureError('RESPONSE_INVALID')
    parts = content.parts.map((part: unknown) => {
      const p = record(part)
      if (p.thought === true && typeof p.text === 'string') return ''
      if (
        typeof p.text !== 'string' ||
        Object.keys(p).some((k) => !['text', 'thought', 'thoughtSignature'].includes(k))
      )
        throw new LiteratureError('RESPONSE_INVALID')
      return p.text
    })
  }
  try {
    return captchaAnswer(parts.join(''))
  } catch {
    throw new LiteratureError('RESPONSE_INVALID')
  }
}
async function jsonBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    // Rejecting headers must also release a response whose body never finishes.
    void response.body?.cancel().catch(() => {})
    throw new LiteratureError('RESPONSE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new LiteratureError('RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
    complete = true
    return record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    )
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export function createOfficialCaptchaReader(
  input: OfficialCaptchaBinding,
  operationKey: string,
  dependencies: OfficialCaptchaDependencies,
): CaptchaReader {
  const binding = { ...input }
  const deps = {
    ...dependencies,
    resolveRoute: dependencies.resolveRoute?.bind(dependencies),
    beginPlatformUsage: dependencies.beginPlatformUsage?.bind(dependencies),
    recordPlatformUsage: dependencies.recordPlatformUsage?.bind(dependencies),
    selectKey: dependencies.selectKey?.bind(dependencies),
    reportOutcome: dependencies.reportOutcome?.bind(dependencies),
    fetchImpl: dependencies.fetchImpl?.bind(dependencies),
  }
  const timeout = deps.timeoutMs ?? 15_000
  if (
    !['anthropic', 'google'].includes(binding.provider) ||
    !binding.usageApproved ||
    !modelValid(binding.provider, binding.model, false) ||
    !modelValid(binding.provider, binding.upstreamModel, true) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operationKey) ||
    typeof deps.resolveRoute !== 'function' ||
    typeof deps.beginPlatformUsage !== 'function' ||
    typeof deps.recordPlatformUsage !== 'function' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 15_000
  )
    throw new LiteratureError('MODEL_UNAVAILABLE')
  return {
    provider: binding.provider,
    model: binding.model,
    usageApproved: true,
    async recognize(request) {
      if (request.signal.aborted) throw new LiteratureError('CANCELLED')
      const controller = new AbortController()
      const abort = () => controller.abort()
      request.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, timeout)
      const signal = controller.signal
      const requestId = randomUUID()
      let selected: SelectedApiKey | null = null
      let attempted = false
      let received = false
      let outcome: PlatformCaptchaUsage['outcome'] = 'network_error'
      let usage: CaptchaTokenUsage | null = null
      let health: PoolOutcome = { kind: 'network' }
      let result: string | undefined
      let failure: unknown
      const stage = async <T>(work: () => Promise<T>): Promise<T> => {
        if (signal.aborted) throw new LiteratureError('CANCELLED')
        return abortable(
          Promise.resolve().then(() => {
            if (signal.aborted) throw new LiteratureError('CANCELLED')
            return work()
          }),
          signal,
        )
      }
      try {
        const route = await stage(() => deps.resolveRoute(signal))
        if (
          !route ||
          route.active !== true ||
          route.supportsVision !== true ||
          route.transport !== 'official-api' ||
          route.usageApproved !== true ||
          route.provider !== binding.provider ||
          route.model !== binding.model ||
          route.upstreamModel !== binding.upstreamModel
        )
          throw new LiteratureError('MODEL_UNAVAILABLE')
        const image = await stage(() => normalizeCaptchaImage(request.image))
        const service = binding.provider === 'anthropic' ? 'claude' : 'gemini'
        selected = await stage(() => (deps.selectKey ?? selectApiKey)(service, operationKey))
        if (
          !selected ||
          selected.service !== service ||
          !selected.memberId ||
          typeof selected.apiKey !== 'string' ||
          selected.apiKey.length < 8 ||
          selected.apiKey.length > 4096 ||
          /[^\x21-\x7e]/.test(selected.apiKey)
        )
          throw new LiteratureError('MODEL_UNAVAILABLE')
        const base64 = image.data.toString('base64')
        const claude = binding.provider === 'anthropic'
        const url = claude
          ? 'https://api.anthropic.com/v1/messages'
          : `https://generativelanguage.googleapis.com/v1beta/models/${binding.upstreamModel}:generateContent`
        const body = claude
          ? {
              model: binding.upstreamModel,
              max_tokens: 64,
              stream: false,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image',
                      source: { type: 'base64', media_type: 'image/png', data: base64 },
                    },
                    { type: 'text', text: CAPTCHA_PROMPT },
                  ],
                },
              ],
            }
          : {
              contents: [
                {
                  role: 'user',
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: base64 } },
                    { text: CAPTCHA_PROMPT },
                  ],
                },
              ],
              generationConfig: { candidateCount: 1, maxOutputTokens: 64 },
            }
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (claude) {
          headers['x-api-key'] = selected.apiKey
          headers['anthropic-version'] = '2023-06-01'
        } else headers['x-goog-api-key'] = selected.apiKey
        await stage(() =>
          deps.beginPlatformUsage(
            Object.freeze({
              requestId,
              provider: binding.provider,
              model: binding.model,
            }),
          ),
        )
        const response = await stage(() => {
          attempted = true
          return (deps.fetchImpl ?? fetch)(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            signal,
          })
        })
        received = true
        health = classifyHttpOutcome(response.status, response.headers, new Date())
        if (!response.ok) {
          outcome = 'http_error'
          void response.body?.cancel().catch(() => {})
          throw new LiteratureError('MODEL_UNAVAILABLE')
        }
        outcome = 'invalid'
        const data = await jsonBody(response, signal)
        const isRefused = refused(binding.provider, data)
        // A refusal remains a refusal even when usage is absent or malformed.
        try {
          usage = usageOf(binding.provider, data)
        } catch {
          /* null is explicitly metered below */
        }
        if (isRefused) {
          outcome = 'refused'
          throw new LiteratureError('MODEL_REFUSED')
        }
        if (!usage) throw new LiteratureError('RESPONSE_INVALID')
        result = answerOf(binding.provider, data)
        outcome = 'success'
      } catch (error) {
        failure = error
      } finally {
        if (signal.aborted) outcome = 'cancelled'
        if (attempted) {
          const memberId = selected!.memberId
          const observedRefusal =
            failure instanceof LiteratureError && failure.code === 'MODEL_REFUSED'
          const reportedHealth = received
            ? health
            : signal.aborted
              ? { kind: 'client_error' as const }
              : health
          // Health must not be delayed or rewritten by an unrelated metering outage.
          void Promise.resolve()
            .then(() => (deps.reportOutcome ?? reportApiKeyOutcome)(memberId, reportedHealth))
            .catch(() => {})
          const event = Object.freeze({
            requestId,
            provider: binding.provider,
            model: binding.model,
            outcome: observedRefusal ? ('refused' as const) : outcome,
            usage: usage ? Object.freeze({ ...usage }) : null,
          })
          const metering = Promise.resolve().then(() => deps.recordPlatformUsage(event))
          if (observedRefusal) {
            // Return the refusal immediately: waiting here would let the solver's
            // outer deadline win and permit another cloud reader. The durable sink
            // must queue/idempotently persist this event; no text/image is retained.
            void metering.catch(() => {})
          } else {
            try {
              await abortable(metering, signal)
            } catch {
              if (!failure) failure = new LiteratureError('MODEL_UNAVAILABLE')
            }
          }
        }
        selected = null // JS strings cannot be reliably zeroized; keep no reader-wide key cache.
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
      }
      if (request.signal.aborted) throw new LiteratureError('CANCELLED')
      // Never turn an observed refusal into a retryable timeout when metering is slow.
      if (failure instanceof LiteratureError && failure.code === 'MODEL_REFUSED') throw failure
      if (signal.aborted) throw new LiteratureError('TIMEOUT')
      if (failure) {
        if (
          failure instanceof LiteratureError &&
          ['MODEL_REFUSED', 'RESPONSE_INVALID', 'RESPONSE_TOO_LARGE'].includes(failure.code)
        )
          throw failure
        throw new LiteratureError('MODEL_UNAVAILABLE')
      }
      if (!result) throw new LiteratureError('RESPONSE_INVALID')
      return result
    },
  }
}
