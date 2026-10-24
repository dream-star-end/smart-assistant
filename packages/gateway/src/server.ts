import { createTaskboardPreflight } from './taskboard/stagePreflight.js'
export { runSessionPreheat, validateEnginePreheatBody } from './sessionPreheat.js'
export type { EnginePreheatBody, EnginePreheatValidation, SessionPreheatHost } from './sessionPreheat.js'
import type { GatewayHttpIo } from './routes/httpIo.js'
// Moved with its only caller; re-exported for existing importers.
export { _buildHealthzDeps } from './routes/system.js'
import type { PreAuthRoutesIo } from './routes/preAuth.js'
import type { PlatformRoutesIo } from './routes/platform.js'
import type { SystemRoutesIo } from './routes/system.js'
import type { AppConfigRoutesIo } from './routes/appConfig.js'
import type { AgentRoutesIo } from './routes/agents.js'
import type { WorkspaceApiRoutesIo } from './routes/workspaceApi.js'
import type {
  ClientSessionsHttpIo,
} from './routes/clientSessions.js'
// Moved with the client session routes; re-exported for existing importers.
export {
  _parseHistoryRevisionCursor,
  filterUserVisibleLiveSessions,
  _parseArchiveQuery,
  _immutableRecordIdHeaders,
} from './routes/clientSessions.js'
import { randomBytes } from 'node:crypto'
import {
  fchmodSync,
  fchownSync,
  linkSync,
  statSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse, createServer } from 'node:http'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import {
  type InboundFrame,
  type OutboundMessage,
  shouldServeInline,
} from '@openclaude/protocol'
import type {
  JobTerminal,
} from '@openclaude/protocol'
import {
  getDelegateMaxConcurrent,
  getDelegateReviewReservedSlots,
} from './delegateCapacity.js'
import { ContainerPreviewHandler } from './containerPreview.js'
import {
  PromptQueueCoordinator,
  type PromptQueueDispatchRequest,
  type PromptQueueSessionContext,
  type PromptQueueTurnLifecycle,
} from './promptQueueCoordinator.js'
import type { AgentSession, PromptQueueExecutionFence } from './sessionManager.js'
import {
  HttpPromptQueueClient,
  readPromptQueueClientConfig,
} from './promptQueueClient.js'
import {
  type AgentDef,
  type AgentsConfig,
  type OpenClaudeConfig,
  SkillDraftStore,
  TaskStore,
  paths,
  readAgentsConfig,
  readConfig,
  syncMarketplaceHub,
} from '@openclaude/storage'
import {
  DETACHED_ASK_USER_TTL_MS,
  buildDetachedAskUserAnswerMessageId,
  type pendingFromDetachedAskUserMessage,
} from './detachedAskUser.js'
import type {
  AskUserWaiter,
  AskUserWaiterAnswer,
} from './askUserWaiter.js'
import {
  filterUserVisibleAgentsForManagement,
  filterUserVisibleRoutesForManagement,
  userVisibleDefaultAgentId,
} from './agentVisibility.js'
import type { AdvisorConsultStore } from './advisorConsultStore.js'
import type {
  AdvisorConfigStore,
} from './advisorConfigStore.js'
import type {
  SessionStreamEvent,
} from './ccbMessageParser.js'
import { type SkillTrainRun, SkillTrainJobStore } from './skillTrainJobs.js'
import {
  type SkillEvalRun,
  SkillEvalJobStore,
} from './skillEvalJobs.js'
import { SkillEvalGenJobStore, type SkillEvalGenRun } from './skillEvalGenJobs.js'
import type {
  GenSessionExcerpt,
} from './skillEvalGen.js'
import type {
  FeedbackScenario,
} from './skillTrain.js'
import type { WebSocket, WebSocketServer } from 'ws'
import type {
  CronScheduler,
  CronDeliveryContext,
  CronJob,
} from './cron.js'
import type {
  CronProjectPorts,
} from './cronProject.js'
import type {
  CronOriginFireResult,
} from './cronOriginSession.js'
import {
  clearCcbLocalAgentPendingForSession,
  type CcbLocalAgentNotification,
} from './ccbLocalAgentCallback.js'
import type {
  SendToAgentIntent,
} from './sendToAgentIntentStore.js'
import type { PatrolEngine } from './taskboard/patrol.js'
import { projectTaskboardRunSnapshots } from './taskboard/runSnapshots.js'
import { postInboxMessage } from './v3InboxPost.js'
import type {
  DelegateProgressRouting,
} from './delegateProgress.js'
import type {
  DelegateTimeoutConfig,
} from './delegateTimeout.js'
import type {
  DelegateJobStore,
  DelegateJobHttpResult,
  DelegateJobSnapshot,
} from './delegateJobs.js'
import type { DelegateResumeRegistry } from './delegateResume.js'
import type {
  DelegateInflightSurfaceStore,
} from './delegateInflightSurface.js'
import type { DefaultEngineNotifier } from './engineNotifier.js'
import type {
  parseParentEngine,
} from './jobTerminal.js'
import type {
  acquireDelegateGrokRoute,
} from './delegateGrokRoute.js'
import type {
  defaultDelegateEngineBilling,
  DelegateEngineBillingClient,
} from './delegateEngineBilling.js'
import type { AdvisorAdmitRouteOk } from './advisorCodexRoute.js'
import type { DelegateOwnerTurnLocator } from './delegateLateCompletion.js'
import { createLogger } from './logger.js'
import {
  outboundRingEvictedTotal,
  outboundRingSizeBytes,
} from './metrics.js'
import { RateLimiter } from './rateLimit.js'
import { DEFAULT_RING_CONFIG, OutboundRingBuffer, type EvictionStats } from './outboundRing.js'
import { Router } from './router.js'
import { RunLog } from './runLog.js'
import {
  SessionRepoWorkspaceManager,
  type SessionRepoBindFrame,
  type SessionRepoStatusOut,
} from './sessionRepoWorkspace.js'
import {
  SessionManager,
  persistInterruptedPromptQueueTurn,
} from './sessionManager.js'
import type { WebhookRouter } from './webhooks.js'
import type {
  ToolFailureReporter,
} from './v3ToolFailureReporter.js'
import type {
  SkillShadowReporter,
} from './skillShadowReporter.js'
import {
  ModelAuthorityConsumer,
  type ConnectionAuthorityContext,
} from './modelAuthority.js'
import {
  DispatchAuthorityConsumer,
  type DispatchTurnContext,
  type admitTurnDispatch,
} from './turnDispatchInbox.js'
import type { RuntimeRecycleDrainCoordinator } from './runtimeRecycleDrain.js'
import {
  localExecutionRejectCode,
  type LocalExecutionRejectCode,
} from './modelCatalogClient.js'
import {
  AutoDreamService,
  formatAutoDreamReceipt,
  type AutoDreamModelRun,
} from './autoDream.js'
import {
  AutoDreamOptimizerService,
  type AutoDreamAuditDataset,
  type AutoDreamOptimizerModelRun,
  type AutoDreamOptimizerProposal,
} from './autoDreamOptimizer.js'
import { AutoDreamOptimizerClient } from './autoDreamOptimizerClient.js'
import { GATEWAY_PENDING_PERMISSION_TTL_MS } from './pendingPermissionSnapshot.js'
import { type AgentHandlersHost, handleAgentsCollection as handleAgentsCollectionImpl, handleAgentItem as handleAgentItemImpl, handlePersona as handlePersonaImpl, handleMemory as handleMemoryImpl, handleMemoryUsage as handleMemoryUsageImpl, handleAutoDreamReport as handleAutoDreamReportImpl, handleAutoDreamOptimizer as handleAutoDreamOptimizerImpl, handleAutoDreamOptimizerCancel as handleAutoDreamOptimizerCancelImpl, handleAutoDreamOptimizerProposal as handleAutoDreamOptimizerProposalImpl, handleMemoryFile as handleMemoryFileImpl, _loadAutoDreamAuditDataset as _loadAutoDreamAuditDatasetImpl, _runAutoDreamOptimizerModel as _runAutoDreamOptimizerModelImpl, _hydrateAutoDreamOptimizerProposals as _hydrateAutoDreamOptimizerProposalsImpl, _applyAutoDreamOptimizerProposal as _applyAutoDreamOptimizerProposalImpl, _runAutoDreamModel as _runAutoDreamModelImpl } from './agentHandlers.js'
import { type SkillHandlersHost, handleSkillsList as handleSkillsListImpl, handleSkillItem as handleSkillItemImpl, handleUserSkillsList as handleUserSkillsListImpl, _handleUserSkillFiles as _handleUserSkillFilesImpl, _handleUserSkillHistory as _handleUserSkillHistoryImpl, _handleUserSkillRestore as _handleUserSkillRestoreImpl, validateSkillAgentScopeInput as validateSkillAgentScopeInputImpl, handleUserSkillItem as handleUserSkillItemImpl, _handleSkillEvalsFile as _handleSkillEvalsFileImpl, _handleSkillEvalStart as _handleSkillEvalStartImpl, _handleSkillEvalRunStatus as _handleSkillEvalRunStatusImpl, _handleSkillEvalGenStart as _handleSkillEvalGenStartImpl, _handleSkillEvalGenStatus as _handleSkillEvalGenStatusImpl, _handleReleaseJobStatus as _handleReleaseJobStatusImpl, _runSkillEvalGen as _runSkillEvalGenImpl, _skillEvalTurn as _skillEvalTurnImpl, _runSkillEval as _runSkillEvalImpl, _startSkillAutoRegression as _startSkillAutoRegressionImpl, _skillAutoRegressionTick as _skillAutoRegressionTickImpl, _collectSkillFeedbackScenarios as _collectSkillFeedbackScenariosImpl, _handleSkillTrainStart as _handleSkillTrainStartImpl, _handleSkillTrainList as _handleSkillTrainListImpl, _handleSkillTrainRun as _handleSkillTrainRunImpl, _handleSkillTrainDrafts as _handleSkillTrainDraftsImpl, _handleSkillTrainDraftItem as _handleSkillTrainDraftItemImpl, _handleSkillTrainComment as _handleSkillTrainCommentImpl, _handleSkillTrainMerge as _handleSkillTrainMergeImpl } from './skillHandlers.js'
import { type DelegateCallbacksHost, _dispatchDelegateNotify as _dispatchDelegateNotifyImpl, _adoptOrphanedStdoutWaitDelegates as _adoptOrphanedStdoutWaitDelegatesImpl, _retryDelegateNotifies as _retryDelegateNotifiesImpl, _persistSendToAgentIntent as _persistSendToAgentIntentImpl, _deliverInterruptedSendToAgentIntent as _deliverInterruptedSendToAgentIntentImpl, _persistInterruptedSendToAgentCallbacks as _persistInterruptedSendToAgentCallbacksImpl, _ensureDurableSendToAgentCallback as _ensureDurableSendToAgentCallbackImpl, handleCcbLocalAgentNotification as handleCcbLocalAgentNotificationImpl, handleCcbLocalAgentDelivered as handleCcbLocalAgentDeliveredImpl, flushCcbLocalAgentPendingOnFinalize as flushCcbLocalAgentPendingOnFinalizeImpl, queueCcbLocalAgentInject as queueCcbLocalAgentInjectImpl, injectCcbLocalAgentCallback as injectCcbLocalAgentCallbackImpl, tryCcbLocalAgentCallbackDispatch as tryCcbLocalAgentCallbackDispatchImpl, _queueSendToAgentCallback as _queueSendToAgentCallbackImpl, injectSendToAgentCallback as injectSendToAgentCallbackImpl, trySendToAgentCallbackDispatch as trySendToAgentCallbackDispatchImpl, _sendToAgentCallbackTurnAlreadyQueued as _sendToAgentCallbackTurnAlreadyQueuedImpl } from './delegateCallbacks.js'
import { type DelegateSupervisionHost, _ensureDelegateInflightSurface as _ensureDelegateInflightSurfaceImpl, _projectDelegateInflightFromJob as _projectDelegateInflightFromJobImpl, _forgetDelegateInflight as _forgetDelegateInflightImpl, _dropDelegateInflightSurface as _dropDelegateInflightSurfaceImpl, _touchDelegateInflightSurface as _touchDelegateInflightSurfaceImpl, _armDelegateReconcileFollowup as _armDelegateReconcileFollowupImpl, _armDelegateReaper as _armDelegateReaperImpl, _delegateRunnerIdle as _delegateRunnerIdleImpl, _delegateChildAlive as _delegateChildAliveImpl, _forgetEvictedDelegateResumes as _forgetEvictedDelegateResumesImpl, _completeDelegateResumeClaim as _completeDelegateResumeClaimImpl, _persistAndCloseDelegateJobs as _persistAndCloseDelegateJobsImpl } from './delegateSupervision.js'
import { type DelegateRuntimeHost, type DelegateTaskResult, _isDelegateHttpPath as _isDelegateHttpPathImpl, _hasValidDelegateContext as _hasValidDelegateContextImpl, _ensureDelegateJobStore as _ensureDelegateJobStoreImpl, _resolveDelegateParentEngine as _resolveDelegateParentEngineImpl, _resolveDelegateProgressTarget as _resolveDelegateProgressTargetImpl, _resolveDelegateParent as _resolveDelegateParentImpl, _markDelegateAncestorActivity as _markDelegateAncestorActivityImpl, handleDelegateTask as handleDelegateTaskImpl, _delegateResultToHttp as _delegateResultToHttpImpl, handleDelegateWait as handleDelegateWaitImpl, _runDelegateTask as _runDelegateTaskImpl, _runDelegateTaskCore as _runDelegateTaskCoreImpl, _runTaskboardDelegate as _runTaskboardDelegateImpl, _readDelegateMemoryPressure as _readDelegateMemoryPressureImpl, _tryReserveDelegateSlot as _tryReserveDelegateSlotImpl, _releaseDelegateSlot as _releaseDelegateSlotImpl, _waitForDelegateCapacity as _waitForDelegateCapacityImpl, _releasePreadmittedDelegateCapacity as _releasePreadmittedDelegateCapacityImpl, _admitDelegateCreate as _admitDelegateCreateImpl, _applyDelegateCapacityReject as _applyDelegateCapacityRejectImpl } from './delegateRuntime.js'
import { type AdvisorHandlersHost, advisorConsultStore as advisorConsultStoreImpl, _ensureConsultBillingProjection as _ensureConsultBillingProjectionImpl, advisorConfigStore as advisorConfigStoreImpl, _projectAdvisorConsultSettled as _projectAdvisorConsultSettledImpl, _adviceFromConsult as _adviceFromConsultImpl, _advisorSessionKey as _advisorSessionKeyImpl, _closeStaleConsult as _closeStaleConsultImpl, _presentConsultBody as _presentConsultBodyImpl, _presentExistingConsult as _presentExistingConsultImpl, _freezeAdvisorTurn as _freezeAdvisorTurnImpl, _invocationFromLiveConsultTool as _invocationFromLiveConsultToolImpl, handleConsultAdvisor as handleConsultAdvisorImpl, _loadConsultHistoryTape as _loadConsultHistoryTapeImpl, _resolveAdvisorConsultExecution as _resolveAdvisorConsultExecutionImpl, _spawnCcbAdvisorConsult as _spawnCcbAdvisorConsultImpl, _advisorConsultRouteOverride as _advisorConsultRouteOverrideImpl, _spawnAdvisorConsult as _spawnAdvisorConsultImpl } from './advisorHandlers.js'
import { type AskUserPermissionsHost, handlePermissionResponse as handlePermissionResponseImpl, _broadcastPermissionSettled as _broadcastPermissionSettledImpl, handleEngineAskUser as handleEngineAskUserImpl, _finishInWindowAskUserWait as _finishInWindowAskUserWaitImpl, _compensateInWindowAskUserAnswer as _compensateInWindowAskUserAnswerImpl, _persistDetachedAskUserCard as _persistDetachedAskUserCardImpl, _patchDetachedAskUserResolved as _patchDetachedAskUserResolvedImpl, _loadDetachedAskUserCard as _loadDetachedAskUserCardImpl, _hydrateDetachedAskUserPending as _hydrateDetachedAskUserPendingImpl, _submitDetachedAskUserAnswer as _submitDetachedAskUserAnswerImpl, _forceDenyPendingPermission as _forceDenyPendingPermissionImpl, _reapCrashedSessionPendingPermissions as _reapCrashedSessionPendingPermissionsImpl, _settlePendingPermissionsForStop as _settlePendingPermissionsForStopImpl, _autoDenyPendingPermissions as _autoDenyPendingPermissionsImpl, _sweepStalePendingPermissions as _sweepStalePendingPermissionsImpl } from './askUserPermissions.js'
import { type CronTaskWebhookHost, _drainFlagOffCronOriginNotifies as _drainFlagOffCronOriginNotifiesImpl, _handleWebhook as _handleWebhookImpl, _handleTasksApi as _handleTasksApiImpl, _handleTaskItem as _handleTaskItemImpl, _triggerTask as _triggerTaskImpl, injectCronOriginFromTerminal as injectCronOriginFromTerminalImpl, injectCronOriginSession as injectCronOriginSessionImpl, cronProjectPorts as cronProjectPortsImpl, stampCronProject as stampCronProjectImpl, handleCronChannels as handleCronChannelsImpl, handleCronApi as handleCronApiImpl, handleCronItem as handleCronItemImpl } from './cronTaskWebhook.js'
import { type HttpMiscHandlersHost, _resolveMediaDirs as _resolveMediaDirsImpl, _sendMediaResolveError as _sendMediaResolveErrorImpl, handleApiFile as handleApiFileImpl, handleMediaGet as handleMediaGetImpl, handleUpload as handleUploadImpl, handleCollaborationConfig as handleCollaborationConfigImpl, handleSearch as handleSearchImpl, handleOAuthStart as handleOAuthStartImpl, handleOAuthCallback as handleOAuthCallbackImpl, refreshClaudeOAuthIfNeeded as refreshClaudeOAuthIfNeededImpl } from './httpMiscHandlers.js'
import { type ChannelHandlersHost, _updateWechatIdempotency as _updateWechatIdempotencyImpl, checkInboundBypass as checkInboundBypassImpl, handleTurnCancelIfQueued as handleTurnCancelIfQueuedImpl, handleTurnRejectIfAbsent as handleTurnRejectIfAbsentImpl, handleTurnDispatchState as handleTurnDispatchStateImpl, handleWechatInbound as handleWechatInboundImpl, handleWechatStop as handleWechatStopImpl, handleWechatInboundCompensate as handleWechatInboundCompensateImpl, _handleWechat as _handleWechatImpl, handleEnginePreheat as handleEnginePreheatImpl } from './channelHandlers.js'
import { type InboundDispatchHost, dispatchInbound as dispatchInboundImpl } from './inboundDispatch.js'
import { type WsConnectionHost, handleWsConnection as handleWsConnectionImpl, autoResumeFromHello as autoResumeFromHelloImpl, handleStop as handleStopImpl, deliver as deliverImpl, _sendStatusFrame as _sendStatusFrameImpl, _sendStampedSessionFrame as _sendStampedSessionFrameImpl, _consumeFrameAuthority as _consumeFrameAuthorityImpl } from './wsConnection.js'
// Moved to ./gatewayFilePolicy.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export { FILE_BLOCKED_PATTERNS, isFileAllowed, FILE_ALLOWED_DIRS, MIME_MAP, uploadExtForMime, UPLOAD_MIME_TO_EXT, isUploadMimeAllowed, makeUserScopedMediaPredicate, COMMERCIAL_USER_VOLUME_MEDIA_GATE, MEDIA_EXTENSIONS, TRUSTED_CONTAINER_HOME, isTrustedContainerFileServeEnabled, OPT_OPENCLAUDE_EXPORT_RE, TEMP_PREFIX, isFileBlocked, safeUploadExtension } from './gatewayFilePolicy.js'
export type { UserMediaLocationLike, UploadFsOps } from './gatewayFilePolicy.js'
import type { UploadFsOps } from './gatewayFilePolicy.js'
// Moved to ./localExecution.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export { decideLocalExecution, resolveLocalExecutionIfEnforced, localExecutionOverride, resolveExecutionModel, EXECUTION_MODEL_FALLBACK_ROUTE, resolveSyntheticTurnModel, downgradeSyntheticCodex, readLiveRunnerModel, peekLiveRunnerModel, liveSessionModelUnusableReason, liveSessionReuseSkipReason, EXECUTION_MODEL_FALLBACK, SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT, TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN, TICKETLESS_LIVE_SESSION_REPLACING_REASON } from './localExecution.js'
export type { LocalExecutionDecision, LocalTurnKind, SyntheticTurnModel } from './localExecution.js'
// Moved to ./turnFrames.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export { _shouldPushTurnInterruptedFinal, _buildTurnTraceContext, _buildEngineErrorFrame, _earlyRejectErrorFrames, _inheritOutboundRouting, preparedModelSwitchCatchupFrame, _stripPrivateRoutingFields, _buildTurnStatusFrame, _turnStatusWireFields, _buildContextRebuiltFrame, _matchActiveTurnReplayCandidate, _unservedActiveTurnReplay, _noteActiveTurnReplayServed, _shouldInterruptUnknownInFlight, GATEWAY_TERMINAL_CODE_MESSAGES, _safeErrorFrameDetail, _parseConnectionTraceIdFromUpgrade, ACTIVE_TURN_REPLAY_CANDIDATE_MAX } from './turnFrames.js'
export type { PrivateRoutingFields } from './turnFrames.js'
import { _stripPrivateRoutingFields } from './turnFrames.js'
// Moved to ./gatewayTypes.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export type { CommercialHook } from './gatewayTypes.js'
import type { CommercialHook } from './gatewayTypes.js'
import { type GatewayLifecycleHost, start as startImpl, _doShutdown as _doShutdownImpl, shutdown as shutdownImpl, bootAutoResume as bootAutoResumeImpl, _recoverTurnDispatchInbox as _recoverTurnDispatchInboxImpl, _startTurnDispatchRecoveryLoop as _startTurnDispatchRecoveryLoopImpl, _runTurnDispatchRecoverySweep as _runTurnDispatchRecoverySweepImpl, _ensureEngineNotifier as _ensureEngineNotifierImpl, _armNotifyRetryScheduler as _armNotifyRetrySchedulerImpl, _tickScheduledTasks as _tickScheduledTasksImpl } from './gatewayLifecycle.js'
import { type GatewayHttpHost, handleHttp as handleHttpImpl, _handleHttpAfterCommercial as _handleHttpAfterCommercialImpl, _serveStaticCached as _serveStaticCachedImpl, _staticCacheFreshOnDisk as _staticCacheFreshOnDiskImpl, openFileHardened as openFileHardenedImpl, setSessionCookie as setSessionCookieImpl, _refreshToken as _refreshTokenImpl, verifyCommercialJwt as verifyCommercialJwtImpl, checkHttpAuth as checkHttpAuthImpl, extractToken as extractTokenImpl, isHttps as isHttpsImpl, getUserId as getUserIdImpl, readBody as readBodyImpl } from './gatewayHttp.js'
import { type SessionRepoBindingHost, _handleSessionRepoBind as _handleSessionRepoBindImpl, _handleSessionRepoUnbind as _handleSessionRepoUnbindImpl, _checkRepoBindSession as _checkRepoBindSessionImpl, _flushPendingRepoBinds as _flushPendingRepoBindsImpl } from './sessionRepoBinding.js'
import { type TurnDispatchHost, _notifyDispatchHooks as _notifyDispatchHooksImpl, _acquireSyntheticTurnBarrier as _acquireSyntheticTurnBarrierImpl, _rejectAuthority as _rejectAuthorityImpl, _sendTurnDispatchReceipt as _sendTurnDispatchReceiptImpl, _consumeDispatchAuthority as _consumeDispatchAuthorityImpl, _buildStatusCallback as _buildStatusCallbackImpl, _dispatchAdmittedClientTurn as _dispatchAdmittedClientTurnImpl, _recordSettlement as _recordSettlementImpl, _lookupSettlement as _lookupSettlementImpl } from './turnDispatch.js'
import { type PromptQueueDispatchHost, _promptQueueContext as _promptQueueContextImpl, _registerPromptQueueClient as _registerPromptQueueClientImpl, _sendPromptQueueGrantCancellation as _sendPromptQueueGrantCancellationImpl, _broadcastPromptQueueSnapshot as _broadcastPromptQueueSnapshotImpl, _sendPromptQueueSnapshotToClient as _sendPromptQueueSnapshotToClientImpl, _sendPromptQueueDispatch as _sendPromptQueueDispatchImpl } from './promptQueueDispatch.js'
import { type SkillTrainRunsHost, _collectGenSessionExcerpts as _collectGenSessionExcerptsImpl, _trainingAgent as _trainingAgentImpl, _ownedTrainRun as _ownedTrainRunImpl, _onTrainEvent as _onTrainEventImpl, _maybeAutoEvalTrainRun as _maybeAutoEvalTrainRunImpl } from './skillTrainRuns.js'
import { type AgentMessageHost, handleAgentMessage as handleAgentMessageImpl, _sendAdapterOutboundMessage as _sendAdapterOutboundMessageImpl, checkBridgeBypass as checkBridgeBypassImpl, _preheatSessionOnOpen as _preheatSessionOnOpenImpl } from './agentMessage.js'
import { type DelegateGuardHost, _checkDelegateResourceGate as _checkDelegateResourceGateImpl, _formatDelegateConcurrencyReject as _formatDelegateConcurrencyRejectImpl, _registerActiveDelegation as _registerActiveDelegationImpl, _interruptDelegationsForParent as _interruptDelegationsForParentImpl, _liveMainSessionForClient as _liveMainSessionForClientImpl, _catalogEngineForModel as _catalogEngineForModelImpl, _loadClientSession as _loadClientSessionImpl, _parentEngineForCollabSession as _parentEngineForCollabSessionImpl, _collaborationCapabilityFields as _collaborationCapabilityFieldsImpl, _consultWaitMs as _consultWaitMsImpl, _consultJobFailedState as _consultJobFailedStateImpl, _consultStillLive as _consultStillLiveImpl } from './delegateGuard.js'
// Moved to ./delegatePolicy.js (FINDINGS §7.6, OCV5-533); re-exported for existing importers.
export { ALLOWED_INBOUND_MODELS, DELEGATE_DEFAULT_PREFERRED_MODELS, DELEGATE_GROK_FALLBACK_MODEL, assertKnownExplicitDelegateModel, DELEGATE_QUEUE_MAX_WAITERS, MAX_HIDDEN_DELEGATIONS_PER_TURN, MEMBER_DELEGATIONS_PER_TURN_DEFAULT, PerTurnDelegationGuard, resolveDelegateParentClientSessionId } from './delegatePolicy.js'
export type { DelegateGateBlock, RunDelegateInput } from './delegatePolicy.js'
import { PerTurnDelegationGuard } from './delegatePolicy.js'
import type { DelegateGateBlock, RunDelegateInput } from './delegatePolicy.js'
// Moved to ./wechatInboundCompensate.js (FINDINGS §7.6, OCV5-533); re-exported for existing importers.
export { COMPENSATE_SESSION_ID_RE, COMPENSATE_BINDING_USER_ID_RE, COMPENSATE_TRACE_ID_MAX_LEN, validateWechatInboundCompensateBody } from './wechatInboundCompensate.js'
export type { WechatStartOutcome, WechatInboundCompensatePayload, WechatInboundCompensateValidation } from './wechatInboundCompensate.js'
import type { WechatStartOutcome } from './wechatInboundCompensate.js'
import type { UpdateWechatIdempotencyPatch } from './channelHandlers.js'
import type { ResolveMediaDirsResult } from './httpMiscHandlers.js'
import type { SkillEvalTurnOpts } from './skillHandlers.js'
import type { HydrateAutoDreamOptimizerProposalsInput, LoadAutoDreamAuditDatasetInput } from './agentHandlers.js'
import type { TouchDelegateInflightSurfaceInput } from './delegateSupervision.js'
import type { CheckDelegateResourceGateOpts, CollaborationCapabilityFieldsInput, ConsultJobFailedStateView, FormatDelegateConcurrencyRejectOpts, ParentEngineForCollabSessionInput } from './delegateGuard.js'
import type { ApplyDelegateCapacityRejectArgs, ReleaseDelegateSlotOpts, ResolveDelegateParentArgs, ResolveDelegateParentResult, ResolveDelegateProgressTargetArgs, TryReserveDelegateSlotOpts, WaitForDelegateCapacityArgs, WaitForDelegateCapacityResult } from './delegateRuntime.js'
import type { AdviceFromConsultRecord, InvocationFromLiveConsultToolParent, PresentExistingConsultInput, ResolveAdvisorConsultExecutionResult, SpawnAdvisorConsultInput, SpawnAdvisorConsultResult, SpawnCcbAdvisorConsultInput, SpawnCcbAdvisorConsultResult } from './advisorHandlers.js'
import type { AcquireSyntheticTurnBarrierResult, LookupSettlementResult, RecordSettlementEntry } from './turnDispatch.js'
import type { InjectCcbLocalAgentCallbackArgs, InjectSendToAgentCallbackArgs, SendToAgentCallbackTurnAlreadyQueuedArgs } from './delegateCallbacks.js'
import type { AutoResumeFromHelloPeers, DeliverOut, HandleStopFrame } from './wsConnection.js'
import type { BroadcastPermissionSettledPayload, CompensateInWindowAskUserAnswerPending, FinishInWindowAskUserWaitArgs, HandlePermissionResponseFrame, HydrateDetachedAskUserPendingFrame, PatchDetachedAskUserResolvedPending, PersistDetachedAskUserCardArgs, SubmitDetachedAskUserAnswerPending } from './askUserPermissions.js'
// Moved to ./httpUploadStatic.js (FINDINGS §7.6, OCV5-533); re-exported for existing importers.
export { MAX_UPLOAD_SINGLE, MAX_UPLOAD_TOTAL, SAFE_UPLOAD_EXTENSION_RE, mimeFor, staticCacheControl, shouldLogHttpAccess } from './httpUploadStatic.js'
// Moved to ./autoDreamSchedule.js (FINDINGS §7.6, OCV5-533); re-exported for existing importers.
export { AUTO_DREAM_SCHEDULE_KEYS, normalizeAutoDreamSchedule } from './autoDreamSchedule.js'
// Moved to ./askUserSanitize.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export { sanitizeAskUserQuestionUpdatedInput, sanitizeEngineAskUserQuestions, ASK_USER_QUESTION_STRING_MAX_LEN } from './askUserSanitize.js'
export type { EngineAskUserSettlement } from './askUserSanitize.js'
// Moved to ./routeOverrides.js (FINDINGS §7.6, OCV5-484); re-exported for existing importers.
export { _buildSafeCodexRouteOverride, _buildSafeAntigravityRouteOverride, _buildSafeZcodeRouteOverride, _buildSafeGrokRouteOverride, CODEX_OFFICIAL_RELAY_PROVIDER_ID, CODEX_API_RELAY_ROUTE_KEYS, CODEX_OFFICIAL_RELAY_BASE_PATH, CODEX_ROUTE_PROVIDER_ID_RE, CODEX_ROUTE_BASE_URL_MAX, CODEX_ROUTE_PROVIDER_NAME_MAX } from './routeOverrides.js'
export { GATEWAY_PENDING_PERMISSION_TTL_MS, BLOCKING_USER_INPUT_TOOLS, _isBlockingUserInputTool, _permissionRequestExpiresAt, type PendingPermissionCatchupEntry, _pendingPermissionCatchupFrames, parsePermissionLookupQuery, projectRuntimePermissionSnapshot, attachPermissionSnapshotIfMissing } from './pendingPermissionSnapshot.js'

