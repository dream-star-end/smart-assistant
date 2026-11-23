/**
 * Safe preservation of multi-file skill assets (`scripts/`, `references/`,
 * `templates/`, etc.) when `SkillStore.save()` promotes or updates a skill.
 *
 * Security & atomicity invariants (OCV5-865):
 *   - Every source and destination directory/leaf is verified via `lstat` (which
 *     detects dangling symlinks, unlike `existsSync`).
 *   - Destination symlinks (live or dangling) at ANY path component abort the
 *     entire preservation with an error.
 *   - Leaf files are created exclusively with `O_CREAT | O_EXCL | O_NOFOLLOW`,
 *     preventing symlink following or clobbering at the kernel level.
 *   - Exceeding `MAX_COPY_FILES` or `MAX_COPY_DEPTH` or encountering ANY read /
 *     write error rolls back newly created files/dirs and throws so `save()`
 *     fails closed without publishing an incomplete skill.
 *   - `SKILL.md`, hidden sidecars (`.openclaude-agent-scope.json`, temp files),
 *     and `history/` are excluded so `save()` remains the sole authority for
 *     `SKILL.md`, history snapshots, and scope metadata.
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const MAX_COPY_DEPTH = 8
export const MAX_COPY_FILES = 250

const LOCK_RETRY_MS = 20
const LOCK_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 30_000
const LOCK_HEARTBEAT_MS = 5_000
const inProcessSkillLocks = new Map<string, Promise<void>>()

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    return code === 'EPERM'
  }
}

/**
 * Serializes concurrent `SkillStore.save()` operations for the same
 * `(writeRoot, skillName)` across both in-process callers and separate
 * processes (via an `O_CREAT | O_EXCL` dotfile lock in `writeRoot`), ensuring
 * version increments and history snapshots never race or drop intermediate bodies.
 */
