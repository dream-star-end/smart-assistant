/**
 * OCV5-890 Wave 2 — Layer 2 RemotePoolV5Driver (`InferencePoolDriver`).
 *
 * Bridges remote `RemoteContainerLane` / v5 relay through the narrow `RemoteV5LaneBridge`
 * seam so Remote Pool and Local Pool are 100% isomorphic from the caller's perspective:
 * - Identical 3-phase transaction state machine (`admit` -> `abandon` | `dispatch`)
 * - Full fidelity pass-through of `serviceTier`, multimodal `input` (`blob_ref`/`image_ref`/`text`),
 *   `stickyHomeKey`, and `frozenPlatformPrompt` (zero silent flattening)
 * - Identical mid-turn `CreditBudgetGuard` triggering `interrupt('budget_exceeded')`
 * - Remote `compaction` presentation -> standard `context_compacted`
 * - Remote `RemoteReceiptV4` / raw counters -> authoritative self-validated `TurnReceiptV5`
 * - Dual-proof `stopLane` (`/stop` + container `/tool/stopped`) reaping ONLY `ephemeral_turn`
 *
 * Architecture invariants:
 * - Zero `node:sqlite`, `process.env`, network APIs, forbidden crypto primitives, or engine special cases.
 * - Value imports restricted to L0 `@openclaude/protocol` and same-module L3 `gateway-runtime`.
 */
import { randomUUID } from 'node:crypto'
import {
  type JobLifecycleClass,
  type RemoteDriverUsagePolicy,
  type RemotePresentationItem,
  type RemoteReceiptV4,
  type ToolBridgeEndpoint,
  type ToolResultEnvelope,
  computeStickyHomeKey,
  normalizeUsageWithPolicy,
  remoteCanonicalSha256,
} from '@openclaude/protocol'
import {
  type DriverCapabilityManifest,
  type InferenceEngineFamily,
  type InferencePoolDriver,
  type InferencePoolKind,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type NormalizedInferenceEvent,
  type NormalizedUsageCounters,
  type PlatformReasoningEffort,
  type RequiredTurnCapabilities,
  type TurnReceiptV5,
  type UnifiedTurnInputBlock,
  type UnifiedTurnRequest,
  computeEffectiveModelCapabilities,
  validateDriverCapabilityManifest,
} from '@openclaude/protocol/inference-pool'
import type {
  ExecEnvJobRegistry,
  ExecEnvReapStopProof,
  ToolBrokerServer,
} from '../execEnv/index.js'
import {
  type AbandonResult,
  type BuildDriverCapabilityManifestOptions,
  CreditBudgetGuard,
  type CreditEstimatorFn,
  DEFAULT_UNIFIED_USAGE_SEMANTICS,
  type DriverAdmission,
  type DriverTerminalStatus,
  type DriverTurnRequest,
  InferencePoolDriverError,
  type PendingSettlementOutbox,
  type PendingSettlementRecord,
  type StopLaneResult,
  type TurnSettlementInfo,
  assertAdmitEligibility,
  buildValidatedTurnReceiptV5,
  isSha256Hex,
  mapStopReasonToExecEnvReason,
  mergeUsageCountersMax,
  safeNonNegativeInt,
  sanitizeIdentifier,
  sanitizeModelId,
} from './localPoolDriver.js'

export interface RemoteV5TurnDispatchPayload {
  readonly admissionId: string
  readonly operationId: string
  readonly laneGeneration: number
  readonly turnId: string
  readonly turnKey: string
  readonly requestId: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly logicalModel: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly serviceTier: InferenceServiceTier
  readonly reasoningEffort?: PlatformReasoningEffort
  /** Structured multimodal input preserved verbatim (`text` | `blob_ref` | `image_ref`). */
  readonly input: readonly UnifiedTurnInputBlock[]
  readonly stickyHomeKey: string
  readonly cacheAffinityKey?: string
  readonly frozenPlatformPrompt?: string
  readonly systemInstructions?: string
  readonly toolBridge?: ToolBridgeEndpoint
  readonly readOnly: boolean
  readonly consultTurn: boolean
  readonly hermeticNoTools: boolean
  readonly needsSwarm: boolean
  readonly nativeSessionId?: string | null
  readonly authorityTurnId?: string
  readonly placementEpoch: number
  readonly creditBudgetFen?: bigint
}

export type RemoteV5LaneEvent =
  | {
      readonly kind: 'dispatched'
      readonly nativeSessionId?: string
      readonly nativeTurnId?: string
      readonly upstreamModel?: string
    }
  | {
      readonly kind: 'text_delta'
      readonly channel: 'answer' | 'reasoning'
      readonly delta: string
    }
  | {
      readonly kind: 'tool_call_delta'
      readonly callId: string
      readonly toolName: string
      readonly argsDelta: string
    }
  | {
      readonly kind: 'tool_call_request'
      readonly callId: string
      readonly toolName: string
      readonly arguments: Readonly<Record<string, unknown>>
      readonly argsSha256?: string
    }
  | {
      readonly kind: 'tool_call_observed'
      readonly callId: string
      readonly toolName: string
      readonly phase: 'started' | 'completed'
      readonly argsSha256: string
    }
  | {
      readonly kind: 'permission_request'
      readonly permissionId: string
      readonly toolName: string
      readonly reason: string
      readonly riskLevel?: 'low' | 'medium' | 'high'
    }
  | {
      readonly kind: 'context_pressure'
      readonly usedTokens: number
      readonly contextWindow: number
      readonly ratio: number
    }
  | {
      readonly kind: 'compaction'
      readonly reason?: string
      readonly beforeTokens?: number
      readonly afterTokens?: number
      readonly clearedPromptCache?: boolean
    }
  | {
      readonly kind: 'presentation'
      readonly item: RemotePresentationItem
    }
  | {
      readonly kind: 'call_usage'
      readonly sampleId: string
      readonly scopeId: string
      readonly usage?: NormalizedUsageCounters
      readonly rawCounters?: Readonly<Record<string, number>>
      readonly countersBaseline?: Readonly<Record<string, number>> | null
      readonly usagePolicy?: RemoteDriverUsagePolicy
    }
  | {
      readonly kind: 'turn_status'
      readonly phase: string
      readonly message?: string
    }
  | {
      readonly kind: 'disallowed_item'
      readonly itemType: string
      readonly reason: string
    }
  | {
      readonly kind: 'remote_receipt_v4'
      readonly receipt: RemoteReceiptV4
    }
  | {
      readonly kind: 'terminal'
      readonly terminalId?: string
      readonly status: 'success' | 'error' | 'interrupted'
      readonly errorCode?: string
      readonly usage?: NormalizedUsageCounters
      readonly rawCounters?: Readonly<Record<string, number>>
      readonly countersBaseline?: Readonly<Record<string, number>> | null
      readonly usagePolicy?: RemoteDriverUsagePolicy
      readonly rawEvidenceDigest?: string
    }

