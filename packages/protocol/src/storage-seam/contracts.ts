/**
 * OCV5-890 Layer 1 — Storage Seam pure protocol contracts.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * Binary payloads use standard ES `Uint8Array`.
 */
import type { ModelAuthorityEngine } from '../modelAuthority.js'

export const STORAGE_POOL_KINDS = [
  'local_container',
  'remote_pool',
  'desktop_tunnel',
] as const
export type StoragePoolKind = (typeof STORAGE_POOL_KINDS)[number]

export const AUTHORITY_ENGINE_KINDS = [
  'ccb',
  'codex',
  'antigravity',
  'grok',
  'cursor',
  'zcode',
] as const satisfies readonly ModelAuthorityEngine[]
export type AuthorityEngineKind = ModelAuthorityEngine

export const ARTIFACT_BLOB_KINDS = [
  'upload',
  'generated',
  'research',
  'tool_spill',
  'capsule_file',
  'tape_archive',
] as const
export type ArtifactBlobKind = (typeof ARTIFACT_BLOB_KINDS)[number]

export const ARTIFACT_BLOB_STORAGE_BACKENDS = [
  'local_cas',
  's3',
  'minio',
  'volume_mirror',
] as const
export type ArtifactBlobStorageBackend = (typeof ARTIFACT_BLOB_STORAGE_BACKENDS)[number]

export const ENGINE_STATE_CAPSULE_PORTABILITIES = [
  'portable',
  'same_engine_version',
  'host_pinned',
  'non_portable',
] as const
export type EngineStateCapsulePortability = (typeof ENGINE_STATE_CAPSULE_PORTABILITIES)[number]

export const CREDENTIAL_LEASE_MOUNT_KINDS = [
  'memfd_or_tmpfs',
  'env_ephemeral',
  'proxy_broker',
] as const
export type CredentialLeaseMountKind = (typeof CREDENTIAL_LEASE_MOUNT_KINDS)[number]

export const RESUME_LADDER_TIERS = [
  'hot_native',
  'warm_capsule',
  'tape_rebuilt',
  'cold_degraded',
] as const
export type ResumeLadderTier = (typeof RESUME_LADDER_TIERS)[number]

export const PLACEMENT_MIGRATION_STATES = [
  'migrating',
  'committed',
  'aborted',
] as const
export type PlacementMigrationState = (typeof PLACEMENT_MIGRATION_STATES)[number]

export const ROLLING_CHECKPOINT_MODES = [
  'anchored_v2',
  'native_handoff',
] as const
export type RollingCheckpointMode = (typeof ROLLING_CHECKPOINT_MODES)[number]

export interface SessionAuthorityEpoch {
  readonly tenantId: string
  readonly sessionKey: string
  readonly placementEpoch: number
  readonly migrationState: 'active' | 'migrating'
  readonly activeMigrationId?: string | null
  readonly updatedAt: string
}

export interface PlacementDescriptor {
  readonly poolKind: StoragePoolKind
  readonly engine: AuthorityEngineKind
  readonly driverId: string
  readonly placementEpoch: number
  readonly hostId?: string
  readonly containerId?: string
  readonly profileId?: string
  readonly operationId?: string
  readonly stickyHomeKey?: string
  readonly workspaceRef?: string
}

export interface AuthoritativeRollingCheckpoint {
  readonly sessionKey: string
  readonly sessionId: string
  readonly checkpointGeneration: string
  readonly placementEpoch: number
  readonly mode: RollingCheckpointMode
  readonly anchorSeq: number
  readonly sourceEngine: AuthorityEngineKind
  readonly summary: string
  readonly instructions?: string | null
  readonly ackedByTurnKey?: string | null
  readonly ackedAt?: string | null
  readonly createdAt: string
}

export interface SessionEnginePointer {
  readonly sessionKey: string
  readonly placementEpoch: number
  readonly poolKind: StoragePoolKind
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string | null
  readonly operationId?: string | null
  readonly profileId?: string | null
  readonly capsuleId?: string | null
  readonly history: readonly string[]
  readonly rejectedIds: readonly string[]
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory: boolean
  readonly migrationState: 'active' | 'migrating'
  readonly activeMigrationId?: string | null
  readonly updatedAt: string
  readonly createdAt?: string
}

export interface ArtifactBlobRef {
  readonly blobId: string
  readonly tenantId: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly mimeType: string
  readonly kind: ArtifactBlobKind
  readonly logicalName?: string
  readonly containerRelativePath?: string
  readonly storageBackend?: ArtifactBlobStorageBackend
  readonly storageUri?: string
  readonly createdAt?: string
}

export interface ArtifactBlobPutInput {
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly mimeType: string
  readonly bytes: Uint8Array
  readonly logicalName?: string
  readonly containerRelativePath?: string
}

