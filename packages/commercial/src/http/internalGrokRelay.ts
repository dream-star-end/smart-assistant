/** Master-side relay for official Grok CLI subscription traffic. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { request, type Dispatcher } from 'undici'
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from '../auth/containerIdentity.js'
import { resolveGrokRouteContext } from '../account-pool/groups.js'
import { getFreshGrokAccessToken } from '../account-pool/grokOAuth.js'
import type { AccountHealthTracker } from '../account-pool/health.js'
import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import { query } from '../db/queries.js'
import { ensureRequestId, REQUEST_ID_HEADER, setSecurityHeaders } from './util.js'

import { GROK_RELAY_PREFIX } from '@openclaude/protocol'

export { GROK_RELAY_PREFIX }
export const GROK_OFFICIAL_UPSTREAM_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const TOKEN_RE = /^[0-9a-f]{64}$/
const ALLOWED = new Set([
  'GET /models',
  'GET /api-key',
  'GET /settings',
  'GET /user',
  'GET /billing',
  'GET /deployment/config',
  'POST /chat/completions',
  'POST /responses',
  // Official Grok CLI Imagine (image_gen / image_edit). Same host as chat proxy.
  'POST /images/generations',
  'POST /images/edits',
])
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const GROK_CORRELATION_HEADERS = new Set([
  'x-grok-conv-id',
  'x-grok-req-id',
  'x-grok-session-id',
  'x-grok-agent-id',
])
const GROK_CORRELATION_VALUE_RE = /^[A-Za-z0-9._:-]{1,256}$/
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

export interface GrokRelayCtx { hostUuid: string; boundIp: string }
export type GrokRelayHandler = (req: IncomingMessage, res: ServerResponse, ctx: GrokRelayCtx) => Promise<void>

/**
 * How an upstream xAI status reflects on the *account* (not the request).
 * Mirrors the scheduler's ReleaseResult kinds so all providers reason alike.
 *
 *   - success      → health recovers
 *   - failure      → account-attributable: 401/402/403 (token/plan), 429 (quota).
 *                    Counts toward the 3-strike cooldown.
 *   - upstream     → 5xx: xAI itself is unhealthy. NOT a strike — the pool has
 *                    only a handful of Grok accounts, and a global 529 burst
 *                    would otherwise cool every one of them for 10 minutes
 *                    (and kill in-flight routes, which require status='active')
 *                    when the old behaviour self-healed the instant xAI did.
 *                    Same reasoning as CCB's 'transient_network': don't bill
 *                    the account for the provider's outage. Still surfaced on
 *                    the row (fail_count / last_error) so admins can see it.
 *   - client_error → request-shape 4xx (400/404/405/413/422…): the CLI sent
 *                    something xAI rejects; the account is fine. No mutation.
 */
export type GrokRelayOutcome = 'success' | 'failure' | 'upstream' | 'client_error'

export function classifyGrokRelayStatus(status: number): GrokRelayOutcome {
  if (status < 400) return 'success'
  if (status === 401 || status === 402 || status === 403 || status === 429) return 'failure'
  if (status >= 500) return 'upstream'
  return 'client_error'
}

/**
 * Default per-request account feedback for the relay: route the classified
 * outcome through the shared AccountHealthTracker so a Grok account with a
 * dead token / exhausted quota / failing upstream trips the same 3-strike
 * cooldown (and cooldownRecoveryActor half-open) as a CCB account, instead
 * of staying in the WRH candidate set until the hourly usage sweep notices.
 *
 * 401 additionally forces `oauth_expires_at = NOW()` so the next relay call
 * refreshes the access token before retrying — preserved from the previous
 * counter-only recorder.
 */
