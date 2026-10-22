import { query, tx, type QueryRunner } from '../db/queries.js'
import {
  leakReportPublic,
  sanitizeTutorialSnapshot,
  scanArtifactBytes,
  scanMarkdownBody,
  type PublicSnapshotManifest,
} from './snapshotSanitizer.js'
import { listTutorialBlobRefs, persistSnapshotBlobs } from './tutorialBlobs.js'
import {
  bindTutorialImages,
  communityBlogEnabled,
  maskTutorialImageRefs,
  parseTutorialImageRefs,
  tutorialReadMinutes,
} from './tutorialImages.js'
import {
  TUTORIAL_ACTIVE_AUTHOR_CAP,
  TutorialTimelineError,
  exportOwnedSessionTimeline,
  parseTutorialSessionId,
  projectDurableMessagesForSnapshot,
} from './tutorialTimeline.js'

export const COMMUNITY_TUTORIAL_CATEGORIES = ['research', 'coding', 'general'] as const
export type CommunityTutorialCategory = (typeof COMMUNITY_TUTORIAL_CATEGORIES)[number]
export type CommunityTutorialKind = 'markdown' | 'snapshot'
export type CommunityTutorialStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'takedown'

export const COMMUNITY_TUTORIAL_PAGE_SIZE = 20
export const COMMUNITY_TUTORIAL_MAX_PAGE_SIZE = 50
/** 经验分享（markdown）频控：每人 24 小时最多投 5 篇，同时最多 3 篇在审。 */
export const COMMUNITY_TUTORIAL_DAILY_SUBMISSIONS = 5
export const COMMUNITY_TUTORIAL_MAX_PENDING = 3
export type CommunityTutorialReviewSource = 'human' | 'ai'

export class CommunityTutorialError extends Error {
  constructor(
    readonly code:
      | 'BAD_CURSOR'
      | 'NOT_FOUND'
      | 'NOT_PENDING'
      | 'NOT_WITHDRAWABLE'
      | 'LEAKS_FOUND'
      | 'BAD_SESSION'
      | 'SESSION_OPEN_TURN'
      | 'QUOTA'
      | 'TOO_LARGE'
      | 'BAD_BODY'
      | 'RATE_LIMITED'
      | 'FEATURE_DISABLED',
    message: string,
    readonly leakReport?: { leaks: Array<{ rule: string; field: string }> },
  ) {
    super(message)
    this.name = 'CommunityTutorialError'
  }
}

export interface CommunityTutorialDraft {
  title: string
  summary: string
  category: CommunityTutorialCategory
  bodyMarkdown: string
}

export interface TutorialCursor {
  at: string
  id: string
}

export interface PublishedTutorialRow {
  id: string
  title: string
  summary: string
  category: CommunityTutorialCategory
  kind: CommunityTutorialKind
  authorName: string
  publishedAt: string
  /** 正文第一张图（封面）；没有图为 null。 */
  coverSha: string | null
  readMinutes: number
}

export type TutorialBlobRef = {
  sha256: string
  role: string
  kind: string
  mime: string
  bytes: number
}

export interface TutorialDetailRow extends PublishedTutorialRow {
  bodyMarkdown: string
  snapshot: PublicSnapshotManifest | null
  refs: TutorialBlobRef[]
}

export interface OwnTutorialRow {
  id: string
  title: string
  summary: string
  category: CommunityTutorialCategory
  kind: CommunityTutorialKind
  bodyMarkdown: string
  snapshot: PublicSnapshotManifest | null
  sanitizerVersion: string | null
  refs: TutorialBlobRef[]
  status: CommunityTutorialStatus
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  publishedAt: string | null
  /** pending 且在等人工（AI 拿不准、出错或审核关闭）。 */
  needsHuman: boolean
  reviewSource: CommunityTutorialReviewSource | null
  viewCount: number
  coverSha: string | null
  readMinutes: number
}

export interface OwnTutorialDetailRow extends OwnTutorialRow {
  sourceSessionId: string | null
}

export interface PendingTutorialRow extends OwnTutorialRow {
  authorName: string
}

export interface AdminTutorialRow extends OwnTutorialRow {
  authorName: string
  imageCount: number
  bodyChars: number
}

