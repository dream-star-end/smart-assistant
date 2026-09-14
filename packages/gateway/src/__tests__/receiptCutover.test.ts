import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

/** Real SQLite/CAS/HTTP. No claim of OS quiesce, model consumption or deployment. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore, type DelegateCreateMeta } from '../delegateJobs.js'
import { beginDelegateCutover, endDelegateCutover } from '../delegateCutover.js'
import { reconcileDelegateJobsOnBoot } from '../delegateReconciler.js'
import type { DelegateRetrySource } from '../delegateRetrySource.js'

const parent = 'agent:main:webchat:dm:private-cutover'
const receipt = { parentTurnKey: 'original-turn', nativeToolUseId: 'original-tool',
  receiptNonceHash: createHash('sha256').update('private-nonce').digest('hex') }
function fixture(t: TestContext) {
  const path = join(sandbox.root, 'cutover.db'), db = new DelegateDurableDb(path)
  let terminals = 0
  const store = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: true,
    bootId: 'private-owner', onTerminal: () => { terminals++ } })
  const sql = new Database(path)
  t.after(() => { store.close(); sql.close() })
  function create(extra: DelegateCreateMeta = {}) {
    const made = store.create('child', { queued: true, callbackOriginUserId: 'private-user',
      parentSessionKey: parent, callback: 'stdout-wait', deliveryReceipt: receipt, ...extra })
    assert.ok('jobId' in made)
    const fence = store.claimQueued(made.jobId); assert.ok(fence.ok)
    return { id: made.jobId, fence }
  }
  return { path, db, store, sql, create, terminals: () => terminals }
}

for (const idle of [true, false]) test(`bound cutover ${idle ? 'original idle ACK' : 'timeout'} retains one receipt; legacy still pauses`, async t => {
  const f = fixture(t), bound = f.create(), legacy = f.create({ deliveryReceipt: undefined, callback: 'origin-inject' })
  if (idle) assert.equal(f.store.ackRunnerQuiesced(bound.id, bound.fence.claimToken, bound.fence.fencingEpoch), true)
  const result = await beginDelegateCutover(f.store, { generation: 73, freezeBudgetMs: 0 })
  assert.equal(result.remainingRunning, 0); assert.equal(result.closedBound, 1); assert.equal(result.paused, 1)
  assert.equal(f.store.snapshotOf(bound.id)?.state, 'killed_by_cutover')
  assert.equal(f.store.snapshotOf(bound.id)?.generation, 0)
  assert.equal(f.store.complete(bound.id, { httpStatus: 200, body: { stale: true } }, bound.fence), false)
  const offered = f.db.getDeliveryReceipt(bound.id, 0)!
  assert.equal(offered.state, 'offered'); assert.equal(offered.parentTurnKey, receipt.parentTurnKey)
  assert.equal(offered.nativeToolUseId, receipt.nativeToolUseId); assert.equal(offered.receiptNonceHash, receipt.receiptNonceHash)
  assert.equal(f.db.listUnacknowledgedFailures('private-user').count, 1)
  assert.equal(f.terminals(), 1); assert.equal(endDelegateCutover(f.store, 73).closed, 1)
  assert.equal(f.store.snapshotOf(legacy.id)?.state, 'killed_by_cutover')
  assert.equal(endDelegateCutover(f.store, 73).closed, 0); assert.equal(f.terminals(), 2)
  const fresh = new DelegateJobStore({ durable: new DelegateDurableDb(f.path), sm: true, bootId: 'next-owner' })
  try {
    assert.equal(reconcileDelegateJobsOnBoot(fresh, { claimPaused: true }).scanned, 0)
    assert.equal(fresh.claimPaused(bound.id).ok, false)
    assert.equal(fresh.claimQueued(bound.id).ok, false)
    assert.equal(fresh.markResultConsumed(bound.id), false)
  } finally { fresh.close() }
})

test('source-only retry target retains public/storage identity and action terminal under cutover', async t => {
  const f = fixture(t)
  const source: DelegateRetrySource = { version: 1, userId: 'c:71', storageUserId: 'default',
    parentSessionKey: parent, parentClientSessionId: 'private-cutover', originSessionKey: parent,
    childSessionKey: 'agent:child:delegate:main:private', targetAgentId: 'child', sourceAgentId: 'main',
    depth: 0, model: 'gpt-6-astra' }
  const original = f.create({ deliveryReceipt: undefined, callbackOriginUserId: 'default',
    sessionKey: source.childSessionKey, retrySource: source })
  assert.equal(f.store.fail(original.id, { ...original.fence, failureClass: 'internal', detail: 'original failed', httpStatus: 500 }), true)
  const key = { userId: source.userId, sourceJobId: original.id, generation: 0, actionId: 'private-action-cutover-001' }
  const accepted = f.store.acceptRetryAction(key, source); assert.ok('kind' in accepted)
  assert.ok(f.store.claimQueued(accepted.action.targetJobId).ok)
  assert.equal((await beginDelegateCutover(f.store, { generation: 73, freezeBudgetMs: 0 })).closedBound, 1)
  assert.equal(f.db.get(accepted.action.targetJobId)?.generation, 0)
  assert.deepEqual(f.db.getRetrySource(source.userId, accepted.action.targetJobId, 0), source)
  assert.equal(f.db.getRetryAction(key)?.state, 'terminal')
  assert.equal(f.db.userSummary('c:71').unacknowledgedFailures, 2)
  assert.equal(f.db.userSummary('default').unacknowledgedFailures, 0)
  f.store.fenceDeletedRetryParent({ userId: 'default', clientSessionId: source.parentClientSessionId })
  assert.equal(f.db.userSummary('c:71').unacknowledgedFailures, 0)
})

test('queued during freeze keeps identity; natural completion wins without cutover result overwrite', async t => {
  const f = fixture(t), running = f.create()
  let queued = ''
  const result = await beginDelegateCutover(f.store, { generation: 73, freezeBudgetMs: 10,
    sleep: async () => {
      const made = f.store.create('child', { queued: true, callbackOriginUserId: 'private-user',
        parentSessionKey: parent, callback: 'stdout-wait', deliveryReceipt: receipt })
      assert.ok('jobId' in made); queued = made.jobId
      assert.deepEqual(f.store.claimQueued(queued), { ok: false, reason: 'cutover_frozen' })
      assert.equal(f.store.complete(running.id, { httpStatus: 200, body: { real: 'winner' } }, running.fence), true)
    } })
  assert.equal(result.completedDuring, 1); assert.equal(result.closedBound, 0)
  assert.deepEqual(f.db.get(running.id)?.result?.body, { real: 'winner' })
  assert.equal(f.db.get(queued)?.generation, 0); assert.equal(f.db.get(queued)?.state, 'queued')
  endDelegateCutover(f.store, 73); assert.ok(f.store.claimQueued(queued).ok)
})

test('cleanup isolates persistent failed legacy row and keeps other freeze holders', async t => {
  const f = fixture(t), bad = f.create({ deliveryReceipt: undefined }), good = f.create({ deliveryReceipt: undefined })
  await beginDelegateCutover(f.store, { generation: 73, freezeBudgetMs: 0 })
  f.store.freezeDispatch('drain:other')
  f.sql.exec(`CREATE TRIGGER private_fault BEFORE UPDATE ON delegate_jobs
    WHEN NEW.job_id='${bad.id}' AND NEW.state='killed_by_cutover' BEGIN SELECT RAISE(ABORT,'persistent terminal fault'); END`)
  const end = endDelegateCutover(f.store, 73)
  assert.equal(end.closed, 1); assert.equal(end.failed, 1); assert.equal(end.errors[0]?.jobId, bad.id)
  assert.equal(f.db.get(bad.id)?.state, 'paused_for_cutover'); assert.equal(f.db.get(good.id)?.state, 'killed_by_cutover')
  assert.equal(f.store.isDispatchFrozen(), true)
})

test('independent Node writer loaded before cutover cannot publish with its original fence', async t => {
  const f = fixture(t), job = f.create()
  const dbModule = fileURLToPath(new URL('../delegateDurable.ts', import.meta.url))
  const storeModule = fileURLToPath(new URL('../delegateJobs.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    import {DelegateDurableDb} from ${JSON.stringify(dbModule)};
    import {DelegateJobStore} from ${JSON.stringify(storeModule)};
    const db=new DelegateDurableDb(${JSON.stringify(f.path)}), s=new DelegateJobStore({durable:db,sm:true});
    try { assert.equal(db.get(${JSON.stringify(job.id)}).state,'running');
      console.log('READY'); await once(process.stdin,'data'); process.stdin.destroy();
      assert.equal(s.complete(${JSON.stringify(job.id)},{httpStatus:200,body:{late:true}},${JSON.stringify(job.fence)}),false);
      assert.equal(db.getDeliveryReceipt(${JSON.stringify(job.id)},0).state,'offered');
      assert.equal(db.get(${JSON.stringify(job.id)}).result.body.error,'delegate-cutover');
    } finally {s.close()}
  `], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: sandbox.root } })
  const closed = once(child, 'close'); let stdout = '', stderr = ''
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', b => { stdout += b; if (stdout.includes('READY\n')) resolve() })
      child.stderr.on('data', b => { stderr += b })
      child.once('error', reject)
      child.once('close', () => { if (!stdout.includes('READY\n')) reject(new Error(stderr || 'writer never ready')) })
    })
    await beginDelegateCutover(f.store, { generation: 73, freezeBudgetMs: 0 })
    child.stdin.end('GO\n')
    const [code] = await closed; assert.equal(code, 0, stderr); assert.equal(f.terminals(), 1)
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); await closed }
})

test('foreign owner bound writer cannot be silently paused or reported as successful cutover', async t => {
  const f = fixture(t), job = f.create()
  const foreign = new DelegateJobStore({ durable: new DelegateDurableDb(f.path), sm: true, bootId: 'foreign-owner' })
  try {
    await assert.rejects(beginDelegateCutover(foreign, { generation: 73, freezeBudgetMs: 0 }), /cutover incomplete/)
    assert.equal(f.db.get(job.id)?.state, 'running'); assert.equal(f.db.getDeliveryReceipt(job.id, 0), undefined)
    assert.equal(foreign.isDispatchFrozen(), false)
    assert.equal(foreign.closeBoundForCutover(job.id, job.fence), false)
    assert.equal(f.store.closeBoundForCutover(job.id, { ...job.fence, claimToken: 'stale' }), false)
  } finally { foreign.close() }
})

test('original Gateway HTTP survives persistent terminal AND cleanup fault with 503 and fresh recovery', async t => {
  sandbox.enableAllFlags()
  const nonce = randomBytes(32).toString('base64url')
  Object.assign(process.env, { OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1', OC_CONTAINER_ID: '991',
    OPENCLAUDE_INBOUND_NONCE: nonce, OC_DELEGATE_CUTOVER_FREEZE_MS: '0' })
  const f = fixture(t), legacy = f.create({ deliveryReceipt: undefined }), bound = f.create()
  assert.ok(f.store.ackRunnerQuiesced(legacy.id, legacy.fence.claimToken, legacy.fence.fencingEpoch))
  f.store.freezeDispatch('drain:other')
  f.sql.exec(`CREATE TRIGGER private_fault BEFORE UPDATE ON delegate_jobs
    WHEN NEW.state='killed_by_cutover' BEGIN SELECT RAISE(ABORT,'persistent terminal fault'); END`)
  const { Gateway } = await import('../server.js')
  const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: randomBytes(32).toString('hex') },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(sandbox.root, 'sessions.db') },
    defaults: { model: 'gpt-6-astra', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'gpt-6-astra' }], routes: [], default: 'main' } })
  ;(gw as any)._delegateJobs = f.store
  const unhandled: unknown[] = [], onUnhandled = (e: unknown) => { unhandled.push(e) }
  process.on('unhandledRejection', onUnhandled)
  const server = createServer((req, res) => { try { (gw as any).handleHttp(req, res) } catch (e) { unhandled.push(e); res.destroy() } })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const request = (route: string, headers: Record<string, string> = { 'x-openclaude-container-id': '991', 'x-openclaude-inbound-nonce': nonce }) =>
      fetch(base + route, { method: 'POST', headers, signal: AbortSignal.timeout(10000) })
    const failed = await request('/internal/v3/delegate-begin-cutover?generation=73')
    assert.equal(failed.status, 503); assert.equal((await failed.json() as any).ok, false)
    assert.equal((await request('/internal/v3/delegate-begin-cutover', {})).status, 401)
    assert.equal((await request('/internal/v3/delegate-end-cutover?generation=73')).status, 503)
    assert.deepEqual(unhandled, []); assert.equal(f.store.isDispatchFrozen(), true)
    assert.equal(f.db.get(legacy.id)?.state, 'paused_for_cutover'); assert.equal(f.db.get(bound.id)?.state, 'running')
    assert.equal(f.db.getDeliveryReceipt(bound.id, 0), undefined)
    assert.equal(f.db.userSummary('private-user').unacknowledgedFailures, 0); assert.equal(f.terminals(), 0)
    f.sql.exec('DROP TRIGGER private_fault')
    const freshDb = new DelegateDurableDb(f.path), fresh = new DelegateJobStore({ durable: freshDb, sm: true, bootId: 'fresh-owner' })
    try {
      reconcileDelegateJobsOnBoot(fresh, { now: () => Date.now() + 60000, isChildAlive: () => false })
      assert.equal(freshDb.get(bound.id)?.state, 'killed_by_cutover')
      assert.equal(freshDb.getDeliveryReceipt(bound.id, 0)?.state, 'offered')
      assert.equal(freshDb.get(bound.id)?.generation, 0)
    } finally { fresh.close() }
    assert.equal(f.store.thawDispatch('drain:other'), true)
    const next = f.create()
    const success = await request('/internal/v3/delegate-begin-cutover?generation=74')
    assert.equal(success.status, 200); const body = await success.json() as any
    assert.equal(body.remainingRunning, 0); assert.equal(body.closedBound, 1)
    assert.equal(f.db.getDeliveryReceipt(next.id, 0)?.state, 'offered')
    assert.deepEqual(unhandled, [])
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    process.off('unhandledRejection', onUnhandled)
  }
})
