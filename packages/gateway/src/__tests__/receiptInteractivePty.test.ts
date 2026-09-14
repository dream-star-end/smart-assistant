/** Real full interactive CLI PTY, not SDK -p or mounted Ink. No paid model. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../../../',import.meta.url))
const fixture=fileURLToPath(new URL('./fixtures/receiptInteractivePty.fixture.py',import.meta.url))
const restore=fileURLToPath(new URL('./fixtures/receiptInteractiveRestore.fixture.ts',import.meta.url))
function killPrivate(home:string) {
 for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){
  try{
   const env=readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')
   if(env.includes(`HOME=${home}`)||env.includes(`HOME=${join(home,'home')}`))process.kill(Number(pid),'SIGKILL')
  }catch{/* process disappeared or is not readable */}
 }
}
async function run(command:string,args:string[],home:string) {
 const child=spawn(command,args,{cwd:root,env:{PATH:process.env.PATH!,HOME:home,NODE_ENV:'test',TEST_ENABLE_SESSION_PERSISTENCE:'1'},stdio:['ignore','pipe','pipe']})
 let out='',err='',timedOut=false
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b)
 const timer=setTimeout(()=>{timedOut=true;killPrivate(home);child.kill('SIGKILL')},150000)
 try{
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  assert.equal(timedOut,false,`private process watchdog: ${out}\n${err}`)
  return {code,out,err}
 }finally{clearTimeout(timer)}
}
for(const mode of ['ordinary','unowned','no-key'] as const)test(`full interactive PTY ${mode}: real CLI boundary and fresh native restore`,{timeout:190000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-pty-'));let passed=false
 try{
  const r=await run('python3',[fixture,dir,mode],dir)
  const evidence=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'))
  assert.equal(r.code,mode==='no-key'?1:0,`${r.out}\n${r.err}`)
  assert.ok(!evidence.argv.includes('-p'));assert.ok(!evidence.argv.includes('--print'))
  if(mode==='no-key'){
   assert.match(evidence.error,/manually backgrounded tool_result must exist before release/)
   assert.deepEqual(evidence.observedBeforeCleanup,{background:false,mainModelRequests:1,beforeRelease:true})
   assert.equal(evidence.keySent,false);assert.equal(evidence.background,false)
  }else{
   assert.equal(evidence.error,null,JSON.stringify(evidence));assert.deepEqual(evidence.handlerFailures,[])
   assert.equal(evidence.mainModelRequests,mode==='ordinary'?4:2)
   if(mode==='ordinary'){assert.equal(evidence.keySent,true);assert.equal(evidence.background,true);assert.equal(evidence.modelReceivedOrdinaryResult,true)}
   else{
    assert.equal(existsSync(join(dir,'started')),false)
    const proof=JSON.parse(readFileSync(join(dir,'gateway-evidence.json'),'utf8'))
    assert.equal(proof.passed,true);assert.equal(proof.jobs,0);assert.equal(proof.receipts,0);assert.equal(proof.parents,0)
   }
   const restored=await run('bun',['run',restore,dir,mode],dir)
   assert.equal(restored.code,0,`${restored.out}\n${restored.err}`)
   const proof=JSON.parse(restored.out.trim().split('\n').at(-1)!);assert.equal(proof.passed,true)
  }
  console.log(JSON.stringify({mode,modelRequests:evidence.mainModelRequests,keySent:evidence.keySent,ordinaryReceived:evidence.modelReceivedOrdinaryResult,observedBeforeCleanup:evidence.observedBeforeCleanup,receiptOwner:'none'}));passed=true
 }finally{killPrivate(dir);if(passed)rmSync(dir,{recursive:true,force:true});else console.error('Private failure artifacts preserved: '+dir)}
})
