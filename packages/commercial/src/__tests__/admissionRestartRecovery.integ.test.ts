import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { computeDispatchRequestHash, LOSSLESS_TURN_TAPE_VERSION, type DispatchRequestContent } from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { getPool } from '../db/index.js'
import { createPgSessionsBackend, type PgSessionsBackend } from '../db/pgSessionsBackend.js'
import { snapshotAdmissionRequest, ADMISSION_RESTART_UNEXECUTED } from '../dispatch/admissionRestartRecovery.js'
import type { ContainerCallResult } from '../dispatch/containerDispatchClient.js'
import { casAdmittedToRejecting, casToTerminal, getDispatch } from '../dispatch/turnDispatchStore.js'
import { claimDueRecoveryJobs, releaseRecoveryPreReceipt, listDueRecoveryCarrierContainers } from '../dispatch/turnRecoveryStore.js'
import { admitDurableControl } from '../dispatch/turnControlStore.js'
import { runReconcileTick, runShutdownDispatchHandoff } from '../dispatch/turnDispatchReconciler.js'
import { truncateAllForTest, useDedicatedTestDatabase } from './helpers/db.js'

const fixture = useDedicatedTestDatabase('ocv5_511_admission_restart_test')
let backend: PgSessionsBackend
let uid: bigint
let proof: ContainerCallResult = { kind: 'ok', state: 'rejected' }
let releases: Array<{ userId: string; requestId: string }>
const sessionId = 's-admission-restart'
const sourceId = 'cm-admission-restart-source'

