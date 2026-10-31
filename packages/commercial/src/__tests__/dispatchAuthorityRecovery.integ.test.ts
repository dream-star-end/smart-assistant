import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Pool } from 'pg'
import { scheduleUndeliveredDispatchRecovery } from '../db/pgSessionsBackend.js'
import { claimDueRecoveryJobs } from '../dispatch/turnRecoveryStore.js'
import { getTestDatabaseUrlForTempTables } from './helpers/db.js'

test('OCV5-682: a proven undelivered turn persists and claims exactly one fresh recovery job in PG', async () => {
  const url = getTestDatabaseUrlForTempTables()
  assert.match(new URL(url).pathname, /_test$/)
  const pool = new Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  try {
    const definitions = readFileSync(new URL('../db/migrations/0202_turn_recovery_control.sql', import.meta.url), 'utf8')
      .match(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\);/g)
    assert.equal(definitions?.length, 3)
    await client.query(definitions!.join('\n').replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'))
    await client.query(`CREATE TEMP TABLE client_sessions(id text,user_id text,messages text,deleted_at timestamptz);
      CREATE TEMP TABLE client_session_live_streams(stream_key text,session_id text,user_id text,client_message_id text);
      CREATE TEMP TABLE client_session_live_frames(stream_key text,payload bytea,record_id bigint)`)
    const source = { id: 'cm-682-pg', role: 'user', text: 'exact original request',
      _routing: { model: 'deepseek-v4-flash', effortLevel: 'high' } }
    await client.query(`INSERT INTO client_sessions VALUES ('session-682','c:3',$1,NULL)`, [JSON.stringify([source])])
    const row = { userId: 3n, sessionId: 'session-682', clientMessageId: source.id,
      dispatchId: '00000000-0000-4000-8000-000000000682', attemptNo: 1,
      requestHash: 'a'.repeat(64), agentId: 'main', failureCode: 'DISPATCH_AUTHORITY_EXPIRED', outcome: 'not_accepted' as const }
    await client.query('BEGIN')
    await scheduleUndeliveredDispatchRecovery(client, row)
    await scheduleUndeliveredDispatchRecovery(client, row)
    await client.query('COMMIT')
    assert.equal((await client.query('SELECT * FROM turn_recovery_jobs')).rowCount, 1, 'duplicate convergence cannot publish a second replay')
    const q = { query: (sql: string, values?: unknown[]) => client.query(sql, values) } as unknown as Pool
    const jobs = await claimDueRecoveryJobs(q, { userId: 3n, ownerId: 'test-682', leaseMs: 1000 })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.semanticRecoveryAttempt, 1)
    assert.equal(jobs[0]!.request._automaticRecoveryRetryLimit, 1)
    assert.equal((jobs[0]!.request.content as { text: string }).text, source.text)
    assert.equal('__oc_model_authority' in jobs[0]!.request, false)
    const child = { ...source, id: jobs[0]!.request.clientMessageId, _automaticRecovery: true,
      _automaticRecoveryAttempt: 1, _automaticRecoveryRootClientMessageId: source.id }
    await client.query(`UPDATE client_sessions SET messages=$1`, [JSON.stringify([source, child])])
    await client.query('BEGIN')
    await scheduleUndeliveredDispatchRecovery(client, { ...row, clientMessageId: child.id as string })
    await client.query('COMMIT')
    assert.equal((await client.query('SELECT * FROM turn_recovery_jobs')).rowCount, 1, 'receipt-free child refusal exhausts the same one-retry budget')
    const messages = JSON.parse((await client.query('SELECT messages FROM client_sessions')).rows[0].messages)
    assert.equal(messages.length, 2, 'no duplicate give-up card is appended')
  } finally { client.release(); await pool.end() }
})
