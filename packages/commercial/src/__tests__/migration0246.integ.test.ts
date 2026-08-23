/**
 * 0246 ungate Cursor Opus 5 / Fable 5 picker (clear min_plan_code).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0246.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0246_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0246_ungate_cursor_opus_fable_picker.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const FAMILY_SQL = `model_id LIKE 'cursor-opus-5-%' OR model_id LIKE 'cursor-fable-5-%'`

type PriceRow = {
  model_id: string
  input_per_mtok: string
  output_per_mtok: string
  cache_read_per_mtok: string
  cache_write_per_mtok: string
  multiplier: string
  enabled: boolean
  visibility: string
  min_plan_code: string | null
}

const PRICE_SELECT = `
  SELECT model_id,
         input_per_mtok::text AS input_per_mtok,
         output_per_mtok::text AS output_per_mtok,
         cache_read_per_mtok::text AS cache_read_per_mtok,
         cache_write_per_mtok::text AS cache_write_per_mtok,
         multiplier::text AS multiplier,
         enabled, visibility, min_plan_code
    FROM model_pricing
   WHERE ${FAMILY_SQL}
   ORDER BY model_id
`

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0246_ungate_cursor_opus_fable_picker', () => {
  test('clears Max gate, preserves prices, and bumps catalog epoch', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0246')
    const before = await query<PriceRow>(PRICE_SELECT)
    assert.equal(before.rows.length, 15)
    for (const row of before.rows) {
      assert.equal(row.min_plan_code, 'max', row.model_id)
    }
    const epochBefore = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
    await query(await loadSql())

    const rows = await query<PriceRow>(PRICE_SELECT)
    assert.equal(rows.rows.length, 15)
    const beforeById = Object.fromEntries(before.rows.map((row) => [row.model_id, row]))
    for (const row of rows.rows) {
      const prev = beforeById[row.model_id]
      assert.ok(prev, row.model_id)
      assert.equal(row.min_plan_code, null, row.model_id)
      assert.equal(row.enabled, prev.enabled, row.model_id)
      assert.equal(row.visibility, prev.visibility, row.model_id)
      assert.equal(row.input_per_mtok, prev.input_per_mtok, row.model_id)
      assert.equal(row.output_per_mtok, prev.output_per_mtok, row.model_id)
      assert.equal(row.cache_read_per_mtok, prev.cache_read_per_mtok, row.model_id)
      assert.equal(row.cache_write_per_mtok, prev.cache_write_per_mtok, row.model_id)
      assert.equal(row.multiplier, prev.multiplier, row.model_id)
    }
    const epochAfter = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
    assert.equal(Number(epochAfter.rows[0]?.epoch), Number(epochBefore.rows[0]?.epoch) + 1)

    const leftover = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_pricing
        WHERE min_plan_code IS NOT NULL AND (${FAMILY_SQL})`,
    )
    assert.equal(leftover.rows[0]?.n, '0')

    const grok = await query<{ min_plan_code: string | null }>(
      `SELECT min_plan_code FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high'`,
    )
    assert.equal(grok.rows[0]?.min_plan_code, null)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0246_ungate_cursor_opus_fable_picker'))
  })

  test('is fail-closed if Opus/Fable are not Max-gated', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0246')
    const sql = await loadSql()
    await query(sql)
    await assert.rejects(
      () => query(sql),
      /0246: expected 15 Opus\/Fable min_plan clears/,
    )
  })

  test('min_plan_code changes now bump security epoch', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0246')
    await query(await loadSql())
    const before = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
    await query(
      `UPDATE model_pricing SET min_plan_code = 'max' WHERE model_id = 'cursor-opus-5-high'`,
    )
    const after = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
    assert.equal(Number(after.rows[0]?.epoch), Number(before.rows[0]?.epoch) + 1)
    await query(
      `UPDATE model_pricing SET min_plan_code = NULL WHERE model_id = 'cursor-opus-5-high'`,
    )
  })
})
