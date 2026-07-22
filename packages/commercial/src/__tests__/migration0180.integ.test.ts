import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0180_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0180_refresh_tokens_rotated_to_index.sql')

let pool: Pool
let pgAvailable = false

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return

  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({ connectionString: TEST_DB_URL, max: 1, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE refresh_tokens (
      id BIGINT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      rotated_to_id BIGINT REFERENCES refresh_tokens(id) ON DELETE SET NULL
    )
  `)
})

after(async () => {
  if (!pgAvailable) return
  await pool.end()
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
})

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await fn()
  })
}

describe('0180_refresh_tokens_rotated_to_index', () => {
  test('uses the no-transaction concurrent index contract', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    assert.match(sql, /^-- no-transaction\b/m)
    assert.match(
      sql,
      /CREATE INDEX CONCURRENTLY idx_refresh_tokens_rotated_to_id\s+ON refresh_tokens\(rotated_to_id\)/,
    )
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /IF NOT EXISTS/)
  })

  maybe('creates a valid supporting index and lets retention delete a referenced token', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    await pool.query(sql)

    const index = await pool.query<{ indisvalid: boolean; indisready: boolean }>(`
      SELECT i.indisvalid,i.indisready
        FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relnamespace=current_schema()::regnamespace
         AND c.relname='idx_refresh_tokens_rotated_to_id'
    `)
    assert.deepEqual(index.rows, [{ indisvalid: true, indisready: true }])

    await pool.query(`
      INSERT INTO refresh_tokens(id,expires_at,rotated_to_id) VALUES
        (1,NOW()-interval '31 days',NULL),
        (2,NOW()+interval '30 days',1)
    `)
    await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < NOW()-interval '30 days'`)
    assert.deepEqual(
      (await pool.query('SELECT id,rotated_to_id FROM refresh_tokens ORDER BY id')).rows,
      [{ id: '2', rotated_to_id: null }],
    )

    await pool.query('SET enable_seqscan=off')
    try {
      const plan = await pool.query(
        'EXPLAIN UPDATE refresh_tokens SET rotated_to_id=NULL WHERE 1=rotated_to_id',
      )
      assert.match(
        plan.rows.map((row) => row['QUERY PLAN']).join('\n'),
        /idx_refresh_tokens_rotated_to_id/,
      )
    } finally {
      await pool.query('RESET enable_seqscan')
    }

    await pool.query('DELETE FROM refresh_tokens')
    await pool.query('DROP INDEX CONCURRENTLY idx_refresh_tokens_rotated_to_id')
  })

  maybe('fails loud instead of accepting a same-name invalid concurrent index', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    await pool.query(`
      INSERT INTO refresh_tokens(id,expires_at,rotated_to_id) VALUES
        (10,NOW()+interval '30 days',NULL),
        (11,NOW()+interval '30 days',10),
        (12,NOW()+interval '30 days',10)
    `)
    await assert.rejects(
      pool.query(
        'CREATE UNIQUE INDEX CONCURRENTLY idx_refresh_tokens_rotated_to_id ON refresh_tokens(rotated_to_id)',
      ),
      /could not create unique index|duplicate key value/,
    )
    const invalid = await pool.query<{ indisvalid: boolean; indisready: boolean }>(`
      SELECT i.indisvalid,i.indisready
        FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relnamespace=current_schema()::regnamespace
         AND c.relname='idx_refresh_tokens_rotated_to_id'
    `)
    assert.equal(invalid.rows.length, 1)
    assert.equal(invalid.rows[0].indisvalid, false)

    await assert.rejects(pool.query(sql), /already exists/)
    assert.equal(
      (
        await pool.query<{ indisvalid: boolean }>(`
          SELECT i.indisvalid
            FROM pg_index i
            JOIN pg_class c ON c.oid=i.indexrelid
           WHERE c.relnamespace=current_schema()::regnamespace
             AND c.relname='idx_refresh_tokens_rotated_to_id'
        `)
      ).rows[0].indisvalid,
      false,
    )
  })
})
