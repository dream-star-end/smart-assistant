/**
 * 0283 Cursor Grok 4.7 family + grok-build upstream 4.7.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0283CursorGrok47.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0283_cursor_grok_47_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0283_cursor_grok_47_and_grok_build.sql')

const GROK47_IDS = [
  'cursor-grok-4.7-low',
  'cursor-grok-4.7-low-fast',
  'cursor-grok-4.7-medium',
  'cursor-grok-4.7-medium-fast',
  'cursor-grok-4.7-high',
  'cursor-grok-4.7-high-fast',
  'cursor-grok-4.7-xhigh',
  'cursor-grok-4.7-xhigh-fast',
] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0283_cursor_grok_47_and_grok_build', () => {
  test('retargets grok-build to grok-4.7 and adds the Cursor Grok 4.7 family', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0283')
    await query(await loadSql())

    const grokBuild = await query<{
      upstream_model_id: string
      display_name: string
      enabled: boolean
      state: string
    }>(
      `SELECT c.upstream_model_id, p.display_name, p.enabled, c.state
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = 'grok-build'`,
    )
    assert.equal(grokBuild.rows[0]?.upstream_model_id, 'grok-4.7')
    assert.equal(grokBuild.rows[0]?.display_name, 'Grok 4.7')
    assert.equal(grokBuild.rows[0]?.enabled, true)
    assert.equal(grokBuild.rows[0]?.state, 'active')

    const family = await query<{
      model_id: string
      upstream_model_id: string
      multiplier: string
      visibility: string
      enabled: boolean
      sort_order: number
    }>(
      `SELECT c.model_id, c.upstream_model_id, p.multiplier::text AS multiplier,
              p.visibility, p.enabled, p.sort_order
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [GROK47_IDS],
    )
    assert.equal(family.rows.length, 8)
    for (const row of family.rows) {
      assert.equal(row.enabled, true)
      assert.equal(row.visibility, 'public')
      assert.equal(row.sort_order, 143)
      const fast = row.model_id.endsWith('-fast')
      assert.equal(Number(row.multiplier), fast ? 2 : 1)
      assert.equal(row.upstream_model_id.startsWith('grok-4.7-'), true)
      assert.equal(row.upstream_model_id.startsWith('cursor-'), false)
    }

    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants
        WHERE model_id = ANY($1::text[])`,
      [GROK47_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')

    const replay = await query(await loadSql())
    assert.ok(replay)
    const again = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_catalog
        WHERE model_id LIKE 'cursor-grok-4.7-%' AND state = 'active'`,
    )
    assert.equal(again.rows[0]?.count, '8')
  })
})
