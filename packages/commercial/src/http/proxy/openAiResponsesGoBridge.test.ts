/**
 * OCV5-425 phase 3 Responses bridge.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/openAiResponsesGoBridge.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  OPENAI_RESPONSES_GO_ENDPOINT,
  OPENAI_RESPONSES_GO_MAX_TOKENS,
  anthropicToOpenAIResponses,
  createOpenAIResponsesGoFetch,
  decodeResponsesToolId,
  encodeResponsesToolId,
  responsesToAnthropicEvents,
  responsesUsage,
} from './openAiResponsesGoBridge.js'

type Obj = Record<string, unknown>

function sse(events: Obj[], split = 9): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(at, at + split))
      at += split
    },
  })
}

async function events(input: Obj[]): Promise<Obj[]> {
  const out: Obj[] = []
  const decoder = new TextDecoder()
  for await (const raw of responsesToAnthropicEvents(sse(input).getReader(), 'grok-4.7')) {
    const line = decoder
      .decode(raw)
      .split('\n')
      .find((l) => l.startsWith('data: '))!
    out.push(JSON.parse(line.slice(6)))
  }
  return out
}

const usage = {
  input_tokens: 6817,
  output_tokens: 40,
  input_tokens_details: { cached_tokens: 100, cache_write_tokens: 6700 },
  output_tokens_details: { reasoning_tokens: 30 },
}
const completed = (extra: Obj = {}) => ({
  type: 'response.completed',
  response: { status: 'completed', usage, ...extra },
})

// OCV5-432: the shape CCB actually sends (captured 2026-10-15). A preamble system message
// after the first user turn, then a `<total_tokens>` system message after every turn whose
// value changes. Three consecutive requests of one session: tool call, tool result, next turn.
function ccbSession(id: string): Obj[] {
  const base: Obj[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>ctx</system-reminder>' },
        { type: 'text', text: 'run it' },
      ],
    },
    { role: 'system', content: [{ type: 'text', text: '# Environment\nstable' }] },
  ]
  const turn1: Obj[] = [
    ...base,
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'a.txt' }] },
    {
      role: 'system',
      content: [{ type: 'text', text: '<total_tokens>900 tokens left</total_tokens>' }],
    },
  ]
  const turn2: Obj[] = [
    // History keeps the earlier notice (as a string, as CCB re-sends it) and appends a new one.
    ...turn1.slice(0, -1),
    { role: 'system', content: '<total_tokens>900 tokens left</total_tokens>' },
    { role: 'assistant', content: [{ type: 'text', text: 'a.txt' }] },
    { role: 'user', content: 'again?' },
    {
      role: 'system',
      content: [{ type: 'text', text: '<total_tokens>800 tokens left</total_tokens>' }],
    },
  ]
  return [base, turn1, turn2].map((messages) => ({ model: 'm', system: 'top system', messages }))
}

describe('request conversion', () => {
  test('OCV5-434: Fast forwards service_tier "priority"; standard sends no tier', () => {
    const base = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(anthropicToOpenAIResponses({ ...base, service_tier: 'priority' }).service_tier, 'priority')
    assert.equal('service_tier' in anthropicToOpenAIResponses(base), false)
    assert.equal('service_tier' in anthropicToOpenAIResponses({ ...base, service_tier: 'auto' }), false)
  })
  test('later system messages stay in place, so every request extends the previous one (OCV5-432)', () => {
    const outs = ccbSession(encodeResponsesToolId('call_1')).map((b) =>
      anthropicToOpenAIResponses(b),
    )
    for (const o of outs) assert.equal(o.instructions, 'top system\n\n# Environment\nstable')
    for (let i = 1; i < outs.length; i++) {
      const prev = outs[i - 1].input as Obj[]
      assert.deepEqual((outs[i].input as Obj[]).slice(0, prev.length), prev)
    }
    assert.deepEqual(
      (outs[2].input as Obj[]).filter((x) => x.role === 'system'),
      [
        { role: 'system', content: '<total_tokens>900 tokens left</total_tokens>' },
        { role: 'system', content: '<total_tokens>800 tokens left</total_tokens>' },
      ],
    )
  })

  test('instructions, stateless input with function_call / function_call_output, effort, cap, tools', () => {
    const id = encodeResponsesToolId('call-abc-0')
    const out = anthropicToOpenAIResponses({
      model: 'grok-4.7',
      max_tokens: 64000,
      system: 'top system',
      output_config: { effort: 'high' },
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'platform context' }] },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x', signature: 's' },
            { type: 'text', text: 'running' },
            { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: id, content: 'a.txt' },
            { type: 'text', text: 'next' },
          ],
        },
      ],
    })
    assert.equal(out.instructions, 'top system\n\nplatform context')
    assert.deepEqual(out.input, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'running' },
      { type: 'function_call', call_id: 'call-abc-0', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call-abc-0', output: 'a.txt' },
      { role: 'user', content: 'next' },
    ])
    assert.equal(out.store, false)
    assert.equal(out.stream, true)
    assert.equal(out.max_output_tokens, OPENAI_RESPONSES_GO_MAX_TOKENS)
    assert.deepEqual(out.reasoning, { effort: 'high' })
    assert.deepEqual(out.tools, [
      { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' } },
    ])
    assert.equal(out.tool_choice, 'required')
    const forced = anthropicToOpenAIResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'T', input_schema: {} }],
      tool_choice: { type: 'tool', name: 'T' },
    })
    assert.deepEqual(forced.tool_choice, { type: 'function', name: 'T' })
    assert.equal(forced.reasoning, undefined)
  })

  test('fails closed on images, server tools and orphan tool results', () => {
    const m = (content: unknown) => ({ model: 'm', messages: [{ role: 'user', content }] })
    assert.throws(
      () => anthropicToOpenAIResponses(m([{ type: 'image', source: {} }])),
      /unsupported/,
    )
    assert.throws(
      () =>
        anthropicToOpenAIResponses(
          m([{ type: 'tool_result', tool_use_id: 'toolu_or_x', content: 'r' }]),
        ),
      /no matching/,
    )
    assert.throws(
      () =>
        anthropicToOpenAIResponses({
          ...m('x'),
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        }),
      /server tools/,
    )
  })

  test('tool ids round-trip in the Anthropic alphabet', () => {
    for (const raw of ['call-2fa0b1de-68a5-0', 'call_HjZAzyBEVxbY', 'fc/x+y:z']) {
      const id = encodeResponsesToolId(raw)
      assert.match(id, /^[A-Za-z0-9_-]+$/)
      assert.equal(decodeResponsesToolId(id), raw)
    }
  })
})

describe('usage', () => {
  test('cached reads and cache writes both come out of input_tokens', () => {
    assert.deepEqual(responsesUsage(usage), {
      input_tokens: 17,
      output_tokens: 40,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 6700,
    })
    assert.deepEqual(
      responsesUsage({
        input_tokens: 8053,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 7936 },
      }),
      {
        input_tokens: 117,
        output_tokens: 30,
        cache_read_input_tokens: 7936,
        cache_creation_input_tokens: 0,
      },
    )
    assert.throws(() =>
      responsesUsage({
        input_tokens: 5,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 3 },
      }),
    )
  })
})

describe('stream conversion', () => {
  test('reasoning is skipped, text streams, function calls become complete tool_use blocks', async () => {
    const out = await events([
      { type: 'response.created' },
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'r1', encrypted_content: 'zzz' },
      },
      { type: 'response.output_text.delta', delta: 'Let me ' },
      { type: 'response.output_text.delta', delta: 'check.' },
      { type: 'response.function_call_arguments.delta', delta: '{"comm' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'Bash',
          arguments: '{"command":"ls"}',
        },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call-2', name: 'Read', arguments: '' },
      },
      completed(),
    ])
    assert.deepEqual(
      out.map((e) => e.type),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    )
    assert.deepEqual(out[5]!.content_block, {
      type: 'tool_use',
      id: encodeResponsesToolId('call-1'),
      name: 'Bash',
      input: {},
    })
    assert.deepEqual(out[6]!.delta, { type: 'input_json_delta', partial_json: '{"command":"ls"}' })
    assert.deepEqual(out[9]!.delta, { type: 'input_json_delta', partial_json: '{}' })
    assert.deepEqual(out[11]!.delta, { stop_reason: 'tool_use', stop_sequence: null })
    assert.deepEqual((out[11]!.usage as Obj).cache_creation_input_tokens, 6700)
  })

  test('a refusal completes as text, not as a broken stream (Codex r1)', async () => {
    const out = await events([
      { type: 'response.refusal.delta', delta: "I can't " },
      { type: 'response.refusal.delta', delta: 'help with that.' },
      { type: 'response.refusal.done', refusal: "I can't help with that." },
      completed(),
    ])
    assert.deepEqual(
      out.filter((e) => e.type === 'content_block_delta').map((e) => (e.delta as Obj).text),
      ["I can't ", 'help with that.'],
    )
    assert.equal((out.at(-2)!.delta as Obj).stop_reason, 'end_turn')
  })

  test('incomplete for max_output_tokens maps to max_tokens; other incompletes fail', async () => {
    const out = await events([
      { type: 'response.output_text.delta', delta: 'partial' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage,
        },
      },
    ])
    assert.equal((out.at(-2)!.delta as Obj).stop_reason, 'max_tokens')
    await assert.rejects(
      events([
        { type: 'response.output_text.delta', delta: 'x' },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
            usage,
          },
        },
      ]),
      /without a successful/,
    )
  })

  test('failed / error / truncated streams fail; partial usage is emitted once first', async () => {
    await assert.rejects(
      events([{ type: 'response.output_text.delta', delta: 'x' }]),
      /without a successful/,
    )
    await assert.rejects(
      events([{ type: 'response.failed', response: { status: 'failed' } }]),
      /error event/,
    )
    const seen: string[] = []
    const decoder = new TextDecoder()
    await assert.rejects(async () => {
      for await (const raw of responsesToAnthropicEvents(
        sse([
          {
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              incomplete_details: { reason: 'content_filter' },
              usage,
            },
          },
        ]).getReader(),
        'm',
      ))
        seen.push(decoder.decode(raw).split('\n')[0]!)
    })
    assert.deepEqual(seen, ['event: message_start', 'event: message_delta'])
  })
})

describe('fetch wrapper', () => {
  test('posts to /responses with Bearer auth and the session header', async () => {
    let seen: { url: string; headers: Headers; body: Obj } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
      return new Response(
        sse([{ type: 'response.output_text.delta', delta: 'pong' }, completed()]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const res = await createOpenAIResponsesGoFetch(fetchImpl)('x', {
      method: 'POST',
      headers: {
        'x-api-key': 'GO-KEY',
        'x-opencode-session': 's-1',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /"text":"pong"/)
    assert.equal(seen!.url, OPENAI_RESPONSES_GO_ENDPOINT)
    assert.equal(seen!.headers.get('authorization'), 'Bearer GO-KEY')
    assert.equal(seen!.headers.get('x-api-key'), null)
    assert.equal(seen!.headers.get('x-opencode-session'), 's-1')
    assert.equal(seen!.body.store, false)
  })

  test('upstream errors are redacted; bad requests never reach upstream', async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'boom GO-KEY' } }), {
        status: 503,
      })) as unknown as typeof fetch
    const res = await createOpenAIResponsesGoFetch(failing)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify({
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(res.status, 503)
    assert.doesNotMatch((await res.json()).error.message, /GO-KEY/)
    let called = false
    const bad = await createOpenAIResponsesGoFetch((async () => {
      called = true
      return new Response('')
    }) as unknown as typeof fetch)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'K' },
      body: '{"model":"m","messages":[]}',
    })
    assert.equal(bad.status, 400)
    assert.equal(called, false)
  })
})
