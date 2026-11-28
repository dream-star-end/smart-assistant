import type { PreheatPreparation } from './speculativePreheat.js'
import { renderHistoricalContextJsonPrompt } from './historicalContextPrompt.js'
import { type RemoteExecutionBackend, type GrokExecutionDescriptor, isBoxApiModel } from '@openclaude/protocol'
import { getDesiredIntelligentUi, intelligentUiNeedsRestart, isIntelligentUiApplied } from './intelligentUiDesired.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve as resolvePath } from 'node:path'
import {
  resolveRuntimeExecutionAgent,
  IdentityAssetsError,
  type IdentityCompatRuntimeContext,
  type AgentDef,
  type OpenClaudeConfig,
  appendServerAuthoredMessageDurable,
  getClientSession,
  getEngineContextMessages,
  getMaxTurnIdx,
  hasPersistedTurnActivity,
  indexTurn,
  MemoryDir,
  type MemoryTurnPolicyDecision,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  readMemoryTurnPolicy,
  recordTurnDispatchRunning,
  getTurnDispatchByDispatchId,
  reserveTurnIndex,
  recordMemoryUsageEvent,
  paths,
  projectSessionFingerprint,
  loadProjectContext,
  skillOverlayManifestSha256,
  type KernelFileLock,
  upsertSessionMeta,
} from '@openclaude/storage'
import {
  abandonAllIdle,
  advanceIdleOp,
  boxTurnMayIdle,
  consumeIdleReset,
  currentIdleSource,
  idleAbandonReason,
  idleOpSettled,
  idleProofWaitMs,
  pruneIdleOps,
  readIdleReset,
  sourceNeedsIdleOp,
  type IdleOp,
  IDLE_COMPACT_PROMPT,
  IdleCompactRejected,
  idleHistoryStillBlocked,
  idleSummaryAccepted,
  nativeShortForOp,
  clearIdleCandidate,
  readIdleCandidate,
  readIdleNative,
  readIdleOp,
  readPendingIdle,
  startIdleOp,
  withIncarnationShutdown,
  writeIdleCandidate,
  writeIdleNative,
  writeIdleOp,
} from './boxIdleCompact.js'
import { fetchBoxIdleProof, type IdleProofResponse } from './engine/boxIdleProofClient.js'
import { notifyBoxUserStop } from './engine/boxUserStopClient.js'
import { IdleTurnTimeoutError, runBoxIdleTurn } from './boxIdleTurn.js'
import { isCcbUserCancellationDiagnostic } from './engine/ccbAdapter.js'
import './engine/ccbFactory.js'
import { isBoxGptWebCatalogModel } from './engine/cursorBoxCc.js'
import './engine/codexAdapter.js'
import './engine/grokAdapter.js'
import { decideEngineCwd } from './engineCwd.js'
import {
  cursorSandBoxCcResumeInnerId,
  cursorSandOfficialCcResumeInnerId,
  cursorResumeStoreExists,
  cursorSandResumeInnerId,
  isCursorSandBoxCcResumeId,
  isAnyCursorSandResumeId,
  relocateCursorResumeStore,
  usableCursorResumeId,
} from './engine/cursorAdapter.js'
import './engine/zcodeAdapter.js'
import './engine/antigravityAdapter.js'
import './remotePool/registerRemoteDriver.js'
import { RESUME_HISTORY_MAX, pickResumableId, probeResumeArtifact } from './engine/resumeArtifacts.js'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineAdapter,
  EngineTurnRun,
} from './engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  EngineExternalBillingEvent,
  EngineEvent,
  EngineFinalMeta,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { createEngine, EngineNotEnabledError, isEngineEnabled, resolveEngine } from './engine/registry.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import type { GrokRouteOverride } from './engine/grokAdapter.js'
