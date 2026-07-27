import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

import { recordProductFrictionEvent } from '../productFriction/events.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0193_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0193_client_error_fingerprints.sql')

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
      event_key CHAR(64) PRIMARY KEY,
      user_id BIGINT,
      surface VARCHAR(48) NOT NULL,
      stage VARCHAR(48) NOT NULL,
      code VARCHAR(64) NOT NULL,
      outcome VARCHAR(16) NOT NULL,
      attempts SMALLINT NOT NULL DEFAULT 1,
      latency_ms INTEGER,
      model VARCHAR(128),
      provider VARCHAR(32),
      client_build VARCHAR(64),
      browser_family VARCHAR(24),
      device_class VARCHAR(16),
      trace_id VARCHAR(96),
      session_id VARCHAR(96),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recovered_at TIMESTAMPTZ
    );
    INSERT INTO product_friction_events(event_key,surface,stage,code,outcome)
    VALUES (repeat('a',64),'client','runtime','JS_ERROR','failed');
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

describe('0193_client_error_fingerprints', () => {
  maybe('is repeat-safe and keeps legacy writers plus existing rows valid', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    await pool.query(sql)
    await pool.query(sql)

    await pool.query(
      `INSERT INTO product_friction_events(event_key,surface,stage,code,outcome)
       VALUES (repeat('b',64),'client','runtime','UNHANDLED_REJECTION','failed')`,
    )
    const legacy = await pool.query<{ error_name: string | null; error_fingerprint: string | null }>(
      `SELECT error_name,error_fingerprint
         FROM product_friction_events
        WHERE event_key IN (repeat('a',64),repeat('b',64))
        ORDER BY event_key`,
    )
    assert.deepEqual(legacy.rows, [
      { error_name: null, error_fingerprint: null },
      { error_name: null, error_fingerprint: null },
    ])
  })

  maybe('writes the first bounded cluster identity and never replaces it with replay data', async () => {
    const base = {
      correlation: 'browser-runtime-cluster',
      surface: 'client',
      stage: 'runtime',
      code: 'JS_ERROR',
    } as const
    await recordProductFrictionEvent({
      ...base,
      outcome: 'failed',
      errorName: 'type_error',
      errorFingerprint: '0123456789abcdef',
    }, pool)
    await recordProductFrictionEvent({ ...base, outcome: 'recovered' }, pool)
    await recordProductFrictionEvent({
      ...base,
      outcome: 'failed',
      errorName: 'range_error',
      errorFingerprint: 'fedcba9876543210',
    }, pool)

    const row = await pool.query<{
      outcome: string
      error_name: string | null
      error_fingerprint: string | null
    }>(
      `SELECT outcome,error_name,error_fingerprint
         FROM product_friction_events
        WHERE event_key <> repeat('a',64) AND event_key <> repeat('b',64)`,
    )
    assert.deepEqual(row.rows, [{
      outcome: 'recovered',
      error_name: 'type_error',
      error_fingerprint: '0123456789abcdef',
    }])
  })

  maybe('rejects non-whitelisted names and malformed fingerprints', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO product_friction_events
           (event_key,surface,stage,code,outcome,error_name)
         VALUES (repeat('c',64),'client','runtime','JS_ERROR','failed','TypeError')`,
      ),
      (err: unknown) => (
        typeof err === 'object' && err !== null &&
        (err as { constraint?: string }).constraint ===
          'product_friction_events_error_name_check'
      ),
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO product_friction_events
           (event_key,surface,stage,code,outcome,error_fingerprint)
         VALUES (repeat('d',64),'client','runtime','JS_ERROR','failed','NOT_HEX_16_LONG!')`,
      ),
      (err: unknown) => (
        typeof err === 'object' && err !== null &&
        (err as { constraint?: string }).constraint ===
          'product_friction_events_error_fingerprint_check'
      ),
    )
  })
})
