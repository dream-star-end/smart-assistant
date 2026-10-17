import { fetchIdentityCompatProjection, resolveRuntimeExecutionAgent } from '@openclaude/storage'
import { handleChatProjectsHttp } from './routes/chatProjects.js'
import type { GatewayHttpIo } from './routes/httpIo.js'
// Moved with its only caller; re-exported for existing importers.
export { _buildHealthzDeps } from './routes/system.js'
import { PRE_AUTH_ROUTES, type PreAuthRoutesIo } from './routes/preAuth.js'
import { PLATFORM_ROUTES, type PlatformRoutesIo } from './routes/platform.js'
import { SYSTEM_ROUTES, type SystemRoutesIo } from './routes/system.js'
import { APP_CONFIG_ROUTES, type AppConfigRoutesIo } from './routes/appConfig.js'
import { AGENT_ROUTES, type AgentRoutesIo } from './routes/agents.js'
import { WORKSPACE_API_ROUTES, type WorkspaceApiRoutesIo } from './routes/workspaceApi.js'
import { dispatchRoutes } from './routes/routeTable.js'
import {
  type ClientSessionsHttpIo,
  clientSessionIsActive,
  handleClientSessionsHttp,
} from './routes/clientSessions.js'
// Moved with the client session routes; re-exported for existing importers.
export {
  _parseHistoryRevisionCursor,
  filterUserVisibleLiveSessions,
  _parseArchiveQuery,
  _immutableRecordIdHeaders,
} from './routes/clientSessions.js'
import { handleProjectAssetsHttp } from './routes/projectAssets.js'
import { saveUserSkill } from './userSkillWrite.js'
import { resolveIdentityCompat, assertIdentityCompatReady } from '@openclaude/protocol'
import { readServerFeatures } from '@openclaude/protocol'
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import {
  constants as fsConstants,
  chmodSync,
  chownSync,
  closeSync,
  createWriteStream,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlink,
  unlinkSync,
} from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import { isOutpaintAspect, normalizeImageEditMask, type OutpaintAspect, orientedImageDimensions, outpaintTargetDimensions } from './imageEdit.js'
import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import {
  type InboundFrame,
  type InboundMessage,
  type OutboundCodexBilling,
  type OutboundExternalEngineBilling,
  type OutboundCallUsage,
  type OutboundError,
  type OutboundMessage,
  type OutboundTurnStatus,
  type OutboundTurnUsage,
  type SysContextRebuilt,
  type Peer,
  type AgentGroupStatus,
  type DurableAgentGroup,
  type DurableCodexBilling,
  type DurableGoalUsageRecord,
  type GoalStateSnapshot,
  type DurableRuntimeEvent,
  type ReviewVerdict,
  REVIEW_VERDICT_PASS,
  REVIEW_VERDICT_NEEDS_FIX,
  newTraceId,
  parseSessionWorkspaceMode,
  parseTraceIdCandidate,
  STATIC_KEY_INBOUND_MODEL_IDS,
  CODEX_ENGINE_MODEL_IDS,
  GROK_ENGINE_MODEL_IDS,
  CURSOR_ENGINE_MODEL_IDS,
  ZCODE_ENGINE_MODEL_IDS,
  PLATFORM_REASONING_EFFORTS,
  AGENT_MODEL_AUTO,
  ADVISOR_AGENT_ID,
  normalizeCollabMode,
  collabConfigVersionOf,
  MAX_ATTACHMENTS_PER_MESSAGE,
  AUTOMATIC_TURN_RETRY_MAX,
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  isCodexEngineModel,
  isGrokEngineModel,
  isCursorEngineModel,
  isZcodeEngineModel,
  isAntigravityEngineModel,
  isClientMessageId,
  isDisplayableServerMessage,
  isPersistedClientMessageId,
  turnErrorSemantics,
  formatMessageReplyPrompt,
  normalizeMessageReplyQuote,
  shouldServeInline,
  stripDispatchAuthorityField,
  isLiveUnitsEnabled,
  type PromptQueueMutationFrame,
  TURN_CANCEL_IF_QUEUED_PATH,
} from '@openclaude/protocol'
import {
  failureClassFromLocalExecutionCode,
  isDelegateTerminalState,
  type DelegateFailureClass,
  type JobTerminal,
} from '@openclaude/protocol'
import {
  delegateConcurrencyCap,
  formatDelegateConcurrencyReject,
  getDelegateMaxConcurrent,
  getDelegateReviewReservedSlots,
} from './delegateCapacity.js'
import {
  classifiedMessageForCode,
  classifyDelegateOutputError,
  classifyRunError,
} from './errorClassify.js'
import { parseCreditBudgetFen } from './creditExhaustion.js'
import {
  CONSULT_INVOCATION_HEADER,
  DELEGATE_CONTEXT_HEADER,
  hashConsultTurnToken,
  inspectConsultTurnToken,
  verifyDelegateContextToken,
} from './delegateContext.js'
import { checkLocalBridge, isHealthzFileProxyReady } from './localBridgeAuth.js'
import { resolveGatewayListen } from './gatewayBind.js'
import { resolveOpenedPath } from './openedPath.js'
import {
  hasResolvedPrefix,
  isPathStrictlyUnder,
  isPathWithinRoot,
  openclaudeTempPrefix,
  trustedContainerHome,
} from './pathAcl.js'
import { defaultReleaseJobDir, isReleaseJobId, publicReleaseJob, readReleaseJob } from './releaseJobStore.js'
import { ContainerPreviewHandler } from './containerPreview.js'
import {
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  PROMPT_QUEUE_GRANT_FIELD,
  PromptQueueCoordinator,
  type PromptQueueDispatchRequest,
  type PromptQueueDispatchCancel,
  type PromptQueueDispatchControl,
  type PromptQueueSessionContext,
  type PromptQueueTurnLifecycle,
} from './promptQueueCoordinator.js'
import type { AgentSession, PromptQueueExecutionFence } from './sessionManager.js'
import { resolveChatRunWorkspace } from './projectWorkspace.js'
import { createRunContextDescriptor, webchatRunId } from './runContextPersist.js'
import {
  HttpPromptQueueClient,
  readPromptQueueClientConfig,
} from './promptQueueClient.js'
// 合成首帧降级兜底模型的 routable 自检(MAJOR-1):兜底模型在当前进程形态下不可路由
// (host 无对应平台静态 key)时**不降级**,保持 CODEX_BILLING_GUARD fail-closed。
import { isHostRoutableStaticModel } from './hostStaticProviders.js'
import {
  parseSkillEvalsJson,
  serializeSkillEvals,
  type SkillEvalCase,
  type SkillEvalsFile,
  type AgentDef,
  type AgentsConfig,
  MemoryDir,
  MEMORY_FILE_RE,
  readUserProfile,
  writeUserProfile,
  type OpenClaudeConfig,
  SkillStore,
  SkillDraftStore,
  TaskStore,
  buildAgentSkillStore,
  buildUserSkillStore,
  parseFrontmatter,
  validateSkillAgentScope,
  paths,
  readAgentsConfig,
  readConfig,
  searchSessions,
  loadSessionTurns,
  loadSessionEvents,
  loadSessionUsage,
  listAutoDreamAuditSessions,
  listAutoDreamSuccessfulSessionsBetween,
  getMemoryUsageDashboard,
  recordMemoryUsageEvent,
  syncMarketplaceHub,
  updateAgentsConfig,
  isMarketplacePersonaTarget,
  writeConfig,
  getUsageSummary,
  queryEvents,
  listClientSessions,
  classifyClientSessions,
  getClientSession,
  getClientSessionPartial,
  readArchivedMessages,
  readClientSessionLiveFrames,
  readClientSessionLiveUnits,
  readLiveOrTapeFramePayload,
  readClientTimelinePage,
  encodeClientTimelineCursor,
  decodeClientTimelineCursor,
  ClientTimelineCursorStaleError,
  listTurnTapeRecords,
  readTapeRecordPayloadChunk,
  readUserMessagePayload,
  upsertClientSession,
  appendServerAuthoredMessage,
  appendServerAuthoredMessageDurable,
  patchServerAuthoredMessage,
  deleteClientSession,
  patchClientSessionMeta,
  searchClientSessions,
  batchClientSessions,
  markClientSessionRead,
  markAllClientSessionsRead,
  parseSessionBatchInput,
  parseIncludeArchivedFlag,
  parseOptionalPositiveInt,
  SESSION_SEARCH_Q_MAX,
  SESSION_SEARCH_LIMIT_DEFAULT,
  SESSION_SEARCH_LIMIT_MAX,
  SESSION_LIST_LIMIT_MAX,
  recordAutoDreamSuccessfulSession,
  listUnclaimedSessions,
  claimSession,
  probeSessionsDb,
  countRuntimeRecycleUnsafeTurnDispatches,
  turnDispatchInboxStats,
} from '@openclaude/storage'
import {
  DETACHED_ASK_USER_TTL_MS,
  agentIdFromAskUserSessionKey,
  buildDetachedAskUserAnswerMessageId,
  buildDetachedAskUserAnsweredResult,
  buildDetachedAskUserPersistMessage,
  buildDetachedAskUserPostedResult,
  buildDetachedAskUserResolvedSinkPayload,
  buildDetachedAskUserSinkPayload,
  buildDetachedAskUserSkippedResult,
  findDetachedAskUserCardInMessages,
  formatAskUserAnswerMessage,
  isDetachedAskUserPending,
  isDetachedAskUserRequestId,
  type pendingFromDetachedAskUserMessage,
} from './detachedAskUser.js'
import {
  type AskUserWaiter,
  askUserHttpUnwritable,
  askUserHttpWriteSucceeded,
  resolveAskUserWaitMs,
  type AskUserWaiterAnswer,
} from './askUserWaiter.js'
import { fetchAskUserPermissionCard, getV3MasterSinkOrNull, readV3MasterSinkConfig } from './v3MasterSink.js'
import {
  filterUserVisibleAgentsForManagement,
  filterUserVisibleByAgentField,
  filterUserVisibleRoutesForManagement,
  isHiddenSystemAgentId,
  isTeamReviewExecution,
  userVisibleDefaultAgentId,
} from './agentVisibility.js'
import { listCollaboratorAgents } from './collaboratorAgents.js'
import {
  advisorPreamble,
  advisorExecutionFromSnapshotJson,
  type buildAdvisorSnapshot,
  collectAuthorizedArtifacts,
  formatAdvisorConsultPrompt,
  ADVISOR_CONSULT_PARENT_ENGINES,
  ADVISOR_CONSULT_PARENT_REASON,
  advisorConsultParentGate,
  advisorCanonicalModelId,
  assertAdvisorModelAllowed,
  CCB_ADVISOR_PROFILE_VERSION,
  coerceHistoryMessages,
  historyFromSessionMessages,
  isAdvisorConsultParentEngine,
  isAdvisorEngineOpen,
  uniquePendingConsultInvocationId,
  isCcbAdvisorModelProven,
  listProvenAdvisorModels,
  matchConsultIdentity,
  openAdvisorEngines,
  parentAuthorizedArtifactTexts,
  stripAdvisorPreambleFromInjected,
  type AdvisorConsultExecution,
} from './advisorMode.js'
import { type AdvisorConsultStore, hashEvidence, mintConsultId } from './advisorConsultStore.js'
import {
  type AdvisorConfigStore,
  CollaborationConfigError,
  resolveSessionCollab,
} from './advisorConfigStore.js'
import type {
  GatewayEngineErrorEvent,
  GatewayStreamEvent,
  GatewayTerminalErrorCode,
  GatewayTurnPhase,
  SessionStreamEvent,
  TurnRetryMeta,
} from './ccbMessageParser.js'
import { type SkillTrainRun, SkillTrainJobStore } from './skillTrainJobs.js'
import {
  type SkillEvalRun,
  SkillEvalJobStore,
  armsForMode,
} from './skillEvalJobs.js'
import {
  type GraderArmInput,
  type SkillEvalCaseResult,
  addUsage,
  buildEvalCasePrompt,
  buildGraderPrompt,
  computeBenchmark,
  emptyUsage,
  gradesToAssertions,
  parseGraderJson,
} from './skillEval.js'
import { SkillEvalGenJobStore, type SkillEvalGenRun } from './skillEvalGenJobs.js'
import {
  MAX_SESSION_EXCERPTS,
  SESSION_EXCERPT_MAX_CHARS,
  buildGeneratePrompt,
  buildGenerationNote,
  buildSessionExcerpt,
  buildSessionSearchQuery,
  finalizeGeneratedCases,
  selectUsageSessionHits,
  type GenSessionExcerpt,
} from './skillEvalGen.js'
import {
  MAX_FEEDBACK_SCENARIOS,
  SKILL_TRAIN_DEFAULT_MODEL,
  SKILL_TRAIN_EFFORT,
  buildFeedbackScenariosSection,
  buildSkillTrainPrompt,
  normalizeSkillTrainArgs,
  type FeedbackScenario,
} from './skillTrain.js'
import { WebSocket, WebSocketServer } from 'ws'
import { checkToken, verifyPassword, signJwt, verifyJwt, type JwtPayload } from './auth.js'
import {
  CronScheduler,
  backfillCronOccurrenceDelegateJobs,
  type CronDeliveryContext,
  type CronJob,
} from './cron.js'
import { listCronDeliverChannels } from './cronChannels.js'
import { deliverCronOutput, type CronDeliverDeps } from './cronDeliver.js'
import {
  deriveFixedBoardProjectId,
  filterCronJobsForBoard,
  type CronProjectPorts,
} from './cronProject.js'
import {
  buildCronOriginResumeText,
  cronOriginClientMessageId,
  cronOriginIdempotencyKey,
  decideCronOriginDispatchAfterPersist,
  parseOriginWebchatSessionKey,
  resolveCronOriginInjectPayload,
  type CronOriginFireResult,
} from './cronOriginSession.js'
import { getProject } from './taskboard/db/projects.js'
import {
  buildSendToAgentCallbackText,
  callbackPayloadFromDurableJob,
  decideCallbackDispatchAfterPersist,
  isSendToAgentCallbackComplete,
  sendToAgentCallbackClientMessageId,
  sendToAgentCallbackIdempotencyKey,
} from './sendToAgentCallback.js'
import {
  abandonCcbLocalAgentInject,
  ackCcbTaskNotificationDelivered,
  beginCcbLocalAgentInject,
  buildCcbLocalAgentCallbackText,
  ccbLocalAgentCallbackClientMessageId,
  ccbLocalAgentCallbackIdempotencyKey,
  clearCcbLocalAgentPendingForSession,
  completeCcbLocalAgentInject,
  evaluateCcbLocalAgentInjectLimit,
  failCcbLocalAgentInject,
  getCcbLocalAgentCallbackState,
  finalizeCcbLocalAgentPendingInjections,
  noteCcbLocalAgentFinalizeRoundExhausted,
  noteCcbTaskNotification,
  noteForegroundBashToolResult,
  sessionHasInFlightTurn,
  type CcbLocalAgentNotification,
} from './ccbLocalAgentCallback.js'
import { runBoundedOriginInjectBackoff } from './originInjectBackoff.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
  removeSendToAgentIntent,
  type SendToAgentIntent,
} from './sendToAgentIntentStore.js'
import {
  postCronOriginInject,
  readV3CronOriginInjectConfig,
} from './v3CronOriginInject.js'
import { handleTaskboardApi, resolveTaskboardActor, setPatrolExecutionHandler } from './taskboard/http.js'
import { getTaskboardDb } from './taskboard/db/index.js'
import { isPatrolSessionKey } from './taskboard/domain.js'
import { isTaskboardEnabled } from './taskboard/feature.js'
import { PatrolEngine } from './taskboard/patrol.js'
import { TaskboardNotifier } from './taskboard/notify.js'
import { sendV3WechatProactive, readV3WechatProactiveConfig } from './v3WechatProactive.js'
import { sendV3QqProactive, readV3QqProactiveConfig } from './v3QqProactive.js'
import { postInboxMessage, postInboxMessageDurable } from './v3InboxPost.js'
import { postInboxAlert, postInboxAlertDurable } from './v3InboxAlert.js'
import { parseDocument } from './documentParser.js'
import {
  makeDelegateProgressBlock,
  makeDelegateUsageProgressBlock,
  makeDelegateBlockPassthrough,
  coalesceDelegateTranscript,
  DELEGATE_TRANSCRIPT_WARN_BYTES,
  estimateTranscriptBytes,
  resolveDelegateProgressRouting,
  toNestedDelegateProgressLine,
  formatDelegateParentWorkingDetail,
  type DelegateProgressBlock,
  type DelegateProgressRouting,
} from './delegateProgress.js'
import {
  getDelegateTimeoutReason,
  resolveDelegateTimeoutConfig,
  type DelegateTimeoutConfig,
} from './delegateTimeout.js'
import {
  type DelegateJobStore,
  DELEGATE_LEASE_HEARTBEAT_MAX_BEATS,
  DELEGATE_LEASE_HEARTBEAT_MS,
  DELEGATE_REAP_INTERVAL_MS,
  resolveDelegateHeartbeatTimeoutMs,
  resolveDelegateJobTtlMs,
  resolveDelegateWaitMs,
  type DelegateJobHttpResult,
  type DelegateJobSnapshot,
} from './delegateJobs.js'
import { type DelegateResumeRegistry, DELEGATE_RESUME_OCCUPIED_MESSAGE } from './delegateResume.js'
import {
  isDelegateCutoverEffective,
  isDelegateDurableEffective,
  isDelegateInflightSurfaceEffective,
  isDelegateNotifierEffective,
  isDelegateSmEnabled,
  resolveDelegateCallbackOwner,
} from './delegateSmFlag.js'
import {
  type DelegateInflightSurfaceStore,
  handleInflightDelegatesRequest,
} from './delegateInflightSurface.js'
import {
  beginDelegateCutover,
  endDelegateCutover,
  isDelegateRunnerIdle,
  resolveDelegateCutoverFreezeMs,
} from './delegateCutover.js'
import { DefaultEngineNotifier, writeInlinePushForSession, type InlinePushSession } from './engineNotifier.js'
import { resolveParentTapeIngestState, type ParentTapeIngestState } from './delegateNotifyTape.js'
import {
  delayUntilNextNotifyRetry,
  dispatchJobTerminalNotify,
  retryPendingNotifies,
} from './delegateNotifyDispatch.js'
import {
  formatJobTerminalMarkdown,
  injectPayloadFromJobTerminal,
  isJobTerminalFailure,
  parseParentEngine,
} from './jobTerminal.js'
import {
  openDelegateDurableDb,
  resolveDelegateLedgerRetentionMs,
} from './delegateDurable.js'
import {
  nextDelegateReconcileAt,
  reconcileDelegateJobsOnBoot,
  restoreResumeOccupancyFromJobs,
} from './delegateReconciler.js'
import {
  delegateCallbackMessageId,
  persistDelegateJobSnapshots,
  restoreDelegateJobSnapshots,
} from './delegateCompleter.js'
import {
  DELEGATE_GOAL_REQUIRED_ERROR,
  isPlatformAgentId,
  parseDelegateAllowSelf,
  parseDelegateModel,
  rejectSelfDelegate,
} from './delegateModel.js'
import { EMPTY_COMPLETED_TURN_NOTICE, hasPlatedAssistantOutput } from './emptyCompletedTurn.js'
import {
  rebindOutboundClientMessageId,
  resolveDelegateProgressBinding,
} from './terminalStreamFence.js'
import {
  type acquireDelegateGrokRoute,
  delegateGrokMintModelId,
  shouldMintDelegateGrokRoute,
  type DelegateGrokRouteLease,
} from './delegateGrokRoute.js'
import {
  type defaultDelegateEngineBilling,
  mapDelegateEngineBillingError,
  resolveDelegateEngineBillingEngine,
  shouldAdmitDelegateEngineBilling,
  type DelegateEngineBillingAdmission,
  type DelegateEngineBillingClient,
} from './delegateEngineBilling.js'
import { parseAdvisorAdmitRoute, type AdvisorAdmitRouteOk } from './advisorCodexRoute.js'
import type { DelegateOwnerTurnLocator } from './delegateLateCompletion.js'
import { eventBus, createEvent } from './eventBus.js'
import { startEventPersistence } from './eventPersist.js'
import { startMemoryTurnObserver } from './memoryTurnObserver.js'
import { startMemoryUsageReporter } from './memoryUsageReporter.js'
import { parseByteRange, serveFileFdWithRange } from './httpRange.js'
import { createLogger, type Logger } from './logger.js'
import {
  startMetricsCollection,
  serializeMetrics,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsTotal,
  sessionsActive,
  outboundRingReplayHitTotal,
  outboundRingReplayMissTotal,
  outboundRingEvictedTotal,
  outboundRingSizeBytes,
  delegateNotifyTotal,
  delegateNotifyLatencyMs,
} from './metrics.js'
import { RateLimiter } from './rateLimit.js'
import { USER_PROFILE_INJECT_MAX_CHARS } from './promptSlots.js'
import { matchBridgeApiAllowlist, parseTrustedCollabParentHeaders } from './bridgeApiAllowlist.js'
import { handleOpenAIRequest } from './openaiCompat.js'
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
  isCommercialManagedRuntime,
  lookupRecentTerminal,
  parseVerificationVerdict,
  persistInterruptedPromptQueueTurn,
  PRE_ADMISSION_STOP_TTL_MS,
  messageSendAttempt,
  preStartStopKey,
  stopControlSendAttempt,
  type PromptQueueExternalTurnReservation,
} from './sessionManager.js'
import { WebhookRouter } from './webhooks.js'
import { inferAgentForModel } from './inferAgentForModel.js'
import {
  capMarketplaceToolsets,
  mergeOnDemandToolsets,
  resolveDelegateToolsets,
} from './toolsetIntent.js'
import { projectCcbExecutionDescriptor, resolveOpenClaudeVisionEntry } from './subprocessRunner.js'
import {
  handleV3CodexRelayLocal,
  readV3CodexRelayConfig,
  V3_CODEX_RELAY_PREFIX,
} from './v3CodexRelay.js'
import {
  handleV5GrokRelayLocal,
  readV5GrokRelayConfig,
  V5_GROK_RELAY_PREFIX,
} from './v5GrokRelay.js'
import {
  handleV5ZcodeRelayLocal,
  readV5ZcodeRelayConfig,
  V5_ZCODE_RELAY_PREFIX,
} from './v5ZcodeRelay.js'
import {
  handleV5AntigravityRelayLocal,
  readV5AntigravityRelayConfig,
  V5_ANTIGRAVITY_RELAY_PREFIX,
} from './v5AntigravityRelay.js'
import type { AntigravityRouteOverride } from './engine/antigravityAdapter.js'
import {
  handleV3MarketplaceRelayLocal,
  readV3MarketplaceRelayConfig,
  V3_MARKETPLACE_LOCAL_RELAY_PREFIX,
} from './v3MarketplaceRelay.js'
import {
  buildSkillTrainCompleteNotice,
  decideSkillLocalRelay,
  SKILL_LOCAL_RELAY_PREFIX,
} from './ocSkillLocalRelay.js'
import { handleProjectSearchLocal, PROJECT_SEARCH_LOCAL_PATH } from './projectSearchLocal.js'
import {
  startToolFailureReporter,
  type ToolFailureReporter,
} from './v3ToolFailureReporter.js'
import {
  fetchUserSkillFeedbackRefs,
  startSkillUsageReporter,
  type SkillFeedbackRef,
} from './skillUsageReporter.js'
import {
  startSkillShadowReporter,
  type SkillShadowReporter,
} from './skillShadowReporter.js'
import { resolveEngine } from './engine/registry.js'
import {
  AuthorityRejected,
  MODEL_AUTHORITY_FIELD,
  ModelAuthorityConsumer,
  attachTurnAuthority,
  buildContainerAttestFrame,
  getTurnAuthority,
  isEngineLocalTurnExempt,
  isModelAuthorityRequired,
  stripModelAuthorityField,
  type ConnectionAuthorityContext,
  type TurnExecutionDescriptor,
} from './modelAuthority.js'
import {
  DISPATCH_AUTHORITY_FIELD,
  DispatchAuthorityConsumer,
  DispatchRejected,
  type DispatchTurnContext,
  type admitTurnDispatch,
  attachDispatchContext,
  buildSyntheticCrashedTapePayload,
  buildTurnDispatchReceiptFrame,
  buildTurnDispatchStateResponse,
  durableTurnDispatchCapabilities,
  getDispatchContext,
  getTurnDispatchState,
  getTurnDispatchStateByDispatch,
  inboxSinkStageFailedByDispatch,
  inboxSinkStagedByDispatch,
  isInboundBypassMethodAllowed,
  isTurnDispatchLive,
  normalizeDispatchUserId,
  queryMasterTapeState,
  recoverTurnDispatchInboxOnBoot,
  rejectTurnDispatchIfAbsent,
  cancelQueuedTurnDispatchExact,
  resolveInboxTerminalAck,
  runDurableDispatchAdmission,
} from './turnDispatchInbox.js'
import type { RuntimeRecycleDrainCoordinator } from './runtimeRecycleDrain.js'
import {
  LocalExecutionRejected,
  ModelCatalogUnavailableError,
  getLocalCatalogView,
  localExecutionRejectCode,
  type LocalCatalogView,
  type LocalExecutionRejectCode,
} from './modelCatalogClient.js'
import { suggestDelegateModels } from './delegateModelCatalogPrompt.js'
import { resolveDelegateCostUsd } from './usageCost.js'
import {
  buildTeamPreamble,
  buildTeamReviewContext,
  parseTeamReviewMode,
  pickDeliberationPanel,
  pickReviewerModel,
  type DeliberationPanelMember,
  type ReviewEvidenceItem,
  type TeamReviewMode,
} from './teamMode.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import {
  OPENCLAUDE_VISION_MCP_ID,
  OPENCLAUDE_VISION_TOOLS,
  isTextOnlyDefinite,
  shouldEnableOpenClaudeVision,
} from './mcpVisionServer.js'
import { buildImageAttachmentHint } from './imageAttachmentHint.js'
import {
  AUTO_DREAM_PROPOSAL_JSON_SCHEMA,
  AutoDreamService,
  AutoDreamStructuredOutputCollector,
  formatAutoDreamReceipt,
  isAutoDreamSuccessfulTurn,
  type AutoDreamModelRun,
} from './autoDream.js'
import {
  AUTO_DREAM_OPTIMIZER_JSON_SCHEMA,
  AutoDreamOptimizerService,
  type AutoDreamAuditDataset,
  type AutoDreamOptimizerModelRun,
  type AutoDreamOptimizerProposal,
} from './autoDreamOptimizer.js'
import { AutoDreamOptimizerClient } from './autoDreamOptimizerClient.js'
import { AutoDreamPolicyClient, type AutoDreamOptimizerPolicy } from './autoDreamPolicy.js'
import { GATEWAY_PENDING_PERMISSION_TTL_MS, _isBlockingUserInputTool, _permissionRequestExpiresAt, _pendingPermissionCatchupFrames, parsePermissionLookupQuery, attachPermissionSnapshotIfMissing } from './pendingPermissionSnapshot.js'
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

/**
 * 协议级允许的 InboundMessage.model 值(2026-04-26 v1.0.4 加)。
 *
 * 不查 deps.pricing(GatewayDeps 没 pricing;商用版 admin 启用列表是 host 概念,
 * 容器 gateway 拿不到)。新增模型时这里同步更新。安全意义:防止用户 prefs 残留
 * 已下线模型 / 恶意 frame 注入字符串让 CCB --model 拿到非法值导致 spawn 失败 →
 * session 卡死。运行时校验在 server.ts:WS handler 里;export 出来便于 unit test
 * 与未来抽 helper。
 *
 * 当前 commercial 暴露集合:
 *   - gpt-5.5 — codex agent 走 codex JSON-RPC(v5 从 picker dropGptForV5Channel,但入站仍受)
 *   - deepseek-v4-pro — master 侧 direct DeepSeek 静态 key 路由(入站/回放仍注册;执行下线由 catalog 决定,同 glm-5.1/5.2)
 *   - deepseek-v4-flash — provider-neutral 产品 id，master 侧实际走 OpenCode Go 静态 key 路由
 *     二者都在 claude-subscription agent 上跑即可,不需要切 agent
 *   - MiniMax-M3 — master 侧切到 MiniMax Token Plan Anthropic 兼容端点,
 *     同样跑 claude-subscription/non-codex agent,不进 codex-native
 *   - glm-5.1 / glm-5.2 / glm-5.3 — master 侧切到火山方舟 Ark Coding Plan Anthropic 兼容端点,
 *     同 non-codex;2026-08-22 起平台全局默认是 glm-5.3-zai,glm-5.3(ark) 不再做默认
 *
 * **Claude 官方模型(claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5)已全面下线**
 * (v3 + v5 均不支持),不在白名单;stale prefs / 构造帧带 Claude 模型会被拒,而不是路由到
 * 已下线的 Anthropic 上游。
 *
 * 静态 key 文本 provider 的字面量(deepseek-v4-flash/pro, MiniMax-M3, glm-5.1/5.2/5.3)从
 * @openclaude/protocol 注册表 STATIC_KEY_INBOUND_MODEL_IDS 注入,新增 provider 零改本处。
 */
export const ALLOWED_INBOUND_MODELS = new Set<string>([
  ...CODEX_ENGINE_MODEL_IDS,
  ...GROK_ENGINE_MODEL_IDS,
  ...CURSOR_ENGINE_MODEL_IDS,
  ...ZCODE_ENGINE_MODEL_IDS,
  ...STATIC_KEY_INBOUND_MODEL_IDS,
])

/** 平台执行模型兜底:V5 当前合法的静态 key 平台默认。 */
export const EXECUTION_MODEL_FALLBACK_ROUTE = [
  'glm-5.3-zai',
  'MiniMax-M3',
  'deepseek-v4-flash',
] as const
export const EXECUTION_MODEL_FALLBACK = EXECUTION_MODEL_FALLBACK_ROUTE[0]

/**
 * delegate_task(s) 未显式指定 model 时的默认优先模型:先试 grok-build(上游 grok-4.6)。
 * 只在 selfhost 豁免门(isEngineLocalTurnExempt)开着时插入候选;catalog 无该行 / 不可路由
 * 会被 decideLocalExecution 的候选循环静默跳过,mint 失败则由 handleDelegateTask 回落到
 * DELEGATE_GROK_FALLBACK_MODEL(日志 delegate_grok_fallback)。显式 model 完全不受影响。
 */
export const DELEGATE_DEFAULT_PREFERRED_MODELS = ['grok-build'] as const
export const DELEGATE_GROK_FALLBACK_MODEL = 'glm-5.3-zai'

/**
 * 把 agent/config 级模型收敛到平台真实支持的集合。
 *
 * ALLOWED_INBOUND_MODELS 只拦**入站帧**;但 agent.model(marketplace manifest / seed /
 * delegate 委派)会**绕过入站校验**,在 SessionManager.getOrCreate 里直接作为 CCB `--model`
 * spawn。已下线模型(如某个 stale 已安装 agent 里残留的 claude-*)会让 CCB 用不可路由的
 * --model 启动 → spawn 失败 / session 卡死。runner 创建是唯一收口点,这里把任何不在白名单的
 * 模型降级到平台默认(glm-5.3-zai),使"Claude 官方模型下线"在 agent 级路径上也真正生效。
 */
export function resolveExecutionModel(
  preferred: string | undefined | null,
  fallback: string | undefined | null,
  /**
   * master 签名的执行权威(方案 §2)。存在 → **直接用 descriptor.canonicalModel**,
   * 不过 ALLOWED_INBOUND_MODELS 这张 baked 白名单。
   *
   * 为什么不能再过白名单:baked 白名单是容器镜像里的第二信任源。catalog 里新 staged→active
   * 的模型(镜像没这一版)会被它降级成 glm-5.3 —— master 按新模型预扣/签发,容器却跑
   * 另一个模型,计费与执行分裂。descriptor 已经是「master 唯一判定者」的产物(active +
   * 有价 + capability schema 可理解),再拿旧白名单去二次审判它,等于让旧快照否决新快照。
   */
  authority?: { canonicalModel: string },
  opts?: { explicit?: boolean },
): string {
  if (authority !== undefined) return authority.canonicalModel
  if (
    opts?.explicit &&
    typeof preferred === 'string' &&
    preferred !== '' &&
    !ALLOWED_INBOUND_MODELS.has(preferred)
  ) {
    const suggestions = suggestDelegateModels(
      preferred,
      [...ALLOWED_INBOUND_MODELS].map((modelId) => ({ modelId, available: true })),
    )
    const hint =
      suggestions.length > 0
        ? ` 你是不是想填: ${suggestions.map((s) => `'${s}'`).join(' / ')}?`
        : ' 系统提示「委派可用型号」段列出了可填的精确 slug。'
    throw new LocalExecutionRejected(
      'DELEGATE_MODEL_UNKNOWN',
      `unknown explicit delegate model '${preferred}' (not inherited).${hint} model 只能填精确 catalog slug,不要猜或截短。`,
    )
  }
  for (const m of [preferred, fallback, ...EXECUTION_MODEL_FALLBACK_ROUTE]) {
    if (typeof m === 'string' && ALLOWED_INBOUND_MODELS.has(m)) return m
  }
  return EXECUTION_MODEL_FALLBACK
}

/**
 * Fail-loud for an explicit delegate `--model` slug against the baked inbound set.
 *
 * - absent / empty → inherit, no-op
 * - known baked slug → no-op
 * - unknown → throws `DELEGATE_MODEL_UNKNOWN` (does not inherit)
 *
 * Does **not** consult the model catalog. Catalog outages stay
 * `MODEL_CATALOG_UNAVAILABLE` on the `OC_MODEL_AUTHORITY=1` path; mixing
 * the two would collapse "master unreachable" into "typo". Catalog-only
 * slugs remain the flag-on `decideLocalExecution` path.
 */
export function assertKnownExplicitDelegateModel(model: string | undefined | null): void {
  if (typeof model !== 'string' || model === '') return
  resolveExecutionModel(model, undefined, undefined, { explicit: true })
}

