/**
 * Unified `EngineAdapter` for all `remote-driver-v4` remote-pool drivers (`cc`, `codex`, and
 * future 5-duty drivers such as `example_echo`).
 *
 * Zero driver-specific conditionals:
 * - Consumes normalized `RemoteSecurityEvent`s (`toolCallObserved`, `textDelta`, `usage`, `turnTerminal`)
 *   and `RemotePresentationItem`s (`compaction`, `status`),
 * - Derives `EngineCapabilities` and optional `EngineBillingEvent` sideband strictly from
 *   `executionBackend.authorityEngine`,
 * - Delegates container tool execution, observation gating, lease renewal, and dual-proof stop
 *   to `RemoteContainerLane`.
 */
import { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  parseRemoteDriverExecutionBackend,
  sameRemoteExecutionBackend,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type PromptPrivacyPolicy,
  type RemoteDriverExecutionBackend,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
  type TurnTokenUsageSnapshot,
} from '@openclaude/protocol'
import { buildCodexBillingEvent } from '../engine/codexAdapter.js'
import type { IntelligentUiApplied } from '../promptSlots.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineTurnRun,
  TurnParams,
} from '../engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  PartialSnapshot,
  PhantomSignals,
  SegmentRecord,
  TurnSummary,
  TurnToolEntry,
} from '../engine/engineEvents.js'
import { engineSessionId } from '../engine/engineSessionId.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { ExecutionTarget } from '../remoteTarget.js'
import { RemoteContainerLane, type RemoteContainerLaneOptions } from './containerLane.js'
import { parseRemoteV4ResumeId, remoteV4ResumeId } from './resumeId.js'
import { remotePoolNeed } from './types.js'

const DEFAULT_PHANTOM_SIGNALS: PhantomSignals = {
  apiState: 'called',
  skipReason: null,
}

function renderToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return JSON.stringify(b)
      })
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}

function formatInputPreview(input: unknown): string {
  const raw = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw
}

export class RemoteEngineAdapter extends EventEmitter implements EngineAdapter {
  readonly executionBackend: RemoteDriverExecutionBackend
  readonly engineId: string
  readonly capabilities: EngineCapabilities

  private readonly lane: RemoteContainerLane
  private readonly _engineSessionId: string
  private readonly _initialResumeNativeId?: string
  private _nativeId: string | null
  private _spawnEmitted = false
  private _model: string | undefined
  private _effortLevel: string | undefined
  private _toolsets: string[] | undefined
  private _executionTarget: ExecutionTarget = { kind: 'local' }
  private _activeRun?: {
    readonly getPartialSnapshot: () => PartialSnapshot
    readonly getPendingTools: () => number
    readonly finalizeNull: () => void
    readonly drainPromise: Promise<void>
  }

  lastActivityAt = Date.now()

  constructor(opts: EngineCreateOpts, laneOptions: RemoteContainerLaneOptions = {}) {
    super()
    const backend = parseRemoteDriverExecutionBackend(opts.executionBackend)
    const parsedResume = opts.resumeSessionId ? parseRemoteV4ResumeId(opts.resumeSessionId) : null
    remotePoolNeed(
      backend.sessionKey === opts.sessionKey &&
        !opts.hermeticNoTools &&
        !opts.advisorExecutionLock &&
        !opts.delegationDepth &&
        opts.executionTarget?.kind !== 'remote' &&
        (!opts.resumeSessionId || parsedResume?.bindingId === backend.operationId),
      'REMOTE_ADAPTER_PROFILE_UNSUPPORTED',
    )

    this.executionBackend = backend
    this.engineId = backend.authorityEngine
    this._engineSessionId = engineSessionId(opts.sessionKey)
    this._initialResumeNativeId = parsedResume?.nativeId
    this._nativeId = parsedResume?.nativeId ?? null
    this._model = opts.model
    this._effortLevel = opts.effortLevel
    this._toolsets = opts.agentToolsets

    const isCodexAuthority = backend.authorityEngine === 'codex'
    this.capabilities = {
      billingMode: isCodexAuthority ? 'engine-reported' : 'proxy',
      supportsEffort: true,
      resumeKind: isCodexAuthority ? 'codex-thread' : 'ccb-session',
      needsServerRequestId: isCodexAuthority,
      historyMode: 'native-resume',
      permissionModel: 'native',
      emitsCallUsage: false,
      emitsToolInputDeltas: false,
      supportsNativeCompact: false,
      multimodalInput: 'text-only',
    }

    this.lane = new RemoteContainerLane(
      {
        ...opts,
        resumeSessionId: parsedResume?.nativeId,
      },
      laneOptions,
    )
    remotePoolNeed(this.lane.binding.canonicalModel === opts.model, 'REMOTE_MODEL_BINDING_MISMATCH')
  }

