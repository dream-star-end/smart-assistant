/**
 * Upload retention.
 *
 * Leftover chunk parts and session metas older than 24h are always removed.
 * Published files older than 30 days are removed only when a complete scan
 * shows no recent session still references them. A failed, truncated, or
 * partial scan does not delete published files. Archive chunks count.
 * The personal directory is shared, so the scan is not limited to user
 * id `default`.
 */
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  constants as fsConstants,
} from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import {
  UPLOAD_PART_MAX_AGE_MS,
  UPLOAD_RETENTION_MS,
  isStaleUploadPartName,
  shouldDeleteAgedUpload,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'

const PUBLISHED_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,32}$/
const MEDIA_REF = /(?:\/api\/media\/|\/uploads\/)([A-Za-z0-9._-]+)/g
const VOLUME_DIR = /^oc-(v3|v5)-data-u([1-9][0-9]{0,18})$/
const MAX_JSONL_FILES = 20000
const MAX_JSONL_BYTES = 32 * 1024 * 1024
const MAX_WALK_DEPTH = 6

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

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

export function sweepStalePartsInDir(dir: string, now = Date.now()): number {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const st = safeLstat(join(dir, name))
    if (!st?.isFile()) continue
    if (!isStaleUploadPartName(name, now - st.mtimeMs)) continue
    try {
      unlinkSync(join(dir, name))
      removed++
    } catch {
      /* raced with a writer */
    }
  }
  return removed
}

function publishedAged(dir: string, now: number): AgedFile[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: AgedFile[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!PUBLISHED_NAME.test(name)) continue
    const st = safeLstat(join(dir, name))
    if (!st?.isFile()) continue
    out.push({ name, ageMs: now - st.mtimeMs })
  }
  return out
}

async function readSessionRefs(dbPath: string, userId: string | null, sinceMs: number, into: Set<string>): Promise<boolean> {
  try {
    const mod = (await import('better-sqlite3')) as { default: new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => {
      prepare: (sql: string) => { all: (...args: unknown[]) => { messages?: string }[] }
      close: () => void
    } }
    const db = new mod.default(dbPath, { readonly: true, fileMustExist: true })
    try {
      const hot = db.prepare(
        `SELECT messages FROM client_sessions
          WHERE last_at >= ? AND deleted_at IS NULL
            AND (messages LIKE '%/api/media/%' OR messages LIKE '%/uploads/%')
            AND (? IS NULL OR user_id = ?)`,
      ).all(sinceMs, userId, userId)
      for (const row of hot) collectMediaNames(String(row.messages ?? ''), into)
      const archived = db.prepare(
        `SELECT c.messages AS messages
           FROM client_session_archive_chunks c
           JOIN client_sessions s ON s.id = c.session_id AND s.user_id = c.user_id
          WHERE s.last_at >= ? AND s.deleted_at IS NULL
            AND (c.messages LIKE '%/api/media/%' OR c.messages LIKE '%/uploads/%')
            AND (? IS NULL OR s.user_id = ?)`,
      ).all(sinceMs, userId, userId)
      for (const row of archived) collectMediaNames(String(row.messages ?? ''), into)
    } finally {
      db.close()
    }
    return true
  } catch {
    return false
  }
}

export function readReachedSize(size: number, pull: () => number): boolean {
  let off = 0
  while (off < size) {
    const n = pull()
    if (n <= 0) return false
    off += n
  }
  return true
}

function readCapped(path: string): { text: string; complete: boolean } {
  const st = safeLstat(path)
  if (!st?.isFile()) return { text: '', complete: true }
  if (st.size > MAX_JSONL_BYTES) return { text: '', complete: false }
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const buf = Buffer.alloc(st.size)
    let off = 0
    const complete = readReachedSize(st.size, () => {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n > 0) off += n
      return n
    })
    return { text: complete ? buf.toString('utf8') : '', complete }
  } catch {
    return { text: '', complete: false }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
  }
}

/**
 * Walk recent jsonl files. Symlinks are not followed. `uploads` and
 * `generated` directories are skipped. Hitting the file cap or an oversized
 * file marks the scan incomplete.
 */
export function scanJsonlTree(root: string, into: Set<string>): boolean {
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
    let entries: Dirent[] = []
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      complete = false
      continue
    }
    for (const entry of entries) {
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
      const read = readCapped(path)
      if (!read.complete) complete = false
      else collectMediaNames(read.text, into)
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
  const dbOk = await readSessionRefs(opts.sessionsDb, opts.userId, opts.sinceMs, names)
  let jsonlOk = true
  for (const root of opts.jsonlRoots) {
    if (!scanJsonlTree(root, names)) jsonlOk = false
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
  for (const dir of opts.sessionDirs) parts += sweepStalePartsInDir(dir, now)
  const aged = publishedAged(opts.uploadsDir, now)
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
      unlinkSync(join(opts.uploadsDir, name))
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

export async function runUploadRetentionSweep(log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown, err?: unknown) => void }): Promise<void> {
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
    entries = readdirSync('/var/lib/docker/volumes')
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
