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
  antigravityModelCooldownMs,
  antigravityModelCoolingUntil,
  configureAntigravityModelCooldownStore,
  createIoredisAntigravityModelCooldownStore,
  reportAntigravityModelOutcome,
} from '../account-pool/antigravityModelCooldown.js'
import { pickAntigravityAccount, reportAntigravityOutcome } from '../account-pool/antigravityPool.js'

const GPT = 'antigravity-gpt-oss-120b'
const FLASH = 'antigravity-gemini-3.8-flash'
const now = 1_800_000_000_000
let clockNow = now
const clock = { now: () => clockNow }

afterEach(() => {
  clockNow = now
  _resetAntigravityModelCooldownForTests(() => clockNow)
})

describe('model cooldown policy', () => {
  test('two strikes only count; the third cools 1min, doubling to a 10min cap', () => {
    const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
    assert.equal(antigravityModelCooldownMs(1), 0)
    assert.equal(antigravityModelCooldownMs(2), 0)
    assert.equal(antigravityModelCooldownMs(3), p.baseMs)
    assert.equal(antigravityModelCooldownMs(4), 2 * p.baseMs)
    assert.equal(antigravityModelCooldownMs(40), p.maxMs)
  })

})

describe('model cooldown state', () => {
  test('three GPT-OSS 5xx cool GPT-OSS on that account only', async () => {
    _resetAntigravityModelCooldownForTests(() => clockNow)
    for (let i = 0; i < 3; i++) await reportAntigravityModelOutcome(1n, GPT, false, clock)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), now + 60_000)
    assert.equal(await antigravityModelCoolingUntil(1n, FLASH, clock), null)
    assert.equal(await antigravityModelCoolingUntil(2n, GPT, clock), null)
    // expired cooldown is usable again (half-open); strikes are still remembered
    clockNow = now + 60_000
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), null)
    await reportAntigravityModelOutcome(1n, GPT, false, clock)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), clockNow + 120_000)
    await reportAntigravityModelOutcome(1n, GPT, true, clock)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), null)
  })

  test('concurrent failures are all counted (Codex r1 P1)', async () => {
    _resetAntigravityModelCooldownForTests(() => clockNow)
    await Promise.all([1, 2, 3].map(() => reportAntigravityModelOutcome(1n, GPT, false, clock)))
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), now + 60_000)
  })

  test('Redis store: INCR+PEXPIRE in one MULTI, cooldown key with PX TTL', async () => {
    const data = new Map<string, string>()
    const ttl = new Map<string, number>()
    const client = {
      multi() {
        const ops: Array<() => [Error | null, unknown]> = []
        const tx = {
          incr(k: string) {
            ops.push(() => {
              const n = Number(data.get(k) ?? '0') + 1
              data.set(k, String(n))
              return [null, n]
            })
            return tx
          },
          pexpire(k: string, ms: number) {
            ops.push(() => {
              ttl.set(k, ms)
              return [null, 1]
            })
            return tx
          },
          async exec() {
            return ops.map((op) => op())
          },
        }
        return tx
      },
      async get(k: string) {
        return data.get(k) ?? null
      },
      async set(k: string, v: string, _mode: 'PX', ms: number) {
        data.set(k, v)
        ttl.set(k, ms)
        return 'OK'
      },
      async del(...keys: string[]) {
        for (const k of keys) data.delete(k)
        return keys.length
      },
    }
    configureAntigravityModelCooldownStore(createIoredisAntigravityModelCooldownStore(client))
    await Promise.all([1, 2, 3].map(() => reportAntigravityModelOutcome(1n, GPT, false, clock)))
    const k = 'oc:v5:antigravity-model-cooldown:1:antigravity-gpt-oss-120b'
    const p = ANTIGRAVITY_MODEL_COOLDOWN_POLICY
    assert.equal(data.get(`${k}:strikes`), '3')
    assert.equal(ttl.get(`${k}:strikes`), p.maxMs + p.strikeWindowMs)
    assert.equal(data.get(`${k}:until`), String(now + 60_000))
    assert.equal(ttl.get(`${k}:until`), 60_000)
    assert.equal(await antigravityModelCoolingUntil(1n, GPT, clock), now + 60_000)
    await reportAntigravityModelOutcome(1n, GPT, true, clock)
    assert.equal(data.size, 0)
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

  test('a usable account past the first 20 is still found (Codex r1 P1)', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1), email: `${i}@x` }))
    const { pool, queries } = fakePool(rows)
    const granted = await admitAntigravityTurn(args(GPT), {
      ...grantDeps,
      pick: (d) => pickAntigravityAccount({ ...d, pool }),
      modelCoolingUntil: async (id: bigint) => (id <= 20n ? now + 60_000 : null),
    })
    assert.equal(granted.token, 't-21')
    assert.doesNotMatch(queries[0]?.sql ?? '', /LIMIT/)
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
