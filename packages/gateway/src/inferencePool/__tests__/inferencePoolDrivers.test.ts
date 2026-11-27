import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  type ExecutionPolicyEnvelope,
  type LogicalModelCapability,
  type NormalizedInferenceEvent,
  type RemoteDriverUsagePolicy,
  type ToolCallEnvelope,
  type TurnReceiptV5,
  buildRemoteReceiptV4,
  computeSchemaFilteredArgsSha256,
  computeStickyHomeKey,
  computeToolIdempotencyKey,
  remoteCanonicalSha256,
} from '@openclaude/protocol'
import { validateTurnReceiptV5 } from '@openclaude/protocol/inference-pool'
import type { EngineAdapter, EngineTurnRun, TurnParams } from '../../engine/engineAdapter.js'
import type {
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  TurnSummary,
} from '../../engine/engineEvents.js'
import { ExecEnvJobRegistry, ToolBrokerServer } from '../../execEnv/index.js'
import {
  type DriverTurnRequest,
  LocalPoolDriver,
  RemotePoolV5Driver,
  type RemoteV5LaneBridge,
  type RemoteV5LaneEvent,
  type RemoteV5TurnDispatchPayload,
  type TurnSettlementInfo,
  buildLocalDriverCapabilityManifest,
  buildRemoteDriverCapabilityManifest,
} from '../index.js'

const registriesToDispose: ExecEnvJobRegistry[] = []
const tempSettlementWalDirs: string[] = []

function makeTempSettlementWalDir(prefix = 'ocv5-settlement-wal-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempSettlementWalDirs.push(dir)
  return dir
}

function makeJobRegistry(): ExecEnvJobRegistry {
  const reg = new ExecEnvJobRegistry({ envId: 'env-test-pool', killGraceMs: 80 })
  registriesToDispose.push(reg)
  return reg
}

afterEach(async () => {
  while (registriesToDispose.length > 0) {
    await registriesToDispose.pop()!.disposeAll()
  }
  while (tempSettlementWalDirs.length > 0) {
    rmSync(tempSettlementWalDirs.pop()!, { recursive: true, force: true })
  }
})

const FIXED_TURN_KEY = remoteCanonicalSha256({ turn: 'turn-key-fixed-v5' })
const FIXED_BLOB_SHA = remoteCanonicalSha256({ blob: 'png-bytes' })
const FIXED_IMAGE_SHA = remoteCanonicalSha256({ image: 'vision-frame' })

function makeCapabilityTriplet(overrides?: {
  probed?: Partial<LogicalModelCapability>
  transport?: Partial<LogicalModelCapability>
  catalog?: Partial<LogicalModelCapability>
}): {
  readonly probed: LogicalModelCapability
  readonly transport: LogicalModelCapability
  readonly catalog: LogicalModelCapability
} {
  const base: LogicalModelCapability = {
    logicalModel: 'gpt-5.4-pro',
    upstreamModelId: 'gpt-5.4-pro-2026',
    supportsVision: true,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportedServiceTiers: ['standard', 'fast'],
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking: true,
    contextWindow: 200_000,
  }
  return {
    probed: { ...base, ...overrides?.probed },
    transport: { ...base, ...overrides?.transport },
    catalog: { ...base, ...overrides?.catalog },
  }
}

function makeTurnRequest(overrides: Partial<DriverTurnRequest> = {}): DriverTurnRequest {
  return {
    schemaVersion: 5,
    turnId: 'turn-001',
    turnKey: FIXED_TURN_KEY,
    requestId: 'req-001',
    tenantId: 'tenant-1',
    sessionKey: 'sess-alpha-01',
    logicalModel: 'gpt-5.4-pro',
    serviceTier: 'fast',
    input: [{ type: 'text', text: 'Analyze repository layout' }],
    placementHint: {
      poolPreference: 'auto',
      placementEpoch: 2,
    },
    ...overrides,
  }
}

class MockEngineAdapter extends EventEmitter implements EngineAdapter {
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

  model: string | undefined = 'gpt-5.4-pro-2026'
  effortLevel: string | undefined = 'medium'
  toolsets: string[] | undefined = undefined
  executionTarget: EngineAdapter['executionTarget'] = {
    kind: 'local',
  } as EngineAdapter['executionTarget']
  nativeSessionId: string | null = 'native-local-sess-1'
  pendingToolCalls = 0
  isRunning = true
  lastActivityAt = Date.now()

  readonly submittedParams: TurnParams[] = []
  readonly interruptCalls: Array<'user' | 'system' | undefined> = []
  readonly permissionResponses: Array<{ requestId: string; response: unknown }> = []
  shutdownCount = 0
  drainCount = 0

  private readonly scenario: (
    params: TurnParams,
    ctrl: {
      readonly onInterrupt: (cb: (reason?: 'user' | 'system') => void) => void
      readonly emitEvent: (ev: EngineEvent) => void
    },
  ) => Promise<TurnSummary | null>

  private interruptListeners: Array<(reason?: 'user' | 'system') => void> = []

  constructor(
    scenario: (
      params: TurnParams,
      ctrl: {
        readonly onInterrupt: (cb: (reason?: 'user' | 'system') => void) => void
        readonly emitEvent: (ev: EngineEvent) => void
      },
    ) => Promise<TurnSummary | null>,
  ) {
    super()
    this.scenario = scenario
  }

  async start(): Promise<void> {
    this.isRunning = true
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    this.submittedParams.push(params)
    this.interruptListeners = []
    let finalized = false

    const summary = Promise.resolve().then(async () => {
      try {
        return await this.scenario(params, {
          onInterrupt: (cb) => this.interruptListeners.push(cb),
          emitEvent: (ev) => params.onEvent(ev),
        })
      } finally {
        finalized = true
      }
    })

    return {
      submitted: Promise.resolve(),
      summary,
      end: () => {
        finalized = true
      },
      getPartialSnapshot: (): PartialSnapshot => ({
        assistantText: '',
        thinkingText: '',
        completedTools: [],
        assistantSegments: [],
        thinkingSegments: [],
        runtimeEvents: [],
      }),
      getPhantomSignals: (): PhantomSignals => ({ apiState: 'called', skipReason: null }),
      get finalized() {
        return finalized
      },
      get pendingToolCalls() {
        return 0
      },
    }
  }

  interrupt(reason?: 'user' | 'system'): boolean {
    this.interruptCalls.push(reason)
    for (const cb of [...this.interruptListeners]) cb(reason)
    return true
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
    this.isRunning = false
  }

  async waitForOutputDrain(): Promise<void> {
    this.drainCount += 1
  }

  clearSessionId(): void {
    this.nativeSessionId = null
  }

