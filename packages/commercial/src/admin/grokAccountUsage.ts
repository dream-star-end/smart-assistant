/**
 * Grok Build (xAI official subscription) account usage / remaining quota.
 *
 * A `provider='grok'` row holds an xAI OAuth token for the official Grok CLI
 * proxy. The same proxy answers the billing questions the CLI's `/usage`
 * command does. Verified against two live SuperGrokPro accounts (2026-09-06):
 *
 *   Bearer <accessToken> + x-xai-token-auth: xai-grok-cli on cli-chat-proxy.grok.com:
 *     GET /v1/billing?format=credits  → weekly credit period, % used, per-product
 *                                        usage (GrokBuild), on-demand cap/used,
 *                                        prepaid balance
 *     GET /v1/billing                 → legacy monthly view (monthlyLimit/used, history)
 *     GET /v1/user?include=subscription → subscriptionTier (SuperGrokPro …),
 *                                        hasGrokCodeAccess, userBlockedReason, team/org
 *
 * Redacted live `/billing?format=credits`:
 *   { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start, end },
 *               creditUsagePercent: 8, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 },
 *               productUsage: [{ product: 'GrokBuild', usagePercent: 8 }],
 *               isUnifiedBillingUser: true, prepaidBalance: { val: 0 },
 *               topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
 *               billingPeriodStart, billingPeriodEnd } }
 *
 * These are xAI-internal endpoints and may change without notice, so every
 * field is optional and parsing is lenient: unknown shape → null, never throw
 * at the caller. Display only — not a billing source of truth.
 *
 * Secrets: the access token is a header value only; it never appears in logs,
 * errors or the snapshot. `/user` also returns the account e-mail and name;
 * we keep only the subscription facts and a masked e-mail so the snapshot is
 * safe to serialise to the admin UI as-is.
 */
import type { Dispatcher } from 'undici'
import { request } from 'undici'

export const GROK_USAGE_UPSTREAM_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const REQUEST_TIMEOUT_MS = 15_000
/** xAI billing is not a hot path; short cache so list refreshes don't hammer it. */
export const GROK_USAGE_CACHE_TTL_MS = 60_000

export interface GrokUsageSnapshot {
  fetched_at: string
  /** Every source that failed (name → short reason, never a token or body dump). */
  errors: Record<string, string>
  /** `/billing?format=credits` — the pool Grok Build draws from (weekly). */
  credits: {
    /** USAGE_PERIOD_TYPE_WEEKLY / … */
    period_type: string | null
    period_start: string | null
    /** When the credit pool resets. */
    period_end: string | null
    /** 0..100, whole pool. */
    usage_percent: number | null
    /** Per product; `GrokBuild` is the one we route. */
    products: Array<{ product: string; usage_percent: number | null }>
    grok_build_percent: number | null
    on_demand_cap: number | null
    on_demand_used: number | null
    prepaid_balance: number | null
    top_up_method: string | null
    is_unified_billing_user: boolean | null
  }
  /** `/billing` — legacy monthly window; mostly zero for subscription users. */
  monthly: {
    limit: number | null
    used: number | null
    on_demand_cap: number | null
    period_start: string | null
    period_end: string | null
  }
  /** `/user?include=subscription` — who / what plan. */
  account: {
    /** SuperGrokPro / SuperGrok / … */
    subscription_tier: string | null
    has_grok_code_access: boolean | null
    user_blocked_reason: string | null
    principal_type: string | null
    team_name: string | null
    organization_name: string | null
    /** Masked (`ab***@hotmail.com`); never the full address. */
    email_masked: string | null
  }
}

export class GrokUsageUnavailableError extends Error {
  readonly code: string
  readonly details: Record<string, string>
  constructor(code: string, details: Record<string, string>) {
    super(`GROK_USAGE_UNAVAILABLE:${code}`)
    this.name = 'GrokUsageUnavailableError'
    this.code = code
    this.details = details
  }
}

