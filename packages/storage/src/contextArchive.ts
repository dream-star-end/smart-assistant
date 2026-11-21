/**
 * First-class reversible archive for Core memories (`memory-archive/`) and
 * user skills (`skills-archive/`), plus reversible semantic memory merge and
 * safety-scanned archived fallback search.
 *
 * Security & durability invariants:
 * - B1: Every archived item gets an immutable, non-overwritable carrier path:
 *     Core:  `memory-archive/batches/<batchId>/<entryId>__<file>`
 *     Skill: `skills-archive/batches/<batchId>/<entryId>__<name>`
 *   `applySemanticMemoryMerge` records `{ targetFile, targetSha256 }` in
 *   `archive-manifest.json`. Full-batch undo verifies all archived sources
 *   before touching live files and NEVER deletes a manually-edited merged file
 *   (preserving edits in `memory/` and reporting `preservedEditedFiles`).
 * - B2: `archiveUserSkill` & orphan/legacy scanners persist/parse effective
 *   agent visibility scope (`SKILL_AGENT_SCOPE_FILE` + frontmatter `agents`),
 *   and `searchArchivedSkills(..., { agentId })` enforces active `SkillStore`
 *   visibility rules.
 * - B8: `applySemanticMemoryMerge` validates `expectedSourceShas` under the
 *   exclusive lock and refuses to archive or overwrite an unrelated live file
 *   at `targetSlug`.
 * - B9: `applySemanticMemoryMerge` preserves `expires` TTL without ever
 *   extending retention (`min(expires)` when all sources expire; rejects mixed
 *   TTL policies).
 * - B10: `searchArchivedMemories` & `searchArchivedSkills` scan the COMPLETE
 *   file body + displayed metadata with `scanMemoryContent`; unreadable or
 *   unsafe entries are skipped completely (never degraded to metadata-only).
 * - B11: All read, write, move, and delete operations share the same trusted
 *   root + non-symlink ancestor check (`verifySafeSubdirWithinRoot`) BEFORE
 *   any filesystem mutation.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { isForbiddenAutoMemoryTarget } from './autoMemoryWrite.js'
import { createMemoryDirForAgentDir, MemoryBoundaryError } from './memoryDir.js'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { acquireFileLock, scanMemoryContent } from './memoryShared.js'
import { parseMemoryExpires } from './memoryTtl.js'
import {
  normalizeSkillAgentScope,
  normalizeSkillPriority,
  parseFrontmatter,
  resolveDefaultAgentId,
  SKILL_AGENT_SCOPE_FILE,
  validateSkillName,
} from './skillStore.js'

export interface ArchivedMemoryEntry {
  id: string
  batchId: string
  slug: string
  file: string
  originalRelPath: string
  archivedRelPath: string
  archivedAt: string
  reason: string
  actor: string
  bytes: number
  /** SHA-256 hex digest of the exact archived source bytes (B1 integrity verification). */
  sourceSha256?: string
  title?: string
  type?: string
}

export interface MergedBatchArtifact {
  batchId: string
  targetFile: string
  targetSha256: string
  sourceFiles: string[]
  createdAt: string
}

export interface ArchivedSkillEntry {
  id: string
  batchId: string
  name: string
  archivedRelPath: string
  archivedAt: string
  reason: string
  actor: string
  bytes: number
  description?: string
  /** Effective agent visibility scope inherited from active SkillStore. */
  agentIds?: string[]
}

export interface ArchiveUserSkillGuard {
  /** Reject archival under lock if live candidate priority >= maxPriorityExclusive (missing priority = 0). */
  maxPriorityExclusive?: number
  /** Require this active sibling skill to exist inside skillsDir under lock. */
  requireKeptSkillName?: string
  /** When `requireKeptSkillName` is set, require kept skill's effective agent scope to be a superset of candidate's scope. */
  checkScopeSuperset?: boolean
}

interface MemoryArchiveManifest {
  schemaVersion: 1
  entries: ArchivedMemoryEntry[]
  mergedArtifacts?: MergedBatchArtifact[]
}

interface SkillArchiveManifest {
  schemaVersion: 1
  entries: ArchivedSkillEntry[]
}

const MANIFEST_FILE = 'archive-manifest.json'
const BATCHES_DIR = 'batches'
const SAFE_BATCH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/
const MEM_CARRIER_RE = /^(mem-[a-zA-Z0-9-]{4,64})__(.+)$/
const SKILL_CARRIER_RE = /^(skill-[a-zA-Z0-9-]{4,64})__(.+)$/

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function memoryArchiveRoot(agentDir: string): string {
  return join(resolve(agentDir), 'memory-archive')
}

function skillArchiveRoot(skillsDir: string): string {
  return join(dirname(resolve(skillsDir)), 'skills-archive')
}

function normalizeBatchId(raw?: string): string {
  const trimmed = raw?.trim()
  if (trimmed && SAFE_BATCH_ID_RE.test(trimmed)) return trimmed
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  return `batch-${ts}-${randomUUID().slice(0, 8)}`
}

/**
 * Shared trusted-root + non-symlink ancestor check (B11).
 * Walks every path segment below `rootDir` down to `targetDir`, rejecting any
 * symlink or non-directory component and verifying `realpath` containment
 * inside `realpath(rootDir)`. When `opts.create` is true, missing directories
 * along the chain are created with `0700` only after all existing ancestors pass.
 */
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
    const rootStat = await stat(rootResolved)
    if (!rootStat.isDirectory()) return { ok: false, reason: 'root_not_dir' }
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

