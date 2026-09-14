/** Synthetic HTTP transport contract, not a Gateway authorization test. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ReceiptOwnerCapabilities,receiptContextHash} from '../../../gateway/src/receiptOwnerCapability.js'
import {issueDelegateContextToken,DELEGATE_CONTEXT_HEADER} from '../../../gateway/src/delegateContext.js'
import {ReceiptCliTransport,RECEIPT_CAP_ENV,RECEIPT_CACHE_ENV} from '../receiptCliTransport.js'
import {createReceiptMcpTransport,RECEIPT_MCP_META} from '../receiptMcpTransport.js'
test('handoff transport errors are per-item, no retry/ready publication; MCP metadata success has no locator',async()=>{
 const home=mkdtempSync(join(tmpdir(),'receipt-handoff-transport-')),saved={...process.env}
 const context=issueDelegateContextToken({agentId:'main',sessionKey:'agent:main:test:handoff',depth:0})
 const cap=new ReceiptOwnerCapabilities().issue({userId:'default',agentId:'main',sessionKey:'agent:main:test:handoff',contextHash:receiptContextHash(context),adapterInstanceId:'adapter',parentOwnerEpoch:'epoch',turnKey:'new-turn',nativeSessionId:'native',consumerToolUseId:'waiter',toolName:'Bash'})
 let count=0,ready=0,behavior='ok'
 const server=createServer(async(req,res)=>{
  count++;assert.equal(req.url,'/api/delegate/receipt-owner/handoff-status')
  assert.equal(req.headers[DELEGATE_CONTEXT_HEADER],context)
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw)
  assert.deepEqual(Object.keys(body).sort(),['capability','jobId'])
  if(behavior==='disconnect'){req.socket.destroy();return}
  if(behavior==='denied'){res.writeHead(409);res.end(JSON.stringify({error:'same turn candidate missing'}));return}
  res.end(behavior==='malformed'?'not json':JSON.stringify({status:'receipt_handoff',jobId:behavior==='wrong-job'?'dlgjob-other':body.jobId,generation:0,execution:'running',delivery:'pending'}))
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 try {
  writeFileSync(join(home,'token'),'synthetic-only');writeFileSync(join(home,'context'),context)
  Object.assign(process.env,{OPENCLAUDE_HOME:home,OPENCLAUDE_GATEWAY_PORT:String((server.address() as {port:number}).port),OPENCLAUDE_GATEWAY_TOKEN_FILE:join(home,'token'),OPENCLAUDE_DELEGATE_CONTEXT_FILE:join(home,'context')})
  const cli=new ReceiptCliTransport({...process.env,[RECEIPT_CAP_ENV]:cap,[RECEIPT_CACHE_ENV]:join(home,'receipt-candidates-v1')},()=>{ready++})
  for(const mode of ['ok','malformed','wrong-job','disconnect','denied']){
   behavior=mode;const before=count,result=await cli.handoff('dlgjob-old')
   assert.equal(result.statusCode,mode==='ok'?200:mode==='denied'?409:503,mode)
   assert.equal(count-before,1,mode);assert.equal(ready,0)
  }
  behavior='ok'
  const mcp=createReceiptMcpTransport({[RECEIPT_MCP_META]:{capability:cap}})!
  const result=await mcp.wait('dlgjob-old',1000)
  assert.equal(result.isError,undefined);assert.equal(result._meta,undefined)
  assert.match(result.content[0]!.text,/交接状态/);assert.ok(!result.content[0]!.text.includes('委派完成'))
 }finally{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k]
  Object.assign(process.env,saved);rmSync(home,{recursive:true,force:true})
 }
})