/** 封面 = 正文里第一个图片地址；只用于卡片展示，代码块里的极少数例外不值得在 SQL 里解析。 */
const COVER_SHA_SQL = (column: string) => `substring(${column} from 'tutorial-blob:([a-f0-9]{64})')`

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function parseSnapshot(value: unknown): PublicSnapshotManifest | null {
  if (!value || typeof value !== 'object') return null
  return value as PublicSnapshotManifest
}

export function encodeTutorialCursor(cursor: TutorialCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeTutorialCursor(value: string | null | undefined): TutorialCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { at?: unknown }).at !== 'string' ||
      !Number.isFinite(Date.parse((parsed as { at: string }).at)) ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      !/^[1-9]\d*$/.test((parsed as { id: string }).id)
    ) {
      throw new Error('invalid cursor payload')
    }
    return { at: (parsed as { at: string }).at, id: (parsed as { id: string }).id }
  } catch {
    throw new CommunityTutorialError('BAD_CURSOR', '分页游标无效')
  }
}

function splitPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  at: (row: T) => string,
): { rows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const visibleRows = hasMore ? rows.slice(0, limit) : rows
  const last = visibleRows.at(-1)
  return {
    rows: visibleRows,
    nextCursor: hasMore && last ? encodeTutorialCursor({ at: at(last), id: last.id }) : null,
  }
}

function assertNoMarkdownLeaks(bodyMarkdown: string): void {
  const leaks = scanMarkdownBody(maskTutorialImageRefs(bodyMarkdown))
  if (leaks.length > 0) {
    throw new CommunityTutorialError('LEAKS_FOUND', '教程正文未通过安全扫描', leakReportPublic(leaks))
  }
}

export type SubmitCommunityTutorialOptions = {
  /** 默认读 OC_COMMUNITY_BLOG_ENABLED；关闭时带图片的投稿被拒（旧的纯文字投稿照常）。 */
  blogEnabled?: boolean
  limits?: { daily: number; maxPending: number }
}

export async function submitCommunityTutorial(
  authorUserId: string,
  draft: CommunityTutorialDraft,
  options: SubmitCommunityTutorialOptions = {},
): Promise<{ id: string; status: 'pending'; createdAt: string; imageCount: number }> {
  const imageShas = parseTutorialImageRefs(draft.bodyMarkdown)
  if (imageShas.length > 0 && !(options.blogEnabled ?? communityBlogEnabled()))
    throw new CommunityTutorialError('FEATURE_DISABLED', '经验分享图片功能未开启')
  assertNoMarkdownLeaks(draft.bodyMarkdown)
  const limits = options.limits ?? {
    daily: COMMUNITY_TUTORIAL_DAILY_SUBMISSIONS,
    maxPending: COMMUNITY_TUTORIAL_MAX_PENDING,
  }
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `tutorial-quota:${authorUserId}`,
    ])
    const counts = await client.query<{ pending: string; recent: string }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::text AS recent
         FROM community_tutorials
        WHERE author_user_id = $1::bigint AND kind = 'markdown'`,
      [authorUserId],
    )
    if (Number(counts.rows[0]?.pending ?? 0) >= limits.maxPending)
      throw new CommunityTutorialError(
        'RATE_LIMITED',
        `最多同时有 ${limits.maxPending} 篇在审核，请等审核结果出来再投`,
      )
    if (Number(counts.rows[0]?.recent ?? 0) >= limits.daily)
      throw new CommunityTutorialError('RATE_LIMITED', `24 小时内最多投稿 ${limits.daily} 篇`)
    // AI 审核（PR-B）接手前，新投稿都在等人工。
    const result = await client.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO community_tutorials
         (author_user_id, title, summary, category, body_markdown, kind, needs_human)
       VALUES ($1::bigint, $2, $3, $4, $5, 'markdown', true)
       RETURNING id::text AS id, created_at`,
      [authorUserId, draft.title, draft.summary, draft.category, draft.bodyMarkdown],
    )
    const row = result.rows[0]!
    await bindTutorialImages(
      { publicationId: row.id, authorUserId, shas: imageShas },
      client,
    )
    return {
      id: row.id,
      status: 'pending' as const,
      createdAt: iso(row.created_at)!,
      imageCount: imageShas.length,
    }
  })
}

function mapTimelineError(error: unknown): never {
  if (error instanceof TutorialTimelineError) {
    throw new CommunityTutorialError(error.code, error.message)
  }
  throw error
}

