import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { EventEmitter, once } from 'node:events'
import childProcess, { spawn, type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Gateway } from '../server.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { DefaultEngineNotifier } from '../engineNotifier.js'
import { captureReceiptParentProcess, receiptParentDeathState } from '../receiptParentProcess.js'
import { ReceiptDeliveryStore } from '@openclaude/storage/receiptDeliveryStore'
import type { ReceiptToolOwner } from '../engine/engineAdapter.js'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const SESSION = 'agent:main:webchat:dm:receipt-recovery'
const TURN = 'receipt-recovery-turn'

async function fixture(t: TestContext, withParent = true) {
 const dir = mkdtempSync(join(tmpdir(), 'receipt-recovery-'))
 const old = { ...process.env }
 Object.assign(process.env, { OPENCLAUDE_HOME: dir, OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1', OC_DELEGATE_NOTIFIER: '1' })
 const sdk = new class extends EventEmitter {
  sessionId = randomUUID(); isRunning = true; receiptProcessIdentity = { pid: process.pid }
  setConsultTurn() {}
  async submit(_a: unknown, _b: unknown, _c: unknown, _d: unknown, bind: (p: object) => void) { bind(this.receiptProcessIdentity) }
  interrupt() { return true }
  async shutdown() { this.isRunning = false }
 }()
 const adapter = new CcbAdapter({ harness: 'ccb' } as never, sdk as never)
 const turn = adapter.submitTurn({ input: 'synthetic SDK only', turnKey: TURN, onEvent() {},
  sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
 await turn.submitted
 sdk.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'creator', name: 'Bash', input: {} }] } })
 const owner = adapter.getReceiptToolOwner('creator')!
 assert.ok(owner.parentProcess)
 const db = new DelegateDurableDb(join(dir, 'jobs.db'))
 const jobs = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: true })
 const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: 'synthetic' },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(dir, 'sessions.db') },
  defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
  agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } }) as any
 const parent = { userId: 'default', sessionKey: SESSION, agentId: 'main', _currentTurnKey: TURN, runner: adapter }
 let visible: typeof parent | undefined = parent
 gw.sessions = { getByKey: (key: string) => key === SESSION ? visible : undefined }
 gw._delegateJobs = jobs; gw._delegateReconcileReady = true
 let requests = 0, body = ''
 const receiver = createServer(async (req, res) => { for await (const b of req) body += b; requests++; res.end('{"ok":true}') })
 await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r))
 const port = (receiver.address() as {port: number}).port
 gw._engineNotifier = new DefaultEngineNotifier({resumeInject: {inject: async event => {
  const r = await fetch(`http://127.0.0.1:${port}`, {method: 'POST', body: JSON.stringify(event) }); return await r.json() as {ok: boolean}
 }}})
 const create = (saved: ReceiptToolOwner | undefined = withParent ? owner : undefined) => {
  const r = jobs.create('worker', { callback: 'stdout-wait', callbackOriginUserId: 'default', parentSessionKey: SESSION, parentEngine: 'ccb',
   deliveryReceipt: { parentTurnKey: TURN, nativeToolUseId: 'creator', receiptNonceHash: hash(randomUUID()),
    ...(saved ? {parent: {agentId: 'main', owner: saved}} : {}) } })
  assert.ok('jobId' in r)
  const initial = jobs.snapshotOf(r.jobId)!
  jobs.complete(r.jobId, {httpStatus: 200, body: {output: 'RECOVERY_AUTHORITATIVE_RESULT'}}, {claimToken: initial.claimToken!, fencingEpoch: initial.fencingEpoch})
  return r.jobId
 }
 const id = create()
 const delivery = new ReceiptDeliveryStore(db.path)
 t.after(async () => {
  clearTimeout(gw._notifyRetryTimer); turn.end(); receiver.closeAllConnections(); await new Promise<void>(r => receiver.close(() => r()))
  delivery.close(); jobs.close()
  for (const k of ['OPENCLAUDE_HOME', 'OC_DELEGATE_SM', 'OC_DELEGATE_DURABLE', 'OC_DELEGATE_NOTIFIER']) {
   if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]
  }
  // Keep private fixture directory while shared SQLite module retains its connection.
 })
 return {dir, db, jobs, gw, owner, parent, turn, id, create, delivery, requests: () => requests, body: () => body,
  hide: () => {visible = undefined}, receipt: (job = id) => db.getDeliveryReceipt(job, 0)!,
  dispatch: () => gw._dispatchDelegateNotify(jobs.snapshotOf(id))}
}


