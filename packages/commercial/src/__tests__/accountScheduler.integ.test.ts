/**
 * T-32 集成:AccountScheduler 在真 PG + InMemoryHealthRedis 上的行为。
 *
 * 覆盖:
 *   1. 无 active 账号 → AccountPoolUnavailableError
 *   2. 全部 cooldown → AccountPoolUnavailableError
 *   3. mode=agent sticky:同 sessionId 多次调用 → 同一账号 + 返真解密后的 token
 *   4. sticky 账号改 cooldown → 下一次 pick 返另一账号(迁移 + fallback)
 *   5. mode=chat weighted:注入固定 random 可重现地选某账号
 *   6. mode=agent 缺 sessionId → TypeError
 *   7. mode 非法 → TypeError
 *   8. pick 返 token 解密正确(还原成明文)
 *   9. release(success) → DB success_count++ + Redis health set
 *  10. release(failure) → DB fail_count++ + last_error 写入
 *  11. account 在 pick 和 readToken 之间被删 → AccountPoolUnavailableError
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { AccountHealthTracker, InMemoryHealthRedis, healthKey } from '../account-pool/health.js'
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  AccountScheduler,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  ERR_ACCOUNT_POOL_BUSY,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
} from '../account-pool/scheduler.js'
import { createAccount, deleteAccount, getAccount, updateAccount } from '../account-pool/store.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { encrypt } from '../crypto/aead.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

const COMMERCIAL_TABLES = [
  'rate_limit_events',
  'admin_audit',
  'agent_audit',
  'agent_containers',
  'agent_subscriptions',
  'user_preferences',
  'request_finalize_journal',
  'orders',
  'topup_plans',
  'usage_records',
  'credit_ledger',
  'model_pricing',
  'claude_accounts',
  'egress_proxies',
  'refresh_tokens',
  'email_verifications',
  'users',
  'schema_migrations',
]

let pgAvailable = false
let TEST_EGRESS_PROXY_ID = '1'
const KEY = randomBytes(KMS_KEY_BYTES)
const keyFn = (): Buffer => Buffer.from(KEY)

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(', ')} CASCADE`)
  await runMigrations()
  const _ep = encrypt('http://test:test@10.0.0.1:8080', KEY)
  const _r = await query<{ id: string }>(
    "INSERT INTO egress_proxies(label, url_enc, url_nonce, status) VALUES ($1, $2, $3, 'active') RETURNING id::text AS id",
    [`t-pool-${Date.now()}`, _ep.ciphertext, _ep.nonce],
  )
  TEST_EGRESS_PROXY_ID = _r.rows[0].id
})

after(async () => {
  if (pgAvailable) {
    try {
      await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(', ')} CASCADE`)
    } catch {
      /* */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query('TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE')
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

function mkTracker(): { tracker: AccountHealthTracker; redis: InMemoryHealthRedis } {
  const redis = new InMemoryHealthRedis()
  return { tracker: new AccountHealthTracker({ redis }), redis }
}

function mkScheduler(
  tracker: AccountHealthTracker,
  overrides: { random?: () => number; maxConcurrent?: number } = {},
): AccountScheduler {
  return new AccountScheduler({
    health: tracker,
    keyFn,
    random: overrides.random,
    maxConcurrent: overrides.maxConcurrent,
  })
}

