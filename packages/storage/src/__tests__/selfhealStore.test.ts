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
  claimNextJob,
  claimQueuedTurn,
  closeSelfhealDb,
  enqueueExecution,
  getExecution,
  getJob,
  insertJobReceived,
  purgeExpiredNonces,
  reclaimOrphanedLeases,
  recordNonceIfFresh,
  renewJobLease,
  setExecutionStatus,
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
  it('enqueues accepted + queued atomically on first call', async () => {
    const r = await enqueueExecution({ executionId: 'e1', sessionKey: 'selfheal:e1' })
    assert.equal(r.outcome, 'enqueued')
    assert.equal(r.execution.status, 'accepted')
  })

  it('is idempotent — a second enqueue does not create a second turn', async () => {
    const r = await enqueueExecution({ executionId: 'e1', sessionKey: 'selfheal:e1' })
    assert.equal(r.outcome, 'exists')
    assert.equal(r.execution.status, 'accepted')
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

describe('reclaimOrphanedLeases — expired-only (Codex HIGH #10)', () => {
  it('does NOT reclaim a still-FRESH lease (a live worker must not be clobbered)', async () => {
    await insertJobReceived({ repairId: 'live-lease', incidentId: 'i', attempt: 0, payloadHash: 'p' })
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
  it('re-opens a running execution so a re-drive re-runs (no swallow)', async () => {
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
    assert.equal((await tryClaimBrokerAction({ claimKey: k, repairId: 'b2', actionKind: 'clean_disk', paramsHash: 'A' })).outcome, 'won')
    await finalizeBrokerAction(k, JSON.stringify({ ok: true, status: 'cleaned' }))
    const conflict = await tryClaimBrokerAction({ claimKey: k, repairId: 'b2', actionKind: 'clean_disk', paramsHash: 'B' })
    assert.equal(conflict.outcome, 'conflict')
  })

  it('a released (non-committed) claim can be re-claimed', async () => {
    const k = 'b3:switch_node'
    assert.equal((await tryClaimBrokerAction({ claimKey: k, repairId: 'b3', actionKind: 'switch_node', paramsHash: 'h' })).outcome, 'won')
    await releaseBrokerClaim(k)
    // After release, a fresh claim wins again (validation-reject retry path).
    assert.equal((await tryClaimBrokerAction({ claimKey: k, repairId: 'b3', actionKind: 'switch_node', paramsHash: 'h' })).outcome, 'won')
  })

  it('release must NOT remove a committed side effect', async () => {
    const k = 'b4:cutover'
    await tryClaimBrokerAction({ claimKey: k, repairId: 'b4', actionKind: 'cutover', paramsHash: 'h' })
    await finalizeBrokerAction(k, JSON.stringify({ ok: false, status: 'deployed' }))
    await releaseBrokerClaim(k) // no-op on a committed row
    const after = await tryClaimBrokerAction({ claimKey: k, repairId: 'b4', actionKind: 'cutover', paramsHash: 'h' })
    assert.equal(after.outcome, 'replay')
  })
})
