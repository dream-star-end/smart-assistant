import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { codexRequestTiming, codexResponseTiming, type TimingFields } from './codexRelayTiming.js'

async function through(chunks: Buffer[], stream: ReturnType<typeof codexRequestTiming>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of Readable.from(chunks).pipe(stream)) parts.push(part as Buffer)
  return Buffer.concat(parts)
}

test('request context observation preserves bytes and logs only fixed numeric summaries', async () => {
  const source = Buffer.from(JSON.stringify({ instructions: 'PRIVATE_SYSTEM', tools: [{ name: 'PRIVATE_TOOL' }],
    input: [{ role: 'developer', content: 'PRIVATE_SKILL' }, { role: 'user', content: 'PRIVATE_USER' }] }))
  const events: TimingFields[] = []
  const result = await through([source.subarray(0, 7), source.subarray(7)], codexRequestTiming(e => events.push(e)))
  assert.deepEqual(result, source)
  assert.equal(events.length, 1)
  assert.equal(events[0].stage, 'request_context')
  assert.equal(events[0].toolCount, 1)
  assert.ok(Number(events[0].developerTokensEstimate) > 0)
  assert.ok(Number(events[0].userTokensEstimate) > 0)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/)
})

test('oversize request and malformed JSON never truncate transport or expose content', async () => {
  for (const source of [Buffer.from('NOT_JSON_PRIVATE'), Buffer.alloc(120, 120)]) {
    const events: TimingFields[] = []
    const result = await through([source], codexRequestTiming(e => events.push(e), () => 42, 0, 32))
    assert.deepEqual(result, source)
    assert.equal(events[0].stage, source.length > 32 ? 'request_context_skipped' : 'request_context_unavailable')
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|xxxxx/)
  }
})

test('SSE split at every byte preserves UTF8/CRLF and separates body, reasoning, text, usage', async () => {
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`
  const source = Buffer.from(`: keepalive\r\n\r\n${event({type:'response.created'})}${event({type:'response.output_text.delta',delta:'  '})}${event({type:'response.reasoning_summary_text.delta',delta:'PRIVATE_THINKING'})}${event({type:'response.output_text.delta',delta:'你好PRIVATE_TEXT'})}${event({type:'response.output_text.delta',delta:'more'})}${event({type:'response.completed',response:{usage:{input_tokens:17000,output_tokens:22,
      input_tokens_details:{cached_tokens:15000}, output_tokens_details:{reasoning_tokens:12},
      secret:'PRIVATE_USAGE',attribution:{request_fields:{instructions:{input_tokens:9000}}}}}})}`)
  const events: TimingFields[] = []
  let clock = 0
  const result = await through([...source].map(x => Buffer.from([x])),
    codexResponseTiming(e => events.push(e), () => ++clock, 0))
  assert.deepEqual(result, source)
  assert.deepEqual(events.map(e => e.stage), ['first_body','first_reasoning_delta','first_text_delta','usage'])
  assert.ok(Number(events[0].elapsedMs) < Number(events[1].elapsedMs))
  assert.ok(Number(events[1].elapsedMs) < Number(events[2].elapsedMs))
  assert.equal(events[3].inputTokens, 17000)
  assert.equal(events[3].cachedInputTokens, 15000)
  assert.equal(events[3].instructionsTokens, 9000)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/)
})

test('oversize SSE event skips observation, resumes next event, and leaves stream unchanged', async () => {
  const source = Buffer.from(`data: ${'x'.repeat(150)}\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n`)
  const events: TimingFields[] = []
  const result = await through([source.subarray(0,90),source.subarray(90)],
    codexResponseTiming(e => events.push(e), () => 1, 0, 80))
  assert.deepEqual(result, source)
  assert.deepEqual(events.map(e => e.stage), ['first_body','sse_observation_skipped','first_text_delta'])
})

test('observer failure cannot fail a successful model stream', async () => {
  const source = Buffer.from('data: {"type":"response.output_text.delta","delta":"ok"}\n\n')
  assert.deepEqual(await through([source], codexResponseTiming(() => { throw new Error('logger unavailable') })), source)
})
