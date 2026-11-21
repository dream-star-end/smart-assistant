/**
 * Non-blocking startup cleanup for orphan `.tmp-*` upload files (OCV5-825).
 *
 * Replaces the synchronous `readdirSync`/`statSync`/`unlinkSync` walk that
 * previously blocked the event loop before `httpServer.listen()` on boot.
 */
import { mkdir, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000 // 1h
const PER_USER_VOLUME_RE = /^oc-(v3|v5)-data-u[1-9][0-9]{0,18}$/

export interface UploadTmpCleanupLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>, err?: unknown): void
}

export interface StartupUploadTmpCleanupOpts {
  uploadsDir: string
  includePerUserVolumes: boolean
  volumesRoot?: string
  maxAgeMs?: number
  nowMs?: number
  shouldAbort?: () => boolean
  log: UploadTmpCleanupLogger
}

export interface StartupUploadTmpCleanupResult {
  legacyCleaned: number
  perUserCleaned: number
  perUserDirsSwept: number
}

export async function sweepUploadTmpDirAsync(
  dir: string,
  cutoffMs: number,
  shouldAbort?: () => boolean,
): Promise<number> {
  let baseReal: string
  let entries: string[]
  try {
    baseReal = await realpath(dir)
    entries = await readdir(baseReal)
  } catch {
    return -1
  }
  let cleaned = 0
  for (const fname of entries) {
    if (shouldAbort?.()) break
    if (!fname.startsWith('.tmp-')) continue
    const fullPath = join(baseReal, fname)
    try {
      const st = await stat(fullPath)
      if (st.mtimeMs < cutoffMs) {
        await unlink(fullPath)
        cleaned++
      }
    } catch {
      // File may have been unlinked or renamed concurrently — ignore.
    }
  }
  return cleaned
}

export async function runStartupUploadTmpCleanup(
  opts: StartupUploadTmpCleanupOpts,
): Promise<StartupUploadTmpCleanupResult> {
  const cutoffMs = (opts.nowMs ?? Date.now()) - (opts.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS)
  let legacyCleaned = 0
  let perUserCleaned = 0
  let perUserDirsSwept = 0

  if (!opts.shouldAbort?.()) {
    try {
      await mkdir(opts.uploadsDir, { recursive: true })
      const cleaned = await sweepUploadTmpDirAsync(opts.uploadsDir, cutoffMs, opts.shouldAbort)
      if (cleaned > 0) {
        legacyCleaned = cleaned
        opts.log.info('upload .tmp orphan cleanup', { cleaned, dir: 'legacy' })
      }
    } catch (err) {
      opts.log.warn('upload .tmp orphan cleanup (legacy) failed', undefined, err)
    }
  }

  if (opts.includePerUserVolumes && !opts.shouldAbort?.()) {
    const volsRoot = opts.volumesRoot ?? '/var/lib/docker/volumes'
    try {
      const entries = await readdir(volsRoot)
      for (const entry of entries) {
        if (opts.shouldAbort?.()) break
        if (!PER_USER_VOLUME_RE.test(entry)) continue
        const userUploads = join(volsRoot, entry, '_data', 'uploads')
        const r = await sweepUploadTmpDirAsync(userUploads, cutoffMs, opts.shouldAbort)
        if (r >= 0) {
          perUserDirsSwept++
          perUserCleaned += r
        }
      }
      if (perUserCleaned > 0 || perUserDirsSwept > 0) {
        opts.log.info('upload .tmp orphan cleanup', {
          cleaned: perUserCleaned,
          dirsSwept: perUserDirsSwept,
          dir: 'per-user',
        })
      }
    } catch (err) {
      opts.log.warn('upload .tmp orphan cleanup (per-user) failed', undefined, err)
    }
  }

  return { legacyCleaned, perUserCleaned, perUserDirsSwept }
}
