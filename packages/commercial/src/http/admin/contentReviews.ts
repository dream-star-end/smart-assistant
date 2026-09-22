/**
 * Admin list, one-click violation notice, and appeal decisions.
 * The review never blocks the message that triggered it.
 * A notice records one strike. Three open strikes ban the account.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { getContentReviewStore } from '../../../../gateway/src/contentReviewStore.js'

import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import {
  decideContentAppeal,
  fileContentAppeal,
  listPendingContentAppeals,
  sendContentViolationNotice,
} from '../../inbox/contentReviewStrikes.js'
import { requireAuth } from '../auth.js'
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

export async function handleAdminNotifyContentReview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const match = new URL(req.url ?? '/', 'http://x').pathname.match(/\/api\/admin\/content-reviews\/(\d+)\/notify$/)
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'not found')
  const review = getContentReviewStore().get(Number(match[1]))
  if (!review) throw new HttpError(404, 'NOT_FOUND', 'review not found')
  if (!review.thresholdMet || review.choice !== 'policy_violation') {
    throw new HttpError(400, 'VALIDATION', 'only a confirmed policy violation can be sent')
  }
  try {
    const result = await sendContentViolationNotice({
      adminId: String(admin.id),
      userId: review.userId,
      reviewId: review.id,
      sessionKey: review.sessionKey,
      excerpt: review.excerpt,
    })
    getContentReviewStore().markNotified(review.id)
    sendJson(res, 200, { ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'notice failed'
    if (message === 'CONTENT_REVIEW_USER_INVALID') {
      throw new HttpError(400, 'VALIDATION', 'review is not tied to a numeric user')
    }
    throw err
  }
}

export async function handleAdminListContentAppeals(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  sendJson(res, 200, { items: await listPendingContentAppeals() })
}

export async function handleAdminDecideContentAppeal(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const match = new URL(req.url ?? '/', 'http://x').pathname.match(
    /\/api\/admin\/content-appeals\/(\d+)\/(approve|reject)$/,
  )
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'not found')
  try {
    const result = await decideContentAppeal({
      adminId: String(admin.id),
      appealId: match[1]!,
      approve: match[2] === 'approve',
    })
    sendJson(res, 200, { ok: true, ...result })
  } catch (err) {
    if (err instanceof Error && err.message === 'CONTENT_APPEAL_NOT_FOUND') {
      throw new HttpError(404, 'NOT_FOUND', 'appeal not found')
    }
    throw err
  }
}

export async function handleFileContentAppeal(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  let body: { strikeId?: unknown; statement?: unknown } = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body
  } catch {
    throw new HttpError(400, 'VALIDATION', 'invalid json')
  }
  const strikeId = typeof body.strikeId === 'string' ? body.strikeId : ''
  const statement = typeof body.statement === 'string' ? body.statement : ''
  if (!/^[1-9][0-9]{0,18}$/.test(strikeId)) throw new HttpError(400, 'VALIDATION', 'strikeId required')
  try {
    const result = await fileContentAppeal({ userId: user.id, strikeId, statement })
    sendJson(res, 200, { ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message === 'CONTENT_APPEAL_NOT_FOUND') throw new HttpError(404, 'NOT_FOUND', 'strike not found')
    if (message === 'CONTENT_APPEAL_EMPTY') throw new HttpError(400, 'VALIDATION', 'statement required')
    throw err
  }
}
