import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Cc5BridgeBinding } from '../cc5BridgePort.js'
import { Cc5NativeUsageObserver } from '../cc5NativeUsage.js'
import { StreamJson } from '../../box-bridge-mod/oc-bridge/hooks/frames.js'

function fixture() {
  const binding: Cc5BridgeBinding = { version: 2, backendKind: 'cc5-interactive-v1',
    canonicalModel: 'box-claude-sonnet-5', sessionKey: 'agent:main:webchat:dm:fixture_chat1',
    runId: randomUUID(), uid: '3', containerDbId: '91', dockerId: 'a'.repeat(64),
    operationId: randomUUID(), capability: 'b'.repeat(64), expiresAt: Date.now() + 60000 }
  const native = randomUUID()
  const producer = new StreamJson()
  producer.sessionId = native
  const nextResultId = (): string => JSON.parse(producer.result({ reason: 'answer', answer: 'fixture', durationMs: 0 }, null)).uuid
  const observer = new Cc5NativeUsageObserver(binding, { legacySingleTurn: true })
  const init = Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: native,
    model: 'claude-sonnet-5' })}\n`)
  const terminal = { type: 'result', subtype: 'success', is_error: false, session_id: native,
    total_cost_usd: 999999, result: '{"usage":{"input_tokens":999999}}',
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } }
  return { binding, native, observer, init, terminal, nextResultId }
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

test('a target launched on another model settles under exactly that model, live and after recovery', () => {
  const f = fixture()
  const binding = { ...f.binding, canonicalModel: 'box-claude-opus-5-5' }
  const frame = (model: string) => Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init',
    session_id: f.native, model })}\n`)
  const raw = Buffer.from(`${JSON.stringify({ ...f.terminal, uuid: f.nextResultId() })}\n`)
  const opus = new Cc5NativeUsageObserver(binding, { upstreamModel: 'claude-opus-5-5' })
  opus.beginTurn({ authorityTurnId: 'c'.repeat(32), turnKey: 'turn-1' })
  const receipt = opus.ingest(Buffer.concat([frame('claude-opus-5-5'), raw]))[1]!.receipt!
  assert.equal(receipt.version, 2)
  assert.equal(receipt.upstreamModel, 'claude-opus-5-5')
  assert.equal(receipt.canonicalModel, 'box-claude-opus-5-5')
  opus.finish()
  // The same receipt restores under the same target and is refused under another one.
  new Cc5NativeUsageObserver(binding, { upstreamModel: 'claude-opus-5-5' }).restoreFromReceipts([receipt])
  assert.throws(() => new Cc5NativeUsageObserver(binding, { upstreamModel: 'claude-haiku-5-5' })
    .restoreFromReceipts([receipt]), /CC5_NATIVE_USAGE_UNPROVEN/)
  // The remote CLI reporting a model the target did not launch is not usage evidence.
  for (const reported of ['claude-sonnet-5', 'claude-haiku-5-5']) {
    const observer = new Cc5NativeUsageObserver(binding, { legacySingleTurn: true, upstreamModel: 'claude-opus-5-5' })
    assert.throws(() => observer.ingest(frame(reported)), /CC5_NATIVE_USAGE_UNPROVEN/)
  }
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

test('live usage requires explicit admission and produces isolated v2 receipts across serial turns', () => {
  const f = fixture()
  const observer = new Cc5NativeUsageObserver(f.binding)
  const first = { authorityTurnId: '1'.repeat(32), turnKey: 'a'.repeat(64) }
  observer.beginTurn(first)
  observer.ingest(f.init)
  const raw = (row: unknown) => Buffer.from(`${JSON.stringify(row)}\n`)
  const one = { ...f.terminal, uuid: f.nextResultId() }
  const receipt = observer.ingest(raw(one))[0]!.receipt!
  assert.equal(receipt.version, 2)
  if (receipt.version === 2) assert.deepEqual({ authorityTurnId: receipt.authorityTurnId, turnKey: receipt.turnKey }, first)
  const second = { authorityTurnId: '2'.repeat(32), turnKey: 'b'.repeat(64) }
  observer.beginTurn(second)
  const two = { ...f.terminal, uuid: f.nextResultId(), usage: { ...f.terminal.usage, input_tokens: 2 } }
  const next = observer.ingest(raw(two))[0]!.receipt!
  assert.equal(next.usage.inputTokens, 2)
  assert.equal(next.nativeSessionId, f.native)
  assert.equal(next.version, 2)
  if (next.version === 2) assert.equal(next.authorityTurnId, second.authorityTurnId)
  observer.finish()
  const unadmitted = new Cc5NativeUsageObserver(f.binding)
  unadmitted.ingest(f.init)
  assert.throws(() => unadmitted.ingest(raw(one)))
})

test('live turns reject overlapping admission, reused terminal UUID/digest and switched native identity', () => {
  for (const reuse of ['uuid', 'digest', 'session', 'rfc-uuid']) {
    const f = fixture()
    const observer = new Cc5NativeUsageObserver(f.binding)
    observer.beginTurn({ authorityTurnId: '1'.repeat(32), turnKey: 'a'.repeat(64) })
    assert.throws(() => observer.beginTurn({ authorityTurnId: '2'.repeat(32), turnKey: 'b'.repeat(64) }))
    observer.ingest(f.init)
    const one = { ...f.terminal, uuid: f.nextResultId() }
    observer.ingest(Buffer.from(`${JSON.stringify(one)}\n`))
    observer.beginTurn({ authorityTurnId: '2'.repeat(32), turnKey: 'b'.repeat(64) })
    const two = reuse === 'digest' ? one : reuse === 'uuid' ? { ...one, result: 'changed bytes' }
      : reuse === 'rfc-uuid' ? { ...one, uuid: randomUUID() }
      : { ...one, uuid: f.nextResultId(), session_id: randomUUID() }
    assert.throws(() => observer.ingest(Buffer.from(`${JSON.stringify(two)}\n`)))
  }
})

test('interruptTurn retains and validates real terminal usage receipt for interrupted turns', () => {
  const f = fixture()
  const observer = new Cc5NativeUsageObserver(f.binding)
  const first = { authorityTurnId: '1'.repeat(32), turnKey: 'a'.repeat(64) }
  observer.beginTurn(first)
  observer.ingest(f.init)
  observer.interruptTurn()
  const interruptedResult = {
    ...f.terminal,
    subtype: 'interrupted',
    is_error: false,
    uuid: f.nextResultId(),
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }
  const frames = observer.ingest(Buffer.from(`${JSON.stringify(interruptedResult)}\n`))
  assert.equal(frames.length, 1)
  assert.ok(frames[0]!.receipt)
  assert.deepEqual(frames[0]!.receipt!.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
  // Next turn can begin cleanly after interrupted turn receipt is settled
  const second = { authorityTurnId: '2'.repeat(32), turnKey: 'b'.repeat(64) }
  observer.beginTurn(second)
  const secondResult = {
    ...f.terminal,
    uuid: f.nextResultId(),
    usage: {
      input_tokens: 14,
      output_tokens: 8,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  }
  const nextFrames = observer.ingest(Buffer.from(`${JSON.stringify(secondResult)}\n`))
  assert.ok(nextFrames[0]!.receipt)
  assert.equal(nextFrames[0]!.receipt!.usage.inputTokens, 14)
  observer.finish()
})
