/**
 * OCV5-915 P3-1 — Production-Callable Dual-Pool Parity Conformance Harness.
 *
 * Exercises live `LocalPoolDriver` + live `RemotePoolV5Driver` (through `LiveRemoteV5LaneBridge`)
 * + `GatewayInferencePoolRouter` + `CreditBudgetGuard` + `TurnReceiptV5.semanticDigest` parity
 * in-process with zero external I/O or upstream token spend.
 *
 * Subdomain: `rt-codex-remote` (rank 1). Zero `process.env`, network APIs, `syncIo`,
 * `emptyCatch`, `typeEscape`, `export *`, or engine-literal special cases.
 */
import { EventEmitter } from 'node:events'
import {
  INFERENCE_SERVICE_TIERS,
  PLATFORM_REASONING_EFFORTS,
  authorityEngineToInferenceFamily,
  remoteCanonicalSha256,
  validateTurnReceiptV5,
  verifyDualPoolReceiptParity,
  type AuthorityEngineKind,
  type DualPoolReceiptParityResult,
  type LogicalModelCapability,
  type NormalizedInferenceEvent,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { PartialSnapshot, PhantomSignals, TurnSummary } from '../engine/engineEvents.js'
import {
  DEFAULT_UNIFIED_USAGE_SEMANTICS,
  LocalPoolDriver,
  buildLocalDriverCapabilityManifest,
  type DriverTurnRequest,
} from './localPoolDriver.js'
import {
  GatewayInferencePoolRouter,
  LiveRemoteV5LaneBridge,
} from './livePoolDriverRuntime.js'
import {
  RemotePoolV5Driver,
  buildRemoteDriverCapabilityManifest,
} from './remotePoolV5Adapter.js'

export interface DualPoolParityCheckResult {
  readonly checkId:
    | 'receipt_semantic_digest_parity'
    | 'pre_dispatch_abandon_zero_settled'
    | 'credit_budget_guard_parity'
    | 'capability_superset_fail_closed'
    | 'stop_lane_teardown_parity'
  readonly ok: boolean
  readonly detail: string
}

export interface DualPoolParityConformanceOptions {
  readonly authorityEngine?: AuthorityEngineKind
  readonly logicalModel?: string
  readonly upstreamModel?: string
  readonly tenantId?: string
  readonly sessionKey?: string
  readonly driverVersion?: string
  readonly clock?: () => number
}

export interface DualPoolParityConformanceReport {
  readonly schemaVersion: 5
  readonly ok: boolean
  readonly checkedAt: string
  readonly conformanceDigest: string
  readonly checks: readonly DualPoolParityCheckResult[]
  readonly failedChecks: readonly string[]
  readonly localReceipt: TurnReceiptV5 | null
  readonly remoteReceipt: TurnReceiptV5 | null
  readonly parity: DualPoolReceiptParityResult | null
}

const EMPTY_SNAPSHOT: PartialSnapshot = Object.freeze({
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
  runtimeEvents: [],
})

const CONFORMANCE_PHANTOM: PhantomSignals = Object.freeze({
  apiState: 'called',
  skipReason: null,
})

class ConformanceSyntheticAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId: string
  readonly capabilities: EngineAdapter['capabilities'] = {
    billingMode: 'engine-reported',
    supportsEffort: true,
    resumeKind: 'codex-thread',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    supportsNativeCompact: false,
    multimodalInput: 'native',
  }

  model: string | undefined
  effortLevel: string | undefined = 'medium'
  toolsets: string[] | undefined = undefined
  executionTarget: EngineAdapter['executionTarget'] = { kind: 'local' }
  nativeSessionId: string | null = 'conformance-native-sess-1'
  pendingToolCalls = 0
  isRunning = false
  lastActivityAt = Date.now()

  shutdownCount = 0
  interruptCount = 0
  private activeInterruptCb: ((reason?: 'user' | 'system') => void) | null = null

  constructor(
    engineId: string,
    model: string,
    private readonly mode: 'normal' | 'budget_exhaust',
  ) {
    super()
    this.engineId = engineId
    this.model = model
  }

  async start(): Promise<void> {
    this.isRunning = true
  }

  private makeTurnSummary(
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      totalTokens: number
    },
    opts: { assistantText: string; stopReason: 'aborted' | 'end_turn'; isError: boolean },
  ): TurnSummary {
    return {
      usage: { cost: 0, ...usage },
      assistantText: opts.assistantText,
      thinkingText: '',
      assistantSegments: [],
      thinkingSegments: [],
      tools: [],
      runtimeEvents: [],
      stopReason: opts.stopReason,
      numTurns: 1,
      isError: opts.isError,
      staleResumeId: false,
      phantomSignals: CONFORMANCE_PHANTOM,
    }
  }

  private runBudgetExhaustTurn(params: TurnParams, isInterrupted: () => boolean): TurnSummary {
    const sampleUsage = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150_000,
    }
    // Emit duplicate sampleId twice to prove deduplication parity + trigger budget interrupt.
    params.onEvent({
      kind: 'call_usage',
      call: { callId: 'sample-budget-1', targetIds: ['main'], usage: sampleUsage },
    })
    params.onEvent({
      kind: 'call_usage',
      call: { callId: 'sample-budget-1', targetIds: ['main'], usage: sampleUsage },
    })
    const interrupted = isInterrupted()
    return this.makeTurnSummary(sampleUsage, {
      assistantText: '',
      stopReason: interrupted ? 'aborted' : 'end_turn',
      isError: interrupted,
    })
  }

  private runNormalTurn(params: TurnParams): TurnSummary {
    params.onEvent({
      kind: 'block',
      block: { kind: 'text', text: 'dual-pool-conformance-ok' },
    })
    const usage = {
      inputTokens: 1_200,
      outputTokens: 450,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
      totalTokens: 2_050,
    }
    params.onEvent({
      kind: 'call_usage',
      call: { callId: 'sample-ok-1', targetIds: ['main'], usage },
    })
    params.onEvent({
      kind: 'final',
      meta: { ...usage, cost: 0, stopReason: 'end_turn' },
    })
    return this.makeTurnSummary(usage, {
      assistantText: 'dual-pool-conformance-ok',
      stopReason: 'end_turn',
      isError: false,
    })
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    this.isRunning = true
    let interrupted = false
    let finalized = false

    const summary = new Promise<TurnSummary | null>((resolve) => {
      this.activeInterruptCb = () => {
        interrupted = true
      }
      queueMicrotask(() => {
        const result =
          this.mode === 'budget_exhaust'
            ? this.runBudgetExhaustTurn(params, () => interrupted)
            : this.runNormalTurn(params)
        finalized = true
        this.isRunning = false
        this.activeInterruptCb = null
        resolve(result)
      })
    })

    return {
      submitted: Promise.resolve(),
      summary,
      end: () => {
        interrupted = true
        finalized = true
      },
      getPartialSnapshot: () => ({ ...EMPTY_SNAPSHOT }),
      getPhantomSignals: () => ({ ...CONFORMANCE_PHANTOM }),
      get finalized() {
        return finalized
      },
      get pendingToolCalls() {
        return 0
      },
    }
  }

  interrupt(reason?: 'user' | 'system'): boolean {
    this.interruptCount += 1
    this.activeInterruptCb?.(reason)
    return true
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
    this.isRunning = false
  }

  async waitForOutputDrain(): Promise<void> {
    this.isRunning = false
  }

  clearSessionId(): void {
    this.nativeSessionId = null
  }

  setModel(model: string | undefined): void {
    this.model = model
  }

  setEffortLevel(level: string | undefined): void {
    this.effortLevel = level
  }

  setTraceId(_traceId: string | undefined): void {
    this.lastActivityAt = Date.now()
  }

  async setGoalState(): Promise<void> {
    this.lastActivityAt = Date.now()
  }

  updateConfig(): void {
    this.lastActivityAt = Date.now()
  }

  setToolsets(toolsets: string[] | undefined): void {
    this.toolsets = toolsets
  }

  setExecutionTarget(target: EngineAdapter['executionTarget']): void {
    this.executionTarget = target
  }

  sendPermissionResponse(): boolean {
    return false
  }

  getPartialSnapshot(): PartialSnapshot {
    return { ...EMPTY_SNAPSHOT }
  }

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return null
  }
}

