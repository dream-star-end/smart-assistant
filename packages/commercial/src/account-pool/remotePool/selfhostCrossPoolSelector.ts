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
  type AuthoritativeRollingCheckpoint,
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
  extractPendingInstallMigration,
  type PgTransactionPool,
} from '../../db/threeLayerStateStore.js'
import {
  assertNoPendingRemoteBillingForSession,
  type ExcludeCurrentPreparedBinding,
} from './placement.js'
import { ensureCrossPoolRollingCheckpoint } from './crossPoolContinuity.js'
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
  'MODEL_POOL_BINDING_FORCED_LOCAL',
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

/** Local hard read-only support per authority engine (aligned with local AGY hard read-only sandbox). */
const LOCAL_READ_ONLY_SUPPORT: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: true,
  antigravity: true,
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
 * Engines supported for selfhost cross-pool pre-dispatch fallback to `local_pool`.
 * - `ccb`: uses the signed authority + egress per-request billing path directly.
 * - `codex` / `antigravity`: require `prepareLocalFallbackTransport` in the seal pipeline
 *   (`resolveRemotePoolBackendAndSeal`) to mint authentic local billing/route credentials
 *   before PG `placementEpoch` commit, failing closed if preparation is absent or fails.
 */
const LOCAL_CROSS_POOL_FALLBACK_SUPPORTED_ENGINES: Readonly<Record<AuthorityEngineKind, boolean>> =
  Object.freeze({
    ccb: true,
    codex: true,
    antigravity: true,
    grok: false,
    cursor: false,
    zcode: false,
  })

export interface CrossPoolFallbackMigrationGrant {
  readonly migrationId: string
  readonly placementEpoch: number
  readonly allowBackendTransition: true
  readonly continuityTier: ResumeLadderTier
  /**
   * OCV5-902 P0-1: Non-enumerable side-channel reference to the authoritative PG rolling
   * checkpoint paired with a `tape_rebuilt` grant (omitted from JSON/JCS serialization so
   * `AuthorityPoolMigrationGrant` stays strictly 4 wire fields).
   */
  readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
}

export interface PrepareRollingCheckpointInput {
  readonly uid: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly sourcePlacementEpoch: number
  readonly sourceEngine: AuthorityEngineKind
  readonly authorityStore: PgSessionAuthorityStateStore
  readonly historicalMessages?: readonly unknown[]
  readonly excludeClientMessageId?: string
}

export type PrepareRollingCheckpointCallback = (
  input: PrepareRollingCheckpointInput,
) => Promise<AuthoritativeRollingCheckpoint | null>

export interface ContinuityVerificationInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly fromPoolKind: 'remote_pool' | 'local_container'
  readonly toPoolKind: 'remote_pool' | 'local_container'
  readonly sourcePlacementEpoch: number
  readonly targetPlacementEpoch: number
  readonly checkpoint: AuthoritativeRollingCheckpoint
}

export type ContinuityVerificationResult =
  | {
      readonly applied: true
      readonly checkpointId: string
    }
  | {
      readonly applied: false
    }

export type ContinuityAppliedVerifier = (
  input: ContinuityVerificationInput,
) => Promise<ContinuityVerificationResult>

export interface SelfhostCrossPoolFallbackInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly canonicalModel: string
  readonly engine: string
  readonly cause: unknown
  readonly expectedSecurityEpoch?: number
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly dispatched?: boolean
  readonly historicalMessages?: readonly unknown[]
  readonly excludeClientMessageId?: string
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback
  /**
   * B01 Stage-1 pre-sign validation hook: runs BEFORE `beginPlacementMigration` so any
   * target descriptor rejection leaves PG completely untouched.
   */
  readonly validateTargetSignable?: (target: {
    readonly canonicalModel: string
    readonly logicalModel: string
    readonly engine: AuthorityEngineKind
    readonly fallbackPool: 'local_pool'
  }) => Promise<boolean>
  /**
   * B01 Stage-2 pre-commit verification hook: runs AFTER `beginPlacementMigration` and
   * BEFORE `commitPlacementMigration`. Returning `false` or throwing triggers explicit
   * `abortPlacementMigration` so PG `placementEpoch` never advances on sign/epoch failure.
   */
  readonly beforeCommit?: (prepared: {
    readonly fallbackPool: 'local_pool'
    readonly resolvedCanonicalModel: string
    readonly logicalModel: string
    readonly migrationGrant: CrossPoolFallbackMigrationGrant
    readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
  }) => Promise<boolean>
  /**
   * B01: Optional continuity proof hook. `tape_rebuilt` is ONLY published when an unacked
   * rolling checkpoint exists at the current source epoch AND this verifier returns
   * `{ applied: true, checkpointId }`; otherwise `cold_degraded` is published honestly.
   */
  readonly verifyContinuityApplied?: ContinuityAppliedVerifier
}

export interface SelfhostReturnToRemoteInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly canonicalModel: string
  readonly engine: string
  readonly executionBackend: RemoteExecutionBackend
  readonly expectedSecurityEpoch?: number
  /**
   * OCV5-902 B4: When true and PG has no `session_engine_pointers` row yet (pre-rollout
   * local session with verified local turn history), treat the session as originating on
   * `local_container` at epoch 1 and run the full `1 -> 2` migration flow. Never guessed
   * when omitted or false.
   */
  readonly hasLocalHistory?: boolean
  readonly historicalMessages?: readonly unknown[]
  readonly excludeClientMessageId?: string
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback
  readonly onDeliveredCheckpoint?: (checkpoint: AuthoritativeRollingCheckpoint) => void
  /**
   * B01 Stage-2 pre-commit hook: validates epoch/signing BEFORE committing return-to-remote.
   * Returning `false` or throwing aborts the migration and leaves PG on `local_container`.
   */
  readonly beforeCommit?: (prepared: {
    readonly migrationGrant: CrossPoolFallbackMigrationGrant
    readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
  }) => Promise<boolean>
  /** Notifies caller when an active `local_container` return is fail-closed blocked (e.g. B06). */
  readonly onBlocked?: (code: string) => void
  /**
   * B01: Optional continuity proof hook. `tape_rebuilt` is ONLY published when an unacked
   * rolling checkpoint exists at the current source epoch AND this verifier returns
   * `{ applied: true, checkpointId }`; otherwise `cold_degraded` is published honestly.
   */
  readonly verifyContinuityApplied?: ContinuityAppliedVerifier
}

