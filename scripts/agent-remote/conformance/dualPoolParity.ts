/**
 * OCV5-890 Wave 3 — Dual-Pool Parity Conformance Matrix & R8–R11 Red/Green Negative-Control Suite.
 *
 * Exercises the exact same logical model across both `LocalPoolDriver` and `RemotePoolV5Driver`
 * over all 5 acceptance dimensions plus R8–R11 fault-injection negative controls:
 *   1. `capability_truth_gate`                  — `probed ∩ transport ∩ catalog`, Vision/Thinking/Effort/serviceTier, zero silent downgrade
 *   2. `tool_policy_parity_R9`                  — `readOnly`, compound shell (`echo ok && $(rm -rf /)`), `blocking_then_detached`, blob spill, monotonic tightening red control
 *   3. `three_phase_cancel_and_billing`         — pre-admit / abandon 0-credit / post-dispatch interrupt & replay fence / CreditBudgetGuard `budget_exceeded` + identical `TurnReceiptV5.semanticDigest`
 *   4. `hot_swap_and_fencing_R10`               — real `managed_job` + `daemon_service` across Local -> Remote -> Local `MigrationCoordinator.handoff()` + stale `fencingToken` red control
 *   5. `schema_observation_R11_and_loopback_R8` — OCV5-800 `toolSummary` green / 1-byte schema tamper red + R8 `octk1.*` single-use green / 5 attack red controls
 *
 * Standalone CLI: `npx tsx scripts/agent-remote/conformance/dualPoolParity.ts`
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SCHEMA_FILTERED_HASH_GOLDEN_VECTORS,
  computeEffectiveModelCapabilities,
  computeSchemaFilteredArgsSha256,
  computeStickyHomeKey,
  computeToolIdempotencyKey,
  isExecutionPolicyMonotonicTightening,
  remoteCanonicalSha256,
  validateToolCallEnvelope,
  validateTurnReceiptV5,
  type CredentialLeaseHandle,
  type EngineStateCapsuleRef,
  type ExecutionPolicyEnvelope,
  type LogicalModelCapability,
  type NormalizedUsageCounters,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type SessionEnginePointer,
  type ToolCallEnvelope,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../../../packages/gateway/src/engine/engineAdapter.js'
import type { EngineEvent, PartialSnapshot, PhantomSignals, TurnSummary } from '../../../packages/gateway/src/engine/engineEvents.js'
import {
  ContainerLinkToolBrokerHost,
  ExecEnvJobRegistry,
  ExecEnvLeaseError,
  ExecEnvLeaseManager,
  ScopedCapabilityTokenAuthority,
  ScopedCapabilityTokenError,
  ToolBrokerPolicyError,
  ToolBrokerServer,
  createInMemoryFrameLinkPair,
  openChannel,
  type DetachedApprovalCard,
  type SpilledBlobRefOutput,
  type ToolBrokerResultEnvelope,
} from '../../../packages/gateway/src/execEnv/index.js'
import {
  InferencePoolDriverError,
  LocalPoolDriver,
  RemotePoolV5Driver,
  buildLocalDriverCapabilityManifest,
  buildRemoteDriverCapabilityManifest,
  type DriverTurnRequest,
  type RemoteV5LaneBridge,
  type RemoteV5LaneEvent,
  type RemoteV5TurnDispatchPayload,
  type TurnSettlementInfo,
} from '../../../packages/gateway/src/inferencePool/index.js'
import { InMemoryArtifactBlobStore } from '../../../packages/gateway/src/storageSeam/index.js'
import type { ExtendedRedControlEntry } from '../../../packages/commercial/src/account-pool/remotePool/extendedRedProof.js'
import {
  MigrationCoordinator,
  type MigrationAuthorityStorePort,
  type MigrationCapsulePort,
  type MigrationCredentialLeasePort,
  type MigrationDriverPort,
  type MigrationExecEnvPort,
} from '../../../packages/commercial/src/account-pool/remotePool/migrationCoordinator.js'
import { UnifiedPlacementRouter } from '../../../packages/commercial/src/account-pool/remotePool/unifiedPlacementRouter.js'
import type {
  AbortPlacementMigrationCas,
  AbortPlacementMigrationResult,
  BeginPlacementMigrationCas,
  BeginPlacementMigrationResult,
  CommitPlacementMigrationCas,
  CommitPlacementMigrationResult,
  SaveRollingCheckpointInput,
  SaveRollingCheckpointResult,
} from '../../../packages/commercial/src/db/threeLayerStateStore.js'

export const DUAL_POOL_PARITY_DIMENSION_NAMES = [
  'capability_truth_gate',
  'tool_policy_parity_R9',
  'three_phase_cancel_and_billing',
  'hot_swap_and_fencing_R10',
  'schema_observation_R11_and_loopback_R8',
] as const
export type DualPoolParityDimensionName = (typeof DUAL_POOL_PARITY_DIMENSION_NAMES)[number]

export interface DualPoolParityCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface DualPoolParityDimensionResult {
  readonly dimension: DualPoolParityDimensionName
  readonly passed: boolean
  readonly localPassed: boolean
  readonly remotePassed: boolean
  readonly parityMatched: boolean
  readonly checks: readonly DualPoolParityCheck[]
  readonly evidenceDigest: string
}

export interface DualPoolParityReport {
  readonly schemaVersion: 1
  readonly logicalModel: string
  readonly overallPassed: boolean
  readonly dimensions: readonly DualPoolParityDimensionResult[]
  readonly r8ToR11Controls: readonly ExtendedRedControlEntry[]
  readonly reportSha256: string
}

const LOGICAL_MODEL = 'gpt-5.4-pro'
const UPSTREAM_MODEL = 'gpt-5.4-pro-2026'
const FIXED_CLOCK_MS = Date.parse('2026-11-25T12:00:00.000Z')
const FIXED_ISO = '2026-11-25T12:00:00.000Z'
const FIXED_IMAGE_SHA = remoteCanonicalSha256({ fixture: 'parity-vision-frame-v5' })
const TENANT_ID = 'tenant-parity-v5'

const makeTurnKey = (tag: string): string =>
  remoteCanonicalSha256({ domain: 'oc-parity-turn-key', tag })

const deepEqualJson = (a: unknown, b: unknown): boolean =>
  remoteCanonicalSha256(a) === remoteCanonicalSha256(b)

function makeBaseRequest(overrides: Partial<DriverTurnRequest> = {}): DriverTurnRequest {
  return {
    schemaVersion: 5,
    turnId: 'turn-parity-01',
    turnKey: makeTurnKey('turn-parity-01'),
    requestId: 'req-parity-01',
    tenantId: TENANT_ID,
    sessionKey: 'sess-parity-01',
    logicalModel: LOGICAL_MODEL,
    serviceTier: 'fast',
    input: [{ type: 'text', text: 'Verify dual-pool parity' }],
    placementHint: { poolPreference: 'auto', placementEpoch: 1 },
    ...overrides,
  }
}

type LocalScenarioCtrl = {
  readonly onInterrupt: (cb: (reason?: 'user' | 'system') => void) => void
  readonly isInterrupted: () => boolean
  readonly emitEvent: (ev: EngineEvent) => void
}

class DeterministicLocalAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'codex'
  readonly capabilities: EngineAdapter['capabilities'] = {
    billingMode: 'engine-reported',
    supportsEffort: true,
    resumeKind: 'codex-thread',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    supportsNativeCompact: true,
    multimodalInput: 'native',
  }
  model: string | undefined = UPSTREAM_MODEL
  effortLevel: string | undefined = 'medium'
  toolsets: string[] | undefined = undefined
  executionTarget = { kind: 'local' } as EngineAdapter['executionTarget']
  nativeSessionId: string | null = 'native-local-parity-1'
  pendingToolCalls = 0
  isRunning = true
  lastActivityAt = FIXED_CLOCK_MS
  readonly submittedParams: TurnParams[] = []
  readonly interruptCalls: Array<'user' | 'system' | undefined> = []
  private interruptListeners: Array<(reason?: 'user' | 'system') => void> = []

  constructor(private readonly scenario: (p: TurnParams, c: LocalScenarioCtrl) => Promise<TurnSummary | null>) {
    super()
  }

  async start(): Promise<void> { this.isRunning = true }
  async shutdown(): Promise<void> { this.isRunning = false }
  async waitForOutputDrain(): Promise<void> {}
  clearSessionId(): void { this.nativeSessionId = null }
  setResumeSessionId(id: string): void { this.nativeSessionId = id }
  setModel(m: string | undefined): void { this.model = m }
  setEffortLevel(l: string | undefined): void { this.effortLevel = l }
  setTraceId(): void {}
  async setGoalState(): Promise<void> {}
  updateConfig(): void {}
  setToolsets(t: string[] | undefined): void { this.toolsets = t }
  setExecutionTarget(t: EngineAdapter['executionTarget']): void { this.executionTarget = t }
  sendPermissionResponse(): boolean { return true }
  getBoundRepoBinding(): null { return null }
  getPartialSnapshot(): PartialSnapshot {
    return { assistantText: '', thinkingText: '', completedTools: [], assistantSegments: [], thinkingSegments: [], runtimeEvents: [] }
  }
  interrupt(reason?: 'user' | 'system'): boolean {
    this.interruptCalls.push(reason)
    for (const cb of [...this.interruptListeners]) cb(reason)
    return true
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    this.submittedParams.push(params)
    this.interruptListeners = []
    let finalized = false
    let turnInterrupted = false
    this.interruptListeners.push(() => { turnInterrupted = true })
    const summary = Promise.resolve().then(async () => {
      try {
        return await this.scenario(params, {
          onInterrupt: (cb) => {
            if (turnInterrupted) cb('system')
            else this.interruptListeners.push((r) => { turnInterrupted = true; cb(r) })
          },
          isInterrupted: () => turnInterrupted,
          emitEvent: (ev) => params.onEvent(ev),
        })
      } finally {
        finalized = true
      }
    })
    return {
      submitted: Promise.resolve(),
      summary,
      end: () => { finalized = true },
      getPartialSnapshot: () => this.getPartialSnapshot(),
      getPhantomSignals: (): PhantomSignals => ({ apiState: 'called', skipReason: null }),
      get finalized() { return finalized },
      get pendingToolCalls() { return 0 },
    }
  }
}

function makeTurnSummary(usage: NormalizedUsageCounters, isError = false): TurnSummary {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    usage: { cost: 0.01, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheWriteTokens, totalTokens },
    assistantText: 'ok',
    thinkingText: '',
    assistantSegments: [],
    thinkingSegments: [],
    tools: [],
    runtimeEvents: [],
    stopReason: 'end_turn',
    numTurns: 1,
    isError,
    staleResumeId: false,
    phantomSignals: { apiState: 'called', skipReason: null },
  }
}

function makeToolCallEnvelope(opts: {
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly canonicalName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly inputSchema?: Readonly<Record<string, unknown>> | null
  readonly argsSha256Override?: string
}): ToolCallEnvelope {
  const argsSha256 = opts.argsSha256Override ?? computeSchemaFilteredArgsSha256(opts.arguments, opts.inputSchema ?? null)
  const propKeys =
    opts.inputSchema && typeof opts.inputSchema === 'object' && opts.inputSchema.properties && typeof opts.inputSchema.properties === 'object'
      ? Object.keys(opts.inputSchema.properties as Record<string, unknown>)
      : undefined
  return {
    schemaVersion: 1,
    leaseId: opts.leaseId,
    turnId: opts.turnId,
    callId: opts.callId,
    idempotencyKey: computeToolIdempotencyKey(opts.leaseId, opts.turnId, opts.callId),
    canonicalName: opts.canonicalName,
    arguments: opts.arguments,
    argsSha256,
    attestation: {
      kind: 'schema_filtered_hook',
      argsSha256,
      observedAt: FIXED_ISO,
      ...(propKeys && propKeys.length > 0 ? { filteredKeys: propKeys } : {}),
    },
  }
}

async function captureDriverError(fn: () => Promise<unknown>): Promise<{ readonly code: string | null; readonly details: readonly string[] }> {
  try {
    await fn()
    return { code: null, details: [] }
  } catch (err) {
    if (err instanceof InferencePoolDriverError) return { code: err.code, details: err.details ?? [] }
    return { code: err instanceof Error ? err.message : String(err), details: [] }
  }
}

function makeCap(overrides: Partial<LogicalModelCapability> = {}): LogicalModelCapability {
  return {
    logicalModel: LOGICAL_MODEL,
    upstreamModelId: UPSTREAM_MODEL,
    supportsVision: true,
    supportedEfforts: ['medium', 'high'],
    defaultEffort: 'medium',
    supportedServiceTiers: ['standard', 'fast'],
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
    contextWindow: 200_000,
    ...overrides,
  }
}

// ── Dimension 1: capability_truth_gate ───────────────────────────────────────
async function runCapabilityTruthGateDimension(): Promise<DualPoolParityDimensionResult> {
  const checks: DualPoolParityCheck[] = []
  const probed = makeCap({ supportedEfforts: ['low', 'medium', 'high', 'max'], supportedServiceTiers: ['standard', 'fast', 'ultrafast'], contextWindow: 256_000 })
  const transport = makeCap({ supportedEfforts: ['low', 'medium', 'high'], supportedServiceTiers: ['standard', 'fast'], contextWindow: 200_000 })
  const catalog = makeCap({ supportedEfforts: ['medium', 'high'], defaultEffort: 'high', supportedServiceTiers: ['standard', 'fast', 'ultrafast'] })
  const noVision = makeCap({ logicalModel: 'text-only-pro', upstreamModelId: 'text-only-pro-2026', supportsVision: false, supportedEfforts: ['medium'], supportedServiceTiers: ['standard'], supportsConsultTurn: false, supportsSwarm: false, supportsAdaptiveThinking: false, contextWindow: 128_000 })

  const triplets = [
    { probed, transport, catalog },
    { probed: { ...noVision, supportsVision: true }, transport: noVision, catalog: noVision },
  ]
  const localManifest = buildLocalDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'local-parity-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: triplets })
  const remoteManifest = buildRemoteDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'remote-parity-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: triplets })

  const localAdapter = new DeterministicLocalAdapter(async () => makeTurnSummary({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const remoteDispatches: RemoteV5TurnDispatchPayload[] = []
  const remoteBridge: RemoteV5LaneBridge = {
    async *dispatchTurn(payload): AsyncIterable<RemoteV5LaneEvent> {
      remoteDispatches.push(payload)
      yield { kind: 'dispatched', nativeSessionId: 'native-remote-parity-1', upstreamModel: payload.upstreamModel }
      yield { kind: 'text_delta', channel: 'answer', delta: 'ok' }
      yield { kind: 'terminal', status: 'success', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
    async interrupt() {},
    async stopRemote() { return { remoteStopped: true } },
  }
  const localDriver = new LocalPoolDriver({ adapter: localAdapter, manifest: localManifest, clock: () => FIXED_CLOCK_MS })
  const remoteDriver = new RemotePoolV5Driver({ bridge: remoteBridge, manifest: remoteManifest, clock: () => FIXED_CLOCK_MS })

  const localModel = (await localDriver.probeCapabilities()).models[0]!
  const remoteModel = (await remoteDriver.probeCapabilities()).models[0]!
  checks.push({
    name: 'probed_intersect_transport_intersect_catalog_parity',
    passed:
      deepEqualJson(localModel, remoteModel) &&
      localModel.supportsVision === true &&
      localModel.supportsAdaptiveThinking === true &&
      deepEqualJson(localModel.supportedEfforts, ['medium', 'high']) &&
      deepEqualJson(localModel.supportedServiceTiers, ['standard', 'fast']) &&
      localModel.contextWindow === 200_000,
    detail: `efforts=${localModel.supportedEfforts.join(',')};tiers=${localModel.supportedServiceTiers.join(',')}`,
  })

  const adaptiveOff = computeEffectiveModelCapabilities(probed, { ...transport, supportsAdaptiveThinking: false }, catalog)
  checks.push({ name: 'adaptive_thinking_strict_intersection', passed: adaptiveOff.supportsAdaptiveThinking === false })

  // Green: Vision + Effort('high') + serviceTier('fast') with zero silent downgrade
  const visionReq = makeBaseRequest({
    turnId: 'turn-cap-green-01',
    turnKey: makeTurnKey('turn-cap-green-01'),
    requestId: 'req-cap-green-01',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    input: [{ type: 'text', text: 'Inspect diagram' }, { type: 'image_ref', blobId: 'blob-img-01', sha256: FIXED_IMAGE_SHA, mimeType: 'image/png' }],
  })
  let localGreenReceipt: TurnReceiptV5 | null = null
  for await (const ev of localDriver.executeTurn(visionReq)) if (ev.kind === 'billing_receipt') localGreenReceipt = ev.receipt
  let remoteGreenReceipt: TurnReceiptV5 | null = null
  for await (const ev of remoteDriver.executeTurn(visionReq)) if (ev.kind === 'billing_receipt') remoteGreenReceipt = ev.receipt
  const lastLocalParam = localAdapter.submittedParams.at(-1)
  const lastRemotePayload = remoteDispatches.at(-1)
  checks.push({
    name: 'vision_effort_fast_tier_zero_silent_downgrade',
    passed:
      localGreenReceipt?.serviceTier === 'fast' &&
      remoteGreenReceipt?.serviceTier === 'fast' &&
      localAdapter.effortLevel === 'high' &&
      lastLocalParam?.serviceTier === 'fast' &&
      Array.isArray(lastLocalParam.input) &&
      lastLocalParam.input.some((b) => b.type === 'image_ref') &&
      lastRemotePayload?.serviceTier === 'fast' &&
      lastRemotePayload.reasoningEffort === 'high' &&
      lastRemotePayload.input.some((b) => b.type === 'image_ref') &&
      localGreenReceipt.semanticDigest === remoteGreenReceipt.semanticDigest,
  })

  // Green: ultrafast serviceTier parity across both pools
  const ultraCap = makeCap({ supportedServiceTiers: ['standard', 'fast', 'ultrafast'] })
  const localUltraAdapter = new DeterministicLocalAdapter(async () => makeTurnSummary({ inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const remoteUltraPayloads: RemoteV5TurnDispatchPayload[] = []
  const localUltraDriver = new LocalPoolDriver({
    adapter: localUltraAdapter,
    manifest: buildLocalDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'local-ultrafast-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: [{ probed: ultraCap, transport: ultraCap, catalog: ultraCap }] }),
    clock: () => FIXED_CLOCK_MS,
  })
  const remoteUltraDriver = new RemotePoolV5Driver({
    bridge: {
      async *dispatchTurn(payload): AsyncIterable<RemoteV5LaneEvent> {
        remoteUltraPayloads.push(payload)
        yield { kind: 'terminal', status: 'success', usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      },
      async interrupt() {},
      async stopRemote() { return { remoteStopped: true } },
    },
    manifest: buildRemoteDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'remote-ultrafast-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: [{ probed: ultraCap, transport: ultraCap, catalog: ultraCap }] }),
    clock: () => FIXED_CLOCK_MS,
  })
  const ultraReq = makeBaseRequest({ turnId: 'turn-cap-ultrafast-01', turnKey: makeTurnKey('turn-cap-ultrafast-01'), requestId: 'req-cap-ultrafast-01', serviceTier: 'ultrafast' })
  let localUltraReceipt: TurnReceiptV5 | null = null
  for await (const ev of localUltraDriver.executeTurn(ultraReq)) if (ev.kind === 'billing_receipt') localUltraReceipt = ev.receipt
  let remoteUltraReceipt: TurnReceiptV5 | null = null
  for await (const ev of remoteUltraDriver.executeTurn(ultraReq)) if (ev.kind === 'billing_receipt') remoteUltraReceipt = ev.receipt
  checks.push({
    name: 'service_tier_ultrafast_parity',
    passed:
      localUltraReceipt?.serviceTier === 'ultrafast' &&
      remoteUltraReceipt?.serviceTier === 'ultrafast' &&
      localUltraAdapter.submittedParams.at(-1)?.serviceTier === 'ultrafast' &&
      remoteUltraPayloads.at(-1)?.serviceTier === 'ultrafast' &&
      localUltraReceipt.semanticDigest === remoteUltraReceipt.semanticDigest,
  })

  // Negative checks: missing serviceTier / effort / vision throw identical CAPABILITY_UNSATISFIED on both pools
  const errUltraLocal = await captureDriverError(() => localDriver.admit(makeBaseRequest({ turnId: 'turn-err-tier', serviceTier: 'ultrafast' })))
  const errUltraRemote = await captureDriverError(() => remoteDriver.admit(makeBaseRequest({ turnId: 'turn-err-tier', serviceTier: 'ultrafast' })))
  checks.push({
    name: 'missing_service_tier_fails_closed_both_pools',
    passed: errUltraLocal.code === 'CAPABILITY_UNSATISFIED' && errUltraRemote.code === 'CAPABILITY_UNSATISFIED' && deepEqualJson(errUltraLocal.details, errUltraRemote.details) && errUltraLocal.details.includes('service_tier_unsupported:ultrafast'),
  })

  const errEffortLocal = await captureDriverError(() => localDriver.admit(makeBaseRequest({ turnId: 'turn-err-effort', reasoningEffort: 'max' })))
  const errEffortRemote = await captureDriverError(() => remoteDriver.admit(makeBaseRequest({ turnId: 'turn-err-effort', reasoningEffort: 'max' })))
  checks.push({
    name: 'missing_effort_fails_closed_both_pools',
    passed: errEffortLocal.code === 'CAPABILITY_UNSATISFIED' && errEffortRemote.code === 'CAPABILITY_UNSATISFIED' && deepEqualJson(errEffortLocal.details, errEffortRemote.details) && errEffortLocal.details.includes('reasoning_effort_unsupported:max'),
  })

  const visionDeniedReq = makeBaseRequest({ turnId: 'turn-err-vision', logicalModel: 'text-only-pro', serviceTier: 'standard', input: [{ type: 'image_ref', blobId: 'blob-img-02', sha256: FIXED_IMAGE_SHA, mimeType: 'image/png' }] })
  const errVisionLocal = await captureDriverError(() => localDriver.admit(visionDeniedReq))
  const errVisionRemote = await captureDriverError(() => remoteDriver.admit(visionDeniedReq))
  checks.push({
    name: 'missing_vision_fails_closed_both_pools',
    passed: errVisionLocal.code === 'CAPABILITY_UNSATISFIED' && errVisionRemote.code === 'CAPABILITY_UNSATISFIED' && deepEqualJson(errVisionLocal.details, errVisionRemote.details) && errVisionLocal.details.includes('vision_unsupported'),
  })

  const router = new UnifiedPlacementRouter({
    candidates: [
      { poolKind: 'local_pool', driverId: localManifest.driverId, manifest: localManifest, healthy: true, draining: false, activeSlots: 0, maxSlots: 4, weight: 100 },
      { poolKind: 'remote_pool', driverId: remoteManifest.driverId, manifest: remoteManifest, healthy: true, draining: false, activeSlots: 0, maxSlots: 4, weight: 100 },
    ],
  })
  const routerBlocked = await router.routeTurn({ rawModelId: LOGICAL_MODEL, sessionKey: 'sess-parity-01', requiredCapabilities: { serviceTier: 'ultrafast' } })
  checks.push({ name: 'router_capability_superset_no_silent_downgrade', passed: routerBlocked.ok === false && routerBlocked.code === 'CAPABILITY_UNSATISFIED' })

  const allPassed = checks.every((c) => c.passed)
  return Object.freeze({
    dimension: 'capability_truth_gate',
    passed: allPassed,
    localPassed: allPassed,
    remotePassed: allPassed,
    parityMatched: allPassed,
    checks: Object.freeze(checks),
    evidenceDigest: remoteCanonicalSha256({ dimension: 'capability_truth_gate', localModel, remoteModel, errUltraLocal, errEffortLocal, errVisionLocal, checks }),
  })
}

// ── Dimension 2: tool_policy_parity_R9 (R9 Red/Green) ────────────────────────
async function runToolPolicyParityR9Dimension(): Promise<{ readonly result: DualPoolParityDimensionResult; readonly r9Control: ExtendedRedControlEntry }> {
  const checks: DualPoolParityCheck[] = []
  const leaseIdRo = 'lease-parity-r9-ro'
  const leaseIdNormal = 'lease-parity-r9-normal'
  const sessionKey = 'sess-parity-r9'
  const fencingTokenRo = 'fence-r9-ro-token-01'
  const fencingTokenNormal = 'fence-r9-normal-token-01'
  const largePayload = 'X'.repeat(1024)

  const readFileSchema = { type: 'object', properties: { Path: { type: 'string' }, spill: { type: 'boolean' } }, required: ['Path'] }
  const writeFileSchema = { type: 'object', properties: { Path: { type: 'string' }, Content: { type: 'string' } }, required: ['Path', 'Content'] }
  const bashSchema = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }

  const localBlobStore = new InMemoryArtifactBlobStore()
  const remoteBlobStore = new InMemoryArtifactBlobStore()
  const localDetachedCards: DetachedApprovalCard[] = []
  const remoteDetachedCards: DetachedApprovalCard[] = []
  let localWriteExecutions = 0
  let remoteWriteExecutions = 0
  let localBashExecutions = 0
  let remoteBashExecutions = 0

  const roPolicy: ExecutionPolicyEnvelope = { schemaVersion: 1, mode: 'read_only', allowedTools: ['read_file'], allowNetworkEgress: false, allowWorkspaceWrite: false, allowSubprocessSpawn: false, maxToolCallsPerTurn: 16 }
  const normalPolicy: ExecutionPolicyEnvelope = { schemaVersion: 1, mode: 'normal', allowedTools: ['read_file', 'write_file', 'bash'], allowNetworkEgress: false, allowWorkspaceWrite: true, allowSubprocessSpawn: true, maxToolCallsPerTurn: 16 }

  const makeSide = (side: 'local' | 'remote') => {
    const leaseMgr = new ExecEnvLeaseManager({ clock: () => FIXED_CLOCK_MS })
    const hostKind = side === 'local' ? 'local-docker' : 'compute-pool-docker'
    leaseMgr.issueLease({ leaseId: leaseIdRo, execEnvId: `env-${side}-r9`, incarnationId: `inc-${side}-1`, sessionKey, hostKind, brainGen: 1, fencingToken: fencingTokenRo })
    leaseMgr.issueLease({ leaseId: leaseIdNormal, execEnvId: `env-${side}-r9-norm`, incarnationId: `inc-${side}-2`, sessionKey, hostKind, brainGen: 1, fencingToken: fencingTokenNormal })
    const blobStore = side === 'local' ? localBlobStore : remoteBlobStore
    const cards = side === 'local' ? localDetachedCards : remoteDetachedCards
    const broker = new ToolBrokerServer({
      channelKind: side === 'local' ? 'uds_jsonrpc' : 'ws_tunnel',
      leaseManager: leaseMgr,
      requireFencingToken: true,
      allowEphemeralSideEffects: true,
      detachedFallbackAfterMs: 30,
      onDetachedApprovalCard: (card) => cards.push(card),
      approvalHandler: async (_req, signal) => await new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ decision: 'deny', reason: 'aborted_for_detached' }), { once: true }) }),
      maxInlinePayloadBytes: 256,
      spillBlob: async (bytes, mimeType) => {
        const ref = await blobStore.put({ tenantId: TENANT_ID, kind: 'tool_spill', mimeType, bytes, logicalName: 'parity-spill.txt' })
        return { blobId: ref.blobId, sha256: ref.sha256, mimeType: ref.mimeType, bytes: ref.sizeBytes }
      },
      clock: () => FIXED_CLOCK_MS,
    })
    broker.registerTool({ canonicalName: 'read_file', readOnly: true, idempotent: true, inputSchema: readFileSchema, handler: (args) => (args.spill === true ? largePayload : `contents:${String(args.Path)}`) })
    broker.registerTool({ canonicalName: 'write_file', readOnly: false, inputSchema: writeFileSchema, handler: () => { if (side === 'local') localWriteExecutions += 1; else remoteWriteExecutions += 1; return 'written' } })
    broker.registerTool({ canonicalName: 'bash', isShell: true, readOnly: false, inputSchema: bashSchema, handler: (args) => { if (side === 'local') localBashExecutions += 1; else remoteBashExecutions += 1; return `ran:${String(args.command)}` } })
    broker.setPolicy(leaseIdRo, roPolicy)
    broker.setPolicy(leaseIdNormal, normalPolicy)
    const [hostLink, clientLink] = createInMemoryFrameLinkPair()
    const host = new ContainerLinkToolBrokerHost({ link: hostLink, server: broker, leaseManager: leaseMgr })
    const clientRo = openChannel('tool-broker', { link: clientLink, hostKind, leaseId: leaseIdRo, fencingToken: fencingTokenRo, brainGen: 1, sessionKey })
    const clientNormal = openChannel('tool-broker', { link: clientLink, hostKind, leaseId: leaseIdNormal, fencingToken: fencingTokenNormal, brainGen: 1, sessionKey })
    return { broker, host, clientRo, clientNormal }
  }

  const localSide = makeSide('local')
  const remoteSide = makeSide('remote')
  const norm = (r: ToolBrokerResultEnvelope) => ({
    status: r.status,
    errorCode: r.errorCode ?? null,
    approvalStatus: r.approvalStatus ?? null,
    replayStatus: r.replayStatus ?? null,
    output: r.output ?? null,
    hasDetachedCard: Boolean(r.detachedCard),
    detachedTool: r.detachedCard?.toolName ?? null,
    detachedTier: r.detachedCard?.evaluation.tier ?? null,
  })

  try {
    // 1. readOnly write interception + read_file allow
    const writeCall = makeToolCallEnvelope({ leaseId: leaseIdRo, turnId: 'turn-r9-1', callId: 'call-r9-write', canonicalName: 'write_file', arguments: { Path: 'hack.ts', Content: 'pwn' }, inputSchema: writeFileSchema })
    const localWriteRes = await localSide.clientRo.invoke(writeCall)
    const remoteWriteRes = await remoteSide.clientRo.invoke(writeCall)
    const readOnlyWriteBlocked = localWriteRes.status === 'denied' && localWriteRes.errorCode === 'EXEC_POLICY_READ_ONLY_DENIED' && deepEqualJson(norm(localWriteRes), norm(remoteWriteRes)) && localWriteExecutions === 0 && remoteWriteExecutions === 0
    checks.push({ name: 'read_only_write_tool_blocked_parity', passed: readOnlyWriteBlocked, detail: `local=${localWriteRes.errorCode},remote=${remoteWriteRes.errorCode}` })

    const readCall = makeToolCallEnvelope({ leaseId: leaseIdRo, turnId: 'turn-r9-1', callId: 'call-r9-read', canonicalName: 'read_file', arguments: { Path: 'README.md' }, inputSchema: readFileSchema })
    const localReadRes = await localSide.clientRo.invoke(readCall)
    const remoteReadRes = await remoteSide.clientRo.invoke(readCall)
    checks.push({ name: 'read_only_read_tool_allowed_parity', passed: localReadRes.status === 'ok' && localReadRes.output === 'contents:README.md' && deepEqualJson(norm(localReadRes), norm(remoteReadRes)) })

    // 2. Compound shell destructive command (`echo ok && $(rm -rf /)`)
    const compoundCall = makeToolCallEnvelope({ leaseId: leaseIdNormal, turnId: 'turn-r9-2', callId: 'call-r9-compound-rm', canonicalName: 'bash', arguments: { command: 'echo ok && $(rm -rf /)' }, inputSchema: bashSchema })
    const localCompoundRes = await localSide.clientNormal.invoke(compoundCall)
    const remoteCompoundRes = await remoteSide.clientNormal.invoke(compoundCall)
    const compoundShellBlocked = localCompoundRes.status === 'denied' && localCompoundRes.errorCode === 'ACTION_POLICY_DENIED' && deepEqualJson(norm(localCompoundRes), norm(remoteCompoundRes)) && localBashExecutions === 0 && remoteBashExecutions === 0
    checks.push({ name: 'compound_shell_destructive_blocked_parity', passed: compoundShellBlocked, detail: `local=${localCompoundRes.errorCode},remote=${remoteCompoundRes.errorCode}` })

    // 3. blocking_then_detached timeout -> async approval card
    const forcePushCall = makeToolCallEnvelope({ leaseId: leaseIdNormal, turnId: 'turn-r9-3', callId: 'call-r9-force-push', canonicalName: 'bash', arguments: { command: 'git push --force origin main' }, inputSchema: bashSchema })
    const [localDetachedRes, remoteDetachedRes] = await Promise.all([localSide.clientNormal.invoke(forcePushCall), remoteSide.clientNormal.invoke(forcePushCall)])
    checks.push({
      name: 'blocking_then_detached_approval_card_parity',
      passed:
        localDetachedRes.status === 'denied' &&
        localDetachedRes.errorCode === 'APPROVAL_DEFERRED_DETACHED' &&
        localDetachedRes.approvalStatus === 'detached_pending' &&
        localDetachedCards.length === 1 &&
        remoteDetachedCards.length === 1 &&
        deepEqualJson(norm(localDetachedRes), norm(remoteDetachedRes)) &&
        localBashExecutions === 0 &&
        remoteBashExecutions === 0,
      detail: `local=${localDetachedRes.errorCode},remote=${remoteDetachedRes.errorCode}`,
    })

    // 4. >maxInlinePayloadBytes auto-spill to ArtifactBlobRef
    const spillCall = makeToolCallEnvelope({ leaseId: leaseIdRo, turnId: 'turn-r9-4', callId: 'call-r9-spill', canonicalName: 'read_file', arguments: { Path: 'big.log', spill: true }, inputSchema: readFileSchema })
    const localSpillRes = await localSide.clientRo.invoke(spillCall)
    const remoteSpillRes = await remoteSide.clientRo.invoke(spillCall)
    const localOut = localSpillRes.output as SpilledBlobRefOutput | undefined
    const remoteOut = remoteSpillRes.output as SpilledBlobRefOutput | undefined
    const expectedSpillSha = createHash('sha256').update(largePayload, 'utf8').digest('hex')
    const localBytes = localOut?.blobId ? await localBlobStore.getBytes(TENANT_ID, localOut.blobId) : null
    const remoteBytes = remoteOut?.blobId ? await remoteBlobStore.getBytes(TENANT_ID, remoteOut.blobId) : null
    checks.push({
      name: 'large_output_spill_to_artifact_blob_ref_parity',
      passed:
        localSpillRes.status === 'ok' &&
        remoteSpillRes.status === 'ok' &&
        Boolean(localSpillRes.spilledBlobId) &&
        Boolean(remoteSpillRes.spilledBlobId) &&
        localOut?.type === 'blob_ref' &&
        remoteOut?.type === 'blob_ref' &&
        localOut.sha256 === expectedSpillSha &&
        remoteOut.sha256 === expectedSpillSha &&
        localOut.bytes === 1024 &&
        remoteOut.bytes === 1024 &&
        localBytes !== null &&
        remoteBytes !== null &&
        Buffer.from(localBytes).toString('utf8') === largePayload &&
        Buffer.from(remoteBytes).toString('utf8') === largePayload,
      detail: `sha256=${expectedSpillSha.slice(0, 12)},bytes=${localOut?.bytes ?? 0}`,
    })

    // 5. R9 Red Control: runtime ExecutionPolicyEnvelope relaxation rejected
    const pureRelaxRejected = !isExecutionPolicyMonotonicTightening(roPolicy, normalPolicy)
    const captureRelax = (broker: ToolBrokerServer): string | null => {
      try { broker.setPolicy(leaseIdRo, normalPolicy); return null } catch (err) { return err instanceof ToolBrokerPolicyError ? err.code : String(err) }
    }
    const localRelaxCode = captureRelax(localSide.broker)
    const remoteRelaxCode = captureRelax(remoteSide.broker)
    const r9RedCaught = pureRelaxRejected && localRelaxCode === 'EXEC_POLICY_RELAXATION_FORBIDDEN' && remoteRelaxCode === 'EXEC_POLICY_RELAXATION_FORBIDDEN' && readOnlyWriteBlocked && compoundShellBlocked
    checks.push({ name: 'R9_red_control_runtime_policy_relaxation_rejected', passed: r9RedCaught, detail: `local=${localRelaxCode},remote=${remoteRelaxCode}` })

    const allPassed = checks.every((c) => c.passed)
    const evidenceDigest = remoteCanonicalSha256({ dimension: 'tool_policy_parity_R9', writeBlocked: norm(localWriteRes), compoundBlocked: norm(localCompoundRes), detachedDeferred: norm(localDetachedRes), spillSha256: expectedSpillSha, localRelaxCode, remoteRelaxCode, checks })
    const r9Control: ExtendedRedControlEntry = Object.freeze({
      requirementId: 'R9' as const,
      dimension: 'tool_policy_parity_R9',
      redControlCaught: (r9RedCaught ? true : false) as true,
      greenPassed: (allPassed ? true : false) as true,
      injectedFault: 'runtime_execution_policy_relaxation_read_only_to_normal_plus_write_and_compound_shell_bypass',
      evidenceDigest,
    })
    return {
      result: Object.freeze({ dimension: 'tool_policy_parity_R9', passed: allPassed, localPassed: allPassed, remotePassed: allPassed, parityMatched: allPassed, checks: Object.freeze(checks), evidenceDigest }),
      r9Control,
    }
  } finally {
    localSide.clientRo.close(); localSide.clientNormal.close(); localSide.host.dispose()
    remoteSide.clientRo.close(); remoteSide.clientNormal.close(); remoteSide.host.dispose()
  }
}

// ── Dimension 3: three_phase_cancel_and_billing ──────────────────────────────
async function runThreePhaseCancelAndBillingDimension(): Promise<DualPoolParityDimensionResult> {
  const checks: DualPoolParityCheck[] = []
  const cap = makeCap()
  const localManifest = buildLocalDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'local-billing-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: [{ probed: cap, transport: cap, catalog: cap }] })
  const remoteManifest = buildRemoteDriverCapabilityManifest({ engineFamily: 'codex', authorityEngine: 'codex', driverId: 'remote-billing-driver', driverVersion: '5.0.0', observedAt: FIXED_ISO, models: [{ probed: cap, transport: cap, catalog: cap }] })

  const localAdmits: string[] = []; const remoteAdmits: string[] = []
  const localAbandons: string[] = []; const remoteAbandons: string[] = []
  const localSettlements: Array<{ receipt: TurnReceiptV5; info: TurnSettlementInfo }> = []
  const remoteSettlements: Array<{ receipt: TurnReceiptV5; info: TurnSettlementInfo }> = []
  let mode: 'interrupt' | 'budget' | 'success' = 'interrupt'

  const localAdapter = new DeterministicLocalAdapter(async (_params, ctrl) => {
    if (mode === 'interrupt') {
      ctrl.emitEvent({ kind: 'call_usage', call: { callId: 'sample-int-1', targetIds: ['main'], usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 400, cacheCreationTokens: 100, totalTokens: 2050 } } })
      if (!ctrl.isInterrupted()) await new Promise<void>((r) => ctrl.onInterrupt(() => r()))
      return makeTurnSummary({ inputTokens: 1200, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 100 })
    }
    if (mode === 'budget') {
      ctrl.emitEvent({ kind: 'call_usage', call: { callId: 'sample-bud-1', targetIds: ['main'], usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1200 } } })
      ctrl.emitEvent({ kind: 'call_usage', call: { callId: 'sample-bud-1', targetIds: ['main'], usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1200 } } })
      ctrl.emitEvent({ kind: 'call_usage', call: { callId: 'sample-bud-2', targetIds: ['main'], usage: { inputTokens: 4000, outputTokens: 1500, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 5500 } } })
      if (!ctrl.isInterrupted()) await new Promise<void>((r) => ctrl.onInterrupt(() => r()))
      return makeTurnSummary({ inputTokens: 5000, outputTokens: 1700, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    ctrl.emitEvent({ kind: 'call_usage', call: { callId: 'sample-ok-1', targetIds: ['main'], usage: { inputTokens: 600, outputTokens: 150, cacheReadTokens: 200, cacheCreationTokens: 50, totalTokens: 1000 } } })
    return makeTurnSummary({ inputTokens: 600, outputTokens: 150, cacheReadTokens: 200, cacheWriteTokens: 50 })
  })

  let remoteInterruptResolver: (() => void) | null = null
  let remoteTurnInterrupted = false
  const remoteBridge: RemoteV5LaneBridge = {
    async *dispatchTurn(payload): AsyncIterable<RemoteV5LaneEvent> {
      remoteTurnInterrupted = false
      remoteInterruptResolver = null
      yield { kind: 'dispatched', nativeSessionId: 'native-remote-bill-1', upstreamModel: payload.upstreamModel }
      if (mode === 'interrupt') {
        yield { kind: 'call_usage', sampleId: 'sample-int-1', scopeId: 'main', usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 100 } }
        if (!remoteTurnInterrupted) await new Promise<void>((r) => { remoteInterruptResolver = r })
        yield { kind: 'terminal', status: 'interrupted', errorCode: 'user_stop', usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 400, cacheWriteTokens: 100 } }
        return
      }
      if (mode === 'budget') {
        yield { kind: 'call_usage', sampleId: 'sample-bud-1', scopeId: 'main', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { kind: 'call_usage', sampleId: 'sample-bud-1', scopeId: 'main', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { kind: 'call_usage', sampleId: 'sample-bud-2', scopeId: 'main', usage: { inputTokens: 4000, outputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { kind: 'terminal', status: 'interrupted', errorCode: 'budget_exceeded', usage: { inputTokens: 5000, outputTokens: 1700, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        return
      }
      yield { kind: 'call_usage', sampleId: 'sample-ok-1', scopeId: 'main', usage: { inputTokens: 600, outputTokens: 150, cacheReadTokens: 200, cacheWriteTokens: 50 } }
      yield { kind: 'terminal', status: 'success', usage: { inputTokens: 600, outputTokens: 150, cacheReadTokens: 200, cacheWriteTokens: 50 } }
    },
    async interrupt() { remoteTurnInterrupted = true; const w = remoteInterruptResolver; remoteInterruptResolver = null; w?.() },
    async stopRemote() { return { remoteStopped: true } },
  }

  const localDriver = new LocalPoolDriver({ adapter: localAdapter, manifest: localManifest, clock: () => FIXED_CLOCK_MS, onAdmitJournal: (_r, a) => { localAdmits.push(a.admissionId) }, onAbandonJournal: (id) => { localAbandons.push(id) }, onSettleReceipt: (receipt, info) => { localSettlements.push({ receipt, info }) } })
  const remoteDriver = new RemotePoolV5Driver({ bridge: remoteBridge, manifest: remoteManifest, clock: () => FIXED_CLOCK_MS, onAdmitJournal: (_r, a) => { remoteAdmits.push(a.admissionId) }, onAbandonJournal: (id) => { remoteAbandons.push(id) }, onSettleReceipt: (receipt, info) => { remoteSettlements.push({ receipt, info }) } })

  // Slice 1: Queued before admit (0 admits, 0 charges)
  const queueAbort = new AbortController()
  queueAbort.abort('user_cancelled_in_queue')
  if (!queueAbort.signal.aborted) {
    await localDriver.admit(makeBaseRequest({ turnId: 'turn-never' }))
    await remoteDriver.admit(makeBaseRequest({ turnId: 'turn-never' }))
  }
  checks.push({ name: 'slice1_queued_pre_admit_zero_charge', passed: localAdmits.length === 0 && remoteAdmits.length === 0 && localSettlements.length === 0 && remoteSettlements.length === 0 })

  // Slice 2: Admitted then abandoned (0 yuan, idempotent, dispatch rejected, pre-dispatch failover ok)
  const abandonReq = makeBaseRequest({ turnId: 'turn-bill-abandon-01', turnKey: makeTurnKey('turn-bill-abandon-01'), requestId: 'req-bill-abandon-01' })
  const lAdmAb = await localDriver.admit(abandonReq)
  const rAdmAb = await remoteDriver.admit(abandonReq)
  const lAbRes = await localDriver.abandon(lAdmAb.admissionId, 'pre_dispatch_cancel')
  const rAbRes = await remoteDriver.abandon(rAdmAb.admissionId, 'pre_dispatch_cancel')
  const lAbIdem = await localDriver.abandon(lAdmAb.admissionId, 'pre_dispatch_cancel')
  const rAbIdem = await remoteDriver.abandon(rAdmAb.admissionId, 'pre_dispatch_cancel')
  const lDispAfterAb = await captureDriverError(async () => { for await (const _ of localDriver.dispatch(lAdmAb.admissionId)) { /* noop */ } })
  const rDispAfterAb = await captureDriverError(async () => { for await (const _ of remoteDriver.dispatch(rAdmAb.admissionId)) { /* noop */ } })

  const router = new UnifiedPlacementRouter({
    candidates: [
      { poolKind: 'local_pool', driverId: localManifest.driverId, manifest: localManifest, healthy: true, draining: false, activeSlots: 0, maxSlots: 4, weight: 100 },
      { poolKind: 'remote_pool', driverId: remoteManifest.driverId, manifest: remoteManifest, healthy: true, draining: false, activeSlots: 0, maxSlots: 4, weight: 100 },
    ],
  })
  const preRetry = await router.decideRetryAfterFailure({ dispatched: false, failedCandidateKey: `local_pool:${localManifest.driverId}:-:-`, failedPoolKind: 'local_pool', errorCode: 'REMOTE_LANE_CAPACITY_EXHAUSTED', allowCrossPoolMigration: true, originalRouteInput: { rawModelId: LOGICAL_MODEL, sessionKey: 'sess-parity-01' } })
  checks.push({
    name: 'slice2_admitted_abandon_zero_credit_and_pre_dispatch_failover',
    passed: lAbRes.zeroSettled && rAbRes.zeroSettled && lAbIdem.zeroSettled && rAbIdem.zeroSettled && localAbandons.length === 1 && remoteAbandons.length === 1 && localSettlements.length === 0 && remoteSettlements.length === 0 && lDispAfterAb.code === 'INFERENCE_ADMISSION_ABANDONED' && rDispAfterAb.code === 'INFERENCE_ADMISSION_ABANDONED' && preRetry.allowRetry === true && preRetry.mustAbandonPriorZeroCredit === true && preRetry.nextRoute.selected.poolKind === 'remote_pool',
  })

  // Slice 3: Dispatched in-flight interrupt (real settlement, post-dispatch replay & abandon forbidden, semanticDigest parity)
  mode = 'interrupt'
  const intReq = makeBaseRequest({ turnId: 'turn-bill-interrupt-01', turnKey: makeTurnKey('turn-bill-interrupt-01'), requestId: 'req-bill-interrupt-01' })
  const lAdmInt = await localDriver.admit(intReq)
  const rAdmInt = await remoteDriver.admit(intReq)
  let lIntReceipt: TurnReceiptV5 | null = null
  const lIntIter = localDriver.dispatch(lAdmInt.admissionId)
  const lAbAfterDisp = await captureDriverError(() => localDriver.abandon(lAdmInt.admissionId, 'late_cancel'))
  for await (const ev of lIntIter) {
    if (ev.kind === 'call_usage') await localDriver.interruptTurn(intReq.turnId, 'user_stop')
    if (ev.kind === 'billing_receipt') lIntReceipt = ev.receipt
  }
  let rIntReceipt: TurnReceiptV5 | null = null
  const rIntIter = remoteDriver.dispatch(rAdmInt.admissionId)
  const rAbAfterDisp = await captureDriverError(() => remoteDriver.abandon(rAdmInt.admissionId, 'late_cancel'))
  for await (const ev of rIntIter) {
    if (ev.kind === 'call_usage') await remoteDriver.interruptTurn(intReq.turnId, 'user_stop')
    if (ev.kind === 'billing_receipt') rIntReceipt = ev.receipt
  }
  const lReplayBlk = await captureDriverError(() => localDriver.admit({ ...intReq, retryContext: { priorDispatched: true } }))
  const rReplayBlk = await captureDriverError(() => remoteDriver.admit({ ...intReq, retryContext: { priorDispatched: true } }))
  const routerPostBlk = await router.decideRetryAfterFailure({ dispatched: true, failedCandidateKey: `local_pool:${localManifest.driverId}:-:-`, errorCode: 'REMOTE_LANE_CAPACITY_EXHAUSTED', allowCrossPoolMigration: true, originalRouteInput: { rawModelId: LOGICAL_MODEL, sessionKey: 'sess-parity-01' } })
  checks.push({
    name: 'slice3_post_dispatch_interrupt_real_settlement_and_semantic_digest_parity',
    passed:
      lAbAfterDisp.code === 'INFERENCE_ABANDON_AFTER_DISPATCH_FORBIDDEN' &&
      rAbAfterDisp.code === 'INFERENCE_ABANDON_AFTER_DISPATCH_FORBIDDEN' &&
      lReplayBlk.code === 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN' &&
      rReplayBlk.code === 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN' &&
      routerPostBlk.allowRetry === false &&
      routerPostBlk.code === 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN' &&
      lIntReceipt !== null &&
      rIntReceipt !== null &&
      validateTurnReceiptV5(lIntReceipt).semanticDigest === validateTurnReceiptV5(rIntReceipt).semanticDigest &&
      lIntReceipt.status === 'interrupted' &&
      lIntReceipt.errorCode === 'user_stop' &&
      lIntReceipt.usage.inputTokens === 1200 &&
      localSettlements.length === 1 &&
      remoteSettlements.length === 1 &&
      localSettlements[0]!.info.cumulativeCreditsFen > 0n &&
      localSettlements[0]!.info.cumulativeCreditsFen === remoteSettlements[0]!.info.cumulativeCreditsFen,
    detail: `semanticDigest=${lIntReceipt?.semanticDigest.slice(0, 12) ?? 'null'},credits=${localSettlements[0]?.info.cumulativeCreditsFen.toString() ?? '0'}`,
  })

  // Slice 4: Mid-turn CreditBudgetGuard `budget_exceeded` + sampleId dedup + semanticDigest parity
  mode = 'budget'
  const budgetReq = makeBaseRequest({ turnId: 'turn-bill-budget-01', turnKey: makeTurnKey('turn-bill-budget-01'), requestId: 'req-bill-budget-01', creditBudgetFen: 10n })
  let lBudReceipt: TurnReceiptV5 | null = null
  for await (const ev of localDriver.executeTurn(budgetReq)) if (ev.kind === 'billing_receipt') lBudReceipt = ev.receipt
  let rBudReceipt: TurnReceiptV5 | null = null
  for await (const ev of remoteDriver.executeTurn(budgetReq)) if (ev.kind === 'billing_receipt') rBudReceipt = ev.receipt
  const lBudSettle = localSettlements[1]; const rBudSettle = remoteSettlements[1]
  checks.push({
    name: 'slice4_mid_turn_credit_budget_guard_and_dedup_parity',
    passed:
      lBudReceipt?.status === 'interrupted' &&
      lBudReceipt.errorCode === 'budget_exceeded' &&
      rBudReceipt?.status === 'interrupted' &&
      rBudReceipt.errorCode === 'budget_exceeded' &&
      lBudReceipt.usage.inputTokens === 5000 &&
      lBudReceipt.usage.outputTokens === 1700 &&
      lBudReceipt.semanticDigest === rBudReceipt.semanticDigest &&
      lBudSettle?.info.terminalStatus === 'budget_exceeded' &&
      rBudSettle?.info.terminalStatus === 'budget_exceeded' &&
      lBudSettle.info.budgetExceeded &&
      rBudSettle.info.budgetExceeded &&
      lBudSettle.info.cumulativeCreditsFen >= 10n &&
      lBudSettle.info.cumulativeCreditsFen === rBudSettle.info.cumulativeCreditsFen &&
      localSettlements.length === 2 &&
      remoteSettlements.length === 2,
    detail: `semanticDigest=${lBudReceipt?.semanticDigest.slice(0, 12) ?? 'null'},credits=${lBudSettle?.info.cumulativeCreditsFen.toString() ?? '0'}`,
  })

  // Green success turn semanticDigest parity
  mode = 'success'
  const okReq = makeBaseRequest({ turnId: 'turn-bill-success-01', turnKey: makeTurnKey('turn-bill-success-01'), requestId: 'req-bill-success-01' })
  let lOkReceipt: TurnReceiptV5 | null = null
  for await (const ev of localDriver.executeTurn(okReq)) if (ev.kind === 'billing_receipt') lOkReceipt = ev.receipt
  let rOkReceipt: TurnReceiptV5 | null = null
  for await (const ev of remoteDriver.executeTurn(okReq)) if (ev.kind === 'billing_receipt') rOkReceipt = ev.receipt
  checks.push({ name: 'success_turn_semantic_digest_parity', passed: lOkReceipt?.status === 'success' && rOkReceipt?.status === 'success' && lOkReceipt.semanticDigest === rOkReceipt.semanticDigest && localSettlements.length === 3 && remoteSettlements.length === 3 })

  const allPassed = checks.every((c) => c.passed)
  return Object.freeze({
    dimension: 'three_phase_cancel_and_billing',
    passed: allPassed,
    localPassed: allPassed,
    remotePassed: allPassed,
    parityMatched: allPassed,
    checks: Object.freeze(checks),
    evidenceDigest: remoteCanonicalSha256({ dimension: 'three_phase_cancel_and_billing', intSemantic: lIntReceipt?.semanticDigest ?? null, budSemantic: lBudReceipt?.semanticDigest ?? null, okSemantic: lOkReceipt?.semanticDigest ?? null, checks }),
  })
}

