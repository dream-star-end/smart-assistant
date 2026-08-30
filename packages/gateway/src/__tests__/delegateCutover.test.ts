/**
 * OCV5-22 stage 3: BeginCutover freeze, recycle drain runningDelegateJobs,
 * restart ClaimPaused / unrecoverable killed_by_cutover + Notifier.
 * No real engine processes.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateCutover.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DelegateDurableDb } from '../delegateDurable.js'
import {
  beginDelegateCutover,
  endDelegateCutover,
  isDelegateRunnerIdle,
  resolveDelegateCutoverFreezeMs,
} from '../delegateCutover.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { dispatchJobTerminalNotify } from '../delegateNotifyDispatch.js'
import { reconcileDelegateJobsOnBoot, restoreResumeOccupancyFromJobs } from '../delegateReconciler.js'
import { DelegateResumeRegistry } from '../delegateResume.js'
import {
  isDelegateCutoverEffective,
  isDelegateCutoverEnabled,
  isDelegateNotifierEffective,
} from '../delegateSmFlag.js'
import { DefaultEngineNotifier } from '../engineNotifier.js'
import { attemptRuntimeRecycleDrain, type RuntimeRecycleDrainDeps } from '../runtimeRecycleDrain.js'

function openStore(dir: string, opts: { bootId?: string; now?: () => number } = {}) {
  const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
  return new DelegateJobStore({
    sm: true,
    ttlMs: 60_000,
    leaseMs: 1_000,
    durable,
    bootId: opts.bootId ?? 'gw:c0',
    now: opts.now,
  })
}

async function runningJob(
  store: DelegateJobStore,
  meta: { sessionKey?: string; callback?: 'origin-inject' | 'stdout-wait'; parentEngine?: string } = {},
) {
  const created = store.create('coding-assistant', {
    queued: true,
    sessionKey: meta.sessionKey,
    parentSessionKey: 'agent:main:webchat:dm:p1',
    callback: meta.callback ?? 'origin-inject',
    parentEngine: meta.parentEngine ?? 'cursor',
    callbackOriginSessionKey: 'agent:main:webchat:dm:p1',
  })
  assert.ok('jobId' in created)
  const claimed = store.claimQueued(created.jobId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) throw new Error('claim failed')
  return { jobId: created.jobId, fence: claimed, snap: store.snapshotOf(created.jobId)! }
}

function drainHarness(overrides: Partial<RuntimeRecycleDrainDeps> = {}) {
  let now = 1_000
  let gatewayUntil = 0
  let sessionUntil = 0
  const ttlMs = 10_000
  const deps: RuntimeRecycleDrainDeps = {
    ttlMs,
    now: () => now,
    armGatewayDrain: (until) => {
      gatewayUntil = until
    },
    isGatewayDrainActive: (at) => gatewayUntil > at,
    releaseGatewayDrain: () => {
      gatewayUntil = 0
    },
    armSessionDrain: (ttl) => {
      sessionUntil = now + ttl
      return { accepted: true, activeTurns: 0 }
    },
    isSessionDrainActive: (at) => sessionUntil > at,
    releaseSessionDrain: () => {
      sessionUntil = 0
    },
    activeIngress: () => 0,
    countDurableRunning: async () => 0,
    ...overrides,
  }
  return { deps, setNow: (value: number) => { now = value } }
}

describe('OC_DELEGATE_CUTOVER flag', () => {
  it('defaults off and requires SM && DURABLE && NOTIFIER && CUTOVER', () => {
    assert.equal(isDelegateCutoverEnabled({}), false)
    assert.equal(isDelegateCutoverEffective({}), false)
    assert.equal(isDelegateCutoverEffective({ OC_DELEGATE_CUTOVER: '1' }), false)
    assert.equal(
      isDelegateCutoverEffective({
        OC_DELEGATE_SM: '1',
        OC_DELEGATE_DURABLE: '1',
        OC_DELEGATE_NOTIFIER: '1',
      }),
      false,
    )
    assert.equal(
      isDelegateNotifierEffective({
        OC_DELEGATE_SM: '1',
        OC_DELEGATE_DURABLE: '1',
        OC_DELEGATE_NOTIFIER: '1',
      }),
      true,
    )
    assert.equal(
      isDelegateCutoverEffective({
        OC_DELEGATE_SM: '1',
        OC_DELEGATE_DURABLE: '1',
        OC_DELEGATE_NOTIFIER: '1',
        OC_DELEGATE_CUTOVER: '1',
      }),
      true,
    )
    assert.equal(resolveDelegateCutoverFreezeMs({}), 30_000)
    assert.equal(resolveDelegateCutoverFreezeMs({ OC_DELEGATE_CUTOVER_FREEZE_MS: '0' }), 0)
  })
})

describe('BeginCutover Phase F', () => {
  it('idle running job pauses with runner_quiesced; old fence cannot complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-idle-'))
    try {
      const store = openStore(dir)
      const { jobId, fence } = await runningJob(store)
      const result = await beginDelegateCutover(store, {
        generation: 7,
        freezeBudgetMs: 1_000,
        isIdle: () => true,
      })
      assert.equal(result.quiesced, 1)
      assert.equal(result.timedOut, 0)
      assert.equal(result.remainingRunning, 0)
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.state, 'paused_for_cutover')
      assert.equal(snap.checkpointKind, 'runner_quiesced')
      assert.equal(snap.generation, 7)
      assert.equal(store.isDispatchFrozen(), true)
      assert.equal(
        store.complete(jobId, { httpStatus: 200, body: { ok: true } }, fence),
        false,
      )
      assert.equal(store.snapshotOf(jobId)?.state, 'paused_for_cutover')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('timeout pauses remaining running without kill or fail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-to-'))
    try {
      let now = 1_000
      const store = openStore(dir, { now: () => now })
      const { jobId } = await runningJob(store)
      const result = await beginDelegateCutover(store, {
        generation: 3,
        freezeBudgetMs: 50,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        pollMs: 25,
        isIdle: () => false,
      })
      assert.equal(result.quiesced, 0)
      assert.equal(result.timedOut, 1)
      assert.equal(result.paused, 1)
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.state, 'paused_for_cutover')
      assert.equal(snap.checkpointKind, 'none')
      assert.notEqual(snap.state, 'failed')
      assert.notEqual(snap.state, 'killed_by_cutover')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('freeze still allows enqueue but blocks claimQueued dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-q-'))
    try {
      const store = openStore(dir)
      await beginDelegateCutover(store, { freezeBudgetMs: 0, isIdle: () => false })
      const created = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      assert.equal(store.snapshotOf(created.jobId)?.state, 'queued')
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, false)
      if (!claimed.ok) assert.equal(claimed.reason, 'cutover_frozen')
      assert.equal(store.snapshotOf(created.jobId)?.state, 'queued')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('restart ClaimPaused / unrecoverable', () => {
  it('quiesced paused job is ClaimPaused to running after G1 boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-resume-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const { jobId } = await runningJob(s1, { sessionKey: 'agent:coding-assistant:delegate:main:1:cccc' })
      await beginDelegateCutover(s1, {
        generation: 9,
        freezeBudgetMs: 0,
        now: () => now,
        isIdle: () => true,
      })
      assert.equal(s1.snapshotOf(jobId)?.checkpointKind, 'runner_quiesced')
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const summary = reconcileDelegateJobsOnBoot(s2, { now: () => now, claimPaused: true })
      assert.equal(s2.snapshotOf(jobId)?.state, 'running')
      assert.equal(s2.snapshotOf(jobId)?.checkpointKind, 'none')
      assert.ok(summary.adopted >= 1)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('unquiesced paused job is killed_by_cutover with pending notify delivery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-kill-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const { jobId } = await runningJob(s1)
      await beginDelegateCutover(s1, {
        freezeBudgetMs: 0,
        now: () => now,
        isIdle: () => false,
      })
      assert.equal(s1.snapshotOf(jobId)?.checkpointKind, 'none')
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const summary = reconcileDelegateJobsOnBoot(s2, { now: () => now, claimPaused: true })
      const snap = s2.snapshotOf(jobId)!
      assert.equal(snap.state, 'killed_by_cutover')
      assert.equal(snap.failureClass, 'cutover')
      assert.equal(snap.callbackState, 'pending')
      assert.ok(snap.terminalCommittedAt)
      assert.ok(summary.killed >= 1)
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        s2,
        snap,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async (ev) => {
              injected += 1
              assert.equal(ev.state, 'killed_by_cutover')
              return { ok: true }
            },
          },
        }),
      )
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injected, 1)
      assert.equal(s2.snapshotOf(jobId)?.callbackState, 'delivered')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flag-off boot closes historical paused rows (no capacity/registry leak)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-flagoff-'))
    try {
      let now = 1_000
      const s1 = openStore(dir, { bootId: 'gw:g0', now: () => now })
      const { jobId } = await runningJob(s1, {
        sessionKey: 'agent:coding-assistant:delegate:main:1:flagoff',
      })
      await beginDelegateCutover(s1, { freezeBudgetMs: 0, now: () => now, isIdle: () => true })
      assert.equal(s1.snapshotOf(jobId)?.state, 'paused_for_cutover')
      s1.close()
      now = 50_000
      const s2 = openStore(dir, { bootId: 'gw:g1', now: () => now })
      const resume = new DelegateResumeRegistry()
      const summary = reconcileDelegateJobsOnBoot(s2, { now: () => now, claimPaused: false })
      const snap = s2.snapshotOf(jobId)!
      assert.equal(snap.state, 'killed_by_cutover')
      assert.equal(snap.callbackState, 'pending')
      assert.ok(snap.terminalCommittedAt)
      assert.ok(summary.killed >= 1)
      assert.equal(s2.nonTerminalCount(), 0)
      assert.equal(restoreResumeOccupancyFromJobs(resume, s2), 0)
      const retry = resume.preflight({
        resumeSessionKey: 'agent:coding-assistant:delegate:main:1:flagoff',
        parentSessionKey: 'agent:main:webchat:dm:p1',
        targetAgentId: 'coding-assistant',
        sourceAgent: 'main',
      })
      assert.equal(retry.ok, false)
      if (!retry.ok) assert.equal(retry.httpStatus, 400)
      now = 100_000
      const summary2 = reconcileDelegateJobsOnBoot(s2, { now: () => now, claimPaused: false })
      assert.equal(s2.snapshotOf(jobId)?.state, 'killed_by_cutover')
      assert.equal(summary2.adopted, 0)
      assert.equal(summary2.killed, 0)
      assert.equal(s2.nonTerminalCount(), 0)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('production idle / quiesce ACK (blocker 1)', () => {
  it('claim→spawn and submit→terminal windows are non-idle without ACK; false quiesce cannot drop terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-idle-prod-'))
    try {
      const store = openStore(dir)
      const { jobId, fence, snap } = await runningJob(store)
      assert.equal(store.isRunnerIdle(snap), false)
      assert.equal(isDelegateRunnerIdle(snap, store, null), false)
      assert.equal(
        isDelegateRunnerIdle(snap, store, { activeTurnCount: 0, activeClientTurnCount: 0 }),
        false,
      )
      const result = await beginDelegateCutover(store, {
        generation: 1,
        freezeBudgetMs: 0,
        isIdle: (job) => isDelegateRunnerIdle(job, store, null),
      })
      assert.equal(result.quiesced, 0)
      assert.equal(result.timedOut, 1)
      assert.equal(store.snapshotOf(jobId)?.checkpointKind, 'none')
      assert.equal(
        store.complete(jobId, { httpStatus: 200, body: { ok: true, output: 'done' } }, fence),
        false,
      )
      assert.equal(store.snapshotOf(jobId)?.state, 'paused_for_cutover')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('only current-fence quiesce ACK may write runner_quiesced; stale fence cannot ACK', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-ack-'))
    try {
      const store = openStore(dir)
      const { jobId, fence, snap } = await runningJob(store)
      assert.equal(store.ackRunnerQuiesced(jobId, 'wrong-token', fence.fencingEpoch), false)
      assert.equal(store.isRunnerIdle(snap), false)
      assert.equal(store.ackRunnerQuiesced(jobId, fence.claimToken, fence.fencingEpoch), true)
      assert.equal(store.isRunnerIdle(store.snapshotOf(jobId)!), true)
      const result = await beginDelegateCutover(store, {
        generation: 2,
        freezeBudgetMs: 0,
        isIdle: (job) => store.isRunnerIdle(job),
      })
      assert.equal(result.quiesced, 1)
      assert.equal(result.timedOut, 0)
      assert.equal(
        store.complete(jobId, { httpStatus: 200, body: { output: 'should-not-land' } }, fence),
        false,
      )
      const paused = store.snapshotOf(jobId)!
      assert.equal(paused.state, 'paused_for_cutover')
      assert.equal(paused.checkpointKind, 'runner_quiesced')
      assert.equal(paused.result, null)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('hydrated running job without ACK is not runner_quiesced (missing runner is not idle proof)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-idle-hydrate-'))
    try {
      const s1 = openStore(dir, { bootId: 'gw:g0' })
      const { jobId, fence } = await runningJob(s1)
      s1.close()
      const s2 = openStore(dir, { bootId: 'gw:g0' })
      const snap = s2.snapshotOf(jobId)!
      assert.equal(snap.state, 'running')
      assert.equal(s2.isRunnerIdle(snap), false)
      assert.equal(isDelegateRunnerIdle(snap, s2, null), false)
      assert.equal(
        isDelegateRunnerIdle(snap, s2, { activeTurnCount: 0, activeClientTurnCount: 0 }),
        false,
      )
      const result = await beginDelegateCutover(s2, {
        generation: 8,
        freezeBudgetMs: 0,
        isIdle: (job) => isDelegateRunnerIdle(job, s2, null),
      })
      assert.equal(result.quiesced, 0)
      assert.equal(result.timedOut, 1)
      assert.equal(s2.snapshotOf(jobId)?.checkpointKind, 'none')
      assert.equal(
        s2.complete(jobId, { httpStatus: 200, body: { output: 'must-not-land' } }, fence),
        false,
      )
      assert.equal(s2.snapshotOf(jobId)?.state, 'paused_for_cutover')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('attached runner can complete during freeze budget before timeout pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-idle-complete-'))
    try {
      let now = 1_000
      const store = openStore(dir, { now: () => now })
      const { jobId, fence } = await runningJob(store)
      const result = await beginDelegateCutover(store, {
        generation: 4,
        freezeBudgetMs: 50,
        now: () => now,
        pollMs: 25,
        sleep: async (ms) => {
          store.complete(jobId, { httpStatus: 200, body: { ok: true, output: 'saved' } }, fence)
          now += ms
        },
        isIdle: (job) => store.isRunnerIdle(job),
      })
      assert.equal(result.quiesced, 0)
      assert.equal(result.timedOut, 0)
      assert.equal(result.completedDuring, 1)
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.state, 'completed')
      assert.equal((snap.result?.body as { output?: string })?.output, 'saved')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('EndCutover generation-owned thaw (blocker 2)', () => {
  it('matching generation thaws dispatch and closes paused rows to killed_by_cutover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-end-'))
    try {
      const store = openStore(dir)
      const { jobId } = await runningJob(store)
      await beginDelegateCutover(store, { generation: 11, freezeBudgetMs: 0, isIdle: () => true })
      assert.equal(store.isDispatchFrozen(), true)
      const ended = endDelegateCutover(store, 11)
      assert.equal(ended.thawed, true)
      assert.equal(ended.closed, 1)
      assert.equal(store.isDispatchFrozen(), false)
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.state, 'killed_by_cutover')
      assert.equal(snap.callbackState, 'pending')
      const created = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('other generation cannot thaw or close a live cutover freeze', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-end-other-'))
    try {
      const store = openStore(dir)
      const { jobId } = await runningJob(store)
      await beginDelegateCutover(store, { generation: 11, freezeBudgetMs: 0, isIdle: () => true })
      const ended = endDelegateCutover(store, 99)
      assert.equal(ended.thawed, false)
      assert.equal(ended.closed, 0)
      assert.equal(store.isDispatchFrozen(), true)
      assert.equal(store.snapshotOf(jobId)?.state, 'paused_for_cutover')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('beginDelegateCutover throw thaws matching generation so claimQueued can proceed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-throw-thaw-'))
    try {
      const store = openStore(dir)
      await runningJob(store)
      await assert.rejects(
        () =>
          beginDelegateCutover(store, {
            generation: 5,
            freezeBudgetMs: 50,
            pollMs: 25,
            isIdle: () => false,
            sleep: async () => {
              throw new Error('boom')
            },
          }),
        /boom/,
      )
      assert.equal(store.isDispatchFrozen(), false)
      const created = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('recycle drain runningDelegateJobs', () => {
  it('flag-off (no count hook) ignores a live running job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-drain-off-'))
    try {
      const store = openStore(dir)
      await runningJob(store)
      const h = drainHarness()
      const decision = await attemptRuntimeRecycleDrain(h.deps)
      assert.deepEqual(decision, { ok: true, status: 200, drainTtlMs: 10_000 })
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flag-on counts running jobs as 409; paused jobs do not block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-drain-on-'))
    try {
      const store = openStore(dir)
      await runningJob(store)
      const busy = drainHarness({
        countRunningDelegateJobs: () => store.countRunning(),
      })
      const busyDecision = await attemptRuntimeRecycleDrain(busy.deps)
      assert.equal(busyDecision.ok, false)
      assert.equal(busyDecision.status, 409)
      if (!busyDecision.ok) {
        assert.equal(busyDecision.runningDelegateJobs, 1)
        assert.equal(busyDecision.durableRunning, 1)
      }

      await beginDelegateCutover(store, { freezeBudgetMs: 0, isIdle: () => true })
      const drained = drainHarness({
        countRunningDelegateJobs: () => store.countRunning(),
      })
      const ok = await attemptRuntimeRecycleDrain(drained.deps)
      assert.deepEqual(ok, { ok: true, status: 200, drainTtlMs: 10_000 })
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drain freezes claimQueued before count so ACK cannot race queued→running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-drain-toctou-'))
    try {
      const store = openStore(dir)
      const created = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in created)
      const h = drainHarness({
        freezeDelegateDispatch: (holder) => store.freezeDispatch(holder),
        thawDelegateDispatch: (holder) => {
          store.thawDispatch(holder)
        },
        countRunningDelegateJobs: async () => {
          await Promise.resolve()
          const raced = store.claimQueued(created.jobId)
          assert.equal(raced.ok, false)
          if (!raced.ok) assert.equal(raced.reason, 'cutover_frozen')
          return 0
        },
        peekRunningDelegateJobs: () => store.countRunning(),
      })
      const decision = await attemptRuntimeRecycleDrain(h.deps)
      assert.equal(decision.ok, true)
      if (decision.ok) assert.equal(decision.status, 200)
      assert.equal(store.snapshotOf(created.jobId)?.state, 'queued')
      assert.equal(store.countRunning(), 0)
      assert.equal(store.isDispatchFrozen(), true)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drain 409 thaws matching holder so a later claimQueued can dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-cut-drain-thaw-'))
    try {
      const store = openStore(dir)
      await runningJob(store)
      const queued = store.create('coding-assistant', { queued: true })
      assert.ok('jobId' in queued)
      const h = drainHarness({
        freezeDelegateDispatch: (holder) => store.freezeDispatch(holder),
        thawDelegateDispatch: (holder) => {
          store.thawDispatch(holder)
        },
        countRunningDelegateJobs: () => store.countRunning(),
        peekRunningDelegateJobs: () => store.countRunning(),
      })
      const decision = await attemptRuntimeRecycleDrain(h.deps)
      assert.equal(decision.ok, false)
      assert.equal(decision.status, 409)
      if (!decision.ok) assert.equal(decision.runningDelegateJobs, 1)
      assert.equal(store.isDispatchFrozen(), false)
      const claimed = store.claimQueued(queued.jobId)
      assert.equal(claimed.ok, true)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
