import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import type { QueryRunner } from '../db/queries.js'
import { openSystemActionsRuntime } from '../system-assistant/runtime.js'
import { SystemOperationRegistry } from '../system-assistant/operations.js'
import { loadOrCreateSystemActionKey } from '../system-assistant/privateState.js'
import { currentSystemActionExecutor, persistSystemActionExecutor } from '../system-assistant/executorIdentity.js'
const origin = 'https://synthetic-runtime.example'
const runner: QueryRunner = { async query() { throw new Error('this isolated runtime proof must not access PG') } }
function deps(stateParent: string) { return { stateParent, registry: new SystemOperationRegistry([]), jwtSecret: 'synthetic-runtime-proof-only', firstPartyOrigin: origin, runner } }
function parent() { return mkdtempSync(join(tmpdir(), 'oc-system-runtime-proof-')) }
test('an unsafe or missing first-party origin fails before private state is initialized', () => {
  const root = parent()
  assert.throws(() => openSystemActionsRuntime({ ...deps(root), firstPartyOrigin: 'http://untrusted.example' }))
  assert.equal(existsSync(join(root, 'system-actions')), false)
})
test('shutdown closes admission immediately and waits for already entered handlers before closing the ledger', async t => {
  const runtime = openSystemActionsRuntime(deps(parent()))
  t.after(() => runtime.closeAndDrain())
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let settled = false
  const entered = runtime.track(async () => { await barrier; return 'isolated completion' })
  const closing = runtime.closeAndDrain().then(() => { settled = true })
  await assert.rejects(runtime.track(async () => 'cannot enter'), /正在重启/)
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  assert.equal(await entered, 'isolated completion')
  await closing
  assert.equal(settled, true)
  assert.throws(() => runtime.grants.issueBootstrap({ uid: '765', containerId: '123', sessionId: 'synthetic-session', agentId: 'main', dispatchId: randomUUID(), attemptNo: 1, ownerId: randomUUID(), dispatchLeaseEpoch: '1' }))
  await runtime.closeAndDrain()
})
test('two simultaneously live incarnations share the stable key and do not recover one another', async t => {
  const root = parent()
  const first = openSystemActionsRuntime(deps(root))
  t.after(() => first.closeAndDrain())
  const second = openSystemActionsRuntime(deps(root))
  t.after(() => second.closeAndDrain())
  assert.notEqual(first.service.executorId, second.service.executorId)
  const bootstrap = first.issueBootstrap({ uid: '765', containerId: '123', sessionId: 'synthetic-session', agentId: 'main', dispatchId: randomUUID(), attemptNo: 1, ownerId: randomUUID(), dispatchLeaseEpoch: '1' })
  assert.equal(second.grants.verifyBootstrap(bootstrap.token).uid, '765')
  await first.closeAndDrain()
  assert.equal(second.grants.verifyBootstrap(bootstrap.token).uid, '765')
  assert.equal(await second.track(async () => 'second live'), 'second live')
})
test('startup changes only the definitely absent previous executor to unknown and never retries its operation', async t => {
  const stateParent = parent()
  const root = join(stateParent, 'system-actions')
  const key = loadOrCreateSystemActionKey(root)
  const ledger = new SystemActionStore({ dbPath: join(root, 'ledger.sqlite'), key })
  key.fill(0)
  // No real account/process is signalled or used; verify this fixture PID is absent.
  const old = { ...currentSystemActionExecutor(), id: randomUUID(), pid: 99_999_999 }
  assert.equal(existsSync(`/proc/${old.pid}`), false)
  persistSystemActionExecutor(root, old)
  const action = ledger.prepare({ userId: '765', sessionId: 'synthetic-session', agentId: 'main', operationId: 'fixture.no-retry', operationTitle: '隔离恢复', operationVersion: 1, executor: 'master', resourceKey: 'synthetic-resource', idempotencyKey: 'synthetic-original', args: {}, preview: {
    title: '隔离恢复', description: '', scope: '测试', before: [], after: [], consequences: [], destructive: false, price: { kind: 'none', label: '无费用' },
  } })
  const detail = ledger.detail('765', action.id)
  ledger.confirm('765', action.id, { deviceId: 'synthetic-device', previewHash: detail.previewHash, nonce: ledger.issueChallenge('765', action.id, 'synthetic-device', detail.previewHash) }, old.id)
  ledger.close()
  const runtime = openSystemActionsRuntime(deps(stateParent))
  t.after(() => runtime.closeAndDrain())
  const recovered = runtime.service.result('765', action.id)
  assert.equal(recovered.state, 'unknown')
  assert.equal(recovered.result?.code, 'EXECUTOR_LOST')
  assert.deepEqual(await runtime.service.registry.catalog({ userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }), { items: [], next: null })
})
