import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'

import { createQwenChinaRelayServer } from '../../../../scripts/v5-qwen-china-relay.mjs'

const KEY = 'test-qwen-relay-key'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function relayHeaders(): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
}

describe('V5 Qwen China relay', () => {
  test('exposes health and rejects unauthorized or unsupported requests before upstream', async () => {
    let upstreamCalls = 0
    const upstream = createServer((_req, res) => {
      upstreamCalls++
      res.end('unexpected')
    })
    const upstreamPort = await listen(upstream)
    const relay = createQwenChinaRelayServer({
      apiKey: Buffer.from(KEY),
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/responses`,
      log: () => {},
    })
    const relayPort = await listen(relay)
    try {
      const health = await fetch(`http://127.0.0.1:${relayPort}/healthz`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { ok: true, role: 'qwen-china-relay' })

      const unauthorized = await fetch(`http://127.0.0.1:${relayPort}/compatible-mode/v1/responses`, {
        method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' },
      })
      assert.equal(unauthorized.status, 401)

      const unsupported = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
        method: 'POST', body: '{}', headers: relayHeaders(),
      })
      assert.equal(unsupported.status, 404)
      assert.equal(upstreamCalls, 0)
    } finally {
      await close(relay)
      await close(upstream)
    }
  })

  test('streams a multi-megabyte chunked request byte-identically with server-owned auth', async () => {
    const expected = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61)
    const expectedHash = createHash('sha256').update(expected).digest('hex')
    let receivedHash = ''
    let receivedBytes = 0
    let authorization = ''
    const upstream = createServer(async (req, res) => {
      authorization = req.headers.authorization ?? ''
      const hash = createHash('sha256')
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk)
        receivedBytes += bytes.length
        hash.update(bytes)
      }
      receivedHash = hash.digest('hex')
      res.setHeader('content-type', 'text/event-stream')
      res.end('data: done\n\n')
    })
    const upstreamPort = await listen(upstream)
    const relay = createQwenChinaRelayServer({
      apiKey: Buffer.from(KEY), upstreamUrl: `http://127.0.0.1:${upstreamPort}/responses`, log: () => {},
    })
    const relayPort = await listen(relay)
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({
          host: '127.0.0.1', port: relayPort, path: '/compatible-mode/v1/responses', method: 'POST',
          headers: { ...relayHeaders(), authorization: 'Bearer test-qwen-relay-key' },
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        for (let offset = 0; offset < expected.length; offset += 8191) req.write(expected.subarray(offset, offset + 8191))
        req.end()
      })
      assert.equal(result.status, 200)
      assert.equal(result.body, 'data: done\n\n')
      assert.equal(receivedBytes, expected.length)
      assert.equal(receivedHash, expectedHash)
      assert.equal(authorization, `Bearer ${KEY}`)
    } finally {
      await close(relay)
      await close(upstream)
    }
  })

  test('delivers the first SSE event before the upstream response completes', async () => {
    let releaseUpstream!: () => void
    const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve })
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain request */ }
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: first\n\n')
      await upstreamGate
      res.end('data: second\n\n')
    })
    const upstreamPort = await listen(upstream)
    const relay = createQwenChinaRelayServer({
      apiKey: Buffer.from(KEY), upstreamUrl: `http://127.0.0.1:${upstreamPort}/responses`, log: () => {},
    })
    const relayPort = await listen(relay)
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/compatible-mode/v1/responses`, {
        method: 'POST', headers: relayHeaders(), body: '{}',
      })
      const reader = response.body!.getReader()
      const first = await reader.read()
      assert.equal(Buffer.from(first.value!).toString('utf8'), 'data: first\n\n')
      releaseUpstream()
      const chunks: Buffer[] = []
      while (true) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(Buffer.from(next.value))
      }
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'data: second\n\n')
    } finally {
      releaseUpstream()
      await close(relay)
      await close(upstream)
    }
  })

  test('propagates downstream aborts to the upstream stream', async () => {
    let upstreamClosed!: () => void
    const upstreamClose = new Promise<void>((resolve) => { upstreamClosed = resolve })
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain request */ }
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: open\n\n')
      res.on('close', upstreamClosed)
    })
    const upstreamPort = await listen(upstream)
    const relay = createQwenChinaRelayServer({
      apiKey: Buffer.from(KEY), upstreamUrl: `http://127.0.0.1:${upstreamPort}/responses`, log: () => {},
    })
    const relayPort = await listen(relay)
    try {
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${relayPort}/compatible-mode/v1/responses`, {
        method: 'POST', headers: relayHeaders(), body: '{}', signal: controller.signal,
      })
      await response.body!.getReader().read()
      controller.abort()
      await Promise.race([
        upstreamClose,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 2_000)),
      ])
    } finally {
      await close(relay)
      await close(upstream)
    }
  })

  test('returns a safe 502 when the upstream cannot be reached', async () => {
    const unused = createServer()
    const unusedPort = await listen(unused)
    await close(unused)
    const relay = createQwenChinaRelayServer({
      apiKey: Buffer.from(KEY), upstreamUrl: `http://127.0.0.1:${unusedPort}/responses`, log: () => {},
    })
    const relayPort = await listen(relay)
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/compatible-mode/v1/responses`, {
        method: 'POST', headers: relayHeaders(), body: '{}',
      })
      assert.equal(response.status, 502)
      assert.deepEqual(await response.json(), {
        error: { code: 'UPSTREAM_FAILED', message: 'Qwen upstream request failed' },
      })
    } finally {
      await close(relay)
    }
  })
})
