// Muse media bridge — public endpoints the Muse VM bridge dials (OCV5-561).
//
//   POST /api/muse-bridge/v1/hello
//   POST /api/muse-bridge/v1/poll                         (long-poll, ≤ POLL_HOLD_SEC)
//   POST /api/muse-bridge/v1/jobs/:id/heartbeat           (first one = ack barrier)
//   GET  /api/muse-bridge/v1/jobs/:id/sources/:n          (bridge >= 0.5, after the ack; Range)
//   PUT  /api/muse-bridge/v1/jobs/:id/files/:idx/chunks/:n
//   POST /api/muse-bridge/v1/jobs/:id/result
//
// Auth: `Authorization: Bearer mbr_…`; only sha256(token) is stored (muse_bridge_credentials).
// Status codes the bridge relies on: 401 UNAUTHORIZED = stop (token rejected), 409 SUPERSEDED =
// superseded by a newer bridge (stop), 410 = job gone (drop it), 204 = no job. Everything else
// (400 for an unknown session after a master restart, 429, 5xx) makes the bridge back off and say
// hello again, so never answer 401/409 for anything but those meanings. The bridge only trusts
// these as JSON `{error:{code}}` bodies: a 401/403 without them came from a proxy or the CDN in
// front of the master and is reported as such (bridge >= 0.3.2). This handler never sends 403.
// The bridge self-check POSTs /api/muse-bridge/probe and expects the JSON 404 NOT_FOUND that the
// prefix check below sends *before* authenticate(), so it never counts as a failed login.

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { REQUEST_ID_HEADER, ensureRequestId, sendJson, setSecurityHeaders } from '../http/util.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import type { MuseBridgeHub } from './hub.js'
import {
  HEARTBEAT_SEC,
  JOB_ID_RE,
  MUSE_BRIDGE_API,
  MUSE_LIMITS,
  MuseError,
  POLL_HOLD_SEC,
} from './protocol.js'
import type { MuseStore } from './store.js'

const JSON_MAX_BYTES = 64 * 1024
const CRED_CACHE_MS = 30_000
const TOUCH_EVERY_MS = 60_000
const AUTH_FAIL_WINDOW_MS = 60_000
const AUTH_FAIL_MAX = 10
const AUTH_BLOCK_MS = 10 * 60_000
const TOKEN_RE = /^mbr_[A-Za-z0-9_-]{20,200}$/

export interface MuseBridgeHttpDeps {
  hub: MuseBridgeHub
  store: MuseStore
  logger?: Logger
  now?: () => number
  /** Tests shorten the long-poll hold; production uses POLL_HOLD_SEC. */
  pollHoldMs?: number
}

export type MuseBridgeHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { clientIp: string },
) => Promise<void>

