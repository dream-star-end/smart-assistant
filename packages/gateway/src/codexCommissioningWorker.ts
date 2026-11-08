/** Fixed one-turn admin commissioning worker. Only run through the master coordinator. */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { CodexRemoteAdapter } from './engine/codexAdapter.js'
import type { EngineCreateOpts } from './engine/registry.js'
import { Cc5ToolHost } from './cc5ToolHost.js'
import { codexBackend, codexNeed } from './codexRemoteContract.js'
import { commissioningLines } from './codexCommissioningWire.js'

// Engine logs cannot enter the control stream. Protocol owns the original stdout writer.
const rawWrite=process.stdout.write.bind(process.stdout)
process.stdout.write=process.stderr.write.bind(process.stderr) as typeof process.stdout.write
const emit=(v:unknown)=>rawWrite(JSON.stringify(v)+'\n')
let initResolve!: (v:any)=>void
const initial=new Promise<any>(resolve=>{initResolve=resolve})
const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>()
let initialized=false,seq=0
commissioningLines(process.stdin,v=>{
  if(!initialized){codexNeed(v.kind==='init'); initialized=true;initResolve(v);return}
  codexNeed(v.kind==='response' && Number.isSafeInteger(v.id) && pending.has(v.id))
  const p=pending.get(v.id)!;pending.delete(v.id); p.resolve(v)
},()=>{for(const p of pending.values())p.reject(new Error('COMMISSION_STDIO_CLOSED'));void adapter?.shutdown().finally(()=>process.exit(1))})
let adapter:CodexRemoteAdapter|undefined
async function main() {
  const v=await initial, b=v.binding
  codexNeed(process.getuid?.()===1000 && b.uid==='3' && b.canonicalModel==='gpt-6-luna-remote' &&
    /^\/home\/agent\/\.openclaude\/commissioning\/[a-f0-9-]{36}\/sentinel\.txt$/.test(v.sentinel))
  const cwd=dirname(v.sentinel);mkdirSync(cwd,{recursive:true,mode:0o700})
  const socket=join(cwd,'relay.sock')
  const server=createServer(async(req,res)=>{
    try {
      codexNeed(req.method==='POST' && pending.size<8)
      const chunks:Buffer[]=[];let bytes=0
      for await(const chunk of req){bytes+=chunk.length;codexNeed(bytes<=2*1024*1024);chunks.push(chunk)}
      const id=++seq
      const answer=new Promise<any>((resolve,reject)=>{pending.set(id,{resolve,reject})})
      emit({kind:'request',id,path:req.url,body:Buffer.concat(chunks).toString('utf8')})
      const r=await answer;res.writeHead(r.status,{'content-type':'application/json'});res.end(r.body)
    }catch{res.writeHead(503);res.end('{}')}
  })
  server.listen(socket);await once(server,'listening')
  let calls=0;const proofs:Array<{root:string;lifecycleId:string;proof:unknown}>=[]
  const keys=new Map<string,Uint8Array>(v.keyring.map(([id,key]:[string,string])=>[id,Buffer.from(key,'base64')]))
  adapter=new CodexRemoteAdapter({sessionKey:b.sessionKey,agentId:'main',agentBaseDir:cwd,model:b.canonicalModel,effortLevel:'low',
    executionBackend:codexBackend(b),config:{version:1,gateway:{bind:'127.0.0.1',port:9,accessToken:'commissioning-not-an-api-token'},
      auth:{mode:'subscription',claudeCodePath:''},channels:{webchat:{enabled:false}},sessions:{dbPath:''},
      defaults:{model:b.canonicalModel,permissionMode:'bypassPermissions'}}} as EngineCreateOpts,
  {binding:b,socketPath:socket,keyring:keys,executionRoot:join(cwd,'tools'),
    // No rolling lease: a one-shot run is hard bounded by its ten-minute admission.
    renewLease:async()=>{throw new Error('COMMISSION_LEASE_NOT_RENEWABLE')},
    hostFactory:(root,lifecycleId,profile,env)=>{
      const host=new Cc5ToolHost(root,lifecycleId,{...profile,mcpConfigPath:null,settingsPath:null},async()=>{throw new Error('COMMISSION_PERMISSION_DENIED')},env)
      return {tools:async()=>{const tools=(await host.tools()).filter(t=>t.name==='Write');codexNeed(tools.length===1);return tools},
        execute:async(name,args,identity)=>{codexNeed(calls===0 && name==='Write' && isDeepStrictEqual(args,{file_path:v.sentinel,content:v.content}));calls++
          return host.execute(name,args,identity)},
        close:async()=>{await host.close();proofs.push({root,lifecycleId,proof:JSON.parse(readFileSync(join(root,'stopped.json'),'utf8'))})}}
    }})
  adapter.on('error',()=>{})
  const timeout=setTimeout(()=>{void adapter!.shutdown().finally(()=>process.exit(1))},9*60_000)
  try {
    const run=adapter.submitTurn({input:`Commissioning test. Use mcp__ocbridge__Write exactly once with this exact JSON: ${JSON.stringify({file_path:v.sentinel,content:v.content})}. Then reply only COMMISSION_OK. Do not use other tools.`,
      requestId:v.requestId,turnKey:v.turnKey,onEvent:()=>{},sessionTotals:{totalCostUSD:0,turns:0},toolUseIdToName:new Map(),
      modelAuthority:{authorityEnvelope:v.authority,leaseEnvelope:v.lease,executionDescriptor:{executionBackend:codexBackend(b),
        canonicalModel:b.canonicalModel,contextWindow:v.contextWindow,capabilityZero:false,supportsThinking:false,supportsVision:false,supportedEfforts:['low']}}})
    const summary=await run.summary
    codexNeed(summary && !summary.isError && calls===1 && readFileSync(v.sentinel,'utf8')===v.content,'COMMISSION_EFFECT_UNPROVEN')
    await adapter.shutdown();codexNeed(proofs.length===1)
    emit({kind:'done',calls,proofs,summary:{isError:summary.isError,usage:summary.usage}})
  } finally {clearTimeout(timeout);await adapter.shutdown();server.close();process.stdin.destroy()}
}
void main().then(()=>process.exit(0),()=>{emit({kind:'failed'});process.exit(1)})
