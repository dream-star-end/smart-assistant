/**
 * Chunked upload sessions.
 *
 * Meta and local parts live beside the uploads directory, never inside it, so
 * `/api/media` cannot serve a session file. Remote metas live in a second
 * sibling so they do not count against the personal 10GiB quota.
 */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { UPLOAD_CHUNK_BYTES, isStaleUploadPartName, uploadChunkLength } from '@openclaude/protocol'
import { resolveOpenedPath } from './openedPath.js'

export const UPLOAD_ID_RE = /^[a-f0-9]{32}$/
export const MAX_UPLOAD_CHUNK_COUNT = 128

export interface UploadRemoteTarget {
  hostUuid: string
  remoteUploadsDir: string
}

export interface UploadSessionMeta {
  uploadId: string
  userId: string
  filename: string
  size: number
  mimeType: string
  ext: string
  chunkBytes: number
  chunkCount: number
  createdAt: number
  received: number[]
  remote: UploadRemoteTarget | null
}

export function localSessionDir(uploadsDir: string): string {
  return join(dirname(uploadsDir), '.upload-sessions')
}

export function remoteSessionDir(personalUploadsDir: string): string {
  return join(dirname(personalUploadsDir), '.upload-sessions-remote')
}

export function metaFileName(uploadId: string): string {
  return `.upload-${uploadId}.json`
}

export function partFileName(uploadId: string, index: number): string {
  return `.part-${uploadId}-${index}`
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export function writeMeta(dir: string, meta: UploadSessionMeta): void {
  if (!UPLOAD_ID_RE.test(meta.uploadId)) throw new Error('bad upload id')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const finalPath = join(dir, metaFileName(meta.uploadId))
  const tmpPath = join(dir, `.meta-tmp-${meta.uploadId}-${randomBytes(4).toString('hex')}`)
  const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  try {
    const payload = Buffer.from(JSON.stringify(meta))
    writeSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
}

export function readMeta(dir: string, uploadId: string): UploadSessionMeta | null {
  if (!UPLOAD_ID_RE.test(uploadId)) return null
  try {
    const raw = readFileSync(join(dir, metaFileName(uploadId)), 'utf8')
    const parsed = JSON.parse(raw) as Partial<UploadSessionMeta>
    if (parsed.uploadId !== uploadId) return null
    if (!Array.isArray(parsed.received)) parsed.received = []
    return parsed as UploadSessionMeta
  } catch {
    return null
  }
}

export function deleteSessionFiles(dir: string, uploadId: string, chunkCount: number): void {
  if (!UPLOAD_ID_RE.test(uploadId)) return
  for (let i = 0; i < chunkCount; i++) {
    try {
      unlinkSync(join(dir, partFileName(uploadId, i)))
    } catch {
      /* already gone */
    }
  }
  try {
    unlinkSync(join(dir, metaFileName(uploadId)))
  } catch {
    /* already gone */
  }
}

export function listReceived(dir: string, meta: UploadSessionMeta): number[] {
  if (meta.remote) {
    return [...meta.received].filter((index) => Number.isInteger(index) && index >= 0 && index < meta.chunkCount)
  }
  const out: number[] = []
  for (let index = 0; index < meta.chunkCount; index++) {
    const st = safeStat(join(dir, partFileName(meta.uploadId, index)))
    if (!st?.isFile()) continue
    if (st.size !== uploadChunkLength(meta.size, index, meta.chunkBytes)) continue
    out.push(index)
  }
  return out
}

export function confirmedReceived(meta: UploadSessionMeta, present: (index: number) => boolean): number[] {
  const out: number[] = []
  for (let index = 0; index < meta.chunkCount; index++) {
    if (!meta.received.includes(index)) continue
    if (!present(index)) continue
    out.push(index)
  }
  return out
}

export function remotePartUploadId(name: string): string | null {
  const match = /^\.part-([a-f0-9]{32})-\d+$/.exec(name)
  return match ? match[1] : null
}

export function isOrphanRemotePart(name: string, liveIds: ReadonlySet<string>): boolean {
  const id = remotePartUploadId(name)
  if (!id) return false
  return !liveIds.has(id)
}

/** Ids whose meta file is still inside the 24h resume window. Null if the directory cannot be read. */
export function freshUploadIds(sessionDir: string, now = Date.now()): Set<string> | null {
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return null
  }
  const live = new Set<string>()
  for (const name of names) {
    const match = /^\.upload-([a-f0-9]{32})\.json$/.exec(name)
    if (!match) continue
    const st = safeStat(join(sessionDir, name))
    if (!st?.isFile()) continue
    if (isStaleUploadPartName(name, now - st.mtimeMs)) continue
    live.add(match[1])
  }
  return live
}

function listMetas(sessionDir: string): UploadSessionMeta[] {
  let names: string[] = []
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  const out: UploadSessionMeta[] = []
  for (const name of names) {
    const match = name.match(/^\.upload-([a-f0-9]{32})\.json$/)
    if (!match) continue
    const meta = readMeta(sessionDir, match[1])
    if (meta) out.push(meta)
  }
  return out
}

/**
 * Published regular files (names that do not start with `.`) plus each live
 * local meta's declared size. Part bytes that belong to a live meta are not
 * added again. Orphan parts whose id has no meta are added.
 * Remote metas are ignored; they live in a different directory.
 */
export function sumUploadReservationBytes(uploadsDir: string, sessionDir: string): number {
  let used = 0
  try {
    for (const name of readdirSync(uploadsDir)) {
      if (name.startsWith('.')) continue
      const st = safeStat(join(uploadsDir, name))
      if (st?.isFile()) used += st.size
    }
  } catch {
    /* uploads dir may not exist yet */
  }
  const live = new Set<string>()
  for (const meta of listMetas(sessionDir)) {
    if (meta.remote) continue
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) continue
    live.add(meta.uploadId)
    used += meta.size
  }
  let names: string[] = []
  try {
    names = readdirSync(sessionDir)
  } catch {
    names = []
  }
  for (const name of names) {
    const match = name.match(/^\.part-([a-f0-9]{32})-\d+$/)
    if (!match || live.has(match[1])) continue
    const st = safeStat(join(sessionDir, name))
    if (st?.isFile()) used += st.size
  }
  return used
}

