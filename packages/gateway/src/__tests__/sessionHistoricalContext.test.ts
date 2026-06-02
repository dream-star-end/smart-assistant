import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  createIdleTimeoutEventGate,
  shouldHardResetRunnerAfterIdleTimeout,
  LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  LIVENESS_IDLE_TIMEOUT_DEFAULT_MS,
  LIVENESS_IDLE_TIMEOUT_TOOL_MS,
  SessionManager,
  buildHistoricalContextPrompt,
  getLivenessIdleTimeoutMs,
} from '../sessionManager.js'
import { CodexAppServerRunner } from '../codexAppServerRunner.js'

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

test('getLivenessIdleTimeoutMs gives context compaction its own budget', () => {
  assert.equal(getLivenessIdleTimeoutMs(null), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
  assert.equal(getLivenessIdleTimeoutMs({ pendingToolCalls: 1 }), LIVENESS_IDLE_TIMEOUT_TOOL_MS)
  assert.equal(
    getLivenessIdleTimeoutMs({ pendingToolCalls: 1, isCompacting: true }),
    LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  )
})

test('shouldHardResetRunnerAfterIdleTimeout only targets codex app-server runners', () => {
  const runner = new CodexAppServerRunner({
    sessionKey: 'test-session',
    agentId: 'codex',
    cwd: process.cwd(),
  })

  assert.equal(shouldHardResetRunnerAfterIdleTimeout(runner), true)
  assert.equal(shouldHardResetRunnerAfterIdleTimeout({ interrupt() {}, shutdown() {} }), false)
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

  override async submit(textOrBlocks: string | Array<{ type: string; text?: string }>) {
    const text = typeof textOrBlocks === 'string' ? textOrBlocks : JSON.stringify(textOrBlocks)
    this.submissions.push(text)

    if (text === 'first') {
      this.lastActivityAt = Date.now() - LIVENESS_IDLE_TIMEOUT_DEFAULT_MS - 1_000
      return new Promise<void>(() => {})
    }

    this.secondStartedAfterShutdown = this.shutdownFinished
    this.emitFakeResult(false)
  }

  override async shutdown() {
    this.shutdownCalled = true
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

test('SessionManager idle timeout hard-resets codex app-server and suppresses late old-turn events', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const manager = new SessionManager({} as any)
    const runner = new HangingCodexAppServerRunner()
    const session = makeTestSession(runner)
    const events: any[] = []

    const first = manager.submit(session, 'first', (e) => events.push(e))
    await Promise.resolve()
    const second = manager.submit(session, 'second', (e) => events.push(e))

    mock.timers.tick(15_001)
    await first
    await second

    assert.equal(runner.interrupted, true)
    assert.equal(runner.shutdownCalled, true)
    assert.equal(runner.secondStartedAfterShutdown, true)
    assert.deepEqual(runner.submissions, ['first', 'second'])
    assert.deepEqual(
      events.map((e) => e.kind),
      ['error', 'final'],
    )
    assert.match(events[0].error, /子进程约 5 分钟无输出,已中断。请重试。/)
  } finally {
    mock.timers.reset()
  }
})
