import { query, tx, type QueryRunner } from '../db/queries.js'
import { leakReportPublic, scanArtifactBytes } from './snapshotSanitizer.js'
import {
  COMMUNITY_TUTORIAL_MAX_PENDING,
  CommunityTutorialError,
  type CommunityTutorialDraft,
  assertNoMarkdownLeaks,
} from './communityTutorials.js'
import {
  assertTutorialImagesOwned,
  communityBlogEnabled,
  parseTutorialImageRefs,
  replaceTutorialImageRefs,
} from './tutorialImages.js'
import { enqueueTutorialModeration, tutorialModerationMode } from './tutorialModerationQueue.js'
import { notifyCommunityTutorialDecision } from './tutorialNotices.js'

/**
 * 加锁顺序（全模块一致，避免死锁 40P01）：审核作业行 → 稿件行 → 修改稿行。
 * 作者修改、AI 结论（settle 先收作业）、人工审核、撤回 / 下架都按这个顺序拿锁。
 *
 * 「经验分享」作者修改已投稿的帖子（OCV5-577 跟进，推翻原 Q8）。每次修改都重新审核：
 *   - 待审 / 未通过：原地改，回到待审（content_version + 1），审核作业重置重跑；
 *     另记一行 revisions(direct) 作审计与频控。
 *   - 已发布：新内容进一行 pending 修改稿，线上旧版不动；通过后替换线上内容，驳回则旧版不变，
 *     作者看到理由可以再改。同一篇同时只有一份修改稿在审，再改就把上一份标 superseded。
 * 已撤回 / 被下架 / 快照教程不能改（仍用「复制为新稿」）。修改不占每日新投稿额度，单独限次。
 */

/** 每人 24 小时内最多修改次数（含原地修改）。 */
export const COMMUNITY_TUTORIAL_DAILY_EDITS = 10

export type ReviseCommunityTutorialOptions = {
  blogEnabled?: boolean
  moderationMode?: 'off' | 'shadow' | 'on'
  limits?: { dailyEdits: number; maxPending: number }
}

export type ReviseResult = {
  id: string
  /** inplace = 稿件本身回到待审；pending = 已发布帖的修改稿在审，线上仍是旧版。 */
  mode: 'inplace' | 'pending'
  revisionId: string
  contentVersion: number
}

