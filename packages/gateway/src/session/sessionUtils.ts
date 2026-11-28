/**
 * Pure session utilities: idle watchdog predicates, recent-terminal ring,
 * pre-start stop keys, goal transitions, verification verdict parsing,
 * prompt-queue admission assertions, and output asset collection scheduling.
 */
import { randomUUID } from 'node:crypto'
import type { GoalStateSnapshot } from '@openclaude/protocol'
import { collectSessionOutputAssets } from '../projectAssetCollector.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import type { ParsedVerdict } from './types.js'

export const SESSION_PERSIST_QUEUED_NOTICE =
  '回复已生成，但会话存储暂时不可用，内容已安全排队待写入。稍后刷新即可看到完整记录。'

export const IDLE_TIMEOUT_TOOL_MS = 15 * 60_000
export const IDLE_TIMEOUT_DEFAULT_MS = 5 * 60_000
export const BOX_ACTIVE_TURN_IDLE_MS = 4 * 60 * 60_000 + 5 * 60_000
export const BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS = 6 * 60 * 60_000 + 15 * 60_000
export const RESUME_MAP_INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000

export const PRE_START_STOP_TTL_MS = 10 * 60_000
export const PRE_ADMISSION_STOP_TTL_MS = 30_000

export const TRANSIENT_RETRY_INPUT = '上一条消息因上游瞬时错误中断，请继续完成该任务。'
export const MODEL_THINKING_WORKING_DETAIL = 'thinking'
export const MODEL_THINKING_KEEPALIVE_MS = 10_000
export const ENGINE_PREHEAT_DEADLINE_DEFAULT_MS = 45_000

const RECENT_TERMINAL_RING_CAP = 8
const USER_GOAL_OBJECTIVE_MAX = 4000
const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|PARTIAL|NEEDS_FIX)\s*$/m

export function assertPromptQueueExecutionAdmission(
  queueTurn: boolean,
  activeSubmits: number,
  activeClientTurns: number,
  queueExecutionActive = false,
): void {
  if (queueTurn && (activeSubmits !== 0 || activeClientTurns !== 1)) {
    throw new Error(
      `PROMPT_QUEUE_EXECUTION_INVARIANT: expected one client turn and no queued submit (client=${activeClientTurns}, submit=${activeSubmits})`,
    )
  }
  if (queueExecutionActive) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: queue execution already owns this session')
  }
}

export function shouldTripIdleWatchdog(input: {
  waitingForUserInput: boolean
  idleMs: number
  thresholdMs: number
}): boolean {
  return !input.waitingForUserInput && input.idleMs > input.thresholdMs
}

export function shouldFireTurnIdleTimeout(input: {
  waitingForUserInput: boolean
  finalized: boolean
}): boolean {
  return !input.finalized && !input.waitingForUserInput
}

export function applyTurnIdleTimeoutTick(input: {
  waitingForUserInput: boolean
  finalized: boolean
  refresh: () => void
}): boolean {
  if (
    !shouldFireTurnIdleTimeout({
      waitingForUserInput: input.waitingForUserInput,
      finalized: input.finalized,
    })
  ) {
    if (!input.finalized && input.waitingForUserInput) input.refresh()
    return false
  }
  return true
}

export function scheduleSessionOutputAssetCollection(opts: {
  userId: string | undefined
  sessionId: string
  assistantText: string
  sessionKey: string
  traceId?: string
  chatProjectId?: string | null
}): void {
  if (!opts.userId) return
  void collectSessionOutputAssets({
    userId: opts.userId,
    sessionId: opts.sessionId,
    assistantText: opts.assistantText || '',
    ...(opts.chatProjectId !== undefined ? { chatProjectId: opts.chatProjectId } : {}),
  }).catch((err) => {
    log.warn(
      'collectSessionOutputAssets failed',
      {
        sessionKey: opts.sessionKey,
        ...(opts.traceId ? { traceId: opts.traceId } : {}),
      },
      err,
    )
  })
}

export function recordRecentTerminal(
  session: AgentSession,
  clientMessageId: string,
  outcome: 'completed' | 'interrupted' | 'crashed',
): void {
  if (!clientMessageId) return
  const ring = session._recentTerminalRing ?? (session._recentTerminalRing = [])
  const existing = ring.findIndex((e) => e.clientMessageId === clientMessageId)
  if (existing >= 0) ring.splice(existing, 1)
  ring.push({ clientMessageId, outcome })
  while (ring.length > RECENT_TERMINAL_RING_CAP) ring.shift()
}

export function lookupRecentTerminal(
  session: AgentSession,
  clientMessageId: string,
  options: { masterAuthoritative?: boolean } = {},
): 'completed' | 'interrupted' | 'crashed' | undefined {
  if (options.masterAuthoritative) return undefined
  return session._recentTerminalRing?.find((e) => e.clientMessageId === clientMessageId)?.outcome
}

export function takeDurableEventOrdinal(session: AgentSession): number {
  const ordinal = session._nextDurableEventOrdinal ?? 0
  session._nextDurableEventOrdinal = ordinal + 1
  return ordinal
}

