/**
 * 0292 GPT-6.1 Sol onboard and GPT-6 Sol retirement.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0292Gpt61Sol.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CODEX_ENGINE_MODELS,
  contextFamilyByModelId,
} from '../../../protocol/src/engineModels.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0292_gpt61_sol_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0292_gpt61_sol_retire_gpt6_sol.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

const NEW_IDS = ['gpt-6.1-sol', 'gpt-6.1-sol-1m'] as const
const OLD_IDS = ['gpt-6-sol', 'gpt-6-sol-1m'] as const

describe('0292_gpt61_sol_retire_gpt6_sol', () => {
  test('protocol exposes GPT-6.1 Sol and drops GPT-6 Sol from the picker', () => {
    for (const id of NEW_IDS) {
      assert.equal(CODEX_ENGINE_MODELS.some((m) => m.id === id), true, id)
    }
    for (const id of OLD_IDS) {
      assert.equal(CODEX_ENGINE_MODELS.some((m) => m.id === id), true, id)
    }
    assert.equal(contextFamilyByModelId('gpt-6.1-sol')?.longId, 'gpt-6.1-sol-1m')
    assert.equal(contextFamilyByModelId('gpt-6.1-sol')?.collapsedByDefault, false)
    assert.equal(contextFamilyByModelId('gpt-6-sol'), undefined)
    assert.equal(contextFamilyByModelId('gpt-6-luna')?.longId, 'gpt-6-luna-1m')
  })

  test('release metadata lists 0292 after 0291', async () => {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      requiredMigrations: string[]
    }
    const ids = metadata.requiredMigrations
    const prev = ids.indexOf('0291_box_claude_cursor_audit')
    assert.equal(ids[prev + 1], '0292_gpt61_sol_retire_gpt6_sol')
  })

  test('activates GPT-6.1 Sol at the 0286 fen rule and disables GPT-6 Sol', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0292')
    const before = await query<{ model_id: string }>(
      `SELECT model_id FROM model_catalog
        WHERE model_id = ANY($1::text[]) AND state = 'active'
        ORDER BY model_id`,
      [OLD_IDS],
    )
    assert.deepEqual(before.rows.map((r) => r.model_id), [...OLD_IDS])

    const now = Date.now()
    await query(
      `INSERT INTO client_sessions (id, created_at, last_at, updated_at, model_id)
       VALUES ($1, $2, $2, $2, 'gpt-6-sol'), ($3, $2, $2, $2, 'gpt-6-sol-1m')`,
      ['0292-sol', now, '0292-sol-1m'],
    )

    const sql = await readFile(migrationPath, 'utf8')
    await query(sql)
    await query(sql)

    const prices = await query<{
      model_id: string
      input_per_mtok: string
      output_per_mtok: string
      cache_read_per_mtok: string
      cache_write_per_mtok: string
      default_effort: string
      visibility: string
      enabled: boolean
      upstream_model_id: string | null
    }>(
      `SELECT p.model_id, p.input_per_mtok::text, p.output_per_mtok::text,
              p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
              p.default_effort, p.visibility, p.enabled, c.upstream_model_id
         FROM model_pricing p
         JOIN model_catalog c ON c.model_id = p.model_id AND c.state = 'active'
        WHERE p.model_id = ANY($1::text[])
        ORDER BY p.model_id`,
      [NEW_IDS],
    )
    assert.deepEqual(
      prices.rows.map((r) => [
        r.model_id,
        r.input_per_mtok,
        r.output_per_mtok,
        r.cache_read_per_mtok,
        r.cache_write_per_mtok,
        r.default_effort,
        r.visibility,
        r.enabled,
        r.upstream_model_id,
      ]),
      [
        ['gpt-6.1-sol', '100', '500', '5', '125', 'medium', 'public', true, null],
        ['gpt-6.1-sol-1m', '150', '750', '8', '188', 'medium', 'public', true, 'gpt-6.1-sol'],
      ],
    )

    const retired = await query<{ model_id: string; state: string; enabled: boolean; visibility: string }>(
      `SELECT c.model_id, c.state, p.enabled, p.visibility
         FROM model_catalog c JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [OLD_IDS],
    )
    assert.deepEqual(
      retired.rows.map((r) => [r.model_id, r.state, r.enabled, r.visibility]),
      [
        ['gpt-6-sol', 'disabled', false, 'hidden'],
        ['gpt-6-sol-1m', 'disabled', false, 'hidden'],
      ],
    )

    const sessions = await query<{ id: string; model_id: string }>(
      `SELECT id, model_id FROM client_sessions WHERE id LIKE '0292-sol%' ORDER BY id`,
    )
    assert.deepEqual(
      sessions.rows.map((r) => [r.id, r.model_id]),
      [
        ['0292-sol', 'gpt-6.1-sol'],
        ['0292-sol-1m', 'gpt-6.1-sol-1m'],
      ],
    )

    const groups = await query<{ model_id: string; n: string }>(
      `SELECT model_id, count(*)::text AS n FROM account_group_models
        WHERE model_id IN ('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-1m', 'gpt-6-sol', 'gpt-6-sol-1m')
        GROUP BY model_id ORDER BY model_id`,
    )
    const byId = new Map(groups.rows.map((r) => [r.model_id, r.n]))
    assert.equal(byId.get('gpt-6.1-sol'), byId.get('gpt-6-astra'))
    assert.equal(byId.has('gpt-6.1-sol-1m'), false)
    assert.equal(byId.has('gpt-6-sol'), false)
    assert.ok(Number(byId.get('gpt-6-astra')) >= 1)
  })
})
