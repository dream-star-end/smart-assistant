/**
 * 0219 DeepSeek V4 Pro → Flash transition and deploy-gap write fence.
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

import { addGrant, removeGrant } from '../admin/modelGrants.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0219_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0219_deepseek_v4_pro_transition.sql')

function testedManualRollbackSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL ROLLBACK 0219'
  const end = '-- END TESTED MANUAL ROLLBACK 0219'
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

async function createUser(email: string, role = 'user'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role)
     VALUES ($1,'x',$2)
     RETURNING id::text AS id`,
    [email, role],
  )
  return result.rows[0]!.id
}

async function insertSession(args: {
  id: string
  userId: string
  model: string | null
  deleted?: boolean
}): Promise<void> {
  await query(
    `INSERT INTO client_sessions(
       id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
       updated_at,deleted_at,next_seq,archived_through_seq,archived_count,model_id
     ) VALUES ($1,$2,'main','test',0,1000,1000,'[]',0,1000,$3,1,0,0,$4)`,
    [args.id, args.userId, args.deleted ? 2000 : null, args.model],
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

async function grantModels(userId: string): Promise<string[]> {
  const result = await query<{ model_id: string }>(
    `SELECT model_id FROM model_visibility_grants
      WHERE user_id=$1::bigint ORDER BY model_id`,
    [userId],
  )
  return result.rows.map((row) => row.model_id)
}

describe('0219_deepseek_v4_pro_transition', () => {
  test('backfills prefs/sessions, shifts official_seed_agent, leaves grants, and is idempotent', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const movedUser = await createUser('dsv4pro-backfill@test.invalid')
    const overlapUser = await createUser('dsv4pro-overlap@test.invalid')
    const untouchedUser = await createUser('dsv4pro-untouched@test.invalid')

    await query(
      `INSERT INTO user_preferences(user_id,prefs) VALUES
       ($1,jsonb_build_object('theme','dark','default_model','deepseek-v4-pro')),
       ($2,jsonb_build_object('theme','dark','default_model','deepseek-v4-pro')),
       ($3,jsonb_build_object('theme','light','default_model','glm-5.3'))`,
      [movedUser, overlapUser, untouchedUser],
    )
    await insertSession({ id: 'live-pro', userId: movedUser, model: 'deepseek-v4-pro' })
    await insertSession({ id: 'deleted-pro', userId: movedUser, model: 'deepseek-v4-pro', deleted: true })
    await insertSession({ id: 'live-other', userId: untouchedUser, model: 'glm-5.3' })
    await query(
      `INSERT INTO model_visibility_grants(user_id,model_id) VALUES
       ($1,'deepseek-v4-pro'),
       ($2,'deepseek-v4-pro'),
       ($2,'deepseek-v4-flash')`,
      [movedUser, overlapUser],
    )

    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-pro:official_seed_agent',
    ])

    await query(sql)

    const preferences = await query<{ user_id: string; model: string; theme: string }>(
      `SELECT user_id::text, prefs->>'default_model' AS model, prefs->>'theme' AS theme
         FROM user_preferences ORDER BY user_id`,
    )
    assert.deepEqual(preferences.rows.find((row) => row.user_id === movedUser), {
      user_id: movedUser,
      model: 'deepseek-v4-flash',
      theme: 'dark',
    })
    assert.deepEqual(preferences.rows.find((row) => row.user_id === overlapUser), {
      user_id: overlapUser,
      model: 'deepseek-v4-flash',
      theme: 'dark',
    })
    assert.equal(preferences.rows.find((row) => row.user_id === untouchedUser)?.model, 'glm-5.3')

    const sessions = await query<{ id: string; model_id: string | null }>(
      'SELECT id,model_id FROM client_sessions ORDER BY id',
    )
    assert.equal(sessions.rows.find((row) => row.id === 'live-pro')?.model_id, 'deepseek-v4-flash')
    assert.equal(sessions.rows.find((row) => row.id === 'deleted-pro')?.model_id, 'deepseek-v4-pro')
    assert.equal(sessions.rows.find((row) => row.id === 'live-other')?.model_id, 'glm-5.3')

    assert.deepEqual(await grantModels(movedUser), ['deepseek-v4-pro'])
    assert.deepEqual(await grantModels(overlapUser), ['deepseek-v4-flash', 'deepseek-v4-pro'])

    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])

    const snapshotsBefore = await query<{ kind: string; n: string }>(
      `SELECT subject_kind AS kind,count(*)::text AS n
         FROM model_dsv4pro_transition_snapshots
        GROUP BY subject_kind ORDER BY subject_kind`,
    )
    assert.deepEqual(snapshotsBefore.rows, [
      { kind: 'client_sessions', n: '1' },
      { kind: 'runtime_requirement', n: '1' },
      { kind: 'user_preferences', n: '2' },
    ])
    const seedSource = await query<{ original_model_id: string }>(
      `SELECT original_model_id FROM model_dsv4pro_transition_snapshots
        WHERE subject_kind='runtime_requirement' AND subject_key='official_seed_agent'`,
    )
    assert.equal(seedSource.rows[0]?.original_model_id, 'deepseek-v4-pro')

    const catalog = await query<{
      model_id: string
      state: string
      enabled: boolean
      keys: string[]
    }>(
      `SELECT c.model_id,c.state,p.enabled,
              (SELECT array_agg(key ORDER BY key)
                 FROM jsonb_object_keys(c.capability_profile) AS key) AS keys
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('deepseek-v4-pro','deepseek-v4-flash')
          AND c.state='active'
        ORDER BY c.model_id`,
    )
    assert.equal(catalog.rows.length, 2)
    assert.ok(catalog.rows.every((row) => row.enabled))
    assert.ok(
      catalog.rows.every((row) => row.keys.includes('supports_vision') && row.keys.includes('ccb')),
      'capability_profile must stay snake_case',
    )

    await query(sql)
    const snapshotsAfter = await query<{ kind: string; n: string }>(
      `SELECT subject_kind AS kind,count(*)::text AS n
         FROM model_dsv4pro_transition_snapshots
        GROUP BY subject_kind ORDER BY subject_kind`,
    )
    assert.deepEqual(
      snapshotsAfter.rows,
      snapshotsBefore.rows,
      'rerun must not duplicate before-images',
    )
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])
    assert.deepEqual(await grantModels(movedUser), ['deepseek-v4-pro'])
  })

  test('temporary security-definer fences normalize prefs/sessions but leave grants on Pro', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const userId = await createUser('dsv4pro-fence@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"default_model":"glm-5.3"}'::jsonb)`,
      [userId],
    )
    await insertSession({ id: 'fence-session', userId, model: 'glm-5.3' })
    await query(sql)

    await query(
      `DO $role$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oc_migration0219_app') THEN
           CREATE ROLE oc_migration0219_app NOLOGIN;
         END IF;
       END
       $role$;
       GRANT USAGE ON SCHEMA public TO oc_migration0219_app;
       GRANT SELECT,INSERT,UPDATE ON user_preferences,client_sessions,model_visibility_grants
         TO oc_migration0219_app;
       GRANT SELECT ON model_catalog TO oc_migration0219_app;
       REVOKE ALL ON model_dsv4pro_transition_snapshots FROM oc_migration0219_app;`,
    )
    await query(
      `BEGIN;
       SET LOCAL ROLE oc_migration0219_app;
       UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','"deepseek-v4-pro"'::jsonb,true),
              updated_at=clock_timestamp()
        WHERE user_id=${Number(userId)};
       UPDATE client_sessions
          SET model_id='deepseek-v4-pro',updated_at=updated_at+1
        WHERE id='fence-session';
       INSERT INTO model_visibility_grants(user_id,model_id)
       VALUES (${Number(userId)},'deepseek-v4-pro');
       COMMIT;`,
    )

    const preference = await query<{ model: string }>(
      `SELECT prefs->>'default_model' AS model FROM user_preferences WHERE user_id=$1`,
      [userId],
    )
    const session = await query<{ model_id: string }>(
      `SELECT model_id FROM client_sessions WHERE id='fence-session'`,
    )
    assert.equal(preference.rows[0]?.model, 'deepseek-v4-flash')
    assert.equal(session.rows[0]?.model_id, 'deepseek-v4-flash')
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-pro'])

    const objects = await query<{ name: string; owner: string; security_definer: boolean }>(
      `SELECT p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS security_definer
         FROM pg_proc p
        WHERE p.proname IN (
          'fn_0219_normalize_user_default_model',
          'fn_0219_normalize_client_session_model',
          'fn_0219_normalize_visibility_grant'
        )
        ORDER BY p.proname`,
    )
    assert.deepEqual(
      objects.rows.map((row) => row.name),
      ['fn_0219_normalize_client_session_model', 'fn_0219_normalize_user_default_model'],
    )
    assert.ok(objects.rows.every((row) => row.security_definer))
    assert.equal(new Set(objects.rows.map((row) => row.owner)).size, 1)

    const snapshotOwner = await query<{ owner: string }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
        WHERE c.oid='model_dsv4pro_transition_snapshots'::regclass`,
    )
    assert.equal(snapshotOwner.rows[0]?.owner, objects.rows[0]?.owner)
    assert.notEqual(snapshotOwner.rows[0]?.owner, 'oc_migration0219_app')
  })

  test('addGrant/removeGrant keep the Pro contract after 0219', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const adminId = await createUser('dsv4pro-grant-admin@test.invalid', 'admin')
    const userId = await createUser('dsv4pro-grant-user@test.invalid')
    await query(
      `INSERT INTO model_visibility_grants(user_id,model_id) VALUES ($1,'deepseek-v4-pro')`,
      [userId],
    )
    await query(sql)
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-pro'])

    const first = await addGrant(userId, 'deepseek-v4-pro', { adminId })
    assert.equal(first.inserted, false)
    assert.equal(first.row.model_id, 'deepseek-v4-pro')
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-pro'])

    const removed = await removeGrant(userId, 'deepseek-v4-pro', { adminId })
    assert.equal(removed.deleted, true)
    assert.deepEqual(await grantModels(userId), [])

    const missing = await removeGrant(userId, 'deepseek-v4-pro', { adminId })
    assert.equal(missing.deleted, false)

    const inserted = await addGrant(userId, 'deepseek-v4-pro', { adminId })
    assert.equal(inserted.inserted, true)
    assert.equal(inserted.row.model_id, 'deepseek-v4-pro')
    assert.equal(inserted.row.user_id, userId)
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-pro'])

    const flash = await addGrant(userId, 'deepseek-v4-flash', { adminId })
    assert.equal(flash.inserted, true)
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-flash', 'deepseek-v4-pro'])
    const removedPro = await removeGrant(userId, 'deepseek-v4-pro', { adminId })
    assert.equal(removedPro.deleted, true)
    assert.deepEqual(await grantModels(userId), ['deepseek-v4-flash'])
  })

  test('fails atomically when deepseek-v4-flash is not active', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query(
      `DELETE FROM model_runtime_requirements
        WHERE model_id='deepseek-v4-flash'`,
    )
    const target = await query<{ entry_id: string; lock_version: number }>(
      `SELECT entry_id::text,lock_version FROM model_catalog
        WHERE model_id='deepseek-v4-flash' AND state='active'`,
    )
    assert.equal(target.rows.length, 1)
    await query('SELECT fn_model_disable_entry($1::bigint,$2,NULL)', [
      target.rows[0]!.entry_id,
      target.rows[0]!.lock_version,
    ])

    const userId = await createUser('dsv4pro-inactive@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"default_model":"deepseek-v4-pro"}'::jsonb)`,
      [userId],
    )
    await assert.rejects(query(sql), /requires exactly one active deepseek-v4-flash catalog row/)

    const state = await query<{ model: string }>(
      `SELECT prefs->>'default_model' AS model FROM user_preferences WHERE user_id=$1`,
      [userId],
    )
    assert.equal(state.rows[0]?.model, 'deepseek-v4-pro')
    const snapshot = await query<{ exists: boolean }>(
      `SELECT to_regclass('model_dsv4pro_transition_snapshots') IS NOT NULL AS exists`,
    )
    assert.equal(snapshot.rows[0]?.exists, false)
    assert.deepEqual(await requirementPairs(), ['deepseek-v4-pro:official_seed_agent'])
  })

  test('tested compensation restores unchanged prefs/sessions and the snapshotted seed source', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const rollbackSql = testedManualRollbackSql(sql)
    const unchangedUser = await createUser('dsv4pro-rollback-unchanged@test.invalid')
    const changedUser = await createUser('dsv4pro-rollback-changed@test.invalid')
    const sequentialUser = await createUser('dsv4pro-rollback-sequential@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs) VALUES
       ($1,'{"default_model":"deepseek-v4-pro"}'::jsonb),
       ($2,'{"default_model":"deepseek-v4-pro"}'::jsonb),
       ($3,'{"default_model":"deepseek-v4-pro"}'::jsonb)`,
      [unchangedUser, changedUser, sequentialUser],
    )
    await insertSession({ id: 'rollback-unchanged', userId: unchangedUser, model: 'deepseek-v4-pro' })
    await insertSession({ id: 'rollback-changed', userId: changedUser, model: 'deepseek-v4-pro' })
    await insertSession({
      id: 'rollback-sequential',
      userId: sequentialUser,
      model: 'deepseek-v4-pro',
    })
    await query(
      `INSERT INTO model_visibility_grants(user_id,model_id) VALUES
       ($1,'deepseek-v4-pro'),
       ($2,'deepseek-v4-pro')`,
      [unchangedUser, changedUser],
    )
    await query(sql)

    await query(
      `UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','"deepseek-v4-flash"'::jsonb,true),
              updated_at=updated_at+interval '1 second'
        WHERE user_id=$1`,
      [changedUser],
    )
    await query(
      `UPDATE client_sessions
          SET model_id='deepseek-v4-flash',updated_at=updated_at+10000
        WHERE id='rollback-changed'`,
    )

    await query(
      `UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','"deepseek-v4-pro"'::jsonb,true)
        WHERE user_id=$1`,
      [sequentialUser],
    )
    await query(
      `UPDATE client_sessions
          SET model_id='deepseek-v4-pro'
        WHERE id='rollback-sequential'`,
    )

    await query(rollbackSql)

    const preferences = await query<{ user_id: string; model: string }>(
      `SELECT user_id::text,prefs->>'default_model' AS model
         FROM user_preferences
        WHERE user_id=ANY($1::bigint[])
        ORDER BY user_id`,
      [[unchangedUser, changedUser, sequentialUser]],
    )
    assert.equal(
      preferences.rows.find((row) => row.user_id === unchangedUser)?.model,
      'deepseek-v4-pro',
    )
    assert.equal(
      preferences.rows.find((row) => row.user_id === changedUser)?.model,
      'deepseek-v4-flash',
    )
    assert.equal(
      preferences.rows.find((row) => row.user_id === sequentialUser)?.model,
      'deepseek-v4-pro',
    )

    const sessions = await query<{ id: string; model_id: string }>(
      `SELECT id,model_id FROM client_sessions
        WHERE id IN ('rollback-unchanged','rollback-changed','rollback-sequential') ORDER BY id`,
    )
    assert.equal(
      sessions.rows.find((row) => row.id === 'rollback-unchanged')?.model_id,
      'deepseek-v4-pro',
    )
    assert.equal(
      sessions.rows.find((row) => row.id === 'rollback-changed')?.model_id,
      'deepseek-v4-flash',
    )
    assert.equal(
      sessions.rows.find((row) => row.id === 'rollback-sequential')?.model_id,
      'deepseek-v4-pro',
    )

    assert.deepEqual(await grantModels(unchangedUser), ['deepseek-v4-pro'])
    assert.deepEqual(await grantModels(changedUser), ['deepseek-v4-pro'])

    const triggers = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger
        WHERE tgname IN (
          'trg_0219_normalize_user_default_model',
          'trg_0219_normalize_client_session_model',
          'trg_0219_normalize_visibility_grant'
        ) AND NOT tgisinternal`,
    )
    assert.equal(triggers.rows[0]?.n, '0')
    const snapshots = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM model_dsv4pro_transition_snapshots',
    )
    assert.equal(snapshots.rows[0]?.n, '7', 'permanent compensation evidence must remain')
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-pro:official_seed_agent',
    ])
  })

  test('compensation restores official_seed_agent to Flash when that was the pre-0219 source', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const rollbackSql = testedManualRollbackSql(sql)
    await query(
      `DELETE FROM model_runtime_requirements
        WHERE model_id='deepseek-v4-pro' AND requirement='official_seed_agent'`,
    )
    await query(
      `INSERT INTO model_runtime_requirements(model_id,requirement)
       VALUES ('deepseek-v4-flash','official_seed_agent')
       ON CONFLICT (model_id,requirement) DO NOTHING`,
    )
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])
    await query(sql)
    const source = await query<{ original_model_id: string }>(
      `SELECT original_model_id FROM model_dsv4pro_transition_snapshots
        WHERE subject_kind='runtime_requirement' AND subject_key='official_seed_agent'`,
    )
    assert.equal(source.rows[0]?.original_model_id, 'deepseek-v4-flash')
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])
    await query(rollbackSql)
    assert.deepEqual(await requirementPairs(), [
      'deepseek-v4-flash:ccb_secondary_utility',
      'deepseek-v4-flash:official_seed_agent',
    ])
  })
})
