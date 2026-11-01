/**
 * Chunked upload HTTP.
 *
 * One request body stays at or below 32MiB (chunks are 16MiB). The assembled
 * file may be 1GiB. Single-shot POST /api/uploads is unchanged and still
 * rejects a body over 100MiB.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  MAX_UPLOAD_CHUNK_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_RETENTION_MS,
  uploadChunkCount,
  uploadChunkLength,
  uploadFileLimitMessage,
  uploadQuotaExceeded,
  uploadQuotaMessage,
  shouldDeleteAgedUpload,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { isUploadMimeAllowed, uploadExtForMime } from './gatewayFilePolicy.js'
import type { HttpMiscHandlersHost } from './httpMiscHandlers.js'
import { publishOpenedUpload } from './httpMiscHandlers.js'
import { SAFE_UPLOAD_EXTENSION_RE } from './httpUploadStatic.js'
import { resolveOpenedPath } from './openedPath.js'
import {
  MAX_UPLOAD_CHUNK_COUNT,
  UPLOAD_ID_RE,
  deleteSessionFiles,
  listReceived,
  localSessionDir,
  markChunkReceived,
  newUploadId,
  partFileName,
  readMeta,
  remoteReservationRemainder,
  remoteSessionDir,
  sumUploadReservationBytes,
  writeLocalPart,
  writeMeta,
  type UploadSessionMeta,
} from './uploadChunkStore.js'
import { scanRefsForUploads } from './uploadRetention.js'

const PUBLISHED_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,32}$/
const INIT_BODY_MAX = 65536

interface RemoteUsageFile {
  name: string
  size: number
  mtimeMs: number
}

interface RemoteUsage {
  usedBytes: number
  truncated: boolean
  files: RemoteUsageFile[]
}

function baseName(name: string): string {
  const part = name.replace(/\\/g, '/').split('/').pop() || 'file'
  return part.slice(0, 255) || 'file'
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(Object.assign(new Error('body too large'), { statusCode: 413 }))
        try {
          req.destroy()
        } catch {
          /* already gone */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => fail(err))
    req.on('aborted', () => fail(new Error('aborted')))
  })
}

function rejectEarlyLength(host: HttpMiscHandlersHost, req: IncomingMessage, res: ServerResponse, maxBytes: number): boolean {
  const declared = req.headers['content-length']
  if (declared === undefined) return false
  const n = Number(declared)
  if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(declared))) {
    host.sendError(res, 400, 'invalid content-length')
    try {
      req.destroy()
    } catch {
      /* already gone */
    }
    return true
  }
  if (n > maxBytes) {
    host.sendError(res, 413, `chunk exceeds ${Math.round(maxBytes / 1024 / 1024)}MB`)
    try {
      req.destroy()
    } catch {
      /* already gone */
    }
    return true
  }
  return false
}

async function ensureUploadContainer(host: HttpMiscHandlersHost, userId: string, res: ServerResponse): Promise<boolean> {
  const ensure = host.deps.commercial?.ensureContainerReady
  if (!ensure || !/^c:[1-9][0-9]{0,18}$/.test(userId)) return true
  const uid = BigInt(userId.slice(2))
  if (uid > BigInt(Number.MAX_SAFE_INTEGER)) return true
  try {
    const ready = await ensure(uid)
    if (!ready.ok) {
      res.setHeader('Retry-After', String(ready.retryAfterSec))
      host.sendError(res, 503, `container not ready: ${ready.reason}`)
      return false
    }
  } catch (err) {
    host.log.warn('chunked upload: ensureContainerReady threw', { userId }, err)
    res.setHeader('Retry-After', '5')
    host.sendError(res, 503, 'container not ready')
    return false
  }
  return true
}

interface PlacedUpload {
  uploadsDir: string
  baseReal: string
  isPerUser: boolean
  sessionDir: string
  remote: UploadSessionMeta['remote']
}

