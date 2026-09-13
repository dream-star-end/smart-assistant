/** Actual CCB CLI probe; no SDK/process/query stubs. Only parent lookup and child executor are fixtures. */
import {openReceiptDelivery} from '../../../../../claude-code-best/src/utils/receiptSqlite.js'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync,writeFileSync,readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { SubprocessRunner } from '../../subprocessRunner.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
const requestedMode=process.argv[3] || 'success';assert.ok(['success','direct','partial','child-failure','stop','mixed','notify-loser'].includes(requestedMode))
const wrapped=requestedMode!=='direct',mcp=true,mixed=requestedMode==='mixed',mode=requestedMode==='stop'?'stop':'create'
let releaseChild:()=>void=()=>{};const childGate=new Promise<void>(r=>{releaseChild=r})
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'')
const dir=process.argv[2]; assert.ok(dir)
mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'native'),{recursive:true})
const token=randomBytes(32).toString('hex'), session='agent:main:webchat:dm:real-model-cli', turnKey='real-model-cli-turn'
const requests:any[]=[], sdk:any[]=[], http:any[]=[]
let resolveBatchBoundary:()=>void=()=>{};const batchBoundary=new Promise<void>(r=>{resolveBatchBoundary=r})
let phase=0, executions=0, received=false, discovered=false, failure:any
let adapter:CcbAdapter, runner:SubprocessRunner, turn:any
const sentinel='REAL_MODEL_CLI_AUTHORITATIVE_RESULT'
const cli=`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-child-only`
const readPath=join(dir,'late-read.txt')
const suffix="; printf 'ORDINARY_SHELL_STDOUT'; printf 'ORDINARY_SHELL_STDERR' >&2; "+(mixed?`printf 'LATE_READ_AFTER_REAL_BASH' > ${JSON.stringify(readPath)}; `:'')+'exit '+(requestedMode==='success'||mixed?0:7)
const command=false?'timeout --signal=TERM 8s '+cli+'; timeout --signal=TERM 8s '+cli.replace('synthetic-child-only','synthetic-child-two'):cli+'; '+cli.replace('synthetic-child-only','synthetic-child-two')+suffix
function send(res:any,body:any,tool:boolean,wait=false,discover=false) {
 const id='synthetic_'+randomBytes(6).toString('hex');
 let content:any=tool?{type:'tool_use',id:wait?'real_waiter':'real_creator',name:mcp?`mcp__openclaude-memory__${wait?'delegate_wait':'delegate_tasks'}`:'Bash',input:mcp?(wait?{jobId:(db as any).db.prepare('SELECT job_id FROM delegate_jobs').get().job_id,waitMs:10000}:{tasks:[{agentId:'coding-assistant',goal:'synthetic-child-only'},{agentId:requestedMode==='partial'?'main':'coding-assistant',goal:'synthetic-child-two'}]}):{command:wait?`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate-wait ${(db as any).db.prepare('SELECT job_id FROM delegate_jobs').all().map((r:any)=>r.job_id).join(' ')}${suffix}`:command,timeout:20000}}:{type:'text',text:'SYNTHETIC_MODEL_DONE'}
 if(wrapped && tool) {
   content=discover?{type:'tool_use',id:'real_discovery',name:'SearchExtraTools',input:{query:'select:mcp__openclaude-memory__delegate_tasks,mcp__openclaude-memory__delegate_wait'}}:
     {...content,name:'ExecuteExtraTool',input:{tool_name:content.name,params:content.input}}
 }
 const blocks=mixed&&tool&&!discover?[content,{type:'tool_use',id:'late_read',name:'Read',input:{file_path:readPath}}]:[content]
 const message={id,type:'message',role:'assistant',model:body.model,content:blocks,stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}}
 if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return}
 res.setHeader('Content-Type','text/event-stream')
 const emit=(event:string,data:any)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
 emit('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null}})
 for(const [index,block] of blocks.entries()) {
  emit('content_block_start',{type:'content_block_start',index,content_block:tool?{...block,input:{}}:{type:'text',text:''}})
  emit('content_block_delta',{type:'content_block_delta',index,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}})
  emit('content_block_stop',{type:'content_block_stop',index})
 }
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
  const main=body.tools?.some((t:any)=>t.name===(wrapped?'ExecuteExtraTool':mcp?'mcp__openclaude-memory__delegate_task':'Bash'))
  if(main&&wrapped&&!discovered){
    assert.ok(!body.tools.some((t:any)=>t.name==='mcp__openclaude-memory__delegate_task'),'default MCP must remain deferred')
    discovered=true;send(res,body,true,false,true)
  }
  else if(main&&phase===0){
    if(wrapped)assert.ok(raw.includes('Found 2 deferred tool'),'actual discovery must finish before execution')
    phase++;send(res,body,true)
  }
  else if(main&&phase===1&&false){assert.equal(executions,2);assert.ok(!raw.includes(sentinel));releaseChild();phase++;send(res,body,true,true)}
  else {if(main){received=raw.includes(sentinel);phase++;writeFileSync(join(dir,'model-final-messages.json'),JSON.stringify(body.messages,null,2))}if(main&&mixed){resolveBatchBoundary();return}send(res,body,false)}
 }catch(e){failure=e;res.statusCode=500;res.end('{}')}
})
await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r))
const upstreamPort=(upstream.address() as any).port
const dbPath=join(dir,'delegate-jobs.db'),db=new DelegateDurableDb(dbPath)
const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true})
const config:any={version:1,gateway:{bind:'127.0.0.1',port:0,accessToken:token},auth:{mode:'subscription',claudeCodePath:join(root,'claude-code-best'),claudeCodeEntry:'scripts/dev.ts'},sessions:{dbPath:join(dir,'sessions.db')},defaults:{model:'claude-sonnet-4-5-20250929',permissionMode:'bypassPermissions'},channels:{webchat:{enabled:true}},terminal:{type:'local'}}
const gw=new Gateway({config,agentsConfig:{agents:[{id:'main',model:config.defaults.model}],routes:[],default:'main'}} as any)
;(gw as any)._delegateJobs=jobs;(gw as any)._delegateReconcileReady=true;(gw as any)._readDelegateMemoryPressure=()=>null
;(gw as any)._runDelegateTask=async(input:any)=>{
 const execution=++executions;const claim=jobs.claimQueued(input.backgroundJobId);assert.ok(claim.ok)
 input.claimToken=claim.claimToken;input.fencingEpoch=claim.fencingEpoch
 if(false)await childGate
 ;(gw as any)._releasePreadmittedDelegateCapacity(input)
 if(execution===2)writeFileSync(readPath,'LATE_READ_AFTER_REAL_BATCH')
 if(requestedMode==='child-failure'&&execution===2)throw Error(sentinel+execution+'_CHILD_FAILURE')
 return {kind:'completed',ok:true,output:sentinel+execution,sessionKey:input.sessionKey}
}
let selectedNotify = false
const server=createServer(async(req,res)=>{
 res.on('finish',()=>http.push({path:req.url,status:res.statusCode}))
 try {
  if(req.url==='/api/delegate/receipt-owner/input') {
   if(mode==='stop')adapter.interrupt()
   if(requestedMode==='notify-loser'&&!selectedNotify) {
    selectedNotify=true
    const first=(db as any).db.prepare('SELECT job_id FROM delegate_delivery_receipt ORDER BY rowid LIMIT 1').get()
    const binding=db.getDeliveryReceipt(first.job_id,0)!
    const delivery=await openReceiptDelivery(dbPath)
    // Deliberately select the competing notify owner at a deterministic seam;
    // real coordinator/state/native/HTTP, NOT a production parent-death race.
    try { assert.equal(await delivery.recover(binding,async()=>({kind:'absent'}),async()=>'inactive'),'notify_ready') }
    finally {delivery.close()}
   }
  }
  void(gw as any).handleHttp(req,res)
 }catch(error){failure=error;res.statusCode=500;res.end('{}')}
})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;config.gateway.port=port
writeFileSync(join(dir,'token'),token,{mode:0o600})
process.env.OPENCLAUDE_GATEWAY_PORT=String(port);process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE=join(dir,'token')
process.env.OPENCLAUDE_HOME=dir;process.env.OPENCLAUDE_DELEGATE_JOBS_DB=dbPath
if(mcp)process.env.OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS='5000'
process.env.CLAUDE_CONFIG_DIR=join(dir,'native');process.env.OPENCLAUDE_RECEIPT_CALLER_V2='1'
const providerEnvOverride={...(mcp&&!wrapped?{ENABLE_SEARCH_EXTRA_TOOLS:'false'}:{}),ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstreamPort}`,ANTHROPIC_API_KEY:'synthetic-local-only',ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_UNATTENDED_RETRY:'0',CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'1',NPM_CONFIG_OFFLINE:'true'}
runner=new SubprocessRunner({sessionKey:session,agentId:'main',agentBaseDir:dir,config,harness:'ccb',model:config.defaults.model,permissionMode:'bypassPermissions',providerEnvOverride})
adapter=new CcbAdapter({harness:'ccb'} as any,runner)
const parent={userId:'default',sessionKey:session,agentId:'main',_currentTurnKey:turnKey,runner:adapter}
;(gw as any).sessions={getByKey:(key:string)=>key===session?parent:undefined}
runner.on('message',(m:any)=>{sdk.push(m);if(m.type==='control_request'&&m.request?.subtype==='can_use_tool')runner.sendPermissionResponse(m.request_id,{behavior:'allow',updatedInput:m.request.input} as any)})
runner.on('stderr',(line:any)=>{process.stderr.write(String(line)+'\n')})
runner.on('error',(e:any)=>{failure=e})
process.once('SIGTERM',()=>{failure=Error('fixture terminated');turn?.end();void runner.shutdown()})
let timer:ReturnType<typeof setTimeout>|undefined
try {
 turn=adapter.submitTurn({input:'RECEIPT_MODEL_PROBE: run synthetic child command then report its result.',turnKey,onEvent(){},sessionTotals:{totalCostUSD:0,turns:0},toolUseIdToName:new Map()} as any)
 await Promise.race([turn.submitted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('submit deadline')),60000)})]);clearTimeout(timer)
 const result=await Promise.race([mixed?batchBoundary:turn.summary,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('model turn deadline')),90000)})]);clearTimeout(timer)
 assert.ok(!failure,String(failure));assert.equal(executions,requestedMode==='partial'?1:2);assert.equal(received,mode!=='stop')
 assert.ok(runner.sessionId);assert.equal(phase,false?3:mode==='stop'?1:2)
 const rows=(db as any).db.prepare('SELECT * FROM delegate_delivery_receipt').all();writeFileSync(join(dir,'receipt-rows.json'),JSON.stringify(rows,null,2));assert.equal(rows.length,requestedMode==='partial'?1:2);assert.ok(rows.every((r:any,i:number)=>r.state===(mode==='stop'?'offered':requestedMode==='notify-loser'&&i===0?'notify_pending':'ingested')),'each ready result requires its own durable receipt');const row=rows[0];assert.equal(row.state,mode==='stop'?'offered':requestedMode==='notify-loser'?'notify_pending':'ingested');assert.equal(row.native_tool_use_id,'real_creator')
 if(mode!=='stop') {
  const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
  const ordinary=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='real_creator'):[])
  assert.equal(ordinary.length,1)
  assert.ok(JSON.stringify(ordinary).includes('最终执行结论由各项持久结果单独交付'))
  assert.ok(!JSON.stringify(ordinary).includes(sentinel),'original aggregate has no unadmitted authoritative bytes')
  if(requestedMode==='partial') assert.ok(JSON.stringify(ordinary).includes('1 项请求或等待异常'))
  if(requestedMode==='child-failure') assert.ok(JSON.stringify(modelMessages).includes('CHILD_FAILURE'))
  const nativeInputs=sdk.filter((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes(sentinel))
  assert.equal(nativeInputs.length,requestedMode==='partial'||requestedMode==='notify-loser'?1:2)
  assert.equal(new Set(rows.map((r:any)=>r.receipt_nonce_hash)).size,rows.length,'each child keeps an independent nonce')
  if(mixed) {
    const users=sdk.filter((m:any)=>m.type==='user')
    const indexOf=(id:string)=>users.findIndex((m:any)=>m.message?.content?.some((c:any)=>c.type==='tool_result'&&c.tool_use_id===id))
    assert.ok(indexOf('real_creator')>=0&&indexOf('late_read')>indexOf('real_creator'))
    const read=users[indexOf('late_read')].message.content.find((c:any)=>c.type==='tool_result'&&c.tool_use_id==='late_read')
    assert.ok(!read.is_error&&JSON.stringify(read.content).includes('LATE_READ_AFTER_REAL_BATCH'))
    assert.ok(users.flatMap((m:any,i:number)=>JSON.stringify(m.message).includes(sentinel)?[i]:[]).every(i=>i>indexOf('late_read')))
    assert.ok(!sdk.some((m:any)=>m.type==='assistant'&&JSON.stringify(m).includes('SYNTHETIC_MODEL_DONE')))
  }
 }
 if(requestedMode==='notify-loser')assert.equal((db as any).db.prepare("SELECT count(*) AS n FROM delegate_jobs WHERE callback_state='pending'").get().n,1)
 if(mode==='stop')assert.ok(!sdk.some((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes(sentinel)))
 process.stdout.write('MODEL_PROBE_PASS '+JSON.stringify({mode:requestedMode,nativeSession:runner.sessionId,phase,executions,received,isError:result?.isError,receiptState:row.state})+'\n')
} catch(e){failure=e;process.exitCode=1;process.stderr.write(String(e)+'\n'+JSON.stringify({requests,http,sdkErrors:sdk.filter((m:any)=>m.type==='user'||m.type==='result').map((m:any)=>({type:m.type,message:m.message,errors:m.errors}))})+'\n')}
finally {
 clearTimeout(timer);releaseChild();turn?.end();await runner.shutdown();server.closeAllConnections();upstream.closeAllConnections()
 await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))])
 writeFileSync(join(dir,'evidence.json'),JSON.stringify({mode:requestedMode,requests,http,sdk,nativeSession:runner.sessionId,phase,executions,received,failure:failure?String(failure):null,boundary:'actual SubprocessRunner+CCB CLI/SDK/HTTP/SQLite; SessionManager lookup and child executor fixture'},null,2))
 jobs.close()
}

process.exitCode=failure?1:0
