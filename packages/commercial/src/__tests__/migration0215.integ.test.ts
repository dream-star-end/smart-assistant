/**
 * 0215 DeepSeek V4 Flash provider-neutral canonical cutover.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0215.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCatalogSnapshot } from '../billing/modelCatalog.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0215_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0215_deepseek_flash_opencode_canonical.sql')

function testedManualCompensationSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL COMPENSATION 0215'
  const end = '-- END TESTED MANUAL COMPENSATION 0215'
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
  await resetAndMigrateBefore('0215')
  return readFile(migrationPath, 'utf8')
}

async function createUser(email: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,status)
     VALUES ($1,'x','user','active') RETURNING id::text AS id`,
    [email],
  )
  return result.rows[0]!.id
}

async function insertSession(args: {
  id: string
  userId: string
  model: string
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

async function seedBrandedReferences(): Promise<{ userA: string; userB: string }> {
  const userA = await createUser('flash-cutover-a@test.invalid')
  const userB = await createUser('flash-cutover-b@test.invalid')
  await query(
    `INSERT INTO user_preferences(user_id,prefs)
     VALUES ($1,'{"theme":"dark","default_model":"deepseek-v4-flash-opencode-go"}'::jsonb)`,
    [userA],
  )
  await insertSession({
    id: 'flash-live-alias',
    userId: userA,
    model: 'deepseek-v4-flash-opencode-go',
  })
  await insertSession({
    id: 'flash-deleted-alias',
    userId: userA,
    model: 'deepseek-v4-flash-opencode-go',
    deleted: true,
  })
  await query(
    `INSERT INTO model_visibility_grants(user_id,model_id) VALUES
       ($1,'deepseek-v4-flash-opencode-go'),
       ($2,'deepseek-v4-flash-opencode-go'),
       ($2,'deepseek-v4-flash')`,
    [userA, userB],
  )
  const groups = await query<{ id: string }>(
    `INSERT INTO account_groups(label,kind,provider) VALUES
       ('flash-alias-only','official_oauth','claude'),
       ('flash-both','official_oauth','claude')
     RETURNING id::text AS id`,
  )
  await query(
    `INSERT INTO account_group_models(group_id,model_id) VALUES
       ($1,'deepseek-v4-flash-opencode-go'),
       ($2,'deepseek-v4-flash-opencode-go'),
       ($2,'deepseek-v4-flash')`,
    [groups.rows[0]!.id, groups.rows[1]!.id],
  )
  return { userA, userB }
}

describe('0215_deepseek_flash_opencode_canonical', () => {
  test('switches the canonical execution provider and collapses every live branded reference', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const { userA } = await seedBrandedReferences()

    await query(sql)

    const models = await query<{
      model_id: string
      state: string
      provider_id: string
      upstream_model_id: string | null
      enabled: boolean
      visibility: string
      display_name: string
    }>(
      `SELECT c.model_id,c.state,c.provider_id,c.upstream_model_id,
              p.enabled,p.visibility,p.display_name
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('deepseek-v4-flash','deepseek-v4-flash-opencode-go')
          AND c.state IN ('active','disabled')
        ORDER BY c.model_id`,
    )
    assert.deepEqual(models.rows, [
      {
        model_id: 'deepseek-v4-flash',
        state: 'active',
        provider_id: 'opencodego',
        upstream_model_id: 'deepseek-v4-flash',
        enabled: true,
        visibility: 'public',
        display_name: 'DeepSeek V4 Flash (1M)',
      },
      {
        model_id: 'deepseek-v4-flash-opencode-go',
        state: 'disabled',
        provider_id: 'opencodego',
        upstream_model_id: 'deepseek-v4-flash',
        enabled: false,
        visibility: 'hidden',
        display_name: 'DeepSeek V4 Flash (OpenCode Go)',
      },
    ])

    const snapshot = await loadCatalogSnapshot()
    assert.equal(snapshot.aliasToCanonical('deepseek-v4-flash-opencode-go'), 'deepseek-v4-flash')
    assert.equal(snapshot.resolve('deepseek-v4-flash')?.providerId, 'opencodego')
    assert.equal(snapshot.resolve('deepseek-v4-flash-opencode-go')?.canonicalModel, 'deepseek-v4-flash')

    const prefs = await query<{ model: string; theme: string }>(
      `SELECT prefs->>'default_model' AS model,prefs->>'theme' AS theme
         FROM user_preferences WHERE user_id=$1`,
      [userA],
    )
    assert.deepEqual(prefs.rows[0], { model: 'deepseek-v4-flash', theme: 'dark' })
    const sessions = await query<{ id: string; model_id: string }>(
      `SELECT id,model_id FROM client_sessions
        WHERE id IN ('flash-live-alias','flash-deleted-alias') ORDER BY id`,
    )
    assert.equal(sessions.rows.find((row) => row.id === 'flash-live-alias')?.model_id, 'deepseek-v4-flash')
    assert.equal(
      sessions.rows.find((row) => row.id === 'flash-deleted-alias')?.model_id,
      'deepseek-v4-flash-opencode-go',
      'deleted history remains immutable and resolves through the compatibility alias',
    )

    for (const table of ['model_visibility_grants', 'account_group_models'] as const) {
      const counts = await query<{ direct: string; branded: string }>(
        `SELECT count(*) FILTER (WHERE model_id='deepseek-v4-flash')::text AS direct,
                count(*) FILTER (WHERE model_id='deepseek-v4-flash-opencode-go')::text AS branded
           FROM ${table}`,
      )
      assert.deepEqual(counts.rows[0], { direct: '2', branded: '0' })
    }
    const ledger = await query<{ subjects: string; missing_after: string }>(
      `SELECT count(*)::text AS subjects,
              count(*) FILTER (WHERE after_row IS NULL)::text AS missing_after
         FROM model_flash_opencode_subject_snapshots`,
    )
    assert.deepEqual(ledger.rows[0], { subjects: '6', missing_after: '0' })
  })

  test('tested compensation restores unchanged references and both public semantic entries', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const compensation = testedManualCompensationSql(sql)
    const { userA } = await seedBrandedReferences()
    await query(sql)

    await query(compensation)

    const active = await query<{ model_id: string; provider_id: string; visibility: string }>(
      `SELECT c.model_id,c.provider_id,p.visibility
         FROM model_catalog c JOIN model_pricing p USING(model_id)
        WHERE c.model_id IN ('deepseek-v4-flash','deepseek-v4-flash-opencode-go')
          AND c.state='active' ORDER BY c.model_id`,
    )
    assert.deepEqual(active.rows, [
      { model_id: 'deepseek-v4-flash', provider_id: 'deepseek', visibility: 'public' },
      {
        model_id: 'deepseek-v4-flash-opencode-go',
        provider_id: 'opencodego',
        visibility: 'public',
      },
    ])
    const alias = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_aliases
        WHERE alias='deepseek-v4-flash-opencode-go'`,
    )
    assert.equal(alias.rows[0]?.n, '0')
    const pref = await query<{ model: string }>(
      `SELECT prefs->>'default_model' AS model FROM user_preferences WHERE user_id=$1`,
      [userA],
    )
    assert.equal(pref.rows[0]?.model, 'deepseek-v4-flash-opencode-go')
    const session = await query<{ model_id: string }>(
      `SELECT model_id FROM client_sessions WHERE id='flash-live-alias'`,
    )
    assert.equal(session.rows[0]?.model_id, 'deepseek-v4-flash-opencode-go')
    const bindings = await query<{ grants: string; groups: string }>(
      `SELECT
         (SELECT count(*)::text FROM model_visibility_grants
           WHERE model_id='deepseek-v4-flash-opencode-go') AS grants,
         (SELECT count(*)::text FROM account_group_models
           WHERE model_id='deepseek-v4-flash-opencode-go') AS groups`,
    )
    assert.deepEqual(bindings.rows[0], { grants: '2', groups: '2' })
    const ledger = await query<{ compensated: boolean }>(
      'SELECT compensated_at IS NOT NULL AS compensated FROM model_flash_opencode_transition',
    )
    assert.equal(ledger.rows[0]?.compensated, true)
  })

  test('fails atomically when the branded execution floor is no longer active', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const branded = await query<{ entry_id: string; lock_version: number }>(
      `SELECT entry_id::text,lock_version FROM model_catalog
        WHERE model_id='deepseek-v4-flash-opencode-go' AND state='active'`,
    )
    await query('SELECT fn_model_disable_entry($1::bigint,$2,NULL)', [
      branded.rows[0]!.entry_id,
      branded.rows[0]!.lock_version,
    ])

    await assert.rejects(query(sql), /query returned no rows|execution descriptor precondition/)
    const ledger = await query<{ exists: boolean }>(
      `SELECT to_regclass('public.model_flash_opencode_transition') IS NOT NULL AS exists`,
    )
    assert.equal(ledger.rows[0]?.exists, false)
    const canonical = await query<{ provider_id: string }>(
      `SELECT provider_id FROM model_catalog
        WHERE model_id='deepseek-v4-flash' AND state='active'`,
    )
    assert.equal(canonical.rows[0]?.provider_id, 'deepseek')
  })
})
