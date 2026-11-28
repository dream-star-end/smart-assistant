/**
 * OCV5-915 P3-1 — Outcome-based real-entry tests for:
 * 1. `selectSelfhostRemoteDriverViaUnifiedRouter` (`UnifiedPlacementRouter` + PG offers/probes +
 *    `PgLogicalModelBindingStore` + WRH sticky/cache affinity + capability superset +
 *    uncommissioned-staging guard + strict `selfhost === true` gate).
 * 2. `verifyDualPoolParityConformance` & `RemoteDriverV4CommissioningService` precheck gate +
 *    `getProfileStatus` parity reporting.
 * 3. `remoteDriverReceiptV5.ts` + `remoteDriverTurnBilling.ts` optional `TurnReceiptV5`
 *    persistence/validation & Q1 pre-upgrade row backward compatibility.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  REMOTE_DRIVER_BACKEND,
  buildRemoteReceiptV4,
  buildTurnReceiptV5FromLocalOutcome,
  buildTurnReceiptV5FromRemoteV4,
  computeCacheAffinityKey,
  remoteCanonicalSha256,
  verifyDualPoolReceiptParity,
  type RemoteDriverUsagePolicy,
  type RemoteProbeSnapshot,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import type { Pool } from 'pg'
import type { PreCheckRedis } from '../../../billing/preCheck.js'
import {
  buildRemoteDriverTurnReceiptV5,
  driverReceiptStamp,
  validateRemoteDriverTurnReceiptV5,
  type RemoteDriverScopeV4,
} from '../../../billing/remoteDriverReceiptV5.js'
import {
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  recoverRemoteDriverTurnBilling,
} from '../../../billing/remoteDriverTurnBilling.js'
import { createLogger } from '../../../logging/logger.js'
import { RemoteDriverV4CommissioningService } from '../commissioningService.js'
import { verifyDualPoolParityConformance } from '../dualPoolParityGate.js'
import { buildExtendedRedProofArtifact, type ExtendedRedControlEntry } from '../extendedRedProof.js'
import { loadRemoteDriverRegistry } from '../registry.js'
import { selectSelfhostRemoteDriverViaUnifiedRouter } from '../remoteDriverRouterSelection.js'
import type { LogicalModelBindingReader } from '../unifiedPlacementRouter.js'

const OP_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const PROFILE_A = '33333333-3333-4333-8333-333333333331'
const PROFILE_B = '33333333-3333-4333-8333-333333333332'
const NODE_A = '44444444-4444-4444-8444-444444444441'
const NODE_B = '44444444-4444-4444-8444-444444444442'
const DISPATCH_ID = '55555555-5555-4555-8555-555555555555'
const NATIVE_SESS = '66666666-6666-4666-8666-666666666666'

function makeProbeSnapshot(opts: {
  driverId: string
  engineId: string
  upstreamModelId: string
  supportsVision: boolean
}): RemoteProbeSnapshot {
  return {
    schemaVersion: 4,
    engineId: opts.engineId,
    driverId: opts.driverId,
    driverVersion: '4.0.0',
    source: 'cli:probe',
    freshness: 'cli-observed',
    authPresent: true,
    accountObserved: true,
    cliVersion: '1.0.0',
    cliSha256: 'a'.repeat(64),
    models: [
      {
        upstreamModelId: opts.upstreamModelId,
        displayName: opts.upstreamModelId,
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsAdaptiveThinking: true,
        supportsVision: opts.supportsVision,
      },
    ],
    rawResponseSha256: 'b'.repeat(64),
    observedAt: '2026-11-27T00:00:00.000Z',
  }
}

function makeValidExtendedControls(): readonly ExtendedRedControlEntry[] {
  return [
    {
      requirementId: 'R8',
      dimension: 'loopback_token_single_use',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'loopback_replay',
      evidenceDigest: remoteCanonicalSha256({ r: 'R8' }),
    },
    {
      requirementId: 'R9',
      dimension: 'tool_policy_parity',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'policy_relax',
      evidenceDigest: remoteCanonicalSha256({ r: 'R9' }),
    },
    {
      requirementId: 'R10',
      dimension: 'fencing_token_monotonic',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'stale_fencing_token',
      evidenceDigest: remoteCanonicalSha256({ r: 'R10' }),
    },
    {
      requirementId: 'R11',
      dimension: 'schema_filtered_observation',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'arg_tamper',
      evidenceDigest: remoteCanonicalSha256({ r: 'R11' }),
    },
  ]
}

describe('OCV5-915 P3-1: UnifiedPlacementRouter Selection, Parity Gate & Billing V5', () => {
  it('selectSelfhostRemoteDriverViaUnifiedRouter is strictly selfhost-gated and enforces uncommissioned guard, cache affinity, capability superset, and Q1 binding fallthrough', async () => {
    let queryCount = 0
    const mockPool = {
      async query() {
        queryCount += 1
        return { rows: [] }
      },
    } as unknown as Pool

    // 1. Commercial (`selfhost: false`) bypasses completely without touching PG.
    const commercialRes = await selectSelfhostRemoteDriverViaUnifiedRouter(mockPool, {
      selfhost: false,
      uid: 42,
      sessionKey: 'agent:main:webchat:dm:commercial_1',
      canonicalModel: 'claude-sonnet-4-6-remote',
      engine: 'ccb',
    })
    assert.equal(commercialRes.driverId, null)
    assert.equal(commercialRes.source, 'non_selfhost_bypass')
    assert.equal(queryCount, 0)

    // 2. Uncommissioned staging guard: staging v4 row does NOT hijack healthy legacy offer.
    const stagingPool = {
      async query(sql: string) {
        if (sql.includes('remote_agent_bindings')) return { rows: [] }
        if (sql.includes('remote_model_offers')) {
          return {
            rows: [
              {
                driver_id: 'cc',
                profile_id: PROFILE_A,
                node_id: NODE_A,
                execution_ready: false,
                verified_fingerprint: null,
                weight: 100,
                max_concurrent_lanes: 5,
                active_slots: 0,
                probe_snapshot: null,
                upstream_model_id: 'claude-sonnet-4-6',
                canonical_model_id: 'claude-sonnet-4-6-remote',
                has_healthy_legacy_offer: true,
              },
            ],
          }
        }
        return { rows: [] }
      },
    } as unknown as Pool

    const guarded = await selectSelfhostRemoteDriverViaUnifiedRouter(stagingPool, {
      selfhost: true,
      uid: 42,
      sessionKey: 'agent:main:webchat:dm:staging_guard_1',
      canonicalModel: 'claude-sonnet-4-6-remote',
      engine: 'ccb',
    })
    assert.equal(guarded.driverId, null)
    assert.equal(guarded.source, 'legacy_uncommissioned_guard')

    // 3. Capability superset (vision) + WRH cache affinity + unconfigured binding Q1 fallthrough.
    const dualOfferPool = {
      async query(sql: string) {
        if (sql.includes('remote_agent_bindings')) return { rows: [] }
        if (sql.includes('model_logical_pool_bindings')) return { rows: [] }
        if (sql.includes('remote_model_offers')) {
          return {
            rows: [
              {
                driver_id: 'cc',
                profile_id: PROFILE_A,
                node_id: NODE_A,
                execution_ready: true,
                verified_fingerprint: 'a'.repeat(64),
                weight: 200,
                max_concurrent_lanes: 5,
                active_slots: 0,
                probe_snapshot: makeProbeSnapshot({
                  driverId: 'cc',
                  engineId: 'cc',
                  upstreamModelId: 'claude-sonnet-4-6',
                  supportsVision: false,
                }),
                upstream_model_id: 'claude-sonnet-4-6',
                canonical_model_id: 'claude-sonnet-4-6-remote',
                rtt_ms_p50: 15,
                has_healthy_legacy_offer: false,
              },
              {
                driver_id: 'cc',
                profile_id: PROFILE_B,
                node_id: NODE_B,
                execution_ready: true,
                verified_fingerprint: 'b'.repeat(64),
                weight: 100,
                max_concurrent_lanes: 5,
                active_slots: 0,
                probe_snapshot: makeProbeSnapshot({
                  driverId: 'cc',
                  engineId: 'cc',
                  upstreamModelId: 'claude-sonnet-4-6',
                  supportsVision: true,
                }),
                upstream_model_id: 'claude-sonnet-4-6',
                canonical_model_id: 'claude-sonnet-4-6-remote',
                rtt_ms_p50: 25,
                has_healthy_legacy_offer: false,
              },
            ],
          }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    } as unknown as Pool

    // Vision requirement MUST pick PROFILE_B (the only vision-capable profile), even though PROFILE_A has higher weight.
    const visionSel = await selectSelfhostRemoteDriverViaUnifiedRouter(dualOfferPool, {
      selfhost: true,
      uid: 42,
      sessionKey: 'agent:main:webchat:dm:vision_req_1',
      canonicalModel: 'claude-sonnet-4-6-remote',
      engine: 'ccb',
      requiredCapabilities: { needsVision: true },
    })
    assert.equal(visionSel.driverId, 'cc')
    assert.equal(visionSel.selectedProfileId, PROFILE_B)
    assert.equal(visionSel.source, 'unified_placement_router')

    // Cache affinity key hit promotes PROFILE_B on non-vision turns too.
    const sessionKeyAff = 'agent:main:webchat:dm:cache_affinity_1'
    const affKey = computeCacheAffinityKey({
      tenantId: '42',
      sessionKey: sessionKeyAff,
      logicalModel: 'claude-sonnet-4-6',
    })
    const affSel = await selectSelfhostRemoteDriverViaUnifiedRouter(
      dualOfferPool,
      {
        selfhost: true,
        uid: 42,
        sessionKey: sessionKeyAff,
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
      },
      { cachedAffinityByProfile: new Map([[PROFILE_B, new Set([affKey])]]) },
    )
    assert.equal(affSel.selectedProfileId, PROFILE_B)
    assert.equal(affSel.routeResult?.ok, true)
    assert.equal(affSel.routeResult?.ok && affSel.routeResult.cacheAffinityHit, true)

    // Configured bindingStore disabling vision fails closed with CAPABILITY_UNSATISFIED (Red Line #1).
    const strictBindings: LogicalModelBindingReader = {
      async inspectLogicalModelBindings() {
        return {
          status: 'configured',
          resolved: {
            logicalModel: 'claude-sonnet-4-6',
            poolPreference: 'pin_remote',
            isLegacyRemoteAlias: true,
          },
          bindings: [
            {
              logicalModelId: 'claude-sonnet-4-6',
              poolKind: 'remote_pool',
              driverId: 'cc',
              canonicalModelId: 'claude-sonnet-4-6-remote',
              priority: 100,
              enabled: true,
              capabilities: {
                logicalModel: 'claude-sonnet-4-6',
                supportsVision: false,
                supportedEfforts: ['medium'],
                defaultEffort: 'medium',
                supportedServiceTiers: ['standard'],
                supportsReadOnly: true,
                supportsConsultTurn: true,
                supportsHermeticNoTools: true,
                supportsSwarm: true,
              },
            },
          ],
          enabledBindings: [],
          allConfiguredBindings: [],
          totalCount: 1,
          hasConfiguredBindings: true,
        }
      },
      async resolveBindingsForModel() {
        return {
          resolved: {
            logicalModel: 'claude-sonnet-4-6',
            poolPreference: 'pin_remote',
            isLegacyRemoteAlias: true,
          },
          bindings: [
            {
              logicalModelId: 'claude-sonnet-4-6',
              poolKind: 'remote_pool',
              driverId: 'cc',
              canonicalModelId: 'claude-sonnet-4-6-remote',
              priority: 100,
              enabled: true,
              capabilities: {
                logicalModel: 'claude-sonnet-4-6',
                supportsVision: false,
                supportedEfforts: ['medium'],
                defaultEffort: 'medium',
                supportedServiceTiers: ['standard'],
                supportsReadOnly: true,
                supportsConsultTurn: true,
                supportsHermeticNoTools: true,
                supportsSwarm: true,
              },
            },
          ],
        }
      },
    }
    await assert.rejects(
      selectSelfhostRemoteDriverViaUnifiedRouter(
        dualOfferPool,
        {
          selfhost: true,
          uid: 42,
          sessionKey: 'agent:main:webchat:dm:binding_reject_1',
          canonicalModel: 'claude-sonnet-4-6-remote',
          engine: 'ccb',
          requiredCapabilities: { needsVision: true },
        },
        { bindingStore: strictBindings },
      ),
      /CAPABILITY_UNSATISFIED/,
    )
  })

  it('verifyDualPoolParityConformance & RemoteDriverV4CommissioningService gate cutover before spend and report parity in getProfileStatus', async () => {
    const regMap = loadRemoteDriverRegistry()
    const ccReg = regMap.get('cc')
    assert.ok(ccReg)

    // 1. Valid extended red proof passes all 3 checks.
    const validArtifact = buildExtendedRedProofArtifact({
      baseProofSha256: 'c'.repeat(64),
      driverId: 'cc',
      controls: makeValidExtendedControls(),
    })
    const passedGate = await verifyDualPoolParityConformance({
      driverId: 'cc',
      canonicalModel: 'claude-sonnet-4-6-remote',
      extendedRedProofArtifact: validArtifact,
      expectedBaseProofSha256: 'c'.repeat(64),
    })
    assert.equal(passedGate.ok, true)
    assert.equal(passedGate.extendedRedProofStatus, 'verified')
    assert.equal(passedGate.receiptParity?.semanticDigestMatch, true)

    // 2. Tampered extended red proof fails closed BEFORE any containerSource/probe spend in commissioningService.
    let containerCalls = 0
    let probeCalls = 0
    const settledJobs: Array<Record<string, unknown>> = []
    let resolveSettled!: () => void
    const settledDone = new Promise<void>((r) => {
      resolveSettled = r
    })

    const fakePool = {
      async query(sql: string) {
        if (sql.includes('SELECT 1 FROM remote_agent_profiles')) return { rows: [{ '?column?': 1 }] }
        if (sql.includes('SELECT driver_id, engine FROM remote_agent_profiles')) {
          return { rows: [{ driver_id: 'cc', engine: 'cc' }] }
        }
        if (sql.includes('SELECT p.id, p.node_id')) {
          return {
            rows: [
              {
                id: PROFILE_A,
                node_id: NODE_A,
                profile_name: 'p31-test',
                engine: 'cc',
                driver_id: 'cc',
                engine_id: 'cc',
                status: 'active',
                disabled_by: null,
                execution_ready: true,
                ready_generation: '1',
                verified_fingerprint: 'a'.repeat(64),
                target_fingerprint: 'a'.repeat(64),
                auth_epoch: 'epoch-1',
                max_concurrent_lanes: 5,
                last_probe_ok_at: new Date(),
                updated_at: new Date(),
              },
            ],
          }
        }
        if (sql.includes('FROM remote_model_offers')) {
          return {
            rows: [
              {
                canonical_model_id: 'claude-sonnet-4-6-remote',
                upstream_model_id: 'claude-sonnet-4-6',
                enabled: true,
              },
            ],
          }
        }
        if (sql.includes('COUNT(*)')) return { rows: [{ cnt: '1' }] }
        if (sql.includes('FROM remote_driver_verification_runs')) return { rows: [] }
        return { rows: [] }
      },
    } as unknown as Pool

    const svc = new RemoteDriverV4CommissioningService({
      executorDeps: {
        pool: fakePool,
        preCheckRedis: {} as PreCheckRedis,
        catalog: {} as never,
        keyring: () => new Map(),
        signer: {} as never,
        loadUserModelAuthz: async () => ({ role: 'admin', grantedModelIds: new Set() }),
        log: createLogger({ out: () => undefined }),
        containerSource: async () => {
          containerCalls += 1
          return null
        },
      },
      probeHostFactory: () => {
        probeCalls += 1
        throw new Error('must never spend on probe when parity precheck fails')
      },
      extendedRedProofArtifact: { ...validArtifact, extendedProofSha256: '0'.repeat(64) },
      onJobSettled: (job) => {
        settledJobs.push(job as unknown as Record<string, unknown>)
        resolveSettled()
      },
    })

    await svc.startReverify({ profileId: PROFILE_A }, 3)
    await settledDone
    const settledJob = settledJobs[0]
    assert.equal(settledJob?.status, 'failed')
    assert.match(String(settledJob?.error ?? ''), /REMOTE_EXTENDED_RED_PROOF_INVALID/)
    assert.equal(containerCalls, 0, 'precheck failure must block BEFORE container/probe spend')
    assert.equal(probeCalls, 0, 'precheck failure must block BEFORE probe spend')

    // getProfileStatus exposes the recorded dualPoolParity failure cleanly.
    const status = await svc.getProfileStatus(PROFILE_A)
    const parityStatus = status.dualPoolParity as { status: string; ok: boolean; errorCode?: string }
    assert.equal(parityStatus.status, 'failed')
    assert.equal(parityStatus.ok, false)
    assert.equal(parityStatus.errorCode, 'REMOTE_EXTENDED_RED_PROOF_INVALID')
  })

  it('Q1 backward compat: remoteDriverTurnBilling recovers pre-upgrade rows without turnReceiptV5 and persists validated turnReceiptV5 on spool recovery', async () => {
    const policy: RemoteDriverUsagePolicy = {
      semanticsId: 'cc-result-per-turn-v1',
      mode: 'per_turn',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cache_read_input_tokens',
      cacheWriteField: 'cache_creation_input_tokens',
      inputIncludesCacheRead: false,
      outputIncludesReasoning: true,
      allowCacheWrite: true,
    }
    const turnKey = 'f'.repeat(64)
    const scope: RemoteDriverScopeV4 = {
      version: 4,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId: OP_ID,
      runId: RUN_ID,
      uid: '42',
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:p31_billing_v5_1',
      canonicalModel: 'claude-opus-5-5-remote',
      upstreamModel: 'claude-opus-5-5',
      driverId: 'cc',
      engineId: 'cc',
      authorityEngine: 'ccb',
      driverVersion: '4.0.0',
      driverDigest: 'b'.repeat(64),
      coreDigest: 'c'.repeat(64),
      probeFingerprint: 'd'.repeat(64),
      manifestSha256: 'e'.repeat(64),
      generation: '1',
      profileId: 'prof-cc-1',
      authEpoch: 'epoch-1',
      expiresAt: Date.now() + 3_600_000,
    }
    const receiptV4 = buildRemoteReceiptV4({
      engineId: scope.engineId,
      driverId: scope.driverId,
      driverVersion: scope.driverVersion,
      driverDigest: scope.driverDigest,
      uid: scope.uid,
      containerDbId: scope.containerDbId,
      dockerId: scope.dockerId,
      operationId: scope.operationId,
      runId: scope.runId,
      sessionKey: scope.sessionKey,
      canonicalModel: scope.canonicalModel,
      upstreamModel: scope.upstreamModel,
      profileId: scope.profileId,
      authEpoch: scope.authEpoch,
      authorityTurnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      turnKey,
      requestId: 'req_v5_billing_1',
      nativeSessionId: NATIVE_SESS,
      terminalId: 'term-v5-1',
      policy,
      countersBaseline: null,
      countersFinal: {
        input_tokens: 2000,
        output_tokens: 500,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
      nativeStatus: 'success',
      rawEvidenceDigest: '9'.repeat(64),
      provenance: {
        generation: scope.generation,
        manifestHash: scope.manifestSha256,
        coreDigest: scope.coreDigest,
        probeFingerprint: scope.probeFingerprint,
      },
    })

    // 1. Verify driverReceiptStamp byte-identical 20-key structure and v5 receipt semantic parity.
    const stamp = driverReceiptStamp(receiptV4)
    assert.equal(Object.keys(stamp).length, 20)
    assert.equal(stamp.receiptDigest, receiptV4.receiptDigest)

    const v5 = buildRemoteDriverTurnReceiptV5({
      scope,
      receiptV4,
      finalizedAt: '2026-11-27T00:00:00.000Z',
    })
    const validatedV5 = validateRemoteDriverTurnReceiptV5(v5, scope, receiptV4)
    const counterpartLocal = buildTurnReceiptV5FromLocalOutcome({
      poolKind: 'local_pool',
      authorityEngine: 'ccb',
      tenantId: scope.uid,
      sessionKey: scope.sessionKey,
      turnId: receiptV4.authorityTurnId,
      turnKey,
      requestId: receiptV4.requestId,
      logicalModel: 'claude-opus-5-5',
      canonicalModel: scope.canonicalModel,
      upstreamModel: scope.upstreamModel,
      usageSemantics: policy.semanticsId,
      usage: receiptV4.usage,
      status: 'success',
      finalizedAt: '2026-11-27T00:00:00.000Z',
    })
    assert.equal(verifyDualPoolReceiptParity(counterpartLocal, validatedV5).ok, true)

    // Tampered v5 receipt fails closed.
    assert.throws(
      () => validateRemoteDriverTurnReceiptV5({ ...v5, driverId: 'codex' }, scope, receiptV4),
      /TURN_RECEIPT_V5_DIGEST_MISMATCH|REMOTE_TURN_RECEIPT_V5_SCOPE_MISMATCH/,
    )

    // 2. Q1: Pre-upgrade inflight row (has `receipt`, NO `turnReceiptV5`, `price_snapshot` has ONLY `remote_native`) proves cleanly!
    const preUpgradeCtx = {
      v: 4 as const,
      scope,
      requestId: receiptV4.requestId,
      turnKey,
      authorityTurnId: receiptV4.authorityTurnId,
      dispatchId: DISPATCH_ID,
      attemptNo: 1,
      sessionId: 'p31_billing_v5_1',
      pricing: {
        v: 1 as const,
        modelId: scope.canonicalModel,
        displayName: scope.canonicalModel,
        inputPerMtok: '1000',
        outputPerMtok: '2000',
        cacheReadPerMtok: '100',
        cacheWritePerMtok: '500',
        multiplier: '1.000',
      },
      billingRevision: 'rev-1',
      authority: {
        kind: 'bridge_signed' as const,
        executionRevision: 'exec-1',
        projectionRevision: null,
        securityEpoch: '1',
      },
      usagePolicy: policy,
      hostStartAttempted: true,
      input: { sequence: 1, inputSha256: '8'.repeat(64) },
      native: { sessionId: NATIVE_SESS, baseline: null },
      receipt: receiptV4,
      reserved: true,
      reservedCredits: '100',
    }
    // Expected cost: (2000*1000 + 500*2000 + 100*100) * 1000 / 1e9 = 3.01 -> ceil = 4n fen.
    let releasedPreUpgrade = 0
    const preUpgradePool = {
      async query(sql: string) {
        if (sql.includes('remote-driver-v4:readback')) {
          return {
            rows: [
              {
                state: 'committed',
                ctx: {
                  remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                  remoteDriverV4: preUpgradeCtx,
                },
                usage_id: '9001',
                ledger_id: '7001',
                cost_credits: '4',
                account_id: null,
                model: scope.canonicalModel,
                container_id: scope.containerDbId,
                session_id: preUpgradeCtx.sessionId,
                turn_key: turnKey,
                dispatch_id: DISPATCH_ID,
                attempt_no: 1,
                status: 'success',
                input_tokens: '2000',
                output_tokens: '500',
                cache_read_tokens: '100',
                cache_write_tokens: '0',
                price_snapshot: {
                  model_id: scope.canonicalModel,
                  input_per_mtok: '1000',
                  output_per_mtok: '2000',
                  cache_read_per_mtok: '100',
                  cache_write_per_mtok: '500',
                  multiplier: '1.000',
                  remote_native: stamp,
                  // Deliberately NO turn_receipt_v5 (pre-upgrade row!).
                },
                execution_revision: 'exec-1',
                security_epoch: '1',
                authority_kind: 'bridge_signed',
              },
            ],
          }
        }
        if (sql.includes('FROM usage_records') && sql.includes('request_id')) {
          return {
            rows: [
              {
                id: '9001',
                ledger_id: '7001',
                cost_credits: '4',
                attribution_credits: '4',
              },
            ],
          }
        }
        if (sql.includes('remote-driver-v4:release-boundary')) {
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected pre-upgrade SQL: ${sql}`)
      },
    } as unknown as Pool

    const redis = {
      async releaseReservation() {
        releasedPreUpgrade += 1
        return true
      },
    } as unknown as PreCheckRedis

    const preRes = await recoverRemoteDriverTurnBilling(
      { pool: preUpgradePool, preCheckRedis: redis, log: createLogger({ out: () => undefined }) },
      {
        preloadedRows: [
          {
            request_id: receiptV4.requestId,
            user_id: scope.uid,
            state: 'committed',
            ctx: {
              remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
              remoteDriverV4: preUpgradeCtx,
            },
          },
        ],
      },
    )
    assert.deepEqual(preRes, { proven: 1, pending: 0 })
    assert.equal(releasedPreUpgrade, 1)

    // 3. Post-upgrade spool recovery generates, persists, and settles TurnReceiptV5 alongside remote_native.
    const tmpRoot = mkdtempSync('/tmp/ocv5-p31-spool-')
    try {
      const journalDir = join(tmpRoot, OP_ID, '1', 'journal')
      mkdirSync(journalDir, { recursive: true, mode: 0o700 })
      const termPath = join(journalDir, '00000001-native-terminal.json')
      writeFileSync(termPath, JSON.stringify(receiptV4), { mode: 0o600 })
      chmodSync(termPath, 0o600)

      const persistedV5s: TurnReceiptV5[] = []
      const settledBox: { snapshot: Record<string, unknown> | null } = { snapshot: null }
      const inflightCtx = { ...preUpgradeCtx, receipt: null as unknown }
      let journalState = 'inflight'
      let storedJournalCtx: Record<string, unknown> = structuredClone(inflightCtx)

      const fakeClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
          if (sql.includes('FROM remote_native_threads')) {
            return { rows: [{ pending_request_id: receiptV4.requestId, total: null }] }
          }
          if (sql.includes('FROM remote_native_turns')) return { rows: [] }
          if (sql.includes('INSERT INTO remote_native_turns')) return { rows: [], rowCount: 1 }
          if (sql.includes('UPDATE remote_native_threads')) return { rows: [], rowCount: 1 }
          if (sql.includes('UPDATE request_finalize_journal') && sql.includes('turnReceiptV5')) {
            const candidate = JSON.parse(String(params?.[4])) as TurnReceiptV5
            persistedV5s.push(candidate)
            storedJournalCtx = {
              ...storedJournalCtx,
              receipt: receiptV4,
              turnReceiptV5: candidate,
            }
            return { rows: [{ persisted_turn_receipt_v5: candidate }], rowCount: 1 }
          }
          throw new Error(`unexpected client SQL: ${sql}`)
        },
        release() {},
      }

      const spoolPool = {
        async connect() {
          return fakeClient
        },
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('remote-driver-v4:readback')) {
            if (!settledBox.snapshot) return { rows: [] }
            return {
              rows: [
                {
                  state: journalState,
                  ctx: {
                    remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                    remoteDriverV4: storedJournalCtx,
                  },
                  usage_id: '9002',
                  ledger_id: '7002',
                  cost_credits: '4',
                  account_id: null,
                  model: scope.canonicalModel,
                  container_id: scope.containerDbId,
                  session_id: preUpgradeCtx.sessionId,
                  turn_key: turnKey,
                  dispatch_id: DISPATCH_ID,
                  attempt_no: 1,
                  status: 'success',
                  input_tokens: '2000',
                  output_tokens: '500',
                  cache_read_tokens: '100',
                  cache_write_tokens: '0',
                  price_snapshot: settledBox.snapshot,
                  execution_revision: 'exec-1',
                  security_epoch: '1',
                  authority_kind: 'bridge_signed',
                },
              ],
            }
          }
          if (sql.includes('settlementClaimId') && sql.includes("state='finalizing'")) {
            journalState = 'finalizing'
            return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
          }
          if (sql.includes("SET state='committed'") || sql.includes("SET state = 'committed'")) {
            journalState = 'committed'
            return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
          }
          if (sql.includes('FROM usage_records') && sql.includes('request_id')) {
            return {
              rows: [
                {
                  id: '9002',
                  ledger_id: '7002',
                  cost_credits: '4',
                  attribution_credits: '4',
                },
              ],
            }
          }
          if (sql.includes('remote-driver-v4:release-boundary')) return { rows: [], rowCount: 1 }
          throw new Error(`unexpected spoolPool SQL: ${sql} params=${JSON.stringify(params)}`)
        },
      } as unknown as Pool

      const fixedRealMs = Date.UTC(2026, 10, 27, 6, 0, 0)
      const fixedRealIso = new Date(fixedRealMs).toISOString()
      const spoolRes = await recoverRemoteDriverTurnBilling(
        { pool: spoolPool, preCheckRedis: redis, log: createLogger({ out: () => undefined }) },
        {
          evidenceRoot: tmpRoot,
          now: () => fixedRealMs,
          preloadedRows: [
            {
              request_id: receiptV4.requestId,
              user_id: scope.uid,
              state: 'inflight',
              ctx: {
                remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                remoteDriverV4: inflightCtx,
              },
            },
          ],
          settle: async (_pool, settleInput) => {
            assert.equal(settleInput.costCredits, 4n)
            settledBox.snapshot = JSON.parse(settleInput.snapshotJson) as Record<string, unknown>
            return {
              usageId: 9002n,
              ledgerId: 7002n,
              clamped: false,
              debitedCredits: 4n,
              attributionCredits: 4n,
              balanceAfter: 1000n,
              commitDisposition: 'new_commit' as const,
              settledCostCredits: 4n,
            }
          },
        },
      )
      assert.deepEqual(spoolRes, { proven: 1, pending: 0 })
      const persistedV5 = persistedV5s[0]
      assert.ok(persistedV5, 'turnReceiptV5 must be persisted into ctx.remoteDriverV4')
      assert.deepEqual(settledBox.snapshot?.remote_native, stamp)
      assert.deepEqual(settledBox.snapshot?.turn_receipt_v5, persistedV5)

      // B04 + B11 cross-end parity: Master persisted turnReceiptV5 uses real 2026+ wall clock and matches Gateway L0 buildTurnReceiptV5FromRemoteV4 byte-for-byte.
      assert.equal(persistedV5.finalizedAt, fixedRealIso)
      assert.ok(new Date(persistedV5.finalizedAt).getUTCFullYear() >= 2026)
      const gatewayProjectedV5 = buildTurnReceiptV5FromRemoteV4({
        receiptV4,
        authorityEngine: scope.authorityEngine,
        serviceTier: 'standard',
        placementEpoch: 1,
        finalizedAt: fixedRealIso,
      })
      assert.deepEqual(persistedV5, gatewayProjectedV5)
      assert.equal(persistedV5.semanticDigest, gatewayProjectedV5.semanticDigest)
      assert.equal(persistedV5.receiptDigest, gatewayProjectedV5.receiptDigest)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('B04 2-writer interleaved live-terminal + spool-recovery holds identical journal & snapshot TurnReceiptV5, passes readProofV4, and releases pending boundary', async () => {
    const policy: RemoteDriverUsagePolicy = {
      semanticsId: 'cc-result-per-turn-v1',
      mode: 'per_turn',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cache_read_input_tokens',
      inputIncludesCacheRead: false,
      outputIncludesReasoning: true,
      allowCacheWrite: false,
    }
    const ccReg = loadRemoteDriverRegistry().get('cc')!
    const scope: RemoteDriverScopeV4 = {
      version: 4,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId: OP_ID,
      runId: RUN_ID,
      uid: '42',
      containerDbId: '7',
      dockerId: 'b'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:p31_b04_race_1',
      canonicalModel: 'claude-sonnet-4-6-remote',
      upstreamModel: 'claude-sonnet-4-6',
      driverId: ccReg.driverId,
      engineId: ccReg.engineId,
      authorityEngine: ccReg.authorityEngine,
      driverVersion: ccReg.driverVersion,
      driverDigest: ccReg.driverDigest,
      coreDigest: ccReg.coreDigest,
      probeFingerprint: 'f'.repeat(64),
      manifestSha256: 'd'.repeat(64),
      generation: '1',
      profileId: PROFILE_A,
      authEpoch: 'epoch-1',
      expiresAt: Date.now() + 60_000,
    }
    const turnKey = remoteCanonicalSha256({ suite: 'p31-b04-2writer' })
    const receiptV4 = buildRemoteReceiptV4({
      engineId: scope.engineId,
      driverId: scope.driverId,
      driverVersion: scope.driverVersion,
      driverDigest: scope.driverDigest,
      uid: scope.uid,
      containerDbId: scope.containerDbId,
      dockerId: scope.dockerId,
      operationId: scope.operationId,
      runId: scope.runId,
      sessionKey: scope.sessionKey,
      canonicalModel: scope.canonicalModel,
      upstreamModel: scope.upstreamModel,
      profileId: scope.profileId,
      authEpoch: scope.authEpoch,
      authorityTurnId: 'b0400000000000000000000000000001',
      turnKey,
      requestId: 'req_b04_interleaved_1',
      nativeSessionId: NATIVE_SESS,
      terminalId: 'term_b04_1',
      policy,
      countersBaseline: null,
      countersFinal: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 100 },
      nativeStatus: 'success',
      rawEvidenceDigest: '9'.repeat(64),
      provenance: {
        generation: scope.generation,
        manifestHash: scope.manifestSha256,
        coreDigest: scope.coreDigest,
        probeFingerprint: scope.probeFingerprint,
      },
    })

    // 1. B04 real wall-clock timestamp proof (NEVER fabricated 2025 hash date!).
    const beforeMs = Date.now()
    const realClockV5 = buildRemoteDriverTurnReceiptV5({ scope, receiptV4 })
    const afterMs = Date.now()
    const parsedRealMs = Date.parse(realClockV5.finalizedAt)
    assert.ok(
      new Date(realClockV5.finalizedAt).getUTCFullYear() >= 2026,
      `finalizedAt must be real >= 2026 timestamp, got ${realClockV5.finalizedAt}`,
    )
    assert.ok(parsedRealMs >= beforeMs - 1000 && parsedRealMs <= afterMs + 1000)

    // 2. Interleaved 2-writer race where Writer 1 already persisted its real-clock V5 (`winnerV5` at
    // 2026-11-27T06:00:00Z) into `request_finalize_journal`, and Writer 2 (spool recovery running 5 minutes
    // later at 2026-11-27T06:05:00Z) runs `COALESCE ... RETURNING`, MUST adopt `winnerV5` from `RETURNING`
    // before winning settlement CAS so `price_snapshot` matches journal verbatim, `readProofV4` passes,
    // and `remote_native_threads.pending_request_id` releases to NULL!
    const writer1ClockMs = Date.UTC(2026, 10, 27, 6, 0, 0)
    const writer2ClockMs = Date.UTC(2026, 10, 27, 6, 5, 0)
    const winnerV5 = buildRemoteDriverTurnReceiptV5({
      scope,
      receiptV4,
      finalizedAt: new Date(writer1ClockMs).toISOString(),
    })
    const writer2CandidateV5 = buildRemoteDriverTurnReceiptV5({
      scope,
      receiptV4,
      finalizedAt: new Date(writer2ClockMs).toISOString(),
    })
    assert.equal(winnerV5.semanticDigest, writer2CandidateV5.semanticDigest)
    assert.notEqual(winnerV5.receiptDigest, writer2CandidateV5.receiptDigest)

    const tmpRoot = mkdtempSync('/tmp/oc-p31-b04-race-')
    try {
      const journalDir = join(tmpRoot, scope.operationId, scope.generation, 'journal')
      mkdirSync(journalDir, { recursive: true })
      const spoolFile = join(journalDir, '00000001-native-terminal.json')
      writeFileSync(spoolFile, JSON.stringify(receiptV4), 'utf8')
      chmodSync(spoolFile, 0o600)

      // Shared stateful DB table simulating two independent PG connections:
      let journalState: 'inflight' | 'finalizing' | 'committed' = 'inflight'
      let journalCtx: Record<string, unknown> = {
        v: 4 as const,
        scope,
        requestId: receiptV4.requestId,
        turnKey,
        authorityTurnId: receiptV4.authorityTurnId,
        dispatchId: DISPATCH_ID,
        attemptNo: 1,
        sessionId: 'p31_b04_sess_1',
        pricing: {
          v: 1 as const,
          modelId: scope.canonicalModel,
          displayName: scope.canonicalModel,
          inputPerMtok: '1000',
          outputPerMtok: '2000',
          cacheReadPerMtok: '100',
          cacheWritePerMtok: '500',
          multiplier: '1.000',
        },
        billingRevision: 'rev-1',
        authority: {
          kind: 'bridge_signed' as const,
          executionRevision: 'exec-1',
          projectionRevision: null,
          securityEpoch: '1',
        },
        usagePolicy: policy,
        hostStartAttempted: true,
        input: { sequence: 1, inputSha256: '8'.repeat(64) },
        native: { sessionId: NATIVE_SESS, baseline: null },
        // Writer 1 already persisted receipt + winnerV5 before Writer 2 starts persistDriverReceiptV4!
        receipt: receiptV4,
        turnReceiptV5: winnerV5,
        reserved: true,
        reservedCredits: '100',
      }
      const settledBox: { snapshot: Record<string, unknown> | null } = { snapshot: null }
      let usageInsertCount = 0
      let pendingRequestId: string | null = receiptV4.requestId

      const makeClient = () => ({
        async query(sql: string, params?: unknown[]) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
          if (sql.includes('FROM remote_native_threads') && sql.includes('FOR UPDATE')) {
            return { rows: [{ pending_request_id: pendingRequestId, total: {} }] }
          }
          if (sql.includes('FROM remote_native_turns')) {
            // Writer 1 already inserted into remote_native_turns with the identical V4 receipt!
            return {
              rows: [
                {
                  uid: scope.uid,
                  operation_id: scope.operationId,
                  native_thread_id: NATIVE_SESS,
                  native_turn_id: receiptV4.terminalId,
                  request_id: receiptV4.requestId,
                  receipt_sha256: receiptV4.receiptDigest,
                  semantic_digest: receiptV4.semanticDigest,
                  receipt: receiptV4,
                },
              ],
            }
          }
          if (sql.includes('UPDATE request_finalize_journal') && sql.includes('turnReceiptV5')) {
            assert.equal(sql.includes('RETURNING'), true, 'persistDriverReceiptV4 MUST use RETURNING for authoritative turnReceiptV5')
            // Simulate PostgreSQL COALESCE(ctx#>'{remoteDriverV4,turnReceiptV5}', $5::jsonb):
            const existing = journalCtx.turnReceiptV5
            const candidate = JSON.parse(String(params?.[4] ?? 'null')) as TurnReceiptV5
            const winning = existing ?? candidate
            journalCtx = { ...journalCtx, receipt: receiptV4, turnReceiptV5: winning }
            return { rowCount: 1, rows: [{ persisted_turn_receipt_v5: winning }] }
          }
          throw new Error(`unexpected B04 client SQL: ${sql}`)
        },
        release() {},
      })

      const sharedPool = {
        async connect() {
          return makeClient()
        },
        async query(sql: string) {
          if (sql.includes('remote-driver-v4:readback')) {
            if (!settledBox.snapshot) return { rows: [] }
            return {
              rows: [
                {
                  state: journalState,
                  ctx: {
                    remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                    remoteDriverV4: journalCtx,
                  },
                  usage_id: '9100',
                  ledger_id: '7100',
                  cost_credits: '4',
                  account_id: null,
                  model: scope.canonicalModel,
                  container_id: scope.containerDbId,
                  session_id: 'p31_b04_sess_1',
                  turn_key: turnKey,
                  dispatch_id: DISPATCH_ID,
                  attempt_no: 1,
                  status: 'success',
                  input_tokens: '2000',
                  output_tokens: '500',
                  cache_read_tokens: '100',
                  cache_write_tokens: '0',
                  price_snapshot: settledBox.snapshot,
                  execution_revision: 'exec-1',
                  security_epoch: '1',
                  authority_kind: 'bridge_signed',
                },
              ],
            }
          }
          if (sql.includes("SET state='committed'") || sql.includes("SET state = 'committed'")) {
            journalState = 'committed'
            return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
          }
          if (sql.includes("SET state='finalizing'") || sql.includes("SET state = 'finalizing'")) {
            if (journalState !== 'inflight') return { rows: [], rowCount: 0 }
            journalState = 'finalizing'
            return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
          }
          if (sql.includes('FROM usage_records') && sql.includes('request_id')) {
            return {
              rows: [{ id: '9100', ledger_id: '7100', cost_credits: '4', attribution_credits: '4' }],
            }
          }
          if (sql.includes('remote-driver-v4:release-boundary')) {
            pendingRequestId = null
            return { rows: [], rowCount: 1 }
          }
          throw new Error(`unexpected B04 pool SQL: ${sql}`)
        },
      } as unknown as Pool

      // Writer 2 starts from an inflight context with receipt=null (stale pre-write snapshot),
      // imports spool receipt, hits COALESCE+RETURNING -> adopts winnerV5 -> wins CAS -> settles!
      const writer2StaleCtx: Record<string, unknown> = { ...journalCtx, receipt: null }
      Reflect.deleteProperty(writer2StaleCtx, 'turnReceiptV5')
      const logLines: string[] = []
      const res = await recoverRemoteDriverTurnBilling(
        {
          pool: sharedPool,
          preCheckRedis: { async releaseReservation() { return true } } as unknown as PreCheckRedis,
          log: createLogger({ out: (line) => logLines.push(line) }),
        },
        {
          evidenceRoot: tmpRoot,
          now: () => writer2ClockMs,
          preloadedRows: [
            {
              request_id: receiptV4.requestId,
              user_id: scope.uid,
              state: 'inflight',
              ctx: {
                remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                remoteDriverV4: writer2StaleCtx,
              },
            },
          ],
          settle: async (_pool, settleInput) => {
            usageInsertCount += 1
            settledBox.snapshot = JSON.parse(settleInput.snapshotJson) as Record<string, unknown>
            return {
              usageId: 9100n,
              ledgerId: 7100n,
              clamped: false,
              debitedCredits: 4n,
              attributionCredits: 4n,
              balanceAfter: 1000n,
              commitDisposition: 'new_commit' as const,
              settledCostCredits: 4n,
            }
          },
        },
      )

      assert.deepEqual(res, { proven: 1, pending: 0 }, `B04 logs=${logLines.join('\n')}`)
      assert.equal(usageInsertCount, 1, 'exactly one usage_records settlement')
      assert.deepEqual(
        settledBox.snapshot?.turn_receipt_v5,
        winnerV5,
        'price_snapshot.turn_receipt_v5 MUST adopt RETURNING winnerV5 from journal',
      )
      assert.deepEqual(journalCtx.turnReceiptV5, winnerV5)
      assert.equal(pendingRequestId, null, 'remote_native_threads pending boundary MUST release cleanly')
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('W01 remoteDriverRouterSelection distinguishes unconfigured binding table (42P01) from DB read errors', async () => {
    const makeOfferPool = () =>
      ({
        async query(sql: string) {
          if (sql.includes('FROM remote_agent_bindings')) return { rows: [] }
          if (sql.includes('FROM remote_model_offers')) {
            return {
              rows: [
                {
                  driver_id: 'cc',
                  profile_id: PROFILE_A,
                  node_id: NODE_A,
                  execution_ready: true,
                  verified_fingerprint: 'a'.repeat(64),
                  weight: 100,
                  max_concurrent_lanes: 4,
                  active_slots: 0,
                  probe_snapshot: makeProbeSnapshot({
                    driverId: 'cc',
                    engineId: 'cc',
                    upstreamModelId: 'claude-sonnet-4-6',
                    supportsVision: true,
                  }),
                  upstream_model_id: 'claude-sonnet-4-6',
                  canonical_model_id: 'claude-sonnet-4-6-remote',
                  rtt_ms_p50: 15,
                  has_healthy_legacy_offer: false,
                },
              ],
            }
          }
          return { rows: [] }
        },
      }) as unknown as Pool

    // 1. Missing table (PG 42P01) -> classified as 'unconfigured', no read error callback.
    let errCalls = 0
    const unconfRes = await selectSelfhostRemoteDriverViaUnifiedRouter(
      makeOfferPool(),
      {
        selfhost: true,
        uid: 42,
        sessionKey: 'agent:main:webchat:dm:p31_w01_unconf',
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
      },
      {
        bindingStore: {
          async resolveBindingsForModel() {
            const err = new Error('relation "model_logical_pool_bindings" does not exist') as Error & { code: string }
            err.code = '42P01'
            throw err
          },
        },
        onBindingReadError: () => {
          errCalls += 1
        },
      },
    )
    assert.equal(unconfRes.driverId, 'cc')
    assert.equal(unconfRes.bindingStatus, 'unconfigured')
    assert.equal(unconfRes.bindingReadError, undefined)
    assert.equal(errCalls, 0)

    // 2. Real storage/connection error -> surfaced as 'read_error' + onBindingReadError callback invoked!
    const reported: string[] = []
    const errRes = await selectSelfhostRemoteDriverViaUnifiedRouter(
      makeOfferPool(),
      {
        selfhost: true,
        uid: 42,
        sessionKey: 'agent:main:webchat:dm:p31_w01_err',
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
      },
      {
        bindingStore: {
          async resolveBindingsForModel() {
            throw new Error('PG_CONNECTION_RESET')
          },
        },
        onBindingReadError: (e) => {
          reported.push(e instanceof Error ? e.message : String(e))
        },
      },
    )
    assert.equal(errRes.driverId, 'cc')
    assert.equal(errRes.bindingStatus, 'read_error')
    assert.match(errRes.bindingReadError ?? '', /PG_CONNECTION_RESET/)
    assert.deepEqual(reported, ['PG_CONNECTION_RESET'])
  })

  it('B11 3-tier serviceTier parity (standard, fast, ultrafast): Master spool recovery & billing preserve durable serviceTier matching Gateway semanticDigest & receiptDigest', async () => {
    const policy: RemoteDriverUsagePolicy = {
      semanticsId: 'cc-result-per-turn-v1',
      mode: 'per_turn',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cache_read_input_tokens',
      inputIncludesCacheRead: false,
      outputIncludesReasoning: true,
      allowCacheWrite: false,
    }
    const ccReg = loadRemoteDriverRegistry().get('cc')!
    const fixedMs = Date.UTC(2026, 10, 27, 6, 45, 0)
    const fixedIso = new Date(fixedMs).toISOString()
    const semanticDigestsByTier = new Map<string, string>()

    for (const [idx, tier] of (['standard', 'fast', 'ultrafast'] as const).entries()) {
      const scope: RemoteDriverScopeV4 = {
        version: 4,
        backendKind: REMOTE_DRIVER_BACKEND,
        operationId: OP_ID,
        runId: RUN_ID,
        uid: '42',
        containerDbId: '7',
        dockerId: 'b'.repeat(64),
        sessionKey: `agent:main:webchat:dm:p31_b11_tier_${tier}`,
        canonicalModel: 'claude-sonnet-4-6-remote',
        upstreamModel: 'claude-sonnet-4-6',
        driverId: ccReg.driverId,
        engineId: ccReg.engineId,
        authorityEngine: ccReg.authorityEngine,
        driverVersion: ccReg.driverVersion,
        driverDigest: ccReg.driverDigest,
        coreDigest: ccReg.coreDigest,
        probeFingerprint: 'f'.repeat(64),
        manifestSha256: 'd'.repeat(64),
        generation: '1',
        profileId: PROFILE_A,
        authEpoch: 'epoch-1',
        expiresAt: Date.now() + 60_000,
      }
      const turnKey = remoteCanonicalSha256({ suite: 'p31-b11-tier-master', tier })
      const receiptV4 = buildRemoteReceiptV4({
        engineId: scope.engineId,
        driverId: scope.driverId,
        driverVersion: scope.driverVersion,
        driverDigest: scope.driverDigest,
        uid: scope.uid,
        containerDbId: scope.containerDbId,
        dockerId: scope.dockerId,
        operationId: scope.operationId,
        runId: scope.runId,
        sessionKey: scope.sessionKey,
        canonicalModel: scope.canonicalModel,
        upstreamModel: scope.upstreamModel,
        profileId: scope.profileId,
        authEpoch: scope.authEpoch,
        authorityTurnId: `b110000000000000000000000000077${idx}`,
        turnKey,
        requestId: `req_b11_master_${tier}`,
        nativeSessionId: NATIVE_SESS,
        terminalId: `term_b11_${tier}`,
        policy,
        countersBaseline: null,
        countersFinal: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 100 },
        nativeStatus: 'success',
        rawEvidenceDigest: '9'.repeat(64),
        provenance: {
          generation: scope.generation,
          manifestHash: scope.manifestSha256,
          coreDigest: scope.coreDigest,
          probeFingerprint: scope.probeFingerprint,
        },
      })

      const tmpRoot = mkdtempSync(`/tmp/oc-p31-b11-${tier}-`)
      try {
        const journalDir = join(tmpRoot, scope.operationId, scope.generation, 'journal')
        mkdirSync(journalDir, { recursive: true })
        const spoolFile = join(journalDir, '00000001-native-terminal.json')
        writeFileSync(spoolFile, JSON.stringify(receiptV4), 'utf8')
        chmodSync(spoolFile, 0o600)

        let journalState: 'inflight' | 'finalizing' | 'committed' = 'inflight'
        const inflightCtx: Record<string, unknown> = {
          v: 4 as const,
          scope,
          requestId: receiptV4.requestId,
          turnKey,
          authorityTurnId: receiptV4.authorityTurnId,
          dispatchId: DISPATCH_ID,
          attemptNo: 1,
          sessionId: `p31_b11_sess_${tier}`,
          pricing: {
            v: 1 as const,
            modelId: scope.canonicalModel,
            displayName: scope.canonicalModel,
            inputPerMtok: '1000',
            outputPerMtok: '2000',
            cacheReadPerMtok: '100',
            cacheWritePerMtok: '500',
            multiplier: '1.000',
          },
          billingRevision: 'rev-1',
          authority: {
            kind: 'bridge_signed' as const,
            executionRevision: 'exec-1',
            projectionRevision: null,
            securityEpoch: '1',
          },
          usagePolicy: policy,
          hostStartAttempted: true,
          // Durable serviceTier captured by beforeDispatch from relay.ts newTurn!
          input: { sequence: 1, inputSha256: '8'.repeat(64), serviceTier: tier },
          native: { sessionId: NATIVE_SESS, baseline: null },
          receipt: null,
          reserved: true,
          reservedCredits: '100',
        }
        let storedCtx: Record<string, unknown> = structuredClone(inflightCtx)
        const persistedList: TurnReceiptV5[] = []
        const settledBox: { snapshot: Record<string, unknown> | null } = { snapshot: null }

        const tierPool = {
          async connect() {
            return {
              async query(sql: string, params?: unknown[]) {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
                if (sql.includes('FROM remote_native_threads')) {
                  return { rows: [{ pending_request_id: receiptV4.requestId, total: {} }] }
                }
                if (sql.includes('FROM remote_native_turns')) return { rows: [] }
                if (sql.includes('INSERT INTO remote_native_turns')) return { rows: [], rowCount: 1 }
                if (sql.includes('UPDATE remote_native_threads')) return { rows: [], rowCount: 1 }
                if (sql.includes('UPDATE request_finalize_journal') && sql.includes('turnReceiptV5')) {
                  const cand = JSON.parse(String(params?.[4])) as TurnReceiptV5
                  persistedList.push(cand)
                  storedCtx = { ...storedCtx, receipt: receiptV4, turnReceiptV5: cand }
                  return { rows: [{ persisted_turn_receipt_v5: cand }], rowCount: 1 }
                }
                throw new Error(`unexpected tier client SQL: ${sql}`)
              },
              release() {},
            }
          },
          async query(sql: string) {
            if (sql.includes('remote-driver-v4:readback')) {
              if (!settledBox.snapshot) return { rows: [] }
              return {
                rows: [
                  {
                    state: journalState,
                    ctx: {
                      remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                      remoteDriverV4: storedCtx,
                    },
                    usage_id: '9200',
                    ledger_id: '7200',
                    cost_credits: '4',
                    account_id: null,
                    model: scope.canonicalModel,
                    container_id: scope.containerDbId,
                    session_id: `p31_b11_sess_${tier}`,
                    turn_key: turnKey,
                    dispatch_id: DISPATCH_ID,
                    attempt_no: 1,
                    status: 'success',
                    input_tokens: '2000',
                    output_tokens: '500',
                    cache_read_tokens: '100',
                    cache_write_tokens: '0',
                    price_snapshot: settledBox.snapshot,
                    execution_revision: 'exec-1',
                    security_epoch: '1',
                    authority_kind: 'bridge_signed',
                  },
                ],
              }
            }
            if (sql.includes("SET state='committed'") || sql.includes("SET state = 'committed'")) {
              journalState = 'committed'
              return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
            }
            if (sql.includes("SET state='finalizing'") || sql.includes("SET state = 'finalizing'")) {
              journalState = 'finalizing'
              return { rows: [{ request_id: receiptV4.requestId }], rowCount: 1 }
            }
            if (sql.includes('FROM usage_records') && sql.includes('request_id')) {
              return { rows: [{ id: '9200', ledger_id: '7200', cost_credits: '4', attribution_credits: '4' }] }
            }
            if (sql.includes('remote-driver-v4:release-boundary')) return { rows: [], rowCount: 1 }
            throw new Error(`unexpected tier pool SQL: ${sql}`)
          },
        } as unknown as Pool

        const tierRes = await recoverRemoteDriverTurnBilling(
          {
            pool: tierPool,
            preCheckRedis: { async releaseReservation() { return true } } as unknown as PreCheckRedis,
            log: createLogger({ out: () => undefined }),
          },
          {
            evidenceRoot: tmpRoot,
            now: () => fixedMs,
            preloadedRows: [
              {
                request_id: receiptV4.requestId,
                user_id: scope.uid,
                state: 'inflight',
                ctx: {
                  remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
                  remoteDriverV4: inflightCtx,
                },
              },
            ],
            settle: async (_pool, settleInput) => {
              settledBox.snapshot = JSON.parse(settleInput.snapshotJson) as Record<string, unknown>
              return {
                usageId: 9200n,
                ledgerId: 7200n,
                clamped: false,
                debitedCredits: 4n,
                attributionCredits: 4n,
                balanceAfter: 1000n,
                commitDisposition: 'new_commit' as const,
                settledCostCredits: 4n,
              }
            },
          },
        )
        assert.deepEqual(tierRes, { proven: 1, pending: 0 })
        const masterV5 = persistedList[0]
        assert.ok(masterV5)
        const gatewayV5 = buildTurnReceiptV5FromRemoteV4({
          receiptV4,
          authorityEngine: scope.authorityEngine,
          serviceTier: tier,
          placementEpoch: 1,
          finalizedAt: fixedIso,
        })
        assert.equal(masterV5.serviceTier, tier)
        assert.equal(masterV5.finalizedAt, fixedIso)
        assert.equal(masterV5.semanticDigest, gatewayV5.semanticDigest)
        assert.equal(masterV5.receiptDigest, gatewayV5.receiptDigest)
        assert.deepEqual(masterV5, gatewayV5)
        assert.deepEqual(settledBox.snapshot?.turn_receipt_v5, gatewayV5)
        // Byte-identical Q1 remote_native stamp untouched by serviceTier!
        assert.deepEqual(settledBox.snapshot?.remote_native, driverReceiptStamp(receiptV4))
        semanticDigestsByTier.set(tier, masterV5.semanticDigest)
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    }
    assert.notEqual(semanticDigestsByTier.get('fast'), semanticDigestsByTier.get('standard'))
    assert.notEqual(semanticDigestsByTier.get('ultrafast'), semanticDigestsByTier.get('standard'))
  })
})
