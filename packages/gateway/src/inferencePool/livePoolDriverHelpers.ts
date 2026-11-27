/**
 * OCV5-915 P3-1 — Pure & lifecycle helpers for `livePoolDriverRuntime.ts`.
 * Subdomain: `rt-codex-remote` (rank 1). Zero circular imports, zero `process.env`,
 * zero network APIs, zero `syncIo`, zero `emptyCatch`, zero `typeEscape`, zero engine literals.
 */
import { randomUUID } from 'node:crypto'
import {
  AUTHORITY_ENGINE_KINDS,
  INFERENCE_SERVICE_TIERS,
  PLATFORM_REASONING_EFFORTS,
  authorityEngineToInferenceFamily,
  buildTurnReceiptV5FromRemoteV4,
  computeStickyHomeKey,
  isRemoteDriverExecutionBackend,
  parseRemoteDriverExecutionBackend,
  remoteCanonicalSha256,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  type AuthorityEngineKind,
  type DriverCapabilityManifest,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type NormalizedInferenceEvent,
  type NormalizedUsageCounters,
  type PlatformReasoningEffort,
  type RemoteReceiptV4,
  type TurnReceiptV5,
  type UnifiedTurnInputBlock,
} from '@openclaude/protocol'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { EngineEvent, PartialSnapshot, PhantomSignals, TurnSummary } from '../engine/engineEvents.js'
import type { UnifiedPoolAdapterWrapContext } from '../engine/registry.js'
import {
  isPlainRecord,
  safeNonNegativeInt,
  sanitizeIdentifier,
  type AbandonResult,
  type DriverAdmission,
  type DriverTurnRequest,
  type StopLaneResult,
} from './localPoolDriver.js'
import type { RemoteV5LaneEvent } from './remotePoolV5Adapter.js'

const SHA256_RE = /^[a-f0-9]{64}$/

export const EMPTY_PARTIAL_SNAPSHOT: PartialSnapshot = Object.freeze({
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
  runtimeEvents: [],
})

export const DEFAULT_PHANTOM_SIGNALS: PhantomSignals = Object.freeze({
  apiState: 'unknown',
  skipReason: null,
})

export type RawUsageInput = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheCreationTokens?: number
  readonly cacheWriteTokens?: number
}

export interface TurnCatalogGuardLike {
  readonly isExhausted: boolean
  observeCallUsage(sampleId: string, usage: NormalizedUsageCounters): boolean
  observeCumulativeUsage(usage: RawUsageInput): boolean
}

export interface LiveTurnContext {
  readonly turnId: string
  readonly requestId: string
  readonly turnKey: string
  readonly fullParams: TurnParams
  readonly catalogGuard: TurnCatalogGuardLike
  readonly resolveSubmitted: () => void
  readonly rejectSubmitted: (err: Error) => void
  readonly resolveSummary: (value: TurnSummary | null) => void
  readonly resolveReceiptDone: () => void
  readonly receiptDone: Promise<void>
  admissionId: string | null
  baseRun: EngineTurnRun | null
  dispatched: boolean
  cancelledBeforeDispatch: boolean
  cancelReason: string | null
  finalized: boolean
  ended: boolean
  observedSummary: TurnSummary | null
  observedRemoteReceiptV4: RemoteReceiptV4 | null
  observedRemoteFinalizedAt: string | null
  receipt: TurnReceiptV5 | null
}

export interface RemoteProjectionState {
  readonly emittedToolReq: Set<string>
  readonly emittedToolDone: Set<string>
  readonly toolArgsSha: Map<string, string>
  streamErrorCode?: string
  latestTurnUsage?: NormalizedUsageCounters
}

export interface UnifiedPoolRouterLike {
  readonly receiptCacheSize: number
  admit(
    poolKind: 'local_pool' | 'remote_pool',
    req: DriverTurnRequest,
  ): Promise<{ readonly admission: DriverAdmission }>
  abandon(
    poolKind: 'local_pool' | 'remote_pool',
    admissionId: string,
    reason: string,
  ): Promise<AbandonResult>
  dispatch(
    poolKind: 'local_pool' | 'remote_pool',
    admissionId: string,
  ): AsyncIterable<NormalizedInferenceEvent>
  interruptTurn(
    poolKind: 'local_pool' | 'remote_pool',
    turnId: string,
    reason?: string,
  ): Promise<void>
  stopLane(
    poolKind: 'local_pool' | 'remote_pool',
    operationId: string,
    reason: string,
  ): Promise<StopLaneResult>
  recordReceipt(receipt: TurnReceiptV5): TurnReceiptV5
}

