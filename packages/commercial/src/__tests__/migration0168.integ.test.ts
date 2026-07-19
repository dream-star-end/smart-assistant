import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import type { Pool } from 'pg'

import type { PluginRuntimeFacade } from '../plugins/runtime.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

process.env.DATABASE_URL = TEST_DB_URL
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0'
process.env.JWT_SECRET ??= 'z'.repeat(64)
process.env.OC_MODEL_AUTHORITY = '1'

const { closePool, createPool, resetPool, setPoolOverride } = await import('../db/index.js')
const { runMigrations } = await import('../db/migrate.js')
const { query } = await import('../db/queries.js')
const { resetTestSchemaForTest } = await import('./helpers/db.js')

let pgAvailable = false
let pool: Pool

before(async () => {
  const probe = createPool({
    connectionString: TEST_DB_URL,
    max: 1,
    connectionTimeoutMillis: 1_500,
  })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return
  await resetPool()
  pool = createPool({ connectionString: TEST_DB_URL, max: 4 })
  setPoolOverride(pool)
  await resetTestSchemaForTest()
  await runMigrations()
})

after(async () => {
  if (!pgAvailable) return
  await closePool()
})

describe('0168 Knowledge Planet automation migration', () => {
  test('installs default-off controls, soft-delete uniqueness and dispatch-claim guards', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')

    const tables = await query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'plugin_automation_controls',
            'plugin_automation_rules',
            'plugin_automation_runs'
          )`,
    )
    assert.deepEqual(
      new Set(tables.rows.map((row) => row.table_name)),
      new Set(['plugin_automation_controls', 'plugin_automation_rules', 'plugin_automation_runs']),
    )

    const controls = await query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'plugin_automation_controls'
          AND column_name = 'enabled'`,
    )
    assert.equal(controls.rows[0]?.column_default, 'false')

    const columns = await query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'plugin_automation_runs'
          AND column_name IN (
            'dispatch_claim_token','dispatch_claim_until','dispatch_owner_token','dispatch_armed_at'
          )`,
    )
    assert.deepEqual(
      new Set(columns.rows.map((row) => row.column_name)),
      new Set([
        'dispatch_claim_token',
        'dispatch_claim_until',
        'dispatch_owner_token',
        'dispatch_armed_at',
      ]),
    )

    const indexes = await query<{ name: string; predicate: string | null }>(
      `SELECT cls.relname AS name, pg_get_expr(idx.indpred, idx.indrelid) AS predicate
         FROM pg_index idx
         JOIN pg_class cls ON cls.oid = idx.indexrelid
        WHERE idx.indrelid = 'plugin_automation_rules'::regclass`,
    )
    assert.deepEqual(
      indexes.rows.find((row) => row.name === 'plugin_automation_rules_active_group')?.predicate,
      '(deleted_at IS NULL)',
    )
    const dispatchIndex = await query<{ predicate: string | null }>(
      `SELECT pg_get_expr(idx.indpred, idx.indrelid) AS predicate
         FROM pg_index idx
         JOIN pg_class cls ON cls.oid = idx.indexrelid
        WHERE cls.relname = 'plugin_automation_runs_one_dispatching_per_account'`,
    )
    assert.match(dispatchIndex.rows[0]?.predicate ?? '', /status.*dispatching/)

    const constraints = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'plugin_automation_runs'::regclass`,
    )
    assert.ok(
      constraints.rows.some(
        (row) =>
          row.definition.includes('dispatch_claim_token IS NULL') &&
          row.definition.includes("'ready'"),
      ),
      'dispatch claims must only exist on ready rows',
    )
    assert.ok(
      constraints.rows.some(
        (row) =>
          row.definition.includes('dispatch_owner_token IS NULL') &&
          row.definition.includes("'dispatching'"),
      ),
      'dispatch ownership must only exist after the irreversible dispatch fence',
    )
  })

  test('persists consent and the full rule create, patch, enable and delete lifecycle', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')

    const [
      { KnowledgePlanetAutomationService, KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION },
      { managedPluginWritePolicy },
    ] = await Promise.all([
      import('../plugins/knowledgePlanetAutomation.js'),
      import('../plugins/writePolicy.js'),
    ])
    const policy = managedPluginWritePolicy('knowledge-planet')!
    const user = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash)
       VALUES ('kp-automation-0168@example.com', 'argon2$stub')
       RETURNING id::text AS id`,
    )
    const connection = await query<{ id: string }>(
      `INSERT INTO connections
         (user_id, provider, display_name, account_key, secret_enc, secret_nonce,
          plugin_write_enabled, plugin_write_disclaimer_version,
          plugin_write_disclaimer_accepted_at)
       VALUES ($1, 'knowledge-planet', 'KP', 'kp-account-key-0168',
               decode(repeat('aa', 16), 'hex'), decode(repeat('bb', 12), 'hex'),
               TRUE, $2, now())
       RETURNING id::text AS id`,
      [user.rows[0]!.id, policy.version],
    )
    const userId = Number(user.rows[0]!.id)
    const targetId = connection.rows[0]!.id
    const groupId = '123456789'
    const fakeRuntime = {
      management: async () => ({
        accounts: [
          {
            id: targetId,
            provider: 'knowledge-planet',
            executable: true,
          },
        ],
      }),
      call: async (input: { actionId: string }) => {
        if (input.actionId === 'get_group') return { group: { id: groupId } }
        if (input.actionId === 'list_groups')
          return {
            groups: [
              { id: groupId, name: '产品星球', memberCount: 120 },
              { id: '323456789', name: '用户星球', memberCount: 80 },
            ],
          }
        if (input.actionId === 'list_topics')
          return { topics: [{ id: '223456789', createdAt: '2026-07-18T00:00:00.000Z' }] }
        throw new Error(`unexpected action ${input.actionId}`)
      },
    } as unknown as PluginRuntimeFacade
    const service = new KnowledgePlanetAutomationService(fakeRuntime, { pool })

    const control = await service.setControl({
      userId,
      targetId,
      enabled: true,
      accepted: true,
      disclaimerVersion: KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION,
      accountDailyLimit: 12,
    })
    assert.equal(control.enabled, true)
    assert.equal(control.accountDailyLimit, 12)

    const created = await service.createRule({
      userId,
      targetId,
      groupId,
      name: '初始规则',
      instructions: '只回复明确提问。',
    })
    const renamed = await service.patchRule({
      userId,
      targetId,
      ruleId: created.id,
      patch: { name: '已重命名规则', dailyLimit: 6 },
    })
    assert.equal(renamed.name, '已重命名规则')
    assert.equal(renamed.dailyLimit, 6)

    const enabled = await service.patchRule({
      userId,
      targetId,
      ruleId: created.id,
      patch: { enabled: true },
    })
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.lastCursorAt, '2026-07-18T00:00:00.000Z')

    const view = await service.get(userId, targetId)
    assert.equal(view.control.enabled, true)
    assert.equal(view.rules.length, 1)
    assert.equal(view.rules[0]?.name, '已重命名规则')

    await service.deleteRule(userId, targetId, created.id)
    assert.equal((await service.get(userId, targetId)).rules.length, 0)

    assert.deepEqual(await service.listGroups(userId, targetId), [
      { id: groupId, name: '产品星球', memberCount: 120 },
      { id: '323456789', name: '用户星球', memberCount: 80 },
    ])
    const batch = await service.createRulesBatch({
      userId,
      targetId,
      groupIds: [groupId, '323456789'],
      name: '批量规则',
      instructions: '只回复明确提问，不确定就跳过。',
      triggerKind: 'new_question',
    })
    assert.equal(batch.length, 2)
    assert.ok(batch.every((rule) => rule.enabled && rule.lastCursorAt !== null))
    const cursors = await query<{ group_id: string; cursor_topic_id: string | null }>(
      `SELECT group_id, cursor_topic_id
         FROM plugin_automation_rules
        WHERE connection_id = $1::bigint AND deleted_at IS NULL
        ORDER BY group_id`,
      [targetId],
    )
    assert.deepEqual(cursors.rows, [
      { group_id: groupId, cursor_topic_id: null },
      { group_id: '323456789', cursor_topic_id: null },
    ])
  })
})
