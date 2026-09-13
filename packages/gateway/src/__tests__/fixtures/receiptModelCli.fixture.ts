/** Actual CCB CLI probe; no SDK/process/query stubs. Only parent lookup and child executor are fixtures. */
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
const requestedMode=process.argv[3] || 'create', mcp=requestedMode.startsWith('mcp-')
const mode=requestedMode.replace(/^mcp-/, '');assert.ok(['create','wait','stop'].includes(mode))
let releaseChild:()=>void=()=>{};const childGate=new Promise<void>(r=>{releaseChild=r})
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'')
const dir=process.argv[2]; assert.ok(dir)
mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'native'),{recursive:true})
const token=randomBytes(32).toString('hex'), session='agent:main:webchat:dm:real-model-cli', turnKey='real-model-cli-turn'
const requests:any[]=[], sdk:any[]=[], http:any[]=[]
let phase=0, executions=0, received=false, failure:any
let adapter:CcbAdapter, runner:SubprocessRunner, turn:any
const sentinel='REAL_MODEL_CLI_AUTHORITATIVE_RESULT'
const cli=`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-child-only`
const command=(mode==='wait'?'timeout --signal=TERM 8s ':'')+cli
function send(res:any,body:any,tool:boolean,wait=false) {
 const id='synthetic_'+randomBytes(6).toString('hex');
 const content=tool?{type:'tool_use',id:wait?'real_waiter':'real_creator',name:mcp?`mcp__openclaude-memory__${wait?'delegate_wait':'delegate_task'}`:'Bash',input:mcp?(wait?{jobId:(db as any).db.prepare('SELECT job_id FROM delegate_jobs').get().job_id,waitMs:10000}:{agentId:'coding-assistant',goal:'synthetic-child-only'}):{command:wait?`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate-wait ${(db as any).db.prepare('SELECT job_id FROM delegate_jobs').get().job_id}`:command,timeout:20000}}:{type:'text',text:'SYNTHETIC_MODEL_DONE'}
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
  const main=body.tools?.some((t:any)=>t.name===(mcp?'mcp__openclaude-memory__delegate_task':'Bash'))
  if(main&&phase===0){phase++;send(res,body,true)}
  else if(main&&phase===1&&mode==='wait'){assert.equal(executions,1);assert.ok(!raw.includes(sentinel));releaseChild();phase++;send(res,body,true,true)}
  else {if(main){received=raw.includes(sentinel);phase++;writeFileSync(join(dir,'model-final-messages.json'),JSON.stringify(body.messages,null,2))}send(res,body,false)}
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
 executions++;const claim=jobs.claimQueued(input.backgroundJobId);assert.ok(claim.ok)
 input.claimToken=claim.claimToken;input.fencingEpoch=claim.fencingEpoch
 if(mode==='wait')await childGate
 ;(gw as any)._releasePreadmittedDelegateCapacity(input)
 return {kind:'completed',ok:true,output:sentinel,sessionKey:input.sessionKey}
}
const server=createServer((req,res)=>{res.on('finish',()=>http.push({path:req.url,status:res.statusCode}));if(mode==='stop'&&req.url==='/api/delegate/receipt-owner/input')adapter.interrupt();void(gw as any).handleHttp(req,res)})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;config.gateway.port=port
writeFileSync(join(dir,'token'),token,{mode:0o600})
process.env.OPENCLAUDE_GATEWAY_PORT=String(port);process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE=join(dir,'token')
process.env.OPENCLAUDE_HOME=dir;process.env.OPENCLAUDE_DELEGATE_JOBS_DB=dbPath
if(mcp)process.env.OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS='5000'
process.env.CLAUDE_CONFIG_DIR=join(dir,'native');process.env.OPENCLAUDE_RECEIPT_CALLER_V2='1'
const providerEnvOverride={...(mcp?{ENABLE_SEARCH_EXTRA_TOOLS:'false'}:{}),ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstreamPort}`,ANTHROPIC_API_KEY:'synthetic-local-only',ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_UNATTENDED_RETRY:'0',CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'1',NPM_CONFIG_OFFLINE:'true'}
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
 const result=await Promise.race([turn.summary,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('model turn deadline')),90000)})]);clearTimeout(timer)
 assert.ok(!failure,String(failure));assert.equal(executions,1);assert.equal(received,mode!=='stop')
 assert.ok(runner.sessionId);assert.equal(phase,mode==='wait'?3:mode==='stop'?1:2)
 const row=(db as any).db.prepare('SELECT * FROM delegate_delivery_receipt').get();assert.equal(row.state,mode==='stop'?'offered':'ingested');assert.equal(row.native_tool_use_id,'real_creator')
 if(mode!=='stop') {
  const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
  const modelResults=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id===(mode==='wait'?'real_waiter':'real_creator')):[])
  const nativeResults=sdk.flatMap((m:any)=>m.type==='user'&&Array.isArray(m.message?.content)?m.message.content.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id===(mode==='wait'?'real_waiter':'real_creator')):[])
  assert.equal(modelResults.length,1);assert.equal(nativeResults.length,1);assert.deepEqual(modelResults[0].content,nativeResults[0].content)
 }
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
