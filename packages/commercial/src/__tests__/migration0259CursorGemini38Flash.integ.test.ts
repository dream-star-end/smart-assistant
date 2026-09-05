/**
 * 0259 Cursor Gemini 3.8 Flash family catalog expansion.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0259CursorGemini38Flash.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0259_cursor_gemini38_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0259_cursor_gemini_38_flash.sql')

const NEW_IDS = [
  'cursor-gemini-3.8-flash-low',
  'cursor-gemini-3.8-flash-medium',
  'cursor-gemini-3.8-flash-high',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0259_cursor_gemini_38_flash', () => {
  test('activates 3 Gemini 3.8 Flash rows cloned from Grok 4.6 High with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0259')
    await query(await loadSql())
    const rows = await query<{
      model_id: string
      upstream_model_id: string
      state: string
      enabled: boolean
      visibility: string
      multiplier: string
      min_plan_code: string | null
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
      display_name: string
    }>(
      `SELECT c.model_id, c.upstream_model_id, c.state, p.enabled, p.visibility,
              p.multiplier::text AS multiplier, p.min_plan_code,
              p.input_per_mtok::text, p.output_per_mtok::text,
              p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
              p.display_name
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [NEW_IDS],
    )
    assert.equal(rows.rows.length, 3)
    const baseline = await query<{
      visibility: string
      min_plan_code: string | null
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
    }>(
      `SELECT visibility, min_plan_code, input_per_mtok::text, output_per_mtok::text,
              cache_read_per_mtok::text, cache_write_per_mtok::text
         FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high'`,
    )
    const base = baseline.rows[0]!
    for (const row of rows.rows) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, base.visibility)
      assert.equal(row.min_plan_code, base.min_plan_code)
      assert.equal(Number(row.multiplier), 1)
      assert.equal(row.input_per_mtok, base.input_per_mtok)
      assert.equal(row.output_per_mtok, base.output_per_mtok)
      assert.equal(row.cache_read_per_mtok, base.cache_read_per_mtok)
      assert.equal(row.cache_write_per_mtok, base.cache_write_per_mtok)
      assert.equal(row.display_name.startsWith('Cursor '), false)
    }
    const byId = Object.fromEntries(rows.rows.map((row) => [row.model_id, row]))
    assert.equal(byId['cursor-gemini-3.8-flash-low']?.upstream_model_id, 'gemini-3.8-flash-low')
    assert.equal(byId['cursor-gemini-3.8-flash-medium']?.upstream_model_id, 'gemini-3.8-flash-medium')
    assert.equal(byId['cursor-gemini-3.8-flash-high']?.upstream_model_id, 'gemini-3.8-flash-high')
    assert.equal(byId['cursor-gemini-3.8-flash-high']?.display_name, 'Gemini 3.8 Flash High')
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('audit check constraint lists the new canonical ids and no Fast/xhigh twins', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0259')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    const text = def.rows[0]?.def ?? ''
    assert.match(text, /cursor-gemini-3\.8-flash-low/)
    assert.match(text, /cursor-gemini-3\.8-flash-medium/)
    assert.match(text, /cursor-gemini-3\.8-flash-high/)
    assert.match(text, /cursor-fable-5\.1-max/)
    assert.match(text, /cursor-grok-4\.5-high/)
    assert.doesNotMatch(text, /cursor-gemini-3\.8-flash-high-fast/)
    assert.doesNotMatch(text, /cursor-gemini-3\.8-flash-xhigh/)
  })

  test('converges an exact pre-existing family without duplicating rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0259')
    await query(await loadSql())
    await query(await loadSql())
    const count = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(count.rows[0]?.count, '3')
  })

  test('refuses a partial imported family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0259')
    await query(await loadSql())
    await query(`DELETE FROM model_pricing WHERE model_id = 'cursor-gemini-3.8-flash-high'`)
    await assert.rejects(
      async () => query(await loadSql()),
      /partial imported Gemini 3\.8 Flash family/,
    )
  })
})
