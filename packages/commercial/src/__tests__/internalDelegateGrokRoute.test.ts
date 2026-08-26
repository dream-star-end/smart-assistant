/**
 * Delegate grok route mint/renew/release internal endpoint: identity gate,
 * allocation outcome mapping, and per-caller lease scoping. No live pool or
 * xAI traffic is used.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalDelegateGrokRoute.test.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  DELEGATE_GROK_ROUTE_MINT_PATH,
  DELEGATE_GROK_ROUTE_RELEASE_PATH,
  DELEGATE_GROK_ROUTE_RENEW_PATH,
  isDelegateGrokRoutePath,
  makeDelegateGrokRouteHandler,
} from '../http/internalDelegateGrokRoute.js'

const SECRET = 'b'.repeat(64)
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`
const CTX = { hostUuid: 'host-self', boundIp: '172.30.0.11' }
const ROUTE_TOKEN = 'a'.repeat(64)

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
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

async function call(port: number, path: string, body: unknown, auth = `Bearer ${CONTAINER_TOKEN}`): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

function handler(deps: Partial<Parameters<typeof makeDelegateGrokRouteHandler>[0]> = {}) {
  return makeDelegateGrokRouteHandler({
    identityRepo: repo(),
    allocate: async () => ({ kind: 'unavailable', reason: 'test-default' }),
    release: async () => false,
    renew: async () => false,
    ...deps,
  })
}

describe('internalDelegateGrokRoute', () => {
  test('isDelegateGrokRoutePath matches exactly the three managed paths', () => {
    assert.equal(isDelegateGrokRoutePath(DELEGATE_GROK_ROUTE_MINT_PATH), true)
    assert.equal(isDelegateGrokRoutePath(DELEGATE_GROK_ROUTE_RELEASE_PATH), true)
    assert.equal(isDelegateGrokRoutePath(DELEGATE_GROK_ROUTE_RENEW_PATH), true)
    assert.equal(isDelegateGrokRoutePath(`${DELEGATE_GROK_ROUTE_MINT_PATH}/extra`), false)
    assert.equal(isDelegateGrokRoutePath('/internal/v5/grok-relay/route/x/v1'), false)
  })

  test('rejects unauthenticated callers before touching the pool', async () => {
    let allocated = 0
    const server = createServer((req, res) => {
      void handler({
        allocate: async () => {
          allocated += 1
          return { kind: 'unavailable', reason: 'unreachable' }
        },
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const result = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'grok-build' }, 'Bearer oc-v3.11.wrong')
      assert.equal(result.status, 401)
      assert.equal(result.json.error.code, 'UNAUTHORIZED')
      assert.equal(allocated, 0)
    } finally {
      await close(server)
    }
  })

  test('mint returns the master-minted route for a valid allocation', async () => {
    const server = createServer((req, res) => {
      void handler({
        allocate: async ({ containerId, userId, modelId, sessionId }) => {
          assert.equal(containerId, 11)
          assert.equal(userId, 42n)
          assert.equal(modelId, 'grok-build')
          assert.equal(sessionId, 'agent:main:delegate:leader:1:abcd')
          return {
            kind: 'api_relay' as const,
            engine: 'grok' as const,
            token: ROUTE_TOKEN,
            baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${ROUTE_TOKEN}/v1`,
            modelProvider: 'grok',
            providerName: 'xAI Grok subscription',
            wireApi: 'chat' as const,
            preferredAuthMethod: 'apikey' as const,
            disableResponseStorage: true,
            groupId: '4',
            credentialId: '53',
            accountId: '53',
            slotId: 'slot-53',
          }
        },
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const result = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, {
        modelId: 'grok-build',
        sessionId: 'agent:main:delegate:leader:1:abcd',
      })
      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.routeToken, ROUTE_TOKEN)
      assert.match(result.json.baseUrl, /^http:\/\/127\.0\.0\.1:18789\/internal\/v5\/grok-relay\/route\//)
      // Internal pool identifiers stay master-side: containers get exactly
      // the fields they consume (baseUrl + routeToken), nothing else.
      assert.equal('accountId' in result.json, false)
      assert.equal('slotId' in result.json, false)
      assert.equal('credentialId' in result.json, false)
      assert.equal('groupId' in result.json, false)
    } finally {
      await close(server)
    }
  })

  test('mint maps pool-busy to 409 and no-account to 503, and validates the body', async () => {
    const busy = Object.assign(new Error('all grok accounts busy'), { name: 'AccountPoolBusyError' })
    const server = createServer((req, res) => {
      void handler({
        allocate: async ({ modelId }) => {
          if (modelId === 'grok-build') throw busy
          return { kind: 'unavailable', reason: 'no usable Grok subscription account' }
        },
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const busyResult = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'grok-build' })
      assert.equal(busyResult.status, 409)
      assert.equal(busyResult.json.error.code, 'GROK_POOL_BUSY')

      const emptyResult = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'grok-other' })
      assert.equal(emptyResult.status, 503)
      assert.equal(emptyResult.json.error.code, 'GROK_POOL_UNAVAILABLE')
      assert.equal(emptyResult.json.error.message, 'no usable Grok subscription account')

      const badBody = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'x'.repeat(65) })
      assert.equal(badBody.status, 400)

      const badSession = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'grok-build', sessionId: 'bad session id!' })
      assert.equal(badSession.status, 400)
    } finally {
      await close(server)
    }
  })

  test('mint maps the per-container delegate lease cap to 429 GROK_DELEGATE_LEASE_LIMIT', async () => {
    const limited = Object.assign(
      new Error('container 11 already holds 4 active delegate grok route leases'),
      { name: 'GrokDelegateLeaseLimitError' },
    )
    const server = createServer((req, res) => {
      void handler({
        allocate: async () => { throw limited },
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const result = await call(port, DELEGATE_GROK_ROUTE_MINT_PATH, { modelId: 'grok-build' })
      assert.equal(result.status, 429)
      assert.equal(result.json.error.code, 'GROK_DELEGATE_LEASE_LIMIT')
    } finally {
      await close(server)
    }
  })

  test('release scopes the lookup to the caller and is idempotent on unknown rows', async () => {
    const releases: string[] = []
    const server = createServer((req, res) => {
      void handler({
        release: async ({ routeToken, containerId, userId }) => {
          assert.equal(containerId, 11)
          assert.equal(userId, 42n)
          if (routeToken === ROUTE_TOKEN) {
            releases.push(routeToken)
            return true
          }
          return false
        },
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const ok = await call(port, DELEGATE_GROK_ROUTE_RELEASE_PATH, { routeToken: ROUTE_TOKEN })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.ok, true)
      assert.equal(ok.json.expired, true)
      assert.deepEqual(releases, [ROUTE_TOKEN])

      const unknown = await call(port, DELEGATE_GROK_ROUTE_RELEASE_PATH, { routeToken: 'f'.repeat(64) })
      assert.equal(unknown.status, 200)
      assert.equal(unknown.json.expired, false)

      const malformed = await call(port, DELEGATE_GROK_ROUTE_RELEASE_PATH, { routeToken: 'nothex' })
      assert.equal(malformed.status, 400)
    } finally {
      await close(server)
    }
  })

  test('renew reports a dead lease without failing the request', async () => {
    const server = createServer((req, res) => {
      void handler({
        renew: async ({ routeToken }) => routeToken === ROUTE_TOKEN,
      })(req, res, CTX)
    })
    const port = await listen(server)
    try {
      const live = await call(port, DELEGATE_GROK_ROUTE_RENEW_PATH, { routeToken: ROUTE_TOKEN })
      assert.equal(live.status, 200)
      assert.equal(live.json.ok, true)
      assert.equal(live.json.expired, undefined)

      const dead = await call(port, DELEGATE_GROK_ROUTE_RENEW_PATH, { routeToken: 'f'.repeat(64) })
      assert.equal(dead.status, 200)
      assert.equal(dead.json.ok, false)
      assert.equal(dead.json.expired, true)
    } finally {
      await close(server)
    }
  })

  test('rejects non-POST methods', async () => {
    const server = createServer((req, res) => { void handler()(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${DELEGATE_GROK_ROUTE_MINT_PATH}`)
      assert.equal(response.status, 405)
    } finally {
      await close(server)
    }
  })
})
