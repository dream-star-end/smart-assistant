/** Actual CCB CLI probe; no SDK/process/query stubs. Only parent lookup and child executor are fixtures. */
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { receiptParentDeathState } from '../../receiptParentProcess.js'
import { randomBytes } from 'node:crypto'
import { mkdirSync,writeFileSync,readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { SubprocessRunner } from '../../subprocessRunner.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../../delegateDurable.js'

const requestedMode=process.argv[3] || 'end';const handoff=requestedMode.startsWith('handoff-');const wrapped=requestedMode==='handoff-deferred';const mcp=wrapped||requestedMode==='handoff-mcp';const mode=handoff?'cross-turn':requestedMode;let jobToWait='',discovered=false;assert.ok(['end','kill','cross-turn','ingested-end'].includes(mode))
let releaseChild:()=>void=()=>{};const childGate=new Promise<void>(r=>{releaseChild=r})
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'')
const dir=process.argv[2]; assert.ok(dir)
mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'native'),{recursive:true})
const token=randomBytes(32).toString('hex'), session='agent:main:webchat:dm:real-model-cli', turnKey='real-model-cli-turn'
const requests:any[]=[], sdk:any[]=[], http:any[]=[]
let phase=0, executions=0, received=false, failure:any
let adapter:CcbAdapter, runner:SubprocessRunner, turn:any
let visible=true, nextTurnStarted=false, savedOwner:any, killedSignal:string|null=null
let markKilled:()=>void=()=>{};const killed=new Promise<void>(r=>{markKilled=r})
const masterRequests:any[]=[], accepted=new Map<string,any>(), terminalWork:Promise<void>[]=[]
async function until(check:()=>boolean, label:string, ms=60000) {
 const end=Date.now()+ms; while(!check()){assert.ok(Date.now()<end,label);await new Promise(r=>setTimeout(r,20))}
}
async function settle() {
 await Promise.all(terminalWork);
 await (gw as any)._retryDelegateNotifies();
 await Promise.all(terminalWork);
}
const sentinel='REAL_MODEL_CLI_AUTHORITATIVE_RESULT'
const cli=`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-child-only`
const command=cli
function send(res:any,body:any,tool:boolean,wait=false) {
 const id='synthetic_'+randomBytes(6).toString('hex');
 let content:any=tool?{type:'tool_use',id:wait?'real_waiter':'real_creator',name:'Bash',input:wait?
  {command:handoff?`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate-wait ${jobToWait}`:'printf background-checkpoint',timeout:20000}:
  {command,timeout:20000,run_in_background:true}}:{type:'text',text:'SYNTHETIC_MODEL_DONE'}
 if(tool&&wait&&mcp) {
  content={...content,name:'mcp__openclaude-memory__delegate_wait',input:{jobId:jobToWait,waitMs:10000}}
  if(wrapped) content=discovered?{...content,name:'ExecuteExtraTool',input:{tool_name:content.name,params:content.input}}:
   {type:'tool_use',id:'real_discovery',name:'SearchExtraTools',input:{query:'select:mcp__openclaude-memory__delegate_wait'}}
 }
 const message={id,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}}
 if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return}
 res.setHeader('Content-Type','text/event-stream')
 const emit=(event:string,data:any)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
 emit('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null}})
 emit('content_block_start',{type:'content_block_start',index:0,content_block:tool?{...content,input:{}}:{type:'text',text:''}})
 emit('content_block_delta',{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}})
 emit('content_block_stop',{type:'content_block_stop',index:0})
 emit('message_delta',{type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}})
 emit('message_stop',{type:'message_stop'});res.end()
}
const upstream=createServer(async(req,res)=>{
 try {
  let raw='';for await(const c of req)raw+=c
  const body=JSON.parse(raw||'{}')
  assert.ok(req.headers['x-api-key']==='synthetic-local-only'||req.headers.authorization==='Bearer synthetic-local-only','only synthetic upstream auth permitted')
  requests.push({path:req.url,method:req.method,model:body.model,stream:body.stream,containsSentinel:raw.includes(sentinel),toolNames:body.tools?.map((t:any)=>t.name)})
  if(req.url?.includes('count_tokens')) {res.end(JSON.stringify({input_tokens:100}));return}
  if(!req.url?.startsWith('/v1/messages')){res.statusCode=404;res.end('{}');return}
  const main=body.tools?.some((t:any)=>t.name==='Bash')
  if(main&&nextTurnStarted){
    if(wrapped&&!discovered){send(res,body,true,true);discovered=true}
     else {nextTurnStarted=false;send(res,body,true,true)}
  }
  else if(main&&phase===0){
    phase++;send(res,body,true)
  }
  else if(main&&phase===1){
     assert.ok(!raw.includes(sentinel),'background placeholder cannot contain result')
     const deadline=Date.now()+20000
     while(executions!==1){assert.ok(Date.now()<deadline,'create deadline');await new Promise(r=>setTimeout(r,20))}
     savedOwner=adapter.getReceiptToolOwner('real_creator');assert.ok(savedOwner?.parentProcess)
     if(mode==='kill') {
       const proc=runner.receiptProcessIdentity as ChildProcess;assert.equal(proc.pid,savedOwner.parentProcess.pid)
       const closed=once(proc,'close');visible=false;process.kill(-proc.pid!,'SIGKILL');await closed;killedSignal=proc.signalCode;markKilled()
       assert.equal(receiptParentDeathState(savedOwner.parentProcess),'inactive');res.end();return
     }
     if(mode!=='ingested-end'){phase++;send(res,body,false);return}
     releaseChild()
     while(!http.some(r=>r.path==='/api/delegate/receipt-owner/status'&&r.status===200)){
       assert.ok(Date.now()<deadline,'authenticated shell notification deadline');await new Promise(r=>setTimeout(r,20))
     }
     phase++;send(res,body,true,true)
   }
  else {if(main&&mode==='cross-turn'){await until(()=>accepted.size===1,'cross-turn callback accepted')}if(main){received=raw.includes(sentinel);phase++;writeFileSync(join(dir,'model-final-messages.json'),JSON.stringify(body.messages,null,2))}send(res,body,false)}
 }catch(e){failure=e;res.statusCode=500;res.end('{}')}
})
await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r))
const upstreamPort=(upstream.address() as any).port
const dbPath=join(dir,'delegate-jobs.db')
Object.assign(process.env,{OPENCLAUDE_HOME:dir,OPENCLAUDE_DELEGATE_JOBS_DB:dbPath,OC_DELEGATE_SM:'1',OC_DELEGATE_DURABLE:'1',OC_DELEGATE_NOTIFIER:'1'})
// F2 notification requires a real active private client row, not just an SDK parent stub.
const {upsertClientSession}=await import('../../../../storage/src/sessionsDb.js')
await upsertClientSession({id:'real-model-cli',userId:'default',agentId:'main',title:'private lifecycle fixture',pinned:false,
 createdAt:1000,lastAt:1000,updatedAt:1000,messages:[]})
