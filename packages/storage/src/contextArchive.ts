/**
 * First-class reversible archive for Core memories (`memory-archive/`) and
 * user skills (`skills-archive/`).
 *
 * Design invariants:
 * - Every archived item gets an immutable, non-overwritable carrier path:
 *     Core:  `memory-archive/batches/<batchId>/<entryId>__<file>`
 *     Skill: `skills-archive/batches/<batchId>/<entryId>__<name>`
 *   Re-archiving the same filename/skill under the same `batchId` can never
 *   overwrite an earlier archived revision.
 * - Crash/interruption recovery: `listArchived*` and `restoreArchived*` also
 *   scan `batches/<batchId>/` for already-moved carriers that were not yet recorded in
 *   `archive-manifest.json`, preventing data loss between move and manifest commit.
 * - Strict archive-root containment: restore sources must resolve strictly
 *   inside the dedicated `memory-archive/` or `skills-archive/` root via
 *   `lstat` (no symlinks) + `realpath` containment.
 * - Every archive/restore operation writes `archive-manifest.json` atomically
 *   (temp file + chmod 0600 + rename) under the authoritative lock:
 *   - Core memory: `MemoryDir.withExclusiveMemoryLock` + `reconcileIndex()`
 *   - User skills: `acquireFileLock(<skills-archive>/.archive.lock)`
 * - Idempotent & non-destructive: missing sources skip cleanly, repeated
 *   restores no-op, and live name collisions skip (`target_exists`).
 * - Backward-compatible with pre-existing manual archives (`memory-archive/*.md`
 *   and `skills-archive/<date>/<skill>`).
 */

import { randomUUID } from 'node:crypto'
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
import { basename, dirname, join, resolve, sep } from 'node:path'

import { createMemoryDirForAgentDir } from './memoryDir.js'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { acquireFileLock } from './memoryShared.js'
import { parseFrontmatter, validateSkillName } from './skillStore.js'

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
  title?: string
  type?: string
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
}

