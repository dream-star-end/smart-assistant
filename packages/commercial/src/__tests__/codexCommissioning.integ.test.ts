/** Real octest PG admission/CAS and settlement. No production DB or node is contacted. */
import assert from 'node:assert/strict'
import { before,after,test } from 'node:test'
import { Pool } from 'pg'
import { generateKeyPairSync,randomUUID,sign } from 'node:crypto'
import { authoritySigningInput,encodeAuthorityEnvelope,encodeTurnLeaseEnvelope,turnLeaseSigningInput,type ModelAuthorityPayload,type TurnLease } from '@openclaude/protocol'
import { codexBackend,buildCodexReceipt,zeroNativeTokens } from '@openclaude/gateway/remote-finance'
import { setPoolOverride,closePool } from '../db/index.js'
import { resetAndMigrateBefore } from './helpers/db.js'
import { runMigrations } from '../db/migrate.js'
import { admitCommission,applyCommission,assertCommissionRun,revokeCommission,commissionBillingProof,controllerSha,COMMISSION_MODEL,type CommissionRun } from '../account-pool/codexCommissioningStore.js'
import { makeAdminCommissionContainerSource } from '../account-pool/codexCommissioningContainer.js'
import type { V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { commissionCatalog } from '../account-pool/codexCommissioningCatalog.js'
import { placeRemoteLane,recordRemoteLaneState } from '../account-pool/remoteBrainPool.js'
import { ModelCatalogSnapshot,type ModelCatalogEntry } from '../billing/modelCatalog.js'
import { createRemoteNativeTurnFinance } from '../billing/remoteNativeTurnBilling.js'
import { bindAuthorityTurnDispatch } from '../billing/verificationSponsorship.js'
import { createLogger } from '../logging/logger.js'
import Redis from 'ioredis'
import { wrapIoredisForPreCheck } from '../billing/preCheck.js'
const url=process.env.TEST_DATABASE_URL
assert.ok(url&&new URL(url).pathname.endsWith('_test'),'explicit isolated TEST_DATABASE_URL required')
const pool=new Pool({connectionString:url,max:8,connectionTimeoutMillis:2000})
const redis=new Redis(process.env.TEST_REDIS_URL??'redis://127.0.0.1:56379',{maxRetriesPerRequest:1,lazyConnect:true})
let profileId:string
// Selfhost runs the v5 channel; getV3ContainerStatus filters agent_containers by it.
process.env.OC_RUNTIME_CHANNEL='v5'
let dockerRunning=true
// Minimal dockerode stand-in: getV3ContainerStatus only reads inspect().State.Running for the
// state and optional image/labels for staleness; absent fields stay undefined.
const docker={getContainer:(id:string)=>({inspect:async()=>({Id:id,State:{Running:dockerRunning},Config:{Image:'fixture'},
  Image:'sha256:fixture',Mounts:[],HostConfig:{}})})}
const container=makeAdminCommissionContainerSource({pool,docker} as unknown as V3SupervisorDeps)
const probe={probe_schema_version:2,source:'codex-app-server:model/list',freshness:'cli-observed',auth_present:true,account_observed:true,models_observed:true,
  snapshot_sha256:'c'.repeat(64),execution_snapshot:{version:1,controllerSha256:controllerSha(),cliSha256:'a'.repeat(64),nativeSha256:'b'.repeat(64),
    modelList:[{model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],modelCatalog:{models:[{slug:'gpt-6-luna'}]}}}
before(async()=>{
  assert.match((await pool.query('SELECT current_database() AS db')).rows[0].db,/_test$/);setPoolOverride(pool)
  await resetAndMigrateBefore('0334');await runMigrations();await redis.connect()
  await pool.query(`INSERT INTO users(id,email,password_hash,credits,role) VALUES(3,'commission746@example.test','test-only',100000,'admin')`)
  // Real selfhost v5 shape: the provisioner writes the v3 identity columns only
  // (state/container_internal_id); the v2 status/docker_id columns keep their defaults
  // ('provisioning' / NULL). The pre-fix gate read exactly those v2 columns and could
  // never admit this row.
  await pool.query(`INSERT INTO agent_containers(id,user_id,secret_hash,bound_ip,port,container_internal_id,state,runtime_channel,runtime_kind)
    VALUES(7,3,$1,'172.30.0.7',3000,$2,'active','v5','docker')`,[Buffer.alloc(32,1),'a'.repeat(64)])
  const n=(await pool.query(`INSERT INTO remote_agent_nodes(label,ssh_host,ssh_user,host_key_fp,key_id,controller_sha256,status)
    VALUES('commission-test','fixture.invalid','box','SHA256:fixture','fixture','fixture','active') RETURNING id`)).rows[0].id
  profileId=(await pool.query(`INSERT INTO remote_agent_profiles(node_id,engine,profile_name,account_fingerprint,runner_mode,probe_snapshot)
    VALUES($1,'codex','default','same-account','app-server',$2::jsonb) RETURNING id`,[n,JSON.stringify(probe)])).rows[0].id
  await pool.query(`INSERT INTO remote_model_offers(profile_id,upstream_model_id,canonical_model_id,base_display_name) VALUES($1,'gpt-6-luna',$2,'luna')`,[profileId,COMMISSION_MODEL])
})
after(async()=>{redis.disconnect();await closePool()})
const baseEntry:ModelCatalogEntry={entryId:1,modelId:'gpt-6-luna',engine:'codex',providerId:'codex',upstreamModelId:'gpt-6-luna',contextWindow:200000,
  capabilityProfile:{supportsVision:false,reasoning:{supported:['low'],codexModelDefault:'low'},ccb:{capabilityZero:false,supportsThinking:false}},capabilitySchemaVersion:1,state:'active',lockVersion:0}
const base=new ModelCatalogSnapshot({entries:[baseEntry],aliases:new Map(),securityEpoch:5n,pricing:new Map([['gpt-6-luna',{
  modelId:'gpt-6-luna',displayName:'Luna',inputPerMtok:600n,outputPerMtok:2400n,cacheReadPerMtok:120n,cacheWritePerMtok:750n,multiplier:'1.000',visibility:'public',sortOrder:1,defaultEffort:'low'}]])})
let denied=new Set<string>()
const authz=async()=>({uid:'3',role:'admin' as const,grantedModelIds:new Set<string>(),deniedModelIds:denied})
const cat=(run:CommissionRun)=>commissionCatalog({assertFresh:async()=>base},authz,run,()=>assertCommissionRun(pool,run,container))
test('only admin commissioning admits an unready profile; ordinary placement and publication stay closed',async()=>{
  await assert.rejects(placeRemoteLane({uid:3,containerDbId:'7',dockerId:'a'.repeat(64),sessionKey:'agent:main:webchat:dm:ordinary',canonicalModel:COMMISSION_MODEL,engine:'codex'},{pool}),/NO_ELIGIBLE/)
  await assert.rejects(admitCommission(pool,'4',profileId,container),/ADMIN_UID/)
  const run=await admitCommission(pool,'3',profileId,container)
  assert.equal((await pool.query('SELECT execution_ready,auth_epoch FROM remote_agent_profiles WHERE id=$1',[profileId])).rows[0].execution_ready,false)
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM model_catalog WHERE model_id=$1`,[COMMISSION_MODEL])).rows[0].n,0)
  const privateCatalog=await cat(run).assertFresh();assert.equal(privateCatalog.resolve(COMMISSION_MODEL)?.placement,'remote_pool')
  denied=new Set(['gpt-6-luna']);await assert.rejects(cat(run).assertFresh(),/SOURCE_MODEL_DENIED/);denied=new Set()
  await pool.query(`UPDATE remote_agent_profiles SET probe_snapshot=probe_snapshot || '{"changed":true}'::jsonb WHERE id=$1`,[profileId])
  await assert.rejects(assertCommissionRun(pool,run,container),/SNAPSHOT_CHANGED/)
  await pool.query('UPDATE remote_agent_profiles SET probe_snapshot=$2::jsonb WHERE id=$1',[profileId,JSON.stringify(probe)])
  await recordRemoteLaneState(run.binding.operationId,'released',pool,'1')
})
test('real dispatch, precheck, receipt v3 and debit precede independent confirmed CAS; stale/unbilled proof rejected',async()=>{
  const run=await admitCommission(pool,'3',profileId,container),catalog=cat(run),snapshot=await catalog.assertFresh()
  run.state='verified' // test producer only; production sets this only after both real stops and immutable bundle
  await assert.rejects(applyCommission(pool,run,'d'.repeat(64),false,container),/CONFIRM/)
  await assert.rejects(applyCommission(pool,run,'d'.repeat(64),true,container),/BILLING_UNPROVEN/)
  run.state='running'
  const key=generateKeyPairSync('ed25519'),keys=new Map([['test',new Uint8Array(Buffer.from(key.publicKey.export({format:'jwk'}).x!,'base64url'))]])
  const now=Date.now(),authority:ModelAuthorityPayload={v:1,keyId:'test',uid:3,containerId:7,authorityTurnId:randomUUID().replaceAll('-',''),
    billingRequestId:run.requestId,connectionChallenge:'commission-test',canonicalModel:COMMISSION_MODEL,engine:'codex',executionBackend:codexBackend(run.binding),
    executionRevision:snapshot.executionRevision,securityEpoch:5,issuedAt:now,expiresAt:now+120000,
    executionDescriptor:{capabilityProfile:baseEntry.capabilityProfile as any,capabilitySchemaVersion:1,contextWindow:200000,supportedEfforts:['low'],supportsVision:false}}
  const lease:TurnLease={v:1,keyId:'test',uid:3,containerId:7,authorityTurnId:authority.authorityTurnId,connectionChallenge:authority.connectionChallenge,
    canonicalModel:COMMISSION_MODEL,securityEpoch:5,issuedAt:now,expiresAt:now+600000}
  await bindAuthorityTurnDispatch(pool,{authorityTurnId:authority.authorityTurnId,dispatchId:run.dispatchId,userId:3n,sessionId:run.binding.sessionKey,
    dispatchModel:COMMISSION_MODEL,canonicalModel:COMMISSION_MODEL,attemptNo:run.attemptNo,ownerId:run.ownerId,leaseEpoch:run.leaseEpoch,agentContainerId:7,runtimeKind:'v5'})
  const finance=createRemoteNativeTurnFinance({pool,preCheckRedis:wrapIoredisForPreCheck(redis),catalog,keyring:keys,loadUserModelAuthz:authz,log:createLogger({out:()=>{}}),upstreamModel:'gpt-6-luna'})
  const input={binding:run.binding,authorityEnvelope:encodeAuthorityEnvelope(authority,sign(null,authoritySigningInput(authority),key.privateKey)),
    leaseEnvelope:encodeTurnLeaseEnvelope(lease,sign(null,turnLeaseSigningInput(lease),key.privateKey)),sessionKey:run.binding.sessionKey,turnKey:'e'.repeat(64)}
  const before=BigInt((await pool.query('SELECT credits FROM users WHERE id=3')).rows[0].credits)
  const f=await finance.admit(input);await f.beforeHostStart();const baseline=await f.bindNativeThread!('commission-thread',true)
  await f.beforeDispatch({sequence:1,inputSha256:'f'.repeat(64)})
  const receipt=buildCodexReceipt(run.binding,{authorityTurnId:authority.authorityTurnId,turnKey:input.turnKey,upstreamModel:'gpt-6-luna',nativeThreadId:'commission-thread',nativeTurnId:'turn1'},baseline,
    {...zeroNativeTokens(),inputTokens:10000,outputTokens:10000},'completed')
  await f.terminal(receipt)
  const proof=await commissionBillingProof(pool,run);assert.equal(proof.state,'committed');assert.ok(BigInt(proof.cost_credits)>0n)
  const after=BigInt((await pool.query('SELECT credits FROM users WHERE id=3')).rows[0].credits);assert.equal(before-after,BigInt(proof.cost_credits))
  await f.terminal(receipt);assert.equal(BigInt((await pool.query('SELECT credits FROM users WHERE id=3')).rows[0].credits),after)
  run.state='verified';await assert.rejects(applyCommission(pool,run,'d'.repeat(64),true,container),/LANE_BUSY/)
  await recordRemoteLaneState(run.binding.operationId,'released',pool,'1')
  const applies=await Promise.allSettled([applyCommission(pool,run,'d'.repeat(64),true,container),applyCommission(pool,run,'d'.repeat(64),true,container)])
  assert.equal(applies.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await pool.query('SELECT execution_ready FROM remote_agent_profiles WHERE id=$1',[profileId])).rows[0].execution_ready,true)
  await assert.rejects(revokeCommission(pool,run,'a'.repeat(64),true,container),/CAS_MISMATCH/)
  await assert.rejects(revokeCommission(pool,run,'d'.repeat(64),false,container),/CONFIRM/)
  await revokeCommission(pool,run,'d'.repeat(64),true,container)
  assert.equal((await pool.query('SELECT execution_ready FROM remote_agent_profiles WHERE id=$1',[profileId])).rows[0].execution_ready,false)
})


test('unknown commissioning keeps capacity, concurrent sixth run rejects, live admin/auth revocations fence',async()=>{
  const contenders=await Promise.allSettled(Array.from({length:6},()=>admitCommission(pool,'3',profileId,container)))
  assert.equal(contenders.filter(r=>r.status==='fulfilled').length,5)
  const runs=contenders.flatMap(r=>r.status==='fulfilled'?[r.value]:[]),run=runs[0]!
  await recordRemoteLaneState(run.binding.operationId,'unknown',pool,'1')
  await assert.rejects(assertCommissionRun(pool,run,container),/LANE_FENCED/)
  await assert.rejects(admitCommission(pool,'3',profileId,container),/CAPACITY_EXHAUSTED/)
  await pool.query("UPDATE users SET role='user' WHERE id=3")
  await assert.rejects(assertCommissionRun(pool,runs[1]!,container),/CONTAINER_NOT_RUNNING/)
  await pool.query("UPDATE users SET role='admin' WHERE id=3")
  await pool.query("UPDATE remote_agent_profiles SET auth_epoch='changed-epoch' WHERE id=$1",[profileId])
  await assert.rejects(assertCommissionRun(pool,runs[1]!,container),/SNAPSHOT_CHANGED/)
  await pool.query('UPDATE remote_agent_profiles SET auth_epoch=$2 WHERE id=$1',[profileId,run.previousAuthEpoch])
  for(const r of runs)await recordRemoteLaneState(r.binding.operationId,'released',pool,'1')
})

test('commissioning binds the v3 runtime identity, never the untouched v2 columns',async()=>{
  const row=(await pool.query(`SELECT status,docker_id,docker_name,state,container_internal_id FROM agent_containers WHERE id=7`)).rows[0]
  assert.equal(row.status,'provisioning'); assert.equal(row.docker_id,null); assert.equal(row.docker_name,null)
  assert.equal(row.state,'active'); assert.equal(row.container_internal_id,'a'.repeat(64))
  // Regression guard: the pre-fix gate is exactly this predicate, and it sees zero rows on
  // the real selfhost shape — that is why every commissioning start returned 409.
  assert.equal((await pool.query(`SELECT c.id FROM users u JOIN agent_containers c ON c.user_id=u.id
    WHERE u.id=3 AND u.role='admin' AND u.status='active' AND c.status='running' AND c.docker_name='oc-v5-u3'`)).rows.length,0)
  // No active v3 row (vanished) is fail-closed even though a legacy row could look healthy.
  await pool.query(`UPDATE agent_containers SET state='vanished' WHERE id=7`)
  await assert.rejects(admitCommission(pool,'3',profileId,container),/CONTAINER_NOT_RUNNING/)
  await pool.query(`UPDATE agent_containers SET state='active' WHERE id=7`)
  // Provisioning (active row, docker id not yet committed) is fail-closed.
  await pool.query(`UPDATE agent_containers SET container_internal_id=NULL WHERE id=7`)
  await assert.rejects(admitCommission(pool,'3',profileId,container),/CONTAINER_NOT_RUNNING/)
  await pool.query(`UPDATE agent_containers SET container_internal_id=$1 WHERE id=7`,['a'.repeat(64)])
  // A non-running container is fail-closed even with a complete row.
  dockerRunning=false
  await assert.rejects(admitCommission(pool,'3',profileId,container),/CONTAINER_NOT_RUNNING/)
  dockerRunning=true
  const run=await admitCommission(pool,'3',profileId,container)
  assert.equal(run.binding.containerDbId,'7'); assert.equal(run.binding.dockerId,'a'.repeat(64))
  // A rebuilt container (new container_internal_id) fences the admitted run.
  await pool.query(`UPDATE agent_containers SET container_internal_id=$1 WHERE id=7`,['b'.repeat(64)])
  await assert.rejects(assertCommissionRun(pool,run,container),/CONTAINER_CHANGED/)
  await pool.query(`UPDATE agent_containers SET container_internal_id=$1 WHERE id=7`,['a'.repeat(64)])
  await recordRemoteLaneState(run.binding.operationId,'released',pool,'1')
})