import type { ZcodeRouteOverride } from './engine/zcodeAdapter.js'
import type { AntigravityRouteOverride } from './engine/antigravityAdapter.js'
import { eventBus, createEvent } from './eventBus.js'
import { beginMemoryTurnTracking } from './memoryTurnObserver.js'
import {
  createTurnUsageRecorder,
  mapTurnTerminalStatus,
  type TurnTerminalStatus,
} from './turnUsage.js'
import { emptyCompletedTurnAssistantText, shouldFailClosedEmptyModelTurn } from './emptyCompletedTurn.js'
import { applyPlatformCostIfMissing } from './usageCost.js'
import { CCB_PROVIDER_TAG, CCB_RESUME_HISTORY_CONTEXT_VERSION, normalizeEngineTag, ResumeStore } from './resumeStore.js'
import { collectResumeSyncSnapshots, type SessionAuthorityRuntimePort, type SessionCapsuleRuntimePort } from './sessionAuthorityHook.js'
import { collectSessionOutputAssets } from './projectAssetCollector.js'
import { adoptRunContext } from './runContextPersist.js'
import {
  deriveLosslessTurnKey,
  getV3MasterSinkOrNull,
  type V3MasterSinkPayload,
} from './v3MasterSink.js'
import { failClosedOnRunningCasMiss } from './turnDispatchInbox.js'
import {
  AUTOMATIC_TURN_RETRY_MAX,
  assessTurnRecoveryTape,
  type CallTokenUsageSnapshot,
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  collectModelHistoryMediaPathHints,
  modelHistoryRoleLabel,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  projectModelHistoryForReplay,
  type ModelHistorySemanticRole,
  type TurnWaiveReason,
  type DurableAgentGroup,
  type DurableGoalUsageRecord,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type ServiceTier,
  type SessionWorkspaceMode,
} from '@openclaude/protocol'
import { resolveExecutionModel } from './server.js'
import {
  buildLateDelegateContinuationArgs,
  isValidDelegateOwnerLocator,
  lateDelegateGroupIdentity,
  type DelegateOwnerTurnLocator,
} from './delegateLateCompletion.js'
import { classifyRunError } from './errorClassify.js'
import type {
  GatewayEngineErrorEvent,
  GatewayTerminalErrorCode,
  GatewayTurnPhase,
  ModelProgressPhase,
} from './ccbMessageParser.js'
import { isCcbSlashCommandPrompt } from './ccbNativeCompaction.js'
import {
  type ExecutionTarget,
  type RemoteTargetController,
  RemoteTargetUnavailableError,
} from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import type { TurnModelAuthority, UsageAttributionTag } from './subprocessRunner.js'
import { isPatrolSessionKey } from './taskboard/domain.js'
import { startMemoryTurnPolicyLease } from './memoryTurnPolicyLease.js'
import {
  applyEfficiencyToolObservation,
  finalizeEfficiencyTurn,
  prepareEfficiencyTurnNote,
} from './agentEfficiencyGuard.js'
import {
  advanceTransientBreaker,
  formatTransientCircuitOpenError,
  resolveTransientBreakerThreshold,
} from './transientRetryCircuit.js'
import { log } from './sessionManagerLog.js'
import { type TurnRunnerHost, _runOneTurn as _runOneTurnImpl, runOneTurnWithRetry as runOneTurnWithRetryImpl } from './sessionTurnRunner.js'
import { type SessionSubmitHost, submit as submitImpl, _getOrCreateExclusive as _getOrCreateExclusiveImpl, getOrCreate as getOrCreateImpl, finishIdleUnderLock as finishIdleUnderLockImpl, recordExternalTurn as recordExternalTurnImpl, beginExternalTurn as beginExternalTurnImpl, _resumeIdFor as _resumeIdForImpl, _resolveDurableResumeId as _resolveDurableResumeIdImpl } from './sessionSubmit.js'
import { type SessionTailHost, _persistTailBatch as _persistTailBatchImpl, _dispatchPostTerminalRuntimeEvent as _dispatchPostTerminalRuntimeEventImpl, _foldPostTerminalTail as _foldPostTerminalTailImpl, _drainTailFolding as _drainTailFoldingImpl, _drainTailPersistQueue as _drainTailPersistQueueImpl, _buildTailCapMarker as _buildTailCapMarkerImpl, _scheduleTailPersistWorker as _scheduleTailPersistWorkerImpl, _chainTailPersist as _chainTailPersistImpl, _trackPersistence as _trackPersistenceImpl, _warnMissingPostTerminalOwner as _warnMissingPostTerminalOwnerImpl } from './sessionTail.js'
import { type SessionAgentGroupsHost, deliverLateDelegateAgentGroup as deliverLateDelegateAgentGroupImpl, bufferPendingAgentGroup as bufferPendingAgentGroupImpl, drainPendingAgentGroups as drainPendingAgentGroupsImpl, _settleDrainedOwnerGroups as _settleDrainedOwnerGroupsImpl, _claimDrainedOwnerGroups as _claimDrainedOwnerGroupsImpl, _sealOwnerTurn as _sealOwnerTurnImpl, _runOnOwnerChain as _runOnOwnerChainImpl, _admitExactOwnerRun as _admitExactOwnerRunImpl, _matchLiveSessionsOwnerRun as _matchLiveSessionsOwnerRunImpl, _matchLiveOwnerRun as _matchLiveOwnerRunImpl, _trimExactOwnerRuns as _trimExactOwnerRunsImpl } from './sessionAgentGroups.js'
import { type SessionLifecycleHost, type EvictionPassResult, preheatRunner as preheatRunnerImpl, recyclePeerForRepoChange as recyclePeerForRepoChangeImpl, recyclePeerForRepoUnbind as recyclePeerForRepoUnbindImpl, runEvictionPass as runEvictionPassImpl, startEvictionLoop as startEvictionLoopImpl, shutdownAll as shutdownAllImpl, destroySession as destroySessionImpl, retireKeepResume as retireKeepResumeImpl, scheduleIdleDrain as scheduleIdleDrainImpl, applyIdleResetIfRequested as applyIdleResetIfRequestedImpl, _ccbJsonlExists as _ccbJsonlExistsImpl, _cursorWorkspacePath as _cursorWorkspacePathImpl, setExecutionTarget as setExecutionTargetImpl, prepareModelSwitch as prepareModelSwitchImpl, armRuntimeRecycleDrain as armRuntimeRecycleDrainImpl } from './sessionLifecycle.js'
import type { AgentSession } from './sessionTypes.js'
import { persistServerAuthoredTurnOutcome } from './sessionTurnOutcome.js'
import { buildHistoricalContextPromptWithRenderer } from './session/historyContext.js'
import {
  BOX_ACTIVE_TURN_IDLE_MS,
  BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS,
  ENGINE_PREHEAT_DEADLINE_DEFAULT_MS,
  IDLE_TIMEOUT_DEFAULT_MS,
  IDLE_TIMEOUT_TOOL_MS,
  PRE_START_STOP_TTL_MS,
  RESUME_MAP_INACTIVE_TTL_MS,
  recordRecentTerminal,
} from './session/sessionUtils.js'
import {
  adoptPreStartStopFence,
  applySessionUserGoalAction,
  awaitBoundedOutputDrainWithTimeout,
  beginSessionPromptQueueFence,
  consumePreStartStopFence,
  getOrCreateTailOwnerBudget,
  recordPreStartStopFence,
  resolveAntigravitySwarmTargetForManager,
  syncSessionGoalState,
} from './session/managerHelpers.js'
import type {
  ExactOwnerRunRecord,
  ExactOwnerRunState,
  GetOrCreateOpts,
  PreStartStopEntry,
  PreheatOutcome,
  PromptQueueExecutionFence,
  PromptQueueExternalTurnReservation,
  SubmitOpts,
  TailFoldItem,
  TailFoldStreamState,
  TailOwnerBudget,
  TailPersistQueueItem,
  TapePersistResult,
  TurnQueueLifecycle,
  TurnUserInput,
  CronBridgeEvent,
} from './session/types.js'

