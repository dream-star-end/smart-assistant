/**
 * B1 真 PG 集成测试:reconcileStuckFinalizeJournal / gcFinalizeJournal 的 SQL 行为。
 *
 * 单元测试(finalizeJournalReconciler.test.ts)只覆盖 sweeper 包装层 + 阈值钳制;
 * 这里锁真 PG:两条 CAS UPDATE 的分类(有/无 usage_records)、状态守卫(只动
 * inflight/finalizing、不碰终态)、aborted 字段、committed 回填 usage_id/ledger_id/
 * final_credits、GC 只删老终态行且尊重 LIMIT。
 *
 * 本地跑:TEST_DATABASE_URL=postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test \
 *        REQUIRE_TEST_DB=1 npx tsx --test finalizeJournalReconciler.integ.test.ts
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  gcFinalizeJournal,
  reconcileStuckFinalizeJournal,
} from '../billing/finalizeJournalReconciler.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const THRESHOLD_MS = 1_800_000 // 30min
const STUCK_MS = 2_400_000 // 40min(> 阈值 → stuck)
const FRESH_MS = 60_000 // 1min(< 阈值 → 不动)
const GC_AGE_MS = 7 * 24 * 3_600_000 // 7d
const OLD_TERMINAL_MS = 8 * 24 * 3_600_000 // 8d(> GC age)

let pgAvailable = false

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
  assertTestDatabase(TEST_DB_URL)
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await closePool()
    } catch {
      /* ignore */
    }
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE request_finalize_journal, usage_records, credit_ledger, users RESTART IDENTITY CASCADE',
  )
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

async function createUser(email: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  )
  return BigInt(r.rows[0].id)
}

async function insertLedger(userId: bigint, delta: bigint): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO credit_ledger(user_id, delta, balance_after, reason) VALUES ($1, $2, 0, 'chat') RETURNING id::text AS id",
    [userId.toString(), delta.toString()],
  )
  return BigInt(r.rows[0].id)
}

async function insertUsage(
  userId: bigint,
  requestId: string,
  opts: { status?: string; cost?: bigint; ledgerId?: bigint | null } = {},
): Promise<bigint> {
  const status = opts.status ?? 'success'
  const cost = opts.cost ?? 100n
  const r = await query<{ id: string }>(
    `INSERT INTO usage_records(user_id, mode, model, price_snapshot, cost_credits, request_id, status, ledger_id)
     VALUES ($1, 'chat', 'claude-x', '{}'::jsonb, $2, $3, $4, $5)
     RETURNING id::text AS id`,
    [userId.toString(), cost.toString(), requestId, status, opts.ledgerId?.toString() ?? null],
  )
  return BigInt(r.rows[0].id)
}

async function insertJournal(
  requestId: string,
  userId: bigint,
  opts: { state?: string; ageMs?: number; precheck?: bigint } = {},
): Promise<void> {
  const state = opts.state ?? 'inflight'
  const ageMs = opts.ageMs ?? 0
  const precheck = opts.precheck ?? 200n
  await query(
    `INSERT INTO request_finalize_journal(request_id, user_id, ctx, precheck_credits, state, updated_at)
     VALUES ($1, $2, '{"model":"claude-x"}'::jsonb, $3, $4, NOW() - ($5::bigint * INTERVAL '1 millisecond'))`,
    [requestId, userId.toString(), precheck.toString(), state, String(ageMs)],
  )
}

async function getJournal(
  requestId: string,
): Promise<{
  state: string
  final_credits: string | null
  usage_id: string | null
  ledger_id: string | null
  error_msg: string | null
} | null> {
  const r = await query<{
    state: string
    final_credits: string | null
    usage_id: string | null
    ledger_id: string | null
    error_msg: string | null
  }>(
    `SELECT state, final_credits::text AS final_credits, usage_id::text AS usage_id,
            ledger_id::text AS ledger_id, error_msg
       FROM request_finalize_journal WHERE request_id=$1`,
    [requestId],
  )
  return r.rows[0] ?? null
}