export async function submitSnapshotTutorial(
  authorUserId: string,
  args: {
    title: string
    summary: string
    category: CommunityTutorialCategory
    bodyMarkdown?: string
    sourceSessionId: string
    messages?: unknown
    selectedArtifacts?: unknown
    asDraft?: boolean
  },
): Promise<{
  id: string
  status: 'draft' | 'pending'
  createdAt: string
  sanitizerVersion: string
  kind: 'snapshot'
}> {
  let sourceSessionId: string
  try {
    sourceSessionId = parseTutorialSessionId(args.sourceSessionId)
  } catch (error) {
    mapTimelineError(error)
  }
  let durable
  try {
    durable = await exportOwnedSessionTimeline({
      sessionId: sourceSessionId,
      authorUserId,
    })
  } catch (error) {
    mapTimelineError(error)
  }
  const projected = projectDurableMessagesForSnapshot(durable, args.messages)
  const sanitized = sanitizeTutorialSnapshot({
    messages: projected,
    selectedArtifacts: args.selectedArtifacts,
  })
  if (sanitized.ok === false) {
    throw new CommunityTutorialError('LEAKS_FOUND', '会话快照未通过安全扫描', sanitized.leakReport)
  }
  const trimmedGuide = args.bodyMarkdown?.trim() ?? ''
  if (trimmedGuide.length > 0 && (trimmedGuide.length < 40 || trimmedGuide.length > 50000)) {
    throw new CommunityTutorialError('BAD_BODY', 'bodyMarkdown length must be 0 or 40..50000')
  }
  const guide =
    trimmedGuide ||
    '会话快照教程。完整交互轨迹见 snapshot 字段与 blob 引用；本段只作公开导语，不含源会话身份。'
  assertNoMarkdownLeaks(guide)
  const status = args.asDraft ? 'draft' : 'pending'
  try {
    return await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `tutorial-quota:${authorUserId}`,
      ])
      const active = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM community_tutorials
          WHERE author_user_id = $1::bigint AND status IN ('draft', 'pending')`,
        [authorUserId],
      )
      if (Number(active.rows[0]?.n ?? 0) >= TUTORIAL_ACTIVE_AUTHOR_CAP) {
        throw new CommunityTutorialError('QUOTA', '同时存在的草稿/待审教程已达上限')
      }
      const inserted = await client.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO community_tutorials
           (author_user_id, title, summary, category, body_markdown, kind, snapshot_json,
            source_session_id, sanitizer_version, status, needs_human)
         VALUES ($1::bigint, $2, $3, $4, $5, 'snapshot', $6::jsonb, $7, $8, $9, $9 = 'pending')
         RETURNING id::text AS id, created_at`,
        [
          authorUserId,
          args.title,
          args.summary,
          args.category,
          guide,
          JSON.stringify(sanitized.manifest),
          sourceSessionId,
          sanitized.sanitizerVersion,
          status,
        ],
      )
      const row = inserted.rows[0]!
      await persistSnapshotBlobs({
        publicationId: row.id,
        blobs: sanitized.blobs,
        manifest: sanitized.manifest,
        runner: client,
      })
      return {
        id: row.id,
        status,
        createdAt: iso(row.created_at)!,
        sanitizerVersion: sanitized.sanitizerVersion,
        kind: 'snapshot' as const,
      }
    })
  } catch (error) {
    if (error instanceof CommunityTutorialError) throw error
    mapTimelineError(error)
  }
}

export async function listPublishedCommunityTutorials(
  args: {
    cursor: TutorialCursor | null
    limit: number
    category?: CommunityTutorialCategory | null
    query?: string | null
  },
  runner?: QueryRunner,
): Promise<{ items: PublishedTutorialRow[]; nextCursor: string | null; total: number | null }> {
  const filterParams = [args.category ?? null, args.query ?? null]
  const FILTER_SQL = `t.status = 'approved'
        AND ($1::text IS NULL OR t.category = $1)
        AND ($2::text IS NULL OR t.title ILIKE '%' || $2 || '%' OR t.summary ILIKE '%' || $2 || '%'
             OR u.display_name ILIKE '%' || $2 || '%')`
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    kind: CommunityTutorialKind
    author_name: string
    published_at: Date | string
    cursor_at: string
    cover_sha: string | null
    body_chars: number
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.kind,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            t.published_at, t.published_at::text AS cursor_at,
            ${COVER_SHA_SQL('t.body_markdown')} AS cover_sha,
            char_length(t.body_markdown) AS body_chars
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE ${FILTER_SQL}
        AND ($3::timestamptz IS NULL OR (t.published_at, t.id) < ($3::timestamptz, $4::bigint))
      ORDER BY t.published_at DESC, t.id DESC
      LIMIT $5`,
    [...filterParams, args.cursor?.at ?? null, args.cursor?.id ?? null, args.limit + 1],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  const items = page.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    authorName: row.author_name,
    publishedAt: iso(row.published_at)!,
    coverSha: row.cover_sha,
    readMinutes: tutorialReadMinutes(row.body_chars),
  }))
  // 只在第一页给总数（列表头「已发布 N 篇」）；翻页时省掉一次 count。
  let total: number | null = null
  if (!args.cursor) {
    const counted = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM community_tutorials t
         JOIN users u ON u.id = t.author_user_id
        WHERE ${FILTER_SQL}`,
      filterParams,
      runner,
    )
    total = Number(counted.rows[0]?.n ?? 0)
  }
  return { items, nextCursor: page.nextCursor, total }
}

