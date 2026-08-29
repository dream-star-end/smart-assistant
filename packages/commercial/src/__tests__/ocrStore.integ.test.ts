import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

process.env.DATABASE_URL = TEST_DB_URL

const { closePool, createPool, getPool, resetPool, setPoolOverride } = await import(
  '../db/index.js'
)
const { runMigrations } = await import('../db/migrate.js')
const { query } = await import('../db/queries.js')
const { PgOcrJobStore } = await import('../ocr/ocrStore.js')
const { resetTestSchemaForTest } = await import('./helpers/db.js')

let pgAvailable = false
let pool: Pool

before(async () => {
  const probe = createPool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return
  await resetPool()
  pool = createPool({ connectionString: TEST_DB_URL, max: 4 })
  setPoolOverride(pool)
  await resetTestSchemaForTest()
  await runMigrations()
})

after(async () => {
  if (!pgAvailable) return
  await resetTestSchemaForTest().catch(() => undefined)
  await closePool()
})

async function user(email: string): Promise<number> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,email_verified)
     VALUES ($1,'x',TRUE) RETURNING id::text AS id`,
    [email],
  )
  return Number(result.rows[0]!.id)
}

describe('SCNet OCR durable store', () => {
  test('enforces tenant reads, cancellation fencing, completion publication and expiry GC', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    const firstUser = await user(`ocr-a-${Date.now()}@test.local`)
    const secondUser = await user(`ocr-b-${Date.now()}@test.local`)
    const store = new PgOcrJobStore(getPool())

    const cancelled = await store.create({
      id: randomUUID(),
      userId: firstUser,
      filename: 'cancel.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12,
    })
    assert.equal(await store.get(secondUser, cancelled.id), null)
    await store.markSubmitted(firstUser, cancelled.id, 'provider-cancel', 'queued')
    assert.equal((await store.cancel(firstUser, cancelled.id))?.status, 'cancelled')
    assert.equal(
      await store.markCompleted({
        id: cancelled.id,
        userId: firstUser,
        pagesTotal: 1,
        markdownPath: '/tmp/cancel.md',
        jsonlPath: '/tmp/cancel.jsonl',
      }),
      false,
    )
    assert.equal((await store.get(firstUser, cancelled.id))?.status, 'cancelled')

    const completed = await store.create({
      id: randomUUID(),
      userId: firstUser,
      filename: 'complete.pdf',
      contentType: 'application/pdf',
      sizeBytes: 24,
    })
    await store.markSubmitted(firstUser, completed.id, 'provider-complete', 'running')
    assert.equal(
      await store.markCompleted({
        id: completed.id,
        userId: firstUser,
        pagesTotal: 3,
        markdownPath: '/tmp/complete.md',
        jsonlPath: '/tmp/complete.jsonl',
      }),
      true,
    )
    const row = await store.get(firstUser, completed.id)
    assert.equal(row?.status, 'completed')
    assert.equal(row?.pagesTotal, 3)
    assert.ok(row?.expiresAt)

    await assert.rejects(
      query(
        `UPDATE ocr_jobs
            SET status='completed',pages_total=NULL,markdown_path=NULL,jsonl_path=NULL
          WHERE id=$1`,
        [cancelled.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )

    await query(`UPDATE ocr_jobs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [
      completed.id,
    ])
    const expired = await store.listExpired(10)
    assert.ok(expired.some((entry) => entry.id === completed.id))
    await store.deleteExpired(firstUser, completed.id)
    assert.equal(await store.get(firstUser, completed.id), null)
  })
})
