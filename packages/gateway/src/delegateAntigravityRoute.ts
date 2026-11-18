/**
 * Container gateway → master delegate Antigravity relay route client (OCV5-738).
 *
 * Delegate turns are container-local: unlike browser turns, nobody injects a
 * master-minted `__oc_antigravity_route` into their frames, so the Antigravity
 * adapter fail-closed with ANTIGRAVITY_ROUTE_REQUIRED. Once the delegate
 * engine-billing admit has produced the master-owned requestId, the gateway
 * asks master to mint a route for that admission (same authenticated internal
 * channel as delegate grok routes), heartbeats it while the turn is live and
 * releases it at turn end.
 *
 * The container never mints credentials: it only forwards the route the
 * master signed for this container/user/admission. Master-side mount is
 * selfhost-exemption-gated; production containers reject antigravity delegate
 * turns in decideLocalExecution and never reach this client.
 */

import {
  DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH as MINT_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH as RELEASE_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH as RENEW_PATH,
} from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

const MINT_TIMEOUT_MS = 15_000
const RENEW_RELEASE_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 32 * 1024
const HEARTBEAT_INTERVAL_MS = 60_000
const RELEASE_RETRY_MIN_MS = 1_000
const RELEASE_RETRY_MAX_MS = 30_000
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const REQUEST_ID_RE = /^[0-9a-f]{32}$/

const pendingReleaseTasks = new Map<string, Promise<void>>()

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Master-signed route, in the exact shape routeOverrides projects. */
export interface DelegateAntigravityRoute {
  baseUrl: string
  routeToken: string
  accessToken: string
  accessTokenExpiresAt: string
  idToken?: string
}

export interface DelegateAntigravityRouteLease {
  readonly route: DelegateAntigravityRoute
  readonly routeToken: string
  /** Stops the heartbeat and best-effort expires the master-side route. */
  release(): Promise<void>
}

export type DelegateAntigravityRouteAcquire =
  | { ok: true; lease: DelegateAntigravityRouteLease }
  | { ok: false; httpStatus: number; reason: string }