export function toNormalizedUsage(raw: RawUsageInput): NormalizedUsageCounters {
  return Object.freeze({
    inputTokens: safeNonNegativeInt(raw.inputTokens),
    outputTokens: safeNonNegativeInt(raw.outputTokens),
    cacheReadTokens: safeNonNegativeInt(raw.cacheReadTokens),
    cacheWriteTokens: safeNonNegativeInt(raw.cacheWriteTokens ?? raw.cacheCreationTokens),
  })
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (v: T) => void
  readonly reject: (e: Error) => void
} {
  let done = false
  let resolveFn!: (v: T) => void
  let rejectFn!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolveFn = (v) => {
      if (!done) {
        done = true
        res(v)
      }
    }
    rejectFn = (e) => {
      if (!done) {
        done = true
        rej(e)
      }
    }
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

export function readRemoteBindingUid(adapter: EngineAdapter): string | undefined {
  const uid = Reflect.get(adapter, 'remoteBindingUid')
  return typeof uid === 'string' && uid.trim().length > 0 ? uid.trim() : undefined
}

export function extractAuthorityIds(raw: unknown): {
  readonly authorityTurnId?: string
  readonly billingRequestId?: string
} {
  if (!isPlainRecord(raw)) return {}
  const desc = isPlainRecord(raw.executionDescriptor) ? raw.executionDescriptor : null
  const turnRaw = raw.authorityTurnId ?? desc?.authorityTurnId
  const reqRaw = raw.billingRequestId ?? desc?.billingRequestId
  return {
    ...(typeof turnRaw === 'string' && turnRaw.trim().length > 0
      ? { authorityTurnId: turnRaw.trim() }
      : {}),
    ...(typeof reqRaw === 'string' && reqRaw.trim().length > 0
      ? { billingRequestId: reqRaw.trim() }
      : {}),
  }
}

export function parsePositiveEpoch(raw: string | undefined, fallback = 1): number {
  if (typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed
  }
  return fallback
}

function readExplicitHermeticSupport(caps: EngineAdapter['capabilities']): boolean | undefined {
  return isPlainRecord(caps) && typeof caps.supportsHermeticNoTools === 'boolean'
    ? caps.supportsHermeticNoTools
    : undefined
}

/** Honest manifest derived strictly from the adapter's real declared capabilities (B13). */
export function buildAutoManifest(
  baseAdapter: EngineAdapter,
  ctx: UnifiedPoolAdapterWrapContext,
  logicalModel: string,
  upstreamModel: string,
): DriverCapabilityManifest {
  const rawAuth = ctx.engineId || baseAdapter.engineId
  const authEngine: AuthorityEngineKind = AUTHORITY_ENGINE_KINDS.find((k) => k === rawAuth) ?? 'ccb'
  const engineFamily = authorityEngineToInferenceFamily(authEngine)
  const remoteBackend = isRemoteDriverExecutionBackend(baseAdapter.executionBackend)
    ? parseRemoteDriverExecutionBackend(baseAdapter.executionBackend)
    : null
  const supportsHermeticNoTools =
    readExplicitHermeticSupport(baseAdapter.capabilities) ??
    (ctx.poolKind === 'local_pool' && baseAdapter.capabilities.permissionModel === 'native')
  const cap: LogicalModelCapability = Object.freeze({
    logicalModel,
    upstreamModelId: upstreamModel,
    supportsVision: baseAdapter.capabilities.multimodalInput === 'native',
    supportedEfforts: Object.freeze([...PLATFORM_REASONING_EFFORTS]),
    defaultEffort: 'medium',
    supportedServiceTiers: Object.freeze([...INFERENCE_SERVICE_TIERS]),
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
  })
  return validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: ctx.poolKind,
    engineFamily,
    authorityEngine: authEngine,
    driverId:
      ctx.poolKind === 'remote_pool' && remoteBackend ? remoteBackend.driverId : `local-${engineFamily}`,
    driverVersion:
      ctx.poolKind === 'remote_pool' && remoteBackend ? remoteBackend.driverVersion : '5.0.0',
    observedAt: new Date().toISOString(),
    models: [cap],
  })
}

