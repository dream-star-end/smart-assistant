/** Dedicated TEST_DATABASE_URL only. Real PG migrations, locks, journals, usage/ledger and balances. */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileRemoteLane } from '../account-pool/remoteLaneRecovery.js'
import { enforceModelAuthority } from '../http/proxy/modelAuthorityGate.js'
import { parseCapabilityProfile } from '../billing/modelCatalog.js'
import { projectCodexRemoteCapabilities } from '../account-pool/codexRemoteProfile.js'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Pool } from 'pg'
import { PassThrough } from 'node:stream'
import { createRemoteLaneRuntime } from '@openclaude/gateway/cc5-container-runtime'
import { setPoolOverride, closePool } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { resetAndMigrateBefore } from './helpers/db.js'
import { placeRemoteLane, recordRemoteLaneState, recordRemoteStartAttempt, applyRemoteNodeProbeResult, publishRemoteModelOffers } from '../account-pool/remoteBrainPool.js'
import { createRemoteNativeTurnFinance, recoverRemoteNativeTurnBilling } from '../billing/remoteNativeTurnBilling.js'
import { ModelCatalogSnapshot, type ModelCatalogCache, type ModelCatalogEntry } from '../billing/modelCatalog.js'
import { createLogger } from '../logging/logger.js'
import { authoritySigningInput, encodeAuthorityEnvelope, encodeTurnLeaseEnvelope, turnLeaseSigningInput,
  type ModelAuthorityPayload, type TurnLease } from '@openclaude/protocol'
import { buildCodexReceipt, codexBackend, zeroNativeTokens, type CodexRemoteBinding } from '@openclaude/gateway/remote-finance'

const url = process.env.TEST_DATABASE_URL
assert.ok(url && new URL(url).pathname.endsWith('_test'), 'explicit isolated TEST_DATABASE_URL required')
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000 })
const model = 'gpt-6-luna-remote', upstream = 'gpt-6-luna'
const controllerSha = createHash('sha256').update(readFileSync(new URL('../../../../scripts/agent-remote/codex-host-controller.py',import.meta.url))).digest('hex')
// Native model/list captured from the OCV5-746 node probe; Sol/Astra advertise ultra.
const observedModels = JSON.parse(readFileSync(new URL('./fixtures/codex-remote-model-list.json',import.meta.url),'utf8'))
const executionSnapshot = { version:1,modelList:observedModels,
  modelCatalog:{models:observedModels.map((m:any)=>({slug:m.model}))},cliSha256:'a'.repeat(64),nativeSha256:'b'.repeat(64),controllerSha256:controllerSha }
const probe = { probe_schema_version:2,source:'codex-app-server:model/list',freshness:'cli-observed',
  auth_present:true,account_observed:true,models_observed:true,snapshot_sha256:'c'.repeat(64),execution_snapshot:executionSnapshot }
