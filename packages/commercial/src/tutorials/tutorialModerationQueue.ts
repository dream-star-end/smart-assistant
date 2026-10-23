import { query, type QueryRunner } from '../db/queries.js'

// 投稿事务与审核 worker 共用的最小部分，单独成模块以免 communityTutorials ↔ tutorialModeration 循环引用。

export type TutorialModerationMode = 'off' | 'shadow' | 'on'

/** OC_TUTORIAL_AI_MODERATION=off|shadow|on，缺省 off（商业版默认关）。 */
export function tutorialModerationMode(env: NodeJS.ProcessEnv = process.env): TutorialModerationMode {
  const raw = env.OC_TUTORIAL_AI_MODERATION?.trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}

/**
 * 投稿 / 修改事务内调用：mode=off 不入队。
 * reset（作者改了稿）：已有作业重新排队、次数清零、清掉租约——正在跑的那次拿不回租约，
 * 它对旧内容的结论落不下来，新内容会重新审一遍。
 */
export async function enqueueTutorialModeration(
  publicationId: string,
  mode: TutorialModerationMode,
  runner: QueryRunner,
  opts: { reset?: boolean } = {},
): Promise<void> {
  if (mode === 'off') return
  await query(
    `INSERT INTO community_tutorial_moderation_jobs (publication_id, mode)
     VALUES ($1::bigint, $2)
     ON CONFLICT (publication_id) DO ${
       opts.reset
         ? `UPDATE SET mode = EXCLUDED.mode, status = 'queued', attempt = 0, next_attempt_at = NOW(),
                       lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()`
         : 'NOTHING'
     }`,
    [publicationId, mode],
    runner,
  )
}
