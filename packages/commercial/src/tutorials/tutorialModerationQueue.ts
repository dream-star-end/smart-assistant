import { query, type QueryRunner } from '../db/queries.js'

// 投稿事务与审核 worker 共用的最小部分，单独成模块以免 communityTutorials ↔ tutorialModeration 循环引用。

export type TutorialModerationMode = 'off' | 'shadow' | 'on'

/** OC_TUTORIAL_AI_MODERATION=off|shadow|on，缺省 off（商业版默认关）。 */
export function tutorialModerationMode(env: NodeJS.ProcessEnv = process.env): TutorialModerationMode {
  const raw = env.OC_TUTORIAL_AI_MODERATION?.trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}

/** 投稿事务内调用：mode=off 不入队。 */
export async function enqueueTutorialModeration(
  publicationId: string,
  mode: TutorialModerationMode,
  runner: QueryRunner,
): Promise<void> {
  if (mode === 'off') return
  await query(
    `INSERT INTO community_tutorial_moderation_jobs (publication_id, mode)
     VALUES ($1::bigint, $2)
     ON CONFLICT (publication_id) DO NOTHING`,
    [publicationId, mode],
    runner,
  )
}