/** Bytes of a remote upload that are not yet on the agent. */
export function remoteReservationRemainder(sessionDir: string, target: UploadRemoteTarget): number {
  let extra = 0
  for (const meta of listMetas(sessionDir)) {
    if (!meta.remote) continue
    if (meta.remote.hostUuid !== target.hostUuid) continue
    if (meta.remote.remoteUploadsDir !== target.remoteUploadsDir) continue
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) continue
    let onAgent = 0
    for (const index of meta.received) {
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) continue
      onAgent += uploadChunkLength(meta.size, index, meta.chunkBytes || UPLOAD_CHUNK_BYTES)
    }
    extra += Math.max(0, meta.size - onAgent)
  }
  return extra
}

export function markChunkReceived(dir: string, meta: UploadSessionMeta, index: number): void {
  const fresh = readMeta(dir, meta.uploadId) ?? meta
  if (!fresh.received.includes(index)) fresh.received.push(index)
  fresh.received.sort((a, b) => a - b)
  writeMeta(dir, fresh)
  meta.received = fresh.received
}

/**
 * Write one local part. The caller already checked the byte length.
 * Returns whether an existing matching part was left untouched.
 */
export function writeLocalPart(dir: string, meta: UploadSessionMeta, index: number, body: Buffer): 'stored' | 'idempotent' {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dirReal = realpathSync(dir)
  const finalPath = join(dirReal, partFileName(meta.uploadId, index))
  const existing = safeStat(finalPath)
  if (existing?.isFile() && existing.size === body.length) return 'idempotent'
  const tmpPath = join(dirReal, `.part-tmp-${meta.uploadId}-${index}-${randomBytes(4).toString('hex')}`)
  const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  try {
    const opened = resolveOpenedPath(fd, tmpPath)
    if (opened !== tmpPath) {
      throw new Error('part path diverged')
    }
    writeSync(fd, body)
    fsyncSync(fd)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* tmp may not exist */
    }
    throw err
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
  return 'stored'
}

export function newUploadId(): string {
  return randomBytes(16).toString('hex')
}
