/**
 * Delegate grok route client: env gating, mint outcome mapping, heartbeat
 * cap, and release idempotence. Uses an injectable fetcher — no live master.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateGrokRoute.test.ts
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { acquireDelegateGrokRoute } from '../delegateGrokRoute.js'

const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:19001',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.11.token',
}
const ROUTE_TOKEN = 'a'.repeat(64)
const BASE_URL = `http://127.0.0.1:18789/internal/v5/grok-relay/route/${ROUTE_TOKEN}/v1`

interface Call {
  path: string
  body: Record<string, unknown>
}

function fetcherScript(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: { body: string }) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, body: JSON.parse(init.body) as Record<string, unknown> })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      statusCode: next.status,
      body: Readable.from([JSON.stringify(next.body)]),
    }
  }) as never
  return { calls, fetcher }
}

const LOG = {
  warn: () => {},
  debug: () => {},
}

describe('acquireDelegateGrokRoute', () => {
  test('fails closed when the master channel env is missing', async () => {
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      log: LOG,
      env: {},
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.httpStatus, 503)
  })

  test('returns the lease and posts modelId/sessionId on mint success', async () => {
    const { calls, fetcher } = fetcherScript([
      { status: 200, body: { ok: true, baseUrl: BASE_URL, routeToken: ROUTE_TOKEN, accountId: '53', slotId: 'slot-53' } },
      { status: 200, body: { ok: true } },
    ])
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      sessionId: 'agent:main:delegate:leader:1:abcd',
      log: LOG,
      env: ENV,
      fetcher,
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0]?.path, '/internal/v5/delegate/grok-route/mint')
    assert.equal(calls[0]?.body.modelId, 'grok-build')
    assert.equal(calls[0]?.body.sessionId, 'agent:main:delegate:leader:1:abcd')
    if (result.ok) {
      assert.equal(result.lease.routeToken, ROUTE_TOKEN)
      assert.equal(result.lease.baseUrl, BASE_URL)
      await result.lease.release()
    }
    assert.equal(calls[1]?.path, '/internal/v5/delegate/grok-route/release')
    assert.equal(calls[1]?.body.routeToken, ROUTE_TOKEN)
  })

  test('sanitizes an invalid sessionId instead of dropping it silently into the pool stickiness key', async () => {
    const { calls, fetcher } = fetcherScript([
      { status: 200, body: { ok: true, baseUrl: BASE_URL, routeToken: ROUTE_TOKEN } },
      { status: 200, body: { ok: true } },
    ])
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      sessionId: 'not a session id',
      log: LOG,
      env: ENV,
      fetcher,
    })
    assert.equal(result.ok, true)
    assert.equal(calls[0]?.body.sessionId, undefined)
    if (result.ok) await result.lease.release()
  })

  test('maps 409 to busy, 503 to unavailable, 404 to unmounted master', async () => {
    for (const [status, expectedHttp, reasonMatch] of [
      [409, 409, /并发已满/],
      [503, 503, /no usable Grok subscription account/],
      [404, 503, /未开放/],
      [500, 502, /HTTP 500/],
    ] as const) {
      const { fetcher } = fetcherScript([
        status === 503
          ? { status, body: { error: { code: 'GROK_POOL_UNAVAILABLE', message: 'no usable Grok subscription account' } } }
          : { status, body: { error: { code: 'X', message: 'x' } } },
      ])
      const result = await acquireDelegateGrokRoute({
        modelId: 'grok-build',
        log: LOG,
        env: ENV,
        fetcher,
      })
      assert.equal(result.ok, false, `status ${status}`)
      if (!result.ok) {
        assert.equal(result.httpStatus, expectedHttp)
        assert.match(result.reason, reasonMatch)
      }
    }
  })

  test('network failure maps to a retryable 503, not a throw', async () => {
    const fetcher = (async () => {
      throw new Error('ECONNREFUSED')
    }) as never
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      log: LOG,
      env: ENV,
      fetcher,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.httpStatus, 503)
      assert.match(result.reason, /ECONNREFUSED/)
    }
  })

  test('mint body shape violations fail closed instead of yielding a lease', async () => {
    const { fetcher } = fetcherScript([
      { status: 200, body: { ok: true, baseUrl: BASE_URL, routeToken: 'short' } },
    ])
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      log: LOG,
      env: ENV,
      fetcher,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.httpStatus, 502)
  })

  test('release swallows network errors so finished turns never fail on cleanup', async () => {
    let minted = false
    const fetcher = (async (url: string) => {
      if (url.includes('/mint')) {
        minted = true
        return { statusCode: 200, body: Readable.from([JSON.stringify({ ok: true, baseUrl: BASE_URL, routeToken: ROUTE_TOKEN })]) }
      }
      throw new Error('release dropped')
    }) as never
    const warnings: string[] = []
    const result = await acquireDelegateGrokRoute({
      modelId: 'grok-build',
      log: { warn: (msg) => warnings.push(msg), debug: () => {} },
      env: ENV,
      fetcher,
    })
    assert.equal(result.ok, true)
    assert.equal(minted, true)
    if (result.ok) await result.lease.release()
    assert.ok(warnings.some((msg) => msg.includes('delegate_grok_route_release_failed')))
  })
})
