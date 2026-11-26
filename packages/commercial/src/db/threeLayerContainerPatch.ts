/**
 * OCV5-907 Wave 2 R1 Audit Fix (B1 / B2 / B4 / B8) — Narrow container-owned
 * PostgreSQL state patches & tenant-fenced multipart upload helpers.
 *
 * Security & ownership invariants:
 * - Container callers NEVER own placement fields (`pool_kind`, `operation_id`,
 *   `profile_id`, `migration_state`, `active_migration_id`) or master-reserved
 *   `prompt_cache_meta_json` keys (`pendingInstallMigration`).
 * - Every mutation executes under `pg_advisory_xact_lock('session-migrate:' || uid || ':' || key)`
 *   + `FOR UPDATE` row lock with strict `placement_epoch` CAS.
 * - Legacy cache without a known epoch must pass `createIfAbsentOnly: true`:
 *   if an authoritative row already exists for a different head, PG fails closed
 *   with `SESSION_PLACEMENT_EPOCH_MISMATCH` rather than clobbering newer epochs.
 * - Layer: platform-pg (L2). Zero `process.env`, zero `R3-special-case`.
 */
import {
  AUTHORITY_ENGINE_KINDS,
  type AuthorityEngineKind,
  type SessionEnginePointer,
} from '@openclaude/protocol'
import {
  PENDING_INSTALL_MIGRATION_KEY,
  type PgTransactionClient,
  type PgTransactionPool,
} from './threeLayerStateStore.js'

const ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const HISTORY_MAX_ENTRIES = 4
const RESERVED_PROMPT_META_KEYS = new Set<string>([
  PENDING_INSTALL_MIGRATION_KEY,
  '_capsuleMeta',
])

const POINTER_SELECT_COLUMNS = `user_id, session_key, placement_epoch, pool_kind, engine, native_session_id, operation_id, profile_id, capsule_id, history_json, rejected_ids_json, prompt_cache_meta_json, usage_baseline_json, history_context_version, promoted_from_history, migration_state, active_migration_id, updated_at, created_at`

interface PointerRow extends Record<string, unknown> {
  user_id: string | number
  session_key: string
  placement_epoch: number
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
  history_context_version: number | null
  promoted_from_history: boolean
  migration_state: string
  active_migration_id: string | null
  updated_at: string | Date
  created_at: string | Date
}

function assertCond(cond: unknown, code: string): asserts cond {
  if (!cond) throw new Error(code)
}

function normUid(userId: number | bigint): string {
  if (typeof userId === 'bigint') {
    assertCond(userId > 0n, 'STATE_STORE_USER_ID_INVALID')
    return userId.toString()
  }
  assertCond(Number.isSafeInteger(userId) && userId > 0, 'STATE_STORE_USER_ID_INVALID')
  return String(userId)
}

