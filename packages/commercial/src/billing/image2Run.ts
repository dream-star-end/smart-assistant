/**
 * Server-side GPT Image call for media studio (OCV5-591 A0 ①).
 *
 * The codex relay serves *containers*: identity, binding, header passthrough and
 * HTTP streaming are all request-shaped. Studio jobs have no container and no
 * incoming request, so this runner drives the same billing journey directly:
 *
 *   completed-cache replay → reserveImageUsage (daily limit, in-flight guard)
 *   → preCheckExactCost → account pick / egress / token → attempt rows
 *   → upstream (one short 429 retry) → validate n images → settleImageCharge
 *
 * Every step reuses the relay's primitives (imageBilling.ts, the upstream failure
 * classifier, the 429 retry rule), so ledger rows, attempt rows and cache replay
 * are indistinguishable from container traffic except container_id IS NULL. The
 * relay itself is untouched — no egress-surface behaviour change.
 *
 * Idempotency: callers pass a stable requestId (studio uses `studio:<exec id>`).
 * A retry after a successful settle replays the cached body and never re-charges.
 */
import type { Pool } from 'pg'
import type { Dispatcher } from 'undici'
import { resolveCodexAccountEgressDispatcher } from '../account-pool/codexEgress.js'
import { pickCodexAccountForBinding } from '../account-pool/scheduler.js'
import { getCodexTokenSnapshot } from '../account-pool/store.js'
import { extractChatGptAccountId } from '../codex-auth/extractAccountId.js'
import { zeroBuffer } from '../crypto/keys.js'
import {
  CODEX_OFFICIAL_UPSTREAM_BASE_URL,
  classifyImageUpstreamFailure,
  decodeValidatedImageBase64,
  image429RetryDelayMs,
  readBoundedResponseBody,
  waitForImageRetry,
} from '../http/internalCodexRelay.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { codexBindingAffinityKey } from '../runtimeChannel.js'
import {
  IMAGE2_UNIT_COST,
  ImageDailyLimitError,
  beginImageUpstreamAttempt,
  finishImageUpstreamAttempt,
  getCompletedImageUsage,
  markImageUsage,
  reserveImageUsage,
  settleImageCharge,
} from './imageBilling.js'
import type { ImageModelPolicy } from './imageModels.js'
import { InsufficientCreditsError as LedgerInsufficientCreditsError } from './ledger.js'
import {
  InsufficientCreditsError as PreCheckInsufficientCreditsError,
  type PreCheckRedis,
  type ReservationHandle,
  preCheckExactCost,
  releasePreCheck,
} from './preCheck.js'

export interface Image2RunInput {
  userId: bigint
  /** Stable per logical call (≤128 chars); retries must reuse it. */
  requestId: string
  prompt: string
  /** Must be in the policy allowlist; defaults to policy.editDefault. */
  model?: string
  /** Clamped to [1,4], billed 50×n. */
  n?: number
  /** Upstream size string, e.g. `1024x1536`; omitted = model default. */
  size?: string
  /** Reference images (PNG/JPEG/WebP bytes). Present → /images/edits. */
  referenceImages?: Buffer[]
  signal?: AbortSignal
}

export interface Image2RunResult {
  images: Buffer[]
  model: string
  costCredits: bigint
  /** false when the result was replayed from the completed-request cache. */
  charged: boolean
}

export type Image2RunErrorCode =
  | 'IMAGE2_DISABLED'
  | 'INVALID_IMAGE_REQUEST'
  | 'ERR_INSUFFICIENT_CREDITS'
  | 'IMAGE_DAILY_LIMIT'
  | 'IMAGE_REQUEST_IN_PROGRESS'
  | 'IMAGE_BILLING_FAILED'
  | 'NO_CODEX_ACCOUNT'
  | 'CODEX_EGRESS_UNAVAILABLE'
  | 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE'
  | 'IMAGE_CLIENT_ABORT'
  | 'IMAGE_INVALID_RESPONSE'
  | 'IMAGE_PROCESSING_FAILED'
  | 'IMAGE_RELAY_FAILED'
  | ReturnType<typeof classifyImageUpstreamFailure>

export class Image2RunError extends Error {
  constructor(
    readonly code: Image2RunErrorCode,
    message: string,
    /** Upstream may have produced (and billed) output; caller must not blindly resubmit elsewhere. */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'Image2RunError'
  }
}