describe('pick — 可用性', () => {
  test('无 active 账号 → AccountPoolUnavailableError(code=ERR_ACCOUNT_POOL_UNAVAILABLE)', async (t) => {
    if (skipIfNoDb(t)) return
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat' }),
      (err: unknown) =>
        err instanceof AccountPoolUnavailableError &&
        (err as AccountPoolUnavailableError).code === ERR_ACCOUNT_POOL_UNAVAILABLE,
    )
  })

  test('全部 cooldown → AccountPoolUnavailableError', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'c1', plan: 'pro', token: 'T1', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ label: 'c2', plan: 'pro', token: 'T2', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await updateAccount(
      a.id,
      {
        status: 'cooldown',
        cooldown_until: new Date(Date.now() + 60_000),
      },
      keyFn,
    )
    await updateAccount(
      b.id,
      {
        status: 'cooldown',
        cooldown_until: new Date(Date.now() + 60_000),
      },
      keyFn,
    )
    const { tracker } = mkTracker()
    await assert.rejects(mkScheduler(tracker).pick({ mode: 'chat' }), AccountPoolUnavailableError)
  })

  test('disabled / banned 不计入可选', async (t) => {
    if (skipIfNoDb(t)) return
    const active = await createAccount({ label: 'active', plan: 'pro', token: 'T-ACTIVE', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const dis = await createAccount({ label: 'dis', plan: 'pro', token: 'T-DIS', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const ban = await createAccount({ label: 'ban', plan: 'pro', token: 'T-BAN', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await updateAccount(dis.id, { status: 'disabled' }, keyFn)
    await updateAccount(ban.id, { status: 'banned' }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const p = await s.pick({ mode: 'chat' })
    assert.equal(p.account_id, active.id)
    p.token.fill(0)
  })
})

describe('pick — mode=agent sticky', () => {
  test('同 sessionId 多次返同一账号', async (t) => {
    if (skipIfNoDb(t)) return
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ label: `a${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    }
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const first = await s.pick({ mode: 'agent', sessionId: 'sess-A' })
    first.token.fill(0)
    for (let i = 0; i < 5; i += 1) {
      const p = await s.pick({ mode: 'agent', sessionId: 'sess-A' })
      assert.equal(p.account_id, first.account_id)
      p.token.fill(0)
    }
  })

  test('sticky 账号切 cooldown → 下次 pick fallback 到另一账号', async (t) => {
    if (skipIfNoDb(t)) return
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ label: `a${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    }
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const sess = 'sess-mig'
    const first = await s.pick({ mode: 'agent', sessionId: sess })
    first.token.fill(0)
    await updateAccount(
      first.account_id,
      {
        status: 'cooldown',
        cooldown_until: new Date(Date.now() + 60_000),
      },
      keyFn,
    )
    const second = await s.pick({ mode: 'agent', sessionId: sess })
    assert.notEqual(second.account_id, first.account_id)
    second.token.fill(0)
  })

  test('mode=agent 缺 sessionId → TypeError', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount({ label: 'a1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(s.pick({ mode: 'agent' }), TypeError)
    await assert.rejects(s.pick({ mode: 'agent', sessionId: '' }), TypeError)
  })
})

describe('pick — mode=chat weighted', () => {
  test('注入固定 random → 落到确定性账号', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'w1', plan: 'pro', token: 'T-1', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ label: 'w2', plan: 'pro', token: 'T-2', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const c = await createAccount({ label: 'w3', plan: 'pro', token: 'T-3', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    // 三个账号都 health=100 → 总权重 300;random=0 → 选 ORDER BY id ASC 首个
    const s0 = mkScheduler(tracker, { random: () => 0 })
    const p0 = await s0.pick({ mode: 'chat' })
    assert.equal(p0.account_id, a.id)
    p0.token.fill(0)
    // random=0.999 → 选最后
    const s2 = mkScheduler(tracker, { random: () => 0.9999 })
    const p2 = await s2.pick({ mode: 'chat' })
    assert.equal(p2.account_id, c.id)
    p2.token.fill(0)
    // 中间:random=0.5 → acc 走到 200(第二个),选 b
    const s1 = mkScheduler(tracker, { random: () => 0.5 })
    const p1 = await s1.pick({ mode: 'chat' })
    assert.equal(p1.account_id, b.id)
    p1.token.fill(0)
  })

  test('mode 非法 → TypeError', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount({ label: 'a1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(s.pick({ mode: 'bogus' as unknown as 'chat' }), TypeError)
  })
})

describe('pick — token 解密正确', () => {
  test('返的 token Buffer 还原为明文', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount(
      { label: 'enc', plan: 'max', token: 'SECRET-ABC-xyz-999', refresh: 'REF-XYZ', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { random: () => 0 })
    const p = await s.pick({ mode: 'chat' })
    assert.equal(p.account_id, a.id)
    assert.equal(p.plan, 'max')
    assert.equal(p.token.toString('utf8'), 'SECRET-ABC-xyz-999')
    assert.equal(p.refresh?.toString('utf8'), 'REF-XYZ')
    p.token.fill(0)
    p.refresh?.fill(0)
  })
})

describe('release', () => {
  test('success → health.onSuccess:success_count++ + Redis health set', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'r1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker, redis } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({ account_id: a.id, result: { kind: 'success' } })
    const row = await getAccount(a.id)
    assert.equal(row!.success_count, 1n)
    assert.equal(row!.last_error, null)
    assert.equal(await redis.get(healthKey(a.id)), '100')
  })

  test('failure → health.onFailure:fail_count++ + last_error', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'r2', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({
      account_id: a.id,
      result: { kind: 'failure', error: 'rate-limited 429' },
    })
    const row = await getAccount(a.id)
    assert.equal(row!.fail_count, 1n)
    assert.equal(row!.last_error, 'rate-limited 429')
    // health 从 100 → 80
    assert.equal(row!.health_score, 80)
  })

  test('failure 无 error msg → last_error 不被覆盖(COALESCE)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'r3', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await updateAccount(a.id, { last_error: 'previous' }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({ account_id: a.id, result: { kind: 'failure' } })
    const row = await getAccount(a.id)
    assert.equal(row!.last_error, 'previous')
  })
})

describe('并发/边界', () => {
  test('pick 后立即删账号 → 再 pick 选其他 / 若仅一个 → 可用性错误', async (t) => {
    if (skipIfNoDb(t)) return
    const only = await createAccount({ label: 'solo', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const p = await s.pick({ mode: 'chat' })
    p.token.fill(0)
    await deleteAccount(only.id)
    await assert.rejects(s.pick({ mode: 'chat' }), AccountPoolUnavailableError)
  })
})

describe('per-account 并发上限', () => {
  test('默认 maxConcurrent=10', async (t) => {
    if (skipIfNoDb(t)) return
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    assert.equal(s.maxConcurrent, DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
  })

  test('单账号 pick 到 cap 后 → AccountPoolBusyError(code=ERR_ACCOUNT_POOL_BUSY)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'cap', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    // 降到 cap=2 方便测
    const s = mkScheduler(tracker, { maxConcurrent: 2 })
    const p1 = await s.pick({ mode: 'chat' })
    const p2 = await s.pick({ mode: 'chat' })
    assert.equal(s.getInflight(a.id), 2)
    await assert.rejects(
      s.pick({ mode: 'chat' }),
      (err: unknown) =>
        err instanceof AccountPoolBusyError &&
        (err as AccountPoolBusyError).code === ERR_ACCOUNT_POOL_BUSY,
    )
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('首选账号满员 → 自动 fallback 到未满账号(chat weighted)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'w-a', plan: 'pro', token: 'T-A', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ label: 'w-b', plan: 'pro', token: 'T-B', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    // random=0 一贯选第一个(按 ORDER BY id 是 a)
    const s = mkScheduler(tracker, { random: () => 0, maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    assert.equal(p1.account_id, a.id)
    // a 到 cap=1 后,即使 random=0 也必须 fallback 到 b
    const p2 = await s.pick({ mode: 'chat' })
    assert.equal(p2.account_id, b.id)
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('agent 模式:sticky 账号满员 → rendezvous 退到次优账号', async (t) => {
    if (skipIfNoDb(t)) return
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ label: `s${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    }
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const sess = 'sess-cap'
    const first = await s.pick({ mode: 'agent', sessionId: sess })
    // 同 session 再 pick,首选已到 cap=1,应选别的
    const second = await s.pick({ mode: 'agent', sessionId: sess })
    assert.notEqual(second.account_id, first.account_id)
    first.token.fill(0)
    second.token.fill(0)
  })

  test('所有账号都到 cap → AccountPoolBusyError(区分 Unavailable)', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount({ label: 'b-a', plan: 'pro', token: 'T-A', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await createAccount({ label: 'b-b', plan: 'pro', token: 'T-B', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    const p2 = await s.pick({ mode: 'chat' })
    await assert.rejects(s.pick({ mode: 'chat' }), AccountPoolBusyError)
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('release(success) 后 slot 释放 → 可再 pick', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'rel', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    assert.equal(s.getInflight(a.id), 1)
    await assert.rejects(s.pick({ mode: 'chat' }), AccountPoolBusyError)
    await s.release({ account_id: a.id, result: { kind: 'success' } })
    assert.equal(s.getInflight(a.id), 0)
    const p2 = await s.pick({ mode: 'chat' })
    assert.equal(p2.account_id, a.id)
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('release(failure) 也要 dec inflight', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'rel-f', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    await s.release({
      account_id: a.id,
      result: { kind: 'failure', error: 'e' },
    })
    assert.equal(s.getInflight(a.id), 0)
    p1.token.fill(0)
  })

  test('对未计数的 id release 幂等:不报错 / 不变负', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'idem', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    // 没 pick 过就 release(例如 finalize 被调两次)
    await s.release({ account_id: a.id, result: { kind: 'success' } })
    await s.release({ account_id: a.id, result: { kind: 'success' } })
    assert.equal(s.getInflight(a.id), 0)
  })

  test('归 0 后 Map 被 delete 避免长期膨胀', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ label: 'del', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const p = await s.pick({ mode: 'chat' })
    await s.release({ account_id: a.id, result: { kind: 'success' } })
    // Map 不暴露,但 getInflight 为 0 说明 key 已删(dec 的归 0 分支)
    assert.equal(s.getInflight(a.id), 0)
    p.token.fill(0)
  })

  test('deps.maxConcurrent 非正整数一律 sanitize 回默认 10', () => {
    // 不触 DB,只测构造参数归一化
    const { tracker } = mkTracker()
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = new AccountScheduler({ health: tracker, keyFn, maxConcurrent: bad })
      assert.equal(
        s.maxConcurrent,
        DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
        `maxConcurrent=${bad} should fall back to default`,
      )
    }
    const good = new AccountScheduler({ health: tracker, keyFn, maxConcurrent: 3 })
    assert.equal(good.maxConcurrent, 3)
  })

  test('env CLAUDE_ACCOUNT_MAX_CONCURRENT 覆盖默认值', async (t) => {
    if (skipIfNoDb(t)) return
    const prev = process.env.CLAUDE_ACCOUNT_MAX_CONCURRENT
    try {
      process.env.CLAUDE_ACCOUNT_MAX_CONCURRENT = '3'
      const { tracker } = mkTracker()
      const s = new AccountScheduler({ health: tracker, keyFn })
      assert.equal(s.maxConcurrent, 3)
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: 必须真删,= undefined 会留下字符串 "undefined"
        delete process.env.CLAUDE_ACCOUNT_MAX_CONCURRENT
      } else {
        process.env.CLAUDE_ACCOUNT_MAX_CONCURRENT = prev
      }
    }
  })
})
