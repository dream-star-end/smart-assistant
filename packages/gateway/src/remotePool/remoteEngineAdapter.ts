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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  SWARM_BOARD_TOOL_NAME,
  mergeSwarmSnapshots,
  parseRemoteDriverExecutionBackend,
  sameRemoteExecutionBackend,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type PromptPrivacyPolicy,
  type RemoteDriverExecutionBackend,
  type RemoteReceiptV4,
  type RemoteSecurityEvent,
  type SwarmPhase,
  type SwarmSnapshot,
  type TurnTokenUsageSnapshot,
} from '@openclaude/protocol'
import {
  AntigravitySwarmWatcher,
  buildDurableSwarmBoardInput,
  formatSwarmWorkingDetail,
  settleSwarmSnapshotTerminal,
} from '../engine/antigravitySwarmWatcher.js'
import { buildCodexBillingEvent } from '../engine/codexAdapter.js'
import {
  lookupRemoteSwarmMcpContext,
  lookupRemoteSwarmRuntimeForSession,
  remoteSwarmLocationForSession,
} from '../remoteSwarmRuntime.js'
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
  PermissionRequest,
  PhantomSignals,
  SegmentRecord,
  TurnSummary,
  TurnToolEntry,
} from '../engine/engineEvents.js'
import { engineSessionId } from '../engine/engineSessionId.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { ExecutionTarget } from '../remoteTarget.js'
import { classifyRunError } from '../errorClassify.js'
import { RemoteContainerLane, type RemoteContainerLaneOptions } from './containerLane.js'
import { parseRemoteV4ResumeId, remoteV4ResumeId } from './resumeId.js'
import { remotePoolNeed } from './types.js'

const DEFAULT_PHANTOM_SIGNALS: PhantomSignals = {
  apiState: 'called',
  skipReason: null,
}

const REMOTE_SWARM_TOOL_NAMES = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait'])

