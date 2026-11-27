/**
 * OCV5-915 P3-1 — Dual-Pool Live `InferencePoolDriver` Runtime & Transparent ES Proxy Facade.
 * Subdomain: `rt-codex-remote` (rank 1). Zero `rt-misc`/`rt-cc5` imports, zero `process.env`,
 * zero network APIs, zero `syncIo`, zero `emptyCatch`, zero `typeEscape`, zero engine literals.
 */
import { randomUUID } from 'node:crypto'
import {
  AUTHORITY_ENGINE_KINDS,
  authorityEngineToInferenceFamily,
  codexServiceTierBillingMultiplier,
  composeMultiplier,
  computeCostFen,
  isRemoteDriverExecutionBackend,
  parseRemoteDriverExecutionBackend,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  validateTurnReceiptV5,
  type AuthorityEngineKind,
  type DriverCapabilityManifest,
  type InferenceEngineFamily,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type NormalizedInferenceEvent,
  type NormalizedUsageCounters,
  type RemoteReceiptV4,
  type ServiceTier,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { EngineEvent, TurnSummary } from '../engine/engineEvents.js'
import type { UnifiedPoolAdapterWrapContext } from '../engine/registry.js'
import {
  getModelCatalogClient,
  lookupCatalogAgentMultiplier,
  type LocalCatalogPricing,
  type LocalCatalogView,
} from '../modelCatalogClient.js'
import {
  DEFAULT_UNIFIED_USAGE_SEMANTICS,
  InferencePoolDriverError,
  LocalPoolDriver,
  sanitizeIdentifier,
  sanitizeModelId,
  type AbandonResult,
  type CreditEstimatorFn,
  type DriverAdmission,
  type DriverTurnRequest,
  type StopLaneResult,
} from './localPoolDriver.js'
import {
  RemotePoolV5Driver,
  type RemoteV5LaneBridge,
  type RemoteV5LaneEvent,
  type RemoteV5TurnDispatchPayload,
} from './remotePoolV5Adapter.js'
import {
  buildAutoManifest,
  buildDriverTurnRequest,
  buildUnifiedTurnRunHandle,
  createDeferred,
  executeUnifiedTurnLifecycle,
  interruptUnifiedActiveTurns,
  parsePositiveEpoch,
  projectEngineEventToRemoteV5,
  shutdownUnifiedActiveTurns,
  toNormalizedUsage,
  type LiveTurnContext,
  type RawUsageInput,
  type RemoteProjectionState,
} from './livePoolDriverHelpers.js'

export type LiveExecutablePoolKind = 'local_pool' | 'remote_pool'
export const MAX_RECEIPT_CACHE_ENTRIES = 2048

const AGENT_MULTIPLIER_FAMILIES: ReadonlySet<InferenceEngineFamily> = new Set(['codex', 'grok'])
const ZERO_CREDITS_ESTIMATOR: CreditEstimatorFn = () => 0n
const ZERO_USAGE: NormalizedUsageCounters = Object.freeze({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
})

export interface CatalogPricingReader {
  readonly configured: boolean
  getView(): Promise<LocalCatalogView>
  peekView?(): { readonly view: LocalCatalogView; readonly verifiedAt: number } | null
  lookupAgentCostMultiplier?(agentId: string): Promise<string | null>
}
export type CatalogPricingLookupFn = (
  modelId: string,
) => Promise<LocalCatalogPricing | null> | LocalCatalogPricing | null
export interface LiveCatalogCreditGuardOptions {
  readonly budgetFen: bigint | undefined
  readonly modelId: () => string | undefined
  readonly agentId?: string
  readonly serviceTier: InferenceServiceTier
  readonly catalogClient?: CatalogPricingReader
  readonly resolvePricing?: CatalogPricingLookupFn
  readonly composeAgentMultiplier?: boolean
  readonly isLive: () => boolean
  readonly onExhausted: (cumulativeCreditsFen: bigint) => void
}

function priceUsageFen(
  u: NormalizedUsageCounters, modelId: string, pricing: LocalCatalogPricing,
  serviceTier: InferenceServiceTier, agentMultiplier?: string | null,
): bigint | null {
  try {
    let multiplier = agentMultiplier ? composeMultiplier(pricing.multiplier, agentMultiplier) : pricing.multiplier
    const tier: ServiceTier | null = serviceTier === 'fast' || serviceTier === 'ultrafast' ? serviceTier : null
    const tierMul = tier ? codexServiceTierBillingMultiplier(modelId, tier) : null
    if (tierMul) multiplier = composeMultiplier(multiplier, tierMul)
    return computeCostFen(
      { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens },
      {
        input_per_mtok: pricing.inputPerMtok, output_per_mtok: pricing.outputPerMtok,
        cache_read_per_mtok: pricing.cacheReadPerMtok, cache_write_per_mtok: pricing.cacheWritePerMtok, multiplier,
      },
    )
  } catch { return null }
}

/** Single cumulative turn-scoped catalog credit guard (B06 + Q2 + Q3). */
export class LiveCatalogCreditGuard {
  private readonly seenSamples = new Set<string>()
  private readonly call = { i: 0, o: 0, r: 0, w: 0 }
  private readonly cum = { i: 0, o: 0, r: 0, w: 0 }
  private exhausted = false
  private inflight = 0
  private pending: NormalizedUsageCounters | null = null
  private lastCostFen = 0n

  constructor(private readonly opts: LiveCatalogCreditGuardOptions) {}

  get active(): boolean { return this.opts.budgetFen !== undefined }
  get isExhausted(): boolean { return this.exhausted }
  get lastComputedCostFen(): bigint { return this.lastCostFen }
  get effectiveUsage(): NormalizedUsageCounters {
    return Object.freeze({
      inputTokens: Math.max(this.call.i, this.cum.i), outputTokens: Math.max(this.call.o, this.cum.o),
      cacheReadTokens: Math.max(this.call.r, this.cum.r), cacheWriteTokens: Math.max(this.call.w, this.cum.w),
    })
  }
  observeCallUsage(sampleId: string, usage: NormalizedUsageCounters): boolean {
    if (!sampleId || this.seenSamples.has(sampleId)) return false
    this.seenSamples.add(sampleId)
    const u = toNormalizedUsage(usage)
    this.call.i += u.inputTokens; this.call.o += u.outputTokens; this.call.r += u.cacheReadTokens; this.call.w += u.cacheWriteTokens
    if (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0) this.schedule(this.effectiveUsage)
    return true
  }
  observeCumulativeUsage(usage: RawUsageInput): boolean {
    const u = toNormalizedUsage(usage)
    const di = Math.max(0, u.inputTokens - this.cum.i); const dOut = Math.max(0, u.outputTokens - this.cum.o)
    const dr = Math.max(0, u.cacheReadTokens - this.cum.r); const dw = Math.max(0, u.cacheWriteTokens - this.cum.w)
    if (di + dOut + dr + dw <= 0) return false
    this.cum.i += di; this.cum.o += dOut; this.cum.r += dr; this.cum.w += dw
    this.schedule(this.effectiveUsage)
    return true
  }
  private schedule(snapshot: NormalizedUsageCounters): void {
    if (!this.active || this.exhausted || !this.opts.isLive()) return
    if (this.inflight > 0) { this.pending = snapshot; return }
    void this.evaluate(snapshot)
  }
  private async resolvePricing(modelId: string): Promise<{ readonly pricing: LocalCatalogPricing; readonly agentMul: string | null } | null> {
    if (this.opts.resolvePricing) {
      try {
        const direct = await this.opts.resolvePricing(modelId)
        if (!direct) return null
        if (this.opts.composeAgentMultiplier && this.opts.agentId && this.opts.catalogClient?.lookupAgentCostMultiplier) {
          const agentMul = await this.opts.catalogClient.lookupAgentCostMultiplier(this.opts.agentId)
          return agentMul ? { pricing: direct, agentMul } : null
        }
        return { pricing: direct, agentMul: null }
      } catch { return null }
    }
    const client = this.opts.catalogClient ?? getModelCatalogClient()
    if (!client.configured) return null
    try {
      const view = await client.getView()
      const row = view.resolve(view.canonicalize(modelId))
      if (!row?.pricing) return null
      let agentMul: string | null = null
      if (this.opts.composeAgentMultiplier && this.opts.agentId) {
        agentMul = client.lookupAgentCostMultiplier
          ? await client.lookupAgentCostMultiplier(this.opts.agentId)
          : lookupCatalogAgentMultiplier(view, this.opts.agentId)
        if (!agentMul) return null
      }
      return { pricing: row.pricing, agentMul }
    } catch { return null }
  }
  private async evaluate(snapshot: NormalizedUsageCounters): Promise<void> {
    const budget = this.opts.budgetFen
    if (budget === undefined) return
    this.inflight += 1
    try {
      const modelId = this.opts.modelId()?.trim()
      if (!modelId) return
      const resolved = await this.resolvePricing(modelId)
      if (!resolved || this.exhausted || !this.opts.isLive()) return
      const fen = priceUsageFen(snapshot, modelId, resolved.pricing, this.opts.serviceTier, resolved.agentMul)
      if (fen === null || this.exhausted || !this.opts.isLive()) return
      this.lastCostFen = fen
      if (fen >= budget) { this.exhausted = true; this.pending = null; this.opts.onExhausted(fen) }
    } finally {
      this.inflight -= 1
      const next = this.pending; this.pending = null
      if (next && !this.exhausted && this.opts.isLive()) void this.evaluate(next)
    }
  }
}

export function createCatalogCreditEstimator(opts: {
  readonly modelId: () => string | undefined; readonly catalogClient?: CatalogPricingReader
  readonly syncPricingLookup?: (modelId: string) => LocalCatalogPricing | null
}): CreditEstimatorFn {
  return (usage, serviceTier): bigint => {
    const modelId = opts.modelId()?.trim()
    if (!modelId) return 0n
    const client = opts.catalogClient ?? getModelCatalogClient()
    const peeked = !opts.syncPricingLookup && client.configured && client.peekView ? client.peekView() : null
    const pricing = opts.syncPricingLookup
      ? opts.syncPricingLookup(modelId)
      : (peeked ? (peeked.view.resolve(peeked.view.canonicalize(modelId))?.pricing ?? null) : null)
    return pricing ? (priceUsageFen(usage, modelId, pricing, serviceTier) ?? 0n) : 0n
  }
}

export interface GatewayInferencePoolRouterOptions {
  readonly localDriver?: LocalPoolDriver; readonly remoteDriver?: RemotePoolV5Driver; readonly maxReceiptCacheEntries?: number
}

export class GatewayInferencePoolRouter {
  private localDriver?: LocalPoolDriver
  private remoteDriver?: RemotePoolV5Driver
  private readonly maxEntries: number
  private readonly receiptCache = new Map<string, TurnReceiptV5>()
  private lastReceipt: TurnReceiptV5 | null = null

  constructor(opts: GatewayInferencePoolRouterOptions = {}) {
    this.localDriver = opts.localDriver; this.remoteDriver = opts.remoteDriver
    this.maxEntries = Math.max(1, Math.min(MAX_RECEIPT_CACHE_ENTRIES, Math.floor(opts.maxReceiptCacheEntries ?? MAX_RECEIPT_CACHE_ENTRIES)))
  }

  registerLocalDriver(driver: LocalPoolDriver): void { this.localDriver = driver }
  registerRemoteDriver(driver: RemotePoolV5Driver): void { this.remoteDriver = driver }
  getDriver(poolKind: LiveExecutablePoolKind): LocalPoolDriver | RemotePoolV5Driver | undefined {
    return poolKind === 'remote_pool' ? this.remoteDriver : this.localDriver
  }
  route(poolKind: LiveExecutablePoolKind): LocalPoolDriver | RemotePoolV5Driver {
    const driver = this.getDriver(poolKind)
    if (!driver) throw new InferencePoolDriverError('INFERENCE_POOL_DRIVER_UNAVAILABLE', `INFERENCE_POOL_DRIVER_UNAVAILABLE:${poolKind}`)
    return driver
  }
  async admit(poolKind: LiveExecutablePoolKind, req: DriverTurnRequest): Promise<{
    readonly poolKind: LiveExecutablePoolKind; readonly driver: LocalPoolDriver | RemotePoolV5Driver; readonly admission: DriverAdmission
  }> {
    const driver = this.route(poolKind)
    return Object.freeze({ poolKind, driver, admission: await driver.admit(req) })
  }
  async abandon(poolKind: LiveExecutablePoolKind, admissionId: string, reason: string): Promise<AbandonResult> { return await this.route(poolKind).abandon(admissionId, reason) }
  dispatch(poolKind: LiveExecutablePoolKind, admissionId: string): AsyncIterable<NormalizedInferenceEvent> { return this.route(poolKind).dispatch(admissionId) }
  async interruptTurn(poolKind: LiveExecutablePoolKind, turnId: string, reason = 'system'): Promise<void> { await this.getDriver(poolKind)?.interruptTurn(turnId, reason) }
  async stopLane(poolKind: LiveExecutablePoolKind, operationId: string, reason: string): Promise<StopLaneResult> { return await this.route(poolKind).stopLane(operationId, reason) }
  recordReceipt(receipt: TurnReceiptV5): TurnReceiptV5 {
    const validated = validateTurnReceiptV5(receipt)
    this.lastReceipt = validated
    if (this.receiptCache.has(validated.turnId)) this.receiptCache.delete(validated.turnId)
    else if (this.receiptCache.size >= this.maxEntries) {
      const oldest = this.receiptCache.keys().next().value
      if (oldest !== undefined) this.receiptCache.delete(oldest)
    }
    this.receiptCache.set(validated.turnId, validated)
    return validated
  }
  getLastReceipt(turnId?: string): TurnReceiptV5 | null { return turnId !== undefined ? (this.receiptCache.get(turnId) ?? null) : this.lastReceipt }
  listRecentReceipts(): readonly TurnReceiptV5[] { return Object.freeze([...this.receiptCache.values()]) }
  get receiptCacheSize(): number { return this.receiptCache.size }
}

export class LiveRemoteV5LaneBridge implements RemoteV5LaneBridge {
  private readonly turnContextByTurnId = new Map<string, LiveTurnContext>()
  private readonly turnIdByAdmissionId = new Map<string, string>()
  private readonly operationToTurnId = new Map<string, string>()

  constructor(private readonly baseAdapter: EngineAdapter, private readonly resolveManifest: () => DriverCapabilityManifest) {}

  registerTurnContext(ctx: LiveTurnContext): void { this.turnContextByTurnId.set(ctx.turnId, ctx) }
  unregisterTurnContext(turnId: string): void { this.turnContextByTurnId.delete(turnId) }
  async probeCapabilities(): Promise<DriverCapabilityManifest> { return this.resolveManifest() }
  async admitRemote(payload: RemoteV5TurnDispatchPayload): Promise<{ readonly operationId?: string; readonly laneGeneration?: number }> {
    this.turnIdByAdmissionId.set(payload.admissionId, payload.turnId)
    this.operationToTurnId.set(payload.operationId, payload.turnId)
    return { operationId: payload.operationId, laneGeneration: payload.laneGeneration }
  }
  async abandonRemote(admissionId: string, operationId: string): Promise<void> {
    const turnId = this.turnIdByAdmissionId.get(admissionId) ?? this.operationToTurnId.get(operationId)
    this.turnIdByAdmissionId.delete(admissionId); this.operationToTurnId.delete(operationId)
    if (turnId) this.turnContextByTurnId.delete(turnId)
  }

  dispatchTurn(payload: RemoteV5TurnDispatchPayload): AsyncIterable<RemoteV5LaneEvent> {
    const turnCtx = this.turnContextByTurnId.get(payload.turnId)
    const { baseAdapter, operationToTurnId, turnIdByAdmissionId } = this
    return (async function* (): AsyncIterable<RemoteV5LaneEvent> {
      const queue: RemoteV5LaneEvent[] = []
      let closed = false; let wake: (() => void) | null = null
      const signal = () => { const fn = wake; wake = null; fn?.() }
      const push = (ev: RemoteV5LaneEvent) => { queue.push(ev); signal() }
      let nativeSid: string | null = baseAdapter.nativeSessionId ?? payload.nativeSessionId ?? null
      const onSessionId = (sid: string) => { if (typeof sid === 'string' && sid.length > 0) nativeSid = sid }
      const onReceiptV4 = (receipt: RemoteReceiptV4, meta?: { readonly finalizedAt?: string }) => {
        if (turnCtx) {
          turnCtx.observedRemoteReceiptV4 = receipt
          if (typeof meta?.finalizedAt === 'string') turnCtx.observedRemoteFinalizedAt = meta.finalizedAt
        }
        push({ kind: 'remote_receipt_v4', receipt })
      }
      baseAdapter.on('session_id', onSessionId)
      baseAdapter.on('remote_receipt_v4', onReceiptV4)
      const proj: RemoteProjectionState = { emittedToolReq: new Set(), emittedToolDone: new Set(), toolArgsSha: new Map() }
      const onEvent = (e: EngineEvent): void => {
        turnCtx?.fullParams.onEvent(e)
        projectEngineEventToRemoteV5(e, payload.turnId, proj, turnCtx, push)
      }
      const runnerTask = (async () => {
        try {
          const turnParams: TurnParams = turnCtx ? { ...turnCtx.fullParams, onEvent } : {
            input: payload.input.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
            ...(payload.readOnly ? { readOnly: true } : {}),
            serviceTier: payload.serviceTier === 'fast' || payload.serviceTier === 'ultrafast' ? payload.serviceTier : null,
            requestId: payload.requestId, turnKey: payload.turnKey,
            ...(payload.creditBudgetFen === undefined ? {} : { creditBudgetFen: payload.creditBudgetFen }),
            onEvent, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map<string, string>(),
          }
          const baseRun = baseAdapter.submitTurn(turnParams)
          if (turnCtx) turnCtx.baseRun = baseRun
          let submitErr: Error | null = null
          try { await baseRun.submitted; turnCtx?.resolveSubmitted() } catch (err) {
            submitErr = err instanceof Error ? err : new Error(String(err)); turnCtx?.rejectSubmitted(submitErr)
          }
          push({
            kind: 'dispatched', ...(nativeSid ? { nativeSessionId: nativeSid } : {}),
            nativeTurnId: payload.authorityTurnId ?? payload.turnId, upstreamModel: payload.upstreamModel,
          })
          let summary: TurnSummary | null = null
          try { summary = await baseRun.summary } catch { summary = null }
          if (turnCtx) turnCtx.observedSummary = summary
          const usage = summary ? toNormalizedUsage(summary.usage) : (proj.latestTurnUsage ?? ZERO_USAGE)
          let status: 'success' | 'error' | 'interrupted' = 'success'
          let errorCode: string | undefined
          if (turnCtx?.catalogGuard.isExhausted) { status = 'interrupted'; errorCode = 'budget_exceeded' }
          else if (turnCtx?.cancelReason) { status = 'interrupted'; errorCode = sanitizeIdentifier(turnCtx.cancelReason, 'interrupted') }
          else if (submitErr || proj.streamErrorCode || !summary || summary.isError) {
            status = 'error'
            errorCode = sanitizeIdentifier(proj.streamErrorCode ?? summary?.errorClass ?? submitErr?.message ?? 'remote_error', 'remote_error')
          }
          push({ kind: 'terminal', terminalId: `term_${payload.turnId}`, status, ...(errorCode === undefined ? {} : { errorCode }), usage })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          turnCtx?.rejectSubmitted(error)
          push({ kind: 'terminal', terminalId: `term_${payload.turnId}`, status: 'error', errorCode: sanitizeIdentifier(error.message, 'remote_error') })
        } finally { closed = true; signal() }
      })()
      try {
        while (!closed || queue.length > 0) {
          if (queue.length > 0) yield queue.shift()!
          else await new Promise<void>((r) => { wake = r })
        }
        await runnerTask
      } finally {
        baseAdapter.off('session_id', onSessionId); baseAdapter.off('remote_receipt_v4', onReceiptV4)
        turnIdByAdmissionId.delete(payload.admissionId); operationToTurnId.delete(payload.operationId)
      }
    })()
  }

  async submitPermissionDecision(permissionId: string, decision: unknown): Promise<boolean> { return this.baseAdapter.sendPermissionResponse(permissionId, decision) }
  async interrupt(_operationId: string, reason: string): Promise<void> { this.baseAdapter.interrupt(reason === 'user' ? 'user' : 'system') }
  async stopRemote(operationId: string): Promise<{ readonly remoteStopped: boolean }> {
    this.operationToTurnId.delete(operationId)
    await this.baseAdapter.shutdown()
    if (typeof this.baseAdapter.waitForOutputDrain === 'function') await this.baseAdapter.waitForOutputDrain()
    return { remoteStopped: true }
  }
}

function createLocalDriverBridgeAdapter(
  baseAdapter: EngineAdapter, pendingByReqId: Map<string, LiveTurnContext>, state: { lastInterruptResult: boolean },
): EngineAdapter {
  const submitTurn = (driverParams: TurnParams): EngineTurnRun => {
    const reqKey = driverParams.requestId ?? ''
    const turnCtx = pendingByReqId.get(reqKey)
    if (!turnCtx) return baseAdapter.submitTurn(driverParams)
    pendingByReqId.delete(reqKey)
    const baseRun = baseAdapter.submitTurn({
      ...turnCtx.fullParams,
      onEvent: (e: EngineEvent) => {
        if (e.kind === 'call_usage') turnCtx.catalogGuard.observeCallUsage(e.call.callId, toNormalizedUsage(e.call.usage))
        else if (e.kind === 'usage') turnCtx.catalogGuard.observeCumulativeUsage(e.usage)
        turnCtx.fullParams.onEvent(e); driverParams.onEvent(e)
      },
    })
    turnCtx.baseRun = baseRun
    void baseRun.submitted.then(() => turnCtx.resolveSubmitted(), (err: unknown) => turnCtx.rejectSubmitted(err instanceof Error ? err : new Error(String(err))))
    void baseRun.summary.then((s) => { turnCtx.observedSummary = s })
    return baseRun
  }
  return new Proxy<EngineAdapter>(baseAdapter, {
    get(target, prop) {
      if (prop === 'submitTurn') return submitTurn
      if (prop === 'interrupt') return (reason?: 'user' | 'system'): boolean => { state.lastInterruptResult = target.interrupt(reason); return state.lastInterruptResult }
      if (prop === 'setModel' || prop === 'setEffortLevel' || prop === 'setResumeSessionId') return () => undefined
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target) },
  })
}