export interface Image2RunDeps {
  pool: Pool
  preCheckRedis: PreCheckRedis
  policy: ImageModelPolicy
  enabled?: boolean
  logger?: Logger
  upstreamBaseUrl?: string
  fetchImpl?: typeof fetch
  pickAccount?: (userId: bigint) => Promise<bigint | null>
  resolveDispatcher?: (
    accountId: bigint,
  ) => Promise<{ accountId: bigint; proxyId: bigint | string; dispatcher: Dispatcher }>
  readAccessToken?: (accountId: bigint) => Promise<Buffer | null>
  waitRetry?: (ms: number, signal: AbortSignal) => Promise<void>
  onImageCharge?: (
    userId: bigint,
    info: { costCredits: string; balanceAfter: string | null },
  ) => void
  /** Test seam; production uses the real journey/hold primitives. */
  billing?: Partial<Image2Billing>
}

const defaultBilling = {
  getCompletedImageUsage,
  reserveImageUsage,
  markImageUsage,
  beginImageUpstreamAttempt,
  finishImageUpstreamAttempt,
  settleImageCharge,
  preCheckExactCost,
  releasePreCheck,
}
export type Image2Billing = typeof defaultBilling

const MAX_REFERENCE_IMAGES = 4
const MAX_PROMPT_CHARS = 8_000
const SIZE_RE = /^(?:auto|[1-9][0-9]{2,4}x[1-9][0-9]{2,4})$/

function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg'
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

function parseImages(bytes: Buffer): Promise<Array<Buffer | null>> | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { data?: Array<{ b64_json?: unknown }> }
    if (!Array.isArray(parsed.data)) return null
    return Promise.all(
      parsed.data.map((item) =>
        typeof item?.b64_json === 'string'
          ? decodeValidatedImageBase64(item.b64_json)
          : Promise.resolve(null),
      ),
    )
  } catch {
    return null
  }
}

async function decodeExpected(bytes: Buffer, n: number): Promise<Buffer[] | null> {
  const decoded = await parseImages(bytes)
  if (!decoded || decoded.length !== n || decoded.some((b) => b === null)) return null
  return decoded as Buffer[]
}

