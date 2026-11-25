/**
 * OCV5-890 Wave 1B — Layer 1 PostgreSQL Authoritative State Stores.
 *
 * Implements the PostgreSQL-backed authoritative stores matching migration
 * `0354_three_layer_pool_unification.sql`:
 * - `PgSessionAuthorityStateStore` (`session_engine_pointers`,
 *   `session_rolling_checkpoints`, `session_placement_migrations`)
 * - `PgLogicalModelBindingStore` (`model_logical_pool_bindings`)
 * - `PgArtifactBlobMetaStore` (`artifact_blobs`, `artifact_blob_uploads`)
 *
 * Layer: platform-pg (L2). Zero `process.env` reads; zero forbidden crypto APIs;
 * zero engine/provider literal special cases.
 */
import { randomUUID } from 'node:crypto'
import {
  ARTIFACT_BLOB_KINDS,
  ARTIFACT_BLOB_MAX_BYTES,
  AUTHORITY_ENGINE_KINDS,
  INFERENCE_POOL_KINDS,
  RESUME_LADDER_TIERS,
  ROLLING_CHECKPOINT_MODES,
  STORAGE_POOL_KINDS,
  resolveLogicalModelId,
  validateArtifactBlobRef,
  validatePlacementDescriptor,
  type ArtifactBlobKind,
  type ArtifactBlobRef,
  type ArtifactBlobStorageBackend,
  type AuthoritativeRollingCheckpoint,
  type AuthorityEngineKind,
  type EngineStateCapsuleRef,
  type InferencePoolKind,
  type LogicalModelCapability,
  type LogicalModelPoolBinding,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type PlacementMigrationState,
  type ResolvedLogicalModelId,
  type ResumeLadderResult,
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
  readonly capsuleRef?: EngineStateCapsuleRef | null
  readonly nativeSessionId?: string | null
  readonly operationId?: string | null
  readonly profileId?: string | null
  readonly capsuleId?: string | null
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
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

const HISTORY_MAX_ENTRIES = 4
const CHUNK_BYTES_MIN = 65_536
const CHUNK_BYTES_MAX = 16_777_216
const CHUNK_COUNT_MAX = 4_096

const SHA256_RE = /^[0-9a-f]{64}$/
const IDENT_8_128_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

const ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const STORAGE_POOL_SET: ReadonlySet<string> = new Set<string>(STORAGE_POOL_KINDS)
const INFERENCE_POOL_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)
const CHECKPOINT_MODE_SET: ReadonlySet<string> = new Set<string>(ROLLING_CHECKPOINT_MODES)
const RESUME_TIER_SET: ReadonlySet<string> = new Set<string>(RESUME_LADDER_TIERS)
const BLOB_KIND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_KINDS)

function assertCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function normalizeUserId(userId: number | bigint): string {
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

function assertNonEmptyString(value: unknown, code: string, maxLen = 512): string {
  assertCondition(
    typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen,
    code,
  )
  return value
}

function assertPositiveEpoch(epoch: unknown, code: string): number {
  assertCondition(
    typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 1,
    code,
  )
  return epoch
}

function toIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string' && raw.length > 0) return raw
  return new Date(0).toISOString()
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}

function parseStringArray(raw: unknown): readonly string[] {
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

function parseNullableRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  const parsed = parseJsonValue(raw)
  if (parsed === null || parsed === undefined) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return Object.freeze({ ...(parsed as Record<string, unknown>) })
}

function parseNullableNumberRecord(raw: unknown): Readonly<Record<string, number>> | null {
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

function dedupeCapStrings(items: readonly string[], maxLen?: number): string[] {
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

function mergePointerHistory(
  existingHistory: readonly string[],
  previousNativeId: string | null,
  nextNativeId: string | null,
  explicitHistory?: readonly string[],
): string[] {
  if (explicitHistory !== undefined) {
    return dedupeCapStrings(explicitHistory, HISTORY_MAX_ENTRIES)
  }
  const combined: string[] = []
  if (previousNativeId && previousNativeId !== nextNativeId) {
    combined.push(previousNativeId)
  }
  for (const id of existingHistory) {
    if (id !== nextNativeId) combined.push(id)
  }
  return dedupeCapStrings(combined, HISTORY_MAX_ENTRIES)
}

async function withTransaction<T>(
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
    } catch {
      // Preserve original error on rollback failure.
    }
    throw err
  } finally {
    client.release()
  }
}

