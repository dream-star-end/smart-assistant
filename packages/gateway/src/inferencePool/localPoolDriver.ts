/**
 * OCV5-890 Wave 2 — Layer 2 LocalPoolDriver (`InferencePoolDriver`).
 *
 * Wraps any local `EngineAdapter` behind the unified v5 three-phase transaction
 * state machine (`admit` -> `abandon` | `dispatch`), mid-turn `CreditBudgetGuard`,
 * monotonic local `ToolBrokerServer` policy tightening, authoritative `TurnReceiptV5`
 * self-validation, and dual-proof `stopLane` that reaps ONLY `ephemeral_turn` jobs.
 *
 * Architecture invariants:
 * - Zero `node:sqlite` imports (Node 20.20.2 compatible).
 * - Zero `process.env`, network APIs, forbidden crypto primitives, or engine-name special cases.
 * - Value imports restricted to L0 `@openclaude/protocol` and same-module L3 `gateway-runtime`.
 */
import { randomUUID } from 'node:crypto'
import {
  type ExecutionPolicyEnvelope,
  type JobLifecycleClass,
  type ModelAuthorityEngine,
  type ToolResultEnvelope,
  computeStickyHomeKey,
  isReadOnlyAllowedCanonicalTool,
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
  type TurnReceiptV5Body,
  type UnifiedTurnInputBlock,
  type UnifiedTurnRequest,
  checkCapabilitySuperset,
  computeEffectiveModelCapabilities,
  computeTurnReceiptV5Digests,
  validateDriverCapabilityManifest,
  validateTurnReceiptV5,
  validateUnifiedTurnRequest,
} from '@openclaude/protocol/inference-pool'
import type { EngineAdapter, EngineSessionTotals, TurnParams } from '../engine/engineAdapter.js'
import type { EngineEvent, TurnSummary } from '../engine/engineEvents.js'
import type {
  ExecEnvJobRegistry,
  ExecEnvReapStopProof,
  ToolBrokerServer,
} from '../execEnv/index.js'

const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SHA256_RE = /^[a-f0-9]{64}$/

const DRIVER_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  'requiredCapabilities',
  'retryContext',
  'creditBudgetFen',
  'frozenPlatformPrompt',
  'stickyHomeKey',
  'leaseId',
  'operationId',
  'laneGeneration',
  'consultTurnConfig',
])

const SERVICE_TIER_MULTIPLIER_BPS: Readonly<Record<InferenceServiceTier, bigint>> = Object.freeze({
  standard: 100n,
  fast: 150n,
  ultrafast: 200n,
})

export const DEFAULT_UNIFIED_USAGE_SEMANTICS = 'unified_pool_v5'

export class InferencePoolDriverError extends Error {
  readonly code: string
  readonly details?: readonly string[]

  constructor(code: string, message?: string, details?: readonly string[]) {
    super(message ?? code)
    this.name = 'InferencePoolDriverError'
    this.code = code
    if (details !== undefined) {
      this.details = Object.freeze([...details])
    }
  }
}

export interface DriverTurnRetryContext {
  readonly priorDispatched?: boolean
  readonly attempt?: number
  readonly reason?: string
}

export interface DriverTurnRequest extends UnifiedTurnRequest {
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly retryContext?: DriverTurnRetryContext
  readonly creditBudgetFen?: bigint
  readonly frozenPlatformPrompt?: string
  readonly stickyHomeKey?: string
  readonly leaseId?: string
  readonly operationId?: string
  readonly laneGeneration?: number
  readonly consultTurnConfig?: {
    readonly configVersion: string
    readonly turnIndex: number
  }
}

export interface DriverAdmission {
  readonly admissionId: string
  readonly operationId: string
  readonly laneGeneration: number
}

export interface AbandonResult {
  readonly abandoned: true
  readonly zeroSettled: true
}

export interface StopLaneResult {
  readonly driverStopped: boolean
  readonly toolHostStopped: boolean
  readonly reapProof?: ExecEnvReapStopProof
}

export type DriverTerminalStatus = 'success' | 'error' | 'interrupted' | 'budget_exceeded'

export interface TurnSettlementInfo {
  readonly admissionId: string
  readonly operationId: string
  readonly terminalStatus: DriverTerminalStatus
  readonly cumulativeCreditsFen: bigint
  readonly budgetExceeded: boolean
}

export type CreditEstimatorFn = (
  usage: NormalizedUsageCounters,
  serviceTier: InferenceServiceTier,
) => bigint

export interface DriverModelCapabilityTriplet {
  readonly probed: LogicalModelCapability
  readonly transport: LogicalModelCapability
  readonly catalog: LogicalModelCapability
}

export interface BuildDriverCapabilityManifestOptions {
  readonly poolKind?: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly authorityEngine: ModelAuthorityEngine
  readonly driverId: string
  readonly driverVersion: string
  readonly observedAt?: string
  readonly models: readonly DriverModelCapabilityTriplet[]
}

export interface PendingSettlementRecord {
  readonly admissionId: string
  readonly turnId: string
  readonly billingRequestId: string
  readonly receipt: TurnReceiptV5
  readonly settlement: TurnSettlementInfo
}

export interface PendingSettlementOutbox {
  put(record: PendingSettlementRecord): Promise<void> | void
  get(admissionId: string): Promise<PendingSettlementRecord | null> | PendingSettlementRecord | null
  delete(admissionId: string): Promise<void> | void
  list(): Promise<readonly PendingSettlementRecord[]> | readonly PendingSettlementRecord[]
}

