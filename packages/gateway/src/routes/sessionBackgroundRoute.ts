/**
 * Container-gateway internal HTTP endpoints for session background task state & control (OCV5-844):
 *   - GET  `/internal/sessions/:id/background-state`
 *   - POST `/internal/sessions/:id/inflight-delegates/:jobId/cancel`
 *   - POST `/internal/sessions/:id/bg-commands/:jobId/cancel`
 *
 * Security invariants:
 *   - Protected by fail-closed `verifyInternalBridgeAuthDetailed(req, { body })`
 *     (same master → container HMAC + anti-replay gate as `/internal/swarm/command`).
 *   - Never exposed under `/api/*`; only commercial master dials these via
 *     `requestUserContainerInternal(...)` after authenticating the user and verifying PG
 *     `client_sessions` ownership.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CronJob } from '../cron.js'
import { cancelSingleDelegateJob, type DelegateCancelHost } from '../delegateCancel.js'
import {
  INFLIGHT_GET_DEFAULT_LIMIT,
  sessionIdFromParentKey,
  type DelegateInflightSurfaceStore,
} from '../delegateInflightSurface.js'
import type { DelegateJobStore } from '../delegateJobs.js'
import {
  cancelSessionBgCommand,
  listSessionBgCommands,
  type SessionBgCommandsOps,
} from '../sessionBgCommands.js'
import {
  verifyInternalBridgeAuthDetailed,
  verifyInternalBridgeHeaderPrecheck,
  type InternalBridgeAuthResult,
  type InternalBridgeReplayCache,
} from './internalBridgeAuth.js'
import type { PreAuthRoutesIo } from './preAuth.js'
import { type HttpRoute, predicateRoute } from './routeTable.js'

export interface SessionOriginCronItem {
  id: string
  name: string
  enabled: boolean
  schedule: string
  message?: string
  nextRunAt: number | null
  oneshot?: boolean
  resume: 'origin-session'
  sourceSessionKey: string
}

export type CronJobsWithMetaReader = () => Promise<
  Array<CronJob & { nextRunAt?: string | number; lastRunAt?: string }>
>

export async function listSessionOriginCrons(
  sessionId: string,
  listJobsWithMeta?: CronJobsWithMetaReader,
): Promise<SessionOriginCronItem[]> {
  const sid = sessionId.trim()
  if (!sid || !listJobsWithMeta) return []
  let jobs: Array<CronJob & { nextRunAt?: string | number }>
  try {
    jobs = await listJobsWithMeta()
  } catch {
    return []
  }
  const items: SessionOriginCronItem[] = []
  for (const job of jobs) {
    if (job.resume !== 'origin-session') continue
    if (typeof job.sourceSessionKey !== 'string' || !job.sourceSessionKey.trim()) continue
    if (sessionIdFromParentKey(job.sourceSessionKey) !== sid) continue
    const rawPrompt = typeof job.prompt === 'string' ? job.prompt.replace(/\s+/g, ' ').trim() : ''
    const name = (typeof job.label === 'string' ? job.label.trim() : '') || rawPrompt.slice(0, 80) || job.id
    const message = rawPrompt ? rawPrompt.slice(0, 240) : undefined
    let nextRunAt: number | null = null
    if (typeof job.nextRunAt === 'number' && Number.isFinite(job.nextRunAt)) {
      nextRunAt = job.nextRunAt
    } else if (typeof job.nextRunAt === 'string' && job.nextRunAt.trim()) {
      const parsed = Date.parse(job.nextRunAt)
      if (Number.isFinite(parsed)) nextRunAt = parsed
    }
    items.push({
      id: job.id,
      name,
      enabled: job.enabled !== false,
      schedule: job.schedule,
      ...(message ? { message } : {}),
      nextRunAt,
      ...(job.oneshot ? { oneshot: true } : {}),
      resume: 'origin-session',
      sourceSessionKey: job.sourceSessionKey,
    })
  }
  items.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (a.nextRunAt !== null && b.nextRunAt !== null) return a.nextRunAt - b.nextRunAt
    if (a.nextRunAt !== null) return -1
    if (b.nextRunAt !== null) return 1
    return a.id.localeCompare(b.id)
  })
  return items
}

export const INTERNAL_SESSION_BG_STATE_RE =
  /^\/internal\/sessions\/([^/]+)\/background-state$/
export const INTERNAL_SESSION_DELEGATE_CANCEL_RE =
  /^\/internal\/sessions\/([^/]+)\/inflight-delegates\/([^/]+)\/cancel$/
export const INTERNAL_SESSION_BG_CMD_CANCEL_RE =
  /^\/internal\/sessions\/([^/]+)\/bg-commands\/([^/]+)\/cancel$/

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_INTERNAL_CONTROL_BODY_BYTES = 8 * 1024

export interface InternalSessionBackgroundDeps {
  verifyAuth?: (
    req: IncomingMessage,
    body?: Buffer,
  ) => boolean | InternalBridgeAuthResult
  env?: NodeJS.ProcessEnv
  replayCache?: InternalBridgeReplayCache
  now?: () => number
  delegateJobs?: () => DelegateJobStore | undefined
  ensureDelegateInflightSurface?: () => DelegateInflightSurfaceStore
  delegateCancelHost?: () => DelegateCancelHost
  listCronJobsWithMeta?: CronJobsWithMetaReader
  bgCommandsRegistryDir?: string
  bgCommandsOps?: SessionBgCommandsOps
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function normalizeAuthOutcome(res: boolean | InternalBridgeAuthResult): InternalBridgeAuthResult {
  if (typeof res === 'boolean') {
    return res
      ? { ok: true }
      : { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  return res
}

async function readRawBodyBounded(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error('BODY_TOO_LARGE')
    }
    chunks.push(buf)
  }
  return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total)
}

function decodeSegment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim()
    return decoded || null
  } catch {
    return null
  }
}

async function verifyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalSessionBackgroundDeps,
  readBody: boolean,
): Promise<boolean> {
  if (!deps.verifyAuth) {
    const pre = verifyInternalBridgeHeaderPrecheck(req, { env: deps.env, now: deps.now })
    if (!pre.ok) {
      sendJson(res, pre.status, { ok: false, code: pre.code, error: pre.error })
      return false
    }
  }
  let rawBody: Buffer = Buffer.alloc(0)
  if (readBody) {
    try {
      rawBody = await readRawBodyBounded(req, MAX_INTERNAL_CONTROL_BODY_BYTES)
    } catch (err) {
      if ((err as Error).message === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', error: 'payload exceeds limit' })
        return false
      }
      sendJson(res, 400, { ok: false, code: 'INVALID_BODY', error: 'failed to read body' })
      return false
    }
  }
  const authOutcome = deps.verifyAuth
    ? normalizeAuthOutcome(deps.verifyAuth(req, rawBody))
    : verifyInternalBridgeAuthDetailed(req, {
        env: deps.env,
        body: rawBody,
        now: deps.now,
        replayCache: deps.replayCache,
      })
  if (!authOutcome.ok) {
    sendJson(res, authOutcome.status, {
      ok: false,
      code: authOutcome.code,
      error: authOutcome.error,
    })
    return false
  }
  return true
}

export async function handleInternalSessionBackgroundState(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalSessionBackgroundDeps = {},
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'GET') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
    return
  }
  if (!(await verifyRequest(req, res, deps, false))) return

  const match = INTERNAL_SESSION_BG_STATE_RE.exec(url.pathname)
  const sessionId = match?.[1] ? decodeSegment(match[1]) : null
  if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SESSION_ID', error: 'valid sessionId required' })
    return
  }

  let delegates: unknown[] = []
  let nextCursor: string | null = null
  let truncated = false
  try {
    const surface = deps.ensureDelegateInflightSurface?.()
    const jobs = deps.delegateJobs?.()
    if (surface) {
      if (jobs) {
        try {
          surface.rebuildFromJobs(jobs.listNonTerminal(), {
            resolveJob: (id) => jobs.snapshotOf(id),
          })
        } catch {
          /* fail-open overlay */
        }
      }
      const rawLimit = Number(url.searchParams.get('limit') ?? '')
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : INFLIGHT_GET_DEFAULT_LIMIT
      const cursor = url.searchParams.get('cursor') || undefined
      // Single-tenant container: master already verified PG ownership of `sessionId`.
      // Omit userId filter so container-local 'default' vs 'master:<uid>' rows both match.
      const page = surface.listForSessionId(sessionId, { limit, cursor })
      delegates = page.items
      nextCursor = page.nextCursor
      truncated = page.truncated
    }
  } catch {
    delegates = []
  }

  const bgCommands = listSessionBgCommands(
    sessionId,
    deps.bgCommandsRegistryDir,
    deps.bgCommandsOps,
  )
  const sessionCrons = await listSessionOriginCrons(sessionId, deps.listCronJobsWithMeta)

  sendJson(res, 200, {
    delegates,
    nextCursor,
    truncated,
    bgCommands,
    sessionCrons,
  })
}