export async function withSkillSaveLock<T>(
  writeRoot: string,
  skillName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${resolve(writeRoot)}\0${skillName}`
  const prev = inProcessSkillLocks.get(key) ?? Promise.resolve()
  let releaseInProcess!: () => void
  const current = new Promise<void>((r) => {
    releaseInProcess = r
  })
  const tail = prev.then(() => current)
  inProcessSkillLocks.set(key, tail)
  await prev

  const lockPath = join(writeRoot, `.${skillName}.save.lock`)
  const ownerToken = randomUUID()
  let lockAcquired = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (!lockAcquired) {
      try {
        const fh = await open(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        )
        await fh.writeFile(`${process.pid}:${ownerToken}:${Date.now()}\n`).catch(() => {})
        await fh.close().catch(() => {})
        lockAcquired = true
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
        if (code !== 'EEXIST') throw err
        // Reclaim lockfile ONLY if the owning PID is dead (ESRCH) or unparseable & stale.
        try {
          const [st, raw] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8').catch(() => '')])
          const pidNum = Number.parseInt(raw.split(':')[0] ?? '', 10)
          const pidKnown = Number.isInteger(pidNum) && pidNum > 0
          const ownerDead = pidKnown && !isPidAlive(pidNum)
          if (ownerDead || (!pidKnown && Date.now() - st.mtimeMs > STALE_LOCK_MS)) {
            await unlink(lockPath).catch(() => {})
            continue
          }
        } catch {
          // Lock vanished between open and stat — retry immediately.
          continue
        }
        if (Date.now() >= deadline) {
          throw new SkillAssetPreservationError(`timed out waiting for skill save lock: ${skillName}`)
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
      }
    }
    heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(lockPath, now, now).catch(() => {})
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref?.()
    return await fn()
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (lockAcquired) {
      const currentRaw = await readFile(lockPath, 'utf8').catch(() => '')
      if (currentRaw.includes(`:${ownerToken}:`)) {
        await unlink(lockPath).catch(() => {})
      }
    }
    releaseInProcess()
    if (inProcessSkillLocks.get(key) === tail) {
      inProcessSkillLocks.delete(key)
    }
  }
}

export class SkillAssetPreservationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillAssetPreservationError'
  }
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT')
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

export async function copyPreservedSkillAssets(
  sourceSkillDir: string,
  targetSkillDir: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): Promise<{ copied: string[] }> {
  const maxFiles = opts?.maxFiles ?? MAX_COPY_FILES
  const maxDepth = opts?.maxDepth ?? MAX_COPY_DEPTH

  const srcRootStat = await lstatOrNull(sourceSkillDir)
  if (!srcRootStat) return { copied: [] }
  if (srcRootStat.isSymbolicLink() || !srcRootStat.isDirectory()) {
    throw new SkillAssetPreservationError(`source skill directory is not a regular directory: ${sourceSkillDir}`)
  }

  const dstRootStat = await lstatOrNull(targetSkillDir)
  if (!dstRootStat || dstRootStat.isSymbolicLink() || !dstRootStat.isDirectory()) {
    throw new SkillAssetPreservationError(`target skill directory is a symlink or invalid: ${targetSkillDir}`)
  }

  const realSource = await realpath(sourceSkillDir)
  const realTarget = await realpath(targetSkillDir)
  if (realSource === realTarget) return { copied: [] }

  const copied: string[] = []
  const createdFiles: string[] = []
  const createdDirs: string[] = []
  const contained = (real: string, root: string) => real === root || real.startsWith(root + sep)

  const rollback = async () => {
    for (let i = createdFiles.length - 1; i >= 0; i--) {
      await unlink(createdFiles[i]!).catch(() => {})
    }
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      await rmdir(createdDirs[i]!).catch(() => {})
    }
  }

  const walk = async (srcDir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      throw new SkillAssetPreservationError(`skill asset directory exceeds max depth (${maxDepth}): ${rel}`)
    }
    const entries = await readdir(srcDir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (depth === 0 && (entry.name === 'SKILL.md' || entry.name === 'history')) continue

      const srcAbs = join(srcDir, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const dstAbs = join(realTarget, childRel)

      const st = await lstat(srcAbs)
      if (st.isSymbolicLink()) continue
      const realSrcItem = await realpath(srcAbs)
      if (!contained(realSrcItem, realSource)) {
        throw new SkillAssetPreservationError(`source asset escapes skill root: ${childRel}`)
      }

      if (st.isDirectory()) {
        const dstSt = await lstatOrNull(dstAbs)
        if (dstSt) {
          if (dstSt.isSymbolicLink() || !dstSt.isDirectory()) {
            throw new SkillAssetPreservationError(`destination directory is a symlink or non-directory: ${childRel}`)
          }
        } else {
          await mkdir(dstAbs)
          createdDirs.push(dstAbs)
        }
        const postDstSt = await lstat(dstAbs)
        if (postDstSt.isSymbolicLink() || !postDstSt.isDirectory()) {
          throw new SkillAssetPreservationError(`destination directory became a symlink: ${childRel}`)
        }
        const realDstDir = await realpath(dstAbs)
        if (!contained(realDstDir, realTarget)) {
          throw new SkillAssetPreservationError(`destination directory escapes skill root: ${childRel}`)
        }
        await walk(realSrcItem, childRel, depth + 1)
      } else if (st.isFile()) {
        if (copied.length >= maxFiles) {
          throw new SkillAssetPreservationError(`skill asset count exceeds limit (${maxFiles})`)
        }
        const dstSt = await lstatOrNull(dstAbs)
        if (dstSt) {
          if (dstSt.isSymbolicLink()) {
            throw new SkillAssetPreservationError(`destination asset is a symlink: ${childRel}`)
          }
          if (dstSt.isFile()) {
            // Preserve existing regular file in target without clobbering.
            continue
          }
          throw new SkillAssetPreservationError(`destination asset is not a regular file: ${childRel}`)
        }

        const srcFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
        const dstFlags =
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
        const srcFh = await open(realSrcItem, srcFlags)
        let bytes: Buffer
        try {
          const fstat = await srcFh.stat()
          if (!fstat.isFile()) {
            throw new SkillAssetPreservationError(`source asset is not a regular file: ${childRel}`)
          }
          bytes = await srcFh.readFile()
        } finally {
          await srcFh.close().catch(() => {})
        }

        const mode = (st.mode & 0o777) || 0o644
        const dstFh = await open(dstAbs, dstFlags, mode)
        try {
          await dstFh.writeFile(bytes)
        } catch (err) {
          await dstFh.close().catch(() => {})
          await unlink(dstAbs).catch(() => {})
          throw err
        }
        await dstFh.close()
        createdFiles.push(dstAbs)
        copied.push(childRel)
      }
    }
  }

  try {
    await walk(realSource, '', 0)
    return { copied }
  } catch (err) {
    await rollback()
    throw err
  }
}
