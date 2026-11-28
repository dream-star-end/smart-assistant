/**
 * Turn finalization pipeline (extracted from `finalizeTurn`).
 * Each stage receives explicit `state`, `params`, and `deps` with zero hidden closures.
 */
import { assessTurnRecoveryTape } from '@openclaude/protocol'
import type { GatewayTerminalErrorCode } from '../ccbMessageParser.js'
import { isCcbUserCancellationDiagnostic } from '../engine/ccbAdapter.js'
import type { TurnSummary } from '../engine/engineEvents.js'
import { triggerLocalCatalogRefreshOnConfigChanged } from '../modelCatalogClient.js'
import { markCheckpointTurnOutcome } from '../sessionCheckpointStore.js'
import { log } from '../sessionManagerLog.js'
import {
  SESSION_PERSIST_QUEUED_NOTICE,
  isNativeEngineTransientContinuationSafe,
} from './sessionUtils.js'
import { persistCompletedTurnResult } from './turnCompletedPersist.js'
import {
  SafeCcbContextRebuildRetryError,
  TRANSIENT_RETRY_ERROR_CODES,
  Upstream429RetryError,
  freezeSegmentsWithCallUsage,
  freezeStructuredBlocksWithCallUsage,
  freezeToolsWithCallUsage,
  type RequestedTerminalInfo,
  type TurnAttemptParams,
  type TurnAttemptState,
  type TurnRunnerDeps,
} from './turnState.js'
import { retainTerminalError } from './turnTerminal.js'

async function handleMissingResultFallback(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
): Promise<void> {
  await Promise.resolve()
  if (state.terminalPersistenceClaim !== 'none' || state.terminalRequestPromise !== null) return
  const planned = deps.shouldClassifyExitAsServiceRestart(params.session, state.runnerExitInfo)
  let fallback: RequestedTerminalInfo
  if (state.requestedTerminal) {
    fallback = state.requestedTerminal
  } else if (planned) {
    fallback = {
      status: 'interrupted',
      reason:
        state.lastRetainedTerminalError?.reason ??
        state.pendingAttemptError?.error ??
        '服务重启中断了当前回合',
      errorCode: 'SERVICE_RESTART',
      waiveReason: 'no_response',
    }
  } else if (state.lastRetainedTerminalError) {
    fallback = state.lastRetainedTerminalError
  } else if (state.pendingAttemptError?.errorCode === 'user_cancelled') {
    fallback = {
      status: 'interrupted',
      reason: state.pendingAttemptError.error,
      errorCode: 'USER_CANCELLED',
    }
  } else {
    fallback = {
      status: 'crashed',
      reason: state.pendingAttemptError?.error ?? 'Engine turn ended without summary',
      errorCode: 'RUNNER_CRASHED',
    }
  }
  await state.persistTerminalSnapshot(
    fallback.status,
    fallback.reason,
    fallback.errorCode,
    true,
    fallback.waiveReason,
  )
}

async function handleStaleResumeResult(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary,
): Promise<void> {
  const { session, traceId } = params
  const refused = deps.markResumeRejectedFromError(
    session.sessionKey,
    result.errorDetail,
    session.ccbSessionId,
  )
  log.warn('stale --resume session id detected, will clear resume-map entry', {
    sessionKey: session.sessionKey,
    staleId: session.ccbSessionId,
    refusedIds: refused,
    ...(traceId ? { traceId } : {}),
  })
  session._pendingStaleResumeClear = true
  session.totalCostUSD = params.prevCostUSD
  session.turns = params.prevTurns
  session._lastCcbCumulativeCost = params.prevLastCcbCost
  await state.persistTerminalSnapshot(
    'crashed',
    result.errorDetail ?? 'Previous engine session is no longer available',
    'STALE_RESUME_ID',
    false,
  )
  state.rejectAttempt(
    new Error('STALE_RESUME_ID: Previous session file missing; next submit will start fresh'),
  )
}