export function emptyGrokUsageSnapshot(now: number): GrokUsageSnapshot {
  return {
    fetched_at: new Date(now).toISOString(),
    errors: {},
    credits: {
      period_type: null,
      period_start: null,
      period_end: null,
      usage_percent: null,
      products: [],
      grok_build_percent: null,
      on_demand_cap: null,
      on_demand_used: null,
      prepaid_balance: null,
      top_up_method: null,
      is_unified_billing_user: null,
    },
    monthly: { limit: null, used: null, on_demand_cap: null, period_start: null, period_end: null },
    account: {
      subscription_tier: null,
      has_grok_code_access: null,
      user_blocked_reason: null,
      principal_type: null,
      team_name: null,
      organization_name: null,
      email_masked: null,
    },
  }
}

// ---------- lenient field readers ----------

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}
/** xAI wraps money/credit scalars as `{ val: number }`; accept bare numbers too. */
function wrappedNum(v: unknown): number | null {
  const o = obj(v)
  if (o) return num(o.val)
  return num(v)
}
function iso(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  const keep = local.length >= 2 ? local.slice(0, 2) : local.slice(0, 1)
  return `${keep}***${domain}`
}

// ---------- appliers (pure; exported for tests) ----------

export function applyCreditsBilling(snap: GrokUsageSnapshot, body: unknown): void {
  const root = obj(body)
  const cfg = obj(root?.config) ?? root
  if (!cfg) return
  const period = obj(cfg.currentPeriod)
  snap.credits.period_type = str(period?.type)
  snap.credits.period_start = iso(period?.start) ?? iso(cfg.billingPeriodStart)
  snap.credits.period_end = iso(period?.end) ?? iso(cfg.billingPeriodEnd)
  snap.credits.usage_percent = num(cfg.creditUsagePercent)
  const products: GrokUsageSnapshot['credits']['products'] = []
  if (Array.isArray(cfg.productUsage)) {
    for (const item of cfg.productUsage) {
      const o = obj(item)
      const product = str(o?.product)
      if (!product) continue
      products.push({ product, usage_percent: num(o?.usagePercent) })
    }
  }
  snap.credits.products = products
  snap.credits.grok_build_percent =
    products.find((p) => p.product.toLowerCase() === 'grokbuild')?.usage_percent ?? null
  snap.credits.on_demand_cap = wrappedNum(cfg.onDemandCap)
  snap.credits.on_demand_used = wrappedNum(cfg.onDemandUsed)
  snap.credits.prepaid_balance = wrappedNum(cfg.prepaidBalance)
  snap.credits.top_up_method = str(cfg.topUpMethod)
  snap.credits.is_unified_billing_user = bool(cfg.isUnifiedBillingUser)
}

export function applyMonthlyBilling(snap: GrokUsageSnapshot, body: unknown): void {
  const root = obj(body)
  const cfg = obj(root?.config) ?? root
  if (!cfg) return
  snap.monthly.limit = wrappedNum(cfg.monthlyLimit)
  snap.monthly.used = wrappedNum(cfg.used)
  snap.monthly.on_demand_cap = wrappedNum(cfg.onDemandCap)
  snap.monthly.period_start = iso(cfg.billingPeriodStart)
  snap.monthly.period_end = iso(cfg.billingPeriodEnd)
}

export function applyUserSubscription(snap: GrokUsageSnapshot, body: unknown): void {
  const u = obj(body)
  if (!u) return
  snap.account.subscription_tier = str(u.subscriptionTier)
  snap.account.has_grok_code_access = bool(u.hasGrokCodeAccess)
  snap.account.user_blocked_reason = str(u.userBlockedReason)
  snap.account.principal_type = str(u.principalType)
  snap.account.team_name = str(u.teamName)
  snap.account.organization_name = str(u.organizationName)
  snap.account.email_masked = maskEmail(str(u.email))
}

// ---------- fetch ----------

