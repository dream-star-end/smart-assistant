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
assert.equal(matching.length,2)
const modelMessages=JSON.parse(readFileSync(join(dir,'model-final-messages.json'),'utf8'))
for (const message of matching as any[]) {
 assert.ok(message.delegateReceipt)
 assert.equal(message.message.content[0].type,'text')
 assert.ok(modelMessages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).some((c:any)=>c.type==='text'&&c.text.includes(message.message.content[0].text)))
}
const rows=JSON.parse(readFileSync(join(dir,'receipt-rows.json'),'utf8'))
assert.equal(new Set(matching.map((m:any)=>m.delegateReceipt.jobId)).size,2)
for (const row of rows) {
 assert.equal(row.state,'ingested');assert.equal(row.native_tool_use_id,'real_creator')
 assert.equal(matching.filter((m:any)=>m.delegateReceipt.jobId===row.job_id).length,1)
}
const ordinary=restored.messages.filter((m:any)=>m.type==='user'&&Array.isArray(m.message.content)&&m.message.content.some((c:any)=>c.type==='tool_result'))
assert.equal(ordinary.length,mode==='wait'?2:1)
assert.ok(JSON.stringify(ordinary).includes('ORDINARY_SHELL_STDOUT'))
assert.ok(JSON.stringify(ordinary).includes('ORDINARY_SHELL_STDERR'))
process.stdout.write(JSON.stringify({mode,passed:true,receiptInputs:matching.length,ordinaryResults:ordinary.length})+'\n')
