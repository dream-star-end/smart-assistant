/**
 * delegate 资源闸有界排队(_waitForDelegateCapacity)的行为测试。
 *
 * 背景:delegate 入口有两道资源闸 —— 并发上限(MAX_CONCURRENT_DELEGATIONS,429)
 * 与容器 cgroup 内存水位(阈值 0.85,503)。历史上命中即拒:并行 fanout 多路同秒
 * 双拒,队长收 503 后放弃委派自己兜底。P5(f7453f4d)曾为旧重团队轨实现过排队,
 * 07-02 双轨清理(1ca107a8)连带误删。本批次以进程内有界等待收口重建:
 *   命中任一闸 → 排队轮询复查(封顶 OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS,默认 90s;
 *   等待者上限 8)→ 放行 / 超时按原闸形状拒 / 用户 Stop 级联即时打断。
 *
 * 测试策略沿用 hiddenDelegateLimit.test.ts:`Object.create(Gateway.prototype)` +
 * 手工 stub,直接驱动真实 handleDelegateTask / _waitForDelegateCapacity /
 * _interruptDelegationsForParent 方法体,断言行为(HTTP 状态 + 响应体 + 进度帧),
 * 不是源码正则。内存读数经实例挂钩 _readDelegateMemoryPressure 注入假值。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateResourceQueue.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { DELEGATE_QUEUE_MAX_WAITERS, Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-queue-test'
const PARENT_PEER = 'wsess-queue-test'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 每个用例自行设置;afterEach 统一还原,避免污染同进程其它测试。
const ORIG_QUEUE_WAIT_MS = process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
afterEach(() => {
  if (ORIG_QUEUE_WAIT_MS === undefined) delete process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS
  else process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = ORIG_QUEUE_WAIT_MS
})

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

function makeGateway(): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const parentSession = {
    sessionKey: PARENT_KEY,
    channel: 'webchat',
    peerId: PARENT_PEER,
    agentId: 'main',
    userId: '1',
    repoSessionId: undefined,
    // 队长自主送审(2026-07-07):hidden 目标委派要过团队门。
    _teamModeTurn: true,
    _currentTurnUserText: '测试任务',
  }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  // 排队参数:轮询提速到 10ms,等待封顶由各用例经 env 控制。
  gw._delegateQueuePollMs = 10
  // 默认无内存压力(确定性:不读真实 cgroup);用例按需覆写。
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
    // team-durability — 一次性委派子会话收尾即销毁(fake 为 no-op,防泄漏语义在生产实现)
    destroySession: async () => {},
    getByKey: (key: string) => (key === PARENT_KEY ? parentSession : undefined),
    interrupt: () => false,
    getOrCreate: async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {} },
    }),
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    // P2 债A — handleDelegateTask 收尾把团队卡 buffer 到父会话;此测试不验团队卡,
    // 提供 no-op 桩即可(真实 SessionManager 有此方法)。
    bufferPendingAgentGroup: () => true,
  }
  gw.delivered = [] as any[]
  gw.deliver = (out: any) => {
    gw.delivered.push(out)
  }
  return gw
}

/** 驱动一次真实的 handleDelegateTask,返回 HTTP 状态码 + 解析后的响应体。 */
async function delegate(
  gw: any,
  targetAgentId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
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

/** 高内存水位读数(ratio 0.9 > 默认阈值 0.85)。 */
const HIGH_MEM = { current: 9_000, max: 10_000, ratio: 0.9 }

function progressBlocksOf(gw: any): any[] {
  return gw.delivered.flatMap((out: any) =>
    (out.blocks || []).filter((b: any) => b?.kind === 'delegate_progress'),
  )
}

// ── 命中 → 等待 → 条件恢复 → 放行 ────────────────────────────────────────────

describe('资源闸有界排队 — 命中后等待,条件恢复即放行', () => {
  it('内存闸命中 → 排队轮询 → 水位回落 → 放行(200),名额收尾归零', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    let reads = 0
    gw._readDelegateMemoryPressure = () => {
      reads++
      return reads <= 3 ? HIGH_MEM : null // 前 3 次读数高压,之后回落
    }
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200, '水位恢复后必须放行而不是 503')
    assert.equal(r.body.ok, true)
    assert.match(r.body.output, /子任务完成/)
    assert.ok(reads > 3, `应当轮询复查过内存读数(实际 ${reads} 次)`)
    assert.equal(gw._activeDelegations, 0, '放行占用的并发名额必须在收尾释放')
    assert.equal(gw._delegateQueueWaiters?.size ?? 0, 0, '等待者表必须清空')
  })

  it('并发闸命中 → 排队 → 并发释放 → 放行(200)', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    gw._activeDelegations = 5 // = MAX_CONCURRENT_DELEGATIONS,满载
    setTimeout(() => {
      gw._activeDelegations = 0 // 模拟并发释放
    }, 40)
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200, '并发释放后必须放行而不是 429')
    assert.equal(r.body.ok, true)
    assert.equal(gw._activeDelegations, 0)
  })

  it('无压力快路径:立即放行,不触碰等待者表', async () => {
    const gw = makeGateway()
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200)
    assert.equal(gw._delegateQueueWaiters, undefined, '快路径不应初始化等待者表')
  })

  it('hidden 审查员委派同样走排队(闸内恢复后放行)', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    let reads = 0
    gw._readDelegateMemoryPressure = () => {
      reads++
      return reads <= 2 ? HIGH_MEM : null
    }
    const r = await delegate(gw, 'hidden-reviewer', taskBody({ goal: '审查草稿' }))
    assert.equal(r.status, 200, 'hidden-reviewer 委派同样适用排队而非硬拒')
    assert.equal(r.body.ok, true)
  })
})

