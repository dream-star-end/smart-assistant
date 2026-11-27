/**
 * Trusted container-side media materializer for `remote-driver-v4` turns (B02).
 *
 * Security invariants:
 * - Source-container filesystem paths are NEVER forwarded raw to remote drivers
 *   (`cc.py` rejects `path` with `CC_CONTENT_INVALID`; `codex.py` misinterprets `path`
 *   as a remote-host `localImage`).
 * - Every `path` image block is validated against explicit or container-scoped
 *   `trustedMediaRoots` BEFORE turn admission/dispatch:
 *     1. Rejects relative paths, NUL bytes, backslashes, and `..` traversal segments.
 *     2. Rejects any candidate root that is itself a symbolic link (or traverses a
 *        symbolic link ancestor), pins the root directory `(dev, ino)` with an
 *        `O_DIRECTORY | O_NOFOLLOW` handle, and verifies root identity before and
 *        after opening the target file.
 *     3. Walks every path segment under the matched root with `lstatSync`, rejecting
 *        any symbolic link (file or intermediate directory) to prevent symlink escape.
 *     4. Opens the target file with `O_RDONLY | O_NOFOLLOW` and checks `fstatSync`
 *        inode/dev match against `lstatSync` (TOCTOU protection) plus strict size bounds.
 *     5. For `path` inputs, sniffs actual image magic bytes (PNG/JPEG/GIF/WebP) and
 *        verifies declared MIME compatibility before encoding to inline base64 `data`
 *        and stripping `path`. (Inline `data` and `blobResolver` branches validate MIME
 *        syntax and payload size bounds.)
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RemoteDriverTurnContentBlock } from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { remotePoolNeed } from './types.js'

export const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024

const MAX_IMAGE_PATH_LENGTH = 4096
const CONTENT_MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const DEFAULT_OPENCLAUDE_HOME = '/home/agent/.openclaude'
const DEFAULT_TRUSTED_HOME_SUBDIRS = ['workspace', 'uploads', 'generated', 'media', 'attachments'] as const

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ResolveTrustedMediaRootsInput {
  readonly trustedMediaRoots?: readonly string[]
  readonly agentBaseDir?: string
  readonly promptCwd?: string
  readonly repoWorkspaceDir?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface MaterializeImagePathOptions {
  readonly trustedMediaRoots: readonly string[]
  readonly maxImageBytes?: number
  readonly declaredMimeType?: string
  readonly enforceDeclaredMimeMatch?: boolean
}

export interface MaterializeTurnContentOptions {
  readonly trustedMediaRoots: readonly string[]
  readonly maxImageBytes?: number
  readonly blobResolver?: (
    blobId: string,
  ) => Promise<{ readonly mimeType: string; readonly data: string }>
  readonly isInferredMimeBlock?: (block: RemoteDriverTurnContentBlock) => boolean
}

export function normalizeDeclaredImageMime(raw: string): string {
  const lowered = raw.trim().toLowerCase()
  return lowered === 'image/jpg' ? 'image/jpeg' : lowered
}

export function inferImageMimeFromPath(filePath: string): SupportedImageMime {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

export function sniffSupportedImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

interface PinnedTrustedRoot {
  readonly configured: string
  readonly real: string
  readonly dev: number
  readonly ino: number
}

function isValidCandidateRootPath(candidate: string): boolean {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > MAX_IMAGE_PATH_LENGTH ||
    candidate.includes('\u0000') ||
    candidate.includes('\\') ||
    !isAbsolute(candidate)
  ) {
    return false
  }
  return !candidate.split('/').includes('..')
}

function relativeInsideRoot(root: string, candidate: string): string | null {
  const rel = relative(root, candidate)
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  return rel
}

/**
 * Verifies that `candidate` is an existing real directory whose path contains NO symbolic link
 * components (neither on the directory itself nor on any ancestor component), then pins its
 * `(dev, ino)` via `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`. Never follows symlinks to whitelist
 * an out-of-scope target directory.
 */
