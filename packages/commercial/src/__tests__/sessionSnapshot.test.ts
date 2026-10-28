import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { after, before, beforeEach, describe, test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { OutboundSessionSnapshot, type SessionSnapshot } from '@openclaude/protocol'
import { setClientSessionsBackend } from '@openclaude/storage'
import { Pool, type PoolClient } from 'pg'
import { WebSocket } from 'ws'
import { handleClientSessionsHttp, type ClientSessionsHttpIo } from '../../../gateway/src/routes/clientSessions.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import { readSessionSnapshot, SESSION_SNAPSHOT_MAX_BYTES } from '../db/sessionSnapshot.js'
import { sendHelloSessionSnapshots } from '../ws/helloOpenDispatchSnapshot.js'

// Real SQL in a private schema: no production connection and no shared fixture
// mutation. Freeze only the observation clock for exact WS/HTTP equality.
const schema = `snapshot_${randomUUID().replaceAll('-', '')}`
const url = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const admin = new Pool({ connectionString: url, max: 1 })
const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
const now = Date.now()
const pool = {
  async connect() {
    const client = await db.connect()
    return {
      query: (sql: string, values?: unknown[]) => client.query(sql.replaceAll('clock_timestamp()', `to_timestamp(${now}/1000.0)`), values),
      release: () => client.release(),
    } as PoolClient
  },
} as Pool
const id = '00000000-0000-4000-8000-000000000001'
const streamKey = `dispatch:${id}:1`
const sessionId = 'session-snapshot'
const cmid = 'cm-snapshot'
const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 })

before(async () => {
  setClientSessionsBackend(backend)
  await admin.query(`CREATE SCHEMA ${schema}`)
  await db.query(`
    CREATE TABLE client_sessions(id text PRIMARY KEY,user_id text,deleted_at timestamptz);
    CREATE TABLE turn_dispatches(dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,client_message_id text,
      agent_id text,status text,outcome text,attempt_no int,admitted_at timestamptz,accepted_at timestamptz,terminal_at timestamptz);
    CREATE TABLE client_session_live_streams(stream_key text PRIMARY KEY,session_id text,user_id text,
      client_message_id text,projection_source text,provenance jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
    CREATE TABLE client_session_live_frames(record_id bigserial PRIMARY KEY,stream_key text,frame_seq bigint,
      source text DEFAULT 'gateway',payload bytea,payload_sha256 text DEFAULT repeat('a',64),created_at timestamptz DEFAULT now());
    CREATE TABLE usage_records(user_id bigint,dispatch_id uuid,attempt_no int,created_at timestamptz,turn_key text,parent_turn_key text);
    CREATE TABLE client_session_turn_tapes(session_id text,user_id text,tape_id text,turn_key text,client_message_id text,status text,finalized_at timestamptz);
    CREATE TABLE turn_tape_cost_components(session_id text,user_id text,tape_id text,request_id text,cost_credits numeric);
    CREATE TABLE pending_usage_patches(user_id text,turn_key text,parent_turn_key text,request_id text,cost_credits text);
    CREATE TABLE turn_permission_requests(user_id bigint,session_id text,request_id text,client_message_id text,
      tool_use_id text,tool_name text,input_json jsonb,expires_at timestamptz,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE turn_control_requests(user_id bigint,session_id text,kind text,status text,root_client_message_id text,created_at timestamptz);
  `)
})
after(async () => {
  await db.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
})
beforeEach(async () => {
  await db.query(`TRUNCATE client_sessions,turn_dispatches,client_session_live_streams,client_session_live_frames,
    usage_records,client_session_turn_tapes,turn_tape_cost_components,pending_usage_patches,turn_permission_requests,turn_control_requests RESTART IDENTITY`)
  await db.query("INSERT INTO client_sessions VALUES ($1,'c:3',NULL)", [sessionId])
  await db.query(`INSERT INTO turn_dispatches VALUES ($1,3,$2,$3,'main','accepted',NULL,1,now()-interval '1 hour',now(),NULL)`, [id, sessionId, cmid])
  await db.query("INSERT INTO client_session_live_streams(stream_key,session_id,user_id,client_message_id,projection_source) VALUES ($1,$2,'c:3',$3,'live')", [streamKey, sessionId, cmid])
})
async function frame(seq: number, payload: Record<string, unknown>) {
  await db.query('INSERT INTO client_session_live_frames(stream_key,frame_seq,payload) VALUES ($1,$2,$3)',
    [streamKey, seq, Buffer.from(JSON.stringify({ ...payload, frameSeq: seq }))])
}
async function credits() {
  await db.query(`INSERT INTO usage_records VALUES (3,$1,1,now(),'root',NULL),(3,NULL,1,now(),'child','root')`, [id])
  await db.query("INSERT INTO client_session_turn_tapes VALUES ($1,'c:3','tape','root',$2,'completed',NULL)", [sessionId, cmid])
  await db.query("INSERT INTO turn_tape_cost_components VALUES ($1,'c:3','tape','r1',9007199254740993)", [sessionId])
  await db.query(`INSERT INTO pending_usage_patches VALUES
    ('c:3','root',NULL,'r1','9007199254740993'),('c:3','child','root','r2','7'),('c:3','root',NULL,'free','0'),
    ('c:9','root',NULL,'other-user','999'),('c:3','unrelated',NULL,'other-turn','888')`)
}
async function http(query = '', user = 'c:3'): Promise<{ code: number; body: { snapshot: SessionSnapshot } & Record<string, unknown> }> {
  return await new Promise(resolve => {
    const io = { getUserId: () => user, sendJson: (_res: unknown, code: number, body: never) => resolve({ code, body }) } as unknown as ClientSessionsHttpIo
    assert.equal(handleClientSessionsHttp(io, { method: 'GET' } as IncomingMessage, {} as ServerResponse,
      new URL(`http://localhost/api/sessions/${sessionId}/live-frames${query}`)), true)
  })
}
async function hello(extra: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = []
  await sendHelloSessionSnapshots(pool, { readyState: WebSocket.OPEN, bufferedAmount: 0, send: data => { sent.push(JSON.parse(String(data))) } },
    '3', [{ peerId: sessionId, ...extra }], null)
  return sent
}

