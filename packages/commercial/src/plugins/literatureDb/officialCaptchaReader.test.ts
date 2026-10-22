import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import type { PoolOutcome } from '../../account-pool/policy/outcome.js'
import type { ModelExecutionDescriptor } from '../../billing/modelCatalog.js'
import { CAPTCHA_PROMPT, LiteratureCaptchaSolver } from './captcha.js'
import { LiteratureError } from './errors.js'
import {
  type OfficialCaptchaBinding,
  type OfficialCaptchaDependencies,
  type OfficialCaptchaRoute,
  type PlatformCaptchaBegin,
  type PlatformCaptchaUsage,
  createCatalogCaptchaResolver,
  createOfficialCaptchaReader,
} from './officialCaptchaReader.js'

const signal = () => new AbortController().signal
const code = (expected: string) => (error: unknown) =>
  error instanceof LiteratureError && error.code === expected
const picture = sharp({ create: { width: 47, height: 20, channels: 3, background: '#666666' } })
  .png()
  .toBuffer()
const binding = (google = false): OfficialCaptchaBinding => ({
  provider: google ? 'google' : 'anthropic',
  model: google ? 'gemini-fixture' : 'claude-fixture',
  upstreamModel: google ? 'gemini-fixture-001' : 'claude-fixture-001',
  usageApproved: true,
})
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const claude = () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '1234' }],
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
  },
})
const gemini = () => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '1234' }] } }],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 2,
    cachedContentTokenCount: 5,
    thoughtsTokenCount: 3,
    totalTokenCount: 25,
  },
})
async function request(abortSignal = signal()) {
  return {
    image: { data: await picture, mediaType: 'image/png' as const },
    prompt: 'ignored attacker prompt containing fixture-account',
    maxOutputTokens: 999,
    signal: abortSignal,
  }
}
function fixture(config = binding()) {
  let route: OfficialCaptchaRoute | null = {
    ...config,
    active: true,
    supportsVision: true,
    transport: 'official-api',
  }
  let handler: typeof fetch = async () =>
    response(config.provider === 'anthropic' ? claude() : gemini())
  const calls: { input: string; init: RequestInit }[] = []
  const events: Readonly<PlatformCaptchaUsage>[] = []
  const begun: Readonly<PlatformCaptchaBegin>[] = []
  const keys: string[] = []
  const health: { member: string; outcome: PoolOutcome }[] = []
  const deps: OfficialCaptchaDependencies = {
    resolveRoute: async () => route,
    selectKey: async (service, sticky) => {
      assert.equal(sticky, 'fixture-operation')
      keys.push(service)
      return { service, memberId: `member-${keys.length}`, apiKey: 'synthetic-fixture-api-key' }
    },
    reportOutcome: async (member, outcome) => {
      health.push({ member, outcome })
    },
    beginPlatformUsage: async (event) => {
      begun.push(event)
    },
    recordPlatformUsage: async (event) => {
      events.push(event)
    },
    fetchImpl: async (input, init) => {
      assert.equal(begun.length, calls.length + 1, 'admission must commit before fetch')
      calls.push({ input: String(input), init: init! })
      return handler(input, init)
    },
  }
  return {
    config,
    deps,
    calls,
    events,
    begun,
    keys,
    health,
    route: (value: OfficialCaptchaRoute | null) => {
      route = value
    },
    handler: (value: typeof fetch) => {
      handler = value
    },
    reader: () => createOfficialCaptchaReader(config, 'fixture-operation', deps),
  }
}

test('Claude official request uses only fixed image protocol and the platform API-key pool', async () => {
  const f = fixture()
  const reader = f.reader()
  assert.equal(await reader.recognize(await request()), '1234')
  assert.equal(await reader.recognize(await request()), '1234')
  assert.deepEqual(f.keys, ['claude', 'claude'])
  assert.deepEqual(
    f.health.map((h) => h.member),
    ['member-1', 'member-2'],
  )
  for (const call of f.calls) {
    assert.equal(call.input, 'https://api.anthropic.com/v1/messages')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.credentials, 'omit')
    const headers = new Headers(call.init.headers)
    assert.equal(headers.get('x-api-key'), 'synthetic-fixture-api-key')
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(headers.get('authorization'), null)
    const body = JSON.parse(String(call.init.body))
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream'])
    assert.equal(body.max_tokens, 64)
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].content[1].text, CAPTCHA_PROMPT)
    assert.equal(body.messages[0].content[0].source.media_type, 'image/png')
    assert(!String(call.init.body).includes('fixture-account'))
  }
  assert.deepEqual(f.events[0].usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    thoughtTokens: 0,
    totalTokens: 19,
  })
  assert.notEqual(f.events[0].requestId, f.events[1].requestId)
  assert.deepEqual(
    f.events.map((e) => e.requestId),
    f.begun.map((e) => e.requestId),
  )
  assert(!JSON.stringify(f.events).includes('1234'))
  assert(!JSON.stringify(f.events).includes('synthetic-fixture-api-key'))
})

