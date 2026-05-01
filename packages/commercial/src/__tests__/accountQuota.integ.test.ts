/**
 * M9 — 账号配额可见性单元 + 集成测试。
 *
 * 单元层(无 PG):parseUtil / parseResetEpoch 边界。
 * 集成层(需 PG):maybeUpdateAccountQuota
 *   - 首次 INSERT (quota_updated_at 从 NULL 变为 NOW)
 *   - 30s 内重复调 → JS 节流跳过(SQL 没动)
 *   - now+31s 后再调 → 数据更新
 *   - 全 null header → 不写
 *   - listAccounts 返回的新字段类型(number|null,不是 string)
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  QUOTA_OUTSTANDING_CAP,
  QUOTA_THROTTLE_MS,
  _quotaOutstanding,
  _resetQuotaState,
  maybeUpdateAccountQuota,
  parseResetEpoch,
  parseUtil,
} from '../account-pool/quota.js'
import { createAccount, listAccounts } from '../account-pool/store.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { encrypt } from '../crypto/aead.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
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

const KEY = randomBytes(KMS_KEY_BYTES)
const keyFn = (): Buffer => Buffer.from(KEY)
let pgAvailable = false
let TEST_EGRESS_PROXY_ID = '1'

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
  _resetQuotaState()
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

/** 简单 HeaderGetter Mock —— 大小写不敏感(浏览器 Headers 行为)。 */
function makeHeaders(record: Record<string, string | null | undefined>): {
  get(name: string): string | null
} {
  const lower: Record<string, string | null | undefined> = {}
  for (const [k, v] of Object.entries(record)) lower[k.toLowerCase()] = v
  return {
    get(name: string): string | null {
      const v = lower[name.toLowerCase()]
      return v === undefined ? null : (v ?? null)
    },
  }
}

// ─── 单元层 ───────────────────────────────────────────────────────

describe('parseUtil', () => {
  test('null / undefined / 空串 → null', () => {
    assert.equal(parseUtil(null), null)
    assert.equal(parseUtil(undefined), null)
    assert.equal(parseUtil(''), null)
  })

  test('非数 → null', () => {
    assert.equal(parseUtil('abc'), null)
    assert.equal(parseUtil('NaN'), null)
  })

  test('fraction (0-1) → 百分比', () => {
    assert.equal(parseUtil('0.5'), 50)
    assert.equal(parseUtil('0.92'), 92)
    assert.equal(parseUtil('0'), 0)
    assert.equal(parseUtil('1'), 100)
  })

  test('fraction > 1(超限)→ clamp 到 100,不当作 percent', () => {
    // Codex review 反馈:不再做 percent 防御分支,1.2 fraction = 120% 超限 = 100% clamp
    assert.equal(parseUtil('1.2'), 100)
    assert.equal(parseUtil('1.5'), 100)
    assert.equal(parseUtil('5'), 100)
  })

  test('越界 clamp [0,100]', () => {
    assert.equal(parseUtil('-0.1'), 0)
    assert.equal(parseUtil('-1'), 0)
  })
})

describe('parseResetEpoch', () => {
  test('null / 空 / 非数 → null', () => {
    assert.equal(parseResetEpoch(null), null)
    assert.equal(parseResetEpoch(''), null)
    assert.equal(parseResetEpoch('abc'), null)
    // 0 / 负 视作非法
    assert.equal(parseResetEpoch('0'), null)
    assert.equal(parseResetEpoch('-1'), null)
  })

  test('epoch seconds → Date', () => {
    const r = parseResetEpoch('1714425600')
    assert.ok(r instanceof Date)
    assert.equal(r!.getTime(), 1714425600 * 1000)
  })

  test('epoch ms → Date(原样)', () => {
    const r = parseResetEpoch('1714425600000')
    assert.ok(r instanceof Date)
    assert.equal(r!.getTime(), 1714425600000)
  })
})

// ─── 集成层(需 PG)─────────────────────────────────────────────────

