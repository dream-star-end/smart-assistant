import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { computeDispatchRequestHash, type DispatchRequestContent } from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { getPool } from '../db/index.js'
import { createPgSessionsBackend, type PgSessionsBackend } from '../db/pgSessionsBackend.js'
import { snapshotAdmissionRequest, ADMISSION_RESTART_UNEXECUTED } from '../dispatch/admissionRestartRecovery.js'
import type { ContainerCallResult, DispatchIdentity } from '../dispatch/containerDispatchClient.js'
import { casToTerminal, getDispatch } from '../dispatch/turnDispatchStore.js'
import { claimDueRecoveryJobs, releaseRecoveryPreReceipt } from '../dispatch/turnRecoveryStore.js'
import { admitDurableControl } from '../dispatch/turnControlStore.js'
import { runReconcileTick, runShutdownDispatchHandoff } from '../dispatch/turnDispatchReconciler.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

const fixture = useDedicatedTestDatabase('ocv5_511_admission_restart_test')
let backend: PgSessionsBackend
let uid: bigint
let proof: ContainerCallResult = { kind: 'ok', state: 'rejected' }
let proofCalls: DispatchIdentity[]
let releases: Array<{ userId: string; requestId: string }>
const sessionId = 's-admission-restart'
const sourceId = 'cm-admission-restart-source'

beforeEach(async () => {
  if (!fixture.available) return
  await truncateAllForTest(['users', 'client_sessions', 'request_finalize_journal', 'usage_records', 'credit_ledger'])
  const pool = getPool()
  uid = BigInt((await pool.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,credits,role) VALUES ('admission-restart@test.local','stub',1000,'user') RETURNING id::text",
  )).rows[0].id)
  await pool.query(`INSERT INTO sessions_store_migration_state
    (singleton,authority,generation,cutover_id,source_digest,completed_at)
    VALUES (true,'pg_authoritative',1,'test','test',1)
    ON CONFLICT (singleton) DO UPDATE SET authority='pg_authoritative',generation=1,
      cutover_id='test',source_digest='test',completed_at=1`)
  proof = { kind: 'ok', state: 'rejected' }; proofCalls = []; releases = []
  backend = createPgSessionsBackend(pool, { expectedGeneration: 1,
    admissionRestartRecovery: {
      rejectIfAbsent: async (id) => { proofCalls.push(id); return proof },
      releaseReservation: async (ref) => { releases.push(ref) },
    },
  })
})

function wire(text = 'complete input\u0000including exact NUL'): Record<string, unknown> {
  return { type: 'inbound.message', channel: 'webchat', peer: { id: sessionId, kind: 'dm' },
    agentId: 'main', clientMessageId: sourceId, idempotencyKey: `web:${sourceId}:0`, ts: Date.now(),
    model: 'gpt-6-sol', modelSwitchId: 'switch-511', effortLevel: 'high', contextTier: '1m',
    serviceTier: 'fast', teamMode: false, collabMode: 'advisor', advisorModel: 'gpt-6-astra',
    collabConfigVersion: 'v1:advisor:gpt-6-astra', conversationMode: 'plan',
    content: { text, displayText: 'visible input', replyTo: { messageId: 'quote', text: 'quoted' },
      media: [{ kind: 'image', url: 'https://media.test/hidden-image', hidden: true }],
      imageEdit: { clientJobId: 'a'.repeat(32), sourceIndex: 0, guideIndex: 0, maskIndex: 0, width: 1, height: 1 } },
    requestId: 'must-not-replay', traceId: 'must-not-replay', _masterHistoricalMessages: ['must-not-replay'],
  }
}

