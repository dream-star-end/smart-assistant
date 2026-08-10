import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0204_auto_dream_minimax_m3.sql')
const DESCRIPTION = 'Auto-Dream 整理与全面优化模型（统一使用 active/public 的 MiniMax M3）'

let pgAvailable = false

async function probe(): Promise<boolean> {
  const pool = createPool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await pool.end().catch(() => undefined)
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 4 }))
})

after(async () => {
  if (pgAvailable) await closePool()
})

async function seedSetting(value?: string): Promise<void> {
  await resetAndMigrateBefore('0203')
  if (value === undefined) {
    await query("DELETE FROM system_settings WHERE key='auto_dream_model'")
    return
  }
  await query(
    `INSERT INTO system_settings(key,value,description)
     VALUES ('auto_dream_model',to_jsonb($1::text),'before')
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, description='before'`,
    [value],
  )
}

async function applyMigration(): Promise<void> {
  await query(await readFile(MIGRATION, 'utf8'))
}

async function currentSetting(): Promise<{ value: string; description: string | null }> {
  const result = await query<{ value: string; description: string | null }>(
    "SELECT value #>> '{}' AS value,description FROM system_settings WHERE key='auto_dream_model'",
  )
  return result.rows[0]!
}

describe('0204_auto_dream_minimax_m3', () => {
  test('inserts MiniMax M3 when the setting row is absent', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await seedSetting()
    await applyMigration()
    assert.deepEqual(await currentSetting(), { value: 'MiniMax-M3', description: DESCRIPTION })
  })

  test('unifies every previous administrator value on MiniMax M3', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    for (const previous of ['gpt-5.6-terra', 'deepseek-v4-flash', 'custom-optimizer']) {
      await seedSetting(previous)
      await applyMigration()
      assert.deepEqual(await currentSetting(), { value: 'MiniMax-M3', description: DESCRIPTION })
    }
  })
})