export interface LocalPoolDriverOptions {
  readonly adapter: EngineAdapter
  readonly manifest: DriverCapabilityManifest
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
  readonly onSubmitToolResult?: (
    callId: string,
    result: ToolResultEnvelope,
  ) => Promise<boolean> | boolean
  readonly onStopToolHost?: (
    operationId: string,
    leaseId: string,
    reason: string,
  ) => Promise<boolean> | boolean
  readonly clock?: () => number
  readonly initialLaneGeneration?: number
  readonly sessionTotals?: EngineSessionTotals
  readonly toolUseIdToName?: Map<string, string>
}

export function defaultEstimateCreditsFen(
  usage: NormalizedUsageCounters,
  serviceTier: InferenceServiceTier,
): bigint {
  const mult = SERVICE_TIER_MULTIPLIER_BPS[serviceTier]
  const weightedTokens =
    BigInt(usage.inputTokens) +
    BigInt(usage.outputTokens) * 4n +
    BigInt(usage.cacheWriteTokens) +
    BigInt(usage.cacheReadTokens) / 10n +
    BigInt(usage.reasoningTokens ?? 0) * 4n
  if (weightedTokens <= 0n) return 0n
  const raw = (weightedTokens * mult + 999n) / 1000n
  return raw > 0n ? raw : 1n
}

export function safeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

export function sanitizeIdentifier(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_')
    if (cleaned.length > 0 && IDENT_RE.test(cleaned)) {
      return cleaned.slice(0, 128)
    }
  }
  return fallback
}

export function sanitizeModelId(raw: string | undefined, fallback: string): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (MODEL_ID_RE.test(trimmed)) return trimmed
  }
  return fallback
}

export function isSha256Hex(raw: unknown): raw is string {
  return typeof raw === 'string' && SHA256_RE.test(raw)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function hasVisionInputBlocks(input: readonly UnifiedTurnInputBlock[]): boolean {
  for (const block of input) {
    if (block.type === 'image_ref') return true
    if (block.type === 'blob_ref' && block.mimeType.startsWith('image/')) return true
  }
  return false
}

export function extractCoreUnifiedTurnRequest(req: DriverTurnRequest): Record<string, unknown> {
  const core: Record<string, unknown> = {}
  const raw = req as unknown as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (DRIVER_EXTENSION_KEYS.has(key)) continue
    if (raw[key] !== undefined) {
      core[key] = raw[key]
    }
  }
  return core
}

export function deriveRequiredCapabilities(
  validated: UnifiedTurnRequest,
  explicit?: RequiredTurnCapabilities,
): RequiredTurnCapabilities {
  const needsVision = Boolean(explicit?.needsVision) || hasVisionInputBlocks(validated.input)
  const reasoningEffort: PlatformReasoningEffort | undefined =
    explicit?.reasoningEffort ?? validated.reasoningEffort
  const serviceTier: InferenceServiceTier | undefined =
    explicit?.serviceTier ?? validated.serviceTier
  const readOnly = Boolean(explicit?.readOnly) || Boolean(validated.readOnly)
  const consultTurn = Boolean(explicit?.consultTurn) || Boolean(validated.consultTurn)
  const hermeticNoTools = Boolean(explicit?.hermeticNoTools) || Boolean(validated.hermeticNoTools)
  const needsSwarm = Boolean(explicit?.needsSwarm) || Boolean(validated.needsSwarm)

  return Object.freeze({
    ...(needsVision ? { needsVision: true } : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(readOnly ? { readOnly: true } : {}),
    ...(consultTurn ? { consultTurn: true } : {}),
    ...(hermeticNoTools ? { hermeticNoTools: true } : {}),
    ...(needsSwarm ? { needsSwarm: true } : {}),
  })
}

export function assertAdmitEligibility(
  manifest: DriverCapabilityManifest,
  req: DriverTurnRequest,
): {
  readonly validated: UnifiedTurnRequest
  readonly requiredCapabilities: RequiredTurnCapabilities
  readonly matchedModel: LogicalModelCapability
} {
  if (req.retryContext?.priorDispatched === true) {
    throw new InferencePoolDriverError(
      'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN',
      'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN',
    )
  }

  const validated = validateUnifiedTurnRequest(extractCoreUnifiedTurnRequest(req))
  const requiredCapabilities = deriveRequiredCapabilities(validated, req.requiredCapabilities)
  const check = checkCapabilitySuperset(manifest, validated.logicalModel, requiredCapabilities)
  if (!check.satisfied || !check.matchedModel) {
    const reasons = check.unsatisfiedReasons.join(',')
    throw new InferencePoolDriverError(
      'CAPABILITY_UNSATISFIED',
      `CAPABILITY_UNSATISFIED:${reasons}`,
      check.unsatisfiedReasons,
    )
  }

  return {
    validated,
    requiredCapabilities,
    matchedModel: check.matchedModel,
  }
}

export function mergeUsageCountersMax(
  a: NormalizedUsageCounters,
  b: NormalizedUsageCounters,
): NormalizedUsageCounters {
  const reasoning =
    a.reasoningTokens === undefined && b.reasoningTokens === undefined
      ? undefined
      : Math.max(a.reasoningTokens ?? 0, b.reasoningTokens ?? 0)
  return Object.freeze({
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  })
}

export function buildValidatedTurnReceiptV5(params: {
  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly driverId: string
  readonly driverVersion: string
  readonly req: UnifiedTurnRequest
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly serviceTier: InferenceServiceTier
  readonly placementEpoch: number
  readonly usageSemantics: string
  readonly usage: NormalizedUsageCounters
  readonly status: 'success' | 'error' | 'interrupted'
  readonly errorCode?: string
  readonly rawEvidenceDigest: string
  readonly finalizedAt: string
}): TurnReceiptV5 {
  const normalizedUsage: NormalizedUsageCounters = Object.freeze({
    inputTokens: safeNonNegativeInt(params.usage.inputTokens),
    outputTokens: safeNonNegativeInt(params.usage.outputTokens),
    cacheReadTokens: safeNonNegativeInt(params.usage.cacheReadTokens),
    cacheWriteTokens: safeNonNegativeInt(params.usage.cacheWriteTokens),
    ...(params.usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: safeNonNegativeInt(params.usage.reasoningTokens) }),
  })

  const body: TurnReceiptV5Body = {
    version: 5,
    poolKind: params.poolKind,
    engineFamily: params.engineFamily,
    driverId: params.driverId,
    driverVersion: params.driverVersion,
    tenantId: params.req.tenantId,
    sessionKey: params.req.sessionKey,
    turnId: params.req.turnId,
    turnKey: params.req.turnKey,
    requestId: params.req.requestId,
    logicalModel: params.req.logicalModel,
    canonicalModel: sanitizeModelId(params.canonicalModel, params.req.logicalModel),
    upstreamModel: sanitizeModelId(params.upstreamModel, params.req.logicalModel),
    serviceTier: params.serviceTier,
    placementEpoch: Math.max(1, Math.floor(params.placementEpoch)),
    usageSemantics: sanitizeIdentifier(params.usageSemantics, DEFAULT_UNIFIED_USAGE_SEMANTICS),
    usage: normalizedUsage,
    status: params.status,
    ...(params.errorCode === undefined
      ? {}
      : { errorCode: sanitizeIdentifier(params.errorCode, 'engine_error') }),
    rawEvidenceDigest: isSha256Hex(params.rawEvidenceDigest)
      ? params.rawEvidenceDigest
      : remoteCanonicalSha256({
          domain: 'oc-raw-evidence-v5-fallback',
          turnId: params.req.turnId,
          requestId: params.req.requestId,
        }),
    finalizedAt: params.finalizedAt,
  }

  const digests = computeTurnReceiptV5Digests(body)
  return validateTurnReceiptV5({
    ...body,
    semanticDigest: digests.semanticDigest,
    receiptDigest: digests.receiptDigest,
  })
}

