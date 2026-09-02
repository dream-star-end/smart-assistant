/**
 * Capacity reject vs dispatch split-brain: timeout/queue_full must not leave an
 * executable job, reject copy reports the effective cap, claimQueued cannot
 * resurrect a settled row.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateCapacityReject.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  DELEGATE_MAX_CONCURRENT_DELEGATIONS,
  DELEGATE_REVIEW_RESERVED_SLOTS,
  delegateConcurrencyCap,
  formatDelegateConcurrencyReject,
} from '../delegateCapacity.js'
import { DelegateJobStore } from '../delegateJobs.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueDelegateContextToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-cap-reject'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ORIG_SM = process.env.OC_DELEGATE_SM
const ORIG_WAIT = process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
afterEach(() => {
  if (ORIG_SM === undefined) delete process.env.OC_DELEGATE_SM
  else process.env.OC_DELEGATE_SM = ORIG_SM
  if (ORIG_WAIT === undefined) delete process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
  else process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = ORIG_WAIT
})

function makeGateway(): any {
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
    retireKeepResume: async () => {},
    forgetResume: () => {},
    interrupt: () => false,
    submit: async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
      gw._submitted = [...(gw._submitted ?? []), true]
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
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

describe('reject copy reports the effective cap', () => {
  it('non-review cap is MAX−reserved (4), review cap is MAX (5)', () => {
    assert.equal(DELEGATE_MAX_CONCURRENT_DELEGATIONS, 5)
    assert.equal(DELEGATE_REVIEW_RESERVED_SLOTS, 1)
    assert.equal(delegateConcurrencyCap(false), 4)
    assert.equal(delegateConcurrencyCap(true), 5)
  })

  it('non-review timeout names max 4 and per-parent occupancy', () => {
    const msg = formatDelegateConcurrencyReject({
      isReview: false,
      inUse: 4,
      perParentInUse: 3,
      perParentMax: 3,
      waitedS: 90,
    })
    assert.match(msg, /max 4 non-review/)
    assert.match(msg, /in-use 4\/4/)
    assert.match(msg, /per-parent 3\/3 full/)
    assert.match(msg, /已等待 90s/)
    assert.doesNotMatch(msg, /max 5/)
  })

  it('review queue_full names max 5 and does not mention per-parent', () => {
    const msg = formatDelegateConcurrencyReject({
      isReview: true,
      inUse: 5,
      perParentInUse: 3,
      perParentMax: 3,
      queueFull: true,
      queueMaxWaiters: 8,
    })
    assert.match(msg, /max 5 review/)
    assert.match(msg, /in-use 5\/5/)
    assert.doesNotMatch(msg, /per-parent/)
    assert.match(msg, /排队等待者已满\(8 个\)/)
  })
})

describe('settleCapacityReject vs claimQueued', () => {
  it('capacity_timeout fail then claimQueued does not dispatch', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', { queued: true })
    assert.ok('jobId' in created)
    const settled = store.settleCapacityReject(created.jobId, {
      failureClass: 'capacity_timeout',
      detail: 'too many concurrent delegations (max 4 non-review; in-use 4/4); 已等待 90s 资源仍紧张,请稍后重试',
      httpStatus: 429,
      drop: false,
    })
    assert.equal(settled, 'failed')
    assert.equal(store.claimQueued(created.jobId).ok, false)
    const view = store.get(created.jobId)
    assert.equal(view.status, 'failed')
    if (view.status !== 'failed') return
    assert.equal(view.failure_class, 'capacity_timeout')
    store.close()
  })

  it('claimQueued then settleCapacityReject leaves the running owner', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', { queued: true })
    assert.ok('jobId' in created)
    const claimed = store.claimQueued(created.jobId)
    assert.equal(claimed.ok, true)
    assert.equal(
      store.settleCapacityReject(created.jobId, {
        failureClass: 'capacity_timeout',
        detail: 'timeout',
        httpStatus: 429,
        drop: false,
      }),
      'claimed',
    )
    assert.equal(store.snapshotOf(created.jobId)?.state, 'running')
    assert.equal(store.dropIfUnclaimed(created.jobId), false)
    store.close()
  })

  it('queue_full drop then claimQueued misses the row', () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000 })
    const created = store.create('coding-assistant', { queued: true })
    assert.ok('jobId' in created)
    assert.equal(
      store.settleCapacityReject(created.jobId, {
        failureClass: 'capacity_queue_full',
        detail: 'full',
        httpStatus: 429,
        drop: true,
      }),
      'dropped',
    )
    assert.equal(store.size(), 0)
    assert.equal(store.claimQueued(created.jobId).ok, false)
    store.close()
  })
})

describe('capacity_timeout production path leaves no executable job', () => {
  it('queued job times out into failed and never calls getOrCreate', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._activeDelegations = delegateConcurrencyCap(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: 'timeout-no-spawn',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    assert.equal(r.status, 200)
    const jobId = r.body.jobId as string
    assert.match(jobId, /^dlgjob-/)
    let view = gw._delegateJobs.get(jobId)
    for (let i = 0; i < 40 && view.status !== 'failed'; i++) {
      await sleep(20)
      view = gw._delegateJobs.get(jobId)
    }
    assert.equal(view.status, 'failed')
    if (view.status !== 'failed') return
    assert.equal(view.failure_class, 'capacity_timeout')
    assert.match(String(view.failure_detail), /max 4 non-review/)
    assert.equal(gw._created, undefined, 'timeout must not spawn a child session')
    assert.equal(gw._submitted, undefined)
    assert.equal(gw._delegateJobs.claimQueued(jobId).ok, false)
  })

  it('reject winning before a late slot+claim still does not spawn', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    gw._activeDelegations = delegateConcurrencyCap(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: 'reject-vs-claim',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    assert.equal(r.status, 200)
    const jobId = r.body.jobId as string
    assert.equal(gw._delegateJobs.get(jobId).status, 'queued')
    const settled = gw._delegateJobs.settleCapacityReject(jobId, {
      failureClass: 'capacity_timeout',
      detail: 'injected timeout',
      httpStatus: 429,
      drop: false,
    })
    assert.equal(settled, 'failed')
    gw._activeDelegations = 0
    await sleep(80)
    assert.equal(gw._created, undefined, 'claim after fail must not spawn')
    assert.equal(gw._delegateJobs.get(jobId).status, 'failed')
    assert.equal(gw._delegateJobs.claimQueued(jobId).ok, false)
  })

  it('HTTP timeout 429 for non-review vs review reports the matching cap', async () => {
    resetDelegateContextKeyForTests()
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._activeDelegations = delegateConcurrencyCap(false)
    const nonReview = await call(gw, 'handleDelegateTask', {
      goal: 'cap-copy',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(nonReview.status, 429)
    assert.match(nonReview.body.error, /max 4 non-review/)
    assert.match(nonReview.body.error, /in-use 4\/4/)
    assert.doesNotMatch(nonReview.body.error, /max 5 review/)

    gw._activeDelegations = DELEGATE_MAX_CONCURRENT_DELEGATIONS
    const review = await call(
      gw,
      'handleDelegateTask',
      { goal: '审查草稿', sourceAgent: 'main', parentSessionKey: PARENT_KEY },
      'hidden-reviewer',
    )
    assert.equal(review.status, 429)
    assert.match(review.body.error, /max 5 review/)
    assert.match(review.body.error, /in-use 5\/5/)
    assert.doesNotMatch(review.body.error, /per-parent/)
  })
})
