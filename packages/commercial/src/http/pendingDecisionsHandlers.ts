/**
 * Unified Pending Decisions ("待拍板") HTTP Handlers.
 *
 * Routes:
 *   GET  /api/me/pending-decisions[?source=turn_permission,connector_write&limit=50]
 *   POST /api/me/pending-decisions/:id/resolve
 *
 * Designed for 2-line wiring in commercial HTTP router/index without touching index.ts:
 *   const handlePendingDecisions = mountPendingDecisionsRoutes({ jwtSecret, service })
 *   if (await handlePendingDecisions(req, res)) return true
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PENDING_DECISIONS_LIST_PATH,
  isPendingDecisionAction,
  isPendingDecisionSource,
  type PendingDecisionSource,
  type ResolvePendingDecisionRequest,
} from '@openclaude/protocol'
import {
  PendingDecisionError,
  type PendingDecisionsService,
} from '../pendingDecisions/index.js'
import { requireAuth, type AuthedUser } from './auth.js'
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from './util.js'

export const PENDING_DECISIONS_RESOLVE_RE = /^\/api\/me\/pending-decisions\/([^/]+)\/resolve$/

export interface PendingDecisionsRouteDeps {
  jwtSecret: string | Uint8Array
  service?: PendingDecisionsService
  /** Optional custom authenticator (e.g. cookie-or-bearer); defaults to Bearer `requireAuth`. */
  authenticate?: (req: IncomingMessage) => Promise<AuthedUser>
}

function parseSourcesQuery(raw: string | null): PendingDecisionSource[] | undefined {
  if (!raw || !raw.trim()) return undefined
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return undefined
  const out: PendingDecisionSource[] = []
  for (const p of parts) {
    if (!isPendingDecisionSource(p)) {
      throw new HttpError(400, 'INVALID_SOURCE', `unsupported pending decision source: ${p}`)
    }
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function parseLimitQuery(raw: string | null): number | undefined {
  if (!raw || !raw.trim()) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new HttpError(400, 'INVALID_LIMIT', 'limit must be an integer between 1 and 200')
  }
  return n
}

function mapPendingDecisionError(err: unknown): never {
  if (err instanceof HttpError) throw err
  if (err instanceof PendingDecisionError) {
    throw new HttpError(err.httpStatus, err.code, err.message)
  }
  throw err
}

function parseResolveBody(raw: unknown): ResolvePendingDecisionRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'INVALID_BODY', 'JSON object body is required')
  }
  const obj = raw as Record<string, unknown>
  if (!isPendingDecisionAction(obj.decision)) {
    throw new HttpError(400, 'INVALID_ACTION', 'decision must be "approve" or "deny"')
  }
  if (obj.reason !== undefined && typeof obj.reason !== 'string') {
    throw new HttpError(400, 'INVALID_BODY', 'reason must be a string')
  }
  if (obj.idempotencyKey !== undefined && typeof obj.idempotencyKey !== 'string') {
    throw new HttpError(400, 'INVALID_BODY', 'idempotencyKey must be a string')
  }
  if (obj.originChannel !== undefined && typeof obj.originChannel !== 'string') {
    throw new HttpError(400, 'INVALID_BODY', 'originChannel must be a string')
  }
  return {
    decision: obj.decision,
    ...(typeof obj.reason === 'string' && obj.reason.trim()
      ? { reason: obj.reason.trim().slice(0, 500) }
      : {}),
    ...(typeof obj.idempotencyKey === 'string' && obj.idempotencyKey.trim()
      ? { idempotencyKey: obj.idempotencyKey.trim().slice(0, 128) }
      : {}),
    ...(typeof obj.originChannel === 'string' && obj.originChannel.trim()
      ? { originChannel: obj.originChannel.trim().slice(0, 32) }
      : { originChannel: 'web' }),
  }
}

export async function handleListPendingDecisions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PendingDecisionsRouteDeps,
): Promise<void> {
  if (!deps.service) {
    throw new HttpError(503, 'PENDING_DECISIONS_UNAVAILABLE', 'pending decisions service unavailable')
  }
  const user = await (deps.authenticate ? deps.authenticate(req) : requireAuth(req, deps.jwtSecret))
  const url = new URL(req.url ?? '/', 'http://x')
  const sources = parseSourcesQuery(url.searchParams.get('source'))
  const limit = parseLimitQuery(url.searchParams.get('limit'))
  try {
    const payload = await deps.service.list(user.id, { sources, limit })
    sendJson(res, 200, payload)
  } catch (err) {
    mapPendingDecisionError(err)
  }
}

export async function handleResolvePendingDecision(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PendingDecisionsRouteDeps,
  encodedDecisionId: string,
): Promise<void> {
  if (!deps.service) {
    throw new HttpError(503, 'PENDING_DECISIONS_UNAVAILABLE', 'pending decisions service unavailable')
  }
  const user = await (deps.authenticate ? deps.authenticate(req) : requireAuth(req, deps.jwtSecret))
  let decisionId: string
  try {
    decisionId = decodeURIComponent(encodedDecisionId)
  } catch {
    throw new HttpError(400, 'INVALID_ID', 'invalid decision id encoding')
  }
  const rawBody = await readJsonBody(req)
  const body = parseResolveBody(rawBody)
  try {
    const result = await deps.service.resolve(user.id, decisionId, body)
    sendJson(res, 200, result)
  } catch (err) {
    mapPendingDecisionError(err)
  }
}

/**
 * Route matcher & dispatcher for `/api/me/pending-decisions` and
 * `/api/me/pending-decisions/:id/resolve`.
 *
 * Returns `true` when the request path matched (and response was written or HttpError handled),
 * `false` when the path did not match so caller can fall through.
 */
export async function dispatchPendingDecisionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PendingDecisionsRouteDeps,
): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const isList = pathname === PENDING_DECISIONS_LIST_PATH
  const resolveMatch = isList ? null : PENDING_DECISIONS_RESOLVE_RE.exec(pathname)
  if (!isList && !resolveMatch) return false

  setSecurityHeaders(res)
  const requestId = ensureRequestId(req)
  res.setHeader(REQUEST_ID_HEADER, requestId)

  try {
    if (isList) {
      if (req.method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET required')
      }
      await handleListPendingDecisions(req, res, deps)
      return true
    }

    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required')
    }
    await handleResolvePendingDecision(req, res, deps, resolveMatch![1]!)
    return true
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.code, err.message, requestId, err.issues, err.extraHeaders)
      return true
    }
    sendError(res, 500, 'INTERNAL', 'internal server error', requestId)
    return true
  }
}

/**
 * 2-line mount helper for commercial HTTP entrypoint (`router.ts` / `index.ts`):
 *   const handlePendingDecisions = mountPendingDecisionsRoutes({ jwtSecret, service })
 *   if (await handlePendingDecisions(req, res)) return true
 */
export function mountPendingDecisionsRoutes(
  deps: PendingDecisionsRouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return (req, res) => dispatchPendingDecisionsRoute(req, res, deps)
}
