/**
 * Session turn execution facade (one turn attempt + retry wrapper).
 * Delegates state/events/terminal/finalization/retry mechanics to `src/session/turn*.ts`.
 */
import { normalizeAssistantOutputUiFences } from './uiFenceNormalize.js'
import type { GrokExecutionDescriptor } from '@openclaude/protocol'
import { getSystemHelpRelay } from './systemHelpRelay.js'
import { refreshTurnModelAuthorityLease, RenewTurnLeaseError } from './masterTurnLease.js'
import { consumeUnusedPreheat } from './speculativePreheat.js'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '@openclaude/storage'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineTurnRun,
} from './engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { markCheckpointTurnOutcome } from './sessionCheckpointStore.js'
import {
  hasCompactableSessionHistory,
  isSafeUniversalOverflowSummary,
  isUniversalOverflowError,
  recordTurnContextWatermarkForAutoCompact,
  SafeUniversalOverflowRetryError,
  tryUniversalOverflowAutoCompact,
} from './sessionAutoCompact.js'
import type { SessionLifecycleHost } from './sessionLifecycle.js'
import { beginMemoryTurnTracking } from './memoryTurnObserver.js'
import {
  createTurnUsageRecorder,
  mapTurnTerminalStatus,
  type TurnTerminalStatus,
} from './turnUsage.js'
import {
  emptyCompletedTurnAssistantText,
  shouldFailClosedEmptyModelTurn,
} from './emptyCompletedTurn.js'
import { applyPlatformCostIfMissing } from './usageCost.js'
import { failClosedOnRunningCasMiss, notifyDispatchRunningReceipt } from './turnDispatchInbox.js'
import {
  resolveEffectiveModelHistoryContextWindow,
  type ContextBreakdown,
  type ContextPressure,
  type OutboundContentBlock,
} from '@openclaude/protocol'
import { summarizePromptSlotBreakdown } from './promptSlots.js'
import { classifyRunError } from './errorClassify.js'
import type { GatewayEngineErrorEvent } from './ccbMessageParser.js'
import type { TurnModelAuthority } from './subprocessRunner.js'
import { applyEfficiencyToolObservation } from './agentEfficiencyGuard.js'
import {
  advanceTransientBreaker,
  formatTransientCircuitOpenError,
  resolveTransientBreakerThreshold,
} from './transientRetryCircuit.js'
import {
  _tapeErrorCodeForGenericFailure,
  _wireTerminalCodeForTape,
  BOX_ACTIVE_TURN_IDLE_MS,
  BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS,
  pickTurnSilentBackstopMs,
  applyTurnIdleTimeoutTick,
  takeDurableEventOrdinal,
  persistServerAuthoredTurnOutcome,
} from './sessionManager.js'
import { log } from './sessionManagerLog.js'
import type { SessionManager, AgentSession } from './sessionManager.js'
import type { TurnQueueLifecycle, TurnUserInput } from './session/types.js'
import {
  createTurnAttemptState,
  waitForRetryDelay,
  type TurnAttemptParams,
  type TurnAttemptState,
  type TurnRunnerDeps,
} from './session/turnState.js'
import { createTurnEventHandlers, type TurnEventHandlers } from './session/turnEvents.js'
import {
  handleRunnerErrorEvent,
  handleRunnerExitEvent,
  persistTerminalSnapshotFlow,
  requestTerminalPersistenceFlow,
} from './session/turnTerminal.js'
import { finalizeTurnAttempt } from './session/turnFinalizer.js'
import { executeTurnWithRetryLoop, type TurnRetryLoopDeps } from './session/turnRetryLoop.js'

export { waitForRetryDelay }