beforeEach(async () => {
  if (!fixture.available) return
  await truncateAllForTest(['turn_recovery_jobs', 'turn_control_requests', 'turn_dispatches',
    'client_session_turn_tapes', 'client_sessions', 'request_finalize_journal',
    'usage_records', 'credit_ledger'])
  const pool = getPool()
  assert.equal((await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db,
    'ocv5_511_admission_restart_test')
  // TRUNCATE users CASCADE resets hundreds of unrelated tables/sequences on
  // every case. Delete this fixture's actual rows instead; keep real FK rules
  // and monotonically fresh uid ownership. The container FK is RESTRICT.
  await pool.query("DELETE FROM agent_containers WHERE id=511 AND user_id IN (SELECT id FROM users WHERE email='admission-restart@test.local')")
  await pool.query("DELETE FROM users WHERE email='admission-restart@test.local'")
  uid = BigInt((await pool.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,credits,role) VALUES ('admission-restart@test.local','stub',1000,'user') RETURNING id::text",
  )).rows[0].id)
  await pool.query(`INSERT INTO agent_containers(id,user_id,secret_hash,state,runtime_channel)
    VALUES (511,$1,$2,'active','v5')`, [uid.toString(), Buffer.alloc(32)])
  await pool.query(`INSERT INTO sessions_store_migration_state
    (singleton,authority,generation,cutover_id,source_digest,completed_at)
    VALUES (true,'pg_authoritative',1,'test','test',1)
    ON CONFLICT (singleton) DO UPDATE SET authority='pg_authoritative',generation=1,
      cutover_id='test',source_digest='test',completed_at=1`)
  proof = { kind: 'ok', state: 'rejected' }; releases = []
  backend = createPgSessionsBackend(pool, { expectedGeneration: 1,
    admissionRestartRecovery: {
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
  const message = { id: sourceId, role: 'user', text: String(content.displayText ?? content.text),
    _modelText: String(content.text), ts: Date.now(),
    _routing: { model: request.model },
    ...(options.snapshot === false ? {} : { _admissionRestartRequest: snapshotAdmissionRequest(request) }),
  } as MessageLike & { id: string }
  if (options.optimistic) {
    await backend.upsertClientSession({ id: sessionId, userId: `c:${uid}`, agentId: 'main', title: 'optimistic',
      pinned: false, createdAt: Date.now(), lastAt: Date.now(), updatedAt: Date.now(),
      messages: [{ id: sourceId, role: 'user', text: String(content.displayText ?? content.text), ts: Date.now() }] })
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
  if (options.terminal !== false) await casToTerminal(getPool(), { dispatchId: d.dispatchId, outcome: 'not_accepted',
    failureCode: 'DISPATCH_NOT_ACCEPTED', clientNotified: false, expectedEpoch: d.leaseEpoch })
  return { d, request }
}

async function jobs() { return (await getPool().query('SELECT * FROM turn_recovery_jobs')).rows }

async function completeTask(dispatchId: string, clientMessageId: string) {
  const turnKey = createHash('sha256').update(dispatchId).digest('hex')
  const createdAt = Date.now()
  const bytes = Buffer.from(JSON.stringify({ sessionId, agentId: 'main', turnIndex: 1,
    status: 'completed', turnKey, clientMessageId, text: 'task finished automatically',
    createdAt, usage: { inputTokens: 1, outputTokens: 2 } }))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const base = { protocolVersion: LOSSLESS_TURN_TAPE_VERSION, sessionId, agentId: 'main',
    turnIndex: 1, status: 'completed' as const, turnKey, tapeId: turnKey, tapeSha256: hash,
    totalBytes: bytes.length, partCount: 1, createdAt }
  await backend.stageLosslessTurnTapePart(`c:${uid}`, { ...base, action: 'part', partIndex: 0,
    partSha256: hash, data: bytes.toString('base64') }, bytes, { dispatchId, attemptNo: 1 })
  assert.equal((await backend.finalizeLosslessTurnTape(`c:${uid}`,
    { ...base, action: 'finalize', dispatchId, attemptNo: 1 })).applied, 'finalized')
  const page = await backend.readClientTimelinePage(sessionId, `c:${uid}`, null, 100)
  assert.ok(JSON.stringify(page).includes('task finished automatically'))
}

type Job = Awaited<ReturnType<typeof claimDueRecoveryJobs>>[number]
async function admitJob(job: Job, ownerId = 'recovery-bridge') {
  const r = job.request
  const content = r.content as Record<string, unknown>
  const cmid = String(r.clientMessageId)
  const recovery = (r.content as { recovery: NonNullable<Parameters<PgSessionsBackend['admitUserTurn']>[0]['recovery']> }).recovery
  const result = await backend.admitUserTurn({ uid, sessionUserId: `c:${uid}`, sessionId,
    clientMessageId: cmid, agentId: 'main', model: 'gpt-6-sol', ownerId,
    requestHash: computeDispatchRequestHash(r.content as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''), dispatchId: randomUUID(),
    agentContainerId: 511, runtimeKind: 'docker', recovery,
    recoveryJob: { jobId: job.jobId, leaseOwner: job.leaseOwner, leaseEpoch: job.leaseEpoch },
    message: { id: cmid, role: 'user', text: String(content.displayText ?? content.text),
      _modelText: String(content.text), ts: Date.now(), _admissionRestartRequest: snapshotAdmissionRequest(r) } })
  assert.equal(result.kind, 'admitted')
  if (result.kind !== 'admitted') throw new Error('job admission failed')
  return result.dispatch
}

// OCV5-511: this is an actual no-tape PG source,
// not a fabricated finalized tape or a test-only alternative scheduler.
test('OCV5-511 ACKed no-tape intent survives restart with exact routing and one recovery identity', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d, request } = await seed({ journal: 'inflight' })
  const oldWallet = (await getPool().query('SELECT credits FROM users WHERE id=$1', [uid.toString()])).rows[0].credits
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 1)
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 0)
  assert.equal((await jobs()).length, 1)
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
  const request = wire(`${'x'.repeat(300_000)}\u0000tail`)
  const { d } = await seed({ request })
  const stored = (await getPool().query('SELECT messages FROM client_sessions WHERE id=$1', [sessionId])).rows[0]
  assert.equal(JSON.parse(stored.messages)[0]._userPayloadDeferred, true)
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'reconnected', leaseMs: 60_000 })
  assert.deepEqual({ ...(job.request.content as object), recovery: undefined }, { ...(request.content as object), recovery: undefined })
})

