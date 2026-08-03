import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { CodexAppServerRunner } from '../codexAppServerRunner.js'
import {
  LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  LIVENESS_IDLE_TIMEOUT_DEFAULT_MS,
  LIVENESS_IDLE_TIMEOUT_TOOL_MS,
  SessionManager,
  buildHistoricalContextPrompt,
  createIdleTimeoutEventGate,
  getLivenessIdleMs,
  getLivenessIdleTimeoutMs,
  isLowInformationContinuationText,
  resolveLivenessIdle,
  shouldClarifyNonNativeResume,
  shouldHardResetRunnerAfterIdleTimeout,
} from '../sessionManager.js'
import { SubprocessRunner } from '../subprocessRunner.js'

test('buildHistoricalContextPrompt includes prior user/assistant turns and wraps current message', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'user', text: '之前的问题' },
      { role: 'assistant', text: '之前的回答' },
    ],
    '继续',
  )
  assert.ok(prompt)
  assert.match(prompt!, /<openclaude_previous_context>/)
  assert.match(prompt!, /User: 之前的问题/)
  assert.match(prompt!, /Assistant: 之前的回答/)
  assert.match(prompt!, /<current_user_message>\n继续\n<\/current_user_message>/)
})

test('buildHistoricalContextPrompt drops optimistic current user message from history', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'user', text: 'old' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'new turn', status: 'sending' },
    ],
    'new turn',
  )
  assert.ok(prompt)
  assert.equal((prompt!.match(/User: new turn/g) ?? []).length, 0)
  assert.match(prompt!, /<current_user_message>\nnew turn\n<\/current_user_message>/)
})

test('buildHistoricalContextPrompt ignores non-chat/system messages', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'thinking', text: 'hidden' },
      { role: 'assistant', text: 'system notice', system: true },
      { role: 'user', text: 'visible' },
    ],
    'next',
  )
  assert.ok(prompt)
  assert.doesNotMatch(prompt!, /hidden|system notice/)
  assert.match(prompt!, /User: visible/)
})

test('isLowInformationContinuationText detects ambiguous continuation and status prompts', () => {
  for (const text of [
    '继续',
    '继续吧',
    '接着做',
    '咋样？',
    '怎么样',
    '改好了吗',
    '修好了吗',
    'status?',
    'done?',
    'keep going',
  ]) {
    assert.equal(isLowInformationContinuationText(text), true, text)
  }
})

test('isLowInformationContinuationText keeps substantive continuation prompts runnable', () => {
  for (const text of [
    '继续修 outbox backoff，从当前 diff 开始',
    '继续调查 mpvektqt-5a2t6d5c 为什么前端无响应',
    '修好这个会话无响应的根因',
    'what is the status of session mpvektqt-5a2t6d5c?',
  ]) {
    assert.equal(isLowInformationContinuationText(text), false, text)
  }
})

test('shouldClarifyNonNativeResume only guards ambiguous webchat non-native resumes', () => {
  assert.equal(
    shouldClarifyNonNativeResume({
      channel: 'webchat',
      turns: 12,
      hasNativeResumeId: false,
      userText: '继续',
    }),
    true,
  )
  assert.equal(
    shouldClarifyNonNativeResume({
      channel: 'webchat',
      turns: 12,
      hasNativeResumeId: true,
      userText: '继续',
    }),
    false,
  )
  assert.equal(
    shouldClarifyNonNativeResume({
      channel: 'telegram',
      turns: 12,
      hasNativeResumeId: false,
      userText: '继续',
    }),
    false,
  )
  assert.equal(
    shouldClarifyNonNativeResume({
      channel: 'webchat',
      turns: 0,
      hasNativeResumeId: false,
      userText: '继续',
    }),
    false,
  )
  assert.equal(
    shouldClarifyNonNativeResume({
      channel: 'webchat',
      turns: 12,
      hasNativeResumeId: false,
      userText: '继续修 outbox backoff，从当前 diff 开始',
    }),
    false,
  )
})

