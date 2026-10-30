import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveBoxAgentSession, type BoxAgentScopeControl } from '@openclaude/protocol'
import { BoxAgentScopeRegistry, captureBoxScopeOwner } from './boxAgentScopeRegistry.js'
import type { controlBoxAgentScope } from './boxAgentScopeClient.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'box-agent-registry-'))
  const file = join(dir,'control.json')
  const root = randomUUID()
  const owner = captureBoxScopeOwner(process.pid,1,randomUUID(),root)
  const server = new Map<string,boolean>()
  let proof = true
  let failCancel = false
  let loseRegisterAck = false
  const calls: Array<{scopeId:string;operation:string}> = []
  const remote: typeof controlBoxAgentScope = async (identity,operation) => {
    // ACK must be preceded by the actual durable private control file.
    const state = JSON.parse(await readFile(file,'utf8'))
    assert.ok(state.records[identity.scopeId])
    assert.equal((await stat(file)).mode & 0o777,0o600)
    calls.push({scopeId:identity.scopeId,operation})
    if (operation === 'register') {
      if (!server.has(identity.scopeId)) server.set(identity.scopeId,false)
      if (loseRegisterAck) {loseRegisterAck=false;throw new Error('lost register ACK')}
    }
    if (operation === 'cancel') {
      if (failCancel) throw new Error('404 or lost response')
      server.set(identity.scopeId,true)
    }
    const cancelled = server.get(identity.scopeId) === true
    return {scopeId:identity.scopeId,status:cancelled ? proof ? 'stopped' : 'pending' : 'active',
      fence:cancelled ? 'cancelled' : 'active',
      ...(cancelled && proof ? {proof:'all_physical_runs_terminal' as const} : {})}
  }
  const create = () => new BoxAgentScopeRegistry({file,containerId:'1',remote,ownerState:() => 'live'})
  const request = (agentId: string, background=false, parentScopeId:string|null=null): BoxAgentScopeControl => ({
    subtype:'box_agent_scope',version:1,operation:'register',scopeId:randomUUID(),
    rootSessionId:root,sessionId:deriveBoxAgentSession(root,agentId),agentId,turnKey:'a'.repeat(64),
    parentScopeId,background,sequence:1})
  return {dir,file,owner,create,request,calls,server,
    proof:(value:boolean) => {proof=value},failCancel:(value:boolean) => {failCancel=value},
    loseRegisterAck:() => {loseRegisterAck=true},
    state:async () => JSON.parse(await readFile(file,'utf8')),
    close:() => rm(dir,{recursive:true,force:true})}
}

test('lost registration ACK retries control only and immutable/generation conflicts fail closed', async () => {
  const f = await fixture()
  try {
    const request = f.request('same-agent')
    f.loseRegisterAck()
    await assert.rejects(() => f.create().handle(request,f.owner),/lost register ACK/)
    assert.equal((await f.state()).records[request.scopeId].registered,false)
    assert.equal((await f.create().handle(request,f.owner)).status,'active')
    assert.equal(f.server.size,1)
    await assert.rejects(() => f.create().handle({...request,sequence:2,turnKey:'b'.repeat(64)},f.owner),/CONFLICT/)
    await assert.rejects(() => f.create().handle({...request,sequence:2},{...f.owner,generation:2}),/CONFLICT/)
  } finally {await f.close()}
})

test('root Stop persists before interrupt, catches late foreground registration, and preserves background lineage', async () => {
  const f = await fixture()
  try {
    const registry = f.create()
    const foreground = f.request('foreground')
    const background = f.request('background',true)
    const nested = f.request('nested-under-background',false,background.scopeId)
    for (const request of [foreground,background,nested]) await registry.handle(request,f.owner)
    await registry.prepareRootStop(f.owner,foreground.turnKey)
    const stopped = await f.state()
    assert.equal(stopped.records[foreground.scopeId].intent,'cancel')
    assert.equal(stopped.records[background.scopeId].intent,'register')
    assert.equal(stopped.records[nested.scopeId].intent,'register')
    const late = f.request('late-foreground')
    assert.notEqual((await registry.handle(late,f.owner)).status,'active')
    await registry.pump()
    assert.equal(f.server.get(late.scopeId),true)
    assert.equal(f.server.get(background.scopeId),false)
    assert.equal(f.server.get(nested.scopeId),false)
  } finally {await f.close()}
})