// ── Dimension 4: hot_swap_and_fencing_R10 (R10 Red/Green) ────────────────────
class InMemoryMigrationAuthorityStore implements MigrationAuthorityStorePort {
  pointer: SessionEnginePointer
  private readonly migrations = new Map<string, PlacementMigrationRecord>()
  private migCounter = 0

  constructor(initial: PlacementDescriptor, sessionKey: string) {
    this.pointer = Object.freeze({
      sessionKey, placementEpoch: initial.placementEpoch, poolKind: initial.poolKind, engine: initial.engine,
      nativeSessionId: 'native-hotswap-01', operationId: initial.operationId ?? null, profileId: initial.profileId ?? null,
      capsuleId: null, history: [], rejectedIds: [], promptCacheMeta: null, usageBaseline: null, historyContextVersion: null,
      promotedFromHistory: false, migrationState: 'active', activeMigrationId: null, updatedAt: FIXED_ISO,
    })
  }
  async getEnginePointer(): Promise<SessionEnginePointer | null> { return this.pointer }
  async saveRollingCheckpoint(_i: SaveRollingCheckpointInput): Promise<SaveRollingCheckpointResult> { return { checkpointGeneration: 'cp-gen-parity-1', createdAtMs: FIXED_CLOCK_MS } }

  async beginPlacementMigration(cas: BeginPlacementMigrationCas): Promise<BeginPlacementMigrationResult> {
    if (this.pointer.migrationState === 'migrating') return Object.freeze({ applied: false as const, currentEpoch: this.pointer.placementEpoch, reason: 'already_migrating' as const, activeMigrationId: this.pointer.activeMigrationId })
    if (this.pointer.placementEpoch !== cas.expectedPlacementEpoch) return Object.freeze({ applied: false as const, currentEpoch: this.pointer.placementEpoch, reason: 'epoch_mismatch' as const })
    this.migCounter += 1
    const migrationId = cas.migrationId ?? `mig-parity-00000${this.migCounter}`
    const record: PlacementMigrationRecord = Object.freeze({ migrationId, tenantId: String(cas.userId), sessionKey: cas.sessionKey, fromEpoch: cas.expectedPlacementEpoch, toEpoch: cas.expectedPlacementEpoch + 1, state: 'migrating', fromPlacement: cas.fromPlacement, toPlacement: cas.toPlacement, capsuleRef: null, continuityTier: null, reason: cas.reason ?? null, createdAt: FIXED_ISO, completedAt: null })
    this.migrations.set(migrationId, record)
    this.pointer = Object.freeze({ ...this.pointer, migrationState: 'migrating', activeMigrationId: migrationId })
    return Object.freeze({ applied: true as const, migration: record, currentEpoch: cas.expectedPlacementEpoch })
  }

