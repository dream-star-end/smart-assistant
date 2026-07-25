/**
 * P2 债A — handleDelegateTask 收尾产出 server-authored 团队卡 durable 载荷。
 *
 * 委派完成/失败/超时收尾处,应把完整结果和 block transcript 经
 * `bufferPendingAgentGroup` 挂到父(队长)会话,供其 turn 收尾
 * 随 persistServerAuthoredTurn 一并下发。这里驱动真实 handleDelegateTask(沿用
 * delegateResourceQueue.test.ts 的 `Object.create(Gateway.prototype)` + 手工 stub
 * 脚手架),断言 buffering 行为(status 三分支 / 长输出无损 / 无 webchat 父
 * 时不物化),不是源码正则。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateTeamCard.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { Gateway, PerTurnDelegationGuard } from '../server.js'
import type { DurableAgentGroup } from '@openclaude/protocol'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-teamcard'
const PARENT_PEER = 'wsess-teamcard'
const DIRECT_DELEGATE_KEY = 'agent:coding-assistant:delegate:main:1783900000000'

type SubmitImpl = (
  session: unknown,
  payload: string,
  onEvent: (e: any) => void,
) => Promise<unknown>

function makeGateway(opts: {
  submit: SubmitImpl
  withParent?: boolean
  nested?: boolean
  onInterrupt?: () => void
  onShutdown?: () => void | Promise<void>
  onWaitForOutputDrain?: () => void | Promise<void>
  /** F4 — 供测试注入"drain 期落进收集器的晚到 tail",验证摘取顺序。 */
  onFlushTailFolding?: (session: any) => void | Promise<void>
}): {
  gw: any
  buffered: Array<{ sessionKey: string; group: DurableAgentGroup }>
  directDelegate: any
  getOrCreateCalls: any[]
  parentSession: any
  childRunners: any[]
} {
  const buffered: Array<{ sessionKey: string; group: DurableAgentGroup }> = []
  const getOrCreateCalls: any[] = []
  const parentSession = {
    sessionKey: PARENT_KEY,
    channel: 'webchat',
    peerId: PARENT_PEER,
    agentId: 'main',
    userId: '1',
    repoSessionId: undefined,
    _currentTurnKey: 'a'.repeat(64),
    runner: { lastActivityAt: 1 },
  }
  const directDelegate = {
    sessionKey: DIRECT_DELEGATE_KEY,
    channel: 'delegate',
    peerId: 'main',
    agentId: 'coding-assistant',
    userId: '1',
    repoSessionId: PARENT_PEER,
    parentSessionKey: PARENT_KEY,
    progressRunId: 'dlg-root',
    _billingParentTurnKey: 'a'.repeat(64),
    _durableDelegateTranscript: [] as unknown[],
    _durableDelegateRuntimeEvents: [] as unknown[],
    _durableDelegateEngineBillings: [] as unknown[],
    runner: { lastActivityAt: 1 },
  }
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
    agents: [
      { id: 'main', provider: 'anthropic', model: 'glm-5.2' },
      { id: 'coding-assistant' },
      { id: 'researcher' },
    ],
  })
  gw._runLog = { start: () => ({}), complete: () => {} }
  const childRunners: any[] = []
  gw.sessions = {
    // F4 — 生产在此 flush 折叠链(drain 期把 acked|queued 的 tail 落进收集器);fake
    // 转调 opts.onFlushTailFolding(默认 no-op)。补上此方法后 server 的 F4 调用不再
    // 抛 TypeError 被 catch 吞掉,顺序才真正被下方用例断言。
    flushSessionTailFolding: async (session: any) => { await opts.onFlushTailFolding?.(session) },
    // team-durability — 一次性委派子会话收尾即销毁(fake 为 no-op,防泄漏语义在生产实现)
    destroySession: async () => {},
    getByKey: (key: string) => {
      if (opts.withParent === false) return undefined
      if (key === PARENT_KEY) return parentSession
      if (opts.nested && key === DIRECT_DELEGATE_KEY) return directDelegate
      return undefined
    },
    interrupt: () => false,
    getOrCreate: async (input: any) => {
      getOrCreateCalls.push(input)
      const runner = Object.assign(new EventEmitter(), {
        lastActivityAt: 1,
        engineId: 'ccb',
        interrupt: () => opts.onInterrupt?.(),
        shutdown: async () => { await opts.onShutdown?.() },
        waitForOutputDrain: async () => { await opts.onWaitForOutputDrain?.() },
        sendPermissionResponse: () => {},
      })
      childRunners.push(runner)
      return {
        agentId: input.agent?.id ?? 'coding-assistant',
        currentTurnStatus: null,
        runner,
      }
    },
    submit: opts.submit,
    // P2 债A — record the durable team-card buffer calls.
    bufferPendingAgentGroup: (sessionKey: string, group: DurableAgentGroup) => {
      buffered.push({ sessionKey, group })
      return true
    },
  }
  gw.delivered = [] as any[]
  gw.deliver = (out: any) => gw.delivered.push(out)
  return { gw, buffered, directDelegate, getOrCreateCalls, parentSession, childRunners }
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