async function placeUpload(host: HttpMiscHandlersHost, userId: string, res: ServerResponse): Promise<PlacedUpload | null> {
  const location = await host._resolveMediaDirs(userId)
  let uploadsDir: string
  let isPerUser = false
  let remote: UploadSessionMeta['remote'] = null
  if (location.kind === 'fail') {
    if (location.reason === 'remote-host' && host.deps.commercial?.pushRemoteHostUpload) {
      remote = { hostUuid: location.hostUuid, remoteUploadsDir: location.uploads }
      uploadsDir = paths.uploadsDir
    } else if (location.reason === 'remote-host') {
      host.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
      return null
    } else {
      host._sendMediaResolveError(res, location, 'upload')
      return null
    }
  } else {
    uploadsDir = location.uploads
    isPerUser = location.kind === 'ok'
  }
  let baseReal: string
  try {
    mkdirSync(uploadsDir, { recursive: true })
    baseReal = realpathSync(uploadsDir)
  } catch (err) {
    host.log.error('chunked upload: uploadsDir setup failed', { uploadsDir }, err)
    host.sendError(res, 500, 'storage unavailable')
    return null
  }
  const sessionDir = remote ? remoteSessionDir(paths.uploadsDir) : localSessionDir(baseReal)
  return { uploadsDir: baseReal, baseReal, isPerUser, sessionDir, remote }
}

async function quotaUsed(host: HttpMiscHandlersHost, userId: string, placed: PlacedUpload): Promise<number | null> {
  if (!placed.remote) return sumUploadReservationBytes(placed.baseReal, placed.sessionDir)
  const sumRemote = host.deps.commercial?.sumRemoteUploadUsage
  if (!sumRemote) return null
  const usage = await sumRemote({
    hostUuid: placed.remote.hostUuid,
    remoteDir: placed.remote.remoteUploadsDir,
  })
  const usedAfterSweep = await sweepRemoteAged(host, userId, placed, usage)
  return usedAfterSweep + remoteReservationRemainder(placed.sessionDir, placed.remote)
}

async function sweepRemoteAged(
  host: HttpMiscHandlersHost,
  userId: string,
  placed: PlacedUpload,
  usage: RemoteUsage,
): Promise<number> {
  if (!placed.remote || usage.truncated || !Array.isArray(usage.files)) return usage.usedBytes
  const del = host.deps.commercial?.deleteRemoteHostUpload
  if (!del) return usage.usedBytes
  let refsComplete = false
  let names = new Set<string>()
  try {
    const refs = await scanRefsForUploads({
      userId,
      sessionsDb: paths.sessionsDb,
      sinceMs: Date.now() - UPLOAD_RETENTION_MS,
      jsonlRoots: [join(paths.home, 'agents')],
    })
    refsComplete = refs.complete
    names = refs.names
  } catch {
    return usage.usedBytes
  }
  if (!refsComplete) return usage.usedBytes
  let used = usage.usedBytes
  const now = Date.now()
  for (const file of usage.files) {
    if (!PUBLISHED_NAME.test(file.name)) continue
    if (!shouldDeleteAgedUpload(now - file.mtimeMs, names.has(file.name))) continue
    try {
      await del({
        hostUuid: placed.remote.hostUuid,
        remotePath: `${placed.remote.remoteUploadsDir}/${file.name}`,
      })
      used -= Number.isFinite(file.size) ? file.size : 0
    } catch (err) {
      host.log.warn('chunked upload: remote aged delete failed', { name: file.name }, err)
    }
  }
  return Math.max(0, used)
}

function sendQuota(host: HttpMiscHandlersHost, res: ServerResponse, used: number, incoming: number): void {
  host.sendJson(res, 413, {
    error: uploadQuotaMessage(used, incoming),
    code: 'upload_quota_exceeded',
  })
}

function loadOwned(
  host: HttpMiscHandlersHost,
  res: ServerResponse,
  userId: string,
  sessionDir: string,
  uploadId: string,
): UploadSessionMeta | null {
  const meta = readMeta(sessionDir, uploadId)
  if (!meta || meta.userId !== userId) {
    host.sendError(res, 404, 'upload not found')
    return null
  }
  return meta
}

