/**
 * 0284 grok-build-fast + retire Cursor Grok 4.6.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0284GrokBuildFastRetire46.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0284_grok_fast_retire_46_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0284_grok_build_fast_retire_grok_46.sql')

describe('0284_grok_build_fast_retire_grok_46', () => {
  test('adds grok-build-fast at 2x and hides Cursor Grok 4.6', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0284')
    await query(await readFile(migrationPath, 'utf8'))

    const fast = await query<{
      upstream_model_id: string
      display_name: string
      multiplier: string
      base_multiplier: string
      enabled: boolean
      state: string
    }>(
      `SELECT c.upstream_model_id, p.display_name, p.multiplier::text,
              b.multiplier::text AS base_multiplier, p.enabled, c.state
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
         JOIN model_pricing b ON b.model_id = 'grok-build'
        WHERE c.model_id = 'grok-build-fast'`,
    )
    assert.equal(fast.rows[0]?.upstream_model_id, 'grok-4.7-build-fast')
    assert.equal(fast.rows[0]?.display_name, 'Grok 4.7 Fast')
    assert.equal(fast.rows[0]?.enabled, true)
    assert.equal(fast.rows[0]?.state, 'active')
    assert.equal(Number(fast.rows[0]?.multiplier), Number(fast.rows[0]?.base_multiplier) * 2)

    const retired = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id LIKE 'cursor-grok-4.6-%' AND c.state = 'disabled'
          AND p.enabled IS FALSE AND p.visibility = 'hidden'`,
    )
    assert.equal(retired.rows[0]?.count, '8')

    const still = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_catalog
        WHERE model_id LIKE 'cursor-grok-4.7-%' AND state = 'active'`,
    )
    assert.equal(still.rows[0]?.count, '8')
  })
})
