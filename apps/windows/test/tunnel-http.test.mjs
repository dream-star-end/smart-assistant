import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLAG_FIN,
  MAX_STREAMS_PER_TUNNEL,
  MuxType,
  createMuxLoopbackPair,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
} from '../src/tunnel/mux.mjs'
import { attachMuxHttpServer, notImplementedHandler } from '../src/tunnel/muxHttpServer.mjs'

function drain(ms = 15) {
  return new Promise((r) => setTimeout(r, ms))
}

function collect(transport) {
  const frames = []
  transport.on('message', (raw) => {
    const decoded = decodeFrames(raw)
    frames.push(...decoded.frames)
  })
  return frames
}

test('OPEN_HTTP empty body still emits START + DATA FIN + END and 200', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  attachMuxHttpServer({
    transport: pair.desktop,
    handler: async (req) => {
      assert.equal(req.method, 'GET')
      assert.equal(req.path, '/healthz')
      assert.equal(req.body.length, 0)
      return {
        status: 200,
        headers: [{ k: 'content-type', v: 'text/plain' }],
        body: 'ok',
      }
    },
  })
  pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, 1, {
    method: 'GET',
    path: '/healthz',
    headers: {},
    deadlineMs: Date.now() + 2_000,
  }))
  pair.master.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0)))
  await drain(40)
  const types = seen.map((f) => f.type)
  assert.deepEqual(types, [MuxType.HTTP_RESPONSE_START, MuxType.HTTP_DATA, MuxType.HTTP_END])
  const start = JSON.parse(seen[0].payload.toString('utf8'))
  assert.equal(start.status, 200)
  assert.equal(seen[1].flags & FLAG_FIN, FLAG_FIN)
  assert.equal(seen[1].payload.toString('utf8'), 'ok')
})

test('HTTP_RESPONSE_START is required before DATA (server emits START first)', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  attachMuxHttpServer({
    transport: pair.desktop,
    handler: async () => ({ status: 204, headers: [], body: Buffer.alloc(0) }),
  })
  pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, 1, {
    method: 'GET', path: '/', headers: {}, deadlineMs: Date.now() + 2_000,
  }))
  pair.master.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0)))
  await drain(40)
  assert.equal(seen[0].type, MuxType.HTTP_RESPONSE_START)
  assert.equal(seen[1].type, MuxType.HTTP_DATA)
  assert.equal(seen[1].payload.length, 0)
  assert.equal(seen[1].flags & FLAG_FIN, FLAG_FIN)
})

test('handler throw yields 502 START + END', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  attachMuxHttpServer({
    transport: pair.desktop,
    handler: async () => { throw new Error('boom') },
  })
  pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, 1, {
    method: 'GET', path: '/', headers: {}, deadlineMs: Date.now() + 2_000,
  }))
  pair.master.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0)))
  await drain(40)
  const start = JSON.parse(seen[0].payload.toString('utf8'))
  assert.equal(start.status, 502)
  assert.equal(seen.at(-1).type, MuxType.HTTP_END)
})

test('notImplementedHandler returns 501 JSON', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  attachMuxHttpServer({ transport: pair.desktop, handler: notImplementedHandler })
  pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, 1, {
    method: 'GET', path: '/api/file', headers: {}, deadlineMs: Date.now() + 2_000,
  }))
  pair.master.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0)))
  await drain(40)
  const start = JSON.parse(seen[0].payload.toString('utf8'))
  assert.equal(start.status, 501)
  assert.match(seen[1].payload.toString('utf8'), /NOT_IMPLEMENTED/)
})

test('33rd concurrent stream is RESET STREAM_LIMIT and does not fail-close', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  let fail = false
  const server = attachMuxHttpServer({
    transport: pair.desktop,
    handler: () => new Promise(() => {}),
    onFailClosed: () => { fail = true },
  })
  for (let i = 0; i < MAX_STREAMS_PER_TUNNEL + 1; i++) {
    const id = i * 2 + 1
    pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, id, {
      method: 'GET', path: '/', headers: {}, deadlineMs: Date.now() + 30_000,
    }))
  }
  await drain(40)
  assert.equal(server.size, MAX_STREAMS_PER_TUNNEL)
  const reset = seen.find((f) => f.type === MuxType.RESET_STREAM)
  assert.ok(reset)
  const obj = JSON.parse(reset.payload.toString('utf8'))
  assert.equal(obj.code, 'STREAM_LIMIT')
  assert.equal(fail, false)
  server.close()
})

test('even streamId OPEN_HTTP is RESET PROTOCOL', async () => {
  const pair = createMuxLoopbackPair()
  const seen = collect(pair.master)
  attachMuxHttpServer({
    transport: pair.desktop,
    handler: async () => ({ status: 200, headers: [], body: '' }),
  })
  pair.master.send(encodeJsonFrame(MuxType.OPEN_HTTP, 2, {
    method: 'GET', path: '/', headers: {}, deadlineMs: Date.now() + 2_000,
  }))
  await drain(20)
  const reset = seen.find((f) => f.type === MuxType.RESET_STREAM)
  assert.ok(reset)
  assert.equal(JSON.parse(reset.payload.toString('utf8')).code, 'PROTOCOL')
})
