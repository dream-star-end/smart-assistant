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
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
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

export type PendingMigrationPgDecision = 'pending' | 'unknown' | 'committed' | 'aborted'

export interface PendingCredentialReconciliationRecord {
  readonly migrationId: string
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly fromEpoch: number
  readonly toEpoch: number
  readonly fromPlacement: PlacementDescriptor
  readonly toPlacement: PlacementDescriptor
  readonly execEnvLeaseId: string
  readonly targetCredentialLease: CredentialLeaseHandle | null
  readonly sourceCredentialLeaseId: string | null
  readonly currentBrainGen: number
  readonly currentFencingToken?: string
  readonly targetBrainGen: number | null
  readonly targetFencingToken: string | null
  readonly pgDecision: PendingMigrationPgDecision
  readonly sourceLeaseRevoked: boolean
  readonly targetLeaseRevoked: boolean
  readonly sourceQuiesced?: boolean
  readonly sourceExecEnvRestored: boolean
  readonly reason: string
  readonly recordedAt: string
}

export interface PendingCredentialReconciliationStore {
  put(record: PendingCredentialReconciliationRecord): Promise<void> | void
  get(
    migrationId: string,
  ): Promise<PendingCredentialReconciliationRecord | null> | PendingCredentialReconciliationRecord | null
  delete(migrationId: string): Promise<void> | void
  list(): Promise<readonly PendingCredentialReconciliationRecord[]> | readonly PendingCredentialReconciliationRecord[]
}

export type CredentialReconciliationOutcome =
  | {
      readonly migrationId: string
      readonly status: 'committed'
      readonly targetCredentialPreserved: true
      readonly targetCredentialLease: CredentialLeaseHandle | null
      readonly sourceCredentialRevoked: boolean
      readonly fullyConverged: boolean
      readonly stillPending: boolean
      readonly migration: PlacementMigrationRecord | null
      readonly pointer: SessionEnginePointer | null
    }
  | {
      readonly migrationId: string
      readonly status: 'aborted'
      readonly targetCredentialRevoked: boolean
      readonly sourceExecEnvRestored: boolean
      readonly sourceCredentialPreserved: true
      readonly fullyConverged: boolean
      readonly stillPending: boolean
      readonly restoredSourceLease?: {
        readonly brainGen: number
        readonly fencingToken: string
      }
      readonly migration: PlacementMigrationRecord | null
    }
  | {
      readonly migrationId: string
      readonly status: 'unknown'
      readonly stillPending: true
      readonly targetCredentialPreserved: true
      readonly reason: string
    }

export interface MigrationCoordinatorDeps {
  readonly authorityStore: MigrationAuthorityStorePort
  readonly capsuleStore: MigrationCapsulePort
  readonly execEnv: MigrationExecEnvPort
  readonly credentialLeases: MigrationCredentialLeasePort
  readonly drivers: MigrationDriverPort
  readonly reconciliationWalDir?: string
  readonly pendingReconciliationStore?: PendingCredentialReconciliationStore
  readonly allowEphemeralReconciliationForTests?: boolean
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
  | 'MIGRATION_RECONCILIATION_STORE_REQUIRED'
  | 'MIGRATION_RECONCILIATION_PERSIST_FAILED'
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
  readonly preservedCandidateLease?: CredentialLeaseHandle
  readonly pendingCredentialReconciliation?: PendingCredentialReconciliationRecord
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
const SAFE_RECONCILE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const RECONCILE_FILE_SUFFIX = '.reconcile.json'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fsyncDirSync(dirPath: string): void {
  let dirFd: number | undefined
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
    dirFd = openSync(dirPath, flags)
    fsyncSync(dirFd)
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset)
  }
}

function safeReconcileFilename(migrationId: string): string {
  const safe = SAFE_RECONCILE_ID_RE.test(migrationId)
    ? migrationId
    : createHash('sha256').update(migrationId, 'utf8').digest('hex')
  return `${safe}${RECONCILE_FILE_SUFFIX}`
}

