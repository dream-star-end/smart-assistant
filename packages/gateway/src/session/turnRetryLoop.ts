/**
 * Logical turn reservation, inbox activation, and automatic retry loop
 * extracted from `runOneTurnWithRetry`.
 */
import { AUTOMATIC_TURN_RETRY_MAX, type GrokExecutionDescriptor } from '@openclaude/protocol'
import {
  getTurnDispatchByDispatchId,
  recordTurnDispatchRunning,
  reserveTurnIndex,
} from '@openclaude/storage'
import type { AutomaticRetryState, CollabAgentPolicy } from '../engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  SegmentRecord,
  SessionStreamEvent,
  TurnToolEntry,
} from '../engine/engineEvents.js'
import { contextRebuildsTotal } from '../metrics.js'
import { triggerLocalCatalogRefreshOnConfigChanged } from '../modelCatalogClient.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import type { TurnModelAuthority } from '../subprocessRunner.js'
import { deriveLosslessTurnKey } from '../v3MasterSink.js'
import { TRANSIENT_RETRY_INPUT, takeDurableEventOrdinal } from './sessionUtils.js'
import {
  SafeCcbContextRebuildRetryError,
  TRANSIENT_RETRY_ERROR_CODES,
  Upstream429RetryError,
  throwIfLogicalTurnCancelled,
  waitForRetryDelay,
} from './turnState.js'
import type { TurnQueueLifecycle, TurnUserInput } from './types.js'

export interface TurnRetryLoopDeps {
  getResumeMapId: (sessionKey: string) => string | undefined
  beginMemoryTurnTracking: (args: {
    sessionKey: string
    turnIndex: number
    agentId: string
    userText: string
  }) => Promise<void>
  failClosedOnRunningCasMiss: (args: {
    userId: string
    sessionId: string
    clientMessageId: string
    dispatchId: string
    cause: unknown
  }) => Promise<never>
  notifyDispatchRunningReceipt: (
    dispatchContext: NonNullable<AgentSession['_currentDispatch']>,
    runningRow: NonNullable<Awaited<ReturnType<typeof recordTurnDispatchRunning>>>,
  ) => void
  runOneTurn: (args: {
    session: AgentSession
    retryInput: TurnUserInput
    onEvent: (e: SessionStreamEvent) => void
    requestId?: string
    traceId?: string
    collabAgentPolicy?: CollabAgentPolicy
    assistantMessageId: string
    thinkingMessageId: string
    toolMessageIdFactory: (blockId: string) => string
    turnKey: string
    clientMessageId?: string
    modelAuthority?: TurnModelAuthority
    retryRuntimeEvents: DurableRuntimeEvent[]
    retryAssistantSegments: SegmentRecord[]
    retryThinkingSegments: SegmentRecord[]
    retryTools: TurnToolEntry[]
    retryStructuredBlocks: Array<Record<string, unknown>>
    queueTurn: boolean
    retryPhantomErrors: boolean
    retryTransientErrors: boolean
    attemptOrdinal: number
    retryState: AutomaticRetryState
    modelSwitchTransition?: AgentSession['_modelSwitchTransition']
    grokExecutionDescriptor?: GrokExecutionDescriptor
  }) => Promise<void>
  isExplicitRemoteOverflowError: (err: unknown) => boolean
  tryUniversalOverflowAutoCompact: (
    session: AgentSession,
    retryInput: TurnUserInput,
    onEvent: (e: SessionStreamEvent) => void,
  ) => Promise<TurnUserInput | null>
  isUniversalOverflowError: (msg: string, errorClass: string) => boolean
  classifyRunError: (msg: string) => { code: string }
  advanceTransientBreaker: (
    retryState: AutomaticRetryState,
    errorClass: string,
    threshold: number,
  ) => { open: boolean; consecutive: number }
  resolveTransientBreakerThreshold: () => number
  formatTransientCircuitOpenError: (errorClass: string, consecutive: number) => string
  transientRetryDelayMs: (attempt: number) => number
}

