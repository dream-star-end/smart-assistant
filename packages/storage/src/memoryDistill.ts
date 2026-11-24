/**
 * Reversible single-file oversized Core memory distillation primitive (OCV5-883).
 *
 * Uses Copy-Verify-Manifest-AtomicRename under `MemoryDir` exclusive lock:
 *   1. Keep live `memory/<file>` untouched in place while copying exact bytes
 *      into `memory-archive/batches/<batchId>/<entryId>__<file>` (0600 temp+rename)
 *      and re-reading the archived carrier to verify `bytes` & `sha256`.
 *   2. Atomically write `memory-archive/archive-manifest.json` (0600) with both
 *      `entries` and `mergedArtifacts` (`{ batchId, targetFile, targetSha256, sourceFiles }`),
 *      so existing `restoreArchivedMemories(agentDir, { batchId })` supports
 *      100% lossless undo (preserving user edits in `preservedEditedFiles`).
 *   3. Atomically replace `memory/<file>` with the distilled hot summary via
 *      `atomicWriteFile0600` (temp+rename), guaranteeing lock-free readers NEVER
 *      observe an `ENOENT` hole or partial write at any crash point.
 *
 * Security & durability invariants:
 * - B1: Archive-first immutable carrier + verified copy + manifest `mergedArtifacts`
 *   hash proof + zero-hole atomic rename replacement.
 * - B6: Existing `archive-manifest.json` is strictly validated; malformed /
 *   unreadable / unrecognized-version manifests fail closed (`corrupt_archive_manifest`)
 *   before any filesystem mutation.
 * - B8: Verifies `expectedSourceSha256` under `withExclusiveMemoryLock`.
 * - B9: Preserves valid `expires` TTL without ever extending it; fails closed
 *   on malformed `expires`.
 * - B10: Scans rendered hot summary with `scanMemoryContent` before any write.
 * - B11: Verifies `agentDir` / `memory/` / `memory-archive/` boundaries and
 *   non-symlink source/manifest files BEFORE any filesystem mutation.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { isForbiddenAutoMemoryTarget } from './autoMemoryWrite.js'
import type { ArchivedMemoryEntry, MergedBatchArtifact } from './contextArchive.js'
import {
  createMemoryDirForAgentDir,
  MEMORY_SOFT_WARN_BYTES,
  MemoryBoundaryError,
} from './memoryDir.js'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { scanMemoryContent } from './memoryShared.js'
import { parseMemoryExpires } from './memoryTtl.js'

export const MAX_DISTILLED_MEMORY_BYTES = 8 * 1024

export interface ApplyOversizedMemoryDistillInput {
  agentDir: string
  file: string
  expectedSourceSha256: string
  distilledTitle: string
  distilledDescription: string
  distilledType: 'user' | 'feedback' | 'project' | 'reference'
  distilledContent: string
  reason?: string
  batchId?: string
  actor?: string
  /** Test-only fault-injection hook for verifying atomic rollback invariants under persistent I/O errors (e.g. ENOSPC). */
  _testOnStage?: (stage: 'before_live_replace' | 'before_manifest_rollback') => void
}

export interface ApplyOversizedMemoryDistillResult {
  ok: boolean
  batchId: string
  file: string
  reason?: string
  archivedEntry?: ArchivedMemoryEntry
  targetSha256?: string
  beforeBytes: number
  afterBytes: number
  bytesSaved: number
}

interface MemoryArchiveManifest {
  schemaVersion: 1
  entries: ArchivedMemoryEntry[]
  mergedArtifacts?: MergedBatchArtifact[]
}

const MANIFEST_FILE = 'archive-manifest.json'
const BATCHES_DIR = 'batches'
const SAFE_BATCH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i
const VALID_MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeBatchId(raw?: string): string {
  const trimmed = raw?.trim()
  if (trimmed && SAFE_BATCH_ID_RE.test(trimmed)) return trimmed
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  return `distill-${ts}-${randomUUID().slice(0, 8)}`
}

function normalizeDistillTargetFile(raw: string): string | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  const file = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
  if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) return null
  if (isForbiddenAutoMemoryTarget(file)) return null
  if (/^claude\.md$/i.test(file) || /^soul\.md$/i.test(file) || /^memory\.md$/i.test(file)) {
    return null
  }
  return file
}