let node: string, cc: string, codex: string, uid: string
before(async () => {
  assert.match((await pool.query('SELECT current_database() AS db')).rows[0].db, /_test$/)
  setPoolOverride(pool)
  await resetAndMigrateBefore('0334')
  const applied = await runMigrations()
  assert.deepEqual(applied.applied, ['0334_users_registration_ip','0335_codex_remote_native','0336_commercial_muse_durable','0337_remote_engine_concurrency'])
  uid = (await pool.query(`INSERT INTO users(email,password_hash,credits) VALUES('codex746@example.test','test-only',100000) RETURNING id::text`)).rows[0].id
  await pool.query(`INSERT INTO agent_containers(id,user_id,secret_hash) VALUES(7,$1,$2)`,[uid,Buffer.alloc(32,1)])
  node = (await pool.query(`INSERT INTO remote_agent_nodes(label,ssh_host,ssh_user,host_key_fp,key_id,controller_sha256,status)
    VALUES('isolated746','fixture.invalid','box','SHA256:fixture','fixture','fixture','active') RETURNING id`)).rows[0].id
  for (const engine of ['cc','codex']) {
    const row = (await pool.query(`INSERT INTO remote_agent_profiles(node_id,engine,profile_name,account_fingerprint,runner_mode,
      probe_snapshot,execution_ready,auth_epoch,execution_manifest) VALUES($1,$2,$2,$2,$3,$4::jsonb,$5,'epoch1',$6::jsonb) RETURNING id`,
    [node,engine,engine === 'cc' ? 'interactive':'app-server',JSON.stringify(probe),engine === 'codex',
      JSON.stringify({version:1,backendKind:'codex-app-server-v1',authEpoch:'epoch1',snapshotSha256:probe.snapshot_sha256,
        controllerSha256:controllerSha,gatewayRevision:'codex-remote-adapter-v1',e2eReceiptSha256:'d'.repeat(64),installed:true,text:true})])).rows[0]
    if (engine === 'cc') cc = row.id; else codex = row.id
    await pool.query(`INSERT INTO remote_model_offers(profile_id,upstream_model_id,canonical_model_id,base_display_name)
      VALUES($1,$2,$3,$2)`,[row.id,engine === 'cc'?'claude-sonnet-5':upstream,engine === 'cc'?'claude-sonnet-5-remote':model])
  }
})
after(async () => { await closePool() })
test('engines pool independently: five Codex lanes per account, the sixth is rejected, CC never contends', async () => {
  const request = { uid:Number(uid),containerDbId:'7',dockerId:'a'.repeat(64) }
  const ccPlace = (key:string) => placeRemoteLane({...request,sessionKey:`agent:main:webchat:dm:${key}`,canonicalModel:'claude-sonnet-5-remote'}, {pool,packet:async()=>Buffer.from('fixture')})
  const codexPlace = (key:string) => placeRemoteLane({...request,sessionKey:`agent:main:webchat:dm:${key}`,canonicalModel:model,engine:'codex'}, {pool})
  // Same node, both engines at once: neither consumes the other's pool.
  const [firstCc, firstCodex] = await Promise.all([ccPlace('cc_slot_test'), codexPlace('codex_slot_test')])
  assert.ok(firstCc.operationId && firstCodex.operationId)
  // An unknown (unproven) stop keeps occupying its own Codex slot — and only that pool.
  await recordRemoteLaneState(firstCodex.operationId,'unknown',pool,firstCodex.generation)
  await recordRemoteLaneState(firstCodex.operationId,'released',pool,'99') // stale generation frees nothing
  assert.equal((await pool.query(`SELECT state FROM remote_agent_bindings WHERE operation_id=$1`,[firstCodex.operationId])).rows[0].state,'unknown')
  const codexLanes = [firstCodex]
  const contenders = await Promise.allSettled(Array.from({length:5},(_,i)=>codexPlace(`codex_race_${i}`)))
  assert.equal(contenders.filter(r=>r.status==='fulfilled').length,4)
  assert.equal(contenders.filter(r=>r.status==='rejected').length,1)
  for (const r of contenders) if(r.status==='fulfilled') codexLanes.push(r.value)
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM remote_agent_bindings WHERE profile_id=$1 AND state<>'released'`,[codex])).rows[0].n,5)
  await assert.rejects(codexPlace('codex_slot_6'),/REMOTE_LANE_CAPACITY_EXHAUSTED/)
  // The Codex pool being full leaves CC's pool untouched.
  const moreCc = await Promise.all(Array.from({length:4},(_,i)=>ccPlace(`cc_more_${i}`)))
  await recordRemoteLaneState(firstCc.operationId,'unknown',pool,firstCc.generation)
  await assert.rejects(ccPlace('cc_sixth'),/REMOTE_LANE_CAPACITY_EXHAUSTED/)
  // A second Codex account on the same engine/node has its own five slots, not a node+engine cap.
  const other = (await pool.query(`INSERT INTO remote_agent_profiles(node_id,engine,profile_name,account_fingerprint,runner_mode,
    probe_snapshot,execution_ready,auth_epoch,execution_manifest)
    SELECT node_id,engine,'codex-other','other',runner_mode,probe_snapshot,execution_ready,auth_epoch,execution_manifest
    FROM remote_agent_profiles WHERE id=$1 RETURNING id`,[codex])).rows[0].id
  await pool.query(`INSERT INTO remote_model_offers(profile_id,upstream_model_id,canonical_model_id,base_display_name)
    SELECT $1,upstream_model_id,canonical_model_id,base_display_name FROM remote_model_offers WHERE profile_id=$2`,[other,codex])
  const otherLanes = await Promise.all(Array.from({length:5},(_,i)=>codexPlace(`other_${i}`)))
  assert.ok(otherLanes.every(r=>r.profileId===String(other)))
  for(const lane of otherLanes) await recordRemoteLaneState(lane.operationId,'released',pool,lane.generation)
  await pool.query(`UPDATE remote_agent_profiles SET status='disabled',disabled_by='admin' WHERE id=$1`,[other])
  // A proven release frees exactly one Codex slot.
  await recordRemoteLaneState(firstCodex.operationId,'released',pool,firstCodex.generation)
  let next = await codexPlace('codex_slot_6')
  assert.equal(next.codex?.manifest.model,upstream)
  assert.equal(next.codex?.manifest.generation,'1')
  await assert.rejects(reconcileRemoteLane(pool,next.operationId,'99'),/UNPROVEN/)
  // Simulate process loss immediately after preparing COMMIT: no SSH key/root exists yet.
  await reconcileRemoteLane(pool,next.operationId,next.generation,{proveLocal:async()=>{throw new Error('must not inspect')},
    proveRemote:async()=>{throw new Error('must not SSH')}})
  await assert.rejects(recordRemoteLaneState(next.operationId,'running',pool,next.generation),/FENCED/)
  await assert.rejects(recordRemoteStartAttempt(next.operationId,next.generation,pool),/FENCED/)
  next = await placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:codex_second_test',canonicalModel:model,engine:'codex'}, {pool})
  await recordRemoteLaneState(next.operationId,'running',pool,next.generation)
  await recordRemoteStartAttempt(next.operationId,next.generation,pool)

  await assert.rejects(reconcileRemoteLane(pool,next.operationId,next.generation,{proveLocal:async()=>{throw new Error('still-running')}}),/still-running/)
  assert.equal((await pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id=$1',[next.operationId])).rows[0].state,'running')
  await reconcileRemoteLane(pool,next.operationId,next.generation,{proveLocal:async id=>{assert.equal(id,request.dockerId)},proveRemote:async spec=>{
    assert.equal(spec.codex!.manifest.generation,next.generation)
    assert.equal(spec.codex!.manifest.root,next.taskRoot)
  }})
  assert.equal((await pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id=$1',[next.operationId])).rows[0].state,'released')
  await recordRemoteLaneState(firstCc.operationId,'released',pool,firstCc.generation)
  const legacy=await placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:legacy_cc_test',canonicalModel:'claude-sonnet-5-remote'},{pool,packet:async()=>Buffer.from('fixture')})
  await pool.query('UPDATE remote_agent_bindings SET recovery_spec=NULL WHERE operation_id=$1',[legacy.operationId])
  await reconcileRemoteLane(pool,legacy.operationId,legacy.generation,{proveLocal:async()=>{},proveRemote:async spec=>{
    assert.equal(spec.taskRoot,legacy.taskRoot);assert.equal(spec.target.host,legacy.target.host);assert.equal(spec.runId,legacy.runId)
  }})
  assert.equal((await pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id=$1',[legacy.operationId])).rows[0].state,'released')
  // Leave no occupied slot behind for the later tests in this file.
  for (const lane of codexLanes.slice(1)) await recordRemoteLaneState(lane.operationId,'released',pool,lane.generation)
  for(const lane of [firstCc,...moreCc]) await recordRemoteLaneState(lane.operationId,'released',pool,lane.generation)
})
test('probe facts persist app-server capabilities and errors but never assert readiness; publication fails closed', async () => {
  await publishRemoteModelOffers({profile_id:codex,allowActivateExecution:true,
    offers:observedModels.map((m:any)=>({upstream_model_id:m.model,base_display_name:m.displayName}))},pool)
  for (const observed of observedModels) {
    const rows=(await pool.query(`SELECT * FROM model_catalog WHERE model_id=$1 AND state='active'`,[`${observed.model}-remote`])).rows
    assert.equal(rows.length,1)
    assert.deepEqual(rows[0].capability_profile.reasoning,{supported:['low','medium','high','xhigh','max'],codex_model_default:observed.defaultReasoningEffort})
  }
  const published=(await pool.query(`SELECT * FROM model_catalog WHERE model_id=$1 AND state='active'`,[model])).rows
  assert.equal(published[0].capability_profile.remote.observed_vision,true)
  const observed = executionSnapshot.modelList.find((m:any)=>m.model===upstream)
  const projected = parseCapabilityProfile(model,projectCodexRemoteCapabilities({probe_snapshot:probe},upstream))
  assert.deepEqual(projected.reasoning.supported,['low','medium','high','xhigh','max'])
  assert.equal(projected.remote?.observed_vision,true)
  assert.deepEqual(projected.remote?.observed_service_tiers,[])
  assert.equal(projected.supportsVision,false); assert.equal(projected.remote?.supports_fast,false)
  const result = await applyRemoteNodeProbeResult(node,{profiles:[{...probe,engine:'codex',profile_name:'codex',
    account_fingerprint:'codex',runner_mode:'app-server',logged_in:true,execution_ready:true,
    snapshot_sha256:'e'.repeat(64),discovered_models:[{upstream_model_id:upstream,display_name:'Fixture Luna',native:observed,
      supported_reasoning_efforts:observed.supportedReasoningEfforts,input_modalities:observed.inputModalities,service_tiers:observed.serviceTiers}]}]},pool)
  assert.equal(result.profiles[0].runner_mode,'app-server')
  assert.equal(result.profiles[0].execution_ready,false)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM model_catalog WHERE model_id=$1 AND state='active'`,[model])).rows[0].n,0)
  assert.deepEqual(result.profiles[0].discovered_models[0].service_tiers,observed.serviceTiers)
  await assert.rejects(publishRemoteModelOffers({profile_id:codex,allowActivateExecution:true,
    offers:[{upstream_model_id:upstream,base_display_name:'Fixture Luna'}]},pool),/CODEX_EXECUTION_NOT_READY/)
  const failed = await applyRemoteNodeProbeResult(node,{profiles:[{engine:'codex',profile_name:'codex',account_fingerprint:'codex',
    runner_mode:'app-server',probe_schema_version:2,source:'codex-app-server:model/list',logged_in:false,
    auth_present:true,account_observed:false,models_observed:false,error_code:'CODEX_ACCOUNT_UNAVAILABLE',discovered_models:[]}]},pool)
  assert.equal(failed.profiles[0].last_error,'CODEX_ACCOUNT_UNAVAILABLE')
  assert.deepEqual(failed.profiles[0].discovered_models,[])
})

