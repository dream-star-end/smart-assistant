/**
 * V3 envv2 Phase 1 集成测试 — `kind` 分区在真 PG 上的行为
 * (plan: docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §1.6)。
 *
 * 覆盖三个 case:
 *   A. platform 池 1 个 active + external_api 池空 →
 *      pick({kind:'external_api'}) 抛 AccountPoolUnavailableError,**不** fallback。
 *   B. 两池都有 active → pick({kind:'platform'}) 永不选到 external_api 账号,反之
 *      亦然(各 100 次,id 集合不相交)。
 *   C. default kind = 'platform'(不传 kind 参数,与历史等价)。
 *
 * **不**测 handler — Phase 1 handler 不切。Phase 1.5 加 handler integ。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { AccountHealthTracker, InMemoryHealthRedis } from '../account-pool/health.js'
import { AccountPoolUnavailableError, AccountScheduler } from '../account-pool/scheduler.js'
import { type AccountKind, createAccount, updateAccount } from '../account-pool/store.js'
import { encrypt } from '../crypto/aead.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false
let TEST_EGRESS_PROXY_ID = '1'
const KEY = randomBytes(KMS_KEY_BYTES)
const keyFn = (): Buffer => Buffer.from(KEY)

/** 防线:DROP SCHEMA 一旦误指 staging/prod 杀伤面极大。强制要求 dbname 以 `_test`
 *  结尾,unmet 直接 throw,不去碰 schema。与 settleUsage.integ.test.ts 同型。 */
function assertTestDatabase(url: string): void {
  let dbName: string
  try {
    dbName = new URL(url).pathname.replace(/^\//, '')
  } catch {
    throw new Error(`invalid TEST_DATABASE_URL: ${url}`)
  }
  if (!dbName.endsWith('_test')) {
    throw new Error(`refusing to reset non-test database: ${dbName} (must end with _test)`)
  }
}

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
  // 测试库可能残留更多表(其它 integ test / 历史 schema)。整库 reset:DROP SCHEMA + 重建。
  // assertTestDatabase 防误炸 staging/prod。
  assertTestDatabase(TEST_DB_URL)
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
  const _ep = encrypt('http://test:test@10.0.0.1:8080', KEY)
  const _r = await query<{ id: string }>(
    "INSERT INTO egress_proxies(label, url_enc, url_nonce, status) VALUES ($1, $2, $3, 'active') RETURNING id::text AS id",
    [`t-kind-${Date.now()}`, _ep.ciphertext, _ep.nonce],
  )
  TEST_EGRESS_PROXY_ID = _r.rows[0].id
})

