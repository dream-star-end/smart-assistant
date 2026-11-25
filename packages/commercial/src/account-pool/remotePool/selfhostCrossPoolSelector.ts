/**
 * OCV5-890 B01 — Production Selfhost Cross-Pool Pre-Dispatch Fallback Selector.
 *
 * Bridges `UserChatBridge.crossPoolFallbackSelector` to the real three-layer control-plane
 * components (`PgSessionAuthorityStateStore`, `PgLogicalModelBindingStore`,
 * `UnifiedPlacementRouter`, and `ModelCatalogCache`) under strict safety invariants:
 * - Active ONLY when `selfhost === true` and ONLY on Pre-Dispatch remote-pool unavailability
 *   (never after dispatch; never on unsettled billing fences such as
 *   `REMOTE_OPERATION_BILLING_PENDING` or `REMOTE_LANE_STOP_UNPROVEN`).
 * - Red Line #1 (Zero Silent Model Downgrade): resolves `resolveLogicalModelId(canonicalModel)`
 *   and accepts ONLY an active local catalog entry for the EXACT same logical model and
 *   authority engine whose capabilities form a strict superset of the requested & source turn
 *   capabilities (`checkCapabilitySuperset` + `UnifiedPlacementRouter`).
 * - Authoritative Epoch CAS: atomically advances `session_engine_pointers.placement_epoch` via
 *   `PgSessionAuthorityStateStore.beginPlacementMigration` + `commitPlacementMigration` and
 *   mints a trusted `CrossPoolFallbackMigrationGrant` for `cc5SessionBackend` /
 *   `assertFreshCc5Session` on the container side.
 * - Any unmet invariant returns `null` (100% preserving fail-closed `REMOTE_NATIVE_UNAVAILABLE`).
 *
 * Module: accounts (L3, allow: identity, catalog). Zero `process.env`, zero network I/O,
 * zero forbidden crypto, zero engine/provider literal special cases, zero billing SQL.
 */
import {
  AUTHORITY_ENGINE_KINDS,
  INFERENCE_SERVICE_TIERS,
  checkCapabilitySuperset,
  resolveLogicalModelId,
  type AuthorityEngineKind,
  type DriverCapabilityManifest,
  type InferenceEngineFamily,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type PlacementDescriptor,
  type PlatformReasoningEffort,
  type RemoteExecutionBackend,
  type RequiredTurnCapabilities,
  type ResumeLadderTier,
} from '@openclaude/protocol'
import type { ModelCatalogCache, ModelExecutionDescriptor } from '../../billing/modelCatalog.js'
import {
  PgLogicalModelBindingStore,
  PgSessionAuthorityStateStore,
  type PgTransactionPool,
} from '../../db/threeLayerStateStore.js'
import { assertNoPendingRemoteBillingForSession } from './placement.js'
import {
  PRE_DISPATCH_RETRYABLE_ERROR_CODES,
  UnifiedPlacementRouter,
  type LogicalModelBindingReader,
  type PoolCandidateDescriptor,
} from './unifiedPlacementRouter.js'

export const PRE_DISPATCH_REMOTE_FALLBACK_ERROR_CODES = [
  ...PRE_DISPATCH_RETRYABLE_ERROR_CODES,
  'REMOTE_NODE_TASKS_EXHAUSTED',
  'REMOTE_LANE_UNAVAILABLE',
  'REMOTE_LANE_PROFILE_UNAVAILABLE',
  'NO_ELIGIBLE_REMOTE_PROFILE',
  'REMOTE_DRIVER_REVERIFY_REQUIRED',
  'REMOTE_POOL_EXECUTION_DISABLED',
] as const

const PRE_DISPATCH_FALLBACK_CODE_SET: ReadonlySet<string> = new Set<string>(
  PRE_DISPATCH_REMOTE_FALLBACK_ERROR_CODES,
)

const NON_FALLBACK_HARD_FENCE_CODES: ReadonlySet<string> = new Set<string>([
  'REMOTE_OPERATION_BILLING_PENDING',
  'REMOTE_LANE_STOP_UNPROVEN',
  'REMOTE_SESSION_KEY_RESERVED',
  'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN',
])

const AUTHORITY_ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const VALID_SERVICE_TIER_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SERVICE_TIERS)

