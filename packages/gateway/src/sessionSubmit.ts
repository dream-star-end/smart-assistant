/**
 * Session submit path: submit, getOrCreate / exclusive create, idle finish, external turns, resume-id resolution.
 */
import { beginIdleWait, endIdleWait } from './boxIdleWait.js'
import { recoverUnconfirmedIdle } from './boxIdleRecovery.js'
import {
  isServiceTier,
  sameRemoteExecutionBackend,
  type ServiceTier,
} from '@openclaude/protocol'
import { restartRunnerForConfigChange } from './runnerConfigRestart.js'
import { BOX_IDLE_PRE_EXPIRY_MIN_TOKENS, boxIdlePreExpiryMs, cancelIdlePreExpiry } from './boxContextBudget.js'
import { cc5SessionBackend, assertFreshCc5Session } from './cc5SessionBackend.js'
import { buildHistoricalContextPayload } from './historicalContextPayload.js'
import { getSystemHelpRelay, systemHelpContextFile } from './systemHelpRelay.js'
import {
  prepareRunnerPromptPrivacy,
  refreshRunnerPromptPrivacy,
  assertRunnerPromptPrivacyStopped,
  clearRunnerPromptPrivacy,
  type PromptPrivacyRunner,
} from './promptPrivacyRuntime.js'
import {
  getDesiredIntelligentUi,
  intelligentUiNeedsRestart,
  isIntelligentUiApplied,
} from './intelligentUiDesired.js'
import {
  resolveRuntimeExecutionAgent,
  IdentityAssetsError,
  getMaxTurnIdx,
  hasPersistedTurnActivity,
  MemoryDir,
  type MemoryTurnPolicyDecision,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  readMemoryTurnPolicy,
  paths,
  type KernelFileLock,
} from '@openclaude/storage'
import {
  advanceIdleOp,
  boxTurnMayIdle,
  currentIdleSource,
  idleAbandonReason,
  idleCandidateAgedOut,
  idleOpSettled,
  idleProofWaitMs,
  pruneIdleOps,
  sourceNeedsIdleOp,
  idleCompactAlways,
  IDLE_COMPACT_PROMPT,
  IdleCompactRejected,
  idleHistoryStillBlocked,
  idleRecoveryRemainingMs,
  idleSummaryAccepted,
  idleNativePath,
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
import {
  BOX_IDLE_TURN_TIMEOUT_MS,
  boxIdleTurnTimeoutMs,
  IdleTurnTimeoutError,
  runBoxIdleTurn,
  shutdownIdleRunner,
} from './boxIdleTurn.js'
import type { SessionStreamEvent } from './engine/engineEvents.js'
import {
  createEngine,
  EngineNotEnabledError,
  isEngineEnabled,
  resolveEngine,
} from './engine/registry.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import { normalizeEngineTag } from './resumeStore.js'
import { adoptRunContext } from './runContextPersist.js'
import { resolveExecutionModel } from './server.js'
import { startMemoryTurnPolicyLease } from './memoryTurnPolicyLease.js'
import { contextAuthorities, type ContextTurnHandle } from './contextAuthority.js'
import { finalizeEfficiencyTurn, prepareEfficiencyTurnNote } from './agentEfficiencyGuard.js'
import { isRemoteV4ResumeId, parseRemoteV4ResumeId } from './remotePool/resumeId.js'
import { log } from './sessionManagerLog.js'
import {
  resolveDefaultWorkspaceCwd,
  isCommercialManagedRuntime,
  buildHistoricalContextPrompt,
  pickIdleTimeoutMs,
  persistServerAuthoredTurnOutcome,
  RuntimeRecycleDrainingError,
} from './sessionManager.js'
import {
  isSessionCompacting,
  type PersistedCheckpointRecord,
} from './sessionCheckpointStore.js'
import { prepareSessionAuthorityBeforeCreate } from './sessionAuthorityHook.js'
import {
  beginTurnOverflowContext,
  clearTurnOverflowContext,
  getTurnActiveCheckpointGeneration,
  maybeAutoCompactBeforeTurn,
} from './sessionAutoCompact.js'
import type {
  SessionManager,
  PromptQueueExternalTurnReservation,
  AgentSession,
  PromptQueueExecutionFence,
  GetOrCreateOpts,
  SubmitOpts,
} from './sessionManager.js'
import type { TurnUserInput } from './session/types.js'
import {
  checkSubmitCommercialAndBillingGuards,
  isDispatchCancelledBeforeStart,
  normalizeToolsetListForCompare,
  resolveModelSwitchAdmission,
  sameToolsetsForCompare,
  startReplayLifecycleSafely,
  validateRuntimeIdentityAdmission,
  validateSubmitQueueAdmission,
} from './session/submitAdmission.js'
import {
  prepareSubmitRunnerPayload,
  type SubmitContextPrepDeps,
} from './session/submitContextPrep.js'
import {
  ackTurnCheckpointOnSuccess,
  createTurnLivenessWatchdog,
  finalizeSubmitReplayAndState,
  handleTurnIdleTimeoutError,
  isTurnIdleTimeoutError,
  runSubmitPreBarrierCleanup,
  type SubmitCleanupDeps,
} from './session/submitLifecycle.js'
import { finishIdleUnderLockFlow, type BoxIdleFlowDeps } from './session/boxIdleFlow.js'
import {
  attachSessionRunnerListeners,
  computeCanIdentityRefresh,
  computeSessionContextFingerprint,
  needsSessionReplacement,
  resolveMappedResumeForCreate,
  resolveReplacementRebuildNotice,
  shutdownReplacedSession,
  validateCreateModelSwitchGuard,
} from './session/sessionCreate.js'
import {
  beginExternalTurnFlow,
  recordExternalTurnFlow,
  type ExternalTurnDeps,
} from './session/externalTurn.js'

export interface SessionSubmitHost {
  _ccbJsonlExists: SessionManager['_ccbJsonlExists']
  _costImpreciseFor: SessionManager['_costImpreciseFor']
  _cursorWorkspacePath: SessionManager['_cursorWorkspacePath']
  _cursorWorkspacePathForSession: SessionManager['_cursorWorkspacePathForSession']
  _enterSessionCreateGate: SessionManager['_enterSessionCreateGate']
  _forgetResumeEntry: SessionManager['_forgetResumeEntry']
  _getOrCreateExclusive: SessionManager['_getOrCreateExclusive']
  _getRepoSnapshot: SessionManager['_getRepoSnapshot']
  _lastCostFor: SessionManager['_lastCostFor']
  _markResumeRejected: SessionManager['_markResumeRejected']
  _ownsPromptQueueExecutionFence: SessionManager['_ownsPromptQueueExecutionFence']
  _promptQueueDispatchFences: SessionManager['_promptQueueDispatchFences']
  _promptQueueExecutionKeys: SessionManager['_promptQueueExecutionKeys']
  _promptQueueExecutions: SessionManager['_promptQueueExecutions']
  _pushResumeHistory: SessionManager['_pushResumeHistory']
  _releaseGrokResumeHead: SessionManager['_releaseGrokResumeHead']
  _resolveDurableResumeId: SessionManager['_resolveDurableResumeId']
  _resumeIdFor: SessionManager['_resumeIdFor']
  _resumeMap: SessionManager['_resumeMap']
  _resumeMapCostImprecise: SessionManager['_resumeMapCostImprecise']
  _resumeMapHistory: SessionManager['_resumeMapHistory']
  _resumeHeadPromotedFromHistory: SessionManager['_resumeHeadPromotedFromHistory']
  _resumeMapLastCost: SessionManager['_resumeMapLastCost']
  _resumeMapProvider: SessionManager['_resumeMapProvider']
  _resumeMapTimestamps: SessionManager['_resumeMapTimestamps']
  _resumeRejectedIds: SessionManager['_resumeRejectedIds']
  _saveResumeMap: SessionManager['_saveResumeMap']
  _sessionIdToKey: SessionManager['_sessionIdToKey']
  _trackPersistence: SessionManager['_trackPersistence']
  applyIdleResetIfRequested: SessionManager['applyIdleResetIfRequested']
  authorityStateRuntime?: SessionManager['authorityStateRuntime']
  capsuleRuntime?: SessionManager['capsuleRuntime']
  getResumeStore?: SessionManager['getResumeStore']
  awaitResumeMapFlush: SessionManager['awaitResumeMapFlush']
  beginClientTurn: SessionManager['beginClientTurn']
  config: SessionManager['config']
  endClientTurn: SessionManager['endClientTurn']
  finishIdleUnderLock: SessionManager['finishIdleUnderLock']
  getOrCreate: SessionManager['getOrCreate']
  isRuntimeRecycleDraining: SessionManager['isRuntimeRecycleDraining']
  onCcbTaskNotification: SessionManager['onCcbTaskNotification']
  onCcbTaskNotificationDelivered: SessionManager['onCcbTaskNotificationDelivered']
  runOneTurnWithRetry: SessionManager['runOneTurnWithRetry']
  scheduleIdleDrain: SessionManager['scheduleIdleDrain']
  sessions: SessionManager['sessions']
}

function persistServerAuthoredTurn(
  args: Parameters<typeof persistServerAuthoredTurnOutcome>[0],
): Promise<boolean> {
  return persistServerAuthoredTurnOutcome(args).then((r) => r === 'acked' || r === 'skipped')
}

function buildContextPrepDeps(host: SessionSubmitHost): SubmitContextPrepDeps {
  return {
    isRemoteV4ResumeId,
    parseRemoteV4ResumeId,
    buildHistoricalContextPrompt,
    buildHistoricalContextPayload,
    prepareEfficiencyTurnNote,
    getResumeMapId: (key) => host._resumeMap.get(key),
    getResumeHeadPromotedFromHistory: (key) => host._resumeHeadPromotedFromHistory.get(key),
    forgetResumeEntry: (key) => host._forgetResumeEntry(key),
    saveResumeMap: () => host._saveResumeMap(),
    awaitResumeMapFlush: () => host.awaitResumeMapFlush(),
    cursorWorkspacePathForSession: (s) => host._cursorWorkspacePathForSession(s),
    ccbJsonlExists: (id) => host._ccbJsonlExists(id),
    resumeIdFor: (key, wantProvider, cwd) => host._resumeIdFor(key, wantProvider, cwd),
  }
}

function buildCleanupDeps(host: SessionSubmitHost): SubmitCleanupDeps {
  return {
    clearRunnerPromptPrivacy,
    getTurnActiveCheckpointGeneration,
    clearTurnOverflowContext,
    finalizeEfficiencyTurn,
    boxTurnMayIdle,
    writeIdleCandidate,
    currentIdleSource,
    isIdleCompactRejected: (err) => err instanceof IdleCompactRejected,
    releasePromptQueueSession: (s) => {
      host._promptQueueExecutions.delete(s)
      host._promptQueueExecutionKeys.delete(s.sessionKey)
    },
    scheduleIdleDrain: (s) => host.scheduleIdleDrain(s),
  }
}

function buildBoxIdleDeps(): BoxIdleFlowDeps {
  return {
    BOX_IDLE_PRE_EXPIRY_MIN_TOKENS,
    BOX_IDLE_TURN_TIMEOUT_MS,
    IDLE_COMPACT_PROMPT,
    boxIdlePreExpiryMs,
    boxIdleTurnTimeoutMs,
    advanceIdleOp,
    clearIdleCandidate,
    idleAbandonReason,
    idleCandidateAgedOut,
    idleCompactAlways,
    idleNativePath,
    idleOpSettled,
    idleProofWaitMs,
    idleSummaryAccepted,
    nativeShortForOp,
    pruneIdleOps,
    readIdleCandidate,
    readIdleNative,
    readIdleOp,
    readPendingIdle,
    sourceNeedsIdleOp,
    startIdleOp,
    withIncarnationShutdown,
    writeIdleNative,
    writeIdleOp,
    recoverUnconfirmedIdle,
    runBoxIdleTurn,
    shutdownIdleRunner,
    createIdleTurnTimeoutError: (killed) => new IdleTurnTimeoutError(killed),
    isIdleTurnTimeoutError: (err): err is IdleTurnTimeoutError => err instanceof IdleTurnTimeoutError,
    createIdleCompactRejected: (code) => new IdleCompactRejected(code),
    refreshRunnerPromptPrivacy,
    clearRunnerPromptPrivacy,
  }
}

function buildExternalTurnDeps(host: SessionSubmitHost): ExternalTurnDeps {
  return {
    getResumeMapId: (key) => host._resumeMap.get(key),
    trackPersistence: (p) => host._trackPersistence(p),
    persistServerAuthoredTurn,
    forgetResumeEntry: (key) => host._forgetResumeEntry(key),
    saveResumeMap: () => host._saveResumeMap(),
    isRuntimeRecycleDraining: () => host.isRuntimeRecycleDraining(),
    ownsPromptQueueExecutionFence: (key, fence) => host._ownsPromptQueueExecutionFence(key, fence),
    beginClientTurn: (s) => host.beginClientTurn(s),
    endClientTurn: (s, outcome) => host.endClientTurn(s, outcome),
    hasQueueExecutionSession: (s) => host._promptQueueExecutions.has(s),
    hasQueueExecutionKey: (key) => host._promptQueueExecutionKeys.has(key),
    hasDispatchFenceKey: (key) => host._promptQueueDispatchFences.has(key),
    addQueueExecution: (s) => {
      host._promptQueueExecutions.add(s)
      host._promptQueueExecutionKeys.add(s.sessionKey)
    },
    deleteQueueExecution: (s) => {
      host._promptQueueExecutions.delete(s)
      host._promptQueueExecutionKeys.delete(s.sessionKey)
    },
  }
}

async function resolveIdleRecoveryUnderLock(
  host: SessionSubmitHost,
  session: AgentSession,
  opts: SubmitOpts | undefined,
  closeIdleWait: (() => void) | undefined,
): Promise<void> {
  if (opts?.modelSwitchInternal === undefined) await host.applyIdleResetIfRequested(session)
  const pendingIdle = readPendingIdle(paths.home, session.sessionKey)
  const idleCandidate = readIdleCandidate(paths.home, session.sessionKey)
  if ((pendingIdle || idleCandidate) && opts?.modelSwitchInternal === undefined) {
    try {
      await host.finishIdleUnderLock(session, {
        sessionId: pendingIdle?.sourceSessionId ?? idleCandidate!.sessionId,
        turnKey: pendingIdle?.sourceTurnKey ?? idleCandidate!.turnKey,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'IDLE_RECOVERY_CORRUPT') throw error
      log.warn('box idle recovery remains unsafe', { sessionKey: session.sessionKey }, error)
      throw new IdleCompactRejected('IDLE_RECOVERY_PENDING', idleRecoveryRemainingMs(paths.home, pendingIdle))
    }
    const still = readIdleCandidate(paths.home, session.sessionKey)
    const recovered = pendingIdle ? readIdleOp(paths.home, session.sessionKey, pendingIdle.revision) : undefined
    if (idleHistoryStillBlocked({ candidate: still, pending: pendingIdle, recovered })) {
      throw new IdleCompactRejected('IDLE_RECOVERY_PENDING', idleRecoveryRemainingMs(paths.home, recovered ?? pendingIdle))
    }
  }
  endIdleWait(session)
  closeIdleWait?.()
  session._idleDeadline = undefined
  const execDesc = opts?.modelAuthority?.executionDescriptor as { contextOwner?: unknown } | undefined
  session._boxContextOwner = typeof execDesc?.contextOwner === 'string' ? execDesc.contextOwner : undefined
}

function applyRunnerRouteOverrides(session: AgentSession, opts: SubmitOpts | undefined): void {
  const maybeSetCodexRoute = (session.runner as any).setCodexRoute
  if (typeof maybeSetCodexRoute === 'function') maybeSetCodexRoute.call(session.runner, opts?.codexRoute ?? null)
  const maybeSetGrokRoute = (session.runner as any).setGrokRoute
  if (typeof maybeSetGrokRoute === 'function') maybeSetGrokRoute.call(session.runner, opts?.grokRoute ?? null)
  const maybeSetZcodeRoute = (session.runner as any).setZcodeRoute
  if (typeof maybeSetZcodeRoute === 'function') maybeSetZcodeRoute.call(session.runner, opts?.zcodeRoute ?? null)
  const maybeSetAntigravityRoute = (session.runner as any).setAntigravityRoute
  if (typeof maybeSetAntigravityRoute === 'function') {
    maybeSetAntigravityRoute.call(session.runner, opts?.antigravityRoute ?? null)
  }
}

function applyRunnerServiceTier(
  session: AgentSession,
  opts: SubmitOpts | undefined,
  modelChanged: boolean,
  model: string | undefined,
): boolean {
  const maybeSetServiceTier = (
    session.runner as { setServiceTier?: (tier: ServiceTier | null, m: string | undefined) => string }
  ).setServiceTier
  if (!Object.prototype.hasOwnProperty.call(opts ?? {}, 'serviceTier') || typeof maybeSetServiceTier !== 'function') {
    return false
  }
  return (
    maybeSetServiceTier.call(
      session.runner,
      isServiceTier(opts?.serviceTier) ? opts.serviceTier : null,
      modelChanged ? model : session.runner.model,
    ) === 'restart'
  )
}

async function restartRunnerIfConfigChanged(args: {
  session: AgentSession
  traceId: string | undefined
  flags: {
    effortChanged: boolean
    modelChanged: boolean
    toolsetsChanged: boolean
    iuiChanged: boolean
    privacyChanged: boolean
    serviceTierChanged: boolean
  }
}): Promise<void> {
  const { session, traceId, flags } = args
  if (
    !flags.effortChanged &&
    !flags.modelChanged &&
    !flags.toolsetsChanged &&
    !flags.iuiChanged &&
    !flags.privacyChanged &&
    !flags.serviceTierChanged
  ) {
    return
  }
  log.info('runner_config_restart', {
    sessionKey: session.sessionKey,
    running: session.runner.isRunning,
    ...flags,
  })
  try {
    await restartRunnerForConfigChange(session.runner)
    if (flags.privacyChanged) assertRunnerPromptPrivacyStopped(session.runner)
  } catch (err) {
    if (flags.privacyChanged) {
      throw new Error('助手隐私设置尚未生效，本轮未发送；请稍后重试或新建会话。', { cause: err })
    }
    log.warn('effort/model/toolsets-change shutdown failed', {
      sessionKey: session.sessionKey,
      effortChanged: flags.effortChanged,
      modelChanged: flags.modelChanged,
      toolsetsChanged: flags.toolsetsChanged,
      iuiChanged: flags.iuiChanged,
      serviceTierChanged: flags.serviceTierChanged,
      ...(traceId ? { traceId } : {}),
    }, err)
  }
}

async function syncRunnerConfigBeforeTurn(args: {
  host: SessionSubmitHost
  session: AgentSession
  traceId: string | undefined
  effortLevel: string | null | undefined
  model: string | undefined
  opts: SubmitOpts | undefined
  assertSessionCurrent: () => void
}): Promise<void> {
  const { host, session, traceId, effortLevel, model, opts, assertSessionCurrent } = args
  if (traceId !== undefined) session.runner.setTraceId(traceId)
  else session.runner.setTraceId?.(undefined)
  session._currentTurnTraceId = traceId
  const privacyChanged = await prepareRunnerPromptPrivacy(session.runner, session.peerId, {
    assertCurrent: assertSessionCurrent,
  })
  applyRunnerRouteOverrides(session, opts)
  const desiredEffort = effortLevel === null ? undefined : effortLevel
  const effortChanged = effortLevel !== undefined && session.runner.effortLevel !== desiredEffort
  const modelChanged = model !== undefined && session.runner.model !== model
  const maybeSetToolsets = (session.runner as any).setToolsets
  const desiredToolsets = normalizeToolsetListForCompare(opts?.toolsets)
  const toolsetsChanged =
    Object.prototype.hasOwnProperty.call(opts ?? {}, 'toolsets') &&
    typeof maybeSetToolsets === 'function' &&
    !sameToolsetsForCompare((session.runner as any).toolsets, desiredToolsets)
  const iuiApplied = (session.runner as { promptIntelligentUi?: unknown }).promptIntelligentUi
  const iuiChanged =
    isIntelligentUiApplied(iuiApplied) &&
    intelligentUiNeedsRestart(iuiApplied, await getDesiredIntelligentUi(session.sessionKey).catch(() => undefined))
  assertSessionCurrent()
  if (effortChanged) session.runner.setEffortLevel(desiredEffort)
  if (modelChanged) {
    session.runner.setModel(model)
    session.model = model ?? host.config.defaults.model ?? 'deepseek-v4-flash'
  }
  if (toolsetsChanged) maybeSetToolsets.call(session.runner, desiredToolsets)
  const serviceTierChanged = applyRunnerServiceTier(session, opts, modelChanged, model)
  await restartRunnerIfConfigChanged({
    session, traceId,
    flags: { effortChanged, modelChanged, toolsetsChanged, iuiChanged, privacyChanged, serviceTierChanged },
  })
  if (Object.prototype.hasOwnProperty.call(opts ?? {}, 'platformGoal')) {
    const goal = opts?.platformGoal ? structuredClone(opts.platformGoal) : null
    session._platformGoal = goal
    await session.runner.setGoalState(goal)
  }
}

function extractCurrentUserText(userTextOrBlocks: TurnUserInput): string {
  if (typeof userTextOrBlocks === 'string') return userTextOrBlocks
  return userTextOrBlocks
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

async function resolveSessionForSubmit(
  host: SessionSubmitHost,
  session: AgentSession,
  model: string | undefined,
  opts: SubmitOpts | undefined,
): Promise<AgentSession> {
  const preparingSwitchCompact =
    session._modelSwitchTransition?.state === 'preparing' &&
    opts?.modelSwitchInternal === session._modelSwitchTransition.id
  if (session._identityCreationOpts && !preparingSwitchCompact) {
    session = await host.getOrCreate({
      ...session._identityCreationOpts,
      ...(model ? { model } : {}),
      modelSwitchId: opts?.modelSwitchId,
      promptQueueExecutionFence: opts?.queueExecutionFence,
    })
  }
  if (host.isRuntimeRecycleDraining()) throw new RuntimeRecycleDrainingError()
  if (!opts?._internalCompact && isSessionCompacting(session.sessionKey)) {
    throw Object.assign(new Error('SESSION_COMPACT_IN_PROGRESS'), { code: 'SESSION_COMPACT_IN_PROGRESS' })
  }
  return session
}

function shouldBeginIdleWait(session: AgentSession, opts: SubmitOpts | undefined): boolean {
  return (
    opts?.modelSwitchInternal === undefined &&
    ((session._idleInternalTurns ?? 0) > 0 ||
      Boolean(session._idlePreExpiryActive) ||
      Boolean(session._idleRunning) ||
      Boolean(currentIdleSource(paths.home, session.sessionKey)))
  )
}

export async function submit(
  this: SessionSubmitHost,
  session: AgentSession,
  userTextOrBlocks: TurnUserInput,
  onEvent: (e: SessionStreamEvent) => void,
  effortLevel?: string | null,
  model?: string,
  requestId?: string,
  traceId?: string,
  _conversationMode?: 'default' | 'plan',
  opts?: SubmitOpts,
): Promise<void> {
  const submitStartedAt = performance.now()
  session = await resolveSessionForSubmit(this, session, model, opts)
  if (!checkSubmitCommercialAndBillingGuards({
    session, requestId, traceId, modelSwitchInternal: opts?.modelSwitchInternal, onEvent,
    isCommercialManagedRuntime, isEngineLocalTurnExempt,
  })) return
  const { transition, consumingModelSwitch } = resolveModelSwitchAdmission(session, model, opts)
  if (opts?.creditBudgetFen !== undefined) session._turnCreditBudgetFen = opts.creditBudgetFen
  const queueTurn = opts?.queueLifecycle !== undefined
  validateSubmitQueueAdmission({
    session, queueTurn, queueExecutionFence: opts?.queueExecutionFence,
    ownsDispatchFence: this._ownsPromptQueueExecutionFence(session.sessionKey, opts?.queueExecutionFence),
    hasQueueExecutionSession: this._promptQueueExecutions.has(session),
    hasQueueExecutionKey: this._promptQueueExecutionKeys.has(session.sessionKey),
    hasDispatchFenceKey: this._promptQueueDispatchFences.has(session.sessionKey),
  })
  await maybeAutoCompactBeforeTurn(this as unknown as import('./sessionLifecycle.js').SessionLifecycleHost, session, userTextOrBlocks, onEvent, opts)
  const prev = session.lock
  let release: () => void = () => {}
  let memoryTurnBarrier: KernelFileLock | undefined
  let memoryTurnPolicy: MemoryTurnPolicyDecision | undefined
  let memoryTurnPolicyLease: { stop: () => Promise<void> } | undefined
  let contextTurn: ContextTurnHandle | undefined
  let replayLifecycleStarted = false
  let unhandledTurnError: unknown | undefined
  let closeIdleWait: (() => void) | undefined
  const logicalTurnAbort = new AbortController()
  let closeHelpLogical: (() => void) | undefined
  let logicalTurnRun: Promise<void> | null = null
  let pendingCheckpoint: PersistedCheckpointRecord | null = null
  let checkpointAcked = false
  if (queueTurn) { this._promptQueueExecutions.add(session); this._promptQueueExecutionKeys.add(session.sessionKey) }
  session.lock = new Promise<void>((r) => (release = r))
  cancelIdlePreExpiry(session)
  session._activeTurnCount = (session._activeTurnCount ?? 0) + 1
  try {
    if (shouldBeginIdleWait(session, opts)) closeIdleWait = beginIdleWait(session, onEvent)
    await prev
    session._turnReadOnly = opts?.readOnly === true
    session._turnServiceTier = session._turnReadOnly ? null : (isServiceTier(opts?.serviceTier) ? opts.serviceTier : null)
    session._antigravitySwarmCompaction = opts?.antigravitySwarmCompaction
    if (!sameRemoteExecutionBackend(session.runner.executionBackend, opts?.modelAuthority?.executionDescriptor.executionBackend)) {
      throw new Error('CC5_BACKEND_SCOPE_CHANGED')
    }
    log.info('turn_pipeline_timing', { traceId, stage: 'submit_lock_acquired', elapsedMs: performance.now() - submitStartedAt })
    await resolveIdleRecoveryUnderLock(this, session, opts, closeIdleWait)
    if (await isDispatchCancelledBeforeStart(opts?.dispatchContext)) return
    const admission = await validateRuntimeIdentityAdmission(session, restartRunnerForConfigChange)
    session._externalTurnAbort = logicalTurnAbort
    replayLifecycleStarted = startReplayLifecycleSafely(session, opts?.replayLifecycle)
    if (isCommercialManagedRuntime() && session.channel !== 'auto-dream') {
      memoryTurnBarrier = await new MemoryDir(session.agentId).acquireSharedBarrier({
        totalBudgetMs: 60_000, perAttemptMs: 5_000, retryDelayMs: 100,
      })
    }
    log.info('turn_pipeline_timing', { traceId, stage: 'memory_barrier_acquired', elapsedMs: performance.now() - submitStartedAt })
    const privacyRunner = session.runner
    const assertSessionCurrent = () => {
      if (session._plannedTeardown || session._replacing || session.runner !== privacyRunner) throw new Error('SESSION_PRIVACY_OPERATION_CANCELLED')
    }
    await syncRunnerConfigBeforeTurn({ host: this, session, traceId, effortLevel, model, opts, assertSessionCurrent })
    session.turnChatProjectId = Object.prototype.hasOwnProperty.call(opts ?? {}, 'turnChatProjectId') ? opts?.turnChatProjectId : undefined
    session.lastUsedAt = Date.now()
    session.toolUseIdToName.clear()
    session.currentUserText = extractCurrentUserText(userTextOrBlocks)
    memoryTurnPolicy = session.parentSessionKey
      ? inheritMemoryTurnPolicy(await readMemoryTurnPolicy(session.parentSessionKey))
      : classifyMemoryTurnPolicy(session.currentUserText, session.channel)
    memoryTurnPolicyLease = await startMemoryTurnPolicyLease({
      sessionKey: session.sessionKey, decision: memoryTurnPolicy, logicalTurnAbort,
      interrupt: () => session.runner.interrupt(),
      onRefreshFailure: (err) => log.error('memory turn policy refresh failed; interrupting turn', { sessionKey: session.sessionKey, reason: memoryTurnPolicy?.reason, err: String(err) }),
    })
    contextTurn = contextAuthorities.beginTurn({
      sessionId: session.sessionKey, agentId: session.agentId, chatProjectId: session.turnChatProjectId ?? null,
      memoryPolicy: memoryTurnPolicy, promptPrivacyFingerprint: (privacyRunner as PromptPrivacyRunner).promptPolicyFingerprint, identity: admission.context,
    })
    logicalTurnAbort.signal.addEventListener('abort', () => contextTurn?.rotate(), { once: true })
    session.currentAssistantBuf = ''
    session.runner.lastActivityAt = Date.now()
    if (session.turns === 0) {
      const legacyId = this._resumeMap.get(session.sessionKey)
      session.turns = await getMaxTurnIdx(legacyId && legacyId !== session.sessionKey ? [session.sessionKey, legacyId] : [session.sessionKey])
    }
    const prep = await prepareSubmitRunnerPayload({ session, userTextOrBlocks, opts, consumingModelSwitch, transition, deps: buildContextPrepDeps(this) })
    pendingCheckpoint = prep.pendingCheckpoint
    assertSessionCurrent()
    closeHelpLogical = getSystemHelpRelay(this)?.begin(session, opts?.systemHelpBootstrap)
    const watchdog = createTurnLivenessWatchdog({ session, logicalTurnAbort, pickIdleTimeoutMs })
    log.info('turn_pipeline_timing', { traceId, stage: 'context_ready', elapsedMs: performance.now() - submitStartedAt })
    beginTurnOverflowContext(session, userTextOrBlocks, pendingCheckpoint?.generation, prep.effectiveMasterHistoricalMessages ?? undefined)
    logicalTurnRun = this.runOneTurnWithRetry(
      session, prep.runnerPayload, onEvent, requestId, traceId, opts?.collabAgentPolicy, opts?.modelAuthority,
      opts?.replayLifecycle?.clientMessageId, opts?.dispatchContext, opts?.queueLifecycle, logicalTurnAbort.signal,
      consumingModelSwitch ? [] : prep.contextOverflowRetryInputs, opts?.automaticRetryState,
      consumingModelSwitch ? transition : undefined, opts?.grokExecutionDescriptor,
    )
    try {
      await Promise.race([logicalTurnRun, watchdog.promise])
      checkpointAcked = ackTurnCheckpointOnSuccess({
        session, activeCkptGen: getTurnActiveCheckpointGeneration(session) ?? pendingCheckpoint?.generation,
        opts, requestId, authorityStateRuntime: this.authorityStateRuntime,
      })
    } finally { watchdog.stop() }
  } catch (err: unknown) {
    if (isTurnIdleTimeoutError(err)) {
      await handleTurnIdleTimeoutError({ err, session, traceId, logicalTurnAbort, logicalTurnRun, onEvent, trackPersistence: (p) => this._trackPersistence(p) })
    } else { unhandledTurnError = err; throw err }
  } finally {
    const cleanupDeps = buildCleanupDeps(this)
    await runSubmitPreBarrierCleanup({ session, closeIdleWait, closeHelpLogical, consumingModelSwitch, transition, checkpointAcked, pendingCheckpoint, deps: cleanupDeps })
    contextTurn?.end()
    await memoryTurnPolicyLease?.stop().catch((err) => log.warn('memory turn policy cleanup failed', { sessionKey: session.sessionKey, err: String(err) }))
    await memoryTurnBarrier?.release().catch(() => {})
    const idleFollowUp = finalizeSubmitReplayAndState({ session, opts, replayLifecycleStarted, unhandledTurnError, logicalTurnAbort, queueTurn, deps: cleanupDeps })
    release()
    if (idleFollowUp) this.scheduleIdleDrain(session)
  }
}

function adoptExistingSessionMetadata(
  existing: AgentSession,
  opts: GetOrCreateOpts,
  nextFingerprint: string | undefined,
  identityCreationOpts: AgentSession['_identityCreationOpts'],
  useAdoptRunContext: boolean,
): AgentSession {
  existing.lastUsedAt = Date.now()
  if (opts.title && (!existing.title || existing.title === 'New conversation')) existing.title = opts.title
  if (opts.userId && !existing.userId) existing.userId = opts.userId
  if (opts.repoSessionId && !existing.repoSessionId) existing.repoSessionId = opts.repoSessionId
  if (opts.parentSessionKey && !existing.parentSessionKey) existing.parentSessionKey = opts.parentSessionKey
  if (opts.projectId !== undefined) existing.projectId = opts.projectId
  if (nextFingerprint) existing.contextFingerprint = nextFingerprint
  if (opts.runContext) {
    existing.runContext = useAdoptRunContext
      ? adoptRunContext(existing.runContext, opts.runContext)
      : opts.runContext
  }
  existing._identityCreationOpts = identityCreationOpts
  return existing
}

async function reconcileCanonicalSessionAfterLock(args: {
  host: SessionSubmitHost
  existing: AgentSession
  opts: GetOrCreateOpts
  identityAgentFingerprint: string | undefined
  identityCreationOpts: AgentSession['_identityCreationOpts']
  engineId: string
  executionModel: string
  executionBackend: ReturnType<typeof cc5SessionBackend>
  hasAuthorizedMigration: boolean
  workspaceMode: NonNullable<GetOrCreateOpts['workspaceMode']>
  nextFingerprint: string | undefined
}): Promise<{ reused: AgentSession } | { canonical: AgentSession }> {
  const { host, opts, identityAgentFingerprint, identityCreationOpts, engineId, executionModel, executionBackend, hasAuthorizedMigration, workspaceMode, nextFingerprint } = args
  let existing = args.existing
  await existing.lock
  const canonical = host.sessions.get(opts.sessionKey)
  if (canonical && canonical !== existing) {
    await canonical.lock
    if (canonical.runner.executionBackend && !sameRemoteExecutionBackend(canonical.runner.executionBackend, executionBackend) && !hasAuthorizedMigration) {
      throw new Error('CC5_BACKEND_SCOPE_CHANGED')
    }
    const desiredEngineNow =
      opts.model !== undefined || opts.executionAuthority !== undefined || opts.agent.provider === 'codex-native'
        ? engineId
        : canonical.providerTag
    const canonicalDiff = needsSessionReplacement({
      session: canonical, opts, identityAgentFingerprint, desiredEngine: desiredEngineNow, executionModel, executionBackend, workspaceMode,
    })
    if (!canonicalDiff.needsReplace) {
      return { reused: adoptExistingSessionMetadata(canonical, opts, nextFingerprint, identityCreationOpts, false) }
    }
    existing = canonical
    existing._replacing = true
  }
  return { canonical: existing }
}

async function executeExistingSessionReplacement(args: {
  host: SessionSubmitHost
  existing: AgentSession
  opts: GetOrCreateOpts
  identity: Awaited<ReturnType<typeof resolveRuntimeExecutionAgent>>
  identityAgentFingerprint: string | undefined
  identityCreationOpts: AgentSession['_identityCreationOpts']
  engineId: string
  desiredEngine: string
  executionModel: string
  executionBackend: ReturnType<typeof cc5SessionBackend>
  hasAuthorizedMigration: boolean
  workspaceMode: NonNullable<GetOrCreateOpts['workspaceMode']>
  nextFingerprint: string | undefined
  diff: ReturnType<typeof needsSessionReplacement>
  replacementNotice: NonNullable<AgentSession['_contextRebuildNotice']>
  assertFreshBackendTarget: (current: AgentSession | undefined) => Promise<void>
}): Promise<
  | { reused: AgentSession }
  | {
      reused?: undefined
      existing: AgentSession
      identityRefreshSession: AgentSession | undefined
      contextRebuildNotice: AgentSession['_contextRebuildNotice']
    }
> {
  const { host, opts, identity, identityAgentFingerprint, identityCreationOpts, engineId, desiredEngine, executionModel, executionBackend, hasAuthorizedMigration, workspaceMode, nextFingerprint, diff, replacementNotice } = args
  let existing = args.existing
  existing._replacing = true
  let identityRefreshSession: AgentSession | undefined
  let contextRebuildNotice: AgentSession['_contextRebuildNotice'] = replacementNotice
  try {
    const reconciled = await reconcileCanonicalSessionAfterLock({
      host, existing, opts, identityAgentFingerprint, identityCreationOpts, engineId,
      executionModel, executionBackend, hasAuthorizedMigration, workspaceMode, nextFingerprint,
    })
    if ('reused' in reconciled) return { reused: reconciled.reused }
    existing = reconciled.canonical
    if (executionBackend && !sameRemoteExecutionBackend(existing.runner.executionBackend, executionBackend)) {
      await args.assertFreshBackendTarget(existing)
    }
    const canRefresh = computeCanIdentityRefresh({
      existing, identityContext: identity.context, opts, identityAgentFingerprint, targetEngine: engineId, executionModel,
      cursorTransportChanged: diff.cursorTransportChanged, backendChanged: diff.backendChanged,
      workspaceModeChanged: diff.workspaceModeChanged, workspaceCwdChanged: diff.workspaceCwdChanged,
      projectIdChanged: diff.projectIdChanged, workspaceMode, resolveDefaultWorkspaceCwd,
    })
    identityRefreshSession = canRefresh ? existing : undefined
    contextRebuildNotice = await resolveReplacementRebuildNotice({
      existing, sessionKey: opts.sessionKey, legacyId: host._resumeMap.get(opts.sessionKey), replacementNotice,
    })
    await shutdownReplacedSession({
      existing, sessionKey: opts.sessionKey, executionBackend, identityRefreshSession,
      engineChanged: existing.providerTag !== desiredEngine, workspaceModeChanged: diff.workspaceModeChanged,
      deleteSessionIfCanonical: (key, expected) => {
        if (host.sessions.get(key) === expected) host.sessions.delete(key)
      },
    })
  } catch (err) {
    if (executionBackend || existing.runner.executionBackend) {
      existing._replacing = false
      throw err
    }
    if (identityRefreshSession) throw err
    log.warn(
      'session-replacement shutdown failed',
      { sessionKey: opts.sessionKey, engineChanged: existing.providerTag !== desiredEngine, workspaceModeChanged: diff.workspaceModeChanged },
      err,
    )
    if (host.sessions.get(opts.sessionKey) === existing) host.sessions.delete(opts.sessionKey)
  }
  return { existing, identityRefreshSession, contextRebuildNotice }
}

async function resolveOrReplaceExistingSession(args: {
  host: SessionSubmitHost
  existing: AgentSession
  opts: GetOrCreateOpts
  identity: Awaited<ReturnType<typeof resolveRuntimeExecutionAgent>>
  identityAgentFingerprint: string | undefined
  identityCreationOpts: AgentSession['_identityCreationOpts']
  engineId: string
  executionModel: string
  executionBackend: ReturnType<typeof cc5SessionBackend>
  hasAuthorizedMigration: boolean
  ownsDispatchFence: boolean
  workspaceMode: NonNullable<GetOrCreateOpts['workspaceMode']>
  assertFreshBackendTarget: (current: AgentSession | undefined) => Promise<void>
}): Promise<
  | { reused: AgentSession }
  | {
      reused?: undefined
      existing: AgentSession
      identityRefreshSession: AgentSession | undefined
      contextRebuildNotice: AgentSession['_contextRebuildNotice']
    }
> {
  const { host, existing, opts, identityAgentFingerprint, identityCreationOpts, engineId, executionModel, executionBackend, ownsDispatchFence, workspaceMode } = args
  const desiredEngine =
    opts.model !== undefined || opts.executionAuthority !== undefined || opts.agent.provider === 'codex-native'
      ? engineId
      : existing.providerTag
  const nextProjectId = opts.projectId === undefined ? (existing.projectId ?? null) : opts.projectId
  const nextFingerprint = opts.contextFingerprint ?? (await computeSessionContextFingerprint(nextProjectId, opts.assetsRevision))
  const diff = needsSessionReplacement({
    session: existing, opts, identityAgentFingerprint, desiredEngine, executionModel, executionBackend, workspaceMode,
  })
  if (!diff.needsReplace) {
    return { reused: adoptExistingSessionMetadata(existing, opts, nextFingerprint, identityCreationOpts, true) }
  }
  log.info('session_runner_replace', {
    sessionKey: opts.sessionKey,
    agentChanged: existing.agentId !== opts.agent.id,
    identityChanged: existing._identityAgentFingerprint !== identityAgentFingerprint,
    engineChanged: existing.providerTag !== desiredEngine,
    cursorTransportChanged: diff.cursorTransportChanged,
    backendChanged: diff.backendChanged,
    workspaceModeChanged: diff.workspaceModeChanged,
    workspaceCwdChanged: diff.workspaceCwdChanged,
    projectIdChanged: diff.projectIdChanged,
  })
  const replacementNotice: NonNullable<AgentSession['_contextRebuildNotice']> =
    existing.providerTag !== desiredEngine ? 'engine-switch' : 'native-resume-loss'
  if (
    host._promptQueueExecutionKeys.has(opts.sessionKey) ||
    (host._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)
  ) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: engine switch cannot replace an active queue session')
  }
  return executeExistingSessionReplacement({
    ...args, desiredEngine, nextFingerprint, diff, replacementNotice,
  })
}

async function buildInitialOrRefreshedSession(args: {
  host: SessionSubmitHost
  opts: GetOrCreateOpts
  existing: AgentSession | undefined
  identityRefreshSession: AgentSession | undefined
  identity: Awaited<ReturnType<typeof resolveRuntimeExecutionAgent>>
  identityAgentFingerprint: string | undefined
  identityCreationOpts: AgentSession['_identityCreationOpts']
  engineId: string
  executionModel: string
  workspaceMode: NonNullable<GetOrCreateOpts['workspaceMode']>
  cwd: string
  repoSessionId: string | undefined
  runner: AgentSession['runner']
  notice: AgentSession['_contextRebuildNotice']
  resumeTransportMismatch: boolean
}): Promise<AgentSession> {
  const { host, opts, existing, identityRefreshSession, identity, identityAgentFingerprint, identityCreationOpts, engineId, executionModel, workspaceMode, cwd, repoSessionId, runner, notice, resumeTransportMismatch } = args
  const now = Date.now()
  if (identityRefreshSession) {
    identityRefreshSession.runner = runner
    identityRefreshSession._identityAgentFingerprint = identityAgentFingerprint
    identityRefreshSession._identityCreationOpts = identityCreationOpts
    identityRefreshSession._identityCompat = identity.context
    identityRefreshSession.agentProvider = opts.agent.provider
    identityRefreshSession._contextRebuildNotice = notice
    identityRefreshSession._forceHistoricalContextOnFirstTurn = resumeTransportMismatch || undefined
    identityRefreshSession._historicalContextInjected = false
    identityRefreshSession._historicalContextInjectedKey = undefined
    identityRefreshSession.lastUsedAt = now
    return identityRefreshSession
  }
  return {
    _identityAgentFingerprint: identityAgentFingerprint, _identityCreationOpts: identityCreationOpts,
    _identityCompat: opts.hermeticNoTools ? undefined : identity.context,
    sessionKey: opts.sessionKey, agentId: opts.agent.id, channel: opts.channel ?? 'webchat', peerId: opts.peerId ?? 'unknown',
    userId: opts.userId, workspaceMode, workspaceCwd: cwd, projectId: opts.projectId,
    contextFingerprint: opts.contextFingerprint ?? (await computeSessionContextFingerprint(opts.projectId, opts.assetsRevision)),
    runContext: opts.runContext, frozenProjectContext: opts.frozenProjectContext,
    repoSessionId,
    title: opts.title ?? 'New conversation', parentSessionKey: opts.parentSessionKey,
    _billingParentTurnKey: opts.usageAttribution?.parentTurnKey,
    _usageAttribution: opts.usageAttribution ? { ...opts.usageAttribution } : undefined,
    startedAt: now, runner, ccbSessionId: null, lock: Promise.resolve(), lastUsedAt: now,
    totalCostUSD: host._lastCostFor(opts.sessionKey, engineId) ?? 0,
    costImprecise: host._costImpreciseFor(opts.sessionKey, engineId),
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, turns: 0,
    _lastCcbCumulativeCost: host._lastCostFor(opts.sessionKey, engineId) ?? 0, model: executionModel,
    ...(existing?._modelSwitchTransition ? { _modelSwitchTransition: existing._modelSwitchTransition } : {}),
    toolUseIdToName: new Map(), executionTarget: { kind: 'local' }, providerTag: engineId, agentProvider: opts.agent.provider,
    _contextRebuildNotice: notice, _forceHistoricalContextOnFirstTurn: resumeTransportMismatch || undefined,
  }
}

async function createAndRegisterSession(args: {
  host: SessionSubmitHost
  opts: GetOrCreateOpts
  existing: AgentSession | undefined
  identityRefreshSession: AgentSession | undefined
  identity: Awaited<ReturnType<typeof resolveRuntimeExecutionAgent>>
  identityAgentFingerprint: string | undefined
  identityCreationOpts: AgentSession['_identityCreationOpts']
  engineId: string
  executionModel: string
  executionBackend: ReturnType<typeof cc5SessionBackend>
  hasAuthorizedMigration: boolean
  workspaceMode: NonNullable<GetOrCreateOpts['workspaceMode']>
  repoSessionId: string | undefined
  contextRebuildNotice: AgentSession['_contextRebuildNotice']
}): Promise<AgentSession> {
  const { host, opts, existing, identityRefreshSession, identity, identityAgentFingerprint, identityCreationOpts, engineId, executionModel, executionBackend, hasAuthorizedMigration, workspaceMode, repoSessionId } = args
  const cwd = opts.workspaceCwd ?? opts.agent.cwd ?? resolveDefaultWorkspaceCwd(workspaceMode, repoSessionId)
  const persona = opts.hermeticNoTools ? undefined : (opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id))
  const { mappedResumeId, hadSameProviderResume } = resolveMappedResumeForCreate({
    opts, targetEngine: engineId, cwd, repoSessionId, executionBackend, hasAuthorizedMigration,
    storedResumeId: host._resumeMap.get(opts.sessionKey), storedResumeProvider: host._resumeMapProvider.get(opts.sessionKey),
    parseRemoteV4ResumeId, forgetResumeEntry: (k) => host._forgetResumeEntry(k), saveResumeMap: () => host._saveResumeMap(),
    resumeIdFor: (k, p, w) => host._resumeIdFor(k, p, w), cursorWorkspacePath: (b, r, pb) => host._cursorWorkspacePath(b, r, pb),
  })
  if (!isEngineEnabled(engineId)) throw new EngineNotEnabledError(engineId)
  const runner = createEngine(engineId, {
    peerId: opts.peerId, sessionKey: opts.sessionKey, executionBackend,
    systemHelpContextFile: systemHelpContextFile(host, opts.sessionKey),
    agentId: opts.agent.id, agentBaseDir: cwd, config: host.config, persona,
    identityCompat: opts.hermeticNoTools ? undefined : identity.context, model: executionModel,
    permissionMode: identity.context.assets
      ? identity.context.assets.effectivePermissionMode
      : (opts.agent.permissionMode ?? host.config.defaults.permissionMode),
    agentProvider: opts.agent.provider, agentMcpServers: opts.agent.mcpServers,
    agentToolsets: opts.agent.toolsets ?? host.config.defaults.toolsets, delegationDepth: opts.delegationDepth,
    resumeSessionId: mappedResumeId,
    resolveResumeFallback: (staleId: string) => {
      const promoted = host._resolveDurableResumeId(
        opts.sessionKey, engineId, undefined, host._cursorWorkspacePath(cwd, repoSessionId, Boolean(opts.projectId)),
        { exclude: staleId, syncRunner: false },
      )
      return promoted && promoted !== staleId ? promoted : undefined
    },
    effortLevel: opts.effortLevel === null ? undefined : opts.effortLevel,
    sessionId: repoSessionId, projectId: opts.projectId ?? undefined,
    runContext: opts.runContext, frozenProjectContext: opts.frozenProjectContext, getRepoSnapshot: host._getRepoSnapshot,
    workload: opts.workload, skillTrainRunId: opts.skillTrainRunId, skillEvalMode: opts.skillEvalMode,
    skillEvalExclude: opts.skillEvalExclude, skillEvalDraft: opts.skillEvalDraft, usageAttribution: opts.usageAttribution,
    hermeticNoTools: opts.hermeticNoTools, advisorExecutionLock: opts.advisorExecutionLock, structuredOutputSchema: opts.structuredOutputSchema,
  })
  const resumeTransportMismatch =
    !opts.hermeticNoTools && hadSameProviderResume &&
    (!mappedResumeId || Boolean(runner.isResumeIdCompatible && !runner.isResumeIdCompatible(mappedResumeId)))
  const notice = resumeTransportMismatch ? 'native-resume-loss' : args.contextRebuildNotice
  const session = await buildInitialOrRefreshedSession({
    host, opts, existing, identityRefreshSession, identity, identityAgentFingerprint,
    identityCreationOpts, engineId, executionModel, workspaceMode, cwd, repoSessionId,
    runner, notice, resumeTransportMismatch,
  })
  attachSessionRunnerListeners(session, runner, {
    sessionKey: opts.sessionKey, targetEngine: engineId,
    getResumeMapId: (k) => host._resumeMap.get(k), setResumeMapId: (k, id) => { host._resumeMap.set(k, id) },
    getResumeMapProvider: (k) => host._resumeMapProvider.get(k), setResumeMapProvider: (k, t) => { host._resumeMapProvider.set(k, t) },
    deleteResumeMapHistory: (k) => { host._resumeMapHistory.delete(k) }, pushResumeHistory: (k, p) => host._pushResumeHistory(k, p),
    getPromotedResumeHead: (k) => host._resumeHeadPromotedFromHistory.get(k), deletePromotedResumeHead: (k) => { host._resumeHeadPromotedFromHistory.delete(k) },
    markResumeRejected: (k, id) => host._markResumeRejected(k, id),
    resolveDurableResumeId: (k, t, h, w, o) => host._resolveDurableResumeId(k, t, h, w, o),
    forgetResumeEntry: (k) => host._forgetResumeEntry(k), saveResumeMap: () => host._saveResumeMap(),
    cursorWorkspacePathForSession: (s) => host._cursorWorkspacePathForSession(s),
    onCcbTaskNotification: host.onCcbTaskNotification, onCcbTaskNotificationDelivered: host.onCcbTaskNotificationDelivered,
  })
  host.sessions.set(opts.sessionKey, session)
  if (opts.peerId) host._sessionIdToKey.set(opts.peerId, opts.sessionKey)
  return session
}

export async function _getOrCreateExclusive(
  this: SessionSubmitHost,
  opts: GetOrCreateOpts,
): Promise<AgentSession> {
  const ownsDispatchFence = this._ownsPromptQueueExecutionFence(opts.sessionKey, opts.promptQueueExecutionFence)
  if ((opts.promptQueueExecutionFence && !ownsDispatchFence) || (this._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: queue preflight owns this logical session')
  }
  const { promptQueueExecutionFence: _fence, modelSwitchId: _switchId, preheatOnly: _preheatOnly, poolMigration: _poolMigration, ...identityCreationOpts } = opts
  const identity = opts.hermeticNoTools ? { agent: opts.agent, context: {} } : await resolveRuntimeExecutionAgent(opts.agent)
  opts = { ...opts, agent: identity.agent }
  const identityAgentFingerprint = identity.context.assets ? JSON.stringify(opts.agent) : undefined
  const executionModel = resolveExecutionModel(
    opts.model ?? opts.agent.model,
    this.config.defaults.model,
    opts.executionAuthority,
    { explicit: typeof opts.model === 'string' && opts.model !== '' },
  )
  const engineId = resolveEngine(executionModel, opts.agent, opts.executionAuthority, {
    requireAuthority: isModelAuthorityRequired(),
  })
  if (
    identity.context.assets &&
    engineId !== 'ccb' &&
    identity.context.assets.effectivePermissionMode !== undefined &&
    identity.context.assets.effectivePermissionMode !== 'bypassPermissions'
  ) {
    throw new IdentityAssetsError(
      'COMPAT_PERMISSION_CONFLICT',
      'COMPAT_PERMISSION_CONFLICT: selected engine cannot enforce the registered permission mode',
    )
  }
  let existing = this.sessions.get(opts.sessionKey)
  if (opts.preheatOnly && existing) return existing
  const poolMigration = opts.poolMigration
  const hasAuthorizedMigration = Boolean(
    poolMigration?.allowBackendTransition &&
      poolMigration.migrationId.trim().length >= 8 &&
      Number.isSafeInteger(poolMigration.placementEpoch) &&
      poolMigration.placementEpoch >= 1,
  )
  if (this.authorityStateRuntime && this.getResumeStore) {
    await prepareSessionAuthorityBeforeCreate({
      authorityRuntime: this.authorityStateRuntime, capsuleRuntime: this.capsuleRuntime,
      resumeStore: this.getResumeStore(), sessionKey: opts.sessionKey,
      engine: engineId as 'ccb' | 'codex' | 'antigravity' | 'grok' | 'cursor' | 'zcode',
      workspaceCwd: opts.workspaceCwd ?? opts.agent.cwd,
      placementEpoch: hasAuthorizedMigration ? poolMigration?.placementEpoch : undefined, existingSession: existing,
    })
  }
  const executionBackend = cc5SessionBackend({
    ...opts, engineId, executionModel, storedResumeId: this._resumeMap.get(opts.sessionKey), poolMigration,
  })
  const backendChanged = !sameRemoteExecutionBackend(existing?.runner.executionBackend, executionBackend)
  if (existing?.runner.executionBackend && backendChanged && !hasAuthorizedMigration) {
    throw new Error('CC5_BACKEND_SCOPE_CHANGED')
  }
  const assertFreshBackendTarget = (current: AgentSession | undefined) =>
    assertFreshCc5Session({
      current, storedResumeId: this._resumeMap.get(opts.sessionKey),
      storedResumeProvider: normalizeEngineTag(this._resumeMapProvider.get(opts.sessionKey)),
      executionBackend, poolMigration,
      sessionIds: [opts.sessionKey, ...(opts.peerId ? [opts.peerId] : [])], hasPersistedTurnActivity,
    })
  if (executionBackend && (!existing || backendChanged)) await assertFreshBackendTarget(existing)
  validateCreateModelSwitchGuard(existing, executionModel, opts.modelSwitchId)
  const previousEngine = existing?.providerTag ?? normalizeEngineTag(this._resumeMapProvider.get(opts.sessionKey))
  let contextRebuildNotice: AgentSession['_contextRebuildNotice'] =
    previousEngine && previousEngine !== engineId ? 'engine-switch' : undefined
  const workspaceMode = opts.workspaceMode ?? existing?.workspaceMode ?? 'legacy'
  let identityRefreshSession: AgentSession | undefined
  try {
    if (existing) {
      const resolved = await resolveOrReplaceExistingSession({
        host: this, existing, opts, identity, identityAgentFingerprint, identityCreationOpts,
        engineId, executionModel, executionBackend, hasAuthorizedMigration, ownsDispatchFence,
        workspaceMode, assertFreshBackendTarget,
      })
      if (resolved.reused) return resolved.reused
      existing = resolved.existing
      identityRefreshSession = resolved.identityRefreshSession
      contextRebuildNotice = resolved.contextRebuildNotice
    }
    const repoSessionId = opts.repoSessionId ?? opts.peerId
    return await createAndRegisterSession({
      host: this, opts, existing, identityRefreshSession, identity, identityAgentFingerprint,
      identityCreationOpts, engineId, executionModel, executionBackend, hasAuthorizedMigration,
      workspaceMode, repoSessionId, contextRebuildNotice,
    })
  } finally {
    if (identityRefreshSession) identityRefreshSession._replacing = false
  }
}

export async function getOrCreate(
  this: SessionSubmitHost,
  opts: GetOrCreateOpts,
): Promise<AgentSession> {
  return this._enterSessionCreateGate(opts.sessionKey, () => this._getOrCreateExclusive(opts))
}

export async function finishIdleUnderLock(
  this: SessionSubmitHost,
  session: AgentSession,
  source: { sessionId: string; turnKey: string },
  recoveryDir: string = paths.home,
  mode: 'after_turn' | 'pre_expiry' = 'after_turn',
): Promise<'deferred' | void> {
  return finishIdleUnderLockFlow(buildBoxIdleDeps(), session, source, recoveryDir, mode)
}

export async function recordExternalTurn(
  this: SessionSubmitHost,
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
  return recordExternalTurnFlow(buildExternalTurnDeps(this), session, args, reservation)
}

export async function beginExternalTurn(
  this: SessionSubmitHost,
  session: AgentSession,
  opts?: {
    queueTurn?: boolean
    queueExecutionFence?: PromptQueueExecutionFence
    clientMessageId?: string
  },
): Promise<{ signal: AbortSignal; finish: (outcome: 'completed' | 'errored') => void }> {
  return beginExternalTurnFlow(buildExternalTurnDeps(this), session, opts)
}

export { _resumeIdFor, _resolveDurableResumeId } from './sessionResumeLadder.js'