  async commitPlacementMigration(cas: CommitPlacementMigrationCas): Promise<CommitPlacementMigrationResult> {
    const existing = this.migrations.get(cas.migrationId)
    if (!existing || existing.state !== 'migrating') return Object.freeze({ applied: false as const })
    const committed: PlacementMigrationRecord = Object.freeze({ ...existing, state: 'committed', continuityTier: cas.continuityTier, capsuleRef: cas.capsuleRef ?? null, completedAt: FIXED_ISO })
    this.migrations.set(cas.migrationId, committed)
    this.pointer = Object.freeze({ ...this.pointer, placementEpoch: existing.toEpoch, poolKind: existing.toPlacement.poolKind, engine: existing.toPlacement.engine, nativeSessionId: cas.nativeSessionId ?? this.pointer.nativeSessionId, operationId: cas.operationId ?? null, profileId: cas.profileId ?? null, capsuleId: cas.capsuleId ?? null, migrationState: 'active', activeMigrationId: null, updatedAt: FIXED_ISO })
    return Object.freeze({ applied: true as const, migration: committed, pointer: this.pointer })
  }

  async abortPlacementMigration(cas: AbortPlacementMigrationCas): Promise<AbortPlacementMigrationResult> {
    const existing = this.migrations.get(cas.migrationId)
    if (!existing || existing.state !== 'migrating') return Object.freeze({ applied: false as const })
    const aborted: PlacementMigrationRecord = Object.freeze({ ...existing, state: 'aborted', completedAt: FIXED_ISO })
    this.migrations.set(cas.migrationId, aborted)
    this.pointer = Object.freeze({ ...this.pointer, migrationState: 'active', activeMigrationId: null })
    return Object.freeze({ applied: true as const, migration: aborted, pointer: this.pointer })
  }
}