function convertImageRefBlock(item: Record<string, unknown>): UnifiedTurnInputBlock | null {
  if (typeof item.mimeType !== 'string') return null
  const uri = typeof item.uri === 'string' && item.uri.length > 0 ? item.uri : undefined
  const blobId = typeof item.blobId === 'string' && item.blobId.length > 0 ? item.blobId : undefined
  if (!uri && !blobId) return null
  const mimeType = item.mimeType.startsWith('image/') ? item.mimeType : 'image/png'
  return {
    type: 'image_ref',
    mimeType,
    ...(blobId ? { blobId } : {}),
    ...(uri ? { uri } : {}),
  }
}

function convertSingleInputBlock(item: unknown): UnifiedTurnInputBlock | null {
  if (!isPlainRecord(item)) return null
  if (item.type === 'text' && typeof item.text === 'string') {
    return { type: 'text', text: item.text }
  }
  if (item.type === 'image_ref') return convertImageRefBlock(item)
  if (item.type === 'image') {
    return { type: 'image_ref', mimeType: 'image/png', uri: 'inline://image' }
  }
  if (
    item.type === 'blob_ref' &&
    typeof item.blobId === 'string' &&
    typeof item.sha256 === 'string' &&
    SHA256_RE.test(item.sha256) &&
    typeof item.mimeType === 'string'
  ) {
    return { type: 'blob_ref', blobId: item.blobId, sha256: item.sha256, mimeType: item.mimeType }
  }
  return null
}

export function toUnifiedInputBlocks(input: TurnParams['input']): readonly UnifiedTurnInputBlock[] {
  if (typeof input === 'string') return Object.freeze([{ type: 'text', text: input }])
  if (!Array.isArray(input) || input.length === 0) return Object.freeze([{ type: 'text', text: '' }])
  const blocks: UnifiedTurnInputBlock[] = []
  for (const item of input) {
    const converted = convertSingleInputBlock(item)
    if (converted !== null) blocks.push(converted)
  }
  return Object.freeze(blocks.length > 0 ? blocks : [{ type: 'text', text: '' }])
}

function projectBlockEventToRemoteV5(
  b: Extract<EngineEvent, { kind: 'block' }>['block'],
  turnId: string,
  st: RemoteProjectionState,
  push: (ev: RemoteV5LaneEvent) => void,
  pushToolCompleted: (callId: string, toolName: string) => void,
): void {
  if (b.kind === 'text') {
    push({ kind: 'text_delta', channel: 'answer', delta: b.text })
  } else if (b.kind === 'thinking') {
    push({ kind: 'text_delta', channel: 'reasoning', delta: b.text })
  } else if (b.kind === 'tool_use') {
    const callId = b.blockId ?? `call_${turnId}`
    if (b.partial === true && typeof b.partialJsonDelta === 'string') {
      push({ kind: 'tool_call_delta', callId, toolName: b.toolName, argsDelta: b.partialJsonDelta })
    } else if (!b.partial && !st.emittedToolReq.has(callId)) {
      const args = isPlainRecord(b.inputJson) ? b.inputJson : {}
      const sha = remoteCanonicalSha256(args)
      st.emittedToolReq.add(callId)
      st.toolArgsSha.set(callId, sha)
      push({ kind: 'tool_call_request', callId, toolName: b.toolName, arguments: args, argsSha256: sha })
    }
  } else if (b.kind === 'tool_result') {
    pushToolCompleted(b.toolUseBlockId ?? b.blockId ?? `call_${turnId}`, b.toolName)
  }
}

function projectToolUseDetectedToRemoteV5(
  tool: Extract<EngineEvent, { kind: 'tool_use_detected' }>['tool'],
  st: RemoteProjectionState,
  push: (ev: RemoteV5LaneEvent) => void,
): void {
  const callId = tool.id
  const args = isPlainRecord(tool.input) ? tool.input : {}
  const sha = remoteCanonicalSha256(args)
  st.toolArgsSha.set(callId, sha)
  if (!st.emittedToolReq.has(callId)) {
    st.emittedToolReq.add(callId)
    push({ kind: 'tool_call_request', callId, toolName: tool.name, arguments: args, argsSha256: sha })
  } else {
    push({ kind: 'tool_call_observed', callId, toolName: tool.name, phase: 'started', argsSha256: sha })
  }
}

