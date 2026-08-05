/**
 * V3 commercial — master-side Codex relay tests.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalCodexRelay.test.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  CODEX_OFFICIAL_UPSTREAM_BASE_URL,
  CODEX_RELAY_PREFIX,
  CODEX_UPSTREAM_AUTH_HEADER,
  buildCodexRelayLocalBaseUrl,
  codexRelayBasePathForUpstream,
  image429RetryDelayMs,
  isRelayCredentialFailureStatus,
  makeCodexRelayHandler,
  mapCodexRelayUrl,
  mapCodexRelayUrlMulti,
  parseAnnotatedImageRequest,
  promoteBailianCodexVisionToolOutputs,
  resolveCodexRelayUpstreamBases,
  type CodexRelayDb,
} from '../http/internalCodexRelay.js'

const SECRET = 'b'.repeat(64)
const TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-self', boundIp: '172.30.0.11' }
const DISPATCHER = { name: 'proxy-dispatcher' } as never

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

async function drainBody(body: unknown): Promise<string> {
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') return ''
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function makeRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return {
        id: 11,
        user_id: 42,
        bound_ip: CTX.boundIp,
        host_uuid: CTX.hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function makeDb(overrides: Partial<Awaited<ReturnType<CodexRelayDb['readContainerBinding']>>> = {}): CodexRelayDb {
  return {
    async readContainerBinding() {
      return {
        codexAccountId: 53n,
        userId: 42n,
        state: 'active',
        provider: 'codex',
        accountStatus: 'active',
        ...overrides,
      }
    },
  }
}

describe('internalCodexRelay path mapping', () => {
  test('builds a loopback base that preserves upstream base path', () => {
    assert.equal(codexRelayBasePathForUpstream('https://yunwu.ai/v1'), `${CODEX_RELAY_PREFIX}/v1`)
    assert.equal(
      buildCodexRelayLocalBaseUrl('http://127.0.0.1:18789/', 'https://yunwu.ai/v1/'),
      `http://127.0.0.1:18789${CODEX_RELAY_PREFIX}/v1`,
    )
  })

  test('maps allowed Codex endpoints to the configured upstream host', () => {
    const mapped = mapCodexRelayUrl(`${CODEX_RELAY_PREFIX}/v1/responses?stream=true`, 'POST', 'https://yunwu.ai/v1')
    assert.ok(!('error' in mapped), JSON.stringify(mapped))
    if ('error' in mapped) return
    assert.equal(mapped.url, 'https://yunwu.ai/v1/responses?stream=true')
    assert.equal(mapped.upstreamHost, 'yunwu.ai')
    assert.equal(mapped.upstreamPath, '/v1/responses')
  })

  test('rejects traversal, unknown paths, and absolute-url shaped suffixes', () => {
    for (const path of [
      `${CODEX_RELAY_PREFIX}/v1/responses/../models`,
      `${CODEX_RELAY_PREFIX}/v1/http%3A%2F%2Fevil.example%2Fresponses`,
      `${CODEX_RELAY_PREFIX}/v1/files`,
    ]) {
      const mapped = mapCodexRelayUrl(path, 'POST', 'https://yunwu.ai/v1')
      assert.ok('error' in mapped, `${path} must be rejected`)
    }
  })

  test('classifies credential-level upstream errors as relay credential failures', () => {
    for (const status of [401, 403, 429, 500, 503]) {
      assert.equal(isRelayCredentialFailureStatus(status), true, `${status} should count as credential failure`)
    }
    for (const status of [200, 201, 400, 404]) {
      assert.equal(isRelayCredentialFailureStatus(status), false, `${status} should not count as credential failure`)
    }
  })

  test('retries images only for explicit integer Retry-After up to two seconds', () => {
    const delay = (value?: string) => image429RetryDelayMs(new Headers(value === undefined ? {} : { 'retry-after': value }))
    assert.equal(delay(), null)
    assert.equal(delay('0'), 100)
    assert.equal(delay('1'), 1_000)
    assert.equal(delay('2'), 2_000)
    for (const invalid of ['3', '-1', '0.5', 'Wed, 21 Oct 2026 07:28:00 GMT', 'x']) {
      assert.equal(delay(invalid), null, invalid)
    }
  })

})

describe('Bailian Codex vision compatibility', () => {
  test('promotes captured function tool image output into a provider-supported user message', () => {
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }
    const originalToolOutput = {
      type: 'function_call_output',
      call_id: 'call-view-image',
      output: [image],
    }
    const body = Buffer.from(JSON.stringify({
      model: 'qwen3.8-max',
      input: [
        { type: 'function_call', name: 'view_image', call_id: 'call-view-image', arguments: '{}' },
        originalToolOutput,
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after' }] },
      ],
    }))

    const promoted = promoteBailianCodexVisionToolOutputs(body)
    assert.equal(promoted.promotedImageCount, 1)
    const parsed = JSON.parse(promoted.body.toString('utf8')) as { input: unknown[] }
    assert.equal(parsed.input.length, 4)
    assert.deepEqual(parsed.input[1], originalToolOutput)
    assert.deepEqual(parsed.input[2], {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'The image below is the result returned by the preceding image-view tool call.' },
        image,
      ],
    })
  })

  test('keeps non-image and malformed bodies byte-identical', () => {
    for (const body of [
      Buffer.from('{not-json'),
      Buffer.from(JSON.stringify({ model: 'qwen3.8-max', input: [{ type: 'function_call_output', output: 'text' }] })),
      Buffer.from(JSON.stringify({ model: 'qwen3.8-max', input: [{ type: 'function_call_output', output: [{ type: 'input_text', text: 'ok' }] }] })),
    ]) {
      const promoted = promoteBailianCodexVisionToolOutputs(body)
      assert.strictEqual(promoted.body, body)
      assert.equal(promoted.promotedImageCount, 0)
    }
  })
})

// ─── annotated-edits body 解析:annotated(带 mask)与 outpaint(无 mask + aspect)
// 共用 /images/annotated-edits 端点,计费同 annotated_edit。解析器必须两形态都收、
// 对形态各自的必填字段 fail-closed。────────────────────────────────────────────
describe('parseAnnotatedImageRequest(annotated / outpaint 双形态)', () => {
  const JOB = 'a'.repeat(32)
  const b = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o))
  const baseAnnotated = () => ({
    jobId: JOB, prompt: '把圈选区域改成晚霞', width: 1024, height: 768,
    sourceBase64: 'AAAA', maskBase64: 'BBBB',
  })
  const baseOutpaint = () => ({
    jobId: JOB, prompt: '把这张图调整为 16:9 宽屏构图', width: 1024, height: 768,
    sourceBase64: 'AAAA', outpaint: { aspect: '16:9' },
  })

  test('accepts a classic annotated request (mask required)', () => {
    const parsed = parseAnnotatedImageRequest(b(baseAnnotated()))
    assert.equal(parsed.maskBase64, 'BBBB')
    assert.equal(parsed.outpaint, undefined)
  })

  test('accepts an outpaint request without a mask when aspect is valid', () => {
    for (const aspect of ['16:9', '4:3', '9:16', '3:4', '1:1']) {
      const parsed = parseAnnotatedImageRequest(b({ ...baseOutpaint(), outpaint: { aspect } }))
      assert.deepEqual(parsed.outpaint, { aspect })
      assert.equal(parsed.maskBase64, undefined)
    }
  })

  test('rejects an annotated request missing its mask', () => {
    const noMask = baseAnnotated() as Record<string, unknown>
    delete noMask.maskBase64
    assert.throws(() => parseAnnotatedImageRequest(b(noMask)), /invalid annotated image request/)
  })

  test('rejects an outpaint request with an unsupported aspect', () => {
    for (const aspect of ['2:1', '16-9', '', 'square']) {
      assert.throws(
        () => parseAnnotatedImageRequest(b({ ...baseOutpaint(), outpaint: { aspect } })),
        /invalid outpaint aspect/,
        `aspect ${aspect} must be rejected`,
      )
    }
    // outpaint 存在但形状非法(非对象)
    assert.throws(() => parseAnnotatedImageRequest(b({ ...baseOutpaint(), outpaint: 'x' })), /invalid outpaint aspect/)
  })

  test('still enforces shared guards (jobId shape / prompt / pixel budget) for both shapes', () => {
    assert.throws(() => parseAnnotatedImageRequest(b({ ...baseOutpaint(), jobId: 'zzz' })), /invalid annotated image request/)
    assert.throws(() => parseAnnotatedImageRequest(b({ ...baseOutpaint(), prompt: '' })), /invalid annotated image request/)
    assert.throws(() => parseAnnotatedImageRequest(b({ ...baseOutpaint(), width: 9000, height: 9000 })), /invalid annotated image request/)
  })
})

describe('internalCodexRelay handler', () => {
  test('authenticates the container, resolves the bound account dispatcher, and relays via that dispatcher only', async () => {
    const captured: { url?: string; headers?: Headers; dispatcher?: unknown; body?: string; duplex?: string } = {}
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb(),
      upstreamBaseUrl: 'https://yunwu.ai/v1',
      resolveDispatcher: async (accountId) => ({ accountId, proxyId: 4n, dispatcher: DISPATCHER }),
      fetchImpl: (async (input, init) => {
        captured.url = String(input)
        captured.headers = new Headers(init?.headers)
        captured.dispatcher = (init as { dispatcher?: unknown }).dispatcher
        captured.body = await drainBody(init?.body)
        captured.duplex = (init as { duplex?: string }).duplex
        return new Response('relay-ok', { status: 201, headers: { 'content-type': 'text/plain' } })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => {
      void handler(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream-token',
          'content-type': 'application/json',
          'x-openclaude-evil': 'strip-me',
        },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 201)
      assert.equal(await res.text(), 'relay-ok')
      assert.equal(captured.url, 'https://yunwu.ai/v1/responses')
      assert.strictEqual(captured.dispatcher, DISPATCHER)
      assert.equal(captured.headers?.get('authorization'), 'Bearer upstream-token')
      assert.equal(captured.headers?.get('content-type'), 'application/json')
      assert.equal(captured.headers?.get('accept-encoding'), 'identity')
      assert.equal(captured.headers?.get('x-openclaude-evil'), null)
      assert.equal(captured.headers?.get(CODEX_UPSTREAM_AUTH_HEADER), null)
      assert.equal(captured.body, '{"input":"hi"}')
      assert.equal(captured.duplex, 'half')
    } finally {
      await close(server)
    }
  })



  test('route token path uses route credential API key and does not require legacy bound codex account', async () => {
    const token = 'a'.repeat(64)
    const captured: { url?: string; headers?: Headers; dispatcher?: unknown; body?: string } = {}
    const successes: string[] = []
    const failures: string[] = []
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb({ codexAccountId: null, provider: null, accountStatus: null }),
      upstreamBaseUrl: 'https://legacy.invalid/v1',
      resolveRouteContext: async (args) => {
        assert.equal(args.token, token)
        assert.equal(args.containerId, 11)
        assert.equal(args.userId, 42n)
        return {
          modelId: 'gpt-5.6-sol',
          group: { id: 9n, label: 'relay', kind: 'api_relay', provider: 'codex', enabled: true, priority: 1, models: ['gpt-5.6-sol'], created_at: new Date(), updated_at: new Date() },
          credential: {
            id: 8n,
            group_id: 9n,
            label: 'yunwu',
            base_url: 'https://yunwu.ai/v1',
            model_provider: 'api111',
            provider_name: 'Yunwu',
            wire_api: 'responses',
            preferred_auth_method: 'apikey',
            disable_response_storage: true,
            status: 'active',
            health_score: 100,
            cooldown_until: null,
            last_used_at: null,
            last_error: null,
            success_count: 0n,
            fail_count: 0n,
            created_at: new Date(),
            updated_at: new Date(),
          },
          apiKey: Buffer.from('route-api-key', 'utf8'),
        }
      },
      resolveDispatcher: async () => { throw new Error('legacy dispatcher must not be used') },
      markCredentialSuccess: async (id) => { successes.push(String(id)) },
      markCredentialFailure: async (id, err) => { failures.push(`${String(id)}:${err}`) },
      fetchImpl: (async (input, init) => {
        captured.url = String(input)
        captured.headers = new Headers(init?.headers)
        captured.dispatcher = (init as { dispatcher?: unknown }).dispatcher
        captured.body = await drainBody(init?.body)
        return new Response('route-ok', { status: 200 })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => {
      void handler(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/route/${token}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer malicious-upstream-token',
          'content-type': 'application/json',
        },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'route-ok')
      assert.equal(captured.url, 'https://yunwu.ai/v1/responses')
      assert.equal(captured.headers?.get('authorization'), 'Bearer route-api-key')
      assert.equal(captured.headers?.get(CODEX_UPSTREAM_AUTH_HEADER), null)
      assert.equal(captured.dispatcher, undefined)
      assert.equal(captured.body, '{"input":"hi"}')
      assert.deepEqual(successes, ['8'])
      assert.deepEqual(failures, [])
    } finally {
      await close(server)
    }
  })

  test('promotes vision tool output only for the qwen3.8-max Bailian Responses route', async () => {
    const token = 'd'.repeat(64)
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }
    const originalBody = JSON.stringify({
      model: 'qwen3.8-max',
      input: [{ type: 'function_call_output', call_id: 'call-image', output: [image] }],
    })
    const textOnlyBody = JSON.stringify({
      model: 'qwen3.8-max',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    })
    for (const testCase of [
      { modelId: 'qwen3.8-max', modelProvider: 'bailian', body: originalBody, expectedInputCount: 2 },
      { modelId: 'qwen3.8-max', modelProvider: 'bailian', body: textOnlyBody, expectedInputCount: 1 },
      { modelId: 'gpt-5.6-sol', modelProvider: 'api111', body: originalBody, expectedInputCount: 1 },
    ]) {
      let capturedBody = ''
      const handler = makeCodexRelayHandler({
        identityRepo: makeRepo(),
        db: makeDb({ codexAccountId: null, provider: null, accountStatus: null }),
        resolveRouteContext: async () => ({
          modelId: testCase.modelId,
          group: { id: 9n, label: 'relay', kind: 'api_relay', provider: 'codex', enabled: true, priority: 1, models: [testCase.modelId], created_at: new Date(), updated_at: new Date() },
          credential: {
            id: 8n,
            group_id: 9n,
            label: 'route',
            base_url: 'https://example.invalid/v1',
            model_provider: testCase.modelProvider,
            provider_name: 'Provider',
            wire_api: 'responses',
            preferred_auth_method: 'apikey',
            disable_response_storage: true,
            status: 'active',
            health_score: 100,
            cooldown_until: null,
            last_used_at: null,
            last_error: null,
            success_count: 0n,
            fail_count: 0n,
            created_at: new Date(),
            updated_at: new Date(),
          },
          apiKey: Buffer.from('route-api-key', 'utf8'),
        }),
        fetchImpl: (async (_input, init) => {
          capturedBody = await drainBody(init?.body)
          return new Response('ok', { status: 200 })
        }) as typeof fetch,
      })
      const server = createServer((req, res) => { void handler(req, res, CTX) })
      const port = await listen(server)
      try {
        const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/route/${token}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: testCase.body,
        })
        assert.equal(res.status, 200)
        const parsed = JSON.parse(capturedBody) as { input: unknown[] }
        assert.equal(parsed.input.length, testCase.expectedInputCount)
        if (testCase.expectedInputCount === 1) assert.equal(capturedBody, testCase.body)
      } finally {
        await close(server)
      }
    }
  })

  test('route token path marks 401/403/429 upstream responses as relay credential failures', async () => {
    for (const status of [401, 403, 429]) {
      const token = 'c'.repeat(64)
      const successes: string[] = []
      const failures: string[] = []
      const handler = makeCodexRelayHandler({
        identityRepo: makeRepo(),
        db: makeDb({ codexAccountId: null, provider: null, accountStatus: null }),
        resolveRouteContext: async () => ({
          modelId: 'gpt-5.6-sol',
          group: { id: 9n, label: 'relay', kind: 'api_relay', provider: 'codex', enabled: true, priority: 1, models: ['gpt-5.6-sol'], created_at: new Date(), updated_at: new Date() },
          credential: {
            id: 8n,
            group_id: 9n,
            label: 'yunwu',
            base_url: 'https://yunwu.ai/v1',
            model_provider: 'api111',
            provider_name: 'Yunwu',
            wire_api: 'responses',
            preferred_auth_method: 'apikey',
            disable_response_storage: true,
            status: 'active',
            health_score: 100,
            cooldown_until: null,
            last_used_at: null,
            last_error: null,
            success_count: 0n,
            fail_count: 0n,
            created_at: new Date(),
            updated_at: new Date(),
          },
          apiKey: Buffer.from('route-api-key', 'utf8'),
        }),
        markCredentialSuccess: async (id) => { successes.push(String(id)) },
        markCredentialFailure: async (id, err) => { failures.push(`${String(id)}:${err}`) },
        fetchImpl: (async () => new Response('upstream-error', { status })) as typeof fetch,
      })
      const server = createServer((req, res) => {
        void handler(req, res, CTX)
      })
      const port = await listen(server)
      try {
        const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/route/${token}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: '{"input":"hi"}',
        })
        assert.equal(res.status, status)
        assert.deepEqual(successes, [])
        assert.deepEqual(failures, [`8:http_${status}`])
      } finally {
        await close(server)
      }
    }
  })

  test('fails closed when the container has no active bound codex account', async () => {
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb({ codexAccountId: null }),
      upstreamBaseUrl: 'https://yunwu.ai/v1',
      resolveDispatcher: async () => { throw new Error('must not resolve dispatcher') },
      fetchImpl: (async () => { throw new Error('must not call upstream') }) as typeof fetch,
    })
    const server = createServer((req, res) => {
      void handler(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer upstream-token',
        },
      })
      assert.equal(res.status, 503)
      const body = await res.json() as { error: { code: string } }
      assert.equal(body.error.code, 'NO_BOUND_CODEX_ACCOUNT')
    } finally {
      await close(server)
    }
  })
})

// ─── official_oauth 数据面(feat/v5-codex-oauth-egress B5)────────────────────

describe('internalCodexRelay official chatgpt upstream(B5)', () => {
  test('official 常量与 gateway 侧 loopback base path 成对(parity 锁定)', () => {
    assert.equal(CODEX_OFFICIAL_UPSTREAM_BASE_URL, 'https://chatgpt.com/backend-api/codex')
    // gateway 侧 CODEX_OFFICIAL_RELAY_BASE_PATH 被 codexRouteOverride.test.ts 锁死为
    // 同一字面量('/internal/v3/codex-relay/backend-api/codex')。两侧测试各锁一端,
    // parity 由字面量传递保证(worktree node_modules 指向 canonical,测试不能跨包
    // import 新 export)。
    assert.equal(
      codexRelayBasePathForUpstream(CODEX_OFFICIAL_UPSTREAM_BASE_URL),
      '/internal/v3/codex-relay/backend-api/codex',
    )
  })

  test('resolveCodexRelayUpstreamBases:official 恒在、最长 base path 优先、撞路径时 official 赢', () => {
    assert.deepEqual(
      resolveCodexRelayUpstreamBases('https://yunwu.ai/v1'),
      [CODEX_OFFICIAL_UPSTREAM_BASE_URL, 'https://yunwu.ai/v1'],
    )
    // env 声称同 base path 但不同 host —— 不允许劫持 official 前缀
    assert.deepEqual(
      resolveCodexRelayUpstreamBases('https://evil.example/backend-api/codex'),
      [CODEX_OFFICIAL_UPSTREAM_BASE_URL],
    )
  })

  test('mapCodexRelayUrlMulti:official 与 env base 各自映射;official 前缀的非法 suffix 不落到 env base', () => {
    const bases = resolveCodexRelayUpstreamBases('https://yunwu.ai/v1')
    const official = mapCodexRelayUrlMulti(
      `${CODEX_RELAY_PREFIX}/backend-api/codex/responses?stream=true`, 'POST', bases,
    )
    assert.ok(!('error' in official), JSON.stringify(official))
    if (!('error' in official)) {
      assert.equal(official.url, 'https://chatgpt.com/backend-api/codex/responses?stream=true')
      assert.equal(official.upstreamHost, 'chatgpt.com')
    }
    const env = mapCodexRelayUrlMulti(`${CODEX_RELAY_PREFIX}/v1/responses`, 'POST', bases)
    assert.ok(!('error' in env))
    if (!('error' in env)) assert.equal(env.url, 'https://yunwu.ai/v1/responses')
    // official base path 命中但 suffix 不在 allowlist → 立即拒,不尝试其它 base
    const bad = mapCodexRelayUrlMulti(`${CODEX_RELAY_PREFIX}/backend-api/codex/files`, 'POST', bases)
    assert.ok('error' in bad)
    if ('error' in bad) assert.equal(bad.error.code, 'PATH_NOT_ALLOWED')
    // 两个 base 都不匹配 → NOT_FOUND
    const miss = mapCodexRelayUrlMulti(`${CODEX_RELAY_PREFIX}/v2/responses`, 'POST', bases)
    assert.ok('error' in miss)
    if ('error' in miss) assert.equal(miss.error.code, 'NOT_FOUND')
  })

  test('生图端点放行:POST /images/generations|edits 过白名单,GET 仍拒(boss 07-11 启用原生生图)', () => {
    for (const suffix of ['/images/generations', '/images/edits']) {
      const ok = mapCodexRelayUrl(`${CODEX_RELAY_PREFIX}/v1${suffix}`, 'POST', 'https://api.openai.com/v1')
      assert.ok(!('error' in ok), `POST ${suffix} must be allowed`)
      if (!('error' in ok)) assert.equal(ok.url, `https://api.openai.com/v1${suffix}`)
      const get = mapCodexRelayUrl(`${CODEX_RELAY_PREFIX}/v1${suffix}`, 'GET', 'https://api.openai.com/v1')
      assert.ok('error' in get, `GET ${suffix} must stay blocked`)
      if ('error' in get) assert.equal(get.error.code, 'PATH_NOT_ALLOWED')
    }
    // 变体/子路径不放行(白名单精确匹配,防路径漂移扩大面)。
    const sub = mapCodexRelayUrl(`${CODEX_RELAY_PREFIX}/v1/images/generations/extra`, 'POST', 'https://api.openai.com/v1')
    assert.ok('error' in sub)
    if ('error' in sub) assert.equal(sub.error.code, 'PATH_NOT_ALLOWED')
  })

  test('handler:official 路径仅透传安全的 Codex 路由头,并返回上游 turn state', async () => {
    const captured: { url?: string; headers?: Headers; dispatcher?: unknown } = {}
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb(),
      resolveDispatcher: async (accountId) => ({ accountId, proxyId: 4n, dispatcher: DISPATCHER }),
      readBoundAccountAccessToken: async () => { throw new Error('container auth present — must not read DB token') },
      fetchImpl: (async (input, init) => {
        captured.url = String(input)
        captured.headers = new Headers(init?.headers)
        captured.dispatcher = (init as { dispatcher?: unknown }).dispatcher
        return new Response('ok', {
          status: 200,
          headers: { 'x-codex-turn-state': 'returned-turn-state' },
        })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer chatgpt-access-token',
          'chatgpt-account-id': 'acc-uuid-1',
          originator: 'codex_cli_rs',
          'x-codex-turn-state': 'request-turn-state',
          'x-openai-internal-codex-responses-lite': 'true',
          'x-codex-installation-id': 'must-not-leave-relay',
          'x-unknown-client-header': 'must-not-leave-relay',
          'x-openclaude-private-test': 'must-not-leave-relay',
          'content-type': 'application/json',
        },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 200)
      assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses')
      assert.strictEqual(captured.dispatcher, DISPATCHER)
      assert.equal(captured.headers?.get('authorization'), 'Bearer chatgpt-access-token')
      assert.equal(captured.headers?.get('chatgpt-account-id'), 'acc-uuid-1')
      assert.equal(captured.headers?.get('originator'), 'codex_cli_rs')
      assert.equal(captured.headers?.get('x-codex-turn-state'), 'request-turn-state')
      assert.equal(captured.headers?.get('x-openai-internal-codex-responses-lite'), 'true')
      assert.equal(captured.headers?.has('x-codex-installation-id'), false)
      assert.equal(captured.headers?.has('x-unknown-client-header'), false)
      assert.equal(captured.headers?.has('x-openclaude-private-test'), false)
      assert.equal(res.headers.get('x-codex-turn-state'), 'returned-turn-state')
    } finally {
      await close(server)
    }
  })
})

describe('internalCodexRelay Authorization 代注 fallback(B5/3b)', () => {
  test('容器未带上游 Authorization → 按绑定账号 DB 代注,且用后清零', async () => {
    const captured: { url?: string; headers?: Headers } = {}
    const readCalls: string[] = []
    const tokenBuf = Buffer.from('db-access-token', 'utf8')
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb(),
      resolveDispatcher: async (accountId) => ({ accountId, proxyId: 4n, dispatcher: DISPATCHER }),
      readBoundAccountAccessToken: async (accountId) => {
        readCalls.push(String(accountId))
        return tokenBuf
      },
      fetchImpl: (async (input, init) => {
        captured.url = String(input)
        captured.headers = new Headers(init?.headers)
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 200)
      assert.deepEqual(readCalls, ['53'])
      assert.equal(captured.headers?.get('authorization'), 'Bearer db-access-token')
      assert.ok(tokenBuf.every((b) => b === 0), 'access token buffer 必须用后清零')
    } finally {
      await close(server)
    }
  })

  test('代注 fail-closed:token 读不到 / 读取抛错 → 503,不打上游', async () => {
    for (const readFn of [
      async () => null,
      async () => { throw new Error('decrypt failed') },
    ]) {
      const handler = makeCodexRelayHandler({
        identityRepo: makeRepo(),
        db: makeDb(),
        resolveDispatcher: async (accountId) => ({ accountId, proxyId: 4n, dispatcher: DISPATCHER }),
        readBoundAccountAccessToken: readFn as (accountId: bigint) => Promise<Buffer | null>,
        fetchImpl: (async () => { throw new Error('must not call upstream') }) as typeof fetch,
      })
      const server = createServer((req, res) => { void handler(req, res, CTX) })
      const port = await listen(server)
      try {
        const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: '{"input":"hi"}',
        })
        assert.equal(res.status, 503)
        const body = await res.json() as { error: { code: string } }
        assert.equal(body.error.code, 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE')
      } finally {
        await close(server)
      }
    }
  })

  test('容器带了 Authorization 但上游 401 → 401 原样透传,单次 fetch,绝不改用 DB token 重试', async () => {
    let fetchCount = 0
    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db: makeDb(),
      resolveDispatcher: async (accountId) => ({ accountId, proxyId: 4n, dispatcher: DISPATCHER }),
      readBoundAccountAccessToken: async () => { throw new Error('must not fall back to DB token on 401') },
      fetchImpl: (async () => {
        fetchCount += 1
        return new Response('unauthorized', { status: 401 })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer stale-container-token',
        },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 401)
      assert.equal(fetchCount, 1, '401 必须 fail-closed,不允许静默重试')
    } finally {
      await close(server)
    }
  })
})

// ─── codex 遥测辅助路径封堵(v5 feat/v5-codex-telemetry-block · nit2)──────────
//
// C1 把 chatgpt_base_url 引到容器 loopback relay 的 /backend-api/codex base 后,
// codex 残余的 backend-api 遥测/身份请求(analytics-events / agent-identity)会
// 落进 relay。它们的 suffix 不在 allowlist(/responses /chat/completions /models)
// → 必须 PATH_NOT_ALLOWED(404),且**在身份校验/dispatcher/上游 fetch 之前**就拒,
// 不 fetch、不解析代理、不 mark credential success/failure(=不产生任何计费副作用)。
describe('internalCodexRelay 遥测辅助路径 fail-closed(nit2)', () => {
  const AUX_TELEMETRY_PATHS: Array<{ method: string; path: string }> = [
    { method: 'POST', path: `${CODEX_RELAY_PREFIX}/backend-api/codex/analytics-events/events` },
    { method: 'GET', path: `${CODEX_RELAY_PREFIX}/backend-api/codex/codex-backend/agent-identity` },
    { method: 'POST', path: `${CODEX_RELAY_PREFIX}/backend-api/codex/codex-backend/agent-identity` },
    { method: 'POST', path: `${CODEX_RELAY_PREFIX}/backend-api/codex/otlp/v1/metrics` },
  ]

  test('辅助遥测路径 → 404 PATH_NOT_ALLOWED,不 fetch / 不解析 dispatcher / 不 mark credential', async () => {
    for (const { method, path } of AUX_TELEMETRY_PATHS) {
      let fetchCalls = 0
      let dispatcherCalls = 0
      const marks: string[] = []
      const handler = makeCodexRelayHandler({
        identityRepo: makeRepo(),
        db: makeDb(),
        resolveDispatcher: async (accountId) => {
          dispatcherCalls += 1
          return { accountId, proxyId: 4n, dispatcher: DISPATCHER }
        },
        readBoundAccountAccessToken: async () => { throw new Error('must not read token for a rejected telemetry path') },
        markCredentialSuccess: async (id) => { marks.push(`success:${String(id)}`) },
        markCredentialFailure: async (id, err) => { marks.push(`failure:${String(id)}:${err}`) },
        fetchImpl: (async () => { fetchCalls += 1; return new Response('nope', { status: 200 }) }) as typeof fetch,
      })
      const server = createServer((req, res) => { void handler(req, res, CTX) })
      const port = await listen(server)
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: method === 'GET' ? undefined : '{}',
        })
        assert.equal(res.status, 404, `${method} ${path} 必须 404`)
        const body = await res.json() as { error: { code: string } }
        assert.equal(body.error.code, 'PATH_NOT_ALLOWED', `${method} ${path}`)
        assert.equal(fetchCalls, 0, `${method} ${path}:绝不打上游`)
        assert.equal(dispatcherCalls, 0, `${method} ${path}:绝不解析账号 dispatcher`)
        assert.deepEqual(marks, [], `${method} ${path}:绝不 mark credential(=零计费副作用)`)
      } finally {
        await close(server)
      }
    }
  })
})