export function mapStopReasonToExecEnvReason(
  reason: string,
): 'completed' | 'revoked' | 'timeout' | 'host_evicted' | 'error' {
  const lower = reason.toLowerCase()
  if (lower.includes('timeout')) return 'timeout'
  if (lower.includes('evict')) return 'host_evicted'
  if (lower.includes('revok') || lower.includes('cancel') || lower.includes('abort'))
    return 'revoked'
  if (lower.includes('err') || lower.includes('fail')) return 'error'
  return 'completed'
}

/**
 * Unified mid-turn credit budget guard shared identically by LocalPoolDriver and RemotePoolV5Driver.
 * Deduplicates by `sampleId`, accumulates normalized token counters and credits, and fires the
 * budget-exceeded fuse immediately upon reaching `creditBudgetFen`.
 */
export class CreditBudgetGuard {
  readonly creditBudgetFen: bigint | undefined
  readonly serviceTier: InferenceServiceTier
  private readonly estimateCreditsFen: CreditEstimatorFn
  private readonly seenSamples = new Set<string>()

  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheWriteTokens = 0
  private reasoningTokens: number | undefined = undefined
  private creditsFen = 0n
  private exceeded = false

  constructor(opts: {
    readonly creditBudgetFen?: bigint
    readonly serviceTier: InferenceServiceTier
    readonly estimateCreditsFen?: CreditEstimatorFn
  }) {
    this.creditBudgetFen = opts.creditBudgetFen
    this.serviceTier = opts.serviceTier
    this.estimateCreditsFen = opts.estimateCreditsFen ?? defaultEstimateCreditsFen
  }

  get cumulativeCreditsFen(): bigint {
    return this.creditsFen
  }

  get budgetExceeded(): boolean {
    return this.exceeded
  }

  get sampleCount(): number {
    return this.seenSamples.size
  }

  get cumulativeUsage(): NormalizedUsageCounters {
    return Object.freeze({
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      ...(this.reasoningTokens === undefined ? {} : { reasoningTokens: this.reasoningTokens }),
    })
  }

  recordSample(
    sampleId: string,
    usage: NormalizedUsageCounters,
  ): {
    readonly duplicate: boolean
    readonly justTriggered: boolean
    readonly cumulativeCreditsFen: bigint
  } {
    if (this.seenSamples.has(sampleId)) {
      return {
        duplicate: true,
        justTriggered: false,
        cumulativeCreditsFen: this.creditsFen,
      }
    }
    this.seenSamples.add(sampleId)

    const normalized: NormalizedUsageCounters = {
      inputTokens: safeNonNegativeInt(usage.inputTokens),
      outputTokens: safeNonNegativeInt(usage.outputTokens),
      cacheReadTokens: safeNonNegativeInt(usage.cacheReadTokens),
      cacheWriteTokens: safeNonNegativeInt(usage.cacheWriteTokens),
      ...(usage.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: safeNonNegativeInt(usage.reasoningTokens) }),
    }

    this.inputTokens += normalized.inputTokens
    this.outputTokens += normalized.outputTokens
    this.cacheReadTokens += normalized.cacheReadTokens
    this.cacheWriteTokens += normalized.cacheWriteTokens
    if (normalized.reasoningTokens !== undefined) {
      this.reasoningTokens = (this.reasoningTokens ?? 0) + normalized.reasoningTokens
    }

