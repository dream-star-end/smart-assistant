/**
 * 0214 legacy model disable/hide transition and tested compensation.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0214.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query, tx } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0214_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0214_disable_legacy_models.sql')
const oldModels = ['qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2'] as const

interface SemanticRow {
  model_id: string
  state: string
  enabled: boolean
  visibility: string
  catalog_updated_by: string | null
  pricing_updated_by: string | null
  catalog_frozen: Record<string, unknown>
  pricing_frozen: Record<string, unknown>
}

function testedManualCompensationSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL COMPENSATION 0214'
  const end = '-- END TESTED MANUAL COMPENSATION 0214'
  assert.ok(migrationSql.includes(start) && migrationSql.includes(end))
  const body = migrationSql.slice(
    migrationSql.indexOf(start) + start.length,
    migrationSql.indexOf(end),
  )
  return body
    .split('\n')
    .map((line) => line.replace(/^-- ?/, ''))
    .join('\n')
}

async function prepareFloor(): Promise<string> {
  await resetAndMigrateBefore('0214')
  return readFile(migrationPath, 'utf8')
}

async function semanticRows(): Promise<SemanticRow[]> {
  const result = await query<SemanticRow>(
    `SELECT c.model_id,c.state,p.enabled,p.visibility,
            c.updated_by::text AS catalog_updated_by,
            p.updated_by::text AS pricing_updated_by,
            to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by'] AS catalog_frozen,
            to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by'] AS pricing_frozen
       FROM model_catalog c JOIN model_pricing p USING(model_id)
      WHERE c.model_id=ANY($1::text[])
      ORDER BY c.model_id`,
    [[...oldModels]],
  )
  return result.rows
}

async function makeQwenProductionLike(): Promise<void> {
  const admin = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,status)
     VALUES ('legacy-disable-admin@test.invalid','x','admin','active')
     RETURNING id::text AS id`,
  )
  await query(
    `UPDATE model_pricing
        SET enabled=FALSE,visibility='hidden',updated_by=$1,lock_version=lock_version+1
      WHERE model_id IN ('qwen3.7-max','qwen3.7-plus')`,
    [admin.rows[0]!.id],
  )
}

async function requirementModels(): Promise<string[]> {
  const result = await query<{ model_id: string }>(
    `SELECT model_id FROM model_runtime_requirements
      WHERE requirement='platform_default_and_hidden_reviewer'
      ORDER BY model_id`,
  )
  return result.rows.map((row) => row.model_id)
}

describe('0214_disable_legacy_models', () => {
  test('disables and hides all four models, shifts the runtime requirement, and removes only temporary fences', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const before = await semanticRows()
    assert.equal(before.length, 4)

    await query(sql)

    const after = await semanticRows()
    assert.deepEqual(
      after.map((row) => ({
        model: row.model_id,
        state: row.state,
        enabled: row.enabled,
        visibility: row.visibility,
      })),
      oldModels
        .slice()
        .sort()
        .map((model) => ({ model, state: 'disabled', enabled: false, visibility: 'hidden' })),
    )
    assert.deepEqual(await requirementModels(), ['glm-5.3'])

    const snapshots = await query<{
      model_id: string
      catalog_state: string
      pricing_enabled: boolean
      pricing_visibility: string
      frozen_matches: boolean
    }>(
      `SELECT s.model_id,s.catalog_state,s.pricing_enabled,s.pricing_visibility,
              ((to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
               AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen) AS frozen_matches
         FROM model_legacy_disable_snapshots s
         JOIN model_catalog c ON c.entry_id=s.entry_id
         JOIN model_pricing p ON p.model_id=s.model_id
        ORDER BY s.model_id`,
    )
    assert.equal(snapshots.rows.length, 4)
    assert.ok(snapshots.rows.every((row) => row.frozen_matches))
    for (const snapshot of snapshots.rows) {
      const original = before.find((row) => row.model_id === snapshot.model_id)
      assert.equal(snapshot.catalog_state, original?.state)
      assert.equal(snapshot.pricing_enabled, original?.enabled)
      assert.equal(snapshot.pricing_visibility, original?.visibility)
    }

    const objects = await query<{
      triggers: string
      functions: string
      retired: string
      ledger: boolean
    }>(
      `SELECT
         (SELECT count(*)::text FROM pg_trigger WHERE tgname LIKE 'trg_0213_normalize_%' AND NOT tgisinternal) AS triggers,
         (SELECT count(*)::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_0213_normalize_%') AS functions,
         (SELECT count(*)::text FROM model_catalog WHERE model_id=ANY($1::text[]) AND state='retired') AS retired,
         to_regclass('public.model_default_transition_snapshots') IS NOT NULL AS ledger`,
      [[...oldModels]],
    )
    assert.deepEqual(objects.rows[0], { triggers: '0', functions: '0', retired: '0', ledger: true })
  })

  test('preserves production-like already-disabled Qwen lineage while disabling both GLM rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await makeQwenProductionLike()
    const before = await query<{ model_id: string; catalog_lock: number; pricing_lock: number }>(
      `SELECT c.model_id,c.lock_version AS catalog_lock,p.lock_version AS pricing_lock
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus') ORDER BY c.model_id`,
    )

    await query(sql)

    const after = await query<{ model_id: string; catalog_lock: number; pricing_lock: number }>(
      `SELECT c.model_id,c.lock_version AS catalog_lock,p.lock_version AS pricing_lock
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus') ORDER BY c.model_id`,
    )
    assert.deepEqual(
      after.rows,
      before.rows,
      'already-disabled hidden rows must remain byte-lineage stable',
    )
    const states = await semanticRows()
    assert.ok(
      states.every(
        (row) => row.state === 'disabled' && !row.enabled && row.visibility === 'hidden',
      ),
    )
  })

  test('refuses a residual preference atomically before snapshots or catalog changes', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role) VALUES ('legacy-residual@test.invalid','x','user')
       RETURNING id::text AS id`,
    )
    await query(
      `ALTER TABLE user_preferences DISABLE TRIGGER trg_0213_normalize_user_default_model;
       INSERT INTO user_preferences(user_id,prefs)
       VALUES (${Number(user.rows[0]!.id)},'{"default_model":"glm-5.2"}'::jsonb);
       ALTER TABLE user_preferences ENABLE TRIGGER trg_0213_normalize_user_default_model;`,
    )
    const before = await semanticRows()

    await assert.rejects(query(sql), /requires zero legacy user\/session references/)
    assert.deepEqual(await semanticRows(), before)
    const snapshot = await query<{ exists: boolean }>(
      `SELECT to_regclass('public.model_legacy_disable_snapshots') IS NOT NULL AS exists`,
    )
    assert.equal(snapshot.rows[0]?.exists, false)
  })

  test('tested compensation restores mixed pre-C2 semantic states without retiring rows', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const compensation = testedManualCompensationSql(sql)
    await makeQwenProductionLike()
    const before = await semanticRows()

    await query(sql)
    const afterForward = await semanticRows()
    const grantee = await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role,status)
       VALUES ('legacy-compensation-drift@test.invalid','x','user','active')
       RETURNING id::text AS id`,
    )
    await query(
      `INSERT INTO model_visibility_grants(user_id,model_id)
       VALUES ($1,'glm-5.1')`,
      [grantee.rows[0]!.id],
    )

    await assert.rejects(
      tx(async (client) => {
        await client.query(compensation)
      }),
      /compensation refuses legacy grants\/group mappings\/aliases/,
    )
    assert.deepEqual(await semanticRows(), afterForward)
    assert.deepEqual(await requirementModels(), ['glm-5.3'])

    await query(
      `DELETE FROM model_visibility_grants
        WHERE user_id=$1 AND model_id='glm-5.1'`,
      [grantee.rows[0]!.id],
    )
    await query(`BEGIN; ${compensation} COMMIT;`)

    assert.deepEqual(await semanticRows(), before)
    assert.deepEqual(await requirementModels(), ['glm-5.2'])
    const proof = await query<{
      retired: string
      snapshots: string
      triggers: string
      functions: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM model_catalog WHERE model_id=ANY($1::text[]) AND state='retired') AS retired,
         (SELECT count(*)::text FROM model_legacy_disable_snapshots) AS snapshots,
         (SELECT count(*)::text FROM pg_trigger WHERE tgname LIKE 'trg_0213_normalize_%' AND NOT tgisinternal) AS triggers,
         (SELECT count(*)::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_0213_normalize_%') AS functions`,
      [[...oldModels]],
    )
    assert.deepEqual(proof.rows[0], { retired: '0', snapshots: '4', triggers: '0', functions: '0' })
  })
})