async function activateTurnDispatchInbox(args: {
  session: AgentSession
  dispatchContext: NonNullable<AgentSession['_currentDispatch']>
  projectedTurnIndex: number
  turnKey: string
  requestId?: string
  deps: TurnRetryLoopDeps
}): Promise<boolean> {
  const { session, dispatchContext, projectedTurnIndex, turnKey, requestId, deps } = args
  let runningRow: Awaited<ReturnType<typeof recordTurnDispatchRunning>> = null
  let recordErr: unknown
  try {
    runningRow = await recordTurnDispatchRunning({
      userId: dispatchContext.userId,
      sessionId: dispatchContext.sessionId,
      clientMessageId: dispatchContext.clientMessageId,
      agentId: session.agentId,
      turnIndex: projectedTurnIndex,
      turnKey,
      requestId: typeof requestId === 'string' && requestId !== '' ? requestId : null,
      createdAt: Date.now(),
    })
  } catch (err) {
    recordErr = err
  }
  if (recordErr !== undefined || runningRow === null) {
    if (recordErr === undefined) {
      try {
        const current = await getTurnDispatchByDispatchId(
          dispatchContext.dispatchId,
          dispatchContext.attemptNo,
        )
        if (
          current?.state === 'rejected' &&
          current.userId === dispatchContext.userId &&
          current.sessionId === dispatchContext.sessionId &&
          current.clientMessageId === dispatchContext.clientMessageId &&
          current.dispatchId === dispatchContext.dispatchId &&
          current.attemptNo === dispatchContext.attemptNo
        ) {
          log.info('DISPATCH_QUEUED_CANCELLED_BEFORE_START', {
            dispatchId: current.dispatchId,
            attemptNo: current.attemptNo,
            state: current.state,
          })
          return false
        }
      } catch (err) {
        recordErr = err
      }
    }
    log.error(
      'turn dispatch running CAS unconfirmed — refusing model call (fail-closed)',
      {
        sessionKey: session.sessionKey,
        dispatchId: dispatchContext.dispatchId,
        recordMissed: runningRow === null,
      },
      recordErr instanceof Error ? recordErr : undefined,
    )
    await deps.failClosedOnRunningCasMiss({
      userId: dispatchContext.userId,
      sessionId: dispatchContext.sessionId,
      clientMessageId: dispatchContext.clientMessageId,
      dispatchId: dispatchContext.dispatchId,
      cause: recordErr,
    })
  }
  session._currentDispatch = dispatchContext
  if (runningRow) deps.notifyDispatchRunningReceipt(dispatchContext, runningRow)
  return true
}

async function reserveLogicalTurn(args: {
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  requestId?: string
  traceId?: string
  dispatchContext?: AgentSession['_currentDispatch']
  queueLifecycle?: TurnQueueLifecycle
  deps: TurnRetryLoopDeps
}): Promise<{
  projectedTurnIndex: number
  turnKey: string
  assistantMessageId: string
  thinkingMessageId: string
  toolMessageIdFactory: (blockId: string) => string
} | null> {
  const { session, userTextOrBlocks, requestId, traceId, dispatchContext, queueLifecycle, deps } = args
  const legacyId = deps.getResumeMapId(session.sessionKey)
  const projectedTurnIndex = await reserveTurnIndex(session.sessionKey, {
    minimumLastTurn: session.turns,
    legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
  })
  const memoryObservationText =
    typeof userTextOrBlocks === 'string'
      ? userTextOrBlocks
      : userTextOrBlocks.flatMap((block) => (typeof block.text === 'string' ? [block.text] : [])).join('\n')
  await deps
    .beginMemoryTurnTracking({
      sessionKey: session.sessionKey,
      turnIndex: projectedTurnIndex,
      agentId: session.agentId,
      userText: memoryObservationText,
    })
    .catch((err) =>
      log.warn('memory turn observation start failed', { sessionKey: session.sessionKey, turnIndex: projectedTurnIndex }, err),
    )
  session.turns = projectedTurnIndex - 1
  const turnKey = deriveLosslessTurnKey({
    sessionId: session.peerId,
    agentId: session.agentId,
    turnIndex: projectedTurnIndex,
    status: 'completed',
    text: '',
  })
  session._currentTurnKey = turnKey
  session._currentTurnIndex = projectedTurnIndex
  session._nextDurableEventOrdinal = 0
  if (dispatchContext) {
    const active = await activateTurnDispatchInbox({
      session, dispatchContext, projectedTurnIndex, turnKey, requestId, deps,
    })
    if (!active) return null
  }
  if (queueLifecycle) {
    await queueLifecycle.onTurnReserved({
      turnIndex: projectedTurnIndex,
      turnKey,
      ...(traceId ? { traceId } : {}),
    })
  }
  return {
    projectedTurnIndex,
    turnKey,
    assistantMessageId: `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}`,
    thinkingMessageId: `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-thinking`,
    toolMessageIdFactory: (blockId: string) =>
      `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-tool-${blockId}`,
  }
}