// User-Agent for gateway-internal Claude OAuth fetch (token exchange + refresh).
// Default Node fetch sends `undici` which is an obvious non-CC fingerprint to
// Anthropic's OAuth endpoint. Mimic the Claude Code CLI UA pattern instead.
// Version is overridable via env so this stays in sync with installed CCB after
// CCB upgrades; CCB's own MACRO.VERSION is a build-time constant unreachable
// from the gateway process, so we can't auto-derive it.
// Codex (auth.openai.com) intentionally NOT covered — different fingerprint
// regime, no evidence of risk, and the gateway _refreshToken path is a backup
// to codex-cli's own internal refresh anyway.
export const CLAUDE_OAUTH_USER_AGENT = `claude-cli/${process.env.OPENCLAUDE_CC_VERSION_FOR_OAUTH || '2.1.888'} (external, cli)`

export const V3_WECHAT_OUTBOUND_ADAPTER_ID = 'v3-wechat-outbound'
export const V3_QQBOT_OUTBOUND_ADAPTER_ID = 'v3-qqbot-outbound'

export type LiveRunnerSessionView = {
  runner?: { model?: string }
  model?: string
  _replacing?: boolean
}

/** Mirror SubprocessRunner's MCP merge rules for prompt/upload hints.
 * This is intentionally metadata-only: the actual tool injection still
 * happens when the CCB subprocess starts. */
export function collectAvailableMcpToolNames(
  config: OpenClaudeConfig,
  agent?: AgentDef,
): string[] {
  const tools = new Set<string>()
  const effectiveProvider = agent?.provider ?? config.provider

  const toolsetDefs = config.toolsets
  const agentToolsets = agent?.toolsets ?? config.defaults.toolsets
  let allowedMcpIds: Set<string> | null = null
  if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
    allowedMcpIds = new Set<string>()
    for (const ts of agentToolsets) {
      const ids = toolsetDefs[ts]
      if (ids) for (const id of ids) allowedMcpIds.add(id)
    }
    allowedMcpIds.add('openclaude-memory')
  }

  const addTools = (id: string, names?: string[], bypassToolset = false) => {
    if (!bypassToolset && allowedMcpIds && !allowedMcpIds.has(id)) return
    for (const name of names ?? []) tools.add(name)
  }

  for (const srv of config.mcpServers ?? []) {
    if (srv.enabled === false) continue
    if (srv.provider && srv.provider !== effectiveProvider) continue
    addTools(srv.id, srv.tools)
  }

  for (const srv of agent?.mcpServers ?? []) {
    if (srv.enabled === false) continue
    // Agent-specific MCPs override/bypass global provider scoping, matching
    // SubprocessRunner's Layer 3 behavior.
    addTools(srv.id, srv.tools, true)
  }

  return [...tools]
}
const defaultUploadFsOps: UploadFsOps = { fchmodSync, fchownSync, linkSync }
export let _uploadFsOps: UploadFsOps = defaultUploadFsOps
export function __setUploadFsOpsForTests(overrides: Partial<UploadFsOps> | null): void {
  _uploadFsOps = overrides ? { ...defaultUploadFsOps, ...overrides } : defaultUploadFsOps
}

export interface GatewayDeps {
  config: OpenClaudeConfig
  agentsConfig: AgentsConfig
  webRoot?: string // 静态 web UI 目录
  /**
   * 静态托管语义模式(单一权威在 cli launcher 按 runtime channel 选定,与 webRoot 同源决定):
   *   - 'vanilla'(默认,v3/personal): 服务 packages/web/public,沿用 ?v=hash cache-bust
   *     约定 → 资产 `public, max-age=3600`、sw.js 不缓存。**未设即 vanilla,v3 行为零变化**。
   *   - 'spa'(v5 Aurora): 服务 packages/web-react/dist 这类 bundler 产物 →
   *     `/assets/` 下内容哈希资产长缓存 immutable,其余(含 index.html)走 ETag 重校验。
   * 仅影响 Cache-Control 头的计算;ETag/304、路径白名单、SPA 回退逻辑两模式共用。
   */
  staticMode?: 'vanilla' | 'spa'
  channelFactories?: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter>
  /** V3 2H: 商业化模块挂载点(undefined = 未启用)。由 cli launcher 在 COMMERCIAL_ENABLED=1 时注入。 */
  commercial?: CommercialHook
}

export function makePeerKey(userId: string, channel: string, peerId: string): string {
  return `${userId}:${channel}:${peerId}`
}

// Hoisted so the methods moved out of Gateway (OCV5-493) read the same value; the class statics alias them.
export const PENDING_PERMISSION_SWEEP_MS = 60_000
export const REPO_BIND_HELLO_GRACE_MS = 5_000
export const REPO_BIND_PENDING_TIMEOUT_MS = 5_000
export const JWT_TTL_SECONDS = 30 * 86400 // 30 days

export class Gateway {
  private wss!: WebSocketServer
  /** Bound helpers for the route modules in routes/ (OCV5-376 P2). */
  private readonly httpIo: GatewayHttpIo = {
    sendJson: (res, code, body) => this.sendJson(res, code, body),
    readBody: (req, maxBytes) => this.readBody(req, maxBytes),
    getUserId: (req) => this.getUserId(req),
  }
  private httpServer!: ReturnType<typeof createServer>
  private router: Router
  private sessions: SessionManager
  private autoDream: AutoDreamService
  private autoDreamOptimizer: AutoDreamOptimizerService
  private cron: CronScheduler | null = null
  private webhookRouter: WebhookRouter | null = null
  private _taskStore = new TaskStore()
  private _runLog = new RunLog()
  // SkillOpt training: async run registry (state machine + per-skill/global concurrency
  // cap). Drafts staged via skill_propose; merge promotes them to the authoritative lib.
  private skillTrainJobs = new SkillTrainJobStore({ maxConcurrent: 2 })
  private skillEvalJobs = new SkillEvalJobStore({ maxConcurrent: 1 })
  private skillEvalGenJobs = new SkillEvalGenJobStore({ maxConcurrent: 1 })
  private skillDrafts = new SkillDraftStore()
  private channels = new Map<string, ChannelAdapter>()
  private log = createLogger({ module: 'gateway' })
  private _containerPreview: ContainerPreviewHandler
  private rateLimiter = new RateLimiter()
  private _wsKeepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _taskSchedulerTimer: ReturnType<typeof setInterval> | null = null
  /** taskboard 统一 60s tick。与 _taskSchedulerTimer 同款生命周期:start 里
   *  setInterval + unref, _doShutdown Stage 2 clearInterval。不登记
   *  check-schedulers.ts(那份 lint 只扫 commercial/src)。 */
  private _taskboardTickTimer: ReturnType<typeof setInterval> | null = null
  private _taskboardPatrol: PatrolEngine | null = null
  private _oauthRefreshTimer: ReturnType<typeof setInterval> | null = null
  private _pendingPermissionSweepTimer: ReturnType<typeof setInterval> | null = null
  private _stopEviction: (() => void) | null = null
  /** v3 master sink retry queue stop hook — set when sink is wired in
   *  start(); called in shutdown stage 2 to cancel the periodic drain
   *  timer. null when v3 sink isn't configured (personal version). */
  private _stopV3RetryDrainer: (() => void) | null = null
  private _kickV3RetryDrainer: (() => void) | null = null
  /** RFC-v5-durable-turn-dispatch §3 — durable inbox 的 retry queue 句柄(boot
   *  recovery ① 查同 dispatch entry + synthetic crashed tape 走同一 queue)。 */
  private _turnDispatchQueue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue | null = null
  /** RFC-v5-durable-turn-dispatch §B5 — durable turn dispatch 链路整体就绪。
   *  仅当 sink hooks 装配 ∧ 端点注册 ∧ boot recovery 首跑成功 后置真;capability 广播
   *  (attest/healthz)据此 fail-closed(见 durableTurnDispatchCapabilities)。 */
  private _durableTurnDispatchReady = false
  /** RFC-v5-durable-turn-dispatch §B4 — 周期 recovery 重试定时器(single-flight)。 */
  private _turnDispatchRecoveryTimer: NodeJS.Timeout | null = null
  /** single-flight 门闩:boot 首跑 / 周期扫一次只跑一轮,防重入。 */
  private _turnDispatchRecoveryInFlight = false
  /** Commercial tool telemetry stays subscribed through session drain, then
   *  fsyncs its final aggregate batch before the process may exit. */
  private _toolFailureReporter: ToolFailureReporter | null = null
  private _skillShadowReporter: SkillShadowReporter | null = null
  private _shuttingDown = false
  private _shutdownPromise: Promise<void> | null = null
  /** Host-controlled stale-image barrier: covers dispatch preprocessing. */
  private _runtimeRecycleDrainUntil = 0
  private _runtimeRecycleIngressActive = 0
  private _runtimeRecycleDrainCoordinator: RuntimeRecycleDrainCoordinator | null = null