export function makeImage2Runner(
  deps: Image2RunDeps,
): (input: Image2RunInput) => Promise<Image2RunResult> {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'image2Run' })
  const enabled = deps.enabled ?? process.env.OC_IMAGE2_ENABLED === 'true'
  const baseUrl = (deps.upstreamBaseUrl ?? CODEX_OFFICIAL_UPSTREAM_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const waitRetry = deps.waitRetry ?? waitForImageRetry
  const pickAccount =
    deps.pickAccount ??
    (async (userId: bigint) =>
      (await pickCodexAccountForBinding(codexBindingAffinityKey(userId)))?.account_id ?? null)
  const resolveDispatcher = deps.resolveDispatcher ?? resolveCodexAccountEgressDispatcher
  const readAccessToken =
    deps.readAccessToken ??
    (async (accountId: bigint) => {
      const snap = await getCodexTokenSnapshot(accountId)
      if (!snap) return null
      if (snap.refresh) zeroBuffer(snap.refresh)
      return snap.token
    })

  const {
    getCompletedImageUsage,
    reserveImageUsage,
    markImageUsage,
    beginImageUpstreamAttempt,
    finishImageUpstreamAttempt,
    settleImageCharge,
    preCheckExactCost,
    releasePreCheck,
  } = { ...defaultBilling, ...deps.billing }

  return async function runImage2ForUser(input) {
    const { userId, requestId } = input
    const runLog = log.child({ uid: String(userId), requestId })
    if (!enabled) throw new Image2RunError('IMAGE2_DISABLED', 'Image 2 is temporarily unavailable')

    // ── validate & build the upstream body (deterministic for a given input) ──
    const model = input.model ?? deps.policy.editDefault
    const prompt = input.prompt.trim()
    const refs = input.referenceImages ?? []
    const n = Math.min(4, Math.max(1, Math.trunc(input.n ?? 1)))
    if (!deps.policy.allowed.has(model)) {
      throw new Image2RunError(
        'INVALID_IMAGE_REQUEST',
        `only model=${[...deps.policy.allowed].join('|')} is supported`,
      )
    }
    if (requestId.length < 1 || requestId.length > 128)
      throw new Image2RunError('INVALID_IMAGE_REQUEST', 'invalid request id')
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS)
      throw new Image2RunError('INVALID_IMAGE_REQUEST', 'invalid prompt')
    if (input.size !== undefined && !SIZE_RE.test(input.size))
      throw new Image2RunError('INVALID_IMAGE_REQUEST', 'invalid size')
    if (refs.length > MAX_REFERENCE_IMAGES)
      throw new Image2RunError('INVALID_IMAGE_REQUEST', 'too many reference images')
    const images: Array<{ image_url: string }> = []
    for (const ref of refs) {
      const mime = sniffImageMime(ref)
      if (!mime)
        throw new Image2RunError('INVALID_IMAGE_REQUEST', 'reference is not a png/jpeg/webp image')
      images.push({ image_url: `data:${mime};base64,${ref.toString('base64')}` })
    }
    const body = JSON.stringify({
      model,
      prompt,
      n,
      ...(input.size ? { size: input.size } : {}),
      ...(images.length > 0 ? { images } : {}),
    })
    const url = `${baseUrl}${images.length > 0 ? '/images/edits' : '/images/generations'}`
    const costCredits = IMAGE2_UNIT_COST * BigInt(n)

    const replay = async (): Promise<Image2RunResult | null> => {
      const cached = await getCompletedImageUsage(deps.pool, { userId, requestId }).catch(
        () => null,
      )
      if (!cached) return null
      const decoded = await decodeExpected(cached.responseBody, n)
      if (!decoded) return null
      return { images: decoded, model, costCredits, charged: false }
    }
    const cached = await replay()
    if (cached) {
      await releasePreCheck(deps.preCheckRedis, { userId: String(userId), requestId }).catch(
        () => {},
      )
      return cached
    }

    // ── reserve (DB journey row + redis hold), same order as the relay ──
    let reservation: ReservationHandle | null = null
    let reserved = false
    const usageKey = {
      userId,
      containerId: null,
      requestId,
      jobId: null,
      operation: 'native_image' as const,
    }
    try {
      const usage = await reserveImageUsage(deps.pool, { ...usageKey, imageCount: n, model })
      reserved = true
      if (!usage.alreadyCharged) {
        reservation = (
          await preCheckExactCost(deps.preCheckRedis, {
            userId,
            requestId,
            maxCost: costCredits,
          })
        ).reservation
      }
    } catch (err) {
      if (reserved)
        await markImageUsage(deps.pool, {
          ...usageKey,
          status: 'failed',
          errorCode: 'precheck_failed',
        }).catch(() => {})
      if (reservation) await releasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
      if (err instanceof PreCheckInsufficientCreditsError)
        throw new Image2RunError('ERR_INSUFFICIENT_CREDITS', err.message)
      if (err instanceof ImageDailyLimitError)
        throw new Image2RunError('IMAGE_DAILY_LIMIT', err.message)
      if ((err as { code?: string }).code === '23505') {
        const raced = await replay()
        if (raced) return raced
        throw new Image2RunError(
          'IMAGE_REQUEST_IN_PROGRESS',
          'another Image 2 request is already running',
          true,
        )
      }
      runLog.error('image2_run_preflight_failed', { err: err as Error })
      throw new Image2RunError('IMAGE_BILLING_FAILED', 'image billing preflight failed', true)
    }
    const fail = async (
      code: Image2RunErrorCode,
      message: string,
      retryable = false,
    ): Promise<never> => {
      // Journey error codes match the relay's vocabulary so ops queries stay uniform.
      const errorCode =
        code === 'ERR_INSUFFICIENT_CREDITS'
          ? 'IMAGE_BILLING_INSUFFICIENT'
          : code === 'NO_CODEX_ACCOUNT'
            ? 'account_unavailable'
            : code === 'CODEX_EGRESS_UNAVAILABLE'
              ? 'egress_unavailable'
              : code === 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE'
                ? 'token_unavailable'
                : code
      await markImageUsage(deps.pool, { ...usageKey, status: 'failed', errorCode }).catch(() => {})
      if (reservation) await releasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
      reservation = null
      throw new Image2RunError(code, message, retryable)
    }

    // ── account / egress / token (no container binding: user-affine pick) ──
    let accountId: bigint | null
    try {
      accountId = await pickAccount(userId)
    } catch (err) {
      runLog.warn('image2_run_account_pick_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      accountId = null
    }
    if (accountId === null) return fail('NO_CODEX_ACCOUNT', 'no active codex account', true)
    let dispatcher: Dispatcher
    try {
      dispatcher = (await resolveDispatcher(accountId)).dispatcher
    } catch {
      runLog.warn('image2_run_egress_unavailable', { codexAccountId: String(accountId) })
      return fail('CODEX_EGRESS_UNAVAILABLE', 'codex account egress unavailable', true)
    }
    let token: Buffer | null
    try {
      token = await readAccessToken(accountId)
    } catch {
      token = null
    }
    if (!token || token.length === 0) {
      if (token) zeroBuffer(token)
      return fail('CODEX_ACCOUNT_TOKEN_UNAVAILABLE', 'codex account token unavailable', true)
    }
    const headers = new Headers({
      'content-type': 'application/json',
      'accept-encoding': 'identity',
      originator: 'codex_cli_rs',
    })
    try {
      const tokenText = token.toString('utf8')
      const workspace = extractChatGptAccountId(tokenText)
      if (workspace) headers.set('chatgpt-account-id', workspace)
      headers.set('authorization', `Bearer ${tokenText}`)
    } finally {
      zeroBuffer(token)
    }

    // ── upstream attempts ──
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    let attemptId: bigint | null = null
    let failureCode: Image2RunErrorCode | null = null
    let upstreamSucceeded = false
    const finishAttempt = async (
      outcome: 'succeeded' | 'failed' | 'cancelled',
      errorCode?: string,
    ) => {
      if (attemptId === null) return
      const id = attemptId
      attemptId = null
      await finishImageUpstreamAttempt(deps.pool, {
        userId,
        requestId,
        attemptId: id,
        outcome,
        errorCode,
      }).catch(() => {})
    }
    const fetchOnce = async (): Promise<Response> => {
      failureCode = null
      const attempt = await beginImageUpstreamAttempt(deps.pool, { userId, requestId })
      attemptId = attempt.attemptId
      runLog.info('image2_run_attempt_started', {
        attempt: attempt.attemptNo,
        codexAccountId: String(accountId),
      })
      return fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher })
    }
    try {
      let upstream = await fetchOnce()
      if (upstream.status === 429) {
        failureCode = 'IMAGE_UPSTREAM_RATE_LIMITED'
        await finishAttempt('failed', failureCode)
        const delay = image429RetryDelayMs(upstream.headers)
        if (delay !== null) {
          await upstream.body?.cancel().catch(() => {})
          await waitRetry(delay, controller.signal)
          upstream = await fetchOnce()
        }
      }
      const bytes = await readBoundedResponseBody(upstream)
      if (!upstream.ok) {
        failureCode = classifyImageUpstreamFailure(upstream.status, bytes)
        runLog.warn('image2_run_upstream_non_2xx', {
          status: upstream.status,
          failureCode,
          imageCount: n,
        })
        throw new Image2RunError(
          failureCode,
          'Image 2 upstream request was not accepted',
          upstream.status === 429 || upstream.status >= 500,
        )
      }
      const decoded = await decodeExpected(bytes, n)
      if (!decoded) {
        failureCode = 'IMAGE_INVALID_RESPONSE'
        throw new Image2RunError(failureCode, 'Image 2 returned an invalid image')
      }
      await finishAttempt('succeeded')
      upstreamSucceeded = true
      if (controller.signal.aborted) throw new DOMException('image request aborted', 'AbortError')
      const settled = await settleImageCharge(deps.pool, {
        ...usageKey,
        imageCount: n,
        model,
        responseBody: bytes,
      })
      if (reservation) {
        await releasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
        reservation = null
      }
      if (!settled.duplicate && deps.onImageCharge) {
        try {
          deps.onImageCharge(userId, {
            costCredits: costCredits.toString(),
            balanceAfter: settled.balanceAfter?.toString() ?? null,
          })
        } catch {
          runLog.warn('image2_run_charge_callback_failed')
        }
      }
      return { images: decoded, model, costCredits, charged: !settled.duplicate }
    } catch (err) {
      const aborted = controller.signal.aborted
      const code: Image2RunErrorCode = aborted
        ? 'IMAGE_CLIENT_ABORT'
        : (failureCode ??
          (err instanceof LedgerInsufficientCreditsError
            ? 'ERR_INSUFFICIENT_CREDITS'
            : upstreamSucceeded
              ? 'IMAGE_PROCESSING_FAILED'
              : 'IMAGE_RELAY_FAILED'))
      await finishAttempt(
        aborted ? 'cancelled' : 'failed',
        code === 'ERR_INSUFFICIENT_CREDITS' ? 'IMAGE_BILLING_INSUFFICIENT' : code,
      )
      if (!(err instanceof Image2RunError)) {
        runLog.warn('image2_run_failed', {
          failureCode: code,
          errorClass: err instanceof Error ? err.name : typeof err,
        })
      }
      const retryable =
        err instanceof Image2RunError ? err.retryable : code === 'IMAGE_RELAY_FAILED'
      return await fail(
        code,
        err instanceof Image2RunError ? err.message : 'Image 2 request failed',
        retryable,
      )
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}
