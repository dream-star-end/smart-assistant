/** Real parent model CLI + synthetic local SSE. Never uses a paid provider. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const fixture=fileURLToPath(new URL('./fixtures/receiptModelCli.fixture.ts',import.meta.url))
const restore=fileURLToPath(new URL('./fixtures/receiptModelRestore.fixture.ts',import.meta.url))
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
for(const mode of ['wait-refresh','deferred-wait-refresh'] as const)test(`same-turn signed refresh via actual model CLI ${mode} and new-process native restore`,{timeout:240000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-model-cli-'))
 try {
  const out=await run(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),fixture,dir,mode],dir)
  const e=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'))
  assert.equal(e.failure,null,JSON.stringify(e));assert.match(out,/MODEL_PROBE_PASS/);
  assert.equal(e.failure,null);assert.equal(e.executions,1);assert.deepEqual(e.refresh,{changed:true,sameTurn:true,nonceHash:e.refresh.nonceHash})
  assert.equal(e.requests.length,mode==='wait-refresh'?3:4)
  assert.equal(e.received,true)
  assert.ok(e.http.some((r:{path:string;status:number})=>r.path==='/api/delegate/receipt-owner/input'&&r.status===200))
  const restored=await run('bun',['run',restore,dir,'wait'],dir)
  const proof=JSON.parse(restored.trim().split('\n').pop()!)
  assert.equal(proof.passed,true);assert.equal(proof.receiptInputs,1)
  console.log(JSON.stringify({mode,modelRequests:e.requests.length,executions:e.executions,received:e.received,nativeReceiptInputs:proof.receiptInputs}))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
