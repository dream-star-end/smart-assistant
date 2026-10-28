import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexNativeContext } from '../engine/codexNativeContext.js'
import { codexRelayTrace } from '../relayTrace.js'
import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import type { ContextObservation } from '@openclaude/protocol'

const tokens = (n: number) => ({ totalTokens: n, inputTokens: n - 10, outputTokens: 10, cachedInputTokens: n - 20, reasoningOutputTokens: 5 })
const usage = (last: number, total = 1000000, window: number | null = 1000) => ({ last: tokens(last), total: tokens(total), modelContextWindow: window })

function harness() {
  const runner = new CodexAppServerRunner({ sessionKey: 'native-context-test', agentId: 'main', cwd: '/tmp', resumeSessionId: 'thread-1' })
  const host = runner as any
  const observations: ContextObservation[] = []
  const messages: any[] = []
  runner.on('context_observation', (event) => observations.push(event))
  runner.on('message', (event) => messages.push(event))
  const feed = (method: string, params: Record<string, unknown>) => host.handleNotification(method, { threadId: 'thread-1', ...params })
  const record = (value: unknown, turnId = 'user-previous') => {
    host.activeTurnId = turnId
    host.currentTurnCompleter = { resolve() {}, reject() {} }
    feed('thread/tokenUsage/updated', { turnId, tokenUsage: value })
    host.consumeActiveTurnUsage()
    host.currentTurnCompleter = null
    host.activeTurnId = null
  }
  host.ensureSpawned = async () => {}
  host.attached = true
  return { runner, host, observations, messages, feed, record }
}

test('native pressure uses latest context tokens, never cumulative billing or cache twice', () => {
  const h = harness()
  h.record(usage(100))
  assert.equal(h.observations.length, 0)
  h.record(usage(800))
  h.record(usage(1100))
  assert.deepEqual(h.observations.map((e) => e.kind === 'context_pressure' && e.pressure), [
    { engine: 'codex', scope: 'native_context', dimension: 'tokens', level: 'warning', usedRatio: 0.8 },
    { engine: 'codex', scope: 'native_context', dimension: 'tokens', level: 'critical', usedRatio: 1.1 },
  ])
})

test('unknown, invalid and foreign-thread measurements do not create native pressure', () => {
  const h = harness()
  for (const window of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) h.record(usage(900, 1000000, window))
  for (const n of [-1, Number.NaN, Number.POSITIVE_INFINITY]) h.record({ ...usage(900), last: tokens(n) })
  h.host.currentTurnCompleter = { resolve() {}, reject() {} }
  h.feed('thread/tokenUsage/updated', { threadId: 'child-thread', turnId: 'child-turn', tokenUsage: usage(900) })
  assert.equal(h.observations.length, 0)
})

test('automatic compaction emits one native summary only for a completed matching lifecycle', () => {
  const h = harness()
  h.record(usage(900))
  h.host.currentTurnCompleter = { resolve() {}, reject() {} }
  h.host.activeTurnId = 'user-turn'
  const params = { turnId: 'internal-auto', item: { id: 'compact-item', type: 'contextCompaction' } }
  h.feed('item/started', params)
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
  h.feed('item/completed', { ...params, threadId: 'foreign-thread' })
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
  h.feed('item/completed', params)
  h.feed('item/completed', params)
  assert.deepEqual(h.observations.filter((e) => e.kind === 'context_compacted'), [{ kind: 'context_compacted', compaction: {
    engine: 'codex', scope: 'native_context', strategy: 'native_summary', beforeTokens: 900,
  } }])
})

test('high native water compacts before the next input, waits beyond ACK, and preserves per-turn usage', async () => {
  const h = harness()
  h.record(usage(900, 1000))
  const requests: { method: string; params: any }[] = []
  let accepted!: () => void
  const compactAck = new Promise<void>((resolve) => { accepted = resolve })
  h.host.sendRequest = async (method: string, params: any) => {
    requests.push({ method, params })
    if (method === 'thread/compact/start') { accepted(); return {} }
    if (method === 'turn/start') {
      h.feed('thread/tokenUsage/updated', { turnId: 'user-new', tokenUsage: usage(200, 1250) })
      h.feed('turn/completed', { turn: { id: 'user-new', status: 'completed' } })
      return { turn: { id: 'user-new' } }
    }
    return {}
  }
  const running = h.host.runTurn('exact newest user input', 'request-2')
  await compactAck
  assert.deepEqual(requests.map((r) => r.method), ['thread/compact/start'])
  const compaction = { turnId: 'compact-turn', item: { id: 'compact-2', type: 'contextCompaction' } }
  h.feed('turn/started', { turn: { id: 'compact-turn', status: 'inProgress' } })
  h.feed('item/started', compaction)
  h.feed('thread/tokenUsage/updated', { turnId: 'compact-turn', tokenUsage: usage(50, 1050) })
  h.feed('item/completed', compaction)
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
  h.feed('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
  await running
  assert.deepEqual(requests.map((r) => r.method), ['thread/compact/start', 'turn/start'])
  assert.equal(requests[1]!.params.threadId, 'thread-1')
  assert.equal(requests[1]!.params.input[0].text, 'exact newest user input')
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 1)
  const final = h.messages.find((m) => m.type === 'result')
  assert.equal(final.is_error, false)
  assert.equal(final.usage.total_tokens, 250, 'summary and user calls remain on the same existing billing delta')
})

