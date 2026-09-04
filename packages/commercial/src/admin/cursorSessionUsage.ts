/**
 * Cursor account usage / remaining quota for Sand session credentials.
 *
 * A `cursor_credential_kind = 'session'` row holds a Cursor account session, so
 * we can ask Cursor the same questions the dashboard does. Verified against a
 * live Sand session (2026-09-03):
 *
 *   Bearer <accessToken> on api2.cursor.sh (ConnectRPC JSON):
 *     DashboardService/GetCurrentPeriodUsage   → billing cycle, % used, spend limits
 *     DashboardService/GetPlanInfo             → plan name / price / cycle end
 *     DashboardService/GetAggregatedUsageEvents→ per-model tokens + cents in a range
 *     DashboardService/GetHardLimit            → { noUsageBasedAllowed } (free) / limits
 *   Cookie WorkosCursorSessionToken=<authId>::<accessToken> on cursor.com:
 *     GET /api/usage-summary                   → plan used/limit/remaining (cents), onDemand
 *     GET /api/auth/stripe                     → membershipType, subscriptionStatus
 *     POST /api/dashboard/get-sand-usage-status  → Grok Bot / Sand pool: % used, weekly reset, SuperGrok plan
 *     POST /api/dashboard/get-sand-access-status → SAND_ACCESS_STATE_* / block reason
 *     GET  /api/auth/super-grok/status           → SuperGrok link state (linked / granted / plan)
 *   (cursor.com/api/dashboard/* POSTs require `origin: https://cursor.com`, otherwise
 *    403 "Invalid origin for state-changing request"; api2 is the reliable surface
 *    for included usage, cursor.com adds the cents breakdown and the Sand pool.)
 *
 * The Sand / Grok Bot pool (verified 2026-09-04) is a *separate* quota from the
 * plan's included usage: the same account showed 0% included and 66.8% Sand.
 * Sand (Opus / Fable via InferenceService) draws from that pool, not from
 * `planUsage`.
 *
 * These are Cursor-internal endpoints and may change without notice, so every
 * field is optional and parsing is lenient: unknown shape → null, never throw
 * at the caller. Nothing here is a billing source of truth — it is display only.
 *
 * Secrets: the access token is used as a header value only; it never appears in
 * logs, errors or the returned snapshot. The returned object is safe to serialise
 * to the admin UI as-is.
 */
import { CURSOR_SESSION_CLIENT_VERSION, cursorSessionChecksum } from '@openclaude/protocol'

export const CURSOR_API2_ORIGIN = 'https://api2.cursor.sh'
export const CURSOR_WEB_ORIGIN = 'https://cursor.com'
const DASHBOARD = `${CURSOR_API2_ORIGIN}/aiserver.v1.DashboardService`
const REQUEST_TIMEOUT_MS = 15_000
/** Cursor's dashboard is not a hot path; keep a short cache so list refreshes don't hammer it. */
export const CURSOR_USAGE_CACHE_TTL_MS = 60_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface CursorUsageSnapshot {
  fetched_at: string
  /** Every source that failed (name → short reason, never a token or body dump). */
  errors: Record<string, string>
  plan: {
    name: string | null
    price: string | null
    membership_type: string | null
    subscription_status: string | null
    billing_cycle_start: string | null
    billing_cycle_end: string | null
  }
  included: {
    /** Cents; null when Cursor did not expose a numeric breakdown. */
    used_cents: number | null
    limit_cents: number | null
    remaining_cents: number | null
    total_percent_used: number | null
    auto_percent_used: number | null
    api_percent_used: number | null
    is_unlimited: boolean | null
    display_message: string | null
  }
  on_demand: {
    enabled: boolean | null
    used_cents: number | null
    limit_cents: number | null
    remaining_cents: number | null
    usage_based_allowed: boolean | null
  }
  /** Aggregated over the current billing cycle (falls back to last 30 days). */
  cycle_usage: {
    range_start: string | null
    range_end: string | null
    total_cost_cents: number | null
    total_input_tokens: number | null
    total_output_tokens: number | null
    total_cache_write_tokens: number | null
    total_cache_read_tokens: number | null
    models: Array<{
      model: string
      cost_cents: number | null
      input_tokens: number | null
      output_tokens: number | null
      cache_write_tokens: number | null
      cache_read_tokens: number | null
    }>
  }
  /**
   * Grok Bot / Sand pool — independent of `included`. Weekly reset. All null when
   * the account has no auth id or every cursor.com Sand endpoint failed.
   */
  sand: {
    /** SAND_ACCESS_STATE_GRANTED / _BLOCKED / … */
    access_state: string | null
    /** SAND_ACCESS_BLOCK_REASON_NONE / … */
    block_reason: string | null
    usage_percent: number | null
    has_available_usage: boolean | null
    has_included_limit: boolean | null
    period_start: string | null
    next_reset_at: string | null
    on_demand_visible: boolean | null
    on_demand_eligible: boolean | null
    /** e.g. supergrok-heavy */
    grok_plan: string | null
    /** e.g. "SuperGrok Heavy" */
    grok_plan_label: string | null
    super_grok_linked: boolean | null
    super_grok_granted: boolean | null
    super_grok_linked_at: string | null
    link_blocked_reason: string | null
  }
}

