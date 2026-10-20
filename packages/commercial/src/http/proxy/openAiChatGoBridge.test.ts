/**
 * OCV5-425 phase 2 chat completions bridge.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/openAiChatGoBridge.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  OPENAI_CHAT_GO_ENDPOINT,
  OPENAI_CHAT_GO_MAX_TOKENS,
  anthropicToOpenAIChat,
  chatToAnthropicEvents,
  chatUsage,
  createOpenAIChatGoFetch,
  decodeChatToolId,
  encodeChatToolId,
} from './openAiChatGoBridge.js'
import { type BoundWebSearch, WebSearchError } from './webSearchServerTool.js'

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
    const line = decoder
      .decode(raw)
      .split('\n')
      .find((l) => l.startsWith('data: '))!
    out.push(JSON.parse(line.slice(6)))
  }
  return out
}

function parseAnthropicSse(text: string): Obj[] {
  return text
    .split(/\n\n/)
    .map((chunk) => chunk.split(/\n/).find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Obj)
}

const usageChunk = {
  choices: [],
  usage: {
    prompt_tokens: 7120,
    completion_tokens: 41,
    prompt_tokens_details: { cached_tokens: 7000 },
  },
}

function webSearchBody(extra: Obj = {}): Obj {
  return {
    model: 'glm-5.3',
    max_tokens: 1024,
    system: 'You are an assistant for performing a web search tool use',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Perform a web search for the query: Claude Fable 5.5 release date',
          },
        ],
      },
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8,
        allowed_domains: ['example.com'],
        blocked_domains: ['spam.example.com'],
      },
    ],
    ...extra,
  }
}

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
  test('later system messages stay in place, so every request extends the previous one (OCV5-432)', () => {
    const outs = ccbSession(encodeChatToolId('call_1')).map((b) => anthropicToOpenAIChat(b))
    for (let i = 1; i < outs.length; i++) {
      const prev = outs[i - 1].messages as Obj[]
      assert.deepEqual((outs[i].messages as Obj[]).slice(0, prev.length), prev)
    }
    const msgs = outs[2].messages as Obj[]
    assert.deepEqual(msgs[0], { role: 'system', content: 'top system\n\n# Environment\nstable' })
    assert.deepEqual(msgs.filter((x) => x.role === 'system').slice(1), [
      { role: 'system', content: '<total_tokens>900 tokens left</total_tokens>' },
      { role: 'system', content: '<total_tokens>800 tokens left</total_tokens>' },
    ])
  })

  test('system, inline system, text, tool loop, effort, cap and tools', () => {
    const id = encodeChatToolId('call_abc.1')
    const out = anthropicToOpenAIChat({
      model: 'glm-5.3',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'top system' }],
      output_config: { effort: 'high' },
      temperature: 0.2,
      stop_sequences: ['END'],
      tools: [
        { name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } },
      ],
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
            {
              type: 'tool_result',
              tool_use_id: id,
              content: [{ type: 'text', text: 'a.txt' }],
              is_error: true,
            },
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
        tool_calls: [
          {
            id: 'call_abc.1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"command":"ls"}' },
          },
        ],
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
      {
        type: 'function',
        function: {
          name: 'Bash',
          description: 'run',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'Bash' } })
    assert.equal('thinking' in out, false)
  })

  test('tool choice modes; no effort when none was kept by the proxy', () => {
    const base = {
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', input_schema: {} }],
    }
    assert.equal(anthropicToOpenAIChat({ ...base }).tool_choice, 'auto')
    assert.equal(
      anthropicToOpenAIChat({ ...base, tool_choice: { type: 'any' } }).tool_choice,
      'required',
    )
    assert.equal(
      anthropicToOpenAIChat({ ...base, tool_choice: { type: 'none' } }).tool_choice,
      'none',
    )
    assert.equal(anthropicToOpenAIChat({ ...base }).reasoning_effort, undefined)
    assert.equal(anthropicToOpenAIChat({ ...base, max_tokens: 100 }).max_tokens, 100)
  })

  test('fails closed on what it cannot represent', () => {
    const m = (content: unknown, role = 'user') => ({ model: 'm', messages: [{ role, content }] })
    assert.throws(
      () => anthropicToOpenAIChat(m([{ type: 'image', source: {} }])),
      /unsupported OpenCode Go user block/,
    )
    assert.throws(
      () =>
        anthropicToOpenAIChat(
          m([{ type: 'tool_result', tool_use_id: 'toolu_oc_x', content: 'r' }]),
        ),
      /no matching tool call/,
    )
    // The official Claude Code WebSearch server tool is stripped instead of
    // rejecting the whole request; other server tools still fail closed.
    const stripped = anthropicToOpenAIChat({
      ...m('x'),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    })
    assert.equal('tools' in stripped, false)
    assert.equal('tool_choice' in stripped, false)
    assert.throws(
      () =>
        anthropicToOpenAIChat({
          ...m('x'),
          tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
        }),
      /server tools/,
    )
    assert.throws(() => anthropicToOpenAIChat(m([{ type: 'text', text: '' }])), /nonempty content/)
    assert.throws(() => anthropicToOpenAIChat({ messages: [] }), /requires a model/)
  })

  test('mixed web_search + function tools keep only function tools and relax a forced search', () => {
    const mixed = anthropicToOpenAIChat({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'search then read' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'Read', input_schema: { type: 'object', properties: {} } },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    })
    assert.deepEqual(mixed.tools, [
      {
        type: 'function',
        function: { name: 'Read', parameters: { type: 'object', properties: {} } },
      },
    ])
    assert.equal(mixed.tool_choice, 'auto')
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
    assert.deepEqual(
      chatUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: null, audio_tokens: null },
      }),
      {
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    )
    assert.throws(() =>
      chatUsage({
        prompt_tokens: 1,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 2 },
      }),
    )
    assert.throws(() => chatUsage({ prompt_tokens: -1, completion_tokens: 0 }))
  })
})

describe('stream conversion', () => {
  test('text then fragmented tool calls become one text block and complete tool_use blocks', async () => {
    const out = await events([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] },
      { choices: [{ index: 0, delta: { content: 'Let me ' } }] },
      { choices: [{ index: 0, delta: { content: 'check.' } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Read', arguments: '' } }],
            },
          },
        ],
      },
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
    assert.deepEqual(out[5]!.content_block, {
      type: 'tool_use',
      id: encodeChatToolId('call_1'),
      name: 'Bash',
      input: {},
    })
    assert.deepEqual(out[6]!.delta, { type: 'input_json_delta', partial_json: '{"command":"ls"}' })
    assert.deepEqual(out[9]!.delta, { type: 'input_json_delta', partial_json: '{}' })
    assert.deepEqual(out[11], {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: {
        input_tokens: 120,
        output_tokens: 41,
        cache_read_input_tokens: 7000,
        cache_creation_input_tokens: 0,
      },
    })
  })

  test('a refusal completes as text, not as a broken stream', async () => {
    const out = await events([
      {
        choices: [
          { index: 0, delta: { refusal: "I can't help with that." }, finish_reason: 'stop' },
        ],
      },
      usageChunk,
      '[DONE]',
    ])
    assert.equal(
      (out.find((e) => e.type === 'content_block_delta')!.delta as Obj).text,
      "I can't help with that.",
    )
    assert.equal((out.at(-2)!.delta as Obj).stop_reason, 'end_turn')
  })

  test('length maps to max_tokens; text only maps to end_turn', async () => {
    const out = await events([
      { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }] },
      usageChunk,
      '[DONE]',
    ])
    assert.equal((out.at(-2)!.delta as Obj).stop_reason, 'max_tokens')
    const done = await events([
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      usageChunk,
    ])
    assert.equal((done.at(-2)!.delta as Obj).stop_reason, 'end_turn')
  })

  test('an unfinished or usage-less stream fails; partial usage is emitted once first', async () => {
    await assert.rejects(
      events([{ choices: [{ index: 0, delta: { content: 'x' } }] }, usageChunk, '[DONE]']),
      /without a successful/,
    )
    await assert.rejects(
      events([
        { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]),
      /without a successful/,
    )
    const seen: string[] = []
    const decoder = new TextDecoder()
    await assert.rejects(async () => {
      for await (const raw of chatToAnthropicEvents(
        sse([usageChunk, { error: { message: 'boom' } }]).getReader(),
        'm',
      ))
        seen.push(decoder.decode(raw).split('\n')[0]!)
    }, /error event/)
    assert.deepEqual(seen, ['event: message_start', 'event: message_delta'])
    await assert.rejects(
      events([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'c', function: { name: 'T', arguments: '[1]' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        usageChunk,
      ]),
      /expected object/,
    )
  })
})

describe('fetch wrapper', () => {
  test('posts the OpenAI body to the chat endpoint with Bearer auth and keeps the session header', async () => {
    let seen: { url: string; headers: Headers; body: Obj } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
      return new Response(
        sse([
          { choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] },
          usageChunk,
          '[DONE]',
        ]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const res = await createOpenAIChatGoFetch(fetchImpl)('https://opencode.ai/zen/go/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'GO-KEY',
        'anthropic-version': '2023-06-01',
        'x-opencode-session': 'sess-1',
      },
      body: JSON.stringify({
        model: 'glm-5.3',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
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
      new Response(JSON.stringify({ error: { message: 'bad key GO-KEY used' } }), {
        status: 429,
        headers: { 'retry-after': '7' },
      })) as unknown as typeof fetch
    const res = await createOpenAIChatGoFetch(failing)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify({
        model: 'glm-5.3',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
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
    }) as unknown as typeof fetch)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'K' },
      body: '{"model":"m","messages":[]}',
    })
    assert.equal(bad.status, 400)
    assert.equal(called, false)
  })

  test('fulfills the WebSearch side request with platform results instead of a 400', async () => {
    let upstreamCalled = false
    let seen: { spec: Parameters<BoundWebSearch>[0]; signal?: AbortSignal } | undefined
    const webSearch: BoundWebSearch = async (spec, signal) => {
      seen = { spec, signal }
      return [
        { title: 'Fable docs', url: 'https://docs.example.com/fable', pageAge: '2026-10-01' },
        { title: 'Blocked', url: 'https://spam.example.com/x' },
        { title: 'Other site', url: 'https://other.test/fable' },
        { title: 'Bad URL', url: 'not-a-url' },
      ]
    }
    const bridge = createOpenAIChatGoFetch(
      (async () => {
        upstreamCalled = true
        return new Response('')
      }) as unknown as typeof fetch,
      { webSearch },
    )
    const r = await bridge('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify(webSearchBody()),
    })
    assert.equal(r.status, 200)
    const events = parseAnthropicSse(await r.text())
    assert.equal(upstreamCalled, false, 'the search side request never hits the Go model')
    assert.equal(seen!.spec.name, 'web_search')
    assert.equal(seen!.spec.query, 'Claude Fable 5.5 release date')
    assert.deepEqual(seen!.spec.allowedDomains, ['example.com'])
    assert.deepEqual(seen!.spec.blockedDomains, ['spam.example.com'])
    assert.deepEqual(
      events.map((e) => e.type),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    )
    const toolUse = events[1]!.content_block as Obj
    assert.equal(toolUse.type, 'server_tool_use')
    assert.equal(toolUse.name, 'web_search')
    assert.match(toolUse.id as string, /^srvtoolu_ws_/)
    assert.deepEqual(JSON.parse((events[2]!.delta as Obj).partial_json as string), {
      query: 'Claude Fable 5.5 release date',
    })
    const result = events[4]!.content_block as Obj
    assert.equal(result.type, 'web_search_tool_result')
    assert.equal(result.tool_use_id, toolUse.id)
    assert.deepEqual(result.content, [
      {
        type: 'web_search_result',
        title: 'Fable docs',
        url: 'https://docs.example.com/fable',
        encrypted_content: '',
        page_age: '2026-10-01',
      },
    ])
    const delta = events[6]!.delta as Obj
    assert.equal(delta.stop_reason, 'end_turn')
    assert.deepEqual((events[6]!.usage as Obj).server_tool_use, {
      web_search_requests: 1,
      web_fetch_requests: 0,
    })
  })

  test('a failed search returns the protocol error block, not an empty result or a 400', async () => {
    const webSearch: BoundWebSearch = async () => {
      throw new WebSearchError('too_many_requests', 'web search rate limited')
    }
    const r = await createOpenAIChatGoFetch(
      (async () => new Response('')) as unknown as typeof fetch,
      {
        webSearch,
      },
    )('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify(webSearchBody()),
    })
    assert.equal(r.status, 200)
    const result = parseAnthropicSse(await r.text()).find(
      (e) =>
        e.type === 'content_block_start' &&
        (e.content_block as Obj).type === 'web_search_tool_result',
    )!.content_block as Obj
    assert.deepEqual(result.content, {
      type: 'web_search_tool_result_error',
      error_code: 'too_many_requests',
      error_message: 'web search rate limited',
    })
  })

  test('without an executor the side request reports search unavailable, without a model call', async () => {
    let upstreamCalled = false
    const fetchImpl = (async () => {
      upstreamCalled = true
      return new Response('')
    }) as unknown as typeof fetch
    const r = await createOpenAIChatGoFetch(fetchImpl)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify(webSearchBody()),
    })
    assert.equal(r.status, 200)
    const result = parseAnthropicSse(await r.text()).find(
      (e) =>
        e.type === 'content_block_start' &&
        (e.content_block as Obj).type === 'web_search_tool_result',
    )!.content_block as Obj
    assert.deepEqual(result.content, {
      type: 'web_search_tool_result_error',
      error_code: 'unavailable',
      error_message: 'web search is not configured for this route',
    })
    assert.equal(upstreamCalled, false)
  })

  test('mixed requests without an executor still strip the tool and reach the model', async () => {
    let seen: Obj | undefined
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body))
      return new Response(
        sse([
          { choices: [{ index: 0, delta: { content: 'no search here' }, finish_reason: 'stop' }] },
          usageChunk,
          '[DONE]',
        ]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const r = await createOpenAIChatGoFetch(fetchImpl)('x', {
      method: 'POST',
      headers: { 'x-api-key': 'GO-KEY' },
      body: JSON.stringify(
        webSearchBody({
          tools: [
            { type: 'web_search_20250305', name: 'web_search' },
            { name: 'Read', input_schema: { type: 'object' } },
          ],
          messages: [{ role: 'user', content: 'read this file' }],
        }),
      ),
    })
    assert.equal(r.status, 200)
    assert.deepEqual(seen!.tools, [
      { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    ])
    assert.match(await r.text(), /no search here/)
  })
})