export async function reviseCommunityTutorial(
  authorUserId: string,
  id: string,
  draft: CommunityTutorialDraft,
  options: ReviseCommunityTutorialOptions = {},
): Promise<ReviseResult> {
  const imageShas = parseTutorialImageRefs(draft.bodyMarkdown)
  if (imageShas.length > 0 && !(options.blogEnabled ?? communityBlogEnabled()))
    throw new CommunityTutorialError('FEATURE_DISABLED', '经验分享图片功能未开启')
  assertNoMarkdownLeaks(draft.bodyMarkdown)
  const limits = options.limits ?? {
    dailyEdits: COMMUNITY_TUTORIAL_DAILY_EDITS,
    maxPending: COMMUNITY_TUTORIAL_MAX_PENDING,
  }
  const mode = options.moderationMode ?? tutorialModerationMode()
  return tx(async (client) => {
    // 与投稿同一把锁：在审篇数和修改次数按作者串行统计。
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`tutorial-quota:${authorUserId}`])
    // 先锁作业行（若有），再锁稿件行：与 AI settle（先收作业再动稿件）同序。
    await client.query('SELECT 1 FROM community_tutorial_moderation_jobs WHERE publication_id = $1::bigint FOR UPDATE', [id])
    const post = (
      await client.query<{ author_user_id: string; status: string; kind: string; content_version: number }>(
        `SELECT author_user_id::text AS author_user_id, status, kind, content_version
           FROM community_tutorials WHERE id = $1::bigint FOR UPDATE`,
        [id],
      )
    ).rows[0]
    if (!post || post.author_user_id !== authorUserId) throw new CommunityTutorialError('NOT_FOUND', '教程投稿不存在')
    if (post.kind !== 'markdown') throw new CommunityTutorialError('NOT_EDITABLE', '会话快照教程不能修改')
    if (post.status !== 'pending' && post.status !== 'rejected' && post.status !== 'approved')
      throw new CommunityTutorialError('NOT_EDITABLE', '已撤回或被下架的投稿不能修改，可以复制为新稿重新投稿')

    const counts = (
      await client.query<{ edits: string; pending_posts: string; pending_edits: string }>(
        `SELECT (SELECT count(*) FROM community_tutorial_revisions
                  WHERE author_user_id = $1::bigint AND created_at > NOW() - INTERVAL '24 hours')::text AS edits,
                (SELECT count(*) FROM community_tutorials
                  WHERE author_user_id = $1::bigint AND kind = 'markdown' AND status = 'pending'
                    AND id <> $2::bigint)::text AS pending_posts,
                (SELECT count(*) FROM community_tutorial_revisions
                  WHERE author_user_id = $1::bigint AND status = 'pending'
                    AND publication_id <> $2::bigint)::text AS pending_edits`,
        [authorUserId, id],
      )
    ).rows[0]
    if (Number(counts?.edits ?? 0) >= limits.dailyEdits)
      throw new CommunityTutorialError('RATE_LIMITED', `24 小时内最多修改 ${limits.dailyEdits} 次`)
    if (Number(counts?.pending_posts ?? 0) + Number(counts?.pending_edits ?? 0) >= limits.maxPending)
      throw new CommunityTutorialError('RATE_LIMITED', `最多同时有 ${limits.maxPending} 篇在审核，请等审核结果出来再改`)

    if (post.status === 'approved') {
      await client.query(
        `UPDATE community_tutorial_revisions SET status = 'superseded', updated_at = NOW()
          WHERE publication_id = $1::bigint AND status = 'pending'`,
        [id],
      )
      await assertTutorialImagesOwned(authorUserId, imageShas, client)
      const revision = (
        await client.query<{ id: string }>(
          `INSERT INTO community_tutorial_revisions
             (publication_id, author_user_id, status, title, summary, category, body_markdown, needs_human)
           VALUES ($1::bigint, $2::bigint, 'pending', $3, $4, $5, $6, $7)
           RETURNING id::text AS id`,
          [id, authorUserId, draft.title, draft.summary, draft.category, draft.bodyMarkdown, mode !== 'on'],
        )
      ).rows[0]!
      for (const sha of imageShas) {
        await client.query(
          'INSERT INTO community_tutorial_revision_images (revision_id, sha256) VALUES ($1::bigint, $2)',
          [revision.id, sha],
        )
      }
      await enqueueTutorialModeration(id, mode, client, { reset: true })
      return { id, mode: 'pending' as const, revisionId: revision.id, contentVersion: post.content_version }
    }

    // 待审 / 未通过：原地改回待审。审核字段清空，旧理由不再适用。
    const updated = (
      await client.query<{ content_version: number }>(
        `UPDATE community_tutorials
            SET title = $2, summary = $3, category = $4, body_markdown = $5, status = 'pending',
                review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, review_source = NULL,
                published_at = NULL, needs_human = $6, content_version = content_version + 1,
                updated_at = NOW()
          WHERE id = $1::bigint
          RETURNING content_version`,
        [id, draft.title, draft.summary, draft.category, draft.bodyMarkdown, mode !== 'on'],
      )
    ).rows[0]!
    await replaceTutorialImageRefs({ publicationId: id, authorUserId, shas: imageShas }, client)
    const revision = (
      await client.query<{ id: string }>(
        `INSERT INTO community_tutorial_revisions
           (publication_id, author_user_id, status, title, summary, category, body_markdown)
         VALUES ($1::bigint, $2::bigint, 'direct', $3, $4, $5, $6)
         RETURNING id::text AS id`,
        [id, authorUserId, draft.title, draft.summary, draft.category, draft.bodyMarkdown],
      )
    ).rows[0]!
    await enqueueTutorialModeration(id, mode, client, { reset: true })
    return { id, mode: 'inplace' as const, revisionId: revision.id, contentVersion: updated.content_version }
  })
}