export interface ArtifactBlobStore {
  put(input: ArtifactBlobPutInput): Promise<ArtifactBlobRef>
  getMetadata(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null>
  getBytes(tenantId: string, blobId: string): Promise<Uint8Array | null>
  headBySha256(tenantId: string, sha256: string): Promise<ArtifactBlobRef | null>
  delete(tenantId: string, blobId: string): Promise<boolean>
}

export interface WorkspaceSnapshotRef {
  readonly snapshotId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly treeSha256: string
  readonly parentSnapshotId?: string | null
  readonly blobRef?: ArtifactBlobRef
  readonly fileCount: number
  readonly totalBytes: number
  readonly createdAt: string
}

export interface EngineStateCapsuleFileEntry {
  readonly logicalPath: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly blobId?: string
  readonly mode?: number
  readonly isSqlite?: boolean
}

export interface EngineStateCapsuleManifest {
  readonly schemaVersion: 1
  readonly capsuleId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly engineVersion: string
  readonly portability: EngineStateCapsulePortability
  readonly placementEpoch: number
  readonly nativeSessionId?: string | null
  readonly totalBytes: number
  readonly files: readonly EngineStateCapsuleFileEntry[]
  readonly createdAt: string
}

export type EngineStateCapsuleManifestBody = Omit<EngineStateCapsuleManifest, 'capsuleId'>

export interface EngineStateCapsuleRef {
  readonly capsuleId: string
  readonly engine: AuthorityEngineKind
  readonly portability: EngineStateCapsulePortability
  readonly placementEpoch: number
  readonly totalBytes: number
  readonly fileCount: number
  readonly manifestBlobId?: string
  readonly createdAt: string
}

export interface EngineStateCapsuleStore {
  putCapsule(
    manifest: EngineStateCapsuleManifest,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<EngineStateCapsuleRef>
  getManifest(tenantId: string, capsuleId: string): Promise<EngineStateCapsuleManifest | null>
  getFileBytes(
    tenantId: string,
    capsuleId: string,
    logicalPath: string,
  ): Promise<Uint8Array | null>
  deleteCapsule(tenantId: string, capsuleId: string): Promise<boolean>
}

export interface DerivedIndexHit {
  readonly sessionKey: string
  readonly score: number
  readonly snippet?: string
}

export interface DerivedIndexStore {
  upsertSessionIndex(
    tenantId: string,
    sessionKey: string,
    document: Readonly<Record<string, unknown>>,
  ): Promise<void>
  querySessions(
    tenantId: string,
    query: { readonly text?: string; readonly limit?: number; readonly cursor?: string },
  ): Promise<readonly DerivedIndexHit[]>
  rebuildIndex(tenantId: string, sessionKey: string): Promise<void>
}

export interface OperationalLedgerEntry {
  readonly tenantId: string
  readonly sessionKey?: string
  readonly kind: string
  readonly idempotencyKey: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface OperationalLedgerStore {
  appendEvent(entry: OperationalLedgerEntry): Promise<{ readonly inserted: boolean }>
  listEvents(
    tenantId: string,
    opts?: {
      readonly sessionKey?: string
      readonly kind?: string
      readonly since?: string
      readonly limit?: number
    },
  ): Promise<readonly OperationalLedgerEntry[]>
}

export interface CredentialLeaseHandle {
  readonly leaseId: string
  readonly tenantId: string
  readonly profileId: string
  readonly engine: AuthorityEngineKind
  readonly mountKind: CredentialLeaseMountKind
  readonly noRefreshToken: boolean
  readonly issuedAt: string
  readonly expiresAt: string
  readonly revoked?: boolean
  readonly scope?: readonly string[]
}

export interface CredentialLeaseStore {
  issueLease(request: {
    readonly tenantId: string
    readonly profileId: string
    readonly engine: AuthorityEngineKind
    readonly mountKind: CredentialLeaseMountKind
    readonly ttlMs: number
    readonly scope?: readonly string[]
  }): Promise<CredentialLeaseHandle>
  validateLease(leaseId: string, nowIso?: string): Promise<CredentialLeaseHandle | null>
  revokeLease(leaseId: string, reason: string): Promise<boolean>
}

export interface ResumeLadderResult {
  readonly tier: ResumeLadderTier
  readonly sessionKey: string
  readonly placementEpoch: number
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId?: string | null
  readonly capsuleId?: string | null
  readonly checkpointGeneration?: string | null
  readonly degradedReason?: string | null
}

export interface PlacementMigrationRecord {
  readonly migrationId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly fromEpoch: number
  readonly toEpoch: number
  readonly state: PlacementMigrationState
  readonly fromPlacement: PlacementDescriptor
  readonly toPlacement: PlacementDescriptor
  readonly capsuleRef?: EngineStateCapsuleRef | null
  readonly continuityTier?: ResumeLadderTier | null
  readonly reason?: string | null
  readonly createdAt: string
  readonly completedAt?: string | null
}

export interface SessionAuthorityStore {
  getEpoch(tenantId: string, sessionKey: string): Promise<SessionAuthorityEpoch | null>
  getPointer(tenantId: string, sessionKey: string): Promise<SessionEnginePointer | null>
  upsertPointer(
    tenantId: string,
    pointer: SessionEnginePointer,
    expectedEpoch?: number,
  ): Promise<SessionEnginePointer>
  getLatestCheckpoint(
    tenantId: string,
    sessionKey: string,
  ): Promise<AuthoritativeRollingCheckpoint | null>
  saveCheckpoint(
    tenantId: string,
    checkpoint: AuthoritativeRollingCheckpoint,
  ): Promise<void>
  ackCheckpoint(
    tenantId: string,
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): Promise<boolean>
  beginPlacementMigration(
    tenantId: string,
    migration: Omit<PlacementMigrationRecord, 'state' | 'completedAt'>,
  ): Promise<PlacementMigrationRecord>
  commitPlacementMigration(
    tenantId: string,
    migrationId: string,
    outcome: {
      readonly continuityTier: ResumeLadderTier
      readonly capsuleRef?: EngineStateCapsuleRef | null
    },
  ): Promise<PlacementMigrationRecord>
  abortPlacementMigration(
    tenantId: string,
    migrationId: string,
    reason: string,
  ): Promise<PlacementMigrationRecord>
}