  // ── Idempotency key dedup (prevents duplicate processing on client reconnect replay) ──
  private _seenIdempotencyKeys = new Map<string, {
    ts: number
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    }
  }>() // key → timestamp + optional WeChat retry metadata
  private static readonly IDEMPOTENCY_MAX_KEYS = 1000
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60_000 // 5 minutes
  // WeChat turns now ACK Step 1 as soon as the runner starts and can keep
  // executing for hours. Keep only WeChat retry metadata long enough for
  // late Step1 retries to dedupe instead of dispatching a second copy.
  private static readonly WECHAT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000 // 24 hours

  /**
   * Check whether an idempotency key has already been processed (read-only).
   * Returns true if the key is a duplicate (i.e. should be skipped).
   */
  private _isIdempotencyDuplicate(key: string): boolean {
    return this._getIdempotencyEntry(key) !== null
  }

  private _getIdempotencyEntry(key: string): {
    ts: number
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    }
  } | null {
    if (!key) return null
    const now = Date.now()

    // Evict expired entries periodically
    if (this._seenIdempotencyKeys.size > 100) {
      for (const [k, entry] of this._seenIdempotencyKeys) {
        if (now - entry.ts > Gateway._idempotencyTtlMs(entry)) {
          this._seenIdempotencyKeys.delete(k)
        }
      }
    }

    const entry = this._seenIdempotencyKeys.get(key)
    if (!entry) return null
    if (now - entry.ts >= Gateway._idempotencyTtlMs(entry)) {
      this._seenIdempotencyKeys.delete(key)
      return null
    }
    return entry
  }

  private static _idempotencyTtlMs(entry: {
    wechat?: unknown
  }): number {
    return entry.wechat ? Gateway.WECHAT_IDEMPOTENCY_TTL_MS : Gateway.IDEMPOTENCY_TTL_MS
  }

  /** Record an idempotency key as processed. */
  private _markIdempotencyKey(
    key: string,
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    },
  ): void {
    if (key) this._seenIdempotencyKeys.set(key, { ts: Date.now(), ...(wechat ? { wechat } : {}) })
  }

  private _updateWechatIdempotency(key: string, patch: UpdateWechatIdempotencyPatch): void {
    _updateWechatIdempotencyImpl.call(this as unknown as ChannelHandlersHost, key, patch)
  }

  // ── Cached task list for high-frequency eventBus lookups ──
  private _cachedTasks: Awaited<ReturnType<TaskStore['list']>> | null = null
  private async _getCachedTasks() {
    if (!this._cachedTasks) {
      this._cachedTasks = await this._taskStore.list()
    }
    return this._cachedTasks
  }
  private _invalidateTaskCache() {
    this._cachedTasks = null
  }

  // ── Cached agents config (avoid re-reading YAML on every request) ──
  private _agentsConfigCache: AgentsConfig | null = null
  private _agentsConfigMtime: number = 0

  private async _getAgentsConfig(): Promise<AgentsConfig> {
    try {
      const st = statSync(paths.agentsYaml)
      const mtime = st.mtimeMs
      if (this._agentsConfigCache && mtime === this._agentsConfigMtime) {
        return this._agentsConfigCache
      }
      this._agentsConfigCache = await readAgentsConfig()
      this._agentsConfigMtime = mtime
      return this._agentsConfigCache
    } catch {
      // File doesn't exist or stat failed — fall through to fresh read
      this._agentsConfigCache = await readAgentsConfig()
      this._agentsConfigMtime = 0
      return this._agentsConfigCache
    }
  }

  // ── User-facing projection of the agents config (single authority) ──
  // 枚举/展示消费面(agent 管理 GET、/v1/models、技能作用域等)统一走这里:
  // agents/routes 剔除隐藏系统 agent、default 收敛到用户可见值。判定/授权/执行面
  // 不走此视图(继续用 isHiddenSystemAgentId predicate 看全量)。
  // 投影结果按底层缓存对象**身份**复用:_getAgentsConfig 只在 YAML mtime 变化时
  // 换新对象,故身份不变即可复用投影;换新(或错误路径每次 fresh read)即重算,
  // 无陈旧风险,也不改动底层缓存对象。
  private _agentsConfigUserViewSource: AgentsConfig | null = null
  private _agentsConfigUserViewCache: AgentsConfig | null = null

  private async _getAgentsConfigUserView(): Promise<AgentsConfig> {
    const cfg = await this._getAgentsConfig()
    if (this._agentsConfigUserViewCache && this._agentsConfigUserViewSource === cfg) {
      return this._agentsConfigUserViewCache
    }
    const view: AgentsConfig = {
      ...cfg,
      agents: filterUserVisibleAgentsForManagement(cfg.agents),
      routes: filterUserVisibleRoutesForManagement(cfg.routes),
      default: userVisibleDefaultAgentId(cfg.default),
    }
    this._agentsConfigUserViewSource = cfg
    this._agentsConfigUserViewCache = view
    return view
  }

  // ── In-memory cache for static web UI files ──
  private _staticFileCache = new Map<
    string,
    { content: Buffer; mime: string; etag: string; mtimeMs: number; ino?: number; size?: number }
  >()
  // (channel, peer.id) → 当前活跃的 ws client(用于回传 outbound)
  private clientsByPeer = new Map<string, Set<WebSocket>>()
  /** Commercial bridge sockets are the only valid path for an internal queue
   * dispatch request. Local/personal WS peers can never receive a grant. */
  private _bridgeConnections = new WeakSet<WebSocket>()
  private _promptQueueCoordinator: PromptQueueCoordinator | null = null
  private _promptQueueLifecycleByFrame = new WeakMap<object, PromptQueueTurnLifecycle>()
  private _promptQueueExecutionFenceByFrame = new WeakMap<object, PromptQueueExecutionFence>()
  private _promptQueueClientSessions = new WeakMap<WebSocket, Set<string>>()
  // Pending permission requests: requestId → { sessionKey, toolName, input, toolUseId, peerKey, channel, peer }
  // Used for single-settlement, original-input passthrough, and disconnect auto-deny.
  // `channel` and `peer` are preserved from the original request so disconnect
  // auto-deny broadcasts with the correct (unspoofable) peer kind.
  // `toolName` lets handlePermissionResponse apply tool-specific handling
  // (e.g. AskUserQuestion merges user-supplied `answers` into updatedInput).
  private _pendingPermissions = new Map<string, {
    sessionKey: string
    toolName: string
    input: Record<string, unknown>
    toolUseId?: string
    /** Browser-authored user row that owns the requesting turn. Carried so
     *  hello-time catch-up can re-attach the replayed card to its turn. */
    clientMessageId?: string
    peerKey: string
    /** Authenticated userId that owns this pending request — carried so that
     *  _recordSettlement can stamp the settlement with the owner, and
     *  reconstructed peerKeys on late-duplicate replay paths match the
     *  original broadcast scope. */
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    /** Monotonic timestamp (Date.now) at which this request should be auto-denied
     *  by the janitor even if no disconnect or crash occurred. Prevents orphan
     *  pending entries when a user leaves the tab open across days. */
    expiresAt: number
    /** Detached Cursor ask_user card: not a real engine permission. Survives
     *  turn end / disconnect / session eviction; 24h TTL; never auto-denied by
     *  the 30-minute sweeper. After the hybrid wait releases (or no waiter is
     *  holding), an allow starts a new user turn. */
    detachedAskUser?: boolean
    /** Blocking Codex requestUserInput. Browser disconnect is not denial;
     * it remains answerable until the logical-turn 12h authority deadline. */
    blockingUserInput?: boolean
  }>()
  // What routes/clientSessions.ts needs from the Gateway (FINDINGS §7 step 2a).
  // Declared after _pendingPermissions: field initializers run in order.
  private readonly clientSessionsIo: ClientSessionsHttpIo = {
    ...this.httpIo,
    sendSessionReadFailure: (res, error, sessionId, publicError) =>
      this.sendSessionReadFailure(res, error, sessionId, publicError),
    listSessions: () => this.sessions.list(),
    preheatSessionOnOpen: (sessId, userId, row) => this._preheatSessionOnOpen(sessId, userId, row),
    pendingPermissions: this._pendingPermissions,
    delegateJobs: () => this._delegateJobs,
    ensureDelegateInflightSurface: () => this._ensureDelegateInflightSurface(),
    advisorConfigStore: () => this.advisorConfigStore(),
  }
  /**
   * In-flight HTTP waiters for Cursor ask_user. Keyed by requestId. A waiter
   * exists only while handleEngineAskUser is blocked on waitMs; after
   * answered_in_window / released_to_detached the entry is deleted.
   */
  private _askUserWaiters = new Map<string, AskUserWaiter>()
  /** Max wait for a permission response before the janitor auto-denies.
   *  Matched to the outer CCB turn timeout (30 min) so we don't pre-empt
   *  a slow user while a turn is still live. */
  private static readonly PENDING_PERMISSION_TTL_MS = GATEWAY_PENDING_PERMISSION_TTL_MS
  /** Detached Cursor ask_user cards stay answerable this long. */
  private static readonly DETACHED_ASK_USER_TTL_MS = DETACHED_ASK_USER_TTL_MS
  /** How often the janitor scans _pendingPermissions. */
  private static readonly PENDING_PERMISSION_SWEEP_MS = PENDING_PERMISSION_SWEEP_MS
  // Recently-settled permission requests: requestId → authoritative result.
  // Used to replay the true `behavior` when a duplicate/late response arrives
  // after the first responder already won the race. Without this, the
  // already_settled branch would rebroadcast the LATE responder's behavior,
  // which could mislabel cards on a 3rd tab that missed the first broadcast.
  // Bounded by RECENT_SETTLEMENT_MAX (FIFO evict) and RECENT_SETTLEMENT_TTL_MS.
  private _recentSettlements = new Map<
    string,
    {
      behavior: 'allow' | 'deny'
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      sessionKey: string
      /** Authenticated userId from the originating request — needed to
       *  reconstruct the per-user peerKey on already-settled replay. */
      userId: string
      // Present only for AskUserQuestion allow settlements — replayed to
      // late-joining tabs so they can fill in the answers column of the card.
      answers?: Record<string, string>
      ts: number
    }
  >()
  // Per-agent last active channel tracking (for proactive push)
  // Track last active channel + session for proactive push (reminders, heartbeat, etc.)
  private lastActiveChannel = new Map<
    string,
    { channel: string; peerId: string; sessionKey: string; at: number; userId: string }
  >()

  // ── Phase 0.3: outbound frame ring buffer (short-term replay) ──
  // See packages/gateway/src/outboundRing.ts for the standalone class.
  // Every outbound.message frame delivered to a webchat peer gets a monotonic
  // `frameSeq` stamped alongside `ts`; the ring backs
  // `autoResumeFromHello(lastFrameSeq)` cursor replay so reconnecting clients
  // can catch up without hitting REST. When the ring can't satisfy a resume,
  // we emit `outbound.resume_failed` so the client escalates to REST sync.
  private _outboundRing!: OutboundRingBuffer
  /** OCV5-427: exact-turn replays already served per socket (`sessionKey\u0000clientMessageId`). */
  private readonly _activeTurnReplaysServed = new WeakMap<object, Set<string>>()

  // ── 模型执行权威(docs/V5_MODEL_AUTHORITY_PLAN.md §2/§7)────────────────────
  // 容器侧验签消费器(进程级:keyring + 容器身份 + epoch 单调水位 + replay cache)。
  // env 缺 keyring / 身份 → enabled=false → attestation 不广播 model_authority_v1
  // → bridge(flag 开)拒该连接并触发 recycle。个人版 / 无 env 的场景恒 disabled,
  // 所有旧路径行为零变化。
  private _modelAuthority = ModelAuthorityConsumer.fromEnv(process.env, (event, fields) =>
    this.log.error(event, fields),
  )
  /** RFC-v5-durable-turn-dispatch §3 — dispatch 票据验签消费器(复用 model authority
   *  同一 keyring / 同连接 challenge;kind 域隔离)。 */
  private _dispatchAuthority = DispatchAuthorityConsumer.fromEnv(process.env)
  /** 每条 bridge 连接的 challenge(WeakMap:ws GC 即释放)。 */
  private _authorityConns = new WeakMap<WebSocket, ConnectionAuthorityContext>()

  // ── Phase 4 GitHub workspace: per-WS recent hello peers cache + pending binds ──
  // bind 帧到达时,sessionId 必须出现在 clientsByPeer 注册表 OR 该 ws 最近 5s 内
  // 收到的 hello peers。否则入 pending 队列(5s timeout 后 fail)。
  // Map keyed by ws → { peerIds: Set<sessionId>, recordedAt: ms }
  private _recentHelloPeers = new WeakMap<
    WebSocket,
    { peerIds: Set<string>; recordedAt: number }
  >()
  private _pendingRepoBinds = new Map<
    string /* sessionId|version */,
    {
      ws: WebSocket
      frame: SessionRepoBindFrame
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private static readonly REPO_BIND_HELLO_GRACE_MS = REPO_BIND_HELLO_GRACE_MS
  private static readonly REPO_BIND_PENDING_TIMEOUT_MS = REPO_BIND_PENDING_TIMEOUT_MS
  private _repoWorkspace = new SessionRepoWorkspaceManager({
    info: (msg, fields) => this.log.info(msg, fields),
    warn: (msg, fields) => this.log.warn(msg, fields),
    error: (msg, fields) => this.log.error(msg, undefined, fields ? new Error(JSON.stringify(fields)) : undefined),
  })

  constructor(private deps: GatewayDeps) {
    this.router = new Router(deps.agentsConfig)
    this.sessions = new SessionManager(deps.config)
    this.sessions.onCcbTaskNotification = (session, payload) => {
      void this.handleCcbLocalAgentNotification(session, payload)
    }
    this.sessions.onCcbTaskNotificationDelivered = (session, payload) => {
      this.handleCcbLocalAgentDelivered(session.sessionKey, payload.taskId)
    }
    this.autoDream = new AutoDreamService({
      runModel: (input) => this._runAutoDreamModel(input),
      notifyResult: (report) => postInboxMessage(formatAutoDreamReceipt(report)),
      log: (event, fields) => this.log.info(event, fields),
    })
    const optimizerClient = new AutoDreamOptimizerClient()
    this.autoDreamOptimizer = new AutoDreamOptimizerService({
      loadAuditDataset: (input) => this._loadAutoDreamAuditDataset(input),
      runModel: (input) => this._runAutoDreamOptimizerModel(input, optimizerClient),
      finishModelRun: (input) =>
        this.sessions
          .destroySession(`auto-dream-optimizer:${input.runId}:reduce`)
          .then(() => undefined),
      hydrateProposals: (input) => this._hydrateAutoDreamOptimizerProposals(input),
      reportPlatformFindings: (input) => optimizerClient.reportFindings(input),
      applyProposal: (input) => this._applyAutoDreamOptimizerProposal(input, optimizerClient),
      log: (event, fields) => this.log.info(event, fields),
    })
    this._containerPreview = new ContainerPreviewHandler({
      log: {
        info: (message, fields) => this.log.info(message, fields),
        warn: (message, fields) => this.log.warn(message, fields),
        error: (message, fields, err) => this.log.error(message, fields, err),
      },
    })
    // Reconcile skill-training runs persisted across a gateway restart (active → failed).
    void this.skillTrainJobs.loadAll(Date.now())
    void this.skillEvalJobs.loadAll(Date.now())
    void this.skillEvalGenJobs.loadAll(Date.now())
    // P3:技能每日自动回归(严格 opt-in:仅 evals.json 里 autoRegression=true 的技能;
    // 开启入口在管理中心且强制确认每日消耗 —— 平台绝不静默烧用户积分)。
    this._startSkillAutoRegression()
    // Wire up auth error handler: force-refresh token when 401 detected (bypass expiry check)
    this.sessions.onAuthError = () => this.refreshClaudeOAuthIfNeeded(true)
    // Phase 5:把 _repoWorkspace 的 getRepoSnapshot 当 provider 注入。
    // 单进程架构下 workspace.states Map 就是权威源,SubprocessRunner.start()
    // 通过它读 ready repo 的 workspaceDir,作为 CCB 的 --add-dir。
    this.sessions.setRepoSnapshotProvider(
      this._repoWorkspace.getRepoSnapshot.bind(this._repoWorkspace),
    )
    // Optional config override for ring bounds: lets `boss` raise maxAgeMs on
    // commercial hosts where mobile users keep tabs backgrounded for >10min.
    const ringCfg = deps.config.gateway.outboundRing ?? {}
    this._outboundRing = new OutboundRingBuffer({
      maxEntries: ringCfg.maxEntries ?? DEFAULT_RING_CONFIG.maxEntries,
      maxAgeMs: ringCfg.maxAgeMs ?? DEFAULT_RING_CONFIG.maxAgeMs,
      maxBytes: ringCfg.maxBytes ?? DEFAULT_RING_CONFIG.maxBytes,
    })
    const promptQueueConfig = readPromptQueueClientConfig()
    if (promptQueueConfig) {
      this._promptQueueCoordinator = new PromptQueueCoordinator(
        new HttpPromptQueueClient(promptQueueConfig),
        {
          broadcast: (context, snapshot) => this._broadcastPromptQueueSnapshot(context, snapshot),
          direct: (context, requester, snapshot) => {
            this._sendPromptQueueSnapshotToClient(context, requester as WebSocket, snapshot)
          },
          sendDispatch: (context, frame) => this._sendPromptQueueDispatch(context, frame),
          interruptExact: async (context, turnId) =>
            this.sessions.interruptExact(context.owner.sessionKey, turnId),
          persistInterrupted: async ({ context, detail, turnId, turnIndex }) => {
            await persistInterruptedPromptQueueTurn({
              sessionKey: context.owner.sessionKey,
              peerId: context.owner.clientSessionId,
              agentId: context.owner.agentId,
              userId: context.userId,
              turnIndex,
              turnKey: turnId,
              clientMessageId: detail.clientMessageId,
            })
          },
          kickPersistence: () => this._kickV3RetryDrainer?.(),
          log: {
            info: (message, fields) => this.log.info(message, fields),
            warn: (message, fields) => this.log.warn(message, fields),
            error: (message, fields) => this.log.error(
              message,
              fields,
              fields?.error ? new Error(String(fields.error)) : undefined,
            ),
          },
        },
      )
      this.log.info('prompt queue coordinator enabled', { baseUrl: promptQueueConfig.baseUrl })
    }
    // 2026-04-21 Medium#G1:被 sessionManager 内部驱逐/shutdown 的 sessionKey
    // 由此 callback 统一走 outboundRing.clear,防 ring 内存长期泄漏。server.ts
    // 其他已有的 destroySession 调用点仍然显式 clear(幂等 double-clear 无副作用)。
    this.sessions.onSessionDestroyed = (sessionKey) => {
      try {
        this._outboundRing.clear(sessionKey)
        outboundRingSizeBytes.value = this._outboundRing.totalBytes()
      } catch {}
      clearCcbLocalAgentPendingForSession(sessionKey)
    }
  }

  /** Feed `prune()` eviction counts into Prometheus counters. Called from
   *  every store/peekReplay site so age-on-read pruning is also reflected.
   *  Also refreshes the ring size gauge — single source of truth for the
   *  `oc_outbound_ring_size_bytes` value. */
  private _recordRingEvictions(stats: EvictionStats): void {
    if (stats.entries) outboundRingEvictedTotal.inc({ cause: 'entries' }, stats.entries)
    if (stats.age) outboundRingEvictedTotal.inc({ cause: 'age' }, stats.age)
    if (stats.bytes) outboundRingEvictedTotal.inc({ cause: 'bytes' }, stats.bytes)
    outboundRingSizeBytes.value = this._outboundRing.totalBytes()
  }

  start(): Promise<void> {
    return startImpl.call(this as unknown as GatewayLifecycleHost)
  }

  /**
   * Public, idempotent shutdown. Safe to call from signal handlers, fatal
   * error handlers, or external orchestration. Concurrent calls share the
   * same in-flight shutdown promise.
   *
   * Pass `exit=false` to skip the terminal `process.exit(0)` — the caller
   * is then responsible for exiting (used by emergency exit handlers that
   * want to exit with code 1 after graceful flush).
   */
  public shutdown(exit = true): Promise<void> {
    return shutdownImpl.call(this as unknown as GatewayLifecycleHost, exit)
  }

  /** True once shutdown has begun; handlers use this to reject new ingress. */
  public get isShuttingDown(): boolean {
    return this._shuttingDown
  }

  private _doShutdown(exit: boolean): Promise<void> {
    return _doShutdownImpl.call(this as unknown as GatewayLifecycleHost, exit)
  }

  // ───────── HTTP ─────────
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    handleHttpImpl.call(this as unknown as GatewayHttpHost, req, res)
  }
  /** Narrow view of the Gateway for routes/preAuth.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly preAuthRoutesIo: PreAuthRoutesIo = ((gw: Gateway): PreAuthRoutesIo => ({
    _handleSkillEvalGenStart: (...args) => gw._handleSkillEvalGenStart(...args),
    _handleSkillEvalGenStatus: (...args) => gw._handleSkillEvalGenStatus(...args),
    _handleSkillTrainRun: (...args) => gw._handleSkillTrainRun(...args),
    _handleSkillTrainStart: (...args) => gw._handleSkillTrainStart(...args),
    extractToken: (...args) => gw.extractToken(...args),
    readBody: (...args) => gw.readBody(...args),
    sendInternalError: (...args) => gw.sendInternalError(...args),
    sendJson: (...args) => gw.sendJson(...args),
    get deps() {
      return gw.deps
    },
    get log() {
      return gw.log
    },
    get rateLimiter() {
      return gw.rateLimiter
    },
    get JWT_TTL_SECONDS() {
      return Gateway.JWT_TTL_SECONDS
    },
  }))(this)

  /** Narrow view of the Gateway for routes/platform.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly platformRoutesIo: PlatformRoutesIo = ((gw: Gateway): PlatformRoutesIo => ({
    _delegateRunnerIdle: (...args) => gw._delegateRunnerIdle(...args),
    _ensureDelegateJobStore: (...args) => gw._ensureDelegateJobStore(...args),
    _getAgentsConfigUserView: (...args) => gw._getAgentsConfigUserView(...args),
    checkHttpAuth: (...args) => gw.checkHttpAuth(...args),
    checkInboundBypass: (...args) => gw.checkInboundBypass(...args),
    handleEnginePreheat: (...args) => gw.handleEnginePreheat(...args),
    handleTurnCancelIfQueued: (...args) => gw.handleTurnCancelIfQueued(...args),
    handleTurnDispatchState: (...args) => gw.handleTurnDispatchState(...args),
    handleTurnRejectIfAbsent: (...args) => gw.handleTurnRejectIfAbsent(...args),
    handleWechatInbound: (...args) => gw.handleWechatInbound(...args),
    handleWechatInboundCompensate: (...args) => gw.handleWechatInboundCompensate(...args),
    handleWechatStop: (...args) => gw.handleWechatStop(...args),
    isHttps: (...args) => gw.isHttps(...args),
    readBody: (...args) => gw.readBody(...args),
    sendError: (...args) => gw.sendError(...args),
    sendInternalError: (...args) => gw.sendInternalError(...args),
    sendJson: (...args) => gw.sendJson(...args),
    setSessionCookie: (...args) => gw.setSessionCookie(...args),
    get _runLog() {
      return gw._runLog
    },
    get _runtimeRecycleDrainCoordinator() {
      return gw._runtimeRecycleDrainCoordinator
    },
    set _runtimeRecycleDrainCoordinator(value) {
      gw._runtimeRecycleDrainCoordinator = value
    },
    get _runtimeRecycleDrainUntil() {
      return gw._runtimeRecycleDrainUntil
    },
    set _runtimeRecycleDrainUntil(value) {
      gw._runtimeRecycleDrainUntil = value
    },
    get _runtimeRecycleIngressActive() {
      return gw._runtimeRecycleIngressActive
    },
    get deps() {
      return gw.deps
    },
    get log() {
      return gw.log
    },
    get sessions() {
      return gw.sessions
    },
  }))(this)

  /** Narrow view of the Gateway for routes/system.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly systemRoutesIo: SystemRoutesIo = ((gw: Gateway): SystemRoutesIo => ({
    getUserId: (...args) => gw.getUserId(...args),
    readBody: (...args) => gw.readBody(...args),
    sendJson: (...args) => gw.sendJson(...args),
    get _dispatchAuthority() {
      return gw._dispatchAuthority
    },
    get _durableTurnDispatchReady() {
      return gw._durableTurnDispatchReady
    },
    get _runLog() {
      return gw._runLog
    },
    get deps() {
      return gw.deps
    },
    get log() {
      return gw.log
    },
    get sessions() {
      return gw.sessions
    },
    get webhookRouter() {
      return gw.webhookRouter
    },
  }))(this)

  /** Narrow view of the Gateway for routes/appConfig.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly appConfigRoutesIo: AppConfigRoutesIo = ((gw: Gateway): AppConfigRoutesIo => ({
    sendError: (...args) => gw.sendError(...args),
    sendJson: (...args) => gw.sendJson(...args),
    get deps() {
      return gw.deps
    },
  }))(this)

  /** Narrow view of the Gateway for routes/agents.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly agentRoutesIo: AgentRoutesIo = ((gw: Gateway): AgentRoutesIo => ({
    _handleReleaseJobStatus: (...args) => gw._handleReleaseJobStatus(...args),
    _handleSkillEvalGenStart: (...args) => gw._handleSkillEvalGenStart(...args),
    _handleSkillEvalGenStatus: (...args) => gw._handleSkillEvalGenStatus(...args),
    _handleSkillEvalRunStatus: (...args) => gw._handleSkillEvalRunStatus(...args),
    _handleSkillEvalStart: (...args) => gw._handleSkillEvalStart(...args),
    _handleSkillEvalsFile: (...args) => gw._handleSkillEvalsFile(...args),
    _handleSkillTrainComment: (...args) => gw._handleSkillTrainComment(...args),
    _handleSkillTrainDraftItem: (...args) => gw._handleSkillTrainDraftItem(...args),
    _handleSkillTrainDrafts: (...args) => gw._handleSkillTrainDrafts(...args),
    _handleSkillTrainList: (...args) => gw._handleSkillTrainList(...args),
    _handleSkillTrainMerge: (...args) => gw._handleSkillTrainMerge(...args),
    _handleSkillTrainRun: (...args) => gw._handleSkillTrainRun(...args),
    _handleSkillTrainStart: (...args) => gw._handleSkillTrainStart(...args),
    _handleUserSkillFiles: (...args) => gw._handleUserSkillFiles(...args),
    _handleUserSkillHistory: (...args) => gw._handleUserSkillHistory(...args),
    _handleUserSkillRestore: (...args) => gw._handleUserSkillRestore(...args),
    handleAgentItem: (...args) => gw.handleAgentItem(...args),
    handleAgentMessage: (...args) => gw.handleAgentMessage(...args),
    handleAgentsCollection: (...args) => gw.handleAgentsCollection(...args),
    handleAutoDreamOptimizer: (...args) => gw.handleAutoDreamOptimizer(...args),
    handleAutoDreamOptimizerCancel: (...args) => gw.handleAutoDreamOptimizerCancel(...args),
    handleAutoDreamOptimizerProposal: (...args) => gw.handleAutoDreamOptimizerProposal(...args),
    handleAutoDreamReport: (...args) => gw.handleAutoDreamReport(...args),
    handleCollaborationConfig: (...args) => gw.handleCollaborationConfig(...args),
    handleConsultAdvisor: (...args) => gw.handleConsultAdvisor(...args),
    handleDelegateTask: (...args) => gw.handleDelegateTask(...args),
    handleDelegateWait: (...args) => gw.handleDelegateWait(...args),
    handleEngineAskUser: (...args) => gw.handleEngineAskUser(...args),
    handleMemory: (...args) => gw.handleMemory(...args),
    handleMemoryFile: (...args) => gw.handleMemoryFile(...args),
    handleMemoryUsage: (...args) => gw.handleMemoryUsage(...args),
    handlePersona: (...args) => gw.handlePersona(...args),
    handleSkillItem: (...args) => gw.handleSkillItem(...args),
    handleSkillsList: (...args) => gw.handleSkillsList(...args),
    handleUserSkillItem: (...args) => gw.handleUserSkillItem(...args),
    handleUserSkillsList: (...args) => gw.handleUserSkillsList(...args),
    sendInternalError: (...args) => gw.sendInternalError(...args),
  }))(this)

  /** Narrow view of the Gateway for routes/workspaceApi.ts (FINDINGS §7.5 2b, OCV5-468). */
  private readonly workspaceApiRoutesIo: WorkspaceApiRoutesIo = ((gw: Gateway): WorkspaceApiRoutesIo => ({
    preflightStages: (stages) => createTaskboardPreflight({ getAgentsConfig: () => gw._getAgentsConfig(), defaultModel: gw.deps.config.defaults.model })(stages),
    getRunSnapshots: (runs) => projectTaskboardRunSnapshots(runs, (key) => gw.sessions.getByKey(key)),
    _getAgentsConfigUserView: (...args) => gw._getAgentsConfigUserView(...args),
    _handleTaskItem: (...args) => gw._handleTaskItem(...args),
    _handleTasksApi: (...args) => gw._handleTasksApi(...args),
    _handleWebhook: (...args) => gw._handleWebhook(...args),
    _handleWechat: (...args) => gw._handleWechat(...args),
    checkBridgeBypass: (...args) => gw.checkBridgeBypass(...args),
    getUserId: (...args) => gw.getUserId(...args),
    handleApiFile: (...args) => gw.handleApiFile(...args),
    handleCronApi: (...args) => gw.handleCronApi(...args),
    handleCronChannels: (...args) => gw.handleCronChannels(...args),
    handleCronItem: (...args) => gw.handleCronItem(...args),
    handleMediaGet: (...args) => gw.handleMediaGet(...args),
    handleOAuthCallback: (...args) => gw.handleOAuthCallback(...args),
    handleOAuthStart: (...args) => gw.handleOAuthStart(...args),
    handleSearch: (...args) => gw.handleSearch(...args),
    handleUpload: (...args) => gw.handleUpload(...args),
    readBody: (...args) => gw.readBody(...args),
    sendInternalError: (...args) => gw.sendInternalError(...args),
    sendJson: (...args) => gw.sendJson(...args),
    verifyCommercialJwt: (...args) => gw.verifyCommercialJwt(...args),
    get _taskStore() {
      return gw._taskStore
    },
    get deps() {
      return gw.deps
    },
    get log() {
      return gw.log
    },
    get webhookRouter() {
      return gw.webhookRouter
    },
  }))(this)


  private _handleHttpAfterCommercial(req: IncomingMessage, res: ServerResponse): void {
    _handleHttpAfterCommercialImpl.call(this as unknown as GatewayHttpHost, req, res)
  }

  /**
   * 静态文件内存缓存的统一命中+读盘路径(通用静态资产与 SPA fallback 的 index.html 共用)。
   * 缓存条目带源文件 mtimeMs,命中时 stat 回盘比对:dist 被 rsync 覆盖(mtime 变)后
   * 下一个请求即拿到新内容 —— 与 ws/frontendBuild.ts 版本探针同语义自愈,漏重启 master
   * 时不会出现「WS 帧已收敛到新 build、HTTP 却一直吐旧 index.html」的分裂(那种分裂会让
   * 前端 update banner 陷入刷新死循环)。
   * 返回 true = 已响应(200/304);false = 磁盘无此文件,由调用方走兜底/404。
   */
  private _serveStaticCached(filePath: string, cacheHeader: string, req: IncomingMessage, res: ServerResponse, mime: string): boolean {
    return _serveStaticCachedImpl.call(this as unknown as GatewayHttpHost, filePath, cacheHeader, req, res, mime)
  }

  /**
   * 缓存条目与磁盘是否仍一致(mtimeMs + inode + size 比对;stat 失败/文件已删 → 视为失效)。
   * inode/size 是为 P0-Web(OCV5-489):webRoot 是 overlay 符号链接,换指向后同一路径是
   * 另一个文件,cp -a 保留的 mtime 可能与旧文件相同。缺字段的旧条目只比 mtime。
   */
  private _staticCacheFreshOnDisk(filePath: string, entry: { mtimeMs: number; ino?: number; size?: number }): boolean {
    return _staticCacheFreshOnDiskImpl.call(this as unknown as GatewayHttpHost, filePath, entry)
  }

  /** Extract bearer token from request (header, WS protocol, or cookie). */
  private extractToken(req: IncomingMessage): string {
    return extractTokenImpl.call(this as unknown as GatewayHttpHost, req)
  }

  private _isDelegateHttpPath(pathname: string): boolean {
    return _isDelegateHttpPathImpl.call(this as unknown as DelegateRuntimeHost, pathname)
  }

  private _hasValidDelegateContext(req: IncomingMessage): boolean {
    return _hasValidDelegateContextImpl.call(this as unknown as DelegateRuntimeHost, req)
  }

  private checkHttpAuth(req: IncomingMessage): boolean {
    return checkHttpAuthImpl.call(this as unknown as GatewayHttpHost, req)
  }

  /**
   * v3 file proxy: check whether this HTTP request is a valid HOST→container
   * bridge call for the explicit v3 bridge API allowlist. When true, the normal
   * checkHttpAuth() requirement is bypassed.
   *
   * All four conditions MUST hold:
   *  1. remote IP === OPENCLAUDE_TRUST_BRIDGE_IP (host in docker bridge)
   *  2. method + path match `BRIDGE_API_ALLOWLIST`
   *  3. X-OpenClaude-Container-Id === env.OC_CONTAINER_ID (binding)
   *  4. timingSafeEqual(X-OpenClaude-Bridge-Nonce, env.OC_BRIDGE_NONCE)
   *
   * Container side doesn't know the HOST's HMAC rootSecret — only its own
   * per-container nonce (HMAC(rootSecret, containerId)) injected at start.
   */
  private checkBridgeBypass(req: IncomingMessage, url: URL): boolean {
    return checkBridgeBypassImpl.call(this as unknown as AgentMessageHost, req, url)
  }

  /**
   * v3 WeChat broker → container inbound 通道(D3d HMAC 派生方案 B')。
   *
   * Master broker 通过 docker bridge gateway 主动 POST 到容器 gateway 的
   * `/internal/v3/wechat-inbound`。**与 checkBridgeBypass 严格不同**:
   *
   *   | 维度          | bridge bypass(file proxy)    | inbound bypass(broker → 容器) |
   *   | ------------- | ---------------------------- | --------------------------- |
   *   | 方向          | host → 容器(file/media 反代)  | host broker → 容器           |
   *   | path          | /api/file, /api/media/*       | /internal/v3/wechat-inbound  |
   *   | method        | GET / HEAD                    | POST                         |
   *   | nonce HMAC 域 | HMAC(s, containerId)           | HMAC(s, "inbound:" + cid)    |
   *   | env           | OC_BRIDGE_NONCE(hex 64)        | OPENCLAUDE_INBOUND_NONCE(b64url 43)|
   *   | header        | X-OpenClaude-Bridge-Nonce     | X-OpenClaude-Inbound-Nonce  |
   *
   * **故意编码不同**(hex vs base64url):env 名 / log / grep 一眼能区分两类 nonce,
   * 避免任何"复用同一校验函数 / 同一 header"的捷径让两条通道粘合。Codex r4 note 2 明确
   * 要求两条通道的 nonce 在 HMAC 输入域 + 编码上同时正交。
   *
   * TRUST_BRIDGE_IP / OC_CONTAINER_ID 与 file-proxy 共用;两个值同时缺/形态不对都直接
   * 拒(同 healthz capability 广播逻辑,避免 healthz advertise 但 bypass 失败的哑锁)。
   * 与 file-proxy 一样 fail-closed:env 缺一即恒 false。
   */
  private checkInboundBypass(req: IncomingMessage, url: URL): boolean {
    return checkInboundBypassImpl.call(this as unknown as ChannelHandlersHost, req, url)
  }

  /**
   * v3 WeChat broker → 容器 dispatchInbound 桥。
   *
   * 调用前必须先过 checkInboundBypass(在 route 入口处已校验)。这里负责:
   *  1. 读 body(256KB 上限,与 internalServerAuthored 对齐;wechat 单消息远小于此,
   *     但 attachments 可能拼大;给个稳妥上限)
   *  2. 轻量手写 schema 校验(gateway 没 zod 依赖,不为单条路由引入新 dep)
   *  3. 构造 InboundFrame 直接喂 this.dispatchInbound —— 复用 line 5181-5190
   *     lazy-session 路径(channel='wechat',peer.id 由 broker 解析为 client_sessions.id,
   *     即 RFC v4 中 sessionPointer.current_session_id)。**不要走** inbound.hello/
   *     inbound.bind 任何模板 —— 那些是 WS-only 控制帧,跟 HTTP inbound 无关。
   *  4. 200 回 { ok, sessionKey };400/413 严守语义,broker outbox 端可按 status
   *     class 决定 fatal vs retry(参见 wechat-broker-design.md §4.8)
   *
   * **trust 模型**:body.userId 由 broker 自行决定(它持有 wechat_bindings 行),
   * 容器层不再二次校验 c:NN 跟容器 owner 的对齐 —— 容器只服务一个用户,broker 错配
   * 整段消息走错容器属于上游路由 bug,跟 dispatchInbound 收到一条 WS frame 信任
   * _userId 是同一信任模型(checkInboundBypass 已确认 caller = master broker)。
   */
  /** OCV5-121: exact queued cancellation, never Stop an active predecessor. */
  private handleTurnCancelIfQueued(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleTurnCancelIfQueuedImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  /**
   * RFC-v5-durable-turn-dispatch §3 — POST /internal/v3/turn-reject-if-absent。
   *
   * body { userId, sessionId, clientMessageId, dispatchId, attemptNo }。事务:有行返
   * 现有状态(negative proof 不成立);无行插 rejected(not_accepted)墓碑。返回
   * { inserted, state, outcome } —— reconciler 据此决定 fail-visible vs 转 accepted。
   */
  private handleTurnRejectIfAbsent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleTurnRejectIfAbsentImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  /**
   * RFC-v5-durable-turn-dispatch §3 — GET /internal/v3/turn-dispatch-state。
   *
   * 按 dispatchId+attemptNo 或逻辑键(userId+sessionId+clientMessageId)查行。
   * 200 { found, state, outcome, dispatchId, attemptNo } —— reconciler accepted+stuck
   * 分支据此判 sink_staged/terminal(等)/ running(等)/ 行消失(manual)。
   */
  private handleTurnDispatchState(url: URL, res: ServerResponse): Promise<void> {
    return handleTurnDispatchStateImpl.call(this as unknown as ChannelHandlersHost, url, res)
  }

  private handleWechatInbound(req: IncomingMessage, res: ServerResponse, source: 'wechat' | 'qqbot' = 'wechat'): Promise<void> {
    return handleWechatInboundImpl.call(this as unknown as ChannelHandlersHost, req, res, source)
  }

  /**
   * v3 WeChat `/stop` bridge. Master resolves the current WeChat wsess and
   * calls this container-local endpoint; the actual runner is keyed as a
   * webchat session so the Web realtime link and WeChat interrupt hit the
   * same `agent:<id>:webchat:dm:<wsess>` SessionManager entry.
   */
  private handleWechatStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleWechatStopImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  /**
   * v3 WeChat broker → 容器 inbound 补偿端点。
   *
   * 调用前已过 checkInboundBypass(在 route 入口处校验);body 是 dispatcher
   * tryCompensation 构造的 `{sessionId, bindingUserId, reason, traceId?}` JSON。
   *
   * **idempotent + always-200**:
   *   - 行存在且未 soft-deleted → 调 deleteClientSession,200 `{ok:true, deleted:true}`
   *   - 行已 soft-deleted / 不存在 / 跨 tenant userId mismatch → 200 `{ok:true, deleted:false}`
   *   - schema 错 → 400(语义是 caller 出错,不是 compensation 失败 — 跟 idempotent 语义不冲突)
   *   - body 过大 → 413(同 handleWechatInbound 风格)
   *   - DB 异常 → 200 `{ok:true, deleted:false, errMessage}`(dispatcher 不该 retry 同条
   *     compensation;reconcile 30s 兜底)
   *
   * `userId` 通过 `c:` + `bindingUserId` 派生,与 master sqlite Step 2a 写入的
   * `MASTER_USER_PREFIX + bindingUserId` 字节级一致 — deleteClientSession 内部的
   * `WHERE id=? AND user_id=?` 自带 tenant scope 防御。
   */
  private handleWechatInboundCompensate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleWechatInboundCompensateImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  /**
   * v3 file proxy: open a file with TOCTOU-hardened realpath checking.
   * Callers must have already verified `realPath` against allowlist/blocklist.
   *
   *  - openSync(O_NOFOLLOW): last-component symlink defense.
   *  - realpathSync(/proc/self/fd/<fd>) === realPath: middle-directory
   *    symlink race defense. An attacker who swaps a parent directory
   *    between our allowlist check and open() will show up here with
   *    fdReal ≠ realPath.
   *  - isFileAllowed/isFileBlocked re-checked on fdReal as fail-closed
   *    defense (redundant but cheap).
   *
   * `extraAllowed` is the **caller-provided** user-scoped predicate. Callers
   * in v3 commercial must NOT pull a global textual predicate from `deps`
   * — that would re-introduce the cross-tenant IDOR risk where user A can
   * read user B's docker volume media by absolute path. Caller constructs
   * a closure over the **current request's** resolved `{uploads, generated}`
   * dirs and passes that down.
   *
   * Returns an fd on success; writes 403/404 to res and returns null on failure.
   */
  private openFileHardened(res: ServerResponse, realPath: string, agentCwds: string[], extraAllowed?: (p: string) => boolean): number | null {
    return openFileHardenedImpl.call(this as unknown as GatewayHttpHost, res, realPath, agentCwds, extraAllowed)
  }

  /** Get authenticated userId from request. Returns 'default' for legacy token auth. */
  private getUserId(req: IncomingMessage): string {
    return getUserIdImpl.call(this as unknown as GatewayHttpHost, req)
  }

  /**
   * Resolve the media directories (uploads + generated) for an authenticated
   * user. Both subdirs live in the same docker volume, so a single resolve
   * call returns both — avoids double-DB / double-docker-inspect on read.
   *
   * Returns `{ kind: 'legacy' }` for personal-version flows (no commercial
   * hook, or commercial hook with no resolver — e.g. agentRuntime didn't
   * come up). Caller falls back to `paths.uploadsDir` / `paths.generatedDir`.
   *
   * Otherwise delegates to `commercial.resolveUserMediaDirs` which returns
   * the structured `{ kind: 'ok', uploads, generated }` / `{ kind: 'fail',
   * reason }`. Gateway never silently falls back from a `fail` to legacy
   * paths — that would re-introduce the same single-tenant split-brain that
   * this whole change exists to fix.
   *
   * Status mapping (caller-side):
   *   not-ready    → 503 + Retry-After (provisioning window)
   *   remote-host  → 503 (deferred remote-volume push, see TODO)
   *   volume-missing/ambiguous/daemon-error → 500 (data corruption / docker err)
   *   invalid-uid  → 401 (token has bad sub form; shouldn't happen post-getUserId)
   */
  private _resolveMediaDirs(userId: string): Promise<
    ResolveMediaDirsResult
  > {
    return _resolveMediaDirsImpl.call(this as unknown as HttpMiscHandlersHost, userId)
  }

  /**
   * Translate a `_resolveMediaDirs` failure into an HTTP response and log.
   * Returns true if the caller should stop (response already sent), false if
   * it can keep going (currently never returns false — branches always send).
   *
   * Centralized so handleUpload, /api/media, /api/file keep the same status
   * mapping.
   */
  private _sendMediaResolveError(res: ServerResponse, fail: {
      reason: 'invalid-uid' | 'not-ready' | 'remote-host' | 'volume-missing' | 'ambiguous' | 'daemon-error'
      logCtx: Record<string, unknown>
    }, context: 'upload' | 'media' | 'file'): void {
    _sendMediaResolveErrorImpl.call(this as unknown as HttpMiscHandlersHost, res, fail, context)
  }

  /**
   * Verify an HS256 JWT signed by the commercial module's jwtSecret.
   * Synchronous (uses node:crypto) so we don't have to make checkHttpAuth /
   * getUserId async — those are called from many spots in this file and
   * propagating async would balloon the diff.
   *
   * Accepts payload shape: { sub: string, role: 'user'|'admin', iat, exp, jti }.
   * Returns null on any verification failure (bad alg, bad sig, expired,
   * malformed payload, or commercial module not loaded).
   */
  private verifyCommercialJwt(token: string): { sub: string; role: 'user' | 'admin'; exp: number } | null {
    return verifyCommercialJwtImpl.call(this as unknown as GatewayHttpHost, token)
  }

  /** Get userId stashed on a WS at handshake time. Falls back to 'default' if
   *  the WS was created before this field existed (hot-reload / legacy client). */
  private getWsUserId(ws: WebSocket): string {
    const uid = (ws as any)._userId
    return typeof uid === 'string' && uid.length > 0 ? uid : 'default'
  }

  /** Build a broadcast routing key. Historically `${channel}:${peerId}` only;
   *  userId dimension added 2026-04-19 so two users sharing a (client-generated,
   *  non-unique) peerId cannot receive each other's broadcasts. Individual
   *  clients are already scoped by userId via SQLite `client_sessions`, but
   *  WS-layer `clientsByPeer` wasn't — this closes that gap. */
  // Pure; lifted to module scope (FINDINGS §7.6 S4) so code moved out of the class can call it.
  private static makePeerKey = makePeerKey

  /** Check if the request arrived over HTTPS (direct TLS or behind a trusted reverse proxy like cloudflared).
   * X-Forwarded-Proto is only trusted when the connection originates from a loopback address (127.0.0.1 / ::1),
   * i.e. a local reverse proxy. External connections must use direct TLS.
   */
  private isHttps(req: IncomingMessage): boolean {
    return isHttpsImpl.call(this as unknown as GatewayHttpHost, req)
  }

  /** Session token lifetime — used for JWT issuance and legacy-mode cookie cap.
   *  Kept in one place so JWT TTL and cookie Max-Age can't drift. */
  private static readonly JWT_TTL_SECONDS = JWT_TTL_SECONDS // 30 days

  /** Set HttpOnly session cookie on response — stores the verified auth token so
   *  <img src="/api/file/...">, <audio>, <video> can access protected media on
   *  the same origin without JS-supplied headers.
   *
   *  Rules:
   *   - JWT mode: store the JWT verbatim (preserves userId); Max-Age tracks the
   *     JWT's remaining exp so the cookie can never outlive its token, avoiding
   *     silent 401 storms on subresource requests. Floored at 60s to avoid
   *     setting an already-dead cookie on the same response that just authed.
   *   - Legacy raw-token mode: store the raw accessToken; Max-Age capped at
   *     JWT_TTL_SECONDS since the raw token has no server-side revocation.
   *   - Otherwise (e.g. JWT just expired in the microsecond race between
   *     checkHttpAuth and here): refuse. We do NOT silently downgrade a JWT
   *     user's identity into the shared 'default' raw-token principal; caller
   *     sees `false` and returns 401 so the client can re-login cleanly.
   *
   *  Returns true if a cookie was set; false if the caller should 401. */
  private setSessionCookie(res: ServerResponse, req: IncomingMessage): boolean {
    return setSessionCookieImpl.call(this as unknown as GatewayHttpHost, res, req)
  }

  private sendJson(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  private sendSessionReadFailure(
    res: ServerResponse,
    error: unknown,
    sessionId: string,
    publicError: string,
  ): void {
    const requestId = randomBytes(8).toString('hex')
    const err = error instanceof Error ? error : new Error(String(error))
    this.log.error('session read failed', { sessionId, requestId, publicError }, err)
    this.sendJson(res, 500, { error: publicError, requestId })
  }
  private sendError(res: ServerResponse, code: number, message: string): void {
    this.sendJson(res, code, { error: message })
  }

  /**
   * 本地路径判定拒绝 → HTTP/结构化映射(模型权威 §3;**单一收口**,禁散落第二套映射)。
   *
   * 非本体系错误 → `undefined`(调用方原样上抛,不吞)。
   */
  private _mapLocalExecutionError(
    err: unknown,
  ): { code: LocalExecutionRejectCode; httpStatus: number; message: string } | undefined {
    const code = localExecutionRejectCode(err)
    if (!code) return undefined
    const detail = (err as Error)?.message ?? String(err)
    this.log.warn('local_execution_rejected', { code, detail })
    switch (code) {
      case 'DELEGATE_CODEX_UNSUPPORTED':
        // 409:显式 codex 意图 + 本地路径 = 语义冲突(不是"稍后重试"能解决的)。
        return {
          code,
          httpStatus: 409,
          message: `DELEGATE_CODEX_UNSUPPORTED: ${detail}`,
        }
      case 'MODEL_NOT_AVAILABLE':
        return { code, httpStatus: 403, message: `MODEL_NOT_AVAILABLE: ${detail}` }
      case 'MODEL_CATALOG_UNAVAILABLE':
        // 503:master 不可达/投影拉不到 —— 拒新 turn(无 baked 回落),可重试。
        return { code, httpStatus: 503, message: `MODEL_CATALOG_UNAVAILABLE: ${detail}` }
      case 'DELEGATE_MODEL_UNKNOWN':
        return { code, httpStatus: 400, message: `DELEGATE_MODEL_UNKNOWN: ${detail}` }
    }
  }
  /** 500 兜底收口:真实错误进日志(可排障),响应只回受控文案 —— 此前 39 处
   *  `sendError(res, 500, String(err))` 会把容器内部路径/栈回显给客户端。 */
  private sendInternalError(res: ServerResponse, err: unknown): void {
    this.log.error('internal error', undefined, err)
    this.sendJson(res, 500, { error: 'internal error' })
  }
  private async readJsonBody<T = any>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf-8')
    if (!raw) return {} as T
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error('invalid json body')
    }
  }

  /**
   * GET /api/file?path=<absolute> — fetch a file by absolute path (allowlisted).
   *
   * Used by the UI when an agent tool output references a file by absolute
   * path (e.g. uploaded image saved at /var/lib/docker/volumes/...).
   *
   * v3 commercial multi-tenant: the user-scoped allowlist predicate is
   * derived from `_resolveMediaDirs(userId)`, NOT from a global textual
   * predicate. This is what prevents user A from reading user B's docker
   * volume media by guessing/leaking absolute paths.
   *
   * Failure modes from the resolver are translated by `_sendMediaResolveError`
   * (not-ready → 503+Retry, etc.). For users with no active container,
   * /api/file silently degrades: still serves OPENCLAUDE_HOME / tmp / agent
   * cwd paths (no docker-volume access), so legacy assets keep working.
   */
  private handleApiFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleApiFileImpl.call(this as unknown as HttpMiscHandlersHost, req, res, url)
  }

  /**
   * GET /api/media/<filename> — fetch a previously uploaded or generated file.
   *
   * V3 multi-tenant: both uploads/ AND generated/ lookup are scoped to the
   * **caller's** per-user docker volume host path. Personal/legacy mode falls
   * back to paths.uploadsDir + paths.generatedDir.
   *
   * Note: closes the pre-existing IDOR — previously any authed user could
   * fetch any digest known to them via /api/media/<digest>.<ext>. Per-user
   * dir routing + user-scoped extraAllowed predicate now restricts cross-user
   * access for both uploads and codex image_gen output.
   */
  private handleMediaGet(req: IncomingMessage, res: ServerResponse, rawFilename: string): Promise<void> {
    return handleMediaGetImpl.call(this as unknown as HttpMiscHandlersHost, req, res, rawFilename)
  }

  /**
   * POST /api/uploads — streaming single-file upload (Plan B 2026-05-09).
   *
   * Body is the raw file bytes. Required headers:
   *   - Content-Type: claimed file MIME type (metadata only; all formats accepted)
   * Optional:
   *   - Content-Length: when present, used for early reject (saves bandwidth);
   *     when absent, streaming guard rejects mid-stream if bytes > MAX_UPLOAD_SINGLE.
   *   - X-Filename: URL-encoded original filename. Only its safe final extension may
   *     be used as a storage suffix when MIME has no canonical mapping.
   *
   * Response: 200 { url, digest, size, mimeType }
   * Errors: 400 / 413 (too large) / 500 (write failed)
   *
   * Storage: streams to `<uploadsDir>/.tmp-<random>` while computing sha256;
   * on success atomically renames to `<digest>.<ext>`. If a file with the
   * same digest already exists, dedups (tmp removed, existing path returned).
   */
  private handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleUploadImpl.call(this as unknown as HttpMiscHandlersHost, req, res)
  }

  // GET /api/agents         → { agents, default }
  // POST /api/agents        → create { id, model?, persona? }
  private handleAgentsCollection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleAgentsCollectionImpl.call(this as unknown as AgentHandlersHost, req, res)
  }

  // GET /api/agents/:id    → { agent }
  // PUT /api/agents/:id    → update model | persona
  // DELETE /api/agents/:id → remove (cannot remove default)
  private handleAgentItem(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    return handleAgentItemImpl.call(this as unknown as AgentHandlersHost, req, res, id)
  }

  // GET /api/agents/:id/persona  → { text }
  // PUT /api/agents/:id/persona  → { text }
  private handlePersona(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    return handlePersonaImpl.call(this as unknown as AgentHandlersHost, req, res, id)
  }

  // memdir 范式下的记忆读写面(单一权威在 storage 的 MemoryDir / userProfile):
  //   - target='user'  : GET/PUT 共享用户画像 user.md(单文本编辑,语义与结构不变)。
  //   - target='memory': GET 返回 MEMORY.md 索引 + 逐文件元信息(供 UI 渲染文件列表);
  //                       PUT → 410 gone(索引不再手写,由 reconcileIndex 自愈;
  //                       单条记忆改走 /memory/files/:file)。
  //
  // 单条记忆文件的 CRUD 在 handleMemoryFile(files/:file 子路由)。
  private handleMemory(req: IncomingMessage, res: ServerResponse, agentId: string, target: 'memory' | 'user'): Promise<void> {
    return handleMemoryImpl.call(this as unknown as AgentHandlersHost, req, res, agentId, target)
  }

  private handleMemoryUsage(req: IncomingMessage, res: ServerResponse, agentId: string, url: URL): Promise<void> {
    return handleMemoryUsageImpl.call(this as unknown as AgentHandlersHost, req, res, agentId, url)
  }

  // GET /api/agents/:id/auto-dream-report → sanitized latest result/progress.
  private handleAutoDreamReport(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    return handleAutoDreamReportImpl.call(this as unknown as AgentHandlersHost, req, res, agentId)
  }

  private handleAutoDreamOptimizer(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    return handleAutoDreamOptimizerImpl.call(this as unknown as AgentHandlersHost, req, res, agentId)
  }

  private handleAutoDreamOptimizerCancel(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    return handleAutoDreamOptimizerCancelImpl.call(this as unknown as AgentHandlersHost, req, res, agentId)
  }

  private handleAutoDreamOptimizerProposal(req: IncomingMessage, res: ServerResponse, agentId: string, proposalId: string, action: 'apply' | 'dismiss'): Promise<void> {
    return handleAutoDreamOptimizerProposalImpl.call(this as unknown as AgentHandlersHost, req, res, agentId, proposalId, action)
  }

  // GET    /api/agents/:id/memory/files/:file → { file, content, version } | 404
  // PUT    /api/agents/:id/memory/files/:file  body { content, version? } → { ok, version } | 409 | 400
  // DELETE /api/agents/:id/memory/files/:file → { ok } | 404
  //
  // 单条记忆文件的 CRUD。文件名双保险:路由已限 [^/],这里再过 MEMORY_FILE_RE(防 `..`
  // 及非法字符穿越)——「API 层拒绝非法名」是读侧安全权威之一(见设计契约§安全)。
  private handleMemoryFile(req: IncomingMessage, res: ServerResponse, agentId: string, file: string): Promise<void> {
    return handleMemoryFileImpl.call(this as unknown as AgentHandlersHost, req, res, agentId, file)
  }

  // GET /api/agents/:id/skills — list
  private handleSkillsList(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    return handleSkillsListImpl.call(this as unknown as SkillHandlersHost, req, res, agentId)
  }

  // GET/PUT/DELETE /api/agents/:id/skills/:name
  private handleSkillItem(req: IncomingMessage, res: ServerResponse, agentId: string, skillName: string): Promise<void> {
    return handleSkillItemImpl.call(this as unknown as SkillHandlersHost, req, res, agentId, skillName)
  }

  // GET /api/skills — user-level skill library list.
  // Aggregates shared + all agents' legacy + marketplace hub (NOT per-agent seed),
  // so a user sees one unified "my skills" library regardless of which agent is active.
  private handleUserSkillsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleUserSkillsListImpl.call(this as unknown as SkillHandlersHost, req, res)
  }

  private async syncMarketplaceHubForManagement(): Promise<void> {
    try {
      await syncMarketplaceHub({ timeoutMs: 4000 })
    } catch {
      /* fail-soft: management reads must still work if marketplace sync is unavailable */
    }
  }

  // PUT/DELETE /api/skills/:name/files — 技能目录内辅助文件的写/删(编辑器)。
  // 路径白名单 references/|assets/|evals/|scripts/,单文件≤64KB;evals.json 过 schema。
  private _handleUserSkillFiles(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleUserSkillFilesImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  // GET /api/skills/:name/history — 版本历史;POST /api/skills/:name/restore — 恢复。
  // 历史/恢复只覆盖 SKILL.md 正文(save() 快照机制),辅助文件不在快照范围。
  private _handleUserSkillHistory(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleUserSkillHistoryImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  private _handleUserSkillRestore(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleUserSkillRestoreImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  private validateSkillAgentScopeInput(input: unknown): Promise<string[] | { error: string }> {
    return validateSkillAgentScopeInputImpl.call(this as unknown as SkillHandlersHost, input)
  }

  // GET/PUT/DELETE /api/skills/:name — user-level skill item. Writes/deletes go to
  // the shared library (delete also sweeps same-named legacy residue across agents).
  private handleUserSkillItem(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return handleUserSkillItemImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  // ── Skill evals(评测:用例文件 CRUD + 隔离双跑 run)──────────────────────
  //
  // 成本纪律:评测跑真模型、消耗用户积分 —— 启动只经显式 POST(前端有估算+确认
  // 对话框),run.usage 逐 turn 累计供前端实报;用例上限(≤5)即成本上限。

  /** GET: evals 文件 + 上次结果;PUT: 保存 evals(仅可写技能)。 */
  private _handleSkillEvalsFile(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleSkillEvalsFileImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  /** POST /api/skills/:name/eval-run — 启动评测(202 → runId,进度轮询 status)。 */
  private _handleSkillEvalStart(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleSkillEvalStartImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  /** GET /api/skill-eval/:runId — run 状态(owner 校验,同训练 run 语义)。 */
  private _handleSkillEvalRunStatus(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    return _handleSkillEvalRunStatusImpl.call(this as unknown as SkillHandlersHost, req, res, runId)
  }

  // ── P1:AI 生成评测用例(异步 job + 轮询;不落库,只回草稿供编辑器审阅保存)──

  /**
   * POST /api/skills/:name/evals/generate — 启动一次 AI 生成 run(202 → runId)。
   *   404 = 技能不存在/平台技能(与训练同权威:includePlatform:false → 平台名解析为 null,
   *         避免 403/404 变成平台技能目录的存在性 oracle);
   *   403 = 技能存在但只读(hub/非自建;写不进且会被 sync 覆盖,生成无意义) —— 与 PUT evals
   *         的可写性门同一权威(store.view(...).writable);
   *   409 = 同技能已有生成 or 评测在跑(生成/评测互斥,避免并跑扰乱与重复扣费)。
   */
  private _handleSkillEvalGenStart(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleSkillEvalGenStartImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  /** GET /api/skill-eval-gen/:runId — 生成 run 状态(owner 校验,与评测 run 同语义)。 */
  private _handleSkillEvalGenStatus(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    return _handleSkillEvalGenStatusImpl.call(this as unknown as SkillHandlersHost, req, res, runId)
  }

  /** GET /api/v5/release-jobs/:id — hydrate the in-chat release card after refresh. */
  private _handleReleaseJobStatus(req: IncomingMessage, res: ServerResponse, id: string): void {
    _handleReleaseJobStatusImpl.call(this as unknown as SkillHandlersHost, req, res, id)
  }

  /**
   * 采集该技能近 30 天真实使用会话的摘录(sessionsDb FTS 既有导出,不 spawn CLI):
   * searchSessions 按 技能名+描述关键词 召回 → 30 天/排除评测训练自身通道过滤 →
   * loadSessionTurns 取每个会话 ≤1500 字符摘录,至多 5 段。任何 DB 异常都降级为空数组
   * (无素材 → 仅 SKILL.md 起草)。
   */
  private _collectGenSessionExcerpts(name: string, description: string): Promise<GenSessionExcerpt[]> {
    return _collectGenSessionExcerptsImpl.call(this as unknown as SkillTrainRunsHost, name, description)
  }

  /** 生成编排:采集素材 → 单个隔离 turn(deepseek,正常计费)→ 宽容解析+归一化+过格式权威。 */
  private _runSkillEvalGen(run: SkillEvalGenRun, input: { skillMd: string; description: string }): Promise<void> {
    return _runSkillEvalGenImpl.call(this as unknown as SkillHandlersHost, run, input)
  }

  /** 跑一个被测/评分 turn:一次性会话,收最终文本+用量,完了销毁会话释放资源。 */
  private _skillEvalTurn(sessionKey: string, userId: string, prompt: string, model: string, opts: SkillEvalTurnOpts): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }> {
    return _skillEvalTurnImpl.call(this as unknown as SkillHandlersHost, sessionKey, userId, prompt, model, opts)
  }

  private _loadAutoDreamAuditDataset(input: LoadAutoDreamAuditDatasetInput): Promise<AutoDreamAuditDataset> {
    return _loadAutoDreamAuditDatasetImpl.call(this as unknown as AgentHandlersHost, input)
  }

  private _runAutoDreamOptimizerModel(input: AutoDreamOptimizerModelRun, client: AutoDreamOptimizerClient): Promise<string> {
    return _runAutoDreamOptimizerModelImpl.call(this as unknown as AgentHandlersHost, input, client)
  }

  private _hydrateAutoDreamOptimizerProposals(input: HydrateAutoDreamOptimizerProposalsInput): Promise<AutoDreamOptimizerProposal[]> {
    return _hydrateAutoDreamOptimizerProposalsImpl.call(this as unknown as AgentHandlersHost, input)
  }

  private _applyAutoDreamOptimizerProposal(input: { agentId: string; proposal: AutoDreamOptimizerProposal }, client: AutoDreamOptimizerClient): Promise<{ ok: true; result?: string } | { ok: false; conflict: string }> {
    return _applyAutoDreamOptimizerProposalImpl.call(this as unknown as AgentHandlersHost, input, client)
  }

  /**
   * Auto-Dream paid turn: exact local catalog authority path, but a hermetic
   * CCB process (`--bare --tools "" --strict-mcp-config`) with no ambient
   * persona/repo/memory/skills/MCP/resume context.
   */
  private _runAutoDreamModel(input: AutoDreamModelRun): Promise<string> {
    return _runAutoDreamModelImpl.call(this as unknown as AgentHandlersHost, input)
  }

  /** 评测编排:逐 case 逐 arm 隔离跑 → 每 case 一个匿名 grader turn → benchmark。 */
  private _runSkillEval(run: SkillEvalRun, opts: { draftDir?: string }): Promise<void> {
    return _runSkillEvalImpl.call(this as unknown as SkillHandlersHost, run, opts)
  }

  // ── P3:技能每日自动回归(opt-in)────────────────────────────────────────
  private _skillRegressionTimer: ReturnType<typeof setInterval> | null = null

  private _startSkillAutoRegression(): void {
    _startSkillAutoRegressionImpl.call(this as unknown as SkillHandlersHost)
  }

  private _skillAutoRegressionTick(minGapMs: number): Promise<void> {
    return _skillAutoRegressionTickImpl.call(this as unknown as SkillHandlersHost, minGapMs)
  }

  // ── SkillOpt skill-training (async; train → diff → confirm-merge) ──

  /** The agent that runs training sessions (default 'main', else the first agent). */
  private _trainingAgent() {
    return _trainingAgentImpl.call(this as unknown as SkillTrainRunsHost)
  }

  /**
   * Resolve a run-scoped request: the run must exist AND be owned by the caller.
   * Sends 404/403 and returns null on failure. Every run-scoped endpoint (status,
   * drafts, diff, comment, merge, discard) gates on this so a leaked runId cannot be
   * read or mutated across users.
   */
  private _ownedTrainRun(req: IncomingMessage, res: ServerResponse, runId: string): SkillTrainRun | null {
    return _ownedTrainRunImpl.call(this as unknown as SkillTrainRunsHost, req, res, runId)
  }

  /**
   * Fold a training session's stream event into the run state. On the agent's `final`
   * event the terminal state is resolved from the ACTUAL staged-draft count (source of
   * truth), not the proposal-call count; other events flow through applyEvent.
   */
  private _onTrainEvent(runId: string, e: SessionStreamEvent): void {
    _onTrainEventImpl.call(this as unknown as SkillTrainRunsHost, runId, e)
  }

  /** 训练完成后的评测门:仅单技能训练 + autoEval + 有可用用例(草稿附带或技能自带)。 */
  private _maybeAutoEvalTrainRun(trainRunId: string): Promise<void> {
    return _maybeAutoEvalTrainRunImpl.call(this as unknown as SkillTrainRunsHost, trainRunId)
  }

  // POST /api/skills/:name/train — start an async DeepSeek training run for ONE
  // user-authored skill. Returns a runId immediately; progress via GET status.
  /**
   * 采集「用户对该技能差评过的真实场景」摘录(供技能训练注入失败案例小节):
   *  1) GET master skill-feedback?slug=&layer=user(容器 token 通道,已内建 fail-open);
   *  2) 有 refs → 按 sessionKey 从**本地** sessions.db 取 turns(复用 P1 buildSessionExcerpt
   *     裁成 ≤1500 字符摘录),至多 MAX_FEEDBACK_SCENARIOS 段。
   * 返回 `{scenarios, total}`:scenarios=实际注入的摘录;total=master 未截断的差评总数
   * (DISTINCT session_key,供前端"已找到 N 条"提示)。任何环节失败/无数据 → `{[], 0}`
   * (训练照常,不注入失败案例小节)。内容主权不出容器:master 只回引用,摘录本体由本地 DB 组装。
   */
  private _collectSkillFeedbackScenarios(skillName: string): Promise<{ scenarios: FeedbackScenario[]; total: number }> {
    return _collectSkillFeedbackScenariosImpl.call(this as unknown as SkillHandlersHost, skillName)
  }

  private _handleSkillTrainStart(req: IncomingMessage, res: ServerResponse, skillName: string): Promise<void> {
    return _handleSkillTrainStartImpl.call(this as unknown as SkillHandlersHost, req, res, skillName)
  }

  // GET /api/skill-training — 当前用户的训练 run 列表(startedAt 降序)。归属权威与
  // _ownedTrainRun 同一来源(getUserId):runId 不再只活在前端组件 state 里,刷新页面 /
  // gateway 重启后前端凭此找回 running(续轮询)或 diff_ready(续合并/修订)的 run。
  private _handleSkillTrainList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return _handleSkillTrainListImpl.call(this as unknown as SkillHandlersHost, req, res)
  }

  // GET /api/skill-training/:runId — run status. DELETE — discard run + its drafts.
  private _handleSkillTrainRun(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    return _handleSkillTrainRunImpl.call(this as unknown as SkillHandlersHost, req, res, runId)
  }

  // GET /api/skill-training/:runId/drafts — list staged draft summaries.
  private _handleSkillTrainDrafts(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    return _handleSkillTrainDraftsImpl.call(this as unknown as SkillHandlersHost, req, res, runId)
  }

  // GET /api/skill-training/:runId/drafts/:name — draft + current authoritative
  // (the two diff sides). PUT — apply a manual user edit to the draft.
  private _handleSkillTrainDraftItem(req: IncomingMessage, res: ServerResponse, runId: string, skillName: string): Promise<void> {
    return _handleSkillTrainDraftItemImpl.call(this as unknown as SkillHandlersHost, req, res, runId, skillName)
  }

  // POST /api/skill-training/:runId/drafts/:name/comment — user comment → AI revises
  // the draft by continuing the SAME training session (async; status returns to running).
  private _handleSkillTrainComment(req: IncomingMessage, res: ServerResponse, runId: string, skillName: string): Promise<void> {
    return _handleSkillTrainCommentImpl.call(this as unknown as SkillHandlersHost, req, res, runId, skillName)
  }

  // POST /api/skill-training/:runId/merge — promote draft(s) into the AUTHORITATIVE
  // library (the only write to live skills). Body {name?} merges one, else all.
  private _handleSkillTrainMerge(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    return _handleSkillTrainMergeImpl.call(this as unknown as SkillHandlersHost, req, res, runId)
  }

  // GET /api/search?q=... → full-text search past sessions
  // ── Inter-agent messaging ──
  private handleAgentMessage(req: IncomingMessage, res: ServerResponse, targetAgentId: string): Promise<void> {
    return handleAgentMessageImpl.call(this as unknown as AgentMessageHost, req, res, targetAgentId)
  }

  /** Active delegation count for recursion/concurrency limits */
  private _activeDelegations = 0
  /** Global concurrent cap. Thin wrapper over delegateCapacity.ts so env knobs
   *  stay call-time and server.ts does not hold a second copy of the literals. */
  private static get MAX_CONCURRENT_DELEGATIONS(): number {
    return getDelegateMaxConcurrent()
  }
  /** P2 债C/3.5 — 硬编排 review 保留槽. Source + env overlay: delegateCapacity.ts. */
  private static get DELEGATE_REVIEW_RESERVED_SLOTS(): number {
    return getDelegateReviewReservedSlots()
  }
  private _activeDelegationsByParent = new Map<string, Set<string>>()
  /** P2 债C/3.5 — 每父会话**运行中**(已过闸、占槽)的非 review 委派计数,per-parent 并发
   *  分桶的权威。区别于 _activeDelegationsByParent(那是含排队中的 childSessionKey Set,
   *  供 Stop 级联);本 Map 只在 slot 预占/释放时同步增减,是"运行中"的精确计数。
   *  测试脚手架 Object.create(Gateway.prototype) 不跑字段初始化,使用处惰性 ??=
   *  (同 _delegateQueueWaiters)。 */
  private _runningDelegationsByParent: Map<string, number> | undefined
  /** P2 债C — 本 turn 发生过**非隐藏**委派的父(队长)webchat sessionKey 集合。
   *  硬编排 review pass 据此判定"本 turn 是否实际组队"→ 决定队长 final 放行前是否触发审查。
   *  turn 起始清零(与 _hiddenDelegateGuard.resetForParent 同点),_runDelegateTask 里对
   *  非隐藏 + webchat 父的委派置位。使用处惰性 ??=(同上)。 */
  private _turnDelegatedNonHiddenByParent: Set<string> | undefined
  /** 2026-09-04 团队模式 — 委派 runId → 实际执行型号(有界 FIFO 512)。审查任务书据此给
   *  panel 成员标注视角型号;DurableAgentGroup 本身不带 model 字段,不改 wire 契约。 */
  private _delegateModelByRunId: Map<string, string> | undefined
  /** OCV5-180 B1 — 委派 runId → 冻结的 exact owner locator(launch 时快照)。
   *  完成收尾时按它判定:owner turn 未 seal → 内存缓冲随 owner tape;已 seal /
   *  owner 会话不在内存 → 持久晚到 continuation。有界 FIFO 512,使用处惰性 ??=
   *  (同 _delegateModelByRunId,prototype 脚手架兼容)。 */
  private _delegateOwnerByRunId: Map<string, DelegateOwnerTurnLocator> | undefined
  /** hidden 审查员串行委派熔断(见 PerTurnDelegationGuard 注释)。gateway 是容器内
   *  单进程,内存计数即权威。 */
  private _hiddenDelegateGuard = new PerTurnDelegationGuard()
  /** P2 批次4 — 普通成员(非 hidden 非 review)每 turn 委派上限,消"串行无上限"债。
   *  与 _hiddenDelegateGuard 同款按父会话计数、turn 边界复位(9863 同点),仅上限值
   *  不同(env OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN,默认 8)。测试脚手架
   *  Object.create(Gateway.prototype) 不跑字段初始化 → 使用处惰性 ??=(同 _delegateQueueWaiters)。 */
  private _memberDelegateGuard: PerTurnDelegationGuard | undefined
  /** 资源闸排队中的委派:childSessionKey → 中止等待回调。用户 Stop 级联
   *  (_interruptDelegationsForParent)对"还没 spawn、只在排队"的委派经此打断。
   *  测试脚手架 Object.create(Gateway.prototype) 不跑字段初始化,使用处惰性 ??=。 */
  private _delegateQueueWaiters: Map<string, () => void> | undefined
  /** Advisor consult AbortController keyed by child session. Stop during
   *  getOrCreate/submit must prevent a later submit on the aborted child. */
  private _advisorConsultAborts: Map<string, AbortController> | undefined
  /** 排队复查间隔;测试覆写加速,生产走 DELEGATE_QUEUE_POLL_DEFAULT_MS。 */
  private _delegateQueuePollMs: number | undefined
  /** SM queue wait clock; tests inject a fake monotonic source. */
  private _delegateMonotonicMs: (() => number) | undefined
  /** Cursor MCP 60s 上限的异步委派作业句柄。测试脚手架 Object.create 不跑字段
   *  初始化,使用处惰性 ??=。 */
  private _delegateJobs: DelegateJobStore | undefined
  private _advisorConsults: AdvisorConsultStore | undefined
  private _consultBillingHookBound: boolean | undefined
  private _consultBillingProjecting: boolean | undefined
  private _consultBillingRetryTimer: ReturnType<typeof setTimeout> | undefined
  private _consultBillingRetryMs: number | undefined
  private _advisorConsultWaitMs: number | undefined
  private _advisorConfig: AdvisorConfigStore | undefined
  /** Test seam for engine-reported delegate admit/settle/abandon. */
  private _delegateEngineBilling: DelegateEngineBillingClient | undefined
  /** Test seam: grok relay route mint(默认 grok-build 优先 → mint 失败回落 glm 的用例注入)。 */
  private _acquireDelegateGrokRoute: typeof acquireDelegateGrokRoute | undefined
  /** Test seam: skip the 60s idle-timeout floor so timeout/billing races are unit-testable. */
  private _delegateTimeoutConfig: DelegateTimeoutConfig | undefined
  /** Stage 1: durable boot reconciler has finished (or durable is off). */
  private _delegateReconcileReady = false
  private _delegateDurablePath: string | undefined
  private _delegateReconcileTimer: ReturnType<typeof setTimeout> | undefined
  /** OCV5-164 heartbeat-timeout reaper + ledger retention janitor. */
  private _delegateReapTimer: ReturnType<typeof setInterval> | undefined
  private _notifyRetryTimer: ReturnType<typeof setTimeout> | undefined
  private _engineNotifier: DefaultEngineNotifier | undefined
  /** R2 session-level inflight projection. Lazy; flag-off never opens the db. */
  private _delegateInflightSurface: DelegateInflightSurfaceStore | undefined

  private _ensureDelegateJobStore(): DelegateJobStore {
    return _ensureDelegateJobStoreImpl.call(this as unknown as DelegateRuntimeHost)
  }

  private _ensureDelegateInflightSurface(): DelegateInflightSurfaceStore {
    return _ensureDelegateInflightSurfaceImpl.call(this as unknown as DelegateSupervisionHost)
  }

  private _projectDelegateInflightFromJob(job: DelegateJobSnapshot): void {
    _projectDelegateInflightFromJobImpl.call(this as unknown as DelegateSupervisionHost, job)
  }

  private _forgetDelegateInflight(jobId: string): void {
    _forgetDelegateInflightImpl.call(this as unknown as DelegateSupervisionHost, jobId)
  }

  private _dropDelegateInflightSurface(jobId: string): void {
    _dropDelegateInflightSurfaceImpl.call(this as unknown as DelegateSupervisionHost, jobId)
  }

  private _touchDelegateInflightSurface(input: TouchDelegateInflightSurfaceInput): void {
    _touchDelegateInflightSurfaceImpl.call(this as unknown as DelegateSupervisionHost, input)
  }

  private _armDelegateReconcileFollowup(store: DelegateJobStore, queueWaitMs: number): void {
    _armDelegateReconcileFollowupImpl.call(this as unknown as DelegateSupervisionHost, store, queueWaitMs)
  }

  /**
   * OCV5-164: periodic heartbeat-timeout reaper + ledger retention janitor.
   *
   * The boot reconciler only judges `owner_lease_until`, and it defers
   * indefinitely while the parent session still holds a runner object — so a
   * row that stopped making progress never reaches a terminal state and keeps
   * occupying delegate capacity. This interval closes that hole using
   * `last_activity_at`, then interrupts the child so the ledger and the
   * subprocess agree.
   *
   * Scope note: for `kind=delegate` the interrupt also unwinds
   * `_runDelegateTaskCore`, whose `finally` releases the Grok relay lease.
   * `kind=cron` never mints such a lease, so reaping a cron row frees delegate
   * capacity — not a Grok slot.
   *
   * Fencing: `reapStaleRunning` skips rows a *live* other instance owns, so
   * running two masters cannot double-reap; retention pruning is idempotent.
   */
  private _armDelegateReaper(store: DelegateJobStore): void {
    _armDelegateReaperImpl.call(this as unknown as DelegateSupervisionHost, store)
  }

  private _delegateRunnerIdle(job: DelegateJobSnapshot): boolean {
    return _delegateRunnerIdleImpl.call(this as unknown as DelegateSupervisionHost, job)
  }

  private _delegateChildAlive(sessionKey: string | undefined): boolean | undefined {
    return _delegateChildAliveImpl.call(this as unknown as DelegateSupervisionHost, sessionKey)
  }

  private _resolveDelegateParentEngine(sessionKey?: string): ReturnType<typeof parseParentEngine> {
    return _resolveDelegateParentEngineImpl.call(this as unknown as DelegateRuntimeHost, sessionKey)
  }

  private _notifyDispatchHooks() {
    return _notifyDispatchHooksImpl.call(this as unknown as TurnDispatchHost)
  }

  private _ensureEngineNotifier(): DefaultEngineNotifier | undefined {
    return _ensureEngineNotifierImpl.call(this as unknown as GatewayLifecycleHost)
  }

  private _dispatchDelegateNotify(job: DelegateJobSnapshot): Promise<void> {
    return _dispatchDelegateNotifyImpl.call(this as unknown as DelegateCallbacksHost, job)
  }

  /**
   * Turn-end adoption of `delegate_task` background jobs.
   *
   * `delegate_task` rows are created as callback `stdout-wait`: the parent is
   * expected to long-poll `/api/delegate/wait`. When the parent turn ends
   * first (Cursor MCP 60s ceiling, model chose not to wait, user interrupted),
   * nothing ever wakes the parent — the sub-task finishes into the void.
   * Flip those rows to origin-inject so the EngineNotifier ResumeInject path
   * (same one `send_to_agent callbackOnComplete` uses) opens a fresh parent
   * turn on terminal. Consumed results (`/api/delegate/wait` returned
   * done/failed) are already skipped_silent and never match.
   *
   * Only webchat dm parents (ResumeInject target) and only when the notifier
   * side channel is effective; otherwise the flip would strand a pending row.
   */
  private _adoptOrphanedStdoutWaitDelegates(parentSessionKey: string | undefined, meta: { userId?: string; turnStartedAt?: number }): void {
    _adoptOrphanedStdoutWaitDelegatesImpl.call(this as unknown as DelegateCallbacksHost, parentSessionKey, meta)
  }

  private _retryDelegateNotifies(opts: { dueOnly?: boolean } = {}): Promise<void> {
    return _retryDelegateNotifiesImpl.call(this as unknown as DelegateCallbacksHost, opts)
  }

  /**
   * Notifier rolled back: Completer no longer consumes pending
   * cron-origin-inject rows. Drain them with the same dlgcb.* ResumeInject
   * path so BUSY leftovers are not stranded (review blocker 1 on→off).
   */
  private _drainFlagOffCronOriginNotifies(opts: { dueOnly?: boolean } = {}): Promise<void> {
    return _drainFlagOffCronOriginNotifiesImpl.call(this as unknown as CronTaskWebhookHost, opts)
  }

  private _armNotifyRetryScheduler(): void {
    _armNotifyRetrySchedulerImpl.call(this as unknown as GatewayLifecycleHost)
  }

  private readonly _activeSendToAgentCallbacks = new Map<string, {
    originSessionKey: string
    userId?: string
    agentId: string
    goal: string
  }>()
  private _syntheticTurnBarriers: Map<string, {
    owner: string
    done: Promise<void>
    release: () => void
  }> | undefined
  /** OCV5-435 — webchat turns between ws admission and settlement
   * (preStartStopKey → live dispatch count). Lazy for Object.create scaffolds. */
  private _admittedClientTurns: Map<string, number> | undefined
  /** HTTP/MCP delegate 续跑绑定。测试脚手架 Object.create 不跑字段初始化,使用处惰性 ??=。 */
  private _delegateResume: DelegateResumeRegistry | undefined

  /** 内存水位读取的实例挂钩:生产=模块级 readDelegateMemoryPressure(cgroup 文件),
   *  测试直接覆写本方法注入假读数。 */
  private _readDelegateMemoryPressure(): { current: number; max: number; ratio: number } | null {
    return _readDelegateMemoryPressureImpl.call(this as unknown as DelegateRuntimeHost)
  }

  /** 两道资源闸共用的判定。并发在前 —— 与历史行为的拒绝优先级一致
   *  (旧代码并发 429 判在内存 503 之前)。
   *
   *  P2 债C/3.5 — 分桶 + review 保留槽:
   *   - 全局:review 委派可用满 MAX;非 review 委派最多用到 MAX − 保留槽,给审查留位。
   *   - per-parent:非 review 委派按父分桶计数,单父超上限即 concurrency block(进排队);
   *     review 委派豁免此桶(它有独立保留槽,不受某父 fan-out 挤占)。
   *   缺 parentBucketKey(cron/webhook 父不在内存)→ 只受全局闸,不分桶(与既有行为一致)。 */
  private _checkDelegateResourceGate(opts?: CheckDelegateResourceGateOpts): DelegateGateBlock | null {
    return _checkDelegateResourceGateImpl.call(this as unknown as DelegateGuardHost, opts)
  }

  /** 预占一个并发名额(判定+自增在同一同步段,单线程下原子,等待者间无超发);
   *  被闸拦截则返回原因、不占名额。P2 债C:非 review + 有父桶 → 同步 bump per-parent 运行计数。 */
  private _tryReserveDelegateSlot(opts?: TryReserveDelegateSlotOpts): DelegateGateBlock | null {
    return _tryReserveDelegateSlotImpl.call(this as unknown as DelegateRuntimeHost, opts)
  }

  /** 释放一个已预占的并发名额(全局 + per-parent)。所有过闸后的路径必须经此释放,
   *  与 _tryReserveDelegateSlot 的增量口径严格对称(否则 per-parent 计数漂移锁死后续委派)。 */
  private _releaseDelegateSlot(opts?: ReleaseDelegateSlotOpts): void {
    _releaseDelegateSlotImpl.call(this as unknown as DelegateRuntimeHost, opts)
  }

  /**
   * delegate 资源闸有界排队:命中「并发 ≥ 上限」或「内存 ≥ 阈值」→ 轮询复查等待
   * 放行,而非立即 429/503(历史实况:并行 fanout 同秒双拒,队长收 503 后放弃委派
   * 自己兜底)。放行时已同步预占并发名额,调用方所有后续路径必须负责释放。
   *
   * 溯源:P5(f7453f4d)曾为旧重团队轨实现过"撞闸排队"(teamRunStore DB FIFO 队列),
   * 07-02 双轨清理(1ca107a8)删除旧 team_run 子系统时**连带**删除(非有意废弃)。
   * 本实现改为进程内等待收口:gateway 是容器内单进程,内存计数即权威,无需 DB 队列,
   * 且对所有 delegate(普通成员/hidden 审查员/嵌套)统一生效。
   *
   * 边界:
   * - 等待封顶 OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS(默认 90s)→ 'timeout';
   * - 排队人数封顶 DELEGATE_QUEUE_MAX_WAITERS(8,防雪崩)→ 'queue_full'(不等待);
   * - 用户 Stop 级联经 _delegateQueueWaiters 回调即时唤醒 → 'aborted';
   * - 无放行顺序保证(非 FIFO):等待者靠轮询抢占,依赖公平性的场景目前不存在。
   */
  private _waitForDelegateCapacity(args: WaitForDelegateCapacityArgs): Promise<
    WaitForDelegateCapacityResult
  > {
    return _waitForDelegateCapacityImpl.call(this as unknown as DelegateRuntimeHost, args)
  }

  /**
   * SM: undo whatever `_admitDelegateCreate` reserved for this input (running slot or
   * waiter entry) when `_runDelegateTaskCore` rejects BEFORE reaching the capacity gate
   * (depth / per-turn guard / agent not found / catalog reject / team-review 409 …).
   *
   * 2026-09-06 事故:这些早退路径原本不释放 → `_activeDelegations` 与 per-parent 计数
   * 只增不减(6 个 MODEL_CATALOG_UNAVAILABLE 拒绝 = 6 个幽灵槽位),随后所有委派
   * `too many concurrent delegations (in-use 7/7)` 等满 300s 后 429。
   * Idempotent:释放后清 flag,重复调用无副作用(与 gate 后的 finally 释放互斥)。
   */
  private _releasePreadmittedDelegateCapacity(input: RunDelegateInput): void {
    _releasePreadmittedDelegateCapacityImpl.call(this as unknown as DelegateRuntimeHost, input)
  }

  /**
   * SM: admit Enqueue and job create in one synchronous step.
   * 'slot' = already reserved a running slot; 'wait' = reserved a waiter; 'full' = no row.
   */
  private _admitDelegateCreate(sessionKey: string, opts: { parentBucketKey?: string; isReview?: boolean }): 'slot' | 'wait' | 'full' {
    return _admitDelegateCreateImpl.call(this as unknown as DelegateRuntimeHost, sessionKey, opts)
  }

  private _formatDelegateConcurrencyReject(opts: FormatDelegateConcurrencyRejectOpts): string {
    return _formatDelegateConcurrencyRejectImpl.call(this as unknown as DelegateGuardHost, opts)
  }

  /**
   * Capacity reject must not leave an executable job, and must not fail a job
   * that already lost the race to claimQueued. Single-threaded Map ops make
   * settle vs claim exclusive; this just chooses drop / fail / already-dispatched
   * on the production write path (not later in the async `.then`).
   */
  private _applyDelegateCapacityReject(input: RunDelegateInput, args: ApplyDelegateCapacityRejectArgs): DelegateTaskResult {
    return _applyDelegateCapacityRejectImpl.call(this as unknown as DelegateRuntimeHost, input, args)
  }

  /**
   * 解析委派进度路由:沿父链向上追溯到最近的 webchat 祖先会话(取代旧的「父非 webchat
   * 即 null」——那会让二级+嵌套委派的进度整段丢弃,一级卡长时间无进展)。
   *
   * 返回 `DelegateProgressRouting`:
   *   - `target` 与旧实现在**一级(直接 webchat 父)**场景下完全一致 → `.target` 即旧返回值;
   *   - `nested` / `firstLevelRunId` / `ancestorAgentPath` 供 handleDelegateTask 把嵌套进度以
   *     既有帧形态挂到用户可见的**一级**委派卡上(见 toNestedDelegateProgressLine)。
   *
   * 追溯纯逻辑在 resolveDelegateProgressRouting(delegateProgress.ts,可单测);本方法只做
   * SessionManager → 追溯所需最小会话视图的适配。断链/环/超深一律返回 null(丢弃,不抛错)。
   */
  private _resolveDelegateProgressTarget(args: ResolveDelegateProgressTargetArgs): DelegateProgressRouting | null {
    return _resolveDelegateProgressTargetImpl.call(this as unknown as DelegateRuntimeHost, args)
  }

  private _resolveDelegateParent(args: ResolveDelegateParentArgs): ResolveDelegateParentResult {
    return _resolveDelegateParentImpl.call(this as unknown as DelegateRuntimeHost, args)
  }

  private _registerActiveDelegation(parentSessionKey: string | undefined, childSessionKey: string): (() => void) | null {
    return _registerActiveDelegationImpl.call(this as unknown as DelegateGuardHost, parentSessionKey, childSessionKey)
  }

  /**
   * Reentrancy latch for `_markDelegateAncestorActivity`.
   * Delegate children bind `activity` → this method, so emitting on an
   * ancestor (which may itself be a delegate child) would otherwise re-enter
   * and re-walk the chain. Object.create(Gateway.prototype) test harnesses
   * skip field initializers; the boolean is treated as unset/false there.
   */
  private _markingDelegateAncestorActivity = false

  /**
   * A synchronous delegate_task keeps every ancestor runner blocked inside the
   * tool call. Raw child adapter activity is therefore real liveness for the
   * complete delegate subtree, even though it is not parent stdout. Refresh the
   * existing ancestor sessions only; a genuinely silent subtree still reaches
   * the normal idle watchdog.
   *
   * `lastActivityAt` feeds the 15-minute liveness watchdog. Emitting `activity`
   * is required as well: the 30-minute fallback timer only `refresh()`es on
   * that event. The latch above ensures one external trigger walks the chain
   * once (each ancestor emits at most once) and that a cyclic parent pointer
   * cannot stack-overflow.
   */
  private _markDelegateAncestorActivity(parentSessionKey: string | undefined): void {
    _markDelegateAncestorActivityImpl.call(this as unknown as DelegateRuntimeHost, parentSessionKey)
  }

  private _interruptDelegationsForParent(parentSessionKey: string, visited = new Set<string>()): boolean {
    return _interruptDelegationsForParentImpl.call(this as unknown as DelegateGuardHost, parentSessionKey, visited)
  }

  private advisorConsultStore(): AdvisorConsultStore {
    return advisorConsultStoreImpl.call(this as unknown as AdvisorHandlersHost)
  }

  private _ensureConsultBillingProjection(store: AdvisorConsultStore, billing: typeof defaultDelegateEngineBilling): void {
    _ensureConsultBillingProjectionImpl.call(this as unknown as AdvisorHandlersHost, store, billing)
  }

  private advisorConfigStore(): AdvisorConfigStore {
    return advisorConfigStoreImpl.call(this as unknown as AdvisorHandlersHost)
  }

  private _liveMainSessionForClient(sessionId: string, userId: string): AgentSession | undefined {
    return _liveMainSessionForClientImpl.call(this as unknown as DelegateGuardHost, sessionId, userId)
  }

  private _catalogEngineForModel(modelId: string | undefined): Promise<string | undefined> {
    return _catalogEngineForModelImpl.call(this as unknown as DelegateGuardHost, modelId)
  }

  private _loadClientSession(sessionId: string, userId: string) {
    return _loadClientSessionImpl.call(this as unknown as DelegateGuardHost, sessionId, userId)
  }

  private _parentEngineForCollabSession(input: ParentEngineForCollabSessionInput): Promise<{ missing: boolean; agentId?: string; engine?: string }> {
    return _parentEngineForCollabSessionImpl.call(this as unknown as DelegateGuardHost, input)
  }

  private _projectAdvisorConsultSettled(billing: { requestId?: string }): void {
    _projectAdvisorConsultSettledImpl.call(this as unknown as AdvisorHandlersHost, billing)
  }

  private _collaborationCapabilityFields(input: CollaborationCapabilityFieldsInput): Record<string, unknown> {
    return _collaborationCapabilityFieldsImpl.call(this as unknown as DelegateGuardHost, input)
  }

  private _consultWaitMs(): number {
    return _consultWaitMsImpl.call(this as unknown as DelegateGuardHost)
  }

  private _adviceFromConsult(record: AdviceFromConsultRecord): string {
    return _adviceFromConsultImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _consultJobFailedState(view: ConsultJobFailedStateView): 'failed' | 'cancelled' | null {
    return _consultJobFailedStateImpl.call(this as unknown as DelegateGuardHost, view)
  }

  private _advisorSessionKey(record: { originTurnKey: string; consultId: string }): string {
    return _advisorSessionKeyImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _consultStillLive(record: { originTurnKey: string; consultId: string; jobId?: string | null }): boolean {
    return _consultStillLiveImpl.call(this as unknown as DelegateGuardHost, record)
  }

  private _closeStaleConsult(record: import('./advisorConsultStore.js').AdvisorConsultRecord): import('./advisorConsultStore.js').AdvisorConsultRecord {
    return _closeStaleConsultImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _presentConsultBody(current: import('./advisorConsultStore.js').AdvisorConsultRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return _presentConsultBodyImpl.call(this as unknown as AdvisorHandlersHost, current, extra)
  }

  private _presentExistingConsult(input: PresentExistingConsultInput): Promise<{ status: number; body: Record<string, unknown> }> {
    return _presentExistingConsultImpl.call(this as unknown as AdvisorHandlersHost, input)
  }

  private _freezeAdvisorTurn(requested: string): Promise<{ ok: true; advisorModel: string } | { ok: false; error: string }> {
    return _freezeAdvisorTurnImpl.call(this as unknown as AdvisorHandlersHost, requested)
  }

  private _invocationFromLiveConsultTool(parent: InvocationFromLiveConsultToolParent): Promise<{ ok: true; invocationId: string } | { ok: false; reason: 'none' | 'ambiguous' }> {
    return _invocationFromLiveConsultToolImpl.call(this as unknown as AdvisorHandlersHost, parent)
  }

  private handleConsultAdvisor(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleConsultAdvisorImpl.call(this as unknown as AdvisorHandlersHost, req, res)
  }

  private _loadConsultHistoryTape(peerId: string, userId: string, turnKey: string) {
    return _loadConsultHistoryTapeImpl.call(this as unknown as AdvisorHandlersHost, peerId, userId, turnKey)
  }

  private _resolveAdvisorConsultExecution(advisorModel: string): Promise<
    ResolveAdvisorConsultExecutionResult
  > {
    return _resolveAdvisorConsultExecutionImpl.call(this as unknown as AdvisorHandlersHost, advisorModel)
  }

  private _spawnCcbAdvisorConsult(input: SpawnCcbAdvisorConsultInput): Promise<SpawnCcbAdvisorConsultResult> {
    return _spawnCcbAdvisorConsultImpl.call(this as unknown as AdvisorHandlersHost, input)
  }

  private _advisorConsultRouteOverride(route: AdvisorAdmitRouteOk, model: string): import('./engine/codexShared.js').CodexProviderConfigOverride | null {
    return _advisorConsultRouteOverrideImpl.call(this as unknown as AdvisorHandlersHost, route, model)
  }

  private _spawnAdvisorConsult(input: SpawnAdvisorConsultInput): Promise<SpawnAdvisorConsultResult> {
    return _spawnAdvisorConsultImpl.call(this as unknown as AdvisorHandlersHost, input)
  }

  private handleCollaborationConfig(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleCollaborationConfigImpl.call(this as unknown as HttpMiscHandlersHost, req, res, url)
  }

  private handleDelegateTask(req: IncomingMessage, res: ServerResponse, targetAgentId: string): Promise<void> {
    return handleDelegateTaskImpl.call(this as unknown as DelegateRuntimeHost, req, res, targetAgentId)
  }

  private _delegateResultToHttp(result: DelegateTaskResult, targetAgentId: string): DelegateJobHttpResult {
    return _delegateResultToHttpImpl.call(this as unknown as DelegateRuntimeHost, result, targetAgentId)
  }

  private handleDelegateWait(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleDelegateWaitImpl.call(this as unknown as DelegateRuntimeHost, req, res)
  }

  /**
   * P2 债C — handleDelegateTask 的 HTTP-无关委派执行核心。
   *
   * 承接原 handleDelegateTask 的全部执行逻辑(深度/熔断/资源闸有界排队/session 创建/
   * submit/timeout/进度回传/团队卡缓冲),但以结构化 {@link RunDelegateInput} 入、
   * {@link DelegateTaskResult} 出,不碰 req/res。两个调用方:
   *   1. handleDelegateTask —— HTTP 委派端点(队长/成员经 delegate_task MCP 工具);
   *   2. dispatchInbound 的硬编排 review pass —— 队长 final 放行前直调,isReview:true。
   *
   * `isReview` 语义:走资源闸保留槽 + 免 per-parent 桶(审查不受某父 fan-out 挤占);
   * runLog 打 isReview;完成后从审查输出解析结构化 verdict 一并回带 + 落团队卡。
   */
  private _forgetEvictedDelegateResumes(keys: string[]): void {
    _forgetEvictedDelegateResumesImpl.call(this as unknown as DelegateSupervisionHost, keys)
  }

  private _completeDelegateResumeClaim(input: RunDelegateInput, sessionSpawned: boolean): Promise<void> {
    return _completeDelegateResumeClaimImpl.call(this as unknown as DelegateSupervisionHost, input, sessionSpawned)
  }

  private _runDelegateTask(input: RunDelegateInput): Promise<DelegateTaskResult> {
    return _runDelegateTaskImpl.call(this as unknown as DelegateRuntimeHost, input)
  }

  private _runDelegateTaskCore(input: RunDelegateInput, hooks?: { onSessionSpawned?: () => void }): Promise<DelegateTaskResult> {
    return _runDelegateTaskCoreImpl.call(this as unknown as DelegateRuntimeHost, input, hooks)
  }

  /**
   * taskboard 巡检的 delegate 适配器。同进程直调 _runDelegateTask,才能拿到
   * timedOut;sessionKey / channel 走巡检专用形状,不进主会话列表。
   */
  private _runTaskboardDelegate(input: import('./taskboard/patrol.js').PatrolDelegateInput): Promise<import('./taskboard/patrol.js').PatrolDelegateResult> {
    return _runTaskboardDelegateImpl.call(this as unknown as DelegateRuntimeHost, input)
  }


  private _handleWebhook(req: IncomingMessage, res: ServerResponse, whId: string): Promise<void> {
    return _handleWebhookImpl.call(this as unknown as CronTaskWebhookHost, req, res, whId)
  }

  private _handleWechat(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    return _handleWechatImpl.call(this as unknown as ChannelHandlersHost, req, res, pathname)
  }

  private _handleTasksApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return _handleTasksApiImpl.call(this as unknown as CronTaskWebhookHost, req, res)
  }

  private _handleTaskItem(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void> {
    return _handleTaskItemImpl.call(this as unknown as CronTaskWebhookHost, req, res, taskId)
  }

  /** Check schedule-triggered tasks and fire if cron matches */
  private _tickScheduledTasks(): Promise<void> {
    return _tickScheduledTasksImpl.call(this as unknown as GatewayLifecycleHost)
  }

  /** Trigger a task by ID (shared by schedule tick, webhook, and manual API) */
  private _triggerTask(taskId: string): Promise<void> {
    return _triggerTaskImpl.call(this as unknown as CronTaskWebhookHost, taskId)
  }

  private handleSearch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleSearchImpl.call(this as unknown as HttpMiscHandlersHost, req, res, url)
  }

  /**
   * Stage 2: EngineNotifier ResumeInject for cron-origin-inject. Uses the
   * same persist+dispatch path as Completer origin-session fire, with
   * dlgcb.{jobId}.{epoch} as the message id.
   */
  private injectCronOriginFromTerminal(event: JobTerminal): Promise<CronOriginFireResult> {
    return injectCronOriginFromTerminalImpl.call(this as unknown as CronTaskWebhookHost, event)
  }

  private injectCronOriginSession(job: CronJob, delivery: CronDeliveryContext, override?: { text?: string; clientMessageId?: string; idempotencyKey?: string }): Promise<CronOriginFireResult> {
    return injectCronOriginSessionImpl.call(this as unknown as CronTaskWebhookHost, job, delivery, override)
  }

  private _acquireSyntheticTurnBarrier(sessionKey: string): Promise<AcquireSyntheticTurnBarrierResult> {
    return _acquireSyntheticTurnBarrierImpl.call(this as unknown as TurnDispatchHost, sessionKey)
  }

  private _persistSendToAgentIntent(intent: SendToAgentIntent): Promise<void> {
    return _persistSendToAgentIntentImpl.call(this as unknown as DelegateCallbacksHost, intent)
  }

  private _deliverInterruptedSendToAgentIntent(intent: SendToAgentIntent): Promise<boolean> {
    return _deliverInterruptedSendToAgentIntentImpl.call(this as unknown as DelegateCallbacksHost, intent)
  }

  private _persistAndCloseDelegateJobs(): Promise<void> {
    return _persistAndCloseDelegateJobsImpl.call(this as unknown as DelegateSupervisionHost)
  }

  private _persistInterruptedSendToAgentCallbacks(): Promise<void> {
    return _persistInterruptedSendToAgentCallbacksImpl.call(this as unknown as DelegateCallbacksHost)
  }

  private _ensureDurableSendToAgentCallback(job: DelegateJobSnapshot, intent: SendToAgentIntent): Promise<boolean> {
    return _ensureDurableSendToAgentCallbackImpl.call(this as unknown as DelegateCallbacksHost, job, intent)
  }

  private handleCcbLocalAgentNotification(session: { sessionKey: string; userId?: string; _activeTurnCount?: number; _activeClientTurnCount?: number }, payload: CcbLocalAgentNotification): void {
    handleCcbLocalAgentNotificationImpl.call(this as unknown as DelegateCallbacksHost, session, payload)
  }

  private handleCcbLocalAgentDelivered(sessionKey: string, taskId: string): void {
    handleCcbLocalAgentDeliveredImpl.call(this as unknown as DelegateCallbacksHost, sessionKey, taskId)
  }

  private flushCcbLocalAgentPendingOnFinalize(session: { sessionKey: string; userId?: string }): void {
    flushCcbLocalAgentPendingOnFinalizeImpl.call(this as unknown as DelegateCallbacksHost, session)
  }

  private queueCcbLocalAgentInject(sessionKey: string, payload: CcbLocalAgentNotification, userId?: string): void {
    queueCcbLocalAgentInjectImpl.call(this as unknown as DelegateCallbacksHost, sessionKey, payload, userId)
  }

  /**
   * Origin-inject a CCB local-agent completion after the parent turn is
   * idle and no mid-turn delivered ack arrived. Retries with the same
   * bounded backoff as send_to_agent. Parent CCB process already dead
   * is not covered.
   */
  private injectCcbLocalAgentCallback(args: InjectCcbLocalAgentCallbackArgs): Promise<CronOriginFireResult> {
    return injectCcbLocalAgentCallbackImpl.call(this as unknown as DelegateCallbacksHost, args)
  }

  private tryCcbLocalAgentCallbackDispatch(args: {
    origin: { sessionKey: string; agentId: string; channel: 'webchat'; peerKind: 'dm'; peerId: string }
    userId: string
    text: string
    clientMessageId: string
    taskId: string
    sessionKey: string
    barrierOwner?: string
    onQueued?: () => void
  }): Promise<CronOriginFireResult> {
    return tryCcbLocalAgentCallbackDispatchImpl.call(this as unknown as DelegateCallbacksHost, args)
  }

  private _queueSendToAgentCallback(runInput: RunDelegateInput, args: { jobId: string; agentId: string; goal: string; output?: string; error?: string }): void {
    _queueSendToAgentCallbackImpl.call(this as unknown as DelegateCallbacksHost, runInput, args)
  }

  /**
   * send_to_agent 完成后注入父 webchat：等父 turn 不在飞，再写 user 行并
   * dispatchInbound 新开父 turn。不走 lastActiveChannel 的 📨 WS 旁路。
   */
  private injectSendToAgentCallback(args: InjectSendToAgentCallbackArgs): Promise<CronOriginFireResult> {
    return injectSendToAgentCallbackImpl.call(this as unknown as DelegateCallbacksHost, args)
  }

  private trySendToAgentCallbackDispatch(args: {
    origin: { sessionKey: string; agentId: string; channel: 'webchat'; peerKind: 'dm'; peerId: string }
    userId: string
    text: string
    clientMessageId: string
    jobId: string
    barrierOwner?: string
    onQueued?: () => void
  }): Promise<CronOriginFireResult> {
    return trySendToAgentCallbackDispatchImpl.call(this as unknown as DelegateCallbacksHost, args)
  }

  private _sendToAgentCallbackTurnAlreadyQueued(args: SendToAgentCallbackTurnAlreadyQueuedArgs): Promise<boolean> {
    return _sendToAgentCallbackTurnAlreadyQueuedImpl.call(this as unknown as DelegateCallbacksHost, args)
  }

  // ── Cron/Reminder API handlers ──
  private cronProjectPorts(): CronProjectPorts {
    return cronProjectPortsImpl.call(this as unknown as CronTaskWebhookHost)
  }

  private stampCronProject(parsed: { projectMode?: unknown; boardProjectId?: unknown }, originPeerId?: string): Promise<{ projectMode: 'follow_session' | 'fixed'; boardProjectId: string | null } | { error: string }> {
    return stampCronProjectImpl.call(this as unknown as CronTaskWebhookHost, parsed, originPeerId)
  }

  private handleCronChannels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleCronChannelsImpl.call(this as unknown as CronTaskWebhookHost, req, res)
  }

  private handleCronApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleCronApiImpl.call(this as unknown as CronTaskWebhookHost, req, res)
  }

  private handleCronItem(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    return handleCronItemImpl.call(this as unknown as CronTaskWebhookHost, req, res, id)
  }

  // ── Claude.ai OAuth PKCE Flow ──
  private oauthPending = new Map<
    string,
    { codeVerifier: string; createdAt: number; provider: string }
  >()

  // Multi-provider OAuth configs
  private readonly OAUTH_PROVIDERS: Record<
    string,
    {
      clientId: string
      authUrl: string
      tokenUrl: string
      redirect: string
      scopes: string
      extraParams?: Record<string, string>
    }
  > = {
    claude: {
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authUrl: 'https://claude.com/cai/oauth/authorize',
      tokenUrl: 'https://platform.claude.com/v1/oauth/token',
      redirect: 'https://platform.claude.com/oauth/code/callback',
      scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    },
  }

  private handleOAuthStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleOAuthStartImpl.call(this as unknown as HttpMiscHandlersHost, req, res)
  }

  private handleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleOAuthCallbackImpl.call(this as unknown as HttpMiscHandlersHost, req, res)
  }

  // Token auto-refresh (called periodically and on-demand after 401).
  // Dedup: concurrent calls share one in-flight refresh to avoid stampede.
  // If a non-forced refresh is in-flight and a forced one is requested,
  // we chain the forced refresh after the current one completes.
  private _refreshPromise: Promise<void> | null = null
  private _refreshForced = false

  private refreshClaudeOAuthIfNeeded(force = false): Promise<void> {
    return refreshClaudeOAuthIfNeededImpl.call(this as unknown as HttpMiscHandlersHost, force)
  }

  private async _refreshClaudeOAuthImpl(force: boolean): Promise<void> {
    // Refresh threshold: 15 min before expiry (was 5 min). v3 plan A9 — wider
    // window so per-user containers reading the bind-mounted container
    // auth.json see the new access_token before the old one expires
    // mid-turn. Combined with the 10-min periodic timer this gives 5–15 min
    // of lead time.
    const REFRESH_LEAD_MS = 15 * 60_000
    const claudeOAuth = this.deps.config.auth.claudeOAuth
    if (claudeOAuth?.refreshToken && (force || Date.now() >= claudeOAuth.expiresAt - REFRESH_LEAD_MS)) {
      await this._refreshToken('claude', claudeOAuth)
    }
  }

  private _refreshToken(providerKey: string, oauth: { refreshToken: string; scope: string; expiresAt: number }): Promise<void> {
    return _refreshTokenImpl.call(this as unknown as GatewayHttpHost, providerKey, oauth)
  }

  private readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
    return readBodyImpl.call(this as unknown as GatewayHttpHost, req, maxBytes)
  }

  private wsClients = new Set<WebSocket>()
  /** Wire-private goal snapshots are trusted only on the authenticated master
   * bridge connection. Programmatic/direct dispatch callers cannot forge it. */
  private trustedGoalFrames = new WeakSet<object>()

  /**
   * 消费一条 bridge inbound.message 上的模型执行权威(方案 §2)。
   *
   * @returns true = 放行(descriptor 已挂载 / 本地路径无需 authority);
   *          false = **拒帧**(已回 error 帧,调用方必须 return,不得 dispatch)
   *
   * 真值表(fail-closed 优先):
   *   | 来源      | 帧带 envelope | 容器能验签 | required | 结果                    |
   *   |-----------|---------------|-----------|----------|-------------------------|
   *   | 本地 WS   | —             | —         | —        | 放行(baked 判定,零变化)|
   *   | bridge    | 否            | —         | 否       | 放行(flag 未开的旧行为) |
   *   | bridge    | 否            | —         | **是**   | **拒**(flag 开 = 必须带)|
   *   | bridge    | 是            | 否        | —        | **拒**(验不了就不许信)  |
   *   | bridge    | 是            | 是        | —        | 验签 + 全断言,过 → 挂载 |
   *
   * 「带 envelope 但容器验不了签」为什么必须拒而不是回落 baked:master 已按 descriptor
   * 完成计费编排(codex 预扣 / journal),容器若改用自己的 baked 判定跑,就是**计费与执行
   * 分裂**。宁可拒帧让用户重发(桥会把这类容器 recycle 掉)。
   */
  private _consumeFrameAuthority(ws: WebSocket, frame: Record<string, unknown>, isFromBridge: boolean): boolean {
    return _consumeFrameAuthorityImpl.call(this as unknown as WsConnectionHost, ws, frame, isFromBridge)
  }

  private _rejectAuthority(ws: WebSocket, code: string, detail: string): void {
    _rejectAuthorityImpl.call(this as unknown as TurnDispatchHost, ws, code, detail)
  }

  /**
   * RFC-v5-durable-turn-dispatch §3 — durable inbox boot recovery 编排。
   *
   * 注入三个 dep 到协议实现(recoverTurnDispatchInboxOnBoot):本地 retry queue 查同
   * dispatch、master 三态查询、synthetic crashed tape staging(走同一 retry queue,
   * 确定性 payload 来自 inbox 持久化字段)。
   */
  private _recoverTurnDispatchInbox(queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue): Promise<void> {
    return _recoverTurnDispatchInboxImpl.call(this as unknown as GatewayLifecycleHost, queue)
  }

  /**
   * RFC-v5-durable-turn-dispatch §B4/§B5 — recovery 单飞一轮(boot 首跑 + 周期共用)。
   *
   * single-flight 门闩 `_turnDispatchRecoveryInFlight` 防重入(boot 与周期、周期各轮之间)。
   * 成功跑完一轮 → 置 `_durableTurnDispatchReady`(B5:即便 boot 首跑曾失败,某轮周期成功即自愈)。
   * 检查+置位同步发生(await 前),JS 单线程下并发调用第二个必早退,无竞态。
   */
  private _runTurnDispatchRecoverySweep(queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue): Promise<void> {
    return _runTurnDispatchRecoverySweepImpl.call(this as unknown as GatewayLifecycleHost, queue)
  }

  /**
   * RFC-v5-durable-turn-dispatch §B4 — 周期 single-flight recovery 重试。
   *
   * boot 首跑只处理"启动瞬间"的 open 行;不可达(recovery_pending)/瞬时写失败留下的
   * 未终局行需要周期重试才能最终收敛(I1 永不静默)。每 60s 一轮:先看是否存在 open 行
   * (无 → 跳过,不空扫),再走单飞 sweep。timer unref 不挡进程退出;shutdown 里清。
   */
  private _startTurnDispatchRecoveryLoop(queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue): void {
    _startTurnDispatchRecoveryLoopImpl.call(this as unknown as GatewayLifecycleHost, queue)
  }

  /**
   * RFC-v5-durable-turn-dispatch §3.b — 已有 inbox 行时回执给 bridge。
   *
   * bridge 据此 CAS accepted(dispatch 已被容器受理执行,不再开第二条 IIFE)。控制帧,
   * bridge 拦截消费,**绝不**透传给浏览器(同 container_attest)。
   */
  private _sendTurnDispatchReceipt(ws: WebSocket, ctx: DispatchTurnContext, row: Awaited<ReturnType<typeof admitTurnDispatch>>['row']): void {
    _sendTurnDispatchReceiptImpl.call(this as unknown as TurnDispatchHost, ws, ctx, row)
  }

  /**
   * RFC-v5-durable-turn-dispatch §3 — 消费 webchat-DM inbound.message 的 dispatch 票据。
   *
   * 返回值 = 是否放行本帧继续处理(caller:`if (!_consumeDispatchAuthority(...)) return` 丢帧)。
   *
   * 无票据 no-op → legacy(return true):非 bridge 连接 / 非 webchat-DM / 不带 __oc_dispatch /
   * dispatchAuthority 未 enabled —— 一律放行走 legacy(不建 inbox 行,现状语义)。census 100% 前
   * 混跑期,没有 dispatch 追踪的 turn 行为等同今天。
   *
   * **带票据但消费失败 = fail-closed 拒帧(return false)**:一旦帧带 __oc_dispatch 且各前置门
   * 满足,验签/断言任一失败(配置漂移 / keyring 不符 / 篡改)都**拒帧**,绝不回落 legacy 执行 ——
   * master 已同事务建 dispatch,legacy 跑完真 tape = 与 reconciler 的 tombstone 双终态分裂。拒帧后
   * master reconciler 走 reject-if-absent → not_accepted → 用户可见失败(I1/I2 双保)。仅告警,不回内文。
   *
   * 验签+全断言通过 → descriptor 挂 WeakMap(dispatchInbound 据此走 durable 准入),return true。
   */
  private _consumeDispatchAuthority(ws: WebSocket, frame: Record<string, unknown>, isFromBridge: boolean): boolean {
    return _consumeDispatchAuthorityImpl.call(this as unknown as TurnDispatchHost, ws, frame, isFromBridge)
  }

  // ───────── WS ─────────
  private handleWsConnection(ws: WebSocket, req: IncomingMessage): void {
    handleWsConnectionImpl.call(this as unknown as WsConnectionHost, ws, req)
  }

  /**
   * Phase 4 — 校验 sessionId 在该 ws 的注册集合或最近 hello peers(grace window)。
   * 三种 outcome:
   *   - 'authorized':立即处理
   *   - 'queued':入 pending,等 hello/message 注册
   *   - 'rejected':硬拒(sessionId 不合法)
   */
  private _checkRepoBindSession(ws: WebSocket, sessionId: string): 'authorized' | 'queued' {
    return _checkRepoBindSessionImpl.call(this as unknown as SessionRepoBindingHost, ws, sessionId)
  }

  /** Phase 4 — bind 帧处理 */
  private _handleSessionRepoBind(ws: WebSocket, frame: SessionRepoBindFrame): Promise<void> {
    return _handleSessionRepoBindImpl.call(this as unknown as SessionRepoBindingHost, ws, frame)
  }

  /**
   * Phase 5:bind status 回调统一 wrapper。两个路径共用(立即处理 / pending flush)。
   * 顺序:先 forward 给 ws → 再读 _repoWorkspace 当前 snapshot 触发 recycle。
   * 单进程下 status callback 是 _repoWorkspace 短锁内 commit 后才调,
   * getRepoSnapshot 此时已是最新值,recycle 决策按最新 snapshot 走。
   */
  private _buildStatusCallback(ws: WebSocket, sessionId: string): (frame: SessionRepoStatusOut) => void {
    return _buildStatusCallbackImpl.call(this as unknown as TurnDispatchHost, ws, sessionId)
  }

  /**
   * Phase 4 — unbind 帧处理(Phase 5 加版本化)。
   *
   * 顺序(关键):
   *   1. _repoWorkspace.unbind(sessionId, version)  短锁内 state.delete
   *      → 之后 getRepoSnapshot 返 null
   *   2. recyclePeerForRepoUnbind(sessionId)        进 session.lock,shutdown runner
   *      → 排队的 submit 拿到 lock 时读 null snapshot,addDir 回 agentBaseDir
   *
   * 没有 selectionVersion 的 unbind 帧:rejected(理论不该发生,前端必带版本号;
   * 没版本的话 workspaceMgr 的 tombstone-too-old 保护就失效)。
   */
  private _handleSessionRepoUnbind(ws: WebSocket, frame: { sessionId: string; selectionVersion?: number }): Promise<void> {
    return _handleSessionRepoUnbindImpl.call(this as unknown as SessionRepoBindingHost, ws, frame)
  }

  /** Phase 4 — hello 到达后,看 pending 队列里有没有匹配的 bind 可以处理 */
  private _flushPendingRepoBinds(ws: WebSocket, peerIds: Set<string>): void {
    _flushPendingRepoBindsImpl.call(this as unknown as SessionRepoBindingHost, ws, peerIds)
  }

  /** Phase 4 — send outbound.control.session_repo_status to a single ws,容错 closed/error。 */
  private _sendStatusFrame(ws: WebSocket, frame: SessionRepoStatusOut): void {
    _sendStatusFrameImpl.call(this as unknown as WsConnectionHost, ws, frame)
  }

  /** OCV5-435 — a webchat turn counts as admitted from ws dispatch until it
   * settles, so a Stop that beats its engine run still binds to this turn. */
  private _dispatchAdmittedClientTurn(frame: InboundFrame): Promise<void> {
    return _dispatchAdmittedClientTurnImpl.call(this as unknown as TurnDispatchHost, frame)
  }

  private handleStop(frame: HandleStopFrame): Promise<boolean> {
    return handleStopImpl.call(this as unknown as WsConnectionHost, frame)
  }

  /** Handle permission approval/denial from the web frontend */
  private handlePermissionResponse(frame: HandlePermissionResponseFrame): Promise<void> {
    return handlePermissionResponseImpl.call(this as unknown as AskUserPermissionsHost, frame)
  }

  /** Broadcast a settlement event to all WS clients at a peerKey.
   *  `answers` is only set for AskUserQuestion allow settlements — lets
   *  other tabs render the collected answers in the permission card, and
   *  lets the sender tab keep its optimistic state in sync if we later
   *  switch semantics (e.g. if answers get server-side post-processing). */
  private _broadcastPermissionSettled(peerKey: string, payload: BroadcastPermissionSettledPayload): void {
    _broadcastPermissionSettledImpl.call(this as unknown as AskUserPermissionsHost, peerKey, payload)
  }

  /** Send a session-scoped wire frame to all WS clients at a peerKey, stamping
   *  it with `frameSeq` + `ts` and storing it in `_outboundRing` so a later
   *  `autoResumeFromHello` reconnect can replay it. WS-only equivalent of
   *  `deliver()` for non-message frames (permission_request / permission_settled).
   *  Adapter dispatch is not applicable — these frames are interactive-only.
   *
   *  When `sessionKey` is empty (legacy fallback path with no server-side
   *  pending entry to look up), we skip ring storage and only broadcast — the
   *  same `else` branch deliver() uses for frames without a sessionKey. */
  private _sendStampedSessionFrame(sessionKey: string, peerKey: string, wireFrame: Record<string, unknown>): void {
    _sendStampedSessionFrameImpl.call(this as unknown as WsConnectionHost, sessionKey, peerKey, wireFrame)
  }

  private _promptQueueContext(userId: string, peerId: string, agentId: string): PromptQueueSessionContext {
    return _promptQueueContextImpl.call(this as unknown as PromptQueueDispatchHost, userId, peerId, agentId)
  }

  private _registerPromptQueueClient(ws: WebSocket, context: PromptQueueSessionContext): void {
    _registerPromptQueueClientImpl.call(this as unknown as PromptQueueDispatchHost, ws, context)
  }

  /** If commercial preparation already reserved a slot/precheck/journal but
   * the gateway cannot consume the exact grant, tell that same trusted bridge
   * to unwind immediately. The bridge validates every original correlation
   * field before applying compensation, so a malformed/forged marker is inert. */
  private _sendPromptQueueGrantCancellation(ws: WebSocket, context: PromptQueueSessionContext, markerValue: unknown, reasonCode: string): boolean {
    return _sendPromptQueueGrantCancellationImpl.call(this as unknown as PromptQueueDispatchHost, ws, context, markerValue, reasonCode)
  }

  private _broadcastPromptQueueSnapshot(context: PromptQueueSessionContext, snapshot: import('@openclaude/protocol').PromptQueueSnapshot): void {
    _broadcastPromptQueueSnapshotImpl.call(this as unknown as PromptQueueDispatchHost, context, snapshot)
  }

  private _sendPromptQueueSnapshotToClient(_context: PromptQueueSessionContext, ws: WebSocket, snapshot: import('@openclaude/protocol').PromptQueueSnapshot): void {
    _sendPromptQueueSnapshotToClientImpl.call(this as unknown as PromptQueueDispatchHost, _context, ws, snapshot)
  }

  private _sendPromptQueueDispatch(context: PromptQueueSessionContext, frame: PromptQueueDispatchRequest): boolean {
    return _sendPromptQueueDispatchImpl.call(this as unknown as PromptQueueDispatchHost, context, frame)
  }

  /** Record an authoritative settlement for later replay to late duplicates.
   *  `answers` is carried so that a 3rd tab hitting the already-settled
   *  replay path still sees the collected AskUserQuestion answers. */
  private _recordSettlement(requestId: string, entry: RecordSettlementEntry): void {
    _recordSettlementImpl.call(this as unknown as TurnDispatchHost, requestId, entry)
  }

  /** Look up a recent settlement, honoring TTL (returns null if expired). */
  private _lookupSettlement(requestId: string): LookupSettlementResult {
    return _lookupSettlementImpl.call(this as unknown as TurnDispatchHost, requestId)
  }

  /** Shared auto-deny + settle + broadcast for one pending permission entry.
   *  Used by disconnect / timeout / session-crash paths. Safe to call on
   *  sessions that no longer exist — the runner-response step silently
   *  skips in that case (the subprocess is already gone). */
  /**
   * Cursor ask_user: persist the question on the session tape, then wait up
   * to `waitMs` for an in-turn answer. Omitting waitMs (legacy clients) is
   * treated as 0 — fully detached, immediate posted. Explicit values are
   * clamped to 55s, under the 60s MCP tools/call wall. On timeout / client
   * abort the waiter releases to the existing detached path (later allow →
   * dispatchInbound). If tryAnswer already won but the HTTP response can no
   * longer be written, the consumed answer is compensated through that same
   * dispatchInbound path so it cannot vanish. The HTTP response is always
   * produced by the waiter timer or a terminal claim — it cannot hang past waitMs.
   */
  private handleEngineAskUser(req: IncomingMessage, res: ServerResponse, targetAgentId: string): Promise<void> {
    return handleEngineAskUserImpl.call(this as unknown as AskUserPermissionsHost, req, res, targetAgentId)
  }

  /**
   * Deliver an in-window ask_user answer over HTTP, or compensate with the
   * same dispatchInbound path used after timeout. `tryClaimDelivery` is the
   * synchronous one-shot so HTTP success and compensation cannot both fire.
   */
  private _finishInWindowAskUserWait(args: FinishInWindowAskUserWaitArgs): Promise<void> {
    return _finishInWindowAskUserWaitImpl.call(this as unknown as AskUserPermissionsHost, args)
  }

  /**
   * In-window answer could not be written back to the MCP HTTP caller.
   * Reuse the timeout-then-answer path: tape user-answer row + dispatchInbound.
   */
  private _compensateInWindowAskUserAnswer(pending: CompensateInWindowAskUserAnswerPending, requestId: string, answer: AskUserWaiterAnswer): Promise<void> {
    return _compensateInWindowAskUserAnswerImpl.call(this as unknown as AskUserPermissionsHost, pending, requestId, answer)
  }

  private _persistDetachedAskUserCard(args: PersistDetachedAskUserCardArgs): Promise<void> {
    return _persistDetachedAskUserCardImpl.call(this as unknown as AskUserPermissionsHost, args)
  }

  private _patchDetachedAskUserResolved(pending: PatchDetachedAskUserResolvedPending, requestId: string, patch: Record<string, unknown>, userAnswer?: { id: string; text: string; ts?: number }): Promise<void> {
    return _patchDetachedAskUserResolvedImpl.call(this as unknown as AskUserPermissionsHost, pending, requestId, patch, userAnswer)
  }

  private _loadDetachedAskUserCard(sessionId: string, userId: string, requestId: string): Promise<Record<string, unknown> | null> {
    return _loadDetachedAskUserCardImpl.call(this as unknown as AskUserPermissionsHost, sessionId, userId, requestId)
  }

  private _hydrateDetachedAskUserPending(frame: HydrateDetachedAskUserPendingFrame): Promise<ReturnType<typeof pendingFromDetachedAskUserMessage>> {
    return _hydrateDetachedAskUserPendingImpl.call(this as unknown as AskUserPermissionsHost, frame)
  }

  private async _submitDetachedAskUserAnswer(pending: SubmitDetachedAskUserAnswerPending, text: string, requestId: string, clientMessageId: string = buildDetachedAskUserAnswerMessageId(requestId)): Promise<void> {
    return _submitDetachedAskUserAnswerImpl.call(this as unknown as AskUserPermissionsHost, pending, text, requestId, clientMessageId)
  }

  private _forceDenyPendingPermission(requestId: string, reason: 'disconnect' | 'timeout' | 'crashed' | 'user_stop', denyMessage: string): boolean {
    return _forceDenyPendingPermissionImpl.call(this as unknown as AskUserPermissionsHost, requestId, reason, denyMessage)
  }

  /**
   * Reap ordinary pending permission requests after a session crash so the
   * map does not leak and connected tabs dismiss their stuck modal.
   *
   * Detached ask_user cards are the exception: they are not bound to the
   * subprocess lifetime. The card stays answerable for 24h even after crash,
   * turn end, or session eviction; the user's answer is delivered as a later
   * inbound message (possibly to a new session). Same contract as
   * `_autoDenyPendingPermissions` and `_sweepStalePendingPermissions`.
   */
  private _reapCrashedSessionPendingPermissions(sessionKey: string): void {
    _reapCrashedSessionPendingPermissionsImpl.call(this as unknown as AskUserPermissionsHost, sessionKey)
  }

  /**
   * Settle pending permission requests for a turn the user just stopped.
   *
   * `interruptClientTurn` / `sessions.interrupt` only abort the CCB turn; the
   * `_pendingPermissions` entry created for a blocking `can_use_tool` (incl.
   * AskUserQuestion) otherwise survives until the 10-minute janitor. During
   * that window every hello replays the dead card to the browser (which
   * renders it read-only since the turn is no longer `sending`) and the
   * durable master row stays `pending` until the reconciler runs. Force-deny
   * here so the runtime map, the master row and every connected tab converge
   * on the same `user_stop` settlement the moment Stop is acknowledged.
   *
   * Detached ask_user cards are exempt (same contract as crash/disconnect/
   * sweep): they outlive the turn by design and are answered later as a new
   * inbound message.
   *
   * When `clientMessageId` is given, only entries owned by that browser turn
   * are settled (entries recorded without a clientMessageId are assumed to
   * belong to the stopped turn — the runtime never holds two blocking
   * permissions for different turns of one session at once). Returns the
   * number of settled requests.
   */
  private _settlePendingPermissionsForStop(sessionKey: string, clientMessageId?: string): number {
    return _settlePendingPermissionsForStopImpl.call(this as unknown as AskUserPermissionsHost, sessionKey, clientMessageId)
  }

  /** Auto-deny all pending permission requests associated with a peerKey (on disconnect) */
  private _autoDenyPendingPermissions(peerKey: string): void {
    _autoDenyPendingPermissionsImpl.call(this as unknown as AskUserPermissionsHost, peerKey)
  }

  /** Periodic janitor: auto-deny permissions whose wait has exceeded the TTL.
   *  Also cleans up entries whose session no longer exists (subprocess was
   *  evicted or destroyed without going through the crash event path). */
  private _sweepStalePendingPermissions(): void {
    _sweepStalePendingPermissionsImpl.call(this as unknown as AskUserPermissionsHost)
  }

  /** Pre-warm webchat sessions on boot so they respond instantly to the first user message */
  private bootAutoResume(): Promise<void> {
    return bootAutoResumeImpl.call(this as unknown as GatewayLifecycleHost)
  }

  /**
   * GET /api/sessions/:id 成功(full 与 ?since= 两条 200 路径)后的 fire-and-forget
   * 引擎预热(INC-20260824-FIRST-TEXT-LATENCY;gate: OC_ENGINE_PREHEAT=1,默认关)。
   *
   * 选中会话必打这条 GET(useSessionList.selectSession → loadHistory),粒度恰好是
   * "用户正在看的那一个会话" —— 明确不挂 bootAutoResume / 全量 hello(那两处是
   * 全量扇出,spawn 会打满内存/fork)。agentId/modelId 取自本次已读出的
   * client_sessions 权威行;执行授权走 prewarm 投影,失败即跳过,不绕 fail-closed。
   */
  /** session-open 预热去抖戳。`.call(fake)` 测试路径下可能缺省,惰性建。 */
  private _sessionOpenPreheatAt = new Map<string, number>()

  private _preheatSessionOnOpen(sessId: string, userId: string, row: { agentId?: string; modelId?: string }): void {
    _preheatSessionOnOpenImpl.call(this as unknown as AgentMessageHost, sessId, userId, row)
  }

  /**
   * POST /internal/v3/engine-preheat。先 200 再异步 spawn:master POST 3s 超时
   * 不能卡在 CCB ~20s 冷启动上。失败只 warn,不再写响应。
   */
  private handleEnginePreheat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleEnginePreheatImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  private autoResumeFromHello(peers: AutoResumeFromHelloPeers, ws: WebSocket): Promise<void> {
    return autoResumeFromHelloImpl.call(this as unknown as WsConnectionHost, peers, ws)
  }

  private dispatchInbound(frame: InboundFrame, adapter?: ChannelAdapter): Promise<void> {
    return dispatchInboundImpl.call(this as unknown as InboundDispatchHost, frame, adapter)
  }

  private _sendAdapterOutboundMessage(out: OutboundMessage, adapter: ChannelAdapter): Promise<void> {
    return _sendAdapterOutboundMessageImpl.call(this as unknown as AgentMessageHost, out, adapter)
  }

  /**
   * Outbound frame egress — WS broadcast + outboundRing + optional adapter fan-out.
   *
   * 入参 union 反映协议演化:历史上只发 OutboundMessage,后续加了 OutboundError /
   * OutboundCodexBilling / OutboundTurnStatus(后两个是 sideband:不带 .blocks,
   * adapter (Telegram / 微信) 假设的 OutboundMessage 形状)。union 起来后:
   *   - sideband type literal 比较 (`wire.type === 'outbound.turn_status'`) 合法
   *   - caller 不再需要 `as unknown as OutboundMessage` 强转(那是协议演化债,
   *     现在统一清掉,deliver 类型签名直接承认所有合法 deliverable shape)
   *
   * 内部访问的只是 `.type / .channel / .peer / .sessionKey`,这些字段在 union 的
   * 四个成员上都有(交集字段),所以 narrowing 不需要,直接读即可。
   */
  private deliver(out:
      DeliverOut, adapter?: ChannelAdapter): void {
    deliverImpl.call(this as unknown as WsConnectionHost, out, adapter)
  }
}

/** Known project roots that agents may work in (intentionally empty — broad source dirs removed) */
const AGENT_CWD_ROOTS: string[] = []

/**
 * Validate a parsed `wechat-inbound-compensate` body. Caller is responsible
 * for `JSON.parse` + body-size cap upstream — this function only deals with
 * a `unknown` value that resulted from successful parse.
 *
 * Error strings are stable: `handleWechatInboundCompensate` returns them
 * verbatim to the broker, so changing wording is a contract change.
 */

export const SESSION_OPEN_PREHEAT_DEBOUNCE_MS = 30_000

export function hasContainerCatalogEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim() && env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim(),
  )
}

// 活跃内容 MIME 集合 + inline 判定已收敛到 @openclaude/protocol 的单一权威(批D D5)。
// shouldServeInline 在文件顶部从 protocol import 供本模块内部使用;此处 re-export 保持
// 既有 import 路径(如 security.test.ts `import { shouldServeInline } from '../server.js'`)不变。
// (原 ACTIVE_CONTENT_TYPES 集合与未被引用的 isActiveContentType 一并移入 protocol。)
export { shouldServeInline }

// 便捷工厂
export async function createGateway(opts?: { webRoot?: string }): Promise<Gateway> {
  const config = await readConfig()
  if (!config) throw new Error('Run `openclaude onboard` first to create config.')
  const agentsConfig = await readAgentsConfig()
  return new Gateway({ config, agentsConfig, webRoot: opts?.webRoot })
}