test('getLivenessIdleTimeoutMs gives context compaction its own budget', () => {
  assert.equal(getLivenessIdleTimeoutMs(null), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
  assert.equal(getLivenessIdleTimeoutMs({ pendingToolCalls: 1 }), LIVENESS_IDLE_TIMEOUT_TOOL_MS)
  assert.equal(
    getLivenessIdleTimeoutMs({ pendingToolCalls: 1, isCompacting: true }),
    LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  )
})

test('shouldHardResetRunnerAfterIdleTimeout targets long-lived runners interrupt cannot free', () => {
  const runner = new CodexAppServerRunner({
    sessionKey: 'test-session',
    agentId: 'codex',
    cwd: process.cwd(),
  })

  assert.equal(shouldHardResetRunnerAfterIdleTimeout(runner), false)

  // claude subprocess runner: a wedged stdin / internal deadlock is a no-op for
  // interrupt(), so it must also be hard-reset (shutdown → next submit respawns).
  // Use the prototype so we don't spawn a real process in a unit test.
  const subproc = Object.create(SubprocessRunner.prototype)
  assert.equal(shouldHardResetRunnerAfterIdleTimeout(subproc), true)

  // A plain object that merely looks like a runner is NOT hard-reset.
  assert.equal(shouldHardResetRunnerAfterIdleTimeout({ interrupt() {}, shutdown() {} }), false)
})

test('getLivenessIdleMs uses visible activity for codex app-server and raw activity for other runners', () => {
  const now = 10_000
  const codexRunner = new CodexAppServerRunner({
    sessionKey: 'test-session',
    agentId: 'codex',
    cwd: process.cwd(),
  })
  codexRunner.lastActivityAt = 9_500

  assert.equal(getLivenessIdleMs(codexRunner, 1_000, now), 9_000)
  assert.equal(getLivenessIdleMs({ lastActivityAt: 9_500 }, 1_000, now), 500)
})

test('resolveLivenessIdle: codex silence never creates an automatic timeout', () => {
  const now = 100 * 60_000
  const codexRunner = new CodexAppServerRunner({
    sessionKey: 'test-session',
    agentId: 'codex',
    cwd: process.cwd(),
  })
  codexRunner.lastActivityAt = now - 1_000
  const silent = resolveLivenessIdle({
    runner: codexRunner,
    hasVisibleProgress: false,
    parser: null,
    turnStartedAt: now - 12 * 60_000, // 12min into cold reasoning
    visibleActivityAt: now - 1_000,
    now,
  })
  assert.equal(silent.threshold, Number.POSITIVE_INFINITY)
  assert.equal(silent.idleMs, 0)
})

test('resolveLivenessIdle: codex remains unbounded after visible progress and tools', () => {
  const now = 100 * 60_000
  const codexRunner = new CodexAppServerRunner({
    sessionKey: 'test-session',
    agentId: 'codex',
    cwd: process.cwd(),
  })
  codexRunner.lastActivityAt = now - 1_000 // raw chatter recent — must be ignored for codex

  const dflt = resolveLivenessIdle({
    runner: codexRunner,
    hasVisibleProgress: true,
    parser: null, // DEFAULT tier
    turnStartedAt: now - 30 * 60_000, // long ago — must NOT be used after first block
    visibleActivityAt: now - 6 * 60_000, // 6min since last visible event
    now,
  })
  assert.equal(dflt.threshold, Number.POSITIVE_INFINITY)
  assert.equal(dflt.idleMs, 0)

  const tool = resolveLivenessIdle({
    runner: codexRunner,
    hasVisibleProgress: true,
    parser: { pendingToolCalls: 1 },
    turnStartedAt: now - 30 * 60_000,
    visibleActivityAt: now - 6 * 60_000,
    now,
  })
  assert.equal(tool.threshold, Number.POSITIVE_INFINITY)
  assert.equal(tool.idleMs, 0)
})

test('resolveLivenessIdle: non-codex runner ignores cold-start grace, uses raw activity + tiers', () => {
  const now = 100 * 60_000
  const claudeLike = resolveLivenessIdle({
    runner: { lastActivityAt: now - 7 * 60_000 },
    hasVisibleProgress: false, // even pre-progress, no grace for non-codex runners
    parser: null,
    turnStartedAt: now - 1_000, // recent — would wrongly shrink idle if used
    visibleActivityAt: now - 30 * 60_000,
    now,
  })
  assert.equal(claudeLike.threshold, LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
  assert.equal(claudeLike.idleMs, 7 * 60_000) // getLivenessIdleMs non-codex path (lastActivityAt)
})

test('createIdleTimeoutEventGate suppresses late events after idle timeout', () => {
  const forwarded: string[] = []
  const suppressed: Array<{ kind: string; count: number }> = []
  const gate = createIdleTimeoutEventGate(
    (e) => forwarded.push(e.kind),
    (e, count) => suppressed.push({ kind: e.kind, count }),
  )

  gate.emit({ kind: 'block', block: { kind: 'text', text: 'before' } } as any)
  gate.suppress()
  gate.emit({ kind: 'error', error: 'late shutdown error' } as any)
  gate.emit({ kind: 'final' } as any)

  assert.deepEqual(forwarded, ['block'])
  assert.deepEqual(suppressed, [
    { kind: 'error', count: 1 },
    { kind: 'final', count: 2 },
  ])
  assert.equal(gate.suppressedCount(), 2)
})

class HangingCodexAppServerRunner extends CodexAppServerRunner {
  interrupted = false
  shutdownCalled = false
  shutdownFinished = false
  secondStartedAfterShutdown: boolean | null = null
  submissions: string[] = []
  goalInputs: Array<{
    objective?: string | null
    status?: string | null
    tokenBudget?: number | null
  }> = []
  rawActivityTicks = 0
  private rawActivityTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super({
      sessionKey: 'agent:codex:webchat:dm:web-test',
      agentId: 'codex',
      cwd: process.cwd(),
    })
  }

  override interrupt(): boolean {
    this.interrupted = true
    return true
  }

  override async setGoal(input: {
    objective?: string | null
    status?: string | null
    tokenBudget?: number | null
  }): Promise<any> {
    this.goalInputs.push(input)
    return { blockId: 'codex-goal', ...input }
  }

  override async submit(textOrBlocks: string | Array<{ type: string; text?: string }>) {
    const text = typeof textOrBlocks === 'string' ? textOrBlocks : JSON.stringify(textOrBlocks)
    this.submissions.push(text)

    if (text === 'first') {
      this.lastActivityAt = Date.now() - LIVENESS_IDLE_TIMEOUT_DEFAULT_MS - 1_000
      return new Promise<void>(() => {})
    }
    if (text === 'first-raw-active') {
      this.lastActivityAt = Date.now()
      this.rawActivityTimer = setInterval(() => {
        this.rawActivityTicks++
        this.lastActivityAt = Date.now()
      }, 1_000)
      return new Promise<void>(() => {})
    }

    this.secondStartedAfterShutdown = this.shutdownFinished
    this.emitFakeResult(false)
  }

  override async shutdown() {
    this.shutdownCalled = true
    if (this.rawActivityTimer) {
      clearInterval(this.rawActivityTimer)
      this.rawActivityTimer = null
    }
    this.emitFakeResult(true)
    this.shutdownFinished = true
  }

  private emitFakeResult(isError: boolean) {
    this.emit('message', {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      session_id: 'thread-test',
      total_cost_usd: 0,
      duration_ms: 1,
      is_error: isError,
      result: isError ? 'late shutdown error' : '',
      usage: isError ? {} : { output_tokens: 1 },
    })
  }
}

function makeTestSession(runner: HangingCodexAppServerRunner): any {
  return {
    sessionKey: 'agent:codex:webchat:dm:web-test',
    agentId: 'codex',
    channel: 'webchat',
    peerId: 'web-test',
    userId: 'boss',
    title: 'test',
    startedAt: Date.now(),
    runner,
    runnerProviderTag: 'codex-native:app-server',
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: Date.now(),
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 1,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    _historicalContextInjected: true,
  }
}

test('SessionManager does not interrupt a silent codex app-server turn', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  try {
    const manager = new SessionManager({} as any)
    const runner = new HangingCodexAppServerRunner()
    const session = makeTestSession(runner)
    const events: any[] = []

    const first = manager.submit(session, 'first', (e) => events.push(e))
    await Promise.resolve()
    const second = manager.submit(session, 'second', (e) => events.push(e))

    mock.timers.tick(24 * 60 * 60_000)
    assert.equal(runner.interrupted, false)
    assert.equal(runner.shutdownCalled, false)
    assert.deepEqual(runner.submissions, ['first'])

    // Explicit lifecycle shutdown remains authoritative and lets the FIFO
    // advance; only silence-based cancellation was removed.
    await runner.shutdown()
    await first
    await second

    assert.equal(runner.shutdownCalled, true)
    assert.equal(runner.secondStartedAfterShutdown, true)
    assert.deepEqual(runner.submissions, ['first', 'second'])
    assert.ok(events.some((e) => e.kind === 'final'))
  } finally {
    mock.timers.reset()
  }
})

