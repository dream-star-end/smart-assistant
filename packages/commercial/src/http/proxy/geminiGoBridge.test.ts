import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import {
  GEMINI_GO_ENDPOINT,
  GEMINI_GO_MODEL,
  anthropicToGemini,
  createGeminiGoFetch,
  decodeGeminiToolId,
  encodeGeminiToolId,
  geminiUsage,
} from './geminiGoBridge.js'
import { pipeStreamWithUsageCapture } from './shared.js'

const input = {
  model: GEMINI_GO_MODEL,
  max_tokens: 128,
  messages: [{ role: 'user', content: 'Connectivity test' }],
}
const usage = {
  promptTokenCount: 100,
  cachedContentTokenCount: 80,
  candidatesTokenCount: 6,
  thoughtsTokenCount: 4,
}
const wire = (events: unknown[], crlf = false) =>
  events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join('')
    .replaceAll('\n', crlf ? '\r\n' : '\n')
function fixture(events: unknown[], chunks = 7): { fetch: typeof fetch; canceled: () => boolean } {
  const bytes = new TextEncoder().encode(wire(events, true))
  let offset = 0
  let canceled = false
  return {
    canceled: () => canceled,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (offset === bytes.length) {
              c.close()
              return
            }
            c.enqueue(bytes.slice(offset, offset + chunks))
            offset = Math.min(bytes.length, offset + chunks)
          },
          cancel() {
            canceled = true
          },
        }),
      ),
  }
}
async function response(fetch: typeof globalThis.fetch) {
  return createGeminiGoFetch(fetch)('https://unused.invalid/messages', {
    method: 'POST',
    headers: {
      'x-api-key': 'fixture-key',
      'x-opencode-session': 'stable-conversation',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(input),
  })
}
async function capture(r: Response) {
  let text = ''
  const res = Object.assign(new EventEmitter(), {
    write(b: Uint8Array) {
      text += new TextDecoder().decode(b)
      return true
    },
  })
  const result = await pipeStreamWithUsageCapture(
    r.body!,
    res as unknown as ServerResponse,
    new AbortController().signal,
  )
  return { text, ...result }
}

function parse(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((raw) =>
      JSON.parse(
        raw
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5),
      ),
    )
}

test('request maps system/tools/options and native signed tool replay without mutating input', () => {
  const id = encodeGeminiToolId({ id: 'native_1' }, 'opaque-google-signature')
  const body = {
    ...input,
    system: [{ type: 'text', text: 'Agent system', cache_control: { type: 'ephemeral' } }],
    tools: [
      {
        name: 'echo',
        description: 'echo',
        input_schema: { type: 'object', additionalProperties: false },
      },
    ],
    tool_choice: { type: 'tool', name: 'echo' },
    messages: [
      input.messages[0],
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'echo', input: { value: 1 } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: 'done' },
          { type: 'text', text: 'continue' },
        ],
      },
    ],
  }
  const before = JSON.stringify(body)
  const native = anthropicToGemini(body)
  assert.equal(JSON.stringify(body), before)
  const contents = native.contents as Record<string, unknown>[]
  assert.deepEqual(contents[1]!.parts, [
    {
      functionCall: { name: 'echo', args: { value: 1 }, id: 'native_1' },
      thoughtSignature: 'opaque-google-signature',
    },
  ])
  assert.deepEqual((contents[2]!.parts as unknown[])[0], {
    functionResponse: { name: 'echo', id: 'native_1', response: { output: 'done' } },
  })
  assert.deepEqual(native.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['echo'] },
  })
  assert.deepEqual(native.systemInstruction, { parts: [{ text: 'Agent system' }] })
  assert.ok(!('metadata' in native))
})

