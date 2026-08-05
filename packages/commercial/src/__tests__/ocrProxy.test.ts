import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { afterEach, describe, test } from 'node:test'

import { hashSecret } from '../auth/containerIdentity.js'
import { makeOcrProxyHandler } from '../ocr/ocrProxy.js'

const SECRET = 'a1'.repeat(32)
const AUTH = `Bearer oc-v3.7.${SECRET}`
const KEYS = `k1:${randomBytes(32).toString('base64')}`
const OWNER_SECRET = randomBytes(32).toString('base64')
const ctx = { hostUuid: 'host', boundIp: '10.0.0.1' }
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
})

function repo(userId = 42): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: userId,
      bound_ip: ctx.boundIp,
      host_uuid: ctx.hostUuid,
      secret_hash: hashSecret(SECRET),
    }),
  }
}

async function listen(handler: ReturnType<typeof makeOcrProxyHandler>): Promise<string> {
  const server = createServer((req, res) => void handler(req, res, ctx))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

function ready(): Response {
  return Response.json({
    release: 'worker-r1',
    protocol_major: 1,
    capabilities: { modes: ['pp', 'hybrid', 'vl'] },
  })
}

async function post(
  base: string,
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: AUTH, ...headers },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

describe('ocrProxy', () => {
  test('fails closed when worker configuration is absent', async () => {
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        workerBaseUrl: '',
        workerToken: '',
        expectedRelease: '',
        ticketKeys: '',
      }),
    )
    const response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket: 'x' }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 503)
  })

  test('streams submit, returns opaque ticket, then status/cancel/result without leaking worker id', async () => {
    const uploaded: Buffer[] = []
    const calls: string[] = []
    const large = Buffer.from('完整结果\n'.repeat(40_000))
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      if (path === '/ready') return ready()
      if (path === '/v1/jobs') {
        for await (const chunk of init?.body as any) uploaded.push(Buffer.from(chunk))
        assert.equal((init?.headers as Record<string, string>)['x-ocr-owner'].includes('42'), false)
        return Response.json(
          { job_id: 'remote-job-secret', status: 'queued', queue_position: 1 },
          { status: 202 },
        )
      }
      if (path.endsWith('/cancel'))
        return Response.json({
          job_id: 'remote-job-secret',
          status: 'running',
          phase: 'cancelling',
        })
      if (path.endsWith('/result'))
        return new Response(large, { headers: { 'content-length': String(large.length) } })
      return Response.json({
        job_id: 'remote-job-secret',
        status: 'running',
        pages_done: 12,
        pages_total: 100,
      })
    }) as typeof fetch
    const handler = makeOcrProxyHandler({
      identityRepo: repo(),
      fetchImpl: mockFetch,
      workerBaseUrl: 'http://worker',
      workerToken: 'worker-token',
      expectedRelease: 'worker-r1',
      ticketKeys: KEYS,
      ownerSecret: OWNER_SECRET,
    })
    const base = await listen(handler)
    const submitted = await post(base, '/v3/ocr/submit', Buffer.from('stream-me'), {
      'content-type': 'application/pdf',
      'content-length': '9',
      'x-ocr-filename': 'scan.pdf',
      'x-ocr-mode': 'hybrid',
      'x-ocr-fallback': '0.1',
    })
    assert.equal(submitted.status, 202)
    const submitBody = (await submitted.json()) as any
    assert.equal(Buffer.concat(uploaded).toString(), 'stream-me')
    assert.equal(submitBody.ticket.includes('remote-job-secret'), false)
    const jobBody = JSON.stringify({ ticket: submitBody.ticket })
    let response = await post(base, '/v3/ocr/status', jobBody, {
      'content-type': 'application/json',
    })
    const status = (await response.json()) as any
    assert.equal(status.pages_done, 12)
    assert.equal(status.job_id, undefined)
    response = await post(base, '/v3/ocr/cancel', jobBody, { 'content-type': 'application/json' })
    assert.equal(((await response.json()) as any).phase, 'cancelling')
    response = await post(
      base,
      '/v3/ocr/result',
      JSON.stringify({ ticket: submitBody.ticket, format: 'markdown' }),
      { 'content-type': 'application/json' },
    )
    assert.equal(Buffer.from(await response.arrayBuffer()).equals(large), true)
    assert.deepEqual(calls, [
      '/ready',
      '/v1/jobs',
      '/ready',
      '/v1/jobs/remote-job-secret',
      '/ready',
      '/v1/jobs/remote-job-secret/cancel',
      '/ready',
      '/v1/jobs/remote-job-secret/result',
    ])
  })

  test('rejects ticket tampering and a ticket presented by another user', async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname === '/ready') return ready()
      return Response.json({ job_id: 'job-1', status: 'queued' }, { status: 202 })
    }) as typeof fetch
    const deps = {
      fetchImpl: mockFetch,
      workerBaseUrl: 'http://worker',
      workerToken: 'token',
      expectedRelease: 'worker-r1',
      ticketKeys: KEYS,
      ownerSecret: OWNER_SECRET,
    }
    const base = await listen(makeOcrProxyHandler({ ...deps, identityRepo: repo(42) }))
    const submitted = await post(base, '/v3/ocr/submit', Buffer.from('x'), {
      'content-length': '1',
    })
    const ticket = String(((await submitted.json()) as any).ticket)
    const parts = ticket.split('.')
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`
    const tampered = parts.join('.')
    let response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket: tampered }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 403)
    const other = await listen(makeOcrProxyHandler({ ...deps, identityRepo: repo(43) }))
    response = await post(other, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 403)
  })

  test('old ticket key keeps the same opaque owner through key rotation', async () => {
    const oldKey = `old:${randomBytes(32).toString('base64')}`
    const newKey = `new:${randomBytes(32).toString('base64')}`
    let submitOwner = ''
    let statusOwner = ''
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/ready') return ready()
      const headers = init?.headers as Record<string, string>
      if (path === '/v1/jobs') {
        submitOwner = headers['x-ocr-owner']
        return Response.json({ job_id: 'job-before-rotation', status: 'queued' }, { status: 202 })
      }
      statusOwner = headers['x-ocr-owner']
      return Response.json({ job_id: 'job-before-rotation', status: 'running' })
    }) as typeof fetch
    const shared = {
      identityRepo: repo(),
      fetchImpl: mockFetch,
      workerBaseUrl: 'http://worker',
      workerToken: 'token',
      expectedRelease: 'worker-r1',
      ownerSecret: OWNER_SECRET,
    }
    const before = await listen(makeOcrProxyHandler({ ...shared, ticketKeys: oldKey }))
    const submitted = await post(before, '/v3/ocr/submit', Buffer.from('x'), {
      'content-length': '1',
    })
    const ticket = String(((await submitted.json()) as any).ticket)
    const after = await listen(
      makeOcrProxyHandler({ ...shared, ticketKeys: `${newKey},${oldKey}` }),
    )
    const response = await post(after, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 200)
    assert.equal(submitOwner, statusOwner)
  })

  test('exact worker release pin fails closed', async () => {
    const mockFetch = (async () =>
      Response.json({
        release: 'wrong',
        protocol_major: 1,
        capabilities: { modes: ['pp', 'hybrid', 'vl'] },
      })) as typeof fetch
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        fetchImpl: mockFetch,
        workerBaseUrl: 'http://worker',
        workerToken: 'token',
        expectedRelease: 'worker-r1',
        ticketKeys: KEYS,
        ownerSecret: OWNER_SECRET,
      }),
    )
    const response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket: 'bad' }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 503)
  })
})