test('SessionManager clarifies ambiguous non-native resume without submitting to runner', async () => {
  const manager = new SessionManager({} as any)
  const runner = new HangingCodexAppServerRunner()
  const session = makeTestSession(runner)
  session._historicalContextInjected = false
  const turnsBefore = session.turns
  const events: any[] = []

  await manager.submit(session, '继续', (e) => events.push(e))

  assert.deepEqual(
    events.map((e) => e.kind),
    ['block', 'final'],
  )
  assert.match(events[0].block.text, /不能原生恢复上一轮内部状态/)
  assert.match(events[0].block.text, /请直接说明要继续的具体事项/)
  assert.deepEqual(runner.submissions, [])
  assert.equal(session.turns, turnsBefore)
  assert.equal(session._historicalContextInjected, false)
})

test('SessionManager seeds Codex goal under the submit lock before the normal turn', async () => {
  const manager = new SessionManager({} as any)
  const runner = new HangingCodexAppServerRunner()
  const session = makeTestSession(runner)
  const events: any[] = []

  await manager.submit(
    session,
    'Ship the UI normally',
    (e) => events.push(e),
    undefined,
    'default',
    'Ship the Goal UI',
  )

  assert.deepEqual(runner.goalInputs, [{ objective: 'Ship the Goal UI', status: 'active' }])
  assert.deepEqual(runner.submissions, ['Ship the UI normally'])
  assert.deepEqual(
    events.map((e) => e.kind),
    ['final'],
  )
})