test('durable detach precedes root Stop and individual Stop leaves peers alive', async () => {
  const f = await fixture()
  try {
    const registry = f.create()
    const a = f.request('detached')
    const b = f.request('peer',true)
    await registry.handle(a,f.owner);await registry.handle(b,f.owner)
    await registry.handle({...a,operation:'detach',sequence:2},f.owner)
    await registry.prepareRootStop(f.owner,a.turnKey)
    assert.equal((await f.state()).records[a.scopeId].intent,'register')
    const stop = {...a,background:true,operation:'explicit-stop' as const,sequence:3}
    assert.equal((await registry.handle(stop,f.owner)).status,'pending')
    await registry.pump()
    assert.equal(f.server.get(a.scopeId),true)
    assert.equal(f.server.get(b.scopeId),false)
  } finally {await f.close()}
})

test('captured Stop tree root fences are one durable write before any owner can be interrupted',async()=>{
  const f=await fixture()
  try {
    const registry=f.create()
    const a=f.request('owner-a')
    const b=f.request('owner-b')
    const second={...f.owner,generation:2,incarnation:randomUUID()}
    await registry.handle(a,f.owner);await registry.handle(b,second)
    await assert.rejects(()=>registry.prepareRootStops([{owner:f.owner,turnKey:a.turnKey},
      {owner:second,turnKey:'invalid'}]),/BOX_SCOPE_TURN_INVALID/)
    const unchanged=await f.state()
    assert.equal(unchanged.rootStops.length,0)
    assert.equal(unchanged.records[a.scopeId].intent,'register')
    await registry.prepareRootStops([{owner:f.owner,turnKey:a.turnKey},{owner:second,turnKey:b.turnKey}])
    const stopped=await f.state()
    assert.equal(stopped.rootStops.length,2)
    assert.equal(stopped.records[a.scopeId].intent,'cancel')
    assert.equal(stopped.records[b.scopeId].intent,'cancel')
    await registry.pump()
  } finally {await f.close()}
})

test('404/pending/lost response survives restart; old scope Stop cannot stop same-agent same-turn resume', async () => {
  const f = await fixture()
  try {
    const old = f.request('stable-agent',true)
    const next = f.request('stable-agent',true)
    assert.equal(old.sessionId,next.sessionId)
    const registry = f.create()
    await registry.handle(old,f.owner)
    f.proof(false);f.failCancel(true)
    await registry.handle({...old,operation:'explicit-stop',sequence:2},f.owner)
    await registry.pump()
    assert.equal((await f.state()).records[old.scopeId].stopped,false)
    const recovered = f.create()
    await recovered.handle(next,f.owner)
    f.failCancel(false);await recovered.pump()
    assert.equal((await f.state()).records[old.scopeId].stopped,false)
    assert.equal(f.server.get(next.scopeId),false)
    f.proof(true);await recovered.pump()
    assert.equal((await f.state()).records[old.scopeId].stopped,true)
    assert.equal(f.server.get(next.scopeId),false)
  } finally {await f.close()}
})

test('real kernel lock serializes independent writers and owner exit never cancels a replacement', async () => {
  const f = await fixture()
  try {
    const requests = Array.from({length:8},(_,i) => f.request(`parallel-${i}`,true))
    await Promise.all(requests.map(request => f.create().handle(request,f.owner)))
    assert.equal(Object.keys((await f.state()).records).length,8)
    const replacementOwner = {...f.owner,incarnation:randomUUID(),generation:2}
    const replacement = f.request('replacement',true)
    const registry = f.create()
    await registry.handle(replacement,replacementOwner)
    await registry.ownerExited(f.owner)
    await registry.pump()
    const state = await f.state()
    assert.ok(requests.every(request => state.records[request.scopeId].intent === 'cancel'))
    assert.equal(state.records[replacement.scopeId].intent,'register')
  } finally {await f.close()}
})
