import { query, tx, type QueryRunner } from '../db/queries.js'

export const COMMUNITY_TUTORIAL_CATEGORIES = ['research', 'coding', 'general'] as const
export type CommunityTutorialCategory = (typeof COMMUNITY_TUTORIAL_CATEGORIES)[number]
export type CommunityTutorialStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

export const COMMUNITY_TUTORIAL_PAGE_SIZE = 20
export const COMMUNITY_TUTORIAL_MAX_PAGE_SIZE = 50

export class CommunityTutorialError extends Error {
  constructor(
    readonly code: 'BAD_CURSOR' | 'NOT_FOUND' | 'NOT_PENDING',
    message: string,
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
  authorName: string
  publishedAt: string
}

export interface TutorialDetailRow extends PublishedTutorialRow {
  bodyMarkdown: string
}

export interface OwnTutorialRow {
  id: string
  title: string
  summary: string
  category: CommunityTutorialCategory
  bodyMarkdown: string
  status: CommunityTutorialStatus
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  publishedAt: string | null
}

export interface PendingTutorialRow extends OwnTutorialRow {
  authorName: string
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
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

export async function submitCommunityTutorial(
  authorUserId: string,
  draft: CommunityTutorialDraft,
  runner?: QueryRunner,
): Promise<{ id: string; status: 'pending'; createdAt: string }> {
  const result = await query<{ id: string; created_at: Date | string }>(
    `INSERT INTO community_tutorials
       (author_user_id, title, summary, category, body_markdown)
     VALUES ($1::bigint, $2, $3, $4, $5)
     RETURNING id::text AS id, created_at`,
    [authorUserId, draft.title, draft.summary, draft.category, draft.bodyMarkdown],
    runner,
  )
  const row = result.rows[0]!
  return { id: row.id, status: 'pending', createdAt: iso(row.created_at)! }
}

export async function listPublishedCommunityTutorials(
  args: {
    cursor: TutorialCursor | null
    limit: number
    category?: CommunityTutorialCategory | null
    query?: string | null
  },
  runner?: QueryRunner,
): Promise<{ items: PublishedTutorialRow[]; nextCursor: string | null }> {
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    author_name: string
    published_at: Date | string
    cursor_at: string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            t.published_at, t.published_at::text AS cursor_at
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.status = 'approved'
        AND ($1::timestamptz IS NULL OR (t.published_at, t.id) < ($1::timestamptz, $2::bigint))
        AND ($3::text IS NULL OR t.category = $3)
        AND ($4::text IS NULL OR t.title ILIKE '%' || $4 || '%' OR t.summary ILIKE '%' || $4 || '%')
      ORDER BY t.published_at DESC, t.id DESC
      LIMIT $5`,
    [
      args.cursor?.at ?? null,
      args.cursor?.id ?? null,
      args.category ?? null,
      args.query ?? null,
      args.limit + 1,
    ],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  const items = page.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    authorName: row.author_name,
    publishedAt: iso(row.published_at)!,
  }))
  return { items, nextCursor: page.nextCursor }
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
    body_markdown: string
    author_name: string
    published_at: Date | string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.body_markdown,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            t.published_at
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.id = $1::bigint AND t.status = 'approved'`,
    [id],
    runner,
  )
  const row = result.rows[0]
  return row
    ? {
        id: row.id,
        title: row.title,
        summary: row.summary,
        category: row.category,
        bodyMarkdown: row.body_markdown,
        authorName: row.author_name,
        publishedAt: iso(row.published_at)!,
      }
    : null
}

export async function listOwnCommunityTutorials(
  authorUserId: string,
  args: { cursor: TutorialCursor | null; limit: number },
  runner?: QueryRunner,
): Promise<{ items: OwnTutorialRow[]; nextCursor: string | null }> {
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    body_markdown: string
    status: CommunityTutorialStatus
    review_note: string | null
    created_at: Date | string
    reviewed_at: Date | string | null
    published_at: Date | string | null
    cursor_at: string
  }>(
    `SELECT id::text AS id, title, summary, category, body_markdown, status, review_note,
            created_at, reviewed_at, published_at, created_at::text AS cursor_at
       FROM community_tutorials
      WHERE author_user_id = $1::bigint
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::bigint))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [authorUserId, args.cursor?.at ?? null, args.cursor?.id ?? null, args.limit + 1],
    runner,
  )
  const page = splitPage(result.rows, args.limit, (row) => row.cursor_at)
  const items = page.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    bodyMarkdown: row.body_markdown,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: iso(row.created_at)!,
    reviewedAt: iso(row.reviewed_at),
    publishedAt: iso(row.published_at),
  }))
  return { items, nextCursor: page.nextCursor }
}

export async function listPendingCommunityTutorials(
  args: { cursor: TutorialCursor | null; limit: number },
  runner?: QueryRunner,
): Promise<{ items: PendingTutorialRow[]; nextCursor: string | null }> {
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    body_markdown: string
    status: 'pending'
    review_note: null
    created_at: Date | string
    reviewed_at: null
    published_at: null
    author_name: string
    cursor_at: string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.body_markdown, t.status,
            t.review_note, t.created_at, t.reviewed_at, t.published_at,
            t.created_at::text AS cursor_at,
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
  const items = page.rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    bodyMarkdown: row.body_markdown,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: iso(row.created_at)!,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    authorName: row.author_name,
  }))
  return { items, nextCursor: page.nextCursor }
}

export async function withdrawCommunityTutorial(
  id: string,
  authorUserId: string,
  runner?: QueryRunner,
): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE community_tutorials
        SET status = 'withdrawn', updated_at = NOW()
      WHERE id = $1::bigint AND author_user_id = $2::bigint AND status = 'pending'
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
  throw new CommunityTutorialError('NOT_PENDING', '只有待审核教程可以撤回')
}

export async function reviewCommunityTutorial(args: {
  id: string
  reviewerUserId: string
  decision: 'approve' | 'reject'
  note: string | null
}): Promise<{ status: 'approved' | 'rejected'; publishedAt: string | null }> {
  return tx(async (client) => {
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
