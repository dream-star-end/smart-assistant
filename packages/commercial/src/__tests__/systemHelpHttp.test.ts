import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import type { QueryRunner } from '../db/queries.js'
import { SystemOperationRegistry } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { makeInternalSystemActionsHandler, INTERNAL_SYSTEM_ACTIONS_PATH } from '../system-assistant/internalHttp.js'
import { SystemHelpGrantSigner, type SystemHelpIdentityScope } from '../system-assistant/helpGrant.js'
async function fixture(t: import('node:test').TestContext, realIdentityCheck = false) {
  const scope: SystemHelpIdentityScope = { uid: '765', containerId: '123', sessionId: 'synthetic-session', agentId: 'main', dispatchId: randomUUID(), attemptNo: 1, ownerId: randomUUID(), dispatchLeaseEpoch: '7' }
  const key = randomBytes(32)
  let now = 1000000
  const grants = new SystemHelpGrantSigner(key, () => now)
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-system-help-http-')), 'ledger.sqlite'), key })
  key.fill(0)
  let effects = 0
  let queries = 0
  let active = true
  let ownerId = scope.ownerId
  const empty = z.object({}).strict()
  const registry = new SystemOperationRegistry([
    { id: 'fixture.read', version: 1, title: '隔离读取', topic: 'fixture', executor: 'master', effect: 'read', roles: ['user'], input: {}, schema: empty,
      authorize: async actor => { assert.equal(actor.userId, '765'); assert.equal(actor.sessionId, scope.sessionId) }, read: async () => ({ enabled: true }) },
    { id: 'fixture.write', version: 1, title: '隔离写入', topic: 'fixture', executor: 'master', effect: 'write', roles: ['user'], input: {}, schema: empty, frozenSchema: empty,
      authorize: async () => {}, authorizeExecution: async () => {}, prepare: async () => ({ args: {}, resourceKey: 'synthetic-resource', expectedVersion: '1', preview: {
        title: '隔离写入', description: '', scope: '测试', before: [], after: [], destructive: false, consequences: [], price: { kind: 'none', label: '无费用' },
      } }), execute: async () => { effects++; return { summary: '隔离执行', completion: 'done' } } },
  ])
  const service = new SystemActionsService(ledger, registry, randomUUID())
  const runner: QueryRunner = { async query(_sql, params) {
    queries++
    for (const predicate of ["td.status IN ('admitted','accepted')", 'td.producer_fenced_at IS NULL', 'td.terminal_at IS NULL', 'u.deleted_at IS NULL', 'cs.deleted_at IS NULL', 'td.lease_epoch=$6::bigint']) assert.ok(_sql.includes(predicate))
    assert.equal(_sql.includes('lease_until'), false)
    const p = params ?? []
    const matches = active && p[0] === scope.dispatchId && p[1] === scope.attemptNo && p[2] === scope.uid && p[3] === scope.containerId && p[4] === ownerId && p[5] === scope.dispatchLeaseEpoch && p[6] === scope.sessionId && p[7] === scope.agentId && (p[8] === null || p[8] === '12')
    return { rows: matches ? [{ user_id: '765', role: 'user', session_id: scope.sessionId, agent_id: 'main', dispatch_id: scope.dispatchId, attempt_no: 1, owner_id: ownerId, dispatch_lease_epoch: '7', security_epoch: '12' }] : [] } as never
  } }
  const handle = makeInternalSystemActionsHandler({ identityRepo: { findActiveByHostAndBoundIp: async () => null }, runner, service, grants, track: f => f(new AbortController().signal),
    ...(realIdentityCheck ? {} : { verify: async () => ({ userId: 765, containerId: 123, boundIp: '127.0.0.1', hostUuid: 'synthetic-host' }) }),
  })
  const server = createServer((req, res) => { void handle(req, res, { hostUuid: 'synthetic-host', boundIp: '127.0.0.1' }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const port = address.port
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); grants.close(); ledger.close() })
  async function call<T = Record<string, unknown>>(body: unknown, method = 'POST'): Promise<{ status: number; body: T }> {
    return await new Promise<{ status: number; body: T }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: INTERNAL_SYSTEM_ACTIONS_PATH, method, headers: { 'content-type': 'application/json' } }, res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c)); res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject); req.end(JSON.stringify(body))
    })
  }
  const bootstrap = grants.issueBootstrap(scope).token
  return { call, bootstrap, grants, scope, service, effects: () => effects, queries: () => queries,
    stop: () => { active = false }, takeover: () => { ownerId = randomUUID() }, advance: () => { now += 60001 } }
}
test('a real server bootstrap creates a short read/prepare grant; preparation itself never executes', async t => {
  const f = await fixture(t)
  const refreshed = await f.call<{ token: string }>({ kind: 'refresh', bootstrap: f.bootstrap })
  assert.equal(refreshed.status, 200)
  const grant = refreshed.body.token
  const catalog = await f.call<{ items: { id: string }[] }>({ kind: 'catalog', grant })
  assert.deepEqual(catalog.body.items.map(x => x.id), ['fixture.read', 'fixture.write'])
  assert.deepEqual((await f.call({ kind: 'read', grant, operationId: 'fixture.read', args: {} })).body, { enabled: true })
  const proposed = await f.call<{ id: string; state: string }>({ kind: 'prepare', grant, operationId: 'fixture.write', args: {}, idempotencyKey: randomUUID() })
  assert.equal(proposed.status, 200); assert.equal(proposed.body.state, 'prepared'); assert.equal(f.effects(), 0)
  assert.equal(f.service.result('765', proposed.body.id).state, 'prepared')
  assert.equal((await f.call({ kind: 'confirm', grant, proposalId: proposed.body.id })).status, 400)
  assert.equal((await f.call({ kind: 'execute', grant, proposalId: proposed.body.id })).status, 400)
  assert.equal(f.effects(), 0)
})
test('scope cannot override actor, cross user, skip a container identity, or use bootstrap directly for reads', async t => {
  const f = await fixture(t)
  const refreshed = await f.call<{ token: string }>({ kind: 'refresh', bootstrap: f.bootstrap })
  assert.equal((await f.call({ kind: 'read', grant: refreshed.body.token, operationId: 'fixture.read', uid: '765' })).status, 400)
  assert.equal((await f.call({ kind: 'read', grant: f.bootstrap, operationId: 'fixture.read' })).status, 403)
  const other = f.grants.issue({ ...f.scope, uid: '8000000000000000000', securityEpoch: '12' }).token
  const before = f.queries()
  assert.equal((await f.call({ kind: 'catalog', grant: other })).status, 403)
  assert.equal(f.queries(), before)
  const unauthenticated = await fixture(t, true)
  assert.equal((await unauthenticated.call({ kind: 'refresh', bootstrap: unauthenticated.bootstrap })).status, 401)
})
test('same-attempt owner takeover invalidates original bootstrap and short grant without reminting new owner', async t => {
  const f = await fixture(t)
  const fresh = await f.call<{ token: string }>({ kind: 'refresh', bootstrap: f.bootstrap })
  f.takeover()
  assert.equal((await f.call({ kind: 'catalog', grant: fresh.body.token })).status, 403)
  assert.equal((await f.call({ kind: 'refresh', bootstrap: f.bootstrap })).status, 403)
  assert.equal(f.effects(), 0)
})
test('expired short grants can only refresh while their original durable producer is still live', async t => {
  const f = await fixture(t)
  const fresh = await f.call<{ token: string }>({ kind: 'refresh', bootstrap: f.bootstrap })
  f.advance()
  assert.equal((await f.call({ kind: 'catalog', grant: fresh.body.token })).status, 403)
  assert.equal((await f.call({ kind: 'refresh', bootstrap: f.bootstrap })).status, 200)
  f.stop()
  assert.equal((await f.call({ kind: 'refresh', bootstrap: f.bootstrap })).status, 403)
  assert.equal(f.effects(), 0)
})
