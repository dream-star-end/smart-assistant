import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Cc5BridgeBinding } from '../cc5BridgePort.js'
import { Cc5NativeUsageObserver } from '../cc5NativeUsage.js'

function fixture() {
  const binding: Cc5BridgeBinding = { version: 2, backendKind: 'cc5-interactive-v1',
    canonicalModel: 'box-claude-sonnet-5', sessionKey: 'agent:main:webchat:dm:fixture_chat1',
    runId: randomUUID(), uid: '3', containerDbId: '91', dockerId: 'a'.repeat(64),
    operationId: randomUUID(), capability: 'b'.repeat(64), expiresAt: Date.now() + 60000 }
  const native = randomUUID()
  const observer = new Cc5NativeUsageObserver(binding)
  const init = Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: native,
    model: 'claude-sonnet-5' })}\n`)
  const terminal = { type: 'result', subtype: 'success', is_error: false, session_id: native,
    total_cost_usd: 999999, result: '{"usage":{"input_tokens":999999}}',
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } }
  return { binding, native, observer, init, terminal }
}

test('only native result aggregate replaces step usage; original bytes and exact digest are retained', () => {
  const f = fixture()
  const step = Buffer.from(`${JSON.stringify({ type: 'stream_event', session_id: f.native,
    event: { type: 'message_delta', usage: { input_tokens: 99, output_tokens: 88 } } })}\n`)
  const raw = Buffer.from(`${JSON.stringify(f.terminal)}\n`)
  const all = Buffer.concat([f.init, step, raw])
  const frames = f.observer.ingest(all)
  assert.deepEqual(Buffer.concat(frames.map((frame) => frame.bytes)), all)
  assert.equal(frames.filter((frame) => frame.receipt).length, 1)
  const receipt = frames[2]!.receipt!
  assert.deepEqual(receipt.usage, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 11, cacheWriteTokens: 13 })
  assert.equal(receipt.resultSha256, createHash('sha256').update(raw).digest('hex'))
  assert.equal(receipt.operationId, f.binding.operationId)
  assert.equal(receipt.runId, f.binding.runId)
  assert.equal(receipt.sessionKey, f.binding.sessionKey)
  assert.equal(receipt.nativeSessionId, f.native)
  assert.equal(receipt.upstreamModel, 'claude-sonnet-5')
  f.observer.finish()
})

test('fragmented output withholds incomplete terminal bytes until its whole native record is validated', () => {
  const f = fixture()
  f.observer.ingest(f.init)
  const raw = Buffer.from(`${JSON.stringify(f.terminal)}\n`)
  assert.deepEqual(f.observer.ingest(raw.subarray(0, raw.length - 1)), [])
  const frames = f.observer.ingest(raw.subarray(raw.length - 1))
  assert.deepEqual(frames[0]!.bytes, raw)
  assert.ok(frames[0]!.receipt)
})

test('missing, negative, fractional, unsafe and forged prose token counters cannot settle', () => {
  for (const invalid of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    const f = fixture()
    f.observer.ingest(f.init)
    const row = { ...f.terminal, usage: { ...f.terminal.usage, input_tokens: invalid } }
    assert.throws(() => f.observer.ingest(Buffer.from(`${JSON.stringify(row)}\n`)))
    assert.throws(() => f.observer.ingest(Buffer.from(`${JSON.stringify(f.terminal)}\n`)))
  }
})

test('native session/model mismatch, duplicate terminal and effects after terminal fail closed', () => {
  for (const wrong of ['session', 'model', 'duplicate', 'after']) {
    const f = fixture()
    f.observer.ingest(f.init)
    const rows = wrong === 'session' ? [{ ...f.terminal, session_id: randomUUID() }]
      : wrong === 'model' ? [{ type: 'assistant', session_id: f.native, message: { model: 'other-model', content: [] } }]
      : wrong === 'duplicate' ? [f.terminal, f.terminal]
      : [f.terminal, { type: 'assistant', session_id: f.native, message: { model: 'claude-sonnet-5', content: [] } }]
    assert.throws(() => f.observer.ingest(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)))
  }
})

test('a result without prior native model identity or with a truncated tail is not proof', () => {
  const f = fixture()
  assert.throws(() => f.observer.ingest(Buffer.from(`${JSON.stringify(f.terminal)}\n`)))
  const other = fixture()
  other.observer.ingest(other.init.subarray(0, other.init.length - 1))
  assert.throws(() => other.observer.finish())
})
