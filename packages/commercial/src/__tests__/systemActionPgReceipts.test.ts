/** Commit-phase protocol tests; real atomicity is covered by the private PG integration proof. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { SystemActionExecution } from '@openclaude/storage'
import type { QueryRunner } from '../db/queries.js'
import { getPgActionReceipt, PgActionOutcomeUnknown, withPgActionReceipt } from '../system-assistant/pgReceipts.js'
import { SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const result = { summary: '偏好已保存。', completion: 'done' as const }
function execution(): SystemActionExecution {
  return { id: randomUUID(), userId: actor.userId, sessionId: actor.sessionId, agentId: actor.agentId,
    operationId: 'preferences.update', operationVersion: 1, executorId: randomUUID(), executionNonce: 'A'.repeat(43),
    requestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), args: { notify_email: false }, expectedVersion: '123', quoteHash: null,
    preview: { title: '更改通知', description: '后续通知', scope: '本人', before: [], after: [], consequences: [], destructive: false, price: { kind: 'none', label: '无费用' } } }
}
function protocol(options: { receipt?: Record<string, unknown>; commitError?: Error; rollbackError?: boolean; role?: string } = {}) {
  const calls: string[] = []
  const released: boolean[] = []
  let connects = 0
  const client = {
    async query(sql: string) {
      calls.push(sql)
      if (sql === 'COMMIT' && options.commitError) throw options.commitError
      if (sql === 'ROLLBACK' && options.rollbackError) throw new Error('synthetic rollback disconnect')
      if (sql.startsWith('SELECT role FROM users')) return { rows: [{ role: options.role ?? 'user' }], rowCount: 1 }
      if (sql.startsWith('SELECT 1 FROM users')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('FROM system_action_receipts')) return { rows: options.receipt ? [options.receipt] : [], rowCount: options.receipt ? 1 : 0 }
      return { rows: [], rowCount: 1 }
    },
    release(discard: boolean) { released.push(discard) },
  }
  const pool = { async connect() { connects++; return client as unknown as PoolClient } } as unknown as Pick<Pool, 'connect'>
  return { pool, runner: client as unknown as QueryRunner, calls, released, connects: () => connects }
}
function receipt(e: SystemActionExecution) {
  return { action_id: e.id, user_id: e.userId, session_id: e.sessionId, agent_id: e.agentId, operation_id: e.operationId,
    operation_version: e.operationVersion, request_hash: e.requestHash, input_hash: e.inputHash, result_json: result }
}
test('a PG-only effect and receipt use one runner with an action lock and account lock before work', async () => {
  const e = execution(); const p = protocol()
  const value = await withPgActionReceipt(actor, e, async runner => {
    assert.equal(runner, p.runner)
    await runner.query('UPDATE synthetic_business SET value=1')
    return result
  }, p.pool)
  assert.deepEqual(value, result)
  const workIndex = p.calls.indexOf('UPDATE synthetic_business SET value=1')
  assert(p.calls.findIndex(s => s.includes('pg_advisory_xact_lock')) < workIndex)
  assert(p.calls.findIndex(s => s.includes('FOR SHARE')) < workIndex)
  assert(p.calls.findIndex(s => s.includes('INSERT INTO system_action_receipts')) > workIndex)
  assert.equal(p.calls.at(-1), 'COMMIT')
  assert.deepEqual(p.released, [false])
})
test('a committed exact receipt is returned without invoking the business effect again', async () => {
  const e = execution(); const p = protocol({ receipt: receipt(e) })
  const value = await withPgActionReceipt(actor, e, async () => { throw new Error('business replay forbidden') }, p.pool)
  assert.deepEqual(value, result)
  assert.equal(p.calls.some(s => s.includes('INSERT INTO system_action_receipts')), false)
})
test('an error after COMMIT was sent stays unknown even when it resembles a known rejection and ROLLBACK replies', async () => {
  const p = protocol({ commitError: new SystemOperationRejected('CONFLICT') })
  await assert.rejects(withPgActionReceipt(actor, execution(), async () => result, p.pool), PgActionOutcomeUnknown)
  assert.equal(p.calls.at(-1), 'ROLLBACK')
  assert.deepEqual(p.released, [true])
})
test('only an acknowledged pre-commit rollback can preserve a no-effect rejection', async () => {
  const p = protocol()
  const reject = () => { throw new SystemOperationRejected('CONFLICT') }
  await assert.rejects(withPgActionReceipt(actor, execution(), reject, p.pool), e => e instanceof SystemOperationRejected && e.code === 'CONFLICT')
  assert.equal(p.calls.includes('COMMIT'), false)
  const lost = protocol({ rollbackError: true })
  await assert.rejects(withPgActionReceipt(actor, execution(), reject, lost.pool), PgActionOutcomeUnknown)
})
test('foreign account, legacy missing digest, revoked role and receipt binding mismatch never call work', async () => {
  const e = execution(); let effects = 0
  const work = async () => { effects++; return result }
  const plain = protocol()
  await assert.rejects(withPgActionReceipt({ ...actor, userId: '766' }, e, work, plain.pool), SystemOperationRejected)
  await assert.rejects(withPgActionReceipt(actor, { ...e, requestHash: null }, work, plain.pool), SystemOperationRejected)
  assert.equal(plain.connects(), 0)
  const revoked = protocol({ role: 'admin' })
  await assert.rejects(withPgActionReceipt(actor, e, work, revoked.pool), e => e instanceof SystemOperationRejected && e.code === 'FORBIDDEN')
  const mismatch = protocol({ receipt: { ...receipt(e), input_hash: 'c'.repeat(64) } })
  await assert.rejects(withPgActionReceipt(actor, e, work, mismatch.pool), PgActionOutcomeUnknown)
  assert.equal(effects, 0)
})
test('receipt lookup is pure and missing evidence never infers a current business state', async () => {
  const e = execution(); const missing = protocol()
  assert.equal(await getPgActionReceipt(e, missing.runner), null)
  assert(missing.calls.every(s => s.startsWith('SELECT')))
  const committed = protocol({ receipt: receipt(e), role: 'admin' })
  assert.deepEqual(await getPgActionReceipt(e, committed.runner), result)
  assert(committed.calls.every(s => s.startsWith('SELECT')))
})
