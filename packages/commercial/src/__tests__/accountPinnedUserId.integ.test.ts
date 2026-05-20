/**
 * 反风控:`claude_accounts.pinned_user_id` schema 回归(0067 migration)。
 *
 * 覆盖:
 *   - `store.createAccount` 走完 INSERT 后,DB 行的 `pinned_user_id` 字段:
 *       ① 是 64 字符小写 hex
 *       ② 通过 0067 migration 的 CHECK 约束 ^[0-9a-f]{64}$
 *       ③ 唯一(同一进程内多次 createAccount 的 pinned_user_id 互不重复)
 *
 * 关键 invariant:`store.ts/createAccount` 的 INSERT 列表**没有** pinned_user_id —
 * 这是有意的"最小改动"决策(plan 阶段 Codex Finding #1 → 选 DB DEFAULT 路径)。
 * 该测试守住"未来新建账号自动拿到合法值"的契约,防止后续 INSERT 路径改动绕过
 * schema DEFAULT 后,容器再次出现"短命随机 device_id"画像。
 *
 * Backfill 路径(0067 migration 对已存在行 backfill)走 staging smoke test 而非
 * 此处的 staged migration harness — 见 0067 migration 注释中的"上线 backfill 验证"。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'
import { createAccount } from '../account-pool/store.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { encrypt } from '../crypto/aead.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

// 跟 accountScheduler.integ.test.ts 保持一致的 reset 范围(避免互相干扰)。
const COMMERCIAL_TABLES = [
  'envelope_prefix_templates',
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
    [`t-pinned-${Date.now()}`, _ep.ciphertext, _ep.nonce],
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
  await query('TRUNCATE TABLE claude_accounts RESTART IDENTITY CASCADE')
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

describe('claude_accounts.pinned_user_id schema invariant (0067)', () => {
  test('createAccount 后 DB 行的 pinned_user_id 是 64 hex 且唯一', async (t) => {
    if (skipIfNoDb(t)) return

    // store.ts/createAccount 的 INSERT 列表没有 pinned_user_id;DB DEFAULT 应自动注入。
    const a = await createAccount(
      { label: 'pin-a', plan: 'pro', token: 'T-A', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )
    const b = await createAccount(
      { label: 'pin-b', plan: 'pro', token: 'T-B', egress_proxy_id: TEST_EGRESS_PROXY_ID },
      keyFn,
    )

    const res = await query<{ id: string; pinned_user_id: string }>(
      'SELECT id::text AS id, pinned_user_id FROM claude_accounts WHERE id IN ($1, $2) ORDER BY id',
      [a.id.toString(), b.id.toString()],
    )
    assert.equal(res.rows.length, 2, '两个新建账号都应能查到')

    for (const row of res.rows) {
      assert.match(
        row.pinned_user_id,
        /^[0-9a-f]{64}$/,
        `pinned_user_id ${row.pinned_user_id} should match 64-lowercase-hex (CHECK constraint)`,
      )
    }

    assert.notEqual(
      res.rows[0].pinned_user_id,
      res.rows[1].pinned_user_id,
      'pinned_user_id 应跨账号唯一(DB UNIQUE INDEX 守住)',
    )
  })
})