export async function getPublishedCommunityTutorial(
  id: string,
  runner?: QueryRunner,
): Promise<TutorialDetailRow | null> {
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    kind: CommunityTutorialKind
    body_markdown: string
    snapshot_json: unknown
    author_name: string
    published_at: Date | string
    cover_sha: string | null
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.kind, t.body_markdown, t.snapshot_json,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            t.published_at, ${COVER_SHA_SQL('t.body_markdown')} AS cover_sha
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.id = $1::bigint AND t.status = 'approved'`,
    [id],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  const refs = await listTutorialBlobRefs(row.id, runner)
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    authorName: row.author_name,
    publishedAt: iso(row.published_at)!,
    coverSha: row.cover_sha,
    readMinutes: tutorialReadMinutes([...row.body_markdown].length),
    bodyMarkdown: row.body_markdown,
    snapshot: parseSnapshot(row.snapshot_json),
    refs,
  }
}

/** 公开详情被读取一次。尽力而为：调用方吞掉错误，不影响响应；不改 updated_at。 */
export async function recordCommunityTutorialView(id: string, runner?: QueryRunner): Promise<void> {
  await query(
    `UPDATE community_tutorials SET view_count = view_count + 1
      WHERE id = $1::bigint AND status = 'approved'`,
    [id],
    runner,
  )
}

type OwnRowDb = {
  id: string
  title: string
  summary: string
  category: CommunityTutorialCategory
  kind: CommunityTutorialKind
  body_markdown: string
  snapshot_json: unknown
  source_session_id: string | null
  sanitizer_version: string | null
  status: CommunityTutorialStatus
  review_note: string | null
  created_at: Date | string
  reviewed_at: Date | string | null
  published_at: Date | string | null
  needs_human: boolean
  review_source: CommunityTutorialReviewSource | null
  view_count: string | number
  cover_sha: string | null
}

/** OwnRowDb 的列；表别名固定为 t。 */
const OWN_COLUMNS = `t.id::text AS id, t.title, t.summary, t.category, t.kind, t.body_markdown,
            t.snapshot_json, t.source_session_id, t.sanitizer_version, t.status, t.review_note,
            t.created_at, t.reviewed_at, t.published_at,
            (t.status = 'pending' AND t.needs_human) AS needs_human, t.review_source,
            t.view_count, ${COVER_SHA_SQL('t.body_markdown')} AS cover_sha`

function mapOwnRow(row: OwnRowDb): OwnTutorialRow {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    bodyMarkdown: row.body_markdown,
    snapshot: parseSnapshot(row.snapshot_json),
    sanitizerVersion: row.sanitizer_version,
    refs: [],
    status: row.status,
    reviewNote: row.review_note,
    createdAt: iso(row.created_at)!,
    reviewedAt: iso(row.reviewed_at),
    publishedAt: iso(row.published_at),
    needsHuman: row.needs_human,
    reviewSource: row.review_source,
    viewCount: Number(row.view_count),
    coverSha: row.cover_sha,
    readMinutes: tutorialReadMinutes([...row.body_markdown].length),
  }
}

export async function getOwnCommunityTutorial(
  id: string,
  authorUserId: string,
  runner?: QueryRunner,
): Promise<OwnTutorialDetailRow | null> {
  const result = await query<OwnRowDb>(
    `SELECT ${OWN_COLUMNS}
       FROM community_tutorials t
      WHERE t.id = $1::bigint AND t.author_user_id = $2::bigint`,
    [id, authorUserId],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    ...mapOwnRow(row),
    refs: await listTutorialBlobRefs(row.id, runner),
    sourceSessionId: row.source_session_id,
  }
}

export async function listOwnCommunityTutorials(
  authorUserId: string,
  args: { cursor: TutorialCursor | null; limit: number },
  runner?: QueryRunner,
): Promise<{ items: OwnTutorialRow[]; nextCursor: string | null }> {
  const result = await query<OwnRowDb & { cursor_at: string }>(
    `SELECT ${OWN_COLUMNS}, t.created_at::text AS cursor_at
       FROM community_tutorials t
      WHERE t.author_user_id = $1::bigint
        AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::bigint))
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $4`,
    [authorUserId, args.cursor?.at ?? null, args.cursor?.id ?? null, args.limit + 1],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  return { items: page.rows.map(mapOwnRow), nextCursor: page.nextCursor }
}

export async function listPendingCommunityTutorials(
  args: { cursor: TutorialCursor | null; limit: number },
  runner?: QueryRunner,
): Promise<{ items: PendingTutorialRow[]; nextCursor: string | null }> {
  const result = await query<OwnRowDb & { cursor_at: string; author_name: string }>(
    `SELECT ${OWN_COLUMNS}, t.created_at::text AS cursor_at,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.status = 'pending'
        AND ($1::timestamptz IS NULL OR (t.created_at, t.id) > ($1::timestamptz, $2::bigint))
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT $3`,
    [args.cursor?.at ?? null, args.cursor?.id ?? null, args.limit + 1],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  return {
    items: page.rows.map((row) => ({ ...mapOwnRow(row), authorName: row.author_name })),
    nextCursor: page.nextCursor,
  }
}

export const ADMIN_TUTORIAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'takedown',
  'withdrawn',
] as const
export type AdminTutorialStatus = (typeof ADMIN_TUTORIAL_STATUSES)[number]

/**
 * 管理端按状态列表。pending 按投稿时间正序（先来先审）；其它状态按处理时间倒序。
 * needsHuman 只对 pending 有意义：只看在等人工的那部分。
 */
export async function listAdminCommunityTutorials(
  args: {
    status: AdminTutorialStatus
    needsHuman: boolean
    cursor: TutorialCursor | null
    limit: number
  },
  runner?: QueryRunner,
): Promise<{ items: AdminTutorialRow[]; nextCursor: string | null }> {
  const pending = args.status === 'pending'
  // 非 pending 的排序键：处理时间，缺失（作者撤回、0320 前的行）时退到 updated_at。
  const orderKey = pending ? 't.created_at' : 'COALESCE(t.reviewed_at, t.updated_at)'
  const result = await query<
    OwnRowDb & { cursor_at: string; author_name: string; image_count: string; body_chars: number }
  >(
    `SELECT ${OWN_COLUMNS}, ${orderKey}::text AS cursor_at,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            (SELECT count(*) FROM tutorial_blob_refs r
              WHERE r.publication_id = t.id AND r.role LIKE 'image:%')::text AS image_count,
            char_length(t.body_markdown) AS body_chars
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.status = $1
        AND (NOT $2::boolean OR t.needs_human)
        AND ($3::timestamptz IS NULL OR (${orderKey}, t.id) ${pending ? '>' : '<'} ($3::timestamptz, $4::bigint))
      ORDER BY ${orderKey} ${pending ? 'ASC' : 'DESC'}, t.id ${pending ? 'ASC' : 'DESC'}
      LIMIT $5`,
    [
      args.status,
      pending && args.needsHuman,
      args.cursor?.at ?? null,
      args.cursor?.id ?? null,
      args.limit + 1,
    ],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  return {
    items: page.rows.map((row) => ({
      ...mapOwnRow(row),
      authorName: row.author_name,
      imageCount: Number(row.image_count),
      bodyChars: row.body_chars,
    })),
    nextCursor: page.nextCursor,
  }
}

export async function withdrawCommunityTutorial(
  id: string,
  authorUserId: string,
  runner?: QueryRunner,
): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE community_tutorials
        SET status = 'withdrawn', published_at = NULL, needs_human = false, updated_at = NOW()
      WHERE id = $1::bigint AND author_user_id = $2::bigint AND status IN ('pending', 'approved', 'draft')
      RETURNING id::text AS id`,
    [id, authorUserId],
    runner,
  )
  if (result.rowCount === 1) return
  const existing = await query<{ author_user_id: string; status: CommunityTutorialStatus }>(
    'SELECT author_user_id::text, status FROM community_tutorials WHERE id = $1::bigint',
    [id],
    runner,
  )
  const row = existing.rows[0]
  if (!row || row.author_user_id !== authorUserId)
    throw new CommunityTutorialError('NOT_FOUND', '教程投稿不存在')
  throw new CommunityTutorialError('NOT_WITHDRAWABLE', '只有草稿、待审核或已上线教程可以由作者撤回')
}

