/** Real parent model CLI + synthetic local SSE. Never uses a paid provider. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const fixture=fileURLToPath(new URL('./fixtures/receiptModelLifecycle.fixture.ts',import.meta.url))
const restore=fileURLToPath(new URL('./fixtures/receiptBackgroundRestore.fixture.ts',import.meta.url))
async function run(command:string,args:string[],home:string) {
 const child=spawn(command,args,{cwd:root,env:{PATH:process.env.PATH!,HOME:home,NODE_ENV:'test',TEST_ENABLE_SESSION_PERSISTENCE:'1',OC_DELEGATE_SM:'1',OC_DELEGATE_DURABLE:'1'},stdio:['ignore','pipe','pipe']})
 let out='',err=''
 child.stdout.on('data',b=>{out+=b});child.stderr.on('data',b=>{err+=b})
 const timer=setTimeout(()=>child.kill('SIGTERM'),210000)
 try {
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  assert.equal(code,0,`${out.slice(-3000)}\n${err.slice(-4000)}`)
  return out
 }finally{clearTimeout(timer)}
}
for(const mode of ['end','kill','cross-turn','ingested-end','handoff-cli','handoff-running','handoff-mcp','handoff-deferred'] as const)test(`actual parent lifecycle model CLI receipt ${mode} and new-process native restore`,{timeout:240000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-model-cli-'))
 try {
  const out=await run(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),fixture,dir,mode],dir)
  const e=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'))
  assert.equal(e.failure,null,JSON.stringify(e));assert.match(out,/MODEL_PROBE_PASS/);
  assert.equal(e.failure,null);assert.equal(e.executions,1)
  assert.equal(e.requests.length,mode==='kill'?2:mode==='end'?2:mode==='handoff-deferred'?5:mode==='cross-turn'||mode.startsWith('handoff-')?4:3)
  assert.equal(e.accepted.length,mode==='ingested-end'?0:1);assert.equal(e.masterRequests.length,e.accepted.length)
  assert.ok(e.terminalCalls>=1);if(mode==='kill')assert.equal(e.killedSignal,'SIGKILL')
  assert.equal(e.received,mode==='ingested-end')
  assert.ok(e.http.some((r:{path:string;status:number})=>r.path==='/api/agents/coding-assistant/delegate'&&r.status===200))
  const restored=await run('bun',['run',restore,dir,mode==='ingested-end'?'create':'stop'],dir)
  const proof=JSON.parse(restored.trim().split('\n').pop()!)
  assert.equal(proof.passed,true);assert.equal(proof.receiptInputs,mode==='ingested-end'?1:0)
  assert.equal(proof.receiptInputs+e.accepted.length,1,'one delivery owner across native and callback')
  console.log(JSON.stringify({mode,modelRequests:e.requests.length,executions:e.executions,received:e.received,nativeReceiptInputs:proof.receiptInputs}))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
