/** Actual production print loop: Stop cannot wait on an ACK it prevents reading. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chownSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { captureBoxScopeOwner, type BoxAgentScopeRegistry } from '../../packages/gateway/src/engine/boxAgentScopeRegistry.js'
import { parseBoxAgentScopeControl } from '../../packages/protocol/src/boxAgentScope.js'
import type { ProxyBody } from '../../packages/commercial/src/http/proxy/shared.js'

type Answer=(res:ServerResponse,id:string,block:{type:'text';text:string}|{type:'tool_use';id:string;name:string;input:unknown})=>void
export async function proveBoxAgentSdkStop(input:{runtime:string;model:string;environment:Record<string,string>;
  registry:BoxAgentScopeRegistry;admitSynthetic:(body:ProxyBody)=>Promise<void>;answer:Answer;
  registerCleanup?: (clean:()=>Promise<void>)=>void}):Promise<void> {
  const home=mkdtempSync('/tmp/ocv5-664-sdk-stop-')
  const dropRoot=process.getuid?.()===0
  if(dropRoot) chownSync(home,1000,1000)
  let child:ChildProcess|undefined
  let closed:Promise<void>=Promise.resolve()
  let cleaning=false
  let failure:Error|undefined
  let rejectFailure!:(error:Error)=>void
  const failed=new Promise<never>((_resolve,reject)=>{rejectFailure=reject})
  // The first wait is installed before the CLI can generate an error.
  void failed.catch(()=>{})
  const fail=(error:unknown)=>{if(cleaning)return;failure ??=error instanceof Error?error:new Error(String(error));rejectFailure(failure)}
  const within=async<T>(stage:Promise<T>):Promise<T>=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    try {return await Promise.race([stage,failed,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('BOX_AGENT_SDK_STOP_CONTROL_DEADLINE')),15_000)
    })])} finally {if(timer) clearTimeout(timer)}
  }
  let rootSession:string|undefined
  let agentId:string|undefined
  let modelReady=false
  const started=new Set<string>()
  let ready!:()=>void
  let modelClosed!:()=>void
  const abortedModel=new Promise<void>(resolve=>{modelClosed=resolve})
  const taskReady=new Promise<void>(resolve=>{ready=resolve})
  const maybeReady=()=>{if(modelReady && agentId && started.has(agentId)) ready()}
  const identities=new Map<string,{agentId:string;background:boolean}>()
  const incarnation=randomUUID()
  let rootCalls=0
  const server=createServer(async(req,res)=>{
    try {
      assert.equal(req.url,'/v1/messages')
      const chunks:Buffer[]=[]
      for await(const chunk of req)chunks.push(Buffer.from(chunk))
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProxyBody
      assert.equal(body.model,input.model)
      const meta=JSON.parse(String(body.metadata?.user_id))
      if(meta.oc_box_agent_scope!==undefined) {
        const scope=identities.get(String(meta.oc_box_agent_scope))
        assert.ok(scope,'SDK Stop target registered before its real API')
        assert.equal(scope.background,false)
        agentId=scope.agentId
        await input.admitSynthetic(body)
        // The synthetic model has not launched a paid process. Keep the real
        // HTTP request open so only the actual TaskStop abort can end it.
        res.once('close',()=>{if(!cleaning && !res.writableFinished)modelClosed()})
        modelReady=true;maybeReady()
        return
      }
      rootSession ??=String(meta.session_id)
      assert.equal(meta.session_id,rootSession)
      if(++rootCalls===1)input.answer(res,'msg_sdk_stop_agent',{type:'tool_use',id:'toolu_sdk_stop',name:'Agent',
        input:{description:'Stop receipt proof',subagent_type:'general-purpose',prompt:'Wait for the synthetic model response.'}})
      else input.answer(res,'msg_sdk_stop_parent',{type:'text',text:'Synthetic task stopped.'})
    } catch(error) {fail(error);res.destroy()}
  })
  let controls:Promise<void>=Promise.resolve()
  let heldAck:(()=>void)|undefined
  let cancelArrived!:()=>void
  const cancelled=new Promise<void>(resolve=>{cancelArrived=resolve})
  let barrierArrived!:()=>void
  const barrier=new Promise<void>(resolve=>{barrierArrived=resolve})
  let stopArrived!:()=>void
  const stopped=new Promise<void>(resolve=>{stopArrived=resolve})
  const stopId=`stop-${randomUUID()}`
  const barrierId=`barrier-${randomUUID()}`
  let barrierObserved=false
  let stopObserved=false
  let cleaningPromise:Promise<void>|undefined
  const clean=():Promise<void>=>cleaningPromise ??= (async()=>{
    cleaning=true
    if(child?.pid && child.exitCode===null && child.signalCode===null) {
      try {process.kill(-child.pid,'SIGKILL')}catch{/* Already exited. */}
    }
    server.closeAllConnections()
    try {await closed}
    finally {
      try {await new Promise<void>(resolve=>server.close(()=>resolve()))}
      finally {
        try {rmSync(home,{recursive:true,force:true})}
        finally {await controls.catch(()=>{})}
      }
    }
  })()
  input.registerCleanup?.(clean)
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();assert.ok(address && typeof address==='object')
    child=spawn(process.execPath,[join(input.runtime,'cli.js'),'-p','--input-format','stream-json',
      '--output-format','stream-json','--verbose','--model',input.model,'--tools','Agent,Bash',
      '--permission-mode','bypassPermissions','--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions','--setting-sources','','--strict-mcp-config',
      '--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--system-prompt','Synthetic Stop control proof.'],{
      cwd:home,detached:true,stdio:['pipe','pipe','pipe'],...(dropRoot?{uid:1000,gid:1000}:{}),env:{
        HOME:home,TMPDIR:home,CLAUDE_CONFIG_DIR:home,XDG_CACHE_HOME:home,PATH:'/usr/bin:/bin:/usr/local/bin',
        ANTHROPIC_BASE_URL:`http://127.0.0.1:${address.port}`,ANTHROPIC_AUTH_TOKEN:'synthetic-not-a-real-key',
        CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
        NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',...input.environment}})
    closed=new Promise<void>(resolve=>{child!.once('close',()=>resolve())})
    const write=(frame:unknown)=>{if(!cleaning)child!.stdin!.write(`${JSON.stringify(frame)}\n`)}
    child.on('error',fail);child.stdin!.on('error',fail)
    child.stderr!.resume()
    child.once('exit',(code)=>{if(!stopObserved)fail(new Error(`BOX_AGENT_SDK_STOP_EARLY_EXIT_${code}`))})
    let buffer=''
    child.stdout!.on('data',chunk=>{
      buffer+=String(chunk)
      let newline:number
      while((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1)
        if(!line.trim())continue
        try {
          const frame=JSON.parse(line)
          if(frame.type==='system' && frame.subtype==='task_started' && frame.task_type==='local_agent') {
            started.add(frame.task_id);maybeReady()
          } else if(frame.type==='control_request' && frame.request?.subtype==='box_agent_scope') {
            controls=controls.then(async()=>{
              const request=parseBoxAgentScopeControl(frame.request);assert.ok(request && child?.pid && rootSession)
              identities.set(request.scopeId,{agentId:request.agentId,background:request.background})
              const owner=captureBoxScopeOwner(child.pid,1,incarnation,rootSession)
              const response=await input.registry.handle(request,owner)
              const ack=()=>write({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}})
              if(request.operation==='explicit-stop') {assert.equal(request.agentId,agentId);heldAck=ack;cancelArrived()}
              else ack()
            }).catch(fail)
          } else if(frame.type==='control_response' && frame.response?.request_id===barrierId) {
            assert.equal(frame.response.subtype,'success');assert.equal(stopObserved,false)
            barrierObserved=true;barrierArrived()
          } else if(frame.type==='control_response' && frame.response?.request_id===stopId) {
            assert.equal(barrierObserved,true,'Stop ACK cannot precede its durable control confirmation')
            assert.equal(frame.response.subtype,'success')
            assert.ok(['pending','stopped'].includes(frame.response.response?.remote_stop))
            stopObserved=true;stopArrived()
          }
        }catch(error){fail(error)}
      }
    })
    write({type:'user',message:{role:'user',content:'Use Agent once; the host will stop its running task.'}})
    await within(taskReady)
    write({type:'control_request',request_id:stopId,request:{subtype:'stop_task',task_id:agentId}})
    await within(cancelled)
    assert.equal(stopObserved,false)
    write({type:'control_request',request_id:barrierId,request:{subtype:'mcp_status'}})
    await within(barrier)
    assert.ok(heldAck);heldAck()
    await within(stopped)
    await within(abortedModel)
    await controls
    if(failure)throw failure
  } finally {await clean()}
}