export function makeGrokRelayHealthRecorder(deps: {
  health: Pick<AccountHealthTracker, 'onSuccess' | 'onFailure'>
  query?: typeof query
}): (accountId: bigint, statusCode: number) => Promise<void> {
  const q = deps.query ?? query
  return async (accountId, statusCode) => {
    const outcome = classifyGrokRelayStatus(statusCode)
    if (outcome === 'client_error') return
    if (outcome === 'success') {
      await deps.health.onSuccess(accountId)
      return
    }
    if (outcome === 'upstream') {
      // Visible, but not a strike (see GrokRelayOutcome).
      await q(
        `UPDATE claude_accounts
            SET fail_count = fail_count + 1, last_used_at = NOW(), last_error = $2, updated_at = NOW()
          WHERE id = $1 AND provider = 'grok'`,
        [String(accountId), `grok_http_${statusCode}`],
      )
      return
    }
    if (statusCode === 401) {
      await q(
        `UPDATE claude_accounts SET oauth_expires_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND provider = 'grok'`,
        [String(accountId)],
      )
    }
    await deps.health.onFailure(accountId, `grok_http_${statusCode}`)
  }
}

function grokRelayPublicMessage(code: string): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'grok relay path or token not found'
    case 'METHOD_NOT_ALLOWED':
      return 'grok relay method not allowed'
    case 'GROK_ROUTE_EXPIRED':
      return 'grok route expired'
    case 'GROK_SLOT_LEASE_LOST':
      return 'grok slot lease lost'
    case 'UNAUTHORIZED':
      return 'grok relay unauthorized'
    default:
      return `grok relay error (${code})`
  }
}

function error(res: ServerResponse, status: number, code: string, requestId: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code, message: grokRelayPublicMessage(code) }, requestId }))
}

function upstreamHeaders(req: IncomingMessage, accessToken: Buffer): Record<string, string> {
  const out: Record<string, string> = {
    authorization: `Bearer ${accessToken.toString('utf8')}`,
    // These two headers are part of the official CLI proxy contract. Own them
    // server-side so a container cannot route a billed grok-build turn to a
    // different backend model or switch the proxy authentication mode.
    'x-xai-token-auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-model-override': 'grok-build',
    'x-grok-client-mode': 'headless',
  }
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    const safe = key === 'accept' || key === 'accept-language' || key === 'content-type' || key === 'user-agent'
      || key === 'x-grok-client-version' || key === 'x-grok-client-surface' || key === 'x-grok-client-identifier'
    if (!safe || rawValue === undefined) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue
  }
  for (const key of GROK_CORRELATION_HEADERS) {
    const value = req.headers[key]
    if (typeof value === 'string' && GROK_CORRELATION_VALUE_RE.test(value)) out[key] = value
  }
  const turnIdx = req.headers['x-grok-turn-idx']
  if (typeof turnIdx === 'string' && /^\d{1,10}$/.test(turnIdx)) out['x-grok-turn-idx'] = turnIdx
  const traceparent = req.headers.traceparent
  if (typeof traceparent === 'string' && TRACEPARENT_RE.test(traceparent)) out.traceparent = traceparent
  return out
}

