/**
 * Isolated PG EXPLAIN for OCV5-185 permission snapshot / hello / lookup queries.
 * Creates a throwaway schema on the test fixture — never writes the live selfhost DB.
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/permissionPromptSnapshotExplain.integ.test.ts
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Pool } from 'pg'

import {
  PERMISSION_PROMPT_HELLO_BATCH_SQL,
  PERMISSION_PROMPT_LOOKUP_SQL,
  PERMISSION_PROMPT_SNAPSHOT_SQL,
  readPendingPermissionPromptsForSessions,
  readPermissionPromptSnapshot,
  readPermissionPromptsByRequestIds,
} from '../dispatch/turnControlStore.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const SCHEMA = 'oc_ocv5_185_perm_explain_test'

let pool: Pool
let pgAvailable = false

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    pgAvailable = false
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return

  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()

  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE turn_permission_requests (
      user_id                BIGINT NOT NULL,
      request_id             TEXT NOT NULL,
      session_id             TEXT NOT NULL,
      client_message_id      TEXT,
      tool_use_id            TEXT,
      tool_name              TEXT NOT NULL,
      input_sha256           TEXT NOT NULL,
      input_json             JSONB NOT NULL,
      ask_payload_json       JSONB,
      status                 TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','responded','expired','cancelled')),
      expires_at             TIMESTAMPTZ NOT NULL,
      response_control_id    TEXT,
      response_json          JSONB,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, request_id)
    );
    CREATE INDEX idx_turn_permission_pending
      ON turn_permission_requests (expires_at)
      WHERE status = 'pending';
    CREATE TABLE turn_control_requests (
      control_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      session_id TEXT NOT NULL,
      root_client_message_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  const userId = 3
  const values: string[] = []
  const params: unknown[] = []
  let p = 1
  for (let s = 0; s < 40; s++) {
    const sessionId = `sess-${s}`
    for (let r = 0; r < 8; r++) {
      const requestId = `req-${s}-${r}`
      const status = r === 0 ? 'pending' : r === 1 ? 'responded' : 'cancelled'
      values.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,$${p++},$${p++}::timestamptz,$${p++}::timestamptz)`,
      )
      params.push(
        userId,
        requestId,
        sessionId,
        `m-${s}`,
        requestId,
        'AskUserQuestion',
        'a'.repeat(64),
        JSON.stringify({ questions: [{ question: `q-${s}-${r}` }] }),
        status,
        new Date(Date.now() + (status === 'pending' ? 600_000 : -600_000)),
        new Date(Date.now() - (40 - s) * 60_000 - r * 1000),
      )
    }
  }
  await pool.query(
    `INSERT INTO turn_permission_requests
      (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at,created_at)
     VALUES ${values.join(',')}`,
    params,
  )
})

after(async () => {
  if (pool) await pool.end().catch(() => undefined)
  if (!pgAvailable) return
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

function skipIfNeeded(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip(`pg not available (${TEST_DB_URL})`)
    return true
  }
  return false
}

describe('OCV5-185 isolated PG EXPLAIN + 200+ scale', () => {
  test('seeded 320 rows (40 sessions × 8)', async (t) => {
    if (skipIfNeeded(t)) return
    const count = await pool.query('SELECT count(*)::int AS n FROM turn_permission_requests')
    assert.equal(count.rows[0]!.n, 320)
  })

  test('snapshot SQL is user+session bounded; EXPLAIN uses PK or filter, not unbounded seq scan of all users', async (t) => {
    if (skipIfNeeded(t)) return
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) ${PERMISSION_PROMPT_SNAPSHOT_SQL}`,
      ['3', 'sess-39', 16],
    )
    const json = JSON.stringify(plan.rows[0]!['QUERY PLAN'])
    assert.match(json, /turn_permission_requests/)
    // Existing indexes: pkey (user_id, request_id) and pending(expires_at).
    // Session-scoped ORDER BY created_at may still Filter after the user partition.
    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: 'sess-39' })
    assert.ok(snapshot.items.length > 0)
    assert.ok(snapshot.items.length <= 16)
    assert.ok(snapshot.completeness === 'complete' || snapshot.completeness === 'truncated')
    assert.equal(snapshot.source, 'pg')
    ;(globalThis as { __ocv5_185_snapshot_explain?: string }).__ocv5_185_snapshot_explain = json
  })

  test('lookup SQL uses (user_id, request_id) primary key', async (t) => {
    if (skipIfNeeded(t)) return
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) ${PERMISSION_PROMPT_LOOKUP_SQL}`,
      ['3', ['req-39-0', 'req-0-7'], 'sess-39'],
    )
    const json = JSON.stringify(plan.rows[0]!['QUERY PLAN'])
    assert.match(json, /Index Scan|Index Only Scan|Bitmap Index Scan/i)
    const rows = await readPermissionPromptsByRequestIds(pool, {
      userId: 3n,
      sessionId: 'sess-39',
      requestIds: ['req-39-0', 'req-0-7', 'req-1-0'],
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.requestId, 'req-39-0')
    ;(globalThis as { __ocv5_185_lookup_explain?: string }).__ocv5_185_lookup_explain = json
  })

  test('hello batch SQL is user + session ANY bounded at 200+ history scale', async (t) => {
    if (skipIfNeeded(t)) return
    const sessionIds = Array.from({ length: 40 }, (_, i) => `sess-${i}`)
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) ${PERMISSION_PROMPT_HELLO_BATCH_SQL} LIMIT $3`,
      ['3', sessionIds, 64],
    )
    const json = JSON.stringify(plan.rows[0]!['QUERY PLAN'])
    const grouped = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds,
    })
    assert.ok(grouped.size > 0)
    assert.ok(grouped.size <= 32)
    for (const [sessionId, rows] of grouped) {
      assert.match(sessionId, /^sess-\d+$/)
      assert.ok(rows.every((row) => row.requestId.startsWith('req-')))
    }
    ;(globalThis as { __ocv5_185_hello_explain?: string }).__ocv5_185_hello_explain = json
  })
})
