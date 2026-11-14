// Two actual child processes: native stdout and the independent MCP transport.
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const handshakes = []
const {role,manifest,turns=['turn-fixture'],thread='thread-fixture',rejectUnsubscribe=false,inflateUsageReplay=false} = JSON.parse(process.env.OC_TEST_NODE)
let seq = 0
let turn = 0
let loaded = false
let effective
const out = v => process.stdout.write(JSON.stringify(v)+'\n')
const wrap = payload => out({version:1,engine:'codex',...manifest,seq:++seq,kind:'stdout',payload})
if (role === 'launch') out({version:1,engine:'codex',...manifest,seq:++seq,kind:'ready'})
else out({...manifest,version:3,engine:'codex',kind:'socket-ready'})
let lastUsage
process.on('message',v => {
 if (v?.method === 'thread/tokenUsage/updated') lastUsage = v.params
 if (role === 'launch') wrap(v); else out(v)
})
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
 // Native 0.167.0 semantics (verified on the real binary): instructions are read only when the
 // thread is loaded; a resume of a loaded thread keeps the old ones until it is unloaded.
 if (f.method === 'thread/start' || f.method === 'thread/resume') {
  const warm = loaded
  if (!loaded) { effective = f.params?.baseInstructions ?? effective; loaded = true }
  wrap({id:f.id,result:{model:manifest.model,thread:{id:thread}}})
  // 0.167.0 (seen live on the node) re-emits the thread's last cumulative usage after a warm resume.
  if (warm && f.method === 'thread/resume' && lastUsage) {
   const total = {...lastUsage.tokenUsage.total}
   if (inflateUsageReplay) { total.inputTokens += 1; total.totalTokens += 1 }
   wrap({method:'thread/tokenUsage/updated',params:{...lastUsage,tokenUsage:{...lastUsage.tokenUsage,total}}})
  }
 }
 else if (f.method === 'thread/unsubscribe' && rejectUnsubscribe) {
  // An older node controller: the RPC is not on its allow-list.
  wrap({id:f.id,error:{code:-32600,message:'CODEX_RPC_REJECTED'}})
 }
 else if (f.method === 'thread/unsubscribe') {
  wrap({id:f.id,result:{status: loaded ? 'unsubscribed' : 'notLoaded'}})
  if (loaded) { loaded = false; wrap({method:'thread/status/changed',params:{threadId:thread,status:{type:'notLoaded'}}}); wrap({method:'thread/closed',params:{threadId:thread}}) }
 }
 else if (f.method === 'turn/start') { process.send?.({effectiveInstructions: effective ?? null}); const id = turns[Math.min(turn++, turns.length-1)]; wrap({id:f.id,result:{turn:{id}}}); wrap({method:'turn/started',params:{threadId:thread,turn:{id}}}) }
 else if (f.id !== undefined) wrap({id:f.id,result:{}})
})