/**
 * 服务端**合成首帧**(cron / webhook / scheduled task / inter-agent / openai-compat 等
 * gateway 进程内直接派发、不经 master bridge 计费编排的新会话首帧)的执行模型解析。
 *
 * 背景(P0 计费旁路封堵铁律的对偶面):codex engine(needsServerRequestId)的真扣费
 * 依赖 master bridge 铸造的 server-owned requestId + preCheck / inflight journal 编排
 * (见 sessionManager 的 CODEX_BILLING_GUARD)。这些合成路径是进程内首帧,拿不到也
 * 铸不出该 requestId —— 尤其 host 平台 agent(如 master 侧 `main`)的 cron **无 per-user
 * 计费主体(session 无 user_id = 无钱包)**,codex turn 落地会被 guard 100% fail-closed
 * 拒(线上实测 agent:main:cron:dm:* 全拒)。因此这类首帧不该落 codex:它既无法被编排,
 * 也没有可扣费的主体。
 *
 * 单一权威:codex 归属判定复用 `resolveExecutionModel`(收敛下线/缺省模型)+ protocol
 * `isCodexEngineModel`(codex 系模型集合的唯一权威),不另立第二套 gpt 集合。
 *
 * 语义(返回 `SyntheticTurnModel | undefined`):
 *   - agent/默认模型解析为**非 codex** → 返回 `undefined`,尊重原配置,合成路径行为不变;
 *   - 解析为 **codex(模型驱动)** → 返回 `{ model, originalModel, downgraded:true }`:`model` 是
 *     显式非 codex 兜底模型(env `OPENCLAUDE_SYNTHETIC_TURN_MODEL` 覆盖,默认 `deepseek-v4-flash`),
 *     `originalModel` 是若不降级本会落地的 codex 模型(供用户面/审计**透明披露**降级,不静默换
 *     模型 —— MAJOR-2)。同时补齐这些路径一直缺失的 `model` 路由字段(合成 inbound 铁律)。
 *   - agent.provider === 'codex-native'(**硬 pin**)→ 返回 `undefined`:model 替换救不了它
 *     (resolveEngine 的 provider pin 恒判 codex),这类 agent 的合成 turn 保持 fail-closed
 *     (显式 codex pin + 无扣费主体 = 按显式意图拒,不静默降级到 CCB)。当前 host `main`
 *     无 pin,不受此分支影响。
 *   - 兜底模型在**当前进程形态**下不可路由(host 无对应平台静态 key,见 hostStaticProviders)
 *     → 返回 `undefined`:换成一个必 401 的模型比闸的显式错误更糟,故保持 fail-closed(MAJOR-1)。
 */
export interface SyntheticTurnModel {
  /** 降级后实际执行的非 codex 模型(getOrCreate 决定 runner engine + submit 路由字段同源)。 */
  model: string
  /** 若不降级本会落地的 codex 执行模型 —— 用于对有计费主体路径透明披露"从什么降下来"。 */
  originalModel: string
  /** 恒 true:本结构只在真正发生 codex → 非 codex 降级时返回(undefined = 不干预)。 */
  downgraded: true
}

export const SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT = 'deepseek-v4-flash'
export function resolveSyntheticTurnModel(
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>,
  defaultModel: string | undefined | null,
): SyntheticTurnModel | undefined {
  // 硬 pin 的 codex-native:model 替换无效(见 registry.resolveEngine),保持 fail-closed。
  if (agent.provider === 'codex-native') return undefined
  const effective = resolveExecutionModel(agent.model, defaultModel)
  if (!isCodexEngineModel(effective) && !isGrokEngineModel(effective) && !isCursorEngineModel(effective) && !isZcodeEngineModel(effective) && !isAntigravityEngineModel(effective)) return undefined
  const raw = process.env.OPENCLAUDE_SYNTHETIC_TURN_MODEL?.trim()
  // env 兜底自身必须**非 codex 且在入站白名单内**,否则忽略回默认 —— 防"把 bug 换个门再引入"
  // (例如误配成 gpt-5.5 又绕回 codex,或配一个会被 resolveExecutionModel 收敛掉的下线模型)。
  const candidate =
    raw && ALLOWED_INBOUND_MODELS.has(raw) && !isCodexEngineModel(raw) && !isGrokEngineModel(raw) && !isCursorEngineModel(raw) && !isZcodeEngineModel(raw) && !isAntigravityEngineModel(raw)
      ? raw
      : SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT
  // ── routable 自检(MAJOR-1)──────────────────────────────────────────────
  // 兜底模型必须在当前进程形态下真正可达:host 上走静态 provider 平台直连,若该 provider 的
  // 平台 key 未经 commercial seam 注入(缺配 / 个人版),换成 deepseek-v4-flash 也是必 401。此时
  // **不降级**,返回 undefined 让 CODEX_BILLING_GUARD 按原样 fail-closed(Codex 明确:闸的显式
  // 错误优于换一个必 401 的模型)。容器身份 isHostRoutableStaticModel 恒 true(经 master
  // internal proxy 按模型名路由可达),不受影响。
  if (!isHostRoutableStaticModel(candidate)) return undefined
  return { model: candidate, originalModel: effective, downgraded: true }
}

// ─── 本地路径(无 envelope)的执行判定 —— 方案 §3 真值表 ─────────────────────
//
// 谁走这里:cron / webhook / scheduled task / inter-agent / openai-compat / skill-train /
// skill-eval / delegate / wechat inbound / boot pre-warm —— 所有**不经 bridge 签发
// authority** 的 runner 创建入口。它们此前按容器镜像里 baked 的两张表判定
// (ALLOWED_INBOUND_MODELS / MODEL_ENGINE_MAP),那是 master 之外的**第二信任源**:
// 与 catalog 必然漂移(新模型 / engine 迁移 / 撤销授权在两侧不同步生效),漂移方向恰好是
// "容器以为自己能跑" = 免费或越权执行。本批把判定源换成 master 的 per-uid catalog 投影。
//
// 三条硬语义:
//   1. **flag 未开 → 一行不动**(resolveLocalExecutionIfEnforced 返回 undefined,调用方
//      走现状 baked 判定)。个人版 / 过渡期零变化。
//   2. **投影拉不到 → 拒新 turn**(ModelCatalogUnavailableError 上抛,无 baked 回落,R1-B1)。
//   3. **codex 意图按 kind 分岔**(§3 真值表):
//        - 'synthetic'(cron/webhook/task/inter-agent/openai-compat)→ 既有语义:**降级**
//          为非 codex 兜底模型(这些是进程内合成首帧,拿不到 master 铸的 server-owned
//          requestId,落 codex 必被 CODEX_BILLING_GUARD 拒;降级让 cron 照常跑);
//        - 'turn'(delegate / wechat 等真实本地 turn / skill-train / skill-eval)→ **拒**,
//          结构化 DELEGATE_CODEX_UNSUPPORTED。现状是同样跑不了(晚期被 billing guard 拒),
//          本批把它提前到**创建 runner 之前**并给出稳定错误码 —— 不静默换模型:用户/队长
//          明确点了 codex,悄悄换成别的模型执行并计费是更坏的答案;
//        - 'prewarm'(boot / hello 预热)→ **不适用 codex 策略**:预热不执行 turn、不计费,
//          engine/model 照样取投影(不查 baked),但允许 codex —— 真正的 turn 一定带 envelope
//          (bridge)或被上面两条拦住,且 CODEX_BILLING_GUARD 仍是最后一道闸。拒预热只会
//          让 codex 会话丢掉预热(UX 回退),换不到任何安全收益。
//   4. **provider pin('codex-native')的本地 turn → 一律拒**:model 替换救不了它
//      (resolveEngine 的 pin 恒判 codex),与 resolveSyntheticTurnModel 现状(返回 undefined
//      → 保持 fail-closed)同向,只是把"晚期 guard 拒"提前成结构化错误。

/** 本地路径的 turn 语义分类(决定 codex 意图怎么处理,见上方真值表)。 */
export type LocalTurnKind = 'synthetic' | 'turn' | 'prewarm' | 'auto_dream'

/** 本地路径判定结果:该 turn 的 canonical 模型 + engine(= getOrCreate/submit 的同源入参)。 */
export interface LocalExecutionDecision {
  /** catalog 归一后的 canonical model id(alias 已解析)。 */
  readonly canonicalModel: string
  /** 取自投影的 engine(不查 baked MODEL_ENGINE_MAP)。 */
  readonly engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  readonly supportsVision: boolean
  /** 非空 = 发生了 codex → 非 codex 降级('synthetic' kind);原模型供透明披露(MAJOR-2)。 */
  readonly downgradedFrom?: string
  /**
   * 无票 inbound 试图沿用存活 runner 的 model,但 catalog 不可用/未授权/豁免门未开
   * 而回退到原阶梯时的说明。成功沿用或冷启动(没有 liveSessionModel)时缺省。
   */
  readonly liveSessionFallback?: { readonly from: string; readonly reason: string }
}

/** 无票 inbound 沿用会话模型失败时的可检索 warn 文案(字段:liveModel/reason/fallbackModel)。 */
export const TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN =
  '无票 inbound 沿用会话模型失败'

/** 无票 inbound 沿用会话模型失败:session 正在 getOrCreate 替换/关闭。 */
export const TICKETLESS_LIVE_SESSION_REPLACING_REASON = 'session_replacing'

type LiveRunnerSessionView = {
  runner?: { model?: string }
  model?: string
  _replacing?: boolean
}

function peekLiveRunnerModel(session: LiveRunnerSessionView): string | undefined {
  const runnerModel = session.runner?.model
  if (typeof runnerModel === 'string' && runnerModel !== '') return runnerModel
  const sessionModel = session.model
  if (typeof sessionModel === 'string' && sessionModel !== '') return sessionModel
  return undefined
}

/** session 正在替换/关闭 → 不得沿用其 model。 */
export function liveSessionReuseSkipReason(
  session: LiveRunnerSessionView | undefined | null,
): string | undefined {
  if (session?._replacing === true) return TICKETLESS_LIVE_SESSION_REPLACING_REASON
  return undefined
}

/**
 * 从内存中的存活 runner 读当前实际在跑的 model。
 * 优先 runner.model(进程正在用的),其次 session.model。
 * **不读** client_sessions.model_id(那只是 UI 恢复提示,不是执行权威)。
 * 命中正在替换/关闭 → undefined(等价冷启动,走原阶梯)。
 */
export function readLiveRunnerModel(
  session: LiveRunnerSessionView | undefined | null,
): string | undefined {
  if (!session) return undefined
  if (liveSessionReuseSkipReason(session) !== undefined) return undefined
  return peekLiveRunnerModel(session)
}

/** 存活 runner 的 model 为何不能沿用。undefined = catalog 认为可路由。 */
export function liveSessionModelUnusableReason(view: LocalCatalogView, raw: string): string | undefined {
  const canonicalModel = view.canonicalize(raw)
  const descriptor = view.resolve(canonicalModel)
  if (descriptor == null) return 'not_in_projection'
  if (descriptor.available === false) return 'unavailable'
  if (!view.isRoutable(canonicalModel)) return 'unroutable'
  if (descriptor.engine === undefined) return 'no_engine'
  return undefined
}

/**
 * 纯函数:给定 per-uid 投影 + 执行意图 → 本地路径判定(真值表实现体,便于单测)。
 *
 * 候选阶梯与 `resolveExecutionModel` **同形**(caller model → agent.model → config 默认 →
 * 平台兜底),只是"这个模型能不能跑"的判定从 baked 白名单换成 catalog 投影 —— 于是
 * "agent.model 是个已下线/未授权模型"这类存量情况仍然优雅降级到平台默认(不回归),
 * 而"catalog 里 disabled / 该 uid 无授权"的模型则被真正拦下(baked 白名单拦不住)。
 */
export function decideLocalExecution(args: {
  view: LocalCatalogView
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>
  /** caller 显式指定的模型(cron 降级模型 / skill-train 模型 / inbound frame.model)。 */
  model?: string
  /**
   * 无票 inbound 且该 sessionKey 已有存活 runner 时,runner 当前实际在跑的 model。
   * 插在 caller model 之后、agent.model 之前:有显式 model 仍以 caller 为准(用户换模型
   * / 签名票路径不走这里);没有显式 model 时先沿用会话,避免 agent 默认改判引擎。
   * 该沿用对所有 engine 生效(含 CCB/Codex),是有意的会话连续性,不只是 cursor 专用。
   */
  liveSessionModel?: string
  /**
   * 无票取样命中正在替换/关闭的 session 时由 caller 传入(如 session_replacing)。
   * 有值则不把 liveSessionModel 插入候选,但仍打回退 warn。
   */
  liveSessionSkipReason?: string
  /** config.defaults.model。 */
  defaultModel?: string | null
  /**
   * 无显式 model 时、插在 liveSessionModel 之后 / agent.model 之前的优先候选(delegate 默认
   * grok-build 优先)。不可路由 / 非 ccb 且未豁免的条目由候选循环静默跳过。
   */
  preferredModels?: readonly string[]
  kind: LocalTurnKind
  env?: NodeJS.ProcessEnv
  /** 沿用会话模型失败并回退时调用(dispatchInbound 接到 this.log.warn)。 */
  warn?: (message: string, fields?: Record<string, unknown>) => void
}): LocalExecutionDecision {
  const { view, agent, kind } = args
  const env = args.env ?? process.env

  // ① provider 硬 pin:engine 恒 codex,换模型无效 → 本地 turn 一律拒(prewarm 除外)。
  if (
    agent.provider === 'codex-native' &&
    kind !== 'prewarm' &&
    kind !== 'auto_dream' &&
    // selfhost 豁免门开着时放行(modelAuthority.isEngineLocalTurnExempt,代价说明见彼处)。
    !isEngineLocalTurnExempt(env)
  ) {
    throw new LocalExecutionRejected(
      'DELEGATE_CODEX_UNSUPPORTED',
      `agent '${agent.id}' is pinned to the codex engine, which cannot run on a local ` +
        `(non-bridge) turn: codex billing needs a master-minted request id. Run it from a chat turn.`,
    )
  }

  const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined
  if (explicitModel) {
    const canonical = view.canonicalize(explicitModel)
    if (!view.isRoutable(canonical) || view.resolve(canonical)?.engine == null) {
      // 自愈提示:只从**可路由**集合里挑近邻(不泄露不可用/无权限型号),仅作建议不自动替换。
      const suggestions = suggestDelegateModels(explicitModel, view.models)
      const hint =
        suggestions.length > 0
          ? ` 你是不是想填: ${suggestions.map((s) => `'${s}'`).join(' / ')}?`
          : ' 系统提示「委派可用型号」段列出了可填的精确 slug。'
      throw new LocalExecutionRejected(
        'DELEGATE_MODEL_UNKNOWN',
        `model '${explicitModel}' is not in the current catalog projection (not inherited).` +
          `${hint} model 只能填精确 catalog slug,不要猜或截短;不填则用成员绑定型号。`,
      )
    }
  }
  const forcedSkipReason =
    typeof args.liveSessionSkipReason === 'string' && args.liveSessionSkipReason !== ''
      ? args.liveSessionSkipReason
      : undefined
  const liveSessionModel =
    forcedSkipReason === undefined &&
    typeof args.liveSessionModel === 'string' &&
    args.liveSessionModel !== ''
      ? args.liveSessionModel
      : undefined
  const ticketlessReuse = explicitModel === undefined
  let liveSkipReason: string | undefined = forcedSkipReason
  if (ticketlessReuse && liveSessionModel && liveSkipReason === undefined) {
    liveSkipReason = liveSessionModelUnusableReason(view, liveSessionModel)
  }

  const decorate = (decision: LocalExecutionDecision): LocalExecutionDecision => {
    if (!ticketlessReuse) return decision
    if (!liveSessionModel && forcedSkipReason === undefined) return decision
    if (liveSessionModel) {
      const liveCanonical = view.canonicalize(liveSessionModel)
      if (decision.canonicalModel === liveCanonical && liveSkipReason === undefined) return decision
    }
    const reason =
      liveSkipReason ??
      (liveSessionModel !== undefined
        ? liveSessionModelUnusableReason(view, liveSessionModel)
        : undefined) ??
      forcedSkipReason ??
      'unroutable'
    args.warn?.(TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN, {
      liveModel: liveSessionModel,
      reason,
      fallbackModel: decision.canonicalModel,
    })
    return { ...decision, liveSessionFallback: { from: liveSessionModel ?? '', reason } }
  }

  // ② 候选阶梯:归一 → 投影可用性 → engine,三件事**全取投影**。
  // 无票 inbound 把存活 runner 的 model 插在 agent.model 之前;有显式 model 时不插入
  // (用户换模型 / 带 model 的普通消息行为不变)。
  const candidates = explicitModel
    ? [explicitModel]
    : [
        ticketlessReuse && liveSessionModel && liveSkipReason === undefined ? liveSessionModel : undefined,
        ...(args.preferredModels ?? []),
        agent.model,
        args.defaultModel,
        ...EXECUTION_MODEL_FALLBACK_ROUTE,
      ]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw === '') continue
    const canonicalModel = view.canonicalize(raw)
    if (!view.isRoutable(canonicalModel)) continue // 未 active / 未授权 / 未知 → 下一档
    const descriptor = view.resolve(canonicalModel)
    const engine = descriptor?.engine
    if (engine === undefined || descriptor == null) continue
    if (engine === 'ccb') return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })

    // codex 意图(engine 取自投影,不看 baked)。
    if (kind === 'prewarm' || kind === 'auto_dream') {
      return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })
    }
    if (kind === 'turn') {
      // selfhost 豁免门(OC_SELFHOST_ENGINE_LOCAL_TURNS=1)未开 -> 结构化拒(现状)。
      if (!isEngineLocalTurnExempt(env)) {
        // 无票沿用的会话模型若是 cursor/codex/grok,生产环境不能本地跑 —— 跳过它
        // 回退原阶梯(与修之前「直接走 agent 默认」同形),不要把整条 turn 拒掉。
        const isLiveOnlyCandidate =
          ticketlessReuse &&
          liveSessionModel !== undefined &&
          raw === liveSessionModel &&
          raw !== agent.model
        if (isLiveOnlyCandidate) {
          liveSkipReason = liveSkipReason ?? 'engine_local_turn_not_exempt'
          continue
        }
        throw new LocalExecutionRejected(
          'DELEGATE_CODEX_UNSUPPORTED',
          `model '${canonicalModel}' runs on the ${engine} engine, which cannot run on a local ` +
            `(non-bridge) turn: engine-reported billing needs a master-minted request id.`,
        )
      }
      // 豁免门开 -> 按投影 engine 放行执行(单租户自用部署接受该 turn 不走 master
      // 计费编排:usage 不结算,仍落 event/usage log 与 durable tape)。
      return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })
    }
    return decorate(downgradeSyntheticCodex(view, canonicalModel, args.defaultModel, env))
  }

  if (ticketlessReuse && (liveSessionModel || forcedSkipReason)) {
    const reason =
      liveSkipReason ??
      (liveSessionModel !== undefined
        ? liveSessionModelUnusableReason(view, liveSessionModel)
        : undefined) ??
      forcedSkipReason ??
      'unroutable'
    args.warn?.(TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN, {
      liveModel: liveSessionModel,
      reason,
      fallbackModel: '',
    })
  }
  throw new LocalExecutionRejected(
    'MODEL_NOT_AVAILABLE',
    `no routable model for agent '${agent.id}' in the current model catalog projection`,
  )
}

/**
 * 合成路径的 codex → 非 codex 降级(真值表 'synthetic' 分支)。
 *
 * 与 `resolveSyntheticTurnModel` 同一套兜底选择(env 覆盖 → deepseek-v4-flash → config 默认 →
 * 平台兜底),差别只在**每一级都必须过投影**(可路由 + 非 codex)——"换一个必 401 的模型"
 * 比闸的显式错误更糟(MAJOR-1 的同构结论):全部兜底都不可路由 → MODEL_NOT_AVAILABLE。
 */
function downgradeSyntheticCodex(
  view: LocalCatalogView,
  from: string,
  defaultModel: string | null | undefined,
  env: NodeJS.ProcessEnv,
): LocalExecutionDecision {
  const override = env.OPENCLAUDE_SYNTHETIC_TURN_MODEL?.trim()
  const fallbacks = [
    override,
    SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT,
    defaultModel,
    ...EXECUTION_MODEL_FALLBACK_ROUTE,
  ]
  for (const raw of fallbacks) {
    if (typeof raw !== 'string' || raw === '') continue
    const canonicalModel = view.canonicalize(raw)
    if (!view.isRoutable(canonicalModel)) continue
    const descriptor = view.resolve(canonicalModel)
    const engine = descriptor?.engine
    if (engine !== 'ccb' || descriptor == null) continue // 兜底自身是 codex → 忽略
    return { canonicalModel, engine, supportsVision: descriptor.supportsVision, downgradedFrom: from }
  }
  throw new LocalExecutionRejected(
    'MODEL_NOT_AVAILABLE',
    `synthetic turn intended codex ('${from}') but no routable non-codex fallback exists`,
  )
}

/**
 * 本地路径判定入口(**所有无 envelope 的 runner 创建入口在创建前调它**)。
 *
 *   - flag 未开 → `undefined`(调用方走现状 baked 判定,行为零变化);
 *   - flag 开 → 取 catalog 投影(TTL 30s + 单飞 + LKG,见 modelCatalogClient)并判定;
 *       · 投影拉不到 → 抛 `ModelCatalogUnavailableError`(**拒新 turn**,无 baked 回落);
 *       · 真值表拒 → 抛 `LocalExecutionRejected`(结构化 code)。
 *
 * 调用方拿到 decision 后:把 `canonicalModel` **同时**喂给 `getOrCreate({model, executionAuthority})`
 * 和 `submit(model)` —— 两处同源,避免 spawn 用 A、路由字段用 B。
 */
export async function resolveLocalExecutionIfEnforced(args: {
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>
  kind: LocalTurnKind
  model?: string
  liveSessionModel?: string
  liveSessionSkipReason?: string
  /** catalog 投影拉完后再取样,缩小「读 runner → await catalog → getOrCreate」窗口。 */
  resolveLiveSessionModel?: () => string | undefined
  /** 与 resolveLiveSessionModel 同时、在 catalog 之后取样。 */
  resolveLiveSessionSkipReason?: () => string | undefined
  defaultModel?: string | null
  /** 见 decideLocalExecution.preferredModels(仅 delegate 默认路径传)。 */
  preferredModels?: readonly string[]
  env?: NodeJS.ProcessEnv
  warn?: (message: string, fields?: Record<string, unknown>) => void
}): Promise<LocalExecutionDecision | undefined> {
  const env = args.env ?? process.env
  const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined
  // Explicit unknown slug fail-loud is unconditional. Flag-off uses the baked
  // inbound set (no catalog I/O). Flag-on still uses catalog projection below
  // so catalog-only slugs are not rejected by the baked snapshot.
  if (explicitModel && !isModelAuthorityRequired(env)) {
    assertKnownExplicitDelegateModel(explicitModel)
  }
  if (!isModelAuthorityRequired(env)) return undefined
  const view = await getLocalCatalogView()
  const liveSessionModel = args.resolveLiveSessionModel?.() ?? args.liveSessionModel
  const liveSessionSkipReason = args.resolveLiveSessionSkipReason?.() ?? args.liveSessionSkipReason
  return decideLocalExecution({ ...args, liveSessionModel, liveSessionSkipReason, view, env })
}

/** decision → getOrCreate 的执行覆盖入参(flag 未开 → `{}`,展开后零影响)。 */
export function localExecutionOverride(decision: LocalExecutionDecision | undefined): {
  model?: string
  executionAuthority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
    source: 'local_catalog'
  }
} {
  if (!decision) return {}
  return {
    model: decision.canonicalModel,
    executionAuthority: {
      canonicalModel: decision.canonicalModel,
      engine: decision.engine,
      source: 'local_catalog',
    },
  }
}

/** Mirror SubprocessRunner's MCP merge rules for prompt/upload hints.
 * This is intentionally metadata-only: the actual tool injection still
 * happens when the CCB subprocess starts. */
export function collectAvailableMcpToolNames(
  config: OpenClaudeConfig,
  agent?: AgentDef,
  model?: string,
  opts: {
    resolveVisionEntry?: (claudeCodePath?: string) => string | null
    modelSupportsVision?: boolean
  } = {},
): string[] {
  const tools = new Set<string>()
  const effectiveProvider = agent?.provider ?? config.provider
  const effectiveModel = model ?? agent?.model ?? config.defaults.model

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

  const resolveVisionEntry = opts.resolveVisionEntry ?? resolveOpenClaudeVisionEntry
  if (
    shouldEnableOpenClaudeVision(
      effectiveProvider,
      effectiveModel,
      opts.modelSupportsVision,
    ) &&
    resolveVisionEntry(config.auth.claudeCodePath)
  ) {
    // bypassToolset=true:vision 是内置平台工具,豁免 toolset 过滤(与 subprocessRunner 注入侧一致;
    // gating 已由 shouldEnableOpenClaudeVision 控制)。否则有 toolset 的 agent 的 prompt hint 不提
    // understand_image,与实际注入不一致。
    addTools(OPENCLAUDE_VISION_MCP_ID, OPENCLAUDE_VISION_TOOLS, true)
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

// ─── Codex per-turn route override(v5 feat/v5-codex-oauth-egress A1/A2)─────
//
// master bridge 在 codex turn 的 inbound 帧上注入私有字段 `__oc_codex_route`
// (client 提供的同名字段在 bridge 侧已强制剥离,见 userChatBridge sanitize)。
// 容器 gateway 在 dispatchInbound 把它解析成 CodexProviderConfigOverride,经
// sessionManager.submit(opts.codexRoute) → runner.setCodexRoute 在下一次 spawn
// 拼成 codex CLI 的 `-c model_providers.*` 覆盖。
//
// v5 语义(与 v3 的关键差异,不得照搬 v3):
//   - official_oauth 不再是"空哨兵/直连官方"。v5 红线 = 数据面必须经
//     容器 loopback relay → master egress(账号绑定代理,fail-closed)转发,
//     所以 `{ kind: 'official_oauth' }` 在这里被固定拼成 loopback relay
//     override(base_url 指向本 gateway 的 /internal/v3/codex-relay 非 route
//     路径 + requires_openai_auth=true,codex CLI 继续用 auth.json 的 ChatGPT
//     token 发 Authorization —— 发给的是 loopback relay,不是 chatgpt.com)。
//   - api_relay override 校验保留(v5 DB 无启用行,不会触发;字段 allowlist
//     从 v3 的"取已知字段"收紧为"未知字段即拒",并加长度上限)。
//   - 门控用 resolveEngine(model, agent) === 'codex' 单点收口,而非 v3 的
//     agent.provider 判断 —— v5 任何 agent 都能以 gpt-5.5 骑 codex 底座。

/** official_oauth relay override 的 codex provider id(TOML key,只允许
 *  [A-Za-z0-9_-])。 */
export const CODEX_OFFICIAL_RELAY_PROVIDER_ID = 'oc_chatgpt_official'

/** official 上游 https://chatgpt.com/backend-api/codex 在容器 loopback relay 的
 *  base path(= master internalCodexRelay 的 codexRelayBasePathForUpstream 拼法:
 *  CODEX_RELAY_PREFIX + 上游 base path)。gateway 与 commercial 不互相 import,
 *  两侧各自持有常量 —— parity 由 commercial 侧单测锁定。 */
export const CODEX_OFFICIAL_RELAY_BASE_PATH = `${V3_CODEX_RELAY_PREFIX}/backend-api/codex`

const CODEX_ROUTE_PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CODEX_ROUTE_BASE_URL_MAX = 512
const CODEX_ROUTE_PROVIDER_NAME_MAX = 128
const CODEX_API_RELAY_ROUTE_KEYS = new Set([
  'baseUrl',
  'modelProvider',
  'providerName',
  'wireApi',
  'preferredAuthMethod',
  'disableResponseStorage',
])

/**
 * Parse the master-owned Codex per-turn route override from an inbound frame.
 * 这是安全面:override 直接变成 codex CLI 的 base_url,任何放松都可能把平台
 * codex 流量引到任意上游。写严 —— 非 loopback / 未知字段 / 超长一律拒(→ null,
 * 即"本 turn 不带 override",codex 走 env 默认;v5 部署 env 无 OC_CODEX_* 六键,
 * 等价 fail-closed 到官方默认 provider,且容器无任何上游凭证)。
 */
export function _buildSafeCodexRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  /** 本 gateway 的监听端口(config.gateway.port)——official override 的 loopback
   *  base_url 指回本进程的 /internal/v3/codex-relay handler。 */
  officialRelayPort: number
  /** master 签名的执行权威(有则 engine 判定只认它,见 registry.resolveEngine)。 */
  authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity' }
}): CodexProviderConfigOverride | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) {
    return null
  }
  // 单点收口:与 sessionManager.getOrCreate 的 engine 判定同构。resolveEngine
  // 对非法 runnerKind fail-closed 抛错 —— 那种配置在 getOrCreate 会同样炸,这里
  // 只需不带 override。
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'codex') return null

  const r = args.rawRoute as Record<string, unknown>
  if (r.kind === 'official_oauth') {
    // Exact-shape marker only。带多余字段的 `{ kind: 'official_oauth', ... }`
    // 不得被重新解释(与 v3 同款防御,防 client 形状混淆)。
    if (Object.keys(r).length !== 1) return null
    const port = args.officialRelayPort
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return {
      modelProvider: CODEX_OFFICIAL_RELAY_PROVIDER_ID,
      baseUrl: `http://127.0.0.1:${port}${CODEX_OFFICIAL_RELAY_BASE_PATH}`,
      providerName: 'OpenAI (OpenClaude relay)',
      wireApi: 'responses',
      // auth.json(per-container chatgptAuthTokens)继续供 token;codex CLI 对
      // requires_openai_auth=true 的自定义 provider 会把 ChatGPT access token
      // 放进 Authorization 发到上面的 loopback base_url。
      preferredAuthMethod: 'chatgpt',
      disableResponseStorage: true,
      requiresOpenaiAuth: true,
    }
  }

  // api_relay 形状:未知字段即拒(严于 v3)。
  for (const key of Object.keys(r)) {
    if (!CODEX_API_RELAY_ROUTE_KEYS.has(key)) return null
  }
  if (typeof r.baseUrl !== 'string' || r.baseUrl.length > CODEX_ROUTE_BASE_URL_MAX) return null
  let routeBaseUrlOk = false
  try {
    const parsedRouteBase = new URL(r.baseUrl)
    routeBaseUrlOk =
      parsedRouteBase.protocol === 'http:' &&
      parsedRouteBase.hostname === '127.0.0.1' &&
      parsedRouteBase.pathname.startsWith(`${V3_CODEX_RELAY_PREFIX}/route/`)
  } catch {
    routeBaseUrlOk = false
  }
  if (!routeBaseUrlOk) return null
  if (typeof r.modelProvider !== 'string' || !CODEX_ROUTE_PROVIDER_ID_RE.test(r.modelProvider)) {
    return null
  }
  if (
    r.providerName !== undefined &&
    r.providerName !== null &&
    (typeof r.providerName !== 'string' || r.providerName.length > CODEX_ROUTE_PROVIDER_NAME_MAX)
  ) {
    return null
  }
  return {
    baseUrl: r.baseUrl,
    modelProvider: r.modelProvider,
    providerName: typeof r.providerName === 'string' ? r.providerName : null,
    wireApi: r.wireApi === 'responses' || r.wireApi === 'chat' ? r.wireApi : null,
    preferredAuthMethod:
      r.preferredAuthMethod === 'apikey' || r.preferredAuthMethod === 'chatgpt'
        ? r.preferredAuthMethod
        : null,
    disableResponseStorage:
      typeof r.disableResponseStorage === 'boolean' ? r.disableResponseStorage : null,
  }
}

/** Validate the master-owned opaque route consumed by the Grok adapter. */
export function _buildSafeGrokRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity' }
}): { baseUrl: string; routeToken: string } | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'grok') return null
  const route = args.rawRoute as Record<string, unknown>
  if (Object.keys(route).sort().join(',') !== 'baseUrl,routeToken') return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (!Number.isInteger(args.officialRelayPort) || args.officialRelayPort <= 0 || args.officialRelayPort > 65535) return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_GROK_RELAY_PREFIX}/route/${route.routeToken}/v1`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    ) return null
  } catch {
    return null
  }
  return { baseUrl: route.baseUrl, routeToken: route.routeToken }
}

/** Validate the master-owned opaque route consumed by the ZCode adapter.
 * Anthropic SDK appends /v1 itself, so the minted baseUrl must NOT include /v1.
 */
export function _buildSafeZcodeRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity' }
}): { baseUrl: string; routeToken: string } | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'zcode') return null
  const route = args.rawRoute as Record<string, unknown>
  if (Object.keys(route).sort().join(',') !== 'baseUrl,routeToken') return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (!Number.isInteger(args.officialRelayPort) || args.officialRelayPort <= 0 || args.officialRelayPort > 65535) return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_ZCODE_RELAY_PREFIX}/route/${route.routeToken}`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    ) return null
  } catch {
    return null
  }
  return { baseUrl: route.baseUrl, routeToken: route.routeToken }
}

/** Validate the master-owned Antigravity route (OCV5-415): the opaque relay
 * token plus the openid/userinfo-only Google token the CLI needs for its
 * startup eligibility check. CLOUD_CODE_URL keeps the path, so the route
 * baseUrl is used verbatim. */
