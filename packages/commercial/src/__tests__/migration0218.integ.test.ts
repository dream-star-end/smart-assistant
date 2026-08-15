/**
 * 0218 public activation for Z.AI Coding Plan GLM-5.3.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0218.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCatalogSnapshot } from '../billing/modelCatalog.js'
import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0218_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0218_public_zai_glm53.sql')
const modelId = 'glm-5.3-zai'

function testedManualRollbackSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL ROLLBACK 0218'
  const end = '-- END TESTED MANUAL ROLLBACK 0218'
  assert.ok(migrationSql.includes(start) && migrationSql.includes(end))
  return migrationSql
    .slice(migrationSql.indexOf(start) + start.length, migrationSql.indexOf(end))
    .split('\n')
    .map((line) => line.replace(/^-- ?/, ''))
    .join('\n')
}

async function prepareFloor(): Promise<string> {
  await resetAndMigrateBefore('0218')
  return readFile(migrationPath, 'utf8')
}

async function targetProjection(): Promise<unknown> {
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
                     FROM client_sessions s WHERE s.deleted_at IS NULL AND s.model_id=$1),
       'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                  FROM admin_audit a
                 WHERE a.target LIKE '%glm-5.3-zai%'
                    OR a.target=(SELECT 'model_catalog:'||entry_id::text
                                   FROM model_catalog WHERE model_id=$1))
     ) AS state`,
    [modelId],
  )
  return result.rows[0]?.state
}

async function frozenProjection(): Promise<{ catalog: unknown; pricing: unknown }> {
  const result = await query<{ catalog: unknown; pricing: unknown }>(
    `SELECT
       (SELECT to_jsonb(c)-ARRAY['state','lock_version','updated_at']
          FROM model_catalog c WHERE c.model_id=$1) AS catalog,
       (SELECT to_jsonb(p)-ARRAY['enabled','visibility','lock_version','updated_at']
          FROM model_pricing p WHERE p.model_id=$1) AS pricing`,
    [modelId],
  )
  return result.rows[0]!
}

async function installAuditPrincipals(): Promise<string> {
  await query(
    `INSERT INTO users(id,email,email_verified,password_hash,role,credits,status)
     VALUES
       (1,'release-admin@example.test',TRUE,'x','admin',0,'active')
     ON CONFLICT(id) DO NOTHING`,
  )
  await query(
    `SELECT setval(
       pg_get_serial_sequence('users','id'),
       GREATEST((SELECT max(id) FROM users),1),
       TRUE
     )`,
  )
  const canary = await query<{ id: string }>(
    `INSERT INTO users(email,email_verified,password_hash,role,credits,status)
     VALUES ('v5-canary@claudeai.chat',TRUE,'x','user',1000,'active')
     RETURNING id::text`,
  )
  return canary.rows[0]!.id
}

async function createExactVerifiedCycle(
  omitGrantRemoveAudit = false,
  reorderGrantAudits = false,
  interleaveUnrelatedAudit = false,
): Promise<void> {
  const canaryId = await installAuditPrincipals()
  const target = await query<{ entry_id: string; lock_version: number }>(
    `SELECT entry_id::text,lock_version FROM model_catalog
      WHERE model_id=$1 AND state='disabled'`,
    [modelId],
  )
  const entryId = target.rows[0]!.entry_id
  assert.equal(target.rows[0]!.lock_version, 2)

  await query('SELECT fn_model_activate_entry($1::bigint,2,1)', [entryId])
  await query(
    `INSERT INTO admin_audit(admin_id,action,target,before,after)
     VALUES (1,'model_catalog.activate',$1,$2::jsonb,$3::jsonb)`,
    [
      `model_catalog:${entryId}`,
      JSON.stringify({ state: 'disabled', lock_version: 2 }),
      JSON.stringify({ state: 'active', model_id: modelId }),
    ],
  )
  if (interleaveUnrelatedAudit) {
    await query(
      `INSERT INTO admin_audit(admin_id,action,target,before,after)
       VALUES (1,'system.test','system:unrelated',NULL,NULL)`,
    )
  }
  await query(
    `INSERT INTO model_visibility_grants(user_id,model_id,granted_by)
     VALUES ($1::bigint,$2,1)`,
    [canaryId, modelId],
  )
  const addGrantAudit = () =>
    query(
      `INSERT INTO admin_audit(admin_id,action,target,before,after)
       VALUES (1,'model_grant.add',$1,NULL,$2::jsonb)`,
      [
        `user:${canaryId}/model:${modelId}`,
        JSON.stringify({ user_id: canaryId, model_id: modelId, granted_by: '1' }),
      ],
    )
  if (!reorderGrantAudits) await addGrantAudit()
  await query('DELETE FROM model_visibility_grants WHERE user_id=$1::bigint AND model_id=$2', [
    canaryId,
    modelId,
  ])
  if (!omitGrantRemoveAudit) {
    await query(
      `INSERT INTO admin_audit(admin_id,action,target,before,after)
       VALUES (1,'model_grant.remove',$1,$2::jsonb,NULL)`,
      [
        `user:${canaryId}/model:${modelId}`,
        JSON.stringify({
          user_id: canaryId,
          model_id: modelId,
          granted_at: {},
          granted_by: '1',
        }),
      ],
    )
  }
  if (reorderGrantAudits) await addGrantAudit()
  await query('SELECT fn_model_disable_entry($1::bigint,3,1)', [entryId])
  await query(
    `INSERT INTO admin_audit(admin_id,action,target,before,after)
     VALUES (1,'model_catalog.disable',$1,$2::jsonb,$3::jsonb)`,
    [
      `model_catalog:${entryId}`,
      JSON.stringify({ state: 'active', lock_version: 3 }),
      JSON.stringify({ state: 'disabled', model_id: modelId }),
    ],
  )
}

async function assertPublic(
  expectedCatalogLock: number,
  expectedUpdatedBy: string | null,
): Promise<void> {
  const state = await query<{
    state: string
    catalog_lock: number
    updated_by: string | null
    enabled: boolean
    visibility: string
    pricing_lock: number
  }>(
    `SELECT c.state,c.lock_version AS catalog_lock,c.updated_by::text,
            p.enabled,p.visibility,p.lock_version AS pricing_lock
       FROM model_catalog c JOIN model_pricing p USING(model_id)
      WHERE c.model_id=$1`,
    [modelId],
  )
  assert.deepEqual(state.rows, [
    {
      state: 'active',
      catalog_lock: expectedCatalogLock,
      updated_by: expectedUpdatedBy,
      enabled: true,
      visibility: 'public',
      pricing_lock: 1,
    },
  ])
  const snapshot = await loadCatalogSnapshot()
  assert.equal(snapshot.resolve(modelId)?.providerId, 'zai')
  assert.equal(
    snapshot
      .listForUser({ uid: 991, role: 'user', grantedModelIds: new Set() })
      .some((row) => row.modelId === modelId),
    true,
  )
}

async function recordMigrationLedger(): Promise<void> {
  await query(
    `INSERT INTO schema_migrations(version,applied_at)
     VALUES ('0218_public_zai_glm53',now()) ON CONFLICT DO NOTHING`,
  )
}

describe('0218_public_zai_glm53', () => {
  test('publishes the untouched 0217 floor without changing frozen descriptor or price columns', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const before = await frozenProjection()

    await query(sql)

    assert.deepEqual(await frozenProjection(), before)
    await assertPublic(3, null)
  })

  test('accepts only the exact audited production verification lineage', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await createExactVerifiedCycle()
    const before = await frozenProjection()

    await query(sql)

    assert.deepEqual(await frozenProjection(), before)
    await assertPublic(5, '1')

    await prepareFloor()
    await createExactVerifiedCycle(false, false, true)
    await query(sql)
    await assertPublic(5, '1')
  })

  test('rejects missing or reordered verification audit atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await createExactVerifiedCycle(true)
    const before = await targetProjection()

    await assert.rejects(query(sql), /exactly four target audit rows/)

    assert.deepEqual(await targetProjection(), before)

    await prepareFloor()
    await createExactVerifiedCycle(false, true)
    const reordered = await targetProjection()

    await assert.rejects(query(sql), /audit sequence mismatch/)

    assert.deepEqual(await targetProjection(), reordered)
  })

  test('rejects pricing or authority-binding drift before publication', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query('UPDATE model_pricing SET input_per_mtok=input_per_mtok+1 WHERE model_id=$1', [
      modelId,
    ])
    const pricingDrift = await targetProjection()
    await assert.rejects(query(sql), /exact hidden 0217 pricing floor/)
    assert.deepEqual(await targetProjection(), pricingDrift)

    await prepareFloor()
    const canaryId = await installAuditPrincipals()
    await query(
      'INSERT INTO model_visibility_grants(user_id,model_id,granted_by) VALUES ($1::bigint,$2,1)',
      [canaryId, modelId],
    )
    const bindingDrift = await targetProjection()
    await assert.rejects(query(sql), /refuses target authority bindings/)
    assert.deepEqual(await targetProjection(), bindingDrift)
  })

  test('tested rollback restores hidden state for both accepted lineages and keeps the ledger', async (t) => {
    if (db.skipIfUnavailable(t)) return
    for (const verified of [false, true]) {
      const sql = await prepareFloor()
      const rollback = testedManualRollbackSql(sql)
      if (verified) await createExactVerifiedCycle()
      const floor = await frozenProjection()
      await query(sql)
      await recordMigrationLedger()

      await query(rollback)

      assert.deepEqual(await frozenProjection(), floor)
      const state = await query<{
        state: string
        catalog_lock: number
        enabled: boolean
        visibility: string
        pricing_lock: number
        ledger: boolean
      }>(
        `SELECT c.state,c.lock_version AS catalog_lock,p.enabled,p.visibility,
                p.lock_version AS pricing_lock,
                EXISTS(SELECT 1 FROM schema_migrations
                        WHERE version='0218_public_zai_glm53') AS ledger
           FROM model_catalog c JOIN model_pricing p USING(model_id)
          WHERE c.model_id=$1`,
        [modelId],
      )
      assert.deepEqual(state.rows, [
        {
          state: 'disabled',
          catalog_lock: verified ? 6 : 4,
          enabled: false,
          visibility: 'hidden',
          pricing_lock: 2,
          ledger: true,
        },
      ])
      const once = await targetProjection()
      await assert.rejects(query(rollback), /exact public catalog post-state/)
      assert.deepEqual(await targetProjection(), once)
    }
  })

  test('rollback refuses alias and runtime-requirement drift atomically', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const rollback = testedManualRollbackSql(sql)
    await query(sql)
    await recordMigrationLedger()
    const entry = await query<{ entry_id: string }>(
      'SELECT entry_id::text FROM model_catalog WHERE model_id=$1',
      [modelId],
    )
    await query(
      "INSERT INTO model_aliases(alias,entry_id) VALUES ('zai-public-alias',$1::bigint)",
      [entry.rows[0]!.entry_id],
    )
    await query(
      "INSERT INTO model_runtime_requirements(model_id,requirement) VALUES ($1,'test-drift')",
      [modelId],
    )
    const before = await targetProjection()

    await assert.rejects(query(rollback), /refuses target authority-binding drift/)

    assert.deepEqual(await targetProjection(), before)
  })
})
