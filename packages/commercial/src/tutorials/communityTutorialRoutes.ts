import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeAdminAuditBestEffort } from '../admin/audit.js'
import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { requireAuth } from '../http/auth.js'
import {
  HttpError,
  clientIpOf,
  readBinaryBody,
  readJsonBody,
  sendJson,
  userAgentOf,
} from '../http/util.js'
import {
  ADMIN_TUTORIAL_STATUSES,
  type AdminTutorialStatus,
  COMMUNITY_TUTORIAL_CATEGORIES,
  COMMUNITY_TUTORIAL_MAX_PAGE_SIZE,
  COMMUNITY_TUTORIAL_PAGE_SIZE,
  CommunityTutorialError,
  type CommunityTutorialCategory,
  decodeTutorialCursor,
  getOwnCommunityTutorial,
  getPublishedCommunityTutorial,
  getTutorialModerationStats,
  listAdminCommunityTutorials,
  listOwnCommunityTutorials,
  listPendingCommunityTutorials,
  listPublishedCommunityTutorials,
  listTutorialModerations,
  recordCommunityTutorialView,
  reviewCommunityTutorial,
  submitCommunityTutorial,
  submitSnapshotTutorial,
  takedownCommunityTutorial,
  withdrawCommunityTutorial,
} from './communityTutorials.js'
import { precheckCommunityTutorial, takeBlogPrecheckToken } from './blogPrecheck.js'
import { TUTORIAL_SNAPSHOT_MAX_BODY_BYTES } from './snapshotSanitizer.js'
import {
  TUTORIAL_IMAGE_MAX_BYTES,
  TutorialImageError,
  communityBlogEnabled,
  getTutorialImageForViewer,
  prepareTutorialImage,
  storeTutorialImageUpload,
} from './tutorialImages.js'
import { tutorialModerationMode } from './tutorialModerationQueue.js'
import { reviewCommunityTutorialRevision, reviseCommunityTutorial } from './tutorialRevisions.js'
import { parseTutorialSessionId, TutorialTimelineError } from './tutorialTimeline.js'

export { TUTORIAL_SNAPSHOT_MAX_BODY_BYTES }

/**
 * Markdown 投稿的 JSON 上限。正文最多 50000 字，中文按 UTF-8 3 字节约 150KB，再加 JSON
 * 转义余量；默认的 64KiB 会把长篇中文投稿 413 掉。
 */
export const COMMUNITY_TUTORIAL_MAX_BODY_BYTES = 256 * 1024

type TutorialRouteDeps = { jwtSecret: string | Uint8Array }

function mapTutorialError(error: unknown): HttpError {
  if (error instanceof TutorialImageError) {
    if (error.code === 'RATE_LIMITED') return new HttpError(429, error.code, error.message)
    if (error.code === 'TOO_LARGE') return new HttpError(413, error.code, error.message)
    return new HttpError(400, error.code, error.message)
  }
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
  if (error.code === 'NOT_FOUND' || error.code === 'FEATURE_DISABLED')
    return new HttpError(404, error.code, error.message)
  if (error.code === 'RATE_LIMITED') return new HttpError(429, error.code, error.message)
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
  const kind = url.searchParams.get('kind') || null
  if (kind !== null && kind !== 'markdown' && kind !== 'snapshot')
    throw new HttpError(400, 'BAD_REQUEST', 'kind must be markdown|snapshot')
  try {
    const page = await listPublishedCommunityTutorials({
      cursor,
      limit,
      category: optionalCategory(url.searchParams.get('category')),
      query: q || null,
      kind,
    })
    res.setHeader('Cache-Control', 'public, max-age=30')
    res.setHeader('X-Robots-Tag', 'noindex')
    sendJson(res, 200, { tutorials: page.items, nextCursor: page.nextCursor, total: page.total })
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
  try {
    await recordCommunityTutorialView(id)
  } catch {
    // 阅读数只是展示用，写失败不影响读者。
  }
  // 撤回/下架必须即时生效，详情不能被浏览器或 CDN 继续复用旧 approved DTO。
  res.setHeader('Cache-Control', 'no-store')
  // quick tunnel 域名随机，经验分享不进搜索引擎。
  res.setHeader('X-Robots-Tag', 'noindex')
  sendJson(res, 200, { tutorial: item })
}

/** 投稿与修改共用的字段校验。 */
function markdownDraft(body: Record<string, unknown>) {
  return {
    title: text(body.title, 'title', 4, 100),
    summary: text(body.summary, 'summary', 10, 280),
    category: category(body.category),
    bodyMarkdown: text(body.bodyMarkdown, 'bodyMarkdown', 40, 50000),
  }
}

export async function handleSubmitCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const body = (await readJsonBody(req, COMMUNITY_TUTORIAL_MAX_BODY_BYTES)) as Record<string, unknown>
  try {
    const result = await submitCommunityTutorial(user.id, markdownDraft(body))
    sendJson(res, 201, { tutorial: result })
  } catch (error) {
    if (error instanceof CommunityTutorialError && error.code === 'LEAKS_FOUND') {
      sendTutorialError(res, error)
      return
    }
    throw mapTutorialError(error)
  }
}

