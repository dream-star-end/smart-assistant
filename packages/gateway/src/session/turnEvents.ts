/**
 * Per-turn engine event routing, startup/thinking progress phases,
 * tool detection hooks, context pressure enrichment, and parse error capture.
 */
import { resolve as resolvePath } from 'node:path'
import type { CallTokenUsageSnapshot, OutboundContentBlock } from '@openclaude/protocol'
import { paths, recordMemoryUsageEvent } from '@openclaude/storage'
import type { ModelProgressPhase } from '../ccbMessageParser.js'
import type {
  EngineBillingEvent,
  EngineEvent,
  EngineExternalBillingEvent,
  TurnRetryMeta,
} from '../engine/engineEvents.js'
import { createEvent, eventBus } from '../eventBus.js'
import { contextCompactionsTotal } from '../metrics.js'
import { log } from '../sessionManagerLog.js'
import {
  MODEL_THINKING_KEEPALIVE_MS,
  MODEL_THINKING_WORKING_DETAIL,
  takeDurableEventOrdinal,
} from './sessionUtils.js'
import type { TurnAttemptParams, TurnAttemptState, TurnRunnerDeps } from './turnState.js'

export interface TurnEventHandlers {
  emitStartupPhase: (status: 'engine_starting' | 'engine_resuming') => void
  stopThinkingStatus: (clear: boolean) => void
  handleModelProgress: (phase: ModelProgressPhase) => void
  handleEngineEvent: (e: EngineEvent) => void
  handleActivity: () => void
  handleBilling: (b: EngineBillingEvent) => void
  handleExternalBilling: (b: EngineExternalBillingEvent) => void
  handleSpawn: (info: { resumed?: boolean }) => void
  handleParseError: (payload: { line: string; err?: unknown; error?: unknown }) => void
}

function updatePhaseTrackingForEngineEvent(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  e: EngineEvent,
  clearStartupPhase: () => void,
  stopThinkingStatus: (clear: boolean) => void,
): void {
  if (state.startupPhaseActive) {
    if (e.kind === 'turn_status') {
      state.startupPhaseActive = false
      if (e.status && typeof e.status === 'object') {
        params.onEvent({ kind: 'turn_status', status: null })
      }
    } else if (
      e.kind === 'block' ||
      e.kind === 'permission_request' ||
      e.kind === 'error' ||
      e.kind === 'final'
    ) {
      clearStartupPhase()
    }
  }
  if (
    e.kind === 'turn_status' ||
    e.kind === 'permission_request' ||
    e.kind === 'error' ||
    e.kind === 'final'
  ) {
    stopThinkingStatus(false)
  }
}

function handleRetryingTurnStatus(
  params: TurnAttemptParams,
  retryInfo: TurnRetryMeta,
): void {
  const { session, automaticRetryState, clientMessageId, turnKey, retryRuntimeEvents, onEvent } = params
  if (session.providerTag !== 'codex' && automaticRetryState) {
    automaticRetryState.attempt = Math.min(
      automaticRetryState.max,
      automaticRetryState.attempt + 1,
    )
  }
  const shared = automaticRetryState ?? {
    rootClientMessageId: clientMessageId ?? turnKey ?? session.sessionKey,
    attempt: retryInfo.attempt,
    max: retryInfo.max,
  }
  const retry = { ...retryInfo, attempt: shared.attempt, max: shared.max }
  retryRuntimeEvents.push({
    ordinal: takeDurableEventOrdinal(session),
    observedAt: Date.now(),
    source: 'gateway',
    payload: {
      type: 'retry_status',
      code: session.providerTag === 'codex' ? 'CODEX_TURN_START_RETRY' : 'CCB_API_RETRY',
      rootClientMessageId: shared.rootClientMessageId,
      attempt: retry.attempt,
      max: retry.max,
    },
  })
  onEvent({ kind: 'turn_status', status: { status: 'retrying', retry } })
}