async function handlePostTurnProviderRecovery(
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary | null,
): Promise<string> {
  const { session, traceId } = params
  if (session.providerTag === 'grok' && !session.runner.nativeSessionId) {
    deps.forgetResumeEntry(session.sessionKey)
    session.ccbSessionId = null
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
    session._forceHistoricalContextOnFirstTurn = true
    session._contextRebuildNotice = 'native-resume-loss'
    deps.saveResumeMap()
  }
  const errorClass = result?.errorClass ?? deps.classifyRunError(result?.errorDetail).code
  if (
    errorClass === 'model_config_changed_retry_turn' ||
    (result && deps.classifyRunError(result.assistantText).code === 'model_config_changed_retry_turn')
  ) {
    triggerLocalCatalogRefreshOnConfigChanged('session_turn_result')
  }
  if (
    errorClass === 'context_too_long' &&
    (session.providerTag === 'ccb' || session.providerTag === 'codex')
  ) {
    log.warn('native context window exhausted; clearing resume before context rebuild', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      ...(traceId ? { traceId } : {}),
    })
    await session.runner.shutdown()
    deps.forgetResumeEntry(session.sessionKey)
    session.ccbSessionId = null
    session.runner.clearSessionId?.()
    deps.saveResumeMap()
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
  }
  return errorClass
}

function isCcbSingleOverflowDiagnostic(session: TurnAttemptParams['session'], result: TurnSummary): boolean {
  if (session.providerTag !== 'ccb' || result.assistantSegments.length !== 1) return false
  const text = result.assistantSegments[0]!.text.trim()
  const matches =
    /^API Error:\s*413\b[\s\S]*\bPROMPT_TOO_LONG\b[\s\S]*$/i.test(text) ||
    /^Prompt is too long\.?$/i.test(text)
  return matches && result.assistantText.trim() === text
}

function hasAnyObservedUsage(state: TurnAttemptState, result: TurnSummary): boolean {
  return (
    result.usage.cost !== 0 ||
    result.usage.inputTokens !== 0 ||
    result.usage.outputTokens !== 0 ||
    result.usage.cacheReadTokens !== 0 ||
    result.usage.cacheCreationTokens !== 0 ||
    Object.values(state.terminalEngineBilling?.usage ?? {}).some(
      (value) => typeof value === 'number' && value !== 0,
    )
  )
}

function isContextOverflowSafeToRetry(
  state: TurnAttemptState,
  session: TurnAttemptParams['session'],
  result: TurnSummary,
  transientErrorClass: string,
  hasUsage: boolean,
  ccbDiag: boolean,
): boolean {
  if (transientErrorClass !== 'context_too_long' || hasUsage) return false
  if (session.providerTag !== 'ccb' && session.providerTag !== 'codex') return false
  if (session.providerTag !== 'codex' && !ccbDiag) return false
  const zeroActivity =
    state.turnBlockCount === (ccbDiag ? 1 : 0) &&
    state.turnPermissionCount === 0 &&
    state.turnToolCallCount === 0 &&
    state.structuredBlocks.length === 0
  if (!zeroActivity) return false
  return (
    (result.assistantText.length === 0 || ccbDiag) &&
    result.thinkingText.length === 0 &&
    (result.assistantSegments.length === 0 || ccbDiag) &&
    result.thinkingSegments.length === 0 &&
    result.tools.length === 0
  )
}

function buildRetryRejectionError(args: {
  deps: TurnRunnerDeps
  session: TurnAttemptParams['session']
  result: TurnSummary
  transientErrorClass: string
  universalOverflowSafe: boolean
  contextOverflowSafe: boolean
}): Error {
  const { deps, session, result, transientErrorClass, universalOverflowSafe, contextOverflowSafe } = args
  const retryError = result.errorDetail ?? `${transientErrorClass}: transient model failure`
  if (universalOverflowSafe && (session.runner.executionBackend || !contextOverflowSafe)) {
    return deps.createSafeUniversalOverflowRetryError(retryError, true)
  }
  if (contextOverflowSafe && session.providerTag === 'ccb') {
    return new SafeCcbContextRebuildRetryError(retryError)
  }
  if (result.retryHint) return new Upstream429RetryError(retryError, result.retryHint)
  return new Error(retryError)
}