    const delta = this.estimateCreditsFen(normalized, this.serviceTier)
    if (delta > 0n) {
      this.creditsFen += delta
    }

    let justTriggered = false
    if (
      this.creditBudgetFen !== undefined &&
      !this.exceeded &&
      this.creditsFen >= this.creditBudgetFen
    ) {
      this.exceeded = true
      justTriggered = true
    }

    return {
      duplicate: false,
      justTriggered,
      cumulativeCreditsFen: this.creditsFen,
    }
  }
}

/**
 * Strictly intersects `(probed, transport, catalog)` capability declarations for each model
 * using `@openclaude/protocol/inference-pool` `computeEffectiveModelCapabilities` and validates
 * the resulting `DriverCapabilityManifest`. Zero silent downgrade.
 */
export function buildLocalDriverCapabilityManifest(
  opts: BuildDriverCapabilityManifestOptions,
): DriverCapabilityManifest {
  const models: LogicalModelCapability[] = opts.models.map((entry) =>
    computeEffectiveModelCapabilities(entry.probed, entry.transport, entry.catalog),
  )
  return validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: opts.poolKind ?? 'local_pool',
    engineFamily: opts.engineFamily,
    authorityEngine: opts.authorityEngine,
    driverId: opts.driverId,
    driverVersion: opts.driverVersion,
    observedAt: opts.observedAt ?? new Date().toISOString(),
    models,
  })
}

interface LocalAdmissionRecord {
  readonly admissionId: string
  readonly operationId: string
  readonly laneGeneration: number
  readonly leaseId: string
  readonly request: UnifiedTurnRequest
  readonly originalRequest: DriverTurnRequest
  readonly requiredCapabilities: RequiredTurnCapabilities
  readonly matchedModel: LogicalModelCapability
  dispatched: boolean
  abandoning: boolean
  abandoned: boolean
  settled: boolean
  settledOnce: boolean
  settledReceipt: TurnReceiptV5 | null
  pendingSettlement: PendingSettlementRecord | null
  activeExecutionPromise: Promise<TurnReceiptV5 | null> | null
  interruptedReason?: string
}

function tightenToolBrokerPolicy(
  broker: ToolBrokerServer,
  leaseId: string,
  required: RequiredTurnCapabilities,
): void {
  if (!required.hermeticNoTools && !required.readOnly) return

  const existing = broker.getPolicy(leaseId)
  if (required.hermeticNoTools || existing?.mode === 'hermetic_no_tools') {
    const hermetic: ExecutionPolicyEnvelope = {
      schemaVersion: 1,
      mode: 'hermetic_no_tools',
      allowedTools: [],
      ...(existing?.deniedTools ? { deniedTools: [...existing.deniedTools] } : {}),
      allowNetworkEgress: false,
      allowWorkspaceWrite: false,
      allowSubprocessSpawn: false,
      maxToolCallsPerTurn: 0,
    }
    broker.setPolicy(leaseId, hermetic)
    return
  }

  let allowedTools: string[] = []
  if (existing) {
    if (existing.allowedTools.length > 0) {
      allowedTools = existing.allowedTools.filter((name) => isReadOnlyAllowedCanonicalTool(name))
    } else {
      allowedTools = []
    }
  } else {
    allowedTools = broker
      .listCatalog()
      .map((entry) => entry.canonicalName)
      .filter((name) => isReadOnlyAllowedCanonicalTool(name))
  }

  const readOnlyPolicy: ExecutionPolicyEnvelope = {
    schemaVersion: 1,
    mode: 'read_only',
    allowedTools,
    ...(existing?.deniedTools ? { deniedTools: [...existing.deniedTools] } : {}),
    allowNetworkEgress: existing ? existing.allowNetworkEgress : false,
    allowWorkspaceWrite: false,
    allowSubprocessSpawn: false,
    ...(existing?.maxToolCallsPerTurn === undefined
      ? {}
      : { maxToolCallsPerTurn: existing.maxToolCallsPerTurn }),
  }
  broker.setPolicy(leaseId, readOnlyPolicy)
}

function toLocalTurnInput(
  blocks: readonly UnifiedTurnInputBlock[],
): string | Array<{ type: string; [k: string]: unknown }> {
  const allText = blocks.every((b) => b.type === 'text')
  if (allText) {
    return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  }
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'blob_ref') {
      return {
        type: 'blob_ref',
        blobId: block.blobId,
        sha256: block.sha256,
        mimeType: block.mimeType,
        ...(block.logicalName === undefined ? {} : { logicalName: block.logicalName }),
      }
    }
    return {
      type: 'image_ref',
      ...(block.blobId === undefined ? {} : { blobId: block.blobId }),
      ...(block.uri === undefined ? {} : { uri: block.uri }),
      ...(block.sha256 === undefined ? {} : { sha256: block.sha256 }),
      mimeType: block.mimeType,
      ...(block.altText === undefined ? {} : { altText: block.altText }),
    }
  })
}

export class LocalPoolDriver implements InferencePoolDriver {
  static readonly buildLocalDriverCapabilityManifest = buildLocalDriverCapabilityManifest

  readonly poolKind: InferencePoolKind
  readonly engineFamily: InferenceEngineFamily
  readonly driverId: string
  readonly driverVersion: string

