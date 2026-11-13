import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Client, type Pool } from 'pg'
import Database from 'better-sqlite3'
import { setClientSessionsBackend, scanRecentClientSessionMessages } from '@openclaude/storage'
import { sweepUploadDir, scanRefsForUploads } from '../../../gateway/src/uploadRetention.js'
import { getTestDatabaseUrlForTempTables } from './helpers/db.js'
import { materializeLosslessTurn } from '../http/losslessTurnTape.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'

const fixtureRoots: string[] = []
const zlib = createRequire(import.meta.url)('node:zlib') as typeof import('node:zlib')
async function observeGunzip(fn: (limits: number[], failures: string[]) => Promise<void>) {
  const original = zlib.gunzipSync; const limits: number[] = []; const failures: string[] = []
  zlib.gunzipSync = ((...args: Parameters<typeof original>) => {
    limits.push(args[1]?.maxOutputLength ?? 0)
    try { return original(...args) } catch (error) { failures.push(String((error as NodeJS.ErrnoException).code)); throw error }
  }) as typeof original
  syncBuiltinESMExports()
  try { await fn(limits, failures) } finally { zlib.gunzipSync = original; syncBuiltinESMExports() }
}

const owner = 'c:707'
const session = 'upload-retention-synthetic'
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const names = Object.fromEntries(['hot', 'archive', 'tape', 'gzip', 'user', 'orphan'].map(k => [k, `${sha(k)}.txt`]))
const ddl = `
CREATE TEMP TABLE client_sessions (id text,user_id text,deleted_at bigint,last_at bigint,messages text);
CREATE TEMP TABLE client_session_archive_chunks (session_id text,user_id text,first_seq bigint,messages text);
CREATE TEMP TABLE client_session_turn_tapes (tape_id text,session_id text,user_id text,tape_sha256 text,billing_anchor_id text,status text,turn_key text,client_message_id text,continuation_of_turn_key text,physical_record_count int,logical_record_count int,record_payload_bytes bigint,materialization_status text,finalized_at bigint,visible_at bigint,visible_head jsonb,dispatch_id uuid,waive_reason text,usage jsonb,engine_billings jsonb);
CREATE TEMP TABLE client_session_turn_tape_records (tape_id text,session_id text,user_id text,msg_id text,ordinal int,role text,content_sha256 text,payload bytea);
CREATE TEMP TABLE client_session_user_payloads (session_id text,user_id text,msg_id text,payload bytea,content_sha256 text,payload_bytes bigint);
CREATE TEMP TABLE turn_dispatches (dispatch_id uuid,client_message_id text);
CREATE TEMP TABLE turn_waivers (user_id bigint,turn_key text,status text);
CREATE TEMP TABLE turn_tape_cost_components (user_id text,session_id text,tape_id text,billing_anchor_id text,cost_credits text,delegate_agent_id text);
CREATE TEMP TABLE pending_usage_patches (user_id text,turn_key text,parent_turn_key text,request_id text,cost_credits text,delegate_agent_id text);
CREATE TEMP TABLE turn_tape_recovery_links (session_id text,user_id text,recovery_tape_id text,source_tape_id text);`

