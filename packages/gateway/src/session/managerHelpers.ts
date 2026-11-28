/**
 * Extracted state helpers for SessionManager methods:
 * swarm target resolution, tail owner LRU budget, bounded stdout drain,
 * goal synchronization, prompt-queue fences, and pre-start stop fences.
 */
import type { GoalStateSnapshot } from '@openclaude/protocol'
import type { EngineAdapter } from '../engine/engineAdapter.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import {
  PRE_START_STOP_TTL_MS,
  nextUserGoal,
  preStartStopKey,
} from './sessionUtils.js'
import type {
  PreStartStopEntry,
  PromptQueueExecutionFence,
  TailOwnerBudget,
} from './types.js'

function findUniqueKeyForSessionId(
  sessionId: string,
  sessionIdToKey: Map<string, string>,
  sessions: Map<string, AgentSession>,
  resumeMap: Map<string, string>,
): string | null {
  const mapped = sessionIdToKey.get(sessionId)
  if (mapped) return mapped
  const liveMatches: string[] = []
  for (const s of sessions.values()) {
    if (s.peerId === sessionId) liveMatches.push(s.sessionKey)
  }
  if (liveMatches.length > 1) return null
  if (liveMatches[0]) return liveMatches[0]
  const suffix = `:${sessionId}`
  const resumeMatches: string[] = []
  for (const key of resumeMap.keys()) {
    if (key.endsWith(suffix)) resumeMatches.push(key)
  }
  return resumeMatches.length === 1 ? resumeMatches[0]! : null
}

export function resolveAntigravitySwarmTargetForManager(
  sessionId: string,
  state: {
    sessionIdToKey: Map<string, string>
    sessions: Map<string, AgentSession>
    resumeMap: Map<string, string>
  },
): { sessionKey: string; brainDir?: string; conversationId?: string } | null {
  const sessionKey = findUniqueKeyForSessionId(
    sessionId,
    state.sessionIdToKey,
    state.sessions,
    state.resumeMap,
  )
  if (!sessionKey) return null
  const live = state.sessions.get(sessionKey)
  const runner = live?.runner as
    | { getActiveSwarmTarget?: () => { brainDir: string; conversationId: string } | null }
    | undefined
  const activeTarget = runner?.getActiveSwarmTarget?.()
  if (activeTarget) {
    return {
      sessionKey,
      brainDir: activeTarget.brainDir,
      conversationId: activeTarget.conversationId,
    }
  }
  const conversationId = live?.ccbSessionId ?? state.resumeMap.get(sessionKey)
  return { sessionKey, ...(conversationId ? { conversationId } : {}) }
}

export function getOrCreateTailOwnerBudget(
  budgets: Map<string, TailOwnerBudget>,
  ownerTurnKey: string,
  maxCap: number,
): TailOwnerBudget {
  const existing = budgets.get(ownerTurnKey)
  if (existing) {
    budgets.delete(ownerTurnKey)
    budgets.set(ownerTurnKey, existing)
    return existing
  }
  const budget: TailOwnerBudget = {
    persistedCount: 0,
    capped: false,
    markerEvent: null,
    chain: Promise.resolve(),
  }
  budgets.set(ownerTurnKey, budget)
  while (budgets.size > maxCap) {
    const oldest = budgets.keys().next().value as string | undefined
    if (oldest === undefined) break
    budgets.delete(oldest)
    log.warn('post-terminal tail owner budget evicted (budget reset)', {
      evictedOwnerTurnKey: oldest,
      budgetCap: maxCap,
    })
  }
  return budget
}

export async function awaitBoundedOutputDrainWithTimeout(
  runner: Pick<EngineAdapter, 'waitForOutputDrain'>,
  session: AgentSession,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await runner.waitForOutputDrain()
    return
  }
  let timer: NodeJS.Timeout | undefined
  const drained = await Promise.race([
    runner.waitForOutputDrain().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (drained) return
  log.error('terminal output drain deadline exceeded; finalizing turn without stdout close', {
    sessionKey: session.sessionKey,
    provider: session.providerTag,
    timeoutMs,
  })
}

export async function applySessionUserGoalAction(
  session: AgentSession | undefined,
  action: 'set' | 'pause' | 'resume' | 'clear',
  objective: string | undefined,
): Promise<'applied' | 'noop' | 'rejected'> {
  if (!session) return 'rejected'
  const prev = session.lock
  let release!: () => void
  session.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await prev
    const next = nextUserGoal(session._platformGoal ?? null, session.peerId, action, objective)
    if (next === 'rejected' || next === 'noop') return next
    session._platformGoal = next
    await session.runner.setGoalState(next)
    return 'applied'
  } finally {
    release()
  }
}

export async function syncSessionGoalState(
  session: AgentSession | undefined,
  goal: GoalStateSnapshot,
): Promise<void> {
  if (!session) return
  const prev = session.lock
  let release!: () => void
  session.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await prev
    session._platformGoal = structuredClone(goal)
    await session.runner.setGoalState(goal)
  } finally {
    release()
  }
}

export function beginSessionPromptQueueFence(
  sessionKey: string,
  state: {
    sessions: Map<string, AgentSession>
    dispatchFences: Map<string, symbol>
    executionKeys: Set<string>
  },
): PromptQueueExecutionFence {
  const existing = state.sessions.get(sessionKey)
  if (
    state.dispatchFences.has(sessionKey) ||
    state.executionKeys.has(sessionKey) ||
    (existing?._activeTurnCount ?? 0) > 0 ||
    (existing?._activeClientTurnCount ?? 0) > 0
  ) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: logical session already owns runtime work')
  }
  const token = Symbol(`prompt-queue:${sessionKey}`)
  state.dispatchFences.set(sessionKey, token)
  let released = false
  return {
    sessionKey,
    token,
    release: () => {
      if (released) return
      released = true
      if (state.dispatchFences.get(sessionKey) === token) {
        state.dispatchFences.delete(sessionKey)
      }
    },
  }
}

export function recordPreStartStopFence(
  map: Map<string, PreStartStopEntry>,
  peerId: string,
  clientMessageId: string,
  ttlMs: number = PRE_START_STOP_TTL_MS,
  sendAttempt?: number,
): void {
  const now = Date.now()
  for (const [key, fence] of map) {
    if (fence.expiresAt <= now) map.delete(key)
  }
  map.set(preStartStopKey(peerId, clientMessageId), {
    expiresAt: now + ttlMs,
    ...(sendAttempt !== undefined ? { sendAttempt } : {}),
  })
}

export function adoptPreStartStopFence(
  map: Map<string, PreStartStopEntry>,
  peerId: string,
  clientMessageId: string,
  sendAttempt?: number,
): void {
  const key = preStartStopKey(peerId, clientMessageId)
  const fence = map.get(key)
  if (!fence) return
  if (fence.expiresAt <= Date.now()) {
    map.delete(key)
    return
  }
  if (fence.sendAttempt !== undefined && sendAttempt !== undefined && fence.sendAttempt !== sendAttempt) {
    map.delete(key)
    return
  }
  fence.expiresAt = Date.now() + PRE_START_STOP_TTL_MS
}

export function consumePreStartStopFence(
  map: Map<string, PreStartStopEntry>,
  peerId: string,
  clientMessageId: string,
): boolean {
  const key = preStartStopKey(peerId, clientMessageId)
  const fence = map.get(key)
  if (fence === undefined) return false
  map.delete(key)
  return fence.expiresAt > Date.now()
}