const ENGINE_FAMILY_BY_AUTHORITY: Readonly<Record<AuthorityEngineKind, InferenceEngineFamily>> =
  Object.freeze({
    ccb: 'cc',
    codex: 'codex',
    antigravity: 'antigravity',
    grok: 'grok',
    cursor: 'cursor',
    zcode: 'zcode',
  })

/** Local hard read-only support per authority engine (B14: local antigravity is fail-closed). */
const LOCAL_READ_ONLY_SUPPORT: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: true,
  antigravity: false,
  grok: false,
  cursor: false,
  zcode: false,
})

const LOCAL_SWARM_SUPPORT: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: false,
  antigravity: false,
  grok: false,
  cursor: false,
  zcode: false,
})

/**
 * Engines whose local execution uses the signed authority + egress per-request billing path
 * directly (requiring no separate pre-seal local Codex journal or Antigravity relay route).
 * Other engines fail closed at the post-classification seal point so local billing routes
 * can never be bypassed.
 */
const LOCAL_EGRESS_AUTHORITY_BILLED: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: false,
  antigravity: false,
  grok: false,
  cursor: false,
  zcode: false,
})

export interface CrossPoolFallbackMigrationGrant {
  readonly migrationId: string
  readonly placementEpoch: number
  readonly allowBackendTransition: true
  readonly continuityTier: ResumeLadderTier
}

export interface SelfhostCrossPoolFallbackInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly engine: string
  readonly cause: unknown
  readonly expectedSecurityEpoch?: number
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly dispatched?: boolean
}

export interface SelfhostReturnToRemoteInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly engine: string
  readonly executionBackend: RemoteExecutionBackend
}

export interface SelfhostCrossPoolFallbackResult {
  readonly fallbackPool: 'local_pool' | 'remote_pool'
  readonly executionBackend: RemoteExecutionBackend | undefined
  readonly resolvedCanonicalModel: string
  readonly logicalModel: string
  readonly migrationGrant: CrossPoolFallbackMigrationGrant
}

export interface SelfhostCrossPoolSelectorDeps {
  readonly pool?: PgTransactionPool
  readonly catalogCache?: Pick<ModelCatalogCache, 'assertFresh'>
  readonly selfhost: boolean
  readonly authorityStore?: PgSessionAuthorityStateStore
  readonly bindingStore?: LogicalModelBindingReader
  readonly pendingBillingChecker?: (input: {
    readonly uid: number
    readonly sessionKey: string
    readonly operationId?: string | null
  }) => Promise<boolean>
  readonly router?: UnifiedPlacementRouter
  readonly now?: () => number
}

function extractErrorCandidates(cause: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim().length > 0) {
      out.push(v.trim())
    }
  }
  if (cause instanceof Error) {
    push((cause as Error & { code?: unknown }).code)
    push(cause.message)
    const inner = (cause as Error & { cause?: unknown }).cause
    if (inner instanceof Error) {
      push((inner as Error & { code?: unknown }).code)
      push(inner.message)
    } else if (typeof inner === 'string') {
      push(inner)
    }
  } else if (cause && typeof cause === 'object') {
    push((cause as { code?: unknown }).code)
    push((cause as { message?: unknown }).message)
  } else if (typeof cause === 'string') {
    push(cause)
  }
  return out
}

export function isPreDispatchRemotePoolFailure(cause: unknown): boolean {
  const candidates = extractErrorCandidates(cause)
  if (candidates.length === 0) return false
  for (const text of candidates) {
    for (const fence of NON_FALLBACK_HARD_FENCE_CODES) {
      if (text === fence || text.includes(fence)) return false
    }
  }
  for (const text of candidates) {
    if (PRE_DISPATCH_FALLBACK_CODE_SET.has(text)) return true
    for (const code of PRE_DISPATCH_REMOTE_FALLBACK_ERROR_CODES) {
      if (text.includes(code)) return true
    }
  }
  return false
}

function extractSupportedServiceTiers(desc: ModelExecutionDescriptor): InferenceServiceTier[] {
  const tiers = new Set<InferenceServiceTier>(['standard'])
  const remoteCap = desc.capabilityProfile.remote
  if (remoteCap?.supports_fast === true) {
    tiers.add('fast')
  }
  for (const rawTier of remoteCap?.service_tiers ?? []) {
    if (VALID_SERVICE_TIER_SET.has(rawTier)) {
      tiers.add(rawTier as InferenceServiceTier)
    }
  }
  return [...tiers]
}

