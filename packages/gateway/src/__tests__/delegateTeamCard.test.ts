/**
 * P2 债A — handleDelegateTask 收尾产出 server-authored 团队卡 durable 载荷。
 *
 * 委派完成/失败/超时收尾处,应把 `{runId, agentId, goal, status, resultSummary?,
 * completedAt}` 经 `bufferPendingAgentGroup` 挂到父(队长)会话,供其 turn 收尾
 * 随 persistServerAuthoredTurn 一并下发。这里驱动真实 handleDelegateTask(沿用
 * delegateResourceQueue.test.ts 的 `Object.create(Gateway.prototype)` + 手工 stub
 * 脚手架),断言 buffering 行为(status 三分支 / resultSummary 截断 / 无 webchat 父
 * 时不物化),不是源码正则。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateTeamCard.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway, HiddenDelegateGuard } from '../server.js'
import type { DurableAgentGroup } from '@openclaude/protocol'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-teamcard'
const PARENT_PEER = 'wsess-teamcard'

type SubmitImpl = (
  session: unknown,
  payload: string,
  onEvent: (e: any) => void,
) => Promise<unknown>

function makeGateway(opts: { submit: SubmitImpl; withParent?: boolean }): {
  gw: any
  buffered: Array<{ sessionKey: string; group: DurableAgentGroup }>
} {
  const buffered: Array<{ sessionKey: string; group: DurableAgentGroup }> = []
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
  gw._hiddenDelegateGuard = new HiddenDelegateGuard()
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
    agents: [
      { id: 'main', provider: 'anthropic', model: 'glm-5.2' },
      { id: 'coding-assistant' },
    ],
  })
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw.sessions = {
    getByKey: (key: string) =>
      opts.withParent === false ? undefined : key === PARENT_KEY ? parentSession : undefined,
    interrupt: () => false,
    getOrCreate: async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
    }),
    submit: opts.submit,
    // P2 债A — record the durable team-card buffer calls.
    bufferPendingAgentGroup: (sessionKey: string, group: DurableAgentGroup) => {
      buffered.push({ sessionKey, group })
      return true
    },
  }
  gw.delivered = [] as any[]
  gw.deliver = (out: any) => gw.delivered.push(out)
  return { gw, buffered }
}

async function delegate(
  gw: any,
  targetAgentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const req: any = { method: 'POST', headers: {} }
  gw.readBody = async () => JSON.stringify(body)
  let status = 0
  let raw = ''
  const res: any = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => { raw = String(chunk ?? '') },
  }
  await gw.handleDelegateTask(req, res, targetAgentId)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

function taskBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: '实现子任务',
    context: '上下文…',
    sourceAgent: 'main',
    parentSessionKey: PARENT_KEY,
    ...extra,
  }
}

describe('handleDelegateTask — server-authored 团队卡 buffering (P2 债A)', () => {
  it('成功委派 → 收尾 buffer status "ok" + resultSummary=输出,挂到父 webchat 会话', async () => {
    const { gw, buffered } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: '子任务结果摘要' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })
    const before = Date.now()
    const r = await delegate(gw, 'coding-assistant', taskBody({ goal: '重构模块' }))
    assert.equal(r.status, 200)
    assert.equal(buffered.length, 1, '恰好 buffer 一次')
    const { sessionKey, group } = buffered[0]
    assert.equal(sessionKey, PARENT_KEY, '挂到父(队长)webchat 会话')
    assert.equal(group.agentId, 'coding-assistant')
    assert.equal(group.goal, '重构模块')
    assert.equal(group.status, 'ok')
    assert.equal(group.resultSummary, '子任务结果摘要')
    assert.match(group.runId, /^dlg-/, 'runId = delegate progress runId')
    assert.ok(group.completedAt >= before && group.completedAt <= Date.now())
  })

  it('失败委派(子 agent 报 error)→ 收尾 buffer status "failed" + resultSummary=错误', async () => {
    const { gw, buffered } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'error', error: '子任务执行失败:依赖缺失' })
      },
    })
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200)
    assert.equal(buffered.length, 1)
    assert.equal(buffered[0].group.status, 'failed')
    assert.equal(buffered[0].group.resultSummary, '子任务执行失败:依赖缺失')
  })

  it('超时委派(DelegateTimeoutError)→ 收尾 buffer status "timeout"', async () => {
    const { gw, buffered } = makeGateway({
      submit: async () => {
        const e = new Error('子 agent 委派超时,已中断。')
        e.name = 'DelegateTimeoutError'
        throw e
      },
    })
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200)
    assert.equal(buffered.length, 1)
    assert.equal(buffered[0].group.status, 'timeout', 'timeout 与 failed 可区分')
  })

  it('resultSummary 在生成点截断 ≤2KB(超长输出 → 2000 字符 + 省略号)', async () => {
    const long = 'x'.repeat(5000)
    const { gw, buffered } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: long } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })
    await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(buffered.length, 1)
    const summary = buffered[0].group.resultSummary!
    assert.equal(summary.length, 2001, '2000 字符 + 1 省略号')
    assert.ok(summary.endsWith('…'))
  })

  it('无 webchat 父(progressTarget 缺席)→ 不物化 buffer(降级 client-only,无回归)', async () => {
    const { gw, buffered } = makeGateway({
      withParent: false,
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'ok' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })
    // parentSessionKey 仍传,但 getByKey 返回 undefined → progressTarget 为 null。
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200, '委派本身仍成功')
    assert.equal(buffered.length, 0, '无父会话 → 不 buffer 团队卡')
  })
})