test('Gemini official protocol is bounded and cached prompt tokens are not added twice', async () => {
  const f = fixture(binding(true))
  f.handler(async () => {
    const body = gemini()
    body.candidates[0].content.parts.unshift({ text: 'ignore-this-thought', thought: true } as {
      text: string
    })
    return response(body)
  })
  assert.equal(await f.reader().recognize(await request()), '1234')
  assert.equal(
    f.calls[0].input,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-001:generateContent',
  )
  assert.deepEqual(f.keys, ['gemini'])
  assert.equal(
    new Headers(f.calls[0].init.headers).get('x-goog-api-key'),
    'synthetic-fixture-api-key',
  )
  const body = JSON.parse(String(f.calls[0].init.body))
  assert.deepEqual(body.generationConfig, { candidateCount: 1, maxOutputTokens: 64 })
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png')
  assert.equal(body.contents[0].parts[1].text, CAPTCHA_PROMPT)
  assert.deepEqual(f.events[0].usage, {
    inputTokens: 20,
    outputTokens: 2,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    thoughtTokens: 3,
    totalTokens: 25,
  })
})

test('fresh route changes stop network and key selection without environment or OAuth fallback', async () => {
  const f = fixture()
  const reader = f.reader()
  const fresh: OfficialCaptchaRoute = {
    ...binding(),
    active: true,
    supportsVision: true,
    transport: 'official-api',
  }
  for (const value of [
    null,
    { ...fresh, active: false },
    { ...fresh, supportsVision: false },
    { ...fresh, usageApproved: false },
    { ...fresh, upstreamModel: 'claude-other' },
    { ...fresh, provider: 'google' as const },
  ]) {
    f.route(value)
    await assert.rejects(reader.recognize(await request()), code('MODEL_UNAVAILABLE'))
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.keys.length, 0)
  f.route(fresh)
  f.deps.selectKey = async () => null
  await assert.rejects(f.reader().recognize(await request()), code('MODEL_UNAVAILABLE'))
  assert.equal(f.calls.length, 0)
})

test('catalog resolver rechecks actual mechanism, canonical binding, vision and use approval', async () => {
  let approved = true
  let reads = 0
  const config = binding()
  const descriptor = {
    canonicalModel: config.model,
    engine: 'ccb',
    providerId: 'anthropic',
    upstreamModelId: config.upstreamModel,
    capabilityProfile: { supportsVision: true },
  } as ModelExecutionDescriptor
  let current: ModelExecutionDescriptor | null = descriptor
  const resolve = createCatalogCaptchaResolver(
    config,
    async () => approved,
    async () => {
      reads++
      return current
    },
  )
  assert.equal((await resolve(signal()))?.transport, 'official-api')
  for (const value of [
    null,
    { ...descriptor, engine: 'codex' as const },
    { ...descriptor, providerId: 'opencodego' },
    { ...descriptor, upstreamModelId: 'claude-other' },
    {
      ...descriptor,
      capabilityProfile: { ...descriptor.capabilityProfile, supportsVision: false },
    },
  ]) {
    current = value
    assert.equal(await resolve(signal()), null)
  }
  current = descriptor
  approved = false
  assert.equal(await resolve(signal()), null)
  assert.equal(reads, 7)
  let googleReads = 0
  assert.equal(
    await createCatalogCaptchaResolver(
      binding(true),
      async () => true,
      async () => {
        googleReads++
        return descriptor
      },
    )(signal()),
    null,
  )
  assert.equal(googleReads, 0) // No official Gemini mechanism in the present catalog.
})

test('constructor rejects OpenAI and model path injection before any external work', () => {
  const f = fixture()
  for (const value of [
    { ...binding(), provider: 'openai' },
    { ...binding(), usageApproved: false },
    { ...binding(), upstreamModel: 'claude-fixture/../../evil' },
    { ...binding(), model: 'gpt-fixture' },
  ]) {
    assert.throws(
      () =>
        createOfficialCaptchaReader(value as OfficialCaptchaBinding, 'fixture-operation', f.deps),
      code('MODEL_UNAVAILABLE'),
    )
  }
  assert.equal(f.calls.length, 0)
})

