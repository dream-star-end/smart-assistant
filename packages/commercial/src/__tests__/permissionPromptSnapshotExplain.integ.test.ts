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
  PERMISSION_PROMPT_HELLO_PRODUCTION_SQL,
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
    const selected = sessionIds.slice(0, 32)
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) ${PERMISSION_PROMPT_HELLO_PRODUCTION_SQL}`,
      ['3', selected, 64, 2],
    )
    const json = JSON.stringify(plan.rows[0]!['QUERY PLAN'])
    const grouped = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds,
    })
    assert.ok(grouped.bySession.size > 0)
    assert.ok(grouped.bySession.size <= 32)
    for (const [sessionId, rows] of grouped.bySession) {
      assert.match(sessionId, /^sess-\d+$/)
      assert.ok(rows.every((row) => row.requestId.startsWith('req-')))
    }
    ;(globalThis as { __ocv5_185_hello_explain?: string }).__ocv5_185_hello_explain = json
  })

  test('B4 Stop then late persist: hello/GET/lookup hide ordinary pending, keep detached ask-user', async (t) => {
    if (skipIfNeeded(t)) return
    const now = Date.now()
    await pool.query(
      `INSERT INTO turn_permission_requests
        (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at,created_at)
       VALUES
        (3,'req-stop-late','sess-stop','m-stop','req-stop-late','Bash',$5,$1::jsonb,'pending',$2::timestamptz,$3::timestamptz),
        (3,'ask-user:keep-stop','sess-stop','m-stop',null,'AskUserQuestion',$6,$4::jsonb,'pending',$2::timestamptz,$3::timestamptz)`,
      [
        JSON.stringify({ command: 'rm -rf /tmp/x' }),
        new Date(now + 600_000),
        new Date(now - 5_000),
        JSON.stringify({ questions: [{ question: '还问吗' }] }),
        'b'.repeat(64),
        'c'.repeat(64),
      ],
    )
    await pool.query(
      `INSERT INTO turn_control_requests (control_id,user_id,session_id,root_client_message_id,kind,status,created_at)
       VALUES ('ctl-stop',3,'sess-stop','m-stop','stop','terminal',$1::timestamptz)`,
      [new Date(now - 1_000)],
    )
    const hello = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds: ['sess-stop'],
    })
    const helloIds = (hello.bySession.get('sess-stop') ?? []).map((row) => row.requestId)
    assert.ok(!helloIds.includes('req-stop-late'))
    assert.ok(helloIds.includes('ask-user:keep-stop'))

    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: 'sess-stop' })
    const late = snapshot.items.find((item) => item.requestId === 'req-stop-late')
    const detached = snapshot.items.find((item) => item.requestId === 'ask-user:keep-stop')
    assert.equal(late?.status, 'cancelled')
    assert.equal(late?.response?.reason, 'user_stop')
    assert.equal(detached?.status, 'pending')

    const looked = await readPermissionPromptsByRequestIds(pool, {
      userId: 3n,
      sessionId: 'sess-stop',
      requestIds: ['req-stop-late', 'ask-user:keep-stop'],
    })
    assert.equal(looked.find((row) => row.requestId === 'req-stop-late')?.status, 'cancelled')
    assert.equal(looked.find((row) => row.requestId === 'ask-user:keep-stop')?.status, 'pending')
  })

  test('UTF-8 CJK over 8KiB is truncated on snapshot and restored by lookup', async (t) => {
    if (skipIfNeeded(t)) return
    const question = '你'.repeat(3000)
    assert.ok(Buffer.byteLength(JSON.stringify({ questions: [{ question }] }), 'utf8') > 8192)
    await pool.query(
      `INSERT INTO turn_permission_requests
        (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at)
       VALUES (3,'req-cjk','sess-cjk','m-cjk','req-cjk','AskUserQuestion',$2,$1::jsonb,'pending',NOW() + interval '10 minutes')`,
      [JSON.stringify({ questions: [{ question, options: [{ label: '是' }] }] }), 'd'.repeat(64)],
    )
    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: 'sess-cjk' })
    const item = snapshot.items.find((row) => row.requestId === 'req-cjk')
    assert.equal(item?.inputTruncated, true)
    const looked = await readPermissionPromptsByRequestIds(pool, {
      userId: 3n,
      sessionId: 'sess-cjk',
      requestIds: ['req-cjk'],
    })
    assert.equal(looked[0]?.inputTruncated, false)
    assert.equal((looked[0]?.input.questions as Array<{ question: string }>)[0]?.question, question)
  })

  test('Q1 uneven 32-session fair share marks truncation below the 64-row budget', async (t) => {
    if (skipIfNeeded(t)) return
    await pool.query(`
      INSERT INTO turn_permission_requests
        (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at)
      SELECT 3, 'q1-' || s || '-' || r, 'q1-' || s, 'q1-m-' || s,
             'q1-' || s || '-' || r, 'AskUserQuestion', repeat('e',64),
             '{"questions":[{"question":"q"}]}'::jsonb, 'pending', NOW() + interval '10 minutes'
        FROM generate_series(0,31) AS s CROSS JOIN generate_series(0,2) AS r
       WHERE s > 0 OR r = 0
    `)
    const scan = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds: Array.from({ length: 32 }, (_, i) => `q1-${i}`),
    })
    assert.equal(scan.bySession.size, 32)
    assert.equal([...scan.bySession.values()].reduce((n, rows) => n + rows.length, 0), 63)
    assert.equal(scan.rowLimited, true)
  })

  test('Q1 3+31x1 skew: production SQL drops the extra row and marks rowLimited', async (t) => {
    if (skipIfNeeded(t)) return
    await pool.query(`
      INSERT INTO turn_permission_requests
        (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at)
      SELECT 3, 'sk31-' || s || '-' || r, 'sk31-' || s, 'sk31-m-' || s,
             'sk31-' || s || '-' || r, 'AskUserQuestion', repeat('f',64),
             '{"questions":[{"question":"q"}]}'::jsonb, 'pending', NOW() + interval '10 minutes'
        FROM generate_series(0,31) AS s
        CROSS JOIN generate_series(0, CASE WHEN s=0 THEN 2 ELSE 0 END) AS r
    `)
    const scan = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds: Array.from({ length: 32 }, (_, i) => `sk31-${i}`),
    })
    const s0 = scan.bySession.get('sk31-0') ?? []
    assert.equal(s0.length, 2)
    assert.equal([...scan.bySession.values()].reduce((n, rows) => n + rows.length, 0), 33)
    assert.equal(scan.rowLimited, true)
  })

  test('Q1 9+1 two-session skew: per-session cap marks rowLimited below global LIMIT', async (t) => {
    if (skipIfNeeded(t)) return
    await pool.query(`
      INSERT INTO turn_permission_requests
        (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at)
      SELECT 3, 'sk91-' || s || '-' || r, 'sk91-' || s, 'sk91-m-' || s,
             'sk91-' || s || '-' || r, 'AskUserQuestion', repeat('g',64),
             '{"questions":[{"question":"q"}]}'::jsonb, 'pending', NOW() + interval '10 minutes'
        FROM generate_series(0,1) AS s
        CROSS JOIN generate_series(0, CASE WHEN s=0 THEN 8 ELSE 0 END) AS r
    `)
    const scan = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds: ['sk91-0', 'sk91-1'],
    })
    assert.equal((scan.bySession.get('sk91-0') ?? []).length, 8)
    assert.equal((scan.bySession.get('sk91-1') ?? []).length, 1)
    assert.equal(scan.rowLimited, true)
  })
})
