import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

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

import {
  DelegateJobStore,
  DELEGATE_LEASE_HEARTBEAT_MAX_BEATS,
  resolveDelegateHeartbeatTimeoutMs,
} from '../delegateJobs.js'
import { DelegateDurableDb, resolveDelegateLedgerRetentionMs } from '../delegateDurable.js'
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
import { backfillCronOccurrenceDelegateJobs, startCronDelegateHeartbeat } from '../cron.js'
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
    const gw = sandbox.trackGateway(Object.create(Gateway.prototype) as any)
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
    const gw = sandbox.trackGateway(Object.create(Gateway.prototype) as any)
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
      const gw = sandbox.trackGateway(Object.create(Gateway.prototype) as any)
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


/**
 * OCV5-164: the ledger must survive the 2h job TTL for process auditing, and a
 * `running` row with no heartbeat must not pin a Grok delegate lease forever.
 */
describe('OCV5-164 ledger retention + heartbeat reaper', () => {
  it('retires terminal rows at TTL instead of deleting, keeping 7d of history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-retain-'))
    try {
      let clock = 1_000_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        durable,
        bootId: 'gw:retain',
        now: () => clock,
      })
      const created = store.create('coding-assistant', { sessionKey: 'sk-retain' })
      assert.ok('jobId' in created)
      const jobId = created.jobId
      const snap0 = store.snapshotOf(jobId)!
      assert.equal(
        store.complete(
          jobId,
          { httpStatus: 200, body: { ok: true } },
          { claimToken: snap0.claimToken!, fencingEpoch: snap0.fencingEpoch },
        ),
        true,
      )

      // Before TTL: the row is live and readable through the normal API.
      assert.equal(store.get(jobId).status, 'done')

      // Past TTL: the handle is gone (unchanged behaviour) …
      clock += 61_000
      assert.equal(store.sweep(), 1)
      assert.equal(store.get(jobId).status, 'expired')
      assert.equal(durable.get(jobId), undefined, 'retired rows are invisible to runtime reads')
      assert.equal(store.nonTerminalCount(), 0)

      // … but the audit ledger still has it (this is the OCV5-164 fix).
      const stats = store.ledgerStats()
      assert.equal(stats.total, 1)
      assert.equal(stats.live, 0)
      assert.equal(stats.retired, 1)
      const retired = durable.loadRetired()
      assert.equal(retired.length, 1)
      assert.equal(retired[0]!.id, jobId)
      assert.equal(retired[0]!.state, 'completed')

      // A row 6d old is inside the 7d window → kept.
      clock += 6 * 24 * 60 * 60_000
      assert.equal(store.pruneRetiredLedger({ retentionMs: 7 * 24 * 60 * 60_000 }), 0)
      assert.equal(store.ledgerStats().total, 1)

      // 8d old and past the row-count floor → pruned.
      clock += 2 * 24 * 60 * 60_000
      assert.equal(
        store.pruneRetiredLedger({ retentionMs: 7 * 24 * 60 * 60_000, keepRows: 0 }),
        1,
      )
      assert.equal(store.ledgerStats().total, 0)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('newest-N floor keeps rows the time window would drop ("取宽")', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-floor-'))
    try {
      let clock = 1_000_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 1_000,
        durable,
        bootId: 'gw:floor',
        now: () => clock,
      })
      const created = store.create('coding-assistant', { sessionKey: 'sk-floor' })
      assert.ok('jobId' in created)
      const floorSnap = store.snapshotOf(created.jobId)!
      assert.equal(
        store.complete(
          created.jobId,
          { httpStatus: 200, body: { ok: true } },
          { claimToken: floorSnap.claimToken!, fencingEpoch: floorSnap.fencingEpoch },
        ),
        true,
      )
      clock += 2_000
      assert.equal(store.sweep(), 1)
      clock += 30 * 24 * 60 * 60_000
      // Well past the window, but the default floor keeps the newest rows.
      assert.equal(store.pruneRetiredLedger({ retentionMs: 7 * 24 * 60 * 60_000 }), 0)
      assert.equal(store.ledgerStats().retired, 1)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reaps a running row idle past the heartbeat timeout; 29min is left alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-reap-'))
    try {
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:reap', now: () => clock })
      const created = store.create('coding-assistant', { sessionKey: 'sk-reap' })
      assert.ok('jobId' in created)
      const jobId = created.jobId

      // 29 minutes idle: under the 30min limit, must not be touched.
      clock += 29 * 60_000
      assert.deepEqual(store.reapStaleRunning({ timeoutMs: 30 * 60_000 }), [])
      assert.equal(store.snapshotOf(jobId)?.state, 'running')

      // 31 minutes idle: reaped through the normal terminal path.
      clock += 2 * 60_000
      const reaped = store.reapStaleRunning({ timeoutMs: 30 * 60_000 })
      assert.equal(reaped.length, 1)
      assert.equal(reaped[0]!.job.id, jobId)
      assert.equal(reaped[0]!.job.state, 'failed')
      assert.equal(reaped[0]!.job.failureClass, 'heartbeat_timeout')
      assert.match(String(reaped[0]!.job.failureDetail), /idle 1860s/)
      // idleSec is captured before fail() rewrites last_activity_at (W2).
      assert.equal(reaped[0]!.idleSec, 1860)
      // Terminal ⇒ the row no longer occupies delegate capacity.
      assert.equal(store.nonTerminalCount(), 0)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reaps an idle kind=cron row (the OCV5-164 lease-pinning case)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-reap-cron-'))
    try {
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:reapcron', now: () => clock })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-1',
        dueMinuteKey: 42,
        agentId: 'coding-assistant',
        sessionKey: 'sk-cron',
      })
      assert.ok('jobId' in enq)
      const fence = claimCronDelegateExecution(store, enq.jobId)
      assert.equal(store.snapshotOf(enq.jobId)?.state, 'running')

      // A live occurrence pushes last_activity_at forward, so it is spared.
      clock += 25 * 60_000
      assert.equal(store.touchActivity(enq.jobId, fence), true)
      clock += 25 * 60_000
      assert.deepEqual(store.reapStaleRunning({ timeoutMs: 30 * 60_000 }), [])

      // No further progress for >30min ⇒ reaped, matching the 7.3h idle cron row.
      clock += 10 * 60_000
      const reaped = store.reapStaleRunning({ timeoutMs: 30 * 60_000 })
      assert.equal(reaped.length, 1)
      assert.equal(reaped[0]!.job.kind, 'cron')
      assert.equal(reaped[0]!.job.failureClass, 'heartbeat_timeout')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('touchActivity moves last_activity_at forward and needs the fence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-touch-'))
    try {
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:touch', now: () => clock })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-2',
        dueMinuteKey: 7,
        agentId: 'coding-assistant',
        sessionKey: 'sk-touch',
      })
      assert.ok('jobId' in enq)
      const fence = claimCronDelegateExecution(store, enq.jobId)
      const before = store.snapshotOf(enq.jobId)?.lastActivityAt
      clock += 5 * 60_000
      // A wrong fence must not be able to fake liveness.
      assert.equal(
        store.touchActivity(enq.jobId, { claimToken: 'bogus', fencingEpoch: fence.fencingEpoch }),
        false,
      )
      assert.equal(store.snapshotOf(enq.jobId)?.lastActivityAt, before)
      assert.equal(store.touchActivity(enq.jobId, fence), true)
      assert.equal(store.snapshotOf(enq.jobId)?.lastActivityAt, clock)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not steal a row another live instance still owns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-reap-fence-'))
    try {
      let clock = 1_000_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      // Lease far longer than the idle limit: the only way to get
      // "idle past timeout" while the owner's lease is still valid.
      const other = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 2 * 60 * 60_000,
        durable,
        bootId: 'gw:other',
        now: () => clock,
      })
      const created = other.create('coding-assistant', { sessionKey: 'sk-other' })
      assert.ok('jobId' in created)
      clock += 31 * 60_000
      const mine = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 2 * 60 * 60_000,
        durable,
        bootId: 'gw:mine',
        now: () => clock,
      })
      const owned = mine.snapshotOf(created.jobId)!
      assert.equal(owned.ownerInstanceId, 'gw:other')
      assert.ok(owned.ownerLeaseUntil! > clock, 'owner lease must still be live')
      // Idle > timeout, but the owner is alive ⇒ leave it to its owner.
      assert.deepEqual(mine.reapStaleRunning({ timeoutMs: 30 * 60_000 }), [])
      assert.equal(mine.snapshotOf(created.jobId)?.state, 'running')
      // Once that lease lapses, the row is reapable.
      clock += 3 * 60 * 60_000
      assert.equal(mine.reapStaleRunning({ timeoutMs: 30 * 60_000 }).length, 1)
      mine.close()
      other.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retention window is env-overridable and clamped', () => {
    assert.equal(resolveDelegateLedgerRetentionMs({}), 7 * 24 * 60 * 60_000)
    assert.equal(
      resolveDelegateLedgerRetentionMs({ OC_DELEGATE_LEDGER_RETENTION_DAYS: '14' }),
      14 * 24 * 60 * 60_000,
    )
    // Below the 1d floor / above the 90d ceiling is clamped, not honoured.
    assert.equal(
      resolveDelegateLedgerRetentionMs({ OC_DELEGATE_LEDGER_RETENTION_DAYS: '0.1' }),
      24 * 60 * 60_000,
    )
    assert.equal(
      resolveDelegateLedgerRetentionMs({ OC_DELEGATE_LEDGER_RETENTION_DAYS: '999' }),
      90 * 24 * 60 * 60_000,
    )
    assert.equal(
      resolveDelegateLedgerRetentionMs({ OC_DELEGATE_LEDGER_RETENTION_DAYS: 'nonsense' }),
      7 * 24 * 60 * 60_000,
    )
  })

  it('heartbeat timeout is env-overridable and clamped', () => {
    assert.equal(resolveDelegateHeartbeatTimeoutMs({}), 30 * 60_000)
    assert.equal(
      resolveDelegateHeartbeatTimeoutMs({ OC_DELEGATE_HEARTBEAT_TIMEOUT_MS: '600000' }),
      600_000,
    )
    assert.equal(
      resolveDelegateHeartbeatTimeoutMs({ OC_DELEGATE_HEARTBEAT_TIMEOUT_MS: '1000' }),
      5 * 60_000,
    )
  })

  it('a retired cron occurrence key can be re-enqueued (was true when rows were deleted)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-idem-'))
    try {
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:idem', now: () => clock })
      const first = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-3',
        dueMinuteKey: 99,
        agentId: 'coding-assistant',
      })
      assert.ok('jobId' in first)
      const fence = claimCronDelegateExecution(store, first.jobId)
      assert.equal(
        settleCronDelegateJob(store, first.jobId, 'completed', fence, undefined, undefined, {
          callbackState: 'delivered',
        }),
        true,
      )
      clock += 61_000
      assert.equal(store.sweep(), 1)
      // Same occurrence key after retirement must not hit a UNIQUE violation.
      const again = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-3',
        dueMinuteKey: 99,
        agentId: 'coding-assistant',
      })
      assert.ok('jobId' in again)
      assert.notEqual(again.jobId, first.jobId)
      assert.equal(again.reused, false)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * OCV5-164 r1: the reaper judges `last_activity_at`, so a claimed cron
 * occurrence needs a *timer* heartbeat. Protocol events are not one —
 * `tool_use_detected` is consumed inside sessionManager and never reaches
 * `onEvent`, so a legitimate long tool call emits nothing for far longer than
 * the timeout. These use a real `setInterval` (short cadence) + real sqlite.
 */
