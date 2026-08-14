/**
 * 0211 GLM-5.3 / OpenCode Go Flash rollback-floor migration.
 *
 * Run: REQUIRE_TEST_DB=1 npx tsx --test packages/commercial/src/__tests__/migration0211.integ.test.ts
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0211_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0211_stage_glm53_opencode_flash.sql')

async function prepareAndReadMigration(): Promise<string> {
  await resetAndMigrateBefore('0211')
  return readFile(migrationPath, 'utf8')
}

describe('0211_stage_glm53_opencode_flash', () => {
  test('fails loud when a legacy Qwen rollback row is missing', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareAndReadMigration()
    await query("DELETE FROM model_pricing WHERE model_id='qwen3.7-max'")

    await assert.rejects(
      query(sql),
      /requires both legacy Qwen3\.7 live rows with catalog\/pricing parity/,
    )

    const targets = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM model_catalog
        WHERE model_id IN ('glm-5.3','deepseek-v4-flash-opencode-go')`,
    )
    assert.equal(targets.rows[0]?.count, '0', 'failed migration must roll back all target rows')
  })

  test('creates exact hidden/disabled catalog and pricing rows without grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareAndReadMigration()
    await query(sql)

    const catalog = await query<{
      model_id: string
      engine: string
      provider_id: string
      upstream_model_id: string
      context_window: number
      state: string
      capability_profile: unknown
    }>(
      `SELECT model_id,engine,provider_id,upstream_model_id,context_window,state,capability_profile
         FROM model_catalog
        WHERE model_id IN ('glm-5.3','deepseek-v4-flash-opencode-go')
          AND state IN ('staged','active','disabled')
        ORDER BY model_id`,
    )
    assert.deepEqual(catalog.rows, [
      {
        model_id: 'deepseek-v4-flash-opencode-go',
        engine: 'ccb',
        provider_id: 'opencodego',
        upstream_model_id: 'deepseek-v4-flash',
        context_window: 1_000_000,
        state: 'disabled',
        capability_profile: {
          supports_vision: false,
          reasoning: { supported: [], codex_model_default: null },
          ccb: { capability_zero: true, supports_thinking: true },
        },
      },
      {
        model_id: 'glm-5.3',
        engine: 'ccb',
        provider_id: 'ark',
        upstream_model_id: 'glm-5.3',
        context_window: 1_000_000,
        state: 'disabled',
        capability_profile: {
          supports_vision: false,
          reasoning: { supported: ['high', 'max'], codex_model_default: null },
          ccb: { capability_zero: true, supports_thinking: true },
        },
      },
    ])

    const pricing = await query<{
      model_id: string
      source_model: string
      prices_match: boolean
      enabled: boolean
      visibility: string
      sort_order: number
      lock_version: number
    }>(
      `SELECT target.model_id,
              source.model_id AS source_model,
              (target.input_per_mtok,target.output_per_mtok,target.cache_read_per_mtok,
               target.cache_write_per_mtok,target.multiplier,target.extra_system_prompt,
               target.default_effort)
                IS NOT DISTINCT FROM
              (source.input_per_mtok,source.output_per_mtok,source.cache_read_per_mtok,
               source.cache_write_per_mtok,source.multiplier,source.extra_system_prompt,
               source.default_effort) AS prices_match,
              target.enabled,target.visibility,target.sort_order,target.lock_version
         FROM model_pricing target
         JOIN model_pricing source ON source.model_id = CASE target.model_id
           WHEN 'glm-5.3' THEN 'glm-5.2'
           WHEN 'deepseek-v4-flash-opencode-go' THEN 'deepseek-v4-flash'
         END
        WHERE target.model_id IN ('glm-5.3','deepseek-v4-flash-opencode-go')
        ORDER BY target.model_id`,
    )
    assert.deepEqual(pricing.rows, [
      {
        model_id: 'deepseek-v4-flash-opencode-go',
        source_model: 'deepseek-v4-flash',
        prices_match: true,
        enabled: false,
        visibility: 'hidden',
        sort_order: 121,
        lock_version: 0,
      },
      {
        model_id: 'glm-5.3',
        source_model: 'glm-5.2',
        prices_match: true,
        enabled: false,
        visibility: 'hidden',
        sort_order: 83,
        lock_version: 0,
      },
    ])

    const qwen = await query<{ model_id: string; state: string; enabled: boolean; visibility: string }>(
      `SELECT c.model_id,c.state,p.enabled,p.visibility
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus')
          AND c.state IN ('staged','active','disabled')
        ORDER BY c.model_id`,
    )
    assert.deepEqual(qwen.rows, [
      { model_id: 'qwen3.7-max', state: 'active', enabled: true, visibility: 'hidden' },
      { model_id: 'qwen3.7-plus', state: 'active', enabled: true, visibility: 'hidden' },
    ])

    const helpers = await query<{
      glm_provider: string
      flash_provider: string
      glm_context: number
      flash_context: number
    }>(
      `SELECT fn_model_catalog_provider('GLM-5.3') AS glm_provider,
              fn_model_catalog_provider('DeepSeek-V4-Flash-OpenCode-Go') AS flash_provider,
              fn_model_catalog_context_window('glm-5.3') AS glm_context,
              fn_model_catalog_context_window('deepseek-v4-flash-opencode-go') AS flash_context`,
    )
    assert.deepEqual(helpers.rows, [{
      glm_provider: 'ark',
      flash_provider: 'opencodego',
      glm_context: 1_000_000,
      flash_context: 1_000_000,
    }])

    const grants = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_visibility_grants
        WHERE model_id IN ('glm-5.3','deepseek-v4-flash-opencode-go')`,
    )
    assert.equal(grants.rows[0]?.count, '0')
  })
})