export interface CursorSessionUsageInput {
  accessToken: string
  /** `auth0|user_…` — required for the cursor.com cookie surface; api2 works without it. */
  authId: string | null
  /** Persisted machine id from login; only used for the checksum header on api2. */
  machineId: string | null
}

export interface CursorSessionUsageOptions {
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
}

// ─── lenient parsing helpers ────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && v !== '-') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** Cursor returns cycle bounds either as ISO strings or ms-epoch strings/numbers. */
function isoDate(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString()
  if (typeof v === 'string' && v.length > 0) {
    if (/^\d{10,16}$/.test(v)) return new Date(Number(v)).toISOString()
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  return null
}

function emptySnapshot(nowMs: number): CursorUsageSnapshot {
  return {
    fetched_at: new Date(nowMs).toISOString(),
    errors: {},
    plan: {
      name: null,
      price: null,
      membership_type: null,
      subscription_status: null,
      billing_cycle_start: null,
      billing_cycle_end: null,
    },
    included: {
      used_cents: null,
      limit_cents: null,
      remaining_cents: null,
      total_percent_used: null,
      auto_percent_used: null,
      api_percent_used: null,
      is_unlimited: null,
      display_message: null,
    },
    on_demand: { enabled: null, used_cents: null, limit_cents: null, remaining_cents: null, usage_based_allowed: null },
    cycle_usage: {
      range_start: null,
      range_end: null,
      total_cost_cents: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cache_write_tokens: null,
      total_cache_read_tokens: null,
      models: [],
    },
    sand: {
      access_state: null,
      block_reason: null,
      usage_percent: null,
      has_available_usage: null,
      has_included_limit: null,
      period_start: null,
      next_reset_at: null,
      on_demand_visible: null,
      on_demand_eligible: null,
      grok_plan: null,
      grok_plan_label: null,
      super_grok_linked: null,
      super_grok_granted: null,
      super_grok_linked_at: null,
      link_blocked_reason: null,
    },
  }
}

// Each apply* mutates the snapshot from one endpoint's JSON. Exported for tests.

export function applyCurrentPeriodUsage(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  snap.plan.billing_cycle_start = isoDate(body.billingCycleStart) ?? snap.plan.billing_cycle_start
  snap.plan.billing_cycle_end = isoDate(body.billingCycleEnd) ?? snap.plan.billing_cycle_end
  snap.included.display_message = str(body.displayMessage) ?? snap.included.display_message
  const plan = body.planUsage
  if (isRecord(plan)) {
    snap.included.total_percent_used = num(plan.totalPercentUsed) ?? snap.included.total_percent_used
    snap.included.auto_percent_used = num(plan.autoPercentUsed) ?? snap.included.auto_percent_used
    snap.included.api_percent_used = num(plan.apiPercentUsed) ?? snap.included.api_percent_used
  }
  const spend = body.spendLimitUsage
  if (isRecord(spend)) {
    snap.on_demand.limit_cents = num(spend.overallLimit) ?? snap.on_demand.limit_cents
    snap.on_demand.remaining_cents = num(spend.overallRemaining) ?? snap.on_demand.remaining_cents
  }
}

export function applyPlanInfo(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body) || !isRecord(body.planInfo)) return
  snap.plan.name = str(body.planInfo.planName) ?? snap.plan.name
  snap.plan.price = str(body.planInfo.price) ?? snap.plan.price
  snap.plan.billing_cycle_end = isoDate(body.planInfo.billingCycleEnd) ?? snap.plan.billing_cycle_end
}

