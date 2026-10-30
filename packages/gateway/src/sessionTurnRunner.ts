import { normalizeAssistantOutputUiFences } from './uiFenceNormalize.js'
import type { GrokExecutionDescriptor } from '@openclaude/protocol'
import type { UpstreamRetryHint } from '@openclaude/protocol'
import { consumeUnusedPreheat } from './speculativePreheat.js'
/**
 * Session turn execution (one turn, retry wrapper)
 *
 * Moved verbatim out of SessionManager (sessionManager.ts) — FINDINGS §7.6, OCV5-469. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. TurnRunnerHost lists exactly the SessionManager members this code
 * touches (typed from the class itself).
 */
import { createHash } from 'node:crypto'
import { join, resolve as resolvePath } from 'node:path'
import {
  indexTurn,
  recordTurnDispatchRunning,
  getTurnDispatchByDispatchId,
  reserveTurnIndex,
  recordMemoryUsageEvent,
  paths,
  upsertSessionMeta,
} from '@openclaude/storage'
import { isCcbUserCancellationDiagnostic } from './engine/ccbAdapter.js'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineTurnRun,
} from './engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  EngineExternalBillingEvent,
  EngineEvent,
  EngineFinalMeta,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { eventBus, createEvent } from './eventBus.js'
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
import {
  deriveLosslessTurnKey,
  getV3MasterSinkOrNull,
  type V3MasterSinkPayload,
} from './v3MasterSink.js'
import { failClosedOnRunningCasMiss } from './turnDispatchInbox.js'
import {
  AUTOMATIC_TURN_RETRY_MAX,
  assessTurnRecoveryTape,
  type CallTokenUsageSnapshot,
  type TurnWaiveReason,
  type OutboundContentBlock,
} from '@openclaude/protocol'
import { classifyRunError } from './errorClassify.js'
import type {
  GatewayEngineErrorEvent,
  GatewayTerminalErrorCode,
  ModelProgressPhase,
} from './ccbMessageParser.js'
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
  SESSION_PERSIST_QUEUED_NOTICE,
  BOX_ACTIVE_TURN_IDLE_MS,
  BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS,
  pickTurnSilentBackstopMs,
  applyTurnIdleTimeoutTick,
  scheduleSessionOutputAssetCollection,
  takeDurableEventOrdinal,
  TRANSIENT_RETRY_INPUT,
  isNativeEngineTransientContinuationSafe,
  MODEL_THINKING_WORKING_DETAIL,
  MODEL_THINKING_KEEPALIVE_MS,
  persistServerAuthoredTurnOutcome,
  activeGoalAttribution,
  parseVerificationVerdict,
} from './sessionManager.js'
import { log } from './sessionManagerLog.js'
import type { SessionManager, AgentSession } from './sessionManager.js'

export interface TurnRunnerHost {
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

/** Exact Gateway registry for tool results that are safe to checkpoint past.
 * Everything else (Bash/browser/MCP/third-party and all writes) stays unknown
 * unless its owning adapter later adds a durable downstream-idempotency
 * proof. Runtime-provided lookalike fields are always stripped first. */
const RECOVERY_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

function stampGatewayToolEffect(tool: TurnToolEntry): TurnToolEntry {
  const frozen = structuredClone(tool) as TurnToolEntry & { _toolEffect?: unknown }
  // biome-ignore lint/performance/noDelete: moved verbatim from sessionManager.ts (OCV5-469); pre-existing there
  delete frozen._toolEffect
  if (!RECOVERY_READ_ONLY_TOOLS.has(frozen.toolName) || frozen.completed === false) {
    return frozen
  }
  return {
    ...frozen,
    _toolEffect: {
      authority: 'gateway-v1',
      registryEntrySha256: createHash('sha256')
        .update(`gateway-v1\0${frozen.toolName}\0read_only`)
        .digest('hex'),
      outcome: 'completed',
      safety: 'read_only',
    },
  } as TurnToolEntry
}

/**
 * engine 事件通道的**单点**受控加宽 cast:engine 权威类型的 error 事件只声明
 * errorCode 'user_cancelled'(engine/ 所有权边界内不改),gateway 编排层发射
 * 其余权威终态码(runner_crashed / service_restart / …)时经此收口。消费端
 * server.ts `_buildEngineErrorFrame` 以 GatewayEngineErrorEvent 形状接收,
 * 运行时零损失;除此 helper 外不允许再出现跨该边界的 cast。
 */
function _asEngineErrorEvent(event: GatewayEngineErrorEvent): SessionStreamEvent {
  return event as unknown as SessionStreamEvent
}

function throwIfLogicalTurnCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('logical turn cancelled')
}

function waitForRetryChunk(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfLogicalTurnCancelled(signal)
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('logical turn cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Long Retry-After dates must never overflow Node's timer into a 1ms retry. */
export async function waitForRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfLogicalTurnCancelled(signal)
  const deadline = Date.now() + ms
  do {
    await waitForRetryChunk(Math.min(60_000, Math.max(0, deadline - Date.now())), signal)
    throwIfLogicalTurnCancelled(signal)
  } while (Date.now() < deadline)
}

/**
 * 触发 v3MasterSink server-authored 持久化的 channel 白名单。
 *
 * 历史上只有 'webchat' 走 master→client_sessions 写回路径(Phase 0.1 落地的 mobile
 * durability 修复)。'wechat' 在 v3 commercial 接 iLink broker 后,inbound 直接从
 * /internal/v3/wechat-inbound 喂 dispatchInbound,**peer.id 由 broker 解析为 client_sessions.id**
 * (即 wechat_session_pointer.current_session_id),所以走和 webchat 一模一样的"per-user
 * client_sessions 行 + master 端 appendServerAuthoredMessage"的写回路径,允许放行。
 *
 * 其它 channel(telegram / cron / webhook / delegate)peerId 不是 client_sessions.id —
 * master 端 WHERE id=? AND user_id=? 永远命不中,落 outbox 死信浪费 IO,故不放行。
 */
const MASTER_SINK_PERSIST_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'wechat'])

function combineRetryAssistantOutput(
  retrySegments: readonly SegmentRecord[],
  terminalText: string,
  terminalSegments: readonly SegmentRecord[],
  fallbackTs: number,
): { text: string; segments: SegmentRecord[] } {
  if (retrySegments.length === 0) {
    return { text: terminalText, segments: terminalSegments.map((segment) => ({ ...segment })) }
  }
  const tail =
    terminalSegments.length > 0
      ? terminalSegments
      : terminalText.length > 0
        ? [{ index: 0, text: terminalText, ts: fallbackTs }]
        : []
  const segments = [...retrySegments, ...tail].map((segment, index) => ({
    ...segment,
    index,
  }))
  return {
    text: retrySegments.map((segment) => segment.text).join('') + terminalText,
    segments,
  }
}

const TRANSIENT_RETRY_ERROR_CODES = new Set(['rate_limited', 'model_capacity', 'upstream_failed'])

function safeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Partial/crash persistence must retain every token counter already observed.
 * Codex billing arrives before its final parser event, so it is also a valid
 * fallback if an exit races terminal materialization. */
function terminalUsageForPersistence(args: {
  finalMeta?: EngineFinalMeta
  billing?: EngineBillingEvent
  traceId?: string
  turnIndex: number
  model?: string
}): NonNullable<V3MasterSinkPayload['usage']> {
  const billingUsage = args.billing?.usage
  const billingTotal = [
    billingUsage?.input_tokens,
    billingUsage?.output_tokens,
    billingUsage?.cache_read_input_tokens,
    billingUsage?.cache_creation_input_tokens,
    billingUsage?.reasoning_output_tokens,
  ].reduce<number | undefined>((total, value) => {
    const safe = safeUsageCounter(value)
    return safe === undefined ? total : (total ?? 0) + safe
  }, undefined)
  const totalTokens = safeUsageCounter(args.finalMeta?.totalTokens) ?? billingTotal
  return {
    inputTokens:
      safeUsageCounter(args.finalMeta?.inputTokens) ??
      safeUsageCounter(billingUsage?.input_tokens) ??
      0,
    outputTokens:
      safeUsageCounter(args.finalMeta?.outputTokens) ??
      safeUsageCounter(billingUsage?.output_tokens) ??
      0,
    cacheReadTokens:
      safeUsageCounter(args.finalMeta?.cacheReadTokens) ??
      safeUsageCounter(billingUsage?.cache_read_input_tokens) ??
      0,
    cacheCreationTokens:
      safeUsageCounter(args.finalMeta?.cacheCreationTokens) ??
      safeUsageCounter(billingUsage?.cache_creation_input_tokens) ??
      0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(args.model ? { model: args.model } : {}),
    turn: args.turnIndex,
    ...(args.traceId ? { traceId: args.traceId } : {}),
  }
}

/** Internal proof that a resolved CCB terminal contained only the canonical
 * provider context-overflow diagnostic, so replaying the same user turn with
 * a smaller master-history suffix cannot duplicate observable work. */
class SafeCcbContextRebuildRetryError extends Error {}
class Upstream429RetryError extends Error {
  constructor(message: string, readonly hint: Readonly<UpstreamRetryHint>) { super(message) }
}

// (auth 错误关键字分类已下沉 engine/ccbAdapter.ts —— 错误字符串是 CCB 底座私有
//  知识;本层只消费 TurnSummary.errorKind === 'auth'。)

