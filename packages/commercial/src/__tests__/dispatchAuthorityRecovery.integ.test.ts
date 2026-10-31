import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Pool } from 'pg'
import { turnRecoveryAttemptIdentity, AUTOMATIC_TURN_RETRY_MAX } from '@openclaude/protocol'
import { createPgSessionsBackend, scheduleUndeliveredDispatchRecovery } from '../db/pgSessionsBackend.js'
import { claimDueRecoveryJobs } from '../dispatch/turnRecoveryStore.js'
import { getTestDatabaseUrlForTempTables } from './helpers/db.js'

test('OCV5-682: a proven undelivered turn persists and claims exactly one fresh recovery job in PG', async () => {
  const url = getTestDatabaseUrlForTempTables()
  assert.match(new URL(url).pathname, /_test$/)
  const pool = new Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  try {
    const definitions = readFileSync(new URL('../db/migrations/0202_turn_recovery_control.sql', import.meta.url), 'utf8')
      .match(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\);/g)
    assert.equal(definitions?.length, 3)
    await client.query(definitions!.join('\n').replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'))
    await client.query(`CREATE TEMP TABLE client_sessions(id text,user_id text,messages text,deleted_at timestamptz);
      CREATE TEMP TABLE client_session_live_streams(stream_key text,session_id text,user_id text,client_message_id text);
      CREATE TEMP TABLE client_session_live_frames(stream_key text,payload bytea,record_id bigint)`)
    const source = { id: 'cm-682-pg', role: 'user', text: 'exact original request',
      _routing: { model: 'deepseek-v4-flash', effortLevel: 'high' } }
    await client.query(`INSERT INTO client_sessions VALUES ('session-682','c:3',$1,NULL)`, [JSON.stringify([source])])
    const row = { userId: 3n, sessionId: 'session-682', clientMessageId: source.id,
      dispatchId: '00000000-0000-4000-8000-000000000682', attemptNo: 1,
      requestHash: 'a'.repeat(64), agentId: 'main', failureCode: 'DISPATCH_AUTHORITY_EXPIRED', outcome: 'not_accepted' as const }
    await client.query('BEGIN')
    await scheduleUndeliveredDispatchRecovery(client, row)
    await scheduleUndeliveredDispatchRecovery(client, row)
    await client.query('COMMIT')
    assert.equal((await client.query('SELECT * FROM turn_recovery_jobs')).rowCount, 1, 'duplicate convergence cannot publish a second replay')
    const q = { query: (sql: string, values?: unknown[]) => client.query(sql, values) } as unknown as Pool
    const jobs = await claimDueRecoveryJobs(q, { userId: 3n, ownerId: 'test-682', leaseMs: 1000 })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.semanticRecoveryAttempt, 1)
    assert.equal(jobs[0]!.request._automaticRecoveryRetryLimit, 1)
    assert.equal((jobs[0]!.request.content as { text: string }).text, source.text)
    assert.equal('__oc_model_authority' in jobs[0]!.request, false)
    const child = { ...source, id: jobs[0]!.request.clientMessageId, _automaticRecovery: true,
      _automaticRecoveryAttempt: 1, _automaticRecoveryRootClientMessageId: source.id }
    await client.query("UPDATE client_sessions SET messages=$1", [JSON.stringify([source, child])])
    await client.query('BEGIN')
    await scheduleUndeliveredDispatchRecovery(client, { ...row, clientMessageId: child.id as string })
    await client.query('COMMIT')
    assert.equal((await client.query('SELECT * FROM turn_recovery_jobs')).rowCount, 1, 'receipt-free child refusal exhausts the same one-retry budget')
    const messages = JSON.parse((await client.query('SELECT messages FROM client_sessions')).rows[0].messages)
    assert.equal(messages.length, 2, 'no duplicate give-up card is appended')
  } finally { client.release(); await pool.end() }
})

