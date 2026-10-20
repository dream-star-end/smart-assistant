import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import { pipeStreamWithUsageCapture } from '../http/proxy/shared.js'

function response(write: (chunk: Uint8Array) => boolean) {
  const res = new EventEmitter() as EventEmitter & { write: typeof write }
  res.write = write
  return res as unknown as ServerResponse
}
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk)
    controller.close()
  } })
}
const encode = (text: string) => new TextEncoder().encode(text)
const event = (type: string, data: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`

test('first text excludes ping, thinking, empty and whitespace; split UTF8/SSE is byte exact', async (t) => {
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const body = encode(event('content_block_delta', { delta: { type: 'text_delta', text: '你好' } }))
  const chunks = [
    encode(event('ping', {})),
    encode(event('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'reasoning' } })),
    encode(event('content_block_start', { content_block: { type: 'text', text: '' } })),
    encode(event('content_block_delta', { delta: { type: 'text_delta', text: ' ' } })),
    body.slice(0, body.length - 11), body.slice(body.length - 11, body.length - 2), body.slice(body.length - 2),
  ]
  const written: Uint8Array[] = []
  const result = await pipeStreamWithUsageCapture(stream(chunks), response(chunk => {
    written.push(chunk); now += 10; return true
  }), new AbortController().signal)
  assert.equal(result.firstByteAtMs, 100)
  assert.equal(result.firstTextAtMs, 160)
  assert.deepEqual(Buffer.concat(written), Buffer.concat(chunks))
  assert.equal(result.bytesOut, Buffer.concat(chunks).length)
  assert.equal(result.error, null)
  assert.deepEqual(result.observation, { kind: 'none' })
})

test('text timestamp is captured before downstream backpressure; usage unchanged', async (t) => {
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const body = encode(event('message_start', { message: { usage: { input_tokens: 100,
    output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 } } }) +
    event('content_block_start', { content_block: { type: 'text', text: 'answer' } }) +
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }))
  const res = response(() => { now = 900; queueMicrotask(() => res.emit('drain')); return false })
  const result = await pipeStreamWithUsageCapture(stream([body]), res, new AbortController().signal)
  assert.equal(result.firstTextAtMs, 100)
  assert.deepEqual(result.observation, { kind: 'final', usage: { input_tokens: 100n,
    output_tokens: 42n, cache_read_tokens: 1000n, cache_write_tokens: 500n } })
})

test('EOF and abort without a real text event retain null', async () => {
  const empty = await pipeStreamWithUsageCapture(stream([]), response(() => true), new AbortController().signal)
  assert.equal(empty.firstTextAtMs, null)
  const ac = new AbortController(); ac.abort()
  const cancelled = await pipeStreamWithUsageCapture(stream([encode('ignored')]), response(() => {
    assert.fail('aborted stream must not write')
  }), ac.signal)
  assert.equal(cancelled.firstTextAtMs, null)
  assert.ok(cancelled.error)
})