export type { AgentSession } from './sessionTypes.js'
export { persistServerAuthoredTurnOutcome } from './sessionTurnOutcome.js'
export type { SessionStreamEvent } from './ccbMessageParser.js'
export {
  TRANSIENT_SAME_CLASS_BREAKER,
  advanceTransientBreaker,
  formatTransientCircuitOpenError,
  resolveTransientBreakerThreshold,
} from './transientRetryCircuit.js'
export type {
  ChatHistoryMessage,
  CronBridgeEvent,
  ExactOwnerRunState,
  GetOrCreateOpts,
  PendingAgentGroupEntry,
  PendingExternalExchange,
  PreheatOutcome,
  PromptQueueExecutionFence,
  PromptQueueExternalTurnReservation,
  SubmitOpts,
  TailFoldItem,
  TailFoldStreamState,
  TailPersistQueueItem,
  TapePersistResult,
} from './session/types.js'
export {
  buildNativeModelHandoffPayload,
  buildNativeModelHandoffPrompt,
  buildRollingCheckpointPayload,
  historicalContextInjectionKey,
  normForCompare,
  providerGapMessagesAfterOwnTurn,
  shouldAttemptHistoricalContextInjection,
  shouldEmitContextRebuilt,
  shouldTreatMasterHistoryAsProviderGap,
} from './session/historyContext.js'
export {
  BOX_ACTIVE_TURN_IDLE_MS,
  BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS,
  ENGINE_PREHEAT_DEADLINE_DEFAULT_MS,
  IDLE_TIMEOUT_DEFAULT_MS,
  IDLE_TIMEOUT_TOOL_MS,
  MODEL_THINKING_KEEPALIVE_MS,
  MODEL_THINKING_WORKING_DETAIL,
  PRE_ADMISSION_STOP_TTL_MS,
  PRE_START_STOP_TTL_MS,
  RESUME_MAP_INACTIVE_TTL_MS,
  RuntimeRecycleDrainingError,
  SESSION_PERSIST_QUEUED_NOTICE,
  TRANSIENT_RETRY_INPUT,
  activeGoalAttribution,
  applyTurnIdleTimeoutTick,
  assertPromptQueueExecutionAdmission,
  isNativeEngineTransientContinuationSafe,
  lookupRecentTerminal,
  messageSendAttempt,
  nextUserGoal,
  parseVerificationVerdict,
  preStartStopKey,
  recordRecentTerminal,
  scheduleSessionOutputAssetCollection,
  shouldFireTurnIdleTimeout,
  shouldTripIdleWatchdog,
  stopControlSendAttempt,
  takeDurableEventOrdinal,
} from './session/sessionUtils.js'

/** Map generic engine failures onto semantic lowercase tape codes when classified. */
export function _tapeErrorCodeForGenericFailure(detail: string | undefined): string {
  const cls = classifyRunError(detail)
  return cls.code === 'unknown' ? 'ENGINE_ERROR' : cls.code
}

/** E4.2 — map uppercase tape terminal control codes onto wire OutboundError codes. */
export function _wireTerminalCodeForTape(
  code: string | undefined,
): GatewayTerminalErrorCode | undefined {
  switch (code) {
    case 'USER_CANCELLED':
      return 'user_cancelled'
    case 'RUNNER_CRASHED':
      return 'runner_crashed'
    case 'SERVICE_RESTART':
      return 'service_restart'
    case 'AUTH_ERROR':
      return 'auth_error'
    case 'ENGINE_ERROR':
      return 'engine_error'
    default:
      return undefined
  }
}

/** Default agent working directory when agent cwd is not pinned. */
export function resolveDefaultWorkspaceCwd(
  workspaceMode: SessionWorkspaceMode = 'legacy',
  sessionId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ws = env.OPENCLAUDE_DEFAULT_WORKSPACE?.trim()
  let baseDir: string | null = null
  if (ws) {
    try {
      if (statSync(ws).isDirectory()) baseDir = ws
    } catch {
      // Fall back to process.cwd() when default workspace is absent/unstatable
    }
  }
  if (workspaceMode === 'legacy') return baseDir ?? process.cwd()
  if (baseDir === null) {
    throw new Error('isolated session workspace requires OPENCLAUDE_DEFAULT_WORKSPACE')
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,50}$/.test(sessionId)) {
    throw new Error('isolated session workspace requires a valid client session id')
  }
  const sessionDir = join(baseDir, 'sessions', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  return sessionDir
}

/** Whether running in commercial managed runtime (v3/v5 container or master). */
export function isCommercialManagedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OC_RUNTIME_CHANNEL !== undefined && env.OC_RUNTIME_CHANNEL.trim() !== '') return true
  return Boolean(env.OPENCLAUDE_V3_MASTER_BASE_URL && env.OPENCLAUDE_V3_CONTAINER_TOKEN)
}

export function buildHistoricalContextPrompt(
  messages: unknown[],
  currentUserText: string,
  maxHistoryChars?: number,
  maxPromptBytes?: number,
  includeCurrentUserText = true,
): string | null {
  return buildHistoricalContextPromptWithRenderer(
    messages,
    currentUserText,
    renderHistoricalContextJsonPrompt,
    maxHistoryChars,
    maxPromptBytes,
    includeCurrentUserText,
  )
}

function isBoxActiveTurn(engineId?: string, modelId?: string): boolean {
  return engineId === 'ccb' && isBoxApiModel(modelId)
}

function isBoxGptWebActiveTurn(engineId?: string, modelId?: string): boolean {
  return (
    (engineId === 'cursor' || engineId === 'ccb' || engineId === undefined) &&
    isBoxGptWebCatalogModel(modelId)
  )
}

export function pickTurnSilentBackstopMs(engineId?: string, modelId?: string): number {
  if (isBoxGptWebActiveTurn(engineId, modelId)) return BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
  return isBoxActiveTurn(engineId, modelId) ? BOX_ACTIVE_TURN_IDLE_MS : 30 * 60_000
}

export function pickIdleTimeoutMs(
  currentTurnStatus: GatewayTurnPhase | undefined,
  pendingToolCalls: number,
  engineId?: string,
  modelId?: string,
): number {
  if (isBoxGptWebActiveTurn(engineId, modelId)) return BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
  if (isBoxActiveTurn(engineId, modelId)) return BOX_ACTIVE_TURN_IDLE_MS
  const inNonStreamingPhase =
    currentTurnStatus === 'compacting' ||
    (typeof currentTurnStatus === 'object' && currentTurnStatus !== null)
  if (
    pendingToolCalls > 0 ||
    inNonStreamingPhase ||
    engineId === 'ccb' ||
    engineId === 'codex' ||
    engineId === 'grok' ||
    engineId === 'cursor' ||
    engineId === 'zcode' ||
    engineId === 'antigravity'
  ) {
    return IDLE_TIMEOUT_TOOL_MS
  }
  return IDLE_TIMEOUT_DEFAULT_MS
}

export function isTempSessionKey(sessionKey: string): boolean {
  return (
    sessionKey.includes(':cron:') || sessionKey.includes(':task:') || isPatrolSessionKey(sessionKey)
  )
}

export function resolveEnginePreheatDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OC_ENGINE_PREHEAT_DEADLINE_MS)
  if (Number.isFinite(raw) && raw >= 20) return Math.floor(raw)
  return ENGINE_PREHEAT_DEADLINE_DEFAULT_MS
}