interface PointerRow extends Record<string, unknown> {
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

function mapPointerRow(row: PointerRow): SessionEnginePointer {
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

interface CheckpointRow extends Record<string, unknown> {
  session_key: string
  session_id: string
  checkpoint_generation: string
  placement_epoch: string | number
  mode: string
  anchor_seq: string | number
  source_engine: string
  summary: string
  instructions: string | null
  acked_by_turn_key: string | null
  acked_at: unknown
  created_at: unknown
}

function mapCheckpointRow(row: CheckpointRow): AuthoritativeRollingCheckpoint {
  return Object.freeze({
    sessionKey: String(row.session_key),
    sessionId: String(row.session_id),
    checkpointGeneration: String(row.checkpoint_generation),
    placementEpoch: Number(row.placement_epoch),
    mode: row.mode as RollingCheckpointMode,
    anchorSeq: Number(row.anchor_seq),
    sourceEngine: row.source_engine as AuthorityEngineKind,
    summary: String(row.summary),
    instructions: row.instructions ?? null,
    ackedByTurnKey: row.acked_by_turn_key ?? null,
    ackedAt: row.acked_at === null || row.acked_at === undefined ? null : toIsoString(row.acked_at),
    createdAt: toIsoString(row.created_at),
  })
}

interface MigrationRow extends Record<string, unknown> {
  migration_id: string
  user_id: string | number
  session_key: string
  from_epoch: string | number
  to_epoch: string | number
  state: string
  from_placement_json: unknown
  to_placement_json: unknown
  capsule_ref_json: unknown
  continuity_tier: string | null
  reason: string | null
  created_at: unknown
  completed_at: unknown
}

function mapMigrationRow(row: MigrationRow): PlacementMigrationRecord {
  const fromPlacement = validatePlacementDescriptor(parseJsonValue(row.from_placement_json))
  const toPlacement = validatePlacementDescriptor(parseJsonValue(row.to_placement_json))
  const rawCapsule = parseJsonValue(row.capsule_ref_json)
  const capsuleRef =
    rawCapsule && typeof rawCapsule === 'object' && !Array.isArray(rawCapsule)
      ? Object.freeze({ ...(rawCapsule as EngineStateCapsuleRef) })
      : null

  return Object.freeze({
    migrationId: String(row.migration_id),
    tenantId: String(row.user_id),
    sessionKey: String(row.session_key),
    fromEpoch: Number(row.from_epoch),
    toEpoch: Number(row.to_epoch),
    state: row.state as PlacementMigrationState,
    fromPlacement,
    toPlacement,
    capsuleRef,
    continuityTier: (row.continuity_tier as ResumeLadderTier | null) ?? null,
    reason: row.reason ?? null,
    createdAt: toIsoString(row.created_at),
    completedAt:
      row.completed_at === null || row.completed_at === undefined
        ? null
        : toIsoString(row.completed_at),
  })
}

const POINTER_SELECT_COLUMNS = `
  user_id, session_key, placement_epoch, pool_kind, engine,
  native_session_id, operation_id, profile_id, capsule_id,
  history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
  history_context_version, promoted_from_history,
  migration_state, active_migration_id, updated_at, created_at
`

export class PgSessionAuthorityStateStore {
  private readonly pool: PgTransactionPool

  constructor(pool: PgTransactionPool) {
    this.pool = pool
  }

  async getEnginePointer(
    userId: number | bigint,
    sessionKey: string,
  ): Promise<SessionEnginePointer | null> {
    const uid = normalizeUserId(userId)
    const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const res = await this.pool.query<PointerRow>(
      `SELECT ${POINTER_SELECT_COLUMNS}
         FROM session_engine_pointers
        WHERE user_id = $1 AND session_key = $2`,
      [uid, key],
    )
    const row = res.rows[0]
    return row ? mapPointerRow(row) : null
  }

  async upsertEnginePointer(input: UpsertEnginePointerInput): Promise<SessionEnginePointer> {
    const uid = normalizeUserId(input.userId)
    const key = assertNonEmptyString(input.sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    assertCondition(ENGINE_SET.has(input.engine), 'STATE_STORE_ENGINE_INVALID')
    const poolKind: StoragePoolKind = input.poolKind ?? 'local_container'
    assertCondition(STORAGE_POOL_SET.has(poolKind), 'STATE_STORE_POOL_KIND_INVALID')
    if (input.expectedPlacementEpoch !== undefined) {
      assertPositiveEpoch(input.expectedPlacementEpoch, 'STATE_STORE_PLACEMENT_EPOCH_INVALID')
    }

    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `session-migrate:${uid}:${key}`,
      ])

      const existingRes = await client.query<PointerRow>(
        `SELECT ${POINTER_SELECT_COLUMNS}
           FROM session_engine_pointers
          WHERE user_id = $1 AND session_key = $2
          FOR UPDATE`,
        [uid, key],
      )
      const existing = existingRes.rows[0] ? mapPointerRow(existingRes.rows[0]) : null

      if (existing) {
        if (existing.migrationState === 'migrating') {
          throw new Error('SESSION_PLACEMENT_MIGRATING')
        }
        if (
          input.expectedPlacementEpoch !== undefined &&
          existing.placementEpoch !== input.expectedPlacementEpoch
        ) {
          throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
        }
      } else if (
        input.expectedPlacementEpoch !== undefined &&
        input.expectedPlacementEpoch !== 1
      ) {
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }

      const guardedEpoch = input.expectedPlacementEpoch ?? existing?.placementEpoch ?? 1

      const nextNativeId =
        input.nativeSessionId !== undefined
          ? input.nativeSessionId
          : (existing?.nativeSessionId ?? null)
      const nextHistory = mergePointerHistory(
        existing?.history ?? [],
        existing?.nativeSessionId ?? null,
        nextNativeId,
        input.history,
      )
      const nextRejected =
        input.rejectedIds !== undefined
          ? dedupeCapStrings(input.rejectedIds)
          : [...(existing?.rejectedIds ?? [])]
      const nextOperationId =
        input.operationId !== undefined ? input.operationId : (existing?.operationId ?? null)
      const nextProfileId =
        input.profileId !== undefined ? input.profileId : (existing?.profileId ?? null)
      const nextCapsuleId =
        input.capsuleId !== undefined ? input.capsuleId : (existing?.capsuleId ?? null)
      const nextPromptCacheMeta =
        input.promptCacheMeta !== undefined
          ? input.promptCacheMeta
          : (existing?.promptCacheMeta ?? null)
      const nextUsageBaseline =
        input.usageBaseline !== undefined
          ? input.usageBaseline
          : (existing?.usageBaseline ?? null)
      const nextHistoryContextVersion =
        input.historyContextVersion !== undefined
          ? input.historyContextVersion
          : (existing?.historyContextVersion ?? null)
      const nextPromotedFromHistory =
        input.promotedFromHistory !== undefined
          ? input.promotedFromHistory
          : (existing?.promotedFromHistory ?? false)

      const res = await client.query<PointerRow>(
        `INSERT INTO session_engine_pointers (
           user_id, session_key, placement_epoch, pool_kind, engine,
           native_session_id, operation_id, profile_id, capsule_id,
           history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
           history_context_version, promoted_from_history
         ) VALUES (
           $1, $2, 1, $3, $4,
           $5, $6, $7, $8,
           $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
           $13, $14
         )
         ON CONFLICT (user_id, session_key) DO UPDATE SET
           pool_kind = EXCLUDED.pool_kind,
           engine = EXCLUDED.engine,
           native_session_id = EXCLUDED.native_session_id,
           operation_id = EXCLUDED.operation_id,
           profile_id = EXCLUDED.profile_id,
           capsule_id = EXCLUDED.capsule_id,
           history_json = EXCLUDED.history_json,
           rejected_ids_json = EXCLUDED.rejected_ids_json,
           prompt_cache_meta_json = EXCLUDED.prompt_cache_meta_json,
           usage_baseline_json = EXCLUDED.usage_baseline_json,
           history_context_version = EXCLUDED.history_context_version,
           promoted_from_history = EXCLUDED.promoted_from_history,
           updated_at = NOW()
         WHERE session_engine_pointers.placement_epoch = $15
           AND session_engine_pointers.migration_state = 'active'
         RETURNING ${POINTER_SELECT_COLUMNS}`,
        [
          uid,
          key,
          poolKind,
          input.engine,
          nextNativeId,
          nextOperationId,
          nextProfileId,
          nextCapsuleId,
          JSON.stringify(nextHistory),
          JSON.stringify(nextRejected),
          nextPromptCacheMeta === null ? null : JSON.stringify(nextPromptCacheMeta),
          nextUsageBaseline === null ? null : JSON.stringify(nextUsageBaseline),
          nextHistoryContextVersion,
          nextPromotedFromHistory,
          guardedEpoch,
        ],
      )
      if (res.rows.length === 0) {
        const currentRes = await client.query<PointerRow>(
          `SELECT ${POINTER_SELECT_COLUMNS}
             FROM session_engine_pointers
            WHERE user_id = $1 AND session_key = $2`,
          [uid, key],
        )
        const current = currentRes.rows[0] ? mapPointerRow(currentRes.rows[0]) : null
        if (current?.migrationState === 'migrating') {
          throw new Error('SESSION_PLACEMENT_MIGRATING')
        }
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }
      return mapPointerRow(res.rows[0]!)
    })
  }

  async recordRejectedResumeId(
    userId: number | bigint,
    sessionKey: string,
    nativeSessionId: string,
  ): Promise<void> {
    const uid = normalizeUserId(userId)
    const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const rejected = assertNonEmptyString(nativeSessionId, 'STATE_STORE_RESUME_ID_INVALID', 256)

    await this.pool.query(
      `UPDATE session_engine_pointers
          SET rejected_ids_json = CASE
                WHEN rejected_ids_json @> to_jsonb(ARRAY[$3::text]) THEN rejected_ids_json
                ELSE rejected_ids_json || to_jsonb(ARRAY[$3::text])
              END,
              updated_at = NOW()
        WHERE user_id = $1 AND session_key = $2`,
      [uid, key, rejected],
    )
  }

  async resolveResumeLadder(
    userId: number | bigint,
    sessionKey: string,
    targetEngine: AuthorityEngineKind,
  ): Promise<ResumeLadderResult> {
    assertCondition(ENGINE_SET.has(targetEngine), 'STATE_STORE_ENGINE_INVALID')
    const [pointer, checkpoint] = await Promise.all([
      this.getEnginePointer(userId, sessionKey),
      this.peekRollingCheckpoint(userId, sessionKey),
    ])

    const placementEpoch = pointer?.placementEpoch ?? 1
    const sameEngine = pointer !== null && pointer.engine === targetEngine

    if (pointer !== null && sameEngine) {
      const rejected = new Set(pointer.rejectedIds)
      const candidates: string[] = []
      if (pointer.nativeSessionId) candidates.push(pointer.nativeSessionId)
      for (const h of pointer.history) candidates.push(h)

      const matchedNative = candidates.find((id) => id.length > 0 && !rejected.has(id)) ?? null
      if (matchedNative !== null) {
        return Object.freeze({
          tier: 'hot_native',
          sessionKey,
          placementEpoch,
          engine: targetEngine,
          nativeSessionId: matchedNative,
          capsuleId: pointer.capsuleId ?? null,
          checkpointGeneration: checkpoint?.checkpointGeneration ?? null,
          degradedReason: null,
        })
      }

      if (pointer.capsuleId) {
        return Object.freeze({
          tier: 'warm_capsule',
          sessionKey,
          placementEpoch,
          engine: targetEngine,
          nativeSessionId: null,
          capsuleId: pointer.capsuleId,
          checkpointGeneration: checkpoint?.checkpointGeneration ?? null,
          degradedReason: pointer.nativeSessionId ? 'native_session_rejected' : 'native_session_absent',
        })
      }
    }

    if (checkpoint !== null) {
      return Object.freeze({
        tier: 'tape_rebuilt',
        sessionKey,
        placementEpoch,
        engine: targetEngine,
        nativeSessionId: null,
        capsuleId: null,
        checkpointGeneration: checkpoint.checkpointGeneration,
        degradedReason:
          pointer === null
            ? 'pointer_absent'
            : !sameEngine
              ? 'engine_switched'
              : 'native_and_capsule_unavailable',
      })
    }

    return Object.freeze({
      tier: 'cold_degraded',
      sessionKey,
      placementEpoch,
      engine: targetEngine,
      nativeSessionId: null,
      capsuleId: null,
      checkpointGeneration: null,
      degradedReason:
        pointer === null
          ? 'no_state'
          : !sameEngine
            ? 'engine_switched_no_checkpoint'
            : 'all_resume_candidates_exhausted',
    })
  }

  async saveRollingCheckpoint(
    input: SaveRollingCheckpointInput,
  ): Promise<SaveRollingCheckpointResult> {
    const uid = normalizeUserId(input.userId)
    const key = assertNonEmptyString(input.sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const sessionId = assertNonEmptyString(input.sessionId, 'STATE_STORE_SESSION_ID_INVALID', 256)
    const expectedEpoch = assertPositiveEpoch(
      input.expectedPlacementEpoch,
      'STATE_STORE_PLACEMENT_EPOCH_INVALID',
    )
    assertCondition(CHECKPOINT_MODE_SET.has(input.mode), 'CHECKPOINT_MODE_INVALID')
    assertCondition(
      typeof input.anchorSeq === 'number' &&
        Number.isSafeInteger(input.anchorSeq) &&
        input.anchorSeq >= 0,
      'CHECKPOINT_ANCHOR_SEQ_INVALID',
    )
    assertCondition(ENGINE_SET.has(input.sourceEngine), 'STATE_STORE_ENGINE_INVALID')
    const summary = assertNonEmptyString(input.summary, 'CHECKPOINT_SUMMARY_INVALID', 1_048_576)
    const generation =
      input.checkpointGeneration !== undefined
        ? assertNonEmptyString(input.checkpointGeneration, 'CHECKPOINT_GENERATION_INVALID', 128)
        : `cp-${randomUUID()}`

    return withTransaction(this.pool, async (client) => {
      const ptrRes = await client.query<{ placement_epoch: string | number }>(
        `SELECT placement_epoch
           FROM session_engine_pointers
          WHERE user_id = $1 AND session_key = $2
          FOR SHARE`,
        [uid, key],
      )
      const currentEpoch = ptrRes.rows[0] ? Number(ptrRes.rows[0].placement_epoch) : 1
      if (currentEpoch !== expectedEpoch) {
        throw new Error('CHECKPOINT_PLACEMENT_EPOCH_MISMATCH')
      }

      const insertRes = await client.query<{
        checkpoint_generation: string
        created_at: unknown
      }>(
        `INSERT INTO session_rolling_checkpoints (
           user_id, session_key, session_id, checkpoint_generation,
           placement_epoch, mode, anchor_seq, source_engine, summary, instructions
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING checkpoint_generation, created_at`,
        [
          uid,
          key,
          sessionId,
          generation,
          expectedEpoch,
          input.mode,
          input.anchorSeq,
          input.sourceEngine,
          summary,
          input.instructions ?? null,
        ],
      )
      const row = insertRes.rows[0]!
      return Object.freeze({
        checkpointGeneration: String(row.checkpoint_generation),
        createdAtMs: Date.parse(toIsoString(row.created_at)),
      })
    })
  }

  async peekRollingCheckpoint(
    userId: number | bigint,
    sessionKey: string,
  ): Promise<AuthoritativeRollingCheckpoint | null> {
    const uid = normalizeUserId(userId)
    const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const res = await this.pool.query<CheckpointRow>(
      `SELECT session_key, session_id, checkpoint_generation, placement_epoch, mode,
              anchor_seq, source_engine, summary, instructions,
              acked_by_turn_key, acked_at, created_at
         FROM session_rolling_checkpoints
        WHERE user_id = $1 AND session_key = $2 AND acked_at IS NULL
        ORDER BY created_at DESC, checkpoint_generation DESC
        LIMIT 1`,
      [uid, key],
    )
    const row = res.rows[0]
    return row ? mapCheckpointRow(row) : null
  }

  async ackRollingCheckpoint(cas: AckRollingCheckpointCas): Promise<boolean> {
    const uid = normalizeUserId(cas.userId)
    const key = assertNonEmptyString(cas.sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const generation = assertNonEmptyString(
      cas.checkpointGeneration,
      'CHECKPOINT_GENERATION_INVALID',
      128,
    )
    const turnKey = assertNonEmptyString(cas.consumedByTurnKey, 'CHECKPOINT_TURN_KEY_INVALID', 256)

    const res = await this.pool.query<{ checkpoint_generation: string }>(
      `UPDATE session_rolling_checkpoints
          SET acked_by_turn_key = $4,
              acked_at = NOW()
        WHERE user_id = $1
          AND session_key = $2
          AND checkpoint_generation = $3
          AND acked_at IS NULL
        RETURNING checkpoint_generation`,
      [uid, key, generation, turnKey],
    )
    return res.rows.length > 0
  }

  async beginPlacementMigration(
    cas: BeginPlacementMigrationCas,
  ): Promise<BeginPlacementMigrationResult> {
    const uid = normalizeUserId(cas.userId)
    const key = assertNonEmptyString(cas.sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const expectedEpoch = assertPositiveEpoch(
      cas.expectedPlacementEpoch,
      'STATE_STORE_PLACEMENT_EPOCH_INVALID',
    )
    const fromPlacement = validatePlacementDescriptor(cas.fromPlacement)
    const toPlacement = validatePlacementDescriptor(cas.toPlacement)
    const migrationId =
      cas.migrationId !== undefined ? cas.migrationId : `mig-${randomUUID()}`
    assertCondition(IDENT_8_128_RE.test(migrationId), 'MIGRATION_ID_INVALID')

    return withTransaction<BeginPlacementMigrationResult>(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `session-migrate:${uid}:${key}`,
      ])

      const ptrRes = await client.query<{
        placement_epoch: string | number
        migration_state: string
        active_migration_id: string | null
      }>(
        `SELECT placement_epoch, migration_state, active_migration_id
           FROM session_engine_pointers
          WHERE user_id = $1 AND session_key = $2
          FOR UPDATE`,
        [uid, key],
      )

      const existing = ptrRes.rows[0]
      if (!existing) {
        if (expectedEpoch !== 1) {
          return Object.freeze({
            applied: false as const,
            currentEpoch: 1,
            reason: 'epoch_mismatch' as const,
          })
        }
        await client.query(
          `INSERT INTO session_engine_pointers (
             user_id, session_key, placement_epoch, pool_kind, engine,
             operation_id, profile_id, migration_state, active_migration_id
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, 'migrating', $7)`,
          [
            uid,
            key,
            fromPlacement.poolKind,
            fromPlacement.engine,
            fromPlacement.operationId ?? null,
            fromPlacement.profileId ?? null,
            migrationId,
          ],
        )
      } else {
        const currentEpoch = Number(existing.placement_epoch)
        if (existing.migration_state === 'migrating') {
          return Object.freeze({
            applied: false as const,
            currentEpoch,
            reason: 'already_migrating' as const,
            activeMigrationId: existing.active_migration_id ?? null,
          })
        }
        if (currentEpoch !== expectedEpoch) {
          return Object.freeze({
            applied: false as const,
            currentEpoch,
            reason: 'epoch_mismatch' as const,
          })
        }

        const updateRes = await client.query<{ placement_epoch: string | number }>(
          `UPDATE session_engine_pointers
              SET migration_state = 'migrating',
                  active_migration_id = $4,
                  updated_at = NOW()
            WHERE user_id = $1
              AND session_key = $2
              AND placement_epoch = $3
              AND migration_state = 'active'
            RETURNING placement_epoch`,
          [uid, key, expectedEpoch, migrationId],
        )
        if (updateRes.rows.length === 0) {
          return Object.freeze({
            applied: false as const,
            currentEpoch,
            reason: 'epoch_mismatch' as const,
          })
        }
      }

      const toEpoch = expectedEpoch + 1
      const migRes = await client.query<MigrationRow>(
        `INSERT INTO session_placement_migrations (
           migration_id, user_id, session_key, from_epoch, to_epoch, state,
           from_placement_json, to_placement_json, reason
         ) VALUES ($1, $2, $3, $4, $5, 'migrating', $6::jsonb, $7::jsonb, $8)
         RETURNING migration_id, user_id, session_key, from_epoch, to_epoch, state,
                   from_placement_json, to_placement_json, capsule_ref_json,
                   continuity_tier, reason, created_at, completed_at`,
        [
          migrationId,
          uid,
          key,
          expectedEpoch,
          toEpoch,
          JSON.stringify(fromPlacement),
          JSON.stringify(toPlacement),
          cas.reason ?? null,
        ],
      )

      return Object.freeze({
        applied: true as const,
        migration: mapMigrationRow(migRes.rows[0]!),
        currentEpoch: expectedEpoch,
      })
    })
  }

  async commitPlacementMigration(
    cas: CommitPlacementMigrationCas,
  ): Promise<CommitPlacementMigrationResult> {
    assertCondition(IDENT_8_128_RE.test(cas.migrationId), 'MIGRATION_ID_INVALID')
    assertCondition(RESUME_TIER_SET.has(cas.continuityTier), 'MIGRATION_CONTINUITY_TIER_INVALID')
    const expectedUid = cas.userId !== undefined ? normalizeUserId(cas.userId) : null

    return withTransaction<CommitPlacementMigrationResult>(this.pool, async (client) => {
      const migRes = await client.query<MigrationRow>(
        `SELECT migration_id, user_id, session_key, from_epoch, to_epoch, state,
                from_placement_json, to_placement_json, capsule_ref_json,
                continuity_tier, reason, created_at, completed_at
           FROM session_placement_migrations
          WHERE migration_id = $1
          FOR UPDATE`,
        [cas.migrationId],
      )
      const migRow = migRes.rows[0]
      if (!migRow || migRow.state !== 'migrating') {
        return Object.freeze({ applied: false as const })
      }
      const uid = String(migRow.user_id)
      const key = String(migRow.session_key)
      if (expectedUid !== null && uid !== expectedUid) {
        return Object.freeze({ applied: false as const })
      }
      if (cas.sessionKey !== undefined && key !== cas.sessionKey) {
        return Object.freeze({ applied: false as const })
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `session-migrate:${uid}:${key}`,
      ])

      const committedRes = await client.query<MigrationRow>(
        `UPDATE session_placement_migrations
            SET state = 'committed',
                continuity_tier = $2,
                capsule_ref_json = $3::jsonb,
                completed_at = NOW()
          WHERE migration_id = $1
            AND state = 'migrating'
          RETURNING migration_id, user_id, session_key, from_epoch, to_epoch, state,
                    from_placement_json, to_placement_json, capsule_ref_json,
                    continuity_tier, reason, created_at, completed_at`,
        [
          cas.migrationId,
          cas.continuityTier,
          cas.capsuleRef === undefined || cas.capsuleRef === null
            ? null
            : JSON.stringify(cas.capsuleRef),
        ],
      )
      if (committedRes.rows.length === 0) {
        return Object.freeze({ applied: false as const })
      }

      const migration = mapMigrationRow(committedRes.rows[0]!)
      const toPlacement = migration.toPlacement
      const hasNativeSessionId = cas.nativeSessionId !== undefined
      const targetNativeSessionId = hasNativeSessionId ? cas.nativeSessionId : null
      const targetOperationId =
        cas.operationId !== undefined ? cas.operationId : (toPlacement.operationId ?? null)
      const targetProfileId =
        cas.profileId !== undefined ? cas.profileId : (toPlacement.profileId ?? null)
      const hasCapsuleId = cas.capsuleId !== undefined || cas.capsuleRef !== undefined
      const targetCapsuleId =
        cas.capsuleId !== undefined ? cas.capsuleId : (cas.capsuleRef?.capsuleId ?? null)
      const hasPromptCacheMeta = cas.promptCacheMeta !== undefined
      const hasUsageBaseline = cas.usageBaseline !== undefined

      const ptrRes = await client.query<PointerRow>(
        `UPDATE session_engine_pointers
            SET placement_epoch = $3,
                migration_state = 'active',
                active_migration_id = NULL,
                pool_kind = $4,
                engine = $5,
                native_session_id = CASE WHEN $13::boolean THEN $6 ELSE native_session_id END,
                operation_id = $7,
                profile_id = $8,
                capsule_id = CASE WHEN $14::boolean THEN $9 ELSE capsule_id END,
                prompt_cache_meta_json = CASE WHEN $15::boolean THEN $10::jsonb ELSE prompt_cache_meta_json END,
                usage_baseline_json = CASE WHEN $16::boolean THEN $11::jsonb ELSE usage_baseline_json END,
                updated_at = NOW()
          WHERE user_id = $1
            AND session_key = $2
            AND active_migration_id = $12
            AND migration_state = 'migrating'
          RETURNING ${POINTER_SELECT_COLUMNS}`,
        [
          uid,
          key,
          migration.toEpoch,
          toPlacement.poolKind,
          toPlacement.engine,
          targetNativeSessionId,
          targetOperationId,
          targetProfileId,
          targetCapsuleId,
          cas.promptCacheMeta === undefined || cas.promptCacheMeta === null
            ? null
            : JSON.stringify(cas.promptCacheMeta),
          cas.usageBaseline === undefined || cas.usageBaseline === null
            ? null
            : JSON.stringify(cas.usageBaseline),
          cas.migrationId,
          hasNativeSessionId,
          hasCapsuleId,
          hasPromptCacheMeta,
          hasUsageBaseline,
        ],
      )
      if (ptrRes.rows.length === 0) {
        throw new Error('MIGRATION_POINTER_CAS_CONFLICT')
      }

      return Object.freeze({
        applied: true as const,
        migration,
        pointer: mapPointerRow(ptrRes.rows[0]!),
      })
    })
  }

  async abortPlacementMigration(
    cas: AbortPlacementMigrationCas,
  ): Promise<AbortPlacementMigrationResult> {
    assertCondition(IDENT_8_128_RE.test(cas.migrationId), 'MIGRATION_ID_INVALID')
    const reason = assertNonEmptyString(cas.reason, 'MIGRATION_ABORT_REASON_INVALID', 512)
    const expectedUid = cas.userId !== undefined ? normalizeUserId(cas.userId) : null

    return withTransaction<AbortPlacementMigrationResult>(this.pool, async (client) => {
      const migRes = await client.query<MigrationRow>(
        `SELECT migration_id, user_id, session_key, from_epoch, to_epoch, state,
                from_placement_json, to_placement_json, capsule_ref_json,
                continuity_tier, reason, created_at, completed_at
           FROM session_placement_migrations
          WHERE migration_id = $1
          FOR UPDATE`,
        [cas.migrationId],
      )
      const migRow = migRes.rows[0]
      if (!migRow || migRow.state !== 'migrating') {
        return Object.freeze({ applied: false as const })
      }
      const uid = String(migRow.user_id)
      const key = String(migRow.session_key)
      if (expectedUid !== null && uid !== expectedUid) {
        return Object.freeze({ applied: false as const })
      }
      if (cas.sessionKey !== undefined && key !== cas.sessionKey) {
        return Object.freeze({ applied: false as const })
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `session-migrate:${uid}:${key}`,
      ])

      const abortedRes = await client.query<MigrationRow>(
        `UPDATE session_placement_migrations
            SET state = 'aborted',
                reason = $2,
                completed_at = NOW()
          WHERE migration_id = $1
            AND state = 'migrating'
          RETURNING migration_id, user_id, session_key, from_epoch, to_epoch, state,
                    from_placement_json, to_placement_json, capsule_ref_json,
                    continuity_tier, reason, created_at, completed_at`,
        [cas.migrationId, reason],
      )
      if (abortedRes.rows.length === 0) {
        return Object.freeze({ applied: false as const })
      }

      const ptrRes = await client.query<PointerRow>(
        `UPDATE session_engine_pointers
            SET migration_state = 'active',
                active_migration_id = NULL,
                updated_at = NOW()
          WHERE user_id = $1
            AND session_key = $2
            AND active_migration_id = $3
            AND migration_state = 'migrating'
          RETURNING ${POINTER_SELECT_COLUMNS}`,
        [uid, key, cas.migrationId],
      )

      return Object.freeze({
        applied: true as const,
        migration: mapMigrationRow(abortedRes.rows[0]!),
        pointer: ptrRes.rows[0] ? mapPointerRow(ptrRes.rows[0]) : null,
      })
    })
  }

  async getPlacementMigration(migrationId: string): Promise<PlacementMigrationRecord | null> {
    assertCondition(IDENT_8_128_RE.test(migrationId), 'MIGRATION_ID_INVALID')
    const res = await this.pool.query<MigrationRow>(
      `SELECT migration_id, user_id, session_key, from_epoch, to_epoch, state,
              from_placement_json, to_placement_json, capsule_ref_json,
              continuity_tier, reason, created_at, completed_at
         FROM session_placement_migrations
        WHERE migration_id = $1`,
      [migrationId],
    )
    return res.rows[0] ? mapMigrationRow(res.rows[0]) : null
  }
}

