/**
 * Per-file CAS & Remote-Host Range media GET helpers for `httpMiscHandlers.ts` (`OCV5-928` B2/B4).
 *
 * Keeps physical volume routing (`remote-host` / `local_direct` / `volume-missing`) intact
 * while providing per-file CAS fallback and HTTP Range (`206 Partial Content`) parity.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { shouldServeInline } from '@openclaude/protocol'
import type { HttpMiscHandlersHost, ResolveMediaDirsResult } from './httpMiscHandlers.js'
import { parseByteRange } from './httpRange.js'
import { mimeFor } from './httpUploadStatic.js'

export interface MediaFallbackLookup {
  readonly userId: string
  readonly filename: string
  readonly isFileBlocked: (pathOrName: string) => boolean
}

function buildMediaBaseHeaders(pathOrName: string): Record<string, string | number> {
  const contentType = mimeFor(pathOrName)
  const disposition = `${shouldServeInline(contentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(pathOrName) || 'file')}"`
  return {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
  }
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

export async function tryServeCasMediaFallback(
  host: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  lookup: MediaFallbackLookup,
): Promise<boolean> {
  const openCas = host.deps.commercial?.openCasMediaFallback
  if (!openCas) return false
  const { userId, filename, isFileBlocked } = lookup
  try {
    const outcome = await openCas({
      userId,
      filename,
      dest: res,
      resolveRange: (totalSize) => parseByteRange(req.headers.range, totalSize),
      isHead: req.method === 'HEAD',
      onReady: (info) => {
        if (isFileBlocked(filename)) {
          host.log.warn('media: CAS hit blocked by sensitive deny-list', { filename })
          res.writeHead(403)
          res.end('access denied')
          return false
        }
        const baseHeaders = buildMediaBaseHeaders(filename)
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
    return outcome !== 'missing'
  } catch (err) {
    host.log.warn('media: CAS fallback failed, continuing without CAS', { userId, filename }, err)
    return res.headersSent
  }
}

async function streamRemoteHostMediaCandidates(
  host: HttpMiscHandlersHost,
  res: ServerResponse,
  ctx: {
    readonly mediaLocation: Extract<ResolveMediaDirsResult, { kind: 'fail'; reason: 'remote-host' }>
    readonly remoteCandidates: readonly string[]
    readonly isFileBlocked: (pathOrName: string) => boolean
  },
): Promise<boolean> {
  const openRemote = host.deps.commercial?.openRemoteHostMedia
  if (!openRemote) return false
  const { mediaLocation, remoteCandidates, isFileBlocked } = ctx
  for (const remotePath of remoteCandidates) {
    try {
      const outcome = await openRemote({
        hostUuid: mediaLocation.hostUuid,
        remotePath,
        dest: res,
        onReady: (info) => {
          if (isFileBlocked(remotePath)) {
            host.log.warn('media: remote hit blocked by sensitive deny-list', { remotePath })
            res.writeHead(403)
            res.end('access denied')
            return false
          }
          res.writeHead(200, { ...buildMediaBaseHeaders(remotePath), 'Content-Length': info.size })
          return true
        },
      })
      if (outcome !== 'missing') return true
    } catch (err) {
      host.log.error(
        'media: remote-host pull failed',
        { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
        err as Error,
      )
      if (!res.headersSent) host.sendError(res, 502, 'remote storage pull failed')
      return true
    }
  }
  return false
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
): Promise<boolean> {
  const pullRemote = host.deps.commercial?.pullRemoteHostMedia
  if (!pullRemote) return false
  const { mediaLocation, remoteCandidates, isFileBlocked } = ctx
  for (const remotePath of remoteCandidates) {
    try {
      const result = await pullRemote({ hostUuid: mediaLocation.hostUuid, remotePath })
      if (result === null) continue
      if (isFileBlocked(remotePath)) {
        host.log.warn('media: remote hit blocked by sensitive deny-list', { hitPath: remotePath })
        res.writeHead(403)
        res.end('access denied')
        return true
      }
      sendBufferMediaWithRange(req, res, remotePath, result)
      return true
    } catch (err) {
      host.log.error(
        'media: remote-host pull failed',
        { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
        err as Error,
      )
      host.sendError(res, 502, 'remote storage pull failed')
      return true
    }
  }
  return false
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
    const remoteCtx = {
      mediaLocation,
      remoteCandidates: [`${mediaLocation.uploads}/${ctx.filename}`, `${mediaLocation.generated}/${ctx.filename}`],
      isFileBlocked: ctx.isFileBlocked,
    }
    const useRangePull = Boolean(req.headers.range && host.deps.commercial?.pullRemoteHostMedia)
    const served = useRangePull
      ? await pullRemoteHostMediaCandidates(host, req, res, remoteCtx)
      : host.deps.commercial?.openRemoteHostMedia
        ? await streamRemoteHostMediaCandidates(host, res, remoteCtx)
        : await pullRemoteHostMediaCandidates(host, req, res, remoteCtx)
    if (served) return
    if (await tryServeCasMediaFallback(host, req, res, ctx)) return
    if (!res.headersSent) {
      res.writeHead(404)
      res.end('not found')
    }
    return
  }
  if (
    (mediaLocation.reason === 'remote-host' || mediaLocation.reason === 'volume-missing') &&
    (await tryServeCasMediaFallback(host, req, res, ctx))
  ) {
    return
  }
  host._sendMediaResolveError(res, mediaLocation, 'media')
}