// ── 等待封顶 → 按原闸形状拒,文案注明已等待时长 ─────────────────────────────

describe('资源闸有界排队 — 等待封顶', () => {
  it('内存持续高压 → 超时 503,同形文案 + "已等待 Xs 资源仍紧张"', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 503, '内存闸超时必须保持 503 形状')
    assert.match(r.body.error, /delegate resource pressure: memory 90% >= 85%/)
    assert.match(r.body.error, /已等待 \d+s 资源仍紧张/)
    assert.equal(gw._activeDelegations, 0, '被拒请求不得占并发名额')
    assert.equal(gw._delegateQueueWaiters?.size ?? 0, 0)
  })

  it('并发持续满载 → 超时 429,同形文案 + "已等待 Xs 资源仍紧张"', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._activeDelegations = 5
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 429, '并发闸超时必须保持 429 形状')
    assert.match(r.body.error, /too many concurrent delegations \(max 5\)/)
    assert.match(r.body.error, /已等待 \d+s 资源仍紧张/)
    assert.equal(gw._activeDelegations, 5, '等待失败不得改变并发计数')
  })
})

// ── 等待者数量上限:超出直接按现行为拒(防雪崩)─────────────────────────────

describe('资源闸有界排队 — 等待者上限', () => {
  it(`内存闸命中且已有 ${DELEGATE_QUEUE_MAX_WAITERS} 个等待者 → 不排队,立即 503`, async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    gw._delegateQueueWaiters = new Map()
    for (let i = 0; i < DELEGATE_QUEUE_MAX_WAITERS; i++) {
      gw._delegateQueueWaiters.set(`w${i}`, () => {})
    }
    const t0 = Date.now()
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 503)
    assert.match(r.body.error, /delegate resource pressure/)
    assert.match(r.body.error, /排队等待者已满/)
    assert.doesNotMatch(r.body.error, /已等待/, '队满拒绝不是超时拒绝,不带等待时长')
    assert.ok(Date.now() - t0 < 1_000, '队满必须立即拒,不进入等待')
    assert.equal(gw._delegateQueueWaiters.size, DELEGATE_QUEUE_MAX_WAITERS, '不得挤进等待者表')
  })

  it(`并发闸命中且等待者已满 → 立即 429`, async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    gw._activeDelegations = 5
    gw._delegateQueueWaiters = new Map()
    for (let i = 0; i < DELEGATE_QUEUE_MAX_WAITERS; i++) {
      gw._delegateQueueWaiters.set(`w${i}`, () => {})
    }
    const t0 = Date.now()
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 429)
    assert.match(r.body.error, /too many concurrent delegations \(max 5\)/)
    assert.ok(Date.now() - t0 < 1_000)
  })
})

// ── 用户 Stop 级联打断等待 ───────────────────────────────────────────────────

describe('资源闸有界排队 — Stop 级联中断', () => {
  it('排队期间 _interruptDelegationsForParent(父会话)→ 即时唤醒,等待中止', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '10000' // 远大于用例时长
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    const t0 = Date.now()
    const pending = delegate(gw, 'coding-assistant', taskBody())
    await sleep(50) // 让请求进入排队
    assert.equal(gw._delegateQueueWaiters?.size, 1, '此刻应有一个排队等待者')
    const interrupted = gw._interruptDelegationsForParent(PARENT_KEY)
    assert.equal(interrupted, true, 'Stop 级联必须报告命中了排队中的委派')
    const r = await pending
    assert.equal(r.status, 503)
    assert.match(r.body.error, /排队等待已被中断/)
    assert.ok(Date.now() - t0 < 5_000, '中断必须即时生效,不等 10s 封顶')
    assert.equal(gw._delegateQueueWaiters?.size ?? 0, 0)
    assert.equal(gw._activeDelegations, 0)
  })
})

// ── 排队进度提示(复用既有 delegate progress 通道)───────────────────────────