function buildLocalCapabilityFromDescriptor(
  logicalModel: string,
  desc: ModelExecutionDescriptor,
  authEngine: AuthorityEngineKind,
): LogicalModelCapability {
  const defaultEffort = (desc.defaultEffort ??
    desc.capabilityProfile.reasoning.codexModelDefault ??
    null) as PlatformReasoningEffort | null
  return Object.freeze({
    logicalModel,
    upstreamModelId: desc.upstreamModelId,
    supportsVision: desc.capabilityProfile.supportsVision === true,
    supportedEfforts: Object.freeze([...desc.capabilityProfile.reasoning.supported]),
    defaultEffort,
    supportedServiceTiers: Object.freeze(extractSupportedServiceTiers(desc)),
    supportsReadOnly: LOCAL_READ_ONLY_SUPPORT[authEngine],
    supportsConsultTurn: LOCAL_READ_ONLY_SUPPORT[authEngine],
    supportsHermeticNoTools: LOCAL_READ_ONLY_SUPPORT[authEngine],
    supportsSwarm: LOCAL_SWARM_SUPPORT[authEngine],
    supportsAdaptiveThinking: desc.capabilityProfile.ccb.supportsThinking === true,
    contextWindow: desc.contextWindow,
  })
}

function resolveCandidateLocalDriverId(
  engineFamily: InferenceEngineFamily,
  matchedBindingDriverId?: string,
): string {
  if (matchedBindingDriverId && matchedBindingDriverId.trim().length > 0) {
    return matchedBindingDriverId.trim()
  }
  return `local-${engineFamily}`
}

