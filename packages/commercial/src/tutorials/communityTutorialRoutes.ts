import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeAdminAuditBestEffort } from '../admin/audit.js'
import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { requireAuth } from '../http/auth.js'
import { HttpError, clientIpOf, readJsonBody, sendJson, userAgentOf } from '../http/util.js'
import {
  COMMUNITY_TUTORIAL_CATEGORIES,
  COMMUNITY_TUTORIAL_MAX_PAGE_SIZE,
  COMMUNITY_TUTORIAL_PAGE_SIZE,
  CommunityTutorialError,
  type CommunityTutorialCategory,
  decodeTutorialCursor,
  getPublishedCommunityTutorial,
  listOwnCommunityTutorials,
  listPendingCommunityTutorials,
  listPublishedCommunityTutorials,
  reviewCommunityTutorial,
  submitCommunityTutorial,
  withdrawCommunityTutorial,
} from './communityTutorials.js'

type TutorialRouteDeps = { jwtSecret: string | Uint8Array }

function mapTutorialError(error: unknown): HttpError {
  if (!(error instanceof CommunityTutorialError))
    return error instanceof HttpError
      ? error
      : new HttpError(500, 'INTERNAL', 'community tutorial error')
  if (error.code === 'BAD_CURSOR') return new HttpError(400, error.code, error.message)
  if (error.code === 'NOT_FOUND') return new HttpError(404, error.code, error.message)
  return new HttpError(409, error.code, error.message)
}

function pageArgs(req: IncomingMessage): {
  cursor: ReturnType<typeof decodeTutorialCursor>
  limit: number
} {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? COMMUNITY_TUTORIAL_PAGE_SIZE : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > COMMUNITY_TUTORIAL_MAX_PAGE_SIZE)
    throw new HttpError(400, 'BAD_REQUEST', `limit must be 1..${COMMUNITY_TUTORIAL_MAX_PAGE_SIZE}`)
  try {
    return { cursor: decodeTutorialCursor(url.searchParams.get('cursor')), limit }
  } catch (error) {
    throw mapTutorialError(error)
  }
}

function category(value: unknown): CommunityTutorialCategory {
  if (
    typeof value !== 'string' ||
    !(COMMUNITY_TUTORIAL_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new HttpError(400, 'BAD_REQUEST', 'category must be research|coding|general')
  }
  return value as CommunityTutorialCategory
}

function optionalCategory(value: string | null): CommunityTutorialCategory | null {
  return value === null || value === '' ? null : category(value)
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', `${field} required`)
  const normalized = value.trim()
  const length = [...normalized].length
  if (length < min || length > max)
    throw new HttpError(400, 'BAD_REQUEST', `${field} length must be ${min}..${max}`)
  return normalized
}

function tutorialId(req: IncomingMessage, suffix = ''): string {
  const pattern = new RegExp(`^/api/(?:admin/)?tutorials/([1-9]\\d*)${suffix}(?:\\?|$)`)
  const match = (req.url ?? '').match(pattern)
  if (!match?.[1]) throw new HttpError(400, 'BAD_REQUEST', 'invalid tutorial id')
  return match[1]
}

export async function handleListCommunityTutorials(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const { cursor, limit } = pageArgs(req)
  const q = url.searchParams.get('q')?.trim() ?? ''
  if (q.length > 100) throw new HttpError(400, 'BAD_REQUEST', 'q too long')
  try {
    const page = await listPublishedCommunityTutorials({
      cursor,
      limit,
      category: optionalCategory(url.searchParams.get('category')),
      query: q || null,
    })
    res.setHeader('Cache-Control', 'public, max-age=30')
    sendJson(res, 200, { tutorials: page.items, nextCursor: page.nextCursor })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

export async function handleGetCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const id = tutorialId(req)
  const item = await getPublishedCommunityTutorial(id)
  if (!item) throw new HttpError(404, 'NOT_FOUND', '教程不存在或尚未上线')
  res.setHeader('Cache-Control', 'public, max-age=30')
  sendJson(res, 200, { tutorial: item })
}

export async function handleSubmitCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const result = await submitCommunityTutorial(user.id, {
    title: text(body.title, 'title', 4, 100),
    summary: text(body.summary, 'summary', 10, 280),
    category: category(body.category),
    bodyMarkdown: text(body.bodyMarkdown, 'bodyMarkdown', 40, 50000),
  })
  sendJson(res, 201, { tutorial: result })
}

export async function handleListOwnCommunityTutorials(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const args = pageArgs(req)
  try {
    const page = await listOwnCommunityTutorials(user.id, args)
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 200, { tutorials: page.items, nextCursor: page.nextCursor })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

export async function handleWithdrawCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  try {
    await withdrawCommunityTutorial(tutorialId(req, '/withdraw'), user.id)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

export async function handleAdminPendingCommunityTutorials(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const args = pageArgs(req)
  try {
    const page = await listPendingCommunityTutorials(args)
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 200, { tutorials: page.items, nextCursor: page.nextCursor })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

export async function handleAdminReviewCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const id = tutorialId(req, '/review')
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject')
    throw new HttpError(400, 'BAD_REQUEST', 'decision must be approve|reject')
  const rawNote = typeof body.note === 'string' ? body.note.trim() : ''
  if (rawNote.length > 2000) throw new HttpError(400, 'BAD_REQUEST', 'note too long')
  if (decision === 'reject' && !rawNote)
    throw new HttpError(400, 'BAD_REQUEST', '拒绝时必须填写理由')
  try {
    const result = await reviewCommunityTutorial({
      id,
      reviewerUserId: admin.id,
      decision,
      note: rawNote || null,
    })
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
      'tutorial.review',
      `community_tutorial:${id}`,
      undefined,
      { decision, note: rawNote || undefined, tutorial_id: id },
    )
    sendJson(res, 200, { ok: true, tutorial: { id, ...result } })
  } catch (error) {
    throw mapTutorialError(error)
  }
}
