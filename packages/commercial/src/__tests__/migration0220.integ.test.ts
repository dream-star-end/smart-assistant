/**
 * 0220 Cursor Grok 4.6 High Fast catalog sibling.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0220.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0220_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0220_cursor_grok_46_high_fast.sql')
const modelId = 'cursor-grok-4.6-high-fast'

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

async function targetRow() {
  const result = await query<{
    model_id: string
    engine: string
    provider_id: string
    upstream_model_id: string
    state: string
    enabled: boolean
    visibility: string
    display_name: string
  }>(
    `SELECT c.model_id, c.engine, c.provider_id, c.upstream_model_id, c.state,
            p.enabled, p.visibility, p.display_name
       FROM model_catalog c
       JOIN model_pricing p USING (model_id)
      WHERE c.model_id = $1`,
    [modelId],
  )
  return result.rows
}

describe('0220_cursor_grok_46_high_fast', () => {
  test('activates the hidden Fast sibling next to High with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0220')
    await query(await loadSql())
    assert.deepEqual(await targetRow(), [
      {
        model_id: modelId,
        engine: 'cursor',
        provider_id: 'cursor',
        upstream_model_id: modelId,
        state: 'active',
        enabled: true,
        visibility: 'hidden',
        display_name: 'Cursor Grok 4.6 High Fast',
      },
    ])
    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = $1`,
      [modelId],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('audit check constraint lists the new canonical id', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0220')
    await query(await loadSql())
    const def = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'cursor_external_usage_audit'::regclass
          AND conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    assert.match(def.rows[0]?.def ?? '', /cursor-grok-4\.6-high-fast/)
  })

  test('refuses to apply without the High floor', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0220')
    await query(`UPDATE model_catalog SET state = 'disabled' WHERE model_id = 'cursor-grok-4.6-high'`)
    await assert.rejects(query(await loadSql()), /0220 requires active enabled cursor-grok-4.6-high floor/)
    const after = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog WHERE model_id = $1`,
      [modelId],
    )
    assert.equal(after.rows[0]?.count, '0')
  })

  test('grants users 1/4 on the default profile and writes append-only audit', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0220')
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES
         (1, 'cursor-admin-0220@example.com', TRUE, 'argon2$stub', 'admin'),
         (4, 'cursor-user-0220@example.com', TRUE, 'argon2$stub', 'user')`,
    )
    await query(await loadSql())
    const grants = await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id
         FROM model_visibility_grants
        WHERE model_id = $1
        ORDER BY user_id`,
      [modelId],
    )
    assert.deepEqual(grants.rows, [{ user_id: '1' }, { user_id: '4' }])
    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM admin_audit
        WHERE action = 'model_grant.add'
          AND after->>'source' = 'migration:0220'`,
    )
    assert.equal(audit.rows[0]?.count, '2')
  })

  test('clones a public High floor instead of demanding hidden', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0220')
    await query(`UPDATE model_pricing SET visibility = 'public' WHERE model_id = 'cursor-grok-4.6-high'`)
    await query(await loadSql())
    const row = await query<{ visibility: string }>(
      `SELECT visibility FROM model_pricing WHERE model_id = $1`,
      [modelId],
    )
    assert.deepEqual(row.rows, [{ visibility: 'public' }])
  })
})