async function atomicWriteJsonFile(targetPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  const tmp = `${targetPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, targetPath)
    await chmod(targetPath, 0o600).catch(() => {})
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function moveFileSafe(src: string, dst: string): Promise<void> {
  if (existsSync(dst)) {
    throw new Error(`archive destination already exists: ${basename(dst)}`)
  }
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 })
  try {
    await rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
    await copyFile(src, dst)
    await chmod(dst, 0o600).catch(() => {})
    await rm(src, { force: true })
  }
  await chmod(dst, 0o600).catch(() => {})
}

async function moveDirSafe(src: string, dst: string): Promise<void> {
  if (existsSync(dst)) {
    throw new Error(`archive destination already exists: ${basename(dst)}`)
  }
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 })
  try {
    await rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
    await cp(src, dst, { recursive: true, verbatimSymlinks: false })
    await rm(src, { recursive: true, force: true })
  }
}

async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0
  const walk = async (cur: string, depth: number): Promise<void> => {
    if (depth > 8) return
    let entries
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(cur, entry.name)
      try {
        const st = await lstat(full)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) await walk(full, depth + 1)
        else if (st.isFile()) total += st.size
      } catch {
        // ignore transient errors
      }
    }
  }
  await walk(dirPath, 0)
  return total
}

/**
 * Strictly resolve an archived source path inside its dedicated archive root
 * (`memory-archive/` or `skills-archive/`), enforcing prefix match, no `..`,
 * non-symlink ancestors & leaf, expected entry type, and realpath containment.
 */
async function resolveArchivedSourcePath(
  archiveRoot: string,
  expectedPrefix: 'memory-archive' | 'skills-archive',
  relPath: string,
  expectedKind: 'file' | 'dir',
): Promise<string | null> {
  if (!existsSync(archiveRoot)) return null
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const prefixWithSlash = `${expectedPrefix}/`
  if (!normalized.startsWith(prefixWithSlash)) return null
  const innerRel = normalized.slice(prefixWithSlash.length)
  if (!innerRel || innerRel.includes('..') || innerRel.startsWith('/')) return null

  const rootResolved = resolve(archiveRoot)
  const lexicalTarget = resolve(rootResolved, innerRel)
  if (!lexicalTarget.startsWith(rootResolved + sep)) return null

  try {
    const rootStat = await lstat(archiveRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    const realRoot = await realpath(archiveRoot)

    // Verify every intermediate ancestor directory inside archiveRoot is not a symlink
    const parentDir = dirname(lexicalTarget)
    const parentCheck = await verifySafeSubdirWithinRoot(archiveRoot, parentDir)
    if (!parentCheck.ok) return null

    const targetStat = await lstat(lexicalTarget)
    if (targetStat.isSymbolicLink()) return null
    if (expectedKind === 'file' && !targetStat.isFile()) return null
    if (expectedKind === 'dir' && !targetStat.isDirectory()) return null

    const realTarget = await realpath(lexicalTarget)
    if (!realTarget.startsWith(realRoot + sep)) return null

    if (expectedKind === 'dir') {
      const skillMdPath = join(realTarget, 'SKILL.md')
      const mdStat = await lstat(skillMdPath)
      if (mdStat.isSymbolicLink() || !mdStat.isFile()) return null
      const realMd = await realpath(skillMdPath)
      if (!realMd.startsWith(realTarget + sep)) return null
    }
    return realTarget
  } catch {
    return null
  }
}

async function readMemoryManifestData(archiveRoot: string): Promise<{
  entries: ArchivedMemoryEntry[]
  mergedArtifacts: MergedBatchArtifact[]
}> {
  const manifestPath = join(archiveRoot, MANIFEST_FILE)
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryArchiveManifest>
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return { entries: [], mergedArtifacts: [] }
    }
    const entries = parsed.entries.filter(
      (e): e is ArchivedMemoryEntry =>
        Boolean(
          e &&
            typeof e === 'object' &&
            typeof e.id === 'string' &&
            typeof e.batchId === 'string' &&
            typeof e.file === 'string' &&
            MEMORY_FILE_RE.test(e.file) &&
            typeof e.archivedRelPath === 'string',
        ),
    )
    const mergedArtifacts = Array.isArray(parsed.mergedArtifacts)
      ? parsed.mergedArtifacts.filter(
          (a): a is MergedBatchArtifact =>
            Boolean(
              a &&
                typeof a === 'object' &&
                typeof a.batchId === 'string' &&
                typeof a.targetFile === 'string' &&
                MEMORY_FILE_RE.test(a.targetFile) &&
                typeof a.targetSha256 === 'string' &&
                /^[0-9a-f]{64}$/i.test(a.targetSha256) &&
                Array.isArray(a.sourceFiles),
            ),
        )
      : []
    return { entries, mergedArtifacts }
  } catch {
    return { entries: [], mergedArtifacts: [] }
  }
}

async function writeMemoryManifestData(
  archiveRoot: string,
  entries: ArchivedMemoryEntry[],
  mergedArtifacts: MergedBatchArtifact[],
): Promise<void> {
  await atomicWriteJsonFile(join(archiveRoot, MANIFEST_FILE), {
    schemaVersion: 1,
    entries,
    ...(mergedArtifacts.length > 0 ? { mergedArtifacts } : {}),
  } satisfies MemoryArchiveManifest)
}

async function readSkillManifest(archiveRoot: string): Promise<ArchivedSkillEntry[]> {
  const manifestPath = join(archiveRoot, MANIFEST_FILE)
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SkillArchiveManifest>
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(
      (e): e is ArchivedSkillEntry =>
        Boolean(
          e &&
            typeof e === 'object' &&
            typeof e.id === 'string' &&
            typeof e.batchId === 'string' &&
            typeof e.name === 'string' &&
            validateSkillName(e.name).ok &&
            typeof e.archivedRelPath === 'string',
        ),
    )
  } catch {
    return []
  }
}

async function writeSkillManifest(
  archiveRoot: string,
  entries: ArchivedSkillEntry[],
): Promise<void> {
  await atomicWriteJsonFile(join(archiveRoot, MANIFEST_FILE), {
    schemaVersion: 1,
    entries,
  } satisfies SkillArchiveManifest)
}

/**
 * Normalize agent visibility scope from sidecar `.openclaude-agent-scope.json`
 * or `SKILL.md` frontmatter `agents` field, preserving wildcard `*` when set
 * and falling back to active `SkillStore` default (`[resolveDefaultAgentId()]`).
 */
/**
 * Single authoritative effective agent scope resolver for shared/archived user
 * skills (B2). Strictly mirrors active `SkillStore.agentScopeForLayer(..., 'shared')`:
 *   - Reads `<skillDir>/.openclaude-agent-scope.json` (regular non-symlink file
 *     contained within `skillDir`).
 *   - Normalizes `parsed.agentIds` via `normalizeSkillAgentScope(..., [resolveDefaultAgentId()])`.
 *   - Missing, unreadable, symlinked, or invalid sidecar ALWAYS falls back to
 *     `[resolveDefaultAgentId()]` (never reads frontmatter `agents` or `'*'`).
 */
export async function resolveEffectiveSkillAgentScope(skillDirAbs: string): Promise<string[]> {
  const fallback = [resolveDefaultAgentId()]
  try {
    const dirStat = await lstat(skillDirAbs)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return fallback
    const realDir = await realpath(skillDirAbs)
    const scopePath = join(realDir, SKILL_AGENT_SCOPE_FILE)
    if (!existsSync(scopePath)) return fallback
    const st = await lstat(scopePath)
    if (st.isSymbolicLink() || !st.isFile()) return fallback
    const realScope = await realpath(scopePath)
    if (!realScope.startsWith(realDir + sep)) return fallback
    const parsed = JSON.parse(await readFile(realScope, 'utf8')) as { agentIds?: unknown }
    return normalizeSkillAgentScope(parsed?.agentIds, fallback)
  } catch {
    return fallback
  }
}

export function resolveCompatLocalSkillStorageIdFromEnv(agentId?: string): string | undefined {
  const raw = process.env.OC_IDENTITY_COMPAT_PROFILE?.trim()
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as {
      canonicalAgentId?: unknown
      localSkillStorageId?: unknown
    }
    const localId =
      typeof parsed?.localSkillStorageId === 'string' ? parsed.localSkillStorageId.trim() : ''
    const canonicalId =
      typeof parsed?.canonicalAgentId === 'string' ? parsed.canonicalAgentId.trim() : ''
    if (!localId) return undefined
    if (agentId && canonicalId && canonicalId !== agentId) return undefined
    return localId
  } catch {
    return undefined
  }
}

/**
 * Shared visibility check aligned 1-to-1 with active `SkillStore.scopeAllows('shared', agentIds)`,
 * including registered compat local skill storage identity aliases.
 */
export function isSkillScopeVisibleToAgent(
  agentIds: readonly string[] | undefined,
  agentId?: string,
  compatLocalSkillStorageId?: string,
): boolean {
  const cleanAgent = agentId?.trim()
  if (!cleanAgent) return true
  const scope = normalizeSkillAgentScope(agentIds, [resolveDefaultAgentId()])
  if (scope.includes(cleanAgent)) return true
  const compatId =
    compatLocalSkillStorageId?.trim() || resolveCompatLocalSkillStorageIdFromEnv(cleanAgent)
  return Boolean(compatId && scope.includes(compatId))
}

/** True iff `keptScope` is a superset of `candidateScope`. */
export function isSkillScopeSuperset(
  keptScope: readonly string[],
  candidateScope: readonly string[],
): boolean {
  const fallback = [resolveDefaultAgentId()]
  const keptSet = new Set(normalizeSkillAgentScope(keptScope, fallback))
  const candList = normalizeSkillAgentScope(candidateScope, fallback)
  return candList.every((id) => keptSet.has(id))
}

/**
 * Scan `memory-archive/batches/<batchId>/*` for carriers that landed on disk
 * (e.g. process crashed between file move and manifest commit) so they remain
 * discoverable and restorable through public list/restore APIs.
 */
async function scanUnregisteredBatchMemories(
  archiveRoot: string,
  trackedRelPaths: ReadonlySet<string>,
): Promise<ArchivedMemoryEntry[]> {
  const batchesRoot = join(archiveRoot, BATCHES_DIR)
  if (!existsSync(batchesRoot)) return []
  let batchDirs
  try {
    batchDirs = await readdir(batchesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const recovered: ArchivedMemoryEntry[] = []
  for (const bDir of batchDirs) {
    if (!bDir.isDirectory() || bDir.name.startsWith('.') || !SAFE_BATCH_ID_RE.test(bDir.name)) {
      continue
    }
    const batchPath = join(batchesRoot, bDir.name)
    let files
    try {
      files = await readdir(batchPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith('.')) continue
      let id: string
      let originalFile: string
      const m = MEM_CARRIER_RE.exec(f.name)
      if (m && MEMORY_FILE_RE.test(m[2]!)) {
        id = m[1]!
        originalFile = m[2]!
      } else if (MEMORY_FILE_RE.test(f.name)) {
        id = `orphan:${bDir.name}/${f.name}`
        originalFile = f.name
      } else {
        continue
      }
      const relPath = `memory-archive/${BATCHES_DIR}/${bDir.name}/${f.name}`
      if (trackedRelPaths.has(relPath)) continue
      const safeAbs = await resolveArchivedSourcePath(archiveRoot, 'memory-archive', relPath, 'file')
      if (!safeAbs) continue
      try {
        const st = await stat(safeAbs)
        const raw = await readFile(safeAbs, 'utf8')
        const { fm } = parseMemoryFrontmatter(raw)
        recovered.push({
          id,
          batchId: bDir.name,
          slug: originalFile.replace(/\.md$/i, ''),
          file: originalFile,
          originalRelPath: `memory/${originalFile}`,
          archivedRelPath: relPath,
          archivedAt: st.mtime.toISOString(),
          reason: 'recovered_unregistered_archive',
          actor: 'recovery',
          bytes: st.size,
          ...(fm.name ? { title: fm.name } : {}),
          ...(fm.type ? { type: fm.type } : {}),
        })
      } catch {
        // ignore unreadable file
      }
    }
  }
  return recovered
}

/**
 * Scan legacy loose `memory-archive/*.md` files (e.g. from earlier manual slimming)
 * that are not tracked in `archive-manifest.json`.
 */
async function scanLegacyArchivedMemories(
  archiveRoot: string,
  trackedRelPaths: ReadonlySet<string>,
): Promise<ArchivedMemoryEntry[]> {
  if (!existsSync(archiveRoot)) return []
  let entries
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const legacy: ArchivedMemoryEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !MEMORY_FILE_RE.test(entry.name)) continue
    const relPath = `memory-archive/${entry.name}`
    if (trackedRelPaths.has(relPath)) continue
    const safeAbs = await resolveArchivedSourcePath(archiveRoot, 'memory-archive', relPath, 'file')
    if (!safeAbs) continue
    try {
      const st = await stat(safeAbs)
      const raw = await readFile(safeAbs, 'utf8')
      const { fm } = parseMemoryFrontmatter(raw)
      legacy.push({
        id: `legacy:${entry.name}`,
        batchId: 'legacy-manual',
        slug: entry.name.replace(/\.md$/i, ''),
        file: entry.name,
        originalRelPath: `memory/${entry.name}`,
        archivedRelPath: relPath,
        archivedAt: st.mtime.toISOString(),
        reason: 'legacy_manual_archive',
        actor: 'manual',
        bytes: st.size,
        title: fm.name || undefined,
        type: fm.type || undefined,
      })
    } catch {
      // ignore unreadable file
    }
  }
  return legacy
}

/**
 * Internal locked archival primitive shared by `archiveMemoryFiles` and
 * `applySemanticMemoryMerge`. Caller MUST already hold `withExclusiveMemoryLock`
 * and have validated `realMemDir` and `realBatchDir` via `verifySafeSubdirWithinRoot`.
 */
async function archiveMemoryFilesLocked(
  realMemDir: string,
  realBatchDir: string,
  manifestEntries: ArchivedMemoryEntry[],
  files: readonly string[],
  options: { reason: string; actor: string; batchId: string },
): Promise<{
  archived: ArchivedMemoryEntry[]
  skipped: Array<{ file: string; reason: string }>
  bytesSaved: number
}> {
  const archived: ArchivedMemoryEntry[] = []
  const skipped: Array<{ file: string; reason: string }> = []
  let bytesSaved = 0
  const nowIso = new Date().toISOString()

  for (const file of files) {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) {
      skipped.push({ file, reason: 'invalid_filename' })
      continue
    }
    const srcPath = join(realMemDir, file)
    if (!existsSync(srcPath)) {
      skipped.push({ file, reason: 'not_found' })
      continue
    }
    let st
    try {
      st = await lstat(srcPath)
    } catch {
      skipped.push({ file, reason: 'not_found' })
      continue
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      skipped.push({ file, reason: 'unsupported_file_type' })
      continue
    }
    const realSrc = await realpath(srcPath)
    if (!realSrc.startsWith(realMemDir + sep)) {
      skipped.push({ file, reason: 'path_escape' })
      continue
    }

    const rawBuf = await readFile(realSrc)
    const raw = rawBuf.toString('utf8')
    const bytes = rawBuf.byteLength
    const sourceSha256 = sha256Hex(rawBuf)
    const { fm } = parseMemoryFrontmatter(raw)
    const entryId = `mem-${randomUUID().slice(0, 12)}`
    const carrierName = `${entryId}__${file}`
    const archivedRelPath = `memory-archive/${BATCHES_DIR}/${options.batchId}/${carrierName}`
    const dstPath = join(realBatchDir, carrierName)

    await moveFileSafe(realSrc, dstPath)

    const entry: ArchivedMemoryEntry = {
      id: entryId,
      batchId: options.batchId,
      slug: file.replace(/\.md$/i, ''),
      file,
      originalRelPath: `memory/${file}`,
      archivedRelPath,
      archivedAt: nowIso,
      reason: options.reason,
      actor: options.actor,
      bytes,
      sourceSha256,
      ...(fm.name ? { title: fm.name } : {}),
      ...(fm.type ? { type: fm.type } : {}),
    }
    manifestEntries.push(entry)
    archived.push(entry)
    bytesSaved += bytes
  }

  return { archived, skipped, bytesSaved }
}

