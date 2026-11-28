/**
 * OCV5-890 / OCV5-928 — Placement migration CAS operations (`session_placement_migrations`
 * and transactional `session_engine_pointers` / `session_rolling_checkpoints` updates).
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 * Zero `process.env`; zero dynamic SQL interpolation; all functions <= 85L, CC <= 15.
 */
import { randomUUID } from 'node:crypto'
import {
  validatePlacementDescriptor,
  type EngineStateCapsuleRef,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type PlacementMigrationState,
  type ResumeLadderTier,
} from '@openclaude/protocol'
import {
  buildPendingInstallPromptCacheMetaJson,
  extractPendingInstallMigration,
  normalizeCheckpointGeneration,
  resolvePendingInstallAckTarget,
  stripPendingInstallPromptCacheMetaJson,
  type PendingInstallMigration,
} from '../threeLayerPendingInstall.js'
import {
  IDENT_8_128_RE,
  RESUME_TIER_SET,
  assertCondition,
  assertNonEmptyString,
  assertPositiveEpoch,
  mapPointerRow,
  normalizeUserId,
  parseJsonValue,
  parseNullableRecord,
  toIsoString,
  withTransaction,
  type AbortPlacementMigrationCas,
  type AbortPlacementMigrationResult,
  type BeginPlacementMigrationCas,
  type BeginPlacementMigrationResult,
  type CommitPlacementMigrationCas,
  type CommitPlacementMigrationResult,
  type MarkPlacementMigrationInstalledOptions,
  type MarkPlacementMigrationInstalledResult,
  type MigrationRow,
  type PgQueryable,
  type PgTransactionClient,
  type PgTransactionPool,
  type PointerRow,
} from './types.js'

export function mapMigrationRow(row: MigrationRow): PlacementMigrationRecord {
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

async function lockAndEnterMigratingState(
  client: PgTransactionClient,
  uid: string,
  key: string,
  expectedEpoch: number,
  fromPlacement: PlacementDescriptor,
  migrationId: string,
): Promise<BeginPlacementMigrationResult | null> {
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
    return null
  }

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
  return null
}

export async function runBeginPlacementMigration(
  pool: PgTransactionPool,
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
  const migrationId = cas.migrationId !== undefined ? cas.migrationId : `mig-${randomUUID()}`
  assertCondition(IDENT_8_128_RE.test(migrationId), 'MIGRATION_ID_INVALID')

  return withTransaction<BeginPlacementMigrationResult>(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `session-migrate:${uid}:${key}`,
    ])
    const rejected = await lockAndEnterMigratingState(
      client,
      uid,
      key,
      expectedEpoch,
      fromPlacement,
      migrationId,
    )
    if (rejected !== null) return rejected

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

async function lockMigratingRowForUpdate(
  client: PgTransactionClient,
  migrationId: string,
  expectedUid: string | null,
  expectedSessionKey: string | undefined,
): Promise<{ uid: string; key: string } | null> {
  const migRes = await client.query<MigrationRow>(
    `SELECT migration_id, user_id, session_key, from_epoch, to_epoch, state,
            from_placement_json, to_placement_json, capsule_ref_json,
            continuity_tier, reason, created_at, completed_at
       FROM session_placement_migrations
      WHERE migration_id = $1
      FOR UPDATE`,
    [migrationId],
  )
  const migRow = migRes.rows[0]
  if (!migRow || migRow.state !== 'migrating') return null
  const uid = String(migRow.user_id)
  const key = String(migRow.session_key)
  if (expectedUid !== null && uid !== expectedUid) return null
  if (expectedSessionKey !== undefined && key !== expectedSessionKey) return null
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `session-migrate:${uid}:${key}`,
  ])
  return { uid, key }
}

