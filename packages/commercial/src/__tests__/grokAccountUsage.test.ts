/**
 * Grok Build account usage snapshot: lenient parsing + fetch fold.
 * No real network: the xAI proxy is a mocked undici `request`. Shapes below are
 * the redacted live responses captured on 2026-09-06 (two SuperGrokPro rows).
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/grokAccountUsage.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  GROK_USAGE_CACHE_TTL_MS,
  GrokUsageUnavailableError,
  applyCreditsBilling,
  applyMonthlyBilling,
  applyUserSubscription,
  buildGrokUsageHeaders,
  clearGrokUsageCache,
  emptyGrokUsageSnapshot,
  fetchGrokAccountUsage,
  getCachedGrokUsage,
  maskEmail,
  setCachedGrokUsage,
} from '../admin/grokAccountUsage.js'

const NOW = 1_788_500_000_000
const TOKEN = 'a'.repeat(64)

const CREDITS = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-04T04:33:28.612588+00:00', end: '2026-09-11T04:33:28.612588+00:00' },
    creditUsagePercent: 8,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 8 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
    billingPeriodStart: '2026-09-04T04:33:28.612588+00:00',
    billingPeriodEnd: '2026-09-11T04:33:28.612588+00:00',
  },
}
const MONTHLY = {
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-09-01T00:00:00+00:00',
    billingPeriodEnd: '2026-10-01T00:00:00+00:00',
    history: [{ billingCycle: { year: 2026, month: 8 }, includedUsed: { val: 0 }, onDemandUsed: { val: 0 }, totalUsed: { val: 0 } }],
  },
}
const USER = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'someone@example.com',
  firstName: 'Jo',
  lastName: 'Doe',
  userBlockedReason: null,
  principalType: 'User',
  principalId: '00000000-0000-4000-8000-000000000001',
  teamId: null,
  teamName: null,
  organizationName: null,
  codingDataRetentionOptOut: true,
  hasGrokCodeAccess: true,
  subscriptionTier: 'SuperGrokPro',
}

type Route = { status: number; body?: unknown; text?: string; throws?: Error }

function mockRequest(routes: Record<string, Route>, seen: Array<{ url: string; headers: Record<string, string> }> = []) {
  return (async (url: string | URL, init: { headers?: Record<string, string> }) => {
    const u = String(url)
    seen.push({ url: u, headers: init.headers ?? {} })
    const path = u.slice('https://cli-chat-proxy.grok.com/v1'.length)
    const route = routes[path]
    if (!route) throw new Error(`unexpected ${u}`)
    if (route.throws) throw route.throws
    const text = route.text ?? JSON.stringify(route.body ?? null)
    return { statusCode: route.status, headers: {}, body: { text: async () => text } }
  }) as unknown as typeof import('undici').request
}

describe('grokAccountUsage appliers', () => {
  test('credits billing → weekly period, pool %, GrokBuild product %', () => {
    const s = emptyGrokUsageSnapshot(NOW)
    applyCreditsBilling(s, CREDITS)
    assert.equal(s.credits.period_type, 'USAGE_PERIOD_TYPE_WEEKLY')
    assert.equal(s.credits.period_start, '2026-09-04T04:33:28.612Z')
    assert.equal(s.credits.period_end, '2026-09-11T04:33:28.612Z')
    assert.equal(s.credits.usage_percent, 8)
    assert.deepEqual(s.credits.products, [{ product: 'GrokBuild', usage_percent: 8 }])
    assert.equal(s.credits.grok_build_percent, 8)
    assert.equal(s.credits.on_demand_cap, 0)
    assert.equal(s.credits.on_demand_used, 0)
    assert.equal(s.credits.prepaid_balance, 0)
    assert.equal(s.credits.top_up_method, 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD')
    assert.equal(s.credits.is_unified_billing_user, true)
  })

  test('credits billing tolerates bare numbers, missing config wrapper and garbage', () => {
    const s = emptyGrokUsageSnapshot(NOW)
    applyCreditsBilling(s, { creditUsagePercent: '42.5', onDemandCap: 10, productUsage: [{ product: 'GrokBuild' }, 'junk', { usagePercent: 1 }] })
    assert.equal(s.credits.usage_percent, 42.5)
    assert.equal(s.credits.on_demand_cap, 10)
    assert.deepEqual(s.credits.products, [{ product: 'GrokBuild', usage_percent: null }])
    assert.equal(s.credits.grok_build_percent, null)
    assert.equal(s.credits.period_end, null)
    const g = emptyGrokUsageSnapshot(NOW)
    applyCreditsBilling(g, 'not an object')
    applyCreditsBilling(g, null)
    applyCreditsBilling(g, [1, 2])
    assert.deepEqual(g, emptyGrokUsageSnapshot(NOW))
  })

  test('monthly billing → limit/used/period', () => {
    const s = emptyGrokUsageSnapshot(NOW)
    applyMonthlyBilling(s, MONTHLY)
    assert.equal(s.monthly.limit, 0)
    assert.equal(s.monthly.used, 0)
    assert.equal(s.monthly.on_demand_cap, 0)
    assert.equal(s.monthly.period_start, '2026-09-01T00:00:00.000Z')
    assert.equal(s.monthly.period_end, '2026-10-01T00:00:00.000Z')
  })

  test('user subscription → tier, access flag, masked email; never the raw address or names', () => {
    const s = emptyGrokUsageSnapshot(NOW)
    applyUserSubscription(s, USER)
    assert.equal(s.account.subscription_tier, 'SuperGrokPro')
    assert.equal(s.account.has_grok_code_access, true)
    assert.equal(s.account.user_blocked_reason, null)
    assert.equal(s.account.principal_type, 'User')
    assert.equal(s.account.email_masked, 'so***@example.com')
    const json = JSON.stringify(s)
    assert.ok(!json.includes('someone@example.com'))
    assert.ok(!json.includes('"Jo"'))
    assert.ok(!json.includes('Doe'))
    assert.ok(!json.includes(USER.userId))
  })

  test('maskEmail edge cases', () => {
    assert.equal(maskEmail(null), null)
    assert.equal(maskEmail('a@b.c'), 'a***@b.c')
    assert.equal(maskEmail('no-at-sign'), '***')
    assert.equal(maskEmail('@x.y'), '***')
  })
})

describe('fetchGrokAccountUsage', () => {
  test('folds all three sources; sends bearer + CLI proxy headers; never leaks the token', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const requestFn = mockRequest({
      '/billing?format=credits': { status: 200, body: CREDITS },
      '/billing': { status: 200, body: MONTHLY },
      '/user?include=subscription': { status: 200, body: USER },
    }, seen)
    const snap = await fetchGrokAccountUsage({ accessToken: TOKEN, requestFn, now: () => NOW })
    assert.equal(snap.fetched_at, new Date(NOW).toISOString())
    assert.deepEqual(snap.errors, {})
    assert.equal(snap.credits.grok_build_percent, 8)
    assert.equal(snap.monthly.period_end, '2026-10-01T00:00:00.000Z')
    assert.equal(snap.account.subscription_tier, 'SuperGrokPro')
    assert.equal(seen.length, 3)
    for (const call of seen) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)
      assert.equal(call.headers['x-xai-token-auth'], 'xai-grok-cli')
      assert.equal(call.headers['x-authenticateresponse'], 'authenticate-response')
    }
    assert.ok(!JSON.stringify(snap).includes(TOKEN))
  })

  test('partial failure is a success with errors[] populated', async () => {
    const requestFn = mockRequest({
      '/billing?format=credits': { status: 200, body: CREDITS },
      '/billing': { status: 500, text: 'boom' },
      '/user?include=subscription': { status: 200, text: '<html>not json</html>' },
    })
    const snap = await fetchGrokAccountUsage({ accessToken: TOKEN, requestFn, now: () => NOW })
    assert.equal(snap.credits.usage_percent, 8)
    assert.equal(snap.errors.monthly, 'http_500')
    assert.equal(snap.errors.user, 'non_json')
    assert.equal(snap.account.subscription_tier, null)
  })

  test('all 401/403 → token_rejected; mixed total failure → all_failed', async () => {
    const rejected = mockRequest({
      '/billing?format=credits': { status: 401, body: { error: 'x' } },
      '/billing': { status: 403, body: {} },
      '/user?include=subscription': { status: 401, body: {} },
    })
    await assert.rejects(
      fetchGrokAccountUsage({ accessToken: TOKEN, requestFn: rejected, now: () => NOW }),
      (err: unknown) => err instanceof GrokUsageUnavailableError && err.code === 'token_rejected' && err.details.credits === 'http_401',
    )
    const dead = mockRequest({
      '/billing?format=credits': { status: 401, body: {} },
      '/billing': { status: 502, body: {} },
      '/user?include=subscription': { status: 0, throws: new Error('ECONNRESET   trailing   spaces') },
    })
    await assert.rejects(
      fetchGrokAccountUsage({ accessToken: TOKEN, requestFn: dead, now: () => NOW }),
      (err: unknown) => err instanceof GrokUsageUnavailableError && err.code === 'all_failed' && err.details.user === 'ECONNRESET trailing spaces',
    )
  })

  test('headers helper is the documented CLI proxy contract', () => {
    const h = buildGrokUsageHeaders('tok')
    assert.equal(h.authorization, 'Bearer tok')
    assert.equal(h['x-xai-token-auth'], 'xai-grok-cli')
    assert.equal(h.accept, 'application/json')
  })
})

describe('grok usage cache', () => {
  test('ttl semantics', () => {
    clearGrokUsageCache()
    const snap = emptyGrokUsageSnapshot(NOW)
    assert.equal(getCachedGrokUsage('12', NOW), null)
    setCachedGrokUsage('12', snap, NOW)
    assert.equal(getCachedGrokUsage('12', NOW + GROK_USAGE_CACHE_TTL_MS - 1), snap)
    assert.equal(getCachedGrokUsage('12', NOW + GROK_USAGE_CACHE_TTL_MS + 1), null)
    clearGrokUsageCache()
  })
})