function projectSystemOrUsageEventToRemoteV5(
  e: EngineEvent,
  st: RemoteProjectionState,
  turnCtx: LiveTurnContext | undefined,
  push: (ev: RemoteV5LaneEvent) => void,
): void {
  if (e.kind === 'context_pressure') {
    push({
      kind: 'context_pressure',
      usedTokens: safeNonNegativeInt(e.pressure.usedTokens),
      contextWindow: safeNonNegativeInt(e.pressure.windowTokens),
      ratio: e.pressure.usedRatio,
    })
  } else if (e.kind === 'context_compacted') {
    push({
      kind: 'compaction',
      reason: e.compaction.strategy,
      ...(e.compaction.beforeTokens === undefined
        ? {}
        : { beforeTokens: safeNonNegativeInt(e.compaction.beforeTokens) }),
      ...(e.compaction.afterTokens === undefined
        ? {}
        : { afterTokens: safeNonNegativeInt(e.compaction.afterTokens) }),
      ...(e.compaction.strategy === 'checkpoint_reset' ? { clearedPromptCache: true } : {}),
    })
  } else if (e.kind === 'call_usage') {
    const normalized = toNormalizedUsage(e.call.usage)
    turnCtx?.catalogGuard.observeCallUsage(e.call.callId, normalized)
    push({ kind: 'call_usage', sampleId: e.call.callId, scopeId: e.call.targetIds[0] ?? 'main', usage: normalized })
  } else if (e.kind === 'usage') {
    turnCtx?.catalogGuard.observeCumulativeUsage(e.usage)
    st.latestTurnUsage = toNormalizedUsage(e.usage)
  } else if (e.kind === 'turn_status') {
    push({
      kind: 'turn_status',
      phase: e.status === null ? 'idle' : typeof e.status === 'string' ? e.status : e.status.status,
    })
  } else if (e.kind === 'error') {
    st.streamErrorCode = e.errorCode ?? e.errorClass ?? 'remote_error'
  } else if (e.kind === 'final' && e.meta) {
    st.latestTurnUsage = toNormalizedUsage(e.meta)
  }
}

export function projectEngineEventToRemoteV5(
  e: EngineEvent,
  turnId: string,
  st: RemoteProjectionState,
  turnCtx: LiveTurnContext | undefined,
  push: (ev: RemoteV5LaneEvent) => void,
): void {
  const pushToolCompleted = (callId: string, toolName: string): void => {
    if (st.emittedToolDone.has(callId)) return
    st.emittedToolDone.add(callId)
    push({
      kind: 'tool_call_observed',
      callId,
      toolName,
      phase: 'completed',
      argsSha256: st.toolArgsSha.get(callId) ?? remoteCanonicalSha256({}),
    })
  }
  if (e.kind === 'block') {
    projectBlockEventToRemoteV5(e.block, turnId, st, push, pushToolCompleted)
  } else if (e.kind === 'tool_use_detected') {
    projectToolUseDetectedToRemoteV5(e.tool, st, push)
  } else if (e.kind === 'tool_result_detected') {
    pushToolCompleted(e.result.toolUseId, e.result.toolName)
  } else if (e.kind === 'permission_request') {
    push({
      kind: 'permission_request',
      permissionId: e.request.requestId,
      toolName: e.request.toolName,
      reason: 'engine_permission_request',
    })
  } else {
    projectSystemOrUsageEventToRemoteV5(e, st, turnCtx, push)
  }
}

