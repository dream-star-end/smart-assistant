import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGoResponsesTrace, traceGoResponsesBody } from './go-responses-sse-trace.mjs'

const encode = (text) => new TextEncoder().encode(text)
const event = (value) => `data: ${JSON.stringify(value)}\n\n`
const completed = { type: 'response.completed', response: { status: 'completed', usage: {
  input_tokens: 31000, output_tokens: 2, input_tokens_details: { cached_tokens: 30000 },
} } }
function bytes(text, split = 7) {
  const source = encode(text)
  let at = 0
  return new ReadableStream({ pull(c) {
    if (at === source.length) { c.close(); return }
    c.enqueue(source.slice(at, at + split)); at = Math.min(at + split, source.length)
  } }, { highWaterMark: 0 })
}

test('tap preserves all bytes across fragmented UTF-8, CRLF, mixed separators, multiline data and DONE', async () => {
  const text = `: PRIVATE_COMMENT\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"PRIVATE_你好🙂"}\r\n\n${event(completed)}data: [DONE]\n\n`
  for (const split of [1, 7, 99999]) {
    const summaries = []
    const body = traceGoResponsesBody(bytes(text, split), (s) => summaries.push(s))
    assert.equal(await new Response(body).text(), text)
    assert.equal(summaries.length, 1)
    const s = summaries[0]
    assert.equal(s.ending, 'eof')
    assert.equal(s.malformed, 0)
    assert.equal(s.bytes, encode(text).length)
    assert.equal(s.textDeltaChars, 'PRIVATE_你好🙂'.length)
    assert.equal(s.terminal.cacheReadTokens, 30000)
    assert.deepEqual(s.sequence.map((r) => r.type), ['no_data', 'response.output_text.delta', 'response.completed', 'done_sentinel'])
    assert.doesNotMatch(JSON.stringify(s), /PRIVATE|你好|🙂/)
  }
})

test('terminal metadata distinguishes snapshot-only output, explicit failures and incompletes without exposing payload', () => {
  for (const [type, status, reason] of [
    ['response.completed', 'completed', undefined],
    ['response.incomplete', 'incomplete', 'max_output_tokens'],
    ['response.incomplete', 'incomplete', 'content_filter'],
    ['response.failed', 'failed', undefined],
    ['error', 'PRIVATE_STATUS', 'PRIVATE_REASON'],
  ]) {
    const trace = createGoResponsesTrace()
    trace.push(encode(event({ type, error: { message: 'PRIVATE_ERROR' }, response: {
      status, incomplete_details: { reason }, usage: { input_tokens: 'PRIVATE_USAGE' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'PRIVATE_TEXT' }] },
        { type: 'function_call', name: 'PRIVATE_TOOL', arguments: 'PRIVATE_ARGS', call_id: 'PRIVATE_ID' }],
    } })))
    const s = trace.end('eof')
    assert.equal(s.terminal.type, type)
    assert.equal(s.terminal.status, status === 'PRIVATE_STATUS' ? 'other' : status)
    assert.equal(s.terminal.reason, reason === 'PRIVATE_REASON' ? 'other' : reason ?? 'absent')
    assert.equal(s.terminal.textChars, 12)
    assert.equal(s.terminal.toolCalls, 1)
    assert.equal(s.terminal.inputTokens, null)
    assert.equal(s.textDeltaChars, 0)
    assert.doesNotMatch(JSON.stringify(s), /PRIVATE/)
  }
})

test('truncation, malformed JSON, missing type and unknown wire labels remain distinct, redacted evidence', () => {
  const trace = createGoResponsesTrace()
  trace.push(encode('event: PRIVATE_HEADER\ndata: {"type":"PRIVATE_TYPE","delta":"PRIVATE_TEXT"}\n\n' +
    'data: {"PRIVATE_MALFORMED"\n\n' + 'event: response.completed\ndata: {"PRIVATE_KEY":"PRIVATE_VALUE"}\n\n' +
    'data: {"type":"response.in_progress"}'))
  const s = trace.end('eof')
  assert.equal(s.terminal, null)
  assert.equal(s.trailingFrame, true)
  assert.equal(s.malformed, 1)
  assert.deepEqual(s.sequence.map((r) => [r.type, r.wire]), [
    ['other', 'other'], ['invalid_json', 'absent'], ['other', 'response.completed'], ['response.in_progress', 'absent'],
  ])
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE/)
})

test('limits bound memory and output without losing later terminal metadata or altering bytes', async () => {
  const many = Array.from({ length: 500 }, (_, i) => event({ type: i % 2 ? 'response.in_progress' : 'response.created' })).join('')
  const text = event({ type: 'response.output_text.delta', delta: 'PRIVATE'.repeat(100000) }) + many + event(completed)
  const summaries = []
  const out = await new Response(traceGoResponsesBody(bytes(text, 400000), (s) => summaries.push(s))).text()
  assert.equal(out, text)
  const s = summaries[0]
  assert.equal(s.oversized, 1)
  assert.equal(s.sequence.length, 48)
  assert(s.omittedRuns > 0)
  assert.equal(s.terminal.type, 'response.completed')
  assert(JSON.stringify(s).length < 12000)
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE/)
})

test('consumer backpressure and cancellation propagate once; cancellation is never reported as EOF', async () => {
  let pulls = 0
  let cancelled
  const source = new ReadableStream({
    pull(c) { pulls++; c.enqueue(encode(': PRIVATE\n\n')) },
    cancel(reason) { cancelled = reason },
  }, { highWaterMark: 0 })
  const summaries = []
  const stream = traceGoResponsesBody(source, (s) => summaries.push(s))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pulls, 0)
  const reader = stream.getReader()
  await reader.read()
  assert.equal(pulls, 1)
  const reason = new Error('PRIVATE_ABORT')
  await reader.cancel(reason)
  assert.equal(cancelled, reason)
  assert.equal(source.locked, false)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].ending, 'cancelled')
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/)
})

test('read errors propagate unchanged and are never serialized; sink failure cannot fail transport', async () => {
  const error = new Error('PRIVATE_READ_ERROR')
  const source = new ReadableStream({ pull(c) { c.error(error) } })
  const summaries = []
  await assert.rejects(new Response(traceGoResponsesBody(source, (s) => summaries.push(s))).text(), (e) => e === error)
  assert.equal(source.locked, false)
  assert.equal(summaries[0].ending, 'read_error')
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/)
  const text = event(completed)
  assert.equal(await new Response(traceGoResponsesBody(bytes(text), () => { throw error })).text(), text)
})

test('cancel during a pending read releases the reader and emits only cancellation', async () => {
  const source = new ReadableStream({ pull() {} }, { highWaterMark: 0 })
  const summaries = []
  const reader = traceGoResponsesBody(source, (s) => summaries.push(s)).getReader()
  const pending = reader.read()
  await new Promise((resolve) => setImmediate(resolve))
  await reader.cancel('PRIVATE_CANCEL')
  assert.deepEqual(await pending, { done: true, value: undefined })
  assert.equal(source.locked, false)
  assert.deepEqual(summaries.map((s) => s.ending), ['cancelled'])
})
