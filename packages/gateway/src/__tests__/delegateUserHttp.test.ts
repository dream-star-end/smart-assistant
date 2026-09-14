/** Actual Gateway.handleHttp + private durable SQLite; no SDK/source-retry claim. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'delegate-user-http-'))
process.env.OPENCLAUDE_HOME = home
const { Gateway } = await import('../server.js')
const { DelegateDurableDb } = await import('../delegateDurable.js')
const { DelegateJobStore } = await import('../delegateJobs.js')
const { signJwt } = await import('../auth.js')
const TOKEN = 'delegate-user-private-test-key'
const auth = (userId: string, exp = Math.floor(Date.now() / 1000) + 60) => 'Bearer ' + signJwt({ userId, exp }, TOKEN)
async function fixture() {
  const path = join(mkdtempSync(join(home, 'case-')), 'delegate.db')
  let now = 1000000
  let db = new DelegateDurableDb(path)
  let jobs = new DelegateJobStore({ durable: db, sm: true, failureInbox: true, ttlMs: 1000, now: () => now })
  const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
    defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } })
  const bind = () => { (gw as unknown as { _delegateJobs: typeof jobs })._delegateJobs = jobs }
  bind()
  const server = createServer((req, res) => { void (gw as any).handleHttp(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/delegates/`
  async function call(path: string, body?: unknown, authorization = auth('alice')) {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, data: await res.json() as any, cache: res.headers.get('cache-control') }
  }
  function create(userId = 'alice', state: 'failed' | 'running' | 'queued' = 'failed') {
    const made = jobs.create('worker', { callbackOriginUserId: userId, parentSessionKey: 'agent:main:webchat:dm:private-' + userId,
      sessionKey: 'agent:worker:delegate:main:1:private', callback: 'none', queued: state === 'queued' })
    assert.ok('jobId' in made)
    const snap = jobs.snapshotOf(made.jobId)!
    if (state === 'failed') assert.equal(jobs.fail(made.jobId, { failureClass: 'child_error', detail: 'PRIVATE_RAW_SECRET_DETAIL',
      httpStatus: 500, claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch }), true)
    return made.jobId
  }
  return { gw, server, base, call, create, get db() { return db }, get jobs() { return jobs },
    expire: () => { now += 1001; return jobs.sweep() },
    reopen: () => { jobs.close(); db.close(); db = new DelegateDurableDb(path); jobs = new DelegateJobStore({ durable: db, sm: true, failureInbox: true, now: () => now }); bind() },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); jobs.close(); db.close() } }
}
test('actual HTTP retains all 55 failures after runtime TTL/reopen; tied cursor and summary are user-scoped', async () => {
  const f = await fixture()
  try {
    const ids = new Set(Array.from({ length: 55 }, () => f.create()))
    for (let i = 0; i < 3; i++) f.create('bob')
    assert.equal(f.expire(), 58); f.reopen()
    for (const id of ids) assert.equal(f.jobs.snapshotOf(id), undefined)
    const first = await f.call('inbox?limit=50')
    assert.equal(first.status, 200); assert.equal(first.cache, 'no-store'); assert.equal(first.data.count, 55); assert.equal(first.data.items.length, 50)
    const second = await f.call('inbox?limit=50&before=' + first.data.nextCursor)
    assert.equal(second.status, 200); assert.equal(second.data.items.length, 5); assert.equal(second.data.nextCursor, null)
    assert.deepEqual(new Set([...first.data.items, ...second.data.items].map(row => row.jobId)), ids)
    assert.equal(JSON.stringify(first.data).includes('PRIVATE_RAW_SECRET_DETAIL'), false)
    assert.ok(first.data.items.every((row: any) => !('userId' in row) && !('childSession' in row) && row.retry.available === false))
    assert.equal((await f.call('inbox', undefined, auth('bob'))).data.count, 3)
    f.create('alice', 'running'); f.create('alice', 'running'); f.create('alice', 'queued'); f.create('bob', 'running')
    assert.deepEqual((await f.call('summary')).data, { version: 1, available: true, running: 2, queued: 1, unacknowledgedFailures: 55 })
  } finally { await f.close() }
})
test('ACK survives TTL and repeated concurrent tabs; foreign/missing never mutate it', async () => {
  const f = await fixture()
  try {
    const id = f.create(); f.expire(); f.reopen()
    assert.equal((await f.call(`inbox/${id}/ack`, { generation: 0 }, auth('bob'))).status, 404)
    assert.equal((await f.call('inbox/missing/ack', { generation: 0 })).status, 404)
    assert.equal((await f.call('inbox')).data.count, 1)
    const responses = await Promise.all([f.call(`inbox/${id}/ack`, { generation: 0 }), f.call(`inbox/${id}/ack`, { generation: 0 })])
    assert.ok(responses.every(r => r.status === 200 && r.data.acknowledged === true))
    f.reopen(); assert.equal((await f.call('inbox')).data.count, 0)
    assert.equal((await f.call(`inbox/${id}/ack`, { generation: 0 })).status, 200)
  } finally { await f.close() }
})
test('explicit user JWT only and strict inputs; raw service token is not default user', async () => {
  const f = await fixture()
  try {
    const id = f.create()
    assert.equal((await f.call('inbox', undefined, 'Bearer ' + TOKEN)).status, 401)
    assert.equal((await f.call('inbox', undefined, auth('alice', 1))).status, 401)
    for (const path of ['inbox?limit=51', 'inbox?limit=0', 'inbox?before=e30', 'inbox?userId=bob', 'summary?userId=bob']) assert.equal((await f.call(path)).status, 400)
    assert.equal((await f.call(`inbox/${id}/ack`, { generation: 0, userId: 'alice' })).status, 400)
    assert.equal((await f.call(`inbox/${id}/ack`, { generation: 0.5 })).status, 400)
    assert.equal((await f.call('inbox')).data.count, 1)
  } finally { await f.close() }
})
test('JWT expiry while actual HTTP body is pending cannot ACK as default', async () => {
  const f = await fixture()
  try {
    const id = f.create(), exp = Math.floor(Date.now() / 1000) + 2, body = JSON.stringify({ generation: 0 })
    const status = await new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const req = request(f.base + `inbox/${id}/ack`, { method: 'POST', headers: { authorization: auth('alice', exp),
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        res.resume(); res.on('end', () => { clearTimeout(timer); resolve(res.statusCode!) })
      })
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('body watchdog')))
      f.server.once('request', () => { timer = setTimeout(() => req.end(body.slice(1)), Math.max(1, exp * 1000 + 30 - Date.now())) })
      req.write(body.slice(0, 1))
    })
    assert.equal(status, 401); assert.equal((await f.call('inbox')).data.count, 1)
  } finally { await f.close() }
})
test('durable write failure is explicit503, not acknowledged/empty success', async () => {
  const f = await fixture()
  try {
    const id = f.create(); f.db.failNextWrite = true
    assert.equal((await f.call(`inbox/${id}/ack`, { generation: 0 })).status, 503)
    assert.equal((await f.call('inbox')).data.count, 1)
    f.db.close(); assert.equal((await f.call('summary')).status, 503)
  } finally { await f.close() }
})