async function seed(client: Client, opts: { archived?: boolean; tapeCount?: number; padding?: number } = {}) {
  const now = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'upload-authority-')); fixtureRoots.push(root)
  const uploads = join(root, 'uploads'); const parts = join(root, 'parts')
  mkdirSync(uploads); mkdirSync(parts)
  for (const name of Object.values(names)) { const file = join(uploads, name); writeFileSync(file, ''); utimesSync(file, new Date(now - 36 * 86400000), new Date(now - 36 * 86400000)) }
  const part = join(parts, `.part-${'a'.repeat(32)}-0`); writeFileSync(part, ''); utimesSync(part, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000))
  const input = { id: 'deferred-user', role: 'user', text: `/uploads/${names.user}` }
  const bytes = Buffer.from(JSON.stringify(input))
  const messages: Record<string, unknown>[] = [{ role: 'user', text: `/api/media/${names.hot}` }, { id: input.id, role: 'user', _userPayloadDeferred: true, _payloadDeferred: true, _payloadSha256: sha(bytes) }]
  await client.query('INSERT INTO client_session_user_payloads VALUES ($1,$2,$3,$4,$5,$6)', [session, owner, input.id, bytes, sha(bytes), bytes.length])
  for (let n = 0; n < (opts.tapeCount ?? 1); n++) {
    const payload = { sessionId: session, agentId: 'main', turnIndex: n + 1, status: 'completed', turnKey: sha(`turn-${n}`), createdAt: now, text: `/api/media/${names.tape}`,
      runtimeEvents: Array.from({ length: 4 }, (_, ordinal) => ({ ordinal, observedAt: now + ordinal, source: 'ccb', payload: { type: 'assistant', text: `/api/media/${names.gzip} ${'x'.repeat(opts.padding ?? 0)}` } })) }
    const turn = materializeLosslessTurn(payload, { runtimeBatching: true })
    assert.ok(turn.runtimeBatchManifestSha256, 'synthetic fixture exercises real gzip batches')
    assert.ok(turn.records.some(r => r.payload._runtimeEventBatch), 'compressed record must exist')
    const tapeId = `tape-${n}`; const tapeSha = sha(JSON.stringify(payload))
    messages.push({ id: turn.billingAnchorId, role: 'assistant', _turnTapeId: tapeId, _turnTapeSha256: tapeSha, _turnTapeComplete: true,
      _turnTapePhysicalRecordCount: turn.records.length, _turnTapeLogicalRecordCount: turn.logicalRecordCount, _turnTapeRuntimeManifestSha256: turn.runtimeBatchManifestSha256 })
    await client.query(`INSERT INTO client_session_turn_tapes VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,NULL,$8,$9,$10,'complete',$11,$11,NULL,NULL,NULL,'{}','[]')`,
      [tapeId, session, owner, tapeSha, turn.billingAnchorId, payload.turnKey, input.id, turn.records.length, turn.logicalRecordCount, turn.records.reduce((a, r) => a + r.payloadBytes.length, 0), now])
    for (const [ordinal, record] of turn.records.entries()) await client.query('INSERT INTO client_session_turn_tape_records VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tapeId, session, owner, record.id, ordinal, record.role, record.payloadSha256, record.payloadBytes])
  }
  await client.query('INSERT INTO client_sessions VALUES ($1,$2,NULL,$3,$4)', [session, owner, now, JSON.stringify(opts.archived ? [] : messages)])
  await client.query('INSERT INTO client_session_archive_chunks VALUES ($1,$2,1,$3)', [session, owner, JSON.stringify([{ role: 'user', text: `/uploads/${names.archive}` }, ...(opts.archived ? messages : [])])])
  return { root, uploads, parts, now, sweep: () => sweepUploadDir({ uploadsDir: uploads, sessionDirs: [parts], userId: owner, sessionsDb: join(root, 'stale-master.db'), jsonlRoots: [], now }) }
}

