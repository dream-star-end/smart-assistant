import assert from 'node:assert/strict'
import { generateKeyPairSync,randomUUID,sign } from 'node:crypto'
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { authoritySigningInput,encodeAuthorityEnvelope,turnLeaseSigningInput,encodeTurnLeaseEnvelope,type ModelAuthorityPayload,type TurnLease } from '@openclaude/protocol'
import { CodexRemoteRelay } from '../codexRemoteRelay.js'
import { codexBackend,zeroNativeTokens,type CodexRemoteBinding } from '../codexRemoteContract.js'
import { cc5ToolInputSha256 } from '../cc5NativeTool.js'
import type { CodexLaneSpec } from '../codexRemoteHost.js'
const pause=(ms=30)=>new Promise(r=>setTimeout(r,ms))
async function harness(t: any, ttl=120000) {
 const root=mkdtempSync(join(tmpdir(),'codex-master-')), now=Date.now()
 const b:CodexRemoteBinding={version:3,backendKind:'codex-app-server-v1',uid:'3',containerDbId:'7',dockerId:'a'.repeat(64),
  operationId:randomUUID(),runId:randomUUID(),sessionKey:'agent:main:webchat:dm:codex_fixture',canonicalModel:'gpt-6-luna-remote',
  generation:'1',profileId:'default',authEpoch:'epoch1',manifestSha256:'a'.repeat(64),capability:'b'.repeat(64),expiresAt:now+600000}
 const spec:CodexLaneSpec={controllerPath:'fixture',manifest:{version:1,engine:'codex',root:'/fixture',operationId:b.operationId,runId:b.runId,
  generation:b.generation,profileId:b.profileId,authEpoch:b.authEpoch,model:'gpt-6-luna',nativeThreadId:null,codexHome:'/fixture',
  controllerSha256:'a'.repeat(64),cliSha256:'a'.repeat(64),nativeSha256:'a'.repeat(64)},modelList:[],modelCatalog:{models:[]}}
 const key=generateKeyPairSync('ed25519'), keyId='test-key'
 const keys=new Map([[keyId,new Uint8Array(Buffer.from(key.publicKey.export({format:'jwk'}).x!,'base64url'))]])
 const a:ModelAuthorityPayload={v:1,keyId,uid:3,containerId:7,authorityTurnId:randomUUID().replaceAll('-',''),billingRequestId:'request-fixture',
  connectionChallenge:'fixture',canonicalModel:b.canonicalModel,engine:'codex',executionBackend:codexBackend(b),securityEpoch:1,executionRevision:'fixture-r1',
  issuedAt:now,expiresAt:now+ttl,executionDescriptor:{capabilityProfile:{},capabilitySchemaVersion:1,contextWindow:1000,supportsVision:false,supportedEfforts:['low']}}
 const l:TurnLease={v:1,keyId,uid:3,containerId:7,authorityTurnId:a.authorityTurnId,connectionChallenge:'fixture',canonicalModel:b.canonicalModel,securityEpoch:1,issuedAt:now,expiresAt:now+600000}
 const auth=encodeAuthorityEnvelope(a,sign(null,authoritySigningInput(a),key.privateKey)), lease=encodeTurnLeaseEnvelope(l,sign(null,turnLeaseSigningInput(l),key.privateKey)),turnKey='c'.repeat(64)
 const children=new Map<string,ChildProcessWithoutNullStreams>(), received:any[]=[], receipts:any[]=[]
 let admitted=false,charged=false,stopCalls=0,financeIndex=0
 const financeStops:any[]=[]
 let gate:{stage:string;entered:()=>void;wait:Promise<void>}|undefined
 const host={provision:async()=>{assert.equal(admitted,true)},open:(role:'launch'|'tool-socket')=>{
  assert.equal(admitted,true)
  const c=spawn(process.execPath,[new URL('./fixtures/codexRemoteNode.mjs',import.meta.url).pathname],
   {stdio:['pipe','pipe','pipe','ipc'],env:{...process.env,OC_TEST_NODE:JSON.stringify({role,manifest:spec.manifest})}}) as ChildProcessWithoutNullStreams
  c.on('message',m=>received.push(m)); children.set(role,c); return c
 },stop:async()=>{stopCalls++;for(const c of children.values())c.kill();return {remoteStopped:true as const}}}
 const relay=new CodexRemoteRelay(b,keys,host,spec,join(root,'journal'),{admit:async()=>{
  const index=++financeIndex, current=gate;gate=undefined
  if(current?.stage==='reserve'){current.entered();await current.wait}
  admitted=true;return {beforeHostStart:async()=>{if(current?.stage==='host-marker'){current.entered();await current.wait}},beforeDispatch:async()=>{},bindNativeThread:async()=>zeroNativeTokens(),
   terminal:async(r)=>{receipts.push(r);charged=true;return {state:'proven',requestId:a.billingRequestId!}},stop:async proof=>{financeStops.push({index,...proof})}}
 }},async()=>{})
 const sock=join(root,'relay.sock');relay.controlServer.listen(sock);await once(relay.controlServer,'listening')
 const call=(path:string,v:any={})=>new Promise<any>((resolve,reject)=>{
  const bytes=JSON.stringify({...b,...v})
  const req=request({socketPath:sock,path,method:'POST',headers:{'content-length':Buffer.byteLength(bytes)}},res=>{
   let result='';res.on('data',d=>result+=d);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(result)}))
  });req.on('error',reject);req.end(bytes)
 })
 t.after(async()=>{const s=relay.stop().catch(()=>{}); await call('/tool/stopped',{authorityTurnId:a.authorityTurnId,turnKey}).catch(()=>{});await s
  for(const c of children.values())c.kill();relay.controlServer.closeAllConnections();await new Promise<void>(r=>relay.controlServer.close(()=>r()));rmSync(root,{recursive:true,force:true})})
 const admit=await call('/admit',{authority:auth,lease,turnKey,catalog:{tools:[{name:'Write',inputSchema:{type:'object'}}]}})
 assert.equal(admit.status,200)
 const rpc=async(frame:any)=>{const r=await call('/rpc',{frame});assert.equal(r.status,200)}
 await rpc({id:1,method:'thread/start',params:{}})
 async function until(fn:()=>Promise<boolean>){for(let i=0;i<150;i++){if(await fn())return;await pause(10)}assert.fail('timed out')}
 await until(async()=>{const r=await call('/poll',{afterSeq:0});return r.frames.some((x:any)=>x.frame.id===1)})
 await rpc({id:2,method:'turn/start',params:{threadId:'thread-fixture',input:[{type:'text',text:'fixture'}],effort:'low'}})
 await until(async()=>{const r=await call('/poll',{afterSeq:0});return r.frames.some((x:any)=>x.frame.method==='turn/started')})
 const args={file_path:join(root,'effect'),content:'real-container-marker'}
 const item={type:'mcpToolCall',id:'call1',server:'ocbridge',tool:'Write',arguments:args}
 const tool={version:3,engine:'codex',operationId:b.operationId,runId:b.runId,generation:b.generation,callId:'call1',
  nativeThreadId:'thread-fixture',nativeTurnId:'turn-fixture',server:'ocbridge',name:'Write',arguments:args,inputSha256:cc5ToolInputSha256(args)}
 const emit=(frame:any)=>children.get('launch')!.send!(frame)
 const sendTool=(v:any=tool)=>children.get('tool-socket')!.send!({version:3,engine:'codex',kind:'tool-request',seq:1,body:Buffer.from(JSON.stringify(v)).toString('base64')})
 const nativeItem=(method='item/started',i:any=item)=>emit({method,params:{threadId:'thread-fixture',turnId:'turn-fixture',item:i}})
 const nextAdmission=(stage:string)=>{
  let entered!:()=>void,unblock!:()=>void
  const arrival=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>unblock=r);gate={stage,entered,wait}
  const next={...a,authorityTurnId:randomUUID().replaceAll('-',''),billingRequestId:'second-fixture',issuedAt:Date.now(),expiresAt:Date.now()+60000}
  const nextLease={...l,authorityTurnId:next.authorityTurnId}
  const response=call('/admit',{authority:encodeAuthorityEnvelope(next,sign(null,authoritySigningInput(next),key.privateKey)),
   lease:encodeTurnLeaseEnvelope(nextLease,sign(null,turnLeaseSigningInput(nextLease),key.privateKey)),turnKey:'d'.repeat(64),
   catalog:{tools:[{name:'Write',inputSchema:{type:'object'}}]}})
  return {arrival,unblock,response,authorityTurnId:next.authorityTurnId,turnKey:'d'.repeat(64)}
 }
 return {root,call,rpc,until,emit,sendTool,nativeItem,item,tool,args,relay,receipts,received,a,turnKey,nextAdmission,financeStops,get charged(){return charged},get stopCalls(){return stopCalls}}
}
test('independent native gate, real two-child relay, tool effect once, terminal waits for ACK + finance; expired admitted authority works',async t=>{
 const h=await harness(t,600);await pause(650)
 h.sendTool();await pause();assert.equal((await h.call('/tool/next')).request,undefined)
 h.nativeItem();let req:any
 await h.until(async()=>{req=(await h.call('/tool/next')).request;return !!req})
 assert.equal(req.callId,'call1');assert.equal((await h.call('/tool/next')).request,undefined)
 writeFileSync(req.arguments.file_path,req.arguments.content)
 assert.equal(readFileSync(h.args.file_path,'utf8'),'real-container-marker')
 assert.equal((await h.call('/tool/result',{callId:'call1',result:{content:[{type:'text',text:'written'}],isError:false}})).status,200)
 h.nativeItem('item/completed');h.emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{...zeroNativeTokens(),inputTokens:100,outputTokens:10,totalTokens:110}}}})
 const final={method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}}
 h.emit(final);await pause();assert.equal(h.charged,false)
 assert.ok(!(await h.call('/poll',{afterSeq:0})).frames.some((x:any)=>x.frame.method==='turn/completed'))
 await h.call('/tool/ack',{callId:'call1'});await h.until(async()=>h.charged)
 h.emit(final);await pause();assert.equal(h.receipts.length,1)
 const frames=(await h.call('/poll',{afterSeq:0})).frames
 assert.equal(frames.filter((x:any)=>x.frame.method==='turn/completed').length,1)
 assert.equal(readdirSync(join(h.root,'journal')).filter(f=>f.includes('native-terminal')).length,1)
 const stop=h.call('/stop');await pause();assert.equal((await h.call('/tool/stopped',{authorityTurnId:h.a.authorityTurnId,turnKey:h.turnKey})).status,200)
 assert.equal((await stop).remoteStopped,true)
})
for(const attack of ['args','thread','server','native','request']) test(`fences ${attack} with no container effect`,async t=>{
 const h=await harness(t)
 if(attack==='native')h.nativeItem('item/started',{type:'commandExecution',id:'bad'})
 else if(attack==='request')h.emit({id:99,method:'item/tool/requestUserInput',params:{}})
 else {h.nativeItem();h.sendTool({...h.tool,...(attack==='args'?{arguments:{...h.args,content:'forged'},inputSha256:cc5ToolInputSha256({...h.args,content:'forged'})}:attack==='thread'?{nativeThreadId:'wrong'}:{server:'wrong'})})}
 await h.until(async()=>h.relay.stopped)
 assert.equal((await h.call('/tool/next')).status,403);assert.equal(h.receipts.length,0)
})
test('late local stop is recoverable without restarting model; stale turn proof cannot release current lifecycle',async t=>{
 const h=await harness(t)
 await assert.rejects(h.relay.stop(),/CODEX_STOP_UNKNOWN/)
 assert.equal((await h.call('/tool/stopped',{authorityTurnId:'d'.repeat(32),turnKey:h.turnKey})).status,403)
 await assert.rejects(h.relay.stop(),/CODEX_STOP_UNKNOWN/)
 assert.equal((await h.call('/tool/stopped',{authorityTurnId:h.a.authorityTurnId,turnKey:h.turnKey})).status,200)
 assert.deepEqual(await h.relay.stop(),{remoteStopped:true})
 assert.equal((await h.call('/tool/next')).status,403)
})

