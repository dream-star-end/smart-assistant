/**
 * Completed turn persistence, FTS5 indexing, turn-level context pressure,
 * usage/cost recording, and verification verdict emission.
 * Split from `turnFinalizer.ts` to keep every module <= 750 lines and CC <= 20.
 */
import { resolveEffectiveModelHistoryContextWindow } from '@openclaude/protocol'
import { indexTurn, upsertSessionMeta } from '@openclaude/storage'
import type { GatewayTerminalErrorCode } from '../ccbMessageParser.js'
import type { DurableRuntimeEvent, SegmentRecord, TurnSummary, TurnToolEntry } from '../engine/engineEvents.js'
import { createEvent, eventBus } from '../eventBus.js'
import { log } from '../sessionManagerLog.js'
import { getV3MasterSinkOrNull } from '../v3MasterSink.js'
import {
  activeGoalAttribution,
  parseVerificationVerdict,
  scheduleSessionOutputAssetCollection,
} from './sessionUtils.js'
import {
  MASTER_SINK_PERSIST_CHANNELS,
  combineRetryAssistantOutput,
  freezeSegmentsWithCallUsage,
  freezeStructuredBlocksWithCallUsage,
  freezeToolsWithCallUsage,
  type RequestedTerminalInfo,
  type TurnAttemptParams,
  type TurnAttemptState,
  type TurnRunnerDeps,
} from './turnState.js'
import { flushTerminalBilling } from './turnTerminal.js'

function emitTurnLevelContextPressureIfNeeded(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
): void {
  const { session, modelAuthority, onEvent } = params
  if (state.emittedTurnPressure || session.channel !== 'webchat') return
  const turnCtxTokens =
    state.lastCallContextTokens > 0
      ? state.lastCallContextTokens
      : result.usage.inputTokens +
        result.usage.cacheReadTokens +
        result.usage.cacheCreationTokens
  const engineTag = session.providerTag || session.runner.engineId || 'unknown'
  const windowTokens = resolveEffectiveModelHistoryContextWindow(
    modelAuthority?.executionDescriptor.contextWindow,
    engineTag,
  )
  const usedRatio = windowTokens > 0 ? turnCtxTokens / windowTokens : 0
  if (turnCtxTokens <= 0 || windowTokens <= 0 || usedRatio < 0.5) return
  const enrichedPressure = deps.enrichContextPressure(
    {
      engine: engineTag,
      scope: 'native_context',
      dimension: 'tokens',
      level: usedRatio >= 1 ? 'critical' : 'warning',
      usedRatio: Number(usedRatio.toFixed(4)),
      usedTokens: turnCtxTokens,
      windowTokens,
    },
    {
      agentId: session.agentId,
      engine: engineTag,
      modelContextWindow: windowTokens,
      observedTokens: turnCtxTokens,
      toolsBytes: state.turnToolsBytes,
    },
  )
  if (usedRatio >= 0.8) {
    eventBus.emit(
      'session.context_pressure',
      createEvent('session.context_pressure', session.agentId, {
        sessionKey: session.sessionKey,
        ...enrichedPressure,
      }),
    )
  }
  onEvent({ kind: 'context_pressure', pressure: enrichedPressure })
}

function persistFtsAndEmitMetrics(
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
  completedAssistantText: string,
  terminalOverride: RequestedTerminalInfo | null,
  completedHasError: boolean,
): void {
  const { session, traceId } = params
  if (session.channel !== 'auto-dream') {
    const sessId = session.sessionKey
    Promise.all([
      upsertSessionMeta({
        id: sessId,
        agentId: session.sessionKey.startsWith('agent:')
          ? session.sessionKey.split(':')[1]
          : session.agentId,
        channel: session.channel,
        peerId: session.peerId,
        title: session.title,
        startedAt: session.startedAt,
        lastAt: Date.now(),
        turnCount: session.turns,
        totalCostUSD: session.totalCostUSD,
      }),
      indexTurn(sessId, session.turns, session.currentUserText ?? '', completedAssistantText),
    ]).catch((err) =>
      log.error('FTS5 index failed', { sessionKey: session.sessionKey, ...(traceId ? { traceId } : {}) }, err),
    )
  }
  deps.recordTurnUsage(
    deps.mapTurnTerminalStatus({
      persistStatus: terminalOverride?.status ?? (result.errorKind === 'auth' ? 'crashed' : undefined),
      errorCode: terminalOverride?.errorCode ?? (result.errorKind === 'auth' ? 'AUTH_ERROR' : undefined),
      hasResult: true,
      resultIsError: completedHasError,
    }),
    {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      costUsd: result.usage.cost,
      model: session.model,
    },
    session.turns,
  )
  eventBus.emit(
    'cost.recorded',
    createEvent('cost.recorded', session.agentId, {
      sessionKey: session.sessionKey,
      turnIndex: session.turns,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        costUsd: result.usage.cost,
        model: session.model,
      },
      sessionTotalCostUsd: session.totalCostUSD,
    }),
  )
  const verdict = parseVerificationVerdict(result.assistantText)
  if (verdict) {
    eventBus.emit(
      'verification.result',
      createEvent('verification.result', session.agentId, {
        sessionKey: session.sessionKey,
        target: 'code' as const,
        passed: verdict.passed,
        evidence: verdict.evidence,
      }),
    )
    log.info('verification verdict', {
      sessionKey: session.sessionKey,
      verdict: verdict.verdict,
      checks: verdict.evidence.length,
      passed: verdict.passed,
      ...(traceId ? { traceId } : {}),
    })
  }
}

