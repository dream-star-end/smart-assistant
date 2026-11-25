/**
 * OCV5-893 B3 — Pending-install migration metadata helpers stored inside
 * `session_engine_pointers.prompt_cache_meta_json` (zero schema changes).
 *
 * Layer: platform-pg (L2). Zero `process.env`, zero network I/O, zero forbidden crypto.
 */
import {
  RESUME_LADDER_TIERS,
  STORAGE_POOL_KINDS,
  type ResumeLadderTier,
  type StoragePoolKind,
} from '@openclaude/protocol'

export interface PendingInstallMigration {
  readonly migrationId: string
  readonly targetPoolKind: StoragePoolKind
  readonly targetEpoch: number
  readonly targetOperationId: string | null
  readonly continuityTier: ResumeLadderTier
  readonly committedAtMs: number
}

export const PENDING_INSTALL_MIGRATION_KEY = 'pendingInstallMigration' as const

const IDENT_8_128_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const STORAGE_POOL_SET: ReadonlySet<string> = new Set<string>(STORAGE_POOL_KINDS)
const RESUME_TIER_SET: ReadonlySet<string> = new Set<string>(RESUME_LADDER_TIERS)

export function extractPendingInstallMigration(
  promptCacheMeta: Readonly<Record<string, unknown>> | null | undefined,
): PendingInstallMigration | null {
  if (!promptCacheMeta || typeof promptCacheMeta !== 'object') return null
  const raw = promptCacheMeta[PENDING_INSTALL_MIGRATION_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (
    typeof rec.migrationId !== 'string' ||
    !IDENT_8_128_RE.test(rec.migrationId) ||
    typeof rec.targetPoolKind !== 'string' ||
    !STORAGE_POOL_SET.has(rec.targetPoolKind) ||
    typeof rec.targetEpoch !== 'number' ||
    !Number.isSafeInteger(rec.targetEpoch) ||
    rec.targetEpoch < 1 ||
    typeof rec.continuityTier !== 'string' ||
    !RESUME_TIER_SET.has(rec.continuityTier) ||
    typeof rec.committedAtMs !== 'number' ||
    !Number.isFinite(rec.committedAtMs)
  ) {
    return null
  }
  const targetOperationId =
    rec.targetOperationId === null || rec.targetOperationId === undefined
      ? null
      : typeof rec.targetOperationId === 'string' && rec.targetOperationId.length > 0
        ? rec.targetOperationId
        : null
  return Object.freeze({
    migrationId: rec.migrationId,
    targetPoolKind: rec.targetPoolKind as StoragePoolKind,
    targetEpoch: rec.targetEpoch,
    targetOperationId,
    continuityTier: rec.continuityTier as ResumeLadderTier,
    committedAtMs: rec.committedAtMs,
  })
}

export function buildPendingInstallPromptCacheMetaJson(
  baseMeta: Readonly<Record<string, unknown>> | null | undefined,
  pending: PendingInstallMigration,
): string {
  return JSON.stringify({
    ...(baseMeta ?? {}),
    [PENDING_INSTALL_MIGRATION_KEY]: pending,
  })
}

export function stripPendingInstallPromptCacheMetaJson(
  promptCacheMeta: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  const nextMeta: Record<string, unknown> = { ...(promptCacheMeta ?? {}) }
  delete nextMeta[PENDING_INSTALL_MIGRATION_KEY]
  return Object.keys(nextMeta).length === 0 ? null : JSON.stringify(nextMeta)
}
