/**
 * OCV5-890 / OCV5-928 — `PgSessionAuthorityStateStore` (`session_engine_pointers`,
 * `session_rolling_checkpoints`, `session_placement_migrations`).
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 * Zero `process.env`; zero dynamic SQL interpolation; all functions <= 85L, CC <= 15.
 */
import { randomUUID } from 'node:crypto'
import type {
  AuthoritativeRollingCheckpoint,
  AuthorityEngineKind,
  PlacementMigrationRecord,
  ResumeLadderResult,
  RollingCheckpointMode,
  SessionEnginePointer,
  StoragePoolKind,
} from '@openclaude/protocol'
import {
  queryPlacementMigration,
  runAbortPlacementMigration,
  runBeginPlacementMigration,
  runCommitPlacementMigration,
  runMarkPlacementMigrationInstalledAndAck,
} from './sessionPlacementMigrationOps.js'
import {
  CHECKPOINT_MODE_SET,
  ENGINE_SET,
  HISTORY_MAX_ENTRIES,
  STORAGE_POOL_SET,
  assertCondition,
  assertNonEmptyString,
  assertPositiveEpoch,
  dedupeCapStrings,
  mapPointerRow,
  normalizeUserId,
  toIsoString,
  withTransaction,
  type AbortPlacementMigrationCas,
  type AbortPlacementMigrationResult,
  type AckRollingCheckpointCas,
  type BeginPlacementMigrationCas,
  type BeginPlacementMigrationResult,
  type CommitPlacementMigrationCas,
  type CommitPlacementMigrationResult,
  type MarkPlacementMigrationInstalledOptions,
  type MarkPlacementMigrationInstalledResult,
  type PgTransactionClient,
  type PgTransactionPool,
  type PointerRow,
  type SaveRollingCheckpointInput,
  type SaveRollingCheckpointResult,
  type UpsertEnginePointerInput,
} from './types.js'

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
    ackedAt:
      row.acked_at === null || row.acked_at === undefined ? null : toIsoString(row.acked_at),
    createdAt: toIsoString(row.created_at),
  })
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

interface ResolvedUpsertFields {
  readonly nextNativeId: string | null
  readonly nextHistory: string[]
  readonly nextRejected: string[]
  readonly nextOperationId: string | null
  readonly nextProfileId: string | null
  readonly nextCapsuleId: string | null
  readonly nextPromptCacheMeta: Readonly<Record<string, unknown>> | null
  readonly nextUsageBaseline: Readonly<Record<string, number>> | null
  readonly nextHistoryContextVersion: number | null
  readonly nextPromotedFromHistory: boolean
}

function pickNullable<T>(
  incoming: T | null | undefined,
  existingVal: T | null | undefined,
): T | null {
  return incoming !== undefined ? incoming : (existingVal ?? null)
}

function pickBoolean(incoming: boolean | undefined, existingVal: boolean | undefined): boolean {
  return incoming !== undefined ? incoming : (existingVal ?? false)
}

function resolveUpsertPointerFields(
  input: UpsertEnginePointerInput,
  existing: SessionEnginePointer | null,
): ResolvedUpsertFields {
  const existingNativeId = existing?.nativeSessionId ?? null
  const nextNativeId = pickNullable(input.nativeSessionId, existingNativeId)
  const nextHistory = mergePointerHistory(
    existing?.history ?? [],
    existingNativeId,
    nextNativeId,
    input.history,
  )
  const nextRejected =
    input.rejectedIds !== undefined
      ? dedupeCapStrings(input.rejectedIds)
      : [...(existing?.rejectedIds ?? [])]
  return {
    nextNativeId,
    nextHistory,
    nextRejected,
    nextOperationId: pickNullable(input.operationId, existing?.operationId),
    nextProfileId: pickNullable(input.profileId, existing?.profileId),
    nextCapsuleId: pickNullable(input.capsuleId, existing?.capsuleId),
    nextPromptCacheMeta: pickNullable(input.promptCacheMeta, existing?.promptCacheMeta),
    nextUsageBaseline: pickNullable(input.usageBaseline, existing?.usageBaseline),
    nextHistoryContextVersion: pickNullable(
      input.historyContextVersion,
      existing?.historyContextVersion,
    ),
    nextPromotedFromHistory: pickBoolean(input.promotedFromHistory, existing?.promotedFromHistory),
  }
}