  setResumeSessionId(sessionId: string): void {
    this.nativeSessionId = sessionId
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

  sendPermissionResponse(requestId: string, response: unknown): boolean {
    this.permissionResponses.push({ requestId, response })
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

  getBoundRepoBinding(): null {
    return null
  }
}

function makeSuccessSummary(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}): TurnSummary {
  return {
    usage: {
      cost: 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      totalTokens:
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    },
    assistantText: 'done',
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

function makeMockRemoteBridge(
  streamScenario: (
    payload: RemoteV5TurnDispatchPayload,
    ctrl: { readonly isInterrupted: () => boolean },
  ) => AsyncIterable<RemoteV5LaneEvent>,
): {
  readonly bridge: RemoteV5LaneBridge
  readonly dispatchedPayloads: RemoteV5TurnDispatchPayload[]
  readonly interruptCalls: Array<{ operationId: string; reason: string }>
  readonly abandonedCalls: Array<{ admissionId: string; operationId: string; reason: string }>
  readonly stopRemoteCalls: Array<{ operationId: string; reason: string }>
  readonly stopToolHostCalls: Array<{ operationId: string; leaseId: string; reason: string }>
} {
  const dispatchedPayloads: RemoteV5TurnDispatchPayload[] = []
  const interruptCalls: Array<{ operationId: string; reason: string }> = []
  const abandonedCalls: Array<{ admissionId: string; operationId: string; reason: string }> = []
  const stopRemoteCalls: Array<{ operationId: string; reason: string }> = []
  const stopToolHostCalls: Array<{ operationId: string; leaseId: string; reason: string }> = []
  let interrupted = false

  const bridge: RemoteV5LaneBridge = {
    async abandonRemote(admissionId, operationId, reason) {
      abandonedCalls.push({ admissionId, operationId, reason })
    },
    dispatchTurn(payload) {
      dispatchedPayloads.push(payload)
      interrupted = false
      return streamScenario(payload, { isInterrupted: () => interrupted })
    },
    async interrupt(operationId, reason) {
      interrupted = true
      interruptCalls.push({ operationId, reason })
    },
    async stopRemote(operationId, reason) {
      stopRemoteCalls.push({ operationId, reason })
      return { remoteStopped: true }
    },
    async stopToolHost(operationId, leaseId, reason) {
      stopToolHostCalls.push({ operationId, leaseId, reason })
      return { toolHostStopped: true }
    },
  }

  return {
    bridge,
    dispatchedPayloads,
    interruptCalls,
    abandonedCalls,
    stopRemoteCalls,
    stopToolHostCalls,
  }
}

async function collectEvents(
  iterable: AsyncIterable<NormalizedInferenceEvent>,
): Promise<NormalizedInferenceEvent[]> {
  const events: NormalizedInferenceEvent[] = []
  for await (const ev of iterable) {
    events.push(ev)
  }
  return events
}

describe('OCV5-890 Wave 2 — Symmetric Dual-Pool Inference Drivers (LocalPoolDriver & RemotePoolV5Driver)', () => {
  it('enforces capability superset intersection and rejects ultrafast / vision / consultTurn gaps with zero silent downgrade', async () => {
    // Transport lacks vision & ultrafast; catalog lacks consultTurn -> strict intersection!
    const triplet = makeCapabilityTriplet({
      probed: {
        supportsVision: true,
        supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
        supportsConsultTurn: true,
      },
      transport: {
        supportsVision: false,
        supportedServiceTiers: ['standard', 'fast'],
        supportsConsultTurn: true,
      },
      catalog: {
        supportsVision: true,
        supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
        supportsConsultTurn: false,
      },
    })

    const localManifest = buildLocalDriverCapabilityManifest({
      engineFamily: 'codex',
      authorityEngine: 'codex',
      driverId: 'local-codex-v5',
      driverVersion: '5.0.0',
      models: [triplet],
    })
    const remoteManifest = buildRemoteDriverCapabilityManifest({
      engineFamily: 'codex',
      authorityEngine: 'codex',
      driverId: 'remote-codex-v5',
      driverVersion: '5.0.0',
      models: [triplet],
    })

    // Intersection invariants
    assert.equal(localManifest.models[0]!.supportsVision, false)
    assert.equal(localManifest.models[0]!.supportsConsultTurn, false)
    assert.deepEqual(localManifest.models[0]!.supportedServiceTiers, ['standard', 'fast'])
    assert.deepEqual(remoteManifest.models[0]!.supportedServiceTiers, ['standard', 'fast'])

    const localDriver = new LocalPoolDriver({
      adapter: new MockEngineAdapter(async () => null),
      manifest: localManifest,
    })
    const { bridge } = makeMockRemoteBridge(async function* () {})
    const remoteDriver = new RemotePoolV5Driver({
      bridge,
      manifest: remoteManifest,
    })

    for (const driver of [localDriver, remoteDriver]) {
      // Missing ultrafast service tier
      await assert.rejects(
        () => driver.admit(makeTurnRequest({ serviceTier: 'ultrafast' })),
        /CAPABILITY_UNSATISFIED:.*service_tier_unsupported:ultrafast/,
      )

      // Missing vision capability (inferred from image_ref input block!)
      await assert.rejects(
        () =>
          driver.admit(
            makeTurnRequest({
              input: [
                { type: 'text', text: 'describe image' },
                {
                  type: 'image_ref',
                  blobId: 'blob-img-1',
                  sha256: FIXED_IMAGE_SHA,
                  mimeType: 'image/png',
                },
              ],
            }),
          ),
        /CAPABILITY_UNSATISFIED:.*vision_unsupported/,
      )

      // Missing consultTurn capability
      await assert.rejects(
        () => driver.admit(makeTurnRequest({ consultTurn: true })),
        /CAPABILITY_UNSATISFIED:.*consult_turn_unsupported/,
      )
    }
  })

  it('enforces 3-phase transaction state machine symmetrically: admit->abandon zero-settle, post-dispatch abandon forbidden, priorDispatched replay forbidden', async () => {
    const triplet = makeCapabilityTriplet()
    const localManifest = buildLocalDriverCapabilityManifest({
      engineFamily: 'codex',
      authorityEngine: 'codex',
      driverId: 'local-codex-v5',
      driverVersion: '5.0.0',
      models: [triplet],
    })
    const remoteManifest = buildRemoteDriverCapabilityManifest({
      engineFamily: 'codex',
      authorityEngine: 'codex',
      driverId: 'remote-codex-v5',
      driverVersion: '5.0.0',
      models: [triplet],
    })

    const localJournal: string[] = []
    const remoteJournal: string[] = []

    const localDriver = new LocalPoolDriver({
      adapter: new MockEngineAdapter(async (_params, ctrl) => {
        ctrl.emitEvent({ kind: 'block', block: { kind: 'text', text: 'ok' } })
        return makeSuccessSummary({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })
      }),
      manifest: localManifest,
      onAdmitJournal: (_req, adm) => {
        localJournal.push(`admit:${adm.admissionId}`)
      },
      onAbandonJournal: (admId, reason) => {
        localJournal.push(`abandon:${admId}:${reason}`)
      },
    })

    const mockRemote = makeMockRemoteBridge(async function* () {
      yield { kind: 'dispatched', nativeSessionId: 'native-rem-1', nativeTurnId: 'nt-1' }
      yield { kind: 'text_delta', channel: 'answer', delta: 'ok' }
      yield {
        kind: 'terminal',
        status: 'success',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    })
    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: remoteManifest,
      onAdmitJournal: (_req, adm) => {
        remoteJournal.push(`admit:${adm.admissionId}`)
      },
      onAbandonJournal: (admId, reason) => {
        remoteJournal.push(`abandon:${admId}:${reason}`)
      },
    })

    for (const [label, driver, journal] of [
      ['local', localDriver, localJournal],
      ['remote', remoteDriver, remoteJournal],
    ] as const) {
      // 1. admit -> abandon before dispatch -> atomic zero-settled close
      const adm1 = await driver.admit(makeTurnRequest({ turnId: `turn-ab-${label}` }))
      const abandonRes = await driver.abandon(adm1.admissionId, 'pre_dispatch_fallback')
      assert.deepEqual(abandonRes, { abandoned: true, zeroSettled: true })
      assert.ok(journal.includes(`abandon:${adm1.admissionId}:pre_dispatch_fallback`))

      // Dispatching an abandoned admission fails closed
      assert.throws(() => driver.dispatch(adm1.admissionId), /INFERENCE_ADMISSION_ABANDONED/)

      // 2. admit -> dispatch burns post-dispatch fence IMMEDIATELY (even before pulling first event)
      const adm2 = await driver.admit(makeTurnRequest({ turnId: `turn-disp-${label}` }))
      const stream = driver.dispatch(adm2.admissionId)
      await assert.rejects(
        () => driver.abandon(adm2.admissionId, 'late_cancel'),
        /INFERENCE_ABANDON_AFTER_DISPATCH_FORBIDDEN/,
      )
      // Double-dispatch forbidden
      assert.throws(
        () => driver.dispatch(adm2.admissionId),
        /INFERENCE_ADMISSION_ALREADY_DISPATCHED/,
      )
      const events = await collectEvents(stream)
      assert.equal(events.at(-1)?.kind, 'turn_terminal')

      // 3. retryContext.priorDispatched === true rejected fail-closed
      await assert.rejects(
        () =>
          driver.admit(
            makeTurnRequest({
              turnId: `turn-replay-${label}`,
              retryContext: { priorDispatched: true, attempt: 2 },
            }),
          ),
        /POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN/,
      )
    }

    assert.equal(mockRemote.abandonedCalls.length, 1)
  })

  it('fires mid-turn CreditBudgetGuard identically across Local and Remote pools and settles with non-zero authoritative TurnReceiptV5', async () => {
    const triplet = makeCapabilityTriplet()
    const fixedClock = () => Date.parse('2026-11-25T12:00:00.000Z')
    // 10 credits per 100 tokens -> 500 tokens = 50 fen, 1100 tokens = 110 fen >= 100 fen budget
    const estimateCreditsFen = (usage: { inputTokens: number; outputTokens: number }) =>
      BigInt(Math.floor((usage.inputTokens + usage.outputTokens) / 10))

    const localSettlements: TurnSettlementInfo[] = []
    const remoteSettlements: TurnSettlementInfo[] = []

    const localAdapter = new MockEngineAdapter(async (_params, ctrl) => {
      let aborted = false
      ctrl.onInterrupt(() => {
        aborted = true
      })
      ctrl.emitEvent({
        kind: 'call_usage',
        call: {
          callId: 'c1',
          targetIds: ['msg-1'],
          usage: {
            totalTokens: 500,
            inputTokens: 400,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      })
      assert.equal(aborted, false)
      ctrl.emitEvent({
        kind: 'call_usage',
        call: {
          callId: 'c2',
          targetIds: ['msg-2'],
          usage: {
            totalTokens: 600,
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      })
      assert.equal(aborted, true, 'local adapter must be interrupted immediately on budget breach')
      return null // interrupted/aborted turn returns null summary — driver must NOT forge 0 receipt!
    })

    const localDriver = new LocalPoolDriver({
      adapter: localAdapter,
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      estimateCreditsFen,
      clock: fixedClock,
      settlementWalDir: makeTempSettlementWalDir(),
      authoritativeSettleIdempotent: true,
      onSettleReceipt: (_receipt, settlement) => {
        localSettlements.push(settlement)
      },
    })

    const mockRemote = makeMockRemoteBridge(async function* (_payload, ctrl) {
      yield { kind: 'dispatched', nativeSessionId: 'ns-1', nativeTurnId: 'nt-1' }
      yield {
        kind: 'call_usage',
        sampleId: 'c1',
        scopeId: 'msg-1',
        usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      assert.equal(ctrl.isInterrupted(), false)
      yield {
        kind: 'call_usage',
        sampleId: 'c2',
        scopeId: 'msg-2',
        usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      assert.equal(
        ctrl.isInterrupted(),
        true,
        'remote bridge must be interrupted immediately on budget breach',
      )
      yield { kind: 'terminal', status: 'interrupted', errorCode: 'budget_exceeded' }
    })

    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      estimateCreditsFen,
      clock: fixedClock,
      settlementWalDir: makeTempSettlementWalDir(),
      authoritativeSettleIdempotent: true,
      onSettleReceipt: (_receipt, settlement) => {
        remoteSettlements.push(settlement)
      },
    })

    const req = makeTurnRequest({
      turnId: 'turn-budget-1',
      creditBudgetFen: 100n,
    })

    const localEvents = await collectEvents(localDriver.executeTurn(req))
    const remoteEvents = await collectEvents(remoteDriver.executeTurn(req))

    assert.deepEqual(localAdapter.interruptCalls, ['system'])
    assert.equal(mockRemote.interruptCalls.length, 1)
    assert.equal(mockRemote.interruptCalls[0]!.reason, 'budget_exceeded')

    // Compare settlements field-by-field
    assert.equal(localSettlements.length, 1)
    assert.equal(remoteSettlements.length, 1)
    assert.equal(localSettlements[0]!.terminalStatus, 'budget_exceeded')
    assert.equal(remoteSettlements[0]!.terminalStatus, 'budget_exceeded')
    assert.equal(localSettlements[0]!.budgetExceeded, true)
    assert.equal(remoteSettlements[0]!.budgetExceeded, true)
    assert.equal(localSettlements[0]!.cumulativeCreditsFen, 110n)
    assert.equal(remoteSettlements[0]!.cumulativeCreditsFen, 110n)

    const localReceiptEv = localEvents.find((e) => e.kind === 'billing_receipt')
    const remoteReceiptEv = remoteEvents.find((e) => e.kind === 'billing_receipt')
    assert.ok(localReceiptEv && localReceiptEv.kind === 'billing_receipt')
    assert.ok(remoteReceiptEv && remoteReceiptEv.kind === 'billing_receipt')

    // Self-validated TurnReceiptV5 with non-zero observed usage and IDENTICAL semanticDigest!
    const localReceipt: TurnReceiptV5 = validateTurnReceiptV5(localReceiptEv.receipt)
    const remoteReceipt: TurnReceiptV5 = validateTurnReceiptV5(remoteReceiptEv.receipt)
    assert.equal(localReceipt.status, 'interrupted')
    assert.equal(remoteReceipt.status, 'interrupted')
    assert.equal(localReceipt.errorCode, 'budget_exceeded')
    assert.equal(remoteReceipt.errorCode, 'budget_exceeded')
    assert.deepEqual(localReceipt.usage, {
      inputTokens: 900,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    assert.deepEqual(remoteReceipt.usage, localReceipt.usage)
    assert.equal(
      localReceipt.semanticDigest,
      remoteReceipt.semanticDigest,
      'Local and Remote TurnReceiptV5 must produce identical semanticDigest for the same logical turn',
    )

    const localTerminal = localEvents.at(-1)
    const remoteTerminal = remoteEvents.at(-1)
    assert.ok(localTerminal && localTerminal.kind === 'turn_terminal')
    assert.ok(remoteTerminal && remoteTerminal.kind === 'turn_terminal')
    assert.equal(localTerminal.status, 'interrupted')
    assert.equal(remoteTerminal.status, 'interrupted')
    assert.equal(localTerminal.errorCode, 'budget_exceeded')
    assert.equal(remoteTerminal.errorCode, 'budget_exceeded')
  })

  it('produces isomorphic context_compacted, tool_call_delta, multimodal pass-through, local hard readOnly policy tightening, and TurnReceiptV5 digests', async () => {
    const triplet = makeCapabilityTriplet()
    const fixedClock = () => Date.parse('2026-11-25T12:15:00.000Z')
    const leaseId = 'lease-ro-parity-1'

    // Local ToolBroker with normal default policy -> readOnly turn must tighten to read_only
    const broker = new ToolBrokerServer({
      defaultPolicy: {
        schemaVersion: 1,
        mode: 'normal',
        allowedTools: ['read_file', 'write_file'],
        allowNetworkEgress: true,
        allowWorkspaceWrite: true,
        allowSubprocessSpawn: true,
      },
    })
    broker.registerTool({
      canonicalName: 'read_file',
      readOnly: true,
      handler: async () => 'ok',
    })
    broker.registerTool({
      canonicalName: 'write_file',
      readOnly: false,
      handler: async () => 'mutated',
    })

    const localAdapter = new MockEngineAdapter(async (_params, ctrl) => {
      ctrl.emitEvent({ kind: 'block', block: { kind: 'thinking', text: 'inspecting...' } })
      ctrl.emitEvent({
        kind: 'context_compacted',
        compaction: {
          engine: 'codex',
          scope: 'native_context',
          strategy: 'native_summary',
          beforeTokens: 90_000,
          afterTokens: 18_000,
        },
      })
      ctrl.emitEvent({
        kind: 'block',
        block: {
          kind: 'tool_use',
          blockId: 'call-read-1',
          toolName: 'read_file',
          partial: true,
          partialJsonDelta: '{"path":"README.md"}',
          partialJsonOffset: 0,
        },
      })
      ctrl.emitEvent({
        kind: 'block',
        block: {
          kind: 'tool_use',
          blockId: 'call-read-1',
          toolName: 'read_file',
          partial: false,
          inputJson: { path: 'README.md' },
        },
      })
      ctrl.emitEvent({ kind: 'block', block: { kind: 'text', text: 'All checks passed.' } })
      ctrl.emitEvent({
        kind: 'call_usage',
        call: {
          callId: 'call-1',
          targetIds: ['msg-1'],
          usage: {
            totalTokens: 1450,
            inputTokens: 1000,
            outputTokens: 250,
            cacheReadTokens: 150,
            cacheCreationTokens: 50,
          },
        },
      })
      return makeSuccessSummary({
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 150,
        cacheCreationTokens: 50,
      })
    })

    const localDriver = new LocalPoolDriver({
      adapter: localAdapter,
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      toolBroker: broker,
      defaultLeaseId: leaseId,
      clock: fixedClock,
    })

    const usagePolicy: RemoteDriverUsagePolicy = {
      semanticsId: 'unified_pool_v5',
      mode: 'per_turn',
      inputField: 'input_tokens',
      outputField: 'output_tokens',
      cacheReadField: 'cache_read_tokens',
      cacheWriteField: 'cache_write_tokens',
      inputIncludesCacheRead: false,
      outputIncludesReasoning: false,
      allowCacheWrite: true,
    }
    const rawEvidenceDigest = remoteCanonicalSha256({ frame: 'remote-v4-evidence' })
    const remoteV4Receipt = buildRemoteReceiptV4({
      engineId: 'codex',
      driverId: 'remote-codex-v5',
      driverVersion: '5.0.0',
      driverDigest: remoteCanonicalSha256({ drv: '1' }),
      uid: '42',
      containerDbId: '99',
      dockerId: remoteCanonicalSha256({ docker: '1' }),
      operationId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      sessionKey: 'sess-alpha-01',
      canonicalModel: 'gpt-5.4-pro',
      upstreamModel: 'gpt-5.4-pro-2026',
      profileId: 'prof-1',
      authEpoch: 'epoch-1',
      authorityTurnId: 'abcdef0123456789abcdef0123456789',
      turnKey: FIXED_TURN_KEY,
      requestId: 'req-001',
      nativeSessionId: 'native-remote-1',
      terminalId: 'term_turn-parity-1',
      policy: usagePolicy,
      countersBaseline: null,
      countersFinal: {
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_tokens: 150,
        cache_write_tokens: 50,
      },
      nativeStatus: 'success',
      rawEvidenceDigest,
      provenance: {
        generation: '1',
        manifestHash: remoteCanonicalSha256({ m: 1 }),
        coreDigest: remoteCanonicalSha256({ c: 1 }),
        probeFingerprint: remoteCanonicalSha256({ p: 1 }),
      },
    })

    const mockRemote = makeMockRemoteBridge(async function* () {
      yield { kind: 'dispatched', nativeSessionId: 'native-remote-1', nativeTurnId: 'nt-1' }
      yield { kind: 'text_delta', channel: 'reasoning', delta: 'inspecting...' }
      yield {
        kind: 'presentation',
        item: { kind: 'compaction', text: 'native_summary' },
      }
      yield {
        kind: 'tool_call_delta',
        callId: 'call-read-1',
        toolName: 'read_file',
        argsDelta: '{"path":"README.md"}',
      }
      yield {
        kind: 'tool_call_request',
        callId: 'call-read-1',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
      }
      yield { kind: 'text_delta', channel: 'answer', delta: 'All checks passed.' }
      yield {
        kind: 'call_usage',
        sampleId: 'call-1',
        scopeId: 'msg-1',
        rawCounters: {
          input_tokens: 1000,
          output_tokens: 250,
          cache_read_tokens: 150,
          cache_write_tokens: 50,
        },
        usagePolicy,
      }
      yield { kind: 'remote_receipt_v4', receipt: remoteV4Receipt }
      yield { kind: 'terminal', status: 'success', terminalId: 'term_turn-parity-1' }
    })

    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      usagePolicy,
      clock: fixedClock,
    })

    const multimodalReq = makeTurnRequest({
      turnId: 'turn-parity-1',
      readOnly: true,
      serviceTier: 'fast',
      leaseId,
      frozenPlatformPrompt: 'FROZEN_SYSTEM_PROMPT_V5',
      input: [
        { type: 'text', text: 'Inspect screenshot and artifact' },
        {
          type: 'image_ref',
          blobId: 'blob-img-99',
          sha256: FIXED_IMAGE_SHA,
          mimeType: 'image/png',
          altText: 'UI screenshot',
        },
        {
          type: 'blob_ref',
          blobId: 'blob-doc-77',
          sha256: FIXED_BLOB_SHA,
          mimeType: 'application/pdf',
          logicalName: 'spec.pdf',
        },
      ],
    })

    const localEvents = await collectEvents(localDriver.executeTurn(multimodalReq))
    const remoteEvents = await collectEvents(remoteDriver.executeTurn(multimodalReq))

    // Verify Local ToolBroker policy was strictly tightened to read_only (blocking write_file!)
    const activePolicy: ExecutionPolicyEnvelope | null = broker.getPolicy(leaseId)
    assert.ok(activePolicy)
    assert.equal(activePolicy.mode, 'read_only')
    assert.equal(activePolicy.allowWorkspaceWrite, false)
    assert.deepEqual(activePolicy.allowedTools, ['read_file'])

    const writeArgs = { path: 'evil.txt', content: 'x' }
    const writeSha = computeSchemaFilteredArgsSha256(writeArgs, null)
    const deniedWrite: ToolCallEnvelope = {
      schemaVersion: 1,
      leaseId,
      turnId: 'turn-parity-1',
      callId: 'call-write-1',
      idempotencyKey: computeToolIdempotencyKey(leaseId, 'turn-parity-1', 'call-write-1'),
      canonicalName: 'write_file',
      arguments: writeArgs,
      argsSha256: writeSha,
      attestation: {
        kind: 'schema_filtered_hook',
        argsSha256: writeSha,
        observedAt: new Date(fixedClock()).toISOString(),
      },
    }
    const writeRes = await broker.invoke(deniedWrite)
    assert.equal(writeRes.status, 'denied')
    assert.equal(writeRes.errorCode, 'EXEC_POLICY_READ_ONLY_DENIED')

    // Verify Remote bridge preserved serviceTier, multimodal blocks, stickyHomeKey, frozenPlatformPrompt verbatim!
    assert.equal(mockRemote.dispatchedPayloads.length, 1)
    const sent = mockRemote.dispatchedPayloads[0]!
    assert.equal(sent.serviceTier, 'fast')
    assert.equal(sent.stickyHomeKey, computeStickyHomeKey(multimodalReq.sessionKey))
    assert.equal(sent.frozenPlatformPrompt, 'FROZEN_SYSTEM_PROMPT_V5')
    assert.equal(sent.input.length, 3)
    assert.equal(sent.input[1]!.type, 'image_ref')
    assert.equal(sent.input[2]!.type, 'blob_ref')

    // Verify local adapter also received structured multimodal blocks without flattening!
    assert.ok(Array.isArray(localAdapter.submittedParams[0]!.input))
    assert.equal(
      (localAdapter.submittedParams[0]!.input as Array<{ type: string }>)[1]!.type,
      'image_ref',
    )

    // Verify event-kind sequence parity (context_compacted + tool_call_delta + tool_call_request + billing_receipt + turn_terminal)
    const kindsOf = (evs: NormalizedInferenceEvent[]) => evs.map((e) => e.kind)
    assert.deepEqual(kindsOf(localEvents), [
      'turn_admitted',
      'turn_dispatched',
      'text_delta',
      'context_compacted',
      'tool_call_delta',
      'tool_call_request',
      'text_delta',
      'call_usage',
      'billing_receipt',
      'turn_terminal',
    ])
    assert.deepEqual(kindsOf(remoteEvents), kindsOf(localEvents))

    const localCompaction = localEvents.find((e) => e.kind === 'context_compacted')
    const remoteCompaction = remoteEvents.find((e) => e.kind === 'context_compacted')
    assert.ok(localCompaction?.kind === 'context_compacted')
    assert.ok(remoteCompaction?.kind === 'context_compacted')
    assert.equal(localCompaction.reason, 'native_summary')
    assert.equal(remoteCompaction.reason, 'native_summary')

    // Verify TurnReceiptV5 self-validation and semanticDigest parity!
    const localReceiptEv = localEvents.find((e) => e.kind === 'billing_receipt')
    const remoteReceiptEv = remoteEvents.find((e) => e.kind === 'billing_receipt')
    assert.ok(localReceiptEv?.kind === 'billing_receipt')
    assert.ok(remoteReceiptEv?.kind === 'billing_receipt')

    const localReceipt = validateTurnReceiptV5(localReceiptEv.receipt)
    const remoteReceipt = validateTurnReceiptV5(remoteReceiptEv.receipt)
    assert.equal(localReceipt.status, 'success')
    assert.equal(remoteReceipt.status, 'success')
    assert.equal(remoteReceipt.rawEvidenceDigest, rawEvidenceDigest)
    assert.deepEqual(localReceipt.usage, remoteReceipt.usage)
    assert.equal(localReceipt.semanticDigest, remoteReceipt.semanticDigest)
  })

  it('stopLane executes dual-proof shutdown and reaps ONLY ephemeral_turn while preserving managed_job and daemon_service', async () => {
    const triplet = makeCapabilityTriplet()
    const localRegistry = makeJobRegistry()
    const remoteRegistry = makeJobRegistry()

    const localLeaseId = 'lease-stop-local'
    const remoteLeaseId = 'lease-stop-remote'

    for (const [reg, leaseId] of [
      [localRegistry, localLeaseId],
      [remoteRegistry, remoteLeaseId],
    ] as const) {
      await reg.startJob({
        jobId: `eph-${leaseId}`,
        leaseId,
        lifecycleClass: 'ephemeral_turn',
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      })
      await reg.startJob({
        jobId: `mgr-${leaseId}`,
        leaseId,
        lifecycleClass: 'managed_job',
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      })
      await reg.startJob({
        jobId: `dmn-${leaseId}`,
        leaseId,
        lifecycleClass: 'daemon_service',
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      })
    }

    const localAdapter = new MockEngineAdapter(async () => null)
    const localDriver = new LocalPoolDriver({
      adapter: localAdapter,
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      jobRegistry: localRegistry,
      defaultLeaseId: localLeaseId,
    })

    const mockRemote = makeMockRemoteBridge(async function* () {})
    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      jobRegistry: remoteRegistry,
      defaultLeaseId: remoteLeaseId,
    })

    const localStop = await localDriver.stopLane('op-local-1', 'turn_completed')
    const remoteStop = await remoteDriver.stopLane('op-remote-1', 'turn_completed')

    // Dual-proof assertions
    assert.equal(localStop.driverStopped, true)
    assert.equal(localStop.toolHostStopped, true)
    assert.equal(localAdapter.shutdownCount, 1)
    assert.equal(localAdapter.drainCount, 1)

    assert.equal(remoteStop.driverStopped, true)
    assert.equal(remoteStop.toolHostStopped, true)
    assert.equal(mockRemote.stopRemoteCalls.length, 1)
    assert.equal(mockRemote.stopToolHostCalls.length, 1)

    // Verify ONLY ephemeral_turn was reaped; managed_job & daemon_service remain running!
    for (const [reg, leaseId, proof] of [
      [localRegistry, localLeaseId, localStop.reapProof],
      [remoteRegistry, remoteLeaseId, remoteStop.reapProof],
    ] as const) {
      assert.ok(proof)
      assert.deepEqual(proof.reapedJobIds, [`eph-${leaseId}`])
      assert.deepEqual([...proof.survivingJobIds].sort(), [`dmn-${leaseId}`, `mgr-${leaseId}`])

      const jobs = await reg.listJobs(leaseId)
      const byId = new Map(jobs.map((j) => [j.jobId, j]))
      assert.equal(byId.get(`eph-${leaseId}`)?.state, 'killed')
      assert.equal(byId.get(`mgr-${leaseId}`)?.state, 'running')
      assert.equal(byId.get(`dmn-${leaseId}`)?.state, 'running')
    }
  })

  it('B07(a): settles onSettleReceipt exactly once even when consumer detaches immediately after turn_dispatched', async () => {
    const triplet = makeCapabilityTriplet()
    const fixedClock = () => Date.parse('2026-11-25T13:00:00.000Z')

    const localSettlements: Array<{ receipt: TurnReceiptV5; info: TurnSettlementInfo }> = []
    const remoteSettlements: Array<{ receipt: TurnReceiptV5; info: TurnSettlementInfo }> = []

    const localAdapter = new MockEngineAdapter(async (_params, ctrl) => {
      await new Promise((r) => setTimeout(r, 25))
      ctrl.emitEvent({ kind: 'block', block: { kind: 'text', text: 'background completion' } })
      ctrl.emitEvent({
        kind: 'call_usage',
        call: {
          callId: 'call-bg-1',
          targetIds: ['msg-bg-1'],
          usage: {
            totalTokens: 320,
            inputTokens: 200,
            outputTokens: 120,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      })
      return makeSuccessSummary({
        inputTokens: 200,
        outputTokens: 120,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    })

    const localDriver = new LocalPoolDriver({
      adapter: localAdapter,
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      clock: fixedClock,
      settlementWalDir: makeTempSettlementWalDir(),
      authoritativeSettleIdempotent: true,
      onSettleReceipt: (receipt, info) => {
        localSettlements.push({ receipt, info })
      },
    })

    const mockRemote = makeMockRemoteBridge(async function* () {
      yield { kind: 'dispatched', nativeSessionId: 'ns-bg-1', nativeTurnId: 'nt-bg-1' }
      await new Promise((r) => setTimeout(r, 25))
      yield { kind: 'text_delta', channel: 'answer', delta: 'background completion' }
      yield {
        kind: 'call_usage',
        sampleId: 'call-bg-1',
        scopeId: 'msg-bg-1',
        usage: { inputTokens: 200, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      yield {
        kind: 'terminal',
        status: 'success',
        usage: { inputTokens: 200, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    })

    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      clock: fixedClock,
      settlementWalDir: makeTempSettlementWalDir(),
      authoritativeSettleIdempotent: true,
      onSettleReceipt: (receipt, info) => {
        remoteSettlements.push({ receipt, info })
      },
    })

    for (const [label, driver, settlements] of [
      ['local', localDriver, localSettlements],
      ['remote', remoteDriver, remoteSettlements],
    ] as const) {
      const adm = await driver.admit(makeTurnRequest({ turnId: `turn-detach-${label}` }))
      const iter = driver.dispatch(adm.admissionId)[Symbol.asyncIterator]()

      // Pull until turn_dispatched, then immediately disconnect consumer via iter.return()
      let sawDispatched = false
      while (!sawDispatched) {
        const step = await iter.next()
        assert.equal(step.done, false, `${label}: stream ended before turn_dispatched`)
        if (step.value.kind === 'turn_dispatched') {
          sawDispatched = true
        }
      }
      await iter.return?.()

      // Background coroutine must still finish turn and execute onSettleReceipt exactly once
      const settledReceipt = await driver.waitForSettlement(adm.admissionId)
      assert.ok(settledReceipt !== null, `${label}: waitForSettlement must return TurnReceiptV5`)
      const validated = validateTurnReceiptV5(settledReceipt)
      assert.equal(validated.status, 'success')
      assert.deepEqual(validated.usage, {
        inputTokens: 200,
        outputTokens: 120,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
      assert.equal(
        settlements.length,
        1,
        `${label}: onSettleReceipt must be invoked exactly once after consumer detach`,
      )

      // Calling waitForSettlement again is idempotent and never double-settles
      const secondWait = await driver.waitForSettlement(adm.admissionId)
      assert.equal(secondWait?.receiptDigest, validated.receiptDigest)
      assert.equal(settlements.length, 1)
    }
  })

  it('B07(b): abandon does not poison state on journal write failure; retry persists once and third call is idempotent', async () => {
    const triplet = makeCapabilityTriplet()

    let localJournalAttempts = 0
    let localJournalSuccesses = 0
    const localDriver = new LocalPoolDriver({
      adapter: new MockEngineAdapter(async () => null),
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      onAbandonJournal: async () => {
        localJournalAttempts += 1
        if (localJournalAttempts === 1) {
          throw new Error('ABANDON_JOURNAL_WRITE_TRANSIENT_FAILURE')
        }
        localJournalSuccesses += 1
      },
    })

    let remoteJournalAttempts = 0
    let remoteJournalSuccesses = 0
    const mockRemote = makeMockRemoteBridge(async function* () {})
    const remoteDriver = new RemotePoolV5Driver({
      bridge: mockRemote.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      onAbandonJournal: async () => {
        remoteJournalAttempts += 1
        if (remoteJournalAttempts === 1) {
          throw new Error('ABANDON_JOURNAL_WRITE_TRANSIENT_FAILURE')
        }
        remoteJournalSuccesses += 1
      },
    })

    for (const [label, driver, getAttempts, getSuccesses] of [
      ['local', localDriver, () => localJournalAttempts, () => localJournalSuccesses],
      ['remote', remoteDriver, () => remoteJournalAttempts, () => remoteJournalSuccesses],
    ] as const) {
      const adm = await driver.admit(makeTurnRequest({ turnId: `turn-abandon-retry-${label}` }))

      // 1st attempt: journal write throws -> abandon MUST reject and NOT poison abandoned=true
      await assert.rejects(
        () => driver.abandon(adm.admissionId, 'pre_dispatch_retry_test'),
        /ABANDON_JOURNAL_WRITE_TRANSIENT_FAILURE/,
      )
      assert.equal(getAttempts(), 1)
      assert.equal(getSuccesses(), 0)

      // 2nd attempt: journal write succeeds -> zero-settled exactly once
      const second = await driver.abandon(adm.admissionId, 'pre_dispatch_retry_test')
      assert.deepEqual(second, { abandoned: true, zeroSettled: true })
      assert.equal(getAttempts(), 2)
      assert.equal(getSuccesses(), 1)

      // 3rd attempt: idempotent return with ZERO additional journal writes
      const third = await driver.abandon(adm.admissionId, 'pre_dispatch_retry_test')
      assert.deepEqual(third, { abandoned: true, zeroSettled: true })
      assert.equal(getAttempts(), 2)
      assert.equal(getSuccesses(), 1)
    }
  })

  it('B07-R2: durable pending-settlement recovery settles exactly once after early disconnect + transient settle failure OR lost-ack post-write', async () => {
    const triplet = makeCapabilityTriplet()

    const makeMemoryOutbox = () => {
      const store = new Map<string, import('../localPoolDriver.js').PendingSettlementRecord>()
      const outbox: import('../localPoolDriver.js').PendingSettlementOutbox = {
        put: (rec) => {
          store.set(rec.admissionId, rec)
        },
        get: (id) => store.get(id) ?? null,
        delete: (id) => {
          store.delete(id)
        },
        list: () => [...store.values()],
      }
      return { store, outbox }
    }

    for (const mode of ['fail_before_write', 'lost_ack_after_write'] as const) {
      const ledgerLocal = new Map<string, TurnReceiptV5>()
      let localAttempts = 0
      const localOutbox = makeMemoryOutbox()
      const localAdapter = new MockEngineAdapter(async (params) => {
        await new Promise((r) => setTimeout(r, 5))
        params.onEvent({ kind: 'block', block: { kind: 'text', text: 'done' } as any })
        params.onEvent({
          kind: 'final',
          meta: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        })
        return {
          usage: {
            cost: 0,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 120,
          },
          assistantText: 'done',
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
      })
      const localDriver = new LocalPoolDriver({
        adapter: localAdapter,
        manifest: buildLocalDriverCapabilityManifest({
          engineFamily: 'codex',
          authorityEngine: 'codex',
          driverId: 'local-codex-v5',
          driverVersion: '5.0.0',
          models: [triplet],
        }),
        pendingSettlementOutbox: localOutbox.outbox,
        probeAuthoritativeSettlement: (reqId) => ledgerLocal.has(reqId),
        onSettleReceipt: async (receipt) => {
          localAttempts += 1
          if (localAttempts === 1) {
            if (mode === 'lost_ack_after_write') {
              ledgerLocal.set(receipt.requestId, receipt)
            }
            throw new Error(`SETTLE_TRANSIENT_${mode}`)
          }
          ledgerLocal.set(receipt.requestId, receipt)
        },
      })

      const ledgerRemote = new Map<string, TurnReceiptV5>()
      let remoteAttempts = 0
      const remoteOutbox = makeMemoryOutbox()
      const mockRemote = makeMockRemoteBridge(async function* () {
        yield { kind: 'text_delta', channel: 'answer', delta: 'done' }
        yield {
          kind: 'terminal',
          status: 'success',
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }
      })
      const remoteDriver = new RemotePoolV5Driver({
        bridge: mockRemote.bridge,
        manifest: buildRemoteDriverCapabilityManifest({
          engineFamily: 'codex',
          authorityEngine: 'codex',
          driverId: 'remote-codex-v5',
          driverVersion: '5.0.0',
          models: [triplet],
        }),
        pendingSettlementOutbox: remoteOutbox.outbox,
        probeAuthoritativeSettlement: (reqId) => ledgerRemote.has(reqId),
        onSettleReceipt: async (receipt) => {
          remoteAttempts += 1
          if (remoteAttempts === 1) {
            if (mode === 'lost_ack_after_write') {
              ledgerRemote.set(receipt.requestId, receipt)
            }
            throw new Error(`SETTLE_TRANSIENT_${mode}`)
          }
          ledgerRemote.set(receipt.requestId, receipt)
        },
      })

      for (const [label, driver, ledger, outboxStore, getAttempts] of [
        ['local', localDriver, ledgerLocal, localOutbox.store, () => localAttempts],
        ['remote', remoteDriver, ledgerRemote, remoteOutbox.store, () => remoteAttempts],
      ] as const) {
        const reqId = `req-b07-${mode}-${label}`
        const adm = await driver.admit(
          makeTurnRequest({ turnId: `turn-b07-${mode}-${label}`, requestId: reqId }),
        )
        const iter = driver.dispatch(adm.admissionId)[Symbol.asyncIterator]()
        let sawDispatched = false
        while (!sawDispatched) {
          const step = await iter.next()
          assert.equal(step.done, false, `${label}/${mode}: stream ended before turn_dispatched`)
          if (step.value.kind === 'turn_dispatched') {
            sawDispatched = true
          }
        }
        // Subscriber detaches immediately after turn_dispatched
        await iter.return?.()

        // Allow background execution + first failing settle attempt to finish
        await new Promise((r) => setTimeout(r, 30))
        assert.equal(getAttempts(), 1)
        assert.equal(
          outboxStore.size,
          1,
          `${label}/${mode}: pending settlement must remain in durable outbox after failed settle`,
        )

        // Recovery via waitForSettlement retries idempotently and clears outbox
        const recovered = await driver.waitForSettlement(adm.admissionId)
        assert.ok(recovered !== null)
        assert.equal(recovered.requestId, reqId)
        assert.equal(ledger.size, 1, `${label}/${mode}: authoritative ledger must have exactly 1 record`)
        assert.equal(outboxStore.size, 0, `${label}/${mode}: outbox cleared only after authoritative confirmation`)
        if (mode === 'lost_ack_after_write') {
          assert.equal(
            getAttempts(),
            1,
            `${label}: probeAuthoritativeSettlement must prevent second write when first succeeded before lost ack`,
          )
        } else {
          assert.equal(getAttempts(), 2)
        }

        // Calling waitForSettlement again AFTER recovery must return the settled receipt (never re-throw stale rejected promise)
        const afterRecovery = await driver.waitForSettlement(adm.admissionId)
        assert.equal(afterRecovery?.receiptDigest, recovered.receiptDigest)
        assert.equal(ledger.size, 1)
      }
    }
  })

  it('B07-R2(b): disk settlementWalDir recovers pending settlements across restarted driver instances via lookupAuthoritativeSettlement (exact-once ledger)', async () => {
    const triplet = makeCapabilityTriplet()

    for (const mode of ['fail_before_write', 'lost_ack_after_write'] as const) {
      for (const kind of ['local', 'remote'] as const) {
        const walDir = mkdtempSync(join(tmpdir(), `ocv5-b07-wal-${kind}-${mode}-`))
        try {
          const ledger = new Map<string, TurnReceiptV5>()
          let settleCalls = 0
          const reqId = `req-b07-disk-${kind}-${mode}`
          const turnId = `turn-b07-disk-${kind}-${mode}`

          const onSettleReceipt = async (receipt: TurnReceiptV5) => {
            settleCalls += 1
            if (settleCalls === 1) {
              if (mode === 'lost_ack_after_write') {
                ledger.set(receipt.requestId, receipt)
              }
              throw new Error(`DISK_SETTLE_TRANSIENT_${mode}`)
            }
            ledger.set(receipt.requestId, receipt)
          }

          const lookupAuthoritativeSettlement = (billingKey: string) => {
            const existing = ledger.get(billingKey)
            return existing ? { settled: true, receipt: existing } : { settled: false }
          }

          const makeDriver = () => {
            if (kind === 'local') {
              const adapter = new MockEngineAdapter(async (params) => {
                await new Promise((r) => setTimeout(r, 5))
                params.onEvent({ kind: 'block', block: { kind: 'text', text: 'persisted' } as any })
                return makeSuccessSummary({
                  inputTokens: 150,
                  outputTokens: 45,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                })
              })
              return new LocalPoolDriver({
                adapter,
                manifest: buildLocalDriverCapabilityManifest({
                  engineFamily: 'codex',
                  authorityEngine: 'codex',
                  driverId: 'local-codex-v5',
                  driverVersion: '5.0.0',
                  models: [triplet],
                }),
                settlementWalDir: walDir,
                lookupAuthoritativeSettlement,
                onSettleReceipt,
              })
            }
            const mockRemote = makeMockRemoteBridge(async function* () {
              yield { kind: 'text_delta', channel: 'answer', delta: 'persisted' }
              yield {
                kind: 'terminal',
                status: 'success',
                usage: { inputTokens: 150, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0 },
              }
            })
            return new RemotePoolV5Driver({
              bridge: mockRemote.bridge,
              manifest: buildRemoteDriverCapabilityManifest({
                engineFamily: 'codex',
                authorityEngine: 'codex',
                driverId: 'remote-codex-v5',
                driverVersion: '5.0.0',
                models: [triplet],
              }),
              settlementWalDir: walDir,
              lookupAuthoritativeSettlement,
              onSettleReceipt,
            })
          }

          // Driver instance 1 dispatches, subscriber detaches early, first settle write fails
          const driver1 = makeDriver()
          const adm = await driver1.admit(makeTurnRequest({ turnId, requestId: reqId }))
          const iter = driver1.dispatch(adm.admissionId)[Symbol.asyncIterator]()
          let sawDispatched = false
          while (!sawDispatched) {
            const step = await iter.next()
            assert.equal(step.done, false)
            if (step.value.kind === 'turn_dispatched') sawDispatched = true
          }
          await iter.return?.()
          await new Promise((r) => setTimeout(r, 30))

          assert.equal(settleCalls, 1)
          const pendingBeforeRestart = await driver1.listPendingSettlements()
          assert.equal(pendingBeforeRestart.length, 1)
          assert.equal(pendingBeforeRestart[0]!.billingIdempotencyKey, reqId)

          // Simulate full process restart: brand new driver2 reads from the SAME settlementWalDir
          const driver2 = makeDriver()
          const report = await driver2.recoverPendingSettlements()
          assert.equal(report.failed.length, 0)
          assert.equal(report.settled.length, 1)
          assert.equal(report.settled[0]!.requestId, reqId)
          assert.equal(ledger.size, 1, `${kind}/${mode}: authoritative ledger must have exactly 1 entry`)
          assert.equal((await driver2.listPendingSettlements()).length, 0)

          if (mode === 'lost_ack_after_write') {
            assert.equal(report.adoptedFromLedger, 1)
            assert.equal(report.replayedToLedger, 0)
            assert.equal(settleCalls, 1, 'already-written ledger record must NEVER be charged twice')
          } else {
            assert.equal(report.adoptedFromLedger, 0)
            assert.equal(report.replayedToLedger, 1)
            assert.equal(settleCalls, 2)
          }

          // Calling retrySettlement after convergence is a safe no-op with zero extra writes
          const noop = await driver2.retrySettlement(reqId)
          assert.equal(noop, null)
          assert.equal(ledger.size, 1)
        } finally {
          rmSync(walDir, { recursive: true, force: true })
        }
      }
    }
  })

  it('B07-R2(c): rejects billable dispatch without durable outbox, retains pending record when recovery lacks writer, and publishes authoritative returned receipt', async () => {
    const triplet = makeCapabilityTriplet()

    // 1. Default construction with onSettleReceipt and NO settlementWalDir/pendingSettlementOutbox
    //    MUST fail closed with DURABLE_SETTLEMENT_STORE_REQUIRED BEFORE executing adapter/bridge!
    let localRan = 0
    let remoteRan = 0
    const ephemeralLocal = new LocalPoolDriver({
      adapter: new MockEngineAdapter(async () => {
        localRan += 1
        return makeSuccessSummary({
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })
      }),
      manifest: buildLocalDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'local-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      onSettleReceipt: () => {},
    })
    const ephemeralRemoteBridge = makeMockRemoteBridge(async function* () {
      remoteRan += 1
      yield { kind: 'terminal', status: 'success' }
    })
    const ephemeralRemote = new RemotePoolV5Driver({
      bridge: ephemeralRemoteBridge.bridge,
      manifest: buildRemoteDriverCapabilityManifest({
        engineFamily: 'codex',
        authorityEngine: 'codex',
        driverId: 'remote-codex-v5',
        driverVersion: '5.0.0',
        models: [triplet],
      }),
      onSettleReceipt: () => {},
    })

    for (const [label, driver] of [
      ['local', ephemeralLocal],
      ['remote', ephemeralRemote],
    ] as const) {
      const adm = await driver.admit(makeTurnRequest({ turnId: `turn-ephem-${label}` }))
      assert.throws(() => driver.dispatch(adm.admissionId), /DURABLE_SETTLEMENT_STORE_REQUIRED/)
    }
    assert.equal(localRan, 0, 'local adapter must not run when durable settlement outbox is missing')
    assert.equal(remoteRan, 0, 'remote bridge must not run when durable settlement outbox is missing')

    // 2. Recovery instance WITHOUT onSettleReceipt (no writer) when authoritative ledger says NOT settled:
    //    MUST preserve pending record on disk (pending=1, replayed=0, skippedNoWriter=1)!
    for (const kind of ['local', 'remote'] as const) {
      const walDir = makeTempSettlementWalDir(`ocv5-b07-nowriter-${kind}-`)
      const ledger = new Map<string, TurnReceiptV5>()
      let writerCalls = 0
      const reqId = `req-nowriter-${kind}`

      const makeInstance = (withWriter: boolean) => {
        const writer = withWriter
          ? async (receipt: TurnReceiptV5) => {
              writerCalls += 1
              if (writerCalls === 1) throw new Error('FIRST_WRITE_FAILED')
              ledger.set(receipt.requestId, receipt)
            }
          : undefined
        if (kind === 'local') {
          return new LocalPoolDriver({
            adapter: new MockEngineAdapter(async () =>
              makeSuccessSummary({
                inputTokens: 50,
                outputTokens: 10,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              }),
            ),
            manifest: buildLocalDriverCapabilityManifest({
              engineFamily: 'codex',
              authorityEngine: 'codex',
              driverId: 'local-codex-v5',
              driverVersion: '5.0.0',
              models: [triplet],
            }),
            settlementWalDir: walDir,
            lookupAuthoritativeSettlement: (k) =>
              ledger.has(k) ? { settled: true, receipt: ledger.get(k)! } : { settled: false },
            ...(writer ? { onSettleReceipt: writer } : {}),
          })
        }
        const bridgeMock = makeMockRemoteBridge(async function* () {
          yield {
            kind: 'terminal',
            status: 'success',
            usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          }
        })
        return new RemotePoolV5Driver({
          bridge: bridgeMock.bridge,
          manifest: buildRemoteDriverCapabilityManifest({
            engineFamily: 'codex',
            authorityEngine: 'codex',
            driverId: 'remote-codex-v5',
            driverVersion: '5.0.0',
            models: [triplet],
          }),
          settlementWalDir: walDir,
          lookupAuthoritativeSettlement: (k) =>
            ledger.has(k) ? { settled: true, receipt: ledger.get(k)! } : { settled: false },
          ...(writer ? { onSettleReceipt: writer } : {}),
        })
      }

      const writerDriver = makeInstance(true)
      const adm = await writerDriver.admit(
        makeTurnRequest({ turnId: `turn-nowriter-${kind}`, requestId: reqId }),
      )
      const iter = writerDriver.dispatch(adm.admissionId)[Symbol.asyncIterator]()
      while (true) {
        const step = await iter.next()
        if (step.done || step.value.kind === 'turn_dispatched') break
      }
      await iter.return?.()
      await new Promise((r) => setTimeout(r, 25))
      assert.equal(writerCalls, 1)
      assert.equal(ledger.size, 0)

      // Restart WITHOUT writer -> MUST NOT report replayed and MUST NOT delete pending record!
      const noWriterRecovery = makeInstance(false)
      const noWriterReport = await noWriterRecovery.recoverPendingSettlements()
      assert.equal(noWriterReport.replayedToLedger, 0)
      assert.equal(noWriterReport.adoptedFromLedger, 0)
      assert.equal(noWriterReport.skippedNoWriter, 1)
      assert.equal(noWriterReport.settled.length, 0)
      assert.equal(noWriterReport.failed.length, 1)
      assert.equal(noWriterReport.failed[0]!.code, 'writer_unavailable')
      assert.equal((await noWriterRecovery.listPendingSettlements()).length, 1)
      assert.equal(ledger.size, 0)

      // Restart WITH writer -> settles once and clears pending record
      const withWriterRecovery = makeInstance(true)
      const okReport = await withWriterRecovery.recoverPendingSettlements()
      assert.equal(okReport.replayedToLedger, 1)
      assert.equal(okReport.skippedNoWriter, 0)
      assert.equal(okReport.failed.length, 0)
      assert.equal(ledger.size, 1)
      assert.equal((await withWriterRecovery.listPendingSettlements()).length, 0)
    }

    // 3. Authoritative returned TurnReceiptV5 (different from local candidate receipt) MUST be
    //    published in billing_receipt event AND returned by waitForSettlement() for BOTH drivers!
    for (const kind of ['local', 'remote'] as const) {
      const walDir = makeTempSettlementWalDir(`ocv5-b07-auth-receipt-${kind}-`)
      const reqId = `req-auth-receipt-${kind}`
      const authHolder: { receipt: TurnReceiptV5 | null } = { receipt: null }

      const buildAuthoritativeOverride = (candidate: TurnReceiptV5): TurnReceiptV5 => {
        const auth: TurnReceiptV5 = {
          ...candidate,
          usage: {
            inputTokens: 999,
            outputTokens: 333,
            cacheReadTokens: 11,
            cacheWriteTokens: 22,
          },
          receiptDigest: remoteCanonicalSha256({ authoritativeOverride: reqId }),
        }
        authHolder.receipt = auth
        return auth
      }

      const driver =
        kind === 'local'
          ? new LocalPoolDriver({
              adapter: new MockEngineAdapter(async () =>
                makeSuccessSummary({
                  inputTokens: 100,
                  outputTokens: 20,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                }),
              ),
              manifest: buildLocalDriverCapabilityManifest({
                engineFamily: 'codex',
                authorityEngine: 'codex',
                driverId: 'local-codex-v5',
                driverVersion: '5.0.0',
                models: [triplet],
              }),
              settlementWalDir: walDir,
              authoritativeSettleIdempotent: true,
              onSettleReceipt: (candidate) => buildAuthoritativeOverride(candidate),
            })
          : new RemotePoolV5Driver({
              bridge: makeMockRemoteBridge(async function* () {
                yield {
                  kind: 'terminal',
                  status: 'success',
                  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
                }
              }).bridge,
              manifest: buildRemoteDriverCapabilityManifest({
                engineFamily: 'codex',
                authorityEngine: 'codex',
                driverId: 'remote-codex-v5',
                driverVersion: '5.0.0',
                models: [triplet],
              }),
              settlementWalDir: walDir,
              authoritativeSettleIdempotent: true,
              onSettleReceipt: (candidate) => buildAuthoritativeOverride(candidate),
            })

      const adm = await driver.admit(
        makeTurnRequest({ turnId: `turn-auth-receipt-${kind}`, requestId: reqId }),
      )
      const events = await collectEvents(driver.dispatch(adm.admissionId))
      const billingEv = events.find((e) => e.kind === 'billing_receipt')
      assert.ok(billingEv && billingEv.kind === 'billing_receipt')
      assert.ok(authHolder.receipt !== null)
      assert.equal(billingEv.receipt.receiptDigest, authHolder.receipt.receiptDigest)
      assert.equal(billingEv.receipt.usage.inputTokens, 999)
      assert.equal(billingEv.receipt.usage.outputTokens, 333)

      const waited = await driver.waitForSettlement(adm.admissionId)
      assert.equal(waited?.receiptDigest, authHolder.receipt.receiptDigest)
      assert.equal(waited?.usage.inputTokens, 999)
    }
  })
})
