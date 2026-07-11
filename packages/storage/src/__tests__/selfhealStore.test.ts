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

describe('reclaimOrphanedLeases — startup crash recovery', () => {
  it('expires leases on non-terminal jobs so they are immediately re-claimable', async () => {
    await insertJobReceived({ repairId: 'orph', incidentId: 'i', attempt: 0, payloadHash: 'p' })
    const now = 3_000_000
    // Claim it with a lease far in the future — normally NOT re-claimable.
    const claimed = await claimNextJob({ owner: 'dead', leaseMs: 600_000, now })
    assert.equal(claimed?.repairId, 'orph')
    assert.equal(await claimNextJob({ owner: 'live', leaseMs: 600_000, now: now + 1000 }), null)
    // Simulate startup recovery: expire orphaned leases.
    const touched = await reclaimOrphanedLeases(now + 2000)
    assert.ok(touched >= 1)
    const re = await claimNextJob({ owner: 'live', leaseMs: 600_000, now: now + 3000 })
    assert.equal(re?.repairId, 'orph')
    assert.equal(re?.leaseOwner, 'live')
    await setJobStatus('orph', 'succeeded')
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