export interface RemoteV5LaneBridge {
  probeCapabilities?(): Promise<DriverCapabilityManifest>
  admitRemote?(
    payload: RemoteV5TurnDispatchPayload,
  ): Promise<{ readonly operationId?: string; readonly laneGeneration?: number } | undefined>
  abandonRemote?(admissionId: string, operationId: string, reason: string): Promise<void>
  dispatchTurn(payload: RemoteV5TurnDispatchPayload): AsyncIterable<RemoteV5LaneEvent>
  submitToolResult?(callId: string, result: ToolResultEnvelope): Promise<boolean>
  submitPermissionDecision?(permissionId: string, decision: unknown): Promise<boolean>
  interrupt(operationId: string, reason: string): Promise<void>
  stopRemote(operationId: string, reason: string): Promise<{ readonly remoteStopped: boolean }>
  stopToolHost?(
    operationId: string,
    leaseId: string,
    reason: string,
  ): Promise<{ readonly toolHostStopped: boolean }>
}

export interface RemotePoolV5DriverOptions {
  readonly bridge: RemoteV5LaneBridge
  readonly manifest: DriverCapabilityManifest
  readonly usagePolicy?: RemoteDriverUsagePolicy
  readonly toolBroker?: ToolBrokerServer
  readonly jobRegistry?: ExecEnvJobRegistry
  readonly defaultLeaseId?: string
  readonly estimateCreditsFen?: CreditEstimatorFn
  readonly usageSemantics?: string
  readonly resolveCanonicalModel?: (logicalModel: string) => string
  readonly resolveUpstreamModel?: (logicalModel: string, matched: LogicalModelCapability) => string
  readonly onAdmitJournal?: (
    req: DriverTurnRequest,
    admission: DriverAdmission,
  ) => Promise<void> | void
  readonly onAbandonJournal?: (admissionId: string, reason: string) => Promise<void> | void
  readonly onSettleReceipt?: (
    receipt: TurnReceiptV5,
    settlement: TurnSettlementInfo,
  ) => Promise<void> | void
  readonly pendingSettlementOutbox?: PendingSettlementOutbox
  readonly probeAuthoritativeSettlement?: (billingRequestId: string) => Promise<boolean> | boolean
  readonly clock?: () => number
  readonly initialLaneGeneration?: number
}

export function buildRemoteDriverCapabilityManifest(
  opts: BuildDriverCapabilityManifestOptions,
): DriverCapabilityManifest {
  const models: LogicalModelCapability[] = opts.models.map((entry) =>
    computeEffectiveModelCapabilities(entry.probed, entry.transport, entry.catalog),
  )
  return validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: opts.poolKind ?? 'remote_pool',
    engineFamily: opts.engineFamily,
    authorityEngine: opts.authorityEngine,
    driverId: opts.driverId,
    driverVersion: opts.driverVersion,
    observedAt: opts.observedAt ?? new Date().toISOString(),
    models,
  })
}

