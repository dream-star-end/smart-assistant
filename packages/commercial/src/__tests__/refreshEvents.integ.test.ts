/**
 * M6/P1-9 集成:account_refresh_events 表的写入 / 读取 / 保留期清理 +
 * 在真 PG 上验证 refresh.ts 各失败路径会落对应受控字符串 err_msg(不含 raw error)。
 *
 * 重点验证:
 *   - DB CHECK chk_event_consistency 强制 ok=true 时 err_code/err_msg=NULL,
 *     ok=false 时两者非空
 *   - listRefreshEvents 倒序 + limit cap
 *   - purgeOlderThan 正确删除超 N 天事件
 *   - refresh.ts 5 个失败 + 1 个成功路径都落事件,err_msg 是固定字符串
 *   - account 删除 → CASCADE 清掉历史
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  RefreshError,
  type RefreshHttpClient,
  refreshAccountToken,
} from '../account-pool/refresh.js'
import {
  MAX_LIST_LIMIT,
  listRefreshEvents,
  purgeOlderThan,
  recordRefreshEvent,
} from '../account-pool/refreshEvents.js'
import { createAccount, deleteAccount } from '../account-pool/store.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

const COMMERCIAL_TABLES = [
  'account_refresh_events',
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
  'refresh_tokens',
  'email_verifications',
  'users',
  'schema_migrations',
]

let pgAvailable = false
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
  await query('TRUNCATE TABLE account_refresh_events, claude_accounts RESTART IDENTITY CASCADE')
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

function mockHttp(resp: { status: number; body: string }): RefreshHttpClient {
  return {
    async post() {
      return { status: resp.status, body: resp.body }
    },
  }
}

function throwingHttp(msg: string): RefreshHttpClient {
  return {
    async post() {
      throw new Error(msg)
    },
  }
}

async function makeAccount(label: string): Promise<bigint> {
  const a = await createAccount(
    {
      label,
      plan: 'pro',
      token: 'ACC',
      refresh: 'REF',
      expires_at: new Date(Date.now() - 60_000),
    },
    keyFn,
  )
  return a.id
}

// ────────────────────────────────────────────────────────────────────
// recordRefreshEvent / listRefreshEvents / DB CHECK
// ────────────────────────────────────────────────────────────────────

describe('recordRefreshEvent + DB CHECK', () => {
  test('ok=true 落库,err_code/err_msg=NULL', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ok1')
    await recordRefreshEvent({ accountId: id, ok: true })
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].ok, true)
    assert.equal(evs[0].err_code, null)
    assert.equal(evs[0].err_msg, null)
  })

  test('ok=false 必须带 errCode + errMsg', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('fail1')
    await recordRefreshEvent({
      accountId: id,
      ok: false,
      errCode: 'http_error',
      errMsg: 'HTTP 502',
    })
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].ok, false)
    assert.equal(evs[0].err_code, 'http_error')
    assert.equal(evs[0].err_msg, 'HTTP 502')
  })

  test('DB CHECK 拒绝 ok=true 但 err_code 非空', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('bad1')
    await assert.rejects(
      query(
        `INSERT INTO account_refresh_events (account_id, ok, err_code, err_msg)
         VALUES ($1, TRUE, 'http_error', 'HTTP 500')`,
        [String(id)],
      ),
      /chk_event_consistency/,
    )
  })

  test('DB CHECK 拒绝 ok=false 但 err_code/err_msg 缺失', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('bad2')
    await assert.rejects(
      query(
        `INSERT INTO account_refresh_events (account_id, ok, err_code, err_msg)
         VALUES ($1, FALSE, NULL, NULL)`,
        [String(id)],
      ),
      /chk_event_consistency/,
    )
  })
})

describe('listRefreshEvents 倒序 + limit cap', () => {
  test('ts 倒序', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('list1')
    // 三条事件,人工设置 ts 错开
    await query(
      `INSERT INTO account_refresh_events (account_id, ts, ok, err_code, err_msg)
       VALUES
         ($1, NOW() - INTERVAL '3 minutes', TRUE, NULL, NULL),
         ($1, NOW() - INTERVAL '1 minute',  FALSE, 'http_error', 'HTTP 500'),
         ($1, NOW() - INTERVAL '2 minutes', TRUE, NULL, NULL)`,
      [String(id)],
    )
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 3)
    // 倒序:最新(1m前)在头
    assert.equal(evs[0].ok, false)
    assert.equal(evs[1].ok, true)
    assert.equal(evs[2].ok, true)
  })

  test('limit 上限 500', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('cap1')
    await recordRefreshEvent({ accountId: id, ok: true })
    // 传超大值不应抛
    const evs = await listRefreshEvents(id, 100_000)
    assert.equal(evs.length, 1)
    // 边界:Math.min(MAX_LIST_LIMIT, x) 在 SQL 之前生效
    assert.equal(MAX_LIST_LIMIT, 500)
  })

  test('limit ≤ 0 → 取 1', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('cap2')
    await recordRefreshEvent({ accountId: id, ok: true })
    await recordRefreshEvent({ accountId: id, ok: true })
    const evs = await listRefreshEvents(id, 0)
    assert.equal(evs.length, 1)
  })

  test('不同账号不串', async (t) => {
    if (skipIfNoDb(t)) return
    const a = await makeAccount('acc-a')
    const b = await makeAccount('acc-b')
    await recordRefreshEvent({ accountId: a, ok: true })
    await recordRefreshEvent({
      accountId: b,
      ok: false,
      errCode: 'no_refresh_token',
      errMsg: 'no refresh_token on record',
    })
    const evsA = await listRefreshEvents(a)
    const evsB = await listRefreshEvents(b)
    assert.equal(evsA.length, 1)
    assert.equal(evsA[0].ok, true)
    assert.equal(evsB.length, 1)
    assert.equal(evsB[0].err_code, 'no_refresh_token')
  })
})

// ────────────────────────────────────────────────────────────────────
// purgeOlderThan
// ────────────────────────────────────────────────────────────────────

describe('purgeOlderThan', () => {
  test('28 天阈值:删超 28 天的,留 28 天内的', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('purge1')
    await query(
      `INSERT INTO account_refresh_events (account_id, ts, ok, err_code, err_msg)
       VALUES
         ($1, NOW() - INTERVAL '40 days', TRUE, NULL, NULL),
         ($1, NOW() - INTERVAL '30 days', TRUE, NULL, NULL),
         ($1, NOW() - INTERVAL '20 days', TRUE, NULL, NULL),
         ($1, NOW() - INTERVAL '5 days',  TRUE, NULL, NULL)`,
      [String(id)],
    )
    const deleted = await purgeOlderThan(28)
    assert.equal(deleted, 2)
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 2)
  })

  test('days <= 0 / NaN → 不删,返 0', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('purge2')
    await recordRefreshEvent({ accountId: id, ok: true })
    assert.equal(await purgeOlderThan(0), 0)
    assert.equal(await purgeOlderThan(-1), 0)
    assert.equal(await purgeOlderThan(Number.NaN), 0)
    assert.equal((await listRefreshEvents(id)).length, 1)
  })
})

// ────────────────────────────────────────────────────────────────────
// FK ON DELETE CASCADE
// ────────────────────────────────────────────────────────────────────

describe('FK ON DELETE CASCADE', () => {
  test('删除账号 → 历史事件随之清', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('cascade1')
    await recordRefreshEvent({ accountId: id, ok: true })
    await recordRefreshEvent({
      accountId: id,
      ok: false,
      errCode: 'http_error',
      errMsg: 'HTTP 401',
    })
    assert.equal((await listRefreshEvents(id)).length, 2)
    await deleteAccount(id)
    // 直接查 DB,绕过 listRefreshEvents 的 account_id 过滤
    const r = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM account_refresh_events WHERE account_id = $1',
      [String(id)],
    )
    assert.equal(r.rows[0]!.count, '0')
  })
})

// ────────────────────────────────────────────────────────────────────
// refresh.ts 各路径落事件 — 验证 err_msg 是固定字符串(无 raw error 泄露)
// ────────────────────────────────────────────────────────────────────

describe('refresh.ts 落事件 — err_msg 固定字符串', () => {
  test('成功路径 → ok=true 事件', async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ev-ok')
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ access_token: 'NEW', expires_in: 3600 }),
    })
    await refreshAccountToken(id, { http, keyFn })
    // refresh 内部 fire-and-forget 落事件,等微任务尾巴
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].ok, true)
  })

  test("network_transient → err_msg='refresh network call failed'(不含底层 err.message)", async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ev-net')
    const http = throwingHttp('CONNECT_TIMEOUT https://proxy.creds@evil:8080')
    await assert.rejects(
      refreshAccountToken(id, { http, keyFn }),
      (e: unknown) => e instanceof RefreshError && e.code === 'network_transient',
    )
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].ok, false)
    assert.equal(evs[0].err_code, 'network_transient')
    assert.equal(evs[0].err_msg, 'refresh network call failed')
    // 关键:err_msg 不含底层异常的 url/凭据字符串
    assert.ok(!evs[0].err_msg!.includes('proxy.creds'))
    assert.ok(!evs[0].err_msg!.includes('CONNECT_TIMEOUT'))
  })

  test("http_error → err_msg='HTTP 502'(只含 status,无 body)", async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ev-http')
    const http = mockHttp({
      status: 502,
      body: '{"err":"upstream","leaked_token":"sk-ant-secret-deadbeef"}',
    })
    await assert.rejects(
      refreshAccountToken(id, { http, keyFn }),
      (e: unknown) => e instanceof RefreshError && e.code === 'http_error',
    )
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(id)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].err_code, 'http_error')
    assert.equal(evs[0].err_msg, 'HTTP 502')
    // 关键:不含 response body 里的 token 残片
    assert.ok(!evs[0].err_msg!.includes('sk-ant-secret'))
    assert.ok(!evs[0].err_msg!.includes('upstream'))
  })

  test("bad_response (invalid JSON) → err_msg='invalid JSON'", async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ev-json')
    const http = mockHttp({ status: 200, body: '<html>not json</html>' })
    await assert.rejects(
      refreshAccountToken(id, { http, keyFn }),
      (e: unknown) => e instanceof RefreshError && e.code === 'bad_response',
    )
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(id)
    assert.equal(evs[0].err_code, 'bad_response')
    assert.equal(evs[0].err_msg, 'invalid JSON')
    assert.ok(!evs[0].err_msg!.includes('html'))
  })

  test("bad_response (missing access_token) → err_msg='missing access_token'", async (t) => {
    if (skipIfNoDb(t)) return
    const id = await makeAccount('ev-noat')
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ leaked_field: 'should-not-leak' }),
    })
    await assert.rejects(
      refreshAccountToken(id, { http, keyFn }),
      (e: unknown) => e instanceof RefreshError && e.code === 'bad_response',
    )
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(id)
    assert.equal(evs[0].err_code, 'bad_response')
    assert.equal(evs[0].err_msg, 'missing access_token')
    assert.ok(!evs[0].err_msg!.includes('leaked'))
  })

  test("no_refresh_token → err_msg='no refresh_token on record'", async (t) => {
    if (skipIfNoDb(t)) return
    const a = await createAccount(
      { label: 'ev-nort', plan: 'pro', token: 'X', refresh: null },
      keyFn,
    )
    const http = mockHttp({ status: 200, body: '{}' })
    await assert.rejects(
      refreshAccountToken(a.id, { http, keyFn }),
      (e: unknown) => e instanceof RefreshError && e.code === 'no_refresh_token',
    )
    await new Promise((r) => setTimeout(r, 50))
    const evs = await listRefreshEvents(a.id)
    assert.equal(evs[0].err_code, 'no_refresh_token')
    assert.equal(evs[0].err_msg, 'no refresh_token on record')
  })
})
