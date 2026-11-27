/**
 * Engine-aware positional file ownership verification for `UniversalEngineStateCapsuleStore`.
 *
 * Prevents cross-session native state clobbering (OCV5-913 T2 B1 + Steward R1):
 * - Single-session exports must ONLY collect files whose engine-specific owner
 *   slot (aligned with `packages/gateway/src/engine/resumeArtifacts.ts`) matches
 *   the target `nativeSessionId` — never sibling sessions (even when a parent
 *   project directory name happens to contain session A's ID) or shared DBs.
 * - Imports (including legacy/unfiltered capsules exported by older binaries)
 *   must verify BOTH the source logicalPath AND the relocated target path
 *   belong to the target session BEFORE creating restore markers or writing any
 *   byte to disk; unknown layouts fail closed as `incompatible`.
 */

import type { AuthorityEngineKind } from '@openclaude/protocol/storage-seam'

const INVALID_SESSION_ID_RE = /[/\\]|\.\./
const MIN_OWNERSHIP_ID_LEN = 4
const UUID_SUFFIX_RE =
  /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const YEAR_RE = /^\d{4}$/
const TWO_DIGIT_RE = /^\d{2}$/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function normalizeNativeSessionId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length < MIN_OWNERSHIP_ID_LEN) return null
  if (INVALID_SESSION_ID_RE.test(trimmed) || hasControlChar(trimmed)) return null
  return trimmed
}

function splitSafeLogicalSegments(logicalPath: string): string[] | null {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0) return null
  if (logicalPath.includes('\\') || logicalPath.startsWith('/') || logicalPath.endsWith('/')) {
    return null
  }
  const segments = logicalPath.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || hasControlChar(seg)) {
      return null
    }
  }
  return segments
}

function stripRequiredSuffix(value: string, suffix: string): string | null {
  return value.toLowerCase().endsWith(suffix) ? value.slice(0, -suffix.length) : null
}

function extractCcbOwner(segments: readonly string[]): string | null {
  if (segments.length === 3 && segments[0] === 'projects') {
    const stem = stripRequiredSuffix(segments[2]!, '.jsonl')
    return stem ? normalizeNativeSessionId(stem) : null
  }
  if (segments.length === 2 && segments[0] === 'todos') {
    const stem = stripRequiredSuffix(segments[1]!, '.json')
    return stem ? normalizeNativeSessionId(stem) : null
  }
  return null
}

function isCodexDatedPath(segments: readonly string[]): boolean {
  return (
    segments.length === 5 &&
    segments[0] === 'sessions' &&
    YEAR_RE.test(segments[1]!) &&
    TWO_DIGIT_RE.test(segments[2]!) &&
    TWO_DIGIT_RE.test(segments[3]!)
  )
}

function extractCodexOwner(segments: readonly string[]): string | null {
  const isFlat = segments.length === 2 && segments[0] === 'sessions'
  if (!isFlat && !isCodexDatedPath(segments)) return null
  const stem = stripRequiredSuffix(segments[segments.length - 1]!, '.jsonl')
  if (!stem) return null
  const uuidMatch = UUID_SUFFIX_RE.exec(stem)
  if (uuidMatch?.[1]) return normalizeNativeSessionId(uuidMatch[1])
  return isFlat ? normalizeNativeSessionId(stem) : null
}

function extractAntigravityOwner(segments: readonly string[]): string | null {
  if (segments.length === 2 && segments[0] === 'conversations') {
    const stem = stripRequiredSuffix(segments[1]!, '.db')
    return stem ? normalizeNativeSessionId(stem) : null
  }
  if (segments.length >= 3 && segments[0] === 'brain') {
    return normalizeNativeSessionId(segments[1])
  }
  return null
}

function extractGrokOwner(segments: readonly string[]): string | null {
  if (segments.length >= 4 && segments[0] === 'sessions') {
    return normalizeNativeSessionId(segments[2])
  }
  if (segments.length >= 5 && segments[0] === 'fast' && segments[1] === 'sessions') {
    return normalizeNativeSessionId(segments[3])
  }
  return null
}

function extractCursorOwner(segments: readonly string[]): string | null {
  return segments.length >= 4 && segments[0] === 'chats'
    ? normalizeNativeSessionId(segments[2])
    : null
}

function extractZcodeOwner(segments: readonly string[]): string | null {
  return segments.length >= 4 && segments[0] === 'cli' && segments[1] === 'exec'
    ? normalizeNativeSessionId(segments[2])
    : null
}

const ENGINE_OWNER_EXTRACTORS: Readonly<
  Record<string, (segments: readonly string[]) => string | null>
> = Object.freeze({
  ccb: extractCcbOwner,
  codex: extractCodexOwner,
  antigravity: extractAntigravityOwner,
  grok: extractGrokOwner,
  cursor: extractCursorOwner,
  zcode: extractZcodeOwner,
})

/**
 * Extracts the exact owning native session/conversation ID from its fixed
 * per-engine path slot (aligned with `resumeArtifacts.ts`), ignoring unrelated
 * parent segments such as CCB project directory slugs. Returns `null` for
 * shared multi-session databases or unknown layouts (fail-closed).
 */
export function extractLogicalPathOwner(
  engine: AuthorityEngineKind | string,
  logicalPath: string,
): string | null {
  const segments = splitSafeLogicalSegments(logicalPath)
  if (!segments) return null
  const extractor = Object.prototype.hasOwnProperty.call(ENGINE_OWNER_EXTRACTORS, engine)
    ? ENGINE_OWNER_EXTRACTORS[engine]
    : undefined
  return extractor ? extractor(segments) : null
}

export function isLogicalPathOwnedByNativeSession(
  engine: AuthorityEngineKind | string,
  logicalPath: string,
  nativeSessionId: string | null | undefined,
): boolean {
  const id = normalizeNativeSessionId(nativeSessionId)
  if (!id) return false
  const owner = extractLogicalPathOwner(engine, logicalPath)
  return owner !== null && owner.toLowerCase() === id.toLowerCase()
}

export function filterSessionOwnedPaths(
  logicalPaths: readonly string[],
  engine: AuthorityEngineKind | string,
  nativeSessionId: string | null | undefined,
): string[] {
  return logicalPaths.filter((p) => isLogicalPathOwnedByNativeSession(engine, p, nativeSessionId))
}

export function requireSessionOwnedPaths(
  logicalPaths: readonly string[],
  engine: AuthorityEngineKind | string,
  nativeSessionId: string | null | undefined,
): string[] {
  const owned = filterSessionOwnedPaths(logicalPaths, engine, nativeSessionId)
  if (owned.length === 0) {
    throw new Error('CAPSULE_NO_SESSION_OWNED_FILES')
  }
  return owned
}

export function findUnownedCapsuleEntry(
  engine: AuthorityEngineKind | string,
  files: readonly { readonly logicalPath: string }[],
  nativeSessionId: string | null | undefined,
  relocate?: (logicalPath: string) => string,
): string | null {
  for (const entry of files) {
    if (!isLogicalPathOwnedByNativeSession(engine, entry.logicalPath, nativeSessionId)) {
      return entry.logicalPath
    }
    if (relocate) {
      const dest = relocate(entry.logicalPath)
      if (!isLogicalPathOwnedByNativeSession(engine, dest, nativeSessionId)) {
        return dest
      }
    }
  }
  return null
}

export function checkImportNativeSessionOwnership(
  manifest: {
    readonly engine: AuthorityEngineKind | string
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
  const unowned = findUnownedCapsuleEntry(manifest.engine, manifest.files, ownerId, relocate)
  return unowned ? `capsule_file_ownership_unverified:${unowned}` : null
}