interface RetryLoopState {
  retryState: AutomaticRetryState
  phantomRetryUsed: boolean
  retryInput: TurnUserInput
  contextOverflowRetryIndex: number
  attemptOrdinal: number
  overflowAutoCompactAttempted: boolean
  retryRuntimeEvents: DurableRuntimeEvent[]
  retryAssistantSegments: SegmentRecord[]
  retryThinkingSegments: SegmentRecord[]
  retryTools: TurnToolEntry[]
  retryStructuredBlocks: Array<Record<string, unknown>>
}

async function tryHandleImmediateRecoveryError(args: {
  err: unknown
  msg: string
  errorClass: string
  loop: RetryLoopState
  session: AgentSession
  onEvent: (e: SessionStreamEvent) => void
  traceId?: string
  logicalTurnSignal?: AbortSignal
  contextOverflowRetryInputs: string[]
  deps: TurnRetryLoopDeps
  canRetry: () => boolean
  emitRetryStatus: (code: string, delayMs?: number) => boolean
  clearRetryStatus: () => void
}): Promise<'continue' | 'return' | null> {
  const { err, msg, errorClass, loop, session, onEvent, traceId, logicalTurnSignal, contextOverflowRetryInputs, deps } = args
  if (/PHANTOM_TURN/i.test(msg)) {
    log.warn('phantom turn detected, restarting subprocess', {
      sessionKey: session.sessionKey,
      phantomRetryUsed: loop.phantomRetryUsed,
      ...(traceId ? { traceId } : {}),
    })
    await session.runner.shutdown()
    throwIfLogicalTurnCancelled(logicalTurnSignal)
    if (loop.phantomRetryUsed) return 'return'
    if (!args.canRetry()) throw err
    loop.phantomRetryUsed = true
    args.emitRetryStatus('PHANTOM_RETRY')
    args.clearRetryStatus()
    loop.attemptOrdinal += 1
    return 'continue'
  }
  if (
    errorClass === 'context_too_long' &&
    (session.providerTag === 'codex' || err instanceof SafeCcbContextRebuildRetryError) &&
    args.canRetry() &&
    loop.contextOverflowRetryIndex < contextOverflowRetryInputs.length
  ) {
    loop.contextOverflowRetryIndex += 1
    contextRebuildsTotal.inc({ reason: 'context_overflow_retry' })
    loop.retryInput = contextOverflowRetryInputs[loop.contextOverflowRetryIndex - 1]!
    log.warn('native context window exhausted; rebuilding with smaller history', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      attempt: loop.contextOverflowRetryIndex,
      maxRetries: loop.retryState.max,
      ...(traceId ? { traceId } : {}),
    })
    args.emitRetryStatus('CONTEXT_REBUILD_RETRY')
    args.clearRetryStatus()
    loop.attemptOrdinal += 1
    return 'continue'
  }
  if (!loop.overflowAutoCompactAttempted && deps.isUniversalOverflowError(msg, errorClass) && loop.retryAssistantSegments.length === 0) {
    loop.overflowAutoCompactAttempted = true
    const recovered = await deps.tryUniversalOverflowAutoCompact(session, loop.retryInput, onEvent)
    if (recovered) {
      loop.retryInput = recovered
      loop.attemptOrdinal += 1
      return 'continue'
    }
  }
  return null
}