function sanitizeSingleLineHeader(raw: string, maxChars: number): string {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

async function verifySafeSubdirWithinRoot(
  rootDir: string,
  targetDir: string,
  opts?: { create?: boolean },
): Promise<{ ok: true; realDir: string } | { ok: false; reason: string }> {
  const rootResolved = resolve(rootDir)
  const targetResolved = resolve(targetDir)
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + sep)) {
    return { ok: false, reason: 'outside_trusted_root' }
  }
  if (!existsSync(rootResolved)) {
    if (!opts?.create) return { ok: false, reason: 'root_missing' }
    await mkdir(rootResolved, { recursive: true, mode: 0o700 })
  }
  let realRoot: string
  try {
    const rootStat = await lstat(rootResolved)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: 'root_not_dir' }
    }
    realRoot = await realpath(rootResolved)
  } catch {
    return { ok: false, reason: 'root_unreadable' }
  }

  const rel = relative(rootResolved, targetResolved)
  if (!rel) return { ok: true, realDir: realRoot }
  const segments = rel.split(sep).filter(Boolean)
  let cur = rootResolved
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, reason: 'invalid_segment' }
    cur = join(cur, seg)
    let st
    try {
      st = await lstat(cur)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return { ok: false, reason: 'unreadable_dir' }
      }
      if (!opts?.create) return { ok: false, reason: 'missing_dir' }
      try {
        await mkdir(cur, { mode: 0o700 })
        st = await lstat(cur)
      } catch {
        return { ok: false, reason: 'unreadable_dir' }
      }
    }
    try {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { ok: false, reason: 'symlink_or_not_dir' }
      }
      const realCur = await realpath(cur)
      if (realCur !== realRoot && !realCur.startsWith(realRoot + sep)) {
        return { ok: false, reason: 'root_escape' }
      }
    } catch {
      return { ok: false, reason: 'unreadable_dir' }
    }
  }
  return { ok: true, realDir: await realpath(cur) }
}

