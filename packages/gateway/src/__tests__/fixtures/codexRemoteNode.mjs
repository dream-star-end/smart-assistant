// Two actual child processes: native stdout and the independent MCP transport.
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const handshakes = []
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
 if (f.method === 'initialize') {
  handshakes.push(f)
  const check = spawnSync('python3', ['-B', fileURLToPath(new URL('./codexPolicyHandshake.py', import.meta.url))],
    {input: JSON.stringify(handshakes), encoding: 'utf8'})
  if (check.status !== 0) {
   out({version:1,engine:'codex',...manifest,seq:++seq,kind:'error',code:'CODEX_RPC_REJECTED'})
   process.exitCode = 1
   process.stdin.destroy()
   return
  }
 }
 if (f.method === 'thread/start' || f.method === 'thread/resume')
  wrap({id:f.id,result:{model:manifest.model,thread:{id:thread}}})
 else if (f.method === 'turn/start') { const id = turns[Math.min(turn++, turns.length-1)]; wrap({id:f.id,result:{turn:{id}}}); wrap({method:'turn/started',params:{threadId:thread,turn:{id}}}) }
 else if (f.id !== undefined) wrap({id:f.id,result:{}})
})