test('OCV5-511 unknown beyond sixty seconds automatically resumes the original running task and delivers its answer', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ terminal: false, journal: 'inflight' })
  await casAdmittedToRejecting(getPool(), { dispatchId: d.dispatchId, expectedEpoch: d.leaseEpoch, ownerId: 'closed-bridge' })
  proof = { kind: 'unreachable', detail: 'temporary restart outage' }
  const tick = (now = Date.now()) => runReconcileTick({ pool: getPool(), now: () => now,
    recoverInterruptedAdmission: id => backend.recoverInterruptedAdmission(id),
    container: { rejectIfAbsent: async () => proof, getDispatchState: async () => proof } })
  await tick(Date.now() + 120_000)
  assert.equal((await getDispatch(getPool(), d.dispatchId))?.status, 'rejecting')
  assert.equal((await jobs()).length, 0)
  assert.equal((await getPool().query('SELECT state FROM request_finalize_journal')).rows[0].state, 'inflight')
  assert.deepEqual(releases, [])
  proof = { kind: 'ok', state: 'running' }
  await tick()
  const accepted = await getDispatch(getPool(), d.dispatchId)
  assert.equal(accepted?.status, 'accepted'); assert.equal(accepted?.billingRequestId, d.billingRequestId)
  await completeTask(d.dispatchId, sourceId)
  assert.equal((await getDispatch(getPool(), d.dispatchId))?.outcome, 'completed')
  assert.equal((await getPool().query('SELECT count(*)::int AS n FROM turn_dispatches')).rows[0].n, 1)
  assert.equal((await jobs()).length, 0); assert.deepEqual(releases, [])
  assert.notEqual((await getPool().query('SELECT state FROM request_finalize_journal')).rows[0].state, 'aborted')
})

test('OCV5-511 legacy missing snapshot and changed source content hash remain fail-closed', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ snapshot: false })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), false)
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
  const text = `${'large'.repeat(60_000)}\u0000end`
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
})

test('OCV5-511 deferred automatic replay preserves lineage across pre-receipt transport retry', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed({ request: wire('x'.repeat(150_000)) })
  assert.equal(await backend.recoverInterruptedAdmission(d.dispatchId), true)
  const [first] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'master-one', leaseMs: 60_000 })
  assert.ok(first)
  const admit = (job: typeof first, ownerId: string) => {
    const r = job.request
    const cmid = String(r.clientMessageId)
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


for (const state of ['queued', 'sink_staged'] as const) {
  test(`OCV5-511 exact ${state} proof continues the original task through its completed answer`, async t => {
    if (fixture.skipIfUnavailable(t)) return
    const { d } = await seed({ terminal: false, journal: 'inflight' })
    await casAdmittedToRejecting(getPool(), { dispatchId: d.dispatchId, expectedEpoch: d.leaseEpoch, ownerId: 'handoff' })
    await runReconcileTick({ pool: getPool(), container: {
      rejectIfAbsent: async () => ({ kind: 'ok', state }), getDispatchState: async () => ({ kind: 'ok', state }) } })
    assert.equal((await getDispatch(getPool(), d.dispatchId))?.status, 'accepted')
    await completeTask(d.dispatchId, sourceId)
    assert.equal((await getDispatch(getPool(), d.dispatchId))?.outcome, 'completed')
    assert.equal((await getPool().query('SELECT count(*)::int AS n FROM turn_dispatches')).rows[0].n, 1)
    assert.equal((await jobs()).length, 0); assert.deepEqual(releases, [])
  })
}

test('OCV5-511 send-unknown queued recovery job follows exact running proof and completes without another claim', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await backend.recoverInterruptedAdmission(d.dispatchId)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'master', leaseMs: 60_000 })
  const child = await admitJob(job)
  assert.equal(await releaseRecoveryPreReceipt(getPool(), { job, dispatchId: child.dispatchId,
    dispatchOwner: child.ownerId!, dispatchLeaseEpoch: child.leaseEpoch }), true)
  await casAdmittedToRejecting(getPool(), { dispatchId: child.dispatchId, expectedEpoch: child.leaseEpoch, ownerId: 'handoff' })
  await getPool().query('UPDATE turn_recovery_jobs SET next_attempt_at=NOW()')
  assert.deepEqual(await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'must-wait-for-proof', leaseMs: 60_000 }), [])
  await runReconcileTick({ pool: getPool(), container: {
    rejectIfAbsent: async () => ({ kind: 'ok', state: 'running' }), getDispatchState: async () => ({ kind: 'ok', state: 'running' }) } })
  assert.equal((await getDispatch(getPool(), child.dispatchId))?.status, 'accepted')
  assert.equal((await jobs())[0].status, 'forwarded')
  await completeTask(child.dispatchId, child.clientMessageId)
  assert.equal((await jobs())[0].status, 'completed')
  assert.equal((await getDispatch(getPool(), child.dispatchId))?.outcome, 'completed')
  assert.equal((await getPool().query('SELECT count(*)::int AS n FROM turn_dispatches')).rows[0].n, 2)
})