export interface TurnRunnerHost {
  getByKey: SessionManager['getByKey']
  _awaitBoundedOutputDrain: SessionManager['_awaitBoundedOutputDrain']
  _dispatchPostTerminalRuntimeEvent: SessionManager['_dispatchPostTerminalRuntimeEvent']
  _forgetResumeEntry: SessionManager['_forgetResumeEntry']
  _markResumeRejectedFromError: SessionManager['_markResumeRejectedFromError']
  _resumeMap: SessionManager['_resumeMap']
  _resumeMapCostImprecise: SessionManager['_resumeMapCostImprecise']
  _resumeMapHistory: SessionManager['_resumeMapHistory']
  _resumeMapLastCost: SessionManager['_resumeMapLastCost']
  _resumeMapProvider: SessionManager['_resumeMapProvider']
  _resumeMapTimestamps: SessionManager['_resumeMapTimestamps']
  _runOneTurn: SessionManager['_runOneTurn']
  _saveResumeMap: SessionManager['_saveResumeMap']
  _settleDrainedOwnerGroups: SessionManager['_settleDrainedOwnerGroups']
  _takePreStartStop: SessionManager['_takePreStartStop']
  _terminalRequestGraceMs: SessionManager['_terminalRequestGraceMs']
  _trackPersistence: SessionManager['_trackPersistence']
  _transientRetryDelayMs: SessionManager['_transientRetryDelayMs']
  drainPendingAgentGroups: SessionManager['drainPendingAgentGroups']
  interrupt: SessionManager['interrupt']
  shouldClassifyExitAsServiceRestart: SessionManager['shouldClassifyExitAsServiceRestart']
}

function _asEngineErrorEvent(event: GatewayEngineErrorEvent): SessionStreamEvent {
  return event as unknown as SessionStreamEvent
}

const PROMPT_BASELINE_TTL_MS = 30_000
const promptBaselineCache = new Map<
  string,
  { at: number; systemBytes: number; memoryBytes: number; skillsBytes: number; projectBytes: number }
>()

