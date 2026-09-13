import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ReceiptDeliveryStore } from '@openclaude/storage/receiptDeliveryStore'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { dispatchJobTerminalNotify } from '../delegateNotifyDispatch.js'
import { DefaultEngineNotifier, notifyClaimFenceOf, type NotifyClaimFence } from '../engineNotifier.js'
import { delegateNotifyId, type JobTerminal } from '@openclaude/protocol'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const latch=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {resolve,promise}}
async function fixture(t:TestContext, output='authoritative result') {
 const dir=mkdtempSync(join(tmpdir(),'receipt-notify-')),path=join(dir,'jobs.db')
 let now=Date.now(), requests=0, gate:Promise<void>|undefined
 const durable=new DelegateDurableDb(path), raw=new Database(path)
 const jobs=new DelegateJobStore({durable,sm:true,deliveryReceipts:true,now:()=>now})
 const made=jobs.create('worker',{callback:'stdout-wait',callbackOriginUserId:'3',parentSessionKey:'agent:main:webchat:dm:receipt-notify',parentEngine:'ccb',deliveryReceipt:{parentTurnKey:'turn',nativeToolUseId:'tool',receiptNonceHash:hash('nonce')}})
 assert.ok('jobId' in made)
 const initial=jobs.snapshotOf(made.jobId)!
 jobs.complete(made.jobId,{httpStatus:200,body:{ok:true,output}},{claimToken:initial.claimToken!,fencingEpoch:initial.fencingEpoch})
 const binding=durable.getDeliveryReceipt(made.jobId,0)!, delivery=new ReceiptDeliveryStore(path,()=>now)
 raw.exec('CREATE TABLE test_receiver_inputs (notify_id TEXT PRIMARY KEY, result TEXT NOT NULL)')
 const receiver=createServer(async(req,res)=>{let b='';for await(const chunk of req)b+=chunk;const event=JSON.parse(b) as JobTerminal;requests++
  raw.prepare('INSERT OR IGNORE INTO test_receiver_inputs VALUES (?,?)').run(delegateNotifyId(event.jobId,event.callbackEpoch),event.resultRef)
  if(gate)await gate;res.end('{"ok":true}')
 })
 await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r))
 const address=receiver.address();assert.ok(address&&typeof address==='object')
 const url=`http://127.0.0.1:${address.port}`
 const notifier=()=>new DefaultEngineNotifier({resumeInject:{inject:async event=>{
  const r=await fetch(url,{method:'POST',body:JSON.stringify(event)});return await r.json() as {ok:boolean}
 }}})
 const snap=()=>jobs.snapshotOf(made.jobId)!
 const receipt=()=>durable.getDeliveryReceipt(made.jobId,0)!
 const inputs=()=>Number((raw.prepare('SELECT count(*) n FROM test_receiver_inputs').get() as {n:number}).n)
 const prepare=()=>delivery.recover(binding,async()=>({kind:'absent'}),async()=> 'inactive')
 t.after(async()=>{receiver.closeAllConnections();await new Promise<void>(r=>receiver.close(()=>r()));raw.close();delivery.close();jobs.close();rmSync(dir,{recursive:true,force:true})})
 return {path,jobs,durable,raw,delivery,binding,snap,receipt,inputs,prepare,notifier,url,requests:()=>requests,setGate:(v:Promise<void>|undefined)=>{gate=v},tick:(ms:number)=>{now+=ms},now:()=>now}
}
test('real dispatcher refuses unselected input owner, then sends and atomically acknowledges one HTTP notification',async t=>{
 const f=await fixture(t)
 assert.deepEqual(await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier()),{skipped:true,reason:'receipt_owner_not_ready'})
 assert.equal(f.requests(),0);assert.equal(await f.prepare(),'notify_ready')
 const result=await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier())
 assert.equal('ok' in result&&result.ok,true);assert.equal(f.inputs(),1);assert.equal(f.requests(),1)
 assert.equal((f.raw.prepare('SELECT result FROM test_receiver_inputs').get() as {result:string}).result,'authoritative result')
 assert.equal(f.receipt().state,'notified');assert.equal(f.snap().callbackState,'delivered')
 await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier());assert.equal(f.requests(),1)
 let writes=0
 assert.equal(await f.delivery.ingest(f.binding,{parentOwnerEpoch:'old',proof:{nativeSessionId:'native',recordLocator:'not-used',recordHash:hash('record')},isCurrentParentOwner:async()=>true},async()=>{writes++},async()=>({kind:'absent'})),'notify_owned')
 assert.equal(writes,0)
})
test('two actual dispatchers cannot steal physical notify ownership even after lease expiry',async t=>{
 const f=await fixture(t);await f.prepare();const held=latch(),entered=latch();f.setGate(held.promise)
 const n=f.notifier(), notify=n.notify.bind(n);n.notify=async e=>{entered.resolve();return notify(e)}
 const first=dispatchJobTerminalNotify(f.jobs,f.snap(),n);await entered.promise
 const secondDb=new DelegateDurableDb(f.path),second=new DelegateJobStore({durable:secondDb,sm:true,now:f.now})
 f.tick(120000)
 const another=dispatchJobTerminalNotify(second,second.snapshotOf(f.binding.jobId)!,f.notifier())
 try{await assert.rejects(f.durable.withDeliveryReceiptBarrier(f.binding.jobId,0,async()=>{}, {timeoutMs:25}),/flock failed|timed out/)}finally{held.resolve()}
 try{await first;await another;assert.equal(f.inputs(),1);assert.equal(f.requests(),1);assert.equal(f.receipt().state,'notified')}finally{second.close()}
})
test('ACK transaction failure preserves both claims; retry keeps callback id and receiver input unique',async t=>{
 const f=await fixture(t);await f.prepare()
 f.raw.exec(`CREATE TRIGGER reject_ack BEFORE UPDATE OF callback_state ON delegate_jobs WHEN NEW.callback_state='delivered' BEGIN SELECT RAISE(ABORT,'ACK failure'); END`)
 await assert.rejects(dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier()),/ACK failure/)
 assert.equal(f.inputs(),1);assert.equal(f.receipt().state,'notify_claimed');assert.equal(f.snap().callbackState,'injecting')
 const epoch=f.snap().callbackEpoch
 f.raw.exec('DROP TRIGGER reject_ack');f.tick(31000)
 await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier())
 assert.equal(f.requests(),2);assert.equal(f.inputs(),1);assert.equal(f.receipt().state,'notified');assert.equal(f.snap().callbackEpoch,epoch)
})
test('old notifier ACK/release APIs cannot mutate a receipt claim and escaped callbacks expire with the barrier',async t=>{
 const f=await fixture(t);await f.prepare();let escaped:NotifyClaimFence|undefined
 const n=f.notifier();n.notify=async event=>{
  escaped=notifyClaimFenceOf(event);assert.equal(escaped?.isLive(),true)
  const snap=f.snap(),args={jobId:snap.id,state:snap.state,fencingEpoch:snap.fencingEpoch,claimToken:snap.claimToken,deliveryToken:snap.notifyDeliveryToken!,now:f.now()}
  assert.equal(f.durable.casCompleteNotify(args),undefined)
  assert.equal(f.durable.casReleaseNotify({...args,retryAt:0,notifyAttempt:1}),undefined)
  assert.equal(f.durable.casMarkAAttempted(args),undefined)
  return {ok:false,failureClass:'transport',hold:true}
 }
 await dispatchJobTerminalNotify(f.jobs,f.snap(),n)
 assert.equal(escaped!.isLive(),false);assert.equal(escaped!.ackDelivered(),false)
 assert.equal(f.receipt().state,'notify_claimed');assert.equal(f.inputs(),0)
 f.tick(31000);await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier());assert.equal(f.inputs(),1)
 assert.equal(escaped!.ackDelivered(),false)
})
test('receipt result resembling heartbeat still reaches the real receiver, not skipped_silent',async t=>{
 const f=await fixture(t,'HEARTBEAT_OK');await f.prepare()
 await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier())
 assert.equal(f.requests(),1);assert.equal(f.inputs(),1);assert.equal(f.receipt().state,'notified')
})
test('unknown native proof remains held beyond old notifier hold windows, with zero HTTP delivery',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.delivery.ingest(f.binding,{parentOwnerEpoch:'epoch',proof:{nativeSessionId:'native',recordLocator:'missing',recordHash:hash('record')},isCurrentParentOwner:async()=>true},async()=>{throw Error('writer stopped')},async()=>({kind:'unknown'})))
 for(const dt of [0,86400000]){f.tick(dt);assert.equal(await f.delivery.recover(f.binding,async()=>({kind:'unknown'}),async()=> 'inactive'),'unknown');await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier())}
 assert.equal(f.requests(),0);assert.equal(f.inputs(),0);assert.equal(f.receipt().state,'ingest_claimed')
})

