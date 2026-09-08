/**
 * OCV5-185 B5: permission snapshot/lookup on the real timeline GET
 * (getClientSession / getClientSessionPartial view:'timeline') using a
 * borrowed PoolClient. Isolated schema only — never the live selfhost DB.
 *
 * Run via scripts/test-mutex.sh commercial. Do not use --test-force-exit.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Pool, type PoolClient } from 'pg'

import {
  queryPermissionRead,
  readPermissionPromptSnapshot,
} from '../dispatch/turnControlStore.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const SCHEMA = 'oc_ocv5_185_perm_timeline_get_test'
const USER = 'c:3'
const SESSION = 'sess-185-timeline'

let pool: Pool
let pgAvailable = false
let origConnect: Pool['connect'] | null = null
let borrowedConnects = 0

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

  pool = new Pool({ connectionString: TEST_DB_URL, max: 4, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL DEFAULT 't',
      pinned SMALLINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_at BIGINT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT,
      next_seq INTEGER NOT NULL DEFAULT 1,
      archived_through_seq INTEGER NOT NULL DEFAULT 0,
      archived_count INTEGER NOT NULL DEFAULT 0,
      history_revision BIGINT NOT NULL DEFAULT 0,
      timeline_generation BIGINT NOT NULL DEFAULT 0,
      model_id TEXT
    );
    CREATE TABLE client_session_archive_chunks (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seq BIGINT NOT NULL,
      last_seq BIGINT NOT NULL,
      message_count INTEGER NOT NULL,
      messages TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE turn_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      user_id BIGINT,
      session_id TEXT,
      client_message_id TEXT,
      status TEXT,
      accepted_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      model TEXT,
      admitted_at TIMESTAMPTZ
    );
    CREATE TABLE client_session_live_streams (
      stream_key TEXT PRIMARY KEY,
      dispatch_id TEXT
    );
    CREATE TABLE client_session_live_frames (
      stream_key TEXT,
      created_at TIMESTAMPTZ
    );
    CREATE TABLE turn_permission_requests (
      user_id BIGINT NOT NULL,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_message_id TEXT,
      tool_use_id TEXT,
      tool_name TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      input_json JSONB NOT NULL,
      ask_payload_json JSONB,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','responded','expired','cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      response_control_id TEXT,
      response_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, request_id)
    );
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

  const now = Date.now()
  await pool.query(
    `INSERT INTO client_sessions
      (id,user_id,title,created_at,last_at,messages,updated_at)
     VALUES ($1,$2,'185', $3,$3,'[]',$3)`,
    [SESSION, USER, now],
  )
  const question = '你'.repeat(3000)
  await pool.query(
    `INSERT INTO turn_permission_requests
      (user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,input_sha256,input_json,status,expires_at,response_json)
     VALUES
      (3,'req-pending', $1,'m-1','req-pending','AskUserQuestion', repeat('a',64),
        $2::jsonb,'pending', NOW() + interval '10 minutes', NULL),
      (3,'req-done', $1,'m-2','req-done','Bash', repeat('b',64),
        '{"command":"ls"}'::jsonb,'responded', NOW() + interval '10 minutes', '{"behavior":"allow"}'::jsonb),
      (3,'req-cjk', $1,'m-3','req-cjk','AskUserQuestion', repeat('c',64),
        $3::jsonb,'pending', NOW() + interval '10 minutes', NULL)`,
    [
      SESSION,
      JSON.stringify({ questions: [{ question: '短题？', options: [{ label: '是' }] }] }),
      JSON.stringify({ questions: [{ question, options: [{ label: '是' }] }] }),
    ],
  )
})

after(async () => {
  if (pool && origConnect) pool.connect = origConnect
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

function instrumentBorrowedConnect(): void {
  borrowedConnects = 0
  origConnect = pool.connect.bind(pool)
  pool.connect = (async () => {
    const client = await origConnect!()
    const innerConnect = client.connect.bind(client)
    client.connect = ((...args: unknown[]) => {
      borrowedConnects += 1
      return innerConnect(...(args as []))
    }) as typeof client.connect
    return client
  }) as Pool['connect']
}

describe('OCV5-185 timeline GET permission snapshot on borrowed client', () => {
  test('getClientSession view=timeline returns pending, terminal, and truncated+lookup', async (t) => {
    if (skipIfNeeded(t)) return
    instrumentBorrowedConnect()
    const { createPgSessionsBackend } = await import('../db/pgSessionsBackend.js')
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 0 })
    const sess = await backend.getClientSession(SESSION, USER, {
      view: 'timeline',
      permissionLookupIds: ['req-cjk'],
    } as never)
    assert.ok(sess, 'session row must exist')
    assert.equal(borrowedConnects, 0)
    const snap = (sess as { permissionPrompts?: {
      completeness: string
      items: Array<{ requestId: string; status: string; behavior: string | null; inputTruncated?: boolean }>
      lookups?: Array<{ requestId: string; inputTruncated?: boolean; inputJson: { questions: Array<{ question: string }> } }>
    } }).permissionPrompts
    assert.ok(snap)
    assert.notEqual(snap.completeness, 'unavailable')
    const pending = snap.items.find((item) => item.requestId === 'req-pending')
    const done = snap.items.find((item) => item.requestId === 'req-done')
    const cjk = snap.items.find((item) => item.requestId === 'req-cjk')
    assert.equal(pending?.status, 'pending')
    assert.equal(done?.status, 'responded')
    assert.equal(done?.behavior, 'allow')
    assert.equal(cjk?.inputTruncated, true)
    const looked = (snap.lookups ?? []).find((item) => item.requestId === 'req-cjk')
    assert.equal(looked?.inputTruncated, false)
    assert.equal((looked?.inputJson.questions as Array<{ question: string }>)[0]?.question, '你'.repeat(3000))
  })

  test('getClientSessionPartial view=timeline shares the borrowed client', async (t) => {
    if (skipIfNeeded(t)) return
    const { createPgSessionsBackend } = await import('../db/pgSessionsBackend.js')
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 0 })
    borrowedConnects = 0
    const partial = await backend.getClientSessionPartial(SESSION, USER, 0, {
      view: 'timeline',
      permissionLookupIds: ['req-pending'],
    } as never)
    assert.ok(partial)
    assert.equal(borrowedConnects, 0)
    const snap = (partial as { permissionPrompts?: {
      completeness: string
      items: Array<{ requestId: string }>
    } }).permissionPrompts
    assert.notEqual(snap?.completeness, 'unavailable')
    assert.ok(snap?.items.some((item) => item.requestId === 'req-pending'))
  })

  test('borrowed-client 250ms timeout rolls back to savepoint; outer txn still commits', async (t) => {
    if (skipIfNeeded(t)) return
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await assert.rejects(
        () => queryPermissionRead(client as never, 'SELECT pg_sleep(1)', []),
      )
      const ping = await client.query<{ ok: number }>('SELECT 1::int AS ok')
      assert.equal(ping.rows[0]!.ok, 1)
      const snapshot = await readPermissionPromptSnapshot(client, {
        userId: 3n,
        sessionId: SESSION,
      })
      assert.ok(snapshot.items.length > 0)
      assert.notEqual(snapshot.completeness, 'unavailable')
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
})
