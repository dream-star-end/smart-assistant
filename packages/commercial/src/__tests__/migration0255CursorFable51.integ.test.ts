/**
 * 0255 Cursor Fable 5.1 family catalog expansion.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0255CursorFable51.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0255_cursor_fable51_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0255_cursor_fable_51.sql')

const NEW_IDS = [
  'cursor-fable-5.1-low',
  'cursor-fable-5.1-medium',
  'cursor-fable-5.1-high',
  'cursor-fable-5.1-xhigh',
  'cursor-fable-5.1-max',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0255_cursor_fable_51', () => {
  test('activates 5 Fable 5.1 rows cloned from Fable 5 with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0255')
    await query(await loadSql())
    const rows = await query<{
      model_id: string
      upstream_model_id: string
      state: string
      enabled: boolean
      visibility: string
      multiplier: string
      min_plan_code: string | null
    }>(
      `SELECT c.model_id, c.upstream_model_id, c.state, p.enabled, p.visibility,
              p.multiplier::text AS multiplier, p.min_plan_code
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [NEW_IDS],
    )
    assert.equal(rows.rows.length, 5)
    const baseline = await query<{
      visibility: string
      min_plan_code: string | null
      input_per_mtok: string
    }>(
      `SELECT visibility, min_plan_code, input_per_mtok::text
         FROM model_pricing WHERE model_id = 'cursor-fable-5-high'`,
    )
    const expectedVisibility = baseline.rows[0]?.visibility
    const expectedPlan = baseline.rows[0]?.min_plan_code
    const expectedInput = baseline.rows[0]?.input_per_mtok
    for (const row of rows.rows) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, expectedVisibility)
      assert.equal(row.min_plan_code, expectedPlan)
      assert.equal(Number(row.multiplier), 1)
    }
    const byId = Object.fromEntries(rows.rows.map((row) => [row.model_id, row]))
    assert.equal(byId['cursor-fable-5.1-high']?.upstream_model_id, 'claude-fable-5-1-thinking-high')
    assert.equal(byId['cursor-fable-5.1-max']?.upstream_model_id, 'claude-fable-5-1-thinking-max')
    const priced = await query<{ input_per_mtok: string }>(
      `SELECT input_per_mtok::text FROM model_pricing WHERE model_id = 'cursor-fable-5.1-high'`,
    )
    assert.equal(priced.rows[0]?.input_per_mtok, expectedInput)
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('audit check constraint lists the new canonical ids', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0255')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    const text = def.rows[0]?.def ?? ''
    assert.match(text, /cursor-fable-5\.1-low/)
    assert.match(text, /cursor-fable-5\.1-max/)
    assert.match(text, /cursor-fable-5-max/)
    assert.match(text, /cursor-opus-4\.8-high-fast/)
    assert.match(text, /cursor-grok-4\.5-high/)
    assert.doesNotMatch(text, /cursor-fable-5\.1-high-fast/)
  })

  test('converges an exact pre-existing family without duplicating rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0255')
    await query(await loadSql())
    // Replaying must be idempotent-safe against a complete family.
    await query(await loadSql())
    const count = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(count.rows[0]?.count, '5')
  })

  test('refuses a partial imported family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0255')
    await query(await loadSql())
    // Live catalog rows are execution-immutable (trigger), so simulate the
    // partial-import hazard on the pricing side: a family whose catalog and
    // pricing row counts disagree must fail closed on replay.
    await query(`DELETE FROM model_pricing WHERE model_id = 'cursor-fable-5.1-max'`)
    await assert.rejects(
      async () => query(await loadSql()),
      /partial imported Fable 5\.1 family/,
    )
  })
})
