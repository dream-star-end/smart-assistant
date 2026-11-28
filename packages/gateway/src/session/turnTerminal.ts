/**
 * Terminal snapshot persistence, cooperative interrupt escalation,
 * runner error/exit handlers, and billing flush for a turn attempt.
 * Preserves exact re-entrant shutdown and bounded stdout drain contracts.
 */
import type { TurnWaiveReason } from '@openclaude/protocol'
import { log } from '../sessionManagerLog.js'
import { getV3MasterSinkOrNull } from '../v3MasterSink.js'
import {
  SESSION_PERSIST_QUEUED_NOTICE,
  activeGoalAttribution,
  scheduleSessionOutputAssetCollection,
  takeDurableEventOrdinal,
} from './sessionUtils.js'
import {
  MASTER_SINK_PERSIST_CHANNELS,
  combineRetryAssistantOutput,
  freezeSegmentsWithCallUsage,
  freezeStructuredBlocksWithCallUsage,
  freezeToolsWithCallUsage,
  terminalUsageForPersistence,
  type TurnAttemptParams,
  type TurnAttemptState,
  type TurnRunnerDeps,
} from './turnState.js'

export function flushTerminalBilling(state: TurnAttemptState, params: TurnAttemptParams): void {
  if ((!state.terminalEngineBilling && !state.terminalExternalBilling) || state.terminalBillingFlushed) {
    return
  }
  state.terminalBillingFlushed = true
  if (state.terminalEngineBilling) {
    const billing = structuredClone(state.terminalEngineBilling)
    params.session._durableDelegateEngineBillings?.push(structuredClone(billing))
    params.onEvent({ kind: 'codex_billing', ...billing })
  }
  if (state.terminalExternalBilling) {
    params.onEvent({
      kind: 'external_billing',
      ...structuredClone(state.terminalExternalBilling),
    })
  }
}

export function retainTerminalError(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  status: 'interrupted' | 'crashed',
  reason: string,
  errorCode: string,
): void {
  state.lastRetainedTerminalError = { status, reason, errorCode }
  const identity = `${status}\0${errorCode}\0${reason}`
  if (state.retainedTerminalErrors.has(identity)) return
  state.retainedTerminalErrors.add(identity)
  params.retryRuntimeEvents.push({
    ordinal: takeDurableEventOrdinal(params.session),
    observedAt: Date.now(),
    source: 'gateway',
    payload: { type: 'terminal_error', status, code: errorCode, detail: reason },
  })
}

function collectPartialTurnArtifacts(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  status: 'interrupted' | 'crashed',
  reason: string,
  errorCode: string,
) {
  const { session, turnKey } = params
  const snap = state.turn?.getPartialSnapshot() ?? {
    assistantText: '',
    thinkingText: '',
    completedTools: [],
    assistantSegments: [],
    thinkingSegments: [],
    runtimeEvents: [],
  }
  const partialAgentGroups = deps.drainPendingAgentGroups(session, turnKey)
  retainTerminalError(state, params, status, reason, errorCode)
  const terminalRuntimeEvents = [
    ...params.retryRuntimeEvents.map((event) => structuredClone(event)),
    ...snap.runtimeEvents,
  ]
  const partialAssistant = combineRetryAssistantOutput(
    params.retryAssistantSegments,
    snap.assistantText,
    freezeSegmentsWithCallUsage(snap.assistantSegments, params.assistantMessageId, state.callUsageByTarget),
    Date.now(),
  )
  const partialThinking = combineRetryAssistantOutput(
    params.retryThinkingSegments,
    snap.thinkingText,
    freezeSegmentsWithCallUsage(snap.thinkingSegments, params.thinkingMessageId, state.callUsageByTarget),
    Date.now(),
  )
  const partialTools = [
    ...params.retryTools.map((tool) => structuredClone(tool)),
    ...freezeToolsWithCallUsage(snap.completedTools, state.callUsageByTarget),
  ]
  const partialStructuredBlocks = [
    ...params.retryStructuredBlocks.map((block) => structuredClone(block)),
    ...freezeStructuredBlocksWithCallUsage(state.structuredBlocks, state.callUsageByTarget),
  ]
  if (session._durableDelegateRuntimeEvents) {
    session._durableDelegateRuntimeEvents.push(
      ...terminalRuntimeEvents.map((event) => structuredClone(event)),
    )
  }
  return {
    partialAgentGroups,
    terminalRuntimeEvents,
    partialAssistant,
    partialThinking,
    partialTools,
    partialStructuredBlocks,
  }
}

