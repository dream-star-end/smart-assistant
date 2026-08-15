/**
 * 0219 DeepSeek V4 Pro disable/hide transition and tested compensation.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0219.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query, tx } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0219_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0219_disable_deepseek_v4_pro.sql')

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
  const start = '-- BEGIN TESTED MANUAL COMPENSATION 0219'
  const end = '-- END TESTED MANUAL COMPENSATION 0219'
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
  await resetAndMigrateBefore('0219')
  return readFile(migrationPath, 'utf8')
}

async function semanticRow(): Promise<SemanticRow> {
  const result = await query<SemanticRow>(
    `SELECT c.model_id,c.state,p.enabled,p.visibility,
            c.updated_by::text AS catalog_updated_by,
            p.updated_by::text AS pricing_updated_by,
            to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by'] AS catalog_frozen,
            to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by'] AS pricing_frozen
       FROM model_catalog c JOIN model_pricing p USING(model_id)
      WHERE c.model_id='deepseek-v4-pro'
        AND c.state IN ('active','disabled')`,
  )
  assert.equal(result.rows.length, 1)
  return result.rows[0]!
}

async function makeProAlreadyHidden(): Promise<void> {
  const admin = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,status)
     VALUES ('dsv4pro-disable-admin@test.invalid','x','admin','active')
     RETURNING id::text AS id`,
  )
  await query(
    `UPDATE model_pricing
        SET visibility='hidden',updated_by=$1,lock_version=lock_version+1
      WHERE model_id='deepseek-v4-pro'
        AND visibility IS DISTINCT FROM 'hidden'`,
    [admin.rows[0]!.id],
  )
}

async function requirementPairs(): Promise<string[]> {
  const result = await query<{ model_id: string; requirement: string }>(
    `SELECT model_id,requirement FROM model_runtime_requirements
      WHERE model_id IN ('deepseek-v4-pro','deepseek-v4-flash')
      ORDER BY model_id,requirement`,
  )
  return result.rows.map((row) => `${row.model_id}:${row.requirement}`)
}

describe('0219_disable_deepseek_v4_pro', () => {
  test('disables and hides Pro, keeps Flash requirements, and removes only temporary fences', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const before = await semanticRow()
    assert.equal(before.state, 'active')
    assert.equal(before.enabled, true)
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])

    await query(sql)

    const after = await semanticRow()
    assert.deepEqual(
      {
        model: after.model_id,
        state: after.state,
        enabled: after.enabled,
        visibility: after.visibility,
      },
      {
        model: 'deepseek-v4-pro',
        state: 'disabled',
        enabled: false,
        visibility: 'hidden',
      },
    )
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])

    const snapshot = await query<{
      catalog_state: string
      pricing_enabled: boolean
      pricing_visibility: string
      frozen_matches: boolean
      profile_keys: string[]
    }>(
      `SELECT s.catalog_state,s.pricing_enabled,s.pricing_visibility,
              ((to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
               AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen) AS frozen_matches,
              (SELECT array_agg(key ORDER BY key)
                 FROM jsonb_object_keys(s.catalog_frozen->'capability_profile') AS key) AS profile_keys
         FROM model_dsv4pro_disable_snapshots s
         JOIN model_catalog c ON c.entry_id=s.entry_id
         JOIN model_pricing p ON p.model_id=s.model_id`,
    )
    assert.equal(snapshot.rows.length, 1)
    assert.equal(snapshot.rows[0]?.frozen_matches, true)
    assert.equal(snapshot.rows[0]?.catalog_state, before.state)
    assert.equal(snapshot.rows[0]?.pricing_enabled, before.enabled)
    assert.equal(snapshot.rows[0]?.pricing_visibility, before.visibility)
    assert.ok(
      snapshot.rows[0]?.profile_keys.includes('supports_vision')
        && snapshot.rows[0]?.profile_keys.includes('ccb'),
      'frozen capability_profile must stay snake_case',
    )

    const objects = await query<{
      triggers: string
      functions: string
      retired: string
      ledger: boolean
    }>(
      `SELECT
         (SELECT count(*)::text FROM pg_trigger WHERE tgname LIKE 'trg_0218_normalize_%' AND NOT tgisinternal) AS triggers,
         (SELECT count(*)::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_0218_normalize_%') AS functions,
         (SELECT count(*)::text FROM model_dsv4pro_disable_snapshots s JOIN model_catalog c ON c.entry_id=s.entry_id WHERE c.state='retired') AS retired,
         to_regclass('public.model_dsv4pro_transition_snapshots') IS NOT NULL AS ledger`,
    )
    assert.deepEqual(objects.rows[0], { triggers: '0', functions: '0', retired: '0', ledger: true })
  })

  test('preserves production-like already-hidden Pro pricing while disabling the catalog row', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await makeProAlreadyHidden()
    const before = await query<{ catalog_lock: number; pricing_lock: number; visibility: string }>(
      `SELECT c.lock_version AS catalog_lock,p.lock_version AS pricing_lock,p.visibility
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id='deepseek-v4-pro' AND c.state='active'`,
    )
    assert.equal(before.rows[0]?.visibility, 'hidden')

    await query(sql)

    const after = await query<{ catalog_lock: number; pricing_lock: number; visibility: string }>(
      `SELECT c.lock_version AS catalog_lock,p.lock_version AS pricing_lock,p.visibility
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id='deepseek-v4-pro' AND c.state='disabled'`,
    )
    assert.equal(after.rows[0]?.visibility, 'hidden')
    assert.equal(after.rows[0]?.pricing_lock, before.rows[0]?.pricing_lock)
    assert.equal(after.rows[0]?.catalog_lock, (before.rows[0]?.catalog_lock ?? 0) + 1)
    const state = await semanticRow()
    assert.equal(state.state, 'disabled')
    assert.equal(state.enabled, false)
    assert.equal(state.visibility, 'hidden')
  })

  test('refuses a residual preference atomically before snapshots or catalog changes', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const user = await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role) VALUES ('dsv4pro-residual@test.invalid','x','user')
       RETURNING id::text AS id`,
    )
    await query(
      `ALTER TABLE user_preferences DISABLE TRIGGER trg_0218_normalize_user_default_model;
       INSERT INTO user_preferences(user_id,prefs)
       VALUES (${Number(user.rows[0]!.id)},'{"default_model":"deepseek-v4-pro"}'::jsonb);
       ALTER TABLE user_preferences ENABLE TRIGGER trg_0218_normalize_user_default_model;`,
    )
    const before = await semanticRow()

    await assert.rejects(query(sql), /requires zero Pro user\/session references/)
    assert.deepEqual(await semanticRow(), before)
    const snapshot = await query<{ exists: boolean }>(
      `SELECT to_regclass('public.model_dsv4pro_disable_snapshots') IS NOT NULL AS exists`,
    )
    assert.equal(snapshot.rows[0]?.exists, false)
  })

  test('tested compensation restores pre-disable semantic state without retiring the row', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const compensation = testedManualCompensationSql(sql)
    await makeProAlreadyHidden()
    const before = await semanticRow()

    await query(sql)
    const afterForward = await semanticRow()
    const grantee = await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role,status)
       VALUES ('dsv4pro-compensation-drift@test.invalid','x','user','active')
       RETURNING id::text AS id`,
    )
    await query(
      `INSERT INTO model_visibility_grants(user_id,model_id)
       VALUES ($1,'deepseek-v4-pro')`,
      [grantee.rows[0]!.id],
    )

    await assert.rejects(
      tx(async (client) => {
        await client.query(compensation)
      }),
      /compensation refuses Pro grants\/group mappings\/aliases/,
    )
    assert.deepEqual(await semanticRow(), afterForward)
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])

    await query(
      `DELETE FROM model_visibility_grants
        WHERE user_id=$1 AND model_id='deepseek-v4-pro'`,
      [grantee.rows[0]!.id],
    )
    await query(`BEGIN; ${compensation} COMMIT;`)

    assert.deepEqual(await semanticRow(), before)
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])
    const proof = await query<{
      retired: string
      snapshots: string
      triggers: string
      functions: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM model_dsv4pro_disable_snapshots s JOIN model_catalog c ON c.entry_id=s.entry_id WHERE c.state='retired') AS retired,
         (SELECT count(*)::text FROM model_dsv4pro_disable_snapshots) AS snapshots,
         (SELECT count(*)::text FROM pg_trigger WHERE tgname LIKE 'trg_0218_normalize_%' AND NOT tgisinternal) AS triggers,
         (SELECT count(*)::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fn_0218_normalize_%') AS functions`,
    )
    assert.deepEqual(proof.rows[0], { retired: '0', snapshots: '1', triggers: '0', functions: '0' })
  })
})
