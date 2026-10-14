/**
 * Master/egress relay for the official Antigravity CLI (OCV5-415 P2).
 *
 * The CLI runs with `CLOUD_CODE_URL=<loopback route>` and holds only a
 * limited (openid/userinfo) token. The gateway's loopback relay replaces the
 * CLI's Authorization with the container token and forwards here. This
 * handler:
 *   - verifies the container identity and the opaque route token;
 *   - forwards only the `/v1internal:<method>` calls the pinned CLI makes;
 *   - for generate calls, accepts only the route model's CLI ids plus the
 *     title-generation model, and admits a call only if metered cost plus
 *     the in-flight reservations of the same route still fit the admission
 *     budget (reserve-then-check in one synchronous step, so concurrent
 *     calls cannot all pass on the same stale total), at most
 *     ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE at a time;
 *   - injects the gemini OAuth account's full-scope access token;
 *   - records every generate call's usageMetadata (antigravity_relay_usage)
 *     before ending the response, so turn settlement sees it;
 *   - reports the upstream status to the account pool.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ANTIGRAVITY_AUX_UPSTREAM_MODELS,
  antigravityAllowedUpstreamModels,
} from '@openclaude/protocol'
import { type Dispatcher, request } from 'undici'
import { reportAntigravityModelOutcome } from '../account-pool/antigravityModelCooldown.js'
import {
  AntigravityOAuthError,
  getFreshAntigravityAccessToken,
} from '../account-pool/antigravityOAuth.js'
import {
  type AntigravityPoolOutcome,
  classifyAntigravityUpstream,
  reportAntigravityOutcome,
} from '../account-pool/antigravityPoolInterim.js'
import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import {
  ANTIGRAVITY_RELAY_PREFIX,
  type AntigravityRelayRoute,
  resolveAntigravityRelayRoute,
} from '../billing/antigravityRouteContext.js'
import {
  type AntigravityUsageTotals,
  antigravityUsageCost,
  sumAntigravityRelayUsage,
} from '../billing/antigravitySettle.js'
import type { PricingCache } from '../billing/pricing.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export { ANTIGRAVITY_RELAY_PREFIX }
/** `CLOUD_CODE_URL` upstream that serves this OAuth client (cloudcode-pa 429s it). */
export const ANTIGRAVITY_UPSTREAM_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
const GENERATE_METHODS = new Set(['streamGenerateContent'])
/** Every `/v1internal:*` method the pinned 1.3.4 CLI calls (probe 2026-10-14). */
const METADATA_METHODS = new Set([
  'loadCodeAssist',
  'fetchUserInfo',
  'fetchAvailableModels',
  'fetchAdminControls',
  'listExperiments',
  'retrieveUserQuotaSummary',
  'writeTrajectoryAcls',
])
const MAX_GENERATE_BODY = 32 * 1024 * 1024
/** Title + agent call run together; subagents may add a couple more. */
export const ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE = 4
/** Output tokens assumed for an in-flight reservation (input comes from the body size). */
const RESERVED_OUTPUT_TOKENS = 2048
const MAX_METADATA_BODY = 1024 * 1024
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'user-agent']
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'set-cookie',
])
const PATH_RE = new RegExp(
  `^${ANTIGRAVITY_RELAY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/route/([0-9a-f]{64})/v1internal:([A-Za-z]{1,64})$`,
)

export type AntigravityRelayHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

export interface AntigravityUsageRow {
  /** One per forwarded upstream call, fixed before any retry: the insert is idempotent on it. */
  callId: string
  requestId: string
  userId: bigint
  accountId: bigint
  routeModelId: string
  upstreamModel: string
  requestType: string | null
  statusCode: number
  promptTokens: number
  candidatesTokens: number
  thoughtsTokens: number
  cachedTokens: number
}

export interface AntigravityRelayDeps {
  identityRepo: ContainerIdentityRepo
  /** OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET; empty → 503 ANTIGRAVITY_NOT_CONFIGURED. */
  clientSecret: string
  pricing?: Pick<PricingCache, 'get'> | null
  requestFn?: typeof request
  dispatcher?: Dispatcher
  resolveRoute?: typeof resolveAntigravityRelayRoute
  freshToken?: (accountId: bigint) => Promise<Buffer>
  reportOutcome?: (
    accountId: bigint,
    outcome: AntigravityPoolOutcome,
    detail: string | null,
  ) => Promise<void>
  /** Per-(account, catalog model) 5xx strikes; see antigravityModelCooldown. */
  reportModelOutcome?: (accountId: bigint, modelId: string, ok: boolean) => Promise<void>
  recordUsage?: (row: AntigravityUsageRow) => Promise<void>
  meteredCost?: (route: AntigravityRelayRoute) => Promise<bigint | null>
  /** Conservative cost of one generate call before it runs; null = pricing missing. */
  estimateCost?: (route: AntigravityRelayRoute, bodyBytes: number) => bigint | null
  /** Cost of the summed in-process usage, rounded once like settlement (not per call). */
  totalsCost?: (route: AntigravityRelayRoute, totals: AntigravityUsageTotals) => bigint
  now?: () => number
}