async function atomicWriteFile0600(fullPath: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 })
  const tmp = `${fullPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, content, { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, fullPath)
    await chmod(fullPath, 0o600).catch(() => {})
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function writeVerifiedArchiveCarrier(
  rawBuf: Buffer,
  expectedBytes: number,
  expectedSha256: string,
  dstPath: string,
): Promise<{ ok: true } | { ok: false }> {
  if (existsSync(dstPath)) {
    return { ok: false }
  }
  try {
    await atomicWriteFile0600(dstPath, rawBuf)
    const st = await lstat(dstPath)
    if (st.isSymbolicLink() || !st.isFile()) {
      await rm(dstPath, { force: true }).catch(() => {})
      return { ok: false }
    }
    const verifiedBuf = await readFile(dstPath)
    if (
      verifiedBuf.byteLength !== expectedBytes ||
      sha256Hex(verifiedBuf) !== expectedSha256
    ) {
      await rm(dstPath, { force: true }).catch(() => {})
      return { ok: false }
    }
    return { ok: true }
  } catch {
    await rm(dstPath, { force: true }).catch(() => {})
    return { ok: false }
  }
}

function isValidArchivedMemoryEntry(e: unknown): e is ArchivedMemoryEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  const rec = e as Record<string, unknown>
  return (
    typeof rec.id === 'string' &&
    rec.id.length > 0 &&
    typeof rec.batchId === 'string' &&
    rec.batchId.length > 0 &&
    typeof rec.file === 'string' &&
    MEMORY_FILE_RE.test(rec.file) &&
    basename(rec.file) === rec.file &&
    typeof rec.archivedRelPath === 'string' &&
    rec.archivedRelPath.length > 0
  )
}

function isValidMergedBatchArtifact(a: unknown): a is MergedBatchArtifact {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false
  const rec = a as Record<string, unknown>
  return (
    typeof rec.batchId === 'string' &&
    rec.batchId.length > 0 &&
    typeof rec.targetFile === 'string' &&
    MEMORY_FILE_RE.test(rec.targetFile) &&
    basename(rec.targetFile) === rec.targetFile &&
    typeof rec.targetSha256 === 'string' &&
    SHA256_HEX_RE.test(rec.targetSha256) &&
    Array.isArray(rec.sourceFiles) &&
    rec.sourceFiles.every((f) => typeof f === 'string' && MEMORY_FILE_RE.test(f))
  )
}

/**
 * Strictly read `memory-archive/archive-manifest.json` (fail-closed on any
 * corruption, unrecognized schemaVersion, read failure, or malformed entries).
 * Initializes an empty manifest ONLY when the file does not exist (`ENOENT`).
 */
async function readManifestDataStrict(
  archiveRoot: string,
): Promise<
  | { ok: true; existed: boolean; entries: ArchivedMemoryEntry[]; mergedArtifacts: MergedBatchArtifact[] }
  | { ok: false; reason: 'corrupt_archive_manifest' | 'unsafe_directory_boundary' }
> {
  const manifestPath = join(archiveRoot, MANIFEST_FILE)
  let st
  try {
    st = await lstat(manifestPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: true, existed: false, entries: [], mergedArtifacts: [] }
    }
    return { ok: false, reason: 'corrupt_archive_manifest' }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: 'unsafe_directory_boundary' }
  }
  try {
    const realRoot = await realpath(archiveRoot)
    const realManifest = await realpath(manifestPath)
    if (!realManifest.startsWith(realRoot + sep)) {
      return { ok: false, reason: 'unsafe_directory_boundary' }
    }
    const raw = await readFile(realManifest, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'corrupt_archive_manifest' }
    }
    const doc = parsed as Partial<MemoryArchiveManifest>
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.entries)) {
      return { ok: false, reason: 'corrupt_archive_manifest' }
    }
    if (!doc.entries.every(isValidArchivedMemoryEntry)) {
      return { ok: false, reason: 'corrupt_archive_manifest' }
    }
    if (doc.mergedArtifacts !== undefined) {
      if (
        !Array.isArray(doc.mergedArtifacts) ||
        !doc.mergedArtifacts.every(isValidMergedBatchArtifact)
      ) {
        return { ok: false, reason: 'corrupt_archive_manifest' }
      }
    }
    return {
      ok: true,
      existed: true,
      entries: doc.entries,
      mergedArtifacts: doc.mergedArtifacts ?? [],
    }
  } catch {
    return { ok: false, reason: 'corrupt_archive_manifest' }
  }
}

async function writeManifestData(
  archiveRoot: string,
  entries: ArchivedMemoryEntry[],
  mergedArtifacts: MergedBatchArtifact[],
): Promise<void> {
  const payload: MemoryArchiveManifest = {
    schemaVersion: 1,
    entries,
    ...(mergedArtifacts.length > 0 ? { mergedArtifacts } : {}),
  }
  await atomicWriteFile0600(
    join(archiveRoot, MANIFEST_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
  )
}

function failResult(
  batchId: string,
  file: string,
  reason: string,
  beforeBytes = 0,
  afterBytes = beforeBytes,
): ApplyOversizedMemoryDistillResult {
  return {
    ok: false,
    batchId,
    file,
    reason,
    beforeBytes,
    afterBytes,
    bytesSaved: 0,
  }
}

/**
 * Losslessly archive a single oversized Core memory file and atomically replace
 * it with a concise distilled hot summary under `MemoryDir` exclusive lock.
 */
export async function applyOversizedMemoryDistill(
  input: ApplyOversizedMemoryDistillInput,
): Promise<ApplyOversizedMemoryDistillResult> {
  const batchId = normalizeBatchId(input.batchId)
  const actor = (input.actor ?? 'auto-dream:oversized-distill').trim() || 'auto-dream:oversized-distill'
  const reason =
    sanitizeSingleLineHeader(input.reason || 'oversized_memory_distill', 200) ||
    'oversized_memory_distill'

  const file = normalizeDistillTargetFile(input.file)
  if (!file) {
    return failResult(batchId, String(input.file ?? '').trim(), 'invalid_file')
  }

  const expectedSha =
    typeof input.expectedSourceSha256 === 'string' ? input.expectedSourceSha256.trim().toLowerCase() : ''
  if (!SHA256_HEX_RE.test(expectedSha)) {
    return failResult(batchId, file, 'invalid_expected_sha256')
  }

  if (!VALID_MEMORY_TYPES.has(input.distilledType)) {
    return failResult(batchId, file, 'invalid_type')
  }

  const title = sanitizeSingleLineHeader(input.distilledTitle, 120)
  const description = sanitizeSingleLineHeader(input.distilledDescription, 240)
  const body = String(input.distilledContent ?? '').replace(/\r\n/g, '\n').trim()
  if (!title || !description || !body) {
    return failResult(batchId, file, 'empty_distilled_fields')
  }

  const memdir = createMemoryDirForAgentDir(input.agentDir)
  const archiveRoot = join(resolve(input.agentDir), 'memory-archive')

  try {
    return await memdir.withExclusiveMemoryLock(
      async ({ dirPath, reconcileIndex, compactIndexIfNeeded }) => {
        // B11: Verify memory/ boundary before reading source
        const memDirCheck = await verifySafeSubdirWithinRoot(input.agentDir, dirPath)
        if (!memDirCheck.ok) {
          return failResult(
            batchId,
            file,
            memDirCheck.reason === 'missing_dir' ? 'source_not_found' : 'unsafe_directory_boundary',
          )
        }
        const realMemDir = memDirCheck.realDir
        const srcPath = join(realMemDir, file)

        let srcStat
        try {
          srcStat = await lstat(srcPath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return failResult(batchId, file, 'source_not_found')
          }
          return failResult(batchId, file, 'unsafe_source_file')
        }
        if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
          return failResult(batchId, file, 'unsafe_source_file')
        }
        const realSrc = await realpath(srcPath)
        if (!realSrc.startsWith(realMemDir + sep)) {
          return failResult(batchId, file, 'unsafe_source_file')
        }

        const rawBuf = await readFile(realSrc)
        const beforeBytes = rawBuf.byteLength
        const actualSourceSha256 = sha256Hex(rawBuf)

        // B8: In-lock CAS verification
        if (actualSourceSha256 !== expectedSha) {
          return failResult(batchId, file, 'source_version_mismatch', beforeBytes, beforeBytes)
        }

        // B9: Preserve valid expires TTL without ever extending it; fail-closed on invalid expires
        const rawText = rawBuf.toString('utf8')
        const { fm } = parseMemoryFrontmatter(rawText)
        const rawExp = fm.expires?.trim()
        let preservedExpires: string | undefined
        if (rawExp) {
          const parsedExp = parseMemoryExpires(rawExp)
          if (!parsedExp) {
            return failResult(batchId, file, 'invalid_source_expires', beforeBytes, beforeBytes)
          }
          preservedExpires = parsedExp
        }

        const entryId = `mem-${randomUUID().slice(0, 12)}`
        const carrierName = `${entryId}__${file}`
        const archivedRelPath = `memory-archive/${BATCHES_DIR}/${batchId}/${carrierName}`

        const headerLines = [
          '---',
          `name: ${title}`,
          `description: ${description}`,
          `type: ${input.distilledType}`,
          'source: auto-distill',
          ...(preservedExpires ? [`expires: ${preservedExpires}`] : []),
          `distill_batch: ${batchId}`,
          `distilled_from: ${archivedRelPath}`,
          '---',
        ]
        const rendered = `${headerLines.join('\n')}\n${body}\n`
        const afterBytes = Buffer.byteLength(rendered, 'utf8')

        // B10: Scan complete rendered hot summary before any disk mutation
        if (!scanMemoryContent(rendered).ok) {
          return failResult(batchId, file, 'unsafe_content', beforeBytes, beforeBytes)
        }
        if (afterBytes > MAX_DISTILLED_MEMORY_BYTES) {
          return failResult(batchId, file, 'distilled_too_large', beforeBytes, afterBytes)
        }
        if (afterBytes >= beforeBytes) {
          return failResult(batchId, file, 'distilled_not_smaller', beforeBytes, afterBytes)
        }

        // B6: Strictly read & validate existing archive-manifest.json BEFORE creating batch dir or writing anything
        const existingArchCheck = await verifySafeSubdirWithinRoot(input.agentDir, archiveRoot)
        if (!existingArchCheck.ok && existingArchCheck.reason !== 'missing_dir') {
          return failResult(batchId, file, 'unsafe_directory_boundary', beforeBytes, beforeBytes)
        }
        const manifestResult = existingArchCheck.ok
          ? await readManifestDataStrict(existingArchCheck.realDir)
          : ({ ok: true as const, existed: false, entries: [], mergedArtifacts: [] })
        if (!manifestResult.ok) {
          return failResult(batchId, file, manifestResult.reason, beforeBytes, beforeBytes)
        }

        // B11: Validate/create archive batch directory only after ALL preconditions & manifest checks pass
        const batchDirCheck = await verifySafeSubdirWithinRoot(
          input.agentDir,
          join(archiveRoot, BATCHES_DIR, batchId),
          { create: true },
        )
        if (!batchDirCheck.ok) {
          return failResult(batchId, file, 'unsafe_directory_boundary', beforeBytes, beforeBytes)
        }

        const prevEntries = [...manifestResult.entries]
        const prevArtifacts = [...manifestResult.mergedArtifacts]
        const dstPath = join(batchDirCheck.realDir, carrierName)
        const nowIso = new Date().toISOString()

        // B7 Step 1 (Copy-Verify): Write archived carrier (0600 temp+rename) and verify exact bytes & sha256
        // while keeping live `memory/<file>` completely untouched in place!
        const copied = await writeVerifiedArchiveCarrier(
          rawBuf,
          beforeBytes,
          actualSourceSha256,
          dstPath,
        )
        if (!copied.ok) {
          return failResult(batchId, file, 'archive_verify_failed', beforeBytes, beforeBytes)
        }

        const archivedEntry: ArchivedMemoryEntry = {
          id: entryId,
          batchId,
          slug: file.replace(/\.md$/i, ''),
          file,
          originalRelPath: `memory/${file}`,
          archivedRelPath,
          archivedAt: nowIso,
          reason,
          actor,
          bytes: beforeBytes,
          sourceSha256: actualSourceSha256,
          ...(fm.name ? { title: fm.name } : {}),
          ...(fm.type ? { type: fm.type } : {}),
        }
        const targetSha256 = sha256Hex(rendered)
        const artifact: MergedBatchArtifact = {
          batchId,
          targetFile: file,
          targetSha256,
          sourceFiles: [file],
          createdAt: nowIso,
        }

        // B7 Step 2 (Manifest): Atomically commit updated manifest BEFORE replacing live file
        let manifestWritten = false
        try {
          await writeManifestData(
            archiveRoot,
            [...prevEntries, archivedEntry],
            [...prevArtifacts, artifact],
          )
          manifestWritten = true
          // B7 Step 3 (AtomicRename): Single atomic temp+rename replaces live `memory/<file>` with zero ENOENT window
          input._testOnStage?.('before_live_replace')
          await atomicWriteFile0600(realSrc, rendered)
        } catch (err) {
          // Live `memory/<file>` remained intact before rename; clean up uncommitted manifest/carrier if live wasn't replaced
          const liveNowSha = await readFile(realSrc)
            .then((buf) => sha256Hex(buf))
            .catch(() => null)
          if (liveNowSha === actualSourceSha256) {
            let manifestReverted = !manifestWritten
            if (manifestWritten) {
              try {
                input._testOnStage?.('before_manifest_rollback')
                if (manifestResult.existed) {
                  await writeManifestData(archiveRoot, prevEntries, prevArtifacts)
                } else {
                  await rm(join(archiveRoot, MANIFEST_FILE), { force: true })
                }
                manifestReverted = true
              } catch {
                // Keep the verified archived carrier on disk if manifest rollback also fails
                // (e.g. persistent ENOSPC), so shared-batch restoreArchivedMemories({ batchId })
                // never encounters a dangling manifest entry (`batch_archive_corrupted`).
                manifestReverted = false
              }
            }
            if (manifestReverted) {
              await rm(dstPath, { force: true }).catch(() => {})
            }
          }
          return failResult(
            batchId,
            file,
            `write_failed: ${err instanceof Error ? err.message : String(err)}`,
            beforeBytes,
            beforeBytes,
          )
        }

        const indexText = await reconcileIndex()
        const indexHasOversizedLine = indexText
          .split('\n')
          .some((l) => l.trim().length > 150)
        if (
          Buffer.byteLength(indexText, 'utf8') > MEMORY_SOFT_WARN_BYTES ||
          indexHasOversizedLine
        ) {
          await compactIndexIfNeeded({ maxBytes: MEMORY_SOFT_WARN_BYTES })
        }

        return {
          ok: true,
          batchId,
          file,
          archivedEntry,
          targetSha256,
          beforeBytes,
          afterBytes,
          bytesSaved: Math.max(0, beforeBytes - afterBytes),
        }
      },
      { checkDirs: [archiveRoot] },
    )
  } catch (err) {
    if (err instanceof MemoryBoundaryError) {
      return failResult(batchId, file, 'unsafe_directory_boundary')
    }
    throw err
  }
}
