/**
 * Antigravity per-model cooldown (OCV5-415): a model's upstream 5xx (Cloud
 * Code "No capacity available for model …") cools that model on that account
 * only; other models on the account and the account row are untouched.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/antigravityModelCooldown.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  AntigravityAdmissionError,
  admitAntigravityTurn,
} from '../account-pool/antigravityAdmission.js'
import {
  ANTIGRAVITY_MODEL_COOLDOWN_POLICY,
  _resetAntigravityModelCooldownForTests,
  antigravityModelCoolingUntil,
  decideAntigravityModelCooldown,
  reportAntigravityModelOutcome,
} from '../account-pool/antigravityModelCooldown.js'
import {
  decideAntigravityInterim,
  pickAntigravityAccount,
  reportAntigravityOutcome,
} from '../account-pool/antigravityPoolInterim.js'
import {
  type AntigravityRelayKv,
  _resetAntigravityRelayRoutesForTests,
  configureAntigravityRelayKv,
} from '../billing/antigravityRouteContext.js'

const GPT = 'antigravity-gpt-oss-120b'
const FLASH = 'antigravity-gemini-3.8-flash'
const now = 1_800_000_000_000

afterEach(() => {
  _resetAntigravityModelCooldownForTests()
  _resetAntigravityRelayRoutesForTests()
})

describe('model cooldown policy', () => {
  test('two strikes only count; the third cools 1min, doubling to a 10min cap', () => {
    const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
    let s = decideAntigravityModelCooldown(null, false, now)
    assert.deepEqual(s, { strikes: 1, until: 0 })
    s = decideAntigravityModelCooldown(s, false, now)
    assert.deepEqual(s, { strikes: 2, until: 0 })
    s = decideAntigravityModelCooldown(s, false, now)
    assert.deepEqual(s, { strikes: 3, until: now + p.baseMs })
    s = decideAntigravityModelCooldown(s, false, now)
    assert.equal(s?.until, now + 2 * p.baseMs)
    s = decideAntigravityModelCooldown({ strikes: 40, until: 0 }, false, now)
    assert.equal(s?.until, now + p.maxMs)
  })

  test('a success clears the model state', () => {
    assert.equal(decideAntigravityModelCooldown({ strikes: 5, until: now + 1 }, true, now), null)
  })

  test('model_unavailable never changes account health or status', () => {
    assert.equal(
      decideAntigravityInterim(
        { healthScore: 100, backoffLevel: 0, status: 'active' },
        { kind: 'model_unavailable' },
        now,
      ),
      null,
    )
  })
})

describe('model cooldown state', () => {
  test('three GPT-OSS 5xx cool GPT-OSS on that account only', async () => {
    const clock = { now: () => now }
    for (let i = 0; i < 3; i++) await reportAntigravityModelOutcome(1n, GPT, false, clock)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), now + 60_000)
    assert.equal(await antigravityModelCoolingUntil(1n, FLASH, clock), null)
    assert.equal(await antigravityModelCoolingUntil(2n, GPT, clock), null)
    // expired cooldown is usable again (half-open); strikes are still remembered
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, { now: () => now + 60_000 }), null)
    await reportAntigravityModelOutcome(1n, GPT, false, { now: () => now + 60_000 })
    assert.equal(
      await antigravityModelCoolingUntil(1n, GPT, { now: () => now + 60_000 }),
      now + 60_000 + 120_000,
    )
    await reportAntigravityModelOutcome(1n, GPT, true, { now: () => now + 200_000 })
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, { now: () => now + 200_000 }), null)
  })

  test('uses the shared relay KV (master reads what egress wrote) with a TTL', async () => {
    const store = new Map<string, { value: string; ttl: number }>()
    const kv: AntigravityRelayKv = {
      async get(k) {
        return store.get(k)?.value ?? null
      },
      async set(k, value, ttl) {
        store.set(k, { value, ttl })
      },
      async del(k) {
        store.delete(k)
      },
    }
    configureAntigravityRelayKv(kv)
    const clock = { now: () => now }
    for (let i = 0; i < 3; i++) await reportAntigravityModelOutcome(1n, GPT, false, clock)
    const entry = store.get('oc:v5:antigravity-model-cooldown:1:antigravity-gpt-oss-120b')
    assert.ok(entry)
    assert.equal(entry.ttl, (60_000 + ANTIGRAVITY_MODEL_COOLDOWN_POLICY.strikeWindowMs) / 1000)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), now + 60_000)
    await reportAntigravityModelOutcome(1n, GPT, true, clock)
    assert.equal(store.size, 0)
  })
})

function fakePool(rows: Array<{ id: string; email: string }>) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  return {
    queries,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params })
        if (/^\s*SELECT id::text AS id, email/.test(sql)) return { rows }
        if (/SELECT status, health_score/.test(sql)) {
          return {
            rows: [{ status: 'active', health_score: 100, backoff_level: 0, disabled_by: null }],
          }
        }
        return { rows: [] }
      },
    } as never,
  }
}

describe('admission skips accounts whose model is cooling', () => {
  const grantDeps = {
    clientSecret: 'GOCSPX-test-secret-not-real-000',
    mintLimited: (async () => ({
      accessToken: 'limited',
      expiresAt: new Date(now + 3_600_000),
      idToken: null,
    })) as never,
    mintRoute: (async (a: { accountId: bigint }) => ({
      token: `t-${a.accountId}`,
      baseUrl: 'http://relay',
    })) as never,
  }
  const args = (modelId: string) => ({
    containerId: 11,
    userId: 42n,
    requestId: 'd'.repeat(32),
    modelId,
    budgetCredits: 100n,
    relayPort: 18789,
  })

  test('cooling GPT-OSS on account 1 moves GPT-OSS to account 2 and leaves Flash on 1', async () => {
    const { pool } = fakePool([
      { id: '1', email: 'a@example.com' },
      { id: '2', email: 'b@example.com' },
    ])
    const deps = {
      ...grantDeps,
      pick: (d: Parameters<typeof pickAntigravityAccount>[0]) =>
        pickAntigravityAccount({ ...d, pool }),
      modelCoolingUntil: async (id: bigint, model: string) =>
        id === 1n && model === GPT ? now + 60_000 : null,
    }
    assert.equal((await admitAntigravityTurn(args(GPT), deps)).token, 't-2')
    assert.equal((await admitAntigravityTurn(args(FLASH), deps)).token, 't-1')
  })

  test('model cooling on every account fails fast with its own code', async () => {
    const { pool } = fakePool([{ id: '1', email: 'a@example.com' }])
    const deps = {
      ...grantDeps,
      pick: (d: Parameters<typeof pickAntigravityAccount>[0]) =>
        pickAntigravityAccount({ ...d, pool }),
      modelCoolingUntil: async (_id: bigint, model: string) =>
        model === GPT ? now + 60_000 : null,
    }
    await assert.rejects(
      admitAntigravityTurn(args(GPT), deps),
      (err: unknown) =>
        err instanceof AntigravityAdmissionError && err.code === 'ANTIGRAVITY_MODEL_COOLING_DOWN',
    )
    assert.equal((await admitAntigravityTurn(args(FLASH), deps)).token, 't-1')
  })

  test('no account at all is still ANTIGRAVITY_NO_ACCOUNT; a KV error does not block', async () => {
    const empty = fakePool([])
    await assert.rejects(
      admitAntigravityTurn(args(GPT), {
        ...grantDeps,
        pick: (d) => pickAntigravityAccount({ ...d, pool: empty.pool }),
      }),
      (err: unknown) =>
        err instanceof AntigravityAdmissionError && err.code === 'ANTIGRAVITY_NO_ACCOUNT',
    )
    const one = fakePool([{ id: '1', email: 'a@example.com' }])
    const granted = await admitAntigravityTurn(args(GPT), {
      ...grantDeps,
      pick: (d) => pickAntigravityAccount({ ...d, pool: one.pool }),
      modelCoolingUntil: async () => {
        throw new Error('redis down')
      },
    })
    assert.equal(granted.token, 't-1')
  })
})

describe('account row on a model 5xx', () => {
  test('only fail_count/last_error move; health, status and backoff are not written', async () => {
    const { pool, queries } = fakePool([])
    await reportAntigravityOutcome(1n, { kind: 'model_unavailable' }, 'antigravity_http_503', {
      pool,
    })
    const update = queries.find((q) => /^\s*UPDATE/.test(q.sql))
    assert.ok(update)
    assert.match(update.sql, /fail_count = fail_count \+ 1/)
    assert.doesNotMatch(update.sql, /health_score|status =|cooldown_until|backoff_level/)
    assert.deepEqual(update.params, ['1', 'antigravity_http_503'])
  })
})
