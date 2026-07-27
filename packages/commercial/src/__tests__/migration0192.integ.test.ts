import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0192_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0192_friction_code_casing.sql')

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

  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE product_friction_events (
      event_key TEXT PRIMARY KEY,
      code VARCHAR(64) NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,64}$')
    );
    INSERT INTO product_friction_events(event_key,code)
    VALUES ('legacy-uppercase','CLIENT_UNKNOWN');
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

describe('0192_friction_code_casing', () => {
  maybe('accepts existing uppercase and bounded lowercase codes after repeat-safe apply', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    await pool.query(sql)
    await pool.query(sql)

    await pool.query(
      `INSERT INTO product_friction_events(event_key,code)
       VALUES ('lowercase','context_too_long'),('mixed','Client_Retry_2')`,
    )
    const rows = await pool.query<{ code: string }>(
      'SELECT code FROM product_friction_events ORDER BY event_key',
    )
    assert.deepEqual(rows.rows.map((row) => row.code), [
      'CLIENT_UNKNOWN',
      'context_too_long',
      'Client_Retry_2',
    ])
  })

  maybe('continues to reject unbounded or punctuation-bearing values', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO product_friction_events(event_key,code)
         VALUES ('invalid','contains-hyphen')`,
      ),
      (err: unknown) => (
        typeof err === 'object' && err !== null &&
        (err as { code?: string }).code === '23514' &&
        (err as { constraint?: string }).constraint === 'product_friction_events_code_check'
      ),
    )
  })
})
