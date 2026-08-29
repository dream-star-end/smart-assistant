import type { IncomingMessage, ServerResponse } from 'node:http'

import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import { isSignalTrafficFilter, signalTrafficFilterValue } from '../../analytics/signalTraffic.js'
import {
  listAutoDreamPlatformFindings,
  updateAutoDreamPlatformFindings,
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
  const traffic = url.searchParams.get('traffic_class') ?? 'production_user'
  if (!isSignalTrafficFilter(traffic)) {
    throw new HttpError(400, 'VALIDATION', 'invalid traffic_class')
  }
  const model = url.searchParams.get('model') ?? 'current'
  if (model !== 'current' && model !== 'all' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model)) {
    throw new HttpError(400, 'VALIDATION', 'invalid model')
  }
  const seenWithin = url.searchParams.get('seen_within') ?? 'all'
  const windows: Record<string, number | null> = {
    all: null,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }
  if (!(seenWithin in windows)) throw new HttpError(400, 'VALIDATION', 'invalid seen_within')
  const minAffectedUsers = parseNonNegativeInt(
    url.searchParams.get('min_affected_users'),
    'min_affected_users',
  ) ?? 0
  const ownerRaw = url.searchParams.get('owner')
  if (ownerRaw !== null && (ownerRaw.length < 1 || ownerRaw.length > 128)) {
    throw new HttpError(400, 'VALIDATION', 'invalid owner')
  }
  const result = await listAutoDreamPlatformFindings(getPool(), {
    status,
    limit,
    offset,
    trafficClass: signalTrafficFilterValue(traffic),
    model,
    seenAfter: windows[seenWithin] === null ? null : new Date(Date.now() - windows[seenWithin]!),
    minAffectedUsers,
    owner: ownerRaw,
  })
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
  const isBatch = url.pathname === '/api/admin/auto-dream-findings/batch'
  const match = url.pathname.match(/^\/api\/admin\/auto-dream-findings\/(\d+)$/)
  if (!isBatch && !match) throw new HttpError(400, 'VALIDATION', 'invalid finding id')
  const body = (await readJsonBody(req, 16 * 1024)) as {
    ids?: unknown
    status?: unknown
    owner?: unknown
  } | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'body must be a JSON object')
  }
  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' || body.status === 'all' || !STATUSES.has(body.status))
  ) {
    throw new HttpError(400, 'VALIDATION', 'invalid status')
  }
  if (
    body.owner !== undefined &&
    body.owner !== null &&
    (typeof body.owner !== 'string' || body.owner.trim().length < 1 || body.owner.length > 128)
  ) {
    throw new HttpError(400, 'VALIDATION', 'invalid owner')
  }
  const ids = isBatch ? body.ids : [match![1]!]
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !/^\d+$/.test(id))) {
    throw new HttpError(400, 'VALIDATION', 'ids must contain 1..200 bigint strings')
  }
  if (body.status === undefined && body.owner === undefined) {
    throw new HttpError(400, 'VALIDATION', 'status or owner is required')
  }
  const updated = await updateAutoDreamPlatformFindings(getPool(), {
    ids: ids as string[],
    ...(typeof body.status === 'string' ? { status: body.status } : {}),
    ...(body.owner === null || typeof body.owner === 'string' ? { owner: body.owner } : {}),
    adminId: admin.id,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  })
  if (updated === 0) throw new HttpError(404, 'NOT_FOUND', 'finding not found')
  sendJson(res, 200, { ok: true, updated })
}