export interface UnifiedPoolAdapterStatus {
  readonly poolKind: LiveExecutablePoolKind; readonly driverId: string
  readonly activeTurnCount: number; readonly receiptCacheSize: number; readonly lastTurnReceiptV5: TurnReceiptV5 | null
}
export interface UnifiedPoolEngineAdapter extends EngineAdapter {
  readonly unifiedPoolKind: LiveExecutablePoolKind; readonly unifiedPoolRouter: GatewayInferencePoolRouter
  readonly lastTurnReceiptV5: TurnReceiptV5 | null
  getLastTurnReceiptV5(): TurnReceiptV5 | null
  getUnifiedPoolStatus(): UnifiedPoolAdapterStatus
}
export interface WrapEngineWithUnifiedPoolDriverOptions {
  readonly router?: GatewayInferencePoolRouter; readonly manifest?: DriverCapabilityManifest
  readonly catalogClient?: CatalogPricingReader; readonly resolvePricing?: CatalogPricingLookupFn
  readonly syncPricingLookup?: (modelId: string) => LocalCatalogPricing | null
  readonly composeAgentMultiplier?: boolean; readonly usageSemantics?: string; readonly tenantId?: string
  readonly onAdmitJournal?: (req: DriverTurnRequest, admission: DriverAdmission) => Promise<void> | void
  readonly onAbandonJournal?: (admissionId: string, reason: string) => Promise<void> | void
  readonly clock?: () => number
}

