import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { makeCcbTranscriptRestoreHandler, CCB_TRANSCRIPT_RESTORE_PATH } from '../http/internalCcbTranscriptRestore.js'
import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import type { ServerAuthoredHandlerCtx } from '../http/internalServerAuthored.js'
import type { CcbNativeTranscriptArchive, CcbTranscriptRestoreBinding } from '@openclaude/protocol'

const binding = { peerId: 'g607-fixture', agentId: 'main', nativeSessionId: '60700000-0000-4000-8000-000000000001' }
const ctx: ServerAuthoredHandlerCtx = { hostUuid: 'g607-fixture-host', boundIp: '172.31.255.2' }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const pathFor = (extra = ''): string => `${CCB_TRANSCRIPT_RESTORE_PATH}?${new URLSearchParams(binding)}${extra}`
function archive(text = 'synthetic-data'): CcbNativeTranscriptArchive {
  return { version: 1, binding, tapes: [{ tapeId: 'fixture-tape', tapeSha256: sha('fixture-tape'), anchorSeq: 1,
    physicalRecordCount: 1, logicalRecordCount: 1,
    canonicalInput: { id: 'fixture-input', modelText: 'fixture-input', sha256: sha('fixture-input') },
    records: [{ ordinal: 1, sha256: sha(text), payload: { fixtureText: text } }] }] }
}
async function harness(options: { fail?: boolean; text?: string; context?: ServerAuthoredHandlerCtx } = {}) {
  const secret = randomBytes(32).toString('hex')
  const token = `oc-v3.607.${secret}`
  const calls: Array<{ owner: string; binding: CcbTranscriptRestoreBinding }> = []
  const identityRepo: ContainerIdentityRepo = { async findActiveByHostAndBoundIp(host, ip) {
    if (host !== ctx.hostUuid || ip !== ctx.boundIp) return null
    return { id: 607, user_id: 765, bound_ip: ctx.boundIp, host_uuid: ctx.hostUuid,
      secret_hash: createHash('sha256').update(Buffer.from(secret, 'hex')).digest() }
  } }
  const payload = archive(options.text)
  const handler = makeCcbTranscriptRestoreHandler({ identityRepo, read: async (owner, seen) => {
    calls.push({ owner, binding: seen })
    if (options.fail) throw new Error('FIXTURE_INCOMPLETE')
    return payload
  } })
  const listenerCounts: Array<[number, number]> = []
  const server = createServer((req, res) => {
    const before = res.listenerCount('close')
    void handler(req, res, options.context ?? ctx).then(() => { listenerCounts.push([before, res.listenerCount('close')]) }, () => res.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { token, payload, calls, listenerCounts, server, port: address.port }
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
async function get(port: number, path: string, auth?: string, method = 'GET'): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: auth ? { authorization: auth } : {} }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject); req.end()
  })
}

test('restore uses real host/IP and bearer identity and never a caller-supplied UID', async () => {
  const h = await harness()
  try {
    assert.equal((await get(h.port, pathFor())).status, 401)
    assert.equal((await get(h.port, pathFor(), 'Bearer invalid')).status, 401)
    assert.equal((await get(h.port, pathFor('&userId=247'), `Bearer ${h.token}`)).status, 400)
    assert.equal((await get(h.port, pathFor('&peerId=other-peer'), `Bearer ${h.token}`)).status, 400)
    assert.equal((await get(h.port, pathFor(), `Bearer ${h.token}`, 'POST')).status, 405)
    assert.equal(h.calls.length, 0)
    const response = await get(h.port, pathFor(), `Bearer ${h.token}`)
    assert.equal(response.status, 200)
    assert.deepEqual(h.calls, [{ owner: 'c:765', binding }])
  } finally { await close(h.server) }
  const otherHost = await harness({ context: { ...ctx, hostUuid: 'another-host' } })
  try {
    assert.equal((await get(otherHost.port, pathFor(), `Bearer ${otherHost.token}`)).status, 401)
    assert.equal(otherHost.calls.length, 0)
  } finally { await close(otherHost.server) }
})

test('large archives stream complete bytes and release every backpressure listener', async () => {
  const h = await harness({ text: 'synthetic-data-'.repeat(400000) })
  try {
    const response = await get(h.port, pathFor(), `Bearer ${h.token}`)
    assert.equal(response.status, 200)
    const frames = response.body.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const complete = frames.pop()
    assert.ok(complete?.complete === true)
    assert.ok(frames.length > 10)
    const chunks = frames.map((frame, index) => { assert.equal(frame.index, index); assert.ok(frame.data.length <= 350000); return Buffer.from(frame.data, 'base64') })
    const bytes = Buffer.concat(chunks)
    assert.equal(complete.chunks, chunks.length)
    assert.equal(complete.bytes, bytes.length)
    assert.equal(complete.sha256, sha(bytes))
    assert.equal(sha(bytes), sha(JSON.stringify(h.payload)))
    assert.ok(h.listenerCounts.length === 1)
    assert.ok(h.listenerCounts.every(([before, after]) => before === after), 'CCB_RESTORE_DRAIN_LISTENER_RELEASE')
  } finally { await close(h.server) }
})

test('an incomplete authority archive returns a safe failure and no complete frame', async () => {
  const h = await harness({ fail: true })
  try {
    const response = await get(h.port, pathFor(), `Bearer ${h.token}`)
    assert.equal(response.status, 409)
    assert.ok(!response.body.toString().includes('FIXTURE_INCOMPLETE'))
    assert.ok(!response.body.toString().includes('"complete":true'))
  } finally { await close(h.server) }
})