function statusBody(meta: UploadSessionMeta, received: number[]) {
  return {
    uploadId: meta.uploadId,
    size: meta.size,
    chunkBytes: meta.chunkBytes,
    chunkCount: meta.chunkCount,
    received,
  }
}

async function handleInit(host: HttpMiscHandlersHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = host.getUserId(req)
  if (!userId) {
    host.sendError(res, 401, 'unauthorized')
    return
  }
  if (!(await ensureUploadContainer(host, userId, res))) return
  let raw: string
  try {
    raw = await host.readBody(req, INIT_BODY_MAX)
  } catch {
    host.sendError(res, 400, 'invalid upload init')
    return
  }
  let body: { filename?: unknown; size?: unknown; mimeType?: unknown }
  try {
    body = JSON.parse(raw) as { filename?: unknown; size?: unknown; mimeType?: unknown }
  } catch {
    host.sendError(res, 400, 'invalid upload init')
    return
  }
  const size = body.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    host.sendError(res, 400, 'invalid upload size')
    return
  }
  if (size > MAX_UPLOAD_FILE_BYTES) {
    host.sendError(res, 413, uploadFileLimitMessage(size))
    return
  }
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.split(';')[0].trim().toLowerCase() : ''
  if (!mimeType || !isUploadMimeAllowed(mimeType)) {
    host.sendError(res, 415, `unsupported mime: ${mimeType || 'missing'}`)
    return
  }
  const filename = baseName(typeof body.filename === 'string' ? body.filename : 'file')
  const ext = uploadExtForMime(mimeType, filename)
  if (!SAFE_UPLOAD_EXTENSION_RE.test(ext)) {
    host.sendError(res, 415, 'unsupported extension')
    return
  }
  let chunkCount = 0
  try {
    chunkCount = uploadChunkCount(size, UPLOAD_CHUNK_BYTES)
  } catch {
    host.sendError(res, 400, 'invalid upload size')
    return
  }
  if (chunkCount > MAX_UPLOAD_CHUNK_COUNT) {
    host.sendError(res, 413, uploadFileLimitMessage(size))
    return
  }
  const placed = await placeUpload(host, userId, res)
  if (!placed) return
  let used: number | null
  try {
    used = await quotaUsed(host, userId, placed)
  } catch (err) {
    host.log.warn('chunked upload: quota check failed', { userId }, err)
    host.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
    return
  }
  if (used === null) {
    host.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
    return
  }
  if (uploadQuotaExceeded(used, size)) {
    sendQuota(host, res, used, size)
    return
  }
  const uploadId = newUploadId()
  const meta: UploadSessionMeta = {
    uploadId,
    userId,
    filename,
    size,
    mimeType,
    ext,
    chunkBytes: UPLOAD_CHUNK_BYTES,
    chunkCount,
    createdAt: Date.now(),
    received: [],
    remote: placed.remote,
  }
  try {
    writeMeta(placed.sessionDir, meta)
  } catch (err) {
    host.log.error('chunked upload: meta write failed', { uploadId }, err)
    host.sendError(res, 500, 'storage unavailable')
    return
  }
  host.sendJson(res, 200, statusBody(meta, []))
}

async function resolveSessionForRequest(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ userId: string; placed: PlacedUpload } | null> {
  const userId = host.getUserId(req)
  if (!userId) {
    host.sendError(res, 401, 'unauthorized')
    return null
  }
  const placed = await placeUpload(host, userId, res)
  if (!placed) return null
  return { userId, placed }
}

async function handleStatus(host: HttpMiscHandlersHost, req: IncomingMessage, res: ServerResponse, uploadId: string): Promise<void> {
  const placedReq = await resolveSessionForRequest(host, req, res)
  if (!placedReq) return
  const meta = loadOwned(host, res, placedReq.userId, placedReq.placed.sessionDir, uploadId)
  if (!meta) return
  host.sendJson(res, 200, statusBody(meta, listReceived(placedReq.placed.sessionDir, meta)))
}

