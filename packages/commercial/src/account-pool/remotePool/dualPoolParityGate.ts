/**
 * OCV5-915 P3-1 — Master-Side Dual-Pool Parity Conformance & `verifyExtendedRedProof` Precheck Gate.
 *
 * Runs before cutover/reverify job spend in `commissioningService.ts` and surfaces live
 * parity status in `getProfileStatus`.
 *
 * Module: accounts (L3).
 * - ZERO touch to `sandboxRedProof.ts`.
 * - ZERO imports from `@openclaude/gateway/*` (`R2-same-layer` + `R2-scope` clean); shares
 *   pure receipt & parity primitives exclusively via L0 `@openclaude/protocol`.
 * - ZERO `process.env`, `syncIo`, `emptyCatch`, `typeEscape`, `export *`, or engine literals.
 */
import {
  INFERENCE_SERVICE_TIERS,
  PLATFORM_REASONING_EFFORTS,
  authorityEngineToInferenceFamily,
  buildRemoteReceiptV4,
  buildTurnReceiptV5FromLocalOutcome,
  buildTurnReceiptV5FromRemoteV4,
  remoteCanonicalSha256,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  verifyDualPoolReceiptParity,
  type AuthorityEngineKind,
  type DualPoolReceiptParityResult,
  type LogicalModelCapability,
  type RemoteDriverUsagePolicy,
} from '@openclaude/protocol'
import {
  verifyExtendedRedProof,
  verifyFullR1ToR11Matrix,
  type VerifiedExtendedRedProof,
  type VerifiedFullR1ToR11Matrix,
} from './extendedRedProof.js'
import { loadRemoteDriverRegistry, type RemoteDriverRegistryEntry } from './registry.js'
import {
  UnifiedPlacementRouter,
  type PoolCandidateDescriptor,
} from './unifiedPlacementRouter.js'

export interface DualPoolParityGateInput {
  readonly driverId: string
  readonly canonicalModel?: string
  readonly upstreamModel?: string
  readonly registryPath?: string
  readonly extendedRedProofArtifact?: unknown
  readonly requireExtendedRedProof?: boolean
  readonly expectedBaseProofSha256?: string
  readonly expectedSuiteDigest?: string
  readonly redProofPath?: string
  readonly verifyFullMatrix?: boolean
  readonly now?: () => number
}

export interface DualPoolParityGateCheck {
  readonly checkId:
    | 'receipt_v4_to_v5_semantic_parity'
    | 'unified_router_dual_pool_parity'
    | 'extended_red_proof_r8_r11'
  readonly ok: boolean
  readonly detail: string
}

export interface DualPoolParityGateResult {
  readonly schemaVersion: 5
  readonly ok: boolean
  readonly driverId: string
  readonly canonicalModel: string
  readonly checkedAt: string
  readonly errorCode?: string
  readonly checks: readonly DualPoolParityGateCheck[]
  readonly parityDigest?: string
  readonly receiptParity?: DualPoolReceiptParityResult
  readonly extendedRedProofStatus:
    | 'verified'
    | 'verified_full_r1_r11_matrix'
    | 'not_provided_negative_control_ok'
    | 'failed'
  readonly extendedProofSha256?: string
  readonly combinedMatrixSha256?: string
}

export interface ProfileDualPoolParitySummary {
  readonly status: 'passed' | 'failed' | 'pending_v4_cutover'
  readonly ok: boolean
  readonly driverId: string | null
  readonly checkedAt: string
  readonly errorCode?: string
  readonly parityDigest?: string
  readonly extendedRedProofStatus?: DualPoolParityGateResult['extendedRedProofStatus']
  readonly extendedProofSha256?: string
  readonly checks?: readonly DualPoolParityGateCheck[]
}

const SYNTHETIC_USAGE_POLICY: RemoteDriverUsagePolicy = Object.freeze({
  semanticsId: 'dual-pool-parity-v5',
  mode: 'per_turn',
  inputField: 'input_tokens',
  outputField: 'output_tokens',
  cacheReadField: 'cache_read_input_tokens',
  cacheWriteField: 'cache_creation_input_tokens',
  inputIncludesCacheRead: false,
  outputIncludesReasoning: true,
  allowCacheWrite: true,
})