export function _buildSafeAntigravityRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity' }
}): AntigravityRouteOverride | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'antigravity') return null
  const route = args.rawRoute as Record<string, unknown>
  const keys = Object.keys(route).sort().join(',')
  if (keys !== 'accessToken,accessTokenExpiresAt,baseUrl,routeToken'
    && keys !== 'accessToken,accessTokenExpiresAt,baseUrl,idToken,routeToken') return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (typeof route.accessToken !== 'string' || !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(route.accessToken)) return null
  if (typeof route.accessTokenExpiresAt !== 'string' || !Number.isFinite(Date.parse(route.accessTokenExpiresAt))) return null
  if (route.idToken !== undefined && (typeof route.idToken !== 'string' || !/^[A-Za-z0-9._-]{20,8192}$/.test(route.idToken))) return null
  if (!Number.isInteger(args.officialRelayPort) || args.officialRelayPort <= 0 || args.officialRelayPort > 65535) return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_ANTIGRAVITY_RELAY_PREFIX}/route/${route.routeToken}`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    ) return null
  } catch {
    return null
  }
  return {
    baseUrl: route.baseUrl,
    routeToken: route.routeToken,
    accessToken: route.accessToken,
    accessTokenExpiresAt: route.accessTokenExpiresAt,
    ...(typeof route.idToken === 'string' ? { idToken: route.idToken } : {}),
  }
}

// ─── handleUpload TOCTOU hardening test seam (v3 commercial v1.0.155) ───────
//
// Production calls fchmod / fchown / link via `_uploadFsOps.*` so unit tests
// can simulate failure modes (EPERM on fchown, EXDEV on link, etc.) without
// spinning up real containers or root-side filesystem state. `null` restores
// defaults. Production code MUST NOT call __setUploadFsOpsForTests.
//
// Only operations whose TOCTOU semantics matter for the contract are wrapped
// — openSync / realpathSync / closeSync / fstatSync / unlinkSync remain
// direct because their failure-injection isn't needed by current tests.
//
// Pattern mirrors `__setCodexSpawnForTests` in codexRunner.ts.
type UploadFsOps = {
  fchmodSync: typeof fchmodSync
  fchownSync: typeof fchownSync
  linkSync: typeof linkSync
}
const defaultUploadFsOps: UploadFsOps = { fchmodSync, fchownSync, linkSync }
export let _uploadFsOps: UploadFsOps = defaultUploadFsOps
export function __setUploadFsOpsForTests(overrides: Partial<UploadFsOps> | null): void {
  _uploadFsOps = overrides ? { ...defaultUploadFsOps, ...overrides } : defaultUploadFsOps
}


/**
 * V3 Phase 2 Task 2H: 商业化模块 hook 形状(只声明 gateway 需要的接口,
 * 不依赖 @openclaude/commercial 的具体实现)。
 *
 * - `handle(req, res) → Promise<boolean>`:返 true 表示已处理,gateway 不再继续路由
 * - `handleWsUpgrade(req, socket, head) → boolean`:同上,boolean 表示是否已 upgrade/destroy
 * - `shutdown()`:在 _doShutdown Stage 3.5 调用(channels 之后,sessions 之前)
 * - `internalProxyAddress`:供 /healthz 反映内部代理是否上线
 *
 * 故意不 import @openclaude/commercial — 保持 gateway 包对商业化模块零编译期依赖,
 * cli launcher 负责 dynamic import + 注入。
 */
/**
 * V3 multi-tenant media 路由结果(uploads + generated 双 dir,同一 docker volume)。
 *
 * 故意结构化(kind discriminator + logCtx),不抛错。gateway 自己决定 HTTP 状态码 +
 * 客户端可见 message。这里的字段命名与 commercial/userMedia.ts 的 `UserMediaLocation`
 * 完全一致 —— 类型在 gateway 端本地重复声明只是为了避免 gateway 反向 import commercial。
 *
 * ok 时同时返回 uploads 和 generated 两个子目录,因为它们属于同一 volume,一次
 * inspect 就能确认两者可用,避免 `/api/media` 一次请求里双查 DB+docker。
 */
export type UserMediaLocationLike =
  | { kind: 'ok'; uid: number; uploads: string; generated: string }
  | {
      kind: 'fail'
      reason: 'remote-host'
      /** 与 'ok' 分支同语义,gateway upload 推远端 host 时透传给 hook。 */
      uid: number
      hostUuid: string
      uploads: string
      generated: string
      logCtx: Record<string, unknown>
    }
  | {
      kind: 'fail'
      reason: 'invalid-uid' | 'not-ready' | 'volume-missing' | 'ambiguous' | 'daemon-error'
      logCtx: Record<string, unknown>
    }

export interface CommercialHook {
  handle: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
  handleWsUpgrade: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean
  shutdown: () => Promise<void>
  internalProxyAddress?: { host: string; port: number }
  /**
   * v5 灰度运行时状态(commercial 自算,gateway 仅在 /healthz 只读透传)。
   * 结构内联(gateway 对 commercial 零编译期依赖),与 commercial 的
   * CommercialRuntimeStatus 保持一致。
   */
  runtimeStatus?: {
    channel: string
    controlPlaneEnabled: boolean
    autoMigrate: boolean
    agentRuntime: string
    containerRuntime: string
    schedulers: string[]
  }
  /**
   * 商业化模块的 JWT HMAC 密钥(HS256)。注入后,gateway 的 personal-version 路由
   * 会同时尝试用这个 secret 验证 access token,使商业化用户也能命中
   * /api/agents、/api/sessions/* 等 personal-version 端点。
   */
  jwtSecret?: Uint8Array
  /**
   * V3 multi-tenant `/api/uploads` 写入 + `/api/media` 读取 +
   * `/api/file`/openFileHardened allowlist 的路径解析器。
   * 把 `c:<uid>` 的 userId 映射到该用户 docker volume 宿主路径下的
   * `_data/uploads/` 和 `_data/generated/` 两个子目录。
   *
   * 注入时表明商用模块在多租户模式 —— gateway 必须按用户路由,不再使用全局
   * `paths.uploadsDir` / `paths.generatedDir`(那两个目录在多租户下不存在
   * 用户文件,会触发 dispatchInbound 端"媒体不存在或不可读" / 图像 404)。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocationLike>
  /**
   * **V3 remote-host 上传桥**(2026-05-16)。把 master 收到的上传文件推到远端
   * compute host 上的用户 docker volume 宿主路径。
   *
   * 仅当 `resolveUserMediaDirs` 返回 `{kind:'fail', reason:'remote-host', ...}`
   * 时由 `handleUpload` 调用 —— 此时 master 物理上不持有用户的 volume,本机
   * tmp+rename 路径不可用。
   *
   * 实现侧(commercial):查 compute_hosts 表解出 NodeAgentTarget,经 mTLS
   * PUT `/files?path=<remotePath>&mode=0644&owner_uid=1000&owner_gid=1000` 上传。
   * node-agent 端 AllowedDirRegexes 严格匹配 v3 用户卷形态;mode+owner 与 self
   * host 上 chmod/chown 完全等价(让远端容器内 agent uid 1000 可读)。
   *
   * 错误语义:throw 表示推送失败(网络/证书/agent app err);gateway 转 5xx。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string
    remotePath: string
    content: Buffer
  }) => Promise<void>
  /**
   * **V3 remote-host 读路径桥**(2026-05-16 Phase 2)。`pushRemoteHostUpload`
   * 的对称端 —— 当 `resolveUserMediaDirs` 返回 `remote-host`,gateway 用本 hook
   * 从远端 user docker volume 拉文件回 master,由 master 服给 HTTP 终端。
   *
   * 仅在 `handleMediaGet` / `handleApiFile` 命中 remote-host 时调用,自 self-host
   * 路径无关。`remotePath` 必须在 node-agent AllowedDirRegexes 之内(uploads/
   * generated 子目录),否则 node-agent 直接 400 BAD_PATH。
   *
   * 返:
   *   - `Buffer` → 拉到字节(可能为空文件)
   *   - `null`   → 远端 404,gateway 可选择尝试另一目录或最终 404 给用户
   *   - throw   → 网络/mTLS/auth/agent app err,gateway 转 502
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string
    remotePath: string
  }) => Promise<Buffer | null>
  /**
   * **textual** 谓词:判定 `resolvedPath` 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— gateway HTTP allowlist 不能用它(cross-tenant
   * IDOR)。allowlist 应该用 `resolveUserMediaDirs(userId)` 解析出当前用户的
   * `{uploads, generated}` 后自己 closure 限制到该 uid 的两 dir。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean
  /**
   * **P1.7 slice 7c — WeChat broker 入口**。
   *
   * 当 commercial 模块启用 wechat broker (WECHAT_BROKER_ENABLED=1) 时注入。
   * gateway 把它**通过 wechatChannelFactory 的 `onInboundOverride`** 透传给
   * `routeWechatInbound`,broker 由此接管 inbound 事件(替代 ctx.dispatch),
   * 并把目标用户的 outbound 容器 endpoint 暂存,供其 v3WechatOutbound 适配器
   * 按 wsess-* session → bindingUserId → senderId 反查回传。
   *
   * **结构类型 (structural)**:gateway 不 import commercial 的具体类——保持
   * gateway → commercial 单向依赖。
   */
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string
      accountId?: string
      senderId: string
      text: string
      messageId?: string
      itemTypes?: string
      rawPayload?: unknown
      imageAttachments?: unknown[]
      mediaAttachments?: unknown[]
      idempotencyKey: string
      receivedAt: number
      channel?: 'wechat'
      agentId?: string
    }): Promise<unknown>
    cleanupBinding?(bindingUserId: string): Promise<unknown>
  }
  /**
   * **v1.0.192 — cold-start guard for `/api/uploads`**(以及 commercial 内部
   * `/api/file`、`/api/media/:file` 由 commercial router 自己直接调底层 wrapper)。
   *
   * `handleUpload` 在确认请求是 commercial user(userId 形如 `c:<digits>`)后,
   * 在 `_resolveMediaDirs` 之前 await 本 hook —— 确保用户容器已 provision +
   * volume 已挂载 + container running,再去解析 host path 并写入。否则会出现
   * "容器尚未启动,写到 volume host path 上,容器内 agent 看不到文件" 的脏写。
   *
   * 与 commercial router 内部使用的 `(uid: bigint) => Promise<void>`(throw 风格)
   * 不同,**这里返回结构化 result**:gateway 不 import commercial 的
   * `ContainerUnreadyError`,保持 structural-only 依赖。`{ok:false}` 由 gateway
   * 翻译成 503 + `Retry-After`,`{ok:true}` 即放行。
   *
   * 底层都是同一个 `sharedEnsureRunning`(per-uid singleflight),所以 WS bridge /
   * HTTP `/api/media-signed` / commercial router file proxy / gateway upload 同
   * uid 的 in-flight 调用会合并成一次 provision。
   *
   * 非 commercial 形态(`c:<digits>` 不匹配,如 personal-version userId)时 gateway
   * 不调用本 hook —— 让 `_resolveMediaDirs` 原有 `invalid-uid` 路径继续判定。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<
    { ok: true } | { ok: false; retryAfterSec: number; reason: string }
  >
  /**
   * master GET /api/sessions/:id 时 fire-and-forget POST 到用户容器
   * `/internal/v3/engine-preheat`。仅 master 注入;失败必须 swallow。
   */
  preheatUserContainer?: (args: {
    userId: string
    sessionId: string
    agentId: string
    modelId?: string
  }) => Promise<void>
  /**
   * **P0 监控盲区收口 — 深度依赖探活**(2026-07-07)。
   *
   * gateway 对 PG/Redis 零编译期依赖(client 全在 commercial 侧),故由 commercial
   * 注入本 hook:master 形态 `/healthz` 会在探完 sessions.db 后并发调用它,拿到
   * 各强依赖(约定键:`pg` = `SELECT 1`、`redis` = `PING`,短超时如 2s 由**实现侧
   * (commercial)**保证)的探活结果。任一 fail → healthz 顶层 `ok:false`(**HTTP 仍
   * 200** —— 深度不健康 ≠ 完全不可服务,不给上游 LB 摘流信号,只翻 ok 供监控/deploy
   * smoke 消费 ok 字段告警)。2026-07-06 sessions.db 事故(进程活着但全站 500 无告警)
   * 的同构盲区,本波扩到 PG/Redis 维度。
   *
   * 返回 map:依赖名 → `{ok:true}` | `{ok:false, error}`。gateway 侧 generic 合并
   * 不硬编码依赖清单(commercial 拥有"哪些依赖"的权威)。**未注入**(个人版/dev 无
   * PG/Redis,或 commercial 尚未接线)= 该维度不探,healthz 行为退回仅 sessions.db。
   */
  probeDeps?: () => Promise<Record<string, { ok: true } | { ok: false; error: string }>>
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

export type WechatStartOutcome = {
  accepted?: boolean
  started: boolean
  completed?: boolean
  traceId?: string
  sessionKey?: string
  peerId?: string
  agentId?: string
}

const DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO = 0.85

function parseDelegateMemoryPressureRatio(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO)
  return Number.isFinite(raw) && raw > 0 && raw < 1
    ? raw
    : DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO
}
/** 同时排队者上限:内存高压期每个等待者都挂着一条 HTTP 请求,不设上限会把
 *  "排队"本身堆成第二波雪崩;超出直接按原闸形状立即拒。 */
export const DELEGATE_QUEUE_MAX_WAITERS = 8

// ── 团队模式审查任务书 ──────────────────────────────────────────────────────
// 2026-09-04 起两套模板(执行验收 / 审议对比)+ 成员证据块,全部在 teamMode.ts
// (buildTeamReviewContext);server.ts 只负责从队长会话取证据(_pendingAgentGroups)喂进去。

/** 资源闸拦截原因 —— 两道闸共用一个判定/拒绝收口,避免两套并行机制。 */
export type DelegateGateBlock =
  | { kind: 'concurrency' }
  | { kind: 'memory'; pct: number; limitPct: number }

/** P2 债C — `_runDelegateTask` 的结构化入参(HTTP 壳从请求 body 组装;gateway 硬编排
 *  review pass 直接构造)。把委派执行核心与 HTTP req/res 解耦,让编排能内部直调同一路径
 *  拿到结构化结果(verdict/output),不必伪造 req/res。 */
export interface RunDelegateInput {
  allowSelf?: boolean
  targetAgentId: string
  goal: string
  context?: string
  sourceAgent?: string
  toolsets?: unknown
  /** 父会话 sessionKey(容器内部键):委派归因 + 进度回传 + per-parent 分桶的解析源。 */
  parentSessionKey?: string
  streamProgress?: boolean
  depth: number
  /** P2 批次4 — 子任务思考量级(low/medium/high),透传给 delegate session 的
   *  sessions.submit effortLevel(参照顶层会话 safeEffortLevel 传法)。缺省/非法 →
   *  undefined,不动子会话 runner 的默认 effort(= 该成员默认档位)。 */
  effort?: string
  /** gateway 硬编排触发的隐藏审查员委派。影响:runLog isReview / 资源闸走保留槽 + 免
   *  per-parent 桶 / 完成后解析结构化 verdict / 不置位"本 turn 有非隐藏委派"跟踪。 */
  isReview?: boolean
  /** 覆盖默认 `agent:<id>:delegate:...`。taskboard 巡检必须传入 buildPatrolSessionKey()。 */
  sessionKey?: string
  projectId?: string
  workspaceCwd?: string
  runContext?: import('./runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /** 覆盖默认 channel 'delegate'。taskboard 传 'taskboard',且不得加入
   *  MASTER_SINK_PERSIST_CHANNELS,否则巡检文本会写进 client_sessions 刷屏。 */
  channel?: string
  /** 可选的本次无活动超时。只按真实 child activity 续租,不是总运行时长上限。 */
  idleTimeoutMs?: number
  /** 可选:覆盖目标成员默认模型的 catalog 型号。审查委派忽略(审查员型号由 gateway 选)。 */
  model?: string
  /** 2026-09-04 团队模式:审查任务书模板(execution 验收 / deliberation 审议对比)。
   *  仅审查委派读取;非法/缺省 → execution。只影响提示词,不影响闸与计费。 */
  reviewMode?: string
  /** HTTP/MCP 可选续跑:已通过 DelegateResumeRegistry 占用的钥匙。 */
  resumable?: boolean
  /** 本次是否新 mint。早退时要 drop binding,避免占 cap。 */
  resumeMinted?: boolean
  /** send_to_agent: child 完成后把结论注入父 webchat 并新开父 turn。 */
  callbackOnComplete?: 'origin-inject'
  /** Captured while the delegate parent chain is still live; nested parents are ephemeral. */
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
  /** Async handle returned to the send_to_agent tool, used as exact UI correlation. */
  backgroundJobId?: string
  /** Captured at claimQueued; never re-read from the store at terminal. */
  claimToken?: string
  fencingEpoch?: number
  /** SM: slot already reserved at Enqueue, skip the waiter loop. */
  capacityReserved?: boolean
  /** SM: the exact opts `_admitDelegateCreate` reserved with (slot or waiter). Every release
   *  of that reservation must use these — never a re-derived bucket key — or the per-parent
   *  running counter drifts and locks the parent out(2026-09-06 槽位泄漏事故:早退未释放)。 */
  capacitySlotOpts?: { parentBucketKey?: string; isReview?: boolean }
  idempotencyKey?: string
  _leaseTimer?: ReturnType<typeof setInterval>
}

// ── hidden 系统 agent 串行委派熔断 ──────────────────────────────────────────
/** 同一父 turn 内对 hidden 系统 agent(隐藏审查员)的委派次数硬上限。
 *
 *  P2 债C 后语义变更:审查触发权威已从 prompt 软约束**收归 gateway 硬编排**
 *  (dispatchInbound teamMode-main-webchat 的 review pass),队长 preamble 不再自觉
 *  调用 hidden-reviewer。本熔断因此从"拦队长 prompt 级串行重试"变为**硬编排重试的
 *  后备保险**:硬编排自身把迭代封顶在 OPENCLAUDE_TEAM_REVIEW_MAX_ROUNDS(默认 2)轮,
 *  本上限(默认 3,env OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN 可配)是更外层的绝对护栏
 *  ——即便编排逻辑有 bug 或未来放宽轮数,单 turn 对审查员的委派也不会失控(每轮 review
 *  都是全新 delegate session 全额计费)。delegation depth 只管嵌套、MAX_CONCURRENT_DELEGATIONS
 *  只管并行,都拦不住串行重试,这里是第三条腿。 */
export const MAX_HIDDEN_DELEGATIONS_PER_TURN = 3

/** P2 批次4 — 普通成员(队长直接委派的已安装 agent,非 hidden 非 review)每 turn
 *  委派次数上限。消"串行无上限"债:队长可以持续 fan-out,但单 turn 不该无界地把
 *  同一批成员反复委派(失控的串行重试/发散拆分会烧钱且拖长 turn)。超限返回结构化
 *  错误引导队长收敛(见 _runDelegateTask member guard 分支),不是静默失败。默认 8,
 *  env 可配(下限 1);比 hidden 熔断默认值宽,因为正常复杂任务的合理 fan-out 会多于审查。 */
export const MEMBER_DELEGATIONS_PER_TURN_DEFAULT = 8

/** 「每 turn、按父会话」的委派计数器 —— 一套通用机制,当前服务两条策略:
 *   1. hidden 审查员串行熔断(_hiddenDelegateGuard,上限 env 可配默认 MAX_HIDDEN_DELEGATIONS_PER_TURN);
 *   2. P2 批次4 普通成员每 turn 委派上限(_memberDelegateGuard,env 可配默认 8)。
 *  两者机制完全一致(仅上限值与计数范围不同),故复用同一个类而非另起并行实现。
 *
 *  计数键 = **父会话 sessionKey**,依据:delegate 请求(mcp-memory
 *  handleDelegateTaskToAgent)只携带 parentSessionKey(取自 OPENCLAUDE_SESSION_KEY env)
 *  和 x-delegation-depth 头,请求里拿不到任何 turn 级标识,因此退而按父会话维度计数,
 *  turn 边界由 dispatchInbound 在同一 sessionKey 收到下一条用户消息时调用 resetForParent
 *  划定。子 delegate 会话的 sessionKey 自带时间戳(一次性,不能当计数键),但它作为"父"
 *  再委派时天然就是 turn 粒度,其计数在该 delegate 请求收尾时清理。TTL 惰性清扫兜底
 *  cron/task 等永远等不到下一条用户消息的父会话 —— 既防 Map 泄漏,也防"额度永久锁死"。 */
export class PerTurnDelegationGuard {
  private counts = new Map<string, { count: number; touchedAt: number }>()

  constructor(
    private readonly limit = MAX_HIDDEN_DELEGATIONS_PER_TURN,
    /** 与平台 12h logical-turn 安全窗口对齐，只兜计数 Map 泄漏/永久锁死。 */
    private readonly staleMs = 12 * 60 * 60_000,
  ) {}

  /** 为一次 hidden 委派占额度:未达上限 → 计数 +1 放行;已达上限 → 拒绝。
   *  `limit` 缺省用构造时上限;生产 hidden 路径传入 call-time env 解析值。 */
  tryAcquire(parentKey: string, now = Date.now(), limit = this.limit): boolean {
    this.prune(now)
    const entry = this.counts.get(parentKey)
    if (!entry) {
      this.counts.set(parentKey, { count: 1, touchedAt: now })
      return true
    }
    if (entry.count >= limit) return false
    entry.count++
    entry.touchedAt = now
    return true
  }

  /** 父会话开启新用户 turn / 父 delegate 会话收尾时清零。 */
  resetForParent(parentKey: string): void {
    this.counts.delete(parentKey)
  }

  /** 只读:该父键本 turn 已占用的额度(团队模式「组队却未送审」可观测用)。 */
  countFor(parentKey: string): number {
    return this.counts.get(parentKey)?.count ?? 0
  }

  private prune(now: number): void {
    for (const [key, entry] of this.counts) {
      if (now - entry.touchedAt > this.staleMs) this.counts.delete(key)
    }
  }
}

/**
 * delegate 计费归因 — 解析"父**客户端**会话 id"(usage_records.parent_session_id
 * 的落库值)。优先级(能拿到 web-* 就绝不落内部键):
 *
 *   1. `progressPeerId`:父会话在内存且是 webchat → 其 peerId 即客户端会话 id
 *      (web-*,userChatBridge sessionKey 模板 `agent:<aid>:webchat:dm:<id>` 的
 *      第 4 段来源)。
 *   2. `parentRepoSessionId`:嵌套 delegate(父是 delegate 会话)→ 其
 *      repoSessionId 在创建时继承自根 webchat 会话的 peerId,仍是 web-*。
 *   3. parentSessionKey 形如 webchat 键 → 直接截取第 4 段(父会话不在内存 ——
 *      如 gateway 重启后 —— 的兜底,不依赖 session map)。
 *   4. 原样返回 parentSessionKey(容器内部会话键,如 cron/webhook 父或更老格式;
 *      master 侧原样落库,映射链依赖本注释)。
 *   5. 都拿不到 → undefined(usage_records.parent_session_id 落 NULL,行上仍有
 *      mode='delegate' + delegate_agent_id 可归因到"某次委派")。
 *
 * 纯函数,便于单测;调用点唯一(handleDelegateTask)。
 */
export function resolveDelegateParentClientSessionId(args: {
  progressPeerId?: string
  parentRepoSessionId?: string
  parentSessionKey?: unknown
}): string | undefined {
  if (args.progressPeerId) return args.progressPeerId
  if (args.parentRepoSessionId) return args.parentRepoSessionId
  const key = args.parentSessionKey
  if (typeof key !== 'string' || !key) return undefined
  const webchat = /^agent:[^:]+:webchat:dm:(.+)$/.exec(key)
  return webchat?.[1] ?? key
}

const AUTO_DREAM_SCHEDULE_KEYS = new Set([
  'id',
  'agent',
  'schedule',
  'prompt',
  'deliver',
  'enabled',
  'oneshot',
  'label',
  'createdAt',
])

/**
 * Auto-Dream may only create local, user-visible schedules. External delivery
 * targets remain a guided/manual action because model-authored peer IDs are
 * not an authority for proactive outbound delivery.
 */
export function normalizeAutoDreamSchedule(
  raw: string,
  agentId: string,
  jobId: string,
): import('./cron.js').CronJob {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTO_DREAM_SCHEDULE_INVALID')
  }
  const row = parsed as Record<string, unknown>
  if (Object.keys(row).some((key) => !AUTO_DREAM_SCHEDULE_KEYS.has(key))) {
    throw new Error('AUTO_DREAM_SCHEDULE_UNKNOWN_FIELD')
  }
  if (
    typeof row.schedule !== 'string' ||
    row.schedule.length < 1 ||
    row.schedule.length > 128 ||
    typeof row.prompt !== 'string' ||
    row.prompt.length < 1 ||
    row.prompt.length > 32_000 ||
    (row.deliver !== undefined && row.deliver !== 'local') ||
    (row.enabled !== undefined && typeof row.enabled !== 'boolean') ||
    (row.oneshot !== undefined && typeof row.oneshot !== 'boolean') ||
    (row.label !== undefined &&
      (typeof row.label !== 'string' || row.label.length < 1 || row.label.length > 500)) ||
    (row.createdAt !== undefined &&
      (typeof row.createdAt !== 'number' ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0))
  ) {
    throw new Error('AUTO_DREAM_SCHEDULE_INVALID')
  }
  return {
    id: jobId,
    agent: agentId,
    schedule: row.schedule,
    prompt: row.prompt,
    deliver: 'local',
    ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
    ...(typeof row.oneshot === 'boolean' ? { oneshot: row.oneshot } : {}),
    ...(typeof row.label === 'string' ? { label: row.label } : {}),
    ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
  }
}

/**
 * Access-log filter for the gateway HTTP server. Static assets are never logged.
 * Probe paths (/healthz, /metrics) are hit every few seconds by the watch timer
 * and monitors: a healthy probe is not logged (it was ~16% of the selfhost
 * master log on 2026-10-16, OCV5-461); a failing or slow one still is. The
 * request metrics count every request regardless.
 */
export function shouldLogHttpAccess(path: string, status: number, durationMs: number): boolean {
  if (path === '/healthz' || path === '/metrics') return status !== 200 || durationMs >= 1000
  return path.startsWith('/api/') || path.startsWith('/v1/')
}

export function makePeerKey(userId: string, channel: string, peerId: string): string {
  return `${userId}:${channel}:${peerId}`
}

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

  private _updateWechatIdempotency(key: string, patch: Partial<{
      started: boolean
      completed: boolean
      traceId: string
      sessionKey: string
      peerId: string
      agentId: string
    }>): void {
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
  private _staticFileCache = new Map<string, { content: Buffer; mime: string; etag: string; mtimeMs: number }>()
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
  private static readonly PENDING_PERMISSION_SWEEP_MS = 60_000
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
  private static readonly RECENT_SETTLEMENT_MAX = 1000
  private static readonly RECENT_SETTLEMENT_TTL_MS = 5 * 60_000
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
  private static readonly REPO_BIND_HELLO_GRACE_MS = 5_000
  private static readonly REPO_BIND_PENDING_TIMEOUT_MS = 5_000
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

  async start(): Promise<void> {
    const { config } = this.deps

    // Phase 0.2: replay any server-authored messages queued to the outbox
    // while the previous gateway instance was unable to reach SQLite (disk
    // full, crash mid-write, etc.). Runs before the WS endpoint opens so
    // catch-up writes precede live traffic. Failures here must not block
    // startup — we'd rather serve with a retryable queue than refuse boot.
    try {
      const { replayMsgOutbox } = await import('@openclaude/storage')
      const summary = await replayMsgOutbox()
      if (summary.processed > 0) {
        this.log.info('msg-outbox replay', summary)
      }
    } catch (err) {
      this.log.error('msg-outbox replay failed (continuing startup)', undefined, err as Error)
    }

    try {
      if (isDelegateSmEnabled()) {
        const store = this._ensureDelegateJobStore()
        if (!isDelegateDurableEffective()) {
          await restoreDelegateJobSnapshots(store)
        }
      }
      const summary = await recoverInterruptedSendToAgentIntents(
        (intent) => this._deliverInterruptedSendToAgentIntent(intent),
        process.env,
        {
          callbackOwner: resolveDelegateCallbackOwner(),
          resolveJob: (jobId) => this._delegateJobs?.snapshotOf(jobId),
          ensureCallback: (job, intent) => this._ensureDurableSendToAgentCallback(job, intent),
        },
      )
      if (summary.recovered > 0 || summary.retained > 0 || summary.malformed > 0) {
        this.log.info('send_to_agent intent recovery', summary)
      }
    } catch (err) {
      this.log.error('send_to_agent intent recovery failed (continuing startup)', undefined, err as Error)
    }

    // V3 commercial: container → master sink for server-authored messages.
    // Wire only if env is configured (set by v3supervisor when spawning
    // commercial containers). Personal version + dev sandbox don't set
    // these envs and the sink stays null — sessionManager falls back to
    // the legacy local-SQLite durable path. This block is no-op for
    // non-commercial deployments.
    //
    // Order matters:
    //   1. read config (env-driven; null → skip).
    //   2. create retry queue WITHOUT a sink reference (queue calls a
    //      function we'll close over).
    //   3. create sink with queue injected.
    //   4. wire the queue's attemptSend to call sink.attemptOnce.
    //   5. set the global getter so sessionManager picks it up before
    //      any turn-end callback fires.
    //   6. kick a drain pass + start periodic timer so any entries
    //      from a prior gateway crash get retried.
    try {
      const { makeV3MasterSink, readV3MasterSinkConfig, setV3MasterSinkSingleton } =
        await import('./v3MasterSink.js')
      const { makeV3MasterRetryQueue } = await import('./v3MasterRetryQueue.js')
      const sinkCfg = readV3MasterSinkConfig()
      if (sinkCfg) {
        // Two-phase wire to break the cycle: queue.attemptSend wants the
        // sink's single-attempt path, sink.persistOrQueue wants the queue
        // for fallback. Box `sinkRef` so the queue can call it via late-
        // binding when sink is constructed below.
        let sinkAttemptOnce: ((p: import('./v3MasterSink.js').V3MasterSinkWirePayload) => Promise<void>) | null = null
        const queue = makeV3MasterRetryQueue({
          attemptSend: async (p) => {
            if (!sinkAttemptOnce) {
              throw new Error('v3MasterRetryQueue: drainer fired before sink wired (impossible)')
            }
            return sinkAttemptOnce(p)
          },
          // RFC-v5-durable-turn-dispatch §3/§B6 + M-R1-1 ①(R3)— 延迟送达 ACK 驱动 inbox terminal。
          // 返回终态是否确认:resolveInboxTerminalAck 内 CAS 成功 / 已幂等终态(同 outcome)→ true,drainer
          // 删文件;CAS 落空且行非目标终态(缺失 / 仍非终态 / 异 outcome)→ false,**保留文件**退避重试,
          // 绝不"文件已删、行永停 sink_staged"。写失败(抛)→ false(同样保留)。
          onDispatchAck: async (dispatchId, attemptNo, status): Promise<boolean> => {
            try {
              const ok = await resolveInboxTerminalAck(dispatchId, attemptNo, status)
              if (!ok) {
                this.log.warn(
                  'inbox terminal (deferred ack) CAS did not apply and row not target-terminal; retaining entry',
                  { dispatchId, attemptNo, status },
                )
              }
              return ok
            } catch (err) {
              this.log.error(
                'inbox terminal (deferred ack) write failed; retaining entry for retry',
                { dispatchId },
                err as Error,
              )
              return false
            }
          },
        })
        const sink = makeV3MasterSink({
          config: sinkCfg,
          retryQueue: queue,
          // RFC-v5-durable-turn-dispatch §3/§B6 — sink 生命周期钩子驱动 inbox 状态机。
          // **await durable 迁移(去 best-effort)**:钩子返回 = 状态迁移已尝试落库并确认;
          // 迁移失败一律 error log + 依赖周期 recovery 兜底,绝不静默停在旧态。
          inboxHooks: {
            onStaged: async (dispatchId, attemptNo) => {
              try {
                await inboxSinkStagedByDispatch(dispatchId, attemptNo)
              } catch (err) {
                // running→sink_staged 写失败:tape 已 fsync 进 retry queue,boot ①路径
                // (retryQueueHasDispatch→sink_staged)会收敛。仅 error log。
                this.log.error('inbox sink_staged write failed', { dispatchId }, err as Error)
              }
            },
            // M-R1-1 ①(R3)— 同步 ACK 后**先**确认 terminal CAS 再删 entry。返回终态是否确认:
            // resolveInboxTerminalAck 成功 / 已幂等终态 → true(persistOrQueue 随后 ackDurable 删 entry);
            // CAS 落空且行非目标终态 / 写失败 → false(保留 entry + kick drainer 重试,幂等)。
            onAck: async (dispatchId, attemptNo, status): Promise<boolean> => {
              try {
                const ok = await resolveInboxTerminalAck(dispatchId, attemptNo, status)
                if (!ok) {
                  this.log.warn(
                    'inbox terminal (sync ack) CAS did not apply and row not target-terminal; retaining entry',
                    { dispatchId, attemptNo, status },
                  )
                }
                return ok
              } catch (err) {
                this.log.error(
                  'inbox terminal (sync ack) write failed; retaining entry for retry',
                  { dispatchId },
                  err as Error,
                )
                return false
              }
            },
            onStageFailed: async (dispatchId, attemptNo) => {
              this.log.error('turn dispatch tape stage failed', { dispatchId, attemptNo })
              // B6:stageDurable 失败 → 行仍 running(从未 stage)。sink_stage_failed 写入
              // **必须同步确认**;写入也失败 → error log,行留 running 由周期 recovery
              // (running→recovery 协议)兜底重试,不许静默停在 running。
              try {
                const row = await inboxSinkStageFailedByDispatch(dispatchId, attemptNo)
                if (!row) {
                  this.log.error(
                    'inbox sink_stage_failed CAS did not apply; leaving to periodic recovery',
                    { dispatchId, attemptNo },
                  )
                }
              } catch (err) {
                this.log.error('inbox sink_stage_failed write failed', { dispatchId }, err as Error)
              }
            },
          },
        })
        sinkAttemptOnce = (p) => sink.attemptOnce(p)
        setV3MasterSinkSingleton(sink)
        // Boot drain — best-effort, never blocks listen().
        queue.kick()
        queue.startPeriodic()
        this._stopV3RetryDrainer = () => queue.stopPeriodic()
        this._kickV3RetryDrainer = () => queue.kick()
        // RFC-v5-durable-turn-dispatch §3/§B4/§B5 — durable inbox boot recovery。**在开放新
        // ingress 前单飞跑完**:queued→rejected;running→三态收敛。阻塞于 sink 就绪之后
        // (需 retry queue 查同 dispatch + 合成 tape 走同一 queue)。
        this._turnDispatchQueue = queue
        // _runTurnDispatchRecoverySweep 成功一轮 → 自置 _durableTurnDispatchReady(B5);
        // 首跑失败仅 log(不置 ready → capability 不申报 → legacy),周期 recovery 会自愈。
        try {
          await this._runTurnDispatchRecoverySweep(queue)
        } catch (err) {
          this.log.error('turn dispatch boot recovery failed', undefined, err as Error)
        }
        // B4:启动首跑之后挂周期 single-flight 重试(收敛 recovery_pending / 不可达行)。
        this._startTurnDispatchRecoveryLoop(queue)
        this.log.info('v3 master sink wired', {
          baseUrl: sinkCfg.baseUrl,
          durableTurnDispatchReady: this._durableTurnDispatchReady,
        })
      }
    } catch (err) {
      // Non-fatal — fall back to legacy local durable path. Ops will see
      // turn texts going to local SQLite (which is permanently empty in
      // v3 commercial) so the symptom is "client_sessions empty" — same
      // as pre-fix; loud enough to detect via dashboards.
      this.log.error('v3 master sink wire failed (falling back to legacy path)', undefined, err as Error)
    }

    // Plan B (2026-05-09): clean up orphan `.tmp-*` files left in uploadsDir
    // by handleUpload runs that crashed mid-stream (or were aborted by the
    // client and the cleanup unlink raced past us). One-shot at startup —
    // intentionally no periodic sweep; abort/error paths in handleUpload
    // already unlink eagerly. Codex Plan B v2 review confirmed.
    //
    // V3 multi-tenant extension (2026-05-12): handleUpload writes land in
    // per-user docker volume host paths, not the global paths.uploadsDir.
    // We sweep both:
    //   1. paths.uploadsDir (personal-version / legacy 'default' uploads)
    //   2. /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads/* (commercial)
    // Each block is wrapped in its own try/catch so a docker host without
    // `/var/lib/docker/volumes` (e.g. dev box) doesn't fail the legacy sweep.
    const cutoff = Date.now() - 60 * 60 * 1000 // 1h
    const sweepTmpInDir = (dir: string): number => {
      let cleaned = 0
      try {
        const baseReal = realpathSync(dir)
        for (const fname of readdirSync(baseReal)) {
          if (!fname.startsWith('.tmp-')) continue
          try {
            const st = statSync(join(baseReal, fname))
            if (st.mtimeMs < cutoff) {
              unlinkSync(join(baseReal, fname))
              cleaned++
            }
          } catch {}
        }
      } catch {
        // Directory missing or unreadable — caller decides whether to log.
        return -1
      }
      return cleaned
    }
    try {
      mkdirSync(paths.uploadsDir, { recursive: true })
      const cleaned = sweepTmpInDir(paths.uploadsDir)
      if (cleaned > 0) this.log.info('upload .tmp orphan cleanup', { cleaned, dir: 'legacy' })
    } catch (err) {
      this.log.warn('upload .tmp orphan cleanup (legacy) failed', undefined, err)
    }
    if (this.deps.commercial?.isUserVolumeMediaPath) {
      // Multi-tenant mode — iterate /var/lib/docker/volumes/oc-v3-data-u*.
      // No DB lookup needed; we accept stale uid dirs (e.g. volume deleted)
      // because readdirSync skips them naturally.
      // We only sweep uploads/, NOT generated/: gateway 自身上传走 .tmp-
      // 协议(rename-after-fsync),codex image_gen 用 writeFile 直接落盘,
      // 不会留 .tmp- 残留,所以 generated/ 没有 orphan 需要清。
      // TODO: 若 generated/ 写入将来切到 .tmp-* publish 语义(例如 codex
      // image_gen 改成 rename-after-fsync),把 generated/ 也加进 sweep 列表。
      try {
        const volsRoot = '/var/lib/docker/volumes'
        let totalCleaned = 0
        let dirsSwept = 0
        for (const entry of readdirSync(volsRoot)) {
          if (!/^oc-v3-data-u[1-9][0-9]{0,18}$/.test(entry)) continue
          const userUploads = join(volsRoot, entry, '_data', 'uploads')
          const r = sweepTmpInDir(userUploads)
          if (r >= 0) {
            dirsSwept++
            totalCleaned += r
          }
        }
        if (totalCleaned > 0 || dirsSwept > 0) {
          this.log.info('upload .tmp orphan cleanup', { cleaned: totalCleaned, dirsSwept, dir: 'per-user' })
        }
      } catch (err) {
        // /var/lib/docker/volumes typically requires root (gateway runs as
        // root in v3 commercial); ENOENT just means docker isn't installed
        // (CI / dev). Log warn but don't fail startup.
        this.log.warn('upload .tmp orphan cleanup (per-user) failed', undefined, err)
      }
    }

    this.httpServer = createServer((req, res) => this.handleHttp(req, res))
    // V3 2H: 改用 noServer + 手动 upgrade dispatch,以便商业化模块的 /ws/user-chat-bridge
    // 与 /ws/agent 路径在 gateway 自身的 /ws 之前优先匹配。原 `path: '/ws'` 模式下
    // ws lib 会对所有非 /ws 请求 socket.destroy(),把商业化路径吃掉。
    // 商用 v3:容器内 gateway 作为 server 接收 bridge client 转发的 user 帧。
    // 用户允许单附件 200 MiB / 总 300 MiB,base64 后 ≈ 400 MiB + envelope → 448 MiB。
    // ws 默认 maxPayload=100 MiB 会让 Receiver 对大附件帧直接 RangeError 关连接。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 448 * 1024 * 1024 })
    this.httpServer.on('upgrade', (req, socket, head) => {
      // 1) 商业化模块优先(/ws/user-chat-bridge / /ws/agent / 未来私有路径)
      try {
        if (this.deps.commercial?.handleWsUpgrade(req, socket, head)) return
      } catch (err) {
        this.log.error('commercial.handleWsUpgrade threw', undefined, err)
        try { socket.destroy() } catch {}
        return
      }
      // 2) V5 container-only Chromium preview. The handler itself requires a
      // signed master assertion + exact trusted bridge IP before accepting.
      try {
        if (this._containerPreview.handleUpgrade(req, socket, head)) return
      } catch (err) {
        this.log.error('containerPreview.handleUpgrade threw', undefined, err)
        try { socket.destroy() } catch {}
        return
      }
      // 3) gateway 自身 /ws(浏览器 ↔ gateway 的 ChannelAdapter 协议)
      const url = req.url ?? '/'
      // 只接受 exact `/ws` 或 `/ws?…` 路径,剩余的 4xx + close
      const path = (() => { try { return new URL(url, 'http://x').pathname } catch { return url } })()
      if (path === '/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
        return
      }
      // 4) 不认识的 ws path:401 + close(对齐 ws lib 默认对未匹配路径的处理)
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      } catch {}
    })

    // WS keepalive: ping every 25s, terminate if no pong in 35s
    this._wsKeepaliveTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if ((ws as any)._isAlive === false) {
          ws.terminate()
          continue
        }
        ;(ws as any)._isAlive = false
        ws.ping()
      }
    }, 25_000)

    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req))

    // 启动渠道
    for (const factory of this.deps.channelFactories ?? []) {
      const adapter = factory({ config })
      const ctx: ChannelContext = {
        dispatch: (frame) => this.dispatchInbound(frame, adapter),
        log: {
          // Channel name last so adapter-supplied meta.channel can't spoof it.
          info: (m, meta) => this.log.info(m, { ...(meta ?? {}), channel: adapter.name }),
          error: (m, meta) => this.log.error(m, { ...(meta ?? {}), channel: adapter.name }),
        },
        config: (config.channels as any)[adapter.name] ?? {},
        // Reset session keyed by (channel, peer). Used by channel /new handlers.
        // Destroys every session the router could route this (channel, peer) to.
        resetSession: async (channel, peerId, peerKind) => {
          const safePeer = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
          const prefix = `agent:`
          const suffix = `:${channel}:${peerKind}:${safePeer}`
          const keys: string[] = []
          for (const s of this.sessions.list()) {
            if (s.sessionKey.startsWith(prefix) && s.sessionKey.endsWith(suffix)) {
              keys.push(s.sessionKey)
            }
          }
          for (const k of keys) {
            try { await this.sessions.destroySession(k) } catch {}
            this._outboundRing.clear(k)
          }
          // Refresh size_bytes gauge — without this, a Prometheus scrape
          // after a wipe still reports the pre-clear bytes until the next
          // store/peek path runs.
          outboundRingSizeBytes.value = this._outboundRing.totalBytes()
        },
      }
      try {
        await adapter.init(ctx)
        this.channels.set(adapter.name, adapter)
        this.log.info('channel ready', { channel: adapter.name })
      } catch (err) {
        this.log.error('channel failed to init', { channel: adapter.name }, err)
      }
    }

    this._stopEviction = this.sessions.startEvictionLoop()
    process.once('SIGINT', () => {
      this.shutdown().catch((err) => this.log.error('shutdown error (SIGINT)', undefined, err))
    })
    process.once('SIGTERM', () => {
      this.shutdown().catch((err) => this.log.error('shutdown error (SIGTERM)', undefined, err))
    })


    // Start cron scheduler for reflection jobs (L3)
    // Smart delivery: push to last active channel, fallback to all webchat clients
    const wechatProactiveCfg = readV3WechatProactiveConfig()
    const qqProactiveCfg = readV3QqProactiveConfig()
    this.cron = new CronScheduler(config, this.sessions, async (text, job, delivery) => {
      await deliverCronOutput(text, job, delivery, {
        lastActiveChannel: this.lastActiveChannel,
        clientsByPeer: this.clientsByPeer as CronDeliverDeps['clientsByPeer'],
        channels: this.channels as CronDeliverDeps['channels'],
        deliver: (msg) => this.deliver(msg as OutboundMessage),
        makePeerKey: (userId, channel, peerId) => Gateway.makePeerKey(userId, channel, peerId),
        qqProactiveCfg,
        wechatProactiveCfg,
        sendQqProactive: sendV3QqProactive,
        sendWechatProactive: sendV3WechatProactive,
        postInboxDurable: postInboxMessageDurable,
      })
    }, (job, delivery) => this.injectCronOriginSession(job, delivery))
    this.cron.setProjectPorts(this.cronProjectPorts())
    this.cron.lastActiveChannel = this.lastActiveChannel
    this.cron.getRegisteredDeliverChannels = () => this.channels.keys()
    this.cron.start().catch((err) => this.log.error('cron start failed', undefined, err))
    if (isDelegateSmEnabled()) {
      this.cron.delegateJobs = this._ensureDelegateJobStore()
    }

    // Start event persistence (writes all events to SQLite event_log)
    startEventPersistence()

    // Exact memory usage + current-fact freshness shadow. Fail-open observers
    // never alter turn execution or user-visible memory results.
    startMemoryTurnObserver()
    startMemoryUsageReporter()

    // Start metrics collection (eventBus → prometheus counters)
    startMetricsCollection()

    // Commercial container telemetry: privacy-safe call rollups + failure rows.
    this._toolFailureReporter = startToolFailureReporter()

    // Commercial container product signal: hub skill_view → master marketplace usage.
    // 默认开(OC_MARKET_SKILL_USAGE!='0');resolveTraceId 从活跃 session 读本 turn 的
    // canonical traceId 作评分归因键(engine 中立、只透传不铸造)。
    startSkillUsageReporter({
      resolveTraceId: (sessionKey) => this.sessions.getByKey(sessionKey)?._currentTurnTraceId ?? null,
    })

    // Retrieval quality shadow: strict opt-in via OC_SKILL_SHADOW_SAMPLE_RATE.
    // The observer never mutates prompt/tool state and never blocks dispatchInbound;
    // it only reads the same agent-visible metadata used by the SKILLS slot.
    this._skillShadowReporter = startSkillShadowReporter({
      resolveTraceId: (sessionKey) => this.sessions.getByKey(sessionKey)?._currentTurnTraceId ?? null,
    })

    // Start rate limiter cleanup
    this.rateLimiter.startCleanup()

    // EventBus: bridge CCB CronCreate/CronDelete to gateway CronScheduler
    eventBus.on('task.created', (ev) => {
      if (!this.cron || ev.source !== 'cron-bridge') return
      if (isHiddenSystemAgentId(ev.agentId)) {
        this.log.warn('eventBus task.created hidden system agent rejected', {
          taskId: ev.taskId,
          agentId: ev.agentId,
        })
        return
      }
      // Use taskId directly — sessionManager already generates unique ccb-xxx IDs
      this.cron
        .addJob({
          id: ev.taskId,
          schedule: ev.schedule || '* * * * *',
          agent: ev.agentId,
          prompt: ev.prompt,
          deliver: 'webchat',
          enabled: true,
          oneshot: ev.oneshot ?? true,
          label: ev.prompt.slice(0, 50),
          // Same creation stamp as the /api/cron path — every user-facing cron
          // entry point must set createdAt so catch-up can't backfire pre-creation.
          createdAt: Date.now(),
        })
        .then(() =>
          this.log.info('eventBus task.created → gateway job', { taskId: ev.taskId }),
        )
        .catch((err) =>
          this.log.warn('eventBus task.created failed', { taskId: ev.taskId }, err),
        )
    })
    eventBus.on('task.deleted', (ev) => {
      if (!this.cron) return
      this.cron
        .removeJob(ev.taskId)
        .then((ok) =>
          this.log.info('eventBus task.deleted', {
            taskId: ev.taskId,
            result: ok ? 'removed' : 'not found',
          }),
        )
        .catch((err) =>
          this.log.warn('eventBus task.deleted failed', { taskId: ev.taskId }, err),
        )
    })

    // Start webhook router
    this.webhookRouter = new WebhookRouter()
    await this.webhookRouter.load()
    this.log.info('webhooks loaded', { count: this.webhookRouter.list().length })

    // EventBus: route webhook.received → agent execution + delivery
    eventBus.on('webhook.received', (ev) => {
      const { webhookId, agentId, payload } = ev
      if (isHiddenSystemAgentId(agentId)) {
        this.log.warn('webhook hidden system agent rejected', { agentId, webhookId })
        return
      }
      const { resolvedPrompt } = payload as any
      ;(async () => {
        const cfg = await this._getAgentsConfig()
        const agent = cfg.agents.find((a) => a.id === agentId)
        if (!agent) {
          this.log.warn('webhook agent not found', { agentId, webhookId })
          return
        }
        const sessionKey = `agent:${agentId}:webhook:${webhookId}:${Date.now()}`
        // 合成首帧路由字段补齐(同 cron):webhook 触发的会话首帧绕过 master bridge
        // 计费编排,落 codex 会被 CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。
        const _whRoute = resolveSyntheticTurnModel(agent, this.deps.config.defaults.model)
        // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影
        // (归一 / 可用性 / engine 全取投影;拉不到 → 抛 → 本次 webhook 执行失败并记日志,
        // 不回落 baked)。flag 未开 → undefined,沿用上面的 baked 合成降级,零变化。
        const _whExec = await resolveLocalExecutionIfEnforced({
          agent,
          kind: 'synthetic',
          model: _whRoute?.model,
          defaultModel: this.deps.config.defaults.model,
        })
        const _whModel = _whExec?.canonicalModel ?? _whRoute?.model
        const session = await this.sessions.getOrCreate({
          sessionKey,
          agent,
          ...(_whModel ? { model: _whModel } : {}),
          ...localExecutionOverride(_whExec),
          channel: 'webhook',
          peerId: webhookId,
          title: `[webhook] ${webhookId}`,
        })
        // MAJOR-2 透明化:降级不静默 —— effective_model 落 runLog(doctor 面可见)。
        const _whRun = this._runLog.start({
          agentId,
          sessionKey,
          taskType: 'webhook',
          ...(_whRoute ? { effectiveModel: _whRoute.model } : {}),
        })
        let output = ''
        let _whError = ''
        try {
          await this.sessions.submit(
            session,
            resolvedPrompt,
            (e) => {
              if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
              if (e.kind === 'error') _whError = e.error
            },
            undefined,
            _whModel,
          )
          this._runLog.complete(_whRun, {
            status: _whError ? 'failed' : 'completed',
            error: _whError || undefined,
          })
        } catch (err: any) {
          _whError = _whError || String(err)
          this._runLog.complete(_whRun, { status: 'failed', error: _whError })
        }
        // Deliver to last active webchat
        if (output.trim()) {
          const lastActive =
            this.lastActiveChannel.get(agentId) || this.lastActiveChannel.get('main')
          if (lastActive) {
            // Route through deliver() so the server-assigned ts gets stamped —
            // otherwise the web client's stale-final guard has nothing to compare
            // against and every webhook-delivered isFinal bypasses the guard.
            this.deliver({
              type: 'outbound.message' as const,
              sessionKey: lastActive.sessionKey,
              channel: 'webchat' as const,
              peer: { id: lastActive.peerId, kind: 'dm' as const },
              blocks: [
                { kind: 'text' as const, text: `🔔 **Webhook ${webhookId}**\n\n${output.trim()}` },
              ],
              isFinal: true,
              _userId: lastActive.userId,
            } as OutboundMessage)
          }
        }
      })().catch((err) =>
        this.log.error('webhook execution failed', { webhookId, agentId }, err),
      )
    })

    // TaskStore: schedule-triggered tasks run alongside cron (check every 60s)
    this._taskSchedulerTimer = setInterval(() => {
      this._tickScheduledTasks().catch((err) =>
        this.log.error('task-scheduler tick failed', undefined, err),
      )
    }, 60_000)

    // 商业版容器由 master 注入 OC_TASKBOARD_ENABLED=0(taskboardEnv.ts):不起巡检、不发简报。
    // 只关后台自动化,/api/board/* 仍在(project-context / MCP 复用)。
    if (isTaskboardEnabled()) {
      // Taskboard 统一巡检 tick:一个 60s 定时器扫全部 stage,不按 stage 建 cron job。
      // 通知复用 onDeliver 瀑布(微信接管则不再推站内信);熔断 warning 走 createInboxMessage。
      const taskboardNotify = new TaskboardNotifier({
        getDb: () => getTaskboardDb(),
        log: (msg, extra) => this.log.warn(msg, extra),
        transport: {
          sendWechat: async ({ text, outboundId }) => {
            const cfg = readV3WechatProactiveConfig()
            if (!cfg) return { kind: 'fallback' as const, marked: false }
            return sendV3WechatProactive({ config: cfg, text, outboundId })
          },
          postInbox: async ({ title, bodyMd, deliveryKey }) => {
            try {
              return await postInboxMessageDurable({ title, bodyMd, deliveryKey })
            } catch (err) {
              this.log.warn('taskboard inbox durable failed', {
                deliveryKey,
                err: String(err),
              })
              return false
            }
          },
          createInboxMessage: async (args) => {
            try {
              return await postInboxAlertDurable(args)
            } catch (err) {
              this.log.warn('taskboard inbox-alert durable failed', {
                deliveryKey: args.deliveryKey,
                err: String(err),
              })
              return false
            }
          },
        },
      })
      this._taskboardPatrol = new PatrolEngine({
        getDb: () => getTaskboardDb(),
        delegate: (input) => this._runTaskboardDelegate(input),
        log: (msg, extra) => this.log.info(msg, extra),
        notify: taskboardNotify,
        onAlert: (alert) => {
          this.log.warn('taskboard guardrail', {
            kind: alert.kind,
            outboundId: alert.outboundId,
            message: alert.message,
            stageId: alert.stageId,
            ticketId: alert.ticketId,
          })
          void taskboardNotify.onGuardrailAlert(alert)
        },
      })
      setPatrolExecutionHandler((job) => {
        void this._taskboardPatrol?.executeJob(job).catch((err) =>
          this.log.error('taskboard patrol job failed', undefined, err),
        )
      })
      this._taskboardTickTimer = setInterval(() => {
        this._taskboardPatrol?.tick().catch((err) =>
          this.log.error('taskboard tick failed', undefined, err),
        )
      }, 60_000)
      this._taskboardTickTimer.unref()
    } else {
      this.log.info('taskboard automation disabled (OC_TASKBOARD_ENABLED=0)')
    }

    // Invalidate task cache when tasks are created or deleted
    eventBus.on('task.created', () => this._invalidateTaskCache())
    eventBus.on('task.deleted', () => this._invalidateTaskCache())

    // EventBus: webhook.received can also trigger webhook-type tasks
    eventBus.on('webhook.received', (ev) => {
      this._getCachedTasks()
        .then((tasks) => {
          for (const t of tasks) {
            if (
              t.trigger === 'webhook' &&
              t.webhookId === ev.webhookId &&
              t.status !== 'disabled'
            ) {
              this._triggerTask(t.id).catch(() => {})
            }
          }
        })
        .catch(() => {})
    })

    // EventBus: catch-all listener for event-triggered tasks (uses cached task list)
    eventBus.on('*', (ev) => {
      this._getCachedTasks()
        .then((tasks) => {
          for (const t of tasks) {
            if (t.trigger === 'event' && t.eventType === ev.type && t.status !== 'disabled') {
              this._triggerTask(t.id).catch(() => {})
            }
          }
        })
        .catch(() => {})
    })

    // Handle subprocess crashes: push a system message to the client so they know
    // the session will auto-recover on the next message they send
    eventBus.on('session.crashed', (ev) => {
      // Route through deliver() so the ts-stamp path is the single source of truth
      // for stale-final ordering. Preserves original semantics (no-op if no
      // clients are connected — deliver() bails early on empty peer set).
      // Cast keeps the legacy `agentId` field the crash notification has always
      // carried; OutboundMessage schema doesn't define it but the client reads
      // it, and the wire format tolerates extra keys.
      this.deliver({
        type: 'outbound.message',
        sessionKey: ev.sessionKey,
        channel: 'webchat',
        peer: { id: ev.peerId, kind: 'dm' },
        agentId: ev.agentId,
        blocks: [
          {
            kind: 'text',
            text: '⚠️ AI 进程异常退出，下一条消息将自动恢复上下文。',
          },
        ],
        isFinal: true,
      } as OutboundMessage)
      this.log.info('pushed crash notification', { peerId: ev.peerId })

      // Ordinary pending permissions die with the subprocess. Detached
      // ask_user cards do not — see `_reapCrashedSessionPendingPermissions`.
      this._reapCrashedSessionPendingPermissions(ev.sessionKey)
    })

    // Periodic OAuth token refresh (every 10 min). Running subprocesses keep
    // the old token until restarted; 401 detection in sessionManager handles
    // the restart + retry when the old token expires mid-conversation.
    this._oauthRefreshTimer = setInterval(() => this.refreshClaudeOAuthIfNeeded().catch(() => {}), 10 * 60_000)
    // Periodic pending-permission janitor: TTL-based auto-deny + orphan cleanup.
    this._pendingPermissionSweepTimer = setInterval(
      () => {
        try { this._sweepStalePendingPermissions() } catch (err) {
          this.log.warn('pending permission sweep failed', undefined, err)
        }
      },
      Gateway.PENDING_PERMISSION_SWEEP_MS,
    )
    // Check immediately on boot
    this.refreshClaudeOAuthIfNeeded().catch(() => {})

    // Converge orphan live streams BEFORE listen: clients that connect the
    // instant the port opens would otherwise page the stale live snapshot and
    // replay frames whose authoritative tape already finalized. One idempotent
    // UPDATE; failure is logged and must not block startup.
    try {
      const { convergeFinalizedTapeLiveStreams } = await import('@openclaude/storage')
      const { converged } = await convergeFinalizedTapeLiveStreams()
      if (converged > 0) {
        this.log.info('converged finalized live streams to tape', { converged })
      }
    } catch (err) {
      this.log.warn('live stream convergence failed', undefined, err)
    }

    const listenOpts = resolveGatewayListen(config.gateway.bind, config.gateway.port)
    await new Promise<void>((res) => {
      if (listenOpts.exclusive) {
        this.httpServer.listen(
          { port: listenOpts.port, host: listenOpts.host, exclusive: true },
          () => res(),
        )
      } else {
        this.httpServer.listen(listenOpts.port, listenOpts.host, () => res())
      }
    })
    this.log.info('server started', { bind: listenOpts.host, port: listenOpts.port })

    // Auto-resume: proactively continue interrupted webchat sessions after gateway restart
    this.bootAutoResume().catch((err) =>
      this.log.error('auto-resume boot failed', undefined, err),
    )
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
    if (this._shutdownPromise) return this._shutdownPromise
    // Set ingress guard FIRST so handlers reject new requests immediately
    this._shuttingDown = true
    this._shutdownPromise = this._doShutdown(exit).catch((err) => {
      try {
        this.log.error('shutdown failed', undefined, err)
      } catch {}
      if (exit) process.exit(1)
    })
    return this._shutdownPromise
  }

  /** True once shutdown has begun; handlers use this to reject new ingress. */
  public get isShuttingDown(): boolean {
    return this._shuttingDown
  }

  private async _doShutdown(exit: boolean): Promise<void> {
    this.log.info('shutting down')

    // ── Stage 1: stop accepting new traffic ──
    // `httpServer.close()` stops accepting new HTTP connections but lets
    // in-flight requests finish. WS upgrade happens via the HTTP server so
    // new WS connections are also refused. Existing handlers additionally
    // check `_shuttingDown` to short-circuit.
    // We capture the close-completion Promise here and await it in Stage 5
    // so the full close lifecycle is awaited before exit.
    let httpCloseDone: Promise<void> = Promise.resolve()
    if (this.httpServer) {
      httpCloseDone = new Promise<void>((resolveClose) => {
        try {
          this.httpServer.close((err) => {
            if (err) this.log.warn('httpServer.close error', undefined, err)
            resolveClose()
          })
        } catch (err) {
          this.log.warn('httpServer.close threw', undefined, err)
          resolveClose()
        }
      })
    }

    // ── Stage 2: stop all background timers ──
    try {
      this._stopEviction?.()
    } catch {}
    this._stopEviction = null
    try {
      await this._persistAndCloseDelegateJobs()
    } catch (err) {
      this.log.error(
        'delegate job snapshot persist failed; keeping in-memory jobs',
        undefined,
        err as Error,
      )
    }
    this._skillShadowReporter?.stop()
    this._skillShadowReporter = null
    if (this._wsKeepaliveTimer !== null) {
      clearInterval(this._wsKeepaliveTimer)
      this._wsKeepaliveTimer = null
    }
    if (this._taskSchedulerTimer !== null) {
      clearInterval(this._taskSchedulerTimer)
      this._taskSchedulerTimer = null
    }
    if (this._taskboardTickTimer !== null) {
      clearInterval(this._taskboardTickTimer)
      this._taskboardTickTimer = null
    }
    setPatrolExecutionHandler(null)
    this._taskboardPatrol = null
    if (this._oauthRefreshTimer !== null) {
      clearInterval(this._oauthRefreshTimer)
      this._oauthRefreshTimer = null
    }
    if (this._pendingPermissionSweepTimer !== null) {
      clearInterval(this._pendingPermissionSweepTimer)
      this._pendingPermissionSweepTimer = null
    }
    try {
      this.cron?.stop()
    } catch (err) {
      this.log.warn('cron stop error', undefined, err)
    }
    // v3 master sink retry queue periodic timer ONLY here. The sink
    // singleton itself MUST stay set until after sessions.shutdownAll()
    // drains turn-end / handleExit-flush callbacks (stage 4) — clearing
    // it now would send late partial-flush writes through the legacy
    // local SQLite path that's permanently empty in v3 commercial,
    // recreating the original data-loss bug. Stopping the periodic timer
    // is fine: it's purely additive (drains entries already on disk
    // from prior boot), and `kick()` is idempotent.
    // Codex R2 BLOCK-2.
    try {
      this._stopV3RetryDrainer?.()
    } catch (err) {
      this.log.warn('v3 retry drainer stop error', undefined, err)
    }
    this._stopV3RetryDrainer = null
    // RFC-v5-durable-turn-dispatch §B4 — 停周期 recovery 定时器(纯附加,清干净不留句柄)。
    if (this._turnDispatchRecoveryTimer) {
      clearInterval(this._turnDispatchRecoveryTimer)
      this._turnDispatchRecoveryTimer = null
    }

    // ── Stage 3: drain channel adapters (Telegram etc.) ──
    for (const ch of this.channels.values()) {
      try {
        await ch.shutdown()
      } catch (err) {
        this.log.warn('channel shutdown error', { channel: ch.name }, err)
      }
    }

    // ── Stage 3.5: V3 2H — drain 商业化模块(close redis/pricing/anthropic proxy/ws bridge) ──
    if (this.deps.commercial) {
      try {
        await this.deps.commercial.shutdown()
      } catch (err) {
        this.log.warn('commercial shutdown error', undefined, err)
      }
    }

    // ── Stage 3.75: close isolated preview Chromium/CDP sessions ──
    try {
      await this._containerPreview.shutdown()
    } catch (err) {
      this.log.warn('container preview shutdown error', undefined, err)
    }

    // ── Stage 4: drain sessions (kill CCB subprocesses, flush resume map) ──
    try {
      await this.sessions.shutdownAll()
    } catch (err) {
      this.log.warn('sessions shutdownAll error', undefined, err)
    }
    try {
      await this.sessions.awaitResumeMapFlush()
    } catch (err) {
      this.log.warn('resume map flush error', undefined, err)
    }
    this._promptQueueCoordinator?.shutdown()
    this._promptQueueCoordinator = null

    // ── Stage 4.25: persist the final tool-call rollup ──
    // Keep the reporter subscribed until every runner has stopped so late
    // tool_result events are included. shutdown() atomically queues+fsyncs the
    // final batch; HTTP delivery may resume from disk on the next boot.
    try {
      await this._toolFailureReporter?.shutdown()
    } catch (err) {
      this.log.warn('tool failure reporter shutdown error', undefined, err)
    }
    this._toolFailureReporter = null

    // ── Stage 4.5: clear v3 master sink singleton ──
    // shutdownAll above internally awaits awaitPendingPersistence(), so
    // every turn-end / handleExit-flush has either landed on master via
    // the sink HTTP POST or has been durably enqueued on disk for
    // retry-on-next-boot. Now safe to disable the write path.
    // Codex R2 BLOCK-2 — kept the kill-switch out of stage 2 and put it
    // here after sessions are fully drained.
    try {
      const { setV3MasterSinkSingleton } = await import('./v3MasterSink.js')
      setV3MasterSinkSingleton(null)
      this._kickV3RetryDrainer = null
    } catch (err) {
      this.log.warn('v3 master sink singleton clear error', undefined, err)
    }

    // ── Stage 5: force-close remaining sockets ──
    // WS: terminate remaining clients so `wss.close()` callback fires promptly.
    // HTTP: `closeAllConnections()` destroys active sockets (e.g. SSE streams)
    //       that would otherwise block the Stage 1 `close()` callback.
    if (this.httpServer) {
      try {
        const closeAll = (this.httpServer as any).closeAllConnections
        if (typeof closeAll === 'function') closeAll.call(this.httpServer)
      } catch (err) {
        this.log.warn('closeAllConnections error', undefined, err)
      }
    }
    const wssCloseDone = new Promise<void>((resolveClose) => {
      if (!this.wss) return resolveClose()
      try {
        for (const ws of this.wss.clients) {
          try { ws.terminate() } catch {}
        }
        this.wss.close((err) => {
          if (err) this.log.warn('wss.close error', undefined, err)
          resolveClose()
        })
      } catch (err) {
        this.log.warn('wss.close threw', undefined, err)
        resolveClose()
      }
    })
    await Promise.allSettled([httpCloseDone, wssCloseDone])
    this.log.info('shutdown complete')
    if (exit) process.exit(0)
  }

  // ───────── HTTP ─────────
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Ingress guard: refuse new work once shutdown has begun
    if (this._shuttingDown) {
      res.statusCode = 503
      res.setHeader('Connection', 'close')
      res.setHeader('Content-Type', 'text/plain')
      res.end('shutting down')
      return
    }

    // V5 direct webpage preview: only the commercial master can reach this
    // signed internal path. It must run before commercial/gateway routing so
    // the user app can never collide with a platform API path.
    try {
      if (this._containerPreview.handleHttp(req, res)) return
    } catch (err) {
      this.log.error('containerPreview.handleHttp threw', undefined, err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end('preview proxy error')
      } else if (!res.writableEnded) {
        try { res.destroy() } catch {}
      }
      return
    }

    // V3 2H: 商业化模块优先 — 其 router 自管 auth + 输入校验 + status code,
    // 返 true 即"已处理",gateway 不再走自家 /api/auth/login 等路径。
    // 必须在 security headers 之前,否则 commercial 自己设置的 CSP/headers 会被覆盖。
    if (this.deps.commercial) {
      const r = this.deps.commercial.handle(req, res)
      if (r === true) return
      if (r && typeof (r as Promise<boolean>).then === 'function') {
        ;(r as Promise<boolean>)
          .then((handled) => {
            if (handled) return
            this._handleHttpAfterCommercial(req, res)
          })
          .catch((err) => {
            this.log.error('commercial.handle threw', undefined, err)
            if (!res.headersSent) {
              try {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'commercial error' } }))
              } catch {}
            } else {
              try { res.end() } catch {}
            }
          })
        return
      }
      // false 同步 → 走 gateway 路由
    }
    this._handleHttpAfterCommercial(req, res)
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
    const reqStart = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const method = req.method ?? 'GET'
    const path = url.pathname

    // M1: Security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // Cloudflare Turnstile widget iframe (challenges.cloudflare.com) needs a
    // handful of sensor/attestation features delegated to it; default deny
    // policy makes the widget hang at "before-interactive" and never produce a
    // token (silent failure — user sees blank widget area). See:
    // https://developers.cloudflare.com/turnstile/troubleshooting/permissions-policy
    // microphone=(self): 允许同源页面用 getUserMedia 录音(语音输入 /ws/voice-transcribe）。
    // 之前 microphone=() 对所有源(含自身)禁用 → 浏览器报 "Permissions policy violation:
    // microphone is not allowed" → 语音输入彻底不可用。用户仍需显式授予麦克风权限,无安全损失。
    res.setHeader('Permissions-Policy', [
      'camera=()', 'microphone=(self)', 'geolocation=()',
      'accelerometer=(self "https://challenges.cloudflare.com")',
      'gyroscope=(self "https://challenges.cloudflare.com")',
      'magnetometer=(self "https://challenges.cloudflare.com")',
      'xr-spatial-tracking=(self "https://challenges.cloudflare.com")',
      'attribution-reporting=(self "https://challenges.cloudflare.com")',
      'private-state-token-issuance=(self "https://challenges.cloudflare.com")',
      'private-state-token-redemption=(self "https://challenges.cloudflare.com")',
    ].join(', '))

    // Instrument response — record metrics after response finishes
    res.on('finish', () => {
      const duration = Date.now() - reqStart
      const status = String(res.statusCode)
      httpRequestsTotal.inc({ method, path: normalizePath(path), status })
      httpRequestDuration.observe(duration, { method, path: normalizePath(path) })
      // Log non-static requests (skip static assets to reduce noise)
      if (shouldLogHttpAccess(path, res.statusCode, duration)) {
        this.log.info('http', { method, path, status: res.statusCode, durationMs: duration })
      }
    })
    // Pre-auth routes (local relays, project search, login): dispatched BEFORE the auth gate: routes/preAuth.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(PRE_AUTH_ROUTES, this.preAuthRoutesIo, req, res, url)) return

    // Routes that need auth
    // All /api/*, /v1/*, and /metrics endpoints require auth except healthz
    const needsAuth =
      (url.pathname.startsWith('/api/') && url.pathname !== '/api/healthz') ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/metrics'
    // v3 file proxy: HOST gateway → container /api/file or /api/media via docker bridge
    // bypasses checkHttpAuth if all four conditions hold (see checkBridgeBypass).
    const bridgeVerified = needsAuth ? this.checkBridgeBypass(req, url) : false
    const delegateAuthedByContext =
      this._isDelegateHttpPath(url.pathname) && this._hasValidDelegateContext(req)
    if (
      needsAuth &&
      !bridgeVerified &&
      !this.checkHttpAuth(req) &&
      !checkLocalBridge(req) &&
      !delegateAuthedByContext
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    // Platform routes (/v1/, auth session/logout, /internal/v3/*): routes/platform.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(PLATFORM_ROUTES, this.platformRoutesIo, req, res, url)) return
    // System routes (web-trace, healthz, metrics, version, doctor, usage, runs): routes/system.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(SYSTEM_ROUTES, this.systemRoutesIo, req, res, url)) return
    // Client session routes (/api/sessions/*): routes/clientSessions.ts (FINDINGS §7 step 2a).
    if (handleClientSessionsHttp(this.clientSessionsIo, req, res, url)) return
    // App config routes (/api/features, /api/config): routes/appConfig.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(APP_CONFIG_ROUTES, this.appConfigRoutesIo, req, res, url)) return
    // Agent routes (agents, persona, memory, auto-dream optimizer, skills, skill eval/training, release jobs, messaging, delegate, advisor, ask-user, collaboration config): routes/agents.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(AGENT_ROUTES, this.agentRoutesIo, req, res, url)) return
    // Workspace API routes (changelog, feedback, search, cron, board, tasks, webhooks, wechat, Claude auth, uploads, media, file): routes/workspaceApi.ts (FINDINGS §7.5 2b).
    if (dispatchRoutes(WORKSPACE_API_ROUTES, this.workspaceApiRoutesIo, req, res, url)) return

    // ── API / WS 404 守卫（仅 spa 模式）────────────────────────────────────
    // 走到这里说明请求未匹配上方任何 /api/* 或 /ws/* 路由(所有已匹配路由都已 return)。
    // spa 模式必须在 SPA fallback 之前对未匹配的 /api/*、/ws/* 显式返回 404 JSON:
    // 否则它们会落到下方 SPA fallback 拿到 index.html(200),新 React client 调错端点
    // 时会把 HTML 当 JSON 解析直接抛错、难定位。
    // 严格 gate 在 staticMode==='spa':vanilla(v3) 分支完全不进此守卫,行为字节级不变
    // (v3 零影响);且只拦"本就该 404 的兜底",不触碰任何已匹配路由。
    if (
      this.deps.staticMode === 'spa' &&
      (url.pathname.startsWith('/api/') ||
        url.pathname === '/ws' ||
        url.pathname.startsWith('/ws/'))
    ) {
      this.sendJson(res, 404, { error: 'not found' })
      return
    }

    // 静态 web UI (with in-memory cache)
    if (this.deps.webRoot) {
      // /admin → /admin.html:React 管理后台是 web-react 的第二 Vite 入口,产物是 dist 里
      // 真实存在的 /admin.html。提供一个无扩展名的 /admin 便捷入口,302 到真实文件后由下方
      // 通用静态服务命中(no-cache,同 index.html);否则 /admin 会落到 SPA fallback 拿到用户端
      // index.html。仅 spa(v5 Aurora)模式:vanilla(v3/personal)产物不含 admin.html。
      if (this.deps.staticMode === 'spa' && url.pathname === '/admin') {
        res.writeHead(302, { Location: '/admin.html' })
        res.end()
        return
      }
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname
      // Cache-Control 按托管模式分流(规则单一权威 = staticCacheControl)。两模式共用下方的
      // ETag/304、路径白名单与 SPA 回退;仅本头不同 → vanilla 分支与历史完全一致(v3 零变化)。
      const cacheHeader = staticCacheControl(safePath, this.deps.staticMode)
      const filePath = resolve(this.deps.webRoot, `.${safePath}`)
      if (filePath.startsWith(resolve(this.deps.webRoot))) {
        if (this._serveStaticCached(filePath, cacheHeader, req, res, mimeFor(filePath))) return
      }
      // SPA fallback — only for navigation requests (no file extension)
      // Static assets (.js/.css/.map/.min.js etc.) should 404, not serve index.html
      const hasExtension = /\.\w+$/.test(url.pathname)
      if (!hasExtension) {
        const indexPath = resolve(this.deps.webRoot, 'index.html')
        if (this._serveStaticCached(indexPath, 'no-cache', req, res, 'text/html')) return
      }
    }
    res.writeHead(404)
    res.end('not found')
  }

  /**
   * 静态文件内存缓存的统一命中+读盘路径(通用静态资产与 SPA fallback 的 index.html 共用)。
   * 缓存条目带源文件 mtimeMs,命中时 stat 回盘比对:dist 被 rsync 覆盖(mtime 变)后
   * 下一个请求即拿到新内容 —— 与 ws/frontendBuild.ts 版本探针同语义自愈,漏重启 master
   * 时不会出现「WS 帧已收敛到新 build、HTTP 却一直吐旧 index.html」的分裂(那种分裂会让
   * 前端 update banner 陷入刷新死循环)。
   * 返回 true = 已响应(200/304);false = 磁盘无此文件,由调用方走兜底/404。
   */
  private _serveStaticCached(
    filePath: string,
    cacheHeader: string,
    req: IncomingMessage,
    res: ServerResponse,
    mime: string,
  ): boolean {
    const cached = this._staticFileCache.get(filePath)
    if (cached && this._staticCacheFreshOnDisk(filePath, cached)) {
      if (req.headers['if-none-match'] === cached.etag) {
        res.writeHead(304)
        res.end()
        return true
      }
      res.writeHead(200, { 'Content-Type': cached.mime, 'ETag': cached.etag, 'Cache-Control': cacheHeader })
      res.end(cached.content)
      return true
    }
    try {
      const s = statSync(filePath)
      if (!s.isFile()) return false
      const content = readFileSync(filePath)
      const etag = `"${createHash('md5').update(content).digest('hex').slice(0, 16)}"`
      if (this._staticFileCache.size >= 200) {
        const firstKey = this._staticFileCache.keys().next().value
        if (firstKey !== undefined) this._staticFileCache.delete(firstKey)
      }
      this._staticFileCache.set(filePath, { content, mime, etag, mtimeMs: s.mtimeMs })
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304)
        res.end()
        return true
      }
      res.writeHead(200, { 'Content-Type': mime, 'ETag': etag, 'Cache-Control': cacheHeader })
      res.end(content)
      return true
    } catch {
      return false
    }
  }

  /** 缓存条目与磁盘是否仍一致(mtimeMs 比对;stat 失败/文件已删 → 视为失效)。 */
  private _staticCacheFreshOnDisk(filePath: string, entry: { mtimeMs: number }): boolean {
    try {
      return statSync(filePath).mtimeMs === entry.mtimeMs
    } catch {
      return false
    }
  }

  /** Extract bearer token from request (header, WS protocol, or cookie). */
  private extractToken(req: IncomingMessage): string {
    const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? ''
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
    const protoToken =
      protocols.includes('bearer') && protocols.length >= 2 ? protocols[protocols.length - 1] : ''
    const cookies = (req.headers.cookie || '').split(';').reduce(
      (acc, c) => {
        const [k, ...v] = c.trim().split('=')
        if (k) acc[k] = v.join('=')
        return acc
      },
      {} as Record<string, string>,
    )
    const cookieToken = cookies.oc_session || ''
    return authHeader || protoToken || cookieToken
  }

  private _isDelegateHttpPath(pathname: string): boolean {
    return _isDelegateHttpPathImpl.call(this as unknown as DelegateRuntimeHost, pathname)
  }

  private _hasValidDelegateContext(req: IncomingMessage): boolean {
    return _hasValidDelegateContextImpl.call(this as unknown as DelegateRuntimeHost, req)
  }

  private checkHttpAuth(req: IncomingMessage): boolean {
    const t = this.extractToken(req)
    // Try JWT first (multi-user mode)
    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt) return true
    // V3 commercial: accept JWTs signed by commercial module's jwtSecret too,
    // otherwise paths that fall through to gateway (e.g. /api/agents,
    // /api/sessions/*, /api/changelog) would 401 right after a successful
    // commercial login and trigger a token-expired redirect storm.
    if (this.verifyCommercialJwt(t) !== null) return true
    // Fall back to legacy single token
    return checkToken(t, this.deps.config.gateway.accessToken)
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
    const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
    const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
    const OC_BRIDGE_NONCE = process.env.OC_BRIDGE_NONCE || ''
    if (!TRUST_BRIDGE_IP || !OC_CONTAINER_ID || !OC_BRIDGE_NONCE) return false
    // Codex R1/R2 SHOULD-3:形态校验与 /healthz 保持一致,防止 env 写错时 bypass 只
    // 看非空就放行(healthz 广播 ready 但 bypass 因细节 reject 会造成哑锁)。
    // 用 net.isIPv4 严格校验,不用松正则 —— out-of-range octet 也要拒。
    if (!isIPv4(TRUST_BRIDGE_IP)) return false
    if (!/^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)) return false
    if (!/^[0-9a-f]{64}$/i.test(OC_BRIDGE_NONCE)) return false
    const remoteIp = req.socket.remoteAddress || ''
    if (remoteIp !== TRUST_BRIDGE_IP && remoteIp !== `::ffff:${TRUST_BRIDGE_IP}`) return false
    const m = req.method || ''
    const p = url.pathname
    if (!matchBridgeApiAllowlist(p, m)) return false
    const hdrId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
    if (hdrId !== OC_CONTAINER_ID) return false
    const hdrNonce = String(req.headers['x-openclaude-bridge-nonce'] ?? '').trim()
    if (!/^[0-9a-f]{64}$/i.test(hdrNonce)) return false
    if (hdrNonce.length !== OC_BRIDGE_NONCE.length) return false
    try {
      return timingSafeEqual(Buffer.from(hdrNonce, 'hex'), Buffer.from(OC_BRIDGE_NONCE, 'hex'))
    } catch {
      return false
    }
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
  private openFileHardened(
    res: ServerResponse,
    realPath: string,
    agentCwds: string[],
    extraAllowed?: (p: string) => boolean,
  ): number | null {
    let fd: number
    try {
      fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return null
    }
    let fdReal: string
    try {
      fdReal = resolveOpenedPath(fd, realPath)
    } catch {
      closeSync(fd)
      res.writeHead(404)
      res.end('not found')
      return null
    }
    // Re-check via fd realpath as fail-closed defense (redundant with caller's
    // upstream check, but cheap). The user-scoped `extraAllowed` predicate
    // covers v3 commercial docker-volume paths for the **current** uid.
    if (fdReal !== realPath || !isFileAllowed(fdReal, agentCwds, extraAllowed) || isFileBlocked(fdReal)) {
      closeSync(fd)
      res.writeHead(403)
      res.end('access denied')
      return null
    }
    return fd
  }

  /** Get authenticated userId from request. Returns 'default' for legacy token auth. */
  private getUserId(req: IncomingMessage): string {
    const t = this.extractToken(req)
    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt?.userId) return jwt.userId
    // Commercial JWT: prefix sub (BIGINT user_id as string) so it cannot
    // collide with personal-version userIds (which are arbitrary usernames).
    // Used as partition key for SQLite client_sessions etc.
    const cm = this.verifyCommercialJwt(t)
    if (cm) return `c:${cm.sub}`
    return 'default'
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
    | { kind: 'legacy'; uploads: string; generated: string }
    | { kind: 'ok'; uid: number; uploads: string; generated: string }
    | {
        kind: 'fail'
        reason: 'remote-host'
        uid: number
        hostUuid: string
        uploads: string
        generated: string
        logCtx: Record<string, unknown>
      }
    | {
        kind: 'fail'
        reason: 'invalid-uid' | 'not-ready' | 'volume-missing' | 'ambiguous' | 'daemon-error'
        logCtx: Record<string, unknown>
      }
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
    if (!token || !this.deps.commercial?.jwtSecret) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    let header: any
    try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) } catch { return null }
    if (header?.alg !== 'HS256') return null
    let actualSig: Buffer
    try { actualSig = Buffer.from(sigB64, 'base64url') } catch { return null }
    const expectedSig = createHmac('sha256', this.deps.commercial.jwtSecret).update(`${headerB64}.${payloadB64}`).digest()
    if (expectedSig.length !== actualSig.length) return null
    if (!timingSafeEqual(expectedSig, actualSig)) return null
    let payload: any
    try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) } catch { return null }
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload?.exp !== 'number' || payload.exp <= now) return null
    if (typeof payload?.sub !== 'string' || payload.sub.length === 0) return null
    if (payload.role !== 'user' && payload.role !== 'admin') return null
    return { sub: payload.sub, role: payload.role, exp: payload.exp }
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
    if ((req.socket as any).encrypted === true) return true
    const remoteAddr = req.socket.remoteAddress ?? ''
    // Trust X-Forwarded-Proto only from loopback (127.x.x.x, ::1, IPv4-mapped ::ffff:127.x.x.x)
    const isLoopback = remoteAddr === '::1' || remoteAddr.startsWith('127.') || remoteAddr.startsWith('::ffff:127.')
    return isLoopback && req.headers['x-forwarded-proto'] === 'https'
  }

  /** Session token lifetime — used for JWT issuance and legacy-mode cookie cap.
   *  Kept in one place so JWT TTL and cookie Max-Age can't drift. */
  private static readonly JWT_TTL_SECONDS = 30 * 86400 // 30 days

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
    const t = this.extractToken(req)
    const secure = this.isHttps(req) ? '; Secure' : ''

    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt && typeof jwt.exp === 'number') {
      // Clamp remaining seconds to [60, JWT_TTL_SECONDS]. Max-Age=0 semantically
      // means "delete cookie"; a positive floor keeps the cookie alive long
      // enough for the client to renew or get a clean 401 on the next request.
      const remaining = jwt.exp - Math.floor(Date.now() / 1000)
      const maxAge = Math.max(60, Math.min(remaining, Gateway.JWT_TTL_SECONDS))
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
      )
      return true
    }
    if (checkToken(t, this.deps.config.gateway.accessToken)) {
      // Legacy raw-token auth. `t` is constant-time equal to the configured
      // accessToken (which came from trusted config), so it's safe to echo
      // into Set-Cookie without further sanitization.
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${Gateway.JWT_TTL_SECONDS}`,
      )
      return true
    }
    // V3 commercial JWT — same Max-Age clamping logic as personal-version JWT.
    const cm = this.verifyCommercialJwt(t)
    if (cm) {
      const remaining = cm.exp - Math.floor(Date.now() / 1000)
      const maxAge = Math.max(60, Math.min(remaining, Gateway.JWT_TTL_SECONDS))
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
      )
      return true
    }
    return false
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
    // eslint-disable-next-line no-console
    console.error('[gateway] internal error:', err)
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
  private async _collectGenSessionExcerpts(
    name: string,
    description: string,
  ): Promise<GenSessionExcerpt[]> {
    const query = buildSessionSearchQuery(name, description)
    if (!query) return []
    let hits: Awaited<ReturnType<typeof searchSessions>>
    try {
      // 多召回一些以吸收 30 天/通道过滤后的损耗。
      hits = await searchSessions(query, MAX_SESSION_EXCERPTS + 5)
    } catch {
      return []
    }
    // 近 30 天 + 排除评测/训练/生成自身通道,取至多 N 个候选(纯逻辑,已单测)。
    const selected = selectUsageSessionHits(hits, Date.now(), MAX_SESSION_EXCERPTS)
    const out: GenSessionExcerpt[] = []
    for (const h of selected) {
      let turns: Awaited<ReturnType<typeof loadSessionTurns>>
      try {
        turns = await loadSessionTurns(h.sessionId)
      } catch {
        continue
      }
      const text = buildSessionExcerpt(turns, SESSION_EXCERPT_MAX_CHARS)
      if (!text) continue
      out.push({ title: h.title, text })
    }
    return out
  }

  /** 生成编排:采集素材 → 单个隔离 turn(deepseek,正常计费)→ 宽容解析+归一化+过格式权威。 */
  private _runSkillEvalGen(run: SkillEvalGenRun, input: { skillMd: string; description: string }): Promise<void> {
    return _runSkillEvalGenImpl.call(this as unknown as SkillHandlersHost, run, input)
  }

  /** 跑一个被测/评分 turn:一次性会话,收最终文本+用量,完了销毁会话释放资源。 */
  private _skillEvalTurn(sessionKey: string, userId: string, prompt: string, model: string, opts: {
      skillEvalExclude?: string
      skillEvalDraft?: { name: string; dir: string }
    }): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }> {
    return _skillEvalTurnImpl.call(this as unknown as SkillHandlersHost, sessionKey, userId, prompt, model, opts)
  }

  private _loadAutoDreamAuditDataset(input: {
    agentId: string
    afterSeq: number | null
    policy: AutoDreamOptimizerPolicy
  }): Promise<AutoDreamAuditDataset> {
    return _loadAutoDreamAuditDatasetImpl.call(this as unknown as AgentHandlersHost, input)
  }

  private _runAutoDreamOptimizerModel(input: AutoDreamOptimizerModelRun, client: AutoDreamOptimizerClient): Promise<string> {
    return _runAutoDreamOptimizerModelImpl.call(this as unknown as AgentHandlersHost, input, client)
  }

  private _hydrateAutoDreamOptimizerProposals(input: {
    runId: string
    agentId: string
    proposals: AutoDreamOptimizerProposal[]
  }): Promise<AutoDreamOptimizerProposal[]> {
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
  private async _trainingAgent() {
    const cfg = await this._getAgentsConfig()
    return cfg.agents.find((a) => a.id === 'main') ?? cfg.agents[0] ?? null
  }

  /**
   * Resolve a run-scoped request: the run must exist AND be owned by the caller.
   * Sends 404/403 and returns null on failure. Every run-scoped endpoint (status,
   * drafts, diff, comment, merge, discard) gates on this so a leaked runId cannot be
   * read or mutated across users.
   */
  private _ownedTrainRun(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): SkillTrainRun | null {
    const run = this.skillTrainJobs.get(runId)
    if (!run) {
      this.sendError(res, 404, 'training run not found')
      return null
    }
    if (run.userId !== this.getUserId(req)) {
      this.sendError(res, 403, 'forbidden')
      return null
    }
    return run
  }

  /**
   * Fold a training session's stream event into the run state. On the agent's `final`
   * event the terminal state is resolved from the ACTUAL staged-draft count (source of
   * truth), not the proposal-call count; other events flow through applyEvent.
   */
  private _onTrainEvent(runId: string, e: SessionStreamEvent): void {
    if (e.kind === 'final') {
      void this.skillTrainJobs.addUsage(runId, e.meta, Date.now())
      void this.skillDrafts
        .listDrafts(runId)
        .then(async (d) => {
          await this.skillTrainJobs.finalize(runId, d.length, Date.now())
          // 训练完成 → 写一条站内信(对话内发起训练的用户多半已离开管理中心;前端发起的
          // 也可能已切走)。draft>0 报草稿数并引导看 diff,draft=0 明确「未产生草稿」。
          // fail-open:postInboxMessage 本就永不抛(缺 master env → no-op),这里再挂一层
          // warn,通知失败绝不影响 finalize / autoEval。
          const doneRun = this.skillTrainJobs.get(runId)
          void postInboxMessage(
            buildSkillTrainCompleteNotice(doneRun?.skillName ?? null, d.length),
          ).catch((err) => this.log.warn('skill train complete inbox notify failed', undefined, err))
          // 评测门(P1):产出草稿且用户启动时同意 autoEval → 自动对目标技能草稿跑
          // draft vs 现版评测。成本已在训练确认对话框中披露(autoEval 开关 + 估算)。
          if (d.length > 0) void this._maybeAutoEvalTrainRun(runId)
        })
        .catch(() => {})
      return
    }
    void this.skillTrainJobs.applyEvent(runId, e, Date.now())
  }

  /** 训练完成后的评测门:仅单技能训练 + autoEval + 有可用用例(草稿附带或技能自带)。 */
  private async _maybeAutoEvalTrainRun(trainRunId: string): Promise<void> {
    const tr = this.skillTrainJobs.get(trainRunId)
    if (!tr || !tr.autoEval || !tr.skillName) return
    const draft = await this.skillDrafts.readDraft(trainRunId, tr.skillName).catch(() => null)
    if (!draft || draft.record.op === 'delete') return
    const store = buildUserSkillStore()
    let evalsRaw =
      draft.evalsJson ??
      ((await store.view(tr.skillName, 'evals/evals.json', { includePlatform: false })) as
        | string
        | null)
    if (typeof evalsRaw !== 'string' || !evalsRaw) return // 无用例 → 不评(前端提示补用例)
    const parsed = parseSkillEvalsJson(evalsRaw)
    if (!parsed.ok) return
    const guard = this.skillEvalJobs.canStart(tr.skillName)
    if (!guard.ok) return
    const run = await this.skillEvalJobs.create({
      runId: SkillEvalJobStore.newRunId(),
      skillName: tr.skillName,
      userId: tr.userId,
      mode: 'draft',
      trainRunId,
      model: SKILL_TRAIN_DEFAULT_MODEL,
      cases: parsed.file.cases,
      now: Date.now(),
    })
    await this.skillTrainJobs.setEvalRunId(trainRunId, run.runId, Date.now())
    void this._runSkillEval(run, {
      draftDir: join(paths.skillDraftRunDir(trainRunId), tr.skillName),
    }).catch((err) => {
      void this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
    })
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
  private async handleAgentMessage(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { message, sourceAgent } = parsed
    if (!message) return this.sendError(res, 400, 'message required')
    if (isHiddenSystemAgentId(targetAgentId)) {
      return this.sendError(res, 404, `agent "${targetAgentId}" not found`)
    }

    // Find target agent
    const cfg = await this._getAgentsConfig()
    const identityProjection = await fetchIdentityCompatProjection()
    const targetIdentity = identityProjection ? resolveIdentityCompat(targetAgentId, identityProjection) : undefined
    if (targetIdentity) assertIdentityCompatReady(targetIdentity)
    const targetAgent = cfg.agents.find((a) => a.id === (targetIdentity?.executionAgentId ?? targetAgentId))
    if (!targetAgent) return this.sendError(res, 404, `agent "${targetAgentId}" not found`)

    const sessionKey = `agent:${targetAgentId}:inter:dm:${sourceAgent || 'system'}`
    this.log.info('inter-agent message', {
      sourceAgent,
      targetAgentId,
      preview: message.slice(0, 60),
    })

    // Create/reuse session for the target agent
    // 合成首帧路由字段补齐(同 cron):agent 间消息的会话首帧绕过 master bridge
    // 计费编排,落 codex 会被 CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。
    const _iaRoute = resolveSyntheticTurnModel(targetAgent, this.deps.config.defaults.model)
    // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影。
    let _iaExec: LocalExecutionDecision | undefined
    try {
      _iaExec = await resolveLocalExecutionIfEnforced({
        agent: targetAgent,
        kind: 'synthetic',
        model: _iaRoute?.model,
        defaultModel: this.deps.config.defaults.model,
      })
    } catch (err) {
      const mapped = this._mapLocalExecutionError(err)
      if (!mapped) throw err
      return this.sendError(res, mapped.httpStatus, mapped.message)
    }
    const _iaModel = _iaExec?.canonicalModel ?? _iaRoute?.model
    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent: targetAgent,
      ...(_iaModel ? { model: _iaModel } : {}),
      ...localExecutionOverride(_iaExec),
      channel: 'inter-agent',
      peerId: sourceAgent || 'system',
      title: `[from ${sourceAgent}] ${message.slice(0, 30)}`,
    })

    // Submit message and collect output
    let output = ''
    await this.sessions.submit(
      session,
      `[来自 agent "${sourceAgent}" 的消息]\n\n${message}`,
      (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
      },
      undefined,
      _iaModel,
    )

    // Push result to user's active channel
    // (MAJOR-2 透明化:降级后的 effective_model 随 API 响应元数据回给调用方,见下方 sendJson。)
    const lastActive =
      this.lastActiveChannel.get('main') || this.lastActiveChannel.values().next().value
    if (lastActive && output.trim()) {
      // Route through deliver() so the ts-stamp happens centrally — bypass here
      // would let inter-agent replies slip past the web client's stale-final guard.
      this.deliver({
        type: 'outbound.message' as const,
        sessionKey: lastActive.sessionKey || `agent:${targetAgentId}:inter:dm:${sourceAgent}`,
        channel: 'webchat' as const,
        peer: { id: lastActive.peerId, kind: 'dm' as const },
        blocks: [
          { kind: 'text' as const, text: `📨 **${targetAgentId}** 回复:\n\n${output.trim()}` },
        ],
        isFinal: true,
        _userId: lastActive.userId,
      } as OutboundMessage)
    }

    this.sendJson(res, 200, {
      ok: true,
      agentId: targetAgentId,
      outputLength: output.length,
      ...(_iaRoute ? { effectiveModel: _iaRoute.model } : {}),
    })
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
  /** P2 债C/3.5 — 单父会话(队长)并行 fan-out 上限。非 review 委派按父分桶计数,
   *  超上限进排队;review 委派豁免此桶(有独立保留槽)。消"一个队长把全局槽占光"。
   *  env 可配(下限 1)。全局上限与 review 保留槽见 delegateCapacity.ts。 */
  private static get MAX_CONCURRENT_DELEGATIONS_PER_PARENT(): number {
    const raw = Number(process.env.OPENCLAUDE_DELEGATE_MAX_PER_PARENT)
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3
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

  private _touchDelegateInflightSurface(input: {
    jobId?: string
    progressRunId?: string
    parentSessionKey?: string
    agentId: string
    goal?: string
    state?: import('@openclaude/protocol').DelegateJobState
    liveHint?: string
    runId?: string
    userId?: string
    nested?: boolean
    ownerRunId?: string
    preserveIdentity?: boolean
  }): void {
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
    return {
      resolveParentEngine: (job: DelegateJobSnapshot) =>
        this._resolveDelegateParentEngine(job.callbackOriginSessionKey ?? job.parentSessionKey) ??
        parseParentEngine(job.parentEngine),
      resolveGoal: (job: DelegateJobSnapshot) =>
        this._activeSendToAgentCallbacks?.get(job.id)?.goal ??
        // Adopted delegate_task rows never registered a send_to_agent intent;
        // the inflight projection still carries the goal (flag-on only).
        this._delegateInflightSurface?.get(job.id)?.goal ??
        undefined,
      resolveCallbackOrigin: (job: DelegateJobSnapshot) => job.callbackOriginSessionKey,
      onDelivered: async (job: DelegateJobSnapshot) => {
        this._activeSendToAgentCallbacks.delete(job.id)
        await removeSendToAgentIntent(job.id)
      },
    }
  }

  private _ensureEngineNotifier(): DefaultEngineNotifier | undefined {
    if (!isDelegateNotifierEffective()) return undefined
    if (this._engineNotifier) return this._engineNotifier
    this._engineNotifier = new DefaultEngineNotifier({
      inlinePush: {
        write: async (event) => {
          const session = this.sessions?.getByKey?.(event.parentSessionKey) as InlinePushSession | undefined
          return writeInlinePushForSession(
            session,
            event,
            formatJobTerminalMarkdown(event),
            process.env,
            {
              isCutoverWindowActive: () => this._delegateJobs?.hasActiveCutoverWindow() === true,
            },
          )
        },
      },
      parentTapeIngestState: async (notifyId, event): Promise<ParentTapeIngestState> =>
        resolveParentTapeIngestState({
          notifyId,
          parentSessionKey: event.parentSessionKey,
          clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
          callbackOriginUserId: event.callbackOriginUserId,
          liveSessionUserId: this.sessions?.getByKey?.(event.parentSessionKey)?.userId,
          envUserId: process.env.OC_USER_ID,
          loadSession: (peerId, userId) => getClientSession(peerId, userId),
        }),
      resumeInject: {
        inject: async (event) => {
          const result =
            event.callback === 'cron-origin-inject'
              ? await this.injectCronOriginFromTerminal(event)
              : await this.injectSendToAgentCallback({
                  parentSessionKey: event.parentSessionKey,
                  jobId: event.jobId,
                  agentId: event.agentId || 'unknown',
                  goal: event.goal || '',
                  ...injectPayloadFromJobTerminal(event),
                  userId: event.callbackOriginUserId,
                  clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
                  once: true,
                })
          if (result.kind === 'injected') return { ok: true }
          if (result.kind === 'retryable_failure' && result.code === 'ORIGIN_SESSION_BUSY') {
            return { ok: false, failureClass: 'internal' as const, busy: true }
          }
          if (result.kind === 'fallback') {
            return { ok: false, failureClass: 'transport' as const, gone: true }
          }
          return { ok: false, failureClass: 'transport' as const }
        },
      },
      onSample: (sample) => {
        delegateNotifyTotal.inc({
          lane: sample.lane,
          ok: sample.ok ? '1' : '0',
          degraded: sample.degraded ? '1' : '0',
        })
        delegateNotifyLatencyMs.observe(sample.latencyMs, { lane: sample.lane })
      },
    })
    return this._engineNotifier
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
    if (this._notifyRetryTimer) {
      clearTimeout(this._notifyRetryTimer)
      this._notifyRetryTimer = undefined
    }
    if (!this._delegateJobs) return
    const notifierOn = isDelegateNotifierEffective()
    if (!notifierOn && !isDelegateDurableEffective()) return
    const delay = notifierOn
      ? delayUntilNextNotifyRetry(this._delegateJobs)
      : delayUntilNextNotifyRetry(this._delegateJobs, Date.now(), {
          callbacks: ['cron-origin-inject'],
          skipLegacyCron: true,
        })
    if (delay == null) return
    this._notifyRetryTimer = setTimeout(() => {
      this._notifyRetryTimer = undefined
      const work = notifierOn
        ? this._retryDelegateNotifies({ dueOnly: true })
        : this._drainFlagOffCronOriginNotifies({ dueOnly: true })
      void work.finally(() => this._armNotifyRetryScheduler())
    }, delay)
    this._notifyRetryTimer.unref()
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
  private _checkDelegateResourceGate(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): DelegateGateBlock | null {
    const isReview = opts?.isReview === true
    const globalCap = delegateConcurrencyCap(isReview)
    if (this._activeDelegations >= globalCap) {
      return { kind: 'concurrency' }
    }
    if (!isReview && opts?.parentBucketKey) {
      const running = (this._runningDelegationsByParent ??= new Map()).get(opts.parentBucketKey) ?? 0
      if (running >= Gateway.MAX_CONCURRENT_DELEGATIONS_PER_PARENT) {
        return { kind: 'concurrency' }
      }
    }
    const pressure = this._readDelegateMemoryPressure()
    const limit = parseDelegateMemoryPressureRatio()
    if (pressure && pressure.ratio >= limit) {
      return {
        kind: 'memory',
        pct: Math.round(pressure.ratio * 100),
        limitPct: Math.round(limit * 100),
      }
    }
    return null
  }

  /** 预占一个并发名额(判定+自增在同一同步段,单线程下原子,等待者间无超发);
   *  被闸拦截则返回原因、不占名额。P2 债C:非 review + 有父桶 → 同步 bump per-parent 运行计数。 */
  private _tryReserveDelegateSlot(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): DelegateGateBlock | null {
    return _tryReserveDelegateSlotImpl.call(this as unknown as DelegateRuntimeHost, opts)
  }

  /** 释放一个已预占的并发名额(全局 + per-parent)。所有过闸后的路径必须经此释放,
   *  与 _tryReserveDelegateSlot 的增量口径严格对称(否则 per-parent 计数漂移锁死后续委派)。 */
  private _releaseDelegateSlot(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): void {
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
  private _waitForDelegateCapacity(args: {
    sessionKey: string
    /** P2 债C/3.5 — per-parent 分桶键(队长会话 sessionKey);缺省 → 只走全局闸。 */
    parentBucketKey?: string
    /** P2 债C — review 委派:走保留槽、豁免 per-parent 桶。 */
    isReview?: boolean
    onQueued?: (blocked: DelegateGateBlock) => void
  }): Promise<
    | { status: 'ok' }
    | { status: 'queue_full'; blocked: DelegateGateBlock }
    | { status: 'timeout'; blocked: DelegateGateBlock; waitedMs: number }
    | { status: 'aborted'; waitedMs: number }
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

  private _formatDelegateConcurrencyReject(opts: {
    isReview: boolean
    parentBucketKey?: string
    waitedS?: number
    queueFull?: boolean
  }): string {
    const perParentMax = Gateway.MAX_CONCURRENT_DELEGATIONS_PER_PARENT
    const perParentInUse =
      !opts.isReview && opts.parentBucketKey
        ? (this._runningDelegationsByParent ??= new Map()).get(opts.parentBucketKey) ?? 0
        : undefined
    return formatDelegateConcurrencyReject({
      isReview: opts.isReview,
      inUse: this._activeDelegations,
      perParentInUse,
      perParentMax,
      waitedS: opts.waitedS,
      queueFull: opts.queueFull,
      queueMaxWaiters: DELEGATE_QUEUE_MAX_WAITERS,
    })
  }

  /**
   * Capacity reject must not leave an executable job, and must not fail a job
   * that already lost the race to claimQueued. Single-threaded Map ops make
   * settle vs claim exclusive; this just chooses drop / fail / already-dispatched
   * on the production write path (not later in the async `.then`).
   */
  private _applyDelegateCapacityReject(input: RunDelegateInput, args: {
      httpStatus: number
      message: string
      failureClass?: DelegateFailureClass
      drop: boolean
    }): DelegateTaskResult {
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
  private _resolveDelegateProgressTarget(args: {
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }): DelegateProgressRouting | null {
    return _resolveDelegateProgressTargetImpl.call(this as unknown as DelegateRuntimeHost, args)
  }

  private _resolveDelegateParent(args: {
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }): {
    sessionKey: string
    repoSessionId?: string
    workspaceMode: 'legacy' | 'isolated_v1'
    billingParentTurnKey?: string
    platformGoal?: GoalStateSnapshot | null
  } | null {
    return _resolveDelegateParentImpl.call(this as unknown as DelegateRuntimeHost, args)
  }

  private _registerActiveDelegation(
    parentSessionKey: string | undefined,
    childSessionKey: string,
  ): (() => void) | null {
    if (!parentSessionKey) return null
    let set = this._activeDelegationsByParent.get(parentSessionKey)
    if (!set) {
      set = new Set<string>()
      this._activeDelegationsByParent.set(parentSessionKey, set)
    }
    set.add(childSessionKey)
    return () => {
      const current = this._activeDelegationsByParent.get(parentSessionKey)
      if (!current) return
      current.delete(childSessionKey)
      if (current.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
    }
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

  private _interruptDelegationsForParent(
    parentSessionKey: string,
    visited = new Set<string>(),
  ): boolean {
    if (visited.has(parentSessionKey)) return false
    visited.add(parentSessionKey)
    const childSessionKeys = this._activeDelegationsByParent.get(parentSessionKey)
    if (!childSessionKeys || childSessionKeys.size === 0) return false

    let interrupted = false
    let attempted = 0
    for (const childSessionKey of [...childSessionKeys]) {
      attempted++
      const descendantInterrupted = this._interruptDelegationsForParent(childSessionKey, visited)
      this._advisorConsultAborts?.get(childSessionKey)?.abort()
      // 还在资源闸排队等待的委派(尚未 spawn,session 不存在):唤醒并中止其等待,
      // 否则 Stop 级联对它不可达,要干等到排队超时。
      const abortQueuedWait = this._delegateQueueWaiters?.get(childSessionKey)
      if (abortQueuedWait) {
        abortQueuedWait()
        interrupted = true
        if (!this.sessions.getByKey(childSessionKey)) {
          childSessionKeys.delete(childSessionKey)
          continue
        }
      }
      if (!this.sessions.getByKey(childSessionKey)) {
        childSessionKeys.delete(childSessionKey)
        interrupted = descendantInterrupted || interrupted
        continue
      }
      interrupted = this.sessions.interrupt(childSessionKey, 'user') || descendantInterrupted || interrupted
    }
    if (childSessionKeys.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
    this.log.info('interrupt_delegations', {
      parentSessionKey,
      attempted,
      ok: interrupted,
    })
    return interrupted
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
    const live = this.sessions.getByKey(`agent:main:webchat:dm:${sessionId}`)
    if (!live || live.agentId !== 'main') return undefined
    if (String(live.userId ?? '') !== String(userId)) return undefined
    return live
  }

  private async _catalogEngineForModel(modelId: string | undefined): Promise<string | undefined> {
    if (!modelId) return undefined
    try {
      const view = await getLocalCatalogView()
      const canonical = view.canonicalize(modelId)
      return view.models.find((row) => row.modelId === canonical || row.modelId === modelId)?.engine
    } catch {
      return undefined
    }
  }

  private async _loadClientSession(sessionId: string, userId: string) {
    return getClientSession(sessionId, userId)
  }

  private async _parentEngineForCollabSession(input: {
    sessionId: string
    userId: string
    req: IncomingMessage
    url: URL
  }): Promise<{ missing: boolean; agentId?: string; engine?: string }> {
    const bridgeVerified = this.checkBridgeBypass(input.req, input.url)
    if (bridgeVerified) {
      const trusted = parseTrustedCollabParentHeaders(input.req.headers as Record<string, unknown>)
      if (!trusted || trusted.sessionId !== input.sessionId) return { missing: true }
      const fromCatalog = await this._catalogEngineForModel(trusted.modelId)
      return { missing: false, agentId: trusted.agentId, engine: fromCatalog }
    }
    const live = this._liveMainSessionForClient(input.sessionId, input.userId)
    let stored: { agentId?: string; modelId?: string } | null | undefined
    try {
      stored = await this._loadClientSession(input.sessionId, input.userId)
    } catch {
      stored = undefined
    }
    if (!stored && !live) return { missing: true }
    const agentId = stored?.agentId || live?.agentId
    if (agentId !== 'main') {
      return { missing: false, agentId, engine: undefined }
    }
    const storedModel = typeof stored?.modelId === 'string' ? stored.modelId.trim() : ''
    const modelId = storedModel || (typeof live?.model === 'string' ? live.model : undefined)
    const fromCatalog = await this._catalogEngineForModel(modelId)
    const engine = fromCatalog || (!storedModel ? live?.providerTag : undefined) || undefined
    return { missing: false, agentId, engine }
  }

  private _projectAdvisorConsultSettled(billing: { requestId?: string }): void {
    _projectAdvisorConsultSettledImpl.call(this as unknown as AdvisorHandlersHost, billing)
  }

  private _collaborationCapabilityFields(input: {
    sessionId?: string
    engine?: string
  }): Record<string, unknown> {
    const gate = advisorConsultParentGate(input.engine)
    return {
      advisorConsultParents: [...ADVISOR_CONSULT_PARENT_ENGINES],
      advisorConsultParentReason: ADVISOR_CONSULT_PARENT_REASON,
      ...(input.engine ? { parentEngine: input.engine } : {}),
      ...(input.sessionId
        ? { advisorConsultAllowed: gate.allowed }
        : {}),
    }
  }

  private _consultWaitMs(): number {
    const raw = Number(this._advisorConsultWaitMs)
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000
  }

  private _adviceFromConsult(record: {
    advice?: string | null
    jobId?: string | null
  }): string {
    return _adviceFromConsultImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _consultJobFailedState(view: {
    status: string
    state?: string
    failure_class?: string
    httpStatus?: number
  }): 'failed' | 'cancelled' | null {
    if (view.status === 'expired') return 'failed'
    if (view.status === 'failed') {
      return view.state === 'cancelled' || view.failure_class === 'cancelled' ? 'cancelled' : 'failed'
    }
    if (view.status === 'done' && (view.failure_class || (typeof view.httpStatus === 'number' && view.httpStatus >= 400))) {
      return view.failure_class === 'cancelled' ? 'cancelled' : 'failed'
    }
    return null
  }

  private _advisorSessionKey(record: { originTurnKey: string; consultId: string }): string {
    return _advisorSessionKeyImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _consultStillLive(record: { originTurnKey: string; consultId: string; jobId?: string | null }): boolean {
    const key = this._advisorSessionKey(record)
    if (this._advisorConsultAborts?.has(key)) return true
    const children = this._activeDelegationsByParent
    if (children) {
      for (const set of children.values()) {
        if (set.has(key)) return true
      }
    }
    const view = record.jobId && this._delegateJobs ? this._delegateJobs.get(record.jobId) : undefined
    return view?.status === 'running' || view?.status === 'queued'
  }

  private _closeStaleConsult(record: import('./advisorConsultStore.js').AdvisorConsultRecord): import('./advisorConsultStore.js').AdvisorConsultRecord {
    return _closeStaleConsultImpl.call(this as unknown as AdvisorHandlersHost, record)
  }

  private _presentConsultBody(current: import('./advisorConsultStore.js').AdvisorConsultRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return _presentConsultBodyImpl.call(this as unknown as AdvisorHandlersHost, current, extra)
  }

  private _presentExistingConsult(input: {
    record: import('./advisorConsultStore.js').AdvisorConsultRecord
    question: string
    concern: string
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    return _presentExistingConsultImpl.call(this as unknown as AdvisorHandlersHost, input)
  }

  private _freezeAdvisorTurn(requested: string): Promise<{ ok: true; advisorModel: string } | { ok: false; error: string }> {
    return _freezeAdvisorTurnImpl.call(this as unknown as AdvisorHandlersHost, requested)
  }

  private _invocationFromLiveConsultTool(parent: {
    runner?: { getPartialSnapshot?: () => { completedTools?: unknown[] } }
  } | undefined): Promise<{ ok: true; invocationId: string } | { ok: false; reason: 'none' | 'ambiguous' }> {
    return _invocationFromLiveConsultToolImpl.call(this as unknown as AdvisorHandlersHost, parent)
  }

  private handleConsultAdvisor(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleConsultAdvisorImpl.call(this as unknown as AdvisorHandlersHost, req, res)
  }

  private _loadConsultHistoryTape(peerId: string, userId: string, turnKey: string) {
    return _loadConsultHistoryTapeImpl.call(this as unknown as AdvisorHandlersHost, peerId, userId, turnKey)
  }

  private _resolveAdvisorConsultExecution(advisorModel: string): Promise<
    | { ok: true; value: AdvisorConsultExecution }
    | { ok: false; error: string; status: number }
  > {
    return _resolveAdvisorConsultExecutionImpl.call(this as unknown as AdvisorHandlersHost, advisorModel)
  }

  private _spawnCcbAdvisorConsult(input: {
    consultId: string
    parent: AgentSession
    originTurnKey: string
    snapshot: ReturnType<typeof buildAdvisorSnapshot>
    execution: AdvisorConsultExecution
    abort?: AbortController
    unregister?: (() => void) | null
  }): Promise<{
    state: string
    advice: string
    jobId?: string
    error?: string
  }> {
    return _spawnCcbAdvisorConsultImpl.call(this as unknown as AdvisorHandlersHost, input)
  }

  private _advisorConsultRouteOverride(route: AdvisorAdmitRouteOk, model: string): import('./engine/codexShared.js').CodexProviderConfigOverride | null {
    return _advisorConsultRouteOverrideImpl.call(this as unknown as AdvisorHandlersHost, route, model)
  }

  private _spawnAdvisorConsult(input: {
    consultId: string
    parent: AgentSession
    originTurnKey: string
    snapshot: ReturnType<typeof buildAdvisorSnapshot>
    requestId: string
    billingApi: typeof defaultDelegateEngineBilling
    abort?: AbortController
    unregister?: (() => void) | null
    codexRoute: import('./engine/codexShared.js').CodexProviderConfigOverride
  }): Promise<{
    state: string
    advice: string
    jobId?: string
    error?: string
    usage?: DurableCodexBilling['usage']
  }> {
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
  private async _tickScheduledTasks(): Promise<void> {
    const tasks = await this._taskStore.list()
    const now = new Date()
    for (const t of tasks) {
      if (t.trigger !== 'schedule' || !t.schedule || t.status === 'disabled') continue
      // Simple minute-level dedup: skip if ran in this minute
      const minuteKey = Math.floor(now.getTime() / 60_000)
      if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === minuteKey) continue
      // Import cronMatches from cron.ts is complex — use a simple check
      // Delegate to CronScheduler's cronMatches by re-importing
      try {
        const { cronMatches } = await import('./cron.js')
        if (cronMatches(t.schedule, now)) {
          this._triggerTask(t.id).catch(() => {})
        }
      } catch {}
    }
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

  private async _acquireSyntheticTurnBarrier(sessionKey: string): Promise<{
    owner: string
    release: () => void
  }> {
    const barriers = (this._syntheticTurnBarriers ??= new Map())
    for (;;) {
      const existing = barriers.get(sessionKey)
      if (!existing) break
      await existing.done
    }
    const owner = `synthetic-${randomBytes(8).toString('hex')}`
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    let released = false
    const release = () => {
      if (released) return
      released = true
      const current = this._syntheticTurnBarriers?.get(sessionKey)
      if (current?.owner === owner) this._syntheticTurnBarriers?.delete(sessionKey)
      resolveDone()
    }
    barriers.set(sessionKey, { owner, done, release })
    return { owner, release }
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
  private injectCcbLocalAgentCallback(args: {
    sessionKey: string
    userId?: string
    taskId: string
    status?: string
    outputFile?: string
    summary?: string
  }): Promise<CronOriginFireResult> {
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
  private injectSendToAgentCallback(args: {
    parentSessionKey?: string
    jobId: string
    agentId: string
    goal: string
    output?: string
    error?: string
    userId?: string
    clientMessageId?: string
    /** Stage 2 notifier: one try, BUSY returns to pending instead of 12-then-fallback. */
    once?: boolean
  }): Promise<CronOriginFireResult> {
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

  private _sendToAgentCallbackTurnAlreadyQueued(args: {
    jobId: string
    userId: string
    sessionKey: string
    sessionId: string
    clientMessageId: string
  }): Promise<boolean> {
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

  private async _refreshToken(
    providerKey: string,
    oauth: { refreshToken: string; scope: string; expiresAt: number },
  ): Promise<void> {
    const prov = this.OAUTH_PROVIDERS[providerKey]
    if (!prov || !prov.tokenUrl) {
      this.log.warn('oauth skipping refresh', {
        provider: providerKey,
        reason: !prov ? 'unknown provider' : 'no tokenUrl configured',
      })
      return
    }

    try {
      const tokenRes = await fetch(prov.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(providerKey === 'claude' ? { 'User-Agent': CLAUDE_OAUTH_USER_AGENT } : {}),
        },
        // 出站硬超时:refresh 挂起会卡住定时续期链路(与 commercial refresh.ts 同款收口)。
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: prov.clientId,
          refresh_token: oauth.refreshToken,
          ...(providerKey === 'claude' ? { scope: prov.scopes } : {}),
        }),
      })

      if (!tokenRes.ok) {
        this.log.error('oauth refresh failed', { provider: providerKey, status: tokenRes.status })
        return
      }

      const tokens = (await tokenRes.json()) as any
      const config = await readConfig()
      if (config) {
        const refreshed = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? oauth.refreshToken,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          scope: tokens.scope ?? oauth.scope,
        }
        if (providerKey === 'claude') config.auth.claudeOAuth = refreshed
        else (config.auth as any)[`${providerKey}OAuth`] = refreshed
        await writeConfig(config)
        this.deps.config = config
        this.sessions.updateConfig(config)
        this.log.info('oauth token refreshed', {
          provider: providerKey,
          expiresInSec: tokens.expires_in,
        })
      }
    } catch (err) {
      this.log.error('oauth refresh error', { provider: providerKey }, err)
    }
  }

  private readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error('body too large'))
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
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
    // 拒帧是安全事件:reason 进日志(运维可见),**不**回给客户端内文
    // (避免把 epoch / challenge / keyId 等内部线索泄漏给容器内的用户 AI)。
    this.log.warn('model_authority.rejected', { code, detail })
    try {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'MODEL_AUTHORITY_REJECTED',
          error: 'model authority rejected',
        }),
      )
    } catch { /* ws may already be closed */ }
  }

  /**
   * RFC-v5-durable-turn-dispatch §3 — durable inbox boot recovery 编排。
   *
   * 注入三个 dep 到协议实现(recoverTurnDispatchInboxOnBoot):本地 retry queue 查同
   * dispatch、master 三态查询、synthetic crashed tape staging(走同一 retry queue,
   * 确定性 payload 来自 inbox 持久化字段)。
   */
  private async _recoverTurnDispatchInbox(
    queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
  ): Promise<void> {
    await recoverTurnDispatchInboxOnBoot({
      retryQueueHasDispatch: (dispatchId, attemptNo) =>
        queue.hasEntryForDispatch(dispatchId, attemptNo),
      queryMasterTapeState: (dispatchId, attemptNo) => queryMasterTapeState(dispatchId, attemptNo),
      // 活执行行一律跳过(§B4 周期 sweep 防误杀在飞 turn);boot 首跑注册表恒空,语义不变。
      isDispatchLive: (dispatchId, attemptNo) => isTurnDispatchLive(dispatchId, attemptNo),
      stageSyntheticCrashedTape: async (row) => {
        const payload = buildSyntheticCrashedTapePayload(row)
        // stageDurable 只需 wire payload;tape 分片在 drain 时由 attemptSend 现算。
        // createdAt 用 inbox 持久化值 → 确定性(多次恢复同 tapeId/hash)。
        await queue.stageDurable({
          schemaVersion: 1,
          payload: { ...payload },
          firstSeenAt: row.createdAt,
          attempts: 0,
        })
        // stage 成功后立即 kick,让 crashed tape 尽快送达 master。
        queue.kick()
      },
      onManualReconcile: (row, reason) => {
        this.log.error('turn dispatch boot recovery: manual reconcile required', {
          dispatchId: row.dispatchId,
          reason,
        })
      },
    })
  }

  /**
   * RFC-v5-durable-turn-dispatch §B4/§B5 — recovery 单飞一轮(boot 首跑 + 周期共用)。
   *
   * single-flight 门闩 `_turnDispatchRecoveryInFlight` 防重入(boot 与周期、周期各轮之间)。
   * 成功跑完一轮 → 置 `_durableTurnDispatchReady`(B5:即便 boot 首跑曾失败,某轮周期成功即自愈)。
   * 检查+置位同步发生(await 前),JS 单线程下并发调用第二个必早退,无竞态。
   */
  private async _runTurnDispatchRecoverySweep(
    queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
  ): Promise<void> {
    if (this._turnDispatchRecoveryInFlight) return
    this._turnDispatchRecoveryInFlight = true
    try {
      await this._recoverTurnDispatchInbox(queue)
      this._durableTurnDispatchReady = true
    } finally {
      this._turnDispatchRecoveryInFlight = false
    }
  }

  /**
   * RFC-v5-durable-turn-dispatch §B4 — 周期 single-flight recovery 重试。
   *
   * boot 首跑只处理"启动瞬间"的 open 行;不可达(recovery_pending)/瞬时写失败留下的
   * 未终局行需要周期重试才能最终收敛(I1 永不静默)。每 60s 一轮:先看是否存在 open 行
   * (无 → 跳过,不空扫),再走单飞 sweep。timer unref 不挡进程退出;shutdown 里清。
   */
  private _startTurnDispatchRecoveryLoop(
    queue: import('./v3MasterRetryQueue.js').V3MasterRetryQueue,
  ): void {
    if (this._turnDispatchRecoveryTimer) return
    // e2e 用 OC_TURN_DISPATCH_SWEEP_MS 压缩 tick 周期复现"sweep 撞在飞 turn"场景;
    // 生产不设 → 60s。clamp 防误配(过小空转,过大失去收敛时效)。
    const envMs = Number(process.env.OC_TURN_DISPATCH_SWEEP_MS)
    const RETRY_MS = Number.isFinite(envMs) && envMs > 0
      ? Math.min(Math.max(envMs, 1_000), 600_000)
      : 60_000
    this._turnDispatchRecoveryTimer = setInterval(() => {
      void (async () => {
        try {
          if (this._turnDispatchRecoveryInFlight) return
          const stats = await turnDispatchInboxStats()
          if (stats.openJobs === 0) return
          await this._runTurnDispatchRecoverySweep(queue)
        } catch (err) {
          this.log.error('turn dispatch periodic recovery sweep failed', undefined, err as Error)
        }
      })()
    }, RETRY_MS)
    this._turnDispatchRecoveryTimer.unref?.()
  }

  /**
   * RFC-v5-durable-turn-dispatch §3.b — 已有 inbox 行时回执给 bridge。
   *
   * bridge 据此 CAS accepted(dispatch 已被容器受理执行,不再开第二条 IIFE)。控制帧,
   * bridge 拦截消费,**绝不**透传给浏览器(同 container_attest)。
   */
  private _sendTurnDispatchReceipt(
    ws: WebSocket,
    ctx: DispatchTurnContext,
    row: Awaited<ReturnType<typeof admitTurnDispatch>>['row'],
  ): void {
    try {
      ws.send(JSON.stringify(buildTurnDispatchReceiptFrame(ctx, row, Date.now())))
    } catch { /* ws may already be closed */ }
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
  private _consumeDispatchAuthority(
    ws: WebSocket,
    frame: Record<string, unknown>,
    isFromBridge: boolean,
  ): boolean {
    if (!isFromBridge || !this._dispatchAuthority.enabled) return true
    const peer = frame.peer as { kind?: unknown } | undefined
    if (frame.channel !== 'webchat' || peer?.kind !== 'dm') return true
    const raw = frame[DISPATCH_AUTHORITY_FIELD]
    if (raw === undefined || raw === null) return true
    const conn = this._authorityConns.get(ws)
    if (!conn) return true
    try {
      // 帧体 hash 断言需真实 content(text + media);computeDispatchRequestHash 只取
      // 内容身份字段(kind + url/base64 摘要),UI-only 字段自动被忽略。
      const content = (frame.content ?? {}) as {
        text?: string
        media?: readonly { kind?: string; url?: string; base64?: string }[]
      }
      // B9:同 turn 的 model-authority descriptor(_consumeFrameAuthority 已在本入口之前消费)
      // 带 billingRequestId 时交叉核对 —— 两票据 master 同事务铸造,billing 身份必一致。
      const modelAuthorityBillingRequestId = getTurnAuthority(frame as object)?.billingRequestId
      const ctx: DispatchTurnContext = this._dispatchAuthority.consume(frame, conn.challenge, content, {
        ...(modelAuthorityBillingRequestId !== undefined ? { modelAuthorityBillingRequestId } : {}),
      })
      attachDispatchContext(frame, ctx)
      return true
    } catch (err) {
      // 带票据的帧消费失败 = 配置漂移(keyring)或篡改。绝不 legacy 执行(master 已建
      // dispatch,legacy 跑完 = 双终态分裂);拒帧后 master reconciler 走 tombstone →
      // not_accepted → 用户可见失败,I1/I2 双保。
      if (err instanceof DispatchRejected) {
        this.log.error('dispatch_authority.rejected: frame refused', { code: err.code })
      } else {
        this.log.error('dispatch_authority.error: frame refused', {
          err: (err as Error)?.message ?? String(err),
        })
      }
      return false
    }
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
    const userId = this.getWsUserId(ws)
    // grace window:hello 后 5s 内,任何 bind 帧引用其 peerIds 视作 authorized。
    // 帮 race:bind 在 hello 之后但 message 注册之前到达。
    const recent = this._recentHelloPeers.get(ws)
    if (recent && Date.now() - recent.recordedAt <= Gateway.REPO_BIND_HELLO_GRACE_MS) {
      if (recent.peerIds.has(sessionId)) return 'authorized'
    }
    // 直查 clientsByPeer:Codex Phase 4.7 #1 — makePeerKey 是 `userId:channel:peerId`
    // (3 parts),不是 4 parts。直接构造预期 key 避免格式漂移 bug。
    // sessionId 已通过 caller 的 SAFE_GIT_REF / SESSION_ID_RE 校验,sanitizePeerId
    // 后等于自身;仍走 sanitize 与 dispatch 路径(L3459-3460)的 makePeerKey 保持一致。
    const sanitizedSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const expectedKey = Gateway.makePeerKey(userId, 'webchat', sanitizedSid)
    const set = this.clientsByPeer.get(expectedKey)
    if (set?.has(ws)) return 'authorized'
    return 'queued'
  }

  /** Phase 4 — bind 帧处理 */
  private async _handleSessionRepoBind(
    ws: WebSocket,
    frame: SessionRepoBindFrame,
  ): Promise<void> {
    // 基础 schema 校验(master bridge 已做严格校验,这里兜底)。
    // Codex Phase 5 review P1:owner/repo/branch typeof + selectionVersion safe-int 必须显式
    // 校验,否则 manager 里 regex.test(undefined) 会把 'undefined' 字符串通过,
    // version 被 NaN/Infinity/小数/负数 污染会进路径和 pending key。
    const isSafePositiveInt =
      typeof frame.selectionVersion === 'number' &&
      Number.isSafeInteger(frame.selectionVersion) &&
      frame.selectionVersion > 0
    const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    if (
      !isNonEmptyStr(frame.sessionId) ||
      !/^[A-Za-z0-9_-]+$/.test(frame.sessionId) ||
      !isSafePositiveInt ||
      !isNonEmptyStr(frame.accessToken) ||
      !isNonEmptyStr(frame.owner) ||
      !isNonEmptyStr(frame.repo) ||
      !isNonEmptyStr(frame.branch)
    ) {
      this._sendStatusFrame(ws, {
        type: 'outbound.control.session_repo_status',
        sessionId: String(frame?.sessionId ?? ''),
        selectionVersion: isSafePositiveInt ? frame.selectionVersion : 0,
        status: 'failed',
        errorCode: 'INVALID_BIND_FRAME',
        errorMessage: 'bind frame schema invalid',
      })
      return
    }
    const auth = this._checkRepoBindSession(ws, frame.sessionId)
    // v1.0.95 诊断 instrument:确认 auth 走了哪条路径(authorized / queued)
    this.log.info('repo_bind_auth_decision', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      auth,
    })
    if (auth === 'queued') {
      // 入 pending 5s 队列
      const key = `${frame.sessionId}|${frame.selectionVersion}`
      // 同 key 已在 pending → 覆盖(用最新 frame)
      const old = this._pendingRepoBinds.get(key)
      if (old) clearTimeout(old.timer)
      const timer = setTimeout(() => {
        this._pendingRepoBinds.delete(key)
        // v1.0.95 诊断 instrument:5s grace 没等到 hello 注册 → 走 fail 路径
        this.log.warn('repo_bind_pending_timeout', {
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
        })
        this._sendStatusFrame(ws, {
          type: 'outbound.control.session_repo_status',
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
          status: 'failed',
          errorCode: 'SESSION_NOT_REGISTERED',
          errorMessage: 'session not registered with this WS within grace window',
        })
      }, Gateway.REPO_BIND_PENDING_TIMEOUT_MS)
      this._pendingRepoBinds.set(key, { ws, frame, timer })
      return
    }
    // authorized → 立即处理
    await this._repoWorkspace.bind(frame, this._buildStatusCallback(ws, frame.sessionId))
  }

  /**
   * Phase 5:bind status 回调统一 wrapper。两个路径共用(立即处理 / pending flush)。
   * 顺序:先 forward 给 ws → 再读 _repoWorkspace 当前 snapshot 触发 recycle。
   * 单进程下 status callback 是 _repoWorkspace 短锁内 commit 后才调,
   * getRepoSnapshot 此时已是最新值,recycle 决策按最新 snapshot 走。
   */
  private _buildStatusCallback(
    ws: WebSocket,
    sessionId: string,
  ): (frame: SessionRepoStatusOut) => void {
    return (statusFrame) => {
      this._sendStatusFrame(ws, statusFrame)
      const snap = this._repoWorkspace.getRepoSnapshot(sessionId)
      this.sessions
        .recyclePeerForRepoChange(sessionId, snap)
        .catch((err) =>
          this.log.warn('recycle_for_repo_change_failed', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
    }
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
  private async _handleSessionRepoUnbind(
    ws: WebSocket,
    frame: { sessionId: string; selectionVersion?: number },
  ): Promise<void> {
    if (typeof frame?.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame.sessionId)) return
    if (
      typeof frame.selectionVersion !== 'number' ||
      !Number.isSafeInteger(frame.selectionVersion) ||
      frame.selectionVersion <= 0
    ) {
      this.log.warn('repo_unbind_invalid_version', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
      })
      return
    }
    // unbind 不要求 ws 注册校验:用户主动清空,任何路径来都允许。
    // Codex Phase 5 review P0:unbind 返 boolean,只在真删 state 时 recycle。
    // stale tombstone(workspace 已被新 version 替换)被 manager ignore 时 caller
    // 必须不 kill runner — 否则旧 v_x runner 被错杀,新 v_y 还在 cloning,下次
    // spawn 读 ready snapshot 走 v_y workspaceDir 而非 v_x。
    const deleted = await this._repoWorkspace.unbind(frame.sessionId, frame.selectionVersion)
    if (!deleted) {
      this.log.info('repo_unbind_skipped_no_recycle', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
      })
      return
    }
    await this.sessions.recyclePeerForRepoUnbind(frame.sessionId).catch((err) =>
      this.log.warn('recycle_for_repo_unbind_failed', {
        sessionId: frame.sessionId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    // 不发 status 帧 — DELETE 已经在 master DB 写 cleared
  }

  /** Phase 4 — hello 到达后,看 pending 队列里有没有匹配的 bind 可以处理 */
  private _flushPendingRepoBinds(ws: WebSocket, peerIds: Set<string>): void {
    if (this._pendingRepoBinds.size === 0) return
    for (const [key, entry] of this._pendingRepoBinds) {
      if (entry.ws !== ws) continue
      if (!peerIds.has(entry.frame.sessionId)) continue
      clearTimeout(entry.timer)
      this._pendingRepoBinds.delete(key)
      // async 处理(不阻塞 hello 转发后续)
      // 用同一个 _buildStatusCallback wrapper:既 forward 给 ws,也触发 recycle。
      this._repoWorkspace
        .bind(entry.frame, this._buildStatusCallback(ws, entry.frame.sessionId))
        .catch((err) =>
          this.log.warn('flush_pending_bind_failed', {
            err: err instanceof Error ? err.message : String(err),
          }),
        )
    }
  }

  /** Phase 4 — send outbound.control.session_repo_status to a single ws,容错 closed/error。 */
  private _sendStatusFrame(ws: WebSocket, frame: SessionRepoStatusOut): void {
    _sendStatusFrameImpl.call(this as unknown as WsConnectionHost, ws, frame)
  }

  /** OCV5-435 — a webchat turn counts as admitted from ws dispatch until it
   * settles, so a Stop that beats its engine run still binds to this turn. */
  private async _dispatchAdmittedClientTurn(frame: InboundFrame): Promise<void> {
    const clientMessageId = (frame as { clientMessageId?: unknown }).clientMessageId
    if (
      frame.type !== 'inbound.message' ||
      frame.channel !== 'webchat' ||
      !isClientMessageId(clientMessageId)
    ) {
      return this.dispatchInbound(frame)
    }
    const key = preStartStopKey(frame.peer.id, clientMessageId)
    const admitted = (this._admittedClientTurns ??= new Map())
    admitted.set(key, (admitted.get(key) ?? 0) + 1)
    this.sessions.adoptPreStartStopOnAdmission(
      frame.peer.id,
      clientMessageId,
      messageSendAttempt((frame as { idempotencyKey?: unknown }).idempotencyKey, clientMessageId),
    )
    try {
      await this.dispatchInbound(frame)
    } finally {
      const left = (admitted.get(key) ?? 1) - 1
      if (left > 0) {
        admitted.set(key, left)
      } else {
        admitted.delete(key)
        this.sessions.clearPreStartStop(frame.peer.id, clientMessageId)
      }
    }
  }

  private handleStop(frame: {
    type: 'inbound.control.stop'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    sessionKey?: string
    clientMessageId?: string
  }): Promise<boolean> {
    return handleStopImpl.call(this as unknown as WsConnectionHost, frame)
  }

  /** Handle permission approval/denial from the web frontend */
  private handlePermissionResponse(frame: {
    type: 'inbound.permission_response'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    requestId: string
    behavior: 'allow' | 'deny'
    message?: string
    /** Optional client-supplied tool input override (currently only used by
     *  AskUserQuestion to carry user-selected `answers` + `annotations`).
     *  Sanitized via `sanitizeAskUserQuestionUpdatedInput` before being
     *  forwarded to CCB; untrusted client fields are dropped. */
    updatedInput?: Record<string, unknown>
  }): Promise<void> {
    return handlePermissionResponseImpl.call(this as unknown as AskUserPermissionsHost, frame)
  }

  /** Broadcast a settlement event to all WS clients at a peerKey.
   *  `answers` is only set for AskUserQuestion allow settlements — lets
   *  other tabs render the collected answers in the permission card, and
   *  lets the sender tab keep its optimistic state in sync if we later
   *  switch semantics (e.g. if answers get server-side post-processing). */
  private _broadcastPermissionSettled(peerKey: string, payload: {
      sessionKey: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      requestId: string
      behavior: 'allow' | 'deny'
      reason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed' | 'user_stop'
      answers?: Record<string, string>
    }): void {
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

  private _promptQueueContext(
    userId: string,
    peerId: string,
    agentId: string,
  ): PromptQueueSessionContext {
    const safeId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return {
      userId,
      owner: {
        sessionKey: `agent:${agentId}:webchat:dm:${safeId}`,
        clientSessionId: peerId,
        agentId,
        peer: { id: peerId, kind: 'dm' },
      },
    }
  }

  private _registerPromptQueueClient(ws: WebSocket, context: PromptQueueSessionContext): void {
    let registered = this._promptQueueClientSessions.get(ws)
    if (!registered) {
      registered = new Set()
      this._promptQueueClientSessions.set(ws, registered)
    }
    if (!registered.has(context.owner.sessionKey)) {
      registered.add(context.owner.sessionKey)
      ws.once('close', () => {
        void this._promptQueueCoordinator?.disconnect(context, ws).catch((err) => {
          this.log.warn('prompt queue disconnect cleanup failed', {
            sessionKey: context.owner.sessionKey,
          }, err as Error)
        })
      })
    }
    const peerKey = Gateway.makePeerKey(context.userId, 'webchat', context.owner.peer.id)
    let set = this.clientsByPeer.get(peerKey)
    if (!set) {
      set = new Set()
      this.clientsByPeer.set(peerKey, set)
    }
    if (set.has(ws)) return
    set.add(ws)
    ws.once('close', () => {
      set?.delete(ws)
      if (set?.size === 0) this.clientsByPeer.delete(peerKey)
    })
  }

  /** If commercial preparation already reserved a slot/precheck/journal but
   * the gateway cannot consume the exact grant, tell that same trusted bridge
   * to unwind immediately. The bridge validates every original correlation
   * field before applying compensation, so a malformed/forged marker is inert. */
  private _sendPromptQueueGrantCancellation(
    ws: WebSocket,
    context: PromptQueueSessionContext,
    markerValue: unknown,
    reasonCode: string,
  ): boolean {
    if (
      !markerValue || typeof markerValue !== 'object' || Array.isArray(markerValue) ||
      !this._bridgeConnections.has(ws) || ws.readyState !== WebSocket.OPEN
    ) return false
    const marker = markerValue as Record<string, unknown>
    if (
      typeof marker.grantId !== 'string' ||
      typeof marker.itemId !== 'string' ||
      typeof marker.contentHash !== 'string' ||
      typeof marker.epoch !== 'string' ||
      typeof marker.claimToken !== 'string'
    ) return false
    const cancel: PromptQueueDispatchCancel = {
      type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
      grantId: marker.grantId,
      owner: context.owner,
      itemId: marker.itemId,
      contentHash: marker.contentHash,
      epoch: marker.epoch,
      claimToken: marker.claimToken,
      reasonCode,
    }
    try {
      ws.send(JSON.stringify(cancel))
      return true
    } catch {
      return false
    }
  }

  private _broadcastPromptQueueSnapshot(
    context: PromptQueueSessionContext,
    snapshot: import('@openclaude/protocol').PromptQueueSnapshot,
  ): void {
    const peerKey = Gateway.makePeerKey(context.userId, 'webchat', context.owner.peer.id)
    this._sendStampedSessionFrame(context.owner.sessionKey, peerKey, snapshot as unknown as Record<string, unknown>)
  }

  private _sendPromptQueueSnapshotToClient(
    _context: PromptQueueSessionContext,
    ws: WebSocket,
    snapshot: import('@openclaude/protocol').PromptQueueSnapshot,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ ...snapshot, ts: Date.now() }))
    } catch {}
  }

  private _sendPromptQueueDispatch(
    context: PromptQueueSessionContext,
    frame: PromptQueueDispatchRequest,
  ): boolean {
    const peerKey = Gateway.makePeerKey(context.userId, 'webchat', context.owner.peer.id)
    const clients = this.clientsByPeer.get(peerKey)
    if (!clients) return false
    const data = JSON.stringify(frame)
    for (const ws of clients) {
      if (!this._bridgeConnections.has(ws) || ws.readyState !== WebSocket.OPEN) continue
      try {
        ws.send(data)
        return true
      } catch {
        // Try another bridge tab before treating the claim as undeliverable.
      }
    }
    return false
  }

  /** Record an authoritative settlement for later replay to late duplicates.
   *  `answers` is carried so that a 3rd tab hitting the already-settled
   *  replay path still sees the collected AskUserQuestion answers. */
  private _recordSettlement(
    requestId: string,
    entry: {
      behavior: 'allow' | 'deny'
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      sessionKey: string
      userId: string
      answers?: Record<string, string>
    },
  ): void {
    // FIFO evict (Map preserves insertion order) to cap memory under burst load.
    while (this._recentSettlements.size >= Gateway.RECENT_SETTLEMENT_MAX) {
      const oldestKey = this._recentSettlements.keys().next().value
      if (oldestKey === undefined) break
      this._recentSettlements.delete(oldestKey)
    }
    this._recentSettlements.set(requestId, { ...entry, ts: Date.now() })
  }

  /** Look up a recent settlement, honoring TTL (returns null if expired). */
  private _lookupSettlement(requestId: string): {
    behavior: 'allow' | 'deny'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    sessionKey: string
    userId: string
    answers?: Record<string, string>
  } | null {
    const e = this._recentSettlements.get(requestId)
    if (!e) return null
    if (Date.now() - e.ts > Gateway.RECENT_SETTLEMENT_TTL_MS) {
      this._recentSettlements.delete(requestId)
      return null
    }
    return {
      behavior: e.behavior,
      channel: e.channel,
      peer: e.peer,
      sessionKey: e.sessionKey,
      userId: e.userId,
      answers: e.answers,
    }
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
  private _finishInWindowAskUserWait(args: {
    req: IncomingMessage
    res: ServerResponse
    waiter: AskUserWaiter
    result: { status: 'answered'; answer: AskUserWaiterAnswer }
    requestId: string
    pending: {
      sessionKey: string
      userId: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
    }
    clientGone: boolean
  }): Promise<void> {
    return _finishInWindowAskUserWaitImpl.call(this as unknown as AskUserPermissionsHost, args)
  }

  /**
   * In-window answer could not be written back to the MCP HTTP caller.
   * Reuse the timeout-then-answer path: tape user-answer row + dispatchInbound.
   */
  private _compensateInWindowAskUserAnswer(pending: {
      sessionKey: string
      userId: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
    }, requestId: string, answer: AskUserWaiterAnswer): Promise<void> {
    return _compensateInWindowAskUserAnswerImpl.call(this as unknown as AskUserPermissionsHost, pending, requestId, answer)
  }

  private _persistDetachedAskUserCard(args: {
    requestId: string
    questions: Array<Record<string, unknown>>
    sessionKey: string
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    expiresAt: number
    agentId: string
  }): Promise<void> {
    return _persistDetachedAskUserCardImpl.call(this as unknown as AskUserPermissionsHost, args)
  }

  private _patchDetachedAskUserResolved(pending: {
      peer: { id: string; kind?: 'dm' | 'group' }
      userId: string
      sessionKey: string
      channel?: string
    }, requestId: string, patch: Record<string, unknown>, userAnswer?: { id: string; text: string; ts?: number }): Promise<void> {
    return _patchDetachedAskUserResolvedImpl.call(this as unknown as AskUserPermissionsHost, pending, requestId, patch, userAnswer)
  }

  private _loadDetachedAskUserCard(sessionId: string, userId: string, requestId: string): Promise<Record<string, unknown> | null> {
    return _loadDetachedAskUserCardImpl.call(this as unknown as AskUserPermissionsHost, sessionId, userId, requestId)
  }

  private _hydrateDetachedAskUserPending(frame: {
    requestId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    /** Stashed by the WS entrypoint from the authenticated connection, never
     *  from the client frame — this is the only user identity we can trust
     *  once the in-memory pending entry is gone (restart / TTL rebuild). */
    _userId?: unknown
  }): Promise<ReturnType<typeof pendingFromDetachedAskUserMessage>> {
    return _hydrateDetachedAskUserPendingImpl.call(this as unknown as AskUserPermissionsHost, frame)
  }

  private async _submitDetachedAskUserAnswer(pending: {
      sessionKey: string
      userId: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
    }, text: string, requestId: string, clientMessageId: string = buildDetachedAskUserAnswerMessageId(requestId)): Promise<void> {
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
  private async bootAutoResume(): Promise<void> {
    const resumableKeys = this.sessions.getResumableKeys((k) => k.includes(':webchat:'))
    if (resumableKeys.length === 0) return

    for (const sessionKey of resumableKeys) {
      // OCV5-428: yield a macrotask per session. The loop runs right after listen();
      // without this the readiness probe (/healthz + WS upgrade) waited ~29s on a
      // 145-session cold start, holding every queued user message.
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (this.sessions.getByKey(sessionKey)) continue

      const parts = sessionKey.split(':')
      const agentId = parts[1]
      if (isHiddenSystemAgentId(agentId)) {
        this.log.warn('auto-resume skipped hidden system agent session', { sessionKey })
        continue
      }
      const peerId = parts.slice(4).join(':')

      this.log.info('auto-resume pre-warming', { sessionKey })
      const cfg = await this._getAgentsConfig()
      const agent = cfg.agents.find((a) => a.id === agentId) ?? ({ id: agentId } as AgentDef)
      // 模型权威 §3:预热也不许查 baked 表(engine/model 取投影)。但预热**不是 turn**——
      // 不执行、不计费 → 不套 codex 真值表(见 decideLocalExecution 的 'prewarm' 语义)。
      // 投影拉不到 → **跳过本次预热**(best-effort:预热失败不该炸 boot 循环;真正的 turn
      // 到来时会重新判定)。绝不回落 baked spawn。
      try {
        const preExec = await resolveLocalExecutionIfEnforced({
          agent,
          kind: 'prewarm',
          defaultModel: this.deps.config.defaults.model,
        })
        await this.sessions.getOrCreate({
          sessionKey,
          agent,
          ...localExecutionOverride(preExec),
          channel: 'webchat',
          peerId,
        })
      } catch (err) {
        this.log.warn(
          'auto-resume pre-warm skipped',
          { sessionKey, code: localExecutionRejectCode(err) ?? 'unknown' },
          err as Error,
        )
        continue
      }
      this.lastActiveChannel.set(agentId, {
        channel: 'webchat',
        peerId,
        sessionKey,
        userId: 'default',
        at: Date.now(),
      })
      this.log.info('auto-resume pre-warmed', { sessionKey })
    }
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

  private _preheatSessionOnOpen(
    sessId: string,
    userId: string,
    row: { agentId?: string; modelId?: string },
  ): void {
    if (process.env.OC_ENGINE_PREHEAT !== '1') return
    const aid = row.agentId || 'main'
    if (isHiddenSystemAgentId(aid)) return
    const stamps = this._sessionOpenPreheatAt ?? (this._sessionOpenPreheatAt = new Map())
    const debounceKey = `${sessId}:${aid}:${row.modelId ?? ''}`
    const now = Date.now()
    const last = stamps.get(debounceKey)
    if (last !== undefined && now - last < SESSION_OPEN_PREHEAT_DEBOUNCE_MS) return
    stamps.set(debounceKey, now)
    if (stamps.size > 256) {
      for (const [k, ts] of stamps) {
        if (now - ts >= SESSION_OPEN_PREHEAT_DEBOUNCE_MS) stamps.delete(k)
      }
    }
    void (async () => {
      if (hasContainerCatalogEnv()) {
        await runSessionPreheat(this as unknown as SessionPreheatHost, sessId, userId, row)
        return
      }
      const hook = this.deps.commercial?.preheatUserContainer
      if (!hook) {
        this.log.info('engine_preheat_skipped', {
          sessionKey: `agent:${aid}:webchat:dm:${sessId}`,
          outcome: 'skipped_no_container_channel',
        })
        return
      }
      await hook({
        userId,
        sessionId: sessId,
        agentId: aid,
        ...(row.modelId ? { modelId: row.modelId } : {}),
      })
    })().catch((err) => {
      this.log.warn('session-open engine preheat failed', { sessId }, err)
    })
  }

  /**
   * POST /internal/v3/engine-preheat。先 200 再异步 spawn:master POST 3s 超时
   * 不能卡在 CCB ~20s 冷启动上。失败只 warn,不再写响应。
   */
  private handleEnginePreheat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleEnginePreheatImpl.call(this as unknown as ChannelHandlersHost, req, res)
  }

  private autoResumeFromHello(peers: Array<{
      peerId: string
      agentId: string
      inFlight?: boolean
      lastFrameSeq?: number
      resumeActiveTurnCandidateMessageIds?: unknown
      inFlightClientMessageId?: string
    }>, ws: WebSocket): Promise<void> {
    return autoResumeFromHelloImpl.call(this as unknown as WsConnectionHost, peers, ws)
  }

  private dispatchInbound(frame: InboundFrame, adapter?: ChannelAdapter): Promise<void> {
    return dispatchInboundImpl.call(this as unknown as InboundDispatchHost, frame, adapter)
  }

  private async _sendAdapterOutboundMessage(
    out: OutboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const { wire } = _stripPrivateRoutingFields(out as unknown as Record<string, unknown>)
    await adapter.send(wire as unknown as OutboundMessage)
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
      | OutboundMessage
      | OutboundError
      | OutboundCodexBilling
      | OutboundExternalEngineBilling
      | OutboundTurnStatus
      | OutboundTurnUsage
      | OutboundCallUsage
      | SysContextRebuilt, adapter?: ChannelAdapter): void {
    deliverImpl.call(this as unknown as WsConnectionHost, out, adapter)
  }
}

// ── V3 S12e CG6 — connection-level trace helpers ──

/**
 * Parse the connection-level trace id from the WS upgrade request headers.
 *
 * Contract:
 *   - `headers` must be a Node `IncomingMessage.headers` value
 *     (keys already lowercased, values `string | string[] | undefined`). We do
 *     NOT case-insensitive match — runtime Node http already canonicalises,
 *     and the symmetric Go side(node-agent CG5)uses CanonicalMIMEHeaderKey
 *     against the *upper-case* header constant for the same reason.
 *   - Multi-value headers(`string[]`)take the first value, matching the Go
 *     ParseHeader "first value unwrap" rule(see protocol/testdata fixture).
 *   - On any `parseTraceIdCandidate` failure we synthesise a fresh
 *     `newTraceId()` so WS upgrade never blocks on bad header — and emit a
 *     `warn` carrying ONLY the issue enum, never the raw header value
 *     (anti-log-injection / log-size DoS).
 *
 * Returns: always a valid trace id string(either the client-supplied one or
 * a fresh fallback).
 *
 * Exported as `_` prefixed test seam — single-call-site internal helper, the
 * underscore signals "do not import from outside gateway".
 */
export function _parseConnectionTraceIdFromUpgrade(
  headers: IncomingHttpHeaders,
  log: Logger,
): string {
  const raw = headers['x-connection-trace-id']
  const candidate = Array.isArray(raw) ? raw[0] : raw
  const result = parseTraceIdCandidate(candidate)
  if (result.ok) return result.traceId
  log.warn('ws.upgrade.connection_trace_invalid', { issue: result.issue })
  return newTraceId()
}

/**
 * Strip the private routing-only fields from any outbound-shaped frame,
 * returning the wire-safe frame and the stripped values.
 *
 * Private fields(all underscore-prefixed):
 *   - `_userId`           — caller-stamped, used by deliver() to scope peerKey
 *   - `_traceId`          — CG7 will stamp(turn-level trace)
 *   - `_connectionTraceId`— CG7 will stamp(connection-level trace)
 *   - `_peerId`           — legacy routing helper(some callers stash this)
 *
 * Why explicit destructure(not a blacklist loop): the field set is small,
 * fixed, and each one has clear ownership.  An explicit destructure creates
 * a single audit point for known private fields — adding a new private field
 * forces an update here, which is the moment we want to review it. (A
 * future typo'd field name on the producer side still requires its own care;
 * this helper is the *known fields* audit point, not a typo shield.)
 *
 * Type-honest generic: returns `Omit<T, '_userId' | ...>` so callers see the
 * private fields removed in the type system, not just at runtime. Two callers
 * use this:
 *   - `deliver()` for `OutboundMessage`-shaped frames(adapter + WS branches)
 *   - `_sendStampedSessionFrame()` for `outbound.permission_request` /
 *     `outbound.permission_settled` / `outbound.model_switch.prepared`
 *     direct-send paths — these frames extend
 *     the same routing tuple but aren't typed as `OutboundMessage`, so we widen
 *     the input to any `Record<string, unknown>` superset.
 */
type PrivateRoutingFields = {
  _userId?: string
  _traceId?: string
  _connectionTraceId?: string
  _peerId?: string
}
export function _stripPrivateRoutingFields<
  T extends Record<string, unknown>,
>(
  out: T,
): {
  wire: Omit<T, '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'>
  userId?: string
  traceId?: string
  connectionTraceId?: string
  peerId?: string
} {
  const {
    _userId,
    _traceId,
    _connectionTraceId,
    _peerId,
    ...wire
  } = out as T & PrivateRoutingFields
  return {
    wire: wire as Omit<
      T,
      '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'
    >,
    userId: _userId,
    traceId: _traceId,
    connectionTraceId: _connectionTraceId,
    peerId: _peerId,
  }
}

// ── V3 S12e CG7 — turn-level trace helpers ──

/**
 * Compute the per-turn trace context at dispatchInbound entry.
 *
 * ── CG7 traceId 双权威源收口(2026-07-10)──
 *
 * turnTraceId 是本 turn 钉在**每一个 outbound 帧**、并折进 messages[i].usage.traceId
 * 成为前端底部"请求ID"展示、也作为 submit 传参传给 runner 的 canonical。它的**唯一
 * 权威源是 master**,不是容器 gateway 自铸。三级优先:
 *
 *   1. master 注入 frame.traceId(权威)—— v5 商业版容器 gateway 只从 master 桥
 *      (commercial userChatBridge CG2a)经 secret 闸收帧。master 在 inbound.message
 *      入口 `newTraceId()` 铸造 canonical,rewrite 注入到转发帧的 `traceId` 字段,并
 *      **同步登记 PG turn_traces 表(CG2d)** —— 那是运维"请求ID一键定位"的唯一持久
 *      落点。容器必须原样采用 master 注入值作为 turnTraceId,前端底部展示的请求ID 才
 *      能与 turn_traces 对上。历史 bug:此函数曾无条件 `newTraceId()` 自铸、无视 master
 *      注入,导致底部请求ID(自造)查 turn_traces(master 登记)查不到(实锤会话
 *      webmrevafa0pvo3qm:底部 cc395cf5… vs turn_traces 5e08cfbc…)。
 *   2. 自铸(fallback)—— 个人版直连场景 master 不注入 frame.traceId(缺省),或注入
 *      值畸形/伪造时,回落 `newTraceId()` 自铸,保证 turn 一定有合法 canonical。
 *   3. clientTraceId 永远只是 observation echo,**绝不**参与 turnTraceId 选取。若 client
 *      提供且合法则原样回显供 submit 层日志关联;非法只记 issue 枚举。
 *
 * 信任边界:容器 gateway 信任 frame.traceId 的前提是 secret 闸保证"只有 master 能送帧"
 * (v5 商业版)。个人版直连场景客户端理论上能在 inbound JSON 里塞 traceId —— 但
 * turnTraceId 只是观测/关联 id(个人版无 master turn_traces 可被冒充),且
 * `parseTraceIdCandidate` 兜底畸形/伪造值(格式合法性 + anti-log-injection),故"信任 +
 * 格式校验"的组合在两种部署形态下都安全。
 *
 * Anti-log-injection:所有 warn ctx 只带 `issue` 枚举,绝不带 raw candidate 值。
 */
export function _buildTurnTraceContext(
  masterRaw: unknown,
  clientRaw: unknown,
  log: Logger,
): { traceId: string; clientTraceId?: string } {
  // ── 权威:master 注入 frame.traceId(合法则直接采用,不再自铸)──
  let turnTraceId: string | undefined
  if (masterRaw !== undefined) {
    const parsedMaster = parseTraceIdCandidate(masterRaw)
    if (parsedMaster.ok) {
      turnTraceId = parsedMaster.traceId
    } else {
      // master 注入值畸形/伪造:回落自铸,只记 issue 枚举(anti-log-injection)。
      log.warn('inbound.master_trace_invalid', { issue: parsedMaster.issue })
    }
  }
  // ── fallback:无 master 注入 / master 注入非法 → 自铸 ──
  if (turnTraceId === undefined) {
    turnTraceId = newTraceId()
  }

  // ── clientTraceId:observation-only echo,与 turnTraceId 选取完全解耦 ──
  if (clientRaw !== undefined) {
    const parsed = parseTraceIdCandidate(clientRaw)
    if (parsed.ok) {
      return { traceId: turnTraceId, clientTraceId: parsed.traceId }
    }
    log.warn('inbound.client_trace_invalid', { issue: parsed.issue })
  }
  return { traceId: turnTraceId }
}

/**
 * Copy the routing tuple(+ public traceId)from the main `out` frame onto a
 * derived outbound frame(outbound.error / outbound.permission_request /
 * outbound.codex_billing).
 *
 * **Explicit field list — not a spread.** We deliberately do NOT
 * `...out` here, because future additions to `out` that are *not* routing
 * fields(e.g. block accumulators, per-turn meta)would otherwise leak into
 * every derived frame. This helper is the single audit point for known
 * routing fields:
 *
 *   - `sessionKey` / `channel` / `peer` — public schema fields used by
 *     `deliver()` to compute peerKey + ring slot.
 *   - `clientMessageId`                — exact browser turn identity.
 *   - `traceId`                        — CG7 public schema field.
 *   - `_userId`                        — private routing stamp consumed by
 *     `_stripPrivateRoutingFields` inside `deliver()`.
 *
 * Adding a new routing field requires updating this helper explicitly. That
 * is the desired property — accidental drift between main and derived frames
 * is the failure mode CG7 is closing.
 */
export function _inheritOutboundRouting(
  out: OutboundMessage & { _userId?: string },
): {
  sessionKey: string
  channel: string
  peer: Peer
  clientMessageId?: string
  _userId?: string
  traceId?: string
} {
  return {
    sessionKey: out.sessionKey,
    channel: out.channel,
    peer: out.peer,
    ...(out.clientMessageId ? { clientMessageId: out.clientMessageId } : {}),
    ...(out._userId ? { _userId: out._userId } : {}),
    ...(out.traceId ? { traceId: out.traceId } : {}),
  }
}

/** gateway 权威预分类码(非 errorClassify 产物)的受控中文文案。errorClassify 的
 *  PATTERNS 只覆盖 provider 原文可识别的码;这些码由编排层(handleExit / tape
 *  终态 / 持久化降级)直接盖章,文案在此单点维护(全角标点,与前端风格对齐)。 */
const GATEWAY_TERMINAL_CODE_MESSAGES: Record<
  Exclude<GatewayTerminalErrorCode, 'user_cancelled'>,
  string
> = {
  runner_crashed: '执行环境意外中断，你的消息已保留，请直接重试本条消息',
  service_restart: '服务正在更新，本轮已中断，请直接重试本条消息',
  engine_error: '任务执行遇到内部错误，请直接重试本条消息',
  auth_error: '模型服务认证失败，请重新登录或检查凭据后重试',
  session_persist_unavailable: '回复已生成，但会话存储暂时不可用，内容已安全排队待写入',
}

/** E4.3 — detail 收口:默认不下发原始 event.error。仅当该码在 taxonomy 中
 *  allowPublicServerMessage 且文本过 isDisplayableServerMessage 守卫时携带
 *  服务端说明;否则只带 traceId(若有)供用户反馈时关联日志。原文只进日志。 */
function _safeErrorFrameDetail(
  code: string,
  rawError: string,
  traceId: string | undefined,
): string | undefined {
  if (turnErrorSemantics(code).allowPublicServerMessage === true && isDisplayableServerMessage(rawError)) {
    return rawError
  }
  return traceId || undefined
}

/** Build the exact structured error wire frame used by dispatchInbound.
 *  参数形状为 GatewayEngineErrorEvent(engine 原生 error 事件 ⊆ 该形状):
 *  sessionManager 经 _asEngineErrorEvent 发射的 gateway 权威终态码在此恢复精度。 */
export function _buildEngineErrorFrame(
  routing: ReturnType<typeof _inheritOutboundRouting>,
  event: GatewayEngineErrorEvent,
): OutboundError & { _userId?: string } {
  if (event.errorCode === 'user_cancelled') {
    // event.error 是 gateway 自产的受控停止文案(「本轮已由用户停止。」),不是
    // 上游原文;detail 保留原值 —— 旧前端 rolling 兼容窗口按该 detail 反推取消。
    return {
      type: 'outbound.error',
      ...routing,
      code: 'user_cancelled',
      message: event.error,
      detail: event.error,
      isFinal: false,
    }
  }
  // gateway 权威终态码(handleExit 分类的 runner_crashed/service_restart、tape
  // AUTH_ERROR、持久化降级 session_persist_unavailable)直接透传,不再被下面的
  // 原文正则分类压成 upstream_failed(E4.2)。
  if (event.errorCode) {
    const detail = _safeErrorFrameDetail(event.errorCode, event.error, routing.traceId)
    return {
      type: 'outbound.error',
      ...routing,
      code: event.errorCode,
      message: GATEWAY_TERMINAL_CODE_MESSAGES[event.errorCode],
      ...(detail !== undefined ? { detail } : {}),
      isFinal: false,
    }
  }
  const preClass = event.errorClass
  const classified =
    preClass && preClass !== 'unknown'
      ? { code: preClass, message: classifiedMessageForCode(preClass) }
      : classifyRunError(event.error)
  const code = classified.code === 'unknown' ? 'upstream_failed' : classified.code
  const detail = _safeErrorFrameDetail(code, event.error, routing.traceId)
  return {
    type: 'outbound.error',
    ...routing,
    code,
    message: classified.code === 'unknown'
      ? '任务执行暂时中断，请直接重试本条消息'
      : classified.message,
    ...(detail !== undefined ? { detail } : {}),
    isFinal: false,
  }
}

/**
 * GatewayTurnPhase → OutboundTurnStatus 判别联合的 status 分支字段。
 * retrying 形态展平为 `status:'retrying'` + 平级 `retry`;compacting/null 为
 * `status` 本身。给「拼装未类型化 wire 对象」的路径用(autoResume 的 JSON.stringify)。
 */
export function _turnStatusWireFields(
  phase: GatewayTurnPhase,
):
  | { status: 'compacting' | 'waiting_for_user' | 'engine_starting' | 'engine_resuming' | null }
  | { status: 'retrying'; retry: TurnRetryMeta }
  | { status: 'working'; detail?: string } {
  if (phase && typeof phase === 'object') {
    if (phase.status === 'working') {
      return phase.detail ? { status: 'working', detail: phase.detail } : { status: 'working' }
    }
    return { status: 'retrying', retry: phase.retry }
  }
  return { status: phase }
}

/**
 * 构造完整 outbound.turn_status wire 帧(带路由继承)。显式按判别联合分支构造,
 * 避免把 union 型 status 字段 spread 进单个 literal(TS 无法归约回 OutboundTurnStatus
 * 判别联合)。`ts`/`frameSeq` 交给 deliver() 落地 stamp。
 */
export function _buildTurnStatusFrame(
  routing: ReturnType<typeof _inheritOutboundRouting>,
  phase: GatewayTurnPhase,
): OutboundTurnStatus & { _userId?: string } {
  if (phase && typeof phase === 'object') {
    if (phase.status === 'working') {
      return {
        type: 'outbound.turn_status',
        ...routing,
        status: 'working',
        ...(phase.detail ? { detail: phase.detail } : {}),
      }
    }
    return { type: 'outbound.turn_status', ...routing, status: 'retrying', retry: phase.retry }
  }
  return { type: 'outbound.turn_status', ...routing, status: phase }
}

/**
 * 早期拒帧(创建 runner 之前的模型路由 / 本地执行拒绝)的结构化双帧构造。
 *
 * 返回**有序**二元组 `[结构化 outbound.error, 兼容 [error] final]`,调用方按序
 * deliver():新客户端识别 outbound.error 渲染红卡 + CTA、按相邻 frameSeq 抑制其后
 * 的裸 `[error]` 文本;旧客户端无视 outbound.error,仍靠 `[error]` final 终止本
 * turn(终止器语义不变)。此处尚无主 `out`,路由字段手工继承入参。
 *
 * `_` 前缀 = 契约测试 seam(锁双帧顺序 + 路由一致)。
 */
export function _earlyRejectErrorFrames(args: {
  sessionKey: string
  channel: string
  peer: Peer
  userId: string
  traceId: string
  code: OutboundError['code']
  message: string
  legacyErrorText: string
}): readonly [OutboundError & { _userId?: string }, OutboundMessage & { _userId?: string }] {
  const structured: OutboundError & { _userId?: string } = {
    type: 'outbound.error',
    sessionKey: args.sessionKey,
    channel: args.channel,
    peer: args.peer,
    code: args.code,
    message: args.message,
    isFinal: false,
    traceId: args.traceId,
    _userId: args.userId,
  }
  const legacyFinal: OutboundMessage & { _userId?: string } = {
    type: 'outbound.message',
    sessionKey: args.sessionKey,
    channel: args.channel,
    peer: args.peer,
    blocks: [{ kind: 'text', text: args.legacyErrorText }],
    isFinal: true,
    traceId: args.traceId,
    _userId: args.userId,
  }
  return [structured, legacyFinal] as const
}

/**
 * GET /api/sessions 的 live/内存会话列表过滤。
 *
 * 巡检 key 必须走 `isPatrolSessionKey`(CORRECTIONS §1.3/§1.4):kind 段是
 * `taskboard`,若只排除 `delegate`,default 用户会把 stageId 误当成 peerId 放进
 * 侧栏。内部委派同样不是用户聊天会话。
 */
/** Replay a prepared native model-switch onto a reconnecting socket.
 *  Ring `peekReplay(fromSeq=0)` is intentionally no_buffer to avoid
 *  duplicate assistant deltas; this control frame is idempotent by requestId. */
export function preparedModelSwitchCatchupFrame(
  session: {
    sessionKey: string
    _modelSwitchTransition?: {
      id: string
      sourceModel: string
      targetModel: string
      state: 'preparing' | 'prepared' | 'consuming'
      expiresAt?: number
    }
  },
  now = Date.now(),
): Record<string, unknown> | null {
  const transition = session._modelSwitchTransition
  if (!transition || transition.state !== 'prepared') return null
  if (typeof transition.expiresAt === 'number' && now >= transition.expiresAt) return null
  return {
    type: 'outbound.model_switch.prepared',
    requestId: transition.id,
    sessionKey: session.sessionKey,
    sourceModel: transition.sourceModel,
    targetModel: transition.targetModel,
    status: 'completed',
    ts: now,
  }
}

/**
 * 构造 sys.context_rebuilt 提示帧(§2.3 boss 硬指标 3)。
 *
 * 路由三件套 + `_userId` + 可选 traceId 从主 `out` 继承(_inheritOutboundRouting,
 * deliver() 会 strip 掉 `_userId`);`ts` 交给 deliver() 落地统一 stamp。返回带
 * `_userId` 私有字段的帧,直接喂 `deliver()`。
 */
export function _buildContextRebuiltFrame(
  out: OutboundMessage & { _userId?: string },
  agentId: string,
  messageCount: number,
): SysContextRebuilt & { _userId?: string } {
  return {
    type: 'sys.context_rebuilt',
    ..._inheritOutboundRouting(out),
    agentId,
    messageCount,
  }
}

// ── active-turn cold replay candidate matching ──

export const ACTIVE_TURN_REPLAY_CANDIDATE_MAX = 32

/** Match a bounded client history hint against the server-owned lock owner.
 * The browser may name candidates, but only the exact runtime marker can
 * authorize a cold replay. Malformed/oversized lists degrade to ordinary
 * cursor replay. */
export function _matchActiveTurnReplayCandidate(
  runningClientMessageId: string | undefined,
  rawCandidates: unknown,
): string | undefined {
  if (!isClientMessageId(runningClientMessageId)) return undefined
  if (
    !Array.isArray(rawCandidates) ||
    rawCandidates.length === 0 ||
    rawCandidates.length > ACTIVE_TURN_REPLAY_CANDIDATE_MAX
  ) {
    return undefined
  }
  return rawCandidates.some(
    (candidate) => isClientMessageId(candidate) && candidate === runningClientMessageId,
  )
    ? runningClientMessageId
    : undefined
}

/** OCV5-427: the exact-turn replay a hello may still get on this socket.
 * One per socket and turn; a repeat ask returns undefined so the caller
 * falls back to the cursor replay instead of resending the whole turn. */
export function _unservedActiveTurnReplay(
  served: WeakMap<object, Set<string>>,
  socket: object,
  sessionKey: string,
  matchedClientMessageId: string | undefined,
): string | undefined {
  if (!matchedClientMessageId) return undefined
  return served.get(socket)?.has(`${sessionKey}\u0000${matchedClientMessageId}`)
    ? undefined
    : matchedClientMessageId
}

/** OCV5-427: record an exact-turn replay that was actually sent on `socket`. */
export function _noteActiveTurnReplayServed(
  served: WeakMap<object, Set<string>>,
  socket: object,
  sessionKey: string,
  clientMessageId: string,
): void {
  let keys = served.get(socket)
  if (!keys) {
    keys = new Set()
    served.set(socket, keys)
  }
  keys.add(`${sessionKey}\u0000${clientMessageId}`)
}

// ── turn-alive-heartbeat (Plan 1) — autoResumeFromHello judgment helper ──

/**
 * Decide whether `autoResumeFromHello` should push a synthetic
 * turn-interrupted `isFinal` to the resuming peer.
 *
 * Background — why this is its own helper(not inlined at the call site):
 *
 * The old judgment was `peerInFlight && !runner.isRunning`. That treats
 * `runner.isRunning` as "turn ended" authority, but `runner.isRunning` is
 * **process-level** truth(`subprocessRunner.ts`: `proc !== null && !closed
 * || starting`). The CCB subprocess can legitimately be in `isRunning=false`
 * mid-turn during these windows:
 *
 *   1. phantom-turn retry — `sessionManager.ts` ~L1386-1424:
 *      `runner.shutdown()` is called and a fresh runner spawned, all inside
 *      the same `submit()` call's try-block.
 *   2. auth-refresh restart — `sessionManager.ts` ~L1445: token refresh
 *      forces a runner restart, also inside the same `submit()`.
 *   3. effort / model swap shutdown — `sessionManager.ts` ~L1196:
 *      `runner.shutdown()` to flip CLI flags, then respawn.
 *
 * If a WS hello arrives in any of these ms-wide windows with `peer.inFlight
 * = true`, the old code pushed a synthetic `isFinal` and the client cleared
 * its sending state — but the CCB respawn then continued the same turn,
 * stranding the user with a "turn is over" UI while gateway was still
 * working. That is the bug Plan 1 fixes.
 *
 * The correct authority is **turn-level**, not process-level:
 * `AgentSession._activeTurnCount` counts in-flight `submit()` promises and
 * stays > 0 across all the windows above(they're inside `submit()`'s
 * try / finally). See `AgentSession._activeTurnCount` jsdoc for the
 * counter's full contract.
 *
 * ── team-durability(2026-07-07)改判据 ──
 *
 * 旧判据还看 `runner.isRunning`(peerInFlight && isRunning → 不推)。这在 warm
 * runner 架构下是死条件:codex app-server 与 warm CCB runner 在 turn **之间**
 * 常驻(isRunning 恒 true),导致"turn 已在服务端正常结束、客户端错过终态帧还
 * 挂着发送态"的会话永远等不到对账 —— 2026-07-07 团队模式事故里客户端重连 6 次
 * 都没被救回,spinner 无限计数。turn 是否在飞的真值源是两个 turn 级计数,进程级
 * isRunning 不再参与判定:turn 活着 ⇒ 必有 submit 在飞 ⇒ engine counter > 0;
 * 团队模式 review 编排窗口(engine turn 已结束、编排未收尾)⇒ client counter > 0。
 * 旧判据护住的三个 respawn 窗口(phantom-turn / auth-refresh / effort swap)全在
 * submit try/finally 内,engine counter 覆盖,语义无回退。
 *
 * Decision table:
 *
 * | peerInFlight | engineTurnCount | clientTurnCount | result |
 * |--------------|-----------------|-----------------|--------|
 * | false        | *               | *               | false (nothing stuck to clear) |
 * | true         | > 0             | *               | false (engine turn in flight) |
 * | true         | *               | > 0             | false (turn 编排在飞,含 review pass) |
 * | true         | 0/undefined     | 0/undefined     | **true** (turn 已终结,客户端悬空) |
 *
 * counters are `undefined` for historical session objects / test fakes —
 * treat as 0(`?? 0`).
 *
 * Exported as `_`-prefixed test seam — single-call-site internal helper,
 * underscore signals "do not import from outside gateway". Pure function,
 * no side effects, no logging — caller owns observability.
 */
export function _shouldPushTurnInterruptedFinal(
  peerInFlight: boolean | undefined,
  engineTurnCount: number | undefined,
  clientTurnCount: number | undefined,
): boolean {
  if (!peerInFlight) return false
  if ((engineTurnCount ?? 0) > 0) return false
  if ((clientTurnCount ?? 0) > 0) return false
  return true
}

/**
 * Identity-bound hello path: ring miss (or V5 master-authoritative lookup which
 * always returns unknown) while this cmid is not `_runningClientMessageId`.
 *
 * Keep `turn_state_unknown` only for the dispatchInbound-before-submit window
 * (counters > 0 but running id not bound yet). Otherwise the producer is gone
 * from this process and leaving unknown keeps the client on 「思考中」 forever.
 */
export function _shouldInterruptUnknownInFlight(input: {
  runningClientMessageId?: string | null
  admittingClientMessageId?: string | null
  inFlightClientMessageId: string
  engineTurnCount?: number
  clientTurnCount?: number
}): boolean {
  if (!input.inFlightClientMessageId) return false
  if (input.runningClientMessageId === input.inFlightClientMessageId) return false
  if (input.admittingClientMessageId === input.inFlightClientMessageId) return false
  if (
    !input.runningClientMessageId
    && !input.admittingClientMessageId
    && ((input.engineTurnCount ?? 0) > 0 || (input.clientTurnCount ?? 0) > 0)
  ) {
    return false
  }
  return true
}

// ── Engine ask_user bridge (cursor MCP) input sanitizer ──

/** Settlement payload handed back to the waiting MCP ask_user HTTP caller. */
export type EngineAskUserSettlement = {
  status: 'answered' | 'skipped' | 'posted'
  answers?: Record<string, string>
  reason?: string
  requestId?: string
  message?: string
}

/**
 * Server-side validator for the engine ask_user bridge. The MCP client is not
 * trusted: clamp counts/lengths and strip unknown keys before the questions
 * enter a pending-permission payload that the web renders (and that
 * sanitizeAskUserQuestionUpdatedInput later keys answers against). Mirrors the
 * MCP-side normalizer in packages/mcp-memory toolDefs.ts — two copies on
 * purpose: different packages, different trust domains, no shared dependency.
 *
 * Returns the normalized product-shape questions array, or null when the input
 * is structurally unusable.
 */
export function sanitizeEngineAskUserQuestions(
  raw: unknown,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null
  const questions: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const question = (item as { question?: unknown }).question
    if (
      typeof question !== 'string' ||
      question.trim().length === 0 ||
      question.length > 2000
    ) {
      return null
    }
    const optionsRaw = (item as { options?: unknown }).options
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2 || optionsRaw.length > 4) return null
    const options: Array<Record<string, unknown>> = []
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null
      const label = (opt as { label?: unknown }).label
      if (typeof label !== 'string' || label.trim().length === 0 || label.length > 300) {
        return null
      }
      const description = (opt as { description?: unknown }).description
      options.push({
        label,
        ...(typeof description === 'string' &&
        description.length > 0 &&
        description.length <= 1000
          ? { description }
          : {}),
      })
    }
    const header = (item as { header?: unknown }).header
    const multiSelect = (item as { multiSelect?: unknown }).multiSelect
    questions.push({
      question,
      ...(typeof header === 'string' && header.length > 0 ? { header: header.slice(0, 12) } : {}),
      ...(multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  return questions
}

// ── AskUserQuestion updatedInput sanitizer ──

/**
 * Hard cap on individual answer / notes / preview string length. Matches the
 * rough upper bound of a reasonable user reply; anything larger is almost
 * certainly abuse / a hostile client trying to blow up the forwarded payload.
 */
const ASK_USER_QUESTION_STRING_MAX_LEN = 8192

/**
 * Sanitize a client-supplied `updatedInput` for the AskUserQuestion tool.
 *
 * The frontend sends `{ answers: { [questionText]: string }, annotations?: {
 * [questionText]: { preview?: string, notes?: string } } }` merged into a
 * copy of the original input. We must not forward arbitrary client data to
 * CCB: an attacker that compromises the websocket could otherwise smuggle
 * tool-schema extras through this path.
 *
 * Rules enforced here (matches the LLM-visible shape of the original CCB
 * `AskUserQuestion` schema):
 *   - Ignore every top-level key in `raw` that is not `answers` or
 *     `annotations`; the rest of the payload is inherited verbatim from the
 *     server-trusted `pending.input`.
 *   - `answers` keys must equal the exact `question` text of one of the
 *     pending questions (CCB uses the question string as the map key).
 *   - `answers` values must be strings, ≤ `ASK_USER_QUESTION_STRING_MAX_LEN`.
 *   - `annotations` keys must also be valid question texts.
 *   - `annotations[q].preview` must equal one of that question's
 *     `options[].preview` — the client is not allowed to invent preview text.
 *   - `annotations[q].notes` must be a short string if provided.
 *
 * Returns `null` when no valid `answers` or `annotations` entries survive
 * sanitization — the caller should treat this as a client error and deny
 * the permission request. (Silently forwarding `pending.input` with empty
 * answers would leave the model unable to tell why the user didn't answer.)
 */
export function sanitizeAskUserQuestionUpdatedInput(
  pendingInput: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const questions = Array.isArray((pendingInput as { questions?: unknown }).questions)
    ? ((pendingInput as { questions: unknown[] }).questions as unknown[])
    : []
  // Map question text → allowed preview strings for that question.
  const previewsByQuestion = new Map<string, Set<string>>()
  const validQuestionTexts = new Set<string>()
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue
    const questionText = (q as { question?: unknown }).question
    if (typeof questionText !== 'string' || questionText.length === 0) continue
    validQuestionTexts.add(questionText)
    const previews = new Set<string>()
    const options = (q as { options?: unknown }).options
    if (Array.isArray(options)) {
      for (const opt of options) {
        if (!opt || typeof opt !== 'object') continue
        const preview = (opt as { preview?: unknown }).preview
        if (typeof preview === 'string' && preview.length > 0) previews.add(preview)
      }
    }
    previewsByQuestion.set(questionText, previews)
  }

  // answers
  const sanitizedAnswers: Record<string, string> = {}
  const rawAnswers = (raw as { answers?: unknown }).answers
  if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (typeof v !== 'string') continue
      if (v.length > ASK_USER_QUESTION_STRING_MAX_LEN) continue
      // Reject blank answers: a whitespace-only string is indistinguishable
      // from "user didn't answer this" for the model, so we treat both as
      // absent. This matches CCB native `AskUserQuestionPermissionRequest`
      // which requires a non-empty selection before enabling submit.
      if (v.trim().length === 0) continue
      sanitizedAnswers[k] = v
    }
  }

  // annotations
  const sanitizedAnnotations: Record<string, { preview?: string; notes?: string }> = {}
  const rawAnnotations = (raw as { annotations?: unknown }).annotations
  if (rawAnnotations && typeof rawAnnotations === 'object' && !Array.isArray(rawAnnotations)) {
    for (const [k, v] of Object.entries(rawAnnotations as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const out: { preview?: string; notes?: string } = {}
      const preview = (v as { preview?: unknown }).preview
      if (typeof preview === 'string' && preview.length <= ASK_USER_QUESTION_STRING_MAX_LEN) {
        const allowed = previewsByQuestion.get(k)
        if (allowed && allowed.has(preview)) out.preview = preview
      }
      const notes = (v as { notes?: unknown }).notes
      if (typeof notes === 'string' && notes.length > 0 && notes.length <= ASK_USER_QUESTION_STRING_MAX_LEN) {
        out.notes = notes
      }
      if (out.preview !== undefined || out.notes !== undefined) {
        sanitizedAnnotations[k] = out
      }
    }
  }

  const hasAnswers = Object.keys(sanitizedAnswers).length > 0
  const hasAnnotations = Object.keys(sanitizedAnnotations).length > 0
  // Require at least one real answer — annotations alone are not a valid
  // submission (the model needs answers, annotations are auxiliary). A
  // client that sent only annotations (or nothing valid) is either buggy
  // or hostile; silently falling back to pending.input would forward an
  // empty-answer AskUserQuestion turn.
  if (!hasAnswers) return null
  return {
    ...pendingInput,
    answers: sanitizedAnswers,
    ...(hasAnnotations ? { annotations: sanitizedAnnotations } : {}),
  }
}

// ── Exported security helpers (tested in security.test.ts) ──

/**
 * Allowlist of directory prefixes from which /api/file may serve files.
 * Static entries cover well-known locations; dynamic entries (agent cwds)
 * are checked separately via `isFileAllowed()`.
 */
export const FILE_ALLOWED_DIRS: string[] = [
  resolve(paths.generatedDir),  // /root/.openclaude/generated/
  resolve(paths.uploadsDir),    // /root/.openclaude/uploads/
]

/** Temp-file prefix pattern: /tmp/openclaude-* (win32: os.tmpdir()/openclaude-) */
const TEMP_PREFIX = openclaudeTempPrefix()

/**
 * v3 Codex sometimes writes a user-requested artifact into its cwd
 * (/opt/openclaude) before reading platform-capabilities. Do not expose the
 * source tree; allow only top-level, non-executable document artifacts.
 */
const OPT_OPENCLAUDE_EXPORT_RE =
  /^\/opt\/openclaude\/[^/\x00-\x1F\x7F]+\.(?:txt|md|csv|pdf|docx?|xlsx?|pptx?|zip|tar|gz)$/i

/** Known project roots that agents may work in (intentionally empty — broad source dirs removed) */
const AGENT_CWD_ROOTS: string[] = []

/** Non-executable media extensions safe to serve from agent CWDs */
const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.webm', '.mov',
  '.pdf', '.txt', '.md', '.csv', '.json', '.log',
])

/**
 * Textual shape of v3 commercial per-user docker volume media paths:
 *   /var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)/...
 *
 * Used as a **hard deny gate** in `isFileAllowed` — any path matching this
 * shape MUST be authorized by the user-scoped predicate (`extraAllowedPredicate`).
 * The static `FILE_ALLOWED_DIRS`, `TEMP_PREFIX`, and agent-CWD branches are NOT
 * allowed to authorize commercial multi-tenant media paths, because those
 * branches are not uid-aware and would re-introduce cross-tenant IDOR if an
 * agent CWD or static dir happened to overlap the volume path shape.
 *
 * Intentionally **broader** than `USER_VOLUME_MEDIA_FILE_REGEX` in
 * commercial/userMedia.ts — this is a fail-closed deny gate, so over-denying
 * the volume path shape is the safe direction:
 *   - matches both the directory itself and any nested file/subpath
 *   - accepts `u0` and leading-zero uids (commercial validates uid form
 *     elsewhere; the gate just refuses to delegate to non-uid-aware branches)
 * Duplicated here so gateway has no reverse import on commercial. If the
 * gate ever needs to match more shapes (e.g. additional subdirs alongside
 * uploads/generated), update both this regex and the commercial-side ones.
 */
// P1d:同时匹配 v3(oc-v3-data)与 v5(oc-v5-data)用户卷媒体路径。这是 fail-closed deny
// gate,over-match 是安全方向 —— 若 v5 路径不被本 gate 捕获,会落到非 uid-aware 的
// FILE_ALLOWED_DIRS/agent-CWD 分支 → v5 媒体跨租户 IDOR。匹配两 channel 前缀即堵死。
const COMMERCIAL_USER_VOLUME_MEDIA_GATE =
  /^\/var\/lib\/docker\/volumes\/oc-v[35]-data-u\d+\/_data\/(uploads|generated)(\/|$)/

/**
 * v3 trusted backend mode — agent OS user home root inside the per-user docker
 * container. Hardcoded by container image contract (entrypoint creates this
 * user; v3supervisor mounts the user volume to `/home/agent/.openclaude/`).
 * Used only by the trusted branch of `isFileAllowed`; legacy/personal-version
 * code never references this constant.
 */
const TRUSTED_CONTAINER_HOME = trustedContainerHome()

/**
 * Call-time check (NOT a module-load const) — tests can flip the env between
 * cases via `process.env.OC_V3_TRUSTED_FILE_SERVE = '1' / delete`.
 * Cost is one string compare per `/api/file` request; negligible.
 */
export function isTrustedContainerFileServeEnabled(): boolean {
  return process.env.OC_V3_TRUSTED_FILE_SERVE === '1'
}

/**
 * Returns true if the resolved absolute path falls within the allowlist.
 * Checked BEFORE the blocklist — if this returns false, the file is denied
 * regardless of blocklist status.
 *
 * `extraAllowedPredicate` is the multi-tenant escape hatch — in v3 commercial,
 * callers construct a **user-scoped** closure via `makeUserScopedMediaPredicate`
 * that restricts to the **current request's** `{uploads, generated}` dirs.
 * Critically NOT a global textual predicate that accepts any user's volume
 * paths — that would let user A read user B's docker volume media by
 * absolute path (cross-tenant IDOR).
 */
export function isFileAllowed(
  resolvedPath: string,
  agentCwds?: string[],
  extraAllowedPredicate?: (p: string) => boolean,
): boolean {
  // 0. **Cross-tenant IDOR hard gate**: paths that look like a v3 commercial
  //    per-user docker volume media path may ONLY be admitted by the
  //    request-scoped predicate. The static / temp / agent-cwd branches
  //    below are not uid-aware and would otherwise let user A read user B's
  //    media if any of those branches' allow-shapes overlap a volume path
  //    (e.g. a misconfigured agent cwd pointing at `/var/lib/docker/volumes/
  //    oc-v3-data-uX/_data`). The predicate captures the **current** user's
  //    resolved {uploads, generated} dirs; without it, deny.
  //
  //    Kept BEFORE the trusted-container branch: in trusted container mode
  //    the agent process never sees host-volume paths (it sees its own
  //    `/home/agent/.openclaude/...` mount), so this gate is a no-op there
  //    in practice. But keeping it ahead is fail-closed defense if anyone
  //    ever wires a host-volume path through trusted serve by misconfig.
  if (COMMERCIAL_USER_VOLUME_MEDIA_GATE.test(resolvedPath)) {
    return Boolean(extraAllowedPredicate && extraAllowedPredicate(resolvedPath))
  }
  // 0b. **v3 trusted backend mode (per-user docker sandbox)** — closed-world.
  //     The container is master-controlled; every secret/credential/state file
  //     under the agent's home is master-injected via known volumes/symlinks
  //     and enumerable. Agent work products may land anywhere under
  //     `/home/agent/...` (cwd / `~/.openclaude/repos/<sess>/<ver>/output.pdf`
  //     / user-named `~/hello.txt` / etc.), so the legacy allowlist is too
  //     narrow and forces agent-prompt-dependent UX (the bug this fix targets).
  //
  //     Switch to **blocklist-only ACL, scoped to `/home/agent/**` + the
  //     openclaude temp prefix**. Anything outside those subtrees (`/etc/*`,
  //     `/opt/openclaude/*` runtime source, `/usr/local/lib/*`, etc.) stays
  //     denied — the trusted bit only loosens the user's own sandbox.
  //
  //     The blocklist is the **single authoritative inventory of download-
  //     sensitive container state** — see `FILE_BLOCKED_PATTERNS`. Any new
  //     master-injected secret or container-runtime persisted state file
  //     must add a matching pattern in the same PR (with a `security.test.ts`
  //     case). v3supervisor.ts and entrypoint.ts cite this contract.
  if (isTrustedContainerFileServeEnabled()) {
    const inHome = isPathWithinRoot(resolvedPath, TRUSTED_CONTAINER_HOME)
    const inTemp = hasResolvedPrefix(resolvedPath, TEMP_PREFIX)
    const inOptExport = OPT_OPENCLAUDE_EXPORT_RE.test(resolvedPath)
    if (!inHome && !inTemp && !inOptExport) return false
    return !isFileBlocked(resolvedPath)
  }
  // 1. Static allowed directories (OPENCLAUDE_HOME, generated/, uploads/)
  for (const dir of FILE_ALLOWED_DIRS) {
    if (isPathWithinRoot(resolvedPath, dir)) return true
  }
  // 2. Temp files matching /tmp/openclaude-*
  if (hasResolvedPrefix(resolvedPath, TEMP_PREFIX)) return true
  // 3. Dynamic agent cwds (if provided) — allow media files and generated/uploads subdirs
  if (agentCwds) {
    for (const raw of agentCwds) {
      if (!raw) continue
      const cwd = resolve(raw)
      if (isPathWithinRoot(resolvedPath, cwd)) {
        // Allow generated/ and uploads/ subdirs unconditionally
        const genSub = join(cwd, 'generated')
        const upSub = join(cwd, 'uploads')
        if (isPathStrictlyUnder(resolvedPath, genSub) || isPathStrictlyUnder(resolvedPath, upSub)) return true
        // Allow non-executable media file extensions anywhere in CWD
        const ext = extname(resolvedPath).toLowerCase()
        if (MEDIA_EXTENSIONS.has(ext)) return true
      }
    }
  }
  // 4. Extra allowed predicate (user-scoped media dirs for v3 commercial).
  //    Called LAST so failure here doesn't shortcut earlier static-allowlist
  //    matches.
  if (extraAllowedPredicate && extraAllowedPredicate(resolvedPath)) return true
  return false
}

/**
 * Build a **user-scoped** allowlist predicate restricted to a single user's
 * resolved media dirs. Used by handleApiFile / handleMediaGet to pass through
 * isFileAllowed + openFileHardened.
 *
 * Critical safety property: the closure captures the **current request's**
 * uploads/generated paths. Two simultaneous requests from different uids each
 * get their own predicate; no cross-tenant leakage by absolute path.
 *
 * `dir + '/'` boundary check avoids the `foo/uploads-evil/x` false positive
 * that a naive `startsWith(dir)` would admit. Equality match (`=== dir`) is
 * legitimate because the dir itself is a stat'able directory entry (not a
 * file to serve, but kept for parity with FILE_ALLOWED_DIRS logic).
 */
export function makeUserScopedMediaPredicate(
  uploadsDir: string,
  generatedDir: string,
): (p: string) => boolean {
  const u = resolve(uploadsDir)
  const g = resolve(generatedDir)
  return (p) => isPathWithinRoot(p, u) || isPathWithinRoot(p, g)
}

/**
 * Sensitive-file blocklist. Authoritative inventory for both:
 *   1. personal/legacy gateway `/api/file` blocklist
 *   2. **v3 trusted container** `/api/file` ACL (it IS the entire ACL there —
 *      see `isFileAllowed` trusted branch and its contract comment).
 *
 * Adding a new master-injected secret, container-persisted runtime state file,
 * or persistent credential location? It MUST land here in the same PR, with
 * a matching `security.test.ts` case. Cross-references:
 *   - v3supervisor.ts `provisionV3Container` env/mounts
 *   - entrypoint.ts (symlinks, codex-config dir, npmrc/pip.conf user volumes)
 *   - gateway state writers (sessions.db, msg-outbox, retry queues, webhooks)
 */
export const FILE_BLOCKED_PATTERNS = [
  // ── Personal/legacy (predates v3 trusted backend). Kept verbatim. ──
  /openclaude\.json$/, // gateway config with tokens
  /\.env($|\.)/, // .env, .env.local, .env.production, .env.development, etc.
  /credentials/, // credential directory (kept legacy-broad; trusted users accept rare false-positive name collisions)
  /\.ssh/, // SSH keys
  /\.key$/, // private keys
  /\.pem$/, // certificates
  /id_rsa/, // SSH private key
  /id_ed25519/, // SSH private key
  /\.gnupg/, // GPG keys
  /\.password/, // password files
  /shadow$/, // /etc/shadow
  /auth.*token/i, // token files
  /MEMORY\.md$/, // agent long-term memory
  /USER\.md$/, // user identity / core memory (legacy per-agent)
  /(^|\/)user\.md$/, // user-level shared identity / core memory (~/.openclaude/user.md)
  /CLAUDE\.md$/, // agent persona / system instructions
  /resume-map\.json$/, // session checkpoint data
  /\.npmrc$/, // npm registry tokens (top-level)
  /\.pypirc$/, // PyPI credentials
  /\.netrc$/, // FTP/HTTP credentials
  /\.aws\//, // AWS credentials & config directory
  /\.kube\//, // Kubernetes config directory
  /\.docker\/config\.json$/, // Docker registry credentials

  // ── v1.0.193 — trusted backend inventory (Codex review v4: closed-world for v3 container). ──

  // Codex auth + runtime state. `~/.codex/auth.json` is a symlink to
  // `/run/oc/codex-auth/auth.json` (master-injected RO). `~/.codex/` also
  // accumulates sessions/memories/sqlite state — all sensitive.
  /\/auth\.json$/i, // filename-bound (catches both symlink and target)
  /\/\.codex\/sessions\//, // turn-by-turn rollout transcripts
  /\/\.codex\/memories\//, // codex persistent memory
  /\/\.codex\/logs_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/state_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/config\.toml$/, // model/profile + api keys

  // Gateway state files (SQLite + WAL/SHM, JSONL outbox, tasks store).
  /\/sessions\.db(-wal|-shm)?$/,
  /\/msg-outbox\.jsonl$/,
  // taskStore atomically writes `tasks.json` (with `.tmp` swap); fields include
  // prompt + lastOutput + execution output/error → same sensitivity class as
  // session JSONL and outbox.
  /\/tasks\.json(\.tmp)?$/,

  // Gateway YAML configs (agents/cron/webhooks). Webhook secrets are HMAC keys.
  /\/agents\.yaml$/,
  /\/cron\.yaml$/,
  /\/webhooks\.ya?ml$/,

  // Gateway retry queues — server-authored sink payloads (assistant text + tool args).
  /\/v3-master-retry\.d\//,
  /\/v3-wechat-retry\.d\//,

  // Cursor CLI cold-start diagnostics (oc-cursor.sh OPENCLAUDE_CURSOR_AGENT_DEBUG):
  // raw CLI stderr/debug logs may carry prompts, tool args and auth diagnostics.
  /\/logs\/cursor-cli\//,

  // Per-agent session JSONL subtree (thinking + tool args, may embed tokens).
  /\/\.openclaude\/agents\/[^/]+\/sessions\//,

  // Git credentials (git store helper at HOME root + dedicated subdir).
  /\/\.openclaude\/git-creds\//,
  /\/\.git-credentials$/,

  // ScanSci PDF persistent state. PDFs under `papers/` are user work products
  // and remain allowed in v3 trusted mode; config/cookies/browser state are
  // credential-bearing runtime state and must never be served as files.
  /\/\.local\/share\/scansci-pdf\/config\.json$/,
  /\/\.local\/share\/scansci-pdf\/cache\/browser_state\.json$/,
  /\/\.local\/share\/scansci-pdf\/(?:cache\/)?[^/]*(cookie|cookies|token|secret|key)[^/]*\.(json|txt|db|sqlite)$/i,

  // Persistent XDG user config volume (mounted by v3supervisor V3_USER_CONFIG_MOUNT).
  // Carries credential-bearing config for gh / git scoped / npm / pip /
  // vscode-server / arbitrary user dotfiles — see v3supervisor.ts comment on
  // `V3_USER_CONFIG_MOUNT`. **Deny the whole subtree** rather than chasing
  // per-tool XDG paths: false-positives here are config files (not work
  // products), and per-tool allowlist would force this blocklist to track the
  // entire CLI ecosystem forever.
  /\/\.config(\/|$)/,

  // Shell history (may include accidentally-pasted credentials).
  /\.bash_history$/,
  /\.zsh_history$/,

  // Kernel + runtime tmpfs. `/run/oc/*` (master-injected token/auth/sockets)
  // is the primary target; `/proc` + `/sys` + `/var/run` are kept for parity.
  /^\/(proc|sys|run|var\/run)\//,

  // System /etc — agent has no write access inside container; read is 99%
  // attack pattern (e.g. `/etc/shadow`, `/etc/sudoers`, `/etc/hostname`).
  // Note: the trusted branch already scopes to `/home/agent/**` + temp, so
  // this is **belt-and-suspenders** for personal/legacy + direct `/api/file`
  // misuse. Personal/legacy already denies `/etc/*` via missing allowlist;
  // this regex makes the intent explicit and survives any future allowlist
  // change.
  /^\/etc(\/|$)/,
]

/** Returns true if the resolved path matches any sensitive-file pattern. */
export function isFileBlocked(resolvedPath: string): boolean {
  return FILE_BLOCKED_PATTERNS.some((p) => p.test(resolvedPath))
}

// ── v3 WeChat broker inbound-compensate payload validation ──
// Pure validator used by handleWechatInboundCompensate (line ~2399). Exposed
// for unit testing without standing up a full Gateway. Returns either the
// typed payload or the 400-error string the route surfaces back to the
// broker dispatcher.

/** Shape of `/internal/v3/wechat-inbound-compensate` JSON body after validation. */
export interface WechatInboundCompensatePayload {
  /** `wsess-[0-9a-f]{16}` — broker-owned client_sessions row id from Step 2a write. */
  sessionId: string
  /** Decimal string of `wechat_bindings.user_id`. Container derives `c:<id>` for tenant scope. */
  bindingUserId: string
  /** Which dispatcher step failed; reason gets logged but doesn't affect deletion semantics. */
  reason: 'step2a_failed' | 'step2b_failed'
  /** Optional broker-side trace id (≤64 chars). */
  traceId?: string
}

export type WechatInboundCompensateValidation =
  | { ok: true; payload: WechatInboundCompensatePayload }
  | { ok: false; error: string }

const COMPENSATE_SESSION_ID_RE = /^wsess-[0-9a-f]{16}$/
const COMPENSATE_BINDING_USER_ID_RE = /^[1-9][0-9]{0,18}$/
const COMPENSATE_TRACE_ID_MAX_LEN = 64

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

const ENGINE_PREHEAT_SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,50}$/
const ENGINE_PREHEAT_AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

export type EnginePreheatBody = {
  sessionId: string
  agentId: string
  modelId?: string
}

export type EnginePreheatValidation =
  | { ok: true; payload: EnginePreheatBody }
  | { ok: false; error: string }

export function validateEnginePreheatBody(parsed: unknown): EnginePreheatValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = parsed as Record<string, unknown>
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !ENGINE_PREHEAT_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'sessionId required' }
  }
  const agentId = body.agentId
  if (typeof agentId !== 'string' || !ENGINE_PREHEAT_AGENT_ID_RE.test(agentId)) {
    return { ok: false, error: 'agentId required' }
  }
  if (isHiddenSystemAgentId(agentId)) {
    return { ok: false, error: 'agentId required' }
  }
  let modelId: string | undefined
  if (body.modelId !== undefined) {
    if (typeof body.modelId !== 'string' || body.modelId.length === 0 || body.modelId.length > 128) {
      return { ok: false, error: 'modelId invalid' }
    }
    modelId = body.modelId
  }
  return { ok: true, payload: { sessionId, agentId, ...(modelId ? { modelId } : {}) } }
}