interface BindingRow extends Record<string, unknown> {
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: string | number
  capabilities_json: unknown
  enabled: boolean
}

function mapBindingRow(row: BindingRow): LogicalModelPoolBinding {
  const parsedCaps = parseJsonValue(row.capabilities_json)
  const capabilities = (
    parsedCaps && typeof parsedCaps === 'object' && !Array.isArray(parsedCaps)
      ? Object.freeze({ ...(parsedCaps as LogicalModelCapability) })
      : Object.freeze({
          logicalModel: String(row.logical_model_id),
          supportsVision: false,
          supportedEfforts: Object.freeze([]),
          defaultEffort: null,
          supportedServiceTiers: Object.freeze([]),
          supportsReadOnly: false,
          supportsConsultTurn: false,
          supportsHermeticNoTools: false,
          supportsSwarm: false,
        })
  ) as LogicalModelCapability

  return Object.freeze({
    logicalModelId: String(row.logical_model_id),
    poolKind: row.pool_kind as InferencePoolKind,
    driverId: String(row.driver_id),
    canonicalModelId: String(row.canonical_model_id),
    priority: Number(row.priority),
    capabilities,
    enabled: Boolean(row.enabled),
  })
}

export class PgLogicalModelBindingStore {
  private readonly pool: PgQueryable

