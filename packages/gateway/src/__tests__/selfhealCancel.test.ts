import * as assert from 'node:assert/strict'
/**
 * Cancel contract tests (block C / design §A2): the four terminated cases, the
 * durable 'cancelling' confirmation state, idempotency, and the per-repair
 * mutex interleavings against a simulated worker critical section.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealCancel.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-cancel-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  claimQueuedTurn,
  closeSelfhealDb,
  enqueueCallback,
  enqueueExecution,
  getJob,
  insertJobReceived,
  listCallbacksForRepair,
  setJobSessionKey,
  setJobStatus,
} = await import('@openclaude/storage')
const { executeSelfhealCancel } = await import('../selfheal/cancel.js')
const { selfhealSessionKey, withRepairLock } = await import('../selfheal/executionLedger.js')

after(async () => {
  await closeSelfhealDb()
})

/** Minimal CancelSessionOps double with scriptable teardown failures. */
function fakeSessions(opts: { live?: string[]; failDestroy?: boolean } = {}) {
  const live = new Set(opts.live ?? [])
  const state = {
    live,
    failDestroy: opts.failDestroy ?? false,
    interrupts: [] as string[],
    destroys: [] as string[],
  }
  return {
    state,
    getByKey: (k: string) => (live.has(k) ? { sessionKey: k } : undefined),
    interrupt: (k: string) => {
      state.interrupts.push(k)
      return live.has(k)
    },
    destroySession: async (k: string) => {
      state.destroys.push(k)
      if (state.failDestroy) throw new Error('teardown wedged')
      live.delete(k)
    },
  }
}

describe('cancel case ① — unknown repair → tombstone, terminated=true', () => {
  it('tombstones and reports terminated', async () => {
    const sessions = fakeSessions()
    const r = await executeSelfhealCancel({ repairId: 'cx-unknown', incidentId: 'inc-1' }, sessions)
    assert.equal(r.terminated, true)
    assert.equal(r.accepted, true)
    assert.equal(r.status, 'cancelled')
    const job = await getJob('cx-unknown')
    assert.equal(job?.status, 'cancelled')
    assert.equal(job?.payloadHash, 'tombstone')
    assert.equal(job?.incidentId, 'inc-1')
    assert.equal(job?.attempt, 0)
  })

  it('a late dispatch for the tombstoned repair conflicts (never executes)', async () => {
    const r = await insertJobReceived({
      repairId: 'cx-unknown',
      incidentId: 'inc-1',
      attempt: 0,
      payloadHash: 'real-hash',
    })
    assert.equal(r.outcome, 'conflict')
  })
})