describe('OCV5-164 cron delegate heartbeat', () => {
  it('keeps a silent occurrence alive, and stops protecting it once halted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-hb-'))
    try {
      const store = openStore(dir, { bootId: 'gw:hb' })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-hb',
        dueMinuteKey: 1,
        agentId: 'coding-assistant',
        sessionKey: 'agent:coding-assistant:cron:dm:cron-hb:d1',
      })
      assert.ok('jobId' in enq)
      const fence = claimCronDelegateExecution(store, enq.jobId)
      const claimedAt = store.snapshotOf(enq.jobId)!.lastActivityAt!

      const hb = startCronDelegateHeartbeat({
        store,
        jobId: enq.jobId,
        fence,
        sessionKey: 'agent:coding-assistant:cron:dm:cron-hb:d1',
        intervalMs: 5,
      })
      // Simulate a long tool call: 120ms of work with zero protocol events.
      await new Promise((r) => setTimeout(r, 120))
      assert.ok(hb.beats() > 0, 'heartbeat must actually beat')
      const afterBeats = store.snapshotOf(enq.jobId)!.lastActivityAt!
      assert.ok(afterBeats > claimedAt, 'last_activity_at must move forward')
      // A 30ms idle limit would have killed this row without the heartbeat.
      assert.deepEqual(store.reapStaleRunning({ timeoutMs: 30 }), [])
      assert.equal(store.snapshotOf(enq.jobId)?.state, 'running')

      // Once execution ends the beat stops, and the row becomes reapable again.
      hb.stop()
      const frozen = store.snapshotOf(enq.jobId)!.lastActivityAt!
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(store.snapshotOf(enq.jobId)!.lastActivityAt, frozen, 'stop() must stop writes')
      const reaped = store.reapStaleRunning({ timeoutMs: 30 })
      assert.equal(reaped.length, 1)
      assert.equal(reaped[0]!.job.failureClass, 'heartbeat_timeout')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('interrupts the child session when the fence is gone (row already reaped)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-hb-fence-'))
    try {
      const store = openStore(dir, { bootId: 'gw:hbfence' })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-hb2',
        dueMinuteKey: 2,
        agentId: 'coding-assistant',
        sessionKey: 'sk-hb2',
      })
      assert.ok('jobId' in enq)
      claimCronDelegateExecution(store, enq.jobId)
      const interrupted: string[] = []
      const warnings: string[] = []
      const hb = startCronDelegateHeartbeat({
        store,
        jobId: enq.jobId,
        // Wrong token: stands in for "the reaper already settled this row".
        fence: { claimToken: 'stale-token', fencingEpoch: 99 },
        sessionKey: 'sk-hb2',
        intervalMs: 5,
        interrupt: (key) => {
          interrupted.push(key)
          return true
        },
        log: { warn: (msg) => warnings.push(msg) },
      })
      await new Promise((r) => setTimeout(r, 60))
      assert.deepEqual(interrupted, ['sk-hb2'], 'child must be interrupted exactly once')
      assert.equal(hb.beats(), 1, 'beating must stop after the first rejected touch')
      assert.ok(warnings.some((w) => w.includes('interrupted child session')))
      hb.stop()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('warns instead of throwing when the child sessionKey is unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-hb-nokey-'))
    try {
      const store = openStore(dir, { bootId: 'gw:hbnokey' })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-hb3',
        dueMinuteKey: 3,
        agentId: 'coding-assistant',
      })
      assert.ok('jobId' in enq)
      claimCronDelegateExecution(store, enq.jobId)
      const warnings: string[] = []
      const hb = startCronDelegateHeartbeat({
        store,
        jobId: enq.jobId,
        fence: { claimToken: 'stale-token', fencingEpoch: 99 },
        intervalMs: 5,
        log: { warn: (msg) => warnings.push(msg) },
      })
      await new Promise((r) => setTimeout(r, 60))
      assert.ok(warnings.some((w) => w.includes('child sessionKey missing')))
      hb.stop()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('honours the beat hard cap so a leaked interval cannot slide liveness forever', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-cron-hb-cap-'))
    try {
      const store = openStore(dir, { bootId: 'gw:hbcap' })
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'cron-hb4',
        dueMinuteKey: 4,
        agentId: 'coding-assistant',
        sessionKey: 'sk-hb4',
      })
      assert.ok('jobId' in enq)
      const fence = claimCronDelegateExecution(store, enq.jobId)
      const interrupted: string[] = []
      const hb = startCronDelegateHeartbeat({
        store,
        jobId: enq.jobId,
        fence,
        sessionKey: 'sk-hb4',
        intervalMs: 2,
        maxBeats: 3,
        interrupt: (key) => {
          interrupted.push(key)
          return true
        },
      })
      await new Promise((r) => setTimeout(r, 80))
      assert.deepEqual(interrupted, ['sk-hb4'], 'hard cap must close out the child')
      assert.equal(hb.beats(), 4, 'stops on the beat that exceeds the cap')
      hb.stop()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * OCV5-164 r1: the server-side reaper wiring itself (W3 gap). Uses the real
 * `_armDelegateReaper` on a Gateway scaffold so the interval, the interrupt
 * closeout and the log payload are exercised, not just the store method.
 */
