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
  SessionPinUnboundError,
  SessionPinTemporarilyUnavailableError,
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
  overrides: {
    ephemeralKey?: () => string
    maxConcurrent?: number
    hash?: (s: string) => bigint
  } = {},
): AccountScheduler {
  return new AccountScheduler({
    health: tracker,
    keyFn,
    ephemeralKey: overrides.ephemeralKey,
    hash: overrides.hash,
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
    const a = await createAccount({ runtime_channel: 'v3', label: 'c1', plan: 'pro', token: 'T1', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ runtime_channel: 'v3', label: 'c2', plan: 'pro', token: 'T2', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
    const active = await createAccount({ runtime_channel: 'v3', label: 'active', plan: 'pro', token: 'T-ACTIVE', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const dis = await createAccount({ runtime_channel: 'v3', label: 'dis', plan: 'pro', token: 'T-DIS', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const ban = await createAccount({ runtime_channel: 'v3', label: 'ban', plan: 'pro', token: 'T-BAN', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
      await createAccount({ runtime_channel: 'v3', label: `a${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
      await createAccount({ runtime_channel: 'v3', label: `a${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
    await createAccount({ runtime_channel: 'v3', label: 'a1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(s.pick({ mode: 'agent' }), TypeError)
    await assert.rejects(s.pick({ mode: 'agent', sessionId: '' }), TypeError)
  })
})

describe('pick — mode=chat WRH', () => {
  test('注入 hash → 让 id 最大的 candidate u≈1 → score 最小 → 必选它', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'w1', plan: 'pro', token: 'T-1', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ runtime_channel: 'v3', label: 'w2', plan: 'pro', token: 'T-2', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const c = await createAccount({ runtime_channel: 'v3', label: 'w3', plan: 'pro', token: 'T-3', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    // 让 b 的 hash 极大(u 接近 1 → -ln(u) ≈ 0 → score 最小)
    const hashFavor = (id: bigint): ((s: string) => bigint) => {
      return (s) => (s.endsWith(`:${id}`) ? (1n << 64n) - 1n : 1n)
    }
    const sa = mkScheduler(tracker, { hash: hashFavor(a.id), ephemeralKey: () => 'k' })
    const pa = await sa.pick({ mode: 'chat' })
    assert.equal(pa.account_id, a.id)
    pa.token.fill(0)
    const sb = mkScheduler(tracker, { hash: hashFavor(b.id), ephemeralKey: () => 'k' })
    const pb = await sb.pick({ mode: 'chat' })
    assert.equal(pb.account_id, b.id)
    pb.token.fill(0)
    const sc = mkScheduler(tracker, { hash: hashFavor(c.id), ephemeralKey: () => 'k' })
    const pc = await sc.pick({ mode: 'chat' })
    assert.equal(pc.account_id, c.id)
    pc.token.fill(0)
  })

  test('mode 非法 → TypeError', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount({ runtime_channel: 'v3', label: 'a1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(s.pick({ mode: 'bogus' as unknown as 'chat' }), TypeError)
  })
})

describe('pick — token 解密正确', () => {
  test('返的 token Buffer 还原为明文', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'enc', plan: 'max', token: 'SECRET-ABC-xyz-999', refresh: 'REF-XYZ', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const { tracker } = mkTracker()
    // 只有一个账号 — 不需要控制选号,WRH 唯一候选必选
    const s = mkScheduler(tracker)
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
    const a = await createAccount({ runtime_channel: 'v3', label: 'r1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker, redis } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({ account_id: a.id, slotId: 'slot-x', result: { kind: 'success' } })
    const row = await getAccount(a.id)
    assert.equal(row!.success_count, 1n)
    assert.equal(row!.last_error, null)
    assert.equal(await redis.get(healthKey(a.id)), '100')
  })

  test('failure → health.onFailure:fail_count++ + last_error', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'r2', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({
      account_id: a.id,
      slotId: 'slot-x',
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
    const a = await createAccount({ runtime_channel: 'v3', label: 'r3', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await updateAccount(a.id, { last_error: 'previous' }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await s.release({ account_id: a.id, slotId: 'slot-x', result: { kind: 'failure' } })
    const row = await getAccount(a.id)
    assert.equal(row!.last_error, 'previous')
  })

  test('client_error → 不扣健康分,不增 fail_count(类比 transient_network)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'r4', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const { tracker, redis } = mkTracker()
    const s = mkScheduler(tracker)
    // 先 pick 占 inflight,再 release 验 dec 路径
    const p = await s.pick({ mode: 'chat' })
    assert.equal(s.getInflight(a.id), 1)
    p.token.fill(0)
    await s.release({
      account_id: a.id,
      slotId: p.slotId,
      result: { kind: 'client_error', error: 'invalid_request_error: thinking signature' },
    })
    const row = await getAccount(a.id)
    // health 不变(默认 100),fail_count 不增
    assert.equal(row!.fail_count, 0n)
    assert.equal(row!.success_count, 0n)
    assert.equal(row!.health_score, 100)
    assert.equal(row!.last_error, null)
    // inflight slot 被 dec
    assert.equal(s.getInflight(a.id), 0)
    // Redis health 也没被改写到 onFailure 路径
    assert.equal(await redis.get(healthKey(a.id)), null)
  })
})

describe('并发/边界', () => {
  test('pick 后立即删账号 → 再 pick 选其他 / 若仅一个 → 可用性错误', async (t) => {
    if (skipIfNoDb(t)) return
    const only = await createAccount({ runtime_channel: 'v3', label: 'solo', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
    const a = await createAccount({ runtime_channel: 'v3', label: 'cap', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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

  test('首选账号满员 → 自动 fallback 到未满账号(chat WRH)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'w-a', plan: 'pro', token: 'T-A', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const b = await createAccount({ runtime_channel: 'v3', label: 'w-b', plan: 'pro', token: 'T-B', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    // 注入 hash 让 a 必胜(u≈1 → score 最小)
    const hashFavorA = (s: string): bigint => (s.endsWith(`:${a.id}`) ? (1n << 64n) - 1n : 1n)
    const s = mkScheduler(tracker, {
      hash: hashFavorA,
      ephemeralKey: () => 'k',
      maxConcurrent: 1,
    })
    const p1 = await s.pick({ mode: 'chat' })
    assert.equal(p1.account_id, a.id)
    // a 到 cap=1 后必须 fallback 到 b
    const p2 = await s.pick({ mode: 'chat' })
    assert.equal(p2.account_id, b.id)
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('agent 模式:sticky 账号满员 → rendezvous 退到次优账号', async (t) => {
    if (skipIfNoDb(t)) return
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ runtime_channel: 'v3', label: `s${i}`, plan: 'pro', token: `T${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
    await createAccount({ runtime_channel: 'v3', label: 'b-a', plan: 'pro', token: 'T-A', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await createAccount({ runtime_channel: 'v3', label: 'b-b', plan: 'pro', token: 'T-B', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
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
    const a = await createAccount({ runtime_channel: 'v3', label: 'rel', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    assert.equal(s.getInflight(a.id), 1)
    await assert.rejects(s.pick({ mode: 'chat' }), AccountPoolBusyError)
    await s.release({ account_id: a.id, slotId: p1.slotId, result: { kind: 'success' } })
    assert.equal(s.getInflight(a.id), 0)
    const p2 = await s.pick({ mode: 'chat' })
    assert.equal(p2.account_id, a.id)
    p1.token.fill(0)
    p2.token.fill(0)
  })

  test('release(failure) 也要 dec inflight', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'rel-f', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker, { maxConcurrent: 1 })
    const p1 = await s.pick({ mode: 'chat' })
    await s.release({
      account_id: a.id,
      slotId: p1.slotId,
      result: { kind: 'failure', error: 'e' },
    })
    assert.equal(s.getInflight(a.id), 0)
    p1.token.fill(0)
  })

  test('对未计数的 id release 幂等:不报错 / 不变负', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'idem', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    // 没 pick 过就 release(例如 finalize 被调两次)— 未知 slotId 还槽是幂等 no-op
    await s.release({ account_id: a.id, slotId: 'slot-x', result: { kind: 'success' } })
    await s.release({ account_id: a.id, slotId: 'slot-x', result: { kind: 'success' } })
    assert.equal(s.getInflight(a.id), 0)
  })

  test('归 0 后 Map 被 delete 避免长期膨胀', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount({ runtime_channel: 'v3', label: 'del', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const p = await s.pick({ mode: 'chat' })
    await s.release({ account_id: a.id, slotId: p.slotId, result: { kind: 'success' } })
    // Map 不暴露,但 getInflight 为 0 说明 key 已删(归 0 分支)
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

// ─── v3 反关联根治 0072 — pick() pin 三态(off / observe / enforce)──────────
//
// 覆盖 scheduler.pick 在引入 chat_session_account_pin 后的全部新行为:
//   - pin enforce + pin active 命中 → 强 sticky
//   - pin enforce + pin active 不在 pool → SessionPinTemporarilyUnavailableError(503)
//   - pin enforce + pin unbound → SessionPinUnboundError(409)
//   - pin enforce + pin miss + 反扩散候选缩窄(只在 history ∩ pool 选)
//   - pin enforce + pin miss + 反扩散全死退化全池
//   - pin enforce + pin miss → race-safe INSERT 落 active 行
//   - pin observe → 不写 csap、不抛(metric only)
//   - 缺 userId/sessionId pin enforce → 自动降级 off 不抛
//   - cascade unbind 在 store.updateAccount(status='banned') 时同事务触发

let TEST_USER_ID_COUNTER = 1000

async function mkUser(label = 'pin'): Promise<bigint> {
  TEST_USER_ID_COUNTER += 1
  const u = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, email_verified, status)
     VALUES($1, 'stub', 0, true, 'active') RETURNING id::text AS id`,
    [`pin-${label}-${TEST_USER_ID_COUNTER}-${Date.now()}@example.com`],
  )
  return BigInt(u.rows[0].id)
}

async function readPinRow(
  userId: bigint,
  sessionId: string,
): Promise<{ account_id: string; status: string } | null> {
  const r = await query<{ account_id: string; status: string }>(
    `SELECT account_id::text AS account_id, status
       FROM chat_session_account_pin
      WHERE user_id = $1 AND session_id = $2`,
    [userId, sessionId],
  )
  return r.rows[0] ?? null
}

describe('pick — pin enforce mode', () => {
  test('pin active 命中 active pool → 强 sticky 返回该 account_id(绕过 WRH)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('hit')
    // 两个 account,加 inflight 让 WRH 倾向其中一个,但 pin 钉到另一个
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'pin-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'pin-B', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-pin-hit-${Date.now()}`
    // 预先在 csap 落一行钉到 b
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, b.id.toString()],
    )

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
    })
    assert.equal(r.account_id, BigInt(b.id), '应当强 sticky 到 pin 指定的 account=b,即使 WRH 会选 a')
    r.token.fill(0)
    r.refresh?.fill(0)
    // sanity:csap 行不变(无重复 INSERT 或重新 active)
    const pin = await readPinRow(uid, sid)
    assert.equal(pin?.account_id, b.id.toString())
    assert.equal(pin?.status, 'active')
    // cleanup
    a // suppress unused
  })

  test('pin active 指向 banned account(不在 active pool)→ SessionPinTemporarilyUnavailableError', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('vanish')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'pin-vanish-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    // 再造一个 banned account 钉过去(注意:不能 INSERT csap 指向 banned —
    // cascade unbind 会把 csap.status 翻成 unbound。所以先 INSERT csap active,再 ban,
    // 验证 cascade。再造一个绕开 cascade 路径的 case)
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'pin-vanish-B', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-pin-vanish-${Date.now()}`
    // 直接把 b 改成 cooldown(不走 banned cascade,csap 保持 active),再让 pin 指向 b
    await updateAccount(
      b.id,
      { status: 'cooldown', cooldown_until: new Date(Date.now() + 60_000) },
      keyFn,
    )
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, b.id.toString()],
    )

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }),
      (err) => err instanceof SessionPinTemporarilyUnavailableError,
    )
    a // suppress unused
  })

  test('pin unbound → SessionPinUnboundError(终态,前端 reset)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('unbound')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'pin-unbound', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-pin-unbound-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }),
      (err) => err instanceof SessionPinUnboundError,
    )
  })

  test('pin miss + race-safe INSERT:首次 pick 在 csap 落新 active 行', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('insert')
    await createAccount(
      { runtime_channel: 'v3', label: 'pin-insert', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-pin-insert-${Date.now()}`
    const before = await readPinRow(uid, sid)
    assert.equal(before, null, 'precondition: csap 没有行')

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
    })
    r.token.fill(0)
    r.refresh?.fill(0)

    const after = await readPinRow(uid, sid)
    assert.ok(after, 'csap 必须落新行')
    assert.equal(after?.status, 'active')
    assert.equal(after?.account_id, r.account_id.toString(), 'csap 写入的 account 必须等于实际返回的')
  })

  test('反扩散:history ∩ pool 非空时,WRH 只在 history 子集里选', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('antispread')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'as-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'as-B', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const c = await createAccount(
      { runtime_channel: 'v3', label: 'as-C', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    // 用户既往足迹只有 a 和 b(两个 _其他_ session 都接触过 a/b);c 是用户从未碰过的干净账号
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, 'old-sess-1', $2, 'unbound'),
              ($1, 'old-sess-2', $3, 'active')`,
      [uid, a.id.toString(), b.id.toString()],
    )
    // 但当前 pick 用的是新 session,pin miss
    const sid = `sess-antispread-${Date.now()}`

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    // 重复 pick 多次(不同 wrh key 也不会跳出 history 子集 — 因为候选池本身就被缩窄了)
    const seen = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      const sidI = `${sid}-${i}`
      const r = await s.pick({
        mode: 'chat',
        sessionId: sidI,
        userId: uid,
        pinMode: 'enforce',
      })
      seen.add(r.account_id.toString())
      r.token.fill(0)
      r.refresh?.fill(0)
    }
    // 必须永远在 {a, b} 中,绝不应选到 c
    assert.ok(!seen.has(c.id.toString()), '反扩散:c 是用户从未碰过的账号,enforce + pin miss 时不应被选')
    for (const id of seen) {
      assert.ok([a.id.toString(), b.id.toString()].includes(id))
    }
  })

  test('反扩散退化:既往足迹账号全死 → 退化到全池(用户不卡死)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('antispread-degen')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'asd-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const c = await createAccount(
      { runtime_channel: 'v3', label: 'asd-C', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    // history = {a},但 a 是 cooldown(不在 active pool)
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, 'old-degen-1', $2, 'unbound')`,
      [uid, a.id.toString()],
    )
    await updateAccount(
      a.id,
      { status: 'cooldown', cooldown_until: new Date(Date.now() + 60_000) },
      keyFn,
    )
    // 此时 pool = {c},history ∩ pool = ∅ → 必须退化全池,选 c
    const sid = `sess-degen-${Date.now()}`
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
    })
    assert.equal(r.account_id, BigInt(c.id), '退化全池后必须选到唯一 active 账号 c')
    r.token.fill(0)
    r.refresh?.fill(0)
  })
})

describe('pick — pin observe mode', () => {
  test('observe → 不写 csap(选号同 off 路径)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('observe')
    await createAccount(
      { runtime_channel: 'v3', label: 'obs-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-observe-${Date.now()}`
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'observe',
    })
    r.token.fill(0)
    r.refresh?.fill(0)
    const pin = await readPinRow(uid, sid)
    assert.equal(pin, null, 'observe 模式不应写 csap')
  })
})

describe('pick — pin off / 降级', () => {
  test('off (default) + 有 csap 行也不读不写', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('off')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'off-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-off-${Date.now()}`
    // 即使 csap 有 unbound 行,off 模式也不应抛 SessionPinUnbound
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({ mode: 'chat', sessionId: sid, userId: uid })
    r.token.fill(0)
    r.refresh?.fill(0)
  })

  test('enforce 缺 userId → 自动降级 off + 不抛(灰度期兼容旧 caller)', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount(
      { runtime_channel: 'v3', label: 'degr-noUid', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    // 缺 userId,pinMode=enforce 应当 silent-degrade,正常返回
    const r = await s.pick({
      mode: 'chat',
      sessionId: `sess-noUid-${Date.now()}`,
      pinMode: 'enforce',
    })
    r.token.fill(0)
    r.refresh?.fill(0)
  })

  test('enforce 缺 sessionId → 自动降级 off + 不抛', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('noSid')
    await createAccount(
      { runtime_channel: 'v3', label: 'degr-noSid', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({ mode: 'chat', userId: uid, pinMode: 'enforce' })
    r.token.fill(0)
    r.refresh?.fill(0)
  })
})

describe('updateAccount — cascade csap unbind', () => {
  test('status=banned → 同事务 UPDATE csap SET status=unbound', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('cascade-banned')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'casc-banned', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid1 = `casc-${Date.now()}-1`
    const sid2 = `casc-${Date.now()}-2`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active'), ($1, $4, $3, 'active')`,
      [uid, sid1, a.id.toString(), sid2],
    )

    await updateAccount(a.id, { status: 'banned' }, keyFn)

    const p1 = await readPinRow(uid, sid1)
    const p2 = await readPinRow(uid, sid2)
    assert.equal(p1?.status, 'unbound', 'sid1 应当被 cascade 翻成 unbound')
    assert.equal(p2?.status, 'unbound', 'sid2 应当被 cascade 翻成 unbound')
  })

  test('status=disabled → cascade unbind 同样触发', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('cascade-disabled')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'casc-disabled', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `casc-dis-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, a.id.toString()],
    )

    await updateAccount(a.id, { status: 'disabled' }, keyFn)

    const p = await readPinRow(uid, sid)
    assert.equal(p?.status, 'unbound')
  })

  test('status=cooldown(非 banned/disabled)→ csap 不变(只对终态级联)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('cascade-cooldown')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'casc-cool', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `casc-cool-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, a.id.toString()],
    )

    await updateAccount(
      a.id,
      { status: 'cooldown', cooldown_until: new Date(Date.now() + 60_000) },
      keyFn,
    )

    const p = await readPinRow(uid, sid)
    assert.equal(p?.status, 'active', 'cooldown 是临时态,csap 不应翻 unbound')
  })

  test('已是 unbound 的 csap 行不被重复触发(idempotent)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('cascade-idem')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'casc-idem', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `casc-idem-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )
    // 抓 updated_at 时间戳,然后 ban,验证 updated_at 没有被刷新
    const t0 = await query<{ updated_at: string }>(
      `SELECT updated_at::text FROM chat_session_account_pin
       WHERE user_id = $1 AND session_id = $2`,
      [uid, sid],
    )
    await updateAccount(a.id, { status: 'banned' }, keyFn)
    const t1 = await query<{ updated_at: string }>(
      `SELECT updated_at::text FROM chat_session_account_pin
       WHERE user_id = $1 AND session_id = $2`,
      [uid, sid],
    )
    assert.equal(t0.rows[0].updated_at, t1.rows[0].updated_at,
      'unbound 行不应被 cascade 重复 UPDATE(WHERE status=active 过滤)')
  })
})

// ─── v3 反关联根治 UX 闭环 — force_repin + 503 retry budget ─────────────────────
//
// 覆盖 pick() facade 新增控制流:
//   - SessionPinTemporarilyUnavailableError 带 retryAfterMs
//   - SessionPinUnboundError 带 retryStrategy='force_repin'
//   - forceRepin=true 在 unbound 之上覆盖回 active(保留 sessionId)
//   - forceRepin=true 在没有 csap 行时落新 active
//   - forceRepin=true 撞到已 active 的并发 race → 切到 winner
//   - terminal 账号 + pin active 未 cascade 的 race → self-heal + 抛 unbound
//   - 长 cooldown 透过 503 给客户端(retryAfterMs > SHORT_BACKOFF)

describe('pick — UX 闭环:retryAfterMs + retry_strategy', () => {
  test('pin active 指向 cooldown account → SessionPinTemporarilyUnavailableError(retryAfterMs > 0)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('retryafter-cool')
    await createAccount(
      { runtime_channel: 'v3', label: 'ra-pool', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'ra-cool', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-ra-${Date.now()}`
    // cooldown 30s — 远超 SHORT_BACKOFF_MS=3000,pick() facade 必抛 503 给客户端
    const cooldownDeadline = new Date(Date.now() + 30_000)
    await updateAccount(b.id, { status: 'cooldown', cooldown_until: cooldownDeadline }, keyFn)
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, b.id.toString()],
    )

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }),
      (err) => {
        if (!(err instanceof SessionPinTemporarilyUnavailableError)) return false
        // retryAfterMs 应当接近 30s(允许 ±2s 漂移涵盖 pickOnce 跑完 + DB 往返)
        const ms = err.retryAfterMs
        assert.ok(ms > 25_000 && ms <= 30_000, `retryAfterMs 应当 ~30s,实际 ${ms}`)
        assert.equal(err.fallbackStrategy, 'force_repin_after_retry')
        return true
      },
    )
  })

  test('SessionPinUnboundError 带 retryStrategy="force_repin"(给客户端续 session 用)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('unbound-retry-strategy')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'urs-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-urs-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }),
      (err) => {
        if (!(err instanceof SessionPinUnboundError)) return false
        assert.equal(err.retryStrategy, 'force_repin')
        assert.equal(err.action, 'reset_session')
        return true
      },
    )
  })
})

describe('pick — forceRepin path', () => {
  test('forceRepin=true 在 unbound 之上覆盖回 active(保留 sessionId)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('force-overwrite')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'fo-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-fo-${Date.now()}`
    // 预先把 csap 设成 unbound(模拟"前一轮被 ban 后客户端拿到 409")
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    // forceRepin=true → 跳过 prelude unbound 检查,走 WRH 选号并 upsert
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
      forceRepin: true,
    })
    r.token.fill(0)
    r.refresh?.fill(0)

    const pin = await readPinRow(uid, sid)
    assert.equal(pin?.status, 'active', 'forceRepin 必须把 unbound 翻成 active')
    assert.equal(pin?.account_id, r.account_id.toString(), 'csap.account_id 必须等于实际返回的')
  })

  test('forceRepin=true 在没有 csap 行时落新 active 行(等价于 pin miss)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('force-fresh')
    await createAccount(
      { runtime_channel: 'v3', label: 'ff-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-ff-${Date.now()}`
    const before = await readPinRow(uid, sid)
    assert.equal(before, null, 'precondition: csap 没行')

    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
      forceRepin: true,
    })
    r.token.fill(0)
    r.refresh?.fill(0)

    const after = await readPinRow(uid, sid)
    assert.ok(after, 'forceRepin 即使无 csap 也应落新行')
    assert.equal(after?.status, 'active')
    assert.equal(after?.account_id, r.account_id.toString())
  })

  test('forceRepin=true 撞到已 active 的并发 row → race-lost 切到 winner(不覆盖 active)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('force-race')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'fr-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'fr-B', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-fr-${Date.now()}`
    // csap 已 active 指向 b(模拟"并发 force_repin 已经抢先把 unbound 翻 active 到 b 了")
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, b.id.toString()],
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    const r = await s.pick({
      mode: 'chat',
      sessionId: sid,
      userId: uid,
      pinMode: 'enforce',
      forceRepin: true,
    })
    r.token.fill(0)
    r.refresh?.fill(0)
    // 必须切到 winner b(account_id 由 csap 决定),即使 WRH 可能选了 a
    assert.equal(r.account_id, BigInt(b.id),
      'force_repin 不能覆盖已 active 的 csap 行 — 必须 race-lost 切到现存 winner')
    // csap 状态 + account 不应被改写
    const pin = await readPinRow(uid, sid)
    assert.equal(pin?.account_id, b.id.toString())
    assert.equal(pin?.status, 'active')
    a // suppress unused
  })

  test('forceRepin=false (默认) + csap unbound → 仍抛 SessionPinUnboundError(保持旧行为)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('no-force')
    const a = await createAccount(
      { runtime_channel: 'v3', label: 'nf-A', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-nf-${Date.now()}`
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'unbound')`,
      [uid, sid, a.id.toString()],
    )
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }), // 未传 forceRepin
      (err) => err instanceof SessionPinUnboundError,
    )
  })
})

describe('pick — terminal account race self-heal', () => {
  test('pin active + account banned 未 cascade(模拟 race)→ self-heal + 抛 SessionPinUnboundError', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser('self-heal')
    await createAccount(
      { runtime_channel: 'v3', label: 'sh-pool', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { runtime_channel: 'v3', label: 'sh-target', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const sid = `sess-sh-${Date.now()}`
    // 注意:必须先 INSERT csap active 再 ban — 但 updateAccount(banned) 会 cascade
    // unbind 把 csap 翻成 unbound。模拟"race window"需要绕过 cascade:用 raw SQL
    // 直接改账号状态不走 updateAccount,csap 保持 active。
    await query(
      `INSERT INTO chat_session_account_pin(user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [uid, sid, b.id.toString()],
    )
    await query(
      `UPDATE claude_accounts SET status='banned', updated_at=NOW() WHERE id=$1`,
      [b.id.toString()],
    )
    // 此刻:csap=active 指向 b,b.status=banned,b 不在 active pool — 这是 cascade race window
    const { tracker } = mkTracker()
    const s = mkScheduler(tracker)
    await assert.rejects(
      s.pick({ mode: 'chat', sessionId: sid, userId: uid, pinMode: 'enforce' }),
      (err) => err instanceof SessionPinUnboundError,
    )
    // self-heal 验证:csap 行必须被翻成 unbound,关闭循环
    const pin = await readPinRow(uid, sid)
    assert.equal(pin?.status, 'unbound', 'handlePinnedAccountUnavailable 必须 self-heal csap 到 unbound')
  })
})
