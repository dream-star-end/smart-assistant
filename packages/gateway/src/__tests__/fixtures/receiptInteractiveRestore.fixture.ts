import {loadFullLog} from '../../../../../claude-code-best/src/utils/sessionStorage.js'
import {readdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,basename} from 'node:path'
import assert from 'node:assert/strict'
const dir=process.argv[2]!
const base=join(dir,'config/projects')
const files=readdirSync(base).flatMap(p=>readdirSync(join(base,p)).filter(f=>f.endsWith('.jsonl')).map(f=>join(base,p,f))).filter(p=>readFileSync(p,'utf8').includes('d16_real_pty_shell'))
assert.equal(files.length,1,'exact private interactive main transcript')
const sessionId=basename(files[0]!,'.jsonl')
const restored=await loadFullLog({isLite:true,sessionId,fullPath:files[0]!,messages:[],date:'',value:0,created:new Date(),modified:new Date(),firstPrompt:'',messageCount:3,isSidechain:false})
const contents=restored.messages.flatMap((m:any)=>m.type==='user'?(Array.isArray(m.message.content)?m.message.content:[{type:'text',text:m.message.content}]):[])
const bash=contents.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='d16_real_pty_shell')
const notes=contents.filter((c:any)=>c.type==='text'&&c.text.includes('<task-notification>'))
const reads=contents.filter((c:any)=>c.type==='tool_result'&&c.tool_use_id==='d16_real_output_read')
if(process.argv[3]==='unowned'){
 assert.equal(bash.length,1);assert.match(JSON.stringify(bash),/receipt invocation rejected \(409\)/);assert.equal(bash[0].is_error,true);assert.equal(notes.length,0);assert.equal(reads.length,0);console.log(JSON.stringify({passed:true,sessionId,bashResults:1,failedNotifications:0,outputReadResults:0,receiptInputs:0}));process.exit(0)
}
assert.equal(bash.length,1);assert.match(JSON.stringify(bash),/manually backgrounded by user/)
assert.equal(notes.length,1);assert.match(JSON.stringify(notes),/<status>failed<\/status>/);assert.match(JSON.stringify(notes),/exit code 7/)
assert.equal(reads.length,1);assert.match(JSON.stringify(reads),/D16_REAL_PTY_ORDINARY_STDOUT/);assert.match(JSON.stringify(reads),/D16_REAL_PTY_ORDINARY_STDERR/)
const final=JSON.parse(readFileSync(join(dir,'requests.json'),'utf8')).filter((r:any)=>r.main).at(-1).body.messages
const user=final.flatMap((m:any)=>m.role==='user'&&Array.isArray(m.content)?m.content:[])
for(const id of ['d16_real_pty_shell','d16_real_output_read'])assert.deepEqual(contents.find((c:any)=>c.type==='tool_result'&&c.tool_use_id===id).content,user.find((c:any)=>c.type==='tool_result'&&c.tool_use_id===id).content)
const evidence={passed:true,sessionId,restoredMessages:restored.messages.length,bashResults:bash.length,failedNotifications:notes.length,outputReadResults:reads.length,receiptInputs:0,boundary:'ordinary fullPTY CLI compatibility; no receipt owner registered'}
writeFileSync(join(dir,'fresh-bun-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