test('role:system messages from CCB join systemInstruction in order (OCV5-423 live 400)', () => {
  // Shape of a real platform first request: top-level system blocks with
  // cache_control, then a user turn and an inline platform-context system
  // message. Before the fix every such request failed locally with
  // "unsupported Gemini message role" and never reached Google.
  const body = {
    model: GEMINI_GO_MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    context_management: { edits: [] },
    output_config: { effort: 'medium' },
    system: [
      { type: 'text', text: 'billing header' },
      { type: 'text', text: 'static platform prompt', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'system',
        content: [{ type: 'text', text: 'session context', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'and again' },
    ],
  }
  const before = structuredClone(body)
  const out = anthropicToGemini(body)
  assert.deepEqual(body, before)
  assert.deepEqual(out.systemInstruction, {
    parts: [
      { text: 'billing header' },
      { text: 'static platform prompt' },
      { text: 'session context' },
    ],
  })
  // Only conversation turns remain; the two user turns around the system message merge.
  assert.deepEqual(out.contents, [
    { role: 'user', parts: [{ text: 'hello' }, { text: 'and again' }] },
  ])
  assert.deepEqual(
    anthropicToGemini({
      ...input,
      messages: [{ role: 'system', content: 'only context' }, ...input.messages],
    }).systemInstruction,
    {
      parts: [{ text: 'only context' }],
    },
  )
  assert.throws(
    () =>
      anthropicToGemini({
        ...input,
        messages: [...input.messages, { role: 'system', content: [{ type: 'image' }] }],
      }),
    /unsupported Gemini system content/,
  )
  assert.throws(
    () => anthropicToGemini({ ...input, messages: [{ role: 'tool', content: 'x' }] }),
    /unsupported Gemini message role/,
  )
})

test('foreign tool history is explicit rejection, not a fabricated Google signature', () => {
  assert.throws(
    () =>
      anthropicToGemini({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_foreign', name: 'x', input: {} }],
          },
        ],
      }),
    /start a new conversation/,
  )
})
test('replay envelopes preserve optional signatures and native ids, parallel calls have unique ids', () => {
  const a = encodeGeminiToolId({ id: 'same' }, 'signature')
  const b = encodeGeminiToolId({ id: 'same' }, 'signature')
  assert.notEqual(a, b)
  assert.equal(decodeGeminiToolId(a).id, 'same')
  assert.equal(decodeGeminiToolId(a).signature, 'signature')
  assert.equal(decodeGeminiToolId(encodeGeminiToolId({})).signature, undefined)
  assert.throws(() => encodeGeminiToolId({}, 'x'.repeat(150000)), /budget/)
})
test('Google cumulative usage does not double bill cached input or omit thought tokens', () => {
  assert.deepEqual(geminiUsage(usage), {
    input_tokens: 20,
    output_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
  })
  assert.throws(() => geminiUsage({ promptTokenCount: 5, cachedContentTokenCount: 6 }), /exceeds/)
})
test('fetch uses fixed native URL and Bearer, preserves signal/dispatcher/session but no Anthropic headers', async () => {
  const signal = new AbortController().signal
  const dispatcher = {}
  let calls = 0
  const fetch = (async (url, init) => {
    calls++
    assert.equal(url, GEMINI_GO_ENDPOINT)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer fixture-key')
    assert.equal(headers.get('x-api-key'), null)
    assert.equal(headers.get('anthropic-version'), null)
    assert.equal(headers.get('x-opencode-session'), 'stable-conversation')
    assert.equal(init?.signal, signal)
    assert.equal((init as RequestInit & { dispatcher: unknown }).dispatcher, dispatcher)
    assert.ok(!('messages' in JSON.parse(init?.body as string)))
    return fixture([
      {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: usage,
      },
    ]).fetch(url, init)
  }) as typeof globalThis.fetch
  const r = await createGeminiGoFetch(fetch)('ignored', {
    body: JSON.stringify(input),
    signal,
    dispatcher,
    headers: { 'x-api-key': 'fixture-key', 'x-opencode-session': 'stable-conversation' },
  } as RequestInit)
  assert.ok((await r.text()).includes('"stop_reason":"end_turn"'))
  assert.equal(calls, 1)
})