function appendAttemptOutputToRetryBuffers(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary,
): void {
  params.retryRuntimeEvents.push(...result.runtimeEvents.map((event) => structuredClone(event)))
  const frozenAssistant = freezeSegmentsWithCallUsage(
    result.assistantSegments, params.assistantMessageId, state.callUsageByTarget,
  )
  const assistantSegs =
    frozenAssistant.length > 0
      ? frozenAssistant
      : result.assistantText.length > 0
        ? [{ index: 0, text: result.assistantText, ts: Date.now() }]
        : []
  params.retryAssistantSegments.push(
    ...assistantSegs.map((seg, i) => ({ ...seg, index: params.retryAssistantSegments.length + i })),
  )
  const frozenThinking = freezeSegmentsWithCallUsage(
    result.thinkingSegments, params.thinkingMessageId, state.callUsageByTarget,
  )
  const thinkingSegs =
    frozenThinking.length > 0
      ? frozenThinking
      : result.thinkingText.length > 0
        ? [{ index: 0, text: result.thinkingText, ts: Date.now() }]
        : []
  params.retryThinkingSegments.push(
    ...thinkingSegs.map((seg, i) => ({ ...seg, index: params.retryThinkingSegments.length + i })),
  )
  params.retryTools.push(...freezeToolsWithCallUsage(result.tools, state.callUsageByTarget))
  params.retryStructuredBlocks.push(
    ...freezeStructuredBlocksWithCallUsage(state.structuredBlocks, state.callUsageByTarget),
  )
}

async function tryRetryableAttemptRejection(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  result: TurnSummary | null
  transientErrorClass: string
}): Promise<boolean> {
  const { state, params, deps, result, transientErrorClass } = args
  if (!result?.isError || state.turnPermissionCount !== 0) return false
  const { session } = params
  const checkpointSafe = assessTurnRecoveryTape(
    freezeToolsWithCallUsage(result.tools, state.callUsageByTarget).map((tool) => ({
      role: 'tool',
      ...tool,
      _completed: tool.completed !== false,
    })),
  ).checkpointSafe
  const nativeContinuationSafe = isNativeEngineTransientContinuationSafe({
    providerTag: session.providerTag,
    nativeSessionId: session.runner.nativeSessionId,
    ccbSessionId: session.ccbSessionId,
    permissionCount: state.turnPermissionCount,
    tools: result.tools,
  })
  if (!checkpointSafe && !nativeContinuationSafe) return false
  const hasUsage = hasAnyObservedUsage(state, result)
  const ccbDiag = isCcbSingleOverflowDiagnostic(session, result)
  const contextOverflowSafe = isContextOverflowSafeToRetry(
    state, session, result, transientErrorClass, hasUsage, ccbDiag,
  )
  const universalOverflowSafe = deps.isSafeUniversalOverflowSummary({
    session, result, errorClass: transientErrorClass, hasUsage,
    turnBlockCount: state.turnBlockCount, turnPermissionCount: state.turnPermissionCount,
    turnToolCallCount: state.turnToolCallCount, structuredBlockCount: state.structuredBlocks.length,
    priorAssistantSegments: params.retryAssistantSegments.length,
    stoppedOrAborted: Boolean(state.requestedTerminal || session._externalTurnAbort?.signal.aborted),
    isCcbSingleDiagnostic: ccbDiag,
  })
  const allowUniversalOverflowRetry =
    universalOverflowSafe &&
    (params.retryTransientErrors || Boolean(session.runner.executionBackend)) &&
    (await deps.hasCompactableSessionHistory(session))
  const allowStandardRetry =
    params.retryTransientErrors &&
    (TRANSIENT_RETRY_ERROR_CODES.has(transientErrorClass) || contextOverflowSafe)
  if (!allowUniversalOverflowRetry && !allowStandardRetry) return false
  appendAttemptOutputToRetryBuffers(state, params, result)
  session.totalCostUSD = params.prevCostUSD
  session.turns = params.prevTurns
  session._lastCcbCumulativeCost = params.prevLastCcbCost
  state.terminalEngineBilling = undefined
  state.rejectAttempt(
    buildRetryRejectionError({
      deps, session, result, transientErrorClass, universalOverflowSafe, contextOverflowSafe,
    }),
  )
  return true
}