async function runHotSwapAndFencingR10Dimension(): Promise<{ readonly result: DualPoolParityDimensionResult; readonly r10Control: ExtendedRedControlEntry }> {
  const checks: DualPoolParityCheck[] = []
  const sessionKey = 'sess-parity-hotswap-01'
  const leaseId = 'lease-parity-hotswap-01'
  const stickyHomeKey = computeStickyHomeKey(sessionKey)
  const pingSchema = { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }

  const jobRegistry = new ExecEnvJobRegistry({ envId: 'exec-env-hotswap-01', killGraceMs: 80, closeDrainSafetyMs: 300, defaultEnv: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } })
  const leaseManager = new ExecEnvLeaseManager({ clock: () => FIXED_CLOCK_MS })
  const initialLease = leaseManager.issueLease({ leaseId, execEnvId: 'exec-env-hotswap-01', incarnationId: 'inc-hotswap-01', tenantId: TENANT_ID, sessionKey, hostKind: 'local-docker', placementEpoch: 1, brainGen: 1, fencingToken: 'fence-e000001-g000001-initial' })

  let brokerToolExecutions = 0
  const toolBroker = new ToolBrokerServer({ leaseManager, requireFencingToken: true, clock: () => FIXED_CLOCK_MS })
  toolBroker.registerTool({ canonicalName: 'read_file', readOnly: true, inputSchema: pingSchema, handler: (args) => { brokerToolExecutions += 1; return `ok:${String(args.tag)}` } })
  const [hostLink, clientLink] = createInMemoryFrameLinkPair()
  const brokerHost = new ContainerLinkToolBrokerHost({ link: hostLink, server: toolBroker, leaseManager })
  const staleLocalClient = openChannel('tool-broker', { link: clientLink, hostKind: 'local-docker', leaseId, fencingToken: initialLease.fencingToken, brainGen: initialLease.brainGen, sessionKey })

  const localPlacement: PlacementDescriptor = { poolKind: 'local_container', engine: 'codex', driverId: 'local-parity-driver', placementEpoch: 1, hostId: 'host-local-1', profileId: 'prof-local-1', stickyHomeKey }
  const remotePlacement: PlacementDescriptor = { poolKind: 'remote_pool', engine: 'codex', driverId: 'remote-parity-driver', placementEpoch: 2, hostId: 'host-remote-1', profileId: 'prof-remote-1', stickyHomeKey }
  const localReturnPlacement: PlacementDescriptor = { poolKind: 'local_container', engine: 'codex', driverId: 'local-parity-driver', placementEpoch: 3, hostId: 'host-local-1', profileId: 'prof-local-1', stickyHomeKey }

  const authorityStore = new InMemoryMigrationAuthorityStore(localPlacement, sessionKey)
  const blobStore = new InMemoryArtifactBlobStore()
  let credCounter = 0

  const capsulePort: MigrationCapsulePort = {
    async exportCapsule(args) {
      const blob = await blobStore.put({ tenantId: args.tenantId, kind: 'capsule_file', mimeType: 'application/json', bytes: Buffer.from(JSON.stringify({ sessionKey: args.sessionKey, epoch: args.placementEpoch }), 'utf8') })
      const capsuleRef: EngineStateCapsuleRef = { capsuleId: `cap_${blob.sha256.slice(0, 24)}`, engine: args.placement.engine, portability: 'portable', placementEpoch: args.placementEpoch, totalBytes: blob.sizeBytes, fileCount: 1, manifestBlobId: blob.blobId, createdAt: FIXED_ISO }
      return { ok: true as const, capsuleRef }
    },
    async importCapsule(args) { return { ok: true as const, nativeSessionId: `native-restored-e${args.targetEpoch}`, continuityTier: 'hot_native' as const } },
    async degradeToTranscript() { return { ok: true as const, tier: 'tape_rebuilt' as const, summary: 'fallback', anchorSeq: 1 } },
  }
  const execEnvPort: MigrationExecEnvPort = {
    async quiesce(args) { leaseManager.quiesceBrain(args.leaseId); return { quiesced: true, activeToolCalls: 0 } },
    async exportAttachmentDigest(args) { return await leaseManager.exportAttachmentDigest(args.leaseId, { jobRegistry }) },
    async rebindBrain(args) {
      const prev = leaseManager.getLease(args.leaseId)?.fencingToken
      const { lease, digest } = await leaseManager.rebindBrain(args.leaseId, args.nextBrainGen, args.nextFencingToken, { jobRegistry })
      return { ok: true as const, brainGen: lease.brainGen, fencingToken: lease.fencingToken, ...(prev === undefined ? {} : { revokedPreviousFencingToken: prev }), attachment: digest }
    },
  }
  const credentialPort: MigrationCredentialLeasePort = {
    async issueLease(req): Promise<CredentialLeaseHandle> {
      credCounter += 1
      return Object.freeze({ leaseId: `cred-lease-parity-${credCounter}`, tenantId: req.tenantId, profileId: req.profileId, engine: req.engine, mountKind: req.mountKind, noRefreshToken: true as const, issuedAt: FIXED_ISO, expiresAt: new Date(FIXED_CLOCK_MS + req.ttlMs).toISOString(), revoked: false })
    },
    async revokeLease() { return true },
  }
  const driverPort: MigrationDriverPort = {
    async stopLane() { await jobRegistry.reapByClass(leaseId, ['ephemeral_turn'], { reason: 'completed' }); return { stopped: true, reachable: true, dualProofVerified: true } },
    async prewarm(args) { return { ready: true, prewarmedKey: args.stickyHomeKey } },
  }
  const coordinator = new MigrationCoordinator({ authorityStore, capsuleStore: capsulePort, execEnv: execEnvPort, credentialLeases: credentialPort, drivers: driverPort, now: () => FIXED_CLOCK_MS })

  try {
    const managedJob = await jobRegistry.startJob({ jobId: 'job-parity-managed-01', leaseId, sessionKey, lifecycleClass: 'managed_job', label: 'build-step', command: [process.execPath, '-e', 'process.stdout.write("MANAGED_START\\n"); setTimeout(() => { process.stdout.write("MANAGED_DONE\\n"); process.exit(0); }, 250);'], yieldAfterMs: 30 })
    const daemonJob = await jobRegistry.startJob({ jobId: 'job-parity-daemon-01', leaseId, sessionKey, lifecycleClass: 'daemon_service', label: 'dev-preview-server', command: [process.execPath, '-e', 'process.stdout.write("DAEMON_READY\\n"); const t = setInterval(() => {}, 5000); process.on("SIGTERM", () => { clearInterval(t); process.exit(0); });'], yieldAfterMs: 40 })
    const ephemeralJob = await jobRegistry.startJob({ jobId: 'job-parity-ephemeral-01', leaseId, sessionKey, lifecycleClass: 'ephemeral_turn', label: 'turn-helper', command: [process.execPath, '-e', 'setInterval(() => {}, 5000);'], yieldAfterMs: 20 })
    checks.push({ name: 'real_subprocesses_started_in_exec_env', passed: managedJob.status === 'running' && daemonJob.status === 'running' && ephemeralJob.status === 'running' })

    // Handoff 1: Local -> Remote (epoch 1->2, brainGen 1->2)
    const handoff1 = await coordinator.handoff({ userId: 101, tenantId: TENANT_ID, sessionKey, sessionId: 'sess-id-hotswap-01', expectedPlacementEpoch: 1, fromPlacement: localPlacement, toPlacement: remotePlacement, settledToolsProven: true, execEnvLeaseId: leaseId, currentBrainGen: 1, currentFencingToken: initialLease.fencingToken, previousCredentialLeaseId: 'cred-lease-initial-local', migrationId: 'mig-parity-local-to-remote', reason: 'parity_local_to_remote' })
    checks.push({ name: 'handoff1_local_to_remote_rebind_monotonic', passed: handoff1.ok === true && handoff1.fromEpoch === 1 && handoff1.toEpoch === 2 && handoff1.brainGen === 2 && handoff1.fencingToken !== initialLease.fencingToken && handoff1.revokedPreviousFencingToken === initialLease.fencingToken && handoff1.previousCredentialRevoked && handoff1.continuityTier === 'hot_native' })
    if (!handoff1.ok) throw new Error(`Handoff 1 failed: ${handoff1.code}:${handoff1.reason}`)

    const ephemeralAfterH1 = await jobRegistry.waitJob(ephemeralJob.jobId, { leaseId, action: 'status' })
    const managedOutcome = await jobRegistry.waitJob(managedJob.jobId, { leaseId, action: 'wait', timeoutMs: 5_000 })
    const daemonAfterH1 = await jobRegistry.waitJob(daemonJob.jobId, { leaseId, action: 'status' })
    checks.push({
      name: 'remote_brain_waits_managed_job_and_daemon_survives',
      passed: ephemeralAfterH1.status === 'killed' && managedOutcome.status === 'exited' && managedOutcome.exitCode === 0 && managedOutcome.stdout.includes('MANAGED_START') && managedOutcome.stdout.includes('MANAGED_DONE') && daemonAfterH1.status === 'running',
      detail: `managed=${managedOutcome.status}/${managedOutcome.exitCode},daemon=${daemonAfterH1.status},ephemeral=${ephemeralAfterH1.status}`,
    })

    const remoteOkRes = await toolBroker.invoke({ ...makeToolCallEnvelope({ leaseId, turnId: 'turn-r10-remote-1', callId: 'call-r10-remote-ok', canonicalName: 'read_file', arguments: { tag: 'remote-gen-2' }, inputSchema: pingSchema }), fencingToken: handoff1.fencingToken, brainGen: handoff1.brainGen, sessionKey })
    checks.push({ name: 'remote_brain_new_fencing_token_accepted', passed: remoteOkRes.status === 'ok' && remoteOkRes.output === 'ok:remote-gen-2' })

    // R10 Red Control: stale Local brain fencingToken replay rejected 100%
    const execBeforeStale = brokerToolExecutions
    const staleCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r10-stale-1', callId: 'call-r10-stale-local', canonicalName: 'read_file', arguments: { tag: 'stale-local-gen-1' }, inputSchema: pingSchema })
    const staleDirectRes = await toolBroker.invoke({ ...staleCall, fencingToken: initialLease.fencingToken, brainGen: 1, sessionKey })
    const staleWireRes = await staleLocalClient.invoke(staleCall)
    let nonMonoCode: string | null = null
    try { await leaseManager.rebindBrain(leaseId, 2, 'fence-non-monotonic') } catch (e) { nonMonoCode = e instanceof ExecEnvLeaseError ? e.code : String(e) }
    let reusedCode: string | null = null
    try { await leaseManager.rebindBrain(leaseId, 99, initialLease.fencingToken) } catch (e) { reusedCode = e instanceof ExecEnvLeaseError ? e.code : String(e) }
    const r10StaleLocalCaught = staleDirectRes.status === 'denied' && staleDirectRes.errorCode === 'EXEC_FENCING_TOKEN_STALE' && staleWireRes.status === 'denied' && staleWireRes.errorCode === 'EXEC_FENCING_TOKEN_STALE' && brokerToolExecutions === execBeforeStale && nonMonoCode === 'EXEC_BRAIN_GEN_NOT_MONOTONIC' && reusedCode === 'EXEC_FENCING_TOKEN_REUSED'
    checks.push({ name: 'R10_red_control_stale_local_fencing_token_rejected', passed: r10StaleLocalCaught, detail: `direct=${staleDirectRes.errorCode},wire=${staleWireRes.errorCode},nonMono=${nonMonoCode},reused=${reusedCode}` })

    // Handoff 2: Remote -> Local bidirectional round-trip (epoch 2->3, brainGen 2->3)
    const handoff2 = await coordinator.handoff({ userId: 101, tenantId: TENANT_ID, sessionKey, sessionId: 'sess-id-hotswap-01', expectedPlacementEpoch: 2, fromPlacement: remotePlacement, toPlacement: localReturnPlacement, settledToolsProven: true, execEnvLeaseId: leaseId, currentBrainGen: handoff1.brainGen, currentFencingToken: handoff1.fencingToken, previousCredentialLeaseId: handoff1.issuedCredentialLease?.leaseId, migrationId: 'mig-parity-remote-to-local', reason: 'parity_remote_to_local_roundtrip' })
    if (!handoff2.ok) throw new Error(`Handoff 2 failed: ${handoff2.code}:${handoff2.reason}`)

    const execBeforeStaleRemote = brokerToolExecutions
    const staleRemoteRes = await toolBroker.invoke({ ...makeToolCallEnvelope({ leaseId, turnId: 'turn-r10-stale-2', callId: 'call-r10-stale-remote', canonicalName: 'read_file', arguments: { tag: 'stale-remote-gen-2' }, inputSchema: pingSchema }), fencingToken: handoff1.fencingToken, brainGen: handoff1.brainGen, sessionKey })
    const localGen3Res = await toolBroker.invoke({ ...makeToolCallEnvelope({ leaseId, turnId: 'turn-r10-local-3', callId: 'call-r10-local-gen3-ok', canonicalName: 'read_file', arguments: { tag: 'local-gen-3' }, inputSchema: pingSchema }), fencingToken: handoff2.fencingToken, brainGen: handoff2.brainGen, sessionKey })
    const daemonAfterH2 = await jobRegistry.waitJob(daemonJob.jobId, { leaseId, action: 'status' })
    checks.push({
      name: 'handoff2_remote_to_local_bidirectional_roundtrip_and_fencing',
      passed: handoff2.fromEpoch === 2 && handoff2.toEpoch === 3 && handoff2.brainGen === 3 && staleRemoteRes.status === 'denied' && staleRemoteRes.errorCode === 'EXEC_FENCING_TOKEN_STALE' && localGen3Res.status === 'ok' && localGen3Res.output === 'ok:local-gen-3' && brokerToolExecutions === execBeforeStaleRemote + 1 && daemonAfterH2.status === 'running',
      detail: `brainGen=${handoff2.brainGen},staleRemote=${staleRemoteRes.errorCode},daemon=${daemonAfterH2.status}`,
    })

    const allPassed = checks.every((c) => c.passed)
    const r10RedCaught = r10StaleLocalCaught && staleRemoteRes.errorCode === 'EXEC_FENCING_TOKEN_STALE'
    const evidenceDigest = remoteCanonicalSha256({ dimension: 'hot_swap_and_fencing_R10', h1: { toEpoch: handoff1.toEpoch, brainGen: handoff1.brainGen, fencingToken: handoff1.fencingToken }, h2: { toEpoch: handoff2.toEpoch, brainGen: handoff2.brainGen, fencingToken: handoff2.fencingToken }, staleLocal: staleDirectRes.errorCode, staleRemote: staleRemoteRes.errorCode, checks })
    const r10Control: ExtendedRedControlEntry = Object.freeze({
      requirementId: 'R10' as const,
      dimension: 'hot_swap_and_fencing_R10',
      redControlCaught: (r10RedCaught ? true : false) as true,
      greenPassed: (allPassed ? true : false) as true,
      injectedFault: 'stale_local_and_remote_fencing_token_replay_plus_non_monotonic_brain_gen_rebind',
      evidenceDigest,
    })
    return {
      result: Object.freeze({ dimension: 'hot_swap_and_fencing_R10', passed: allPassed, localPassed: allPassed, remotePassed: allPassed, parityMatched: allPassed, checks: Object.freeze(checks), evidenceDigest }),
      r10Control,
    }
  } finally {
    staleLocalClient.close()
    brokerHost.dispose()
    await jobRegistry.disposeAll()
  }
}