/**
 * Archive one or more Core memory files from `<agentDir>/memory/` into
 * `<agentDir>/memory-archive/batches/<batchId>/<entryId>__<file>` under
 * `MemoryDir` exclusive lock, updating `archive-manifest.json` and reconciling
 * `MEMORY.md`.
 */
export async function archiveMemoryFiles(
  agentDir: string,
  files: readonly string[],
  options: { reason: string; actor?: string; batchId?: string },
): Promise<{
  batchId: string
  archived: ArchivedMemoryEntry[]
  skipped: Array<{ file: string; reason: string }>
  bytesSaved: number
}> {
  const batchId = normalizeBatchId(options.batchId)
  const actor = (options.actor ?? 'user').trim() || 'user'
  const reason = (options.reason || 'manual_archive').trim() || 'manual_archive'
  const uniqueFiles = [...new Set(files.map((f) => String(f ?? '').trim()).filter(Boolean))]
  if (uniqueFiles.length === 0) {
    return { batchId, archived: [], skipped: [], bytesSaved: 0 }
  }

  const memdir = createMemoryDirForAgentDir(agentDir)
  const archiveRoot = memoryArchiveRoot(agentDir)

  try {
    return await memdir.withExclusiveMemoryLock(
      async ({ dirPath, reconcileIndex }) => {
        // B11: Fail-closed directory boundary validation BEFORE first move
        const memDirCheck = await verifySafeSubdirWithinRoot(agentDir, dirPath)
        if (!memDirCheck.ok) {
          return {
            batchId,
            archived: [],
            skipped: uniqueFiles.map((file) => ({
              file,
              reason: memDirCheck.reason === 'missing_dir' ? 'not_found' : 'unsafe_directory_boundary',
            })),
            bytesSaved: 0,
          }
        }
        const batchDirCheck = await verifySafeSubdirWithinRoot(
          agentDir,
          join(archiveRoot, BATCHES_DIR, batchId),
          { create: true },
        )
        if (!batchDirCheck.ok) {
          return {
            batchId,
            archived: [],
            skipped: uniqueFiles.map((file) => ({ file, reason: 'unsafe_directory_boundary' })),
            bytesSaved: 0,
          }
        }

        const manifestData = await readMemoryManifestData(archiveRoot)
        const { archived, skipped, bytesSaved } = await archiveMemoryFilesLocked(
          memDirCheck.realDir,
          batchDirCheck.realDir,
          manifestData.entries,
          uniqueFiles,
          { reason, actor, batchId },
        )

        if (archived.length > 0) {
          await writeMemoryManifestData(archiveRoot, manifestData.entries, manifestData.mergedArtifacts)
          await reconcileIndex()
        }

        return { batchId, archived, skipped, bytesSaved }
      },
      { checkDirs: [archiveRoot] },
    )
  } catch (err) {
    if (err instanceof MemoryBoundaryError) {
      return {
        batchId,
        archived: [],
        skipped: uniqueFiles.map((file) => ({ file, reason: 'unsafe_directory_boundary' })),
        bytesSaved: 0,
      }
    }
    throw err
  }
}

/**
 * List all archived Core memories (manifest-tracked + unregistered batch
 * carriers + legacy loose `.md` files), newest first. Fail-open if absent.
 */