export async function handleInternalSessionDelegateCancel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalSessionBackgroundDeps = {},
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
    return
  }
  if (!(await verifyRequest(req, res, deps, true))) return

  const match = INTERNAL_SESSION_DELEGATE_CANCEL_RE.exec(url.pathname)
  const sessionId = match?.[1] ? decodeSegment(match[1]) : null
  const jobId = match?.[2] ? decodeSegment(match[2]) : null
  if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SESSION_ID', error: 'valid sessionId required' })
    return
  }
  if (!jobId) {
    sendJson(res, 400, { ok: false, code: 'INVALID_JOB_ID', error: 'valid jobId required' })
    return
  }
  const host = deps.delegateCancelHost?.()
  if (!host) {
    sendJson(res, 503, { ok: false, code: 'UNAVAILABLE', error: 'delegate cancel unavailable' })
    return
  }
  const result = cancelSingleDelegateJob(host, sessionId, jobId)
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, code: result.code, error: result.error })
    return
  }
  sendJson(res, 200, result)
}

export async function handleInternalSessionBgCmdCancel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalSessionBackgroundDeps = {},
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
    return
  }
  if (!(await verifyRequest(req, res, deps, true))) return

  const match = INTERNAL_SESSION_BG_CMD_CANCEL_RE.exec(url.pathname)
  const sessionId = match?.[1] ? decodeSegment(match[1]) : null
  const jobId = match?.[2] ? decodeSegment(match[2]) : null
  if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SESSION_ID', error: 'valid sessionId required' })
    return
  }
  if (!jobId) {
    sendJson(res, 400, { ok: false, code: 'INVALID_JOB_ID', error: 'valid jobId required' })
    return
  }
  const result = await cancelSessionBgCommand(
    sessionId,
    jobId,
    deps.bgCommandsRegistryDir,
    deps.bgCommandsOps,
  )
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, code: result.code, error: result.error })
    return
  }
  sendJson(res, 200, result)
}

