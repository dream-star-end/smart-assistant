/**
 * OCV5-574 commercial Muse credits on real Postgres (0319).
 *
 *   1. settle marks the running row succeeded and charges it in one transaction:
 *      credit_ledger reason 'muse_media', ref muse_media_job, users.credits down by the price.
 *   2. a second settle of the same job charges nothing (the row is no longer running).
 *   3. a job that is not running (failed / cancelled / orphan-closed) is never charged.
 *   4. ensureBalance refuses a requirement above the spendable balance (402).
 *   5. the CHECK keeps cost_credits on succeeded rows only.
 *   6. outcome() tells a committed charge from none (a lost COMMIT reply); openCredits() sums the
 *      quotes of open jobs only, whichever process wrote them; findJob() returns delivered files.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { createMuseBilling } from '../muse/billing.js'
import { MuseError } from '../muse/protocol.js'
import { createPgMuseStore } from '../muse/store.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

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
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetTestSchemaForTest()
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetTestSchemaForTest()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE muse_media_jobs, credit_ledger, user_subscriptions, users RESTART IDENTITY CASCADE',
  )
})

async function user(credits: bigint): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, credits)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`m${randomUUID().slice(0, 8)}@t.local`, credits.toString()],
  )
  return r.rows[0]!.id
}

async function job(
  userId: string,
  status: 'running' | 'failed',
  kind: 'image' | 'video' = 'image',
) {
  const id = `mj_${randomUUID()}`
  await query(
    `INSERT INTO muse_media_jobs (id, user_id, kind, prompt_sha256, prompt_preview, params, status)
     VALUES ($1, $2, $3, '\\x00'::bytea, 'p', '{}'::jsonb, $4)`,
    [id, userId, kind, status],
  )
  return id
}

const PRICES = { image: 10, video: 50 }
const settleInput = (jobId: string, userId: string, kind: 'image' | 'video', price: bigint) => ({
  jobId,
  userId,
  kind,
  price,
  files: [{ mime: 'image/webp', bytes: 4000, sha256: 'a'.repeat(64) }],
  artifactIds: ['media-artifact:x'],
  snapshotId: 'snap:1',
})

describe('Muse billing (OCV5-574)', () => {
  test('settle records the success and charges once, atomically', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(1000n)
    const id = await job(uid, 'running', 'video')
    const out = await billing.settle(settleInput(id, uid, 'video', 50n))
    assert.equal(out.debitedCredits, 50n)
    const row = await query<{
      status: string
      cost_credits: string
      debited_credits: string
      ledger_id: string
    }>(
      'SELECT status, cost_credits::text, debited_credits::text, ledger_id::text FROM muse_media_jobs WHERE id = $1',
      [id],
    )
    assert.deepEqual(
      { ...row.rows[0], ledger_id: row.rows[0]!.ledger_id !== null },
      { status: 'succeeded', cost_credits: '50', debited_credits: '50', ledger_id: true },
    )
    const ledger = await query<{ reason: string; delta: string; ref_type: string; ref_id: string }>(
      'SELECT reason, delta::text, ref_type, ref_id FROM credit_ledger WHERE user_id = $1',
      [uid],
    )
    assert.deepEqual(ledger.rows, [
      { reason: 'muse_media', delta: '-50', ref_type: 'muse_media_job', ref_id: id },
    ])
    const credits = await query<{ credits: string }>(
      'SELECT credits::text FROM users WHERE id = $1',
      [uid],
    )
    assert.equal(credits.rows[0]!.credits, '950')

    await assert.rejects(billing.settle(settleInput(id, uid, 'video', 50n)), /MUSE_JOB_NOT_RUNNING/)
    const after = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM credit_ledger WHERE user_id = $1',
      [uid],
    )
    assert.equal(after.rows[0]!.n, '1', 'no second charge')
  })

  test('a job that is not running is never charged', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(1000n)
    const id = await job(uid, 'failed')
    await assert.rejects(billing.settle(settleInput(id, uid, 'image', 10n)), /MUSE_JOB_NOT_RUNNING/)
    const ledger = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM credit_ledger')
    assert.equal(ledger.rows[0]!.n, '0')
    const credits = await query<{ credits: string }>(
      'SELECT credits::text FROM users WHERE id = $1',
      [uid],
    )
    assert.equal(credits.rows[0]!.credits, '1000')
  })

  test('ensureBalance refuses a requirement above the spendable balance', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(55n)
    await billing.ensureBalance(uid, 50n)
    await assert.rejects(
      billing.ensureBalance(uid, 60n),
      (e: unknown) =>
        e instanceof MuseError && e.code === 'MUSE_INSUFFICIENT_CREDITS' && e.status === 402,
    )
  })

  test('only a succeeded row can carry a charge', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const uid = await user(0n)
    const id = await job(uid, 'failed')
    await assert.rejects(
      query('UPDATE muse_media_jobs SET cost_credits = 10 WHERE id = $1', [id]),
      /muse_media_jobs_charge_only_succeeded/,
    )
  })

  test('outcome reports a committed charge and nothing for an uncharged job', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(1000n)
    const paid = await job(uid, 'running', 'video')
    await billing.settle(settleInput(paid, uid, 'video', 50n))
    assert.deepEqual(await billing.outcome(paid), { charged: true, debitedCredits: 50n })
    const failed = await job(uid, 'failed')
    assert.deepEqual(await billing.outcome(failed), { charged: false, debitedCredits: null })
    const running = await job(uid, 'running')
    assert.deepEqual(await billing.outcome(running), { charged: false, debitedCredits: null })
  })

  test('openCredits sums open quotes only; findJob returns the delivered files', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const store = createPgMuseStore(getPool())
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(1000n)
    const insert = (kind: 'image' | 'video', price: bigint) => {
      const id = `mj_${randomUUID()}`
      return store
        .insertJob({
          id,
          userId: uid,
          containerId: null,
          kind,
          promptSha256: Buffer.alloc(32),
          promptPreview: 'p',
          params: {},
          priceCredits: price,
        })
        .then(() => id)
    }
    const video = await insert('video', 50n)
    await insert('image', 10n)
    assert.equal(await store.openCredits(uid), 60n)
    await query("UPDATE muse_media_jobs SET status = 'running' WHERE id = $1", [video])
    await billing.settle(settleInput(video, uid, 'video', 50n))
    assert.equal(await store.openCredits(uid), 10n, 'a succeeded job is no longer open')
    const rec = await store.findJob(uid, video)
    assert.equal(rec?.status, 'succeeded')
    assert.equal(rec?.debitedCredits, '50')
    assert.deepEqual(rec?.files, [{ mime: 'image/webp', bytes: 4000, sha256: 'a'.repeat(64) }])
    assert.equal(rec?.snapshotId, 'snap:1')
    assert.equal(await store.findJob(String(Number(uid) + 999), video), null)
  })

  test('outcome waits for a settle still in flight and reads its final result', async (t) => {
    if (!pgAvailable) return t.skip('no test database')
    const billing = createMuseBilling(getPool(), PRICES)
    const uid = await user(1000n)
    const id = await job(uid, 'running', 'image')
    // Stand-in for a settle whose COMMIT reply was lost: the row is locked and not yet committed.
    const inFlight = await getPool().connect()
    try {
      await inFlight.query('BEGIN')
      await inFlight.query(
        "UPDATE muse_media_jobs SET status = 'succeeded', cost_credits = 10, debited_credits = 10 WHERE id = $1",
        [id],
      )
      const pending = billing.outcome(id)
      const early = await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r('waiting'), 300)),
      ])
      assert.equal(early, 'waiting', 'a plain read would have said running')
      await inFlight.query('COMMIT')
      assert.deepEqual(await pending, { charged: true, debitedCredits: 10n })
    } finally {
      inFlight.release()
    }
  })
})
