/**
 * P2 批次4 — 普通成员每 turn 委派上限 + effort 透传 + 回传输出无损 的行为测试。
 *
 * 沿用 hiddenDelegateLimit.test.ts 先例:`Object.create(Gateway.prototype)` + 手工 stub,
 * 直接驱动真实 handleDelegateTask / _runDelegateTask 方法体,断言行为(HTTP 状态/响应体/
 * 透传到 submit 的 effort/回传 output 是否完整),不是源码正则。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/memberDelegateLimit.test.ts
 */
import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'

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
  'OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN',
] as const
const ORIG_ENV: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k]
function restoreDelegateLimitEnv(): void {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIG_ENV[k]
  }
}
function clearDelegateLimitEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}
clearDelegateLimitEnv()
afterEach(() => {
  clearDelegateLimitEnv()
})
after(() => {
  restoreDelegateLimitEnv()
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
  // 可控:提交时回传的文本(用于无损测试)+ 捕获透传进来的 effortLevel。
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

// ── 回传 output 无损 ─────────────────────────────────────────────────────────

describe('委派回传 output 无损', () => {
  it('普通成员超长回传完整交给队长', async () => {
    const gw = makeGateway()
    const full = 'A'.repeat(50_000)
    gw._submitOutputText = full
    const r = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(r.status, 200)
    assert.equal(r.body.output, full)
  })

  it('短回传原样保留', async () => {
    const gw = makeGateway()
    gw._submitOutputText = '简短结论'
    const r = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(r.body.output, '简短结论')
  })

  it('review 委派同样全量喂回队长续写', async () => {
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
  })
})


describe('preflight quota preserves hidden and member limits', () => {
  for (const target of ['coding-assistant', 'hidden-reviewer']) {
    it(`missing ${target} preflight does not consume quota`, async () => {
      process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '1'
      process.env.OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN = '1'
      const gw = makeGateway()
      const getConfig = gw._getAgentsConfig
      gw._getAgentsConfig = async () => {
        const cfg = await getConfig()
        return { ...cfg, agents: cfg.agents.filter((a: { id: string }) => a.id !== target) }
      }
      for (let i = 0; i < 4; i++) {
        assert.equal((await delegate(gw, target, memberBody())).status, 404)
      }
      gw._getAgentsConfig = getConfig
      assert.equal((await delegate(gw, target, memberBody())).status, 200)
      assert.equal((await delegate(gw, target, memberBody())).status, 429)
    })
  }

  it('spawned submit failure still consumes member quota', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '1'
    const gw = makeGateway()
    let submitted = 0
    gw.sessions.submit = async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
      submitted++
      onEvent({ kind: 'block', block: { kind: 'text', text: 'partial output before runner error' } })
      throw new Error('started runner failed')
    }
    await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(submitted, 1)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 429)
    assert.equal(submitted, 1)
  })

  it('concurrent valid members share one synchronous quota acquisition', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '1'
    const gw = makeGateway()
    const results = await Promise.all([
      delegate(gw, 'coding-assistant', memberBody()),
      delegate(gw, 'coding-assistant', memberBody()),
    ])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 429])
  })
})

