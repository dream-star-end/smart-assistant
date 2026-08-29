import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import {
  V5_GROK_RELAY_PREFIX,
  handleV5GrokRelayLocal,
  readV5GrokRelayConfig,
} from '../v5GrokRelay.js'

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

describe('v5GrokRelay local gateway', () => {
  test('requires both the master base and container identity token', () => {
    assert.equal(readV5GrokRelayConfig({}), null)
    assert.deepEqual(readV5GrokRelayConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791///',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v5.container',
    }), {
      masterBaseUrl: 'http://127.0.0.1:18791',
      containerToken: 'oc-v5.container',
    })
  })

  test('forwards the token-bound path but strips caller authorization in favor of container identity', async () => {
    const token = 'a'.repeat(64)
    const captured: { url?: string; headers?: Headers; body?: string } = {}
    const server = createServer((req, res) => {
      void handleV5GrokRelayLocal(req, res, {
        masterBaseUrl: 'http://master.internal:18791',
        containerToken: 'oc-v5.container',
      }, {
        fetchImpl: async (input, init) => {
          captured.url = String(input)
          captured.headers = new Headers(init.headers)
          captured.body = await drainBody(init.body)
          return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
    })
    const port = await listen(server)
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}${V5_GROK_RELAY_PREFIX}/route/${token}/v1/chat/completions?stream=true`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer attacker-controlled-route-token',
            'content-type': 'application/json',
          },
          body: '{"model":"grok-build"}',
        },
      )
      assert.equal(res.status, 200)
      assert.equal(
        captured.url,
        `http://master.internal:18791${V5_GROK_RELAY_PREFIX}/route/${token}/v1/chat/completions?stream=true`,
      )
      assert.equal(captured.headers?.get('authorization'), 'Bearer oc-v5.container')
      assert.equal(captured.body, '{"model":"grok-build"}')
    } finally {
      await close(server)
    }
  })
})
