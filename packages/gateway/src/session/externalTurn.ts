/**
 * External (platform-executed) turn locking and persistence helpers
 * extracted from `sessionSubmit.ts`.
 */
import { indexTurn, reserveTurnIndex } from '@openclaude/storage'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import { deriveLosslessTurnKey } from '../v3MasterSink.js'
import {
  RuntimeRecycleDrainingError,
  activeGoalAttribution,
  assertPromptQueueExecutionAdmission,
  scheduleSessionOutputAssetCollection,
} from './sessionUtils.js'
import type {
  PromptQueueExecutionFence,
  PromptQueueExternalTurnReservation,
} from './types.js'

export interface ExternalTurnDeps {
  getResumeMapId: (sessionKey: string) => string | undefined
  trackPersistence: (p: Promise<unknown>) => void
  persistServerAuthoredTurn: (args: {
    sessionKey: string
    peerId: string
    agentId: string
    userId: string | undefined
    turnIndex: number
    goalId?: string
    goalStateRevision?: number
    turnKey: string
    text: string
    status: 'completed'
    requestId: string
    usage: { turn: number; model?: string; traceId?: string }
  }) => Promise<boolean>
  forgetResumeEntry: (sessionKey: string) => void
  saveResumeMap: () => void
  isRuntimeRecycleDraining: () => boolean
  ownsPromptQueueExecutionFence: (
    sessionKey: string,
    fence: PromptQueueExecutionFence | undefined,
  ) => boolean
  beginClientTurn: (session: AgentSession) => void
  endClientTurn: (session: AgentSession, outcome: 'completed' | 'errored') => void
  hasQueueExecutionSession: (session: AgentSession) => boolean
  hasQueueExecutionKey: (sessionKey: string) => boolean
  hasDispatchFenceKey: (sessionKey: string) => boolean
  addQueueExecution: (session: AgentSession) => void
  deleteQueueExecution: (session: AgentSession) => void
}

async function resolveExternalTurnReservation(
  session: AgentSession,
  assistantText: string,
  reservation: PromptQueueExternalTurnReservation | undefined,
  getResumeMapId: (sessionKey: string) => string | undefined,
): Promise<{ turnIndex: number; turnKey: string }> {
  if (reservation) {
    const expectedTurnKey = deriveLosslessTurnKey({
      sessionId: session.peerId,
      agentId: session.agentId,
      turnIndex: reservation.turnIndex,
      status: 'completed',
      text: '',
    })
    if (reservation.turnKey !== expectedTurnKey) {
      throw new Error('prompt queue external turn reservation does not match session identity')
    }
    return { turnIndex: reservation.turnIndex, turnKey: reservation.turnKey }
  }
  const legacyId = getResumeMapId(session.sessionKey)
  const turnIndex = await reserveTurnIndex(session.sessionKey, {
    minimumLastTurn: session.turns,
    legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
  })
  const turnKey = deriveLosslessTurnKey({
    sessionId: session.peerId,
    agentId: session.agentId,
    turnIndex,
    status: 'completed',
    text: assistantText,
  })
  return { turnIndex, turnKey }
}