function buildDualPoolCandidates(params: {
  readonly reg: RemoteDriverRegistryEntry
  readonly logicalModel: string
  readonly upstreamModel: string
  readonly observedAt: string
}): readonly PoolCandidateDescriptor[] {
  const family = authorityEngineToInferenceFamily(params.reg.authorityEngine)
  const capRemote: LogicalModelCapability = Object.freeze({
    logicalModel: params.logicalModel,
    upstreamModelId: params.upstreamModel,
    supportsVision: true,
    supportedEfforts: Object.freeze([...PLATFORM_REASONING_EFFORTS]),
    defaultEffort: 'medium',
    supportedServiceTiers: Object.freeze([...INFERENCE_SERVICE_TIERS]),
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
  })
  const capLocalNoVision: LogicalModelCapability = Object.freeze({
    ...capRemote,
    supportsVision: false,
  })

  const localManifest = validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: 'local_pool',
    engineFamily: family,
    authorityEngine: params.reg.authorityEngine,
    driverId: `local-${family}`,
    driverVersion: params.reg.driverVersion,
    observedAt: params.observedAt,
    models: [capLocalNoVision],
  })
  const remoteManifest = validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: 'remote_pool',
    engineFamily: family,
    authorityEngine: params.reg.authorityEngine,
    driverId: params.reg.driverId,
    driverVersion: params.reg.driverVersion,
    observedAt: params.observedAt,
    models: [capRemote],
  })

  return Object.freeze([
    Object.freeze({
      poolKind: 'local_pool' as const,
      driverId: `local-${family}`,
      profileId: 'local-default',
      nodeId: 'local-host',
      manifest: localManifest,
      healthy: true,
      draining: false,
      activeSlots: 0,
      maxSlots: 4,
      weight: 100,
    }),
    Object.freeze({
      poolKind: 'remote_pool' as const,
      driverId: params.reg.driverId,
      profileId: 'remote-parity-prof',
      nodeId: 'remote-parity-node',
      manifest: remoteManifest,
      healthy: true,
      draining: false,
      activeSlots: 0,
      maxSlots: params.reg.profileMaxLanes,
      weight: 100,
    }),
  ])
}

function buildSyntheticParityReceipts(params: {
  readonly reg: RemoteDriverRegistryEntry
  readonly rawCanonical: string
  readonly logicalModel: string
  readonly upstreamModel: string
  readonly authEngine: AuthorityEngineKind
  readonly family: ReturnType<typeof authorityEngineToInferenceFamily>
  readonly checkedAt: string
}) {
  const { reg, rawCanonical, logicalModel, upstreamModel, authEngine, family, checkedAt } = params
  const turnKey = remoteCanonicalSha256({
    domain: 'oc-master-parity-turn-key',
    driverId: reg.driverId,
    canonicalModel: rawCanonical,
  })
  const rawEvidenceDigest = remoteCanonicalSha256({
    domain: 'oc-master-parity-evidence',
    driverId: reg.driverId,
    canonicalModel: rawCanonical,
  })
  const receiptV4 = buildRemoteReceiptV4({
    engineId: reg.engineId,
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    driverDigest: reg.driverDigest,
    uid: '3',
    containerDbId: '1',
    dockerId: 'a'.repeat(64),
    operationId: '00000000-0000-4000-8000-000000000101',
    runId: '00000000-0000-4000-8000-000000000202',
    sessionKey: 'agent:main:webchat:dm:parity_gate_check',
    canonicalModel: rawCanonical,
    upstreamModel,
    profileId: 'parity-profile-1',
    authEpoch: 'epoch-parity-1',
    authorityTurnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    turnKey,
    requestId: 'req_parity_gate_1',
    nativeSessionId: 'native-parity-1',
    terminalId: 'term-parity-1',
    policy: SYNTHETIC_USAGE_POLICY,
    countersBaseline: null,
    countersFinal: {
      input_tokens: 1_500,
      output_tokens: 600,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    },
    nativeStatus: 'success',
    rawEvidenceDigest,
    provenance: {
      generation: '1',
      manifestHash: 'b'.repeat(64),
      coreDigest: reg.coreDigest,
      probeFingerprint: 'c'.repeat(64),
    },
  })
  const remoteV5 = buildTurnReceiptV5FromRemoteV4({
    receiptV4,
    authorityEngine: authEngine,
    logicalModel,
    canonicalModel: rawCanonical,
    upstreamModel,
    serviceTier: 'standard',
    placementEpoch: 1,
    finalizedAt: checkedAt,
  })
  const localV5 = buildTurnReceiptV5FromLocalOutcome({
    poolKind: 'local_pool',
    authorityEngine: authEngine,
    engineFamily: family,
    driverId: `local-${family}`,
    driverVersion: reg.driverVersion,
    tenantId: '3',
    sessionKey: 'agent:main:webchat:dm:parity_gate_check',
    turnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    turnKey,
    requestId: 'req_parity_gate_1',
    logicalModel,
    canonicalModel: rawCanonical,
    upstreamModel,
    serviceTier: 'standard',
    placementEpoch: 1,
    usageSemantics: SYNTHETIC_USAGE_POLICY.semanticsId,
    usage: { inputTokens: 1_500, outputTokens: 600, cacheReadTokens: 200, cacheWriteTokens: 50 },
    status: 'success',
    rawEvidenceDigest,
    finalizedAt: checkedAt,
  })
  return { localV5, remoteV5 }
}

