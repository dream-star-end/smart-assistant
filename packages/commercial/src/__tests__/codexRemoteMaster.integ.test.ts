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
import { setPoolOverride, closePool } from '../db/index.js'
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
const executionSnapshot = { version:1,modelList:[{ id:upstream,model:upstream,displayName:'Fixture Luna',
  supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',inputModalities:['text','image'],serviceTiers:['fast'] }],
  modelCatalog:{models:[{slug:upstream}]},cliSha256:'a'.repeat(64),nativeSha256:'b'.repeat(64),controllerSha256:controllerSha }
const probe = { probe_schema_version:2,source:'codex-app-server:model/list',freshness:'cli-observed',
  auth_present:true,account_observed:true,models_observed:true,snapshot_sha256:'c'.repeat(64),execution_snapshot:executionSnapshot }
let node: string, cc: string, codex: string, uid: string
before(async () => {
  assert.match((await pool.query('SELECT current_database() AS db')).rows[0].db, /_test$/)
  setPoolOverride(pool)
  await resetAndMigrateBefore('0334')
  await pool.query(readFileSync(new URL('../db/migrations/0335_codex_remote_native.sql',import.meta.url),'utf8'))
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
test('CC and Codex contend atomically for one node slot; unknown and stale generation never free it', async () => {
  const request = { uid:Number(uid),containerDbId:'7',dockerId:'a'.repeat(64) }
  const outcomes = await Promise.allSettled([
    placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:cc_slot_test',canonicalModel:'claude-sonnet-5-remote'}, {pool,packet:async()=>Buffer.from('fixture')}),
    placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:codex_slot_test',canonicalModel:model,engine:'codex'}, {pool}),
  ])
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1)
  const winner = outcomes.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof placeRemoteLane>>>
  await recordRemoteLaneState(winner.value.operationId,'unknown',pool,winner.value.generation)
  await assert.rejects(placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:third_slot_test',canonicalModel:model,engine:'codex'}, {pool}),/NO_ELIGIBLE/)
  await recordRemoteLaneState(winner.value.operationId,'released',pool,'99')
  assert.equal((await pool.query(`SELECT state FROM remote_agent_bindings WHERE operation_id=$1`,[winner.value.operationId])).rows[0].state,'unknown')
  await recordRemoteLaneState(winner.value.operationId,'released',pool,winner.value.generation)
  let next = await placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:codex_second_test',canonicalModel:model,engine:'codex'}, {pool})
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
  const legacy=await placeRemoteLane({...request,sessionKey:'agent:main:webchat:dm:legacy_cc_test',canonicalModel:'claude-sonnet-5-remote'},{pool,packet:async()=>Buffer.from('fixture')})
  await pool.query('UPDATE remote_agent_bindings SET recovery_spec=NULL WHERE operation_id=$1',[legacy.operationId])
  await reconcileRemoteLane(pool,legacy.operationId,legacy.generation,{proveLocal:async()=>{},proveRemote:async spec=>{
    assert.equal(spec.taskRoot,legacy.taskRoot);assert.equal(spec.target.host,legacy.target.host);assert.equal(spec.runId,legacy.runId)
  }})
  assert.equal((await pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id=$1',[legacy.operationId])).rows[0].state,'released')
})
test('probe facts persist app-server capabilities and errors but never assert readiness; publication fails closed', async () => {
  await publishRemoteModelOffers({profile_id:codex,allowActivateExecution:true,offers:[{upstream_model_id:upstream,base_display_name:'Fixture Luna'}]},pool)
  const published=(await pool.query(`SELECT * FROM model_catalog WHERE model_id=$1 AND state='active'`,[model])).rows
  assert.equal(published.length,1)
  assert.deepEqual(published[0].capability_profile.reasoning.supported,['low'])
  assert.equal(published[0].capability_profile.remote.observed_vision,true)
  const observed = executionSnapshot.modelList[0]
  const projected = parseCapabilityProfile(model,projectCodexRemoteCapabilities({probe_snapshot:probe},upstream))
  assert.deepEqual(projected.reasoning.supported,['low'])
  assert.equal(projected.remote?.observed_vision,true)
  assert.deepEqual(projected.remote?.observed_service_tiers,['fast'])
  assert.equal(projected.supportsVision,false); assert.equal(projected.remote?.supports_fast,false)
  const result = await applyRemoteNodeProbeResult(node,{profiles:[{...probe,engine:'codex',profile_name:'codex',
    account_fingerprint:'codex',runner_mode:'app-server',logged_in:true,execution_ready:true,
    snapshot_sha256:'e'.repeat(64),discovered_models:[{upstream_model_id:upstream,display_name:'Fixture Luna',native:observed,
      supported_reasoning_efforts:observed.supportedReasoningEfforts,input_modalities:observed.inputModalities,service_tiers:observed.serviceTiers}]}]},pool)
  assert.equal(result.profiles[0].runner_mode,'app-server')
  assert.equal(result.profiles[0].execution_ready,false)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM model_catalog WHERE model_id=$1 AND state='active'`,[model])).rows[0].n,0)
  assert.deepEqual(result.profiles[0].discovered_models[0].service_tiers,['fast'])
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
})