for (const outcome of ['failed', 'interrupted', 'missing-item'] as const) {
  test(`native compact ${outcome} cannot send the user input or claim success`, async () => {
    const h = harness()
    h.record(usage(900))
    const requests: string[] = []
    h.host.sendRequest = async (method: string) => {
      requests.push(method)
      if (method === 'thread/compact/start') {
        h.feed('turn/started', { turn: { id: 'compact-failed', status: 'inProgress' } })
        h.feed('turn/completed', { turn: { id: 'compact-failed', status: outcome === 'missing-item' ? 'completed' : outcome } })
      }
      return {}
    }
    await h.host.runTurn('must remain unsent', 'failed-request')
    assert.deepEqual(requests, ['thread/compact/start'])
    assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
    assert.equal(h.messages.at(-1).is_error, true)
  })
}

test('Stop during compact wakes the wait and never submits the queued user input', async () => {
  const h = harness()
  h.record(usage(900))
  let accepted!: () => void
  const ack = new Promise<void>((resolve) => { accepted = resolve })
  const requests: string[] = []
  h.host.sendRequest = async (method: string) => { requests.push(method); accepted(); return {} }
  const running = h.host.runTurn('do not start after stop', 'stopped-request')
  await ack
  assert.equal(h.runner.interrupt(), true)
  await running
  assert.deepEqual(requests, ['thread/compact/start'])
  assert.equal(h.messages.at(-1).billing_terminal_code, 'USER_CANCELLED')
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
})

test('thread or model changes cannot inherit another context watermark', async () => {
  for (const change of ['thread', 'model']) {
    const h = harness()
    h.record(usage(900))
    if (change === 'thread') h.host.threadId = 'new-thread'
    else h.runner.setModel('gpt-6-astra')
    const requests: string[] = []
    h.host.sendRequest = async (method: string) => {
      requests.push(method)
      h.feed('turn/completed', { turn: { id: 'new-turn', status: 'completed' } })
      return { turn: { id: 'new-turn' } }
    }
    await h.host.runTurn('continue')
    assert.deepEqual(requests, ['turn/start'])
  }
})

for (const completedBeforeAck of [false, true]) {
  test(`compact timeout also bounds a missing RPC ACK (completed=${completedBeforeAck})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const observations: ContextObservation[] = []
    const context = new CodexNativeContext((e) => observations.push(e))
    context.observeUsage('thread-1', { threadId: 'thread-1', tokenUsage: usage(900) })
    let drains = 0
    const running = context.compactIfNeeded({ threadId: 'thread-1', traceId: 'trace123456789012', timeoutMs: 1000,
      send: () => new Promise(() => {}), drainFailure: async () => { drains++ },
    })
    assert.equal(codexRelayTrace(JSON.stringify({ thread_id: 'thread-1' })), 'trace123456789012')
    if (completedBeforeAck) {
      context.notification('turn/started', { threadId: 'thread-1', turn: { id: 'c1' } })
      const item = { id: 'compact', type: 'contextCompaction' }
      context.notification('item/started', { threadId: 'thread-1', turnId: 'c1', item })
      context.notification('item/completed', { threadId: 'thread-1', turnId: 'c1', item })
      context.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'c1', status: 'completed' } })
    }
    const rejected = assert.rejects(running, /timed out/)
    t.mock.timers.tick(1000)
    await rejected
    assert.equal(drains, 1)
    assert.equal(context.running, false)
    assert.equal(observations.filter((e) => e.kind === 'context_compacted').length, 0)
    assert.equal(codexRelayTrace(JSON.stringify({ thread_id: 'thread-1' })), undefined)
  })
}

test('failed compaction drains late usage before releasing its internal turn identity', async () => {
  const h = harness()
  h.record(usage(900, 1000))
  h.host.sendRequest = async () => {
    h.feed('turn/started', { turn: { id: 'drain-compact' } })
    h.feed('turn/completed', { turn: { id: 'drain-compact', status: 'failed', error: { message: 'context window exceeded' } } })
    return {}
  }
  h.host.recycleProcKeepQueue = async () => {
    h.feed('thread/tokenUsage/updated', { turnId: 'drain-compact', tokenUsage: usage(100, 1100) })
  }
  await h.host.runTurn('not replayed', 'drained-request')
  const result = h.messages.find((m) => m.type === 'result')
  assert.equal(result.usage.total_tokens, 100)
  assert.equal(result.errorClass, 'context_too_long')
  assert.equal(h.observations.filter((e) => e.kind === 'context_compacted').length, 0)
  h.host.currentTurnCompleter = { resolve() { assert.fail('retired compact resolved the new user turn') }, reject() {} }
  h.host.activeTurnId = null
  h.feed('turn/completed', { turn: { id: 'drain-compact', status: 'completed' } })
  assert.equal(h.host.activeTurnId, null)
})
