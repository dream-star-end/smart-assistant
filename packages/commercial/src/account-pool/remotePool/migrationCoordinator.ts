/**
 * OCV5-890 Wave 2 — Cross-Pool Seamless Migration Coordinator (`MigrationCoordinator`).
 *
 * Implements L0 `PoolMigrationControl` and orchestrates the 9-step live brain cutover
 * state machine while keeping the Layer 3 Execution Environment ("hands & feet")
 * anchored in place:
 *   1. Pre-flight safety gate: fail-closed unless `settledToolsProven === true` and
 *      execEnv is quiesced (`MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT`).
 *   2. PG CAS fence: `authorityStore.beginPlacementMigration` (returns
 *      `MIGRATION_EPOCH_CONFLICT` on stale epoch or concurrent migration).
 *   3. Source dual-proof stop + Tier 1 capsule export (graceful degrade to Tier 2
 *      when source host is unreachable or export fails).
 *   4. Execution environment in-place anchor: `execEnv.rebindBrain` with strictly
 *      monotonic `(brainGen, fencingToken)`, preserving active `oc_bash` jobs /
 *      previews / browser / swarm attachments.
 *   5. Target pool prewarm + 3-tier continuity ladder (`hot_native` → `warm_capsule`
 *      / `tape_rebuilt` with rolling checkpoint → `cold_degraded`).
 *   6. Atomic commit (`commitPlacementMigration`) + revoke old `CredentialLease`.
 *   7. Full rollback on any pre-commit failure (`abortPlacementMigration`, candidate
 *      credential revocation, NEVER flipping `placementEpoch`).
 *
 * Module: accounts (L3). Zero environment-variable reads, zero network I/O,
 * zero forbidden crypto, zero engine/provider literal special cases, zero billing SQL.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  computeStickyHomeKey,
  validatePlacementDescriptor,
  type AuthorityEngineKind,
  type CredentialLeaseHandle,
  type CredentialLeaseMountKind,
  type EngineStateCapsuleManifest,
  type EngineStateCapsuleRef,
  type ExecEnvAttachmentDigest,
  type ManagedJobSummary,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type PoolMigrationControl,
  type ResumeLadderTier,
  type RollingCheckpointMode,
  type SessionEnginePointer,
} from '@openclaude/protocol'
import type {
  AbortPlacementMigrationCas,
  AbortPlacementMigrationResult,
  BeginPlacementMigrationCas,
  BeginPlacementMigrationResult,
  CommitPlacementMigrationCas,
  CommitPlacementMigrationResult,
  SaveRollingCheckpointInput,
  SaveRollingCheckpointResult,
} from '../../db/threeLayerStateStore.js'
import type { RemoteReleaseDrainStatus } from './drainGate.js'

export interface MigrationAuthorityStorePort {
  beginPlacementMigration(cas: BeginPlacementMigrationCas): Promise<BeginPlacementMigrationResult>
  commitPlacementMigration(cas: CommitPlacementMigrationCas): Promise<CommitPlacementMigrationResult>
  abortPlacementMigration(cas: AbortPlacementMigrationCas): Promise<AbortPlacementMigrationResult>
  saveRollingCheckpoint(input: SaveRollingCheckpointInput): Promise<SaveRollingCheckpointResult>
  getPlacementMigration?(migrationId: string): Promise<PlacementMigrationRecord | null>
  getEnginePointer?(
    userId: number | bigint,
    sessionKey: string,
  ): Promise<SessionEnginePointer | null>
}

export type ExportCapsuleResult =
  | {
      readonly ok: true
      readonly capsuleRef: EngineStateCapsuleRef
      readonly manifest?: EngineStateCapsuleManifest
    }
  | {
      readonly ok: false
      readonly reason: string
    }

export type ImportCapsuleResult =
  | {
      readonly ok: true
      readonly nativeSessionId: string
      readonly continuityTier?: 'hot_native' | 'warm_capsule'
    }
  | {
      readonly ok: false
      readonly reason: string
    }

export type DegradeToTranscriptResult =
  | {
      readonly ok: true
      readonly tier: 'warm_capsule' | 'tape_rebuilt'
      readonly summary: string
      readonly anchorSeq: number
      readonly instructions?: string | null
      readonly nativeSessionId?: string | null
      readonly mode?: RollingCheckpointMode
    }
  | {
      readonly ok: false
      readonly reason: string
    }

export interface MigrationCapsulePort {
  exportCapsule(args: {
    readonly tenantId: string
    readonly sessionKey: string
    readonly placement: PlacementDescriptor
    readonly placementEpoch: number
    readonly nativeSessionId?: string | null
  }): Promise<ExportCapsuleResult>
  importCapsule(args: {
    readonly tenantId: string
    readonly sessionKey: string
    readonly targetPlacement: PlacementDescriptor
    readonly targetEpoch: number
    readonly capsuleRef: EngineStateCapsuleRef
  }): Promise<ImportCapsuleResult>
  degradeToTranscript(args: {
    readonly tenantId: string
    readonly sessionKey: string
    readonly sessionId: string
    readonly sourcePlacement: PlacementDescriptor
    readonly targetPlacement: PlacementDescriptor
    readonly targetEpoch: number
    readonly capsuleRef?: EngineStateCapsuleRef | null
    readonly reason: string
  }): Promise<DegradeToTranscriptResult>
}

export interface ExecEnvAttachmentSnapshot extends ExecEnvAttachmentDigest {
  readonly activeJobs?: readonly ManagedJobSummary[]
  readonly activePreviews?: readonly string[]
  readonly activeBrowserSessions?: readonly string[]
  readonly activeSwarmMembers?: readonly string[]
}

export type RebindBrainResult =
  | {
      readonly ok: true
      readonly brainGen: number
      readonly fencingToken: string
      readonly revokedPreviousFencingToken?: string
      readonly attachment?: ExecEnvAttachmentSnapshot
    }
  | {
      readonly ok: false
      readonly reason: string
    }

export interface MigrationExecEnvPort {
  quiesce(args: {
    readonly leaseId: string
    readonly sessionKey: string
    readonly reason: string
  }): Promise<{
    readonly quiesced: boolean
    readonly activeToolCalls?: number
    readonly reason?: string
  }>
  exportAttachmentDigest(args: {
    readonly leaseId: string
    readonly sessionKey: string
  }): Promise<ExecEnvAttachmentSnapshot>
  rebindBrain(args: {
    readonly leaseId: string
    readonly sessionKey: string
    readonly nextBrainGen: number
    readonly nextFencingToken: string
    readonly previousFencingToken?: string
    readonly targetPlacement: PlacementDescriptor
  }): Promise<RebindBrainResult>
}

export interface MigrationCredentialLeasePort {
  issueLease(request: {
    readonly tenantId: string
    readonly profileId: string
    readonly engine: AuthorityEngineKind
    readonly mountKind: CredentialLeaseMountKind
    readonly ttlMs: number
    readonly scope?: readonly string[]
  }): Promise<CredentialLeaseHandle>
  revokeLease(leaseId: string, reason: string): Promise<boolean>
}

export interface MigrationDriverPort {
  stopLane(args: {
    readonly placement: PlacementDescriptor
    readonly sessionKey: string
    readonly migrationId: string
    readonly reason: string
  }): Promise<{
    readonly stopped: boolean
    readonly reachable: boolean
    readonly dualProofVerified?: boolean
    readonly reason?: string
  }>
  prewarm(args: {
    readonly targetPlacement: PlacementDescriptor
    readonly stickyHomeKey: string
    readonly frozenPromptSha256?: string
    readonly credentialLease?: CredentialLeaseHandle
    readonly sessionKey: string
  }): Promise<{
    readonly ready: boolean
    readonly prewarmedKey?: string
    readonly reason?: string
  }>
}

export interface MigrationDrainResult {
  readonly drained: true
  readonly elapsedMs: number
  readonly releaseRunId: string
  readonly admissionClosedAt: string
  readonly drainedAt: string
}

export interface MigrationDrainOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly releaseRunId?: string
  readonly keepClosedForRestart?: boolean
}

export interface MigrationDrainCoordinatorPort {
  status?(): RemoteReleaseDrainStatus
  reopen(): void
  drain?(options?: MigrationDrainOptions): Promise<MigrationDrainResult>
  drainForCutover?(
    pool: unknown,
    options?: MigrationDrainOptions,
  ): Promise<MigrationDrainResult>
}

export interface MigrationCoordinatorDeps {
  readonly authorityStore: MigrationAuthorityStorePort
  readonly capsuleStore: MigrationCapsulePort
  readonly execEnv: MigrationExecEnvPort
  readonly credentialLeases: MigrationCredentialLeasePort
  readonly drivers: MigrationDriverPort
  readonly drainCoordinator?: MigrationDrainCoordinatorPort
  readonly drainPool?: unknown
  readonly control?: Partial<PoolMigrationControl>
  readonly now?: () => number
}

export interface MigrationHandoffInput {
  readonly userId: number | bigint
  readonly tenantId: string
  readonly sessionKey: string
  readonly sessionId: string
  readonly expectedPlacementEpoch: number
  readonly fromPlacement: PlacementDescriptor
  readonly toPlacement: PlacementDescriptor
  readonly settledToolsProven: boolean
  readonly execEnvLeaseId: string
  readonly currentBrainGen: number
  readonly currentFencingToken?: string
  readonly previousCredentialLeaseId?: string
  readonly targetCredentialMountKind?: CredentialLeaseMountKind
  readonly targetCredentialTtlMs?: number
  readonly targetCredentialScope?: readonly string[]
  readonly stickyHomeKey?: string
  readonly frozenPromptSha256?: string
  readonly nativeSessionId?: string | null
  readonly allowColdFallback?: boolean
  readonly migrationId?: string
  readonly reason?: string
}

export interface MigrationHandoffSuccess {
  readonly ok: true
  readonly migrationId: string
  readonly fromEpoch: number
  readonly toEpoch: number
  readonly continuityTier: ResumeLadderTier
  readonly notifyContextRebuilt: boolean
  readonly degradedReasons: readonly string[]
  readonly capsuleRef: EngineStateCapsuleRef | null
  readonly checkpointGeneration: string | null
  readonly nativeSessionId: string | null
  readonly stickyHomeKey: string
  readonly brainGen: number
  readonly fencingToken: string
  readonly revokedPreviousFencingToken?: string
  readonly attachment: ExecEnvAttachmentSnapshot
  readonly issuedCredentialLease: CredentialLeaseHandle | null
  readonly previousCredentialRevoked: boolean
  readonly migration: PlacementMigrationRecord
  readonly pointer: SessionEnginePointer
}

export type MigrationHandoffErrorCode =
  | 'MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT'
  | 'MIGRATION_EPOCH_CONFLICT'
  | 'MIGRATION_SOURCE_STOP_FAILED'
  | 'MIGRATION_CREDENTIAL_LEASE_FAILED'
  | 'MIGRATION_EXEC_ENV_REBIND_FAILED'
  | 'MIGRATION_TARGET_PREWARM_FAILED'
  | 'MIGRATION_CAPSULE_REQUIRED'
  | 'MIGRATION_STATE_RESTORE_FAILED'
  | 'MIGRATION_COMMIT_CONFLICT'

export interface MigrationHandoffFailure {
  readonly ok: false
  readonly code: MigrationHandoffErrorCode
  readonly reason: string
  readonly placementEpoch: number
  readonly rolledBack: boolean
  readonly recoveryRequired?: boolean
  readonly restoredSourceLease?: {
    readonly brainGen: number
    readonly fencingToken: string
  }
  readonly migrationId?: string
  readonly conflictReason?: 'epoch_mismatch' | 'already_migrating'
  readonly activeMigrationId?: string | null
}

export type MigrationHandoffResult = MigrationHandoffSuccess | MigrationHandoffFailure

export interface MigrationPrewarmInput {
  readonly sessionKey: string
  readonly targetPlacement: PlacementDescriptor
  readonly stickyHomeKey?: string
  readonly frozenPromptSha256?: string
  readonly credentialLease?: CredentialLeaseHandle
}

export interface MigrationPrewarmResult {
  readonly ready: boolean
  readonly stickyHomeKey: string
  readonly prewarmedKey?: string
  readonly reason?: string
}

const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60_000
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function buildMonotonicFencingToken(
  migrationId: string,
  toEpoch: number,
  nextBrainGen: number,
): string {
  const epochPart = String(toEpoch).padStart(6, '0')
  const genPart = String(nextBrainGen).padStart(6, '0')
  const digest = createHash('sha256')
    .update(`oc-brain-fence-v5:${migrationId}:${toEpoch}:${nextBrainGen}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
  return `fence-e${epochPart}-g${genPart}-${digest}`
}

export class MigrationCoordinator implements PoolMigrationControl {
  readonly allowAutoMigration: boolean
  readonly preserveStickyHome: boolean
  readonly requireCapsuleForWarmHandoff: boolean
  readonly drainTimeoutMs: number

  private readonly authorityStore: MigrationAuthorityStorePort
  private readonly capsuleStore: MigrationCapsulePort
  private readonly execEnv: MigrationExecEnvPort
  private readonly credentialLeases: MigrationCredentialLeasePort
  private readonly drivers: MigrationDriverPort
  private readonly drainCoordinator?: MigrationDrainCoordinatorPort
  private readonly drainPool?: unknown
  private readonly now: () => number
  private draining = false

  constructor(deps: MigrationCoordinatorDeps) {
    this.authorityStore = deps.authorityStore
    this.capsuleStore = deps.capsuleStore
    this.execEnv = deps.execEnv
    this.credentialLeases = deps.credentialLeases
    this.drivers = deps.drivers
    this.drainCoordinator = deps.drainCoordinator
    this.drainPool = deps.drainPool
    this.now = deps.now ?? Date.now

    this.allowAutoMigration = deps.control?.allowAutoMigration ?? true
    this.preserveStickyHome = deps.control?.preserveStickyHome ?? true
    this.requireCapsuleForWarmHandoff = deps.control?.requireCapsuleForWarmHandoff ?? false
    this.drainTimeoutMs = Math.max(50, Math.floor(deps.control?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS))
  }

  get isDraining(): boolean {
    return this.draining
  }

  async handoff(args: MigrationHandoffInput): Promise<MigrationHandoffResult> {
    const reason = args.reason ?? 'placement_migration'

    // Step 1: Pre-flight safety gate — never migrate with unsettled tools in flight.
    if (args.settledToolsProven !== true) {
      return Object.freeze({
        ok: false as const,
        code: 'MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT' as const,
        reason: 'settled_tools_proof_missing',
        placementEpoch: args.expectedPlacementEpoch,
        rolledBack: false,
      })
    }

    const fromPlacement = validatePlacementDescriptor(args.fromPlacement)
    const toPlacement = validatePlacementDescriptor(args.toPlacement)
    const stickyHomeKey =
      args.stickyHomeKey ??
      (this.preserveStickyHome
        ? (toPlacement.stickyHomeKey ?? fromPlacement.stickyHomeKey)
        : undefined) ??
      computeStickyHomeKey(args.sessionKey)

    // Step 2: Acquire PG CAS migration ownership FIRST, before quiescing the source ExecEnv.
    // On epoch conflict or concurrent migration, exit immediately without freezing source ExecEnv.
    const beginRes = await this.authorityStore.beginPlacementMigration({
      userId: args.userId,
      sessionKey: args.sessionKey,
      expectedPlacementEpoch: args.expectedPlacementEpoch,
      fromPlacement,
      toPlacement,
      ...(args.migrationId === undefined ? {} : { migrationId: args.migrationId }),
      reason,
    })

    if (!beginRes.applied) {
      return Object.freeze({
        ok: false as const,
        code: 'MIGRATION_EPOCH_CONFLICT' as const,
        reason: beginRes.reason,
        conflictReason: beginRes.reason,
        ...(beginRes.reason === 'already_migrating'
          ? { activeMigrationId: beginRes.activeMigrationId ?? null }
          : {}),
        placementEpoch: beginRes.currentEpoch,
        rolledBack: false,
      })
    }

    const migration = beginRes.migration
    const migrationId = migration.migrationId
    let candidateLease: CredentialLeaseHandle | null = null
    let quiesced = false
    let reboundToBrainGen: number | null = null
    let reboundFencingToken: string | null = null

    const abortAndFail = async (
      code: MigrationHandoffErrorCode,
      abortReason: string,
      opts?: { readonly commitOutcomeUnknown?: boolean; readonly alreadyAbortedInPg?: boolean },
    ): Promise<MigrationHandoffFailure> => {
      let pgAborted = opts?.alreadyAbortedInPg === true
      // B08: NEVER revoke candidate credentials or flip ExecEnv before confirming PG actually
      // aborted! If commitOutcomeUnknown is true, PG may have committed to target; revoking the
      // target lease first would strand the committed target placement without credentials.
      if (!pgAborted && opts?.commitOutcomeUnknown !== true) {
        try {
          const abortRes = await this.authorityStore.abortPlacementMigration({
            migrationId,
            userId: args.userId,
            sessionKey: args.sessionKey,
            reason: `${code}:${abortReason}`,
          })
          pgAborted = abortRes.applied === true
        } catch {
          pgAborted = false
        }
      } else if (!pgAborted && opts?.commitOutcomeUnknown === true) {
        // Attempt PG abort ONLY if migration is still 'migrating' (abortPlacementMigration uses
        // WHERE state = 'migrating', so it returns applied=false if PG already committed!).
        try {
          const abortRes = await this.authorityStore.abortPlacementMigration({
            migrationId,
            userId: args.userId,
            sessionKey: args.sessionKey,
            reason: `${code}:${abortReason}`,
          })
          pgAborted = abortRes.applied === true
        } catch {
          pgAborted = false
        }
      }

      if (candidateLease !== null && (opts?.commitOutcomeUnknown !== true || pgAborted)) {
        try {
          await this.credentialLeases.revokeLease(
            candidateLease.leaseId,
            `migration_aborted:${code}`,
          )
        } catch {
          // Best-effort cleanup of candidate lease during confirmed rollback.
        }
      }

      let execEnvRestored = false
      let restoredSourceLease: { readonly brainGen: number; readonly fencingToken: string } | undefined

      if (!quiesced && reboundToBrainGen === null) {
        execEnvRestored = true
      } else if (opts?.commitOutcomeUnknown && !pgAborted) {
        // PG commit status is unconfirmed and abort did not apply; do NOT split-brain by flipping ExecEnv.
        execEnvRestored = false
      } else {
        const rollbackBrainGen = (reboundToBrainGen ?? args.currentBrainGen) + 1
        const rollbackFencingToken = buildMonotonicFencingToken(
          migrationId,
          Math.max(migration.toEpoch, args.expectedPlacementEpoch),
          rollbackBrainGen,
        )
        const prevToken = reboundFencingToken ?? args.currentFencingToken
        try {
          const restoreRes = await this.execEnv.rebindBrain({
            leaseId: args.execEnvLeaseId,
            sessionKey: args.sessionKey,
            nextBrainGen: rollbackBrainGen,
            nextFencingToken: rollbackFencingToken,
            ...(prevToken === undefined ? {} : { previousFencingToken: prevToken }),
            targetPlacement: fromPlacement,
          })
          if (restoreRes.ok) {
            execEnvRestored = true
            restoredSourceLease = Object.freeze({
              brainGen: restoreRes.brainGen,
              fencingToken: restoreRes.fencingToken,
            })
          } else {
            execEnvRestored = false
          }
        } catch {
          execEnvRestored = false
        }
      }

      const rolledBack = pgAborted && execEnvRestored
      return Object.freeze({
        ok: false as const,
        code,
        reason: abortReason,
        placementEpoch: args.expectedPlacementEpoch,
        rolledBack,
        ...(rolledBack ? {} : { recoveryRequired: true }),
        ...(restoredSourceLease === undefined ? {} : { restoredSourceLease }),
        migrationId,
      })
    }

    // Step 2b: Quiesce source ExecEnv ONLY after owning the PG migration lock.
    let quiesceRes: {
      readonly quiesced: boolean
      readonly activeToolCalls?: number
      readonly reason?: string
    }
    try {
      quiesceRes = await this.execEnv.quiesce({
        leaseId: args.execEnvLeaseId,
        sessionKey: args.sessionKey,
        reason,
      })
    } catch (err) {
      return abortAndFail(
        'MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT',
        `exec_env_quiesce_error:${errorMessage(err)}`,
      )
    }

    if (!quiesceRes.quiesced || (quiesceRes.activeToolCalls ?? 0) > 0) {
      return abortAndFail(
        'MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT',
        quiesceRes.reason ?? 'exec_env_active_tool_calls_remaining',
      )
    }
    quiesced = true

    // Step 3: Source dual-proof stop + Tier 1 capsule export
    const degradedReasons: string[] = []
    let exportedCapsuleRef: EngineStateCapsuleRef | null = null

    let stopOutcome: {
      readonly stopped: boolean
      readonly reachable: boolean
      readonly dualProofVerified?: boolean
      readonly reason?: string
    }
    try {
      stopOutcome = await this.drivers.stopLane({
        placement: fromPlacement,
        sessionKey: args.sessionKey,
        migrationId,
        reason,
      })
    } catch (err) {
      stopOutcome = {
        stopped: false,
        reachable: false,
        reason: `source_stop_unreachable:${errorMessage(err)}`,
      }
    }

    if (!stopOutcome.reachable) {
      degradedReasons.push(stopOutcome.reason ?? 'source_node_unreachable')
    } else if (!stopOutcome.stopped) {
      return abortAndFail(
        'MIGRATION_SOURCE_STOP_FAILED',
        stopOutcome.reason ?? 'source_lane_refused_stop',
      )
    } else {
      try {
        const exportRes = await this.capsuleStore.exportCapsule({
          tenantId: args.tenantId,
          sessionKey: args.sessionKey,
          placement: fromPlacement,
          placementEpoch: args.expectedPlacementEpoch,
          nativeSessionId: args.nativeSessionId ?? null,
        })
        if (exportRes.ok) {
          exportedCapsuleRef = exportRes.capsuleRef
        } else {
          degradedReasons.push(`capsule_export_failed:${exportRes.reason}`)
        }
      } catch (err) {
        degradedReasons.push(`capsule_export_error:${errorMessage(err)}`)
      }
    }

    // Issue candidate target credential lease prior to prewarm / rebind
    if (toPlacement.profileId !== undefined) {
      try {
        candidateLease = await this.credentialLeases.issueLease({
          tenantId: args.tenantId,
          profileId: toPlacement.profileId,
          engine: toPlacement.engine,
          mountKind: args.targetCredentialMountKind ?? 'memfd_or_tmpfs',
          ttlMs: args.targetCredentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS,
          ...(args.targetCredentialScope === undefined
            ? {}
            : { scope: args.targetCredentialScope }),
        })
      } catch (err) {
        return abortAndFail('MIGRATION_CREDENTIAL_LEASE_FAILED', errorMessage(err))
      }
    }

    // Step 4: Anchor Execution Environment in place — rebind brain with monotonic fencingToken
    const nextBrainGen = args.currentBrainGen + 1
    const nextFencingToken = buildMonotonicFencingToken(
      migrationId,
      migration.toEpoch,
      nextBrainGen,
    )

    let rebindRes: RebindBrainResult
    try {
      rebindRes = await this.execEnv.rebindBrain({
        leaseId: args.execEnvLeaseId,
        sessionKey: args.sessionKey,
        nextBrainGen,
        nextFencingToken,
        ...(args.currentFencingToken === undefined
          ? {}
          : { previousFencingToken: args.currentFencingToken }),
        targetPlacement: toPlacement,
      })
    } catch (err) {
      return abortAndFail('MIGRATION_EXEC_ENV_REBIND_FAILED', errorMessage(err))
    }

    if (!rebindRes.ok) {
      return abortAndFail('MIGRATION_EXEC_ENV_REBIND_FAILED', rebindRes.reason)
    }
    reboundToBrainGen = rebindRes.brainGen
    reboundFencingToken = rebindRes.fencingToken

    let attachment: ExecEnvAttachmentSnapshot
    try {
      attachment =
        rebindRes.attachment ??
        (await this.execEnv.exportAttachmentDigest({
          leaseId: args.execEnvLeaseId,
          sessionKey: args.sessionKey,
        }))
    } catch (err) {
      return abortAndFail('MIGRATION_EXEC_ENV_REBIND_FAILED', errorMessage(err))
    }

    // Step 5: Target pool prewarm + 3-tier state restore ladder
    let prewarmRes: { readonly ready: boolean; readonly prewarmedKey?: string; readonly reason?: string }
    try {
      prewarmRes = await this.drivers.prewarm({
        targetPlacement: toPlacement,
        stickyHomeKey,
        ...(args.frozenPromptSha256 === undefined
          ? {}
          : { frozenPromptSha256: args.frozenPromptSha256 }),
        ...(candidateLease === null ? {} : { credentialLease: candidateLease }),
        sessionKey: args.sessionKey,
      })
    } catch (err) {
      return abortAndFail('MIGRATION_TARGET_PREWARM_FAILED', errorMessage(err))
    }

    if (!prewarmRes.ready) {
      return abortAndFail(
        'MIGRATION_TARGET_PREWARM_FAILED',
        prewarmRes.reason ?? 'target_prewarm_rejected',
      )
    }

    let continuityTier: ResumeLadderTier | null = null
    let resolvedNativeSessionId: string | null = null
    let finalCapsuleRef: EngineStateCapsuleRef | null = null
    let checkpointGeneration: string | null = null
    let notifyContextRebuilt = false

    // Tier 1: Hot native capsule import
    if (exportedCapsuleRef !== null) {
      try {
        const importRes = await this.capsuleStore.importCapsule({
          tenantId: args.tenantId,
          sessionKey: args.sessionKey,
          targetPlacement: toPlacement,
          targetEpoch: migration.toEpoch,
          capsuleRef: exportedCapsuleRef,
        })
        if (importRes.ok) {
          continuityTier = importRes.continuityTier ?? 'hot_native'
          resolvedNativeSessionId = importRes.nativeSessionId
          finalCapsuleRef = exportedCapsuleRef
          notifyContextRebuilt = false
        } else {
          degradedReasons.push(`capsule_import_failed:${importRes.reason}`)
        }
      } catch (err) {
        degradedReasons.push(`capsule_import_error:${errorMessage(err)}`)
      }
    }

    // Tier 2A / 2B: Degrade to transcript / warm checkpoint
    if (continuityTier === null) {
      if (this.requireCapsuleForWarmHandoff && args.allowColdFallback === false) {
        return abortAndFail(
          'MIGRATION_CAPSULE_REQUIRED',
          degradedReasons.join('; ') || 'capsule_required_for_warm_handoff',
        )
      }

      try {
        const degradeRes = await this.capsuleStore.degradeToTranscript({
          tenantId: args.tenantId,
          sessionKey: args.sessionKey,
          sessionId: args.sessionId,
          sourcePlacement: fromPlacement,
          targetPlacement: toPlacement,
          targetEpoch: migration.toEpoch,
          capsuleRef: exportedCapsuleRef,
          reason: degradedReasons.join('; ') || 'capsule_unavailable',
        })
        if (degradeRes.ok) {
          const cpRes = await this.authorityStore.saveRollingCheckpoint({
            userId: args.userId,
            sessionKey: args.sessionKey,
            sessionId: args.sessionId,
            expectedPlacementEpoch: args.expectedPlacementEpoch,
            mode: degradeRes.mode ?? 'anchored_v2',
            anchorSeq: degradeRes.anchorSeq,
            sourceEngine: fromPlacement.engine,
            summary: degradeRes.summary,
            instructions: degradeRes.instructions ?? null,
          })
          continuityTier = degradeRes.tier
          checkpointGeneration = cpRes.checkpointGeneration
          resolvedNativeSessionId = degradeRes.nativeSessionId ?? null
          notifyContextRebuilt = degradeRes.tier === 'tape_rebuilt'
        } else {
          degradedReasons.push(`transcript_degrade_failed:${degradeRes.reason}`)
        }
      } catch (err) {
        degradedReasons.push(`transcript_degrade_error:${errorMessage(err)}`)
      }
    }

    // Tier 3: Cold degraded fallback (if permitted)
    if (continuityTier === null) {
      if (args.allowColdFallback === false) {
        return abortAndFail(
          'MIGRATION_STATE_RESTORE_FAILED',
          degradedReasons.join('; ') || 'all_restore_tiers_exhausted',
        )
      }
      continuityTier = 'cold_degraded'
      resolvedNativeSessionId = null
      notifyContextRebuilt = true
    }

    // Step 6: Atomic commit & revoke previous credential lease (read-back authoritative state on unknown error)
    let commitRes: CommitPlacementMigrationResult | null = null
    let commitErr: unknown = null
    try {
      commitRes = await this.authorityStore.commitPlacementMigration({
        migrationId,
        userId: args.userId,
        sessionKey: args.sessionKey,
        continuityTier,
        capsuleRef: finalCapsuleRef,
        nativeSessionId: resolvedNativeSessionId,
        operationId: toPlacement.operationId ?? null,
        profileId: toPlacement.profileId ?? null,
        capsuleId: finalCapsuleRef?.capsuleId ?? null,
      })
    } catch (err) {
      commitErr = err
    }

    let committedOutcome: Extract<CommitPlacementMigrationResult, { readonly applied: true }>
    if (commitErr === null && commitRes !== null && commitRes.applied) {
      committedOutcome = commitRes
    } else {
      let observedMigration: PlacementMigrationRecord | null = null
      if (typeof this.authorityStore.getPlacementMigration === 'function') {
        try {
          observedMigration = await this.authorityStore.getPlacementMigration(migrationId)
        } catch {
          observedMigration = null
        }
      }

      if (observedMigration?.state === 'committed') {
        let observedPointer: SessionEnginePointer | null = null
        if (typeof this.authorityStore.getEnginePointer === 'function') {
          try {
            observedPointer = await this.authorityStore.getEnginePointer(
              args.userId,
              args.sessionKey,
            )
          } catch {
            observedPointer = null
          }
        }
        const resolvedPointer: SessionEnginePointer =
          observedPointer ??
          Object.freeze({
            sessionKey: args.sessionKey,
            placementEpoch: observedMigration.toEpoch,
            poolKind: toPlacement.poolKind,
            engine: toPlacement.engine,
            nativeSessionId: resolvedNativeSessionId,
            operationId: toPlacement.operationId ?? null,
            profileId: toPlacement.profileId ?? null,
            capsuleId: finalCapsuleRef?.capsuleId ?? null,
            history: [],
            rejectedIds: [],
            promptCacheMeta: null,
            usageBaseline: null,
            historyContextVersion: null,
            promotedFromHistory: false,
            migrationState: 'active',
            activeMigrationId: null,
            updatedAt: observedMigration.completedAt ?? new Date(this.now()).toISOString(),
          })
        committedOutcome = {
          applied: true as const,
          migration: observedMigration,
          pointer: resolvedPointer,
        }
      } else {
        const commitReason =
          commitErr !== null ? errorMessage(commitErr) : 'commit_cas_not_applied'
        return abortAndFail('MIGRATION_COMMIT_CONFLICT', commitReason, {
          commitOutcomeUnknown: commitErr !== null && observedMigration === null,
          alreadyAbortedInPg: observedMigration?.state === 'aborted',
        })
      }
    }

    let previousCredentialRevoked = false
    if (args.previousCredentialLeaseId) {
      try {
        previousCredentialRevoked = await this.credentialLeases.revokeLease(
          args.previousCredentialLeaseId,
          `migration_committed:${migrationId}`,
        )
      } catch {
        previousCredentialRevoked = false
      }
    }

    return Object.freeze({
      ok: true as const,
      migrationId,
      fromEpoch: migration.fromEpoch,
      toEpoch: migration.toEpoch,
      continuityTier,
      notifyContextRebuilt,
      degradedReasons: Object.freeze(degradedReasons),
      capsuleRef: finalCapsuleRef,
      checkpointGeneration,
      nativeSessionId: resolvedNativeSessionId,
      stickyHomeKey,
      brainGen: rebindRes.brainGen,
      fencingToken: rebindRes.fencingToken,
      ...(rebindRes.revokedPreviousFencingToken === undefined
        ? {}
        : { revokedPreviousFencingToken: rebindRes.revokedPreviousFencingToken }),
      attachment,
      issuedCredentialLease: candidateLease,
      previousCredentialRevoked,
      migration: committedOutcome.migration,
      pointer: committedOutcome.pointer,
    })
  }

  async prewarm(args: MigrationPrewarmInput): Promise<MigrationPrewarmResult> {
    const targetPlacement = validatePlacementDescriptor(args.targetPlacement)
    const stickyHomeKey =
      args.stickyHomeKey ??
      targetPlacement.stickyHomeKey ??
      computeStickyHomeKey(args.sessionKey)

    const res = await this.drivers.prewarm({
      targetPlacement,
      stickyHomeKey,
      ...(args.frozenPromptSha256 === undefined
        ? {}
        : { frozenPromptSha256: args.frozenPromptSha256 }),
      ...(args.credentialLease === undefined ? {} : { credentialLease: args.credentialLease }),
      sessionKey: args.sessionKey,
    })

    return Object.freeze({
      ready: res.ready,
      stickyHomeKey,
      ...(res.prewarmedKey === undefined ? {} : { prewarmedKey: res.prewarmedKey }),
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    })
  }

  async drain(options: MigrationDrainOptions = {}): Promise<MigrationDrainResult> {
    const effectiveOptions: MigrationDrainOptions = {
      ...options,
      timeoutMs: options.timeoutMs ?? this.drainTimeoutMs,
    }
    const startedAt = this.now()
    this.draining = true

    try {
      if (this.drainCoordinator?.drain) {
        const res = await this.drainCoordinator.drain(effectiveOptions)
        if (options.keepClosedForRestart === false) {
          this.draining = false
        }
        return Object.freeze(res)
      }
      if (this.drainCoordinator?.drainForCutover && this.drainPool !== undefined) {
        const res = await this.drainCoordinator.drainForCutover(
          this.drainPool,
          effectiveOptions,
        )
        if (options.keepClosedForRestart === false) {
          this.draining = false
        }
        return Object.freeze(res)
      }

      const closedAt = new Date(startedAt).toISOString()
      const drainedAt = new Date(this.now()).toISOString()
      const releaseRunId =
        typeof options.releaseRunId === 'string' && options.releaseRunId.trim().length > 0
          ? options.releaseRunId.trim()
          : `mig-drain-${randomUUID()}`
      if (options.keepClosedForRestart === false) {
        this.draining = false
      }
      return Object.freeze({
        drained: true as const,
        elapsedMs: Math.max(0, this.now() - startedAt),
        releaseRunId,
        admissionClosedAt: closedAt,
        drainedAt,
      })
    } catch (err) {
      this.draining = false
      throw err
    }
  }

  reopen(): { readonly draining: false } {
    this.draining = false
    this.drainCoordinator?.reopen()
    return Object.freeze({ draining: false as const })
  }
}
