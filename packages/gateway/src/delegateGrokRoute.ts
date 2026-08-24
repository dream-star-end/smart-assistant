/**
 * Container gateway → master delegate grok relay route client.
 *
 * Delegate turns are container-local: unlike browser turns, nobody injects a
 * master-minted `__oc_grok_route` into their frames. When a delegate resolves
 * to engine grok, the gateway asks master (same authenticated internal channel
 * as masterTurnLease) to mint a route against the grok account pool, heartbeats
 * it while the turn is live, and releases it at turn end. Master-side mount is
 * selfhost-exemption-gated; production containers are rejected earlier in
 * decideLocalExecution and never reach this client.
 */

import { isGrokEngineModel } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

/**
 * Whether a local delegate turn must mint a master Grok relay route.
 *
 * `send_to_agent` does not pass `model`; when catalog authority is off the
 * previous fallback only looked at requestedModel and skipped mint, then
 * GrokAdapter fail-closed with GROK_ROUTE_REQUIRED. Agent default model is
 * the send_to_agent source of truth in that case.
 */
export function shouldMintDelegateGrokRoute(args: {
  delegateEngine?: string | null
  requestedModel?: string | null
  agentModel?: string | null
}): boolean {
  if (args.delegateEngine) return args.delegateEngine === 'grok'
  return isGrokEngineModel(args.requestedModel || args.agentModel)
}

export function delegateGrokMintModelId(args: {
  canonicalModel?: string | null
  requestedModel?: string | null
  agentModel?: string | null
}): string | undefined {
  const model = args.canonicalModel || args.requestedModel || args.agentModel || undefined
  return isGrokEngineModel(model) ? model : undefined
}

const MINT_PATH = '/internal/v5/delegate/grok-route/mint'
const RELEASE_PATH = '/internal/v5/delegate/grok-route/release'
const RENEW_PATH = '/internal/v5/delegate/grok-route/renew'

const MINT_TIMEOUT_MS = 10_000
const RENEW_RELEASE_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 32 * 1024
const HEARTBEAT_INTERVAL_MS = 60_000
const RELEASE_RETRY_MIN_MS = 1_000
const RELEASE_RETRY_MAX_MS = 30_000

// At most the durable Grok route cap can be present here. Timers are unrefed so
// cleanup improves a live gateway without delaying process shutdown.
const pendingReleaseTasks = new Map<string, Promise<void>>()

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
const SESSION_ID_RE = /^[A-Za-z0-9_:@.-]{1,128}$/

export interface DelegateGrokRouteLease {
  readonly baseUrl: string
  readonly routeToken: string
  /** Stops the heartbeat and best-effort expires the master-side lease. */
  release(): Promise<void>
}

export type DelegateGrokRouteAcquire =
  | { ok: true; lease: DelegateGrokRouteLease }
  | { ok: false; httpStatus: number; reason: string }

export interface DelegateGrokRouteLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void
  debug?: (msg: string, fields?: Record<string, unknown>) => void
}

interface FetchResult {
  statusCode: number
  text: string
}

async function postJson(
  fetcher: typeof undiciRequest,
  url: string,
  bearer: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<FetchResult> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += bytes.length
    if (total > MAX_RESPONSE_BYTES) throw new Error('delegate grok route response too large')
    chunks.push(bytes)
  }
  return { statusCode: response.statusCode, text: Buffer.concat(chunks, total).toString('utf8') }
}

function errorText(result: FetchResult): string {
  try {
    const parsed = JSON.parse(result.text) as { error?: { message?: unknown } }
    if (parsed.error && typeof parsed.error.message === 'string' && parsed.error.message) {
      return parsed.error.message
    }
  } catch {
    /* fall through to raw text */
  }
  return result.text.slice(0, 200)
}

function scheduleReleaseUntilAck(args: {
  fetcher: typeof undiciRequest
  baseUrl: string
  bearer: string
  routeToken: string
  log: DelegateGrokRouteLog
  retryMs: number
}): void {
  if (pendingReleaseTasks.has(args.routeToken)) return
  const task = (async () => {
    let delayMs = Math.max(1, args.retryMs)
    let warned = false
    for (;;) {
      try {
        const result = await postJson(
          args.fetcher,
          `${args.baseUrl}${RELEASE_PATH}`,
          args.bearer,
          { routeToken: args.routeToken },
          RENEW_RELEASE_TIMEOUT_MS,
        )
        // Unknown/already-expired is deliberately returned as HTTP 200.
        if (result.statusCode === 200) return
        if (!warned) {
          warned = true
          args.log.warn('delegate_grok_route_release_deferred', { status: result.statusCode })
        }
      } catch (err) {
        if (!warned) {
          warned = true
          args.log.warn('delegate_grok_route_release_deferred', { err: String(err) })
        } else {
          args.log.debug?.('delegate_grok_route_release_retry_failed', { err: String(err) })
        }
      }
      await sleepUnref(delayMs)
      delayMs = Math.min(Math.max(RELEASE_RETRY_MIN_MS, delayMs * 2), RELEASE_RETRY_MAX_MS)
    }
  })().finally(() => {
    pendingReleaseTasks.delete(args.routeToken)
  })
  pendingReleaseTasks.set(args.routeToken, task)
}

