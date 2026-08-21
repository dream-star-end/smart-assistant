/**
 * 0223 official CNY prices + GPT 1M catalog twins.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0223.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0223_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0223_official_cny_pricing_and_gpt_1m.sql')

const GPT_1M_IDS = ['gpt-5.6-sol-1m', 'gpt-5.6-terra-1m', 'gpt-5.6-luna-1m'] as const

async function loadSql(): Promise<string> {
  return readFile(migrationPath, 'utf8')
}

describe('0223_official_cny_pricing_and_gpt_1m', () => {
  test('refreshes vendor prices and activates GPT 1M twins with zero grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0223')
    await query(await loadSql())

    const pro = await query<{
      input_per_mtok: string
      cache_read_per_mtok: string
      output_per_mtok: string
    }>(
      `SELECT input_per_mtok::text, cache_read_per_mtok::text, output_per_mtok::text
         FROM model_pricing WHERE model_id = 'deepseek-v4-pro'`,
    )
    assert.equal(pro.rows[0]?.input_per_mtok, '450')
    assert.equal(pro.rows[0]?.cache_read_per_mtok, '15')
    assert.equal(pro.rows[0]?.output_per_mtok, '1350')

    const sol = await query<{ multiplier: string; input_per_mtok: string }>(
      `SELECT multiplier::text, input_per_mtok::text FROM model_pricing WHERE model_id = 'gpt-5.6-sol'`,
    )
    assert.equal(Number(sol.rows[0]?.multiplier), 1)
    assert.equal(sol.rows[0]?.input_per_mtok, '3395')

    const kimi = await query<{ model_id: string; input_per_mtok: string }>(
      `SELECT model_id, input_per_mtok::text FROM model_pricing
        WHERE model_id IN ('kimi-k3', 'k3-256k') ORDER BY model_id`,
    )
    const byId = Object.fromEntries(kimi.rows.map((row) => [row.model_id, row.input_per_mtok]))
    assert.equal(byId['k3-256k'], '1019')
    assert.equal(byId['kimi-k3'], '2037')

    const grokFast = await query<{ input_per_mtok: string; multiplier: string }>(
      `SELECT input_per_mtok::text, multiplier::text
         FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high-fast'`,
    )
    assert.equal(grokFast.rows[0]?.input_per_mtok, '1358')
    assert.equal(Number(grokFast.rows[0]?.multiplier), 2)

    const rows = await query<{
      model_id: string
      upstream_model_id: string
      context_window: number
      state: string
      enabled: boolean
      visibility: string
      input_per_mtok: string
    }>(
      `SELECT c.model_id, c.upstream_model_id, c.context_window, c.state, p.enabled, p.visibility,
              p.input_per_mtok::text
         FROM model_catalog c
         JOIN model_pricing p USING (model_id)
        WHERE c.model_id = ANY($1::text[])
        ORDER BY c.model_id`,
      [GPT_1M_IDS],
    )
    assert.equal(rows.rows.length, 3)
    const sol1m = rows.rows.find((row) => row.model_id === 'gpt-5.6-sol-1m')
    assert.equal(sol1m?.upstream_model_id, 'gpt-5.6-sol')
    assert.equal(sol1m?.context_window, 1_000_000)
    assert.equal(sol1m?.state, 'active')
    assert.equal(sol1m?.enabled, true)
    assert.equal(sol1m?.visibility, 'public')
    assert.equal(sol1m?.input_per_mtok, '6790')
    const luna1m = rows.rows.find((row) => row.model_id === 'gpt-5.6-luna-1m')
    assert.equal(luna1m?.visibility, 'hidden')

    const grants = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM model_visibility_grants WHERE model_id = ANY($1::text[])`,
      [GPT_1M_IDS],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('copies hidden Luna grants on the default profile', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0223')
    await query(
      `INSERT INTO users(id, email, email_verified, password_hash, role)
       VALUES (1, 'gpt-admin-0223@example.com', TRUE, 'argon2$stub', 'admin')`,
    )
    await query(
      `INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
       VALUES (1, 'gpt-5.6-luna', 1)
       ON CONFLICT (user_id, model_id) DO NOTHING`,
    )
    await query(await loadSql())
    const grants = await query<{ model_id: string }>(
      `SELECT model_id FROM model_visibility_grants WHERE user_id = 1 AND model_id LIKE 'gpt-5.6-%-1m' ORDER BY model_id`,
    )
    assert.deepEqual(grants.rows.map((row) => row.model_id), ['gpt-5.6-luna-1m'])
  })
})