test('explicit provider refusals override valid-looking text and missing usage', async () => {
  const cases: { google?: boolean; body: unknown }[] = [
    { body: { ...claude(), stop_reason: 'refusal', usage: undefined } },
    { body: { ...claude(), stop_details: { type: 'refusal' } } },
    {
      google: true,
      body: { ...gemini(), promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: undefined },
    },
    {
      google: true,
      body: {
        ...gemini(),
        candidates: [
          { finishReason: 'PUP_LIMITED_DISABLED', content: { parts: [{ text: '1234' }] } },
        ],
      },
    },
  ]
  for (const item of cases) {
    const f = fixture(binding(item.google))
    f.handler(async () => response(item.body))
    await assert.rejects(f.reader().recognize(await request()), code('MODEL_REFUSED'))
    assert.equal(f.events[0].outcome, 'refused')
    assert.equal(f.health[0].outcome.kind, 'success')
  }
})

test('observed refusal remains latched when platform metering hangs until timeout', async () => {
  const first = fixture()
  first.deps.recordPlatformUsage = async () => new Promise(() => {})
  first.handler(async () => response({ ...claude(), stop_reason: 'refusal' }))
  const second = fixture(binding(true))
  const solver = new LiteratureCaptchaSolver([first.reader(), second.reader()], 150)
  const budget = { cloudCalls: 0, maxCloudCalls: 2, cloudRefused: false }
  const input = await request()
  await assert.rejects(solver.solve(input.image, budget, input.signal), code('MODEL_UNAVAILABLE'))
  assert.equal(budget.cloudRefused, true)
  assert.equal(second.calls.length, 0)
})

test('invalid, partial and tool responses never become a CAPTCHA answer', async () => {
  const cases = [
    { google: false, body: { ...claude(), stop_reason: 'max_tokens' } },
    { google: false, body: { ...claude(), usage: undefined } },
    { google: false, body: { ...claude(), content: [{ type: 'tool_use', text: '1234' }] } },
    { google: false, body: { ...claude(), content: [{ type: 'text', text: '**1234**' }] } },
    {
      google: true,
      body: { ...gemini(), candidates: [gemini().candidates[0], gemini().candidates[0]] },
    },
    { google: true, body: { ...gemini(), candidates: [{ finishReason: 'MAX_TOKENS' }] } },
    {
      google: true,
      body: {
        ...gemini(),
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [{ functionCall: { name: 'fixture' }, text: '1234' }],
            },
          },
        ],
      },
    },
    {
      google: true,
      body: {
        ...gemini(),
        usageMetadata: { ...gemini().usageMetadata, cachedContentTokenCount: 100 },
      },
    },
  ]
  for (const item of cases) {
    const f = fixture(binding(item.google))
    f.handler(async () => response(item.body))
    await assert.rejects(f.reader().recognize(await request()), code('RESPONSE_INVALID'))
    assert.equal(f.events[0].outcome, 'invalid')
  }
})

test('response byte cap, bad JSON and stalled body remain bounded and sanitised', async (t) => {
  for (const [text, expected] of [
    ['x'.repeat(65537), 'RESPONSE_TOO_LARGE'],
    ['{', 'MODEL_UNAVAILABLE'],
  ]) {
    const f = fixture()
    f.handler(async () => new Response(text, { headers: { 'content-type': 'application/json' } }))
    await assert.rejects(f.reader().recognize(await request()), code(expected))
    assert.equal(f.calls.length, 1)
  }
  const f = fixture()
  f.deps.timeoutMs = 30
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = 0
  let body!: ReadableStream<Uint8Array>
  f.handler(async () => {
    body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        cancelled++
      },
    })
    return new Response(body, { headers: { 'content-type': 'application/json' } })
  })
  const reading = f.reader().recognize(await request())
  let finished = false
  void reading.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    },
  )
  while (!body?.locked && !finished) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.length, 1)
  assert.equal(body?.locked, true)
  t.mock.timers.tick(30)
  await assert.rejects(reading, code('TIMEOUT'))
  assert.equal(cancelled, 1)
  assert.equal(f.events[0].outcome, 'cancelled')
})

test('pre-cancelled calls select no key and cancellation after headers stops body processing', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.reader().recognize(await request(controller.signal)), code('CANCELLED'))
  assert.equal(f.keys.length, 0)
  const active = new AbortController()
  f.handler(async () => {
    active.abort()
    return response(claude())
  })
  await assert.rejects(f.reader().recognize(await request(active.signal)), code('CANCELLED'))
  assert.equal(f.calls.length, 1)
  await new Promise((resolve) => setImmediate(resolve))
})