after(async () => {
  if (pgAvailable) {
    try {
      assertTestDatabase(TEST_DB_URL)
      await query('DROP SCHEMA IF EXISTS public CASCADE')
      await query('CREATE SCHEMA public')
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

function mkScheduler(): AccountScheduler {
  const redis = new InMemoryHealthRedis()
  const tracker = new AccountHealthTracker({ redis })
  return new AccountScheduler({ health: tracker, keyFn })
}

describe('pick — V3 envv2 kind 分区(0070)', () => {
  test('case A: external_api 池空 → pick({kind:external_api}) 抛 AccountPoolUnavailableError,不 fallback', async (t) => {
    if (skipIfNoDb(t)) return
    // 只建一个 platform 账号(默认 kind);external_api 池零行。
    const p = await createAccount(
      { label: 'p1', plan: 'pro', token: 'T-P1', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    assert.equal(p.kind, 'platform', 'createAccount default kind should be platform')

    const s = mkScheduler()
    await assert.rejects(
      s.pick({ mode: 'chat', kind: 'external_api' }),
      (err: unknown) => err instanceof AccountPoolUnavailableError,
    )
  })

  test('case B: 两池都有 active → pick 严格按 kind 过滤,不交叉(各 100 次 id 集合不相交)', async (t) => {
    if (skipIfNoDb(t)) return
    // 4 个 platform + 4 个 external_api,token 全部独立(WRH 验证池分离)。
    const platformAccts = []
    const externalAccts = []
    for (let i = 0; i < 4; i += 1) {
      const a = await createAccount(
        { label: `p${i}`, plan: 'pro', token: `T-P${i}`, egress_proxy_id: TEST_EGRESS_PROXY_ID },
        keyFn,
      )
      platformAccts.push(a.id)
    }
    for (let i = 0; i < 4; i += 1) {
      const a = await createAccount(
        {
          label: `e${i}`,
          kind: 'external_api',
          plan: 'pro',
          token: `T-E${i}`,
          egress_proxy_id: TEST_EGRESS_PROXY_ID,
        },
        keyFn,
      )
      externalAccts.push(a.id)
    }

    const platformIds = new Set(platformAccts.map(String))
    const externalIds = new Set(externalAccts.map(String))

    const s = mkScheduler()
    // 100 次 pick({kind:'platform'}) — 每次 sessionId 不同,覆盖多 WRH key 的回归抽样
    // (非穷举证明;真正的隔离保证来自 scheduler SQL 的 `AND kind = $2`,这里测试
    // 是行为校验:在合理 sessionId 分布下,绝不会跨池泄漏)。
    // 每次 release 释放 inflight slot,否则 maxConcurrent=10 会卡死。
    for (let i = 0; i < 100; i += 1) {
      const r = await s.pick({ mode: 'chat', kind: 'platform', sessionId: `sess-p-${i}` })
      assert.ok(
        platformIds.has(String(r.account_id)),
        `pick(platform) 返了非 platform 账号: ${String(r.account_id)}`,
      )
      assert.ok(
        !externalIds.has(String(r.account_id)),
        `pick(platform) 选到了 external_api 账号: ${String(r.account_id)}`,
      )
      r.token.fill(0)
      r.refresh?.fill(0)
      await s.release({ account_id: r.account_id, result: { kind: 'success' } })
    }
    // 100 次 pick({kind:'external_api'})
    for (let i = 0; i < 100; i += 1) {
      const r = await s.pick({ mode: 'chat', kind: 'external_api', sessionId: `sess-e-${i}` })
      assert.ok(
        externalIds.has(String(r.account_id)),
        `pick(external_api) 返了非 external_api 账号: ${String(r.account_id)}`,
      )
      assert.ok(
        !platformIds.has(String(r.account_id)),
        `pick(external_api) 选到了 platform 账号: ${String(r.account_id)}`,
      )
      r.token.fill(0)
      r.refresh?.fill(0)
      await s.release({ account_id: r.account_id, result: { kind: 'success' } })
    }
  })

  test('case C: default kind (不传) 等价 platform — 与历史行为兼容', async (t) => {
    if (skipIfNoDb(t)) return
    // 1 platform + 1 external_api。不传 kind 必选 platform。
    const p = await createAccount(
      { label: 'p1', plan: 'pro', token: 'T-P1', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const e = await createAccount(
      {
        label: 'e1',
        kind: 'external_api',
        plan: 'pro',
        token: 'T-E1',
        egress_proxy_id: TEST_EGRESS_PROXY_ID,
      },
      keyFn,
    )

    const s = mkScheduler()
    // 30 次不传 kind — 必定全部命中 platform(p.id)。
    // 每次 release,否则 per-account maxConcurrent=10 cap 卡死。
    for (let i = 0; i < 30; i += 1) {
      const r = await s.pick({ mode: 'chat', sessionId: `sess-default-${i}` })
      assert.equal(
        r.account_id,
        p.id,
        `default kind 应当只选 platform 账号,实际选到 ${String(r.account_id)}`,
      )
      assert.notEqual(r.account_id, e.id)
      r.token.fill(0)
      r.refresh?.fill(0)
      await s.release({ account_id: r.account_id, result: { kind: 'success' } })
    }
  })

  test('updateAccount(kind=external_api) 能把 platform 账号迁移到外接池', async (t) => {
    if (skipIfNoDb(t)) return
    // ops 迁移路径 SOP(plan §1.5):boss 手动 UPDATE 把账号划进外接池。
    // 这里走 updateAccount API,验证 store 层暴露的 patch 接口语义正确。
    const a = await createAccount(
      { label: 'p1', plan: 'pro', token: 'T-P1', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    assert.equal(a.kind, 'platform')

    const updated = await updateAccount(a.id, { kind: 'external_api' as AccountKind }, keyFn)
    assert.ok(updated, 'updateAccount returned null')
    assert.equal(updated.kind, 'external_api')

    const s = mkScheduler()
    // 此时 platform 池空,external_api 池有 a。
    await assert.rejects(
      s.pick({ mode: 'chat', kind: 'platform' }),
      (err: unknown) => err instanceof AccountPoolUnavailableError,
    )
    const r = await s.pick({ mode: 'chat', kind: 'external_api' })
    assert.equal(r.account_id, a.id)
    r.token.fill(0)
    r.refresh?.fill(0)
    await s.release({ account_id: r.account_id, result: { kind: 'success' } })
  })

  test('createAccount 拒绝非法 kind 值', async (t) => {
    if (skipIfNoDb(t)) return
    await assert.rejects(
      createAccount(
        {
          label: 'bad',
          // @ts-expect-error 故意传非法值验 runtime guard
          kind: 'invalid_kind_value',
          plan: 'pro',
          token: 'T-BAD',
          egress_proxy_id: TEST_EGRESS_PROXY_ID,
        },
        keyFn,
      ),
      /invalid kind/,
    )
  })

  test('pick 拒绝非法 kind 值(防 caller 绕 TS)', async (t) => {
    if (skipIfNoDb(t)) return
    const s = mkScheduler()
    await assert.rejects(
      // @ts-expect-error 故意传非法值验 runtime guard
      s.pick({ mode: 'chat', kind: 'invalid_kind_value' }),
      /invalid kind/,
    )
  })

  test('AccountRow.envelope_version 默认 = 1(0070 DEFAULT)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount(
      { label: 'p', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    assert.equal(a.envelope_version, 1, '0070 migration 默认值应为 1')
  })
})
