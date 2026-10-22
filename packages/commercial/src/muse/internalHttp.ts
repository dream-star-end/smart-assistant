// Muse media bridge — container-facing endpoints used by `oc-muse` (OCV5-561).
//
//   GET    /internal/v3/muse-media/status
//   POST   /internal/v3/muse-media/jobs                 → 202 {job_id}
//   GET    /internal/v3/muse-media/jobs/:id?wait=25     → status (long-poll ≤ 25 s)
//   GET    /internal/v3/muse-media/jobs/:id/files/:idx  → raw bytes
//   DELETE /internal/v3/muse-media/jobs/:id
//
// Tenant = verified container identity only. The allowlist (OC_MUSE_ALLOWED_UIDS) is the
// authority: other users get 403 MUSE_NOT_ENABLED even though the CLI exists everywhere.

import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'

import {
  type ContainerIdentity,
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, sendJson, setSecurityHeaders } from '../http/util.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { readBodyBuffer } from './bridgeHttp.js'
import type { MuseBridgeHub } from './hub.js'
import {
  JOB_ID_RE,
  MUSE_INTERNAL_PREFIX,
  MUSE_LIMITS,
  MuseError,
  parseSubmission,
} from './protocol.js'

/** 4 source images × 10 MiB as base64, plus JSON slack. */
const SUBMIT_MAX_BYTES =
  Math.ceil((MUSE_LIMITS.max_source_images * MUSE_LIMITS.source_max_bytes * 4) / 3) + 64 * 1024
const MAX_WAIT_SEC = 25

export interface MuseInternalDeps {
  identityRepo: ContainerIdentityRepo
  /** Undefined when OC_MUSE_BRIDGE_ENABLED is off. */
  hub?: MuseBridgeHub
  logger?: Logger
}

export type MuseInternalHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

function sendErr(res: ServerResponse, err: MuseError, requestId: string): void {
  sendJson(res, err.status, {
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      request_id: requestId,
    },
  })
}

export function makeMuseInternalHandler(deps: MuseInternalDeps): MuseInternalHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'museInternal' })

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const url = new URL(req.url ?? '/', 'http://x.invalid')
    const sub = url.pathname.slice(MUSE_INTERNAL_PREFIX.length)
    const method = req.method ?? 'GET'
    try {
      let identity: ContainerIdentity
      try {
        identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
      } catch (err) {
        if (err instanceof ContainerIdentityError) {
          log.warn('identity_failed', { errcode: err.code })
          throw new MuseError(401, 'UNAUTHORIZED', 'container identity verification failed')
        }
        throw err
      }
      const userId = String(identity.userId)
      const hub = deps.hub
      if (!hub || !hub.isAllowed(userId)) {
        throw new MuseError(
          403,
          'MUSE_NOT_ENABLED',
          'Muse media tools are not enabled for this account',
        )
      }

      if (method === 'GET' && sub === '/status') {
        sendJson(res, 200, { enabled: true, bridge_online: hub.bridgeOnline() })
        return
      }
      if (method === 'POST' && sub === '/jobs') {
        const buf = await readBodyBuffer(req, SUBMIT_MAX_BYTES)
        let raw: unknown
        try {
          raw = JSON.parse(buf.toString('utf8'))
        } catch {
          throw new MuseError(400, 'MUSE_INVALID_INPUT', 'body is not valid JSON')
        }
        const spec = parseSubmission(raw)
        const jobId = await hub.submit(userId, String(identity.containerId), spec)
        sendJson(res, 202, { job_id: jobId })
        return
      }

      const m = /^\/jobs\/([^/]+)(?:\/files\/(\d+))?$/.exec(sub)
      if (!m || !JOB_ID_RE.test(m[1]!)) throw new MuseError(404, 'NOT_FOUND', 'not found')
      const jobId = m[1]!

      if (method === 'GET' && m[2] === undefined) {
        const waitRaw = Number(url.searchParams.get('wait') ?? '0')
        const waitSec = Number.isFinite(waitRaw) ? Math.max(0, Math.min(MAX_WAIT_SEC, waitRaw)) : 0
        const view = await hub.view(userId, jobId, waitSec * 1000)
        if (!view) throw new MuseError(404, 'NOT_FOUND', 'job not found')
        sendJson(res, 200, view)
        return
      }
      if (method === 'GET' && m[2] !== undefined) {
        const found = await hub.fileFor(userId, jobId, Number(m[2]))
        if (!found) throw new MuseError(404, 'NOT_FOUND', 'file not found')
        res.statusCode = 200
        res.setHeader('Content-Type', found.file.mime)
        res.setHeader('Content-Length', String(found.file.bytes))
        res.setHeader('X-Content-SHA256', found.file.sha256)
        res.setHeader('Content-Disposition', `attachment; filename="${found.file.filename}"`)
        await pipeline(createReadStream(found.path), res)
        return
      }
      if (method === 'DELETE' && m[2] === undefined) {
        const view = hub.cancel(userId, jobId)
        if (!view) throw new MuseError(404, 'NOT_FOUND', 'job not found')
        sendJson(res, 200, view)
        return
      }
      throw new MuseError(405, 'METHOD_NOT_ALLOWED', 'method not allowed')
    } catch (err) {
      if (err instanceof MuseError) {
        if (!res.headersSent && !res.destroyed) sendErr(res, err, requestId)
        return
      }
      log.error('muse_internal_error', { path: sub, err: (err as Error).message })
      if (!res.headersSent && !res.destroyed) {
        sendErr(res, new MuseError(500, 'INTERNAL', 'internal error'), requestId)
      } else if (!res.destroyed) {
        res.destroy()
      }
    }
  }
}
