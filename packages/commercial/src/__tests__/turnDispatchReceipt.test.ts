import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { ClaimedRecoveryJob } from '../dispatch/turnRecoveryStore.js'
import { __resetOpenTurnKeyMemory } from '../billing/openTurnAttribution.js'
import { handleTurnDispatchReceipt } from '../ws/turnDispatchReceipt.js'

const record = {
  dispatchId: '00000000-0000-4000-8000-000000000001', clientMessageId: 'cm-receipt',
  sessionId: 'receipt-session', attemptNo: 2, leaseEpoch: 5, leaseOwnerId: 'bridge-owner',
}
const acceptedRow = {
  dispatch_id: record.dispatchId, user_id: '3', session_id: record.sessionId,
  client_message_id: record.clientMessageId, attempt_no: 2, lease_epoch: '5', anchor_seq: null, status: 'accepted',
}
const receipt = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'outbound.control.turn_dispatch_receipt', dispatchId: record.dispatchId,
  clientMessageId: record.clientMessageId, sessionId: record.sessionId, attemptNo: record.attemptNo,
  state: 'running', outcome: null, ...patch,
})

function harness(query: (sql: string, values: unknown[]) => Promise<unknown>, cron = false) {
  const broadcasts: unknown[] = []
  const settlements: unknown[] = []
  const warnings: unknown[] = []
  const frames: unknown[] = []
  const admittedDispatches = new Map([[record.clientMessageId, record]])
  const context = {
    pool: {
      query,
      async connect() {
        return { query, release() {} }
      },
    } as unknown as Pool, uid: 3n, admittedDispatches,
    enrichmentDispatches: new Map<string, { record: typeof record }>(),
    claimEnrichmentTerminalization: () => true,
    acceptEnrichmentReceipt: () => true,
    dropAdmittedDispatch: (cmid: string) => { admittedDispatches.delete(cmid) },
    settleCronOriginClaim: (dispatchId: string, result: unknown) => { settlements.push({ dispatchId, result }) },
    hasCronOriginClaim: () => cron,
    noteDispatchStreamFrame: (...args: unknown[]) => { frames.push(args) },
    broadcast: (frame: unknown) => { broadcasts.push(frame) },
    warn: (message: string, fields: unknown) => { warnings.push({ message, fields }) },
  }
  return { context, broadcasts, settlements, warnings, frames }
}

test('container acceptance is broadcast only after the exact admitted-to-accepted CAS commits', async () => {
  let commit!: (value: unknown) => void
  const queries: unknown[] = []
  const h = harness(async (sql, values) => {
    queries.push({ sql, values })
    return await new Promise(resolve => { commit = resolve })
  })
  assert.equal(handleTurnDispatchReceipt(receipt(), h.context), true)
  assert.deepEqual(h.broadcasts, [], 'an uncommitted inbox receipt is not browser delivery confirmation')
  assert.equal(h.context.admittedDispatches.size, 1)
  assert.deepEqual(h.frames, [[record.sessionId, record.clientMessageId, false]])
  assert.match((queries[0] as { sql: string }).sql, /status = 'admitted' AND lease_epoch = \$2/)
  assert.deepEqual((queries[0] as { values: unknown[] }).values.slice(0, 2), [record.dispatchId, record.leaseEpoch])
  commit({ rows: [acceptedRow], rowCount: 1 })
  await setImmediate()
  assert.deepEqual(h.broadcasts, [{
    type: 'outbound.ack', peer: { id: record.sessionId, kind: 'dm' }, clientMessageId: record.clientMessageId, accepted: true,
  }])
  assert.equal('admitted' in (h.broadcasts[0] as object), false)
  assert.deepEqual(h.settlements, [{ dispatchId: record.dispatchId, result: { kind: 'claimed' } }])
  assert.equal(h.context.admittedDispatches.size, 0)
})

test('a stale CAS emits no accepted ACK, even when a Cron lookup proves an earlier acceptance', async () => {
  let queries = 0
  const h = harness(async (sql) => {
    queries++
    if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 }
    return { rows: [acceptedRow], rowCount: 1 }
  }, true)
  assert.equal(handleTurnDispatchReceipt(receipt(), h.context), true)
  await setImmediate()
  assert.equal(queries, 2)
  assert.deepEqual(h.broadcasts, [])
  assert.deepEqual(h.settlements, [{ dispatchId: record.dispatchId, result: { kind: 'claimed' } }])
})

