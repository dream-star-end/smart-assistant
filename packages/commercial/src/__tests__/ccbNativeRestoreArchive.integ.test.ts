import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Client, type PoolClient } from 'pg'
import { getTestDatabaseUrlForTempTables } from './helpers/db.js'
import { materializeLosslessTurn } from '../http/losslessTurnTape.js'
import { readCcbNativeRestoreArchive } from '../db/pgSessionsBackend.js'

const binding = { peerId: 'g607-temp-only', agentId: 'main', nativeSessionId: '60700000-0000-4000-8000-000000000001' }
const owner = 'c:765', clock = 1792800000000
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const ddl = `
CREATE TEMP TABLE client_sessions (id text,user_id text,deleted_at bigint,messages jsonb);
CREATE TEMP TABLE client_session_archive_chunks (session_id text,user_id text,first_seq bigint,messages jsonb);
CREATE TEMP TABLE client_session_turn_tapes (tape_id text,session_id text,user_id text,agent_id text,tape_sha256 text,physical_record_count integer,logical_record_count integer,record_payload_bytes bigint,client_message_id text,turn_index integer,created_at bigint,status text,turn_key text,finalized_at bigint,materialization_status text,billing_anchor_id text,dispatch_id uuid,attempt_no integer,waive_reason text);
CREATE TEMP TABLE client_session_turn_tape_records (tape_id text,session_id text,user_id text,msg_id text,ordinal integer,role text,content_sha256 text,payload bytea);
CREATE TEMP TABLE turn_dispatches (dispatch_id uuid,user_id integer,session_id text,agent_id text,client_message_id text,status text,outcome text);
CREATE TEMP TABLE turn_tape_recovery_links (session_id text,user_id text,source_tape_id text,recovery_tape_id text,source_tape_sha256 text,recovery_tape_sha256 text,source_turn_key text,recovery_turn_key text);
CREATE TEMP TABLE client_session_user_payloads (session_id text,user_id text,msg_id text,payload bytea,content_sha256 text,payload_bytes bigint);`
function nativeEvents() {
  return [
    { type: 'system', subtype: 'init', session_id: binding.nativeSessionId, parent_tool_use_id: null },
    { type: 'assistant', session_id: binding.nativeSessionId, parent_tool_use_id: null, uuid: 'native-a', message: { id: 'model-message', role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic opaque thought', signature: 'opaque-signature-byte-owner' }, { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: '/synthetic/image.png' } }] } },
    { type: 'user', session_id: binding.nativeSessionId, parent_tool_use_id: null, uuid: 'native-u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-one', content: [{ type: 'text', text: 'synthetic result' }] }] } },
    { type: 'assistant', session_id: binding.nativeSessionId, parent_tool_use_id: null, uuid: 'native-final', message: { id: 'model-final', role: 'assistant', content: [{ type: 'text', text: 'synthetic complete' }] } },
  ]
}
async function seed(client: Client, opts: { archived?: boolean; deferred?: boolean; recovery?: boolean } = {}) {
  const input = { id: 'm-g607-synthetic', role: 'user', text: 'synthetic visible prompt', _modelText: 'synthetic exact model prompt' }
  const events = nativeEvents()
  const payload = { sessionId: binding.peerId, agentId: binding.agentId, turnIndex: 1, status: 'completed', turnKey: '1'.repeat(64), createdAt: clock, text: 'synthetic visible output',
    runtimeEvents: events.map((payload, ordinal) => ({ ordinal, observedAt: clock + ordinal, source: 'ccb', payload })) }
  const turn = materializeLosslessTurn(payload, { runtimeBatching: true })
  assert.ok(turn.runtimeBatchManifestSha256, 'fixture must exercise real gzip batches')
  const tapeId = opts.recovery ? 'recovery-tape' : 'fixture-tape', tapeSha = sha(JSON.stringify(payload))
  const anchor = { id: 'fixture-anchor', role: 'assistant', text: payload.text, _turnTapeComplete: true, _turnTapeId: tapeId, _turnTapeSha256: tapeSha,
    _turnTapePhysicalRecordCount: turn.records.length, _turnTapeLogicalRecordCount: turn.logicalRecordCount, _turnTapeRuntimeManifestSha256: turn.runtimeBatchManifestSha256, _orderSeq: 10 }
  const user = opts.deferred ? { id: input.id, role: 'user', _userPayloadDeferred: true } : input
  await client.query('INSERT INTO client_sessions VALUES ($1,$2,NULL,$3)', [binding.peerId, owner, JSON.stringify(opts.archived ? [] : [user, anchor])])
  if (opts.archived) await client.query('INSERT INTO client_session_archive_chunks VALUES ($1,$2,1,$3)', [binding.peerId, owner, JSON.stringify([user, anchor])])
  if (opts.deferred) { const bytes = Buffer.from(JSON.stringify(input)); await client.query('INSERT INTO client_session_user_payloads VALUES ($1,$2,$3,$4,$5,$6)', [binding.peerId, owner, input.id, bytes, sha(bytes), bytes.length]) }
  await client.query(`INSERT INTO client_session_turn_tapes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'completed',$11,$10,'complete',$12,NULL,NULL,NULL)`,
    [tapeId, binding.peerId, owner, binding.agentId, tapeSha, turn.records.length, turn.logicalRecordCount, turn.records.reduce((n, record) => n + record.payloadBytes.length, 0), opts.recovery ? null : input.id, clock, payload.turnKey, turn.billingAnchorId])
  for (const [ordinal, record] of turn.records.entries()) await client.query('INSERT INTO client_session_turn_tape_records VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [tapeId, binding.peerId, owner, record.id, ordinal, record.role, record.payloadSha256, record.payloadBytes])
  if (opts.recovery) {
    const dispatch = '60700000-0000-4000-8000-000000000002', sourceSha = sha('synthetic-source-tape'), sourceKey = '2'.repeat(64)
    await client.query(`INSERT INTO client_session_turn_tapes VALUES ('source-tape',$1,$2,$3,$4,1,1,1,$5,1,$6,'crashed',$7,$6,'complete',$8,$9,1,NULL)`,
      [binding.peerId, owner, binding.agentId, sourceSha, input.id, clock, sourceKey, turn.billingAnchorId, dispatch])
    await client.query("INSERT INTO turn_dispatches VALUES ($1,765,$2,$3,$4,'terminal','crashed')", [dispatch, binding.peerId, binding.agentId, input.id])
    await client.query("INSERT INTO turn_tape_recovery_links VALUES ($1,$2,'source-tape',$3,$4,$5,$6,$7)", [binding.peerId, owner, tapeId, sourceSha, tapeSha, sourceKey, payload.turnKey])
  }
  return { events, input, tapeId }
}

test('raw restore validates tenant authority, batched bytes, deferred input and administrative recovery without touching shared tables', async t => {
  const url = getTestDatabaseUrlForTempTables(), parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'TEMP_FIXTURE_REQUIRES_LOOPBACK')
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^[a-z][a-z0-9_]*_test$/, 'TEMP_FIXTURE_REQUIRES_TEST_DATABASE')
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 })
  await client.connect()
  try {
    assert.match(String((await client.query('SELECT current_database() AS name')).rows[0]?.name), /^[a-z][a-z0-9_]*_test$/)
    await client.query('SET search_path TO pg_temp, pg_catalog'); await client.query(ddl)
    const read = (bound = binding, owned = owner) => readCcbNativeRestoreArchive(client as unknown as PoolClient, owned, bound)
    const scenario = async (name: string, fn: () => Promise<void>) => t.test(name, async () => { await client.query('BEGIN'); try { await fn() } finally { await client.query('ROLLBACK') } })
    await scenario('raw signature and complete native arrays survive real gzip batch expansion', async () => {
      const seeded = await seed(client), archive = await read()
      assert.equal(archive.tapes.length, 1); assert.deepEqual(archive.tapes[0]!.records.map(record => record.payload), seeded.events.slice(1))
      assert.equal(archive.tapes[0]!.canonicalInput.modelText, seeded.input._modelText)
      assert.equal(archive.tapes[0]!.records[0]!.sha256, sha(JSON.stringify(seeded.events[1])))
      await assert.rejects(read(binding, 'c:247')); await assert.rejects(read({ ...binding, peerId: 'foreign-peer' })); await assert.rejects(read({ ...binding, nativeSessionId: '60700000-0000-4000-8000-000000000099' }))
    })
    await scenario('archived anchors and exact deferred model input are authoritative', async () => {
      await seed(client, { archived: true, deferred: true }); assert.equal((await read()).tapes[0]!.canonicalInput.modelText, 'synthetic exact model prompt')
      await client.query("UPDATE client_session_user_payloads SET payload=convert_to('tampered','UTF8')")
      await assert.rejects(read())
    })
    await scenario('a validated content-only recovery keeps the original CID and excludes its crashed source', async () => {
      const seeded = await seed(client, { recovery: true }); const restored = await read()
      assert.deepEqual(restored.tapes.map(tape => tape.tapeId), [seeded.tapeId]); assert.equal(restored.tapes[0]!.canonicalInput.id, seeded.input.id)
      await client.query("UPDATE turn_tape_recovery_links SET recovery_turn_key=$1", ['f'.repeat(64)])
      await assert.rejects(read())
    })
    await scenario('payload tampering is rejected even if SQL lengths match', async () => {
      await seed(client); await client.query("UPDATE client_session_turn_tape_records SET payload=overlay(payload placing decode('78','hex') from 2 for 1) WHERE ordinal=0")
      await assert.rejects(read())
    })
    await scenario('the anchor manifest cannot authorize a different batch', async () => {
      await seed(client); await client.query("UPDATE client_sessions SET messages=jsonb_set(messages,'{1,_turnTapeRuntimeManifestSha256}',to_jsonb($1::text))", ['0'.repeat(64)])
      await assert.rejects(read())
    })
  } finally { await client.end() }
})