async function persistPartialSnapshotPayload(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  status: 'interrupted' | 'crashed'
  reason: string
  errorCode: string
  waiveReason?: TurnWaiveReason
}): Promise<{ persistenceAcknowledged: boolean; persistenceQueuedToOutbox: boolean }> {
  const { state, params, deps, status, reason, errorCode, waiveReason } = args
  const { session, turnKey, clientMessageId, requestId, traceId, prevTurns } = params
  const artifacts = collectPartialTurnArtifacts(state, params, deps, status, reason, errorCode)
  if (!MASTER_SINK_PERSIST_CHANNELS.has(session.channel)) {
    return { persistenceAcknowledged: true, persistenceQueuedToOutbox: false }
  }
  const turnIndex = prevTurns + 1
  session.turns = Math.max(session.turns, turnIndex)
  scheduleSessionOutputAssetCollection({
    userId: session.userId,
    chatProjectId: session.turnChatProjectId,
    sessionId: session.peerId,
    assistantText: artifacts.partialAssistant.text,
    sessionKey: session.sessionKey,
    ...(traceId ? { traceId } : {}),
  })
  const partialOutcome = await deps.persistServerAuthoredTurnOutcome({
    sessionKey: session.sessionKey,
    peerId: session.peerId,
    agentId: session.agentId,
    userId: session.userId,
    turnIndex,
    ...activeGoalAttribution(session),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(turnKey ? { turnKey } : {}),
    ...(waiveReason ? { waiveReason } : {}),
    ...(session._currentDispatch ? { dispatch: session._currentDispatch } : {}),
    text: artifacts.partialAssistant.text,
    ...(artifacts.partialThinking.text.length > 0 ? { thinkingText: artifacts.partialThinking.text } : {}),
    status,
    errorCode,
    errorDetail: reason,
    usage: terminalUsageForPersistence({
      finalMeta: state.observedFinalMeta,
      billing: state.terminalEngineBilling,
      traceId,
      turnIndex,
      model: session.model,
    }),
    ...(requestId ? { requestId } : {}),
    ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
    ...(artifacts.partialTools.length > 0 ? { tools: artifacts.partialTools } : {}),
    ...(artifacts.partialAssistant.segments.length > 0
      ? { assistantSegments: artifacts.partialAssistant.segments }
      : {}),
    ...(artifacts.partialThinking.segments.length > 0
      ? { thinkingSegments: artifacts.partialThinking.segments }
      : {}),
    ...(artifacts.partialAgentGroups.length > 0 ? { agentGroups: artifacts.partialAgentGroups } : {}),
    ...(artifacts.partialStructuredBlocks.length > 0
      ? { structuredBlocks: artifacts.partialStructuredBlocks }
      : {}),
    runtimeEvents: artifacts.terminalRuntimeEvents,
    ...(state.terminalEngineBilling !== undefined ? { engineBilling: state.terminalEngineBilling } : {}),
  })
  if (turnKey) deps.settleDrainedOwnerGroups(session, turnKey, artifacts.partialAgentGroups, partialOutcome)
  return {
    persistenceAcknowledged: partialOutcome === 'acked' || partialOutcome === 'skipped',
    persistenceQueuedToOutbox: getV3MasterSinkOrNull() === null && partialOutcome === 'queued',
  }
}

