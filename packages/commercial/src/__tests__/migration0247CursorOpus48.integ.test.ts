/**
 * 0247 Cursor Opus 4.8 family catalog expansion.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0247CursorOpus48.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0247_cursor_opus48_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0247_cursor_opus_48.sql')

const NEW_IDS = [
  'cursor-opus-4.8-low',
  'cursor-opus-4.8-low-fast',
  'cursor-opus-4.8-medium',
  'cursor-opus-4.8-medium-fast',
  'cursor-opus-4.8-high',
  'cursor-opus-4.8-high-fast',
  'cursor-opus-4.8-xhigh',
  'cursor-opus-4.8-xhigh-fast',
  'cursor-opus-4.8-max',
  'cursor-opus-4.8-max-fast',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0247_cursor_opus_48', () => {
  test('activates 10 Opus 4.8 rows cloned from Opus 5 with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
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
    assert.equal(rows.rows.length, 10)
    const baseline = await query<{
      visibility: string
      min_plan_code: string | null
      input_per_mtok: string
    }>(
      `SELECT visibility, min_plan_code, input_per_mtok::text
         FROM model_pricing WHERE model_id = 'cursor-opus-5-high'`,
    )
    const expectedVisibility = baseline.rows[0]?.visibility
    const expectedPlan = baseline.rows[0]?.min_plan_code
    const expectedInput = baseline.rows[0]?.input_per_mtok
    for (const row of rows.rows) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, expectedVisibility)
      assert.equal(row.min_plan_code, expectedPlan)
    }
    const byId = Object.fromEntries(rows.rows.map((row) => [row.model_id, row]))
    assert.equal(byId['cursor-opus-4.8-high']?.upstream_model_id, 'claude-opus-4-8-thinking-high')
    assert.equal(Number(byId['cursor-opus-4.8-high']?.multiplier), 1)
    assert.equal(
      byId['cursor-opus-4.8-high-fast']?.upstream_model_id,
      'claude-opus-4-8-thinking-high-fast',
    )
    assert.equal(Number(byId['cursor-opus-4.8-high-fast']?.multiplier), 2)
    const priced = await query<{ input_per_mtok: string }>(
      `SELECT input_per_mtok::text FROM model_pricing WHERE model_id = 'cursor-opus-4.8-high'`,
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
    await resetAndMigrateBefore('0247')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    const text = def.rows[0]?.def ?? ''
    assert.match(text, /cursor-opus-4\.8-high-fast/)
    assert.match(text, /cursor-opus-4\.8-max/)
    assert.match(text, /cursor-opus-5-max-fast/)
    assert.match(text, /cursor-grok-4\.5-high/)
  })

  test('grants users 1/4 on the default profile', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES
         (1, 'cursor-admin-0247@example.com', TRUE, 'argon2$stub', 'admin'),
         (4, 'cursor-user-0247@example.com', TRUE, 'argon2$stub', 'user')`,
    )
    await query(await loadSql())
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM model_visibility_grants
        WHERE user_id IN (1, 4) AND model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '20')
    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM admin_audit
        WHERE action = 'model_grant.add'
          AND after->>'source' = 'migration:0247'`,
    )
    assert.equal(audit.rows[0]?.count, '20')
  })
})
