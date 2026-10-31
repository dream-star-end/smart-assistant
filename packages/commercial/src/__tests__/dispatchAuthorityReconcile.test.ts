import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { runReconcileTick, type BillingAssessment } from '../dispatch/turnDispatchReconciler.js'
import type { TurnDispatchRow } from '../dispatch/turnDispatchStore.js'
import { handleDispatchAuthorityRejection } from '../ws/dispatchAuthorityRejection.js'

function fixture() {
  const now = Date.now()
  const state: TurnDispatchRow = {
    traceId: '60500000000000000000000000000682',
    dispatchId: '00000000-0000-4000-8000-000000000682', userId: 42n,
    sessionId: 'session-proof-682', clientMessageId: 'cm-proof-682', agentId: 'main',
    model: 'deepseek-v4-flash', requestHash: 'a'.repeat(64), billingRequestId: 'billing-proof-682',
    attemptNo: 1, status: 'admitted', outcome: null, failureCode: null, conflictReason: null,
    resolution: null, resolvedAt: null, clientNotified: false, ownerId: 'owner-proof-682',
    leaseEpoch: 2, leaseUntil: new Date(now + 60_000), anchorSeq: 5n,
    admittedAt: new Date(now - 120_000), acceptedAt: null, terminalAt: null, lastAttemptAt: null,
    shutdownCtx: null, agentContainerId: 7, runtimeKind: 'docker',
  }
  const source = {
    id: state.clientMessageId, role: 'user', text: 'exact original request', _modelText: 'exact model request',
    _routing: { model: state.model, effortLevel: 'high' },
    _media: [{ kind: 'image', url: 'https://files.invalid/proof-682' }],
  }
  const jobs = new Map<string, Record<string, unknown>>()
  const events: string[] = []
  const unhandled: string[] = []
  let transaction = false
  let snapshot: TurnDispatchRow | null = null
  let pendingJobs: typeof jobs | null = null
  const raw = () => Object.fromEntries(Object.entries(state).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    typeof value === 'bigint' ? value.toString() : value,
  ]))
  const none = () => ({ rows: [], rowCount: 0 })
  const found = () => ({ rows: [raw()], rowCount: 1 })
  const query = async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s === 'BEGIN') {
      assert.equal(transaction, false)
      transaction = true
      snapshot = { ...state }
      pendingJobs = new Map(jobs)
      events.push('begin')
      return none()
    }
    if (s === 'COMMIT') {
      assert.equal(transaction, true)
      transaction = false
      jobs.clear()
      for (const [key, value] of pendingJobs!) jobs.set(key, value)
      pendingJobs = null
      snapshot = null
      events.push('commit')
      return none()
    }
    if (s === 'ROLLBACK') {
      if (snapshot) Object.assign(state, snapshot)
      transaction = false
      pendingJobs = null
      snapshot = null
      events.push('rollback')
      return none()
    }
    if (s.startsWith('UPDATE turn_dispatches')) {
      if (s.includes("SET status = 'rejecting'")) {
        if (state.status !== 'admitted' || String(state.leaseEpoch) !== params[3]) return none()
        state.status = 'rejecting'
        state.ownerId = params[1] as string
        state.leaseEpoch++
        state.leaseUntil = null
        state.failureCode = (params[4] as string | null) ?? state.failureCode
        events.push('rejecting')
        return found()
      }
      if (s.includes("SET status = 'terminal'")) {
        if (!(params[5] as string[]).includes(state.status)) return none()
        state.status = 'terminal'
        state.outcome = params[1] as TurnDispatchRow['outcome']
        state.failureCode = params[2] as string
        state.terminalAt = params[4] as Date
        state.leaseUntil = null
        events.push(`terminal:${state.outcome}`)
        return found()
      }
      if (s.includes("SET status = 'accepted'")) {
        if (state.status !== 'rejecting') return none()
        state.status = 'accepted'
        state.acceptedAt = params[1] as Date
        events.push('accepted')
        return found()
      }
      if (s.includes("SET status = 'manual_reconcile'")) {
        state.status = 'manual_reconcile'
        state.conflictReason = params[1] as string
        events.push('manual')
        return found()
      }
      if (s.includes('client_notified = TRUE')) {
        assert.equal(transaction, true)
        state.clientNotified = true
        events.push('notified')
        return { rows: [], rowCount: 1 }
      }
      if (s.includes('SET shutdown_ctx =')) return none()
    }
    if (s.startsWith('UPDATE request_finalize_journal')) {
      if (s.includes("state='aborted'")) {
        assert.equal(transaction, true)
        events.push('journal_waiver')
      }
      return none()
    }
    if (s.startsWith('SELECT') && s.includes('FROM turn_dispatches')) {
      if (s.includes('-- closeVisibleOrphans') || s.includes('LEFT JOIN client_sessions s')) return none()
      if (s.includes('FOR UPDATE')) { assert.equal(transaction, true); return found() }
      if (s.includes('client_message_id = $3')) return found()
      if (s.includes("status = 'rejecting'")) return state.status === 'rejecting' ? found() : none()
      if (s.includes('client_notified = FALSE')) return state.status === 'terminal' && !state.clientNotified ? found() : none()
      if (s.includes("status = 'accepted'")) return state.status === 'accepted' ? found() : none()
      // This fixture's original owner lease is still active. Only the error
      // helper may enter rejecting; the generic expiry scanner cannot mask a
      // missing rejection-handler connection.
      if (s.includes("status = 'admitted'") || s.includes("status IN ('admitted', 'accepted', 'rejecting')")) return none()
    }
    if (s.startsWith('SELECT messages,deleted_at FROM client_sessions')) {
      assert.equal(transaction, true)
      assert.deepEqual(params, [state.sessionId, 'c:42'])
      return { rows: [{ messages: JSON.stringify([source]), deleted_at: null }], rowCount: 1 }
    }
    if (s.startsWith('INSERT INTO turn_recovery_jobs')) {
      assert.equal(transaction, true, 'the replay job must commit with the verified terminal status')
      assert.equal(state.status, 'terminal')
      assert.equal(state.outcome, 'not_accepted')
      const key = JSON.stringify([params[0], params[1], params[2], params[7]])
      if (pendingJobs!.has(key)) return none()
      pendingJobs!.set(key, JSON.parse(params[8] as string))
      events.push('enqueue')
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith('UPDATE client_sessions')) {
      assert.equal(transaction, true)
      events.push('timeline')
      return { rows: [], rowCount: 1 }
    }
    if (s.startsWith('SELECT pg_advisory_xact_lock') || s.startsWith('SELECT f.payload') ||
      /^UPDATE (turn_control_requests|turn_permission_requests|turn_recovery_jobs)\b/.test(s)) return none()
    unhandled.push(s)
    throw new Error(`unhandled proof fixture SQL: ${s}`)
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool
  return { pool, state, source, jobs, events, unhandled, now }
}

