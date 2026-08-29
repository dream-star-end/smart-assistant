/**
 * OCV5-22 stage 1: durable SQLite + reconciler. No real grok processes.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateDurable.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import { isDelegateDurableEnabled } from '../delegateSmFlag.js'
import {
  reconcileDelegateJobsOnBoot,
  restoreResumeOccupancyFromJobs,
} from '../delegateReconciler.js'
import { DelegateResumeRegistry } from '../delegateResume.js'
import { enqueueCronOccurrenceJob } from '../delegateCronIdempotency.js'
import { backfillCronOccurrenceDelegateJobs } from '../cron.js'

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
