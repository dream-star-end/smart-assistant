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
  rmSync(dir, {recursive: true, force: true})
 })
 return {dir, db, jobs, gw, owner, parent, turn, id, create, delivery, requests: () => requests, body: () => body,
  hide: () => {visible = undefined}, receipt: (job = id) => db.getDeliveryReceipt(job, 0)!,
  dispatch: () => gw._dispatchDelegateNotify(jobs.snapshotOf(id))}
}

test('kernel evidence: living parent/foreign namespace unknown; actual child death inactive', async () => {
 const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'})
 const closed = once(child, 'close')
 try {
  const descriptor = captureReceiptParentProcess(child.pid)
  assert.ok(descriptor); assert.equal(receiptParentDeathState(descriptor), 'unknown')
  assert.equal(receiptParentDeathState({...descriptor, pidNamespace: 'pid:[0]'}), 'unknown')
  assert.equal(receiptParentDeathState({...descriptor, startTicks: '-1'}), 'unknown')
  child.kill('SIGKILL'); await closed
  assert.equal(receiptParentDeathState(descriptor), 'inactive')
 } finally { child.kill('SIGKILL'); await closed }
})

test('actual gateway terminal dispatch holds active parent; real adapter turn-end then notifies once', async t => {
 const f = await fixture(t)
 await f.dispatch(); assert.equal(f.requests(), 0); assert.equal(f.receipt().state, 'offered')
 f.turn.end(); await f.dispatch(); assert.equal(f.requests(), 1); assert.match(f.body(), /RECOVERY_AUTHORITATIVE_RESULT/)
 assert.equal(f.receipt().state, 'notified'); assert.equal(f.jobs.snapshotOf(f.id)!.callbackState, 'delivered')
 await f.dispatch(); assert.equal(f.requests(), 1)
})

test('turn-end adoption uses receipt recovery rather than legacy callback mutation', async t => {
 const f = await fixture(t); f.turn.end()
 await f.gw._adoptOrphanedStdoutWaitDelegates(SESSION, {userId: 'default'})
 assert.equal(f.requests(), 1); assert.equal(f.receipt().state, 'notified')
})

test('restart/retry missing parent with living process remains unknown; confirmed dead process recovers', async t => {
 const f = await fixture(t); f.hide()
 await f.gw._retryDelegateNotifies(); assert.equal(f.requests(), 0); assert.equal(f.receipt().state, 'offered')
 const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}), closed = once(child,'close')
 const descriptor = captureReceiptParentProcess(child.pid); assert.ok(descriptor)
 const id = f.create({...f.owner, parentProcess: descriptor})
 child.kill('SIGKILL'); await closed
 await f.gw._retryDelegateNotifies(); assert.equal(f.requests(), 1); assert.equal(f.receipt(id).state, 'notified')
 assert.equal(f.receipt().state, 'offered')
})

test('legacy missing descriptor and mismatched user are unknown, never parent-dead guesses', async t => {
 const f = await fixture(t, false); f.turn.end()
 await f.dispatch(); assert.equal(f.requests(),0); assert.equal(f.receipt().state,'offered')
 f.create(f.owner); f.parent.userId = 'other-user'
 await f.gw._retryDelegateNotifies(); assert.equal(f.requests(),0)
})

for (const mode of ['present','absent','malformed','wrong-epoch'] as const) {
 test(`gateway recovery uses actual Bun native oracle: ${mode}`, async t => {
  const f = await fixture(t)
  const uuid = randomUUID(), file = join(f.dir,'native.jsonl')
  const line = JSON.stringify({type:'user', uuid, sessionId:f.owner.nativeSessionId, isSidechain:false, parentUuid:null,
   timestamp:new Date().toISOString(), message:{role:'user',content:[{type:'tool_result',tool_use_id:'creator',content:'RECOVERY_AUTHORITATIVE_RESULT'}]}})
  writeFileSync(file, mode==='malformed' ? line.slice(0,-1) : mode==='absent' ? '' : line+'\n')
  const proof = {nativeSessionId:f.owner.nativeSessionId,recordLocator:JSON.stringify([file,uuid]),recordHash:hash(line)}
  await assert.rejects(f.delivery.ingest(f.receipt(), {parentOwnerEpoch:mode==='wrong-epoch'?'different':f.owner.parentOwnerEpoch,
   proof,isCurrentParentOwner:async()=>true},async()=>{throw Error('lost ACK')},async()=>({kind:'unknown'})))
  f.turn.end(); await f.dispatch()
  assert.equal(f.requests(),mode==='absent'?1:0)
  assert.equal(f.receipt().state,mode==='present'?'ingested':mode==='absent'?'notified':'ingest_claimed')
 })
}


test('actual timed-out Bun oracle keeps the receipt flock until its kernel process closes', async t => {
 const f = await fixture(t)
 const proof = {nativeSessionId:f.owner.nativeSessionId, recordLocator:JSON.stringify([join(f.dir,'missing.jsonl'),randomUUID()]),recordHash:hash('absent')}
 await assert.rejects(f.delivery.ingest(f.receipt(), {parentOwnerEpoch:f.owner.parentOwnerEpoch,proof,isCurrentParentOwner:async()=>true},
  async()=>{throw Error('lost writer')},async()=>({kind:'unknown'})))
 f.turn.end()
 const realSpawn = childProcess.spawn, realSetTimeout = global.setTimeout
 let resolveSpawn!: (child: ChildProcess) => void
 const started = new Promise<ChildProcess>(r=>{resolveSpawn=r})
 let observed: ChildProcess | undefined, closed = false
 const spy = t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof realSpawn>) => {
  const child = realSpawn(...args)
  if (args[0]==='bun') {
   observed=child; child.once('close',()=>{closed=true})
   child.once('spawn',()=>{child.kill('SIGSTOP');resolveSpawn(child)})
  }
  return child
 }) as typeof realSpawn)
 syncBuiltinESMExports()
 const timer = t.mock.method(global, 'setTimeout', ((handler: (...a: any[])=>void, delay?: number, ...args: any[]) =>
  realSetTimeout(handler,delay===60000?500:delay,...args)) as typeof setTimeout)
 const recovery = f.gw._recoverDelegateReceipt(f.jobs.snapshotOf(f.id)) as Promise<void>
 try {
  const child=await started; assert.ok(child.pid)
  await assert.rejects(f.db.withDeliveryReceiptBarrier(f.id,0,async()=>{}, {timeoutMs:30}),/flock failed|timed out/)
  assert.equal(closed,false)
  await recovery
  assert.equal(closed,true); assert.equal(child.signalCode,'SIGKILL')
  assert.equal(f.requests(),0); assert.equal(f.receipt().state,'ingest_claimed')
 } finally {
  observed?.kill('SIGKILL'); await recovery
  spy.mock.restore(); timer.mock.restore(); syncBuiltinESMExports()
 }
})

test('active old native owner during platform turn transition remains unknown', async t => {
 const f=await fixture(t);f.parent._currentTurnKey='next-platform-turn'
 await f.dispatch();assert.equal(f.requests(),0);assert.equal(f.receipt().state,'offered')
})
