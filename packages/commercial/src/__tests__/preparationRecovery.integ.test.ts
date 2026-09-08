import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, beforeEach, test } from 'node:test'
import { Pool } from 'pg'
import { canonicalDigestHex } from '../connectors/canonicalJson.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import { freezePreparationRequest } from '../dispatch/preparationRecovery.js'
import { claimDueRecoveryJobs, forwardRecoveryUnderRootFence, releasePreparationPreReceipt } from '../dispatch/turnRecoveryStore.js'
import { admitDurableControl } from '../dispatch/turnControlStore.js'

// Fail-loud real PG fixture. This never falls back to a live/production URL.
const url = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const schema = `oc_preparation_${process.pid}`
let pool: Pool
let sourceId: string
const sourceMessage = 'm-preparation-source-001'
const source = { type: 'inbound.message',channel: 'webchat',peer: { id: 'preparation-session',kind: 'dm' },
  agentId: 'main',model: 'cursor-opus-5-high',effortLevel: 'high',contextTier: '1m',teamMode: true,
  modelSwitchId: 'switch-1',clientMessageId: sourceMessage,idempotencyKey: 'source-key',ts: 100,
  content: { text: 'exact request',replyTo: { messageId: 'quoted',text: 'exact quote' },
    media: [{ kind: 'image',url: '/api/media/source.png' }] } }

