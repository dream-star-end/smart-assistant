/**
 * OCV5-890 / OCV5-928 — Shared contracts, validation constants, and pure helpers
 * for Layer 1 PostgreSQL Authoritative State Stores (`db/threeLayer/*`).
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 * Zero `process.env` reads; zero forbidden crypto APIs; zero sync I/O.
 */
import {
  ARTIFACT_BLOB_KINDS,
  AUTHORITY_ENGINE_KINDS,
  INFERENCE_POOL_KINDS,
  RESUME_LADDER_TIERS,
  ROLLING_CHECKPOINT_MODES,
  STORAGE_POOL_KINDS,
  type ArtifactBlobKind,
  type ArtifactBlobStorageBackend,
  type AuthorityEngineKind,
  type EngineStateCapsuleRef,
  type InferencePoolKind,
  type LogicalModelPoolBinding,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type PlacementMigrationState,
  type ResolvedLogicalModelId,
  type ResumeLadderTier,
  type RollingCheckpointMode,
  type SessionEnginePointer,
  type StoragePoolKind,
} from '@openclaude/protocol'

export interface PgQueryResult<R extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: R[]
  readonly rowCount?: number | null
}

export interface PgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult<R>>
}

export interface PgTransactionClient extends PgQueryable {
  release(): void
}

export interface PgTransactionPool extends PgQueryable {
  connect(): Promise<PgTransactionClient>
}

export interface UpsertEnginePointerInput {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly poolKind?: StoragePoolKind
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId?: string | null
  readonly operationId?: string | null
  readonly profileId?: string | null
  readonly capsuleId?: string | null
  readonly history?: readonly string[]
  readonly rejectedIds?: readonly string[]
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory?: boolean
  readonly expectedPlacementEpoch?: number
}

export interface SaveRollingCheckpointInput {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly sessionId: string
  readonly expectedPlacementEpoch: number
  readonly mode: RollingCheckpointMode
  readonly anchorSeq: number
  readonly sourceEngine: AuthorityEngineKind
  readonly summary: string
  readonly instructions?: string | null
  readonly checkpointGeneration?: string
}

export interface SaveRollingCheckpointResult {
  readonly checkpointGeneration: string
  readonly createdAtMs: number
}

export interface AckRollingCheckpointCas {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly checkpointGeneration: string
  readonly consumedByTurnKey: string
}

export interface BeginPlacementMigrationCas {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly expectedPlacementEpoch: number
  readonly fromPlacement: PlacementDescriptor
  readonly toPlacement: PlacementDescriptor
  readonly migrationId?: string
  readonly reason?: string | null
}

export type BeginPlacementMigrationResult =
  | {
      readonly applied: true
      readonly migration: PlacementMigrationRecord
      readonly currentEpoch: number
    }
  | {
      readonly applied: false
      readonly currentEpoch: number
      readonly reason: 'epoch_mismatch' | 'already_migrating'
      readonly activeMigrationId?: string | null
    }

export interface CommitPlacementMigrationCas {
  readonly migrationId: string
  readonly userId?: number | bigint
  readonly sessionKey?: string
  readonly continuityTier: ResumeLadderTier
  readonly checkpointGeneration?: string | null
  readonly capsuleRef?: EngineStateCapsuleRef | null
  readonly nativeSessionId?: string | null
  readonly operationId?: string | null
  readonly profileId?: string | null
  readonly capsuleId?: string | null
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
}

export interface MarkPlacementMigrationInstalledOptions {
  readonly consumedByTurnKey?: string
  readonly checkpointGeneration?: string | null
  readonly requireWarmCheckpointMatch?: boolean
}

export interface MarkPlacementMigrationInstalledResult {
  readonly installed: boolean
  readonly checkpointAcked: boolean
  readonly checkpointGeneration: string | null
}

export type CommitPlacementMigrationResult =
  | {
      readonly applied: true
      readonly migration: PlacementMigrationRecord
      readonly pointer: SessionEnginePointer
    }
  | { readonly applied: false }

export interface AbortPlacementMigrationCas {
  readonly migrationId: string
  readonly reason: string
  readonly userId?: number | bigint
  readonly sessionKey?: string
}

export type AbortPlacementMigrationResult =
  | {
      readonly applied: true
      readonly migration: PlacementMigrationRecord
      readonly pointer: SessionEnginePointer | null
    }
  | { readonly applied: false }

export interface ResolvedModelPoolBindings {
  readonly resolved: ResolvedLogicalModelId
  readonly bindings: readonly LogicalModelPoolBinding[]
}

export interface InspectedModelPoolBindings {
  readonly status: 'unconfigured' | 'configured'
  readonly resolved: ResolvedLogicalModelId
  readonly bindings: readonly LogicalModelPoolBinding[]
  readonly enabledBindings: readonly LogicalModelPoolBinding[]
  readonly allConfiguredBindings: readonly LogicalModelPoolBinding[]
  readonly totalCount: number
  readonly hasConfiguredBindings: boolean
}

export interface ArtifactBlobUploadPartMeta {
  readonly sizeBytes: number
  readonly sha256: string
}

