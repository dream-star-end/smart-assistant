/**
 * M1b — codex 账号池 runtime_channel 划分(0098)集成测试。
 *
 * 覆盖(架构决策:单账号单刷新权威,防 v3/v5 双 master 共刷 codex OAuth
 * refresh-token family 触发吊销):
 *   1. 0098 migration 幂等:整文件重复执行不炸;default 'v3';CHECK 拒第三种 channel;
 *   2. picker fail-closed:v5 channel 下只见 runtime_channel='v5' 的 codex 行,
 *      池里只有 v3 行时返回 null(报"池空"),**绝不回落 v3 行**;
 *   3. actor 刷新枚举同口径:v5 只枚举 v5 行的到期账号;
 *   4. claude provider 行不受 channel 过滤影响(共享池语义不动)。
 *
 * 本地:见 packages/commercial/README.md 起 PG fixture;
 *      REQUIRE_TEST_DB=1 npx tsx --test codexChannelPartition.integ.test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, test } from 'node:test'
import { pickCodexAccountForBinding } from '../account-pool/scheduler.js'
import { generatePersona } from '../account-pool/persona.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

const MIGRATION_0098 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/0098_claude_accounts_runtime_channel.sql',
)

let pgAvailable = false
let egressProxyId = ''
const savedChannel = process.env.OC_RUNTIME_CHANNEL

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) throw new Error(`refusing non-test database: ${dbName}`)
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
      /* ignore */
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
  assertTestDatabase(TEST_DB_URL)
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetTestSchemaForTest()
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (savedChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL
  else process.env.OC_RUNTIME_CHANNEL = savedChannel
  if (pgAvailable) await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  delete process.env.OC_RUNTIME_CHANNEL // 默认 v3
  await query('TRUNCATE TABLE claude_accounts, egress_proxies RESTART IDENTITY CASCADE')
  const ep = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce) VALUES ('chan-ep', '\\x00'::bytea, '\\x00'::bytea) RETURNING id::text AS id`,
  )
  egressProxyId = ep.rows[0].id
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

async function mkAccount(args: {
  provider?: 'codex' | 'claude'
  status?: string
  channel?: 'v3' | 'v5' | null
  expiresInMs?: number | null
}): Promise<bigint> {
  const provider = args.provider ?? 'codex'
  const status = args.status ?? 'active'
  const cols = ['label', 'plan', 'provider', 'status', 'oauth_token_enc', 'oauth_nonce', 'egress_proxy_id', 'persona']
  const vals: unknown[] = [
    `acct-${provider}-${Math.random().toString(36).slice(2, 10)}`,
    'pro',
    provider,
    status,
    Buffer.from([0]),
    Buffer.from([0]),
    egressProxyId,
    JSON.stringify(generatePersona()),
  ]
  const placeholders = cols.map((_, i) => `$${i + 1}`)
  if (args.channel !== undefined && args.channel !== null) {
    cols.push('runtime_channel')
    vals.push(args.channel)
    placeholders.push(`$${vals.length}`)
  }
  if (args.expiresInMs !== undefined && args.expiresInMs !== null) {
    cols.push('oauth_expires_at')
    vals.push(new Date(Date.now() + args.expiresInMs))
    placeholders.push(`$${vals.length}`)
  }
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id::text AS id`,
    vals,
  )
  return BigInt(r.rows[0].id)
}

