/**
 * 0300 Box Claude Haiku 5.5 row (selfhost, OCV5-338).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0300BoxClaudeHaiku55.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boxClaudeRunner, cursorModelById } from '../../../protocol/src/engineModels.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0300_box_haiku55_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0300_box_claude_haiku_5_5.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

describe('0300_box_claude_haiku_5_5', () => {
  test('protocol knows box-claude-haiku-5-5 as its own box Claude row', () => {
    const model = cursorModelById('box-claude-haiku-5-5')
    assert.equal(model?.upstreamModel, 'claude-haiku-5-5')
    assert.equal(model?.family, 'box-claude-haiku-5-5')
    assert.equal(boxClaudeRunner('box-claude-haiku-5-5'), 'interactive')
  })

  test('release metadata lists 0300 after 0292', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    const ids = metadata.requiredMigrations
    assert.equal(ids[ids.indexOf('0292_gpt61_sol_retire_gpt6_sol') + 1], '0300_box_claude_haiku_5_5')
  })

  test('stages Haiku 5.5 unavailable, leaves the other box rows alone and admits it in the audit', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0300')
    const snapshot = async () => (await query<{ row: unknown }>(
      `SELECT to_jsonb(c) - 'updated_at' || jsonb_build_object('pricing', to_jsonb(p) - 'updated_at') AS row
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id <> 'box-claude-haiku-5-5' ORDER BY c.entry_id`,
    )).rows.map((r) => r.row)
    const before = await snapshot()

    const sql = await readFile(migrationPath, 'utf8')
    await query(sql)
    await query(sql)

    assert.deepEqual(await snapshot(), before)
    const rows = await query<Record<string, unknown>>(
      `SELECT c.state, c.engine, c.provider_id, c.upstream_model_id, c.context_window,
              c.capability_profile = (SELECT capability_profile FROM model_catalog
                                       WHERE model_id = 'box-claude-haiku-4-5' AND state = 'active') AS same_profile,
              p.enabled, p.visibility, p.display_name, p.sort_order,
              p.input_per_mtok::text AS input, p.output_per_mtok::text AS output,
              p.cache_read_per_mtok::text AS cache_read, p.cache_write_per_mtok::text AS cache_write,
              p.multiplier::text AS multiplier
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = 'box-claude-haiku-5-5'`,
    )
    assert.deepEqual(rows.rows, [{
      state: 'staged', engine: 'cursor', provider_id: 'cursor', upstream_model_id: 'claude-haiku-5-5',
      context_window: 1000000, same_profile: true, enabled: false, visibility: 'public',
      display_name: 'Claude Haiku 5.5', sort_order: 18, input: '20', output: '100', cache_read: '2',
      cache_write: '25', multiplier: '1.000',
    }])
    const groups = await query(`SELECT 1 FROM account_group_models WHERE model_id = 'box-claude-haiku-5-5'`)
    assert.equal(groups.rows.length, 0)

    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'cursor_external_usage_audit_model_id_check'`,
    )
    assert.match(check.rows[0]!.def, /'box-claude-haiku-5-5'/)
    assert.match(check.rows[0]!.def, /'box-claude-haiku-4-5'/)
    assert.match(check.rows[0]!.def, /'cursor-auto'/)
  })
})