interface CompletedArtifacts {
  persistedResultStatus: 'completed' | 'interrupted' | 'crashed'
  completedAssistant: { text: string; segments: SegmentRecord[] }
  completedThinking: { text: string; segments: SegmentRecord[] }
  completedTools: TurnToolEntry[]
  completedStructuredBlocks: Array<Record<string, unknown>>
  completedAgentGroups: ReturnType<TurnRunnerDeps['drainPendingAgentGroups']>
  completedRuntimeEvents: DurableRuntimeEvent[]
  completedHasError: boolean
  terminalErrorForClient: string | undefined
  terminalErrorCodeForClient: GatewayTerminalErrorCode | undefined
}

function collectCompletedArtifacts(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
  terminalOverride: RequestedTerminalInfo | null,
): CompletedArtifacts {
  const { session, turnKey } = params
  const persistedResultStatus =
    terminalOverride?.status ??
    (result.isError || result.errorDetail !== undefined || result.errorKind === 'auth'
      ? 'crashed'
      : 'completed')
  const completedAssistantRaw = deps.normalizeAssistantOutputUiFences(
    combineRetryAssistantOutput(
      params.retryAssistantSegments,
      result.assistantText,
      freezeSegmentsWithCallUsage(result.assistantSegments, params.assistantMessageId, state.callUsageByTarget),
      Date.now(),
    ),
  )
  const completedAssistantText = deps.emptyCompletedTurnAssistantText({
    status: persistedResultStatus,
    errorCode: terminalOverride?.errorCode,
    assistantText: completedAssistantRaw.text,
  })
  const completedAssistant =
    completedAssistantText === completedAssistantRaw.text
      ? completedAssistantRaw
      : { text: completedAssistantText, segments: completedAssistantRaw.segments }
  const completedThinking = combineRetryAssistantOutput(
    params.retryThinkingSegments,
    result.thinkingText,
    freezeSegmentsWithCallUsage(result.thinkingSegments, params.thinkingMessageId, state.callUsageByTarget),
    Date.now(),
  )
  const completedTools = [
    ...params.retryTools.map((tool) => structuredClone(tool)),
    ...freezeToolsWithCallUsage(result.tools, state.callUsageByTarget),
  ]
  const completedStructuredBlocks = [
    ...params.retryStructuredBlocks.map((block) => structuredClone(block)),
    ...freezeStructuredBlocksWithCallUsage(state.structuredBlocks, state.callUsageByTarget),
  ]
  const completedAgentGroups = deps.drainPendingAgentGroups(session, turnKey)
  const completedRuntimeEvents = [
    ...params.retryRuntimeEvents.map((event) => structuredClone(event)),
    ...result.runtimeEvents,
  ]
  if (session._durableDelegateRuntimeEvents) {
    session._durableDelegateRuntimeEvents.push(
      ...completedRuntimeEvents.map((event) => structuredClone(event)),
    )
  }
  const completedHasError =
    terminalOverride !== null ||
    result.isError ||
    result.errorDetail !== undefined ||
    result.errorKind === 'auth'
  const terminalErrorForClient = completedHasError
    ? (terminalOverride?.reason ?? result.errorDetail ?? state.pendingAttemptError?.error ?? 'engine reported an error')
    : undefined
  const terminalErrorCodeForClient = completedHasError
    ? (deps.wireTerminalCodeForTape(terminalOverride?.errorCode) ??
      (result.errorKind === 'auth' ? 'auth_error' : undefined))
    : undefined
  return {
    persistedResultStatus,
    completedAssistant,
    completedThinking,
    completedTools,
    completedStructuredBlocks,
    completedAgentGroups,
    completedRuntimeEvents,
    completedHasError,
    terminalErrorForClient,
    terminalErrorCodeForClient,
  }
}

