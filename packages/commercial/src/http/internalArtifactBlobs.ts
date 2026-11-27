/**
 * OCV5-907 Wave 2 (P1-2) — Master internal RPC endpoint for container <-> master
 * content-addressed Artifact Blob Store (`LocalCasArtifactBlobStore`).
 *
 * Trust boundary:
 * - Mounted exclusively on the internal container proxy listener under
 *   `ARTIFACT_BLOB_INTERNAL_PREFIX` (`/internal/v3/artifact-blobs/`).
 * - Auth via `verifyContainerIdentity`; `tenantId` is ALWAYS derived from the
 *   verified container identity (`c:${identity.userId}`). Cross-tenant access
 *   is structurally impossible.
 * - Direct `POST /put` is hard-capped at 4 MiB; larger payloads (e.g. engine
 *   state capsules / SQLite snapshots) use multipart chunked uploads
 *   (`POST /uploads` -> `PUT /uploads/:id/parts/:idx` -> `POST /uploads/:id/complete`).
 * - Downloads stream directly from `openReadStream` with HTTP Range support and
 *   destroy the underlying file stream on client disconnect (`req`/`res` close).
 *
 * Layer: commercial http (L4). Zero `process.env` reads; zero engine literal
 * special cases.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ARTIFACT_BLOB_INTERNAL_PREFIX,
  ARTIFACT_BLOB_KINDS,
  type ArtifactBlobKind,
} from '@openclaude/protocol'
import type {
  BlobTicketOperation,
  LocalCasArtifactBlobStore,
} from '../agent-sandbox/artifactBlobStore.js'
import type { ServerAuthoredHandler } from './internalServerAuthored.js'
import { ensureRequestId, sendError, sendJson, setSecurityHeaders } from './util.js'

export { ARTIFACT_BLOB_INTERNAL_PREFIX }

const MAX_JSON_BODY_BYTES = 64 * 1024
const MAX_DIRECT_PUT_BYTES = 4 * 1024 * 1024
const MAX_PART_BODY_BYTES = 16 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const BLOB_KIND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_KINDS)
const TICKET_OP_SET: ReadonlySet<string> = new Set<string>(['read', 'write', 'materialize'])

export interface InternalArtifactBlobsDeps {
  readonly getStore: () => LocalCasArtifactBlobStore | undefined
  readonly verify: (
    req: IncomingMessage,
    ctx: Parameters<ServerAuthoredHandler>[2],
  ) => Promise<{ userId: number | bigint }>
}

class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE'
  constructor(limitBytes: number) {
    super(`Payload exceeds ${limitBytes} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

class InvalidJsonError extends Error {
  readonly code = 'INVALID_JSON'
  constructor() {
    super('Request body must be valid JSON')
    this.name = 'InvalidJsonError'
  }
}

function readRawBodyBounded(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      if (err) reject(err)
      else resolve(buf ?? Buffer.alloc(0))
    }

    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      total += b.length
      if (total > maxBytes) {
        req.resume()
        finish(new PayloadTooLargeError(maxBytes))
        return
      }
      chunks.push(b)
    }

    const onEnd = () => finish(null, total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total))
    const onError = (err: Error) => finish(err)
    const onAborted = () => finish(new Error('REQUEST_ABORTED'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

async function readJsonBodyBounded(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const buf = await readRawBodyBounded(req, maxBytes)
  if (buf.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidJsonError()
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof InvalidJsonError) throw err
    throw new InvalidJsonError()
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim()
  return undefined
}

function parseSingleByteRange(
  rangeHeader: string | undefined,
): { readonly start: number; readonly end?: number } | 'invalid' | undefined {
  if (!rangeHeader) return undefined
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) return 'invalid'
  const start = Number(m[1])
  if (!Number.isSafeInteger(start) || start < 0) return 'invalid'
  if (m[2] === '') return { start }
  const end = Number(m[2])
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end }
}

function mapBlobStoreError(res: ServerResponse, err: unknown, requestId: string): void {
  if (err instanceof PayloadTooLargeError) {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, requestId)
    return
  }
  if (err instanceof InvalidJsonError) {
    sendError(res, 400, 'INVALID_JSON', err.message, requestId)
    return
  }
  const msg = err instanceof Error ? err.message : ''
  if (
    msg === 'BLOB_PART_SHA256_MISMATCH' ||
    msg === 'BLOB_SHA256_MISMATCH' ||
    msg === 'BLOB_UPLOAD_NOT_OPEN' ||
    msg === 'BLOB_UPLOAD_ALREADY_EXISTS'
  ) {
    sendError(res, 409, msg, 'artifact blob conflict', requestId)
    return
  }
  if (msg === 'BLOB_UPLOAD_NOT_FOUND' || msg === 'BLOB_NOT_FOUND') {
    sendError(res, 404, msg, 'artifact blob resource not found', requestId)
    return
  }
  if (msg === 'BLOB_RANGE_INVALID') {
    sendError(res, 416, msg, 'invalid byte range', requestId)
    return
  }
  if (msg === 'BLOB_UPLOAD_TENANT_MISMATCH') {
    sendError(res, 403, msg, 'tenant mismatch', requestId)
    return
  }
  if (
    msg === 'BLOB_SIGNING_SECRET_UNCONFIGURED' ||
    msg === 'BLOB_TICKET_SIGNER_NOT_CONFIGURED'
  ) {
    sendError(res, 503, msg, 'blob ticket signing secret unavailable', requestId)
    return
  }
  if (msg.startsWith('BLOB_')) {
    sendError(res, 400, msg, 'invalid artifact blob request', requestId)
    return
  }
  sendError(res, 500, 'ARTIFACT_BLOB_ERROR', 'artifact blob operation failed', requestId)
}

export function makeInternalArtifactBlobsHandler(
  deps: InternalArtifactBlobsDeps,
): ServerAuthoredHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader('x-request-id', requestId)
    res.setHeader('cache-control', 'no-store')

    let tenantId: string
    try {
      const identity = await deps.verify(req, ctx)
      tenantId = `c:${identity.userId.toString()}`
    } catch {
      sendError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return
    }

    const store = deps.getStore()
    if (!store) {
      sendError(res, 503, 'ARTIFACT_BLOB_STORE_UNAVAILABLE', 'artifact blob store not initialized', requestId)
      return
    }

    const url = new URL(req.url ?? '/', 'http://internal')
    if (!url.pathname.startsWith(ARTIFACT_BLOB_INTERNAL_PREFIX)) {
      sendError(res, 404, 'NOT_FOUND', 'unknown artifact blob route', requestId)
      return
    }
    const subpath = url.pathname.slice(ARTIFACT_BLOB_INTERNAL_PREFIX.length)
    const segments = subpath.split('/').filter((s) => s.length > 0)
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      // POST /internal/v3/artifact-blobs/put (direct small upload <= 4 MiB)
      if (segments.length === 1 && segments[0] === 'put') {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
          return
        }
        const kind = headerValue(req, 'x-blob-kind') ?? url.searchParams.get('kind') ?? ''
        if (!BLOB_KIND_SET.has(kind)) {
          sendError(res, 400, 'BLOB_KIND_INVALID', 'valid x-blob-kind header is required', requestId)
          return
        }
        const mimeType =
          headerValue(req, 'x-blob-mime-type') ??
          headerValue(req, 'content-type')?.split(';')[0]?.trim() ??
          'application/octet-stream'
        const logicalNameRaw = headerValue(req, 'x-blob-logical-name')
        const relPathRaw = headerValue(req, 'x-blob-container-rel-path')
        const logicalName = logicalNameRaw ? decodeURIComponent(logicalNameRaw) : undefined
        const containerRelativePath = relPathRaw ? decodeURIComponent(relPathRaw) : undefined

        const body = await readRawBodyBounded(req, MAX_DIRECT_PUT_BYTES)
        const ref = await store.put({
          tenantId,
          kind: kind as ArtifactBlobKind,
          mimeType,
          bytes: new Uint8Array(body),
          ...(logicalName ? { logicalName } : {}),
          ...(containerRelativePath ? { containerRelativePath } : {}),
        })
        sendJson(res, 200, { ok: true, blob: ref })
        return
      }

      // POST /internal/v3/artifact-blobs/uploads (initiate chunked upload)
      if (segments.length === 1 && segments[0] === 'uploads') {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_JSON_BODY_BYTES)
        if (typeof body.kind !== 'string' || !BLOB_KIND_SET.has(body.kind)) {
          sendError(res, 400, 'BLOB_KIND_INVALID', 'valid kind required', requestId)
          return
        }
        if (typeof body.filename !== 'string' || body.filename.trim().length === 0) {
          sendError(res, 400, 'BLOB_FILENAME_INVALID', 'filename required', requestId)
          return
        }
        if (typeof body.mimeType !== 'string' || body.mimeType.trim().length === 0) {
          sendError(res, 400, 'BLOB_MIME_TYPE_INVALID', 'mimeType required', requestId)
          return
        }
        if (typeof body.expectedSizeBytes !== 'number' || !Number.isSafeInteger(body.expectedSizeBytes) || body.expectedSizeBytes < 0) {
          sendError(res, 400, 'BLOB_EXPECTED_SIZE_INVALID', 'expectedSizeBytes required', requestId)
          return
        }
        // B8: Master ALWAYS allocates a fresh random uploadId; caller-supplied
        // uploadId is ignored so tenants can never collide or hijack staging IDs.
        const session = await store.initiateChunkedUpload({
          tenantId,
          kind: body.kind as ArtifactBlobKind,
          filename: body.filename,
          mimeType: body.mimeType,
          expectedSizeBytes: body.expectedSizeBytes,
          ...(typeof body.chunkBytes === 'number' ? { chunkBytes: body.chunkBytes } : {}),
          ...(typeof body.containerRelativePath === 'string'
            ? { containerRelativePath: body.containerRelativePath }
            : {}),
        })
        sendJson(res, 200, { ok: true, session })
        return
      }

      // PUT /internal/v3/artifact-blobs/uploads/:uploadId/parts/:index
      if (segments.length === 4 && segments[0] === 'uploads' && segments[2] === 'parts') {
        if (method !== 'PUT') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'PUT required', requestId)
          return
        }
        const uploadId = segments[1]!
        const index = Number(segments[3])
        const sha256 = headerValue(req, 'x-part-sha256') ?? ''
        if (!IDENT_RE.test(uploadId) || !Number.isSafeInteger(index) || index < 0 || !SHA256_RE.test(sha256)) {
          sendError(res, 400, 'BLOB_PART_INPUT_INVALID', 'invalid uploadId, part index, or x-part-sha256', requestId)
          return
        }
        const bytes = await readRawBodyBounded(req, MAX_PART_BODY_BYTES)
        const receipt = await store.putPart({
          uploadId,
          tenantId,
          index,
          bytes: new Uint8Array(bytes),
          sha256,
        })
        sendJson(res, 200, { ok: true, part: receipt })
        return
      }

      // POST /internal/v3/artifact-blobs/uploads/:uploadId/complete
      if (segments.length === 3 && segments[0] === 'uploads' && segments[2] === 'complete') {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
          return
        }
        const uploadId = segments[1]!
        if (!IDENT_RE.test(uploadId)) {
          sendError(res, 400, 'BLOB_UPLOAD_ID_INVALID', 'invalid uploadId', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_JSON_BODY_BYTES)
        const blob = await store.completeUpload({
          uploadId,
          tenantId,
          ...(typeof body.expectedSha256 === 'string' ? { expectedSha256: body.expectedSha256 } : {}),
          ...(typeof body.blobId === 'string' ? { blobId: body.blobId } : {}),
        })
        sendJson(res, 200, { ok: true, blob })
        return
      }

      // DELETE /internal/v3/artifact-blobs/uploads/:uploadId
      if (segments.length === 2 && segments[0] === 'uploads') {
        if (method !== 'DELETE') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'DELETE required', requestId)
          return
        }
        const uploadId = segments[1]!
        if (!IDENT_RE.test(uploadId)) {
          sendError(res, 400, 'BLOB_UPLOAD_ID_INVALID', 'invalid uploadId', requestId)
          return
        }
        await store.abortUpload(tenantId, uploadId)
        sendJson(res, 200, { ok: true })
        return
      }

      // GET /internal/v3/artifact-blobs/by-sha256/:sha256
      if (segments.length === 2 && segments[0] === 'by-sha256') {
        if (method !== 'GET') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET required', requestId)
          return
        }
        const sha256 = segments[1]!
        if (!SHA256_RE.test(sha256)) {
          sendError(res, 400, 'BLOB_SHA256_INVALID', 'invalid sha256', requestId)
          return
        }
        const blob = await store.headBySha256(tenantId, sha256)
        sendJson(res, 200, { ok: true, blob })
        return
      }

      // GET /internal/v3/artifact-blobs/:blobId/meta
      if (segments.length === 2 && segments[1] === 'meta') {
        if (method !== 'GET') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET required', requestId)
          return
        }
        const blobId = segments[0]!
        if (!IDENT_RE.test(blobId)) {
          sendError(res, 400, 'BLOB_ID_INVALID', 'invalid blobId', requestId)
          return
        }
        const blob = await store.getMetadata(tenantId, blobId)
        if (!blob) {
          sendError(res, 404, 'BLOB_NOT_FOUND', 'blob not found', requestId)
          return
        }
        sendJson(res, 200, { ok: true, blob })
        return
      }

      // POST /internal/v3/artifact-blobs/:blobId/ticket
      if (segments.length === 2 && segments[1] === 'ticket') {
        if (method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
          return
        }
        const blobId = segments[0]!
        if (!IDENT_RE.test(blobId)) {
          sendError(res, 400, 'BLOB_ID_INVALID', 'invalid blobId', requestId)
          return
        }
        const body = await readJsonBodyBounded(req, MAX_JSON_BODY_BYTES)
        const op = typeof body.op === 'string' && TICKET_OP_SET.has(body.op) ? (body.op as BlobTicketOperation) : null
        const audience = typeof body.audience === 'string' ? body.audience.trim() : ''
        const ttlMs = typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : 0
        if (!op || !audience || ttlMs <= 0) {
          sendError(res, 400, 'BLOB_TICKET_INPUT_INVALID', 'op, audience, and positive ttlMs required', requestId)
          return
        }
        const meta = await store.getMetadata(tenantId, blobId)
        if (!meta) {
          sendError(res, 404, 'BLOB_NOT_FOUND', 'blob not found', requestId)
          return
        }
        const ticket = store.issueSignedTicket({
          blobId,
          tenantId,
          audience,
          op,
          ttlMs,
        })
        sendJson(res, 200, { ok: true, ticket })
        return
      }

      // GET / HEAD / DELETE /internal/v3/artifact-blobs/:blobId
      if (segments.length === 1) {
        const blobId = segments[0]!
        if (!IDENT_RE.test(blobId)) {
          sendError(res, 400, 'BLOB_ID_INVALID', 'invalid blobId', requestId)
          return
        }
        if (method === 'DELETE') {
          const deleted = await store.delete(tenantId, blobId)
          sendJson(res, 200, { ok: true, deleted })
          return
        }
        if (method === 'HEAD') {
          const meta = await store.getMetadata(tenantId, blobId)
          if (!meta) {
            res.statusCode = 404
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', meta.mimeType)
          res.setHeader('content-length', String(meta.sizeBytes))
          res.setHeader('x-blob-sha256', meta.sha256)
          res.end()
          return
        }
        if (method === 'GET') {
          const parsedRange = parseSingleByteRange(headerValue(req, 'range'))
          if (parsedRange === 'invalid') {
            sendError(res, 416, 'BLOB_RANGE_INVALID', 'invalid Range header', requestId)
            return
          }
          // W4: register early-disconnect listener BEFORE awaiting PG metadata / opening fd
          let clientDisconnected = req.destroyed || res.destroyed
          const onEarlyDisconnect = () => {
            clientDisconnected = true
          }
          req.once('close', onEarlyDisconnect)
          res.once('close', onEarlyDisconnect)

          let handle: Awaited<ReturnType<LocalCasArtifactBlobStore['openReadStream']>>
          try {
            handle = await store.openReadStream(
              tenantId,
              blobId,
              parsedRange ? { range: parsedRange } : undefined,
            )
          } finally {
            req.off('close', onEarlyDisconnect)
            res.off('close', onEarlyDisconnect)
          }
          if (!handle) {
            if (!clientDisconnected && !res.destroyed) {
              sendError(res, 404, 'BLOB_NOT_FOUND', 'blob not found', requestId)
            }
            return
          }
          if (clientDisconnected || req.destroyed || res.destroyed) {
            handle.stream.destroy()
            return
          }
          const isPartial = Boolean(parsedRange) && handle.meta.sizeBytes > 0
          res.statusCode = isPartial ? 206 : 200
          res.setHeader('content-type', handle.meta.mimeType)
          res.setHeader('content-length', String(handle.contentLength))
          res.setHeader('x-blob-sha256', handle.meta.sha256)
          res.setHeader('accept-ranges', 'bytes')
          if (isPartial) {
            res.setHeader(
              'content-range',
              `bytes ${handle.start}-${handle.end}/${handle.meta.sizeBytes}`,
            )
          }

          await new Promise<void>((resolve) => {
            let done = false
            const finish = () => {
              if (done) return
              done = true
              req.off('close', onAbort)
              res.off('close', onAbort)
              handle.stream.off('error', onStreamError)
              res.off('finish', finish)
              resolve()
            }
            const onAbort = () => {
              if (!res.writableEnded) {
                handle.stream.destroy()
              }
              finish()
            }
            const onStreamError = () => {
              if (!res.headersSent) {
                sendError(res, 500, 'BLOB_STREAM_ERROR', 'failed to stream blob', requestId)
              } else {
                res.destroy()
              }
              finish()
            }
            req.once('close', onAbort)
            res.once('close', onAbort)
            handle.stream.once('error', onStreamError)
            res.once('finish', finish)
            if (req.destroyed || res.destroyed) {
              onAbort()
              return
            }
            handle.stream.pipe(res)
          })
          return
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET, HEAD, or DELETE required', requestId)
        return
      }

      sendError(res, 404, 'NOT_FOUND', 'unknown artifact blob endpoint', requestId)
    } catch (err) {
      mapBlobStoreError(res, err, requestId)
    }
  }
}