async function seed(options: { request?: Record<string, unknown>; snapshot?: boolean; optimistic?: boolean; journal?: string; terminal?: boolean } = {}) {
  const request = options.request ?? wire()
  const content = request.content as Record<string, unknown>
  const message = { id: sourceId, role: 'user', text: String(content.text), ts: Date.now(),
    _routing: { model: request.model },
    ...(options.snapshot === false ? {} : { _admissionRestartRequest: snapshotAdmissionRequest(request) }),
  } as MessageLike & { id: string }
  if (options.optimistic) {
    await backend.upsertClientSession({ id: sessionId, userId: `c:${uid}`, agentId: 'main', title: 'optimistic',
      pinned: false, createdAt: Date.now(), lastAt: Date.now(), updatedAt: Date.now(),
      messages: [{ id: sourceId, role: 'user', text: String(content.text), ts: Date.now() }] })
  }
  const admitted = await backend.admitUserTurn({ uid, sessionUserId: `c:${uid}`, sessionId,
    clientMessageId: sourceId, agentId: 'main', model: 'gpt-6-sol',
    requestHash: computeDispatchRequestHash(content as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''), dispatchId: randomUUID(), ownerId: 'old-master',
    agentContainerId: 511, runtimeKind: 'docker', message })
  assert.equal(admitted.kind, 'admitted')
  if (admitted.kind !== 'admitted') throw new Error('admission failed')
  const d = admitted.dispatch
  if (options.journal) await getPool().query(`INSERT INTO request_finalize_journal
    (request_id,user_id,ctx,precheck_credits,state,dispatch_id)
    VALUES ($1,$2,'{}',50,$3,$4)`, [d.billingRequestId, uid.toString(), options.journal, d.dispatchId])
  if (options.terminal !== false) await casToTerminal(getPool(), { dispatchId: d.dispatchId, outcome: 'executed_error',
    failureCode: 'bridge_closed_during_admission', clientNotified: false, expectedEpoch: d.leaseEpoch })
  return { d, request }
}

async function jobs() { return (await getPool().query('SELECT * FROM turn_recovery_jobs')).rows }

// OCV5-511: this is an actual no-tape PG source,
// not a fabricated finalized tape or a test-only alternative scheduler.
test('OCV5-511 ACKed no-tape intent survives restart with exact routing and one recovery identity', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d, request } = await seed({ journal: 'inflight' })
  const oldWallet = (await getPool().query('SELECT credits FROM users WHERE id=$1', [uid.toString()])).rows[0].credits
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 1)
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 0)
  assert.equal((await jobs()).length, 1)
  assert.deepEqual(proofCalls[0], { uid, dispatchId: d.dispatchId, attemptNo: d.attemptNo,
    sessionId, clientMessageId: sourceId, agentContainerId: 511, runtimeKind: 'docker' })
  const original = await getDispatch(getPool(), d.dispatchId)
  assert.equal(original?.outcome, 'not_accepted')
  assert.equal(original?.failureCode, ADMISSION_RESTART_UNEXECUTED)
  const journal = (await getPool().query('SELECT state,final_credits,error_msg FROM request_finalize_journal')).rows[0]
  assert.equal(journal.state, 'aborted'); assert.equal(journal.final_credits, '0')
  assert.match(journal.error_msg, /permanent_codex_waiver/)
  assert.ok(releases.some(ref => ref.requestId === d.billingRequestId))
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'new-master', leaseMs: 60_000 })
  assert.ok(job); assert.notEqual(job.request.clientMessageId, sourceId)
  const replay = job.request
  assert.deepEqual({ ...(replay.content as object), recovery: undefined },
    { ...(request.content as object), recovery: undefined })
  for (const key of ['model', 'modelSwitchId', 'effortLevel', 'contextTier', 'serviceTier', 'teamMode',
    'collabMode', 'advisorModel', 'collabConfigVersion', 'conversationMode']) assert.deepEqual(replay[key], request[key], key)
  for (const key of ['requestId', 'traceId', '_masterHistoricalMessages']) assert.equal(replay[key], undefined)
  const cmid = String(replay.clientMessageId)
  const recovery = (replay.content as { recovery: NonNullable<Parameters<PgSessionsBackend['admitUserTurn']>[0]['recovery']> }).recovery
  const admit = () => backend.admitUserTurn({ uid, sessionUserId: `c:${uid}`, sessionId,
    clientMessageId: cmid, agentId: 'main', model: 'gpt-6-sol',
    requestHash: computeDispatchRequestHash(replay.content as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''), dispatchId: randomUUID(), ownerId: 'new-bridge',
    agentContainerId: 511, runtimeKind: 'docker', recovery,
    recoveryJob: { jobId: job.jobId, leaseOwner: job.leaseOwner, leaseEpoch: job.leaseEpoch },
    message: { id: cmid, role: 'user', text: String((replay.content as Record<string, unknown>).text), ts: Date.now() } })
  assert.equal((await admit()).kind, 'admitted')
  assert.equal((await admit()).kind, 'already_owned')
  assert.equal((await getPool().query('SELECT count(*) FROM turn_dispatches WHERE client_message_id=$1', [cmid])).rows[0].count, '1')
  assert.equal((await getPool().query('SELECT count(*) FROM usage_records')).rows[0].count, '0')
  assert.equal((await getPool().query('SELECT count(*) FROM credit_ledger')).rows[0].count, '0')
  assert.equal((await getPool().query('SELECT credits FROM users WHERE id=$1', [uid.toString()])).rows[0].credits, oldWallet)
})