describe('OCV5-164 reaper wiring interrupts the child session', () => {
  it('interrupts a reaped row and logs the pre-reap idleSec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-reap-wire-'))
    const prevTimeout = process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS
    try {
      // 5min floor is the lowest the env knob allows; drive the clock past it.
      process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS = '300000'
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:wire', now: () => clock })
      const created = store.create('coding-assistant', { sessionKey: 'sk-wire' })
      assert.ok('jobId' in created)

      const interrupted: string[] = []
      const logs: Array<{ msg: string; meta: Record<string, unknown> }> = []
      const gw = sandbox.trackGateway(Object.create(Gateway.prototype) as any)
      gw.log = {
        debug() {},
        info() {},
        error() {},
        warn: (msg: string, meta: Record<string, unknown>) => logs.push({ msg, meta }),
      }
      gw.sessions = {
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      }
      gw._armDelegateReaper(store)
      assert.ok(gw._delegateReapTimer, 'reaper interval must be armed')

      // Advance past the timeout, then run one tick the way the interval does.
      clock += 6 * 60_000
      gw._delegateReapTimer._onTimeout()

      assert.deepEqual(interrupted, ['sk-wire'], 'reaped child must be interrupted')
      const reapLog = logs.find((l) => l.msg === 'delegate_heartbeat_timeout_reaped')
      assert.ok(reapLog, 'reap must be logged')
      assert.equal(reapLog!.meta.jobId, created.jobId)
      assert.equal(reapLog!.meta.sessionKey, 'sk-wire')
      assert.equal(reapLog!.meta.failureClass, 'heartbeat_timeout')
      assert.equal(reapLog!.meta.interrupted, true)
      // W2: idleSec is the real idle span, not ~0 measured after fail().
      assert.equal(reapLog!.meta.idleSec, 360)
      assert.equal(store.snapshotOf(created.jobId)?.state, 'failed')

      clearInterval(gw._delegateReapTimer)
      store.close()
    } finally {
      if (prevTimeout === undefined) delete process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS
      else process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS = prevTimeout
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('survives an interrupt that throws, and still logs the reap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-reap-wire-throw-'))
    const prevTimeout = process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS
    try {
      process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS = '300000'
      let clock = 1_000_000
      const store = openStore(dir, { bootId: 'gw:wirethrow', now: () => clock })
      const created = store.create('coding-assistant', { sessionKey: 'sk-throw' })
      assert.ok('jobId' in created)
      const logs: string[] = []
      const gw = sandbox.trackGateway(Object.create(Gateway.prototype) as any)
      gw.log = {
        debug() {},
        info() {},
        error() {},
        warn: (msg: string) => logs.push(msg),
      }
      gw.sessions = {
        interrupt: () => {
          throw new Error('session gone')
        },
      }
      gw._armDelegateReaper(store)
      clock += 6 * 60_000
      gw._delegateReapTimer._onTimeout()
      assert.ok(logs.includes('delegate_heartbeat_timeout_interrupt_failed'))
      assert.ok(logs.includes('delegate_heartbeat_timeout_reaped'))
      // The ledger write must stand even when the interrupt failed.
      assert.equal(store.snapshotOf(created.jobId)?.state, 'failed')
      clearInterval(gw._delegateReapTimer)
      store.close()
    } finally {
      if (prevTimeout === undefined) delete process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS
      else process.env.OC_DELEGATE_HEARTBEAT_TIMEOUT_MS = prevTimeout
      await rm(dir, { recursive: true, force: true })
    }
  })
})
