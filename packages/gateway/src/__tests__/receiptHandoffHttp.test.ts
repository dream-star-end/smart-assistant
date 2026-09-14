/** Real Gateway HTTP + CcbAdapter/parser, synthetic SDK process (no model/CLI).
 * Proves native identity and lifecycle, NOT receipt ingestion/notification ACK. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withReceiptWriteBarrier } from '@openclaude/storage/receiptWriteBarrier'
import type { SubprocessRunner } from '../subprocessRunner.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { TurnParams } from '../engine/engineAdapter.js'

const home = mkdtempSync(join(tmpdir(), 'receipt-owner-http-'))
process.env.OPENCLAUDE_HOME = home
const { Gateway } = await import('../server.js')
const { CcbAdapter } = await import('../engine/ccbAdapter.js')
const { SubprocessRunner: NativeRunner } = await import('../subprocessRunner.js')
const { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } = await import('../delegateContext.js')
const { signJwt } = await import('../auth.js')
const { ReceiptOwnerCapabilities } = await import('../receiptOwnerCapability.js')

const TOKEN = 'receipt-http-test-only-token'
const SESSION = 'agent:main:webchat:dm:receipt-http'
const TURN = 'server-owned-turn-1'
class SdkProcess extends EventEmitter {
  sessionId = 'native-ccb-session'
  isRunning = true
  receiptProcessIdentity: object = {}
  beforeInput?: () => void
  afterInput?: () => void
  submitGate: Promise<void> = Promise.resolve()
  shutdownGate: Promise<void> = Promise.resolve()
  setConsultTurn(): void {}
  async submit(_input?: unknown, _requestId?: string, _authority?: unknown, _turn?: string,
    onInput?: (identity: object) => void): Promise<void> {
    await this.submitGate
    this.beforeInput?.()
    onInput?.(this.receiptProcessIdentity)
    this.afterInput?.()
  }
  interrupt(): boolean { return true }
  async shutdown(): Promise<void> { await this.shutdownGate; this.isRunning = false }
  tool(id: string, name = 'Bash', parent?: string, input: Record<string, unknown> = {}): void {
    this.emit('message', { type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input }] } })
  }
}
function makeAdapter(harness: 'ccb' | 'official-cc' = 'ccb') {
  const process = new SdkProcess()
  const adapter = new CcbAdapter({ harness } as EngineCreateOpts, process as unknown as SubprocessRunner)
  return { process, adapter }
}
function start(adapter: InstanceType<typeof CcbAdapter>, turnKey: string | undefined = TURN) {
  return adapter.submitTurn({ input: 'synthetic SDK test', turnKey, onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    toolUseIdToName: new Map(),
  } as TurnParams)
}
async function fixture(userId = 'default') {
  const { process, adapter } = makeAdapter()
  const turn = start(adapter)
  await turn.submitted
  const parent: any = { agentId: 'main', sessionKey: SESSION, userId, _currentTurnKey: TURN, runner: adapter }
  let visibleParent: typeof parent | undefined = parent
  const gw = new Gateway({
    config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
      defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } },
    } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' },
  })
  // Only session lookup is a fixture. Request dispatch, auth, adapter and parser are real.
  ;(gw as any).sessions = { getByKey: (key: string) => key === SESSION ? visibleParent : undefined }
  const server = createServer((req, res) => (gw as any).handleHttp(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const context = issueDelegateContextToken({ agentId: 'main', sessionKey: SESSION, depth: 0 })
  async function post(action: string, body: unknown, overrides: Record<string, string> = {}, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        [DELEGATE_CONTEXT_HEADER]: context, ...overrides },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, data: await response.json() as any, cache: response.headers.get('cache-control') }
  }
  async function partialPost(action: string, body: unknown, authorization: string, completeAt: number, signedContext = context) {
    const bytes = JSON.stringify(body)
    let atDispatch = 0
    let atCompletion = 0
    const result = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const req = request(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(bytes), [DELEGATE_CONTEXT_HEADER]: signedContext },
      }, res => {
        let text = ''
        res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, data: JSON.parse(text) }) })
      })
      req.on('error', reject)
      req.setTimeout(6000, () => req.destroy(new Error('partial-body test watchdog')))
      // This listener runs after the actual Gateway.handleHttp listener has
      // entered authentication/readBody; no auth or clock is mocked.
      server.once('request', () => {
        atDispatch = Date.now()
        timer = setTimeout(() => { atCompletion = Date.now(); req.end(bytes.slice(1)) }, Math.max(1, completeAt - Date.now()))
      })
      req.write(bytes.slice(0, 1))
    })
    return { ...result, atDispatch, atCompletion }
  }
  async function issue(id = 'creator') {
    const result = await post('issue', { toolUseId: id })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(typeof result.data.capability, 'string')
    assert.equal(result.cache, 'no-store')
    return result.data.capability as string
  }
  return { url: `http://127.0.0.1:${port}`, gw, process, adapter, turn, parent, post, partialPost, issue, context,
    caps: (gw as unknown as { _receiptOwnerCapabilities: InstanceType<typeof ReceiptOwnerCapabilities> })._receiptOwnerCapabilities,
    hideParent: () => { visibleParent = undefined },
    close: async () => { adapter.interrupt(); turn.end(); clearTimeout((gw as any)._receiptCandidateTimer); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
const jwt = (userId: string) => `Bearer ${signJwt({ userId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)}`

const storage = await import('../../../storage/src/sessionsDb.js')
async function seed(id: string, userId: string) {
  await storage.upsertClientSession({ id, userId, agentId: 'main', title: 'private F2 test', pinned: false,
    createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
}

const { DelegateDurableDb } = await import('../delegateDurable.js')
const { DelegateJobStore } = await import('../delegateJobs.js')
async function enrolled(f: Awaited<ReturnType<typeof fixture>>) {
 f.process.tool('creator'); const creator=f.adapter.getReceiptToolOwner('creator')!
 const db=new DelegateDurableDb(join(home,randomUUID()+'.db'))
 const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true});(f.gw as any)._delegateJobs=jobs
 const made=jobs.create('worker',{parentSessionKey:SESSION,callbackOriginUserId:f.parent.userId,callback:'stdout-wait',
  deliveryReceipt:{parentTurnKey:TURN,nativeToolUseId:'creator',receiptNonceHash:'a'.repeat(64),parent:{agentId:'main',owner:creator}}})
 assert.ok('jobId' in made);const jobId=made.jobId,snap=jobs.snapshotOf(jobId)!
 const complete=()=>assert.equal(jobs.complete(jobId,{httpStatus:200,body:{output:'PRIVATE_ORIGINAL',ok:true}},
  {claimToken:snap.claimToken!,fencingEpoch:snap.fencingEpoch}),true)
 async function next(){f.parent._currentTurnKey='turn-two';const turn=start(f.adapter,'turn-two');await turn.submitted;f.process.tool('waiter');return {turn,capability:await f.issue('waiter')}}
 return {db,jobs,jobId,complete,next,raw:(db as any).db}
}
test('cross-turn metadata preserves original source across all delivery states with zero writes',async()=>{
 const f=await fixture('c:3'),e=await enrolled(f)
 try{
  const cap=await f.issue('creator');assert.equal((await f.post('handoff-status',{jobId:e.jobId,capability:cap})).status,409)
  const n=await e.next(),body={jobId:e.jobId,capability:n.capability}
  const live=await f.post('handoff-status',body);assert.equal(live.status,200);assert.equal(live.data.execution,'running');assert.equal(live.data.delivery,'pending')
  e.complete()
  for(const state of ['offered','ingest_claimed','notify_pending','notify_claimed','notified','ingested']){
   e.raw.prepare('UPDATE delegate_delivery_receipt SET state=? WHERE job_id=?').run(state,e.jobId)
   const before=e.raw.prepare('SELECT * FROM delegate_delivery_receipt').all(),jobBefore=e.raw.prepare('SELECT * FROM delegate_jobs').all()
   const result=await f.post('handoff-status',body);assert.equal(result.status,200);assert.equal(result.cache,'no-store')
   assert.deepEqual(result.data,{status:'receipt_handoff',jobId:e.jobId,generation:0,execution:'terminal',delivery:state==='notified'||state==='ingested'?state:'pending'})
   assert.deepEqual(e.raw.prepare('SELECT * FROM delegate_delivery_receipt').all(),before);assert.deepEqual(e.raw.prepare('SELECT * FROM delegate_jobs').all(),jobBefore)
   assert.ok(!JSON.stringify(result.data).includes('PRIVATE_ORIGINAL'))
  }n.turn.end()
 }finally{await f.close();e.jobs.close()}
})
test('handoff rejects foreign identity, stale generation, retired, malformed input and Stop',async()=>{
 const f=await fixture('c:3'),e=await enrolled(f)
 try{
  const old=await f.issue('creator');e.complete();const n=await e.next(),body={jobId:e.jobId,capability:n.capability}
  assert.equal((await f.post('handoff-status',body)).status,200)
  for(const overrides of [{authorization:''},{[DELEGATE_CONTEXT_HEADER]:''},{authorization:jwt('c:4')}])assert.notEqual((await f.post('handoff-status',body,overrides)).status,200)
  for(const extra of [{generation:0},{receiptNonce:'a'.repeat(64)},{sourceTurn:TURN}])assert.equal((await f.post('handoff-status',{...body,...extra})).status,400)
  assert.equal((await f.post('handoff-status',{...body,capability:old})).status,409)
  for(const [column,value] of [['callback_origin_user_id','c:4'],['parent_session_key','foreign'],['retired_at',1],['generation',1]] as const){
   const before=e.raw.prepare(`SELECT ${column} AS v FROM delegate_jobs WHERE job_id=?`).get(e.jobId).v
   e.raw.prepare(`UPDATE delegate_jobs SET ${column}=? WHERE job_id=?`).run(value,e.jobId)
   assert.equal((await f.post('handoff-status',body)).status,404,column)
   e.raw.prepare(`UPDATE delegate_jobs SET ${column}=? WHERE job_id=?`).run(before,e.jobId)
  }
  const orig=e.raw.prepare('SELECT delivery_receipt_context AS c FROM delegate_jobs WHERE job_id=?').get(e.jobId).c
  const context=JSON.parse(orig);context.parent.agentId='other'
  e.raw.prepare('UPDATE delegate_jobs SET delivery_receipt_context=? WHERE job_id=?').run(JSON.stringify(context),e.jobId)
  assert.equal((await f.post('handoff-status',body)).status,404)
  e.raw.prepare('UPDATE delegate_jobs SET delivery_receipt_context=? WHERE job_id=?').run(orig,e.jobId)
  f.adapter.interrupt();assert.equal((await f.post('handoff-status',body)).status,409);n.turn.end()
 }finally{await f.close();e.jobs.close()}
})
test('handoff reauthenticates after real SQL await, fails closed for unknown and actual private deletion',async()=>{
 const f=await fixture('c:3'),e=await enrolled(f)
 try{
  await seed('handoff-private','c:3');f.parent.channel='webchat';f.parent.peerId='handoff-private'
  e.complete();const n=await e.next(),body={jobId:e.jobId,capability:n.capability}
  assert.equal((await f.post('handoff-status',body)).status,200)
  const original=(f.gw as any)._receiptClientState.bind(f.gw),exp=Math.ceil(Date.now()/1000)+1
  ;(f.gw as any)._receiptClientState=async(parent:unknown)=>{const state=await original(parent);await new Promise(r=>setTimeout(r,Math.max(1,exp*1000+30-Date.now())));return state}
  assert.equal((await f.post('handoff-status',body,{authorization:`Bearer ${signJwt({userId:'c:3',exp},TOKEN)}`})).status,401)
  ;(f.gw as any)._receiptClientState=async()=> 'unknown';assert.equal((await f.post('handoff-status',body)).status,503)
  ;(f.gw as any)._receiptClientState=original
  await storage.deleteClientSession('handoff-private','c:3');assert.equal((await f.post('handoff-status',body)).status,409);n.turn.end()
 }finally{await f.close();e.jobs.close()}
})