  constructor(pool: PgQueryable) {
    this.pool = pool
  }

  async resolveBindingsForModel(rawModelId: string): Promise<ResolvedModelPoolBindings> {
    const resolved = resolveLogicalModelId(rawModelId)
    const sql = resolved.isLegacyRemoteAlias
      ? `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                priority, capabilities_json, enabled
           FROM model_logical_pool_bindings
          WHERE logical_model_id = $1
            AND enabled = TRUE
            AND pool_kind = 'remote_pool'
          ORDER BY priority ASC, driver_id ASC`
      : `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                priority, capabilities_json, enabled
           FROM model_logical_pool_bindings
          WHERE logical_model_id = $1
            AND enabled = TRUE
          ORDER BY priority ASC, driver_id ASC`

    const res = await this.pool.query<BindingRow>(sql, [resolved.logicalModel])
    return Object.freeze({
      resolved,
      bindings: Object.freeze(res.rows.map(mapBindingRow)),
    })
  }

  /**
   * N01: Distinguishes "never configured (0 rows)" from "explicitly configured but all disabled
   * (totalConfiguredCount > 0, enabledBindings.length === 0)" so callers never treat an
   * explicitly disabled binding as unconfigured fallback.
   */
  async resolveBindingsStateForModel(rawModelId: string): Promise<{
    readonly resolved: ReturnType<typeof resolveLogicalModelId>
    readonly bindings: readonly LogicalModelPoolBinding[]
    readonly allConfiguredBindings: readonly LogicalModelPoolBinding[]
    readonly hasConfiguredBindings: boolean
  }> {
    const resolved = resolveLogicalModelId(rawModelId)
    const sql = resolved.isLegacyRemoteAlias
      ? `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                priority, capabilities_json, enabled
           FROM model_logical_pool_bindings
          WHERE logical_model_id = $1
            AND pool_kind = 'remote_pool'
          ORDER BY priority ASC, driver_id ASC`
      : `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                priority, capabilities_json, enabled
           FROM model_logical_pool_bindings
          WHERE logical_model_id = $1
          ORDER BY priority ASC, driver_id ASC`

    const res = await this.pool.query<BindingRow>(sql, [resolved.logicalModel])
    const allConfiguredBindings = Object.freeze(res.rows.map(mapBindingRow))
    const bindings = Object.freeze(allConfiguredBindings.filter((b) => b.enabled))
    return Object.freeze({
      resolved,
      bindings,
      allConfiguredBindings,
      hasConfiguredBindings: allConfiguredBindings.length > 0,
    })
  }