test('upload retention reads authoritative PG hot, archive and exact deferred payloads with bounded complete scans', async t => {
  const url = getTestDatabaseUrlForTempTables(); const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'TEMP_FIXTURE_REQUIRES_LOOPBACK')
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^[a-z][a-z0-9_]*_test$/, 'TEMP_FIXTURE_REQUIRES_TEST_DATABASE')
  const oldStore = process.env.OC_SESSIONS_STORE; const oldContainer = process.env.OC_CONTAINER_ID
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await client.connect()
  const queries: string[] = []; let delayFetch = false
  const pool = { connect: async () => ({ query: async (sql: string, args?: unknown[]) => { queries.push(sql); if (delayFetch && sql.startsWith('FETCH')) await new Promise(resolve => setTimeout(resolve, 25)); return client.query(sql, args) }, release() {} }) } as unknown as Pool
  const backend = createPgSessionsBackend(pool, { expectedGeneration: 0 })
  const scan = backend.scanRecentClientSessionMessages.bind(backend)
  const scopedScan = () => scan({ userId: owner, sinceMs: Date.now() - 30 * 86400000 }, () => {})
  const incomplete = async (fixture: Awaited<ReturnType<typeof seed>>) => {
    const result = await fixture.sweep()
    assert.equal(result.skippedAged, true); assert.equal(result.published, 0)
    for (const name of Object.values(names)) assert.equal(existsSync(join(fixture.uploads, name)), true)
    assert.equal(result.parts, 1, '24h part cleanup still runs when references are incomplete')
  }
  try {
    assert.match(String((await client.query('SELECT current_database() AS name')).rows[0]?.name), /^[a-z][a-z0-9_]*_test$/)
    await client.query('SET search_path TO pg_temp, pg_catalog'); await client.query(ddl)
    process.env.OC_SESSIONS_STORE = 'pg'; Reflect.deleteProperty(process.env, 'OC_CONTAINER_ID')
    const scenario = async (name: string, fn: () => Promise<void>) => t.test(name, async () => {
      await client.query('TRUNCATE pg_temp.client_sessions,pg_temp.client_session_archive_chunks,pg_temp.client_session_turn_tapes,pg_temp.client_session_turn_tape_records,pg_temp.client_session_user_payloads')
      backend.scanRecentClientSessionMessages = scan; queries.length = 0
      try { await fn() } finally { backend.scanRecentClientSessionMessages = scan; Reflect.deleteProperty(process.env, 'OC_CONTAINER_ID') }
    })
    await scenario('PG configuration without injected PG backend cannot fall back to stale SQLite', async () => {
      const fixture = await seed(client)
      const stalePath = join(fixture.root, 'stale-master.db'); const stale = new Database(stalePath)
      stale.exec('CREATE TABLE client_sessions (id TEXT,user_id TEXT,last_at INTEGER,deleted_at INTEGER,messages TEXT); CREATE TABLE client_session_archive_chunks (session_id TEXT,user_id TEXT,messages TEXT)'); stale.close()
      assert.equal(await scanRecentClientSessionMessages({ userId: owner, sinceMs: 0, sessionsDb: stalePath }, () => { throw new Error('must not visit stale SQLite') }), false)
      await incomplete(fixture)
    })
    setClientSessionsBackend(backend)
    await scenario('PG hot/archive/tape/gzip/user references survive while a genuinely unreferenced file is removed', async () => {
      const fixture = await seed(client)
      const refs = await scanRefsForUploads({ userId: owner, sinceMs: fixture.now - 1000, sessionsDb: join(fixture.root, 'nonexistent.sqlite'), jsonlRoots: [] })
      assert.equal(refs.complete, true)
      for (const key of ['hot', 'archive', 'tape', 'gzip', 'user']) assert.equal(refs.names.has(names[key]!), true, key)
      const result = await fixture.sweep(); assert.equal(result.published, 1); assert.equal(result.skippedAged, false)
      assert.equal(existsSync(join(fixture.uploads, names.orphan!)), false)
      for (const key of ['hot', 'archive', 'tape', 'gzip', 'user']) assert.equal(existsSync(join(fixture.uploads, names[key]!)), true)
      assert.ok(queries.some(sql => sql.includes('REPEATABLE READ READ ONLY')))
      assert.equal(queries.some(sql => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)), false)
    })
    await scenario('archive-only exact tape and deferred user references are protected', async () => { const fixture = await seed(client, { archived: true }); assert.equal((await fixture.sweep()).published, 1); assert.equal(existsSync(join(fixture.uploads, names.user!)), true); assert.equal(existsSync(join(fixture.uploads, names.gzip!)), true) })
    await scenario('a missing tape record fails closed', async () => { const fixture = await seed(client); await client.query('DELETE FROM client_session_turn_tape_records WHERE ordinal=0'); await incomplete(fixture) })
    await scenario('a missing or short deferred user payload fails closed', async () => { const fixture = await seed(client); await client.query("UPDATE client_session_user_payloads SET payload=convert_to('short','UTF8')"); await incomplete(fixture); await client.query('DELETE FROM client_session_user_payloads'); assert.equal(await scopedScan(), false) })
    await scenario('a same-length corrupted tape payload fails closed', async () => { const fixture = await seed(client); await client.query("UPDATE client_session_turn_tape_records SET payload=overlay(payload placing decode('78','hex') from 2 for 1) WHERE ordinal=0"); await incomplete(fixture) })
    await scenario('row, byte and time budgets cannot authorize partial deletion', async () => {
      const fixture = await seed(client)
      for (const limits of [{ maxRows: 1 }, { maxBytes: 128 }]) assert.equal(await scan({ userId: owner, sinceMs: 0, ...limits }, () => {}), false)
      delayFetch = true; try { assert.equal(await scan({ userId: owner, sinceMs: 0, maxMs: 5 }, () => {}), false) } finally { delayFetch = false }
      backend.scanRecentClientSessionMessages = (opts, visit) => scan({ ...opts, maxRows: 1 }, visit); await incomplete(fixture)
    })
    await scenario('container-local logs cannot authorize deletion of published files', async () => { const fixture = await seed(client); process.env.OC_CONTAINER_ID = 'synthetic-container'; await incomplete(fixture); assert.equal(queries.length, 0) })
    await scenario('legacy unknown or mismatched tape metadata fails closed before hydration', async () => {
      const fixture = await seed(client); await client.query('UPDATE client_session_turn_tapes SET record_payload_bytes=0'); await incomplete(fixture)
      assert.equal(queries.some(sql => sql.includes('SELECT r.tape_id, t.tape_sha256')), false)
    })
    await scenario('unpublished and rolling tape locators are incomplete', async () => {
      const fixture = await seed(client); await client.query("UPDATE client_session_turn_tapes SET materialization_status='pending'"); await incomplete(fixture)
      await client.query("UPDATE client_session_turn_tapes SET materialization_status='complete'")
      await client.query("UPDATE client_sessions SET messages=jsonb_set(jsonb_set(messages::jsonb,'{2,_turnTapeComplete}','false'),'{2,_turnTapeMsgId}',to_jsonb((SELECT msg_id FROM client_session_turn_tape_records WHERE ordinal=0)))::text"); assert.equal(await scopedScan(), false)
    })
    await scenario('multiple gzip tapes share one expansion budget', async () => {
      const fixture = await seed(client, { tapeCount: 3, padding: 2000 })
      await observeGunzip(async limits => {
        assert.equal(await scan({ userId: owner, sinceMs: 0, maxBytes: 40000 }, () => {}), false)
        assert.ok(limits.length >= 2, 'at least two tapes must reach gzip expansion')
        assert.ok(limits[1]! < limits[0]!, 'second tape receives the remaining budget, not a fresh budget')
      })
      backend.scanRecentClientSessionMessages = (opts, visit) => scan({ ...opts, maxBytes: 40000 }, visit); await incomplete(fixture)
    })
    await scenario('gzip output is bounded even when its declared uncompressed size lies', async () => {
      const fixture = await seed(client, { padding: 12000 })
      const row = (await client.query<{ tape_id: string; msg_id: string; payload: Buffer }>("SELECT tape_id,msg_id,payload FROM client_session_turn_tape_records WHERE role='runtime-event' AND convert_from(payload,'UTF8') LIKE '%_runtimeEventBatch%'")).rows[0]!
      const payload = JSON.parse(row.payload.toString('utf8')); payload._runtimeEventBatch.uncompressedBytes = 1
      const bytes = Buffer.from(JSON.stringify(payload)); await client.query('UPDATE client_session_turn_tape_records SET payload=$1,content_sha256=$2 WHERE msg_id=$3', [bytes, sha(bytes), row.msg_id])
      await client.query('UPDATE client_session_turn_tapes t SET record_payload_bytes=(SELECT SUM(octet_length(r.payload)) FROM client_session_turn_tape_records r WHERE r.tape_id=t.tape_id)')
      backend.scanRecentClientSessionMessages = (opts, visit) => scan({ ...opts, maxBytes: 20000 }, visit)
      await observeGunzip(async (limits, failures) => { await incomplete(fixture); assert.ok(limits.some(n => n > 0 && n <= 20000)); assert.ok(failures.includes('ERR_BUFFER_TOO_LARGE'), 'gzip must stop at the output limit before post-expansion validation') })
    })
  } finally {
    if (oldStore === undefined) Reflect.deleteProperty(process.env, 'OC_SESSIONS_STORE'); else process.env.OC_SESSIONS_STORE = oldStore
    if (oldContainer === undefined) Reflect.deleteProperty(process.env, 'OC_CONTAINER_ID'); else process.env.OC_CONTAINER_ID = oldContainer
    await client.end()
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
  }
})