async function pushRemotePart(host: HttpMiscHandlersHost, meta: UploadSessionMeta, index: number, body: Buffer): Promise<void> {
  if (!meta.remote) return
  const push = host.deps.commercial?.pushRemoteHostUpload
  if (!push) throw new Error('remote push unavailable')
  await push({
    hostUuid: meta.remote.hostUuid,
    remotePath: `${meta.remote.remoteUploadsDir}/${partFileName(meta.uploadId, index)}`,
    content: body,
  })
}

async function handleChunk(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
  indexRaw: string,
): Promise<void> {
  if (!UPLOAD_ID_RE.test(uploadId)) {
    host.sendError(res, 404, 'upload not found')
    return
  }
  if (!/^\d+$/.test(indexRaw) || indexRaw.length > 4) {
    host.sendError(res, 400, 'invalid chunk index')
    req.destroy()
    return
  }
  const index = Number(indexRaw)
  if (!Number.isSafeInteger(index) || String(index) !== indexRaw) {
    host.sendError(res, 400, 'invalid chunk index')
    req.destroy()
    return
  }
  if (rejectEarlyLength(host, req, res, MAX_UPLOAD_CHUNK_BYTES)) return
  const placedReq = await resolveSessionForRequest(host, req, res)
  if (!placedReq) {
    req.destroy()
    return
  }
  const meta = loadOwned(host, res, placedReq.userId, placedReq.placed.sessionDir, uploadId)
  if (!meta) {
    req.destroy()
    return
  }
  if (index >= meta.chunkCount) {
    host.sendError(res, 400, 'chunk index out of range')
    req.destroy()
    return
  }
  const expected = uploadChunkLength(meta.size, index, meta.chunkBytes)
  let body: Buffer
  try {
    body = await readRequestBody(req, MAX_UPLOAD_CHUNK_BYTES)
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode
    if (!res.headersSent) {
      if (statusCode === 413) host.sendError(res, 413, `chunk exceeds ${MAX_UPLOAD_CHUNK_BYTES / 1024 / 1024}MB`)
      else host.sendError(res, 400, 'chunk aborted')
    }
    return
  }
  if (body.length !== expected) {
    host.sendError(res, 400, 'chunk length mismatch')
    return
  }
  const dir = placedReq.placed.sessionDir
  try {
    const outcome = writeLocalPart(dir, meta, index, body)
    if (meta.remote && (outcome === 'stored' || !meta.received.includes(index))) {
      await pushRemotePart(host, meta, index, body)
    }
    markChunkReceived(dir, meta, index)
  } catch (err) {
    host.log.error('chunked upload: part write failed', { uploadId, index }, err)
    if (!res.headersSent) host.sendError(res, 502, meta.remote ? 'remote storage push failed' : 'storage write failed')
    return
  }
  res.writeHead(204)
  res.end()
}

async function assembleLocal(
  host: HttpMiscHandlersHost,
  res: ServerResponse,
  meta: UploadSessionMeta,
  placed: PlacedUpload,
): Promise<void> {
  const received = listReceived(placed.sessionDir, meta)
  if (received.length !== meta.chunkCount) {
    host.sendJson(res, 409, { error: 'upload incomplete', code: 'upload_incomplete', received })
    return
  }
  const tmpPath = join(placed.baseReal, `.tmp-${randomBytes(8).toString('hex')}`)
  const tmpFd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
  let handedOff = false
  try {
    const opened = resolveOpenedPath(tmpFd, tmpPath)
    if (opened !== tmpPath) {
      host.sendError(res, 500, 'storage path diverged')
      return
    }
    const hash = createHash('sha256')
    let total = 0
    for (let index = 0; index < meta.chunkCount; index++) {
      const part = readFileSync(join(placed.sessionDir, partFileName(meta.uploadId, index)))
      const expect = uploadChunkLength(meta.size, index, meta.chunkBytes)
      if (part.length !== expect) {
        host.sendJson(res, 409, { error: 'upload incomplete', code: 'upload_incomplete', received })
        return
      }
      writeSync(tmpFd, part)
      hash.update(part)
      total += part.length
    }
    if (total !== meta.size) {
      host.sendError(res, 409, 'upload size mismatch')
      return
    }
    const digest = hash.digest('hex')
    const finalName = `${digest}.${meta.ext}`
    const finalPath = join(placed.baseReal, finalName)
    handedOff = true
    const published = publishOpenedUpload({
      tmpFd,
      tmpPath,
      finalPath,
      isPerUser: placed.isPerUser,
      userId: meta.userId,
      res,
      log: host.log,
      sendError: (response, code, message) => host.sendError(response, code, message),
    })
    if (!published) return
    deleteSessionFiles(placed.sessionDir, meta.uploadId, meta.chunkCount)
    host.sendJson(res, 200, {
      url: `/api/media/${finalName}`,
      digest,
      size: total,
      mimeType: meta.mimeType,
    })
  } finally {
    try {
      closeSync(tmpFd)
    } catch {
      /* already closed */
    }
    if (!handedOff) {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* already gone */
      }
    }
  }
}

