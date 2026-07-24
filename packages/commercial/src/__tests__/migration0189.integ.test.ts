import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0189_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0189_auto_dream_deepseek_v4_flash.sql')

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
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 1,
    options: `-c search_path=${SCHEMA}`,
  })
})

after(async () => {
  if (!pgAvailable) return
  await pool.end()
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
})

async function resetSetting(value?: string): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS system_settings')
  await pool.query(
    'CREATE TABLE system_settings (key TEXT PRIMARY KEY,value JSONB NOT NULL,description TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  )
  if (value !== undefined) {
    await pool.query(
      "INSERT INTO system_settings(key,value,description) VALUES ('auto_dream_model',to_jsonb($1::text),'before')",
      [value],
    )
  }
}

async function applyMigration(): Promise<void> {
  await pool.query(await readFile(MIGRATION, 'utf8'))
}

async function currentSetting(): Promise<{ value: string; description: string | null }> {
  const result = await pool.query<{ value: string; description: string | null }>(
    "SELECT value #>> '{}' AS value,description FROM system_settings WHERE key='auto_dream_model'",
  )
  return result.rows[0]!
}

describe('0189_auto_dream_deepseek_v4_flash', () => {
  test('inserts DeepSeek when the old default row is absent', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await resetSetting()
    await applyMigration()
    assert.deepEqual(await currentSetting(), {
      value: 'deepseek-v4-flash',
      description:
        'Auto-Dream 全面优化审计模型（默认使用 active/public 的 DeepSeek V4 Flash）',
    })
  })

  test('updates Terra but preserves an explicit non-Terra administrator choice', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await resetSetting('gpt-5.6-terra')
    await applyMigration()
    assert.equal((await currentSetting()).value, 'deepseek-v4-flash')

    await resetSetting('custom-optimizer')
    await applyMigration()
    assert.deepEqual(await currentSetting(), {
      value: 'custom-optimizer',
      description: 'before',
    })
  })
})