test('OCV5-511 a permanently rejected automatic identity hands off once and its successor finishes the task', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const { d } = await seed()
  await backend.recoverInterruptedAdmission(d.dispatchId)
  const [first] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'master', leaseMs: 60_000 })
  const child = await admitJob(first)
  await casToTerminal(getPool(), { dispatchId: child.dispatchId, outcome: 'not_accepted',
    failureCode: 'DISPATCH_NOT_ACCEPTED', clientNotified: false, expectedEpoch: child.leaseEpoch })
  assert.deepEqual(await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'no-tombstone-retry', leaseMs: 60_000 }), [])
  assert.equal(await backend.recoverInterruptedAdmission(child.dispatchId), true)
  assert.equal(await backend.recoverInterruptedAdmission(child.dispatchId), false)
  const all = await jobs()
  assert.equal(all.length, 2)
  assert.equal(all.find(row => row.job_id === first.jobId)?.status, 'completed')
  const [next] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'next', leaseMs: 60_000 })
  assert.notEqual(next.request.clientMessageId, first.request.clientMessageId)
  assert.equal(next.semanticRecoveryAttempt, 2)
  const successor = await admitJob(next, 'next-bridge')
  await casAdmittedToRejecting(getPool(), { dispatchId: successor.dispatchId, expectedEpoch: successor.leaseEpoch, ownerId: 'probe' })
  await runReconcileTick({ pool: getPool(), container: {
    rejectIfAbsent: async () => ({ kind: 'ok', state: 'running' }), getDispatchState: async () => ({ kind: 'ok', state: 'running' }) } })
  await completeTask(successor.dispatchId, successor.clientMessageId)
  assert.equal((await getDispatch(getPool(), successor.dispatchId))?.outcome, 'completed')
  assert.ok((await jobs()).every(row => row.status === 'completed'))
})


test('OCV5-763 due recovery carrier selection excludes deleted, foreign and other-channel sessions', async t => {
  if (fixture.skipIfUnavailable(t)) return
  await seed({ journal: 'inflight' })
  assert.equal(await backend.reconcileAutomaticRecoveryJobs(uid), 1)
  assert.deepEqual(await listDueRecoveryCarrierContainers(getPool(), uid, 'v5'), [{ container_id: 511 }])
  const pool = getPool()
  await pool.query("UPDATE agent_containers SET runtime_kind='desktop' WHERE id=511")
  assert.deepEqual(await listDueRecoveryCarrierContainers(pool, uid, 'v5'), [],
    'the exact numeric id cannot substitute a different runtime kind')
  await pool.query("UPDATE turn_dispatches SET runtime_kind='desktop' WHERE user_id=$1", [uid.toString()])
  assert.deepEqual(await listDueRecoveryCarrierContainers(pool, uid, 'v5'), [{ container_id: 511 }],
    'a desktop dispatch keeps its desktop carrier; recovery is not docker-only')
  await pool.query(`INSERT INTO agent_containers(id,user_id,secret_hash,state,runtime_channel,runtime_kind)
    VALUES (512,$1,$2,'active','v5','docker')`, [uid.toString(), Buffer.alloc(32)])
  t.after(async () => { await pool.query('DELETE FROM agent_containers WHERE id=512 AND user_id=$1', [uid.toString()]) })
  assert.deepEqual(await listDueRecoveryCarrierContainers(pool, uid, 'v5'), [{ container_id: 511 }],
    'a known desktop carrier is not replaced by the other docker carrier')
  await pool.query('UPDATE turn_dispatches SET agent_container_id=NULL WHERE user_id=$1', [uid.toString()])
  assert.deepEqual(await listDueRecoveryCarrierContainers(pool, uid, 'v5'), [],
    'unknown carrier refuses ambiguity across docker and desktop')
  await pool.query("UPDATE agent_containers SET state='vanished' WHERE id=512")
  assert.deepEqual(await listDueRecoveryCarrierContainers(pool, uid, 'v5'), [{ container_id: 511 }],
    'an unbound job can wake the sole active carrier across supported kinds')
  assert.deepEqual(await listDueRecoveryCarrierContainers(getPool(), uid + 1n, 'v5'), [])
  assert.deepEqual(await listDueRecoveryCarrierContainers(getPool(), uid, 'other-channel'), [])
  assert.equal(await backend.softDeleteMasterSession(sessionId, `c:${uid}`), true)
  assert.equal((await jobs()).length, 1, 'the tombstone filter, not deleting the recovery job, prevents a wake')
  assert.deepEqual(await listDueRecoveryCarrierContainers(getPool(), uid, 'v5'), [])
})

