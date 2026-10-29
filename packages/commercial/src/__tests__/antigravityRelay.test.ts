/**
 * Antigravity relay (OCV5-415 P2): route binding, method/model allowlists,
 * token injection, per-call metering, budget stop, interim pool policy and
 * settlement math. No live Google traffic.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/antigravityRelay.test.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, test } from 'node:test'

import {
  type AntigravityPoolOutcome,
  classifyAntigravityUpstream,
  parseRetryAfterMs,
  toPoolOutcome,
} from '../account-pool/antigravityPool.js'
import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import {
  _resetAntigravityRelayRoutesForTests,
  configureAntigravityRelayKv,
  expireAntigravityRelayRoute,
  expireAntigravityRelayRouteForRequest,
  mintAntigravityRelayRoute,
  resolveAntigravityRelayRoute,
} from '../billing/antigravityRouteContext.js'
import {
  type AntigravityUsageTotals,
  mapAntigravityUsage,
  planAntigravitySettle,
} from '../billing/antigravitySettle.js'
import type { ModelPricing } from '../billing/pricing.js'
import {
  ANTIGRAVITY_RELAY_PREFIX,
  ANTIGRAVITY_UPSTREAM_BASE_URL,
  type AntigravityRelayDeps,
  type AntigravityUsageRow,
  AntigravityUsageTap,
  _antigravityInflightForTests,
  makeAntigravityRelayHandler,
} from '../http/internalAntigravityRelay.js'

const SECRET = 'b'.repeat(64)
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-self', boundIp: '172.30.0.11' }
const REQUEST_ID = 'd'.repeat(32)
const FULL_TOKEN = 'ya29.full-scope-account-token'

function repo(): ContainerIdentityRepo {
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

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

async function mintRoute(
  modelId = 'antigravity-gemini-3.8-flash',
  budget = 1_000n,
): Promise<string> {
  _resetAntigravityRelayRoutesForTests()
  const minted = await mintAntigravityRelayRoute({
    containerId: 11,
    userId: 42,
    requestId: REQUEST_ID,
    modelId,
    accountId: 7n,
    budgetCredits: budget,
    relayPort: 18789,
  })
  return minted.token
}

interface Upstream {
  status: number
  headers?: Record<string, string>
  body: string[]
}

interface Captured {
  url?: string
  auth?: string
  headers?: Record<string, string>
  body?: string
  calls: number
  usage: AntigravityUsageRow[]
  outcomes: Array<{ accountId: bigint; outcome: AntigravityPoolOutcome }>
}

async function relay(
  path: string,
  init: { method?: string; body?: string; auth?: string; headers?: Record<string, string> },
  upstream: Upstream,
  extra: Partial<AntigravityRelayDeps> = {},
): Promise<{ status: number; text: string; captured: Captured }> {
  const captured: Captured = { calls: 0, usage: [], outcomes: [] }
  const handler = makeAntigravityRelayHandler({
    identityRepo: repo(),
    clientSecret: 'GOCSPX-test-secret-not-real-000',
    freshToken: async () => Buffer.from(FULL_TOKEN, 'utf8'),
    reportOutcome: async (accountId, outcome) => {
      captured.outcomes.push({ accountId, outcome })
    },
    recordUsage: async (row) => {
      captured.usage.push(row)
    },
    meteredCost: async () => 0n,
    estimateCost: () => 0n,
    requestFn: (async (url: unknown, opts: { headers?: Record<string, string>; body?: Buffer }) => {
      captured.calls += 1
      captured.url = String(url)
      captured.headers = opts.headers ?? {}
      captured.auth = opts.headers?.authorization
      captured.body = opts.body?.toString('utf8')
      return {
        statusCode: upstream.status,
        headers: upstream.headers ?? { 'content-type': 'text/event-stream' },
        body: Readable.from(upstream.body.map((chunk) => Buffer.from(chunk, 'utf8'))),
      }
    }) as never,
    ...extra,
  })
  const server = createServer((req, res) => {
    void handler(req, res, CTX)
  })
  const port = await listen(server)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        authorization: init.auth ?? `Bearer ${CONTAINER_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'antigravity/cli/1.3.4',
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    })
    return { status: res.status, text: await res.text(), captured }
  } finally {
    await close(server)
  }
}

const SSE = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"po"}]}}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ng"}]}}],"usageMetadata":{"promptTokenCount":11885,"candid',
  'atesTokenCount":1,"totalTokenCount":11914,"thoughtsTokenCount":28,"cachedContentTokenCount":9000}}}\n\n',
]

function generateBody(model: string, requestType = 'agent'): string {
  return JSON.stringify({
    model,
    project: 'p-1',
    request: { contents: [] },
    requestId: 'r',
    requestType,
    userAgent: 'antigravity',
  })
}

afterEach(() => {
  _resetAntigravityRelayRoutesForTests()
})

describe('Antigravity relay handler', () => {
  async function refuseBody(source: Readable, generate: boolean) {
    const token = await mintRoute()
    const req = Object.assign(source, {
      method: 'POST',
      url: `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:${generate ? 'streamGenerateContent?alt=sse' : 'loadCodeAssist'}`,
      headers: { authorization: `Bearer ${CONTAINER_TOKEN}` },
    })
    const res = {
      statusCode: 200, text: '',
      setHeader() {},
      end(text: string) { this.text = text },
    }
    const handler = makeAntigravityRelayHandler({
      identityRepo: repo(), clientSecret: 'test-client-secret',
      freshToken: async () => { assert.fail('body rejection must not fetch account credentials') },
      meteredCost: async () => { assert.fail('body rejection must precede billing admission') },
      recordUsage: async () => { assert.fail('body rejection must not charge') },
      reportOutcome: async () => { assert.fail('body rejection is not an upstream outcome') },
      requestFn: (async () => { assert.fail('body rejection must not forward') }) as never,
    })
    await handler(req as any, res as any, CTX)
    assert.equal(_antigravityInflightForTests().has(token), false)
    return res
  }

  test('OCV5-659 relay stream failures do not become size errors or reserve credits', async () => {
    for (const generate of [false, true]) {
      const req = Readable.from((async function* () {
        yield Buffer.from('{"partial":')
        throw Object.assign(new Error('private payload must not escape'), { code: 'ECONNRESET', status: 413 })
      })())
      const res = await refuseBody(req, generate)
      assert.equal(res.statusCode, 400)
      assert.equal(JSON.parse(res.text).error.code, 'REQUEST_BODY_READ_FAILED')
      assert.doesNotMatch(res.text, /BODY_TOO_LARGE|private payload/)
    }
  })

  test('OCV5-659 relay metadata and generate byte caps still reject before billing', async () => {
    for (const generate of [false, true]) {
      const chunk = Buffer.alloc(64 * 1024)
      const chunks = (generate ? 32 : 1) * 16
      const req = Readable.from((function* () {
        for (let i = 0; i < chunks; i++) yield chunk
        yield Buffer.from('x')
      })())
      const res = await refuseBody(req, generate)
      assert.equal(res.statusCode, 413)
      assert.equal(JSON.parse(res.text).error.code, 'BODY_TOO_LARGE')
    }
  })

  test('generate call: injects the account token, streams, and meters usageMetadata', async () => {
    const token = await mintRoute()
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      {
        body: generateBody('gemini-3.8-flash-high'),
        // the trace header (OCV5-569) must not be among the forwarded keys below
        headers: { 'x-goog-api-key': 'nope', cookie: 'a=b', 'x-openclaude-trace-id': '0a1b2c3d4e5f60718293a4b5c6d7e8f9' },
      },
      { status: 200, body: SSE },
    )
    assert.equal(status, 200)
    assert.equal(text, SSE.join(''))
    assert.equal(
      captured.url,
      `${ANTIGRAVITY_UPSTREAM_BASE_URL}/v1internal:streamGenerateContent?alt=sse`,
    )
    assert.equal(captured.auth, `Bearer ${FULL_TOKEN}`)
    // Only the allowlisted headers survive (fetch adds `accept` itself).
    assert.deepEqual(Object.keys(captured.headers ?? {}).sort(), [
      'accept',
      'authorization',
      'content-type',
      'user-agent',
    ])
    assert.equal(JSON.parse(captured.body ?? '{}').model, 'gemini-3.8-flash-high')
    assert.match(captured.usage[0]?.callId ?? '', /^[0-9a-f-]{36}$/)
    assert.deepEqual(
      captured.usage.map(({ callId: _c, ...rest }) => rest),
      [
        {
          requestId: REQUEST_ID,
          userId: 42n,
          accountId: 7n,
          routeModelId: 'antigravity-gemini-3.8-flash',
          upstreamModel: 'gemini-3.8-flash-high',
          requestType: 'agent',
          statusCode: 200,
          promptTokens: 11885,
          candidatesTokens: 1,
          thoughtsTokens: 28,
          cachedTokens: 9000,
        },
      ],
    )
    assert.deepEqual(captured.outcomes, [{ accountId: 7n, outcome: { kind: 'success' } }])
  })

  test('a transient usage-row write failure is retried, not left unbilled', async () => {
    const token = await mintRoute()
    const seen: string[] = []
    let attempts = 0
    const rows: AntigravityUsageRow[] = []
    const { status } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: SSE },
      {
        recordUsage: async (row) => {
          attempts += 1
          seen.push(row.callId)
          if (attempts < 3) throw new Error('pg blip')
          rows.push(row)
        },
      },
    )
    assert.equal(status, 200)
    assert.equal(attempts, 3)
    assert.equal(rows.length, 1)
    // Every retry carries the same call id, so the idempotent insert cannot double-count.
    assert.equal(new Set(seen).size, 1)
  })

  test('title generation model is allowed and metered on the turn', async () => {
    const token = await mintRoute('antigravity-claude-sonnet-5.5')
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.5-flash-lite', 'checkpoint') },
      { status: 200, body: SSE },
    )
    assert.equal(status, 200)
    assert.equal(captured.usage[0]?.upstreamModel, 'gemini-3.5-flash-lite')
    assert.equal(captured.usage[0]?.routeModelId, 'antigravity-claude-sonnet-5.5')
  })

  test('web search: non-streaming generateContent is forwarded and metered from its JSON body', async () => {
    const token = await mintRoute()
    const json = JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: 'results' }] } }],
        usageMetadata: {
          promptTokenCount: 900,
          candidatesTokenCount: 120,
          thoughtsTokenCount: 10,
          cachedContentTokenCount: 0,
        },
      },
    })
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:generateContent`,
      { body: generateBody('gemini-3.5-flash-lite', 'web_search') },
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: [json.slice(0, 40), json.slice(40)],
      },
    )
    assert.equal(status, 200)
    assert.equal(text, json)
    assert.equal(captured.url, `${ANTIGRAVITY_UPSTREAM_BASE_URL}/v1internal:generateContent`)
    assert.equal(captured.usage.length, 1)
    assert.equal(captured.usage[0]?.requestType, 'web_search')
    assert.equal(captured.usage[0]?.upstreamModel, 'gemini-3.5-flash-lite')
    assert.equal(captured.usage[0]?.promptTokens, 900)
    assert.equal(captured.usage[0]?.candidatesTokens, 120)
    assert.equal(captured.usage[0]?.thoughtsTokens, 10)
  })

  test('generateContent takes no query; streamGenerateContent still requires alt=sse', async () => {
    const token = await mintRoute()
    const withQuery = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:generateContent?alt=sse`,
      { body: generateBody('gemini-3.5-flash-lite', 'web_search') },
      { status: 200, body: ['{}'] },
    )
    assert.equal(withQuery.status, 400)
    assert.equal(withQuery.captured.calls, 0)
    const noSse = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent`,
      { body: generateBody('gemini-3.8-flash-high') },
      { status: 200, body: SSE },
    )
    assert.equal(noSse.status, 400)
    assert.equal(noSse.captured.calls, 0)
    const otherModel = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:generateContent`,
      { body: generateBody('claude-opus-4-6-thinking', 'web_search') },
      { status: 200, body: ['{}'] },
    )
    assert.equal(otherModel.status, 403)
  })

  test('refuses a model outside the route allowlist before calling Google', async () => {
    const token = await mintRoute('antigravity-gemini-3.8-flash')
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('claude-opus-4-6-thinking') },
      { status: 200, body: SSE },
    )
    assert.equal(status, 403)
    assert.match(text, /ANTIGRAVITY_MODEL_NOT_ALLOWED/)
    assert.equal(captured.calls, 0)
  })

  test('stops new generate calls once metered cost reaches the admission budget', async () => {
    const token = await mintRoute('antigravity-gemini-3.8-flash', 50n)
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: SSE },
      { meteredCost: async () => 50n },
    )
    assert.equal(status, 402)
    assert.match(text, /ANTIGRAVITY_BUDGET_EXHAUSTED/)
    assert.equal(captured.calls, 0)
  })

  test('fails closed when pricing is not loaded (no unmetered calls)', async () => {
    const token = await mintRoute()
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: SSE },
      { meteredCost: async () => null },
    )
    assert.equal(status, 503)
    assert.equal(captured.calls, 0)
  })

  test('metadata calls pass through without metering; unknown methods are refused', async () => {
    const token = await mintRoute()
    const ok = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`,
      { body: '{"metadata":{"ideType":"ANTIGRAVITY"}}' },
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'x=y' },
        body: ['{"currentTier":{}}'],
      },
    )
    assert.equal(ok.status, 200)
    assert.equal(ok.text, '{"currentTier":{}}')
    assert.equal(ok.captured.usage.length, 0)
    assert.equal(ok.captured.body, '{"metadata":{"ideType":"ANTIGRAVITY"}}')

    for (const method of ['onboardUser', 'generateChat', 'setUserSettings']) {
      const refused = await relay(
        `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:${method}`,
        { body: '{}' },
        { status: 200, body: ['{}'] },
      )
      assert.equal(refused.status, 405, method)
      assert.equal(refused.captured.calls, 0, method)
    }
    const query = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist?key=x`,
      { body: '{}' },
      { status: 200, body: ['{}'] },
    )
    assert.equal(query.status, 400)
  })

  test('requires container identity and a live route bound to that container', async () => {
    const token = await mintRoute()
    const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`
    const noAuth = await relay(
      path,
      { body: '{}', auth: 'Bearer ya29.limited-cli-token' },
      { status: 200, body: ['{}'] },
    )
    assert.equal(noAuth.status, 401)
    assert.equal(noAuth.captured.calls, 0)
    await expireAntigravityRelayRoute(token)
    const expired = await relay(path, { body: '{}' }, { status: 200, body: ['{}'] })
    assert.equal(expired.status, 404)
    assert.equal(expired.captured.calls, 0)
  })

  test('429 from Google is reported to the pool and passed to the CLI', async () => {
    const token = await mintRoute()
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-high') },
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '40' },
        body: ['{"error":{"code":429}}'],
      },
    )
    assert.equal(status, 429)
    assert.deepEqual(captured.outcomes, [
      { accountId: 7n, outcome: { kind: 'rate_limited', retryAfterMs: 40_000 } },
    ])
    assert.equal(captured.usage[0]?.statusCode, 429)
    assert.equal(captured.usage[0]?.promptTokens, 0)
  })

  test('a generate 5xx cools only the route model, never the account (OCV5-415)', async () => {
    const cases: Array<{
      label: string
      model: string
      path: string
      body: string
      status: number
      outcome: AntigravityPoolOutcome['kind']
      modelOutcome: Array<[bigint, string, boolean]>
    }> = [
      {
        label: 'GPT-OSS no capacity',
        model: 'antigravity-gpt-oss-120b',
        path: 'streamGenerateContent?alt=sse',
        body: generateBody('gpt-oss-120b-medium'),
        status: 503,
        outcome: 'model_unavailable',
        modelOutcome: [[7n, 'antigravity-gpt-oss-120b', false]],
      },
      {
        label: 'title model 5xx is not the turn model',
        model: 'antigravity-gpt-oss-120b',
        path: 'streamGenerateContent?alt=sse',
        body: generateBody('gemini-3.5-flash-lite', 'checkpoint'),
        status: 500,
        outcome: 'model_unavailable',
        modelOutcome: [],
      },
      {
        label: 'metadata 5xx stays account-level',
        model: 'antigravity-gpt-oss-120b',
        path: 'loadCodeAssist',
        body: '{}',
        status: 503,
        outcome: 'upstream_error',
        modelOutcome: [],
      },
      {
        label: 'generate success clears the model strikes',
        model: 'antigravity-gemini-3.8-flash',
        path: 'streamGenerateContent?alt=sse',
        body: generateBody('gemini-3.8-flash-high'),
        status: 200,
        outcome: 'success',
        modelOutcome: [[7n, 'antigravity-gemini-3.8-flash', true]],
      },
      {
        label: '429 stays account-level',
        model: 'antigravity-gemini-3.8-flash',
        path: 'streamGenerateContent?alt=sse',
        body: generateBody('gemini-3.8-flash-high'),
        status: 429,
        outcome: 'rate_limited',
        modelOutcome: [],
      },
    ]
    for (const c of cases) {
      const token = await mintRoute(c.model)
      const modelOutcome: Array<[bigint, string, boolean]> = []
      const { status, captured } = await relay(
        `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:${c.path}`,
        { body: c.body },
        {
          status: c.status,
          headers: { 'content-type': 'application/json' },
          body: c.status === 200 ? SSE : ['{"error":{"code":%d}}'.replace('%d', String(c.status))],
        },
        {
          reportModelOutcome: async (accountId, modelId, ok) => {
            modelOutcome.push([accountId, modelId, ok])
          },
        },
      )
      assert.equal(status, c.status, c.label)
      assert.deepEqual(
        captured.outcomes.map((o) => o.outcome.kind),
        [c.outcome],
        c.label,
      )
      assert.deepEqual(modelOutcome, c.modelOutcome, c.label)
    }
  })

  test('not configured → 503 without touching Google', async () => {
    const token = await mintRoute()
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`,
      { body: '{}' },
      { status: 200, body: ['{}'] },
      { clientSecret: '' },
    )
    assert.equal(status, 503)
    assert.equal(captured.calls, 0)
  })
})

describe('Antigravity relay concurrent budget (Codex r1 P1)', () => {
  async function concurrent(opts: {
    budget: bigint
    n: number
    extra: Partial<AntigravityRelayDeps>
  }): Promise<{ statuses: number[]; calls: number }> {
    const token = await mintRoute('antigravity-gemini-3.8-flash', opts.budget)
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = makeAntigravityRelayHandler({
      identityRepo: repo(),
      clientSecret: 'GOCSPX-test-secret-not-real-000',
      freshToken: async () => Buffer.from(FULL_TOKEN, 'utf8'),
      reportOutcome: async () => {},
      recordUsage: async () => {},
      meteredCost: async () => 0n,
      requestFn: (async () => {
        calls += 1
        await gate
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: Readable.from([Buffer.from(SSE.join(''))]),
        }
      }) as never,
      ...opts.extra,
    })
    const server = createServer((req, res) => {
      void handler(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`
      const pending = Array.from({ length: opts.n }, () =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${CONTAINER_TOKEN}`,
            'content-type': 'application/json',
          },
          body: generateBody('gemini-3.8-flash-low'),
        }).then(async (res) => {
          await res.text()
          return res.status
        }),
      )
      // Let every request reach the admission check before any upstream call finishes.
      await new Promise((resolve) => setTimeout(resolve, 300))
      release()
      return { statuses: await Promise.all(pending), calls }
    } finally {
      await close(server)
    }
  }

  test('16 simultaneous calls on a 1-credit route: one runs, the rest are refused before Google', async () => {
    const { statuses, calls } = await concurrent({
      budget: 1n,
      n: 16,
      extra: { estimateCost: () => 10n },
    })
    assert.equal(calls, 1)
    assert.equal(statuses.filter((code) => code === 200).length, 1)
    assert.equal(statuses.filter((code) => code === 402).length, 15)
  })

  test('calls that fit the budget run concurrently up to the per-route cap', async () => {
    const { statuses, calls } = await concurrent({
      budget: 1_000_000n,
      n: 7,
      extra: { estimateCost: () => 1n },
    })
    assert.equal(calls, 4)
    assert.equal(statuses.filter((code) => code === 200).length, 4)
    assert.equal(statuses.filter((code) => code === 429).length, 3)
  })

  test("a finished call's cost counts even when the DB total read raced its insert", async () => {
    const token = await mintRoute('antigravity-gemini-3.8-flash', 50n)
    const deps: Partial<AntigravityRelayDeps> = {
      meteredCost: async () => 0n,
      estimateCost: () => 1n,
      totalsCost: (_route, totals) => BigInt(totals.calls) * 100n,
    }
    const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`
    // relay() builds a fresh handler each call; the in-flight table is module-level, like production.
    const first = await relay(
      path,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: SSE },
      deps,
    )
    assert.equal(first.status, 200)
    const second = await relay(
      path,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: SSE },
      deps,
    )
    assert.equal(second.status, 402)
    assert.equal(second.captured.calls, 0)
  })
})

describe('Antigravity relay downstream close (OCV5-411 Codex r1 P1)', () => {
  test('a CLI that disconnects under backpressure does not hang the call: usage is metered, the reservation freed', async () => {
    const token = await mintRoute('antigravity-gemini-3.8-flash', 1_000_000n)
    const usage: AntigravityUsageRow[] = []
    const refreshed: string[] = []
    let handlerDone!: () => void
    const finished = new Promise<void>((resolve) => {
      handlerDone = resolve
    })
    // 16 MiB the client never reads: res.write returns false and no drain follows.
    const pad = Buffer.from(`: ${'x'.repeat(16 * 1024 * 1024)}\n\n`, 'utf8')
    async function* upstreamBody() {
      yield pad
      await new Promise((resolve) => setTimeout(resolve, 200))
      for (const chunk of SSE) yield Buffer.from(chunk, 'utf8')
    }
    const handler = makeAntigravityRelayHandler({
      identityRepo: repo(),
      clientSecret: 'GOCSPX-test-secret-not-real-000',
      freshToken: async () => Buffer.from(FULL_TOKEN, 'utf8'),
      reportOutcome: async () => {},
      recordUsage: async (row) => {
        usage.push(row)
      },
      refreshWaived: async (route) => {
        refreshed.push(route.requestId)
      },
      meteredCost: async () => 0n,
      estimateCost: () => 1n,
      requestFn: (async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Readable.from(upstreamBody()),
      })) as never,
    })
    const server = createServer((req, res) => {
      void handler(req, res, CTX).finally(handlerDone)
    })
    const port = await listen(server)
    try {
      const abort = new AbortController()
      const res = await fetch(
        `http://127.0.0.1:${port}${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${CONTAINER_TOKEN}`, 'content-type': 'application/json' },
          body: generateBody('gemini-3.8-flash-low'),
          signal: abort.signal,
        },
      )
      assert.equal(res.status, 200)
      abort.abort()
      let timer: NodeJS.Timeout | undefined
      const outcome = await Promise.race([
        finished.then(() => 'finished'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('hung'), 5000)
        }),
      ])
      clearTimeout(timer)
      assert.equal(outcome, 'finished', 'handler parked on a drain that never comes')
      assert.equal(usage.length, 1, 'the abandoned call is still metered')
      assert.equal(usage[0]?.promptTokens, 11885)
      const slot = _antigravityInflightForTests().get(token)
      assert.equal(slot?.count, 0, 'in-flight slot released')
      assert.equal(slot?.reserved, 0n, 'reservation released')
      assert.equal(slot?.recorded.calls, 1)
      // The Stop may have settled the turn first: the late row is folded into it (OCV5-451).
      assert.equal(refreshed.length, 1)
      assert.equal(refreshed[0], usage[0]?.requestId)
    } finally {
      server.closeAllConnections()
      await close(server)
    }
  })
})

describe('Antigravity relay budget rounding (Codex r2 P1)', () => {
  test('small serial calls are summed before rounding, like settlement', async () => {
    const pricing = {
      model_id: 'antigravity-gemini-3.8-flash',
      display_name: 'x',
      input_per_mtok: 120n,
      output_per_mtok: 150n,
      cache_read_per_mtok: 5n,
      cache_write_per_mtok: 0n,
      multiplier: '1.000',
      enabled: true,
    } as unknown as ModelPricing
    const token = await mintRoute('antigravity-gemini-3.8-flash', 2n)
    const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`
    const small = [
      'data: {"response":{"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10}}}\n\n',
    ]
    const deps: Partial<AntigravityRelayDeps> = {
      pricing: { get: () => pricing },
      meteredCost: async () => 0n,
      estimateCost: undefined,
    }
    // Each call alone rounds up to 1 credit; three together are still 1.
    for (let i = 0; i < 3; i++) {
      const res = await relay(
        path,
        { body: generateBody('gemini-3.8-flash-low') },
        { status: 200, body: small },
        deps,
      )
      assert.equal(res.status, 200, `call ${i + 1}`)
    }
  })
})

describe('Antigravity route context', () => {
  test('expire by requestId works in memory and through the shared KV', async () => {
    const token = await mintRoute()
    await expireAntigravityRelayRouteForRequest('e'.repeat(32))
    assert.ok(await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 42 }))
    await expireAntigravityRelayRouteForRequest(REQUEST_ID)
    assert.equal(await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 42 }), null)

    const store = new Map<string, string>()
    configureAntigravityRelayKv({
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v)
      },
      del: async (k) => {
        store.delete(k)
      },
    })
    const minted = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-3.8-flash',
      accountId: 7n,
      budgetCredits: 1_000n,
      relayPort: 18789,
    })
    assert.equal(store.size, 2)
    assert.ok(
      await resolveAntigravityRelayRoute({ token: minted.token, containerId: 11, userId: 42 }),
    )
    await expireAntigravityRelayRouteForRequest(REQUEST_ID)
    // Only the request's expired mark is left (it fences late renewals).
    assert.deepEqual([...store.values()], ['expired'])
    assert.equal(
      await resolveAntigravityRelayRoute({ token: minted.token, containerId: 11, userId: 42 }),
      null,
    )
  })

  // OCV5-556: an 82-minute turn outlived the fixed 60-minute route; the CLI's
  // next call 404'd ROUTE_EXPIRED and the turn ended with no reply.
  test('a route in use slides past the idle window, up to the lifetime cap', async () => {
    _resetAntigravityRelayRoutesForTests()
    const minute = 60_000
    const { token } = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-3.8-flash',
      accountId: 7n,
      budgetCredits: 1_000n,
      relayPort: 18789,
      nowMs: 0,
    })
    const at = (m: number) =>
      resolveAntigravityRelayRoute({ token, containerId: 11, userId: 42, nowMs: m * minute })
    assert.equal((await at(20))?.expiresAt, 60 * minute, 'more than half left: no renewal')
    assert.equal((await at(40))?.expiresAt, 100 * minute)
    assert.ok(await at(95), 'past the original 60 minutes while in use')
    for (let m = 130; m < 360; m += 50) assert.ok(await at(m), `minute ${m}`)
    assert.equal((await at(359))?.expiresAt, 360 * minute, 'capped at the lifetime')
    assert.equal(await at(361), null)

    _resetAntigravityRelayRoutesForTests()
    const idle = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-3.8-flash',
      accountId: 7n,
      budgetCredits: 1_000n,
      relayPort: 18789,
      nowMs: 0,
    })
    assert.equal(
      await resolveAntigravityRelayRoute({
        token: idle.token,
        containerId: 11,
        userId: 42,
        nowMs: 61 * minute,
      }),
      null,
      'an unused route still expires after the idle window',
    )
  })

  test('KV renewal: refreshes the token key, never revives a route the turn end expired', async () => {
    const minute = 60_000
    const store = new Map<string, { value: string; ttlSec: number }>()
    let beforeTokenRead: (() => Promise<void>) | null = null
    configureAntigravityRelayKv({
      get: async (k) => {
        const hit = store.get(k)?.value ?? null
        if (beforeTokenRead && !k.includes(':req:')) {
          const hook = beforeTokenRead
          beforeTokenRead = null
          await hook()
        }
        return hit
      },
      set: async (k, value, ttlSec) => {
        store.set(k, { value, ttlSec })
      },
      del: async (k) => {
        store.delete(k)
      },
    })
    const { token } = await mintAntigravityRelayRoute({
      containerId: 11,
      userId: 42,
      requestId: REQUEST_ID,
      modelId: 'antigravity-gemini-3.8-flash',
      accountId: 7n,
      budgetCredits: 1_000n,
      relayPort: 18789,
      nowMs: 0,
    })
    const tokenEntry = () => [...store.entries()].find(([k]) => !k.includes(':req:'))?.[1]
    const requestEntry = () => [...store.entries()].find(([k]) => k.includes(':req:'))?.[1]
    assert.equal(tokenEntry()?.ttlSec, 3600)
    assert.equal(requestEntry()?.ttlSec, 6 * 3600, 'request key outlives every renewal')

    const renewed = await resolveAntigravityRelayRoute({
      token,
      containerId: 11,
      userId: 42,
      nowMs: 45 * minute,
    })
    assert.equal(renewed?.expiresAt, 105 * minute)
    assert.equal(tokenEntry()?.ttlSec, 3600)
    assert.equal(JSON.parse(tokenEntry()!.value).expiresAt, 105 * minute)

    const [staleKey, staleEntry] = [...store.entries()].find(([k]) => !k.includes(':req:'))!
    const staleRow = staleEntry.value
    // The turn ends while a call that read the route is about to renew it.
    beforeTokenRead = () => expireAntigravityRelayRouteForRequest(REQUEST_ID)
    assert.equal(
      await resolveAntigravityRelayRoute({
        token,
        containerId: 11,
        userId: 42,
        nowMs: 80 * minute,
      }),
      null,
    )
    assert.equal(tokenEntry(), undefined, 'the racing renewal did not leave the route behind')

    // Codex r1 P1: a second call that lands while a racing renewal has the
    // token key written back must still be refused.
    const raw = JSON.stringify({ ...JSON.parse(staleRow), expiresAt: 200 * minute })
    store.set(staleKey, { value: raw, ttlSec: 3600 })
    assert.equal(
      await resolveAntigravityRelayRoute({
        token,
        containerId: 11,
        userId: 42,
        nowMs: 82 * minute,
      }),
      null,
      'a call during the renewal window is not served after the turn ended',
    )
    assert.equal(store.has(staleKey), false)
    assert.equal(
      await resolveAntigravityRelayRoute({
        token,
        containerId: 11,
        userId: 42,
        nowMs: 81 * minute,
      }),
      null,
    )
  })

  test('binds container, user, account and budget; rejects other containers', async () => {
    const token = await mintRoute('antigravity-gpt-oss-120b', 77n)
    const route = await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 42 })
    assert.equal(route?.accountId, 7n)
    assert.equal(route?.budgetCredits, 77n)
    assert.equal(route?.modelId, 'antigravity-gpt-oss-120b')
    assert.equal(await resolveAntigravityRelayRoute({ token, containerId: 12, userId: 42 }), null)
    assert.equal(await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 43 }), null)
  })

  test('refuses non-Antigravity models and empty budgets', async () => {
    const base = {
      containerId: 11,
      userId: 42,
      requestId: REQUEST_ID,
      accountId: 7n,
      relayPort: 18789,
    }
    await assert.rejects(
      mintAntigravityRelayRoute({ ...base, modelId: 'glm-5.3-zai', budgetCredits: 5n }),
      /not allowlisted/,
    )
    await assert.rejects(
      mintAntigravityRelayRoute({
        ...base,
        modelId: 'antigravity-gemini-3.8-flash',
        budgetCredits: 0n,
      }),
      /budget/,
    )
  })
})

describe('AntigravityUsageTap', () => {
  test('json mode reads usageMetadata from one response body, also when it outgrows the buffer', () => {
    const tap = new AntigravityUsageTap('json')
    tap.push('{"response":{"candidates":[],')
    tap.push('"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}}')
    tap.end()
    assert.deepEqual(tap.usage, { prompt: 5, candidates: 2, thoughts: 0, cached: 0 })
    const big = new AntigravityUsageTap('json')
    big.push(
      `{"response":{"candidates":[{"content":{"parts":[{"text":"${'x'.repeat(17 * 1024 * 1024)}"}]}}],`,
    )
    big.push(
      '"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"cachedContentTokenCount":1}}}',
    )
    big.end()
    assert.deepEqual(big.usage, { prompt: 7, candidates: 3, thoughts: 0, cached: 1 })
  })

  test('keeps the last usageMetadata across chunk boundaries and ignores non-data lines', () => {
    const tap = new AntigravityUsageTap()
    for (const chunk of SSE) tap.push(chunk)
    tap.push(': keepalive\n')
    tap.end()
    assert.deepEqual(tap.usage, { prompt: 11885, candidates: 1, thoughts: 28, cached: 9000 })
  })

  test('an unterminated last event is still read at end', () => {
    const tap = new AntigravityUsageTap()
    tap.push('data: {"response":{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}}')
    tap.end()
    assert.deepEqual(tap.usage, { prompt: 5, candidates: 2, thoughts: 0, cached: 0 })
  })
})

describe('Antigravity pool outcomes (shared OCV5-424 policy)', () => {
  const now = 1_000_000

  test('account-level outcomes map onto the shared pool outcome unchanged', () => {
    const resetAt = new Date(now + 3_600_000)
    assert.deepEqual(toPoolOutcome({ kind: 'success' }, null), { kind: 'success' })
    assert.deepEqual(toPoolOutcome({ kind: 'rate_limited', retryAfterMs: 7_000 }, 'x'), {
      kind: 'rate_limited',
      retryAfterMs: 7_000,
    })
    assert.deepEqual(toPoolOutcome({ kind: 'quota_exhausted', resetAt }, 'x'), {
      kind: 'quota_exhausted',
      resetAt,
    })
    assert.deepEqual(toPoolOutcome({ kind: 'auth_invalid' }, 'antigravity_http_401'), {
      kind: 'auth_invalid',
      detail: 'antigravity_http_401',
    })
    assert.deepEqual(toPoolOutcome({ kind: 'upstream_error' }, 'antigravity_http_502'), {
      kind: 'upstream_error',
      detail: 'antigravity_http_502',
    })
    assert.deepEqual(toPoolOutcome({ kind: 'client_error' }, null), { kind: 'client_error', detail: null })
    assert.deepEqual(toPoolOutcome({ kind: 'network' }, null), { kind: 'network', detail: null })
  })

  test('classification and Retry-After parsing', () => {
    assert.deepEqual(classifyAntigravityUpstream(200, {}, now), { kind: 'success' })
    assert.deepEqual(classifyAntigravityUpstream(429, {}, now), {
      kind: 'rate_limited',
      retryAfterMs: null,
    })
    assert.deepEqual(classifyAntigravityUpstream(403, {}, now), { kind: 'auth_invalid' })
    assert.deepEqual(classifyAntigravityUpstream(503, {}, now), { kind: 'upstream_error' })
    assert.deepEqual(classifyAntigravityUpstream(400, {}, now), { kind: 'client_error' })
    assert.equal(parseRetryAfterMs('7', now), 7_000)
    assert.equal(parseRetryAfterMs(new Date(now + 9_000).toUTCString(), now) !== null, true)
    assert.equal(parseRetryAfterMs('soon', now), null)
  })
})

describe('Antigravity settlement math', () => {
  const pricing = {
    model_id: 'antigravity-gemini-3.8-flash',
    display_name: 'Gemini 3.8 Flash (Antigravity)',
    input_per_mtok: 120n,
    output_per_mtok: 150n,
    cache_read_per_mtok: 5n,
    cache_write_per_mtok: 0n,
    multiplier: '1.000',
    enabled: true,
  } as unknown as ModelPricing
  const totals: AntigravityUsageTotals = {
    promptTokens: 12_008n,
    candidatesTokens: 4n,
    thoughtsTokens: 28n,
    cachedTokens: 9_000n,
    calls: 2,
  }

  test('cached tokens come out of prompt; thoughts bill as output', () => {
    assert.deepEqual(mapAntigravityUsage(totals), {
      input_tokens: 3_008n,
      output_tokens: 32n,
      cache_read_tokens: 9_000n,
      cache_write_tokens: 0n,
    })
  })

  test('only a successful turn with output is charged', () => {
    const ok = planAntigravitySettle({ engineStatus: 'success', totals, pricing })
    assert.ok(ok.costCredits > 0n)
    assert.equal(ok.settleStatus, 'success')
    const failed = planAntigravitySettle({
      engineStatus: 'error',
      totals,
      pricing,
      terminalCode: 'ENGINE_ERROR',
    })
    assert.equal(failed.costCredits, 0n)
    assert.match(failed.snapshotJson, /antigravity_engine_not_success/)
    const silent = planAntigravitySettle({
      engineStatus: 'success',
      totals: { ...totals, candidatesTokens: 0n, thoughtsTokens: 0n },
      pricing,
    })
    assert.equal(silent.costCredits, 0n)
    assert.match(silent.snapshotJson, /no_output/)
  })
})


describe('Google retirement banners are errors, never successful paid answers (OCV5-515)', () => {
  const notice = 'Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.'
  const event = (text: string, complete = false) => `data: ${JSON.stringify({ response: {
    candidates: [{ content: { parts: [{ text }] }, ...(complete ? { finishReason: 'STOP' } : {}) }],
    ...(complete ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } } : {}),
  } })}\n\n`

  test('a banner split between SSE events/chunks becomes 410 before any answer is forwarded', async () => {
    const token = await mintRoute()
    const wire = event(notice.slice(0, 21)) + event(notice.slice(21))
    const result = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-low') },
      { status: 200, body: [wire.slice(0, 17), wire.slice(17, 99), wire.slice(99)] },
    )
    assert.equal(result.status, 410)
    assert.match(result.text, /ANTIGRAVITY_MODEL_RETIRED/)
    assert.ok(!result.text.includes('Please switch'))
    assert.equal(result.captured.usage[0]?.statusCode, 410)
    assert.ok(!result.captured.outcomes.some((x) => x.outcome.kind === 'success'))
  })

  test('a normal completed answer quoting exactly the banner remains successful', async () => {
    const token = await mintRoute()
    const wire = event(notice, true)
    const result = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody('gemini-3.8-flash-low') }, { status: 200, body: [wire] },
    )
    assert.equal(result.status, 200)
    assert.equal(result.text, wire)
    assert.equal(result.captured.usage[0]?.statusCode, 200)
  })

  test('JSON retirement banners are errors too; title usage cannot make the turn billable', async () => {
    const token = await mintRoute()
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: notice }] } }] } })
    const result = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:generateContent`,
      { body: generateBody('gemini-3.5-flash-lite', 'web_search') }, { status: 200, body: [body] },
    )
    assert.equal(result.status, 410)
    const plan = planAntigravitySettle({ engineStatus: 'success',
      totals: { promptTokens: 1000n, candidatesTokens: 50n, thoughtsTokens: 0n, cachedTokens: 0n, calls: 2, retired: true },
      pricing: { input_per_mtok: 100n, output_per_mtok: 500n, cache_read_per_mtok: 5n, cache_write_per_mtok: 0n, multiplier: '2' } as ModelPricing,
    })
    assert.equal(plan.costCredits, 0n)
    assert.equal(plan.settleStatus, 'error')
    assert.equal(JSON.parse(plan.snapshotJson).antigravity_terminal_code, 'ANTIGRAVITY_MODEL_RETIRED')
  })
})