  async upsertPoolBinding(binding: LogicalModelPoolBinding): Promise<LogicalModelPoolBinding> {
    assertCondition(
      typeof binding.logicalModelId === 'string' && MODEL_ID_RE.test(binding.logicalModelId),
      'MODEL_BINDING_LOGICAL_ID_INVALID',
    )
    assertCondition(INFERENCE_POOL_SET.has(binding.poolKind), 'MODEL_BINDING_POOL_KIND_INVALID')
    assertCondition(
      typeof binding.driverId === 'string' && DRIVER_ID_RE.test(binding.driverId),
      'MODEL_BINDING_DRIVER_ID_INVALID',
    )
    assertCondition(
      typeof binding.canonicalModelId === 'string' && MODEL_ID_RE.test(binding.canonicalModelId),
      'MODEL_BINDING_CANONICAL_ID_INVALID',
    )
    assertCondition(
      typeof binding.priority === 'number' && Number.isSafeInteger(binding.priority),
      'MODEL_BINDING_PRIORITY_INVALID',
    )

    const res = await this.pool.query<BindingRow>(
      `INSERT INTO model_logical_pool_bindings (
         logical_model_id, pool_kind, driver_id, canonical_model_id,
         priority, capabilities_json, enabled
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (logical_model_id, pool_kind, driver_id) DO UPDATE SET
         canonical_model_id = EXCLUDED.canonical_model_id,
         priority = EXCLUDED.priority,
         capabilities_json = EXCLUDED.capabilities_json,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING logical_model_id, pool_kind, driver_id, canonical_model_id,
                 priority, capabilities_json, enabled`,
      [
        binding.logicalModelId,
        binding.poolKind,
        binding.driverId,
        binding.canonicalModelId,
        binding.priority,
        JSON.stringify(binding.capabilities),
        binding.enabled,
      ],
    )
    return mapBindingRow(res.rows[0]!)
  }

