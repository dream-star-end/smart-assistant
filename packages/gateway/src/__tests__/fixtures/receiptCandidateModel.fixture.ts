/** Actual CCB CLI probe; no SDK/process/query stubs. Only parent lookup and child executor are fixtures. */
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,openSync,closeSync,writeSync,constants } from 'node:fs'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { SubprocessRunner } from '../../subprocessRunner.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
const mode=process.argv[3] || 'late'; assert.ok(['late','ordinary','deleted'].includes(mode))
const root=fileURLToPath(new URL('../../../../../',import.meta.url))
const dir=process.argv[2]; assert.ok(dir)
mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'native'),{recursive:true})
const token=randomBytes(32).toString('hex'), session='agent:main:webchat:dm:real-model-cli', turnKey='real-model-cli-turn'
const requests:any[]=[], sdk:any[]=[], http:any[]=[]
let phase=0, executions=0, received=false, discovered=false, failure:any; 
let savedOwner:any;let adapter:CcbAdapter, runner:SubprocessRunner, turn:any
const sentinel='REAL_MODEL_CLI_AUTHORITATIVE_RESULT'
const cli=`node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-child-only`
assert.equal(spawnSync('mkfifo',[join(dir,'writer-release')]).status,0);
const lateCli=cli.replace('node --import',`OC_TEST_LATE_CACHE_GATE=${dir} node --import ${fileURLToPath(new URL('./receiptCandidateGate.fixture.mjs',import.meta.url))} --import`)
const command=mode==='ordinary'?'printf ordinary-no-job-proof':`(${lateCli} > ${dir}/late-stdout 2> ${dir}/late-stderr; echo $? > ${dir}/writer-exit) </dev/null >/dev/null 2>&1 & printf parent-shell-completed`
function send(res:any,body:any,tool:boolean) {
 const id='synthetic_'+randomBytes(6).toString('hex');
 const content:any=tool?{type:'tool_use',id:'real_creator',name:'Bash',input:{command,timeout:20000}}:{type:'text',text:'SYNTHETIC_MODEL_DONE'}
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
  if(main&&phase===0){phase++;send(res,body,true)}
  else {
    if(main){
      if(mode!=='ordinary') {
        const until=Date.now()+30000;
        while(!existsSync(join(dir,'writer-ready'))){assert.ok(Date.now()<until,'late writer gate deadline');await new Promise(r=>setTimeout(r,20))}
      }
      savedOwner=adapter.getReceiptToolOwner('real_creator');assert.ok(savedOwner);assert.equal(adapter.checkReceiptOwner(savedOwner),'active');
      received=raw.includes(sentinel);phase++;writeFileSync(join(dir,'model-final-messages.json'),JSON.stringify(body.messages,null,2))
    }
    send(res,body,false)
  }
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
 ;(gw as any)._releasePreadmittedDelegateCapacity(input)
 return {kind:'completed',ok:true,output:sentinel,sessionKey:input.sessionKey}
}
const server=createServer((req,res)=>{res.on('finish',()=>http.push({path:req.url,status:res.statusCode}));void(gw as any).handleHttp(req,res)})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;config.gateway.port=port
writeFileSync(join(dir,'token'),token,{mode:0o600})
process.env.OPENCLAUDE_GATEWAY_PORT=String(port);process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE=join(dir,'token')
process.env.OPENCLAUDE_HOME=dir;process.env.OPENCLAUDE_DELEGATE_JOBS_DB=dbPath
process.env.CLAUDE_CONFIG_DIR=join(dir,'native');process.env.OPENCLAUDE_RECEIPT_CALLER_V2='1'
const providerEnvOverride={ANTHROPIC_BASE_URL:`http://127.0.0.1:${upstreamPort}`,ANTHROPIC_API_KEY:'synthetic-local-only',ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_UNATTENDED_RETRY:'0',CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'1',NPM_CONFIG_OFFLINE:'true'}
runner=new SubprocessRunner({sessionKey:session,agentId:'main',agentBaseDir:dir,config,harness:'ccb',model:config.defaults.model,permissionMode:'bypassPermissions',providerEnvOverride})
adapter=new CcbAdapter({harness:'ccb'} as any,runner)
const parent={userId:'default',sessionKey:session,agentId:'main',_currentTurnKey:turnKey,runner:adapter,
 ...(mode==='deleted'?{channel:'webchat',peerId:'real-model-cli'}:{})}