describe('PG session snapshot transport contract', () => {
  test('new device: actual HTTP route and WS snapshot deep-equal, including actual credits and latest usage', async () => {
    await credits()
    await frame(20, { type: 'outbound.turn_usage', usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    await frame(21, { type: 'outbound.turn_status', status: 'working', detail: 'tool' })
    await frame(22, { type: 'outbound.message', blocks: [] })
    const response = await http()
    const sent = await hello()
    const wire = sent.find(f => f.type === 'outbound.session_snapshot')!
    assert.equal(response.code, 200)
    assert.deepEqual(wire.snapshot, response.body.snapshot)
    assert.equal(Value.Check(OutboundSessionSnapshot, wire), true)
    const snapshot = response.body.snapshot
    assert.deepEqual(snapshot.credits, { settled: '9007199254741000', requests: 3, asOf: now })
    assert.deepEqual((sent[0]!.meta as Record<string, unknown>).credits, snapshot.credits)
    assert.equal(snapshot.turnStatus?.status, 'working')
    assert.equal(snapshot.usage?.frameSeq, 20)
    assert.equal('credits' in snapshot.usage!, false)
    assert.ok(Array.isArray(response.body.frames), 'old HTTP page remains present')
    assert.equal(snapshot.gap, null, 'session-scoped first frame need not start at 1')
  })
  test('terminal requested cmid beats newer open; credits survive tape projection with no usage', async () => {
    await credits()
    await db.query("UPDATE turn_dispatches SET status='terminal',outcome='completed',terminal_at=now()")
    await db.query(`INSERT INTO turn_dispatches VALUES ('00000000-0000-4000-8000-000000000002',3,$1,'cm-new','main','admitted',NULL,1,now(),NULL,NULL)`, [sessionId])
    await db.query("UPDATE client_session_live_streams SET projection_source='tape'")
    const response = await http(`?dispatch=${cmid}`)
    const sent = await hello({ inFlight: true, inFlightClientMessageId: cmid })
    assert.deepEqual(sent.find(f => f.type === 'outbound.session_snapshot')!.snapshot, response.body.snapshot)
    assert.equal(response.body.snapshot.dispatch?.id, id)
    assert.equal(response.body.snapshot.reconcile, 'turn_completed')
    assert.equal(response.body.snapshot.usage, null)
    assert.equal(response.body.snapshot.credits?.settled, '9007199254741000')
    assert.equal(response.body.snapshot.gap?.reason, 'tape')
    assert.equal(sent[0]!.type, 'outbound.message')
  })
  test('afterSeq and legacy after are independent; stream change resets before paging', async () => {
    for (const seq of [10, 11, 12]) await frame(seq, { type: 'outbound.message' })
    const response = await http(`?after=1&afterSeq=10&streamKey=${streamKey}&limit=1`)
    assert.deepEqual(response.body.snapshot.frames.map(f => f.frameSeq), [11])
    assert.equal(response.body.snapshot.nextAfterSeq, 11)
    assert.equal(response.body.snapshot.hasMore, true)
    assert.equal(response.body.snapshot.gap?.reason, 'page_limit')
    assert.deepEqual((await hello({ lastFrameSeq: 10, lastStreamKey: streamKey })).find(f => f.type === 'outbound.session_snapshot')!.snapshot,
      (await http(`?afterSeq=10&streamKey=${streamKey}`)).body.snapshot)
    const reset = await readSessionSnapshot(pool, '3', sessionId, { afterSeq: 999, streamKey })
    assert.equal(reset!.gap?.reason, 'cursor_reset')
    assert.deepEqual(reset!.frames.map(f => f.frameSeq), [10, 11, 12])
  })
  test('reports a persisted sequence gap and an oversize payload locator without loading it', async () => {
    await frame(20, { type: 'outbound.message' })
    await frame(100, { type: 'outbound.message' })
    assert.equal((await readSessionSnapshot(pool, '3', sessionId))!.gap?.reason, 'sequence_gap')
    await frame(101, { type: 'outbound.message', text: 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES + 1) })
    const snapshot = (await readSessionSnapshot(pool, '3', sessionId))!
    assert.equal(snapshot.frames.length, 2)
    assert.equal(snapshot.gap?.reason, 'byte_limit')
    assert.equal(snapshot.gap?.frameSeq, 101)
    assert.equal(snapshot.gap?.sha256, 'a'.repeat(64))
    assert.equal(snapshot.nextAfterSeq, 100)
  })
  test('latest usage is found beyond 64 tail frames; stale engine_starting cannot revive', async () => {
    await frame(1, { type: 'outbound.turn_status', status: 'engine_starting' })
    await frame(2, { type: 'outbound.turn_usage', usage: { totalTokens: 1, inputTokens: 1 } })
    for (let i = 3; i < 70; i++) await frame(i, { type: 'outbound.message' })
    const snapshot = (await readSessionSnapshot(pool, '3', sessionId))!
    assert.equal(snapshot.usage?.frameSeq, 2)
    assert.equal(snapshot.turnStatus?.status, null)
    assert.deepEqual(snapshot.credits, { settled: '0', requests: 0, asOf: now })
  })
  test('legal JSON with escaped NUL or lone surrogate never breaks recovery; nested type is not usage', async () => {
    await frame(1, { type: 'outbound.turn_usage', usage: { totalTokens: 7 } })
    await frame(2, { type: 'outbound.turn_status', status: 'working' })
    for (let seq = 3; seq < 70; seq++) {
      await frame(seq, { type: 'outbound.message', text: '\u0000\ud800', nested: { type: 'outbound.turn_usage' } })
    }
    const snapshot = (await http()).body.snapshot
    assert.equal(snapshot.usage?.frameSeq, 1)
    assert.equal(snapshot.usage?.usage.totalTokens, 7)
    assert.equal(snapshot.turnStatus?.status, 'working')
    assert.equal(snapshot.frames.length, 69)
    assert.deepEqual((await hello()).find(f => f.type === 'outbound.session_snapshot')!.snapshot, snapshot)
  })
  test('missing/deleted/other-user sessions never expose dispatch, frames or billing', async () => {
    await credits()
    assert.equal((await http('', 'c:9')).code, 404)
    assert.equal(await readSessionSnapshot(pool, '9', sessionId), null)
    assert.equal(await readSessionSnapshot(pool, 'invalid', sessionId), null)
    await db.query('UPDATE client_sessions SET deleted_at=now()')
    assert.equal((await hello()).length, 0)
  })
  test('no dispatch is an explicit idle snapshot, not a terminal verdict', async () => {
    await db.query('DELETE FROM turn_dispatches')
    const snapshot = (await http()).body.snapshot
    assert.equal(snapshot.dispatch, null)
    assert.equal(snapshot.reconcile, null)
    assert.equal(snapshot.credits, null)
    assert.deepEqual((await hello())[0]!.snapshot, snapshot)
  })
  test('PG pending permissions preserve stop, expiry and detached ask_user semantics', async () => {
    await db.query(`INSERT INTO turn_permission_requests(user_id,session_id,request_id,client_message_id,tool_name,input_json,expires_at,status)
      SELECT 3,$1,request,$2,'tool','{}',now()+duration,'pending' FROM (VALUES
        ('stopped',interval '1 hour'),('ask-user:keep',interval '1 hour'),('expired',interval '-1 hour')) v(request,duration)`, [sessionId, cmid])
    await db.query("INSERT INTO turn_control_requests VALUES(3,$1,'stop','pending',$2,now())", [sessionId, cmid])
    const snapshot = (await readSessionSnapshot(pool, '3', sessionId))!
    assert.deepEqual(snapshot.pendingPermissions.items.map(p => p.requestId), ['ask-user:keep'])
    assert.equal(snapshot.pendingPermissions.completeness, 'complete')
  })
  test('credit query failure rolls back its savepoint and still returns authoritative state', async () => {
    await db.query('ALTER TABLE usage_records RENAME TO usage_records_unavailable')
    try {
      const snapshot = (await readSessionSnapshot(pool, '3', sessionId))!
      assert.equal(snapshot.credits, null)
      assert.equal(snapshot.dispatch?.status, 'accepted')
      assert.equal(snapshot.turnStatus?.status, 'engine_starting')
    } finally { await db.query('ALTER TABLE usage_records_unavailable RENAME TO usage_records') }
  })
  test('HTTP rejects malformed cursors without a backend query', async () => {
    for (const q of ['?afterSeq=-1', '?afterSeq=1.5', '?dispatch=%20', '?streamKey=garbage', '?limit=501']) {
      assert.equal((await http(q)).code, 400, q)
    }
  })
})
