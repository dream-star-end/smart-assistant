/**
 * B3 集成:findCodexDisableDrift 的真 SQL —— 准确选出"state=active 容器绑在
 * provider=codex 且 status<>active 账号上"的漂移行,且不误选健康/异类行。
 *
 * 本地:TEST_DATABASE_URL=postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test \
 *      REQUIRE_TEST_DB=1 npx tsx --test codexDisableDrift.integ.test.ts
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { findCodexDisableDrift } from '../account-pool/codexDisableFanout.js'
import { generatePersona } from '../account-pool/persona.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false
let egressProxyId = ''
let _userCtr = 0

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
  if (pgAvailable) await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE agent_containers, claude_accounts, egress_proxies, users RESTART IDENTITY CASCADE',
  )
  const ep = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce) VALUES ('drift-ep', '\\x00'::bytea, '\\x00'::bytea) RETURNING id::text AS id`,
  )
  egressProxyId = ep.rows[0].id
  _userCtr = 0
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

async function mkAccount(provider: 'codex' | 'claude', status: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, provider, status, oauth_token_enc, oauth_nonce, egress_proxy_id, persona)
     VALUES ($1, 'pro', $2, $3, '\\x00'::bytea, '\\x00'::bytea, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [
      `acct-${provider}-${status}-${Math.floor(performance.now() * 1000)}`,
      provider,
      status,
      egressProxyId,
      JSON.stringify(generatePersona()),
    ],
  )
  return BigInt(r.rows[0].id)
}

async function mkContainer(codexAccountId: bigint | null, state: string): Promise<bigint> {
  // 每个容器一个独立 user:agent_containers 有 UNIQUE(user_id) WHERE state='active'。
  _userCtr += 1
  const u = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1,'argon2$stub',0,'user','active') RETURNING id::text AS id",
    [`c${_userCtr}@t.co`],
  )
  const r = await query<{ id: string }>(
    `INSERT INTO agent_containers(user_id, secret_hash, state, codex_account_id)
     VALUES ($1, decode(repeat('00', 32), 'hex'), $2, $3)
     RETURNING id::text AS id`,
    [u.rows[0].id, state, codexAccountId === null ? null : codexAccountId.toString()],
  )
  return BigInt(r.rows[0].id)
}

describe('findCodexDisableDrift (integ)', () => {
  test('选出 codex disabled/cooldown 账号上的 active 容器;不误选健康/异类行', async (t) => {
    if (skipIfNoPg(t)) return
    const codexDisabled = await mkAccount('codex', 'disabled')
    const codexCooldown = await mkAccount('codex', 'cooldown')
    const codexActive = await mkAccount('codex', 'active')
    const claudeDisabled = await mkAccount('claude', 'disabled')

    const drift1 = await mkContainer(codexDisabled, 'active') // ✓ 漂移
    const drift2 = await mkContainer(codexCooldown, 'active') // ✓ 漂移(status<>active)
    await mkContainer(codexActive, 'active') // ✗ 账号 active
    await mkContainer(claudeDisabled, 'active') // ✗ provider=claude
    await mkContainer(null, 'active') // ✗ codex_account_id NULL
    await mkContainer(codexDisabled, 'vanished') // ✗ 容器非 active

    const rows = await findCodexDisableDrift()
    const ids = rows.map((r) => r.containerId).sort((a, b) => a - b)
    assert.deepEqual(
      ids,
      [Number(drift1), Number(drift2)].sort((a, b) => a - b),
    )
    // accountId 正确回填且为 bigint
    const byContainer = new Map(rows.map((r) => [r.containerId, r.accountId]))
    assert.equal(byContainer.get(Number(drift1)), codexDisabled)
    assert.equal(byContainer.get(Number(drift2)), codexCooldown)
  })

  test('无漂移 → 空数组', async (t) => {
    if (skipIfNoPg(t)) return
    const codexActive = await mkAccount('codex', 'active')
    await mkContainer(codexActive, 'active')
    assert.deepEqual(await findCodexDisableDrift(), [])
  })
})