export async function takedownCommunityTutorial(args: {
  id: string
  adminUserId: string
  note: string
}): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE community_tutorials
        SET status = 'takedown',
            published_at = NULL,
            review_note = $3,
            reviewed_by = $2::bigint,
            reviewed_at = NOW(),
            review_source = 'human',
            needs_human = false,
            updated_at = NOW()
      WHERE id = $1::bigint AND status = 'approved'
      RETURNING id::text AS id`,
    [args.id, args.adminUserId, args.note],
  )
  if (result.rowCount === 1) return
  const existing = await query<{ id: string }>(
    'SELECT id::text AS id FROM community_tutorials WHERE id = $1::bigint',
    [args.id],
  )
  if (!existing.rows[0]) throw new CommunityTutorialError('NOT_FOUND', '教程投稿不存在')
  throw new CommunityTutorialError('NOT_PENDING', '只能下架已公开的教程')
}

async function rescanBeforeReview(id: string, runner: QueryRunner): Promise<void> {
  const result = await query<{
    kind: CommunityTutorialKind
    body_markdown: string
    snapshot_json: unknown
  }>(
    'SELECT kind, body_markdown, snapshot_json FROM community_tutorials WHERE id = $1::bigint',
    [id],
    runner,
  )
  const row = result.rows[0]
  if (!row) throw new CommunityTutorialError('NOT_FOUND', '教程投稿不存在')
  assertNoMarkdownLeaks(row.body_markdown)
  // 快照的 manifest 与所有 blob、经验分享的图片，公开前都按当前规则复扫一遍。
  const leaks =
    row.kind === 'snapshot' ? scanMarkdownBody(JSON.stringify(row.snapshot_json ?? {}), 'snapshot') : []
  const blobs = await query<{ role: string; mime: string; body: Buffer }>(
    `SELECT r.role, b.mime, b.body
       FROM tutorial_blob_refs r
       JOIN tutorial_blobs b ON b.sha256 = r.sha256
      WHERE r.publication_id = $1::bigint`,
    [id],
    runner,
  )
  for (const blob of blobs.rows) {
    const body = Buffer.isBuffer(blob.body) ? blob.body : Buffer.from(blob.body)
    leaks.push(...scanArtifactBytes(blob.mime, body, `blob:${blob.role}`))
  }
  if (leaks.length > 0) {
    throw new CommunityTutorialError('LEAKS_FOUND', '投稿未通过复核扫描', leakReportPublic(leaks))
  }
}

export async function reviewCommunityTutorial(args: {
  id: string
  reviewerUserId: string
  decision: 'approve' | 'reject'
  note: string | null
}): Promise<{ status: 'approved' | 'rejected'; publishedAt: string | null }> {
  return tx(async (client) => {
    if (args.decision === 'approve') await rescanBeforeReview(args.id, client)
    const status = args.decision === 'approve' ? 'approved' : 'rejected'
    const result = await client.query<{
      status: 'approved' | 'rejected'
      published_at: Date | string | null
    }>(
      `UPDATE community_tutorials
          SET status = $2,
              review_note = $3,
              reviewed_by = $4::bigint,
              reviewed_at = NOW(),
              review_source = 'human',
              needs_human = false,
              published_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1::bigint AND status = 'pending'
        RETURNING status, published_at`,
      [args.id, status, args.note, args.reviewerUserId],
    )
    const row = result.rows[0]
    if (!row) {
      const existing = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM community_tutorials WHERE id = $1::bigint',
        [args.id],
      )
      if (!existing.rows[0]) throw new CommunityTutorialError('NOT_FOUND', '教程投稿不存在')
      throw new CommunityTutorialError('NOT_PENDING', '该教程已经处理或撤回')
    }
    return { status: row.status, publishedAt: iso(row.published_at) }
  })
}