export function createSelfhostCrossPoolFallbackSelector(
  deps: SelfhostCrossPoolSelectorDeps,
): (input: SelfhostCrossPoolFallbackInput) => Promise<SelfhostCrossPoolFallbackResult | null> {
  const authorityStore =
    deps.authorityStore ?? (deps.pool ? new PgSessionAuthorityStateStore(deps.pool) : undefined)
  const implicitBindingStore =
    deps.bindingStore === undefined && deps.pool
      ? new PgLogicalModelBindingStore(deps.pool)
      : undefined
  const clock = deps.now ?? Date.now

  return async (
    input: SelfhostCrossPoolFallbackInput,
  ): Promise<SelfhostCrossPoolFallbackResult | null> => {
    if (deps.selfhost !== true) return null
    if (input.dispatched === true) return null
    if (!deps.catalogCache || !authorityStore) return null
    if (!isPreDispatchRemotePoolFailure(input.cause)) return null
    if (
      !Number.isSafeInteger(input.uid) ||
      input.uid <= 0 ||
      typeof input.sessionKey !== 'string' ||
      input.sessionKey.trim().length === 0 ||
      typeof input.canonicalModel !== 'string' ||
      input.canonicalModel.trim().length === 0
    ) {
      return null
    }

    let logicalModel: string
    try {
      logicalModel = resolveLogicalModelId(input.canonicalModel).logicalModel
    } catch {
      return null
    }

    let snapshot: Awaited<ReturnType<Pick<ModelCatalogCache, 'assertFresh'>['assertFresh']>>
    try {
      snapshot = await deps.catalogCache.assertFresh()
    } catch {
      return null
    }
    // B01: Verify securityEpoch matches the caller's fenced epoch BEFORE any PG mutation so a
    // catalog epoch drift can never leave PG migrated while the bridge rejects signing.
    if (
      input.expectedSecurityEpoch !== undefined &&
      Number(snapshot.securityEpoch) !== input.expectedSecurityEpoch
    ) {
      return null
    }

    const sourceDesc = snapshot.resolve(input.canonicalModel)
    const rawEngine = sourceDesc?.engine ?? input.engine
    if (!AUTHORITY_ENGINE_SET.has(rawEngine)) return null
    const authEngine = rawEngine as AuthorityEngineKind
    if (LOCAL_EGRESS_AUTHORITY_BILLED[authEngine] !== true) return null
    const engineFamily = ENGINE_FAMILY_BY_AUTHORITY[authEngine]

    // Red Line #1: ONLY accept an active local catalog entry for the EXACT same logical model.
    const localDesc = snapshot.resolve(logicalModel)
    if (!localDesc || localDesc.placement !== 'local') return null
    if (localDesc.engine !== authEngine) return null
    try {
      if (resolveLogicalModelId(localDesc.canonicalModel).logicalModel !== logicalModel) {
        return null
      }
    } catch {
      return null
    }

    // Preserve capabilities advertised by the requested remote model (never silently strip).
    if (
      sourceDesc?.capabilityProfile.supportsVision === true &&
      localDesc.capabilityProfile.supportsVision !== true
    ) {
      return null
    }
    if (
      sourceDesc?.capabilityProfile.ccb.supportsThinking === true &&
      localDesc.capabilityProfile.ccb.supportsThinking !== true
    ) {
      return null
    }

    // N01: Authoritative pool-binding gate. Distinguish three states strictly:
    //  1) Read failure -> fail-closed (return null)
    //  2) Configured (hasConfiguredBindings === true), even if all bindings are disabled ->
    //     pass activeBindingReader to UnifiedPlacementRouter so disabled bindings REJECT!
    //  3) Unconfigured (0 rows for logicalModel) -> fall through to strict catalog+superset gate.
    let activeBindingReader: LogicalModelBindingReader | undefined = deps.bindingStore
    let localBindingDriverId: string | undefined
    if (deps.bindingStore) {
      try {
        const res = await deps.bindingStore.resolveBindingsForModel(logicalModel)
        const localBinding = res.bindings.find(
          (b) => b.enabled && b.poolKind === 'local_pool',
        )
        localBindingDriverId = localBinding?.driverId
      } catch {
        return null
      }
    } else if (implicitBindingStore) {
      try {
        const state = await implicitBindingStore.resolveBindingsStateForModel(logicalModel)
        if (state.hasConfiguredBindings) {
          activeBindingReader = {
            resolveBindingsForModel: async () => ({
              resolved: state.resolved,
              bindings: state.bindings,
            }),
          }
          const localBinding = state.bindings.find(
            (b) => b.enabled && b.poolKind === 'local_pool',
          )
          localBindingDriverId = localBinding?.driverId
        }
      } catch {
        // Fail closed on authoritative binding-store read errors (N01).
        return null
      }
    }

    const localDriverId = resolveCandidateLocalDriverId(engineFamily, localBindingDriverId)
    const localCapability = buildLocalCapabilityFromDescriptor(logicalModel, localDesc, authEngine)
    const localManifest: DriverCapabilityManifest = Object.freeze({
      schemaVersion: 5 as const,
      poolKind: 'local_pool' as const,
      engineFamily,
      authorityEngine: authEngine,
      driverId: localDriverId,
      driverVersion: '5.0.0',
      observedAt: new Date(clock()).toISOString(),
      models: Object.freeze([localCapability]),
    })

    const required: RequiredTurnCapabilities = {
      ...(sourceDesc?.capabilityProfile.supportsVision === true ? { needsVision: true } : {}),
      ...(input.requiredCapabilities ?? {}),
    }

    const superset = checkCapabilitySuperset(localManifest, logicalModel, required)
    if (!superset.satisfied) return null

    const localCandidate: PoolCandidateDescriptor = Object.freeze({
      poolKind: 'local_pool' as const,
      driverId: localDriverId,
      manifest: localManifest,
      healthy: true,
      draining: false,
      activeSlots: 0,
      maxSlots: 1,
      weight: 100,
    })

    const router =
      deps.router ??
      new UnifiedPlacementRouter({
        candidates: [localCandidate],
        ...(activeBindingReader ? { bindingStore: activeBindingReader } : {}),
      })

    const routeRes = await router.routeTurn({
      rawModelId: logicalModel,
      sessionKey: input.sessionKey,
      tenantId: String(input.uid),
      requiredCapabilities: required,
      poolPreference: 'pin_local',
      currentPoolKind: 'remote_pool',
      currentDriverId: engineFamily,
      candidates: [localCandidate],
    })

    if (!routeRes.ok || routeRes.selected.poolKind !== 'local_pool') {
      return null
    }

    const resolvedLocalDesc = snapshot.resolve(routeRes.canonicalModelId) ?? localDesc
    if (
      resolvedLocalDesc.placement === 'remote_pool' ||
      resolvedLocalDesc.engine !== authEngine
    ) {
      return null
    }
    try {
      if (resolveLogicalModelId(resolvedLocalDesc.canonicalModel).logicalModel !== logicalModel) {
        return null
      }
    } catch {
      return null
    }

    // Authoritative PG placement epoch migration CAS (remote_pool -> local_container).
    const existingPointer = await authorityStore.getEnginePointer(input.uid, input.sessionKey)

    // B06: Unconditionally verify NO unsettled remote billing journal exists for this
    // user/session/operation BEFORE authorizing cross-pool fallback or advancing PG epoch.
    try {
      if (deps.pendingBillingChecker) {
        const hasPending = await deps.pendingBillingChecker({
          uid: input.uid,
          sessionKey: input.sessionKey,
          operationId: existingPointer?.operationId ?? null,
        })
        if (hasPending) return null
      } else if (deps.pool) {
        await assertNoPendingRemoteBillingForSession(
          deps.pool,
          input.uid,
          input.sessionKey,
          existingPointer?.operationId ?? null,
        )
      }
    } catch {
      return null
    }

    // B01: Determine honest continuityTier based on real persisted recovery evidence
    // (rolling checkpoint / pointer history) instead of unconditionally claiming `tape_rebuilt`.
    let hasPersistedRecoveryContext = false
    try {
      const checkpoint = await authorityStore.peekRollingCheckpoint(input.uid, input.sessionKey)
      if (checkpoint !== null) {
        hasPersistedRecoveryContext = true
      }
    } catch {
      hasPersistedRecoveryContext = false
    }
    if (!hasPersistedRecoveryContext && existingPointer && existingPointer.history.length > 0) {
      hasPersistedRecoveryContext = true
    }
    const continuityTier: ResumeLadderTier = hasPersistedRecoveryContext
      ? 'tape_rebuilt'
      : 'cold_degraded'

    const expectedPlacementEpoch = existingPointer?.placementEpoch ?? 1
    const fromPlacement: PlacementDescriptor = {
      poolKind: existingPointer?.poolKind ?? 'remote_pool',
      engine: existingPointer?.engine ?? authEngine,
      driverId: engineFamily,
      placementEpoch: expectedPlacementEpoch,
      ...(existingPointer?.profileId ? { profileId: existingPointer.profileId } : {}),
      ...(existingPointer?.operationId ? { operationId: existingPointer.operationId } : {}),
    }
    const toPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: authEngine,
      driverId: localDriverId,
      placementEpoch: expectedPlacementEpoch + 1,
      containerId: String(input.containerId),
    }

    const begun = await authorityStore.beginPlacementMigration({
      userId: input.uid,
      sessionKey: input.sessionKey,
      expectedPlacementEpoch,
      fromPlacement,
      toPlacement,
      reason: 'pre_dispatch_remote_unavailable_fallback_local',
    })
    if (!begun.applied) return null

    const committed = await authorityStore
      .commitPlacementMigration({
        migrationId: begun.migration.migrationId,
        userId: input.uid,
        sessionKey: input.sessionKey,
        continuityTier,
      })
      .catch(async () => {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'commit_failed_rollback',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        return null
      })

    if (!committed || !committed.applied) {
      await authorityStore
        .abortPlacementMigration({
          migrationId: begun.migration.migrationId,
          reason: 'commit_not_applied',
          userId: input.uid,
          sessionKey: input.sessionKey,
        })
        .catch(() => {})
      return null
    }

    const migrationGrant: CrossPoolFallbackMigrationGrant = Object.freeze({
      migrationId: committed.migration.migrationId,
      placementEpoch: committed.pointer.placementEpoch,
      allowBackendTransition: true as const,
      continuityTier,
    })

    return Object.freeze({
      fallbackPool: 'local_pool' as const,
      executionBackend: undefined,
      resolvedCanonicalModel: resolvedLocalDesc.canonicalModel,
      logicalModel,
      migrationGrant,
    })
  }
}