function runReceiptParityCheck(params: {
  readonly reg: RemoteDriverRegistryEntry
  readonly rawCanonical: string
  readonly logicalModel: string
  readonly upstreamModel: string
  readonly authEngine: AuthorityEngineKind
  readonly family: ReturnType<typeof authorityEngineToInferenceFamily>
  readonly checkedAt: string
}): {
  readonly check: DualPoolParityGateCheck
  readonly receiptParity?: DualPoolReceiptParityResult
  readonly errorCode?: string
} {
  try {
    const { localV5, remoteV5 } = buildSyntheticParityReceipts(params)
    const receiptParity = verifyDualPoolReceiptParity(localV5, remoteV5, {
      expectedLocalPoolKind: 'local_pool',
      expectedRemotePoolKind: 'remote_pool',
    })
    return {
      receiptParity,
      check: {
        checkId: 'receipt_v4_to_v5_semantic_parity',
        ok: receiptParity.ok,
        detail: receiptParity.ok
          ? `semantic_digest:${receiptParity.localSemanticDigest.slice(0, 16)}`
          : receiptParity.mismatchReasons.join(','),
      },
      ...(receiptParity.ok ? {} : { errorCode: 'DUAL_POOL_RECEIPT_PARITY_MISMATCH' }),
    }
  } catch (err) {
    return {
      errorCode: 'DUAL_POOL_RECEIPT_PARITY_ERROR',
      check: {
        checkId: 'receipt_v4_to_v5_semantic_parity',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

async function runRouterParityCheck(params: {
  readonly reg: RemoteDriverRegistryEntry
  readonly logicalModel: string
  readonly upstreamModel: string
  readonly checkedAt: string
}): Promise<{ readonly check: DualPoolParityGateCheck; readonly errorCode?: string }> {
  try {
    const candidates = buildDualPoolCandidates({
      reg: params.reg,
      logicalModel: params.logicalModel,
      upstreamModel: params.upstreamModel,
      observedAt: params.checkedAt,
    })
    const router = new UnifiedPlacementRouter({ candidates })
    const baseRoute = {
      rawModelId: params.logicalModel,
      sessionKey: 'agent:main:webchat:dm:parity_router_1',
      tenantId: '3',
    }
    const remotePin = await router.routeTurn({
      ...baseRoute,
      rawModelId: `${params.logicalModel}-remote`,
    })
    const localVision = await router.routeTurn({
      ...baseRoute,
      poolPreference: 'pin_local',
      requiredCapabilities: { needsVision: true },
    })
    const failedKey = remotePin.ok ? remotePin.selectedCandidateKey : 'remote'
    const postDispatch = await router.decideRetryAfterFailure({
      dispatched: true,
      failedCandidateKey: failedKey,
      errorCode: 'REMOTE_POOL_DRAINING_RETRY_LATER',
      allowCrossPoolMigration: true,
      originalRouteInput: baseRoute,
    })
    const preDispatch = await router.decideRetryAfterFailure({
      dispatched: false,
      failedCandidateKey: failedKey,
      failedPoolKind: 'remote_pool',
      errorCode: 'REMOTE_POOL_DRAINING_RETRY_LATER',
      allowCrossPoolMigration: true,
      originalRouteInput: baseRoute,
    })
    const pinOk =
      remotePin.ok &&
      remotePin.selected.poolKind === 'remote_pool' &&
      remotePin.effectivePoolPreference === 'pin_remote'
    const supersetOk = !localVision.ok && localVision.code === 'CAPABILITY_UNSATISFIED'
    const fenceOk =
      !postDispatch.allowRetry &&
      postDispatch.code === 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN' &&
      preDispatch.allowRetry &&
      preDispatch.mustAbandonPriorZeroCredit &&
      preDispatch.nextRoute.selected.poolKind === 'local_pool'
    const routerOk = pinOk && supersetOk && fenceOk
    return {
      check: {
        checkId: 'unified_router_dual_pool_parity',
        ok: routerOk,
        detail: routerOk ? 'pin_remote+superset+pre_post_fence_ok' : 'router_parity_invariant_failed',
      },
      ...(routerOk ? {} : { errorCode: 'DUAL_POOL_ROUTER_PARITY_FAILED' }),
    }
  } catch (err) {
    return {
      errorCode: 'DUAL_POOL_ROUTER_PARITY_ERROR',
      check: {
        checkId: 'unified_router_dual_pool_parity',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

interface ExtendedRedProofCheckOutcome {
  readonly check: DualPoolParityGateCheck
  readonly status: DualPoolParityGateResult['extendedRedProofStatus']
  readonly extendedProofSha256?: string
  readonly combinedMatrixSha256?: string
  readonly errorCode?: string
}

function runExtendedRedProofNegativeControl(driverId: string): ExtendedRedProofCheckOutcome {
  let negativeCaught = false
  try {
    verifyExtendedRedProof({ schemaVersion: 2, driverId, controls: [] })
  } catch (negErr) {
    negativeCaught =
      negErr instanceof Error && negErr.message.includes('REMOTE_EXTENDED_RED_PROOF_INVALID')
  }
  return {
    status: negativeCaught ? 'not_provided_negative_control_ok' : 'failed',
    check: {
      checkId: 'extended_red_proof_r8_r11',
      ok: negativeCaught,
      detail: negativeCaught
        ? 'artifact_optional_negative_control_verified'
        : 'extended_red_proof_negative_control_failed',
    },
    ...(negativeCaught ? {} : { errorCode: 'REMOTE_EXTENDED_RED_PROOF_INVALID' }),
  }
}

function runExtendedRedProofCheck(
  input: DualPoolParityGateInput,
  reg: RemoteDriverRegistryEntry,
): ExtendedRedProofCheckOutcome {
  if (input.extendedRedProofArtifact === undefined) {
    if (input.requireExtendedRedProof === true) {
      return {
        status: 'failed',
        errorCode: 'DUAL_POOL_EXTENDED_RED_PROOF_REQUIRED',
        check: {
          checkId: 'extended_red_proof_r8_r11',
          ok: false,
          detail: 'extended_red_proof_artifact_missing',
        },
      }
    }
    return runExtendedRedProofNegativeControl(reg.driverId)
  }
  try {
    if (input.verifyFullMatrix && input.expectedSuiteDigest !== undefined) {
      const matrix: VerifiedFullR1ToR11Matrix = verifyFullR1ToR11Matrix({
        driverProofInput: {
          driverId: reg.driverId,
          expectedDriverDigest: reg.driverDigest,
          expectedCoreDigest: reg.coreDigest,
          expectedSuiteDigest: input.expectedSuiteDigest,
          ...(input.redProofPath ? { proofPath: input.redProofPath } : {}),
        },
        extendedArtifact: input.extendedRedProofArtifact,
      })
      return {
        status: 'verified_full_r1_r11_matrix',
        extendedProofSha256: matrix.extendedProof.extendedProofSha256,
        combinedMatrixSha256: matrix.combinedMatrixSha256,
        check: {
          checkId: 'extended_red_proof_r8_r11',
          ok: true,
          detail: `full_r1_r11_matrix:${matrix.combinedMatrixSha256.slice(0, 16)}`,
        },
      }
    }
    const verified: VerifiedExtendedRedProof = verifyExtendedRedProof(
      input.extendedRedProofArtifact,
      {
        driverId: reg.driverId,
        ...(input.expectedBaseProofSha256
          ? { baseProofSha256: input.expectedBaseProofSha256 }
          : {}),
      },
    )
    return {
      status: 'verified',
      extendedProofSha256: verified.extendedProofSha256,
      check: {
        checkId: 'extended_red_proof_r8_r11',
        ok: true,
        detail: `extended_r8_r11_verified:${verified.extendedProofSha256.slice(0, 16)}`,
      },
    }
  } catch (err) {
    return {
      status: 'failed',
      errorCode: 'REMOTE_EXTENDED_RED_PROOF_INVALID',
      check: {
        checkId: 'extended_red_proof_r8_r11',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

/**
 * Master-side Dual-Pool Parity Conformance & `verifyExtendedRedProof` precheck gate.
 * Executes deterministically with zero external I/O and zero upstream token spend.
 */
export async function verifyDualPoolParityConformance(
  input: DualPoolParityGateInput,
): Promise<DualPoolParityGateResult> {
  const checkedAt = new Date((input.now ?? Date.now)()).toISOString()
  const reg = loadRemoteDriverRegistry(input.registryPath).get(input.driverId)

  if (!reg) {
    return Object.freeze({
      schemaVersion: 5 as const,
      ok: false,
      driverId: input.driverId,
      canonicalModel: input.canonicalModel ?? 'unknown-model',
      checkedAt,
      errorCode: 'REMOTE_DRIVER_NOT_REGISTERED',
      checks: Object.freeze([
        {
          checkId: 'receipt_v4_to_v5_semantic_parity' as const,
          ok: false,
          detail: `driver_not_registered:${input.driverId}`,
        },
      ]),
      extendedRedProofStatus: 'failed' as const,
    })
  }

  const rawCanonical = (input.canonicalModel ?? 'claude-sonnet-4-6-remote').trim().toLowerCase()
  const logicalModel = resolveLogicalModelId(rawCanonical).logicalModel
  const upstreamModel = (input.upstreamModel ?? logicalModel).trim().toLowerCase()
  const authEngine: AuthorityEngineKind = reg.authorityEngine
  const family = authorityEngineToInferenceFamily(authEngine)

  const receiptOutcome = runReceiptParityCheck({
    reg,
    rawCanonical,
    logicalModel,
    upstreamModel,
    authEngine,
    family,
    checkedAt,
  })
  const routerOutcome = await runRouterParityCheck({ reg, logicalModel, upstreamModel, checkedAt })
  const redOutcome = runExtendedRedProofCheck(input, reg)

  const checks: DualPoolParityGateCheck[] = [
    receiptOutcome.check,
    routerOutcome.check,
    redOutcome.check,
  ]
  const errorCode = receiptOutcome.errorCode ?? routerOutcome.errorCode ?? redOutcome.errorCode
  const ok = checks.every((c) => c.ok)
  const parityDigest = remoteCanonicalSha256({
    domain: 'oc-master-dual-pool-parity-gate-v5',
    driverId: reg.driverId,
    canonicalModel: rawCanonical,
    ok,
    checks,
    receiptParityDigest: receiptOutcome.receiptParity?.parityDigest ?? null,
    extendedProofSha256: redOutcome.extendedProofSha256 ?? null,
    combinedMatrixSha256: redOutcome.combinedMatrixSha256 ?? null,
  })

  return Object.freeze({
    schemaVersion: 5 as const,
    ok,
    driverId: reg.driverId,
    canonicalModel: rawCanonical,
    checkedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
    checks: Object.freeze(checks),
    parityDigest,
    ...(receiptOutcome.receiptParity === undefined
      ? {}
      : { receiptParity: receiptOutcome.receiptParity }),
    extendedRedProofStatus: redOutcome.status,
    ...(redOutcome.extendedProofSha256 === undefined
      ? {}
      : { extendedProofSha256: redOutcome.extendedProofSha256 }),
    ...(redOutcome.combinedMatrixSha256 === undefined
      ? {}
      : { combinedMatrixSha256: redOutcome.combinedMatrixSha256 }),
  })
}

function toProfileParitySummary(res: DualPoolParityGateResult): ProfileDualPoolParitySummary {
  return Object.freeze({
    status: res.ok ? ('passed' as const) : ('failed' as const),
    ok: res.ok,
    driverId: res.driverId,
    checkedAt: res.checkedAt,
    ...(res.errorCode ? { errorCode: res.errorCode } : {}),
    ...(res.parityDigest ? { parityDigest: res.parityDigest } : {}),
    extendedRedProofStatus: res.extendedRedProofStatus,
    ...(res.extendedProofSha256 ? { extendedProofSha256: res.extendedProofSha256 } : {}),
    checks: res.checks,
  })
}

export async function evaluateProfileDualPoolParityStatus(input: {
  readonly driverId: string | null
  readonly canonicalModel?: string
  readonly registryPath?: string
  readonly extendedRedProofArtifact?: unknown
  readonly requireExtendedRedProof?: boolean
  readonly cached?: DualPoolParityGateResult | null
  readonly now?: () => number
}): Promise<ProfileDualPoolParitySummary> {
  if (input.cached) return toProfileParitySummary(input.cached)

  const checkedAt = new Date((input.now ?? Date.now)()).toISOString()
  if (!input.driverId) {
    return Object.freeze({
      status: 'pending_v4_cutover' as const,
      ok: true,
      driverId: null,
      checkedAt,
    })
  }

  const res = await verifyDualPoolParityConformance({
    driverId: input.driverId,
    canonicalModel: input.canonicalModel,
    registryPath: input.registryPath,
    extendedRedProofArtifact: input.extendedRedProofArtifact,
    requireExtendedRedProof: input.requireExtendedRedProof,
    now: input.now,
  })
  return toProfileParitySummary(res)
}
