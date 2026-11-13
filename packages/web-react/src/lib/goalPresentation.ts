import type { GoalStateSnapshot } from '@openclaude/protocol/goalState'
export type GoalSetInput = {
  objective: string
  tokenBudget: number | null
  creditBudget: string | null
  expectedStateRevision: number
}

export const STATUS_LABEL: Record<GoalStateSnapshot['status'], string> = {
  active: '已启用',
  paused: '已暂停',
  blocked: '受阻',
  completed: '已完成',
  cleared: '未设置',
}

export function creditsNearBudget(used: string, budget: string | null): boolean {
  if (!budget) return false
  try {
    return BigInt(used) * 5n >= BigInt(budget) * 4n
  } catch {
    return false
  }
}

export function tokensNearBudget(used: number, budget: number | null): boolean {
  if (budget === null) return false
  return BigInt(used) * 5n >= BigInt(budget) * 4n
}

/** 会话是否有一个「可见」目标（已设置且未清除）。入口徽标/状态点的单一判定权威。 */
export function visibleGoalOf(
  goal: GoalStateSnapshot | null | undefined,
): GoalStateSnapshot | null {
  return goal && goal.status !== 'cleared' ? goal : null
}

/** 目标预算是否接近/达到软阈值（80%）。入口状态点颜色与对话框内软告警共用同一判定。 */
export function goalNearBudget(goal: GoalStateSnapshot): boolean {
  return (
    tokensNearBudget(goal.tokensUsed, goal.tokenBudget) ||
    creditsNearBudget(goal.creditsUsed, goal.creditBudget)
  )
}