test('fragmented CRLF/UTF8 Google SSE, terminal chunk before final usage, becomes a real Anthropic terminal', async () => {
  const r = await response(
    fixture(
      [
        {
          candidates: [{ content: { parts: [{ text: '你好' }] } }],
          usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80 },
        },
        { candidates: [{ content: { parts: [{ text: '🙂' }] }, finishReason: 'STOP' }] },
        {
          candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'final-signature' }] } }],
          usageMetadata: usage,
        },
      ],
      1,
    ).fetch,
  )
  const text = await r.text()
  const events = parse(text)
  assert.equal(
    events.filter((e) => e.type === 'message_delta').length,
    1,
    'CCB bills each delta; success must emit only one',
  )
  assert.equal(
    events.filter((e) => e.type === 'content_block_start').length,
    1,
    'text fragments must share one block',
  )
  assert.equal(events[0]!.type, 'message_start')
  assert.equal(events.at(-1)!.type, 'message_stop')
  assert.ok(text.includes('你好'))
  assert.ok(text.includes('🙂'))
  const observed = await capture(new Response(text))
  assert.deepEqual(observed.observation, {
    kind: 'final',
    usage: {
      input_tokens: 20n,
      output_tokens: 10n,
      cache_read_tokens: 80n,
      cache_write_tokens: 0n,
    },
  })
})
test('SSE tool call returns parsable input and signature/id survive JSON persist→replay', async () => {
  const text = await (
    await response(
      fixture([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'echo', args: { text: 'pong' }, id: 'google-call' },
                    thoughtSignature: 'signature',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: usage,
        },
      ]).fetch,
    )
  ).text()
  const events = parse(text)
  const block = events.find((e) => e.type === 'content_block_start')!.content_block as Record<
    string,
    unknown
  >
  const delta = events.find((e) => e.type === 'content_block_delta')!.delta as Record<
    string,
    unknown
  >
  const restored = JSON.parse(
    JSON.stringify({ ...block, input: JSON.parse(delta.partial_json as string) }),
  )
  const request = anthropicToGemini({
    ...input,
    messages: [
      input.messages[0],
      { role: 'assistant', content: [restored] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: restored.id, content: 'pong' }],
      },
    ],
  })
  assert.deepEqual(((request.contents as Record<string, unknown>[])[1]!.parts as unknown[])[0], {
    functionCall: { name: 'echo', args: { text: 'pong' }, id: 'google-call' },
    thoughtSignature: 'signature',
  })
  assert.equal((events.at(-2)!.delta as Record<string, unknown>).stop_reason, 'tool_use')
})

for (const finishReason of [undefined, 'MALFORMED_FUNCTION_CALL', 'SAFETY']) {
  test(`no false success for native terminal ${String(finishReason)}; real UsageObserver retains partial usage`, async () => {
    const r = await response(
      fixture([
        {
          candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason }],
          usageMetadata: usage,
        },
      ]).fetch,
    )
    const result = await capture(r)
    assert.ok(result.error)
    assert.ok(!result.text.includes('"type":"message_stop"'))
    assert.deepEqual(result.observation, {
      kind: 'partial',
      usage: {
        input_tokens: 20n,
        output_tokens: 10n,
        cache_read_tokens: 80n,
        cache_write_tokens: 0n,
      },
    })
  })
}
test('bad request fails before any network call; native HTTP failure remains HTTP failure', async () => {
  let calls = 0
  const bad = await createGeminiGoFetch(async () => {
    calls++
    throw new Error('must not fetch')
  })('ignored', { body: '{}' })
  assert.equal(bad.status, 400)
  assert.equal(calls, 0)
  const failed = await response(
    async () =>
      new Response(JSON.stringify({ error: { message: 'quota' } }), {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
  )
  assert.equal(failed.status, 429)
  assert.equal(failed.headers.get('retry-after'), '30')
  assert.ok((await failed.text()).includes('quota'))
})
test('canceling converted body cancels native reader without a background consumer', async () => {
  let canceled = false
  const r = await response(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true
          },
        }),
      ),
  )
  await r.body!.cancel()
  assert.equal(canceled, true)
})

// OCV5-423 live: official Claude Code WebSearch sends a side request whose only
// tool is Anthropic's server web_search; the bridge rejected it locally (400).
const webSearchBody = {
  model: GEMINI_GO_MODEL,
  max_tokens: 32000,
  system: [{ type: 'text', text: 'You are an assistant for performing a web search tool use' }],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Perform a web search for the query: opencode go pricing' }],
    },
  ],
  tools: [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 8,
      blocked_domains: ['spam.example'],
    },
  ],
  tool_choice: { type: 'auto' },
}

test('server web_search maps to Google Search grounding; other server tools still fail closed', () => {
  const out = anthropicToGemini(webSearchBody)
  assert.deepEqual(out.tools, [{ googleSearch: {} }])
  assert.equal(out.toolConfig, undefined)
  const forced = anthropicToGemini({
    ...webSearchBody,
    tool_choice: { type: 'tool', name: 'web_search' },
  })
  assert.deepEqual(forced.tools, [{ googleSearch: {} }])
  assert.equal(forced.toolConfig, undefined)
  const mixed = anthropicToGemini({
    ...webSearchBody,
    tools: [...webSearchBody.tools, { name: 'echo', input_schema: { type: 'object' } }],
  })
  assert.deepEqual(mixed.tools, [
    { googleSearch: {} },
    { functionDeclarations: [{ name: 'echo', parametersJsonSchema: { type: 'object' } }] },
  ])
  assert.deepEqual(mixed.toolConfig, { functionCallingConfig: { mode: 'AUTO' } })
  assert.throws(
    () =>
      anthropicToGemini({
        ...webSearchBody,
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
      }),
    /unsupported Gemini tool declaration/,
  )
})