export type SessionPreheatHost = {
  log: { info: (msg: string, fields?: unknown) => void; warn: (msg: string, fields?: unknown, err?: unknown) => void }
  sessions: {
    getByKey: (key: string) => unknown
    getOrCreate: (opts: Record<string, unknown>) => Promise<unknown>
    preheatRunner: (session: unknown) => Promise<string>
  }
  _getAgentsConfig: () => Promise<{ agents: AgentDef[] }>
  deps: { config: { defaults: { model: string } } }
}

/** 容器内真实预热:投影授权 → getOrCreate → preheatRunner。供 internal 口与容器 GET 钩子共用。 */
export async function runSessionPreheat(
  host: SessionPreheatHost,
  sessId: string,
  userId: string,
  row: { agentId?: string; modelId?: string },
): Promise<void> {
  const aid = row.agentId || 'main'
  if (isHiddenSystemAgentId(aid)) return
  const sessionKey = `agent:${aid}:webchat:dm:${sessId}`
  const cfg = await host._getAgentsConfig()
  const agent = cfg.agents.find((a) => a.id === aid) ?? ({ id: aid } as AgentDef)
  const preExec = await resolveLocalExecutionIfEnforced({
    agent,
    kind: 'prewarm',
    ...(row.modelId ? { model: row.modelId } : {}),
    defaultModel: host.deps.config.defaults.model,
  })
  let session = host.sessions.getByKey(sessionKey)
  if (!session) {
    const override = localExecutionOverride(preExec)
    session = await host.sessions.getOrCreate({
      sessionKey,
      agent,
      ...override,
      ...(override.model === undefined && row.modelId ? { model: row.modelId } : {}),
      channel: 'webchat',
      peerId: sessId,
      userId,
    })
  }
  const outcome = await host.sessions.preheatRunner(session)
  if (outcome !== 'started' && outcome !== 'already_running') {
    host.log.info('engine_preheat_skipped', { sessionKey, outcome })
  }
}