test('OCV5-682: correlated expiry reconciles durable inbox and billing proof before one exact replay', async () => {
  for (const sample of [
    { name: 'unbilled tombstone', inbox: 'rejected', billing: 'not_billed', expected: 'terminal', jobs: 1 },
    { name: 'existing running attempt', inbox: 'running', billing: 'not_billed', expected: 'accepted', jobs: 0 },
    { name: 'billing evidence', inbox: 'rejected', billing: 'billed', expected: 'manual_reconcile', jobs: 0 },
  ] as const) {
    const f = fixture()
    const rec = { clientMessageId: f.state.clientMessageId, sessionId: f.state.sessionId,
      dispatchId: f.state.dispatchId, attemptNo: 1, leaseEpoch: 2, leaseOwnerId: f.state.ownerId! }
    const admitted = new Map([[rec.clientMessageId, rec]])
    const warnings: unknown[] = []
    const context = { uid: 42n, pool: f.pool, admittedDispatches: admitted,
      acceptEnrichmentReceipt: () => true, dropAdmittedDispatch: (id: string) => { admitted.delete(id) },
      settleCronOriginClaim() {}, warn: (...args: unknown[]) => { warnings.push(args) } }
    const refusal = JSON.stringify({ type: 'error', code: 'MODEL_AUTHORITY_REJECTED', authorityExpired: true,
      clientMessageId: rec.clientMessageId, dispatchId: rec.dispatchId, attemptNo: 1,
      peer: { id: rec.sessionId, kind: 'dm' } })
    assert.equal(handleDispatchAuthorityRejection(refusal, context), true)
    await setImmediate()
    assert.equal(f.state.status, 'rejecting', sample.name)
    assert.equal(f.state.failureCode, 'DISPATCH_AUTHORITY_EXPIRED')
    assert.equal(admitted.size, 0)
    const probes: string[] = []
    const deps = { pool: f.pool, now: () => f.now, listCarrierDeadDispatchIds: async () => [],
      container: {
        rejectIfAbsent: async () => { probes.push('reject-if-absent'); return { kind: 'ok' as const, state: sample.inbox } },
        getDispatchState: async () => ({ kind: 'ok' as const, state: 'running' as const }),
      },
      assessBilling: async (): Promise<BillingAssessment> => {
        assert.equal(f.state.outcome, 'not_accepted')
        f.events.push(`finance:${sample.billing}`)
        return sample.billing
      },
      enqueueAlert() {},
    }
    await runReconcileTick(deps)
    assert.deepEqual(probes, ['reject-if-absent'], sample.name)
    assert.equal(f.state.status, sample.expected, sample.name)
    assert.equal(f.jobs.size, sample.jobs, sample.name)
    if (sample.jobs) {
      assert.equal(f.state.outcome, 'not_accepted')
      assert.equal(f.state.clientNotified, true)
      const request = [...f.jobs.values()][0]!
      assert.equal(request.model, f.source._routing.model)
      assert.equal(request.effortLevel, 'high')
      assert.equal(request._automaticRecoveryRetryLimit, 1)
      assert.notEqual(request.clientMessageId, f.state.clientMessageId)
      assert.equal((request.content as Record<string, unknown>).text, f.source._modelText)
      assert.deepEqual((request.content as Record<string, unknown>).media, f.source._media)
      assert.equal('__oc_model_authority' in request, false)
      assert.ok(f.events.indexOf('finance:not_billed') < f.events.indexOf('enqueue'))
      assert.ok(f.events.indexOf('enqueue') < f.events.indexOf('commit'))
    }
    handleDispatchAuthorityRejection(refusal, context)
    await setImmediate()
    await runReconcileTick(deps)
    assert.equal(f.jobs.size, sample.jobs, `${sample.name}: a repeated refusal/tick cannot schedule another replay`)
    assert.equal(f.events.filter(event => event === 'enqueue').length, sample.jobs)
    assert.deepEqual(warnings, [])
    assert.deepEqual(f.unhandled, [], 'strict fixture must not hide a swallowed reconciler error')
  }
})
