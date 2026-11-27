/**
 * Per-session file ownership verification for `UniversalEngineStateCapsuleStore`.
 *
 * Prevents cross-session native state clobbering (OCV5-913 T2 B1):
 * - Single-session exports must ONLY collect files proven to belong to the
 *   target `nativeSessionId` (never sibling sessions or shared multi-session DBs).
 * - Imports (including legacy/unfiltered capsules exported by older binaries)
 *   must verify every logical path & relocated target path belongs to the
 *   target session BEFORE writing any byte to disk; otherwise fail closed as
 *   `incompatible` so callers degrade cleanly to `tape_rebuilt` without
 *   overwriting sibling sessions or shared SQLite databases.
 */

const INVALID_SESSION_ID_RE = /[/\\\u0000-\u001F\u007F]|\.\./
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g
const MIN_OWNERSHIP_ID_LEN = 4

function escapeRegex(value: string): string {
  return value.replace(REGEX_META_RE, '\\$&')
}

function normalizeNativeSessionId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length < MIN_OWNERSHIP_ID_LEN) return null
  if (INVALID_SESSION_ID_RE.test(trimmed)) return null
  return trimmed
}

/**
 * Returns `true` iff `logicalPath` contains `nativeSessionId` as a standalone
 * non-alphanumeric-delimited token (e.g. `<id>.jsonl`, `rollout-...-<id>.jsonl`,
 * `conversations/<id>.db`, `brain/<id>/...`). Shared files like `state/global.db`
 * or sibling session files carrying another session's ID return `false`.
 */
export function isLogicalPathOwnedByNativeSession(
  logicalPath: string,
  nativeSessionId: string | null | undefined,
): boolean {
  const id = normalizeNativeSessionId(nativeSessionId)
  if (!id || typeof logicalPath !== 'string' || logicalPath.length === 0) {
    return false
  }
  const tokenRe = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(id)}(?:$|[^A-Za-z0-9])`, 'i')
  return tokenRe.test(logicalPath)
}

export function filterSessionOwnedPaths(
  logicalPaths: readonly string[],
  nativeSessionId: string | null | undefined,
): string[] {
  return logicalPaths.filter((p) => isLogicalPathOwnedByNativeSession(p, nativeSessionId))
}

export function requireSessionOwnedPaths(
  logicalPaths: readonly string[],
  nativeSessionId: string | null | undefined,
): string[] {
  const owned = filterSessionOwnedPaths(logicalPaths, nativeSessionId)
  if (owned.length === 0) {
    throw new Error('CAPSULE_NO_SESSION_OWNED_FILES')
  }
  return owned
}

export function findUnownedCapsuleEntry(
  files: readonly { readonly logicalPath: string }[],
  nativeSessionId: string | null | undefined,
  relocate?: (logicalPath: string) => string,
): string | null {
  for (const entry of files) {
    if (!isLogicalPathOwnedByNativeSession(entry.logicalPath, nativeSessionId)) {
      return entry.logicalPath
    }
    if (relocate) {
      const dest = relocate(entry.logicalPath)
      if (!isLogicalPathOwnedByNativeSession(dest, nativeSessionId)) {
        return dest
      }
    }
  }
  return null
}

export function checkImportNativeSessionOwnership(
  manifest: {
    readonly nativeSessionId?: string | null
    readonly files: readonly { readonly logicalPath: string }[]
  },
  expectedNativeSessionId: string | null | undefined,
  relocate: (logicalPath: string) => string,
): string | null {
  if (
    expectedNativeSessionId &&
    manifest.nativeSessionId &&
    manifest.nativeSessionId !== expectedNativeSessionId
  ) {
    return 'native_session_mismatch'
  }
  const ownerId = expectedNativeSessionId ?? manifest.nativeSessionId
  const unowned = findUnownedCapsuleEntry(manifest.files, ownerId, relocate)
  return unowned ? `capsule_file_ownership_unverified:${unowned}` : null
}