export function buildDriverTurnRequest(args: {
  readonly params: TurnParams
  readonly ctx: UnifiedPoolAdapterWrapContext
  readonly baseAdapter: EngineAdapter
  readonly activeTurns: ReadonlyMap<string, LiveTurnContext>
  readonly rawModel: string
  readonly poolKind: 'local_pool' | 'remote_pool'
  readonly placementEpoch: number
  readonly activeOperationId: string
  readonly tenantIdOverride?: string
}): {
  readonly turnId: string
  readonly requestId: string
  readonly turnKey: string
  readonly serviceTier: InferenceServiceTier
  readonly driverRequest: DriverTurnRequest
} {
  const { params, ctx, baseAdapter, activeTurns, rawModel, poolKind, placementEpoch, activeOperationId } =
    args
  const authIds = extractAuthorityIds(params.modelAuthority)
  const requestId = sanitizeIdentifier(
    params.requestId ?? authIds.billingRequestId,
    `req_${randomUUID().replace(/-/g, '')}`,
  )
  const baseTurnId = sanitizeIdentifier(
    authIds.authorityTurnId ?? params.requestId ?? authIds.billingRequestId,
    `turn_${randomUUID().replace(/-/g, '')}`,
  )
  const turnId = activeTurns.has(baseTurnId) ? `${baseTurnId}_${randomUUID().slice(0, 8)}` : baseTurnId
  const sessionKey =
    typeof ctx.opts.sessionKey === 'string' && ctx.opts.sessionKey.trim().length > 0
      ? ctx.opts.sessionKey
      : `session_${turnId}`
  const turnKey =
    typeof params.turnKey === 'string' && SHA256_RE.test(params.turnKey)
      ? params.turnKey
      : remoteCanonicalSha256({ domain: 'oc-live-turn-key-v5', sessionKey, turnId, requestId })
  const resolvedModel = resolveLogicalModelId(rawModel)
  const serviceTier: InferenceServiceTier =
    INFERENCE_SERVICE_TIERS.find((t) => t === params.serviceTier) ?? 'standard'
  const effort: PlatformReasoningEffort | undefined = PLATFORM_REASONING_EFFORTS.find(
    (e) => e === baseAdapter.effortLevel,
  )
  const tenantId = sanitizeIdentifier(
    args.tenantIdOverride ?? readRemoteBindingUid(baseAdapter),
    'local-tenant',
  ).slice(0, 64)

  const driverRequest: DriverTurnRequest = {
    schemaVersion: 5,
    turnId,
    turnKey,
    requestId,
    tenantId,
    sessionKey,
    logicalModel: resolvedModel.logicalModel,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    serviceTier,
    input: toUnifiedInputBlocks(params.input),
    placementHint: {
      poolPreference: poolKind === 'remote_pool' ? 'pin_remote' : 'pin_local',
      stickyHomeKey: computeStickyHomeKey(sessionKey),
      placementEpoch,
    },
    ...(params.readOnly === true ? { readOnly: true } : {}),
    ...(params.consultTurn
      ? {
          consultTurn: true,
          consultTurnConfig: {
            configVersion: params.consultTurn.configVersion,
            turnIndex: params.consultTurn.turnIndex,
          },
        }
      : {}),
    ...(ctx.opts.hermeticNoTools === true ? { hermeticNoTools: true } : {}),
    ...(params.creditBudgetFen === undefined ? {} : { creditBudgetFen: params.creditBudgetFen }),
    operationId: activeOperationId,
  }
  return { turnId, requestId, turnKey, serviceTier, driverRequest }
}

export function buildUnifiedTurnRunHandle(
  turnCtx: LiveTurnContext,
  submitted: Promise<void>,
  summary: Promise<TurnSummary | null>,
): EngineTurnRun {
  return {
    submitted,
    summary,
    end: () => {
      if (turnCtx.ended) return
      turnCtx.ended = true
      if (!turnCtx.dispatched) {
        turnCtx.cancelledBeforeDispatch = true
        turnCtx.cancelReason ??= 'ended_before_dispatch'
      } else {
        turnCtx.baseRun?.end()
      }
    },
    getPartialSnapshot: () => turnCtx.baseRun?.getPartialSnapshot() ?? { ...EMPTY_PARTIAL_SNAPSHOT },
    getPhantomSignals: () => turnCtx.baseRun?.getPhantomSignals() ?? { ...DEFAULT_PHANTOM_SIGNALS },
    get finalized() {
      return turnCtx.finalized || (turnCtx.baseRun?.finalized ?? false)
    },
    get pendingToolCalls() {
      return turnCtx.baseRun?.pendingToolCalls ?? 0
    },
  }
}

