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
  CODEX_RELAY_PREFIX,
  CODEX_UPSTREAM_AUTH_HEADER,
  buildCodexRelayLocalBaseUrl,
  codexRelayBasePathForUpstream,
  makeCodexRelayHandler,
  mapCodexRelayUrl,
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