test('OCV5-511 optimistic user row receives the exact server snapshot before admission returns', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ optimistic: true })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'reconnected', leaseMs: 60_000 })
  assert.equal((job.request.content as Record<string, unknown>).text, 'complete input\u0000including exact NUL')
})

test('OCV5-511 oversized intent hydrates the existing byte sidecar without truncating hidden media or options', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const request = wire('x'.repeat(300_000) + '\u0000tail')
  const { d } = await seed({ request })
  const stored = (await getPool().query('SELECT messages FROM client_sessions WHERE id=$1', [sessionId])).rows[0]
  assert.equal(JSON.parse(stored.messages)[0]._userPayloadDeferred, true)
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'reconnected', leaseMs: 60_000 })
  assert.deepEqual({ ...(job.request.content as object), recovery: undefined }, { ...(request.content as object), recovery: undefined })
})

test('OCV5-511 running queued staged absent unknown or failed proof never authorizes a second execution', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  for (const state of ['running', 'queued', 'recovery_pending', 'sink_staged', 'sink_stage_failed', 'terminal', 'absent'] as const) {
    proof = { kind: 'ok', state }
    assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false, state)
    assert.equal((await jobs()).length, 0)
  }
  for (const kind of ['unreachable', 'error'] as const) {
    proof = { kind, detail: 'temporarily unavailable' }
    assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  }
  await getPool().query("UPDATE turn_dispatches SET terminal_at=NOW()-INTERVAL '2 minutes' WHERE dispatch_id=$1", [d.dispatchId])
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false, 'persistent lost container remains fail-visible')
  assert.equal((await jobs()).length, 0)
})

test('OCV5-511 legacy missing snapshot and changed source content hash remain fail-closed', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ snapshot: false })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal(proofCalls.length, 0)
  const snapshot = snapshotAdmissionRequest(wire('different original content'))
  const messages = JSON.parse((await getPool().query('SELECT messages FROM client_sessions WHERE id=$1', [sessionId])).rows[0].messages)
  messages[0]._admissionRestartRequest = snapshot
  await getPool().query('UPDATE client_sessions SET messages=$2 WHERE id=$1', [sessionId, JSON.stringify(messages)])
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0)
})

test('OCV5-511 session Stop before recovery prevents enqueue', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await admitDurableControl(getPool(), { controlId: randomUUID(), userId: uid, sessionId,
    rootClientMessageId: null, kind: 'stop', payload: { type: 'inbound.control', action: 'stop' } })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0)
  assert.ok(releases.some(ref => ref.requestId === d.billingRequestId), 'no-journal precheck is also released')
})

test('OCV5-511 a later session Stop cancels an already claimed automatic transport', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'claimed-before-stop', leaseMs: 60_000 })
  assert.ok(job)
  await admitDurableControl(getPool(), { controlId: randomUUID(), userId: uid, sessionId,
    rootClientMessageId: null, kind: 'stop', payload: { type: 'inbound.control', action: 'stop' } })
  assert.equal((await jobs())[0].status, 'cancelled')
  assert.deepEqual(await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'late', leaseMs: 60_000 }), [])
})