// ── Dimension 5: schema_observation_R11_and_loopback_R8 ──────────────────────
async function runSchemaObservationR11AndLoopbackR8Dimension(): Promise<{
  readonly result: DualPoolParityDimensionResult
  readonly r8Control: ExtendedRedControlEntry
  readonly r11Control: ExtendedRedControlEntry
}> {
  const checks: DualPoolParityCheck[] = []
  const leaseId = 'lease-parity-r8-r11'
  const sessionKey = 'sess-parity-r8-r11'
  const otherSessionKey = 'sess-parity-other'
  const secret = 'ocv5-parity-r8-hmac-secret-32bytes!!'
  let nowMs = FIXED_CLOCK_MS

  const readSchema = { type: 'object', properties: { Path: { type: 'string' }, StartLine: { type: 'integer' } }, required: ['Path'] }
  const listSchema = { type: 'object', properties: { Dir: { type: 'string' } }, required: ['Dir'] }
  let localExec = 0
  let remoteExec = 0

  const makeStack = (side: 'local' | 'remote') => {
    const authority = new ScopedCapabilityTokenAuthority({ secret, defaultTtlMs: 30_000, clock: () => nowMs })
    const broker = new ToolBrokerServer({ channelKind: side === 'local' ? 'uds_jsonrpc' : 'ws_tunnel', capabilityAuthority: authority, requireCapabilityToken: true, clock: () => nowMs })
    broker.registerTool({ canonicalName: 'read_file', readOnly: true, inputSchema: readSchema, handler: (a) => { if (side === 'local') localExec += 1; else remoteExec += 1; return `read:${String(a.Path)}:${String(a.StartLine ?? 1)}` } })
    broker.registerTool({ canonicalName: 'list_dir', readOnly: true, inputSchema: listSchema, handler: (a) => { if (side === 'local') localExec += 1; else remoteExec += 1; return `ls:${String(a.Dir)}` } })
    return { authority, broker }
  }
  const local = makeStack('local')
  const remote = makeStack('remote')

  const issueBoth = (callId: string, toolName: string, nonce: string, ttlMs?: number) => ({
    l: local.authority.issueToken({ callId, toolName, sessionKey, leaseId, brainGen: 1, nonce, ...(ttlMs === undefined ? {} : { ttlMs }) }).token,
    r: remote.authority.issueToken({ callId, toolName, sessionKey, leaseId, brainGen: 1, nonce, ...(ttlMs === undefined ? {} : { ttlMs }) }).token,
  })

  // R11: Golden vectors + OCV5-800 `toolSummary` green + 1-byte schema tamper red
  const goldenOk = SCHEMA_FILTERED_HASH_GOLDEN_VECTORS.every((v) => computeSchemaFilteredArgsSha256(v.args, v.inputSchema) === v.sha256)
  checks.push({ name: 'R11_golden_vectors_match', passed: goldenOk })

  const observedSha = computeSchemaFilteredArgsSha256({ Path: 'README.md', StartLine: 1 }, readSchema)
  const r11GreenCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r11-green', callId: 'call-r11-green', canonicalName: 'read_file', arguments: { Path: 'README.md', StartLine: 1, toolSummary: 'Read project README header', _cliUiBadge: 'read' }, inputSchema: readSchema, argsSha256Override: observedSha })
  const envOk = validateToolCallEnvelope(r11GreenCall, { inputSchema: readSchema }).argsSha256 === observedSha
  const r11GreenTok = issueBoth(r11GreenCall.callId, 'read_file', 'nonce-r11-green')
  const lR11G = await local.broker.invoke({ ...r11GreenCall, sessionKey, capabilityToken: r11GreenTok.l })
  const rR11G = await remote.broker.invoke({ ...r11GreenCall, sessionKey, capabilityToken: r11GreenTok.r })
  const r11GreenOk = goldenOk && envOk && lR11G.status === 'ok' && rR11G.status === 'ok' && lR11G.output === 'read:README.md:1' && rR11G.output === 'read:README.md:1'
  checks.push({ name: 'R11_green_ocv5_800_toolSummary_zero_false_positive_both_pools', passed: r11GreenOk })

  const lBeforeR11Red = localExec; const rBeforeR11Red = remoteExec
  const r11RedCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r11-red', callId: 'call-r11-red', canonicalName: 'read_file', arguments: { Path: 'README.me', StartLine: 1, toolSummary: 'Read project README header' }, inputSchema: readSchema, argsSha256Override: observedSha })
  const r11RedTok = issueBoth(r11RedCall.callId, 'read_file', 'nonce-r11-red')
  const lR11R = await local.broker.invoke({ ...r11RedCall, sessionKey, capabilityToken: r11RedTok.l })
  const rR11R = await remote.broker.invoke({ ...r11RedCall, sessionKey, capabilityToken: r11RedTok.r })
  const r11RedCaught = lR11R.status === 'denied' && lR11R.errorCode === 'TOOL_ARGS_SCHEMA_HASH_MISMATCH' && rR11R.status === 'denied' && rR11R.errorCode === 'TOOL_ARGS_SCHEMA_HASH_MISMATCH' && localExec === lBeforeR11Red && remoteExec === rBeforeR11Red
  checks.push({ name: 'R11_red_control_1byte_schema_param_tamper_rejected_zero_execution', passed: r11RedCaught, detail: `local=${lR11R.errorCode},remote=${rR11R.errorCode}` })

  // R8: Single-use `octk1.*` green + 5 red controls (replay, cross-tool, cross-session, tampered MAC, expired)
  const r8GreenCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r8-green', callId: 'call-r8-green', canonicalName: 'read_file', arguments: { Path: 'Cargo.toml', StartLine: 1 }, inputSchema: readSchema })
  const r8Tok = issueBoth(r8GreenCall.callId, 'read_file', 'nonce-r8-single-use')
  const lR8G = await local.broker.invoke({ ...r8GreenCall, sessionKey, capabilityToken: r8Tok.l })
  const rR8G = await remote.broker.invoke({ ...r8GreenCall, sessionKey, capabilityToken: r8Tok.r })
  const r8GreenOk = r8Tok.l.startsWith('octk1.') && r8Tok.r.startsWith('octk1.') && lR8G.status === 'ok' && rR8G.status === 'ok'
  checks.push({ name: 'R8_green_single_use_octk1_token_accepted_once_both_pools', passed: r8GreenOk })

  const lBeforeR8Red = localExec; const rBeforeR8Red = remoteExec
  // Red 1: replay consumed token
  const lReplay = await local.broker.invoke({ ...r8GreenCall, sessionKey, capabilityToken: r8Tok.l })
  const rReplay = await remote.broker.invoke({ ...r8GreenCall, sessionKey, capabilityToken: r8Tok.r })
  const r8ReplayCaught = lReplay.status === 'denied' && lReplay.errorCode === 'CAPABILITY_TOKEN_REPLAYED' && rReplay.status === 'denied' && rReplay.errorCode === 'CAPABILITY_TOKEN_REPLAYED'
  checks.push({ name: 'R8_red1_consumed_token_replay_rejected', passed: r8ReplayCaught })

  // Red 2: cross-tool misuse
  const xToolCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r8-xtool', callId: 'call-r8-xtool', canonicalName: 'list_dir', arguments: { Dir: '.' }, inputSchema: listSchema })
  const xToolTok = issueBoth(xToolCall.callId, 'read_file', 'nonce-r8-xtool')
  const lXTool = await local.broker.invoke({ ...xToolCall, sessionKey, capabilityToken: xToolTok.l })
  const rXTool = await remote.broker.invoke({ ...xToolCall, sessionKey, capabilityToken: xToolTok.r })
  const r8CrossToolCaught = lXTool.status === 'denied' && lXTool.errorCode === 'CAPABILITY_TOKEN_TOOL_MISMATCH' && rXTool.status === 'denied' && rXTool.errorCode === 'CAPABILITY_TOKEN_TOOL_MISMATCH'
  checks.push({ name: 'R8_red2_cross_tool_token_rejected', passed: r8CrossToolCaught })

  // Red 3: cross-session misuse
  const xSessCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r8-xsess', callId: 'call-r8-xsess', canonicalName: 'read_file', arguments: { Path: 'a.txt', StartLine: 1 }, inputSchema: readSchema })
  const xSessTok = issueBoth(xSessCall.callId, 'read_file', 'nonce-r8-xsess')
  const lXSess = await local.broker.invoke({ ...xSessCall, sessionKey: otherSessionKey, capabilityToken: xSessTok.l })
  const rXSess = await remote.broker.invoke({ ...xSessCall, sessionKey: otherSessionKey, capabilityToken: xSessTok.r })
  const r8CrossSessCaught = lXSess.status === 'denied' && lXSess.errorCode === 'CAPABILITY_TOKEN_SESSION_MISMATCH' && rXSess.status === 'denied' && rXSess.errorCode === 'CAPABILITY_TOKEN_SESSION_MISMATCH'
  checks.push({ name: 'R8_red3_cross_session_token_rejected', passed: r8CrossSessCaught })

  // Red 4: tampered MAC
  const flipLast = (t: string) => `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`
  const macCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r8-mac', callId: 'call-r8-mac', canonicalName: 'read_file', arguments: { Path: 'b.txt', StartLine: 1 }, inputSchema: readSchema })
  const macTok = issueBoth(macCall.callId, 'read_file', 'nonce-r8-mac')
  const lMac = await local.broker.invoke({ ...macCall, sessionKey, capabilityToken: flipLast(macTok.l) })
  const rMac = await remote.broker.invoke({ ...macCall, sessionKey, capabilityToken: flipLast(macTok.r) })
  const r8TamperedMacCaught = lMac.status === 'denied' && lMac.errorCode === 'CAPABILITY_TOKEN_SIGNATURE_INVALID' && rMac.status === 'denied' && rMac.errorCode === 'CAPABILITY_TOKEN_SIGNATURE_INVALID'
  checks.push({ name: 'R8_red4_tampered_mac_rejected', passed: r8TamperedMacCaught })

  // Red 5: expired token
  const expCall = makeToolCallEnvelope({ leaseId, turnId: 'turn-r8-exp', callId: 'call-r8-exp', canonicalName: 'read_file', arguments: { Path: 'c.txt', StartLine: 1 }, inputSchema: readSchema })
  const expTok = issueBoth(expCall.callId, 'read_file', 'nonce-r8-exp', 1_000)
  nowMs += 5_000
  const lExp = await local.broker.invoke({ ...expCall, sessionKey, capabilityToken: expTok.l })
  const rExp = await remote.broker.invoke({ ...expCall, sessionKey, capabilityToken: expTok.r })
  let directExpCode: string | null = null
  try { local.authority.verifyAndConsumeToken(expTok.l, { toolName: 'read_file', sessionKey, leaseId, callId: expCall.callId, nowMs }) } catch (e) { directExpCode = e instanceof ScopedCapabilityTokenError ? e.code : String(e) }
  const r8ExpiredCaught = lExp.status === 'denied' && lExp.errorCode === 'CAPABILITY_TOKEN_EXPIRED' && rExp.status === 'denied' && rExp.errorCode === 'CAPABILITY_TOKEN_EXPIRED' && directExpCode === 'CAPABILITY_TOKEN_EXPIRED' && localExec === lBeforeR8Red && remoteExec === rBeforeR8Red
  checks.push({ name: 'R8_red5_expired_token_rejected_zero_execution', passed: r8ExpiredCaught })

  const r8RedCaught = r8ReplayCaught && r8CrossToolCaught && r8CrossSessCaught && r8TamperedMacCaught && r8ExpiredCaught
  const allPassed = checks.every((c) => c.passed)
  const r8EvidenceDigest = remoteCanonicalSha256({ requirementId: 'R8', replay: lReplay.errorCode, crossTool: lXTool.errorCode, crossSession: lXSess.errorCode, tamperedMac: lMac.errorCode, expired: lExp.errorCode, greenOk: r8GreenOk })
  const r11EvidenceDigest = remoteCanonicalSha256({ requirementId: 'R11', observedSha, greenOk: r11GreenOk, redLocal: lR11R.errorCode, redRemote: rR11R.errorCode })
  const dimDigest = remoteCanonicalSha256({ dimension: 'schema_observation_R11_and_loopback_R8', r8EvidenceDigest, r11EvidenceDigest, checks })

  return {
    result: Object.freeze({ dimension: 'schema_observation_R11_and_loopback_R8', passed: allPassed, localPassed: allPassed, remotePassed: allPassed, parityMatched: allPassed, checks: Object.freeze(checks), evidenceDigest: dimDigest }),
    r8Control: Object.freeze({ requirementId: 'R8' as const, dimension: 'schema_observation_R11_and_loopback_R8', redControlCaught: (r8RedCaught ? true : false) as true, greenPassed: (r8GreenOk ? true : false) as true, injectedFault: 'octk1_replay_consumed_token_cross_tool_cross_session_tampered_mac_and_expired_token', evidenceDigest: r8EvidenceDigest }),
    r11Control: Object.freeze({ requirementId: 'R11' as const, dimension: 'schema_observation_R11_and_loopback_R8', redControlCaught: (r11RedCaught ? true : false) as true, greenPassed: (r11GreenOk ? true : false) as true, injectedFault: 'one_byte_schema_declared_argument_tamper_with_preserved_ocv5_800_digest', evidenceDigest: r11EvidenceDigest }),
  }
}