export async function executeUnifiedTurnLifecycle(args: {
  readonly poolKind: 'local_pool' | 'remote_pool'
  readonly authEngine: AuthorityEngineKind
  readonly serviceTier: InferenceServiceTier
  readonly placementEpoch: number
  readonly rawModel: string
  readonly driverRequest: DriverTurnRequest
  readonly turnCtx: LiveTurnContext
  readonly router: UnifiedPoolRouterLike
  readonly baseAdapter: EngineAdapter
  readonly ensureReady: (rawModel: string) => void
  readonly isShuttingDown: () => boolean
  readonly onOperationId: (operationId: string) => void
  readonly onReceipt: (receipt: TurnReceiptV5) => void
  readonly onCleanup: () => void
  readonly clock?: () => number
}): Promise<void> {
  const {
    poolKind,
    authEngine,
    serviceTier,
    placementEpoch,
    rawModel,
    driverRequest,
    turnCtx,
    router,
    baseAdapter,
  } = args
  try {
    args.ensureReady(rawModel)
    const admitted = await router.admit(poolKind, driverRequest)
    turnCtx.admissionId = admitted.admission.admissionId
    args.onOperationId(admitted.admission.operationId)
    if (turnCtx.cancelledBeforeDispatch || turnCtx.ended || args.isShuttingDown()) {
      await router.abandon(
        poolKind,
        admitted.admission.admissionId,
        turnCtx.cancelReason ?? (args.isShuttingDown() ? 'shutdown' : 'cancelled_before_dispatch'),
      )
      turnCtx.finalized = true
      turnCtx.resolveSubmitted()
      turnCtx.resolveSummary(null)
      return
    }
    turnCtx.dispatched = true
    for await (const ev of router.dispatch(poolKind, admitted.admission.admissionId)) {
      if (ev.kind === 'billing_receipt') {
        const rawReceipt =
          poolKind === 'remote_pool' && turnCtx.observedRemoteReceiptV4 !== null
            ? buildTurnReceiptV5FromRemoteV4({
                receiptV4: turnCtx.observedRemoteReceiptV4,
                authorityEngine: authEngine,
                serviceTier,
                placementEpoch,
                finalizedAt:
                  turnCtx.observedRemoteFinalizedAt ??
                  new Date((args.clock ?? Date.now)()).toISOString(),
              })
            : ev.receipt
        const validated = router.recordReceipt(rawReceipt)
        turnCtx.receipt = validated
        args.onReceipt(validated)
        baseAdapter.emit('turn_receipt_v5', validated)
      }
    }
    turnCtx.finalized = true
    turnCtx.resolveSubmitted()
    turnCtx.resolveSummary(turnCtx.observedSummary)
  } catch (err) {
    turnCtx.finalized = true
    turnCtx.rejectSubmitted(err instanceof Error ? err : new Error(String(err)))
    turnCtx.resolveSummary(turnCtx.observedSummary)
  } finally {
    turnCtx.finalized = true
    args.onCleanup()
    turnCtx.resolveReceiptDone()
  }
}

export function interruptUnifiedActiveTurns(args: {
  readonly activeTurns: ReadonlyMap<string, LiveTurnContext>
  readonly poolKind: 'local_pool' | 'remote_pool'
  readonly router: UnifiedPoolRouterLike
  readonly baseAdapter: EngineAdapter
  readonly localBridgeState: { lastInterruptResult: boolean }
  readonly reason?: 'user' | 'system'
}): boolean {
  const { activeTurns, poolKind, router, baseAdapter, localBridgeState, reason } = args
  const label = reason === 'user' ? 'user_cancelled' : 'system_interrupted'
  let preDispatch = false
  let dispatchedId: string | null = null
  for (const t of activeTurns.values()) {
    t.cancelReason ??= label
    if (!t.dispatched) {
      t.cancelledBeforeDispatch = true
      preDispatch = true
    } else {
      dispatchedId = t.turnId
    }
  }
  if (dispatchedId !== null) {
    void router.interruptTurn(poolKind, dispatchedId, reason ?? 'system').catch((err: unknown) => {
      void err
    })
    return poolKind === 'local_pool' ? localBridgeState.lastInterruptResult : true
  }
  return preDispatch ? true : baseAdapter.interrupt(reason)
}

export async function shutdownUnifiedActiveTurns(args: {
  readonly activeTurns: Map<string, LiveTurnContext>
  readonly pendingLocalByReqId: Map<string, LiveTurnContext>
  readonly poolKind: 'local_pool' | 'remote_pool'
  readonly router: UnifiedPoolRouterLike
  readonly activeOperationId: string
}): Promise<void> {
  const pendingDone: Array<Promise<void>> = []
  for (const t of args.activeTurns.values()) {
    if (!t.dispatched) {
      t.cancelledBeforeDispatch = true
      t.cancelReason ??= 'shutdown'
    } else {
      t.baseRun?.end()
    }
    pendingDone.push(t.receiptDone)
  }
  await args.router.stopLane(args.poolKind, args.activeOperationId, 'shutdown')
  await Promise.allSettled(pendingDone)
  args.activeTurns.clear()
  args.pendingLocalByReqId.clear()
}
