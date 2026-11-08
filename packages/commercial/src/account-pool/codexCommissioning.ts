/** Live master coordinator. No fake host/finance/receipt injection exists on this production path. */
import { spawn,execFile } from 'node:child_process'
import { promisify,isDeepStrictEqual } from 'node:util'
import { once } from 'node:events'
import { readFileSync,lstatSync,realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { CodexSshHost,CodexRemoteRelay,commissioningLines } from '@openclaude/gateway/codex-commissioning'
import { codexBackend } from '@openclaude/gateway/remote-finance'
import type { Pool } from 'pg'
import type { AuthoritySigner } from '../ws/authoritySigner.js'
import type { RemoteNativeTurnFinanceDeps } from '../billing/remoteNativeTurnBilling.js'
import { createRemoteNativeTurnFinance } from '../billing/remoteNativeTurnBilling.js'
import { bindAuthorityTurnDispatch } from '../billing/verificationSponsorship.js'
import { casToTerminal, heartbeatLease } from '../dispatch/turnDispatchStore.js'
import { recordRemoteLaneState, recordRemoteStartAttempt, recordRemoteNativeThread } from './remoteBrainPool.js'
import { CommissionEvidence,evidenceHash } from './codexCommissioningEvidence.js'
import { commissionCatalog } from './codexCommissioningCatalog.js'
import { admitCommission,assertCommissionRun,applyCommission,revokeCommission,commissionBillingProof,commissionManifest,
  requireCommission,COMMISSION_MODEL,type CommissionRun } from './codexCommissioningStore.js'
const exec=promisify(execFile)
const CODE_ROOT=fileURLToPath(new URL('../../../../',import.meta.url))
const WORKER='packages/gateway/dist/codexCommissioningWorker.js'
const PINNED=[WORKER,'packages/gateway/dist/codexRemoteLane.js','packages/gateway/dist/codexRemoteTransport.js',
  'packages/gateway/dist/engine/codexAdapter.js','packages/gateway/dist/cc5ToolHost.js','packages/gateway/dist/codexCommissioningWire.js',
  'scripts/agent-remote/cc5-toolhost-supervisor.py','scripts/ocv5-289/box_keeper.py','claude-code-best/dist/cli-node.js']
export interface CommissionDeps extends Omit<RemoteNativeTurnFinanceDeps,'upstreamModel'> { signer:AuthoritySigner }
async function docker(args:string[],maxBuffer=4*1024*1024){return (await exec('/usr/bin/docker',args,{timeout:30000,maxBuffer})).stdout}
async function proveRuntime(run:CommissionRun){
  const info=JSON.parse(await docker(['inspect',run.binding.dockerId]))[0]
  requireCommission(info?.Id===run.binding.dockerId && info.Name==='/oc-v5-u3' && info.State?.Running &&
    info.Mounts?.some((m:any)=>m.Destination==='/opt/openclaude' && m.RW===false),'RUNTIME_IDENTITY')
  const mount=info.Mounts.find((m:any)=>m.Destination==='/opt/openclaude')
  requireCommission(typeof mount.Source==='string' && realpathSync(mount.Source)===mount.Source,'RUNTIME_MOUNT')
  // Runtime compilation happens in the official immutable source-release, not in the master checkout.
  for(let path=mount.Source;path!=='/';path=join(path,'..')){const st=lstatSync(path);requireCommission(st.isDirectory()&&st.uid===0&&!(st.mode&0o022),'RUNTIME_OWNER')}
  const manifest=JSON.parse(readFileSync(join(mount.Source,'MANIFEST.json'),'utf8'))
  const expected=Object.fromEntries(PINNED.map(name=>{
    const record=manifest.files?.find((f:any)=>f.path===name),actual=evidenceHash(readFileSync(join(mount.Source,name)))
    requireCommission(record?.sha256===actual,'RUNTIME_MANIFEST')
    // Compare source semantics to this master before using the corresponding precompiled module.
    if(name.includes('/dist/')){
      const source=name.replace('/dist/','/src/').replace(/\.js$/,'.ts')
      if(name!== 'claude-code-best/dist/cli-node.js')requireCommission(evidenceHash(readFileSync(join(CODE_ROOT,source)))===evidenceHash(readFileSync(join(mount.Source,source))),'RUNTIME_REBUILD_REQUIRED')
    }else requireCommission(evidenceHash(readFileSync(join(CODE_ROOT,name)))===actual,'RUNTIME_REBUILD_REQUIRED')
    return [name,actual]
  }))
  const script="import hashlib,json,pathlib,sys; files=json.loads(sys.argv[1]);print(json.dumps({p:hashlib.sha256((pathlib.Path('/opt/openclaude')/p).read_bytes()).hexdigest() for p in files}))"
  const actual=JSON.parse(await docker(['exec','--user','1000',run.binding.dockerId,'/usr/bin/python3','-I','-B','-c',script,JSON.stringify(PINNED)]))
  requireCommission(isDeepStrictEqual(actual,expected),'RUNTIME_REBUILD_REQUIRED');return expected
}
async function proveContainer(run:CommissionRun,result:any){
  requireCommission(result?.calls===1 && result.proofs?.length===1,'LOCAL_PROOF_MISSING')
  const p=result.proofs[0],base=`/home/agent/.openclaude/commissioning/${run.id}/tools/`
  requireCommission(typeof p.root==='string' && p.root.startsWith(base) && !p.root.includes('..') && /^[a-f0-9-]{36}$/.test(p.lifecycleId),'LOCAL_PROOF_SCOPE')
  // Independent docker exec reads the actual marker + supervisor proof and checks that supervisor exited.
  const script=`import json,os,pathlib,stat,sys
marker,content,root,life=sys.argv[1:]
p=pathlib.Path(root)/'stopped.json'; s=p.lstat()
assert stat.S_ISREG(s.st_mode) and s.st_uid==1000 and s.st_nlink==1 and not s.st_mode&0o077
v=json.loads(p.read_text()); assert v['version']==1 and v['lifecycleId']==life and v['localStopped'] is True
assert not pathlib.Path('/proc/'+str(v['supervisorPid'])).exists()
f=pathlib.Path(marker); s=f.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_uid==1000 and s.st_nlink==1 and f.read_text()==content
print(json.dumps({'sentinel':marker,'proof':v,'independentDockerRead':True}))`
  const proof=JSON.parse(await docker(['exec','--user','1000',run.binding.dockerId,'/usr/bin/python3','-I','-B','-c',script,run.sentinel,run.content,p.root,p.lifecycleId]))
  requireCommission(isDeepStrictEqual(proof.proof,p.proof),'LOCAL_PROOF_CHANGED');return proof
}
function relayCall(socketPath:string,path:string,body:string):Promise<{status:number;body:string}>{
  requireCommission(/^\/(?:admit|rpc|poll|baseline|tool\/next|tool\/result|tool\/ack|tool\/stopped|stop|renew|abandon)$/.test(path),'CONTROL_PATH')
  requireCommission(Buffer.byteLength(body)<=2*1024*1024,'CONTROL_BODY')
  return new Promise((resolve,reject)=>{
    const req=request({socketPath,path,method:'POST',headers:{'content-length':Buffer.byteLength(body)}},res=>{
      let data='';res.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>2*1024*1024)req.destroy(new Error('COMMISSION_RESPONSE_LIMIT'))})
      res.on('end',()=>resolve({status:res.statusCode??500,body:data}));res.on('error',reject)
    });req.on('error',reject);req.setTimeout(60000,()=>req.destroy(new Error('COMMISSION_RELAY_TIMEOUT')));req.end(body)
  })
}
export class CodexCommissioning {
  private readonly evidence:CommissionEvidence
  private readonly active=new Map<string,CommissionRun>()
  constructor(private readonly deps:CommissionDeps,root='/var/lib/openclaude/remote-native/commissioning') {this.evidence=new CommissionEvidence(root)}
  async start(adminId:string,profileId:string){
    const run=await admitCommission(this.deps.pool,adminId,profileId)
    // If disk persistence fails, DB binding remains occupied, never guessed released.
    this.evidence.create(run.id);this.evidence.write(run.id,'run.json',run);this.active.set(run.id,run)
    void this.execute(run).catch(()=>{}).finally(()=>this.active.delete(run.id))
    return {id:run.id,state:run.state,requestId:run.requestId,sessionKey:run.binding.sessionKey,expiresAt:run.expiresAt}
  }
  status(id:string){const run=this.evidence.read(id,'run.json') as CommissionRun
    return {id,state:run.state==='running'&&!this.active.has(id)?'unknown':run.state,revoked:!!run.revoked,requestId:run.requestId,
      profileId:run.profileId,sessionKey:run.binding.sessionKey}}
  artifact(id:string){const run=this.evidence.read(id,'run.json') as CommissionRun;requireCommission(run.state==='verified','NOT_VERIFIED')
    const packet=this.evidence.read(id,'artifact.json'),sha=evidenceHash(JSON.stringify(packet))
    requireCommission(isDeepStrictEqual(packet.frames,this.evidence.frames(id)),'EVIDENCE_CHANGED')
    return {e2eReceiptSha256:sha,execution_manifest:commissionManifest(run,sha),packet}}
  async apply(id:string,sha:string,confirm:boolean){
    const run=this.evidence.read(id,'run.json') as CommissionRun,artifact=this.artifact(id)
    requireCommission(artifact.e2eReceiptSha256===sha,'EVIDENCE_CHANGED')
    requireCommission(isDeepStrictEqual(await commissionBillingProof(this.deps.pool,run),artifact.packet.billing),'BILLING_CHANGED')
    return applyCommission(this.deps.pool,run,sha,confirm)
  }
  async revoke(id:string,sha:string,confirm:boolean){
    const run=this.evidence.read(id,'run.json') as CommissionRun;requireCommission(this.artifact(id).e2eReceiptSha256===sha,'EVIDENCE_CHANGED')
    await revokeCommission(this.deps.pool,run,sha,confirm);this.evidence.write(id,'run.json',run,true);return {ready:false}
  }
  private async execute(run:CommissionRun){
    let relay:CodexRemoteRelay|undefined,child:ReturnType<typeof spawn>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined
    let fail:(e:Error)=>void=()=>{}
    try {
      const runtime=await proveRuntime(run)
      const catalog=commissionCatalog(this.deps.catalog,this.deps.loadUserModelAuthz,run,()=>assertCommissionRun(this.deps.pool,run))
      const snapshot=await catalog.assertFresh(),d=snapshot.resolve(COMMISSION_MODEL)!
      const signed=this.deps.signer.signBundle({uid:3,containerId:Number(run.binding.containerDbId),connectionChallenge:`commission-${run.id}`,
        canonicalModel:COMMISSION_MODEL,engine:'codex',auxModels:[],executionRevision:snapshot.executionRevision,securityEpoch:Number(snapshot.securityEpoch),
        billingRequestId:run.requestId,executionBackend:codexBackend(run.binding),executionDescriptor:{capabilityProfile:d.capabilityProfile as any,
          capabilitySchemaVersion:d.capabilitySchemaVersion,contextWindow:d.contextWindow,supportedEfforts:[...d.capabilityProfile.reasoning.supported],
          ...(d.capabilityProfile.reasoning.codexModelDefault===null?{}:{codexDefaultEffort:d.capabilityProfile.reasoning.codexModelDefault}),supportsVision:false}}, {leaseTtlMs:10*60_000})
      await bindAuthorityTurnDispatch(this.deps.pool,{authorityTurnId:signed.payload.authorityTurnId,dispatchId:run.dispatchId,userId:3n,
        sessionId:run.binding.sessionKey,dispatchModel:COMMISSION_MODEL,canonicalModel:COMMISSION_MODEL,attemptNo:run.attemptNo,
        ownerId:run.ownerId,leaseEpoch:run.leaseEpoch,agentContainerId:Number(run.binding.containerDbId),runtimeKind:'v5'})
      const host=new CodexSshHost(run.target,run.spec)
      const preflight=await host.preflight();requireCommission(preflight.memoryOk,preflight.code??'NODE_MEMORY')
      await recordRemoteLaneState(run.binding.operationId,'running',this.deps.pool,'1')
      const rawFrames:Array<{channel:string;sha256:string;bytes:number}>=[]
      relay=new CodexRemoteRelay(run.binding,this.deps.signer.publicKeyring(),host,run.spec,join(this.evidence.dir(run.id),'relay'),
        createRemoteNativeTurnFinance({...this.deps,catalog,upstreamModel:'gpt-6-luna'}),
        id=>recordRemoteNativeThread(run.binding.operationId,'1',id,this.deps.pool),
        ()=>recordRemoteStartAttempt(run.binding.operationId,'1',this.deps.pool),
        (channel,frame)=>{requireCommission(rawFrames.length<100000,'FRAME_LIMIT');const raw=JSON.stringify(frame);rawFrames.push({channel,sha256:evidenceHash(raw),bytes:Buffer.byteLength(raw)})})
      // Short Unix path: root evidence path + UUID can exceed sockaddr_un's 108 byte bound.
      const socket=join('/run',`oc-cm-${run.id}.sock`)
      relay.controlServer.listen(socket);await once(relay.controlServer,'listening')
      const proc=spawn('/usr/bin/docker',['exec','-i','--user','1000',run.binding.dockerId,'/usr/local/bin/node','--conditions=openclaude-precompiled',`/opt/openclaude/${WORKER}`],{stdio:['pipe','pipe','pipe']});child=proc
      proc.stderr.resume() // Never persist arbitrary engine diagnostics/credential-bearing logs.
      let done:any, seq=0,inflight=0,failed=false
      const finished=new Promise<any>((resolve,reject)=>{
        fail=e=>{if(!failed){failed=true;run.revoked=true;reject(e);proc.stdin.destroy();proc.kill('SIGTERM');void relay?.stop().catch(()=>{})}}
        commissioningLines(proc.stdout,v=>{
          requireCommission(!done,'AFTER_DONE')
          if(v.kind==='done'){done=v;return}
          requireCommission(v.kind==='request' && v.id===++seq && inflight<8 && typeof v.body==='string','WORKER_FRAME')
          inflight++;void relayCall(socket,v.path,v.body).then(r=>{if(!failed)proc.stdin.write(JSON.stringify({kind:'response',id:v.id,...r})+'\n')},fail).finally(()=>{inflight--})
        },e=>{if(!done)fail(e)})
        proc.once('error',fail);proc.once('close',code=>{if(code===0&&done&&!failed)resolve(done);else fail(new Error('CODEX_COMMISSION_WORKER_EXIT_UNKNOWN'))})
      })
      const timer=setTimeout(()=>fail(new Error('CODEX_COMMISSION_TIMEOUT')),10*60_000)
      heartbeat=setInterval(()=>{void heartbeatLease(this.deps.pool,{dispatchId:run.dispatchId,ownerId:run.ownerId,leaseEpoch:run.leaseEpoch})
        .then(ok=>{if(!ok)fail(new Error('CODEX_COMMISSION_DISPATCH_FENCED'))},fail)},25000)
      const turnKey=randomBytes(32).toString('hex')
      proc.stdin.write(JSON.stringify({kind:'init',binding:run.binding,requestId:run.requestId,turnKey,sentinel:run.sentinel,content:run.content,
        authority:signed.bundle.authority,lease:signed.bundle.lease,contextWindow:d.contextWindow,
        keyring:[...this.deps.signer.publicKeyring()].map(([id,key])=>[id,Buffer.from(key).toString('base64')])})+'\n')
      const result=await finished.finally(()=>clearTimeout(timer))
      await relay.stop();const stopProof=host.verifiedStopEvidence as {fence?:{scopes?:unknown[]};proof?:{scopes?:unknown[]}} | undefined
      requireCommission(stopProof?.fence?.scopes?.length===2 && stopProof.proof?.scopes?.length===2,'NODE_PROOF_MISSING')
      const local=await proveContainer(run,result),billing=await commissionBillingProof(this.deps.pool,run)
      await assertCommissionRun(this.deps.pool,run)
      const artifact={version:1,kind:'codex-live-commissioning',id:run.id,createdAt:new Date().toISOString(),model:COMMISSION_MODEL,effort:'low',
        probe:run.probe,account:run.account,previousAuthEpoch:run.previousAuthEpoch,authEpoch:run.authEpoch,controller:run.spec.manifest.controllerSha256,
        runtime,rawFrames,frames:this.evidence.frames(run.id),billing,nodeProof:host.verifiedStopEvidence,localProof:local,worker:{exitCode:0,calls:result.calls}}
      this.evidence.write(run.id,'artifact.json',artifact)
      await recordRemoteLaneState(run.binding.operationId,'released',this.deps.pool,'1')
      const terminal=await casToTerminal(this.deps.pool,{dispatchId:run.dispatchId,expectedEpoch:run.leaseEpoch,outcome:'completed'})
      requireCommission(terminal,'DISPATCH_TERMINAL_FAILED');run.state='verified'
      this.evidence.write(run.id,'run.json',run,true)
    }catch(e){
      run.revoked=true;run.state='unknown'
      await recordRemoteLaneState(run.binding.operationId,'unknown',this.deps.pool,'1').catch(()=>{})
      this.evidence.write(run.id,'failure.json',{code:e instanceof Error && /^CODEX_[A-Z_]+$/.test(e.message)?e.message:'CODEX_COMMISSION_UNKNOWN'})
      this.evidence.write(run.id,'run.json',run,true)
      // No terminal/slot release without both proofs. Recovery requires the existing formal reconciler.
      throw e
    }finally{
      clearInterval(heartbeat);child?.stdin?.destroy();child?.kill('SIGTERM')
      await relay?.stop().catch(()=>{});relay?.controlServer.close();relay?.toolServer.close()
    }
  }
}
