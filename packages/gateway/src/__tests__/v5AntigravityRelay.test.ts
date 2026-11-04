/**
 * Loopback hop for the Antigravity CLI (OCV5-415 P2): the CLI's limited
 * Google token and any API key never leave the container; master sees only
 * the container identity.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v5AntigravityRelay.test.ts
 */
import assert from 'node:assert/strict'
import { Agent as HttpAgent, createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import {
  V5_ANTIGRAVITY_RELAY_PREFIX,
  handleV5AntigravityRelayLocal,
  readV5AntigravityRelayConfig,
} from '../v5AntigravityRelay.js'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

async function drainBody(body: unknown): Promise<string> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')
    return ''
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('v5AntigravityRelay local gateway', () => {
  test('requires both the master base and container identity token', () => {
    assert.equal(readV5AntigravityRelayConfig({}), null)
    assert.deepEqual(
      readV5AntigravityRelayConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791//',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v5.container',
      }),
      { masterBaseUrl: 'http://127.0.0.1:18791', containerToken: 'oc-v5.container' },
    )
  })

  test('forwards /v1internal calls with the container token and drops the CLI credentials', async () => {
    const token = 'a'.repeat(64)
    const captured: { url?: string; headers?: Headers; body?: string } = {}
    const server = createServer((req, res) => {
      void handleV5AntigravityRelayLocal(
        req,
        res,
        {
          masterBaseUrl: 'http://master.internal:18791',
          containerToken: 'oc-v5.container',
        },
        {
          fetchImpl: async (input, init) => {
            captured.url = String(input)
            captured.headers = new Headers(init.headers)
            captured.body = await drainBody(init.body)
            return new Response('data: {"response":{}}\n\n', {
              status: 200,
              headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
            })
          },
        },
      )
    })
    const port = await listen(server)
    try {
      const path = `${V5_ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ya29.limited-cli-token',
          'x-goog-api-key': 'must-not-leak',
          cookie: 'sid=1',
          'content-type': 'application/json',
          'user-agent': 'antigravity/cli/1.3.4',
        },
        body: '{"model":"gemini-3.8-flash-low"}',
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'data: {"response":{}}\n\n')
      assert.equal(
        res.headers.get('content-encoding'),
        null,
        'decoded body must not keep content-encoding',
      )
      assert.equal(captured.url, `http://master.internal:18791${path}`)
      assert.equal(captured.headers?.get('authorization'), 'Bearer oc-v5.container')
      assert.equal(captured.headers?.get('x-goog-api-key'), null)
      assert.equal(captured.headers?.get('cookie'), null)
      assert.equal(captured.headers?.get('user-agent'), 'antigravity/cli/1.3.4')
      assert.equal(captured.body, '{"model":"gemini-3.8-flash-low"}')
    } finally {
      await close(server)
    }
  })

  test('refuses paths outside the route prefix', async () => {
    let called = false
    const server = createServer((req, res) => {
      void handleV5AntigravityRelayLocal(
        req,
        res,
        {
          masterBaseUrl: 'http://master.internal:18791',
          containerToken: 'oc-v5.container',
        },
        {
          fetchImpl: async () => {
            called = true
            return new Response('')
          },
        },
      )
    })
    const port = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${V5_ANTIGRAVITY_RELAY_PREFIX}/events`)
      assert.equal(res.status, 404)
      assert.equal(called, false)
    } finally {
      await close(server)
    }
  })

  test('closes each loopback relay response so pooled CLI connections never reset across tool pauses', async () => {
    const token = 'b'.repeat(64)
    let upstreamCalls = 0
    const server = createServer((req, res) => {
      void handleV5AntigravityRelayLocal(
        req,
        res,
        {
          masterBaseUrl: 'http://master.internal:18791',
          containerToken: 'oc-v5.container',
        },
        {
          fetchImpl: async (_input, init) => {
            await drainBody(init.body)
            upstreamCalls++
            return new Response(`data: {"call":${upstreamCalls}}\n\n`, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            })
          },
        },
      )
    })
    server.keepAliveTimeout = 80
    const port = await listen(server)
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 })
    const path = `${V5_ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`
    const payload = JSON.stringify({ model: 'gemini-4-argon', pad: 'x'.repeat(256 * 1024) })

    function postOnce(): Promise<{ status: number; body: string; connection: string | undefined }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            agent,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { text += chunk })
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              body: text,
              connection: res.headers.connection,
            }))
          },
        )
        req.on('error', reject)
        req.end(payload)
      })
    }

    try {
      const first = await postOnce()
      assert.equal(first.status, 200)
      assert.equal(first.connection, 'close')
      await new Promise((r) => setTimeout(r, 80))
      const second = await postOnce()
      assert.equal(second.status, 200)
      assert.equal(second.body, 'data: {"call":2}\n\n')
      assert.equal(upstreamCalls, 2)
    } finally {
      agent.destroy()
      await close(server)
    }
  })
})
