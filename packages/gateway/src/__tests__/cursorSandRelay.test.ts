import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import * as protobuf from 'protobufjs'
import { CursorSandRelay, encodeCursorSandRequest, recoverXmlToolCalls } from '../engine/cursorSandRelay.js'
import { CursorSandAdapter, cursorSandEnabledForModel } from '../engine/cursorSandAdapter.js'
import { CursorRoutingAdapter } from '../engine/cursorRoutingAdapter.js'
import { createEngine } from '../engine/registry.js'

const root = protobuf.loadSync(
  resolve(process.cwd(), 'packages/gateway/src/engine/cursorSandInference.proto'),
)
const StreamRequest = root.lookupType('aiserver.v1.InferenceStreamRequest')
const StreamResponse = root.lookupType('aiserver.v1.InferenceStreamResponse')

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length)
  out[0] = flags
  out.writeUInt32BE(payload.length, 1)
  Buffer.from(payload).copy(out, 5)
  return out
}

function responseFrame(field: string, value: unknown): Buffer {
  return envelope(StreamResponse.encode(StreamResponse.fromObject({ [field]: value })).finish())
}

function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`
}

test('Sand sidecar selects only primary-key Fable models', () => {
  const sidecar = '# sand-mode v1\napi-key 1\napi-key.2 0\n'
  assert.equal(cursorSandEnabledForModel('cursor-fable-5-high', sidecar), true)
  assert.equal(cursorSandEnabledForModel('cursor-grok-4.6-high', sidecar), false)
  assert.equal(cursorSandEnabledForModel('cursor-fable-5-high', 'api-key 0\n'), false)
  assert.equal(cursorSandEnabledForModel('cursor-fable-5-high', 'api-key.2 1\n'), false)
})

test('cursor engine factory selects Sand CCB only when the primary sidecar enables Fable', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-factory-'))
  const sidecar = resolve(dir, '.sand-mode')
  const previous = process.env.OC_CURSOR_SAND_SIDECAR
  process.env.OC_CURSOR_SAND_SIDECAR = sidecar
  const opts = {
    sessionKey: 'agent:main:test:cursor-sand-factory',
    agentId: 'main',
    agentBaseDir: dir,
    config: {} as never,
    model: 'cursor-fable-5-high',
  }
  try {
    writeFileSync(sidecar, 'api-key 1\n')
    const sand = createEngine('cursor', opts)
    assert.equal(sand instanceof CursorRoutingAdapter, true)
    assert.equal((sand as unknown as CursorRoutingAdapter).currentVariant, 'sand')
    assert.equal(typeof sand.compactForHandoff, 'function')
    sand.setModel('cursor-grok-4.6-high')
    await (sand as unknown as CursorRoutingAdapter).refreshVariantForTest()
    assert.equal((sand as unknown as CursorRoutingAdapter).currentVariant, 'native')
    sand.setModel('cursor-fable-5-high')
    await (sand as unknown as CursorRoutingAdapter).refreshVariantForTest()
    assert.equal((sand as unknown as CursorRoutingAdapter).currentVariant, 'sand')
    await sand.shutdown()

    writeFileSync(sidecar, 'api-key 0\n')
    const native = createEngine('cursor', opts)
    assert.equal(native instanceof CursorRoutingAdapter, true)
    assert.equal((native as unknown as CursorRoutingAdapter).currentVariant, 'native')
    writeFileSync(sidecar, 'api-key 1\n')
    native.setModel('cursor-fable-5-high')
    await assert.rejects(
      (native as unknown as CursorRoutingAdapter).refreshVariantForTest(),
      /CURSOR_ROUTE_VARIANT_CHANGED_REOPEN_SESSION/,
    )
    await native.shutdown()
  } finally {
    if (previous === undefined) delete process.env.OC_CURSOR_SAND_SIDECAR
    else process.env.OC_CURSOR_SAND_SIDECAR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cold submit starts the relay and emits one external billing terminal with usage', async () => {
  let starts = 0
  let closes = 0
  const relay = {
    async start() { starts++; return 'http://127.0.0.1:12345/route/test' },
    async close() { closes++ },
  } as unknown as CursorSandRelay
  const summary = {
    usage: {
      cost: 0, inputTokens: 11, outputTokens: 7,
      cacheReadTokens: 3, cacheCreationTokens: 2, totalTokens: 23,
    },
    assistantText: 'ok', thinkingText: '', assistantSegments: [], thinkingSegments: [],
    tools: [], runtimeEvents: [], stopReason: 'end_turn', numTurns: 1,
    isError: false, staleResumeId: false,
    phantomSignals: { apiState: 'called', skipReason: null },
  }
  const fakeRun = {
    submitted: Promise.resolve(),
    summary: Promise.resolve(summary),
    end() {},
    getPartialSnapshot: () => ({
      assistantText: '', thinkingText: '', completedTools: [],
      assistantSegments: [], thinkingSegments: [], runtimeEvents: [],
    }),
    getPhantomSignals: () => ({ apiState: 'unknown' as const, skipReason: null }),
    finalized: true,
    pendingToolCalls: 0,
  }
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:cold-sand', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high',
  }, relay, () => fakeRun as never)
  const billing: unknown[] = []
  adapter.on('external_billing', (event) => billing.push(event))
  const run = adapter.submitTurn({
    input: 'hello', requestId: 'a'.repeat(32),
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  await run.submitted
  assert.equal((await run.summary)?.assistantText, 'ok')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(starts, 1)
  assert.equal(billing.length, 1)
  assert.deepEqual(billing[0], {
    requestId: 'a'.repeat(32), engine: 'cursor', status: 'success',
    durationMs: (billing[0] as { durationMs: number }).durationMs,
    usage: {
      input_tokens: 11, output_tokens: 7,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
    },
  })
  await adapter.shutdown()
  assert.equal(closes, 1)
})

test('interrupt before cold Sand preparation prevents submission', async () => {
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise })
  let starts = 0
  let submissions = 0
  const relay = {
    async start() {
      starts++
      await startGate
      return 'http://127.0.0.1:12345/route/test'
    },
    async close() {},
  } as unknown as CursorSandRelay
  const adapter = new CursorSandAdapter({
    sessionKey: 'agent:main:test:cold-sand-cancel', agentId: 'main', agentBaseDir: process.cwd(),
    config: {} as never, model: 'cursor-fable-5-high',
  }, relay, () => {
    submissions++
    throw new Error('cancelled cold submit must not reach the inner adapter')
  })
  const billing: Array<{ terminalCode?: string }> = []
  adapter.on('external_billing', (event) => billing.push(event as { terminalCode?: string }))
  const run = adapter.submitTurn({
    input: 'hello', requestId: 'b'.repeat(32),
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    onEvent() {}, onPostTerminalRuntimeEvent() {},
  })
  assert.equal(adapter.interrupt(), true)
  releaseStart()
  await run.submitted
  assert.equal(await run.summary, null)
  assert.equal(starts, 1)
  assert.equal(submissions, 0)
  assert.equal(billing.length, 1)
  assert.equal(billing[0].terminalCode, 'USER_CANCELLED')
  await adapter.shutdown()
})

test('routing interrupt during deferred variant preparation prevents inner submission', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cursor-sand-routing-cancel-'))
  const sidecar = resolve(dir, '.sand-mode')
  const previous = process.env.OC_CURSOR_SAND_SIDECAR
  process.env.OC_CURSOR_SAND_SIDECAR = sidecar
  writeFileSync(sidecar, 'api-key 0\n')
  const router = new CursorRoutingAdapter({
    sessionKey: 'agent:main:test:routing-cancel', agentId: 'main', agentBaseDir: dir,
    config: {} as never, model: 'cursor-grok-4.6-high',
  })
  try {
    let releaseVariant!: () => void
    const variantGate = new Promise<void>((resolvePromise) => { releaseVariant = resolvePromise })
    let submissions = 0
    const testRouter = router as unknown as {
      ensureVariant: () => Promise<void>
      inner: { submitTurn: () => never }
    }
    testRouter.ensureVariant = async () => { await variantGate }
    testRouter.inner.submitTurn = () => {
      submissions++
      throw new Error('cancelled routing submit must not reach the inner adapter')
    }
    const run = router.submitTurn({
      input: 'hello', sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(), onEvent() {}, onPostTerminalRuntimeEvent() {},
    })
    assert.equal(router.interrupt(), true)
    releaseVariant()
    await run.submitted
    assert.equal(await run.summary, null)
    assert.equal(submissions, 0)
  } finally {
    await router.shutdown()
    if (previous === undefined) delete process.env.OC_CURSOR_SAND_SIDECAR
    else process.env.OC_CURSOR_SAND_SIDECAR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool recovery accepts XML and bounded compact control but rejects unknown tools', () => {
  const bash = { name: 'Bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
  const read = { name: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
  const xml = recoverXmlToolCalls(
    '<tool_use name="Read">{"path":"a.txt"}</tool_use>',
    [read],
  )
  assert.equal(xml.tools.length, 1)
  assert.equal(xml.tools[0].name, 'Read')
  assert.deepEqual(xml.tools[0].input, { path: 'a.txt' })
  assert.equal(xml.text, '')

  const example = recoverXmlToolCalls(
    'Example: <tool_use name="Bash">{"command":"danger"}</tool_use>',
    [bash],
  )
  assert.equal(example.tools.length, 0)
  assert.match(example.text, /Example:/)

  const compact = recoverXmlToolCalls(
    'tool_call: {"name":"Bash","arguments":{"command":"printf ok"}}',
    [bash],
  )
  assert.equal(compact.tools.length, 1)
  assert.equal(compact.tools[0].name, 'Bash')
  assert.equal(compact.text, '')

  const compactWithSuffix = recoverXmlToolCalls(
    'tool_call: {"name":"Bash","arguments":{"command":"printf ok"}}\nresult',
    [bash],
  )
  assert.equal(compactWithSuffix.tools.length, 0)

  const colon = recoverXmlToolCalls(': Bash\ninput: {"command":"printf ok"}', [bash])
  assert.equal(colon.tools.length, 1)
  assert.equal(colon.tools[0].name, 'Bash')
  assert.deepEqual(colon.tools[0].input, { command: 'printf ok' })
  assert.equal(colon.text, '')

  const rejected = recoverXmlToolCalls(
    'tool_call: {"name":"Unadvertised","arguments":{}}',
    [bash],
  )
  assert.equal(rejected.tools.length, 0)

  const inferred = recoverXmlToolCalls(
    '{"command":"printf ok"}',
    [
      bash,
      read,
    ],
  )
  assert.equal(inferred.tools.length, 1)
  assert.equal(inferred.tools[0].name, 'Bash')
  assert.equal(inferred.text, '')

  const wrongType = recoverXmlToolCalls(
    '{"command":123}',
    [bash],
  )
  assert.equal(wrongType.tools.length, 0)
})

test('Anthropic request encodes the concrete Fable model, history and tools', () => {
  const encoded = encodeCursorSandRequest({
    model: 'cursor-fable-5-high',
    max_tokens: 512,
    system: [{ type: 'text', text: 'system' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }],
      },
    ],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  })
  assert.equal(encoded.upstreamModel, 'claude-fable-5-thinking-high')
  const request = StreamRequest.toObject(StreamRequest.decode(encoded.bytes), { oneofs: true })
  assert.equal(request.modelId, 'claude-fable-5-thinking-high')
  assert.equal(request.modelConfig.maxTokens, 512)
  assert.equal(request.messages[0].role, 4)
  assert.match(request.messages[0].text, /<tool_use name="TOOL_NAME">/)
  assert.match(request.messages[0].text, /"name":"Read"/)
  assert.equal(
    request.messages.some((message: { text?: string }) => message.text?.includes('<tool_result id="toolu_1"')),
    true,
  )
  assert.deepEqual(request.tools ?? [], [])
})

test('loopback relay hits InferenceService/Stream with Sand identity and emits Anthropic SSE', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.InferenceService/Stream')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('x-cursor-client-type'), 'sand')
    assert.equal(headers.get('x-cursor-client-version'), 'cli-2026.08.11-e8db854')
    assert.equal(headers.get('content-type'), 'application/connect+proto')
    const body = Buffer.from(init.body as Uint8Array)
    const length = body.readUInt32BE(1)
    const request = StreamRequest.toObject(
      StreamRequest.decode(body.subarray(5, 5 + length)),
      { oneofs: true },
    )
    assert.equal(request.modelId, 'claude-fable-5-thinking-high')
    const response = Buffer.concat([
      responseFrame('thinkingPart', { text: 'thought' }),
      responseFrame('textPart', { text: 'done' }),
      responseFrame('toolCallPart', {
        toolCallId: 'toolu_x',
        toolName: 'Read',
        args: '{"path":"a.txt"}',
        isComplete: true,
        toolIndex: 0,
      }),
      responseFrame('usage', { promptTokens: 10, completionTokens: 4, totalTokens: 14 }),
      envelope(Buffer.from('{}'), 0x02),
    ])
    return new Response(response, {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({
    fetchImpl,
    readApiKey: () => Buffer.from('crsr_test'),
  })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high',
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: message_start/)
    assert.match(text, /"usage":\{"input_tokens":10,"output_tokens":0\}/)
    assert.match(text, /"type":"thinking_delta"/)
    assert.match(text, /"type":"text_delta","text":"done"/)
    assert.match(text, /"type":"tool_use"/)
    assert.match(text, /"type":"input_json_delta"/)
    assert.match(text, /"stop_reason":"tool_use"/)
    assert.match(text, /event: message_stop/)
    assert.equal(calls.length, 2)
  } finally {
    await relay.close()
  }
})

test('ordinary tool examples remain text and do not trigger a correction request', async () => {
  let inferenceCalls = 0
  const ordinary = 'Example: <tool_use name="Bash">{"command":"printf unsafe"}</tool_use>'
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    inferenceCalls++
    return new Response(Buffer.concat([
      responseFrame('textPart', { text: ordinary }),
      responseFrame('usage', { promptTokens: 8, completionTokens: 6, totalTokens: 14 }),
      envelope(Buffer.from('{}'), 0x02),
    ]), {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'show a tool example' }],
        tools: [{
          name: 'Bash',
          input_schema: {
            type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
          },
        }],
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /Example:/)
    assert.match(body, /"stop_reason":"end_turn"/)
    assert.equal(inferenceCalls, 1)
  } finally {
    await relay.close()
  }
})

test('count_tokens remains loopback-scoped and side-effect free', async () => {
  let upstreamCalls = 0
  const relay = new CursorSandRelay({
    fetchImpl: async () => {
      upstreamCalls++
      throw new Error('must not call upstream')
    },
    readApiKey: () => Buffer.from('unused'),
  })
  const baseUrl = await relay.start()
  try {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor-fable-5-high', messages: [{ role: 'user', content: 'hello' }] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { input_tokens: number }
    assert.equal(body.input_tokens > 0, true)
    assert.equal(upstreamCalls, 0)
  } finally {
    await relay.close()
  }
})

test('downstream abort cancels the Cursor stream and relay close does not hang', async () => {
  let upstreamAborted = false
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input).endsWith('/auth/exchange_user_api_key')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener('abort', () => {
          upstreamAborted = true
          controller.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      },
      cancel() { upstreamAborted = true },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/connect+proto' },
    })
  }
  const relay = new CursorSandRelay({ fetchImpl, readApiKey: () => Buffer.from('crsr_test') })
  const baseUrl = await relay.start()
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cursor-fable-5-high', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content: 'wait' }],
    }),
    signal: controller.signal,
  })
  controller.abort()
  await response.text().catch(() => {})
  await Promise.race([
    relay.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('relay close timeout')), 500)),
  ])
  assert.equal(upstreamAborted, true)
})