function error(res: ServerResponse, status: number, code: string, requestId: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code, message: `antigravity relay: ${code}` }, requestId }))
}

function readLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Incremental SSE scanner: keeps the last `usageMetadata` seen. Cloud Code
 * wraps each event as `{"response": {..., "usageMetadata": {...}}}`; the last
 * one of a stream carries the call's final counts.
 */
export class AntigravityUsageTap {
  private pending = ''
  usage: { prompt: number; candidates: number; thoughts: number; cached: number } | null = null

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl).trim()
      this.pending = this.pending.slice(nl + 1)
      this.scanLine(line)
    }
    if (this.pending.length > 4 * 1024 * 1024) this.pending = ''
  }

  end(): void {
    this.scanLine(this.pending.trim())
    this.pending = ''
  }

  private scanLine(line: string): void {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload.includes('usageMetadata')) return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    const outer = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    const inner =
      outer?.response && typeof outer.response === 'object'
        ? (outer.response as Record<string, unknown>)
        : outer
    const meta = inner?.usageMetadata
    if (!meta || typeof meta !== 'object') return
    const m = meta as Record<string, unknown>
    this.usage = {
      prompt: count(m.promptTokenCount),
      candidates: count(m.candidatesTokenCount),
      thoughts: count(m.thoughtsTokenCount),
      cached: count(m.cachedContentTokenCount),
    }
  }
}

/**
 * Idempotent on call_id: a retry after a commit whose acknowledgement was lost
 * inserts nothing, so one upstream call is never billed twice (Codex r3 P1).
 */
export async function recordAntigravityRelayUsage(row: AntigravityUsageRow): Promise<void> {
  await query(
    `INSERT INTO antigravity_relay_usage
       (call_id, request_id, user_id, account_id, route_model_id, upstream_model, request_type, status_code,
        prompt_tokens, candidates_tokens, thoughts_tokens, cached_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (call_id) DO NOTHING`,
    [
      row.callId,
      row.requestId,
      row.userId.toString(),
      row.accountId.toString(),
      row.routeModelId,
      row.upstreamModel.slice(0, 128),
      row.requestType?.slice(0, 32) ?? null,
      row.statusCode,
      row.promptTokens,
      row.candidatesTokens,
      row.thoughtsTokens,
      row.cachedTokens,
    ],
  )
}

/**
 * Per route token, this process only (a container's route always resolves to
 * one relay target). `recorded` sums the tokens this process already metered
 * for the route, so a call whose DB read raced another call's insert still
 * counts them (committed = max(db, cost(recorded)) + reserved). Tokens, not
 * per-call costs: settlement rounds once on the turn total (Codex r2 P1).
 */
interface InflightSlot {
  count: number
  reserved: bigint
  recorded: AntigravityUsageTotals
  touchedAt: number
}
const inflight = new Map<string, InflightSlot>()
/** Longer than the route TTL; idle slots past it are dropped. */
const SLOT_IDLE_MS = 2 * 60 * 60 * 1000

function pruneSlots(now: number): void {
  for (const [key, slot] of inflight) {
    if (slot.count <= 0 && now - slot.touchedAt > SLOT_IDLE_MS) inflight.delete(key)
  }
}

export function _antigravityInflightForTests(): ReadonlyMap<string, InflightSlot> {
  return inflight
}

