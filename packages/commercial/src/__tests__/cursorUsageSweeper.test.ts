/**
 * cursorUsageSweeper (0260): snapshot → column patch, per-account isolation,
 * weight-input bucketing, materializer nudge. No DB / no network: every
 * dependency is injected.
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/cursorUsageSweeper.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clearCursorUsageCache, emptySnapshot, getCachedCursorUsage, CursorUsageUnavailableError } from '../admin/cursorSessionUsage.js'
import {
  cursorUsagePatchFromSnapshot,
  cursorUsageWeightInputsChanged,
  isCursorUsageSweepCandidate,
  refreshCursorAccountUsage,
  sweepCursorUsageOnce,
} from '../account-pool/cursorUsageSweeper.js'
import type { AccountRow, CursorTokenSnapshot } from '../account-pool/store.js'

const NOW = 1_788_500_000_000

function row(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 14n,
    provider: 'cursor',
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
    cursor_quota_class: 'other_ok',
    cursor_sand_enabled: true,
    cursor_credential_kind: 'session',
    cursor_auth_id: 'auth0|user_01',
    cursor_sand_usage_pct: null,
    cursor_sand_period_start: null,
    cursor_sand_next_reset_at: null,
    cursor_sand_access_state: null,
    cursor_plan_membership: null,
    cursor_billing_cycle_end: null,
    cursor_usage_updated_at: null,
    cursor_usage_error: null,
    ...over,
  } as AccountRow
}

function tokenSnap(over: Partial<CursorTokenSnapshot> = {}): CursorTokenSnapshot {
  return {
    id: 14n,
    token: Buffer.from('session-token-bytes'),
    credential_kind: 'session',
    machine_id: 'abcdefghijklmnopqrstuvwxyz',
    refresh: Buffer.from('refresh-bytes'),
    expires_at: new Date(NOW + 3_600_000),
    ...over,
  } as CursorTokenSnapshot
}

function sandSnapshot(pct: number, resetIso: string, cycleEndIso: string) {
  const s = emptySnapshot(NOW)
  s.sand.usage_percent = pct
  s.sand.period_start = '2026-08-30T00:00:00.000Z'
  s.sand.next_reset_at = resetIso
  s.sand.access_state = 'SAND_ACCESS_STATE_GRANTED'
  s.plan.membership_type = 'pro'
  s.plan.billing_cycle_end = cycleEndIso
  return s
}

test('cursorUsagePatchFromSnapshot picks the persisted columns and clamps the pct', () => {
  const snap = sandSnapshot(66.8123, '2026-09-06T00:00:00.000Z', '2026-09-25T10:20:33.431Z')
  const patch = cursorUsagePatchFromSnapshot(snap)
  assert.equal(patch.cursor_sand_usage_pct, 66.81)
  assert.equal(patch.cursor_sand_period_start?.toISOString(), '2026-08-30T00:00:00.000Z')
  assert.equal(patch.cursor_sand_next_reset_at?.toISOString(), '2026-09-06T00:00:00.000Z')
  assert.equal(patch.cursor_sand_access_state, 'SAND_ACCESS_STATE_GRANTED')
  assert.equal(patch.cursor_plan_membership, 'pro')
  assert.equal(patch.cursor_billing_cycle_end?.toISOString(), '2026-09-25T10:20:33.431Z')

  const empty = cursorUsagePatchFromSnapshot(emptySnapshot(NOW))
  assert.deepEqual(empty, {
    cursor_sand_usage_pct: null,
    cursor_sand_period_start: null,
    cursor_sand_next_reset_at: null,
    cursor_sand_access_state: null,
    cursor_plan_membership: null,
    cursor_billing_cycle_end: null,
  })
  const weird = emptySnapshot(NOW)
  weird.sand.usage_percent = Number.NaN
  assert.equal(cursorUsagePatchFromSnapshot(weird).cursor_sand_usage_pct, null)
})

test('weight inputs are bucketed: small hourly drift does not churn the pool projection', () => {
  const base = row({
    cursor_sand_usage_pct: 61,
    cursor_sand_next_reset_at: new Date('2026-09-06T00:00:00.000Z'),
    cursor_billing_cycle_end: new Date('2026-09-25T10:20:33.431Z'),
  })
  const same = cursorUsagePatchFromSnapshot(sandSnapshot(63.9, '2026-09-06T05:00:00.000Z', '2026-09-25T00:00:00.000Z'))
  assert.equal(cursorUsageWeightInputsChanged(base, same), false, '61→63.9 stays in the 60-65 bucket, same reset day')
  const crossed = cursorUsagePatchFromSnapshot(sandSnapshot(65.2, '2026-09-06T05:00:00.000Z', '2026-09-25T00:00:00.000Z'))
  assert.equal(cursorUsageWeightInputsChanged(base, crossed), true, 'crossing a 5% boundary matters')
  const reset = cursorUsagePatchFromSnapshot(sandSnapshot(61, '2026-09-13T00:00:00.000Z', '2026-09-25T00:00:00.000Z'))
  assert.equal(cursorUsageWeightInputsChanged(base, reset), true, 'weekly reset moved')
  const firstObservation = row()
  assert.equal(cursorUsageWeightInputsChanged(firstObservation, same), true, 'null → value is a change')
})

test('refreshCursorAccountUsage persists columns + snapshot, warms the cache, nudges on weight change', async () => {
  clearCursorUsageCache()
  const queries: Array<{ text: string; params: unknown[] }> = []
  const nudged: bigint[] = []
  const snap = tokenSnap()
  const result = await refreshCursorAccountUsage(row(), {
    now: () => NOW,
    getTokenSnapshot: async () => snap,
    fetchUsage: async (input) => {
      assert.equal(input.accessToken, 'session-token-bytes')
      assert.equal(input.authId, 'auth0|user_01')
      assert.equal(input.machineId, 'abcdefghijklmnopqrstuvwxyz')
      return sandSnapshot(72, '2026-09-06T00:00:00.000Z', '2026-09-25T10:20:33.431Z')
    },
    query: async (text, params) => { queries.push({ text, params }) },
    onWeightInputsChanged: (id) => nudged.push(id),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.weightInputsChanged, true)
  assert.deepEqual(nudged, [14n])
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /cursor_sand_usage_pct\s*=\s*COALESCE\(\$2::numeric/)
  assert.match(queries[0].text, /cursor_usage_snapshot\s*=\s*\$9::jsonb/)
  assert.equal(queries[0].params[0], '14')
  assert.equal(queries[0].params[1], 72)
  assert.equal(queries[0].params[7], null, 'error column cleared on success')
  const stored = JSON.parse(String(queries[0].params[8])) as { sand: { usage_percent: number } }
  assert.equal(stored.sand.usage_percent, 72)
  assert.match(String(queries[0].params[8]), /^(?!.*session-token-bytes)/, 'snapshot never carries the token')
  // Token buffers are wiped after use.
  assert.equal(snap.token.every((b) => b === 0), true)
  assert.equal(snap.refresh?.every((b) => b === 0), true)
  // The modal's 60s cache is warm.
  assert.equal(getCachedCursorUsage('14', NOW)?.sand.usage_percent, 72)
  clearCursorUsageCache()
})

test('refreshCursorAccountUsage records the failure reason and keeps previous numbers', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = []
  const nudged: bigint[] = []
  const result = await refreshCursorAccountUsage(row({ cursor_sand_usage_pct: 40 }), {
    now: () => NOW,
    getTokenSnapshot: async () => tokenSnap(),
    fetchUsage: async () => { throw new CursorUsageUnavailableError('session_rejected', { current_period: 'HTTP 401' }) },
    query: async (text, params) => { queries.push({ text, params }) },
    onWeightInputsChanged: (id) => nudged.push(id),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'session_rejected:current_period')
  assert.equal(result.skipped, undefined)
  assert.equal(nudged.length, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0].text, /SET cursor_usage_error = \$2 WHERE id = \$1/)
  assert.doesNotMatch(queries[0].text, /cursor_sand_usage_pct/, 'a failed fetch never overwrites the last good numbers')
})

test('refreshCursorAccountUsage skips expired sessions and non-session rows without fetching', async () => {
  let fetched = 0
  const queries: string[] = []
  const expired = await refreshCursorAccountUsage(row(), {
    now: () => NOW,
    getTokenSnapshot: async () => tokenSnap({ expires_at: new Date(NOW - 1) }),
    fetchUsage: async () => { fetched++; return emptySnapshot(NOW) },
    query: async (text) => { queries.push(text) },
  })
  assert.equal(expired.ok, false)
  assert.equal(!expired.ok && expired.skipped, 'expired')
  assert.equal(fetched, 0)
  assert.equal(queries.length, 1)

  const apiKey = await refreshCursorAccountUsage(row({ cursor_credential_kind: 'api_key', cursor_auth_id: null }), {
    getTokenSnapshot: async () => { throw new Error('must not read the token of a non-session row') },
    fetchUsage: async () => { fetched++; return emptySnapshot(NOW) },
    query: async () => {},
  })
  assert.equal(apiKey.ok, false)
  assert.equal(!apiKey.ok && apiKey.skipped, 'not_session')
  assert.equal(fetched, 0)
})

test('sweepCursorUsageOnce isolates failures, skips ineligible rows, and nudges the pool once', async () => {
  clearCursorUsageCache()
  const rows = [
    row({ id: 14n }),
    row({ id: 15n, label: 'rejects' }),
    row({ id: 16n, status: 'disabled' }),
    row({ id: 17n, cursor_credential_kind: 'api_key', cursor_auth_id: null }),
    row({ id: 18n, label: 'throws' }),
    row({ id: 19n, provider: 'claude' }),
  ]
  assert.deepEqual(rows.map(isCursorUsageSweepCandidate), [true, true, false, false, true, false])
  const sleeps: number[] = []
  let nudges = 0
  const summary = await sweepCursorUsageOnce({
    now: () => NOW,
    listCursorAccounts: async () => rows,
    sleep: async (ms) => { sleeps.push(ms) },
    getTokenSnapshot: async (id) => {
      if (String(id) === '18') throw new Error('kms offline')
      return tokenSnap({ id: BigInt(String(id)) })
    },
    fetchUsage: async (input) => {
      // Slot 15 has a dead session; the others answer.
      if (input.accessToken === 'session-token-bytes' && input.authId === 'auth0|user_01') {
        return sandSnapshot(30, '2026-09-06T00:00:00.000Z', '2026-09-25T00:00:00.000Z')
      }
      throw new CursorUsageUnavailableError('session_rejected', {})
    },
    query: async () => {},
    onWeightInputsChanged: () => { nudges++ },
  })
  // 14 ok, 15 ok (same fake token → both succeed here), 18 throws.
  assert.equal(summary.scanned, 3)
  assert.equal(summary.refreshed, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.skipped, 0)
  assert.equal(summary.weightChanged, 2)
  assert.equal(nudges, 1, 'materializer is nudged once per sweep, not per account')
  assert.equal(sleeps.length, 2, 'paced between accounts, not after the last')
  clearCursorUsageCache()
})
