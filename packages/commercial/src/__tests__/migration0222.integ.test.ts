/**
 * 0222 Cursor family effort × Fast catalog expansion.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0222.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0222_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0222_cursor_family_effort_fast.sql')

const NEW_IDS = [
  'cursor-grok-4.6-low',
  'cursor-grok-4.6-low-fast',
  'cursor-grok-4.6-medium',
  'cursor-grok-4.6-medium-fast',
  'cursor-grok-4.6-xhigh',
  'cursor-grok-4.6-xhigh-fast',
  'cursor-composer-2.5',
  'cursor-opus-5-low',
  'cursor-opus-5-low-fast',
  'cursor-opus-5-medium',
  'cursor-opus-5-medium-fast',
  'cursor-opus-5-high-fast',
  'cursor-opus-5-xhigh',
  'cursor-opus-5-xhigh-fast',
  'cursor-opus-5-max',
  'cursor-opus-5-max-fast',
  'cursor-fable-5-low',
  'cursor-fable-5-medium',
  'cursor-fable-5-xhigh',
  'cursor-fable-5-max',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0222_cursor_family_effort_fast', () => {
  test('activates 20 new family rows cloned from baselines with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0222')
    await query(await loadSql())
    const rows = await query<{
      model_id: string
      upstream_model_id: string
      state: string
      enabled: boolean
      visibility: string
      multiplier: string
    }>(
      `SELECT c.model_id, c.upstream_model_id, c.state, p.enabled, p.visibility,
              p.multiplier::text AS multiplier
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [NEW_IDS],
    )
    assert.equal(rows.rows.length, 20)
    for (const row of rows.rows) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, 'hidden')
    }
    const byId = Object.fromEntries(rows.rows.map((row) => [row.model_id, row]))
    assert.equal(Number(byId['cursor-grok-4.6-low']?.multiplier), 1)
    assert.equal(Number(byId['cursor-grok-4.6-low-fast']?.multiplier), 2)
    assert.equal(byId['cursor-composer-2.5']?.upstream_model_id, 'composer-2.5')
    assert.equal(Number(byId['cursor-composer-2.5']?.multiplier), 1)
    assert.equal(byId['cursor-opus-5-high-fast']?.upstream_model_id, 'claude-opus-5-thinking-high-fast')
    assert.equal(Number(byId['cursor-opus-5-high-fast']?.multiplier), 2)
    assert.equal(byId['cursor-fable-5-max']?.upstream_model_id, 'claude-fable-5-thinking-max')
    assert.equal(Number(byId['cursor-fable-5-max']?.multiplier), 1)
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('audit check constraint lists the new canonical ids', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0222')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    const text = def.rows[0]?.def ?? ''
    assert.match(text, /cursor-composer-2\.5/)
    assert.match(text, /cursor-opus-5-max-fast/)
    assert.match(text, /cursor-fable-5-max/)
    assert.match(text, /cursor-grok-4\.6-xhigh-fast/)
  })

  test('clones official 0221 prices onto new rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0222')
    await query(await loadSql())
    const grok = await query<{ input_per_mtok: string; multiplier: string }>(
      `SELECT input_per_mtok::text, multiplier::text FROM model_pricing WHERE model_id = 'cursor-grok-4.6-xhigh-fast'`,
    )
    assert.equal(grok.rows[0]?.input_per_mtok, '200')
    assert.equal(Number(grok.rows[0]?.multiplier), 2)
    const composer = await query<{ input_per_mtok: string; multiplier: string }>(
      `SELECT input_per_mtok::text, multiplier::text FROM model_pricing WHERE model_id = 'cursor-composer-2.5'`,
    )
    assert.equal(composer.rows[0]?.input_per_mtok, '50')
    assert.equal(Number(composer.rows[0]?.multiplier), 1)
  })

  test('grants users 1/4 on the default profile', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0222')
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES
         (1, 'cursor-admin-0222@example.com', TRUE, 'argon2$stub', 'admin'),
         (4, 'cursor-user-0222@example.com', TRUE, 'argon2$stub', 'user')`,
    )
    await query(await loadSql())
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM model_visibility_grants
        WHERE user_id IN (1, 4) AND model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '40')
    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM admin_audit
        WHERE action = 'model_grant.add'
          AND after->>'source' = 'migration:0222'`,
    )
    assert.equal(audit.rows[0]?.count, '40')
  })
})