async function executePointerUpsertSql(
  client: PgTransactionClient,
  uid: string,
  key: string,
  poolKind: StoragePoolKind,
  engine: AuthorityEngineKind,
  fields: ResolvedUpsertFields,
  guardedEpoch: number,
): Promise<SessionEnginePointer> {
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
     RETURNING user_id, session_key, placement_epoch, pool_kind, engine,
               native_session_id, operation_id, profile_id, capsule_id,
               history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
               history_context_version, promoted_from_history, migration_state,
               active_migration_id, updated_at, created_at`,
    [
      uid,
      key,
      poolKind,
      engine,
      fields.nextNativeId,
      fields.nextOperationId,
      fields.nextProfileId,
      fields.nextCapsuleId,
      JSON.stringify(fields.nextHistory),
      JSON.stringify(fields.nextRejected),
      fields.nextPromptCacheMeta === null ? null : JSON.stringify(fields.nextPromptCacheMeta),
      fields.nextUsageBaseline === null ? null : JSON.stringify(fields.nextUsageBaseline),
      fields.nextHistoryContextVersion,
      fields.nextPromotedFromHistory,
      guardedEpoch,
    ],
  )
  if (res.rows.length > 0) {
    return mapPointerRow(res.rows[0]!)
  }

  const currentRes = await client.query<PointerRow>(
    `SELECT user_id, session_key, placement_epoch, pool_kind, engine,
            native_session_id, operation_id, profile_id, capsule_id,
            history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
            history_context_version, promoted_from_history, migration_state,
            active_migration_id, updated_at, created_at
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

function resolveSameEngineResumeTier(
  pointer: SessionEnginePointer,
  checkpoint: AuthoritativeRollingCheckpoint | null,
  sessionKey: string,
  placementEpoch: number,
  targetEngine: AuthorityEngineKind,
): ResumeLadderResult | null {
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
  return null
}

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
      `SELECT user_id, session_key, placement_epoch, pool_kind, engine,
              native_session_id, operation_id, profile_id, capsule_id,
              history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
              history_context_version, promoted_from_history, migration_state,
              active_migration_id, updated_at, created_at
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
        `SELECT user_id, session_key, placement_epoch, pool_kind, engine,
                native_session_id, operation_id, profile_id, capsule_id,
                history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
                history_context_version, promoted_from_history, migration_state,
                active_migration_id, updated_at, created_at
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
      const fields = resolveUpsertPointerFields(input, existing)
      return executePointerUpsertSql(
        client,
        uid,
        key,
        poolKind,
        input.engine,
        fields,
        guardedEpoch,
      )
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
      const hit = resolveSameEngineResumeTier(
        pointer,
        checkpoint,
        sessionKey,
        placementEpoch,
        targetEngine,
      )
      if (hit !== null) return hit
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
    expectedEpoch?: number,
  ): Promise<AuthoritativeRollingCheckpoint | null> {
    const uid = normalizeUserId(userId)
    const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    if (expectedEpoch !== undefined) {
      assertPositiveEpoch(expectedEpoch, 'STATE_STORE_PLACEMENT_EPOCH_INVALID')
    }
    const res =
      expectedEpoch !== undefined
        ? await this.pool.query<CheckpointRow>(
            `SELECT session_key, session_id, checkpoint_generation, placement_epoch, mode,
                    anchor_seq, source_engine, summary, instructions, acked_by_turn_key,
                    acked_at, created_at
               FROM session_rolling_checkpoints
              WHERE user_id = $1 AND session_key = $2 AND placement_epoch = $3 AND acked_at IS NULL
              ORDER BY created_at DESC, checkpoint_generation DESC
              LIMIT 1`,
            [uid, key, expectedEpoch],
          )
        : await this.pool.query<CheckpointRow>(
            `SELECT session_key, session_id, checkpoint_generation, placement_epoch, mode,
                    anchor_seq, source_engine, summary, instructions, acked_by_turn_key,
                    acked_at, created_at
               FROM session_rolling_checkpoints
              WHERE user_id = $1 AND session_key = $2 AND acked_at IS NULL
              ORDER BY created_at DESC, checkpoint_generation DESC
              LIMIT 1`,
            [uid, key],
          )
    const row = res.rows[0]
    return row ? mapCheckpointRow(row) : null
  }

  /** OCV5-902 P0-1: Read a rolling checkpoint by exact generation (survives epoch N -> N+1 bump on first-frame retry). */
  async getRollingCheckpointByGeneration(
    userId: number | bigint,
    sessionKey: string,
    checkpointGeneration: string,
    opts?: { readonly includeAcked?: boolean },
  ): Promise<AuthoritativeRollingCheckpoint | null> {
    const uid = normalizeUserId(userId)
    const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
    const generation = assertNonEmptyString(
      checkpointGeneration,
      'CHECKPOINT_GENERATION_INVALID',
      128,
    )
    const res =
      opts?.includeAcked === true
        ? await this.pool.query<CheckpointRow>(
            `SELECT session_key, session_id, checkpoint_generation, placement_epoch, mode,
                    anchor_seq, source_engine, summary, instructions, acked_by_turn_key,
                    acked_at, created_at
               FROM session_rolling_checkpoints
              WHERE user_id = $1 AND session_key = $2 AND checkpoint_generation = $3
              LIMIT 1`,
            [uid, key, generation],
          )
        : await this.pool.query<CheckpointRow>(
            `SELECT session_key, session_id, checkpoint_generation, placement_epoch, mode,
                    anchor_seq, source_engine, summary, instructions, acked_by_turn_key,
                    acked_at, created_at
               FROM session_rolling_checkpoints
              WHERE user_id = $1 AND session_key = $2 AND checkpoint_generation = $3 AND acked_at IS NULL
              LIMIT 1`,
            [uid, key, generation],
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
    return runBeginPlacementMigration(this.pool, cas)
  }

  async commitPlacementMigration(
    cas: CommitPlacementMigrationCas,
  ): Promise<CommitPlacementMigrationResult> {
    return runCommitPlacementMigration(this.pool, cas)
  }

  async abortPlacementMigration(
    cas: AbortPlacementMigrationCas,
  ): Promise<AbortPlacementMigrationResult> {
    return runAbortPlacementMigration(this.pool, cas)
  }

  async getPlacementMigration(migrationId: string): Promise<PlacementMigrationRecord | null> {
    return queryPlacementMigration(this.pool, migrationId)
  }

  /**
   * OCV5-893 B3 + OCV5-902 B1: Atomically clears `pendingInstallMigration` and acks the matched
   * `session_rolling_checkpoints` row inside a single PG transaction.
   */
  async markPlacementMigrationInstalledAndAckCheckpoint(
    userId: number | bigint,
    sessionKey: string,
    expectedEpoch: number,
    expectedMigrationId: string,
    opts?: MarkPlacementMigrationInstalledOptions,
  ): Promise<MarkPlacementMigrationInstalledResult> {
    return runMarkPlacementMigrationInstalledAndAck(
      this.pool,
      userId,
      sessionKey,
      expectedEpoch,
      expectedMigrationId,
      opts,
    )
  }

  async markPlacementMigrationInstalled(
    userId: number | bigint,
    sessionKey: string,
    expectedEpoch: number,
    expectedMigrationId: string,
    opts?: MarkPlacementMigrationInstalledOptions,
  ): Promise<boolean> {
    const res = await this.markPlacementMigrationInstalledAndAckCheckpoint(
      userId,
      sessionKey,
      expectedEpoch,
      expectedMigrationId,
      opts,
    )
    return res.installed
  }
}
