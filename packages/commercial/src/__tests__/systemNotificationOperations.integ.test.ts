/** Private synthetic schemas only. Exact approved inbox writes and their real PG receipts. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { SystemActionStore } from '@openclaude/storage'
import { setPoolOverride, closePool } from '../db/index.js'
import { notificationOperations } from '../system-assistant/notificationOperations.js'
import { makeAuthorizeSystemActor } from '../system-assistant/assemble.js'
import { SystemOperationRegistry, type SystemActor } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { getPgActionReceipt, withPgActionReceipt } from '../system-assistant/pgReceipts.js'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test')
if (!['127.0.0.1','localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('isolated local test database required')
const admin = new Pool({ connectionString: target.toString(), max: 1 })
after(async () => { await admin.end() })
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const principal: BrowserConfirmationPrincipal = { id: '765', role: 'user', accessJti: 'synthetic-jti', accessExpiresAt: 9999999999, refreshFamilyId: randomUUID(), refreshSessionId: '19' }
async function fixture(t: import('node:test').TestContext, loseReply = false) {
  const schema = `oc_notification_approval_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: target.toString(), max: 6, options: `-c search_path=${schema}` })
  t.after(async () => { await closePool() }) // Retain this unique fixture schema.
  await pool.query(`CREATE TABLE users(id bigint PRIMARY KEY,role text,status text,deleted_at timestamptz,created_at timestamptz);
    INSERT INTO users VALUES(765,'user','active',NULL,now()-interval '1 day');
    CREATE TABLE inbox_messages(id bigserial PRIMARY KEY,audience text,user_id bigint,title text,body_md text,created_at timestamptz DEFAULT now(),expires_at timestamptz);
    CREATE TABLE inbox_message_reads(user_id bigint,message_id bigint REFERENCES inbox_messages(id) ON DELETE CASCADE,read_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,message_id));`)
  await pool.query(readFileSync(new URL('../db/migrations/0327_system_action_receipts.sql', import.meta.url), 'utf8'))
  setPoolOverride(pool)
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-notification-ledger-')), 'ledger.sqlite'), key: randomBytes(32) })
  t.after(() => ledger.close())
  const effect = (a: SystemActor, e: import('@openclaude/storage').SystemActionExecution, work: Parameters<typeof withPgActionReceipt>[2]) => withPgActionReceipt(a, e, work,
    loseReply ? { async connect() { const client = await pool.connect(); return { query: async (sql: string, params?: unknown[]) => { const result = await client.query(sql, params); if (sql === 'COMMIT') throw new Error('synthetic lost committed reply'); return result }, release: (discard?: boolean) => client.release(discard) } as unknown as PoolClient } } : pool)
  const registry = new SystemOperationRegistry(notificationOperations({ authorize: makeAuthorizeSystemActor(pool), effect }))
  const service = new SystemActionsService(ledger, registry, randomUUID(), b => getPgActionReceipt(b, pool))
  async function add(opts: { userId?: string; audience?: string; created?: string; expires?: string } = {}) {
    const r = await pool.query(`INSERT INTO inbox_messages(audience,user_id,title,body_md,created_at,expires_at) VALUES($1,$2,'Synthetic notification','Synthetic body',COALESCE($3::timestamptz,now()),$4) RETURNING id::text`, [opts.audience ?? 'user', opts.userId ?? '765', opts.created ?? null, opts.expires ?? null])
    return r.rows[0].id as string
  }
  async function proposal(operation = 'notifications.read-all', args: unknown = {}) {
    const action = await service.prepare(actor, operation, args, randomUUID())
    const detail = service.detail('765', action.id)
    const deviceId = randomUUID()
    const { nonce } = service.challenge(principal, action.id, deviceId, detail.previewHash)
    return { id: action.id, proof: { nonce, deviceId, previewHash: detail.previewHash } }
  }
  const readIds = async () => (await pool.query('SELECT message_id::text AS id FROM inbox_message_reads ORDER BY message_id')).rows.map(r => r.id as string)
  return { pool, ledger, service, add, proposal, readIds }
}
test('read-all freezes only currently visible unread IDs and later arrivals remain unread', async t => {
  const f = await fixture(t)
  const own = await f.add()
  const broadcast = await f.add({ audience: 'all' })
  await f.add({ userId: '8000000766' }); await f.add({ audience: 'all', created: '2020-01-01T00:00:00Z' }); await f.add({ expires: '2020-01-01T00:00:00Z' })
  const p = await f.proposal()
  const later = await f.add()
  assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'succeeded')
  assert.deepEqual(await f.readIds(), [own, broadcast]); assert(!(await f.readIds()).includes(later))
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM system_action_receipts')).rows[0].n, 1)
})
test('single mark-read enforces own visibility and already-read remains an idempotent noop', async t => {
  const f = await fixture(t)
  const own = await f.add()
  const other = await f.add({ userId: '8000000766' })
  await assert.rejects(f.proposal('notifications.mark-read', { messageId: other }))
  for (let i = 0; i < 2; i++) { const p = await f.proposal('notifications.mark-read', { messageId: own }); assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'succeeded') }
  assert.deepEqual(await f.readIds(), [own])
})
test('message version drift aborts the entire frozen batch and its receipt', async t => {
  const f = await fixture(t); await f.add(); const changed = await f.add()
  const p = await f.proposal()
  await f.pool.query("UPDATE inbox_messages SET body_md='Synthetic revised body' WHERE id=$1", [changed])
  assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'failed')
  assert.deepEqual(await f.readIds(), [])
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM system_action_receipts')).rows[0].n, 0)
})
for (const mutation of ['delete','expire']) test(`${mutation} of an approved message cannot leave partial read markers`, async t => {
  const f = await fixture(t); await f.add(); const changed = await f.add()
  const p = await f.proposal()
  await f.pool.query(mutation === 'delete' ? 'DELETE FROM inbox_messages WHERE id=$1' : "UPDATE inbox_messages SET expires_at=now()-interval '1 second' WHERE id=$1", [changed])
  assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'failed')
  assert.deepEqual(await f.readIds(), [])
})
test('duplicate confirmation commits one inbox effect and one positive receipt', async t => {
  const f = await fixture(t); const own = await f.add()
  const p = await f.proposal()
  await Promise.all([f.service.confirm(principal, p.id, p.proof), f.service.confirm(principal, p.id, p.proof)])
  assert.deepEqual(await f.readIds(), [own])
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM system_action_receipts')).rows[0].n, 1)
})
test('lost COMMIT reply keeps unknown until this exact receipt restores success without another inbox write', async t => {
  const f = await fixture(t, true); const own = await f.add()
  const p = await f.proposal()
  assert.equal((await f.service.confirm(principal, p.id, p.proof) as { state: string }).state, 'unknown')
  assert.deepEqual(await f.readIds(), [own])
  const readAt = (await f.pool.query('SELECT read_at::text AS value FROM inbox_message_reads')).rows[0].value
  assert.equal((await f.service.reconcile('765', p.id)).state, 'succeeded')
  assert.equal((await f.pool.query('SELECT read_at::text AS value FROM inbox_message_reads')).rows[0].value, readAt)
})
