import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionManager } from '../sessionManager.js'
import { handleStop } from '../wsConnection.js'
import { registerDelegateTraceWait } from '../delegateTrace.js'

function deferred() {
  let resolve!:()=>void,reject!:(error:Error)=>void
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
function fixture() {
  const key='agent:main:webchat:dm:boxagentreceipt'
  let barrier=deferred(),interrupts=0,prepares=0
  const external=new AbortController()
  const session={sessionKey:key,peerId:'boxagentreceipt',model:'box-api-claude-opus-5-5',
    _currentTurnKey:'a'.repeat(64),_runningClientMessageId:'m-boxagentreceipt-0001',
    _externalTurnAbort:external,_persistActiveTurn:undefined as undefined|(()=>Promise<void>),
    runner:{prepareInterrupt:async()=>{prepares++;await barrier.promise},interrupt:()=>{interrupts++;return true}}}
  const manager=Object.create(SessionManager.prototype) as SessionManager
  const entries=new Map([[key,session]])
  Object.assign(manager,{sessions:entries,_trackPersistence:()=>{},fencePreStartStop:()=>{}})
  const host={sessions:manager,_activeDelegationsByParent:new Map<string,Set<string>>(),_pendingPermissions:new Map(),
    _settlePendingPermissionsForStop:()=>{},log:{info:()=>{},warn:()=>{}}}
  const frame={type:'inbound.control.stop' as const,channel:'webchat',peer:{id:'boxagentreceipt',kind:'dm' as const},
    clientMessageId:session._runningClientMessageId}
  return {key,session,entries,manager,external,barrier,host,frame,interrupts:()=>interrupts,prepares:()=>prepares,
    nextBarrier:()=>{barrier=deferred();return barrier}}
}

test('actual browser Stop awaits the Box durable barrier before a receipt and local abort',async()=>{
  const f=fixture()
  let settled=false
  const stop=handleStop.call(f.host as never,f.frame).then(value=>{settled=true;return value})
  await Promise.resolve()
  assert.equal(f.prepares(),1);assert.equal(settled,false)
  assert.equal(f.external.signal.aborted,false);assert.equal(f.interrupts(),0)
  f.barrier.resolve()
  assert.equal(await stop,true)
  assert.equal(f.external.signal.aborted,true);assert.equal(f.interrupts(),1)
})

test('same Stop receipt retries frozen child targets after the parent CMID ends, without stopping a replacement',async()=>{
  const f=fixture(),childKey='agent:worker:delegate:old-child'
  const oldAbort=new AbortController(),newAbort=new AbortController()
  let fail=true,oldPrepares=0,oldInterrupts=0,newInterrupts=0
  const oldRunner={prepareInterrupt:async()=>{oldPrepares++;if(fail) throw new Error('child private fsync failed')},
    interrupt:()=>{oldInterrupts++;return true}}
  const child={...f.session,sessionKey:childKey,_runningClientMessageId:'m-child',
    _externalTurnAbort:oldAbort,runner:oldRunner}
  f.entries.set(childKey,child)
  f.host._activeDelegationsByParent.set(f.key,new Set([childKey]))
  const oldTrace=registerDelegateTraceWait(f.host,childKey)
  f.barrier.resolve()
  await assert.rejects(()=>handleStop.call(f.host as never,f.frame),/child private fsync failed/)
  assert.equal(f.external.signal.aborted,false,'no target aborts before all prepares succeed')
  f.session._runningClientMessageId=''
  oldTrace.close()
  const newTrace=registerDelegateTraceWait(f.host,childKey)
  child._currentTurnKey='b'.repeat(64);child._externalTurnAbort=newAbort
  child.runner={prepareInterrupt:async()=>{throw new Error('must not prepare a replacement')},
    interrupt:()=>{newInterrupts++;return true}}
  fail=false
  assert.equal(await handleStop.call(f.host as never,f.frame),true)
  assert.equal(oldPrepares,2)
  assert.equal(oldInterrupts,0);assert.equal(newInterrupts,0)
  assert.equal(oldAbort.signal.aborted,false);assert.equal(newAbort.signal.aborted,false)
  assert.equal(oldTrace.isAborted(),true);assert.equal(newTrace.isAborted(),false)
  newTrace.close()
})

test('failed Box persistence rejects the receipt path; retry can confirm the same exact turn',async()=>{
  const f=fixture()
  const failed=f.manager.interruptForReceipt(f.key,{clientMessageId:f.frame.clientMessageId})
  f.barrier.reject(new Error('synthetic fsync EIO'))
  await assert.rejects(failed,/fsync EIO/)
  assert.equal(f.external.signal.aborted,false);assert.equal(f.interrupts(),0)
  const barrier=f.nextBarrier()
  const retry=f.manager.interruptForReceipt(f.key,{clientMessageId:f.frame.clientMessageId})
  barrier.resolve();assert.equal(await retry,true)
})

test('late durable ACK cannot stop a successor turn, controller or engine',async()=>{
  const f=fixture()
  const pending=f.manager.interruptForReceipt(f.key,{turnKey:f.session._currentTurnKey})
  const next=new AbortController()
  f.session._currentTurnKey='b'.repeat(64);f.session._externalTurnAbort=next
  f.barrier.resolve()
  assert.equal(await pending,true,'the old durable target is applied without aborting its successor')
  assert.equal(f.external.signal.aborted,false);assert.equal(next.signal.aborted,false)
  assert.equal(f.interrupts(),0)
  assert.equal(await f.manager.interruptForReceipt(f.key,{turnKey:'a'.repeat(64)}),false)
  assert.equal(f.prepares(),1)
})

test('active-turn receipt awaits terminal persistence and propagates its failure',async()=>{
  const f=fixture()
  const persistence=deferred()
  const entered=deferred()
  f.session._persistActiveTurn=()=>{entered.resolve();return persistence.promise}
  f.barrier.resolve()
  let settled=false
  const pending=f.manager.interruptForReceipt(f.key).finally(()=>{settled=true})
  await entered.promise;assert.equal(settled,false)
  persistence.reject(new Error('terminal persistence unavailable'))
  await assert.rejects(pending,/terminal persistence unavailable/)
  assert.equal(f.external.signal.aborted,false);assert.equal(f.interrupts(),0)
})