export function makeAntigravityRelayHandler(deps: AntigravityRelayDeps): AntigravityRelayHandler {
  const now = deps.now ?? Date.now
  const freshToken =
    deps.freshToken ??
    ((accountId: bigint) =>
      getFreshAntigravityAccessToken(accountId, {
        clientSecret: deps.clientSecret,
        onAuthFailure: async (id, err) => {
          await (deps.reportOutcome ?? reportAntigravityOutcome)(
            id,
            { kind: 'auth_invalid' },
            err.message,
          )
        },
      }))
  const reportOutcome = deps.reportOutcome ?? reportAntigravityOutcome
  const reportModelOutcome = deps.reportModelOutcome ?? reportAntigravityModelOutcome
  const recordUsage = deps.recordUsage ?? recordAntigravityRelayUsage
  const meteredCost =
    deps.meteredCost ??
    (async (route: AntigravityRelayRoute) => {
      const pricing = deps.pricing?.get(route.modelId) ?? null
      if (pricing === null) return null
      const totals = await sumAntigravityRelayUsage(getPool(), route.requestId, route.userId)
      return antigravityUsageCost(totals, pricing)
    })
  const estimateCost =
    deps.estimateCost ??
    ((route: AntigravityRelayRoute, bodyBytes: number) => {
      const pricing = deps.pricing?.get(route.modelId) ?? null
      if (pricing === null) return null
      // ~4 bytes per token of JSON body is generous for prompts (cached parts
      // are billed lower, so this over-reserves).
      return antigravityUsageCost(
        {
          promptTokens: BigInt(Math.ceil(bodyBytes / 4)),
          candidatesTokens: BigInt(RESERVED_OUTPUT_TOKENS),
          thoughtsTokens: 0n,
          cachedTokens: 0n,
          calls: 1,
        },
        pricing,
      )
    })
  const totalsCost =
    deps.totalsCost ??
    ((route: AntigravityRelayRoute, totals: AntigravityUsageTotals) => {
      const pricing = deps.pricing?.get(route.modelId) ?? null
      return pricing === null ? 0n : antigravityUsageCost(totals, pricing)
    })

  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const parsed = new URL(req.url ?? '/', 'http://local')
    const match = PATH_RE.exec(parsed.pathname)
    if (!match) {
      error(res, 404, 'NOT_FOUND', requestId)
      return
    }
    const token = match[1]!
    const rpc = match[2]!
    const method = (req.method ?? 'GET').toUpperCase()
    const generate = GENERATE_METHODS.has(rpc)
    if (
      (!generate && !METADATA_METHODS.has(rpc)) ||
      (method !== 'POST' && !(method === 'GET' && !generate))
    ) {
      error(res, 405, 'METHOD_NOT_ALLOWED', requestId)
      return
    }
    if (generate ? parsed.search !== '?alt=sse' : parsed.search !== '') {
      error(res, 400, 'QUERY_NOT_ALLOWED', requestId)
      return
    }
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        error(res, 401, 'UNAUTHORIZED', requestId)
        return
      }
      throw err
    }
    const route = await (deps.resolveRoute ?? resolveAntigravityRelayRoute)({
      token,
      containerId: identity.containerId,
      userId: BigInt(identity.userId),
    })
    if (!route) {
      error(res, 404, 'ANTIGRAVITY_ROUTE_EXPIRED', requestId)
      return
    }
    if (!deps.clientSecret) {
      error(res, 503, 'ANTIGRAVITY_NOT_CONFIGURED', requestId)
      return
    }
    let body: Buffer | undefined
    if (method === 'POST') {
      try {
        body = await readLimited(req, generate ? MAX_GENERATE_BODY : MAX_METADATA_BODY)
      } catch {
        error(res, 413, 'BODY_TOO_LARGE', requestId)
        return
      }
    }
    let upstreamModel = ''
    let requestType: string | null = null
    let reservation: { slot: InflightSlot; estimate: bigint } | null = null
    // Kept (not deleted) at count 0 so `recorded` survives between calls; pruned when idle.
    const release = (): void => {
      if (!reservation) return
      reservation.slot.count -= 1
      reservation.slot.reserved -= reservation.estimate
      reservation.slot.touchedAt = now()
      reservation = null
    }
    if (generate) {
      let payload: Record<string, unknown>
      try {
        const value = JSON.parse(body!.toString('utf8')) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('not an object')
        payload = value as Record<string, unknown>
      } catch {
        error(res, 400, 'INVALID_JSON', requestId)
        return
      }
      upstreamModel = typeof payload.model === 'string' ? payload.model : ''
      requestType = typeof payload.requestType === 'string' ? payload.requestType : null
      if (!antigravityAllowedUpstreamModels(route.modelId).includes(upstreamModel)) {
        error(res, 403, 'ANTIGRAVITY_MODEL_NOT_ALLOWED', requestId)
        return
      }
      let spent: bigint | null
      try {
        spent = await meteredCost(route)
      } catch {
        error(res, 503, 'ANTIGRAVITY_METERING_UNAVAILABLE', requestId)
        return
      }
      const estimate = estimateCost(route, body!.length)
      if (spent === null || estimate === null) {
        error(res, 503, 'ANTIGRAVITY_PRICING_UNAVAILABLE', requestId)
        return
      }
      // Synchronous from here to the reservation: no await between the check
      // and the increment, so concurrent calls see each other's reservations.
      pruneSlots(now())
      const slot = inflight.get(token) ?? {
        count: 0,
        reserved: 0n,
        recorded: {
          promptTokens: 0n,
          candidatesTokens: 0n,
          thoughtsTokens: 0n,
          cachedTokens: 0n,
          calls: 0,
        },
        touchedAt: now(),
      }
      if (slot.count >= ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE) {
        error(res, 429, 'ANTIGRAVITY_ROUTE_BUSY', requestId)
        return
      }
      // The first call only needs budget left (serial behaviour, overspend is
      // clamped at settlement); every concurrent call must fit with the others.
      const local = slot.recorded.calls > 0 ? totalsCost(route, slot.recorded) : 0n
      const committed = (spent > local ? spent : local) + slot.reserved
      if (
        committed >= route.budgetCredits ||
        (slot.count > 0 && committed + estimate > route.budgetCredits)
      ) {
        error(res, 402, 'ANTIGRAVITY_BUDGET_EXHAUSTED', requestId)
        return
      }
      slot.count += 1
      slot.reserved += estimate
      slot.touchedAt = now()
      inflight.set(token, slot)
      reservation = { slot, estimate }
    }

    let accessToken: Buffer | null = null
    try {
      try {
        accessToken = await freshToken(route.accountId)
      } catch (err) {
        error(
          res,
          503,
          err instanceof AntigravityOAuthError && err.authInvalid
            ? 'ANTIGRAVITY_AUTH_UNAVAILABLE'
            : 'ANTIGRAVITY_UPSTREAM_UNAVAILABLE',
          requestId,
        )
        return
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken.toString('utf8')}`,
      }
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = req.headers[name]
        if (typeof value === 'string' && value.length <= 512) headers[name] = value
      }
      const upstream = await (deps.requestFn ?? request)(
        `${ANTIGRAVITY_UPSTREAM_BASE_URL}/v1internal:${rpc}${parsed.search}`,
        {
          method: method as 'GET' | 'POST',
          dispatcher: deps.dispatcher ?? directEgressDispatcher(),
          headers,
          body,
        },
      )
      const classified = classifyAntigravityUpstream(upstream.statusCode, upstream.headers, now())
      // A 5xx on a generate call is the model's capacity (other models on the
      // account keep working): cool that model, not the whole account.
      const outcome: AntigravityPoolOutcome =
        generate && classified.kind === 'upstream_error'
          ? { kind: 'model_unavailable' }
          : classified
      void reportOutcome(
        route.accountId,
        outcome,
        outcome.kind === 'success' ? null : `antigravity_http_${upstream.statusCode}`,
      ).catch(() => {})
      if (
        generate &&
        !(ANTIGRAVITY_AUX_UPSTREAM_MODELS as readonly string[]).includes(upstreamModel)
      ) {
        const modelOk = classified.kind === 'success'
        if (modelOk || classified.kind === 'upstream_error') {
          void reportModelOutcome(route.accountId, route.modelId, modelOk).catch(() => {})
        }
      }
      res.statusCode = upstream.statusCode
      for (const [rawKey, rawValue] of Object.entries(upstream.headers)) {
        if (!HOP.has(rawKey.toLowerCase()) && rawValue !== undefined) {
          res.setHeader(rawKey, Array.isArray(rawValue) ? rawValue : String(rawValue))
        }
      }
      const tap = generate ? new AntigravityUsageTap() : null
      for await (const chunk of upstream.body) {
        tap?.push(chunk as Buffer)
        if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve))
      }
      if (tap) {
        tap.end()
        const usage = tap.usage
        // Record before ending the response: the CLI only finishes the turn
        // after this stream ends, so settlement always sees the row.
        const row: AntigravityUsageRow = {
          callId: randomUUID(),
          requestId: route.requestId,
          userId: route.userId,
          accountId: route.accountId,
          routeModelId: route.modelId,
          upstreamModel,
          requestType,
          statusCode: upstream.statusCode,
          promptTokens: usage?.prompt ?? 0,
          candidatesTokens: usage?.candidates ?? 0,
          thoughtsTokens: usage?.thoughts ?? 0,
          cachedTokens: usage?.cached ?? 0,
        }
        // A lost row is an unbilled call: retry briefly before failing the stream.
        for (let attempt = 1; ; attempt++) {
          try {
            await recordUsage(row)
            break
          } catch (err) {
            if (attempt >= 3) throw err
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
          }
        }
        if (reservation) {
          const r = reservation.slot.recorded
          reservation.slot.recorded = {
            promptTokens: r.promptTokens + BigInt(row.promptTokens),
            candidatesTokens: r.candidatesTokens + BigInt(row.candidatesTokens),
            thoughtsTokens: r.thoughtsTokens + BigInt(row.thoughtsTokens),
            cachedTokens: r.cachedTokens + BigInt(row.cachedTokens),
            calls: r.calls + 1,
          }
        }
      }
      res.end()
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined)
      } else {
        error(res, 503, 'ANTIGRAVITY_UPSTREAM_UNAVAILABLE', requestId)
      }
    } finally {
      // After recordUsage: the call's real cost is metered before its reservation goes.
      release()
      accessToken?.fill(0)
    }
  }
}