export function applyHardLimit(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  const denied = bool(body.noUsageBasedAllowed)
  if (denied !== null) snap.on_demand.usage_based_allowed = !denied
  const hard = num(body.hardLimit)
  if (hard !== null) snap.on_demand.limit_cents = hard * 100
}

export function applyAggregatedUsageEvents(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  snap.cycle_usage.total_cost_cents = num(body.totalCostCents) ?? snap.cycle_usage.total_cost_cents
  snap.cycle_usage.total_input_tokens = num(body.totalInputTokens) ?? snap.cycle_usage.total_input_tokens
  snap.cycle_usage.total_output_tokens = num(body.totalOutputTokens) ?? snap.cycle_usage.total_output_tokens
  snap.cycle_usage.total_cache_write_tokens = num(body.totalCacheWriteTokens) ?? snap.cycle_usage.total_cache_write_tokens
  snap.cycle_usage.total_cache_read_tokens = num(body.totalCacheReadTokens) ?? snap.cycle_usage.total_cache_read_tokens
  if (Array.isArray(body.aggregations)) {
    const models: CursorUsageSnapshot['cycle_usage']['models'] = []
    for (const row of body.aggregations) {
      if (!isRecord(row)) continue
      const model = str(row.modelIntent) ?? str(row.model)
      if (!model) continue
      models.push({
        model,
        cost_cents: num(row.totalCents),
        input_tokens: num(row.inputTokens),
        output_tokens: num(row.outputTokens),
        cache_write_tokens: num(row.cacheWriteTokens),
        cache_read_tokens: num(row.cacheReadTokens),
      })
    }
    models.sort((a, b) => (b.cost_cents ?? 0) - (a.cost_cents ?? 0))
    snap.cycle_usage.models = models
  }
}

export function applyUsageSummary(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  snap.plan.membership_type = str(body.membershipType) ?? snap.plan.membership_type
  snap.plan.billing_cycle_start = isoDate(body.billingCycleStart) ?? snap.plan.billing_cycle_start
  snap.plan.billing_cycle_end = isoDate(body.billingCycleEnd) ?? snap.plan.billing_cycle_end
  snap.included.is_unlimited = bool(body.isUnlimited) ?? snap.included.is_unlimited
  const individual = body.individualUsage
  if (!isRecord(individual)) return
  const plan = individual.plan
  if (isRecord(plan)) {
    snap.included.used_cents = num(plan.used) ?? snap.included.used_cents
    snap.included.limit_cents = num(plan.limit) ?? snap.included.limit_cents
    snap.included.remaining_cents = num(plan.remaining) ?? snap.included.remaining_cents
    snap.included.total_percent_used = num(plan.totalPercentUsed) ?? snap.included.total_percent_used
    snap.included.auto_percent_used = num(plan.autoPercentUsed) ?? snap.included.auto_percent_used
    snap.included.api_percent_used = num(plan.apiPercentUsed) ?? snap.included.api_percent_used
  }
  const onDemand = individual.onDemand
  if (isRecord(onDemand)) {
    snap.on_demand.enabled = bool(onDemand.enabled) ?? snap.on_demand.enabled
    snap.on_demand.used_cents = num(onDemand.used) ?? snap.on_demand.used_cents
    snap.on_demand.limit_cents = num(onDemand.limit) ?? snap.on_demand.limit_cents
    snap.on_demand.remaining_cents = num(onDemand.remaining) ?? snap.on_demand.remaining_cents
  }
}

export function applyStripeProfile(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  snap.plan.membership_type = str(body.membershipType) ?? snap.plan.membership_type
  snap.plan.subscription_status = str(body.subscriptionStatus) ?? snap.plan.subscription_status
}

/** cursor.com POST /api/dashboard/get-sand-usage-status — the Grok Bot / Sand pool itself. */
export function applySandUsageStatus(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  const s = snap.sand
  s.usage_percent = num(body.usagePercent) ?? s.usage_percent
  s.has_available_usage = bool(body.hasAvailableUsage) ?? s.has_available_usage
  s.has_included_limit = bool(body.hasNonZeroIncludedLimit) ?? s.has_included_limit
  s.period_start = isoDate(body.currentPeriodStart) ?? s.period_start
  s.next_reset_at = isoDate(body.nextResetTimestampUtc) ?? s.next_reset_at
  s.grok_plan = str(body.includedUsageSuperGrokPlan) ?? s.grok_plan
  s.grok_plan_label = str(body.grokPlanLabel) ?? s.grok_plan_label
  const od = body.onDemandSettings
  if (isRecord(od)) {
    s.on_demand_visible = bool(od.visible) ?? s.on_demand_visible
    s.on_demand_eligible = bool(od.eligible) ?? s.on_demand_eligible
  }
}