export function validateWechatInboundCompensateBody(
  parsed: unknown,
): WechatInboundCompensateValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = parsed as Record<string, unknown>
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !COMPENSATE_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'sessionId must match wsess-[0-9a-f]{16}' }
  }
  const bindingUserId = body.bindingUserId
  if (typeof bindingUserId !== 'string' || !COMPENSATE_BINDING_USER_ID_RE.test(bindingUserId)) {
    return { ok: false, error: 'bindingUserId must be a positive integer string' }
  }
  const reason = body.reason
  if (reason !== 'step2a_failed' && reason !== 'step2b_failed') {
    return { ok: false, error: "reason must be 'step2a_failed' or 'step2b_failed'" }
  }
  // traceId 可选;cap 64 chars 防 log 注入膨胀
  const traceId = body.traceId
  if (traceId !== undefined && (typeof traceId !== 'string' || traceId.length > COMPENSATE_TRACE_ID_MAX_LEN)) {
    return { ok: false, error: 'traceId must be string ≤64' }
  }
  return {
    ok: true,
    payload: {
      sessionId,
      bindingUserId,
      reason,
      ...(traceId !== undefined ? { traceId: traceId as string } : {}),
    },
  }
}

// ── Upload constants — single source of truth ──
// 2026-05-18:从 200MB → 100MB。前端 attachments.js 同步;Cloudflare Free/Pro
// request body cap = 100MB,后端写 200MB 是个永远摸不到的虚上限。前后端对齐到
// CF 现实让 413 在前端直接拦,而不是被 CF 边缘 HTML 错误页吞掉。
export const MAX_UPLOAD_SINGLE = 100 * 1024 * 1024
export const MAX_UPLOAD_TOTAL = 300 * 1024 * 1024

