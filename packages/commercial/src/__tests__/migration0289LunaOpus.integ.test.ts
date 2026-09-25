/**
 * 0289: GPT-6 Luna x0.4, Opus 5.5 matches Opus 5, Opus 5 disabled.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0289LunaOpus.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { contextFamilyCollapsedByDefault } from '../../../protocol/src/engineModels.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0289_luna_opus_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0289_luna_x04_opus55_match_retire_opus5.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

describe('0289_luna_x04_opus55_match_retire_opus5', () => {
  test('GPT-6 Luna is not in the collapsed picker group', () => {
    assert.equal(contextFamilyCollapsedByDefault('gpt-6-luna'), false)
    assert.equal(contextFamilyCollapsedByDefault('gpt-6-sol'), false)
  })

  test('release metadata lists 0289 after 0288', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    const ids = metadata.requiredMigrations
    const prev = ids.indexOf('0288_gpt6_sol_luna_retire_gpt56')
    assert.equal(ids[prev + 1], '0289_luna_x04_opus55_match_retire_opus5')
  })

  test('reprices Luna, matches Opus 5.5 to Opus 5, and disables Opus 5', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0289')
    const before = await query<{ model_id: string; multiplier: string; input_per_mtok: string }>(
      `SELECT model_id, multiplier::text, input_per_mtok::text
         FROM model_pricing
        WHERE model_id IN ('gpt-6-luna', 'claude-opus-5', 'claude-opus-5-5')
        ORDER BY model_id`,
    )
    assert.deepEqual(
      before.rows.map((row) => [row.model_id, row.multiplier, row.input_per_mtok]),
      [
        ['claude-opus-5', '2.500', '250'],
        ['claude-opus-5-5', '2.500', '200'],
        ['gpt-6-luna', '1.000', '5'],
      ],
    )
    await query(
      `INSERT INTO client_sessions (id, created_at, last_at, updated_at, model_id, deleted_at)
       VALUES ('0289-opus5-live', 1, 1, 1, 'claude-opus-5', NULL),
              ('0289-opus5-dead', 1, 1, 1, 'claude-opus-5', 1),
              ('0289-opus55-live', 1, 1, 1, 'claude-opus-5-5', NULL)`,
    )

    const sql = await readFile(migrationPath, 'utf8')
    await query(sql)
    await query(sql)

    const prices = await query<{
      model_id: string
      multiplier: string
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
      state: string
      enabled: boolean
      visibility: string
    }>(
      `SELECT p.model_id, p.multiplier::text, p.input_per_mtok::text, p.output_per_mtok::text,
              p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
              c.state, p.enabled, p.visibility
         FROM model_pricing p
         JOIN model_catalog c ON c.model_id = p.model_id AND c.state IN ('active', 'disabled')
        WHERE p.model_id = ANY($1::text[])
        ORDER BY p.model_id`,
      [[
        'gpt-6-sol',
        'gpt-6-sol-1m',
        'gpt-6-luna',
        'gpt-6-luna-1m',
        'claude-opus-5',
        'claude-opus-5-5',
      ]],
    )
    assert.deepEqual(
      prices.rows.map((row) => [
        row.model_id,
        row.multiplier,
        row.input_per_mtok,
        row.output_per_mtok,
        row.cache_read_per_mtok,
        row.cache_write_per_mtok,
        row.state,
        row.enabled,
        row.visibility,
      ]),
      [
        ['claude-opus-5', '2.500', '250', '1250', '25', '312', 'disabled', false, 'hidden'],
        ['claude-opus-5-5', '2.500', '250', '1250', '25', '312', 'active', true, 'public'],
        ['gpt-6-luna', '0.400', '5', '25', '1', '6', 'active', true, 'public'],
        ['gpt-6-luna-1m', '0.400', '8', '38', '2', '9', 'active', true, 'public'],
        ['gpt-6-sol', '1.000', '100', '500', '10', '125', 'active', true, 'public'],
        ['gpt-6-sol-1m', '1.000', '150', '750', '15', '188', 'active', true, 'public'],
      ],
    )
    const sessions = await query<{ id: string; model_id: string }>(
      `SELECT id, model_id FROM client_sessions
        WHERE id LIKE '0289-%'
        ORDER BY id`,
    )
    assert.deepEqual(sessions.rows, [
      { id: '0289-opus5-dead', model_id: 'claude-opus-5' },
      { id: '0289-opus5-live', model_id: 'claude-opus-5-5' },
      { id: '0289-opus55-live', model_id: 'claude-opus-5-5' },
    ])
    const bound = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM account_group_models WHERE model_id = 'claude-opus-5'`,
    )
    assert.equal(bound.rows[0]?.n, '0')
  })
})