function handleToolUseDetected(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  tool: { id: string; name: string; input: Record<string, unknown> },
): void {
  const { session } = params
  state.turnToolCallCount++
  if (tool.name === 'Read') {
    const rawPath =
      typeof tool.input.file_path === 'string'
        ? tool.input.file_path
        : typeof tool.input.path === 'string'
          ? tool.input.path
          : null
    if (rawPath) {
      const memoryRoot = resolvePath(paths.agentMemoryDir(session.agentId))
      const target = resolvePath(rawPath)
      if (target.startsWith(`${memoryRoot}/`) && target.endsWith('.md')) {
        state.memoryReadTargets.set(tool.id, target)
      }
    }
  }
  try {
    deps.applyEfficiencyToolObservation(session, tool, state.turnToolCallCount)
  } catch (err) {
    log.debug('efficiency guard observe failed', {
      sessionKey: session.sessionKey,
      err: String(err),
    })
  }
  if (tool.name === 'CronCreate') {
    const gatewayJobId = `ccb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    if (!session._cronBridgeMap) session._cronBridgeMap = new Map()
    session._cronBridgeMap.set(`_pending:${tool.id}`, gatewayJobId)
    eventBus.emit(
      'task.created',
      createEvent('task.created', session.agentId, {
        taskId: gatewayJobId,
        schedule: typeof tool.input.cron === 'string' ? tool.input.cron : undefined,
        prompt: typeof tool.input.prompt === 'string' ? tool.input.prompt : '',
        oneshot: tool.input.recurring === false,
        source: 'cron-bridge',
      }),
    )
  } else if (tool.name === 'CronDelete') {
    const ccbId = String(tool.input.id ?? '')
    const gatewayId = session._cronBridgeMap?.get(ccbId) ?? ccbId
    eventBus.emit(
      'task.deleted',
      createEvent('task.deleted', session.agentId, { taskId: gatewayId }),
    )
  }
}

function handleToolResultDetected(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  tr: Extract<EngineEvent, { kind: 'tool_result_detected' }>['result'],
): void {
  const { session } = params
  const memoryTarget = state.memoryReadTargets.get(tr.toolUseId)
  state.memoryReadTargets.delete(tr.toolUseId)
  if (memoryTarget && !tr.isError) {
    void recordMemoryUsageEvent({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      turnIndex: session.turns + 1,
      operation: 'core_read',
      memoryType: 'core',
      outcome: 'success',
      topMatchKey: memoryTarget,
      metadata: { source: 'native_read_tool' },
    }).catch((err) => {
      log.debug('memory usage event record failed', {
        sessionKey: session.sessionKey,
        err: String(err),
      })
    })
  }
  if (tr.toolName === 'CronCreate' && !tr.isError && session._cronBridgeMap) {
    const pendingKey = `_pending:${tr.toolUseId}`
    const gatewayJobId = session._cronBridgeMap.get(pendingKey)
    if (gatewayJobId) {
      session._cronBridgeMap.delete(pendingKey)
      const match = /job\s+([0-9a-f]{6,12})/i.exec(tr.preview)
      if (match) session._cronBridgeMap.set(match[1]!, gatewayJobId)
    }
  }
  state.turnToolsBytes +=
    Buffer.byteLength(tr.preview ?? '', 'utf8') +
    Buffer.byteLength(tr.inputPreview ?? '', 'utf8')
  eventBus.emit(
    'tool.called',
    createEvent('tool.called', session.agentId, {
      sessionKey: session.sessionKey,
      turnIndex: session.turns + 1,
      toolName: tr.toolName,
      durationMs: tr.durationMs,
      isError: tr.isError,
      ...(session._currentTurnTraceId ? { traceId: session._currentTurnTraceId } : {}),
      inputPreview: tr.inputPreview,
      outputPreview: tr.preview ? tr.preview.slice(0, 500) : undefined,
      ...(tr.exitCode !== undefined ? { exitCode: tr.exitCode } : {}),
      ...(tr.terminationReason !== undefined ? { terminationReason: tr.terminationReason } : {}),
    }),
  )
}

function handleCallUsageEvent(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  rawCall: CallTokenUsageSnapshot,
): void {
  const call: CallTokenUsageSnapshot = {
    ...structuredClone(rawCall),
    callId: `a${params.attemptOrdinal + 1}-${rawCall.callId}`,
  }
  const callCtxTokens =
    (call.usage.inputTokens ?? 0) +
    (call.usage.cacheReadTokens ?? 0) +
    (call.usage.cacheCreationTokens ?? 0)
  if (callCtxTokens > 0) state.lastCallContextTokens = callCtxTokens
  for (const targetId of call.targetIds) {
    state.callUsageByTarget.set(targetId, call)
  }
  params.onEvent({ kind: 'call_usage', call })
}

function handleBlockTracking(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  block: OutboundContentBlock,
): void {
  if ((block.kind === 'plan' || block.kind === 'goal') && !block.parentToolUseId) {
    const rawOrdinal = (block as Record<string, unknown>)._ocEventOrdinal
    state.structuredBlocks.push({
      ...structuredClone(block),
      _ocObservedAt: Date.now(),
      _ocEventOrdinal:
        typeof rawOrdinal === 'number' ? rawOrdinal : takeDurableEventOrdinal(params.session),
    })
  }
  state.turnBlockCount++
}

function dispatchEngineEvent(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
  e: EngineEvent,
  clearStartupPhase: () => void,
  stopThinkingStatus: (clear: boolean) => void,
): void {
  const { session, onEvent } = params
  updatePhaseTrackingForEngineEvent(state, params, e, clearStartupPhase, stopThinkingStatus)
  if (e.kind === 'turn_status' && e.status && typeof e.status === 'object' && e.status.status === 'retrying') {
    handleRetryingTurnStatus(params, e.status.retry)
    return
  }
  if (e.kind === 'tool_use_detected') {
    handleToolUseDetected(state, params, deps, {
      id: e.tool.id,
      name: e.tool.name,
      input: e.tool.input as Record<string, unknown>,
    })
    return
  }
  if (e.kind === 'tool_result_detected') {
    handleToolResultDetected(state, params, e.result)
    return
  }
  if (e.kind === 'context_pressure') {
    const enrichedPressure = deps.enrichContextPressure(e.pressure, {
      agentId: session.agentId,
      engine: e.pressure.engine || session.providerTag || session.runner.engineId || 'unknown',
      modelContextWindow: params.modelAuthority?.executionDescriptor.contextWindow,
      observedTokens: state.lastCallContextTokens > 0 ? state.lastCallContextTokens : undefined,
      toolsBytes: state.turnToolsBytes,
    })
    state.emittedTurnPressure = true
    eventBus.emit(
      'session.context_pressure',
      createEvent('session.context_pressure', session.agentId, {
        sessionKey: session.sessionKey,
        ...enrichedPressure,
      }),
    )
    onEvent({ kind: 'context_pressure', pressure: enrichedPressure })
    return
  }
  if (e.kind === 'context_compacted') {
    contextCompactionsTotal.inc({
      engine: e.compaction.engine,
      strategy: e.compaction.strategy,
      outcome: 'ok',
    })
  }
  if (e.kind === 'call_usage') {
    handleCallUsageEvent(state, params, e.call)
    return
  }
  if (e.kind === 'block') handleBlockTracking(state, params, e.block)
  else if (e.kind === 'permission_request') state.turnPermissionCount++
  if (e.kind === 'final') {
    state.observedFinalMeta = e.meta ? { ...e.meta } : undefined
    state.pendingFinal = e
    return
  }
  if (e.kind === 'error') {
    state.pendingAttemptError = e
    return
  }
  onEvent(e)
}

export function createTurnEventHandlers(
  state: TurnAttemptState,
  params: TurnAttemptParams,
  deps: TurnRunnerDeps,
): TurnEventHandlers {
  const { session, onEvent, traceId, retryRuntimeEvents } = params
  const emitStartupPhase = (status: 'engine_starting' | 'engine_resuming'): void => {
    state.startupPhaseActive = true
    onEvent({ kind: 'turn_status', status })
  }
  const clearStartupPhase = (): void => {
    if (!state.startupPhaseActive) return
    state.startupPhaseActive = false
    onEvent({ kind: 'turn_status', status: null })
  }
  const emitThinkingStatus = (): void => {
    onEvent({ kind: 'turn_status', status: { status: 'working', detail: MODEL_THINKING_WORKING_DETAIL } })
  }
  const stopThinkingStatus = (clear: boolean): void => {
    if (!state.thinkingKeepalive) return
    clearInterval(state.thinkingKeepalive)
    state.thinkingKeepalive = null
    if (clear) onEvent({ kind: 'turn_status', status: null })
  }
  const handleModelProgress = (phase: ModelProgressPhase): void => {
    if (state.detached) return
    clearStartupPhase()
    if (phase === 'thinking_start') {
      if (state.thinkingKeepalive) return
      emitThinkingStatus()
      state.thinkingKeepalive = setInterval(() => {
        if (state.detached) stopThinkingStatus(false)
        else emitThinkingStatus()
      }, MODEL_THINKING_KEEPALIVE_MS)
      state.thinkingKeepalive.unref?.()
    } else if (phase === 'thinking_stop') {
      stopThinkingStatus(true)
    }
  }
  return {
    emitStartupPhase,
    stopThinkingStatus,
    handleModelProgress,
    handleEngineEvent: (e) =>
      dispatchEngineEvent(state, params, deps, e, clearStartupPhase, stopThinkingStatus),
    handleActivity: () => {
      if (!state.detached) state.idleTimer?.refresh()
    },
    handleBilling: (b) => {
      if (!state.detached) state.terminalEngineBilling = structuredClone(b)
    },
    handleExternalBilling: (b) => {
      if (!state.detached) state.terminalExternalBilling = structuredClone(b)
    },
    handleSpawn: (info) => {
      if (!state.detached) emitStartupPhase(info?.resumed ? 'engine_resuming' : 'engine_starting')
    },
    handleParseError: (payload) => {
      const rawError = payload.err ?? payload.error
      const err = rawError instanceof Error ? rawError : undefined
      retryRuntimeEvents.push({
        ordinal: takeDurableEventOrdinal(session),
        observedAt: Date.now(),
        source: 'gateway',
        payload: {
          type: 'parse_error',
          line: payload.line,
          error: err?.message ?? String(rawError ?? 'unknown parse error'),
        },
      })
      log.warn('ccb stdout parse_error', {
        sessionKey: session.sessionKey,
        msg: err?.message,
        sample: payload.line?.slice(0, 200),
        ...(traceId ? { traceId } : {}),
      })
    },
  }
}