const config:any={version:1,gateway:{bind:'127.0.0.1',port:0,accessToken:token},auth:{mode:'subscription',claudeCodePath:join(root,'claude-code-best'),claudeCodeEntry:'scripts/dev.ts'},sessions:{dbPath:join(dir,'sessions.db')},defaults:{model:'claude-sonnet-4-5-20250929',permissionMode:'bypassPermissions'},channels:{webchat:{enabled:true}},terminal:{type:'local'}}
const gw=new Gateway({config,agentsConfig:{agents:[{id:'main',model:config.defaults.model}],routes:[],default:'main'}} as any)
// Keep the actual production constructor, terminal hook, boot/retry scheduler and notifier.
// Only fixture enrollment opts in; production gate is unchanged and asserted closed.
;(gw as any)._delegateDurablePath=dbPath
const jobs=(gw as any)._ensureDelegateJobStore()
assert.equal(jobs.acceptsDeliveryReceipts,false)
const db=(jobs as any).durable as DelegateDurableDb
assert.ok(db instanceof DelegateDurableDb);assert.equal(db.path,dbPath)
Object.defineProperty(jobs,'acceptsDeliveryReceipts',{get:()=>true})
const dispatch=(gw as any)._dispatchDelegateNotify.bind(gw)
;(gw as any)._dispatchDelegateNotify=(job:any)=>{const work=dispatch(job);terminalWork.push(work);return work}
;(gw as any)._readDelegateMemoryPressure=()=>null
const master=createServer(async(req,res)=>{
 try {
  assert.equal(req.url,'/internal/v3/cron-origin-inject');assert.equal(req.headers.authorization,'Bearer synthetic-master-only')
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw)
  assert.equal(body.sessionId,'real-model-cli');assert.equal(body.agentId,'main');assert.ok(body.text.includes(sentinel))
  masterRequests.push(body)
  if(!accepted.has(body.clientMessageId)) {accepted.set(body.clientMessageId,body);writeFileSync(join(dir,'master-accepted.json'),JSON.stringify([...accepted.values()]))}
  res.end('{}')
 }catch(e){failure=e;res.statusCode=500;res.end('{}')}
})
await new Promise<void>(r=>master.listen(0,'127.0.0.1',r))
function enableMasterCallback(){
 process.env.OPENCLAUDE_V3_MASTER_BASE_URL=`http://127.0.0.1:${(master.address() as any).port}`
 process.env.OPENCLAUDE_V3_CONTAINER_TOKEN='synthetic-master-only'
}
;(gw as any)._runDelegateTask=async(input:any)=>{
 executions++;const claim=jobs.claimQueued(input.backgroundJobId);assert.ok(claim.ok)
 input.claimToken=claim.claimToken;input.fencingEpoch=claim.fencingEpoch
 await childGate
 ;(gw as any)._releasePreadmittedDelegateCapacity(input)
 return {kind:'completed',ok:true,output:sentinel,sessionKey:input.sessionKey}
}
const server=createServer((req,res)=>{res.on('finish',()=>http.push({path:req.url,status:res.statusCode}));void(gw as any).handleHttp(req,res)})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;config.gateway.port=port
writeFileSync(join(dir,'token'),token,{mode:0o600})
process.env.OPENCLAUDE_GATEWAY_PORT=String(port);process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE=join(dir,'token')
process.env.OPENCLAUDE_HOME=dir;process.env.OPENCLAUDE_DELEGATE_JOBS_DB=dbPath
process.env.CLAUDE_CONFIG_DIR=join(dir,'native');process.env.OPENCLAUDE_RECEIPT_CALLER_V2='1'
const providerEnvOverride={...(mcp&&!wrapped?{ENABLE_SEARCH_EXTRA_TOOLS:'false'}:{}),ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstreamPort}`,ANTHROPIC_API_KEY:'synthetic-local-only',ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_UNATTENDED_RETRY:'0',CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'1',NPM_CONFIG_OFFLINE:'true'}
runner=new SubprocessRunner({sessionKey:session,agentId:'main',agentBaseDir:dir,config,harness:'ccb',model:config.defaults.model,permissionMode:'bypassPermissions',providerEnvOverride})
adapter=new CcbAdapter({harness:'ccb'} as any,runner)
const parent={userId:'default',sessionKey:session,agentId:'main',_currentTurnKey:turnKey,runner:adapter}
;(gw as any).sessions={getByKey:(key:string)=>key===session&&visible?parent:undefined}
runner.on('message',(m:any)=>{sdk.push(m);if(m.type==='control_request'&&m.request?.subtype==='can_use_tool')runner.sendPermissionResponse(m.request_id,{behavior:'allow',updatedInput:m.request.input} as any)})
runner.on('stderr',(line:any)=>{process.stderr.write(String(line)+'\n')})
runner.on('error',(e:any)=>{if(mode!=='kill')failure=e})
process.once('SIGTERM',()=>{failure=Error('fixture terminated');turn?.end();void runner.shutdown()})
let timer:ReturnType<typeof setTimeout>|undefined
try {
 turn=adapter.submitTurn({input:'RECEIPT_MODEL_PROBE: run synthetic child command then report its result.',turnKey,onEvent(){},sessionTotals:{totalCostUSD:0,turns:0},toolUseIdToName:new Map()} as any)
 await Promise.race([turn.submitted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('submit deadline')),60000)})]);clearTimeout(timer)
 const result=await Promise.race([mode==='kill'?killed:turn.summary,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('model turn or actual kill deadline')),90000)})]);clearTimeout(timer)
 assert.ok(!failure,String(failure));assert.equal(executions,1)
 assert.ok(runner.sessionId)
 if(mode==='kill')await until(()=>killedSignal==='SIGKILL','actual parent close after SIGKILL')
 const jobId=(db as any).db.prepare('SELECT job_id FROM delegate_jobs').get().job_id as string
 const before=db.getDeliveryReceipt(jobId,0)
 if(mode!=='ingested-end'){
  assert.equal(received,false);assert.equal(accepted.size,0)
  if(mode==='cross-turn') {
   jobToWait=jobId;parent._currentTurnKey='real-next-turn';nextTurnStarted=true
   turn=adapter.submitTurn({input:'New real user turn; old child still pending.',turnKey:parent._currentTurnKey,onEvent(){},sessionTotals:{totalCostUSD:0,turns:1},toolUseIdToName:new Map()} as any)
   await turn.submitted
   await until(()=>!!adapter.getReceiptToolOwner('real_waiter'),'new SDK owner')
   const newOwner=adapter.getReceiptToolOwner('real_waiter')!
   assert.notEqual(newOwner.parentOwnerEpoch,savedOwner.parentOwnerEpoch)
   assert.equal(adapter.checkReceiptOwner(savedOwner),'inactive')
  }else if(mode==='end') {
   assert.equal(adapter.checkReceiptOwner(savedOwner),'inactive')
  }
  enableMasterCallback();releaseChild()
  await until(()=>jobs.snapshotOf(jobId)?.state==='completed','child terminal')
 }else {assert.equal(received,true);assert.equal(before?.state,'ingested')}
 enableMasterCallback()
 // Assert the actual terminal hook delivered BEFORE manually exercising retry/adoption.
 await Promise.all(terminalWork)
 assert.equal(accepted.size,mode==='ingested-end'?0:1,'terminal hook must select the sole delivery before retry')
 await settle()
 await (gw as any)._adoptOrphanedStdoutWaitDelegates(session,{userId:'default'})
 await settle()
 const row=db.getDeliveryReceipt(jobId,0)!
 assert.equal(row.state,mode==='ingested-end'?'ingested':'notified')
 assert.equal(row.nativeToolUseId,'real_creator')
 assert.equal(masterRequests.length,mode==='ingested-end'?0:1)
 assert.equal(accepted.size,mode==='ingested-end'?0:1)
 assert.equal(jobs.snapshotOf(jobId).callbackState,mode==='ingested-end'?'none':'delivered')
 assert.ok(terminalWork.length>=1,'actual onTerminal dispatch must execute')
 if(mode==='cross-turn')await turn.summary
 if(handoff) {
  const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
  const waited=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='real_waiter'):[])
  assert.equal(waited.length,1);assert.notEqual(waited[0].is_error,true,JSON.stringify(waited))
  assert.ok(JSON.stringify(waited).includes('原回调'));assert.ok(!JSON.stringify(waited).includes(sentinel))
  assert.ok(!JSON.stringify(waited).includes('receipt-locator'))
  assert.equal(http.filter(r=>r.path==='/api/delegate/receipt-owner/handoff-status'&&r.status===200).length,1)
  assert.equal(http.filter(r=>r.path==='/api/delegate/wait'||r.path==='/api/delegate/receipt-owner/input').length,0)
  assert.equal(http.filter(r=>r.path==='/api/agents/coding-assistant/delegate').length,1)
 }
 if(mode==='kill')assert.equal(killedSignal,'SIGKILL')
 if(mode==='ingested-end') {
  const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
  const modelResults=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='real_creator'):[])
  const nativeResults=sdk.flatMap((m:any)=>m.type==='user'&&Array.isArray(m.message?.content)?m.message.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='real_creator'):[])
  assert.equal(modelResults.length,1);assert.equal(nativeResults.length,1);assert.deepEqual(modelResults[0].content,nativeResults[0].content)
   assert.ok(!JSON.stringify(modelResults).includes(sentinel),'no duplicate tool result')
   const resultTexts=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='text'&&c.text.includes(sentinel)):[])
   assert.equal(resultTexts.length,1,'exactly one admitted background user input')
 }
 if(mode!=='ingested-end')assert.ok(!sdk.some((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes(sentinel)))
 process.stdout.write('MODEL_PROBE_PASS '+JSON.stringify({mode:requestedMode,nativeSession:runner.sessionId,phase,executions,received,isError:result?.isError,receiptState:row.state,masterRequests:masterRequests.length,accepted:accepted.size,terminalCalls:terminalWork.length,killedSignal})+'\n')
} catch(e){failure=e;process.exitCode=1;process.stderr.write(String(e)+'\n'+JSON.stringify({requests,http,sdkErrors:sdk.filter((m:any)=>m.type==='user'||m.type==='result').map((m:any)=>({type:m.type,message:m.message,errors:m.errors}))})+'\n')}
finally {
 clearTimeout(timer);releaseChild();turn?.end();await runner.shutdown();
 if(executions===1)await until(()=>jobs.listNonTerminal().length===0,'cleanup child terminal');
 await settle();
 clearTimeout((gw as any)._notifyRetryTimer);clearTimeout((gw as any)._delegateReconcileTimer);clearInterval((gw as any)._delegateReapTimer)
 server.closeAllConnections();upstream.closeAllConnections();master.closeAllConnections()
 await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r())),new Promise<void>(r=>master.close(()=>r()))])
 writeFileSync(join(dir,'evidence.json'),JSON.stringify({mode:requestedMode,masterRequests,accepted:[...accepted.values()],terminalCalls:terminalWork.length,killedSignal,requests,http,sdk,nativeSession:runner.sessionId,phase,executions,received,failure:failure?String(failure):null,boundary:'actual SubprocessRunner+CCB CLI/SDK/HTTP/SQLite; SessionManager lookup, child executor, enrollment opt-in and master receiver fixtures; actual production store hooks, recovery, notifier and HTTP client'},null,2))
 jobs.close()
}

process.exitCode=failure?1:0