export function persistTerminalSnapshotFlow(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  status: 'interrupted' | 'crashed'
  reason: string
  errorCode: string
  settleAfter?: boolean
  waiveReason?: TurnWaiveReason
}): Promise<void> {
  const { state, params, deps, status, reason, errorCode, waiveReason } = args
  const settleAfter = args.settleAfter ?? true
  if (state.terminalPersistenceClaim !== 'none') {
    return state.partialPersistencePromise ?? Promise.resolve()
  }
  state.terminalPersistenceClaim = 'partial'
  const promise = (async () => {
    let persistenceAcknowledged = !MASTER_SINK_PERSIST_CHANNELS.has(params.session.channel)
    let persistenceQueuedToOutbox = false
    state.detach()
    if (
      params.modelSwitchTransition &&
      params.session._modelSwitchTransition === params.modelSwitchTransition
    ) {
      params.modelSwitchTransition.state = 'prepared'
      params.modelSwitchTransition.summaryInjected = false
    }
    if (
      status === 'interrupted' &&
      errorCode === 'USER_CANCELLED' &&
      state.terminalEngineBilling?.status === 'error'
    ) {
      state.terminalEngineBilling = {
        ...state.terminalEngineBilling,
        terminalCode: 'USER_CANCELLED',
      }
    }
    flushTerminalBilling(state, params)
    try {
      const result = await persistPartialSnapshotPayload({
        state, params, deps, status, reason, errorCode, waiveReason,
      })
      persistenceAcknowledged = result.persistenceAcknowledged
      persistenceQueuedToOutbox = result.persistenceQueuedToOutbox
    } finally {
      const usageForLog = terminalUsageForPersistence({
        finalMeta: state.observedFinalMeta,
        billing: state.terminalEngineBilling,
        traceId: params.traceId,
        turnIndex: params.prevTurns + 1,
        model: params.session.model,
      })
      deps.recordTurnUsage(
        deps.mapTurnTerminalStatus({ persistStatus: status, errorCode }),
        {
          inputTokens: usageForLog.inputTokens,
          outputTokens: usageForLog.outputTokens,
          cacheReadTokens: usageForLog.cacheReadTokens,
          cacheCreationTokens: usageForLog.cacheCreationTokens,
          model: params.session.model,
        },
        params.prevTurns + 1,
      )
      if (persistenceAcknowledged) {
        const wireCode = deps.wireTerminalCodeForTape(errorCode)
        params.onEvent(
          deps.toEngineErrorEvent({
            kind: 'error',
            error: reason,
            ...(wireCode ? { errorCode: wireCode } : {}),
          }),
        )
      } else if (persistenceQueuedToOutbox) {
        log.warn('partial terminal delivered in degraded persist-queued mode', {
          sessionKey: params.session.sessionKey,
          errorCode,
          ...(params.traceId ? { traceId: params.traceId } : {}),
        })
        params.onEvent(
          deps.toEngineErrorEvent({
            kind: 'error',
            error: reason || SESSION_PERSIST_QUEUED_NOTICE,
            errorCode: 'session_persist_unavailable',
          }),
        )
      }
      if (settleAfter) state.resolveAttempt()
    }
  })()
  state.partialPersistencePromise = promise
  deps.trackPersistence(promise)
  return promise
}

async function settleAfterSummaryOrFallback(
  state: TurnAttemptState,
  status: 'interrupted' | 'crashed',
  reason: string,
  errorCode: string,
  waiveReason?: TurnWaiveReason,
): Promise<void> {
  await state.finalizationDone
  await state.partialPersistencePromise
  if (state.terminalPersistenceClaim === 'none') {
    await state.persistTerminalSnapshot(status, reason, errorCode, true, waiveReason)
  }
}