async function handleTransientBackoffRetry(args: {
  err: unknown
  msg: string
  errorClass: string
  loop: RetryLoopState
  session: AgentSession
  traceId?: string
  logicalTurnSignal?: AbortSignal
  deps: TurnRetryLoopDeps
  canRetry: () => boolean
  emitRetryStatus: (code: string, delayMs?: number) => boolean
  clearRetryStatus: () => void
}): Promise<'continue'> {
  const { err, msg, errorClass, loop, session, traceId, logicalTurnSignal, deps } = args
  const isTransient =
    TRANSIENT_RETRY_ERROR_CODES.has(errorClass) ||
    (errorClass === 'unknown' && /AbortError|operation was aborted|timed?\s*out/i.test(msg))
  if (!isTransient || !args.canRetry()) throw err
  if (TRANSIENT_RETRY_ERROR_CODES.has(errorClass)) {
    const breaker = deps.advanceTransientBreaker(
      loop.retryState,
      errorClass,
      deps.resolveTransientBreakerThreshold(),
    )
    if (breaker.open && errorClass !== 'rate_limited') {
      log.warn('transient retry circuit open', {
        sessionKey: session.sessionKey, errorClass, consecutive: breaker.consecutive,
        attempt: loop.retryState.attempt, ...(traceId ? { traceId } : {}),
      })
      throw new Error(deps.formatTransientCircuitOpenError(errorClass, breaker.consecutive), { cause: err })
    }
  }
  const delay = Math.max(
    deps.transientRetryDelayMs(loop.retryState.attempt),
    errorClass === 'rate_limited' && err instanceof Upstream429RetryError
      ? Math.max(0, err.hint.retryNotBeforeMs - Date.now())
      : 0,
  )
  log.warn('transient error, retrying', {
    sessionKey: session.sessionKey, attempt: loop.retryState.attempt + 1,
    maxRetries: loop.retryState.max, delayS: Math.round(delay / 1000),
    error: msg, ...(traceId ? { traceId } : {}),
  })
  args.emitRetryStatus('TRANSIENT_RETRY', delay)
  loop.retryInput = TRANSIENT_RETRY_INPUT
  try {
    await waitForRetryDelay(delay, logicalTurnSignal)
  } finally {
    args.clearRetryStatus()
  }
  loop.attemptOrdinal += 1
  return 'continue'
}

async function handleRetryLoopError(args: {
  err: unknown
  loop: RetryLoopState
  session: AgentSession
  onEvent: (e: SessionStreamEvent) => void
  traceId?: string
  logicalTurnSignal?: AbortSignal
  contextOverflowRetryInputs: string[]
  deps: TurnRetryLoopDeps
  canRetry: () => boolean
  emitRetryStatus: (code: string, delayMs?: number) => boolean
  clearRetryStatus: () => void
}): Promise<'continue' | 'return'> {
  const { err, loop, session, onEvent, logicalTurnSignal, deps } = args
  throwIfLogicalTurnCancelled(logicalTurnSignal)
  const msg = err instanceof Error ? err.message : String(err)
  const isExplicitRemoteOverflow = deps.isExplicitRemoteOverflowError(err)
  if (session.runner.executionBackend && !isExplicitRemoteOverflow) throw err
  if (isExplicitRemoteOverflow && !loop.overflowAutoCompactAttempted && loop.retryAssistantSegments.length === 0) {
    loop.overflowAutoCompactAttempted = true
    const recovered = await deps.tryUniversalOverflowAutoCompact(session, loop.retryInput, onEvent)
    if (recovered) {
      loop.retryInput = recovered
      loop.attemptOrdinal += 1
      return 'continue'
    }
    if (session.runner.executionBackend) throw err
  }
  if (/AUTH_ERROR/i.test(msg)) throw err
  const errorClass = deps.classifyRunError(msg).code
  if (errorClass === 'model_config_changed_retry_turn') {
    triggerLocalCatalogRefreshOnConfigChanged('session_turn_throw')
  }
  const immediate = await tryHandleImmediateRecoveryError({ ...args, msg, errorClass })
  if (immediate !== null) return immediate
  return handleTransientBackoffRetry({ ...args, msg, errorClass })
}

