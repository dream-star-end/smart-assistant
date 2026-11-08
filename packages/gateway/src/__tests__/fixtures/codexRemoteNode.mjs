// Two actual child processes: native stdout and the independent MCP transport.
import readline from 'node:readline'
const {role,manifest,turns=['turn-fixture'],thread='thread-fixture'} = JSON.parse(process.env.OC_TEST_NODE)
let seq = 0
let turn = 0
const out = v => process.stdout.write(JSON.stringify(v)+'\n')
const wrap = payload => out({version:1,engine:'codex',...manifest,seq:++seq,kind:'stdout',payload})
if (role === 'launch') out({version:1,engine:'codex',...manifest,seq:++seq,kind:'ready'})
else out({...manifest,version:3,engine:'codex',kind:'socket-ready'})
process.on('message',v => { if (role === 'launch') wrap(v); else out(v) })
readline.createInterface({input:process.stdin}).on('line',line => {
 const f=JSON.parse(line)
 process.send?.({received:f})
 if (role !== 'launch') return
 if (f.method === 'thread/start' || f.method === 'thread/resume')
  wrap({id:f.id,result:{model:manifest.model,thread:{id:thread}}})
 else if (f.method === 'turn/start') { const id = turns[Math.min(turn++, turns.length-1)]; wrap({id:f.id,result:{turn:{id}}}); wrap({method:'turn/started',params:{threadId:thread,turn:{id}}}) }
 else if (f.id !== undefined) wrap({id:f.id,result:{}})
})