test('OCV5-682: real PG replay admission waits for the completed no-billing proof', async () => {
  const url = getTestDatabaseUrlForTempTables()
  assert.match(new URL(url).pathname, /_test$/)
  const pool = new Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  try {
    const dispatchDefinition = readFileSync(new URL('../db/migrations/0170_durable_turn_dispatch.sql', import.meta.url), 'utf8')
      .match(/CREATE TABLE IF NOT EXISTS turn_dispatches[\s\S]*?\n\);/)?.[0]
    assert.ok(dispatchDefinition)
    await client.query(dispatchDefinition.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'))
    await client.query(`ALTER TABLE pg_temp.turn_dispatches ADD COLUMN visible_head jsonb,
      ADD COLUMN visible_at bigint,ADD COLUMN producer_fenced_at timestamptz,ADD COLUMN shutdown_ctx jsonb,
      ADD COLUMN agent_container_id integer,ADD COLUMN runtime_kind text,ADD COLUMN trace_id text;
      CREATE TEMP TABLE client_sessions(id text,user_id text,messages text,deleted_at timestamptz,
        next_seq integer DEFAULT 2,archived_through_seq bigint DEFAULT 0,archived_count bigint DEFAULT 0,
        workspace_mode text DEFAULT 'legacy',message_count integer DEFAULT 1,last_at bigint DEFAULT 0,
        updated_at bigint DEFAULT 0,history_revision bigint DEFAULT 1);
      CREATE TEMP TABLE client_session_turn_tapes(session_id text,user_id text,client_message_id text,
        finalized_at timestamptz,tape_id text,status text,waive_reason text,turn_key text);
      CREATE TEMP TABLE client_session_archived_ids(session_id text,msg_id text)`)
    const source = { id: 'cm-682-admission', role: 'user', text: 'exact original request', ts: 1, _seq: 1 }
    const parent = '00000000-0000-4000-8000-000000000681'
    await client.query("INSERT INTO client_sessions(id,user_id,messages) VALUES ('session-682-admission','c:3',$1)", [JSON.stringify([source])])
    await client.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,
      agent_id,request_hash,billing_request_id,status,outcome,failure_code,client_notified)
      VALUES ($1,3,'session-682-admission',$2,'main',$3,'billing-parent-682','terminal','not_accepted',
        'DISPATCH_AUTHORITY_EXPIRED',FALSE)`, [parent, source.id, 'a'.repeat(64)])
    // Real backend and PG statements; the facade pins transactions to these
    // connection-local TEMP tables instead of mocking an admission query.
    const pinned = { connect: async () => ({ query: client.query.bind(client), release() {} }) } as unknown as Pool
    const backend = createPgSessionsBackend(pinned, { expectedGeneration: 1 })
    const identity = turnRecoveryAttemptIdentity('session-682-admission', source.id, 1)
    const input: Parameters<typeof backend.admitUserTurn>[0] = {
      uid: 3n, sessionUserId: 'c:3', sessionId: 'session-682-admission', clientMessageId: identity.clientMessageId,
      agentId: 'main', model: null, requestHash: 'a'.repeat(64), billingRequestId: 'billing-child-682',
      dispatchId: '00000000-0000-4000-8000-000000000682', ownerId: 'browser-682',
      message: { id: identity.clientMessageId, role: 'user', text: source.text, ts: 2 },
      recovery: { sourceClientMessageId: source.id, mode: 'replay' as const, automatic: true as const,
        rootClientMessageId: source.id, attempt: 1, max: AUTOMATIC_TURN_RETRY_MAX },
    }
    assert.deepEqual(await backend.admitUserTurn(input), {
      kind: 'recovery_conflict', reason: 'source_not_safely_replayable',
    })
    assert.equal((await client.query('SELECT * FROM turn_dispatches')).rowCount, 1)
    assert.deepEqual(JSON.parse((await client.query('SELECT messages FROM client_sessions')).rows[0].messages), [source])
    await client.query("UPDATE turn_dispatches SET status='manual_reconcile',conflict_reason='billed_but_failed' WHERE dispatch_id=$1", [parent])
    assert.equal((await backend.admitUserTurn(input)).kind, 'recovery_conflict', 'a failed financial proof never admits the replay')
    await client.query("UPDATE turn_dispatches SET status='terminal',conflict_reason=NULL,client_notified=TRUE WHERE dispatch_id=$1", [parent])
    assert.equal((await backend.admitUserTurn(input)).kind, 'admitted', 'completed authoritative no-billing proof permits one new dispatch')
    assert.equal((await client.query('SELECT * FROM turn_dispatches')).rowCount, 2)
    assert.equal(JSON.parse((await client.query('SELECT messages FROM client_sessions')).rows[0].messages).length, 2)
  } finally { client.release(); await pool.end() }
})