function inspectPinnedTrustedRoot(candidate: string): PinnedTrustedRoot | null {
  if (!isValidCandidateRootPath(candidate)) return null
  const configured = resolve(candidate)
  if (configured === '/') return null

  const segments = configured.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null

  let cursor = '/'
  let leafStat: Stats | undefined
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    if (seg === '.' || seg === '..') return null
    cursor = join(cursor, seg)
    let st: Stats
    try {
      st = lstatSync(cursor)
    } catch {
      return null
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return null
    }
    if (i === segments.length - 1) {
      leafStat = st
    }
  }
  if (!leafStat) return null

  let fd: number | undefined
  try {
    fd = openSync(configured, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const meta = fstatSync(fd)
    if (!meta.isDirectory() || meta.dev !== leafStat.dev || meta.ino !== leafStat.ino) {
      return null
    }
    const real = realpathSync(configured)
    if (real === '/' || real !== configured) {
      return null
    }
    return {
      configured,
      real,
      dev: meta.dev,
      ino: meta.ino,
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Verifies an auto-discovered `${baseHome}/<subdir>` root: `baseHome` itself must not be a
 * symlink, every segment from `baseHome` to `<subdir>` must be a real directory (no symlinks),
 * and `realpathSync(subdir)` must remain strictly inside `realpathSync(baseHome)`.
 */
function resolveSafeHomeSubdirRoot(baseHome: string, subdir: string): string | null {
  const pinnedBase = inspectPinnedTrustedRoot(baseHome)
  if (!pinnedBase) return null
  if (!subdir || subdir.includes('/') || subdir.includes('\\') || subdir === '.' || subdir === '..') {
    return null
  }
  const candidate = join(pinnedBase.configured, subdir)
  const pinnedSub = inspectPinnedTrustedRoot(candidate)
  if (!pinnedSub) return null
  if (relativeInsideRoot(pinnedBase.real, pinnedSub.real) === null) {
    return null
  }
  return pinnedSub.configured
}

export function resolveTrustedMediaRoots(input: ResolveTrustedMediaRootsInput): readonly string[] {
  const rawCandidates: string[] = []
  if (input.trustedMediaRoots !== undefined) {
    for (const root of input.trustedMediaRoots) {
      if (typeof root === 'string' && root.trim().length > 0) {
        rawCandidates.push(root.trim())
      }
    }
  } else {
    for (const candidate of [input.agentBaseDir, input.promptCwd, input.repoWorkspaceDir]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const pinned = inspectPinnedTrustedRoot(candidate.trim())
        if (pinned) {
          rawCandidates.push(pinned.configured)
        }
      }
    }
    const envHome = input.env?.OPENCLAUDE_HOME?.trim() || paths.home
    const baseHome = envHome && isAbsolute(envHome) ? envHome : DEFAULT_OPENCLAUDE_HOME
    if (inspectPinnedTrustedRoot(baseHome) !== null) {
      for (const sub of DEFAULT_TRUSTED_HOME_SUBDIRS) {
        const safeSub = resolveSafeHomeSubdirRoot(baseHome, sub)
        if (safeSub !== null) {
          rawCandidates.push(safeSub)
        }
      }
    }
  }

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const candidate of rawCandidates) {
    if (!isValidCandidateRootPath(candidate)) continue
    const normalized = resolve(candidate)
    if (normalized === '/' || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
  }
  return deduped
}

function resolveExistingTrustedRoots(roots: readonly string[]): PinnedTrustedRoot[] {
  const resolved: PinnedTrustedRoot[] = []
  for (const root of roots) {
    const pinned = inspectPinnedTrustedRoot(root)
    if (pinned) {
      resolved.push(pinned)
    }
  }
  return resolved
}

export function materializeTrustedImagePath(
  rawPath: string,
  options: MaterializeImagePathOptions,
): { readonly type: 'image'; readonly mimeType: SupportedImageMime; readonly data: string } {
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  remotePoolNeed(
    Number.isSafeInteger(maxBytes) && maxBytes > 0,
    'REMOTE_IMAGE_PAYLOAD_TOO_LARGE',
  )
  remotePoolNeed(
    typeof rawPath === 'string' &&
      rawPath.length > 0 &&
      rawPath.length <= MAX_IMAGE_PATH_LENGTH &&
      !rawPath.includes('\u0000') &&
      !rawPath.includes('\\'),
    'REMOTE_IMAGE_PATH_INVALID',
  )
  remotePoolNeed(isAbsolute(rawPath), 'REMOTE_IMAGE_PATH_UNTRUSTED')
  const rawSegments = rawPath.split('/')
  remotePoolNeed(!rawSegments.includes('..'), 'REMOTE_IMAGE_PATH_TRAVERSAL')

  const roots = resolveExistingTrustedRoots(options.trustedMediaRoots)
  remotePoolNeed(roots.length > 0, 'REMOTE_IMAGE_PATH_UNTRUSTED')

  const normalizedInput = resolve(rawPath)
  let matchedRoot: PinnedTrustedRoot | undefined
  let matchedRel: string | undefined
  for (const entry of roots) {
    const relFromConfigured = relativeInsideRoot(entry.configured, normalizedInput)
    if (relFromConfigured !== null) {
      matchedRoot = entry
      matchedRel = relFromConfigured
      break
    }
  }
  remotePoolNeed(
    matchedRoot !== undefined && matchedRel !== undefined,
    'REMOTE_IMAGE_PATH_UNTRUSTED',
  )

  const segments = matchedRel.split('/').filter((s) => s.length > 0)
  remotePoolNeed(segments.length > 0, 'REMOTE_IMAGE_PATH_UNTRUSTED')

  let rawBytes: Buffer
  let pinnedRootFd: number | undefined
  let fd: number | undefined
  try {
    // Pin the authorized root directory handle and confirm its (dev, ino) before walking/opening.
    pinnedRootFd = openSync(
      matchedRoot.configured,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const preRootFdMeta = fstatSync(pinnedRootFd)
    remotePoolNeed(
      preRootFdMeta.isDirectory() &&
        preRootFdMeta.dev === matchedRoot.dev &&
        preRootFdMeta.ino === matchedRoot.ino,
      'REMOTE_IMAGE_PATH_UNTRUSTED',
    )

    // Walk every component beneath the pinned root using lstatSync to block any symlink escape.
    let cursor = matchedRoot.configured
    let targetStat: Stats | undefined
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!
      remotePoolNeed(seg !== '.' && seg !== '..', 'REMOTE_IMAGE_PATH_TRAVERSAL')
      cursor = join(cursor, seg)
      let st: Stats
      try {
        st = lstatSync(cursor)
      } catch {
        throw new Error('REMOTE_IMAGE_PATH_UNREADABLE')
      }
      remotePoolNeed(!st.isSymbolicLink(), 'REMOTE_IMAGE_PATH_SYMLINK_FORBIDDEN')
      if (i < segments.length - 1) {
        remotePoolNeed(st.isDirectory(), 'REMOTE_IMAGE_PATH_UNREADABLE')
      } else {
        remotePoolNeed(st.isFile(), 'REMOTE_IMAGE_PATH_UNREADABLE')
        targetStat = st
      }
    }

    let realTarget: string
    try {
      realTarget = realpathSync(cursor)
    } catch {
      throw new Error('REMOTE_IMAGE_PATH_UNREADABLE')
    }
    remotePoolNeed(
      relativeInsideRoot(matchedRoot.real, realTarget) !== null,
      'REMOTE_IMAGE_PATH_UNTRUSTED',
    )

    // Re-check root (dev, ino) immediately before opening target file.
    const preOpenRootStat = lstatSync(matchedRoot.configured)
    remotePoolNeed(
      !preOpenRootStat.isSymbolicLink() &&
        preOpenRootStat.isDirectory() &&
        preOpenRootStat.dev === matchedRoot.dev &&
        preOpenRootStat.ino === matchedRoot.ino,
      'REMOTE_IMAGE_PATH_UNTRUSTED',
    )

    fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW)
    const meta = fstatSync(fd)
    remotePoolNeed(
      meta.isFile() &&
        targetStat !== undefined &&
        meta.ino === targetStat.ino &&
        meta.dev === targetStat.dev,
      'REMOTE_IMAGE_PATH_UNREADABLE',
    )

    // Re-verify root (dev, ino) and containment AFTER opening target file to defeat root swaps.
    const postOpenRootStat = lstatSync(matchedRoot.configured)
    const postOpenRootFdMeta = fstatSync(pinnedRootFd)
    remotePoolNeed(
      !postOpenRootStat.isSymbolicLink() &&
        postOpenRootStat.isDirectory() &&
        postOpenRootStat.dev === matchedRoot.dev &&
        postOpenRootStat.ino === matchedRoot.ino &&
        postOpenRootFdMeta.dev === matchedRoot.dev &&
        postOpenRootFdMeta.ino === matchedRoot.ino,
      'REMOTE_IMAGE_PATH_UNTRUSTED',
    )
    const postRealTarget = realpathSync(cursor)
    remotePoolNeed(
      relativeInsideRoot(matchedRoot.real, postRealTarget) !== null,
      'REMOTE_IMAGE_PATH_UNTRUSTED',
    )

    remotePoolNeed(meta.size > 0, 'REMOTE_IMAGE_INVALID_FORMAT')
    const estimatedBase64Bytes = Math.ceil(meta.size / 3) * 4
    remotePoolNeed(
      meta.size <= maxBytes && estimatedBase64Bytes <= maxBytes,
      'REMOTE_IMAGE_PAYLOAD_TOO_LARGE',
    )
    rawBytes = readFileSync(fd)
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE' ||
        err.message === 'REMOTE_IMAGE_INVALID_FORMAT' ||
        err.message === 'REMOTE_IMAGE_PATH_UNREADABLE' ||
        err.message === 'REMOTE_IMAGE_PATH_UNTRUSTED' ||
        err.message === 'REMOTE_IMAGE_PATH_TRAVERSAL' ||
        err.message === 'REMOTE_IMAGE_PATH_SYMLINK_FORBIDDEN')
    ) {
      throw err
    }
    throw new Error('REMOTE_IMAGE_PATH_UNREADABLE')
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close errors.
      }
    }
    if (pinnedRootFd !== undefined) {
      try {
        closeSync(pinnedRootFd)
      } catch {
        // Ignore close errors.
      }
    }
  }

  remotePoolNeed(rawBytes.length > 0, 'REMOTE_IMAGE_INVALID_FORMAT')
  remotePoolNeed(rawBytes.length <= maxBytes, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')

  const sniffedMime = sniffSupportedImageMime(rawBytes)
  remotePoolNeed(sniffedMime !== null, 'REMOTE_IMAGE_INVALID_FORMAT')

  if (options.declaredMimeType !== undefined) {
    const normalizedDeclared = normalizeDeclaredImageMime(options.declaredMimeType)
    remotePoolNeed(
      SUPPORTED_IMAGE_MIMES.has(normalizedDeclared),
      'REMOTE_IMAGE_INVALID_FORMAT',
    )
    if (options.enforceDeclaredMimeMatch !== false) {
      remotePoolNeed(normalizedDeclared === sniffedMime, 'REMOTE_IMAGE_MIME_MISMATCH')
    }
  }

  const data = rawBytes.toString('base64')
  remotePoolNeed(Buffer.byteLength(data, 'utf8') <= maxBytes, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')

  return {
    type: 'image',
    mimeType: sniffedMime,
    data,
  }
}

export async function materializeRemoteTurnContentBlocks(
  blocks: readonly RemoteDriverTurnContentBlock[],
  options: MaterializeTurnContentOptions,
): Promise<RemoteDriverTurnContentBlock[]> {
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  let totalImageBytes = 0
  const out: RemoteDriverTurnContentBlock[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text })
      continue
    }

    if (typeof block.data === 'string' && block.data.length > 0) {
      remotePoolNeed(
        typeof block.mimeType === 'string' &&
          block.mimeType.length <= 128 &&
          CONTENT_MIME_RE.test(block.mimeType) &&
          !block.data.includes('\u0000'),
        'REMOTE_CONTENT_BLOCK_INVALID',
      )
      totalImageBytes += Buffer.byteLength(block.data, 'utf8')
      remotePoolNeed(totalImageBytes <= maxBytes, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')
      out.push({ type: 'image', mimeType: block.mimeType, data: block.data })
      continue
    }

    if (typeof block.path === 'string' && block.path.length > 0) {
      const remainingBytes = maxBytes - totalImageBytes
      remotePoolNeed(remainingBytes > 0, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')
      const materialized = materializeTrustedImagePath(block.path, {
        trustedMediaRoots: options.trustedMediaRoots,
        maxImageBytes: remainingBytes,
        declaredMimeType: block.mimeType,
        enforceDeclaredMimeMatch: !(options.isInferredMimeBlock?.(block) ?? false),
      })
      totalImageBytes += Buffer.byteLength(materialized.data, 'utf8')
      remotePoolNeed(totalImageBytes <= maxBytes, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')
      out.push(materialized)
      continue
    }

    if (typeof block.blobId === 'string' && block.blobId.length > 0) {
      const resolver = options.blobResolver
      remotePoolNeed(typeof resolver === 'function', 'REMOTE_IMAGE_BLOB_UNRESOLVED')
      let resolved: { readonly mimeType: string; readonly data: string } | undefined
      try {
        resolved = await resolver(block.blobId)
      } catch {
        throw new Error('REMOTE_IMAGE_BLOB_UNRESOLVED')
      }
      remotePoolNeed(
        resolved !== undefined &&
          typeof resolved.mimeType === 'string' &&
          resolved.mimeType.length > 0 &&
          resolved.mimeType.length <= 128 &&
          CONTENT_MIME_RE.test(resolved.mimeType) &&
          typeof resolved.data === 'string' &&
          resolved.data.length > 0 &&
          !resolved.data.includes('\u0000'),
        'REMOTE_IMAGE_BLOB_UNRESOLVED',
      )
      totalImageBytes += Buffer.byteLength(resolved.data, 'utf8')
      remotePoolNeed(totalImageBytes <= maxBytes, 'REMOTE_IMAGE_PAYLOAD_TOO_LARGE')
      out.push({ type: 'image', mimeType: resolved.mimeType, data: resolved.data })
      continue
    }

    throw new Error('REMOTE_IMAGE_BLOB_UNRESOLVED')
  }

  return out
}