function createUnifiedPoolAdapterProxy(
  baseAdapter: EngineAdapter,
  handlers: {
    readonly submitTurn: (params: TurnParams) => EngineTurnRun
    readonly interrupt: (reason?: 'user' | 'system') => boolean
    readonly shutdown: () => Promise<void>
    readonly poolKind: LiveExecutablePoolKind
    readonly router: GatewayInferencePoolRouter
    readonly getLastReceipt: () => TurnReceiptV5 | null
    readonly getStatus: () => UnifiedPoolAdapterStatus
  },
): UnifiedPoolEngineAdapter {
  return new Proxy<EngineAdapter>(baseAdapter, {
    get(target, prop) {
      if (prop === 'submitTurn') return handlers.submitTurn
      if (prop === 'interrupt') return handlers.interrupt
      if (prop === 'shutdown') return handlers.shutdown
      if (prop === 'unifiedPoolKind') return handlers.poolKind
      if (prop === 'unifiedPoolRouter') return handlers.router
      if (prop === 'lastTurnReceiptV5') return handlers.getLastReceipt()
      if (prop === 'getLastTurnReceiptV5') return handlers.getLastReceipt
      if (prop === 'getUnifiedPoolStatus') return handlers.getStatus
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target)
    },
  }) as UnifiedPoolEngineAdapter
}