function hasModelAuthorityProgress(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary | null,
): boolean {
  if (!result) return false
  const hasCurrent =
    result.assistantText.trim().length > 0 ||
    result.thinkingText.trim().length > 0 ||
    result.tools.length > 0 ||
    result.usage.outputTokens > 0 ||
    state.structuredBlocks.length > 0
  if (hasCurrent) return true
  return (
    params.retryAssistantSegments.some((s) => s.text.trim().length > 0) ||
    params.retryThinkingSegments.some((s) => s.text.trim().length > 0) ||
    params.retryTools.length > 0 ||
    params.retryStructuredBlocks.length > 0 ||
    params.session._pendingAgentGroups?.some(
      (entry) => entry.ownerTurnKey === undefined || entry.ownerTurnKey === params.turnKey,
    ) === true
  )
}

function matchRequestedCancellationOverride(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary | null,
): RequestedTerminalInfo | null {
  const req = state.requestedTerminal
  if (!req || req.status !== 'interrupted') return null
  const { session } = params
  const ccbUserCancel =
    session.providerTag === 'ccb' &&
    result?.isError === true &&
    isCcbUserCancellationDiagnostic(result.errorDetail, result.stopReason)
  const engineUserCancel = result ? session.runner.isUserCancellationResult?.(result) === true : false
  const confirmedInterrupt = result?.stopReason === 'interrupted' || ccbUserCancel || engineUserCancel
  if (req.errorCode === 'SYSTEM_INTERRUPT') return confirmedInterrupt ? req : null
  if (req.errorCode !== 'USER_CANCELLED') return null
  const escalatedCodexCancel =
    state.terminalRequestEscalated &&
    result?.isError === true &&
    result.stopReason !== 'end_turn' &&
    state.terminalEngineBilling?.status === 'error' &&
    state.terminalEngineBilling.terminalCode === 'CODEX_ERROR' &&
    result.errorDetail?.includes('"result":"codex app-server exited code=') === true
  if (!confirmedInterrupt && !escalatedCodexCancel) return null
  if (state.terminalEngineBilling?.status === 'error') {
    state.terminalEngineBilling = { ...state.terminalEngineBilling, terminalCode: 'USER_CANCELLED' }
  }
  return req
}

function resolveTerminalOverrideForResult(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary | null,
): RequestedTerminalInfo | null {
  let override: RequestedTerminalInfo | null = state.requestedTerminal?.waiveReason
    ? state.requestedTerminal
    : matchRequestedCancellationOverride(state, params, result)
  if (!override && result?.errorKind === 'model_authority') {
    const hasProgress = hasModelAuthorityProgress(state, params, result)
    override = {
      status: 'crashed',
      reason: hasProgress
        ? '任务暂时中断，已生成的内容和步骤已保留。可以从断点继续，已完成的调用按实际用量计费。'
        : '任务暂时中断。你可以继续。',
      errorCode: 'MODEL_AUTHORITY_EXPIRED',
      ...(hasProgress ? {} : { waiveReason: 'platform_authority_expired' }),
    }
  }
  if (override) retainTerminalError(state, params, override.status, override.reason, override.errorCode)
  return override
}

function isLegacyZeroUsagePhantom(
  state: TurnAttemptState,
  result: TurnSummary | null,
  isStringInput: boolean,
  isSlashCommand: boolean,
): boolean {
  if (!result || !isStringInput || isSlashCommand || result.isError) return false
  const u = result.usage
  return (
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadTokens === 0 &&
    u.cacheCreationTokens === 0 &&
    u.cost === 0 &&
    state.turnToolCallCount === 0 &&
    state.turnBlockCount === 0 &&
    state.turnPermissionCount === 0
  )
}