export async function listArchivedMemories(agentDir: string): Promise<ArchivedMemoryEntry[]> {
  const archiveRoot = memoryArchiveRoot(agentDir)
  const archCheck = await verifySafeSubdirWithinRoot(agentDir, archiveRoot)
  if (!archCheck.ok) return []
  const { entries: manifest } = await readMemoryManifestData(archiveRoot)
  const existingManifest: ArchivedMemoryEntry[] = []
  const trackedRel = new Set<string>()
  for (const entry of manifest) {
    const safeAbs = await resolveArchivedSourcePath(
      archiveRoot,
      'memory-archive',
      entry.archivedRelPath,
      'file',
    )
    if (!safeAbs) continue
    existingManifest.push(entry)
    trackedRel.add(entry.archivedRelPath)
  }
  const unregistered = await scanUnregisteredBatchMemories(archiveRoot, trackedRel)
  for (const u of unregistered) trackedRel.add(u.archivedRelPath)
  const legacy = await scanLegacyArchivedMemories(archiveRoot, trackedRel)
  return [...existingManifest, ...unregistered, ...legacy].sort(
    (a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.file.localeCompare(b.file),
  )
}

function planPreservedEditedFileName(originalFile: string, realMemDir: string): string {
  const stem = originalFile.replace(/\.md$/i, '').slice(0, 42)
  const shortTs = Date.now().toString(36).slice(-6)
  let candidate = `${stem}-edited-${shortTs}.md`
  if (existsSync(join(realMemDir, candidate)) || !MEMORY_FILE_RE.test(candidate)) {
    const rand = randomUUID().replace(/-/g, '').slice(0, 6)
    candidate = `${stem.slice(0, 36)}-edited-${rand}.md`
  }
  return candidate
}

/**
 * Restore archived Core memories by single `id` or whole `batchId` under
 * `MemoryDir` exclusive lock, updating `archive-manifest.json` and reconciling
 * `MEMORY.md`.
 *
 * B1 guarantee: For whole-batch undo of a semantic merge, verifies archived
 * sources FIRST, then compares the live synthetic merged file's sha256 against
 * the recorded `mergedArtifacts` sha256. Unedited exact artifacts are removed;
 * manually edited artifacts are NEVER deleted (kept in place or atomically
 * renamed to `<slug>-edited-<ts>.md` on name collision, and listed in
 * `preservedEditedFiles`).
 */
export async function restoreArchivedMemories(
  agentDir: string,
  filter: { id?: string; batchId?: string },
): Promise<{
  restored: ArchivedMemoryEntry[]
  skipped: Array<{ id: string; file: string; reason: string }>
  preservedEditedFiles: string[]
}> {
  const targetId = filter.id?.trim() || undefined
  const targetBatchId = filter.batchId?.trim() || undefined
  if (!targetId && !targetBatchId) {
    return { restored: [], skipped: [], preservedEditedFiles: [] }
  }

  const memdir = createMemoryDirForAgentDir(agentDir)
  const archiveRoot = memoryArchiveRoot(agentDir)

  try {
    return await memdir.withExclusiveMemoryLock(
      async ({ dirPath, reconcileIndex }) => {
        // B11: Verify both archiveRoot and live memory/ stay inside trusted agentDir without symlinks
        const archCheck = await verifySafeSubdirWithinRoot(agentDir, archiveRoot)
        if (!archCheck.ok) {
          return { restored: [], skipped: [], preservedEditedFiles: [] }
        }
        const memDirCheck = await verifySafeSubdirWithinRoot(agentDir, dirPath, { create: true })
        if (!memDirCheck.ok) {
          return {
            restored: [],
            skipped: [
              {
                id: targetId ?? targetBatchId ?? 'unknown',
                file: '',
                reason: 'unsafe_directory_boundary',
              },
            ],
            preservedEditedFiles: [],
          }
        }
        const realMemDir = memDirCheck.realDir

        const manifestData = await readMemoryManifestData(archiveRoot)
        const manifestEntries = manifestData.entries
        let mergedArtifacts = [...manifestData.mergedArtifacts]

        const trackedRel = new Set(manifestEntries.map((e) => e.archivedRelPath))
        const unregisteredEntries = await scanUnregisteredBatchMemories(archiveRoot, trackedRel)
        for (const u of unregisteredEntries) trackedRel.add(u.archivedRelPath)
        const legacyEntries = await scanLegacyArchivedMemories(archiveRoot, trackedRel)

        const allCandidates = [...manifestEntries, ...unregisteredEntries, ...legacyEntries]
        const matches = allCandidates.filter((entry) => {
          if (targetId && entry.id !== targetId) return false
          if (targetBatchId && entry.batchId !== targetBatchId) return false
          return true
        })

        if (matches.length === 0) {
          return { restored: [], skipped: [], preservedEditedFiles: [] }
        }

        // B1 step 1: Verify EVERY matched archived source exists AND passes full content/byte integrity
        // BEFORE touching or removing any live/synthetic file.
        const verifiedMatches: Array<{ entry: ArchivedMemoryEntry; archivedAbs: string }> = []
        const skipped: Array<{ id: string; file: string; reason: string }> = []
        for (const entry of matches) {
          if (!MEMORY_FILE_RE.test(entry.file) || basename(entry.file) !== entry.file) {
            skipped.push({ id: entry.id, file: entry.file, reason: 'invalid_filename' })
            continue
          }
          const archivedAbs = await resolveArchivedSourcePath(
            archiveRoot,
            'memory-archive',
            entry.archivedRelPath,
            'file',
          )
          if (!archivedAbs) {
            skipped.push({ id: entry.id, file: entry.file, reason: 'archive_missing_or_invalid' })
            continue
          }
          let rawBuf: Buffer
          try {
            rawBuf = await readFile(archivedAbs)
          } catch {
            skipped.push({ id: entry.id, file: entry.file, reason: 'archive_corrupted' })
            continue
          }
          const expectedSha =
            typeof entry.sourceSha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sourceSha256)
              ? entry.sourceSha256.toLowerCase()
              : null
          if (expectedSha) {
            const actualSha = sha256Hex(rawBuf)
            const expectedBytes = typeof entry.bytes === 'number' && entry.bytes >= 0 ? entry.bytes : null
            if (actualSha !== expectedSha || (expectedBytes !== null && rawBuf.byteLength !== expectedBytes)) {
              skipped.push({ id: entry.id, file: entry.file, reason: 'archive_corrupted' })
              continue
            }
          } else {
            const expectedBytes = typeof entry.bytes === 'number' && entry.bytes > 0 ? entry.bytes : null
            if (rawBuf.byteLength === 0 || (expectedBytes !== null && rawBuf.byteLength !== expectedBytes)) {
              skipped.push({ id: entry.id, file: entry.file, reason: 'archive_corrupted' })
              continue
            }
          }
          verifiedMatches.push({ entry, archivedAbs })
        }

        if (verifiedMatches.length === 0) {
          return { restored: [], skipped, preservedEditedFiles: [] }
        }

        const restored: ArchivedMemoryEntry[] = []
        const removedIds = new Set<string>()
        const preservedEditedFiles: string[] = []
        let liveMutated = false

        // Detect synthetic merged artifacts belonging to targetBatchId (for whole-batch undo)
        const batchArtifacts =
          targetBatchId && !targetId
            ? mergedArtifacts.filter((a) => a.batchId === targetBatchId)
            : []
        const syntheticFiles = new Set<string>(batchArtifacts.map((a) => a.targetFile))
        if (targetBatchId && !targetId) {
          try {
            const liveEntries = await readdir(realMemDir, { withFileTypes: true })
            for (const liveEntry of liveEntries) {
              if (!liveEntry.isFile() || !MEMORY_FILE_RE.test(liveEntry.name)) continue
              const full = join(realMemDir, liveEntry.name)
              try {
                const st = await lstat(full)
                if (st.isSymbolicLink() || !st.isFile()) continue
                const realFull = await realpath(full)
                if (!realFull.startsWith(realMemDir + sep)) continue
                const raw = await readFile(realFull, 'utf8')
                const { fm } = parseMemoryFrontmatter(raw)
                if (fm.source === 'auto-merge' && fm.merge_batch === targetBatchId) {
                  syntheticFiles.add(liveEntry.name)
                }
              } catch {
                // ignore unreadable live file
              }
            }
          } catch {
            // ignore
          }
        }

        // B1 step 2: If this whole-batch undo targets a semantic merge batch and ANY archived source
        // failed integrity verification, NEVER delete the synthetic merged file and abort batch restore
        // so the intact merged artifact remains live without partial duplication.
        if (targetBatchId && !targetId && syntheticFiles.size > 0 && skipped.length > 0) {
          for (const { entry } of verifiedMatches) {
            skipped.push({ id: entry.id, file: entry.file, reason: 'batch_archive_corrupted' })
          }
          return { restored: [], skipped, preservedEditedFiles: [] }
        }

        // B1 step 3: Whole-batch undo of semantic merge only when ALL batch sources verified intact
        if (targetBatchId && !targetId && skipped.length === 0 && syntheticFiles.size > 0) {
          const expectedShaByFile = new Map<string, string>(
            batchArtifacts.map((a) => [a.targetFile, a.targetSha256.toLowerCase()]),
          )
          const restoringFileNames = new Set(verifiedMatches.map((m) => m.entry.file))
          for (const targetFile of syntheticFiles) {
            const liveFull = join(realMemDir, targetFile)
            if (!existsSync(liveFull)) continue
            try {
              const st = await lstat(liveFull)
              if (st.isSymbolicLink() || !st.isFile()) continue
              const realFull = await realpath(liveFull)
              if (!realFull.startsWith(realMemDir + sep)) continue
              const liveRaw = await readFile(realFull, 'utf8')
              const liveSha = sha256Hex(liveRaw)
              const expectedSha = expectedShaByFile.get(targetFile)

              if (expectedSha && liveSha === expectedSha) {
                // Exact unedited auto-merged artifact -> safe to remove
                await rm(realFull, { force: true })
                liveMutated = true
              } else {
                // Edited by user (or no recorded hash proof) -> NEVER delete!
                if (restoringFileNames.has(targetFile)) {
                  const preservedName = planPreservedEditedFileName(targetFile, realMemDir)
                  await moveFileSafe(realFull, join(realMemDir, preservedName))
                  preservedEditedFiles.push(preservedName)
                  liveMutated = true
                } else {
                  preservedEditedFiles.push(targetFile)
                }
              }
            } catch {
              // fail-closed: preserve file on any read error
              preservedEditedFiles.push(targetFile)
            }
          }

          mergedArtifacts = mergedArtifacts.filter((a) => a.batchId !== targetBatchId)
        }

        // B1 step 4: Restore verified archived sources into realMemDir
        for (const { entry, archivedAbs } of verifiedMatches) {
          const liveDst = join(realMemDir, entry.file)
          if (existsSync(liveDst)) {
            skipped.push({ id: entry.id, file: entry.file, reason: 'target_exists' })
            continue
          }
          await moveFileSafe(archivedAbs, liveDst)
          restored.push(entry)
          removedIds.add(entry.id)
          liveMutated = true
        }

        const remainingEntries = manifestEntries.filter((e) => !removedIds.has(e.id))
        if (
          remainingEntries.length !== manifestEntries.length ||
          mergedArtifacts.length !== manifestData.mergedArtifacts.length
        ) {
          await writeMemoryManifestData(archiveRoot, remainingEntries, mergedArtifacts)
        }
        if (liveMutated) {
          await reconcileIndex()
        }

        return { restored, skipped, preservedEditedFiles }
      },
      { checkDirs: [archiveRoot] },
    )
  } catch (err) {
    if (err instanceof MemoryBoundaryError) {
      return {
        restored: [],
        skipped: [
          {
            id: targetId ?? targetBatchId ?? 'unknown',
            file: '',
            reason: 'unsafe_directory_boundary',
          },
        ],
        preservedEditedFiles: [],
      }
    }
    throw err
  }
}

