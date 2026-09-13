/** Real parent model CLI + synthetic local SSE. Never uses a paid provider. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const fixture=fileURLToPath(new URL('./fixtures/receiptModelMcpBatch.fixture.ts',import.meta.url))
const restore=fileURLToPath(new URL('./fixtures/receiptMcpBatchRestore.fixture.ts',import.meta.url))
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
for(const mode of ['success','direct','partial','child-failure','stop','mixed','notify-loser'] as const)test(`actual MCP batch receipt ${mode} and new-process native restore`,{timeout:240000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-model-composite-'))
 try {
  const out=await run(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),fixture,dir,mode],dir)
  const e=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'))
  assert.equal(e.failure,null,JSON.stringify(e));assert.match(out,/MODEL_PROBE_PASS/);
  assert.equal(e.failure,null);assert.equal(e.executions,mode==='partial'?1:2)
  assert.equal(e.requests.length,mode==='direct'||mode==='stop'?2:3)
  assert.equal(e.received,mode!=='stop')
  assert.ok(e.http.some((r:{path:string;status:number})=>r.path==='/api/delegate/receipt-owner/input'&&r.status===(mode==='stop'?409:200)))
  const restored=await run('bun',['run',restore,dir,mode],dir)
  const proof=JSON.parse(restored.trim().split('\n').pop()!)
  assert.equal(proof.passed,true);assert.equal(proof.receiptInputs,mode==='stop'?0:mode==='partial'||mode==='notify-loser'?1:2)
  console.log(JSON.stringify({mode,modelRequests:e.requests.length,executions:e.executions,received:e.received,nativeReceiptInputs:proof.receiptInputs}))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