function isRemoteSwarmToolName(toolName: string): boolean {
  if (REMOTE_SWARM_TOOL_NAMES.has(toolName)) return true
  if (toolName.startsWith('mcp__openclaude-memory__')) {
    return REMOTE_SWARM_TOOL_NAMES.has(toolName.slice('mcp__openclaude-memory__'.length))
  }
  return false
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
  private _shuttingDown = false
  private _activeRun?: {
    readonly getPartialSnapshot: () => PartialSnapshot
    readonly getPendingTools: () => number
    readonly hasPendingPermissions: () => boolean
    readonly resolvePermission: (requestId: string, response: Record<string, unknown>) => boolean
    readonly markInterrupted: (reason?: 'user' | 'system') => void
    readonly finalizeNull: () => void
    drainPromise: Promise<void>
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
    const isAntigravityAuthority = backend.authorityEngine === 'antigravity'
    const needsServerReqId =
      isCodexAuthority ||
      isAntigravityAuthority ||
      backend.authorityEngine === 'grok' ||
      backend.authorityEngine === 'cursor' ||
      backend.authorityEngine === 'zcode'
    this.capabilities = {
      billingMode: isCodexAuthority ? 'engine-reported' : 'proxy',
      supportsEffort: true,
      resumeKind: isAntigravityAuthority
        ? 'antigravity-session'
        : isCodexAuthority
          ? 'codex-thread'
          : 'ccb-session',
      needsServerRequestId: needsServerReqId,
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

  /** Expose active container-side Remote Swarm board location for `POST /internal/swarm/command`. */
  getActiveSwarmTarget(): { brainDir: string; conversationId: string } | null {
    if (
      this.engineId !== 'antigravity' ||
      this.executionBackend.sessionKey.includes(':swarm:')
    ) {
      return null
    }
    const loc = remoteSwarmLocationForSession(this.executionBackend.sessionKey)
    if (!existsSync(join(loc.swarmDir, 'members.json'))) return null
    return { brainDir: loc.brainDir, conversationId: loc.swarmId }
  }

  async start(): Promise<void> {
    // Admission occurs lazily on the first authorized turn (`beginTurn`/`executeTurn`).
  }

  // Deliberately omit the optional preheat hook: admission is lazy, and the legacy
  // preheat privacy refresh calls shutdown(), which permanently stops this lane.
  // Normal submits refresh consent through restartForConfigChange/recycle instead.

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
    const pendingPermissions = new Map<
      string,
      { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void }
    >()
    const rejectPendingPermissions = (reason: string): void => {
      for (const waiter of pendingPermissions.values()) {
        waiter.reject(new Error(reason))
      }
      pendingPermissions.clear()
    }
    let finalized = false
    let userCancelled = false
    let interruptReason: 'user' | 'system' | null = null
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

    // Remote Antigravity coordinator sessions watch their container-side SwarmBoard
    // directory (`remoteSwarmLocationForSession`) so SwarmBoard UI receives live
    // snapshots, delta posts, and durable turn persistence identically to local AGY.
    let swarmWatcher: AntigravitySwarmWatcher | null = null
    let lastEmittedSwarmSnapshot: SwarmSnapshot | null = null
    let swarmBlockId: string | undefined
    let swarmEventOrdinal: number | undefined
    let swarmCommitted = false

    const swarmBlockIdFor = (swarmId: string): string => {
      if (!swarmBlockId) {
        swarmBlockId = `agy-swarm-${swarmId.slice(0, 8)}-t${params.sessionTotals.turns}`
      }
      return swarmBlockId
    }

    const emitSwarmSnapshot = (snapshot: SwarmSnapshot): void => {
      if (finalized) return
      lastEmittedSwarmSnapshot =
        swarmWatcher?.latestSnapshot() ??
        mergeSwarmSnapshots(lastEmittedSwarmSnapshot, snapshot) ??
        structuredClone(snapshot)
      this.lastActivityAt = Date.now()
      this.emit('activity')
      const blockId = swarmBlockIdFor(snapshot.swarmId)
      if (swarmEventOrdinal === undefined) {
        swarmEventOrdinal = nextOrdinal()
      }
      params.onEvent({
        kind: 'block',
        block: {
          kind: 'swarm_snapshot',
          blockId,
          snapshot,
        } as OutboundContentBlock,
      })
      if (snapshot.phase === 'running' || snapshot.phase === 'starting') {
        params.onEvent({
          kind: 'turn_status',
          status: { status: 'working', detail: formatSwarmWorkingDetail(snapshot) },
        })
      }
    }

    const commitTerminalSwarmBoard = (
      phase: SwarmPhase,
      opts: { emitEvent: boolean; readDisk: boolean },
    ): void => {
      if (swarmCommitted) {
        swarmWatcher?.stop()
        swarmWatcher = null
        return
      }
      const watcher = swarmWatcher
      swarmWatcher = null
      let finalSwarm: SwarmSnapshot | null = null
      if (opts.readDisk && watcher) {
        finalSwarm = watcher.stopAndReadFinal(phase)
      } else {
        watcher?.stop()
        const hadActivity = (watcher?.hasTurnActivity() ?? false) || lastEmittedSwarmSnapshot !== null
        const base = lastEmittedSwarmSnapshot ?? (hadActivity ? watcher?.latestSnapshot() ?? null : null)
        if (hadActivity && base) {
          finalSwarm = settleSwarmSnapshotTerminal(base, phase)
        }
      }
      if (!finalSwarm) return
      swarmCommitted = true
      lastEmittedSwarmSnapshot = structuredClone(finalSwarm)
      const blockId = swarmBlockIdFor(finalSwarm.swarmId)
      if (opts.emitEvent && !finalized) {
        params.onEvent({
          kind: 'block',
          block: {
            kind: 'swarm_snapshot',
            blockId,
            snapshot: finalSwarm,
          } as OutboundContentBlock,
        })
      }
      const durableInput = buildDurableSwarmBoardInput(finalSwarm)
      const swarmSummary = formatSwarmWorkingDetail(finalSwarm)
      const swarmStartedAt = finalSwarm.startedAt ?? startedAtMs
      toolsById.set(blockId, {
        toolUseId: blockId,
        blockId,
        toolName: SWARM_BOARD_TOOL_NAME,
        inputJson: durableInput,
        inputPreview: durableInput.title.slice(0, 500),
        output: swarmSummary,
        completed: true,
        isError: phase === 'error',
        durationMs: Math.max(0, Date.now() - swarmStartedAt),
        ts: Date.now(),
        arrivedAt: swarmStartedAt,
        eventOrdinal: swarmEventOrdinal ?? nextOrdinal(),
      })
    }

    if (
      this.engineId === 'antigravity' &&
      !this.executionBackend.sessionKey.includes(':swarm:')
    ) {
      const loc = remoteSwarmLocationForSession(this.executionBackend.sessionKey)
      const sessionKeyForSwarm = this.executionBackend.sessionKey
      swarmWatcher = new AntigravitySwarmWatcher({
        brainDir: loc.brainDir,
        conversationId: loc.swarmId,
        seedBaselineOnStart: existsSync(loc.swarmDir),
        onSnapshot: emitSwarmSnapshot,
        onStallDetected: (alert) => {
          if (finalized) return
          const runtime = lookupRemoteSwarmRuntimeForSession(sessionKeyForSwarm)
          if (!runtime) return
          const posted = runtime.postGatewayStallAlert(sessionKeyForSwarm, alert)
          if (posted) {
            swarmWatcher?.kick()
          }
        },
      })
      swarmWatcher.start()
    }

    const getPartialSnapshot = (): PartialSnapshot => {
      if (userCancelled || interruptReason !== null) {
        commitTerminalSwarmBoard('interrupted', { emitEvent: false, readDisk: false })
      }
      return {
        assistantText: assistantBuf,
        thinkingText: thinkingBuf,
        completedTools: [...toolsById.values()].map((t) => structuredClone(t)),
        assistantSegments: assistantSegments.map((s) => ({ ...s })),
        thinkingSegments: thinkingSegments.map((s) => ({ ...s })),
        runtimeEvents: runtimeEvents.map((e) => structuredClone(e)),
      }
    }

    const finalizeWith = (value: TurnSummary | null): void => {
      if (finalized) return
      if (!swarmCommitted) {
        commitTerminalSwarmBoard(
          userCancelled || interruptReason !== null ? 'interrupted' : 'error',
          { emitEvent: false, readDisk: false },
        )
      } else {
        swarmWatcher?.stop()
        swarmWatcher = null
      }
      finalized = true
      rejectPendingPermissions('TURN_FINALIZED')
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

    let presentationErrorText: string | undefined
    let presentationErrorCode: string | undefined
    let terminalErrorCode: string | undefined

    const handleSecurityEvent = (ev: RemoteSecurityEvent): void => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      if (finalized) return

      const payload = ev.payload
      if (payload.kind === 'turnTerminal' && typeof payload.errorCode === 'string' && payload.errorCode.length > 0) {
        terminalErrorCode = payload.errorCode
      }
      if (payload.kind === 'toolCallObserved' && payload.phase === 'started') {
        const callId = payload.callId
        const toolName = this.lane.resolveClientToolName(payload.name)
        if (
          isRemoteSwarmToolName(toolName) &&
          lookupRemoteSwarmMcpContext(this.executionBackend.sessionKey) !== undefined
        ) {
          swarmWatcher?.activateTurnSwarm()
        }
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
      const finalSwarmPhase: SwarmPhase = isInterrupted
        ? 'interrupted'
        : isError
          ? 'error'
          : 'completed'
      commitTerminalSwarmBoard(finalSwarmPhase, { emitEvent: true, readDisk: true })

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

      const effectiveErrorCode = terminalErrorCode ?? presentationErrorCode
      const rawErrorText =
        presentationErrorText ??
        (effectiveErrorCode
          ? `Remote turn ended with status ${receipt.nativeStatus} (${effectiveErrorCode})`
          : `Remote turn ended with status ${receipt.nativeStatus}`)
      const classified =
        isError && !isInterrupted
          ? classifyRunError([effectiveErrorCode, presentationErrorText].filter(Boolean).join('\n') || rawErrorText)
          : { code: 'unknown' as const, message: '' }
      const isAuthError =
        isError &&
        !isInterrupted &&
        (classified.code === 'auth_error' ||
          effectiveErrorCode === 'CC_AUTH_ERROR' ||
          effectiveErrorCode === 'CC_ACCOUNT_VERIFICATION_REQUIRED')

      if (isInterrupted) {
        params.onEvent({
          kind: 'error',
          error: 'Turn cancelled by user',
          errorCode: 'user_cancelled',
        })
      } else if (isError) {
        params.onEvent({
          kind: 'error',
          error: rawErrorText,
          ...(isAuthError
            ? { errorCode: 'auth_error' as const, errorClass: 'auth_error' as const }
            : classified.code !== 'unknown'
              ? { errorClass: classified.code }
              : { errorCode: 'engine_error' as const }),
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
        ...(isError && !isInterrupted
          ? {
              errorKind: isAuthError ? ('auth' as const) : ('other' as const),
              ...(classified.code !== 'unknown' ? { errorClass: classified.code } : {}),
              errorDetail: rawErrorText,
            }
          : {}),
        staleResumeId: false,
        phantomSignals: { ...DEFAULT_PHANTOM_SIGNALS },
      })
    }

    const activeHandle: NonNullable<RemoteEngineAdapter['_activeRun']> = {
      getPartialSnapshot,
      getPendingTools: () => pendingToolCalls,
      hasPendingPermissions: () => pendingPermissions.size > 0,
      resolvePermission: (requestId: string, response: Record<string, unknown>) => {
        const waiter = pendingPermissions.get(requestId)
        if (!waiter || finalized) return false
        pendingPermissions.delete(requestId)
        waiter.resolve(response)
        return true
      },
      markInterrupted: (reason?: 'user' | 'system') => {
        interruptReason = reason ?? 'system'
        if (reason === 'user') userCancelled = true
        rejectPendingPermissions('TURN_INTERRUPTED')
      },
      finalizeNull: () => {
        interruptReason = 'user'
        userCancelled = true
        finalizeWith(null)
      },
      drainPromise: Promise.resolve(),
    }
    this._activeRun = activeHandle

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
            onPermissionRequest: (request: PermissionRequest) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              if (finalized || userCancelled || interruptReason !== null) {
                return Promise.reject(new Error('TURN_NOT_ACTIVE'))
              }
              return new Promise<Record<string, unknown>>((resolve, reject) => {
                pendingPermissions.set(request.requestId, { resolve, reject })
                params.onEvent({ kind: 'permission_request', request })
              })
            },
            onPresentationItem: (item) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              if (finalized) return
              if (item.kind === 'status' && item.code === 'compacting') {
                params.onEvent({ kind: 'turn_status', status: 'compacting' })
              } else if (item.kind === 'error') {
                if (!presentationErrorCode && typeof item.code === 'string' && item.code.length > 0) {
                  presentationErrorCode = item.code
                }
                if (!presentationErrorText && typeof item.text === 'string' && item.text.trim().length > 0) {
                  presentationErrorText = item.text.trim().slice(0, 2_000)
                }
              }
            },
            onToolExecuted: ({ callId, clientToolName, result }) => {
              this.lastActivityAt = Date.now()
              this.emit('activity')
              completeToolResult(callId, clientToolName, result.content, result.isError)
              if (isRemoteSwarmToolName(clientToolName)) {
                swarmWatcher?.kick()
              }
            },
          },
        )
        if (outcome.kind === 'abandoned') {
          if (this._shuttingDown) {
            if (!finalized) {
              this.emit('exit', { code: 0, signal: 'SIGTERM', crashed: false })
            }
            resolveSubmitted()
            finalizeWith(null)
            return
          }
          if (userCancelled || interruptReason !== null) {
            resolveSubmitted()
            if (!finalized) {
              params.onEvent({
                kind: 'error',
                error: userCancelled ? 'Turn cancelled by user' : 'Turn cancelled before dispatch',
                ...(userCancelled ? { errorCode: 'user_cancelled' as const } : {}),
              })
            }
            finalizeWith(null)
            return
          }
          const fenceErr = this.lane.fenceError ?? new Error('REMOTE_TURN_ABORTED')
          rejectSubmitted(fenceErr)
          if (!finalized) {
            this.emit('error', fenceErr)
          }
          finalizeWith(null)
          return
        }
        resolveSubmitted()
        settleWithReceipt(outcome.receipt, Math.max(0, Date.now() - startedAtMs))
      } catch (err) {
        const error = err instanceof Error ? err : new Error('REMOTE_TURN_FAILED')
        if (this._shuttingDown) {
          if (!finalized) {
            this.emit('exit', { code: 0, signal: 'SIGTERM', crashed: false })
          }
          rejectSubmitted(error)
          finalizeWith(null)
          return
        }
        rejectSubmitted(error)
        if (!finalized) {
          this.emit('error', error)
        }
        finalizeWith(null)
      }
    })()
    activeHandle.drainPromise = drainPromise

    return {
      submitted,
      summary,
      end: () => {
        if (!finalized) {
          interruptReason ??= 'system'
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

  interrupt(reason?: 'user' | 'system'): boolean {
    this._activeRun?.markInterrupted(reason)
    return this.lane.interrupt()
  }

  beginPlannedShutdown(): void {
    this._shuttingDown = true
    void this.lane.stopLane().catch(() => {})
  }

  async shutdown(): Promise<void> {
    this._shuttingDown = true
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

  get waitingForUserInput(): boolean {
    return this._activeRun?.hasPendingPermissions() ?? false
  }

  sendPermissionResponse(requestId: string, response: unknown): boolean {
    if (!this._activeRun || !response || typeof response !== 'object' || Array.isArray(response)) {
      return false
    }
    const behavior = (response as { behavior?: unknown }).behavior
    if (behavior !== 'allow' && behavior !== 'deny') {
      return false
    }
    const sent = this._activeRun.resolvePermission(requestId, response as Record<string, unknown>)
    if (sent) {
      this.lastActivityAt = Date.now()
      this.emit('activity')
    }
    return sent
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