function createUnifiedDriverSetup(args: {
  readonly baseAdapter: EngineAdapter
  readonly ctx: UnifiedPoolAdapterWrapContext
  readonly options: WrapEngineWithUnifiedPoolDriverOptions
  readonly router: GatewayInferencePoolRouter
  readonly pendingLocalByReqId: Map<string, LiveTurnContext>
  readonly localBridgeState: { lastInterruptResult: boolean }
}) {
  const { baseAdapter, ctx, options, router, pendingLocalByReqId, localBridgeState } = args
  const poolKind: LiveExecutablePoolKind = ctx.poolKind
  let currentManifest: DriverCapabilityManifest | null = options.manifest
    ? validateDriverCapabilityManifest(options.manifest)
    : null
  let registeredManifest: DriverCapabilityManifest | null = null

  const currentRawModel = (): string => sanitizeModelId(baseAdapter.model ?? ctx.opts.model, 'default-model')
  const ensureManifest = (rawModel: string): DriverCapabilityManifest => {
    if (options.manifest) return currentManifest!
    const sanitized = sanitizeModelId(rawModel, 'default-model')
    const logical = resolveLogicalModelId(sanitized).logicalModel
    if (currentManifest?.models.some((m) => m.logicalModel === logical)) return currentManifest
    currentManifest = buildAutoManifest(baseAdapter, ctx, logical, sanitized)
    return currentManifest
  }

  const localBridgeAdapter =
    poolKind === 'local_pool'
      ? createLocalDriverBridgeAdapter(baseAdapter, pendingLocalByReqId, localBridgeState)
      : null
  const remoteLaneBridge =
    poolKind === 'remote_pool'
      ? new LiveRemoteV5LaneBridge(baseAdapter, () => ensureManifest(currentRawModel()))
      : null

  const ensureDriver = (manifest: DriverCapabilityManifest): void => {
    if (router.getDriver(poolKind) && registeredManifest === manifest) return
    const sharedOpts = {
      manifest,
      estimateCreditsFen: ZERO_CREDITS_ESTIMATOR,
      usageSemantics: options.usageSemantics ?? DEFAULT_UNIFIED_USAGE_SEMANTICS,
      resolveCanonicalModel: () => currentRawModel(),
      resolveUpstreamModel: (_logical: string, matched: LogicalModelCapability) =>
        matched.upstreamModelId ?? currentRawModel(),
      onAdmitJournal: options.onAdmitJournal,
      onAbandonJournal: options.onAbandonJournal,
      clock: options.clock,
    }
    if (poolKind === 'remote_pool') {
      router.registerRemoteDriver(new RemotePoolV5Driver({ ...sharedOpts, bridge: remoteLaneBridge! }))
    } else {
      router.registerLocalDriver(new LocalPoolDriver({ ...sharedOpts, adapter: localBridgeAdapter! }))
    }
    registeredManifest = manifest
  }
  const initialManifest = ensureManifest(currentRawModel())
  ensureDriver(initialManifest)

  return {
    initialManifest,
    remoteLaneBridge,
    currentRawModel,
    ensureReady: (rawModel: string) => ensureDriver(ensureManifest(rawModel)),
  }
}

