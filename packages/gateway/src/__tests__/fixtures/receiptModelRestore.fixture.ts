import {loadFullLog} from '../../../../../claude-code-best/src/utils/sessionStorage.js'
import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const dir=process.argv[2]!,mode=process.argv[3]!
const evidence=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'))
const projects=join(dir,'native/projects')
const files=readdirSync(projects).flatMap(p=>readdirSync(join(projects,p)).filter(f=>f===evidence.nativeSession+'.jsonl').map(f=>join(projects,p,f)))
assert.equal(files.length,1)
const restored=await loadFullLog({isLite:true,sessionId:evidence.nativeSession,fullPath:files[0]!,messages:[],date:'',value:0,created:new Date(),modified:new Date(),firstPrompt:'',messageCount:3,isSidechain:false})
const matching=restored.messages.filter((m:any)=>m.type==='user'&&JSON.stringify(m.message).includes('REAL_MODEL_CLI_AUTHORITATIVE_RESULT'))
assert.equal(matching.length,mode==='stop'?0:1)
if(mode!=='stop') {
 assert.ok((matching[0] as any).delegateReceipt)
 const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
 const actualContent=(matching[0] as any).message.content[0].content
 const modelResult=modelMessages.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content:[]).find((c:any)=>c.type==='tool_result'&&c.tool_use_id===(mode==='wait'?'real_waiter':'real_creator'))
 assert.ok(modelResult);assert.deepEqual(actualContent,modelResult.content)
 assert.equal((matching[0] as any).message.content[0].tool_use_id,mode==='wait'?'real_waiter':'real_creator')
}
process.stdout.write(JSON.stringify({mode,nativeSession:evidence.nativeSession,restoredMessageCount:restored.messages.length,receiptInputs:matching.length,passed:true})+"\n")
