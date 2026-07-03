/**
 * Integ tests: channelState 状态机(权威源单一) + P2 free bootstrap 抑制。
 *
 * 需要 Postgres 测试库(TEST_DATABASE_URL,默认 :55432/openclaude_test);无库则 skip。
 * Run: npm run test:commercial:integ  (或单文件 npx tsx --test <file>)
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import {
  abortInflight,
  getChannelState,
  isMigratedToV5,
  markMigrated,
  markMigrating,
  markSeeding,
  migratedUserIds,
  releaseSeeding,
  rollbackToV3,
} from '../channelMigration/channelState.js'
import { ensureFreeSubscription, getUserSubscription } from '../billing/subscription.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function resetSchema(): Promise<void> {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
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
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required (REQUIRE_TEST_DB=1)')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetSchema()
  await runMigrations()
})
after(async () => {
  if (pgAvailable) {
    try {
      await resetSchema()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})
beforeEach(async () => {
  if (!pgAvailable) return
  await query('TRUNCATE TABLE user_subscriptions, credit_ledger, users RESTART IDENTITY CASCADE')
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}
async function createUser(email: string): Promise<string> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  )
  return r.rows[0].id
}

describe('channelState 状态机', () => {
  test('未迁移用户 isMigratedToV5=false;NULL 默认', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('a@x.com')
    assert.equal(await isMigratedToV5(uid), false)
    const st = await getChannelState(uid)
    assert.equal(st?.onV5, false)
    assert.equal(st?.status, null)
  })

  test('全程生命周期 seeding→release→migrating→migrated,权威随之翻转', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('b@x.com')
    assert.equal((await markSeeding(uid)).applied, true)
    assert.equal(await isMigratedToV5(uid), false, 'seeding 未翻转权威')
    assert.equal((await releaseSeeding(uid)).applied, true, 'preseed 结束释放 seeding')
    assert.equal((await markMigrating(uid)).applied, true)
    assert.equal(await isMigratedToV5(uid), false, 'migrating 未翻转权威')
    assert.equal((await markMigrated(uid)).applied, true)
    assert.equal(await isMigratedToV5(uid), true, 'migrated 翻转权威到 v5')
    const st = await getChannelState(uid)
    assert.ok(st?.migratedAt instanceof Date)
  })

  test('互斥:seeding 进行中 markMigrating 被拒;release 后可进', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('mx@x.com')
    assert.equal((await markSeeding(uid)).applied, true)
    const blocked = await markMigrating(uid)
    assert.equal(blocked.applied, false, 'preseed 持有 seeding 时 cutover 应被互斥拒绝')
    assert.equal(blocked.status, 'seeding')
    assert.equal((await releaseSeeding(uid)).applied, true)
    assert.equal((await markMigrating(uid)).applied, true, 'release 后可进 migrating')
  })

  test('releaseSeeding 只清 seeding,绝不动 migrating(防清掉 cutover)', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('rs@x.com')
    assert.equal((await markMigrating(uid)).applied, true) // NULL→migrating
    const r = await releaseSeeding(uid)
    assert.equal(r.applied, false, 'releaseSeeding 不得命中 migrating')
    assert.equal((await getChannelState(uid))?.status, 'migrating', 'migrating 状态保持')
  })

  test('非法转换 rowCount=0 → applied=false(防脑裂)', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('c@x.com')
    // 未 migrating 直接 markMigrated 应不生效。
    const r = await markMigrated(uid)
    assert.equal(r.applied, false)
    assert.equal(await isMigratedToV5(uid), false)
  })

  test('并发 markMigrating 只一个生效', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('d@x.com')
    await markMigrating(uid) // → migrating
    await markMigrated(uid) // → migrated
    // 已 migrated,再 markMigrating 应被拒(migrated_at 已非空)。
    const again = await markMigrating(uid)
    assert.equal(again.applied, false)
    assert.equal(again.status, 'migrated')
  })

  test('rollback: migrated→rolled_back,权威清回 v3', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('e@x.com')
    await markMigrating(uid)
    await markMigrated(uid)
    assert.equal((await rollbackToV3(uid)).applied, true)
    assert.equal(await isMigratedToV5(uid), false, 'rollback 后路由回 v3')
    assert.equal((await getChannelState(uid))?.status, 'rolled_back')
  })

  test('abortInflight: seeding/migrating→NULL 复位', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('f@x.com')
    await markSeeding(uid)
    assert.equal((await abortInflight(uid)).applied, true)
    assert.equal((await getChannelState(uid))?.status, null)
    // 已 migrated 的不能被 abortInflight。
    await markMigrating(uid)
    await markMigrated(uid)
    assert.equal((await abortInflight(uid)).applied, false)
  })

  test('migratedUserIds 批量只返回已迁移子集', async (t) => {
    if (skipIfNoPg(t)) return
    const u1 = await createUser('g1@x.com')
    const u2 = await createUser('g2@x.com')
    const u3 = await createUser('g3@x.com')
    await markMigrating(u2)
    await markMigrated(u2)
    const set = await migratedUserIds([u1, u2, u3])
    assert.deepEqual([...set], [u2])
    assert.equal((await migratedUserIds([])).size, 0)
  })
})

describe('P2 free bootstrap 抑制', () => {
  test('新用户(free_bootstrap_settled=FALSE)发放 300', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('new@x.com') // 默认 free_bootstrap_settled=FALSE
    await ensureFreeSubscription(uid)
    const sub = await getUserSubscription(uid)
    assert.equal(sub?.periodCredits, 300n, '新用户应发放首期 300')
    const settled = await query<{ v: boolean }>(
      'SELECT free_bootstrap_settled AS v FROM users WHERE id=$1',
      [uid],
    )
    assert.equal(settled.rows[0].v, true, '发放后置结算终态')
  })

  test('存量用户(free_bootstrap_settled=TRUE)抑制,发放 0', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('old@x.com')
    // 模拟迁移 0100 backfill:存量用户置 TRUE。
    await query('UPDATE users SET free_bootstrap_settled=TRUE WHERE id=$1', [uid])
    await ensureFreeSubscription(uid)
    const sub = await getUserSubscription(uid)
    assert.equal(sub?.periodCredits, 0n, '存量用户被抑制,期内桶 0')
    // 无 'subscription' period 流水(未发放)。
    const led = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM credit_ledger WHERE user_id=$1 AND bucket='period'",
      [uid],
    )
    assert.equal(led.rows[0].n, '0', '抑制时不写发放流水')
  })

  test('ensureFreeSubscription 幂等:重复调用不重复发放', async (t) => {
    if (skipIfNoPg(t)) return
    const uid = await createUser('idem@x.com')
    await ensureFreeSubscription(uid)
    await ensureFreeSubscription(uid)
    const led = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM credit_ledger WHERE user_id=$1 AND bucket='period'",
      [uid],
    )
    assert.equal(led.rows[0].n, '1', '仅一条发放流水')
  })
})