async function assembleRemote(host: HttpMiscHandlersHost, res: ServerResponse, meta: UploadSessionMeta, placed: PlacedUpload): Promise<void> {
  if (!meta.remote) return
  const received = listReceived(placed.sessionDir, meta)
  if (received.length !== meta.chunkCount) {
    host.sendJson(res, 409, { error: 'upload incomplete', code: 'upload_incomplete', received })
    return
  }
  const assemble = host.deps.commercial?.assembleRemoteHostUpload
  if (!assemble) {
    host.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
    return
  }
  try {
    for (let index = 0; index < meta.chunkCount; index++) {
      if (meta.received.includes(index)) continue
      const body = readFileSync(join(placed.sessionDir, partFileName(meta.uploadId, index)))
      await pushRemotePart(host, meta, index, body)
      markChunkReceived(placed.sessionDir, meta, index)
    }
    const assembled = await assemble({
      hostUuid: meta.remote.hostUuid,
      remoteDir: meta.remote.remoteUploadsDir,
      uploadId: meta.uploadId,
      count: meta.chunkCount,
      ext: meta.ext,
      expectedSize: meta.size,
    })
    if (assembled.size !== meta.size) {
      host.sendError(res, 409, 'upload size mismatch')
      return
    }
    deleteSessionFiles(placed.sessionDir, meta.uploadId, meta.chunkCount)
    host.sendJson(res, 200, {
      url: `/api/media/${assembled.sha256}.${meta.ext}`,
      digest: assembled.sha256,
      size: assembled.size,
      mimeType: meta.mimeType,
    })
  } catch (err) {
    host.log.error('chunked upload: remote assemble failed', { uploadId: meta.uploadId }, err)
    if (!res.headersSent) host.sendError(res, 502, 'remote storage push failed')
  }
}

async function handleComplete(host: HttpMiscHandlersHost, req: IncomingMessage, res: ServerResponse, uploadId: string): Promise<void> {
  const placedReq = await resolveSessionForRequest(host, req, res)
  if (!placedReq) return
  const meta = loadOwned(host, res, placedReq.userId, placedReq.placed.sessionDir, uploadId)
  if (!meta) return
  if (meta.remote) await assembleRemote(host, res, meta, placedReq.placed)
  else await assembleLocal(host, res, meta, placedReq.placed)
}

export async function handleChunkedUpload(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = url.pathname
  if (method === 'POST' && path === '/api/uploads/init') {
    await handleInit(this, req, res)
    return
  }
  const chunk = method === 'PUT' ? path.match(/^\/api\/uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/) : null
  if (chunk) {
    await handleChunk(this, req, res, chunk[1], chunk[2])
    return
  }
  const status = method === 'GET' ? path.match(/^\/api\/uploads\/([a-f0-9]{32})$/) : null
  if (status) {
    await handleStatus(this, req, res, status[1])
    return
  }
  const done = method === 'POST' ? path.match(/^\/api\/uploads\/([a-f0-9]{32})\/complete$/) : null
  if (done) {
    await handleComplete(this, req, res, done[1])
    return
  }
  this.sendError(res, 404, 'not found')
}