  get fenceReason(): string | undefined {
    return this.lane.fenceError?.message
  }

  async start(): Promise<void> {
    // Admission occurs lazily on the first authorized turn (`beginTurn`/`executeTurn`).
  }

  preheat(): Promise<void> {
    return Promise.resolve()
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    remotePoolNeed(
      params.modelAuthority?.executionDescriptor !== undefined &&
        sameRemoteExecutionBackend(
          params.modelAuthority.executionDescriptor.executionBackend,
          this.executionBackend,
        ),
      'REMOTE_TURN_BACKEND_MISMATCH',
    )
    const validated = this.lane.validateTurnSubmission(params)
    this.lastActivityAt = Date.now()

    let assistantBuf = ''
    let thinkingBuf = ''
    const assistantSegments: SegmentRecord[] = []
    const thinkingSegments: SegmentRecord[] = []
    let currentTextSegmentIndex = 0
    let currentThinkingSegmentIndex = 0
    let pendingTextBump = false
    let pendingThinkingBump = false
    const toolsById = new Map<string, TurnToolEntry>()
    const toolStartPerf = new Map<string, number>()
    const emittedToolResultIds = new Set<string>()
    const runtimeEvents: DurableRuntimeEvent[] = []
    let pendingToolCalls = 0
    let finalized = false
    let userCancelled = false
    const startedAtMs = Date.now()
    let localOrdinal = 0
    const nextOrdinal = () => (params.nextDurableEventOrdinal ? params.nextDurableEventOrdinal() : ++localOrdinal)

    let resolveSubmitted!: () => void
    let rejectSubmitted!: (err: Error) => void
    let submittedSettled = false
    const submitted = new Promise<void>((res, rej) => {
      resolveSubmitted = () => {
        if (!submittedSettled) {
          submittedSettled = true
          res()
        }
      }
      rejectSubmitted = (err: Error) => {
        if (!submittedSettled) {
          submittedSettled = true
          rej(err)
        }
      }
    })

    let resolveSummary!: (value: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((res) => {
      resolveSummary = res
    })

    const getPartialSnapshot = (): PartialSnapshot => ({
      assistantText: assistantBuf,
      thinkingText: thinkingBuf,
      completedTools: [...toolsById.values()].map((t) => structuredClone(t)),
      assistantSegments: assistantSegments.map((s) => ({ ...s })),
      thinkingSegments: thinkingSegments.map((s) => ({ ...s })),
      runtimeEvents: runtimeEvents.map((e) => structuredClone(e)),
    })

    const finalizeWith = (value: TurnSummary | null): void => {
      if (finalized) return
      finalized = true
      if (this._activeRun === activeHandle) {
        this._activeRun = undefined
      }
      resolveSummary(value)
    }

    const completeToolResult = (callId: string, toolName: string, content: unknown, isError: boolean): void => {
      if (emittedToolResultIds.has(callId)) return
      emittedToolResultIds.add(callId)
      if (pendingToolCalls > 0) pendingToolCalls -= 1

      const fullOutput = renderToolResultText(content)
      const preview = fullOutput.length > 3000 ? `${fullOutput.slice(0, 3000)}…` : fullOutput
      const startedPerf = toolStartPerf.get(callId)
      toolStartPerf.delete(callId)
      const durationMs = startedPerf !== undefined ? Math.max(0, Math.round(performance.now() - startedPerf)) : 0
      const nowMs = Date.now()

      const existing = toolsById.get(callId)
      const inputPreview = existing?.inputPreview ?? '{}'
      if (existing) {
        existing.output = fullOutput
        existing.outputJson = content
        existing.completed = true
        existing.isError = isError
        existing.durationMs = durationMs
        existing.ts = nowMs
      } else {
        toolsById.set(callId, {
          toolUseId: callId,
          blockId: callId,
          toolName,
          inputJson: {},
          inputPreview,
          output: fullOutput,
          outputJson: content,
          completed: true,
          isError,
          durationMs,
          ts: nowMs,
          arrivedAt: nowMs,
          eventOrdinal: nextOrdinal(),
        })
      }

      if (!finalized) {
        params.onEvent({
          kind: 'block',
          block: {
            kind: 'tool_result',
            blockId: `${callId}:result`,
            toolUseBlockId: callId,
            toolName,
            isError,
            preview,
            output: fullOutput,
            outputJson: content,
          } as OutboundContentBlock,
        })
        params.onEvent({
          kind: 'tool_result_detected',
          result: {
            toolUseId: callId,
            toolName,
            preview: preview.slice(0, 500),
            isError,
            durationMs,
            inputPreview,
          },
        })
      }
    }

    const handleSecurityEvent = (ev: RemoteSecurityEvent): void => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      if (finalized) return

      const payload = ev.payload
      if (payload.kind === 'toolCallObserved' && payload.phase === 'started') {
        const callId = payload.callId
        const toolName = this.lane.resolveClientToolName(payload.name)
        const inputPreview = formatInputPreview(payload.arguments)
        const nowMs = Date.now()
        params.toolUseIdToName.set(callId, toolName)
        if (assistantSegments.length > 0) pendingTextBump = true
        if (thinkingSegments.length > 0) pendingThinkingBump = true
        pendingToolCalls += 1
        toolStartPerf.set(callId, performance.now())

        toolsById.set(callId, {
          toolUseId: callId,
          blockId: callId,
          toolName,
          inputJson: structuredClone(payload.arguments),
          inputPreview,
          output: '',
          completed: false,
          isError: false,
          durationMs: 0,
          ts: nowMs,
          arrivedAt: nowMs,
          eventOrdinal: nextOrdinal(),
        })

        params.onEvent({
          kind: 'tool_use_detected',
          tool: {
            id: callId,
            name: toolName,
            input: structuredClone(payload.arguments),
          },
        })
        const block: Record<string, unknown> = {
          kind: 'tool_use',
          blockId: callId,
          toolName,
          inputPreview,
          inputJson: structuredClone(payload.arguments),
          partial: false,
        }
        if (params.toolMessageIdFactory) {
          block.messageId = params.toolMessageIdFactory(callId)
        }
        params.onEvent({ kind: 'block', block: block as unknown as OutboundContentBlock })
        return
      }

      if (payload.kind === 'textDelta' && payload.delta.length > 0) {
        if (payload.channel === 'answer') {
          if (pendingTextBump) {
            currentTextSegmentIndex += 1
            pendingTextBump = false
          }
          assistantBuf += payload.delta
          let cur = assistantSegments[assistantSegments.length - 1]
          if (!cur || cur.index !== currentTextSegmentIndex) {
            cur = {
              index: currentTextSegmentIndex,
              text: '',
              ts: Date.now(),
              eventOrdinal: nextOrdinal(),
            }
            assistantSegments.push(cur)
          }
          cur.text += payload.delta
          const block: Record<string, unknown> = {
            kind: 'text',
            text: payload.delta,
          }
          if (params.assistantMessageId) {
            block.messageId = `${params.assistantMessageId}-s${currentTextSegmentIndex}`
          }
          params.onEvent({ kind: 'block', block: block as unknown as OutboundContentBlock })
        } else if (payload.channel === 'reasoning') {
          if (pendingThinkingBump) {
            currentThinkingSegmentIndex += 1
            pendingThinkingBump = false
          }
          thinkingBuf += payload.delta
          let cur = thinkingSegments[thinkingSegments.length - 1]
          if (!cur || cur.index !== currentThinkingSegmentIndex) {
            cur = {
              index: currentThinkingSegmentIndex,
              text: '',
              ts: Date.now(),
              eventOrdinal: nextOrdinal(),
            }
            thinkingSegments.push(cur)
          }
          cur.text += payload.delta
          const block: Record<string, unknown> = {
            kind: 'thinking',
            text: payload.delta,
          }
          if (params.thinkingMessageId) {
            block.messageId = `${params.thinkingMessageId}-s${currentThinkingSegmentIndex}`
          }
          params.onEvent({ kind: 'block', block: block as unknown as OutboundContentBlock })
        }
      }
    }

    const settleWithReceipt = (receipt: RemoteReceiptV4, durationMs: number): void => {
      if (finalized) return
      const totalTokens =
        receipt.usage.inputTokens +
        receipt.usage.outputTokens +
        receipt.usage.cacheReadTokens +
        receipt.usage.cacheWriteTokens
      const usageSnapshot: TurnTokenUsageSnapshot = {
        inputTokens: receipt.usage.inputTokens,
        outputTokens: receipt.usage.outputTokens,
        cacheReadTokens: receipt.usage.cacheReadTokens,
        cacheCreationTokens: receipt.usage.cacheWriteTokens,
        totalTokens,
      }
      params.onEvent({ kind: 'usage', usage: usageSnapshot })

      const isInterrupted = receipt.nativeStatus === 'interrupted' || userCancelled
      const isError = receipt.status === 'error' || isInterrupted

      if (this.capabilities.billingMode === 'engine-reported' && params.requestId) {
        this.emit(
          'billing',
          buildCodexBillingEvent(
            {
              is_error: isError,
              ...(isInterrupted ? { billing_terminal_code: 'USER_CANCELLED' } : {}),
              duration_ms: durationMs,
              usage: {
                input_tokens: receipt.usage.inputTokens,
                output_tokens: receipt.usage.outputTokens,
                cache_read_input_tokens: receipt.usage.cacheReadTokens,
                cache_creation_input_tokens: receipt.usage.cacheWriteTokens,
              },
            },
            params.requestId,
            this._engineSessionId,
            params.turnKey,
            params.usageAttribution,
          ),
        )
      }

      params.sessionTotals.turns += 1

      if (isInterrupted) {
        params.onEvent({
          kind: 'error',
          error: 'Turn cancelled by user',
          errorCode: 'user_cancelled',
        })
      } else if (isError) {
        params.onEvent({
          kind: 'error',
          error: `Remote turn ended with status ${receipt.nativeStatus}`,
          errorCode: 'engine_error',
        })
      } else {
        params.onEvent({
          kind: 'final',
          meta: {
            cost: 0,
            inputTokens: receipt.usage.inputTokens,
            outputTokens: receipt.usage.outputTokens,
            cacheReadTokens: receipt.usage.cacheReadTokens,
            cacheCreationTokens: receipt.usage.cacheWriteTokens,
            totalTokens,
            totalCost: params.sessionTotals.totalCostUSD,
            turn: params.sessionTotals.turns,
            stopReason: 'end_turn',
          },
        })
      }

      finalizeWith({
        usage: {
          cost: 0,
          inputTokens: receipt.usage.inputTokens,
          outputTokens: receipt.usage.outputTokens,
          cacheReadTokens: receipt.usage.cacheReadTokens,
          cacheCreationTokens: receipt.usage.cacheWriteTokens,
          totalTokens,
        },
        assistantText: assistantBuf,
        thinkingText: thinkingBuf,
        assistantSegments: assistantSegments.map((s) => ({ ...s })),
        thinkingSegments: thinkingSegments.map((s) => ({ ...s })),
        tools: [...toolsById.values()].map((t) => structuredClone(t)),
        runtimeEvents: runtimeEvents.map((e) => structuredClone(e)),
        stopReason: isInterrupted ? 'aborted' : isError ? null : 'end_turn',
        ...(isInterrupted ? { terminalReason: 'aborted_streaming' } : {}),
        numTurns: 1,
        isError,
        ...(isError && !isInterrupted ? { errorKind: 'other' as const, errorDetail: receipt.nativeStatus } : {}),
        staleResumeId: false,
        phantomSignals: { ...DEFAULT_PHANTOM_SIGNALS },
      })
    }

    const drainPromise = (async () => {
      try {
        const outcome = await this.lane.executeTurn(
          {
            ...validated,
            ...(this._effortLevel ? { effort: this._effortLevel } : {}),
          },
          {
            onNativeSession: (nativeId) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              if (!this._spawnEmitted) {
                this._spawnEmitted = true
                this.emit('spawn', { resumed: Boolean(this._initialResumeNativeId) })
              }
              if (this._nativeId !== nativeId) {
                this._nativeId = nativeId
              }
              this.emit('session_id', remoteV4ResumeId(this.executionBackend.operationId, nativeId))
            },
            onSubmitted: () => {
              resolveSubmitted()
            },
            onSecurityEvent: handleSecurityEvent,
            onPresentationItem: (item) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              if (finalized) return
              if (item.kind === 'status' && item.code === 'compacting') {
                params.onEvent({ kind: 'turn_status', status: 'compacting' })
              }
            },
            onToolExecuted: ({ callId, clientToolName, result }) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              completeToolResult(callId, clientToolName, result.content, result.isError)
            },
          },
        )
        resolveSubmitted()
        if (outcome.kind === 'abandoned') {
          userCancelled = true
          if (!finalized) {
            params.onEvent({
              kind: 'error',
              error: 'Turn cancelled before dispatch',
              errorCode: 'user_cancelled',
            })
          }
          finalizeWith(null)
          return
        }
        settleWithReceipt(outcome.receipt, Math.max(0, Date.now() - startedAtMs))
      } catch (err) {
        const error = err instanceof Error ? err : new Error('REMOTE_TURN_FAILED')
        rejectSubmitted(error)
        this.emit('error', error)
        finalizeWith(null)
      }
    })()

    const activeHandle = {
      getPartialSnapshot,
      getPendingTools: () => pendingToolCalls,
      finalizeNull: () => {
        userCancelled = true
        finalizeWith(null)
      },
      drainPromise,
    }
    this._activeRun = activeHandle

    return {
      submitted,
      summary,
      end: () => {
        if (!finalized) {
          this.lane.interrupt()
          finalizeWith(null)
        }
      },
      getPartialSnapshot,
      getPhantomSignals: () => ({ ...DEFAULT_PHANTOM_SIGNALS }),
      get finalized() {
        return finalized
      },
      get pendingToolCalls() {
        return pendingToolCalls
      },
    }
  }

  interrupt(_reason?: 'user' | 'system'): boolean {
    return this.lane.interrupt()
  }

  beginPlannedShutdown(): void {
    void this.lane.stopLane().catch(() => {})
  }

  async shutdown(): Promise<void> {
    await this.lane.stopLane()
  }

  async waitForOutputDrain(): Promise<void> {
    await this._activeRun?.drainPromise.catch(() => {})
  }

  get nativeSessionId(): string | null {
    return this._nativeId ? remoteV4ResumeId(this.executionBackend.operationId, this._nativeId) : null
  }

  isResumeIdCompatible(sessionId: string): boolean {
    const parsed = parseRemoteV4ResumeId(sessionId)
    if (!parsed || parsed.bindingId !== this.executionBackend.operationId) return false
    return !this._nativeId || parsed.nativeId === this._nativeId
  }

  clearSessionId(): void {
    this._nativeId = null
  }

  setResumeSessionId(sessionId: string): void {
    const parsed = parseRemoteV4ResumeId(sessionId)
    remotePoolNeed(
      parsed !== null &&
        parsed.bindingId === this.executionBackend.operationId &&
        (!this._nativeId || parsed.nativeId === this._nativeId),
      'REMOTE_RESUME_ID_INCOMPATIBLE',
    )
    this._nativeId ??= parsed.nativeId
  }

  requiresReopenForModel(model: string | undefined): boolean {
    return model !== this.lane.binding.canonicalModel
  }

  isUserCancellationResult(summary: TurnSummary): boolean {
    return summary.terminalReason === 'aborted_streaming' || summary.stopReason === 'aborted'
  }

  setModel(model: string | undefined): void {
    remotePoolNeed(model === this.lane.binding.canonicalModel, 'REMOTE_ROUTE_CHANGED_REOPEN_SESSION')
    this._model = model
  }

  get model(): string | undefined {
    return this._model
  }

  setEffortLevel(level: string | undefined): void {
    this._effortLevel = level
    this.lane.setEffortLevel(level)
  }

  get effortLevel(): string | undefined {
    return this._effortLevel
  }

  get promptPolicyFingerprint(): string | undefined {
    return this.lane.promptPolicyFingerprint
  }

  get promptIntelligentUi(): IntelligentUiApplied | undefined {
    return this.lane.promptIntelligentUi
  }

  setPromptPrivacy(policy: PromptPrivacyPolicy): void {
    this.lane.setPromptPrivacy(policy)
  }

  clearPromptPrivacy(): void {
    this.lane.clearPromptPrivacy()
  }

  assertPromptPrivacyStopped(): void {
    if (!this.lane.isPromptPrivacyStopped()) {
      throw new Error('助手隐私刷新仍在等待旧进程终结，请稍后重试。')
    }
  }

  restartForConfigChange(): Promise<void> {
    return this.lane.recycleForConfigChange()
  }

  setTraceId(_traceId: string | undefined): void {}

  async setGoalState(_goal: GoalStateSnapshot | null): Promise<void> {}

  updateConfig(config: OpenClaudeConfig): void {
    this.lane.updateConfig(config)
  }

  setToolsets(toolsets: string[] | undefined): void {
    this._toolsets = toolsets
  }

  get toolsets(): string[] | undefined {
    return this._toolsets
  }

  setExecutionTarget(target: ExecutionTarget): void {
    remotePoolNeed(target.kind === 'local', 'REMOTE_NESTED_TARGET_UNSUPPORTED')
    this._executionTarget = target
  }

  get executionTarget(): ExecutionTarget {
    return this._executionTarget
  }

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    return false
  }

  getPartialSnapshot(): PartialSnapshot {
    return (
      this._activeRun?.getPartialSnapshot() ?? {
        assistantText: '',
        thinkingText: '',
        completedTools: [],
        assistantSegments: [],
        thinkingSegments: [],
        runtimeEvents: [],
      }
    )
  }

  get pendingToolCalls(): number {
    return this._activeRun?.getPendingTools() ?? 0
  }

  get isRunning(): boolean {
    return this._activeRun !== undefined && !this.lane.stopped
  }

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return null
  }
}
