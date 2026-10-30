import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveBoxAgentSession } from '@openclaude/protocol'

const home=await mkdtemp(join(tmpdir(),'box-agent-generation-'))
process.env.OPENCLAUDE_HOME=home
process.env.OC_CONTAINER_ID='1'
const {SubprocessRunner}=await import('../subprocessRunner.js')
const {getBoxAgentScopeRegistry}=await import('../engine/boxAgentScopeRegistry.js')
const registry=getBoxAgentScopeRegistry()
clearInterval((registry as unknown as {timer:NodeJS.Timeout}).timer)
await registry.pump()
test.after(async()=>{await registry.pump();await rm(home,{recursive:true,force:true})})
class FakeStream extends EventEmitter {
  destroyed=false;writable=true;writableEnded=false;writes:string[]=[]
  write(chunk:string) {this.writes.push(chunk);return true}
}
class FakeProc {
  pid=process.pid;exitCode=null;signalCode=null;stdin=new FakeStream()
}
function fixture() {
  const root=randomUUID()
  const proc=new FakeProc()
  const runner=new SubprocessRunner({sessionKey:'agent:main:webchat:dm:scopegen',agentId:'main',
    agentBaseDir:home,config:{} as never,harness:'ccb',resumeSessionId:root} as never)
  const internal=runner as unknown as {proc:FakeProc;spawnGeneration:number;
    currentSessionId:string;handleBoxAgentScope:(message:unknown,source:unknown)=>Promise<void>;
    handleStdout:(line:string,timing:undefined,source:unknown)=>void}
  internal.proc=proc;internal.spawnGeneration=1
  const request={type:'control_request',request_id:randomUUID(),request:{subtype:'box_agent_scope',version:1,
    operation:'register',scopeId:randomUUID(),rootSessionId:root,sessionId:deriveBoxAgentSession(root,'agent'),
    agentId:'agent',turnKey:'a'.repeat(64),parentScopeId:null,background:false,sequence:1}}
  return {root,proc,runner,internal,request}
}

test('a late scope-control ACK never reaches a replacement process generation',async()=>{
  const f=fixture()
  const original=registry.handle
  let entered!:()=>void
  let release!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve})
  const paused=new Promise<void>(resolve=>{release=resolve})
  registry.handle=async request=>{entered();await paused;return {scopeId:(request as typeof f.request.request).scopeId,sequence:1,status:'active'}}
  try {
    const pending=f.internal.handleBoxAgentScope(f.request,{proc:f.proc,generation:1})
    await started
    const replacement=new FakeProc();f.internal.proc=replacement;f.internal.spawnGeneration=2
    release();await pending
    assert.equal(f.proc.stdin.writes.length,0);assert.equal(replacement.stdin.writes.length,0)
    assert.equal(f.runner.sessionId,f.root)
  } finally {registry.handle=original}
})

test('dedicated control frames leave the parser and root session untouched and ACK only their current owner',async()=>{
  const f=fixture()
  const original=registry.handle
  let resolveHandled!:()=>void
  const handled=new Promise<void>(resolve=>{resolveHandled=resolve})
  registry.handle=async request=>{resolveHandled();return {scopeId:(request as typeof f.request.request).scopeId,sequence:1,status:'active'}}
  const ordinary:unknown[]=[];f.runner.on('message',message=>ordinary.push(message))
  try {
    f.internal.handleStdout(`${JSON.stringify(f.request)}\n`,undefined,{proc:f.proc,generation:1})
    await handled;await new Promise<void>(resolve=>setImmediate(resolve))
    assert.equal(ordinary.length,0);assert.equal(f.runner.sessionId,f.root)
    assert.equal(f.proc.stdin.writes.length,1)
    assert.equal(JSON.parse(f.proc.stdin.writes[0]!).response.request_id,f.request.request_id)
  } finally {registry.handle=original}
})

test('a captured Stop retry preserves its original owner after process replacement',async()=>{
  const f=fixture()
  const original=registry.prepareRootStop
  const captured=f.runner.captureBoxAgentStop('a'.repeat(64))
  let observed:unknown
  registry.prepareRootStop=async(owner,turnKey)=>{observed={owner,turnKey}}
  try {
    f.internal.proc=new FakeProc();f.internal.spawnGeneration=2;f.internal.currentSessionId=randomUUID()
    await captured.prepare()
    assert.equal(captured.isCurrent(),false)
    assert.deepEqual(observed,{owner:captured.target!.owner,turnKey:'a'.repeat(64)})
    assert.equal(captured.target!.owner.rootSessionId,f.root)
    assert.equal(captured.target!.owner.generation,1)
  } finally {registry.prepareRootStop=original}
})
