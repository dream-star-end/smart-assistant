/**
 * Upload retention.
 *
 * Automatic sweeps are disabled unless OC_UPLOAD_RETENTION_ENABLED=1.
 * Enabled sweeps remove leftover chunk parts and session metas older than 24h.
 * Published files older than 30 days are removed only when a complete scan
 * shows no recent session still references them. A failed, truncated, or
 * partial scan does not delete published files. Archive chunks count.
 * The personal directory is shared, so the scan is not limited to user
 * id `default`.
 */
import { constants as fsConstants } from 'node:fs'
import { lstat, open, opendir, readdir, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import {
  UPLOAD_PART_MAX_AGE_MS,
  UPLOAD_RETENTION_MS,
  isStaleUploadPartName,
  shouldDeleteAgedUpload,
} from '@openclaude/protocol'
import { paths, scanRecentClientSessionMessages } from '@openclaude/storage'
import { isV3ContainerRuntime } from './hostStaticProviders.js'

const PUBLISHED_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,32}$/
const MEDIA_REF = /(?:\/api\/media\/|\/uploads\/)([A-Za-z0-9._-]+)/g
const VOLUME_DIR = /^oc-(v3|v5)-data-u([1-9][0-9]{0,18})$/
const MAX_JSONL_FILES = 20000
const MAX_JSONL_BYTES = 32 * 1024 * 1024
const MAX_WALK_DEPTH = 6
const READ_CHUNK_BYTES = 256 * 1024
// Longer than /api/media/ + 64 hex + dot + 32 extension characters.
const REF_OVERLAP_BYTES = 256

export interface AgedFile {
  name: string
  ageMs: number
}

export interface RefScan {
  names: Set<string>
  complete: boolean
}

let retentionStop: (() => void) | null = null

export function planAgedDeletes(files: AgedFile[], refs: Set<string>, complete: boolean): string[] {
  if (!complete) return []
  const doomed: string[] = []
  for (const file of files) {
    if (!PUBLISHED_NAME.test(file.name)) continue
    if (shouldDeleteAgedUpload(file.ageMs, refs.has(file.name))) doomed.push(file.name)
  }
  return doomed
}

export function collectMediaNames(text: string, into: Set<string>): void {
  MEDIA_REF.lastIndex = 0
  for (const match of text.matchAll(MEDIA_REF)) {
    const name = match[1]
    if (PUBLISHED_NAME.test(name)) into.add(name)
  }
}

async function safeLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

export async function sweepStalePartsInDir(dir: string, now = Date.now()): Promise<number> {
  let removed = 0
  try {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name)
      const st = await safeLstat(path)
      if (!st?.isFile() || !isStaleUploadPartName(entry.name, now - st.mtimeMs)) continue
      try {
        await unlink(path)
        removed++
      } catch {
        /* raced with a writer */
      }
    }
  } catch {
    /* missing or unreadable directory */
  }
  return removed
}

async function publishedAged(dir: string, now: number): Promise<AgedFile[]> {
  const out: AgedFile[] = []
  try {
    for await (const entry of await opendir(dir)) {
      if (!PUBLISHED_NAME.test(entry.name)) continue
      const st = await safeLstat(join(dir, entry.name))
      if (st?.isFile()) out.push({ name: entry.name, ageMs: now - st.mtimeMs })
    }
  } catch {
    /* missing or unreadable directory */
  }
  return out
}

export async function readReachedSize(size: number, pull: () => Promise<number>): Promise<boolean> {
  let off = 0
  while (off < size) {
    const n = await pull()
    if (n <= 0) return false
    off += n
  }
  return true
}

async function readCapped(path: string, into: Set<string>): Promise<boolean> {
  const st = await safeLstat(path)
  if (!st?.isFile() || st.size > MAX_JSONL_BYTES) return false
  let fd: Awaited<ReturnType<typeof open>> | undefined
  let complete = false
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    fd = handle
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_JSONL_BYTES) return false
    const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, opened.size))
    let off = 0
    let tail = ''
    complete = await readReachedSize(opened.size, async () => {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, opened.size - off), off)
      if (bytesRead <= 0) return 0
      off += bytesRead
      const text = tail + buf.toString('utf8', 0, bytesRead)
      collectMediaNames(text, into)
      tail = text.slice(-REF_OVERLAP_BYTES)
      await yieldToEventLoop()
      return bytesRead
    })
  } catch {
    complete = false
  } finally {
    try {
      await fd?.close()
    } catch {
      complete = false
    }
  }
  return complete
}

/**
 * Walk recent jsonl files. Symlinks are not followed. `uploads` and
 * `generated` directories are skipped. Hitting the file cap or an oversized
 * file marks the scan incomplete.
 */
export async function scanJsonlTree(root: string, into: Set<string>): Promise<boolean> {
  let complete = true
  let visited = 0
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > MAX_WALK_DEPTH) {
      complete = false
      continue
    }
    try {
      for await (const entry of await opendir(current.dir)) {
        if (entry.isSymbolicLink()) continue
        const path = join(current.dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'uploads' || entry.name === 'generated') continue
          stack.push({ dir: path, depth: current.depth + 1 })
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        visited++
        if (visited > MAX_JSONL_FILES) return false
        if (!await readCapped(path, into)) complete = false
      }
    } catch {
      complete = false
    }
  }
  return complete
}