test('OCV5-887 swarmMode survives both _admissionRestartRequest and deferred oversized payload recovery', async t => {
  if (fixture.skipIfUnavailable(t)) return
  const request: Record<string, unknown> = { ...wire(`${'s'.repeat(300_000)}\u0000swarm-tail`), swarmMode: true }
  const content = request.content as Record<string, unknown>
  const message = {
    id: sourceId,
    role: 'user',
    text: String(content.displayText ?? content.text),
    _modelText: String(content.text),
    ts: Date.now(),
    _routing: { model: request.model, swarmMode: true },
    _admissionRestartRequest: snapshotAdmissionRequest(request),
  } as MessageLike & { id: string }
  const decodedSnap = JSON.parse(
    Buffer.from((message._admissionRestartRequest as { wireBase64: string }).wireBase64, 'base64').toString('utf8'),
  ) as Record<string, unknown>
  assert.equal(decodedSnap.swarmMode, true)

  const admitted = await backend.admitUserTurn({
    uid,
    sessionUserId: `c:${uid}`,
    sessionId,
    clientMessageId: sourceId,
    agentId: 'main',
    model: 'gpt-6-sol',
    requestHash: computeDispatchRequestHash(content as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''),
    dispatchId: randomUUID(),
    ownerId: 'old-master',
    agentContainerId: 511,
    runtimeKind: 'docker',
    message,
  })
  assert.equal(admitted.kind, 'admitted')
  if (admitted.kind !== 'admitted') return
  await casToTerminal(getPool(), {
    dispatchId: admitted.dispatch.dispatchId,
    outcome: 'not_accepted',
    failureCode: 'DISPATCH_NOT_ACCEPTED',
    clientNotified: false,
    expectedEpoch: admitted.dispatch.leaseEpoch,
  })
  assert.equal(await backend.recoverInterruptedAdmission(admitted.dispatch.dispatchId), true)
  const [job] = await claimDueRecoveryJobs(getPool(), { userId: uid, ownerId: 'swarm-master', leaseMs: 60_000 })
  assert.ok(job)
  assert.equal(job.request.swarmMode, true, 'turn_recovery_jobs must preserve swarmMode: true across restart')
})