function parseJsonObj(raw: unknown): Record<string, unknown> | null {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return { ...(parsed as Record<string, unknown>) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseStrArr(raw: unknown): string[] {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

function parseNumRec(raw: unknown): Record<string, number> | null {
  const obj = parseJsonObj(raw)
  if (!obj) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function toIso(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string' && raw.length > 0) return raw
  return new Date(0).toISOString()
}

function mapRow(row: PointerRow): SessionEnginePointer {
  return {
    sessionKey: String(row.session_key),
    placementEpoch: Number(row.placement_epoch),
    poolKind: row.pool_kind as SessionEnginePointer['poolKind'],
    engine: row.engine as AuthorityEngineKind,
    nativeSessionId: row.native_session_id ?? null,
    operationId: row.operation_id ?? null,
    profileId: row.profile_id ?? null,
    capsuleId: row.capsule_id ?? null,
    history: Object.freeze(parseStrArr(row.history_json)),
    rejectedIds: Object.freeze(parseStrArr(row.rejected_ids_json)),
    promptCacheMeta: parseJsonObj(row.prompt_cache_meta_json),
    usageBaseline: parseNumRec(row.usage_baseline_json),
    historyContextVersion:
      row.history_context_version === null || row.history_context_version === undefined
        ? null
        : Number(row.history_context_version),
    promotedFromHistory: Boolean(row.promoted_from_history),
    migrationState: row.migration_state === 'migrating' ? 'migrating' : 'active',
    activeMigrationId: row.active_migration_id ?? null,
    updatedAt: toIso(row.updated_at),
    createdAt: toIso(row.created_at),
  }
}

async function withTx<T>(
  pool: PgTransactionPool,
  fn: (client: PgTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const res = await fn(client)
    await client.query('COMMIT')
    return res
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface PatchContainerResumePointerInput {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string | null
  readonly history?: readonly string[]
  readonly rejectedIds?: readonly string[]
  readonly totalCostUsd?: number
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory?: boolean
  readonly expectedPlacementEpoch?: number
  readonly createIfAbsentOnly?: boolean
  readonly reset?: boolean
}

export async function patchContainerResumePointer(
  pool: PgTransactionPool,
  input: PatchContainerResumePointerInput,
): Promise<SessionEnginePointer> {
  const uid = normUid(input.userId)
  assertCond(
    typeof input.sessionKey === 'string' &&
      input.sessionKey.trim().length > 0 &&
      input.sessionKey.length <= 512,
    'STATE_STORE_SESSION_KEY_INVALID',
  )
  assertCond(ENGINE_SET.has(input.engine), 'STATE_STORE_ENGINE_INVALID')
  assertCond(
    input.expectedPlacementEpoch !== undefined || input.createIfAbsentOnly === true,
    'STATE_STORE_PRECONDITION_REQUIRED',
  )
  if (input.expectedPlacementEpoch !== undefined) {
    assertCond(
      Number.isSafeInteger(input.expectedPlacementEpoch) && input.expectedPlacementEpoch >= 1,
      'STATE_STORE_PLACEMENT_EPOCH_INVALID',
    )
  }

  return withTx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `session-migrate:${uid}:${input.sessionKey}`,
    ])
    const existingRes = await client.query<PointerRow>(
      `SELECT ${POINTER_SELECT_COLUMNS}
         FROM session_engine_pointers
        WHERE user_id = $1 AND session_key = $2
        FOR UPDATE`,
      [uid, input.sessionKey],
    )
    const existing = existingRes.rows[0] ? mapRow(existingRes.rows[0]) : null

    if (existing) {
      if (existing.migrationState === 'migrating') {
        throw new Error('SESSION_PLACEMENT_MIGRATING')
      }
      if (input.createIfAbsentOnly === true) {
        // Legacy cache without a known epoch may NEVER overwrite a differing authoritative row.
        if (
          existing.engine !== input.engine ||
          existing.nativeSessionId !== input.nativeSessionId
        ) {
          throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
        }
        return existing
      }
      if (existing.placementEpoch !== input.expectedPlacementEpoch) {
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }
    } else {
      if (
        input.expectedPlacementEpoch !== undefined &&
        input.expectedPlacementEpoch !== 1
      ) {
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }
    }

    const nextNativeId = input.reset ? null : input.nativeSessionId
    const nextHistory = input.reset
      ? []
      : input.history !== undefined
        ? [...new Set(input.history.filter((h) => h.length > 0 && h !== nextNativeId))].slice(
            0,
            HISTORY_MAX_ENTRIES,
          )
        : [...(existing?.history ?? [])]
    const nextRejected =
      input.rejectedIds !== undefined
        ? [...new Set(input.rejectedIds.filter((r) => r.length > 0))].slice(0, 32)
        : [...(existing?.rejectedIds ?? [])]
    // Preserve all existing usageBaseline keys; only merge totalCostUsd if supplied.
    const nextUsageBaseline: Record<string, number> | null =
      input.totalCostUsd !== undefined && Number.isFinite(input.totalCostUsd)
        ? { ...(existing?.usageBaseline ?? {}), totalCostUsd: input.totalCostUsd }
        : (existing?.usageBaseline ? { ...existing.usageBaseline } : null)
    const nextHistoryCtxVer =
      input.historyContextVersion !== undefined
        ? input.historyContextVersion
        : (existing?.historyContextVersion ?? null)
    const nextPromoted = input.reset
      ? false
      : input.promotedFromHistory !== undefined
        ? input.promotedFromHistory
        : (existing?.promotedFromHistory ?? false)

    if (!existing) {
      const inserted = await client.query<PointerRow>(
        `INSERT INTO session_engine_pointers (
           user_id, session_key, placement_epoch, pool_kind, engine,
           native_session_id, history_json, rejected_ids_json,
           usage_baseline_json, history_context_version, promoted_from_history
         ) VALUES ($1, $2, 1, 'local_container', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING ${POINTER_SELECT_COLUMNS}`,
        [
          uid,
          input.sessionKey,
          input.engine,
          nextNativeId,
          JSON.stringify(nextHistory),
          JSON.stringify(nextRejected),
          nextUsageBaseline === null ? null : JSON.stringify(nextUsageBaseline),
          nextHistoryCtxVer,
          nextPromoted,
        ],
      )
      return mapRow(inserted.rows[0]!)
    }

    // Narrow UPDATE: NEVER mutates pool_kind, operation_id, profile_id,
    // capsule_id, prompt_cache_meta_json (preserving pendingInstallMigration /
    // _capsuleMeta / promptState), migration_state, or active_migration_id.
    const updated = await client.query<PointerRow>(
      `UPDATE session_engine_pointers
          SET engine = $3,
              native_session_id = $4,
              history_json = $5::jsonb,
              rejected_ids_json = $6::jsonb,
              usage_baseline_json = $7::jsonb,
              history_context_version = $8,
              promoted_from_history = $9,
              updated_at = NOW()
        WHERE user_id = $1
          AND session_key = $2
          AND placement_epoch = $10
          AND migration_state = 'active'
        RETURNING ${POINTER_SELECT_COLUMNS}`,
      [
        uid,
        input.sessionKey,
        input.engine,
        nextNativeId,
        JSON.stringify(nextHistory),
        JSON.stringify(nextRejected),
        nextUsageBaseline === null ? null : JSON.stringify(nextUsageBaseline),
        nextHistoryCtxVer,
        nextPromoted,
        existing.placementEpoch,
      ],
    )
    if (updated.rows.length === 0) {
      throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
    }
    return mapRow(updated.rows[0]!)
  })
}

export interface PatchContainerPromptStateInput {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly expectedPlacementEpoch: number
  readonly promptState: {
    readonly v: 1
    readonly sessionKey: string
    readonly conversationId: string
    readonly inputsKey: string
    readonly slotHashes?: Readonly<Record<string, string>>
    readonly injectedAfterBaseline: number
    readonly updatedAt: number
  }
}

export async function patchContainerPromptState(
  pool: PgTransactionPool,
  input: PatchContainerPromptStateInput,
): Promise<SessionEnginePointer> {
  const uid = normUid(input.userId)
  assertCond(ENGINE_SET.has(input.engine), 'STATE_STORE_ENGINE_INVALID')
  assertCond(
    Number.isSafeInteger(input.expectedPlacementEpoch) && input.expectedPlacementEpoch >= 1,
    'STATE_STORE_PLACEMENT_EPOCH_INVALID',
  )

  return withTx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `session-migrate:${uid}:${input.sessionKey}`,
    ])
    const existingRes = await client.query<PointerRow>(
      `SELECT ${POINTER_SELECT_COLUMNS}
         FROM session_engine_pointers
        WHERE user_id = $1 AND session_key = $2
        FOR UPDATE`,
      [uid, input.sessionKey],
    )
    const existing = existingRes.rows[0] ? mapRow(existingRes.rows[0]) : null
    if (existing) {
      if (existing.migrationState === 'migrating') {
        throw new Error('SESSION_PLACEMENT_MIGRATING')
      }
      if (existing.placementEpoch !== input.expectedPlacementEpoch) {
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }
    } else if (input.expectedPlacementEpoch !== 1) {
      throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
    }

    const stamped = {
      ...input.promptState,
      placementEpoch: existing?.placementEpoch ?? 1,
    }
    const mergedMeta: Record<string, unknown> = {
      ...(existing?.promptCacheMeta ?? {}),
      conversationId: stamped.conversationId,
      inputsKey: stamped.inputsKey,
      injectedAfterBaseline: stamped.injectedAfterBaseline,
      ...(stamped.slotHashes ? { slotHashes: stamped.slotHashes } : {}),
      placementEpoch: stamped.placementEpoch,
      updatedAt: stamped.updatedAt,
      promptState: stamped,
    }
    // Never allow promptState patch to drop reserved master keys that existed.
    for (const reserved of RESERVED_PROMPT_META_KEYS) {
      if (existing?.promptCacheMeta && reserved in existing.promptCacheMeta) {
        mergedMeta[reserved] = existing.promptCacheMeta[reserved]
      }
    }

    if (!existing) {
      const inserted = await client.query<PointerRow>(
        `INSERT INTO session_engine_pointers (
           user_id, session_key, placement_epoch, pool_kind, engine,
           native_session_id, prompt_cache_meta_json
         ) VALUES ($1, $2, 1, 'local_container', $3, $4, $5::jsonb)
         RETURNING ${POINTER_SELECT_COLUMNS}`,
        [uid, input.sessionKey, input.engine, stamped.conversationId, JSON.stringify(mergedMeta)],
      )
      return mapRow(inserted.rows[0]!)
    }

    const updated = await client.query<PointerRow>(
      `UPDATE session_engine_pointers
          SET prompt_cache_meta_json = $3::jsonb,
              updated_at = NOW()
        WHERE user_id = $1
          AND session_key = $2
          AND placement_epoch = $4
          AND migration_state = 'active'
        RETURNING ${POINTER_SELECT_COLUMNS}`,
      [uid, input.sessionKey, JSON.stringify(mergedMeta), existing.placementEpoch],
    )
    if (updated.rows.length === 0) {
      throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
    }
    return mapRow(updated.rows[0]!)
  })
}

