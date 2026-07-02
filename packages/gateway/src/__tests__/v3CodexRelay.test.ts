/**
 * v3 commercial Codex container-local relay tests.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3CodexRelay.test.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import {
  V3_CODEX_RELAY_PREFIX,
  V3_CODEX_UPSTREAM_AUTH_HEADER,
  handleV3CodexRelayLocal,
  isLoopbackRemoteAddress,
  readV3CodexRelayConfig,
} from '../v3CodexRelay.js'

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

describe('v3CodexRelay local gateway', () => {
  test('reads config only when master base and container token are present', () => {
    assert.equal(readV3CodexRelayConfig({}), null)
    assert.equal(readV3CodexRelayConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791' }), null)
    assert.deepEqual(
      readV3CodexRelayConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791///',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.7.secret',
      }),
      { masterBaseUrl: 'http://127.0.0.1:18791', containerToken: 'oc-v3.7.secret' },
    )
  })

  test('accepts only loopback socket addresses', () => {
    assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('::1'), true)
    assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('172.30.0.9'), false)
    assert.equal(isLoopbackRemoteAddress(undefined), false)
  })

  test('moves upstream Authorization into the private header and overwrites spoofed private header', async () => {
    const captured: { url?: string; headers?: Headers; body?: string; duplex?: string } = {}
    const server = createServer((req, res) => {
      void handleV3CodexRelayLocal(
        req,
        res,
        { masterBaseUrl: 'http://master.internal:18791', containerToken: 'oc-v3.7.container' },
        {
          fetchImpl: async (input, init) => {
            captured.url = String(input)
            captured.headers = new Headers(init.headers)
            captured.body = await drainBody(init.body)
            captured.duplex = init.duplex
            return new Response('ok', { status: 202, headers: { 'content-type': 'text/plain' } })
          },
        },
      )
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${V3_CODEX_RELAY_PREFIX}/v1/responses?stream=true`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer upstream-token',
          [V3_CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer attacker-spoof',
          'content-type': 'application/json',
        },
        body: '{"input":"hi"}',
      })
      assert.equal(res.status, 202)
      assert.equal(await res.text(), 'ok')
      assert.equal(captured.url, `http://master.internal:18791${V3_CODEX_RELAY_PREFIX}/v1/responses?stream=true`)
      assert.equal(captured.headers?.get('authorization'), 'Bearer oc-v3.7.container')
      assert.equal(captured.headers?.get(V3_CODEX_UPSTREAM_AUTH_HEADER), 'Bearer upstream-token')
      assert.equal(captured.headers?.get('content-type'), 'application/json')
      assert.equal(captured.body, '{"input":"hi"}')
      assert.equal(captured.duplex, 'half')
    } finally {
      await close(server)
    }
  })
})