test('grounded answer streams text then server_tool_use + web_search_tool_result with resolved links', async () => {
  const redirect = (n: number) =>
    `https://vertexaisearch.cloud.google.com/grounding-api-redirect/r${n}`
  const sse = wire([
    { candidates: [{ content: { parts: [{ text: 'OpenCode Go costs ' }] } }] },
    {
      candidates: [
        {
          content: { parts: [{ text: '$10 per month.' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['opencode go pricing'],
            groundingChunks: [
              { web: { uri: redirect(1), title: 'opencode.ai' } },
              { web: { uri: redirect(2), title: 'spam.example' } },
              { web: { uri: redirect(3), title: 'docs.example.org' } },
            ],
          },
        },
      ],
      usageMetadata: usage,
    },
  ])
  const seen: string[] = []
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    seen.push(`${init?.method ?? 'GET'} ${u}`)
    if (u === GEMINI_GO_ENDPOINT) {
      const sent = JSON.parse(String(init?.body))
      assert.deepEqual(sent.tools, [{ googleSearch: {} }])
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (u === redirect(1))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://opencode.ai/docs/go/' },
      })
    if (u === redirect(2))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://www.spam.example/x' },
      })
    throw new Error('network down') // redirect(3) stays unresolved, still usable
  }) as typeof fetch
  const r = await createGeminiGoFetch(fetchStub)('https://unused.invalid/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'fixture-key', 'x-opencode-session': 's' },
    body: JSON.stringify(webSearchBody),
  })
  assert.equal(r.status, 200)
  const events = parse(await r.text())
  const starts = events
    .filter((e) => e.type === 'content_block_start')
    .map((e) => e.content_block as Record<string, unknown>)
  assert.deepEqual(
    starts.map((b) => b.type),
    ['text', 'server_tool_use', 'web_search_tool_result'],
  )
  const toolUse = starts[1]!
  assert.match(toolUse.id as string, /^srvtoolu_g4_/)
  assert.equal(toolUse.name, 'web_search')
  const queryDelta = events.find(
    (e) =>
      e.type === 'content_block_delta' &&
      (e.delta as Record<string, unknown>).type === 'input_json_delta',
  )!
  assert.deepEqual(JSON.parse((queryDelta.delta as Record<string, string>).partial_json!), {
    query: 'opencode go pricing',
  })
  const result = starts[2]!
  assert.equal(result.tool_use_id, toolUse.id)
  // blocked_domains drops the spam result; the unresolved redirect keeps its link.
  assert.deepEqual(result.content, [
    {
      type: 'web_search_result',
      title: 'opencode.ai',
      url: 'https://opencode.ai/docs/go/',
      encrypted_content: '',
      page_age: null,
    },
    {
      type: 'web_search_result',
      title: 'docs.example.org',
      url: redirect(3),
      encrypted_content: '',
      page_age: null,
    },
  ])
  const indexes = events.filter((e) => e.type === 'content_block_start').map((e) => e.index)
  assert.deepEqual(indexes, [0, 1, 2])
  assert.equal((events.at(-2)!.delta as Record<string, unknown>).stop_reason, 'end_turn')
  assert.equal(seen.filter((s) => s.startsWith('HEAD ')).length, 3)
})

test('a grounded request that did not search emits no search blocks', async () => {
  const sse = wire([
    {
      candidates: [
        {
          content: { parts: [{ text: 'No search needed.' }] },
          finishReason: 'STOP',
          groundingMetadata: {},
        },
      ],
      usageMetadata: usage,
    },
  ])
  const r = await createGeminiGoFetch((async () => new Response(sse)) as typeof fetch)('x', {
    method: 'POST',
    headers: { 'x-api-key': 'fixture-key' },
    body: JSON.stringify(webSearchBody),
  })
  const types = parse(await r.text())
    .filter((e) => e.type === 'content_block_start')
    .map((e) => (e.content_block as Record<string, unknown>).type)
  assert.deepEqual(types, ['text'])
})