function detectPhantomTurn(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary | null,
  signals: TurnSummary['phantomSignals'],
  isStringInput: boolean,
  isSlashCommand: boolean,
): boolean {
  const { session, traceId } = params
  if (signals.apiState === 'skipped') {
    log.info('turn.skipped (telemetry)', {
      sessionKey: session.sessionKey,
      reason: signals.skipReason,
      ...(traceId ? { traceId } : {}),
    })
    return false
  }
  if (signals.apiState === 'called') {
    if (result && !result.stopReason && state.turnBlockCount === 0 && state.turnPermissionCount === 0) {
      const diag = result.diagnostics
      log.warn('telemetry: willCallApi fired but no stop_reason and no blocks', {
        sessionKey: session.sessionKey,
        incompleteCount: 1,
        hadApiResponse: diag?.hadApiResponse ?? false,
        apiRespStopReason: diag?.apiRespStopReason,
        lastToolPreUse: diag?.lastToolPreUse,
        toolErrorCount: diag?.toolErrorCount ?? 0,
        ...(traceId ? { traceId } : {}),
      })
    }
    return false
  }
  return isLegacyZeroUsagePhantom(state, result, isStringInput, isSlashCommand)
}

async function handlePhantomTurnOutcome(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  result: TurnSummary | null,
): Promise<void> {
  if (result && params.retryPhantomErrors) {
    params.retryRuntimeEvents.push(...result.runtimeEvents.map((e) => structuredClone(e)))
  }
  params.session.totalCostUSD = params.prevCostUSD
  params.session.turns = params.prevTurns
  params.session._lastCcbCumulativeCost = params.prevLastCcbCost
  log.warn('phantom turn — CCB returned empty result without invoking model', {
    sessionKey: params.session.sessionKey,
    turnIndex: params.session.turns + 1,
    durationMs: Date.now() - params.turnStartTime,
    ...(params.traceId ? { traceId: params.traceId } : {}),
  })
  if (params.retryPhantomErrors) {
    state.rejectAttempt(new Error('PHANTOM_TURN: CCB returned empty result'))
  } else {
    await state.persistTerminalSnapshot(
      'crashed',
      '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
      'PHANTOM_TURN',
      true,
      'no_response',
    )
  }
}

function applyEmptyOutputOverrides(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  result: TurnSummary | null
  signals: TurnSummary['phantomSignals']
  isSlashCommand: boolean
  terminalOverride: RequestedTerminalInfo | null
}): RequestedTerminalInfo | null {
  const { state, params, deps, result, signals, isSlashCommand } = args
  let override = args.terminalOverride
  if (override || !result) return override
  const zeroOutputWithInput =
    result.usage.outputTokens === 0 &&
    (result.usage.inputTokens > 0 ||
      result.usage.cacheReadTokens > 0 ||
      result.usage.cacheCreationTokens > 0)
  const retryAssistantPreview = params.retryAssistantSegments.map((s) => s.text).join('')
  const failClosedEmpty =
    !zeroOutputWithInput &&
    deps.shouldFailClosedEmptyModelTurn({
      status: 'completed',
      assistantText: `${retryAssistantPreview}${result.assistantText ?? ''}`,
      outputTokens: result.usage.outputTokens,
      inputTokens: result.usage.inputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      toolCallCount: state.turnToolCallCount,
      blockCount: state.turnBlockCount,
      structuredBlockCount: state.structuredBlocks.length,
      apiState: signals.apiState,
      isSlashCommand,
      isError: result.isError === true,
    })
  if (zeroOutputWithInput || failClosedEmpty) {
    override = {
      status: 'crashed',
      reason: '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
      errorCode: 'NO_RESPONSE',
      waiveReason: 'no_response',
    }
    retainTerminalError(state, params, override.status, override.reason, override.errorCode)
  }
  return override
}

