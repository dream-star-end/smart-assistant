/**
 * 0247 open commercial Cursor/Grok to all users and add Opus 4.8.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0247.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0247_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0247_open_cursor_grok_opus48.sql')
const selfhostMigrationPath = path.resolve(here, '../db/migrations/0247_cursor_opus_48.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

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

async function loadSelfhostSql(): Promise<string> {
  return readFile(selfhostMigrationPath, 'utf8')
}

describe('0247_open_cursor_grok_opus48', () => {
  test('activates Opus 4.8, publishes Cursor+Grok, and inserts zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
    const epochBefore = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
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
      input_per_mtok: string
    }>(
      `SELECT input_per_mtok::text FROM model_pricing WHERE model_id = 'cursor-opus-5-high'`,
    )
    const expectedInput = baseline.rows[0]?.input_per_mtok
    for (const row of rows.rows) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, 'public')
      assert.equal(row.min_plan_code, null)
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

    const opened = await query<{ model_id: string; visibility: string; min_plan_code: string | null }>(
      `SELECT c.model_id, p.visibility, p.min_plan_code
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.state = 'active' AND p.enabled IS TRUE
          AND (
            (c.engine = 'cursor' AND c.model_id NOT IN ('cursor-auto', 'cursor-grok-4.5-high'))
            OR c.model_id = 'grok-build'
          )
        ORDER BY c.model_id`,
    )
    assert.equal(opened.rows.length, 36)
    for (const row of opened.rows) {
      assert.equal(row.visibility, 'public', row.model_id)
      assert.equal(row.min_plan_code, null, row.model_id)
    }

    const retired = await query<{ model_id: string; visibility: string }>(
      `SELECT model_id, visibility FROM model_pricing
        WHERE model_id IN ('cursor-auto', 'cursor-grok-4.5-high')
        ORDER BY model_id`,
    )
    for (const row of retired.rows) {
      assert.equal(row.visibility, 'hidden', row.model_id)
    }

    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = ANY($1::text[])`,
      [NEW_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')

    const epochAfter = await query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM model_security_epoch WHERE id`,
    )
    assert.ok(Number(epochAfter.rows[0]?.epoch) > Number(epochBefore.rows[0]?.epoch))

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0247_open_cursor_grok_opus48'))
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

  test('does not grant users 1/4 even when they exist', async (t) => {
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
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('converges an exact pre-existing selfhost Opus 4.8 family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
    await query(await loadSelfhostSql())
    await query(await loadSql())

    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
          AND c.state = 'active'
          AND p.enabled IS TRUE
          AND p.visibility = 'public'
          AND p.min_plan_code IS NULL`,
      [NEW_IDS],
    )
    assert.equal(rows.rows[0]?.count, '10')
  })

  test('is fail-closed on a partial imported Opus 4.8 family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
    await query(await loadSelfhostSql())
    await query(`DELETE FROM model_pricing WHERE model_id = 'cursor-opus-4.8-max-fast'`)
    const sql = await loadSql()
    await assert.rejects(
      () => query(sql),
      /0247 refuses partial imported Opus 4\.8 family/,
    )
  })

  test('is fail-closed on a drifted imported Opus 4.8 family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0247')
    await query(await loadSelfhostSql())
    await query(
      `UPDATE model_pricing
          SET multiplier = 3
        WHERE model_id = 'cursor-opus-4.8-high'`,
    )
    const sql = await loadSql()
    await assert.rejects(
      () => query(sql),
      /0247 refuses drifted imported Opus 4\.8 family/,
    )
  })
})