/**
 * B01: Return-to-remote migration grant resolver for selfhost V5.
 * When a session previously fell back to `local_container` and remote pool recovers for a
 * subsequent turn on the remote model, atomically transitions PG pointer `local_container` ->
 * `remote_pool` (epoch N -> N+1) and issues a signed `CrossPoolFallbackMigrationGrant` so the
 * container gateway permits resuming the session on the recovered remote lane without forcing a
 * brand-new chat. Returns `null` when the session is NOT currently on `local_container` (zero
 * overhead / zero weakening of fail-closed locks for ordinary sessions).
 */
export function createSelfhostReturnToRemoteGrantResolver(
  deps: Pick<SelfhostCrossPoolSelectorDeps, 'pool' | 'selfhost' | 'authorityStore' | 'pendingBillingChecker'>,
): (input: SelfhostReturnToRemoteInput) => Promise<CrossPoolFallbackMigrationGrant | null> {
  const authorityStore =
    deps.authorityStore ?? (deps.pool ? new PgSessionAuthorityStateStore(deps.pool) : undefined)

  return async (
    input: SelfhostReturnToRemoteInput,
  ): Promise<CrossPoolFallbackMigrationGrant | null> => {
    if (deps.selfhost !== true || !authorityStore) return null
    if (
      !Number.isSafeInteger(input.uid) ||
      input.uid <= 0 ||
      typeof input.sessionKey !== 'string' ||
      input.sessionKey.trim().length === 0
    ) {
      return null
    }
    if (!AUTHORITY_ENGINE_SET.has(input.engine)) return null
    const authEngine = input.engine as AuthorityEngineKind
    const engineFamily = ENGINE_FAMILY_BY_AUTHORITY[authEngine]

    const existingPointer = await authorityStore.getEnginePointer(input.uid, input.sessionKey)
    if (!existingPointer || existingPointer.poolKind !== 'local_container') {
      return null
    }

    // B06 defense-in-depth: never authorize return-to-remote while an unsettled remote journal exists.
    try {
      if (deps.pendingBillingChecker) {
        const hasPending = await deps.pendingBillingChecker({
          uid: input.uid,
          sessionKey: input.sessionKey,
          operationId: existingPointer.operationId ?? null,
        })
        if (hasPending) return null
      } else if (deps.pool) {
        await assertNoPendingRemoteBillingForSession(
          deps.pool,
          input.uid,
          input.sessionKey,
          existingPointer.operationId ?? null,
        )
      }
    } catch {
      return null
    }

    let hasPersistedRecoveryContext = existingPointer.history.length > 0
    if (!hasPersistedRecoveryContext) {
      try {
        hasPersistedRecoveryContext =
          (await authorityStore.peekRollingCheckpoint(input.uid, input.sessionKey)) !== null
      } catch {
        hasPersistedRecoveryContext = false
      }
    }
    const continuityTier: ResumeLadderTier = hasPersistedRecoveryContext
      ? 'tape_rebuilt'
      : 'cold_degraded'

    const fromPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: existingPointer.engine,
      driverId: `local-${engineFamily}`,
      placementEpoch: existingPointer.placementEpoch,
      containerId: String(input.containerId),
    }
    const toPlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: authEngine,
      driverId: engineFamily,
      placementEpoch: existingPointer.placementEpoch + 1,
      operationId: input.executionBackend.operationId,
    }

    const begun = await authorityStore.beginPlacementMigration({
      userId: input.uid,
      sessionKey: input.sessionKey,
      expectedPlacementEpoch: existingPointer.placementEpoch,
      fromPlacement,
      toPlacement,
      reason: 'remote_pool_recovered_return_from_local',
    })
    if (!begun.applied) return null

    const committed = await authorityStore
      .commitPlacementMigration({
        migrationId: begun.migration.migrationId,
        userId: input.uid,
        sessionKey: input.sessionKey,
        continuityTier,
        operationId: input.executionBackend.operationId,
      })
      .catch(async () => {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'return_to_remote_commit_failed',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        return null
      })

    if (!committed || !committed.applied) {
      await authorityStore
        .abortPlacementMigration({
          migrationId: begun.migration.migrationId,
          reason: 'return_to_remote_commit_not_applied',
          userId: input.uid,
          sessionKey: input.sessionKey,
        })
        .catch(() => {})
      return null
    }

    return Object.freeze({
      migrationId: committed.migration.migrationId,
      placementEpoch: committed.pointer.placementEpoch,
      allowBackendTransition: true as const,
      continuityTier,
    })
  }
}