async function updatePointerOnMigrationCommit(
  client: PgTransactionClient,
  uid: string,
  key: string,
  migration: PlacementMigrationRecord,
  cas: CommitPlacementMigrationCas,
  checkpointGeneration: string | null,
): Promise<PointerRow> {
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
  const hasUsageBaseline = cas.usageBaseline !== undefined

  const existingPtrRes = await client.query<{ prompt_cache_meta_json: unknown }>(
    `SELECT prompt_cache_meta_json
       FROM session_engine_pointers
      WHERE user_id = $1 AND session_key = $2
      FOR UPDATE`,
    [uid, key],
  )
  const basePromptCacheMeta =
    cas.promptCacheMeta !== undefined
      ? (cas.promptCacheMeta ?? {})
      : (parseNullableRecord(existingPtrRes.rows[0]?.prompt_cache_meta_json) ?? {})
  const pendingInstallMigration: PendingInstallMigration = {
    migrationId: migration.migrationId,
    targetPoolKind: toPlacement.poolKind,
    targetEpoch: migration.toEpoch,
    targetOperationId,
    continuityTier: cas.continuityTier,
    committedAtMs: Date.now(),
    ...(checkpointGeneration !== null ? { checkpointGeneration } : {}),
  }
  const nextPromptCacheMetaJson = buildPendingInstallPromptCacheMetaJson(
    basePromptCacheMeta,
    pendingInstallMigration,
  )

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
      RETURNING user_id, session_key, placement_epoch, pool_kind, engine,
                native_session_id, operation_id, profile_id, capsule_id,
                history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
                history_context_version, promoted_from_history, migration_state,
                active_migration_id, updated_at, created_at`,
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
      nextPromptCacheMetaJson,
      cas.usageBaseline === undefined || cas.usageBaseline === null
        ? null
        : JSON.stringify(cas.usageBaseline),
      cas.migrationId,
      hasNativeSessionId,
      hasCapsuleId,
      true,
      hasUsageBaseline,
    ],
  )
  if (ptrRes.rows.length === 0) {
    throw new Error('MIGRATION_POINTER_CAS_CONFLICT')
  }
  return ptrRes.rows[0]!
}

export async function runCommitPlacementMigration(
  pool: PgTransactionPool,
  cas: CommitPlacementMigrationCas,
): Promise<CommitPlacementMigrationResult> {
  assertCondition(IDENT_8_128_RE.test(cas.migrationId), 'MIGRATION_ID_INVALID')
  assertCondition(RESUME_TIER_SET.has(cas.continuityTier), 'MIGRATION_CONTINUITY_TIER_INVALID')
  const expectedUid = cas.userId !== undefined ? normalizeUserId(cas.userId) : null
  const checkpointGeneration = normalizeCheckpointGeneration(cas.checkpointGeneration)

  return withTransaction<CommitPlacementMigrationResult>(pool, async (client) => {
    const locked = await lockMigratingRowForUpdate(
      client,
      cas.migrationId,
      expectedUid,
      cas.sessionKey,
    )
    if (!locked) return Object.freeze({ applied: false as const })

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
    const ptrRow = await updatePointerOnMigrationCommit(
      client,
      locked.uid,
      locked.key,
      migration,
      cas,
      checkpointGeneration,
    )
    return Object.freeze({
      applied: true as const,
      migration,
      pointer: mapPointerRow(ptrRow),
    })
  })
}

export async function runAbortPlacementMigration(
  pool: PgTransactionPool,
  cas: AbortPlacementMigrationCas,
): Promise<AbortPlacementMigrationResult> {
  assertCondition(IDENT_8_128_RE.test(cas.migrationId), 'MIGRATION_ID_INVALID')
  const reason = assertNonEmptyString(cas.reason, 'MIGRATION_ABORT_REASON_INVALID', 512)
  const expectedUid = cas.userId !== undefined ? normalizeUserId(cas.userId) : null

  return withTransaction<AbortPlacementMigrationResult>(pool, async (client) => {
    const locked = await lockMigratingRowForUpdate(
      client,
      cas.migrationId,
      expectedUid,
      cas.sessionKey,
    )
    if (!locked) return Object.freeze({ applied: false as const })

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
        RETURNING user_id, session_key, placement_epoch, pool_kind, engine,
                  native_session_id, operation_id, profile_id, capsule_id,
                  history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json,
                  history_context_version, promoted_from_history, migration_state,
                  active_migration_id, updated_at, created_at`,
      [locked.uid, locked.key, cas.migrationId],
    )

    return Object.freeze({
      applied: true as const,
      migration: mapMigrationRow(abortedRes.rows[0]!),
      pointer: ptrRes.rows[0] ? mapPointerRow(ptrRes.rows[0]) : null,
    })
  })
}

