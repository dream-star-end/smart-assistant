/**
 * OCV5-915 P3-1 — Outcome-based real-entry tests for Dual-Pool Unified `InferencePoolDriver`
 * live wiring, transparent ES `Proxy` facade, catalog-backed `CreditBudgetGuard` (including
 * local Antigravity cumulative `usage`), `TurnReceiptV5` parity, and T2 Q1-Q4 invariants.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import {
  buildRemoteReceiptV4,
  buildTurnReceiptV5FromLocalOutcome,
  buildTurnReceiptV5FromRemoteV4,
  remoteCanonicalSha256,
  validateTurnReceiptV5,
  verifyDualPoolReceiptParity,
  type RemoteDriverUsagePolicy,
  type TurnReceiptV5,
} from '@openclaude/protocol'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { EngineEvent, PartialSnapshot, PhantomSignals, TurnSummary } from '../engine/engineEvents.js'
import {
  createEngine,
  getUnifiedPoolAdapterWrapper,
  isUnifiedPoolSelfhostEnabled,
  registerEngine,
  registerRemoteDriverAdapter,
  registerUnifiedPoolAdapterWrapper,
  type EngineCreateOpts,
} from '../engine/registry.js'
import type { LocalCatalogPricing, LocalCatalogView } from '../modelCatalogClient.js'
import {
  GatewayInferencePoolRouter,
  MAX_RECEIPT_CACHE_ENTRIES,
  runDualPoolParityConformance,
  wrapEngineWithUnifiedPoolDriver,
  type CatalogPricingReader,
} from '../inferencePool/index.js'
import { syncSelfhostUnifiedPoolAdapterWrapper } from '../remotePool/registerRemoteDriver.js'

const SAVED_WRAPPER = getUnifiedPoolAdapterWrapper()
const SAVED_SELFHOST_ENV = process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS

afterEach(() => {
  if (SAVED_SELFHOST_ENV === undefined) {
    Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
  } else {
    process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = SAVED_SELFHOST_ENV
  }
  registerUnifiedPoolAdapterWrapper(SAVED_WRAPPER)
})

const FIXED_TURN_KEY = remoteCanonicalSha256({ suite: 'p31-live-wiring-turn-key' })

const TEST_PRICING: LocalCatalogPricing = {
  inputPerMtok: '10000',
  outputPerMtok: '40000',
  cacheReadPerMtok: '1000',
  cacheWritePerMtok: '12500',
  multiplier: '1.000',
}

function makeCatalogReader(opts: {
  configured: boolean
  pricing?: LocalCatalogPricing
  delayMs?: number
  onGetView?: () => Promise<void>
  agentMultipliers?: Readonly<Record<string, string>>
  lookupAgentMultiplier?: (agentId: string) => Promise<string | null>
}): CatalogPricingReader {
  const view: LocalCatalogView = {
    models: [
      {
        modelId: 'gemini-3-pro',
        displayName: 'Gemini 3 Pro',
        engine: 'antigravity',
        providerId: 'google',
        contextWindow: 200_000,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsVision: true,
        capabilityZero: false,
        supportsThinking: true,
        defaultEffort: 'medium',
        available: true,
        pricing: opts.pricing ?? TEST_PRICING,
      },
      {
        modelId: 'gpt-5.4-pro',
        displayName: 'GPT 5.4 Pro',
        engine: 'codex',
        providerId: 'openai',
        contextWindow: 200_000,
        supportedEfforts: ['low', 'medium', 'high'],
        supportsVision: true,
        capabilityZero: false,
        supportsThinking: true,
        defaultEffort: 'medium',
        available: true,
        pricing: opts.pricing ?? TEST_PRICING,
      },
    ],
    projectionRevision: 'rev-1',
    availabilityRevision: 'avail-1',
    securityEpoch: '1',
    canonicalize: (id) => id,
    aliasEntries: () => [],
    isRoutable: () => true,
    resolve: (id) => view.models.find((m) => m.modelId === id) ?? null,
    isCodexModel: (id) => id.startsWith('gpt-'),
    agentCostOverrides: new Map(Object.entries(opts.agentMultipliers ?? {})),
  }

  return {
    configured: opts.configured,
    async getView() {
      if (opts.onGetView) {
        await opts.onGetView()
      } else if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      return view
    },
    peekView() {
      return null
    },
    ...(opts.lookupAgentMultiplier
      ? { lookupAgentCostMultiplier: opts.lookupAgentMultiplier }
      : opts.agentMultipliers !== undefined
        ? {
            lookupAgentCostMultiplier: async (agentId: string) =>
              opts.agentMultipliers?.[agentId] ?? '1.000',
          }
        : {}),
  }
}

class DuckTypedLiveAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId: string
  readonly executionBackend?: EngineAdapter['executionBackend']
  readonly remoteBindingUid?: string
  readonly capabilities: EngineAdapter['capabilities']

  model: string | undefined
  effortLevel: string | undefined = 'medium'
  toolsets: string[] | undefined = undefined
  executionTarget: EngineAdapter['executionTarget'] = { kind: 'local' }
  nativeSessionId: string | null = 'native-sess-duck-1'
  pendingToolCalls = 0
  isRunning = false
  lastActivityAt = Date.now()

  // Duck-typed adapter methods/getters that MUST survive ES Proxy wrapping intact.
  promptIntelligentUi = { enabled: true, version: 'v5' }
  codexRouteReceived: unknown = null
  antigravityRouteReceived: unknown = null
  restartConfigCount = 0
  submitCount = 0
  interruptCount = 0
  shutdownCount = 0
  readonly receivedParams: TurnParams[] = []

  private readonly scenario: (
    params: TurnParams,
    helpers: {
      readonly waitForInterrupt: () => Promise<'user' | 'system'>
      readonly isInterrupted: () => boolean
      readonly setPendingTools: (n: number) => void
      readonly emitEvent: (event: string, payload: unknown) => void
    },
  ) => Promise<TurnSummary | null>

  private interruptWaiters: Array<(reason: 'user' | 'system') => void> = []
  private currentInterrupted = false

  constructor(
    opts: {
      engineId: string
      model: string
      executionBackend?: EngineAdapter['executionBackend']
      remoteBindingUid?: string
      capabilities?: Partial<EngineAdapter['capabilities']> & { supportsHermeticNoTools?: boolean }
    },
    scenario: DuckTypedLiveAdapter['scenario'],
  ) {
    super()
    this.engineId = opts.engineId
    this.model = opts.model
    this.executionBackend = opts.executionBackend
    this.remoteBindingUid = opts.remoteBindingUid
    this.capabilities = {
      billingMode: 'external',
      supportsEffort: true,
      resumeKind: 'antigravity-session',
      needsServerRequestId: true,
      historyMode: 'native-resume',
      permissionModel: 'native',
      emitsCallUsage: false,
      emitsToolInputDeltas: false,
      supportsNativeCompact: false,
      multimodalInput: 'native',
      ...opts.capabilities,
    }
    this.scenario = scenario
  }

  setCodexRoute(route: unknown): void {
    this.codexRouteReceived = route
  }

  setAntigravityRoute(route: unknown): void {
    this.antigravityRouteReceived = route
  }

  async restartForConfigChange(): Promise<void> {
    this.restartConfigCount += 1
  }

  getActiveSwarmTarget(): { brainDir: string; conversationId: string } | null {
    return { brainDir: '/tmp/brain-test', conversationId: 'conv-test-1' }
  }

  async start(): Promise<void> {
    this.isRunning = true
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    this.submitCount += 1
    this.receivedParams.push(params)
    this.isRunning = true
    this.currentInterrupted = false
    let finalized = false
    let partialText = ''

    const origOnEvent = params.onEvent
    const wrappedParams: TurnParams = {
      ...params,
      onEvent: (ev: EngineEvent) => {
        if (ev.kind === 'block' && ev.block.kind === 'text') {
          partialText += ev.block.text
        }
        origOnEvent(ev)
      },
    }

    const summary = this.scenario(wrappedParams, {
      waitForInterrupt: () =>
        new Promise<'user' | 'system'>((resolve) => {
          this.interruptWaiters.push(resolve)
        }),
      isInterrupted: () => this.currentInterrupted,
      setPendingTools: (n) => {
        this.pendingToolCalls = n
      },
      emitEvent: (event, payload) => {
        this.emit(event, payload)
      },
    }).finally(() => {
      finalized = true
      this.isRunning = false
    })

    return {
      submitted: Promise.resolve(),
      summary,
      end: () => {
        this.currentInterrupted = true
        finalized = true
      },
      getPartialSnapshot: (): PartialSnapshot => ({
        assistantText: partialText,
        thinkingText: '',
        completedTools: [],
        assistantSegments: partialText
          ? [{ index: 0, text: partialText, ts: Date.now() }]
          : [],
        thinkingSegments: [],
        runtimeEvents: [],
      }),
      getPhantomSignals: (): PhantomSignals => ({
        apiState: 'called',
        skipReason: null,
      }),
      get finalized() {
        return finalized
      },
      get pendingToolCalls() {
        return 0
      },
    }
  }

  interrupt(reason: 'user' | 'system' = 'system'): boolean {
    this.interruptCount += 1
    this.currentInterrupted = true
    const waiters = this.interruptWaiters.splice(0)
    for (const w of waiters) w(reason)
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

  setTraceId(): void {}
  async setGoalState(): Promise<void> {}
  updateConfig(): void {}
  setToolsets(toolsets: string[] | undefined): void {
    this.toolsets = toolsets
  }
  setExecutionTarget(target: EngineAdapter['executionTarget']): void {
    this.executionTarget = target
  }
  sendPermissionResponse(): boolean {
    return true
  }
  getPartialSnapshot(): PartialSnapshot {
    return {
      assistantText: '',
      thinkingText: '',
      completedTools: [],
      assistantSegments: [],
      thinkingSegments: [],
      runtimeEvents: [],
    }
  }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return null
  }
}

function makeCreateOpts(overrides: Partial<EngineCreateOpts> = {}): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:p31_live_test_1',
    agentId: 'main',
    agentBaseDir: '/tmp',
    model: 'gemini-3-pro',
    config: {} as EngineCreateOpts['config'],
    ...overrides,
  } as EngineCreateOpts
}

describe('OCV5-915 P3-1: Dual-Pool Live Wiring, ES Proxy Facade & CreditBudgetGuard', () => {
  it('createEngine wraps local & remote adapters via L2 hook preserving instanceof, duck-typed methods, TurnParams, and emitting TurnReceiptV5', async () => {
    const baseLocal = new DuckTypedLiveAdapter(
      { engineId: 'antigravity', model: 'gemini-3-pro' },
      async (params) => {
        params.onEvent({ kind: 'block', block: { kind: 'text', text: 'hello-unified-local' } })
        params.onEvent({
          kind: 'usage',
          usage: {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 50,
            cacheCreationTokens: 0,
            totalTokens: 750,
          },
        })
        return {
          usage: {
            cost: 0,
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 50,
            cacheCreationTokens: 0,
            totalTokens: 750,
          },
          assistantText: 'hello-unified-local',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'end_turn',
          numTurns: 1,
          isError: false,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )

    registerEngine('antigravity', () => baseLocal)

    // B05-P31: commercial / non-selfhost mode leaves wrapper unregistered and returns untouched raw adapter.
    Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
    assert.equal(isUnifiedPoolSelfhostEnabled(), false)
    assert.equal(syncSelfhostUnifiedPoolAdapterWrapper(), false)
    assert.equal(getUnifiedPoolAdapterWrapper(), undefined)
    const rawNonSelfhost = createEngine('antigravity', makeCreateOpts())
    assert.equal(rawNonSelfhost, baseLocal, 'non-selfhost createEngine must return untouched raw adapter')

    // Even when wrapper is registered in selfhost mode, explicit `{ isSelfhost: false }` returns raw adapter.
    process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
    assert.equal(isUnifiedPoolSelfhostEnabled(), true)
    assert.equal(syncSelfhostUnifiedPoolAdapterWrapper(), true)
    assert.ok(getUnifiedPoolAdapterWrapper())
    assert.equal(
      createEngine('antigravity', makeCreateOpts(), { isSelfhost: false }),
      baseLocal,
      'explicit isSelfhost: false must bypass unified pool wrapper',
    )

    const wrapped = createEngine('antigravity', makeCreateOpts())
    assert.equal(wrapped instanceof DuckTypedLiveAdapter, true)

    // Verify 100% duck-typed method & getter preservation through ES Proxy.
    const duck = wrapped as unknown as DuckTypedLiveAdapter & {
      readonly lastTurnReceiptV5: TurnReceiptV5 | null
      readonly unifiedPoolKind: string
    }
    assert.equal(duck.unifiedPoolKind, 'local_pool')
    duck.setCodexRoute({ provider: 'openai-test' })
    duck.setAntigravityRoute({ relayUrl: 'https://relay.example' })
    assert.deepEqual(baseLocal.codexRouteReceived, { provider: 'openai-test' })
    assert.deepEqual(baseLocal.antigravityRouteReceived, { relayUrl: 'https://relay.example' })
    assert.deepEqual(duck.promptIntelligentUi, { enabled: true, version: 'v5' })
    await duck.restartForConfigChange()
    assert.equal(baseLocal.restartConfigCount, 1)
    assert.deepEqual(duck.getActiveSwarmTarget(), {
      brainDir: '/tmp/brain-test',
      conversationId: 'conv-test-1',
    })

    const emittedReceipts: TurnReceiptV5[] = []
    wrapped.on('turn_receipt_v5', (r: TurnReceiptV5) => emittedReceipts.push(r))

    const events: EngineEvent[] = []
    const run = wrapped.submitTurn({
      input: 'inspect workspace',
      requestId: 'req_p31_local_1',
      turnKey: FIXED_TURN_KEY,
      assistantMessageId: 'msg-asst-1',
      thinkingMessageId: 'msg-think-1',
      onEvent: (e) => events.push(e),
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await run.submitted
    const summary = await run.summary

    assert.ok(summary)
    assert.equal(summary.assistantText, 'hello-unified-local')
    assert.equal(baseLocal.receivedParams[0]?.assistantMessageId, 'msg-asst-1')
    assert.equal(baseLocal.receivedParams[0]?.thinkingMessageId, 'msg-think-1')
    assert.equal(run.getPartialSnapshot().assistantText, 'hello-unified-local')
    assert.equal(run.getPhantomSignals().apiState, 'called')
    assert.equal(events.some((e) => e.kind === 'block'), true)

    assert.equal(emittedReceipts.length, 1)
    const validated = validateTurnReceiptV5(emittedReceipts[0]!)
    assert.equal(validated.poolKind, 'local_pool')
    assert.equal(validated.engineFamily, 'antigravity')
    assert.equal(validated.usage.inputTokens, 500)
    assert.equal(validated.usage.outputTokens, 200)
    assert.deepEqual(duck.lastTurnReceiptV5, validated)

    // Remote pool wiring through createEngine -> RemotePoolV5Driver -> LiveRemoteV5LaneBridge.
    const remoteBackend = {
      kind: 'remote-driver-v4' as const,
      version: 4 as const,
      engineId: 'codex',
      authorityEngine: 'codex' as const,
      driverId: 'codex',
      driverVersion: '4.1.0',
      sessionKey: 'agent:main:webchat:dm:p31_remote_1',
      operationId: '00000000-0000-4000-8000-000000000777',
      generation: '2',
      profileId: 'prof-codex-1',
      authEpoch: 'epoch-7',
    }
    const baseRemote = new DuckTypedLiveAdapter(
      { engineId: 'codex', model: 'gpt-5.4-pro-remote', executionBackend: remoteBackend },
      async (params) => {
        params.onEvent({ kind: 'block', block: { kind: 'text', text: 'hello-unified-remote' } })
        params.onEvent({
          kind: 'call_usage',
          call: {
            callId: 'c-remote-1',
            targetIds: ['main'],
            usage: {
              inputTokens: 800,
              outputTokens: 300,
              cacheReadTokens: 100,
              cacheCreationTokens: 0,
              totalTokens: 1200,
            },
          },
        })
        return {
          usage: {
            cost: 0,
            inputTokens: 800,
            outputTokens: 300,
            cacheReadTokens: 100,
            cacheCreationTokens: 0,
            totalTokens: 1200,
          },
          assistantText: 'hello-unified-remote',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'end_turn',
          numTurns: 1,
          isError: false,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )
    registerRemoteDriverAdapter(() => baseRemote)
    const wrappedRemote = createEngine(
      'codex',
      makeCreateOpts({
        sessionKey: remoteBackend.sessionKey,
        model: 'gpt-5.4-pro-remote',
        executionBackend: remoteBackend,
      }),
    )
    const remoteReceipts: TurnReceiptV5[] = []
    wrappedRemote.on('turn_receipt_v5', (r: TurnReceiptV5) => remoteReceipts.push(r))

    const remoteRun = wrappedRemote.submitTurn({
      input: 'hello remote',
      requestId: 'req_p31_remote_1',
      turnKey: FIXED_TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await remoteRun.submitted
    const remoteSummary = await remoteRun.summary
    assert.equal(remoteSummary?.assistantText, 'hello-unified-remote')
    assert.equal(remoteReceipts.length, 1)
    assert.equal(remoteReceipts[0]!.poolKind, 'remote_pool')
    assert.equal(remoteReceipts[0]!.driverId, 'codex')
    assert.equal(remoteReceipts[0]!.logicalModel, 'gpt-5.4-pro')
    assert.equal(remoteReceipts[0]!.usage.outputTokens, 300)
  })

  it('enforces real catalog-backed CreditBudgetGuard on local Antigravity cumulative usage (monotonic delta) and fails open when catalog is unconfigured', async () => {
    // 1. Unconfigured catalog -> fail-open (never aborts even with creditBudgetFen = 1n).
    const unconfiguredBase = new DuckTypedLiveAdapter(
      { engineId: 'antigravity', model: 'gemini-3-pro' },
      async (params) => {
        params.onEvent({
          kind: 'usage',
          usage: {
            inputTokens: 500_000,
            outputTokens: 200_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 700_000,
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        return {
          usage: {
            cost: 0,
            inputTokens: 500_000,
            outputTokens: 200_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 700_000,
          },
          assistantText: 'fail-open-ok',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'end_turn',
          numTurns: 1,
          isError: false,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )
    const wrappedFailOpen = wrapEngineWithUnifiedPoolDriver(
      unconfiguredBase,
      { engineId: 'antigravity', poolKind: 'local_pool', opts: makeCreateOpts() },
      { catalogClient: makeCatalogReader({ configured: false }) },
    )
    const rOpen = wrappedFailOpen.submitTurn({
      input: 'big turn unconfigured',
      requestId: 'req_fail_open_1',
      turnKey: FIXED_TURN_KEY,
      creditBudgetFen: 1n,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    const openSummary = await rOpen.summary
    assert.equal(openSummary?.isError, false)
    assert.equal(unconfiguredBase.interruptCount, 0)
    assert.equal(wrappedFailOpen.lastTurnReceiptV5?.status, 'success')

    // 2. Configured catalog -> Antigravity cumulative step usage (with duplicate & out-of-order lower snapshot)
    // stays below budget until step 2 crosses budget, then interrupts immediately with budget_exceeded!
    const agyBase = new DuckTypedLiveAdapter(
      { engineId: 'antigravity', model: 'gemini-3-pro' },
      async (params, helpers) => {
        // Step 1: 100k input + 10k output -> 1000 + 400 = 1400 fen? Wait: 100k * 10000 / 1e6 = 1000 fen,
        // 10k * 40000 / 1e6 = 400 fen -> total 1400 fen < budget 3000 fen.
        params.onEvent({
          kind: 'usage',
          usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 110_000 },
        })
        // Duplicate + out-of-order lower snapshot must NOT double-count (Q3 monotonic delta!).
        params.onEvent({
          kind: 'usage',
          usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 110_000 },
        })
        params.onEvent({
          kind: 'usage',
          usage: { inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 55_000 },
        })
        await new Promise((r) => setTimeout(r, 20))
        assert.equal(helpers.isInterrupted(), false, 'duplicate/lower snapshots must not trigger budget abort')

        // Step 2 cumulative jumps to 200k input (2000 fen) + 50k output (2000 fen) = 4000 fen >= 3000 fen.
        params.onEvent({
          kind: 'usage',
          usage: { inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 250_000 },
        })
        const interruptReason = await helpers.waitForInterrupt()
        assert.equal(interruptReason, 'system')
        return {
          usage: { cost: 0, inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 250_000 },
          assistantText: '',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'aborted',
          numTurns: 1,
          isError: true,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )

    const wrappedAgy = wrapEngineWithUnifiedPoolDriver(
      agyBase,
      { engineId: 'antigravity', poolKind: 'local_pool', opts: makeCreateOpts() },
      { catalogClient: makeCatalogReader({ configured: true }) },
    )
    const runAgy = wrappedAgy.submitTurn({
      input: 'multi-step antigravity turn',
      requestId: 'req_agy_budget_1',
      turnKey: FIXED_TURN_KEY,
      creditBudgetFen: 3000n,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await runAgy.summary
    assert.equal(agyBase.interruptCount, 1)
    assert.equal(wrappedAgy.lastTurnReceiptV5?.status, 'interrupted')
    assert.equal(wrappedAgy.lastTurnReceiptV5?.errorCode, 'budget_exceeded')
  })

  it('Q3 isLive() fence blocks late Turn 1 async pricing from interrupting Turn 2; Q2 receipt cache is bounded FIFO', async () => {
    let releaseTurn1Pricing!: () => void
    const turn1PricingGate = new Promise<void>((r) => {
      releaseTurn1Pricing = r
    })
    let pricingCalls = 0
    let turnNumber = 0

    const base = new DuckTypedLiveAdapter(
      { engineId: 'codex', model: 'gpt-5.4-pro' },
      async (params) => {
        turnNumber += 1
        if (turnNumber === 1) {
          // Huge usage on Turn 1 whose async pricing lookup stalls until Turn 2 is active.
          params.onEvent({
            kind: 'call_usage',
            call: {
              callId: 'sample-late-1',
              targetIds: ['main'],
              usage: { inputTokens: 500_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 700_000 },
            },
          })
          return {
            usage: { cost: 0, inputTokens: 500_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 700_000 },
            assistantText: 'turn-1-fast',
            thinkingText: '',
            assistantSegments: [],
            thinkingSegments: [],
            tools: [],
            runtimeEvents: [],
            stopReason: 'end_turn',
            numTurns: 1,
            isError: false,
            staleResumeId: false,
            phantomSignals: { apiState: 'called', skipReason: null },
          }
        }
        // Turn 2 releases Turn 1's stalled pricing lookup while Turn 2 is running.
        releaseTurn1Pricing()
        await new Promise((r) => setTimeout(r, 25))
        return {
          usage: { cost: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 },
          assistantText: 'turn-2-unaffected',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'end_turn',
          numTurns: 1,
          isError: false,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )

    const router = new GatewayInferencePoolRouter({ maxReceiptCacheEntries: 3 })
    const wrapped = wrapEngineWithUnifiedPoolDriver(
      base,
      { engineId: 'codex', poolKind: 'local_pool', opts: makeCreateOpts({ model: 'gpt-5.4-pro' }) },
      {
        router,
        resolvePricing: async () => {
          pricingCalls += 1
          if (pricingCalls === 1) {
            await turn1PricingGate
          }
          return TEST_PRICING
        },
      },
    )

    const t1 = wrapped.submitTurn({
      input: 'turn 1',
      requestId: 'req_late_1',
      turnKey: FIXED_TURN_KEY,
      creditBudgetFen: 10n,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await t1.summary

    const t2 = wrapped.submitTurn({
      input: 'turn 2',
      requestId: 'req_late_2',
      turnKey: FIXED_TURN_KEY,
      creditBudgetFen: 10_000n,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 1 },
      toolUseIdToName: new Map(),
    })
    const s2 = await t2.summary
    assert.equal(s2?.assistantText, 'turn-2-unaffected')
    assert.equal(base.interruptCount, 0, 'late Turn 1 pricing must never interrupt Turn 2')

    // Bounded FIFO cache verification (cap = 3 <= MAX_RECEIPT_CACHE_ENTRIES = 2048).
    assert.equal(MAX_RECEIPT_CACHE_ENTRIES, 2048)
    for (let i = 0; i < 5; i++) {
      const r = buildTurnReceiptV5FromLocalOutcome({
        tenantId: 't1',
        sessionKey: 'sess-fifo',
        turnId: `turn-fifo-${i}`,
        turnKey: FIXED_TURN_KEY,
        requestId: `req-fifo-${i}`,
        logicalModel: 'gpt-5.4-pro',
        usage: { inputTokens: 10, outputTokens: 5 },
        status: 'success',
        finalizedAt: '2026-11-27T00:00:00.000Z',
      })
      router.recordReceipt(r)
    }
    assert.equal(router.receiptCacheSize, 3)
    assert.equal(router.getLastReceipt('turn-fifo-0'), null)
    assert.equal(router.getLastReceipt('turn-fifo-4')?.turnId, 'turn-fifo-4')
  })

  it('Q4 pre-start cancel transitions admit -> abandon (zero-settled), skips baseAdapter.submitTurn, and releases listeners on shutdown', async () => {
    let releaseAdmit!: () => void
    const admitBarrier = new Promise<void>((r) => {
      releaseAdmit = r
    })
    const abandonedIds: string[] = []
    const base = new DuckTypedLiveAdapter(
      { engineId: 'codex', model: 'gpt-5.4-pro' },
      async () => {
        throw new Error('baseAdapter.submitTurn must NEVER be called after pre-start cancel')
      },
    )

    const wrapped = wrapEngineWithUnifiedPoolDriver(
      base,
      { engineId: 'codex', poolKind: 'local_pool', opts: makeCreateOpts({ model: 'gpt-5.4-pro' }) },
      {
        onAdmitJournal: async () => {
          await admitBarrier
        },
        onAbandonJournal: (admissionId) => {
          abandonedIds.push(admissionId)
        },
      },
    )

    const run = wrapped.submitTurn({
      input: 'cancelled before dispatch',
      requestId: 'req_prestart_cancel_1',
      turnKey: FIXED_TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })

    // Cancel synchronously while admit journal is still in flight.
    assert.equal(wrapped.interrupt('user'), true)
    releaseAdmit()

    await run.submitted
    const summary = await run.summary
    assert.equal(summary, null)
    assert.equal(base.submitCount, 0)
    assert.equal(abandonedIds.length, 1)
    assert.equal(base.listenerCount('session_id'), 0)

    await wrapped.shutdown()
    assert.equal(base.shutdownCount, 1)
    assert.equal(wrapped.getUnifiedPoolStatus().activeTurnCount, 0)
    assert.equal(base.listenerCount('session_id'), 0)
  })

  it('L0 receiptBridge + live runDualPoolParityConformance pass all 5 dual-pool checks with matching semanticDigest', async () => {
    const policy: RemoteDriverUsagePolicy = {
      semanticsId: 'unified_pool_v5',
      mode: 'per_turn',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cache_read_input_tokens',
      cacheWriteField: 'cache_creation_input_tokens',
      inputIncludesCacheRead: false,
      outputIncludesReasoning: true,
      allowCacheWrite: true,
    }
    const v4 = buildRemoteReceiptV4({
      engineId: 'codex',
      driverId: 'codex',
      driverVersion: '4.1.0',
      driverDigest: 'a'.repeat(64),
      uid: '42',
      containerDbId: '7',
      dockerId: 'b'.repeat(64),
      operationId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      sessionKey: 'agent:main:webchat:dm:parity_bridge_1',
      canonicalModel: 'gpt-5.4-pro-remote',
      upstreamModel: 'gpt-5.4-pro',
      profileId: 'prof-1',
      authEpoch: 'epoch-1',
      authorityTurnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      turnKey: FIXED_TURN_KEY,
      requestId: 'req_parity_1',
      nativeSessionId: 'native-1',
      terminalId: 'term-1',
      policy,
      countersBaseline: null,
      countersFinal: {
        input_tokens: 1000,
        output_tokens: 400,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      nativeStatus: 'success',
      rawEvidenceDigest: 'c'.repeat(64),
      provenance: {
        generation: '1',
        manifestHash: 'd'.repeat(64),
        coreDigest: 'e'.repeat(64),
        probeFingerprint: 'f'.repeat(64),
      },
    })
    const remoteV5 = buildTurnReceiptV5FromRemoteV4({
      receiptV4: v4,
      authorityEngine: 'codex',
      finalizedAt: '2026-11-27T00:00:00.000Z',
    })
    const localV5 = buildTurnReceiptV5FromLocalOutcome({
      poolKind: 'local_pool',
      authorityEngine: 'codex',
      tenantId: '42',
      sessionKey: 'agent:main:webchat:dm:parity_bridge_1',
      turnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      turnKey: FIXED_TURN_KEY,
      requestId: 'req_parity_1',
      logicalModel: 'gpt-5.4-pro',
      canonicalModel: 'gpt-5.4-pro-remote',
      upstreamModel: 'gpt-5.4-pro',
      usageSemantics: 'unified_pool_v5',
      usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 200, cacheWriteTokens: 50 },
      status: 'success',
      finalizedAt: '2026-11-27T00:00:00.000Z',
    })
    const parity = verifyDualPoolReceiptParity(localV5, remoteV5)
    assert.equal(parity.ok, true)
    assert.equal(parity.semanticDigestMatch, true)
    assert.equal(parity.localSemanticDigest, parity.remoteSemanticDigest)

    // Live conformance harness across LocalPoolDriver + RemotePoolV5Driver + GatewayInferencePoolRouter.
    const report = await runDualPoolParityConformance()
    assert.equal(report.ok, true, `conformance failed: ${report.failedChecks.join(',')}`)
    assert.equal(report.checks.length, 5)
    assert.equal(report.parity?.semanticDigestMatch, true)
    assert.equal(report.localReceipt?.poolKind, 'local_pool')
    assert.equal(report.remoteReceipt?.poolKind, 'remote_pool')
  })

  it('B06 single cumulative budget evaluator: 2x100 tokens @ 1000/MTok (budget 2 fen) does NOT over-fuse; 1 vs N events and agentMultiplier share identical thresholds', async () => {
    const pricing1000: LocalCatalogPricing = {
      inputPerMtok: '1000',
      outputPerMtok: '1000',
      cacheReadPerMtok: '0',
      cacheWritePerMtok: '0',
      multiplier: '1.000',
    }
    const runSplitCase = async (chunks: readonly number[], budgetFen: bigint) => {
      const adapter = new DuckTypedLiveAdapter(
        { engineId: 'codex', model: 'gpt-5.4-pro' },
        async (params) => {
          let total = 0
          for (let i = 0; i < chunks.length; i++) {
            const n = chunks[i]!
            total += n
            params.onEvent({
              kind: 'call_usage',
              call: {
                callId: `b06-sample-${i}`,
                targetIds: ['main'],
                usage: {
                  inputTokens: n,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  totalTokens: n,
                },
              },
            })
            await new Promise((r) => setTimeout(r, 10))
          }
          await new Promise((r) => setTimeout(r, 20))
          return {
            usage: {
              cost: 0,
              inputTokens: total,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: total,
            },
            assistantText: 'ok',
            thinkingText: '',
            assistantSegments: [],
            thinkingSegments: [],
            tools: [],
            runtimeEvents: [],
            stopReason: 'end_turn',
            numTurns: 1,
            isError: false,
            staleResumeId: false,
            phantomSignals: { apiState: 'called', skipReason: null },
          }
        },
      )
      const wrapped = wrapEngineWithUnifiedPoolDriver(
        adapter,
        { engineId: 'codex', poolKind: 'local_pool', opts: makeCreateOpts({ model: 'gpt-5.4-pro', agentId: 'main' }) },
        {
          catalogClient: makeCatalogReader({
            configured: true,
            pricing: pricing1000,
            agentMultipliers: { main: '1.000' },
          }),
          syncPricingLookup: () => pricing1000,
        },
      )
      const run = wrapped.submitTurn({
        input: 'b06 split check',
        requestId: `req_b06_${chunks.join('_')}_${budgetFen.toString()}`,
        turnKey: FIXED_TURN_KEY,
        creditBudgetFen: budgetFen,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.summary
      return {
        interruptCount: adapter.interruptCount,
        status: wrapped.lastTurnReceiptV5?.status,
        errorCode: wrapped.lastTurnReceiptV5?.errorCode,
      }
    }

    // Exact Audit R1 B06 probe: 2x100 tokens @ 1000/MTok = 0.2 fen -> ceil = 1 fen < budget 2 fen.
    // MUST NOT over-fuse whether delivered as 1 event (200) or 2 events (100 + 100)!
    const singleBelow = await runSplitCase([200], 2n)
    const splitBelow = await runSplitCase([100, 100], 2n)
    assert.equal(singleBelow.interruptCount, 0)
    assert.equal(splitBelow.interruptCount, 0, '2x100 tokens must NOT per-sample Math.ceil over-fuse at budget 2 fen')
    assert.equal(splitBelow.status, 'success')

    // Reaching cumulative cost = 2 fen (1_500_000 tokens @ 1000/MTok -> ceil(1.5) = 2 fen >= 2 fen) fuses identically for 1 vs 3 events!
    const singleAt = await runSplitCase([1_500_000], 2n)
    const splitAt = await runSplitCase([500_000, 500_000, 500_000], 2n)
    assert.equal(singleAt.interruptCount, 1)
    assert.equal(splitAt.interruptCount, 1)
    assert.equal(singleAt.errorCode, 'budget_exceeded')
    assert.equal(splitAt.errorCode, 'budget_exceeded')

    // Agent cost multiplier composition (codex default composeAgentMultiplier = true):
    // 1_000_000 tokens @ 1000/MTok * 2.000 agent multiplier = 2000 fen >= budget 1500 fen -> fuses!
    const mulAdapter = new DuckTypedLiveAdapter(
      { engineId: 'codex', model: 'gpt-5.4-pro' },
      async (params, helpers) => {
        params.onEvent({
          kind: 'call_usage',
          call: {
            callId: 'b06-mul-1',
            targetIds: ['codex-pro'],
            usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1_000_000 },
          },
        })
        await helpers.waitForInterrupt()
        return {
          usage: { cost: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1_000_000 },
          assistantText: '',
          thinkingText: '',
          assistantSegments: [],
          thinkingSegments: [],
          tools: [],
          runtimeEvents: [],
          stopReason: 'aborted',
          numTurns: 1,
          isError: true,
          staleResumeId: false,
          phantomSignals: { apiState: 'called', skipReason: null },
        }
      },
    )
    const wrappedMul = wrapEngineWithUnifiedPoolDriver(
      mulAdapter,
      { engineId: 'codex', poolKind: 'local_pool', opts: makeCreateOpts({ model: 'gpt-5.4-pro', agentId: 'codex-pro' }) },
      {
        catalogClient: makeCatalogReader({
          configured: true,
          pricing: pricing1000,
          agentMultipliers: { 'codex-pro': '2.000' },
        }),
      },
    )
    const mulRun = wrappedMul.submitTurn({
      input: 'multiplier test',
      requestId: 'req_b06_mul_1',
      turnKey: FIXED_TURN_KEY,
      creditBudgetFen: 1500n,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await mulRun.summary
    assert.equal(mulAdapter.interruptCount, 1)
    assert.equal(wrappedMul.lastTurnReceiptV5?.errorCode, 'budget_exceeded')
  })

  it('B11 cross-end authoritative TurnReceiptV5 identity & B04 real timestamp: Gateway emitted V5 matches Master across standard, fast, and ultrafast tiers (non-2025)', async () => {
    const policy: RemoteDriverUsagePolicy = {
      semanticsId: 'codex-cumulative-v1',
      mode: 'cumulative',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cached_input_tokens',
      inputIncludesCacheRead: true,
      outputIncludesReasoning: true,
      allowCacheWrite: false,
    }
    const remoteBackend = {
      kind: 'remote-driver-v4' as const,
      version: 4 as const,
      engineId: 'codex',
      authorityEngine: 'codex' as const,
      driverId: 'codex',
      driverVersion: '4.2.0',
      sessionKey: 'agent:main:webchat:dm:p31_b11_parity_1',
      operationId: '11111111-1111-4111-8111-111111111111',
      generation: '3',
      profileId: 'prof-codex-b11',
      authEpoch: 'epoch-b11',
    }
    const realFinalizedAtMs = Date.UTC(2026, 10, 27, 6, 30, 0)
    const realFinalizedAtIso = new Date(realFinalizedAtMs).toISOString()

    for (const [idx, tier] of (['standard', 'fast', 'ultrafast'] as const).entries()) {
      const authorityTurnId = `b110000000000000000000000000099${idx}`
      const requestId = `req_b11_cross_end_${tier}`
      const v4Receipt = buildRemoteReceiptV4({
        engineId: 'codex',
        driverId: 'codex',
        driverVersion: '4.2.0',
        driverDigest: 'a'.repeat(64),
        uid: '42',
        containerDbId: '7',
        dockerId: 'b'.repeat(64),
        operationId: remoteBackend.operationId,
        runId: '22222222-2222-4222-8222-222222222222',
        sessionKey: remoteBackend.sessionKey,
        canonicalModel: 'gpt-5.4-pro-remote',
        upstreamModel: 'gpt-5.4-pro',
        profileId: remoteBackend.profileId,
        authEpoch: remoteBackend.authEpoch,
        authorityTurnId,
        turnKey: FIXED_TURN_KEY,
        requestId,
        nativeSessionId: 'native-thread-b11',
        terminalId: `term-b11-${tier}`,
        policy,
        countersBaseline: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 },
        countersFinal: { input_tokens: 1100, output_tokens: 420, cached_input_tokens: 210 },
        nativeStatus: 'success',
        rawEvidenceDigest: 'c'.repeat(64),
        provenance: {
          generation: '3',
          manifestHash: 'd'.repeat(64),
          coreDigest: 'e'.repeat(64),
          probeFingerprint: 'f'.repeat(64),
        },
      })

      const baseRemote = new DuckTypedLiveAdapter(
        {
          engineId: 'codex',
          model: 'gpt-5.4-pro-remote',
          executionBackend: remoteBackend,
          remoteBindingUid: '42',
        },
        async (params, helpers) => {
          params.onEvent({ kind: 'block', block: { kind: 'text', text: `b11-${tier}` } })
          helpers.emitEvent('remote_receipt_v4', v4Receipt)
          return {
            usage: {
              cost: 0,
              inputTokens: v4Receipt.usage.inputTokens,
              outputTokens: v4Receipt.usage.outputTokens,
              cacheReadTokens: v4Receipt.usage.cacheReadTokens,
              cacheCreationTokens: 0,
              totalTokens: v4Receipt.usage.inputTokens + v4Receipt.usage.outputTokens + v4Receipt.usage.cacheReadTokens,
            },
            assistantText: `b11-${tier}`,
            thinkingText: '',
            assistantSegments: [],
            thinkingSegments: [],
            tools: [],
            runtimeEvents: [],
            stopReason: 'end_turn',
            numTurns: 1,
            isError: false,
            staleResumeId: false,
            phantomSignals: { apiState: 'called', skipReason: null },
          }
        },
      )

      const wrappedRemote = wrapEngineWithUnifiedPoolDriver(
        baseRemote,
        {
          engineId: 'codex',
          poolKind: 'remote_pool',
          opts: makeCreateOpts({
            sessionKey: remoteBackend.sessionKey,
            model: 'gpt-5.4-pro-remote',
            executionBackend: remoteBackend,
          }),
        },
        { clock: () => realFinalizedAtMs },
      )
      const emitted: TurnReceiptV5[] = []
      wrappedRemote.on('turn_receipt_v5', (r: TurnReceiptV5) => emitted.push(r))

      const run = wrappedRemote.submitTurn({
        input: `cross-end identity check ${tier}`,
        serviceTier: tier === 'standard' ? null : tier,
        requestId,
        turnKey: FIXED_TURN_KEY,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary

      assert.equal(emitted.length, 1)
      const gwReceipt = emitted[0]!
      const masterReceipt = buildTurnReceiptV5FromRemoteV4({
        receiptV4: v4Receipt,
        authorityEngine: 'codex',
        serviceTier: tier,
        placementEpoch: 3,
        finalizedAt: realFinalizedAtIso,
      })

      assert.equal(gwReceipt.turnId, authorityTurnId)
      assert.equal(gwReceipt.tenantId, '42')
      assert.equal(gwReceipt.serviceTier, tier)
      assert.equal(gwReceipt.usageSemantics, 'codex-cumulative-v1')
      assert.equal(gwReceipt.finalizedAt, realFinalizedAtIso)
      assert.ok(Date.parse(gwReceipt.finalizedAt) >= Date.UTC(2026, 0, 1), 'B04: finalizedAt must be real >= 2026 timestamp, never fabricated 2025')
      assert.equal(gwReceipt.semanticDigest, masterReceipt.semanticDigest)
      assert.equal(gwReceipt.receiptDigest, masterReceipt.receiptDigest)
      assert.deepEqual(gwReceipt, masterReceipt)
    }

    // B04 guard: calling buildTurnReceiptV5FromRemoteV4 without finalizedAt uses real wall-clock time (>= 2026), NEVER 2025.
    const defaultClockReceipt = buildTurnReceiptV5FromRemoteV4({
      receiptV4: buildRemoteReceiptV4({
        engineId: 'codex',
        driverId: 'codex',
        driverVersion: '4.2.0',
        driverDigest: 'a'.repeat(64),
        uid: '42',
        containerDbId: '7',
        dockerId: 'b'.repeat(64),
        operationId: remoteBackend.operationId,
        runId: '22222222-2222-4222-8222-222222222222',
        sessionKey: remoteBackend.sessionKey,
        canonicalModel: 'gpt-5.4-pro-remote',
        upstreamModel: 'gpt-5.4-pro',
        profileId: remoteBackend.profileId,
        authEpoch: remoteBackend.authEpoch,
        authorityTurnId: 'b0400000000000000000000000000888',
        turnKey: FIXED_TURN_KEY,
        requestId: 'req_b04_real_clock',
        nativeSessionId: 'native-thread-b11',
        terminalId: 'term-b04-clock',
        policy,
        countersBaseline: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        countersFinal: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
        nativeStatus: 'success',
        rawEvidenceDigest: 'c'.repeat(64),
        provenance: {
          generation: '3',
          manifestHash: 'd'.repeat(64),
          coreDigest: 'e'.repeat(64),
          probeFingerprint: 'f'.repeat(64),
        },
      }),
      authorityEngine: 'codex',
    })
    assert.ok(
      new Date(defaultClockReceipt.finalizedAt).getUTCFullYear() >= 2026,
      `expected real wall-clock year >= 2026, got ${defaultClockReceipt.finalizedAt}`,
    )
  })

  it('B13 honest capability manifest: text-only driver rejects image turn before dispatch, and hermeticNoTools requires real enforcement capability', async () => {
    // 1. Text-only local Antigravity adapter (multimodalInput: 'text-only', permissionModel: 'forced-unattended').
    const textOnlyAgy = new DuckTypedLiveAdapter(
      {
        engineId: 'antigravity',
        model: 'gemini-3-pro',
        capabilities: { multimodalInput: 'text-only', permissionModel: 'forced-unattended' },
      },
      async () => {
        throw new Error('must NEVER dispatch to text-only adapter when image is supplied')
      },
    )
    const wrappedTextOnly = wrapEngineWithUnifiedPoolDriver(textOnlyAgy, {
      engineId: 'antigravity',
      poolKind: 'local_pool',
      opts: makeCreateOpts({ model: 'gemini-3-pro' }),
    })

    const imgRun = wrappedTextOnly.submitTurn({
      input: [
        { type: 'text', text: 'describe this image' },
        { type: 'image_ref', mimeType: 'image/png', uri: 'file:///tmp/screenshot.png' },
      ],
      requestId: 'req_b13_vision_reject',
      turnKey: FIXED_TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(imgRun.submitted, /CAPABILITY_UNSATISFIED:vision_unsupported/)
    assert.equal(await imgRun.summary, null)
    assert.equal(textOnlyAgy.submitCount, 0, 'text-only adapter must not be dispatched for image turn')

    // 2. hermeticNoTools on an adapter lacking enforcement (permissionModel: 'forced-unattended', no explicit supportsHermeticNoTools).
    const nonHermetic = new DuckTypedLiveAdapter(
      {
        engineId: 'antigravity',
        model: 'gemini-3-pro',
        capabilities: { multimodalInput: 'text-only', permissionModel: 'forced-unattended' },
      },
      async () => {
        throw new Error('must NEVER dispatch hermeticNoTools turn to adapter lacking enforcement')
      },
    )
    const wrappedNonHermetic = wrapEngineWithUnifiedPoolDriver(nonHermetic, {
      engineId: 'antigravity',
      poolKind: 'local_pool',
      opts: makeCreateOpts({ model: 'gemini-3-pro', hermeticNoTools: true }),
    })
    const hermRun = wrappedNonHermetic.submitTurn({
      input: 'advisor turn',
      requestId: 'req_b13_hermetic_reject',
      turnKey: FIXED_TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(hermRun.submitted, /CAPABILITY_UNSATISFIED:hermetic_no_tools_unsupported/)
    assert.equal(await hermRun.summary, null)
    assert.equal(nonHermetic.submitCount, 0)

    // 3. Adapter declaring explicit hermetic enforcement admits and completes cleanly.
    const hermeticCapable = new DuckTypedLiveAdapter(
      {
        engineId: 'antigravity',
        model: 'gemini-3-pro',
        capabilities: {
          multimodalInput: 'text-only',
          permissionModel: 'forced-unattended',
          supportsHermeticNoTools: true,
        },
      },
      async () => ({
        usage: { cost: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 },
        assistantText: 'hermetic-ok',
        thinkingText: '',
        assistantSegments: [],
        thinkingSegments: [],
        tools: [],
        runtimeEvents: [],
        stopReason: 'end_turn',
        numTurns: 1,
        isError: false,
        staleResumeId: false,
        phantomSignals: { apiState: 'called', skipReason: null },
      }),
    )
    const wrappedHermetic = wrapEngineWithUnifiedPoolDriver(hermeticCapable, {
      engineId: 'antigravity',
      poolKind: 'local_pool',
      opts: makeCreateOpts({ model: 'gemini-3-pro', hermeticNoTools: true }),
    })
    const okRun = wrappedHermetic.submitTurn({
      input: 'hermetic text turn',
      requestId: 'req_b13_hermetic_ok',
      turnKey: FIXED_TURN_KEY,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await okRun.submitted
    const okSummary = await okRun.summary
    assert.equal(okSummary?.assistantText, 'hermetic-ok')
    assert.equal(hermeticCapable.submitCount, 1)
  })
})
