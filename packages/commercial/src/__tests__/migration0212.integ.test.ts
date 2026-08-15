/**
 * 0212 public activation for GLM-5.3 and OpenCode Go DeepSeek V4 Flash.
 *
 * Run through the commercial test mutex, never invoke this file directly:
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0212.integ.test.ts'
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { query } from '../db/queries.js'
import { resetAndMigrateBefore, useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('models_0212_test')
const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../db/migrations/0212_public_glm53_opencode_flash.sql')
const modelIds = ['deepseek-v4-flash-opencode-go', 'glm-5.3'] as const

function testedManualRollbackSql(migrationSql: string): string {
  const start = '-- BEGIN TESTED MANUAL ROLLBACK 0212'
  const end = '-- END TESTED MANUAL ROLLBACK 0212'
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
  await resetAndMigrateBefore('0212')
  return readFile(migrationPath, 'utf8')
}

async function pricingProjection(): Promise<unknown[]> {
  const result = await query<{ projection: unknown }>(
    `SELECT jsonb_build_object(
              'model_id', p.model_id,
              'frozen', to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at'],
              'enabled', p.enabled,
              'visibility', p.visibility,
              'lock_version', p.lock_version
            ) AS projection
       FROM model_pricing p
      WHERE p.model_id = ANY($1::text[])
      ORDER BY p.model_id`,
    [modelIds],
  )
  return result.rows.map((row) => row.projection)
}

async function catalogProjection(): Promise<unknown[]> {
  const result = await query<{ projection: unknown }>(
    `SELECT jsonb_build_object(
              'model_id', c.model_id,
              'frozen', to_jsonb(c) - ARRAY['state','lock_version','updated_at'],
              'state', c.state,
              'lock_version', c.lock_version
            ) AS projection
       FROM model_catalog c
      WHERE c.model_id = ANY($1::text[])
      ORDER BY c.model_id, c.entry_id`,
    [modelIds],
  )
  return result.rows.map((row) => row.projection)
}

async function fullTargetState(): Promise<unknown> {
  const result = await query<{ state: unknown }>(
    `SELECT jsonb_build_object(
              'catalog', (
                SELECT jsonb_agg(to_jsonb(c) ORDER BY c.model_id, c.entry_id)
                  FROM model_catalog c
                 WHERE c.model_id = ANY($1::text[])
              ),
              'pricing', (
                SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id)
                  FROM model_pricing p
                 WHERE p.model_id = ANY($1::text[])
              ),
              'grants', (
                SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id, g.model_id)
                  FROM model_visibility_grants g
                 WHERE g.model_id = ANY($1::text[])
              )
            ) AS state`,
    [modelIds],
  )
  return result.rows[0]?.state
}

function frozen(rows: unknown[]): unknown[] {
  return rows.map((row) => (row as { frozen: unknown }).frozen)
}

describe('0212_public_glm53_opencode_flash', () => {
  test('activates both exact descriptors publicly without changing frozen catalog or pricing columns', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const pricingBefore = await pricingProjection()
    const catalogBefore = await catalogProjection()

    await query(sql)

    const pricingAfter = await pricingProjection()
    const catalogAfter = await catalogProjection()
    assert.deepEqual(frozen(pricingAfter), frozen(pricingBefore))
    assert.deepEqual(frozen(catalogAfter), frozen(catalogBefore))
    assert.deepEqual(
      pricingAfter.map((row) => {
        const value = row as { model_id: string; enabled: boolean; visibility: string }
        return { model_id: value.model_id, enabled: value.enabled, visibility: value.visibility }
      }),
      [
        { model_id: 'deepseek-v4-flash-opencode-go', enabled: true, visibility: 'public' },
        { model_id: 'glm-5.3', enabled: true, visibility: 'public' },
      ],
    )
    assert.deepEqual(
      catalogAfter.map((row) => {
        const value = row as { model_id: string; state: string }
        return { model_id: value.model_id, state: value.state }
      }),
      [
        { model_id: 'deepseek-v4-flash-opencode-go', state: 'active' },
        { model_id: 'glm-5.3', state: 'active' },
      ],
    )

    const grants = await query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM model_visibility_grants
        WHERE model_id = ANY($1::text[])`,
      [modelIds],
    )
    assert.equal(grants.rows[0]?.count, '0')
  })

  test('accepts production-like lock-version drift from a completed hidden verification cycle', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const initial = await query<{ entry_id: string; model_id: string; lock_version: number }>(
      `SELECT entry_id::text, model_id, lock_version
         FROM model_catalog
        WHERE model_id = ANY($1::text[]) AND state = 'disabled'
        ORDER BY model_id`,
      [modelIds],
    )
    assert.equal(initial.rows.length, 2)

    for (const row of initial.rows) {
      await query('SELECT fn_model_activate_entry($1::bigint,$2,1)', [row.entry_id, row.lock_version])
      const active = await query<{ lock_version: number }>(
        'SELECT lock_version FROM model_catalog WHERE entry_id=$1::bigint',
        [row.entry_id],
      )
      await query('SELECT fn_model_disable_entry($1::bigint,$2,1)', [
        row.entry_id,
        active.rows[0]?.lock_version,
      ])
    }

    const drifted = await query<{ entry_id: string; lock_version: number; updated_by: string }>(
      `SELECT entry_id::text, lock_version, updated_by::text
         FROM model_catalog
        WHERE model_id = ANY($1::text[]) AND state = 'disabled'
        ORDER BY model_id`,
      [modelIds],
    )
    assert.equal(drifted.rows.length, 2)
    assert.deepEqual(drifted.rows.map((row) => row.lock_version), [4, 4])
    assert.deepEqual(drifted.rows.map((row) => row.updated_by), ['1', '1'])

    await query(sql)

    const active = await query<{ entry_id: string; state: string; lock_version: number }>(
      `SELECT entry_id::text, state, lock_version
         FROM model_catalog
        WHERE model_id = ANY($1::text[])
        ORDER BY model_id`,
      [modelIds],
    )
    assert.deepEqual(active.rows.map((row) => row.entry_id), drifted.rows.map((row) => row.entry_id))
    assert.ok(active.rows.every((row, index) =>
      row.state === 'active' && row.lock_version === drifted.rows[index]!.lock_version + 1,
    ))
  })

  test('fails loud before mutation when either frozen pricing row drifted', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    await query(
      `UPDATE model_pricing
          SET input_per_mtok=input_per_mtok+1,
              updated_at=now()
        WHERE model_id='glm-5.3'`,
    )
    const before = await fullTargetState()

    await assert.rejects(query(sql), /requires the exact hidden pricing floor/)

    assert.deepEqual(await fullTargetState(), before, 'rejected migration must be atomic')
  })

  test('tested compensation restores the hidden floor, keeps the ledger, and rejects a rerun', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const sql = await prepareFloor()
    const rollbackSql = testedManualRollbackSql(sql)
    const pricingFloor = await pricingProjection()
    const catalogFloor = await catalogProjection()

    await query(sql)
    await query(
      `INSERT INTO schema_migrations(version,applied_at)
       VALUES ('0212_public_glm53_opencode_flash',now())
       ON CONFLICT DO NOTHING`,
    )

    await query(
      `UPDATE model_pricing
          SET input_per_mtok=input_per_mtok+1
        WHERE model_id='deepseek-v4-flash-opencode-go'`,
    )
    const driftedPostState = await fullTargetState()
    await assert.rejects(query(rollbackSql), /requires the exact public pricing post-state/)
    assert.deepEqual(await fullTargetState(), driftedPostState)
    await query(
      `UPDATE model_pricing
          SET input_per_mtok=input_per_mtok-1
        WHERE model_id='deepseek-v4-flash-opencode-go'`,
    )

    await query(rollbackSql)

    const pricingAfter = await pricingProjection()
    const catalogAfter = await catalogProjection()
    assert.deepEqual(frozen(pricingAfter), frozen(pricingFloor))
    assert.deepEqual(frozen(catalogAfter), frozen(catalogFloor))
    assert.deepEqual(
      pricingAfter.map((row) => {
        const value = row as { enabled: boolean; visibility: string }
        return { enabled: value.enabled, visibility: value.visibility }
      }),
      [
        { enabled: false, visibility: 'hidden' },
        { enabled: false, visibility: 'hidden' },
      ],
    )
    assert.ok(catalogAfter.every((row) => (row as { state: string }).state === 'disabled'))

    const ledger = await query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM schema_migrations WHERE version='0212_public_glm53_opencode_flash'
       ) AS present`,
    )
    assert.equal(ledger.rows[0]?.present, true)

    const beforeRejectedRerun = await fullTargetState()
    await assert.rejects(query(rollbackSql), /0212 rollback requires the exact active catalog post-state/)
    assert.deepEqual(await fullTargetState(), beforeRejectedRerun)
  })
})