function createLiveTurnContext(args: {
  readonly turnId: string
  readonly requestId: string
  readonly turnKey: string
  readonly params: TurnParams
  readonly rawModel: string
  readonly serviceTier: InferenceServiceTier
  readonly baseAdapter: EngineAdapter
  readonly ctx: UnifiedPoolAdapterWrapContext
  readonly options: WrapEngineWithUnifiedPoolDriverOptions
  readonly composeAgentMul: boolean
  readonly poolKind: LiveExecutablePoolKind
  readonly router: GatewayInferencePoolRouter
  readonly activeTurns: ReadonlyMap<string, LiveTurnContext>
  readonly isLatestTurn: (turnId: string) => boolean
  readonly shuttingDown: boolean
}) {
  const { turnId, requestId, turnKey, params, rawModel, serviceTier, baseAdapter, ctx, options } = args
  const subDef = createDeferred<void>()
  subDef.promise.catch((err: unknown) => {
    void err
  })
  const sumDef = createDeferred<TurnSummary | null>()
  const recDef = createDeferred<void>()
  const turnCtx: LiveTurnContext = {
    turnId,
    requestId,
    turnKey,
    fullParams: params,
    catalogGuard: new LiveCatalogCreditGuard({
      budgetFen: params.creditBudgetFen,
      modelId: () => baseAdapter.model ?? ctx.opts.model ?? rawModel,
      agentId: ctx.opts.agentId,
      serviceTier,
      catalogClient: options.catalogClient,
      resolvePricing: options.resolvePricing,
      composeAgentMultiplier: args.composeAgentMul,
      isLive: () =>
        !turnCtx.finalized &&
        !turnCtx.ended &&
        args.activeTurns.has(turnId) &&
        args.isLatestTurn(turnId),
      onExhausted: () => {
        turnCtx.cancelReason ??= 'budget_exceeded'
        void args.router.interruptTurn(args.poolKind, turnId, 'budget_exceeded').catch((err: unknown) => {
          void err
        })
      },
    }),
    resolveSubmitted: () => subDef.resolve(undefined),
    rejectSubmitted: subDef.reject,
    resolveSummary: sumDef.resolve,
    resolveReceiptDone: () => recDef.resolve(undefined),
    receiptDone: recDef.promise,
    admissionId: null,
    baseRun: null,
    dispatched: false,
    cancelledBeforeDispatch: args.shuttingDown,
    cancelReason: args.shuttingDown ? 'shutdown' : null,
    finalized: false,
    ended: false,
    observedSummary: null,
    observedRemoteReceiptV4: null,
    observedRemoteFinalizedAt: null,
    receipt: null,
  }
  return { turnCtx, subDef, sumDef }
}

