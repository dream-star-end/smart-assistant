export const GOAL_STATUSES = ['active', 'paused', 'blocked', 'completed', 'cleared'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

/** Platform-authoritative session goal projection. Engine-native goal state is
 * diagnostic only and can never overwrite objective/status/budgets. */
export interface GoalStateSnapshot {
  sessionId: string
  goalId: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  creditBudget: string | null
  tokensUsed: number
  creditsUsed: string
  timeUsedSeconds: number
  stateRevision: number
  snapshotRevision: number
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  engineStatus?: string | null
  engineTokensUsed?: number | null
  engineTimeUsedSeconds?: number | null
  engineUpdatedAt?: string | null
}

/** One normalized execution record. A top-level turn has its own tape usage;
 * delegate records cover each child execution exactly once, including nested
 * mixed-engine trees. */
export interface DurableGoalUsageRecord {
  runId: string
  agentId: string
  engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}