  async setPoolBindingEnabled(
    logicalModelId: string,
    poolKind: InferencePoolKind,
    driverId: string,
    enabled: boolean,
  ): Promise<boolean> {
    assertCondition(MODEL_ID_RE.test(logicalModelId), 'MODEL_BINDING_LOGICAL_ID_INVALID')
    assertCondition(INFERENCE_POOL_SET.has(poolKind), 'MODEL_BINDING_POOL_KIND_INVALID')
    assertCondition(DRIVER_ID_RE.test(driverId), 'MODEL_BINDING_DRIVER_ID_INVALID')

    const res = await this.pool.query<{ binding_id: string | number }>(
      `UPDATE model_logical_pool_bindings
          SET enabled = $4,
              updated_at = NOW()
        WHERE logical_model_id = $1
          AND pool_kind = $2
          AND driver_id = $3
        RETURNING binding_id`,
      [logicalModelId, poolKind, driverId, enabled],
    )
    return res.rows.length > 0
  }

  async listAllEnabledBindings(): Promise<readonly LogicalModelPoolBinding[]> {
    const res = await this.pool.query<BindingRow>(
      `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
              priority, capabilities_json, enabled
         FROM model_logical_pool_bindings
        WHERE enabled = TRUE
        ORDER BY logical_model_id ASC, priority ASC, driver_id ASC`,
    )
    return Object.freeze(res.rows.map(mapBindingRow))
  }
}

interface BlobRow extends Record<string, unknown> {
  blob_id: string
  tenant_id: string
  sha256: string
  size_bytes: string | number
  mime_type: string
  kind: string
  logical_name: string | null
  container_relative_path: string | null
  storage_backend: string
  storage_uri: string
  created_at: unknown
}

function mapBlobRow(row: BlobRow): ArtifactBlobRef {
  return validateArtifactBlobRef({
    blobId: String(row.blob_id),
    tenantId: String(row.tenant_id),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    kind: row.kind as ArtifactBlobKind,
    ...(row.logical_name === null || row.logical_name === undefined
      ? {}
      : { logicalName: String(row.logical_name) }),
    ...(row.container_relative_path === null || row.container_relative_path === undefined
      ? {}
      : { containerRelativePath: String(row.container_relative_path) }),
    storageBackend: row.storage_backend as ArtifactBlobStorageBackend,
    storageUri: String(row.storage_uri),
    createdAt: toIsoString(row.created_at),
  })
}

interface BlobUploadRow extends Record<string, unknown> {
  upload_id: string
  tenant_id: string
  kind: string
  filename: string
  mime_type: string
  expected_size_bytes: string | number
  chunk_bytes: string | number
  chunk_count: string | number
  received_parts_json: unknown
  status: string
  completed_blob_id: string | null
  created_at: unknown
  updated_at: unknown
}

function parseReceivedParts(raw: unknown): Record<string, ArtifactBlobUploadPartMeta> {
  const parsed = parseJsonValue(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, ArtifactBlobUploadPartMeta> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const part = v as Record<string, unknown>
      if (typeof part.sizeBytes === 'number' && typeof part.sha256 === 'string') {
        out[k] = { sizeBytes: part.sizeBytes, sha256: part.sha256 }
      }
    }
  }
  return out
}