export async function recordExternalTurnFlow(
  deps: ExternalTurnDeps,
  session: AgentSession,
  args: {
    userText: string
    assistantText: string
    requestId: string
    traceId?: string
    model?: string
    chatProjectId?: string | null
  },
  reservation?: PromptQueueExternalTurnReservation,
): Promise<{ turnIndex: number; messageId: string }> {
  const { turnIndex, turnKey } = await resolveExternalTurnReservation(
    session,
    args.assistantText,
    reservation,
    deps.getResumeMapId,
  )
  session.turns = turnIndex
  session.currentUserText = args.userText
  session.currentAssistantBuf = args.assistantText
  session.lastUsedAt = Date.now()
  void indexTurn(session.sessionKey, turnIndex, args.userText, args.assistantText).catch((err) =>
    log.warn('external turn index failed', { sessionKey: session.sessionKey, turnIndex }, err),
  )
  const persistence = deps.persistServerAuthoredTurn({
    sessionKey: session.sessionKey,
    peerId: session.peerId,
    agentId: session.agentId,
    userId: session.userId,
    turnIndex,
    ...activeGoalAttribution(session),
    turnKey,
    text: args.assistantText,
    status: 'completed',
    requestId: args.requestId,
    usage: {
      turn: turnIndex,
      ...(args.model ? { model: args.model } : {}),
      ...(args.traceId ? { traceId: args.traceId } : {}),
    },
  })
  deps.trackPersistence(persistence)
  scheduleSessionOutputAssetCollection({
    userId: session.userId,
    ...(Object.prototype.hasOwnProperty.call(args, 'chatProjectId')
      ? { chatProjectId: args.chatProjectId }
      : {}),
    sessionId: session.peerId,
    assistantText: args.assistantText,
    sessionKey: session.sessionKey,
    traceId: args.traceId,
  })
  const messageId = `srv-${session.peerId}-${session.agentId}-t${turnIndex}`
  const createdAt = Date.now()
  ;(session._pendingExternalExchanges ??= []).push({
    user: {
      id: `external-${args.requestId}-user`,
      role: 'user',
      text: args.userText,
      status: 'completed',
      ts: createdAt - 1,
    },
    assistant: {
      id: messageId,
      role: 'assistant',
      text: args.assistantText,
      status: 'completed',
      ts: createdAt,
    },
  })
  if (!(await persistence)) {
    throw new Error('external turn is durably queued but master has not acknowledged it')
  }
  deps.forgetResumeEntry(session.sessionKey)
  session.ccbSessionId = null
  session.runner.clearSessionId?.()
  deps.saveResumeMap()
  if (session.runner.isRunning) await session.runner.shutdown()
  session._historicalContextInjected = false
  session._historicalContextInjectedKey = undefined
  return { turnIndex, messageId }
}

export async function beginExternalTurnFlow(
  deps: ExternalTurnDeps,
  session: AgentSession,
  opts?: {
    queueTurn?: boolean
    queueExecutionFence?: PromptQueueExecutionFence
    clientMessageId?: string
  },
): Promise<{ signal: AbortSignal; finish: (outcome: 'completed' | 'errored') => void }> {
  if (deps.isRuntimeRecycleDraining()) throw new RuntimeRecycleDrainingError()
  const queueTurn = opts?.queueTurn === true
  const ownsDispatchFence = deps.ownsPromptQueueExecutionFence(
    session.sessionKey,
    opts?.queueExecutionFence,
  )
  if (opts?.queueExecutionFence && !ownsDispatchFence) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: stale queue execution fence')
  }
  const prev = session.lock
  let release: () => void = () => {}
  deps.beginClientTurn(session)
  try {
    assertPromptQueueExecutionAdmission(
      queueTurn,
      session._activeTurnCount ?? 0,
      session._activeClientTurnCount ?? 0,
      deps.hasQueueExecutionSession(session) ||
        deps.hasQueueExecutionKey(session.sessionKey) ||
        (deps.hasDispatchFenceKey(session.sessionKey) && !ownsDispatchFence),
    )
  } catch (err) {
    deps.endClientTurn(session, 'errored')
    throw err
  }
  if (queueTurn) deps.addQueueExecution(session)
  session.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new AbortController()
  try {
    await prev
  } catch (err) {
    deps.endClientTurn(session, 'errored')
    if (queueTurn) deps.deleteQueueExecution(session)
    release()
    throw err
  }
  session._externalTurnAbort = controller
  if (opts?.clientMessageId) session._runningClientMessageId = opts.clientMessageId
  let finished = false
  return {
    signal: controller.signal,
    finish: (outcome) => {
      if (finished) return
      finished = true
      if (session._externalTurnAbort === controller) session._externalTurnAbort = undefined
      if (session._runningClientMessageId === opts?.clientMessageId) {
        session._runningClientMessageId = undefined
      }
      session._currentTurnKey = undefined
      session._currentTurnIndex = undefined
      deps.endClientTurn(session, outcome)
      if (queueTurn) deps.deleteQueueExecution(session)
      release()
    },
  }
}