describe('OCV5-895: 默认 16 配额 + 零输出失败/早退退还 + rawLimit 防风暴', () => {
  it('默认上限为 16:前 16 次放行,第 17 次返回 429', async () => {
    assert.equal(MEMBER_DELEGATIONS_PER_TURN_DEFAULT, 16)
    const gw = makeGateway()
    for (let i = 0; i < 16; i++) {
      const r = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(r.status, 200, `第 ${i + 1} 次委派应放行`)
      assert.equal(r.body.ok, true)
    }
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 16)
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 16)
    const blocked = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(blocked.status, 429)
    assert.match(blocked.body.error, /16 次/)
  })

  it('零输出上游失败(error 事件与抛错)及 getOrCreate/资源闸早退均退还额度,后续轮次不饿死', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const origWait = process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '30'
    try {
      const gw = makeGateway()
      gw._delegateQueuePollMs = 5
      // 1) 资源闸内存高压超时早退 → 退还额度
      gw._readDelegateMemoryPressure = () => ({ current: 9_000, max: 10_000, ratio: 0.9 })
      const gateRejected = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(gateRejected.status, 503)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 1)
      gw._readDelegateMemoryPressure = () => null

      // 2) getOrCreate 抛错 → 退还额度
      const origGetOrCreate = gw.sessions.getOrCreate
      gw.sessions.getOrCreate = async () => { throw new Error('spawn failed') }
      const spawnErr = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(spawnErr.status, 500)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 2)
      gw.sessions.getOrCreate = origGetOrCreate

      // 3) 上游 500 熔断 error 事件(零文本输出) → 退还额度
      const origSubmit = gw.sessions.submit
      gw.sessions.submit = async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
        onEvent({ kind: 'error', error: 'HTTP 500 upstream circuit open' })
      }
      const upstream500 = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(upstream500.status, 200)
      assert.equal(upstream500.body.ok, false)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 3)

      // 4) submit 抛错且零文本输出 → 退还额度
      gw.sessions.submit = async () => { throw new Error('HTTP 429 rate limited') }
      const upstream429 = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(upstream429.status, 200)
      assert.equal(upstream429.body.ok, false)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 4)

      // 5) 恢复正常后,2 个有效额度仍然完整可用(rawLimit = max(4, 6) = 6,还剩 2 次 rawAttempts)
      gw.sessions.submit = origSubmit
      assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
      assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 2)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 6)
      assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 429)
    } finally {
      if (origWait === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS')
      else process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = origWait
    }
  })

  it('连续零输出失败达 rawLimit 仍被硬熔断防重试风暴', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => null
    let submitted = 0
    gw.sessions.submit = async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
      submitted++
      onEvent({ kind: 'error', error: 'HTTP 500 upstream failure' })
    }
    // limit=2 -> rawLimit = Math.max(2 * 2, 2 + 4) = 6
    for (let i = 0; i < 6; i++) {
      const r = await delegate(gw, 'coding-assistant', memberBody())
      assert.equal(r.status, 200, `第 ${i + 1} 次应放行并退还有效计数`)
      assert.equal(r.body.ok, false)
      assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
      assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), i + 1)
    }
    assert.equal(submitted, 6)
    const tripped = await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(tripped.status, 429, 'rawAttempts 触顶后必须硬熔断防无限重试风暴')
    assert.equal(submitted, 6, '熔断后不得再进入 submit')
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 6)
  })

  it('用户取消或超时即使零输出也不退还成员额度', async () => {
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '1'
    const gwCancel = makeGateway()
    gwCancel._readDelegateMemoryPressure = () => null
    gwCancel.sessions.submit = async (_s: unknown, _p: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'error', error: 'cancelled by user', errorCode: 'user_cancelled' })
    }
    const cancelled = await delegate(gwCancel, 'coding-assistant', memberBody())
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.ok, false)
    assert.equal(gwCancel._memberDelegateGuard.countFor(PARENT_KEY), 1, '用户取消不退还额度')
    assert.equal((await delegate(gwCancel, 'coding-assistant', memberBody())).status, 429)

    const gwTimeout = makeGateway()
    gwTimeout._readDelegateMemoryPressure = () => null
    gwTimeout._delegateTimeoutConfig = { idleTimeoutMs: 15, checkIntervalMs: 5 }
    let releaseSubmit: (() => void) | undefined
    gwTimeout.sessions.getOrCreate = async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: {
        interrupt: () => releaseSubmit?.(),
        shutdown: async () => releaseSubmit?.(),
        waitForOutputDrain: async () => {},
        sendPermissionResponse: () => {},
      },
    })
    gwTimeout.sessions.submit = async () =>
      new Promise<void>((resolve) => {
        releaseSubmit = resolve
      })
    const timedOut = await delegate(gwTimeout, 'coding-assistant', memberBody())
    assert.equal(timedOut.status, 200)
    assert.equal(timedOut.body.ok, false)
    assert.equal(gwTimeout._memberDelegateGuard.countFor(PARENT_KEY), 1, '超时不退还额度')
    assert.equal((await delegate(gwTimeout, 'coding-assistant', memberBody())).status, 429)
  })

  it('同一次调用不会重复退还,且 PerTurnDelegationGuard.refund 不退 rawAttempts 也不降为负', async () => {
    const guard = new PerTurnDelegationGuard(2)
    guard.refund('missing')
    assert.equal(guard.countFor('missing'), 0)
    assert.equal(guard.rawAttemptsFor('missing'), 0)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.tryAcquire('p1'), true)
    assert.equal(guard.countFor('p1'), 2)
    assert.equal(guard.rawAttemptsFor('p1'), 2)
    guard.refund('p1')
    assert.equal(guard.countFor('p1'), 1)
    assert.equal(guard.rawAttemptsFor('p1'), 2)
    guard.refund('p1')
    guard.refund('p1')
    assert.equal(guard.countFor('p1'), 0)
    assert.equal(guard.rawAttemptsFor('p1'), 2)

    // 运行时验证:一次成功占 1 额,另一次零输出失败仅退还自己的 1 额(绝不双退把成功的那次也退掉)
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => null
    const memberGuard = new PerTurnDelegationGuard(2)
    let refundCalls = 0
    const origRefundToken = memberGuard.refundToken.bind(memberGuard)
    memberGuard.refundToken = (token) => {
      refundCalls++
      return origRefundToken(token)
    }
    gw._memberDelegateGuard = memberGuard
    assert.equal((await delegate(gw, 'coding-assistant', memberBody())).status, 200)
    assert.equal(memberGuard.countFor(PARENT_KEY), 1)

    gw.sessions.submit = async () => { throw new Error('upstream 500') }
    await delegate(gw, 'coding-assistant', memberBody())
    assert.equal(refundCalls, 1, '单次零输出失败只允许退还一次')
    assert.equal(memberGuard.countFor(PARENT_KEY), 1, '不得把先前成功委派的额度一并退掉')
    assert.equal(memberGuard.rawAttemptsFor(PARENT_KEY), 2)
  })

  it('OCV5-895 B5: 跨轮迟到零输出退款绑定代次凭证,严禁错扣新轮有效占用', async () => {
    // 1) 单元级验证:resetForParent 与 TTL 过期重建均切换 generation,旧 token 返回 false 零副作用
    const guard = new PerTurnDelegationGuard(2, 1_000)
    const t0 = 10_000
    const g1 = guard.acquireToken('p1', t0)
    assert.equal(g1.ok, true)
    if (!g1.ok) return
    guard.resetForParent('p1')
    assert.equal(guard.refundToken(g1.token), false, 'reset 后空条目必须返回 false')
    const g2 = guard.acquireToken('p1', t0 + 10)
    assert.equal(g2.ok, true)
    if (!g2.ok) return
    assert.notEqual(g2.token.generation, g1.token.generation)
    assert.equal(guard.refundToken(g1.token), false, '旧代次 token 不得扣减新代次 count')
    assert.equal(guard.countFor('p1'), 1)
    assert.equal(guard.rawAttemptsFor('p1'), 1)
    // TTL 过期重建同理
    const g3 = guard.acquireToken('p1', t0 + 2_000)
    assert.equal(g3.ok, true)
    if (!g3.ok) return
    assert.notEqual(g3.token.generation, g2.token.generation)
    assert.equal(guard.refundToken(g2.token), false, 'TTL 过期前旧 token 不得扣减重建条目')
    assert.equal(guard.countFor('p1'), 1)
    assert.equal(guard.refundToken(g3.token), true)
    assert.equal(guard.countFor('p1'), 0)
    assert.equal(guard.rawAttemptsFor('p1'), 1)

    // 2) 运行时交错回归:旧轮获得额度并挂起 → 新用户回合 dispatchInbound reset → 新轮占用额度 → 旧轮迟到零输出失败退款
    process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN = '2'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => null
    let releaseTurn1!: () => void
    let turn1Entered!: () => void
    const turn1EnteredReady = new Promise<void>((resolve) => {
      turn1Entered = resolve
    })
    const turn1Gate = new Promise<void>((resolve) => {
      releaseTurn1 = resolve
    })
    const origSubmit = gw.sessions.submit
    let submitSeq = 0
    gw.sessions.submit = async (
      session: unknown,
      payload: string,
      onEvent: (e: any) => void,
      effortLevel?: string | null,
    ) => {
      submitSeq += 1
      if (submitSeq === 1) {
        // 旧轮挂起,等新轮占完额度后再以零输出上游 500 失败收尾
        turn1Entered()
        await turn1Gate
        onEvent({ kind: 'error', error: 'HTTP 500 late failure from previous turn' })
        return
      }
      await origSubmit(session, payload, onEvent, effortLevel)
    }

    const turn1Pending = delegate(gw, 'coding-assistant', memberBody({ goal: 'turn-1-late-fail' }))
    await turn1EnteredReady
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 1)
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 1)

    // 新用户 turn 到达 → dispatchInbound 调用 resetForParent(PARENT_KEY)
    await newUserTurn(gw)
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 0)
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 0)

    // 新轮占用 1 份有效额度
    const turn2First = await delegate(gw, 'coding-assistant', memberBody({ goal: 'turn-2-first' }))
    assert.equal(turn2First.status, 200)
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 1)
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 1)

    // 释放旧轮使其以零输出失败收尾并尝试 refundMemberQuota
    releaseTurn1()
    const turn1Result = await turn1Pending
    assert.equal(turn1Result.status, 200)
    assert.equal(turn1Result.body.ok, false)

    // 新轮有效占用与 rawAttempts 必须丝毫未变!
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 1, '旧轮迟到退款绝不得错扣新轮有效占用')
    assert.equal(gw._memberDelegateGuard.rawAttemptsFor(PARENT_KEY), 1)

    // 新轮仅剩 1 份额度:第 2 次放行,第 3 次必须 429
    assert.equal((await delegate(gw, 'coding-assistant', memberBody({ goal: 'turn-2-second' }))).status, 200)
    assert.equal(gw._memberDelegateGuard.countFor(PARENT_KEY), 2)
    assert.equal((await delegate(gw, 'coding-assistant', memberBody({ goal: 'turn-2-third' }))).status, 429)
  })
})