test('SessionManager warmupSession runs through the per-session lock', async () => {
  const manager = new SessionManager({} as any)
  const runner = new HangingCodexAppServerRunner() as any
  const session = makeTestSession(runner)
  let release!: () => void
  let warmed = false
  session.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  runner.warmup = async () => {
    warmed = true
    return true
  }
  ;(manager as any).sessions.set(session.sessionKey, session)

  const warm = manager.warmupSession(session.sessionKey, 123)
  await Promise.resolve()
  assert.equal(warmed, false)
  release()
  assert.equal(await warm, true)
  assert.equal(warmed, true)
})

test('SessionManager warmupSession swallows runner warmup failure', async () => {
  const manager = new SessionManager({} as any)
  const runner = new HangingCodexAppServerRunner() as any
  const session = makeTestSession(runner)
  runner.warmup = async () => {
    throw new Error('warmup boom')
  }
  ;(manager as any).sessions.set(session.sessionKey, session)

  assert.equal(await manager.warmupSession(session.sessionKey, 123), false)
  await session.lock
})

test('SessionManager also keeps a raw-active but visibly quiet codex turn alive', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
  try {
    const manager = new SessionManager({} as any)
    const runner = new HangingCodexAppServerRunner()
    const session = makeTestSession(runner)
    const events: any[] = []

    const first = manager.submit(session, 'first-raw-active', (e) => events.push(e))
    await Promise.resolve()
    const second = manager.submit(session, 'second', (e) => events.push(e))

    mock.timers.tick(24 * 60 * 60_000)
    assert.ok(runner.rawActivityTicks > 0)
    assert.equal(runner.interrupted, false)
    assert.equal(runner.shutdownCalled, false)
    assert.deepEqual(runner.submissions, ['first-raw-active'])

    await runner.shutdown()
    await first
    await second

    assert.equal(runner.shutdownCalled, true)
    assert.equal(runner.secondStartedAfterShutdown, true)
    assert.deepEqual(runner.submissions, ['first-raw-active', 'second'])
    assert.ok(events.some((e) => e.kind === 'final'))
  } finally {
    mock.timers.reset()
  }
})
