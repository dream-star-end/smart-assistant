import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { chownSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolConfig } from 'pg'
import { verifiedBoxAgentEntry } from './boxAgentArtifact.js'
import { BoxDurableJournal } from '../../packages/commercial/src/http/proxy/boxDurableJournal.js'
import { resolveBoxCapacityPolicy } from '../../packages/commercial/src/http/proxy/boxCapacityPolicy.js'
import { deriveBoxCallFingerprint } from '../../packages/commercial/src/http/proxy/boxCallFingerprint.js'
import { BoxAgentScopes } from '../../packages/commercial/src/http/proxy/boxAgentScopes.js'
import { BoxAgentScopeRegistry, captureBoxScopeOwner } from '../../packages/gateway/src/engine/boxAgentScopeRegistry.js'
import type { BoxAgentScopeIdentity } from '../../packages/protocol/src/boxAgentScope.js'
import type { ProxyBody } from '../../packages/commercial/src/http/proxy/shared.js'
import { proveBoxAgentSdkStop } from './boxAgentSdkStopProof.js'

const MODEL='box-claude-haiku-5-5'
const TURN='a'.repeat(64)
const PRICING={v:1,modelId:MODEL,displayName:'Opus',inputPerMtok:'1',outputPerMtok:'1',
  cacheReadPerMtok:'1',cacheWritePerMtok:'1',multiplier:'1'}
