// OCV5-377 (commercial uid 1870 since 10-08, uid 4 on 10-11): the container
// received a recovery dispatch and refused it (IDLE_HISTORY_PENDING), so the
// dispatch ended not_accepted and no tape was written. Only a sealed tape
// settles a forwarded job, and a user Stop cancels only queued/leased/sent:
// the job stayed forwarded and the turn read "retrying" forever.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  pauseRecoveryForRefusal,
  pauseRecoveryJobsForRefusedDispatches,
  pauseRecoveryPreReceipt,
  releaseRecoveryPreReceipt,
} from '../dispatch/turnRecoveryStore.js'

const url = process.env.TEST_DATABASE_URL
test('a forwarded recovery job whose dispatch ended not_accepted is paused, nothing else',
  { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid NOT NULL,
      attempt_no integer NOT NULL, status text NOT NULL, outcome text, PRIMARY KEY (dispatch_id, attempt_no))`)
    await client.query(`CREATE TEMP TABLE turn_recovery_jobs (job_id text PRIMARY KEY, status text NOT NULL,
      dispatch_id uuid, dispatch_attempt_no integer, pause_reason text, terminal_outcome text,
      lease_owner text, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`)
    const q = { query: (sql: string, params: unknown[] = []) => client.query(sql, params) }
    const d = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    await client.query(`INSERT INTO turn_dispatches VALUES
      ($1,1,'terminal','not_accepted'), ($2,1,'terminal','completed'), ($3,1,'accepted',NULL),
      ($4,1,'terminal','not_accepted'), ($5,2,'terminal','not_accepted')`, [d(1), d(2), d(3), d(4), d(5)])
    await client.query(`INSERT INTO turn_recovery_jobs (job_id,status,dispatch_id,dispatch_attempt_no) VALUES
      ('refused','forwarded',$1,1), ('ran','forwarded',$2,1), ('running','forwarded',$3,1),
      ('sent','sent',$4,1), ('other-attempt','forwarded',$5,1)`, [d(1), d(2), d(3), d(4), d(5)])
    assert.equal(await pauseRecoveryJobsForRefusedDispatches(q as never), 1)
    const rows = await client.query(`SELECT job_id,status,pause_reason,terminal_outcome FROM turn_recovery_jobs ORDER BY job_id`)
    assert.deepEqual(rows.rows, [
      { job_id: 'other-attempt', status: 'forwarded', pause_reason: null, terminal_outcome: null },
      { job_id: 'ran', status: 'forwarded', pause_reason: null, terminal_outcome: null },
      { job_id: 'refused', status: 'paused', pause_reason: 'dispatch_not_accepted', terminal_outcome: 'interrupted' },
      { job_id: 'running', status: 'forwarded', pause_reason: null, terminal_outcome: null },
      { job_id: 'sent', status: 'sent', pause_reason: null, terminal_outcome: null },
    ])
    assert.equal(await pauseRecoveryJobsForRefusedDispatches(q as never), 0, 'idempotent')
  } finally { client.release(); await pool.end() }
})

// OCV5-391 (commercial uid 4, 2026-10-13): a recovery job for the retired kimi-k3-ark was
// refused (UNAUTHORIZED_MODEL) and re-queued every 5 minutes for two months. A definitive
// refusal now pauses the job: unbound under its lease fence, bound together with its dispatch.
test('a refused recovery job pauses (with its admitted dispatch when bound); fences hold; release still re-queues',
  { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY, status text NOT NULL,
      outcome text, failure_code text, owner_id text, lease_epoch bigint NOT NULL, lease_until timestamptz,
      terminal_at timestamptz, last_attempt_at timestamptz)`)
    await client.query(`CREATE TEMP TABLE turn_recovery_jobs (job_id text PRIMARY KEY, status text NOT NULL,
      lease_owner text, lease_epoch bigint NOT NULL, lease_until timestamptz, dispatch_id uuid,
      pause_reason text, terminal_outcome text, transport_wait_attempt integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`)
    const d = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    await client.query(`INSERT INTO turn_dispatches (dispatch_id,status,owner_id,lease_epoch) VALUES
      ($1,'admitted','bridge-1',3), ($2,'admitted','bridge-1',3), ($3,'admitted','bridge-1',3)`, [d(1), d(2), d(3)])
    await client.query(`INSERT INTO turn_recovery_jobs (job_id,status,lease_owner,lease_epoch,dispatch_id) VALUES
      ('unbound','leased','master-a',7,NULL), ('unbound-stale','leased','master-a',8,NULL),
      ('bound','leased','master-a',7,$1), ('bound-wrong-owner','leased','master-a',7,$2),
      ('bound-transient','leased','master-a',7,$3)`, [d(1), d(2), d(3)])
    const db = client as never
    const job = (jobId: string) => ({ jobId, leaseOwner: 'master-a', leaseEpoch: 7, transportWaitAttempt: 0 })

    assert.equal(await pauseRecoveryForRefusal(db, job('unbound'), 'UNAUTHORIZED_MODEL'), true)
    assert.equal(await pauseRecoveryForRefusal(db, job('unbound-stale'), 'UNAUTHORIZED_MODEL'), false, 'lost lease')
    assert.equal(await pauseRecoveryForRefusal(db, job('bound'), 'MODEL_NOT_AVAILABLE'), false,
      'a bound job is left to the pre-forward exit')
    assert.equal(await pauseRecoveryPreReceipt(db, { job: job('bound'), dispatchId: d(1), dispatchOwner: 'bridge-1',
      dispatchLeaseEpoch: 3, reason: 'MODEL_NOT_AVAILABLE' }), true)
    assert.equal(await pauseRecoveryPreReceipt(db, { job: job('bound-wrong-owner'), dispatchId: d(2),
      dispatchOwner: 'bridge-2', dispatchLeaseEpoch: 3, reason: 'MODEL_NOT_AVAILABLE' }), false, 'dispatch fence')
    assert.equal(await releaseRecoveryPreReceipt(db, { job: job('bound-transient'), dispatchId: d(3),
      dispatchOwner: 'bridge-1', dispatchLeaseEpoch: 3 }), true)

    const jobs = await client.query(`SELECT job_id,status,pause_reason,terminal_outcome,transport_wait_attempt
      FROM turn_recovery_jobs ORDER BY job_id`)
    assert.deepEqual(jobs.rows, [
      { job_id: 'bound', status: 'paused', pause_reason: 'refused:MODEL_NOT_AVAILABLE', terminal_outcome: 'interrupted', transport_wait_attempt: 0 },
      { job_id: 'bound-transient', status: 'queued', pause_reason: null, terminal_outcome: null, transport_wait_attempt: 1 },
      { job_id: 'bound-wrong-owner', status: 'leased', pause_reason: null, terminal_outcome: null, transport_wait_attempt: 0 },
      { job_id: 'unbound', status: 'paused', pause_reason: 'refused:UNAUTHORIZED_MODEL', terminal_outcome: 'interrupted', transport_wait_attempt: 0 },
      { job_id: 'unbound-stale', status: 'leased', pause_reason: null, terminal_outcome: null, transport_wait_attempt: 0 },
    ])
    const dispatches = await client.query(`SELECT dispatch_id::text AS id,status,outcome,failure_code,
      terminal_at IS NOT NULL AS ended FROM turn_dispatches ORDER BY dispatch_id`)
    assert.deepEqual(dispatches.rows, [
      { id: d(1), status: 'terminal', outcome: 'not_accepted', failure_code: 'refused:MODEL_NOT_AVAILABLE', ended: true },
      { id: d(2), status: 'admitted', outcome: null, failure_code: null, ended: false },
      { id: d(3), status: 'admitted', outcome: null, failure_code: null, ended: false },
    ])
  } finally { client.release(); await pool.end() }
})