if(mode==='deleted'){
 const {upsertClientSession}=await import('../../../../storage/src/sessionsDb.js')
 await upsertClientSession({id:'real-model-cli',userId:'default',agentId:'main',title:'private deleted CLI',pinned:false,createdAt:1000,lastAt:1000,updatedAt:1000,messages:[]})
}
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
 assert.ok(!failure,String(failure));assert.equal(received,false)
 assert.ok(savedOwner);turn.end();assert.equal(adapter.checkReceiptOwner(savedOwner),'inactive')
 assert.ok(sdk.some((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes(mode!=='ordinary'?'parent-shell-completed':'ordinary-no-job-proof')))
 const candidateRoot=join(dir,'receipt-candidates-v1')
 assert.equal(readdirSync(join(candidateRoot,'data')).length,1)
 let writer:any
 if(mode!=='ordinary') {
   writer=JSON.parse(readFileSync(join(dir,'writer-ready'),'utf8'));process.kill(writer.pid,0)
   assert.equal(writer.cache,candidateRoot);assert.ok(writer.report.startsWith(candidateRoot+'/'))
 }
 if(mode==='deleted'){
  const response=await fetch(`http://127.0.0.1:${port}/api/sessions/real-model-cli`,{method:'DELETE',headers:{authorization:`Bearer ${token}`}})
  const body=await response.json() as any;assert.equal(response.status,200);assert.equal(body.receiptCandidateCleanup.state,'complete')
 } else await (gw as any)._sweepReceiptCandidates() // actual turn-end helper; SessionManager lookup is fixture
 assert.equal(readdirSync(join(candidateRoot,'data')).length,0)
 if(writer) {
   const fd=openSync(join(dir,'writer-release'),constants.O_WRONLY);writeSync(fd,'release');closeSync(fd)
   const deadline=Date.now()+15000
   while(!existsSync(join(dir,'writer-exit'))){assert.ok(Date.now()<deadline,'late CLI exit deadline');await new Promise(r=>setTimeout(r,20))}
 }
 const recreated=readdirSync(join(candidateRoot,'data')).length!==0
 const states=readdirSync(join(candidateRoot,'namespaces')).map(f=>JSON.parse(readFileSync(join(candidateRoot,'namespaces',f),'utf8')).state)
 const rows=(db as any).db.prepare('SELECT state,native_tool_use_id FROM delegate_delivery_receipt').all()
 const proof={mode,parentModelEnded:true,writerAliveAfterEnd:!!writer,recreated,states,ordinaryPreserved:true,
   executions,receipts:rows,http,cliExit:writer?readFileSync(join(dir,'writer-exit'),'utf8').trim():null}
 writeFileSync(join(dir,'lifecycle-proof.json'),JSON.stringify(proof,null,2))
 assert.equal(recreated,false,'retired namespace must not be recreated by the actual late CLI')
 assert.deepEqual(states,['retired']);assert.equal(executions,mode!=='ordinary'?1:0)
 assert.equal(rows.length,mode!=='ordinary'?1:0)
 if(mode!=='ordinary'){assert.equal(rows[0].state,'offered');assert.equal(rows[0].native_tool_use_id,'real_creator')}
 process.stdout.write('CANDIDATE_LIFECYCLE_PASS\n')

} catch(e){failure=e;process.exitCode=1;process.stderr.write(String(e)+'\n'+JSON.stringify({requests,http,sdkErrors:sdk.filter((m:any)=>m.type==='user'||m.type==='result').map((m:any)=>({type:m.type,message:m.message,errors:m.errors}))})+'\n')}
finally {
 clearTimeout(timer);if(existsSync(join(dir,'writer-ready'))&&!existsSync(join(dir,'writer-exit'))){const w=JSON.parse(readFileSync(join(dir,'writer-ready'),'utf8'));try{process.kill(w.pid,'SIGKILL')}catch{}}turn?.end();await runner.shutdown();server.closeAllConnections();upstream.closeAllConnections()
 await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))])
 writeFileSync(join(dir,'evidence.json'),JSON.stringify({mode,requests,http,sdk,nativeSession:runner.sessionId,phase,executions,received,failure:failure?String(failure):null,boundary:'actual SubprocessRunner+CCB CLI/SDK/HTTP/SQLite; SessionManager lookup and child executor fixture'},null,2))
 clearTimeout((gw as any)._receiptCandidateTimer);jobs.close()
}

process.exitCode=failure?1:0