export function makeGrokRelayHandler(deps: {
  identityRepo: ContainerIdentityRepo
  resolveContext?: typeof resolveGrokRouteContext
  freshToken?: typeof getFreshGrokAccessToken
  resolveDispatcher?: (accountId: bigint) => Promise<{ dispatcher: Dispatcher }>
  requestFn?: typeof request
  recordStatus?: (accountId: bigint, statusCode: number) => Promise<void>
  renewSlot?: (accountId: bigint, slotId: string) => boolean
}): GrokRelayHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    let identity
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) { error(res, 401, 'UNAUTHORIZED', requestId); return }
      throw err
    }
    const parsed = new URL(req.url ?? '/', 'http://local')
    const match = new RegExp(`^${GROK_RELAY_PREFIX}/route/([0-9a-f]{64})/v1(/.*)$`).exec(parsed.pathname)
    if (!match || !TOKEN_RE.test(match[1]!)) { error(res, 404, 'NOT_FOUND', requestId); return }
    const suffix = match[2]!
    const method = (req.method ?? 'GET').toUpperCase()
    if (!ALLOWED.has(`${method} ${suffix}`)) { error(res, 405, 'METHOD_NOT_ALLOWED', requestId); return }
    const context = await (deps.resolveContext ?? resolveGrokRouteContext)({
      token: match[1]!,
      containerId: identity.containerId,
      userId: BigInt(identity.userId),
    })
    if (!context || context.modelId !== 'grok-build') { error(res, 404, 'GROK_ROUTE_EXPIRED', requestId); return }
    let accessToken: Buffer | null = null
    if (deps.renewSlot && !deps.renewSlot(context.accountId, context.slotId)) {
      error(res, 409, 'GROK_SLOT_LEASE_LOST', requestId)
      return
    }
    // In the split-egress topology the durable active grok_route_context row is
    // the lease authority and Master rehydrates it before every new allocation.
    // A co-located Master can additionally refresh its in-memory slot while a
    // single upstream HTTP request is flowing.
    const renewTimer = deps.renewSlot ? setInterval(() => {
      if (!deps.renewSlot?.(context.accountId, context.slotId)) {
        res.destroy(new Error('GROK_SLOT_LEASE_LOST'))
      }
    }, 60_000) : null
    renewTimer?.unref()
    try {
      // Same selfhost workaround as device auth: xAI is reachable from the
      // master host, but the bound sing-box egress is IPv6-only and RST.
      // Explicit direct Agent also bypasses the process-global EnvHttpProxyAgent.
      const route = await (deps.resolveDispatcher ?? (async () =>
        ({ dispatcher: directEgressDispatcher() })))(context.accountId)
      accessToken = await (deps.freshToken ?? getFreshGrokAccessToken)(context.accountId)
      const upstream = await (deps.requestFn ?? request)(`${GROK_OFFICIAL_UPSTREAM_BASE_URL}${suffix}${parsed.search}`, {
        method: method as 'GET' | 'POST',
        dispatcher: route.dispatcher,
        headers: upstreamHeaders(req, accessToken),
        body: method === 'GET' ? undefined : req,
      })
      res.statusCode = upstream.statusCode
      for (const [rawKey, rawValue] of Object.entries(upstream.headers)) {
        const key = rawKey.toLowerCase()
        if (!HOP.has(key) && key !== 'content-length' && rawValue !== undefined) {
          res.setHeader(rawKey, Array.isArray(rawValue) ? rawValue : String(rawValue))
        }
      }
      // Account feedback. Production injects makeGrokRelayHealthRecorder (shared
      // AccountHealthTracker → 3-strike cooldown); the bare counter fallback
      // only exists for callers that have no tracker (tests / legacy wiring).
      const recordStatus = deps.recordStatus ?? (async (accountId: bigint, statusCode: number) => {
        await query(
          `UPDATE claude_accounts SET
             success_count = success_count + CASE WHEN $2::int < 400 THEN 1 ELSE 0 END,
             fail_count = fail_count + CASE WHEN $2::int >= 400 THEN 1 ELSE 0 END,
             oauth_expires_at = CASE WHEN $2::int = 401 THEN NOW() ELSE oauth_expires_at END,
             last_used_at = NOW(), last_error = CASE WHEN $2::int >= 400 THEN 'grok_http_' || $2::text ELSE NULL END,
             updated_at = NOW() WHERE id = $1 AND provider = 'grok'`,
          [String(accountId), statusCode],
        )
      })
      void recordStatus(context.accountId, upstream.statusCode).catch(() => {})
      await pipeline(upstream.body, res)
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined)
      } else {
        error(res, 503, 'GROK_UPSTREAM_UNAVAILABLE', requestId)
      }
    } finally {
      if (renewTimer !== null) clearInterval(renewTimer)
      accessToken?.fill(0)
    }
  }
}