describe('handleDelegateTask — child activity keeps synchronous ancestors live', () => {
  it('first-level child raw activity refreshes the webchat parent and listener is turn-scoped', async () => {
    let releaseSubmit!: () => void
    let markSubmitStarted!: () => void
    const submitStarted = new Promise<void>((resolve) => { markSubmitStarted = resolve })
    const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
    const { gw, parentSession, childRunners } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        markSubmitStarted()
        await submitGate
        onEvent({ kind: 'block', block: { kind: 'text', text: '完成' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })

    const pending = delegate(gw, 'coding-assistant', taskBody())
    await submitStarted
    assert.equal(childRunners.length, 1)
    childRunners[0].emit('activity')
    assert.ok(parentSession.runner.lastActivityAt > 1, 'child activity must refresh root liveness')

    releaseSubmit()
    assert.equal((await pending).status, 200)
    assert.equal(childRunners[0].listenerCount('activity'), 0, 'listener must detach at delegate end')
    parentSession.runner.lastActivityAt = 7
    childRunners[0].emit('activity')
    assert.equal(parentSession.runner.lastActivityAt, 7, 'late child activity must not leak across turns')
  })

  it('nested child raw activity refreshes both direct delegate and webchat root', async () => {
    let releaseSubmit!: () => void
    let markSubmitStarted!: () => void
    const submitStarted = new Promise<void>((resolve) => { markSubmitStarted = resolve })
    const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
    const { gw, parentSession, directDelegate, childRunners } = makeGateway({
      nested: true,
      submit: async (_s, _p, onEvent) => {
        markSubmitStarted()
        await submitGate
        onEvent({ kind: 'block', block: { kind: 'text', text: '完成' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })

    const pending = delegate(gw, 'researcher', taskBody({
      sourceAgent: 'coding-assistant',
      parentSessionKey: DIRECT_DELEGATE_KEY,
    }))
    await submitStarted
    childRunners[0].emit('activity')
    assert.ok(directDelegate.runner.lastActivityAt > 1, 'nested activity must refresh direct parent')
    assert.ok(parentSession.runner.lastActivityAt > 1, 'nested activity must reach the webchat root')

    releaseSubmit()
    assert.equal((await pending).status, 200)
  })
})

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
    assert.deepEqual(group.transcript, [
      { kind: 'text', text: '子任务结果摘要' },
      { kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } },
    ])
    assert.match(group.runId, /^dlg-/, 'runId = delegate progress runId')
    assert.ok(group.completedAt >= before && group.completedAt <= Date.now())
  })

  it('F4 — flushSessionTailFolding 在摘取收集器构造 group 之前调用(drain 期落进的 tail 入 group)', async () => {
    let flushedBeforeBuffer = false
    const { gw, buffered } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: '结果' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
      onFlushTailFolding: (session) => {
        // 模拟:drain 期把一条 acked|queued 的晚到 tail 落进 delegate 收集器。
        // 只有当本回调在"摘取 durableRuntimeEvents 构造 group"之前发生,该 tail 才会
        // 进入 buffered group.runtimeEvents —— 以此断言 F4 顺序真的生效。
        flushedBeforeBuffer = buffered.length === 0
        session._durableDelegateRuntimeEvents?.push({
          ordinal: 999,
          observedAt: 1,
          source: 'ccb',
          payload: { type: 'system', subtype: 'bash_output_tail', tool_use_id: 'late', tail: 'late-drain' },
        })
      },
    })
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200)
    assert.equal(flushedBeforeBuffer, true, 'flush 发生在 bufferPendingAgentGroup 之前')
    assert.equal(buffered.length, 1)
    const rtEvents = buffered[0].group.runtimeEvents ?? []
    assert.ok(
      rtEvents.some((e) => (e.payload as { tail?: string })?.tail === 'late-drain'),
      'drain 期落进收集器的晚到 tail 必须进入 group(证明摘取前已 await 折叠链)',
    )
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

  it('真实 timeout race 会等 interrupt 后 submit 收口再物化完整 transcript', async () => {
    const realNow = Date.now
    const oldIdle = process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS
    const oldHard = process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS
    const oldCheck = process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS
    let now = realNow()
    let emit: ((event: any) => void) | undefined
    let settle: (() => void) | undefined
    let started!: () => void
    const submitStarted = new Promise<void>((resolve) => { started = resolve })
    try {
      Date.now = () => now
      process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS = '60000'
      process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS = '300000'
      process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS = '1000'
      const { gw, buffered } = makeGateway({
        submit: async (_s, _p, onEvent) => {
          emit = onEvent
          started()
          await new Promise<void>((resolve) => { settle = resolve })
        },
        onInterrupt: () => {
          emit?.({ kind: 'block', block: { kind: 'thinking', text: '超时边界完整思考' } })
          emit?.({ kind: 'block', block: { kind: 'text', text: '超时边界完整正文' } })
          emit?.({ kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } })
          settle?.()
        },
      })
      const pending = delegate(gw, 'coding-assistant', taskBody())
      await submitStarted
      now += 61_000
      const r = await pending
      assert.equal(r.status, 200)
      assert.equal(buffered.length, 1)
      assert.equal(buffered[0].group.status, 'timeout')
      assert.deepEqual(buffered[0].group.transcript, [
        { kind: 'thinking', text: '超时边界完整思考' },
        { kind: 'text', text: '超时边界完整正文' },
        { kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } },
      ])
    } finally {
      Date.now = realNow
      if (oldIdle === undefined) delete process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS
      else process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS = oldIdle
      if (oldHard === undefined) delete process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS
      else process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS = oldHard
      if (oldCheck === undefined) delete process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS
      else process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS = oldCheck
    }
  })

  it('timeout 强停后等待真实 stdout drain，再物化 drain 边界内的全部帧', async () => {
    const realNow = Date.now
    const oldIdle = process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS
    const oldHard = process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS
    const oldCheck = process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS
    const oldDrain = process.env.OPENCLAUDE_DELEGATE_INTERRUPT_DRAIN_MS
    const oldShutdown = process.env.OPENCLAUDE_DELEGATE_SHUTDOWN_WAIT_MS
    let now = realNow()
    let emit: ((event: any) => void) | undefined
    let settle: (() => void) | undefined
    let started!: () => void
    let shutdowns = 0
    const submitStarted = new Promise<void>((resolve) => { started = resolve })
    try {
      Date.now = () => now
      process.env.OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS = '60000'
      process.env.OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS = '300000'
      process.env.OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS = '1'
      process.env.OPENCLAUDE_DELEGATE_INTERRUPT_DRAIN_MS = '5'
      process.env.OPENCLAUDE_DELEGATE_SHUTDOWN_WAIT_MS = '5'
      const { gw, buffered } = makeGateway({
        submit: async (_s, _p, onEvent) => {
          emit = onEvent
          started()
          await new Promise<void>((resolve) => { settle = resolve })
        },
        onShutdown: async () => {
          shutdowns++
          emit?.({ kind: 'block', block: { kind: 'thinking', text: '强停前最后思考' } })
          emit?.({ kind: 'block', block: { kind: 'text', text: '强停前最后正文' } })
          await new Promise<void>(() => {})
        },
        onWaitForOutputDrain: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          emit?.({ kind: 'block', block: { kind: 'thinking', text: '管道关闭前迟到思考' } })
          emit?.({ kind: 'block', block: { kind: 'text', text: '管道关闭前迟到正文' } })
          emit?.({ kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } })
          settle?.()
        },
      })
      const pending = delegate(gw, 'coding-assistant', taskBody())
      await submitStarted
      now += 61_000
      const r = await pending
      assert.equal(r.status, 200)
      assert.equal(shutdowns, 1)
      assert.equal(buffered.length, 1)
      assert.equal(buffered[0].group.status, 'timeout')
      assert.deepEqual(buffered[0].group.transcript, [
        { kind: 'thinking', text: '强停前最后思考' },
        { kind: 'text', text: '强停前最后正文' },
        { kind: 'thinking', text: '管道关闭前迟到思考' },
        { kind: 'text', text: '管道关闭前迟到正文' },
        { kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } },
      ])
    } finally {
      Date.now = realNow
      for (const [key, value] of [
        ['OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS', oldIdle],
        ['OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS', oldHard],
        ['OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS', oldCheck],
        ['OPENCLAUDE_DELEGATE_INTERRUPT_DRAIN_MS', oldDrain],
        ['OPENCLAUDE_DELEGATE_SHUTDOWN_WAIT_MS', oldShutdown],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('resultSummary 与 transcript 对超长输出完整保留', async () => {
    const long = 'x'.repeat(5000)
    const { gw, buffered } = makeGateway({
      submit: async (_s, _p, onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: long } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
      },
    })
    await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(buffered.length, 1)
    assert.equal(buffered[0].group.resultSummary, long)
    assert.equal((buffered[0].group.transcript?.[0] as any).text, long)
  })

  it('委派原始 runtime 事件和最终计费证据随父 turn 卡完整持久化', async () => {
    const runtimeEvent = {
      ordinal: 7,
      observedAt: 1_783_930_000_007,
      source: 'codex-jsonrpc' as const,
      payload: {
        method: 'item/completed',
        params: {
          item: {
            id: 'delegate-item-1',
            type: 'reasoning',
            summary: ['原始委派思考'],
            content: [{ type: 'reasoning_text', text: '逐字保留' }],
          },
        },
      },
    }
    const engineBilling = {
      requestId: 'delegate-request-1',
      parentTurnKey: 'a'.repeat(64),
      parentSessionId: PARENT_PEER,
      delegateAgentId: 'coding-assistant',
      engineSessionId: 'delegate-engine-session-1',
      status: 'success' as const,
      durationMs: 1_234,
      usage: {
        input_tokens: 101,
        output_tokens: 202,
        cache_read_input_tokens: 33,
        reasoning_output_tokens: 44,
      },
    }
    const { gw, buffered } = makeGateway({
      submit: async (session: any, _p, onEvent) => {
        session._durableDelegateRuntimeEvents.push(structuredClone(runtimeEvent))
        session._durableDelegateEngineBillings.push(structuredClone(engineBilling))
        onEvent({ kind: 'block', block: { kind: 'text', text: '委派正文' } })
        onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 101, outputTokens: 202, turn: 1 } })
      },
    })
    const r = await delegate(gw, 'coding-assistant', taskBody())
    assert.equal(r.status, 200)
    assert.equal(buffered.length, 1)
    assert.deepEqual(buffered[0].group.runtimeEvents, [runtimeEvent])
    assert.deepEqual(buffered[0].group.engineBillings, [engineBilling])
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

  it('嵌套委派把完整后代 transcript 写入直接父卡,并沿用根 turnKey 计费', async () => {
    const nestedText = '嵌套完整输出'.repeat(10_000)
    const { gw, buffered, directDelegate, getOrCreateCalls } = makeGateway({
      nested: true,
      submit: async (session: any, _p, onEvent) => {
        session._durableDelegateEngineBillings.push({
          requestId: 'nested-request-1',
          parentTurnKey: 'a'.repeat(64),
          parentSessionId: PARENT_PEER,
          delegateAgentId: 'researcher',
          engineSessionId: 'nested-engine-session-1',
          status: 'success',
          durationMs: 456,
          usage: { input_tokens: 2, output_tokens: 3 },
        })
        onEvent({ kind: 'block', block: { kind: 'thinking', text: '完整嵌套思考' } })
        onEvent({ kind: 'block', block: { kind: 'text', text: nestedText } })
        onEvent({ kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } })
      },
    })
    const r = await delegate(gw, 'researcher', {
      ...taskBody({
        goal: '嵌套研究',
        sourceAgent: 'coding-assistant',
        parentSessionKey: DIRECT_DELEGATE_KEY,
      }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.output, nestedText, '返回给直接父模型的正文不得截断')
    assert.equal(buffered.length, 0, '正常嵌套写进一级卡,不另造重复顶层卡')
    assert.equal(
      getOrCreateCalls[0].usageAttribution.parentTurnKey,
      'a'.repeat(64),
      '嵌套成本仍归根 webchat turn',
    )
    const transcript = directDelegate._durableDelegateTranscript as any[]
    assert.match(transcript[0].text, /嵌套委派 · researcher/)
    assert.deepEqual(transcript.slice(1), [
      { kind: 'thinking', text: '完整嵌套思考' },
      { kind: 'text', text: nestedText },
      { kind: 'final', meta: { cost: 1, inputTokens: 2, outputTokens: 3, turn: 1 } },
    ])
    assert.deepEqual(directDelegate._durableDelegateEngineBillings, [{
      requestId: 'nested-request-1',
      parentTurnKey: 'a'.repeat(64),
      parentSessionId: PARENT_PEER,
      delegateAgentId: 'researcher',
      engineSessionId: 'nested-engine-session-1',
      status: 'success',
      durationMs: 456,
      usage: { input_tokens: 2, output_tokens: 3 },
    }])
  })
})
