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
import { enqueueCronOccurrenceJob } from '../delegateCronIdempotency.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueDelegateContextToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
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
      assert.deepEqual(await readdir(dir), [])
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