interface MemoryArchiveManifest {
  schemaVersion: 1
  entries: ArchivedMemoryEntry[]
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
 * non-symlink lstat, expected entry type, and realpath containment.
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

async function readMemoryManifest(archiveRoot: string): Promise<ArchivedMemoryEntry[]> {
  const manifestPath = join(archiveRoot, MANIFEST_FILE)
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryArchiveManifest>
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(
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
  } catch {
    return []
  }
}

async function writeMemoryManifest(
  archiveRoot: string,
  entries: ArchivedMemoryEntry[],
): Promise<void> {
  await atomicWriteJsonFile(join(archiveRoot, MANIFEST_FILE), {
    schemaVersion: 1,
    entries,
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

  return await memdir.withExclusiveMemoryLock(async ({ dirPath, reconcileIndex }) => {
    const manifestEntries = await readMemoryManifest(archiveRoot)
    const archived: ArchivedMemoryEntry[] = []
    const skipped: Array<{ file: string; reason: string }> = []
    let bytesSaved = 0
    const nowIso = new Date().toISOString()

    let realMemDir: string | null = null
    try {
      if (existsSync(dirPath)) realMemDir = await realpath(dirPath)
    } catch {
      realMemDir = null
    }

    for (const file of uniqueFiles) {
      if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) {
        skipped.push({ file, reason: 'invalid_filename' })
        continue
      }
      if (!realMemDir) {
        skipped.push({ file, reason: 'not_found' })
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

      const raw = await readFile(realSrc, 'utf8')
      const bytes = Buffer.byteLength(raw, 'utf8')
      const { fm } = parseMemoryFrontmatter(raw)
      const entryId = `mem-${randomUUID().slice(0, 12)}`
      const carrierName = `${entryId}__${file}`
      const archivedRelPath = `memory-archive/${BATCHES_DIR}/${batchId}/${carrierName}`
      const dstPath = join(archiveRoot, BATCHES_DIR, batchId, carrierName)

      await moveFileSafe(realSrc, dstPath)

      const entry: ArchivedMemoryEntry = {
        id: entryId,
        batchId,
        slug: file.replace(/\.md$/i, ''),
        file,
        originalRelPath: `memory/${file}`,
        archivedRelPath,
        archivedAt: nowIso,
        reason,
        actor,
        bytes,
        ...(fm.name ? { title: fm.name } : {}),
        ...(fm.type ? { type: fm.type } : {}),
      }
      manifestEntries.push(entry)
      archived.push(entry)
      bytesSaved += bytes
    }

    if (archived.length > 0) {
      await writeMemoryManifest(archiveRoot, manifestEntries)
      await reconcileIndex()
    }

    return { batchId, archived, skipped, bytesSaved }
  })
}

/**
 * List all archived Core memories (manifest-tracked + unregistered batch
 * carriers + legacy loose `.md` files), newest first. Fail-open if absent.
 */
export async function listArchivedMemories(agentDir: string): Promise<ArchivedMemoryEntry[]> {
  const archiveRoot = memoryArchiveRoot(agentDir)
  const manifest = await readMemoryManifest(archiveRoot)
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

/**
 * Restore archived Core memories by single `id` or whole `batchId` under
 * `MemoryDir` exclusive lock, updating `archive-manifest.json` and reconciling
 * `MEMORY.md`. Idempotent and never clobbers existing live files.
 */
export async function restoreArchivedMemories(
  agentDir: string,
  filter: { id?: string; batchId?: string },
): Promise<{
  restored: ArchivedMemoryEntry[]
  skipped: Array<{ id: string; file: string; reason: string }>
}> {
  const targetId = filter.id?.trim() || undefined
  const targetBatchId = filter.batchId?.trim() || undefined
  if (!targetId && !targetBatchId) {
    return { restored: [], skipped: [] }
  }

  const memdir = createMemoryDirForAgentDir(agentDir)
  const archiveRoot = memoryArchiveRoot(agentDir)

  return await memdir.withExclusiveMemoryLock(async ({ dirPath, reconcileIndex }) => {
    const manifestEntries = await readMemoryManifest(archiveRoot)
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
      return { restored: [], skipped: [] }
    }

    await mkdir(dirPath, { recursive: true })
    const restored: ArchivedMemoryEntry[] = []
    const skipped: Array<{ id: string; file: string; reason: string }> = []
    const removedIds = new Set<string>()

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
      const liveDst = join(dirPath, entry.file)
      if (existsSync(liveDst)) {
        skipped.push({ id: entry.id, file: entry.file, reason: 'target_exists' })
        continue
      }
      await moveFileSafe(archivedAbs, liveDst)
      restored.push(entry)
      removedIds.add(entry.id)
    }

    if (removedIds.size > 0) {
      const remaining = manifestEntries.filter((e) => !removedIds.has(e.id))
      if (remaining.length !== manifestEntries.length) {
        await writeMemoryManifest(archiveRoot, remaining)
      }
    }
    if (restored.length > 0) {
      await reconcileIndex()
    }

    return { restored, skipped }
  })
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
 * `<dirname(skillsDir)>/skills-archive/batches/<batchId>/<entryId>__<name>`.
 */
export async function archiveUserSkill(
  skillsDir: string,
  name: string,
  options: { reason: string; actor?: string; batchId?: string },
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

  const archiveRoot = skillArchiveRoot(skillsDir)
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
  const release = await acquireFileLock(join(archiveRoot, '.archive.lock'))
  try {
    if (!existsSync(skillsDir)) {
      return { batchId, entry: null, skippedReason: 'not_found' }
    }
    const realSkillsRoot = await realpath(skillsDir)
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

    let description: string | undefined
    try {
      const raw = await readFile(skillMdPath, 'utf8')
      const { meta } = parseFrontmatter(raw)
      if (meta.description) description = meta.description
    } catch {
      // optional
    }
    const bytes = await dirSizeBytes(realSrc)
    const entryId = `skill-${randomUUID().slice(0, 12)}`
    const carrierName = `${entryId}__${cleanName}`
    const archivedRelPath = `skills-archive/${BATCHES_DIR}/${batchId}/${carrierName}`
    const dstDir = join(archiveRoot, BATCHES_DIR, batchId, carrierName)

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
  const archiveRoot = skillArchiveRoot(skillsDir)
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
    existingManifest.push(entry)
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

  const archiveRoot = skillArchiveRoot(skillsDir)
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
  const release = await acquireFileLock(join(archiveRoot, '.archive.lock'))
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

    await mkdir(skillsDir, { recursive: true })
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
      const liveDst = join(skillsDir, entry.name)
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
