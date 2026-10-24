/** Real commits/rollbacks in one new private schema. No shared resets or product account access. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import { setPoolOverride, closePool } from '../db/index.js'
import { makeAuthorizeSystemActor } from '../system-assistant/assemble.js'
import { preferenceOperations } from '../system-assistant/preferenceOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { getPgActionReceipt, withPgActionReceipt, PgActionOutcomeUnknown } from '../system-assistant/pgReceipts.js'
import { getVersionedPreferences, patchPreferences } from '../user/preferences.js'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test')
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('isolated local test database required')
const schema = `oc_system_receipts_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: target.toString(), max: 1 })
const pool = new Pool({ connectionString: target.toString(), max: 8, options: `-c search_path=${schema}` })
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const principal: BrowserConfirmationPrincipal = { id: '765', role: 'user', accessJti: 'synthetic-jti', accessExpiresAt: 9999999999, refreshFamilyId: randomUUID(), refreshSessionId: '19' }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query("CREATE TABLE users (id bigint PRIMARY KEY,role text NOT NULL,status text NOT NULL,deleted_at timestamptz)")
  await pool.query("INSERT INTO users VALUES(765,'user','active',NULL)")
  await pool.query('CREATE TABLE user_preferences (user_id bigint PRIMARY KEY,prefs jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())')
  await pool.query('CREATE TABLE receipt_effect_counter (id integer PRIMARY KEY,n integer NOT NULL)')
  await pool.query('INSERT INTO receipt_effect_counter VALUES(1,0)')
  await pool.query(readFileSync(new URL('../db/migrations/0327_system_action_receipts.sql', import.meta.url), 'utf8'))
  setPoolOverride(pool)
})
after(async () => { await closePool(); await admin.end() }) // Retain the uniquely named proof schema.
type Effect = NonNullable<Parameters<typeof preferenceOperations>[0]['effect']>
const normalEffect: Effect = (a, e, work) => withPgActionReceipt(a, e, work, pool)
function fixture(t: import('node:test').TestContext, effect: Effect = normalEffect) {
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-system-receipt-')), 'ledger.sqlite'), key: randomBytes(32) })
  t.after(() => ledger.close())
  const registry = new SystemOperationRegistry(preferenceOperations({ authorize: makeAuthorizeSystemActor(pool), privacySupported: async () => true, effect }))
  const service = new SystemActionsService(ledger, registry, randomUUID(), binding => getPgActionReceipt(binding, pool))
  async function proposal(notifyEmail: boolean) {
    const action = await service.prepare(actor, 'preferences.update', { notify_email: notifyEmail }, randomUUID())
    const detail = service.detail('765', action.id)
    const deviceId = randomUUID()
    const { nonce } = service.challenge(principal, action.id, deviceId, detail.previewHash)
    return { id: action.id, proof: { nonce, deviceId, previewHash: detail.previewHash } }
  }
  return { ledger, registry, service, proposal }
}
function loseCommittedReply(): Pick<Pool, 'connect'> {
  return { async connect() {
    const client = await pool.connect()
    return { query: async (sql: string, params?: unknown[]) => {
      const response = await client.query(sql, params)
      if (sql === 'COMMIT') throw new Error('synthetic reply lost after actual PG commit')
      return response
    }, release: (discard?: boolean) => client.release(discard) } as unknown as PoolClient
  } } as unknown as Pick<Pool, 'connect'>
}
test('lost COMMIT reply leaves unknown, then exact positive receipt restores success without another preference write', async t => {
  const f = fixture(t, (a, e, work) => withPgActionReceipt(a, e, work, loseCommittedReply()))
  const p = await f.proposal(false)
  const response = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in response && response.state, 'unknown')
  const written = await getVersionedPreferences('765')
  assert.equal(written.prefs.notify_email, false)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM system_action_receipts WHERE action_id=$1', [p.id])).rows[0].n, 1)
  assert.equal(f.ledger.detail('765', p.id).preview, null)
  assert.equal((await f.service.reconcile('765', p.id)).state, 'succeeded')
  assert.equal((await getVersionedPreferences('765')).version, written.version)
  await f.service.confirm(principal, p.id, p.proof)
  assert.equal((await getVersionedPreferences('765')).version, written.version)
  assert.equal(f.ledger.unknownReceiptBinding('765', p.id), null)
})
test('an acknowledged rollback removes both the actual preference mutation and its receipt', async t => {
  await patchPreferences('765', { notify_email: true })
  const before = await getVersionedPreferences('765')
  const f = fixture(t, (a, e, work) => withPgActionReceipt(a, e, async runner => {
    await work(runner)
    throw new SystemOperationRejected('CONFLICT')
  }, pool))
  const p = await f.proposal(false)
  const response = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in response && response.state, 'failed')
  assert.equal((await getVersionedPreferences('765')).version, before.version)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM system_action_receipts WHERE action_id=$1', [p.id])).rows[0].n, 0)
})
test('matching current preference values without this action receipt cannot clear unknown or its resource fence', async t => {
  const f = fixture(t, async () => { throw new PgActionOutcomeUnknown() })
  const p = await f.proposal(false)
  await f.service.confirm(principal, p.id, p.proof)
  await patchPreferences('765', { notify_email: false }) // A separate explicit human mutation in this private fixture.
  assert.equal((await f.service.reconcile('765', p.id)).state, 'unknown')
  assert.equal((await getVersionedPreferences('765')).prefs.notify_email, false)
  await assert.rejects(f.service.prepare(actor, 'preferences.update', { notify_email: true }, randomUUID()), e => e instanceof Error && e.message === 'RECONCILIATION_REQUIRED')
})
test('concurrent duplicate PG workers commit one effect and one positive receipt', async t => {
  const f = fixture(t)
  const p = await f.service.prepare(actor, 'preferences.update', { notify_email: false }, randomUUID())
  const detail = f.service.detail('765', p.id)
  const proof = { deviceId: 'synthetic-device', previewHash: detail.previewHash,
    nonce: f.ledger.issueChallenge('765', p.id, 'synthetic-device', detail.previewHash) }
  const claim = f.ledger.confirm('765', p.id, proof, randomUUID())
  assert('executionNonce' in claim)
  const effect = async (runner: import('../db/queries.js').QueryRunner) => {
    await runner.query('UPDATE receipt_effect_counter SET n=n+1 WHERE id=1')
    return { summary: 'committed once', completion: 'done' as const }
  }
  const values = await Promise.all([withPgActionReceipt(actor, claim, effect, pool), withPgActionReceipt(actor, claim, effect, pool)])
  assert.deepEqual(values[0], values[1])
  assert.equal((await pool.query('SELECT n FROM receipt_effect_counter WHERE id=1')).rows[0].n, 1)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM system_action_receipts WHERE action_id=$1', [p.id])).rows[0].n, 1)
  f.ledger.finish(claim, 'succeeded', values[0]!)
})
test('receipt binding, fresh account status and historical ownership govern reads', async () => {
  const row = (await pool.query('SELECT * FROM system_action_receipts ORDER BY committed_at LIMIT 1')).rows[0]
  const binding = { id: String(row.action_id), userId: String(row.user_id), sessionId: String(row.session_id), agentId: String(row.agent_id),
    operationId: String(row.operation_id), operationVersion: Number(row.operation_version), requestHash: String(row.request_hash), inputHash: String(row.input_hash) }
  await assert.rejects(getPgActionReceipt({ ...binding, inputHash: 'f'.repeat(64) }, pool), PgActionOutcomeUnknown)
  await pool.query("UPDATE users SET role='admin' WHERE id=765")
  assert.equal((await getPgActionReceipt(binding, pool))?.completion, 'done')
  await pool.query("UPDATE users SET status='disabled' WHERE id=765")
  try { await assert.rejects(getPgActionReceipt(binding, pool), e => e instanceof SystemOperationRejected && e.code === 'FORBIDDEN') }
  finally { await pool.query("UPDATE users SET role='user',status='active' WHERE id=765") }
})

test('receipt ACL hardens the actual migration owner without relying on a separately named application role', async () => {
  const rows = await pool.query<{ privilege_type: string }>(`SELECT acl.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE n.nspname=current_schema() AND c.relname='system_action_receipts'
      AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    ORDER BY acl.privilege_type`)
  assert.deepEqual(rows.rows.map(row => row.privilege_type), ['INSERT','SELECT'])
})