interface SerializedReconciliationRecord {
  readonly schemaVersion: 1
  readonly migrationId: string
  readonly userIdType: 'bigint' | 'number'
  readonly userIdValue: string
  readonly sessionKey: string
  readonly fromEpoch: number
  readonly toEpoch: number
  readonly fromPlacement: PlacementDescriptor
  readonly toPlacement: PlacementDescriptor
  readonly execEnvLeaseId: string
  readonly targetCredentialLease: CredentialLeaseHandle | null
  readonly sourceCredentialLeaseId: string | null
  readonly currentBrainGen: number
  readonly currentFencingToken?: string
  readonly targetBrainGen: number | null
  readonly targetFencingToken: string | null
  readonly pgDecision: PendingMigrationPgDecision
  readonly sourceLeaseRevoked: boolean
  readonly targetLeaseRevoked: boolean
  readonly sourceQuiesced?: boolean
  readonly sourceExecEnvRestored: boolean
  readonly reason: string
  readonly recordedAt: string
}

function serializeReconciliationRecord(
  rec: PendingCredentialReconciliationRecord,
): SerializedReconciliationRecord {
  return {
    schemaVersion: 1,
    migrationId: rec.migrationId,
    userIdType: typeof rec.userId === 'bigint' ? 'bigint' : 'number',
    userIdValue: String(rec.userId),
    sessionKey: rec.sessionKey,
    fromEpoch: rec.fromEpoch,
    toEpoch: rec.toEpoch,
    fromPlacement: rec.fromPlacement,
    toPlacement: rec.toPlacement,
    execEnvLeaseId: rec.execEnvLeaseId,
    targetCredentialLease: rec.targetCredentialLease,
    sourceCredentialLeaseId: rec.sourceCredentialLeaseId,
    currentBrainGen: rec.currentBrainGen,
    ...(rec.currentFencingToken === undefined
      ? {}
      : { currentFencingToken: rec.currentFencingToken }),
    targetBrainGen: rec.targetBrainGen,
    targetFencingToken: rec.targetFencingToken,
    pgDecision: rec.pgDecision,
    sourceLeaseRevoked: rec.sourceLeaseRevoked,
    targetLeaseRevoked: rec.targetLeaseRevoked,
    sourceQuiesced: rec.sourceQuiesced ?? !rec.sourceExecEnvRestored,
    sourceExecEnvRestored: rec.sourceExecEnvRestored,
    reason: rec.reason,
    recordedAt: rec.recordedAt,
  }
}

function deserializeReconciliationRecord(raw: unknown): PendingCredentialReconciliationRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.migrationId !== 'string' ||
    typeof obj.userIdValue !== 'string' ||
    typeof obj.sessionKey !== 'string' ||
    typeof obj.execEnvLeaseId !== 'string' ||
    typeof obj.fromEpoch !== 'number' ||
    typeof obj.toEpoch !== 'number' ||
    typeof obj.currentBrainGen !== 'number' ||
    obj.fromPlacement === null ||
    typeof obj.fromPlacement !== 'object' ||
    obj.toPlacement === null ||
    typeof obj.toPlacement !== 'object'
  ) {
    return null
  }
  const userId: number | bigint =
    obj.userIdType === 'bigint' ? BigInt(obj.userIdValue) : Number(obj.userIdValue)
  const pgDecision: PendingMigrationPgDecision =
    obj.pgDecision === 'committed' ||
    obj.pgDecision === 'aborted' ||
    obj.pgDecision === 'unknown' ||
    obj.pgDecision === 'pending'
      ? obj.pgDecision
      : 'unknown'
  return Object.freeze({
    migrationId: obj.migrationId,
    userId,
    sessionKey: obj.sessionKey,
    fromEpoch: obj.fromEpoch,
    toEpoch: obj.toEpoch,
    fromPlacement: obj.fromPlacement as PlacementDescriptor,
    toPlacement: obj.toPlacement as PlacementDescriptor,
    execEnvLeaseId: obj.execEnvLeaseId,
    targetCredentialLease:
      obj.targetCredentialLease === null || typeof obj.targetCredentialLease !== 'object'
        ? null
        : (obj.targetCredentialLease as CredentialLeaseHandle),
    sourceCredentialLeaseId:
      typeof obj.sourceCredentialLeaseId === 'string' ? obj.sourceCredentialLeaseId : null,
    currentBrainGen: obj.currentBrainGen,
    ...(typeof obj.currentFencingToken === 'string'
      ? { currentFencingToken: obj.currentFencingToken }
      : {}),
    targetBrainGen: typeof obj.targetBrainGen === 'number' ? obj.targetBrainGen : null,
    targetFencingToken: typeof obj.targetFencingToken === 'string' ? obj.targetFencingToken : null,
    pgDecision,
    sourceLeaseRevoked: obj.sourceLeaseRevoked === true,
    targetLeaseRevoked: obj.targetLeaseRevoked === true,
    sourceQuiesced:
      typeof obj.sourceQuiesced === 'boolean'
        ? obj.sourceQuiesced
        : obj.sourceExecEnvRestored !== true,
    sourceExecEnvRestored: obj.sourceExecEnvRestored === true,
    reason: typeof obj.reason === 'string' ? obj.reason : 'reconciliation_pending',
    recordedAt: typeof obj.recordedAt === 'string' ? obj.recordedAt : new Date(0).toISOString(),
  })
}