test('actual notifier process SIGKILL after HTTP acceptance resumes same callback without a second receiver input',async t=>{
 const f=await fixture(t);await f.prepare()
 const modulePath=(name:string)=>fileURLToPath(new URL('../'+name+'.ts',import.meta.url))
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`
  import {DelegateDurableDb} from ${JSON.stringify(modulePath('delegateDurable'))};
  import {DelegateJobStore} from ${JSON.stringify(modulePath('delegateJobs'))};
  import {DefaultEngineNotifier} from ${JSON.stringify(modulePath('engineNotifier'))};
  import {dispatchJobTerminalNotify} from ${JSON.stringify(modulePath('delegateNotifyDispatch'))};
  const db=new DelegateDurableDb(${JSON.stringify(f.path)}), jobs=new DelegateJobStore({durable:db,sm:true});
  const notifier=new DefaultEngineNotifier({resumeInject:{inject:async event=>{
    const response=await fetch(${JSON.stringify(f.url)},{method:'POST',body:JSON.stringify(event)});await response.json();
    process.send('accepted');await new Promise(resolve=>process.once('message',resolve));return {ok:true};
  }}});
  await dispatchJobTerminalNotify(jobs,jobs.snapshotOf(${JSON.stringify(f.binding.jobId)}),notifier);jobs.close();
 `],{stdio:['ignore','ignore','pipe','ipc']})
 let errors='';child.stderr?.on('data',b=>{errors+=b})
 const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()))
 const watchdog=setTimeout(()=>child.kill('SIGKILL'),15000)
 try {
  await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('close',()=>reject(Error(errors||'child closed before HTTP')));})
  assert.equal(f.inputs(),1);assert.equal(f.receipt().state,'notify_claimed')
  await assert.rejects(f.durable.withDeliveryReceiptBarrier(f.binding.jobId,0,async()=>{}, {timeoutMs:25}),/flock failed|timed out/)
  child.kill('SIGKILL');await exited;f.tick(Math.max(0, f.snap().notifyClaimedUntil! - f.now() + 1))
  await dispatchJobTerminalNotify(f.jobs,f.snap(),f.notifier())
  assert.equal(f.inputs(),1);assert.equal(f.requests(),2);assert.equal(f.receipt().state,'notified');assert.equal(f.snap().callbackEpoch,1)
 }finally{clearTimeout(watchdog);child.kill('SIGKILL');await exited}
})
