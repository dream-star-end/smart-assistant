import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { SocialLoginError, socialLoginOrCreate } from '../auth/socialLogin.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

/**
 * LDC SSO 业务编排集成测试 — socialLoginOrCreate 端到端打通真 Postgres。
 *
 * 验收点:
 *   1. 首登:users + oauth_identities + credit_ledger 各 1 行,credits 按
 *      bonusForTrustLevel 阶梯计算,memo 含 "LINUX DO ... 赠送 ¥X (TL{n})";
 *      access/refresh token 都签出来,refresh_tokens 插入一行(remember_me=TRUE)。
 *   2. 二登:同 (provider, provider_user_id) 不创建新用户、不双发积分,
 *      **trust_level 升级也不补差额**。LDC 侧改昵称/换头像/升 TL → identity
 *      行的快照字段被 UPDATE。
 *   3. 用户被 ban(status='banned')→ 抛 SocialLoginError(USER_DISABLED)。
 *   4. provider_user_id 不合法 → 抛 SocialLoginError(INVALID_INPUT)。
 *   5. 并发首登 race:两个 tx 同时落 → advisory_xact_lock 串行化,
 *      共建 1 个 user / 1 个 identity / 1 行 ledger,无 23505。
 *   6. trust_level 阶梯覆盖:TL0/TL3/TL4 各自首登赠金等于阶梯金额。
 *
 * 全部用 testJwtSecret 签 token,不调外网。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'

const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

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
  'refresh_tokens',
  'email_verifications',
  'oauth_identities',
  'users',
  'schema_migrations',
]

async function cleanCommercialSchema(): Promise<void> {
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(', ')} CASCADE`
  await query(sql)
}

async function probe(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  })
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

const testJwtSecret = 'test-secret-32bytes-test-secret-3'

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        'Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). ' +
          'Start it: docker compose -f tests/fixtures/docker-compose.test.yml up -d',
      )
    }
    return
  }
  await resetPool()
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 })
  setPoolOverride(pool)
  await cleanCommercialSchema()
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await cleanCommercialSchema()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE refresh_tokens, oauth_identities, credit_ledger, email_verifications, users RESTART IDENTITY CASCADE',
  )
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

describe('auth.socialLoginOrCreate (linuxdo, integ)', () => {
  test('first login (TL2) creates user + identity + ¥10 (1000 cents) + ledger row', async (t) => {
    if (skipIfNoPg(t)) return
    const result = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '12345',
        username: 'alice_ldo',
        email: 'alice@ldo.example',
        trustLevel: 2,
        avatarUrl: 'https://cdn.linux.do/u/12345.png',
      },
      { jwtSecret: testJwtSecret, userAgent: 'test-ua', bindIp: '127.0.0.1' },
    )

    assert.equal(result.isNew, true)
    assert.ok(result.access_token)
    assert.ok(result.refresh_token)
    assert.equal(result.remember, true)
    assert.equal(result.user.email, 'linuxdo-12345@users.claudeai.chat')
    assert.equal(result.user.email_verified, true)
    assert.equal(result.user.credits, '1000')
    assert.equal(result.user.role, 'user')
    assert.equal(result.user.display_name, 'alice_ldo')

    const u = await query<{ cnt: string; credits: string; status: string; email: string }>(
      'SELECT COUNT(*)::text AS cnt, MIN(credits::text) AS credits, MIN(status) AS status, MIN(email) AS email FROM users',
    )
    assert.equal(u.rows[0].cnt, '1')
    assert.equal(u.rows[0].credits, '1000')
    assert.equal(u.rows[0].status, 'active')
    assert.equal(u.rows[0].email, 'linuxdo-12345@users.claudeai.chat')

    const oi = await query<{
      cnt: string
      provider: string
      pid: string
      username: string
      trust_level: number | null
      avatar_url: string | null
    }>(
      `SELECT COUNT(*)::text AS cnt, MIN(provider) AS provider,
              MIN(provider_user_id) AS pid, MIN(username) AS username,
              MIN(trust_level) AS trust_level, MIN(avatar_url) AS avatar_url
         FROM oauth_identities`,
    )
    assert.equal(oi.rows[0].cnt, '1')
    assert.equal(oi.rows[0].provider, 'linuxdo')
    assert.equal(oi.rows[0].pid, '12345')
    assert.equal(oi.rows[0].username, 'alice_ldo')
    assert.equal(oi.rows[0].trust_level, 2)
    assert.equal(oi.rows[0].avatar_url, 'https://cdn.linux.do/u/12345.png')

    const led = await query<{
      cnt: string
      delta: string
      balance_after: string
      reason: string
      memo: string | null
    }>(
      `SELECT COUNT(*)::text AS cnt, MIN(delta::text) AS delta,
              MIN(balance_after::text) AS balance_after, MIN(reason) AS reason,
              MIN(memo) AS memo FROM credit_ledger`,
    )
    assert.equal(led.rows[0].cnt, '1')
    assert.equal(led.rows[0].delta, '1000')
    assert.equal(led.rows[0].balance_after, '1000')
    assert.equal(led.rows[0].reason, 'promotion')
    assert.match(led.rows[0].memo ?? '', /LINUX DO/)
    assert.match(led.rows[0].memo ?? '', /赠送/)
    assert.match(led.rows[0].memo ?? '', /¥10/)
    assert.match(led.rows[0].memo ?? '', /TL2/)

    const rt = await query<{
      cnt: string
      remember: boolean
      ua: string | null
      ip: string | null
    }>(
      `SELECT COUNT(*)::text AS cnt, MIN(remember_me::text)::boolean AS remember,
              MIN(user_agent) AS ua, MIN(ip::text) AS ip FROM refresh_tokens`,
    )
    assert.equal(rt.rows[0].cnt, '1')
    assert.equal(rt.rows[0].remember, true)
    assert.equal(rt.rows[0].ua, 'test-ua')
    assert.equal(rt.rows[0].ip, '127.0.0.1')
  })

  test('second login: no double bonus, identity snapshot updated', async (t) => {
    if (skipIfNoPg(t)) return
    const r1 = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '777',
        username: 'oldname',
        email: null,
        trustLevel: 1,
        avatarUrl: null,
      },
      { jwtSecret: testJwtSecret },
    )
    assert.equal(r1.isNew, true)

    const r2 = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '777',
        username: 'newname',
        email: null,
        trustLevel: 3,
        avatarUrl: 'https://cdn.linux.do/u/777_v2.png',
      },
      { jwtSecret: testJwtSecret },
    )
    assert.equal(r2.isNew, false)
    assert.equal(r2.user.id, r1.user.id)

    const u = await query<{ cnt: string; credits: string }>(
      `SELECT COUNT(*)::text AS cnt, MIN(credits::text) AS credits FROM users`,
    )
    assert.equal(u.rows[0].cnt, '1', '二登必须复用同一行 user')
    // 首登 TL1 = ¥5 (500 cents);二登 TL 升到 3 但不补差额(产品决策)。
    assert.equal(u.rows[0].credits, '500', '二登不发新积分,且 TL 升级不补差')

    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '1', '二登不写新 ledger')

    const oi = await query<{
      username: string
      trust_level: number | null
      avatar_url: string | null
    }>(
      `SELECT username, trust_level, avatar_url FROM oauth_identities WHERE provider_user_id='777'`,
    )
    assert.equal(oi.rows[0].username, 'newname', 'identity username 必须 UPDATE')
    assert.equal(oi.rows[0].trust_level, 3, 'trust_level 必须 UPDATE')
    assert.equal(oi.rows[0].avatar_url, 'https://cdn.linux.do/u/777_v2.png')
  })

  test('banned user → SocialLoginError(USER_DISABLED)', async (t) => {
    if (skipIfNoPg(t)) return
    const r1 = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '999',
        username: 'banned_user',
        email: null,
        trustLevel: null,
        avatarUrl: null,
      },
      { jwtSecret: testJwtSecret },
    )
    await query(`UPDATE users SET status='banned' WHERE id=$1`, [r1.user.id])

    await assert.rejects(
      socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: '999',
          username: 'banned_user',
          email: null,
          trustLevel: null,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret },
      ),
      (err: unknown) => err instanceof SocialLoginError && err.code === 'USER_DISABLED',
    )
  })

  test('invalid provider_user_id → SocialLoginError(INVALID_INPUT)', async (t) => {
    if (skipIfNoPg(t)) return
    await assert.rejects(
      socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: 'has space and !!!',
          username: 'x',
          email: null,
          trustLevel: null,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret },
      ),
      (err: unknown) => err instanceof SocialLoginError && err.code === 'INVALID_INPUT',
    )
    const u = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM users')
    assert.equal(u.rows[0].cnt, '0', 'INVALID_INPUT 不应留下任何 DB 副作用')
  })

  test('concurrent first login: advisory lock serializes — 1 user, 1 identity, 1 ledger', async (t) => {
    if (skipIfNoPg(t)) return
    // 同 provider_user_id 并发两个 callback,advisory lock 必须把第二个阻塞到第一个
    // commit 后,第二个 SELECT 命中已建 identity,走"已存在"路径不重复送积分。
    const calls = await Promise.allSettled([
      socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: '424242',
          username: 'race_a',
          email: null,
          trustLevel: 1,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret },
      ),
      socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: '424242',
          username: 'race_b',
          email: null,
          trustLevel: 1,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret },
      ),
    ])
    // 两个都要 fulfilled(没人因 23505 失败)
    assert.equal(calls.length, 2)
    assert.equal(
      calls[0].status,
      'fulfilled',
      `c0 should not throw: ${(calls[0] as PromiseRejectedResult).reason}`,
    )
    assert.equal(
      calls[1].status,
      'fulfilled',
      `c1 should not throw: ${(calls[1] as PromiseRejectedResult).reason}`,
    )

    const u = await query<{ cnt: string; credits: string }>(
      `SELECT COUNT(*)::text AS cnt, MIN(credits::text) AS credits FROM users`,
    )
    assert.equal(u.rows[0].cnt, '1', '并发只该建 1 个 user')
    // 两边都传 TL1 = 500 cents,并发不能双发(advisory lock 序列化)
    assert.equal(u.rows[0].credits, '500', '并发不能双发积分')

    const oi = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM oauth_identities WHERE provider_user_id='424242'`,
    )
    assert.equal(oi.rows[0].cnt, '1', '并发只该建 1 个 identity')

    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '1', '并发只该写 1 行 ledger')
  })
})

describe('auth.socialLoginOrCreate (linuxdo) — trust_level bonus tier coverage', () => {
  // 覆盖 TL0/TL3/TL4 三档首登赠金,确保阶梯生效。
  // TL1=¥5 已被并发测试覆盖,TL2=¥10 已被 first-login 主测试覆盖。
  const tiers: Array<{
    tl: number
    pid: string
    expectedCredits: string
    expectedYuan: string
    expectedTlLabel: string
  }> = [
    { tl: 0, pid: '500000', expectedCredits: '300', expectedYuan: '¥3', expectedTlLabel: 'TL0' },
    { tl: 3, pid: '500003', expectedCredits: '2000', expectedYuan: '¥20', expectedTlLabel: 'TL3' },
    { tl: 4, pid: '500004', expectedCredits: '3000', expectedYuan: '¥30', expectedTlLabel: 'TL4' },
  ]

  for (const tier of tiers) {
    test(`first login (TL${tier.tl}) → ${tier.expectedYuan} (${tier.expectedCredits} cents)`, async (t) => {
      if (skipIfNoPg(t)) return
      const result = await socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: tier.pid,
          username: `tl${tier.tl}_user`,
          email: null,
          trustLevel: tier.tl,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret },
      )
      assert.equal(result.isNew, true)
      assert.equal(result.user.credits, tier.expectedCredits)

      const u = await query<{ credits: string }>(
        'SELECT credits::text AS credits FROM users WHERE id = $1',
        [result.user.id],
      )
      assert.equal(u.rows[0].credits, tier.expectedCredits, 'users.credits 必须等于阶梯金额')

      const led = await query<{ delta: string; balance_after: string; memo: string | null }>(
        `SELECT delta::text AS delta, balance_after::text AS balance_after, memo
           FROM credit_ledger WHERE user_id = $1`,
        [result.user.id],
      )
      assert.equal(led.rows.length, 1, '阶梯首登只写 1 行 ledger')
      assert.equal(led.rows[0].delta, tier.expectedCredits)
      assert.equal(led.rows[0].balance_after, tier.expectedCredits)
      assert.match(led.rows[0].memo ?? '', new RegExp(tier.expectedYuan))
      assert.match(led.rows[0].memo ?? '', new RegExp(tier.expectedTlLabel))
    })
  }
})