export interface ArtifactBlobUploadRecord {
  readonly uploadId: string
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly filename: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
  readonly chunkBytes: number
  readonly chunkCount: number
  readonly receivedParts: Readonly<Record<string, ArtifactBlobUploadPartMeta>>
  readonly status: 'open' | 'completed' | 'aborted'
  readonly completedBlobId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface InitiateBlobUploadMetaInput {
  readonly uploadId?: string
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly filename: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
  readonly chunkBytes: number
  readonly chunkCount: number
}

export type RecordBlobPartResult = 'recorded' | 'idempotent'

export interface CompleteBlobRowInput {
  readonly blobId: string
  readonly tenantId: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly mimeType: string
  readonly kind: ArtifactBlobKind
  readonly logicalName?: string
  readonly containerRelativePath?: string
  readonly storageBackend?: ArtifactBlobStorageBackend
  readonly storageUri: string
  readonly createdAt?: string
}

export interface GcUnreferencedBlobsOptions {
  readonly completeReferenceProof: boolean
  readonly liveBlobIds: ReadonlySet<string> | readonly string[]
  readonly olderThanMs: number
  readonly nowMs?: number
  readonly tenantId?: string
  readonly dryRun?: boolean
}

export interface GcUnreferencedBlobsResult {
  readonly markedDeletedBlobIds: readonly string[]
  readonly markedDeletedCount: number
  readonly cutoffIso: string
}

export interface PointerRow extends Record<string, unknown> {
  user_id: string | number
  session_key: string
  placement_epoch: string | number
  pool_kind: string
  engine: string
  native_session_id: string | null
  operation_id: string | null
  profile_id: string | null
  capsule_id: string | null
  history_json: unknown
  rejected_ids_json: unknown
  prompt_cache_meta_json: unknown
  usage_baseline_json: unknown
  history_context_version: string | number | null
  promoted_from_history: boolean
  migration_state: string
  active_migration_id: string | null
  updated_at: unknown
  created_at: unknown
}

export interface MigrationRow extends Record<string, unknown> {
  migration_id: string
  user_id: string | number
  session_key: string
  from_epoch: string | number
  to_epoch: string | number
  state: PlacementMigrationState | string
  from_placement_json: unknown
  to_placement_json: unknown
  capsule_ref_json: unknown
  continuity_tier: string | null
  reason: string | null
  created_at: unknown
  completed_at: unknown
}

export const HISTORY_MAX_ENTRIES = 4
export const CHUNK_BYTES_MIN = 65_536
export const CHUNK_BYTES_MAX = 16_777_216
export const CHUNK_COUNT_MAX = 4_096

export const SHA256_RE = /^[0-9a-f]{64}$/
export const IDENT_8_128_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
export const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

export const ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
export const STORAGE_POOL_SET: ReadonlySet<string> = new Set<string>(STORAGE_POOL_KINDS)
export const INFERENCE_POOL_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)
export const CHECKPOINT_MODE_SET: ReadonlySet<string> = new Set<string>(ROLLING_CHECKPOINT_MODES)
export const RESUME_TIER_SET: ReadonlySet<string> = new Set<string>(RESUME_LADDER_TIERS)
export const BLOB_KIND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_KINDS)
export type { InferencePoolKind }

export function assertCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

export function normalizeUserId(userId: number | bigint): string {
  if (typeof userId === 'bigint') {
    assertCondition(userId > 0n, 'STATE_STORE_USER_ID_INVALID')
    return userId.toString()
  }
  assertCondition(
    typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0,
    'STATE_STORE_USER_ID_INVALID',
  )
  return String(userId)
}

export function assertNonEmptyString(value: unknown, code: string, maxLen = 512): string {
  assertCondition(
    typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen,
    code,
  )
  return value
}

export function assertPositiveEpoch(epoch: unknown, code: string): number {
  assertCondition(
    typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 1,
    code,
  )
  return epoch
}

export function toIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string' && raw.length > 0) return raw
  return new Date(0).toISOString()
}

export function parseJsonValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}

export function parseStringArray(raw: unknown): readonly string[] {
  const parsed = parseJsonValue(raw)
  if (!Array.isArray(parsed)) return Object.freeze([])
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return Object.freeze(out)
}

export function parseNullableRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  const parsed = parseJsonValue(raw)
  if (parsed === null || parsed === undefined) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return Object.freeze({ ...(parsed as Record<string, unknown>) })
}

export function parseNullableNumberRecord(raw: unknown): Readonly<Record<string, number>> | null {
  const parsed = parseJsonValue(raw)
  if (parsed === null || parsed === undefined) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v
    }
  }
  return Object.freeze(out)
}

export function dedupeCapStrings(items: readonly string[], maxLen?: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (maxLen !== undefined && out.length >= maxLen) break
  }
  return out
}

export function mapPointerRow(row: PointerRow): SessionEnginePointer {
  return Object.freeze({
    sessionKey: String(row.session_key),
    placementEpoch: Number(row.placement_epoch),
    poolKind: row.pool_kind as StoragePoolKind,
    engine: row.engine as AuthorityEngineKind,
    nativeSessionId: row.native_session_id ?? null,
    operationId: row.operation_id ?? null,
    profileId: row.profile_id ?? null,
    capsuleId: row.capsule_id ?? null,
    history: parseStringArray(row.history_json),
    rejectedIds: parseStringArray(row.rejected_ids_json),
    promptCacheMeta: parseNullableRecord(row.prompt_cache_meta_json),
    usageBaseline: parseNullableNumberRecord(row.usage_baseline_json),
    historyContextVersion:
      row.history_context_version === null || row.history_context_version === undefined
        ? null
        : Number(row.history_context_version),
    promotedFromHistory: Boolean(row.promoted_from_history),
    migrationState: row.migration_state === 'migrating' ? 'migrating' : 'active',
    activeMigrationId: row.active_migration_id ?? null,
    updatedAt: toIsoString(row.updated_at),
    createdAt: toIsoString(row.created_at),
  })
}

export async function withTransaction<T>(
  pool: PgTransactionPool,
  fn: (client: PgTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      void rollbackErr
    }
    throw err
  } finally {
    client.release()
  }
}
