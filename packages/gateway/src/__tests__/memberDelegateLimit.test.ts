/**
 * P2 批次4 — 普通成员每 turn 委派上限 + effort 透传 + 回传输出封顶 的行为测试。
 *
 * 沿用 hiddenDelegateLimit.test.ts 先例:`Object.create(Gateway.prototype)` + 手工 stub,
 * 直接驱动真实 handleDelegateTask / _runDelegateTask 方法体,断言行为(HTTP 状态/响应体/
 * 透传到 submit 的 effort/回传 output 是否封顶),不是源码正则。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/memberDelegateLimit.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { InboundFrame } from '@openclaude/protocol'

import {
  Gateway,
  MAX_HIDDEN_DELEGATIONS_PER_TURN,
  MEMBER_DELEGATIONS_PER_TURN_DEFAULT,
  PerTurnDelegationGuard,
} from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-member-limit'

const ENV_KEYS = [
  'OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN',
  'OPENCLAUDE_DELEGATE_OUTPUT_CAP',
] as const
const ORIG_ENV: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k]
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIG_ENV[k]
  }
})

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
  // _memberDelegateGuard 故意不初始化 —— 验证使用处惰性 ??= 在 Object.create 脚手架下也安全。
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
  // 可控:提交时回传的文本(用于封顶测试)+ 捕获透传进来的 effortLevel。
  gw._submitOutputText = '子任务完成'
  gw._lastSubmitEffort = 'UNSET'
  gw.sessions = {
    // team-durability — 一次性委派子会话收尾即销毁(fake 为 no-op,防泄漏语义在生产实现)
    destroySession: async () => {},
    beginClientTurn: () => {},
    endClientTurn: () => {},
    // 队长自主送审(2026-07-07):hidden 目标委派要过团队门 —— fake 父会话恒为团队 turn。
    getByKey: () => ({ _teamModeTurn: true, _currentTurnUserText: '测试任务' }),
    getOrCreate: async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
    }),
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      effortLevel?: string | null,
    ) => {
      gw._lastSubmitEffort = effortLevel
      onEvent({ kind: 'block', block: { kind: 'text', text: gw._submitOutputText } })
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

function memberBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { goal: '实现子任务', context: '上下文…', sourceAgent: 'main', parentSessionKey: PARENT_KEY, ...extra }
}

async function newUserTurn(gw: any): Promise<void> {
  const frame: InboundFrame = {
    type: 'inbound.message',
    channel: 'webchat',
    peer: { id: 'wsess-member-limit', kind: 'dm' },
    content: { text: '下一个问题', media: [] },
    _userId: '1',
  } as any
  await gw.dispatchInbound(frame)
}

// ── 普通成员每 turn 上限 ─────────────────────────────────────────────────────

describe('普通成员每 turn 委派上限', () => {
  it(`默认上限 ${MEMBER_DELEGATIONS_PER_TURN_DEFAULT}:前 N 次放行,第 N+1 次结构化 429(非静默/非 500)`, async () => {
    const gw = makeGateway()
    for (let i = 0; i < MEMBER_DELEGATIONS_PER_TURN_DEFAULT; i++) {
      const r = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(r.status, 200, `第 ${i + 1} 次成员委派应放行`)
      assert.equal(r.body.ok, true)
    }
    const blocked = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(blocked.status, 429, '超限走 delegate 失败形状(429),不是 500,也不是静默')
    assert.match(blocked.body.error, /本轮委派已达上限/)
    assert.match(blocked.body.error, new RegExp(String(MEMBER_DELEGATIONS_PER_TURN_DEFAULT)))
    // 持续拒绝
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 429)
  })

  it('env OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN 覆盖上限(惰性 init 读 env)', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    const blocked = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(blocked.status, 429)
    assert.match(blocked.body.error, /2 次/)
  })

  it('新用户 turn(dispatchInbound)重置成员计数,可再次委派', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 429)
    await newUserTurn(gw)
    assert.equal(
      (await delegate(gw, 'coding-assistant', memberBody())).status,
      200,
      '新 turn 后成员额度必须恢复',
    )
  })

  it('成员计数与 hidden 审查员计数互相隔离(hidden 委派不消耗成员额度,反之亦然)', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    // 先打满 hidden 审查员 3 次(hidden 上限 3),这些不该占用成员额度。
    for (let i = 0; i < MAX_HIDDEN_DELEGATIONS_PER_TURN; i++) {
      assert.equal((await delegate(gw, 'hidden-reviewer', memberBody())).status, 200)
    }
    // 成员额度仍是满的:2 次成员委派应全部放行。
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    // 第 3 次成员超本 turn 上限(2)。
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 429)
    // 而 hidden 已达自己的上限(3),第 4 次 hidden 走 hidden 的 429 文案。
    const hiddenBlocked = await delegate(gw, 'hidden-reviewer', memberBody())
    assert.equal(hiddenBlocked.status, 429)
    assert.match(hiddenBlocked.body.error, /审查委派已达本轮上限/)
  })

  it('body 缺 parentSessionKey 时退化为按 sourceAgent 计数,上限仍生效(无绕过口)', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '1'
    const gw = makeGateway()
    const body = { goal: '实现', sourceAgent: 'main' }
    assert.equal((await delegate(gw, 'coding-assistant', body)).status, 200)
    const blocked = await delegate(gw, 'coding-assistant', body)
    assert.equal(blocked.status, 429)
    assert.match(blocked.body.error, /本轮委派已达上限/)
  })
})

// ── effort 分档透传 ──────────────────────────────────────────────────────────

describe('effort 透传到 sessions.submit', () => {
  it('body.effort=high → submit 收到 effortLevel="high"', async () => {
    const gw = makeGateway()
    const r = await delegate(gw, 'coding-assistant', memberBody({ effort: 'high' }))
    assert.equal(r.status, 200)
    assert.equal(gw._lastSubmitEffort, 'high')
  })

  it('不带 effort → submit 收到 undefined(不动成员默认档位)', async () => {
    const gw = makeGateway()
    await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(gw._lastSubmitEffort, undefined)
  })

  it('非法 effort(如 "turbo")被白名单剔除 → submit 收到 undefined', async () => {
    const gw = makeGateway()
    await delegate(gw, 'coding-assistant', memberBody({ effort: 'turbo' }))
    assert.equal(gw._lastSubmitEffort, undefined)
  })

  it('low/medium 均透传', async () => {
    const gw = makeGateway()
    await delegate(gw, 'coding-assistant', memberBody({ effort: 'low' }))
    assert.equal(gw._lastSubmitEffort, 'low')
    await delegate(gw, 'coding-assistant', memberBody({ effort: 'medium' }))
    assert.equal(gw._lastSubmitEffort, 'medium')
  })
})

// ── 回传 output 兜底封顶 ─────────────────────────────────────────────────────

describe('委派回传 output 封顶', () => {
  it('普通成员超长回传被截断到默认 4000 字 + 尾注引导落文件', async () => {
    const gw = makeGateway()
    gw._submitOutputText = 'A'.repeat(5000)
    const r = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(r.status, 200)
    assert.ok(r.body.output.length < 5000, '应被截断')
    assert.ok(r.body.output.startsWith('A'.repeat(4000)), '保留前 4000 字')
    assert.match(r.body.output, /\[输出过长已截断至 4000 字/)
    assert.match(r.body.output, /generated\//)
  })

  it('短回传不被截断,不加尾注', async () => {
    const gw = makeGateway()
    gw._submitOutputText = '简短结论'
    const r = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(r.body.output, '简短结论')
    assert.doesNotMatch(r.body.output, /已截断/)
  })

  it('env OPENCLAUDE_DELEGATE_OUTPUT_CAP 覆盖封顶阈值', async () => {
    process.env.OPENCLAUDE_DELEGATE_OUTPUT_CAP = '1000'
    const gw = makeGateway()
    gw._submitOutputText = 'B'.repeat(3000)
    const r = await delegate(gw, 'coding-assistant', memberBody())
    assert.ok(r.body.output.startsWith('B'.repeat(1000)))
    assert.match(r.body.output, /已截断至 1000 字/)
  })

  it('review 委派回传**不**封顶(要全量喂回队长续写)', async () => {
    const gw = makeGateway()
    gw._submitOutputText = 'R'.repeat(6000)
    // 直接驱动内部编排入口 _runDelegateTask(isReview:true);HTTP 路径永不置 isReview。
    const result = await gw._runDelegateTask({
      targetAgentId: 'hidden-reviewer',
      goal: '审查草稿',
      context: '草稿…',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      depth: 0,
      isReview: true,
    })
    assert.equal(result.kind, 'completed')
    assert.equal(result.output.length, 6000, 'review 输出必须全量保留')
    assert.doesNotMatch(result.output, /已截断/)
  })
})
