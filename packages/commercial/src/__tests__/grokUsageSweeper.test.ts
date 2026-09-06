/**
 * grokUsageSweeper (0276): snapshot → column patch, per-account isolation,
 * never-throw sweep. No DB / no network: every dependency is injected.
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/grokUsageSweeper.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clearGrokUsageCache,
  emptyGrokUsageSnapshot,
  getCachedGrokUsage,
  GrokUsageUnavailableError,
} from '../admin/grokAccountUsage.js'
import { GrokOAuthRefreshError } from '../account-pool/grokOAuth.js'
import {
  grokUsagePatchFromSnapshot,
  grokUsageWeightInputsChanged,
  isGrokUsageSweepCandidate,
  refreshGrokAccountUsage,
  sweepGrokUsageOnce,
} from '../account-pool/grokUsageSweeper.js'
import type { AccountRow } from '../account-pool/store.js'

const NOW = 1_788_500_000_000

function row(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 14n,
    provider: 'grok',
    group_id: null,
    label: 'acct',
    plan: 'pro',
    status: 'active',
    health_score: 100,
    cooldown_until: null,
    oauth_expires_at: new Date(NOW + 3_600_000),
    subscription_end_at: null,
    last_used_at: null,
    last_error: null,
    success_count: 0n,
    fail_count: 0n,
    quota_remaining: null,
    quota_5h_pct: null,
    quota_5h_resets_at: null,
    quota_7d_pct: null,
    quota_7d_resets_at: null,
    quota_updated_at: null,
    egress_proxy: null,
    egress_proxy_id: null,
    egress_host_uuid: null,
    has_refresh_token: true,
    runtime_channel: 'v5',
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    cursor_quota_class: 'unknown',
    cursor_sand_enabled: false,
    cursor_credential_kind: 'api_key',
    cursor_auth_id: null,
    cursor_sand_usage_pct: null,
    cursor_sand_period_start: null,
    cursor_sand_next_reset_at: null,
    cursor_sand_access_state: null,
    cursor_plan_membership: null,
    cursor_billing_cycle_end: null,
    cursor_usage_updated_at: null,
    cursor_usage_error: null,
    grok_credit_usage_pct: null,
    grok_build_usage_pct: null,
    grok_credit_period_start: null,
    grok_credit_period_end: null,
    grok_subscription_tier: null,
    grok_usage_updated_at: null,
    grok_usage_error: null,
    ...over,
  } as AccountRow
}

function usageSnapshot(pct: number, buildPct: number, startIso: string, endIso: string, tier: string) {
  const s = emptyGrokUsageSnapshot(NOW)
  s.credits.usage_percent = pct
  s.credits.grok_build_percent = buildPct
  s.credits.period_start = startIso
  s.credits.period_end = endIso
  s.account.subscription_tier = tier
  return s
}

test('grokUsagePatchFromSnapshot picks the persisted columns and clamps the pct', () => {
  const snap = usageSnapshot(66.8123, 8.049, '2026-09-04T04:33:28.612Z', '2026-09-11T04:33:28.612Z', 'SuperGrokPro')
  const patch = grokUsagePatchFromSnapshot(snap)
  assert.equal(patch.grok_credit_usage_pct, 66.81)
  assert.equal(patch.grok_build_usage_pct, 8.05)
  assert.equal(patch.grok_credit_period_start?.toISOString(), '2026-09-04T04:33:28.612Z')
  assert.equal(patch.grok_credit_period_end?.toISOString(), '2026-09-11T04:33:28.612Z')
  assert.equal(patch.grok_subscription_tier, 'SuperGrokPro')

  const empty = grokUsagePatchFromSnapshot(emptyGrokUsageSnapshot(NOW))
  assert.deepEqual(empty, {
    grok_credit_usage_pct: null,
    grok_build_usage_pct: null,
    grok_credit_period_start: null,
    grok_credit_period_end: null,
    grok_subscription_tier: null,
  })
  const weird = emptyGrokUsageSnapshot(NOW)
  weird.credits.usage_percent = Number.NaN
  weird.credits.grok_build_percent = 1_234.567
  assert.equal(grokUsagePatchFromSnapshot(weird).grok_credit_usage_pct, null)
  assert.equal(grokUsagePatchFromSnapshot(weird).grok_build_usage_pct, 999.99)
})

test('refreshGrokAccountUsage skips non-grok rows without fetching', async () => {
  let fetched = 0
  let tokens = 0
  const result = await refreshGrokAccountUsage(row({ provider: 'cursor' }), {
    getToken: async () => { tokens++; return Buffer.from('tok') },
    fetchUsage: async () => { fetched++; return emptyGrokUsageSnapshot(NOW) },
    query: async () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.skipped, 'not_grok')
  assert.equal(fetched, 0)
  assert.equal(tokens, 0)
})

test('refreshGrokAccountUsage records oauth_terminal and skips token_terminal', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = []
  const token = Buffer.from('should-not-leak')
  const result = await refreshGrokAccountUsage(row(), {
    now: () => NOW,
    getToken: async () => { throw new GrokOAuthRefreshError(400, 'invalid_grant') },
    fetchUsage: async () => { throw new Error('must not fetch after a terminal token') },
    query: async (text, params) => { queries.push({ text, params }) },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.skipped, 'token_terminal')
  assert.equal(result.reason, 'oauth_terminal:invalid_grant')
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /SET grok_usage_error = \$2 WHERE id = \$1/)
  assert.equal(queries[0].params[1], 'oauth_terminal:invalid_grant')
  assert.doesNotMatch(queries[0].text, /grok_credit_usage_pct/, 'a failed token never overwrites the last good numbers')
  token.fill(0)
})

test('refreshGrokAccountUsage records the fetch failure reason and keeps previous numbers', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = []
  const token = Buffer.from('access-token-bytes')
  const result = await refreshGrokAccountUsage(row({ grok_credit_usage_pct: 40 }), {
    now: () => NOW,
    getToken: async () => token,
    fetchUsage: async () => { throw new GrokUsageUnavailableError('token_rejected', { credits: 'http_401', monthly: 'http_401', user: 'http_401' }) },
    query: async (text, params) => { queries.push({ text, params }) },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'token_rejected:credits,monthly,user')
  assert.equal(result.skipped, undefined)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /SET grok_usage_error = \$2 WHERE id = \$1/)
  assert.equal(queries[0].params[1], 'token_rejected:credits,monthly,user')
  assert.doesNotMatch(queries[0].text, /grok_credit_usage_pct/, 'a failed fetch never overwrites the last good numbers')
  assert.equal(token.every((b) => b === 0), true, 'token buffer wiped after use')
})

test('grokUsageWeightInputsChanged buckets pct by 5% and period_end by day', () => {
  const day = new Date('2026-09-11T04:33:28.612Z')
  const laterSameDay = new Date('2026-09-11T20:00:00.000Z')
  const nextDay = new Date('2026-09-12T04:33:28.612Z')
  const before = { grok_credit_usage_pct: 8, grok_credit_period_end: day }
  assert.equal(
    grokUsageWeightInputsChanged(before, { grok_credit_usage_pct: 9, grok_credit_period_end: day }),
    false,
    '8→9 stays in the same 5% bucket',
  )
  assert.equal(
    grokUsageWeightInputsChanged(before, { grok_credit_usage_pct: 13, grok_credit_period_end: day }),
    true,
    '8→13 crosses a 5% boundary',
  )
  assert.equal(
    grokUsageWeightInputsChanged(before, { grok_credit_usage_pct: 8, grok_credit_period_end: laterSameDay }),
    false,
    'same calendar day, different hour is not a change',
  )
  assert.equal(
    grokUsageWeightInputsChanged(before, { grok_credit_usage_pct: 8, grok_credit_period_end: nextDay }),
    true,
    'crossing a day boundary matters',
  )
  assert.equal(
    grokUsageWeightInputsChanged(
      { grok_credit_usage_pct: null, grok_credit_period_end: null },
      { grok_credit_usage_pct: 8, grok_credit_period_end: day },
    ),
    true,
    'null → value is a change',
  )
})

test('refreshGrokAccountUsage persists columns + snapshot and warms the cache', async () => {
  clearGrokUsageCache()
  const queries: Array<{ text: string; params: unknown[] }> = []
  const token = Buffer.from('access-token-bytes')
  const dispatcher = { name: 'direct' } as never
  const result = await refreshGrokAccountUsage(row(), {
    now: () => NOW,
    dispatcher,
    getToken: async () => token,
    fetchUsage: async (input) => {
      assert.equal(input.accessToken, 'access-token-bytes')
      assert.equal(input.dispatcher, dispatcher)
      return usageSnapshot(8, 8, '2026-09-04T04:33:28.612Z', '2026-09-11T04:33:28.612Z', 'SuperGrokPro')
    },
    query: async (text, params) => { queries.push({ text, params }) },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.weightInputsChanged, true, 'row 初值 null,快照 pct 8 → true')
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /grok_credit_usage_pct\s*=\s*COALESCE\(\$2::numeric/)
  assert.match(queries[0].text, /grok_usage_snapshot\s*=\s*\$7::jsonb/)
  assert.match(queries[0].text, /grok_usage_error\s*=\s*NULL/)
  assert.equal(queries[0].params[0], '14')
  assert.equal(queries[0].params[1], 8)
  assert.equal(queries[0].params[2], 8)
  assert.equal(queries[0].params[5], 'SuperGrokPro')
  const stored = JSON.parse(String(queries[0].params[6])) as { credits: { usage_percent: number }; account: { subscription_tier: string } }
  assert.equal(stored.credits.usage_percent, 8)
  assert.equal(stored.account.subscription_tier, 'SuperGrokPro')
  assert.match(String(queries[0].params[6]), /^(?!.*access-token-bytes)/, 'snapshot never carries the token')
  assert.equal(token.every((b) => b === 0), true)
  assert.equal(getCachedGrokUsage('14', NOW)?.credits.usage_percent, 8)
  clearGrokUsageCache()
})

test('refreshGrokAccountUsage weightInputsChanged is false when pct stays in the same 5% bucket', async () => {
  clearGrokUsageCache()
  const periodEnd = new Date('2026-09-11T04:33:28.612Z')
  const token = Buffer.from('access-token-bytes')
  const result = await refreshGrokAccountUsage(
    row({ grok_credit_usage_pct: 8, grok_credit_period_end: periodEnd }),
    {
      now: () => NOW,
      getToken: async () => token,
      fetchUsage: async () => usageSnapshot(9, 8, '2026-09-04T04:33:28.612Z', '2026-09-11T04:33:28.612Z', 'SuperGrokPro'),
      query: async () => {},
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.weightInputsChanged, false, 'row 初值 8 快照 9 → false')
  clearGrokUsageCache()
})

test('refreshGrokAccountUsage compares against the COALESCEd value when the snapshot lacks a number', async () => {
  clearGrokUsageCache()
  const periodEnd = new Date('2026-09-11T04:33:28.612Z')
  const snap = emptyGrokUsageSnapshot(NOW) // usage_percent / period_end stay null → UPDATE keeps old columns
  snap.account.subscription_tier = 'SuperGrokPro'
  const result = await refreshGrokAccountUsage(
    row({ grok_credit_usage_pct: 8, grok_credit_period_end: periodEnd }),
    {
      now: () => NOW,
      getToken: async () => Buffer.from('access-token-bytes'),
      fetchUsage: async () => snap,
      query: async () => {},
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.weightInputsChanged, false, 'null patch value COALESCEs onto 8 → nothing moved')
  clearGrokUsageCache()
})

test('sweepGrokUsageOnce isolates failures, skips ineligible rows, and never throws', async () => {
  clearGrokUsageCache()
  const rows = [
    row({ id: 14n }),
    row({ id: 15n, label: 'rejects' }),
    row({ id: 16n, status: 'disabled' }),
    row({ id: 17n, provider: 'cursor' }),
    row({ id: 18n, label: 'throws' }),
    row({ id: 19n, status: 'cooldown' }),
  ]
  assert.deepEqual(rows.map(isGrokUsageSweepCandidate), [true, true, false, false, true, true])
  const sleeps: number[] = []
  const summary = await sweepGrokUsageOnce({
    now: () => NOW,
    listGrokAccounts: async () => rows,
    sleep: async (ms) => { sleeps.push(ms) },
    getToken: async (id) => {
      if (String(id) === '18') throw new Error('kms offline')
      return Buffer.from('access-token-bytes')
    },
    fetchUsage: async () => {
      throw new GrokUsageUnavailableError('all_failed', { credits: 'http_500' })
    },
    query: async () => {},
  })
  // 14/15 fail fetch, 18 token throws (counted failed, not skipped), 16/17 not candidates.
  // 19 cooldown is a candidate and also fails fetch.
  assert.equal(summary.scanned, 4)
  assert.equal(summary.refreshed, 0)
  assert.equal(summary.failed, 4)
  assert.equal(summary.skipped, 0)
  assert.equal(summary.weightChanged, 0)
  assert.equal(sleeps.length, 3, 'paced between accounts, not after the last')

  const listingFailed = await sweepGrokUsageOnce({
    listGrokAccounts: async () => { throw new Error('db down') },
    getToken: async () => { throw new Error('must not run') },
    fetchUsage: async () => { throw new Error('must not run') },
    query: async () => { throw new Error('must not run') },
  })
  assert.deepEqual(listingFailed, { scanned: 0, refreshed: 0, failed: 0, skipped: 0, weightChanged: 0 })
  clearGrokUsageCache()
})

test('sweepGrokUsageOnce counts token_terminal as skipped and a success as refreshed', async () => {
  const rows = [
    row({ id: 20n }),
    row({ id: 21n, label: 'dead-token' }),
    row({ id: 22n, label: 'missing' }),
  ]
  const summary = await sweepGrokUsageOnce({
    now: () => NOW,
    listGrokAccounts: async () => rows,
    sleep: async () => {},
    getToken: async (id) => {
      if (String(id) === '21') throw new GrokOAuthRefreshError(401, 'invalid_client')
      if (String(id) === '22') throw new Error('GROK_ACCOUNT_NOT_FOUND')
      return Buffer.from('access-token-bytes')
    },
    fetchUsage: async () => usageSnapshot(12, 12, '2026-09-04T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'SuperGrok'),
    query: async () => {},
  })
  assert.equal(summary.scanned, 3)
  assert.equal(summary.refreshed, 1)
  assert.equal(summary.skipped, 2)
  assert.equal(summary.failed, 0)
  assert.equal(summary.weightChanged, 1, 'null → pct 12 moves the 5% bucket')
})

test('sweepGrokUsageOnce weightChanged counts only bucketed input moves', async () => {
  const periodEndIso = '2026-09-11T00:00:00.000Z'
  const periodEnd = new Date(periodEndIso)
  const rows = [
    row({ id: 30n, grok_credit_usage_pct: 8, grok_credit_period_end: periodEnd }),
    row({ id: 31n, grok_credit_usage_pct: null, grok_credit_period_end: null }),
  ]
  const summary = await sweepGrokUsageOnce({
    now: () => NOW,
    listGrokAccounts: async () => rows,
    sleep: async () => {},
    getToken: async () => Buffer.from('access-token-bytes'),
    fetchUsage: async () => usageSnapshot(9, 9, '2026-09-04T00:00:00.000Z', periodEndIso, 'SuperGrok'),
    query: async () => {},
  })
  assert.equal(summary.scanned, 2)
  assert.equal(summary.refreshed, 2)
  assert.equal(summary.weightChanged, 1, '8→9 same day is not a change; null→9 is')
})
