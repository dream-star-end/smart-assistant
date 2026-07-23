import type { IncomingMessage, ServerResponse } from 'node:http'

import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import {
  listAutoDreamPlatformFindings,
  updateAutoDreamPlatformFindingStatus,
} from '../../autoDream/optimizerStore.js'
import { getPool } from '../../db/index.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'
import { parseNonNegativeInt, parsePositiveInt } from './_shared.js'

const STATUSES = new Set(['all', 'new', 'triaged', 'planned', 'resolved', 'dismissed'])

export async function handleAdminListAutoDreamFindings(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const status = url.searchParams.get('status') ?? 'all'
  if (!STATUSES.has(status)) throw new HttpError(400, 'VALIDATION', 'invalid status')
  const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 200) ?? 50
  const offset = parseNonNegativeInt(url.searchParams.get('offset'), 'offset') ?? 0
  const result = await listAutoDreamPlatformFindings(getPool(), { status, limit, offset })
  sendJson(res, 200, result)
}

export async function handleAdminUpdateAutoDreamFinding(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const match = url.pathname.match(/^\/api\/admin\/auto-dream-findings\/(\d+)$/)
  if (!match) throw new HttpError(400, 'VALIDATION', 'invalid finding id')
  const body = (await readJsonBody(req, 4 * 1024)) as { status?: unknown } | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'body must be a JSON object')
  }
  if (typeof body.status !== 'string' || body.status === 'all' || !STATUSES.has(body.status)) {
    throw new HttpError(400, 'VALIDATION', 'invalid status')
  }
  const ok = await updateAutoDreamPlatformFindingStatus(getPool(), {
    id: match[1]!,
    status: body.status,
    adminId: admin.id,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  })
  if (!ok) throw new HttpError(404, 'NOT_FOUND', 'finding not found')
  sendJson(res, 200, { ok: true })
}
