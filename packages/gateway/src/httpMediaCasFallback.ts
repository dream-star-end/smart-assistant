/**
 * Per-file CAS & Remote-Host Range media GET helpers for `httpMiscHandlers.ts` (`OCV5-928` B2/B4).
 *
 * Invariants:
 * - B2-a: Pre-header node-agent I/O/transport errors fall back to healthy per-file CAS replica
 *   before returning 502; explicit policy rejections (`403`) never downgrade.
 * - B2-b: Remote Range (`206`) and `HEAD` stream end-to-end via `openRemoteHostMedia` without
 *   buffering whole files into Master memory.
 * - B2-c: CAS stream handle is opened before `onReady` writes 200/206 headers; mid-stream errors
 *   after headers destroy `res` cleanly instead of leaving un-ended sockets.
 * - B2-d: CAS policy check evaluates all canonical paths (`/<uploads|generated>/<filename>`,
 *   `logicalName`, `containerRelativePath`) identically to physical volume checks.
 * - B4: Only content-addressed `<64-hex-sha256>[.<ext>]` URLs receive `immutable` caching;
 *   mutable logical names emit `no-cache, must-revalidate` (plus `ETag` / `304` on CAS).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { shouldServeInline } from '@openclaude/protocol'
import type { HttpMiscHandlersHost, ResolveMediaDirsResult } from './httpMiscHandlers.js'
import { parseByteRange } from './httpRange.js'
import { mimeFor } from './httpUploadStatic.js'

const IMMUTABLE_DIGEST_FILENAME_RE = /^[0-9a-f]{64}(?:\.[a-z0-9]{1,16})?$/i

export interface MediaFallbackLookup {
  readonly userId: string
  readonly filename: string
  readonly isFileBlocked: (pathOrName: string) => boolean
}

export function mediaCacheControlForFilename(
  pathOrName: string,
  explicitImmutable?: boolean,
): string {
  const base = basename(pathOrName)
  const immutable = explicitImmutable ?? IMMUTABLE_DIGEST_FILENAME_RE.test(base)
  return immutable ? 'private, max-age=3600, immutable' : 'private, no-cache, must-revalidate'
}

function buildMediaBaseHeaders(
  pathOrName: string,
  opts?: { readonly isImmutableDigest?: boolean; readonly sha256?: string },
): Record<string, string | number> {
  const contentType = mimeFor(pathOrName)
  const disposition = `${shouldServeInline(contentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(pathOrName) || 'file')}"`
  return {
    'Content-Type': contentType,
    'Cache-Control': mediaCacheControlForFilename(pathOrName, opts?.isImmutableDigest),
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    ...(opts?.sha256 ? { ETag: `"${opts.sha256}"` } : {}),
  }
}

function matchesIfNoneMatch(req: IncomingMessage, sha256: string | undefined): boolean {
  if (!sha256 || req.headers.range) return false
  const raw = req.headers['if-none-match']
  if (typeof raw !== 'string' || raw.trim().length === 0) return false
  const target = `"${sha256}"`
  return raw
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === target)
}

export function sendBufferMediaWithRange(
  req: IncomingMessage,
  res: ServerResponse,
  hitPath: string,
  buf: Buffer,
): void {
  const baseHeaders = buildMediaBaseHeaders(hitPath)
  const isHead = req.method === 'HEAD'
  const range = isHead ? null : parseByteRange(req.headers.range, buf.length)
  if (range) {
    const slice = buf.subarray(range.start, range.end + 1)
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${buf.length}`,
      'Content-Length': slice.length,
    })
    res.end(slice)
    return
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': buf.length })
  if (isHead) res.end()
  else res.end(buf)
}

function classifyExplicitDenialStatus(err: unknown): 403 | 502 | null {
  if (!err || typeof err !== 'object') return null
  const e = err as {
    readonly name?: unknown
    readonly httpStatus?: unknown
    readonly statusCode?: unknown
    readonly reason?: unknown
  }
  if (e.name === 'MediaAccessDeniedError') return 403
  const st = typeof e.httpStatus === 'number' ? e.httpStatus : e.statusCode
  if (st === 403) return 403
  if (
    st === 400 ||
    st === 401 ||
    e.name === 'AgentAuthError' ||
    e.name === 'CertVerifyError' ||
    (e.name === 'HostNotServiceableError' && e.reason === 'revoked')
  ) {
    return 502
  }
  return null
}

export async function tryServeCasMediaFallback(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  lookup: MediaFallbackLookup,
): Promise<boolean> {
  const openCas = host.deps.commercial?.openCasMediaFallback
  if (!openCas) return false
  const { userId, filename, isFileBlocked } = lookup
  let responded304 = false
  try {
    const outcome = await openCas({
      userId,
      filename,
      dest: res,
      resolveRange: (totalSize) => parseByteRange(req.headers.range, totalSize),
      isHead: req.method === 'HEAD',
      isFileBlocked,
      onReady: (info) => {
        const checkPaths = info.policyCheckPaths ?? [`/uploads/${filename}`, `/generated/${filename}`]
        if (checkPaths.some((p) => isFileBlocked(p))) {
          host.log.warn('media: CAS hit blocked by sensitive deny-list', { filename })
          res.writeHead(403)
          res.end('access denied')
          return false
        }
        const baseHeaders = buildMediaBaseHeaders(filename, {
          isImmutableDigest: info.isImmutableDigest,
          sha256: info.sha256,
        })
        if (matchesIfNoneMatch(req, info.sha256)) {
          responded304 = true
          res.writeHead(304, {
            'Cache-Control': baseHeaders['Cache-Control']!,
            ETag: `"${info.sha256}"`,
          })
          res.end()
          return false
        }
        if (info.range) {
          res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${info.range.start}-${info.range.end}/${info.totalSize}`,
            'Content-Length': info.contentLength,
          })
        } else {
          res.writeHead(200, { ...baseHeaders, 'Content-Length': info.totalSize })
          if (req.method === 'HEAD') res.end()
        }
        return true
      },
    })
    if (responded304) return true
    if (outcome === 'rejected' && !res.headersSent) {
      res.writeHead(403)
      res.end('access denied')
      return true
    }
    return outcome !== 'missing'
  } catch (err) {
    host.log.warn('media: CAS fallback failed, continuing without CAS', { userId, filename }, err)
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.destroy(err instanceof Error ? err : undefined)
      }
      return true
    }
    return false
  }
}

type RemoteMediaAttemptOutcome = 'served' | 'missing' | 'denied' | 'upstream_error'

async function streamRemoteHostMediaCandidates(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    readonly mediaLocation: Extract<ResolveMediaDirsResult, { kind: 'fail'; reason: 'remote-host' }>
    readonly remoteCandidates: readonly string[]
    readonly isFileBlocked: (pathOrName: string) => boolean
  },
): Promise<RemoteMediaAttemptOutcome> {
  const openRemote = host.deps.commercial?.openRemoteHostMedia
  if (!openRemote) return 'missing'
  const { mediaLocation, remoteCandidates, isFileBlocked } = ctx
  const isHead = req.method === 'HEAD'
  for (const remotePath of remoteCandidates) {
    try {
      const outcome = await openRemote({
        hostUuid: mediaLocation.hostUuid,
        remotePath,
        dest: res,
        resolveRange: (totalSize) => parseByteRange(req.headers.range, totalSize),
        isHead,
        onReady: (info) => {
          if (isFileBlocked(remotePath)) {
            host.log.warn('media: remote hit blocked by sensitive deny-list', { remotePath })
            res.writeHead(403)
            res.end('access denied')
            return false
          }
          const baseHeaders = buildMediaBaseHeaders(remotePath)
          const effectiveRange =
            info.range !== undefined
              ? info.range
              : isHead
                ? null
                : parseByteRange(req.headers.range, info.size)
          if (effectiveRange) {
            const len = info.contentLength ?? effectiveRange.end - effectiveRange.start + 1
            res.writeHead(206, {
              ...baseHeaders,
              'Content-Range': `bytes ${effectiveRange.start}-${effectiveRange.end}/${info.size}`,
              'Content-Length': len,
            })
          } else {
            res.writeHead(200, { ...baseHeaders, 'Content-Length': info.size })
            if (isHead) res.end()
          }
          return true
        },
      })
      if (outcome === 'denied') {
        host.sendError(res, 502, 'remote storage pull denied')
        return 'denied'
      }
      if (outcome !== 'missing') return 'served'
    } catch (err) {
      host.log.error(
        'media: remote-host pull failed',
        { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
        err as Error,
      )
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) {
          res.destroy(err instanceof Error ? err : undefined)
        }
        return 'served'
      }
      const denialStatus = classifyExplicitDenialStatus(err)
      if (denialStatus !== null) {
        if (denialStatus === 403) {
          res.writeHead(403)
          res.end('access denied')
        } else {
          host.sendError(res, 502, 'remote storage pull denied')
        }
        return 'denied'
      }
      return 'upstream_error'
    }
  }
  return 'missing'
}

async function pullRemoteHostMediaCandidates(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    readonly mediaLocation: Extract<ResolveMediaDirsResult, { kind: 'fail'; reason: 'remote-host' }>
    readonly remoteCandidates: readonly string[]
    readonly isFileBlocked: (pathOrName: string) => boolean
  },
): Promise<RemoteMediaAttemptOutcome> {
  const pullRemote = host.deps.commercial?.pullRemoteHostMedia
  if (!pullRemote) return 'missing'
  const { mediaLocation, remoteCandidates, isFileBlocked } = ctx
  for (const remotePath of remoteCandidates) {
    try {
      const result = await pullRemote({
        hostUuid: mediaLocation.hostUuid,
        remotePath,
        isFileBlocked,
      })
      if (result === null) continue
      if (isFileBlocked(remotePath)) {
        host.log.warn('media: remote hit blocked by sensitive deny-list', { hitPath: remotePath })
        res.writeHead(403)
        res.end('access denied')
        return 'served'
      }
      sendBufferMediaWithRange(req, res, remotePath, result)
      return 'served'
    } catch (err) {
      host.log.error(
        'media: remote-host pull failed',
        { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
        err as Error,
      )
      if (res.headersSent) return 'served'
      const denialStatus = classifyExplicitDenialStatus(err)
      if (denialStatus !== null) {
        if (denialStatus === 403) {
          res.writeHead(403)
          res.end('access denied')
        } else {
          host.sendError(res, 502, 'remote storage pull denied')
        }
        return 'denied'
      }
      return 'upstream_error'
    }
  }
  return 'missing'
}

export async function tryServeRemoteHostApiFile(
  host: HttpMiscHandlersHost,
  res: ServerResponse,
  ctx: {
    readonly resolvedPath: string
    readonly mediaLocation: ResolveMediaDirsResult
    readonly isScopedMediaPath: (p: string) => boolean
    readonly isFileBlocked: (pathOrName: string) => boolean
  },
): Promise<boolean> {
  const pullRemote = host.deps.commercial?.pullRemoteHostMedia
  if (ctx.mediaLocation.kind !== 'fail' || ctx.mediaLocation.reason !== 'remote-host' || !pullRemote) {
    return false
  }
  if (!ctx.isScopedMediaPath(ctx.resolvedPath)) return false
  if (ctx.isFileBlocked(ctx.resolvedPath)) {
    host.log.warn('api/file: remote hit blocked by sensitive deny-list', { path: ctx.resolvedPath })
    res.writeHead(403)
    res.end('access denied')
    return true
  }
  let buf: Buffer | null = null
  try {
    buf = await pullRemote({
      hostUuid: ctx.mediaLocation.hostUuid,
      remotePath: ctx.resolvedPath,
      isFileBlocked: ctx.isFileBlocked,
    })
  } catch (err) {
    if (classifyExplicitDenialStatus(err) === 403) {
      res.writeHead(403)
      res.end('access denied')
      return true
    }
    host.log.error(
      'api/file: remote-host pull failed',
      { hostUuid: ctx.mediaLocation.hostUuid, remotePath: ctx.resolvedPath, ...ctx.mediaLocation.logCtx },
      err as Error,
    )
    host.sendError(res, 502, 'remote storage pull failed')
    return true
  }
  if (buf === null) {
    res.writeHead(404)
    res.end('not found')
    return true
  }
  const contentType = mimeFor(ctx.resolvedPath)
  const disposition = shouldServeInline(contentType) ? 'inline' : 'attachment'
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${disposition}; filename="${encodeURIComponent(basename(ctx.resolvedPath) || 'file')}"`,
  })
  res.end(buf)
  return true
}

export async function handleMediaGetFailLocation(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MediaFallbackLookup & {
    readonly mediaLocation: Extract<ResolveMediaDirsResult, { kind: 'fail' }>
  },
): Promise<void> {
  const { mediaLocation } = ctx
  const hasRemoteHook = Boolean(
    host.deps.commercial?.openRemoteHostMedia || host.deps.commercial?.pullRemoteHostMedia,
  )
  if (mediaLocation.reason === 'remote-host' && hasRemoteHook) {
    const remoteCandidates = [
      `${mediaLocation.uploads}/${ctx.filename}`,
      `${mediaLocation.generated}/${ctx.filename}`,
    ]
    if (remoteCandidates.some((p) => ctx.isFileBlocked(p))) {
      host.log.warn('media: remote request blocked by sensitive deny-list', { filename: ctx.filename })
      res.writeHead(403)
      res.end('access denied')
      return
    }
    const remoteCtx = { mediaLocation, remoteCandidates, isFileBlocked: ctx.isFileBlocked }
    const remoteOutcome = host.deps.commercial?.openRemoteHostMedia
      ? await streamRemoteHostMediaCandidates(host, req, res, remoteCtx)
      : await pullRemoteHostMediaCandidates(host, req, res, remoteCtx)
    if (remoteOutcome === 'served' || remoteOutcome === 'denied') return
    if (await tryServeCasMediaFallback(host, req, res, ctx)) return
    if (!res.headersSent) {
      if (remoteOutcome === 'upstream_error') {
        host.sendError(res, 502, 'remote storage pull failed')
      } else {
        res.writeHead(404)
        res.end('not found')
      }
    }
    return
  }
  if (mediaLocation.reason === 'remote-host' || mediaLocation.reason === 'volume-missing') {
    if ([`/uploads/${ctx.filename}`, `/generated/${ctx.filename}`].some((p) => ctx.isFileBlocked(p))) {
      res.writeHead(403)
      res.end('access denied')
      return
    }
    if (await tryServeCasMediaFallback(host, req, res, ctx)) return
  }
  host._sendMediaResolveError(res, mediaLocation, 'media')
}