function mapBlobUploadRow(row: BlobUploadRow): ArtifactBlobUploadRecord {
  const parts = parseReceivedParts(row.received_parts_json)
  return Object.freeze({
    uploadId: String(row.upload_id),
    tenantId: String(row.tenant_id),
    kind: row.kind as ArtifactBlobKind,
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    expectedSizeBytes: Number(row.expected_size_bytes),
    chunkBytes: Number(row.chunk_bytes),
    chunkCount: Number(row.chunk_count),
    receivedParts: Object.freeze(parts),
    status: row.status as 'open' | 'completed' | 'aborted',
    completedBlobId: row.completed_blob_id ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  })
}

const BLOB_SELECT_COLUMNS = `
  blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
  logical_name, container_relative_path, storage_backend, storage_uri, created_at
`

export class PgArtifactBlobMetaStore {
  private readonly pool: PgTransactionPool

  constructor(pool: PgTransactionPool) {
    this.pool = pool
  }

  async initiateUpload(meta: InitiateBlobUploadMetaInput): Promise<ArtifactBlobUploadRecord> {
    const uploadId = meta.uploadId ?? `upl-${randomUUID()}`
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(meta.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_KIND_SET.has(meta.kind), 'BLOB_KIND_INVALID')
    assertNonEmptyString(meta.filename, 'BLOB_FILENAME_INVALID', 256)
    assertNonEmptyString(meta.mimeType, 'BLOB_MIME_TYPE_INVALID', 128)
    assertCondition(
      typeof meta.expectedSizeBytes === 'number' &&
        Number.isSafeInteger(meta.expectedSizeBytes) &&
        meta.expectedSizeBytes >= 0 &&
        meta.expectedSizeBytes <= ARTIFACT_BLOB_MAX_BYTES,
      'BLOB_EXPECTED_SIZE_INVALID',
    )
    assertCondition(
      typeof meta.chunkBytes === 'number' &&
        Number.isSafeInteger(meta.chunkBytes) &&
        meta.chunkBytes >= CHUNK_BYTES_MIN &&
        meta.chunkBytes <= CHUNK_BYTES_MAX,
      'BLOB_CHUNK_BYTES_INVALID',
    )
    assertCondition(
      typeof meta.chunkCount === 'number' &&
        Number.isSafeInteger(meta.chunkCount) &&
        meta.chunkCount >= 1 &&
        meta.chunkCount <= CHUNK_COUNT_MAX,
      'BLOB_CHUNK_COUNT_INVALID',
    )

    const res = await this.pool.query<BlobUploadRow>(
      `INSERT INTO artifact_blob_uploads (
         upload_id, tenant_id, kind, filename, mime_type,
         expected_size_bytes, chunk_bytes, chunk_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING upload_id, tenant_id, kind, filename, mime_type,
                 expected_size_bytes, chunk_bytes, chunk_count,
                 received_parts_json, status, completed_blob_id, created_at, updated_at`,
      [
        uploadId,
        meta.tenantId,
        meta.kind,
        meta.filename,
        meta.mimeType,
        meta.expectedSizeBytes,
        meta.chunkBytes,
        meta.chunkCount,
      ],
    )
    return mapBlobUploadRow(res.rows[0]!)
  }

