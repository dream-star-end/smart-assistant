/**
 * Explicit typed state container, dependency contracts, and pure snapshot/usage
 * helpers for a single turn attempt and its retry wrapper.
 */
import { createHash } from 'node:crypto'
import type {
  CallTokenUsageSnapshot,
  ContextPressure,
  DurableAgentGroup,
  GrokExecutionDescriptor,
  OutboundContentBlock,
  TurnWaiveReason,
  UpstreamRetryHint,
} from '@openclaude/protocol'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineAdapter,
  EngineTurnRun,
} from '../engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  EngineEvent,
  EngineExternalBillingEvent,
  EngineFinalMeta,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from '../engine/engineEvents.js'
import type { GatewayEngineErrorEvent, GatewayTerminalErrorCode } from '../ccbMessageParser.js'
import type { TerminalBillingStatus } from '../costBackfillPolicy.js'
import type { AgentSession } from '../sessionTypes.js'
import type { TurnModelAuthority } from '../subprocessRunner.js'
import type { V3MasterSinkPayload } from '../v3MasterSink.js'
import type { TapePersistResult, TurnUserInput } from './types.js'

const RECOVERY_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

export const MASTER_SINK_PERSIST_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'wechat'])

export const TRANSIENT_RETRY_ERROR_CODES = new Set([
  'rate_limited',
  'model_capacity',
  'upstream_failed',
  'upstream_timeout',
  'network_error',
])

export class SafeCcbContextRebuildRetryError extends Error {}

export class Upstream429RetryError extends Error {
  constructor(
    message: string,
    readonly hint: Readonly<UpstreamRetryHint>,
  ) {
    super(message)
  }
}

export interface RequestedTerminalInfo {
  status: 'interrupted' | 'crashed'
  reason: string
  errorCode: string
  waiveReason?: TurnWaiveReason
}

export interface TurnAttemptParams {
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  onEvent: (e: SessionStreamEvent) => void
  requestId?: string
  traceId?: string
  collabAgentPolicy?: CollabAgentPolicy
  assistantMessageId?: string
  thinkingMessageId?: string
  toolMessageIdFactory?: (blockId: string) => string
  turnKey?: string
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
  automaticRetryState?: AutomaticRetryState
  modelSwitchTransition?: AgentSession['_modelSwitchTransition']
  grokExecutionDescriptor?: GrokExecutionDescriptor
  prevCostUSD: number
  prevTurns: number
  prevLastCcbCost: number
  turnStartTime: number
}

export interface TurnAttemptState {
  settled: boolean
  detached: boolean
  turn: EngineTurnRun | null
  finalizationDone: Promise<void> | null
  terminalPersistenceClaim: 'none' | 'complete' | 'partial'
  requestedTerminal: RequestedTerminalInfo | null
  terminalRequestEscalated: boolean
  runnerExitInfo: { signal: string | null; crashed?: boolean } | undefined
  pendingFinal: SessionStreamEvent | null
  pendingAttemptError: Extract<EngineEvent, { kind: 'error' }> | null
  observedFinalMeta: EngineFinalMeta | undefined
  terminalEngineBilling: EngineBillingEvent | undefined
  terminalExternalBilling: EngineExternalBillingEvent | undefined
  terminalBillingFlushed: boolean
  startupPhaseActive: boolean
  thinkingKeepalive: ReturnType<typeof setInterval> | null
  turnToolCallCount: number
  turnBlockCount: number
  turnPermissionCount: number
  turnToolsBytes: number
  lastCallContextTokens: number
  emittedTurnPressure: boolean
  memoryReadTargets: Map<string, string>
  structuredBlocks: Array<Record<string, unknown>>
  callUsageByTarget: Map<string, CallTokenUsageSnapshot>
  retainedTerminalErrors: Set<string>
  lastRetainedTerminalError: {
    status: 'interrupted' | 'crashed'
    reason: string
    errorCode: string
  } | null
  partialPersistencePromise: Promise<void> | null
  terminalRequestPromise: Promise<void> | null
  closeHelpAttempt: (() => void) | undefined
  idleTimer: NodeJS.Timeout | null
  settle: (fn: () => void) => void
  resolveAttempt: () => void
  rejectAttempt: (err: unknown) => void
  detach: () => void
  persistTerminalSnapshot: (
    status: 'interrupted' | 'crashed',
    reason: string,
    errorCode: string,
    settleAfter?: boolean,
    waiveReason?: TurnWaiveReason,
  ) => Promise<void>
  requestTerminalPersistence: (
    status: 'interrupted' | 'crashed',
    reason: string,
    errorCode: string,
    waiveReason?: TurnWaiveReason,
  ) => Promise<void>
}

