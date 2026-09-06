/**
 * 2026-09-06 槽位泄漏回归:SM async 委派在 _admitDelegateCreate 预占了运行槽位(或 waiter),
 * 随后 _runDelegateTaskCore 在资源闸之前结构化拒绝(深度闸 / agent 不存在 / per-turn 熔断 /
 * catalog 拒绝 …)—— 预占必须归还,否则 _activeDelegations 与 per-parent 计数只增不减,
 * 之后所有委派 `too many concurrent delegations (in-use N/N)` 等满 300s 后 429。
 *
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/delegateSlotLeakOnEarlyReject.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { delegateConcurrencyCap } from '../delegateCapacity.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueDelegateContextToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-slot-leak'
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
    // 父会话在内存里(webchat, agentId=main)→ per-parent 桶键 = PARENT_KEY。
    getByKey: (key: string) =>
      key === PARENT_KEY
        ? { sessionKey: PARENT_KEY, channel: 'webchat', agentId: 'main', _teamModeTurn: true }
        : undefined,
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
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function postAsync(
  gw: any,
  body: Record<string, unknown>,
  opts: { depth?: number; targetAgentId?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    [DELEGATE_CONTEXT_HEADER]: issueDelegateContextToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: opts.depth ?? 0,
    }),
  }
  const req: any = { method: 'POST', headers }
  gw.readBody = async () => JSON.stringify({ ...body, async: true })
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
  await gw.handleDelegateTask(req, res, opts.targetAgentId ?? 'coding-assistant')
  return { status, body: raw ? JSON.parse(raw) : {} }
}

async function waitTerminal(gw: any, jobId: string): Promise<any> {
  let view = gw._delegateJobs.get(jobId)
  for (let i = 0; i < 100 && view.status !== 'failed' && view.status !== 'done'; i++) {
    await sleep(10)
    view = gw._delegateJobs.get(jobId)
  }
  return view
}

function counters(gw: any) {
  return {
    active: gw._activeDelegations as number,
    perParent: gw._runningDelegationsByParent?.get(PARENT_KEY) ?? 0,
    waiters: gw._delegateQueueWaiters?.size ?? 0,
  }
}

describe('SM pre-reserved slot is released when core rejects before the gate', () => {
  it('depth limit reject (slot admitted) returns the slot and per-parent count', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    const gw = makeGateway()
    const r = await postAsync(
      gw,
      { goal: 'too-deep', sourceAgent: 'main', parentSessionKey: PARENT_KEY },
      { depth: 3 },
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const view = await waitTerminal(gw, r.body.jobId)
    assert.equal(view.status, 'failed')
    assert.match(String(view.failure_detail ?? view.error ?? ''), /depth limit/)
    assert.equal(gw._created, undefined, 'must not spawn')
    assert.deepEqual(counters(gw), { active: 0, perParent: 0, waiters: 0 })
  })

  it('agent-not-found reject (slot admitted) returns the slot', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    const gw = makeGateway()
    const r = await postAsync(
      gw,
      { goal: 'no-such-agent', sourceAgent: 'main', parentSessionKey: PARENT_KEY },
      { targetAgentId: 'ghost-agent' },
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const view = await waitTerminal(gw, r.body.jobId)
    assert.equal(view.status, 'failed')
    assert.deepEqual(counters(gw), { active: 0, perParent: 0, waiters: 0 })
  })

  it('N repeated early rejects never accumulate phantom slots (the 2026-09-06 incident shape)', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    const gw = makeGateway()
    const cap = delegateConcurrencyCap(false)
    const jobIds: string[] = []
    for (let i = 0; i < cap + 2; i++) {
      const r = await postAsync(
        gw,
        { goal: `deep-${i}`, sourceAgent: 'main', parentSessionKey: PARENT_KEY },
        { depth: 3 },
      )
      assert.equal(r.status, 200, `iteration ${i}: ${JSON.stringify(r.body)}`)
      jobIds.push(r.body.jobId)
    }
    for (const id of jobIds) {
      const view = await waitTerminal(gw, id)
      assert.equal(view.status, 'failed')
      assert.doesNotMatch(
        String(view.failure_detail ?? ''),
        /too many concurrent delegations/,
        'a pre-gate reject must never turn into a capacity reject via leaked slots',
      )
    }
    assert.deepEqual(counters(gw), { active: 0, perParent: 0, waiters: 0 })

    // 泄漏修好后,一个正常委派仍能立刻拿到槽位并跑完。
    const ok = await postAsync(gw, { goal: 'after-leak', sourceAgent: 'main', parentSessionKey: PARENT_KEY })
    assert.equal(ok.status, 200)
    const done = await waitTerminal(gw, ok.body.jobId)
    assert.equal(done.status, 'done', JSON.stringify(done))
    assert.equal(gw._created?.length, 1)
    assert.deepEqual(counters(gw), { active: 0, perParent: 0, waiters: 0 })
  })

  it('waiter admitted (cap full) then early reject drops the waiter entry', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    const cap = delegateConcurrencyCap(false)
    gw._activeDelegations = cap // 全局已满 → admit 走 'wait'
    const r = await postAsync(
      gw,
      { goal: 'deep-while-full', sourceAgent: 'main', parentSessionKey: PARENT_KEY },
      { depth: 3 },
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const view = await waitTerminal(gw, r.body.jobId)
    assert.equal(view.status, 'failed')
    assert.match(String(view.failure_detail ?? ''), /depth limit/)
    assert.equal(gw._activeDelegations, cap, 'no slot was reserved, none may be released')
    assert.equal(gw._delegateQueueWaiters?.size ?? 0, 0, 'placeholder waiter must be dropped')
  })

  it('waiter admitted then gate passes: placeholder waiter is consumed, slot released at end', async () => {
    resetDelegateContextKeyForTests()
    process.env.OC_DELEGATE_SM = '1'
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    const cap = delegateConcurrencyCap(false)
    gw._activeDelegations = cap
    const r = await postAsync(gw, { goal: 'queued-then-run', sourceAgent: 'main', parentSessionKey: PARENT_KEY })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(gw._delegateJobs.get(r.body.jobId).status, 'queued')
    assert.equal(gw._delegateQueueWaiters.size, 1)
    await sleep(30)
    gw._activeDelegations = 0 // 释放容量 → 排队者放行
    const done = await waitTerminal(gw, r.body.jobId)
    assert.equal(done.status, 'done', JSON.stringify(done))
    assert.deepEqual(counters(gw), { active: 0, perParent: 0, waiters: 0 })
  })
})
