// OCV5-377 (commercial uid 1870 since 10-08, uid 4 on 10-11): the container
// received a recovery dispatch and refused it (IDLE_HISTORY_PENDING), so the
// dispatch ended not_accepted and no tape was written. Only a sealed tape
// settles a forwarded job, and a user Stop cancels only queued/leased/sent:
// the job stayed forwarded and the turn read "retrying" forever.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { pauseRecoveryJobsForRefusedDispatches } from '../dispatch/turnRecoveryStore.js'

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
