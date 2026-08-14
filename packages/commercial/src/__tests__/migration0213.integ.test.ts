/**
 * 0213 GLM-5.3 default transition and deploy-gap write fence.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0213.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0213_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0213_glm53_default_transition.sql')
const oldModels = ['qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2'] as const

function testedManualRollbackSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL ROLLBACK 0213'
  const end = '-- END TESTED MANUAL ROLLBACK 0213'
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
  await resetAndMigrateBefore('0213')
  return readFile(migrationPath, 'utf8')
}

async function createUser(email: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role)
     VALUES ($1,'x','user')
     RETURNING id::text AS id`,
    [email],
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

describe('0213_glm53_default_transition', () => {
  test('backfills every old preference/live-session reference, preserves deleted history, and is idempotent', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const userIds: string[] = []

    for (let i = 0; i < oldModels.length; i += 1) {
      const userId = await createUser(`glm53-backfill-${i}@test.invalid`)
      userIds.push(userId)
      await query(
        `INSERT INTO user_preferences(user_id,prefs)
         VALUES ($1,jsonb_build_object('theme','dark','default_model',$2::text))`,
        [userId, oldModels[i]],
      )
      await insertSession({ id: `live-${i}`, userId, model: oldModels[i] })
    }

    const untouchedUser = await createUser('glm53-untouched@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"theme":"light","default_model":"deepseek-v4-pro"}'::jsonb)`,
      [untouchedUser],
    )
    await insertSession({
      id: 'deleted-old',
      userId: untouchedUser,
      model: 'glm-5.2',
      deleted: true,
    })
    await insertSession({ id: 'live-other', userId: untouchedUser, model: 'deepseek-v4-pro' })

    await query(sql)

    const preferences = await query<{ user_id: string; model: string; theme: string }>(
      `SELECT user_id::text, prefs->>'default_model' AS model, prefs->>'theme' AS theme
         FROM user_preferences ORDER BY user_id`,
    )
    for (const userId of userIds) {
      const row = preferences.rows.find((value) => value.user_id === userId)
      assert.deepEqual(row, { user_id: userId, model: 'glm-5.3', theme: 'dark' })
    }
    assert.equal(
      preferences.rows.find((value) => value.user_id === untouchedUser)?.model,
      'deepseek-v4-pro',
    )

    const sessions = await query<{ id: string; model_id: string | null }>(
      'SELECT id,model_id FROM client_sessions ORDER BY id',
    )
    assert.ok(
      sessions.rows
        .filter((row) => row.id.startsWith('live-') && row.id !== 'live-other')
        .every((row) => row.model_id === 'glm-5.3'),
    )
    assert.equal(sessions.rows.find((row) => row.id === 'deleted-old')?.model_id, 'glm-5.2')
    assert.equal(sessions.rows.find((row) => row.id === 'live-other')?.model_id, 'deepseek-v4-pro')

    const snapshotsBefore = await query<{ kind: string; n: string }>(
      `SELECT subject_kind AS kind,count(*)::text AS n
         FROM model_default_transition_snapshots
        GROUP BY subject_kind ORDER BY subject_kind`,
    )
    assert.deepEqual(snapshotsBefore.rows, [
      { kind: 'client_sessions', n: '4' },
      { kind: 'user_preferences', n: '4' },
    ])

    await query(sql)
    const snapshotsAfter = await query<{ kind: string; n: string }>(
      `SELECT subject_kind AS kind,count(*)::text AS n
         FROM model_default_transition_snapshots
        GROUP BY subject_kind ORDER BY subject_kind`,
    )
    assert.deepEqual(
      snapshotsAfter.rows,
      snapshotsBefore.rows,
      'rerun must not duplicate before-images',
    )
  })

  test('temporary security-definer fences normalize old-stable writes under an unprivileged app role', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const userId = await createUser('glm53-fence@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"default_model":"deepseek-v4-pro"}'::jsonb)`,
      [userId],
    )
    await insertSession({ id: 'fence-session', userId, model: 'deepseek-v4-pro' })
    await query(sql)

    await query(
      `DO $role$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oc_migration0213_app') THEN
           CREATE ROLE oc_migration0213_app NOLOGIN;
         END IF;
       END
       $role$;
       GRANT USAGE ON SCHEMA public TO oc_migration0213_app;
       GRANT SELECT,UPDATE ON user_preferences,client_sessions TO oc_migration0213_app;
       REVOKE ALL ON model_default_transition_snapshots FROM oc_migration0213_app;`,
    )
    await query(
      `BEGIN;
       SET LOCAL ROLE oc_migration0213_app;
       UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','"glm-5.2"'::jsonb,true),
              updated_at=clock_timestamp()
        WHERE user_id=${Number(userId)};
       UPDATE client_sessions
          SET model_id='qwen3.7-max',updated_at=updated_at+1
        WHERE id='fence-session';
       COMMIT;`,
    )

    const preference = await query<{ model: string }>(
      `SELECT prefs->>'default_model' AS model FROM user_preferences WHERE user_id=$1`,
      [userId],
    )
    const session = await query<{ model_id: string }>(
      `SELECT model_id FROM client_sessions WHERE id='fence-session'`,
    )
    assert.equal(preference.rows[0]?.model, 'glm-5.3')
    assert.equal(session.rows[0]?.model_id, 'glm-5.3')

    const objects = await query<{ name: string; owner: string; security_definer: boolean }>(
      `SELECT p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS security_definer
         FROM pg_proc p
        WHERE p.proname IN (
          'fn_0213_normalize_user_default_model',
          'fn_0213_normalize_client_session_model'
        )
        ORDER BY p.proname`,
    )
    assert.equal(objects.rows.length, 2)
    assert.ok(objects.rows.every((row) => row.security_definer))
    assert.equal(new Set(objects.rows.map((row) => row.owner)).size, 1)

    const snapshotOwner = await query<{ owner: string }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
        WHERE c.oid='model_default_transition_snapshots'::regclass`,
    )
    assert.equal(snapshotOwner.rows[0]?.owner, objects.rows[0]?.owner)
    assert.notEqual(snapshotOwner.rows[0]?.owner, 'oc_migration0213_app')
  })

  test('fails atomically when glm-5.3 is not active', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const target = await query<{ entry_id: string; lock_version: number }>(
      `SELECT entry_id::text,lock_version FROM model_catalog
        WHERE model_id='glm-5.3' AND state='active'`,
    )
    assert.equal(target.rows.length, 1)
    await query('SELECT fn_model_disable_entry($1::bigint,$2,NULL)', [
      target.rows[0]!.entry_id,
      target.rows[0]!.lock_version,
    ])

    const userId = await createUser('glm53-inactive@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs)
       VALUES ($1,'{"default_model":"glm-5.2"}'::jsonb)`,
      [userId],
    )
    await assert.rejects(query(sql), /requires exactly one active glm-5\.3 catalog row/)

    const state = await query<{ model: string }>(
      `SELECT prefs->>'default_model' AS model FROM user_preferences WHERE user_id=$1`,
      [userId],
    )
    assert.equal(state.rows[0]?.model, 'glm-5.2')
    const snapshot = await query<{ exists: boolean }>(
      `SELECT to_regclass('model_default_transition_snapshots') IS NOT NULL AS exists`,
    )
    assert.equal(snapshot.rows[0]?.exists, false)
  })

  test('tested compensation restores only rows unchanged since normalization', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const rollbackSql = testedManualRollbackSql(sql)
    const unchangedUser = await createUser('glm53-rollback-unchanged@test.invalid')
    const changedUser = await createUser('glm53-rollback-changed@test.invalid')
    const sequentialUser = await createUser('glm53-rollback-sequential@test.invalid')
    await query(
      `INSERT INTO user_preferences(user_id,prefs) VALUES
       ($1,'{\"default_model\":\"glm-5.1\"}'::jsonb),
       ($2,'{\"default_model\":\"glm-5.2\"}'::jsonb),
       ($3,'{\"default_model\":\"glm-5.1\"}'::jsonb)`,
      [unchangedUser, changedUser, sequentialUser],
    )
    await insertSession({ id: 'rollback-unchanged', userId: unchangedUser, model: 'qwen3.7-plus' })
    await insertSession({ id: 'rollback-changed', userId: changedUser, model: 'glm-5.2' })
    await insertSession({
      id: 'rollback-sequential',
      userId: sequentialUser,
      model: 'qwen3.7-plus',
    })
    await query(sql)

    // Same target value chosen later must still count as a later user write. The marker
    // differs, so compensation cannot silently resurrect the old preference/session.
    await query(
      `UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','\"glm-5.3\"'::jsonb,true),
              updated_at=updated_at+interval '1 second'
        WHERE user_id=$1`,
      [changedUser],
    )
    await query(
      `UPDATE client_sessions
          SET model_id='glm-5.3',updated_at=updated_at+10000
        WHERE id='rollback-changed'`,
    )

    // A later request for a different fenced legacy model must replace both the
    // before-image and marker. Compensation restores the latest request, never
    // the legacy model captured by the initial backfill.
    await query(
      `UPDATE user_preferences
          SET prefs=jsonb_set(prefs,'{default_model}','\"qwen3.7-max\"'::jsonb,true)
        WHERE user_id=$1`,
      [sequentialUser],
    )
    await query(
      `UPDATE client_sessions
          SET model_id='glm-5.2'
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
    assert.equal(preferences.rows.find((row) => row.user_id === unchangedUser)?.model, 'glm-5.1')
    assert.equal(preferences.rows.find((row) => row.user_id === changedUser)?.model, 'glm-5.3')
    assert.equal(
      preferences.rows.find((row) => row.user_id === sequentialUser)?.model,
      'qwen3.7-max',
    )

    const sessions = await query<{ id: string; model_id: string }>(
      `SELECT id,model_id FROM client_sessions
        WHERE id IN ('rollback-unchanged','rollback-changed','rollback-sequential') ORDER BY id`,
    )
    assert.equal(
      sessions.rows.find((row) => row.id === 'rollback-unchanged')?.model_id,
      'qwen3.7-plus',
    )
    assert.equal(sessions.rows.find((row) => row.id === 'rollback-changed')?.model_id, 'glm-5.3')
    assert.equal(sessions.rows.find((row) => row.id === 'rollback-sequential')?.model_id, 'glm-5.2')

    const triggers = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger
        WHERE tgname IN (
          'trg_0213_normalize_user_default_model',
          'trg_0213_normalize_client_session_model'
        ) AND NOT tgisinternal`,
    )
    assert.equal(triggers.rows[0]?.n, '0')
    const snapshots = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM model_default_transition_snapshots',
    )
    assert.equal(snapshots.rows[0]?.n, '6', 'permanent compensation evidence must remain')
  })
})
