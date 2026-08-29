/**
 * OCV5-22 phase 0: resume true-reject, capacity_timeout, owner lease, B2/B3.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegatePhase0.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DelegateJobStore } from '../delegateJobs.js'
import {
  DELEGATE_RESUME_OCCUPIED_MESSAGE,
  DelegateResumeRegistry,
} from '../delegateResume.js'
import { decideSendToAgentIntentRecovery } from '../delegateCallbackOwner.js'
import { enqueueCronOccurrenceJob, settleCronDelegateJob } from '../delegateCronIdempotency.js'
import { persistDelegateJobSnapshots, restoreDelegateJobSnapshots } from '../delegateCompleter.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueDelegateContextToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { DELEGATE_MAX_CONCURRENT_DELEGATIONS } from '../delegateCapacity.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-phase0-delegate'

function makeGateway(holdSubmit = false): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw._delegateQueuePollMs = 10
  gw._readDelegateMemoryPressure = () => null
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.deps = {
    config: {
      version: 1,
      provider: 'anthropic',
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
      auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
      defaults: { model: 'glm-5.2', permissionMode: 'default' },
      channels: { webchat: { enabled: true } },
    },
  }
  gw._getAgentsConfig = async () => ({
    default: 'main',
    agents: [agent, { id: 'hidden-reviewer' }, { id: 'coding-assistant' }],
  })
  gw._runLog = { start: () => ({}), complete: () => {} }
  let releaseHold!: () => void
  gw._holdGate = holdSubmit
    ? new Promise<void>((res) => {
        releaseHold = res
      })
    : Promise.resolve()
  gw._releaseHold = () => releaseHold?.()
  gw._submitted = []
  gw.sessions = {
    destroySession: async () => {},
    getByKey: () => ({ _teamModeTurn: true, _currentTurnUserText: '测试任务' }),
    getOrCreate: async (opts: any) => {
      gw._created = [...(gw._created ?? []), opts]
      return {
        agentId: opts?.agent?.id ?? 'coding-assistant',
        currentTurnStatus: null,
        runner: { interrupt: () => {}, sendPermissionResponse: () => {}, on: () => {}, off: () => {} },
      }
    },
    retireKeepResume: async (key: string) => {
      gw._retiredKeys = [...(gw._retiredKeys ?? []), key]
    },
    forgetResume: () => {},
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      effort?: string,
      model?: string,
    ) => {
      gw._submitted.push({ effort, model })
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      await gw._holdGate
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function call(
  gw: any,
  method: 'handleDelegateTask' | 'handleDelegateWait',
  body: Record<string, unknown>,
  targetAgentId = 'coding-assistant',
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {}
  if (method === 'handleDelegateTask' && body.async === true) {
    headers[DELEGATE_CONTEXT_HEADER] = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: 0,
    })
  }
  const req: any = { method: 'POST', headers }
  gw.readBody = async () => JSON.stringify(body)
  let status = 0
  let raw = ''
  const res: any = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? '')
    },
  }
  if (method === 'handleDelegateTask') await gw.handleDelegateTask(req, res, targetAgentId)
  else await gw.handleDelegateWait(req, res)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

describe('resume occupancy: reject before any dispatch side effect', () => {
  it('retiring session: two resume attempts both 409 and dispatchGrants stay at 0 extra', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'aa' })
    const minted = reg.preflight({
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    assert.equal(minted.dispatchGranted, true)
    const grantsAfterMint = reg.dispatchGrants
    reg.markRetiring(minted.sessionKey)

    const first = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'resume-a',
    })
    const second = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'resume-b',
    })
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
    if (first.ok || second.ok) return
    assert.equal(first.httpStatus, 409)
    assert.equal(second.httpStatus, 409)
    assert.equal(first.dispatchGranted, false)
    assert.equal(second.dispatchGranted, false)
    assert.match(first.message, /仍在运行或正在收尾/)
    assert.equal(first.message, DELEGATE_RESUME_OCCUPIED_MESSAGE)
    assert.equal(reg.dispatchGrants, grantsAfterMint)
  })

  it('same idempotency key during in-flight resumes as replay, never grants a second dispatch', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'bb' })
    const minted = reg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'same-key',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    const grants = reg.dispatchGrants
    const replay = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'same-key',
    })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.replay, true)
    assert.equal(replay.dispatchGranted, false)
    assert.equal(reg.dispatchGrants, grants)
  })

  it('after release, the first resume grants exactly one dispatch', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'cc' })
    const minted = reg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    reg.release(minted.sessionKey)
    const grantsBefore = reg.dispatchGrants
    const resumed = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'after-release',
    })
    assert.equal(resumed.ok, true)
    if (!resumed.ok) return
    assert.equal(resumed.dispatchGranted, true)
    assert.equal(reg.dispatchGrants, grantsBefore + 1)
    const again = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'after-release-2',
    })
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.dispatchGranted, false)
    assert.equal(reg.dispatchGrants, grantsBefore + 1)
  })
})

describe('HTTP resume reject does not spawn submit', () => {
  it('in-flight resume 409s with zero additional submit', async () => {
    resetDelegateContextKeyForTests()
    const gw = makeGateway(true)
    const start = await call(gw, 'handleDelegateTask', {
      goal: '慢任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    assert.equal(start.status, 200)
    const jobsBefore = gw._delegateJobs.size()
    assert.equal(jobsBefore, 1)
    const resume = await call(gw, 'handleDelegateTask', {
      goal: '不该发出去',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: start.body.sessionKey,
      idempotencyKey: 'retry-1',
      async: true,
    })
    assert.equal(resume.status, 409)
    assert.match(String(resume.body.error), /仍在运行或正在收尾/)
    assert.equal(gw._delegateJobs.size(), jobsBefore, '409 resume must not mint a second job')
    gw._releaseHold()
  })
})

describe('SM capacity_timeout is explicit failed', () => {
  it('queued job times out into failed{capacity_timeout} without silent queue', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, now: () => 1000 })
    const created = store.create('coding-assistant', { queued: true, sessionKey: 'sk' })
    assert.ok('jobId' in created)
    const view = store.get(created.jobId)
    assert.equal(view.status, 'queued')
    const ok = store.fail(created.jobId, {
      failureClass: 'capacity_timeout',
      detail: 'too many concurrent delegations (max 5); 已等待 90s 资源仍紧张',
      httpStatus: 429,
    })
    assert.equal(ok, true)
    const failed = store.get(created.jobId)
    assert.equal(failed.status, 'failed')
    if (failed.status !== 'failed') return
    assert.equal(failed.failure_class, 'capacity_timeout')
    assert.ok(failed.failure_detail.length > 0)
  })

  it('HTTP wait returns failed capacity_timeout as 429 with failure_class', async () => {
    resetDelegateContextKeyForTests()
    const gw = makeGateway(false)
    gw._delegateJobs = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = gw._delegateJobs.create('coding-assistant', { queued: true, sessionKey: 'sk' })
    gw._delegateJobs.fail(created.jobId, {
      failureClass: 'capacity_timeout',
      detail: 'too many concurrent delegations (max 5); 已等待 90s 资源仍紧张',
      httpStatus: 429,
    })
    const waited = await call(gw, 'handleDelegateWait', { jobId: created.jobId, waitMs: 30 })
    assert.equal(waited.status, 429)
    assert.equal(waited.body.status, 'failed')
    assert.equal(waited.body.failure_class, 'capacity_timeout')
  })
})

describe('B1 owner lease CAS', () => {
  it('stale running without runner_quiesced is killed_by_cutover; wrong token cannot complete', () => {
    const g0 = new DelegateJobStore({ sm: true, bootId: 'gw:g0', leaseMs: 10, now: () => 1000 })
    const created = g0.create('coding-assistant', { ownerInstanceId: 'gw:g0' })
    assert.ok('jobId' in created)
    const snap = g0.snapshotOf(created.jobId)!
    assert.equal(snap.state, 'running')
    const stolen = g0.complete(
      created.jobId,
      { httpStatus: 200, body: { ok: true } },
      { claimToken: 'deadbeef', fencingEpoch: snap.fencingEpoch },
    )
    assert.equal(g0.snapshotOf(created.jobId)?.state, 'running')
    void stolen

    const g1 = new DelegateJobStore({ sm: true, bootId: 'gw:g1', leaseMs: 10, now: () => 2000 })
    // copy is in-memory per store; simulate adopt on g0 with expired lease using g0 clock
    let now = 1_000
    const expired = new DelegateJobStore({
      sm: true,
      bootId: 'gw:g1',
      leaseMs: 10,
      now: () => now,
    })
    const job = expired.create('coding-assistant', { ownerInstanceId: 'gw:g0' })
    assert.ok('jobId' in job)
    now = 50_000
    const before = expired.snapshotOf(job.jobId)!
    assert.equal(expired.decideAdoptNextState(before), 'killed_by_cutover')
    const adopted = expired.adoptOrKill(job.jobId, before.fencingEpoch, 'killed_by_cutover')
    assert.equal(adopted?.state, 'killed_by_cutover')
    assert.equal(adopted?.failureClass, 'cutover')
    const late = expired.complete(
      job.jobId,
      { httpStatus: 200, body: { ok: true, output: 'g0 late' } },
      { claimToken: before.claimToken!, fencingEpoch: before.fencingEpoch },
    )
    void late
    assert.equal(expired.snapshotOf(job.jobId)?.state, 'killed_by_cutover')
    void g1
  })
})

describe('B2 callback owner', () => {
  it('job-owner recovery: non-terminal drops shadow; missing job may legacy-interrupt', () => {
    assert.deepEqual(
      decideSendToAgentIntentRecovery({ callbackOwner: 'job', job: { jobId: 'dlgjob-1', state: 'running' } }),
      { action: 'drop_shadow' },
    )
    assert.deepEqual(
      decideSendToAgentIntentRecovery({ callbackOwner: 'job', job: undefined }),
      { action: 'legacy_interrupt' },
    )
    assert.deepEqual(
      decideSendToAgentIntentRecovery({
        callbackOwner: 'job',
        job: { jobId: 'dlgjob-1', state: 'completed' },
      }),
      { action: 'ensure_callback', jobId: 'dlgjob-1', state: 'completed' },
    )
    assert.deepEqual(
      decideSendToAgentIntentRecovery({ callbackOwner: 'intent', job: { jobId: 'dlgjob-1', state: 'running' } }),
      { action: 'legacy_interrupt' },
    )
  })

  it('recoverInterrupted does not deliver interrupt when job row is non-terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-sta-b2-'))
    const env = { OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: dir } as NodeJS.ProcessEnv
    try {
      await persistSendToAgentIntent({
        v: 1,
        jobId: 'dlgjob-live',
        originSessionKey: 'agent:main:webchat:dm:sess-1',
        agentId: 'coding-assistant',
        goal: 'x',
        createdAt: 1,
      }, env)
      const delivered: string[] = []
      const summary = await recoverInterruptedSendToAgentIntents(
        async (intent) => {
          delivered.push(intent.jobId)
          return true
        },
        env,
        {
          callbackOwner: 'job',
          resolveJob: (id) =>
            id === 'dlgjob-live'
              ? {
                  id,
                  agentId: 'coding-assistant',
                  state: 'running',
                  fencingEpoch: 1,
                  attemptNo: 1,
                  checkpointKind: 'none',
                  callback: 'origin-inject',
                  callbackState: 'none',
                  callbackEpoch: 0,
                  kind: 'send_to_agent',
                  generation: 0,
                }
              : undefined,
        },
      )
      assert.equal(summary.skippedShadow, 1)
      assert.equal(summary.recovered, 0)
      assert.deepEqual(delivered, [])
      assert.deepEqual(await readdir(dir), ['dlgjob-live.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('B3 cron idempotency', () => {
  it('same cron:job:minute retries return the original dlgjob and never mint a second', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const a = enqueueCronOccurrenceJob(store, {
      cronJobId: 'remind-mtd9f0ng-pgki',
      dueMinuteKey: 1767225600,
      agentId: 'main',
    })
    const b = enqueueCronOccurrenceJob(store, {
      cronJobId: 'remind-mtd9f0ng-pgki',
      dueMinuteKey: 1767225600,
      agentId: 'main',
    })
    assert.ok(!('error' in a) && !('error' in b))
    if ('error' in a || 'error' in b) return
    assert.equal(a.reused, false)
    assert.equal(b.reused, true)
    assert.equal(a.jobId, b.jobId)
    assert.equal(store.size(), 1)
  })
})

describe('auditor probes: resume key lifecycle', () => {
  it('occupancy 409 is not cached: after release the same key can dispatch again', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'k1' })
    const minted = reg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'K',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    const occupied = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'K2',
    })
    assert.equal(occupied.ok, false)
    if (occupied.ok) return
    assert.equal(occupied.httpStatus, 409)
    assert.equal(occupied.replay, false)
    reg.release(minted.sessionKey)
    const retry = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'K2',
    })
    assert.equal(retry.ok, true)
    if (!retry.ok) return
    assert.equal(retry.dispatchGranted, true)
    assert.equal(retry.replay, false)
  })

  it('accepted same key while in-flight replays the bound jobId, not an older sibling', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'k2' })
    const minted = reg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'req-j2',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    reg.bindJob(minted.sessionKey, 'req-j2', 'dlgjob-j2')
    const replay = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
      idempotencyKey: 'req-j2',
    })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.replay, true)
    assert.equal(replay.dispatchGranted, false)
    assert.equal(replay.jobId, 'dlgjob-j2')
  })

  it('flag-off same idempotencyKey one-shots mint two jobs and two dispatches', async () => {
    resetDelegateContextKeyForTests()
    const gw = makeGateway(false)
    const a = await call(gw, 'handleDelegateTask', {
      goal: 'one-shot',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      idempotencyKey: 'same-one-shot',
      async: true,
    })
    const b = await call(gw, 'handleDelegateTask', {
      goal: 'one-shot',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      idempotencyKey: 'same-one-shot',
      async: true,
    })
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.notEqual(a.body.jobId, b.body.jobId)
    assert.equal(gw._delegateJobs.size(), 2)
  })
})

describe('auditor probes: owner fence on production complete', () => {
  it('SM owned job complete() without fence does not go terminal', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, now: () => 1 })
    const created = store.create('coding-assistant')
    assert.ok('jobId' in created)
    store.complete(created.jobId, { httpStatus: 200, body: { ok: true } })
    assert.equal(store.snapshotOf(created.jobId)?.state, 'running')
    const snap = store.snapshotOf(created.jobId)!
    store.complete(
      created.jobId,
      { httpStatus: 200, body: { ok: true } },
      { claimToken: snap.claimToken!, fencingEpoch: snap.fencingEpoch },
    )
    assert.equal(store.snapshotOf(created.jobId)?.state, 'completed')
  })
})

describe('auditor probes: queue_full does not leave a job row', () => {
  it('SM admit full rejects before create', async () => {
    resetDelegateContextKeyForTests()
    const prev = process.env.OC_DELEGATE_SM
    process.env.OC_DELEGATE_SM = '1'
    try {
      const gw = makeGateway(false)
      gw._delegateJobs = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
      gw._delegateQueueWaiters = new Map()
      for (let i = 0; i < 8; i++) gw._delegateQueueWaiters.set(`w${i}`, () => {})
      gw._activeDelegations = DELEGATE_MAX_CONCURRENT_DELEGATIONS
      const r = await call(gw, 'handleDelegateTask', {
        goal: 'no-row',
        sourceAgent: 'main',
        parentSessionKey: PARENT_KEY,
        async: true,
      })
      assert.equal(r.status, 429)
      assert.equal(r.body.failure_class, 'capacity_queue_full')
      assert.equal(gw._delegateJobs.size(), 0)
    } finally {
      if (prev === undefined) delete process.env.OC_DELEGATE_SM
      else process.env.OC_DELEGATE_SM = prev
    }
  })

  it('dropIfUnclaimed removes a provisional queued row after late queue_full', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', { queued: true })
    assert.ok('jobId' in created)
    assert.equal(store.dropIfUnclaimed(created.jobId), true)
    assert.equal(store.size(), 0)
    assert.equal(store.get(created.jobId).status, 'expired')
  })
})

describe('auditor probes: cron terminal frees capacity', () => {
  it('257 distinct occurrences do not exhaust the store after settle', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, maxJobs: 256 })
    for (let i = 0; i < 257; i++) {
      const enq = enqueueCronOccurrenceJob(store, {
        cronJobId: 'remind-cap',
        dueMinuteKey: 1_700_000_000 + i,
        agentId: 'main',
      })
      assert.ok(!('error' in enq), `occurrence ${i} should enqueue`)
      if ('error' in enq) return
      const claimed = store.claimQueued(enq.jobId)
      assert.equal(claimed.ok, true, `occurrence ${i} should claim`)
      if (!claimed.ok) return
      assert.equal(
        settleCronDelegateJob(store, enq.jobId, 'completed', {
          claimToken: claimed.claimToken,
          fencingEpoch: claimed.fencingEpoch,
        }),
        true,
      )
    }
    assert.ok(store.nonTerminalCount() < 256)
    assert.ok(store.size() >= 1)
  })
})

describe('auditor probes: shutdown keeps recovery records', () => {
  it('persist snapshots survive close; drop_shadow does not delete intent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-dlg-snap-'))
    const intentDir = await mkdtemp(join(tmpdir(), 'oc-sta-keep-'))
    const env = {
      OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR: dir,
      OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: intentDir,
    } as NodeJS.ProcessEnv
    try {
      const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
      const created = store.create('coding-assistant', {
        queued: true,
        callback: 'origin-inject',
        sessionKey: 'sk',
      })
      assert.ok('jobId' in created)
      await persistSendToAgentIntent({
        v: 1,
        jobId: created.jobId,
        originSessionKey: 'agent:main:webchat:dm:sess-1',
        agentId: 'coding-assistant',
        goal: 'x',
        createdAt: 1,
      }, env)
      const n = await persistDelegateJobSnapshots(store, env)
      assert.equal(n, 1)
      store.close()
      assert.equal(store.size(), 0)
      const restored = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
      await restoreDelegateJobSnapshots(restored, env)
      assert.equal(restored.snapshotOf(created.jobId)?.state, 'queued')
      const delivered: string[] = []
      await recoverInterruptedSendToAgentIntents(async (intent) => {
        delivered.push(intent.jobId)
        return true
      }, env, {
        callbackOwner: 'job',
        resolveJob: (id) => restored.snapshotOf(id),
      })
      assert.deepEqual(delivered, [])
      assert.deepEqual(await readdir(intentDir), [`${created.jobId}.json`])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(intentDir, { recursive: true, force: true })
    }
  })
})

describe('auditor probes: cron settle never borrows the live fence', () => {
  it('claim A then rotate B: settle with A affects 0 rows', () => {
    let now = 1_000
    const store = new DelegateJobStore({
      sm: true,
      ttlMs: 60_000,
      bootId: 'gw:a',
      leaseMs: 10,
      now: () => now,
    })
    const enq = enqueueCronOccurrenceJob(store, {
      cronJobId: 'remind-fence',
      dueMinuteKey: 1_700_000_100,
      agentId: 'main',
    })
    assert.ok(!('error' in enq))
    if ('error' in enq) return
    const claimedA = store.claimQueued(enq.jobId)
    assert.equal(claimedA.ok, true)
    if (!claimedA.ok) return
    now = 50_000
    const adopted = store.adoptOrKill(enq.jobId, claimedA.fencingEpoch, 'running')
    assert.equal(adopted?.state, 'running')
    assert.notEqual(adopted?.claimToken, claimedA.claimToken)
    const missing = settleCronDelegateJob(store, enq.jobId, 'completed', undefined)
    assert.equal(missing, false)
    assert.equal(store.snapshotOf(enq.jobId)?.state, 'running')
    const stale = settleCronDelegateJob(store, enq.jobId, 'completed', {
      claimToken: claimedA.claimToken,
      fencingEpoch: claimedA.fencingEpoch,
    })
    assert.equal(stale, false)
    assert.equal(store.snapshotOf(enq.jobId)?.state, 'running')
    assert.equal(store.snapshotOf(enq.jobId)?.claimToken, adopted?.claimToken)
  })
})

describe('auditor probes: snapshot persist fail-closed', () => {
  it('persist failure does not close or clear in-memory jobs', async () => {
    const gw = Object.create(Gateway.prototype) as any
    gw.log = { debug() {}, info() {}, warn() {}, error() {} }
    gw._activeSendToAgentCallbacks = new Map()
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', {
      queued: true,
      callback: 'origin-inject',
      sessionKey: 'sk',
    })
    assert.ok('jobId' in created)
    gw._delegateJobs = store
    const prev = process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR
    process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR = '/dev/null/ocv5-22-phase0'
    let closed = 0
    const origClose = store.close.bind(store)
    store.close = () => {
      closed += 1
      origClose()
    }
    try {
      await gw._persistAndCloseDelegateJobs()
      assert.fail('persist failure must propagate')
    } catch (err: any) {
      assert.equal(err?.code, 'ENOTDIR')
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR
      else process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR = prev
    }
    assert.equal(closed, 0)
    assert.equal(gw._delegateJobs, store)
    assert.equal(store.size(), 1)
    assert.equal(store.snapshotOf(created.jobId)?.state, 'queued')
  })
})

describe('auditor probes: callback CAS winner only', () => {
  it('stale-owner fence does not inject or delete intent', async () => {
    const prevSm = process.env.OC_DELEGATE_SM
    process.env.OC_DELEGATE_SM = '1'
    const intentDir = await mkdtemp(join(tmpdir(), 'oc-sta-stale-'))
    const envPrev = process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    try {
      const gw = makeGateway(false)
      const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, now: () => 1 })
      const created = store.create('coding-assistant', {
        queued: true,
        callback: 'origin-inject',
        sessionKey: 'sk',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) return
      const won = store.complete(
        created.jobId,
        { httpStatus: 200, body: { ok: true, output: 'done' } },
        { claimToken: claimed.claimToken, fencingEpoch: claimed.fencingEpoch },
      )
      assert.equal(won, true)
      await persistSendToAgentIntent({
        v: 1,
        jobId: created.jobId,
        originSessionKey: 'agent:main:webchat:dm:sess-1',
        agentId: 'coding-assistant',
        goal: 'x',
        createdAt: 1,
      })
      gw._delegateJobs = store
      gw._activeSendToAgentCallbacks = new Map([[created.jobId, { originSessionKey: 's' }]])
      let injected = 0
      gw.injectSendToAgentCallback = async () => {
        injected += 1
        return { kind: 'injected' }
      }
      gw._queueSendToAgentCallback(
        {
          callbackOnComplete: 'origin-inject',
          claimToken: 'stale-owner',
          fencingEpoch: claimed.fencingEpoch,
          parentSessionKey: PARENT_KEY,
        },
        { jobId: created.jobId, agentId: 'coding-assistant', goal: 'x', output: 'done' },
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(injected, 0)
      assert.equal(store.snapshotOf(created.jobId)?.callbackState, 'pending')
      assert.deepEqual(await readdir(intentDir), [`${created.jobId}.json`])
    } finally {
      if (prevSm === undefined) delete process.env.OC_DELEGATE_SM
      else process.env.OC_DELEGATE_SM = prevSm
      if (envPrev === undefined) delete process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR
      else process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = envPrev
      await rm(intentDir, { recursive: true, force: true })
    }
  })

  it('delivered CAS false keeps the intent shadow', async () => {
    const prevSm = process.env.OC_DELEGATE_SM
    process.env.OC_DELEGATE_SM = '1'
    const intentDir = await mkdtemp(join(tmpdir(), 'oc-sta-cas-'))
    const envPrev = process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    try {
      const gw = makeGateway(false)
      const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, now: () => 1 })
      const created = store.create('coding-assistant', {
        queued: true,
        callback: 'origin-inject',
        sessionKey: 'sk',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) return
      assert.equal(
        store.complete(
          created.jobId,
          { httpStatus: 200, body: { ok: true } },
          { claimToken: claimed.claimToken, fencingEpoch: claimed.fencingEpoch },
        ),
        true,
      )
      await persistSendToAgentIntent({
        v: 1,
        jobId: created.jobId,
        originSessionKey: 'agent:main:webchat:dm:sess-1',
        agentId: 'coding-assistant',
        goal: 'x',
        createdAt: 1,
      })
      const origPatch = store.patchCallbackState.bind(store)
      store.patchCallbackState = (jobId, next, fence) => {
        if (next === 'delivered') return false
        return origPatch(jobId, next, fence)
      }
      gw._delegateJobs = store
      gw._activeSendToAgentCallbacks = new Map([[created.jobId, { originSessionKey: 's' }]])
      let injected = 0
      gw.injectSendToAgentCallback = async () => {
        injected += 1
        return { kind: 'injected' }
      }
      gw._queueSendToAgentCallback(
        {
          callbackOnComplete: 'origin-inject',
          claimToken: claimed.claimToken,
          fencingEpoch: claimed.fencingEpoch,
          parentSessionKey: PARENT_KEY,
        },
        { jobId: created.jobId, agentId: 'coding-assistant', goal: 'x', output: 'done' },
      )
      for (let i = 0; i < 30 && injected === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(injected, 1)
      for (let i = 0; i < 30 && store.snapshotOf(created.jobId)?.callbackState === 'injecting'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(store.snapshotOf(created.jobId)?.callbackState, 'pending')
      assert.deepEqual(await readdir(intentDir), [`${created.jobId}.json`])
    } finally {
      if (prevSm === undefined) delete process.env.OC_DELEGATE_SM
      else process.env.OC_DELEGATE_SM = prevSm
      if (envPrev === undefined) delete process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR
      else process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = envPrev
      await rm(intentDir, { recursive: true, force: true })
    }
  })
})
