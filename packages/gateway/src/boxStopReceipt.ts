/** Freeze known control targets before awaiting I/O. A retry of the same
 * receipt must not rediscover a newer turn through its mutable session key. */
import type { DelegateGuardHost } from './delegateGuard.js'
import { captureDelegateTraceCancel } from './delegateTrace.js'
import { getBoxAgentScopeRegistry } from './engine/boxAgentScopeRegistry.js'

type Captured=NonNullable<ReturnType<DelegateGuardHost['sessions']['captureInterruptForReceipt']>>
type Pending={targets:Captured[];cancelQueued:Array<()=>void>;running?:Promise<boolean>}
const pendingByHost=new WeakMap<object,Map<string,Pending>>()

export async function capturedStopReceipt(host:DelegateGuardHost,identity:{
  channel:string;peerId:string;peerKind:'dm'|'group';clientMessageId:string;controlId?:string
}):Promise<boolean|undefined> {
  if (!host.sessions.captureInterruptForReceipt) return undefined // legacy thin adapters
  let pending=pendingByHost.get(host)
  if (!pending) {pending=new Map();pendingByHost.set(host,pending)}
  const receiptKey=JSON.stringify(identity)
  let entry=pending.get(receiptKey)
  if (!entry) {
    const safe=identity.peerId.replace(/[^a-zA-Z0-9_-]/g,'_')
    const suffix=`:${identity.channel}:${identity.peerKind}:${safe}`
    const root=host.sessions.list().find(s=>s.sessionKey.endsWith(suffix)
      && host.sessions.getByKey(s.sessionKey)?._runningClientMessageId===identity.clientMessageId)
    if (!root) return undefined
    if (pending.size>=1024) throw new Error('BOX_STOP_RECEIPT_PENDING_FULL')
    const targets:Captured[]=[]
    const cancelQueued:Array<()=>void>=[]
    const seen=new Set<string>()
    const capture=(key:string,rootTarget=false)=>{
      if (seen.has(key)) return
      seen.add(key)
      const current=host.sessions.getByKey(key)
      const target=host.sessions.captureInterruptForReceipt(key,rootTarget
        ? {clientMessageId:identity.clientMessageId} : {turnKey:current?._currentTurnKey})
      if(target) targets.push(target)
      const queued=host._delegateQueueWaiters?.get(key)
      const advisor=host._advisorConsultAborts?.get(key)
      const trace= captureDelegateTraceCancel(host,key)
      cancelQueued.push(()=>{trace();queued?.();advisor?.abort()})
      for(const child of host._activeDelegationsByParent?.get(key) ?? []) capture(child)
    }
    capture(root.sessionKey,true)
    entry={targets,cancelQueued}
    pending.set(receiptKey,entry) // before the first await, including a failed fsync
  }
  if (entry.running) return entry.running
  const captured=entry
  const run=(async()=>{
    const boxTargets=captured.targets.flatMap(target=>target.target ? [target.target] : [])
    // Every existing Box owner is fenced in ONE private fsync before a root
    // or child can clear its CMID. The outbox independently drains after ACK.
    if(boxTargets.length) await getBoxAgentScopeRegistry().prepareRootStops(boxTargets)
    await Promise.all(captured.targets.filter(target=>!target.target).map(target=>target.prepare()))
    for(const cancel of captured.cancelQueued) cancel()
    await Promise.all(captured.targets.map(target=>target.interrupt()))
    pending!.delete(receiptKey)
    return true
  })()
  captured.running=run
  try {return await run} finally {if(captured.running===run) captured.running=undefined}
}
