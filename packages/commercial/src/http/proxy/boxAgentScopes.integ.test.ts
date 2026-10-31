/** Real PostgreSQL interleavings, in one private schema on an explicit test DB. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client, Pool } from 'pg'
import { deriveBoxAgentSession, boxApiUpstreamModelFor, type BoxAgentScopeIdentity } from '@openclaude/protocol'
import { BoxDurableJournal, type BoxJournalAdmission } from './boxDurableJournal.js'
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent, hashBoxAssistantNoCallerContent } from './boxCallFingerprint.js'
import { compileBoxToolCatalog } from './boxToolCatalog.js'
import { BoxAgentScopes } from './boxAgentScopes.js'
import type { ProxyBody } from './shared.js'
import type { BoxPrelaunchReceipt } from './boxPrelaunchControl.js'

const url=process.env.TEST_DATABASE_URL ?? process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
assert.ok(url,'Box scope tests require an explicit isolated PostgreSQL fixture')
const address=new URL(url)
assert.ok(['127.0.0.1','localhost','[::1]'].includes(address.hostname) && /_test$/.test(address.pathname),'test DB must be loopback *_test')
const schema=`box_scope_${randomBytes(6).toString('hex')}`
const MODEL='box-api-claude-opus-5-5'
function requiredUpstreamModel():string {
  const model=boxApiUpstreamModelFor(MODEL)
  assert.ok(model,'selected test model must have an upstream')
  return model
}
let pool:Pool
let serial=0
test.before(async () => {
  const admin=new Client({connectionString:url})
  await admin.connect()
  try {
    assert.match((await admin.query('SELECT current_database() AS db')).rows[0].db,/_test$/)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`SET search_path=${schema}`)
    await admin.query(`CREATE TABLE users(id BIGINT PRIMARY KEY);
      CREATE TABLE agent_containers(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id));
      CREATE TABLE request_finalize_journal(request_id TEXT PRIMARY KEY,user_id BIGINT NOT NULL,
        container_id BIGINT,state TEXT NOT NULL,ctx JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),error_msg TEXT,failure_code TEXT,final_credits BIGINT)`)
    await admin.query(await readFile(new URL('../../db/migrations/0332_box_agent_api_scopes.sql',import.meta.url),'utf8'))
    pool=new Pool({connectionString:url,max:8,options:`-c search_path=${schema}`})
  } finally {await admin.end()}
})
test.after(async () => {
  await pool?.end()
  const admin=new Client({connectionString:url})
  await admin.connect()
  try {await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)} finally {await admin.end()}
})
async function fixture(caps=3) {
  const uid=BigInt(900664000+ ++serial)
  const containerId=uid
  await pool.query('INSERT INTO users VALUES ($1)',[uid.toString()])
  await pool.query('INSERT INTO agent_containers VALUES ($1,$1)',[uid.toString()])
  const rootSessionId=randomUUID()
  const owner={uid,containerId}
  const scope=(agentId='agent'):BoxAgentScopeIdentity => ({scopeId:randomUUID(),rootSessionId,
    sessionId:deriveBoxAgentSession(rootSessionId,agentId),agentId,turnKey:'a'.repeat(64)})
  const journal=new BoxDurableJournal(pool,() => ({maxRunsPerAccount:caps,maxRunsPerUser:caps}))
  let stops=0
  const scopes=new BoxAgentScopes({pool,journal,
    coordinator:{requestStop:async () => {stops++;return 'pending'}},recoverPrelaunch:async () => false})
  async function candidate(identity:BoxAgentScopeIdentity, mode:'plain'|'text'|'guarded'='plain') {
    const requestId=`scope-${randomBytes(12).toString('hex')}`
    const body={model:MODEL,max_tokens:32,stream:true,
      metadata:{user_id:JSON.stringify({session_id:identity.sessionId,oc_turn_key:identity.turnKey,
        oc_box_agent_scope:identity.scopeId})},messages:[{role:'user',content:requestId}]} as ProxyBody
    const fingerprint=deriveBoxCallFingerprint(uid,body)
    const input:BoxJournalAdmission & {canonicalBody:ProxyBody}={requestId,uid,accountId:uid,model:MODEL,fingerprint,canonicalBody:body,
      runNonce:randomBytes(12).toString('hex'),leaseEpoch:randomBytes(16).toString('hex'),
      ...(mode === 'guarded' ? {invocationMode:'detached_tool',contextHash:deriveBoxContextHash(body),
        detachedRunnerHash:'f'.repeat(64),catalogHash:'e'.repeat(64)} : {}),
      ...(mode === 'text' ? {invocationMode:'text',detachedRunnerHash:'f'.repeat(64),
        upstreamModel:requiredUpstreamModel()} : {})}
    await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
      VALUES($1,$2,$2,'inflight',$3::jsonb)`,[requestId,uid.toString(),JSON.stringify({model:MODEL,
        boxInvocationRecovery:'v1',boxAgentScopeId:identity.scopeId,
        billingPricing:{v:1,modelId:MODEL,displayName:'Opus',inputPerMtok:'1',outputPerMtok:'1',
          cacheReadPerMtok:'1',cacheWritePerMtok:'1',multiplier:'1'},
        boxBillingContext:{v:1,sessionId:identity.sessionId,mode:'chat',parentSessionId:null,delegateAgentId:null,
          turnKey:identity.turnKey,parentTurnKey:null,authority:null,dispatchId:null,attemptNo:null,
          verificationSponsorship:null,apiKeyId:null}})])
    return input
  }
  return {owner,scope,journal,scopes,candidate,stops:() => stops}
}

test('committed cancel-before-admit fences a late HTTP request even after a positive no-run receipt',async () => {
  const f=await fixture()
  const identity=f.scope()
  assert.equal((await f.scopes.control(f.owner,identity,'register')).status,'active')
  const cancelled=await f.scopes.control(f.owner,identity,'cancel','explicit-stop')
  assert.equal(cancelled.status,'stopped');assert.equal(cancelled.proof,'prelaunch_cancelled')
  const late=await f.candidate(identity)
  await assert.rejects(() => f.journal.admit(late),/BOX_AGENT_SCOPE_INACTIVE/)
  assert.equal(f.stops(),0)
  assert.equal((await pool.query('SELECT ctx FROM request_finalize_journal WHERE request_id=$1',[late.requestId])).rows[0].ctx.boxState,undefined)
  assert.equal((await f.scopes.control(f.owner,identity,'register')).fence,'cancelled','idempotent registration never reopens a generation')
})

test('cancel-after-admit rejects every later launch arm; original prestart CAS closes without changing billing state',async () => {
  for(const mode of ['plain','text','guarded'] as const) {
    const f=await fixture()
    const identity=f.scope()
    await f.scopes.control(f.owner,identity,'register')
    const call=await f.candidate(identity,mode);await f.journal.admit(call)
    let receipt:BoxPrelaunchReceipt|undefined
    if(mode === 'guarded') {
      // Synthetic private control identity; no remote stage or keeper is launched.
      const manifest={accountId:call.accountId.toString(),controlDev:'1',controlId:'a'.repeat(32),controlIno:'2',
        leaseEpoch:call.leaseEpoch,lockDev:'1',lockIno:'3',runNonce:call.runNonce,version:2 as const}
      receipt={...manifest,identityHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}
      await f.journal.recordPrelaunchControl({...call,receipt})
    }
    assert.equal((await f.scopes.control(f.owner,identity,'cancel','explicit-stop')).status,'pending')
    if(mode === 'plain') await assert.rejects(() => f.journal.markRunning(call),/BOX_AGENT_SCOPE_INACTIVE/)
    if(mode === 'text') await assert.rejects(() => f.journal.armTextLaunch({...call,detachedRunnerHash:'f'.repeat(64),upstreamModel:requiredUpstreamModel()}),/BOX_AGENT_SCOPE_INACTIVE/)
    if(mode === 'guarded') await assert.rejects(() => f.journal.armGuardedLaunch({...call,receipt:receipt!}),/BOX_AGENT_SCOPE_INACTIVE/)
    if(receipt) await f.journal.markGuardedPrestartStopped({...call,receipt,cleanedReceipt:`cleaned:${receipt.identityHash}`})
    else await f.journal.markPrestartStopped(call)
    const closed=await f.scopes.control(f.owner,identity,'status')
    assert.equal(closed.status,'stopped')
    assert.equal((await pool.query('SELECT state FROM request_finalize_journal WHERE request_id=$1',[call.requestId])).rows[0].state,'inflight','control proof never settles or refunds billing')
  }
})

test('already armed run stays pending and occupies capacity; expired/missing/wrong-identity proof never retires scope',async () => {
  const f=await fixture(1)
  const old=f.scope()
  await f.scopes.control(f.owner,old,'register')
  const call=await f.candidate(old,'text');await f.journal.admit(call)
  await f.journal.armTextLaunch({...call,detachedRunnerHash:'f'.repeat(64),upstreamModel:requiredUpstreamModel()})
  assert.equal((await f.scopes.control(f.owner,old,'cancel','explicit-stop')).status,'pending')
  const next=f.scope('other');await f.scopes.control(f.owner,next,'register')
  await assert.rejects(() => f.candidate(next).then(input => f.journal.admit(input)),/BOX_CAPACITY_HELD/)
  for(const patch of [{boxState:'expired_unproven'}, {boxState:'failed_stopped',boxTerminalProof:{revision:1,
    reason:'keeper_stopped',runNonce:'f'.repeat(24),leaseEpoch:call.leaseEpoch,keeperPid:11,cliPid:12}}]) {
    await pool.query(`UPDATE request_finalize_journal SET state='aborted',ctx=ctx || $2::jsonb WHERE request_id=$1`,[call.requestId,JSON.stringify(patch)])
    assert.equal((await f.scopes.control(f.owner,old,'status')).status,'pending')
  }
})

test('old cancelled generation cannot cancel a same-agent same-turn fresh invocation',async () => {
  const f=await fixture()
  const old=f.scope()
  const next=f.scope()
  assert.equal(old.sessionId,next.sessionId)
  await f.scopes.control(f.owner,old,'register')
  await f.scopes.control(f.owner,old,'cancel','finish')
  await f.scopes.control(f.owner,next,'register')
  const call=await f.candidate(next);await f.journal.admit(call)
  await f.scopes.control(f.owner,old,'cancel','explicit-stop')
  await f.journal.markRunning(call)
  assert.equal((await f.scopes.control(f.owner,next,'status')).status,'active')
  assert.equal(f.stops(),0)
})

test('only a complete settled physical chain with its exact keeper proof retires a cancelled scope',async () => {
  const f=await fixture()
  const identity=f.scope()
  await f.scopes.control(f.owner,identity,'register')
  const call=await f.candidate(identity,'text');await f.journal.admit(call)
  await f.journal.armTextLaunch({...call,detachedRunnerHash:'f'.repeat(64),upstreamModel:requiredUpstreamModel()})
  const patch={boxState:'failed_stopped',boxTerminalProof:{revision:1,reason:'keeper_stopped',
    runNonce:call.runNonce,leaseEpoch:call.leaseEpoch,keeperPid:11,cliPid:12}}
  await pool.query('UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb WHERE request_id=$1',[call.requestId,JSON.stringify(patch)])
  assert.equal((await f.scopes.control(f.owner,identity,'cancel','explicit-stop')).status,'pending',
    'keeper proof alone cannot stand in for settlement')
  const before=f.stops()
  await pool.query("UPDATE request_finalize_journal SET state='aborted' WHERE request_id=$1",[call.requestId])
  const stopped=await f.scopes.control(f.owner,identity,'status')
  assert.equal(stopped.status,'stopped');assert.equal(stopped.fence,'cancelled')
  assert.equal(stopped.proof,'all_physical_runs_terminal')
  assert.equal(f.stops(),before,'a proven terminal run never requests another physical Stop')
})

test('scope cancellation commits the exact generation intent before the original keeper can be selected',async () => {
  const f=await fixture()
  const identity=f.scope()
  await f.scopes.control(f.owner,identity,'register')
  const call=await f.candidate(identity,'text');await f.journal.admit(call)
  await f.journal.armTextLaunch({...call,detachedRunnerHash:'f'.repeat(64),upstreamModel:requiredUpstreamModel()})
  const input={...call,scopeId:identity.scopeId,reason:'explicit-stop' as const}
  await assert.rejects(() => f.journal.recordScopeCancelIntent(input),/BOX_AGENT_SCOPE_INACTIVE/)
  await f.scopes.control(f.owner,identity,'cancel','explicit-stop')
  await assert.rejects(() => f.journal.recordScopeCancelIntent({...input,scopeId:randomUUID()}),/BOX_AGENT_SCOPE_INACTIVE/)
  await f.journal.recordScopeCancelIntent(input)
  const leaf=await f.journal.getCancelLeaf(call)
  assert.equal(leaf.requestId,call.requestId);assert.equal(leaf.runNonce,call.runNonce)
  assert.equal(leaf.leaseEpoch,call.leaseEpoch);assert.equal(leaf.accountId,call.accountId)
  const row=(await pool.query('SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1',[call.requestId])).rows[0]
  assert.equal(row.state,'inflight');assert.equal(row.ctx.boxCancelIntent.reason,'user_cancel')
  assert.equal(row.ctx.boxTerminalProof,undefined,'durable intent is never a keeper proof')
})

test('a real tool-resume claim preserves generation and cancellation follows its exact new leaf',async()=>{
  const f=await fixture()
  const identity=f.scope()
  const fresh=f.scope()
  for(const scope of [identity,fresh]) await f.scopes.control(f.owner,scope,'register')
  const call=await f.candidate(identity,'guarded')
  call.canonicalBody.tools=[{name:'Echo',description:'synthetic',input_schema:{type:'object',properties:{}}}]
  call.fingerprint=deriveBoxCallFingerprint(call.uid,call.canonicalBody)
  call.contextHash=deriveBoxContextHash(call.canonicalBody)
  call.catalogHash=compileBoxToolCatalog(call.canonicalBody.tools).bindingSha256
  await f.journal.admit(call)
  const manifest={accountId:call.accountId.toString(),controlDev:'1',controlId:'a'.repeat(32),controlIno:'2',
    leaseEpoch:call.leaseEpoch,lockDev:'1',lockIno:'3',runNonce:call.runNonce,version:2 as const}
  const receipt={...manifest,identityHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}
  await f.journal.recordPrelaunchControl({...call,receipt})
  await f.journal.armGuardedLaunch({...call,receipt})
  const content=[{type:'tool_use' as const,id:'toolu_scope_echo',name:'Echo',input:{}}]
  await f.journal.recordToolHandoff({...call,roundNo:1,spoolOffset:1000,
    detachedRunnerHash:call.detachedRunnerHash!,catalogHash:call.catalogHash,
    verifiedPendingToolUseIds:['toolu_scope_echo'],messagePointer:{version:1,uid:call.uid.toString(),
      requestId:call.requestId,runNonce:call.runNonce,leaseEpoch:call.leaseEpoch,roundNo:1,bytes:20,sha256:'9'.repeat(64)},
    candidate:{messageId:'msg_scope_echo',toolUses:[{id:'toolu_scope_echo',boxName:'mcp__ocbridge__t0',clientName:'Echo',input:{}}],
      assistantContentHash:hashBoxAssistantContent(content),assistantNoCallerHash:hashBoxAssistantNoCallerContent(content),
      inputTokens:2,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0}})
  const nextBody={...call.canonicalBody,messages:[...call.canonicalBody.messages,{role:'assistant',content},
    {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_scope_echo',content:'synthetic-result'}]}]} as ProxyBody
  const other=await f.candidate(fresh,'guarded')
  const wrongBody={...nextBody,metadata:other.canonicalBody.metadata}
  await assert.rejects(()=>f.journal.claimToolResume({requestId:other.requestId,uid:call.uid,
    canonicalModel:MODEL,canonicalBody:wrongBody}),/BOX_AGENT_SCOPE_GENERATION_CONFLICT/)
  const next=await f.candidate(identity,'guarded')
  const claimed=await f.journal.claimToolResume({requestId:next.requestId,uid:call.uid,
    canonicalModel:MODEL,canonicalBody:nextBody})
  assert.equal(claimed.runNonce,call.runNonce);assert.equal(claimed.leaseEpoch,call.leaseEpoch)
  const row=(await pool.query('SELECT ctx FROM request_finalize_journal WHERE request_id=$1',[next.requestId])).rows[0]
  assert.equal(row.ctx.boxAgentScopeId,identity.scopeId)
  assert.equal((await f.scopes.control(f.owner,identity,'cancel','explicit-stop')).status,'pending')
  const leafInput={...call,requestId:next.requestId,scopeId:identity.scopeId,reason:'explicit-stop' as const}
  await f.journal.recordScopeCancelIntent(leafInput)
  assert.equal((await f.journal.getCancelLeaf(call)).requestId,next.requestId)
  const late=await f.candidate(identity,'guarded')
  await assert.rejects(()=>f.journal.claimToolResume({requestId:late.requestId,uid:call.uid,
    canonicalModel:MODEL,canonicalBody:nextBody}),/BOX_AGENT_SCOPE_INACTIVE/)
  assert.equal((await f.scopes.control(f.owner,fresh,'status')).status,'active')
})

test('cancel and admit racing under the same session lock cannot yield a false no-run receipt plus a launch',async () => {
  const f=await fixture()
  const identity=f.scope()
  await f.scopes.control(f.owner,identity,'register')
  const call=await f.candidate(identity)
  const [cancelled,admitted]=await Promise.allSettled([
    f.scopes.control(f.owner,identity,'cancel','explicit-stop'),f.journal.admit(call)])
  assert.equal(cancelled.status,'fulfilled')
  if(admitted.status === 'fulfilled') {
    assert.equal(cancelled.status === 'fulfilled' && cancelled.value.status,'pending')
    await assert.rejects(() => f.journal.markRunning(call),/BOX_AGENT_SCOPE_INACTIVE/)
  } else assert.match(String(admitted.reason),/BOX_AGENT_SCOPE_INACTIVE/)
  const row=(await pool.query('SELECT ctx FROM request_finalize_journal WHERE request_id=$1',[call.requestId])).rows[0]
  assert.equal(row.ctx.boxLaunchPermit,undefined)
})

test('cancelled generation closes a never-admitted rollover gap and cannot finish or launch its successor',async()=>{
  const f=await fixture()
  const identity=f.scope()
  await f.scopes.control(f.owner,identity,'register')
  const call=await f.candidate(identity,'guarded')
  // An explicit private fixture of the server's already-journaled rollover
  // claim, before its new physical admission. No keeper is fabricated.
  const receipt={v:1 as const,requestId:call.requestId,ownerRequestId:'synthetic-old-leaf',
    accountId:call.accountId.toString(),runNonce:call.runNonce,leaseEpoch:call.leaseEpoch,
    durableRevision:randomUUID(),reason:'rounds' as const,sessionId:identity.sessionId,turnKey:identity.turnKey,
    model:MODEL,nextContextHash:call.contextHash!,roundNo:128,catalogHash:call.catalogHash!,
    detachedRunnerHash:call.detachedRunnerHash!,resultHashes:[{modelToolUseId:'toolu_scope_gap',
      contentHash:'1'.repeat(64),isError:false}]}
  await pool.query('UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb WHERE request_id=$1',
    [call.requestId,JSON.stringify({boxSessionId:identity.sessionId,boxTurnKey:identity.turnKey,boxRolloverFrom:receipt})])
  const stopped=await f.scopes.control(f.owner,identity,'cancel','explicit-stop')
  assert.equal(stopped.status,'stopped');assert.equal(stopped.proof,'prelaunch_cancelled')
  const row=(await pool.query('SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1',[call.requestId])).rows[0]
  assert.equal(row.state,'inflight');assert.equal(row.ctx.boxRolloverCancelled,true)
  assert.equal(row.ctx.boxRunNonce,undefined);assert.equal(row.ctx.boxTerminalProof,undefined)
  await assert.rejects(()=>f.journal.finishToolRollover({requestId:call.requestId,uid:call.uid,
    claim:{...receipt,accountId:call.accountId}}),/BOX_AGENT_SCOPE_INACTIVE/)
  await assert.rejects(()=>f.journal.admit(call),/BOX_AGENT_SCOPE_INACTIVE/)
})
