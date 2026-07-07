/**
 * hidden 系统 agent(隐藏审查员)串行委派硬上限的行为测试。
 *
 * 背景:team-mode prompt 的"NEEDS_FIX→修→再审→迭代到 PASS"闭环没有代码级
 * 迭代上限,每轮 review 都是全新 delegate session 全额计费;delegation depth
 * 只管嵌套、MAX_CONCURRENT_DELEGATIONS 只管并行,都拦不住串行重试。
 *
 * 测试策略沿用 wechatLiveDispatch.test.ts 的先例:`Object.create(Gateway.prototype)`
 * + 手工 stub dispatchInbound / handleDelegateTask 触碰到的字段,直接驱动真实的
 * handleDelegateTask / dispatchInbound 方法体 —— 断言的是行为(HTTP 状态 + 响应
 * 体),不是源码正则。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/hiddenDelegateLimit.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { InboundFrame } from '@openclaude/protocol'

import { Gateway, PerTurnDelegationGuard, MAX_HIDDEN_DELEGATIONS_PER_TURN } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-hidden-limit'

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

function makeGateway(): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw.clientsByPeer = new Map()
  gw.lastActiveChannel = new Map()
  gw._seenIdempotencyKeys = new Map()
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.rateLimiter = { check: () => true }
  gw.router = { route: () => ({ sessionKey: PARENT_KEY, agent }) }
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
  gw._isIdempotencyDuplicate = () => false
  gw._markIdempotencyKey = () => {}
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw.sessions = {
    // team-durability — 一次性委派子会话收尾即销毁(fake 为 no-op,防泄漏语义在生产实现)
    destroySession: async () => {},
    beginClientTurn: () => {},
    endClientTurn: () => {},
    // 队长自主送审(2026-07-07):hidden 目标委派要过团队门 —— fake 父会话恒为
    // 团队模式队长 turn,让本文件继续专注串行硬上限语义。
    getByKey: () => ({ _teamModeTurn: true, _currentTurnUserText: '测试任务' }),
    getOrCreate: async () => ({
      agentId: 'main',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
    }),
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'block', block: { kind: 'text', text: '审查完成:PASS' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
  }
  gw.deliver = () => {}
  return gw
}

/** 驱动一次真实的 handleDelegateTask,返回 HTTP 状态码 + 解析后的响应体。 */
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
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? '')
    },
  }
  await gw.handleDelegateTask(req, res, targetAgentId)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

function reviewBody(): Record<string, unknown> {
  return {
    goal: '审查队长草稿',
    context: '草稿内容…',
    sourceAgent: 'main',
    parentSessionKey: PARENT_KEY,
  }
}

/** 模拟同一父会话收到下一条用户消息(开启新 turn)。 */
async function newUserTurn(gw: any): Promise<void> {
  const frame: InboundFrame = {
    type: 'inbound.message',
    channel: 'webchat',
    peer: { id: 'wsess-hidden-limit', kind: 'dm' },
    content: { text: '下一个问题', media: [] },
    _userId: '1',
  } as any
  await gw.dispatchInbound(frame)
}

// ── PerTurnDelegationGuard 单元行为 ─────────────────────────────────────────────

describe('PerTurnDelegationGuard — 计数器单元行为', () => {
  it('同一 key 前 N 次放行,第 N+1 次拒绝;reset 后额度恢复', () => {
    const guard = new PerTurnDelegationGuard(3)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.tryAcquire('p1'), false)
    assert.equal(guard.tryAcquire('p1'), false, '拒绝不额外累计,持续拒绝')
    guard.resetForParent('p1')
    assert.equal(guard.tryAcquire('p1'), true)
  })

  it('不同 key 互不影响', () => {
    const guard = new PerTurnDelegationGuard(1)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.tryAcquire('p2'), true)
    assert.equal(guard.tryAcquire('p1'), false)
    assert.equal(guard.tryAcquire('p2'), false)
  })

  it('TTL 惰性清扫:超过 staleMs 的旧条目在下次 tryAcquire 时回收(防泄漏/防永久锁死)', () => {
    const guard = new PerTurnDelegationGuard(1, 60_000)
    const t0 = 1_000_000
    assert.equal(guard.tryAcquire('cron-parent', t0), true)
    assert.equal(guard.tryAcquire('cron-parent', t0 + 1), false, 'TTL 内仍受限')
    assert.equal(guard.tryAcquire('cron-parent', t0 + 61_000), true, '过期后额度自动恢复')
  })
})