describe('maybeUpdateAccountQuota', () => {
  test('首次写入 — 4 列 + quota_updated_at 全部落地', async (t) => {
    if (skipIfNoDb(t)) return
    const acc = await createAccount({ label: 'q1', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const headers = makeHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.32',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-7d-utilization': '0.81',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
    })
    await maybeUpdateAccountQuota(getPool(), acc.id, headers)
    const [reloaded] = await listAccounts({ status: 'active' })
    assert.equal(typeof reloaded.quota_5h_pct, 'number')
    assert.equal(reloaded.quota_5h_pct, 32)
    assert.equal(reloaded.quota_7d_pct, 81)
    assert.ok(reloaded.quota_5h_resets_at instanceof Date)
    assert.ok(reloaded.quota_7d_resets_at instanceof Date)
    assert.ok(reloaded.quota_updated_at instanceof Date)
  })

  test('30s 内重复调用 — JS 节流跳过(SQL 不打)', async (t) => {
    if (skipIfNoDb(t)) return
    const acc = await createAccount({ label: 'q2', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const h1 = makeHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.10' })
    await maybeUpdateAccountQuota(getPool(), acc.id, h1)
    const after1 = (await listAccounts())[0]
    assert.equal(after1.quota_5h_pct, 10)

    // 第二次:5s 内,header 数值变了 → JS 节流应该不更新
    const h2 = makeHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.99' })
    const fakeNow = (): number => after1.quota_updated_at!.getTime() + 5 * 1000
    await maybeUpdateAccountQuota(getPool(), acc.id, h2, fakeNow)
    const after2 = (await listAccounts())[0]
    assert.equal(after2.quota_5h_pct, 10, '30s 内不应更新')
  })

  test('> 30s 后再调用 — 数据更新', async (t) => {
    if (skipIfNoDb(t)) return
    const acc = await createAccount({ label: 'q3', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    // 第一次设置一个 31s 前的 lastAttempt(JS 层),然后让 SQL 也跨过 30s
    const startMs = Date.now() - 31 * 1000
    await maybeUpdateAccountQuota(
      getPool(),
      acc.id,
      makeHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.20' }),
      () => startMs,
    )
    // 把 quota_updated_at 手动倒回 31s 前(模拟时间过去),再调一次
    await query(
      `UPDATE claude_accounts SET quota_updated_at = NOW() - INTERVAL '31 seconds' WHERE id = $1::bigint`,
      [acc.id.toString()],
    )
    await maybeUpdateAccountQuota(
      getPool(),
      acc.id,
      makeHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.77' }),
      () => Date.now(),
    )
    const after = (await listAccounts())[0]
    assert.equal(after.quota_5h_pct, 77, '30s 后应更新')
  })

  test('全 null header — 不写不抛', async (t) => {
    if (skipIfNoDb(t)) return
    const acc = await createAccount({ label: 'q4', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await maybeUpdateAccountQuota(getPool(), acc.id, makeHeaders({}))
    const after = (await listAccounts())[0]
    assert.equal(after.quota_5h_pct, null)
    assert.equal(after.quota_updated_at, null)
  })

  test('listAccounts 新字段类型断言(number|null,不是 string)', async (t) => {
    if (skipIfNoDb(t)) return
    await createAccount({ label: 'q5a', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    const acc2 = await createAccount({ label: 'q5b', plan: 'pro', token: 'T', egress_proxy_id: TEST_EGRESS_PROXY_ID }, keyFn)
    await maybeUpdateAccountQuota(
      getPool(),
      acc2.id,
      makeHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0.55' }),
    )
    const all = await listAccounts()
    for (const a of all) {
      // 未写过的账号 → null
      // 写过的账号 → number
      if (a.quota_7d_pct !== null) assert.equal(typeof a.quota_7d_pct, 'number')
      if (a.quota_5h_pct !== null) assert.equal(typeof a.quota_5h_pct, 'number')
    }
  })

  test('常量导出形态正确(防回归)', () => {
    assert.equal(QUOTA_THROTTLE_MS, 30000)
    assert.equal(QUOTA_OUTSTANDING_CAP, 32)
    assert.equal(typeof _quotaOutstanding(), 'number')
  })
})
