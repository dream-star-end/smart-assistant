/** Admin-only commissioning admission. Normal placement/catalog readiness is deliberately unchanged. */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import type { CodexRemoteBinding } from '@openclaude/gateway/remote-finance'
import type { CodexLaneSpec, RemoteCcTarget } from '@openclaude/gateway/codex-commissioning'
import { codexManifestHash, parseCodexExecutionSnapshot, projectCodexRemoteCapabilities } from './codexRemoteProfile.js'
import { remoteNodeExecKeyDir } from './remoteBrainPool.js'
import { admitDispatch } from '../dispatch/turnDispatchStore.js'
export const COMMISSION_MODEL = 'gpt-6-luna-remote'
export const COMMISSION_UPSTREAM = 'gpt-6-luna'
export const controllerSha = () => createHash('sha256').update(readFileSync(new URL('../../../../scripts/agent-remote/codex-host-controller.py',import.meta.url))).digest('hex')
export function requireCommission(value: unknown, reason: string): asserts value { if (!value) throw new Error(`CODEX_COMMISSION_${reason}`) }
export interface CommissionRun {
  version: 1; id: string; adminId: string; profileId: string; nodeId: string; probe: any; account: string
  hostKeyFp: string; previousAuthEpoch: string | null; previousManifest: any; authEpoch: string; expiresAt: number
  binding: CodexRemoteBinding; spec: CodexLaneSpec; target: RemoteCcTarget
  dispatchId: string; requestId: string; ownerId: string; leaseEpoch: number; attemptNo: number
  sentinel: string; content: string; state: 'running' | 'failed' | 'unknown' | 'verified'; revoked?: boolean
}
async function adminContainer(q: Pick<Pool,'query'> | PoolClient, adminId: string) {
  requireCommission(adminId === '3','ADMIN_UID')
  const r=(await q.query(`SELECT c.id::text,c.docker_id,c.docker_name FROM users u JOIN agent_containers c ON c.user_id=u.id
    WHERE u.id=3 AND u.role='admin' AND u.status='active' AND c.status='running' AND c.docker_name='oc-v5-u3'`)).rows
  requireCommission(r.length===1 && /^[a-f0-9]{64}$/.test(r[0].docker_id),'CONTAINER_NOT_RUNNING')
  return r[0]
}
async function profile(q: Pick<Pool,'query'> | PoolClient, id: string, lock=false) {
  const r=(await q.query(`SELECT p.*,n.ssh_host,n.ssh_port,n.ssh_user,n.key_id,n.host_key_fp,n.status AS node_status,n.disabled_by AS node_disabled
    FROM remote_agent_profiles p JOIN remote_agent_nodes n ON n.id=p.node_id WHERE p.id=$1 ${lock?'FOR UPDATE OF p,n':''}`,[id])).rows[0]
  requireCommission(r && r.engine==='codex' && r.runner_mode==='app-server' && r.profile_name==='default' &&
    ['active','degraded'].includes(r.status) && r.disabled_by!=='admin' && ['active','degraded'].includes(r.node_status) && r.node_disabled!=='admin','PROFILE_UNAVAILABLE')
  return r
}
function observed(p: any) {
  const b=p.probe_snapshot,s=parseCodexExecutionSnapshot(b?.execution_snapshot)
  requireCommission(!p.execution_ready && b.probe_schema_version===2 && b.source==='codex-app-server:model/list' &&
    b.freshness==='cli-observed' && b.auth_present===true && b.account_observed===true && b.models_observed===true &&
    !b.error_code && /^[a-f0-9]{64}$/.test(b.snapshot_sha256) && s.controllerSha256===controllerSha(),'PROBE_NOT_ELIGIBLE')
  requireCommission(projectCodexRemoteCapabilities(p,COMMISSION_UPSTREAM).reasoning.supported.includes('low'),'LOW_NOT_OBSERVED')
  return s
}
export async function assertCommissionRun(pool: Pool, run: CommissionRun, timeFence=true): Promise<void> {
  requireCommission(!run.revoked && (!timeFence || run.expiresAt>Date.now()),'EXPIRED_OR_REVOKED')
  const c=await adminContainer(pool,run.adminId)
  requireCommission(c.id===run.binding.containerDbId && c.docker_id===run.binding.dockerId,'CONTAINER_CHANGED')
  const p=await profile(pool,run.profileId); observed(p)
  requireCommission(isDeepStrictEqual(p.probe_snapshot,run.probe) && p.account_fingerprint===run.account &&
    p.auth_epoch===run.previousAuthEpoch && isDeepStrictEqual(p.execution_manifest,run.previousManifest) && String(p.node_id)===run.nodeId &&
    p.host_key_fp===run.hostKeyFp && p.ssh_host===run.target.host && p.ssh_user===run.target.user && Number(p.ssh_port)===run.target.port &&
    join(remoteNodeExecKeyDir(p.key_id),'codex_id_ed25519')===run.target.keyPath,'SNAPSHOT_CHANGED')
  if(timeFence)requireCommission((await pool.query(`SELECT 1 FROM remote_agent_bindings WHERE operation_id=$1 AND generation=1
    AND state IN ('preparing','running') AND expires_at>NOW()`,[run.binding.operationId])).rows.length===1,'LANE_FENCED')
}
export async function admitCommission(pool: Pool, adminId: string, profileId: string): Promise<CommissionRun> {
  requireCommission(process.env.OC_REMOTE_POOL_EXECUTION_ENABLED!=='0','DISABLED')
  const q=await pool.connect()
  try {
    await q.query('BEGIN'); const c=await adminContainer(q,adminId); const p=await profile(q,profileId,true); const s=observed(p)
    const occupied=(await q.query(`SELECT COUNT(*)::int AS n FROM remote_agent_bindings WHERE profile_id=$1 AND state<>'released'`,[profileId])).rows[0].n
    requireCommission(occupied<Number(p.max_concurrent_lanes),'CAPACITY_EXHAUSTED')
    const id=randomUUID(), operationId=randomUUID(), runId=randomUUID(), authEpoch=p.auth_epoch ?? randomUUID()
    const sessionKey=`agent:main:webchat:dm:commission_${id.replaceAll('-','')}`
    const root=`/home/${p.ssh_user}/oc-codexremote-${operationId.replaceAll('-','')}-g1`
    const manifest: CodexLaneSpec['manifest']={version:1,engine:'codex',root,operationId,runId,generation:'1',profileId:p.profile_name,
      authEpoch,model:COMMISSION_UPSTREAM,nativeThreadId:null,codexHome:`/home/${p.ssh_user}/.oc-remote-codex/profiles/default/codex-home`,
      controllerSha256:s.controllerSha256,cliSha256:s.cliSha256,nativeSha256:s.nativeSha256}
    const spec: CodexLaneSpec={controllerPath:`/opt/openclaude/codex-remote/${s.controllerSha256}/codex-host-controller.py`,manifest,modelList:s.modelList,modelCatalog:s.modelCatalog}
    const execDir=remoteNodeExecKeyDir(p.key_id)
    const target: RemoteCcTarget={host:p.ssh_host,port:Number(p.ssh_port),user:p.ssh_user,keyPath:join(execDir,'codex_id_ed25519'),
      knownHostsPath:join(execDir,'known_hosts'),controllerSha256:s.controllerSha256,taskRootPrefix:`/home/${p.ssh_user}/oc-codexremote-`,upstreamModel:COMMISSION_UPSTREAM}
    const expiresAt=Date.now()+10*60_000
    const binding: CodexRemoteBinding={version:3,backendKind:'codex-app-server-v1',uid:'3',containerDbId:c.id,dockerId:c.docker_id,
      operationId,runId,sessionKey,canonicalModel:COMMISSION_MODEL,generation:'1',profileId:'default',authEpoch,
      manifestSha256:codexManifestHash(manifest),capability:randomBytes(32).toString('hex'),expiresAt}
    await q.query(`INSERT INTO remote_agent_bindings(operation_id,run_id,uid,container_db_id,docker_id,session_key,node_id,profile_id,
      canonical_model_id,state,expires_at,engine,backend_kind,generation,auth_epoch,manifest_sha256,recovery_spec,remote_start_attempted)
      VALUES($1,$2,3,$3,$4,$5,$6,$7,$8,'preparing',$9,'codex','codex-app-server-v1',1,$10,$11,$12::jsonb,FALSE)`,
    [operationId,runId,c.id,c.docker_id,sessionKey,p.node_id,profileId,COMMISSION_MODEL,new Date(expiresAt),authEpoch,binding.manifestSha256,
      JSON.stringify({version:1,target,taskRoot:root,operationId,runId,generation:'1',codex:spec,commissioningId:id})])
    const dispatchId=randomUUID(), requestId=`commission-${id}`, ownerId=`commission-${id}`
    // Dedicated commissioning admission, not an impersonated user-chat append. Durable dispatch still owns all billing.
    const d=await admitDispatch(q,{dispatchId,userId:3n,sessionId:sessionKey,clientMessageId:id,agentId:'main',model:COMMISSION_MODEL,
      requestHash:codexManifestHash({kind:'codex-commissioning',id,probe:p.probe_snapshot}),billingRequestId:requestId,ownerId,
      anchorSeq:null,agentContainerId:Number(c.id),runtimeKind:'v5',leaseTtlMs:12*60_000})
    requireCommission(d.kind==='admitted','DISPATCH_REJECTED')
    const run: CommissionRun={version:1,id,adminId,profileId,nodeId:String(p.node_id),probe:p.probe_snapshot,account:p.account_fingerprint,
      hostKeyFp:p.host_key_fp,previousAuthEpoch:p.auth_epoch,previousManifest:p.execution_manifest,authEpoch,expiresAt,binding,spec,target,dispatchId,requestId,ownerId,
      leaseEpoch:d.dispatch.leaseEpoch,attemptNo:d.dispatch.attemptNo,sentinel:`/home/agent/.openclaude/commissioning/${id}/sentinel.txt`,
      content:`OCV5-746 ${randomBytes(32).toString('hex')}\n`,state:'running'}
    await q.query('COMMIT'); return run
  } catch(e) { await q.query('ROLLBACK'); throw e } finally {q.release()}
}
export async function commissionBillingProof(pool: Pool, run: CommissionRun) {
  const r=(await pool.query(`SELECT t.receipt,j.state,u.id::text AS usage_id,u.ledger_id::text,u.cost_credits::text
    FROM remote_native_turns t JOIN request_finalize_journal j ON j.user_id=t.uid AND j.request_id=t.request_id
    JOIN usage_records u ON u.user_id=t.uid AND u.request_id=t.request_id
    WHERE t.uid=3 AND t.operation_id=$1 AND t.request_id=$2`,[run.binding.operationId,run.requestId])).rows
  requireCommission(r.length===1 && r[0].state==='committed' && r[0].receipt.version===3 && r[0].receipt.status==='success' &&
    r[0].receipt.nativeStatus==='completed' && r[0].receipt.usage.outputTokens>0 && BigInt(r[0].cost_credits)>0n && r[0].ledger_id,'BILLING_UNPROVEN')
  return r[0]
}
export function commissionManifest(run: CommissionRun, sha: string) {
  requireCommission(/^[a-f0-9]{64}$/.test(sha),'EVIDENCE_DIGEST')
  return {version:1,backendKind:'codex-app-server-v1',authEpoch:run.authEpoch,snapshotSha256:run.probe.snapshot_sha256,
    controllerSha256:run.spec.manifest.controllerSha256,gatewayRevision:'codex-remote-adapter-v1',e2eReceiptSha256:sha,installed:true,text:true}
}
/** Only the coordinator's private verified package reaches this CAS; no client-provided proof is accepted. */
export async function applyCommission(pool: Pool, run: CommissionRun, sha: string, confirm: boolean) {
  requireCommission(confirm && run.state==='verified' && !run.revoked,'CONFIRM_VERIFIED_REQUIRED')
  await assertCommissionRun(pool,run,false); await commissionBillingProof(pool,run)
  const q=await pool.connect()
  try {
    await q.query('BEGIN'); const p=await profile(q,run.profileId,true); observed(p)
    requireCommission(isDeepStrictEqual(p.probe_snapshot,run.probe) && p.auth_epoch===run.previousAuthEpoch &&
      p.account_fingerprint===run.account && isDeepStrictEqual(p.execution_manifest,run.previousManifest) && p.host_key_fp===run.hostKeyFp &&
      p.ssh_host===run.target.host && p.ssh_user===run.target.user && Number(p.ssh_port)===run.target.port && String(p.node_id)===run.nodeId,'CAS_MISMATCH')
    requireCommission(!(await q.query(`SELECT 1 FROM remote_agent_bindings WHERE profile_id=$1 AND state<>'released'`,[run.profileId])).rows.length,'LANE_BUSY')
    const manifest=commissionManifest(run,sha)
    await q.query(`UPDATE remote_agent_profiles SET execution_ready=TRUE,auth_epoch=$2,execution_manifest=$3::jsonb,updated_at=NOW() WHERE id=$1`,[run.profileId,run.authEpoch,JSON.stringify(manifest)])
    await q.query('COMMIT'); return manifest
  } catch(e) {await q.query('ROLLBACK');throw e} finally{q.release()}
}
export async function revokeCommission(pool: Pool, run: CommissionRun, sha: string, confirm: boolean) {
  requireCommission(confirm,'CONFIRM_REQUIRED'); await adminContainer(pool,run.adminId)
  const q=await pool.connect()
  try {
    await q.query('BEGIN'); const p=(await q.query('SELECT * FROM remote_agent_profiles WHERE id=$1 FOR UPDATE',[run.profileId])).rows[0]
    requireCommission(p && isDeepStrictEqual(p.execution_manifest,commissionManifest(run,sha)),'CAS_MISMATCH')
    // Existing lanes may finish; removing readiness immediately denies every new placement/offer activation.
    await q.query('UPDATE remote_agent_profiles SET execution_ready=FALSE,updated_at=NOW() WHERE id=$1',[run.profileId])
    await q.query('COMMIT'); run.revoked=true
  } catch(e){await q.query('ROLLBACK');throw e} finally{q.release()}
}