export interface TurnRunnerDeps {
  terminalRequestGraceMs: () => number
  trackPersistence: (p: Promise<unknown>) => void
  awaitBoundedOutputDrain: (
    runner: Pick<EngineAdapter, 'waitForOutputDrain'>,
    session: AgentSession,
  ) => Promise<void>
  shouldClassifyExitAsServiceRestart: (
    session: AgentSession,
    info?: { signal: string | null; crashed?: boolean },
  ) => boolean
  drainPendingAgentGroups: (session: AgentSession, turnKey?: string) => DurableAgentGroup[]
  settleDrainedOwnerGroups: (
    session: AgentSession,
    turnKey: string,
    groups: DurableAgentGroup[],
    outcome: TapePersistResult,
  ) => void
  markResumeRejectedFromError: (
    key: string,
    errorDetail: string | undefined,
    liveId: string | null | undefined,
  ) => string[]
  forgetResumeEntry: (key: string) => void
  saveResumeMap: () => void
  persistServerAuthoredTurnOutcome: (args: Record<string, unknown>) => Promise<TapePersistResult>
  toEngineErrorEvent: (event: GatewayEngineErrorEvent) => SessionStreamEvent
  wireTerminalCodeForTape: (code: string | undefined) => GatewayTerminalErrorCode | undefined
  tapeErrorCodeForGenericFailure: (detail: string | undefined) => string
  classifyRunError: (detail: string | undefined) => { code: string }
  normalizeAssistantOutputUiFences: (input: {
    text: string
    segments: SegmentRecord[]
  }) => { text: string; segments: SegmentRecord[] }
  emptyCompletedTurnAssistantText: (args: {
    status: 'completed' | 'interrupted' | 'crashed'
    errorCode?: string
    assistantText: string
  }) => string
  shouldFailClosedEmptyModelTurn: (args: {
    status: 'completed'
    assistantText: string
    outputTokens: number
    inputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    toolCallCount: number
    blockCount: number
    structuredBlockCount: number
    apiState: 'unknown' | 'called' | 'skipped'
    isSlashCommand: boolean
    isError: boolean
  }) => boolean
  applyPlatformCostIfMissing: (args: {
    model?: string
    usage: TurnSummary['usage']
    sessionCostUsd: number
    prevCostUsd: number
    waiveReason?: TurnWaiveReason
    agentId?: string
    engine?: string
    isError?: boolean
    terminalBillingStatus?: TerminalBillingStatus
  }) => Promise<number | null>
  applyEfficiencyToolObservation: (
    session: AgentSession,
    tool: { name: string; input: Record<string, unknown> },
    toolCallCount: number,
  ) => void
  enrichContextPressure: (
    pressure: ContextPressure,
    ctx: {
      agentId: string
      engine: string
      modelContextWindow?: number | null
      observedTokens?: number
      toolsBytes?: number
    },
  ) => ContextPressure
  recordTurnContextWatermarkForAutoCompact: (
    session: AgentSession,
    args: {
      usedTokens: number
      modelContextWindow?: number | null
      userText?: string
      assistantText: string
      toolsBytes: number
    },
  ) => void
  isSafeUniversalOverflowSummary: (args: {
    session: AgentSession
    result: TurnSummary | null
    errorClass: string
    hasUsage: boolean
    turnBlockCount: number
    turnPermissionCount: number
    turnToolCallCount: number
    structuredBlockCount: number
    priorAssistantSegments: number
    stoppedOrAborted: boolean
    isCcbSingleDiagnostic: boolean
  }) => boolean
  hasCompactableSessionHistory: (session: AgentSession) => Promise<boolean>
  createSafeUniversalOverflowRetryError: (msg: string, explicit: boolean) => Error
  recordTurnUsage: (
    terminalStatus: string,
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      costUsd?: number
      model?: string
    },
    turnIndex?: number,
  ) => boolean
  mapTurnTerminalStatus: (args: {
    persistStatus?: 'interrupted' | 'crashed'
    errorCode?: string
    hasResult?: boolean
    resultIsError?: boolean
  }) => string
}