describe('reconcileStuckFinalizeJournal (integ)', () => {
  test('stuck inflight + usage_records(success) → committed,回填 usage_id/ledger_id/final_credits', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('a@t.co')
    const ledgerId = await insertLedger(u, 100n)
    const usageId = await insertUsage(u, 'r1', { status: 'success', cost: 137n, ledgerId })
    await insertJournal('r1', u, { state: 'inflight', ageMs: STUCK_MS })
    const res = await reconcileStuckFinalizeJournal(THRESHOLD_MS)
    assert.equal(res.committed, 1)
    assert.equal(res.aborted, 0)
    const j = await getJournal('r1')
    assert.equal(j?.state, 'committed')
    assert.equal(j?.final_credits, '137')
    assert.equal(j?.usage_id, usageId.toString())
    assert.equal(j?.ledger_id, ledgerId.toString())
  })

  test('committed 不按 status 过滤(billing_failed / error 也算结算存在)', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('b@t.co')
    await insertUsage(u, 'r-bf', { status: 'billing_failed', cost: 0n })
    await insertJournal('r-bf', u, { state: 'finalizing', ageMs: STUCK_MS })
    await insertUsage(u, 'r-err', { status: 'error', cost: 0n })
    await insertJournal('r-err', u, { state: 'inflight', ageMs: STUCK_MS })
    const res = await reconcileStuckFinalizeJournal(THRESHOLD_MS)
    assert.equal(res.committed, 2)
    assert.equal(res.aborted, 0)
    assert.equal((await getJournal('r-bf'))?.state, 'committed')
    assert.equal((await getJournal('r-err'))?.state, 'committed')
  })

  test('stuck + 无 usage_records → aborted(reconciler_timeout, final_credits=0)', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('c@t.co')
    await insertJournal('r2', u, { state: 'inflight', ageMs: STUCK_MS })
    await insertJournal('r3', u, { state: 'finalizing', ageMs: STUCK_MS })
    const res = await reconcileStuckFinalizeJournal(THRESHOLD_MS)
    assert.equal(res.committed, 0)
    assert.equal(res.aborted, 2)
    const j = await getJournal('r2')
    assert.equal(j?.state, 'aborted')
    assert.equal(j?.error_msg, 'reconciler_timeout')
    assert.equal(j?.final_credits, '0')
  })

  test('fresh inflight(未到阈值)→ 不动', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('d@t.co')
    await insertJournal('r4', u, { state: 'inflight', ageMs: FRESH_MS })
    const res = await reconcileStuckFinalizeJournal(THRESHOLD_MS)
    assert.equal(res.committed, 0)
    assert.equal(res.aborted, 0)
    assert.equal((await getJournal('r4'))?.state, 'inflight')
  })

  test('已终态行(committed/aborted)不被重复处理', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('e@t.co')
    await insertJournal('r5', u, { state: 'committed', ageMs: STUCK_MS })
    await insertJournal('r6', u, { state: 'aborted', ageMs: STUCK_MS })
    const res = await reconcileStuckFinalizeJournal(THRESHOLD_MS)
    assert.equal(res.committed, 0)
    assert.equal(res.aborted, 0)
    assert.equal((await getJournal('r5'))?.state, 'committed')
    assert.equal((await getJournal('r6'))?.state, 'aborted')
  })
})

describe('gcFinalizeJournal (integ)', () => {
  test('删老终态行,保留 fresh 终态 + 任何 inflight,尊重 LIMIT', async (t) => {
    if (skipIfNoPg(t)) return
    const u = await createUser('f@t.co')
    // 3 个老 committed/aborted(应被删,但 LIMIT=2 一批只删 2)
    await insertJournal('g1', u, { state: 'committed', ageMs: OLD_TERMINAL_MS })
    await insertJournal('g2', u, { state: 'aborted', ageMs: OLD_TERMINAL_MS })
    await insertJournal('g3', u, { state: 'committed', ageMs: OLD_TERMINAL_MS })
    // fresh 终态(应保留)
    await insertJournal('g4', u, { state: 'committed', ageMs: FRESH_MS })
    // 老 inflight(GC 绝不删非终态)
    await insertJournal('g5', u, { state: 'inflight', ageMs: OLD_TERMINAL_MS })

    const del1 = await gcFinalizeJournal(GC_AGE_MS, 2)
    assert.equal(del1, 2, 'LIMIT=2 一批删 2')
    const del2 = await gcFinalizeJournal(GC_AGE_MS, 10)
    assert.equal(del2, 1, '剩下 1 个老终态行被删')
    const del3 = await gcFinalizeJournal(GC_AGE_MS, 10)
    assert.equal(del3, 0, '没有更多老终态行')

    // fresh 终态 + 老 inflight 仍在
    assert.equal((await getJournal('g4'))?.state, 'committed')
    assert.equal((await getJournal('g5'))?.state, 'inflight')
  })
})
