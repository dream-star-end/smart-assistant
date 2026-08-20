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
      | 'BAD_BODY',
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
}

export interface OwnTutorialDetailRow extends OwnTutorialRow {
  sourceSessionId: string | null
}

export interface PendingTutorialRow extends OwnTutorialRow {
  authorName: string
}

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
  const leaks = scanMarkdownBody(bodyMarkdown)
  if (leaks.length > 0) {
    throw new CommunityTutorialError('LEAKS_FOUND', '教程正文未通过安全扫描', leakReportPublic(leaks))
  }
}

export async function submitCommunityTutorial(
  authorUserId: string,
  draft: CommunityTutorialDraft,
  runner?: QueryRunner,
): Promise<{ id: string; status: 'pending'; createdAt: string }> {
  assertNoMarkdownLeaks(draft.bodyMarkdown)
  const result = await query<{ id: string; created_at: Date | string }>(
    `INSERT INTO community_tutorials
       (author_user_id, title, summary, category, body_markdown, kind)
     VALUES ($1::bigint, $2, $3, $4, $5, 'markdown')
     RETURNING id::text AS id, created_at`,
    [authorUserId, draft.title, draft.summary, draft.category, draft.bodyMarkdown],
    runner,
  )
  const row = result.rows[0]!
  return { id: row.id, status: 'pending', createdAt: iso(row.created_at)! }
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
            source_session_id, sanitizer_version, status)
         VALUES ($1::bigint, $2, $3, $4, $5, 'snapshot', $6::jsonb, $7, $8, $9)
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
): Promise<{ items: PublishedTutorialRow[]; nextCursor: string | null }> {
  const result = await query<{
    id: string
    title: string
    summary: string
    category: CommunityTutorialCategory
    kind: CommunityTutorialKind
    author_name: string
    published_at: Date | string
    cursor_at: string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.kind,
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
    kind: row.kind,
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
    kind: CommunityTutorialKind
    body_markdown: string
    snapshot_json: unknown
    author_name: string
    published_at: Date | string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.kind, t.body_markdown, t.snapshot_json,
            COALESCE(NULLIF(btrim(u.display_name), ''), '社区用户') AS author_name,
            t.published_at
       FROM community_tutorials t
       JOIN users u ON u.id = t.author_user_id
      WHERE t.id = $1::bigint AND t.status = 'approved'`,
    [id],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  const refs = row.kind === 'snapshot' ? await listTutorialBlobRefs(row.id, runner) : []
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    authorName: row.author_name,
    publishedAt: iso(row.published_at)!,
    bodyMarkdown: row.body_markdown,
    snapshot: parseSnapshot(row.snapshot_json),
    refs,
  }
}

export async function getOwnCommunityTutorial(
  id: string,
  authorUserId: string,
  runner?: QueryRunner,
): Promise<OwnTutorialDetailRow | null> {
  const result = await query<{
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
  }>(
    `SELECT id::text AS id, title, summary, category, kind, body_markdown, snapshot_json,
            source_session_id, sanitizer_version, status, review_note,
            created_at, reviewed_at, published_at
       FROM community_tutorials
      WHERE id = $1::bigint AND author_user_id = $2::bigint`,
    [id, authorUserId],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  const refs = row.kind === 'snapshot' ? await listTutorialBlobRefs(row.id, runner) : []
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    bodyMarkdown: row.body_markdown,
    snapshot: parseSnapshot(row.snapshot_json),
    sourceSessionId: row.source_session_id,
    sanitizerVersion: row.sanitizer_version,
    refs,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: iso(row.created_at)!,
    reviewedAt: iso(row.reviewed_at),
    publishedAt: iso(row.published_at),
  }
}

function mapOwnRow(row: {
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
}): OwnTutorialRow {
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
  }
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
    cursor_at: string
  }>(
    `SELECT id::text AS id, title, summary, category, kind, body_markdown, snapshot_json,
            source_session_id, sanitizer_version, status, review_note,
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
  return { items: page.rows.map(mapOwnRow), nextCursor: page.nextCursor }
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
    kind: CommunityTutorialKind
    body_markdown: string
    snapshot_json: unknown
    source_session_id: string | null
    sanitizer_version: string | null
    status: 'pending'
    review_note: null
    created_at: Date | string
    reviewed_at: null
    published_at: null
    author_name: string
    cursor_at: string
  }>(
    `SELECT t.id::text AS id, t.title, t.summary, t.category, t.kind, t.body_markdown, t.snapshot_json,
            t.source_session_id, t.sanitizer_version, t.status,
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
  return {
    items: page.rows.map((row) => ({ ...mapOwnRow(row), authorName: row.author_name })),
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
        SET status = 'withdrawn', published_at = NULL, updated_at = NOW()
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
  if (row.kind === 'snapshot') {
    const leaks = scanMarkdownBody(JSON.stringify(row.snapshot_json ?? {}), 'snapshot')
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
      throw new CommunityTutorialError('LEAKS_FOUND', '快照未通过复核扫描', leakReportPublic(leaks))
    }
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