/**
 * 投稿预检（对话写博客的草稿卡）：和投稿同样的确定性检查，只读、不入队、不调用模型。
 * 字段不合法不报 400，而是作为问题列出来，草稿卡据此提示要改什么。
 */
export async function handlePrecheckCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  if (!communityBlogEnabled()) throw new HttpError(404, 'FEATURE_DISABLED', '经验分享未开启')
  if (!takeBlogPrecheckToken(user.id))
    throw new HttpError(429, 'RATE_LIMITED', '检查太频繁，稍等一分钟再试')
  const body = await readJsonBody(req, COMMUNITY_TUTORIAL_MAX_BODY_BYTES)
  const draft = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  sendJson(res, 200, await precheckCommunityTutorial(user.id, draft))
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

/** 经验分享图片上传：原始字节，Content-Type 声明格式，服务端按魔数复核并去元数据。 */
export async function handleUploadTutorialImage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  if (!communityBlogEnabled()) throw new HttpError(404, 'FEATURE_DISABLED', '经验分享未开启')
  const body = await readBinaryBody(req, TUTORIAL_IMAGE_MAX_BYTES)
  try {
    const image = await prepareTutorialImage(body, req.headers['content-type'])
    await storeTutorialImageUpload(user.id, image)
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 201, {
      image: {
        sha256: image.sha256,
        mime: image.mime,
        bytes: image.body.length,
        width: image.width,
        height: image.height,
      },
    })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

/**
 * 作者预览 / 管理员复核读图（未公开的稿件也能看）。不区分不存在与无权，一律 404。
 * 前端带 Bearer fetch 后转 blob URL；公开读取仍走 /api/tutorial-embeds。
 */