  async getUpload(uploadId: string): Promise<ArtifactBlobUploadRecord | null> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    const res = await this.pool.query<BlobUploadRow>(
      `SELECT upload_id, tenant_id, kind, filename, mime_type,
              expected_size_bytes, chunk_bytes, chunk_count,
              received_parts_json, status, completed_blob_id, created_at, updated_at
         FROM artifact_blob_uploads
        WHERE upload_id = $1`,
      [uploadId],
    )
    return res.rows[0] ? mapBlobUploadRow(res.rows[0]) : null
  }

  async recordPart(
    uploadId: string,
    index: number,
    sizeBytes: number,
    partSha256: string,
  ): Promise<RecordBlobPartResult> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(
      typeof index === 'number' && Number.isSafeInteger(index) && index >= 0,
      'BLOB_PART_INDEX_INVALID',
    )
    assertCondition(
      typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0,
      'BLOB_PART_SIZE_INVALID',
    )
    assertCondition(
      typeof partSha256 === 'string' && SHA256_RE.test(partSha256),
      'BLOB_PART_SHA256_INVALID',
    )

    return withTransaction(this.pool, async (client) => {
      const res = await client.query<BlobUploadRow>(
        `SELECT upload_id, tenant_id, kind, filename, mime_type,
                expected_size_bytes, chunk_bytes, chunk_count,
                received_parts_json, status, completed_blob_id, created_at, updated_at
           FROM artifact_blob_uploads
          WHERE upload_id = $1
          FOR UPDATE`,
        [uploadId],
      )
      const row = res.rows[0]
      assertCondition(row !== undefined, 'BLOB_UPLOAD_NOT_FOUND')
      assertCondition(row.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')
      assertCondition(index < Number(row.chunk_count), 'BLOB_PART_INDEX_OUT_OF_RANGE')
      assertCondition(sizeBytes <= Number(row.chunk_bytes), 'BLOB_PART_SIZE_EXCEEDED')

      const parts = parseReceivedParts(row.received_parts_json)
      const key = String(index)
      const existing = parts[key]
      if (existing) {
        if (existing.sha256 === partSha256 && existing.sizeBytes === sizeBytes) {
          return 'idempotent'
        }
        throw new Error('BLOB_PART_SHA256_MISMATCH')
      }

      let totalBytes = sizeBytes
      for (const p of Object.values(parts)) {
        totalBytes += p.sizeBytes
      }
      assertCondition(
        totalBytes <= Number(row.expected_size_bytes) && totalBytes <= ARTIFACT_BLOB_MAX_BYTES,
        'BLOB_UPLOAD_SIZE_EXCEEDED',
      )

      parts[key] = { sizeBytes, sha256: partSha256 }
      await client.query(
        `UPDATE artifact_blob_uploads
            SET received_parts_json = $2::jsonb,
                updated_at = NOW()
          WHERE upload_id = $1`,
        [uploadId, JSON.stringify(parts)],
      )
      return 'recorded'
    })
  }

  async completeUpload(uploadId: string, blobRow: CompleteBlobRowInput): Promise<ArtifactBlobRef> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    const validated = validateArtifactBlobRef({
      blobId: blobRow.blobId,
      tenantId: blobRow.tenantId,
      sha256: blobRow.sha256,
      sizeBytes: blobRow.sizeBytes,
      mimeType: blobRow.mimeType,
      kind: blobRow.kind,
      ...(blobRow.logicalName === undefined ? {} : { logicalName: blobRow.logicalName }),
      ...(blobRow.containerRelativePath === undefined
        ? {}
        : { containerRelativePath: blobRow.containerRelativePath }),
      storageBackend: blobRow.storageBackend ?? 'local_cas',
      storageUri: blobRow.storageUri,
      ...(blobRow.createdAt === undefined ? {} : { createdAt: blobRow.createdAt }),
    })

    return withTransaction(this.pool, async (client) => {
      const uploadRes = await client.query<BlobUploadRow>(
        `SELECT upload_id, tenant_id, kind, filename, mime_type,
                expected_size_bytes, chunk_bytes, chunk_count,
                received_parts_json, status, completed_blob_id, created_at, updated_at
           FROM artifact_blob_uploads
          WHERE upload_id = $1
          FOR UPDATE`,
        [uploadId],
      )
      const upload = uploadRes.rows[0]
      assertCondition(upload !== undefined, 'BLOB_UPLOAD_NOT_FOUND')
      assertCondition(upload.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')
      assertCondition(String(upload.tenant_id) === validated.tenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')

      const insertedRes = await client.query<BlobRow>(
        `INSERT INTO artifact_blobs (
           blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
           logical_name, container_relative_path, storage_backend, storage_uri
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${BLOB_SELECT_COLUMNS}`,
        [
          validated.blobId,
          validated.tenantId,
          validated.sha256,
          validated.sizeBytes,
          validated.mimeType,
          validated.kind,
          validated.logicalName ?? null,
          validated.containerRelativePath ?? null,
          validated.storageBackend ?? 'local_cas',
          validated.storageUri!,
        ],
      )

      await client.query(
        `UPDATE artifact_blob_uploads
            SET status = 'completed',
                completed_blob_id = $2,
                updated_at = NOW()
          WHERE upload_id = $1`,
        [uploadId, validated.blobId],
      )

      return mapBlobRow(insertedRes.rows[0]!)
    })
  }

  async insertBlob(blobRow: CompleteBlobRowInput): Promise<ArtifactBlobRef> {
    const validated = validateArtifactBlobRef({
      blobId: blobRow.blobId,
      tenantId: blobRow.tenantId,
      sha256: blobRow.sha256,
      sizeBytes: blobRow.sizeBytes,
      mimeType: blobRow.mimeType,
      kind: blobRow.kind,
      ...(blobRow.logicalName === undefined ? {} : { logicalName: blobRow.logicalName }),
      ...(blobRow.containerRelativePath === undefined
        ? {}
        : { containerRelativePath: blobRow.containerRelativePath }),
      storageBackend: blobRow.storageBackend ?? 'local_cas',
      storageUri: blobRow.storageUri,
      ...(blobRow.createdAt === undefined ? {} : { createdAt: blobRow.createdAt }),
    })

    const res = await this.pool.query<BlobRow>(
      `INSERT INTO artifact_blobs (
         blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
         logical_name, container_relative_path, storage_backend, storage_uri
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${BLOB_SELECT_COLUMNS}`,
      [
        validated.blobId,
        validated.tenantId,
        validated.sha256,
        validated.sizeBytes,
        validated.mimeType,
        validated.kind,
        validated.logicalName ?? null,
        validated.containerRelativePath ?? null,
        validated.storageBackend ?? 'local_cas',
        validated.storageUri!,
      ],
    )
    return mapBlobRow(res.rows[0]!)
  }

  async statBlob(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(IDENT_8_128_RE.test(blobId), 'BLOB_ID_INVALID')
    const res = await this.pool.query<BlobRow>(
      `SELECT ${BLOB_SELECT_COLUMNS}
         FROM artifact_blobs
        WHERE tenant_id = $1 AND blob_id = $2 AND deleted_at IS NULL`,
      [tenantId, blobId],
    )
    return res.rows[0] ? mapBlobRow(res.rows[0]) : null
  }

  async findBlobBySha256(tenantId: string, sha256: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(SHA256_RE.test(sha256), 'BLOB_SHA256_INVALID')
    const res = await this.pool.query<BlobRow>(
      `SELECT ${BLOB_SELECT_COLUMNS}
         FROM artifact_blobs
        WHERE tenant_id = $1 AND sha256 = $2 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, sha256],
    )
    return res.rows[0] ? mapBlobRow(res.rows[0]) : null
  }

  async softDeleteBlob(tenantId: string, blobId: string): Promise<boolean> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(IDENT_8_128_RE.test(blobId), 'BLOB_ID_INVALID')
    const res = await this.pool.query<{ blob_id: string }>(
      `UPDATE artifact_blobs
          SET deleted_at = NOW()
        WHERE tenant_id = $1 AND blob_id = $2 AND deleted_at IS NULL
        RETURNING blob_id`,
      [tenantId, blobId],
    )
    return res.rows.length > 0
  }

  async listTenantBlobs(
    tenantId: string,
    kind?: ArtifactBlobKind,
  ): Promise<readonly ArtifactBlobRef[]> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    if (kind !== undefined) {
      assertCondition(BLOB_KIND_SET.has(kind), 'BLOB_KIND_INVALID')
      const res = await this.pool.query<BlobRow>(
        `SELECT ${BLOB_SELECT_COLUMNS}
           FROM artifact_blobs
          WHERE tenant_id = $1 AND kind = $2 AND deleted_at IS NULL
          ORDER BY created_at DESC`,
        [tenantId, kind],
      )
      return Object.freeze(res.rows.map(mapBlobRow))
    }

    const res = await this.pool.query<BlobRow>(
      `SELECT ${BLOB_SELECT_COLUMNS}
         FROM artifact_blobs
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [tenantId],
    )
    return Object.freeze(res.rows.map(mapBlobRow))
  }

  async gcUnreferencedBlobs(opts: GcUnreferencedBlobsOptions): Promise<GcUnreferencedBlobsResult> {
    if (opts.completeReferenceProof !== true) {
      throw new Error('BLOB_GC_INCOMPLETE_REFERENCE_PROOF')
    }
    assertCondition(
      typeof opts.olderThanMs === 'number' &&
        Number.isFinite(opts.olderThanMs) &&
        opts.olderThanMs >= 0,
      'BLOB_GC_OLDER_THAN_INVALID',
    )
    if (opts.tenantId !== undefined) {
      assertCondition(TENANT_ID_RE.test(opts.tenantId), 'BLOB_TENANT_ID_INVALID')
    }

    const nowMs = opts.nowMs ?? Date.now()
    const cutoffIso = new Date(nowMs - opts.olderThanMs).toISOString()
    const liveIds = Array.isArray(opts.liveBlobIds)
      ? dedupeCapStrings(opts.liveBlobIds)
      : dedupeCapStrings([...opts.liveBlobIds])

    const params: unknown[] = [cutoffIso, liveIds]
    const tenantClause = opts.tenantId !== undefined ? ' AND tenant_id = $3' : ''
    if (opts.tenantId !== undefined) params.push(opts.tenantId)

    const sql = opts.dryRun
      ? `SELECT blob_id
           FROM artifact_blobs
          WHERE deleted_at IS NULL
            AND created_at < $1::timestamptz
            AND NOT (blob_id = ANY($2::text[]))${tenantClause}`
      : `UPDATE artifact_blobs
            SET deleted_at = NOW()
          WHERE deleted_at IS NULL
            AND created_at < $1::timestamptz
            AND NOT (blob_id = ANY($2::text[]))${tenantClause}
          RETURNING blob_id`

    const res = await this.pool.query<{ blob_id: string }>(sql, params)
    const markedDeletedBlobIds = Object.freeze(res.rows.map((r) => String(r.blob_id)))
    return Object.freeze({
      markedDeletedBlobIds,
      markedDeletedCount: markedDeletedBlobIds.length,
      cutoffIso,
    })
  }
}