/** cursor.com POST /api/dashboard/get-sand-access-status. */
export function applySandAccessStatus(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  snap.sand.access_state = str(body.state) ?? snap.sand.access_state
  snap.sand.block_reason = str(body.blockReason) ?? snap.sand.block_reason
}

/** cursor.com GET /api/auth/super-grok/status. */
export function applySuperGrokStatus(snap: CursorUsageSnapshot, body: unknown): void {
  if (!isRecord(body)) return
  const s = snap.sand
  s.super_grok_linked = bool(body.linked) ?? s.super_grok_linked
  s.super_grok_granted = bool(body.granted) ?? s.super_grok_granted
  s.super_grok_linked_at = isoDate(body.linkedAt) ?? s.super_grok_linked_at
  s.link_blocked_reason = str(body.linkBlockedReason) ?? s.link_blocked_reason
  s.grok_plan = s.grok_plan ?? str(body.grokPlan)
  snap.plan.membership_type = snap.plan.membership_type ?? str(body.membershipType)
}

// ─── transport ─────────────────────────────────────────────────────────────

export function buildCursorApi2Headers(accessToken: string, machineId: string | null, nowMs: number): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'connect-protocol-version': '1',
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': CURSOR_SESSION_CLIENT_VERSION,
    'x-ghost-mode': 'true',
  }
  if (machineId) headers['x-cursor-checksum'] = cursorSessionChecksum(machineId, nowMs)
  return headers
}

export function buildCursorWebHeaders(accessToken: string, authId: string): Record<string, string> {
  return {
    accept: 'application/json',
    cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${authId}::${accessToken}`)}`,
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    // cursor.com/api/dashboard/* POSTs enforce a same-origin check
    // ("Invalid origin for state-changing request"); GETs ignore these.
    origin: CURSOR_WEB_ORIGIN,
    referer: `${CURSOR_WEB_ORIGIN}/dashboard`,
  }
}

/** Compact, secret-free reason string for `errors`. */
function describeFailure(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
    return err.message.slice(0, 120)
  }
  return 'unknown'
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, reason: 'non_json' }
    }
  } catch (err) {
    return { ok: false, reason: describeFailure(err) }
  }
}

/**
 * Fetch every usage surface in parallel and fold into one snapshot. Individual
 * failures land in `errors`; the call itself only rejects when *all* api2
 * calls failed (the session is most likely dead → caller maps to 502/401).
 */
