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
  getOwnCommunityTutorial,
  getPublishedCommunityTutorial,
  listOwnCommunityTutorials,
  listPendingCommunityTutorials,
  listPublishedCommunityTutorials,
  reviewCommunityTutorial,
  submitCommunityTutorial,
  submitSnapshotTutorial,
  takedownCommunityTutorial,
  withdrawCommunityTutorial,
} from './communityTutorials.js'
import { TUTORIAL_SNAPSHOT_MAX_BODY_BYTES } from './snapshotSanitizer.js'
import { parseTutorialSessionId, TutorialTimelineError } from './tutorialTimeline.js'

export { TUTORIAL_SNAPSHOT_MAX_BODY_BYTES }

type TutorialRouteDeps = { jwtSecret: string | Uint8Array }

function mapTutorialError(error: unknown): HttpError {
  if (error instanceof TutorialTimelineError) {
    if (error.code === 'NOT_FOUND') return new HttpError(404, error.code, error.message)
    if (error.code === 'SESSION_OPEN_TURN') return new HttpError(409, error.code, error.message)
    return new HttpError(400, error.code, error.message)
  }
  if (!(error instanceof CommunityTutorialError))
    return error instanceof HttpError
      ? error
      : new HttpError(500, 'INTERNAL', 'community tutorial error')
  if (
    error.code === 'BAD_CURSOR' ||
    error.code === 'LEAKS_FOUND' ||
    error.code === 'BAD_SESSION' ||
    error.code === 'TOO_LARGE' ||
    error.code === 'BAD_BODY'
  ) {
    return new HttpError(400, error.code, error.message)
  }
  if (error.code === 'NOT_FOUND') return new HttpError(404, error.code, error.message)
  return new HttpError(409, error.code, error.message)
}

function sendTutorialError(res: ServerResponse, error: unknown): void {
  const http = mapTutorialError(error)
  const extra =
    error instanceof CommunityTutorialError && error.leakReport
      ? { leakReport: error.leakReport }
      : {}
  sendJson(res, http.status, { error: { code: http.code, message: http.message }, ...extra })
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
  // 撤回/下架必须即时生效，详情不能被浏览器或 CDN 继续复用旧 approved DTO。
  res.setHeader('Cache-Control', 'no-store')
  sendJson(res, 200, { tutorial: item })
}

export async function handleSubmitCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req)) as Record<string, unknown>
  try {
    const result = await submitCommunityTutorial(user.id, {
      title: text(body.title, 'title', 4, 100),
      summary: text(body.summary, 'summary', 10, 280),
      category: category(body.category),
      bodyMarkdown: text(body.bodyMarkdown, 'bodyMarkdown', 40, 50000),
    })
    sendJson(res, 201, { tutorial: result })
  } catch (error) {
    if (error instanceof CommunityTutorialError && error.code === 'LEAKS_FOUND') {
      sendTutorialError(res, error)
      return
    }
    throw mapTutorialError(error)
  }
}

function optionalBodyMarkdown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'bodyMarkdown required')
  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  return text(normalized, 'bodyMarkdown', 40, 50000)
}

export async function handleSubmitTutorialSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req, TUTORIAL_SNAPSHOT_MAX_BODY_BYTES)) as Record<string, unknown>
  try {
    const result = await submitSnapshotTutorial(user.id, {
      title: text(body.title, 'title', 4, 100),
      summary: text(body.summary, 'summary', 10, 280),
      category: category(body.category),
      bodyMarkdown: optionalBodyMarkdown(body.bodyMarkdown),
      sourceSessionId: parseTutorialSessionId(body.sourceSessionId),
      messages: body.messages,
      selectedArtifacts: body.selectedArtifacts,
      asDraft: body.asDraft === true,
    })
    sendJson(res, 201, { tutorial: result })
  } catch (error) {
    if (error instanceof CommunityTutorialError && error.code === 'LEAKS_FOUND') {
      sendTutorialError(res, error)
      return
    }
    throw mapTutorialError(error)
  }
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

export async function handleGetOwnCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const match = (req.url ?? '').match(/^\/api\/tutorials\/mine\/([1-9]\d*)(?:\?|$)/)
  if (!match?.[1]) throw new HttpError(400, 'BAD_REQUEST', 'invalid tutorial id')
  const item = await getOwnCommunityTutorial(match[1], user.id)
  if (!item) throw new HttpError(404, 'NOT_FOUND', '教程投稿不存在')
  res.setHeader('Cache-Control', 'private, no-store')
  sendJson(res, 200, { tutorial: item })
}

export async function handleTutorialUserGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (path.startsWith('/api/tutorials/mine/')) {
    await handleGetOwnCommunityTutorial(req, res, deps)
    return
  }
  await handleGetCommunityTutorial(req, res)
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
    if (error instanceof CommunityTutorialError && error.code === 'LEAKS_FOUND') {
      sendTutorialError(res, error)
      return
    }
    throw mapTutorialError(error)
  }
}

export async function handleAdminTakedownCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const id = tutorialId(req, '/takedown')
  const body = (await readJsonBody(req)) as Record<string, unknown>
  const note = text(body.note, 'note', 1, 2000)
  try {
    await takedownCommunityTutorial({ id, adminUserId: admin.id, note })
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
      'tutorial.takedown',
      `community_tutorial:${id}`,
      undefined,
      { tutorial_id: id },
    )
    sendJson(res, 200, { ok: true })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

export async function handleAdminTutorialWrite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (path.endsWith('/takedown')) {
    await handleAdminTakedownCommunityTutorial(req, res, deps)
    return
  }
  if (path.endsWith('/review')) {
    await handleAdminReviewCommunityTutorial(req, res, deps)
    return
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found')
}
