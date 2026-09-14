import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReceiptHandoff } from '../receiptHandoffView.js'
import { runDelegateWaitLoop } from '../delegateWaitCli.js'
const handoff={status:'receipt_handoff',jobId:'dlgjob-old',generation:0,execution:'running',delivery:'pending'}
const response=(data:unknown,statusCode=200)=>({statusCode,body:JSON.stringify(data)})
test('handoff is metadata, never counted as child success; malformed or HTTP failure cannot become handoff',async()=>{
 for(const bad of [{...handoff,result:'private'},{...handoff,delivery:'notified'},{...handoff,generation:-1}])assert.equal(parseReceiptHandoff(bad),undefined)
 const result=await runDelegateWaitLoop({jobIds:['dlgjob-old','dlgjob-good','dlgjob-bad'],pollWaitMs:500,
  waitOnce:async id=>id==='dlgjob-old'?response(handoff):id==='dlgjob-bad'?response({error:'bad item'},409):response({status:'done',output:'GOOD'})})
 assert.equal(result.exitCode,2);assert.match(result.stdout,/1 成功 \/ 1 失败/);assert.match(result.stdout,/1 项仅交接状态/)
 assert.match(result.stdout,/仍在运行/);assert.match(result.stdout,/GOOD/);assert.match(result.stdout,/bad item/)
 const failed=await runDelegateWaitLoop({jobIds:['dlgjob-old'],pollWaitMs:500,waitOnce:async()=>response(handoff,401)})
 assert.equal(failed.exitCode,2)
})
test('budget exit never calls running handoff completed or re-enqueues it for wait',async()=>{
 let now=0;const seen:string[]=[]
 const result=await runDelegateWaitLoop({jobIds:['dlgjob-old','dlgjob-live'],pollWaitMs:1000,foregroundBudgetMs:500,
  now:()=>now,sleep:async ms=>{now+=ms},waitOnce:async id=>{seen.push(id);return id==='dlgjob-old'?response(handoff):response({status:'running',jobId:id})}})
 assert.equal(result.exitCode,0);assert.match(result.stdout,/0 已完成/);assert.match(result.stdout,/1 项仅交接状态/)
 assert.match(result.stdout,/oc-memory delegate-wait dlgjob-live/);assert.ok(!result.stdout.includes('oc-memory delegate-wait dlgjob-old'))
 assert.equal(seen.filter(id=>id==='dlgjob-old').length,1)
})
