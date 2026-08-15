/**
 * 0216 Moonshot K3 256K publication and K3 effort capability transition.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0216.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCatalogSnapshot } from '../billing/modelCatalog.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0216_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0216_kimi_k3_256k.sql')
const modelIds = ['kimi-k3', 'k3-256k'] as const

const oldProfile = {
  supports_vision: true,
  reasoning: { supported: [], codex_model_default: null },
  ccb: { capability_zero: true, supports_thinking: true },
}
const newProfile = {
  supports_vision: true,
  reasoning: { supported: ['low', 'high', 'max'], codex_model_default: null },
  ccb: { capability_zero: true, supports_thinking: true },
}

function testedManualCompensationSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL COMPENSATION 0216'
  const end = '-- END TESTED MANUAL COMPENSATION 0216'
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
  await resetAndMigrateBefore('0216')
  return readFile(migrationPath, 'utf8')
}

async function fullTargetState(): Promise<unknown> {
  const transitionTable = await query<{ present: boolean }>(
    `SELECT to_regclass('public.model_k3_256k_transition') IS NOT NULL AS present`,
  )
  const transition = transitionTable.rows[0]?.present
    ? (
        await query<{ rows: unknown }>(
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) AS rows
             FROM model_k3_256k_transition t`,
        )
      ).rows[0]?.rows
    : null
  const result = await query<{ state: unknown }>(
    `SELECT jsonb_build_object(
       'catalog',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id)
                    FROM model_catalog c WHERE c.model_id=ANY($1::text[])),
       'pricing',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id)
                    FROM model_pricing p WHERE p.model_id=ANY($1::text[])),
       'aliases',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.alias)
                    FROM model_aliases a JOIN model_catalog c ON c.entry_id=a.entry_id
                   WHERE a.alias='k3-256k' OR c.model_id=ANY($1::text[])),
       'requirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.model_id,r.requirement)
                         FROM model_runtime_requirements r
                        WHERE r.model_id=ANY($1::text[])),
       'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id,g.model_id)
                   FROM model_visibility_grants g WHERE g.model_id=ANY($1::text[])),
       'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.group_id,g.model_id)
                   FROM account_group_models g WHERE g.model_id=ANY($1::text[])),
       'prefs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id)
                  FROM user_preferences p WHERE p.prefs->>'default_model'=ANY($1::text[])),
       'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                     FROM client_sessions s WHERE s.model_id=ANY($1::text[]))
     ) AS state`,
    [[...modelIds]],
  )
  return { state: result.rows[0]?.state, transition }
}

async function createUser(email: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,status)
     VALUES ($1,'x','user','active') RETURNING id::text AS id`,
    [email],
  )
  return result.rows[0]!.id
}

async function insertLiveSession(id: string, userId: string, model: string): Promise<void> {
  await query(
    `INSERT INTO client_sessions(
       id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
       updated_at,deleted_at,next_seq,archived_through_seq,archived_count,model_id
     ) VALUES ($1,$2,'main','test',0,1000,1000,'[]',0,1000,NULL,1,0,0,$3)`,
    [id, userId, model],
  )
}

async function applyAndCompensation(): Promise<{ compensation: string; sql: string }> {
  const sql = await prepareFloor()
  await query(sql)
  return { sql, compensation: testedManualCompensationSql(sql) }
}

describe('0216_kimi_k3_256k', () => {
  test('publishes exact descriptors/prices and exposes both K3 models publicly without grants', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()

    await query(sql)

    const rows = await query<{
      model_id: string
      engine: string
      provider_id: string
      upstream_model_id: string | null
      context_window: number
      capability_profile: unknown
      state: string
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
    }>(
      `SELECT c.model_id,c.engine,c.provider_id,c.upstream_model_id,c.context_window,
              c.capability_profile,c.state,p.display_name,
              p.input_per_mtok::text,p.output_per_mtok::text,
              p.cache_read_per_mtok::text,p.cache_write_per_mtok::text,
              p.multiplier::text,p.enabled,p.sort_order,p.visibility,p.default_effort
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id=ANY($1::text[]) AND c.state='active'
        ORDER BY c.model_id`,
      [[...modelIds]],
    )
    assert.deepEqual(rows.rows, [
      {
        model_id: 'k3-256k',
        engine: 'ccb',
        provider_id: 'moonshot',
        upstream_model_id: null,
        context_window: 262144,
        capability_profile: newProfile,
        state: 'active',
        display_name: 'Kimi K3 256K',
        input_per_mtok: '500',
        output_per_mtok: '2500',
        cache_read_per_mtok: '50',
        cache_write_per_mtok: '0',
        multiplier: '1.000',
        enabled: true,
        sort_order: 90,
        visibility: 'public',
        default_effort: null,
      },
      {
        model_id: 'kimi-k3',
        engine: 'ccb',
        provider_id: 'moonshot',
        upstream_model_id: null,
        context_window: 1048576,
        capability_profile: newProfile,
        state: 'active',
        display_name: 'Kimi K3',
        input_per_mtok: '1000',
        output_per_mtok: '5000',
        cache_read_per_mtok: '100',
        cache_write_per_mtok: '0',
        multiplier: '1.000',
        enabled: true,
        sort_order: 89,
        visibility: 'public',
        default_effort: null,
      },
    ])

    const snapshot = await loadCatalogSnapshot()
    const target = snapshot.resolve('k3-256k')
    assert.equal(target?.canonicalModel, 'k3-256k')
    assert.equal(target?.upstreamModelId, 'k3-256k')
    assert.equal(target?.contextWindow, 262144)
    assert.deepEqual(target?.capabilityProfile.reasoning.supported, ['low', 'high', 'max'])
    const projection = snapshot.listForUser({
      uid: 77,
      role: 'user',
      grantedModelIds: new Set(),
    })
    assert.deepEqual(
      projection
        .filter((row) => modelIds.includes(row.modelId as (typeof modelIds)[number]))
        .map((row) => ({ id: row.modelId, efforts: [...row.supportedEfforts] })),
      [
        { id: 'kimi-k3', efforts: ['low', 'high', 'max'] },
        { id: 'k3-256k', efforts: ['low', 'high', 'max'] },
      ],
    )
    assert.equal(
      snapshot.canUseModel({ uid: 77, role: 'user', grantedModelIds: new Set() }, 'k3-256k'),
      true,
    )
  })

  test('is a no-op only for its exact uncompensated terminal lineage', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query(sql)
    const once = await fullTargetState()

    await query(sql)

    assert.deepEqual(await fullTargetState(), once)
    const ledger = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM model_k3_256k_transition',
    )
    assert.equal(ledger.rows[0]?.n, '1')
  })

  test('tested compensation hides 256K, restores legacy Phase-A capability, and preserves both ledgers', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { sql, compensation } = await applyAndCompensation()
    await query(
      `INSERT INTO schema_migrations(version,applied_at)
       VALUES ('0216_kimi_k3_256k',now()) ON CONFLICT DO NOTHING`,
    )

    await query(compensation)

    const snapshot = await loadCatalogSnapshot()
    assert.deepEqual(snapshot.resolve('kimi-k3')?.capabilityProfile.reasoning.supported, [])
    assert.equal(snapshot.resolve('k3-256k'), null)
    assert.equal(
      snapshot
        .listForUser({ uid: 77, role: 'user', grantedModelIds: new Set() })
        .some((row) => row.modelId === 'k3-256k'),
      false,
    )
    const terminal = await query<{
      legacy_profile: unknown
      target_state: string
      target_enabled: boolean
      target_visibility: string
      compensated: boolean
      restored: boolean
      schema_ledger: boolean
    }>(
      `SELECT
         (SELECT capability_profile FROM model_catalog
           WHERE model_id='kimi-k3' AND state='active') AS legacy_profile,
         (SELECT state FROM model_catalog
           WHERE model_id='k3-256k' AND entry_id=t.target_entry_id) AS target_state,
         (SELECT enabled FROM model_pricing WHERE model_id='k3-256k') AS target_enabled,
         (SELECT visibility FROM model_pricing WHERE model_id='k3-256k') AS target_visibility,
         t.compensated_at IS NOT NULL AS compensated,
         t.restored_legacy_entry_id IS NOT NULL AS restored,
         EXISTS(SELECT 1 FROM schema_migrations
                 WHERE version='0216_kimi_k3_256k') AS schema_ledger
       FROM model_k3_256k_transition t`,
    )
    assert.deepEqual(terminal.rows[0], {
      legacy_profile: oldProfile,
      target_state: 'disabled',
      target_enabled: false,
      target_visibility: 'hidden',
      compensated: true,
      restored: true,
      schema_ledger: true,
    })

    const compensatedState = await fullTargetState()
    await assert.rejects(query(compensation), /compensation already completed/)
    assert.deepEqual(await fullTargetState(), compensatedState)
    await assert.rejects(query(sql), /was compensated and cannot be re-published/)
    assert.deepEqual(await fullTargetState(), compensatedState)
  })

  test('refuses predecessor pricing drift atomically before any target publication', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query("UPDATE model_pricing SET input_per_mtok=input_per_mtok+1 WHERE model_id='kimi-k3'")
    const before = await fullTargetState()

    await assert.rejects(query(sql), /pricing predecessor precondition failed/)

    assert.deepEqual(await fullTargetState(), before)
    const target = await query<{ n: string }>(
      `SELECT (SELECT count(*) FROM model_catalog WHERE model_id='k3-256k')::text AS n`,
    )
    assert.equal(target.rows[0]?.n, '0')
  })

  test('refuses an extra predecessor catalog history row atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const active = await query<{ lock_version: number }>(
      `SELECT lock_version FROM model_catalog
        WHERE model_id='kimi-k3' AND state='active'`,
    )
    await query(
      `SELECT fn_model_switch_version(
         'kimi-k3','ccb','moonshot',NULL,1048576,$1::jsonb,1,NULL,$2
       )`,
      [oldProfile, active.rows[0]!.lock_version],
    )
    const before = await fullTargetState()

    await assert.rejects(query(sql), /catalog lineage precondition failed/)

    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses catalog drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    await query(
      `UPDATE model_catalog SET updated_by=1
        WHERE model_id='k3-256k' AND state='active'`,
    )
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /catalog descriptor drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses pricing drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    await query("UPDATE model_pricing SET input_per_mtok=input_per_mtok+1 WHERE model_id='k3-256k'")
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /pricing drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses alias drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    await query("SELECT fn_model_alias_set('k3-short','k3-256k',NULL)")
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /alias drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses grant drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    const userId = await createUser('k3-256k-grant-drift@test.invalid')
    await query("INSERT INTO model_visibility_grants(user_id,model_id) VALUES ($1,'k3-256k')", [
      userId,
    ])
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /target grant\/group mapping drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses account-group mapping drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    const group = await query<{ id: string }>(
      `INSERT INTO account_groups(label,kind,provider)
       VALUES ('k3-256k-drift','official_oauth','claude')
       RETURNING id::text AS id`,
    )
    await query("INSERT INTO account_group_models(group_id,model_id) VALUES ($1,'k3-256k')", [
      group.rows[0]!.id,
    ])
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /target grant\/group mapping drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses runtime-requirement drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    await query(
      `INSERT INTO model_runtime_requirements(model_id,requirement)
       VALUES ('k3-256k','test-drift')`,
    )
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /runtime requirement drift/)
    assert.deepEqual(await fullTargetState(), before)
  })

  test('compensation refuses default and live-session drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { compensation } = await applyAndCompensation()
    const userId = await createUser('k3-256k-default-drift@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"default_model":"k3-256k"}'::jsonb)`,
      [userId],
    )
    await insertLiveSession('k3-256k-live', userId, 'k3-256k')
    const before = await fullTargetState()

    await assert.rejects(query(compensation), /target default\/live session drift/)
    assert.deepEqual(await fullTargetState(), before)
  })
})