export interface DelegateAntigravityRouteLog {
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
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error('delegate antigravity route response too large')
    }
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
  log: DelegateAntigravityRouteLog
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
          args.log.warn('delegate_antigravity_route_release_deferred', {
            status: result.statusCode,
          })
        }
      } catch (err) {
        if (!warned) {
          warned = true
          args.log.warn('delegate_antigravity_route_release_deferred', { err: String(err) })
        } else {
          args.log.debug?.('delegate_antigravity_route_release_retry_failed', {
            err: String(err),
          })
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

function parseRoute(text: string): DelegateAntigravityRoute | null {
  let parsed: { route?: Record<string, unknown> }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return null
  }
  const route = parsed.route
  if (!route || typeof route !== 'object') return null
  if (typeof route.baseUrl !== 'string' || !route.baseUrl) return null
  if (typeof route.routeToken !== 'string' || !ROUTE_TOKEN_RE.test(route.routeToken)) return null
  if (typeof route.accessToken !== 'string' || !route.accessToken) return null
  if (typeof route.accessTokenExpiresAt !== 'string' || !route.accessTokenExpiresAt) return null
  return {
    baseUrl: route.baseUrl,
    routeToken: route.routeToken,
    accessToken: route.accessToken,
    accessTokenExpiresAt: route.accessTokenExpiresAt,
    ...(typeof route.idToken === 'string' && route.idToken ? { idToken: route.idToken } : {}),
  }
}

export async function acquireDelegateAntigravityRoute(args: {
  requestId: string
  log: DelegateAntigravityRouteLog
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  heartbeatMs?: number
  /** Test seam; production starts at one second and backs off to 30 seconds. */
  releaseRetryMs?: number
}): Promise<DelegateAntigravityRouteAcquire> {
  if (!REQUEST_ID_RE.test(args.requestId)) {
    return { ok: false, httpStatus: 400, reason: 'delegate antigravity requestId malformed' }
  }
  const env = args.env ?? process.env
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) {
    return {
      ok: false,
      httpStatus: 503,
      reason:
        'master 内部通道未配置(OPENCLAUDE_V3_MASTER_BASE_URL/TOKEN 缺失),无法铸造 antigravity relay route',
    }
  }
  const fetcher = args.fetcher ?? undiciRequest

  let mint: FetchResult
  try {
    mint = await postJson(
      fetcher,
      `${baseUrl}${MINT_PATH}`,
      bearer,
      { requestId: args.requestId },
      MINT_TIMEOUT_MS,
    )
  } catch (err) {
    return {
      ok: false,
      httpStatus: 503,
      reason: `无法连接 master 铸造 antigravity route: ${(err as Error).message}`,
    }
  }

  if (mint.statusCode === 200) {
    const route = parseRoute(mint.text)
    if (!route) {
      return { ok: false, httpStatus: 503, reason: 'master antigravity route mint 响应字段缺失' }
    }
    const routeToken = route.routeToken
    const heartbeatMs = args.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
    // Master renews the KV TTL on relay traffic; this heartbeat covers idle
    // gaps and proves liveness. Hard cap: a leaked lease must not slide the
    // master TTL forever (120 × 60s ≈ 2h, above any delegate idle timeout).
    let beats = 0
    let heartbeat: NodeJS.Timeout | null = setInterval(() => {
      if (++beats > 720) {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        return
      }
      postJson(
        fetcher,
        `${baseUrl}${RENEW_PATH}`,
        bearer,
        { routeToken },
        RENEW_RELEASE_TIMEOUT_MS,
      )
        .then((result) => {
          if (result.statusCode !== 200) {
            // Never log the token, even a prefix: route tokens are credentials.
            args.log.warn('delegate_antigravity_route_heartbeat_rejected', {
              status: result.statusCode,
            })
          }
        })
        .catch((err) => {
          args.log.debug?.('delegate_antigravity_route_heartbeat_failed', {
            err: String(err),
          })
        })
    }, heartbeatMs)
    heartbeat.unref?.()
    const lease: DelegateAntigravityRouteLease = {
      route,
      routeToken,
      release: async () => {
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
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
    // The admission row is unusable (already minted / moved on). Like every
    // other missing-route outcome this is a fail-closed 503: the caller must
    // abandon and never start the turn bare.
    const text = errorText(mint)
    return {
      ok: false,
      httpStatus: 503,
      reason: text.includes('ALREADY_MINTED')
        ? '该委派已申请过 Antigravity route,不能重复铸造'
        : `Antigravity 委派准入不可用: ${text}`,
    }
  }
  if (mint.statusCode === 503) {
    return { ok: false, httpStatus: 503, reason: errorText(mint) || '无可用 Antigravity 账号' }
  }
  if (mint.statusCode === 404) {
    return {
      ok: false,
      httpStatus: 503,
      reason: 'master 未开放 delegate antigravity route(需要 selfhost 引擎本地豁免)',
    }
  }
  return {
    ok: false,
    httpStatus: 502,
    reason: `master antigravity route mint HTTP ${mint.statusCode}: ${errorText(mint)}`,
  }
}

/** Main turns use the same identity-scoped renew endpoint, never the mint endpoint. */
export async function renewAntigravityRouteLease(
  routeToken: string,
  opts: { env?: NodeJS.ProcessEnv; fetcher?: typeof undiciRequest } = {},
): Promise<void> {
  const env = opts.env ?? process.env
  if (env.OC_SELFHOST_ENGINE_LOCAL_TURNS !== '1') return
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!base || !bearer || !ROUTE_TOKEN_RE.test(routeToken)) return
  const result = await postJson(opts.fetcher ?? undiciRequest, `${base}${RENEW_PATH}`,
    bearer, { routeToken }, RENEW_RELEASE_TIMEOUT_MS)
  if (result.statusCode !== 200) throw new Error(`Antigravity route renewal HTTP ${result.statusCode}`)
  if (JSON.parse(result.text)?.ok !== true) throw new Error('Antigravity route renewal rejected')
}
