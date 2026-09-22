/**
 * Admin list + one-click session ban for Jev content reviews.
 * The review itself never blocks the message. Ban stops later messages.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { getContentReviewStore } from '../../../../gateway/src/contentReviewStore.js'

import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, sendJson } from '../util.js'

export async function handleAdminListContentReviews(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  const limit = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? '50')
  sendJson(res, 200, { items: getContentReviewStore().list(Number.isFinite(limit) ? limit : 50) })
}

export async function handleAdminBanContentReview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const match = new URL(req.url ?? '/', 'http://x').pathname.match(/\/api\/admin\/content-reviews\/(\d+)\/ban$/)
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'not found')
  const review = getContentReviewStore().ban(Number(match[1]), `admin:${String(admin.id)}`)
  if (!review) throw new HttpError(404, 'NOT_FOUND', 'review not found')
  sendJson(res, 200, { ok: true, review })
}