export async function _runOneTurn(
  this: TurnRunnerHost,
  session: AgentSession,
  userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
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
  retryAuthErrors = true,
  retryPhantomErrors = true,
  retryTransientErrors = false,
  attemptOrdinal = 0,
  automaticRetryState?: AutomaticRetryState,
  modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
  grokExecutionDescriptor?: GrokExecutionDescriptor,
): Promise<void> {
  const { runner } = session
  const turnStartTime = Date.now()
  let turnToolCallCount = 0
  let turnBlockCount = 0
  let turnPermissionCount = 0
  const memoryReadTargets = new Map<string, string>()
  // Plan/goal blocks are paid structured model output but are not contained
  // in assistantText/thinkingText/tool snapshots. Keep every update (not
  // merely the last card projection) so a disconnected browser is never the
  // sole durable copy.
  const structuredBlocks: Array<Record<string, unknown>> = []
  const callUsageByTarget = new Map<string, CallTokenUsageSnapshot>()
  const freezeCall = (call: CallTokenUsageSnapshot): CallTokenUsageSnapshot => structuredClone(call)
  const freezeTools = (tools: readonly TurnToolEntry[]): TurnToolEntry[] =>
    tools.map((tool) => {
      const call = callUsageByTarget.get(tool.blockId)
      return {
        ...stampGatewayToolEffect(tool),
        ...(call ? { _callUsage: freezeCall(call) } : {}),
      }
    })
  const freezeSegments = (
    segments: readonly SegmentRecord[],
    messageIdBase: string | undefined,
  ): SegmentRecord[] =>
    segments.map((segment) => {
      const targetId = messageIdBase ? `${messageIdBase}-s${segment.index}` : undefined
      const call = targetId ? callUsageByTarget.get(targetId) : undefined
      return {
        ...structuredClone(segment),
        ...(call ? { _callUsage: freezeCall(call) } : {}),
      }
    })
  const freezeStructuredBlocks = (
    blocks: readonly Record<string, unknown>[],
  ): Array<Record<string, unknown>> =>
    blocks.map((block) => {
      const targetId = typeof block.blockId === 'string' ? block.blockId : undefined
      const call = targetId ? callUsageByTarget.get(targetId) : undefined
      return {
        ...structuredClone(block),
        ...(call ? { _callUsage: freezeCall(call) } : {}),
      }
    })
  const onPostTerminalRuntimeEvent = (
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
  ): void => {
    const ownerTurnKey = session.channel === 'delegate' ? session._billingParentTurnKey : turnKey
    const ownerSessionId =
      session.channel === 'delegate' ? session._usageAttribution?.parentSessionId : session.peerId
    this._dispatchPostTerminalRuntimeEvent(session, event, block, {
      ownerTurnKey,
      ownerSessionId,
      turnIndex: prevTurns + 1,
      onEvent,
    })
  }

  // Snapshot session totals so we can roll back on auth error / phantom turn
  // (CcbAdapter 的 per-turn parser 经 TurnParams.sessionTotals 引用直接 mutate
  // 这些字段 —— 成本 delta 基线的单一权威仍是 AgentSession 本身)
  const prevCostUSD = session.totalCostUSD
  const prevTurns = session.turns
  const prevLastCcbCost = session._lastCcbCumulativeCost
  const turnUsage = createTurnUsageRecorder()
  const recordTurnUsage = (
    terminalStatus: TurnTerminalStatus,
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      costUsd?: number
      model?: string
    },
    turnIndex = Math.max(session.turns, prevTurns + 1),
  ): boolean =>
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
      toolCalls: turnToolCallCount,
      durationMs: Date.now() - turnStartTime,
      terminalStatus,
      ...(requestId ? { requestId } : {}),
      ...(session._currentTurnTraceId ? { traceId: session._currentTurnTraceId } : {}),
    })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    let turn: EngineTurnRun | null = null
    let finalizationDone: Promise<void> | null = null
    let persistTerminalSnapshot:
      | ((
          status: 'interrupted' | 'crashed',
          reason: string,
          errorCode: string,
          settleAfter?: boolean,
          waiveReason?: TurnWaiveReason,
        ) => Promise<void>)
      | null = null
    let requestTerminalPersistence:
      | ((
          status: 'interrupted' | 'crashed',
          reason: string,
          errorCode: string,
          waiveReason?: TurnWaiveReason,
        ) => Promise<void>)
      | null = null
    let requestedTerminal: {
      status: 'interrupted' | 'crashed'
      reason: string
      errorCode: string
      waiveReason?: TurnWaiveReason
    } | null = null
    let terminalRequestEscalated = false

    // Idle timeout — refreshed on every adapter 'activity'(底座每条原始消息,
    // 含 parser 会忽略的消息 —— 与旧 runner 'message' 的 refresh 时机逐条对齐)。
    // A turn is only killed if the agent produces no output for this long, so long
    // active tasks keep running while genuinely stuck turns still get interrupted.
    // Waiting for the user is not silence: re-arm instead of IDLE_TIMEOUT/waiver.
    // The 12h logical-turn hard limit in submit() is unchanged.
    const IDLE_TIMEOUT_MS = pickTurnSilentBackstopMs(session.providerTag, session.model)
    const timer = setTimeout(() => {
      const fire = applyTurnIdleTimeoutTick({
        waitingForUserInput: runner.waitingForUserInput === true,
        finalized: turn?.finalized === true,
        refresh: () => timer.refresh(),
      })
      if (!fire) return
      const duration =
        IDLE_TIMEOUT_MS === BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
          ? '6 小时 15 分钟'
          : IDLE_TIMEOUT_MS === BOX_ACTIVE_TURN_IDLE_MS
            ? '4 小时 5 分钟'
            : '30 分钟'
      const reason = `任务 ${duration}没有新输出，已中断。本轮已自动免单，积分将原路退回；请重试。`
      const persistence =
        requestTerminalPersistence?.('interrupted', reason, 'IDLE_TIMEOUT', 'idle_timeout') ??
        Promise.resolve()
      this._trackPersistence(persistence)
    }, IDLE_TIMEOUT_MS)

    // Buffer 'final' event — only forward to client after auth check passes
    let pendingFinal: SessionStreamEvent | null = null
    let pendingAttemptError: Extract<EngineEvent, { kind: 'error' }> | null = null
    let observedFinalMeta: EngineFinalMeta | undefined
    let terminalEngineBilling: EngineBillingEvent | undefined
    let terminalExternalBilling: EngineExternalBillingEvent | undefined
    let terminalBillingFlushed = false
    const flushTerminalBilling = () => {
      if ((!terminalEngineBilling && !terminalExternalBilling) || terminalBillingFlushed) return
      terminalBillingFlushed = true
      if (terminalEngineBilling) {
        const billing = structuredClone(terminalEngineBilling)
        session._durableDelegateEngineBillings?.push(structuredClone(billing))
        onEvent({ kind: 'codex_billing', ...billing })
      }
      if (terminalExternalBilling)
        onEvent({ kind: 'external_billing', ...structuredClone(terminalExternalBilling) })
    }
    // Engine cold-start visibility (INC-20260824-FIRST-TEXT-LATENCY):
    // while this turn's engine process is spawning/resuming, the browser
    // shows an explicit startup phase instead of a silent 20-40s
    // "thinking" gap. The phase is authoritatively ended HERE on the first
    // observable event (content block / permission card / any successor
    // turn_status / terminal event); the frontend clear-on-content is only
    // a dropped-frame fallback.
    let startupPhaseActive = false
    const emitStartupPhase = (status: 'engine_starting' | 'engine_resuming'): void => {
      startupPhaseActive = true
      onEvent({ kind: 'turn_status', status })
    }
    const clearStartupPhase = (): void => {
      if (!startupPhaseActive) return
      startupPhaseActive = false
      onEvent({ kind: 'turn_status', status: null })
    }
    // Model-thinking visibility: Box Opus max-effort thinks for minutes with
    // EMPTY thinking text, so no visible block arrives and the startup phase
    // used to stick ("正在启动引擎 (136s)"). The adapter's model_progress
    // side channel reports message_start / thinking open-close; message_start
    // ends the startup phase, and while a main-agent thinking block is open
    // a `working` keepalive (detail=thinking) tells the browser the model is
    // thinking. Ticks stop with the turn, so a dead stream still escalates
    // to the client's silence warning.
    let thinkingKeepalive: ReturnType<typeof setInterval> | null = null
    const emitThinkingStatus = (): void => {
      onEvent({
        kind: 'turn_status',
        status: { status: 'working', detail: MODEL_THINKING_WORKING_DETAIL },
      })
    }
    const stopThinkingStatus = (clear: boolean): void => {
      if (!thinkingKeepalive) return
      clearInterval(thinkingKeepalive)
      thinkingKeepalive = null
      if (clear) onEvent({ kind: 'turn_status', status: null })
    }
    const handleModelProgress = (phase: ModelProgressPhase): void => {
      if (detached) return
      clearStartupPhase()
      if (phase === 'thinking_start') {
        if (thinkingKeepalive) return
        emitThinkingStatus()
        thinkingKeepalive = setInterval(() => {
          if (detached) stopThinkingStatus(false)
          else emitThinkingStatus()
        }, MODEL_THINKING_KEEPALIVE_MS)
        thinkingKeepalive.unref?.()
      } else if (phase === 'thinking_stop') {
        stopThinkingStatus(true)
      }
    }
    const handleEngineEvent = (e: EngineEvent) => {
      if (startupPhaseActive) {
        if (e.kind === 'turn_status') {
          // A successor phase owns the activity row from here on. Object
          // phases (working/retrying) do not replace the client's phase
          // state by themselves, so null the startup phase first; string
          // phases (compacting/waiting_for_user/null) overwrite it.
          startupPhaseActive = false
          if (e.status && typeof e.status === 'object') {
            onEvent({ kind: 'turn_status', status: null })
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
      // A successor phase (retrying / compacting / waiting_for_user / null)
      // owns the activity row: stop the thinking keepalive WITHOUT a null so
      // neither a later tick nor thinking_stop overwrites that phase (or the
      // server's reconnect cache of it).
      if (
        e.kind === 'turn_status' ||
        e.kind === 'permission_request' ||
        e.kind === 'error' ||
        e.kind === 'final'
      ) {
        stopThinkingStatus(false)
      }
      if (
        e.kind === 'turn_status' &&
        e.status &&
        typeof e.status === 'object' &&
        e.status.status === 'retrying'
      ) {
        // Codex mutates the shared counter before emitting. Native CCB
        // api_retry has only its own local numbering, so advance it here.
        if (session.providerTag !== 'codex' && automaticRetryState) {
          automaticRetryState.attempt = Math.min(
            automaticRetryState.max,
            automaticRetryState.attempt + 1,
          )
        }
        const shared = automaticRetryState ?? {
          rootClientMessageId: clientMessageId ?? turnKey ?? session.sessionKey,
          attempt: e.status.retry.attempt,
          max: e.status.retry.max,
        }
        const retry = {
          ...e.status.retry,
          attempt: shared.attempt,
          max: shared.max,
        }
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
        return
      }
      // CCB 私有 detected 事件(原 parser onToolUse/onToolResult 回调的升格形态):
      // cron 桥接 + tool.called 指标属 engine 中立编排,在此就地消费,**不进**
      // server.ts 的 outbound 流(与旧回调语义一致)。事件与内容 block 同一条
      // 同步顺序流 —— 触发时序与旧回调逐一对位。
      if (e.kind === 'tool_use_detected') {
        const tool = e.tool
        turnToolCallCount++
        if (tool.name === 'Read') {
          const toolInput = tool.input as unknown as Record<string, unknown>
          const rawPath =
            typeof toolInput.file_path === 'string'
              ? toolInput.file_path
              : typeof toolInput.path === 'string'
                ? toolInput.path
                : null
          if (rawPath) {
            const memoryRoot = resolvePath(paths.agentMemoryDir(session.agentId))
            const target = resolvePath(rawPath)
            if (target.startsWith(`${memoryRoot}/`) && target.endsWith('.md')) {
              memoryReadTargets.set(tool.id, target)
            }
          }
        }
        try {
          applyEfficiencyToolObservation(session, tool, turnToolCallCount)
        } catch (err) {
          log.debug('efficiency guard observe failed', {
            sessionKey: session.sessionKey,
            err: String(err),
          })
        }
        // Bridge CCB CronCreate/CronDelete via EventBus
        if (tool.name === 'CronCreate') {
          const gatewayJobId = `ccb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          if (!session._cronBridgeMap) session._cronBridgeMap = new Map()
          session._cronBridgeMap.set(`_pending:${tool.id}`, gatewayJobId)
          eventBus.emit(
            'task.created',
            createEvent('task.created', session.agentId, {
              taskId: gatewayJobId,
              schedule: tool.input.cron,
              prompt: tool.input.prompt,
              oneshot: tool.input.recurring === false,
              source: 'cron-bridge',
            }),
          )
        } else if (tool.name === 'CronDelete') {
          const ccbId = tool.input.id
          const gatewayId = session._cronBridgeMap?.get(ccbId) ?? ccbId
          eventBus.emit(
            'task.deleted',
            createEvent('task.deleted', session.agentId, {
              taskId: gatewayId,
            }),
          )
        }
        return
      }
      if (e.kind === 'tool_result_detected') {
        const tr = e.result
        const memoryTarget = memoryReadTargets.get(tr.toolUseId)
        memoryReadTargets.delete(tr.toolUseId)
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
          }).catch(() => {})
        }
        if (tr.toolName === 'CronCreate' && !tr.isError && session._cronBridgeMap) {
          const pendingKey = `_pending:${tr.toolUseId}`
          const gatewayJobId = session._cronBridgeMap.get(pendingKey)
          if (gatewayJobId) {
            session._cronBridgeMap.delete(pendingKey)
            const match = /job\s+([0-9a-f]{6,12})/i.exec(tr.preview)
            if (match) {
              session._cronBridgeMap.set(match[1], gatewayJobId)
            }
          }
        }
        // Emit tool.called for metrics / observability.
        // turnIndex is 1-indexed to match turn.completed semantics:
        // session.turns is still pre-increment during tool processing
        // (incremented inside parser._handleResult after this path runs).
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
            ...(tr.terminationReason !== undefined
              ? { terminationReason: tr.terminationReason }
              : {}),
          }),
        )
        return
      }
      if (e.kind === 'context_pressure') {
        eventBus.emit('session.context_pressure', createEvent('session.context_pressure', session.agentId, {
          sessionKey: session.sessionKey, ...e.pressure,
        }))
      }
      if (e.kind === 'call_usage') {
        const call: CallTokenUsageSnapshot = {
          ...structuredClone(e.call),
          callId: `a${attemptOrdinal + 1}-${e.call.callId}`,
        }
        for (const targetId of call.targetIds) {
          callUsageByTarget.set(targetId, call)
        }
        onEvent({ kind: 'call_usage', call })
        return
      }
      if (
        e.kind === 'block' &&
        (e.block.kind === 'plan' || e.block.kind === 'goal') &&
        !e.block.parentToolUseId
      ) {
        structuredBlocks.push({
          ...(structuredClone(e.block) as OutboundContentBlock),
          _ocObservedAt: Date.now(),
          _ocEventOrdinal:
            typeof (e.block as Record<string, unknown>)._ocEventOrdinal === 'number'
              ? (e.block as Record<string, unknown>)._ocEventOrdinal
              : takeDurableEventOrdinal(session),
        })
      }
      // Track all observable output for phantom-turn detection.
      // permission_request counts as real output too (visible permission card),
      // so it must NOT be flagged as phantom even if usage is 0.
      if (e.kind === 'block') turnBlockCount++
      else if (e.kind === 'permission_request') turnPermissionCount++
      if (e.kind === 'final') {
        observedFinalMeta = e.meta ? { ...e.meta } : undefined
        pendingFinal = e
        return
      }
      if (e.kind === 'error') {
        // Native errors describe an attempt, not the logical turn. The adapter
        // keeps their raw runtime events for the tape. Only the acknowledged
        // result/partial terminal below may publish a user-facing error; a
        // retry (or a later successful result) must never flash a red card.
        pendingAttemptError = e
        return
      }
      onEvent(e)
    }

    // adapter 'activity' = 底座每条原始消息到达。detach 后不再 refresh:旧实现
    // 靠 `!detached` guard(listener 跨 turn 保留),现 listener 在 detach 卸载,
    // guard 留作 belt-and-braces(卸载与 emit 同 tick 竞争时不重臂已清的 timer)。
    const handleActivity = () => {
      if (!detached) timer.refresh()
    }
    // M1a — engine-reported 计费侧信道(codex)。adapter 在 turn 终态 result
    // 帧上 emit 'billing'(先于 parser 产出 'final',顺序与 P1f 前一致);这里
    // 包装成 SessionStreamEvent 'codex_billing' 直通 onEvent → server.ts 发
    // outbound.codex_billing 帧给 master 做真扣费 settle(M2)。
    //   - 直调 onEvent 而非 handleEngineEvent:billing 帧不计 turnBlockCount /
    //     turnPermissionCount,phantom 判定不把 billing 当"输出"(旧语义)。
    //   - `!detached` guard:turn 已 idle/error 收尾后不再补发,防二次 settle。
    //   - CCB(billingMode:'proxy')永不 emit 'billing',本 listener 是 no-op。
    const handleBilling = (b: EngineBillingEvent) => {
      if (detached) return
      // Do not let a transient attempt's error billing claim the logical
      // request before a later successful retry. finalize/partial persistence
      // flushes exactly the one terminal attempt; the tape remains the
      // durable fallback for a lost live frame.
      terminalEngineBilling = structuredClone(b)
    }
    const handleExternalBilling = (b: EngineExternalBillingEvent) => {
      if (!detached) terminalExternalBilling = structuredClone(b)
    }
    // Per-turn parse_error listener (previously only installed at runner
    // construction). Must be detached with the rest to avoid per-turn
    // listener accumulation (R9).
    // Per-turn spawn listener: upgrades/announces the startup phase with
    // resume attribution. CCB emits 'spawn' only on cold start; cursor/grok
    // one-shot CLIs emit it on every turn (their cold start IS per turn).
    const handleSpawn = (info: { resumed?: boolean }) => {
      if (detached) return
      emitStartupPhase(info?.resumed ? 'engine_resuming' : 'engine_starting')
    }
    const handleParseError = (payload: { line: string; err?: unknown; error?: unknown }) => {
      const rawError = payload.err ?? payload.error
      const err = rawError as Error | undefined
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
    }

    let detached = false
    // A subprocess exit and the final result line can cross in the stdout
    // drain window. Exactly one terminal snapshot may own this logical turn;
    // otherwise completed and crash-flush payloads would contend for the
    // same immutable turn key. Normal completion wins until the crash timer
    // explicitly freezes the parser and claims the partial snapshot.
    let terminalPersistenceClaim: 'none' | 'complete' | 'partial' = 'none'
    const detach = () => {
      if (detached) return
      detached = true
      if (session._persistActiveTurn === requestTerminalPersistence) {
        session._persistActiveTurn = undefined
      }
      clearTimeout(timer)
      // 等价旧 parser.finish():幂等终结本 turn(summary 以当前累积态 resolve)。
      // turn-scoped 句柄保证 stale detach 不波及后继 turn(旧
      // `session._currentParser === parser` identity guard 收在 adapter 内)。
      turn?.end()
      // 故意不清 adapter 的 stdout 路由:CCB 的 bg bash 在 turn 结束后仍 emit
      // bash_output_tail,需要继续流经 finalized parser(放行 tail)→
      // handleEngineEvent → onEvent → this.deliver。下一轮 submitTurn 会替换
      // 路由,旧闭包链届时被 GC。telemetry 的 per-turn 作用域由 adapter 在
      // turn 终态时清(旧 runner.off('telemetry') 的对位物)。
      runner.off('activity', handleActivity)
      runner.off('billing', handleBilling)
      runner.off('external_billing', handleExternalBilling)
      runner.off('error', handleError)
      runner.off('exit', handleExit)
      runner.off('parse_error', handleParseError)
      runner.off('spawn', handleSpawn)
      runner.off('model_progress', handleModelProgress)
      stopThinkingStatus(false)
    }

    const retainedTerminalErrors = new Set<string>()
    const retainTerminalError = (
      status: 'interrupted' | 'crashed',
      reason: string,
      errorCode: string,
    ): void => {
      const identity = `${status}\0${errorCode}\0${reason}`
      if (retainedTerminalErrors.has(identity)) return
      retainedTerminalErrors.add(identity)
      retryRuntimeEvents.push({
        ordinal: takeDurableEventOrdinal(session),
        observedAt: Date.now(),
        source: 'gateway',
        payload: { type: 'terminal_error', status, code: errorCode, detail: reason },
      })
    }

    let partialPersistencePromise: Promise<void> | null = null
    persistTerminalSnapshot = (
      status: 'interrupted' | 'crashed',
      reason: string,
      errorCode: string,
      settleAfter = true,
      waiveReason?: TurnWaiveReason,
    ): Promise<void> => {
      if (terminalPersistenceClaim !== 'none') {
        return partialPersistencePromise ?? Promise.resolve()
      }
      terminalPersistenceClaim = 'partial'
      partialPersistencePromise = (async () => {
        let persistenceAcknowledged = !MASTER_SINK_PERSIST_CHANNELS.has(session.channel)
        let persistenceQueuedToOutbox = false
        detach()
        if (
          status === 'interrupted' &&
          errorCode === 'USER_CANCELLED' &&
          terminalEngineBilling?.status === 'error'
        ) {
          terminalEngineBilling = {
            ...terminalEngineBilling,
            terminalCode: 'USER_CANCELLED',
          }
        }
        flushTerminalBilling()
        const snap = turn?.getPartialSnapshot() ?? {
          assistantText: '',
          thinkingText: '',
          completedTools: [],
          assistantSegments: [],
          thinkingSegments: [],
          runtimeEvents: [],
        }
        // OCV5-180 B1 — terminal partial persist 也是 payload 冻结点:exact-owner
        // drain + 同步 seal(与 completed 路径同一封口语义)。
        const partialAgentGroups = this.drainPendingAgentGroups(session, turnKey)
        retainTerminalError(status, reason, errorCode)
        const terminalRuntimeEvents = [
          ...retryRuntimeEvents.map((event) => structuredClone(event)),
          ...snap.runtimeEvents,
        ]
        const partialAssistant = combineRetryAssistantOutput(
          retryAssistantSegments,
          snap.assistantText,
          freezeSegments(snap.assistantSegments, assistantMessageId),
          Date.now(),
        )
        const partialThinking = combineRetryAssistantOutput(
          retryThinkingSegments,
          snap.thinkingText,
          freezeSegments(snap.thinkingSegments, thinkingMessageId),
          Date.now(),
        )
        const partialTools = [
          ...retryTools.map((tool) => structuredClone(tool)),
          ...freezeTools(snap.completedTools),
        ]
        const partialStructuredBlocks = [
          ...retryStructuredBlocks.map((block) => structuredClone(block)),
          ...freezeStructuredBlocks(structuredBlocks),
        ]
        if (session._durableDelegateRuntimeEvents) {
          session._durableDelegateRuntimeEvents.push(
            ...terminalRuntimeEvents.map((event) => structuredClone(event)),
          )
        }
        try {
          if (MASTER_SINK_PERSIST_CHANNELS.has(session.channel)) {
            const turnIndex = prevTurns + 1
            session.turns = Math.max(session.turns, turnIndex)
            scheduleSessionOutputAssetCollection({
              userId: session.userId,
              chatProjectId: session.turnChatProjectId,
              sessionId: session.peerId,
              assistantText: partialAssistant.text,
              sessionKey: session.sessionKey,
              ...(traceId ? { traceId } : {}),
            })
            // E6 — Outcome 版本识别 'queued'(语义同 finalizeTurn 主路径)。
            const partialOutcome = await persistServerAuthoredTurnOutcome({
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
              text: partialAssistant.text,
              ...(partialThinking.text.length > 0 ? { thinkingText: partialThinking.text } : {}),
              status,
              errorCode,
              errorDetail: reason,
              usage: terminalUsageForPersistence({
                finalMeta: observedFinalMeta,
                billing: terminalEngineBilling,
                traceId,
                turnIndex,
                model: session.model,
              }),
              ...(requestId ? { requestId } : {}),
              ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
              ...(partialTools.length > 0 ? { tools: partialTools } : {}),
              ...(partialAssistant.segments.length > 0
                ? { assistantSegments: partialAssistant.segments }
                : {}),
              ...(partialThinking.segments.length > 0
                ? { thinkingSegments: partialThinking.segments }
                : {}),
              ...(partialAgentGroups.length > 0 ? { agentGroups: partialAgentGroups } : {}),
              ...(partialStructuredBlocks.length > 0
                ? { structuredBlocks: partialStructuredBlocks }
                : {}),
              runtimeEvents: terminalRuntimeEvents,
              ...(terminalEngineBilling !== undefined
                ? { engineBilling: terminalEngineBilling }
                : {}),
            })
            if (turnKey)
              this._settleDrainedOwnerGroups(session, turnKey, partialAgentGroups, partialOutcome)
            persistenceAcknowledged = partialOutcome === 'acked' || partialOutcome === 'skipped'
            // 同 finalizeTurn 主路径:降级投递仅限个人版本地 outbox;商用 v3
            // sink 的 queued 保持静默(master ACK 权威,契约测试锁此语义)。
            persistenceQueuedToOutbox =
              getV3MasterSinkOrNull() === null && partialOutcome === 'queued'
          }
        } finally {
          const usageForLog = terminalUsageForPersistence({
            finalMeta: observedFinalMeta,
            billing: terminalEngineBilling,
            traceId,
            turnIndex: prevTurns + 1,
            model: session.model,
          })
          recordTurnUsage(
            mapTurnTerminalStatus({ persistStatus: status, errorCode }),
            {
              inputTokens: usageForLog.inputTokens,
              outputTokens: usageForLog.outputTokens,
              cacheReadTokens: usageForLog.cacheReadTokens,
              cacheCreationTokens: usageForLog.cacheCreationTokens,
              model: session.model,
            },
            prevTurns + 1,
          )
          // A queued tape is durable locally but not yet visible from the
          // authoritative PG history. Never expose a terminal frame until
          // the master has ACKed it; reconnect/relogin must not turn a live
          // "finished" reply into a missing one.
          // E4.2 — handleExit/interrupt 已分类的终态码(RUNNER_CRASHED /
          // SERVICE_RESTART / USER_CANCELLED …)透传 wire 子集,不再让 server
          // 对「子进程异常退出 (code 1)」这类原文正则分类压成 upstream_failed。
          if (persistenceAcknowledged) {
            const wireCode = _wireTerminalCodeForTape(errorCode)
            onEvent(
              _asEngineErrorEvent({
                kind: 'error',
                error: reason,
                ...(wireCode ? { errorCode: wireCode } : {}),
              }),
            )
          } else if (persistenceQueuedToOutbox) {
            // E6 — queued 降级终态(语义同 finalizeTurn 主路径):不静默卡住。
            log.warn('partial terminal delivered in degraded persist-queued mode', {
              sessionKey: session.sessionKey,
              errorCode,
              ...(traceId ? { traceId } : {}),
            })
            onEvent(
              _asEngineErrorEvent({
                kind: 'error',
                error: reason || SESSION_PERSIST_QUEUED_NOTICE,
                errorCode: 'session_persist_unavailable',
              }),
            )
          }
          if (settleAfter) settle(() => resolve())
        }
      })()
      return partialPersistencePromise
    }

    let terminalRequestPromise: Promise<void> | null = null
    requestTerminalPersistence = (
      status: 'interrupted' | 'crashed',
      reason: string,
      errorCode: string,
      waiveReason?: TurnWaiveReason,
    ): Promise<void> => {
      // Record the terminal observation immediately, before a cooperative
      // interrupt can produce more engine events. Its global ordinal thus
      // reconstructs the exact live ordering after refresh.
      requestedTerminal ??= { status, reason, errorCode, ...(waiveReason ? { waiveReason } : {}) }
      retainTerminalError(status, reason, errorCode)
      if (terminalRequestPromise) return terminalRequestPromise
      terminalRequestPromise = (async () => {
        const activeTurn = turn
        if (!activeTurn) {
          await Promise.resolve()
          if (!turn) {
            await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
            return
          }
        }

        try {
          runner.interrupt(
            status === 'interrupted' && errorCode === 'USER_CANCELLED' ? 'user' : 'system',
          )
        } catch {}

        // Give a cooperative interrupt one short window to produce its own
        // usage-bearing terminal result. If it does, normal finalization is
        // authoritative and already includes the gateway terminal event.
        const targetTurn = turn!
        let summaryFinished = false
        let timerHandle: NodeJS.Timeout | null = null
        await Promise.race([
          targetTurn.summary.then(() => {
            summaryFinished = true
          }),
          new Promise<void>((resolveWait) => {
            timerHandle = setTimeout(resolveWait, this._terminalRequestGraceMs)
          }),
        ])
        if (timerHandle) clearTimeout(timerHandle)
        if (summaryFinished) {
          await finalizationDone
          await partialPersistencePromise
          if (terminalPersistenceClaim === 'none') {
            await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
          }
          return
        }

        // No result: terminate the process generation, then wait beyond the
        // supervisor's bounded shutdown return until its stdout really
        // closes. This is the no-loss barrier for escaped descendants that
        // still hold the pipe after SIGKILL.
        if (status === 'interrupted' && errorCode === 'USER_CANCELLED') {
          terminalRequestEscalated = true
        }
        try {
          await runner.shutdown()
        } catch (err) {
          retainTerminalError(
            'crashed',
            `runner shutdown failed: ${String(err)}`,
            'RUNNER_SHUTDOWN_FAILED',
          )
        }
        await this._awaitBoundedOutputDrain(runner, session)
        // Let synchronously parsed final/result frames schedule their
        // summary/finalization microtasks before deciding a partial is needed.
        await Promise.resolve()
        if (targetTurn.finalized) {
          await finalizationDone
          await partialPersistencePromise
          return
        }
        await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
      })()
      return terminalRequestPromise
    }
    session._persistActiveTurn = requestTerminalPersistence

    // == turn 终态后处理(原 parser onFinish 主体,改为消费 TurnSummary)==
    // 由下方 turn.summary.then(finalizeTurn) 触发:正常终态带 summary(engine
    // 中立汇总),异常终态(error/exit/timeout 经 detach → turn.end 强制收尾)
    // 为 null —— 与旧 onFinish(result | null) 语义一致。时序:parser onFinish →
    // summary resolve → microtask 执行本函数,期间不会有新的 stdout 宏任务插入,
    // 后处理相对底座输出流的顺序与旧同步实现一致(含 crash 路径下
    // _pendingStaleResumeClear 先于 getOrCreate 'exit' handler 可见)。
    const finalizeTurn = async (result: TurnSummary | null): Promise<void> => {
      if (terminalPersistenceClaim === 'partial') return
      detach()
      if (result?.nativeCompactionSummary) {
        session._lastNativeCompactionSummary = result.nativeCompactionSummary
      }
      if (modelSwitchTransition && session._modelSwitchTransition === modelSwitchTransition) {
        if (result && !result.isError) session._modelSwitchTransition = undefined
        else {
          modelSwitchTransition.state = 'prepared'
          modelSwitchTransition.summaryInjected = false
        }
      }
      let persistenceAcknowledged = true
      // E6 — 'queued'(queued_to_outbox)三态旁路:本地已可靠排队但权威库未
      // 确认。不算 acknowledged(paid-turn 完成语义不变),但也不能静默不投递
      // 终态 —— 那会让用户永远停在「思考中」。
      let persistenceQueuedToOutbox = false
      let terminalErrorForClient: string | undefined
      let terminalErrorCodeForClient: GatewayTerminalErrorCode | undefined

      // Detect stale --resume session id. CCB emits an error result with
      // `errors: ["No conversation found with session ID: <id>"]` when
      // the JSONL file for the requested resume id is missing on disk.
      // Flag the session so the upcoming runner.exit handler evicts the
      // entry from resume-map; otherwise every subsequent submit()
      // re-spawns CCB with the same dead id and loops forever.
      if (result?.staleResumeId) {
        // Circuit breaker: the id the engine REFUSED is named in the error,
        // not in session.ccbSessionId (CCB already minted a fresh id before
        // failing to load the old one). Without this the crash handler's
        // ladder walk re-promoted the same on-disk-but-unloadable id forever.
        const refused = this._markResumeRejectedFromError(
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
        session.totalCostUSD = prevCostUSD
        session.turns = prevTurns
        session._lastCcbCumulativeCost = prevLastCcbCost
        await persistTerminalSnapshot?.(
          'crashed',
          result.errorDetail ?? 'Previous engine session is no longer available',
          'STALE_RESUME_ID',
          false,
        )
        settle(() =>
          reject(
            new Error(
              'STALE_RESUME_ID: Previous session file missing; next submit will start fresh',
            ),
          ),
        )
        return
      }

      if (session.providerTag === 'grok' && !session.runner.nativeSessionId) {
        // Grok native sessions are dirtied by interrupt, crash without
        // `end`, or a hung `--resume` that was cold-started without PG
        // tape. Drop the resume-map head so the next submit does not
        // --resume that id; OpenClaude history injection fills the gap.
        this._forgetResumeEntry(session.sessionKey)
        session.ccbSessionId = null
        session._historicalContextInjected = false
        session._historicalContextInjectedKey = undefined
        session._forceHistoricalContextOnFirstTurn = true
        session._contextRebuildNotice = 'native-resume-loss'
        this._saveResumeMap()
      }

      const terminalResultErrorClass =
        result?.errorClass ?? classifyRunError(result?.errorDetail).code
      if (
        terminalResultErrorClass === 'context_too_long' &&
        (session.providerTag === 'ccb' || session.providerTag === 'codex')
      ) {
        log.warn('native context window exhausted; clearing resume before context rebuild', {
          sessionKey: session.sessionKey,
          provider: session.providerTag,
          ...(traceId ? { traceId } : {}),
        })
        await runner.shutdown()
        this._resumeMap.delete(session.sessionKey)
        this._resumeMapTimestamps.delete(session.sessionKey)
        this._resumeMapProvider.delete(session.sessionKey)
        this._resumeMapLastCost.delete(session.sessionKey)
        this._resumeMapCostImprecise.delete(session.sessionKey)
        this._resumeMapHistory.delete(session.sessionKey)
        session.ccbSessionId = null
        runner.clearSessionId?.()
        this._saveResumeMap()
        session._historicalContextInjected = false
        session._historicalContextInjectedKey = undefined
      }

      // Detect auth error — roll back counters and reject. 分类逻辑(isError +
      // 关键字宽匹配 / CCB 精确错误前缀)已下沉 CcbAdapter(底座私有知识),
      // 本层只消费 errorKind === 'auth'。
      if (result?.errorKind === 'auth' && retryAuthErrors) {
        retryRuntimeEvents.push(...result.runtimeEvents.map((event) => structuredClone(event)))
        session.totalCostUSD = prevCostUSD
        session.turns = prevTurns
        session._lastCcbCumulativeCost = prevLastCcbCost
        settle(() => reject(new Error('AUTH_ERROR: Token expired or invalid')))
        return
      }

      const transientErrorClass = terminalResultErrorClass
      const contextOverflowHasUsage =
        result !== null &&
        (result.usage.cost !== 0 ||
          result.usage.inputTokens !== 0 ||
          result.usage.outputTokens !== 0 ||
          result.usage.cacheReadTokens !== 0 ||
          result.usage.cacheCreationTokens !== 0 ||
          Object.values(terminalEngineBilling?.usage ?? {}).some(
            (value) => typeof value === 'number' && value !== 0,
          ))
      const ccbContextDiagnostic =
        session.providerTag === 'ccb' &&
        result !== null &&
        result.assistantSegments.length === 1 &&
        (/^API Error:\s*413\b[\s\S]*\bPROMPT_TOO_LONG\b[\s\S]*$/i.test(
          result.assistantSegments[0]!.text.trim(),
        ) ||
          /^Prompt is too long\.?$/i.test(result.assistantSegments[0]!.text.trim())) &&
        result.assistantText.trim() === result.assistantSegments[0]!.text.trim()
      const contextOverflowIsSafeToRetry =
        result !== null &&
        transientErrorClass === 'context_too_long' &&
        (session.providerTag === 'ccb' || session.providerTag === 'codex') &&
        (session.providerTag === 'codex' || ccbContextDiagnostic) &&
        turnBlockCount === (ccbContextDiagnostic ? 1 : 0) &&
        turnPermissionCount === 0 &&
        turnToolCallCount === 0 &&
        structuredBlocks.length === 0 &&
        (result.assistantText.length === 0 || ccbContextDiagnostic) &&
        result.thinkingText.length === 0 &&
        (result.assistantSegments.length === 0 || ccbContextDiagnostic) &&
        result.thinkingSegments.length === 0 &&
        result.tools.length === 0 &&
        !contextOverflowHasUsage
      const checkpointSafe = assessTurnRecoveryTape(
        freezeTools(result?.tools ?? []).map((tool) => ({
          role: 'tool',
          ...tool,
          // TurnToolEntry omits completed for a matched result; the
          // durable recovery contract requires an explicit terminal bit.
          _completed: tool.completed !== false,
        })),
      ).checkpointSafe
      const nativeContinuationSafe = isNativeEngineTransientContinuationSafe({
        providerTag: session.providerTag,
        nativeSessionId: session.runner.nativeSessionId,
        ccbSessionId: session.ccbSessionId,
        permissionCount: turnPermissionCount,
        tools: result?.tools ?? [],
      })
      // Native continuation is not a replay: TRANSIENT_RETRY_INPUT resumes
      // the same engine session. Completed Bash is therefore safe here.
      const transientContinuationIsSafe =
        turnPermissionCount === 0 && (checkpointSafe || nativeContinuationSafe)
      if (
        result?.isError &&
        retryTransientErrors &&
        transientContinuationIsSafe &&
        (TRANSIENT_RETRY_ERROR_CODES.has(transientErrorClass) || contextOverflowIsSafeToRetry)
      ) {
        retryRuntimeEvents.push(...result.runtimeEvents.map((event) => structuredClone(event)))
        const frozenAttemptAssistantSegments = freezeSegments(
          result.assistantSegments,
          assistantMessageId,
        )
        const attemptAssistantSegments =
          frozenAttemptAssistantSegments.length > 0
            ? frozenAttemptAssistantSegments
            : result.assistantText.length > 0
              ? [{ index: 0, text: result.assistantText, ts: Date.now() }]
              : []
        retryAssistantSegments.push(
          ...attemptAssistantSegments.map((segment, index) => ({
            ...segment,
            index: retryAssistantSegments.length + index,
          })),
        )
        const frozenAttemptThinkingSegments = freezeSegments(
          result.thinkingSegments,
          thinkingMessageId,
        )
        const attemptThinkingSegments =
          frozenAttemptThinkingSegments.length > 0
            ? frozenAttemptThinkingSegments
            : result.thinkingText.length > 0
              ? [{ index: 0, text: result.thinkingText, ts: Date.now() }]
              : []
        retryThinkingSegments.push(
          ...attemptThinkingSegments.map((segment, index) => ({
            ...segment,
            index: retryThinkingSegments.length + index,
          })),
        )
        retryTools.push(...freezeTools(result.tools))
        retryStructuredBlocks.push(...freezeStructuredBlocks(structuredBlocks))
        session.totalCostUSD = prevCostUSD
        session.turns = prevTurns
        session._lastCcbCumulativeCost = prevLastCcbCost
        // The failed attempt is free and must not claim the shared
        // request/turn identity before the terminal attempt.
        terminalEngineBilling = undefined
        const retryError = result.errorDetail ?? `${transientErrorClass}: transient model failure`
        settle(() =>
          reject(
            contextOverflowIsSafeToRetry && session.providerTag === 'ccb'
              ? new SafeCcbContextRebuildRetryError(retryError)
              : result.retryHint
                ? new Upstream429RetryError(retryError, result.retryHint)
                : new Error(retryError),
          ),
        )
        return
      }

      const modelAuthorityFailure = result?.errorKind === 'model_authority'
      const modelAuthorityReason = modelAuthorityFailure
        ? '任务运行时间较长，平台执行凭证未能继续。本轮已自动免单，积分将原路退回；你可以重新尝试。'
        : undefined
      // A generic runner error may be emitted before the remaining stdout
      // drains into a valid terminal result (pipe/error ordering). Preserve
      // that diagnostic runtime event, but only a platform-owned waiver or
      // an engine-confirmed user cancellation may override the summary.
      // If Stop races a natural end_turn, completion remains authoritative.
      // CCB confirms its cooperative AbortController path with an
      // error_during_execution result instead of stopReason='interrupted'.
      // Streaming-phase aborts carry stop_reason=null; a Stop that lands
      // while a tool call is executing (query.ts aborted_tools) yields the
      // "[Request interrupted by user for tool use]" user message and keeps
      // the last API stop_reason=tool_use. Both are the same user action.
      const ccbUserCancellationResult =
        session.providerTag === 'ccb' &&
        result?.isError === true &&
        isCcbUserCancellationDiagnostic(result.errorDetail, result.stopReason)
      const engineUserCancellationResult = result
        ? session.runner.isUserCancellationResult?.(result) === true
        : false
      const userCancellationOverride =
        requestedTerminal?.status === 'interrupted' &&
        requestedTerminal.errorCode === 'USER_CANCELLED' &&
        (result?.stopReason === 'interrupted' ||
          ccbUserCancellationResult ||
          engineUserCancellationResult ||
          (terminalRequestEscalated &&
            result?.isError === true &&
            result.stopReason !== 'end_turn' &&
            terminalEngineBilling?.status === 'error' &&
            terminalEngineBilling.terminalCode === 'CODEX_ERROR' &&
            result.errorDetail?.includes('"result":"codex app-server exited code=') === true))
          ? requestedTerminal
          : null
      const systemInterruptionOverride =
        requestedTerminal?.status === 'interrupted' &&
        requestedTerminal.errorCode === 'SYSTEM_INTERRUPT' &&
        (result?.stopReason === 'interrupted' ||
          ccbUserCancellationResult ||
          engineUserCancellationResult)
          ? requestedTerminal
          : null
      if (userCancellationOverride && terminalEngineBilling?.status === 'error') {
        // A forced Codex app-server shutdown reports a generic CODEX_ERROR
        // because the runner cannot know why its process was killed. At
        // this layer both sides are authoritative: the browser requested
        // USER_CANCELLED and the engine confirmed an interrupted result.
        // Keep billing/audit classification aligned with the tape.
        terminalEngineBilling = {
          ...terminalEngineBilling,
          terminalCode: 'USER_CANCELLED',
        }
      }
      let terminalOverride =
        (requestedTerminal?.waiveReason
          ? requestedTerminal
          : (userCancellationOverride ?? systemInterruptionOverride)) ??
        (modelAuthorityFailure
          ? {
              status: 'crashed' as const,
              reason: modelAuthorityReason!,
              errorCode: 'MODEL_AUTHORITY_EXPIRED',
              waiveReason: 'platform_authority_expired' as const,
            }
          : null)
      if (terminalOverride) {
        retainTerminalError(
          terminalOverride.status,
          terminalOverride.reason,
          terminalOverride.errorCode,
        )
      }

      // Phantom-turn detection — three-state logic (v3):
      //   - apiState='skipped'  → CCB explicitly said no API call
      //                           (slash command path). Normal completion,
      //                           zero cost is expected, NOT phantom.
      //   - apiState='called'   → CCB explicitly fired willCallApi.
      //                           Cannot be phantom. If the result row is
      //                           missing stop_reason AND no blocks came
      //                           out, note `incomplete` for diagnostics
      //                           but don't roll back.
      //   - apiState='unknown'  → No telemetry arrived (e.g. old CCB,
      //                           disabled kill switch, emit swallowed an
      //                           error). Fall back to the legacy 9-AND
      //                           heuristic so behavior is strictly ≤
      //                           pre-refactor (R7: never fail closed).
      // See docs/ccb-telemetry-refactor-plan.md §5.4.
      const userInputStr = typeof userTextOrBlocks === 'string' ? userTextOrBlocks : null
      const isStringInput = userInputStr !== null
      const isSlashCommand = isStringInput && userInputStr!.trimStart().startsWith('/')

      // phantom 信号经 turn 句柄读(异常终态 result=null 时仍可读 —— 旧实现
      // 在 onFinish(null) 里同样消费 telemetry signals;正常终态与
      // result.phantomSignals 同源同值)。
      const signals = turn!.getPhantomSignals()
      let isPhantomTurn = false
      switch (signals.apiState) {
        case 'skipped':
          log.info('turn.skipped (telemetry)', {
            sessionKey: session.sessionKey,
            reason: signals.skipReason,
            ...(traceId ? { traceId } : {}),
          })
          isPhantomTurn = false
          break
        case 'called':
          isPhantomTurn = false
          if (result && !result.stopReason && turnBlockCount === 0 && turnPermissionCount === 0) {
            // Correlate with turn.apiResponse (if received) to distinguish
            // "stream ended mid-flight" from "stream never finished" —
            // apiResponse fires only after stream loop completes, so its
            // absence here means CCB's stream completed without producing
            // an assistant message. 诊断字段由 CcbAdapter 在汇总时快照
            // (result.diagnostics);incompleteCount 恒为 1 —— telemetry
            // channel 是 per-turn 实例,旧 noteIncomplete/getIncompleteCount
            // 组合在此路径的取值恒等于 1。
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
          break
        case 'unknown':
          // Legacy 9-AND heuristic (unchanged from pre-refactor)
          isPhantomTurn =
            !!result &&
            isStringInput &&
            !isSlashCommand &&
            !result.isError &&
            result.usage.inputTokens === 0 &&
            result.usage.outputTokens === 0 &&
            result.usage.cacheReadTokens === 0 &&
            result.usage.cacheCreationTokens === 0 &&
            result.usage.cost === 0 &&
            turnToolCallCount === 0 &&
            turnBlockCount === 0 &&
            turnPermissionCount === 0
          break
      }
      if (terminalOverride) isPhantomTurn = false

      if (isPhantomTurn) {
        if (result && retryPhantomErrors) {
          retryRuntimeEvents.push(...result.runtimeEvents.map((event) => structuredClone(event)))
        }
        // Roll back parser-mutated counters (parser already incremented
        // turns and may have touched cost/cumulative even if delta was 0).
        session.totalCostUSD = prevCostUSD
        session.turns = prevTurns
        session._lastCcbCumulativeCost = prevLastCcbCost
        log.warn('phantom turn — CCB returned empty result without invoking model', {
          sessionKey: session.sessionKey,
          turnIndex: session.turns + 1,
          durationMs: Date.now() - turnStartTime,
          ...(traceId ? { traceId } : {}),
        })
        if (retryPhantomErrors) {
          settle(() => reject(new Error('PHANTOM_TURN: CCB returned empty result')))
        } else {
          await persistTerminalSnapshot?.(
            'crashed',
            '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
            'PHANTOM_TURN',
            true,
            'no_response',
          )
        }
        return
      }

      // Proxy billing already treats a successfully metered call with
      // zero output tokens as no-response and charges 0. Carry the same
      // exact reason onto the terminal tape so that decision is never a
      // silent waiver: even a zero-debit turn gets one inbox receipt.
      if (
        !terminalOverride &&
        result &&
        result.usage.outputTokens === 0 &&
        (result.usage.inputTokens > 0 ||
          result.usage.cacheReadTokens > 0 ||
          result.usage.cacheCreationTokens > 0)
      ) {
        terminalOverride = {
          status: 'crashed',
          reason: '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
          errorCode: 'NO_RESPONSE',
          waiveReason: 'no_response',
        }
        retainTerminalError(
          terminalOverride.status,
          terminalOverride.reason,
          terminalOverride.errorCode,
        )
      }

      // 连一次模型调用的 token 都没有、也没有任何可见产出时，不能记成 completed
      // 再补「本轮未能产出可见回复」。那句话会变成假正文，评价和操作栏都会贴上去。
      const retryAssistantPreview = retryAssistantSegments.map((segment) => segment.text).join('')
      if (
        !terminalOverride &&
        result &&
        shouldFailClosedEmptyModelTurn({
          status: 'completed',
          assistantText: `${retryAssistantPreview}${result.assistantText ?? ''}`,
          outputTokens: result.usage.outputTokens,
          inputTokens: result.usage.inputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          toolCallCount: turnToolCallCount,
          blockCount: turnBlockCount,
          structuredBlockCount: structuredBlocks.length,
          apiState: signals.apiState,
          isSlashCommand,
          isError: result.isError === true,
        })
      ) {
        terminalOverride = {
          status: 'crashed',
          reason: '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
          errorCode: 'NO_RESPONSE',
          waiveReason: 'no_response',
        }
        retainTerminalError(
          terminalOverride.status,
          terminalOverride.reason,
          terminalOverride.errorCode,
        )
      }

      // Update session accumulators from turn result
      if (result) {
        const persistedResultStatus = terminalOverride?.status
          ?? (result.isError || result.errorDetail !== undefined ? 'crashed' : 'completed')
        terminalPersistenceClaim = 'complete'
        flushTerminalBilling()
        const completedAssistantRaw = normalizeAssistantOutputUiFences(
          combineRetryAssistantOutput(
            retryAssistantSegments,
            result.assistantText,
            freezeSegments(result.assistantSegments, assistantMessageId),
            Date.now(),
          ),
        )
        const completedAssistantText = emptyCompletedTurnAssistantText({
          status: persistedResultStatus,
          errorCode: terminalOverride?.errorCode,
          assistantText: completedAssistantRaw.text,
        })
        const completedAssistant =
          completedAssistantText === completedAssistantRaw.text
            ? completedAssistantRaw
            : { text: completedAssistantText, segments: completedAssistantRaw.segments }
        const completedThinking = combineRetryAssistantOutput(
          retryThinkingSegments,
          result.thinkingText,
          freezeSegments(result.thinkingSegments, thinkingMessageId),
          Date.now(),
        )
        const completedTools = [
          ...retryTools.map((tool) => structuredClone(tool)),
          ...freezeTools(result.tools),
        ]
        const completedStructuredBlocks = [
          ...retryStructuredBlocks.map((block) => structuredClone(block)),
          ...freezeStructuredBlocks(structuredBlocks),
        ]
        const pricedUsd = await applyPlatformCostIfMissing({
          model: session.model,
          usage: result.usage,
          sessionCostUsd: session.totalCostUSD,
          prevCostUsd: prevCostUSD,
          waiveReason: terminalOverride?.waiveReason,
          agentId: session.agentId,
          engine: session.providerTag,
          isError: result.isError,
          terminalBillingStatus: terminalExternalBilling?.status ?? terminalEngineBilling?.status,
        })
        if (pricedUsd != null) {
          session.totalCostUSD = prevCostUSD + pricedUsd
          // Gateway-side catalog backfill is an estimate unless the engine
          // reports vendor USD. Keep the estimate visible, but never present
          // it as the exact master admission/ledger amount.
          session.costImprecise = true
        }
        const resultUsageCost = result.usage as typeof result.usage & { costImprecise?: boolean }
        if (resultUsageCost.costImprecise === true) session.costImprecise = true
        session.totalInputTokens += result.usage.inputTokens
        session.totalOutputTokens += result.usage.outputTokens
        session.totalCacheReadTokens += result.usage.cacheReadTokens
        session.totalCacheCreationTokens += result.usage.cacheCreationTokens
        session.currentAssistantBuf = completedAssistant.text
        // Persist cost-delta baseline after every successful turn so that
        // a gateway crash + restart can re-seed the correct baseline for
        // the resumed CCB (whose restoreCostStateForSession will target
        // the same cumulative). Without this, `lastCost` in resume-map
        // would only get updated when session_id changes, which lags
        // behind real turn completion by many turns.
        this._saveResumeMap()
        // L2: persist to FTS5 for session_search.
        // Use sessionKey (not ccbSessionId) as the FTS / sessions_meta
        // identity: sessionKey is stable across CCB process lifecycles
        // and across provider switches, while ccbSessionId rotates and
        // would split one logical session's history into multiple rows
        // — also breaking getMaxTurnIdx() lookup on resume.
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
            indexTurn(
              sessId,
              session.turns,
              session.currentUserText ?? '',
              completedAssistant.text,
            ),
          ]).catch((err) =>
            log.error(
              'FTS5 index failed',
              { sessionKey: session.sessionKey, ...(traceId ? { traceId } : {}) },
              err,
            ),
          )
        }

        // ── Phase 0.1: persist server-authored assistant message ──
        // Write the authoritative assistant text into the client_sessions
        // row so that a mobile client that missed the tail of the
        // streaming response (tab backgrounded, tab frozen, network
        // drop, OS-level JS suspension) can recover the full turn via
        // REST force-sync after reconnect. This is the core durability
        // fix — prior to this, server.ts:3787 silently dropped outbound
        // frames when no ws client was connected, and nothing else
        // persisted the assistant text to the user-visible messages
        // array. See docs/MOBILE_STREAM_DURABILITY_PLAN.md.
        //
        // Only applies to channels whose peerId resolves to a client_sessions
        // row id —— 当前是 webchat(UI 创建会话拿到 id 后才 dispatch 第一条)
        // 和 wechat(broker 用 wechat_session_pointer.current_session_id 当 peer.id
        // 喂 dispatchInbound,语义等价)。telegram/cron/webhook/delegate 的 peerId
        // 不是 client_sessions.id,master 端 WHERE id=? 永远命不中,只会浪费 outbox
        // 死信 IO,所以由 MASTER_SINK_PERSIST_CHANNELS 拒。它们的 turn 跟踪走
        // sessions_meta / event_log 路径(已存在,不在本 if 内)。
        const completedHasAssistant = completedAssistant.text.length > 0
        const completedHasThinking = completedThinking.text.length > 0
        // Tools-only turn is rare but real: a turn that emits tool_use
        // blocks, runs them, and ends without producing further assistant
        // text or thinking. We still need to persist the tool snapshots
        // so refresh recovery has something to render. Without this,
        // tool rows would only land when assistantText|thinkingText is
        // also non-empty — losing the durability fix in the rare case.
        const completedHasTools = completedTools.length > 0
        // P2 债A — drain the leader session's buffered team cards. Drained
        // unconditionally (exact-owner take) so a completed turn never leaks
        // its delegations into the next turn's persist, even if the persist
        // gate below is false (non-persisting channel). Added to the gate so
        // a delegation-only turn (leader produced no text/thinking/tools —
        // Agent tool is excluded from tools[] by ccbMessageParser) still
        // persists its team cards.
        // OCV5-180 B1 — turnKey = 本 turn 的 exact owner;drain 同步 seal 该
        // owner(payload 即将冻结),seal 后到达的晚到卡改走持久 continuation。
        const completedAgentGroups = this.drainPendingAgentGroups(session, turnKey)
        const completedHasAgentGroups = completedAgentGroups.length > 0
        const completedHasStructuredBlocks = completedStructuredBlocks.length > 0
        const completedRuntimeEvents = [
          ...retryRuntimeEvents.map((event) => structuredClone(event)),
          ...result.runtimeEvents,
        ]
        if (session._durableDelegateRuntimeEvents) {
          session._durableDelegateRuntimeEvents.push(
            ...completedRuntimeEvents.map((event) => structuredClone(event)),
          )
        }
        const completedHasRuntimeEvents = completedRuntimeEvents.length > 0
        const completedHasError =
          terminalOverride !== null || result.isError || result.errorDetail !== undefined
        if (completedHasError) {
          terminalErrorForClient =
            terminalOverride?.reason ?? result.errorDetail ?? pendingAttemptError?.error ?? 'engine reported an error'
          // E4.2 — gateway 权威终态码透传:handleExit/tape 已正确分类的
          // RUNNER_CRASHED / SERVICE_RESTART(以及 USER_CANCELLED、tape
          // AUTH_ERROR / ENGINE_ERROR)不再被 server 侧原文正则压成
          // upstream_failed。免单/静默恢复类码(LIVENESS_TIMEOUT 等)不在
          // wire 枚举内,保持 undefined 走既有 classify 兜底。
          terminalErrorCodeForClient =
            _wireTerminalCodeForTape(terminalOverride?.errorCode) ??
            (result.errorKind === 'auth' ? 'auth_error' : undefined)
        }
        if (
          MASTER_SINK_PERSIST_CHANNELS.has(session.channel) &&
          (completedHasAssistant ||
            completedHasThinking ||
            completedHasTools ||
            completedHasAgentGroups ||
            completedHasStructuredBlocks ||
            completedHasRuntimeEvents ||
            completedHasError)
        ) {
          const peerId = session.peerId
          const assistantText = completedAssistant.text
          const thinkingText = completedThinking.text
          const turnIndex = session.turns
          scheduleSessionOutputAssetCollection({
            userId: session.userId,
            chatProjectId: session.turnChatProjectId,
            sessionId: peerId,
            assistantText,
            sessionKey: session.sessionKey,
            ...(traceId ? { traceId } : {}),
          })
          // Phase 0.4 P1-3 (tightened): use `session.userId` directly when
          // we have it — this lets `appendServerAuthoredMessageDurable`
          // route `session_not_found` into the outbox instead of silently
          // dropping when the client's debounced PUT hasn't landed yet.
          // Fall back to `getClientSession` lookup for legacy code paths
          // that didn't carry userId (cron pre-warm, old webchat calls).
          //
          // thinkingText is forwarded too (Phase 0.4 thinking durability):
          // server-wins overwrite path was discarding the streaming-only
          // thinking buffer; persisting it as `_source: 'server'` keeps it
          // through merge-preserving-server-authored & through phantom
          // dedupe. Threshold extended to "thinking-only" turns (Sonnet
          // 4.6 adaptive thinking that runs out of tokens before producing
          // assistant text) so those don't disappear either.
          // E6 — 用四态 Outcome 版本以识别 'queued'(queued_to_outbox):
          // 布尔层语义不变(acked|skipped→true),queued 走下方降级终态旁路。
          const persistenceOutcome = persistServerAuthoredTurnOutcome({
            sessionKey: session.sessionKey,
            peerId,
            agentId: session.agentId,
            userId: session.userId,
            turnIndex,
            ...activeGoalAttribution(session),
            ...(clientMessageId ? { clientMessageId } : {}),
            ...(turnKey ? { turnKey } : {}),
            ...(session._currentDispatch ? { dispatch: session._currentDispatch } : {}),
            text: assistantText,
            ...(completedHasThinking ? { thinkingText } : {}),
            status: persistedResultStatus,
            ...(terminalOverride?.waiveReason ? { waiveReason: terminalOverride.waiveReason } : {}),
            // Plan §4.4 改动 7 — wire telemetry into the sink so master
            // can persist `usage` + render refresh-stable truncated pill.
            // requestId may be absent on non-codex / non-master paths;
            // master schema only requires it when text is non-empty,
            // and we already gate the persist call on completedHasAssistant
            // OR completedHasThinking. The v3 sink schema enforces
            // requestId for assistant writes; the gateway is run only
            // by master in v3 commercial, so requestId is always present
            // there. When absent (personal-version dev), the legacy
            // path is taken (sink is null) and requestId is ignored.
            ...(requestId ? { requestId } : {}),
            // CCB agent session id → 让 master 按 session 精确排空 pending costCredits
            // (= anthropicProxy 从 LLM metadata.session_id 提取的同一 id)。
            ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cacheReadTokens: result.usage.cacheReadTokens,
              cacheCreationTokens: result.usage.cacheCreationTokens,
              totalTokens: result.usage.totalTokens,
              ...(session.model ? { model: session.model } : {}),
              turn: turnIndex,
              // Surface the master-owned per-turn traceId so the web UI can
              // show a copyable "请求ID" that greps verbatim against master
              // turn logs; persisted into messages[i].usage.traceId so it
              // survives refresh via the usage sync channel.
              ...(traceId ? { traceId } : {}),
            },
            ...(result.stopReason === 'max_tokens' ? { truncated: true } : {}),
            ...(result.stopReason === 'max_tokens' || result.stopReason === 'pause_turn'
              ? { truncatedReason: result.stopReason }
              : {}),
            ...(completedHasError
              ? {
                  errorCode:
                    terminalOverride?.errorCode ??
                    (result.errorKind === 'auth'
                      ? 'AUTH_ERROR'
                      : result.errorClass && result.errorClass !== 'unknown'
                        ? result.errorClass
                        : _tapeErrorCodeForGenericFailure(result.errorDetail)),
                  errorDetail:
                    terminalOverride?.reason ?? result.errorDetail ?? 'engine reported an error',
                }
              : {}),
            ...(completedHasTools ? { tools: completedTools } : {}),
            // Fix B (2026-05-25) — per-segment durable rows. Plan §3.5.1.
            ...(completedAssistant.segments.length > 0
              ? { assistantSegments: completedAssistant.segments }
              : {}),
            ...(completedThinking.segments.length > 0
              ? { thinkingSegments: completedThinking.segments }
              : {}),
            // P2 债A — team cards drained above.
            ...(completedHasAgentGroups ? { agentGroups: completedAgentGroups } : {}),
            ...(completedHasStructuredBlocks
              ? { structuredBlocks: completedStructuredBlocks }
              : {}),
            ...(completedHasRuntimeEvents ? { runtimeEvents: completedRuntimeEvents } : {}),
            ...(terminalEngineBilling !== undefined
              ? { engineBilling: terminalEngineBilling }
              : {}),
          })
          const persistence = persistenceOutcome.then((r) => r === 'acked' || r === 'skipped')
          this._trackPersistence(
            persistenceOutcome.then((r) => {
              if (turnKey) this._settleDrainedOwnerGroups(session, turnKey, completedAgentGroups, r)
            }),
          )
          this._trackPersistence(persistence)
          // Do not declare the paid turn complete until master has
          // durably finalized the immutable tape. A queued local spool is
          // safe but not yet refresh-visible, so it must not masquerade as
          // an acknowledged completion.
          persistenceAcknowledged = await persistence
          // E6 的降级投递只针对**个人版本地 outbox**(queued_to_outbox):本地
          // SQLite 即权威库,没有任何上游会替我们把终态送给用户。商用 v3 sink
          // 的 'queued'(master 暂不可达)保持既有静默语义 —— master ACK 才是
          // 权威终态,提前投递会与 master 侧恢复链路(reconnect replay)打架
          // (契约测试锁此语义)。
          persistenceQueuedToOutbox =
            getV3MasterSinkOrNull() === null && (await persistenceOutcome) === 'queued'
        }

        // Unified turn-usage emit (eventPersist writes usage_log).
        recordTurnUsage(
          mapTurnTerminalStatus({
            persistStatus: terminalOverride?.status,
            errorCode: terminalOverride?.errorCode,
            hasResult: true,
            resultIsError: terminalOverride !== null || result.isError,
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

        // Emit cost.recorded for budget tracking
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

        // Detect verification verdicts in assistant output and emit structured event
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
      // A transient persistence failure stays in the unlimited fsynced
      // retry queue. Do not emit a new user-facing notice and do not expose
      // terminal completion until the authoritative master ACKs it.
      if (!result) {
        recordTurnUsage(mapTurnTerminalStatus({ hasResult: false }))
      }
      if (persistenceAcknowledged) {
        if (terminalErrorForClient) {
          // 审计 R3:errorClass 已是 TurnSummary 的权威字段(各 adapter 的
          // buildTurnSummary 从 TurnResult 复制),直读即可 —— 不再 cast 穿透,
          // 也不再靠 server 侧重新正则解析 errorDetail 兜底。runner 预分类在场
          // 则透传给 server.ts 直接按码组 outbound.error;缺省 undefined →
          // server 侧回落 classifyRunError,行为不变。
          const preClassified = result?.errorClass
          onEvent(
            _asEngineErrorEvent({
              kind: 'error',
              error: terminalErrorForClient,
              ...(preClassified ? { errorClass: preClassified } : {}),
              ...(terminalErrorCodeForClient ? { errorCode: terminalErrorCodeForClient } : {}),
            }),
          )
        } else if (pendingFinal) {
          onEvent(pendingFinal)
        }
      } else if (persistenceQueuedToOutbox) {
        // E6 — 落库进 outbox(权威库暂不可用):不算 acknowledged,但必须向
        // 当前连接投递降级终态,否则用户永远停在「思考中」。发一个
        // session_persist_unavailable 的 error 事件:server.ts 组结构化
        // outbound.error(受控文案「回复已生成、暂存待落库」)+ 兼容 [error]
        // final 终止器关闭本轮。已流式送达的正文气泡不受影响;outbox replay
        // 落库后刷新可见全文。原始失败细节(若有)进事件 error 字段仅供日志。
        log.warn('turn terminal delivered in degraded persist-queued mode', {
          sessionKey: session.sessionKey,
          turnIndex: session.turns,
          ...(traceId ? { traceId } : {}),
        })
        onEvent(
          _asEngineErrorEvent({
            kind: 'error',
            error: terminalErrorForClient ?? SESSION_PERSIST_QUEUED_NOTICE,
            errorCode: 'session_persist_unavailable',
          }),
        )
      }
      settle(() => resolve())
    }

    let runnerExitInfo: { signal: string | null; crashed?: boolean } | undefined
    const handleError = (err: Error) => {
      // All unexpected runner failures share one recovery-facing code.  The
      // immutable detail still preserves the concrete transport/process
      // error, while the Master can make one deterministic retry decision.
      // Wait past handleExit's 150ms drain so a planned SIGTERM is classified
      // once. Emitting RUNNER_CRASHED first and SERVICE_RESTART second is what
      // repainted the same turn from red to yellow. The diagnostic event is
      // recorded immediately; only the client-visible terminal waits.
      const plannedAtError = this.shouldClassifyExitAsServiceRestart(session, runnerExitInfo)
      retainTerminalError(
        plannedAtError ? 'interrupted' : 'crashed',
        err.message,
        plannedAtError ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
      )
      const persistence = (async () => {
        // Not unref'd: this wait is part of a tracked persistence that
        // awaitPendingPersistence (and shutdownAll) waits on. An unref'd
        // timer let the process leave before the RUNNER_CRASHED terminal was
        // written whenever nothing else held the event loop (OCV5-439).
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 200)
        })
        if (terminalPersistenceClaim !== 'none' || turn?.finalized) return
        const planned = this.shouldClassifyExitAsServiceRestart(session, runnerExitInfo)
        await (requestTerminalPersistence?.(
          planned ? 'interrupted' : 'crashed',
          err.message,
          planned ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
          planned ? 'no_response' : undefined,
        ) ?? Promise.resolve())
      })()
      this._trackPersistence(persistence)
    }

    // Listen for subprocess crash mid-turn. Defer slightly to let remaining
    // stdout data drain (exit can fire before stdout 'end' in Node.js).
    const handleExit = (info: {
      code: number | null
      signal: string | null
      crashed: boolean
    }) => {
      runnerExitInfo = { signal: info.signal, crashed: info.crashed }
      // Normal lifecycle restarts (model/effort/toolset swaps and Codex
      // app-server route-token respawns) emit a clean `exit` before the turn
      // continues on the replacement process. Do not finalize/detach the
      // parser for that expected code=0/no-signal shape; real signal/non-zero
      // exits still take the existing partial-drain/error path below.
      if (!info.crashed && info.code === 0 && info.signal == null) return

      // The setTimeout body is wrapped in `flushP` and registered with the
      // pending-persistence set IMMEDIATELY (synchronously, on this exit
      // event). That way `SessionManager.awaitPendingPersistence` — called
      // from `shutdownAll` after `runner.shutdown()` resolves — already
      // sees the promise and waits for the 150ms drain window + the sink
      // enqueue inside it to land on disk. If we instead added the
      // persist promise inside the setTimeout body, shutdown could race
      // past awaitPendingPersistence (set still empty) and clear the
      // sink singleton before the setTimeout fires, sending the partial
      // through the legacy data-loss path. Codex R2 BLOCK-1.
      const flushP = new Promise<void>((resolveFlush) => {
        setTimeout(() => {
          if (turn?.finalized || terminalPersistenceClaim !== 'none') {
            resolveFlush()
            return
          }
          const reason = info.signal
            ? `子进程被信号 ${info.signal} 终止`
            : info.code
              ? `子进程异常退出 (code ${info.code})`
              : '子进程意外退出'
          const planned = this.shouldClassifyExitAsServiceRestart(session, info)
          const status: 'interrupted' | 'crashed' =
            planned || info.signal ? 'interrupted' : 'crashed'
          void (
            persistTerminalSnapshot?.(
              status,
              reason,
              planned ? 'SERVICE_RESTART' : 'RUNNER_CRASHED',
              true,
              planned ? 'no_response' : undefined,
            ) ?? Promise.resolve()
          ).finally(resolveFlush)
        }, 150)
      })
      this._trackPersistence(flushP)
    }

    runner.on('activity', handleActivity)
    runner.on('billing', handleBilling)
    runner.on('external_billing', handleExternalBilling)
    runner.on('error', handleError)
    runner.on('exit', handleExit)
    runner.on('parse_error', handleParseError)
    runner.on('spawn', handleSpawn)
    runner.on('model_progress', handleModelProgress)

    // Engine not running yet → this turn pays a cold start (CCB ~20s
    // bun+JSONL resume, codex app-server init, cursor/grok one-shot CLI
    // every turn). Announce it before submit; the runner's own 'spawn'
    // event upgrades starting→resuming once resume attribution is known.
    if (!runner.isRunning) emitStartupPhase('engine_starting')

    // adapter 在 submitTurn 内构造 per-turn parser + telemetry(CCB 私有生命
    // 周期)并替换 stdout 路由目标 —— 旧 _currentMessageListener 的替换语义
    // (每 session 恒一个路由目标,旧 turn 闭包链自此可 GC)收进 adapter。
    // PR2 v1.0.66 — requestId 挂 queue entry(CCB 路径 noop 透传)。
    const submittedTurn = runner.submitTurn({
      input: userTextOrBlocks,
      ...(queueTurn ? { queueTurn: true } : {}),
      requestId,
      ...(turnKey ? { turnKey } : {}),
      // 模型权威批次 §4:bridge turn 的两张签名票(本地路径 undefined → CCB runner
      // 自取 local_catalog token;codex adapter 不消费本字段)。
      ...(modelAuthority !== undefined ? { modelAuthority } : {}),
      ...(grokExecutionDescriptor !== undefined ? { grokExecutionDescriptor } : {}),
      traceId,
      assistantMessageId,
      thinkingMessageId,
      toolMessageIdFactory,
      nextDurableEventOrdinal: () => takeDurableEventOrdinal(session),
      onPostTerminalRuntimeEvent,
      collabAgentPolicy,
      ...(session._collabModeTurn === 'advisor' && session._advisorTurn && turnKey
        ? {
            consultTurn: {
              configVersion: session._advisorTurn.configVersion,
              turnIndex: prevTurns + 1,
            },
          }
        : {}),
      automaticRetryState,
      ...(session._usageAttribution ? { usageAttribution: session._usageAttribution } : {}),
      ...(session._turnCreditBudgetFen !== undefined
        ? { creditBudgetFen: session._turnCreditBudgetFen }
        : {}),
      onEvent: handleEngineEvent,
      // CCB 成本 delta 基线:parser 直接读写 session.totalCostUSD / turns /
      // _lastCcbCumulativeCost(单一权威;回滚由上方 finalizeTurn 就地恢复)。
      sessionTotals: session,
      toolUseIdToName: session.toolUseIdToName,
    })
    // Capacity is released only after an actual engine submission; cancellation/admission
    // failures before this point keep the original unused-runner TTL.
    consumeUnusedPreheat(this, session)
    turn = submittedTurn
    // OCV5-435: a Stop that arrived before this run existed ends it now,
    // through the same user-stop persistence as a Stop on a running turn.
    if (clientMessageId && this._takePreStartStop(session.peerId, clientMessageId)) {
      log.info('pre-start stop applied', { sessionKey: session.sessionKey, clientMessageId })
      this.interrupt(session.sessionKey, 'user')
    }

    // 对位旧 runner.submit(...).catch:spawn 失败 / crash-loop backoff 等。
    submittedTurn.submitted.catch((err) => {
      const persistence =
        requestTerminalPersistence?.('crashed', String(err), 'RUNNER_CRASHED') ?? Promise.resolve()
      this._trackPersistence(persistence)
    })

    finalizationDone = submittedTurn.summary.then(finalizeTurn).catch((err) => {
      // finalizeTurn 自身抛错(编排层内部 bug)时对位旧实现 parser._parseInner
      // 的 catch → error 事件;并 settle 防 session lock 悬挂(旧实现此路径
      // 会悬挂,这里顺手加固,正常路径行为不变)。
      onEvent({ kind: 'error', error: String(err) })
      settle(() => resolve())
    })
  })
}

export async function runOneTurnWithRetry(
  this: TurnRunnerHost,
  session: AgentSession,
  userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
  onEvent: (e: SessionStreamEvent) => void,
  requestId?: string,
  traceId?: string,
  collabAgentPolicy?: CollabAgentPolicy,
  modelAuthority?: TurnModelAuthority,
  clientMessageId?: string,
  dispatchContext?: AgentSession['_currentDispatch'],
  queueLifecycle?: {
    readonly queueTurn: true
    onTurnReserved(reservation: {
      turnIndex: number
      turnKey: string
      traceId?: string
    }): Promise<void>
  },
  logicalTurnSignal?: AbortSignal,
  contextOverflowRetryInputs: string[] = [],
  automaticRetryState?: AutomaticRetryState,
  modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
  grokExecutionDescriptor?: GrokExecutionDescriptor,
): Promise<void> {
  const retryState: AutomaticRetryState = automaticRetryState ?? {
    rootClientMessageId: clientMessageId ?? session.sessionKey,
    attempt: 0,
    max: AUTOMATIC_TURN_RETRY_MAX,
  }
  // PHANTOM_TURN 用独立计数器,不和 transient 共用 attempt budget。
  // 第 0 次 phantom → 重启子进程 + retry 1 次;第 1 次还是 phantom → 终态 error,不再重试。
  let phantomRetryUsed = false

  // V3 v7 — Canonical assistant/thinking message ids for this user turn.
  // Computed ONCE here and shared by:
  //   1. CcbMessageParser (stamps text/thinking blocks emitted by the model)
  //   2. retry/auth/transient status text emits below (so they don't claim
  //      a separate m-* row that would later prevent canonical id adoption)
  //   3. Phase 0.1 turn-end takeover (persistServerAuthoredTurn legacy
  //      path + master internalServerAuthored.ts handler use the identical
  //      formula `srv-${peerId}-${agentId}-t${turnIndex}` and `${...}-thinking`)
  //
  // Reserve the turn id durably before any model output. FTS/session metadata
  // are post-result indexes and can lag or be absent for interrupted turns;
  // using them alone lets a process restart reuse tN and collide with an
  // immutable tape already ACKed (or queued locally). A reservation is never
  // rolled back; failed/empty turns may leave harmless gaps.
  //
  // 2026-05-13 — agentId segment added to disambiguate mid-chat model
  // switches. A chat that flips from codex to main keeps the same
  // peerId, but server creates a new AgentSession whose `session.turns`
  // restarts at 0; without agentId, turn 1 of codex and turn 1 of main
  // both stamp `srv-${peerId}-t1` and the client merges two answers
  // into one row. AgentId is part of sessionKey already so each
  // AgentSession naturally has its own agentId in scope here.
  //
  // Retry attempts within this loop SHARE these ids: a user turn that
  // gets retried for phantom/auth/transient errors is still one logical
  // assistant message from the user's perspective.
  const legacyId = this._resumeMap.get(session.sessionKey)
  const projectedTurnIndex = await reserveTurnIndex(session.sessionKey, {
    minimumLastTurn: session.turns,
    legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
  })
  const memoryObservationText =
    typeof userTextOrBlocks === 'string'
      ? userTextOrBlocks
      : userTextOrBlocks
          .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
          .join('\n')
  await beginMemoryTurnTracking({
    sessionKey: session.sessionKey,
    turnIndex: projectedTurnIndex,
    agentId: session.agentId,
    userText: memoryObservationText,
  }).catch((err) =>
    log.warn(
      'memory turn observation start failed',
      {
        sessionKey: session.sessionKey,
        turnIndex: projectedTurnIndex,
      },
      err,
    ),
  )
  // CcbMessageParser increments this reference on a real result. Seed it to
  // the slot immediately before the reservation so the result lands exactly
  // on projectedTurnIndex; partial/crash persistence uses the same slot.
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
  // RFC-v5-durable-turn-dispatch §3 — durable inbox: queued → running,同事务落
  // finalize 元数据(agent_id/turn_index/turn_key/request_id/created_at),**先于
  // 模型调用**。created_at 在此现取一次并持久化,boot recovery 合成 crashed tape
  // 用它确定性重放(严禁恢复期 Date.now())。runOneTurnWithRetry 在 lock 内跑,
  // dispatchContext 天然 turn-scoped;记 session._currentDispatch 供 turn-end 持久化取。
  if (dispatchContext) {
    // B3 fail-closed:queued→running CAS **必须确认**才允许调用模型。返回 null(CAS 落空:
    // 行已非 queued / 缺失)或抛异常(DB 故障)→ 禁止调用模型,CAS inbox → rejected
    // (not_accepted)并抛 TurnDispatchNotAcceptedError 走既有失败路径终局。绝不"告警后继续跑"
    // —— 那会让 rejected 墓碑与真 tape 并存(双终态,§3 铁律)。
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
            return
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
      // 落 rejected 墓碑 + 抛错(既有失败路径:submit replayLifecycle 投影用户可见错误,
      // 不写 tape → 无双终态)。**只在 running CAS 确认后**才把 dispatch 记进 session,
      // 避免 turn-end 持久化误取一个从未进入执行的 dispatch。
      await failClosedOnRunningCasMiss({
        userId: dispatchContext.userId,
        sessionId: dispatchContext.sessionId,
        clientMessageId: dispatchContext.clientMessageId,
        dispatchId: dispatchContext.dispatchId,
        cause: recordErr,
      })
    }
    session._currentDispatch = dispatchContext
  }
  if (queueLifecycle) {
    await queueLifecycle.onTurnReserved({
      turnIndex: projectedTurnIndex,
      turnKey,
      ...(traceId ? { traceId } : {}),
    })
  }
  const assistantMessageId = `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}`
  const thinkingMessageId = `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-thinking`
  // V3 v7.1 — canonical tool row id factory. Same lifecycle as the
  // assistant / thinking ids above (one per user turn, shared across
  // retries). Format matches master's `internalServerAuthored.ts` tool
  // id branch so client + server tape agree on tool row id from frame 1.
  const toolMessageIdFactory = (blockId: string): string =>
    `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-tool-${blockId}`

  // Every retry attempt belongs to one logical turn and one immutable tape.
  // Keep exact failed-attempt protocol events and gateway retry notices, then
  // prepend them to the terminal attempt's snapshot.
  const retryRuntimeEvents: DurableRuntimeEvent[] = []
  const retryAssistantSegments: SegmentRecord[] = []
  const retryThinkingSegments: SegmentRecord[] = []
  const retryTools: TurnToolEntry[] = []
  const retryStructuredBlocks: Array<Record<string, unknown>> = []
  let retryInput = userTextOrBlocks
  let contextOverflowRetryIndex = 0
  const canRetry = (): boolean => retryState.attempt < retryState.max
  const emitRetryStatus = (code: string, delayMs = 0): boolean => {
    if (!canRetry()) return false
    retryState.attempt += 1
    const ordinal = takeDurableEventOrdinal(session)
    const observedAt = Date.now()
    retryRuntimeEvents.push({
      ordinal,
      observedAt,
      source: 'gateway',
      payload: {
        type: 'retry_status',
        code,
        rootClientMessageId: retryState.rootClientMessageId,
        attempt: retryState.attempt,
        max: retryState.max,
      },
    })
    onEvent({
      kind: 'turn_status',
      status: {
        status: 'retrying',
        retry: {
          attempt: retryState.attempt,
          max: retryState.max,
          delayMs,
          retryAt: Date.now() + delayMs,
        },
      },
    })
    return true
  }
  const clearRetryStatus = (): void => onEvent({ kind: 'turn_status', status: null })

  let attemptOrdinal = 0
  for (;;) {
    throwIfLogicalTurnCancelled(logicalTurnSignal)
    try {
      await this._runOneTurn(
        session,
        retryInput,
        onEvent,
        requestId,
        traceId,
        collabAgentPolicy,
        assistantMessageId,
        thinkingMessageId,
        toolMessageIdFactory,
        turnKey,
        clientMessageId,
        modelAuthority,
        retryRuntimeEvents,
        retryAssistantSegments,
        retryThinkingSegments,
        retryTools,
        retryStructuredBlocks,
        queueLifecycle?.queueTurn === true,
        canRetry(),
        !phantomRetryUsed,
        canRetry(),
        attemptOrdinal,
        retryState,
        modelSwitchTransition,
        grokExecutionDescriptor,
      )
      return // success
    } catch (err: any) {
      // Liveness owns the terminal outcome for the complete logical turn.
      // Never let an interrupted EngineTurnRun escape into another gateway
      // retry attempt while the timeout path is persisting its exact tape.
      throwIfLogicalTurnCancelled(logicalTurnSignal)
      const msg = err?.message ?? String(err)

      // Phantom turn: CCB 返回了不调模型的空 result(usage/cost/blocks 全为 0)。
      // 通常是 CCB 子进程长闲置后内部状态卡死,重启子进程能恢复。
      if (/PHANTOM_TURN/i.test(msg)) {
        log.warn('phantom turn detected, restarting subprocess', {
          sessionKey: session.sessionKey,
          phantomRetryUsed,
          ...(traceId ? { traceId } : {}),
        })
        // shutdown → 下次 submit() 会自动 respawn 一个干净的 CCB 进程。
        // 子进程重启时 runner 的 'spawn' 事件会自动把 _lastCcbCumulativeCost 归零。
        await session.runner.shutdown()
        throwIfLogicalTurnCancelled(logicalTurnSignal)
        if (phantomRetryUsed) {
          return
        }
        if (!canRetry()) throw err
        phantomRetryUsed = true
        emitRetryStatus('PHANTOM_RETRY')
        clearRetryStatus()
        attemptOrdinal += 1
        continue
      }

      // Authentication/user-policy failures require explicit user action.
      // Never fold them into the model-busy automatic retry loop.
      if (/AUTH_ERROR/i.test(msg)) {
        throw err
      }

      const errorClass = classifyRunError(msg).code
      // A full Codex native thread is recoverable: immediately rebuild it
      // from a smaller exact master-history suffix. Surface progress to the
      // user and do not add transient backoff latency.
      if (
        errorClass === 'context_too_long' &&
        (session.providerTag === 'codex' || err instanceof SafeCcbContextRebuildRetryError) &&
        canRetry() &&
        contextOverflowRetryIndex < contextOverflowRetryInputs.length
      ) {
        contextOverflowRetryIndex += 1
        retryInput = contextOverflowRetryInputs[contextOverflowRetryIndex - 1]!
        log.warn('native context window exhausted; rebuilding with smaller history', {
          sessionKey: session.sessionKey,
          provider: session.providerTag,
          attempt: contextOverflowRetryIndex,
          maxRetries: retryState.max,
          ...(traceId ? { traceId } : {}),
        })
        emitRetryStatus('CONTEXT_REBUILD_RETRY')
        clearRetryStatus()
        attemptOrdinal += 1
        continue
      }

      // Only retry on transient errors (rate limit, server error, network)
      const isTransient =
        TRANSIENT_RETRY_ERROR_CODES.has(errorClass) ||
        /AbortError|operation was aborted|timed?\s*out/i.test(msg)
      if (!isTransient || !canRetry()) throw err
      if (TRANSIENT_RETRY_ERROR_CODES.has(errorClass)) {
        const breaker = advanceTransientBreaker(
          retryState,
          errorClass,
          resolveTransientBreakerThreshold(),
        )
        if (breaker.open && errorClass !== 'rate_limited') {
          log.warn('transient retry circuit open', {
            sessionKey: session.sessionKey,
            errorClass,
            consecutive: breaker.consecutive,
            attempt: retryState.attempt,
            ...(traceId ? { traceId } : {}),
          })
          throw new Error(formatTransientCircuitOpenError(errorClass, breaker.consecutive), {
            cause: err,
          })
        }
      }
      const delay = Math.max(this._transientRetryDelayMs(retryState.attempt),
        errorClass === 'rate_limited' && err instanceof Upstream429RetryError
          ? Math.max(0, err.hint.retryNotBeforeMs - Date.now()) : 0)
      log.warn('transient error, retrying', {
        sessionKey: session.sessionKey,
        attempt: retryState.attempt + 1,
        maxRetries: retryState.max,
        delayS: Math.round(delay / 1000),
        error: msg,
        ...(traceId ? { traceId } : {}),
      })
      emitRetryStatus('TRANSIENT_RETRY', delay)
      // Match the only recovery action a user would take: continue the same
      // engine session. Codex/CC own tool and conversation continuation.
      retryInput = TRANSIENT_RETRY_INPUT
      try {
        await waitForRetryDelay(delay, logicalTurnSignal)
      } finally {
        clearRetryStatus()
      }
      attemptOrdinal += 1
    }
  }
}