const {privateKey,publicKey} = generateKeyPairSync('ed25519'), keyId='mak1_testkey00000001'
const keys = new Map([[keyId,new Uint8Array(Buffer.from(publicKey.export({format:'jwk'}).x!,'base64url'))]])
const cap = {supportsVision:false,reasoning:{supported:['low'] as const,codexModelDefault:'low' as const},ccb:{capabilityZero:false,supportsThinking:false}}
const entry: ModelCatalogEntry = {entryId:1,modelId:model,engine:'codex',providerId:'codex',placement:'remote_pool',upstreamModelId:upstream,
  contextWindow:200000,capabilityProfile:cap,capabilitySchemaVersion:1,state:'active',lockVersion:0}
const catalog = new ModelCatalogSnapshot({entries:[entry],aliases:new Map(),securityEpoch:5n,pricing:new Map([[model,
  {modelId:model,displayName:model,inputPerMtok:600n,outputPerMtok:2400n,cacheReadPerMtok:120n,cacheWritePerMtok:750n,
    multiplier:'1.000',visibility:'public',sortOrder:100,defaultEffort:'low'}]])})
test('receipt v3 persists total deltas, charges once, advances free error/cancel boundaries and resumes from PG', async () => {
  const binding: CodexRemoteBinding = { version:3,backendKind:'codex-app-server-v1',uid,containerDbId:'7',dockerId:'a'.repeat(64),
    operationId:randomUUID(),runId:randomUUID(),sessionKey:'agent:main:webchat:dm:billing_codex_test',canonicalModel:model,
    generation:'1',profileId:'codex',authEpoch:'epoch1',manifestSha256:'f'.repeat(64),capability:'f'.repeat(64),expiresAt:Date.now()+3600000 }
  const redis = {eval:async()=>0} as any
  const evidence = mkdtempSync(join(tmpdir(),'codex-recovery-'))
  const journalDir = join(evidence,binding.operationId,binding.generation,'journal')
  mkdirSync(journalDir,{recursive:true})
  let failRelease=false,failReceipt=false
  const faultPool = new Proxy(pool,{get(target,prop){
    if(prop==='query')return async (...args:any[])=>{if(failRelease && String(args[0]).includes('remote-native:release-boundary'))throw new Error('crash-after-commit');return (target.query as any)(...args)}
    if(prop==='connect')return async()=>{const c=await target.connect();return new Proxy(c,{get(t,p){
      if(p==='query')return async(...args:any[])=>{if(failReceipt && String(args[0]).includes('INSERT INTO remote_native_turns'))throw new Error('crash-before-receipt-commit');return (t.query as any)(...args)}
      const value=Reflect.get(t,p);return typeof value==='function'?value.bind(t):value
    }})}
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value
  }})
  const finance = (upstream: string, snapshot: ModelCatalogSnapshot) => createRemoteNativeTurnFinance({pool:faultPool,upstreamModel:upstream,preCheckRedis:redis,keyring:keys,
    catalog:{assertFresh:async()=>snapshot} as unknown as ModelCatalogCache,
    loadUserModelAuthz:async(userId)=>({uid:userId,role:'user',grantedModelIds:new Set<string>(),deniedModelIds:new Set<string>(),userPlanTier:null,orgPlanCode:null}),
    log:createLogger({out:()=>{}})}, {reserve:async()=>({maxCost:100n}) as any,release:async()=>true})
  const totals = [
    {inputTokens:10000,cachedInputTokens:6000,cacheWriteInputTokens:0,outputTokens:2000,reasoningOutputTokens:1500},
    {inputTokens:12000,cachedInputTokens:6500,cacheWriteInputTokens:0,outputTokens:2200,reasoningOutputTokens:1600},
    {inputTokens:15000,cachedInputTokens:7000,cacheWriteInputTokens:0,outputTokens:2500,reasoningOutputTokens:1700},
    {inputTokens:16000,cachedInputTokens:7200,cacheWriteInputTokens:0,outputTokens:2700,reasoningOutputTokens:1800},
  ]
  const statuses = ['completed','failed','interrupted','completed'] as const
  const costs: string[] = []
  for (let i=0;i<10;i++) {
    // Switch actual signed model + pricing in the same native thread; never reset cumulative usage.
    const turnBinding = {...binding,canonicalModel:i===3?'gpt-6.1-sol-remote':model}
    const turnUpstream = i===3?'gpt-6.1-sol':upstream
    const turnCatalog = i===3 ? new ModelCatalogSnapshot({entries:[{...entry,modelId:turnBinding.canonicalModel,upstreamModelId:turnUpstream}],
      aliases:new Map(),securityEpoch:5n,pricing:new Map([[turnBinding.canonicalModel,
        {modelId:turnBinding.canonicalModel,displayName:'Sol',inputPerMtok:1200n,outputPerMtok:4800n,cacheReadPerMtok:240n,
          cacheWritePerMtok:1500n,multiplier:'1.000',visibility:'public',sortOrder:100,defaultEffort:'low'}]])}) : catalog
    const dispatch=randomUUID(), request=randomUUID().replaceAll('-',''), auth=randomUUID().replaceAll('-',''), turnKey=createHash('sha256').update(request).digest('hex')
    await pool.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,model,request_hash,
      billing_request_id,status,agent_container_id) VALUES($1,$2,$3,$4,'main',$5,$6,$4,'admitted',7)`,
    [dispatch,uid,binding.sessionKey,request,turnBinding.canonicalModel,turnKey])
    await pool.query(`INSERT INTO authority_turn_dispatches(authority_turn_id,user_id,canonical_model,session_id,dispatch_id,attempt_no)
      VALUES($1,$2,$3,$4,$5,1)`,[auth,uid,turnBinding.canonicalModel,binding.sessionKey,dispatch])
    const now=Date.now(), a:ModelAuthorityPayload={v:1,keyId,uid:Number(uid),containerId:7,authorityTurnId:auth,connectionChallenge:'fixture',canonicalModel:turnBinding.canonicalModel,
      engine:'codex',executionBackend:codexBackend(turnBinding),executionDescriptor:{capabilityProfile:cap,capabilitySchemaVersion:1,contextWindow:200000,
        supportsVision:false,supportedEfforts:['low'],codexDefaultEffort:'low'},executionRevision:turnCatalog.executionRevision,securityEpoch:5,
      billingRequestId:request,issuedAt:now,expiresAt:now+60000}
    const l:TurnLease={v:1,keyId,uid:Number(uid),containerId:7,authorityTurnId:auth,connectionChallenge:'fixture',canonicalModel:turnBinding.canonicalModel,securityEpoch:5,issuedAt:now,expiresAt:now+600000}
    await assert.rejects(enforceModelAuthority({catalog:{assertFresh:async()=>catalog},keyring:keys,headers:{},uid:BigInt(uid),containerId:7n,model}),/anthropic proxy/)
    const f=finance(turnUpstream,turnCatalog), turn=await f.admit({binding:turnBinding,sessionKey:binding.sessionKey,turnKey,
      authorityEnvelope:encodeAuthorityEnvelope(a,sign(null,authoritySigningInput(a),privateKey)),
      leaseEnvelope:encodeTurnLeaseEnvelope(l,sign(null,turnLeaseSigningInput(l),privateKey))})
    if (i>=4) {
      if (i===5 || i===7 || i===9) await turn.beforeHostStart() // marker completed, but relay proved no provision/launch
      if (i>=6) {
        // Master died after finance admission, before its persistent remote-start CAS.
        await pool.query(`INSERT INTO remote_agent_bindings(operation_id,run_id,uid,container_db_id,docker_id,session_key,
          node_id,profile_id,canonical_model_id,state,expires_at,engine,backend_kind,generation,remote_start_attempted)
          VALUES($1,$2,$3,7,$4,$5,$6,$7,$8,'preparing',NOW()+INTERVAL '1 hour','codex','codex-app-server-v1',1,$9)
          ON CONFLICT(operation_id) DO UPDATE SET state='preparing',remote_start_attempted=EXCLUDED.remote_start_attempted,
            recovery_spec=EXCLUDED.recovery_spec,no_host_effect_proven=FALSE`,
        [binding.operationId,binding.runId,uid,binding.dockerId,binding.sessionKey,node,codex,model,i>=7])
        if (i>=7) {
          await pool.query('UPDATE remote_agent_bindings SET recovery_spec=$2::jsonb WHERE operation_id=$1',[binding.operationId,
            JSON.stringify({version:1,operationId:binding.operationId,runId:binding.runId,generation:'1'})])
        }
        await reconcileRemoteLane(pool,binding.operationId,'1',{proveLocal:async()=>{},proveRemote:async()=>({noHostEffect:i<8})})
        assert.deepEqual(await recoverRemoteNativeTurnBilling({pool,preCheckRedis:redis,log:createLogger({out:()=>{}})}),{proven:1,pending:0})
      } else await turn.stop({hostStartAttempted:false,userSubmitted:false,remoteStopped:true})
      assert.equal((await pool.query('SELECT state FROM request_finalize_journal WHERE request_id=$1',[request])).rows[0].state,'aborted')
      assert.equal((await pool.query('SELECT COUNT(*)::int n FROM usage_records WHERE request_id=$1',[request])).rows[0].n,0)
      continue
    }
    await turn.beforeHostStart()
    const baseline=await turn.bindNativeThread!('thread746',i===0)
    assert.deepEqual(baseline,i===0?zeroNativeTokens():totals[i-1])
    await turn.beforeDispatch({sequence:1,inputSha256:turnKey})
    const receipt=buildCodexReceipt(turnBinding,{authorityTurnId:auth,turnKey,upstreamModel:turnUpstream,nativeThreadId:'thread746',nativeTurnId:`turn${i}`},baseline,totals[i],statuses[i])
    failRelease=i===0;failReceipt=i===1
    const outcomes=await Promise.all(Array.from({length:10},()=>turn.terminal(structuredClone(receipt))))
    if(i<2){
      assert.ok(outcomes.every(o=>o.state==='pending'))
      const journal=(await pool.query('SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1',[request])).rows[0]
      assert.equal(journal.state,i===0?'committed':'inflight')
      if(i===1){
        assert.equal(journal.ctx.remoteNative.receipt,null)
        writeFileSync(join(journalDir,'00000009-native-terminal.json'),JSON.stringify(receipt),{mode:0o600})
      }
      failRelease=false;failReceipt=false
      const repaired=await recoverRemoteNativeTurnBilling({pool,preCheckRedis:redis,log:createLogger({out:()=>{}})},{evidenceRoot:evidence})
      assert.deepEqual(repaired,{proven:1,pending:0})
    }else assert.ok(outcomes.every(o=>o.state==='proven'))
    const usage=(await pool.query(`SELECT cost_credits::text,input_tokens::text,cache_read_tokens::text,output_tokens::text,price_snapshot
      FROM usage_records WHERE request_id=$1`,[request])).rows
    assert.equal(usage.length,1); costs.push(usage[0].cost_credits)
    assert.equal(usage[0].input_tokens,String(receipt.usage.inputTokens))
    assert.deepEqual(usage[0].price_snapshot.remote_native.nativeUsage,receipt.nativeUsage)
    assert.throws(()=>turn.terminal({...receipt,total:{...receipt.total,outputTokens:receipt.total.outputTokens+1}}))
  }
  assert.deepEqual(costs,['8','0','0','2']) // exact rates: cache discounted once, reasoning never added to output.
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM remote_native_turns WHERE operation_id=$1`,[binding.operationId])).rows[0].n,4)
  assert.equal((await pool.query(`SELECT pending_request_id FROM remote_native_threads WHERE operation_id=$1`,[binding.operationId])).rows[0].pending_request_id,null)
  assert.deepEqual(await recoverRemoteNativeTurnBilling({pool,preCheckRedis:redis,log:createLogger({out:()=>{}})}),{proven:0,pending:0})
  const balance=(await pool.query(`SELECT credits::text FROM users WHERE id=$1`,[uid])).rows[0].credits
  assert.equal(balance,'99990')
  rmSync(evidence,{recursive:true,force:true})
})
test('an admission abandoned before dispatch frees its journal, thread claim and operation for the next turn', async () => {
  const redis = {eval:async()=>0} as any
  // One port, like one container lane: the in-memory owner is exactly what a cancel has to release.
  const port = createRemoteNativeTurnFinance({pool,upstreamModel:upstream,preCheckRedis:redis,keyring:keys,
    catalog:{assertFresh:async()=>catalog} as unknown as ModelCatalogCache,
    loadUserModelAuthz:async(userId)=>({uid:userId,role:'user',grantedModelIds:new Set<string>(),deniedModelIds:new Set<string>(),userPlanTier:null,orgPlanCode:null}),
    log:createLogger({out:()=>{}})}, {reserve:async()=>({maxCost:100n}) as any,release:async()=>true})
  const binding: CodexRemoteBinding = { version:3,backendKind:'codex-app-server-v1',uid,containerDbId:'7',dockerId:'a'.repeat(64),
    operationId:randomUUID(),runId:randomUUID(),sessionKey:'agent:main:webchat:dm:abandon_codex_test',canonicalModel:model,
    generation:'1',profileId:'codex',authEpoch:'epoch1',manifestSha256:'f'.repeat(64),capability:'f'.repeat(64),expiresAt:Date.now()+3600000 }
  const issue = async (label: string) => {
    const dispatch=randomUUID(), auth=randomUUID().replaceAll('-',''), turnKey=createHash('sha256').update(`${label}-key`).digest('hex')
    await pool.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,model,request_hash,
      billing_request_id,status,agent_container_id) VALUES($1,$2,$3,$4,'main',$5,$6,$4,'admitted',7)`,
    [dispatch,uid,binding.sessionKey,label,model,turnKey])
    await pool.query(`INSERT INTO authority_turn_dispatches(authority_turn_id,user_id,canonical_model,session_id,dispatch_id,attempt_no)
      VALUES($1,$2,$3,$4,$5,1)`,[auth,uid,model,binding.sessionKey,dispatch])
    const now=Date.now(), a:ModelAuthorityPayload={v:1,keyId,uid:Number(uid),containerId:7,authorityTurnId:auth,connectionChallenge:'fixture',
      canonicalModel:model,engine:'codex',executionBackend:codexBackend(binding),executionDescriptor:{capabilityProfile:cap,capabilitySchemaVersion:1,
      contextWindow:200000,supportsVision:false,supportedEfforts:['low'],codexDefaultEffort:'low'},executionRevision:catalog.executionRevision,
      securityEpoch:5,billingRequestId:label,issuedAt:now,expiresAt:now+60000}
    const l:TurnLease={v:1,keyId,uid:Number(uid),containerId:7,authorityTurnId:auth,connectionChallenge:'fixture',canonicalModel:model,
      securityEpoch:5,issuedAt:now,expiresAt:now+600000}
    return {label,auth,turnKey,admit:{binding,sessionKey:binding.sessionKey,turnKey,
      authorityEnvelope:encodeAuthorityEnvelope(a,sign(null,authoritySigningInput(a),privateKey)),
      leaseEnvelope:encodeTurnLeaseEnvelope(l,sign(null,turnLeaseSigningInput(l),privateKey))}}
  }
  const first=await issue('abandon746a')
  const turnA=await port.admit(first.admit)
  await turnA.beforeHostStart()
  // The cancel-before-dispatch state: the host started and the thread is claimed, nothing was sent.
  assert.deepEqual(await turnA.bindNativeThread!('thread-abandon-746',true),zeroNativeTokens())
  const second=await issue('abandon746b')
  await assert.rejects(port.admit(second.admit),/.*/) // the live owner must not admit a second turn
  assert.deepEqual(await turnA.abandonUndispatched!(),{state:'proven',requestId:first.label})
  const journal=(await pool.query(`SELECT state,final_credits::text,failure_code,error_msg
    FROM request_finalize_journal WHERE request_id=$1`,[first.label])).rows[0]
  assert.equal(journal.state,'aborted'); assert.equal(journal.final_credits,'0')
  assert.equal(journal.failure_code,'USER_CANCELLED'); assert.equal(journal.error_msg,'remote_native_abandoned_before_dispatch')
  const thread=(await pool.query('SELECT pending_request_id,total FROM remote_native_threads WHERE operation_id=$1',
    [binding.operationId])).rows[0]
  assert.equal(thread.pending_request_id,null) // the claim is freed, the thread itself survives
  assert.deepEqual(thread.total,zeroNativeTokens())
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM usage_records WHERE request_id=$1',[first.label])).rows[0].n,0)
  await assert.rejects(port.admit(first.admit),/.*/) // the abandoned authority is never re-admitted

  // The next turn admits on the same operation and the same native thread, still from a zero base.
  const turnB=await port.admit(second.admit)
  await turnB.beforeHostStart()
  assert.deepEqual(await turnB.bindNativeThread!('thread-abandon-746',false),zeroNativeTokens())
  // The boundary is a one-shot claim for this turn: the relay may re-attach the same thread inside
  // the admission (kernel restart), but it must reuse the recorded baseline, never bind twice.
  await assert.rejects(turnB.bindNativeThread!('thread-abandon-746',false),/REMOTE_NATIVE_BILLING_REJECTED/)
  await turnB.beforeDispatch({sequence:1,inputSha256:second.turnKey})
  const total={inputTokens:1000,cachedInputTokens:500,cacheWriteInputTokens:0,outputTokens:100,reasoningOutputTokens:60}
  const receipt=buildCodexReceipt(binding,{authorityTurnId:second.auth,turnKey:second.turnKey,upstreamModel:upstream,
    nativeThreadId:'thread-abandon-746',nativeTurnId:'turn-abandon-1'},zeroNativeTokens(),total,'completed')
  assert.deepEqual(await turnB.terminal(receipt),{state:'proven',requestId:second.label})
  const usage=(await pool.query('SELECT price_snapshot FROM usage_records WHERE request_id=$1',[second.label])).rows
  assert.equal(usage.length,1) // only the turn that dispatched is billed
  assert.deepEqual(usage[0].price_snapshot.remote_native.nativeUsage,total)
  assert.equal((await pool.query('SELECT pending_request_id FROM remote_native_threads WHERE operation_id=$1',
    [binding.operationId])).rows[0].pending_request_id,null)
  for (const reason of ['REMOTE_NODE_MEMORY_EXHAUSTED','REMOTE_NODE_TASKS_EXHAUSTED'] as const) {
  const refused = await issue(reason)
  const refusedTurn = await port.admit(refused.admit)
  await refusedTurn.beforeHostStart()
  await refusedTurn.stop({hostStartAttempted:true,userSubmitted:false,remoteStopped:true,nodeAdmissionRejected:true,nodeAdmissionReason:reason})
  const rejected = (await pool.query(`SELECT state,final_credits::text,failure_code,error_msg FROM request_finalize_journal WHERE request_id=$1`,[refused.label])).rows[0]
  assert.deepEqual(rejected,{state:'aborted',final_credits:'0',failure_code:'INTERNAL_ERROR',error_msg:reason})
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM usage_records WHERE request_id=$1',[refused.label])).rows[0].n,0)
  }

})


test('R1 missing Codex profiles withdraw exclusive models; surviving ready supplier remains routable', async () => {
  const manifest = {version:1,backendKind:'codex-app-server-v1',authEpoch:'epoch1',snapshotSha256:probe.snapshot_sha256,
    controllerSha256:controllerSha,gatewayRevision:'codex-remote-adapter-v1',e2eReceiptSha256:'d'.repeat(64),installed:true,text:true}
  const profile = (name:string) => ({...probe,engine:'codex' as const,profile_name:name,account_fingerprint:name,
    runner_mode:'app-server',logged_in:true,discovered_models:[{upstream_model_id:upstream,display_name:'Fixture Luna'}]})
  for (const surviving of [false,true]) {
    await pool.query(`UPDATE remote_agent_profiles SET execution_ready=TRUE,status='active',disabled_by=NULL,
      probe_snapshot=$2::jsonb,execution_manifest=$3::jsonb WHERE id=$1`,[codex,JSON.stringify(probe),JSON.stringify(manifest)])
    const other=(await pool.query(`INSERT INTO remote_agent_profiles(node_id,engine,profile_name,account_fingerprint,runner_mode,
      probe_snapshot,execution_ready,auth_epoch,execution_manifest)
      VALUES($1,'codex','r1-other','r1-other','app-server',$2::jsonb,$3,'epoch1',$4::jsonb)
      ON CONFLICT(node_id,engine,profile_name) DO UPDATE SET execution_ready=EXCLUDED.execution_ready,
        status='active',probe_snapshot=EXCLUDED.probe_snapshot,execution_manifest=EXCLUDED.execution_manifest RETURNING id`,
      [node,JSON.stringify(probe),surviving,JSON.stringify(manifest)])).rows[0].id
    await pool.query(`INSERT INTO remote_model_offers(profile_id,upstream_model_id,canonical_model_id,base_display_name)
      VALUES($1,$2,$3,'Fixture Luna') ON CONFLICT DO NOTHING`,[other,upstream,model])
    await publishRemoteModelOffers({profile_id:codex,allowActivateExecution:true,offers:[{upstream_model_id:upstream,base_display_name:'Fixture Luna'}]},pool)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM model_catalog WHERE model_id=$1 AND state='active'`,[model])).rows[0].n,1,'publication positive control')
    await applyRemoteNodeProbeResult(node,{profiles:[profile('r1-other')]},pool)
    assert.equal((await pool.query('SELECT execution_ready FROM remote_agent_profiles WHERE id=$1',[codex])).rows[0].execution_ready,false)
    const row=(await pool.query(`SELECT state FROM model_catalog WHERE model_id=$1 AND state<>'retired'`,[model])).rows[0]
    assert.equal(row.state,surviving?'active':'disabled')
    const place=()=>placeRemoteLane({uid:Number(uid),containerDbId:'7',dockerId:'a'.repeat(64),
      sessionKey:`agent:main:webchat:dm:r1missing${surviving}`,canonicalModel:model,engine:'codex'},{pool})
    if (surviving) {const lane=await place();assert.equal(lane.profileId,String(other));await recordRemoteLaneState(lane.operationId,'released',pool,lane.generation)}
    else await assert.rejects(place(),/NO_ELIGIBLE_REMOTE_PROFILE/)
    // Entire engine absent, not just a missing named profile.
    await applyRemoteNodeProbeResult(node,{profiles:[{engine:'grok-build',profile_name:'r1-grok',
      account_fingerprint:'r1-grok',runner_mode:'interactive',logged_in:true,
      discovered_models:[{upstream_model_id:'grok-fixture',display_name:'Fixture'}]}]},pool)
    assert.equal((await pool.query(`SELECT state FROM model_catalog WHERE model_id=$1 AND state<>'retired'`,[model])).rows[0].state,'disabled')
  }
})