for (const stage of ['reserve','host-marker'] as const) test(`stop drains ${stage} admission before proving no host effect`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'codex-admit-stop-')),key=generateKeyPairSync('ed25519'),now=Date.now()
 const b:CodexRemoteBinding={version:3,backendKind:'codex-app-server-v1',uid:'3',containerDbId:'7',dockerId:'a'.repeat(64),
  operationId:randomUUID(),runId:randomUUID(),sessionKey:'agent:main:webchat:dm:stop_race',canonicalModel:'gpt-6-luna-remote',
  generation:'1',profileId:'default',authEpoch:'epoch1',manifestSha256:'a'.repeat(64),capability:'b'.repeat(64),expiresAt:now+600000}
 const spec:CodexLaneSpec={controllerPath:'fixture',manifest:{version:1,engine:'codex',root:'/fixture',operationId:b.operationId,runId:b.runId,
  generation:'1',profileId:'default',authEpoch:'epoch1',model:'gpt-6-luna',nativeThreadId:null,codexHome:'/fixture',
  controllerSha256:'a'.repeat(64),cliSha256:'a'.repeat(64),nativeSha256:'a'.repeat(64)},modelList:[],modelCatalog:{models:[]}}
 const a:ModelAuthorityPayload={v:1,keyId:'test-key',uid:3,containerId:7,authorityTurnId:randomUUID().replaceAll('-',''),billingRequestId:'race',
  connectionChallenge:'fixture',canonicalModel:b.canonicalModel,engine:'codex',executionBackend:codexBackend(b),securityEpoch:1,
  executionRevision:'fixture',issuedAt:now,expiresAt:now+60000,executionDescriptor:{capabilityProfile:{},capabilitySchemaVersion:1,contextWindow:1000,supportsVision:false,supportedEfforts:[]}}
 const l:TurnLease={v:1,keyId:a.keyId,uid:3,containerId:7,authorityTurnId:a.authorityTurnId,connectionChallenge:'fixture',canonicalModel:b.canonicalModel,securityEpoch:1,issuedAt:now,expiresAt:now+60000}
 let entered!:()=>void,unblock!:()=>void,marks=0,stops=0,provisions=0
 const arrival=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>unblock=r)
 const relay=new CodexRemoteRelay(b,new Map([[a.keyId,new Uint8Array(Buffer.from(key.publicKey.export({format:'jwk'}).x!,'base64url'))]]),
  {provision:async()=>{provisions++},open:()=>{throw new Error('must not launch')},stop:async()=>({remoteStopped:true})},spec,join(dir,'journal'),
  {admit:async()=>{if(stage==='reserve'){entered();await barrier}return {
   beforeHostStart:async()=>{marks++;if(stage==='host-marker'){entered();await barrier}},beforeDispatch:async()=>{},
   terminal:async()=>({state:'pending'}),stop:async proof=>{assert.deepEqual(proof,{hostStartAttempted:false,userSubmitted:false,remoteStopped:true});stops++},
  }}},async()=>{})
 const socketPath=join(dir,'relay.sock');relay.controlServer.listen(socketPath);await once(relay.controlServer,'listening')
 t.after(async()=>{unblock();await relay.stop();relay.controlServer.closeAllConnections();await new Promise<void>(r=>relay.controlServer.close(()=>r()));rmSync(dir,{recursive:true,force:true})})
 const payload=JSON.stringify({...b,authority:encodeAuthorityEnvelope(a,sign(null,authoritySigningInput(a),key.privateKey)),
  lease:encodeTurnLeaseEnvelope(l,sign(null,turnLeaseSigningInput(l),key.privateKey)),turnKey:'c'.repeat(64),catalog:{tools:[{name:'Write',inputSchema:{type:'object'}}]}})
 const response=new Promise<number|undefined>((resolve,reject)=>{const r=request({socketPath,path:'/admit',method:'POST',headers:{'content-length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',reject);r.end(payload)})
 await arrival;let settled=false;const stopped=relay.stop().then(r=>{settled=true;return r});await pause();assert.equal(settled,false)
 unblock();assert.equal(await response,403);assert.deepEqual(await stopped,{remoteStopped:true});await relay.stop()
 assert.equal(marks,stage==='reserve'?0:1);assert.equal(stops,1);assert.equal(provisions,0)
})

for(const stage of ['reserve','host-marker']) test(`resident second turn stopped during ${stage} never inherits previous effect flags`,async t=>{
 const h=await harness(t)
 h.emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{...zeroNativeTokens(),inputTokens:100,outputTokens:10,totalTokens:110}}}})
 h.emit({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}})
 await h.until(async()=>h.charged)
 const next=h.nextAdmission(stage);await next.arrival
 const stopped=h.relay.stop();next.unblock();assert.equal((await next.response).status,403)
 assert.equal((await h.call('/tool/stopped',{authorityTurnId:next.authorityTurnId,turnKey:next.turnKey})).status,200)
 assert.deepEqual(await stopped,{remoteStopped:true})
 assert.deepEqual(h.financeStops,[{index:2,hostStartAttempted:false,userSubmitted:false,remoteStopped:true}])
 assert.equal(h.receipts.length,1)
})
