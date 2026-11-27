/** OCV5-917: real delegate picks and atomic in-process reservations; only PG is faked. */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  ANTIGRAVITY_AFFINITY_SERVICE as SERVICE,
  type AntigravityAccountPick,
  pickAntigravityAccount,
} from '../account-pool/antigravityPool.js'
import {
  _resetAffinityCapsForTest,
  _resetAffinityTouchForTest,
  configureAffinitySettings,
  inflightCount,
  releaseInflight,
} from '../account-pool/policy/affinity.js'
import { resetPool, setPoolOverride } from '../db/index.js'

const MODEL = 'antigravity-gemini-3.8-flash'
const USER = 42n
const settings = (antigravityInflight: number, antigravityRatePerMin = 20) => async () => ({
  maxUsersPerSubscription: 8,
  ratePerMin: 30,
  antigravityInflight,
  antigravityRatePerMin,
})

afterEach(async () => {
  configureAffinitySettings(null)
  _resetAffinityCapsForTest()
  _resetAffinityTouchForTest()
  await resetPool()
})

function account(
  id: string,
  paidTier = 'g1-ultra-tier',
  availableModels: AntigravityAccountPick['availableModels'] = null,
) {
  return {
    id,
    email: `account-${id}@example.invalid`,
    paid_tier: paidTier,
    health_score: 100,
    last_used_at: null,
    status: 'active',
    available_models: availableModels,
  }
}

function fakePg(rows = [account('1')]) {
  const unexpected: string[] = []
  let beforeBindingRead: (() => Promise<void>) | undefined
  const bound = rows[0]
  // Prebind the caller to the first account so the real affinity path prefers it.
  const binding = {
    member_kind: 'account',
    member_id: bound.id,
    last_used_at: new Date(),
    expires_at: new Date(Date.now() + 86_400_000),
    migrations_recent: 0,
    migrations_window_start: null,
  }
  const pool = {
    async query(sql: string, params: readonly unknown[] = []) {
      if (/^SELECT id::text AS id, email/.test(sql)) return { rows }
      if (/^SELECT member_kind, member_id, last_used_at/.test(sql)) {
        assert.deepEqual(params, [SERVICE, String(USER)])
        await beforeBindingRead?.()
        return { rows: [binding] }
      }
      if (/^SELECT status, cooldown_reason, cooldown_until/.test(sql)) {
        return { rows: rows.filter((row) => row.id === params[0]) }
      }
      if (/^SELECT member_id, count/.test(sql)) {
        return { rows: [{ member_id: binding.member_id, n: '1' }] }
      }
      if (/^UPDATE pool_user_affinity SET last_used_at/.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      unexpected.push(sql)
      throw new Error(`Unexpected fake PG query: ${sql}`)
    },
    async end() {},
  } as never
  // Both candidate lookup and resolveAffinity's internal DB helper use this fake.
  setPoolOverride(pool)
  const pick = (reserveToken: string, skip?: (id: bigint) => Promise<boolean>) =>
    pickAntigravityAccount({ userId: USER, modelId: MODEL, strictCapacity: true, reserveToken, skip })
  return {
    pick,
    async race(tokens: string[]) {
      // All racers see the same initial capacity, then wait on real affinity I/O
      // before any can reserve. The reservation must recheck current capacity.
      let readers = 0
      let openGate!: () => void
      const gate = new Promise<void>((resolve) => { openGate = resolve })
      beforeBindingRead = async () => {
        if (++readers === tokens.length) openGate()
        await gate
      }
      try {
        return await Promise.all(tokens.map((token) => pick(token)))
      } finally {
        beforeBindingRead = undefined
      }
    },
    assertNoUnexpectedQueries() {
      // The picker swallows affinity DB errors; don't let an incomplete fake
      // silently send a test through the degraded affinity path.
      assert.deepEqual(unexpected, [])
    },
  }
}

for (const cap of [3, 1]) {
  test(`selfhost delegates reserve four live slots with an in-flight cap of ${cap}`, async () => {
    configureAffinitySettings(settings(cap), true)
    const pg = fakePg()
    for (let i = 1; i <= 4; i++) {
      assert.equal((await pg.pick(`delegate-${i}`))?.accountId, 1n, `delegate ${i} must be admitted`)
      assert.equal(inflightCount(SERVICE, '1'), i, 'returned picks must each own a slot')
    }
    pg.assertNoUnexpectedQueries()
  })
}

for (const flag of ['omitted', false] as const) {
  test(`commercial delegate stays strict with selfhost flag ${flag}; release restores capacity`, async () => {
    const loader = settings(3)
    if (flag === 'omitted') configureAffinitySettings(loader)
    else configureAffinitySettings(loader, flag)
    const pg = fakePg()
    for (const token of ['one', 'two', 'three']) {
      assert.equal((await pg.pick(token))?.accountId, 1n)
    }
    assert.equal(await pg.pick('four'), null)
    assert.equal(inflightCount(SERVICE, '1'), 3, 'a denied pick does not take a slot')
    releaseInflight('two') // same token-scoped hook that cancellation uses
    releaseInflight('two')
    assert.equal(inflightCount(SERVICE, '1'), 2, 'duplicate release does not free another turn')
    assert.equal((await pg.pick('replacement'))?.accountId, 1n)
    assert.equal(inflightCount(SERVICE, '1'), 3)
    pg.assertNoUnexpectedQueries()
  })
}

test('selfhost minute cap is atomic across racing delegates and survives cancellation', { timeout: 5_000 }, async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  configureAffinitySettings(settings(3, 5), true)
  const pg = fakePg()
  for (const token of ['one', 'two', 'three', 'four']) {
    assert.equal((await pg.pick(token))?.accountId, 1n)
  }

  const racing = ['five-a', 'five-b', 'five-c']
  const results = await pg.race(racing)
  assert.equal(results.filter((pick) => pick?.accountId === 1n).length, 1)
  assert.equal(results.filter((pick) => pick === null).length, 2)
  assert.equal(inflightCount(SERVICE, '1'), 5, 'only the winning racer reserves')

  for (const token of ['one', 'two', 'three', 'four', ...racing]) releaseInflight(token)
  assert.equal(inflightCount(SERVICE, '1'), 0)
  assert.equal(await pg.pick('still-rate-limited'), null, 'free slots do not refund minute quota')
  assert.equal(inflightCount(SERVICE, '1'), 0)

  now += 60_001
  assert.equal((await pg.pick('after-window'))?.accountId, 1n)
  assert.equal(inflightCount(SERVICE, '1'), 1)
  pg.assertNoUnexpectedQueries()
})

