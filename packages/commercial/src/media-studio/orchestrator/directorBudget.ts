// Worst-case price of one user-billed director call (plan, interpret, visual QA),
// reserved on the project before the task is queued. A slot with no pricer reserves
// nothing (tests and a catalog-less boot). A pricer that cannot price returns
// 'unpriced' so the caller does not dispatch a free call past the budget.

import type { PoolClient } from 'pg'

import { reserveBudget } from './budget.js'
import { directorModelOf } from './directorModel.js'
import type { StudioQaDeps } from './qa.js'

export async function reserveDirectorStep(
  client: PoolClient,
  qa: StudioQaDeps | undefined,
  projectId: string,
): Promise<{ est: bigint } | 'budget' | 'unpriced'> {
  const chosen = await client.query<{ model: string | null }>(
    `SELECT settings->>'directorModel' AS model FROM studio_projects WHERE id = $1`,
    [projectId],
  )
  const est = qa?.maxCost
    ? await qa.maxCost(directorModelOf({ directorModel: chosen.rows[0]?.model })).catch(() => null)
    : 0n
  if (est === null) return 'unpriced'
  if (!(await reserveBudget(client, projectId, est))) return 'budget'
  return { est }
}