test('OCV5-887 P1-07: restart & checkpoint recovery preserve tri-state swarmMode (true / false / undefined)', async t => {
  if (fixture.skipIfUnavailable(t)) return

  const admitAndFinalizeCrashedCheckpoint = async (args: {
    sid: string
    cmid: string
    text: string
    swarmMode?: boolean
    tools?: Array<Record<string, unknown>>
  }) => {
    const req: Record<string, unknown> = {
      ...wire(args.text),
      peer: { id: args.sid, kind: 'dm' },
      clientMessageId: args.cmid,
      idempotencyKey: `web:${args.cmid}:0`,
      ...(args.swarmMode !== undefined ? { swarmMode: args.swarmMode } : {}),
    }
    const content = req.content as Record<string, unknown>
    const routing: Record<string, unknown> = {
      model: req.model,
      ...(args.swarmMode !== undefined ? { swarmMode: args.swarmMode } : {}),
    }
    const msg = {
      id: args.cmid,
      role: 'user',
      text: String(content.displayText ?? content.text),
      _modelText: String(content.text),
      ts: Date.now(),
      _routing: routing,
      _admissionRestartRequest: snapshotAdmissionRequest(req),
    } as MessageLike & { id: string }
    const admitted = await backend.admitUserTurn({
      uid,
      sessionUserId: `c:${uid}`,
      sessionId: args.sid,
      clientMessageId: args.cmid,
      agentId: 'main',
      model: 'gpt-6-sol',
      requestHash: computeDispatchRequestHash(content as DispatchRequestContent),
      billingRequestId: randomUUID().replaceAll('-', ''),
      dispatchId: randomUUID(),
      ownerId: 'old-master',
      agentContainerId: 511,
      runtimeKind: 'docker',
      message: msg,
    })
    assert.equal(admitted.kind, 'admitted')
    if (admitted.kind !== 'admitted') throw new Error('admission failed')

    const turnKey = createHash('sha256').update(admitted.dispatch.dispatchId).digest('hex')
    const createdAt = Date.now()
    const bytes = Buffer.from(JSON.stringify({
      sessionId: args.sid,
      agentId: 'main',
      turnIndex: 1,
      status: 'crashed',
      errorCode: 'upstream_failed',
      turnKey,
      clientMessageId: args.cmid,
      text: '',
      thinkingText: 'partial durable progress before crash',
      ...(args.tools ? { tools: args.tools } : {}),
      createdAt,
      usage: { inputTokens: 1, outputTokens: 2 },
    }))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const base = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      sessionId: args.sid,
      agentId: 'main',
      turnIndex: 1,
      status: 'crashed' as const,
      turnKey,
      tapeId: turnKey,
      tapeSha256: hash,
      totalBytes: bytes.length,
      partCount: 1,
      createdAt,
    }
    await backend.stageLosslessTurnTapePart(
      `c:${uid}`,
      { ...base, action: 'part', partIndex: 0, partSha256: hash, data: bytes.toString('base64') },
      bytes,
      { dispatchId: admitted.dispatch.dispatchId, attemptNo: 1 },
    )
    const fin = await backend.finalizeLosslessTurnTape(`c:${uid}`, {
      ...base,
      action: 'finalize',
      dispatchId: admitted.dispatch.dispatchId,
      attemptNo: 1,
    })
    assert.equal(fin.applied, 'finalized')
  }

  // 1. Explicit swarmMode: false via admission restart recovery stays false.
  const offReq: Record<string, unknown> = { ...wire('single agent turn'), swarmMode: false }
  const offContent = offReq.content as Record<string, unknown>
  const offMsg = {
    id: sourceId,
    role: 'user',
    text: String(offContent.displayText ?? offContent.text),
    _modelText: String(offContent.text),
    ts: Date.now(),
    _routing: { model: offReq.model, swarmMode: false },
    _admissionRestartRequest: snapshotAdmissionRequest(offReq),
  } as MessageLike & { id: string }
  const admOff = await backend.admitUserTurn({
    uid,
    sessionUserId: `c:${uid}`,
    sessionId,
    clientMessageId: sourceId,
    agentId: 'main',
    model: 'gpt-6-sol',
    requestHash: computeDispatchRequestHash(offContent as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''),
    dispatchId: randomUUID(),
    ownerId: 'old-master',
    agentContainerId: 511,
    runtimeKind: 'docker',
    message: offMsg,
  })
  assert.equal(admOff.kind, 'admitted')
  if (admOff.kind !== 'admitted') return
  await casToTerminal(getPool(), {
    dispatchId: admOff.dispatch.dispatchId,
    outcome: 'not_accepted',
    failureCode: 'DISPATCH_NOT_ACCEPTED',
    clientNotified: false,
    expectedEpoch: admOff.dispatch.leaseEpoch,
  })
  assert.equal(await backend.recoverInterruptedAdmission(admOff.dispatch.dispatchId), true)

  // 2. Legacy admission restart snapshot omitting swarmMode keeps swarmMode undefined.
  const legacyRestartSid = 's-legacy-restart-undef'
  const legacyRestartCmid = 'cm-legacy-restart-undef'
  const legacyReq: Record<string, unknown> = {
    ...wire('legacy turn without swarm flag'),
    peer: { id: legacyRestartSid, kind: 'dm' },
    clientMessageId: legacyRestartCmid,
    idempotencyKey: `web:${legacyRestartCmid}:0`,
  }
  delete legacyReq.swarmMode
  const legacyContent = legacyReq.content as Record<string, unknown>
  const admLegacyRestart = await backend.admitUserTurn({
    uid,
    sessionUserId: `c:${uid}`,
    sessionId: legacyRestartSid,
    clientMessageId: legacyRestartCmid,
    agentId: 'main',
    model: 'gpt-6-sol',
    requestHash: computeDispatchRequestHash(legacyContent as DispatchRequestContent),
    billingRequestId: randomUUID().replaceAll('-', ''),
    dispatchId: randomUUID(),
    ownerId: 'old-master',
    agentContainerId: 511,
    runtimeKind: 'docker',
    message: {
      id: legacyRestartCmid,
      role: 'user',
      text: String(legacyContent.displayText ?? legacyContent.text),
      _modelText: String(legacyContent.text),
      ts: Date.now(),
      _routing: { model: legacyReq.model },
      _admissionRestartRequest: snapshotAdmissionRequest(legacyReq),
    } as MessageLike & { id: string },
  })
  assert.equal(admLegacyRestart.kind, 'admitted')
  if (admLegacyRestart.kind !== 'admitted') return
  await casToTerminal(getPool(), {
    dispatchId: admLegacyRestart.dispatch.dispatchId,
    outcome: 'not_accepted',
    failureCode: 'DISPATCH_NOT_ACCEPTED',
    clientNotified: false,
    expectedEpoch: admLegacyRestart.dispatch.leaseEpoch,
  })
  assert.equal(await backend.recoverInterruptedAdmission(admLegacyRestart.dispatch.dispatchId), true)

  // 3. Tape-backed automatic checkpoint recoveries: explicit true, explicit false,
  //    legacy undefined (no swarm tools -> stays undefined), and legacy undefined with SwarmBoard tool -> true.
  await admitAndFinalizeCrashedCheckpoint({
    sid: 's-ckpt-swarm-true',
    cmid: 'cm-ckpt-swarm-true',
    text: 'continue active swarm',
    swarmMode: true,
  })
  await admitAndFinalizeCrashedCheckpoint({
    sid: 's-ckpt-swarm-false',
    cmid: 'cm-ckpt-swarm-false',
    text: 'explicitly single-agent turn',
    swarmMode: false,
  })
  await admitAndFinalizeCrashedCheckpoint({
    sid: 's-ckpt-swarm-legacy-undef',
    cmid: 'cm-ckpt-swarm-legacy-undef',
    text: 'legacy turn without swarm flag or swarm tool',
  })
  await admitAndFinalizeCrashedCheckpoint({
    sid: 's-ckpt-swarm-legacy-tool',
    cmid: 'cm-ckpt-swarm-legacy-tool',
    text: 'legacy turn that invoked SwarmBoard',
    tools: [{ blockId: 'blk-swarm-1', toolName: 'SwarmBoard', output: 'ok', completed: true }],
  })

  const claimed = await claimDueRecoveryJobs(getPool(), {
    userId: uid,
    ownerId: 'tri-state-master',
    leaseMs: 60_000,
    limit: 10,
  })
  const bySession = new Map(claimed.map(job => [job.sessionId, job]))

  const offRestartJob = bySession.get(sessionId)
  assert.ok(offRestartJob)
  assert.equal(offRestartJob.request.swarmMode, false, 'explicit swarmMode: false must survive restart recovery')

  const legacyRestartJob = bySession.get(legacyRestartSid)
  assert.ok(legacyRestartJob)
  assert.equal(legacyRestartJob.request.swarmMode, undefined, 'legacy restart snapshot without swarmMode must stay undefined')
  assert.equal(Object.prototype.hasOwnProperty.call(legacyRestartJob.request, 'swarmMode'), false)

  const ckptTrueJob = bySession.get('s-ckpt-swarm-true')
  assert.ok(ckptTrueJob)
  assert.equal(ckptTrueJob.recoveryMode, 'checkpoint')
  assert.equal(ckptTrueJob.request.swarmMode, true, 'explicit swarmMode: true must survive checkpoint recovery')

  const ckptFalseJob = bySession.get('s-ckpt-swarm-false')
  assert.ok(ckptFalseJob)
  assert.equal(ckptFalseJob.recoveryMode, 'checkpoint')
  assert.equal(ckptFalseJob.request.swarmMode, false, 'explicit swarmMode: false must never be flipped or dropped on checkpoint recovery')

  const ckptLegacyUndefJob = bySession.get('s-ckpt-swarm-legacy-undef')
  assert.ok(ckptLegacyUndefJob)
  assert.equal(ckptLegacyUndefJob.recoveryMode, 'checkpoint')
  assert.equal(ckptLegacyUndefJob.request.swarmMode, undefined, 'legacy checkpoint missing swarmMode must stay undefined (never coerced to false) so Gateway live-worker fallback is reachable')
  assert.equal(Object.prototype.hasOwnProperty.call(ckptLegacyUndefJob.request, 'swarmMode'), false)

  const ckptLegacyToolJob = bySession.get('s-ckpt-swarm-legacy-tool')
  assert.ok(ckptLegacyToolJob)
  assert.equal(ckptLegacyToolJob.recoveryMode, 'checkpoint')
  assert.equal(ckptLegacyToolJob.request.swarmMode, true, 'legacy checkpoint whose own tape ran SwarmBoard infers swarmMode: true')
})
