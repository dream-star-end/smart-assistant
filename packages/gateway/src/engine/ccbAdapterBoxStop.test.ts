import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CcbAdapter, isBoxContinuationRejectedDetail } from './ccbAdapter.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

class FakeRunner extends EventEmitter {
  model = 'box-api-claude-opus-5-5'
  sessionId = 'ccb-native-session'
  interrupts = 0
  setConsultTurn(): void {}
  async submit(): Promise<void> {}
  interrupt(): boolean { this.interrupts++; return true }
}

test('browser Stop notifies internal Box route once before interrupting local CCB', async () => {
  const vars = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
  const saved = Object.fromEntries(vars.map((key) => [key, process.env[key]]))
  const oldFetch = globalThis.fetch
  process.env.ANTHROPIC_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.1.synthetic'
  const runner = new FakeRunner()
  const sequence: string[] = []
  let delivered!: () => void
  const sent = new Promise<void>((resolve) => { delivered = resolve })
  globalThis.fetch = (async (url, init) => {
    sequence.push('box-stop')
    assert.equal(String(url), 'http://172.31.0.1:18892/internal/box/stop')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      session_id: runner.sessionId, oc_turn_key: 'a'.repeat(64),
    })
    delivered()
    return new Response(JSON.stringify({ status: 'stopped' }), { status: 200 })
  }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'a'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    assert.equal(adapter.interrupt('user'), true)
    await sent
    assert.equal(adapter.interrupt('user'), true)
    assert.equal(runner.interrupts, 2)
    assert.deepEqual(sequence, ['box-stop'])
    turn.end()
  } finally {
    globalThis.fetch = oldFetch
    for (const key of vars) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('automatic adapter interrupt does not claim explicit user Stop', async () => {
  const oldFetch = globalThis.fetch
  const runner = new FakeRunner()
  let sent = 0
  globalThis.fetch = (async () => { sent++; throw new Error('must not notify') }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'b'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    assert.equal(adapter.interrupt(), true)
    assert.equal(sent, 0)
    turn.end()
  } finally { globalThis.fetch = oldFetch }
})

// OCV5-315 live #72191544: a deterministic Box continuation reject ended the
// CCB turn but left the handed-off Box CLI parked, so the idle candidate
// blocked every next message (IDLE_HISTORY_PENDING -> 消息未开始处理).
const rejected = (code: string, message = 'continuation rejected') =>
  `API Error: 409 {"error":{"code":"${code}","message":"${message}"},"request_id":"dc1551b789864b0500d6bd581ffd538b"}`

test('OCV5-315 a Box continuation reject settles the parked Box turn once', async () => {
  const vars = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
  const saved = Object.fromEntries(vars.map((key) => [key, process.env[key]]))
  const oldFetch = globalThis.fetch
  process.env.ANTHROPIC_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.1.synthetic'
  const runner = new FakeRunner()
  const bodies: unknown[] = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), 'http://172.31.0.1:18892/internal/box/stop')
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ status: 'stopped' }), { status: 200 })
  }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'c'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    runner.emit('message', { type: 'result', subtype: 'success', is_error: true,
      result: rejected('BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION') })
    const summary = await turn.summary
    assert.equal(summary?.isError, true)
    await adapter.shutdown().catch(() => {})
    assert.deepEqual(bodies, [{ session_id: runner.sessionId, oc_turn_key: 'c'.repeat(64) }])
    // already notified: a later Stop of the same turn does not resend
    assert.equal(adapter.interrupt('user'), true)
    assert.equal(bodies.length, 1)
  } finally {
    globalThis.fetch = oldFetch
    for (const key of vars) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('OCV5-315 only the exact continuation reject qualifies', () => {
  const detail = (result: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ subtype: 'success', result, ...extra })
  assert.equal(isBoxContinuationRejectedDetail(detail(rejected('BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION'))), true)
  assert.equal(isBoxContinuationRejectedDetail(detail(rejected('BOX_PREPARED_CATALOG_MISSING'))), true)
  for (const other of [
    detail(rejected('BOX_REPLAY_PENDING', 'previous Box call still resolving')),
    detail(rejected('BOX_AUTHORITY_REJECTED', 'authority binding rejected')),
    detail('API Error: 503 {"error":{"code":"BOX_REPLAY_UNAVAILABLE","message":"continuation rejected"}}'),
    detail('API Error: 409 {"error":{"code":"OTHER","message":"continuation rejected"}}'),
    detail('the model said: API Error: 409 {"error":{"code":"BOX_X","message":"continuation rejected"}}'),
    detail(null),
    'not json continuation rejected',
    undefined,
  ]) {
    assert.equal(isBoxContinuationRejectedDetail(other), false, String(other))
  }
})

test('OCV5-315 a non-Box model never notifies Box on a reject-shaped result', async () => {
  const oldFetch = globalThis.fetch
  const runner = new FakeRunner()
  runner.model = 'claude-sonnet-5'
  let sent = 0
  globalThis.fetch = (async () => { sent++; throw new Error('must not notify') }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'd'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    runner.emit('message', { type: 'result', subtype: 'success', is_error: true,
      result: rejected('BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION') })
    await turn.summary
    assert.equal(sent, 0)
  } finally { globalThis.fetch = oldFetch }
})
