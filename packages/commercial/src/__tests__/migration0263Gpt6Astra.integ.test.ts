/**
 * 0263 GPT-6-Astra (Codex 0.153.3) + Luna public.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0263Gpt6Astra.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CODEX_ENGINE_MODELS, contextFamilyByModelId } from '@openclaude/protocol'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0263_gpt6_astra_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0263_gpt6_astra_and_luna_public.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

type PriceRow = {
  model_id: string
  display_name: string
  input_per_mtok: string
  output_per_mtok: string
  cache_read_per_mtok: string
  cache_write_per_mtok: string
  multiplier: string
  enabled: boolean
  sort_order: number
  visibility: string
  default_effort: string | null
  min_plan_code: string | null
  extra_system_prompt: string | null
  engine: string | null
  provider_id: string | null
  upstream_model_id: string | null
  context_window: number | null
  state: string | null
  capability_profile: unknown
}

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

async function rows(ids: readonly string[]): Promise<Map<string, PriceRow>> {
  const res = await query<PriceRow>(
    `SELECT p.model_id, p.display_name,
            p.input_per_mtok::text, p.output_per_mtok::text,
            p.cache_read_per_mtok::text, p.cache_write_per_mtok::text,
            p.multiplier::text, p.enabled, p.sort_order, p.visibility,
            p.default_effort, p.min_plan_code, p.extra_system_prompt,
            c.engine, c.provider_id, c.upstream_model_id, c.context_window, c.state,
            c.capability_profile
       FROM model_pricing p
       LEFT JOIN model_catalog c ON c.model_id = p.model_id AND c.state = 'active'
      WHERE p.model_id = ANY($1::text[])`,
    [ids],
  )
  return new Map(res.rows.map((r) => [r.model_id, r]))
}

const x2 = (v: string) => (BigInt(v) * 2n).toString()
const x15 = (v: string) => ((BigInt(v) * 3n + 1n) / 2n).toString()

describe('0263_gpt6_astra_and_luna_public', () => {
  test('protocol declares Astra as a Codex model with a 1M twin', () => {
    const astra = CODEX_ENGINE_MODELS.find((m) => m.id === 'gpt-6-astra')
    const astra1m = CODEX_ENGINE_MODELS.find((m) => m.id === 'gpt-6-astra-1m')
    assert.equal(astra?.defaultReasoningEffort, 'xhigh')
    assert.equal(astra1m?.longContext, true)
    assert.equal(contextFamilyByModelId('gpt-6-astra')?.longId, 'gpt-6-astra-1m')
  })

  test('adds Astra standard (Sol x2) + 1M (1.5x), ranked above Sol, and makes Luna public', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0263')
    const before = await rows(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-luna-1m'])
    const sol = before.get('gpt-5.6-sol')!
    assert.equal(before.get('gpt-5.6-luna')!.visibility, 'hidden', 'fixture: 0183 leaves Luna hidden')
    const epochBefore = await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')

    await query(await loadSql())

    const after = await rows([
      'gpt-6-astra', 'gpt-6-astra-1m', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-luna-1m',
    ])
    const astra = after.get('gpt-6-astra')!
    const astra1m = after.get('gpt-6-astra-1m')!

    for (const row of [astra, astra1m]) {
      assert.equal(row.state, 'active')
      assert.equal(row.enabled, true)
      assert.equal(row.engine, 'codex')
      assert.equal(row.provider_id, 'codex')
      assert.equal(row.display_name, 'GPT-6-Astra')
      assert.equal(Number(row.multiplier), 1)
      assert.equal(row.default_effort, 'xhigh')
      assert.equal(row.visibility, sol.visibility)
      assert.equal(row.min_plan_code, sol.min_plan_code)
      assert.equal(row.extra_system_prompt, sol.extra_system_prompt)
      assert.equal(row.sort_order, sol.sort_order - 1)
      assert.deepEqual(row.capability_profile, sol.capability_profile)
    }
    assert.equal(astra.upstream_model_id, null)
    assert.equal(astra.context_window, null)
    assert.equal(astra1m.upstream_model_id, 'gpt-6-astra')
    assert.equal(astra1m.context_window, 1_000_000)

    assert.equal(astra.input_per_mtok, x2(sol.input_per_mtok))
    assert.equal(astra.output_per_mtok, x2(sol.output_per_mtok))
    assert.equal(astra.cache_read_per_mtok, x2(sol.cache_read_per_mtok))
    assert.equal(astra.cache_write_per_mtok, x2(sol.cache_write_per_mtok))
    assert.equal(astra1m.input_per_mtok, x15(astra.input_per_mtok))
    assert.equal(astra1m.output_per_mtok, x15(astra.output_per_mtok))
    assert.equal(astra1m.cache_read_per_mtok, x15(astra.cache_read_per_mtok))
    assert.equal(astra1m.cache_write_per_mtok, x15(astra.cache_write_per_mtok))

    const solAfter = after.get('gpt-5.6-sol')!
    assert.equal(solAfter.input_per_mtok, sol.input_per_mtok)
    assert.equal(solAfter.sort_order, sol.sort_order)

    assert.equal(after.get('gpt-5.6-luna')!.visibility, 'public')
    assert.equal(after.get('gpt-5.6-luna-1m')!.visibility, 'public')
    assert.equal(after.get('gpt-5.6-luna')!.input_per_mtok, before.get('gpt-5.6-luna')!.input_per_mtok)

    const groups = await query<{ sol: string; astra: string; astra1m: string }>(
      `SELECT
         (SELECT count(*) FROM account_group_models gm JOIN account_groups g ON g.id = gm.group_id
           WHERE gm.model_id = 'gpt-5.6-sol' AND g.provider = 'codex')::text AS sol,
         (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6-astra')::text AS astra,
         (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6-astra-1m')::text AS astra1m`,
    )
    assert.equal(groups.rows[0]!.astra, groups.rows[0]!.sol)
    assert.equal(groups.rows[0]!.astra1m, '0')

    const grants = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_visibility_grants WHERE model_id LIKE 'gpt-6-astra%'`,
    )
    assert.equal(grants.rows[0]!.count, '0')

    const epochAfter = await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')
    assert.ok(BigInt(epochAfter.rows[0]!.epoch) > BigInt(epochBefore.rows[0]!.epoch))
  })

  test('refuses replay', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0263')
    await query(await loadSql())
    await assert.rejects(async () => query(await loadSql()), /refuses pre-existing gpt-6-astra/)
  })

  test('is registered in release metadata after 0262', async () => {
    const meta = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    const idx = meta.requiredMigrations.indexOf('0263_gpt6_astra_and_luna_public')
    assert.ok(idx > 0)
    assert.equal(meta.requiredMigrations[idx - 1], '0262_cursor_sand_usage_columns')
  })
})
