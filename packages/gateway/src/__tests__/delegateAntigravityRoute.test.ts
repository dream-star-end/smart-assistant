/**
 * Container-side delegate antigravity route client (OCV5-738): env gating,
 * mint response parsing/mapping, heartbeat renewal and ack-based release.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateAntigravityRoute.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH,
} from '@openclaude/protocol'

import { acquireDelegateAntigravityRoute } from '../delegateAntigravityRoute.js'

const REQUEST_ID = 'ab'.repeat(16)
const ROUTE_TOKEN = 'ef'.repeat(32)
const BASE = 'http://127.0.0.1:18788'
const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: BASE,
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.11.self',
} as NodeJS.ProcessEnv

const LOG = { warn: () => {}, debug: () => {} }

interface Call {
  url: string
  body: any
}

function response(statusCode: number, payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    statusCode,
    body: (async function* () {
      yield Buffer.from(text)
    })(),
  }
}

function routeBody() {
  return {
    ok: true,
    route: {
      baseUrl: `${BASE}/internal/v5/antigravity-relay/route/${ROUTE_TOKEN}`,
      routeToken: ROUTE_TOKEN,
      accessToken: 'A'.repeat(48),
      accessTokenExpiresAt: '2026-11-05T00:00:00.000Z',
    },
  }
}

function fetcher(handler: (call: Call) => ReturnType<typeof response>) {
  const calls: Call[] = []
  const fn = (async (url: string, opts: any) => {
    const call = { url: String(url), body: JSON.parse(String(opts.body)) }
    calls.push(call)
    return handler(call)
  }) as any
  return { fn, calls }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('acquireDelegateAntigravityRoute', () => {
  it('fails closed without the master internal channel and never mints locally', async () => {
    const { fn, calls } = fetcher(() => response(200, routeBody()))
    const result = await acquireDelegateAntigravityRoute({
      requestId: REQUEST_ID,
      log: LOG,
      env: {} as NodeJS.ProcessEnv,
      fetcher: fn,
    })
    assert.equal(result.ok, false)
    assert.equal((result as { httpStatus: number }).httpStatus, 503)
    assert.equal(calls.length, 0)
  })

  it('rejects a malformed requestId before any network call', async () => {
    const { fn, calls } = fetcher(() => response(200, routeBody()))
    const result = await acquireDelegateAntigravityRoute({
      requestId: 'not-hex',
      log: LOG,
      env: ENV,
      fetcher: fn,
    })
    assert.equal(result.ok, false)
    assert.equal((result as { httpStatus: number }).httpStatus, 400)
    assert.equal(calls.length, 0)
  })

  it('mints against the admission requestId and passes the route through verbatim', async () => {
    const { fn, calls } = fetcher(() => response(200, routeBody()))
    const result = await acquireDelegateAntigravityRoute({
      requestId: REQUEST_ID,
      log: LOG,
      env: ENV,
      fetcher: fn,
      heartbeatMs: 60_000,
    })
    assert.equal(result.ok, true)
    const lease = (result as { lease: any }).lease
    assert.deepEqual(lease.route, routeBody().route)
    assert.equal(lease.routeToken, ROUTE_TOKEN)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${BASE}${DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH}`)
    assert.deepEqual(calls[0].body, { requestId: REQUEST_ID })
    await lease.release()
  })

  it('heartbeats the route while the turn is live and releases it until acked', async () => {
    const { fn, calls } = fetcher((call) =>
      call.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH)
        ? response(200, { ok: true, expired: true })
        : response(200, routeBody()),
    )
    const result = await acquireDelegateAntigravityRoute({
      requestId: REQUEST_ID,
      log: LOG,
      env: ENV,
      fetcher: fn,
      heartbeatMs: 5,
      releaseRetryMs: 1,
    })
    assert.equal(result.ok, true)
    const lease = (result as { lease: any }).lease
    await sleep(25)
    const renews = calls.filter((c) => c.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH))
    assert.ok(renews.length >= 1, 'a live lease must renew master TTL')
    assert.deepEqual(renews[0].body, { routeToken: ROUTE_TOKEN })
    await lease.release()
    await sleep(20)
    const releases = calls.filter((c) => c.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH))
    assert.equal(releases.length, 1, 'ack on the first attempt ends the retry loop')
    const renewsAfterRelease = calls.filter((c) =>
      c.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH),
    ).length
    await sleep(20)
    assert.equal(
      calls.filter((c) => c.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH)).length,
      renewsAfterRelease,
      'release stops the heartbeat',
    )
  })

  it('retries release until master acknowledges it', async () => {
    let releaseAttempts = 0
    const { fn, calls } = fetcher((call) => {
      if (call.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH)) {
        releaseAttempts += 1
        return releaseAttempts < 3 ? response(500, { error: { message: 'down' } }) : response(200, { ok: true })
      }
      return response(200, routeBody())
    })
    const result = await acquireDelegateAntigravityRoute({
      requestId: REQUEST_ID,
      log: LOG,
      env: ENV,
      fetcher: fn,
      heartbeatMs: 60_000,
      releaseRetryMs: 1,
    })
    assert.equal(result.ok, true)
    await (result as { lease: any }).lease.release()
    // Production floor is 1s between release attempts (the test seam only
    // overrides the first delay), so wait past the first backoff.
    await sleep(1200)
    assert.equal(releaseAttempts, 3)
    assert.equal(
      calls.filter((c) => c.url.endsWith(DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH)).length,
      3,
    )
  })

  it('maps every unusable mint outcome to a fail-closed 503', async () => {
    const cases = [
      { status: 409, body: { error: { code: 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED', message: 'ALREADY_MINTED' } } },
      { status: 404, body: { error: { message: 'not found' } } },
      { status: 503, body: { error: { code: 'ANTIGRAVITY_NO_ACCOUNT', message: 'no account' } } },
    ]
    for (const c of cases) {
      const { fn } = fetcher(() => response(c.status, c.body))
      const result = await acquireDelegateAntigravityRoute({
        requestId: REQUEST_ID,
        log: LOG,
        env: ENV,
        fetcher: fn,
        heartbeatMs: 60_000,
      })
      assert.equal(result.ok, false, `status ${c.status}`)
      const failed = result as { httpStatus: number }
      assert.equal(failed.httpStatus, 503, `status ${c.status} must fail closed as 503`)
    }
  })

  it('rejects a mint response that is missing route fields', async () => {
    const { fn } = fetcher(() => response(200, { ok: true, route: { baseUrl: BASE } }))
    const result = await acquireDelegateAntigravityRoute({
      requestId: REQUEST_ID,
      log: LOG,
      env: ENV,
      fetcher: fn,
      heartbeatMs: 60_000,
    })
    assert.equal(result.ok, false)
    assert.equal((result as { httpStatus: number }).httpStatus, 502)
  })
})