export function stampGatewayToolEffect(tool: TurnToolEntry): TurnToolEntry {
  const cloned = structuredClone(tool) as TurnToolEntry & { _toolEffect?: unknown }
  const { _toolEffect: _stripped, ...rest } = cloned
  const clean = rest as TurnToolEntry
  if (!RECOVERY_READ_ONLY_TOOLS.has(clean.toolName) || clean.completed === false) {
    return clean
  }
  return {
    ...clean,
    _toolEffect: {
      authority: 'gateway-v1',
      registryEntrySha256: createHash('sha256')
        .update(`gateway-v1\0${clean.toolName}\0read_only`)
        .digest('hex'),
      outcome: 'completed',
      safety: 'read_only',
    },
  } as TurnToolEntry
}

export function freezeToolsWithCallUsage(
  tools: readonly TurnToolEntry[],
  callUsageByTarget: Map<string, CallTokenUsageSnapshot>,
): TurnToolEntry[] {
  return tools.map((tool) => {
    const call = callUsageByTarget.get(tool.blockId)
    return {
      ...stampGatewayToolEffect(tool),
      ...(call ? { _callUsage: structuredClone(call) } : {}),
    }
  })
}

export function freezeSegmentsWithCallUsage(
  segments: readonly SegmentRecord[],
  messageIdBase: string | undefined,
  callUsageByTarget: Map<string, CallTokenUsageSnapshot>,
): SegmentRecord[] {
  return segments.map((segment) => {
    const targetId = messageIdBase ? `${messageIdBase}-s${segment.index}` : undefined
    const call = targetId ? callUsageByTarget.get(targetId) : undefined
    return {
      ...structuredClone(segment),
      ...(call ? { _callUsage: structuredClone(call) } : {}),
    }
  })
}

export function freezeStructuredBlocksWithCallUsage(
  blocks: readonly Record<string, unknown>[],
  callUsageByTarget: Map<string, CallTokenUsageSnapshot>,
): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    const targetId = typeof block.blockId === 'string' ? block.blockId : undefined
    const call = targetId ? callUsageByTarget.get(targetId) : undefined
    return {
      ...structuredClone(block),
      ...(call ? { _callUsage: structuredClone(call) } : {}),
    }
  })
}

export function combineRetryAssistantOutput(
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

export function safeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function terminalUsageForPersistence(args: {
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

export function throwIfLogicalTurnCancelled(signal: AbortSignal | undefined): void {
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

export function createTurnAttemptState(
  resolve: () => void,
  reject: (err: unknown) => void,
): TurnAttemptState {
  const state: TurnAttemptState = {
    settled: false,
    detached: false,
    turn: null,
    finalizationDone: null,
    terminalPersistenceClaim: 'none',
    requestedTerminal: null,
    terminalRequestEscalated: false,
    runnerExitInfo: undefined,
    pendingFinal: null,
    pendingAttemptError: null,
    observedFinalMeta: undefined,
    terminalEngineBilling: undefined,
    terminalExternalBilling: undefined,
    terminalBillingFlushed: false,
    startupPhaseActive: false,
    thinkingKeepalive: null,
    turnToolCallCount: 0,
    turnBlockCount: 0,
    turnPermissionCount: 0,
    turnToolsBytes: 0,
    lastCallContextTokens: 0,
    emittedTurnPressure: false,
    memoryReadTargets: new Map(),
    structuredBlocks: [],
    callUsageByTarget: new Map(),
    retainedTerminalErrors: new Set(),
    lastRetainedTerminalError: null,
    partialPersistencePromise: null,
    terminalRequestPromise: null,
    closeHelpAttempt: undefined,
    idleTimer: null,
    settle: (fn) => {
      if (!state.settled) {
        state.settled = true
        fn()
      }
    },
    resolveAttempt: () => state.settle(resolve),
    rejectAttempt: (err) => state.settle(() => reject(err)),
    detach: () => {},
    persistTerminalSnapshot: () => Promise.resolve(),
    requestTerminalPersistence: () => Promise.resolve(),
  }
  return state
}
