/** Real read-only PG scope queries in a new retained schema; no product account or shared reset. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import { resolveCurrentSystemHelpActor } from '../system-assistant/helpActor.js'
import { SystemHelpGrantError, type SystemHelpIdentityScope } from '../system-assistant/helpGrant.js'
const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test')
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('isolated local proof database required')
const schema = `oc_system_help_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: target.toString(), max: 1 })
const pool = new Pool({ connectionString: target.toString(), max: 4, options: `-c search_path=${schema}` })
const scope: SystemHelpIdentityScope = { uid: '765', containerId: '123', sessionId: 'synthetic-session', agentId: 'main', dispatchId: randomUUID(), attemptNo: 1, ownerId: randomUUID(), dispatchLeaseEpoch: '7' }
const identity = { userId: 765, containerId: 123 }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE users (id bigint PRIMARY KEY,role text,status text,deleted_at timestamptz);
    CREATE TABLE client_sessions (id text PRIMARY KEY,user_id text,deleted_at timestamptz);
    CREATE TABLE model_security_epoch (id boolean PRIMARY KEY,epoch bigint);
    CREATE TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,agent_id text,attempt_no integer,
      owner_id text,lease_epoch bigint,agent_container_id bigint,runtime_kind text,status text,terminal_at timestamptz,producer_fenced_at timestamptz,lease_until timestamptz);`)
  await pool.query("INSERT INTO users VALUES (765,'user','active',NULL)")
  await pool.query("INSERT INTO client_sessions VALUES ('synthetic-session','c:765',NULL)")
  await pool.query('INSERT INTO model_security_epoch VALUES (TRUE,12)')
  await pool.query(`INSERT INTO turn_dispatches VALUES ($1,765,'synthetic-session','main',1,$2,7,123,'docker','accepted',NULL,NULL,NOW()-INTERVAL '1 day')`, [scope.dispatchId, scope.ownerId])
})
after(async () => { await pool.end(); await admin.end() })
async function resolve(expectedEpoch?: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const result = await resolveCurrentSystemHelpActor(client, identity, scope, expectedEpoch)
    await client.query('COMMIT')
    return result
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}
const invalid = (e: unknown) => e instanceof SystemHelpGrantError && e.code === 'INVALID_CONTEXT'
test('canonical actor is derived in a read-only snapshot even after the 90-second bridge lease time', async () => {
  const actual = await resolve('12')
  assert.deepEqual(actual.actor, { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' })
  assert.equal(actual.scope.dispatchLeaseEpoch, '7')
  assert.equal(actual.scope.securityEpoch, '12')
})
test('current role is fresh; deletion, disabled status and session ownership changes all reject', async () => {
  await pool.query("UPDATE users SET role='admin' WHERE id=765")
  assert.equal((await resolve()).actor.role, 'admin')
  await pool.query("UPDATE users SET role='user',deleted_at=NOW() WHERE id=765")
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE users SET deleted_at=NULL,status='disabled' WHERE id=765")
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE users SET status='active' WHERE id=765")
  await pool.query("UPDATE client_sessions SET user_id='c:synthetic-other' WHERE id='synthetic-session'")
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE client_sessions SET user_id='c:765',deleted_at=NOW() WHERE id='synthetic-session'")
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE client_sessions SET deleted_at=NULL WHERE id='synthetic-session'")
})
test('same-attempt takeover cannot refresh the prior owner grant', async () => {
  await pool.query('UPDATE turn_dispatches SET owner_id=$1,lease_epoch=8 WHERE dispatch_id=$2', [randomUUID(), scope.dispatchId])
  await assert.rejects(resolve(), invalid)
  await pool.query('UPDATE turn_dispatches SET owner_id=$1,lease_epoch=7 WHERE dispatch_id=$2', [scope.ownerId, scope.dispatchId])
  assert.equal((await resolve()).scope.ownerId, scope.ownerId)
})
test('container/runtime mismatch, terminal and producer fencing are fail closed', async () => {
  await pool.query('UPDATE turn_dispatches SET agent_container_id=NULL WHERE dispatch_id=$1', [scope.dispatchId])
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE turn_dispatches SET agent_container_id=123,runtime_kind='desktop' WHERE dispatch_id=$1", [scope.dispatchId])
  await assert.rejects(resolve(), invalid)
  await pool.query("UPDATE turn_dispatches SET runtime_kind='docker',producer_fenced_at=NOW() WHERE dispatch_id=$1", [scope.dispatchId])
  await assert.rejects(resolve(), invalid)
  await pool.query('UPDATE turn_dispatches SET producer_fenced_at=NULL,terminal_at=NOW() WHERE dispatch_id=$1', [scope.dispatchId])
  await assert.rejects(resolve(), invalid)
  await pool.query('UPDATE turn_dispatches SET terminal_at=NULL WHERE dispatch_id=$1', [scope.dispatchId])
})
test('security epoch changes invalidate short grants while a valid original owner can refresh', async () => {
  await pool.query('UPDATE model_security_epoch SET epoch=13 WHERE id=TRUE')
  await assert.rejects(resolve('12'), invalid)
  assert.equal((await resolve()).scope.securityEpoch, '13')
})