function buildMasterSinkCompletedErrorFields(
  deps: TurnRunnerDeps,
  result: TurnSummary,
  terminalOverride: RequestedTerminalInfo | null,
  completedHasError: boolean,
): Record<string, unknown> {
  if (!completedHasError) return {}
  const fallbackCode =
    result.errorKind === 'auth'
      ? 'AUTH_ERROR'
      : result.errorClass && result.errorClass !== 'unknown'
        ? result.errorClass
        : deps.tapeErrorCodeForGenericFailure(result.errorDetail)
  return {
    errorCode: terminalOverride?.errorCode ?? fallbackCode,
    errorDetail: terminalOverride?.reason ?? result.errorDetail ?? 'engine reported an error',
  }
}

function buildMasterSinkOptionalArtifacts(
  artifacts: CompletedArtifacts,
  terminalEngineBilling: TurnAttemptState['terminalEngineBilling'],
): Record<string, unknown> {
  return {
    ...(artifacts.completedTools.length > 0 ? { tools: artifacts.completedTools } : {}),
    ...(artifacts.completedAssistant.segments.length > 0
      ? { assistantSegments: artifacts.completedAssistant.segments }
      : {}),
    ...(artifacts.completedThinking.segments.length > 0
      ? { thinkingSegments: artifacts.completedThinking.segments }
      : {}),
    ...(artifacts.completedAgentGroups.length > 0 ? { agentGroups: artifacts.completedAgentGroups } : {}),
    ...(artifacts.completedStructuredBlocks.length > 0
      ? { structuredBlocks: artifacts.completedStructuredBlocks }
      : {}),
    ...(artifacts.completedRuntimeEvents.length > 0
      ? { runtimeEvents: artifacts.completedRuntimeEvents }
      : {}),
    ...(terminalEngineBilling !== undefined ? { engineBilling: terminalEngineBilling } : {}),
  }
}

function buildMasterSinkCompletedPayload(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
  terminalOverride: RequestedTerminalInfo | null,
  artifacts: CompletedArtifacts,
): Record<string, unknown> {
  const { session, turnKey, clientMessageId, requestId, traceId } = params
  const turnIndex = session.turns
  const truncatedReason =
    result.stopReason === 'max_tokens' || result.stopReason === 'pause_turn'
      ? result.stopReason
      : undefined
  return {
    sessionKey: session.sessionKey,
    peerId: session.peerId,
    agentId: session.agentId,
    userId: session.userId,
    turnIndex,
    ...activeGoalAttribution(session),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(turnKey ? { turnKey } : {}),
    ...(session._currentDispatch ? { dispatch: session._currentDispatch } : {}),
    text: artifacts.completedAssistant.text,
    ...(artifacts.completedThinking.text.length > 0 ? { thinkingText: artifacts.completedThinking.text } : {}),
    status: artifacts.persistedResultStatus,
    ...(terminalOverride?.waiveReason ? { waiveReason: terminalOverride.waiveReason } : {}),
    ...(requestId ? { requestId } : {}),
    ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      totalTokens: result.usage.totalTokens,
      ...(session.model ? { model: session.model } : {}),
      turn: turnIndex,
      ...(traceId ? { traceId } : {}),
    },
    ...(result.stopReason === 'max_tokens' ? { truncated: true } : {}),
    ...(truncatedReason ? { truncatedReason } : {}),
    ...buildMasterSinkCompletedErrorFields(deps, result, terminalOverride, artifacts.completedHasError),
    ...buildMasterSinkOptionalArtifacts(artifacts, state.terminalEngineBilling),
  }
}

