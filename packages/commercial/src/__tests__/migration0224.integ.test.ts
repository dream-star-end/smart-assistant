/**
 * 0224 target xN billing + Max-gate Opus/Fable.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0224.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { costXVsBaseline } from '@openclaude/protocol'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0224_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0224_cost_x_targets_and_max_plan_gate.sql')

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

type PriceRow = {
  model_id: string
  input_per_mtok: string
  cache_read_per_mtok: string
  output_per_mtok: string
  multiplier: string
  min_plan_code: string | null
}

function xOf(row: PriceRow, pro: PriceRow): number | undefined {
  return costXVsBaseline(
    {
      inputPerMtok: row.input_per_mtok,
      cacheReadPerMtok: row.cache_read_per_mtok,
      outputPerMtok: row.output_per_mtok,
      multiplier: row.multiplier,
    },
    {
      inputPerMtok: pro.input_per_mtok,
      cacheReadPerMtok: pro.cache_read_per_mtok,
      outputPerMtok: pro.output_per_mtok,
      multiplier: pro.multiplier,
    },
  )
}

describe('0224_cost_x_targets_and_max_plan_gate', () => {
  test('reprices to target xN and Max-gates Opus/Fable', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0224')
    await query(await loadSql())

    const rows = await query<PriceRow>(
      `SELECT model_id,
              input_per_mtok::text AS input_per_mtok,
              cache_read_per_mtok::text AS cache_read_per_mtok,
              output_per_mtok::text AS output_per_mtok,
              multiplier::text AS multiplier,
              min_plan_code
         FROM model_pricing
        WHERE model_id IN (
          'deepseek-v4-pro', 'deepseek-v4-flash',
          'glm-5.2', 'glm-5.3', 'glm-5.3-zai',
          'k3-256k', 'kimi-k3',
          'gpt-5.6-sol', 'gpt-5.6-sol-1m',
          'gpt-5.6-terra', 'gpt-5.6-terra-1m',
          'gpt-5.6-luna', 'gpt-5.6-luna-1m',
          'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast',
          'cursor-composer-2.5', 'cursor-composer-2.5-fast',
          'cursor-opus-5-high', 'cursor-opus-5-high-fast',
          'cursor-fable-5-high'
        )`,
    )
    const byId = Object.fromEntries(rows.rows.map((row) => [row.model_id, row]))
    const pro = byId['deepseek-v4-pro']
    assert.ok(pro)
    assert.equal(pro.input_per_mtok, '450')
    assert.equal(xOf(pro, pro), 1.0)

    assert.equal(xOf(byId['glm-5.3'], pro), 2.0)
    assert.equal(xOf(byId['glm-5.3-zai'], pro), 2.0)
    assert.equal(xOf(byId['glm-5.2'], pro), 2.0)
    assert.equal(xOf(byId['k3-256k'], pro), 4.0)
    assert.equal(xOf(byId['kimi-k3'], pro), 8.0)
    assert.equal(xOf(byId['gpt-5.6-sol'], pro), 4.0)
    assert.equal(xOf(byId['gpt-5.6-sol-1m'], pro), 8.0)
    assert.equal(xOf(byId['gpt-5.6-terra'], pro), 2.0)
    assert.equal(xOf(byId['gpt-5.6-terra-1m'], pro), 4.0)
    assert.equal(xOf(byId['gpt-5.6-luna'], pro), 1.0)
    assert.equal(xOf(byId['gpt-5.6-luna-1m'], pro), 2.0)
    assert.equal(xOf(byId['deepseek-v4-flash'], pro), 0.5)
    assert.equal(xOf(byId['cursor-grok-4.6-high'], pro), 2.0)
    assert.equal(xOf(byId['cursor-grok-4.6-high-fast'], pro), 4.0)
    assert.equal(Number(byId['cursor-grok-4.6-high-fast'].multiplier), 2)
    assert.equal(xOf(byId['cursor-composer-2.5'], pro), 2.0)
    assert.equal(xOf(byId['cursor-composer-2.5-fast'], pro), 4.0)
    assert.equal(xOf(byId['cursor-opus-5-high'], pro), 10.0)
    assert.equal(xOf(byId['cursor-opus-5-high-fast'], pro), 20.0)
    assert.equal(xOf(byId['cursor-fable-5-high'], pro), 20.0)

    assert.equal(byId['cursor-opus-5-high'].min_plan_code, 'max')
    assert.equal(byId['cursor-fable-5-high'].min_plan_code, 'max')
    assert.equal(byId['cursor-grok-4.6-high'].min_plan_code, null)
    assert.equal(byId['gpt-5.6-sol'].min_plan_code, null)

    const gated = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_pricing
        WHERE min_plan_code = 'max'
          AND (model_id LIKE 'cursor-opus-5-%' OR model_id LIKE 'cursor-fable-5-%')`,
    )
    assert.equal(gated.rows[0]?.n, '15')
  })
})