export function stopControlSendAttempt(controlId: unknown, clientMessageId: string): number | undefined {
  if (typeof controlId !== 'string') return undefined
  const base = `control:stop:${clientMessageId}`
  if (controlId === base) return 0
  const match = controlId.startsWith(`${base}:attempt:`)
    ? /^(\d{1,9})$/.exec(controlId.slice(base.length + ':attempt:'.length))
    : null
  return match ? Number(match[1]) : undefined
}

export function messageSendAttempt(idempotencyKey: unknown, clientMessageId: string): number | undefined {
  if (typeof idempotencyKey !== 'string') return undefined
  const prefix = `web:${clientMessageId}:`
  if (!idempotencyKey.startsWith(prefix)) return undefined
  const match = /^(\d{1,9})$/.exec(idempotencyKey.slice(prefix.length))
  return match ? Number(match[1]) : undefined
}

export function preStartStopKey(peerId: string, clientMessageId: string): string {
  return `${peerId.replace(/[^a-zA-Z0-9_-]/g, '_')}\u0000${clientMessageId}`
}

export function activeGoalAttribution(session: AgentSession):
  | {
      goalId: string
      goalStateRevision: number
    }
  | undefined {
  const goal = session._platformGoal
  return goal?.status === 'active'
    ? { goalId: goal.goalId, goalStateRevision: goal.stateRevision }
    : undefined
}

/** A short-lived host-controlled drain rejected a new runtime turn. */
export class RuntimeRecycleDrainingError extends Error {
  readonly code = 'RUNTIME_RECYCLE_DRAINING'
  constructor() {
    super('runtime is draining for a stale-image recycle')
    this.name = 'RuntimeRecycleDrainingError'
  }
}

function isUserGoalNoop(
  current: GoalStateSnapshot | null,
  action: 'set' | 'pause' | 'resume' | 'clear',
  text: string,
): boolean {
  if (!current) return false
  if (action === 'clear') return current.status === 'cleared'
  if (action === 'pause') return current.status === 'paused'
  return current.status === 'active' && current.objective === text
}

function buildGoalSnapshot(
  current: GoalStateSnapshot | null,
  sessionId: string,
  text: string,
  status: GoalStateSnapshot['status'],
): GoalStateSnapshot {
  const now = new Date().toISOString()
  return {
    sessionId,
    goalId: current?.goalId ?? randomUUID(),
    objective: text || current?.objective || ' ',
    status,
    tokenBudget: current?.tokenBudget ?? null,
    creditBudget: current?.creditBudget ?? null,
    tokensUsed: current?.tokensUsed ?? 0,
    creditsUsed: current?.creditsUsed ?? '0',
    timeUsedSeconds: current?.timeUsedSeconds ?? 0,
    stateRevision: (current?.stateRevision ?? 0) + 1,
    snapshotRevision: (current?.snapshotRevision ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    statusChangedAt: current?.status === status ? current.statusChangedAt : now,
  }
}

/** Browser goal-bar mutation. Usage counters stay on the previous snapshot. */
export function nextUserGoal(
  current: GoalStateSnapshot | null,
  sessionId: string,
  action: 'set' | 'pause' | 'resume' | 'clear',
  objective: string | undefined,
): GoalStateSnapshot | 'noop' | 'rejected' {
  const clean = typeof objective === 'string' ? objective.trim() : ''
  if (clean.length > USER_GOAL_OBJECTIVE_MAX) return 'rejected'
  const text = action === 'set' ? clean : current?.objective || clean
  if (action !== 'clear' && !text) return 'rejected'
  if (isUserGoalNoop(current, action, text)) return 'noop'
  const status = action === 'clear' ? 'cleared' : action === 'pause' ? 'paused' : 'active'
  return buildGoalSnapshot(current, sessionId, text, status)
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

function parseVerdictEvidenceBlock(part: string): ParsedVerdict['evidence'][number] | null {
  const nameMatch = /^### Check:\s*(.+?)(?:\n|$)/.exec(part)
  if (!nameMatch) return null
  const checkName = nameMatch[1]!.trim()
  const allResults = [...part.matchAll(/^\*\*Result:\s*(PASS|FAIL)\*\*/gm)]
  const lastResult = allResults.length > 0 ? allResults[allResults.length - 1] : undefined
  const passed = lastResult ? lastResult[1] === 'PASS' : false
  const endIdx = lastResult?.index
  const slice = endIdx !== undefined ? part.slice(nameMatch[0].length, endIdx) : part.slice(nameMatch[0].length)
  const detail = slice.trim().slice(0, 500) || undefined
  return { check: checkName, passed, detail }
}

export function parseVerificationVerdict(text: string): ParsedVerdict | null {
  const cleaned = stripCodeFences(text)
  const verdictMatch = VERDICT_RE.exec(cleaned)
  if (!verdictMatch) return null
  const verdict = verdictMatch[1] as ParsedVerdict['verdict']
  const evidence: ParsedVerdict['evidence'] = []
  for (const part of cleaned.split(/(?=^### Check:)/m)) {
    const item = parseVerdictEvidenceBlock(part)
    if (item) evidence.push(item)
  }
  return { verdict, passed: verdict === 'PASS', evidence }
}