export async function handleGetTutorialImage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const match = (req.url ?? '').match(/^\/api\/tutorials\/images\/([a-f0-9]{64})(?:\?|$)/)
  if (!match?.[1]) throw new HttpError(400, 'BAD_REQUEST', 'invalid image id')
  let isAdmin = false
  if (user.role === 'admin') {
    await requireAdminVerifyDb(req, deps.jwtSecret)
    isAdmin = true
  }
  const image = await getTutorialImageForViewer({ sha256: match[1], userId: user.id, isAdmin })
  if (!image) throw new HttpError(404, 'NOT_FOUND', 'image not found')
  res.statusCode = 200
  res.setHeader('Content-Type', image.mime)
  res.setHeader('Content-Length', String(image.body.length))
  res.setHeader('Content-Disposition', `inline; filename="${match[1].slice(0, 12)}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Robots-Tag', 'noindex')
  res.end(image.body)
}

export async function handleTutorialUserGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (path.startsWith('/api/tutorials/images/')) {
    await handleGetTutorialImage(req, res, deps)
    return
  }
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

/**
 * 作者修改已投稿的经验分享：待审 / 未通过的原地改后重审；已发布的进修改稿，审核通过前线上仍是旧版。
 */
export async function handleReviseCommunityTutorial(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const id = tutorialId(req, '/revise')
  const body = (await readJsonBody(req, COMMUNITY_TUTORIAL_MAX_BODY_BYTES)) as Record<string, unknown>
  try {
    const result = await reviseCommunityTutorial(user.id, id, markdownDraft(body))
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 200, { tutorial: result })
  } catch (error) {
    if (error instanceof CommunityTutorialError && error.code === 'LEAKS_FOUND') {
      sendTutorialError(res, error)
      return
    }
    throw mapTutorialError(error)
  }
}

/** POST /api/tutorials/:id/withdraw | /revise（exact 路由之外的用户写操作）。 */
export async function handleTutorialUserPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (path.endsWith('/revise')) {
    await handleReviseCommunityTutorial(req, res, deps)
    return
  }
  await handleWithdrawCommunityTutorial(req, res, deps)
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

/** 管理端按状态列表：`?status=pending|approved|rejected|takedown|withdrawn[&needsHuman=1]`。 */
export async function handleAdminListCommunityTutorials(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const status = url.searchParams.get('status') ?? 'pending'
  if (!(ADMIN_TUTORIAL_STATUSES as readonly string[]).includes(status))
    throw new HttpError(400, 'BAD_REQUEST', `status must be ${ADMIN_TUTORIAL_STATUSES.join('|')}`)
  const needsHuman = url.searchParams.get('needsHuman') === '1'
  const kind = url.searchParams.get('kind') || null
  if (kind !== null && kind !== 'markdown' && kind !== 'snapshot')
    throw new HttpError(400, 'BAD_REQUEST', 'kind must be markdown|snapshot')
  const args = pageArgs(req)
  try {
    const page = await listAdminCommunityTutorials({
      status: status as AdminTutorialStatus,
      needsHuman,
      kind,
      ...args,
    })
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 200, { tutorials: page.items, nextCursor: page.nextCursor })
  } catch (error) {
    throw mapTutorialError(error)
  }
}

/** 管理端页头：审核模式与今天的自动处理计数。 */
export async function handleAdminTutorialModerationStats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const stats = await getTutorialModerationStats()
  res.setHeader('Cache-Control', 'private, no-store')
  sendJson(res, 200, {
    mode: tutorialModerationMode(),
    vision: process.env.OC_TUTORIAL_MODERATION_VISION?.trim().toLowerCase() !== 'off',
    ...stats,
  })
}

/** 「AI 审核记录」列表。 */
export async function handleAdminListTutorialModerations(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const args = pageArgs(req)
  try {
    const page = await listTutorialModerations(args)
    res.setHeader('Cache-Control', 'private, no-store')
    sendJson(res, 200, { moderations: page.items, nextCursor: page.nextCursor })
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
  // 列表给的 reviewToken：p:<正文版本>（稿件本身）或 r:<修改稿 id>（已发布帖的修改）。
  const token = typeof body.reviewToken === 'string' ? body.reviewToken : null
  const tokenMatch = token === null ? null : /^(p|r):([1-9]\d{0,18})$/.exec(token)
  if (token !== null && !tokenMatch) throw new HttpError(400, 'BAD_REQUEST', 'invalid reviewToken')
  const revisionId = tokenMatch?.[1] === 'r' ? tokenMatch[2]! : null
  try {
    const result = revisionId
      ? await reviewCommunityTutorialRevision({
          publicationId: id,
          revisionId,
          reviewerUserId: admin.id,
          decision,
          note: rawNote || null,
        })
      : await reviewCommunityTutorial({
          id,
          reviewerUserId: admin.id,
          decision,
          note: rawNote || null,
          expectedVersion: tokenMatch?.[1] === 'p' ? Number(tokenMatch[2]) : null,
        })
    await writeAdminAuditBestEffort(
      { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
      'tutorial.review',
      `community_tutorial:${id}`,
      undefined,
      { decision, note: rawNote || undefined, tutorial_id: id, ...(revisionId ? { revision_id: revisionId } : {}) },
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