export async function fetchCursorSessionUsage(
  input: CursorSessionUsageInput,
  opts: CursorSessionUsageOptions = {},
): Promise<CursorUsageSnapshot> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const now = opts.now ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const nowMs = now()
  const snap = emptySnapshot(nowMs)
  const api2Headers = buildCursorApi2Headers(input.accessToken, input.machineId, nowMs)

  const api2 = (method: string, body: unknown) =>
    fetchJson(fetchImpl, `${DASHBOARD}/${method}`, { method: 'POST', headers: api2Headers, body: JSON.stringify(body) }, timeoutMs)

  // Cycle first: aggregated events want the billing window as the range.
  const period = await api2('GetCurrentPeriodUsage', {})
  if (period.ok) applyCurrentPeriodUsage(snap, period.body)
  else snap.errors.current_period = period.reason

  const rangeEnd = nowMs
  const cycleStart = snap.plan.billing_cycle_start ? Date.parse(snap.plan.billing_cycle_start) : NaN
  const rangeStart = Number.isFinite(cycleStart) && cycleStart < rangeEnd ? cycleStart : rangeEnd - 30 * 86_400_000
  snap.cycle_usage.range_start = new Date(rangeStart).toISOString()
  snap.cycle_usage.range_end = new Date(rangeEnd).toISOString()

  const tasks: Array<Promise<void>> = [
    api2('GetPlanInfo', {}).then((r) => {
      if (r.ok) applyPlanInfo(snap, r.body)
      else snap.errors.plan_info = r.reason
    }),
    api2('GetHardLimit', {}).then((r) => {
      if (r.ok) applyHardLimit(snap, r.body)
      else snap.errors.hard_limit = r.reason
    }),
    api2('GetAggregatedUsageEvents', { startDate: String(rangeStart), endDate: String(rangeEnd) }).then((r) => {
      if (r.ok) applyAggregatedUsageEvents(snap, r.body)
      else snap.errors.aggregated_usage = r.reason
    }),
  ]
  if (input.authId) {
    const webHeaders = buildCursorWebHeaders(input.accessToken, input.authId)
    tasks.push(
      fetchJson(fetchImpl, `${CURSOR_WEB_ORIGIN}/api/usage-summary`, { method: 'GET', headers: webHeaders }, timeoutMs).then((r) => {
        if (r.ok) applyUsageSummary(snap, r.body)
        else snap.errors.usage_summary = r.reason
      }),
      fetchJson(fetchImpl, `${CURSOR_WEB_ORIGIN}/api/auth/stripe`, { method: 'GET', headers: webHeaders }, timeoutMs).then((r) => {
        if (r.ok) applyStripeProfile(snap, r.body)
        else snap.errors.stripe_profile = r.reason
      }),
      // Grok Bot / Sand pool. Dashboard POSTs take an (empty) JSON body.
      fetchJson(
        fetchImpl,
        `${CURSOR_WEB_ORIGIN}/api/dashboard/get-sand-usage-status`,
        { method: 'POST', headers: { ...webHeaders, 'content-type': 'application/json' }, body: '{}' },
        timeoutMs,
      ).then((r) => {
        if (r.ok) applySandUsageStatus(snap, r.body)
        else snap.errors.sand_usage = r.reason
      }),
      fetchJson(
        fetchImpl,
        `${CURSOR_WEB_ORIGIN}/api/dashboard/get-sand-access-status`,
        { method: 'POST', headers: { ...webHeaders, 'content-type': 'application/json' }, body: '{}' },
        timeoutMs,
      ).then((r) => {
        if (r.ok) applySandAccessStatus(snap, r.body)
        else snap.errors.sand_access = r.reason
      }),
      fetchJson(fetchImpl, `${CURSOR_WEB_ORIGIN}/api/auth/super-grok/status`, { method: 'GET', headers: webHeaders }, timeoutMs).then((r) => {
        if (r.ok) applySuperGrokStatus(snap, r.body)
        else snap.errors.super_grok = r.reason
      }),
    )
  } else {
    snap.errors.usage_summary = 'no_auth_id'
    snap.errors.sand_usage = 'no_auth_id'
  }
  await Promise.all(tasks)

  const api2Failed = ['current_period', 'plan_info', 'hard_limit', 'aggregated_usage'].every((k) => k in snap.errors)
  if (api2Failed) {
    const reasons = new Set(Object.values(snap.errors))
    throw new CursorUsageUnavailableError(reasons.has('http_401') || reasons.has('http_403') ? 'session_rejected' : 'upstream_unavailable', snap.errors)
  }
  return snap
}

export class CursorUsageUnavailableError extends Error {
  readonly code: 'session_rejected' | 'upstream_unavailable'
  readonly details: Record<string, string>
  constructor(code: 'session_rejected' | 'upstream_unavailable', details: Record<string, string>) {
    super(code)
    this.name = 'CursorUsageUnavailableError'
    this.code = code
    this.details = details
  }
}

// ─── per-account short cache ────────────────────────────────────────────────

const cache = new Map<string, { at: number; snap: CursorUsageSnapshot }>()

export function getCachedCursorUsage(accountId: string, nowMs = Date.now(), ttlMs = CURSOR_USAGE_CACHE_TTL_MS): CursorUsageSnapshot | null {
  const hit = cache.get(accountId)
  if (!hit) return null
  if (nowMs - hit.at > ttlMs) {
    cache.delete(accountId)
    return null
  }
  return hit.snap
}

export function setCachedCursorUsage(accountId: string, snap: CursorUsageSnapshot, nowMs = Date.now()): void {
  cache.set(accountId, { at: nowMs, snap })
}

export function clearCursorUsageCache(accountId?: string): void {
  if (accountId === undefined) cache.clear()
  else cache.delete(accountId)
}