before(async () => {
  assert.equal(new URL(url).pathname, '/openclaude_test', 'only isolated test database allowed')
  const admin = new Pool({ connectionString: url,connectionTimeoutMillis: 2000 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  pool = new Pool({ connectionString: url,options: `-c search_path=${schema}`,max: 6 })
  await pool.query(`CREATE TABLE client_sessions (id text PRIMARY KEY,user_id text,messages text,
    deleted_at timestamptz,history_revision bigint DEFAULT 0,timeline_generation bigint DEFAULT 0,updated_at bigint DEFAULT 0);
    CREATE TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,client_message_id text,
      attempt_no integer DEFAULT 1,lease_epoch bigint DEFAULT 1,owner_id text,lease_until timestamptz,
      status text DEFAULT 'admitted',accepted_at timestamptz,admitted_at timestamptz DEFAULT NOW(),
      last_attempt_at timestamptz,terminal_at timestamptz,outcome text,failure_code text);
    CREATE TABLE client_session_turn_tapes (session_id text,user_id text,client_message_id text);`)
  for (const name of ['0202_turn_recovery_control','0279_preparation_recovery_origin']) {
    await pool.query(await readFile(new URL(`../db/migrations/${name}.sql`,import.meta.url),'utf8'))
  }
})
after(async () => {
  if (pool) await pool.end()
  const admin = new Pool({ connectionString: url })
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
})
beforeEach(async () => {
  await pool.query('TRUNCATE turn_recovery_jobs,turn_control_requests,turn_dispatches,client_sessions')
  sourceId = randomUUID()
  await pool.query(`INSERT INTO client_sessions(id,user_id,messages) VALUES ('preparation-session','c:7',$1)`,
    [JSON.stringify([{ id: sourceMessage,role: 'user',text: 'exact request' }])])
  const snapshot = freezePreparationRequest(source)!
  assert.ok(snapshot)
  await pool.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,owner_id,
    preparation_request_json,preparation_request_sha256) VALUES ($1,7,'preparation-session',$2,'owner',$3::jsonb,$4)`,
  [sourceId,sourceMessage,JSON.stringify(snapshot),canonicalDigestHex(snapshot)])
})
function backend(writer = true) {
  return createPgSessionsBackend(pool,{ expectedGeneration: 1,testPreparationRecoveryWriter: writer })
}
function failInput() {
  return { uid: 7n,sessionId: 'preparation-session',clientMessageId: sourceMessage,
    dispatchId: sourceId,attemptNo: 1,ownerId: 'owner',leaseEpoch: 1 }
}
async function child() {
  assert.equal((await backend().failPreparationAndScheduleRecovery(failInput())).kind,'scheduled')
  await pool.query(`UPDATE turn_recovery_jobs SET next_attempt_at=NOW()`)
  const [job] = await claimDueRecoveryJobs(pool,{ userId: 7n,ownerId: 'scheduler',leaseMs: 30000 })
  assert.ok(job)
  const id = randomUUID()
  await pool.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,owner_id)
    VALUES ($1,7,'preparation-session',$2,'child-owner')`,[id,job.request.clientMessageId])
  await pool.query(`UPDATE turn_recovery_jobs SET dispatch_id=$1,dispatch_attempt_no=1 WHERE job_id=$2`,[id,job.jobId])
  await pool.query(`UPDATE client_sessions SET messages=$1`,[JSON.stringify([{ id: sourceMessage,role: 'user' },
    { id: job.request.clientMessageId,role: 'user' }])])
  return { job,dispatchId: id,dispatchAttemptNo: 1,dispatchOwner: 'child-owner',dispatchLeaseEpoch: 1 }
}

test('R0 build writer is closed; exact owner source failure and job become one committed fact',async () => {
  assert.equal((await backend(false).failPreparationAndScheduleRecovery(failInput())).kind,'not_eligible')
  const results = await Promise.all([backend().failPreparationAndScheduleRecovery(failInput()),backend().failPreparationAndScheduleRecovery(failInput())])
  assert.equal(results.filter((result) => result.kind === 'scheduled').length,1)
  const row = (await pool.query(`SELECT d.status,d.outcome,j.job_origin,j.request_json,j.source_turn_key,j.tape_sha256,
    c.history_revision FROM turn_dispatches d JOIN turn_recovery_jobs j ON j.source_dispatch_id=d.dispatch_id
    JOIN client_sessions c ON c.id=j.session_id`)).rows[0]
  assert.equal(row.status,'terminal'); assert.equal(row.outcome,'not_accepted')
  assert.equal(row.job_origin,'pre_transfer_enrichment'); assert.equal(row.source_turn_key,null); assert.equal(row.tape_sha256,null)
  assert.equal(row.request_json.contextTier,'1m'); assert.equal(row.request_json.teamMode,true)
  assert.deepEqual(row.request_json.content.media,source.content.media)
  assert.ok(Number(row.history_revision)>0)
})

test('accepted source or takeover epoch cannot enqueue a new execution',async () => {
  await pool.query(`UPDATE turn_dispatches SET accepted_at=NOW()`)
  assert.equal((await backend().failPreparationAndScheduleRecovery(failInput())).kind,'lost_ownership')
  assert.equal((await backend().failPreparationAndScheduleRecovery({...failInput(),leaseEpoch: 2})).kind,'not_eligible')
  assert.equal((await pool.query('SELECT count(*) FROM turn_recovery_jobs')).rows[0].count,'0')
})

test('two pure preparation failures reuse one child then terminate only that child',async () => {
  const input = await child()
  assert.equal(await releasePreparationPreReceipt(pool,{ ...input,failureCode: 'dispatch_enrichment_timeout' }),'queued')
  assert.equal((await pool.query('SELECT preparation_retry_count FROM turn_recovery_jobs')).rows[0].preparation_retry_count,1)
  await pool.query(`UPDATE turn_recovery_jobs SET next_attempt_at=NOW()`)
  const [again] = await claimDueRecoveryJobs(pool,{userId: 7n,ownerId: 'scheduler',leaseMs: 30000})
  assert.ok(again)
  await pool.query(`UPDATE turn_dispatches SET owner_id='child-owner' WHERE dispatch_id=$1`,[input.dispatchId])
  assert.equal(await releasePreparationPreReceipt(pool,{...input,job: again,failureCode: 'dispatch_enrichment_timeout'}),'exhausted')
  const terminal = (await pool.query('SELECT status,outcome,failure_code FROM turn_dispatches WHERE dispatch_id=$1',[input.dispatchId])).rows[0]
  assert.deepEqual(terminal,{status: 'terminal',outcome: 'not_accepted',failure_code: 'dispatch_preparation_retry_exhausted'})
  assert.equal((await pool.query('SELECT count(*) FROM turn_recovery_jobs')).rows[0].count,'1')
})

test('intent commits before send, survives send failure and prevents false not-executed cap',async () => {
  const input = await child()
  let sends = 0
  assert.equal(await forwardRecoveryUnderRootFence(pool,input,() => { sends++; return false } ),false)
  assert.equal(sends,1)
  assert.ok((await pool.query('SELECT preparation_send_intent_at FROM turn_recovery_jobs')).rows[0].preparation_send_intent_at)
  assert.equal(await releasePreparationPreReceipt(pool,{...input,failureCode: 'dispatch_enrichment_timeout'}),'unknown')
  const state = (await pool.query(`SELECT j.preparation_retry_count,d.status FROM turn_recovery_jobs j JOIN turn_dispatches d ON d.dispatch_id=j.dispatch_id`)).rows[0]
  assert.equal(state.preparation_retry_count,0); assert.equal(state.status,'admitted')
  await assert.rejects(pool.query('UPDATE turn_recovery_jobs SET preparation_send_intent_at=NULL'),/intent is immutable/)
})

test('origin check rejects counterfeit tape, nullable source attempt and incomplete snapshot',async () => {
  await child()
  await assert.rejects(pool.query(`UPDATE turn_recovery_jobs SET tape_sha256=$1`,['a'.repeat(64)]),/origin_check/)
  await assert.rejects(pool.query('UPDATE turn_recovery_jobs SET source_dispatch_attempt=NULL'),/origin_check/)
  await assert.rejects(pool.query('UPDATE turn_dispatches SET preparation_request_sha256=NULL WHERE dispatch_id=$1',[sourceId]),/snapshot_check/)
})

test('source scheduling rollback leaves neither a terminal source nor a detached job',async () => {
  await pool.query(`CREATE FUNCTION fail_preparation_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected visibility rollback'; END $$;
    CREATE TRIGGER visibility_failure BEFORE UPDATE ON client_sessions FOR EACH ROW EXECUTE FUNCTION fail_preparation_visibility()`)
  try {
    await assert.rejects(backend().failPreparationAndScheduleRecovery(failInput()),/injected visibility rollback/)
    assert.equal((await pool.query('SELECT status FROM turn_dispatches WHERE dispatch_id=$1',[sourceId])).rows[0].status,'admitted')
    assert.equal((await pool.query('SELECT count(*) FROM turn_recovery_jobs')).rows[0].count,'0')
  } finally {
    await pool.query('DROP TRIGGER visibility_failure ON client_sessions; DROP FUNCTION fail_preparation_visibility()')
  }
})

test('Stop after durable intent preserves unknown child; Stop before intent forbids physical send',async () => {
  const input = await child()
  assert.equal(await forwardRecoveryUnderRootFence(pool,input,() => false),false)
  await admitDurableControl(pool,{ controlId: 'stop-intent',userId: 7n,sessionId: 'preparation-session',
    rootClientMessageId: sourceMessage,kind: 'stop',payload: {} })
  assert.equal((await pool.query('SELECT status FROM turn_dispatches WHERE dispatch_id=$1',[input.dispatchId])).rows[0].status,'admitted')
  let sends = 0
  assert.equal(await forwardRecoveryUnderRootFence(pool,input,() => { sends++; return true }),false)
  assert.equal(sends,0)
})