  private readonly adapter: EngineAdapter
  private readonly manifest: DriverCapabilityManifest
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
  private readonly onAdmitJournal?: LocalPoolDriverOptions['onAdmitJournal']
  private readonly onAbandonJournal?: LocalPoolDriverOptions['onAbandonJournal']
  private readonly onSettleReceipt?: LocalPoolDriverOptions['onSettleReceipt']
  private readonly pendingSettlementOutbox?: PendingSettlementOutbox
  private readonly probeAuthoritativeSettlement?: (
    billingRequestId: string,
  ) => Promise<boolean> | boolean
  private readonly onSubmitToolResult?: LocalPoolDriverOptions['onSubmitToolResult']
  private readonly onStopToolHost?: LocalPoolDriverOptions['onStopToolHost']
  private readonly clock: () => number
  private readonly sessionTotals: EngineSessionTotals
  private readonly toolUseIdToName: Map<string, string>

  private laneGeneration: number
  private readonly admissions = new Map<string, LocalAdmissionRecord>()
  private readonly activeByTurnId = new Map<string, LocalAdmissionRecord>()
  private readonly operationToLease = new Map<string, string>()
  private readonly pendingSettlements = new Map<string, PendingSettlementRecord>()
  private readonly settlementInFlight = new Map<string, Promise<TurnReceiptV5>>()

  constructor(opts: LocalPoolDriverOptions) {
    this.manifest = validateDriverCapabilityManifest(opts.manifest)
    this.adapter = opts.adapter
    this.poolKind = this.manifest.poolKind
    this.engineFamily = this.manifest.engineFamily
    this.driverId = this.manifest.driverId
    this.driverVersion = this.manifest.driverVersion
    this.toolBroker = opts.toolBroker
    this.jobRegistry = opts.jobRegistry
    this.defaultLeaseId = opts.defaultLeaseId
    this.estimateCreditsFen = opts.estimateCreditsFen
    this.usageSemantics = sanitizeIdentifier(opts.usageSemantics, DEFAULT_UNIFIED_USAGE_SEMANTICS)
    this.resolveCanonicalModel = opts.resolveCanonicalModel
    this.resolveUpstreamModel = opts.resolveUpstreamModel
    this.onAdmitJournal = opts.onAdmitJournal
    this.onAbandonJournal = opts.onAbandonJournal
    this.onSettleReceipt = opts.onSettleReceipt
    this.pendingSettlementOutbox = opts.pendingSettlementOutbox
    this.probeAuthoritativeSettlement = opts.probeAuthoritativeSettlement
    this.onSubmitToolResult = opts.onSubmitToolResult
    this.onStopToolHost = opts.onStopToolHost
    this.clock = opts.clock ?? (() => Date.now())
    this.laneGeneration = Math.max(1, Math.floor(opts.initialLaneGeneration ?? 1))
    this.sessionTotals = opts.sessionTotals ?? { totalCostUSD: 0, turns: 0 }
    this.toolUseIdToName = opts.toolUseIdToName ?? new Map<string, string>()
  }

  async probeCapabilities(): Promise<DriverCapabilityManifest> {
    return this.manifest
  }