describe('0098 migration — 幂等 + default + CHECK', () => {
  test('整文件重复执行幂等;存量/新行默认 v3', async (t) => {
    if (skipIfNoPg(t)) return
    const sql = await readFile(MIGRATION_0098, 'utf8')
    // runMigrations 已跑过一次;再裸跑两遍不允许炸(IF NOT EXISTS / pg_constraint 探测)。
    await query(sql)
    await query(sql)
    const id = await mkAccount({}) // 不指定 channel
    const r = await query<{ runtime_channel: string }>(
      'SELECT runtime_channel FROM claude_accounts WHERE id = $1',
      [String(id)],
    )
    assert.equal(r.rows[0].runtime_channel, 'v3', 'default 必须 v3(v3 现网零行为变化)')
  })

  test("CHECK 拒第三种 channel('v9')", async (t) => {
    if (skipIfNoPg(t)) return
    const id = await mkAccount({})
    await assert.rejects(
      () => query("UPDATE claude_accounts SET runtime_channel = 'v9' WHERE id = $1", [String(id)]),
      /claude_accounts_runtime_channel_check/,
    )
  })
})

describe('picker channel fail-closed(v5 取不到 v3 行)', () => {
  test('v5 channel:只有 v3 codex 行 → null(池空,不回落)', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ channel: 'v3' })
    await mkAccount({ channel: null }) // 默认 v3
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    const picked = await pickCodexAccountForBinding('container-fc-1')
    assert.equal(picked, null, 'v5 绝不消费 v3 channel 的 codex 账号')
  })

  test('v5 channel:v3+v5 混布 → 恒选 v5 行', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ channel: 'v3' })
    const v5Id = await mkAccount({ channel: 'v5' })
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    for (const sess of ['s-a', 's-b', 's-c']) {
      const picked = await pickCodexAccountForBinding(sess)
      assert.equal(picked?.account_id, v5Id)
    }
  })

  test('v3 channel(默认):只见 v3 行,不消费 v5 行', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Id = await mkAccount({ channel: 'v3' })
    await mkAccount({ channel: 'v5' })
    const picked = await pickCodexAccountForBinding('s-v3')
    assert.equal(picked?.account_id, v3Id)
  })

  test('v5 channel:v5 行存在但非 active → null(status 与 channel 双过滤)', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ channel: 'v5', status: 'disabled' })
    await mkAccount({ channel: 'v3', status: 'active' })
    process.env.OC_RUNTIME_CHANNEL = 'v5'
    assert.equal(await pickCodexAccountForBinding('s-d'), null)
  })
})

describe('actor 刷新枚举 channel 口径', () => {
  // 与 codexAccountActor.runOneTick 的枚举 SQL 同文(单一权威在 actor 源码;
  // 这里验证该口径在真 PG 上的行为:v5 只枚举 v5 行的到期账号)。
  async function dueAccounts(channel: 'v3' | 'v5'): Promise<string[]> {
    const r = await query<{ id: string }>(
      `SELECT id::text AS id
       FROM claude_accounts
       WHERE provider = 'codex' AND status = 'active'
         AND runtime_channel = $2
         AND oauth_expires_at IS NOT NULL
         AND oauth_expires_at < (NOW() + ($1::int * interval '1 millisecond'))`,
      [15 * 60 * 1000, channel],
    )
    return r.rows.map((x) => x.id)
  }

  test('v5 枚举不含 v3 到期账号;v3 枚举不含 v5', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Due = await mkAccount({ channel: 'v3', expiresInMs: 60_000 })
    const v5Due = await mkAccount({ channel: 'v5', expiresInMs: 60_000 })
    await mkAccount({ channel: 'v5', expiresInMs: 24 * 3600 * 1000 }) // 未到期
    assert.deepEqual(await dueAccounts('v5'), [String(v5Due)])
    assert.deepEqual(await dueAccounts('v3'), [String(v3Due)])
  })
})

describe('claude provider 不受 channel 过滤影响(共享池语义)', () => {
  test('scheduler 常规 claude 视图仍能看到默认 v3 行(未按 channel 切)', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ provider: 'claude', channel: null })
    // claude 选取路径(AccountScheduler.pick 系)不读 runtime_channel 列;
    // 这里验证行级数据可见性没有被 0098 影响(列存在但不参与 claude 过滤)。
    const r = await query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM claude_accounts WHERE provider = 'claude' AND status = 'active'`,
    )
    assert.equal(r.rows[0].cnt, '1')
  })
})