async function scanUnregisteredBatchSkills(
  archiveRoot: string,
  trackedRelPaths: ReadonlySet<string>,
): Promise<ArchivedSkillEntry[]> {
  const batchesRoot = join(archiveRoot, BATCHES_DIR)
  if (!existsSync(batchesRoot)) return []
  let batchDirs
  try {
    batchDirs = await readdir(batchesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const recovered: ArchivedSkillEntry[] = []
  for (const bDir of batchDirs) {
    if (!bDir.isDirectory() || bDir.name.startsWith('.') || !SAFE_BATCH_ID_RE.test(bDir.name)) {
      continue
    }
    const batchPath = join(batchesRoot, bDir.name)
    let skillDirs
    try {
      skillDirs = await readdir(batchPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of skillDirs) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue
      let id: string
      let skillName: string
      const m = SKILL_CARRIER_RE.exec(dir.name)
      if (m && validateSkillName(m[2]!).ok) {
        id = m[1]!
        skillName = m[2]!
      } else if (validateSkillName(dir.name).ok) {
        id = `orphan:${bDir.name}/${dir.name}`
        skillName = dir.name
      } else {
        continue
      }
      const relPath = `skills-archive/${BATCHES_DIR}/${bDir.name}/${dir.name}`
      if (trackedRelPaths.has(relPath)) continue
      const safeAbs = await resolveArchivedSourcePath(archiveRoot, 'skills-archive', relPath, 'dir')
      if (!safeAbs) continue
      try {
        const skillMd = join(safeAbs, 'SKILL.md')
        const st = await stat(skillMd)
        const raw = await readFile(skillMd, 'utf8')
        const { meta } = parseFrontmatter(raw)
        const bytes = await dirSizeBytes(safeAbs)
        const agentIds = await resolveEffectiveSkillAgentScope(safeAbs)
        recovered.push({
          id,
          batchId: bDir.name,
          name: skillName,
          archivedRelPath: relPath,
          archivedAt: st.mtime.toISOString(),
          reason: 'recovered_unregistered_archive',
          actor: 'recovery',
          bytes,
          ...(meta.description ? { description: meta.description } : {}),
          agentIds,
        })
      } catch {
        // ignore unreadable skill dir
      }
    }
  }
  return recovered
}

async function scanLegacyArchivedSkills(
  archiveRoot: string,
  trackedRelPaths: ReadonlySet<string>,
): Promise<ArchivedSkillEntry[]> {
  if (!existsSync(archiveRoot)) return []
  let buckets
  try {
    buckets = await readdir(archiveRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const legacy: ArchivedSkillEntry[] = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.name === BATCHES_DIR || bucket.name.startsWith('.')) {
      continue
    }
    const bucketPath = join(archiveRoot, bucket.name)
    let skillDirs
    try {
      skillDirs = await readdir(bucketPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of skillDirs) {
      if (!dir.isDirectory() || !validateSkillName(dir.name).ok) continue
      const relPath = `skills-archive/${bucket.name}/${dir.name}`
      if (trackedRelPaths.has(relPath)) continue
      const safeAbs = await resolveArchivedSourcePath(archiveRoot, 'skills-archive', relPath, 'dir')
      if (!safeAbs) continue
      try {
        const skillMd = join(safeAbs, 'SKILL.md')
        const st = await stat(skillMd)
        const raw = await readFile(skillMd, 'utf8')
        const { meta } = parseFrontmatter(raw)
        const agentIds = await resolveEffectiveSkillAgentScope(safeAbs)
        legacy.push({
          id: `legacy:${bucket.name}/${dir.name}`,
          batchId: `legacy:${bucket.name}`,
          name: dir.name,
          archivedRelPath: relPath,
          archivedAt: st.mtime.toISOString(),
          reason: 'legacy_manual_archive',
          actor: 'manual',
          bytes: st.size,
          description: meta.description || undefined,
          agentIds,
        })
      } catch {
        // ignore unreadable legacy skill
      }
    }
  }
  return legacy
}

/**
 * Archive a user skill directory from `<skillsDir>/<name>` into
 * `<dirname(skillsDir)>/skills-archive/batches/<batchId>/<entryId>__<name>`,
 * persisting its effective `agentIds` scope and validating non-symlink boundaries.
 */
export async function archiveUserSkill(
  skillsDir: string,
  name: string,
  options: {
    reason: string
    actor?: string
    batchId?: string
    guard?: ArchiveUserSkillGuard
  },
): Promise<{
  batchId: string
  entry: ArchivedSkillEntry | null
  skippedReason?: string
}> {
  const batchId = normalizeBatchId(options.batchId)
  const actor = (options.actor ?? 'user').trim() || 'user'
  const reason = (options.reason || 'manual_archive').trim() || 'manual_archive'
  const cleanName = String(name ?? '').trim()
  if (!validateSkillName(cleanName).ok || basename(cleanName) !== cleanName) {
    return { batchId, entry: null, skippedReason: 'invalid_skill_name' }
  }

  const baseDir = dirname(resolve(skillsDir))
  const archiveRoot = skillArchiveRoot(skillsDir)

  // B11: Verify both skillsDir and skills-archive/batches/<batchId> under trusted baseDir
  const skillsDirCheck = await verifySafeSubdirWithinRoot(baseDir, skillsDir)
  if (!skillsDirCheck.ok) {
    return {
      batchId,
      entry: null,
      skippedReason:
        skillsDirCheck.reason === 'missing_dir' ? 'not_found' : 'unsafe_directory_boundary',
    }
  }
  const archRootCheck = await verifySafeSubdirWithinRoot(baseDir, archiveRoot, { create: true })
  if (!archRootCheck.ok) {
    return { batchId, entry: null, skippedReason: 'unsafe_directory_boundary' }
  }

  const release = await acquireFileLock(join(archRootCheck.realDir, '.archive.lock'))
  try {
    const batchDirCheck = await verifySafeSubdirWithinRoot(
      baseDir,
      join(archiveRoot, BATCHES_DIR, batchId),
      { create: true },
    )
    if (!batchDirCheck.ok) {
      return { batchId, entry: null, skippedReason: 'unsafe_directory_boundary' }
    }

    const realSkillsRoot = skillsDirCheck.realDir
    const srcDir = join(realSkillsRoot, cleanName)
    if (!existsSync(srcDir)) {
      return { batchId, entry: null, skippedReason: 'not_found' }
    }
    const st = await lstat(srcDir)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { batchId, entry: null, skippedReason: 'unsupported_skill_dir' }
    }
    const realSrc = await realpath(srcDir)
    if (!realSrc.startsWith(realSkillsRoot + sep)) {
      return { batchId, entry: null, skippedReason: 'path_escape' }
    }
    const skillMdPath = join(realSrc, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      return { batchId, entry: null, skippedReason: 'missing_skill_md' }
    }
    const mdStat = await lstat(skillMdPath)
    if (mdStat.isSymbolicLink() || !mdStat.isFile()) {
      return { batchId, entry: null, skippedReason: 'unsupported_skill_md' }
    }

    let description: string | undefined
    let rawSkillMd = ''
    let parsedPriority: number | undefined
    try {
      rawSkillMd = await readFile(skillMdPath, 'utf8')
      const { meta } = parseFrontmatter(rawSkillMd)
      if (meta.description) description = meta.description
      parsedPriority = normalizeSkillPriority(meta.priority)
    } catch {
      if (options.guard) {
        return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
      }
    }
    const agentIds = await resolveEffectiveSkillAgentScope(realSrc)

    // B8: Atomic in-lock guard re-validating live priority, kept sibling existence,
    // and authoritative effective agent scope superset BEFORE moving the directory.
    if (options.guard) {
      const { maxPriorityExclusive, requireKeptSkillName, checkScopeSuperset } = options.guard
      if (typeof maxPriorityExclusive === 'number') {
        const effectivePriority = parsedPriority ?? 0
        if (effectivePriority >= maxPriorityExclusive) {
          return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
        }
      }
      if (requireKeptSkillName !== undefined) {
        const keptName = String(requireKeptSkillName ?? '').trim()
        if (!keptName || keptName === cleanName || !validateSkillName(keptName).ok) {
          return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
        }
        const keptDir = join(realSkillsRoot, keptName)
        if (!existsSync(keptDir)) {
          return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
        }
        try {
          const keptStat = await lstat(keptDir)
          if (keptStat.isSymbolicLink() || !keptStat.isDirectory()) {
            return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
          }
          const realKept = await realpath(keptDir)
          if (!realKept.startsWith(realSkillsRoot + sep)) {
            return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
          }
          const keptMdPath = join(realKept, 'SKILL.md')
          const keptMdStat = await lstat(keptMdPath)
          if (keptMdStat.isSymbolicLink() || !keptMdStat.isFile()) {
            return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
          }
          const realKeptMd = await realpath(keptMdPath)
          if (!realKeptMd.startsWith(realKept + sep)) {
            return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
          }
          if (checkScopeSuperset) {
            const keptScope = await resolveEffectiveSkillAgentScope(realKept)
            if (!isSkillScopeSuperset(keptScope, agentIds)) {
              return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
            }
          }
        } catch {
          return { batchId, entry: null, skippedReason: 'guard_conflict_after_lock' }
        }
      }
    }

    const bytes = await dirSizeBytes(realSrc)
    const entryId = `skill-${randomUUID().slice(0, 12)}`
    const carrierName = `${entryId}__${cleanName}`
    const archivedRelPath = `skills-archive/${BATCHES_DIR}/${batchId}/${carrierName}`
    const dstDir = join(batchDirCheck.realDir, carrierName)

    await moveDirSafe(realSrc, dstDir)

    const entry: ArchivedSkillEntry = {
      id: entryId,
      batchId,
      name: cleanName,
      archivedRelPath,
      archivedAt: new Date().toISOString(),
      reason,
      actor,
      bytes,
      ...(description ? { description } : {}),
      agentIds,
    }
    const manifestEntries = await readSkillManifest(archiveRoot)
    manifestEntries.push(entry)
    await writeSkillManifest(archiveRoot, manifestEntries)

    return { batchId, entry }
  } finally {
    await release().catch(() => {})
  }
}

/**
 * List all archived user skills (manifest-tracked + unregistered batch
 * carriers + legacy date buckets), newest first. Fail-open if absent.
 */
export async function listArchivedSkills(skillsDir: string): Promise<ArchivedSkillEntry[]> {
  const baseDir = dirname(resolve(skillsDir))
  const archiveRoot = skillArchiveRoot(skillsDir)
  const archCheck = await verifySafeSubdirWithinRoot(baseDir, archiveRoot)
  if (!archCheck.ok) return []
  const manifest = await readSkillManifest(archiveRoot)
  const existingManifest: ArchivedSkillEntry[] = []
  const trackedRel = new Set<string>()
  for (const entry of manifest) {
    const safeAbs = await resolveArchivedSourcePath(
      archiveRoot,
      'skills-archive',
      entry.archivedRelPath,
      'dir',
    )
    if (!safeAbs) continue
    let agentIds = entry.agentIds
    if (!agentIds) {
      agentIds = await resolveEffectiveSkillAgentScope(safeAbs)
    }
    existingManifest.push({ ...entry, agentIds })
    trackedRel.add(entry.archivedRelPath)
  }
  const unregistered = await scanUnregisteredBatchSkills(archiveRoot, trackedRel)
  for (const u of unregistered) trackedRel.add(u.archivedRelPath)
  const legacy = await scanLegacyArchivedSkills(archiveRoot, trackedRel)
  return [...existingManifest, ...unregistered, ...legacy].sort(
    (a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.name.localeCompare(b.name),
  )
}

/**
 * Restore archived user skills by `id`, `name`, or `batchId`.
 * Idempotent and never clobbers an existing live skill directory.
 */
export async function restoreArchivedSkills(
  skillsDir: string,
  filter: { id?: string; name?: string; batchId?: string },
): Promise<{
  restored: ArchivedSkillEntry[]
  skipped: Array<{ id: string; name: string; reason: string }>
}> {
  const targetId = filter.id?.trim() || undefined
  const targetName = filter.name?.trim() || undefined
  const targetBatchId = filter.batchId?.trim() || undefined
  if (!targetId && !targetName && !targetBatchId) {
    return { restored: [], skipped: [] }
  }

  const baseDir = dirname(resolve(skillsDir))
  const archiveRoot = skillArchiveRoot(skillsDir)
  const archCheck = await verifySafeSubdirWithinRoot(baseDir, archiveRoot)
  if (!archCheck.ok) {
    return { restored: [], skipped: [] }
  }
  const skillsDirCheck = await verifySafeSubdirWithinRoot(baseDir, skillsDir, { create: true })
  if (!skillsDirCheck.ok) {
    return {
      restored: [],
      skipped: [
        {
          id: targetId ?? targetBatchId ?? targetName ?? 'unknown',
          name: targetName ?? '',
          reason: 'unsafe_directory_boundary',
        },
      ],
    }
  }
  const realSkillsDir = skillsDirCheck.realDir

  const release = await acquireFileLock(join(archCheck.realDir, '.archive.lock'))
  try {
    const manifestEntries = await readSkillManifest(archiveRoot)
    const trackedRel = new Set(manifestEntries.map((e) => e.archivedRelPath))
    const unregisteredEntries = await scanUnregisteredBatchSkills(archiveRoot, trackedRel)
    for (const u of unregisteredEntries) trackedRel.add(u.archivedRelPath)
    const legacyEntries = await scanLegacyArchivedSkills(archiveRoot, trackedRel)
    const allCandidates = [...manifestEntries, ...unregisteredEntries, ...legacyEntries].sort(
      (a, b) => b.archivedAt.localeCompare(a.archivedAt),
    )

    let matches = allCandidates.filter((entry) => {
      if (targetId && entry.id !== targetId) return false
      if (targetName && entry.name !== targetName) return false
      if (targetBatchId && entry.batchId !== targetBatchId) return false
      return true
    })
    // When restoring by name alone and multiple historical snapshots exist, restore only the newest.
    if (targetName && !targetId && !targetBatchId && matches.length > 1) {
      matches = [matches[0]!]
    }
    if (matches.length === 0) {
      return { restored: [], skipped: [] }
    }

    const restored: ArchivedSkillEntry[] = []
    const skipped: Array<{ id: string; name: string; reason: string }> = []
    const removedIds = new Set<string>()

    for (const entry of matches) {
      if (!validateSkillName(entry.name).ok || basename(entry.name) !== entry.name) {
        skipped.push({ id: entry.id, name: entry.name, reason: 'invalid_skill_name' })
        continue
      }
      const archivedAbs = await resolveArchivedSourcePath(
        archiveRoot,
        'skills-archive',
        entry.archivedRelPath,
        'dir',
      )
      if (!archivedAbs) {
        skipped.push({ id: entry.id, name: entry.name, reason: 'archive_missing_or_invalid' })
        continue
      }
      const liveDst = join(realSkillsDir, entry.name)
      if (existsSync(liveDst)) {
        skipped.push({ id: entry.id, name: entry.name, reason: 'target_exists' })
        continue
      }
      await moveDirSafe(archivedAbs, liveDst)
      restored.push(entry)
      removedIds.add(entry.id)
    }

    if (removedIds.size > 0) {
      const remaining = manifestEntries.filter((e) => !removedIds.has(e.id))
      if (remaining.length !== manifestEntries.length) {
        await writeSkillManifest(archiveRoot, remaining)
      }
    }

    return { restored, skipped }
  } finally {
    await release().catch(() => {})
  }
}

// ── Semantic Auto-Merge Primitive (OCV5-841 Wave 2) ──────────────────────

const VALID_SEMANTIC_MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])
const MAX_SEMANTIC_MERGED_BYTES = 8 * 1024

export interface SemanticMemoryMergeGroup {
  targetSlug: string
  sourceSlugs: string[]
  mergedTitle: string
  mergedDescription: string
  mergedType: 'user' | 'feedback' | 'project' | 'reference'
  mergedContent: string
  reason: string
  /** Optional sha256 map keyed by source filename (`foo.md`) or slug (`foo`) for CAS verification. */
  expectedSourceShas?: Record<string, string>
}

export interface SemanticArchiveSuperseded {
  slug: string
  reason: string
  expectedSha?: string
}

export interface ApplySemanticMemoryMergeInput {
  agentDir: string
  mergeGroups: readonly SemanticMemoryMergeGroup[]
  archiveSuperseded?: readonly SemanticArchiveSuperseded[]
  batchId?: string
  actor?: string
}

export interface ApplySemanticMemoryMergeResult {
  batchId: string
  mergedGroups: Array<{
    targetFile: string
    targetSha256: string
    sourceFiles: string[]
    reason: string
    expires?: string
  }>
  archivedEntries: ArchivedMemoryEntry[]
  skippedGroups: Array<{ targetSlug: string; reason: string }>
  skippedSuperseded: Array<{ slug: string; reason: string }>
  bytesSaved: number
}

function normalizeMemorySlugToFile(raw: string): string | null {
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

async function atomicWriteMemoryFile(fullPath: string, content: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true })
  const tmp = `${fullPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, fullPath)
    await chmod(fullPath, 0o600).catch(() => {})
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * First-class reversible semantic merge primitive for Core memories.
 *
 * Safety invariants:
 * - B11: Validates both `memory/` and `memory-archive/batches/<batchId>` strictly
 *   within `agentDir` with zero symlink components BEFORE any mutation.
 * - B8: Under `withExclusiveMemoryLock`, verifies `expectedSourceShas` (if given)
 *   and refuses to archive or overwrite an unrelated live file at `targetSlug`.
 * - B9: Propagates `expires` TTL without ever extending retention (`min(expires)`
 *   when all sources carry valid `expires`; rejects mixed TTL policies).
 * - B1: Archives all sources first, records `{ targetFile, targetSha256 }` in
 *   `archive-manifest.json`, then atomically writes the merged file (`0600`)
 *   and reconciles `MEMORY.md`.
 */
export async function applySemanticMemoryMerge(
  input: ApplySemanticMemoryMergeInput,
): Promise<ApplySemanticMemoryMergeResult> {
  const batchId = normalizeBatchId(input.batchId)
  const actor = (input.actor ?? 'auto-dream:semantic-merge').trim() || 'auto-dream:semantic-merge'
  const groups = Array.isArray(input.mergeGroups) ? input.mergeGroups : []
  const superseded = Array.isArray(input.archiveSuperseded) ? input.archiveSuperseded : []

  if (groups.length === 0 && superseded.length === 0) {
    return {
      batchId,
      mergedGroups: [],
      archivedEntries: [],
      skippedGroups: [],
      skippedSuperseded: [],
      bytesSaved: 0,
    }
  }

  const memdir = createMemoryDirForAgentDir(input.agentDir)
  const archiveRoot = memoryArchiveRoot(input.agentDir)

  try {
    return await memdir.withExclusiveMemoryLock(
      async ({ dirPath, reconcileIndex }) => {
    // B11: Validate trusted boundaries BEFORE first mutation
    const memDirCheck = await verifySafeSubdirWithinRoot(input.agentDir, dirPath)
    if (!memDirCheck.ok) {
      return {
        batchId,
        mergedGroups: [],
        archivedEntries: [],
        skippedGroups: groups.map((g) => ({
          targetSlug: String(g.targetSlug ?? ''),
          reason:
            memDirCheck.reason === 'missing_dir' ? 'source_not_found' : 'unsafe_directory_boundary',
        })),
        skippedSuperseded: superseded.map((s) => ({
          slug: String(s.slug ?? ''),
          reason:
            memDirCheck.reason === 'missing_dir' ? 'not_found' : 'unsafe_directory_boundary',
        })),
        bytesSaved: 0,
      }
    }
    const batchDirCheck = await verifySafeSubdirWithinRoot(
      input.agentDir,
      join(archiveRoot, BATCHES_DIR, batchId),
      { create: true },
    )
    if (!batchDirCheck.ok) {
      return {
        batchId,
        mergedGroups: [],
        archivedEntries: [],
        skippedGroups: groups.map((g) => ({
          targetSlug: String(g.targetSlug ?? ''),
          reason: 'unsafe_directory_boundary',
        })),
        skippedSuperseded: superseded.map((s) => ({
          slug: String(s.slug ?? ''),
          reason: 'unsafe_directory_boundary',
        })),
        bytesSaved: 0,
      }
    }

    const realMemDir = memDirCheck.realDir
    const realBatchDir = batchDirCheck.realDir
    const manifestData = await readMemoryManifestData(archiveRoot)
    const manifestEntries = manifestData.entries
    const mergedArtifacts = manifestData.mergedArtifacts

    const mergedGroups: ApplySemanticMemoryMergeResult['mergedGroups'] = []
    const archivedEntries: ArchivedMemoryEntry[] = []
    const skippedGroups: Array<{ targetSlug: string; reason: string }> = []
    const skippedSuperseded: Array<{ slug: string; reason: string }> = []
    let archivedBytesTotal = 0
    let writtenBytesTotal = 0
    const nowIso = new Date().toISOString()

    const readRegularMemoryFile = async (
      file: string,
    ): Promise<{ content: string; sha256: string } | null> => {
      const full = join(realMemDir, file)
      if (!existsSync(full)) return null
      try {
        const st = await lstat(full)
        if (st.isSymbolicLink() || !st.isFile()) return null
        const realFull = await realpath(full)
        if (!realFull.startsWith(realMemDir + sep)) return null
        const content = await readFile(realFull, 'utf8')
        return { content, sha256: sha256Hex(content) }
      } catch {
        return null
      }
    }

    const consumedSources = new Set<string>()
    const createdTargets = new Set<string>()

    for (const group of groups) {
      const targetFile = normalizeMemorySlugToFile(group.targetSlug)
      if (!targetFile) {
        skippedGroups.push({ targetSlug: String(group.targetSlug ?? ''), reason: 'invalid_target' })
        continue
      }
      if (createdTargets.has(targetFile)) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'duplicate_target_in_batch' })
        continue
      }
      if (!Array.isArray(group.sourceSlugs) || group.sourceSlugs.length < 2) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'insufficient_sources' })
        continue
      }
      const normalizedSources: string[] = []
      let hasInvalidSource = false
      for (const rawSlug of group.sourceSlugs) {
        const f = normalizeMemorySlugToFile(rawSlug)
        if (!f) {
          hasInvalidSource = true
          break
        }
        if (!normalizedSources.includes(f)) normalizedSources.push(f)
      }
      if (hasInvalidSource || normalizedSources.length < 2) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'invalid_source_slug' })
        continue
      }
      if (normalizedSources.some((f) => consumedSources.has(f) || createdTargets.has(f))) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'overlapping_source' })
        continue
      }
      if (!VALID_SEMANTIC_MEMORY_TYPES.has(group.mergedType)) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'invalid_type' })
        continue
      }
      const title = sanitizeSingleLineHeader(group.mergedTitle, 120)
      const description = sanitizeSingleLineHeader(group.mergedDescription, 240)
      const body = String(group.mergedContent ?? '').replace(/\r\n/g, '\n').trim()
      if (!title || !description || !body) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'empty_merged_fields' })
        continue
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_SEMANTIC_MERGED_BYTES) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'merged_content_too_large' })
        continue
      }

      // B8: Target ownership guard — refuse to archive or overwrite an unrelated live file
      if (!normalizedSources.includes(targetFile)) {
        const existingTarget = await readRegularMemoryFile(targetFile)
        if (existingTarget !== null || existsSync(join(realMemDir, targetFile))) {
          skippedGroups.push({
            targetSlug: group.targetSlug,
            reason: 'target_owned_by_unrelated_file',
          })
          continue
        }
      }

      // Verify ALL source files exist, check expectedSourceShas (B8), and inspect expires TTL (B9)
      let missingSource = false
      let versionMismatch = false
      let incompatibleTtl = false
      const sourceExpires: Array<string | null> = []

      for (const srcFile of normalizedSources) {
        const loaded = await readRegularMemoryFile(srcFile)
        if (!loaded) {
          missingSource = true
          break
        }
        if (group.expectedSourceShas !== undefined) {
          const slugKey = srcFile.replace(/\.md$/i, '')
          const expectedSha =
            group.expectedSourceShas[srcFile] ?? group.expectedSourceShas[slugKey]
          if (
            typeof expectedSha !== 'string' ||
            expectedSha.trim().toLowerCase() !== loaded.sha256
          ) {
            versionMismatch = true
            break
          }
        }
        const { fm } = parseMemoryFrontmatter(loaded.content)
        const rawExp = fm.expires?.trim()
        if (rawExp) {
          const parsedExp = parseMemoryExpires(rawExp)
          if (!parsedExp) {
            incompatibleTtl = true
            break
          }
          sourceExpires.push(parsedExp)
        } else {
          sourceExpires.push(null)
        }
      }

      if (missingSource) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'source_not_found' })
        continue
      }
      if (versionMismatch) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'source_version_mismatch' })
        continue
      }
      if (incompatibleTtl) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'incompatible_ttl_policy' })
        continue
      }

      // B9: Propagate earliest expires when all sources carry expires; reject mixed policies
      const withExpires = sourceExpires.filter((e): e is string => e !== null)
      if (withExpires.length > 0 && withExpires.length !== normalizedSources.length) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'incompatible_ttl_policy' })
        continue
      }
      const mergedExpires =
        withExpires.length === normalizedSources.length ? [...withExpires].sort()[0] : undefined

      const headerLines = [
        '---',
        `name: ${title}`,
        `description: ${description}`,
        `type: ${group.mergedType}`,
        'source: auto-merge',
        ...(mergedExpires ? [`expires: ${mergedExpires}`] : []),
        `merge_batch: ${batchId}`,
        `merged_from: [${normalizedSources.join(', ')}]`,
        '---',
      ]
      const rendered = `${headerLines.join('\n')}\n${body}\n`
      if (Buffer.byteLength(rendered, 'utf8') > MAX_SEMANTIC_MERGED_BYTES + 1024) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'merged_content_too_large' })
        continue
      }
      if (!scanMemoryContent(rendered).ok) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'unsafe_content' })
        continue
      }

      // Archive-first: move ONLY the verified source files
      const archRes = await archiveMemoryFilesLocked(
        realMemDir,
        realBatchDir,
        manifestEntries,
        normalizedSources,
        {
          reason:
            sanitizeSingleLineHeader(group.reason || 'semantic_auto_merge', 200) ||
            'semantic_auto_merge',
          actor,
          batchId,
        },
      )
      if (archRes.archived.length < normalizedSources.length) {
        skippedGroups.push({ targetSlug: group.targetSlug, reason: 'archive_incomplete' })
        continue
      }
      archivedEntries.push(...archRes.archived)
      archivedBytesTotal += archRes.bytesSaved

      const targetSha256 = sha256Hex(rendered)
      mergedArtifacts.push({
        batchId,
        targetFile,
        targetSha256,
        sourceFiles: normalizedSources,
        createdAt: nowIso,
      })

      // Commit manifest (with recorded targetSha256) BEFORE writing merged file
      await writeMemoryManifestData(archiveRoot, manifestEntries, mergedArtifacts)

      // Write merged target atomically (0600)
      await atomicWriteMemoryFile(join(realMemDir, targetFile), rendered)
      writtenBytesTotal += Buffer.byteLength(rendered, 'utf8')

      for (const f of normalizedSources) consumedSources.add(f)
      createdTargets.add(targetFile)
      mergedGroups.push({
        targetFile,
        targetSha256,
        sourceFiles: normalizedSources,
        reason: group.reason || 'semantic_auto_merge',
        ...(mergedExpires ? { expires: mergedExpires } : {}),
      })
    }

    for (const item of superseded) {
      const file = normalizeMemorySlugToFile(item.slug)
      if (!file) {
        skippedSuperseded.push({ slug: String(item.slug ?? ''), reason: 'invalid_slug' })
        continue
      }
      if (createdTargets.has(file) || consumedSources.has(file)) {
        skippedSuperseded.push({ slug: item.slug, reason: 'already_handled' })
        continue
      }
      const loaded = await readRegularMemoryFile(file)
      if (!loaded) {
        skippedSuperseded.push({ slug: item.slug, reason: 'not_found' })
        continue
      }
      if (
        item.expectedSha !== undefined &&
        item.expectedSha.trim().toLowerCase() !== loaded.sha256
      ) {
        skippedSuperseded.push({ slug: item.slug, reason: 'source_version_mismatch' })
        continue
      }
      const archRes = await archiveMemoryFilesLocked(
        realMemDir,
        realBatchDir,
        manifestEntries,
        [file],
        {
          reason:
            sanitizeSingleLineHeader(item.reason || 'semantic_superseded', 200) ||
            'semantic_superseded',
          actor,
          batchId,
        },
      )
      if (archRes.archived.length > 0) {
        archivedEntries.push(...archRes.archived)
        archivedBytesTotal += archRes.bytesSaved
        consumedSources.add(file)
      } else {
        skippedSuperseded.push({
          slug: item.slug,
          reason: archRes.skipped[0]?.reason ?? 'skipped',
        })
      }
    }

    if (archivedEntries.length > 0 || mergedGroups.length > 0) {
      await writeMemoryManifestData(archiveRoot, manifestEntries, mergedArtifacts)
      await reconcileIndex()
    }

    return {
      batchId,
      mergedGroups,
      archivedEntries,
      skippedGroups,
      skippedSuperseded,
      bytesSaved: Math.max(0, archivedBytesTotal - writtenBytesTotal),
    }
      },
      { checkDirs: [archiveRoot] },
    )
  } catch (err) {
    if (err instanceof MemoryBoundaryError) {
      return {
        batchId,
        mergedGroups: [],
        archivedEntries: [],
        skippedGroups: groups.map((g) => ({
          targetSlug: String(g.targetSlug ?? ''),
          reason: 'unsafe_directory_boundary',
        })),
        skippedSuperseded: superseded.map((s) => ({
          slug: String(s.slug ?? ''),
          reason: 'unsafe_directory_boundary',
        })),
        bytesSaved: 0,
      }
    }
    throw err
  }
}

// ── Archived Fallback Recall Search (OCV5-841 Wave 2) ────────────────────

export interface ArchivedSearchHit {
  id: string
  batchId: string
  kind: 'memory' | 'skill'
  target: string
  title: string
  description: string
  reason: string
  archivedAt: string
  score: number
  snippet: string
}

function extractSearchTerms(query: string): { normalizedQuery: string; terms: string[] } {
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim()
  if (!normalizedQuery) return { normalizedQuery: '', terms: [] }
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const seen = new Set<string>()
  const terms: string[] = []
  for (const part of segmenter.segment(normalizedQuery)) {
    if (!part.isWordLike) continue
    const seg = part.segment.trim()
    if (seg.length >= 2 || seg === normalizedQuery) {
      if (!seen.has(seg)) {
        seen.add(seg)
        terms.push(seg)
      }
    }
  }
  if (terms.length === 0) terms.push(normalizedQuery)
  return { normalizedQuery, terms }
}

function scoreArchivedCandidate(
  query: string,
  terms: readonly string[],
  fields: { metaText: string; bodyText: string },
): { score: number; snippet: string } {
  const metaNorm = fields.metaText.normalize('NFKC').toLocaleLowerCase()
  const bodyNorm = fields.bodyText.normalize('NFKC').toLocaleLowerCase()
  let score = 0
  let firstBodyAt = -1

  if (query.length >= 2) {
    if (metaNorm.includes(query)) score += 60
    const idx = bodyNorm.indexOf(query)
    if (idx >= 0) {
      score += 30
      firstBodyAt = idx
    }
  }
  let matchedMetaTerms = 0
  let matchedBodyTerms = 0
  for (const term of terms) {
    if (metaNorm.includes(term)) {
      matchedMetaTerms += 1
      score += 20
    }
    const idx = bodyNorm.indexOf(term)
    if (idx >= 0) {
      matchedBodyTerms += 1
      score += 10
      if (firstBodyAt < 0 || idx < firstBodyAt) firstBodyAt = idx
    }
  }
  if (score === 0) return { score: 0, snippet: '' }
  if (terms.length >= 3 && score < 30 && matchedMetaTerms + matchedBodyTerms < 2) {
    return { score: 0, snippet: '' }
  }

  let snippet = ''
  if (fields.bodyText.trim()) {
    const start = firstBodyAt >= 0 ? Math.max(0, firstBodyAt - 60) : 0
    const rawExcerpt = fields.bodyText.slice(start, start + 200).replace(/\s+/g, ' ').trim()
    snippet = `${start > 0 ? '…' : ''}${rawExcerpt}${start + 200 < fields.bodyText.length ? '…' : ''}`
  }
  return { score, snippet }
}

/**
 * Fallback lexical search over archived Core memories (manifest + unregistered
 * orphan batch carriers + legacy loose files).
 * B10: Reads & scans the COMPLETE file body + displayed metadata with
 * `scanMemoryContent` (no 4096-byte truncation); unreadable or unsafe entries
 * are skipped completely (never degraded to metadata-only).
 */
export async function searchArchivedMemories(
  agentDir: string,
  query: string,
  limit = 3,
): Promise<ArchivedSearchHit[]> {
  const { normalizedQuery, terms } = extractSearchTerms(query)
  if (!normalizedQuery) return []
  const maxHits = Math.max(1, Math.min(20, Math.floor(limit)))
  const archiveRoot = memoryArchiveRoot(agentDir)
  const entries = await listArchivedMemories(agentDir).catch(() => [])
  const hits: ArchivedSearchHit[] = []

  for (const entry of entries) {
    const safeAbs = await resolveArchivedSourcePath(
      archiveRoot,
      'memory-archive',
      entry.archivedRelPath,
      'file',
    )
    if (!safeAbs) continue
    let raw: string
    try {
      raw = await readFile(safeAbs, 'utf8')
    } catch {
      // B10: Unverifiable content must NEVER degrade to metadata-only return
      continue
    }
    const { fm, body } = parseMemoryFrontmatter(raw)
    const description = fm.description || ''
    const title = entry.title || fm.name || entry.slug
    const displayMeta = [title, entry.slug, entry.file, description, entry.reason].join('\n')
    if (!scanMemoryContent(raw).ok || !scanMemoryContent(displayMeta).ok) continue

    const metaText = [entry.slug, entry.file, title, description, entry.reason].join(' ')
    const scored = scoreArchivedCandidate(normalizedQuery, terms, { metaText, bodyText: body })
    if (scored.score <= 0) continue

    hits.push({
      id: entry.id,
      batchId: entry.batchId,
      kind: 'memory',
      target: entry.file,
      title,
      description,
      reason: entry.reason,
      archivedAt: entry.archivedAt,
      score: scored.score,
      snippet: scored.snippet || description,
    })
  }

  return hits
    .sort((a, b) => b.score - a.score || b.archivedAt.localeCompare(a.archivedAt))
    .slice(0, maxHits)
}

/**
 * Fallback lexical search over archived user skills (manifest + unregistered
 * orphan batch carriers + legacy date buckets).
 * - B2: When `opts.agentId` is provided, strictly enforces active `SkillStore`
 *   visibility scope (`agentIds` / frontmatter `agents`).
 * - B10: Reads & scans the COMPLETE `SKILL.md` body + displayed metadata with
 *   `scanMemoryContent`; unreadable or unsafe entries are skipped completely.
 */
export async function searchArchivedSkills(
  skillsDir: string,
  query: string,
  limit = 3,
  opts?: { agentId?: string; compatLocalSkillStorageId?: string },
): Promise<ArchivedSearchHit[]> {
  const { normalizedQuery, terms } = extractSearchTerms(query)
  if (!normalizedQuery) return []
  const maxHits = Math.max(1, Math.min(20, Math.floor(limit)))
  const archiveRoot = skillArchiveRoot(skillsDir)
  const entries = await listArchivedSkills(skillsDir).catch(() => [])
  const hits: ArchivedSearchHit[] = []

  for (const entry of entries) {
    const safeAbs = await resolveArchivedSourcePath(
      archiveRoot,
      'skills-archive',
      entry.archivedRelPath,
      'dir',
    )
    if (!safeAbs) continue
    let raw: string
    try {
      raw = await readFile(join(safeAbs, 'SKILL.md'), 'utf8')
    } catch {
      // B10: Unverifiable content must NEVER degrade to metadata-only return
      continue
    }

    // B2: Enforce active SkillStore agent visibility scope (including compat identity)
    const effectiveScope = await resolveEffectiveSkillAgentScope(safeAbs)
    if (!isSkillScopeVisibleToAgent(effectiveScope, opts?.agentId, opts?.compatLocalSkillStorageId)) {
      continue
    }

    const { meta, body } = parseFrontmatter(raw)
    const description = entry.description || meta.description || ''
    const displayMeta = [entry.name, description, entry.reason].join('\n')
    if (!scanMemoryContent(raw).ok || !scanMemoryContent(displayMeta).ok) continue

    const metaText = [entry.name, description, entry.reason].join(' ')
    const scored = scoreArchivedCandidate(normalizedQuery, terms, { metaText, bodyText: body })
    if (scored.score <= 0) continue

    hits.push({
      id: entry.id,
      batchId: entry.batchId,
      kind: 'skill',
      target: entry.name,
      title: entry.name,
      description,
      reason: entry.reason,
      archivedAt: entry.archivedAt,
      score: scored.score,
      snippet: scored.snippet || description,
    })
  }

  return hits
    .sort((a, b) => b.score - a.score || b.archivedAt.localeCompare(a.archivedAt))
    .slice(0, maxHits)
}