test('complete migration chain preserves old users/Muse writes and records exact ordered versions', async () => {
  const applied=(await pool.query(`SELECT version FROM schema_migrations WHERE version > '0333_remote_agent_pool' ORDER BY version`)).rows.map(r=>r.version)
  assert.deepEqual(applied,['0334_users_registration_ip','0335_codex_remote_native','0336_commercial_muse_durable','0337_remote_engine_concurrency'])
  const user=(await pool.query(`INSERT INTO users(email,password_hash) VALUES('r1-old-writer@example.test','fixture') RETURNING id,registration_ip`)).rows[0]
  assert.equal(user.registration_ip,null)
  const id=`mj_${randomUUID()}`
  await pool.query(`INSERT INTO muse_media_jobs(id,user_id,kind,prompt_sha256,prompt_preview,params,status)
    VALUES($1,$2,'video',$3,'old writer','{}','running')`,[id,user.id,Buffer.alloc(32)])
  const result=await pool.query(`UPDATE muse_media_jobs SET status='failed',error_code='MUSE_MASTER_RESTARTED'
    WHERE id=$1 RETURNING status,durable,delivery_attempts`,[id])
  assert.deepEqual(result.rows,[{status:'failed',durable:null,delivery_attempts:0}])
})


test('R1 PG prepare failure then same-chat retry frees exactly one slot; unknown proof keeps it occupied', {skip: process.getuid?.() !== 0}, async () => {
  for (const unproven of [false,true]) {
    const root=mkdtempSync('/tmp/rl-')
    const sessionKey=`agent:main:webchat:dm:r1prepare${unproven}`
    let failPrepare=true,failStop=unproven
    const runtime=createRemoteLaneRuntime({selfhost:true,
      env:{OC_SELFHOST_CC5_T1555U_ENABLED:'1',OC_SELFHOST_CC5_T1555U_TEST_UID:uid},
      financeFactory:()=>({admit:async()=>{throw new Error('must not start model')}}),
      hooks:{place:request=>placeRemoteLane(request,{pool,packet:async()=>Buffer.from('fixture')}),
        onState:(op,state,generation)=>recordRemoteLaneState(op,state,pool,generation)},
      configuration:()=>({baseRoot:join(root,'r'),controllerPath:'/unused',hostFactory:()=>({
        prepareTask:async()=>{if(failPrepare)throw new Error('transient preparation failure')},
        start:()=>({stdin:new PassThrough(),stdout:new PassThrough(),ready:Promise.resolve()}),
        stop:async()=>{if(failStop)throw new Error('stop unproven');return {remoteStopped:true as const}},
      })}),
    })!
    const ensure=()=>runtime.ensureLane({uid:Number(uid),containerDbId:'7',sessionKey,canonicalModel:'claude-sonnet-5-remote'})
    const rows=async()=> (await pool.query(`SELECT state,generation FROM remote_agent_bindings WHERE uid=$1 AND session_key=$2`,[uid,sessionKey])).rows
    try {
      const key=generateKeyPairSync('ed25519')
      const handle=(await runtime.prepare({uid:Number(uid),containerDbId:'7',local:true,publicKeyring:`fixture-key:${key.publicKey.export({format:'jwk'}).x}`}))!
      await runtime.bindCreated(handle,'a'.repeat(64));await runtime.activate(handle,'a'.repeat(64))
      await assert.rejects(ensure(),/REMOTE_LANE_UNAVAILABLE/)
      assert.equal((await rows())[0].state,unproven?'unknown':'released')
      if(unproven){await assert.rejects(ensure(),/REMOTE_LANE_UNAVAILABLE/);assert.equal((await rows())[0].state,'unknown')}
      failPrepare=false;failStop=false
      const recovered=await ensure();assert.ok(recovered.operationId)
      const occupied=(await rows()).filter(r=>r.state!=='released')
      assert.equal(occupied.length,1);assert.equal(occupied[0].state,'running')
      await runtime.release('7')
      assert.equal((await rows()).filter(r=>r.state!=='released').length,0)
    } finally {failStop=false;await runtime.release('7');rmSync(root,{recursive:true,force:true})}
  }
})