/**
 * Upload admission is intentionally format-agnostic. Browser MIME values are
 * client-controlled metadata (and `application/octet-stream` already made the
 * old allowlist bypassable), so they are not a security boundary. Safety comes
 * from byte limits, tenant-scoped storage, parser-specific gates, and forcing
 * executable web content to download rather than render inline.
 */
export function isUploadMimeAllowed(_mime: string): boolean {
  return true
}

/** MIME → file extension. Used by dispatchInbound (legacy base64 path) and
 *  handleUpload (new streaming endpoint). Kept module-level so both paths
 *  agree on what `<digest>.<ext>` should be. */
export const UPLOAD_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

const SAFE_UPLOAD_EXTENSION_RE = /^[a-z0-9]{1,32}$/

function safeUploadExtension(candidate: string | undefined): string | null {
  if (!candidate) return null
  const normalized = candidate.toLowerCase()
  return SAFE_UPLOAD_EXTENSION_RE.test(normalized) ? normalized : null
}

/**
 * Resolve claimed MIME + optional original filename to a safe storage suffix.
 * Canonical MIME mappings win. Unknown formats retain a bounded final filename
 * extension when possible, then fall back to a bounded MIME subtype or `bin`.
 * `filenameHint` accepts either raw URL-encoded X-Filename or a plain legacy
 * filename; malformed encoding never rejects the upload.
 */