describe('cancel case ② — received/starting without a session → CAS cancelled', () => {
  it('cancels a received job', async () => {
    await insertJobReceived({ repairId: 'cx-recv', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    const r = await executeSelfhealCancel({ repairId: 'cx-recv', incidentId: 'i' }, fakeSessions())
    assert.equal(r.terminated, true)
    assert.equal((await getJob('cx-recv'))?.status, 'cancelled')
  })

  it('cancels a crashed running job whose session no longer exists', async () => {
    await insertJobReceived({ repairId: 'cx-crash', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus('cx-crash', 'running')
    const r = await executeSelfhealCancel({ repairId: 'cx-crash', incidentId: 'i' }, fakeSessions())
    assert.equal(r.terminated, true)
    assert.equal((await getJob('cx-crash'))?.status, 'cancelled')
  })
})

describe('cancel case ③ — already cancelled → idempotent true', () => {
  it('replays terminated=true', async () => {
    const r = await executeSelfhealCancel(
      { repairId: 'cx-unknown', incidentId: 'inc-1' },
      fakeSessions(),
    )
    assert.equal(r.terminated, true)
    assert.equal(r.status, 'cancelled')
  })
})

describe('cancel case ④ — live session → durable cancelling → confirmed teardown', () => {
  it('confirmed teardown reaches cancelled (terminated=true)', async () => {
    await insertJobReceived({ repairId: 'cx-live', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus('cx-live', 'running')
    const sessionKey = selfhealSessionKey('cx-live')
    await setJobSessionKey('cx-live', sessionKey)
    const sessions = fakeSessions({ live: [sessionKey] })
    const r = await executeSelfhealCancel({ repairId: 'cx-live', incidentId: 'i' }, sessions)
    assert.equal(r.terminated, true)
    assert.equal(r.status, 'cancelled')
    assert.deepEqual(sessions.state.interrupts, [sessionKey])
    assert.deepEqual(sessions.state.destroys, [sessionKey])
    assert.equal((await getJob('cx-live'))?.status, 'cancelled')
  })

  it('unconfirmed teardown STAYS in durable cancelling (terminated=false); retry resumes', async () => {
    await insertJobReceived({ repairId: 'cx-wedge', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus('cx-wedge', 'running')
    const sessionKey = selfhealSessionKey('cx-wedge')
    await setJobSessionKey('cx-wedge', sessionKey)
    const sessions = fakeSessions({ live: [sessionKey], failDestroy: true })

    const first = await executeSelfhealCancel({ repairId: 'cx-wedge', incidentId: 'i' }, sessions)
    assert.equal(first.terminated, false, 'unconfirmed teardown must NOT report terminated')
    assert.equal(first.accepted, true)
    assert.equal(first.status, 'cancelling')
    assert.equal((await getJob('cx-wedge'))?.status, 'cancelling', 'durably parked in cancelling')

    // Retry while still wedged — still cancelling, still not terminated.
    const second = await executeSelfhealCancel({ repairId: 'cx-wedge', incidentId: 'i' }, sessions)
    assert.equal(second.terminated, false)
    assert.equal((await getJob('cx-wedge'))?.status, 'cancelling')

    // Teardown recovers → the retried cancel resumes and confirms.
    sessions.state.failDestroy = false
    const third = await executeSelfhealCancel({ repairId: 'cx-wedge', incidentId: 'i' }, sessions)
    assert.equal(third.terminated, true)
    assert.equal(third.status, 'cancelled')
    assert.equal((await getJob('cx-wedge'))?.status, 'cancelled')
  })
})

describe('cancel case ⑤ — terminal success/failure: never resurrected, slot fully released (HIGH3)', () => {
  // Semantics change (HIGH3): a terminal job used to answer terminated=false /
  // accepted=false, permanently occupying the v5 singleflight slot. Now the
  // cancel is honored WITHOUT touching the business result: terminated=true,
  // release durably revoked, queued callbacks abandoned, residual session gone.
  it('a succeeded job reports terminated=true, keeps its status, revokes the release and abandons the outbox', async () => {
    await insertJobReceived({ repairId: 'cx-done', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus('cx-done', 'succeeded')
    // A parked pending_release marker is still queued when the cancel lands.
    await enqueueCallback({
      repairId: 'cx-done',
      phase: 'pending_release',
      message: 'gated',
      detail: { phase: 'pending_release' },
    })
    const r = await executeSelfhealCancel({ repairId: 'cx-done', incidentId: 'i' }, fakeSessions())
    assert.equal(r.terminated, true, 'terminal cancel now fully releases the slot')
    assert.equal(r.accepted, true)
    assert.equal(r.status, 'succeeded', 'business result unchanged')
    const job = await getJob('cx-done')
    assert.equal(job?.status, 'succeeded', 'never resurrected')
    assert.equal(job?.releaseRevoked, true, 'durable release fuse blown')
    assert.equal(
      (await listCallbacksForRepair('cx-done'))[0]?.status,
      'abandoned',
      'queued master callbacks abandoned',
    )
  })

  it('a failed job with a RESIDUAL live session tears it down (best-effort) and reports terminated=true', async () => {
    await insertJobReceived({ repairId: 'cx-fail', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus('cx-fail', 'failed')
    const sessionKey = selfhealSessionKey('cx-fail')
    await setJobSessionKey('cx-fail', sessionKey)
    const sessions = fakeSessions({ live: [sessionKey] })
    const r = await executeSelfhealCancel({ repairId: 'cx-fail', incidentId: 'i' }, sessions)
    assert.equal(r.terminated, true)
    assert.equal(r.status, 'failed')
    assert.deepEqual(sessions.state.destroys, [sessionKey], 'residual session torn down')
    assert.equal((await getJob('cx-fail'))?.status, 'failed')
    assert.equal((await getJob('cx-fail'))?.releaseRevoked, true)
  })

  it('a wedged residual teardown still revokes + terminates (teardown is best-effort)', async () => {
    await insertJobReceived({
      repairId: 'cx-wedgeT',
      incidentId: 'i',
      attempt: 0,
      payloadHash: 'p',
    })
    await setJobStatus('cx-wedgeT', 'succeeded')
    const sessionKey = selfhealSessionKey('cx-wedgeT')
    await setJobSessionKey('cx-wedgeT', sessionKey)
    const sessions = fakeSessions({ live: [sessionKey], failDestroy: true })
    const r = await executeSelfhealCancel({ repairId: 'cx-wedgeT', incidentId: 'i' }, sessions)
    assert.equal(r.terminated, true, 'the revocation, not the teardown, is the hard guarantee')
    assert.equal((await getJob('cx-wedgeT'))?.releaseRevoked, true)
  })
})

describe('mutex interleavings (design §A2 序化结果)', () => {
  it('cancel-first: the worker CAS loses and the ledger refuses the late turn (zero submit)', async () => {
    const repairId = 'cx-race-cancel-first'
    await insertJobReceived({ repairId, incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus(repairId, 'starting')
    const sessionKey = selfhealSessionKey(repairId)
    await setJobSessionKey(repairId, sessionKey)

    // Cancel wins first (no live session → direct cancelled).
    const cancel = await executeSelfhealCancel({ repairId, incidentId: 'i' }, fakeSessions())
    assert.equal(cancel.terminated, true)

    // The worker's critical section then runs: its guarded CAS must lose, and
    // even a (buggy) late enqueue/claim is refused by the SQLite fence.
    let submitted = false
    await withRepairLock(repairId, async () => {
      const cas = await setJobStatus(repairId, 'running', ['starting', 'running'])
      assert.equal(cas, false, 'cancel-first ⇒ the worker CAS must lose')
      if (!cas) return // worker path: destroy session, zero submit
      submitted = true
    })
    assert.equal(submitted, false)
    assert.equal(
      (await enqueueExecution({ executionId: repairId, sessionKey })).outcome,
      'rejected',
    )
    assert.equal(await claimQueuedTurn(repairId), false)
    assert.equal((await getJob(repairId))?.status, 'cancelled')
  })

  it('worker-first: cancel serializes behind the critical section and tears the live turn down', async () => {
    const repairId = 'cx-race-worker-first'
    await insertJobReceived({ repairId, incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await setJobStatus(repairId, 'starting')
    const sessionKey = selfhealSessionKey(repairId)
    await setJobSessionKey(repairId, sessionKey)
    const sessions = fakeSessions() // session appears when the worker "starts the turn"

    const order: string[] = []
    let releaseWorker: () => void = () => {}
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r
    })

    // Worker critical section: CAS → claim → register the (fake) turn.
    const worker = withRepairLock(repairId, async () => {
      order.push('worker-start')
      assert.equal(await setJobStatus(repairId, 'running', ['starting', 'running']), true)
      assert.equal(
        (await enqueueExecution({ executionId: repairId, sessionKey })).outcome,
        'enqueued',
      )
      assert.equal(await claimQueuedTurn(repairId), true)
      sessions.state.live.add(sessionKey) // turn registered / session live
      await workerGate // hold the lock so the cancel below MUST queue behind us
      order.push('worker-end')
    })

    // Cancel issued while the worker holds the lock — it must wait.
    const cancel = executeSelfhealCancel({ repairId, incidentId: 'i' }, sessions).then((r) => {
      order.push('cancel-done')
      return r
    })
    // Give the cancel a chance to (wrongly) run early, then release the worker.
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(
      order,
      ['worker-start'],
      'cancel must not enter while the worker holds the lock',
    )
    releaseWorker()
    await worker

    const cancelOutcome = await cancel
    assert.deepEqual(order, ['worker-start', 'worker-end', 'cancel-done'])
    // Worker-first ⇒ cancel found the LIVE session, tore it down, confirmed.
    assert.equal(cancelOutcome.terminated, true)
    assert.equal(cancelOutcome.status, 'cancelled')
    assert.deepEqual(sessions.state.destroys, [sessionKey])
    assert.equal((await getJob(repairId))?.status, 'cancelled')
  })
})
