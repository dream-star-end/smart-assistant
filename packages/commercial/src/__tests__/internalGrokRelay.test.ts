/**
 * V5 official Grok relay: route/identity/account/egress binding and header
 * ownership. No live xAI traffic is used.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalGrokRelay.test.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  GROK_OFFICIAL_UPSTREAM_BASE_URL,
  GROK_RELAY_PREFIX,
  makeGrokRelayHandler,
} from '../http/internalGrokRelay.js'

const SECRET = 'b'.repeat(64)
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`
const ROUTE_TOKEN = 'a'.repeat(64)
const CTX = { hostUuid: 'host-self', boundIp: '172.30.0.11' }
const DISPATCHER = { name: 'grok-account-proxy' } as never

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

async function bodyText(body: unknown): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('internal Grok relay', () => {
  test('injects the selected subscription bearer and uses only that account egress dispatcher', async () => {
    const captured: { url?: string; headers?: Headers; dispatcher?: unknown; body?: string } = {}
    const statusCalls: Array<[bigint, number]> = []
    const handler = makeGrokRelayHandler({
      identityRepo: repo(),
      resolveContext: async ({ token, containerId, userId }) => {
        assert.equal(token, ROUTE_TOKEN)
        assert.equal(containerId, 11)
        assert.equal(userId, 42n)
        return { modelId: 'grok-build', accountId: 53n, slotId: 'slot-53' }
      },
      freshToken: async (accountId) => {
        assert.equal(accountId, 53n)
        return Buffer.from('real-xai-oauth-token', 'utf8')
      },
      resolveDispatcher: async (accountId) => {
        assert.equal(accountId, 53n)
        return { dispatcher: DISPATCHER }
      },
      requestFn: (async (
        url: Parameters<typeof import('undici').request>[0],
        init: Parameters<typeof import('undici').request>[1],
      ) => {
        assert.ok(init)
        captured.url = String(url)
        captured.headers = new Headers(init.headers as HeadersInit)
        captured.dispatcher = init.dispatcher
        captured.body = await bodyText(init.body)
        return {
          statusCode: 201,
          headers: { 'content-type': 'text/plain', connection: 'close' },
          body: Readable.from(['relay-ok']),
        }
      }) as never,
      recordStatus: async (accountId, statusCode) => { statusCalls.push([accountId, statusCode]) },
      renewSlot: (accountId, slotId) => {
        assert.equal(accountId, 53n)
        assert.equal(slotId, 'slot-53')
        return true
      },
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${GROK_RELAY_PREFIX}/route/${ROUTE_TOKEN}/v1/chat/completions?stream=true`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CONTAINER_TOKEN}`,
          'content-type': 'application/json',
          'x-grok-client-version': '1.0.3',
          'x-grok-client-mode': 'attacker-mode',
          'x-authenticateresponse': 'attacker-response',
          'x-grok-model-override': 'attacker-model',
          'x-xai-token-auth': 'attacker-mode',
          'x-grok-conv-id': 'conv-12345',
          'x-grok-req-id': 'req-67890',
          'x-grok-session-id': 'session-abcdef',
          'x-grok-agent-id': 'agent-abcdef',
          'x-grok-turn-idx': '2',
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        },
        body: '{"model":"grok-build"}',
      })
      assert.equal(response.status, 201)
      assert.equal(await response.text(), 'relay-ok')
      assert.equal(captured.url, `${GROK_OFFICIAL_UPSTREAM_BASE_URL}/chat/completions?stream=true`)
      assert.equal(captured.headers?.get('authorization'), 'Bearer real-xai-oauth-token')
      assert.equal(captured.headers?.get('content-type'), 'application/json')
      assert.equal(captured.headers?.get('x-grok-client-version'), '1.0.3')
      assert.equal(captured.headers?.get('x-grok-model-override'), 'grok-build')
      assert.equal(captured.headers?.get('x-xai-token-auth'), 'xai-grok-cli')
      assert.equal(captured.headers?.get('x-authenticateresponse'), 'authenticate-response')
      assert.equal(captured.headers?.get('x-grok-client-mode'), 'headless')
      assert.equal(captured.headers?.get('x-grok-conv-id'), 'conv-12345')
      assert.equal(captured.headers?.get('x-grok-req-id'), 'req-67890')
      assert.equal(captured.headers?.get('x-grok-session-id'), 'session-abcdef')
      assert.equal(captured.headers?.get('x-grok-agent-id'), 'agent-abcdef')
      assert.equal(captured.headers?.get('x-grok-turn-idx'), '2')
      assert.equal(captured.headers?.get('traceparent'), '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
      assert.strictEqual(captured.dispatcher, DISPATCHER)
      assert.equal(captured.body, '{"model":"grok-build"}')
      assert.deepEqual(statusCalls, [[53n, 201]])
    } finally {
      await close(server)
    }
  })

  test('fails closed before upstream traffic when the selected account slot lease is gone', async () => {
    let upstreamCalls = 0
    const handler = makeGrokRelayHandler({
      identityRepo: repo(),
      resolveContext: async () => ({ modelId: 'grok-build', accountId: 53n, slotId: 'slot-53' }),
      renewSlot: () => false,
      requestFn: (async () => { upstreamCalls += 1; throw new Error('must not call') }) as never,
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${GROK_RELAY_PREFIX}/route/${ROUTE_TOKEN}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CONTAINER_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 409)
      assert.equal(upstreamCalls, 0)
    } finally {
      await close(server)
    }
  })

  test('fails closed for an unapproved upstream endpoint before account lookup', async () => {
    let contextCalls = 0
    const handler = makeGrokRelayHandler({
      identityRepo: repo(),
      resolveContext: async () => { contextCalls += 1; return { modelId: 'grok-build', accountId: 53n, slotId: 'slot-53' } },
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${GROK_RELAY_PREFIX}/route/${ROUTE_TOKEN}/v1/files`, {
        headers: { authorization: `Bearer ${CONTAINER_TOKEN}` },
      })
      assert.equal(response.status, 405)
      assert.equal(contextCalls, 0)
    } finally {
      await close(server)
    }
  })

  test('allows the official CLI API-key probe while still replacing its fake bearer', async () => {
    let capturedUrl = ''
    let capturedAuth = ''
    const handler = makeGrokRelayHandler({
      identityRepo: repo(),
      resolveContext: async () => ({ modelId: 'grok-build', accountId: 53n, slotId: 'slot-53' }),
      freshToken: async () => Buffer.from('real-xai-oauth-token', 'utf8'),
      resolveDispatcher: async () => ({ dispatcher: DISPATCHER }),
      requestFn: (async (url: unknown, init: { headers?: HeadersInit }) => {
        capturedUrl = String(url)
        capturedAuth = new Headers(init.headers).get('authorization') ?? ''
        return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{}']) }
      }) as never,
      recordStatus: async () => {},
    })
    const server = createServer((req, res) => { void handler(req, res, CTX) })
    const port = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${GROK_RELAY_PREFIX}/route/${ROUTE_TOKEN}/v1/api-key`, {
        headers: { authorization: `Bearer ${CONTAINER_TOKEN}` },
      })
      assert.equal(response.status, 200)
      assert.equal(capturedUrl, `${GROK_OFFICIAL_UPSTREAM_BASE_URL}/api-key`)
      assert.equal(capturedAuth, 'Bearer real-xai-oauth-token')
    } finally {
      await close(server)
    }
  })
})
