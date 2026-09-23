/**
 * 0288 GPT-6 Sol/Luna onboard and GPT-5.6 Codex retirement.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0288Gpt6SolLuna.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CODEX_ENGINE_MODELS, contextFamilyByModelId } from '../../../protocol/src/engineModels.ts'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0288_gpt6_sol_luna_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0288_gpt6_sol_luna_retire_gpt56.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const NEW_IDS = ['gpt-6-sol', 'gpt-6-sol-1m', 'gpt-6-luna', 'gpt-6-luna-1m'] as const
const OLD_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-sol-1m',
  'gpt-5.6-luna',
  'gpt-5.6-luna-1m',
  'gpt-5.6-terra',
  'gpt-5.6-terra-1m',
] as const

describe('0288_gpt6_sol_luna_retire_gpt56', () => {
  test('protocol exposes Sol and Luna and drops GPT-5.6 from the picker', () => {
    for (const id of NEW_IDS) {
      assert.equal(CODEX_ENGINE_MODELS.some((m) => m.id === id), true, id)
    }
    assert.equal(contextFamilyByModelId('gpt-6-sol')?.longId, 'gpt-6-sol-1m')
    assert.equal(contextFamilyByModelId('gpt-6-luna')?.longId, 'gpt-6-luna-1m')
    assert.equal(contextFamilyByModelId('gpt-5.6-sol'), undefined)
    assert.equal(contextFamilyByModelId('gpt-5.6-terra'), undefined)
  })

  test('release metadata lists 0288 after 0287', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    const ids = metadata.requiredMigrations
    const prev = ids.indexOf('0287_claude_opus_55_context_1m')
    assert.equal(ids[prev + 1], '0288_gpt6_sol_luna_retire_gpt56')
  })

  test('activates Sol/Luna at the 0286 fen rule and disables Codex GPT-5.6', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0288')
    const before = await query<{ model_id: string; state: string }>(
      `SELECT model_id, state FROM model_catalog
        WHERE model_id = ANY($1::text[]) AND state = 'active'`,
      [OLD_IDS],
    )
    assert.equal(before.rows.length, 6)

    await query(await readFile(migrationPath, 'utf8'))

    const prices = await query<{
      model_id: string
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
      state: string
      enabled: boolean
      visibility: string
      default_effort: string
    }>(
      `SELECT p.model_id, p.input_per_mtok::text, p.output_per_mtok::text,
              p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
              c.state, p.enabled, p.visibility, p.default_effort
         FROM model_pricing p
         JOIN model_catalog c ON c.model_id = p.model_id AND c.state = 'active'
        WHERE p.model_id = ANY($1::text[])
        ORDER BY p.model_id`,
      [NEW_IDS],
    )
    assert.deepEqual(
      prices.rows.map((r) => [r.model_id, r.input_per_mtok, r.output_per_mtok, r.cache_read_per_mtok, r.cache_write_per_mtok, r.default_effort, r.visibility, r.enabled]),
      [
        ['gpt-6-luna', '5', '25', '1', '6', 'medium', 'public', true],
        ['gpt-6-luna-1m', '8', '38', '2', '9', 'medium', 'public', true],
        ['gpt-6-sol', '100', '500', '10', '125', 'medium', 'public', true],
        ['gpt-6-sol-1m', '150', '750', '15', '188', 'medium', 'public', true],
      ],
    )

    const retired = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_catalog
        WHERE engine = 'codex' AND state = 'active' AND model_id LIKE 'gpt-5.6-%'`,
    )
    assert.equal(retired.rows[0]?.n, '0')
    const req = await query<{ model_id: string }>(
      `SELECT model_id FROM model_runtime_requirements WHERE requirement = 'default_codex_engine'`,
    )
    assert.deepEqual(req.rows.map((r) => r.model_id), ['gpt-6-astra'])
  })
})
