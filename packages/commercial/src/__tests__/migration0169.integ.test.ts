import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { Pool } from 'pg'

import { KMS_KEY_BYTES } from '../crypto/keys.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

process.env.DATABASE_URL = TEST_DB_URL
process.env.OPENCLAUDE_KMS_KEY = randomBytes(KMS_KEY_BYTES).toString('base64')

const { closePool, createPool, resetPool, setPoolOverride } = await import('../db/index.js')
const { runMigrations } = await import('../db/migrate.js')
const { query } = await import('../db/queries.js')
const { getLedgerRow, proposeWrite } = await import('../connectors/ledger.js')
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

describe('0169 Plugin write preapproval migration', () => {
  test('adds default-off account consent and attributed ledger columns', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    const columns = await query<{
      table_name: string
      column_name: string
      column_default: string | null
    }>(
      `SELECT table_name, column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('connections', 'plugin_write_preapproval_enabled'),
            ('connections', 'plugin_write_preapproval_disclaimer_version'),
            ('connections', 'plugin_write_preapproval_accepted_at'),
            ('connector_write_ledger', 'approval_source'),
            ('connector_write_ledger', 'approval_policy_version')
          )`,
    )
    assert.equal(columns.rows.length, 5)
    assert.equal(
      columns.rows.find((row) => row.column_name === 'plugin_write_preapproval_enabled')
        ?.column_default,
      'false',
    )
    assert.match(
      columns.rows.find((row) => row.column_name === 'approval_source')?.column_default ?? '',
      /user_confirmation/,
    )

    const constraints = await query<{ name: string; definition: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname IN (
          'connections_plugin_write_preapproval_consent',
          'connector_write_ledger_approval_source_shape'
        )`,
    )
    assert.equal(constraints.rows.length, 2)
    assert.match(
      constraints.rows.find((row) => row.name === 'connections_plugin_write_preapproval_consent')
        ?.definition ?? '',
      /plugin_write_enabled/,
    )
    assert.match(
      constraints.rows.find(
        (row) => row.name === 'connector_write_ledger_approval_source_shape',
      )?.definition ?? '',
      /account_preapproval/,
    )
  })

  test('fails closed without the master switch and starts preapproved ledger rows as approved', async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    const user = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash)
       VALUES ('plugin-preapproval-0169@example.com', 'argon2$stub')
       RETURNING id::text AS id`,
    )
    const connection = await query<{ id: string; revision: number }>(
      `INSERT INTO connections
         (user_id, provider, display_name, account_key, secret_enc, secret_nonce)
       VALUES ($1, 'knowledge-planet', 'KP', 'kp-preapproval-0169',
               decode(repeat('aa', 16), 'hex'), decode(repeat('bb', 12), 'hex'))
       RETURNING id::text AS id, revision`,
      [user.rows[0]!.id],
    )
    await assert.rejects(
      query(
        `UPDATE connections
            SET plugin_write_preapproval_enabled = TRUE,
                plugin_write_preapproval_disclaimer_version = 1,
                plugin_write_preapproval_accepted_at = now()
          WHERE id = $1::bigint`,
        [connection.rows[0]!.id],
      ),
      (error: unknown) => (error as { code?: unknown })?.code === '23514',
    )
    await query(
      `UPDATE connections
          SET plugin_write_enabled = TRUE,
              plugin_write_disclaimer_version = 2,
              plugin_write_disclaimer_accepted_at = now(),
              plugin_write_preapproval_enabled = TRUE,
              plugin_write_preapproval_disclaimer_version = 1,
              plugin_write_preapproval_accepted_at = now()
        WHERE id = $1::bigint`,
      [connection.rows[0]!.id],
    )

    const userId = Number(user.rows[0]!.id)
    const targetId = connection.rows[0]!.id
    const preapproved = await proposeWrite({
      userId,
      connectionId: targetId,
      connectionRevision: connection.rows[0]!.revision,
      provider: 'knowledge-planet',
      action: 'set_topic_like',
      params: { topicId: '123456789', liked: true },
      summary: '点赞主题',
      approval: { source: 'account_preapproval', policyVersion: 1 },
    })
    const row = await getLedgerRow(preapproved.id, userId)
    assert.ok(row)
    assert.equal(row.status, 'approved')
    assert.equal(row.approval_source, 'account_preapproval')
    assert.equal(row.approval_policy_version, 1)
    assert.ok(row.approved_at)

    await assert.rejects(
      query(
        `UPDATE connector_write_ledger
            SET approval_policy_version = NULL
          WHERE id = $1::uuid`,
        [preapproved.id],
      ),
      (error: unknown) => (error as { code?: unknown })?.code === '23514',
    )

    const interactive = await proposeWrite({
      userId,
      connectionId: targetId,
      connectionRevision: connection.rows[0]!.revision,
      provider: 'knowledge-planet',
      action: 'set_comment_like',
      params: { commentId: '223456789', liked: false },
      summary: '取消评论点赞',
    })
    const interactiveRow = await getLedgerRow(interactive.id, userId)
    assert.equal(interactiveRow?.status, 'pending')
    assert.equal(interactiveRow?.approval_source, 'user_confirmation')
    assert.equal(interactiveRow?.approval_policy_version, null)
  })
})