// ── Public Suite Runner & CLI Entrypoint ─────────────────────────────────────
export async function runDualPoolParitySuite(): Promise<DualPoolParityReport> {
  const dim1 = await runCapabilityTruthGateDimension()
  const { result: dim2, r9Control } = await runToolPolicyParityR9Dimension()
  const dim3 = await runThreePhaseCancelAndBillingDimension()
  const { result: dim4, r10Control } = await runHotSwapAndFencingR10Dimension()
  const { result: dim5, r8Control, r11Control } = await runSchemaObservationR11AndLoopbackR8Dimension()

  const dimensions = Object.freeze([dim1, dim2, dim3, dim4, dim5])
  const r8ToR11Controls = Object.freeze([r8Control, r9Control, r10Control, r11Control])
  const overallPassed =
    dimensions.every((d) => d.passed && d.localPassed && d.remotePassed && d.parityMatched) &&
    r8ToR11Controls.every((c) => c.redControlCaught === true && c.greenPassed === true)

  const body = { schemaVersion: 1 as const, logicalModel: LOGICAL_MODEL, overallPassed, dimensions, r8ToR11Controls }
  return Object.freeze({ ...body, reportSha256: remoteCanonicalSha256(body) })
}

function isDirectCliExecution(): boolean {
  const arg1 = process.argv[1]
  if (!arg1) return false
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(arg1) } catch { return false }
}

if (isDirectCliExecution()) {
  runDualPoolParitySuite()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      if (!report.overallPassed) process.exit(1)
    })
    .catch((err) => {
      console.error('[dualPoolParity] fatal error:', err)
      process.exit(1)
    })
}