export async function queryPlacementMigration(
  pool: PgQueryable,
  migrationId: string,
): Promise<PlacementMigrationRecord | null> {
  assertCondition(IDENT_8_128_RE.test(migrationId), 'MIGRATION_ID_INVALID')
  const res = await pool.query<MigrationRow>(
    `SELECT migration_id, user_id, session_key, from_epoch, to_epoch, state,
            from_placement_json, to_placement_json, capsule_ref_json,
            continuity_tier, reason, created_at, completed_at
       FROM session_placement_migrations
      WHERE migration_id = $1`,
    [migrationId],
  )
  return res.rows[0] ? mapMigrationRow(res.rows[0]) : null
}

export async function runMarkPlacementMigrationInstalledAndAck(
  pool: PgTransactionPool,
  userId: number | bigint,
  sessionKey: string,
  expectedEpoch: number,
  expectedMigrationId: string,
  opts?: MarkPlacementMigrationInstalledOptions,
): Promise<MarkPlacementMigrationInstalledResult> {
  const uid = normalizeUserId(userId)
  const key = assertNonEmptyString(sessionKey, 'STATE_STORE_SESSION_KEY_INVALID')
  const epoch = assertPositiveEpoch(expectedEpoch, 'STATE_STORE_PLACEMENT_EPOCH_INVALID')
  assertCondition(IDENT_8_128_RE.test(expectedMigrationId), 'MIGRATION_ID_INVALID')
  const turnKey =
    typeof opts?.consumedByTurnKey === 'string' && opts.consumedByTurnKey.trim().length > 0
      ? assertNonEmptyString(opts.consumedByTurnKey.trim(), 'CHECKPOINT_TURN_KEY_INVALID', 256)
      : `migration-install:${expectedMigrationId}`
  const noop = Object.freeze({
    installed: false,
    checkpointAcked: false,
    checkpointGeneration: null,
  })

  return withTransaction<MarkPlacementMigrationInstalledResult>(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `session-migrate:${uid}:${key}`,
    ])
    const ptrRes = await client.query<PointerRow>(
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
    const row = ptrRes.rows[0]
    if (!row) return noop
    const pointer = mapPointerRow(row)
    if (pointer.placementEpoch !== epoch) return noop
    const pending = extractPendingInstallMigration(pointer.promptCacheMeta)
    if (!pending || pending.migrationId !== expectedMigrationId || pending.targetEpoch !== epoch) {
      return noop
    }
    const ackTarget = resolvePendingInstallAckTarget(pending, opts)
    if (!ackTarget.allowed) return noop

    const nextJson = stripPendingInstallPromptCacheMetaJson(pointer.promptCacheMeta)
    const upd = await client.query<{ placement_epoch: string | number }>(
      `UPDATE session_engine_pointers
          SET prompt_cache_meta_json = $3::jsonb,
              updated_at = NOW()
        WHERE user_id = $1 AND session_key = $2 AND placement_epoch = $4
        RETURNING placement_epoch`,
      [uid, key, nextJson, epoch],
    )
    if (upd.rows.length === 0) return noop
    if (ackTarget.checkpointGeneration === null) {
      return Object.freeze({ installed: true, checkpointAcked: false, checkpointGeneration: null })
    }
    const ackRes = await client.query<{ checkpoint_generation: string }>(
      `UPDATE session_rolling_checkpoints
          SET acked_by_turn_key = $4,
              acked_at = NOW()
        WHERE user_id = $1
          AND session_key = $2
          AND checkpoint_generation = $3
          AND acked_at IS NULL
        RETURNING checkpoint_generation`,
      [uid, key, ackTarget.checkpointGeneration, turnKey],
    )
    return Object.freeze({
      installed: true,
      checkpointAcked: ackRes.rows.length > 0,
      checkpointGeneration: ackTarget.checkpointGeneration,
    })
  })
}