function answer(res:ServerResponse,id:string,block:{type:'text';text:string}|{type:'tool_use';id:string;name:string;input:unknown}) {
  const usage={input_tokens:20,output_tokens:8,cache_creation_input_tokens:0,cache_read_input_tokens:0}
  res.writeHead(200,{'content-type':'text/event-stream','x-request-id':id})
  const event=(type:string,data:unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  event('message_start',{type:'message_start',message:{id,type:'message',role:'assistant',model:MODEL,content:[],stop_reason:null,usage}})
  event('content_block_start',{type:'content_block_start',index:0,content_block:block.type === 'text'
    ? {type:'text',text:''} : {...block,input:{}}})
  event('content_block_delta',{type:'content_block_delta',index:0,delta:block.type === 'text'
    ? {type:'text_delta',text:block.text} : {type:'input_json_delta',partial_json:JSON.stringify(block.input)}})
  event('content_block_stop',{type:'content_block_stop',index:0})
  event('message_delta',{type:'message_delta',delta:{stop_reason:block.type === 'text' ? 'end_turn' : 'tool_use'},usage})
  event('message_stop',{type:'message_stop'});res.end()
}
function killOwn(child:ChildProcess) {
  if(!child.pid || child.exitCode!==null || child.signalCode!==null) return
  try {process.kill(-child.pid,'SIGKILL')} catch {try {child.kill('SIGKILL')} catch { /* gone */ }}
}

/** Actual production CCB Agent/Bash serialization → real PG admission. The
 * account/model endpoint is synthetic; no Box, credential, credit or billing
 * mutation occurs. The parent handoff is an explicit private fixture hold. */
export async function proveBoxAgentSession(candidate:string,config:PoolConfig,
  registerCleanup?: (cleanup:() => Promise<void>) => void):Promise<string> {
  const entry=verifiedBoxAgentEntry(candidate)
  // The master gate's TMPDIR has a root-only 0700 ancestor. This owned
  // scratch must remain traversable after the actual CLI drops to uid 1000.
  const scratch=mkdtempSync('/tmp/ocv5-664-agent-proof-')
  const schema=`agent_proof_${randomBytes(6).toString('hex')}`
  const admin=new Pool({...config,max:1})
  let pool:Pool|undefined
  let child:ChildProcess|undefined
  let schemaCreated=false
  const runtime=join(scratch,'runtime')
  let controlChain:Promise<void>=Promise.resolve()
  let cleaning=false
  let failure:Error|undefined
  let resolveResult!:() => void
  let rejectResult:((error:Error) => void)|undefined
  const fail=(error:unknown) => {
    if(cleaning) return
    failure ??=error instanceof Error ? error : new Error(String(error))
    rejectResult?.(failure)
  }
  let rootSession:string|undefined
  let childSession:string|undefined
  let hash:string|undefined
  let rootCalls=0
  let childCalls=0
  let hookCalls=0
  let requestNo=0
  const registryFile=join(scratch,'scope-control.json')
  const incarnation=randomUUID()
  let registry:BoxAgentScopeRegistry|undefined
  let journal:BoxDurableJournal
  let scopes:BoxAgentScopes
  const scopesById=new Map<string,BoxAgentScopeIdentity>()
  const bodies:ProxyBody[]=[]
  const environmentA={CLAUDE_CODE_EXTRA_METADATA:JSON.stringify({oc_turn_key:TURN,oc_mode:'chat'}),
    ANTHROPIC_CUSTOM_HEADERS:'x-oc-model-authority: SYNTHETIC_AUTH_A\nx-oc-turn-lease: SYNTHETIC_LEASE_A\nx-openclaude-trace-id: SYNTHETIC_TRACE_A'}
  const environmentB={CLAUDE_CODE_EXTRA_METADATA:JSON.stringify({oc_turn_key:'b'.repeat(64),oc_mode:'chat'}),
    ANTHROPIC_CUSTOM_HEADERS:'x-oc-model-authority: SYNTHETIC_AUTH_B\nx-oc-turn-lease: SYNTHETIC_LEASE_B\nx-openclaude-trace-id: SYNTHETIC_TRACE_B'}
  const environmentAcks=new Map<string,()=>void>()
  const updateEnvironment=async(variables:Record<string,string>)=>{
    if(cleaning) throw new Error('BOX_AGENT_PROOF_CLEANING')
    const requestId=`synthetic-environment-${randomUUID()}`
    const applied=new Promise<void>(resolve=>{environmentAcks.set(requestId,resolve)})
    child!.stdin!.write(`${JSON.stringify({type:'update_environment_variables',variables})}\n`)
    // The stdin loop processes this read-only control after the update. Its
    // ACK makes global B an observed boundary before the real Bash executes.
    child!.stdin!.write(`${JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'mcp_status'}})}\n`)
    await applied
    if(cleaning) throw new Error('BOX_AGENT_PROOF_CLEANING')
  }
  const admission=async (body:ProxyBody,uid=1n,accountId=uid) => {
    const fingerprint=deriveBoxCallFingerprint(uid,body)
    const requestId=`agent-proof-${++requestNo}`
    await pool!.query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
      VALUES($1,$2,$2,'inflight',$3::jsonb)`,[requestId,uid.toString(),JSON.stringify({model:MODEL,
        boxInvocationRecovery:'v1',...(fingerprint.agentScopeId ? {boxAgentScopeId:fingerprint.agentScopeId} : {}),
        billingPricing:PRICING,boxBillingContext:{v:1,sessionId:fingerprint.sessionId,mode:'chat',
          parentSessionId:null,delegateAgentId:null,turnKey:fingerprint.turnKey,parentTurnKey:null,
          authority:null,dispatchId:null,attemptNo:null,verificationSponsorship:null,apiKeyId:null}})])
    return {requestId,uid,accountId,model:MODEL,fingerprint,canonicalBody:body,
      runNonce:randomBytes(12).toString('hex'),leaseEpoch:randomBytes(16).toString('hex')}
  }
  const meta=(body:ProxyBody) => JSON.parse(String(body.metadata?.user_id)) as Record<string,unknown>
  const server=createServer(async (req,res) => {
    try {
      const endpoint=new URL(req.url!,'http://127.0.0.1')
      assert.equal(endpoint.pathname,'/v1/messages')
      assert.ok(endpoint.search==='' || endpoint.search==='?beta=true')
      const chunks:Buffer[]=[]
      for await(const chunk of req) chunks.push(Buffer.from(chunk))
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProxyBody
      assert.equal(body.model,MODEL,'actual proof must use the selected Box model')
      assert.equal(req.headers['x-oc-model-authority'],'SYNTHETIC_AUTH_A')
      assert.equal(req.headers['x-oc-turn-lease'],'SYNTHETIC_LEASE_A')
      assert.equal(req.headers['x-openclaude-trace-id'],'SYNTHETIC_TRACE_A')
      const metadata=meta(body)
      assert.equal(metadata.oc_turn_key,TURN)
      assert.ok(Buffer.byteLength(String(body.metadata?.user_id))<=512)
      bodies.push(structuredClone(body))
      if(rootSession === undefined) {
        rootSession=String(metadata.session_id);rootCalls++
        assert.equal(metadata.oc_box_agent_scope,undefined,'root API identity must remain global')
        const input=await admission(body);await journal.admit(input)
        // A synthetic parent model has just handed Agent to CCB. Keep exactly
        // that parent session occupied while the actual child API arrives.
        await pool!.query(`UPDATE request_finalize_journal SET ctx=ctx || '{"boxState":"handoff"}'::jsonb WHERE request_id=$1`,[input.requestId])
        answer(res,'msg_agent_parent',{type:'tool_use',id:'toolu_agent',name:'Agent',input:{
          description:'Proof local hash',subagent_type:'general-purpose',
          prompt:'Run the Bash tool to create fresh random bytes in agent-proof.bin and return its SHA256.'}})
      } else if(metadata.oc_box_agent_scope !== undefined) {
        const scopeId=String(metadata.oc_box_agent_scope)
        const registered=scopesById.get(scopeId)
        assert.ok(registered,'BOX_AGENT_DURABLE_REGISTER_BEFORE_API')
        if(registered.agentId.startsWith('hook-agent-')) {
          assert.equal(++hookCalls,1,'the actual SubagentStop verification hook must run once')
          assert.notEqual(metadata.session_id,rootSession)
          assert.notEqual(metadata.session_id,childSession,'hook API identity must be independently bound')
          const hook=await admission(body);await journal.admit(hook)
          await journal.markPrestartStopped(hook)
          answer(res,'msg_agent_hook',{type:'tool_use',id:'toolu_hook_result',name:'StructuredOutput',input:{ok:true}})
          return
        }
        childCalls++
        childSession ??=String(metadata.session_id)
        assert.notEqual(childSession,rootSession,'BOX_AGENT_CHILD_API_ID_ISOLATED')
        assert.equal(metadata.session_id,registered.sessionId)
        assert.equal(metadata.session_id,childSession,'Box Agent retry/tool round must retain one API UUID')
        const input=await admission(body);await journal.admit(input)
        if(childCalls === 1) {
          assert.equal((await pool!.query(`SELECT count(*)::int AS n FROM request_finalize_journal
            WHERE user_id=1 AND ctx->>'boxState' IN ('reserved','handoff')`)).rows[0].n,2,
          'BOX_AGENT_PARENT_AND_CHILD_ADMITTED_AT_UNCHANGED_CAPACITY')
          const same=structuredClone(body);same.messages.push({role:'user',content:'same child concurrent negative'})
          await assert.rejects(() => admission(same).then(next => journal.admit(next)),/BOX_CAPACITY_HELD/)
          await journal.markPrestartStopped(input)
          await updateEnvironment(environmentB)
          answer(res,'msg_agent_child_bash',{type:'tool_use',id:'toolu_agent_bash',name:'Bash',input:{
            command:"python3 -I -c 'import os,hashlib; raw=os.urandom(32); open(\"agent-proof.bin\",\"wb\").write(raw); print(hashlib.sha256(raw).hexdigest())'",
            description:'Create random proof bytes and calculate SHA256'}})
        } else {
          assert.equal(childCalls,2,'unexpected child replay/model loop')
          hash=createHash('sha256').update(readFileSync(join(scratch,'agent-proof.bin'))).digest('hex')
          assert.ok(JSON.stringify(body.messages).includes(hash),'BOX_AGENT_REAL_BASH_HASH_MISSING')
          await journal.markPrestartStopped(input)
          await updateEnvironment(environmentA)
          answer(res,'msg_agent_child_done',{type:'text',text:`CHILD_PROVED ${hash}`})
        }
        // This loopback endpoint has no remote Box/paid launch. Preserve the
        // product's original prestart-only CAS rather than fabricate a keeper.
      } else {
        rootCalls++
        assert.equal(rootCalls,2,'unexpected parent replay/model loop')
        assert.equal(metadata.session_id,rootSession)
        assert.ok(hash && JSON.stringify(body.messages).includes(`CHILD_PROVED ${hash}`),'BOX_AGENT_PARENT_RESULT_MISSING')
        answer(res,'msg_agent_parent_done',{type:'text',text:`PARENT_PROVED ${hash}`})
      }
    } catch(error) {
      fail(error)
      if(!res.headersSent && !res.destroyed) {res.statusCode=500;res.end(JSON.stringify({error:{type:'api_error',message:'synthetic proof failed'}}))}
      else res.destroy()
    }
  })
  let cleanupPromise:Promise<void>|undefined
  const clean=():Promise<void> => cleanupPromise ??= (async () => {
    cleaning=true
    for(const acknowledge of environmentAcks.values()) acknowledge()
    environmentAcks.clear()
    if(child) {try {child.stdin?.end()} catch { /* closed */ };killOwn(child)}
    try {
      await controlChain.catch(() => {})
      await registry?.pump().catch(() => {})
    } finally {
      server.closeAllConnections?.()
      try {await new Promise<void>(resolve => server.close(() => resolve()))}
      finally {
        try {await pool?.end()}
        finally {
          try {if(schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`)}
          finally {try {await admin.end()} finally {rmSync(scratch,{recursive:true,force:true})}}
        }
      }
    }
  })()
  registerCleanup?.(clean)
  try {
    assert.match((await admin.query('SELECT current_database() AS db')).rows[0].db,/_test$/)
    await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true
    pool=new Pool({...config,max:8,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000,
      options:`${config.options ?? ''} -c search_path=${schema}`.trim()})
    await pool.query(`CREATE TABLE users(id BIGINT PRIMARY KEY);
      CREATE TABLE agent_containers(id BIGINT PRIMARY KEY,user_id BIGINT);
      INSERT INTO users VALUES(1),(2),(3);INSERT INTO agent_containers VALUES(1,1),(2,2),(3,3);
      CREATE TABLE request_finalize_journal(request_id TEXT PRIMARY KEY,user_id BIGINT NOT NULL,
        container_id BIGINT,state TEXT NOT NULL,ctx JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),error_msg TEXT,failure_code TEXT,final_credits BIGINT)`)
    await pool.query(readFileSync(join(candidate,'packages/commercial/src/db/migrations/0331_box_agent_api_scopes.sql'),'utf8'))
    journal=new BoxDurableJournal(pool,() => ({maxRunsPerAccount:3,maxRunsPerUser:3}))
    scopes=new BoxAgentScopes({pool,journal,coordinator:{requestStop:async () => 'pending'},recoverPrelaunch:async () => false})
    registry=new BoxAgentScopeRegistry({file:registryFile,containerId:'1',remote:async (identity,operation,reason) => {
      const receipt=await scopes.control({uid:1n,containerId:1n},identity,operation,reason)
      if(operation === 'register' && receipt.status === 'active') scopesById.set(identity.scopeId,identity)
      return receipt
    }})
    cpSync(join(candidate,'claude-code-best/dist'),runtime,{recursive:true})
    const dropRoot=process.getuid?.() === 0
    if(dropRoot) {
      const own=(path:string) => {chownSync(path,1000,1000);for(const item of readdirSync(path,{withFileTypes:true})) {
        const childPath=join(path,item.name);if(item.isDirectory()) own(childPath);else chownSync(childPath,1000,1000)
      }}
      own(scratch)
    }
    assert.equal(readFileSync(join(runtime,'cli.js')).equals(readFileSync(entry)),true)
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
    const address=server.address();assert.ok(address && typeof address === 'object')
    child=spawn(process.execPath,[join(runtime,'cli.js'),'-p','--input-format','stream-json','--output-format','stream-json',
      '--verbose','--model',MODEL,'--tools','Agent,Bash','--permission-mode','bypassPermissions',
      '--allow-dangerously-skip-permissions','--dangerously-skip-permissions','--setting-sources','',
      '--settings',JSON.stringify({hooks:{SubagentStop:[{hooks:[{type:'agent',model:MODEL,
        prompt:'Verify the synthetic child result and return StructuredOutput with ok true.'}]}]}}),
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--system-prompt','Synthetic Agent boundary proof.'],{
      cwd:scratch,detached:true,stdio:['pipe','pipe','pipe'],...(dropRoot ? {uid:1000,gid:1000} : {}),
      env:{HOME:scratch,TMPDIR:scratch,XDG_CACHE_HOME:scratch,CLAUDE_CONFIG_DIR:scratch,
        PATH:'/usr/bin:/bin:/usr/local/bin',ANTHROPIC_BASE_URL:`http://127.0.0.1:${address.port}`,
        ANTHROPIC_AUTH_TOKEN:'synthetic-not-a-real-key',CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
        NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',
        ...environmentA,
        CLAUDE_CODE_EXTRA_BODY:JSON.stringify({metadata:{user_id:JSON.stringify({session_id:'untrusted-extra-body'})}}),
        }})
    let buffer=''
    let stderr=''
    const result=new Promise<void>((resolve,reject) => {resolveResult=resolve;rejectResult=reject})
    const timer=setTimeout(() => fail(new Error('BOX_AGENT_REAL_CCB_DEADLINE')),60_000)
    child.on('error',fail)
    child.stdin!.on('error',error => {if(!cleaning) fail(error)})
    child.stderr!.on('data',chunk => {stderr=(stderr+String(chunk)).slice(-8000)})
    child.once('exit',(code,signal) => {if(code !== 0) fail(new Error(`BOX_AGENT_CCB_EXIT_${code}_${signal}: ${stderr.slice(-1500)}`))})
    child.stdout!.on('data',chunk => {
      buffer+=String(chunk)
      let newline:number
      while((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1)
        if(!line.trim()) continue
        try {
          const frame=JSON.parse(line)
          if(frame.type === 'control_response' && environmentAcks.has(frame.response?.request_id)) {
            const acknowledge=environmentAcks.get(frame.response.request_id)!
            environmentAcks.delete(frame.response.request_id)
            if(frame.response.subtype !== 'success') throw new Error('BOX_AGENT_ENVIRONMENT_BOUNDARY_ACK_FAILED')
            acknowledge()
          } else if(frame.type === 'control_request' && frame.request?.subtype === 'box_agent_scope') {
            controlChain=controlChain.then(async () => {
              assert.ok(rootSession && child?.pid)
              const owner=captureBoxScopeOwner(child.pid,1,incarnation,rootSession)
              const capturedChild=child
              const response=await registry!.handle(frame.request,owner)
              if(cleaning || child !== capturedChild || capturedChild.exitCode !== null
                || capturedChild.signalCode !== null || !capturedChild.stdin?.writable
                || capturedChild.stdin.writableEnded || capturedChild.stdin.destroyed) return
              capturedChild.stdin.write(`${JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}})}\n`)
            }).catch(fail)
          } else if(frame.type === 'result') {
            if(frame.is_error) fail(new Error('BOX_AGENT_PARENT_RESULT_ERROR'))
            else if(hash && JSON.stringify(frame).includes(`PARENT_PROVED ${hash}`)) resolveResult()
          }
        } catch(error) {fail(error)}
      }
    })
    child.stdin!.write(`${JSON.stringify({type:'user',message:{role:'user',content:'Use Agent to obtain a real local Bash hash.'}})}\n`)
    try {await result} finally {clearTimeout(timer)}
    if(failure) throw failure
    assert.equal(rootCalls,2);assert.equal(childCalls,2)
    assert.equal(hookCalls,1,'BOX_AGENT_ACTUAL_STOP_HOOK_REQUIRED')
    assert.ok(childSession && rootSession && childSession !== rootSession)
    await controlChain;await registry.pump()
    if(failure) throw failure
    // The exact old serializer identity is a negative control at otherwise
    // sufficient capacity, using the observed real child request body.
    const old=structuredClone(bodies.find(body => meta(body).oc_box_agent_scope !== undefined)!)
    const oldMeta=meta(old);Reflect.deleteProperty(oldMeta,'oc_box_agent_scope');oldMeta.session_id=rootSession
    old.metadata={user_id:JSON.stringify(oldMeta)}
    await assert.rejects(() => admission(old).then(input => journal.admit(input)),/BOX_CAPACITY_HELD/,
      'BOX_AGENT_LEGACY_SAME_SESSION_MUST_REJECT')
    const first=structuredClone(bodies[0]!)
    const policy=resolveBoxCapacityPolicy({})
    assert.equal(policy.maxRunsPerAccount,1);assert.equal(policy.maxRunsPerUser,1)
    const defaultJournal=new BoxDurableJournal(pool,() => policy)
    const parent=await admission(first,2n);await defaultJournal.admit(parent)
    const actualChild=structuredClone(bodies.find(body => meta(body).oc_box_agent_scope !== undefined)!)
    const childMeta=meta(actualChild);Reflect.deleteProperty(childMeta,'oc_box_agent_scope')
    actualChild.metadata={user_id:JSON.stringify(childMeta)}
    await assert.rejects(() => admission(actualChild,3n,2n).then(input => defaultJournal.admit(input)),/BOX_CAPACITY_HELD/,
      'BOX_AGENT_DEFAULT_ACCOUNT_ONE_CAP_MUST_NOT_EXPAND')
    await assert.rejects(() => admission(actualChild,2n,3n).then(input => defaultJournal.admit(input)),/BOX_CAPACITY_HELD/,
      'BOX_AGENT_DEFAULT_USER_ONE_CAP_MUST_NOT_EXPAND')
    await proveBoxAgentSdkStop({runtime,model:MODEL,environment:environmentA,registry,answer,registerCleanup,
      admitSynthetic:async(body)=>{
        const run=await admission(body);await journal.admit(run)
        await journal.markPrestartStopped(run)
      }})
    if(failure) throw failure
    return '[ocv5-664-box-agent-session] PASS — actual production CCB Agent returns a fresh Bash hash with an isolated stable API session; real PG admits parent plus child, rejects legacy/same-child collision, and preserves default capacity'
  } catch(error) {
    // The outer official gate prints error.message. Preserve positive evidence
    // that an ablation failed the actual AssertionError, rather than a timeout
    // or generic CLI error that happens to mention the same incident label.
    if(error instanceof assert.AssertionError) throw new Error(
      `BOX_AGENT_PROOF_ASSERTION [${error.code}] ${error.message}`,{cause:error})
    throw error
  } finally { await clean() }
}