export function requestTerminalPersistenceFlow(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  status: 'interrupted' | 'crashed'
  reason: string
  errorCode: string
  waiveReason?: TurnWaiveReason
}): Promise<void> {
  const { state, params, deps, status, reason, errorCode, waiveReason } = args
  state.closeHelpAttempt?.()
  state.requestedTerminal ??= {
    status,
    reason,
    errorCode,
    ...(waiveReason ? { waiveReason } : {}),
  }
  retainTerminalError(state, params, status, reason, errorCode)
  if (state.terminalRequestPromise) return state.terminalRequestPromise
  const runner = params.session.runner
  state.terminalRequestPromise = (async () => {
    if (!state.turn) {
      await Promise.resolve()
      if (!state.turn) {
        await state.persistTerminalSnapshot(status, reason, errorCode, true, waiveReason)
        return
      }
    }
    try {
      runner.interrupt(
        status === 'interrupted' && errorCode === 'USER_CANCELLED' ? 'user' : 'system',
      )
    } catch (interruptErr) {
      log.debug('cooperative runner.interrupt failed', {
        sessionKey: params.session.sessionKey,
        err: String(interruptErr),
      })
    }
    const targetTurn = state.turn
    let summaryFinished = false
    let timerHandle: NodeJS.Timeout | null = null
    await Promise.race([
      targetTurn.summary.then(() => {
        summaryFinished = true
      }),
      new Promise<void>((resolveWait) => {
        timerHandle = setTimeout(resolveWait, deps.terminalRequestGraceMs())
      }),
    ])
    if (timerHandle) clearTimeout(timerHandle)
    if (summaryFinished) {
      await settleAfterSummaryOrFallback(state, status, reason, errorCode, waiveReason)
      return
    }
    if (status === 'interrupted' && errorCode === 'USER_CANCELLED') {
      state.terminalRequestEscalated = true
    }
    try {
      await runner.shutdown()
    } catch (err) {
      retainTerminalError(state, params, 'crashed', `runner shutdown failed: ${String(err)}`, 'RUNNER_SHUTDOWN_FAILED')
    }
    await deps.awaitBoundedOutputDrain(runner, params.session)
    await Promise.resolve()
    if (targetTurn.finalized) {
      await settleAfterSummaryOrFallback(state, status, reason, errorCode, waiveReason)
      return
    }
    await state.persistTerminalSnapshot(status, reason, errorCode, true, waiveReason)
  })()
  return state.terminalRequestPromise
}

export function handleRunnerErrorEvent(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  err: Error,
): void {
  const plannedAtError = deps.shouldClassifyExitAsServiceRestart(params.session, state.runnerExitInfo)
  retainTerminalError(
    state,
    params,
    plannedAtError ? 'interrupted' : 'crashed',
    err.message,
    plannedAtError ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
  )
  const persistence = (async () => {
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 200)
    })
    if (state.terminalPersistenceClaim !== 'none' || state.turn?.finalized) return
    const planned = deps.shouldClassifyExitAsServiceRestart(params.session, state.runnerExitInfo)
    await state.requestTerminalPersistence(
      planned ? 'interrupted' : 'crashed',
      err.message,
      planned ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
      planned ? 'no_response' : undefined,
    )
  })()
  deps.trackPersistence(persistence)
}

export function handleRunnerExitEvent(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  info: { code: number | null; signal: string | null; crashed: boolean },
): void {
  state.runnerExitInfo = { signal: info.signal, crashed: info.crashed }
  if (!info.crashed && info.code === 0 && info.signal == null) return
  const flushP = new Promise<void>((resolveFlush) => {
    setTimeout(() => {
      if (state.turn?.finalized || state.terminalPersistenceClaim !== 'none') {
        resolveFlush()
        return
      }
      const reason = info.signal
        ? `子进程被信号 ${info.signal} 终止`
        : info.code
          ? `子进程异常退出 (code ${info.code})`
          : '子进程意外退出'
      const planned = deps.shouldClassifyExitAsServiceRestart(params.session, info)
      const status: 'interrupted' | 'crashed' = planned || info.signal ? 'interrupted' : 'crashed'
      void state
        .persistTerminalSnapshot(
          status,
          reason,
          planned ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
          true,
          planned ? 'no_response' : undefined,
        )
        .finally(resolveFlush)
    }, 150)
  })
  deps.trackPersistence(flushP)
}