/** Read a body into a Buffer, refusing anything over maxBytes (413). */
export async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MuseError(413, 'BODY_TOO_LARGE', 'request body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += b.length
    if (total > maxBytes) throw new MuseError(413, 'BODY_TOO_LARGE', 'request body too large')
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const buf = await readBodyBuffer(req, maxBytes)
  if (buf.length === 0) return {}
  let v: unknown
  try {
    v = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new MuseError(400, 'INVALID_JSON', 'body is not valid JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new MuseError(400, 'INVALID_JSON', 'body must be an object')
  }
  return v as Record<string, unknown>
}

/**
 * One `bytes=a-b` / `bytes=a-` range within `size`; null for no Range header. Anything else
 * (several ranges, suffix ranges, out of bounds) is 416: the bridge only ever asks for one.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined) return null
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  const start = m ? Number(m[1]) : Number.NaN
  const end = m && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1
  if (!m || !Number.isSafeInteger(start) || start >= size || end < start) {
    throw new MuseError(416, 'RANGE_NOT_SATISFIABLE', 'range not satisfiable')
  }
  return { start, end }
}

function sendErr(res: ServerResponse, err: MuseError, requestId: string): void {
  sendJson(res, err.status, {
    error: { code: err.code, message: err.message, request_id: requestId },
  })
}

export function makeMuseBridgeHttpHandler(deps: MuseBridgeHttpDeps): MuseBridgeHttpHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'museBridgeHttp' })
  const now = deps.now ?? Date.now
  const credCache = new Map<string, { id: string | null; at: number }>()
  const lastTouch = new Map<string, number>()
  const authFails = new Map<string, { count: number; windowStart: number; blockedUntil: number }>()

  async function authenticate(req: IncomingMessage, ip: string): Promise<string> {
    const t = now()
    const state = authFails.get(ip)
    if (state && state.blockedUntil > t) {
      throw new MuseError(429, 'AUTH_RATE_LIMITED', 'too many failed attempts')
    }
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    let credentialId: string | null = null
    if (TOKEN_RE.test(token)) {
      const sha = createHash('sha256').update(token).digest()
      const key = sha.toString('hex')
      const cached = credCache.get(key)
      if (cached && t - cached.at < CRED_CACHE_MS) {
        credentialId = cached.id
      } else {
        credentialId = (await deps.store.findCredential(sha))?.id ?? null
        if (credCache.size > 256) credCache.clear()
        credCache.set(key, { id: credentialId, at: t })
      }
    }
    if (!credentialId) {
      const s = authFails.get(ip)
      if (!s || t - s.windowStart > AUTH_FAIL_WINDOW_MS) {
        authFails.set(ip, { count: 1, windowStart: t, blockedUntil: 0 })
      } else {
        s.count += 1
        if (s.count > AUTH_FAIL_MAX) s.blockedUntil = t + AUTH_BLOCK_MS
      }
      if (authFails.size > 4096) authFails.clear()
      log.warn('muse_bridge_auth_fail', { clientIp: ip })
      throw new MuseError(401, 'UNAUTHORIZED', 'bridge token rejected')
    }
    return credentialId
  }

  function touch(credentialId: string, version: string | null, force = false): void {
    const t = now()
    if (!force && t - (lastTouch.get(credentialId) ?? 0) < TOUCH_EVERY_MS) return
    lastTouch.set(credentialId, t)
    deps.store.touchCredential(credentialId, version).catch((err) => {
      log.warn('muse_bridge_touch_failed', { err: (err as Error).message })
    })
  }

  function requireSession(req: IncomingMessage): string {
    const raw = req.headers['x-muse-bridge-session']
    const sessionId = typeof raw === 'string' ? raw : undefined
    const check = deps.hub.checkSession(sessionId)
    if (check === 'superseded') {
      throw new MuseError(409, 'SUPERSEDED', 'a newer bridge session took over')
    }
    if (check === 'unknown') {
      // Not 409: after a master restart the bridge must simply say hello again.
      throw new MuseError(400, 'SESSION_UNKNOWN', 'unknown session; send hello again')
    }
    return sessionId!
  }

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const url = new URL(req.url ?? '/', 'http://x.invalid')
    const path = url.pathname
    const method = req.method ?? 'GET'
    try {
      if (!path.startsWith(`${MUSE_BRIDGE_API}/`)) {
        throw new MuseError(404, 'NOT_FOUND', 'not found')
      }
      const sub = path.slice(MUSE_BRIDGE_API.length)
      const credentialId = await authenticate(req, ctx.clientIp)

      if (method === 'POST' && sub === '/hello') {
        const body = await readJson(req, JSON_MAX_BYTES)
        const version =
          typeof body.bridge_version === 'string' ? body.bridge_version.slice(0, 32) : null
        const sessionId = deps.hub.hello(credentialId, version)
        touch(credentialId, version, true)
        sendJson(res, 200, {
          session_id: sessionId,
          poll_hold_sec: POLL_HOLD_SEC,
          heartbeat_sec: HEARTBEAT_SEC,
          limits: MUSE_LIMITS,
          // Bridges >= 0.4.0 run this many jobs at once (capped by their --max-concurrency).
          max_concurrency: deps.hub.bridgeConcurrency(),
        })
        return
      }

      const sessionId = requireSession(req)
      touch(credentialId, null)

      if (method === 'POST' && sub === '/poll') {
        await readJson(req, JSON_MAX_BYTES)
        // Detect the client going away on the *response* side; req 'close' also fires after
        // a normally consumed body and must not be used here. One bridge keeps a poll per free
        // slot, so the abort names this poll, not the session.
        const gone = new AbortController()
        const onClose = () => {
          if (!res.writableEnded) gone.abort()
        }
        res.on('close', onClose)
        const job = await deps.hub.poll(
          sessionId,
          deps.pollHoldMs ?? POLL_HOLD_SEC * 1000,
          gone.signal,
        )
        res.off('close', onClose)
        if (!job) {
          if (!res.destroyed && !res.writableEnded) {
            res.statusCode = 204
            res.end()
          }
          return
        }
        if (res.destroyed || res.writableEnded) {
          deps.hub.undeliverable(job.id)
          return
        }
        sendJson(res, 200, { job })
        return
      }

      const src = /^\/jobs\/([^/]+)\/sources\/(\d+)$/.exec(sub)
      if (src && method === 'GET') {
        if (!JOB_ID_RE.test(src[1]!)) throw new MuseError(404, 'NOT_FOUND', 'not found')
        const nonce = String(req.headers['x-job-nonce'] ?? '')
        const source = deps.hub.source(src[1]!, nonce, Number(src[2]))
        const size = source.data.length
        const range = parseByteRange(req.headers.range, size)
        const body = range ? source.data.subarray(range.start, range.end + 1) : source.data
        res.statusCode = range ? 206 : 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(body.length))
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Source-Sha256', source.sha256)
        res.setHeader('X-Source-Bytes', String(size))
        if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        res.end(body)
        return
      }

      const m = /^\/jobs\/([^/]+)\/(heartbeat|result|files\/(\d+)\/chunks\/(\d+))$/.exec(sub)
      if (!m || !JOB_ID_RE.test(m[1]!)) throw new MuseError(404, 'NOT_FOUND', 'not found')
      const jobId = m[1]!

      if (method === 'POST' && m[2] === 'heartbeat') {
        const body = await readJson(req, JSON_MAX_BYTES)
        const nonce = typeof body.job_nonce === 'string' ? body.job_nonce : ''
        sendJson(res, 200, deps.hub.heartbeat(jobId, nonce))
        return
      }
      if (method === 'POST' && m[2] === 'result') {
        const body = await readJson(req, JSON_MAX_BYTES)
        const nonce = typeof body.job_nonce === 'string' ? body.job_nonce : ''
        await deps.hub.result(jobId, nonce, body)
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'PUT' && m[3] !== undefined && m[4] !== undefined) {
        const nonce = String(req.headers['x-job-nonce'] ?? '')
        const sha = String(req.headers['x-chunk-sha256'] ?? '').toLowerCase()
        const data = await readBodyBuffer(req, MUSE_LIMITS.chunk_bytes)
        await deps.hub.putChunk(jobId, nonce, Number(m[3]), Number(m[4]), data, sha)
        sendJson(res, 200, { ok: true })
        return
      }
      throw new MuseError(405, 'METHOD_NOT_ALLOWED', 'method not allowed')
    } catch (err) {
      if (err instanceof MuseError) {
        if (!res.headersSent && !res.destroyed) sendErr(res, err, requestId)
        return
      }
      log.error('muse_bridge_http_error', { path, err: (err as Error).message })
      if (!res.headersSent && !res.destroyed) {
        sendErr(res, new MuseError(500, 'INTERNAL', 'internal error'), requestId)
      }
    }
  }
}

/** Router entry for `/api/muse-bridge/*`. 404 unless OC_MUSE_BRIDGE_ENABLED assembled it. */
export async function dispatchMuseBridgeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { clientIp: string; requestId: string },
  deps: { museBridgeHttp?: MuseBridgeHttpHandler },
): Promise<void> {
  if (!deps.museBridgeHttp) {
    sendErr(res, new MuseError(404, 'NOT_FOUND', 'not found'), ctx.requestId)
    return
  }
  await deps.museBridgeHttp(req, res, ctx)
}