test('OCV5-511 concurrent masters enqueue one job and never release a finalizing or charged source', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ journal: 'finalizing' })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0); assert.equal(releases.length, 0)
  await getPool().query("UPDATE request_finalize_journal SET state='inflight' WHERE dispatch_id=$1", [d.dispatchId])
  await Promise.all([backend.recoverInterruptedAdmission(d.dispatchId), backend.recoverInterruptedAdmission(d.dispatchId)])
  assert.equal((await jobs()).length, 1)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'winner', leaseMs: 60_000 })
  assert.ok(job)
  assert.deepEqual(await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'loser', leaseMs: 60_000 }), [])
})

test('OCV5-511 failure reconciler proves an inflight journal before manual verdict and hides recovered source status', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ journal: 'inflight' })
  await runReconcileTick({ pool: getPool(), recoverInterruptedAdmission: id => backend.recoverInterruptedAdmission(id),
    container: { rejectIfAbsent: async () => proof, getDispatchState: async () => proof } })
  assert.equal((await jobs()).length, 1)
  assert.equal((await getDispatch(getPool(), d.dispatchId))?.status, 'terminal')
  await getPool().query('UPDATE turn_dispatches SET client_notified=TRUE WHERE dispatch_id=$1', [d.dispatchId])
  const session = await backend.getClientSession(sessionId, `c:${uid}`)
  assert.ok(session)
  assert.equal((session.messages as MessageLike[]).some(row => row._turnStatusRecord === true), false)
  const page = await backend.readClientTimelinePage(sessionId, `c:${uid}`, null, 100)
  assert.ok(page)
  assert.equal(JSON.stringify(page).includes(`turn-status:${d.dispatchId}`), false)
})

test('OCV5-511 an exact-root Stop before proof also vetoes the new semantic attempt', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await admitDurableControl(getPool(), { controlId: randomUUID(), userId: uid, sessionId,
    rootClientMessageId: sourceId, kind: 'stop', payload: { type: 'inbound.control', action: 'stop' } })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0)
})

test('OCV5-511 newer user intent and deleted sessions are never replayed', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await backend.appendServerAuthoredMessage(sessionId, `c:${uid}`,
    { id: 'cm-newer-intent', role: 'user', text: 'do something else', ts: Date.now() })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal(proofCalls.length, 0)
  await getPool().query('UPDATE client_sessions SET deleted_at=$2 WHERE id=$1', [sessionId, Date.now()])
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0)
})

test('OCV5-511 any charged source remains held and cannot generate another billable attempt', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ journal: 'inflight' })
  const ledger = (await getPool().query<{ id: string }>(`INSERT INTO credit_ledger
    (user_id,delta,balance_after,reason) VALUES ($1,-7,993,'chat') RETURNING id::text`, [uid.toString()])).rows[0].id
  await getPool().query(`INSERT INTO usage_records
    (user_id,mode,model,price_snapshot,cost_credits,request_id,status,ledger_id,dispatch_id)
    VALUES ($1,'chat','gpt-6-sol','{}',7,$2,'success',$3,$4)`, [uid.toString(), d.billingRequestId, ledger, d.dispatchId])
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
  assert.equal((await jobs()).length, 0); assert.equal(releases.length, 0)
  assert.equal((await getPool().query('SELECT state FROM request_finalize_journal')).rows[0].state, 'inflight')
  assert.equal((await getPool().query('SELECT sum(cost_credits)::text AS cost FROM usage_records')).rows[0].cost, '7')
  assert.equal((await getPool().query('SELECT sum(delta)::text AS delta FROM credit_ledger')).rows[0].delta, '-7')
})

test('OCV5-511 an existing large exact user sidecar gains admission metadata atomically', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const text = 'large'.repeat(60_000) + '\u0000end'
  await backend.upsertClientSession({ id: sessionId, userId: `c:${uid}`, agentId: 'main', title: 'existing large',
    pinned: false, createdAt: Date.now(), lastAt: Date.now(), updatedAt: Date.now(), messages: [] })
  await backend.appendServerAuthoredMessage(sessionId, `c:${uid}`,
    { id: sourceId, role: 'user', text, ts: Date.now() })
  const { d } = await seed({ request: wire(text) })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'large-existing', leaseMs: 60_000 })
  assert.equal((job.request.content as Record<string, unknown>).text, text)
})