test('HTTP rate limits report pool health once and never replay a paid request', async () => {
  const f = fixture()
  f.handler(
    async () =>
      new Response('raw-fixture-upstream-error', {
        status: 429,
        headers: { 'retry-after': '3' },
      }),
  )
  await assert.rejects(f.reader().recognize(await request()), code('MODEL_UNAVAILABLE'))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.health[0].outcome, { kind: 'rate_limited', retryAfterMs: 3000 })
  assert.equal(f.events[0].usage, null)
  assert.equal(f.events[0].outcome, 'http_error')
})

test('meter failure prevents success and dependency class methods retain their receiver', async () => {
  const f = fixture()
  class Dependencies implements OfficialCaptchaDependencies {
    beginPlatformUsage = f.deps.beginPlatformUsage
    resolveRoute = f.deps.resolveRoute
    selectKey = f.deps.selectKey
    reportOutcome = f.deps.reportOutcome
    fetchImpl = f.deps.fetchImpl
    count = 0
    async recordPlatformUsage() {
      this.count++
      throw new Error('synthetic-private-meter-detail')
    }
  }
  const deps = new Dependencies()
  const reader = createOfficialCaptchaReader(binding(), 'fixture-operation', deps)
  await assert.rejects(reader.recognize(await request()), code('MODEL_UNAVAILABLE'))
  assert.equal(deps.count, 1)
  assert.equal(f.calls.length, 1)
})

test('prototype dependency methods never fall through to a real pool or fetch', async () => {
  const f = fixture()
  class Dependencies implements OfficialCaptchaDependencies {
    calls = 0
    async beginPlatformUsage() {
      this.calls++
    }
    async resolveRoute() {
      this.calls++
      return {
        ...binding(),
        active: true,
        supportsVision: true,
        transport: 'official-api' as const,
      }
    }
    async selectKey(service: 'claude' | 'gemini') {
      this.calls++
      return { service, memberId: 'class-member', apiKey: 'synthetic-class-key' }
    }
    async fetchImpl() {
      this.calls++
      return response(claude())
    }
    async reportOutcome() {
      this.calls++
    }
    async recordPlatformUsage() {
      this.calls++
    }
  }
  const deps = new Dependencies()
  assert.equal(
    await createOfficialCaptchaReader(binding(), 'fixture-operation', deps).recognize(
      await request(),
    ),
    '1234',
  )
  assert.equal(deps.calls, 6)
  assert.equal(f.calls.length, 0)
})

test('known rate-limit health survives a stalled platform meter', async () => {
  const f = fixture()
  f.deps.timeoutMs = 100
  f.deps.recordPlatformUsage = async () => new Promise(() => {})
  f.handler(async () => new Response(null, { status: 429, headers: { 'retry-after': '3' } }))
  await assert.rejects(f.reader().recognize(await request()), code('TIMEOUT'))
  assert.deepEqual(f.health[0].outcome, { kind: 'rate_limited', retryAfterMs: 3000 })
  assert.equal(f.calls.length, 1)
})

test('rejecting a non-JSON response immediately cancels an unfinished response body', async () => {
  const f = fixture()
  let cancelled = 0
  f.handler(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('<html>unfinished fixture'))
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'content-type': 'text/html' } },
      ),
  )
  await assert.rejects(f.reader().recognize(await request()), code('RESPONSE_INVALID'))
  assert.equal(cancelled, 1)
  assert.equal(f.events[0].outcome, 'invalid')
  assert.equal(f.calls.length, 1)
})

test('failed durable admission prevents any provider request or health report', async () => {
  const f = fixture()
  f.deps.beginPlatformUsage = async () => {
    throw new LiteratureError('RATE_LIMITED')
  }
  await assert.rejects(f.reader().recognize(await request()), code('MODEL_UNAVAILABLE'))
  assert.equal(f.calls.length, 0)
  assert.equal(f.events.length, 0)
  assert.equal(f.health.length, 0)
})

test('cancellation while admission commits late never dispatches a provider request', async () => {
  const f = fixture()
  const controller = new AbortController()
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.deps.beginPlatformUsage = async (event) => {
    f.begun.push(event)
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const pending = f.reader().recognize(await request(controller.signal))
  await enteredPromise
  controller.abort()
  await assert.rejects(pending, code('CANCELLED'))
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.begun.length, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.events.length, 0)
})