export async function executeTurnWithRetryLoop(args: {
  deps: TurnRetryLoopDeps
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  onEvent: (e: SessionStreamEvent) => void
  requestId?: string
  traceId?: string
  collabAgentPolicy?: CollabAgentPolicy
  modelAuthority?: TurnModelAuthority
  clientMessageId?: string
  dispatchContext?: AgentSession['_currentDispatch']
  queueLifecycle?: TurnQueueLifecycle
  logicalTurnSignal?: AbortSignal
  contextOverflowRetryInputs: string[]
  automaticRetryState?: AutomaticRetryState
  modelSwitchTransition?: AgentSession['_modelSwitchTransition']
  grokExecutionDescriptor?: GrokExecutionDescriptor
}): Promise<void> {
  const { deps, session, onEvent, requestId, traceId, logicalTurnSignal } = args
  const reserved = await reserveLogicalTurn({
    session, userTextOrBlocks: args.userTextOrBlocks, requestId, traceId,
    dispatchContext: args.dispatchContext, queueLifecycle: args.queueLifecycle, deps,
  })
  if (!reserved) return
  const loop: RetryLoopState = {
    retryState: args.automaticRetryState ?? {
      rootClientMessageId: args.clientMessageId ?? session.sessionKey,
      attempt: 0,
      max: AUTOMATIC_TURN_RETRY_MAX,
    },
    phantomRetryUsed: false,
    retryInput: args.userTextOrBlocks,
    contextOverflowRetryIndex: 0,
    attemptOrdinal: 0,
    overflowAutoCompactAttempted: false,
    retryRuntimeEvents: [],
    retryAssistantSegments: [],
    retryThinkingSegments: [],
    retryTools: [],
    retryStructuredBlocks: [],
  }
  const canRetry = (): boolean => !session.runner.executionBackend && loop.retryState.attempt < loop.retryState.max
  const emitRetryStatus = (code: string, delayMs = 0): boolean => {
    if (!canRetry()) return false
    loop.retryState.attempt += 1
    loop.retryRuntimeEvents.push({
      ordinal: takeDurableEventOrdinal(session),
      observedAt: Date.now(),
      source: 'gateway',
      payload: {
        type: 'retry_status',
        code,
        rootClientMessageId: loop.retryState.rootClientMessageId,
        attempt: loop.retryState.attempt,
        max: loop.retryState.max,
      },
    })
    onEvent({
      kind: 'turn_status',
      status: {
        status: 'retrying',
        retry: { attempt: loop.retryState.attempt, max: loop.retryState.max, delayMs, retryAt: Date.now() + delayMs },
      },
    })
    return true
  }
  const clearRetryStatus = (): void => onEvent({ kind: 'turn_status', status: null })
  for (;;) {
    throwIfLogicalTurnCancelled(logicalTurnSignal)
    try {
      await deps.runOneTurn({
        session, retryInput: loop.retryInput, onEvent, requestId, traceId,
        collabAgentPolicy: args.collabAgentPolicy, assistantMessageId: reserved.assistantMessageId,
        thinkingMessageId: reserved.thinkingMessageId, toolMessageIdFactory: reserved.toolMessageIdFactory,
        turnKey: reserved.turnKey, clientMessageId: args.clientMessageId, modelAuthority: args.modelAuthority,
        retryRuntimeEvents: loop.retryRuntimeEvents, retryAssistantSegments: loop.retryAssistantSegments,
        retryThinkingSegments: loop.retryThinkingSegments, retryTools: loop.retryTools,
        retryStructuredBlocks: loop.retryStructuredBlocks, queueTurn: args.queueLifecycle?.queueTurn === true,
        retryPhantomErrors: !loop.phantomRetryUsed, retryTransientErrors: canRetry(),
        attemptOrdinal: loop.attemptOrdinal, retryState: loop.retryState,
        modelSwitchTransition: args.modelSwitchTransition, grokExecutionDescriptor: args.grokExecutionDescriptor,
      })
      return
    } catch (err: unknown) {
      const action = await handleRetryLoopError({
        err, loop, session, onEvent, traceId, logicalTurnSignal,
        contextOverflowRetryInputs: args.contextOverflowRetryInputs,
        deps, canRetry, emitRetryStatus, clearRetryStatus,
      })
      if (action === 'return') return
    }
  }
}
