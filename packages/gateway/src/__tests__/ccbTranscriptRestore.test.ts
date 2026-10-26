import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createCcbTranscriptRestoreSocket } from '../ccbTranscriptRestore.js'
import { CCB_TRANSCRIPT_RESTORE_PATH } from '@openclaude/protocol'

test('a private restore socket forwards only its fixed authority and preserves byte framing', async () => {
  const saved = Object.fromEntries(['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN'].map(key => [key, process.env[key]]))
  const secret = randomBytes(32).toString('hex')
  const binding = { peerId: 'g607-synthetic', agentId: 'main', nativeSessionId: '60700000-0000-4000-8000-000000000001' }
  const body = Buffer.from('{"index":0,"data":"c3ludGhldGlj"}\n{"complete":true,"chunks":1}\n')
  let broken = false
  const calls: string[] = []
  const master = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`)
    calls.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(body.subarray(0, 12))
    if (broken) { setImmediate(() => res.destroy()); return }
    res.end(body.subarray(12))
  })
  master.listen(0, '127.0.0.1'); await once(master, 'listening')
  const address = master.address(); assert.ok(address && typeof address === 'object')
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = secret
  const socket = await createCcbTranscriptRestoreSocket(binding)
  const get = (path: string) => new Promise<{ status: number; bytes: Buffer; complete: boolean }>((resolve, reject) => {
    const req = request({ socketPath: socket.socketPath, path }, res => {
      const chunks: Buffer[] = []; let done = false
      res.on('data', data => chunks.push(Buffer.from(data)))
      const finish = (complete: boolean) => { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks), complete }) }
      res.once('end', () => finish(true)); res.once('aborted', () => finish(false)); res.once('error', () => finish(false))
    })
    req.once('error', reject); req.end()
  })
  try {
    assert.equal((await stat(dirname(socket.socketPath))).mode & 0o777, 0o700)
    assert.equal((await stat(socket.socketPath)).mode & 0o777, 0o600)
    assert.equal((await get('/restore?peerId=other')).status, 404)
    assert.equal(calls.length, 0)
    const response = await get('/restore')
    assert.equal(response.status, 200); assert.equal(response.complete, true); assert.deepEqual(response.bytes, body)
    const target = new URL(calls[0]!, 'http://internal')
    assert.equal(target.pathname, CCB_TRANSCRIPT_RESTORE_PATH)
    assert.deepEqual(Object.fromEntries(target.searchParams), binding)
    broken = true
    const partial = await get('/restore')
    assert.equal(partial.complete, false)
    assert.equal(partial.bytes.includes(Buffer.from('"complete":true')), false)
    await socket.close(); await socket.close()
    await assert.rejects(stat(dirname(socket.socketPath)), { code: 'ENOENT' })
    await assert.rejects(get('/restore'))
  } finally {
    await socket.close(); master.closeAllConnections(); await new Promise<void>(resolve => master.close(() => resolve()))
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})