export class FilePendingCredentialReconciliationStore
  implements PendingCredentialReconciliationStore
{
  readonly walDir: string

  constructor(walDir: string) {
    const resolved = resolve(walDir)
    mkdirSync(resolved, { recursive: true, mode: 0o700 })
    const st = lstatSync(resolved)
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`MIGRATION_RECONCILIATION_WAL_DIR_INVALID:${resolved}`)
    }
    this.walDir = resolved
  }

  put(record: PendingCredentialReconciliationRecord): void {
    const finalPath = join(this.walDir, safeReconcileFilename(record.migrationId))
    const tmpPath = join(this.walDir, `.${randomUUID()}.reconcile.tmp`)
    const payload = Buffer.from(JSON.stringify(serializeReconciliationRecord(record)), 'utf8')
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0)
    let fd: number | undefined
    try {
      fd = openSync(tmpPath, flags, 0o600)
      writeAllSync(fd, payload)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmpPath, finalPath)
      fsyncDirSync(this.walDir)
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
      try {
        unlinkSync(tmpPath)
      } catch {}
      throw err
    }
  }

  get(migrationId: string): PendingCredentialReconciliationRecord | null {
    const directPath = join(this.walDir, safeReconcileFilename(migrationId))
    const direct = this.readFileSync(directPath)
    if (direct && direct.migrationId === migrationId) return direct
    for (const rec of this.list()) {
      if (rec.migrationId === migrationId) return rec
    }
    return null
  }

  delete(migrationId: string): void {
    const directPath = join(this.walDir, safeReconcileFilename(migrationId))
    try {
      unlinkSync(directPath)
      fsyncDirSync(this.walDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
    }
  }

  list(): readonly PendingCredentialReconciliationRecord[] {
    const out: PendingCredentialReconciliationRecord[] = []
    for (const entry of readdirSync(this.walDir)) {
      if (!entry.endsWith(RECONCILE_FILE_SUFFIX)) continue
      const parsed = this.readFileSync(join(this.walDir, entry))
      if (parsed) out.push(parsed)
    }
    return out
  }

  private readFileSync(filePath: string): PendingCredentialReconciliationRecord | null {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
    if (!st.isFile() || st.isSymbolicLink()) return null
    let fd: number | undefined
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      return deserializeReconciliationRecord(JSON.parse(readFileSync(fd, 'utf8')))
    } catch {
      return null
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }
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
  private readonly pendingReconciliationStore?: PendingCredentialReconciliationStore
  private readonly allowEphemeralReconciliationForTests: boolean
  private readonly drainCoordinator?: MigrationDrainCoordinatorPort
  private readonly drainPool?: unknown
  private readonly now: () => number
  private readonly pendingCredentialReconciliations = new Map<
    string,
    PendingCredentialReconciliationRecord
  >()
  private draining = false

  constructor(deps: MigrationCoordinatorDeps) {
    this.authorityStore = deps.authorityStore
    this.capsuleStore = deps.capsuleStore
    this.execEnv = deps.execEnv
    this.credentialLeases = deps.credentialLeases
    this.drivers = deps.drivers
    if (deps.pendingReconciliationStore) {
      this.pendingReconciliationStore = deps.pendingReconciliationStore
    } else if (
      typeof deps.reconciliationWalDir === 'string' &&
      deps.reconciliationWalDir.trim().length > 0
    ) {
      this.pendingReconciliationStore = new FilePendingCredentialReconciliationStore(
        deps.reconciliationWalDir,
      )
    }
    this.allowEphemeralReconciliationForTests = deps.allowEphemeralReconciliationForTests === true
    this.drainCoordinator = deps.drainCoordinator
    this.drainPool = deps.drainPool
    this.now = deps.now ?? Date.now

    this.allowAutoMigration = deps.control?.allowAutoMigration ?? true
    this.preserveStickyHome = deps.control?.preserveStickyHome ?? true
    this.requireCapsuleForWarmHandoff = deps.control?.requireCapsuleForWarmHandoff ?? false
    this.drainTimeoutMs = Math.max(50, Math.floor(deps.control?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS))
  }

  get hasDurableReconciliationStore(): boolean {
    return this.pendingReconciliationStore !== undefined
  }

  private async persistPendingReconciliation(
    record: PendingCredentialReconciliationRecord,
  ): Promise<void> {
    if (this.pendingReconciliationStore) {
      await this.pendingReconciliationStore.put(record)
    }
    this.pendingCredentialReconciliations.set(record.migrationId, record)
  }

  private async deletePendingReconciliation(migrationId: string): Promise<void> {
    if (this.pendingReconciliationStore) {
      await this.pendingReconciliationStore.delete(migrationId)
    }
    this.pendingCredentialReconciliations.delete(migrationId)
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

    // B08: Any credential-bearing handoff MUST have a durable reconciliation store
    // (`reconciliationWalDir` or `pendingReconciliationStore`) before mutating PG or issuing leases.
    const involvesCredentials =
      toPlacement.profileId !== undefined || args.previousCredentialLeaseId !== undefined
    if (
      involvesCredentials &&
      !this.hasDurableReconciliationStore &&
      !this.allowEphemeralReconciliationForTests
    ) {
      return Object.freeze({
        ok: false as const,
        code: 'MIGRATION_RECONCILIATION_STORE_REQUIRED' as const,
        reason:
          'reconciliationWalDir or pendingReconciliationStore is required for credential-bearing migration handoff',
        placementEpoch: args.expectedPlacementEpoch,
        rolledBack: false,
      })
    }

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
    let commitAttempted = false
    let intentPersisted = false
    let reboundToBrainGen: number | null = null
    let reboundFencingToken: string | null = null

    const buildReconciliationRecord = (params: {
      readonly pgDecision: PendingMigrationPgDecision
      readonly sourceLeaseRevoked: boolean
      readonly targetLeaseRevoked: boolean
      readonly sourceExecEnvRestored: boolean
      readonly reason: string
    }): PendingCredentialReconciliationRecord =>
      Object.freeze({
        migrationId,
        userId: args.userId,
        sessionKey: args.sessionKey,
        fromEpoch: migration.fromEpoch,
        toEpoch: migration.toEpoch,
        fromPlacement,
        toPlacement,
        execEnvLeaseId: args.execEnvLeaseId,
        targetCredentialLease: candidateLease,
        sourceCredentialLeaseId: args.previousCredentialLeaseId ?? null,
        currentBrainGen: args.currentBrainGen,
        ...(args.currentFencingToken === undefined
          ? {}
          : { currentFencingToken: args.currentFencingToken }),
        targetBrainGen: reboundToBrainGen,
        targetFencingToken: reboundFencingToken,
        pgDecision: params.pgDecision,
        sourceLeaseRevoked: params.sourceLeaseRevoked,
        targetLeaseRevoked: params.targetLeaseRevoked,
        sourceQuiesced: quiesced,
        sourceExecEnvRestored: params.sourceExecEnvRestored,
        reason: params.reason,
        recordedAt: new Date(this.now()).toISOString(),
      })

    const abortAndFail = async (
      code: MigrationHandoffErrorCode,
      abortReason: string,
      opts?: { readonly commitOutcomeUnknown?: boolean; readonly alreadyAbortedInPg?: boolean },
    ): Promise<MigrationHandoffFailure> => {
      let pgAborted = opts?.alreadyAbortedInPg === true
      // B08: ALWAYS confirm authoritative PG abort BEFORE revoking target candidate credentials
      // or flipping ExecEnv! `abortPlacementMigration` uses CAS `WHERE state = 'migrating'`, so
      // it returns `applied=false` if PG already committed or is unreachable.
      if (!pgAborted) {
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

      // B08: NEVER revoke candidateLease unless PG abort is explicitly confirmed (`pgAborted === true`).
      let targetLeaseRevoked = candidateLease === null
      if (candidateLease !== null && pgAborted) {
        try {
          targetLeaseRevoked = await this.credentialLeases.revokeLease(
            candidateLease.leaseId,
            `migration_aborted:${code}`,
          )
        } catch {
          targetLeaseRevoked = false
        }
      }

      let execEnvRestored = false
      let restoredSourceLease: { readonly brainGen: number; readonly fencingToken: string } | undefined

      if (!quiesced && reboundToBrainGen === null) {
        execEnvRestored = true
      } else if (!pgAborted && (opts?.commitOutcomeUnknown === true || commitAttempted)) {
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

      // B08: Delete durable reconciliation record ONLY when PG abort, target lease revocation,
      // AND source ExecEnv restoration are ALL authoritatively confirmed! Otherwise retain/update it.
      let pendingReconciliation: PendingCredentialReconciliationRecord | undefined
      const needsDeferredReconciliation =
        !pgAborted || !targetLeaseRevoked || !execEnvRestored
      if (!needsDeferredReconciliation) {
        if (intentPersisted) {
          await this.deletePendingReconciliation(migrationId)
        }
      } else if (
        intentPersisted ||
        candidateLease !== null ||
        opts?.commitOutcomeUnknown === true ||
        commitAttempted
      ) {
        pendingReconciliation = buildReconciliationRecord({
          pgDecision: pgAborted ? 'aborted' : 'unknown',
          sourceLeaseRevoked: false,
          targetLeaseRevoked,
          sourceExecEnvRestored: execEnvRestored,
          reason: `${code}:${abortReason}`,
        })
        await this.persistPendingReconciliation(pendingReconciliation)
      }

      const rolledBack = pgAborted && execEnvRestored && targetLeaseRevoked
      return Object.freeze({
        ok: false as const,
        code,
        reason: abortReason,
        placementEpoch: args.expectedPlacementEpoch,
        rolledBack,
        ...(rolledBack ? {} : { recoveryRequired: true }),
        ...(restoredSourceLease === undefined ? {} : { restoredSourceLease }),
        ...(pendingReconciliation === undefined
          ? {}
          : { pendingCredentialReconciliation: pendingReconciliation }),
        ...(!pgAborted && candidateLease !== null ? { preservedCandidateLease: candidateLease } : {}),
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

    // Step 5b (B08): Durably register reconciliation intent BEFORE invoking irreversible PG commit.
    // Never swallow persistence errors: if durable intent write fails, abort safely BEFORE PG commit!
    if (this.hasDurableReconciliationStore || candidateLease !== null || args.previousCredentialLeaseId) {
      const intentRecord = buildReconciliationRecord({
        pgDecision: 'pending',
        sourceLeaseRevoked: !args.previousCredentialLeaseId,
        targetLeaseRevoked: candidateLease === null,
        sourceExecEnvRestored: false,
        reason: 'pre_commit_intent',
      })
      try {
        await this.persistPendingReconciliation(intentRecord)
        intentPersisted = true
      } catch (err) {
        return abortAndFail(
          'MIGRATION_RECONCILIATION_PERSIST_FAILED',
          `reconciliation_intent_persist_failed:${errorMessage(err)}`,
        )
      }
    }

    // Step 6: Atomic commit & revoke previous credential lease (read-back authoritative state on unknown error)
    commitAttempted = true
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

    // B08: Delete durable reconciliation record ONLY when source credential cleanup (if any) succeeded!
    // If revoking the old source lease failed, retain the committed reconciliation record for retry.
    if (!args.previousCredentialLeaseId || previousCredentialRevoked) {
      if (intentPersisted) {
        await this.deletePendingReconciliation(migrationId)
      }
    } else if (intentPersisted) {
      await this.persistPendingReconciliation(
        buildReconciliationRecord({
          pgDecision: 'committed',
          sourceLeaseRevoked: false,
          targetLeaseRevoked: false,
          sourceExecEnvRestored: false,
          reason: `source_lease_revoke_pending:${migrationId}`,
        }),
      )
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

  async getPendingCredentialReconciliation(
    migrationId: string,
  ): Promise<PendingCredentialReconciliationRecord | null> {
    const inMem = this.pendingCredentialReconciliations.get(migrationId)
    if (inMem) return inMem
    if (this.pendingReconciliationStore) {
      return (await this.pendingReconciliationStore.get(migrationId)) ?? null
    }
    return null
  }

  async listPendingCredentialReconciliations(): Promise<
    readonly PendingCredentialReconciliationRecord[]
  > {
    const byId = new Map<string, PendingCredentialReconciliationRecord>()
    for (const [id, rec] of this.pendingCredentialReconciliations) {
      byId.set(id, rec)
    }
    if (this.pendingReconciliationStore) {
      for (const rec of await this.pendingReconciliationStore.list()) {
        byId.set(rec.migrationId, rec)
      }
    }
    return [...byId.values()]
  }

  /**
   * B08: Deferred authoritative credential & ExecEnv reconciliation for migrations that ended
   * in an unknown commit state (`commitOutcomeUnknown`), failed PG abort confirmation, or had
   * partial cleanup failures.
   *
   * Step-by-step state tracking guarantees a pending record is deleted ONLY after EVERY required
   * cleanup action for the authoritative PG decision is confirmed:
   * - Authoritative state `committed`: preserves target credential lease intact and revokes ONLY
   *   the old source credential lease; if source revocation fails, retains the persisted record!
   * - Authoritative state `aborted` (or `migrating` cleanly aborted via CAS): revokes candidate
   *   target credential lease AND restores source ExecEnv with monotonic gen; if either fails,
   *   persists partial progress and retains the record until both succeed!
   * - Still unreachable/unknown: performs ZERO destructive revocation and retains the record.
   */
  async reconcilePendingCredentialCleanup(
    migrationId: string,
  ): Promise<CredentialReconciliationOutcome | null> {
    const pending = await this.getPendingCredentialReconciliation(migrationId)
    if (!pending) return null

    const finalizeCommitted = async (
      committedMigration: PlacementMigrationRecord | null,
    ): Promise<CredentialReconciliationOutcome> => {
      let sourceLeaseRevoked = pending.sourceLeaseRevoked || !pending.sourceCredentialLeaseId
      if (pending.sourceCredentialLeaseId && !sourceLeaseRevoked) {
        try {
          sourceLeaseRevoked = await this.credentialLeases.revokeLease(
            pending.sourceCredentialLeaseId,
            `migration_committed_reconciled:${migrationId}`,
          )
        } catch {
          sourceLeaseRevoked = false
        }
      }
      let pointer: SessionEnginePointer | null = null
      if (typeof this.authorityStore.getEnginePointer === 'function') {
        try {
          pointer = await this.authorityStore.getEnginePointer(pending.userId, pending.sessionKey)
        } catch {
          pointer = null
        }
      }

      const fullyConverged = sourceLeaseRevoked
      if (fullyConverged) {
        await this.deletePendingReconciliation(migrationId)
      } else {
        await this.persistPendingReconciliation(
          Object.freeze({
            ...pending,
            pgDecision: 'committed' as const,
            sourceLeaseRevoked: false,
          }),
        )
      }

      return Object.freeze({
        migrationId,
        status: 'committed' as const,
        targetCredentialPreserved: true as const,
        targetCredentialLease: pending.targetCredentialLease,
        sourceCredentialRevoked: sourceLeaseRevoked,
        fullyConverged,
        stillPending: !fullyConverged,
        migration: committedMigration,
        pointer,
      })
    }

    const finalizeAborted = async (
      abortedMigration: PlacementMigrationRecord | null,
    ): Promise<CredentialReconciliationOutcome> => {
      let targetLeaseRevoked = pending.targetLeaseRevoked || pending.targetCredentialLease === null
      if (pending.targetCredentialLease !== null && !targetLeaseRevoked) {
        try {
          targetLeaseRevoked = await this.credentialLeases.revokeLease(
            pending.targetCredentialLease.leaseId,
            `migration_aborted_reconciled:${migrationId}`,
          )
        } catch {
          targetLeaseRevoked = false
        }
      }

      // B08: NEVER infer sourceExecEnvRestored from `targetBrainGen === null`:
      // if source was quiesced (or unknown), we MUST restore source ExecEnv with a monotonic
      // rollbackBrainGen before deleting the reconciliation record.
      const needsSourceRestore =
        pending.sourceQuiesced !== false || pending.targetBrainGen !== null
      let sourceExecEnvRestored = pending.sourceExecEnvRestored || !needsSourceRestore
      let restoredSourceLease:
        | { readonly brainGen: number; readonly fencingToken: string }
        | undefined
      if (needsSourceRestore && !sourceExecEnvRestored) {
        const rollbackBrainGen =
          Math.max(pending.currentBrainGen, pending.targetBrainGen ?? pending.currentBrainGen) + 1
        const rollbackFencingToken = buildMonotonicFencingToken(
          migrationId,
          Math.max(pending.toEpoch, pending.fromEpoch),
          rollbackBrainGen,
        )
        const prevToken = pending.targetFencingToken ?? pending.currentFencingToken
        try {
          const restoreRes = await this.execEnv.rebindBrain({
            leaseId: pending.execEnvLeaseId,
            sessionKey: pending.sessionKey,
            nextBrainGen: rollbackBrainGen,
            nextFencingToken: rollbackFencingToken,
            ...(prevToken === undefined ? {} : { previousFencingToken: prevToken }),
            targetPlacement: pending.fromPlacement,
          })
          if (restoreRes.ok) {
            sourceExecEnvRestored = true
            restoredSourceLease = Object.freeze({
              brainGen: restoreRes.brainGen,
              fencingToken: restoreRes.fencingToken,
            })
          }
        } catch {
          sourceExecEnvRestored = false
        }
      }

      const fullyConverged = targetLeaseRevoked && sourceExecEnvRestored
      if (fullyConverged) {
        await this.deletePendingReconciliation(migrationId)
      } else {
        await this.persistPendingReconciliation(
          Object.freeze({
            ...pending,
            pgDecision: 'aborted' as const,
            targetLeaseRevoked,
            sourceExecEnvRestored,
          }),
        )
      }

      return Object.freeze({
        migrationId,
        status: 'aborted' as const,
        targetCredentialRevoked: targetLeaseRevoked,
        sourceExecEnvRestored,
        sourceCredentialPreserved: true as const,
        fullyConverged,
        stillPending: !fullyConverged,
        ...(restoredSourceLease === undefined ? {} : { restoredSourceLease }),
        migration: abortedMigration,
      })
    }

    // Fast path when PG decision was already authoritatively established in a prior step/attempt.
    if (pending.pgDecision === 'committed') {
      let observed: PlacementMigrationRecord | null = null
      if (typeof this.authorityStore.getPlacementMigration === 'function') {
        try {
          observed = await this.authorityStore.getPlacementMigration(migrationId)
        } catch {
          observed = null
        }
      }
      return await finalizeCommitted(observed)
    }
    if (pending.pgDecision === 'aborted') {
      let observed: PlacementMigrationRecord | null = null
      if (typeof this.authorityStore.getPlacementMigration === 'function') {
        try {
          observed = await this.authorityStore.getPlacementMigration(migrationId)
        } catch {
          observed = null
        }
      }
      return await finalizeAborted(observed)
    }

    if (typeof this.authorityStore.getPlacementMigration !== 'function') {
      return Object.freeze({
        migrationId,
        status: 'unknown' as const,
        stillPending: true as const,
        targetCredentialPreserved: true as const,
        reason: 'authority_store_readback_unsupported',
      })
    }

    let observed: PlacementMigrationRecord | null
    try {
      observed = await this.authorityStore.getPlacementMigration(migrationId)
    } catch (err) {
      return Object.freeze({
        migrationId,
        status: 'unknown' as const,
        stillPending: true as const,
        targetCredentialPreserved: true as const,
        reason: `authority_readback_error:${errorMessage(err)}`,
      })
    }

    if (observed === null) {
      return Object.freeze({
        migrationId,
        status: 'unknown' as const,
        stillPending: true as const,
        targetCredentialPreserved: true as const,
        reason: 'authority_migration_record_not_found',
      })
    }

    if (observed.state === 'committed') {
      return await finalizeCommitted(observed)
    }

    if (observed.state === 'aborted') {
      return await finalizeAborted(observed)
    }

    // Still 'migrating' in PG -> attempt CAS abort (`WHERE state = 'migrating'`).
    try {
      const abortRes = await this.authorityStore.abortPlacementMigration({
        migrationId,
        userId: pending.userId,
        sessionKey: pending.sessionKey,
        reason: `reconcile_abort:${pending.reason}`,
      })
      if (abortRes.applied) {
        return await finalizeAborted(abortRes.migration)
      }
    } catch (err) {
      return Object.freeze({
        migrationId,
        status: 'unknown' as const,
        stillPending: true as const,
        targetCredentialPreserved: true as const,
        reason: `authority_abort_error:${errorMessage(err)}`,
      })
    }

    // CAS abort did not apply -> migration transitioned concurrently; re-read authoritative state.
    try {
      const rechecked = await this.authorityStore.getPlacementMigration(migrationId)
      if (rechecked?.state === 'committed') {
        return await finalizeCommitted(rechecked)
      }
      if (rechecked?.state === 'aborted') {
        return await finalizeAborted(rechecked)
      }
    } catch {
      // Fall through to unknown without revoking credentials.
    }

    return Object.freeze({
      migrationId,
      status: 'unknown' as const,
      stillPending: true as const,
      targetCredentialPreserved: true as const,
      reason: 'authority_state_unresolved',
    })
  }

  async reconcileAllPendingCredentials(): Promise<readonly CredentialReconciliationOutcome[]> {
    const pending = await this.listPendingCredentialReconciliations()
    const outcomes: CredentialReconciliationOutcome[] = []
    for (const rec of pending) {
      const outcome = await this.reconcilePendingCredentialCleanup(rec.migrationId)
      if (outcome !== null) {
        outcomes.push(outcome)
      }
    }
    return Object.freeze(outcomes)
  }

  reopen(): { readonly draining: false } {
    this.draining = false
    this.drainCoordinator?.reopen()
    return Object.freeze({ draining: false as const })
  }
}