async function collectReceiptFromStream(
  stream: AsyncIterable<NormalizedInferenceEvent>,
): Promise<TurnReceiptV5 | null> {
  let receipt: TurnReceiptV5 | null = null
  for await (const ev of stream) {
    if (ev.kind === 'billing_receipt') {
      receipt = validateTurnReceiptV5(ev.receipt)
    }
  }
  return receipt
}

interface ConformanceContext {
  readonly authorityEngine: AuthorityEngineKind
  readonly logicalModel: string
  readonly upstreamModel: string
  readonly tenantId: string
  readonly sessionKey: string
  readonly fixedNowMs: number
  readonly baseTurnKey: string
  readonly createRouterPair: (mode: 'normal' | 'budget_exhaust') => {
    readonly router: GatewayInferencePoolRouter
    readonly localAdapter: ConformanceSyntheticAdapter
    readonly remoteAdapter: ConformanceSyntheticAdapter
  }
}

function buildConformanceContext(options: DualPoolParityConformanceOptions): ConformanceContext {
  const authorityEngine: AuthorityEngineKind = options.authorityEngine ?? 'codex'
  const engineFamily = authorityEngineToInferenceFamily(authorityEngine)
  const logicalModel = options.logicalModel ?? 'gpt-5.4-pro'
  const upstreamModel = options.upstreamModel ?? logicalModel
  const tenantId = options.tenantId ?? 'tenant-conformance'
  const sessionKey = options.sessionKey ?? 'agent:main:webchat:dm:conformance_parity_1'
  const driverVersion = options.driverVersion ?? '5.0.0'
  const fixedNowMs = options.clock ? options.clock() : Date.parse('2026-11-27T00:00:00.000Z')
  const fixedClock = () => fixedNowMs
  const observedAt = new Date(fixedNowMs).toISOString()

  const cap: LogicalModelCapability = Object.freeze({
    logicalModel,
    upstreamModelId: upstreamModel,
    supportsVision: false,
    supportedEfforts: Object.freeze([...PLATFORM_REASONING_EFFORTS]),
    defaultEffort: 'medium',
    supportedServiceTiers: Object.freeze([...INFERENCE_SERVICE_TIERS]),
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
    contextWindow: 200_000,
  })
  const triplet = Object.freeze({ probed: cap, transport: cap, catalog: cap })

  const localManifest = buildLocalDriverCapabilityManifest({
    poolKind: 'local_pool',
    engineFamily,
    authorityEngine,
    driverId: `local-${engineFamily}`,
    driverVersion,
    observedAt,
    models: [triplet],
  })
  const remoteManifest = buildRemoteDriverCapabilityManifest({
    poolKind: 'remote_pool',
    engineFamily,
    authorityEngine,
    driverId: engineFamily,
    driverVersion,
    observedAt,
    models: [triplet],
  })

  const createRouterPair = (mode: 'normal' | 'budget_exhaust') => {
    const localAdapter = new ConformanceSyntheticAdapter(authorityEngine, upstreamModel, mode)
    const remoteAdapter = new ConformanceSyntheticAdapter(authorityEngine, upstreamModel, mode)
    const remoteBridge = new LiveRemoteV5LaneBridge(remoteAdapter, () => remoteManifest)
    const localDriver = new LocalPoolDriver({
      adapter: localAdapter,
      manifest: localManifest,
      usageSemantics: DEFAULT_UNIFIED_USAGE_SEMANTICS,
      resolveCanonicalModel: () => logicalModel,
      resolveUpstreamModel: () => upstreamModel,
      clock: fixedClock,
    })
    const remoteDriver = new RemotePoolV5Driver({
      bridge: remoteBridge,
      manifest: remoteManifest,
      usageSemantics: DEFAULT_UNIFIED_USAGE_SEMANTICS,
      resolveCanonicalModel: () => logicalModel,
      resolveUpstreamModel: () => upstreamModel,
      clock: fixedClock,
    })
    return {
      router: new GatewayInferencePoolRouter({ localDriver, remoteDriver }),
      localAdapter,
      remoteAdapter,
    }
  }

  const baseTurnKey = remoteCanonicalSha256({
    domain: 'oc-dual-pool-conformance-turn-key',
    logicalModel,
    sessionKey,
  })
  return {
    authorityEngine,
    logicalModel,
    upstreamModel,
    tenantId,
    sessionKey,
    fixedNowMs,
    baseTurnKey,
    createRouterPair,
  }
}