export function wrapEngineWithUnifiedPoolDriver(
  baseAdapter: EngineAdapter,
  ctx: UnifiedPoolAdapterWrapContext,
  options: WrapEngineWithUnifiedPoolDriverOptions = {},
): UnifiedPoolEngineAdapter {
  const poolKind: LiveExecutablePoolKind = ctx.poolKind
  const router = options.router ?? new GatewayInferencePoolRouter()
  const activeTurns = new Map<string, LiveTurnContext>()
  const pendingLocalByReqId = new Map<string, LiveTurnContext>()
  const localBridgeState = { lastInterruptResult: false }
  const rawAuth = ctx.engineId || baseAdapter.engineId
  const authEngine: AuthorityEngineKind = AUTHORITY_ENGINE_KINDS.find((k) => k === rawAuth) ?? 'ccb'
  const engineFamily = authorityEngineToInferenceFamily(authEngine)
  const remoteBackend = isRemoteDriverExecutionBackend(baseAdapter.executionBackend)
    ? parseRemoteDriverExecutionBackend(baseAdapter.executionBackend)
    : null
  const placementEpoch = parsePositiveEpoch(remoteBackend?.generation, 1)
  const composeAgentMul =
    options.composeAgentMultiplier ??
    (poolKind === 'local_pool' && AGENT_MULTIPLIER_FAMILIES.has(engineFamily))

  let latestTurnId: string | null = null
  let lastTurnReceiptV5: TurnReceiptV5 | null = null
  let shuttingDown = false
  let activeOperationId = remoteBackend ? remoteBackend.operationId : randomUUID()

  const setup = createUnifiedDriverSetup({
    baseAdapter,
    ctx,
    options,
    router,
    pendingLocalByReqId,
    localBridgeState,
  })

  const submitTurn = (params: TurnParams): EngineTurnRun => {
    const rawModel = setup.currentRawModel()
    const { turnId, requestId, turnKey, serviceTier, driverRequest } = buildDriverTurnRequest({
      params, ctx, baseAdapter, activeTurns, rawModel, poolKind, placementEpoch,
      activeOperationId, tenantIdOverride: options.tenantId,
    })
    latestTurnId = turnId
    const { turnCtx, subDef, sumDef } = createLiveTurnContext({
      turnId, requestId, turnKey, params, rawModel, serviceTier, baseAdapter, ctx, options,
      composeAgentMul, poolKind, router, activeTurns,
      isLatestTurn: (id) => latestTurnId === id,
      shuttingDown,
    })
    activeTurns.set(turnId, turnCtx)
    if (poolKind === 'local_pool') pendingLocalByReqId.set(requestId, turnCtx)
    else setup.remoteLaneBridge?.registerTurnContext(turnCtx)

    void executeUnifiedTurnLifecycle({
      poolKind, authEngine, serviceTier, placementEpoch, rawModel, driverRequest, turnCtx,
      router, baseAdapter, clock: options.clock, ensureReady: setup.ensureReady,
      isShuttingDown: () => shuttingDown,
      onOperationId: (opId) => { activeOperationId = opId },
      onReceipt: (rec) => { lastTurnReceiptV5 = rec },
      onCleanup: () => {
        activeTurns.delete(turnId)
        pendingLocalByReqId.delete(requestId)
        setup.remoteLaneBridge?.unregisterTurnContext(turnId)
      },
    })
    return buildUnifiedTurnRunHandle(turnCtx, subDef.promise, sumDef.promise)
  }

  return createUnifiedPoolAdapterProxy(baseAdapter, {
    submitTurn,
    interrupt: (reason) =>
      interruptUnifiedActiveTurns({ activeTurns, poolKind, router, baseAdapter, localBridgeState, reason }),
    shutdown: async () => {
      shuttingDown = true
      await shutdownUnifiedActiveTurns({ activeTurns, pendingLocalByReqId, poolKind, router, activeOperationId })
    },
    poolKind,
    router,
    getLastReceipt: () => lastTurnReceiptV5,
    getStatus: () => ({
      poolKind,
      driverId: router.getDriver(poolKind)?.driverId ?? setup.initialManifest.driverId,
      activeTurnCount: activeTurns.size,
      receiptCacheSize: router.receiptCacheSize,
      lastTurnReceiptV5,
    }),
  })
}