export const SESSION_BACKGROUND_INTERNAL_ROUTES: readonly HttpRoute<PreAuthRoutesIo>[] = [
  predicateRoute(
    'GET /internal/sessions/:id/background-state',
    (req, url) => INTERNAL_SESSION_BG_STATE_RE.test(url.pathname) && req.method === 'GET',
    (io, req, res, url) => {
      handleInternalSessionBackgroundState(req, res, url, {
        delegateJobs: io.delegateJobs,
        ensureDelegateInflightSurface: io.ensureDelegateInflightSurface,
        listCronJobsWithMeta: io.listCronJobsWithMeta,
      }).catch((err) => {
        io.log.error('internal session background-state handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, code: 'INTERNAL', error: 'internal background state error' })
        }
      })
      return true
    },
  ),
  predicateRoute(
    'POST /internal/sessions/:id/inflight-delegates/:jobId/cancel',
    (req, url) => INTERNAL_SESSION_DELEGATE_CANCEL_RE.test(url.pathname) && req.method === 'POST',
    (io, req, res, url) => {
      handleInternalSessionDelegateCancel(req, res, url, {
        delegateCancelHost: io.delegateCancelHost,
      }).catch((err) => {
        io.log.error('internal delegate cancel handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, code: 'INTERNAL', error: 'internal delegate cancel error' })
        }
      })
      return true
    },
  ),
  predicateRoute(
    'POST /internal/sessions/:id/bg-commands/:jobId/cancel',
    (req, url) => INTERNAL_SESSION_BG_CMD_CANCEL_RE.test(url.pathname) && req.method === 'POST',
    (io, req, res, url) => {
      handleInternalSessionBgCmdCancel(req, res, url).catch((err) => {
        io.log.error('internal bg-command cancel handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, code: 'INTERNAL', error: 'internal bg command cancel error' })
        }
      })
      return true
    },
  ),
]