export type PendingRevisionRow = {
  id: string
  publicationId: string
  authorUserId: string
  title: string
  summary: string
  category: string
  bodyMarkdown: string
}

/** 已发布帖当前在审的修改稿；没有返回 null。 */
export async function getPendingRevision(publicationId: string, runner?: QueryRunner): Promise<PendingRevisionRow | null> {
  const row = (
    await query<{
      id: string
      publication_id: string
      author_user_id: string
      title: string
      summary: string
      category: string
      body_markdown: string
    }>(
      `SELECT r.id::text AS id, r.publication_id::text AS publication_id, r.author_user_id::text AS author_user_id,
              r.title, r.summary, r.category, r.body_markdown
         FROM community_tutorial_revisions r
         JOIN community_tutorials t ON t.id = r.publication_id
        WHERE r.publication_id = $1::bigint AND r.status = 'pending' AND t.status = 'approved'`,
      [publicationId],
      runner,
    )
  ).rows[0]
  if (!row) return null
  return {
    id: row.id,
    publicationId: row.publication_id,
    authorUserId: row.author_user_id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    bodyMarkdown: row.body_markdown,
  }
}

/** 修改稿的图片字节（AI 视觉审核与公开前复扫用）。 */
export async function listRevisionImages(
  revisionId: string,
  runner?: QueryRunner,
): Promise<Array<{ sha256: string; mime: string; body: Buffer }>> {
  const result = await query<{ sha256: string; mime: string; body: Buffer }>(
    `SELECT b.sha256, b.mime, b.body
       FROM community_tutorial_revision_images i JOIN tutorial_blobs b ON b.sha256 = i.sha256
      WHERE i.revision_id = $1::bigint
      ORDER BY b.sha256`,
    [revisionId],
    runner,
  )
  return result.rows.map((row) => ({ ...row, body: Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body) }))
}

/** 修改稿公开前的泄密复扫（正文 + 图片），与稿件本身的 assertTutorialPublishable 同一规则。 */
export async function assertRevisionPublishable(revisionId: string, runner: QueryRunner): Promise<void> {
  const row = (
    await query<{ body_markdown: string }>(
      'SELECT body_markdown FROM community_tutorial_revisions WHERE id = $1::bigint',
      [revisionId],
      runner,
    )
  ).rows[0]
  if (!row) throw new CommunityTutorialError('NOT_FOUND', '修改稿不存在')
  assertNoMarkdownLeaks(row.body_markdown)
  const leaks: ReturnType<typeof scanArtifactBytes> = []
  for (const image of await listRevisionImages(revisionId, runner)) {
    leaks.push(...scanArtifactBytes(image.mime, image.body, `blob:revision-image:${image.sha256.slice(0, 12)}`))
  }
  if (leaks.length > 0) throw new CommunityTutorialError('LEAKS_FOUND', '修改稿未通过复核扫描', leakReportPublic(leaks))
}

type Settled = { publicationId: string; authorUserId: string; title: string }

/** 动修改稿之前先锁它所属的稿件行（加锁顺序：稿件 → 修改稿）。 */
async function lockRevisionPost(client: QueryRunner, revisionId: string): Promise<void> {
  await query(
    `SELECT t.id FROM community_tutorials t
       JOIN community_tutorial_revisions r ON r.publication_id = t.id
      WHERE r.id = $1::bigint
        FOR UPDATE OF t`,
    [revisionId],
    client,
  )
}

/**
 * 修改稿通过：替换线上正文、标题、摘要、分类和图片引用，content_version + 1。
 * 修改稿已不在审（作者又改了、帖子被撤回）返回 null，调用方按「没生效」处理。
 */
