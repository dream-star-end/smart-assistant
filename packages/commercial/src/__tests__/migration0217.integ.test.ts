/**
 * 0217 Z.AI GLM-5.3 rollback-floor migration.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0217.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCatalogSnapshot } from '../billing/modelCatalog.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0217_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0217_stage_zai_glm53.sql')
const modelId = 'glm-5.3-zai'

const expectedProfile = {
  supports_vision: false,
  reasoning: { supported: ['high', 'max'], codex_model_default: null },
  ccb: { capability_zero: true, supports_thinking: true },
}

async function prepareFloor(): Promise<string> {
  await resetAndMigrateBefore('0217')
  return readFile(migrationPath, 'utf8')
}

async function fullTargetAndHelpers(): Promise<unknown> {
  const result = await query<{ state: unknown }>(
    `SELECT jsonb_build_object(
       'catalog',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id)
                    FROM model_catalog c WHERE c.model_id=$1),
       'pricing',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id)
                    FROM model_pricing p WHERE p.model_id=$1),
       'aliases',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.alias)
                    FROM model_aliases a LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
                   WHERE a.alias=$1 OR c.model_id=$1),
       'requirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requirement)
                         FROM model_runtime_requirements r WHERE r.model_id=$1),
       'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id)
                   FROM model_visibility_grants g WHERE g.model_id=$1),
       'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.group_id)
                   FROM account_group_models g WHERE g.model_id=$1),
       'prefs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id)
                  FROM user_preferences p WHERE p.prefs->>'default_model'=$1),
       'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                     FROM client_sessions s WHERE s.model_id=$1),
       'helpers',jsonb_build_object(
         'provider',fn_model_catalog_provider($1),
         'context',fn_model_catalog_context_window($1),
         'capability',fn_model_catalog_capability($1)
       )
     ) AS state`,
    [modelId],
  )
  return result.rows[0]?.state
}

describe('0217_stage_zai_glm53', () => {
  test('creates the exact disabled/hidden descriptor and copies GLM-5.3 billing with zero bindings', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()

    await query(sql)

    const rows = await query<{
      model_id: string
      engine: string
      provider_id: string
      upstream_model_id: string
      context_window: number
      capability_schema_version: number
      capability_profile: unknown
      state: string
      catalog_lock_version: number
      catalog_updated_by: string | null
      display_name: string
      prices_match: boolean
      enabled: boolean
      sort_order: number
      visibility: string
      pricing_lock_version: number
      pricing_updated_by: string | null
    }>(
      `SELECT target_catalog.model_id,target_catalog.engine,target_catalog.provider_id,
              target_catalog.upstream_model_id,target_catalog.context_window,
              target_catalog.capability_schema_version,target_catalog.capability_profile,
              target_catalog.state,target_catalog.lock_version AS catalog_lock_version,
              target_catalog.updated_by::text AS catalog_updated_by,
              target_pricing.display_name,
              (target_pricing.input_per_mtok,target_pricing.output_per_mtok,
               target_pricing.cache_read_per_mtok,target_pricing.cache_write_per_mtok,
               target_pricing.multiplier,target_pricing.extra_system_prompt,
               target_pricing.default_effort)
                IS NOT DISTINCT FROM
              (source_pricing.input_per_mtok,source_pricing.output_per_mtok,
               source_pricing.cache_read_per_mtok,source_pricing.cache_write_per_mtok,
               source_pricing.multiplier,source_pricing.extra_system_prompt,
               source_pricing.default_effort) AS prices_match,
              target_pricing.enabled,target_pricing.sort_order,target_pricing.visibility,
              target_pricing.lock_version AS pricing_lock_version,
              target_pricing.updated_by::text AS pricing_updated_by
         FROM model_catalog target_catalog
         JOIN model_pricing target_pricing USING(model_id)
         JOIN model_pricing source_pricing ON source_pricing.model_id='glm-5.3'
        WHERE target_catalog.model_id=$1`,
      [modelId],
    )
    assert.deepEqual(rows.rows, [
      {
        model_id: modelId,
        engine: 'ccb',
        provider_id: 'zai',
        upstream_model_id: 'glm-5.3',
        context_window: 1_000_000,
        capability_schema_version: 1,
        capability_profile: expectedProfile,
        state: 'disabled',
        catalog_lock_version: 2,
        catalog_updated_by: null,
        display_name: 'GLM-5.3 (Z.AI)',
        prices_match: true,
        enabled: false,
        sort_order: 84,
        visibility: 'hidden',
        pricing_lock_version: 0,
        pricing_updated_by: null,
      },
    ])

    const refs = await query<{
      aliases: string
      requirements: string
      grants: string
      groups: string
      prefs: string
      sessions: string
    }>(
      `SELECT
         (SELECT count(*) FROM model_aliases a LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
           WHERE a.alias=$1 OR c.model_id=$1)::text AS aliases,
         (SELECT count(*) FROM model_runtime_requirements WHERE model_id=$1)::text AS requirements,
         (SELECT count(*) FROM model_visibility_grants WHERE model_id=$1)::text AS grants,
         (SELECT count(*) FROM account_group_models WHERE model_id=$1)::text AS groups,
         (SELECT count(*) FROM user_preferences WHERE prefs->>'default_model'=$1)::text AS prefs,
         (SELECT count(*) FROM client_sessions WHERE model_id=$1)::text AS sessions`,
      [modelId],
    )
    assert.deepEqual(refs.rows[0], {
      aliases: '0',
      requirements: '0',
      grants: '0',
      groups: '0',
      prefs: '0',
      sessions: '0',
    })

    const helpers = await query<{
      provider: string
      ark_provider: string
      context: number
      capability: unknown
    }>(
      `SELECT fn_model_catalog_provider('GLM-5.3-ZAI') AS provider,
              fn_model_catalog_provider('GLM-5.3') AS ark_provider,
              fn_model_catalog_context_window('glm-5.3-zai') AS context,
              fn_model_catalog_capability('glm-5.3-zai') AS capability`,
    )
    assert.deepEqual(helpers.rows[0], {
      provider: 'zai',
      ark_provider: 'ark',
      context: 1_000_000,
      capability: expectedProfile,
    })

    const snapshot = await loadCatalogSnapshot()
    assert.equal(snapshot.resolve(modelId), null, 'disabled Release A row must not resolve')
    assert.equal(
      snapshot
        .listForUser({ uid: 77, role: 'user', grantedModelIds: new Set() })
        .some((row) => row.modelId === modelId),
      false,
      'hidden+disabled Release A row must not appear publicly',
    )
  })

  test('refuses predecessor visibility drift atomically before target/helper mutation', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query("UPDATE model_pricing SET visibility='hidden' WHERE model_id='glm-5.3'")
    const before = await fullTargetAndHelpers()

    await assert.rejects(query(sql), /glm-5\.3 pricing predecessor must be enabled and public/)

    assert.deepEqual(await fullTargetAndHelpers(), before)
  })

  test('refuses any pre-existing target lineage atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query(
      `SELECT fn_model_stage_version(
        $1,'ccb','ark','wrong-upstream',200000,
        '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":true,"supports_thinking":true}}'::jsonb,
        1,NULL
      )`,
      [modelId],
    )
    const before = await fullTargetAndHelpers()

    await assert.rejects(query(sql), /refuses pre-existing glm-5\.3-zai/)

    assert.deepEqual(await fullTargetAndHelpers(), before)
  })

  test('runner records 0217 once and skips the exact ledger version on rerun', async (t) => {
    if (db.skipIfUnavailable(t)) return
    await resetAndMigrateBefore('0217')

    const first = await runMigrations()
    assert.ok(first.applied.includes('0217_stage_zai_glm53'))
    const ledger = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations
        WHERE version='0217_stage_zai_glm53'`,
    )
    assert.equal(ledger.rows[0]?.n, '1')

    const once = await fullTargetAndHelpers()
    const second = await runMigrations()
    assert.ok(second.skipped.includes('0217_stage_zai_glm53'))
    assert.deepEqual(await fullTargetAndHelpers(), once)
  })
})
