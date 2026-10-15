/**
 * OCV5-425 phase 2 chat completions bridge.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/openAiChatGoBridge.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  anthropicToOpenAIChat,
  chatToAnthropicEvents,
  chatUsage,
  createOpenAIChatGoFetch,
  decodeChatToolId,
  encodeChatToolId,
  OPENAI_CHAT_GO_ENDPOINT,
  OPENAI_CHAT_GO_MAX_TOKENS,
} from './openAiChatGoBridge.js'

type Obj = Record<string, unknown>

function sse(chunks: Array<Obj | '[DONE]'>, split = 7): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${c === '[DONE]' ? c : JSON.stringify(c)}\n\n`).join('')
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

async function events(chunks: Array<Obj | '[DONE]'>): Promise<Obj[]> {
  const out: Obj[] = []
  const decoder = new TextDecoder()
  for await (const raw of chatToAnthropicEvents(sse(chunks).getReader(), 'glm-5.3')) {
    const line = decoder.decode(raw).split('\n').find((l) => l.startsWith('data: '))!
    out.push(JSON.parse(line.slice(6)))
  }
  return out
}

const usageChunk = {
  choices: [],
  usage: { prompt_tokens: 7120, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 7000 } },
}

describe('request conversion', () => {
  test('system, inline system, text, tool loop, effort, cap and tools', () => {
    const id = encodeChatToolId('call_abc.1')
    const out = anthropicToOpenAIChat({
      model: 'glm-5.3',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'top system' }],
      output_config: { effort: 'high' },
      temperature: 0.2,
      stop_sequences: ['END'],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'Bash' },
      messages: [
        { role: 'system', content: 'platform context' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden', signature: 'x' },
            { type: 'text', text: 'running' },
            { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'a.txt' }], is_error: true },
            { type: 'text', text: 'next' },
          ],
        },
      ],
    })
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'top system\n\nplatform context' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'running',
        tool_calls: [{ id: 'call_abc.1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_abc.1', content: 'Error: a.txt' },
      { role: 'user', content: 'next' },
    ])
    assert.equal(out.max_tokens, OPENAI_CHAT_GO_MAX_TOKENS)
    assert.equal(out.reasoning_effort, 'high')
    assert.equal(out.temperature, 0.2)
    assert.deepEqual(out.stop, ['END'])
    assert.equal(out.stream, true)
    assert.deepEqual(out.stream_options, { include_usage: true })
    assert.deepEqual(out.tools, [
      { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } } },
    ])
    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'Bash' } })
    assert.equal('thinking' in out, false)
  })

  test('tool choice modes; no effort when none was kept by the proxy', () => {
    const base = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', input_schema: {} }] }
    assert.equal(anthropicToOpenAIChat({ ...base }).tool_choice, 'auto')
    assert.equal(anthropicToOpenAIChat({ ...base, tool_choice: { type: 'any' } }).tool_choice, 'required')
    assert.equal(anthropicToOpenAIChat({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none')
    assert.equal(anthropicToOpenAIChat({ ...base }).reasoning_effort, undefined)
    assert.equal(anthropicToOpenAIChat({ ...base, max_tokens: 100 }).max_tokens, 100)
  })

  test('fails closed on what it cannot represent', () => {
    const m = (content: unknown, role = 'user') => ({ model: 'm', messages: [{ role, content }] })
    assert.throws(() => anthropicToOpenAIChat(m([{ type: 'image', source: {} }])), /unsupported OpenCode Go user block/)
    assert.throws(
      () => anthropicToOpenAIChat(m([{ type: 'tool_result', tool_use_id: 'toolu_oc_x', content: 'r' }])),
      /no matching tool call/,
    )
    assert.throws(
      () => anthropicToOpenAIChat({ ...m('x'), tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
      /server tools/,
    )
    assert.throws(() => anthropicToOpenAIChat(m([{ type: 'text', text: '' }])), /nonempty content/)
    assert.throws(() => anthropicToOpenAIChat({ messages: [] }), /requires a model/)
  })

  test('tool ids round-trip and stay inside the Anthropic id alphabet', () => {
    for (const raw of ['call_x1', 'functions.Bash:0', 'chatcmpl-tool-ab/cd+ef']) {
      const id = encodeChatToolId(raw)
      assert.match(id, /^[A-Za-z0-9_-]+$/)
      assert.equal(decodeChatToolId(id), raw)
    }
  })
})

describe('usage', () => {
  test('cached reads come out of prompt; output keeps reasoning; null details are zero', () => {
    assert.deepEqual(chatUsage(usageChunk.usage), {
      input_tokens: 120,
      output_tokens: 41,
      cache_read_input_tokens: 7000,
      cache_creation_input_tokens: 0,
    })
    assert.deepEqual(chatUsage({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: null, audio_tokens: null } }), {
      input_tokens: 5,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    assert.throws(() => chatUsage({ prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 2 } }))
    assert.throws(() => chatUsage({ prompt_tokens: -1, completion_tokens: 0 }))
  })
})

describe('stream conversion', () => {
  test('text then fragmented tool calls become one text block and complete tool_use blocks', async () => {
    const out = await events([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] },
      { choices: [{ index: 0, delta: { content: 'Let me ' } }] },
      { choices: [{ index: 0, delta: { content: 'check.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Read', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      usageChunk,
      '[DONE]',
    ])
    const types = out.map((e) => e.type)
    assert.deepEqual(types, [
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
    ])
    assert.deepEqual(out[5]!.content_block, { type: 'tool_use', id: encodeChatToolId('call_1'), name: 'Bash', input: {} })
    assert.deepEqual(out[6]!.delta, { type: 'input_json_delta', partial_json: '{"command":"ls"}' })
    assert.deepEqual(out[9]!.delta, { type: 'input_json_delta', partial_json: '{}' })
    assert.deepEqual(out[11], {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 120, output_tokens: 41, cache_read_input_tokens: 7000, cache_creation_input_tokens: 0 },
    })
  })

  test('length maps to max_tokens; text only maps to end_turn', async () => {
    const out = await events([
      { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }] },
      usageChunk,
      '[DONE]',
    ])
    assert.equal((out.at(-2)!.delta as Obj).stop_reason, 'max_tokens')
    const done = await events([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, usageChunk])
    assert.equal((done.at(-2)!.delta as Obj).stop_reason, 'end_turn')
  })

  test('an unfinished or usage-less stream fails; partial usage is emitted once first', async () => {
    await assert.rejects(events([{ choices: [{ index: 0, delta: { content: 'x' } }] }, usageChunk, '[DONE]']), /without a successful/)
    await assert.rejects(events([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]']), /without a successful/)
    const seen: string[] = []
    const decoder = new TextDecoder()
    await assert.rejects(async () => {
      for await (const raw of chatToAnthropicEvents(sse([usageChunk, { error: { message: 'boom' } }]).getReader(), 'm'))
        seen.push(decoder.decode(raw).split('\n')[0]!)
    }, /error event/)
    assert.deepEqual(seen, ['event: message_start', 'event: message_delta'])
    await assert.rejects(
      events([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'T', arguments: '[1]' } }] }, finish_reason: 'tool_calls' }] }, usageChunk]),
      /expected object/,
    )
  })
})

describe('fetch wrapper', () => {
  test('posts the OpenAI body to the chat endpoint with Bearer auth and keeps the session header', async () => {
    let seen: { url: string; headers: Headers; body: Obj } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
      return new Response(sse([{ choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] }, usageChunk, '[DONE]']), { status: 200 })
    }) as unknown as typeof fetch
    const res = await createOpenAIChatGoFetch(fetchImpl)('https://opencode.ai/zen/go/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY', 'anthropic-version': '2023-06-01', 'x-opencode-session': 'sess-1' },
      body: JSON.stringify({ model: 'glm-5.3', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /"text":"pong"/)
    assert.equal(seen!.url, OPENAI_CHAT_GO_ENDPOINT)
    assert.equal(seen!.headers.get('authorization'), 'Bearer GO-KEY')
    assert.equal(seen!.headers.get('x-api-key'), null)
    assert.equal(seen!.headers.get('anthropic-version'), null)
    assert.equal(seen!.headers.get('x-opencode-session'), 'sess-1')
    assert.equal(seen!.body.model, 'glm-5.3')
  })

  test('upstream errors pass through with the key redacted; bad requests never reach upstream', async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key GO-KEY used' } }), { status: 429, headers: { 'retry-after': '7' } })) as unknown as typeof fetch
    const res = await createOpenAIChatGoFetch(failing)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify({ model: 'glm-5.3', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '7')
    const body = await res.json()
    assert.equal(body.error.type, 'api_error')
    assert.doesNotMatch(body.error.message, /GO-KEY/)
    let called = false
    const bad = await createOpenAIChatGoFetch((async () => {
      called = true
      return new Response('')
    }) as unknown as typeof fetch)('x', { method: 'POST', headers: { 'x-api-key': 'K' }, body: '{"model":"m","messages":[]}' })
    assert.equal(bad.status, 400)
    assert.equal(called, false)
  })
})
