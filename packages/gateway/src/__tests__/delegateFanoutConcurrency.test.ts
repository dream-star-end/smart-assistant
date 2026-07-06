/**
 * P2 批次4 — fan-out 并行委派的 gateway 侧并发行为:同一队长(父)一次并行派发
 * 多个子任务时,超过 per-parent 分桶上限(默认 3)的委派应**排队等待放行**,而不是
 * 被硬拒(429)。这是 delegate_tasks 复数原语成立的前提 —— gateway 端零改动,靠既有
 * per-parent 分桶(3)+ 全局闸(5)+ 有界排队消化并发。
 *
 * 沿用 delegateResourceQueue.test.ts 的脚手架:getByKey 返回父会话 → parentBucketKey
 * 生效;submit 挂在可控 barrier 上,让前 3 个占满桶、第 4 个进排队,断言"排队而非拒绝",
 * 释放后 4 个全部 200。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateFanoutConcurrency.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-fanout'
const PARENT_PEER = 'wsess-fanout'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ORIG_QUEUE_WAIT_MS = process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
afterEach(() => {
  if (ORIG_QUEUE_WAIT_MS === undefined) delete process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
  else process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = ORIG_QUEUE_WAIT_MS
})

function makeGateway(): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const parentSession = {
    sessionKey: PARENT_KEY,
    channel: 'webchat',
    peerId: PARENT_PEER,
    agentId: 'main',
    userId: '1',
    repoSessionId: undefined,
  }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._runningDelegationsByParent = new Map()
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
  // 可控 barrier:submit 发完首块后挂起,直到 releaseHold();让前 3 个占满 per-parent 桶。
  let releaseHold!: () => void
  gw._holdGate = new Promise<void>((res) => {
    releaseHold = res
  })
  gw._releaseHold = () => releaseHold()
  gw.sessions = {
    getByKey: (key: string) => (key === PARENT_KEY ? parentSession : undefined),
    interrupt: () => false,
    getOrCreate: async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
    }),
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      await gw._holdGate
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function delegate(gw: any, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const req: any = { method: 'POST', headers: {} }
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
  await gw.handleDelegateTask(req, res, 'coding-assistant')
  return { status, body: raw ? JSON.parse(raw) : {} }
}

function taskBody(goal: string): Record<string, unknown> {
  return { goal, sourceAgent: 'main', parentSessionKey: PARENT_KEY }
}

describe('fan-out 并行委派 — per-parent 分桶消化并发,超桶排队而非拒绝', () => {
  it('同父 4 路并发:3 个占满桶、第 4 个排队,释放后全部 200(无 429)', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    // 一次并行派发 4 个独立子任务(模拟 delegate_tasks 的 Promise.all)。
    const pending = [0, 1, 2, 3].map((i) => delegate(gw, taskBody(`子任务 ${i}`)))
    // 让前 3 个过闸占满 per-parent 桶(3),第 4 个进排队。
    await sleep(80)
    assert.equal(
      gw._runningDelegationsByParent.get(PARENT_KEY),
      3,
      'per-parent 桶应恰好占满 3(不超发)',
    )
    assert.equal(gw._delegateQueueWaiters?.size, 1, '第 4 个应在排队,而不是被拒绝')
    // 放行:前 3 个收尾释放槽 → 第 4 个被唤醒过闸执行。
    gw._releaseHold()
    const results = await Promise.all(pending)
    for (const [i, r] of results.entries()) {
      assert.equal(r.status, 200, `子任务 ${i} 最终应放行(排队而非硬拒)`)
      assert.equal(r.body.ok, true)
    }
    assert.equal(gw._activeDelegations, 0, '收尾后全局并发名额归零')
    assert.equal(gw._runningDelegationsByParent.get(PARENT_KEY) ?? 0, 0, 'per-parent 桶归零')
    assert.equal(gw._delegateQueueWaiters?.size ?? 0, 0, '等待者表清空')
  })
})
