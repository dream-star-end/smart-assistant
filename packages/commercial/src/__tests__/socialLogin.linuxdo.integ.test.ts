import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { SocialLoginError, socialLoginOrCreate } from '../auth/socialLogin.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

/**
 * LDC SSO 业务编排集成测试 — socialLoginOrCreate 端到端打通真 Postgres。
 *
 * 验收点:
 *   1. 首登:users + oauth_identities 各 1 行;赠金已下线(2026-07-07)→
 *      credits=0、credit_ledger 零行;
 *      access/refresh token 都签出来,refresh_tokens 插入一行(remember_me=TRUE)。
 *   2. 二登:同 (provider, provider_user_id) 不创建新用户、不双发积分,
 *      **trust_level 升级也不补差额**。LDC 侧改昵称/换头像/升 TL → identity
 *      行的快照字段被 UPDATE。
 *   3. 用户被 ban(status='banned')→ 抛 SocialLoginError(USER_DISABLED)。
 *   4. provider_user_id 不合法 → 抛 SocialLoginError(INVALID_INPUT)。
 *   5. 并发首登 race:两个 tx 同时落 → advisory_xact_lock 串行化,
 *      共建 1 个 user / 1 个 identity / 1 行 ledger,无 23505。
 *   6. trust_level 覆盖:TL0/TL3/TL4 首登一律零赠金(TL 只作 identity 快照)。
 *
 * 全部用 testJwtSecret 签 token,不调外网。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'

const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function cleanCommercialSchema(): Promise<void> {
  await resetTestSchemaForTest()
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
          'See packages/commercial/README.md for bootstrap.',
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
  test('first login (TL2) creates user + identity,零赠金零 ledger(赠金已下线)', async (t) => {
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
    assert.equal(result.user.credits, '0')
    assert.equal(result.user.role, 'user')
    assert.equal(result.user.display_name, 'alice_ldo')

    const u = await query<{ cnt: string; credits: string; status: string; email: string }>(
      'SELECT COUNT(*)::text AS cnt, MIN(credits::text) AS credits, MIN(status) AS status, MIN(email) AS email FROM users',
    )
    assert.equal(u.rows[0].cnt, '1')
    assert.equal(u.rows[0].credits, '0')
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
    assert.equal(led.rows[0].cnt, '0', '首登不写任何 ledger(赠金已下线)')

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
    // pg 把 inet 类型 cast::text 后会带 /32 mask(127.0.0.1/32),取消尾部网段再比
    assert.equal((rt.rows[0].ip ?? '').replace(/\/\d+$/, ''), '127.0.0.1')
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
    // 首登赠金已下线;二登 TL 升级同样零积分。
    assert.equal(u.rows[0].credits, '0', '首登/二登均零积分')

    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '0', '二登同样零 ledger(赠金已下线)')

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

  // ── allowCreate gate(2026-05-25 注册关停)─────────────────────────
  //
  // 设计语义验证:
  //   1. allowCreate=false + identity miss → REGISTRATION_DISABLED,无任何 DB 副作用
  //      (advisory lock 持仓的 tx 内部 throw,自动回滚 lock + 不写 users/identity/ledger)
  //   2. allowCreate=false + identity hit → 老用户登录不受影响(关停只 apply 到"新建"分支)
  //   3. allowCreate=true(默认)+ identity miss → 仍按原行为建账号(向下兼容)

  test('allowCreate=false + identity miss → REGISTRATION_DISABLED (no DB writes)', async (t) => {
    if (skipIfNoPg(t)) return
    await assert.rejects(
      socialLoginOrCreate(
        {
          provider: 'linuxdo',
          providerUserId: '8001',
          username: 'newcomer',
          email: null,
          trustLevel: 2,
          avatarUrl: null,
        },
        { jwtSecret: testJwtSecret, allowCreate: false },
      ),
      (err: unknown) =>
        err instanceof SocialLoginError && err.code === 'REGISTRATION_DISABLED',
    )
    const u = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM users')
    assert.equal(u.rows[0].cnt, '0', 'REGISTRATION_DISABLED 不该建 user')
    const oi = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM oauth_identities')
    assert.equal(oi.rows[0].cnt, '0', 'REGISTRATION_DISABLED 不该建 identity')
    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '0', 'REGISTRATION_DISABLED 不该写 ledger')
    const rt = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM refresh_tokens')
    assert.equal(rt.rows[0].cnt, '0', 'REGISTRATION_DISABLED 不该签 refresh token')
  })

  test('allowCreate=false + identity hit → existing LDC user logs in normally', async (t) => {
    if (skipIfNoPg(t)) return
    // 先用 allowCreate=true 建一个老 LDC 用户
    const seeded = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '8002',
        username: 'oldhand',
        email: null,
        trustLevel: 1,
        avatarUrl: null,
      },
      { jwtSecret: testJwtSecret, allowCreate: true },
    )
    assert.equal(seeded.isNew, true)

    // 全局关停后再来登录:identity 命中 → 走"老用户登录"分支,allowCreate=false 不应拦
    const r = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: '8002',
        username: 'oldhand_v2',
        email: null,
        trustLevel: 2,
        avatarUrl: 'https://cdn.linux.do/u/8002.png',
      },
      { jwtSecret: testJwtSecret, allowCreate: false },
    )
    assert.equal(r.isNew, false)
    assert.equal(r.user.id, seeded.user.id)
    assert.ok(r.access_token)
    assert.ok(r.refresh_token)

    // 不双发积分;identity 快照按常规升级路径 UPDATE
    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '0', '老用户复登零 ledger(赠金已下线)')
    const oi = await query<{ username: string; trust_level: number | null }>(
      `SELECT username, trust_level FROM oauth_identities WHERE provider_user_id='8002'`,
    )
    assert.equal(oi.rows[0].username, 'oldhand_v2', 'identity snapshot 应被 UPDATE')
    assert.equal(oi.rows[0].trust_level, 2)
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

  test('concurrent first login: advisory lock serializes — 1 user, 1 identity, 0 ledger', async (t) => {
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
    // 赠金已下线:并发首登同样零积分(advisory lock 序列化只保 1 user)
    assert.equal(u.rows[0].credits, '0', '并发首登零积分')

    const oi = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM oauth_identities WHERE provider_user_id='424242'`,
    )
    assert.equal(oi.rows[0].cnt, '1', '并发只该建 1 个 identity')

    const led = await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM credit_ledger')
    assert.equal(led.rows[0].cnt, '0', '并发首登零 ledger(赠金已下线)')
  })
})

describe('auth.socialLoginOrCreate (linuxdo) — 首登零赠金,与 TL 无关(赠金已下线)', () => {
  // 2026-07-07 起注册赠金机制整体下线。覆盖 TL0/TL3/TL4 三档回归:任何 TL 首登
  // credits 恒 0、零 ledger;TL 仅存 oauth_identities 快照。
  const tiers: Array<{ tl: number; pid: string }> = [
    { tl: 0, pid: '500000' },
    { tl: 3, pid: '500003' },
    { tl: 4, pid: '500004' },
  ]

  for (const tier of tiers) {
    test(`first login (TL${tier.tl}) → 零赠金零 ledger`, async (t) => {
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
      assert.equal(result.user.credits, '0')

      const u = await query<{ credits: string }>(
        'SELECT credits::text AS credits FROM users WHERE id = $1',
        [result.user.id],
      )
      assert.equal(u.rows[0].credits, '0', '任何 TL 首登 credits 恒 0')

      const led = await query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1',
        [result.user.id],
      )
      assert.equal(led.rows[0].cnt, '0', '零 ledger 行')
    })
  }
})