export async function acquireDelegateGrokRoute(args: {
  modelId: string
  sessionId?: string
  log: DelegateGrokRouteLog
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  heartbeatMs?: number
  /** Test seam; production starts at one second and backs off to 30 seconds. */
  releaseRetryMs?: number
}): Promise<DelegateGrokRouteAcquire> {
  const env = args.env ?? process.env
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) {
    return {
      ok: false,
      httpStatus: 503,
      reason: 'master 内部通道未配置(OPENCLAUDE_V3_MASTER_BASE_URL/TOKEN 缺失),无法铸造 grok relay route',
    }
  }
  const fetcher = args.fetcher ?? undiciRequest
  const sessionId =
    typeof args.sessionId === 'string' && SESSION_ID_RE.test(args.sessionId)
      ? args.sessionId
      : undefined

  let mint: FetchResult
  try {
    mint = await postJson(fetcher, `${baseUrl}${MINT_PATH}`, bearer, {
      modelId: args.modelId,
      ...(sessionId ? { sessionId } : {}),
    }, MINT_TIMEOUT_MS)
  } catch (err) {
    return {
      ok: false,
      httpStatus: 503,
      reason: `无法连接 master 铸造 grok route: ${(err as Error).message}`,
    }
  }

  if (mint.statusCode === 200) {
    let parsed: { baseUrl?: unknown; routeToken?: unknown }
    try {
      parsed = JSON.parse(mint.text) as typeof parsed
    } catch {
      return { ok: false, httpStatus: 502, reason: 'master grok route mint 响应格式错误' }
    }
    if (
      typeof parsed.baseUrl !== 'string' ||
      !parsed.baseUrl ||
      typeof parsed.routeToken !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.routeToken)
    ) {
      return { ok: false, httpStatus: 502, reason: 'master grok route mint 响应字段缺失' }
    }
    const routeToken = parsed.routeToken
    const heartbeatMs = args.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
    // Hard cap: a leaked lease (caller crashes between mint and its finally)
    // must not slide the master TTL forever. 120 beats × 60s ≈ 2h, far above
    // any delegate idle timeout; release() clears the timer earlier.
    let beats = 0
    let heartbeat: NodeJS.Timeout | null = setInterval(() => {
      if (++beats > 120) {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        return
      }
      postJson(fetcher, `${baseUrl}${RENEW_PATH}`, bearer, { routeToken }, RENEW_RELEASE_TIMEOUT_MS)
        .then((result) => {
          if (result.statusCode !== 200) {
            // 不写 routeToken(即使前缀):route token 属于凭据材料。
            args.log.warn('delegate_grok_route_heartbeat_rejected', {
              status: result.statusCode,
            })
          }
        })
        .catch((err) => {
          // Relay requests renew the lease themselves; a lost heartbeat only
          // risks the generic slot reaper, and the next relay request restores it.
          args.log.debug?.('delegate_grok_route_heartbeat_failed', {
            err: String(err),
          })
        })
    }, heartbeatMs)
    heartbeat.unref?.()
    const lease: DelegateGrokRouteLease = {
      baseUrl: parsed.baseUrl,
      routeToken,
      release: async () => {
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        // Completion must stay fast for the user. A transient master deploy must
        // also not turn this into a seven-day durable slot leak, so cleanup keeps
        // retrying in the live gateway until the idempotent endpoint acknowledges.
        scheduleReleaseUntilAck({
          fetcher,
          baseUrl,
          bearer,
          routeToken,
          log: args.log,
          retryMs: args.releaseRetryMs ?? RELEASE_RETRY_MIN_MS,
        })
      },
    }
    return { ok: true, lease }
  }

  if (mint.statusCode === 409) {
    return { ok: false, httpStatus: 409, reason: 'Grok 订阅账号并发已满,请稍后重试' }
  }
  if (mint.statusCode === 503) {
    return { ok: false, httpStatus: 503, reason: errorText(mint) || '无可用 Grok 订阅账号' }
  }
  if (mint.statusCode === 404) {
    return {
      ok: false,
      httpStatus: 503,
      reason: 'master 未开放 delegate grok route(需要 selfhost 引擎本地豁免)',
    }
  }
  return {
    ok: false,
    httpStatus: 502,
    reason: `master grok route mint HTTP ${mint.statusCode}: ${errorText(mint)}`,
  }
}