test('wrong session, dispatch or attempt receipts cannot confirm delivery', async () => {
  for (const patch of [{ sessionId: 'another-session' }, { dispatchId: 'another-dispatch' }, { attemptNo: 3 }, { state: 'terminal', outcome: 'not_accepted' }]) {
    let queried = false
    const h = harness(async () => { queried = true; return { rows: [], rowCount: 0 } })
    assert.equal(handleTurnDispatchReceipt(receipt(patch), h.context), true)
    await setImmediate()
    assert.equal(queried, false)
    assert.equal(h.warnings.length, 1)
    assert.deepEqual(h.broadcasts, [])
    assert.equal(h.context.admittedDispatches.size, 1)
  }
})

test('PG failure preserves delivery uncertainty and never emits accepted', async () => {
  const h = harness(async () => { throw new Error('test failure') })
  assert.equal(handleTurnDispatchReceipt(receipt(), h.context), true)
  await setImmediate()
  assert.deepEqual(h.broadcasts, [])
  assert.deepEqual(h.settlements, [{ dispatchId: record.dispatchId, result: { kind: 'delivery_unknown' } }])
  assert.equal(h.context.admittedDispatches.size, 0)
  assert.equal(h.warnings.length, 1)
})

test('ordinary and recovery rejections retain terminal convergence and Cron refusal semantics', async () => {
  for (const recoveryJob of [undefined, { jobId: 'rejected-recovery-job', leaseOwner: 'scheduler', leaseEpoch: 2, transportWaitAttempt: 0 } as ClaimedRecoveryJob]) {
  const queries: string[] = []
  const h = harness(async (sql) => { queries.push(sql); return { rows: [acceptedRow], rowCount: 1 } })
  if (recoveryJob) h.context.admittedDispatches.set(record.clientMessageId, { ...record, ...{ recoveryJob } })
  const enrichment = { record }
  h.context.enrichmentDispatches.set(record.clientMessageId, enrichment)
  assert.equal(handleTurnDispatchReceipt(receipt({ state: 'rejected', outcome: 'not_accepted' }), h.context), true)
  await setImmediate()
  assert.match(queries[0], /status = 'terminal'/)
  assert.deepEqual(h.broadcasts, [])
  assert.deepEqual(h.settlements, [{ dispatchId: record.dispatchId, result: { kind: 'rejected' } }])
  assert.equal(h.context.enrichmentDispatches.size, 0)
  assert.equal(h.context.admittedDispatches.size, 0)
  }
})

test('an enrichment fence that already terminalized wins before any database await', async () => {
  let queried = false
  const h = harness(async () => { queried = true; return { rows: [], rowCount: 0 } })
  h.context.acceptEnrichmentReceipt = () => false
  assert.equal(handleTurnDispatchReceipt(receipt(), h.context), true)
  await setImmediate()
  assert.equal(queried, false)
  assert.deepEqual(h.broadcasts, [])
  assert.equal(h.context.admittedDispatches.size, 1)
})

test('automatic recovery retains its atomic receipt and running-status path', async () => {
  const queries: unknown[] = []
  const h = harness(async (sql, values) => { queries.push({ sql, values }); return { rows: [], rowCount: 1 } })
  const recoveryJob: ClaimedRecoveryJob = {
    jobId: 'receipt-recovery-job', userId: 3n, sourceTurnKey: 'a'.repeat(64),
    errorCode: 'UPSTREAM_UNAVAILABLE', recoveryMode: 'checkpoint', transportWaitAttempt: 0,
    leaseOwner: record.leaseOwnerId, leaseEpoch: record.leaseEpoch,
    sessionId: record.sessionId, sourceClientMessageId: 'cm-source', rootClientMessageId: 'cm-root',
    semanticRecoveryAttempt: 2, request: { clientMessageId: record.clientMessageId, _automaticRecoveryRetryLimit: 3 },
  }
  h.context.admittedDispatches.set(record.clientMessageId, { ...record, ...{ recoveryJob } })
  assert.equal(handleTurnDispatchReceipt(receipt(), h.context), true)
  await setImmediate()
  assert.equal(queries.length, 1)
  assert.match((queries[0] as { sql: string }).sql, /UPDATE turn_recovery_jobs/)
  assert.deepEqual((queries[0] as { values: unknown[] }).values, [record.dispatchId, record.attemptNo, record.leaseEpoch])
  assert.equal(h.context.admittedDispatches.size, 0)
  assert.deepEqual(h.broadcasts[0], {
    type: 'outbound.ack', peer: { id: record.sessionId, kind: 'dm' }, clientMessageId: record.clientMessageId, accepted: true,
  })
  assert.equal(h.broadcasts.length, 2)
  assert.equal((h.broadcasts[1] as { type: string }).type, 'sys.recovery_status')
  assert.equal((h.broadcasts[1] as { retryStatus: { attempt: number } }).retryStatus.attempt, 2)
  assert.deepEqual(h.settlements, [])
})