function safeStatSize(filePath: string): number {
  try {
    const st = statSync(filePath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function readResidentPromptBreakdown(agentId: string): {
  systemBytes: number
  memoryBytes: number
  skillsBytes: number
  projectBytes: number
} {
  const now = Date.now()
  const cached = promptBaselineCache.get(agentId)
  if (cached && now - cached.at < PROMPT_BASELINE_TTL_MS) {
    return {
      systemBytes: cached.systemBytes,
      memoryBytes: cached.memoryBytes,
      skillsBytes: cached.skillsBytes,
      projectBytes: cached.projectBytes,
    }
  }
  let systemBytes = 0
  let memoryBytes = 0
  let skillsBytes = 0
  const projectBytes = 0
  try {
    const dir = paths.agentDir(agentId)
    systemBytes += safeStatSize(join(dir, 'SOUL.md'))
    systemBytes += safeStatSize(join(dir, 'IDENTITY.md'))
    systemBytes += safeStatSize(paths.sharedUserMd)
    memoryBytes += safeStatSize(join(dir, 'MEMORY.md'))
    try {
      const memDir = join(dir, 'memory')
      for (const entry of readdirSync(memDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          memoryBytes += safeStatSize(join(memDir, entry.name))
        }
      }
    } catch {
      /* memory dir may not exist */
    }
    try {
      for (const entry of readdirSync(paths.sharedSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const sz = safeStatSize(join(paths.sharedSkillsDir, entry.name, 'SKILL.md'))
        if (sz > 0) skillsBytes += Math.min(sz, 320)
      }
    } catch {
      /* skills dir may not exist */
    }
  } catch {
    /* fail-open */
  }
  promptBaselineCache.set(agentId, { at: now, systemBytes, memoryBytes, skillsBytes, projectBytes })
  return { systemBytes, memoryBytes, skillsBytes, projectBytes }
}

/** OCV5-840: Populate missing usedTokens / windowTokens / breakdown on ContextPressure. */
export function enrichContextPressure(
  pressure: ContextPressure,
  ctx: {
    agentId: string
    engine: string
    modelContextWindow?: number | null
    observedTokens?: number
    toolsBytes?: number
    appliedSlots?: readonly { name: string; bytes: number }[]
  },
): ContextPressure {
  const windowTokens =
    pressure.windowTokens ??
    resolveEffectiveModelHistoryContextWindow(ctx.modelContextWindow, ctx.engine)
  const usedTokens =
    pressure.usedTokens ??
    (typeof ctx.observedTokens === 'number' && ctx.observedTokens > 0
      ? Math.round(ctx.observedTokens)
      : pressure.dimension === 'tokens' && windowTokens > 0
        ? Math.round(pressure.usedRatio * windowTokens)
        : undefined)
  let breakdown: ContextBreakdown | undefined = pressure.breakdown
  if (!breakdown) {
    const resident = ctx.appliedSlots
      ? summarizePromptSlotBreakdown(ctx.appliedSlots)
      : readResidentPromptBreakdown(ctx.agentId)
    const toolsBytes = Math.max(0, Math.floor(ctx.toolsBytes ?? 0))
    const totalEstimatedBytes = usedTokens && usedTokens > 0 ? Math.round(usedTokens * 3.5) : 0
    const residentSum =
      resident.systemBytes + resident.memoryBytes + resident.skillsBytes + resident.projectBytes
    const historyBytes = Math.max(0, totalEstimatedBytes - residentSum - toolsBytes)
    breakdown = {
      systemBytes: resident.systemBytes,
      memoryBytes: resident.memoryBytes,
      skillsBytes: resident.skillsBytes,
      projectBytes: resident.projectBytes,
      historyBytes,
      toolsBytes,
    }
  }
  return {
    ...pressure,
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(windowTokens > 0 ? { windowTokens } : {}),
    ...(breakdown ? { breakdown } : {}),
  }
}

function buildTurnRunnerDeps(
  host: TurnRunnerHost,
  state: TurnAttemptState,
  params: TurnAttemptParams,
): TurnRunnerDeps {
  const turnUsage = createTurnUsageRecorder()
  const { session, prevTurns, turnStartTime, requestId } = params
  return {
    terminalRequestGraceMs: () => host._terminalRequestGraceMs,
    trackPersistence: (p) => host._trackPersistence(p),
    awaitBoundedOutputDrain: (runner, s) => host._awaitBoundedOutputDrain(runner, s),
    shouldClassifyExitAsServiceRestart: (s, info) => host.shouldClassifyExitAsServiceRestart(s, info),
    drainPendingAgentGroups: (s, tk) => host.drainPendingAgentGroups(s, tk),
    settleDrainedOwnerGroups: (s, tk, groups, outcome) =>
      host._settleDrainedOwnerGroups(s, tk, groups, outcome),
    markResumeRejectedFromError: (key, detail, liveId) =>
      host._markResumeRejectedFromError(key, detail, liveId),
    forgetResumeEntry: (key) => host._forgetResumeEntry(key),
    saveResumeMap: () => host._saveResumeMap(),
    persistServerAuthoredTurnOutcome: (args) =>
      persistServerAuthoredTurnOutcome(
        args as Parameters<typeof persistServerAuthoredTurnOutcome>[0],
      ),
    toEngineErrorEvent: _asEngineErrorEvent,
    wireTerminalCodeForTape: _wireTerminalCodeForTape,
    tapeErrorCodeForGenericFailure: _tapeErrorCodeForGenericFailure,
    classifyRunError,
    normalizeAssistantOutputUiFences,
    emptyCompletedTurnAssistantText,
    shouldFailClosedEmptyModelTurn,
    applyPlatformCostIfMissing,
    // Efficiency guard hook for `tool_use_detected` events
    applyEfficiencyToolObservation,
    enrichContextPressure,
    recordTurnContextWatermarkForAutoCompact,
    isSafeUniversalOverflowSummary,
    hasCompactableSessionHistory,
    createSafeUniversalOverflowRetryError: (msg, explicit) =>
      new SafeUniversalOverflowRetryError(msg, explicit),
    mapTurnTerminalStatus: (args) => mapTurnTerminalStatus(args),
    recordTurnUsage: (terminalStatus, usage, turnIndex = Math.max(session.turns, prevTurns + 1)) =>
      turnUsage.record({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        turnIndex,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadTokens: usage?.cacheReadTokens ?? 0,
          cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
          costUsd: usage?.costUsd ?? 0,
          model: usage?.model ?? session.model,
        },
        toolCalls: state.turnToolCallCount,
        durationMs: Date.now() - turnStartTime,
        terminalStatus: terminalStatus as TurnTerminalStatus,
        ...(requestId ? { requestId } : {}),
        ...(session._currentTurnTraceId ? { traceId: session._currentTurnTraceId } : {}),
      }),
  }
}

function submitEngineTurnAttempt(args: {
  host: TurnRunnerHost
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  events: TurnEventHandlers
  finalize: (result: TurnSummary | null, rejectedBeforeSubmit?: boolean) => Promise<void>
}): void {
  const { host, state, params, events, finalize } = args
  const { session } = params
  const onPostTerminalRuntimeEvent = (
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
  ): void => {
    const ownerTurnKey =
      session.channel === 'delegate' ? session._billingParentTurnKey : params.turnKey
    const ownerSessionId =
      session.channel === 'delegate' ? session._usageAttribution?.parentSessionId : session.peerId
    host._dispatchPostTerminalRuntimeEvent(session, event, block, {
      ownerTurnKey,
      ownerSessionId,
      turnIndex: params.prevTurns + 1,
      onEvent: params.onEvent,
    })
  }
  let submittedTurn: EngineTurnRun
  try {
    submittedTurn = session.runner.submitTurn({
      input: params.userTextOrBlocks,
      readOnly: session._turnReadOnly === true,
      serviceTier: session._turnServiceTier ?? null,
      ...(params.queueTurn ? { queueTurn: true } : {}),
      requestId: params.requestId,
      ...(params.turnKey ? { turnKey: params.turnKey } : {}),
      ...(params.modelAuthority !== undefined ? { modelAuthority: params.modelAuthority } : {}),
      ...(params.grokExecutionDescriptor !== undefined
        ? { grokExecutionDescriptor: params.grokExecutionDescriptor }
        : {}),
      traceId: params.traceId,
      assistantMessageId: params.assistantMessageId,
      thinkingMessageId: params.thinkingMessageId,
      toolMessageIdFactory: params.toolMessageIdFactory,
      nextDurableEventOrdinal: () => takeDurableEventOrdinal(session),
      onPostTerminalRuntimeEvent,
      collabAgentPolicy: params.collabAgentPolicy,
      ...(session._antigravitySwarmCompaction
        ? { antigravitySwarmCompaction: session._antigravitySwarmCompaction }
        : {}),
      ...(session._collabModeTurn === 'advisor' && session._advisorTurn && params.turnKey
        ? {
            consultTurn: {
              configVersion: session._advisorTurn.configVersion,
              turnIndex: params.prevTurns + 1,
            },
          }
        : {}),
      automaticRetryState: params.automaticRetryState,
      ...(session._usageAttribution ? { usageAttribution: session._usageAttribution } : {}),
      ...(session._turnCreditBudgetFen !== undefined
        ? { creditBudgetFen: session._turnCreditBudgetFen }
        : {}),
      onEvent: events.handleEngineEvent,
      sessionTotals: session,
      toolUseIdToName: session.toolUseIdToName,
    })
  } catch (error) {
    state.detach()
    state.rejectAttempt(error)
    return
  }
  consumeUnusedPreheat(host, session)
  state.turn = submittedTurn
  if (params.clientMessageId && host._takePreStartStop(session.peerId, params.clientMessageId)) {
    log.info('pre-start stop applied', {
      sessionKey: session.sessionKey,
      clientMessageId: params.clientMessageId,
    })
    host.interrupt(session.sessionKey, 'user')
  }
  submittedTurn.submitted.catch((err) => {
    state.closeHelpAttempt?.()
    const planned = host.shouldClassifyExitAsServiceRestart(session, state.runnerExitInfo)
    const reason = err instanceof Error ? err.message : String(err)
    const persistence = state.requestTerminalPersistence(
      planned ? 'interrupted' : 'crashed',
      reason,
      planned ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
      planned ? 'no_response' : undefined,
    )
    host._trackPersistence(persistence)
  })
  state.finalizationDone = submittedTurn.summary.then(finalize).catch((err) => {
    params.onEvent({ kind: 'error', error: String(err) })
    state.resolveAttempt()
  })
}

function dispatchOrRenewEngineTurn(args: {
  host: TurnRunnerHost
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  events: TurnEventHandlers
  finalize: (result: TurnSummary | null, rejectedBeforeSubmit?: boolean) => Promise<void>
}): void {
  const { state, params, finalize } = args
  const { session, attemptOrdinal, modelAuthority, turnKey } = params
  if (attemptOrdinal > 0 && modelAuthority && turnKey) {
    const renewalSignal = session._externalTurnAbort?.signal
    void refreshTurnModelAuthorityLease(turnKey, modelAuthority, { signal: renewalSignal })
      .then(() => {
        if (state.settled || state.detached || renewalSignal?.aborted) return
        submitEngineTurnAttempt(args)
      })
      .catch(async (error: unknown) => {
        if (state.settled || state.detached) return
        if (renewalSignal?.aborted) {
          state.detach()
          state.rejectAttempt(error)
          return
        }
        if (error instanceof RenewTurnLeaseError && !error.retryable) {
          state.finalizationDone = finalize(
            {
              usage: {
                cost: 0, inputTokens: 0, outputTokens: 0,
                cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
              },
              assistantText: '', thinkingText: '', assistantSegments: [], thinkingSegments: [],
              tools: [], runtimeEvents: [], stopReason: null, numTurns: null, isError: true,
              errorKind: 'model_authority', errorDetail: 'MODEL_AUTHORITY_EXPIRED', staleResumeId: false,
              phantomSignals: { apiState: 'unknown', skipReason: null },
            },
            true,
          ).catch((err) => {
            params.onEvent({ kind: 'error', error: String(err) })
            state.resolveAttempt()
          })
          await state.finalizationDone
          return
        }
        state.detach()
        state.rejectAttempt(error)
      })
  } else {
    submitEngineTurnAttempt(args)
  }
}

function wireAndRunAttempt(
  host: TurnRunnerHost,
  state: TurnAttemptState,
  params: TurnAttemptParams,
): void {
  const { session } = params
  const { runner } = session
  const deps = buildTurnRunnerDeps(host, state, params)
  const events = createTurnEventHandlers(state, params, deps)
  const idleTimeoutMs = pickTurnSilentBackstopMs(session.providerTag, session.model)
  state.idleTimer = setTimeout(() => {
    const fire = applyTurnIdleTimeoutTick({
      waitingForUserInput: runner.waitingForUserInput === true,
      finalized: state.turn?.finalized === true,
      refresh: () => state.idleTimer?.refresh(),
    })
    if (!fire) return
    const duration =
      idleTimeoutMs === BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
        ? '6 小时 15 分钟'
        : idleTimeoutMs === BOX_ACTIVE_TURN_IDLE_MS
          ? '4 小时 5 分钟'
          : '30 分钟'
    const reason = `任务 ${duration}没有新输出，已中断。本轮已自动免单，积分将原路退回；请重试。`
    host._trackPersistence(
      state.requestTerminalPersistence('interrupted', reason, 'IDLE_TIMEOUT', 'idle_timeout'),
    )
  }, idleTimeoutMs)
  const handleError = (err: Error) => handleRunnerErrorEvent(state, params, deps, err)
  const handleExit = (info: { code: number | null; signal: string | null; crashed: boolean }) =>
    handleRunnerExitEvent(state, params, deps, info)
  state.detach = () => {
    state.closeHelpAttempt?.()
    if (state.detached) return
    state.detached = true
    if (session._persistActiveTurn === state.requestTerminalPersistence) {
      session._persistActiveTurn = undefined
    }
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.turn?.end()
    runner.off('activity', events.handleActivity)
    runner.off('billing', events.handleBilling)
    runner.off('external_billing', events.handleExternalBilling)
    runner.off('error', handleError)
    runner.off('exit', handleExit)
    runner.off('parse_error', events.handleParseError)
    runner.off('spawn', events.handleSpawn)
    runner.off('model_progress', events.handleModelProgress)
    events.stopThinkingStatus(false)
  }
  state.persistTerminalSnapshot = (status, reason, errorCode, settleAfter = true, waiveReason) =>
    persistTerminalSnapshotFlow({ state, params, deps, status, reason, errorCode, settleAfter, waiveReason })
  state.requestTerminalPersistence = (status, reason, errorCode, waiveReason) =>
    requestTerminalPersistenceFlow({ state, params, deps, status, reason, errorCode, waiveReason })
  session._persistActiveTurn = state.requestTerminalPersistence
  runner.on('activity', events.handleActivity)
  runner.on('billing', events.handleBilling)
  runner.on('external_billing', events.handleExternalBilling)
  runner.on('error', handleError)
  runner.on('exit', handleExit)
  runner.on('parse_error', events.handleParseError)
  runner.on('spawn', events.handleSpawn)
  runner.on('model_progress', events.handleModelProgress)
  if (!runner.isRunning) events.emitStartupPhase('engine_starting')
  const capturedAbort = session._externalTurnAbort
  try {
    state.closeHelpAttempt = getSystemHelpRelay(host)?.openAttempt(
      session,
      session.sessionKey,
      () =>
        host.getByKey(session.sessionKey) === session &&
        session.runner === runner &&
        session._currentTurnKey === params.turnKey &&
        session._currentTurnTraceId === params.traceId &&
        session._externalTurnAbort === capturedAbort &&
        capturedAbort !== undefined &&
        !capturedAbort.signal.aborted &&
        !session._plannedTeardown &&
        !session._replacing &&
        !state.settled &&
        !state.detached &&
        state.requestedTerminal === null &&
        state.turn?.finalized !== true,
    )
  } catch {
    getSystemHelpRelay(host)?.endAttempt(session)
  }
  const finalize = (result: TurnSummary | null, rejectedBeforeSubmit = false) =>
    finalizeTurnAttempt(state, params, deps, result, rejectedBeforeSubmit)
  dispatchOrRenewEngineTurn({ host, state, params, deps, events, finalize })
}

export async function _runOneTurn(
  this: TurnRunnerHost,
  session: AgentSession,
  userTextOrBlocks: TurnUserInput,
  onEvent: (e: SessionStreamEvent) => void,
  requestId?: string,
  traceId?: string,
  collabAgentPolicy?: CollabAgentPolicy,
  assistantMessageId?: string,
  thinkingMessageId?: string,
  toolMessageIdFactory?: (blockId: string) => string,
  turnKey?: string,
  clientMessageId?: string,
  modelAuthority?: TurnModelAuthority,
  retryRuntimeEvents: DurableRuntimeEvent[] = [],
  retryAssistantSegments: SegmentRecord[] = [],
  retryThinkingSegments: SegmentRecord[] = [],
  retryTools: TurnToolEntry[] = [],
  retryStructuredBlocks: Array<Record<string, unknown>> = [],
  queueTurn = false,
  _retryAuthErrors = false,
  retryPhantomErrors = true,
  retryTransientErrors = false,
  attemptOrdinal = 0,
  automaticRetryState?: AutomaticRetryState,
  modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
  grokExecutionDescriptor?: GrokExecutionDescriptor,
): Promise<void> {
  markCheckpointTurnOutcome(session, 'failed')
  const params: TurnAttemptParams = {
    session, userTextOrBlocks, onEvent, requestId, traceId, collabAgentPolicy,
    assistantMessageId, thinkingMessageId, toolMessageIdFactory, turnKey, clientMessageId,
    modelAuthority, retryRuntimeEvents, retryAssistantSegments, retryThinkingSegments,
    retryTools, retryStructuredBlocks, queueTurn, retryPhantomErrors, retryTransientErrors,
    attemptOrdinal, automaticRetryState, modelSwitchTransition, grokExecutionDescriptor,
    prevCostUSD: session.totalCostUSD, prevTurns: session.turns,
    prevLastCcbCost: session._lastCcbCumulativeCost, turnStartTime: Date.now(),
  }
  let stateRef: TurnAttemptState | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const state = createTurnAttemptState(resolve, reject)
      stateRef = state
      wireAndRunAttempt(this, state, params)
    })
  } finally {
    stateRef?.closeHelpAttempt?.()
  }
}