export interface SelfhostForcedLocalMigrationInput {
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly canonicalModel: string
  readonly engine: string
  readonly reason?: string
  readonly expectedSecurityEpoch?: number
  readonly historicalMessages?: readonly unknown[]
  readonly excludeClientMessageId?: string
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback
  readonly onDeliveredCheckpoint?: (checkpoint: AuthoritativeRollingCheckpoint) => void
  readonly beforeCommit?: (prepared: {
    readonly migrationGrant: CrossPoolFallbackMigrationGrant
    readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
  }) => Promise<boolean>
  readonly onBlocked?: (code: string) => void
  readonly verifyContinuityApplied?: ContinuityAppliedVerifier
}

export interface SelfhostCrossPoolFallbackResult {
  readonly fallbackPool: 'local_pool' | 'remote_pool'
  readonly executionBackend: RemoteExecutionBackend | undefined
  readonly resolvedCanonicalModel: string
  readonly logicalModel: string
  readonly migrationGrant?: CrossPoolFallbackMigrationGrant
  readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
  readonly reusedExistingLocalPlacement?: boolean
  readonly placementEpoch?: number
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
    readonly excludeCurrentPreparedBinding?: ExcludeCurrentPreparedBinding
  }) => Promise<boolean>
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback
  readonly verifyContinuityApplied?: ContinuityAppliedVerifier
  readonly router?: UnifiedPlacementRouter
  readonly now?: () => number
}