function normalizeRemoteUsageInput(params: {
  readonly usage?: NormalizedUsageCounters
  readonly rawCounters?: Readonly<Record<string, number>>
  readonly countersBaseline?: Readonly<Record<string, number>> | null
  readonly usagePolicy?: RemoteDriverUsagePolicy
  readonly fallbackPolicy?: RemoteDriverUsagePolicy
}): NormalizedUsageCounters {
  if (params.usage) {
    return Object.freeze({
      inputTokens: safeNonNegativeInt(params.usage.inputTokens),
      outputTokens: safeNonNegativeInt(params.usage.outputTokens),
      cacheReadTokens: safeNonNegativeInt(params.usage.cacheReadTokens),
      cacheWriteTokens: safeNonNegativeInt(params.usage.cacheWriteTokens),
      ...(params.usage.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: safeNonNegativeInt(params.usage.reasoningTokens) }),
    })
  }
  const policy = params.usagePolicy ?? params.fallbackPolicy
  if (params.rawCounters && policy) {
    const normalized = normalizeUsageWithPolicy(
      policy,
      params.rawCounters,
      params.countersBaseline ?? null,
    )
    return Object.freeze({
      inputTokens: normalized.usage.inputTokens,
      outputTokens: normalized.usage.outputTokens,
      cacheReadTokens: normalized.usage.cacheReadTokens,
      cacheWriteTokens: normalized.usage.cacheWriteTokens,
    })
  }
  if (params.rawCounters) {
    return Object.freeze({
      inputTokens: safeNonNegativeInt(
        params.rawCounters.inputTokens ?? params.rawCounters.input_tokens,
      ),
      outputTokens: safeNonNegativeInt(
        params.rawCounters.outputTokens ?? params.rawCounters.output_tokens,
      ),
      cacheReadTokens: safeNonNegativeInt(
        params.rawCounters.cacheReadTokens ?? params.rawCounters.cache_read_input_tokens,
      ),
      cacheWriteTokens: safeNonNegativeInt(
        params.rawCounters.cacheWriteTokens ?? params.rawCounters.cache_creation_input_tokens,
      ),
    })
  }
  return Object.freeze({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
}

interface RemoteAdmissionRecord {
  readonly admissionId: string
  readonly operationId: string
  readonly laneGeneration: number
  readonly leaseId: string
  readonly request: UnifiedTurnRequest
  readonly originalRequest: DriverTurnRequest
  readonly requiredCapabilities: RequiredTurnCapabilities
  readonly matchedModel: LogicalModelCapability
  readonly dispatchPayload: RemoteV5TurnDispatchPayload
  dispatched: boolean
  abandoning: boolean
  remoteAbandoned: boolean
  abandoned: boolean
  settled: boolean
  settledOnce: boolean
  settledReceipt: TurnReceiptV5 | null
  pendingSettlement: PendingSettlementRecord | null
  activeExecutionPromise: Promise<TurnReceiptV5 | null> | null
  interruptedReason?: string
}

export class RemotePoolV5Driver implements InferencePoolDriver {
  static readonly buildRemoteDriverCapabilityManifest = buildRemoteDriverCapabilityManifest

  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly driverId: string
  readonly driverVersion: string

  private readonly bridge: RemoteV5LaneBridge
  private readonly manifest: DriverCapabilityManifest
  private readonly usagePolicy?: RemoteDriverUsagePolicy
  private readonly toolBroker?: ToolBrokerServer
  private readonly jobRegistry?: ExecEnvJobRegistry
  private readonly defaultLeaseId?: string
  private readonly estimateCreditsFen?: CreditEstimatorFn
  private readonly usageSemantics: string
  private readonly resolveCanonicalModel?: (logicalModel: string) => string
  private readonly resolveUpstreamModel?: (
    logicalModel: string,
    matched: LogicalModelCapability,
  ) => string
  private readonly onAdmitJournal?: RemotePoolV5DriverOptions['onAdmitJournal']
  private readonly onAbandonJournal?: RemotePoolV5DriverOptions['onAbandonJournal']
  private readonly onSettleReceipt?: RemotePoolV5DriverOptions['onSettleReceipt']
  private readonly pendingSettlementOutbox?: PendingSettlementOutbox
  private readonly probeAuthoritativeSettlement?: (
    billingRequestId: string,
  ) => Promise<boolean> | boolean
  private readonly clock: () => number

  private laneGeneration: number
  private readonly admissions = new Map<string, RemoteAdmissionRecord>()
  private readonly activeByTurnId = new Map<string, RemoteAdmissionRecord>()
  private readonly operationToLease = new Map<string, string>()
  private readonly pendingSettlements = new Map<string, PendingSettlementRecord>()
  private readonly settlementInFlight = new Map<string, Promise<TurnReceiptV5>>()

  constructor(opts: RemotePoolV5DriverOptions) {
    this.manifest = validateDriverCapabilityManifest(opts.manifest)
    this.bridge = opts.bridge
    this.poolKind = this.manifest.poolKind
    this.engineFamily = this.manifest.engineFamily
    this.driverId = this.manifest.driverId
    this.driverVersion = this.manifest.driverVersion
    this.usagePolicy = opts.usagePolicy
    this.toolBroker = opts.toolBroker
    this.jobRegistry = opts.jobRegistry
    this.defaultLeaseId = opts.defaultLeaseId
    this.estimateCreditsFen = opts.estimateCreditsFen
    this.usageSemantics = sanitizeIdentifier(
      opts.usageSemantics ?? opts.usagePolicy?.semanticsId,
      DEFAULT_UNIFIED_USAGE_SEMANTICS,
    )
    this.resolveCanonicalModel = opts.resolveCanonicalModel
    this.resolveUpstreamModel = opts.resolveUpstreamModel
    this.onAdmitJournal = opts.onAdmitJournal
    this.onAbandonJournal = opts.onAbandonJournal
    this.onSettleReceipt = opts.onSettleReceipt
    this.pendingSettlementOutbox = opts.pendingSettlementOutbox
    this.probeAuthoritativeSettlement = opts.probeAuthoritativeSettlement
    this.clock = opts.clock ?? (() => Date.now())
    this.laneGeneration = Math.max(1, Math.floor(opts.initialLaneGeneration ?? 1))
  }

  async probeCapabilities(): Promise<DriverCapabilityManifest> {
    if (this.bridge.probeCapabilities) {
      return validateDriverCapabilityManifest(await this.bridge.probeCapabilities())
    }
    return this.manifest
  }

  async admit(req: DriverTurnRequest): Promise<DriverAdmission> {
    const { validated, requiredCapabilities, matchedModel } = assertAdmitEligibility(
      this.manifest,
      req,
    )

    const admissionId = `adm_${randomUUID().replace(/-/g, '')}`
    let operationId = req.operationId ?? randomUUID()
    let laneGeneration = Math.max(1, Math.floor(req.laneGeneration ?? this.laneGeneration))
    const stickyHomeKey =
      req.stickyHomeKey ??
      validated.placementHint?.stickyHomeKey ??
      computeStickyHomeKey(validated.sessionKey)
    const leaseId = req.leaseId ?? this.defaultLeaseId ?? `lease_${stickyHomeKey}`
    const serviceTier: InferenceServiceTier = validated.serviceTier ?? 'standard'
    const placementEpoch = validated.placementHint?.placementEpoch ?? 1
    const canonicalModel = sanitizeModelId(
      this.resolveCanonicalModel?.(validated.logicalModel),
      validated.logicalModel,
    )
    const upstreamModel = sanitizeModelId(
      this.resolveUpstreamModel?.(validated.logicalModel, matchedModel) ??
        matchedModel.upstreamModelId,
      canonicalModel,
    )
    const frozenPlatformPrompt = req.frozenPlatformPrompt ?? validated.systemInstructions

    const initialPayload: RemoteV5TurnDispatchPayload = Object.freeze({
      admissionId,
      operationId,
      laneGeneration,
      turnId: validated.turnId,
      turnKey: validated.turnKey,
      requestId: validated.requestId,
      tenantId: validated.tenantId,
      sessionKey: validated.sessionKey,
      logicalModel: validated.logicalModel,
      canonicalModel,
      upstreamModel,
      serviceTier,
      ...(validated.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: validated.reasoningEffort }),
      input: validated.input,
      stickyHomeKey,
      ...(validated.placementHint?.cacheAffinityKey === undefined
        ? {}
        : { cacheAffinityKey: validated.placementHint.cacheAffinityKey }),
      ...(frozenPlatformPrompt === undefined ? {} : { frozenPlatformPrompt }),
      ...(validated.systemInstructions === undefined
        ? {}
        : { systemInstructions: validated.systemInstructions }),
      ...(validated.toolBridge === undefined ? {} : { toolBridge: validated.toolBridge }),
      readOnly: Boolean(requiredCapabilities.readOnly),
      consultTurn: Boolean(requiredCapabilities.consultTurn),
      hermeticNoTools: Boolean(requiredCapabilities.hermeticNoTools),
      needsSwarm: Boolean(requiredCapabilities.needsSwarm),
      ...(validated.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: validated.nativeSessionId }),
      ...(validated.authorityTurnId === undefined
        ? {}
        : { authorityTurnId: validated.authorityTurnId }),
      placementEpoch,
      ...(req.creditBudgetFen === undefined ? {} : { creditBudgetFen: req.creditBudgetFen }),
    })

    if (this.bridge.admitRemote) {
      const remoteAck = await this.bridge.admitRemote(initialPayload)
      if (remoteAck?.operationId) operationId = remoteAck.operationId
      if (remoteAck?.laneGeneration !== undefined) {
        laneGeneration = Math.max(1, Math.floor(remoteAck.laneGeneration))
      }
    }

    const dispatchPayload: RemoteV5TurnDispatchPayload = Object.freeze({
      ...initialPayload,
      operationId,
      laneGeneration,
    })

    const record: RemoteAdmissionRecord = {
      admissionId,
      operationId,
      laneGeneration,
      leaseId,
      request: validated,
      originalRequest: req,
      requiredCapabilities,
      matchedModel,
      dispatchPayload,
      dispatched: false,
      abandoning: false,
      remoteAbandoned: false,
      abandoned: false,
      settled: false,
      settledOnce: false,
      settledReceipt: null,
      pendingSettlement: null,
      activeExecutionPromise: null,
    }
    const admission: DriverAdmission = Object.freeze({
      admissionId,
      operationId,
      laneGeneration,
    })

    this.admissions.set(admissionId, record)
    this.operationToLease.set(operationId, leaseId)
    try {
      await this.onAdmitJournal?.(req, admission)
    } catch (err) {
      this.admissions.delete(admissionId)
      throw err
    }

    return admission
  }

  async abandon(admissionId: string, reason: string): Promise<AbandonResult> {
    const record = this.admissions.get(admissionId)
    if (!record) {
      throw new InferencePoolDriverError(
        'INFERENCE_ADMISSION_NOT_FOUND',
        `INFERENCE_ADMISSION_NOT_FOUND:${admissionId}`,
      )
    }
    if (record.dispatched) {
      throw new InferencePoolDriverError(
        'INFERENCE_ABANDON_AFTER_DISPATCH_FORBIDDEN',
        'INFERENCE_ABANDON_AFTER_DISPATCH_FORBIDDEN',
      )
    }
    if (record.abandoned) {
      return Object.freeze({ abandoned: true, zeroSettled: true })
    }
    if (record.abandoning) {
      throw new InferencePoolDriverError(
        'INFERENCE_ABANDON_IN_FLIGHT',
        `INFERENCE_ABANDON_IN_FLIGHT:${admissionId}`,
      )
    }

    record.abandoning = true
    try {
      if (this.bridge.abandonRemote && !record.remoteAbandoned) {
        await this.bridge.abandonRemote(admissionId, record.operationId, reason)
        record.remoteAbandoned = true
      }
      await this.onAbandonJournal?.(admissionId, reason)
      // Mark abandoned ONLY after remote abandon AND authoritative abandon journal writes succeed.
      record.abandoned = true
      return Object.freeze({ abandoned: true, zeroSettled: true })
    } finally {
      record.abandoning = false
    }
  }

  dispatch(admissionId: string): AsyncIterable<NormalizedInferenceEvent> {
    const record = this.admissions.get(admissionId)
    if (!record) {
      throw new InferencePoolDriverError(
        'INFERENCE_ADMISSION_NOT_FOUND',
        `INFERENCE_ADMISSION_NOT_FOUND:${admissionId}`,
      )
    }
    if (record.abandoned || record.abandoning) {
      throw new InferencePoolDriverError(
        'INFERENCE_ADMISSION_ABANDONED',
        `INFERENCE_ADMISSION_ABANDONED:${admissionId}`,
      )
    }
    if (record.dispatched) {
      throw new InferencePoolDriverError(
        'INFERENCE_ADMISSION_ALREADY_DISPATCHED',
        `INFERENCE_ADMISSION_ALREADY_DISPATCHED:${admissionId}`,
      )
    }

    // Atomically burn the post-dispatch fence BEFORE returning the consumer async iterable.
    record.dispatched = true

    const consumerQueue: NormalizedInferenceEvent[] = []
    let producerClosed = false
    let consumerDetached = false
    let producerError: unknown = null
    let notifyConsumer: (() => void) | null = null

    const wakeConsumer = () => {
      if (notifyConsumer) {
        const wake = notifyConsumer
        notifyConsumer = null
        wake()
      }
    }

    const pushToConsumer = (ev: NormalizedInferenceEvent) => {
      if (consumerDetached) return
      consumerQueue.push(ev)
      wakeConsumer()
    }

    const closeConsumer = (err?: unknown) => {
      if (err !== undefined && producerError === null) {
        producerError = err
      }
      producerClosed = true
      wakeConsumer()
    }

    // Launch decoupled background execution + exactly-once settlement coroutine.
    const executionPromise = this.executeDispatchedTurnInBackground(
      record,
      pushToConsumer,
      closeConsumer,
    )
    // Prevent unhandled rejection if consumer detaches and nobody awaits waitForSettlement().
    executionPromise.catch(() => {})
    record.activeExecutionPromise = executionPromise

    return (async function* (): AsyncIterable<NormalizedInferenceEvent> {
      try {
        while (!producerClosed || consumerQueue.length > 0) {
          if (consumerQueue.length > 0) {
            yield consumerQueue.shift()!
          } else {
            await new Promise<void>((resolve) => {
              notifyConsumer = resolve
            })
          }
        }
        if (producerError !== null) {
          throw producerError
        }
      } finally {
        consumerDetached = true
        consumerQueue.length = 0
      }
    })()
  }

  private async settlePendingRecord(
    pending: PendingSettlementRecord,
    record?: RemoteAdmissionRecord,
  ): Promise<TurnReceiptV5> {
    if (record?.settledOnce && record.settledReceipt) {
      return record.settledReceipt
    }
    const existingInFlight = this.settlementInFlight.get(pending.admissionId)
    if (existingInFlight) {
      return await existingInFlight
    }
    const attempt = (async () => {
      let alreadySettled = false
      if (this.probeAuthoritativeSettlement) {
        alreadySettled = Boolean(await this.probeAuthoritativeSettlement(pending.billingRequestId))
      }
      if (!alreadySettled && this.onSettleReceipt) {
        await this.onSettleReceipt(pending.receipt, pending.settlement)
      }
      if (record) {
        record.settledOnce = true
        record.settled = true
        record.settledReceipt = pending.receipt
        record.pendingSettlement = null
      }
      this.pendingSettlements.delete(pending.admissionId)
      await this.pendingSettlementOutbox?.delete(pending.admissionId)
      return pending.receipt
    })()
    this.settlementInFlight.set(pending.admissionId, attempt)
    try {
      return await attempt
    } finally {
      if (this.settlementInFlight.get(pending.admissionId) === attempt) {
        this.settlementInFlight.delete(pending.admissionId)
      }
    }
  }

  async retryPendingSettlement(admissionId: string): Promise<TurnReceiptV5 | null> {
    const record = this.admissions.get(admissionId)
    if (record?.settledOnce && record.settledReceipt) {
      return record.settledReceipt
    }
    const pending =
      record?.pendingSettlement ??
      this.pendingSettlements.get(admissionId) ??
      (await this.pendingSettlementOutbox?.get(admissionId)) ??
      null
    if (!pending) return record?.settledReceipt ?? null
    return await this.settlePendingRecord(pending, record)
  }

  async reconcilePendingSettlements(): Promise<readonly TurnReceiptV5[]> {
    const byId = new Map<string, PendingSettlementRecord>()
    for (const [id, rec] of this.pendingSettlements) {
      byId.set(id, rec)
    }
    if (this.pendingSettlementOutbox) {
      const persisted = await this.pendingSettlementOutbox.list()
      for (const rec of persisted) {
        byId.set(rec.admissionId, rec)
      }
    }
    const settled: TurnReceiptV5[] = []
    for (const pending of byId.values()) {
      const record = this.admissions.get(pending.admissionId)
      settled.push(await this.settlePendingRecord(pending, record))
    }
    return settled
  }

  async waitForSettlement(admissionId: string): Promise<TurnReceiptV5 | null> {
    const record = this.admissions.get(admissionId)
    if (!record) {
      return await this.retryPendingSettlement(admissionId)
    }
    if (record.activeExecutionPromise) {
      try {
        return await record.activeExecutionPromise
      } catch (err) {
        if (!record.settled && record.pendingSettlement !== null) {
          return await this.retryPendingSettlement(admissionId)
        }
        throw err
      }
    }
    if (!record.settled && record.pendingSettlement !== null) {
      return await this.retryPendingSettlement(admissionId)
    }
    return record.settledReceipt
  }

  async *executeTurn(request: DriverTurnRequest): AsyncIterable<NormalizedInferenceEvent> {
    const admission = await this.admit(request)
    for await (const event of this.dispatch(admission.admissionId)) {
      yield event
    }
  }

  async submitToolResult(callId: string, result: ToolResultEnvelope): Promise<boolean> {
    if (this.bridge.submitToolResult) {
      return Boolean(await this.bridge.submitToolResult(callId, result))
    }
    return false
  }

  async submitPermissionDecision(permissionId: string, decision: unknown): Promise<boolean> {
    if (this.bridge.submitPermissionDecision) {
      return Boolean(await this.bridge.submitPermissionDecision(permissionId, decision))
    }
    return false
  }

  async interrupt(reason = 'system'): Promise<boolean> {
    const targets = [...this.activeByTurnId.values()]
    if (targets.length === 0) return false
    for (const active of targets) {
      active.interruptedReason ??= reason
      await this.bridge.interrupt(active.operationId, reason)
    }
    return true
  }

  async interruptTurn(turnId: string, reason = 'system'): Promise<void> {
    const active = this.activeByTurnId.get(turnId)
    if (!active) return
    active.interruptedReason ??= reason
    await this.bridge.interrupt(active.operationId, reason)
  }

  async stopLane(operationId: string, reason: string): Promise<StopLaneResult> {
    const leaseId = this.operationToLease.get(operationId) ?? this.defaultLeaseId ?? operationId
    let driverStopped = false
    let toolHostStopped = false
    let reapProof: ExecEnvReapStopProof | undefined

    const remoteRes = await this.bridge.stopRemote(operationId, reason)
    driverStopped = Boolean(remoteRes.remoteStopped)

    if (this.bridge.stopToolHost) {
      const toolHostRes = await this.bridge.stopToolHost(operationId, leaseId, reason)
      toolHostStopped = Boolean(toolHostRes.toolHostStopped)
    }

    if (this.jobRegistry) {
      const classesToReap: readonly JobLifecycleClass[] = ['ephemeral_turn']
      reapProof = await this.jobRegistry.reapByClass(leaseId, classesToReap, {
        reason: mapStopReasonToExecEnvReason(reason),
      })
      toolHostStopped = this.bridge.stopToolHost ? toolHostStopped : true
    }

    if (this.toolBroker) {
      this.toolBroker.markLeaseDisconnected(leaseId, reason)
      if (!this.bridge.stopToolHost) toolHostStopped = true
    }

    if (!this.bridge.stopToolHost && !this.jobRegistry && !this.toolBroker) {
      toolHostStopped = true
    }

    this.laneGeneration += 1
    return Object.freeze({
      driverStopped,
      toolHostStopped,
      ...(reapProof === undefined ? {} : { reapProof }),
    })
  }

  private async executeDispatchedTurnInBackground(
    record: RemoteAdmissionRecord,
    emitConsumerEvent: (ev: NormalizedInferenceEvent) => void,
    closeConsumer: (err?: unknown) => void,
  ): Promise<TurnReceiptV5 | null> {
    const req = record.request
    const payload = record.dispatchPayload
    const serviceTier = payload.serviceTier
    const placementEpoch = payload.placementEpoch

    let seq = 0
    const nowIso = () => new Date(this.clock()).toISOString()
    const evidenceLog: unknown[] = []
    const recordEvidence = (tag: string, data: unknown) => {
      evidenceLog.push({ seq: evidenceLog.length + 1, tag, data })
    }

    const budgetGuard = new CreditBudgetGuard({
      creditBudgetFen: record.originalRequest.creditBudgetFen,
      serviceTier,
      estimateCreditsFen: this.estimateCreditsFen,
    })

    this.activeByTurnId.set(req.turnId, record)

    let dispatchedEmitted = false
    let upstreamModel = payload.upstreamModel
    let canonicalModel = payload.canonicalModel
    let remoteReceiptV4: RemoteReceiptV4 | null = null
    let terminalStatusFromBridge: 'success' | 'error' | 'interrupted' | null = null
    let terminalErrorCode: string | undefined
    let terminalId = `term_${req.turnId}`
    let terminalUsage: NormalizedUsageCounters | undefined
    let bridgeRawEvidenceDigest: string | undefined
    let streamFailure: Error | null = null

    const emitDispatched = (meta?: {
      readonly nativeSessionId?: string
      readonly nativeTurnId?: string
      readonly upstreamModel?: string
    }): NormalizedInferenceEvent => {
      dispatchedEmitted = true
      if (meta?.upstreamModel) {
        upstreamModel = sanitizeModelId(meta.upstreamModel, upstreamModel)
      }
      const nativeSessionId = meta?.nativeSessionId ?? req.nativeSessionId ?? undefined
      const nativeTurnId = meta?.nativeTurnId ?? req.authorityTurnId ?? req.turnId
      recordEvidence('turn_dispatched', {
        nativeSessionId: nativeSessionId ?? null,
        nativeTurnId,
        upstreamModel,
      })
      return {
        kind: 'turn_dispatched',
        turnId: req.turnId,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        nativeTurnId,
        logicalModel: req.logicalModel,
        upstreamModel,
        seq: ++seq,
        ts: nowIso(),
      }
    }

    let backgroundError: unknown = undefined
    try {
      recordEvidence('turn_admitted', {
        admissionId: record.admissionId,
        operationId: record.operationId,
        stickyHomeKey: payload.stickyHomeKey,
        serviceTier,
      })
      emitConsumerEvent({
        kind: 'turn_admitted',
        turnId: req.turnId,
        poolKind: this.poolKind,
        driverId: this.driverId,
        placementEpoch,
        seq: ++seq,
        ts: nowIso(),
      })

      try {
        for await (const ev of this.bridge.dispatchTurn(payload)) {
          const ts = nowIso()

          if (ev.kind === 'dispatched') {
            if (!dispatchedEmitted) {
              emitConsumerEvent(emitDispatched(ev))
            }
            continue
          }

          if (!dispatchedEmitted) {
            emitConsumerEvent(emitDispatched())
          }

          switch (ev.kind) {
            case 'text_delta': {
              recordEvidence('text_delta', { channel: ev.channel, len: ev.delta.length })
              emitConsumerEvent({
                kind: 'text_delta',
                turnId: req.turnId,
                channel: ev.channel,
                delta: ev.delta,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'tool_call_delta': {
              recordEvidence('tool_call_delta', { callId: ev.callId, toolName: ev.toolName })
              emitConsumerEvent({
                kind: 'tool_call_delta',
                turnId: req.turnId,
                callId: ev.callId,
                toolName: ev.toolName,
                argsDelta: ev.argsDelta,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'tool_call_request': {
              const argsSha256 = isSha256Hex(ev.argsSha256)
                ? ev.argsSha256
                : remoteCanonicalSha256(ev.arguments)
              recordEvidence('tool_call_request', {
                callId: ev.callId,
                toolName: ev.toolName,
                argsSha256,
              })
              emitConsumerEvent({
                kind: 'tool_call_request',
                turnId: req.turnId,
                callId: ev.callId,
                toolName: ev.toolName,
                arguments: ev.arguments,
                argsSha256,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'tool_call_observed': {
              recordEvidence('tool_call_observed', {
                callId: ev.callId,
                phase: ev.phase,
              })
              emitConsumerEvent({
                kind: 'tool_call_observed',
                turnId: req.turnId,
                callId: ev.callId,
                toolName: ev.toolName,
                phase: ev.phase,
                argsSha256: ev.argsSha256,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'permission_request': {
              recordEvidence('permission_request', {
                permissionId: ev.permissionId,
                toolName: ev.toolName,
              })
              emitConsumerEvent({
                kind: 'permission_request',
                turnId: req.turnId,
                permissionId: ev.permissionId,
                toolName: ev.toolName,
                reason: ev.reason,
                ...(ev.riskLevel === undefined ? {} : { riskLevel: ev.riskLevel }),
                seq: ++seq,
                ts,
              })
              break
            }
            case 'context_pressure': {
              recordEvidence('context_pressure', {
                usedTokens: ev.usedTokens,
                ratio: ev.ratio,
              })
              emitConsumerEvent({
                kind: 'context_pressure',
                turnId: req.turnId,
                usedTokens: safeNonNegativeInt(ev.usedTokens),
                contextWindow: safeNonNegativeInt(ev.contextWindow),
                ratio: ev.ratio,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'compaction': {
              const reason = ev.reason ?? 'remote_compaction'
              recordEvidence('context_compacted', { reason })
              emitConsumerEvent({
                kind: 'context_compacted',
                turnId: req.turnId,
                reason,
                ...(ev.beforeTokens === undefined
                  ? {}
                  : { beforeTokens: safeNonNegativeInt(ev.beforeTokens) }),
                ...(ev.afterTokens === undefined
                  ? {}
                  : { afterTokens: safeNonNegativeInt(ev.afterTokens) }),
                ...(ev.clearedPromptCache === undefined
                  ? {}
                  : { clearedPromptCache: ev.clearedPromptCache }),
                seq: ++seq,
                ts,
              })
              break
            }
            case 'presentation': {
              const item = ev.item
              if (item.kind === 'compaction') {
                const reason = item.text && item.text.length > 0 ? item.text : 'remote_compaction'
                recordEvidence('context_compacted', { reason })
                emitConsumerEvent({
                  kind: 'context_compacted',
                  turnId: req.turnId,
                  reason,
                  seq: ++seq,
                  ts,
                })
              } else if (item.kind === 'text_delta' && typeof item.text === 'string') {
                recordEvidence('text_delta', { channel: 'answer', len: item.text.length })
                emitConsumerEvent({
                  kind: 'text_delta',
                  turnId: req.turnId,
                  channel: 'answer',
                  delta: item.text,
                  seq: ++seq,
                  ts,
                })
              } else if (item.kind === 'thinking_delta' && typeof item.text === 'string') {
                recordEvidence('text_delta', { channel: 'reasoning', len: item.text.length })
                emitConsumerEvent({
                  kind: 'text_delta',
                  turnId: req.turnId,
                  channel: 'reasoning',
                  delta: item.text,
                  seq: ++seq,
                  ts,
                })
              } else if (item.kind === 'status') {
                emitConsumerEvent({
                  kind: 'turn_status',
                  turnId: req.turnId,
                  phase: item.code ?? 'status',
                  ...(item.text === undefined ? {} : { message: item.text }),
                  seq: ++seq,
                  ts,
                })
              } else if (item.kind === 'error') {
                terminalErrorCode = item.code ?? 'remote_error'
                recordEvidence('presentation_error', { code: terminalErrorCode })
              }
              break
            }
            case 'call_usage': {
              const normalized = normalizeRemoteUsageInput({
                usage: ev.usage,
                rawCounters: ev.rawCounters,
                countersBaseline: ev.countersBaseline,
                usagePolicy: ev.usagePolicy,
                fallbackPolicy: this.usagePolicy,
              })
              recordEvidence('call_usage', { sampleId: ev.sampleId, usage: normalized })
              emitConsumerEvent({
                kind: 'call_usage',
                turnId: req.turnId,
                sampleId: ev.sampleId,
                scopeId: ev.scopeId,
                usage: normalized,
                seq: ++seq,
                ts,
              })
              const guardResult = budgetGuard.recordSample(ev.sampleId, normalized)
              if (guardResult.justTriggered) {
                recordEvidence('credit_budget_exceeded', {
                  cumulativeCreditsFen: guardResult.cumulativeCreditsFen.toString(),
                  budgetFen: record.originalRequest.creditBudgetFen?.toString() ?? null,
                })
                await this.bridge.interrupt(record.operationId, 'budget_exceeded')
              }
              break
            }
            case 'turn_status': {
              emitConsumerEvent({
                kind: 'turn_status',
                turnId: req.turnId,
                phase: ev.phase,
                ...(ev.message === undefined ? {} : { message: ev.message }),
                seq: ++seq,
                ts,
              })
              break
            }
            case 'disallowed_item': {
              recordEvidence('disallowed_item', { itemType: ev.itemType, reason: ev.reason })
              emitConsumerEvent({
                kind: 'disallowed_item',
                turnId: req.turnId,
                itemType: ev.itemType,
                reason: ev.reason,
                seq: ++seq,
                ts,
              })
              break
            }
            case 'remote_receipt_v4': {
              remoteReceiptV4 = ev.receipt
              canonicalModel = sanitizeModelId(ev.receipt.canonicalModel, canonicalModel)
              upstreamModel = sanitizeModelId(ev.receipt.upstreamModel, upstreamModel)
              terminalId = ev.receipt.terminalId || terminalId
              bridgeRawEvidenceDigest = ev.receipt.rawEvidenceDigest
              recordEvidence('remote_receipt_v4', {
                receiptDigest: ev.receipt.receiptDigest,
                semanticDigest: ev.receipt.semanticDigest,
              })
              break
            }
            case 'terminal': {
              terminalStatusFromBridge = ev.status
              if (ev.errorCode !== undefined) terminalErrorCode = ev.errorCode
              if (ev.terminalId !== undefined) terminalId = ev.terminalId
              if (ev.rawEvidenceDigest !== undefined) {
                bridgeRawEvidenceDigest = ev.rawEvidenceDigest
              }
              if (ev.usage || ev.rawCounters) {
                terminalUsage = normalizeRemoteUsageInput({
                  usage: ev.usage,
                  rawCounters: ev.rawCounters,
                  countersBaseline: ev.countersBaseline,
                  usagePolicy: ev.usagePolicy,
                  fallbackPolicy: this.usagePolicy,
                })
              }
              recordEvidence('terminal', {
                status: ev.status,
                errorCode: ev.errorCode ?? null,
              })
              break
            }
          }
        }
      } catch (err) {
        streamFailure = err instanceof Error ? err : new Error(String(err))
        recordEvidence('stream_failure', streamFailure.message)
      }

      if (!dispatchedEmitted) {
        emitConsumerEvent(emitDispatched())
      }

      const v4Usage: NormalizedUsageCounters = remoteReceiptV4
        ? Object.freeze({
            inputTokens: safeNonNegativeInt(remoteReceiptV4.usage.inputTokens),
            outputTokens: safeNonNegativeInt(remoteReceiptV4.usage.outputTokens),
            cacheReadTokens: safeNonNegativeInt(remoteReceiptV4.usage.cacheReadTokens),
            cacheWriteTokens: safeNonNegativeInt(remoteReceiptV4.usage.cacheWriteTokens),
          })
        : Object.freeze({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          })

      const mergedRemoteUsage = terminalUsage
        ? mergeUsageCountersMax(v4Usage, terminalUsage)
        : v4Usage
      const finalUsage = mergeUsageCountersMax(budgetGuard.cumulativeUsage, mergedRemoteUsage)

      let receiptStatus: 'success' | 'error' | 'interrupted'
      let errorCode: string | undefined
      let terminalStatus: DriverTerminalStatus

      if (budgetGuard.budgetExceeded) {
        receiptStatus = 'interrupted'
        errorCode = 'budget_exceeded'
        terminalStatus = 'budget_exceeded'
      } else if (record.interruptedReason !== undefined) {
        receiptStatus = 'interrupted'
        errorCode = sanitizeIdentifier(record.interruptedReason, 'interrupted')
        terminalStatus = 'interrupted'
      } else if (streamFailure !== null) {
        receiptStatus = 'error'
        errorCode = sanitizeIdentifier(terminalErrorCode ?? streamFailure.message, 'remote_error')
        terminalStatus = 'error'
      } else if (terminalStatusFromBridge !== null) {
        receiptStatus = terminalStatusFromBridge
        if (receiptStatus !== 'success') {
          errorCode = sanitizeIdentifier(
            terminalErrorCode ?? (receiptStatus === 'interrupted' ? 'interrupted' : 'remote_error'),
            'remote_error',
          )
        }
        terminalStatus = receiptStatus
      } else if (remoteReceiptV4 !== null) {
        receiptStatus = remoteReceiptV4.nativeStatus
        if (receiptStatus !== 'success') {
          errorCode = sanitizeIdentifier(
            terminalErrorCode ?? (receiptStatus === 'interrupted' ? 'interrupted' : 'remote_error'),
            'remote_error',
          )
        }
        terminalStatus = receiptStatus
      } else {
        receiptStatus = 'error'
        errorCode = sanitizeIdentifier(
          terminalErrorCode ?? 'remote_stream_incomplete',
          'remote_error',
        )
        terminalStatus = 'error'
      }

      const rawEvidenceDigest = isSha256Hex(bridgeRawEvidenceDigest)
        ? bridgeRawEvidenceDigest
        : remoteCanonicalSha256({
            domain: 'oc-raw-evidence-v5',
            poolKind: this.poolKind,
            driverId: this.driverId,
            turnId: req.turnId,
            requestId: req.requestId,
            evidenceLog,
          })

      const receipt = buildValidatedTurnReceiptV5({
        poolKind: this.poolKind,
        engineFamily: this.engineFamily,
        driverId: this.driverId,
        driverVersion: this.driverVersion,
        req,
        canonicalModel,
        upstreamModel,
        serviceTier,
        placementEpoch,
        usageSemantics: remoteReceiptV4?.usageSemantics ?? this.usageSemantics,
        usage: finalUsage,
        status: receiptStatus,
        errorCode,
        rawEvidenceDigest,
        finalizedAt: nowIso(),
      })

      if (!record.settledOnce) {
        const pending: PendingSettlementRecord = Object.freeze({
          admissionId: record.admissionId,
          turnId: req.turnId,
          billingRequestId: req.requestId,
          receipt,
          settlement: Object.freeze({
            admissionId: record.admissionId,
            operationId: record.operationId,
            terminalStatus,
            cumulativeCreditsFen: budgetGuard.cumulativeCreditsFen,
            budgetExceeded: budgetGuard.budgetExceeded,
          }),
        })
        record.pendingSettlement = pending
        this.pendingSettlements.set(record.admissionId, pending)
        await this.pendingSettlementOutbox?.put(pending)
        await this.settlePendingRecord(pending, record)
      }

      emitConsumerEvent({
        kind: 'billing_receipt',
        turnId: req.turnId,
        receipt,
        seq: ++seq,
        ts: nowIso(),
      })

      emitConsumerEvent({
        kind: 'turn_terminal',
        turnId: req.turnId,
        terminalId,
        status: receipt.status,
        ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
        seq: ++seq,
        ts: nowIso(),
      })

      return receipt
    } catch (err) {
      backgroundError = err
      throw err
    } finally {
      this.activeByTurnId.delete(req.turnId)
      closeConsumer(backgroundError)
    }
  }
}