test('racing selfhost delegates fill an open Pro slot before exceeding the bound Ultra cap', { timeout: 5_000 }, async () => {
  configureAffinitySettings(settings(1), true)
  const pg = fakePg([account('1'), account('2', 'g1-pro-tier')])
  const picks = await pg.race(['left', 'right'])
  assert.deepEqual(picks.map((pick) => pick?.accountId).sort(), [1n, 2n])
  assert.equal(inflightCount(SERVICE, '1'), 1)
  assert.equal(inflightCount(SERVICE, '2'), 1)

  const overflow = await pg.pick('overflow')
  assert.ok(overflow, 'once both accounts are full, another pick may overflow')
  assert.equal(inflightCount(SERVICE, String(overflow.accountId)), 2)
  assert.equal(inflightCount(SERVICE, '1') + inflightCount(SERVICE, '2'), 3)
  pg.assertNoUnexpectedQueries()
})

test('selfhost cannot overflow onto accounts excluded by model availability or cooldown', async () => {
  configureAffinitySettings(settings(1), true)
  const pg = fakePg([
    account('1'),
    account('2', 'g1-ultra-tier', {}), // directory does not offer the model
    account('3'), // excluded by live model cooldown
  ])
  const cooling = async (id: bigint) => id === 3n
  assert.equal((await pg.pick('initial', cooling))?.accountId, 1n)
  assert.equal((await pg.pick('overflow', cooling))?.accountId, 1n, 'only the full account is usable')
  assert.equal(await pg.pick('unavailable', async (id) => id === 1n || id === 3n), null)
  assert.equal(inflightCount(SERVICE, '1'), 2)
  assert.equal(inflightCount(SERVICE, '2'), 0)
  assert.equal(inflightCount(SERVICE, '3'), 0)
  pg.assertNoUnexpectedQueries()
})
