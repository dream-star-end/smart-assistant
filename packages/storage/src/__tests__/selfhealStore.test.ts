import * as assert from 'node:assert/strict'
/**
 * Tests for the durable self-heal store (slice ② / block B2a).
 *
 * Covers the two hard invariants:
 *   - Job intake idempotency/conflict (repair_id PK + payload_hash).
 *   - At-most-once turn execution (enqueue accepted+queued atomically, then a
 *     single-winner CAS consume).
 * Plus lease-based crash recovery and nonce replay defense.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/selfhealStore.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  SELFHEAL_CALLBACK_BACKOFF_BASE_MS,
  SELFHEAL_CALLBACK_BACKOFF_CAP_MS,
  abandonQueuedCallbacks,
  bumpCallbackAttempt,
  claimDueCallbacks,
  claimNextJob,
  claimQueuedTurn,
  closeSelfhealDb,
  commitBrokerOutcomeWithCallback,
  enqueueCallback,
  enqueueExecution,
  getBrokerAction,
  getReleaseJob,
  getSelfhealDb,
  getExecution,
  getJob,
  insertCancelTombstone,
  insertJobReceived,
  listCallbacksForRepair,
  listJobsByStatus,
  markCallbackAbandoned,
  markCallbackSent,
  overwriteBrokerActionResponse,
  purgeExpiredNonces,
  reclaimOrphanedLeases,
  recordNonceIfFresh,
  renewJobLease,
  setExecutionStatus,
  setJobReleaseRevoked,
  setJobStatus,
  tryClaimBrokerAction,
  finalizeBrokerAction,
  releaseBrokerClaim,
  reopenExecutionForRedrive,
  releaseJobLeasesForOwner,
} = await import('../selfhealStore.js')

after(async () => {
  await closeSelfhealDb()
})

/**
 * Block C fence (design §A2): enqueueExecution/claimQueuedTurn now REQUIRE an
 * owning selfheal_job in an executable state ('starting'/'running'). This
 * helper stages such a job for the execution-ledger tests. It claims with a
 * REAL wall-clock lease so the job is never a claimable candidate for the
 * synthetic-`now` lease tests later in this file.
 */
async function stageRunningJob(repairId: string): Promise<void> {
  await insertJobReceived({ repairId, incidentId: 'i', attempt: 0, payloadHash: 'p' })
  const claimed = await claimNextJob({ owner: 'fence-setup', leaseMs: 3_600_000, now: Date.now() })
  assert.equal(claimed?.repairId, repairId, 'fence setup must claim the staged job')
  assert.equal(await setJobStatus(repairId, 'running', ['starting']), true)
}

describe('insertJobReceived — idempotency & conflict', () => {
  it('inserts a fresh repair', async () => {
    const r = await insertJobReceived({
      repairId: 'r1',
      incidentId: 'i1',
      attempt: 0,
      payloadHash: 'h1',
    })
    assert.equal(r.outcome, 'inserted')
    assert.equal(r.job.status, 'received')
    assert.equal(r.job.incidentId, 'i1')
  })

  it('is idempotent for the same payload hash', async () => {
    const r = await insertJobReceived({
      repairId: 'r1',
      incidentId: 'i1',
      attempt: 0,
      payloadHash: 'h1',
    })
    assert.equal(r.outcome, 'duplicate')
  })

  it('conflicts when the same repair_id has a different payload hash', async () => {
    const r = await insertJobReceived({
      repairId: 'r1',
      incidentId: 'i1',
      attempt: 1,
      payloadHash: 'h2',
    })
    assert.equal(r.outcome, 'conflict')
  })
})