export async function scanRefsForUploads(opts: {
  userId: string | null
  sessionsDb: string
  sinceMs: number
  jsonlRoots: string[]
}): Promise<RefScan> {
  const names = new Set<string>()
  // A container cannot see the master's authoritative recent sessions.
  const dbOk = !isV3ContainerRuntime() && await scanRecentClientSessionMessages({
    sessionsDb: opts.sessionsDb, userId: opts.userId, sinceMs: opts.sinceMs,
  }, body => collectMediaNames(body, names))
  let jsonlOk = true
  for (const root of opts.jsonlRoots) {
    if (!await scanJsonlTree(root, names)) jsonlOk = false
  }
  return { names, complete: dbOk && jsonlOk }
}

function userIdForVolume(entry: string): string | null {
  const match = entry.match(VOLUME_DIR)
  if (!match) return null
  return `c:${match[2]}`
}

export async function sweepUploadDir(opts: {
  uploadsDir: string
  sessionDirs: string[]
  userId: string | null
  sessionsDb: string
  jsonlRoots: string[]
  now?: number
}): Promise<{ parts: number; published: number; skippedAged: boolean }> {
  const now = opts.now ?? Date.now()
  let parts = 0
  for (const dir of opts.sessionDirs) parts += await sweepStalePartsInDir(dir, now)
  const aged = await publishedAged(opts.uploadsDir, now)
  const oldEnough = aged.filter((file) => file.ageMs >= UPLOAD_RETENTION_MS)
  if (oldEnough.length === 0) return { parts, published: 0, skippedAged: false }
  const refs = await scanRefsForUploads({
    userId: opts.userId,
    sessionsDb: opts.sessionsDb,
    sinceMs: now - UPLOAD_RETENTION_MS,
    jsonlRoots: opts.jsonlRoots,
  })
  if (!refs.complete) return { parts, published: 0, skippedAged: true }
  let published = 0
  for (const name of planAgedDeletes(oldEnough, refs.names, true)) {
    try {
      await unlink(join(opts.uploadsDir, name))
      published++
    } catch {
      /* raced */
    }
  }
  return { parts, published, skippedAged: false }
}

function personalJsonlRoots(): string[] {
  return [join(paths.home, 'agents')]
}

function volumeJsonlRoots(volumeData: string): string[] {
  return [volumeData, join(paths.home, 'agents')]
}

export function isUploadRetentionEnabled(): boolean {
  return process.env.OC_UPLOAD_RETENTION_ENABLED === '1'
}

let retentionRunning = false

export async function runUploadRetentionSweep(log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown, err?: unknown) => void }): Promise<void> {
  if (!isUploadRetentionEnabled() || retentionRunning) return
  retentionRunning = true
  try {
    await runEnabledSweep(log)
  } finally {
    retentionRunning = false
  }
}

async function runEnabledSweep(log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown, err?: unknown) => void }): Promise<void> {
  const personalSessions = localSessions(paths.uploadsDir)
  try {
    const result = await sweepUploadDir({
      uploadsDir: paths.uploadsDir,
      sessionDirs: personalSessions,
      userId: null,
      sessionsDb: paths.sessionsDb,
      jsonlRoots: personalJsonlRoots(),
    })
    if (result.parts > 0 || result.published > 0) {
      log?.info?.('upload retention sweep', { scope: 'personal', ...result })
    }
  } catch (err) {
    log?.warn?.('upload retention sweep failed', { scope: 'personal' }, err)
  }
  let entries: string[] = []
  try {
    entries = await readdir('/var/lib/docker/volumes')
  } catch {
    return
  }
  for (const entry of entries) {
    const userId = userIdForVolume(entry)
    if (!userId) continue
    const data = join('/var/lib/docker/volumes', entry, '_data')
    const uploadsDir = join(data, 'uploads')
    try {
      const result = await sweepUploadDir({
        uploadsDir,
        sessionDirs: [join(data, '.upload-sessions'), join(data, '.upload-sessions-remote')],
        userId,
        sessionsDb: paths.sessionsDb,
        jsonlRoots: volumeJsonlRoots(data),
      })
      if (result.parts > 0 || result.published > 0) {
        log?.info?.('upload retention sweep', { scope: entry, ...result })
      }
    } catch (err) {
      log?.warn?.('upload retention sweep failed', { scope: entry }, err)
    }
  }
}

function localSessions(uploadsDir: string): string[] {
  const parent = join(uploadsDir, '..')
  return [join(parent, '.upload-sessions'), join(parent, '.upload-sessions-remote')]
}

export function startUploadRetention(log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown, err?: unknown) => void }): void {
  stopUploadRetention()
  if (!isUploadRetentionEnabled()) {
    log?.info?.('upload retention disabled', { enableWith: 'OC_UPLOAD_RETENTION_ENABLED=1' })
    return
  }
  const tick = () => {
    void runUploadRetentionSweep(log)
  }
  const timer = setInterval(tick, 60 * 60 * 1000)
  timer.unref?.()
  retentionStop = () => clearInterval(timer)
}

export function stopUploadRetention(): void {
  retentionStop?.()
  retentionStop = null
}
