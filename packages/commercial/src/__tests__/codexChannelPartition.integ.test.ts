/**
 * 0098 — codex 账号池 runtime_channel 划分(v3 侧 backport)集成测试。
 *
 * 架构决策(与 v5 树 0098 同构):v3/v5 是两个并行 master,共享同一张
 * claude_accounts。codex OAuth refresh-token 是 family 语义,同一账号被两个
 * 进程并发刷新会触发 family 吊销 → codex 行必须有唯一 channel 归属,v3 只
 * 刷/绑/消费 runtime_channel='v3' 的行,v5 行对 v3 完全不可见(fail-closed)。
 *
 * 覆盖:
 *   1. 0098 migration 幂等:整文件重复执行不炸;default 'v3';CHECK 拒第三种 channel;
 *   2. picker(pickCodexAccountForBinding):v3 只见 v3 行;池里只有 v5 行 → null
 *      (池空 fail-closed,绝不回落 v5 行);
 *   3. actor 刷新枚举同口径:v3 只枚举 v3 行的到期账号(v5 行不进刷新权威);
 *   4. groups official_oauth 探测:codex 只认 v3 行;claude 不受 channel 过滤影响;
 *   5. admin 可见性(store.listAccounts):v5 codex 行不可见;claude 行不过滤;
 *   6. halfOpen 自动恢复:不越权翻 v5 codex cooldown 行(claude / v3 codex 正常恢复);
 *   7. claude provider 共享池语义零变化。
 *
 * 本地:见 packages/commercial/README.md 起 PG fixture;
 *      REQUIRE_TEST_DB=1 npx tsx --test codexChannelPartition.integ.test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasActiveOfficialOAuthAccountInGroup } from '../account-pool/groups.js'
import { AccountHealthTracker, InMemoryHealthRedis } from '../account-pool/health.js'
import { generatePersona } from '../account-pool/persona.js'
import { pickCodexAccountForBinding } from '../account-pool/scheduler.js'
import { listAccounts } from '../account-pool/store.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

const MIGRATION_0098 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/0098_claude_accounts_runtime_channel.sql',
)

let pgAvailable = false
let egressProxyId = ''

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
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (pgAvailable) await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE account_groups, claude_accounts, egress_proxies RESTART IDENTITY CASCADE',
  )
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
  groupId?: string | null
  expiresInMs?: number | null
  cooldownUntilMsAgo?: number
}): Promise<bigint> {
  const provider = args.provider ?? 'codex'
  const status = args.status ?? 'active'
  const cols = [
    'label',
    'plan',
    'provider',
    'status',
    'oauth_token_enc',
    'oauth_nonce',
    'egress_proxy_id',
    'persona',
  ]
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
  const push = (col: string, val: unknown): void => {
    cols.push(col)
    vals.push(val)
    placeholders.push(`$${vals.length}`)
  }
  // channel 不传 = 不写列(验证 DEFAULT 'v3')
  if (args.channel !== undefined && args.channel !== null) push('runtime_channel', args.channel)
  if (args.groupId !== undefined && args.groupId !== null) push('group_id', args.groupId)
  if (args.expiresInMs !== undefined && args.expiresInMs !== null) {
    push('oauth_expires_at', new Date(Date.now() + args.expiresInMs))
  }
  if (args.cooldownUntilMsAgo !== undefined) {
    push('cooldown_until', new Date(Date.now() - args.cooldownUntilMsAgo))
  }
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id::text AS id`,
    vals,
  )
  return BigInt(r.rows[0].id)
}

describe('0098 migration — 幂等 + default + CHECK', () => {
  test('整文件重复执行幂等;不带 channel 的新行默认 v3(存量行零行为变化)', async (t) => {
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
    assert.equal(r.rows[0].runtime_channel, 'v3', "default 必须 'v3'(v3 现网存量行为不变)")
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

describe('picker channel fail-closed(v3 取不到 v5 行)', () => {
  test('池里只有 v5 codex 行 → null(池空,绝不回落 v5 行)', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ channel: 'v5' })
    const picked = await pickCodexAccountForBinding('container-fc-1')
    assert.equal(picked, null, 'v3 绝不绑定/消费 v5 channel 的 codex 账号')
  })

  test('v3+v5 混布 → 恒选 v3 行(含默认 channel 行)', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Id = await mkAccount({ channel: null }) // DEFAULT 'v3'
    await mkAccount({ channel: 'v5' })
    for (const sess of ['s-a', 's-b', 's-c']) {
      const picked = await pickCodexAccountForBinding(sess)
      assert.equal(picked?.account_id, v3Id)
    }
  })

  test('v3 行存在但非 active → null(status 与 channel 双过滤)', async (t) => {
    if (skipIfNoPg(t)) return
    await mkAccount({ channel: 'v3', status: 'disabled' })
    await mkAccount({ channel: 'v5', status: 'active' })
    assert.equal(await pickCodexAccountForBinding('s-d'), null)
  })
})

describe('actor 刷新枚举 channel 口径', () => {
  // 与 codexAccountActor.runOneTick 的枚举 SQL 同文(单一权威在 actor 源码;
  // 这里验证该口径在真 PG 上的行为:v3 只枚举 v3 行的到期账号)。
  async function dueAccountsV3(): Promise<string[]> {
    const r = await query<{ id: string }>(
      `SELECT id::text AS id
       FROM claude_accounts
       WHERE provider = 'codex' AND status = 'active'
         AND runtime_channel = 'v3'
         AND oauth_expires_at IS NOT NULL
         AND oauth_expires_at < (NOW() + ($1::int * interval '1 millisecond'))`,
      [15 * 60 * 1000],
    )
    return r.rows.map((x) => x.id)
  }

  test('v3 枚举不含 v5 到期账号(v5 行永不进 v3 刷新权威)', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Due = await mkAccount({ channel: 'v3', expiresInMs: 60_000 })
    await mkAccount({ channel: 'v5', expiresInMs: 60_000 }) // v5 到期 — 不该出现
    await mkAccount({ channel: 'v3', expiresInMs: 24 * 3600 * 1000 }) // v3 未到期
    assert.deepEqual(await dueAccountsV3(), [String(v3Due)])
  })
})

describe('groups official_oauth 探测 channel 口径', () => {
  async function mkGroup(provider: 'codex' | 'claude'): Promise<string> {
    const r = await query<{ id: string }>(
      `INSERT INTO account_groups(label, kind, provider, enabled)
       VALUES ($1, 'official_oauth', $2, TRUE) RETURNING id::text AS id`,
      [`grp-${provider}-${Math.random().toString(36).slice(2, 8)}`, provider],
    )
    return r.rows[0].id
  }

  test('codex 组:组里只有 v5 行 → false;有 v3 行 → true', async (t) => {
    if (skipIfNoPg(t)) return
    const gid = await mkGroup('codex')
    await mkAccount({ channel: 'v5', groupId: gid })
    assert.equal(await hasActiveOfficialOAuthAccountInGroup(gid, 'codex'), false)
    await mkAccount({ channel: 'v3', groupId: gid })
    assert.equal(await hasActiveOfficialOAuthAccountInGroup(gid, 'codex'), true)
  })

  test('claude 组:不受 channel 过滤影响(共享池语义)', async (t) => {
    if (skipIfNoPg(t)) return
    const gid = await mkGroup('claude')
    // claude 行即便被显式标成 v5(异常数据),探测也不过滤 —— claude 共享池语义不动。
    await mkAccount({ provider: 'claude', channel: 'v5', groupId: gid })
    assert.equal(await hasActiveOfficialOAuthAccountInGroup(gid, 'claude'), true)
  })
})

describe('admin 可见性(store.listAccounts)', () => {
  test('v5 codex 行不可见;v3 codex + claude(任意 channel)可见', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Codex = await mkAccount({ channel: 'v3' })
    await mkAccount({ channel: 'v5' }) // 不可见
    const claudeDefault = await mkAccount({ provider: 'claude', channel: null })
    const rows = await listAccounts()
    const ids = rows.map((r) => r.id).sort()
    assert.deepEqual(ids, [v3Codex, claudeDefault].sort(), 'v3 admin 列表只见 v3 权威的行')
  })
})

describe('halfOpen 自动恢复 channel 口径', () => {
  test('不越权翻 v5 codex cooldown 行;v3 codex + claude 正常恢复', async (t) => {
    if (skipIfNoPg(t)) return
    const v3Codex = await mkAccount({
      channel: 'v3',
      status: 'cooldown',
      cooldownUntilMsAgo: 60_000,
    })
    const v5Codex = await mkAccount({
      channel: 'v5',
      status: 'cooldown',
      cooldownUntilMsAgo: 60_000,
    })
    const claude = await mkAccount({
      provider: 'claude',
      status: 'cooldown',
      cooldownUntilMsAgo: 60_000,
    })
    const tracker = new AccountHealthTracker({ redis: new InMemoryHealthRedis() })
    const recovered = await tracker.halfOpen()
    const recoveredIds = recovered.map((h) => h.id).sort()
    assert.deepEqual(
      recoveredIds,
      [v3Codex, claude].sort(),
      'v5 codex 行的状态权威归 v5,不被 v3 半开',
    )
    const r = await query<{ status: string }>('SELECT status FROM claude_accounts WHERE id = $1', [
      String(v5Codex),
    ])
    assert.equal(r.rows[0].status, 'cooldown', 'v5 codex 行保持 cooldown 原状')
  })
})
