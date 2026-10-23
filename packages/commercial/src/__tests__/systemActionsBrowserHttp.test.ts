import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import type { SystemActionDetail } from '@openclaude/protocol'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import { makeSystemActionsBrowserHandler } from '../system-assistant/browserHttp.js'
import { SystemOperationRegistry } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { signAccess, issueRefresh } from '../auth/jwt.js'
import { HttpError } from '../http/util.js'
import type { QueryRunner } from '../db/queries.js'
const origin = 'https://synthetic-browser.example'
const secret = 'synthetic-system-actions-http-secret-only'
async function fixture(t: import('node:test').TestContext) {
  let effects = 0, active = true
  const refresh = issueRefresh(), family = randomUUID()
  const access = await signAccess({ sub: '765', role: 'user' }, secret)
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-system-http-')), 'actions.db'), key: randomBytes(32) })
  const schema = z.object({ enabled: z.boolean() }).strict()
  const registry = new SystemOperationRegistry([{
    id: 'fixture.notification', version: 1, title: '隔离通知设置', topic: 'preferences', effect: 'write', executor: 'master', roles: ['user'],
    input: { enabled: 'boolean' }, schema, frozenSchema: schema, authorize: async () => {}, authorizeExecution: async () => {},
    prepare: async (_actor, args) => ({ args, resourceKey: 'fixture-preferences', expectedVersion: '1', preview: {
      title: '隔离通知设置', description: '只修改本测试的内存计数。', scope: '独立测试', before: [], after: [], destructive: false,
      consequences: ['不登录产品、不发送消息、不访问真实账号。'], price: { kind: 'none', label: '无费用' },
    } }),
    execute: async () => { effects++; return { summary: '隔离操作完成', completion: 'done' } },
  }])
  const service = new SystemActionsService(ledger, registry, randomUUID())
  const proposal = await service.prepare({ userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }, 'fixture.notification', { enabled: false }, randomUUID())
  const runner = { async query(sql: string, params: unknown[]) {
    assert.ok(sql.trimStart().startsWith('SELECT '))
    if (sql.includes('refresh_tokens')) {
      assert.deepEqual(params, [refresh.hash, '765'])
      return { rows: active ? [{ id: '765', role: 'user', refresh_session_id: '17', refresh_family_id: family }] : [] }
    }
    assert.deepEqual(params, ['765'])
    return { rows: active ? [{ role: 'user' }] : [] }
  } } as unknown as QueryRunner
  const handle = makeSystemActionsBrowserHandler({ service, runner, jwtSecret: secret, firstPartyOrigin: origin })
  const server: Server = createServer((req, res) => { void handle(req, res).catch(e => {
    res.statusCode = e instanceof HttpError ? e.status : 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: { code: e instanceof HttpError ? e.code : 'INTERNAL' } }))
  }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); ledger.close() })
  async function call<T = SystemActionDetail>(path: string, body?: unknown, options: { token?: string; cookie?: boolean } = {}) {
    const method = body === undefined ? 'GET' : 'POST'
    return await new Promise<{ status: number; body: T; cache: string | undefined }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: {
        authorization: `Bearer ${options.token ?? access.token}`,
        ...(options.cookie === false ? {} : { cookie: `oc_rt=${refresh.token}` }),
        origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cache: res.headers['cache-control'] }) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const read = `/api/me/system-actions/${proposal.id}`
  const write = `/api/auth/system-actions/${proposal.id}`
  return { call, read, write, id: proposal.id, effects: () => effects, deactivate: () => { active = false } }
}
test('only the real browser proof can approve; replay returns the original single effect and owner receipt', async t => {
  const f = await fixture(t), deviceId = randomUUID()
  const detail = await f.call(f.read)
  assert.equal(detail.status, 200); assert.equal(detail.cache, 'no-store'); assert.equal(detail.body.state, 'prepared')
  assert.equal('args' in detail.body, false); assert.equal('nonce' in detail.body, false)
  const input = { deviceId, previewHash: detail.body.previewHash }
  assert.equal((await f.call(`${f.write}/challenge`, input, { cookie: false })).status, 403)
  assert.equal((await f.call(`${f.write}/challenge`, { ...input, args: { enabled: true } })).status, 400)
  const challenge = await f.call<{ nonce: string }>(`${f.write}/challenge`, input)
  assert.equal(challenge.status, 200)
  const proof = { ...input, nonce: challenge.body.nonce }
  assert.equal((await f.call(`${f.write}/confirm`, proof, { cookie: false })).status, 403)
  assert.equal(f.effects(), 0)
  const done = await f.call(`${f.write}/confirm`, proof)
  assert.equal(done.status, 200); assert.equal(done.body.state, 'succeeded')
  assert.equal((await f.call(`${f.write}/confirm`, proof)).body.state, 'succeeded')
  assert.equal(f.effects(), 1)
  assert.equal((await f.call(`${f.read}/result`)).body.result?.completion, 'done')
})
test('refreshing access identity invalidates the old sheet and requires a newly fetched challenge', async t => {
  const f = await fixture(t), deviceId = randomUUID()
  const detail = await f.call(f.read), input = { deviceId, previewHash: detail.body.previewHash }
  const old = await f.call<{ nonce: string }>(`${f.write}/challenge`, input)
  const fresh = await signAccess({ sub: '765', role: 'user' }, secret)
  const stale = await f.call(`${f.write}/confirm`, { ...input, nonce: old.body.nonce }, { token: fresh.token })
  assert.equal(stale.status, 409); assert.equal(f.effects(), 0)
  const next = await f.call<{ nonce: string }>(`${f.write}/challenge`, input, { token: fresh.token })
  assert.equal((await f.call(`${f.write}/confirm`, { ...input, nonce: next.body.nonce }, { token: fresh.token })).body.state, 'succeeded')
  assert.equal(f.effects(), 1)
})
test('inactive accounts and altered privileged route/body data never execute', async t => {
  const f = await fixture(t)
  assert.equal((await f.call(`${f.write}/confirm`, { userId: '765', operationId: 'fixture.notification' })).status, 400)
  assert.equal((await f.call(`${f.write}/execute`, {})).status, 404)
  assert.equal((await f.call(f.read.replace(f.id, randomUUID()))).status, 404)
  f.deactivate()
  assert.equal((await f.call(f.read)).status, 403)
  assert.equal((await f.call(`${f.write}/deny`, {})).status, 403)
  assert.equal(f.effects(), 0)
})