export function uploadExtForMime(mime: string, filenameHint?: string): string {
  const normalizedMime = mime.split(';')[0].trim().toLowerCase()
  const mapped = safeUploadExtension(UPLOAD_MIME_TO_EXT[normalizedMime])
  if (mapped) return mapped

  if (filenameHint) {
    let decoded = filenameHint
    try {
      decoded = decodeURIComponent(filenameHint)
    } catch {
      // A literal '%' or malformed escape is still safe to inspect because we
      // retain only a bounded alphanumeric suffix, never any path component.
    }
    const finalComponent = decoded.replace(/\\/g, '/').split('/').pop() ?? ''
    const suffix = finalComponent.match(/\.([^.]+)$/)?.[1]
    const fromFilename = safeUploadExtension(suffix)
    if (fromFilename) return fromFilename
  }

  const subtype = normalizedMime.includes('/')
    ? normalizedMime.slice(normalizedMime.indexOf('/') + 1).replace(/[^a-z0-9]/g, '')
    : ''
  return safeUploadExtension(subtype) ?? 'bin'
}

const MIME_MAP: Record<string, string> = {
  // web
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

export function mimeFor(p: string): string {
  return MIME_MAP[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 静态 web UI 资产的 Cache-Control —— 缓存规则的单一权威(见 GatewayDeps.staticMode)。
 * `safePath` 已把 `/` 归一为 `/index.html`。抽为纯函数便于单测锁定、避免规则在测试里被
 * 重新实现而漂移。
 *   - 'spa'(v5 Aurora,bundler dist): 内容哈希资产 `/assets/*` → immutable 1 年;
 *     其余(含 index.html / public 透传文件)→ no-cache,借 ETag 廉价重校验。
 *   - 'vanilla'(默认,v3/personal,web/public): 沿用 ?v=hash cache-bust →
 *     普通资产 1 小时;sw.js 永不被边缘缓存(CF 默认 4h TTL 会把用户钉在陈旧 SW 上)。
 */
export function staticCacheControl(safePath: string, mode: 'vanilla' | 'spa' | undefined): string {
  if (mode === 'spa') {
    return safePath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  }
  return safePath === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
}

// 活跃内容 MIME 集合 + inline 判定已收敛到 @openclaude/protocol 的单一权威(批D D5)。
// shouldServeInline 在文件顶部从 protocol import 供本模块内部使用;此处 re-export 保持
// 既有 import 路径(如 security.test.ts `import { shouldServeInline } from '../server.js'`)不变。
// (原 ACTIVE_CONTENT_TYPES 集合与未被引用的 isActiveContentType 一并移入 protocol。)
export { shouldServeInline }

/** Known route prefixes for metrics normalization (avoids high-cardinality labels). */
const KNOWN_ROUTES = [
  '/api/healthz', '/api/doctor', '/api/usage', '/api/usage/events',
  '/api/runs', '/api/sessions', '/api/sessions/list', '/api/sessions/search', '/api/sessions/batch',
  '/api/sessions/read-all',
  '/api/chat-projects', '/api/project-assets', '/api/config', '/api/features', '/api/agents', '/api/collaboration-config', '/api/search',
  '/api/cron', '/api/cron/channels', '/api/board', '/api/board/projects', '/api/board/tickets',
  '/api/board/pipelines', '/api/board/agents', '/api/board/settings',
  '/api/board/stats/cost', '/api/board/templates', '/api/board/reports/weekly',
  '/api/delegate/wait', '/api/tasks', '/api/tasks-executions', '/api/webhooks',
  '/api/wechat/pair/start', '/api/wechat/pair/poll', '/api/wechat/pair/cancel',
  '/api/wechat/binding', '/api/wechat/binding/status',
  '/api/auth/session', '/api/auth/logout', '/api/auth/claude/start',
  '/api/auth/claude/callback', '/api/auth/claude/status',
  '/api/file', '/healthz', '/metrics',
]

/** Normalize URL paths for metrics labels (replace dynamic IDs with :id to avoid high cardinality). */
function normalizePath(p: string): string {
  // Exact match for known routes
  if (KNOWN_ROUTES.includes(p)) return p
  // Dynamic API routes — normalize IDs
  const normalized = p
    .replace(/\/api\/sessions\/[a-zA-Z0-9_-]+\/inflight-delegates$/, '/api/sessions/:id/inflight-delegates')
    .replace(/\/api\/sessions\/[a-zA-Z0-9_-]+\/read$/, '/api/sessions/:id/read')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/skills\/[a-z0-9-]+/, '/api/agents/:id/skills/:name')
    .replace(/\/api\/skills\/[a-z0-9-]+/, '/api/skills/:name')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/([a-z]+)/, '/api/agents/:id/$1')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+/, '/api/agents/:id')
    .replace(/\/api\/cron\/[a-zA-Z0-9_-]+/, '/api/cron/:id')
    .replace(/\/api\/chat-projects\/[a-zA-Z0-9_-]+\/restore/, '/api/chat-projects/:id/restore')
    .replace(/\/api\/chat-projects\/[a-zA-Z0-9_-]+/, '/api/chat-projects/:id')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+\/versions/, '/api/project-assets/:id/versions')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+\/restore/, '/api/project-assets/:id/restore')
    .replace(/\/api\/project-assets\/[a-zA-Z0-9_-]+/, '/api/project-assets/:id')
    .replace(/\/api\/board\/projects\/[^/]+\/board/, '/api/board/projects/:id/board')
    .replace(/\/api\/board\/projects\/[^/]+\/context\/preview/, '/api/board/projects/:id/context/preview')
    .replace(/\/api\/board\/projects\/[^/]+\/ensure/, '/api/board/projects/:id/ensure')
    .replace(/\/api\/board\/projects\/[^/]+\/workspace\/file/, '/api/board/projects/:id/workspace/file')
    .replace(/\/api\/board\/projects\/[^/]+\/workspace$/, '/api/board/projects/:id/workspace')
    .replace(/\/api\/board\/projects\/[^/]+\/context/, '/api/board/projects/:id/context')
    .replace(
      /\/api\/board\/projects\/[^/]+\/memories\/[^/]+\/[a-z]+/,
      '/api/board/projects/:id/memories/:file/:action',
    )
    .replace(/\/api\/board\/projects\/[^/]+\/memories/, '/api/board/projects/:id/memories')
    .replace(/\/api\/board\/projects\/[^/]+/, '/api/board/projects/:id')
    .replace(/\/api\/board\/tickets\/[^/]+\/[a-z_]+/, '/api/board/tickets/:id/:action')
    .replace(/\/api\/board\/tickets\/[^/]+/, '/api/board/tickets/:id')
    .replace(/\/api\/board\/pipelines\/[^/]+\/reorder/, '/api/board/pipelines/:id/reorder')
    .replace(/\/api\/board\/pipelines\/[^/]+\/stages/, '/api/board/pipelines/:id/stages')
    .replace(/\/api\/board\/pipelines\/[^/]+/, '/api/board/pipelines/:id')
    .replace(/\/api\/board\/stages\/[^/]+/, '/api/board/stages/:id')
    .replace(/\/api\/board\/runs\/[^/]+\/context/, '/api/board/runs/:id/context')
    .replace(/\/api\/board\/runs\/[^/]+/, '/api/board/runs/:id')
    .replace(/\/api\/board\/relations\/[^/]+/, '/api/board/relations/:id')
    .replace(/\/api\/board\/templates\/[^/]+\/apply/, '/api/board/templates/:id/apply')
    .replace(/\/api\/board\/templates\/[^/]+/, '/api/board/templates/:id')
    .replace(/\/api\/tasks\/[a-zA-Z0-9_-]+/, '/api/tasks/:id')
    .replace(/\/api\/webhooks\/[a-zA-Z0-9_-]+/, '/api/webhooks/:id')
    .replace(/\/api\/media\/.+/, '/api/media/:file')
  if (normalized !== p) return normalized
  // OpenAI compat
  if (p.startsWith('/v1/')) return '/v1/:endpoint'
  // Static files and unknown paths — collapse to prevent cardinality explosion
  return '/__other__'
}

// 便捷工厂
export async function createGateway(opts?: { webRoot?: string }): Promise<Gateway> {
  const config = await readConfig()
  if (!config) throw new Error('Run `openclaude onboard` first to create config.')
  const agentsConfig = await readAgentsConfig()
  return new Gateway({ config, agentsConfig, webRoot: opts?.webRoot })
}