function deliverFinalClientOutcome(args: {
  state: TurnAttemptState
  params: TurnAttemptParams
  deps: TurnRunnerDeps
  result: TurnSummary | null
  terminalOverride: RequestedTerminalInfo | null
  persistenceAcknowledged: boolean
  persistenceQueuedToOutbox: boolean
  terminalErrorForClient: string | undefined
  terminalErrorCodeForClient: GatewayTerminalErrorCode | undefined
}): void {
  const { state, params, deps, result, terminalOverride } = args
  if (!result) deps.recordTurnUsage(deps.mapTurnTerminalStatus({ hasResult: false }))
  if (args.persistenceAcknowledged) {
    if (args.terminalErrorForClient) {
      const preClassified = result?.errorClass
      params.onEvent(
        deps.toEngineErrorEvent({
          kind: 'error',
          error: args.terminalErrorForClient,
          ...(preClassified ? { errorClass: preClassified } : {}),
          ...(args.terminalErrorCodeForClient ? { errorCode: args.terminalErrorCodeForClient } : {}),
        }),
      )
    } else if (state.pendingFinal) {
      if (result && !result.isError && result.errorDetail === undefined && terminalOverride === null) {
        markCheckpointTurnOutcome(params.session, 'completed')
      }
      params.onEvent(state.pendingFinal)
    } else if (result && !result.isError && result.errorDetail === undefined && terminalOverride === null) {
      markCheckpointTurnOutcome(params.session, 'completed')
    }
  } else if (args.persistenceQueuedToOutbox) {
    log.warn('turn terminal delivered in degraded persist-queued mode', {
      sessionKey: params.session.sessionKey,
      turnIndex: params.session.turns,
      ...(params.traceId ? { traceId: params.traceId } : {}),
    })
    params.onEvent(
      deps.toEngineErrorEvent({
        kind: 'error',
        error: args.terminalErrorForClient ?? SESSION_PERSIST_QUEUED_NOTICE,
        errorCode: 'session_persist_unavailable',
      }),
    )
  }
  state.resolveAttempt()
}

function settleModelSwitchTransition(params: TurnAttemptParams, result: TurnSummary | null): void {
  if (result?.nativeCompactionSummary) {
    params.session._lastNativeCompactionSummary = result.nativeCompactionSummary
  }
  const transition = params.modelSwitchTransition
  if (!transition || params.session._modelSwitchTransition !== transition) return
  if (result && !result.isError) {
    params.session._modelSwitchTransition = undefined
  } else {
    transition.state = 'prepared'
    transition.summaryInjected = false
  }
}

export async function finalizeTurnAttempt(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  result: TurnSummary | null,
  rejectedBeforeSubmit = false,
): Promise<void> {
  if (state.terminalPersistenceClaim === 'partial') return
  if (!state.turn && (!rejectedBeforeSubmit || result?.errorKind !== 'model_authority')) {
    throw new Error('terminal finalization requires an engine turn')
  }
  if (rejectedBeforeSubmit) {
    if (state.turn) throw new Error('rejected retry already submitted an engine turn')
    params.session.turns = Math.max(params.session.turns, params.prevTurns + 1)
  }
  if (!result && !rejectedBeforeSubmit) {
    await handleMissingResultFallback(state, params, deps)
    return
  }
  state.detach()
  settleModelSwitchTransition(params, result)
  if (result?.staleResumeId) {
    await handleStaleResumeResult(state, params, deps, result)
    return
  }
  const transientErrorClass = await handlePostTurnProviderRecovery(params, deps, result)
  if (await tryRetryableAttemptRejection({ state, params, deps, result, transientErrorClass })) return
  let terminalOverride = resolveTerminalOverrideForResult(state, params, result)
  const userInputStr = typeof params.userTextOrBlocks === 'string' ? params.userTextOrBlocks : null
  const isStringInput = userInputStr !== null
  const isSlashCommand = isStringInput && userInputStr.trimStart().startsWith('/')
  const signals = state.turn ? state.turn.getPhantomSignals() : result!.phantomSignals
  if (!terminalOverride && detectPhantomTurn(state, params, result, signals, isStringInput, isSlashCommand)) {
    await handlePhantomTurnOutcome(state, params, result)
    return
  }
  terminalOverride = applyEmptyOutputOverrides({
    state, params, deps, result, signals, isSlashCommand, terminalOverride,
  })
  const persisted = result
    ? await persistCompletedTurnResult({ state, params, deps, result, terminalOverride })
    : {
        persistenceAcknowledged: true,
        persistenceQueuedToOutbox: false,
        terminalErrorForClient: undefined,
        terminalErrorCodeForClient: undefined,
      }
  deliverFinalClientOutcome({ state, params, deps, result, terminalOverride, ...persisted })
}
