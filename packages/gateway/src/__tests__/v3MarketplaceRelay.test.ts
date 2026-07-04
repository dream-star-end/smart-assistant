/**
 * v3/v5 commercial marketplace local relay tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/v3MarketplaceRelay.test.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import {
  V3_MARKETPLACE_LOCAL_RELAY_PREFIX,
  V3_MARKETPLACE_MASTER_AGENT_PREFIX,
  handleV3MarketplaceRelayLocal,
  readV3MarketplaceRelayConfig,
} from '../v3MarketplaceRelay.js'

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

describe('v3MarketplaceRelay local gateway', () => {
  test('reads config only when master base and container token are present', () => {
    assert.equal(readV3MarketplaceRelayConfig({}), null)
    assert.equal(readV3MarketplaceRelayConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791' }), null)
    assert.deepEqual(
      readV3MarketplaceRelayConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791///',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.7.secret',
      }),
      { masterBaseUrl: 'http://127.0.0.1:18791', containerToken: 'oc-v3.7.secret' },
    )
  })

  test('maps local relay path to master marketplace agent path and strips caller auth', async () => {
    const captured: { url?: string; headers?: Headers; body?: string; duplex?: string } = {}
    const server = createServer((req, res) => {
      void handleV3MarketplaceRelayLocal(
        req,
        res,
        { masterBaseUrl: 'http://master.internal:18791', containerToken: 'oc-v3.7.container' },
        {
          fetchImpl: async (input, init) => {
            captured.url = String(input)
            captured.headers = new Headers(init.headers)
            captured.body = await drainBody(init.body)
            captured.duplex = init.duplex
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
          },
        },
      )
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/install`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer caller-should-not-forward',
          'content-type': 'application/json',
        },
        body: '{"slug":"ok-skill"}',
      })
      assert.equal(res.status, 200)
      assert.equal(captured.url, `http://master.internal:18791${V3_MARKETPLACE_MASTER_AGENT_PREFIX}install`)
      assert.equal(captured.headers?.get('authorization'), 'Bearer oc-v3.7.container')
      assert.equal(captured.headers?.get('content-type'), 'application/json')
      assert.equal(captured.body, '{"slug":"ok-skill"}')
      assert.equal(captured.duplex, 'half')
    } finally {
      await close(server)
    }
  })

  test('preserves query parameters for read-only ops', async () => {
    let capturedUrl = ''
    const server = createServer((req, res) => {
      void handleV3MarketplaceRelayLocal(
        req,
        res,
        { masterBaseUrl: 'http://master.internal:18791', containerToken: 'oc-v3.7.container' },
        {
          fetchImpl: async (input) => {
            capturedUrl = String(input)
            return new Response('[]', { status: 200 })
          },
        },
      )
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/search?q=&kind=skill`)
      assert.equal(res.status, 200)
      assert.equal(capturedUrl, `http://master.internal:18791${V3_MARKETPLACE_MASTER_AGENT_PREFIX}search?q=&kind=skill`)
    } finally {
      await close(server)
    }
  })
})