export async function runOneTurnWithRetry(
  this: TurnRunnerHost,
  session: AgentSession,
  userTextOrBlocks: TurnUserInput,
  onEvent: (e: SessionStreamEvent) => void,
  requestId?: string,
  traceId?: string,
  collabAgentPolicy?: CollabAgentPolicy,
  modelAuthority?: TurnModelAuthority,
  clientMessageId?: string,
  dispatchContext?: AgentSession['_currentDispatch'],
  queueLifecycle?: TurnQueueLifecycle,
  logicalTurnSignal?: AbortSignal,
  contextOverflowRetryInputs: string[] = [],
  automaticRetryState?: AutomaticRetryState,
  modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
  grokExecutionDescriptor?: GrokExecutionDescriptor,
): Promise<void> {
  const deps: TurnRetryLoopDeps = {
    getResumeMapId: (key) => this._resumeMap.get(key),
    beginMemoryTurnTracking,
    failClosedOnRunningCasMiss,
    notifyDispatchRunningReceipt,
    runOneTurn: (a) =>
      this._runOneTurn(
        a.session, a.retryInput, a.onEvent, a.requestId, a.traceId, a.collabAgentPolicy,
        a.assistantMessageId, a.thinkingMessageId, a.toolMessageIdFactory, a.turnKey,
        a.clientMessageId, a.modelAuthority, a.retryRuntimeEvents, a.retryAssistantSegments,
        a.retryThinkingSegments, a.retryTools, a.retryStructuredBlocks, a.queueTurn,
        false, a.retryPhantomErrors, a.retryTransientErrors, a.attemptOrdinal,
        a.retryState, a.modelSwitchTransition, a.grokExecutionDescriptor,
      ),
    isExplicitRemoteOverflowError: (err) =>
      err instanceof SafeUniversalOverflowRetryError && err.explicitPreAdmissionRejection,
    tryUniversalOverflowAutoCompact: (s, retryInput, cb) =>
      tryUniversalOverflowAutoCompact(this as unknown as SessionLifecycleHost, s, retryInput, cb),
    isUniversalOverflowError,
    classifyRunError,
    advanceTransientBreaker,
    resolveTransientBreakerThreshold,
    formatTransientCircuitOpenError,
    transientRetryDelayMs: (attempt) => this._transientRetryDelayMs(attempt),
  }
  await executeTurnWithRetryLoop({
    deps, session, userTextOrBlocks, onEvent, requestId, traceId, collabAgentPolicy,
    modelAuthority, clientMessageId, dispatchContext, queueLifecycle, logicalTurnSignal,
    contextOverflowRetryInputs, automaticRetryState, modelSwitchTransition, grokExecutionDescriptor,
  })
}