export function buildGrokUsageHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    // Official CLI proxy contract (same as internalGrokRelay.upstreamHeaders).
    'x-xai-token-auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    accept: 'application/json',
    'user-agent': 'openclaude-admin-usage/1.0',
  }
}

export type GrokUsageRequestFn = typeof request

export interface FetchGrokAccountUsageArgs {
  accessToken: string
  /** Undici dispatcher for the account's egress; default direct (see relay). */
  dispatcher?: Dispatcher
  requestFn?: GrokUsageRequestFn
  now?: () => number
  timeoutMs?: number
}

async function getJson(
  path: string,
  args: FetchGrokAccountUsageArgs,
): Promise<{ status: number; body: unknown }> {
  const requestFn = args.requestFn ?? request
  const res = await requestFn(`${GROK_USAGE_UPSTREAM_BASE_URL}${path}`, {
    method: 'GET',
    headers: buildGrokUsageHeaders(args.accessToken),
    ...(args.dispatcher ? { dispatcher: args.dispatcher } : {}),
    headersTimeout: args.timeoutMs ?? REQUEST_TIMEOUT_MS,
    bodyTimeout: args.timeoutMs ?? REQUEST_TIMEOUT_MS,
  })
  const text = await res.body.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.statusCode, body }
}

function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * Fetch the three sources in parallel and fold them into one snapshot.
 * Throws `GrokUsageUnavailableError('token_rejected')` when xAI answers 401/403
 * on every source (token dead — the caller should surface "re-authorize"), and
 * `('all_failed')` when nothing at all came back. Partial success is a
 * success: the missing parts are null with an `errors[...]` entry.
 */
export async function fetchGrokAccountUsage(args: FetchGrokAccountUsageArgs): Promise<GrokUsageSnapshot> {
  const now = args.now ?? Date.now
  const snap = emptyGrokUsageSnapshot(now())
  const sources: Array<{ name: string; path: string; apply: (s: GrokUsageSnapshot, b: unknown) => void }> = [
    { name: 'credits', path: '/billing?format=credits', apply: applyCreditsBilling },
    { name: 'monthly', path: '/billing', apply: applyMonthlyBilling },
    { name: 'user', path: '/user?include=subscription', apply: applyUserSubscription },
  ]
  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        const r = await getJson(src.path, args)
        if (r.status === 401 || r.status === 403) return { src, auth: true as const, status: r.status }
        if (r.status < 200 || r.status >= 300) return { src, fail: `http_${r.status}` }
        if (r.body === null) return { src, fail: 'non_json' }
        src.apply(snap, r.body)
        return { src, ok: true as const }
      } catch (err) {
        return { src, fail: shortReason(err) }
      }
    }),
  )
  let okCount = 0
  let authCount = 0
  for (const r of results) {
    if ('ok' in r && r.ok) {
      okCount += 1
    } else if ('auth' in r && r.auth) {
      authCount += 1
      snap.errors[r.src.name] = `http_${r.status}`
    } else if ('fail' in r) {
      snap.errors[r.src.name] = r.fail
    }
  }
  if (okCount === 0) {
    if (authCount === results.length) throw new GrokUsageUnavailableError('token_rejected', snap.errors)
    throw new GrokUsageUnavailableError('all_failed', snap.errors)
  }
  return snap
}

// ---------- cache (per account id; process-local) ----------

const cache = new Map<string, { at: number; snap: GrokUsageSnapshot }>()

export function getCachedGrokUsage(accountId: string, now: number = Date.now()): GrokUsageSnapshot | null {
  const hit = cache.get(accountId)
  if (!hit) return null
  if (now - hit.at > GROK_USAGE_CACHE_TTL_MS) {
    cache.delete(accountId)
    return null
  }
  return hit.snap
}

export function setCachedGrokUsage(accountId: string, snap: GrokUsageSnapshot, now: number = Date.now()): void {
  cache.set(accountId, { at: now, snap })
}

export function clearGrokUsageCache(): void {
  cache.clear()
}
