/**
 * OCV5-22 stage 1: durable SQLite + reconciler. No real grok processes.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateDurable.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DelegateJobStore, DELEGATE_LEASE_HEARTBEAT_MAX_BEATS } from '../delegateJobs.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import { isDelegateDurableEnabled, isDelegateDurableEffective } from '../delegateSmFlag.js'
import {
  nextDelegateReconcileAt,
  reconcileDelegateJobsOnBoot,
  restoreResumeOccupancyFromJobs,
} from '../delegateReconciler.js'
import { DelegateResumeRegistry } from '../delegateResume.js'
import {
  claimCronDelegateExecution,
  CronDelegateClaimDeniedError,
  enqueueCronOccurrenceJob,
  settleCronDelegateJob,
} from '../delegateCronIdempotency.js'
import { backfillCronOccurrenceDelegateJobs } from '../cron.js'
import { callbackPayloadFromDurableJob } from '../sendToAgentCallback.js'
import { persistDelegateJobSnapshots } from '../delegateCompleter.js'
import { Gateway } from '../server.js'

function openStore(dir: string, opts: { bootId?: string; now?: () => number; hydrate?: boolean } = {}) {
  const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
  return new DelegateJobStore({
    sm: true,
    ttlMs: 60_000,
    leaseMs: 1_000,
    durable,
    bootId: opts.bootId ?? 'gw:t0',
    now: opts.now,
    hydrate: opts.hydrate,
  })
}

describe('OC_DELEGATE_DURABLE flag', () => {
  it('defaults off', () => {
    assert.equal(isDelegateDurableEnabled({}), false)
    assert.equal(isDelegateDurableEnabled({ OC_DELEGATE_DURABLE: '1' }), true)
  })

  it('effective durable requires SM && DURABLE', () => {
    assert.equal(isDelegateDurableEffective({}), false)
    assert.equal(isDelegateDurableEffective({ OC_DELEGATE_DURABLE: '1' }), false)
    assert.equal(isDelegateDurableEffective({ OC_DELEGATE_SM: '1' }), false)
    assert.equal(
      isDelegateDurableEffective({ OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1' }),
      true,
    )
  })

  it('heartbeat hard cap is 480 beats (2h at 15s)', () => {
    assert.equal(DELEGATE_LEASE_HEARTBEAT_MAX_BEATS, 480)
  })
})

describe('durable write-through + Wait across restart', () => {
  it('queued job survives close and reopen; wait is not expired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-dur-'))
    try {
      const s1 = openStore(dir, { bootId: 'gw:g0' })
      const created = s1.create('coding-assistant', {
        queued: true,
        sessionKey: 'agent:coding-assistant:delegate:main:1:aaaa',
        parentSessionKey: 'agent:main:webchat:dm:p1',
        callback: 'stdout-wait',
      })
      assert.ok('jobId' in created)
      const id = created.jobId
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const snap = s2.snapshotOf(id)
      assert.equal(snap?.state, 'queued')
      const view = await s2.wait(id, 30)
      assert.equal(view.status, 'queued')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('completed result body is restored (not reconstructed empty)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-dur-done-'))
    try {
      const s1 = openStore(dir)
      const created = s1.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      const claimed = s1.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) return
      const body = { ok: true, output: '子任务完成-durable' }
      assert.equal(
        s1.complete(created.jobId, { httpStatus: 200, body }, claimed),
        true,
      )
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const view = s2.get(created.jobId)
      assert.equal(view.status, 'done')
      if (view.status !== 'done') return
      assert.deepEqual(view.body, body)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('idempotency key returns the original jobId after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-dur-idem-'))
    try {
      const s1 = openStore(dir)
      const created = s1.create('coding-assistant', {
        queued: true,
        idempotencyKey: 'cron:job-a:1700000000',
        kind: 'cron',
      })
      assert.ok('jobId' in created)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const again = s2.create('coding-assistant', {
        queued: true,
        idempotencyKey: 'cron:job-a:1700000000',
        kind: 'cron',
      })
      assert.ok('jobId' in again)
      assert.equal(again.jobId, created.jobId)
      assert.equal(again.reused, true)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('double-write crash mid-state', () => {
  it('sqlite committed / memory lost: hydrate recovers the row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-crash-db-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      const db = new DelegateDurableDb(path)
      const s1 = new DelegateJobStore({ sm: true, durable: db, hydrate: false, bootId: 'gw:g0' })
      db.upsert({
        id: 'dlgjob-crash-1',
        agentId: 'coding-assistant',
        state: 'running',
        kind: 'delegate',
        generation: 0,
        fencingEpoch: 1,
        attemptNo: 1,
        checkpointKind: 'none',
        callback: 'none',
        callbackState: 'none',
        callbackEpoch: 0,
        claimToken: 'ab'.repeat(32),
        ownerInstanceId: 'gw:g0',
        ownerLeaseUntil: 9_999_999_999,
        createdAt: 1_000,
        updatedAt: 1_000,
        lastActivityAt: 1_000,
      })
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      assert.equal(s2.snapshotOf('dlgjob-crash-1')?.state, 'running')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persist failure leaves memory unchanged (complete still running)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-crash-mem-'))
    try {
      const s1 = openStore(dir)
      const created = s1.create('coding-assistant')
      assert.ok('jobId' in created)
      const snap = s1.snapshotOf(created.jobId)!
      s1.injectDurableWriteFailure()
      assert.throws(() => {
        s1.complete(
          created.jobId,
          { httpStatus: 200, body: { ok: true } },
          { claimToken: snap.claimToken!, fencingEpoch: snap.fencingEpoch },
        )
      })
      assert.equal(s1.snapshotOf(created.jobId)?.state, 'running')
      assert.equal(s1.get(created.jobId).status, 'running')
      s1.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('reconciler AdoptOrKill', () => {
  it('expired lease + checkpoint none → killed_by_cutover; old fence 0 rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-kill-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const created = s1.create('coding-assistant', { ownerInstanceId: 'gw:g0' })
      assert.ok('jobId' in created)
      const before = s1.snapshotOf(created.jobId)!
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const summary = reconcileDelegateJobsOnBoot(s2, { now: () => now })
      assert.equal(s2.snapshotOf(created.jobId)?.state, 'killed_by_cutover')
      assert.ok(summary.killed >= 1)
      const late = s2.complete(
        created.jobId,
        { httpStatus: 200, body: { ok: true, output: 'g0 late' } },
        { claimToken: before.claimToken!, fencingEpoch: before.fencingEpoch },
      )
      assert.equal(late, false)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('valid lease + unknown liveness is deferred (not killed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-defer-'))
    try {
      const now = () => 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now })
      const created = s1.create('coding-assistant', { ownerInstanceId: 'gw:g0' })
      assert.ok('jobId' in created)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1', now })
      const summary = reconcileDelegateJobsOnBoot(s2, { now })
      assert.equal(s2.snapshotOf(created.jobId)?.state, 'running')
      assert.equal(summary.deferred, 1)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('orphan proved (isChildAlive=false) kills even with live lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-orphan-'))
    try {
      const now = () => 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now })
      const created = s1.create('coding-assistant')
      assert.ok('jobId' in created)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1', now })
      reconcileDelegateJobsOnBoot(s2, { now, isChildAlive: () => false })
      assert.equal(s2.snapshotOf(created.jobId)?.state, 'killed_by_cutover')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('queued past wall-clock wait budget becomes capacity_timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-cap-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const created = s1.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      s1.close()
      now = 200_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const summary = reconcileDelegateJobsOnBoot(s2, { now: () => now, queueWaitMs: 90_000 })
      assert.equal(s2.snapshotOf(created.jobId)?.state, 'failed')
      assert.equal(s2.snapshotOf(created.jobId)?.failureClass, 'capacity_timeout')
      assert.equal(summary.capacityTimedOut, 1)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('restored non-terminal jobs count toward capacity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-count-'))
    try {
      const s1 = new DelegateJobStore({
        sm: true,
        maxJobs: 2,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:g0',
      })
      assert.ok('jobId' in s1.create('coding-assistant', { queued: true }))
      assert.ok('jobId' in s1.create('coding-assistant', { queued: true }))
      s1.close()
      const s2 = new DelegateJobStore({
        sm: true,
        maxJobs: 2,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:g1',
      })
      assert.equal(s2.nonTerminalCount(), 2)
      const third = s2.create('coding-assistant', { queued: true })
      assert.deepEqual(third, { error: 'capacity' })
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fence expiry after restart', () => {
  it('heartbeat lease is durable; stale token cannot complete after rotate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-fence-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const created = s1.create('coding-assistant')
      assert.ok('jobId' in created)
      const tok = s1.snapshotOf(created.jobId)!
      now = 1_500
      assert.equal(s1.casHeartbeat(created.jobId, tok.claimToken!, tok.fencingEpoch), true)
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      reconcileDelegateJobsOnBoot(s2, { now: () => now })
      assert.equal(s2.snapshotOf(created.jobId)?.state, 'killed_by_cutover')
      assert.equal(
        s2.complete(
          created.jobId,
          { httpStatus: 200, body: { ok: true } },
          { claimToken: tok.claimToken!, fencingEpoch: tok.fencingEpoch },
        ),
        false,
      )
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resume occupancy restore', () => {
  it('same (session, idempotency) replays the original jobId after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-resume-'))
    try {
      const sessionKey = 'agent:coding-assistant:delegate:main:1:bbbb'
      const s1 = openStore(dir)
      const created = s1.create('coding-assistant', {
        queued: true,
        sessionKey,
        parentSessionKey: 'agent:main:webchat:dm:p1',
        idempotencyKey: 'resume:sk:abc',
      })
      assert.ok('jobId' in created)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const registry = new DelegateResumeRegistry()
      restoreResumeOccupancyFromJobs(registry, s2)
      const replay = registry.preflight({
        resumeSessionKey: sessionKey,
        parentSessionKey: 'agent:main:webchat:dm:p1',
        targetAgentId: 'coding-assistant',
        sourceAgent: 'main',
        idempotencyKey: 'resume:sk:abc',
      })
      assert.equal(replay.ok, true)
      if (!replay.ok) return
      assert.equal(replay.replay, true)
      assert.equal(replay.dispatchGranted, false)
      assert.equal(replay.jobId, created.jobId)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cron occurrence projection backfill', () => {
  it('fills missing delegateJobId from UNIQUE idempotency key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-bf-'))
    try {
      const s1 = openStore(dir)
      const enq = enqueueCronOccurrenceJob(s1, {
        cronJobId: 'daily',
        dueMinuteKey: 1_700_000_000,
        agentId: 'main',
      })
      assert.ok(!('error' in enq))
      if ('error' in enq) return
      const occDir = join(dir, 'occurrences')
      await mkdir(occDir, { recursive: true })
      const rec = {
        version: 1 as const,
        deliveryId: 'd1',
        jobId: 'daily',
        dueMinuteKey: 1_700_000_000,
        schedule: '0 * * * *',
        state: 'prepared',
        sessionKey: 'sk',
        tapeEvents: 0,
        updatedAt: 1,
      }
      await writeFile(join(occDir, 'd1.json'), `${JSON.stringify(rec)}\n`)
      const n = backfillCronOccurrenceDelegateJobs(s1, occDir)
      assert.equal(n, 1)
      const filled = JSON.parse(await readFile(join(occDir, 'd1.json'), 'utf8'))
      assert.equal(filled.delegateJobId, enq.jobId)
      s1.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 1: SQLite fence CAS is the write authority', () => {
  it('old epoch complete cannot overwrite a newer killed row (two DB handles)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cas-epoch-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      let now = 1_000
      const g0 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(path),
        bootId: 'gw:g0',
        leaseMs: 1_000,
        now: () => now,
      })
      const created = g0.create('coding-assistant')
      assert.ok('jobId' in created)
      const before = g0.snapshotOf(created.jobId)!
      assert.equal(before.fencingEpoch, 1)
      now = 50_000
      const g1 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(path),
        bootId: 'gw:g1',
        leaseMs: 1_000,
        now: () => now,
      })
      const summary = reconcileDelegateJobsOnBoot(g1, { now: () => now })
      assert.ok(summary.killed >= 1)
      assert.equal(g1.snapshotOf(created.jobId)?.state, 'killed_by_cutover')
      assert.equal(g1.snapshotOf(created.jobId)?.fencingEpoch, 2)
      const late = g0.complete(
        created.jobId,
        { httpStatus: 200, body: { ok: true, output: 'g0 late' } },
        { claimToken: before.claimToken!, fencingEpoch: before.fencingEpoch },
      )
      assert.equal(late, false)
      const observer = new DelegateDurableDb(path)
      const row = observer.get(created.jobId)
      assert.equal(row?.state, 'killed_by_cutover')
      assert.equal(row?.fencingEpoch, 2)
      observer.close()
      g0.close()
      g1.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('capacity is arbitrated in SQLite, not per-process Maps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cas-cap-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      const g0 = new DelegateJobStore({
        sm: true,
        maxJobs: 1,
        durable: new DelegateDurableDb(path),
        bootId: 'gw:g0',
      })
      assert.ok('jobId' in g0.create('coding-assistant', { queued: true }))
      const g1 = new DelegateJobStore({
        sm: true,
        maxJobs: 1,
        durable: new DelegateDurableDb(path),
        bootId: 'gw:g1',
        hydrate: false,
      })
      assert.equal(g1.nonTerminalCount(), 1)
      assert.deepEqual(g1.create('coding-assistant', { queued: true }), { error: 'capacity' })
      g0.close()
      g1.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 2: reconciler follow-up settles deferred + queued', () => {
  it('one-shot boot defers live-lease running and leaves queued unclaimed; second scan times out both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-rec-follow-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const queued = s1.create('coding-assistant', { queued: true })
      const running = s1.create('coding-assistant', { ownerInstanceId: 'gw:g0' })
      if (!('jobId' in queued) || !('jobId' in running)) {
        assert.fail('expected two jobs')
        return
      }
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const first = reconcileDelegateJobsOnBoot(s2, { now: () => now, queueWaitMs: 90_000 })
      assert.equal(first.deferred, 1)
      assert.equal(first.capacityTimedOut, 0)
      const qSnap = s2.snapshotOf(queued.jobId)!
      assert.equal(qSnap.state, 'queued')
      assert.equal(qSnap.claimToken, undefined)
      const nextAt = nextDelegateReconcileAt(s2, { now: () => now, queueWaitMs: 90_000 })
      assert.ok(nextAt != null && nextAt > now)
      now = 100_000
      const second = reconcileDelegateJobsOnBoot(s2, { now: () => now, queueWaitMs: 90_000 })
      assert.equal(s2.snapshotOf(running.jobId)?.state, 'killed_by_cutover')
      assert.equal(s2.snapshotOf(queued.jobId)?.state, 'failed')
      assert.equal(s2.snapshotOf(queued.jobId)?.failureClass, 'capacity_timeout')
      assert.ok(second.killed >= 1)
      assert.equal(second.capacityTimedOut, 1)
      assert.equal(s2.nonTerminalCount(), 0)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 3: resume occupancy skips cron and releases on terminal', () => {
  it('256 restored cron jobs do not fill the HTTP resume registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-resume-cron-'))
    try {
      const s1 = openStore(dir)
      for (let i = 0; i < 256; i++) {
        const created = s1.create('main', {
          queued: true,
          kind: 'cron',
          sessionKey: `agent:main:cron:dm:job:${i}`,
          idempotencyKey: `cron:job-${i}:1`,
        })
        assert.ok('jobId' in created)
      }
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const registry = new DelegateResumeRegistry()
      restoreResumeOccupancyFromJobs(registry, s2)
      assert.equal(registry.reservedSize(), 0)
      assert.equal(registry.size(), 0)
      for (const job of s2.listNonTerminal()) {
        const claimed = s2.claimQueued(job.id)
        assert.equal(claimed.ok, true)
        if (!claimed.ok) continue
        assert.equal(
          s2.complete(job.id, { httpStatus: 200, body: { ok: true } }, claimed),
          true,
        )
      }
      const fresh = registry.preflight({
        parentSessionKey: 'agent:main:webchat:dm:p1',
        targetAgentId: 'coding-assistant',
        sourceAgent: 'main',
      })
      assert.equal(fresh.ok, true)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('store terminal releases restored delegate occupancy so preflight is not 503', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-resume-rel-'))
    try {
      const sessionKey = 'agent:coding-assistant:delegate:main:1:rel'
      const registry = new DelegateResumeRegistry({ maxBindings: 1 })
      const s1 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:g0',
        onTerminal: (job) => {
          if (job.sessionKey) registry.release(job.sessionKey)
        },
      })
      const created = s1.create('coding-assistant', {
        queued: true,
        kind: 'delegate',
        sessionKey,
        parentSessionKey: 'agent:main:webchat:dm:p1',
        idempotencyKey: 'resume:rel:1',
      })
      assert.ok('jobId' in created)
      s1.close()
      const s2 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:g1',
        onTerminal: (job) => {
          if (job.sessionKey) registry.release(job.sessionKey)
        },
      })
      restoreResumeOccupancyFromJobs(registry, s2)
      assert.equal(registry.reservedSize(), 1)
      const claimed = s2.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (claimed.ok) {
        assert.equal(
          s2.complete(created.jobId, { httpStatus: 200, body: { ok: true } }, claimed),
          true,
        )
      }
      assert.equal(registry.reservedSize(), 0)
      const fresh = registry.preflight({
        parentSessionKey: 'agent:main:webchat:dm:other',
        targetAgentId: 'coding-assistant',
        sourceAgent: 'main',
      })
      assert.equal(fresh.ok, true)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 4: cron claim failure is fail-closed', () => {
  it('queued cron stays claimable after G1 boot (no adopted token to block claim)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-queued-claim-'))
    try {
      const s1 = openStore(dir, { bootId: 'gw:g0' })
      const enq = enqueueCronOccurrenceJob(s1, {
        cronJobId: 'nightly-queued',
        dueMinuteKey: 1_700_000_222,
        agentId: 'main',
      })
      assert.ok(!('error' in enq))
      if ('error' in enq) return
      assert.equal(s1.snapshotOf(enq.jobId)?.claimToken, undefined)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const summary = reconcileDelegateJobsOnBoot(s2)
      assert.equal(s2.snapshotOf(enq.jobId)?.state, 'queued')
      assert.equal(s2.snapshotOf(enq.jobId)?.claimToken, undefined)
      assert.equal(summary.adopted, 0)
      const fence = claimCronDelegateExecution(s2, enq.jobId)
      assert.equal(typeof fence.claimToken, 'string')
      assert.equal(fence.claimToken.length, 64)
      assert.equal(s2.snapshotOf(enq.jobId)?.state, 'running')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('claimCronDelegateExecution throws after killed_by_cutover and does not mint a fence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-claim-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const enq = enqueueCronOccurrenceJob(s1, {
        cronJobId: 'nightly',
        dueMinuteKey: 1_700_000_000,
        agentId: 'main',
      })
      assert.ok(!('error' in enq))
      if ('error' in enq) return
      const claimed = s1.claimQueued(enq.jobId)
      assert.equal(claimed.ok, true)
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      reconcileDelegateJobsOnBoot(s2, { now: () => now })
      assert.equal(s2.snapshotOf(enq.jobId)?.state, 'killed_by_cutover')
      assert.throws(
        () => claimCronDelegateExecution(s2, enq.jobId),
        (err: unknown) => err instanceof CronDelegateClaimDeniedError && err.reason === 'terminal',
      )
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 5: skipped_silent is one durable CAS', () => {
  it('HEARTBEAT_OK writes completed + skipped_silent in a single update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-silent-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      const db = new DelegateDurableDb(path)
      let writes = 0
      const orig = db.casUpdate.bind(db)
      db.casUpdate = ((...args: Parameters<DelegateDurableDb['casUpdate']>) => {
        writes += 1
        return orig(...args)
      }) as DelegateDurableDb['casUpdate']
      const store = new DelegateJobStore({ sm: true, durable: db, bootId: 'gw:t' })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'hb',
        dueMinuteKey: 1_700_000_111,
        agentId: 'main',
      })
      assert.ok(!('error' in enq))
      if ('error' in enq) return
      const claimed = store.claimQueued(enq.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) return
      writes = 0
      assert.equal(
        settleCronDelegateJob(store, enq.jobId, 'skipped_silent', claimed),
        true,
      )
      assert.equal(writes, 1)
      const row = db.get(enq.jobId)
      assert.equal(row?.state, 'completed')
      assert.equal(row?.callbackState, 'skipped_silent')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('blocker 6: restart callback uses durable result', () => {
  it('success and failure payloads are reconstructed from the job row', () => {
    assert.deepEqual(
      callbackPayloadFromDurableJob({
        state: 'completed',
        result: { body: { output: 'UNIQUE_OUTPUT' } },
      }),
      { output: 'UNIQUE_OUTPUT' },
    )
    assert.deepEqual(
      callbackPayloadFromDurableJob({
        state: 'failed',
        failureClass: 'child_error',
        failureDetail: 'upstream 402',
        result: { body: { error: 'upstream 402' } },
      }),
      { error: 'upstream 402' },
    )
    assert.deepEqual(
      callbackPayloadFromDurableJob({
        state: 'completed',
        result: { body: { ok: false, output: '', error: 'child exploded' } },
      }),
      { error: 'child exploded' },
    )
  })

  it('ensureCallback injects durable output instead of empty completed text', async () => {
    const gw = Object.create(Gateway.prototype) as any
    gw.log = { debug() {}, info() {}, warn() {}, error() {} }
    const captured: Array<{ output?: string; error?: string }> = []
    gw.injectSendToAgentCallback = async (args: { output?: string; error?: string }) => {
      captured.push({ output: args.output, error: args.error })
      return { kind: 'injected' }
    }
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', {
      queued: true,
      callback: 'origin-inject',
    })
    assert.ok('jobId' in created)
    const claimed = store.claimQueued(created.jobId)
    assert.equal(claimed.ok, true)
    if (!claimed.ok) return
    assert.equal(
      store.complete(
        created.jobId,
        { httpStatus: 200, body: { ok: true, output: 'UNIQUE_OUTPUT' } },
        claimed,
      ),
      true,
    )
    gw._delegateJobs = store
    const ok = await gw._ensureDurableSendToAgentCallback(store.snapshotOf(created.jobId), {
      v: 1,
      jobId: created.jobId,
      originSessionKey: 'agent:main:webchat:dm:sess-1',
      agentId: 'coding-assistant',
      goal: 'x',
      createdAt: 1,
    })
    assert.equal(ok, true)
    assert.deepEqual(captured, [{ output: 'UNIQUE_OUTPUT', error: undefined }])
    store.close()
  })

  it('ensureCallback injects durable failure instead of fake completed-empty text', async () => {
    const gw = Object.create(Gateway.prototype) as any
    gw.log = { debug() {}, info() {}, warn() {}, error() {} }
    const captured: Array<{ output?: string; error?: string }> = []
    gw.injectSendToAgentCallback = async (args: { output?: string; error?: string }) => {
      captured.push({ output: args.output, error: args.error })
      return { kind: 'injected' }
    }
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', {
      queued: true,
      callback: 'origin-inject',
    })
    assert.ok('jobId' in created)
    const claimed = store.claimQueued(created.jobId)
    assert.equal(claimed.ok, true)
    if (!claimed.ok) return
    assert.equal(
      store.fail(created.jobId, {
        failureClass: 'child_error',
        detail: 'upstream 402',
        httpStatus: 502,
        claimToken: claimed.claimToken,
        fencingEpoch: claimed.fencingEpoch,
      }),
      true,
    )
    gw._delegateJobs = store
    const ok = await gw._ensureDurableSendToAgentCallback(store.snapshotOf(created.jobId), {
      v: 1,
      jobId: created.jobId,
      originSessionKey: 'agent:main:webchat:dm:sess-1',
      agentId: 'coding-assistant',
      goal: 'x',
      createdAt: 1,
    })
    assert.equal(ok, true)
    assert.deepEqual(captured, [{ output: undefined, error: 'upstream 402' }])
    store.close()
  })
})

describe('blocker 7: flag quadrants and baseline JSON DTO', () => {
  const baselinePersistKeys = [
    'id',
    'agentId',
    'state',
    'sessionKey',
    'failureClass',
    'failureDetail',
    'claimToken',
    'fencingEpoch',
    'attemptNo',
    'ownerInstanceId',
    'ownerLeaseUntil',
    'checkpointKind',
    'callback',
    'callbackState',
    'callbackEpoch',
    'idempotencyKey',
    'kind',
    'generation',
  ]

  it('snapshotsForPersist omits durable-only fields (byte-equivalent DTO)', () => {
    const store = new DelegateJobStore({
      sm: true,
      now: () => 1_700_000_000_000,
    })
    const created = store.create('coding-assistant', {
      queued: true,
      sessionKey: 'agent:coding-assistant:delegate:main:1:aaaa',
      parentSessionKey: 'agent:main:webchat:dm:p1',
    })
    assert.ok('jobId' in created)
    const snap = store.snapshotsForPersist()[0]
    const json = JSON.stringify(snap)
    assert.equal(json.includes('"result"'), false)
    assert.equal(json.includes('"expiresAt"'), false)
    assert.equal(json.includes('"createdAt"'), false)
    assert.equal(json.includes('"lastActivityAt"'), false)
    assert.equal(json.includes('"parentSessionKey"'), false)
    for (const key of Object.keys(snap)) {
      assert.ok(baselinePersistKeys.includes(key), `unexpected persist key ${key}`)
    }
    store.close()
  })

  it('four-quadrant predicates: only SM=1 and DURABLE=1 opens SQLite', () => {
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      [undefined, undefined, false],
      ['0', '0', false],
      ['0', '1', false],
      ['1', '0', false],
      ['1', '1', true],
    ]
    for (const [sm, durable, expected] of cases) {
      const env = {
        ...(sm === undefined ? {} : { OC_DELEGATE_SM: sm }),
        ...(durable === undefined ? {} : { OC_DELEGATE_DURABLE: durable }),
      }
      assert.equal(
        isDelegateDurableEffective(env),
        expected,
        `SM=${sm} DURABLE=${durable}`,
      )
    }
  })

  it('SM=1 DURABLE=1 persist path is SQLite, not JSON snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-quad-sql-'))
    try {
      const dbPath = join(dir, 'delegate-jobs.db')
      const snapDir = join(dir, 'json-snaps')
      await mkdir(snapDir, { recursive: true })
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        bootId: 'gw:quad',
      })
      const created = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      const names = await readdir(snapDir)
      assert.equal(names.length, 0)
      const observer = new DelegateDurableDb(dbPath)
      assert.equal(observer.get(created.jobId)?.state, 'queued')
      observer.close()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('SM=0 DURABLE=1 still writes JSON snapshots (does not skip both stores)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-quad-'))
    const prevSm = process.env.OC_DELEGATE_SM
    const prevD = process.env.OC_DELEGATE_DURABLE
    const prevSnap = process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR
    process.env.OC_DELEGATE_SM = '0'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR = dir
    try {
      assert.equal(isDelegateDurableEffective(), false)
      const gw = Object.create(Gateway.prototype) as any
      gw.log = { debug() {}, info() {}, warn() {}, error() {} }
      gw._activeSendToAgentCallbacks = new Map()
      const store = new DelegateJobStore({ sm: false, ttlMs: 60_000 })
      const created = store.create('coding-assistant', { sessionKey: 'sk' })
      assert.ok('jobId' in created)
      gw._delegateJobs = store
      const n = await persistDelegateJobSnapshots(store, {
        OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR: dir,
      } as NodeJS.ProcessEnv)
      assert.equal(n, 1)
      const names = await readdir(dir)
      assert.equal(names.length, 1)
      const raw = await readFile(join(dir, names[0]!), 'utf8')
      assert.equal(raw.includes('"result"'), false)
      assert.equal(raw.includes('"createdAt"'), false)
      store.close()
    } finally {
      if (prevSm === undefined) delete process.env.OC_DELEGATE_SM
      else process.env.OC_DELEGATE_SM = prevSm
      if (prevD === undefined) delete process.env.OC_DELEGATE_DURABLE
      else process.env.OC_DELEGATE_DURABLE = prevD
      if (prevSnap === undefined) delete process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR
      else process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR = prevSnap
      await rm(dir, { recursive: true, force: true })
    }
  })
})