/** Close a PG-active queue turn after a gateway/container restart without ever re-running it. */
export async function persistInterruptedPromptQueueTurn(args: {
  sessionKey: string
  peerId: string
  agentId: string
  userId: string
  turnIndex: number
  turnKey: string
  clientMessageId: string
}): Promise<void> {
  const outcome = await persistServerAuthoredTurnOutcome({
    sessionKey: args.sessionKey,
    peerId: args.peerId,
    agentId: args.agentId,
    userId: args.userId,
    turnIndex: args.turnIndex,
    turnKey: args.turnKey,
    clientMessageId: args.clientMessageId,
    text: '运行环境重启，本轮已安全中断并自动免单，请重新发送。',
    status: 'interrupted',
    errorCode: 'SERVICE_RESTART',
    errorDetail: 'prompt queue active turn recovered after gateway restart',
    waiveReason: 'no_response',
  })
  if (outcome === 'dropped' || outcome === 'skipped') {
    throw new Error(`prompt queue restart tape was not retained (${outcome})`)
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  private _exactOwnerRuns = new Map<string, ExactOwnerRunRecord>()
  private _sessionCreateGates = new Map<string, Promise<void>>()
  private _promptQueueExecutions = new WeakSet<AgentSession>()
  private _promptQueueExecutionKeys = new Set<string>()
  private _preStartStops = new Map<string, PreStartStopEntry>()
  private _promptQueueDispatchFences = new Map<string, symbol>()
  private _runtimeRecycleDrainUntil = 0
  private _runtimeRecycleDrainTimer: ReturnType<typeof setTimeout> | null = null
  private maxIdleMsCron = 30 * 60 * 1000
  private maxIdleMsChat = 2 * 60 * 60 * 1000
  private _tailFoldMinIntervalMs = 5000
  private _tailFoldStreamCap = 24
  private _tailFoldOwnerCap = 64
  private _tailPersistBatchMaxEvents = 32
  private _tailPersistBatchMaxBytes = 512 * 1024
  private _terminalRequestGraceMs = 5_000
  private _terminalOutputDrainTimeoutMs = 15_000
  private _tailOwnerBudgets = new Map<string, TailOwnerBudget>()
  private static readonly TAIL_OWNER_BUDGET_MAX = 512
  private _missingOwnerMetrics = { tailDropped: 0, nonTailForwarded: 0 }
  private _lastMissingOwnerWarnAt = 0
  /** @deprecated Use eventBus 'task.created'/'task.deleted' instead. */
  public onCronBridge?: (event: CronBridgeEvent) => Promise<void>
  public onAuthError?: () => Promise<void>
  public onSessionDestroyed?: (sessionKey: string) => void
  public onCcbTaskNotification?: (
    session: AgentSession,
    payload: {
      taskId: string
      status: string
      outputFile: string
      summary: string
      toolUseId?: string
    },
  ) => void
  public onCcbTaskNotificationDelivered?: (
    session: AgentSession,
    payload: { taskId: string; deliveredBy: 'ccb-mid-turn' },
  ) => void
  private _getRepoSnapshot: ((sessionId: string) => RepoSnapshot | null) | undefined
  private _sessionIdToKey = new Map<string, string>()
  private readonly resumeStore = new ResumeStore(join(paths.home, 'resume-map.json'))
  authorityStateRuntime?: SessionAuthorityRuntimePort
  capsuleRuntime?: SessionCapsuleRuntimePort
  private _remoteTargetController?: RemoteTargetController
  private _pendingPersistence = new Set<Promise<unknown>>()
  private readonly _preheatInFlight = new Map<string, Promise<PreheatOutcome>>()
  private _preheatActive = 0

  private static CCB_PROVIDER_TAG = CCB_PROVIDER_TAG
  private static CCB_RESUME_HISTORY_CONTEXT_VERSION = CCB_RESUME_HISTORY_CONTEXT_VERSION
  private static normalizeEngineTag = normalizeEngineTag

  constructor(public config: OpenClaudeConfig) {
    this._loadResumeMap()
  }

  getResumeStore(): ResumeStore {
    return this.resumeStore
  }
  private get resumeMapPath(): string {
    return this.resumeStore.path
  }
  private set resumeMapPath(path: string) {
    this.resumeStore.path = path
  }

  resolveAntigravitySwarmTarget(sessionId: string): {
    sessionKey: string
    brainDir?: string
    conversationId?: string
  } | null {
    return resolveAntigravitySwarmTargetForManager(sessionId, {
      sessionIdToKey: this._sessionIdToKey,
      sessions: this.sessions,
      resumeMap: this._resumeMap,
    })
  }

  setRepoSnapshotProvider(fn: (sessionId: string) => RepoSnapshot | null): void {
    this._getRepoSnapshot = fn
  }

  applyUserGoalAction(
    sessionKey: string,
    action: 'set' | 'pause' | 'resume' | 'clear',
    objective: string | undefined,
  ): Promise<'applied' | 'noop' | 'rejected'> {
    return applySessionUserGoalAction(this.sessions.get(sessionKey), action, objective)
  }

  syncGoalState(sessionId: string, goal: GoalStateSnapshot): Promise<void> {
    const sessionKey = this._sessionIdToKey.get(sessionId)
    return syncSessionGoalState(sessionKey ? this.sessions.get(sessionKey) : undefined, goal)
  }

  recyclePeerForRepoChange(sessionId: string, newSnapshot: RepoSnapshot | null): Promise<void> {
    return recyclePeerForRepoChangeImpl.call(this as unknown as SessionLifecycleHost, sessionId, newSnapshot)
  }

  recyclePeerForRepoUnbind(sessionId: string): Promise<void> {
    return recyclePeerForRepoUnbindImpl.call(this as unknown as SessionLifecycleHost, sessionId)
  }

  isRuntimeRecycleDraining(now = Date.now()): boolean {
    if (this._runtimeRecycleDrainUntil <= now) {
      this.releaseRuntimeRecycleDrain()
      return false
    }
    return true
  }

  private markPlannedServiceRestart(session: AgentSession): void {
    session._plannedTeardown = 'service_restart'
  }

  private shouldClassifyExitAsServiceRestart(
    session: AgentSession,
    info?: { signal: string | null; crashed?: boolean },
  ): boolean {
    if (session._plannedTeardown === 'service_restart') return true
    if (this.isRuntimeRecycleDraining()) return true
    if (info?.crashed === false) return true
    return info?.signal === 'SIGTERM'
  }

  armRuntimeRecycleDrain(ttlMs: number): { accepted: boolean; activeTurns: number } {
    return armRuntimeRecycleDrainImpl.call(this as unknown as SessionLifecycleHost, ttlMs)
  }

  releaseRuntimeRecycleDrain(): void {
    this._runtimeRecycleDrainUntil = 0
    if (this._runtimeRecycleDrainTimer) {
      clearTimeout(this._runtimeRecycleDrainTimer)
      this._runtimeRecycleDrainTimer = null
    }
  }

  updateConfig(config: OpenClaudeConfig): void {
    this.config = config
    for (const session of this.sessions.values()) {
      session.runner.updateConfig(config)
    }
  }

  setRemoteTargetController(ctrl: RemoteTargetController | undefined): void {
    this._remoteTargetController = ctrl
  }

  private _trackPersistence(p: Promise<unknown>): void {
    _trackPersistenceImpl.call(this as unknown as SessionTailHost, p)
  }

  async awaitPendingPersistence(): Promise<void> {
    if (this._pendingPersistence.size === 0) return
    await Promise.allSettled([...this._pendingPersistence])
  }

  private _chainTailPersist(session: AgentSession, task: () => Promise<void>): void {
    _chainTailPersistImpl.call(this as unknown as SessionTailHost, session, task)
  }

  private _getOwnerBudget(ownerTurnKey: string): TailOwnerBudget {
    return getOrCreateTailOwnerBudget(
      this._tailOwnerBudgets,
      ownerTurnKey,
      SessionManager.TAIL_OWNER_BUDGET_MAX,
    )
  }

  private _runOnOwnerChain(ownerTurnKey: string, task: () => Promise<void>): Promise<void> {
    return _runOnOwnerChainImpl.call(this as unknown as SessionAgentGroupsHost, ownerTurnKey, task)
  }

  private _buildTailCapMarker(item: TailFoldItem, reason: 'cap' | 'owner_cap'): DurableRuntimeEvent {
    return _buildTailCapMarkerImpl.call(this as unknown as SessionTailHost, item, reason)
  }

  private _enqueueTailPersist(
    session: AgentSession,
    st: TailFoldStreamState,
    item: TailFoldItem,
  ): void {
    st.lastPersistAt = Date.now()
    ;(session._postTerminalTailQueue ??= []).push({ st, item })
    this._scheduleTailPersistWorker(session)
  }

  private _scheduleTailPersistWorker(session: AgentSession): void {
    _scheduleTailPersistWorkerImpl.call(this as unknown as SessionTailHost, session)
  }

  private _drainTailPersistQueue(session: AgentSession): Promise<void> {
    return _drainTailPersistQueueImpl.call(this as unknown as SessionTailHost, session)
  }

  private _persistTailBatch(session: AgentSession, batch: TailPersistQueueItem[]): Promise<void> {
    return _persistTailBatchImpl.call(this as unknown as SessionTailHost, session, batch)
  }

  private _foldPostTerminalTail(session: AgentSession, item: TailFoldItem, streamKey: string): void {
    _foldPostTerminalTailImpl.call(this as unknown as SessionTailHost, session, item, streamKey)
  }

  private _warnMissingPostTerminalOwner(kind: 'tail_dropped' | 'non_tail_forwarded'): void {
    _warnMissingPostTerminalOwnerImpl.call(this as unknown as SessionTailHost, kind)
  }

  private _dispatchPostTerminalRuntimeEvent(
    session: AgentSession,
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
    ctx: {
      ownerTurnKey: string | undefined | null
      ownerSessionId: string | undefined | null
      turnIndex: number
      onEvent: (e: SessionStreamEvent) => void
    },
  ): void {
    _dispatchPostTerminalRuntimeEventImpl.call(this as unknown as SessionTailHost, session, event, block, ctx)
  }

  private _drainTailFolding(session: AgentSession, opts: { destroy: boolean }): Promise<void> {
    return _drainTailFoldingImpl.call(this as unknown as SessionTailHost, session, opts)
  }

  private async _flushTailFolding(session: AgentSession): Promise<void> {
    await this._drainTailFolding(session, { destroy: true })
  }

  async flushSessionTailFolding(session: AgentSession): Promise<void> {
    await this._drainTailFolding(session, { destroy: false })
  }

  recordExternalTurn(
    session: AgentSession,
    args: {
      userText: string
      assistantText: string
      requestId: string
      traceId?: string
      model?: string
      chatProjectId?: string | null
    },
    reservation?: PromptQueueExternalTurnReservation,
  ): Promise<{ turnIndex: number; messageId: string }> {
    return recordExternalTurnImpl.call(this as unknown as SessionSubmitHost, session, args, reservation)
  }

  async reservePromptQueueExternalTurn(
    session: AgentSession,
    queueLifecycle: TurnQueueLifecycle,
    traceId?: string,
  ): Promise<PromptQueueExternalTurnReservation> {
    const legacyId = this._resumeMap.get(session.sessionKey)
    const turnIndex = await reserveTurnIndex(session.sessionKey, {
      minimumLastTurn: session.turns,
      legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
    })
    const turnKey = deriveLosslessTurnKey({
      sessionId: session.peerId,
      agentId: session.agentId,
      turnIndex,
      status: 'completed',
      text: '',
    })
    session.turns = turnIndex - 1
    session._currentTurnKey = turnKey
    session._currentTurnIndex = turnIndex
    await queueLifecycle.onTurnReserved({
      turnIndex,
      turnKey,
      ...(traceId ? { traceId } : {}),
    })
    return { turnIndex, turnKey }
  }

  beginExternalTurn(
    session: AgentSession,
    opts?: {
      queueTurn?: boolean
      queueExecutionFence?: PromptQueueExecutionFence
      clientMessageId?: string
    },
  ): Promise<{ signal: AbortSignal; finish: (outcome: 'completed' | 'errored') => void }> {
    return beginExternalTurnImpl.call(this as unknown as SessionSubmitHost, session, opts)
  }

  private get _resumeMap() { return this.resumeStore.ids }
  private get _resumeMapProvider() { return this.resumeStore.provider }
  private get _resumeMapHistory() { return this.resumeStore.history }
  private get _resumeRejectedIds() { return this.resumeStore.rejected }
  private get _resumeHeadPromotedFromHistory() { return this.resumeStore.promotedFromHistory }
  private get _resumeMapTimestamps() { return this.resumeStore.timestamps }
  private get _resumeMapLastCost() { return this.resumeStore.lastCost }
  private get _resumeMapCostImprecise() { return this.resumeStore.costImprecise }
  private get _resumeMapWrite() { return this.resumeStore.write }

  private _pushResumeHistory(key: string, prev: string | undefined | null): void {
    this.resumeStore.pushHistory(key, prev)
  }

  static extractRejectedResumeIds(errorDetail: string | undefined): string[] {
    return ResumeStore.extractRejectedIds(errorDetail)
  }

  private _markResumeRejectedFromError(
    key: string,
    errorDetail: string | undefined,
    liveId: string | null | undefined,
  ): string[] {
    return this.resumeStore.markRejectedFromError(key, errorDetail, liveId)
  }

  private _markResumeRejected(key: string, id: string | undefined | null): void {
    this.resumeStore.markRejected(key, id)
  }

  private _forgetResumeEntry(key: string): void {
    const prevProvider = this.resumeStore.provider.get(key)
    this.resumeStore.forget(key)
    this.authorityStateRuntime?.syncResumeReset(key, prevProvider)
  }

  private _resolveDurableResumeId(
    sessionKey: string,
    provider: string,
    head: string | undefined,
    workspacePath?: string,
    opts?: { exclude?: string; syncRunner?: boolean },
  ): string | undefined {
    return _resolveDurableResumeIdImpl.call(this as unknown as SessionSubmitHost, sessionKey, provider, head, workspacePath, opts)
  }

  private _resumeIdFor(sessionKey: string, wantProvider: string, workspacePath?: string): string | undefined {
    return _resumeIdForImpl.call(this as unknown as SessionSubmitHost, sessionKey, wantProvider, workspacePath)
  }

  private _releaseGrokResumeHead(sessionKey: string): void {
    const live = this.sessions.get(sessionKey)
    if (!live || live.providerTag !== 'grok') return
    live.ccbSessionId = null
    live.runner.clearSessionId()
    live._historicalContextInjected = false
    live._historicalContextInjectedKey = undefined
    live._forceHistoricalContextOnFirstTurn = true
    live._contextRebuildNotice = 'native-resume-loss'
  }

  private _cursorWorkspacePath(agentBaseDir: string, repoSessionId?: string, projectBound?: boolean): string {
    return _cursorWorkspacePathImpl.call(this as unknown as SessionLifecycleHost, agentBaseDir, repoSessionId, projectBound)
  }

  private _cursorWorkspacePathForSession(session: AgentSession): string | undefined {
    if (!session.workspaceCwd) return undefined
    return this._cursorWorkspacePath(
      session.workspaceCwd,
      session.repoSessionId ?? session.peerId,
      Boolean(session.projectId),
    )
  }

  private _ccbJsonlExists(resumeId: string): boolean {
    return _ccbJsonlExistsImpl.call(this as unknown as SessionLifecycleHost, resumeId)
  }

  private _lastCostFor(sessionKey: string, wantProvider: string): number | undefined {
    const cost = this._resumeMapLastCost.get(sessionKey)
    if (cost === undefined) return undefined
    const tag = SessionManager.normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
    return tag === wantProvider ? cost : undefined
  }

  private _costImpreciseFor(sessionKey: string, wantProvider: string): boolean {
    const tag = SessionManager.normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
    return tag === wantProvider && this._resumeMapCostImprecise.get(sessionKey) === true
  }

  private _loadResumeMap(): void {
    this.resumeStore.load()
  }

  private _saveResumeMap(): void {
    this.resumeStore.persist(this.resumeStore.serialize(this.sessions))
    if (this.authorityStateRuntime?.isRemoteEnabled) {
      this.authorityStateRuntime.syncResumeSnapshots(collectResumeSyncSnapshots(this.resumeStore))
    }
  }

  async awaitResumeMapFlush(): Promise<void> {
    await Promise.allSettled([
      this.resumeStore.flush(),
      this.authorityStateRuntime?.flush() ?? Promise.resolve(),
    ])
  }

  getResumableKeys(filter?: (key: string) => boolean): string[] {
    const keys = [...this._resumeMap.keys()]
    return filter ? keys.filter(filter) : keys
  }

  beginPromptQueueExecutionFence(sessionKey: string): PromptQueueExecutionFence {
    return beginSessionPromptQueueFence(sessionKey, {
      sessions: this.sessions,
      dispatchFences: this._promptQueueDispatchFences,
      executionKeys: this._promptQueueExecutionKeys,
    })
  }

  private _ownsPromptQueueExecutionFence(
    sessionKey: string,
    fence: PromptQueueExecutionFence | undefined,
  ): boolean {
    return (
      fence !== undefined &&
      fence.sessionKey === sessionKey &&
      this._promptQueueDispatchFences.get(sessionKey) === fence.token
    )
  }

  getOrCreate(opts: GetOrCreateOpts): Promise<AgentSession> {
    return getOrCreateImpl.call(this as unknown as SessionSubmitHost, opts)
  }

  private async _enterSessionCreateGate<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this._sessionCreateGates.get(sessionKey) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held, () => held)
    this._sessionCreateGates.set(sessionKey, tail)
    try {
      await previous
      return await work()
    } finally {
      release()
      if (this._sessionCreateGates.get(sessionKey) === tail) {
        this._sessionCreateGates.delete(sessionKey)
      }
    }
  }

  private _getOrCreateExclusive(opts: GetOrCreateOpts): Promise<AgentSession> {
    return _getOrCreateExclusiveImpl.call(this as unknown as SessionSubmitHost, opts)
  }

  prepareModelSwitch(
    session: AgentSession,
    expectedSourceModel: string,
    targetModel: string,
    switchId: string,
  ): Promise<{ sourceModel: string; targetModel: string }> {
    return prepareModelSwitchImpl.call(
      this as unknown as SessionLifecycleHost,
      session,
      expectedSourceModel,
      targetModel,
      switchId,
    )
  }

  private async finishIdleUnderLock(
    session: AgentSession,
    source: { sessionId: string; turnKey: string },
    recoveryDir: string = paths.home,
    mode: 'after_turn' | 'pre_expiry' = 'after_turn',
  ): Promise<'deferred' | void> {
    return finishIdleUnderLockImpl.call(this as unknown as SessionSubmitHost, session, source, recoveryDir, mode)
  }

  private scheduleIdleDrain(session: AgentSession, attempt = 0): void {
    scheduleIdleDrainImpl.call(this as unknown as SessionLifecycleHost, session, attempt)
  }

  private applyIdleResetIfRequested(session: AgentSession): Promise<void> {
    return applyIdleResetIfRequestedImpl.call(this as unknown as SessionLifecycleHost, session)
  }

  cancelModelSwitch(session: AgentSession, switchId: string): boolean {
    const transition = session._modelSwitchTransition
    if (!transition || transition.id !== switchId || transition.state === 'consuming') return false
    session._modelSwitchTransition = undefined
    return true
  }

  private _promptQueueHolds(session: AgentSession): boolean {
    return (
      this._promptQueueExecutions.has(session) ||
      this._promptQueueExecutionKeys.has(session.sessionKey) ||
      this._promptQueueDispatchFences.has(session.sessionKey)
    )
  }

  preheatRunner(session: AgentSession, preparation?: PreheatPreparation): Promise<PreheatOutcome> {
    return preheatRunnerImpl.call(this as unknown as SessionLifecycleHost, session, preparation)
  }

  submit(
    session: AgentSession,
    userTextOrBlocks: TurnUserInput,
    onEvent: (e: SessionStreamEvent) => void,
    effortLevel?: string | null,
    model?: string,
    requestId?: string,
    traceId?: string,
    conversationMode?: 'default' | 'plan',
    opts?: SubmitOpts,
  ): Promise<void> {
    return submitImpl.call(
      this as unknown as SessionSubmitHost,
      session,
      userTextOrBlocks,
      onEvent,
      effortLevel,
      model,
      requestId,
      traceId,
      conversationMode,
      opts,
    )
  }

  private runOneTurnWithRetry(
    session: AgentSession,
    userTextOrBlocks: TurnUserInput,
    onEvent: (e: SessionStreamEvent) => void,
    requestId?: string,
    traceId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    modelAuthority?: TurnModelAuthority,
    clientMessageId?: string,
    dispatchContext?: AgentSession['_currentDispatch'],
    queueLifecycle?: TurnQueueLifecycle,
    logicalTurnSignal?: AbortSignal,
    contextOverflowRetryInputs: string[] = [],
    automaticRetryState?: AutomaticRetryState,
    modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
    grokExecutionDescriptor?: GrokExecutionDescriptor,
  ): Promise<void> {
    return runOneTurnWithRetryImpl.call(
      this as unknown as TurnRunnerHost,
      session,
      userTextOrBlocks,
      onEvent,
      requestId,
      traceId,
      collabAgentPolicy,
      modelAuthority,
      clientMessageId,
      dispatchContext,
      queueLifecycle,
      logicalTurnSignal,
      contextOverflowRetryInputs,
      automaticRetryState,
      modelSwitchTransition,
      grokExecutionDescriptor,
    )
  }

  private _transientRetryDelayMs(attempt: number): number {
    return Math.min(30_000, 2000 * 2 ** attempt) + Math.random() * 1000
  }

  private _awaitBoundedOutputDrain(
    runner: Pick<EngineAdapter, 'waitForOutputDrain'>,
    session: AgentSession,
  ): Promise<void> {
    return awaitBoundedOutputDrainWithTimeout(runner, session, this._terminalOutputDrainTimeoutMs)
  }

  private _runOneTurn(
    session: AgentSession,
    userTextOrBlocks: TurnUserInput,
    onEvent: (e: SessionStreamEvent) => void,
    requestId?: string,
    traceId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    assistantMessageId?: string,
    thinkingMessageId?: string,
    toolMessageIdFactory?: (blockId: string) => string,
    turnKey?: string,
    clientMessageId?: string,
    modelAuthority?: TurnModelAuthority,
    retryRuntimeEvents: DurableRuntimeEvent[] = [],
    retryAssistantSegments: SegmentRecord[] = [],
    retryThinkingSegments: SegmentRecord[] = [],
    retryTools: TurnToolEntry[] = [],
    retryStructuredBlocks: Array<Record<string, unknown>> = [],
    queueTurn = false,
    retryAuthErrors = true,
    retryPhantomErrors = true,
    retryTransientErrors = false,
    attemptOrdinal = 0,
    automaticRetryState?: AutomaticRetryState,
    modelSwitchTransition?: AgentSession['_modelSwitchTransition'],
    grokExecutionDescriptor?: GrokExecutionDescriptor,
  ): Promise<void> {
    return _runOneTurnImpl.call(
      this as unknown as TurnRunnerHost,
      session,
      userTextOrBlocks,
      onEvent,
      requestId,
      traceId,
      collabAgentPolicy,
      assistantMessageId,
      thinkingMessageId,
      toolMessageIdFactory,
      turnKey,
      clientMessageId,
      modelAuthority,
      retryRuntimeEvents,
      retryAssistantSegments,
      retryThinkingSegments,
      retryTools,
      retryStructuredBlocks,
      queueTurn,
      retryAuthErrors,
      retryPhantomErrors,
      retryTransientErrors,
      attemptOrdinal,
      automaticRetryState,
      modelSwitchTransition,
      grokExecutionDescriptor,
    )
  }

  interrupt(sessionKey: string, reason: 'user' | 'system' = 'system'): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    const external = s._externalTurnAbort
    if (external && !external.signal.aborted) external.abort()
    const persistActiveTurn = s._persistActiveTurn
    if (persistActiveTurn) {
      const persistence =
        reason === 'user'
          ? persistActiveTurn('interrupted', '本轮已由用户停止。', 'USER_CANCELLED')
          : persistActiveTurn('interrupted', '本轮因系统调度中断。', 'SYSTEM_INTERRUPT')
      this._trackPersistence(persistence)
      return true
    }
    const runnerInterrupted = s.runner.interrupt(reason)
    return !!external || runnerInterrupted
  }

  interruptExact(sessionKey: string, turnKey: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._currentTurnKey !== turnKey) return false
    return this.interrupt(sessionKey, 'user')
  }

  interruptClientTurn(sessionKey: string, clientMessageId: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._runningClientMessageId !== clientMessageId) return false
    if (!session._persistActiveTurn) this.fencePreStartStop(session.peerId, clientMessageId)
    return this.interrupt(sessionKey, 'user')
  }

  fencePreStartStop(
    peerId: string,
    clientMessageId: string,
    ttlMs: number = PRE_START_STOP_TTL_MS,
    sendAttempt?: number,
  ): void {
    recordPreStartStopFence(this._preStartStops, peerId, clientMessageId, ttlMs, sendAttempt)
  }

  adoptPreStartStopOnAdmission(peerId: string, clientMessageId: string, sendAttempt?: number): void {
    adoptPreStartStopFence(this._preStartStops, peerId, clientMessageId, sendAttempt)
  }

  clearPreStartStop(peerId: string, clientMessageId: string): void {
    this._preStartStops.delete(`${peerId.replace(/[^a-zA-Z0-9_-]/g, '_')}\u0000${clientMessageId}`)
  }

  private _takePreStartStop(peerId: string, clientMessageId: string): boolean {
    return consumePreStartStopFence(this._preStartStops, peerId, clientMessageId)
  }

  getByKey(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)
  }

  bufferPendingAgentGroup(
    parentSessionKey: string,
    group: DurableAgentGroup,
    owner?: DelegateOwnerTurnLocator,
  ): boolean {
    return bufferPendingAgentGroupImpl.call(this as unknown as SessionAgentGroupsHost, parentSessionKey, group, owner)
  }

  drainPendingAgentGroups(session: AgentSession, turnKey?: string): DurableAgentGroup[] {
    return drainPendingAgentGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey)
  }

  deliverLateDelegateAgentGroup(args: {
    owner: DelegateOwnerTurnLocator
    group: DurableAgentGroup
    sessionKey?: string
  }): boolean {
    return deliverLateDelegateAgentGroupImpl.call(this as unknown as SessionAgentGroupsHost, args)
  }

  private _exactOwnerRunKey(ownerTurnKey: string, runId: string): string {
    return `${ownerTurnKey}\0${runId}`
  }

  private _trimExactOwnerRuns(): void {
    _trimExactOwnerRunsImpl.call(this as unknown as SessionAgentGroupsHost)
  }

  private _ownerLocatorForSession(
    session: AgentSession,
    turnKey: string,
  ): DelegateOwnerTurnLocator {
    return {
      parentSessionId: session.peerId,
      parentTurnKey: turnKey,
      turnIndex:
        session._currentTurnIndex ??
        (Number.isSafeInteger(session.turns) ? Math.max(1, session.turns) : 1),
    }
  }

  private _admitExactOwnerRun(
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
    next: ExactOwnerRunState,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _admitExactOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, owner, group, next)
  }

  private _claimDrainedOwnerGroups(
    session: AgentSession,
    turnKey: string,
    groups: DurableAgentGroup[],
  ): void {
    _claimDrainedOwnerGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey, groups)
  }

  private _settleDrainedOwnerGroups(
    session: AgentSession,
    turnKey: string,
    groups: DurableAgentGroup[],
    outcome: TapePersistResult,
  ): void {
    _settleDrainedOwnerGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey, groups, outcome)
  }

  private _compareOwnerRunIdentity(
    seenIdentity: string,
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
  ): 'duplicate' | 'conflict' {
    if (!seenIdentity) return 'duplicate'
    return seenIdentity === lateDelegateGroupIdentity(owner, group) ? 'duplicate' : 'conflict'
  }

  private _matchLiveOwnerRun(
    session: AgentSession,
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _matchLiveOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, session, owner, group)
  }

  private _matchLiveSessionsOwnerRun(
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
    sessionKey?: string,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _matchLiveSessionsOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, owner, group, sessionKey)
  }

  private _sealOwnerTurn(session: AgentSession, turnKey: string): void {
    _sealOwnerTurnImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey)
  }

  beginClientTurn(session: AgentSession): void {
    session._activeClientTurnCount = (session._activeClientTurnCount ?? 0) + 1
  }

  endClientTurn(
    session: AgentSession,
    outcome: 'completed' | 'errored',
    clientMessageId?: string,
  ): void {
    session._activeClientTurnCount = Math.max(0, (session._activeClientTurnCount ?? 0) - 1)
    session._lastClientTurnOutcome = outcome
    if (clientMessageId) {
      recordRecentTerminal(
        session,
        clientMessageId,
        outcome === 'completed' ? 'completed' : 'interrupted',
      )
    }
  }

  setExecutionTarget(
    sessionKey: string,
    target: { kind: 'local' } | { kind: 'remote'; hostId: string },
  ): Promise<void> {
    return setExecutionTargetImpl.call(this as unknown as SessionLifecycleHost, sessionKey, target)
  }

  destroySession(sessionKey: string): Promise<void> {
    return destroySessionImpl.call(this as unknown as SessionLifecycleHost, sessionKey)
  }

  retireKeepResume(
    sessionKey: string,
    opts?: { expectedSession?: AgentSession; onlyIfIdle?: boolean },
  ): Promise<void> {
    return retireKeepResumeImpl.call(this as unknown as SessionLifecycleHost, sessionKey, opts)
  }

  hasLiveSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }

  forgetResume(sessionKey: string): void {
    if (!this._resumeMap.has(sessionKey) && !this.authorityStateRuntime?.isRemoteEnabled) return
    this._forgetResumeEntry(sessionKey)
    this._saveResumeMap()
  }

  quarantineSessionResume(sessionKey: string): void {
    const live = this.sessions.get(sessionKey)
    if (live) {
      live.ccbSessionId = null
      live.runner.clearSessionId?.()
    }
    this.resumeStore.persist(this.resumeStore.serialize(this.sessions))
  }

  beginPlannedShutdown(): void {
    for (const s of this.sessions.values()) {
      try {
        s.runner.beginPlannedShutdown?.()
      } catch (err) {
        log.warn('beginPlannedShutdown failed', { sessionKey: s.sessionKey }, err)
      }
    }
  }

  shutdownAll(): Promise<void> {
    return shutdownAllImpl.call(this as unknown as SessionLifecycleHost)
  }

  list(): {
    sessionKey: string
    agentId: string
    lastUsedAt: number
    ccbSessionId: string | null
    turns: number
    totalCostUSD: number
  }[] {
    return [...this.sessions.values()].map((s) => ({
      sessionKey: s.sessionKey,
      agentId: s.agentId,
      lastUsedAt: s.lastUsedAt,
      ccbSessionId: s.ccbSessionId,
      turns: s.turns,
      totalCostUSD: s.totalCostUSD,
    }))
  }

  runEvictionPass(): Promise<EvictionPassResult> {
    return runEvictionPassImpl.call(this as unknown as SessionLifecycleHost)
  }

  startEvictionLoop(intervalMs = 60_000): () => void {
    return startEvictionLoopImpl.call(this as unknown as SessionLifecycleHost, intervalMs)
  }

  private _pruneResumeMap(): void {
    const pruned = this.resumeStore.prune(
      (key) => this.sessions.has(key),
      RESUME_MAP_INACTIVE_TTL_MS,
    )
    for (const { key, ageMs } of pruned) {
      log.info('pruned idle resume-map entry', { sessionKey: key, ageMs })
    }
    if (pruned.length > 0) this._saveResumeMap()
  }
}