async function checkReceiptSemanticDigestParity(ctx: ConformanceContext): Promise<{
  readonly check: DualPoolParityCheckResult
  readonly localReceipt: TurnReceiptV5 | null
  readonly remoteReceipt: TurnReceiptV5 | null
  readonly parity: DualPoolReceiptParityResult | null
}> {
  let localReceipt: TurnReceiptV5 | null = null
  let remoteReceipt: TurnReceiptV5 | null = null
  try {
    const { router } = ctx.createRouterPair('normal')
    const req: DriverTurnRequest = {
      schemaVersion: 5,
      turnId: 'turn-conformance-parity-1',
      turnKey: ctx.baseTurnKey,
      requestId: 'req-conformance-parity-1',
      tenantId: ctx.tenantId,
      sessionKey: ctx.sessionKey,
      logicalModel: ctx.logicalModel,
      serviceTier: 'fast',
      input: [{ type: 'text', text: 'conformance check' }],
      placementHint: { poolPreference: 'auto', placementEpoch: 1 },
    }
    const localAdm = await router.admit('local_pool', req)
    localReceipt = await collectReceiptFromStream(
      router.dispatch('local_pool', localAdm.admission.admissionId),
    )
    const remoteAdm = await router.admit('remote_pool', req)
    remoteReceipt = await collectReceiptFromStream(
      router.dispatch('remote_pool', remoteAdm.admission.admissionId),
    )
    if (!localReceipt || !remoteReceipt) {
      return {
        localReceipt,
        remoteReceipt,
        parity: null,
        check: {
          checkId: 'receipt_semantic_digest_parity',
          ok: false,
          detail: 'missing_receipt_from_one_or_both_pools',
        },
      }
    }
    router.recordReceipt(localReceipt)
    router.recordReceipt(remoteReceipt)
    const parity = verifyDualPoolReceiptParity(localReceipt, remoteReceipt, {
      expectedLocalPoolKind: 'local_pool',
      expectedRemotePoolKind: 'remote_pool',
    })
    return {
      localReceipt,
      remoteReceipt,
      parity,
      check: {
        checkId: 'receipt_semantic_digest_parity',
        ok: parity.ok,
        detail: parity.ok
          ? `semantic_digest_matched:${parity.localSemanticDigest.slice(0, 16)}`
          : parity.mismatchReasons.join(','),
      },
    }
  } catch (err) {
    return {
      localReceipt,
      remoteReceipt,
      parity: null,
      check: {
        checkId: 'receipt_semantic_digest_parity',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

async function checkPreDispatchAbandonZeroSettled(
  ctx: ConformanceContext,
): Promise<DualPoolParityCheckResult> {
  try {
    const { router } = ctx.createRouterPair('normal')
    let allOk = true
    const details: string[] = []
    for (const poolKind of ['local_pool', 'remote_pool'] as const) {
      const adm = await router.admit(poolKind, {
        schemaVersion: 5,
        turnId: `turn-abandon-${poolKind}`,
        turnKey: ctx.baseTurnKey,
        requestId: `req-abandon-${poolKind}`,
        tenantId: ctx.tenantId,
        sessionKey: ctx.sessionKey,
        logicalModel: ctx.logicalModel,
        serviceTier: 'standard',
        input: [{ type: 'text', text: 'cancel before dispatch' }],
      })
      const abandoned = await router.abandon(poolKind, adm.admission.admissionId, 'pre_start_cancel')
      if (!abandoned.abandoned || !abandoned.zeroSettled) {
        allOk = false
        details.push(`${poolKind}:abandon_not_zero_settled`)
      }
      let rejectedAfterAbandon = false
      try {
        router.dispatch(poolKind, adm.admission.admissionId)
      } catch (dispatchErr) {
        rejectedAfterAbandon =
          dispatchErr instanceof Error &&
          dispatchErr.message.includes('INFERENCE_ADMISSION_ABANDONED')
      }
      if (!rejectedAfterAbandon) {
        allOk = false
        details.push(`${poolKind}:dispatch_after_abandon_not_blocked`)
      }
    }
    return {
      checkId: 'pre_dispatch_abandon_zero_settled',
      ok: allOk,
      detail: allOk ? 'both_pools_zero_settled_and_fenced' : details.join(','),
    }
  } catch (err) {
    return {
      checkId: 'pre_dispatch_abandon_zero_settled',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkCreditBudgetGuardParity(
  ctx: ConformanceContext,
): Promise<DualPoolParityCheckResult> {
  try {
    const { router } = ctx.createRouterPair('budget_exhaust')
    const budgetReq: DriverTurnRequest = {
      schemaVersion: 5,
      turnId: 'turn-conformance-budget-1',
      turnKey: ctx.baseTurnKey,
      requestId: 'req-conformance-budget-1',
      tenantId: ctx.tenantId,
      sessionKey: ctx.sessionKey,
      logicalModel: ctx.logicalModel,
      serviceTier: 'standard',
      creditBudgetFen: 10n,
      input: [{ type: 'text', text: 'trigger budget guard' }],
      placementHint: { poolPreference: 'auto', placementEpoch: 1 },
    }
    const lAdm = await router.admit('local_pool', budgetReq)
    const lRec = await collectReceiptFromStream(
      router.dispatch('local_pool', lAdm.admission.admissionId),
    )
    const rAdm = await router.admit('remote_pool', budgetReq)
    const rRec = await collectReceiptFromStream(
      router.dispatch('remote_pool', rAdm.admission.admissionId),
    )
    const budgetParity =
      lRec && rRec
        ? verifyDualPoolReceiptParity(lRec, rRec, {
            expectedLocalPoolKind: 'local_pool',
            expectedRemotePoolKind: 'remote_pool',
          })
        : null
    const ok =
      Boolean(budgetParity?.ok) &&
      lRec?.status === 'interrupted' &&
      lRec.errorCode === 'budget_exceeded' &&
      rRec?.status === 'interrupted' &&
      rRec.errorCode === 'budget_exceeded'
    return {
      checkId: 'credit_budget_guard_parity',
      ok,
      detail: ok
        ? `budget_exceeded_parity:${budgetParity!.localSemanticDigest.slice(0, 16)}`
        : 'budget_guard_parity_failed',
    }
  } catch (err) {
    return {
      checkId: 'credit_budget_guard_parity',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkCapabilitySupersetFailClosed(
  ctx: ConformanceContext,
): Promise<DualPoolParityCheckResult> {
  try {
    const { router } = ctx.createRouterPair('normal')
    let bothRejected = true
    for (const poolKind of ['local_pool', 'remote_pool'] as const) {
      let caught = false
      try {
        await router.admit(poolKind, {
          schemaVersion: 5,
          turnId: `turn-cap-${poolKind}`,
          turnKey: ctx.baseTurnKey,
          requestId: `req-cap-${poolKind}`,
          tenantId: ctx.tenantId,
          sessionKey: ctx.sessionKey,
          logicalModel: ctx.logicalModel,
          serviceTier: 'standard',
          input: [{ type: 'image_ref', mimeType: 'image/png', uri: 'blob://vision-test' }],
        })
      } catch (capErr) {
        caught = capErr instanceof Error && capErr.message.includes('CAPABILITY_UNSATISFIED')
      }
      if (!caught) bothRejected = false
    }
    return {
      checkId: 'capability_superset_fail_closed',
      ok: bothRejected,
      detail: bothRejected ? 'vision_unsatisfied_rejected_both_pools' : 'capability_gate_bypassed',
    }
  } catch (err) {
    return {
      checkId: 'capability_superset_fail_closed',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkStopLaneTeardownParity(
  ctx: ConformanceContext,
): Promise<DualPoolParityCheckResult> {
  try {
    const { router, localAdapter, remoteAdapter } = ctx.createRouterPair('normal')
    const lStop = await router.stopLane('local_pool', 'op-conformance-local', 'conformance_stop')
    const rStop = await router.stopLane('remote_pool', 'op-conformance-remote', 'conformance_stop')
    const ok =
      lStop.driverStopped &&
      lStop.toolHostStopped &&
      rStop.driverStopped &&
      rStop.toolHostStopped &&
      localAdapter.shutdownCount === 1 &&
      remoteAdapter.shutdownCount === 1
    return {
      checkId: 'stop_lane_teardown_parity',
      ok,
      detail: ok ? 'both_pools_stopped_cleanly' : 'teardown_parity_failed',
    }
  } catch (err) {
    return {
      checkId: 'stop_lane_teardown_parity',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Production-callable Dual-Pool Parity Conformance harness verifying that `local_pool`
 * (`LocalPoolDriver`) and `remote_pool` (`RemotePoolV5Driver`) routed through
 * `GatewayInferencePoolRouter` satisfy identical transaction, budget-guard, capability-superset,
 * teardown, and `TurnReceiptV5.semanticDigest` contracts.
 */
export async function runDualPoolParityConformance(
  options: DualPoolParityConformanceOptions = {},
): Promise<DualPoolParityConformanceReport> {
  const ctx = buildConformanceContext(options)
  const receiptOutcome = await checkReceiptSemanticDigestParity(ctx)
  const checks: DualPoolParityCheckResult[] = [
    receiptOutcome.check,
    await checkPreDispatchAbandonZeroSettled(ctx),
    await checkCreditBudgetGuardParity(ctx),
    await checkCapabilitySupersetFailClosed(ctx),
    await checkStopLaneTeardownParity(ctx),
  ]

  const failedChecks = checks.filter((c) => !c.ok).map((c) => c.checkId)
  const ok = failedChecks.length === 0
  const checkedAt = new Date(ctx.fixedNowMs).toISOString()
  const conformanceDigest = remoteCanonicalSha256({
    domain: 'oc-dual-pool-parity-conformance-v5',
    schemaVersion: 5,
    ok,
    authorityEngine: ctx.authorityEngine,
    logicalModel: ctx.logicalModel,
    checks,
    parityDigest: receiptOutcome.parity?.parityDigest ?? null,
  })

  return Object.freeze({
    schemaVersion: 5 as const,
    ok,
    checkedAt,
    conformanceDigest,
    checks: Object.freeze(checks),
    failedChecks: Object.freeze(failedChecks),
    localReceipt: receiptOutcome.localReceipt,
    remoteReceipt: receiptOutcome.remoteReceipt,
    parity: receiptOutcome.parity,
  })
}