export interface PatchContainerCapsuleRefInput {
  readonly userId: number | bigint
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly expectedPlacementEpoch: number
  readonly capsuleId: string
  readonly manifestBlobId: string
  readonly engineVersion: string
  readonly createdAt: string
  readonly nativeSessionId?: string | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
}

export async function patchContainerCapsuleRef(
  pool: PgTransactionPool,
  input: PatchContainerCapsuleRefInput,
): Promise<SessionEnginePointer> {
  const uid = normUid(input.userId)
  assertCond(ENGINE_SET.has(input.engine), 'STATE_STORE_ENGINE_INVALID')
  assertCond(
    Number.isSafeInteger(input.expectedPlacementEpoch) && input.expectedPlacementEpoch >= 1,
    'STATE_STORE_PLACEMENT_EPOCH_INVALID',
  )
  assertCond(
    typeof input.capsuleId === 'string' && input.capsuleId.trim().length > 0 && input.capsuleId.length <= 256,
    'STATE_STORE_CAPSULE_ID_INVALID',
  )
  assertCond(
    typeof input.manifestBlobId === 'string' &&
      input.manifestBlobId.trim().length > 0 &&
      input.manifestBlobId.length <= 128,
    'STATE_STORE_MANIFEST_BLOB_ID_INVALID',
  )

  return withTx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `session-migrate:${uid}:${input.sessionKey}`,
    ])
    const existingRes = await client.query<PointerRow>(
      `SELECT ${POINTER_SELECT_COLUMNS}
         FROM session_engine_pointers
        WHERE user_id = $1 AND session_key = $2
        FOR UPDATE`,
      [uid, input.sessionKey],
    )
    const existing = existingRes.rows[0] ? mapRow(existingRes.rows[0]) : null
    if (existing) {
      if (existing.migrationState === 'migrating') {
        throw new Error('SESSION_PLACEMENT_MIGRATING')
      }
      if (existing.placementEpoch !== input.expectedPlacementEpoch) {
        throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
      }
    } else if (input.expectedPlacementEpoch !== 1) {
      throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
    }

    const mergedMeta: Record<string, unknown> = {
      ...(existing?.promptCacheMeta ?? {}),
      _capsuleMeta: {
        capsuleId: input.capsuleId,
        manifestBlobId: input.manifestBlobId,
        engine: input.engine,
        engineVersion: input.engineVersion,
        placementEpoch: existing?.placementEpoch ?? 1,
        createdAt: input.createdAt,
      },
    }
    const nextUsage: Record<string, number> | null = input.usageBaseline
      ? { ...(existing?.usageBaseline ?? {}), ...input.usageBaseline }
      : (existing?.usageBaseline ? { ...existing.usageBaseline } : null)

    if (!existing) {
      const inserted = await client.query<PointerRow>(
        `INSERT INTO session_engine_pointers (
           user_id, session_key, placement_epoch, pool_kind, engine,
           native_session_id, capsule_id, prompt_cache_meta_json, usage_baseline_json
         ) VALUES ($1, $2, 1, 'local_container', $3, $4, $5, $6::jsonb, $7::jsonb)
         RETURNING ${POINTER_SELECT_COLUMNS}`,
        [
          uid,
          input.sessionKey,
          input.engine,
          input.nativeSessionId ?? null,
          input.capsuleId,
          JSON.stringify(mergedMeta),
          nextUsage === null ? null : JSON.stringify(nextUsage),
        ],
      )
      return mapRow(inserted.rows[0]!)
    }

    const updated = await client.query<PointerRow>(
      `UPDATE session_engine_pointers
          SET capsule_id = $3,
              prompt_cache_meta_json = $4::jsonb,
              usage_baseline_json = $5::jsonb,
              updated_at = NOW()
        WHERE user_id = $1
          AND session_key = $2
          AND placement_epoch = $6
          AND migration_state = 'active'
        RETURNING ${POINTER_SELECT_COLUMNS}`,
      [
        uid,
        input.sessionKey,
        input.capsuleId,
        JSON.stringify(mergedMeta),
        nextUsage === null ? null : JSON.stringify(nextUsage),
        existing.placementEpoch,
      ],
    )
    if (updated.rows.length === 0) {
      throw new Error('SESSION_PLACEMENT_EPOCH_MISMATCH')
    }
    return mapRow(updated.rows[0]!)
  })
}
