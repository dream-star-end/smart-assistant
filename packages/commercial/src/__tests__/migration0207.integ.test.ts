/**
 * 0207 Grok Build catalog/account-pool/admin-only database contract.
 *
 * Run: REQUIRE_TEST_DB=1 npx tsx --test packages/commercial/src/__tests__/migration0207.integ.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { query } from '../db/queries.js'
import { useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('grok_0207_test')

describe('0207_grok_build_admin_pool', () => {
  test('stages the exact admin model without exposing it to the rollback runtime', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const result = await query<{
      model_id: string
      engine: string
      provider_id: string
      upstream_model_id: string
      context_window: number
      state: string
      enabled: boolean
      visibility: string
      default_effort: string
      group_provider: string
      group_kind: string
      group_enabled: boolean
    }>(
      `SELECT c.model_id,c.engine,c.provider_id,c.upstream_model_id,c.context_window,c.state,
              p.enabled,p.visibility,p.default_effort,
              g.provider AS group_provider,g.kind AS group_kind,g.enabled AS group_enabled
         FROM model_catalog c
         JOIN model_pricing p USING(model_id)
         JOIN account_group_models gm USING(model_id)
         JOIN account_groups g ON g.id=gm.group_id
        WHERE c.model_id='grok-build' AND c.state='staged'`,
    )
    assert.deepEqual(result.rows, [{
      model_id: 'grok-build',
      engine: 'grok',
      provider_id: 'grok',
      upstream_model_id: 'grok-build',
      context_window: 500_000,
      state: 'staged',
      enabled: false,
      visibility: 'admin',
      default_effort: 'high',
      group_provider: 'grok',
      group_kind: 'official_oauth',
      group_enabled: true,
    }])
  })

  test('database trigger rejects a direct Grok grant to non-admin and permits admin', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const users = await query<{ id: string; role: string }>(
      `INSERT INTO users(email,password_hash,role)
       VALUES ('grok-user@test.invalid','x','user'),('grok-admin@test.invalid','x','admin')
       RETURNING id::text AS id,role`,
    )
    const user = users.rows.find((row) => row.role === 'user')!
    const admin = users.rows.find((row) => row.role === 'admin')!
    await assert.rejects(
      query(`INSERT INTO model_visibility_grants(user_id,model_id) VALUES ($1,'grok-build')`, [user.id]),
      /grok models are admin-only/,
    )
    await query(`INSERT INTO model_visibility_grants(user_id,model_id) VALUES ($1,'grok-build')`, [admin.id])
    const grants = await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM model_visibility_grants WHERE model_id='grok-build'`,
    )
    assert.deepEqual(grants.rows, [{ user_id: admin.id }])
  })

  test('route table binds token to container/user/account/slot/model with active expiry lookup index', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const table = await query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
        WHERE relname IN ('grok_route_contexts','idx_grok_route_contexts_lookup')
        ORDER BY relname`,
    )
    assert.deepEqual(table.rows.map((row) => row.name), [
      'grok_route_contexts',
      'idx_grok_route_contexts_lookup',
    ])
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'grok_route_contexts'
          AND column_name IN ('container_id','user_id','account_id','slot_id','model_id')
        ORDER BY column_name`,
    )
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'account_id',
      'container_id',
      'model_id',
      'slot_id',
      'user_id',
    ])
  })
})
