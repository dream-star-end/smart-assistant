import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemOperation, type SystemActor } from '../system-assistant/operations.js'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const principal: BrowserConfirmationPrincipal = { id: '765', role: 'user', accessJti: 'synthetic-access-jti', accessExpiresAt: 9_999_999_999, refreshFamilyId: randomUUID(), refreshSessionId: '91' }
function fixture(t: import('node:test').TestContext, overrides: Partial<SystemOperation> = {}) {
  let amount = 0
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-system-service-')), 'ledger.sqlite'), key: randomBytes(32) })
  t.after(() => ledger.close())
  const operation: SystemOperation = {
    id: 'fixture.change', version: 1, title: '测试操作', topic: 'fixture', effect: 'write', executor: 'master', roles: ['user', 'admin'], input: { amount: 'positive number in units' },
    schema: z.object({ amount: z.number().positive().transform(n => n * 100) }).strict(),
    frozenSchema: z.object({ amount: z.number().positive().int() }).strict(),
    authorize: async () => {}, authorizeExecution: async () => {},
    prepare: async (_actor, raw) => ({ args: raw, resourceKey: 'synthetic-resource', expectedVersion: '1', preview: {
      title: '测试操作', description: '隔离夹具，不付款。', scope: '测试数据', before: [], after: [{ label: '数量', value: String((raw as { amount: number }).amount) }],
      consequences: ['不访问真实用户或模型。'], price: { kind: 'none', label: '测试操作无费用' }, destructive: false,
    } }),
    execute: async (_actor, execution) => { amount += (execution.args as { amount: number }).amount; return { summary: '测试已完成', completion: 'done' } },
    ...overrides,
  }
  const registry = new SystemOperationRegistry([operation])
  const service = new SystemActionsService(ledger, registry, randomUUID())
  return { ledger, registry, service, operation, amount: () => amount }
}
async function proposal(f: ReturnType<typeof fixture>) {
  const action = await f.service.prepare(actor, 'fixture.change', { amount: 1 }, randomUUID())
  const deviceId = randomUUID()
  const detail = f.service.detail(actor.userId, action.id)
  const { nonce } = f.service.challenge(principal, action.id, deviceId, detail.previewHash)
  return { id: action.id, proof: { nonce, deviceId, previewHash: detail.previewHash } }
}
test('frozen execution validates without applying the public units conversion a second time', async t => {
  const f = fixture(t)
  const p = await proposal(f)
  assert.equal(f.amount(), 0)
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'succeeded')
  assert.equal(f.amount(), 100)
  const replay = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in replay && replay.state, 'succeeded')
  assert.equal(f.amount(), 100)
})
test('a transforming frozen validator is rejected before an approval can be created', async t => {
  const f = fixture(t, { frozenSchema: z.object({ amount: z.number().transform(n => n * 100) }).strict() })
  await assert.rejects(f.service.prepare(actor, 'fixture.change', { amount: 1 }, randomUUID()), e => e instanceof SystemOperationRejected && e.code === 'INVALID_INPUT')
  assert.equal(f.amount(), 0)
})
test('a changed access identity cannot reuse the prior confirmation challenge', async t => {
  const f = fixture(t); const p = await proposal(f)
  await assert.rejects(f.service.confirm({ ...principal, accessJti: 'new-synthetic-jti' }, p.id, p.proof))
  assert.equal(f.amount(), 0)
  assert.equal(f.service.result('765', p.id).state, 'prepared')
  await f.service.confirm(principal, p.id, p.proof)
  assert.equal(f.amount(), 100)
})
test('permissions are rechecked on frozen execution and a known rejection has no business effect', async t => {
  const f = fixture(t, { authorizeExecution: async () => { throw new SystemOperationRejected('FORBIDDEN') } })
  const p = await proposal(f)
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'failed')
  assert.equal(f.amount(), 0)
})
test('an ambiguous business outcome blocks a new key without re-executing', async t => {
  let effects = 0
  const f = fixture(t, { execute: async () => { effects++; throw new Error('synthetic receipt lost') } })
  const p = await proposal(f)
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'unknown')
  await assert.rejects(f.service.prepare(actor, 'fixture.change', { amount: 1 }, randomUUID()))
  assert.equal(effects, 1)
})
test('draining stops new approvals and waits for the existing business execution', async t => {
  let release!: () => void
  let entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const f = fixture(t, { execute: async () => { entered(); await barrier; return { summary: '隔离测试完成', completion: 'done' } } })
  const p = await proposal(f)
  const work = f.service.confirm(principal, p.id, p.proof)
  await running
  let drained = false
  const drain = f.service.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  await assert.rejects(f.service.confirm(principal, p.id, p.proof), e => e instanceof SystemOperationRejected && e.code === 'UNAVAILABLE')
  release(); await work; await drain
  assert.equal(drained, true)
})
