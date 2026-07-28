import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0193_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0193_selfheal_active_master_tier1.sql')

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
    CREATE TABLE incident_policies (
      id BIGSERIAL PRIMARY KEY,
      match_kind TEXT NOT NULL,
      match_key TEXT NOT NULL,
      auto_repair BOOLEAN NOT NULL DEFAULT FALSE,
      execution_class TEXT NOT NULL DEFAULT 'tier2',
      action_opcode TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT incident_policies_tier1_opcode_ck CHECK (
        (execution_class = 'tier1' AND action_opcode IS NOT NULL) OR
        (execution_class = 'tier2' AND action_opcode IS NULL)
      ),
      UNIQUE(match_kind, match_key)
    );
    INSERT INTO incident_policies
      (match_kind,match_key,auto_repair,execution_class,action_opcode)
    VALUES
      ('prefix','ops.monitor:svc_v5',TRUE,'tier2',NULL),
      ('prefix','ops.monitor:http_v5',TRUE,'tier2',NULL),
      ('prefix','ops.monitor:public_route',FALSE,'tier2',NULL);
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

describe('0193_selfheal_active_master_tier1', () => {
  maybe('routes only svc_v5/http_v5 to the fixed opcode and keeps activation off', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    await pool.query(sql)
    await pool.query(sql)

    const rows = await pool.query<{
      match_key: string
      auto_repair: boolean
      execution_class: string
      action_opcode: string | null
    }>(
      `SELECT match_key,auto_repair,execution_class,action_opcode
         FROM incident_policies ORDER BY match_key`,
    )
    assert.deepEqual(rows.rows, [
      {
        match_key: 'ops.monitor:http_v5',
        auto_repair: false,
        execution_class: 'tier1',
        action_opcode: 'restart-v5-active-master-v1',
      },
      {
        match_key: 'ops.monitor:public_route',
        auto_repair: false,
        execution_class: 'tier2',
        action_opcode: null,
      },
      {
        match_key: 'ops.monitor:svc_v5',
        auto_repair: false,
        execution_class: 'tier1',
        action_opcode: 'restart-v5-active-master-v1',
      },
    ])
  })

  maybe('fails closed unless both exact policy rows exist', async () => {
    const sql = await readFile(MIGRATION, 'utf8')
    const client = await pool.connect()
    try {
      await client.query(`DELETE FROM incident_policies WHERE match_key='ops.monitor:http_v5'`)
      await assert.rejects(
        client.query(sql),
        /0193 expected exactly 2 active-master policies, updated 1/,
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