describe('claimNextJob — lease + crash recovery', () => {
  // Drain any leftover claimable jobs from earlier describes so `c1` is the
  // ONLY claimable row (claimNextJob picks the oldest claimable). This isolates
  // the lease/recovery assertions from the shared-DB test ordering.
  before(async () => {
    for (;;) {
      const j = await claimNextJob({ owner: 'drain', leaseMs: 1000, now: 10_000_000 })
      if (!j) break
      await setJobStatus(j.repairId, 'succeeded')
    }
  })

  it('claims a received job and flips it to starting with a lease', async () => {
    await insertJobReceived({ repairId: 'c1', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    const now = 1_000_000
    const job = await claimNextJob({ owner: 'w1', leaseMs: 60_000, now })
    assert.ok(job)
    assert.equal(job?.repairId, 'c1')
    assert.equal(job?.status, 'starting')
    assert.equal(job?.leaseOwner, 'w1')
    assert.equal(job?.leaseUntil, now + 60_000)
  })

  it('does NOT re-claim a starting job while its lease is fresh', async () => {
    // c1 is leased until 1_060_000; ask again well before that.
    const job = await claimNextJob({ owner: 'w2', leaseMs: 60_000, now: 1_010_000 })
    assert.equal(job, null)
  })

  it('re-claims a starting job after its lease expires (crash recovery)', async () => {
    const job = await claimNextJob({ owner: 'w2', leaseMs: 60_000, now: 1_100_000 })
    assert.ok(job)
    assert.equal(job?.repairId, 'c1')
    assert.equal(job?.leaseOwner, 'w2')
  })

  it('renewJobLease extends only for the current owner', async () => {
    const ok = await renewJobLease({ repairId: 'c1', owner: 'w2', leaseMs: 60_000, now: 1_110_000 })
    assert.equal(ok, true)
    const stale = await renewJobLease({ repairId: 'c1', owner: 'w1', leaseMs: 60_000 })
    assert.equal(stale, false)
  })

  it('returns null when nothing is claimable', async () => {
    await setJobStatus('c1', 'succeeded')
    const job = await claimNextJob({ owner: 'w3', leaseMs: 60_000, now: 2_000_000 })
    assert.equal(job, null)
  })
})

describe('setJobStatus — guarded transitions', () => {
  it('applies unguarded transitions', async () => {
    await insertJobReceived({ repairId: 's1', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    assert.equal(await setJobStatus('s1', 'running'), true)
  })

  it('rejects a guarded transition from an unexpected state', async () => {
    // s1 is 'running'; a cancel guarded on ['received'] must not apply.
    assert.equal(await setJobStatus('s1', 'cancelled', ['received']), false)
    const job = await getJob('s1')
    assert.equal(job?.status, 'running')
  })

  it('applies a guarded transition from an expected state', async () => {
    assert.equal(await setJobStatus('s1', 'cancelled', ['starting', 'running']), true)
  })
})

describe('enqueueExecution + claimQueuedTurn — at-most-once', () => {
  // Block C semantics change: both now require the owning job to be in an
  // executable state (fence, design §A2) — hence stageRunningJob per id.
  it('enqueues accepted + queued atomically on first call', async () => {
    await stageRunningJob('e1')
    const r = await enqueueExecution({ executionId: 'e1', sessionKey: 'selfheal:e1' })
    assert.equal(r.outcome, 'enqueued')
    assert.equal(r.outcome === 'enqueued' && r.execution.status, 'accepted')
  })

  it('is idempotent — a second enqueue does not create a second turn', async () => {
    const r = await enqueueExecution({ executionId: 'e1', sessionKey: 'selfheal:e1' })
    assert.equal(r.outcome, 'exists')
    assert.equal(r.outcome === 'exists' && r.execution.status, 'accepted')
  })

  it('exactly one caller wins the turn claim; execution flips to running', async () => {
    const [a, b] = await Promise.all([claimQueuedTurn('e1'), claimQueuedTurn('e1')])
    assert.equal([a, b].filter(Boolean).length, 1, 'exactly one winner')
    const exec = await getExecution('e1')
    assert.equal(exec?.status, 'running')
  })

  it('a re-drive after consume loses the claim (no double-execute)', async () => {
    const again = await claimQueuedTurn('e1')
    assert.equal(again, false)
  })

  it('a crash BEFORE consume is re-drained (queued survives → claim wins)', async () => {
    // Enqueue but never claim → simulates crash after accept, before consume.
    await stageRunningJob('e2')
    const r = await enqueueExecution({ executionId: 'e2', sessionKey: 'selfheal:e2' })
    assert.equal(r.outcome, 'enqueued')
    // Re-drive: the queued row is still there, so the claim must win — no swallow.
    assert.equal(await claimQueuedTurn('e2'), true)
  })

  it('settles execution status to done/failed', async () => {
    await setExecutionStatus('e2', 'done')
    const exec = await getExecution('e2')
    assert.equal(exec?.status, 'done')
  })
})

describe('execution fence (design §A2) — job status guards inside the txn', () => {
  it('rejects an enqueue when no job row exists for the execution', async () => {
    const r = await enqueueExecution({ executionId: 'fence-nojob', sessionKey: 'k' })
    assert.equal(r.outcome, 'rejected')
  })

  it('rejects an enqueue once the job is cancelled (zero submit)', async () => {
    await stageRunningJob('fence-cxl')
    assert.equal(await setJobStatus('fence-cxl', 'cancelled', ['starting', 'running']), true)
    const r = await enqueueExecution({ executionId: 'fence-cxl', sessionKey: 'k' })
    assert.equal(r.outcome, 'rejected')
  })

  it('blocks claimQueuedTurn after the job leaves starting/running (late claim)', async () => {
    await stageRunningJob('fence-late')
    const r = await enqueueExecution({ executionId: 'fence-late', sessionKey: 'k' })
    assert.equal(r.outcome, 'enqueued')
    // Cancel wins between enqueue and claim (the exact「取消后迟到 submit」window).
    assert.equal(await setJobStatus('fence-late', 'cancelling', ['starting', 'running']), true)
    assert.equal(await claimQueuedTurn('fence-late'), false, 'cancelling job must not claim')
    assert.equal(await setJobStatus('fence-late', 'cancelled', ['cancelling']), true)
    assert.equal(await claimQueuedTurn('fence-late'), false, 'cancelled job must not claim')
    // The execution never ran.
    assert.equal((await getExecution('fence-late'))?.status, 'accepted')
  })
})

describe('cancel tombstone + cancelling state (design §A2)', () => {
  it('tombstones an unknown repair with the contract NOT NULL values', async () => {
    assert.equal(await insertCancelTombstone({ repairId: 'tomb-1', incidentId: 'inc-t1' }), true)
    const job = await getJob('tomb-1')
    assert.equal(job?.status, 'cancelled')
    assert.equal(job?.incidentId, 'inc-t1')
    assert.equal(job?.attempt, 0)
    assert.equal(job?.payloadHash, 'tombstone')
  })

  it('is single-winner: a second tombstone insert loses', async () => {
    assert.equal(await insertCancelTombstone({ repairId: 'tomb-1', incidentId: 'inc-t1' }), false)
  })

  it('never clobbers an existing job row', async () => {
    await insertJobReceived({ repairId: 'tomb-2', incidentId: 'i', attempt: 3, payloadHash: 'h' })
    assert.equal(await insertCancelTombstone({ repairId: 'tomb-2', incidentId: 'x' }), false)
    const job = await getJob('tomb-2')
    assert.equal(job?.status, 'received')
    assert.equal(job?.attempt, 3)
    await setJobStatus('tomb-2', 'succeeded')
  })

  it('a LATE dispatch for a tombstoned repair is a payload conflict (never executes)', async () => {
    const r = await insertJobReceived({
      repairId: 'tomb-1',
      incidentId: 'inc-t1',
      attempt: 0,
      payloadHash: 'real-dispatch-hash',
    })
    assert.equal(r.outcome, 'conflict')
  })

  it("'cancelling' is a legal durable state and only teardown-confirm reaches 'cancelled'", async () => {
    await insertJobReceived({ repairId: 'cxl-1', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    assert.equal(
      await setJobStatus('cxl-1', 'cancelling', ['received', 'starting', 'running']),
      true,
    )
    assert.equal((await getJob('cxl-1'))?.status, 'cancelling')
    // listJobsByStatus sees it (retry-cancel discovery surface).
    const stuck = await listJobsByStatus(['cancelling'])
    assert.ok(stuck.some((j) => j.repairId === 'cxl-1'))
    // A worker CAS (starting/running guard) must NOT resurrect it.
    assert.equal(await setJobStatus('cxl-1', 'running', ['starting', 'running']), false)
    assert.equal(await setJobStatus('cxl-1', 'cancelled', ['cancelling']), true)
    assert.equal((await getJob('cxl-1'))?.status, 'cancelled')
  })

  it('a cancelling job is NOT claimable by the worker loop', async () => {
    await insertJobReceived({ repairId: 'cxl-2', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    assert.equal(await setJobStatus('cxl-2', 'cancelling'), true)
    // Even with a synthetic far-future now (any expired-lease window), a
    // cancelling job never comes back to a worker.
    const claimed = await claimNextJob({ owner: 'w-cxl', leaseMs: 1000, now: 9_000_000 })
    assert.notEqual(claimed?.repairId, 'cxl-2')
    if (claimed) await setJobStatus(claimed.repairId, 'succeeded')
    await setJobStatus('cxl-2', 'cancelled', ['cancelling'])
  })
})

describe('reclaimOrphanedLeases — expired-only (Codex HIGH #10)', () => {
  it('does NOT reclaim a still-FRESH lease (a live worker must not be clobbered)', async () => {
    await insertJobReceived({
      repairId: 'live-lease',
      incidentId: 'i',
      attempt: 0,
      payloadHash: 'p',
    })
    const now = 3_000_000
    const claimed = await claimNextJob({ owner: 'liveworker', leaseMs: 600_000, now })
    assert.equal(claimed?.repairId, 'live-lease')
    // Boot reclaim while the lease is still fresh — must touch nothing.
    const touched = await reclaimOrphanedLeases(now + 1000)
    assert.equal(touched, 0, 'a fresh (live) lease must never be reclaimed')
    // And the job stays un-stealable while the lease holds.
    assert.equal(await claimNextJob({ owner: 'other', leaseMs: 600_000, now: now + 2000 }), null)
    await setJobStatus('live-lease', 'succeeded')
  })

  it('reclaims an EXPIRED lease so it is immediately re-claimable', async () => {
    await insertJobReceived({ repairId: 'orph', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    const now = 4_000_000
    await claimNextJob({ owner: 'dead', leaseMs: 60_000, now })
    // Now past the lease → reclaim zeroes it.
    const touched = await reclaimOrphanedLeases(now + 120_000)
    assert.ok(touched >= 1)
    const re = await claimNextJob({ owner: 'live', leaseMs: 60_000, now: now + 121_000 })
    assert.equal(re?.repairId, 'orph')
    assert.equal(re?.leaseOwner, 'live')
    await setJobStatus('orph', 'succeeded')
  })
})

describe('releaseJobLeasesForOwner — graceful shutdown fast recovery', () => {
  it('releases only the owner’s own in-flight leases → immediately re-claimable', async () => {
    await insertJobReceived({ repairId: 'rel1', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    const now = 5_000_000
    await claimNextJob({ owner: 'gwA', leaseMs: 600_000, now })
    // Another owner's fresh lease must be untouched.
    await insertJobReceived({ repairId: 'rel2', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    await claimNextJob({ owner: 'gwB', leaseMs: 600_000, now: now + 10 })
    const n = await releaseJobLeasesForOwner('gwA', now + 20)
    assert.equal(n, 1, 'only gwA’s lease is released')
    // gwA's job is immediately re-claimable; gwB's is not.
    const re = await claimNextJob({ owner: 'gwC', leaseMs: 600_000, now: now + 30 })
    assert.equal(re?.repairId, 'rel1')
    assert.equal(await claimNextJob({ owner: 'gwC', leaseMs: 600_000, now: now + 40 }), null)
    await setJobStatus('rel1', 'succeeded')
    await setJobStatus('rel2', 'succeeded')
  })
})

describe('reopenExecutionForRedrive — crash-mid-turn re-run (Codex HIGH #9)', () => {
  // Block C: executions now need an executable owning job (fence) — staged here.
  it('re-opens a running execution so a re-drive re-runs (no swallow)', async () => {
    await stageRunningJob('rex')
    await enqueueExecution({ executionId: 'rex', sessionKey: 'selfheal:rex' })
    // Simulate a claimed-but-crashed attempt: queue consumed, execution running.
    assert.equal(await claimQueuedTurn('rex'), true)
    assert.equal((await getExecution('rex'))?.status, 'running')
    // A naive re-drive would lose the CAS forever (swallow); reopen fixes it.
    assert.equal(await claimQueuedTurn('rex'), false, 'without reopen the re-drive is swallowed')
    assert.equal(await reopenExecutionForRedrive('rex'), true)
    assert.equal((await getExecution('rex'))?.status, 'accepted')
    assert.equal(await claimQueuedTurn('rex'), true, 're-drive now wins and re-runs')
  })

  it('does NOT re-open a completed (done) execution — no re-run after success', async () => {
    await stageRunningJob('rex2')
    await enqueueExecution({ executionId: 'rex2', sessionKey: 'selfheal:rex2' })
    await claimQueuedTurn('rex2')
    await setExecutionStatus('rex2', 'done')
    assert.equal(await reopenExecutionForRedrive('rex2'), false)
    assert.equal((await getExecution('rex2'))?.status, 'done')
    assert.equal(await claimQueuedTurn('rex2'), false, 'a done turn is never re-run')
  })
})

describe('nonce replay defense', () => {
  it('records a fresh nonce and rejects the replay', async () => {
    assert.equal(await recordNonceIfFresh('n1', 5_000), true)
    assert.equal(await recordNonceIfFresh('n1', 5_001), false)
  })

  it('purges nonces older than the TTL', async () => {
    await recordNonceIfFresh('old', 1_000)
    await recordNonceIfFresh('new', 100_000)
    const purged = await purgeExpiredNonces(10_000, 100_000)
    assert.ok(purged >= 1)
    // 'old' is gone → it can be recorded fresh again; 'new' is still blocked.
    assert.equal(await recordNonceIfFresh('old', 100_001), true)
    assert.equal(await recordNonceIfFresh('new', 100_002), false)
  })
})

describe('broker action claim — atomic single-winner idempotency', () => {
  it('first claim wins; a committed replay returns the recorded response', async () => {
    const k = 'b1:restart_service'
    const first = await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b1',
      actionKind: 'restart_service',
      paramsHash: 'h',
    })
    assert.equal(first.outcome, 'won')
    // Before finalize, a duplicate is 'in_progress' (never re-execute).
    const mid = await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b1',
      actionKind: 'restart_service',
      paramsHash: 'h',
    })
    assert.equal(mid.outcome, 'in_progress')
    await finalizeBrokerAction(k, JSON.stringify({ ok: true, status: 'restarted' }))
    const replay = await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b1',
      actionKind: 'restart_service',
      paramsHash: 'h',
    })
    assert.equal(replay.outcome, 'replay')
    assert.equal(JSON.parse(replay.response ?? '{}').status, 'restarted')
  })

  it('same key with a different params hash is a conflict (not a silent replay)', async () => {
    const k = 'b2:clean_disk'
    assert.equal(
      (
        await tryClaimBrokerAction({
          claimKey: k,
          repairId: 'b2',
          actionKind: 'clean_disk',
          paramsHash: 'A',
        })
      ).outcome,
      'won',
    )
    await finalizeBrokerAction(k, JSON.stringify({ ok: true, status: 'cleaned' }))
    const conflict = await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b2',
      actionKind: 'clean_disk',
      paramsHash: 'B',
    })
    assert.equal(conflict.outcome, 'conflict')
  })

  it('a released (non-committed) claim can be re-claimed', async () => {
    const k = 'b3:switch_node'
    assert.equal(
      (
        await tryClaimBrokerAction({
          claimKey: k,
          repairId: 'b3',
          actionKind: 'switch_node',
          paramsHash: 'h',
        })
      ).outcome,
      'won',
    )
    await releaseBrokerClaim(k)
    // After release, a fresh claim wins again (validation-reject retry path).
    assert.equal(
      (
        await tryClaimBrokerAction({
          claimKey: k,
          repairId: 'b3',
          actionKind: 'switch_node',
          paramsHash: 'h',
        })
      ).outcome,
      'won',
    )
  })

  it('release must NOT remove a committed side effect', async () => {
    const k = 'b4:cutover'
    await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b4',
      actionKind: 'cutover',
      paramsHash: 'h',
    })
    await finalizeBrokerAction(k, JSON.stringify({ ok: false, status: 'deployed' }))
    await releaseBrokerClaim(k) // no-op on a committed row
    const after = await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b4',
      actionKind: 'cutover',
      paramsHash: 'h',
    })
    assert.equal(after.outcome, 'replay')
  })
})

describe('release_revoked fuse (HIGH3)', () => {
  it('defaults to false; setJobReleaseRevoked durably and idempotently flips it', async () => {
    await insertJobReceived({ repairId: 'rv-1', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    assert.equal((await getJob('rv-1'))?.releaseRevoked, false)
    assert.equal(await setJobReleaseRevoked('rv-1'), true)
    assert.equal((await getJob('rv-1'))?.releaseRevoked, true)
    // Idempotent re-apply; unknown repair touches nothing.
    assert.equal(await setJobReleaseRevoked('rv-1'), true)
    assert.equal(await setJobReleaseRevoked('rv-ghost'), false)
    await setJobStatus('rv-1', 'succeeded')
  })
})

describe('callback outbox — durable broker→master delivery (BLOCKER2)', () => {
  it('enqueue is idempotent on (repair_id, phase); different phases coexist', async () => {
    assert.equal(
      await enqueueCallback({
        repairId: 'ob-1',
        phase: 'pending_release',
        message: 'm1',
        detail: { phase: 'pending_release', sha: 'a'.repeat(40) },
        now: 1_000,
      }),
      true,
    )
    // Duplicate (crash re-drive) is a no-op — never a second delivery.
    assert.equal(
      await enqueueCallback({
        repairId: 'ob-1',
        phase: 'pending_release',
        message: 'm1-retry',
        detail: {},
        now: 1_001,
      }),
      false,
    )
    assert.equal(
      await enqueueCallback({
        repairId: 'ob-1',
        phase: 'done',
        message: 'm2',
        detail: { phase: 'deployed' },
        now: 1_002,
      }),
      true,
    )
    const rows = await listCallbacksForRepair('ob-1')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.phase, 'pending_release')
    assert.equal(rows[0]?.message, 'm1', 'losing enqueue must not overwrite the original')
    assert.deepEqual(JSON.parse(rows[0]?.detailJson ?? '{}'), {
      phase: 'pending_release',
      sha: 'a'.repeat(40),
    })
    assert.equal(rows[1]?.phase, 'done')
  })

  it('claimDue holds back a repair’s done while its pending_release is still queued (保序)', async () => {
    // ob-1 has pending_release(id smaller) + done queued: only pending is due.
    const due = await claimDueCallbacks(2_000, 10)
    const mine = due.filter((r) => r.repairId === 'ob-1')
    assert.equal(mine.length, 1)
    assert.equal(mine[0]?.phase, 'pending_release')
    // Once pending_release is sent, done becomes claimable.
    await markCallbackSent(mine[0]!.id, 2_001)
    const due2 = await claimDueCallbacks(2_002, 10)
    const mine2 = due2.filter((r) => r.repairId === 'ob-1')
    assert.equal(mine2.length, 1)
    assert.equal(mine2[0]?.phase, 'done')
    await markCallbackSent(mine2[0]!.id, 2_003)
    assert.equal(
      (await claimDueCallbacks(2_004, 10)).filter((r) => r.repairId === 'ob-1').length,
      0,
    )
  })

  it('bumpCallbackAttempt backs off exponentially (base 5s, doubling, cap 5min)', async () => {
    await enqueueCallback({
      repairId: 'ob-bk',
      phase: 'done',
      message: 'm',
      detail: {},
      now: 10_000,
    })
    const [row] = await listCallbacksForRepair('ob-bk')
    assert.ok(row)
    // attempt 1: +base
    await bumpCallbackAttempt(row!.id, 20_000)
    let cur = (await listCallbacksForRepair('ob-bk'))[0]
    assert.equal(cur?.attempts, 1)
    assert.equal(cur?.nextAttemptAt, 20_000 + SELFHEAL_CALLBACK_BACKOFF_BASE_MS)
    // Not due before next_attempt_at, due at/after it.
    assert.equal(
      (await claimDueCallbacks(20_000 + SELFHEAL_CALLBACK_BACKOFF_BASE_MS - 1, 10)).some(
        (r) => r.repairId === 'ob-bk',
      ),
      false,
    )
    assert.equal(
      (await claimDueCallbacks(20_000 + SELFHEAL_CALLBACK_BACKOFF_BASE_MS, 10)).some(
        (r) => r.repairId === 'ob-bk',
      ),
      true,
    )
    // attempt 2: +2*base
    await bumpCallbackAttempt(row!.id, 30_000)
    cur = (await listCallbacksForRepair('ob-bk'))[0]
    assert.equal(cur?.attempts, 2)
    assert.equal(cur?.nextAttemptAt, 30_000 + 2 * SELFHEAL_CALLBACK_BACKOFF_BASE_MS)
    // Many attempts later the delay is capped at 5min.
    for (let i = 0; i < 10; i++) await bumpCallbackAttempt(row!.id, 40_000)
    cur = (await listCallbacksForRepair('ob-bk'))[0]
    assert.equal(cur?.attempts, 12)
    assert.equal(cur?.nextAttemptAt, 40_000 + SELFHEAL_CALLBACK_BACKOFF_CAP_MS)
    await markCallbackAbandoned(row!.id)
  })

  it('markCallbackAbandoned removes the row from the due set and unblocks later rows', async () => {
    await enqueueCallback({
      repairId: 'ob-ab',
      phase: 'pending_release',
      message: 'm',
      detail: {},
      now: 0,
    })
    await enqueueCallback({ repairId: 'ob-ab', phase: 'done', message: 'm', detail: {}, now: 1 })
    const rows = await listCallbacksForRepair('ob-ab')
    await markCallbackAbandoned(rows[0]!.id, 2)
    // The abandoned pending_release no longer holds back done.
    const due = (await claimDueCallbacks(3, 10)).filter((r) => r.repairId === 'ob-ab')
    assert.equal(due.length, 1)
    assert.equal(due[0]?.phase, 'done')
    await markCallbackSent(due[0]!.id, 4)
  })

  it('abandonQueuedCallbacks abandons only the repair’s queued rows', async () => {
    await enqueueCallback({
      repairId: 'ob-cx',
      phase: 'pending_release',
      message: 'm',
      detail: {},
      now: 0,
    })
    await enqueueCallback({ repairId: 'ob-cx', phase: 'done', message: 'm', detail: {}, now: 1 })
    await enqueueCallback({ repairId: 'ob-other', phase: 'done', message: 'm', detail: {}, now: 2 })
    // A sent row must stay sent.
    const cxRows = await listCallbacksForRepair('ob-cx')
    await markCallbackSent(cxRows[0]!.id, 3)
    assert.equal(await abandonQueuedCallbacks('ob-cx', 4), 1)
    const after = await listCallbacksForRepair('ob-cx')
    assert.equal(after[0]?.status, 'sent')
    assert.equal(after[1]?.status, 'abandoned')
    // The other repair is untouched (still due).
    const other = (await claimDueCallbacks(5, 10)).filter((r) => r.repairId === 'ob-other')
    assert.equal(other.length, 1)
    await markCallbackSent(other[0]!.id, 6)
  })
})

describe('broker action record read/overwrite (release path, block C)', () => {
  it('getBrokerAction reads the durable record; missing key is null', async () => {
    const k = 'b5:cutover'
    await tryClaimBrokerAction({
      claimKey: k,
      repairId: 'b5',
      actionKind: 'cutover',
      paramsHash: 'h',
    })
    let rec = await getBrokerAction(k)
    assert.equal(rec?.status, 'claimed')
    assert.equal(rec?.response, null)
    await finalizeBrokerAction(k, JSON.stringify({ ok: false, status: 'pending_release' }))
    rec = await getBrokerAction(k)
    assert.equal(rec?.status, 'committed')
    assert.equal(JSON.parse(rec?.response ?? '{}').status, 'pending_release')
    assert.equal(await getBrokerAction('nope:cutover'), null)
  })

  it('overwriteBrokerActionResponse only touches COMMITTED rows', async () => {
    const k = 'b5:cutover'
    assert.equal(
      await overwriteBrokerActionResponse(k, JSON.stringify({ ok: true, status: 'deployed' })),
      true,
    )
    assert.equal(JSON.parse((await getBrokerAction(k))?.response ?? '{}').status, 'deployed')
    // A still-claimed row must not be overwritten.
    const kc = 'b6:cutover'
    await tryClaimBrokerAction({
      claimKey: kc,
      repairId: 'b6',
      actionKind: 'cutover',
      paramsHash: 'h',
    })
    assert.equal(await overwriteBrokerActionResponse(kc, '{"status":"deployed"}'), false)
    assert.equal((await getBrokerAction(kc))?.response, null)
  })
})

describe('commitBrokerOutcomeWithCallback — atomic cutover commit + release-job insert (R2-4)', () => {
  const SHA = 'a'.repeat(40)
  const rj = (rrid: string) => ({
    releaseRequestId: rrid,
    repairId: 'r4',
    incidentId: 'i4',
    payloadHash: 'ph4',
    approvedSha: SHA,
    baseSha: 'b'.repeat(40),
    deployPlanHash: 'p'.repeat(64),
    manifestHash: 'm'.repeat(64),
    planJson: JSON.stringify({ classification: { surfaces: ['web'], manual: [] } }),
    origin: 'auto' as const,
  })
  const queued = JSON.stringify({ ok: true, status: 'queued' })

  it('commit ⟹ BOTH the cutover broker_action is committed AND the release job exists', async () => {
    const k = 'r4a:cutover'
    await tryClaimBrokerAction({ claimKey: k, repairId: 'r4', actionKind: 'cutover', paramsHash: 'h' })
    await commitBrokerOutcomeWithCallback({
      finalize: [{ claimKey: k, response: queued }],
      releaseJobInsert: rj('r4a-rrid'),
    })
    assert.equal((await getBrokerAction(k))?.status, 'committed')
    assert.equal(JSON.parse((await getBrokerAction(k))?.response ?? '{}').status, 'queued')
    const job = await getReleaseJob('r4a-rrid')
    assert.equal(job?.status, 'received')
    assert.equal(job?.origin, 'auto')
    assert.equal(job?.approvedSha, SHA)
  })

  it('a crash inside the txn (malformed insert) rolls BOTH back — cutover NOT committed, no job', async () => {
    const k = 'r4b:cutover'
    await tryClaimBrokerAction({ claimKey: k, repairId: 'r4', actionKind: 'cutover', paramsHash: 'h' })
    // Inject a constraint violation (bad `origin` — CHECK is v5|breakglass|auto)
    // AFTER the finalize UPDATE in the same transaction → the whole txn rolls back.
    await assert.rejects(
      commitBrokerOutcomeWithCallback({
        finalize: [{ claimKey: k, response: queued }],
        releaseJobInsert: { ...rj('r4b-rrid'), origin: 'CRASH_INJECT' as unknown as 'auto' },
      }),
    )
    // Atomic: the broker_action stays 'claimed' (not committed) and NO job exists.
    assert.equal((await getBrokerAction(k))?.status, 'claimed')
    assert.equal((await getBrokerAction(k))?.response, null)
    assert.equal(await getReleaseJob('r4b-rrid'), null)
  })

  it('a replayed cutover commit does NOT insert a second job (PK-idempotent, replay-safe)', async () => {
    const k = 'r4c:cutover'
    await tryClaimBrokerAction({ claimKey: k, repairId: 'r4', actionKind: 'cutover', paramsHash: 'h' })
    await commitBrokerOutcomeWithCallback({
      finalize: [{ claimKey: k, response: queued }],
      releaseJobInsert: rj('r4c-rrid'),
    })
    // Re-drive the SAME commit (crash-replay): finalize is a no-op (already
    // committed) and the release-job insert hits ON CONFLICT(rrid) DO NOTHING.
    await commitBrokerOutcomeWithCallback({
      finalize: [{ claimKey: k, response: queued }],
      releaseJobInsert: rj('r4c-rrid'),
    })
    const db = await getSelfhealDb()
    const n = (
      db.prepare('SELECT COUNT(*) n FROM selfheal_release_jobs WHERE release_request_id = ?').get('r4c-rrid') as { n: number }
    ).n
    assert.equal(n, 1, 'PK-idempotent: the replay inserts no duplicate')
  })

  it('R3-3: a same-rrid DIFFERENT-content conflict poisons the commit (throws, full rollback)', async () => {
    const k1 = 'r4d:cutover'
    await tryClaimBrokerAction({ claimKey: k1, repairId: 'r4', actionKind: 'cutover', paramsHash: 'h' })
    await commitBrokerOutcomeWithCallback({
      finalize: [{ claimKey: k1, response: queued }],
      releaseJobInsert: rj('r4d-rrid'),
    })
    // A second commit reusing the SAME rrid but different identity fields must NOT
    // be silently swallowed as a replay — it would associate the cutover with an
    // unrelated existing job. The whole finalize rolls back (claim stays held).
    const k2 = 'r4e:cutover'
    await tryClaimBrokerAction({ claimKey: k2, repairId: 'r4e', actionKind: 'cutover', paramsHash: 'h' })
    await assert.rejects(
      commitBrokerOutcomeWithCallback({
        finalize: [{ claimKey: k2, response: queued }],
        releaseJobInsert: { ...rj('r4d-rrid'), repairId: 'r4e', payloadHash: 'ph-DIFFERENT' },
      }),
      /not an exact replay/,
    )
    assert.equal((await getBrokerAction(k2))?.status, 'claimed', 'poisoned commit fully rolled back')
    const job = await getReleaseJob('r4d-rrid')
    assert.equal(job?.repairId, 'r4', 'the surviving job is untouched')
  })
})
