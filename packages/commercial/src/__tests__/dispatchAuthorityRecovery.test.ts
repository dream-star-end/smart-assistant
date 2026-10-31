import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { scheduleUndeliveredDispatchRecovery } from '../db/pgSessionsBackend.js'
import { undeliveredDispatchStatus } from '../db/undeliveredDispatchStatus.js'
import { handleDispatchAuthorityRejection } from '../ws/dispatchAuthorityRejection.js'

const record = {
  clientMessageId: 'cm-682', sessionId: 'session-682', dispatchId: '00000000-0000-4000-8000-000000000682',
  attemptNo: 1, leaseEpoch: 2, leaseOwnerId: 'owner-682',
}
const rejection = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'error', code: 'MODEL_AUTHORITY_REJECTED', authorityExpired: true,
  ...record, peer: { id: record.sessionId, kind: 'dm' }, ...over,
})

test('OCV5-682: expired refusal requests durable negative proof, stale or accepted attempts never replay', async () => {
  const queries: string[] = []
  const map = new Map([[record.clientMessageId, record]])
  const context = {
    uid: 3n, pool: { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 } } } as unknown as Pool,
    admittedDispatches: map, acceptEnrichmentReceipt: () => true,
    dropAdmittedDispatch: (id: string) => { map.delete(id) }, settleCronOriginClaim() {}, warn() {},
  }
  assert.equal(handleDispatchAuthorityRejection(rejection({ attemptNo: 2 }), context), true)
  assert.equal(map.size, 1)
  assert.deepEqual(queries, [])
  assert.equal(handleDispatchAuthorityRejection(rejection(), context), true)
  await setImmediate()
  assert.equal(map.size, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /status = 'rejecting'/)
  assert.match(queries[0]!, /status = 'admitted' AND lease_epoch =/)
  assert.doesNotMatch(queries[0]!, /status = 'terminal'|INSERT INTO turn_recovery_jobs/)
  // After lease retirement only exact durable identity may begin proof.
  queries.length = 0
  context.pool = { query: async (sql: string) => {
    queries.push(sql)
    return { rows: [{ dispatch_id: record.dispatchId, user_id: '3', session_id: record.sessionId,
      client_message_id: record.clientMessageId, attempt_no: 1, lease_epoch: '2', status: 'accepted',
      anchor_seq: null }], rowCount: 1 }
  } } as unknown as Pool
  handleDispatchAuthorityRejection(rejection(), context)
  await setImmediate()
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /SELECT/)
})

test('OCV5-682: proven undelivered dispatch durably schedules one exact replay and stops after that retry', async () => {
  let source: Record<string, unknown> = {
    id: record.clientMessageId, role: 'user', text: 'exact original', _modelText: 'exact model text',
    _routing: { model: 'deepseek-v4-flash', effortLevel: 'high' }, _media: [{ kind: 'image', url: 'https://files.invalid/682' }],
  }
  const requests: Record<string, unknown>[] = []
  const client = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT messages,deleted_at FROM client_sessions')) return { rows: [{ messages: JSON.stringify([source]), deleted_at: null }], rowCount: 1 }
    if (sql.includes('INSERT INTO turn_recovery_jobs')) {
      requests.push(JSON.parse(values[8] as string))
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  } } as unknown as PoolClient
  const row = { ...record, userId: 3n, requestHash: 'a'.repeat(64), agentId: 'main',
    failureCode: 'DISPATCH_AUTHORITY_EXPIRED', outcome: 'not_accepted' as const }
  await scheduleUndeliveredDispatchRecovery(client, row)
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request._automaticRecoveryRetryLimit, 1)
  assert.notEqual(request.clientMessageId, record.clientMessageId)
  assert.equal(request.model, 'deepseek-v4-flash')
  assert.deepEqual((request.content as Record<string, unknown>).media, source._media)
  assert.equal((request.content as Record<string, unknown>).text, 'exact model text')
  assert.equal('__oc_model_authority' in request, false, 'fresh admission mints authority; stale ticket is never replayed')
  source = { ...source, id: request.clientMessageId, _automaticRecovery: true,
    _automaticRecoveryRootClientMessageId: record.clientMessageId, _automaticRecoveryAttempt: 1 }
  await scheduleUndeliveredDispatchRecovery(client, { ...row, clientMessageId: request.clientMessageId as string })
  assert.equal(requests.length, 1, 'a second no-receipt refusal does not reset the semantic budget')
  await scheduleUndeliveredDispatchRecovery(client, { ...row, outcome: 'completed' })
  assert.equal(requests.length, 1, 'only an explicit rejected inbox certificate can schedule replay')
})

test('OCV5-682: delivery history keeps one gray root notice and hidden child terminal evidence', async () => {
  const rows = [
    { client_message_id: 'root', failure_code: 'DISPATCH_AUTHORITY_EXPIRED' },
    { client_message_id: 'child', failure_code: 'DISPATCH_AUTHORITY_EXPIRED' },
  ]
  let childNotified = false
  const q = { query: async () => ({ rows: [{ source_client_message_id: 'root', child_message_id: 'child', status: 'completed',
    child_status: 'terminal', child_outcome: 'not_accepted', child_notified: childNotified }] }) } as unknown as Pool
  const sending = await undeliveredDispatchStatus(q, '3', 'session-682', rows)
  assert.deepEqual(sending.map(row => row.deliveryRecovery), ['resent', 'hidden'])
  childNotified = true
  const failed = await undeliveredDispatchStatus(q, '3', 'session-682', rows)
  assert.deepEqual(failed.map(row => row.deliveryRecovery), ['failed', 'hidden'])
  assert.equal(failed[0]!.retryClientMessageId, 'child')
})