const sessionStorage = await import('../../../storage/src/sessionsDb.js')
async function seedParent() {
 await sessionStorage.upsertClientSession({ id: 'receipt-recovery', userId: 'default', agentId: 'main', title: 'private notify lifecycle', pinned: false,
  createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
}

test('deleted receipt parent suppresses terminal and original due-retry delivery; restart keeps ACK unchanged and timer bounded', async t => {
 const f = await fixture(t)
 await seedParent()
 assert.equal(await sessionStorage.deleteClientSession('receipt-recovery', 'default'), true)
 f.turn.end()
 await f.dispatch()
 assert.equal(f.requests(), 0)
 assert.notEqual(f.receipt().state, 'notified')
 const receiptState = f.receipt().state, callback = f.jobs.snapshotOf(f.id)!.callbackState
 const notBefore = f.gw._receiptNotifyNotBefore.get(f.gw._receiptNotifyKey(f.jobs.snapshotOf(f.id)))
 assert.ok(notBefore > Date.now())
 for (let i = 0; i < 3; i++) await f.gw._retryDelegateNotifies({ dueOnly: true })
 f.gw._armNotifyRetryScheduler()
 assert.ok(f.gw._notifyRetryTimer._idleTimeout >= 25_000, 'suppressed due job must not create a delay=0 busy timer')
 assert.equal(f.gw._receiptNotifyNotBefore.get(f.gw._receiptNotifyKey(f.jobs.snapshotOf(f.id))), notBefore)
 assert.equal(f.receipt().state, receiptState); assert.equal(f.jobs.snapshotOf(f.id)!.callbackState, callback)
 clearTimeout(f.gw._notifyRetryTimer)
 // New Gateway and rehydrated durable store, no live parent lookup or candidate scope needed.
 const restarted = new Gateway(f.gw.deps) as any
 const reopened = new DelegateJobStore({ durable: new DelegateDurableDb(f.db.path), sm: true, deliveryReceipts: true })
 restarted.sessions = { getByKey: () => undefined }; restarted._delegateJobs = reopened
 restarted._engineNotifier = f.gw._engineNotifier
 try {
  await restarted._dispatchDelegateNotify(reopened.snapshotOf(f.id))
  await restarted._retryDelegateNotifies({ dueOnly: true })
  restarted._armNotifyRetryScheduler()
  assert.equal(f.requests(), 0)
  assert.equal(f.receipt().state, receiptState); assert.equal(reopened.snapshotOf(f.id)!.callbackState, callback)
  assert.ok(restarted._notifyRetryTimer._idleTimeout >= 25_000)
 } finally { clearTimeout(restarted._notifyRetryTimer); reopened.close() }
})

test('foreign-user deletion attempt cannot suppress active receipt parent notification', async t => {
 const f = await fixture(t)
 // A distinct trusted parent key avoids reviving the previous deleted session.
 const peer = 'receipt-active-foreign', sessionKey = 'agent:main:webchat:dm:' + peer
 await sessionStorage.upsertClientSession({ id: peer, userId: 'default', agentId: 'main', title: 'private active', pinned: false,
  createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
 assert.equal(await sessionStorage.deleteClientSession(peer, 'foreign-user'), false)
 const r = f.jobs.create('worker', { callback: 'stdout-wait', callbackOriginUserId: 'default', parentSessionKey: sessionKey, parentEngine: 'ccb',
  deliveryReceipt: { parentTurnKey: TURN, nativeToolUseId: 'creator', receiptNonceHash: hash(randomUUID()), parent: { agentId: 'main', owner: f.owner } } })
 assert.ok('jobId' in r)
 const initial = f.jobs.snapshotOf(r.jobId)!
 f.jobs.complete(r.jobId, { httpStatus: 200, body: { output: 'ACTIVE_PRIVATE_RESULT' } }, { claimToken: initial.claimToken!, fencingEpoch: initial.fencingEpoch })
 f.gw.sessions = { getByKey: (key: string) => key === sessionKey ? { ...f.parent, sessionKey } : undefined }
 f.turn.end()
 await f.gw._dispatchDelegateNotify(f.jobs.snapshotOf(r.jobId))
 assert.equal(f.requests(), 1); assert.match(f.body(), /ACTIVE_PRIVATE_RESULT/)
 assert.equal(f.receipt(r.jobId).state, 'notified')
})