// ── handleDelegateTask 行为 ─────────────────────────────────────────────────

describe('handleDelegateTask — hidden 审查员串行硬上限', () => {
  it(`同一父 turn 连续委派:前 ${MAX_HIDDEN_DELEGATIONS_PER_TURN} 次正常,第 ${MAX_HIDDEN_DELEGATIONS_PER_TURN + 1} 次收到上限错误(非 500)`, async () => {
    const gw = makeGateway()
    for (let i = 0; i < MAX_HIDDEN_DELEGATIONS_PER_TURN; i++) {
      const r = await delegate(gw, 'hidden-reviewer', reviewBody())
      assert.equal(r.status, 200, `第 ${i + 1} 次委派应放行`)
      assert.equal(r.body.ok, true)
      assert.match(r.body.output, /PASS/)
    }
    const blocked = await delegate(gw, 'hidden-reviewer', reviewBody())
    assert.equal(blocked.status, 429, '超限必须走既有 delegate 失败形状,不是 500')
    assert.match(blocked.body.error, /审查委派已达本轮上限/)
    assert.match(blocked.body.error, new RegExp(String(MAX_HIDDEN_DELEGATIONS_PER_TURN)))
    // 持续拒绝:第 5 次依旧被拦
    const blockedAgain = await delegate(gw, 'hidden-reviewer', reviewBody())
    assert.equal(blockedAgain.status, 429)
  })

  it('新用户 turn(dispatchInbound)开启后计数重置,可再次委派', async () => {
    const gw = makeGateway()
    for (let i = 0; i < MAX_HIDDEN_DELEGATIONS_PER_TURN; i++) {
      assert.equal((await delegate(gw, 'hidden-reviewer', reviewBody())).status, 200)
    }
    assert.equal((await delegate(gw, 'hidden-reviewer', reviewBody())).status, 429)

    // 同一父会话收到下一条用户消息 → dispatchInbound 划定新 turn 边界并清零
    await newUserTurn(gw)

    const afterReset = await delegate(gw, 'hidden-reviewer', reviewBody())
    assert.equal(afterReset.status, 200, '新 turn 后额度必须恢复')
    assert.equal(afterReset.body.ok, true)
  })

  it('上限只针对 hidden 系统 agent — 普通成员不受串行上限影响', async () => {
    const gw = makeGateway()
    for (let i = 0; i < MAX_HIDDEN_DELEGATIONS_PER_TURN + 2; i++) {
      const r = await delegate(gw, 'coding-assistant', {
        goal: '实现子任务',
        sourceAgent: 'main',
        parentSessionKey: PARENT_KEY,
      })
      assert.equal(r.status, 200, `普通成员第 ${i + 1} 次委派不应被串行上限拦截`)
    }
  })

  it('不同父会话的计数互相隔离', async () => {
    const gw = makeGateway()
    for (let i = 0; i < MAX_HIDDEN_DELEGATIONS_PER_TURN; i++) {
      assert.equal((await delegate(gw, 'hidden-reviewer', reviewBody())).status, 200)
    }
    assert.equal((await delegate(gw, 'hidden-reviewer', reviewBody())).status, 429)
    // 另一个父会话(如另一个 webchat 会话)不受影响
    const other = await delegate(gw, 'hidden-reviewer', {
      ...reviewBody(),
      parentSessionKey: 'agent:main:webchat:dm:wsess-other',
    })
    assert.equal(other.status, 200)
  })

  it('body 缺 parentSessionKey → 团队门 409 直接拒绝(比退化计数更强的无绕过口)', async () => {
    // 队长自主送审(2026-07-07):无父会话键 = 无法核验团队 turn = 审查 fail-closed。
    // 旧语义(退化按 sourceAgent 计数)由团队门取代 —— 连首个请求都进不来,防绕过更强。
    const gw = makeGateway()
    const body = { goal: '审查', sourceAgent: 'main' }
    const blocked = await delegate(gw, 'hidden-reviewer', body)
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.error, /仅在团队模式/)
  })

  it('父会话非团队 turn → 审查 409 拒绝(非团队会话防误触发计费)', async () => {
    const gw = makeGateway()
    gw.sessions.getByKey = () => ({ _teamModeTurn: false })
    const blocked = await delegate(gw, 'hidden-reviewer', {
      goal: '审查',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.error, /仅在团队模式/)
  })
})
