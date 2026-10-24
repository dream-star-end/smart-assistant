import { createServer } from 'node:http'
import { signAccess } from '../auth/jwt.js'
import { dispatchSessionMetadataRead } from '../http/sessionMetadata.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
/** New unique private schemas; never reads or resets shared/product account data. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { SystemActionStore } from '@openclaude/storage'
import { setPoolOverride, closePool } from '../db/index.js'
import { patchSessionMetadataInTx, readSessionMetadata } from '../db/sessionMetadataApproval.js'
import { sessionMetadataOperations } from '../system-assistant/sessionMetadataOperations.js'
import { makeAuthorizeSystemActor } from '../system-assistant/assemble.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { getPgActionReceipt, withPgActionReceipt } from '../system-assistant/pgReceipts.js'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test')
if (!['127.0.0.1','localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('isolated local test database required')
const admin = new Pool({ connectionString: target.toString(), max: 1 })
after(async () => { await admin.end() })
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-origin', agentId: 'main' }
const principal: BrowserConfirmationPrincipal = { id: '765', role: 'user', accessJti: 'synthetic-jti', accessExpiresAt: 9999999999, refreshFamilyId: randomUUID(), refreshSessionId: '19' }
async function fixture(t: import('node:test').TestContext, mode: 'normal' | 'lost-reply' | 'rollback' = 'normal') {
 const schema = `oc_session_metadata_${randomUUID().replaceAll('-', '')}`
 await admin.query(`CREATE SCHEMA ${schema}`)
 const pool = new Pool({ connectionString: target.toString(), max: 6, options: `-c search_path=${schema}` })
 t.after(async () => { await closePool() })
 await pool.query(`CREATE TABLE users(id bigint PRIMARY KEY,role text,status text,deleted_at timestamptz);
 INSERT INTO users VALUES(765,'user','active',NULL);
 CREATE TABLE client_sessions(id text PRIMARY KEY,user_id text,title text,pinned int DEFAULT 0,updated_at bigint DEFAULT 100,deleted_at bigint,model_id text DEFAULT 'synthetic-model',project_id text,archived_at bigint,messages jsonb DEFAULT '[]');
 CREATE TABLE chat_projects(id text PRIMARY KEY,user_id text,deleted_at bigint);
 INSERT INTO client_sessions(id,user_id,title) VALUES('target','c:765','Original'),('other','c:8000000766','Foreign'),('deleted','c:765','Deleted');
 UPDATE client_sessions SET deleted_at=1 WHERE id='deleted';
 INSERT INTO chat_projects VALUES('project','c:765',NULL);`)
 await pool.query(readFileSync(new URL('../db/migrations/0327_system_action_receipts.sql', import.meta.url), 'utf8'))
 setPoolOverride(pool)
 const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-session-meta-ledger-')), 'ledger.sqlite'), key: randomBytes(32) })
 t.after(() => ledger.close())
 const effect = (a: SystemActor, e: import('@openclaude/storage').SystemActionExecution, work: Parameters<typeof withPgActionReceipt>[2]) => withPgActionReceipt(a, e, async runner => {
   const result = await work(runner)
   if (mode === 'rollback') throw new SystemOperationRejected('CONFLICT')
   return result
 }, mode === 'lost-reply' ? { async connect() { const client = await pool.connect(); return { query: async (sql: string, params?: unknown[]) => { const result = await client.query(sql, params); if (sql === 'COMMIT') throw new Error('synthetic committed reply loss'); return result }, release: (discard?: boolean) => client.release(discard) } as unknown as PoolClient } } : pool)
 const registry = new SystemOperationRegistry(sessionMetadataOperations({ pgSessionsReady: true, authorize: makeAuthorizeSystemActor(pool), effect }))
 const service = new SystemActionsService(ledger, registry, randomUUID(), b => getPgActionReceipt(b, pool))
 async function proposal(patch: { title?: string; pinned?: boolean } = { title: 'Approved' }, sessionId = 'target') {
  const action = await service.prepare(actor, 'sessions.metadata.update', { sessionId, patch }, randomUUID())
  const detail = service.detail('765', action.id)
  const deviceId = randomUUID()
  const { nonce } = service.challenge(principal, action.id, deviceId, detail.previewHash)
  return { id: action.id, proof: { nonce, deviceId, previewHash: detail.previewHash } }
 }
 const row = async () => (await pool.query("SELECT title,pinned,updated_at::text AS updated_at,xmin::text AS version,model_id,project_id,archived_at,messages FROM client_sessions WHERE id='target'")).rows[0]
 const receipts = async () => (await pool.query('SELECT count(*)::int AS n FROM system_action_receipts')).rows[0].n as number
 return { pool, ledger, service, proposal, row, receipts }
}
test('approved own metadata and receipt commit together without touching messages/model/runtime', async t => {
 const f = await fixture(t)
 const p = await f.proposal({ title: 'Approved', pinned: true })
 assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'succeeded')
 const row = await f.row()
 assert.equal(row.title, 'Approved'); assert.equal(row.pinned, 1); assert(Number(row.updated_at) > 100)
 assert.equal(row.model_id, 'synthetic-model'); assert.deepEqual(row.messages, []); assert.equal(row.project_id, null); assert.equal(row.archived_at, null)
 assert.equal(await f.receipts(), 1)
})
test('missing, foreign and soft-deleted targets share not-found and never create a proposal', async t => {
 const f = await fixture(t)
 for (const id of ['missing','other','deleted']) await assert.rejects(f.proposal({ title: 'Denied' }, id))
 assert.equal((await f.row()).title, 'Original'); assert.equal(await f.receipts(), 0)
})
test('xmin catches a concurrent write even if its timestamp was not advanced', async t => {
 const f = await fixture(t); const p = await f.proposal()
 await f.pool.query("UPDATE client_sessions SET pinned=1 WHERE id='target'")
 assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'failed')
 assert.equal((await f.row()).title, 'Original'); assert.equal(await f.receipts(), 0)
})
test('a failure after the business update rolls back both metadata and receipt', async t => {
 const f = await fixture(t, 'rollback'); const before = await f.row(); const p = await f.proposal()
 assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'failed')
 assert.deepEqual(await f.row(), before); assert.equal(await f.receipts(), 0)
})
test('a confirmed no-op has an exact receipt and does not bump the session row version', async t => {
 const f = await fixture(t); const before = await f.row(); const p = await f.proposal({ title: 'Original', pinned: false })
 assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'succeeded')
 assert.deepEqual(await f.row(), before); assert.equal(await f.receipts(), 1)
})
test('two proposals at the same row version cannot both overwrite the target', async t => {
 const f = await fixture(t); const a = await f.proposal({ title: 'First' }); const b = await f.proposal({ title: 'Second' })
 const results = await Promise.allSettled([f.service.confirm(principal, a.id, a.proof), f.service.confirm(principal, b.id, b.proof)])
 assert.equal(results.filter(r => r.status === 'fulfilled' && (r.value as { state: string }).state === 'succeeded').length, 1)
 assert.equal(await f.receipts(), 1)
})
test('lost COMMIT reply reconciles the exact durable receipt without another update', async t => {
 const f = await fixture(t, 'lost-reply'); const p = await f.proposal()
 assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'unknown')
 const committed = await f.row()
 assert.equal((await f.service.reconcile('765', p.id)).state, 'succeeded')
 assert.deepEqual(await f.row(), committed); assert.equal(await f.receipts(), 1)
})
test('legacy mixed metadata remains one transaction with project validation and monotonic time', async t => {
 const f = await fixture(t)
 const client = await f.pool.connect()
 try {
  await client.query('BEGIN')
  const ok = await patchSessionMetadataInTx(client, 'target', 'c:765', { title: 'Mixed', pinned: true, modelId: 'synthetic-next', projectId: 'project', archived: true })
  assert.equal(ok.ok, true); await client.query('COMMIT')
  const current = await f.row()
  assert.equal(current.title, 'Mixed'); assert.equal(current.pinned, 1); assert.equal(current.model_id, 'synthetic-next'); assert.equal(current.project_id, 'project'); assert(current.archived_at)
  await client.query('BEGIN')
  const bad = await patchSessionMetadataInTx(client, 'target', 'c:765', { title: 'Must not apply', projectId: 'missing' })
  assert.deepEqual(bad, { ok: false, error: 'project_not_found' }); await client.query('ROLLBACK')
  assert.deepEqual(await f.row(), current)
 } finally { client.release() }
})

test('browser metadata GET is a pure owned point-read, preserves GitHub fallback and rejects inactive accounts', async t => {
 const f = await fixture(t); const before = await f.row()
 const secret = randomBytes(32)
 const deps = { jwtSecret: secret, sessionMetadataRead: (owner: string, id: string) => readSessionMetadata(owner,id,f.pool) } as unknown as CommercialHttpDeps
 let fallbackCalls = 0
 const server = createServer((req,res) => { void dispatchSessionMetadataRead(req,res,{} as RequestContext,deps,async () => { fallbackCalls++; res.writeHead(418); res.end('legacy-route') }).catch(error => { res.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: error.code ?? 'ERROR' })) }) })
 await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
 t.after(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())))
 const address = server.address(); assert(address && typeof address !== 'string')
 const base = `http://127.0.0.1:${address.port}`
 const { token } = await signAccess({ sub: '765', role: 'user' }, secret)
 const headers = { Authorization: `Bearer ${token}` }
 const ok = await fetch(`${base}/api/me/sessions/target/metadata`, { headers })
 assert.equal(ok.status,200); assert.deepEqual(await ok.json(), { id: 'target', title: 'Original', pinned: false, updatedAt: 100 })
 for (const id of ['missing','other','deleted']) assert.equal((await fetch(`${base}/api/me/sessions/${id}/metadata`, { headers })).status,404)
 assert.equal((await fetch(`${base}/api/me/sessions/target/metadata`)).status,401)
 assert.equal((await fetch(`${base}/api/me/sessions/target/github-selection`)).status,418); assert.equal(fallbackCalls,1)
 await f.pool.query("UPDATE users SET status='banned' WHERE id=765")
 assert.equal((await fetch(`${base}/api/me/sessions/target/metadata`, { headers })).status,403)
 assert.deepEqual(await f.row(),before); assert.equal(await f.receipts(),0)
})
