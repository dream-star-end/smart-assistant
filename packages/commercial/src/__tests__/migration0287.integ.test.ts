/**
 * 0287 Claude Opus 5.5 catalog context_window → 1M.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0287.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0287_opus55_ctx_1m_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0287_claude_opus_55_context_1m.sql')
const metadataPath = path.resolve(here, '../../../../deploy/v5/release-metadata.json')

type ActiveRow = {
  model_id: string
  entry_id: string
  engine: string
  provider_id: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: unknown
}

async function activeRow(modelId: string): Promise<ActiveRow | undefined> {
  const r = await query<ActiveRow>(
    `SELECT model_id, entry_id::text AS entry_id, engine, provider_id,
            upstream_model_id, context_window, capability_profile
       FROM model_catalog
      WHERE state = 'active' AND model_id = $1`,
    [modelId],
  )
  return r.rows[0]
}

async function pricingSnapshot(): Promise<unknown> {
  const r = await query<{ snap: unknown }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb) AS snap
       FROM model_pricing p WHERE p.model_id = 'claude-opus-5-5'`,
  )
  return r.rows[0]!.snap
}

async function epoch(): Promise<number> {
  const r = await query<{ epoch: string }>('SELECT epoch::text AS epoch FROM model_security_epoch')
  return Number(r.rows[0]!.epoch)
}

describe('0287_claude_opus_55_context_1m', () => {
  test('switches only claude-opus-5-5 to context_window=1M and replays cleanly', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0287')

    const before = await activeRow('claude-opus-5-5')
    assert.ok(before, '0286 must leave an active claude-opus-5-5 row')
    assert.equal(before.engine, 'ccb')
    assert.equal(before.provider_id, 'anthropic')
    assert.equal(before.context_window, 200000)
    const opus5 = await activeRow('claude-opus-5')
    assert.equal(opus5?.context_window, 200000)
    const pricingBefore = await pricingSnapshot()
    const epochBefore = await epoch()

    const sql = await readFile(migrationPath, 'utf8')
    assert.match(sql, /^-- order-dependency: 0286_claude_opus_55/m)
    await query(sql)

    const after = await activeRow('claude-opus-5-5')
    assert.ok(after)
    assert.equal(after.context_window, 1000000)
    assert.notEqual(after.entry_id, before.entry_id)
    assert.equal(after.engine, before.engine)
    assert.equal(after.provider_id, before.provider_id)
    assert.equal(after.upstream_model_id, before.upstream_model_id)
    assert.deepEqual(after.capability_profile, before.capability_profile)
    const retired = await query<{ state: string; context_window: number }>(
      `SELECT state, context_window FROM model_catalog WHERE entry_id = $1`,
      [before.entry_id],
    )
    assert.equal(retired.rows[0]?.state, 'retired')
    assert.equal(retired.rows[0]?.context_window, 200000)
    assert.equal((await activeRow('claude-opus-5'))?.entry_id, opus5?.entry_id)
    assert.equal((await activeRow('claude-opus-5'))?.context_window, 200000)
    assert.deepEqual(await pricingSnapshot(), pricingBefore)
    const epochAfter = await epoch()
    assert.ok(epochAfter > epochBefore)
    const glm = await query<{ w: number }>(`SELECT fn_model_catalog_context_window('glm-5.3') AS w`)
    const sol = await query<{ w: number | null }>(`SELECT fn_model_catalog_context_window('gpt-5.6-sol') AS w`)
    assert.equal(glm.rows[0]?.w, 1000000)
    assert.equal(sol.rows[0]?.w, null)

    const derived = await query<{ w: number }>(
      `SELECT fn_model_catalog_context_window('claude-opus-5-5') AS w`,
    )
    assert.equal(derived.rows[0]?.w, 1000000)
    const sibling = await query<{ w: number }>(
      `SELECT fn_model_catalog_context_window('claude-opus-5') AS w`,
    )
    assert.equal(sibling.rows[0]?.w, 200000)

    await query(sql)
    const replay = await activeRow('claude-opus-5-5')
    assert.equal(replay?.entry_id, after.entry_id)
    assert.equal(replay?.context_window, 1000000)
    assert.equal(await epoch(), epochAfter)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { requiredMigrations: string[] }
    assert.ok(metadata.requiredMigrations.includes('0287_claude_opus_55_context_1m'))
    const idx = metadata.requiredMigrations.indexOf('0287_claude_opus_55_context_1m')
    assert.equal(metadata.requiredMigrations[idx - 1], '0286_claude_opus_55')
  })
})
