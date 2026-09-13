/** Actual CCB CLI probe; no SDK/process/query stubs. Only parent lookup and child executor are fixtures. */
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,existsSync } from 'node:fs'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { SubprocessRunner } from '../../subprocessRunner.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
import { receiptLocatorPartition } from '../../receiptOwnerCapability.js'
const requestedMode=process.argv[3] || 'create', wrapped=requestedMode.startsWith('deferred-'), mcp=wrapped||requestedMode.startsWith('mcp-')
const mixed=requestedMode==='mixed'
const incomplete=requestedMode==='missing-locator'||requestedMode==='corrupt-locator'
const mode=incomplete?'wait':(requestedMode==='success'||mixed)?'create':requestedMode.replace(/^(mcp|deferred)-/, '');assert.ok(['create','wait','stop'].includes(mode))
let releaseChild:()=>void=()=>{};const childGate=new Promise<void>(r=>{releaseChild=r})
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'')
const dir=process.argv[2]; assert.ok(dir)
mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'native'),{recursive:true})
const token=randomBytes(32).toString('hex'), session='agent:main:webchat:dm:real-model-cli', turnKey='real-model-cli-turn'
const requests:any[]=[], sdk:any[]=[], http:any[]=[]
let resolveBatchBoundary:()=>void=()=>{};const batchBoundary=new Promise<void>(r=>{resolveBatchBoundary=r})
let phase=0, executions=0, received=false, discovered=false, failure:any
let receiptBindingsBefore: Array<{job_id:string;receipt_nonce_hash:string;native_tool_use_id:string}> = []
let missingJobId:string|undefined
let adapter:CcbAdapter, runner:SubprocessRunner, turn:any
const sentinel='REAL_MODEL_CLI_AUTHORITATIVE_RESULT'
const cli=`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-child-only`
const readPath=join(dir,'late-read.txt')
const suffix="; printf 'ORDINARY_SHELL_STDOUT'; printf 'ORDINARY_SHELL_STDERR' >&2; "+(mixed?`printf 'LATE_READ_AFTER_REAL_BASH' > ${JSON.stringify(readPath)}; `:'')+'exit '+(requestedMode==='success'||mixed?0:7)
const command=mode==='wait'?'timeout --signal=TERM 8s '+cli+'; timeout --signal=TERM 8s '+cli.replace('synthetic-child-only','synthetic-child-two'):cli+'; '+cli.replace('synthetic-child-only','synthetic-child-two')+suffix
function send(res:any,body:any,tool:boolean,wait=false,discover=false) {
 const id='synthetic_'+randomBytes(6).toString('hex');
 let content:any=tool?{type:'tool_use',id:wait?'real_waiter':'real_creator',name:mcp?`mcp__openclaude-memory__${wait?'delegate_wait':'delegate_task'}`:'Bash',input:mcp?(wait?{jobId:(db as any).db.prepare('SELECT job_id FROM delegate_jobs').get().job_id,waitMs:10000}:{agentId:'coding-assistant',goal:'synthetic-child-only'}):{command:wait?`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate-wait ${(db as any).db.prepare('SELECT job_id FROM delegate_jobs').all().map((r:any)=>r.job_id).join(' ')}${incomplete?'; multiwait_code=$?; printf \"MULTIWAIT_EXIT:%s\" \"$multiwait_code\"':''}${suffix}`:command,timeout:20000}}:{type:'text',text:'SYNTHETIC_MODEL_DONE'}
 if(wrapped && tool) {
   content=discover?{type:'tool_use',id:'real_discovery',name:'SearchExtraTools',input:{query:'select:mcp__openclaude-memory__delegate_task,mcp__openclaude-memory__delegate_wait'}}:
     {...content,name:'ExecuteExtraTool',input:{tool_name:content.name,params:content.input}}
 }
 const blocks=mixed&&tool?[content,{type:'tool_use',id:'late_read',name:'Read',input:{file_path:readPath}}]:[content]
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
  else if(main&&phase===1&&mode==='wait'){
    assert.equal(executions,2,'two actual child executors before wait');assert.ok(!raw.includes(sentinel))
    if(incomplete) {
      // Receipt rows are offered by the real terminal commit, not by create.
      // Both original CLI processes have exited; finish the children before
      // inspecting their immutable bindings and inducing local cache loss.
      releaseChild()
      const deadline=Date.now()+10000
      while((db as any).db.prepare('SELECT count(*) n FROM delegate_delivery_receipt').get().n!==2) {
        assert.ok(Date.now()<deadline,'real terminal receipts deadline')
        await new Promise(r=>setTimeout(r,10))
      }
      receiptBindingsBefore=(db as any).db.prepare('SELECT job_id,receipt_nonce_hash,native_tool_use_id FROM delegate_delivery_receipt ORDER BY rowid').all()
      assert.equal(receiptBindingsBefore.length,2,'two persisted receipts before corrupting candidate')
      const owner=adapter.getReceiptToolOwner('real_creator');assert.ok(owner)
      const partition=receiptLocatorPartition({...owner,userId:'default',agentId:'main',sessionKey:session})
      const cache=join(dir,'receipt-candidates-v1','data',partition,'cache')
      assert.ok(existsSync(join(cache,receiptBindingsBefore[0]!.job_id+'.json')))
      missingJobId=receiptBindingsBefore[1]!.job_id
      const file=join(cache,missingJobId+'.json');assert.ok(existsSync(file))
      // Exact private candidate, not a job/nonce mutation or a recovery fallback.
      // Both real CLI creates succeeded; emulate loss/corruption before later wait.
      if(requestedMode==='missing-locator')unlinkSync(file)
      else writeFileSync(file,'{incomplete-private-record')
    }
    releaseChild();phase++;send(res,body,true,true)
  }
  else {if(main){received=raw.includes(sentinel);phase++;writeFileSync(join(dir,'model-final-messages.json'),JSON.stringify(body.messages,null,2))}if(main&&mixed){resolveBatchBoundary();return}send(res,body,false)}
 }catch(e){failure=e;process.stderr.write('UPSTREAM_FIXTURE_ERROR '+(e instanceof Error?e.stack:String(e))+'\n');res.statusCode=500;res.end('{}')}
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
 if(mode==='wait')await childGate
 ;(gw as any)._releasePreadmittedDelegateCapacity(input)
 return {kind:'completed',ok:true,output:sentinel+execution,sessionKey:input.sessionKey}
}
const server=createServer((req,res)=>{res.on('finish',()=>http.push({path:req.url,status:res.statusCode}));if(mode==='stop'&&req.url==='/api/delegate/receipt-owner/input')adapter.interrupt();void(gw as any).handleHttp(req,res)})
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
 assert.ok(!failure,String(failure));assert.equal(executions,2);assert.equal(received,mode!=='stop')
 assert.ok(runner.sessionId);assert.equal(phase,mode==='wait'?3:mode==='stop'?1:2)
 const rows=(db as any).db.prepare('SELECT * FROM delegate_delivery_receipt ORDER BY rowid').all();writeFileSync(join(dir,'receipt-rows.json'),JSON.stringify(rows,null,2));assert.equal(rows.length,2)
 if(incomplete) {
  assert.deepEqual(rows.map((r:any)=>({job_id:r.job_id,receipt_nonce_hash:r.receipt_nonce_hash,native_tool_use_id:r.native_tool_use_id})),receiptBindingsBefore)
  assert.deepEqual(rows.map((r:any)=>r.state),['ingested','offered'])
  assert.ok(rows.every((r:any)=>r.native_tool_use_id==='real_creator'))
  assert.equal(http.filter((r:any)=>r.path==='/api/agents/coding-assistant/delegate').length,2)
  assert.equal(http.filter((r:any)=>r.path==='/api/delegate/wait').length,0)
  assert.equal(http.filter((r:any)=>r.path==='/api/delegate/receipt-owner/input').length,1)
 } else assert.ok(rows.every((r:any)=>r.state==='ingested'),'both results must be durably ingested')
 const row=rows[0];assert.equal(row.state,mode==='stop'?'offered':'ingested');assert.equal(row.native_tool_use_id,'real_creator')
 if(mode!=='stop') {
  const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
  const modelResults=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id===(mode==='wait'?'real_waiter':'real_creator')):[])
  const nativeResults=sdk.flatMap((m:any)=>m.type==='user'&&Array.isArray(m.message?.content)?m.message.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id===(mode==='wait'?'real_waiter':'real_creator')):[])
  assert.ok(JSON.stringify(modelMessages).includes(sentinel+'1'))
  if(incomplete) {
    assert.ok(!JSON.stringify(modelMessages).includes(sentinel+'2'))
    assert.ok(JSON.stringify(modelResults).includes('receipt locator unavailable; job retained, do not resubmit'))
    assert.ok(JSON.stringify(modelResults).includes(missingJobId!))
    assert.ok(JSON.stringify(modelResults).includes('MULTIWAIT_EXIT:2'))
  } else assert.ok(JSON.stringify(modelMessages).includes(sentinel+'2'));
  assert.ok(JSON.stringify(modelResults).includes('ORDINARY_SHELL_STDOUT'));assert.ok(JSON.stringify(modelResults).includes('ORDINARY_SHELL_STDERR'));assert.equal(Boolean(modelResults[0].is_error),!(requestedMode==='success'||mixed));assert.equal(modelResults.length,1);assert.equal(nativeResults.length,1);assert.deepEqual(modelResults[0].content,nativeResults[0].content)
 }
 if(mixed) {
  // The second real model REQUEST has arrived, but no response/assistant output
  // can repair the chain. queryReceiptBatch separately stops before any request.
  const users=sdk.filter((m:any)=>m.type==='user')
  const indexOf=(id:string)=>users.findIndex((m:any)=>m.message?.content?.some((c:any)=>c.type==='tool_result'&&c.tool_use_id===id))
  assert.ok(indexOf('real_creator')>=0&&indexOf('late_read')>indexOf('real_creator'),'real Read must complete after real Bash')
  const read=users[indexOf('late_read')].message.content.find((c:any)=>c.type==='tool_result'&&c.tool_use_id==='late_read')
  assert.ok(!read.is_error&&JSON.stringify(read.content).includes('LATE_READ_AFTER_REAL_BASH'),'Read must read the file actually created by Bash')
  assert.equal(users.filter((m:any)=>m.message?.content?.some((c:any)=>c.type==='tool_result'&&c.tool_use_id==='late_read')).length,1)
  const receiptIndices=users.flatMap((m:any,i:number)=>JSON.stringify(m.message).includes(sentinel)?[i]:[])
  assert.equal(receiptIndices.length,2);assert.ok(receiptIndices.every(i=>i>indexOf('late_read')))
  assert.equal(new Set(sdk.filter((m:any)=>m.type==='assistant').map((m:any)=>m.message.id)).size,1,'both tools belong to one real assistant batch')
  assert.ok(!sdk.some((m:any)=>m.type==='assistant'&&JSON.stringify(m).includes('SYNTHETIC_MODEL_DONE')))
 }
 if(mode==='stop')assert.ok(!sdk.some((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes(sentinel)))
 process.stdout.write('MODEL_PROBE_PASS '+JSON.stringify({mode:requestedMode,nativeSession:runner.sessionId,phase,executions,received,isError:result?.isError,receiptState:row.state})+'\n')
} catch(e){failure=e;process.exitCode=1;process.stderr.write(String(e)+'\n'+JSON.stringify({executions,receipts:(db as any).db.prepare('SELECT job_id,state,native_tool_use_id FROM delegate_delivery_receipt').all(),requests,http,sdkErrors:sdk.filter((m:any)=>m.type==='user'||m.type==='result').map((m:any)=>({type:m.type,message:m.message,errors:m.errors}))})+'\n')}
finally {
 clearTimeout(timer);releaseChild();turn?.end();await runner.shutdown();server.closeAllConnections();upstream.closeAllConnections()
 await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))])
 writeFileSync(join(dir,'evidence.json'),JSON.stringify({mode:requestedMode,requests,http,sdk,nativeSession:runner.sessionId,phase,executions,received,failure:failure?String(failure):null,boundary:'actual SubprocessRunner+CCB CLI/SDK/HTTP/SQLite; SessionManager lookup and child executor fixture'},null,2))
 jobs.close()
}

process.exitCode=failure?1:0
