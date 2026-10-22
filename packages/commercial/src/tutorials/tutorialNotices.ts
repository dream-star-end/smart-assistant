import { query } from '../db/queries.js'

/**
 * 「经验分享」审核结果站内信。AI 与人工审核共用：同一篇同一结果只发一条
 * （inbox_messages 的 source 唯一索引兜底），发送者是最早的在职管理员（与免单回执同一做法）。
 * 失败只影响通知，不影响审核结果，调用方吞掉错误。
 */
export async function notifyCommunityTutorialDecision(input: {
  publicationId: string
  authorUserId: string
  title: string
  decision: 'approved' | 'rejected'
  reason: string | null
}): Promise<void> {
  const link = `/?panel=help&tab=blog&community=${input.publicationId}`
  const title =
    input.decision === 'approved' ? '你的经验分享已发布' : '你的经验分享未通过审核'
  const body =
    input.decision === 'approved'
      ? `「${input.title}」已通过审核并公开发布。\n\n[查看文章](${link})`
      : `「${input.title}」没有通过审核。\n\n原因：${input.reason ?? '未说明'}\n\n可以在「经验分享 → 我的投稿」里复制为新稿，修改后重新投稿。`
  await query(
    `INSERT INTO inbox_messages
       (audience, user_id, title, body_md, level, category, thread_key, created_by, notify_email,
        source_type, source_id, source_phase)
     SELECT 'user', $1::bigint, $2, $3, $4, 'automation',
            'community-blog:user:' || ($1::bigint)::text, a.id, FALSE,
            'community_tutorial', $5::bigint, $6
       FROM (
         SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1
       ) a
      WHERE EXISTS (SELECT 1 FROM users WHERE id = $1::bigint AND status = 'active')
     ON CONFLICT (source_type, source_id, source_phase) WHERE source_type IS NOT NULL DO NOTHING`,
    [
      input.authorUserId,
      title,
      body,
      input.decision === 'approved' ? 'notice' : 'warning',
      input.publicationId,
      input.decision,
    ],
  )
}
