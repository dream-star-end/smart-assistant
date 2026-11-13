import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { requireAuth } from './auth.js'
import { HttpError, sendJson } from './util.js'
import { query } from '../db/queries.js'

type Handler = (req: IncomingMessage, res: ServerResponse, context: RequestContext, deps: CommercialHttpDeps) => Promise<void>
/** Dispatch only the new exact metadata shape; existing GitHub GET semantics keep their original handler. */
export async function dispatchSessionMetadataRead(req: IncomingMessage, res: ServerResponse, context: RequestContext, deps: CommercialHttpDeps, fallback: Handler): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const match = /^\/api\/me\/sessions\/([^/]+)\/metadata$/.exec(path)
  if (!match) return fallback(req, res, context, deps)
  const user = await requireAuth(req, deps.jwtSecret)
  if (!deps.sessionMetadataRead) throw new HttpError(503, 'UNAVAILABLE', 'session authority unavailable')
  let id: string
  try { id = decodeURIComponent(match[1]!) } catch { throw new HttpError(404, 'NOT_FOUND', 'session not found') }
  if (!id || id.length > 160 || id.includes('\0')) throw new HttpError(404, 'NOT_FOUND', 'session not found')
  const active = await query<{ role: string }>("SELECT role FROM users WHERE id=$1::bigint AND status='active' AND deleted_at IS NULL", [user.id])
  if (active.rows.length !== 1 || active.rows[0]?.role !== user.role) throw new HttpError(403, 'FORBIDDEN', 'account unavailable')
  const metadata = await deps.sessionMetadataRead(`c:${user.id}`, id)
  if (!metadata) throw new HttpError(404, 'NOT_FOUND', 'session not found')
  sendJson(res, 200, { id: metadata.id, title: metadata.title, pinned: metadata.pinned, updatedAt: metadata.updatedAt })
}