test('OCV5-511 an older session Stop does not suppress a later accepted intent', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await admitDurableControl(getPool(), { controlId: randomUUID(), userId: uid, sessionId,
    rootClientMessageId: null, kind: 'stop', payload: { type: 'inbound.control', action: 'stop' } })
  await getPool().query("UPDATE turn_control_requests SET created_at=NOW()-INTERVAL '1 day'")
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  assert.equal((await jobs()).length, 1)
})

test('OCV5-511 shutdown handoff rejection of a detached preparing bridge remains recoverable after container reap', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ journal: 'inflight', terminal: false })
  const result = await runShutdownDispatchHandoff({ pool: getPool(), budgetMs: 1500,
    markJournals: async () => 0,
    container: { rejectIfAbsent: async () => ({ kind: 'ok', state: 'rejected' }),
      getDispatchState: async () => ({ kind: 'ok', state: 'rejected' }) } })
  assert.equal(result.timedOut, false)
  const rejected = await getDispatch(getPool(), d.dispatchId)
  assert.equal(rejected?.outcome, 'not_accepted'); assert.equal(rejected?.failureCode, 'DISPATCH_NOT_ACCEPTED')
  proof = { kind: 'unreachable', detail: 'old container reaped after its durable tombstone committed' }
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 1)
  assert.equal((await jobs()).length, 1)
  assert.equal(proofCalls.length, 0, 'persisted exact rejected proof is already authoritative')
})

test('OCV5-511 deferred automatic replay preserves lineage across pre-receipt transport retry', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ request: wire('x'.repeat(150_000)) })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [first] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'master-one', leaseMs: 60_000 })
  assert.ok(first)
  const admit = (job: typeof first, ownerId: string) => {
    const r = job.request, cmid = String(r.clientMessageId)
    const recovery = (r.content as { recovery: NonNullable<Parameters<PgSessionsBackend['admitUserTurn']>[0]['recovery']> }).recovery
    return backend.admitUserTurn({ uid, sessionUserId: `c:${uid}`, sessionId,
      clientMessageId: cmid, agentId: 'main', model: 'gpt-6-sol', ownerId,
      requestHash: computeDispatchRequestHash(r.content as DispatchRequestContent),
      billingRequestId: randomUUID().replaceAll('-', ''), dispatchId: randomUUID(),
      agentContainerId: 511, runtimeKind: 'docker', recovery,
      recoveryJob: { jobId: job.jobId, leaseOwner: job.leaseOwner, leaseEpoch: job.leaseEpoch },
      message: { id: cmid, role: 'user', text: String((r.content as Record<string, unknown>).text), ts: Date.now(),
        _admissionRestartRequest: snapshotAdmissionRequest(r) } })
  }
  const initial = await admit(first, 'bridge-one')
  assert.equal(initial.kind, 'admitted')
  if (initial.kind !== 'admitted') return
  assert.equal(await releaseRecoveryPreReceipt(getPool(), { job: first,
    dispatchId: initial.dispatch.dispatchId, dispatchOwner: initial.dispatch.ownerId!,
    dispatchLeaseEpoch: initial.dispatch.leaseEpoch }), true)
  await getPool().query('UPDATE turn_recovery_jobs SET next_attempt_at=NOW()')
  const [retry] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'master-two', leaseMs: 60_000 })
  assert.ok(retry)
  const resumed = await admit(retry, 'bridge-two')
  assert.equal(resumed.kind, 'admitted', 'must not reject deferred row with identity_reused')
  if (resumed.kind !== 'admitted') return
  assert.equal(resumed.dispatch.dispatchId, initial.dispatch.dispatchId)
  assert.equal(resumed.dispatch.billingRequestId, initial.dispatch.billingRequestId)
  assert.equal((await jobs()).length, 1)
})