describe('资源闸有界排队 — 父会话进度提示', () => {
  it('排队时发"排队中"start 帧(带 goal 关联键),放行后发"开始委派"帧', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    let reads = 0
    gw._readDelegateMemoryPressure = () => {
      reads++
      return reads <= 2 ? HIGH_MEM : null
    }
    const r = await delegate(gw, 'coding-assistant', taskBody({ streamProgress: true }))
    assert.equal(r.status, 200)
    const blocks = progressBlocksOf(gw)
    const queued = blocks.find((b) => b.phase === 'start' && /排队中/.test(b.text || ''))
    assert.ok(queued, '排队期间必须向父会话发"排队中"进度帧')
    assert.equal(queued.goal, '实现子任务', '排队帧必须带 goal 关联键以嵌回队长工具卡')
    const started = blocks.find((b) => b.phase === 'start' && /开始委派给/.test(b.text || ''))
    assert.ok(started, '放行后仍必须发既有"开始委派"帧')
    assert.ok(
      blocks.indexOf(queued) < blocks.indexOf(started),
      '排队帧在开始帧之前',
    )
  })

  it('排队超时且已发排队帧 → 补 error 终止帧,卡片不悬挂', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    const r = await delegate(gw, 'coding-assistant', taskBody({ streamProgress: true }))
    assert.equal(r.status, 503)
    const blocks = progressBlocksOf(gw)
    assert.ok(blocks.some((b) => b.phase === 'start' && /排队中/.test(b.text || '')))
    const terminal = blocks.find((b) => b.phase === 'error')
    assert.ok(terminal, '超时必须补 error 帧终结进度卡')
    assert.equal(terminal.isError, true)
    assert.match(terminal.text || '', /已等待 \d+s/)
  })

  it('未开 streamProgress 时排队不发任何进度帧(既有静默语义不变)', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '80'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 503)
    assert.equal(progressBlocksOf(gw).length, 0)
  })
})

// ── 语义边界:深度闸先于等待 ─────────────────────────────────────────────────

describe('资源闸有界排队 — 语义边界', () => {
  it('深度闸在等待之前判:depth 超限即便资源紧张也立即 400,不占等待名额', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    gw._readDelegateMemoryPressure = () => HIGH_MEM
    const t0 = Date.now()
    const r = await delegate(gw, 'coding-assistant', taskBody(), { 'x-delegation-depth': '3' })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /delegation depth limit exceeded/)
    assert.ok(Date.now() - t0 < 1_000, '深度闸拒绝不进入等待')
    assert.equal(gw._delegateQueueWaiters, undefined, '不得占用等待名额')
  })

  it('嵌套 delegate(depth 未超限)同样适用排队', async () => {
    process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS = '5000'
    const gw = makeGateway()
    let reads = 0
    gw._readDelegateMemoryPressure = () => {
      reads++
      return reads <= 2 ? HIGH_MEM : null
    }
    const r = await delegate(gw, 'coding-assistant', taskBody(), { 'x-delegation-depth': '1' })
    assert.equal(r.status, 200, '嵌套 delegate 命中资源闸也应排队放行')
    assert.ok(reads > 2)
  })
})



// ── leftover live journal 根治: emitProgress 盖父轮 cmid ────────────────────

describe('emitProgress stamps parent webchat clientMessageId', () => {
  it('出站进度帧带父轮 _runningClientMessageId', async () => {
    const gw = makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent._runningClientMessageId = 'parent-cmid-running'
    const r = await delegate(gw, 'coding-assistant', taskBody({ streamProgress: true }))
    assert.equal(r.status, 200)
    const outs = gw.delivered.filter((o: any) =>
      (o.blocks || []).some((b: any) => b?.kind === 'delegate_progress'),
    )
    assert.ok(outs.length > 0, '必须发出 delegate_progress 出站帧')
    for (const out of outs) {
      assert.equal(out.clientMessageId, 'parent-cmid-running')
    }
  })

  it('无 _runningClientMessageId 时回退 _currentDispatch.clientMessageId', async () => {
    const gw = makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent._currentDispatch = { clientMessageId: 'parent-cmid-dispatch' }
    const r = await delegate(gw, 'coding-assistant', taskBody({ streamProgress: true }))
    assert.equal(r.status, 200)
    const outs = gw.delivered.filter((o: any) =>
      (o.blocks || []).some((b: any) => b?.kind === 'delegate_progress'),
    )
    assert.ok(outs.length > 0)
    for (const out of outs) {
      assert.equal(out.clientMessageId, 'parent-cmid-dispatch')
    }
  })

  it('非法 cmid 不写入 clientMessageId', async () => {
    const gw = makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent._runningClientMessageId = 'cm:user:large'
    const r = await delegate(gw, 'coding-assistant', taskBody({ streamProgress: true }))
    assert.equal(r.status, 200)
    const outs = gw.delivered.filter((o: any) =>
      (o.blocks || []).some((b: any) => b?.kind === 'delegate_progress'),
    )
    assert.ok(outs.length > 0)
    for (const out of outs) {
      assert.equal(out.clientMessageId, undefined)
    }
  })
})