function makeMigrationGrant(
  base: {
    readonly migrationId: string
    readonly placementEpoch: number
    readonly allowBackendTransition: true
    readonly continuityTier: ResumeLadderTier
  },
  deliveredCheckpoint?: AuthoritativeRollingCheckpoint | null,
): CrossPoolFallbackMigrationGrant {
  const grant: Record<string, unknown> = {
    migrationId: base.migrationId,
    placementEpoch: base.placementEpoch,
    allowBackendTransition: true as const,
    continuityTier: base.continuityTier,
  }
  if (deliveredCheckpoint) {
    Object.defineProperty(grant, 'deliveredCheckpoint', {
      value: deliveredCheckpoint,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(grant) as unknown as CrossPoolFallbackMigrationGrant
}

/**
 * OCV5-902 B2: Strictly resolves the checkpoint carrier for a pending-install redelivery.
 * - `tape_rebuilt` with a recorded `checkpointGeneration`: MUST read that exact row cleanly
 *   from PG; any read error, missing row, or empty summary fails closed (`ok: false`) so the
 *   caller aborts this forward and retains PG `pendingInstall` for a clean retry.
 * - Legacy `tape_rebuilt` row missing `checkpointGeneration`: explicitly downgrades to
 *   `cold_degraded` rather than signing an empty `tape_rebuilt` grant.
 */
async function resolveRedeliveredPendingInstall(input: {
  readonly authorityStore: PgSessionAuthorityStateStore
  readonly uid: number
  readonly sessionKey: string
  readonly pendingInstall: NonNullable<ReturnType<typeof extractPendingInstallMigration>>
}): Promise<
  | {
      readonly ok: true
      readonly continuityTier: ResumeLadderTier
      readonly checkpoint?: AuthoritativeRollingCheckpoint
    }
  | {
      readonly ok: false
      readonly blockedCode: 'CROSS_POOL_CHECKPOINT_UNAVAILABLE'
    }
> {
  if (input.pendingInstall.continuityTier !== 'tape_rebuilt') {
    return { ok: true, continuityTier: input.pendingInstall.continuityTier }
  }
  const gen = input.pendingInstall.checkpointGeneration
  if (!gen) {
    return { ok: true, continuityTier: 'cold_degraded' }
  }
  let fetched: AuthoritativeRollingCheckpoint | null
  try {
    fetched = await input.authorityStore.getRollingCheckpointByGeneration(
      input.uid,
      input.sessionKey,
      gen,
    )
  } catch {
    return { ok: false, blockedCode: 'CROSS_POOL_CHECKPOINT_UNAVAILABLE' }
  }
  if (fetched === null || typeof fetched.summary !== 'string' || fetched.summary.trim().length === 0) {
    return { ok: false, blockedCode: 'CROSS_POOL_CHECKPOINT_UNAVAILABLE' }
  }
  return { ok: true, continuityTier: 'tape_rebuilt', checkpoint: fetched }
}

async function resolveAndVerifyCrossPoolContinuity(input: {
  readonly authorityStore: PgSessionAuthorityStateStore
  readonly uid: number
  readonly containerId: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly fromPoolKind: 'remote_pool' | 'local_container'
  readonly toPoolKind: 'remote_pool' | 'local_container'
  readonly sourcePlacementEpoch: number
  readonly sourceEngine: AuthorityEngineKind
  readonly historicalMessages?: readonly unknown[]
  readonly excludeClientMessageId?: string
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback
  readonly depsVerifier?: ContinuityAppliedVerifier
  readonly inputVerifier?: ContinuityAppliedVerifier
}): Promise<{
  readonly ok: boolean
  readonly continuityTier: ResumeLadderTier
  readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint
}> {
  let rollingCheckpoint: AuthoritativeRollingCheckpoint | null
  try {
    rollingCheckpoint = await input.authorityStore.peekRollingCheckpoint(
      input.uid,
      input.sessionKey,
      input.sourcePlacementEpoch,
    )
  } catch {
    return { ok: false, continuityTier: 'cold_degraded' }
  }

  if (rollingCheckpoint === null) {
    if (input.prepareRollingCheckpoint) {
      try {
        rollingCheckpoint = await input.prepareRollingCheckpoint({
          uid: input.uid,
          sessionKey: input.sessionKey,
          sessionId: input.sessionId,
          sourcePlacementEpoch: input.sourcePlacementEpoch,
          sourceEngine: input.sourceEngine,
          authorityStore: input.authorityStore,
          historicalMessages: input.historicalMessages,
          excludeClientMessageId: input.excludeClientMessageId,
        })
      } catch {
        rollingCheckpoint = null
      }
    } else if (
      Array.isArray(input.historicalMessages) &&
      input.historicalMessages.length > 0 &&
      typeof input.sessionId === 'string' &&
      input.sessionId.trim().length > 0
    ) {
      rollingCheckpoint = await ensureCrossPoolRollingCheckpoint({
        authorityStore: input.authorityStore,
        uid: input.uid,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId.trim(),
        sourcePlacementEpoch: input.sourcePlacementEpoch,
        sourceEngine: input.sourceEngine,
        rawHistory: input.historicalMessages,
        excludeClientMessageId: input.excludeClientMessageId,
      })
    }
  }

  const verifiers: ContinuityAppliedVerifier[] = []
  if (input.depsVerifier) verifiers.push(input.depsVerifier)
  if (input.inputVerifier && input.inputVerifier !== input.depsVerifier) {
    verifiers.push(input.inputVerifier)
  }

  if (rollingCheckpoint === null || verifiers.length === 0) {
    return { ok: true, continuityTier: 'cold_degraded' }
  }

  for (const verify of verifiers) {
    try {
      const verified = await verify({
        uid: input.uid,
        containerId: input.containerId,
        sessionKey: input.sessionKey,
        fromPoolKind: input.fromPoolKind,
        toPoolKind: input.toPoolKind,
        sourcePlacementEpoch: input.sourcePlacementEpoch,
        targetPlacementEpoch: input.sourcePlacementEpoch + 1,
        checkpoint: rollingCheckpoint,
      })
      if (
        verified.applied !== true ||
        verified.checkpointId !== rollingCheckpoint.checkpointGeneration
      ) {
        return { ok: true, continuityTier: 'cold_degraded' }
      }
    } catch {
      return { ok: true, continuityTier: 'cold_degraded' }
    }
  }

  return {
    ok: true,
    continuityTier: 'tape_rebuilt',
    deliveredCheckpoint: rollingCheckpoint,
  }
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
    // B06: Fail closed if neither an explicit pendingBillingChecker nor an authoritative PG pool is wired.
    if (!deps.pendingBillingChecker && !deps.pool) return null
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
    if (LOCAL_CROSS_POOL_FALLBACK_SUPPORTED_ENGINES[authEngine] !== true) return null
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
    //  1) Read failure -> fail-closed (return null, never touch PG epoch)
    //  2) Configured (`status === 'configured'`, `totalCount > 0`) ->
    //     - If `enabledBindings.length === 0` (all explicitly disabled): REJECT immediately!
    //     - Otherwise pass `activeBindingReader` with enabled bindings to UnifiedPlacementRouter.
    //  3) Unconfigured (`status === 'unconfigured'`, `totalCount === 0`) ->
    //     fall through to strict catalog + capability superset gate.
    let activeBindingReader: LogicalModelBindingReader | undefined
    let localBindingDriverId: string | undefined
    if (deps.bindingStore) {
      try {
        if (typeof deps.bindingStore.inspectLogicalModelBindings === 'function') {
          const inspected = await deps.bindingStore.inspectLogicalModelBindings(logicalModel)
          if (inspected.status === 'configured' && inspected.enabledBindings.length === 0) {
            return null
          }
          activeBindingReader = {
            resolveBindingsForModel: async () => ({
              resolved: inspected.resolved,
              bindings: inspected.enabledBindings,
            }),
          }
          localBindingDriverId = inspected.enabledBindings.find(
            (b) => b.enabled && b.poolKind === 'local_pool',
          )?.driverId
        } else {
          const res = await deps.bindingStore.resolveBindingsForModel(logicalModel)
          activeBindingReader = {
            resolveBindingsForModel: async () => res,
          }
          localBindingDriverId = res.bindings.find(
            (b) => b.enabled && b.poolKind === 'local_pool',
          )?.driverId
        }
      } catch {
        return null
      }
    } else if (implicitBindingStore) {
      try {
        const inspected = await implicitBindingStore.inspectLogicalModelBindings(logicalModel)
        if (inspected.status === 'configured') {
          if (inspected.enabledBindings.length === 0) {
            return null
          }
          activeBindingReader = {
            resolveBindingsForModel: async () => ({
              resolved: inspected.resolved,
              bindings: inspected.enabledBindings,
            }),
          }
          localBindingDriverId = inspected.enabledBindings.find(
            (b) => b.enabled && b.poolKind === 'local_pool',
          )?.driverId
        }
      } catch {
        // Fail closed on authoritative binding-store read errors (N01).
        return null
      }
    }

    // B06: Read authoritative pointer & verify NO unsettled remote billing journal or unreleased
    // remote binding exists BEFORE concluding this session can fall back to local_pool.
    let existingPointer: Awaited<ReturnType<PgSessionAuthorityStateStore['getEnginePointer']>>
    try {
      existingPointer = await authorityStore.getEnginePointer(input.uid, input.sessionKey)
    } catch {
      return null
    }

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

    const alreadyOnLocal = existingPointer?.poolKind === 'local_container'
    let routeRes: Awaited<ReturnType<UnifiedPlacementRouter['routeTurn']>>
    try {
      routeRes = await router.routeTurn({
        rawModelId: logicalModel,
        sessionKey: input.sessionKey,
        tenantId: String(input.uid),
        requiredCapabilities: required,
        poolPreference: 'pin_local',
        currentPoolKind: alreadyOnLocal ? 'local_pool' : 'remote_pool',
        currentDriverId: alreadyOnLocal ? localDriverId : engineFamily,
        candidates: [localCandidate],
      })
    } catch {
      return null
    }

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
    if (
      typeof snapshot.billingPricingFor === 'function' &&
      snapshot.billingPricingFor(resolvedLocalDesc.canonicalModel) === null
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

    // B01 Stage 1: Validate target descriptor signability BEFORE any PG mutation or local reuse.
    if (input.validateTargetSignable) {
      try {
        const signable = await input.validateTargetSignable({
          canonicalModel: resolvedLocalDesc.canonicalModel,
          logicalModel,
          engine: authEngine,
          fallbackPool: 'local_pool',
        })
        if (!signable) return null
      } catch {
        return null
      }
    }

    // B01 + OCV5-893 B3: If the authoritative pointer is ALREADY active on `local_container`
    // for this engine (remote remained unavailable across consecutive turns), reuse the existing
    // local placement directly without starting a redundant same-pool migration or bumping
    // placementEpoch. Re-issue the exact committed migrationGrant ONLY while PG's durable
    // `pendingInstallMigration` marker for `(local_container, placementEpoch)` is still present
    // (never rely on `nativeSessionId === null`, which is preserved across migrations). Once
    // `markPlacementMigrationInstalled` clears the marker or a newer epoch supersedes it,
    // omit the grant for pure local continuation.
    if (existingPointer && existingPointer.poolKind === 'local_container') {
      if (existingPointer.migrationState !== 'active' || existingPointer.engine !== authEngine) {
        return null
      }
      const pendingInstall = extractPendingInstallMigration(existingPointer.promptCacheMeta)
      const shouldRedeliver =
        pendingInstall !== null &&
        pendingInstall.targetPoolKind === 'local_container' &&
        pendingInstall.targetEpoch === existingPointer.placementEpoch
      let redeliveredCheckpoint: AuthoritativeRollingCheckpoint | undefined
      let redeliveredGrant: CrossPoolFallbackMigrationGrant | undefined
      if (shouldRedeliver && pendingInstall !== null) {
        const resolvedPending = await resolveRedeliveredPendingInstall({
          authorityStore,
          uid: input.uid,
          sessionKey: input.sessionKey,
          pendingInstall,
        })
        if (!resolvedPending.ok) {
          return null
        }
        redeliveredCheckpoint = resolvedPending.checkpoint
        redeliveredGrant = makeMigrationGrant(
          {
            migrationId: pendingInstall.migrationId,
            placementEpoch: pendingInstall.targetEpoch,
            allowBackendTransition: true as const,
            continuityTier: resolvedPending.continuityTier,
          },
          redeliveredCheckpoint,
        )
      }
      return Object.freeze({
        fallbackPool: 'local_pool' as const,
        executionBackend: undefined,
        resolvedCanonicalModel: resolvedLocalDesc.canonicalModel,
        logicalModel,
        reusedExistingLocalPlacement: true as const,
        placementEpoch: existingPointer.placementEpoch,
        migrationGrant: redeliveredGrant,
        ...(redeliveredCheckpoint ? { deliveredCheckpoint: redeliveredCheckpoint } : {}),
      })
    }

    const expectedPlacementEpoch = existingPointer?.placementEpoch ?? 1

    const continuity = await resolveAndVerifyCrossPoolContinuity({
      authorityStore,
      uid: input.uid,
      containerId: input.containerId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      fromPoolKind:
        existingPointer?.poolKind === 'local_container' ? 'local_container' : 'remote_pool',
      toPoolKind: 'local_container',
      sourcePlacementEpoch: expectedPlacementEpoch,
      sourceEngine: existingPointer?.engine ?? authEngine,
      historicalMessages: input.historicalMessages,
      excludeClientMessageId: input.excludeClientMessageId,
      prepareRollingCheckpoint: input.prepareRollingCheckpoint ?? deps.prepareRollingCheckpoint,
      depsVerifier: deps.verifyContinuityApplied,
      inputVerifier: input.verifyContinuityApplied,
    })
    if (!continuity.ok) return null
    const continuityTier: ResumeLadderTier = continuity.continuityTier
    const deliveredCheckpoint = continuity.deliveredCheckpoint

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

    // B01 Stage 2: CAS begin -> pre-commit sign/epoch verification -> commit (or explicit abort).
    const begun = await authorityStore.beginPlacementMigration({
      userId: input.uid,
      sessionKey: input.sessionKey,
      expectedPlacementEpoch,
      fromPlacement,
      toPlacement,
      reason: 'pre_dispatch_remote_unavailable_fallback_local',
    })
    if (!begun.applied) return null

    const preparedGrant: CrossPoolFallbackMigrationGrant = makeMigrationGrant(
      {
        migrationId: begun.migration.migrationId,
        placementEpoch: begun.migration.toEpoch,
        allowBackendTransition: true as const,
        continuityTier,
      },
      deliveredCheckpoint,
    )

    if (input.beforeCommit) {
      let commitApproved = false
      try {
        commitApproved = await input.beforeCommit({
          fallbackPool: 'local_pool',
          resolvedCanonicalModel: resolvedLocalDesc.canonicalModel,
          logicalModel,
          migrationGrant: preparedGrant,
          ...(deliveredCheckpoint ? { deliveredCheckpoint } : {}),
        })
      } catch {
        commitApproved = false
      }
      if (!commitApproved) {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'target_sign_validation_rejected',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        return null
      }
    }

    const readBackCommittedLocal = async () => {
      const readBack = await authorityStore
        .getPlacementMigration(begun.migration.migrationId)
        .catch(() => null)
      if (readBack && readBack.state === 'committed') {
        const ptr = await authorityStore
          .getEnginePointer(input.uid, input.sessionKey)
          .catch(() => null)
        if (
          ptr &&
          ptr.poolKind === 'local_container' &&
          ptr.migrationState === 'active' &&
          ptr.placementEpoch === readBack.toEpoch
        ) {
          return { applied: true as const, migration: readBack, pointer: ptr }
        }
      }
      return null
    }

    let committed = await authorityStore
      .commitPlacementMigration({
        migrationId: begun.migration.migrationId,
        userId: input.uid,
        sessionKey: input.sessionKey,
        continuityTier,
        ...(continuityTier === 'tape_rebuilt' && deliveredCheckpoint
          ? { checkpointGeneration: deliveredCheckpoint.checkpointGeneration }
          : {}),
      })
      .catch(async () => {
        // B01 + OCV5-893 B3: If PG commit landed before the ack was lost, read back the
        // authoritative migration/pointer state instead of blindly aborting and dropping the grant!
        const recovered = await readBackCommittedLocal()
        if (recovered) return recovered
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
      const recovered = await readBackCommittedLocal()
      if (recovered) {
        committed = recovered
      } else {
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
    }

    const migrationGrant: CrossPoolFallbackMigrationGrant = makeMigrationGrant(
      {
        migrationId: committed.migration.migrationId,
        placementEpoch: committed.pointer.placementEpoch,
        allowBackendTransition: true as const,
        continuityTier,
      },
      deliveredCheckpoint,
    )

    return Object.freeze({
      fallbackPool: 'local_pool' as const,
      executionBackend: undefined,
      resolvedCanonicalModel: resolvedLocalDesc.canonicalModel,
      logicalModel,
      migrationGrant,
      ...(deliveredCheckpoint ? { deliveredCheckpoint } : {}),
    })
  }
}

/**
 * B01: Return-to-remote migration grant resolver for selfhost V5.
 * When a session previously fell back to `local_container` and remote pool recovers for a
 * subsequent turn on the remote model, verifies unsettled billing (B06), validates signability
 * via `beforeCommit` BEFORE committing, atomically transitions PG pointer `local_container` ->
 * `remote_pool` (epoch N -> N+1), and issues a signed `CrossPoolFallbackMigrationGrant`.
 * Returns `null` when the session is NOT currently on `local_container` (zero weakening of
 * fail-closed locks for ordinary sessions).
 */
export function createSelfhostReturnToRemoteGrantResolver(
  deps: Pick<
    SelfhostCrossPoolSelectorDeps,
    | 'pool'
    | 'selfhost'
    | 'authorityStore'
    | 'pendingBillingChecker'
    | 'prepareRollingCheckpoint'
    | 'verifyContinuityApplied'
  >,
): (input: SelfhostReturnToRemoteInput) => Promise<CrossPoolFallbackMigrationGrant | null> {
  const authorityStore =
    deps.authorityStore ?? (deps.pool ? new PgSessionAuthorityStateStore(deps.pool) : undefined)

  return async (
    input: SelfhostReturnToRemoteInput,
  ): Promise<CrossPoolFallbackMigrationGrant | null> => {
    if (deps.selfhost !== true || !authorityStore) return null
    if (!deps.pendingBillingChecker && !deps.pool) return null
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

    let existingPointer: Awaited<ReturnType<PgSessionAuthorityStateStore['getEnginePointer']>>
    try {
      existingPointer = await authorityStore.getEnginePointer(input.uid, input.sessionKey)
    } catch {
      return null
    }
    let isLegacyLocalWithoutPointer = !existingPointer && input.hasLocalHistory === true
    if (isLegacyLocalWithoutPointer && deps.pool) {
      // OCV5-902 B4: Do not classify an unpointed session with historical remote_agent_bindings
      // as pre-existing local history; only pure-local unpointed sessions migrate 1 -> 2.
      try {
        const rbRes = await deps.pool.query<{ operation_id?: string | null }>(
          `SELECT operation_id FROM remote_agent_bindings
            WHERE user_id = $1 AND session_key = $2
            LIMIT 1`,
          [input.uid, input.sessionKey],
        )
        if (rbRes.rows.length > 0) {
          isLegacyLocalWithoutPointer = false
        }
      } catch {
        return null
      }
    }
    if (!existingPointer && !isLegacyLocalWithoutPointer) {
      return null
    }

    const backendOperationId =
      'operationId' in input.executionBackend &&
      typeof input.executionBackend.operationId === 'string' &&
      input.executionBackend.operationId.trim().length > 0
        ? input.executionBackend.operationId.trim()
        : null
    const pendingInstall = existingPointer
      ? extractPendingInstallMigration(existingPointer.promptCacheMeta)
      : null
    // OCV5-893 B3: Restrict remote re-delivery strictly to the exact committed targetOperationId
    // when one was recorded so a brand-new remote operation can never inherit a stale grant.
    const operationMatchesPendingInstall =
      pendingInstall !== null &&
      (pendingInstall.targetOperationId === null ||
        (backendOperationId !== null && pendingInstall.targetOperationId === backendOperationId))
    const isPendingRemoteInstallRedelivery =
      existingPointer !== null &&
      existingPointer.poolKind === 'remote_pool' &&
      existingPointer.migrationState === 'active' &&
      existingPointer.engine === authEngine &&
      pendingInstall !== null &&
      pendingInstall.targetPoolKind === 'remote_pool' &&
      pendingInstall.targetEpoch === existingPointer.placementEpoch &&
      operationMatchesPendingInstall

    if (
      !isLegacyLocalWithoutPointer &&
      existingPointer?.poolKind !== 'local_container' &&
      !isPendingRemoteInstallRedelivery
    ) {
      return null
    }

    const backendDriverId =
      'driverId' in input.executionBackend &&
      typeof input.executionBackend.driverId === 'string' &&
      input.executionBackend.driverId.trim().length > 0
        ? input.executionBackend.driverId.trim()
        : engineFamily
    const backendProfileId =
      'profileId' in input.executionBackend &&
      typeof input.executionBackend.profileId === 'string' &&
      input.executionBackend.profileId.trim().length > 0
        ? input.executionBackend.profileId.trim()
        : undefined
    const backendGeneration =
      'generation' in input.executionBackend &&
      typeof input.executionBackend.generation === 'string' &&
      input.executionBackend.generation.trim().length > 0
        ? input.executionBackend.generation.trim()
        : undefined
    const excludeCurrentPreparedBinding: ExcludeCurrentPreparedBinding | undefined =
      backendGeneration && backendProfileId
        ? {
            operationId: input.executionBackend.operationId,
            generation: backendGeneration,
            profileId: backendProfileId,
          }
        : undefined

    // B06 + B01: Verify NO unsettled billing journal and NO other unreleased remote binding exists.
    // Excuse ONLY the exact (operationId, generation, profileId) row prepared for this turn by
    // cc5BackendSelector/ensureLane when checking `state <> 'released'`; never skip billing journals.
    try {
      if (deps.pendingBillingChecker) {
        const hasPending = await deps.pendingBillingChecker({
          uid: input.uid,
          sessionKey: input.sessionKey,
          operationId: existingPointer?.operationId ?? null,
          ...(excludeCurrentPreparedBinding ? { excludeCurrentPreparedBinding } : {}),
        })
        if (hasPending) {
          input.onBlocked?.('REMOTE_OPERATION_BILLING_PENDING')
          return null
        }
      } else if (deps.pool) {
        await assertNoPendingRemoteBillingForSession(
          deps.pool,
          input.uid,
          input.sessionKey,
          existingPointer?.operationId ?? null,
          excludeCurrentPreparedBinding ? { excludeCurrentPreparedBinding } : undefined,
        )
      }
    } catch {
      input.onBlocked?.('REMOTE_OPERATION_BILLING_PENDING')
      return null
    }

    // OCV5-893 B3 + OCV5-902 B2: PG already committed `local_container -> remote_pool` at this
    // epoch, but the first frame was lost before container installation. Re-deliver the exact
    // committed grant ONLY after verifying checkpoint availability and `beforeCommit` sign check.
    if (isPendingRemoteInstallRedelivery && pendingInstall !== null) {
      const resolvedPending = await resolveRedeliveredPendingInstall({
        authorityStore,
        uid: input.uid,
        sessionKey: input.sessionKey,
        pendingInstall,
      })
      if (!resolvedPending.ok) {
        input.onBlocked?.(resolvedPending.blockedCode)
        return null
      }
      const redeliveredCheckpoint = resolvedPending.checkpoint
      const redeliveredGrant: CrossPoolFallbackMigrationGrant = makeMigrationGrant(
        {
          migrationId: pendingInstall.migrationId,
          placementEpoch: pendingInstall.targetEpoch,
          allowBackendTransition: true as const,
          continuityTier: resolvedPending.continuityTier,
        },
        redeliveredCheckpoint,
      )
      if (input.beforeCommit) {
        let approved = false
        try {
          approved = await input.beforeCommit({
            migrationGrant: redeliveredGrant,
            ...(redeliveredCheckpoint ? { deliveredCheckpoint: redeliveredCheckpoint } : {}),
          })
        } catch {
          approved = false
        }
        if (!approved) {
          input.onBlocked?.('RETURN_TO_REMOTE_SIGN_REJECTED')
          return null
        }
      }
      if (redeliveredCheckpoint) {
        input.onDeliveredCheckpoint?.(redeliveredCheckpoint)
      }
      return redeliveredGrant
    }

    const sourcePlacementEpoch = existingPointer?.placementEpoch ?? 1
    const sourceEngine = existingPointer?.engine ?? authEngine

    const continuity = await resolveAndVerifyCrossPoolContinuity({
      authorityStore,
      uid: input.uid,
      containerId: input.containerId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      fromPoolKind: 'local_container',
      toPoolKind: 'remote_pool',
      sourcePlacementEpoch,
      sourceEngine,
      historicalMessages: input.historicalMessages,
      excludeClientMessageId: input.excludeClientMessageId,
      prepareRollingCheckpoint: input.prepareRollingCheckpoint ?? deps.prepareRollingCheckpoint,
      depsVerifier: deps.verifyContinuityApplied,
      inputVerifier: input.verifyContinuityApplied,
    })
    if (!continuity.ok) {
      input.onBlocked?.('AUTHORITY_CHECKPOINT_READ_FAILED')
      return null
    }
    const continuityTier: ResumeLadderTier = continuity.continuityTier
    const deliveredCheckpoint = continuity.deliveredCheckpoint

    const fromPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: sourceEngine,
      driverId: `local-${engineFamily}`,
      placementEpoch: sourcePlacementEpoch,
      containerId: String(input.containerId),
    }
    const toPlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: authEngine,
      driverId: backendDriverId,
      placementEpoch: sourcePlacementEpoch + 1,
      operationId: input.executionBackend.operationId,
      ...(backendProfileId ? { profileId: backendProfileId } : {}),
    }

    const begun = await authorityStore.beginPlacementMigration({
      userId: input.uid,
      sessionKey: input.sessionKey,
      expectedPlacementEpoch: sourcePlacementEpoch,
      fromPlacement,
      toPlacement,
      reason: isLegacyLocalWithoutPointer
        ? 'legacy_local_session_migrated_to_remote'
        : 'remote_pool_recovered_return_from_local',
    })
    if (!begun.applied) {
      input.onBlocked?.('RETURN_TO_REMOTE_MIGRATION_CONFLICT')
      return null
    }

    const preparedGrant: CrossPoolFallbackMigrationGrant = makeMigrationGrant(
      {
        migrationId: begun.migration.migrationId,
        placementEpoch: begun.migration.toEpoch,
        allowBackendTransition: true as const,
        continuityTier,
      },
      deliveredCheckpoint,
    )

    if (input.beforeCommit) {
      let commitApproved = false
      try {
        commitApproved = await input.beforeCommit({
          migrationGrant: preparedGrant,
          ...(deliveredCheckpoint ? { deliveredCheckpoint } : {}),
        })
      } catch {
        commitApproved = false
      }
      if (!commitApproved) {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'return_to_remote_sign_validation_rejected',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        input.onBlocked?.('RETURN_TO_REMOTE_SIGN_REJECTED')
        return null
      }
    }

    const readBackCommittedRemote = async () => {
      const readBack = await authorityStore
        .getPlacementMigration(begun.migration.migrationId)
        .catch(() => null)
      if (readBack && readBack.state === 'committed') {
        const ptr = await authorityStore
          .getEnginePointer(input.uid, input.sessionKey)
          .catch(() => null)
        if (
          ptr &&
          ptr.poolKind === 'remote_pool' &&
          ptr.migrationState === 'active' &&
          ptr.placementEpoch === readBack.toEpoch
        ) {
          return { applied: true as const, migration: readBack, pointer: ptr }
        }
      }
      return null
    }

    let committed = await authorityStore
      .commitPlacementMigration({
        migrationId: begun.migration.migrationId,
        userId: input.uid,
        sessionKey: input.sessionKey,
        continuityTier,
        ...(continuityTier === 'tape_rebuilt' && deliveredCheckpoint
          ? { checkpointGeneration: deliveredCheckpoint.checkpointGeneration }
          : {}),
        operationId: input.executionBackend.operationId,
        ...(backendProfileId ? { profileId: backendProfileId } : {}),
      })
      .catch(async () => {
        // OCV5-893 B3: If PG commit actually landed before ack was lost, read back
        // authoritative state and deliver the committed grant instead of mis-aborting!
        const recovered = await readBackCommittedRemote()
        if (recovered) return recovered
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
      const recovered = await readBackCommittedRemote()
      if (recovered) {
        committed = recovered
      } else {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'return_to_remote_commit_not_applied',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        input.onBlocked?.('RETURN_TO_REMOTE_COMMIT_FAILED')
        return null
      }
    }

    if (deliveredCheckpoint) {
      input.onDeliveredCheckpoint?.(deliveredCheckpoint)
    }

    return makeMigrationGrant(
      {
        migrationId: committed.migration.migrationId,
        placementEpoch: committed.pointer.placementEpoch,
        allowBackendTransition: true as const,
        continuityTier: committed.migration.continuityTier ?? continuityTier,
      },
      deliveredCheckpoint,
    )
  }
}

/**
 * OCV5-902 B4: Forced-local migration grant resolver for selfhost V5.
 * When an active `remote_pool` session is redirected to local execution by an admin binding
 * priority/disable change (`MODEL_POOL_BINDING_FORCED_LOCAL`), runs the exact same B06
 * unsettled-billing fence, `tape_rebuilt` checkpoint continuity proof, and CAS epoch migration
 * (`remote_pool` -> `local_container`, epoch N -> N+1) so the container transitions cleanly
 * without hitting `CC5_BACKEND_SCOPE_CHANGED`.
 */
export function createSelfhostForcedLocalMigrationResolver(
  deps: Pick<
    SelfhostCrossPoolSelectorDeps,
    | 'pool'
    | 'selfhost'
    | 'authorityStore'
    | 'pendingBillingChecker'
    | 'prepareRollingCheckpoint'
    | 'verifyContinuityApplied'
  >,
): (input: SelfhostForcedLocalMigrationInput) => Promise<CrossPoolFallbackMigrationGrant | null> {
  const authorityStore =
    deps.authorityStore ?? (deps.pool ? new PgSessionAuthorityStateStore(deps.pool) : undefined)

  return async (
    input: SelfhostForcedLocalMigrationInput,
  ): Promise<CrossPoolFallbackMigrationGrant | null> => {
    if (deps.selfhost !== true || !authorityStore) return null
    if (!deps.pendingBillingChecker && !deps.pool) return null
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
    if (LOCAL_CROSS_POOL_FALLBACK_SUPPORTED_ENGINES[authEngine] !== true) return null
    const engineFamily = ENGINE_FAMILY_BY_AUTHORITY[authEngine]

    let existingPointer: Awaited<ReturnType<PgSessionAuthorityStateStore['getEnginePointer']>>
    try {
      existingPointer = await authorityStore.getEnginePointer(input.uid, input.sessionKey)
    } catch {
      return null
    }
    // OCV5-902 B4: Reconstruct unpointed legacy remote sessions from authoritative remote_agent_bindings
    // so disabling a remote binding mid-session still performs a verified 1 -> 2 migration (with B06).
    let inferredRemoteBinding: { operationId: string | null; profileId: string | null } | null = null
    if (!existingPointer && deps.pool) {
      try {
        const rbRes = await deps.pool.query<{
          operation_id?: string | null
          profile_id?: string | null
        }>(
          `SELECT operation_id, profile_id
             FROM remote_agent_bindings
            WHERE user_id = $1 AND session_key = $2
            ORDER BY updated_at DESC
            LIMIT 1`,
          [input.uid, input.sessionKey],
        )
        const rbRow = rbRes.rows[0]
        if (rbRow) {
          inferredRemoteBinding = {
            operationId:
              typeof rbRow.operation_id === 'string' && rbRow.operation_id.trim().length > 0
                ? rbRow.operation_id.trim()
                : null,
            profileId:
              typeof rbRow.profile_id === 'string' && rbRow.profile_id.trim().length > 0
                ? rbRow.profile_id.trim()
                : null,
          }
        }
      } catch {
        input.onBlocked?.('REMOTE_PLACEMENT_LOOKUP_FAILED')
        return null
      }
    }
    if (!existingPointer && !inferredRemoteBinding) return null

    const pendingInstall = existingPointer
      ? extractPendingInstallMigration(existingPointer.promptCacheMeta)
      : null
    const isPendingLocalInstallRedelivery =
      existingPointer !== null &&
      existingPointer.poolKind === 'local_container' &&
      existingPointer.migrationState === 'active' &&
      existingPointer.engine === authEngine &&
      pendingInstall !== null &&
      pendingInstall.targetPoolKind === 'local_container' &&
      pendingInstall.targetEpoch === existingPointer.placementEpoch

    if (
      existingPointer !== null &&
      existingPointer.poolKind !== 'remote_pool' &&
      !isPendingLocalInstallRedelivery
    ) {
      return null
    }

    const sourcePlacementEpoch = existingPointer?.placementEpoch ?? 1
    const sourceEngine = existingPointer?.engine ?? authEngine
    const sourceOperationId = existingPointer?.operationId ?? inferredRemoteBinding?.operationId ?? null
    const sourceProfileId = existingPointer?.profileId ?? inferredRemoteBinding?.profileId ?? null

    // B06: Strictly enforce unsettled remote billing fence before migrating away from remote_pool.
    try {
      if (deps.pendingBillingChecker) {
        const hasPending = await deps.pendingBillingChecker({
          uid: input.uid,
          sessionKey: input.sessionKey,
          operationId: sourceOperationId,
        })
        if (hasPending) {
          input.onBlocked?.('REMOTE_OPERATION_BILLING_PENDING')
          return null
        }
      } else if (deps.pool) {
        await assertNoPendingRemoteBillingForSession(
          deps.pool,
          input.uid,
          input.sessionKey,
          sourceOperationId,
        )
      }
    } catch {
      input.onBlocked?.('REMOTE_OPERATION_BILLING_PENDING')
      return null
    }

    if (isPendingLocalInstallRedelivery && pendingInstall !== null) {
      const resolvedPending = await resolveRedeliveredPendingInstall({
        authorityStore,
        uid: input.uid,
        sessionKey: input.sessionKey,
        pendingInstall,
      })
      if (!resolvedPending.ok) {
        input.onBlocked?.(resolvedPending.blockedCode)
        return null
      }
      const redeliveredCheckpoint = resolvedPending.checkpoint
      const redeliveredGrant = makeMigrationGrant(
        {
          migrationId: pendingInstall.migrationId,
          placementEpoch: pendingInstall.targetEpoch,
          allowBackendTransition: true as const,
          continuityTier: resolvedPending.continuityTier,
        },
        redeliveredCheckpoint,
      )
      if (input.beforeCommit) {
        let approved = false
        try {
          approved = await input.beforeCommit({
            migrationGrant: redeliveredGrant,
            ...(redeliveredCheckpoint ? { deliveredCheckpoint: redeliveredCheckpoint } : {}),
          })
        } catch {
          approved = false
        }
        if (!approved) {
          input.onBlocked?.('FORCED_LOCAL_SIGN_REJECTED')
          return null
        }
      }
      if (redeliveredCheckpoint) {
        input.onDeliveredCheckpoint?.(redeliveredCheckpoint)
      }
      return redeliveredGrant
    }

    if (existingPointer && existingPointer.migrationState !== 'active') {
      input.onBlocked?.('FORCED_LOCAL_MIGRATION_CONFLICT')
      return null
    }

    const continuity = await resolveAndVerifyCrossPoolContinuity({
      authorityStore,
      uid: input.uid,
      containerId: input.containerId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      fromPoolKind: 'remote_pool',
      toPoolKind: 'local_container',
      sourcePlacementEpoch,
      sourceEngine,
      historicalMessages: input.historicalMessages,
      excludeClientMessageId: input.excludeClientMessageId,
      prepareRollingCheckpoint: input.prepareRollingCheckpoint ?? deps.prepareRollingCheckpoint,
      depsVerifier: deps.verifyContinuityApplied,
      inputVerifier: input.verifyContinuityApplied,
    })
    if (!continuity.ok) {
      input.onBlocked?.('AUTHORITY_CHECKPOINT_READ_FAILED')
      return null
    }
    const continuityTier: ResumeLadderTier = continuity.continuityTier
    const deliveredCheckpoint = continuity.deliveredCheckpoint

    const fromPlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: sourceEngine,
      driverId: engineFamily,
      placementEpoch: sourcePlacementEpoch,
      ...(sourceProfileId ? { profileId: sourceProfileId } : {}),
      ...(sourceOperationId ? { operationId: sourceOperationId } : {}),
    }
    const toPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: authEngine,
      driverId: `local-${engineFamily}`,
      placementEpoch: sourcePlacementEpoch + 1,
      containerId: String(input.containerId),
    }

    const begun = await authorityStore.beginPlacementMigration({
      userId: input.uid,
      sessionKey: input.sessionKey,
      expectedPlacementEpoch: sourcePlacementEpoch,
      fromPlacement,
      toPlacement,
      reason:
        typeof input.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : 'MODEL_POOL_BINDING_FORCED_LOCAL',
    })
    if (!begun.applied) {
      input.onBlocked?.('FORCED_LOCAL_MIGRATION_CONFLICT')
      return null
    }

    const preparedGrant = makeMigrationGrant(
      {
        migrationId: begun.migration.migrationId,
        placementEpoch: begun.migration.toEpoch,
        allowBackendTransition: true as const,
        continuityTier,
      },
      deliveredCheckpoint,
    )

    if (input.beforeCommit) {
      let commitApproved = false
      try {
        commitApproved = await input.beforeCommit({
          migrationGrant: preparedGrant,
          ...(deliveredCheckpoint ? { deliveredCheckpoint } : {}),
        })
      } catch {
        commitApproved = false
      }
      if (!commitApproved) {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'forced_local_sign_validation_rejected',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        input.onBlocked?.('FORCED_LOCAL_SIGN_REJECTED')
        return null
      }
    }

    const readBackCommittedLocal = async () => {
      const readBack = await authorityStore
        .getPlacementMigration(begun.migration.migrationId)
        .catch(() => null)
      if (readBack && readBack.state === 'committed') {
        const ptr = await authorityStore
          .getEnginePointer(input.uid, input.sessionKey)
          .catch(() => null)
        if (
          ptr &&
          ptr.poolKind === 'local_container' &&
          ptr.migrationState === 'active' &&
          ptr.placementEpoch === readBack.toEpoch
        ) {
          return { applied: true as const, migration: readBack, pointer: ptr }
        }
      }
      return null
    }

    let committed = await authorityStore
      .commitPlacementMigration({
        migrationId: begun.migration.migrationId,
        userId: input.uid,
        sessionKey: input.sessionKey,
        continuityTier,
        ...(continuityTier === 'tape_rebuilt' && deliveredCheckpoint
          ? { checkpointGeneration: deliveredCheckpoint.checkpointGeneration }
          : {}),
      })
      .catch(async () => {
        const recovered = await readBackCommittedLocal()
        if (recovered) return recovered
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'forced_local_commit_failed',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        return null
      })

    if (!committed || !committed.applied) {
      const recovered = await readBackCommittedLocal()
      if (recovered) {
        committed = recovered
      } else {
        await authorityStore
          .abortPlacementMigration({
            migrationId: begun.migration.migrationId,
            reason: 'forced_local_commit_not_applied',
            userId: input.uid,
            sessionKey: input.sessionKey,
          })
          .catch(() => {})
        input.onBlocked?.('FORCED_LOCAL_COMMIT_FAILED')
        return null
      }
    }

    if (deliveredCheckpoint) {
      input.onDeliveredCheckpoint?.(deliveredCheckpoint)
    }

    return makeMigrationGrant(
      {
        migrationId: committed.migration.migrationId,
        placementEpoch: committed.pointer.placementEpoch,
        allowBackendTransition: true as const,
        continuityTier: committed.migration.continuityTier ?? continuityTier,
      },
      deliveredCheckpoint,
    )
  }
}