  async admit(req: DriverTurnRequest): Promise<DriverAdmission> {
    const { validated, requiredCapabilities, matchedModel } = assertAdmitEligibility(
      this.manifest,
      req,
    )

    const admissionId = `adm_${randomUUID().replace(/-/g, '')}`
    const operationId = req.operationId ?? randomUUID()
    const laneGeneration = Math.max(1, Math.floor(req.laneGeneration ?? this.laneGeneration))
    const leaseId =
      req.leaseId ?? this.defaultLeaseId ?? `lease_${computeStickyHomeKey(validated.sessionKey)}`

    const record: LocalAdmissionRecord = {
      admissionId,
      operationId,
      laneGeneration,
      leaseId,
      request: validated,
      originalRequest: req,
      requiredCapabilities,
      matchedModel,
      dispatched: false,
      abandoning: false,
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
      await this.onAbandonJournal?.(admissionId, reason)
      // Mark abandoned ONLY after the authoritative abandon journal write succeeds.
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
    record?: LocalAdmissionRecord,
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
    if (this.onSubmitToolResult) {
      return Boolean(await this.onSubmitToolResult(callId, result))
    }
    return false
  }

  async submitPermissionDecision(permissionId: string, decision: unknown): Promise<boolean> {
    return this.adapter.sendPermissionResponse(permissionId, decision)
  }

  async interrupt(reason: 'user' | 'system' | string = 'system'): Promise<boolean> {
    for (const active of this.activeByTurnId.values()) {
      active.interruptedReason ??= reason
    }
    return this.adapter.interrupt(reason === 'user' ? 'user' : 'system')
  }

  async interruptTurn(turnId: string, reason = 'system'): Promise<void> {
    const active = this.activeByTurnId.get(turnId)
    if (active) {
      active.interruptedReason ??= reason
    }
    this.adapter.interrupt(reason === 'user' ? 'user' : 'system')
  }

  async stopLane(operationId: string, reason: string): Promise<StopLaneResult> {
    const leaseId = this.operationToLease.get(operationId) ?? this.defaultLeaseId ?? operationId
    let driverStopped = false
    let toolHostStopped = false
    let reapProof: ExecEnvReapStopProof | undefined

    await this.adapter.shutdown()
    if (typeof this.adapter.waitForOutputDrain === 'function') {
      await this.adapter.waitForOutputDrain()
    }
    driverStopped = true

    if (this.jobRegistry) {
      const classesToReap: readonly JobLifecycleClass[] = ['ephemeral_turn']
      reapProof = await this.jobRegistry.reapByClass(leaseId, classesToReap, {
        reason: mapStopReasonToExecEnvReason(reason),
      })
      toolHostStopped = true
    }

    if (this.toolBroker) {
      this.toolBroker.markLeaseDisconnected(leaseId, reason)
      toolHostStopped = true
    }

    if (this.onStopToolHost) {
      toolHostStopped = Boolean(await this.onStopToolHost(operationId, leaseId, reason))
    } else if (!this.jobRegistry && !this.toolBroker) {
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
    record: LocalAdmissionRecord,
    emitConsumerEvent: (ev: NormalizedInferenceEvent) => void,
    closeConsumer: (err?: unknown) => void,
  ): Promise<TurnReceiptV5 | null> {
    const req = record.request
    const originalReq = record.originalRequest
    const serviceTier: InferenceServiceTier = req.serviceTier ?? 'standard'
    const placementEpoch = req.placementHint?.placementEpoch ?? 1
    const canonicalModel = sanitizeModelId(
      this.resolveCanonicalModel?.(req.logicalModel),
      req.logicalModel,
    )
    const upstreamModel = sanitizeModelId(
      this.resolveUpstreamModel?.(req.logicalModel, record.matchedModel) ??
        record.matchedModel.upstreamModelId,
      canonicalModel,
    )

    let seq = 0
    const nowIso = () => new Date(this.clock()).toISOString()
    const evidenceLog: unknown[] = []
    const recordEvidence = (tag: string, payload: unknown) => {
      evidenceLog.push({ seq: evidenceLog.length + 1, tag, payload })
    }

    const budgetGuard = new CreditBudgetGuard({
      creditBudgetFen: originalReq.creditBudgetFen,
      serviceTier,
      estimateCreditsFen: this.estimateCreditsFen,
    })

    // Enforce hard read-only / hermetic policy on local ToolBroker BEFORE invoking local adapter.
    if (this.toolBroker) {
      tightenToolBrokerPolicy(this.toolBroker, record.leaseId, record.requiredCapabilities)
    }

    this.activeByTurnId.set(req.turnId, record)

    const emittedToolRequests = new Set<string>()
    const emittedToolCompletions = new Set<string>()
    const toolArgsShaByCallId = new Map<string, string>()

    let dispatchedEmitted = false
    const preDispatchBuffer: Array<() => NormalizedInferenceEvent> = []
    const pushEventFactory = (makeEv: (assignedSeq: number) => NormalizedInferenceEvent) => {
      if (!dispatchedEmitted) {
        preDispatchBuffer.push(() => makeEv(++seq))
        return
      }
      emitConsumerEvent(makeEv(++seq))
    }

    let observedNativeSessionId: string | null =
      this.adapter.nativeSessionId ?? req.nativeSessionId ?? null
    let streamErrorCode: string | undefined
    let latestTurnUsage: NormalizedUsageCounters | undefined

    const onSessionId = (sid: string) => {
      if (typeof sid === 'string' && sid.length > 0) {
        observedNativeSessionId = sid
      }
    }
    this.adapter.on('session_id', onSessionId)

    let backgroundError: unknown = undefined
    try {
      const admittedEvent: NormalizedInferenceEvent = {
        kind: 'turn_admitted',
        turnId: req.turnId,
        poolKind: this.poolKind,
        driverId: this.driverId,
        placementEpoch,
        seq: ++seq,
        ts: nowIso(),
      }
      recordEvidence('turn_admitted', {
        admissionId: record.admissionId,
        operationId: record.operationId,
      })
      emitConsumerEvent(admittedEvent)

      this.adapter.setModel(upstreamModel)
      if (req.reasoningEffort !== undefined) {
        this.adapter.setEffortLevel(req.reasoningEffort)
      }
      if (req.nativeSessionId && typeof this.adapter.setResumeSessionId === 'function') {
        this.adapter.setResumeSessionId(req.nativeSessionId)
      }

      const adapterServiceTier: TurnParams['serviceTier'] =
        serviceTier === 'fast' || serviceTier === 'ultrafast' ? serviceTier : null

      const handleEngineEvent = (e: EngineEvent): void => {
        const ts = nowIso()
        switch (e.kind) {
          case 'block': {
            const b = e.block
            if (b.kind === 'text') {
              recordEvidence('text_delta', b.text.length)
              pushEventFactory((assignedSeq) => ({
                kind: 'text_delta',
                turnId: req.turnId,
                channel: 'answer',
                delta: b.text,
                seq: assignedSeq,
                ts,
              }))
            } else if (b.kind === 'thinking') {
              recordEvidence('reasoning_delta', b.text.length)
              pushEventFactory((assignedSeq) => ({
                kind: 'text_delta',
                turnId: req.turnId,
                channel: 'reasoning',
                delta: b.text,
                seq: assignedSeq,
                ts,
              }))
            } else if (b.kind === 'tool_use') {
              const callId = b.blockId ?? `call_${seq + 1}`
              if (b.partial === true && typeof b.partialJsonDelta === 'string') {
                recordEvidence('tool_call_delta', { callId, toolName: b.toolName })
                const delta = b.partialJsonDelta
                pushEventFactory((assignedSeq) => ({
                  kind: 'tool_call_delta',
                  turnId: req.turnId,
                  callId,
                  toolName: b.toolName,
                  argsDelta: delta,
                  seq: assignedSeq,
                  ts,
                }))
              } else if (!b.partial && !emittedToolRequests.has(callId)) {
                const args = isPlainRecord(b.inputJson) ? b.inputJson : {}
                const argsSha256 = remoteCanonicalSha256(args)
                emittedToolRequests.add(callId)
                toolArgsShaByCallId.set(callId, argsSha256)
                recordEvidence('tool_call_request', { callId, toolName: b.toolName, argsSha256 })
                pushEventFactory((assignedSeq) => ({
                  kind: 'tool_call_request',
                  turnId: req.turnId,
                  callId,
                  toolName: b.toolName,
                  arguments: args,
                  argsSha256,
                  seq: assignedSeq,
                  ts,
                }))
              }
            } else if (b.kind === 'tool_result') {
              const callId = b.toolUseBlockId ?? b.blockId ?? `call_${seq + 1}`
              if (!emittedToolCompletions.has(callId)) {
                emittedToolCompletions.add(callId)
                const argsSha256 = toolArgsShaByCallId.get(callId) ?? remoteCanonicalSha256({})
                recordEvidence('tool_call_observed', { callId, phase: 'completed' })
                pushEventFactory((assignedSeq) => ({
                  kind: 'tool_call_observed',
                  turnId: req.turnId,
                  callId,
                  toolName: b.toolName,
                  phase: 'completed',
                  argsSha256,
                  seq: assignedSeq,
                  ts,
                }))
              }
            }
            break
          }
          case 'tool_use_detected': {
            const callId = e.tool.id
            const args = isPlainRecord(e.tool.input) ? e.tool.input : {}
            const argsSha256 = remoteCanonicalSha256(args)
            toolArgsShaByCallId.set(callId, argsSha256)
            if (!emittedToolRequests.has(callId)) {
              emittedToolRequests.add(callId)
              recordEvidence('tool_call_request', { callId, toolName: e.tool.name, argsSha256 })
              pushEventFactory((assignedSeq) => ({
                kind: 'tool_call_request',
                turnId: req.turnId,
                callId,
                toolName: e.tool.name,
                arguments: args,
                argsSha256,
                seq: assignedSeq,
                ts,
              }))
            } else {
              recordEvidence('tool_call_observed', { callId, phase: 'started' })
              pushEventFactory((assignedSeq) => ({
                kind: 'tool_call_observed',
                turnId: req.turnId,
                callId,
                toolName: e.tool.name,
                phase: 'started',
                argsSha256,
                seq: assignedSeq,
                ts,
              }))
            }
            break
          }
          case 'tool_result_detected': {
            const callId = e.result.toolUseId
            if (!emittedToolCompletions.has(callId)) {
              emittedToolCompletions.add(callId)
              const argsSha256 = toolArgsShaByCallId.get(callId) ?? remoteCanonicalSha256({})
              recordEvidence('tool_call_observed', { callId, phase: 'completed' })
              pushEventFactory((assignedSeq) => ({
                kind: 'tool_call_observed',
                turnId: req.turnId,
                callId,
                toolName: e.result.toolName,
                phase: 'completed',
                argsSha256,
                seq: assignedSeq,
                ts,
              }))
            }
            break
          }
          case 'permission_request': {
            recordEvidence('permission_request', {
              permissionId: e.request.requestId,
              toolName: e.request.toolName,
            })
            pushEventFactory((assignedSeq) => ({
              kind: 'permission_request',
              turnId: req.turnId,
              permissionId: e.request.requestId,
              toolName: e.request.toolName,
              reason: 'engine_permission_request',
              seq: assignedSeq,
              ts,
            }))
            break
          }
          case 'context_pressure': {
            const contextWindow = e.pressure.windowTokens ?? record.matchedModel.contextWindow ?? 0
            recordEvidence('context_pressure', {
              usedRatio: e.pressure.usedRatio,
              usedTokens: e.pressure.usedTokens ?? 0,
            })
            pushEventFactory((assignedSeq) => ({
              kind: 'context_pressure',
              turnId: req.turnId,
              usedTokens: safeNonNegativeInt(e.pressure.usedTokens),
              contextWindow: safeNonNegativeInt(contextWindow),
              ratio: e.pressure.usedRatio,
              seq: assignedSeq,
              ts,
            }))
            break
          }
          case 'context_compacted': {
            const clearedPromptCache = e.compaction.strategy === 'checkpoint_reset'
            recordEvidence('context_compacted', {
              strategy: e.compaction.strategy,
              beforeTokens: e.compaction.beforeTokens ?? null,
              afterTokens: e.compaction.afterTokens ?? null,
            })
            pushEventFactory((assignedSeq) => ({
              kind: 'context_compacted',
              turnId: req.turnId,
              reason: e.compaction.strategy,
              ...(e.compaction.beforeTokens === undefined
                ? {}
                : { beforeTokens: safeNonNegativeInt(e.compaction.beforeTokens) }),
              ...(e.compaction.afterTokens === undefined
                ? {}
                : { afterTokens: safeNonNegativeInt(e.compaction.afterTokens) }),
              ...(clearedPromptCache ? { clearedPromptCache: true } : {}),
              seq: assignedSeq,
              ts,
            }))
            break
          }
          case 'call_usage': {
            const normalized: NormalizedUsageCounters = Object.freeze({
              inputTokens: safeNonNegativeInt(e.call.usage.inputTokens),
              outputTokens: safeNonNegativeInt(e.call.usage.outputTokens),
              cacheReadTokens: safeNonNegativeInt(e.call.usage.cacheReadTokens),
              cacheWriteTokens: safeNonNegativeInt(e.call.usage.cacheCreationTokens),
            })
            recordEvidence('call_usage', { sampleId: e.call.callId, usage: normalized })
            pushEventFactory((assignedSeq) => ({
              kind: 'call_usage',
              turnId: req.turnId,
              sampleId: e.call.callId,
              scopeId: e.call.targetIds[0] ?? 'main',
              usage: normalized,
              seq: assignedSeq,
              ts,
            }))
            const guardResult = budgetGuard.recordSample(e.call.callId, normalized)
            if (guardResult.justTriggered) {
              recordEvidence('credit_budget_exceeded', {
                cumulativeCreditsFen: guardResult.cumulativeCreditsFen.toString(),
                budgetFen: originalReq.creditBudgetFen?.toString() ?? null,
              })
              this.adapter.interrupt('system')
            }
            break
          }
          case 'usage': {
            latestTurnUsage = Object.freeze({
              inputTokens: safeNonNegativeInt(e.usage.inputTokens),
              outputTokens: safeNonNegativeInt(e.usage.outputTokens),
              cacheReadTokens: safeNonNegativeInt(e.usage.cacheReadTokens),
              cacheWriteTokens: safeNonNegativeInt(e.usage.cacheCreationTokens),
            })
            recordEvidence('usage', latestTurnUsage)
            break
          }
          case 'turn_status': {
            const phase =
              e.status === null ? 'idle' : typeof e.status === 'string' ? e.status : e.status.status
            pushEventFactory((assignedSeq) => ({
              kind: 'turn_status',
              turnId: req.turnId,
              phase,
              seq: assignedSeq,
              ts,
            }))
            break
          }
          case 'error': {
            streamErrorCode = e.errorCode ?? e.errorClass ?? 'engine_error'
            recordEvidence('error', { code: streamErrorCode })
            break
          }
          case 'final': {
            if (e.meta) {
              latestTurnUsage = Object.freeze({
                inputTokens: safeNonNegativeInt(e.meta.inputTokens),
                outputTokens: safeNonNegativeInt(e.meta.outputTokens),
                cacheReadTokens: safeNonNegativeInt(e.meta.cacheReadTokens),
                cacheWriteTokens: safeNonNegativeInt(e.meta.cacheCreationTokens),
              })
              recordEvidence('final_meta', latestTurnUsage)
            }
            break
          }
          default:
            break
        }
      }

      const turnParams: TurnParams = {
        input: toLocalTurnInput(req.input),
        ...(record.requiredCapabilities.readOnly ? { readOnly: true } : {}),
        serviceTier: adapterServiceTier,
        requestId: req.requestId,
        turnKey: req.turnKey,
        ...(originalReq.creditBudgetFen === undefined
          ? {}
          : { creditBudgetFen: originalReq.creditBudgetFen }),
        ...(record.requiredCapabilities.consultTurn
          ? {
              consultTurn: originalReq.consultTurnConfig ?? {
                configVersion: 'v5',
                turnIndex: 1,
              },
            }
          : {}),
        onEvent: handleEngineEvent,
        sessionTotals: this.sessionTotals,
        toolUseIdToName: this.toolUseIdToName,
      }

      const turnRun = this.adapter.submitTurn(turnParams)
      let submitError: Error | null = null
      try {
        await turnRun.submitted
      } catch (err) {
        submitError = err instanceof Error ? err : new Error(String(err))
        recordEvidence('submit_error', submitError.message)
      }

      const resolvedNativeSessionId =
        observedNativeSessionId ?? this.adapter.nativeSessionId ?? req.nativeSessionId ?? undefined
      const nativeTurnId = req.authorityTurnId ?? req.turnId

      const dispatchedEvent: NormalizedInferenceEvent = {
        kind: 'turn_dispatched',
        turnId: req.turnId,
        ...(resolvedNativeSessionId ? { nativeSessionId: resolvedNativeSessionId } : {}),
        nativeTurnId,
        logicalModel: req.logicalModel,
        upstreamModel,
        seq: ++seq,
        ts: nowIso(),
      }
      recordEvidence('turn_dispatched', {
        nativeSessionId: resolvedNativeSessionId ?? null,
        nativeTurnId,
      })
      dispatchedEmitted = true
      emitConsumerEvent(dispatchedEvent)
      while (preDispatchBuffer.length > 0) {
        emitConsumerEvent(preDispatchBuffer.shift()!())
      }

      let summary: TurnSummary | null = null
      try {
        summary = await turnRun.summary
      } catch {
        summary = null
      }

      const summaryUsage: NormalizedUsageCounters = summary
        ? Object.freeze({
            inputTokens: safeNonNegativeInt((summary as TurnSummary).usage.inputTokens),
            outputTokens: safeNonNegativeInt((summary as TurnSummary).usage.outputTokens),
            cacheReadTokens: safeNonNegativeInt((summary as TurnSummary).usage.cacheReadTokens),
            cacheWriteTokens: safeNonNegativeInt(
              (summary as TurnSummary).usage.cacheCreationTokens,
            ),
          })
        : (latestTurnUsage ??
          Object.freeze({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }))

      const finalUsage = mergeUsageCountersMax(budgetGuard.cumulativeUsage, summaryUsage)

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
      } else if (
        submitError !== null ||
        streamErrorCode !== undefined ||
        summary === null ||
        (summary as TurnSummary).isError
      ) {
        receiptStatus = 'error'
        const rawErr =
          streamErrorCode ??
          (summary as TurnSummary | null)?.errorClass ??
          (submitError ? submitError.message : undefined) ??
          'engine_error'
        errorCode = sanitizeIdentifier(rawErr, 'engine_error')
        terminalStatus = 'error'
      } else {
        receiptStatus = 'success'
        errorCode = undefined
        terminalStatus = 'success'
      }

      const rawEvidenceDigest = remoteCanonicalSha256({
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
        usageSemantics: this.usageSemantics,
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
        terminalId: `term_${req.turnId}`,
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
      this.adapter.off('session_id', onSessionId)
      this.activeByTurnId.delete(req.turnId)
      closeConsumer(backgroundError)
    }
  }
}