test('ordinary or malformed frames remain on the normal bridge path', () => {
  const h = harness(async () => ({ rows: [] }))
  for (const raw of [null, '{broken', '{"type":"outbound.message"}', '{"type":"outbound.control.turn_dispatch_receipt"']) {
    assert.equal(handleTurnDispatchReceipt(raw, h.context), false)
  }
})

test('OCV5-898 follow-up running receipt after queued eviction binds turn_key with verified containerId and skips when containerId is missing', async () => {
  __resetOpenTurnKeyMemory()
  const turnKey = 'e'.repeat(64)

  // Missing agentContainerId must NEVER write to PG (BLOCKER 3)
  const missingContainerQueries: Array<{ sql: string; values: unknown[] }> = []
  const hMissing = harness(async (sql, values) => {
    missingContainerQueries.push({ sql, values })
    return { rows: [], rowCount: 1 }
  })
  hMissing.context.admittedDispatches.clear()
  assert.equal(handleTurnDispatchReceipt(receipt({ state: 'running', turnKey }), hMissing.context), true)
  await setImmediate()
  assert.equal(missingContainerQueries.length, 0, 'follow-up receipt without agentContainerId must fail closed')

  // Verified containerId binds under lockTurnBillingKeys with exact clientMessageId without re-emitting browser ack
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const h = harness(async (sql, values) => {
    queries.push({ sql, values })
    return { rows: [], rowCount: 1 }
  })
  h.context.admittedDispatches.clear()
  ;(h.context as { agentContainerId?: number }).agentContainerId = 7392
  assert.equal(handleTurnDispatchReceipt(receipt({ state: 'running', turnKey }), h.context), true)
  await setImmediate()
  const bindQ = queries.find((q) => q.sql.includes('open-turn:bind-active-dispatch-turn-key'))
  assert.ok(bindQ, 'verified containerId must run guarded turn_key bind')
  assert.equal(queries.some((q) => q.sql.includes('pg_advisory_xact_lock')), true, 'bind must acquire lockTurnBillingKeys')
  assert.deepEqual(bindQ.values, [
    record.dispatchId,
    '3',
    turnKey,
    '7392',
    record.attemptNo,
    record.sessionId,
    record.clientMessageId,
  ])
  assert.deepEqual(h.broadcasts, [], 'follow-up running receipt must not re-broadcast outbound.ack')
})

test('OCV5-898 initial running receipt with turnKey commits accepted CAS and binds turn_key; missing containerId or rejected receipt never binds', async () => {
  __resetOpenTurnKeyMemory()
  const turnKey = 'd'.repeat(64)
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const h = harness(async (sql, values) => {
    queries.push({ sql, values })
    if (sql.includes("SET status = 'accepted'")) return { rows: [acceptedRow], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  ;(h.context as { agentContainerId?: number }).agentContainerId = 7392
  assert.equal(handleTurnDispatchReceipt(receipt({ state: 'running', turnKey }), h.context), true)
  await setImmediate()
  assert.equal(queries.some((q) => q.sql.includes("SET status = 'accepted'")), true)
  const bindQ = queries.find((q) => q.sql.includes('open-turn:bind-active-dispatch-turn-key'))
  assert.ok(bindQ)
  assert.equal(bindQ.values[2], turnKey)
  assert.equal(bindQ.values[3], '7392')
  assert.equal(bindQ.values[6], record.clientMessageId)
  assert.equal(h.broadcasts.length, 1)

  // Missing containerId on initial receipt still commits accepted CAS but never binds turn_key
  const noCidQueries: string[] = []
  const hNoCid = harness(async (sql) => {
    noCidQueries.push(sql)
    if (sql.includes("SET status = 'accepted'")) return { rows: [acceptedRow], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  assert.equal(handleTurnDispatchReceipt(receipt({ state: 'running', turnKey: 'c'.repeat(64) }), hNoCid.context), true)
  await setImmediate()
  assert.equal(noCidQueries.some((sql) => sql.includes('open-turn:bind-active-dispatch-turn-key')), false)

  // Rejected receipt carrying turnKey must NOT attempt turn_key binding
  const rejQueries: string[] = []
  const hRej = harness(async (sql) => {
    rejQueries.push(sql)
    return { rows: [acceptedRow], rowCount: 1 }
  })
  ;(hRej.context as { agentContainerId?: number }).agentContainerId = 7392
  assert.equal(
    handleTurnDispatchReceipt(receipt({ state: 'rejected', outcome: 'not_accepted', turnKey }), hRej.context),
    true,
  )
  await setImmediate()
  assert.equal(rejQueries.some((sql) => sql.includes('open-turn:bind-active-dispatch-turn-key')), false)
})
