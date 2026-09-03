/**
 * Cursor account-session usage snapshot (Sand): lenient parsing + fetch fold.
 * No real network: every Cursor endpoint is a mocked fetch. Shapes below are the
 * redacted live responses captured on 2026-09-03.
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/cursorSessionUsage.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { cursorSessionChecksum } from '@openclaude/protocol'
import {
  CURSOR_USAGE_CACHE_TTL_MS,
  CursorUsageUnavailableError,
  applyAggregatedUsageEvents,
  applyCurrentPeriodUsage,
  applyHardLimit,
  applyPlanInfo,
  applyStripeProfile,
  applyUsageSummary,
  buildCursorApi2Headers,
  buildCursorWebHeaders,
  clearCursorUsageCache,
  fetchCursorSessionUsage,
  getCachedCursorUsage,
  setCachedCursorUsage,
  type CursorUsageSnapshot,
} from '../admin/cursorSessionUsage.js'

const NOW = 1_788_500_000_000
const ACCESS = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXRoMHx1c2VyXzAxIn0.sig-bytes'
const AUTH_ID = 'auth0|user_01'
const MACHINE_ID = 'abcdefghijklmnopqrstuvwxyz'

const CURRENT_PERIOD = {
  billingCycleStart: '1787727633431',
  billingCycleEnd: '1790406033431',
  planUsage: { remainingBonus: false, autoPercentUsed: 12.5, apiPercentUsed: 0, totalPercentUsed: 12.5 },
  spendLimitUsage: { pooledLimit: 0, pooledRemaining: 0, individualLimit: 0, limitType: 'user', overallLimit: 2000, overallRemaining: 1500 },
  displayThreshold: 200,
  displayMessage: "You've used 12% of your included usage",
  autoBucketModels: ['default'],
}
const PLAN_INFO = {
  planInfo: { planName: 'Free', price: 'Free', billingCycleEnd: '1790406033431' },
  nextUpgrade: { tier: 'pro', name: 'Pro', includedAmountCents: 2000, price: '$20/mo' },
}
const AGGREGATED = {
  aggregations: [
    { modelIntent: 'claude-fable-5-1-thinking-high', inputTokens: '6479', outputTokens: '1045460', cacheWriteTokens: '3737007', cacheReadTokens: '83973646', totalCents: 12004.3789, tier: 1 },
    { modelIntent: 'claude-opus-5-thinking-high', inputTokens: '724', outputTokens: '7061', cacheWriteTokens: '145953', cacheReadTokens: '467788', totalCents: 132.62, tier: 1 },
  ],
  totalInputTokens: '7203',
  totalOutputTokens: '1052521',
  totalCacheWriteTokens: '3882960',
  totalCacheReadTokens: '84441434',
  totalCostCents: 12137.003424999999,
}
const USAGE_SUMMARY = {
  billingCycleStart: '2026-08-26T07:00:33.431Z',
  billingCycleEnd: '2026-09-26T07:00:33.431Z',
  membershipType: 'free',
  limitType: 'user',
  isUnlimited: false,
  individualUsage: {
    plan: { enabled: true, used: 250, limit: 2000, remaining: 1750, breakdown: { included: 2000, bonus: 0, total: 2000 }, autoPercentUsed: 12.5, apiPercentUsed: 0, totalPercentUsed: 12.5 },
    onDemand: { enabled: false, used: 0, limit: null, remaining: null },
  },
  teamUsage: {},
}
const STRIPE = { membershipType: 'free', subscriptionStatus: 'unpaid', isTeamMember: false }

type Route = { status: number; body: unknown } | { throws: Error }
type Call = { url: string; init: RequestInit }

function mockFetch(routes: Record<string, Route>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const route = key ? routes[key] : undefined
    if (!route) return new Response('{"error":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    if ('throws' in route) throw route.throws
    return new Response(typeof route.body === 'string' ? route.body : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const ALL_OK: Record<string, Route> = {
  'DashboardService/GetCurrentPeriodUsage': { status: 200, body: CURRENT_PERIOD },
  'DashboardService/GetPlanInfo': { status: 200, body: PLAN_INFO },
  'DashboardService/GetHardLimit': { status: 200, body: { noUsageBasedAllowed: true } },
  'DashboardService/GetAggregatedUsageEvents': { status: 200, body: AGGREGATED },
  'cursor.com/api/usage-summary': { status: 200, body: USAGE_SUMMARY },
  'cursor.com/api/auth/stripe': { status: 200, body: STRIPE },
}

function blank(): CursorUsageSnapshot {
  return {
    fetched_at: new Date(NOW).toISOString(),
    errors: {},
    plan: { name: null, price: null, membership_type: null, subscription_status: null, billing_cycle_start: null, billing_cycle_end: null },
    included: { used_cents: null, limit_cents: null, remaining_cents: null, total_percent_used: null, auto_percent_used: null, api_percent_used: null, is_unlimited: null, display_message: null },
    on_demand: { enabled: null, used_cents: null, limit_cents: null, remaining_cents: null, usage_based_allowed: null },
    cycle_usage: { range_start: null, range_end: null, total_cost_cents: null, total_input_tokens: null, total_output_tokens: null, total_cache_write_tokens: null, total_cache_read_tokens: null, models: [] },
  }
}

describe('cursorSessionUsage parsers', () => {
  test('GetCurrentPeriodUsage: ms-epoch strings → ISO, percentages and spend limit', () => {
    const s = blank()
    applyCurrentPeriodUsage(s, CURRENT_PERIOD)
    assert.equal(s.plan.billing_cycle_start, '2026-08-26T07:00:33.431Z')
    assert.equal(s.plan.billing_cycle_end, '2026-09-26T07:00:33.431Z')
    assert.equal(s.included.total_percent_used, 12.5)
    assert.equal(s.included.auto_percent_used, 12.5)
    assert.equal(s.included.api_percent_used, 0)
    assert.equal(s.included.display_message, "You've used 12% of your included usage")
    assert.equal(s.on_demand.limit_cents, 2000)
    assert.equal(s.on_demand.remaining_cents, 1500)
  })

  test('GetPlanInfo / GetHardLimit / stripe', () => {
    const s = blank()
    applyPlanInfo(s, PLAN_INFO)
    assert.equal(s.plan.name, 'Free')
    assert.equal(s.plan.price, 'Free')
    assert.equal(s.plan.billing_cycle_end, '2026-09-26T07:00:33.431Z')
    applyHardLimit(s, { noUsageBasedAllowed: true })
    assert.equal(s.on_demand.usage_based_allowed, false)
    applyHardLimit(s, { hardLimit: 50, noUsageBasedAllowed: false })
    assert.equal(s.on_demand.usage_based_allowed, true)
    assert.equal(s.on_demand.limit_cents, 5000)
    applyStripeProfile(s, STRIPE)
    assert.equal(s.plan.membership_type, 'free')
    assert.equal(s.plan.subscription_status, 'unpaid')
  })

  test('GetAggregatedUsageEvents: numeric strings coerced, models sorted by cost desc', () => {
    const s = blank()
    applyAggregatedUsageEvents(s, AGGREGATED)
    assert.equal(s.cycle_usage.total_cost_cents, 12137.003424999999)
    assert.equal(s.cycle_usage.total_input_tokens, 7203)
    assert.equal(s.cycle_usage.total_cache_read_tokens, 84441434)
    assert.equal(s.cycle_usage.models.length, 2)
    assert.equal(s.cycle_usage.models[0]!.model, 'claude-fable-5-1-thinking-high')
    assert.equal(s.cycle_usage.models[0]!.output_tokens, 1045460)
    assert.equal(s.cycle_usage.models[1]!.cost_cents, 132.62)
  })

  test('usage-summary: cents used/limit/remaining + onDemand nulls stay null', () => {
    const s = blank()
    applyUsageSummary(s, USAGE_SUMMARY)
    assert.equal(s.plan.membership_type, 'free')
    assert.equal(s.included.used_cents, 250)
    assert.equal(s.included.limit_cents, 2000)
    assert.equal(s.included.remaining_cents, 1750)
    assert.equal(s.included.is_unlimited, false)
    assert.equal(s.on_demand.enabled, false)
    assert.equal(s.on_demand.used_cents, 0)
    assert.equal(s.on_demand.limit_cents, null)
    assert.equal(s.on_demand.remaining_cents, null)
  })

  test('garbage shapes never throw and never overwrite with junk', () => {
    const s = blank()
    applyUsageSummary(s, USAGE_SUMMARY)
    for (const junk of [null, undefined, 'x', 42, [], { individualUsage: 'nope' }, { planUsage: [] }, { aggregations: [null, 'x', { modelIntent: 7 }] }]) {
      applyCurrentPeriodUsage(s, junk)
      applyPlanInfo(s, junk)
      applyHardLimit(s, junk)
      applyAggregatedUsageEvents(s, junk)
      applyUsageSummary(s, junk)
      applyStripeProfile(s, junk)
    }
    assert.equal(s.included.remaining_cents, 1750)
    assert.equal(s.plan.membership_type, 'free')
    assert.deepEqual(s.cycle_usage.models, [])
  })
})

describe('cursorSessionUsage headers', () => {
  test('api2 headers: Bearer + sand client type + checksum from persisted machine id', () => {
    const h = buildCursorApi2Headers(ACCESS, MACHINE_ID, NOW)
    assert.equal(h.authorization, `Bearer ${ACCESS}`)
    assert.equal(h['x-cursor-client-type'], 'sand')
    assert.equal(h['connect-protocol-version'], '1')
    assert.equal(h['x-cursor-checksum'], cursorSessionChecksum(MACHINE_ID, NOW))
    assert.equal('x-cursor-checksum' in buildCursorApi2Headers(ACCESS, null, NOW), false)
  })

  test('web headers: WorkosCursorSessionToken cookie = authId::accessToken', () => {
    const h = buildCursorWebHeaders(ACCESS, AUTH_ID)
    assert.equal(h.cookie, `WorkosCursorSessionToken=${encodeURIComponent(`${AUTH_ID}::${ACCESS}`)}`)
  })
})

describe('fetchCursorSessionUsage', () => {
  test('folds all six sources; aggregated range = billing cycle start → now', async () => {
    const calls: Call[] = []
    const snap = await fetchCursorSessionUsage(
      { accessToken: ACCESS, authId: AUTH_ID, machineId: MACHINE_ID },
      { fetchImpl: mockFetch(ALL_OK, calls), now: () => NOW },
    )
    assert.deepEqual(snap.errors, {})
    assert.equal(snap.fetched_at, new Date(NOW).toISOString())
    assert.equal(snap.plan.name, 'Free')
    assert.equal(snap.plan.membership_type, 'free')
    assert.equal(snap.plan.subscription_status, 'unpaid')
    assert.equal(snap.included.remaining_cents, 1750)
    assert.equal(snap.included.total_percent_used, 12.5)
    assert.equal(snap.on_demand.usage_based_allowed, false)
    assert.equal(snap.cycle_usage.models.length, 2)
    assert.equal(snap.cycle_usage.range_start, '2026-08-26T07:00:33.431Z')
    assert.equal(snap.cycle_usage.range_end, new Date(NOW).toISOString())
    assert.equal(calls.length, 6)
    const agg = calls.find((c) => c.url.includes('GetAggregatedUsageEvents'))!
    assert.deepEqual(JSON.parse(String(agg.init.body)), { startDate: '1787727633431', endDate: String(NOW) })
    // Secrets: token only in headers, never in URL / body.
    for (const c of calls) {
      assert.equal(c.url.includes(ACCESS), false)
      assert.equal(String(c.init.body ?? '').includes(ACCESS), false)
    }
    // Snapshot is safe to serialise to the UI.
    assert.equal(JSON.stringify(snap).includes(ACCESS), false)
  })

  test('without authId: skips cursor.com surface, api2 still gives percentages', async () => {
    const calls: Call[] = []
    const snap = await fetchCursorSessionUsage(
      { accessToken: ACCESS, authId: null, machineId: MACHINE_ID },
      { fetchImpl: mockFetch(ALL_OK, calls), now: () => NOW },
    )
    assert.equal(calls.length, 4)
    assert.equal(calls.some((c) => c.url.includes('cursor.com/api')), false)
    assert.equal(snap.errors.usage_summary, 'no_auth_id')
    assert.equal(snap.included.remaining_cents, null)
    assert.equal(snap.included.total_percent_used, 12.5)
  })

  test('partial failures are reported per source, not thrown; no billing cycle → 30d range', async () => {
    const snap = await fetchCursorSessionUsage(
      { accessToken: ACCESS, authId: AUTH_ID, machineId: MACHINE_ID },
      {
        fetchImpl: mockFetch({
          ...ALL_OK,
          'DashboardService/GetCurrentPeriodUsage': { status: 500, body: { error: 'boom' } },
          'cursor.com/api/usage-summary': { status: 403, body: { error: 'forbidden' } },
          'DashboardService/GetHardLimit': { throws: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) },
        }),
        now: () => NOW,
      },
    )
    assert.deepEqual(snap.errors, { current_period: 'http_500', usage_summary: 'http_403', hard_limit: 'timeout' })
    assert.equal(snap.plan.name, 'Free')
    assert.equal(snap.cycle_usage.range_start, new Date(NOW - 30 * 86_400_000).toISOString())
  })

  test('all api2 sources 401 → CursorUsageUnavailableError(session_rejected)', async () => {
    await assert.rejects(
      fetchCursorSessionUsage(
        { accessToken: ACCESS, authId: null, machineId: MACHINE_ID },
        { fetchImpl: mockFetch({ DashboardService: { status: 401, body: { error: 'unauthorized' } } }), now: () => NOW },
      ),
      (err: unknown) => err instanceof CursorUsageUnavailableError && err.code === 'session_rejected',
    )
  })

  test('all api2 sources network-fail → upstream_unavailable', async () => {
    await assert.rejects(
      fetchCursorSessionUsage(
        { accessToken: ACCESS, authId: null, machineId: null },
        { fetchImpl: mockFetch({ DashboardService: { throws: new Error('ECONNRESET') } }), now: () => NOW },
      ),
      (err: unknown) => err instanceof CursorUsageUnavailableError && err.code === 'upstream_unavailable' && !JSON.stringify(err.details).includes(ACCESS),
    )
  })
})

describe('cursorSessionUsage cache', () => {
  test('hit within TTL, miss after TTL, clear by id', () => {
    clearCursorUsageCache()
    const snap = blank()
    setCachedCursorUsage('11', snap, NOW)
    assert.equal(getCachedCursorUsage('11', NOW + 1_000), snap)
    assert.equal(getCachedCursorUsage('12', NOW + 1_000), null)
    assert.equal(getCachedCursorUsage('11', NOW + CURSOR_USAGE_CACHE_TTL_MS + 1), null)
    setCachedCursorUsage('11', snap, NOW)
    clearCursorUsageCache('11')
    assert.equal(getCachedCursorUsage('11', NOW), null)
  })
})