async function persistCompletedToMasterSink(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
  terminalOverride: RequestedTerminalInfo | null,
  artifacts: CompletedArtifacts,
): Promise<{ persistenceAcknowledged: boolean; persistenceQueuedToOutbox: boolean }> {
  const { session, turnKey, traceId } = params
  const hasDurablePayload =
    artifacts.completedAssistant.text.length > 0 ||
    artifacts.completedThinking.text.length > 0 ||
    artifacts.completedTools.length > 0 ||
    artifacts.completedAgentGroups.length > 0 ||
    artifacts.completedStructuredBlocks.length > 0 ||
    artifacts.completedRuntimeEvents.length > 0 ||
    artifacts.completedHasError
  if (!MASTER_SINK_PERSIST_CHANNELS.has(session.channel) || !hasDurablePayload) {
    return { persistenceAcknowledged: true, persistenceQueuedToOutbox: false }
  }
  scheduleSessionOutputAssetCollection({
    userId: session.userId,
    chatProjectId: session.turnChatProjectId,
    sessionId: session.peerId,
    assistantText: artifacts.completedAssistant.text,
    sessionKey: session.sessionKey,
    ...(traceId ? { traceId } : {}),
  })
  const payload = buildMasterSinkCompletedPayload(state, params, deps, result, terminalOverride, artifacts)
  const persistenceOutcome = deps.persistServerAuthoredTurnOutcome(payload)
  const persistence = persistenceOutcome.then((r) => r === 'acked' || r === 'skipped')
  deps.trackPersistence(
    persistenceOutcome.then((r) => {
      if (turnKey) deps.settleDrainedOwnerGroups(session, turnKey, artifacts.completedAgentGroups, r)
    }),
  )
  deps.trackPersistence(persistence)
  const persistenceAcknowledged = await persistence
  const persistenceQueuedToOutbox =
    getV3MasterSinkOrNull() === null && (await persistenceOutcome) === 'queued'
  return { persistenceAcknowledged, persistenceQueuedToOutbox }
}

export async function persistCompletedTurnResult(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  result: TurnSummary
  terminalOverride: RequestedTerminalInfo | null
}): Promise<{
  persistenceAcknowledged: boolean
  persistenceQueuedToOutbox: boolean
  terminalErrorForClient: string | undefined
  terminalErrorCodeForClient: GatewayTerminalErrorCode | undefined
}> {
  const { state, params, deps, result, terminalOverride } = args
  const { session } = params
  state.terminalPersistenceClaim = 'complete'
  flushTerminalBilling(state, params)
  const artifacts = collectCompletedArtifacts(state, params, deps, result, terminalOverride)
  const pricedUsd = await deps.applyPlatformCostIfMissing({
    model: session.model,
    usage: result.usage,
    sessionCostUsd: session.totalCostUSD,
    prevCostUsd: params.prevCostUSD,
    waiveReason: terminalOverride?.waiveReason,
    agentId: session.agentId,
    engine: session.providerTag,
    isError: result.isError,
    terminalBillingStatus:
      state.terminalExternalBilling?.status ?? state.terminalEngineBilling?.status,
  })
  if (pricedUsd != null) {
    session.totalCostUSD = params.prevCostUSD + pricedUsd
    session.costImprecise = true
  }
  const resultUsageCost = result.usage as typeof result.usage & { costImprecise?: boolean }
  if (resultUsageCost.costImprecise === true) session.costImprecise = true
  session.totalInputTokens += result.usage.inputTokens
  session.totalOutputTokens += result.usage.outputTokens
  session.totalCacheReadTokens += result.usage.cacheReadTokens
  session.totalCacheCreationTokens += result.usage.cacheCreationTokens
  session.currentAssistantBuf = artifacts.completedAssistant.text
  deps.recordTurnContextWatermarkForAutoCompact(session, {
    usedTokens:
      state.lastCallContextTokens > 0
        ? state.lastCallContextTokens
        : result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheCreationTokens,
    modelContextWindow: params.modelAuthority?.executionDescriptor.contextWindow,
    userText: session.currentUserText,
    assistantText: artifacts.completedAssistant.text,
    toolsBytes: state.turnToolsBytes,
  })
  emitTurnLevelContextPressureIfNeeded(state, params, deps, result)
  deps.saveResumeMap()
  const { persistenceAcknowledged, persistenceQueuedToOutbox } = await persistCompletedToMasterSink(
    state, params, deps, result, terminalOverride, artifacts,
  )
  persistFtsAndEmitMetrics(
    params, deps, result, artifacts.completedAssistant.text, terminalOverride, artifacts.completedHasError,
  )
  return {
    persistenceAcknowledged,
    persistenceQueuedToOutbox,
    terminalErrorForClient: artifacts.terminalErrorForClient,
    terminalErrorCodeForClient: artifacts.terminalErrorCodeForClient,
  }
}