export async function applyRevision(
  client: QueryRunner,
  args: { revisionId: string; reviewerUserId: string; source: 'ai' | 'human'; note: string | null },
): Promise<Settled | null> {
  await lockRevisionPost(client, args.revisionId)
  const revision = (
    await query<{
      publication_id: string
      author_user_id: string
      title: string
      summary: string
      category: string
      body_markdown: string
    }>(
      `UPDATE community_tutorial_revisions
          SET status = 'approved', reviewed_by = $2::bigint, reviewed_at = NOW(), review_source = $3,
              review_note = $4, needs_human = false, updated_at = NOW()
        WHERE id = $1::bigint AND status = 'pending'
          AND EXISTS (SELECT 1 FROM community_tutorials t WHERE t.id = publication_id AND t.status = 'approved')
        RETURNING publication_id::text AS publication_id, author_user_id::text AS author_user_id,
                  title, summary, category, body_markdown`,
      [args.revisionId, args.reviewerUserId, args.source, args.note],
      client,
    )
  ).rows[0]
  if (!revision) return null
  await query(
    `UPDATE community_tutorials
        SET title = $2, summary = $3, category = $4, body_markdown = $5,
            content_version = content_version + 1, updated_at = NOW()
      WHERE id = $1::bigint AND status = 'approved'`,
    [revision.publication_id, revision.title, revision.summary, revision.category, revision.body_markdown],
    client,
  )
  await replaceTutorialImageRefs(
    {
      publicationId: revision.publication_id,
      authorUserId: revision.author_user_id,
      shas: parseTutorialImageRefs(revision.body_markdown),
    },
    client,
  )
  return { publicationId: revision.publication_id, authorUserId: revision.author_user_id, title: revision.title }
}

/** 修改稿驳回：线上旧版不变。已不在审返回 null。 */
export async function rejectRevision(
  client: QueryRunner,
  args: { revisionId: string; reviewerUserId: string; source: 'ai' | 'human'; note: string },
): Promise<Settled | null> {
  await lockRevisionPost(client, args.revisionId)
  const row = (
    await query<{ publication_id: string; author_user_id: string; title: string }>(
      `UPDATE community_tutorial_revisions
          SET status = 'rejected', reviewed_by = $2::bigint, reviewed_at = NOW(), review_source = $3,
              review_note = $4, needs_human = false, updated_at = NOW()
        WHERE id = $1::bigint AND status = 'pending'
        RETURNING publication_id::text AS publication_id, author_user_id::text AS author_user_id, title`,
      [args.revisionId, args.reviewerUserId, args.source, args.note],
      client,
    )
  ).rows[0]
  if (!row) return null
  return { publicationId: row.publication_id, authorUserId: row.author_user_id, title: row.title }
}

/** 管理员人工审核一份修改稿（AI 拿不准或出错转来的）。 */
export async function reviewCommunityTutorialRevision(args: {
  publicationId: string
  revisionId: string
  reviewerUserId: string
  decision: 'approve' | 'reject'
  note: string | null
}): Promise<{ status: 'approved' | 'rejected' }> {
  const settled = await tx(async (client) => {
    const owner = (
      await client.query<{ publication_id: string }>(
        'SELECT publication_id::text AS publication_id FROM community_tutorial_revisions WHERE id = $1::bigint',
        [args.revisionId],
      )
    ).rows[0]
    if (!owner || owner.publication_id !== args.publicationId)
      throw new CommunityTutorialError('NOT_FOUND', '修改稿不存在')
    if (args.decision === 'approve') await assertRevisionPublishable(args.revisionId, client)
    const result =
      args.decision === 'approve'
        ? await applyRevision(client, {
            revisionId: args.revisionId,
            reviewerUserId: args.reviewerUserId,
            source: 'human',
            note: args.note,
          })
        : await rejectRevision(client, {
            revisionId: args.revisionId,
            reviewerUserId: args.reviewerUserId,
            source: 'human',
            note: args.note ?? '',
          })
    if (!result) throw new CommunityTutorialError('STALE', '这份修改已经处理过，或作者又改了一版，请刷新后再看')
    return result
  })
  const status = args.decision === 'approve' ? 'approved' : 'rejected'
  await notifyCommunityTutorialDecision({
    publicationId: settled.publicationId,
    authorUserId: settled.authorUserId,
    title: settled.title,
    decision: status,
    reason: args.note,
    revisionId: args.revisionId,
  }).catch(() => {})
  return { status }
}
