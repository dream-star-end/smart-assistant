import { query } from '../db/queries.js'

/**
 * 「经验分享」审核结果站内信。AI 与人工审核共用：同一篇同一结果只发一条
 * （inbox_messages 的 source 唯一索引兜底），发送者是最早的在职管理员（与免单回执同一做法）。
 * 失败只影响通知，不影响审核结果，调用方吞掉错误。
 *
 * 去重键：稿件本身是 (community_tutorial, 稿件 id, 结果)，改过再审的稿件结果带版本号
 * （rejected:v2…），否则第二次驳回会被第一次的去重吞掉；已发布帖的修改稿按修改稿 id 去重。
 */
export async function notifyCommunityTutorialDecision(input: {
  publicationId: string
  authorUserId: string
  title: string
  decision: 'approved' | 'rejected'
  reason: string | null
  /** 稿件当前正文版本；>1 表示改过再审。 */
  version?: number
  /** 已发布帖的修改稿：线上旧版不变，结果只针对这次修改。 */
  revisionId?: string
}): Promise<void> {
  const link = `/?panel=help&tab=blog&community=${input.publicationId}`
  const edit = input.revisionId !== undefined
  const approved = input.decision === 'approved'
  const title = edit
    ? approved
      ? '你的经验分享修改已生效'
      : '你的经验分享修改未通过审核'
    : approved
      ? '你的经验分享已发布'
      : '你的经验分享未通过审核'
  const body = edit
    ? approved
      ? `「${input.title}」的修改已通过审核，线上已换成新版本。\n\n[查看文章](${link})`
      : `「${input.title}」的修改没有通过审核，线上仍是修改前的版本。\n\n原因：${input.reason ?? '未说明'}\n\n可以在「经验分享 → 我的投稿」里继续修改后重新提交。`
    : approved
      ? `「${input.title}」已通过审核并公开发布。\n\n[查看文章](${link})`
      : `「${input.title}」没有通过审核。\n\n原因：${input.reason ?? '未说明'}\n\n可以在「经验分享 → 我的投稿」里修改后重新提交审核。`
  const sourceType = edit ? 'community_tutorial_revision' : 'community_tutorial'
  const sourceId = edit ? input.revisionId : input.publicationId
  const phase = !edit && (input.version ?? 1) > 1 ? `${input.decision}:v${input.version}` : input.decision
  await query(
    `INSERT INTO inbox_messages
       (audience, user_id, title, body_md, level, category, thread_key, created_by, notify_email,
        source_type, source_id, source_phase)
     SELECT 'user', $1::bigint, $2, $3, $4, 'automation',
            'community-blog:user:' || ($1::bigint)::text, a.id, FALSE,
            $7, $5::bigint, $6
       FROM (
         SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1
       ) a
      WHERE EXISTS (SELECT 1 FROM users WHERE id = $1::bigint AND status = 'active')
     ON CONFLICT (source_type, source_id, source_phase) WHERE source_type IS NOT NULL DO NOTHING`,
    [input.authorUserId, title, body, approved ? 'notice' : 'warning', sourceId, phase, sourceType],
  )
}
