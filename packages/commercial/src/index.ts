/**
 * @openclaude/commercial — OpenClaude 商业化模块入口
 *
 * 启用方式:在 Gateway 中通过环境变量 COMMERCIAL_ENABLED=1 启用,
 * 然后在 gateway/src/server.ts 中条件挂载(见 docs/commercial/02-ARCHITECTURE §8)。
 *
 * T-02 起,本文件在挂载时会自动跑 schema migration(除非 COMMERCIAL_AUTO_MIGRATE=0)。
 * T-16 起,registerCommercial 还会:
 *   - 装配 redis 客户端(REDIS_URL,用于限流)
 *   - 实例化 HTTP 路由处理器,通过 result.handle 暴露给 gateway
 */

import type { IncomingMessage } from "node:http";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
// P3 双 master 蓝绿交接 + cohort 分批切流(RFC-v5-dual-master-cohort)。
import type { Slot } from "./deploy/deployState.js";
import { startDesiredWatch, type DesiredWatch } from "./deploy/deployState.js";
import { createLeaderBundle, type LeaderBundle, type BundleMemberHandle } from "./deploy/leaderBundle.js";
import {
  createLeaderLeaseController,
  resolveLeaderEnvEligibility,
  type LeaderLeaseController,
  type LeadershipStatus,
} from "./deploy/leaderLease.js";
import {
  createControlListener,
  privatePortForSlot,
  type ControlListener,
} from "./deploy/controlListener.js";
import {
  createSlotRelayClient,
  handleSlotRelayRequest,
  type SlotRelayLocal,
} from "./deploy/slotRelay.js";
import type { TLSSocket } from "node:tls";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import type { Duplex } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import IORedis from "ioredis";
import Docker from "dockerode";
import { runMigrations } from "./db/migrate.js";
import { closePool, getPool } from "./db/index.js";
import {
  assertModelCatalogAdminPoolConfigured,
  closeModelCatalogAdminPool,
} from "./db/modelCatalogAdmin.js";
import { loadConfig, type CommercialConfig } from "./config.js";
import { stubMailer, createResendMailer } from "./auth/mail.js";
import { wrapIoredis } from "./middleware/rateLimit.js";
import { createCommercialHandler, type CommercialHandler } from "./http/router.js";
import { deriveMediaSignKey } from "./http/mediaSign.js";
import { ThumbnailDiskCache } from "./http/mediaThumbnail.js";
import { deriveWechatLiveLinkKey } from "./wechat/liveShare.js";
import { loadKmsKey, zeroBuffer } from "./crypto/keys.js";
import { rootLogger } from "./logging/logger.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { secretToKey } from "./auth/jwt.js";
import { PricingCache, createModelHintProvider, type ModelPricing } from "./billing/pricing.js";
import { applyTurnWaiver } from "./billing/refund.js";
import { canUseModel } from "./billing/authzModels.js";
import { ALLOWED_INBOUND_MODELS, setModelHintProvider, setLiteratureSkillProvider, setHostStaticProviderKeys } from "@openclaude/gateway";
import { getPreferences, patchPreferences } from "./user/preferences.js";
import { getLiteratureSkillConfig } from "./admin/literatureConfig.js";
import {
  getPhase6AccountUuidEnforce,
  getSessionPinMode,
} from "./admin/runtimeFlags.js";
import { renderLiteratureSkillContent } from "./literatureSkill.js";
import {
  estimateMaxCost,
  InsufficientCreditsError,
  preCheckWithCost,
  releasePreCheck,
  type ReservationHandle,
  wrapIoredisForPreCheck,
} from "./billing/preCheck.js";
import { createHttpHupijiaoClient, type HupijiaoClient, type HupijiaoConfig } from "./payment/hupijiao/client.js";
import {
  AccountScheduler,
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  ContainerStaleBindingError,
  pickCodexAccountForBindingInTx,
} from "./account-pool/scheduler.js";
import {
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
  type WriteAuthDeps,
} from "./account-pool/codexLazyMigrate.js";
import {
  type CodexDisableFanoutDeps,
  type CodexDriftReconcilerHandle,
  enqueueCodexDisableFanout,
  startCodexDisableDriftReconciler,
} from "./account-pool/codexDisableFanout.js";
import { AccountHealthTracker, wrapIoredisForHealth } from "./account-pool/health.js";
import {
  putRemoteCodexContainerAuth,
  deleteRemoteCodexContainerAuth,
} from "./codex-auth/remoteCodexAuth.js";
import { tx } from "./db/queries.js";
import { GoalStateService } from './goal/goalStateService.js'
import { recordProductFrictionEvent } from "./productFriction/events.js";
import {
  startLifecycleScheduler,
  type LifecycleScheduler,
  type LifecycleLogger,
} from "./agent/index.js";
import type { AgentHttpDeps } from "./http/agent.js";
import { startAlertScheduler, type AlertScheduler } from "./admin/alerts.js";
import {
  startRefreshEventsSweeper,
  type SweeperHandle as RefreshEventsSweeperHandle,
} from "./account-pool/refreshEventsSweeper.js";
import {
  startAuditRetentionSweeper,
  type AuditRetentionSweeperHandle,
} from "./admin/auditRetention.js";
import { startGithubWorkspaceSweeper } from "./github/sessionWorkspaces.js";
import { startImageUsageSweeper } from "./billing/imageBilling.js";
import {
  startCodexRefreshActor,
  type CodexRefreshActorHandle,
} from "./account-pool/codexAccountActor.js";
import {
  startCooldownRecoveryActor,
  type CooldownRecoveryActorHandle,
} from "./account-pool/cooldownRecoveryActor.js";
import { startCursorAuthSyncActor } from "./account-pool/cursorMaterializer.js";
import {
  DEFAULT_V3_CODEX_CONTAINER_DIR,
  V3_CONTAINER_PORT,
  stopAndRemoveV3Container,
  ocGatewayIpForChannel,
  ocInternalProxyPortForChannel,
} from "./agent-sandbox/v3supervisor.js";
import { AuthoritySigner } from "./ws/authoritySigner.js";
import { ModelCatalogCache, PLATFORM_AUX_MODEL_IDS } from "./billing/modelCatalog.js";
import { getCodexAccountRuntimeChannel, getRuntimeChannel } from "./runtimeChannel.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "./agent-sandbox/constants.js";
import {
  startPendingOrdersExpirer,
  type SweeperHandle as PendingOrdersExpirerHandle,
} from "./payment/pendingOrdersExpirer.js";
import {
  startSubscriptionRolloverSweeper,
  type SubscriptionRolloverHandle,
} from "./billing/subscriptionRolloverSweeper.js";
import {
  startAccountSlotReaper,
  type SlotReaperHandle,
} from "./account-pool/accountSlotReaper.js";
import {
  startFinalizeJournalReconciler,
  resolveStuckThresholdMs,
  resolveDurableWaiverAgeMs,
  markGatewayShutdownEvidence,
  DEFAULT_RECONCILE_INTERVAL_MS,
  MIN_INTERVAL_MS as FINALIZE_RECONCILER_MIN_INTERVAL_MS,
  type ReconcilerHandle as FinalizeJournalReconcilerHandle,
} from "./billing/finalizeJournalReconciler.js";
import {
  startLiveFrameMaintenanceScheduler,
  resolveLiveFrameMaintenanceDisabled,
  resolveLiveFrameMaintenanceIntervalMs,
  resolvePruneMaxBatches,
  resolveRetireMinAgeMs,
} from "./db/liveFrameMaintenanceScheduler.js";
import {
  startOnboardingScheduler,
  type OnboardingSchedulerHandle,
} from "./inbox/onboarding.js";
import {
  startInboxEmailScheduler,
  type InboxEmailSchedulerHandle,
} from "./inbox/email.js";
import {
  startResearchJobScheduler,
  type ResearchJobSchedulerHandle,
} from "./research/scheduler.js";
import {
  startCronWakeScheduler,
  findDueCronWakeUsers,
  runCronWakeRescan,
  type CronWakeSchedulerHandle,
  type CronWakeRunner,
} from "./agent-sandbox/cronWake.js";
import { createCronDeliveryInboxMessage, createInboxMessage } from "./inbox/inbox.js";
import {
  startMarketplaceAiReviewScheduler,
  type MarketplaceAiReviewSchedulerHandle,
} from "./marketplace/aiReview.js";
import {
  startProviderHealthScheduler,
  type ProviderHealthSchedulerHandle,
} from "./admin/providerHealthScheduler.js";
import {
  startIncidentReconciler,
  startIncidentSweeper,
  assertSelfhealConfig,
  selfhealTickMs,
  type IncidentReconcilerHandle,
  type IncidentSweeperHandle,
} from "./selfheal/index.js";
import {
  startWecomAlertDispatcher,
} from "./admin/wecomAlertDispatcher.js";
import {
  getWecomAibotConnectionManager,
} from "./admin/wecomAibotConnection.js";
import {
  startUserNoticeApproval,
} from "./selfheal/userNoticeApproval.js";
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyHandler,
} from "./http/anthropicProxy.js";
import { assertPlatformDefaultModelConfigured, STATIC_PROVIDER_META } from "./http/proxy/staticProviderMeta.js";
import type {
  DurableCodexBilling,
  StaticProviderId,
  StaticProviderKeys,
} from "@openclaude/protocol";
import { isGrokEngineModel } from "@openclaude/protocol";
import { makePlatformContextLoader } from "./platform/platformContextLoader.js";
import { makeDefaultVolumeContextReader } from "./platform/volumeContextReader.js";
import {
  makeServerAuthoredHandler,
  makeTurnTapeStateHandler,
  SERVER_AUTHORED_PATH,
  TURN_TAPE_STATE_PATH,
  type ServerAuthoredHandler,
} from "./http/internalServerAuthored.js";
import {
  CODEX_TOKEN_REFRESH_PATH,
  type CodexTokenRefreshHandler,
} from "./http/internalCodexTokenRefresh.js";
import {
  buildCodexRelayHandler,
  buildCodexTokenRefreshHandler,
} from "./http/codexInternalAssembly.js";
import {
  createCodexRouteContextForModel,
  createGrokRouteContextForModel,
  expireCodexRouteContext,
  expireGrokRouteContext,
  expireGrokRouteContextByLease,
  hasActiveOfficialOAuthAccountInGroup,
  listActiveGrokRouteLeases,
  listEnabledGroupsForModel,
} from "./account-pool/groups.js";
import {
  CODEX_RELAY_PREFIX,
  type CodexRelayHandler,
} from "./http/internalCodexRelay.js";
import {
  GROK_RELAY_PREFIX,
  makeGrokRelayHandler,
  type GrokRelayHandler,
} from "./http/internalGrokRelay.js";
import {
  SKILL_EMBED_PREFIX,
  makeSkillEmbedHandler,
  type SkillEmbedHandler,
} from "./http/internalSkillEmbed.js";
import {
  CORE_MEMORY_RANK_PATH,
  makeCoreMemoryRankHandler,
  type CoreMemoryRankHandler,
} from "./http/internalCoreMemoryRank.js";
import {
  MARKETPLACE_SYNC_PATH,
  makeMarketplaceSyncHandler,
  type MarketplaceSyncHandler,
} from "./http/internalMarketplaceSync.js";
import {
  TURN_WAIVE_PATH,
  makeTurnWaiveHandler,
  type TurnWaiveHandler,
} from "./http/internalTurnWaive.js";
import {
  TURN_LEASE_RENEW_PATH,
  makeTurnLeaseRenewHandler,
  type TurnLeaseRenewHandler,
} from "./http/internalTurnLeaseRenew.js";
import {
  PROMPT_QUEUE_CLAIM_PATH,
  PROMPT_QUEUE_DETAIL_PATH,
  PROMPT_QUEUE_MUTATION_PATH,
  PROMPT_QUEUE_SNAPSHOT_PATH,
  isPromptQueueV1Enabled,
  makePromptQueueHandler,
  type PromptQueueHandler,
} from "./http/internalPromptQueue.js";
import { PgPromptQueueStore } from "./promptQueue/pgPromptQueueStore.js";
import {
  COST_EVENT_PATH,
  makeCostEventHandler,
  type CostEventHandler,
} from "./http/internalCostEvent.js";
import {
  MARKETPLACE_AGENT_PREFIX,
  makeMarketplaceAgentHandler,
  type MarketplaceAgentHandler,
} from "./http/internalMarketplaceAgent.js";
import {
  TOOL_CALL_ROLLUP_PATH,
  TOOL_FAILURE_AUDIT_PATH,
  isToolFailureAuditEnabled,
  makeToolCallRollupHandler,
  makeToolFailureAuditHandler,
  type ToolCallRollupHandler,
  type ToolFailureAuditHandler,
} from "./http/internalToolFailureAudit.js";
import {
  SKILL_USAGE_PATH,
  isSkillUsageEnabled,
  makeSkillUsageHandler,
  type SkillUsageHandler,
} from "./http/internalSkillUsage.js";
import {
  SKILL_FEEDBACK_PATH,
  makeSkillFeedbackHandler,
  type SkillFeedbackHandler,
} from "./http/internalSkillFeedback.js";
import {
  SKILL_SHADOW_PATH,
  isSkillShadowEnabled,
  makeSkillShadowHandler,
  type SkillShadowHandler,
} from "./http/internalSkillShadow.js";
import {
  AUTO_DREAM_POLICY_PATH,
  makeAutoDreamPolicyHandler,
  type AutoDreamPolicyHandler,
} from "./http/internalAutoDreamPolicy.js";
import {
  AUTO_DREAM_OPTIMIZER_ABANDON_PATH,
  AUTO_DREAM_OPTIMIZER_ACTION_PATH,
  AUTO_DREAM_OPTIMIZER_ADMIT_PATH,
  AUTO_DREAM_OPTIMIZER_FINDINGS_PATH,
  AUTO_DREAM_OPTIMIZER_SETTLE_PATH,
  isAutoDreamOptimizerInternalPath,
  makeAutoDreamOptimizerHandler,
  projectAutoDreamCodexRoute,
  type AutoDreamOptimizerRuntime,
} from "./http/internalAutoDreamOptimizer.js";
import {
  applyAutoDreamPreferenceAction,
  reportAutoDreamPlatformFindings,
} from "./autoDream/optimizerStore.js";
import { getUserSignalTrafficClass } from "./analytics/signalTraffic.js";
import {
  CRON_INDEX_PATH,
  makeCronIndexHandler,
  type CronIndexHandler,
} from "./http/internalCronIndex.js";
import {
  INBOX_ALERT_PATH,
  INBOX_POST_PATH,
  makeInboxPostHandler,
  type InboxPostHandler,
} from "./http/internalInboxPost.js";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  assertSeedModelsActive,
  makeModelCatalogHandler,
  type ModelCatalogHandler,
} from "./http/internalModelCatalog.js";
import {
  authorityKeyringProvider,
  getModelCatalogCache,
  isModelAuthorityEnforced,
  peekModelCatalogCache,
} from "./billing/modelCatalogRuntime.js";
import {
  MASTER_CAPABILITIES,
  assertModelAuthorityCutoverFloor,
} from "./runtimeCapabilities.js";
import {
  makePgSkillEmbedCache,
  makePgSkillSearchLogger,
} from "./http/skillEmbedCachePg.js";
import {
  appendCostCredits,
  appendServerAuthoredMessage,
  appendServerAuthoredMessageForRequest,
  appendServerAuthoredMessageDrainByUser,
  drainDelegateCostForClientSession,
  getClientSession,
  patchServerAuthoredMessage,
  readArchivedMessages,
  getEngineContextMessages,
  hasCompletedClientTurn,
  // P1.7 slice 7c — broker assembly 需要的 master sqlite helpers
  upsertMasterClientSession,
  softDeleteMasterSession,
  allMasterWsessRows,
  getWechatBindingByUserId,
  // P2 master 会话权威迁 PG(RFC-v5-sessions-pg D1):一次性注入 backend 的 composition root 入口。
  setClientSessionsBackend,
} from "@openclaude/storage";
import {
  createPgSessionsBackend,
  type DispatchAdmissionBackend,
  startSessionsGcSweeper,
  type LosslessTurnTapeStorage,
} from "./db/pgSessionsBackend.js";
import { persistGatewayLiveFrame } from "./db/liveTurnFrames.js";
import { makeContainerDispatchClient } from "./dispatch/containerDispatchClient.js";
import {
  resolveDispatchStuckThresholdMs,
  startTurnDispatchReconciler,
  runShutdownDispatchHandoff,
  DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS,
} from "./dispatch/turnDispatchReconciler.js";
import { resolveSessionsStoreAuthority } from "./db/sessionsStoreAuthority.js";
import { getLaneMetricsSnapshot, type LaneMetricsSnapshot } from "./deploy/laneEvaluate.js";
import {
  WECHAT_OUTBOUND_PATH,
  makeOutboundReceiverHandler,
  type WechatCodexBillingBody,
} from "./wechat/outboundReceiver.js";
import {
  WECHAT_PROACTIVE_PATH,
  makeProactiveReceiverHandler,
  canonicalWechatSenderId,
  type ProactiveReceiverHandler,
} from "./wechat/proactiveReceiver.js";
import { getCurrentSessionId } from "./wechat/sessionPointer.js";
import { MASTER_USER_PREFIX } from "./wechat/userIds.js";
import {
  LITERATURE_SEARCH_PATH,
  makeLiteratureProxyHandler,
  type LiteratureProxyHandler,
} from "./literatureProxy.js";
import {
  CONNECTORS_RPC_PREFIX,
  PLUGINS_RPC_PREFIX,
  makeConnectorsRpcHandler,
  type ConnectorsRpcHandler,
} from './connectors/rpc.js'
import { PluginRuntimeFacade } from './plugins/runtime.js'
import { ManagedBrowserRuntime } from './plugins/browserRuntime.js'
import {
  KnowledgePlanetDockerService,
  createKnowledgePlanetRuntimeRegistries,
} from './plugins/knowledgePlanet.js'
import { KnowledgePlanetSetupManager } from './plugins/knowledgePlanetSetup.js'
import { KnowledgePlanetAutomationService } from './plugins/knowledgePlanetAutomation.js'
import { startKnowledgePlanetAutomationScheduler } from './plugins/knowledgePlanetAutomationScheduler.js'
import { WeiboDockerService, createWeiboRuntimeRegistries } from './plugins/weibo.js'
import { WeiboSetupManager } from './plugins/weiboSetup.js'
import { seedDefaultConnectors } from './connectors/declarativeSeed.js'
import { startConnectorSweeper } from './connectors/sweeper.js'
import {
  RESEARCH_PREFIX,
  makeResearchProxyHandler,
  type ResearchProxyHandler,
} from "./research/researchProxy.js";
import {
  OCR_PREFIX,
  makeOcrProxyHandler,
  type OcrProxyHandler,
} from "./ocr/ocrProxy.js";
import { PgOcrJobStore } from "./ocr/ocrStore.js";
import { getResearchConfigPublic } from "./admin/researchConfig.js";
import {
  seedPlatformGeneralAgents,
  seedPlatformResearchAgents,
} from "./marketplace/seedPlatformAgents.js";
import {
  PLATFORM_PROMPT_SLOTS_PATH,
  makePlatformPromptSlotsHandler,
  type PlatformPromptSlotsHandler,
} from "./http/internalPlatformPromptSlots.js";
import {
  MINIMAX_MEDIA_PATH,
  makeMiniMaxMediaHandler,
  type MiniMaxMediaHandler,
} from "./minimax/mediaProxy.js";
import {
  MINIMAX_WEB_SEARCH_PATH,
  makeMiniMaxWebSearchHandler,
  type MiniMaxWebSearchHandler,
} from "./minimax/webSearchProxy.js";
import { MediaGenerationService } from "./media-generation/service.js";
import {
  MEDIA_GENERATION_INTERNAL_PREFIX,
  makeMediaGenerationInternalHandler,
  type MediaGenerationInternalHandler,
} from "./media-generation/http.js";
import {
  makeInboundDispatcher,
  type PrepareWechatCodexTurnResult,
} from "./wechat/inboundDispatcher.js";
import { handleWechatModelCommand } from "./wechat/modelCommand.js";
import { pickWechatInboundModel } from "./wechat/modelResolver.js";
import { makeNodeHttpContainerTransport } from "./wechat/nodeHttpContainerTransport.js";
import { makeIlinkSendAdapter, makeIlinkSendMediaAdapter } from "./wechat/ilinkSendAdapter.js";
import { makeSaveWechatMediaToUserUploads } from "./wechat/imageIngest.js";
import { makeWechatOutboundMediaResolver } from "./wechat/outboundMedia.js";
import { createNoopRateLimiter } from "./wechat/rateLimiter.js";
import { makeWechatBroker, type WechatBroker } from "./wechat/broker.js";
import { readQqBotConfig } from "./qqbot/config.js";
import {
  makeQqBotService,
  qqInboundChannelProfile,
  type QqBotService,
} from "./qqbot/service.js";
import { makeSaveQqMediaToUserUploads } from "./qqbot/mediaIngest.js";
import { makeQqOutboundMediaResolver } from "./qqbot/outboundMedia.js";
import {
  QQ_OUTBOUND_PATH,
  QQ_PROACTIVE_PATH,
  makeQqOutboundReceiver,
  makeQqProactiveReceiver,
} from "./qqbot/receiver.js";
import { createPgIdentityRepo } from "./auth/containerIdentity.js";
import { makeContainerIdentityStrategy } from "./auth/proxyIdentity.js";
import { makeLoadUserModelAuthz } from "./auth/userModelAuthz.js";
import { getProviderRoutingAvailability } from "./admin/providerHealthGate.js";
import { makePgApiKeyRepo } from "./auth/apiKeyRepo.js";
import { makeApiKeyIdentityStrategy } from "./auth/apiKeyIdentity.js";
import {
  createUserChatBridge,
  ContainerUnreadyError,
  DEFAULT_MAX_FRAME_BYTES,
  type CodexBindingHandle,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
  type BridgeMetricSink,
} from "./ws/userChatBridge.js";
import { createFrontendBuildProbe } from "./ws/frontendBuild.js";
import {
  createVoiceTranscribeHandler,
  type VoiceTranscribeHandler,
} from "./ws/voiceTranscribe.js";
import {
  composeMultiplier,
  getAgentCostMultiplier,
} from "./billing/agentMultiplier.js";
import {
  startInflightJournal,
  type JournalFailureCode,
} from "./billing/proxyBilling.js";
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  deriveEngineSessionId,
  makeCodexFinalizer,
  type CodexFinalizeHandle,
} from "./billing/codexFinalizer.js";
import { settleDurableCodexBilling } from "./billing/durableCodexBilling.js";
import { serializeBillingPricing } from "./billing/persistedBillingPricing.js";
import { createTunnelContainerSocket } from "./ws/tunnelContainerSocket.js";
import {
  CONTAINER_PREVIEW_MAX_FRAME_BYTES,
  createContainerPreviewBridge,
  type ContainerPreviewBridgeHandler,
} from "./ws/containerPreviewBridge.js";
import { ContainerPreviewTicketStore } from "./ws/containerPreviewTickets.js";
import {
  createDirectContainerPreviewService,
  type DirectContainerPreviewService,
} from "./ws/directContainerPreview.js";
import {
  DEFAULT_V3_CCB_BASELINE_DIR,
  lookupContainerUserRole,
  resolveCcbBaselineMounts,
  makePrewarmContainer,
  makeUidSingleflight,
  makeV3EnsureRunning,
  preheatV3Image,
  startIdleSweepScheduler,
  startMigrationReconcileScheduler,
  startOrphanReconcileScheduler,
  markV3ContainerActivity,
  startV3ContainerEventsWorker,
  startVolumeGcScheduler,
  createUserMediaResolver,
  createSyntheticEvalOverlayRuntime,
  isUserVolumeMediaPath,
  readSyntheticEvalReleaseSourceCommit,
  resolvePlatformBundleMount,
  resolveRuntimeReleaseMount,
  DEFAULT_PLATFORM_ROOT,
  DEFAULT_RUNTIME_RELEASES_ROOT,
  type IdleSweepScheduler,
  type MigrationReconcileScheduler,
  type OrphanReconcileScheduler,
  type UserMediaLocation,
  type V3ContainerEventsWorker,
  type V3SupervisorDeps,
  type V3RuntimeTuple,
  type VolumeGcScheduler,
} from "./agent-sandbox/index.js";
import {
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
  observeWsBridgeTtft,
} from "./admin/metrics.js";
import { loadOrCreateBridgeSecret, DEFAULT_BRIDGE_SECRET_PATH } from "./bridgeSecret.js";
import { setRemoteMuxDeps } from "./remoteHosts/sshMux.js";
import { RemoteHostError } from "./remoteHosts/service.js";
import * as computeQueries from "./compute-pool/queries.js";
import {
  hostRowToTarget,
  resolveServiceableHostTarget,
  startSshControlMaster,
  stopSshControlMaster,
  putFile as nodeAgentPutFile,
  deleteFile as nodeAgentDeleteFile,
  getFile as nodeAgentGetFile,
} from "./compute-pool/nodeAgentClient.js";
import { createContainerService } from "./compute-pool/containerService.js";
import { getHealthPoller, type HealthPoller } from "./compute-pool/nodeHealth.js";
import { initComputePool } from "./compute-pool/poolInit.js";
import { getImagePromoteScheduler } from "./compute-pool/imagePromote.js";
import {
  getBaselineServer,
  type BaselineServer,
} from "./compute-pool/baselineServer.js";
import {
  ensureCa,
  ensureMasterLeaf,
  extractSpiffeUris,
  extractHostUuidFromSpiffe,
} from "./compute-pool/certAuthority.js";
import type { ServerResponse } from "node:http";

/**
 * 控制面 leader 判定(单一权威,可测)。返回 true = 本实例是控制面 leader
 * (controlPlaneEnabled),运行 shared 域后台 mutator(账号池 cooldown 恢复 /
 * finalize 对账 / 磁盘·OOM 监控 / 告警轮询 / 订单过期 等)。
 *
 * leader 权威从 channel 解耦为显式信号 OC_CONTROL_PLANE_LEADER —— v3 退役后 v5 需成为
 * 唯一 leader 接管这些职责,否则它们随 v3 停服真空(账号池只减不增 / 崩溃 journal 不对账 /
 * 磁盘无告警)。判定优先级:
 *   - OC_CONTROL_PLANE_LEADER="1" → leader(true)
 *   - OC_CONTROL_PLANE_LEADER="0" → follower(false,应急 kill-switch)
 *   - 未设 → 回落旧 channel 派生:runtimeChannel==="v5" → follower(保留 P0 期"防 v5
 *     启动写共享现网"初衷);其它 channel(v3)→ 默认 leader,除非 COMMERCIAL_CONTROL_PLANE_DISABLED=1。
 *
 * 【全网单 leader 铁律】同一时刻只能有一个实例是 leader,否则 shared 全表 mutator 双跑
 * (双 settle / 双恢复 / 竞态)。cutover 纪律:先停旧 leader(v3)再给新实例(v5)设 =1,
 * 严禁两实例同时 leader。
 */
export function resolveControlPlaneLeader(
  env: Record<string, string | undefined>,
  runtimeChannel: string,
): boolean {
  const explicit = env.OC_CONTROL_PLANE_LEADER?.trim();
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  if (runtimeChannel === "v5") return false;
  return env.COMMERCIAL_CONTROL_PLANE_DISABLED !== "1";
}

/**
 * T-02: 是否在 registerCommercial 时自动执行 migrations。
 *
 * 规约:
 *   - 未设 / "" / "1" → true(默认开)
 *   - "0" → false(关)
 *   - 其他值(如 "true"/"false"/"yes"/"no")→ true,但打 warning,
 *     提示运维该值不会被识别为 "关",避免 "以为自己关掉了但其实没关" 的脚枪
 */
function shouldAutoMigrate(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => {
    // eslint-disable-next-line no-console
    console.warn(m);
  },
): boolean {
  const raw = env.COMMERCIAL_AUTO_MIGRATE;
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  // 无法识别的值:运维最常见的失误是写成 "true"/"false"/"no" —— 我们继续
  // 执行 migration(默认开),但要 warn。坚持 "只有 0 才关" 的严格口径,
  // 但不让它 fail hard(和 COMMERCIAL_ENABLED 的严格枚举不同)。
  warn(
    `[commercial] COMMERCIAL_AUTO_MIGRATE=${JSON.stringify(raw)} not recognized; ` +
      "auto-migrate remains ON. Use exactly '0' to disable.",
  );
  return true;
}

/**
 * v5 灰度运行时状态 — 由 commercial 自身计算(它拥有控制面/运行时的事实),
 * 经 RegisterCommercialResult 暴露给 gateway,gateway 仅在 /healthz 透传序列化。
 * 用作"控制面是否静默 / 容器·agent 运行时是否启用 / 灰度归属(channel)"的只读断言面。
 */
export interface CommercialRuntimeStatus {
  /** 运行时 channel 单一权威(OC_RUNTIME_CHANNEL),默认 "v3"。 */
  channel: string;
  /** 后台控制面 mutator 是否启用(v5 follower 恒为 false)。 */
  controlPlaneEnabled: boolean;
  /** 启动是否执行了共享 PG migration(COMMERCIAL_AUTO_MIGRATE)。 */
  autoMigrate: boolean;
  /** legacy agent 运行时(AGENT_IMAGE/docker)状态。 */
  agentRuntime: "enabled" | "disabled";
  /** v3 supervisor 容器运行时(OC_RUNTIME_IMAGE)状态。 */
  containerRuntime: "enabled" | "disabled";
  /** 当前存活的后台 scheduler/actor 名单(v5 follower 必须为空)。live getter:反映 LeaderBundle 实时启停。 */
  schedulers: string[];
  /**
   * 本 master 构建实现的协议能力(见 runtimeCapabilities.ts)。**构建级事实,不是开关态** ——
   * deploy 的四面 capability 守卫读 `/healthz` 的 `runtime.capabilities` 判断"这个 master
   * 版本认不认模型权威协议",据此拒绝把不认的旧版本翻上来(方案 §7 步 5 兼容地板)。
   * 注:gateway 顶层的 `body.capabilities` 是**容器 file-proxy 面**的语义,与本字段无关。
   */
  capabilities: string[];
  /**
   * P3 leader lease 归属(RFC-v5-dual-master-cohort D4)。healthz 只读断言面:
   * state=ineligible(env kill-switch)|standby(有 env 资格但 desired 非本 slot)|
   * acquiring|leader|fenced。env=1 不再等同 active leader(smoke 断言随之改为断言 state=leader)。
   */
  leadership: LeadershipStatus;
  /** P3 lane 放量观测快照(evaluateLane 命中计数,详见 deploy/laneEvaluate.ts)。 */
  laneMetrics: LaneMetricsSnapshot;
}

export interface RegisterCommercialResult {
  /**
   * HTTP 处理器:gateway 在自身 handleHttp 入口前调用,
   * 返回 true 表示已处理完毕,gateway 不再继续路由。
   */
  handle: CommercialHandler;
  /** v5 灰度运行时状态(见 CommercialRuntimeStatus)。 */
  runtimeStatus?: CommercialRuntimeStatus;
  /**
   * WebSocket upgrade 处理器:gateway 在 HTTP server 的 `upgrade` 事件里调用。
   * 返回 true → commercial 已处理(可能是鉴权失败 + destroy,也可能是成功 upgrade);
   * 返回 false → 非 commercial 路由(如 `/ws`),gateway 自行处理。
   */
  handleWsUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** 关闭所有商业化资源(pool / redis / ws)。 */
  shutdown: () => Promise<void>;
  /**
   * V3 2H:内部 anthropic 代理监听地址(`{host, port}`),用于:
   *   - /healthz 反映启用状态
   *   - 测试断言代理已上线
   *   - dev 工具按地址探活
   * 未启用(env 缺失 / skipInternalProxy / 监听失败)时为 undefined。
   */
  internalProxyAddress?: { host: string; port: number };
  /**
   * V3 D.1b:外部 mTLS 监听地址(18443)。remote-host node-agent L7 反代从这里进。
   * 未启用(EXTERNAL_MTLS_ENABLED != 1 / 缺 bind/port / 监听失败)时为 undefined。
   */
  externalMtlsAddress?: { host: string; port: number };
  /**
   * Commercial access JWT 的 HMAC 密钥(已规范化为 ≥32 byte Uint8Array)。
   *
   * 暴露给 gateway,使其在 checkHttpAuth / getUserId 时能识别 commercial
   * 模块签发的 JWT —— 否则商用版用户登录后调 personal-version 沿用的
   * `/api/agents` `/api/sessions/*` 等路由会一律 401(因为 personal 版
   * checkHttpAuth 用 `gateway.accessToken` 当 HMAC,而 commercial JWT
   * 用 JWT_SECRET,两个 secret 完全不同)。
   *
   * gateway 用同步 HS256 验签(node:crypto.createHmac),不引入 jose 依赖,
   * 也不需要把 checkHttpAuth 链路改 async(改动面太大)。
   */
  jwtSecret: Uint8Array;
  /**
   * V3 multi-tenant `/api/uploads` 写入与 `/api/media` 读取的存储路径解析器。
   *
   * 把 `c:<uid>` 形式的 userId 映射到这台 master 上**用户 docker volume 宿主路径**
   * 的 uploads / generated **两个子目录**(同一 docker volume,一次 inspect 同时
   * 确认两 dir 可用)。容器侧 dispatchInbound / codex `image_gen` 通过相同的
   * volume mount 分别看到 `/home/agent/.openclaude/(uploads|generated)/`,从而
   * 消除 "master 写到自己 paths.{uploads,generated}Dir / 容器读自己同名 dir"
   * 的双视图 bug(两次同型回归:2026-05-09 uploads + 2026-05-12 generated)。
   *
   * 装配条件:agentRuntime 起得来(有 docker client)+ pool 已建立。两者任一缺失
   * (e.g. AGENT_IMAGE 没配),resolver 为 undefined,gateway 自动回退到旧的
   * `paths.uploadsDir` / `paths.generatedDir`(personal/单租户兼容)。
   *
   * fail-closed:DB 查无 active container → not-ready;远程 host → remote-host;
   * 多条 active → ambiguous;volume 不存在 → volume-missing。gateway 转译为对应
   * HTTP 4xx/5xx,不做静默回退。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocation>;
  /**
   * V3 multi-tenant **textual** 谓词:判定一个 resolvedPath 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— 只检查路径形态,不验证 uid 等于当前请求 userId。
   * gateway HTTP allowlist **不能**用它(会引入 cross-tenant IDOR:用户 A 拿到
   * 用户 B 的绝对路径就能读)。allowlist 的 user-scoped predicate 应该用
   * `resolveUserMediaDirs(userId)` 解析出当前用户的 `{uploads, generated}` 后
   * 自己 closure。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean;
  /**
   * v1.0.192 — 给 gateway `handleUpload` 在写 user docker volume 之前用的
   * 冷启动护栏。**结构化返回**(不抛 ContainerUnreadyError),让 gateway 保持
   * 零编译期依赖 commercial 子模块的边界(server.ts 头部明确注释:不 import
   * @openclaude/commercial)。
   *
   * 其他 error(DB 抖 / docker daemon 不可达 / supervisor wired-but-broken)
   * 仍然 throw,gateway 端 catch 后兜底 503。
   *
   * 共享同一 per-uid singleflight(与 commercial 内部 `/api/media-signed` +
   * WS bridge 同闭包),reload 时不会让 upload 路径成为 DB INSERT race 输家。
   *
   * 未注入(agentRuntime 没起 / v3Deps 缺) → gateway 直接跳过冷启动护栏,
   * 走原 `_resolveMediaDirs` 行为(personal/legacy 单租户路径)。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<{ ok: true } | { ok: false; retryAfterSec: number; reason: string }>;
  /**
   * 2026-05-16 hotfix — remote-host upload push hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `{kind:"fail", reason:"remote-host",
   * hostUuid, uploads, generated}` 时,gateway 把本地暂存好的字节(stream→
   * digest 校验完成)通过这个 hook 推到 host 上的 docker volume:
   *   `${uploads}/${digest}.${ext}` 或 `${generated}/${name}`
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentPutFile(target,
   * remotePath, content, 0o644, 1000, 1000) → finally psk.fill(0)。
   *
   * 错误语义:任意阶段失败(row 不存在 / agent 不可达 / HTTP >=400)直接抛,
   * gateway 转 502 "remote storage push failed";frontend 重试合理。
   *
   * 装配条件同 `resolveUserMediaDirs`(agentRuntime 在手),为简化保持总是
   * 装配 —— closure 内部自己用 pool,与上面的 resolver 一致。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  /**
   * 2026-05-16 hotfix Phase 2 — remote-host **读路径**对称 hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `remote-host` 失败,gateway 的
   * `handleMediaGet` / `handleApiFile` 通过本 hook 从远端 node-agent /files GET
   * 拉用户卷下的文件回 master,由 master 服给浏览器/API 客户端。
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentGetFile(target,
   * remotePath) → finally psk.fill(0)。
   *
   * 返回:
   *   - `Buffer` (含空 Buffer = 0 字节文件,合法):远端命中
   *   - `null`:远端 404(node-agent 明确不存在,gateway 可选择 fallback 到另一
   *     目录或最终 404 给用户)
   *
   * 错误:任意阶段失败(row 不存在 / agent 不可达 / mTLS / HTTP >=400 非 404)
   *   直接抛 → gateway 转 502 "remote storage pull failed";frontend 重试合理。
   *
   * 装配条件、psk 清零纪律与 `pushRemoteHostUpload` 完全对称。
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string;
    remotePath: string;
  }) => Promise<Buffer | null>;
  /**
   * P1.7 slice 7c — WeChat broker 入站入口。
   *
   * 装配条件:
   *   - cfg.WECHAT_BROKER_ENABLED === true (env WECHAT_BROKER_ENABLED=1)
   *   - selfHostUuid / dispatchInternal 等基础设施已就绪
   *
   * gateway 不 import commercial 类型 — 这里只暴露 broker.onInbound 的最小投影
   * (结构对齐 gateway 的 `CommercialHook.wechatBroker.onInbound` 形状)。返回
   * `unknown` 让 caller 不感知 BrokerInboundOutcome 内部 union;broker 自己
   * never-throw,caller 不需要 try/catch。
   */
  /**
   * healthz 深度探活:gateway healthz 经此 seam 探 commercial 强依赖(PG/Redis),
   * 补"依赖宕机但 healthz 仍绿零告警"的盲区。返回 { pg, redis } 各自 ok/err,
   * 内部 2s 超时;gateway 未拿到该函数(旧接线/个人版)时退回仅探 sessions.db。
   */
  probeDeps?: () => Promise<Record<string, { ok: true } | { ok: false; error: string }>>;
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string;
      accountId?: string;
      senderId: string;
      text: string;
      messageId?: string;
      itemTypes?: string;
      rawPayload?: unknown;
      mediaAttachments?: import("@openclaude/channel-wechat").WechatMediaAttachment[];
      imageAttachments?: import("@openclaude/channel-wechat").WechatImageAttachment[];
      idempotencyKey: string;
      receivedAt: number;
      channel?: "wechat";
      agentId?: string;
    }): Promise<unknown>;
    cleanupBinding(bindingUserId: string): Promise<unknown>;
  };
}

// ─── D.1b: 18443 mTLS 反代前置校验 ─────────────────────────────────────────
//
// remote-host 的 node-agent 通过 mTLS 把容器出站 POST 反代到 master:18443。
// 入口做四件事:
//   1. TLS 层已经验了证书链;我们还要从 SAN URI 解出 host uuid
//   2. DB 查 `compute_hosts.id = hostUuid`:确认 status='ready' + fingerprint pin
//      (fingerprint 校验是撤销机制 —— cert 泄露时 admin 轮换 db 行的 fp 即时生效)
//   3. 校验 X-V3-Container-IP 头:只允许单一字符串、不含 CR/LF、且是合法 IPv4
//   4. 去掉 X-V3-Container-IP 头,再把请求以 { hostUuid, boundIp } ctx 交给 proxyHandler
//
// 任意校验失败都直接以 JSON error 结束;不进 proxy,不消耗 account,不扣分。

/** Raw DER → PEM。node TLSSocket.getPeerCertificate(true).raw 是 DER Buffer。 */
function derToPem(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function sendMtlsError(
  res: ServerResponse,
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* socket gone */ }
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { code, ...(extra ?? {}) } }));
}

async function handleExternalMtls(
  req: IncomingMessage,
  res: ServerResponse,
  proxyHandler: AnthropicProxyHandler,
): Promise<void> {
  const socket = req.socket as TLSSocket;
  // TLS 层已经 rejectUnauthorized:true,到这里 authorized 理论必真;额外 belt-and-suspenders
  if (!socket.authorized) {
    sendMtlsError(res, 401, "PEER_UNAUTHORIZED", { reason: socket.authorizationError?.message });
    return;
  }
  const peerCert = socket.getPeerCertificate(true);
  if (!peerCert || !peerCert.raw || peerCert.raw.length === 0) {
    sendMtlsError(res, 401, "NO_PEER_CERT");
    return;
  }

  // SPIFFE URI → host uuid
  const certPem = derToPem(peerCert.raw);
  let uris: string[];
  try {
    uris = await extractSpiffeUris(certPem);
  } catch {
    sendMtlsError(res, 403, "CERT_PARSE_FAIL");
    return;
  }
  const hostUri = uris.find((u) => u.startsWith("spiffe://openclaude/host/"));
  if (!hostUri) {
    sendMtlsError(res, 403, "NO_HOST_SPIFFE");
    return;
  }
  const hostUuid = extractHostUuidFromSpiffe(hostUri);
  if (!hostUuid) {
    sendMtlsError(res, 403, "BAD_SPIFFE_URI");
    return;
  }

  // DB state + fingerprint pin。**不做 in-proc cache**,每请求一查 —— admin 轮换 fp 就即时生效
  const row = await computeQueries.getHostById(hostUuid);
  if (!row) {
    sendMtlsError(res, 403, "HOST_NOT_FOUND");
    return;
  }
  // A3 — 终态 revoked host(被入侵/下线)不得再用 file-proxy。setRevoked 已把
  // agent_cert_fingerprint_sha256 置 NULL,下面 expectedFp 检查本就会 fail-closed;
  // 这里显式拒一遍,给出明确 reason code + 不依赖"fp 一定被清"的隐式不变量。
  if (row.status === "revoked") {
    sendMtlsError(res, 403, "HOST_REVOKED");
    return;
  }
  const expectedFp = row.agent_cert_fingerprint_sha256;
  if (!expectedFp) {
    sendMtlsError(res, 403, "NO_PINNED_FP");
    return;
  }
  // peerCert.fingerprint256 是 "AA:BB:..." 冒号分隔大写 hex。
  // 异常 TLS 对象形态下可能为 undefined/"",统一落 401 而非走到后面抛 500。
  if (!peerCert.fingerprint256 || typeof peerCert.fingerprint256 !== "string") {
    sendMtlsError(res, 401, "NO_PEER_FINGERPRINT");
    return;
  }
  const presentedFp = peerCert.fingerprint256.replace(/:/g, "").toLowerCase();
  const pBuf = Buffer.from(presentedFp, "hex");
  const eBuf = Buffer.from(expectedFp.toLowerCase(), "hex");
  if (pBuf.length !== eBuf.length || pBuf.length === 0 || !timingSafeEqual(pBuf, eBuf)) {
    sendMtlsError(res, 403, "FINGERPRINT_MISMATCH");
    return;
  }

  // 0042 — agent-uplink-probe 专用快路径:绕过 status='ready' 与 X-V3-Container-IP 校验。
  // 目的:让 quarantined host 也能从 uplink-probe-failed 自愈;同时不开放任何代理能力,
  // 仅返回 200 {ok:true,hostUuid} 让 agent 知道 mTLS+fingerprint 校验通过。
  // 请求路径硬匹配 GET /v3/agent-uplink-probe。
  if (req.method === "GET" && req.url === "/v3/agent-uplink-probe") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, hostUuid }));
    return;
  }

  // 业务流量(/v1/messages 等)需要 host 处于 ready
  if (row.status !== "ready") {
    sendMtlsError(res, 503, "HOST_NOT_READY", { status: row.status });
    return;
  }

  // X-V3-Container-IP 校验:三重防御(数组 / CRLF header-folding / 非 IPv4)
  const rawIp = req.headers["x-v3-container-ip"];
  if (Array.isArray(rawIp)) {
    sendMtlsError(res, 400, "IP_HEADER_ARRAY");
    return;
  }
  if (!rawIp || typeof rawIp !== "string") {
    sendMtlsError(res, 400, "IP_HEADER_MISSING");
    return;
  }
  if (rawIp.includes("\r") || rawIp.includes("\n")) {
    sendMtlsError(res, 400, "IP_HEADER_CRLF");
    return;
  }
  if (!isIPv4(rawIp)) {
    sendMtlsError(res, 400, "IP_HEADER_NOT_IPV4");
    return;
  }

  // 剥掉 X-V3-Container-IP 头,防止透传到 anthropic 上游
  delete req.headers["x-v3-container-ip"];
  await proxyHandler(req, res, { hostUuid, boundIp: rawIp });
}

/**
 * 从 commercial config 派生 host 静态 provider 平台 key 表(注入 gateway seam)。
 *
 * 单一权威:遍历 STATIC_PROVIDER_META,按各 provider 的 `keyConfigField` 从 cfg 取 key 值
 * (不硬编码 id→字段名映射,与 proxy 侧共用同一份权威,零漂移)。全体静态 provider 都是**非
 * codex**(codex 走 OAuth,不在 STATIC_KEY_PROVIDERS)—— 即"只注入非 codex 静态 provider 的
 * key"。缺某个 key → 该 id 留 undefined(resolveHostStaticProviderEnv 命中其模型时 fail-closed,
 * resolveSyntheticTurnModel 的 routable 自检据此不降级,符合预期)。
 */
function buildHostStaticProviderKeys(cfg: CommercialConfig): StaticProviderKeys {
  const keys: StaticProviderKeys = {};
  for (const id of Object.keys(STATIC_PROVIDER_META) as StaticProviderId[]) {
    const raw = cfg[STATIC_PROVIDER_META[id].keyConfigField];
    if (typeof raw === "string" && raw.trim()) keys[id] = raw;
  }
  return keys;
}

/**
 * 注册商业化模块。
 *
 * 1. 校验 env(loadConfig)— 缺失/非法直接抛 ConfigError
 * 2. 自动跑 schema migrations(除非 COMMERCIAL_AUTO_MIGRATE=0)
 * 3. 装配 ioredis 客户端 + HTTP 处理器
 * 4. warmupLoginDummyHash 提前算 dummy argon2 hash(否则首个错登录请求要等 ~80ms)
 * 5. 返回 { handle, shutdown }
 *
 * @param app — gateway 应用对象;预留参数,目前未直接使用,以便后续 hook
 * @returns 包含 handle 和 shutdown 的对象
 */
export async function registerCommercial(
  app: unknown,
  options: {
    /** 测试可注入 jwt secret 而非从 env 读 */
    jwtSecret?: string | Uint8Array;
    /**
     * V3 Phase 2 Task 2H:用户 WS 桥接的容器端点解析器。
     *
     * 默认实现:始终 throw `ContainerUnreadyError(retryAfterSec=5, "supervisor_not_wired")`,
     * 使前端按 4503 重试。Phase 3D 的 supervisor.ensureRunning 应注入实现替换。
     *
     * 测试可注入 stub 直接返回 host/port。
     */
    resolveContainerEndpoint?: ResolveContainerEndpoint;
    /**
     * V3 Phase 2 Task 2H:跳过启动内部 anthropic 代理 listener(测试默认 true 避免抢端口)。
     * 生产侧由 cli launcher 显式置 false 让代理上线;dev/CI 不需要。
     */
    skipInternalProxy?: boolean;
    /**
     * 版本握手(v5 spa):静态前端 dist 目录。webRoot 的路径决策权威在 cli launcher
     * (commands/gateway.ts,按 OC_RUNTIME_CHANNEL 分流),此处只透传,不做第二次推导。
     * 注入后 userChatBridge 会在每个 userWs accept 时下发 `sys.frontend_build` 帧
     * (见 ws/frontendBuild.ts)。v3 / 测试不传 → 功能整体 inert。
     */
    webDistDir?: string;
    /** 当前 gateway 实际监听端口;Quick Tunnel 必须回源到本 slot,不能固定指向 A。 */
    gatewayPort?: number;
  } = {},
): Promise<RegisterCommercialResult> {
  void app;

  // 步骤 5 兼容地板(方案 §7 步 5,R3-B4):cutover marker 置位后禁止在 flag 关闭态下起。
  // 放在最前 —— 拒启要发生在任何 DB/容器/调度器副作用之前。
  assertModelAuthorityCutoverFloor();

  const cfg = loadConfig();

  // v5 灰度 — 运行时 channel 单一权威。OC_RUNTIME_CHANNEL 默认 "v3"(现网零行为变化)。
  // v5=follower:控制面(后台 mutator,会写共享 PG/账号池/订单/发邮件)必须静默,
  // 直到 P1 控制面权威收敛 + leader 选举再按需放开。controlPlaneEnabled 作为单一闸门
  // 直接 AND 进每个后台 mutator 的启动条件 —— 根除"漏关某个 *_DISABLED 即污染共享现网"
  // 的整类风险(个别 *_DISABLED 仍保留为 v3 细粒度运维开关)。
  const runtimeChannel = process.env.OC_RUNTIME_CHANNEL?.trim() || "v3";
  // 控制面 leader 权威从 channel 解耦为显式信号 OC_CONTROL_PLANE_LEADER(见
  // resolveControlPlaneLeader 文档)。未设时行为与旧代码完全一致(v3=leader / v5=follower)。
  const controlPlaneEnabled = resolveControlPlaneLeader(process.env, runtimeChannel);

  // ── mutator 归属矩阵(单一权威源)─────────────────────────────────────────
  // 每个后台 scheduler/worker 创建即经 trackScheduler 登记,登记必须声明数据域归属:
  //   "shared"   共享现网数据域(订单/账号池/容器面/邮件等) → 只允许 controlPlaneEnabled
  //              (即当前 leader,由 OC_CONTROL_PLANE_LEADER 决定)运行;follower 下出现即 fail-closed 拒启。
  //   "v5-owned" v5 独有数据域(0096 订阅周期等 v3 现网树根本没有对应代码的表) →
  //              channel=v5 也必须运行,否则该域权威真空(free 月度重置/到期降级无人执行)。
  //   "local"    纯进程内自愈(无 DB/网络副作用,如 slot 租约回收) → 任何 channel 都运行。
  // enabledSchedulers 由本登记表**派生**——根除"创建了 scheduler 但忘登记 → 不变量断言
  // 出现盲区"的一类缺陷(此前 subscriptionRollover / imagePromote 均漏登记)。
  // scripts/check-schedulers.ts 强制 index.ts 内所有 scheduler 工厂调用必须包 trackScheduler。
  type MutatorDomain = "shared" | "v5-owned" | "local";
  const schedulerRegistry: Array<{ name: string; domain: MutatorDomain }> = [];
  const unregisterMutator = (name: string): void => {
    const i = schedulerRegistry.findIndex((s) => s.name === name);
    if (i >= 0) schedulerRegistry.splice(i, 1);
  };
  function trackScheduler<T>(name: string, domain: MutatorDomain, handle: T): T {
    // 幂等:同名重复登记只记一次(imagePromote 在 gate 判定点先同步登记占位,
    // 异步 initComputePool 完成后真正 .start() 时再包一层 —— 不产生重复项)。
    if (handle && !schedulerRegistry.some((s) => s.name === name)) {
      schedulerRegistry.push({ name, domain });
    }
    return handle;
  }

  // v5 follower 硬约束 —— fail-closed,早于一切共享-state 副作用。
  // P1d 起:v5 容器隔离已就位(runtime_channel 贯穿 writer/reader/sweeper/docker label/name/
  // volume/network + 复合唯一索引 + v5-net 172.31 + v5 内部代理),故 v5 合法使用 v3-supervisor
  // 容器路径(OC_RUNTIME_IMAGE)——不再是 offender。仍硬拦下列会写共享现网的危险 env:
  //   - AGENT_IMAGE:legacy agent 路径(v5 不走;会起 lifecycle scheduler 写共享)
  //   - WECHAT_BROKER_ENABLED=1:渠道 broker 写共享 outbox/session
  // (compute-pool 写仍由 OC_IMAGE_DISTRIBUTE_DISABLED=1 + 无 COMPUTE_POOL_SELF_HOST_UUID 挡;
  //  控制面 sweeper 仍由 controlPlaneEnabled=false + 各 *_DISABLED + 末尾 enabledSchedulers 不变量挡。)
  if (runtimeChannel === "v5") {
    const offenders: string[] = [];
    if (process.env.AGENT_IMAGE) offenders.push("AGENT_IMAGE");
    if (process.env.WECHAT_BROKER_ENABLED === "1") offenders.push("WECHAT_BROKER_ENABLED=1");
    if (offenders.length > 0) {
      throw new Error(
        `[commercial] v5 follower 禁止 legacy/渠道副作用(写共享现网),检测到危险 env=[${offenders.join(
          ",",
        )}],拒启。`,
      );
    }
    // 内部代理双权威错位防护(Codex 重要项):listener 实际 bind 读 INTERNAL_PROXY_BIND/PORT
    // env,而容器 egress 目标由 ocGatewayIpForChannel()/ocInternalProxyPortForChannel() 计算。
    // 二者必须一致,否则容器把 API 打到一个没人监听的地址 → 全部 turn fail。env 漏配/错配时
    // fail-closed 拒启,而非上线后才发现 v5 容器一调用就挂。expected 来自单一权威 helper。
    const expectBind = ocGatewayIpForChannel(); // v5 → 172.31.0.1
    const expectPort = ocInternalProxyPortForChannel(); // v5 → 18892
    const actualBind = process.env.INTERNAL_PROXY_BIND?.trim();
    const actualPort = Number(process.env.INTERNAL_PROXY_PORT?.trim());
    if (process.env.OC_EGRESS_SPLIT === "1") {
      // egress split(2026-07-02):容器出站地址(INTERNAL_PROXY_*)由独立 egress
      // 进程监听(它自己带同款 fail-closed guard,见 egress/main.ts),master 改听
      // loopback 控制口。这里只验证控制口配置齐全 + 秘钥在位——master 若仍试图
      // bind 容器地址会跟 egress 撞端口,而漏配控制口会让转发面全 503。
      const cb = process.env.INTERNAL_CONTROL_BIND?.trim();
      const cp = process.env.INTERNAL_CONTROL_PORT?.trim();
      if (!cb || !cp || !process.env.OC_EGRESS_SECRET) {
        throw new Error(
          "[commercial] OC_EGRESS_SPLIT=1 但 INTERNAL_CONTROL_BIND/PORT/OC_EGRESS_SECRET 未配齐,拒启。",
        );
      }
    } else if (actualBind !== expectBind || actualPort !== expectPort) {
      throw new Error(
        `[commercial] v5 内部代理 env 与 channel 期望不符:` +
          `INTERNAL_PROXY_BIND=${actualBind ?? "(unset)"} (期望 ${expectBind}),` +
          `INTERNAL_PROXY_PORT=${process.env.INTERNAL_PROXY_PORT ?? "(unset)"} (期望 ${expectPort})。` +
          `容器 egress 与 listener bind 须一致,拒启。`,
      );
    }
  }

  // 共享 PG schema 迁移同样受控制面单一权威 gate:v5 follower 绝不迁移共享库
  // (防漏配 COMMERCIAL_AUTO_MIGRATE=0 仍误改现网 schema)。一次计算,供下方 runtimeStatus 复用。
  const autoMigrateEffective = controlPlaneEnabled && shouldAutoMigrate();
  if (autoMigrateEffective) {
    // eslint-disable-next-line no-console
    console.log("[commercial] auto-migrate: running...");
    const r = await runMigrations({
      // eslint-disable-next-line no-console
      onApply: (v) => console.log(`[commercial] auto-migrate applied ${v}`),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] auto-migrate done. applied=${r.applied.length} skipped=${r.skipped.length}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] auto-migrate disabled (controlPlaneEnabled=${controlPlaneEnabled} channel=${runtimeChannel})`,
    );
  }

  // ── P2:master 会话权威 backend 选择(RFC-v5-sessions-pg D1 启动矩阵)────────────
  // 放在 config 加载 + auto-migrate(0134 表须先在)之后、一切 schedulers/backend 消费之前。
  // channel=v5 = master 形态(容器内 gateway / 个人版不加载 commercial → 天然 SQLite,零变化)。
  // 依 OC_SESSIONS_STORE + PG 状态行 + 本地 manifest 三元组裁决 sqlite/pg;矩阵之外 fail-closed
  // 拒起(resolveSessionsStoreAuthority 抛错即 registerCommercial 抛错 = master 拒起)。
  // 驱动选择权威在此一处(composition root),函数内禁 if(pg) 分支;pg 则一次性 setClientSessionsBackend。
  let sessionsGcSweeper: { stop: () => Promise<void> } | null = null;
  let turnDispatchShutdownHandoff: (() => Promise<unknown>) | undefined;
  let losslessTurnTapeStorage: LosslessTurnTapeStorage | undefined;
  // durable turn dispatch(RFC §2):受理、tape-state 与真实终态读需 DispatchAdmissionBackend 面。
  let dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  const goalUsageRefreshRef: {
    current: (userId: string, sessionId: string) => void | Promise<void>;
  } = { current: () => { /* GoalState service is assembled below. */ } };
  if (runtimeChannel === "v5") {
    const decision = await resolveSessionsStoreAuthority({ pool: getPool() });
    if (decision.store === "pg") {
      const pgSessionsBackend = createPgSessionsBackend(getPool(), {
        expectedGeneration: decision.generation,
        onGoalUsageChanged: (userId, sessionId) => goalUsageRefreshRef.current(userId, sessionId),
      });
      setClientSessionsBackend(pgSessionsBackend);
      losslessTurnTapeStorage = pgSessionsBackend;
      dispatchAdmissionBackend = pgSessionsBackend;
      // advisory lease fencing 下的 usage 聚合 GC(RFC D3):双 master 只由持锁者执行。
      // trackScheduler 登记为 v5-owned(会话正文权威落 PG 是 v5 独有数据域)。
      sessionsGcSweeper = trackScheduler("sessionsGcSweep", "v5-owned", startSessionsGcSweeper({
        pool: getPool(),
        onGoalUsageChanged: (userId, sessionId) => goalUsageRefreshRef.current(userId, sessionId),
        onStats: (s) => {
          if (s.pendingFolded || s.pendingUnreachableExpired || s.tapePartsPurged) {
            rootLogger.info("[sessionsGcSweep] lossless 收尾 GC", {
              pendingFolded: s.pendingFolded,
              pendingUnreachableExpired: s.pendingUnreachableExpired,
              tapePartsPurged: s.tapePartsPurged,
            });
          }
          // 折叠异常 = (request_id,user_id) 已有坐标/金额不符的 cost component。行被
          // 保留待人工核对;持续非零应查 appendCostCredits/finalize 两路径的归因分歧。
          if (s.pendingFoldAnomaly) {
            rootLogger.warn("[sessionsGcSweep] pending 折叠异常(component 坐标不符,行已保留)", {
              pendingFoldAnomaly: s.pendingFoldAnomaly,
            });
          }
        },
      }));
      // eslint-disable-next-line no-console
      console.log(`[commercial] sessions store authority = PG (generation=${decision.generation})`);
    } else {
      // eslint-disable-next-line no-console
      console.log("[commercial] sessions store authority = SQLite(未割接 / 基建先行期)");
    }
  }

  // ── P3 双 master 蓝绿:LeaderBundle + lease + desired watch + 控制口 VIP(RFC D3/D4)─────────
  // 本 slot 静态身份(RFC §3:A/B)。默认 'A'——基建版现有 unit 即 A slot。非法值 fail-closed。
  const ocSlotRaw = process.env.OC_SLOT?.trim() || "A";
  if (ocSlotRaw !== "A" && ocSlotRaw !== "B") {
    throw new Error(`[commercial] OC_SLOT 必须是 'A'|'B'(当前=${JSON.stringify(process.env.OC_SLOT)}),拒起`);
  }
  const ocSlot: Slot = ocSlotRaw;
  // 双 master 是 v5 特性:v5 走 lease-gated bundle + 控制口 VIP;非 v5(v3/个人版)保持旧 eager 语义。
  const dualMasterEnabled = runtimeChannel === "v5";
  // LeaderBundle 始终构造(统一收口 shared+4 特例调度器的启动);触发方式按 channel 分流(见文末)。
  // onMemberStopped:成员 drain 后从 schedulerRegistry 摘除,让 healthz schedulers getter 实时反映让位。
  const leaderBundle: LeaderBundle = createLeaderBundle({
    onMemberStopped: (name) => unregisterMutator(name),
    onError: (ctx, err) => rootLogger.warn(`[leaderBundle] ${ctx}`, { err: (err as Error)?.message ?? String(err) }),
    logger: {
      info: (m) => rootLogger.info(m, { subsys: "leaderBundle" }),
      warn: (m, meta) => rootLogger.warn(m, { subsys: "leaderBundle", meta }),
    },
  });
  // 平台 preset 的 current_approved_version_id 是双 slot 共享 PG 状态，不能由 0% standby
  // candidate 在进程启动时 eager 改写。真正的实现会在 pricing/marketplace 依赖装配完成后
  // 赋给此闭包，并仅由 leadership acquire 路径 await；旧 slot 在 abort/rollback 后重新
  // acquire 时也会按其 release 自带定义幂等重指 current，形成确定性补偿。
  let seedPlatformAgentsForLeadership: () => Promise<void> = async () => {};
  // desired watch(5s 轮询缓存):lease 读 desired_leader_slot,控制口读 desired_control_slot。仅 v5 需要。
  let deployDesiredWatch: DesiredWatch | undefined;
  let leaderLease: LeaderLeaseController | undefined;
  let controlListener: ControlListener | undefined;
  if (dualMasterEnabled) {
    deployDesiredWatch = startDesiredWatch({
      pool: getPool(),
      onError: (err) => rootLogger.warn("[deployDesiredWatch] poll 失败(保留旧缓存)", { err: (err as Error)?.message ?? String(err) }),
    });
    // env 资格严格解析('1'|'0';unset/非法=fail-closed 拒起)。与 controlPlaneEnabled 分职:
    // controlPlaneEnabled 仍供 auto-migrate 等一次性启动分支(读 env 资格不动);lease 用严格版。
    const eligibleEnv = resolveLeaderEnvEligibility(process.env);
    leaderLease = createLeaderLeaseController({
      pool: getPool(),
      slot: ocSlot,
      desiredWatch: deployDesiredWatch,
      eligibleEnv,
      callbacks: {
        // BLOCKER 1:onAcquire=bundle start-all-or-fail;required 成员起不来 → start() reject →
        // lease step-down + onFatal(fail-stop)。onFence 返回 {drained,stuck};drained:false → lease fail-stop。
        onAcquire: async () => {
          await leaderBundle.start();
          await seedPlatformAgentsForLeadership();
        },
        onFence: (reason) => {
          rootLogger.warn(`[leaderLease] fence → stopAndDrain bundle(${reason})`, { subsys: "leaderLease" });
          return leaderBundle.stopAndDrain();
        },
      },
      // fail-stop:无法安全持有/交出 leadership(bundle 半启动 / drain 有 stuck / 掉线后 ACK 也失败)时
      // 退进程,systemd Restart=on-failure 拉起后因 desired 判定以 standby 起,后继经 PID liveness 接管。
      onFatal: (reason, detail) => {
        rootLogger.error(`[leaderLease] FAIL-STOP: ${reason}`, { subsys: "leaderLease", detail: (detail as Error)?.message ?? detail });
        // eslint-disable-next-line no-process-exit
        process.exit(1);
      },
      logger: {
        info: (m, meta) => rootLogger.info(m, { subsys: "leaderLease", meta }),
        warn: (m, meta) => rootLogger.warn(m, { subsys: "leaderLease", meta }),
        error: (m, meta) => rootLogger.error(m, { subsys: "leaderLease", meta }),
      },
    });
  }

  const jwtSecret =
    options.jwtSecret ??
    process.env.COMMERCIAL_JWT_SECRET ??
    process.env.JWT_SECRET ??
    "";
  if (typeof jwtSecret === "string" && jwtSecret.length === 0) {
    throw new Error(
      "[commercial] COMMERCIAL_JWT_SECRET (or JWT_SECRET) must be set when COMMERCIAL_ENABLED=1",
    );
  }

  const redis = new IORedis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  // 预热 dummy hash:第一次登录无影响
  await warmupLoginDummyHash();

  // T-20: 初始化定价缓存。启动时 load,并开启 LISTEN pricing_changed
  // 以便 admin UI 改价时自动 reload。两步失败都不阻塞启动,让 gateway
  // 继续上线;HTTP handler 在 cache 空时会返 503 PRICING_NOT_READY,
  // 而 pricing 热路径(T-21 计费)会直接得到 "unknown model" —— 比把
  // 整个服务卡死更好。
  const pricing = new PricingCache();
  try {
    await pricing.load();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing initial load failed:", err);
  }
  try {
    await pricing.startListener(cfg.DATABASE_URL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing LISTEN setup failed:", err);
  }

  // 0060 — 把 per-model extra_system_prompt 注入到 gateway promptSlots。
  // gateway 不依赖 commercial(personal 版没这一行);commercial 启动时把 cache 反向暴露。
  // canonicalize 责任在 provider 层(plan):传入 firstParty 带日期 alias 也能命中 DB 短名。
  // PricingCache 缓存空(initial load 失败)时 get() 自然返 null → buildModelHintSlot 落 null,
  // 不会影响 prompt 构建。
  // canonical id 直接取 PricingCache 命中行的 model_id(详见 createModelHintProvider 注释)。
  setModelHintProvider(createModelHintProvider(pricing));

  // 2026-07-07 MAJOR-1 — host 静态 provider 平台直连 key seam。
  // host 平台 agent(main)的合成首帧(cron/webhook/task/inter-agent/openai-compat)解析到
  // 非 codex 静态模型(默认 deepseek-v4-pro)后,host CCB 子进程需平台静态 key 直连上游
  // (见 gateway/hostStaticProviders + subprocessRunner 注入点)。个人版不 import commercial →
  // seam 恒 null = 整块 no-op,settings.json 继续掌权。与 setModelHintProvider 同注册/清理生命周期。
  setHostStaticProviderKeys(buildHostStaticProviderKeys(cfg));

  // 0069 — SKILLS_LITERATURE slot 反向钩子:容器 spawn 重建 system prompt 时读窄配置,
  // admin 改完下次 spawn 自然生效(无 cache / 无 LISTEN/NOTIFY,见 0069 migration 注释)。
  // 关键最小权限分流:这里**只**调 getLiteratureSkillConfig()(不解密 token),bearer
  // plaintext 只在 proxy 路径(getLiteratureConfig(false))才会出现。
  // fail-soft:DB 抖动 → 返 null + warn,prompt 构建照样推进。
  setLiteratureSkillProvider(async () => {
    try {
      const cfg = await getLiteratureSkillConfig();
      if (!cfg.enabled || !cfg.token_set) return null;
      return {
        name: "SKILLS_LITERATURE",
        content: renderLiteratureSkillContent(cfg),
      };
    } catch (err) {
      // 单行 DB 读失败就跳过 slot,不要让 master DB 闪断拖垮容器系统 prompt 构建。
      // 选 warn 不 error:这条 slot 是增强非必需,日志噪声压低。
      // eslint-disable-next-line no-console
      console.warn("[commercial] literatureSkillProvider read failed, skipping slot:", err);
      return null;
    }
  });

  // T-24 虎皮椒:三件套齐全 → 生产 client;否则 undefined(handler 会 503)
  let hupijiao: HupijiaoClient | undefined;
  let hupijiaoConfig: Pick<HupijiaoConfig, "appId" | "appSecret"> | undefined;
  if (cfg.HUPIJIAO_APP_ID && cfg.HUPIJIAO_APP_SECRET && cfg.HUPIJIAO_CALLBACK_URL) {
    const fullCfg: HupijiaoConfig = {
      appId: cfg.HUPIJIAO_APP_ID,
      appSecret: cfg.HUPIJIAO_APP_SECRET,
      notifyUrl: cfg.HUPIJIAO_CALLBACK_URL,
      returnUrl: cfg.HUPIJIAO_RETURN_URL,
      endpoint: cfg.HUPIJIAO_ENDPOINT,
    };
    hupijiao = createHttpHupijiaoClient(fullCfg);
    hupijiaoConfig = { appId: fullCfg.appId, appSecret: fullCfg.appSecret };
  }

  const preCheckRedis = wrapIoredisForPreCheck(redis);

  const knowledgePlanetMediaResolverRef: {
    current: ((userId: string) => Promise<UserMediaLocation>) | undefined
  } = { current: undefined }
  const knowledgePlanetMediaDeps = {
    resolveUserMediaDirs: async (userId: string): Promise<UserMediaLocation> => {
      if (!knowledgePlanetMediaResolverRef.current)
        throw new Error('Knowledge Planet media resolver unavailable')
      return knowledgePlanetMediaResolverRef.current(userId)
    },
    pullRemoteHostMedia: async (args: { hostUuid: string; remotePath: string }) => {
      const target = await resolveServiceableHostTarget(args.hostUuid)
      try {
        return await nodeAgentGetFile(target, args.remotePath)
      } finally {
        target.psk?.fill(0)
      }
    },
    stagingRoot: '/var/lib/openclaude-v5/plugin-media-staging',
    expectedOwnerUid: 0,
  }

  // Generic Plugin facade is process-scoped and shared by container RPC + browser HTTP.
  // The official Knowledge Planet driver is enabled only on V5 with the immutable image ID;
  // a mutable tag is never accepted as the worker trust root.
  let knowledgePlanetService: KnowledgePlanetDockerService | undefined
  let knowledgePlanetSetup: KnowledgePlanetSetupManager | undefined
  let weiboService: WeiboDockerService | undefined
  let weiboSetup: WeiboSetupManager | undefined
  let knowledgePlanetAutomation: KnowledgePlanetAutomationService | undefined
  let pluginFacade: PluginRuntimeFacade
  if (runtimeChannel === 'v5' && cfg.OC_RUNTIME_IMAGE_ID) {
    const pluginDocker = cfg.AGENT_DOCKER_SOCKET
      ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
      : new Docker()
    knowledgePlanetService = new KnowledgePlanetDockerService(pluginDocker, {
      imageId: cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: '/var/lib/openclaude-v5/plugin-workers',
      brokerRoot: '/run/openclaude-v5/plugin-browser-brokers',
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    })
    weiboService = new WeiboDockerService(pluginDocker, {
      imageId: cfg.OC_RUNTIME_IMAGE_ID,
      workerRoot: '/var/lib/openclaude-v5/plugin-workers-weibo',
      brokerRoot: '/run/openclaude-v5/plugin-browser-brokers-weibo',
      expectedOwnerUid: 0,
      socketUid: 1000,
      socketGid: 1000,
    })
    const knowledgePlanetRegistries = createKnowledgePlanetRuntimeRegistries(knowledgePlanetService)
    const weiboRegistries = createWeiboRuntimeRegistries(weiboService)
    const browserRuntime = new ManagedBrowserRuntime({
      drivers: new Map([...knowledgePlanetRegistries.drivers, ...weiboRegistries.drivers]),
      launchers: new Map([...knowledgePlanetRegistries.launchers, ...weiboRegistries.launchers]),
      profileRoot: '/var/lib/openclaude-v5/plugin-browser-profiles',
      expectedOwnerUid: 0,
    })
    pluginFacade = new PluginRuntimeFacade({
      redis,
      browserRuntime,
      knowledgePlanetMedia: knowledgePlanetMediaDeps,
    })
    knowledgePlanetSetup = new KnowledgePlanetSetupManager(knowledgePlanetService, {
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    })
    weiboSetup = new WeiboSetupManager(weiboService, {
      redis,
      isAgentReady: (contract) => browserRuntime.supportsContract(contract),
    })
    knowledgePlanetAutomation = new KnowledgePlanetAutomationService(pluginFacade)
  } else {
    pluginFacade = new PluginRuntimeFacade({ redis })
  }

  // T-53: 装配 agent 运行时(image + seccomp + rpc dir + lifecycle scheduler)。
  // 任一必要字段缺失 → agentRuntime 置 undefined;/api/agent/open 返 503,/status 仍然可读。
  let agentRuntime: AgentHttpDeps | undefined;
  let lifecycleScheduler: LifecycleScheduler | undefined;
  const agentEnvStatus: Record<string, boolean> = {
    AGENT_IMAGE: !!cfg.AGENT_IMAGE,
    AGENT_NETWORK: !!cfg.AGENT_NETWORK,
    AGENT_PROXY_URL: !!cfg.AGENT_PROXY_URL,
    AGENT_SECCOMP_PATH: !!cfg.AGENT_SECCOMP_PATH,
    AGENT_RPC_SOCKET_DIR: !!cfg.AGENT_RPC_SOCKET_DIR,
  };
  const agentReady = Object.values(agentEnvStatus).every(Boolean);
  if (agentReady) {
    try {
      // Docker:走默认 socketPath 或 AGENT_DOCKER_SOCKET 覆盖
      const docker = cfg.AGENT_DOCKER_SOCKET
        ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
        : new Docker();
      // Seccomp profile 一次性读成字符串,后续 provision 直接用
      const seccompProfileJson = fs.readFileSync(cfg.AGENT_SECCOMP_PATH!, "utf8");
      // RPC socket 父目录启动时自愈:mkdir -p + 0700
      fs.mkdirSync(cfg.AGENT_RPC_SOCKET_DIR!, { recursive: true, mode: 0o700 });

      const agentLogger: LifecycleLogger = {
        info: (m, meta) => {
          // eslint-disable-next-line no-console
          console.log(m, meta ?? {});
        },
        warn: (m, meta) => {
          // eslint-disable-next-line no-console
          console.warn(m, meta ?? {});
        },
        error: (m, meta) => {
          // eslint-disable-next-line no-console
          console.error(m, meta ?? {});
        },
      };

      agentRuntime = {
        docker,
        image: cfg.AGENT_IMAGE!,
        network: cfg.AGENT_NETWORK!,
        proxyUrl: cfg.AGENT_PROXY_URL!,
        seccompProfileJson,
        rpcSocketHostDir: cfg.AGENT_RPC_SOCKET_DIR!,
        limits: {
          memoryMb: cfg.AGENT_MEMORY_MB,
          cpus: cfg.AGENT_CPUS,
          pidsLimit: cfg.AGENT_PIDS_LIMIT,
        },
        priceCredits: cfg.AGENT_PLAN_PRICE_CREDITS,
        durationDays: cfg.AGENT_PLAN_DURATION_DAYS,
        logger: agentLogger,
      };

      // Lifecycle scheduler:默认 1h tick,不在启动时跑
      lifecycleScheduler = trackScheduler("lifecycle", "shared", startLifecycleScheduler(docker, {
        intervalMs: cfg.AGENT_LIFECYCLE_TICK_MS,
        volumeGcDays: cfg.AGENT_VOLUME_GC_DAYS,
        logger: agentLogger,
        runOnStart: false,
      }));
      // eslint-disable-next-line no-console
      console.log("[commercial] agent runtime ready", {
        image: cfg.AGENT_IMAGE,
        network: cfg.AGENT_NETWORK,
        rpc_dir: cfg.AGENT_RPC_SOCKET_DIR,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] agent runtime init failed, disabling:", err);
      agentRuntime = undefined;
      if (lifecycleScheduler) {
        try { await lifecycleScheduler.stop(); } catch { /* */ }
      }
      lifecycleScheduler = undefined;
      unregisterMutator("lifecycle"); // 初始化失败已回滚 → 登记表同步撤销,不留幽灵项
    }
  } else {
    const missing = Object.entries(agentEnvStatus)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] agent runtime disabled; missing env: ${missing.join(", ")}`,
    );
  }

  // V3: account-pool 仍然装配(供 admin 列表/T-30 store + agent 容器内部 chat 走 anthropic
  // 中央代理时使用),但 v2 的 chat orchestrator(ws/chat + http/chat)已删除 —
  // v3 chat 不在 commercial 进程出口,而是在每个用户的 docker 容器里跑个人版,通过
  // anthropicProxy(2D)统一调上游。
  const healthRedis = wrapIoredisForHealth(
    redis as unknown as Parameters<typeof wrapIoredisForHealth>[0],
  );
  const healthTracker = new AccountHealthTracker({ redis: healthRedis });
  const scheduler = new AccountScheduler({ health: healthTracker });

  // V3 Phase 2 Task 2H:启动内部 Anthropic 代理监听(供容器内 OpenClaude 出站调用)。
  //
  // 非启用条件(任一即跳过,只 log warn 不阻塞主流程):
  //   - options.skipInternalProxy(测试用)
  //   - 缺 INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT
  //   - 任何监听异常 → 仅 log + 跳过(/healthz 会反映 internalProxy=false)
  //
  // 强约束:bind 已在 config.ts schema 拒绝 0.0.0.0/::,这里不再二次校验。
  // egress split 模式:容器出站地址(INTERNAL_PROXY_*)让位给独立 egress 进程,
  // master 的 internal listener 改绑 loopback 控制口(容器流量经 egress 转发到达,
  // /internal/v5/* 控制专用路径只有 egress 能直连)。未开 split → 完全旧行为。
  const egressSplitEnabled = cfg.OC_EGRESS_SPLIT === true;
  const proxyBind = egressSplitEnabled ? cfg.INTERNAL_CONTROL_BIND : cfg.INTERNAL_PROXY_BIND;
  const proxyPort = egressSplitEnabled ? cfg.INTERNAL_CONTROL_PORT : cfg.INTERNAL_PROXY_PORT;
  let internalProxyServer: HttpServer | undefined;
  let internalProxyHandler: AnthropicProxyHandler | undefined;
  let internalProxyAddress: { host: string; port: number } | undefined;
  let externalMtlsServer: HttpsServer | undefined;
  let externalMtlsAddress: { host: string; port: number } | undefined;
  // 2026-05-05 v3 commercial server-authored persistence:18791 plain + 18443 mTLS
  // 共享同一个 dispatcher,按 url path 分流到 anthropicProxy 或 internalServerAuthored。
  // 在 internalProxyHandler 构造完毕后赋值;mTLS listener 读它而不是 internalProxyHandler。
  let dispatchInternal: AnthropicProxyHandler | undefined;
  // Internal listeners are assembled before model-authority startup. Renewal
  // reads this forward ref at request time; startup windows fail closed 503.
  let modelAuthoritySigner: AuthoritySigner | undefined;
  let modelCatalogCache: ModelCatalogCache | undefined;
  // 前向引用占位:userChatBridge 在下方创建,但 anthropicProxy 在这里就要它的 broadcastToUser。
  // 给 proxy 的 dep 是稳定的闭包(总是调 bridgeBroadcastRef.current),创建 bridge 后赋值。
  // 在 bridge 初始化完成前到达的 cost_charged broadcast 会走到 noop,不 throw 也不落盘(前端
  // 看不到积分显示,但扣费本身仍生效;生产上 proxy 处理请求前 bridge 必已初始化)。
  const bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge 还没装好,静默丢弃 */ },
  };
  const mediaGenerationService = new MediaGenerationService({
    workerUrl: cfg.MEDIA_GENERATION_WORKER_URL,
    workerToken: cfg.MEDIA_GENERATION_WORKER_TOKEN,
    stateRoot: cfg.MEDIA_GENERATION_STATE_ROOT,
    allowUserIds: cfg.MEDIA_GENERATION_ALLOW_USER_IDS,
    maxInputBytes: cfg.MEDIA_GENERATION_MAX_INPUT_BYTES,
    maxUserStoredInputBytes: cfg.MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES,
    broadcast: (uid, frame) => bridgeBroadcastRef.current(uid, frame),
  });
  if (runtimeChannel === "v5" && mediaGenerationService.configured()) {
    leaderBundle.add({
      name: "mediaGeneration",
      domain: "v5-owned",
      start: () => mediaGenerationService.start(),
    });
  }
  const goalBroadcastRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge not assembled yet */ },
  };
  const goalSyncRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge not assembled yet */ },
  };
  const goalStateService = new GoalStateService({
    pool: getPool(),
    broadcast: (uid, snapshot) => goalBroadcastRef.current(uid, {
      type: 'sys.goal_snapshot',
      goal: snapshot,
    }),
    syncEngine: (uid, snapshot) => goalSyncRef.current(uid, snapshot),
  });
  goalUsageRefreshRef.current = async (userId, sessionId) => {
    if (!/^c:\d+$/.test(userId)) return;
    await goalStateService.refreshUsage(BigInt(userId.slice(2)), sessionId);
  };
  // 双槽私有 relay 的本槽 bridge forward-ref。控制口先起、bridge 后装配，窗口内安全返空。
  const slotRelayLocalRef: { current: SlotRelayLocal } = {
    current: { onlineUserSubset: () => [], broadcastToUsers: () => 0 },
  };
  const slotRelayClient = createSlotRelayClient({
    secret: cfg.OC_EGRESS_SECRET ?? "",
    logger: rootLogger.child({ subsys: "commercial", module: "slotRelay" }),
  });
  // ⚠️ 命名空间对齐(根因修复):商业版 session 存储(SQLite client_sessions /
  // pending_usage_patches / server_authored_request_map)的 user_id 是 `c:<uid>`
  // (MASTER_USER_PREFIX),而 proxy/bridge 传进来的是裸 uid(与 PG 计费同口径)。
  // appendCostCredits 直接打 session 存储,必须加同一前缀——否则 cost 落库的
  // (request_id, 裸uid) 与 server-authored 持久化写的 (request_id, c:uid) 永不 join,
  // 成本永久孤儿在 pending_usage_patches、落不到消息 usage.costCredits → 前端无积分徽章。
  // 姊妹 dep loadMasterSessionMessages 早已加前缀,此处历史漏加(去 codex 后全量 ccb 暴露)。
  const appendCostCreditsForUser = (
    requestId: string,
    rawUserId: string,
    costCredits: string,
    sessionId?: string | null,
    // delegate 子会话的父客户端会话 id(web-*);普通 chat / codex 自费恒 undefined。
    parentSessionId?: string | null,
    // P2 债D — 委派目标 agent id(与 parentSessionId 同源);普通 chat / codex 自费恒 undefined。
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) =>
    appendCostCredits(
      requestId,
      // 防双前缀:当前调用方都传裸 uid,但 guard 住将来复用误传 c: 前缀的情况(Codex 次要建议)。
      rawUserId.startsWith(MASTER_USER_PREFIX) ? rawUserId : MASTER_USER_PREFIX + rawUserId,
      costCredits,
      sessionId,
      parentSessionId,
      delegateAgentId,
      turnKey,
      parentTurnKey,
    );
  // P1.7 slice 7c — broker 前向引用。dispatchInternal 在 line ~883 装配,需要路由
  // `/internal/v3/wechat-outbound` → broker.outboundHandler;但 broker 本身依赖
  // resolveContainerEndpoint(line ~1529)装配完才能 makeInboundDispatcher → makeWechatBroker。
  // 这层 ref 把"路由表"(dispatchInternal)与"broker 实例"装配顺序解耦,与
  // bridgeBroadcastRef 同型:proxy 闭包总读 ref.current,broker 未就绪时短路 404 不 throw。
  const wechatBrokerRef: { current: WechatBroker | null } = { current: null };
  const autoDreamOptimizerRuntimeRef: { current: AutoDreamOptimizerRuntime | null } = {
    current: null,
  };
  // 主动微信投递接收点(cron/提醒 → master 权威解析收件人 → outbox)。与 broker 同生命周期,
  // 同条件块内装配;未装配时 dispatchInternal 显式 404(同 wechat-outbound 语义)。
  const wechatProactiveRef: { current: ProactiveReceiverHandler | null } = { current: null };
  const qqOutboundRef: {
    current: ReturnType<typeof makeQqOutboundReceiver> | null;
  } = { current: null };
  const qqProactiveRef: {
    current: ReturnType<typeof makeQqProactiveReceiver> | null;
  } = { current: null };
  // v1.0.120 feat/codex-disable-rebind:fanoutDeps 依赖 v3Deps.putRemoteCodexAuth,
  // 必须在 v3Deps 装配后才能赋值;但 proxy / codex token refresh
  // handler / commercialHttpDeps 在更早就要拿到 trigger 闭包,故用 ref 打破先后。
  //
  // 装配前到达的事件(理论不可能,proxy 接请求前 v3Deps 已就绪)走 noop。
  const triggerCodexDisableFanoutRef: { current: (accountId: bigint) => void } = {
    current: () => { /* fanoutDeps 还没装好,静默丢弃 */ },
  };
  const triggerCodexDisableFanout = (accountId: bigint): void => {
    triggerCodexDisableFanoutRef.current(accountId);
  };
  // D.1b: self host uuid 取失败只降级多机路径(proxy / v3Deps.containerService /
  // baselineServer),不牵连整个 commercial 启动。多处共用,提前一次性取。
  let selfHostUuid: string | undefined;
  try {
    selfHostUuid = (await computeQueries.getSelfHost()).id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] getSelfHost failed; multi-host routing + internal proxy disabled",
      { err: (err as Error)?.message ?? String(err) },
    );
    // selfHostUuid 保持 undefined;下面 proxy / v3Deps / baselineServer 全部靠 guard 跳过
  }

  // V3 CC 外接 plan Phase 3(2026-05-18):rateLimitRedis 与 loadUserModelAuthz
  // 都提到 internal 块外作为外层 const,让 container strategy(私有 18791/18443)
  // 和 api-key strategy(公网 /api/anthropic/v1/messages)共享同一份依赖闭包,
  // 避免两份同型实现长出漂移(Codex Phase 3 plan-review NIT 采纳)。
  //
  // 注:rateLimitRedis 仅在两条 proxy strategy 中消费;放在外层不会额外占资源
  // (redis 客户端是同一个,wrapIoredis 只是 typed-method 投影)。
  const sharedRateLimitRedis = wrapIoredis(redis);
  // 2026-07-02 egress split:authz 加载器抽到 auth/userModelAuthz.ts 单一权威
  // (master 与 egress 两进程共用同一份规则),语义与原内联实现逐行等价。
  const loadUserModelAuthz = makeLoadUserModelAuthz();

  if (
    !options.skipInternalProxy &&
    proxyBind &&
    proxyPort !== undefined &&
    selfHostUuid
  ) {
    // fail-closed guard(Codex plan review #4 + diff review Blocker):平台默认模型(2026-06-17 起
    // glm-5.3)路由到静态 provider ark,若 ARK_CODING_PLAN_KEY 未配 → throw,loud fail 拒绝启动。
    // guard 动态走 PLATFORM_DEFAULT_MODEL→provider→meta.keyConfigField,非硬编码某 provider。
    // 注:minimax(文本走 ARK_AGENT_PLAN_KEY)/deepseek 不是平台默认,其 key 不被本 guard 拦,
    // 缺失则命中各自模型时 503。
    // **必须放在下面 try 之外** —— 该 try 的 catch 只会打印 "internal proxy ... disabling" 并把
    // internalProxyHandler 置空后让 master 继续跑;若 guard 在 try 内,缺 key 会被降级吞成
    // "internal proxy 禁用但 master 照跑",违反 loud-fail。放 try 外则异常直接冒泡崩 master boot。
    // 触发面仅此 internal-proxy/agent-runtime 启动路径;unit test / external proxy harness 不进此分支。
    assertPlatformDefaultModelConfigured(cfg);
    try {
      const identityRepo = createPgIdentityRepo();
      const rateLimitRedis = sharedRateLimitRedis;
      // V3 Phase 2(2026-05-18 anthropicProxy 拆分):身份层 strategy。
      // 把 verify + recordHostRequest + loadUserModelAuthz + canUseModel 收口到
      // IdentityStrategy 单一注入点。loadUserModelAuthz 闭包形状不变(从权威源 DB
      // 读 role + grants,fail-closed throw → handler 500)。
      //
      // V3 CC 外接 plan Phase 3:loadUserModelAuthz 已提到外层共享(见上方注释),
      // 这里直接传引用,与 api-key strategy 走同一份业务规则。
      const identityStrategy = makeContainerIdentityStrategy({
        repo: identityRepo,
        pricing,
        loadUserModelAuthz,
        // recordHostRequest 不显式注入,strategy 内部走模块级 default
        // (../compute-pool/hostReqCounter.recordHostRequest)。
      });
      // ── 模型执行 catalog(模型权威批次 · 方案 §1.2/§4/§6)──────────────────────
      //
      // 进程内唯一一份(modelCatalogRuntime 单例)—— bridge 签发 / 内部下发端点 /
      // 本 handler 共用同一快照,避免同进程两份快照一新一旧导致 fence 结论互斥。
      //
      // **生产的 /v1/messages 不走这个 handler**(走独立 egress 进程,egress/main.ts 里
      // 有同构装配);这里是非 split 拓扑(dev/测试)的对等实现。
      //
      // 失败策略的非对称(有意):
      //   - enforce(OC_MODEL_AUTHORITY=1)→ 抛,拒启(半开状态 = 全站被 fence 拒,
      //     不如启动就响亮失败);
      //   - 影子期 → **fail-soft**:catalog 只是观测面,没有任何判定依赖它;此时因为
      //     0143 未 apply 就把 master 拒启,是纯自伤(零安全收益)。记 error 继续跑 legacy。
      const modelAuthorityEnforce = isModelAuthorityEnforced();
      let modelCatalogForProxy: Awaited<ReturnType<typeof getModelCatalogCache>> | undefined;
      try {
        modelCatalogForProxy = await getModelCatalogCache();
      } catch (err) {
        if (modelAuthorityEnforce) throw err;
        console.error(
          "[commercial] model catalog load failed (shadow mode → legacy 判定继续):",
          err,
        );
      }
      internalProxyHandler = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing,
        preCheckRedis,
        scheduler,
        modelCatalog: modelCatalogForProxy,
        modelAuthorityEnforce,
        authorityKeyring: authorityKeyringProvider(),
        identity: identityStrategy,
        loadUserModelAuthz,
        rateLimitRedis,
        // HOTFIX 2026-04-21: 不传 refreshDeps 导致 anthropicProxy 里
        //   `deps.refreshDeps && pick.expires_at && shouldRefresh(...)` 永远 false,
        // OAuth token 过期后不会自动 refresh,结果上游直接 401。
        // health 注入进来是为了 refresh 失败时按规约走 health.manualDisable。
        // v1.0.120:triggerCodexDisableFanout 注入 — disableOnFailure 内部
        // 按 provider 二次过滤,claude 账号 refresh 失败不会误触发 codex fanout。
        refreshDeps: { health: healthTracker, triggerCodexDisableFanout },
        // 真实扣费积分推送 —— proxy 在 finalize.commit 后调,通过 bridge 把
        // outbound.cost_charged 帧发给用户。bridge 启动顺序在 proxy 之后,
        // 故用 ref 打破先后(构造期调用是 noop,请求期 bridge 必已 wire)。
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
        // Plan §4.2 改动 4 — durable persist of debited costCredits into
        // master's `client_sessions.messages[i].usage.costCredits`. Storage
        // owns the (sessionId, msgId) lookup via `server_authored_request_map`
        // and falls back to `pending_usage_patches` when the assistant sink
        // POST hasn't landed yet.
        appendCostCredits: appendCostCreditsForUser, // c:<uid> 前缀对齐 session 存储命名空间
        // 静态 key 文本 provider 的 key 解析表(deepseek/minimax/ark)。cfg 在外层闭包已
        // loadConfig() 过,这里直接读取;某 provider 未配 → 命中其模型时 503(各自 reject reason)。
        // 这是 internal proxy(容器/agent runtime 走的上游),三个 provider 全注入。
        // key 只留 master,不进用户容器。平台默认模型 glm-5.3(ark)的 key(ARK_CODING_PLAN_KEY)缺失
        // 已由下方 assertPlatformDefaultModelConfigured guard 在装配前 loud-fail;minimax(文本走
        // ARK_AGENT_PLAN_KEY)/deepseek 不被该 guard 拦,缺失则命中其模型时 503。
        staticProviderKeys: {
          deepseek: cfg.DEEPSEEK_API_KEY,
          // 2026-07-07:minimax 文本/识图上游切回 MiniMax 官方,key 来源改回 MINIMAX_TOKEN_PLAN_KEY
          //(与媒体/搜索 proxy 同 key;回退 06-30 火山迁移,因火山 Ark 大图识图挂死)。
          minimax: cfg.MINIMAX_TOKEN_PLAN_KEY,
          ark: cfg.ARK_CODING_PLAN_KEY,
          // 2026-08-15:智谱国际版 Z.AI GLM Coding Plan(glm-5.3-zai)。
          zai: cfg.ZAI_CODING_PLAN_KEY,
          // 2026-07-05:OpenCode Go(qwen3.7-max/plus)。个人订阅配额,缺 key 命中时 503。
          opencodego: cfg.OPENCODE_GO_API_KEY,
          // 2026-07-06:火山 Agent Plan Kimi(kimi-k2.7-code),与 minimax 共 ARK_AGENT_PLAN_KEY。
          kimi: cfg.ARK_AGENT_PLAN_KEY,
          // 2026-07-22:火山 Agent Plan Kimi K3(kimi-k3-ark),同订阅/key、独立能力机制。
          "ark-k3": cfg.ARK_AGENT_PLAN_KEY,
          // 2026-07-17:Moonshot 官方 Kimi For Coding(kimi-k3),独立订阅独立 key。
          moonshot: cfg.MOONSHOT_CODING_PLAN_KEY,
          // 2026-08-04:阿里百炼 Token Plan(qwen3.8-max)，独立订阅独立 key。
          bailian: cfg.BAILIAN_TOKEN_PLAN_KEY,
        },
        // v1.0.207 起 Phase 6 account_uuid 锚定(plan §3.0)+ csap session pin 三态
        // (0072+0073+0074),从 env-only 迁到 `system_settings` 表(admin UI 立即可改,
        // 不需要 systemctl restart)。注入 30s TTL cache 的 getter
        // (`admin/runtimeFlags.ts`)— pickUpstream 入口 await 一次冻结到局部常量,
        // scheduler.pick 与 hook 同值消费,保留 plan §5.5.4 竞态防护设计。
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      // 2026-05-05 v3 commercial server-authored persistence — 复用 18791/18443
      // 同一个 listener,新加 POST /internal/v3/server-authored-message。
      // 路由由 dispatchInternal 按 url path 分流;仅 path 完全匹配 SERVER_AUTHORED_PATH
      // 才进新 handler,其它路径仍透到 anthropicProxy(其内部还有 /v1/messages 白名单)。
      // 新 handler 与 anthropicProxy 共用 (hostUuid, boundIp) ctx 与 verifyContainerIdentity 双因子。
      // 详见 packages/commercial/src/http/internalServerAuthored.ts。
      const serverAuthoredHandler: ServerAuthoredHandler = makeServerAuthoredHandler({
        identityRepo,
        losslessTurnTapeStorage,
        settleCodexBilling: async (userId, billing) => {
          await settleDurableCodexBilling(
            {
              pgPool: getPool(),
              preCheckRedis,
              pricing,
              logger: rootLogger.child({ subsys: "durableCodexBilling" }),
            },
            userId,
            billing,
          );
        },
        applyTurnWaiver: (input) => applyTurnWaiver(getPool(), input),
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
        storage: {
          appendServerAuthoredMessage,
          appendServerAuthoredMessageForRequest,
          appendServerAuthoredMessageDrainByUser,
          drainDelegateCostForClientSession,
          getClientSession,
          readArchivedMessages,
          patchServerAuthoredMessage,
        },
        recordOversized: ({ userId, requestId, sessionId }) => {
          void recordProductFrictionEvent({
            correlation: requestId,
            userId,
            surface: "session",
            stage: "persist",
            code: "SESSION_OVERSIZED",
            outcome: "failed",
            sessionId,
          }, getPool()).catch(() => {});
        },
      });
      // Codex reverse-RPC `account/chatgptAuthTokens/refresh` over HTTP.
      // Container's gateway forwards 401-recovery refresh asks here; we read
      // the bound codex_account, refresh upstream, persist to DB + per-container
      // auth.json under FOR UPDATE, and return the new token. Without this
      // path every codex 401 fails the turn (-32601 method-not-found).
      //
      // egress split(M1b 架构决策):装配收口在 http/codexInternalAssembly.ts,
      // 同一份实现同时在 egress 进程本地挂载(egress/main.ts,容器流量不过 master
      // → master 重启不断 codex 刷新/在飞流);master 侧挂载保留,服务非 split
      // 拓扑(dev/测试)。改 codex relay/refresh 代码部署须 `deploy-v5.sh --egress`。
      const codexTokenRefreshHandler: CodexTokenRefreshHandler = buildCodexTokenRefreshHandler({
        identityRepo,
        rateLimitRedis,
        healthTracker,
        // selfHostId 取自外层闭包 selfHostUuid;此分支已 guard 它非空。
        selfHostId: selfHostUuid,
        // v1.0.120:triggerCodexDisableFanout — codex token refresh 失败 disable
        // 后立刻 fanout rebind 其他活跃容器,避免老 token 仍被 codex CLI 沿用。
        triggerCodexDisableFanout,
      });
      // /v3/literature/search — DeepXiv 文献检索 proxy。复用 identityRepo
      // (同 anthropicProxy 的双因子身份),token 留在 master,容器只走 mTLS 内部 proxy。
      // GET-then-INCR Lua 配额 + per-container 60req/5min in-memory limiter。
      const literatureProxyHandler: LiteratureProxyHandler = makeLiteratureProxyHandler({
        identityRepo,
        redis,
      });
      // /v3/connectors/{list|call} — 应用连接器容器 RPC(oc-connect CLI 回源)。
      // 同款 verifyContainerIdentity 双因子;第三方凭据只在 master(connections 表
      // AES-256-GCM),容器只带自身身份 bearer。写操作过确认门(connector_write_ledger),
      // 出站过 outboundPolicy(自由域 DNS 钉死 / 固定域静态白名单)。
      const connectorsRpcHandler: ConnectorsRpcHandler = makeConnectorsRpcHandler({
        identityRepo,
        redis,
        pluginFacade,
      })
      // /v3/research/* — 科研 agent 能力 proxy(oc-lit 多源检索 + oc-cite 引用门禁)。
      // 同款 verifyContainerIdentity 双因子;平台 secret(S2/Unpaywall 等)留 master;
      // enabled 由 research_config 控制(off → 503)。免费源(OpenAlex/Crossref/arXiv)无 key。
      const researchProxyHandler: ResearchProxyHandler = makeResearchProxyHandler({
        identityRepo,
        redis,
      });
      // /v3/ocr/* — container-authenticated async SCNet document parsing.
      // Provider credentials and durable tenant ownership stay on master.
      const ocrProxyHandler: OcrProxyHandler = makeOcrProxyHandler({
        identityRepo,
        store: new PgOcrJobStore(getPool()),
      });
      // /internal/v3/platform-prompt-slots — 容器 → master 拉取平台级 prompt slot
      // (SKILLS_LITERATURE / MODEL_HINT)。镜像 build 排除 packages/commercial,所以
      // 容器进程内的 gateway 看不到 setLiteratureSkillProvider / setModelHintProvider
      // 注册的 hook;这条 endpoint 把 master 持有的 slot 内容 GET 给容器,在容器
      // buildPromptContext 时合并进 extra-prompt.md。详见
      // packages/commercial/src/http/internalPlatformPromptSlots.ts 头注。
      const platformPromptSlotsHandler: PlatformPromptSlotsHandler =
        makePlatformPromptSlotsHandler({
          identityRepo,
          pricingCache: pricing,
          // MODEL_HINT 的 alias→canonical 单一权威 = catalog(model_aliases);
          // pricingCache 只留 extra_system_prompt 文案。未装配(shadow 期 catalog
          // 拉不起来)→ handler 内部退 legacy 归一。
          catalog: modelCatalogForProxy,
        });
      // /internal/v3/minimax — 容器内 safe mmx wrapper → master 代持 MiniMax
      // Token Plan key 调用多模态 API 并记账。Token Plan key 只在 master env,
      // 不注入容器；鉴权同 anthropicProxy / platform slots 双因子。
      const minimaxMediaHandler: MiniMaxMediaHandler = makeMiniMaxMediaHandler({
        identityRepo,
        pgPool: getPool(),
        tokenPlanKey: cfg.MINIMAX_TOKEN_PLAN_KEY,
      });
      const mediaGenerationInternalHandler: MediaGenerationInternalHandler =
        makeMediaGenerationInternalHandler({ identityRepo, service: mediaGenerationService });
      // /internal/v3/minimax-search — 容器内 CCB 内置 WebSearch(MiniMaxSearchAdapter)回源 master。
      // key(MINIMAX_TOKEN_PLAN_KEY)只在 master,不注入容器;同款 verifyContainerIdentity 双因子。
      // MiniMax coding_plan/search 中文深度强,替代脆弱的 Bing HTML 刮页(Bing Search API 已退役)。
      const minimaxWebSearchHandler: MiniMaxWebSearchHandler = makeMiniMaxWebSearchHandler({
        identityRepo,
        tokenPlanKey: cfg.MINIMAX_TOKEN_PLAN_KEY,
      });
      // /internal/v3/codex-relay — 平台管控的 codex api_relay 流式转发。
      // egress split(M1b 架构决策):同一 handler 同时在 egress 进程本地挂载,
      // 生产在飞 codex 流走 egress 不经 master;master 挂载留作非 split 拓扑兜底。
      const codexRelayHandler: CodexRelayHandler = buildCodexRelayHandler({
        identityRepo,
        preCheckRedis,
        pgPool: getPool(),
        onImageCharge: (uid, charge) => {
          bridgeBroadcastRef.current(uid, {
            type: 'outbound.cost_charged',
            costCredits: charge.costCredits,
            balanceAfter: charge.balanceAfter,
          })
        },
      });
      const grokRelayHandler: GrokRelayHandler = makeGrokRelayHandler({
        identityRepo,
        renewSlot: (accountId, slotId) => {
          if (!scheduler.renewCodexSlot(accountId, slotId)) {
            // resolveGrokRouteContext already proved the durable row active.
            // Rebuild a local mirror forgotten by a restart/orphan reaper.
            scheduler.restoreCodexSlot(accountId, slotId);
          }
          return true;
        },
      });
      // /internal/v3/skill-embed — 容器内 mcp-memory 语义 skill_search 回源 master。
      // master 持 SKILL_EMBEDDING_API_KEY/DASHSCOPE_API_KEY(只在 master env,不注入容器),
      // 同款 verifyContainerIdentity 双因子鉴权;向量跨租户 PG 缓存,fail-closed 回落关键词。
      const skillEmbedHandler: SkillEmbedHandler = makeSkillEmbedHandler({
        identityRepo,
        cache: makePgSkillEmbedCache(),
        recordSearch: makePgSkillSearchLogger(),
      });
      // Core memory stays first-party: current safe chunks are ranked by the
      // q8 model bundled in this master release, with no vector persistence.
      const coreMemoryRankHandler: CoreMemoryRankHandler = makeCoreMemoryRankHandler({
        identityRepo,
      });
      // /internal/v3/marketplace/sync — 容器内 mcp-memory 拉取本用户已安装(未撤回)
      // 的市场 skill artifact 做 hub 对账(pull 模型,同款 verifyContainerIdentity)。
      const marketplaceSyncHandler: MarketplaceSyncHandler = makeMarketplaceSyncHandler({
        identityRepo,
      });
      // /internal/v3/turn-waive — 滚动升级/审计修复的兼容入口。master 只按
      // (user, turnKey) 精确冲正，并在同一事务写一封定向站内信。主路径
      // 由 lossless turn tape 携 waiveReason，不再使用会话时间窗口。
      const turnWaiveHandler: TurnWaiveHandler = makeTurnWaiveHandler({
        identityRepo,
        pgPool: getPool(),
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
      });
      const turnLeaseRenewHandler: TurnLeaseRenewHandler = makeTurnLeaseRenewHandler({
        identityRepo,
        pgPool: getPool(),
        getSigner: () => modelAuthoritySigner,
      });
      // durable turn dispatch(RFC §2.4 / §3):容器 boot recovery 查 tape 三态。同容器身份双因子。
      const turnTapeStateHandler: ServerAuthoredHandler = makeTurnTapeStateHandler({
        identityRepo,
        storage: dispatchAdmissionBackend,
      });
      // V5 queue P1 compatibility layer:strict opt-in. Flag off means no store
      // instance and no route registration, so legacy internal dispatch remains exact.
      const promptQueueHandler: PromptQueueHandler | null = isPromptQueueV1Enabled()
        ? makePromptQueueHandler({
            identityRepo,
            store: new PgPromptQueueStore(getPool()),
          })
        : null;
      // /internal/v3/marketplace/agent/* — 容器内 AI(market skill / oc-market CLI)
      // 代用户做市场操作(search/install/uninstall/publish),同款 verifyContainerIdentity
      // 限本用户;install 仅已审内容、publish 仅入 pending(管理员审核前不上线)。
      const marketplaceAgentHandler: MarketplaceAgentHandler = makeMarketplaceAgentHandler({
        identityRepo,
        listPublicModels: () => pricing.listPublic(),
      });
      // /internal/v3/agent-audit/tool-failure — 容器 gateway 自动上报失败工具调用。
      // user_id 由 verifyContainerIdentity 推导,不信任容器传入;写入 agent_audit 供后台优化。
      // 显式开关 OC_TOOL_FAILURE_AUDIT=1(与容器侧 reporter 同名 env,supervisor 只在
      // master 设了才透传进容器):未开启 → 不注册路由,path fall through 到
      // internalProxyHandler 返 404,容器侧按 fatal 直接 drop —— 与"未部署"等价。
      // v3 env 无此键 = 默认关,代码合回 v3 也不会静默对现网开启明文遥测。
      const toolFailureAuditHandler: ToolFailureAuditHandler | null = isToolFailureAuditEnabled()
        ? makeToolFailureAuditHandler({
            identityRepo,
            queryRunner: getPool(),
          })
        : null;
      const toolCallRollupHandler: ToolCallRollupHandler | null = isToolFailureAuditEnabled()
        ? makeToolCallRollupHandler({
            identityRepo,
            queryRunner: getPool(),
          })
        : null;
      // /internal/v3/marketplace/skill-usage — 容器 gateway skillUsageReporter 批量上报
      // 「hub 技能被使用」的低敏信号(slug/agent/trace,不记内容)。user_id 由
      // verifyContainerIdentity 推导,不信容器传入;写入 marketplace_skill_usage_events 供
      // 目录聚合(usage30d/users30d + 评分归因)。与 tool-failure 相反 = **默认开**
      // (OC_MARKET_SKILL_USAGE 显式 '0' 才关):关闭 → 不注册路由,path fall through 到
      // internalProxyHandler 返 404,容器侧按 fatal drop —— 与"未部署"等价。
      const skillUsageHandler: SkillUsageHandler | null = isSkillUsageEnabled()
        ? makeSkillUsageHandler({
            identityRepo,
            queryRunner: getPool(),
          })
        : null;
      // /internal/v3/skill-shadow — 四路 cost-free 检索旁路 + 同 turn skill_view 金标。
      // 严格 opt-in:env 缺省时不注册路由，与容器侧 listener 的门控同源。
      const skillShadowHandler: SkillShadowHandler | null = isSkillShadowEnabled()
        ? makeSkillShadowHandler({
            identityRepo,
            queryRunner: getPool(),
          })
        : null;
      // /internal/v3/marketplace/skill-feedback — 容器 gateway 起技能训练前拉「该用户对该技能
      // 差评过的真实场景引用」(只回 sessionKey/traceId/at,内容主权不出容器)。user_id 由
      // verifyContainerIdentity 推导。**无条件注册**:纯只读端点,无数据时返 {refs:[],total:0};
      // 即便 skill-usage 上报关闭(无事件写入)本端点也只是恒返空,gateway 侧 fail-open 照常训练。
      const skillFeedbackHandler: SkillFeedbackHandler = makeSkillFeedbackHandler({
        identityRepo,
        queryRunner: getPool(),
      });
      const autoDreamPolicyHandler: AutoDreamPolicyHandler = makeAutoDreamPolicyHandler({
        identityRepo,
      });
      const autoDreamOptimizerHandler = makeAutoDreamOptimizerHandler({
        identityRepo,
        runtimeRef: autoDreamOptimizerRuntimeRef,
      });
      // 平台 preset seed 会写双 slot 共享的 marketplace current 指针，必须跟随唯一
      // leadership，而非 candidate process startup。初次 acquire / finalize 接管 / abort
      // 后旧 slot re-acquire 都 await 同一幂等逻辑；单个 seed 仍沿用原 fail-soft 语义。
      if (runtimeChannel === "v5") {
        seedPlatformAgentsForLeadership = async () => {
          // 平台官方**科研** agent：仅 research_config 开启时 seed。
          try {
            const rc = await getResearchConfigPublic();
            if (rc.enabled) {
              const seeded = await seedPlatformResearchAgents({
                listPublicModels: () => pricing.listPublic(),
              });
              console.log(
                "[commercial] platform research agents seed:",
                JSON.stringify(seeded),
              );
            }
          } catch (err) {
            console.error("[commercial] seedPlatformResearchAgents failed:", err);
          }
          // 平台官方**通用** agent(办公助手 + 编程助手)：不依赖 research_config，无条件 seed。
          try {
            const seeded = await seedPlatformGeneralAgents({
              listPublicModels: () => pricing.listPublic(),
            });
            console.log(
              "[commercial] platform general agents seed:",
              JSON.stringify(seeded),
            );
          } catch (err) {
            console.error("[commercial] seedPlatformGeneralAgents failed:", err);
          }
        };
      }
      // 声明式**默认连接器**(notion/feishu/github)的幂等 seed —— 走完整 securityApprove 审计
      // 路径落 security_approved,catalog 才有可绑连接器、用户/agent 才发现得到。无此调用则生产
      // 目录为空(整套端到端不成立)。fire-and-forget,失败只 log 不阻断启动;幂等,重启可反复跑。
      void (async () => {
        try {
          const seeded = await seedDefaultConnectors(getPool());
          console.log("[commercial] default connectors seed:", JSON.stringify(seeded));
        } catch (err) {
          console.error("[commercial] seedDefaultConnectors failed:", err);
        }
      })();
      // egress split:cost 回执接收端(egress finalize 后的 SQLite 持久化 + WS 广播
      // 回投)。仅 split 模式挂载;秘钥头校验在 handler 内(loopback + egress 剥头 +
      // 秘钥三层)。
      const costEventHandler: CostEventHandler = makeCostEventHandler({
        secret: cfg.OC_EGRESS_SECRET,
        appendCostCredits: appendCostCreditsForUser,
        broadcastToUser: async (uid, payload) => {
          if (dualMasterEnabled) {
            await slotRelayClient.broadcastToUsers([uid.toString()], payload);
            return;
          }
          bridgeBroadcastRef.current(uid, payload);
        },
      });
      // /internal/v3/cron-index — 容器 gateway 上报「派生唤醒索引」(nextFireAt/enabledCount)。
      // uid 由 verifyContainerIdentity 推导;upsert cron_wake_index(runtime_channel=当前)。
      // 见 http/internalCronIndex.ts + agent-sandbox/cronWake.ts。runner 用 getPool()(结构上
      // 满足 CronWakeRunner 宽松契约,同 toolFailureAudit 传 getPool() 的取舍)。
      const cronIndexHandler: CronIndexHandler = makeCronIndexHandler({
        identityRepo,
        runner: getPool() as unknown as CronWakeRunner,
      });
      // /internal/v3/inbox-post — 容器 onDeliver「离线送达兜底写站内信」。uid 由容器身份推导,
      // audience 硬编码 'user' 只给自己写;created_by = MIN active admin(同 onboarding 语义,
      // 每次现解析,不缓存)。无 admin → 抛错 → handler 500。见 http/internalInboxPost.ts。
      const postInboxToUser = async (
        uid: number,
        msg: { title: string; bodyMd: string; level: "info" | "warning"; deliveryKey?: string },
      ) => {
        const adminRow = await getPool().query<{ id: string }>(
          `SELECT id::text AS id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1`,
        );
        const senderId = adminRow.rows[0]?.id;
        if (!senderId) throw new Error("inbox-post: no active admin sender");
        if (msg.deliveryKey) {
          await createCronDeliveryInboxMessage({
            userId: uid,
            title: msg.title,
            bodyMd: msg.bodyMd,
            level: msg.level,
            createdBy: senderId,
            deliveryKey: msg.deliveryKey,
          });
          return;
        }
        await createInboxMessage(senderId, {
          audience: "user",
          user_id: uid,
          title: msg.title,
          body_md: msg.bodyMd,
          level: msg.level,
        });
      };
      const inboxPostHandler: InboxPostHandler = makeInboxPostHandler({
        identityRepo,
        postMessage: postInboxToUser,
      });
      // 熔断告警:允许 warning,仍走同一 createInboxMessage / deliveryKey 幂等。
      const inboxAlertHandler: InboxPostHandler = makeInboxPostHandler({
        identityRepo,
        postMessage: postInboxToUser,
        allowWarning: true,
      });
      // /internal/v3/model-catalog{,-epoch} —— 容器 catalog client 的 per-uid 投影下发
      // (模型权威批次 §3/§6)。服务的是**本地路径**(cron/synthetic/delegate)判定;浏览器
      // turn 的判定随 inbound 的签名 descriptor 下来,不经这条路。
      //
      // catalog 未装配(影子期 + 0143 未 apply)→ **不注册**:path fall through 到
      // internalProxyHandler 返 404,容器侧 catalog client 把 404 当"拿不到权威快照" →
      // 本地路径拒新 turn(fail-closed,与"未部署"等价)。
      //
      // **这两条 path 不进 browser→container 代理 allowlist**:那份 allowlist(gateway
      // bridgeApiAllowlist + commercial containerApiProxy)只收 /api/*,结构上不可能命中
      // /internal/v3/*;__tests__/internalModelCatalog.test.ts 有显式断言把它钉死。
      const modelCatalogHandler: ModelCatalogHandler | null = modelCatalogForProxy
        ? makeModelCatalogHandler({
            identityRepo,
            catalog: modelCatalogForProxy,
            loadUserModelAuthz,
            // Team fallback selection must see newly opened/cleared quota circuits
            // immediately; the endpoint itself is already a narrow local-turn call.
            loadRoutingAvailability: () =>
              getProviderRoutingAvailability(Date.now(), undefined, undefined, true),
          })
        : null;
      // seed 完整性(§5 / R2-M8):平台预设 agent 引用的模型必须在 catalog active,否则用户
      // 点开预设助手第一句话就被 gate 拒。**全局**断言(per-uid 下发仍严格过滤、不强塞)。
      // 影子期只告警(判定还没切过去,不该因此拒启);enforce 期 → 抛。
      if (modelCatalogForProxy) {
        try {
          assertSeedModelsActive(modelCatalogForProxy.current());
        } catch (err) {
          if (modelAuthorityEnforce) throw err;
          console.error("[commercial] seed model catalog check failed (shadow):", err);
        }
      }
      dispatchInternal = (req, res, ctx) => {
        const path = (req.url ?? "/").split("?")[0];
        if (egressSplitEnabled && path === COST_EVENT_PATH) {
          return costEventHandler(req, res);
        }
        if (
          modelCatalogHandler &&
          (path === MODEL_CATALOG_PATH || path === MODEL_CATALOG_EPOCH_PATH)
        ) {
          return modelCatalogHandler(req, res, ctx);
        }
        if (path === SERVER_AUTHORED_PATH) {
          return serverAuthoredHandler(req, res, ctx);
        }
        if (path === TURN_TAPE_STATE_PATH) {
          return turnTapeStateHandler(req, res, ctx);
        }
        if (path === LITERATURE_SEARCH_PATH) {
          return literatureProxyHandler(req, res, ctx);
        }
        if (
          path.startsWith(CONNECTORS_RPC_PREFIX) ||
          path.startsWith(PLUGINS_RPC_PREFIX)
        ) {
          return connectorsRpcHandler(req, res, ctx);
        }
        if (path.startsWith(RESEARCH_PREFIX)) {
          return researchProxyHandler(req, res, ctx);
        }
        if (path.startsWith(OCR_PREFIX)) {
          return ocrProxyHandler(req, res, ctx);
        }
        if (path === PLATFORM_PROMPT_SLOTS_PATH) {
          return platformPromptSlotsHandler(req, res, ctx);
        }
        if (path === MINIMAX_MEDIA_PATH) {
          return minimaxMediaHandler(req, res, ctx);
        }
        if (
          path === MEDIA_GENERATION_INTERNAL_PREFIX ||
          path.startsWith(`${MEDIA_GENERATION_INTERNAL_PREFIX}/`)
        ) {
          return mediaGenerationInternalHandler(req, res, ctx);
        }
        if (path === MINIMAX_WEB_SEARCH_PATH) {
          return minimaxWebSearchHandler(req, res, ctx);
        }
        if (path === CODEX_TOKEN_REFRESH_PATH) {
          return codexTokenRefreshHandler(req, res, ctx);
        }
        if (path === CODEX_RELAY_PREFIX || path.startsWith(`${CODEX_RELAY_PREFIX}/`)) {
          return codexRelayHandler(req, res, ctx);
        }
        if (path === GROK_RELAY_PREFIX || path.startsWith(`${GROK_RELAY_PREFIX}/`)) {
          return grokRelayHandler(req, res, ctx);
        }
        if (path === SKILL_EMBED_PREFIX) {
          return skillEmbedHandler(req, res, ctx);
        }
        if (path === CORE_MEMORY_RANK_PATH) {
          return coreMemoryRankHandler(req, res, ctx);
        }
        if (path === MARKETPLACE_SYNC_PATH) {
          return marketplaceSyncHandler(req, res, ctx);
        }
        if (path === TURN_WAIVE_PATH) {
          return turnWaiveHandler(req, res, ctx);
        }
        if (path === TURN_LEASE_RENEW_PATH) {
          return turnLeaseRenewHandler(req, res, ctx);
        }
        if (
          promptQueueHandler &&
          (path === PROMPT_QUEUE_MUTATION_PATH || path === PROMPT_QUEUE_SNAPSHOT_PATH ||
            path === PROMPT_QUEUE_DETAIL_PATH || path === PROMPT_QUEUE_CLAIM_PATH)
        ) {
          return promptQueueHandler(req, res, ctx);
        }
        if (toolFailureAuditHandler && path === TOOL_FAILURE_AUDIT_PATH) {
          return toolFailureAuditHandler(req, res, ctx);
        }
        if (toolCallRollupHandler && path === TOOL_CALL_ROLLUP_PATH) {
          return toolCallRollupHandler(req, res, ctx);
        }
        if (skillUsageHandler && path === SKILL_USAGE_PATH) {
          return skillUsageHandler(req, res, ctx);
        }
        if (skillShadowHandler && path === SKILL_SHADOW_PATH) {
          return skillShadowHandler(req, res, ctx);
        }
        if (path === SKILL_FEEDBACK_PATH) {
          return skillFeedbackHandler(req, res, ctx);
        }
        if (path === AUTO_DREAM_POLICY_PATH) {
          return autoDreamPolicyHandler(req, res, ctx);
        }
        if (isAutoDreamOptimizerInternalPath(path)) {
          return autoDreamOptimizerHandler(req, res, ctx, path);
        }
        if (path === CRON_INDEX_PATH) {
          return cronIndexHandler(req, res, ctx);
        }
        if (path === INBOX_POST_PATH) {
          return inboxPostHandler(req, res, ctx);
        }
        if (path === INBOX_ALERT_PATH) {
          return inboxAlertHandler(req, res, ctx);
        }
        if (path.startsWith(MARKETPLACE_AGENT_PREFIX)) {
          return marketplaceAgentHandler(req, res, ctx);
        }
        if (path === WECHAT_OUTBOUND_PATH) {
          // P1.7 slice 7c — wechat broker outbound 接收点
          // broker 自带 brokerEnabled() 短路 403,无需在此重判 cfg.WECHAT_BROKER_ENABLED;
          // 未装配(ref.current=null)时显式 404,避免 caller container 把缺失误读为 503/超时
          // (回 retry,污染 retryQueue)— 404 在 v3WechatOutbound 端被分类为 fatal,直接 drop。
          const broker = wechatBrokerRef.current;
          if (!broker) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
              error: { code: "WECHAT_BROKER_NOT_ASSEMBLED", message: "wechat broker not assembled" },
            }));
            return Promise.resolve();
          }
          return broker.outboundHandler(req, res, ctx);
        }
        if (path === WECHAT_PROACTIVE_PATH) {
          // 主动微信投递(cron/提醒)。未装配 → 404(同 wechat-outbound:容器侧分类为 fatal 直接 drop,
          // 不污染 retryQueue)。装配条件与 broker 一致,故复用 broker null 判定即可。
          const proactive = wechatProactiveRef.current;
          if (!proactive) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
              error: { code: "WECHAT_BROKER_NOT_ASSEMBLED", message: "wechat broker not assembled" },
            }));
            return Promise.resolve();
          }
          return proactive(req, res, ctx);
        }
        if (path === QQ_OUTBOUND_PATH) {
          const receiver = qqOutboundRef.current;
          if (!receiver) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
              error: { code: "QQ_BOT_NOT_ASSEMBLED", message: "QQ Bot not assembled" },
            }));
            return Promise.resolve();
          }
          return receiver(req, res, ctx);
        }
        if (path === QQ_PROACTIVE_PATH) {
          const receiver = qqProactiveRef.current;
          if (!receiver) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
              error: { code: "QQ_BOT_NOT_ASSEMBLED", message: "QQ Bot not assembled" },
            }));
            return Promise.resolve();
          }
          return receiver(req, res, ctx);
        }
        return internalProxyHandler!(req, res, ctx);
      };
      // ── P3 控制口只读端点(RFC D3;私有口 + VIP 共用此 handler)────────────────────
      // 这两个是 Agent A/C 之间掉的球,现在补上:deploy lane 的 finalize 四门槛 / candidate 自检 /
      // abort 健康核验都靠它们。在 dispatchInternal(anthropic proxy 路由,不认这些路径)之前拦截。
      const currentLeadership = (): LeadershipStatus =>
        leaderLease
          ? leaderLease.status()
          : { state: "ineligible", slot: ocSlot, generation: null, leasePid: null };
      // 私有口 healthz:leadership + vip(owner|released)+ slot —— deploy 脚本据此判断 standby/leader/VIP 归属。
      const respondControlHealthz = (res: ServerResponse): void => {
        const vip = controlListener?.status().vipBound ? "owner" : "released";
        const body = {
          ok: true, // 本控制口在响应即证明进程存活;深度依赖探活走 /internal/v5/control-probe。
          channel: runtimeChannel,
          slot: ocSlot,
          leadership: currentLeadership(),
          vip,
        };
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
      };
      // control-probe:egress secret 校验后自检 dispatcher 路由表 + PG SELECT 1 + "本实例持有 VIP"。
      const respondControlProbe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const reply = (code: number, obj: Record<string, unknown>): void => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(obj));
        };
        const secret = cfg.OC_EGRESS_SECRET;
        if (!secret) return reply(503, { ok: false, error: "EGRESS_SECRET_UNSET" });
        const presented = req.headers["x-oc-egress-secret"];
        const okSecret =
          typeof presented === "string" &&
          (() => {
            const pBuf = Buffer.from(presented);
            const eBuf = Buffer.from(secret);
            return pBuf.length === eBuf.length && pBuf.length > 0 && timingSafeEqual(pBuf, eBuf);
          })();
        if (!okSecret) return reply(401, { ok: false, error: "UNAUTHORIZED" });
        // ① dispatcher 路由表已装配 ② PG 连通 ③ 本实例持有 VIP
        const routeTable = typeof dispatchInternal === "function" && typeof internalProxyHandler === "function";
        let pgOk = false;
        try {
          await getPool().query("SELECT 1");
          pgOk = true;
        } catch {
          pgOk = false;
        }
        const vipOwner = controlListener?.status().vipBound === true;
        return reply(200, {
          ok: routeTable && pgOk && vipOwner,
          routeTable,
          pg: pgOk ? "ok" : "error",
          vipOwner,
          slot: ocSlot,
          leadership: currentLeadership(),
        });
      };
      // 请求 dispatcher 闭包(VIP+私有双 listener 与单 listener 共用)。
      const internalRequestHandler = (req: IncomingMessage, res: ServerResponse): void => {
        // P3 控制端点前置拦截(GET /healthz、GET /internal/v5/control-probe)。
        const urlPath = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && urlPath === "/healthz") {
          try { respondControlHealthz(res); } catch { /* socket gone */ }
          return;
        }
        if (req.method === "GET" && urlPath === "/internal/v5/control-probe") {
          void respondControlProbe(req, res).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[commercial] control-probe handler threw:", err);
            if (!res.headersSent) {
              try {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: false, error: "PROBE_INTERNAL" }));
              } catch { /* socket gone */ }
            }
          });
          return;
        }
        // 双槽定向通知 relay 只允许走本 slot 私有控制口；VIP/普通 proxy 端口不暴露该面。
        if (
          dualMasterEnabled &&
          req.socket.localPort === privatePortForSlot(ocSlot) &&
          handleSlotRelayRequest(req, res, {
            secret: cfg.OC_EGRESS_SECRET ?? "",
            local: {
              onlineUserSubset: (uids) => slotRelayLocalRef.current.onlineUserSubset(uids),
              broadcastToUsers: (uids, payload) => slotRelayLocalRef.current.broadcastToUsers(uids, payload),
            },
            logger: rootLogger.child({ subsys: "commercial", module: "slotRelayServer" }),
          })
        ) return;
        // self-host 路径:container → plain HTTP 18791 → 这里。peerIp 就是 container 的 bound_ip,
        // hostUuid 固定 = selfHostUuid(本机容器不需要也不可能带 mTLS cert)。
        // split 模式下容器流量经 egress 转发到达,socket peer 恒为 loopback;
        // 真实容器 ip 由 egress 注入 x-v5-egress-peer-ip(它同时会剥掉入站同名头,容器伪造不进来)。
        const fwdPeer = egressSplitEnabled ? req.headers["x-v5-egress-peer-ip"] : undefined;
        const peerIp =
          (typeof fwdPeer === "string" && fwdPeer.trim()) || req.socket.remoteAddress || "";
        Promise.resolve(
          dispatchInternal!(req, res, { hostUuid: selfHostUuid!, boundIp: peerIp }),
        ).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[commercial] internal listener handler threw:", err);
          if (!res.headersSent) {
            try {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal listener error" } }));
            } catch { /* socket gone */ }
          } else {
            try { res.end(); } catch { /* */ }
          }
        });
      };
      if (dualMasterEnabled && egressSplitEnabled && deployDesiredWatch) {
        // ── P3 双 master 控制口:VIP + 私有双 listener(RFC D3)────────────────────
        // VIP=proxyBind:proxyPort(egress 唯一目标,零改动),仅 desired_control_slot==本 slot bind;
        // 私有口=127.0.0.1:privatePortForSlot(slot)(本 slot 常驻自检口)。基建版 A slot+desired=A →
        // 启动即 bind proxyPort(与今日单 listener 同)+ 新增 18896。EADDRINUSE 交接窗重试,余错 fail-loud。
        controlListener = createControlListener({
          slot: ocSlot,
          desiredWatch: deployDesiredWatch,
          handler: internalRequestHandler,
          vip: { host: proxyBind, port: proxyPort },
          logger: {
            info: (m, meta) => rootLogger.info(m, { subsys: "controlListener", meta }),
            warn: (m, meta) => rootLogger.warn(m, { subsys: "controlListener", meta }),
            error: (m, meta) => rootLogger.error(m, { subsys: "controlListener", meta }),
          },
        });
        // 首绑前 prime desired 缓存:确保 controlListener 的 firstAttempt VIP 判定看到真实
        // desired_control_slot(而非 watch 尚未首轮轮询的 null)。首读失败(PG 抖)不阻塞——
        // current() 保持 null → VIP 首绑跳过,由 watch onChange 后补 bind。
        try { await deployDesiredWatch.refreshNow(); } catch { /* 首读失败,后补 */ }
        await controlListener.start();
        internalProxyAddress = { host: proxyBind, port: proxyPort };
        // eslint-disable-next-line no-console
        console.log(`[commercial] P3 控制口 VIP+私有双 listener 就绪 (slot=${ocSlot}, vip=${proxyBind}:${proxyPort})`);
      } else {
        internalProxyServer = createHttpServer(internalRequestHandler);
        // 同步监听 + 转 promise:监听失败立即 throw,主流程 catch 后降级
        await new Promise<void>((resolve, reject) => {
          internalProxyServer!.once("error", reject);
          internalProxyServer!.listen(proxyPort, proxyBind, () => {
            internalProxyServer!.removeListener("error", reject);
            resolve();
          });
        });
        internalProxyAddress = { host: proxyBind, port: proxyPort };
        // eslint-disable-next-line no-console
        console.log(
          `[commercial] internal anthropic proxy listening on ${proxyBind}:${proxyPort}`,
        );
      }
    } catch (err) {
      // P3:控制口(VIP+私有)bind 失败 = 部署故障,fail-loud 拒起(私有口是本 slot 自检基础设施,
      // egress 靠 VIP 送 cost 事件——静默 disable 会让 v5 master 带病运行)。单 listener 路径保持
      // 旧"降级 disable"语义(容器直连非 split,失败退化为无内部代理,/healthz 反映)。
      if (dualMasterEnabled && egressSplitEnabled) {
        try { await controlListener?.close(); } catch { /* */ }
        controlListener = undefined;
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error("[commercial] internal proxy listener failed; disabling:", err);
      try { internalProxyServer?.close(); } catch { /* */ }
      internalProxyServer = undefined;
      internalProxyHandler = undefined;
      internalProxyAddress = undefined;
      dispatchInternal = undefined;
    }
  } else if (!options.skipInternalProxy) {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] internal anthropic proxy disabled; missing INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT",
    );
  }

  // V3 CC 外接 plan Phase 3(2026-05-18)— public-facing
  // `POST /api/anthropic/v1/messages` 的第二个 AnthropicProxyHandler 实例。
  //
  // 与 internalProxyHandler 平行装配,**不**依赖 INTERNAL_PROXY_BIND/PORT/selfHostUuid
  // —— external 不监听端口、不需要 selfHostUuid,直接挂在公网 commercialHandler 的
  // pre-route adapter 上(见 http/router.ts 的 `CC 外接 endpoint` 块)。
  //
  // 两实例的唯一差异是 IdentityStrategy:
  //   - internal:`makeContainerIdentityStrategy`(容器双因子 + recordHostRequest)
  //   - external:`makeApiKeyIdentityStrategy`(Bearer `oc-cc.*` token,无 recordHostRequest)
  // 其它依赖(pricing / preCheckRedis / scheduler / refreshDeps / 计费 / 广播)完全
  // 共享 —— 计费 / 账号池 / 上游路由语义两路必须一致,唯一分歧是身份维度。
  //
  // 装配失败语义(Codex Phase 3 plan-review MINOR 1):catch + undefined,router
  // 见 undefined 走 503 EXTERNAL_PROXY_UNAVAILABLE 而非 404(部署故障不该伪装成
  // "用户 URL 写错")。
  let externalApiKeyProxy: AnthropicProxyHandler | undefined;
  if (!options.skipInternalProxy) {
    try {
      const apiKeyRepo = makePgApiKeyRepo(getPool());
      const apiKeyStrategy = makeApiKeyIdentityStrategy({
        repo: apiKeyRepo,
        pricing,
        loadUserModelAuthz,
        logger: rootLogger.child({ subsys: "apiKeyIdentity" }),
      });
      // Phase 5 platform envelope rewriter wiring(2026-05-21)。
      // secret 缺失 → throw → 外层 catch 将 externalApiKeyProxy 置 undefined,
      // 同 hupi/deepseek 已有的"缺配置 → 端点 503"模式一致(non-fatal,主进程继续)。
      // Loader 持有 PlatformContextReader 单例,master 进程生命期与之绑定,无须 close。
      if (!cfg.PLATFORM_HMAC_SECRET) {
        throw new Error(
          "PLATFORM_HMAC_SECRET required for external ApiKey proxy (Phase 5 envelope)",
        );
      }
      const platformContextLoader = makePlatformContextLoader({
        reader: makeDefaultVolumeContextReader(),
      });
      externalApiKeyProxy = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing,
        preCheckRedis,
        scheduler,
        identity: apiKeyStrategy,
        loadUserModelAuthz,
        rateLimitRedis: sharedRateLimitRedis,
        // 与 internal 同型:OAuth refresh 走 health + codex disable fanout。
        refreshDeps: { health: healthTracker, triggerCodexDisableFanout },
        // bridge broadcastToUser 同型 ref 闭包;externalApiKeyProxy 装配于
        // bridge 之前是正常顺序(请求期 bridge 必已就绪)。
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
        appendCostCredits: appendCostCreditsForUser, // c:<uid> 前缀对齐 session 存储命名空间
        // external API-key proxy **故意只注入 deepseek**(保持现有能力面,不拓宽 minimax/ark)。
        // 该 proxy 上 minimax/ark 模型请求维持 not_configured 503,与历史行为一致。
        staticProviderKeys: { deepseek: cfg.DEEPSEEK_API_KEY },
        platformContextLoader,
        platformServerSecret: cfg.PLATFORM_HMAC_SECRET,
        // v1.0.207 — external ApiKey proxy 与 internal proxy 共用 runtime flag getter,
        // 同一个 30s TTL cache(`admin/runtimeFlags.ts`)。
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      // eslint-disable-next-line no-console
      console.log(
        "[commercial] external api-key anthropic proxy assembled (POST /api/anthropic/v1/messages)",
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[commercial] external api-key proxy failed to assemble; endpoint will return 503:",
        err,
      );
      externalApiKeyProxy = undefined;
    }
  }

  // V3 D.1b: 18443 mTLS listener。remote-host node-agent 走 L7 反代过来,master 这边
  // 用 master leaf cert 作服务端 cert,并要求对端出示 host leaf cert(SPIFFE host/<uuid>)。
  // 通过 handleExternalMtls 做 cert + fingerprint + container-ip 头三级校验后,
  // 走到同一个 internalProxyHandler(和 self-host plain 18791 共用)。
  //
  // 启用条件:EXTERNAL_MTLS_ENABLED=1 + bind + port 都配齐 + internalProxyHandler 已就绪。
  // 关掉 / 配不齐 / 监听失败 → 单边降级,remote host 出不来但 self host 不受影响。
  if (
    internalProxyHandler &&
    dispatchInternal &&
    cfg.EXTERNAL_MTLS_ENABLED &&
    cfg.EXTERNAL_MTLS_BIND &&
    cfg.EXTERNAL_MTLS_PORT !== undefined
  ) {
    const mtlsBind = cfg.EXTERNAL_MTLS_BIND;
    const mtlsPort = cfg.EXTERNAL_MTLS_PORT;
    try {
      const caMat = await ensureCa();
      const masterLeaf = await ensureMasterLeaf();
      const caPem = await fs.promises.readFile(caMat.caCertPath, "utf8");
      const masterKey = await fs.promises.readFile(masterLeaf.keyPath, "utf8");
      // 2026-05-05: 用 dispatchInternal 而不是 internalProxyHandler,这样
      // remote-host 容器也能命中 /internal/v3/server-authored-message 路径,
      // 与 self-host 路径行为一致(同一 dispatcher 共享 path 分流逻辑)。
      const capturedHandler = dispatchInternal;
      externalMtlsServer = createHttpsServer(
        {
          key: masterKey,
          cert: masterLeaf.certPem,
          ca: caPem,
          requestCert: true,
          rejectUnauthorized: true,
          // master + node-agent 都我们自己控(Node 18+ / Go 1.22 均原生 TLS 1.3),
          // 没有历史客户端兼容性包袱,直接 hard-require 1.3。
          minVersion: "TLSv1.3",
        },
        (req, res) => {
          Promise.resolve(handleExternalMtls(req, res, capturedHandler)).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[commercial] external mTLS handler threw:", err);
            if (!res.headersSent) {
              try {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: { code: "INTERNAL", message: "mtls error" } }));
              } catch { /* socket gone */ }
            } else {
              try { res.end(); } catch { /* */ }
            }
          });
        },
      );
      await new Promise<void>((resolve, reject) => {
        externalMtlsServer!.once("error", reject);
        externalMtlsServer!.listen(mtlsPort, mtlsBind, () => {
          externalMtlsServer!.removeListener("error", reject);
          resolve();
        });
      });
      externalMtlsAddress = { host: mtlsBind, port: mtlsPort };
      // eslint-disable-next-line no-console
      console.log(
        `[commercial] external mTLS listening on ${mtlsBind}:${mtlsPort}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] external mTLS listener failed; disabling:", err);
      try { externalMtlsServer?.close(); } catch { /* */ }
      externalMtlsServer = undefined;
      externalMtlsAddress = undefined;
    }
  } else if (internalProxyHandler && !cfg.EXTERNAL_MTLS_ENABLED) {
    // eslint-disable-next-line no-console
    console.log("[commercial] external mTLS listener disabled (EXTERNAL_MTLS_ENABLED != 1)");
  }

  // T-12+ 真实 mailer:env 配 RESEND_API_KEY 后切到 Resend,否则保留 stub(dev/测试)。
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const mailFrom = process.env.MAIL_FROM?.trim() || "auth@claudeai.chat";
  const mailer = resendKey
    ? createResendMailer({ apiKey: resendKey, from: mailFrom })
    : stubMailer;
  if (resendKey) {
    console.log(`[commercial] mailer = resend (from=${mailFrom})`);
  } else {
    console.log("[commercial] mailer = stub (RESEND_API_KEY 未设置, 验证邮件只打日志)");
  }

  // v3 file proxy:HOST bridge root secret。加载/生成 `/var/lib/openclaude/.v3-bridge-secret`。
  // 任何失败(权限 / 磁盘 / 路径)→ fail-closed 只警告,让 supervisor 不注入 env,file
  // proxy 整体降级为 CONTAINER_OUTDATED 503,不会阻止 gateway 启动。
  let bridgeSecret: string | undefined;
  try {
    bridgeSecret = loadOrCreateBridgeSecret();
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 bridge secret loaded", { path: DEFAULT_BRIDGE_SECRET_PATH });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] v3 bridge secret load/create failed; file proxy will be DISABLED",
      { path: DEFAULT_BRIDGE_SECRET_PATH, error: (err as Error)?.message ?? String(err) },
    );
    bridgeSecret = undefined;
  }

  // v3 signed-URL media key —— HKDF(bridgeSecret, info="oc-media-sign-v1") 派生
  // 32-byte 子 key,与 bridgeSecret 同生命周期。bridgeSecret 缺失时 mediaSignKey 也
  // undefined,signed URL endpoints 自动 503 SIGN_DISABLED。
  //
  // **没有 cookie fallback**:前端拿到 503/null 后媒体保持占位(透明 1x1 / 空 src),
  // 不会偷偷退回 `<img src="/api/file?path=...">` —— 那条路径正是 iOS Safari 丢
  // cookie 的根因,绕回去等于把 bug 重新放出来。bridgeSecret 缺失通常意味整个
  // file proxy 都没装配(单租户 personal 版),本来也用不到 commercial 媒体渲染。
  let mediaSignKey: Buffer | undefined;
  let wechatLiveLinkKey: Buffer | undefined;
  if (bridgeSecret) {
    try {
      mediaSignKey = deriveMediaSignKey(bridgeSecret);
      // eslint-disable-next-line no-console
      console.log("[commercial] v3 media signing key derived");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] media sign key derivation failed; signed URL DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      mediaSignKey = undefined;
    }
    try {
      wechatLiveLinkKey = deriveWechatLiveLinkKey(bridgeSecret);
      // eslint-disable-next-line no-console
      console.log("[commercial] v3 wechat live link key derived");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] wechat live key derivation failed; live links DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      wechatLiveLinkKey = undefined;
    }
  }

  // 服务端缩略图磁盘缓存 —— 与 mediaSignKey 同生命周期(依赖 signed media 管线)。
  // 落 OPENCLAUDE_HOME/media-thumb-cache/,启动清零(init)。缺 mediaSignKey → 不装配,
  // `?w=` 被 handler 忽略回原图(优雅降级)。
  let thumbnailCache: ThumbnailDiskCache | undefined;
  if (mediaSignKey) {
    try {
      const home = process.env.OPENCLAUDE_HOME ?? path.join(homedir(), ".openclaude");
      const cache = new ThumbnailDiskCache(path.join(home, "media-thumb-cache"));
      await cache.init();
      thumbnailCache = cache;
      // eslint-disable-next-line no-console
      console.log("[commercial] media thumbnail cache ready (startup-cleared)");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] thumbnail cache init failed; thumbnails DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      thumbnailCache = undefined;
    }
  }

  // ── 模型执行权威(docs/V5_MODEL_AUTHORITY_PLAN.md §2/§7 步 4)────────────────
  //
  // flag `OC_MODEL_AUTHORITY=1` 才装配。装配 = 三件事同时生效(方案的原子开关):
  //   ① supervisor 往新容器注入公钥 keyring + OC_USER_ID，并在 provision-required=true
  //      时注入 OC_MODEL_AUTHORITY；回滚清退期显式设 provision-required=false，新容器仍拿
  //      公钥消费已签票据，但不再成为必须 attest 的强制容器；
  //   ② bridge 对每条连接要求容器 attest `model_authority_v1`(未 attest 前缓冲用户帧,
  //      超时/不支持 → 拒连接 + stale recycle);
  //   ③ bridge 对每条 inbound.message 签发并注入 `__oc_model_authority`,codex 分类
  //      改用 catalog descriptor.engine(与签发同源)。
  //
  // fail-closed 启动:catalog 首次快照拉不起来(0143 迁移未 apply / DB 不可达)→ **抛**,
  // 不允许「flag 开着但 catalog 空转」这种半开状态(那会让每条帧都被 fence 拒,等于全站
  // 静默不可用,还不如启动就响亮失败)。
  //
  // 关 flag → 全部旧行为(容器不 attest 也不会被拒;帧不带 envelope;判定回 baked)。
  const modelAuthorityFlag = process.env.OC_MODEL_AUTHORITY === "1";
  // 缺省为 true，保持既有原子开关语义。只允许 deploy-v5.sh 的回滚闭环短暂写 0：
  // master 继续签发/验 attest，同时停止制造新的 OC_MODEL_AUTHORITY=1 容器，等旧容器
  // 经 authenticated drain 全量退出后才真正关总 flag，消除回滚 census 的尾巴竞态。
  const modelAuthorityProvisionRequired =
    modelAuthorityFlag && process.env.OC_MODEL_AUTHORITY_PROVISION_REQUIRED !== "0";
  if (modelAuthorityFlag) {
    // catalog HTTP mutation 必须走独立低权 admin role；缺失/串用 app role 时拒绝启动。
    await assertModelCatalogAdminPoolConfigured();
    modelAuthoritySigner = AuthoritySigner.loadOrCreate();
    // 与 proxy/internal catalog 共用进程级单例，禁止 bridge 另起一份快照。
    modelCatalogCache = await getModelCatalogCache();
    // eslint-disable-next-line no-console
    console.log("[commercial] model authority ENABLED", {
      activeKeyId: modelAuthoritySigner.activeKeyId,
      keyIds: modelAuthoritySigner.keyIds.length,
      securityEpoch: modelCatalogCache.current().securityEpoch.toString(),
      executionRevision: modelCatalogCache.current().executionRevision.slice(0, 12),
    });
  }

  // V3 Phase 3 supervisor 装配 —— 必须在 createCommercialHandler 之前构造,
  // 因为 admin/containers HIGH#6 路径要在 deps.v3Supervisor 上 dispatch v3 行。
  // 见下方 idleSweep / volumeGc / orphanReconcile / makeV3EnsureRunning 都复用 v3Deps。
  let v3Deps: V3SupervisorDeps | undefined;
  if (cfg.OC_RUNTIME_IMAGE) {
    // 复用 agentRuntime 路径的 docker socket / 默认逻辑,避免 v2/v3 端再各开一个 docker client
    // (一个进程开多个 dockerode 也无副作用,但同一 socket 没必要)
    const v3Docker = cfg.AGENT_DOCKER_SOCKET
      ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
      : new Docker();

    // ── V5 runtime tuple 启动期解析(plan §1.5 prepare/startup 一次性全量校验)──
    // OC_PLATFORM_BUNDLE / OC_RUNTIME_RELEASE 配了就在此**一次性**跑昂贵的 resolvePlatformBundleMount
    // (逐文件 sha256)/ resolveRuntimeReleaseMount,把 bundleRev/bootHash/resolved 路径灌进 tuple;
    // provision 每次只做便宜的 assertCurrentMatches。解析失败**不阻断 gateway 启动**(与 baseline
    // 自检同范式)——只 console.error 留态;下一次 provision 由 supervisor 依 v5 fail-closed / OPTIONAL
    // 决定拒/降级(bundlePath 传下去但 bundleRev 空 → provision 侧判 "解析失败" 拒)。
    let runtimeTuple: V3RuntimeTuple | undefined;
    if (cfg.OC_RUNTIME_IMAGE_ID || cfg.OC_PLATFORM_BUNDLE || cfg.OC_RUNTIME_RELEASE) {
      const platformRoot = cfg.OC_PLATFORM_ROOT ?? DEFAULT_PLATFORM_ROOT;
      const releasesRoot = cfg.OC_RUNTIME_RELEASES_ROOT ?? DEFAULT_RUNTIME_RELEASES_ROOT;
      const t: V3RuntimeTuple = {
        imageId: cfg.OC_RUNTIME_IMAGE_ID,
        bundlePath: cfg.OC_PLATFORM_BUNDLE,
        releasePath: cfg.OC_RUNTIME_RELEASE,
        platformRoot,
        releasesRoot,
      };
      if (cfg.OC_PLATFORM_BUNDLE) {
        try {
          // B5 containment:传 platformRoot 让校验器显式断言 resolved 落在 <platformRoot>/bundles/ 下
          // (ancestorRoot 同值锁祖先链;platformRoot 另钉布局根,两者语义分离但生产同一目录)。
          const resolved = resolvePlatformBundleMount(cfg.OC_PLATFORM_BUNDLE, {
            ancestorRoot: platformRoot,
            platformRoot,
          });
          t.bundleResolvedPath = resolved.resolvedPath;
          t.bundleRev = resolved.bundleRev;
          t.bootHash = resolved.bootHash;
          // eslint-disable-next-line no-console
          console.log("[commercial] v5 platform bundle validated", {
            bundlePath: cfg.OC_PLATFORM_BUNDLE,
            bundleRev: resolved.bundleRev,
            bootHash: resolved.bootHash,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            "[commercial] v5 platform bundle validation FAILED — provision will fail-closed (or skip with OC_PLATFORM_BUNDLE_OPTIONAL=1)",
            { bundlePath: cfg.OC_PLATFORM_BUNDLE, error: (err as Error).message },
          );
        }
      }
      if (cfg.OC_RUNTIME_RELEASE) {
        try {
          t.releaseResolvedPath = resolveRuntimeReleaseMount(cfg.OC_RUNTIME_RELEASE, releasesRoot);
          // eslint-disable-next-line no-console
          console.log("[commercial] v5 runtime release validated", {
            releasePath: cfg.OC_RUNTIME_RELEASE,
            resolved: t.releaseResolvedPath,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            "[commercial] v5 runtime release validation FAILED — provision will fail-closed",
            { releasePath: cfg.OC_RUNTIME_RELEASE, error: (err as Error).message },
          );
        }
      }
      runtimeTuple = t;
    }

    v3Deps = {
      docker: v3Docker,
      pool: getPool(),
      image: cfg.OC_RUNTIME_IMAGE,
      // bridgeSecret 注入后,provisionV3Container 会写 OC_CONTAINER_ID / OC_BRIDGE_NONCE
      // 到容器 env;未注入则容器侧 /healthz 不广播 file-proxy-v1,代理自动 OUTDATED。
      bridgeSecret,
      // 模型执行权威:公钥 keyring + uid + 强制门注入新容器 env(方案 §7 步 4)。
      // flag 关 → undefined → 容器 env 完全同旧。
      ...(modelAuthoritySigner
        ? {
            modelAuthority: {
              // **函数**而非启动期快照:轮换步骤①(addKey)之后新 provision 的容器必须
              // 立刻拿到含新公钥的 ring —— 传字符串的话要等 master 重启才生效,步骤②
              // 的 census 永远收敛不到 100%,整条轮换卡死。signer 内部按文件 stat 热重载。
              keyringEnvAssignment: () => modelAuthoritySigner!.publicKeyringEnvAssignment(),
              required: modelAuthorityProvisionRequired,
              // 次级模型 master 单向下发(注入 OPENCLAUDE_SECONDARY_MODEL);与签发 authority 的
              // auxModels 同源,消除 master/runtime 版本 skew 的 WebFetch/WebSearch 403。
              auxModels: PLATFORM_AUX_MODEL_IDS,
            },
          }
        : {}),
      // V5 runtime tuple(启动期已解析);未配 → undefined → provision/ensureRunning 走旧路径。
      ...(runtimeTuple ? { runtimeTuple } : {}),
      // Default-no-op exact-prompt evaluation lane. The runtime adapter rejects
      // every real UID and any absent/invalid/expired root-owned active record.
      ...(getRuntimeChannel() === "v5"
        ? {
            syntheticEvalOverlay: createSyntheticEvalOverlayRuntime({
              expectedBaseCommit: readSyntheticEvalReleaseSourceCommit(
                runtimeTuple?.releaseResolvedPath ? process.cwd() : undefined,
              ),
            }),
          }
        : {}),
      // 多机路由 wiring:selfHostUuid 取到才同时注入 containerService + selfHostId,
      // 避免出现 "containerService 注入但 selfHostId undefined" 的半 wire 状态
      // (provisionV3Container 的 useRemote 判定依赖 selfHostId 非空)。
      ...(selfHostUuid
        ? {
            containerService: createContainerService(v3Docker),
            selfHostId: selfHostUuid,
            // v1.0.72 — 远端 codex auth 写/删 helper:统一在此一处做
            // getHostById → hostRowToTarget → put/delete → finally psk.fill(0)
            // 三处调用方(provisionV3Container / lazy migrate / stopAndRemove)
            // 都通过这两个回调,避免泄密 buffer 散落。
            //
            // 失败语义:put 抛 → caller fallback NULL bind;delete 抛 → caller
            // 应吞掉(best-effort,与本地 removeCodexContainerAuthDir 一致)。
            // 本闭包不做 catch —— 让 caller 决定。
            putRemoteCodexAuth: async (
              hostUuid: string,
              containerId: string,
              accessToken: string,
              lastRefreshIso: string,
            ) => {
              // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒。
              const target = await resolveServiceableHostTarget(hostUuid);
              try {
                await putRemoteCodexContainerAuth(
                  target,
                  containerId,
                  accessToken,
                  lastRefreshIso,
                );
              } finally {
                target.psk?.fill(0);
              }
            },
            deleteRemoteCodexAuth: async (
              hostUuid: string,
              containerId: string,
            ) => {
              // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒
              // (与 put/pull 对称;清 codex auth 也是 node-agent file 接触)。
              const target = await resolveServiceableHostTarget(hostUuid);
              try {
                await deleteRemoteCodexContainerAuth(target, containerId);
              } finally {
                target.psk?.fill(0);
              }
            },
          }
        : {}),
    };
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 supervisor wired", {
      image: cfg.OC_RUNTIME_IMAGE,
      multiHost: Boolean(selfHostUuid),
      selfHostId: selfHostUuid ?? null,
    });

    // CCB 基线自检(只读诊断,不自己阻断启动 —— 真正的 fail-closed 发生在
    // provisionV3Container 里抛 SupervisorError("CcbBaselineMissing"))。
    //
    // 这里的作用是给运维在 gateway 启动日志上立刻看见 baseline 是否就绪,
    // 避免"rsync 漏了目录,gateway 跑得好好的但下一个 provision 直接 500"。
    // MISSING 时日志态势明确,不用等用户踩坑才发现。
    {
      const baselineDir = process.env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR;
      const resolved = resolveCcbBaselineMounts(baselineDir);
      const optional = process.env.OC_V3_CCB_BASELINE_OPTIONAL?.trim().toLowerCase();
      const optionalFlagOn = optional === "1" || optional === "true" || optional === "yes";
      if (resolved) {
        // eslint-disable-next-line no-console
        console.log("[commercial] v3 ccb baseline ready", {
          baselineDir,
          claudeMd: resolved.claudeMdHostPath,
          skillsDir: resolved.skillsDirHostPath,
          optional: optionalFlagOn,
        });
      } else if (optionalFlagOn) {
        // dev/test 显式允许缺基线,不阻断
        // eslint-disable-next-line no-console
        console.warn(
          "[commercial] v3 ccb baseline missing (OPTIONAL=1) — new containers will spawn WITHOUT platform guardrails",
          { baselineDir },
        );
      } else {
        // 生产路径 —— 下一次 provisionV3Container 将抛 CcbBaselineMissing
        // eslint-disable-next-line no-console
        console.error(
          "[commercial] v3 ccb baseline MISSING — next provisionV3Container will FAIL (fail-closed). Fix baseline rsync or set OC_V3_CCB_BASELINE_OPTIONAL=1 for dev only.",
          { baselineDir },
        );
      }
    }

    // ── P3 MAJOR 4(compute-pool 三件套双 master 护栏 + 收口债)───────────────────────
    // preheatV3Image / initComputePool / imagePromote 都向共享 compute_hosts 写状态(desired/loaded
    // image、quarantine、backfill),属 v3 控制面;它们仍以 **静态 controlPlaneEnabled eager-start,
    // 未纳入 LeaderBundle**。双 master(v5)下两 slot 的 OC_CONTROL_PLANE_LEADER 都=1 → controlPlaneEnabled
    // 两 slot 都 true → 两 slot 都 eager 跑 = 双写 compute_hosts 竞态;且 imagePromote 以 shared 域 eager
    // 注册会违反下方"非 leader 不跑 shared"实时不变量。在纳入 bundle 前的硬护栏:v5 下 candidate/incumbent
    // 任一 slot 都必须显式关掉这些开关,否则 fail-loud 拒起。v3 已下线、v5 镜像本机常驻,compute-pool
    // 对 v5 本就无用(preheat 是 noop)。【收口债】后续应将 compute-pool 纳入 LeaderBundle 或从 v5 剥离。
    if (dualMasterEnabled && controlPlaneEnabled) {
      const preheatOn = process.env.OC_PREHEAT_DISABLED !== "1";
      const distributeOn = process.env.OC_IMAGE_DISTRIBUTE_DISABLED !== "1";
      if (preheatOn || distributeOn) {
        throw new Error(
          "[commercial] v5 双 master:compute-pool 三件套(preheat/initComputePool/imagePromote)未纳入 " +
            "LeaderBundle,eager 跑会在两 slot 双写 v3 compute_hosts 且违反 shared 单跑不变量。须在 v5 " +
            "drop-in 显式关闭:OC_PREHEAT_DISABLED=1 且 OC_IMAGE_DISTRIBUTE_DISABLED=1(v3 已下线、v5 镜像本机常驻)。拒起。",
        );
      }
    }

    // V3 Phase 3I — 启动时镜像预热(fire-and-forget):本地已有 → noop;
    // 没有 → docker pull,把首次 provision 30-60s 拉镜像延迟摊到启动时。
    // OC_PREHEAT_DISABLED=1 关闭(测试 / 网络受限 / CI)。失败不影响 gateway。
    // P1d 单一权威:preheat + 其内嵌的 compute pool init / image-promote scheduler 都向
    // 共享 compute_hosts 写状态。v5(dualMaster)已由上方 MAJOR 4 护栏要求显式关闭这些开关;
    // 走到此处的 v5 一定 preheatOn=false,故本块实际只在非双 master(v3/legacy leader)执行。
    if (controlPlaneEnabled && process.env.OC_PREHEAT_DISABLED !== "1") {
      void preheatV3Image(v3Docker, cfg.OC_RUNTIME_IMAGE, {
        info: (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn: (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
      }).catch((err: unknown) => {
        // preheatV3Image 内部已经吞了所有错;到这里只是兜底防 unhandledRejection
        // eslint-disable-next-line no-console
        console.warn("[commercial] v3 preheat unexpectedly threw", { error: (err as Error)?.message ?? String(err) });
      });

      // 0042 — 启动时 compute pool 初始化:
      //   1. inspect 本地 OC_RUNTIME_IMAGE → 算 desiredImageId
      //   2. setDesiredImage(打开 placement gate)
      //   3. setLoadedImage(self,= master 本机 image)
      //   4. backfill:并发 4 / 单 host 30s / 整体 5min,拉一遍 /health 给非-self host 写各维度
      //   5. 一次 promoteOnce(distribute 把 host 与 desired 对齐)
      //   后台启动 ImagePromoteScheduler — 每 5min 自动 inspect+distribute,补 master image 升级后的状态收敛。
      //
      //  本调用替代旧 distributePreheatToAllHosts startup 调用 —— promoteOnce 内部已经包了
      //  distribute,且会写 loaded_image_id + clear quarantine。
      //  OC_IMAGE_DISTRIBUTE_DISABLED=1 仍可关掉(单机 dev / 测试)。
      if (process.env.OC_IMAGE_DISTRIBUTE_DISABLED !== "1") {
        // imagePromote 实际 .start() 在 initComputePool 完成后(异步),但归属登记必须
        // 同步发生在 gate 判定点 —— 否则 v5 不变量断言窗口期看不到它(此前的漏登记盲区)。
        trackScheduler("imagePromote", "shared", true);
        void initComputePool({ imageTag: cfg.OC_RUNTIME_IMAGE })
          .then((r) => {
            // eslint-disable-next-line no-console
            console.log("[commercial] compute pool init done", {
              desiredImageId: r.desiredImageId,
              selfSynced: r.selfSynced,
              backfillHosts: r.backfillHosts,
              backfillSucceeded: r.backfillSucceeded,
              backfillSkipped: r.backfillSkipped,
              backfillTimedOut: r.backfillTimedOut,
              promoteRan: r.promoteRan,
            });
            // 启动周期性 promote scheduler(60s 后第一 tick,之后每 5min)。
            // trackScheduler 幂等:gate 判定点已同步登记占位,此处重复包装不产生重复项。
            trackScheduler("imagePromote", "shared", getImagePromoteScheduler({ imageTag: cfg.OC_RUNTIME_IMAGE })).start();
          })
          .catch((err: unknown) => {
            // initComputePool 内部 best-effort 不抛;到这里就是 bug
            // eslint-disable-next-line no-console
            console.warn("[commercial] compute pool init unexpectedly threw", {
              error: (err as Error)?.message ?? String(err),
            });
          });
      }
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] v3 supervisor disabled; missing env: OC_RUNTIME_IMAGE",
    );
  }

  // v1.0.120 feat/codex-disable-rebind:fanoutDeps 装配 —— admin disable codex
  // 账号 / refresh.ts 401 自动 disable 后触发后台 actor,把仍绑该账号的容器
  // rebind 到新 active 账号(M2 强一致路径)。
  //
  // 单机 / v3Deps 未装(测试 / 无 docker)时 putRemoteCodexAuth 为 undefined,
  // 走本地 fs 写;若实际 row.host_uuid 是远端但 helper 未注入,
  // fetchSnapshotAndWriteContainerAuth 会抛错 → tx ROLLBACK,符合强一致语义。
  // 句柄声明在 block 外,shutdown 才能 stop(fanoutDeps 是 block-local)。
  let codexDriftReconciler: CodexDriftReconcilerHandle | undefined;
  {
    const codexContainerDirForFanout =
      process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
    const fanoutDeps: CodexDisableFanoutDeps = {
      writeAuth: {
        selfHostId: v3Deps?.selfHostId ?? null,
        containerUid: V3_AGENT_UID,
        containerGid: V3_AGENT_GID,
        codexContainerDir: codexContainerDirForFanout,
        putRemoteCodexAuth: v3Deps?.putRemoteCodexAuth,
      },
      concurrency: 4,
      logger: rootLogger.child({
        subsys: "commercial",
        module: "codexDisableFanout",
      }),
    };
    triggerCodexDisableFanoutRef.current = (accountId: bigint) => {
      enqueueCodexDisableFanout(accountId, fanoutDeps);
    };
    // B3 — fanout 是 fire-and-forget,单容器 rebind 失败无重试且恢复 actor 看不到
    // disabled 账号的残留绑定 → 周期性兜底对账,复用同一强一致 rebind。
    //
    // 【域归属 v5-owned(channel-scoped)】0098 起 codex 账号池权威按 runtime_channel
    // 划分:reconciler 只扫本 channel 的 agent_containers/claude_accounts 行(SQL 已带
    // runtime_channel 注入)。沿旧 controlPlaneEnabled gate 会让 v5 的 codex 绑定漂移
    // 永远无人对账(v3 leader 只管 v3 行)—— 与 channel 纪律自相矛盾,故 v5 必须自己跑。
    if (
      (controlPlaneEnabled || runtimeChannel === "v5") &&
      process.env.COMMERCIAL_CODEX_DRIFT_RECONCILER_DISABLED !== "1"
    ) {
      const raw = Number(process.env.COMMERCIAL_CODEX_DRIFT_RECONCILER_INTERVAL_MS);
      const intervalMs = Number.isFinite(raw) && raw >= 30_000 ? raw : 300_000;
      codexDriftReconciler = trackScheduler("codexDriftReconciler", "v5-owned", startCodexDisableDriftReconciler({ deps: fanoutDeps, intervalMs }));
    }
  }

  // V3 多机路由:启动 BaselineServer,给远端 node-agent 提供
  // /internal/v3/baseline-{version,tarball} 端点。只在 v3Deps + selfHostUuid
  // 都就绪且 runtimeChannel!=v5 时起(多机 wiring 前置条件),失败不阻断 gateway —— remote host 拉
  // baseline 失败时 provisionV3Container 会走 CcbBaselineMissing fail-closed。
  // V5 P1 是 local-only，明确不注册/调度 remote compute host，也不能在 A/B 双 master
  // 同时抢占一个 baseline 端口；V5 本地容器直接 ro bind slot-local baseline，无需此 server。
  // V3 bind 0.0.0.0 + mTLS + PSK 双因子认证;GCP default-allow-internal 挡公网。
  let baselineSrv: BaselineServer | undefined;
  if (v3Deps && selfHostUuid && runtimeChannel !== "v5") {
    try {
      const baselineDir =
        process.env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR;
      baselineSrv = getBaselineServer({
        baselineDir,
        bind: "0.0.0.0",
        port: 18792,
      });
      await baselineSrv.start();
      // eslint-disable-next-line no-console
      console.log("[commercial] baseline server started", {
        bind: "0.0.0.0",
        port: 18792,
        baselineDir,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] baseline server start failed", {
        err: (err as Error)?.message ?? String(err),
      });
      baselineSrv = undefined;
    }
  }

  // C.3 — 向 sshMux 注入 remote-aware 依赖。不注入时 acquireMux 的 remote 分支
  // 会抛 "RPC fns not configured"(sshMux.ts defaultDeps),等价于死代码。此处必须
  // 在 createCommercialHandler / sessionManager 初始化之前完成注入。
  //
  // resolvePlacement 合约(sshMux.ts):按 userId 查 sticky compute_host;self → {kind:'self'},
  // 其它 → {kind:'remote', target}。fail-closed:DB 错 / 无 active 容器 → 抛
  // RemoteHostError("INTERNAL", "NO_CONTAINER: ...")。sshMux caller 会把异常 propagate。
  //
  // 注:M1 语义是"一个 user 最多占一台 compute_host"(findUserStickyHost LIMIT 1),故 hostId
  // 参数目前只用于日志;未来若放宽"单用户多容器",此处要重新 keyed by (userId, hostId)。
  setRemoteMuxDeps({
    async resolvePlacement(userId, hostId) {
      const uidInt = Number.parseInt(userId, 10);
      if (!Number.isFinite(uidInt) || uidInt <= 0 || String(uidInt) !== userId) {
        throw new RemoteHostError(
          "INTERNAL",
          `resolvePlacement: userId not positive integer: ${userId}`,
        );
      }
      const sticky = await computeQueries.findUserStickyHost(uidInt);
      if (!sticky) {
        throw new RemoteHostError(
          "INTERNAL",
          `NO_CONTAINER: user ${userId} has no active container (hostId=${hostId})`,
        );
      }
      const hostRow = await computeQueries.getHostById(sticky.hostUuid);
      if (!hostRow) {
        throw new RemoteHostError(
          "INTERNAL",
          `compute_host ${sticky.hostUuid} not found (userId=${userId} hostId=${hostId})`,
        );
      }
      rootLogger.debug("sshMux resolvePlacement", {
        subsys: "remote-ssh",
        userId,
        hostId,
        resolvedHostUuid: hostRow.id,
        resolvedName: hostRow.name,
      });
      if (hostRow.name === "self") return { kind: "self" };
      // A3 — 终态 revoked host 不再做 SSH 远端文件操作(deny)。setRevoked 已清
      // fingerprint;requireFingerprint=true 让缺 pin 的 host 也在 TLS 层 fail-closed。
      if (hostRow.status === "revoked") {
        throw new RemoteHostError(
          "INTERNAL",
          `compute_host ${sticky.hostUuid} revoked (userId=${userId} hostId=${hostId})`,
        );
      }
      const target = hostRowToTarget(hostRow);
      target.requireFingerprint = true;
      return { kind: "remote", target };
    },
    startSshControlMaster,
    stopSshControlMaster,
    putRemoteFile: nodeAgentPutFile,
    deleteRemoteFile: nodeAgentDeleteFile,
  });
  // eslint-disable-next-line no-console
  console.log("[commercial] sshMux remote deps wired");

  // v1.0.191 — /api/media-signed 冷启动护栏 + per-uid singleflight 合并。
  // 详见 handlers.ts ensureContainerReady JSDoc 与 ensureContainerSingleflight.ts。
  //
  // **单一 singleflight 权威**(2026-07-07 saga 根治,修 Codex MAJOR):本进程内**所有**
  // provision 入口 —— WS bridge `resolveContainerEndpoint` / HTTP `/api/media-signed`
  // ensureContainerReady / cronWake wakeContainer / prewarm(下方复用本闭包)—— 全部汇入
  // 这**唯一一个** makeUidSingleflight in-flight map。于是同 uid 有在途 provision 时,任何
  // 后来者都 **join 同一 promise**,绝不独立走 getV3ContainerStatus 观察到 saga 中段的
  // active+cid=NULL 在途占位行去销毁它(singleflight 在 ensureRunning 完整 settle 才 unwrap,
  // 那时 Tx2 已提交 cid)。
  //
  // **关键推论**:getV3ContainerStatus 观察到 active+cid=NULL ⟺ 本进程无在途 provision ⟺
  // 该行是崩溃/重启残留的**孤儿**(Tx1 提交后进程异常留下)。因此 15s grace 回归其原始
  // "孤儿检测"用途(不需魔法 120s),provisioning 态是孤儿的**有界自愈等待**(≤15s 后转
  // missing → stopAndRemove + 重建自愈,不引入慢愈退化)。见 v3supervisor
  // getV3ContainerStatus / v3ensureRunning 2a-bis 的语义注释。
  const clearResolvedEndpointSecret = (
    endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>,
  ): void => {
    try { endpoint.tunnel?.nodeAgent.psk?.fill(0); } catch { /* best-effort secret cleanup */ }
  };
  const cloneResolvedEndpoint = (
    endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>,
  ): Awaited<ReturnType<ResolveContainerEndpoint>> => ({
    ...endpoint,
    ...(endpoint.tunnel
      ? {
          tunnel: {
            ...endpoint.tunnel,
            nodeAgent: {
              ...endpoint.tunnel.nodeAgent,
              psk: endpoint.tunnel.nodeAgent.psk
                ? Buffer.from(endpoint.tunnel.nodeAgent.psk)
                : null,
            },
          },
        }
      : {}),
  });
  const sharedEnsureRunning: ResolveContainerEndpoint | undefined = v3Deps
    ? makeUidSingleflight(makeV3EnsureRunning(v3Deps), {
        // A provision singleflight may fan out to chat, legacy preview and
        // native preview at once. Give every consumer its own mutable PSK
        // buffer so one transport's mandatory fill(0) cannot break another.
        cloneResult: cloneResolvedEndpoint,
        disposeSharedResult: clearResolvedEndpointSecret,
      })
    : undefined;

  const ensureContainerEndpointReady: ((uid: bigint) => Promise<void>) | undefined =
    sharedEnsureRunning
      ? async (uid) => {
          const endpoint = await sharedEnsureRunning(uid);
          clearResolvedEndpointSecret(endpoint);
        }
      : undefined;

  const ensureContainerReady: ((uid: bigint) => Promise<void>) | undefined =
    ensureContainerEndpointReady;

  // 邮箱验证成功 → fire-and-forget 触发 v3 容器 pre-warm(p50=215s"验证 → 首消息"间隔
  // 覆盖 docker run 冷启,首条消息命中 running)。
  // **复用 sharedEnsureRunning 的同一 singleflight**(不再独立 makeV3EnsureRunning 闭包):
  // 旧独立闭包让 prewarm 与 WS 走两个 in-flight map,都能独立观察并销毁同一 active+cid=NULL
  // 在途行(Codex MAJOR)。统一后 prewarm 在途时 WS 请求 join 而非另起观察销毁。fire-and-forget
  // 语义仍由 makePrewarmContainer 外层 .catch 吞掉保留(它只把返回 promise 吞掉,同步 return void)。
  // v3Deps 未配 → sharedEnsureRunning undefined → prewarmContainer undefined → handler 端 no-op。
  const prewarmContainer: ((uid: bigint) => void) | undefined = sharedEnsureRunning
    ? makePrewarmContainer(
        sharedEnsureRunning,
        rootLogger.child({ subsys: "v3/prewarm" }),
        ({ userId, correlation, latencyMs }) => {
          void recordProductFrictionEvent({
            correlation,
            userId,
            surface: "container",
            stage: "prewarm",
            code: "PREWARM_FAILED",
            outcome: "failed",
            latencyMs,
          }, getPool()).catch(() => {});
        },
      )
    : undefined;

  // V3 multi-tenant media resolver(`c:<uid>` → user volume {uploads, generated})
  // 仅暴露给 gateway(`RegisterCommercialResult.resolveUserMediaDirs`,装配
  // _resolveMediaDirs 用于 /api/uploads 写路径)。
  //
  // v1.0.131 起 media-sign handler 不再用此 resolver:签 URL / 验签的路径都是
  // 容器内 `/home/agent/...` 命名空间,master 侧只做 `isContainerPathAllowed`
  // sanity check,真正 ACL 由 containerFileProxy 转发到容器内 handleApiFile
  // (走 agentCwds + realpathSync + isFileAllowed) 把权威。
  //
  // 装配条件:有 docker client 即可——agentRuntime(legacy)或 v3Deps(on-demand 容器运行时)任一。
  // ⚠️ v5 回归根因(P7 修复):v5 env 移除 AGENT_IMAGE 以禁 legacy agent runtime + 其 scheduler
  // → agentRuntime=undefined → 旧代码 resolver=undefined → gateway _resolveMediaDirs 回退到
  // master 单租户 uploadsDir,/api/uploads 写的文件进不了用户容器卷,容器内 dispatchInbound
  // 解析 /api/media/<file> 时报"媒体不存在或不可读"。v3 prod 有 AGENT_IMAGE(agentRuntime 在)
  // 故无此问题。这里把 docker 退到 v3Deps.docker：优先 agentRuntime(v3 行为零改变),v5 用 v3Deps。
  // resolver 内部按 getRuntimeChannel() 解析 channel 卷(oc-v5-data-u<uid>),安全。
  const mediaResolverDocker = agentRuntime?.docker ?? v3Deps?.docker;
  const userMediaResolver = mediaResolverDocker
    ? createUserMediaResolver({
        pool: getPool(),
        docker: mediaResolverDocker,
      })
    : undefined;
  knowledgePlanetMediaResolverRef.current = userMediaResolver

  // Shared remote-host upload closure. It is used by both gateway /api/uploads
  // and the master-side WeChat image ingest bridge so the two paths keep the
  // same node-agent semantics (0644, owner 1000:1000, PSK zeroing).
  const pushRemoteHostUpload = async (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => {
    // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒。
    const target = await resolveServiceableHostTarget(args.hostUuid);
    try {
      await nodeAgentPutFile(
        target,
        args.remotePath,
        args.content,
        0o644,
        1000,
        1000,
      );
    } finally {
      target.psk?.fill(0);
    }
  };

  // One endpoint resolver is shared by chat, legacy screencast and direct
  // iframe transports. Keep it above HTTP handler assembly so the optional
  // direct service can own public preview-host requests from the first byte.
  const resolveContainerEndpoint: ResolveContainerEndpoint =
    options.resolveContainerEndpoint
    ?? sharedEnsureRunning
    ?? (async (_uid: bigint) => {
      throw new ContainerUnreadyError(5, "supervisor_not_wired");
    });

  // V5 container-local web preview is intentionally atomic: the HTTP ticket
  // endpoint stays unavailable until the authenticated public WS bridge has
  // been assembled below. Model authority provides the existing Ed25519 trust
  // root; without it, a same-UID process inside the user container could forge
  // preview capabilities.
  const containerPreviewBaseUrl = process.env.COMMERCIAL_BASE_URL?.trim();
  const containerPreviewTickets =
    runtimeChannel === "v5"
    && modelAuthoritySigner
    && v3Deps
    && containerPreviewBaseUrl
      ? new ContainerPreviewTicketStore()
      : undefined;
  let containerPreviewBridge: ContainerPreviewBridgeHandler | undefined;
  let directContainerPreview: DirectContainerPreviewService | undefined;
  if (
    process.env.OC_CONTAINER_DIRECT_PREVIEW_ENABLED === "1"
    && containerPreviewTickets
    && modelAuthoritySigner
    && containerPreviewBaseUrl
  ) {
    try {
      directContainerPreview = createDirectContainerPreviewService({
        signer: modelAuthoritySigner,
        resolveContainerEndpoint,
        parentOrigin: containerPreviewBaseUrl,
        tunnelOrigin: `http://127.0.0.1:${options.gatewayPort}`,
        cloudflaredBinary: process.env.OC_CONTAINER_PREVIEW_CLOUDFLARED_BIN,
        maxSessions: Number(process.env.OC_CONTAINER_PREVIEW_MAX_SESSIONS),
        warmTunnels: Number(process.env.OC_CONTAINER_PREVIEW_WARM_TUNNELS || 2),
        logger: rootLogger.child({ subsys: "commercial", module: "directContainerPreview" }),
      });
      // eslint-disable-next-line no-console
      console.log("[commercial] V5 native iframe preview ENABLED (temporary Quick Tunnel beta)");
    } catch (err) {
      rootLogger.error("[commercial] native iframe preview disabled", {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  const handler = createCommercialHandler({
    jwtSecret,
    mediaGeneration: mediaGenerationService,
    goalStateService,
    containerPreviewTickets,
    containerPreviewAvailable: () => containerPreviewBridge !== undefined,
    directContainerPreview,
    pluginRuntime: pluginFacade,
    knowledgePlanetSetup,
    weiboSetup,
    knowledgePlanetAutomation,
    mailer,
    redis: wrapIoredis(redis),
    literatureDailyUsage: async (key) => {
      const value = await redis.get(key)
      return value === null ? 0 : Number(value)
    },
    turnstileSecret: cfg.TURNSTILE_SECRET,
    turnstileBypass: cfg.TURNSTILE_TEST_BYPASS,
    // 账号级人机验证白名单(2026-07-26 安全整改)。生产上 TURNSTILE_TEST_BYPASS 已被
    // config.ts 的危险开关扫描 fail-closed 拦死,自动化(e2e-journey / smoke-turn /
    // 技能评测)改由这里的账号白名单放行 —— 作用域收敛到具体邮箱,真实用户零影响。
    turnstileBypassAccounts: cfg.TURNSTILE_BYPASS_ACCOUNTS,
    turnstileEnforce: cfg.TURNSTILE_ENFORCE,
    turnstileSiteKey: cfg.TURNSTILE_SITE_KEY,
    requireEmailVerified: cfg.REQUIRE_EMAIL_VERIFIED,
    // HIGH#4:生产 claudeai.chat 全 HTTPS,默认 Secure cookie;
    // 仅当 env COMMERCIAL_INSECURE_COOKIE=1(本地 dev / docker compose)才关
    refreshCookieSecure: process.env.COMMERCIAL_INSECURE_COOKIE === "1" ? false : true,
    verifyEmailUrlBase: process.env.COMMERCIAL_BASE_URL,
    resetPasswordUrlBase: process.env.COMMERCIAL_BASE_URL,
    pricing,
    // `/api/public/models` 的投影权威(方案 §6):active catalog + pricing join,
    // provider 归属/能力/可用性全部来自 catalog(不再用 route registry 推断)。
    // 取进程级唯一快照(modelCatalogRuntime 单例;上面 internal-proxy 装配段已 get 过)——
    // 未装配(skipInternalProxy / catalog 拉不起来的 shadow 期)→ undefined → handler 退 legacy 投影。
    modelCatalog: peekModelCatalogCache() ?? undefined,
    loadUserModelAuthz,
    // T-23 preCheck 复用限流用的 ioredis 客户端(SCAN / SET EX 都 OK)
    preCheckRedis,
    // 2026-05-06:admin reset-cooldown 修 bug 时新接的依赖。adminResetCooldown
    // 在 status='cooldown' 时调 health.recoverFromCooldown 把账号一并 active+50
    // (避免 cooldown_until=NULL ∧ status='cooldown' 的永久卡死)。
    accountHealth: healthTracker,
    hupijiao,
    hupijiaoConfig,
    agentRuntime,
    // 按需容器路径就绪 = v3-supervisor 已装配(v3Deps)。/api/agent/status 据此返
    // runtime_ready+ondemand,前端跳过 legacy 订阅 gate 直连 WS(v5 ccb 单底座聊天前置)。
    containerRuntimeReady: Boolean(v3Deps),
    // HIGH#6:admin/containers v3 行的 stop/remove/restart 走这条 dispatch
    v3Supervisor: v3Deps,
    prewarmContainer,
    // v1.0.191 — /api/media-signed 冷启动护栏。装配端做了 per-uid singleflight 合并,
    // 见上方 ensureContainerReady 构造闭包注释。
    ensureContainerReady,
    // v3 file proxy:root secret 给 containerFileProxy 签 per-request nonce;
    // feature flag 控制 router 是否把 /api/file / /api/media/* 从 BLOCKED 拉进 PROXY 分支
    bridgeSecret,
    fileProxyEnabled: cfg.FILE_PROXY_ENABLED,
    // v3 signed media URL —— HKDF 派生的 32-byte key。
    // 缺失 → /api/media-sign 与 /api/media-signed 返 503,前端拿到 null 即保持占位
    // (透明 PNG / 空 src);**不退回 cookie 路径**,那条 path 正是 iOS Safari 丢
    // cookie 的根因。详见上面 mediaSignKey 注释。
    //
    // 旧版还往这里注入 resolveUserMediaDirs(把 container 路径反解到 host volume
    // 路径再用 makeUserScopedMediaPredicate 做 ACL),v1.0.131 起删除:容器路径与
    // 主机路径同时存在导致两侧语义错位,真正 ACL 由容器内 handleApiFile (走
    // agentCwds + realpathSync + isFileAllowed) 把权威,master 侧只做 sanity check
    // (isContainerPathAllowed)。
    mediaSignKey,
    // 服务端缩略图缓存(见 mediaThumbnail.ts):/api/media-signed?w=640|1280 缩 webp。
    thumbnailCache,
    wechatLiveLinkKey,
    // v1.0.120 feat/codex-disable-rebind:透传给 admin/accounts handler 的
    // adminPatchAccount ctx,active→disabled 转移触发 fanout actor。
    triggerCodexDisableFanout,
    // V3 CC 外接 plan Phase 3:公网 `POST /api/anthropic/v1/messages` 的 handler
    // 实例。undefined 时 router 该路径返 503 EXTERNAL_PROXY_UNAVAILABLE 而非 404。
    externalApiKeyProxy,
  });

  // legacy /ws/agent(T-52 老 agent runtime WS 入口)已删除;v5 一律走 /ws/user-chat-bridge。

  // V3 Phase 2 Task 2H + Phase 3D:用户 WS ↔ 容器 WS 桥接(/ws/user-chat-bridge)。
  //
  // resolveContainerEndpoint 的解析顺序(高优先 → 低优先):
  //   1. options.resolveContainerEndpoint(测试 / 显式覆盖)
  //   2. v3 supervisor(env 完备 → makeV3EnsureRunning,见上方 v3Deps 装配)
  //   3. stub `supervisor_not_wired`(Phase 2 行为,/healthz 仍报 commercial up)
  //
  // 注:v3Deps 已在 createCommercialHandler 之前装配(HIGH#6 admin v3 dispatch 需要)。

  // ── P3:容器面 shared 调度器收口 LeaderBundle(RFC D4)──────────────────────────
  // 旧模型每个都 `if (controlPlaneEnabled && ...)` eager-start;双 master 下会双跑(双误杀/双删卷/
  // 双对账竞态)。改造:membership = 各自 deps(v3Deps)+ *_DISABLED(不含 leadership),启动时机
  // 交给 lease(v5)/ controlPlaneEnabled(legacy)统一触发。trackScheduler 留在 start 闭包内
  // (注册进 schedulerRegistry + 满足 scheduler-wiring lint);drain 时 bundle 经 onMemberStopped 摘除。
  // orphanReconcile 曾以 v5-owned `||v5` 双跑(错峰缓解),P3 归入 leader 单跑=正解(消错峰假设)。
  if (v3Deps && process.env.OC_IDLE_SWEEP_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "idleSweep",
      domain: "shared",
      start: () => {
        const idleSweepLog = rootLogger.child({ subsys: "v3/idleSweep" });
        const h = trackScheduler("idleSweep", "shared", startIdleSweepScheduler(deps, { logger: idleSweepLog, runOnStart: false }));
        idleSweepLog.info("scheduler started", { tickSec: 60, idleCutoffMin: 30 });
        return { stop: () => h.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_VOLUME_GC_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "volumeGc",
      domain: "shared",
      start: () => {
        const volumeGcLog = rootLogger.child({ subsys: "v3/volumeGc" });
        const h = trackScheduler("volumeGc", "shared", startVolumeGcScheduler(deps, { logger: volumeGcLog, runOnStart: false }));
        volumeGcLog.info("scheduler started", { tickSec: 3600, bannedDays: 7, noLoginDays: 90 });
        return { stop: () => h.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_ORPHAN_RECONCILE_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "orphanReconcile",
      domain: "v5-owned",
      start: () => {
        const orphanReconcileLog = rootLogger.child({ subsys: "v3/orphanReconcile" });
        const h = trackScheduler("orphanReconcile", "v5-owned", startOrphanReconcileScheduler(deps, { logger: orphanReconcileLog }));
        orphanReconcileLog.info("scheduler started", { tickSec: 3600, runOnStart: true });
        return { stop: () => h.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_MIGRATION_RECONCILER_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "migrationReconcile",
      domain: "shared",
      start: () => {
        const migrationReconcileLog = rootLogger.child({ subsys: "v3/migrationReconciler" });
        const h = trackScheduler("migrationReconcile", "shared", startMigrationReconcileScheduler(deps, { logger: migrationReconcileLog }));
        migrationReconcileLog.info("scheduler started", { tickSec: 60, staleSec: 600, runOnStart: true });
        return { stop: () => h.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_HEALTH_POLLER_DISABLED !== "1") {
    leaderBundle.add({
      name: "healthPoller",
      domain: "shared",
      start: () => {
        const hp = trackScheduler("healthPoller", "shared", getHealthPoller());
        hp.start();
        rootLogger.child({ subsys: "node-health" }).info("scheduler started", { intervalMs: 30_000 });
        return { stop: () => hp.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_CONTAINER_EVENTS_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "containerEvents",
      domain: "shared",
      start: () => {
        const h = trackScheduler("containerEvents", "shared", startV3ContainerEventsWorker({
          docker: deps.docker,
          logger: {
            debug: (m, meta) => { /* eslint-disable-next-line no-console */ console.debug(m, meta ?? {}); },
            info:  (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
            warn:  (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
            error: (m, meta) => { /* eslint-disable-next-line no-console */ console.error(m, meta ?? {}); },
          },
        }));
        // eslint-disable-next-line no-console
        console.log("[commercial] v3 container events worker started (oom/die → alerts)");
        return { stop: () => h.stop() };
      },
    });
  }

  if (
    containerPreviewTickets
    && modelAuthoritySigner
    && containerPreviewBaseUrl
  ) {
    try {
      containerPreviewBridge = createContainerPreviewBridge({
        tickets: containerPreviewTickets,
        signer: modelAuthoritySigner,
        resolveContainerEndpoint,
        allowedOrigin: containerPreviewBaseUrl,
        maxGlobalSessions: Number(process.env.OC_CONTAINER_PREVIEW_MAX_SESSIONS),
        createTunnelContainerSocket: (tunnel, port, assertion, connectionTraceId, signal) =>
          createTunnelContainerSocket(
            tunnel.nodeAgent,
            tunnel.containerInternalId,
            port,
            signal,
            {
              maxFrameBytes: CONTAINER_PREVIEW_MAX_FRAME_BYTES,
              connectionTraceId,
              containerWsPath: "/ws/container-preview",
              previewAssertion: assertion,
            },
          ),
        logger: rootLogger.child({ subsys: "commercial", module: "containerPreviewBridge" }),
      });
      // eslint-disable-next-line no-console
      console.log("[commercial] V5 container web preview ENABLED");
    } catch (err) {
      // Ticket issuance remains fail-closed through containerPreviewAvailable.
      rootLogger.error("[commercial] container web preview disabled", {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }


  // ─── wechat codex(gpt-*)turn:api_relay 路由 + 真扣费 ─────────────────────
  // 接收侧插槽:wechat/inboundDispatcher.prepareCodexTurn / outboundReceiver.handleCodexBilling。
  // v5 计费口径(M1b):finalizer 走双钱包 settle;usage_records.account_id=NULL;
  // session_id=deriveEngineSessionId 口径;cost 回执走 appendCostCreditsForUser
  // (c:<uid> 前缀对齐 session 存储命名空间 —— v3 旧版直调 appendCostCredits 是孤儿成本 bug)。
  const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000;
  const DEFAULT_CODEX_SESSION_MAX_MS = 600_000;
  const readCodexSessionMaxMs = (): number => {
    const raw = process.env.CODEX_SESSION_MAX_MS;
    if (!raw) return DEFAULT_CODEX_SESSION_MAX_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_CODEX_SESSION_MAX_MS;
  };
  const newCodexRequestId = (): string => randomBytes(16).toString("hex");
  const codexRouteLog = rootLogger.child({ subsys: "commercial", module: "codexRoute" });

  // M2 — 网页(bridge)codex turn 的 per-turn 路由决策(与 wechat 版差异:bridge
  // 需要 api_relay / official_oauth / unavailable 判别联合,由 bridge 决定占槽
  // 还是 fast-fail;wechat 只走 api_relay)。恢复源 = P1f^ 同名函数,零语义改动。
  const createCommercialCodexRoute = async ({ containerId, userId, modelId, sessionId }: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
  }) => {
    if (isGrokEngineModel(modelId)) {
      // grok_route_contexts is the durable concurrency authority. Rebuild the
      // local scheduler mirror before every allocation so a browser disconnect,
      // generic slot reaper, or Master restart cannot make a live route vanish
      // from the cap check.
      for (const lease of await listActiveGrokRouteLeases()) {
        scheduler.restoreCodexSlot(lease.accountId, lease.slotId);
      }
      const groups = await listEnabledGroupsForModel({ modelId, provider: "grok" });
      let busy: AccountPoolBusyError | null = null;
      for (const group of groups) {
        let picked;
        try {
          picked = await scheduler.pick({
            mode: "agent",
            provider: "grok",
            groupId: group.id,
            sessionId: sessionId ?? `container:${containerId}`,
          });
        } catch (err) {
          if (err instanceof AccountPoolBusyError) { busy = err; continue; }
          if (err instanceof AccountPoolUnavailableError) continue;
          throw err;
        }
        picked.token.fill(0);
        picked.refresh?.fill(0);
        let route;
        try {
          route = await tx((client) => createGrokRouteContextForModel({
            containerId,
            userId,
            modelId,
            accountId: picked.account_id,
            slotId: picked.slotId,
            groupId: group.id,
            runner: client,
            maxConcurrent: scheduler.maxConcurrent,
          }));
        } catch (err) {
          scheduler.releaseCodexSlot(picked.account_id, picked.slotId);
          throw err;
        }
        if (!route) {
          scheduler.releaseCodexSlot(picked.account_id, picked.slotId);
          continue;
        }
        return {
          kind: "api_relay" as const,
          engine: "grok" as const,
          token: route.token,
          baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v5/grok-relay/route/${route.token}/v1`,
          modelProvider: "grok",
          providerName: "xAI Grok subscription",
          wireApi: "chat" as const,
          preferredAuthMethod: "apikey" as const,
          disableResponseStorage: true,
          groupId: route.group.id.toString(),
          credentialId: route.accountId.toString(),
          accountId: route.accountId.toString(),
          slotId: picked.slotId,
        };
      }
      if (busy) throw busy;
      return { kind: "unavailable" as const, reason: "no usable Grok subscription account" };
    }
    const groups = await listEnabledGroupsForModel({ modelId, provider: "codex" });
    if (groups.length === 0) return null;
    for (const group of groups) {
      if (group.kind === "api_relay") {
        const route = await createCodexRouteContextForModel({
          containerId,
          userId,
          modelId,
          groupId: group.id,
        });
        if (!route) continue;
        return {
          kind: "api_relay" as const,
          engine: "codex" as const,
          token: route.token,
          baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v3/codex-relay/route/${route.token}`,
          modelProvider: route.credential.model_provider,
          providerName: route.credential.provider_name,
          wireApi: route.credential.wire_api,
          preferredAuthMethod: route.credential.preferred_auth_method,
          disableResponseStorage: route.credential.disable_response_storage,
          groupId: route.group.id.toString(),
          credentialId: route.credential.id.toString(),
        };
      }
      if (group.kind === "official_oauth") {
        const hasAccount = await hasActiveOfficialOAuthAccountInGroup(group.id, "codex");
        if (!hasAccount) continue;
        return { kind: "official_oauth" as const, groupId: group.id.toString() };
      }
    }
    return { kind: "unavailable" as const, reason: "no usable enabled Codex group" };
  };

  const createWechatApiRelayRoute = async (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
  }) => {
    const groups = await listEnabledGroupsForModel({ modelId: args.modelId, provider: "codex" });
    for (const group of groups) {
      if (group.kind !== "api_relay") continue;
      const route = await createCodexRouteContextForModel({
        containerId: args.containerId,
        userId: args.userId,
        modelId: args.modelId,
        groupId: group.id,
      });
      if (!route) continue;
      return {
        token: route.token,
        routeFrame: {
          baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v3/codex-relay/route/${route.token}`,
          modelProvider: route.credential.model_provider,
          providerName: route.credential.provider_name ?? null,
          wireApi: route.credential.wire_api ?? "responses",
          preferredAuthMethod: route.credential.preferred_auth_method ?? "apikey",
          disableResponseStorage: route.credential.disable_response_storage ?? true,
        },
      };
    }
    return null;
  };

  type WechatCodexTurnSnapshot = {
    finalizer: CodexFinalizeHandle;
    reservation: ReservationHandle;
    requestId: string;
    userId: bigint;
    containerId: number;
    model: string;
    traceId: string;
    routeToken: string;
    timeout: ReturnType<typeof setTimeout>;
  };
  const wechatCodexTurns = new Map<string, WechatCodexTurnSnapshot>();

  const expireCodexRouteToken = (token: string | null | undefined, reason: string): void => {
    if (!token) return;
    expireCodexRouteContext(token).catch((err) => {
      codexRouteLog.warn("expire_codex_route_failed", {
        reason,
        errMessage: (err as Error)?.message ?? String(err),
      });
    });
  };

  const failWechatCodexTurn = async (requestId: string, reason: string): Promise<void> => {
    const snap = wechatCodexTurns.get(requestId);
    if (!snap) return;
    wechatCodexTurns.delete(requestId);
    clearTimeout(snap.timeout);
    const failureCode: JournalFailureCode = reason === "wechat_container_cold_start"
      ? "UPSTREAM_UNAVAILABLE"
      : reason.startsWith("wechat_container_rejected_")
          || reason === "wechat_container_terminal_before_start"
        ? "UPSTREAM_REJECTED"
        : "INTERNAL_ERROR";
    try {
      await snap.finalizer.fail(reason, failureCode);
    } finally {
      expireCodexRouteToken(snap.routeToken, reason);
    }
  };

  const expireWechatCodexRecoverySnapshot = async (requestId: string): Promise<void> => {
    const snap = wechatCodexTurns.get(requestId);
    if (!snap) return;
    wechatCodexTurns.delete(requestId);
    clearTimeout(snap.timeout);
    // This is only an in-memory retention timeout, not a billing decision.
    // Keep the durable journal inflight indefinitely; a delayed fsynced frame
    // can reconstruct settlement after any master restart.
    await releasePreCheck(preCheckRedis, snap.reservation).catch(() => {});
    expireCodexRouteToken(snap.routeToken, "wechat_codex_snapshot_expired");
  };

  const safeBillingNum = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
    return Math.trunc(v);
  };

  const handleWechatCodexBilling = async (
    body: WechatCodexBillingBody,
    identity: { userId: number; containerId: number },
  ): Promise<void> => {
    const pool = getPool();
    const journal = await pool.query<{
      user_id: string;
      container_id: string | null;
      ctx: unknown;
    }>(
      `SELECT user_id::text AS user_id, container_id::text AS container_id, ctx
         FROM request_finalize_journal WHERE request_id=$1`,
      [body.requestId],
    );
    const row = journal.rows[0];
    if (!row) throw new Error(`wechat codex billing journal missing for ${body.requestId}`);
    if (row.user_id !== String(identity.userId) || row.container_id !== String(identity.containerId)) {
      throw new Error(`wechat codex billing identity mismatch for ${body.requestId}`);
    }
    const ctx = row.ctx !== null && typeof row.ctx === "object" && !Array.isArray(row.ctx)
      ? row.ctx as Record<string, unknown>
      : {};
    const agentId = typeof ctx.agentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(ctx.agentId)
      ? ctx.agentId
      : "codex";
    const derivedEngineSessionId = deriveEngineSessionId(
      `wechat:${identity.userId}:${identity.containerId}:${agentId}`,
    );
    const journalEngineSessionId = typeof ctx.engineSessionId === "string"
      && /^oceng-[0-9a-f]{48}$/.test(ctx.engineSessionId)
      ? ctx.engineSessionId
      : derivedEngineSessionId;
    if (body.engineSessionId !== undefined && body.engineSessionId !== journalEngineSessionId) {
      throw new Error(`wechat codex billing engine session mismatch for ${body.requestId}`);
    }
    const u = body.usage ?? {};
    const billing: DurableCodexBilling = {
      requestId: body.requestId,
      ...(body.turnKey ? { turnKey: body.turnKey } : {}),
      ...(body.parentTurnKey ? { parentTurnKey: body.parentTurnKey } : {}),
      ...(body.parentSessionId ? { parentSessionId: body.parentSessionId } : {}),
      ...(body.delegateAgentId ? { delegateAgentId: body.delegateAgentId } : {}),
      engineSessionId: journalEngineSessionId,
      status: body.status,
      ...(body.terminalCode !== undefined ? { terminalCode: body.terminalCode } : {}),
      durationMs: body.durationMs,
      usage: {
        input_tokens: safeBillingNum(u.input_tokens),
        output_tokens: safeBillingNum(u.output_tokens),
        reasoning_output_tokens: safeBillingNum(u.reasoning_output_tokens),
        cache_read_input_tokens: safeBillingNum(u.cache_read_input_tokens),
        cache_creation_input_tokens: safeBillingNum(u.cache_creation_input_tokens),
      },
      ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits } : {}),
    };
    try {
      await settleDurableCodexBilling(
        {
          pgPool: pool,
          preCheckRedis,
          pricing,
          logger: rootLogger.child({ subsys: "wechatDurableCodexBilling" }),
        },
        BigInt(identity.userId),
        billing,
      );
    } catch (err) {
      codexRouteLog.error("wechat_codex_finalizer_commit_failed", {
        requestId: body.requestId,
        errMessage: (err as Error)?.message ?? String(err),
      });
      // Propagate so outboundReceiver returns non-2xx and the gateway retains
      // its fsynced retry frame. Never ACK an unsettled/unknown journal.
      throw err;
    }
    const snap = wechatCodexTurns.get(body.requestId);
    if (snap) {
      wechatCodexTurns.delete(body.requestId);
      clearTimeout(snap.timeout);
      expireCodexRouteToken(snap.routeToken, "wechat_codex_billing_settled");
    }
  };

  const prepareWechatCodexTurn = async (args: {
    containerId: number;
    bindingUserId: string;
    userId: bigint;
    modelId: string;
    agentId: string;
    traceId: string;
  }): Promise<PrepareWechatCodexTurnResult> => {
    const route = await createWechatApiRelayRoute(args);
    if (!route) {
      return {
        kind: "unavailable",
        reply: "GPT 模型通道暂时不可用，请稍后再试，或发送 /model 切换到其它模型。",
      };
    }

    const modelPricing = pricing.get(args.modelId);
    if (!modelPricing) {
      expireCodexRouteToken(route.token, "wechat_codex_pricing_missing");
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    const agentForCharge = args.agentId || "codex";
    let derivedPricing: ModelPricing;
    try {
      const agentMul = await getAgentCostMultiplier(getPool(), agentForCharge);
      derivedPricing = {
        ...modelPricing,
        multiplier: composeMultiplier(modelPricing.multiplier, agentMul),
      };
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_multiplier_failed");
      codexRouteLog.error("wechat_codex_multiplier_failed", {
        agentId: agentForCharge,
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    const requestId = newCodexRequestId();
    let maxCost: bigint;
    try {
      maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_estimate_failed");
      codexRouteLog.error("wechat_codex_estimate_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费配置暂时不可用，请稍后再试。" };
    }

    let preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
    try {
      preCheckResult = await preCheckWithCost(preCheckRedis, {
        userId: args.userId,
        requestId,
        maxCost,
      });
    } catch (err) {
      expireCodexRouteToken(route.token, "wechat_codex_precheck_failed");
      if (err instanceof InsufficientCreditsError) {
        return { kind: "unavailable", reply: "余额不足，请到网页端充值后再使用 GPT 模型，或发送 /model 切换其它模型。" };
      }
      codexRouteLog.error("wechat_codex_precheck_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费检查暂时不可用，请稍后再试。" };
    }

    const engineSessionId = deriveEngineSessionId(
      `wechat:${args.bindingUserId}:${args.containerId}:${agentForCharge}`,
    );
    try {
      const admitted = await startInflightJournal(getPool(), {
        requestId,
        userId: args.userId,
        containerId: BigInt(args.containerId),
        model: args.modelId,
        precheckCredits: preCheckResult.maxCost,
        ctxJson: {
          agentId: agentForCharge,
          codexAccountId: null,
          source: "wechat_codex_api_relay",
          durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
          billingPricing: serializeBillingPricing(derivedPricing),
          engineSessionId,
        },
      });
      if (!admitted) {
        await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
        expireCodexRouteToken(route.token, "wechat_codex_journal_conflict");
        codexRouteLog.error("wechat_codex_journal_conflict", { requestId });
        return { kind: "unavailable", reply: "GPT 模型计费初始化暂时不可用，请稍后再试。" };
      }
    } catch (err) {
      await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
      expireCodexRouteToken(route.token, "wechat_codex_journal_failed");
      codexRouteLog.error("wechat_codex_journal_failed", {
        requestId,
        errMessage: (err as Error)?.message ?? String(err),
      });
      return { kind: "unavailable", reply: "GPT 模型计费初始化暂时不可用，请稍后再试。" };
    }

    const finalizer = makeCodexFinalizer({
      pgPool: getPool(),
      preCheckRedis,
      userId: args.userId,
      requestId,
      // v5 计费口径:usage_records.session_id 单一权威 helper 派生(oceng-<48hex>)。
      // wechat 会话没有 ccb sessionKey,用 (binding, container, agent) 稳定三元组派生;
      // M2 gateway billing 事件接入后网页路径改用 gateway 传来的同算法值。
      engineSessionId,
      model: args.modelId,
      derivedPricing,
      reservation: preCheckResult.reservation,
    });
    const timeout = setTimeout(() => {
      void expireWechatCodexRecoverySnapshot(requestId);
    }, readCodexSessionMaxMs());
    timeout.unref?.();
    wechatCodexTurns.set(requestId, {
      finalizer,
      reservation: preCheckResult.reservation,
      requestId,
      userId: args.userId,
      containerId: args.containerId,
      model: args.modelId,
      traceId: args.traceId,
      routeToken: route.token,
      timeout,
    });

    return { kind: "ready", requestId, routeFrame: route.routeFrame };
  };

  // ─── Auto-Dream V2 optimizer: master-owned policy, actions and reporting ──
  type AutoDreamCodexSnapshot = {
    reservation: ReservationHandle;
    finalizer: CodexFinalizeHandle;
    routeToken: string | null;
    userId: bigint;
    containerId: number;
    engineSessionId: string;
    timeout: NodeJS.Timeout;
  };
  const autoDreamCodexTurns = new Map<string, AutoDreamCodexSnapshot>();

  const requireAutoDreamString = (
    body: Record<string, unknown>,
    key: string,
    re: RegExp,
  ): string => {
    const value = body[key];
    if (typeof value !== "string" || !re.test(value)) {
      throw new Error(`AUTO_DREAM_INVALID_${key.toUpperCase()}`);
    }
    return value;
  };

  autoDreamOptimizerRuntimeRef.current = {
    handle: async ({ path, identity, body }) => {
      const userId = BigInt(identity.userId);
      if (path === AUTO_DREAM_OPTIMIZER_ADMIT_PATH) {
        const runId = requireAutoDreamString(body, "runId", /^[0-9a-f-]{36}$/);
        const callId = requireAutoDreamString(body, "callId", /^[0-9a-f-]{36}:\d{1,8}$/);
        const agentId = requireAutoDreamString(body, "agentId", /^[A-Za-z0-9_-]{1,64}$/);
        const model = requireAutoDreamString(body, "model", /^gpt-5\.6-terra$/);
        const { getAutoDreamPolicy } = await import("./user/autoDream.js");
        const policy = await getAutoDreamPolicy(userId);
        if (
          !policy.enabled ||
          policy.mode !== "optimizer_v2" ||
          policy.modelId !== model
        ) {
          throw new Error("AUTO_DREAM_INVALID_POLICY");
        }
        const route = projectAutoDreamCodexRoute(
          await createCommercialCodexRoute({
            containerId: identity.containerId,
            userId,
            modelId: model,
          }),
        );
        if (!route) throw new Error("AUTO_DREAM_ROUTE_UNAVAILABLE");
        const basePricing = pricing.get(model);
        if (!basePricing) {
          expireCodexRouteToken(route.token, "auto_dream_pricing_missing");
          throw new Error("AUTO_DREAM_PRICING_UNAVAILABLE");
        }
        const agentMul = await getAgentCostMultiplier(getPool(), agentId);
        const derivedPricing: ModelPricing = {
          ...basePricing,
          multiplier: composeMultiplier(basePricing.multiplier, agentMul),
        };
        const requestId = newCodexRequestId();
        const maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
        let precheck: Awaited<ReturnType<typeof preCheckWithCost>>;
        try {
          precheck = await preCheckWithCost(preCheckRedis, { userId, requestId, maxCost });
        } catch (err) {
          expireCodexRouteToken(route.token, "auto_dream_precheck_failed");
          throw err;
        }
        const engineSessionId = deriveEngineSessionId(
          `auto-dream:${identity.userId}:${identity.containerId}:${agentId}`,
        );
        try {
          const admitted = await startInflightJournal(getPool(), {
            requestId,
            userId,
            containerId: BigInt(identity.containerId),
            model,
            precheckCredits: precheck.maxCost,
            ctxJson: {
              agentId,
              runId,
              callId,
              source: "auto_dream_optimizer",
              durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
              billingPricing: serializeBillingPricing(derivedPricing),
              engineSessionId,
            },
          });
          if (!admitted) throw new Error("AUTO_DREAM_JOURNAL_CONFLICT");
        } catch (err) {
          await releasePreCheck(preCheckRedis, precheck.reservation).catch(() => {});
          expireCodexRouteToken(route.token, "auto_dream_journal_failed");
          throw err;
        }
        const finalizer = makeCodexFinalizer({
          pgPool: getPool(),
          preCheckRedis,
          userId,
          requestId,
          engineSessionId,
          model,
          derivedPricing,
          reservation: precheck.reservation,
        });
        const timeout = setTimeout(() => {
          const live = autoDreamCodexTurns.get(requestId);
          if (!live) return;
          autoDreamCodexTurns.delete(requestId);
          expireCodexRouteToken(live.routeToken, "auto_dream_admission_expired");
          void releasePreCheck(preCheckRedis, live.reservation).catch(() => {});
        }, readCodexSessionMaxMs());
        timeout.unref?.();
        autoDreamCodexTurns.set(requestId, {
          reservation: precheck.reservation,
          finalizer,
          routeToken: route.token,
          userId,
          containerId: identity.containerId,
          engineSessionId,
          timeout,
        });
        return {
          requestId,
          engineSessionId,
          routeFrame: route.routeFrame,
        };
      }
      if (path === AUTO_DREAM_OPTIMIZER_FINDINGS_PATH) {
        const runId = requireAutoDreamString(body, "runId", /^[0-9a-f-]{36}$/);
        const agentId = requireAutoDreamString(body, "agentId", /^[A-Za-z0-9_-]{1,64}$/);
        const { getAutoDreamPolicy } = await import("./user/autoDream.js");
        const policy = await getAutoDreamPolicy(userId);
        if (!policy.enabled || policy.mode !== "optimizer_v2") {
          throw new Error("AUTO_DREAM_INVALID_POLICY");
        }
        const pseudonymKey = loadKmsKey();
        try {
          return await reportAutoDreamPlatformFindings(getPool(), {
            subjectHash: createHmac("sha256", jwtSecret)
              .update(`auto-dream-platform-finding-user\0${identity.userId}`)
              .digest("hex"),
            agentId,
            runId,
            model: policy.modelId,
            findings: body.findings,
            rawFindings: body.rawFindings,
            trafficClass: await getUserSignalTrafficClass(identity.userId, getPool()),
            pseudonymKey,
          });
        } finally {
          zeroBuffer(pseudonymKey);
        }
      }
      if (path === AUTO_DREAM_OPTIMIZER_ACTION_PATH) {
        const action = requireAutoDreamString(body, "action", /^preference\.patch$/);
        void action;
        return await applyAutoDreamPreferenceAction(getPool(), {
          userId: identity.userId,
          proposalId: requireAutoDreamString(body, "proposalId", /^[0-9a-f]{32}$/),
          targetId: requireAutoDreamString(
            body,
            "targetId",
            /^preferences\.[a-z_]{1,64}$/,
          ),
          beforeFingerprint: requireAutoDreamString(
            body,
            "beforeFingerprint",
            /^[0-9a-f]{64}$/,
          ),
          after:
            typeof body.after === "string" && body.after.length <= 32_000
              ? body.after
              : (() => {
                  throw new Error("AUTO_DREAM_INVALID_AFTER");
                })(),
        });
      }

      const requestId = requireAutoDreamString(body, "requestId", /^[0-9a-f]{32}$/);
      const journal = await getPool().query<{
        user_id: string;
        container_id: string | null;
        ctx: Record<string, unknown> | null;
      }>(
        `SELECT user_id::text,container_id::text,ctx
           FROM request_finalize_journal WHERE request_id=$1`,
        [requestId],
      );
      const journalRow = journal.rows[0];
      if (
        !journalRow ||
        journalRow.user_id !== String(identity.userId) ||
        journalRow.container_id !== String(identity.containerId) ||
        journalRow.ctx?.source !== "auto_dream_optimizer"
      ) {
        throw new Error("AUTO_DREAM_INVALID_JOURNAL_IDENTITY");
      }

      if (path === AUTO_DREAM_OPTIMIZER_SETTLE_PATH) {
        const usage =
          body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
            ? body.usage as Record<string, unknown>
            : {};
        const safe = (value: unknown): number =>
          typeof value === "number" && Number.isFinite(value) && value > 0
            ? Math.trunc(value)
            : 0;
        const status = body.status === "success" ? "success" : "error";
        await settleDurableCodexBilling(
          {
            pgPool: getPool(),
            preCheckRedis,
            pricing,
            logger: rootLogger.child({ subsys: "autoDreamDurableCodexBilling" }),
          },
          userId,
          {
            requestId,
            engineSessionId:
              typeof journalRow.ctx.engineSessionId === "string"
                ? journalRow.ctx.engineSessionId
                : deriveEngineSessionId(`auto-dream:${identity.userId}:${identity.containerId}:main`),
            status,
            durationMs: safe(body.durationMs),
            usage: {
              input_tokens: safe(usage.input_tokens),
              output_tokens: safe(usage.output_tokens),
              reasoning_output_tokens: safe(usage.reasoning_output_tokens),
              cache_read_input_tokens: safe(usage.cache_read_input_tokens),
              cache_creation_input_tokens: safe(usage.cache_creation_input_tokens),
            },
            ...(body.terminalCode === "USER_CANCELLED" || body.terminalCode === "CODEX_ERROR"
              ? { terminalCode: body.terminalCode }
              : {}),
            ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits as any } : {}),
          },
        );
        const live = autoDreamCodexTurns.get(requestId);
        if (live) {
          autoDreamCodexTurns.delete(requestId);
          clearTimeout(live.timeout);
          expireCodexRouteToken(live.routeToken, "auto_dream_billing_settled");
        }
        return { settled: true };
      }
      if (path === AUTO_DREAM_OPTIMIZER_ABANDON_PATH) {
        const live = autoDreamCodexTurns.get(requestId);
        if (live) {
          autoDreamCodexTurns.delete(requestId);
          clearTimeout(live.timeout);
          try {
            await live.finalizer.fail("auto_dream_abandoned", "INTERNAL_ERROR");
          } finally {
            expireCodexRouteToken(live.routeToken, "auto_dream_abandoned");
          }
        } else {
          const { abortInflightJournal } = await import("./billing/proxyBilling.js");
          await abortInflightJournal(
            getPool(),
            requestId,
            "auto_dream_abandoned",
            "INTERNAL_ERROR",
          );
          await releasePreCheck(preCheckRedis, {
            userId: String(identity.userId),
            requestId,
          }).catch(() => {});
        }
        return { abandoned: true };
      }
      throw new Error("AUTO_DREAM_INVALID_PATH");
    },
  };

  // ─── V5 QQ Official Bot ────────────────────────────────────────────────
  // One platform bot is owned by the LeaderBundle.  HTTP binding/internal
  // receivers remain stateless on both slots and write the shared PG tables;
  // only the leader owns Tencent's gateway connection and outbox sends.
  const qqConfig = readQqBotConfig(process.env);
  let qqBotService: QqBotService | undefined;
  if (qqConfig) {
    if (!bridgeSecret) {
      throw new Error("QQ Bot is configured but the container bridge secret is unavailable");
    }
    const qqDispatcher = makeInboundDispatcher({
      pgPool: getPool(),
      resolveContainerEndpoint,
      bridgeSecret,
      resolveModel: async (bindingUserId) => {
        const uid = BigInt(bindingUserId);
        const [prefs, authz] = await Promise.all([
          getPreferences(uid),
          loadUserModelAuthz(uid),
        ]);
        return pickWechatInboundModel({
          preferredModel: prefs.prefs.default_model,
          visibleModels: pricing.listForUser(authz),
          canUseModel: (modelId) => canUseModel({ pricing }, { ...authz, modelId }),
          allowedModels: ALLOWED_INBOUND_MODELS,
        });
      },
      prepareCodexTurn: prepareWechatCodexTurn,
      failCodexTurn: failWechatCodexTurn,
      upsertMasterClientSession,
      softDeleteMasterSession: async (sessionId, userId) => {
        await softDeleteMasterSession(sessionId, userId);
      },
      transport: makeNodeHttpContainerTransport(),
      channel: qqInboundChannelProfile(),
    });
    const resolveQqOutboundMedia =
      userMediaResolver
        ? makeQqOutboundMediaResolver({
            resolveUserMediaDirs: userMediaResolver,
            pullRemoteHostMedia: async (args) => {
              const target = await resolveServiceableHostTarget(args.hostUuid);
              try {
                return await nodeAgentGetFile(target, args.remotePath);
              } finally {
                target.psk?.fill(0);
              }
            },
          })
        : undefined;
    qqBotService = makeQqBotService({
      pool: getPool(),
      config: qqConfig,
      dispatcher: qqDispatcher,
      prepareMedia:
        userMediaResolver && ensureContainerEndpointReady
          ? makeSaveQqMediaToUserUploads({
              ensureContainerReady: ensureContainerEndpointReady,
              resolveUserMediaDirs: userMediaResolver,
              pushRemoteHostUpload,
            })
          : undefined,
      resolveOutboundMedia: resolveQqOutboundMedia,
      handleModelCommand: async (bindingUserId, text) => {
        const uid = BigInt(bindingUserId);
        const [prefs, authz] = await Promise.all([
          getPreferences(uid),
          loadUserModelAuthz(uid),
        ]);
        return await handleWechatModelCommand({
          text,
          channelName: "QQ",
          preferredModel: prefs.prefs.default_model,
          visibleModels: pricing.listForUser(authz),
          canUseModel: (modelId) =>
            canUseModel({ pricing }, { ...authz, modelId }),
          allowedModels: ALLOWED_INBOUND_MODELS,
          setDefaultModel: async (modelId) => {
            await patchPreferences(uid, { default_model: modelId });
          },
        });
      },
    });
    const qqIdentityRepo = createPgIdentityRepo();
    qqOutboundRef.current = makeQqOutboundReceiver({
      pool: getPool(),
      identityRepo: qqIdentityRepo,
      handleCodexBilling: handleWechatCodexBilling,
      onQueued: () => qqBotService?.kickOutbox(),
    });
    qqProactiveRef.current = makeQqProactiveReceiver({
      pool: getPool(),
      identityRepo: qqIdentityRepo,
      onQueued: () => qqBotService?.kickOutbox(),
    });
    leaderBundle.add({
      name: "qqBot",
      domain: "shared",
      start: async () => {
        await qqBotService!.start();
        return { stop: () => qqBotService!.stop() };
      },
    });
  }

  // ─── P1.7 slice 7c — WeChat broker 装配 ───────────────────────────────────
  //
  // 装配条件:WECHAT_BROKER_ENABLED=1 + bridgeSecret 已加载(对称要求 — broker 给
  // container 发 inbound 时 HMAC 来自这个 root secret)。两者任一缺失 →
  // broker 全程 disabled,wechatBrokerRef.current 保持 null,
  // /internal/v3/wechat-outbound 永远 404、外部 onInbound 也未暴露。
  //
  // 装配后:broker 自带 brokerEnabled() 短路;但本侧已经 gate 过整个装配链
  // (没装就没 onInbound 也没 outboundHandler),所以 callback 直接 () => true。
  // 这样后续若加 ConfigService 热重载,把 callback 换成 ConfigService.get 即可,
  // 不动 broker.ts。
  let wechatBroker: WechatBroker | undefined;
  // controlPlaneEnabled 纳入:broker 启动 outbox worker/reconcile/housekeeping(写 wechat_outbox /
  // soft-delete session / 发 iLink)属共享-state mutator,v5 follower 必须静默。
  // 【P3 MINOR 3 收口债】wechatBroker 目前以 controlPlaneEnabled 静态 gate + eager start(未纳入
  // LeaderBundle),且 v5 下被 follower 硬 block(WECHAT_BROKER_ENABLED=1 是禁忌项,见文首 v5 env
  // 守卫)——即 v5 当前根本不跑 broker,故无双 master 双跑面。**未来若为 v5 解除该 legacy gate
  // 让 broker 在 v5 上线,它是 shared-domain 单跑 mutator,必须同步纳入 LeaderBundle(add 成 member,
  // 交给 lease 单 leader 启停),绝不能沿用这套静态 eager gate**,否则双 master 会双发 iLink / 双写 outbox。
  if (controlPlaneEnabled && cfg.WECHAT_BROKER_ENABLED && bridgeSecret) {
    // ─ 依赖装配(自下而上):transport → dispatcher → outboundReceiver →
    //   sendText → broker
    const wechatLog = rootLogger.child({ subsys: "wechatBrokerAssembly" });
    const containerTransport = makeNodeHttpContainerTransport();
    const ilinkSendText = makeIlinkSendAdapter();
    const ilinkSendMedia = makeIlinkSendMediaAdapter();
    const resolveWechatOutboundMedia =
      userMediaResolver
        ? makeWechatOutboundMediaResolver({
            resolveUserMediaDirs: userMediaResolver,
            pullRemoteHostMedia: async (args) => {
              // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒。
              const target = await resolveServiceableHostTarget(args.hostUuid);
              try {
                return await nodeAgentGetFile(target, args.remotePath);
              } finally {
                target.psk?.fill(0);
              }
            },
          })
        : undefined;

    const inboundDispatcher = makeInboundDispatcher({
      pgPool: getPool(),
      resolveContainerEndpoint,
      bridgeSecret,
      resolveModel: async (bindingUserId) => {
        const uid = BigInt(bindingUserId);
        const [prefs, authz] = await Promise.all([
          getPreferences(uid),
          loadUserModelAuthz(uid),
        ]);

        return pickWechatInboundModel({
          preferredModel: prefs.prefs.default_model,
          visibleModels: pricing.listForUser(authz),
          canUseModel: (modelId) =>
            canUseModel({ pricing }, { ...authz, modelId }),
          allowedModels: ALLOWED_INBOUND_MODELS,
        });
      },
      prepareCodexTurn: prepareWechatCodexTurn,
      failCodexTurn: failWechatCodexTurn,
      // dispatcher Step 2a / 2b — 走 storage helper 写 master sqlite client_sessions。
      upsertMasterClientSession,
      // dispatcher Step 2b 失败 + broker reconcile 共用同一个 soft-delete
      // (返 boolean,broker.softDeleteMasterSession 期待 Promise<void> — 包一层吞掉返回值)
      softDeleteMasterSession: async (sessionId, userId) => {
        await softDeleteMasterSession(sessionId, userId);
      },
      transport: containerTransport,
    });

    const identityRepo = createPgIdentityRepo();
    const rateLimitRedis = wrapIoredis(redis);
    void rateLimitRedis; // P1 占位:noop limiter;P3 真实滑窗时切回 rateLimitRedis 依赖
    const outboundReceiver = makeOutboundReceiverHandler({
      identityRepo,
      pool: getPool(),
      rateLimiter: createNoopRateLimiter(),
      handleCodexBilling: handleWechatCodexBilling,
    });

    // 主动微信投递接收点 —— 权威解析收件人(senderId = binding.loginUserId),
    // 不接受 body 指定收件人。绑微信默认开(prefs.wechat_proactive_push !== false)。
    wechatProactiveRef.current = makeProactiveReceiverHandler({
      identityRepo,
      pool: getPool(),
      resolveRecipient: async (bindingUserId) => {
        // SQLite wechat_bindings.user_id 是 `c:<digit>`(MASTER_USER_PREFIX),而容器身份
        // bindingUserId 是裸数字 —— 与 outboxWorker.getBinding(MASTER_USER_PREFIX + …) 同源约定。
        // 漏前缀会永远查不到(no_binding),且可能误命中 legacy 裸 id 行破坏 trust boundary。
        const b = await getWechatBindingByUserId(MASTER_USER_PREFIX + bindingUserId);
        if (!b || b.status !== "active" || !b.loginUserId) return null;
        // loginUserId 是 wire 形态(<base64url>@im.wechat),但 contextTokens 的 key 是
        // canonical(剥后缀)。senderId 必须 canonical 才能命中 contextTokens(否则永久
        // no_context_token),且与既有 outbound 路径的 canonical senderId 一致。
        return { senderId: canonicalWechatSenderId(b.loginUserId), contextTokens: b.contextTokens };
      },
      isProactiveEnabled: async (userId) => {
        const snap = await getPreferences(BigInt(userId));
        return snap.prefs.wechat_proactive_push !== false;
      },
      getSessionId: getCurrentSessionId,
    });

    wechatBroker = trackScheduler("wechatBroker", "shared", makeWechatBroker({
      pgPool: getPool(),
      dispatcher: inboundDispatcher,
      outboundReceiver,
      // broker reconcile 一次性读全集 wsess 行,然后内部 diff 出孤儿。
      allMasterWsessRows,
      softDeleteMasterSession: async (sessionId, userId) => {
        await softDeleteMasterSession(sessionId, userId);
      },
      sendText: ilinkSendText,
      sendMedia: ilinkSendMedia,
      resolveOutboundMediaPart: resolveWechatOutboundMedia,
      wechatLiveLinkKey,
      wechatUxCommands: {
        handleModelCommand: async (evt) => {
          const uid = BigInt(evt.bindingUserId);
          const [prefs, authz] = await Promise.all([
            getPreferences(uid),
            loadUserModelAuthz(uid),
          ]);

          return await handleWechatModelCommand({
            text: evt.text,
            preferredModel: prefs.prefs.default_model,
            visibleModels: pricing.listForUser(authz),
            canUseModel: (modelId) =>
              canUseModel({ pricing }, { ...authz, modelId }),
            allowedModels: ALLOWED_INBOUND_MODELS,
            setDefaultModel: async (modelId) => {
              await patchPreferences(uid, { default_model: modelId });
            },
          });
        },
      },
      wechatProcessVisibility: {
        getShowToolCalls: async (bindingUserId) => {
          const snap = await getPreferences(BigInt(bindingUserId));
          return snap.prefs.wechat_show_tool_calls !== false;
        },
        setShowToolCalls: async (bindingUserId, show) => {
          await patchPreferences(BigInt(bindingUserId), {
            wechat_show_tool_calls: show,
          });
        },
      },
      saveWechatMedia: userMediaResolver
        ? makeSaveWechatMediaToUserUploads({
            resolveUserMediaDirs: userMediaResolver,
            pushRemoteHostUpload,
          })
        : undefined,
      // 读 master sqlite wechat_bindings 拿 botToken + contextTokens 给 outboxWorker。
      // 失败 / 不存在 → 返 null,worker 该 row 走 permanent(无可恢复 token)。
      getBinding: async (bindingUserId) => {
        const b = await getWechatBindingByUserId(bindingUserId);
        if (!b) return null;
        return { botToken: b.botToken, contextTokens: b.contextTokens };
      },
      brokerEnabled: () => true, // 装配链已 gate 过整体开关
    }));
    wechatBroker.start();
    wechatBrokerRef.current = wechatBroker;
    wechatLog.info("wechat_broker_assembled");
    // eslint-disable-next-line no-console
    console.log("[commercial] wechat broker assembled + started");
  } else {
    // eslint-disable-next-line no-console
    if (cfg.WECHAT_BROKER_ENABLED && !bridgeSecret) {
      console.warn(
        "[commercial] WECHAT_BROKER_ENABLED=1 but bridgeSecret missing; broker NOT assembled",
      );
    } else {
      console.log("[commercial] wechat broker disabled (WECHAT_BROKER_ENABLED!=1)");
    }
  }

  // V3 2I-2:把 buffered_bytes / session_duration 接到 prometheus histogram。
  // 单帧 / per-uid 字节数不进 metrics —— 标签基数太大。
  const bridgeMetrics: BridgeMetricSink = {
    onBufferedBytes: (_uid, side, bytes) => observeWsBridgeBuffered(side, bytes),
    onClose: (stats) => observeWsBridgeSessionDuration(stats.cause, stats.durationMs / 1000),
    onTtft: (_uid, kind, seconds) => observeWsBridgeTtft(kind, seconds),
  };
  // PR1:bridge 拿到 client→container 帧时刷 last_ws_activity(60s debounce)。
  // 防 idle sweep 把"长 WS 单连但持续在用"的会话误判为 idle。fire-and-forget 包到
  // 闭包里;markV3ContainerActivity 自身已 swallow 异常。无 v3Deps(单测 / mock)
  // → 不注入,bridge 退化为 PR1 之前的行为(只 ensureRunning 刷一次)。
  const markActivityForBridge = v3Deps
    ? (cid: number) => { void markV3ContainerActivity(v3Deps!, cid); }
    : undefined;

  // plan v3 G5/G7 → M2 复活 — codex 容器绑定 / per-account 并发槽 handle。
  // 恢复源 = P1f^ 同段(byte-parity 除注释);SQL 带 runtime_channel(P1d 加固,
  // 0098 起为 v5/v3 账号池权威分界)。要点:
  //   - acquire:tx 内 FOR UPDATE 锁 agent_containers 行 → active 账号直取 /
  //     legacy NULL 判 stale recycle(池非空)或透传 / 非 active 走 lazy migrate
  //       * 非 active(disabled / quarantined)→ pickCodexAccountForBindingInTx 重选 →
  //         getCodexTokenSnapshot → writeCodexContainerAuthFile 原子写 → UPDATE
  //         codex_account_id;tx 提交后再 acquireCodexSlot(失败 → bridge fast-fail,
  //         migrate 已落盘永久不回滚:下次重连 active 路径直接走 happy 分支)
  //   - acquireCodexSlot 在 tx **外**调,避免 commit 失败造成的 in-process slot 永久泄漏:
  //     已经持有 slot 但 UPDATE 回滚 → 调用方拿到错误 → bridge.acquiredCodexAccountId
  //     未被赋值 → cleanup() 与 G6 timer 都不知道哪个 account 该 release → 永久泄漏。
  //   - release(account_id, slotId):按 slotId 精确还槽,幂等。
  //   - v3Deps 未注入(测试 / 早期 boot 路径)→ codexBinding=undefined,bridge 退化为不做并发管控
  // 闭包外 capture v3Deps 给 stale recycle fire-and-forget 路径用(必须非空)。
  const v3DepsForCodex = v3Deps;
  const codexBinding: CodexBindingHandle | undefined = v3Deps
    ? {
        async acquire(containerId: number, groupId?: string | null) {
          // tx 内做"锁 + 查 + 可能 lazy migrate / stale recycle";acquire slot / 容器 rm 在 tx 外
          type AcquireResult =
            | { kind: "active"; account_id: bigint }
            | { kind: "stale"; containerInternalId: string | null; hostUuid: string | null }
            | null;
          const desiredGroupId = groupId ?? null;
          const result: AcquireResult = await tx<AcquireResult>(async (client) => {
            const lookup = await client.query<{
              account_id: string | null;
              account_status: string | null;
              account_group_id: string | null;
              state: string;
              container_internal_id: string | null;
              host_uuid: string | null;
              age_seconds: string;
            }>(
              `SELECT ac.codex_account_id::text AS account_id,
                      ca.status AS account_status,
                      ca.group_id::text AS account_group_id,
                      ac.state AS state,
                      ac.container_internal_id AS container_internal_id,
                      ac.host_uuid AS host_uuid,
                      EXTRACT(EPOCH FROM (NOW() - ac.created_at))::text AS age_seconds
               FROM agent_containers ac
               LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
               WHERE ac.id = $1 AND ac.runtime_channel = $2
               FOR UPDATE OF ac`,
              [containerId, getRuntimeChannel()],
            );
            if (lookup.rows.length === 0) {
              // 容器在 acquire 前刚被删了 — 当 legacy 透传(下游 sendToContainer 必失败,
              // 错误从那条路径返回给前端,与本桥状态一致)
              return null;
            }
            const row = lookup.rows[0];
            if (row.state !== "active") {
              // 容器已不再 active(stopped / vanished / removed) — 当 legacy 透传,
              // 让下游 sendToContainer 路径产出标准错误,不在 acquire 这层造一种新的错。
              return null;
            }
            if (row.account_id === null) {
              // legacy NULL 绑定。检查池子里是否有 active codex 账号:
              //   - 没有 → 真 legacy 路径不变,return null(N3 行为兼容)
              //   - 有   → 用户 admin 已加账号但容器 mount immutable 永远 401,
              //            必须 mark vanished + docker rm 让 ensureRunning 重 provision
              //            重新走 picker 路径产出 per-container mount。
              // 池子查询条件必须与 pickCodexAccountForBinding 完全一致(provider='codex'
              // AND status='active'),否则可能误判为"有账号"但 picker 实际拿不到。
              // 0098+:池按 Codex account-pool channel 划分权威,只数 picker 同口径账号行。
              const poolParams: unknown[] = [getCodexAccountRuntimeChannel()];
              const poolWhere = ["provider = 'codex'", "status = 'active'", "runtime_channel = $1"];
              if (desiredGroupId !== null) {
                poolParams.push(desiredGroupId);
                poolWhere.push(`group_id = $${poolParams.length}`);
              }
              const poolCount = await client.query<{ cnt: string }>(
                `SELECT count(*)::text AS cnt
                   FROM claude_accounts
                  WHERE ${poolWhere.join(" AND ")}`,
                poolParams,
              );
              if (Number(poolCount.rows[0]?.cnt ?? "0") === 0) {
                return null;
              }
              // **死循环守护(v1.0.72 Codex review High#1)**:
              // 远端 host 的 putRemoteCodexAuth 短暂故障(node-agent 抖 / fingerprint
              // 错配 / cert 失效)→ provisionV3Container 写 codex auth 失败 → no-mount
              // + codex_account_id NULL → 下次 acquire 看池非空 → 又 recycle → 又重 provision
              // → 又失败 → 死循环烧资源。本地 host 也存在同 case(picker 抛 / write fail),
              // 只是远端故障频率高。
              //
              // 守护:row 才创建 < 60s 又被 stale recycle = 强信号上一轮 provision codex
              // 绑定失败,**这一轮不再 recycle**,return null 走 legacy 透传(N3 行为)。
              // 用户 GPT 请求会失败但容器照常用,不会陷入重建循环。运维通过监控 NULL
              // bind 容器数 + 日志告警感知后,修复 host 后下一轮自然 recycle 自愈
              // (60s 后行不再"年轻")。
              const ageSec = Number(row.age_seconds ?? "0");
              if (Number.isFinite(ageSec) && ageSec < 60) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[codex acquire] skip stale recycle: row too young (likely upstream codex bind failed last provision)",
                  { containerId, ageSec, hostUuid: row.host_uuid },
                );
                return null;
              }
              // 池子非空 — recycle。同 tx 内把 row 标 vanished,与下面 lazy migrate
              // 的 UPDATE 同 commit,避免并发 acquirer 看到 state='active' 走错路径。
              // WHERE state='active' guard 防 race:并发 acquirer/admin/idleSweep
              // 已经把 state 改了的话本 UPDATE rowCount=0。FOR UPDATE OF ac 已锁住
              // 本 row,同 tx 内应永远 rowCount=1;rowCount=0 = 不变量破坏,throw
              // 抬出问题而不是静默 return null(旧容器仍会 401,只是把问题往后挪)。
              const upd = await client.query(
                `UPDATE agent_containers
                    SET state = 'vanished', updated_at = NOW()
                  WHERE id = $1 AND state = 'active' AND runtime_channel = $2`,
                [containerId, getRuntimeChannel()],
              );
              if ((upd.rowCount ?? 0) === 0) {
                throw new Error(
                  `codex stale recycle: UPDATE state=vanished rowCount=0 for container ${containerId} (invariant: FOR UPDATE row was active)`,
                );
              }
              return {
                kind: "stale",
                containerInternalId: row.container_internal_id,
                hostUuid: row.host_uuid,
              };
            }
            if (row.account_status === "active" && (desiredGroupId === null || row.account_group_id === desiredGroupId)) {
              return { kind: "active", account_id: BigInt(row.account_id) };
            }
            // disabled / quarantined / 任意非 active → lazy migrate
            //
            // v1.0.120 feat/codex-disable-rebind:"pick + snapshot + write + UPDATE"
            // 走 codexLazyMigrate 模块,与 M1(internalCodexTokenRefresh in-turn 自愈)
            // + M2(codexDisableFanout 后台 actor)共享同一组 helper。
            //
            // acquire 走**强一致**(tx 内 pick + write + UPDATE 一同 COMMIT):
            //   - acquire 是用户 inbound 触发,单容器单流,持锁 IO 开销可接受
            //   - 写失败 → tx ROLLBACK → row 仍指 disabled 账号 → 下次 inbound 再
            //     acquire 重试(孤儿 auth.json 由 stop/remove、volume gc、重 provision
            //     覆盖兜底)
            const picked = await pickCodexAccountForBindingInTx(client, String(containerId), { groupId: desiredGroupId });
            if (!picked) {
              throw new Error(
                `codex pool empty during lazy migrate for container ${containerId}`,
              );
            }
            const codexContainerDir =
              process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
            // v1.0.72 host 路由由 helper 内部决定(selfHostId / host_uuid / putRemote
            // 三选一,见 codexLazyMigrate.fetchSnapshotAndWriteContainerAuth);
            // 远端 helper 未注入抛错 → tx ROLLBACK,与之前行为一致。
            const writeAuthDeps: WriteAuthDeps = {
              selfHostId: v3DepsForCodex?.selfHostId ?? null,
              containerUid: V3_AGENT_UID,
              containerGid: V3_AGENT_GID,
              codexContainerDir,
              putRemoteCodexAuth: v3DepsForCodex?.putRemoteCodexAuth,
            };
            // 用 client 传入 helper → 走 in-tx snapshot,**不**申请第二个 PG client
            // (避免 burst 时撑大 pool 占用)。
            await fetchSnapshotAndWriteContainerAuth({
              accountId: picked.account_id,
              containerId,
              hostUuidUnderLock: row.host_uuid,
              deps: writeAuthDeps,
              client,
            });
            // FOR UPDATE 持锁内 UPDATE,COMMIT 时一同落盘。失败 → tx 抛出 → ROLLBACK
            await commitCodexRebindInTx(client, containerId, picked.account_id);
            return { kind: "active", account_id: picked.account_id };
          });
          if (result === null) return null;
          if (result.kind === "stale") {
            // tx 已 commit:row.state 已落 vanished。**必须 await** 把 docker 实体清掉
            // 再返错,否则容器名是 per-uid 固定,旧实体没 rm 时下条 message 触发
            // ensureRunning 会撞 docker NameConflict 被卡几秒重试,体验上不"自愈"。
            // await 失败也 throw stale(下次 ensureRunning 仍会自己 try stop/remove
            // 旧名字兜底,与 orphanReconcile 路径一致),日志留 warn 便于诊断。
            try {
              await stopAndRemoveV3Container(v3DepsForCodex!, {
                id: containerId,
                container_internal_id: result.containerInternalId,
                host_uuid: result.hostUuid,
              });
            } catch (err) {
              rootLogger.warn(
                "[commercial] codex stale recycle: stopAndRemoveV3Container failed (continuing — ensureRunning will retry on next message)",
                {
                  containerId,
                  err: (err as Error)?.message ?? String(err),
                },
              );
            }
            throw new ContainerStaleBindingError(containerId);
          }
          // tx 已 commit;现在尝试占 in-process per-account slot。Busy → 抛 AccountPoolBusyError
          // (bridge 转 CODEX_POOL_BUSY)。lazy migrate 已落盘不会回滚,Busy 只影响本 turn。
          const slotId = scheduler.acquireCodexSlot(result.account_id);
          return { account_id: result.account_id, slotId };
        },
        release(account_id: bigint, slotId: string): void {
          try { scheduler.releaseCodexSlot(account_id, slotId); } catch { /* */ }
        },
        renew(account_id: bigint, slotId: string): boolean {
          try { return scheduler.renewCodexSlot(account_id, slotId); } catch { return false; }
        },
      }
    : undefined;

  /**
   * 容器不支持 model authority attestation(旧 release / 旧 env)→ 销毁它。
   *
   * 复用既有的 codex stale recycle 范式:DB 翻 vanished + docker 清实体,用户下一条
   * 消息触发 ensureRunning 重新 provision(此时 supervisor 会注入 keyring env)。
   * best-effort:清不干净也无妨 —— ensureRunning 会撞名字冲突后自己重试清理(与
   * orphanReconcile 路径一致)。
   */
  const recycleUnattestedContainer = (containerId: number, reason: string): void => {
    if (!v3Deps) return;
    const depsForRecycle = v3Deps;
    void (async () => {
      try {
        const { rows } = await getPool().query<{
          id: number;
          container_internal_id: string | null;
          host_uuid: string | null;
        }>(
          // lint-agent-containers-sql: allow — 回收路径必须能看到任意 state 的行,
          // 目的就是把它 stop+remove;行只喂 stopAndRemoveV3Container,
          // 不进任何用户可见视图 / 计费聚合。
          "SELECT id, container_internal_id, host_uuid FROM agent_containers WHERE id = $1",
          [containerId],
        );
        const row = rows[0];
        if (!row) return;
        await stopAndRemoveV3Container(depsForRecycle, row);
        rootLogger.warn("[commercial] recycled container without model-authority attestation", {
          containerId,
          reason,
        });
      } catch (err) {
        rootLogger.error("[commercial] model-authority recycle failed", {
          containerId,
          reason,
          err: (err as Error)?.message ?? String(err),
        });
      }
    })();
  };

  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    jwtSecret,
    promptQueueEnabled: isPromptQueueV1Enabled(),
    resolveContainerEndpoint,
    // 模型执行权威(方案 §2):注入即开启 flag —— 签发 + attestation 门 + descriptor 分类。
    ...(modelAuthoritySigner && modelCatalogCache
      ? {
          modelAuthority: {
            signer: modelAuthoritySigner,
            catalog: modelCatalogCache,
            recycleContainer: recycleUnattestedContainer,
          },
        }
      : {}),
    metrics: bridgeMetrics,
    markContainerActivity: markActivityForBridge,
    // 每用户并发 /ws/chat 上限。缺省不传 → bridge 内 DEFAULT_MAX_PER_USER(3)。
    // OC_WS_MAX_PER_USER 覆盖:自用实例多设备/多标签并发常超 3,超限时 registry
    // 踢最老 → 被踢端 1s 重连再踢别人,形成互踢循环(2026-08-17 排障实录)。
    ...(Number(process.env.OC_WS_MAX_PER_USER) > 0
      ? { maxPerUser: Number(process.env.OC_WS_MAX_PER_USER) }
      : {}),
    // 版本握手:cli launcher 注入 dist 目录(spa 才有)→ probe 读 index.html 的
    // oc-build meta;v3/测试 undefined → bridge 不发 sys.frontend_build,零变化。
    getFrontendBuildId: options.webDistDir
      ? createFrontendBuildProbe(options.webDistDir)
      : undefined,
    // 跨 host 容器:bridge 用 node-agent tunnel 拉容器 WS(direct dial 必然 EHOSTUNREACH)。
    // 工厂内部走 mTLS+pin 预拨 + ws.createConnection hijack;maxFrameBytes 与 bridge 默认对齐
    // (factory 内会用同一上限;不显式传则 ws 默认无限,有 OOM 风险)。
    createTunnelContainerSocket: (tunnel, port, signal, connectionTraceId) =>
      createTunnelContainerSocket(tunnel.nodeAgent, tunnel.containerInternalId, port, signal, {
        maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
        // S12e CG4:bridge connId(server-side randomUUID)透传到 outgoing tunnel WS
        // upgrade 的 `X-Connection-Trace-Id` header,与 node-agent / in-container gateway
        // 共用同一 connection-scoped trace。
        connectionTraceId,
      }),
    // 注入 logger,让 bridge 把 4503 reason / container error 等关键路径日志写出来。
    // 不传则静默 noop,生产排错时全部不可见(原版 commit 漏了)。
    logger: rootLogger.child({ subsys: "commercial", module: "userChatBridge" }),
    // 模型授权 checker。模型权威开启后 role+grants 与 catalog visibility 必须绑定同一
    // fenced epoch：不信握手 JWT 的旧 role，也不回读可能 reload 失败的 PricingCache。
    loadAllowedModelChecker: async (uid, requiredEpoch) => {
      if (modelCatalogCache) {
        const snapshot = await modelCatalogCache.assertFresh();
        if (requiredEpoch !== undefined && snapshot.securityEpoch < requiredEpoch) {
          throw new Error(
            `catalog snapshot epoch ${snapshot.securityEpoch} < required ${requiredEpoch}`,
          );
        }
        const authz = await loadUserModelAuthz(uid, snapshot.securityEpoch);
        return (modelId: string) => snapshot.canUseModel({
          uid: uid.toString(),
          role: authz.role,
          grantedModelIds: authz.grantedModelIds,
          deniedModelIds: authz.deniedModelIds,
          userPlanTier: authz.userPlanTier ?? null,
          orgPlanCode: authz.orgPlanCode ?? null,
        }, modelId);
      }
      // cutover 前 legacy 路径仍从 DB loader 取 role+grants，不再信 JWT role。
      const { canUseModel } = await import("./billing/authzModels.js");
      const authz = await loadUserModelAuthz(uid);
      return (modelId: string) =>
        canUseModel({ pricing }, { ...authz, modelId });
    },
    // P0 计费旁路封堵 —— bridge 可信模型推导的 agent 权威(seed 声明 / 常量 +
    // marketplace 预设/已装 manifest,详见 ws/agentModelAuthority.ts 头注)。
    // bridge 用它推导「帧无 model 时该 agentId 的有效模型」参与 codex 分类
    // (与容器 resolveEngine 同构),推导不出且帧无 model → fail-closed 拒帧。
    //
    // 模型权威批次 §5 阶段 B(flag OC_SEED_AUTHORITY_BY_REV=1):bridge 在 ensureRunning
    // 之后把容器 label 上的 bundleRev 传进来 → seed 层按**该 rev 的 platform-seed 声明**
    // 推导(bundle 全量校验复用 resolvePlatformBundleMount)。rev 缺失 / bundle 坏 →
    // 抛 SeedDeclarationError → bridge close(1011) fail-closed,绝不回落 master 常量。
    // flag 未设 → opts.bundleRev 被忽略,走旧的 master 常量路径(零行为变化)。
    loadAgentModelResolver: async (uid, opts) => {
      const { loadAgentModelResolverForUser } = await import("./ws/agentModelAuthority.js");
      return loadAgentModelResolverForUser(uid, {
        bundleRev: opts.bundleRev ?? null,
        // 与 supervisor / bundle 校验器同一稳定根(见上方 runtimeTuple 装配)。
        platformRoot: cfg.OC_PLATFORM_ROOT ?? DEFAULT_PLATFORM_ROOT,
      });
    },
    // 引擎历史只读真实 Tape 的有限模型窗口 sidecar。浏览器历史不受该窗口影响；当前
    // prompt/引擎/上下文窗口均由 bridge 的可信 catalog snapshot 传入，避免回退到全量
    // BYTEA 全量水合后再做固定行数/字符数截断。
    loadMasterSessionMessages: async (uid, sessionId, context) =>
      getEngineContextMessages(
        sessionId,
        MASTER_USER_PREFIX + uid.toString(),
        context,
      ),
    hasCompletedClientTurn: async (uid, sessionId, clientMessageId) =>
      hasCompletedClientTurn(
        sessionId,
        MASTER_USER_PREFIX + uid.toString(),
        clientMessageId,
      ),
    loadGoalState: (uid, sessionId) => goalStateService.get(uid, sessionId),
    updateGoalEngineMetrics: (args) => goalStateService.updateEngineMetrics(args),
    persistMasterUserMessage: async (uid, sessionId, message) =>
      appendServerAuthoredMessage(
        sessionId,
        MASTER_USER_PREFIX + uid.toString(),
        message,
      ),
    persistOutboundFrame: (input) => persistGatewayLiveFrame(getPool(), input),
    // durable turn dispatch 受理面(RFC §2.1):容器 attest durable-turn-dispatch-v1 时
    // 替代 persistMasterUserMessage(单事务 append + dispatch 冲突表)。未装 backend → undefined → legacy。
    admitUserTurn: dispatchAdmissionBackend
      ? (input) => dispatchAdmissionBackend!.admitUserTurn(input)
      : undefined,
    reconcileAutomaticRecoveryJobs: dispatchAdmissionBackend
      ? (uid, limit) => dispatchAdmissionBackend!.reconcileAutomaticRecoveryJobs(uid, limit)
      : undefined,
    loadSessionWorkspaceMode: dispatchAdmissionBackend
      ? (uid, sessionId) => dispatchAdmissionBackend!.getClientSessionWorkspaceMode(
          sessionId,
          MASTER_USER_PREFIX + uid.toString(),
        )
      : undefined,
    // plan v3 G5/G7 → M2 — codex per-account 并发槽 / lazy migrate / 严格单飞 handle。
    // v3Deps 未注入(测试 mock)→ undefined,bridge 退化为透传不做并发管控(测试默认行为)。
    codexBinding,
    createCodexRoute: createCommercialCodexRoute,
    expireCodexRoute: async (token) => {
      await Promise.all([expireCodexRouteContext(token), expireGrokRouteContext(token)]);
    },
    releaseGrokRouteLease: async (accountId, slotId) => {
      // Expire durable authority before freeing the local mirror. If PG is
      // unavailable the slot remains occupied and the immutable terminal frame
      // can retry without admitting an over-cap turn.
      await expireGrokRouteContextByLease(accountId, slotId);
      scheduler.releaseCodexSlot(accountId, slotId);
    },
    // PR2 v1.0.66 → M2 — codex 真扣费三件套(pgPool / preCheckRedis / pricing 进程级
    //   singleton):bridge 内 preCheckWithCost / startInflightJournal,settle 收口
    //   codexFinalizer(双钱包 / 零输出免单 / account_id NULL / engineSessionId 记账)。
    //   createUserChatBridge entry 已强校验"三件套全有或全无"+"codexBinding 蕴含
    //   三件套",partial 注入会 throw,防生产配错让 codex 免费。
    pgPool: getPool(),
    preCheckRedis,
    pricing,
    selfHostId: selfHostUuid ?? null,
    // Plan §4.2 改动 4a — codex billing commit 路径同样把 debit 持久化进
    // master's `client_sessions.messages[i].usage.costCredits`。与 anthropicProxy
    // 走同一个 storage helper,签名一致。
    appendCostCredits: appendCostCreditsForUser, // c:<uid> 前缀对齐 session 存储命名空间
  });
  // 把 proxy 的 forward-ref 指向真实 broadcastToUser —— 此刻以后,commit 成功
  // 扣费事件会实时推到用户前端。
  bridgeBroadcastRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };
  goalBroadcastRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };
  goalSyncRef.current = (uid, payload) => {
    userChatBridge.syncGoalToContainers(uid, payload);
  };
  slotRelayLocalRef.current = {
    onlineUserSubset: (uids) => userChatBridge.onlineUserSubset(uids),
    broadcastToUsers: (uids, payload) => userChatBridge.broadcastToUsers(uids, payload),
  };

  // Browser voice input: MediaRecorder → master WS → Deepgram Nova-3 streaming,
  // then one-shot DeepSeek V4 Flash context polish after stop.
  // Master-only commercial path: no runtime image rebuild required.
  const voiceTranscribeHandler: VoiceTranscribeHandler = createVoiceTranscribeHandler({
    jwtSecret,
    deepgramApiKey: cfg.DEEPGRAM_API_KEY,
    deepseekApiKey: cfg.DEEPSEEK_API_KEY,
    asrModel: cfg.VOICE_ASR_MODEL,
    asrLanguage: cfg.VOICE_ASR_LANGUAGE,
    voicePolishModel: cfg.VOICE_POLISH_MODEL,
    maxSeconds: cfg.VOICE_MAX_SECONDS,
    maxPerUser: cfg.VOICE_MAX_PER_USER,
    maxGlobal: cfg.VOICE_MAX_GLOBAL,
    logger: rootLogger.child({ subsys: "commercial", module: "voiceTranscribe" }),
  });

  // T-62 告警调度器 —— 默认 60s tick,不在启动时立刻跑(避免冷启动误报)。P3:收口 LeaderBundle。
  if (process.env.COMMERCIAL_ALERTS_DISABLED !== "1") {
    leaderBundle.add({
      name: "alert",
      domain: "shared",
      start: () => {
        // 非法 / 空 / NaN → 60s;下限 1s(防 typo 写成 "50" ms 把 DB 打穿)
        const raw = Number(process.env.COMMERCIAL_ALERT_TICK_MS);
        const tickMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
        const h = trackScheduler("alert", "shared", startAlertScheduler({ intervalMs: tickMs, runOnStart: false }));
        return { stop: () => h.stop() };
      },
    });
  }

  // M6/P1-9 — account_refresh_events 28 天 retention sweeper(24h interval,unref)。P3:收口 LeaderBundle。
  if (process.env.COMMERCIAL_REFRESH_EVENTS_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "refreshEventsSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("refreshEventsSweep", "shared", startRefreshEventsSweeper());
        return { stop: () => h.stop() };
      },
    });
  }

  // 审计体系整改批 — 审计/事件表统一 retention sweeper(boot 立即异步跑一轮,随后 24h tick)。
  // V5 经常因正常发版重启；若只从每次启动重新计满 24h，refresh_tokens 等已登记
  // retention 的死行会永久饥饿。runOnStart 不阻塞 gateway 启动，单表失败仍由 sweeper 隔离。
  // 政策注册表=admin/auditRetention.ts(security_events 180d/agent_audit 90d/
  // compute_host_audit 90d/turn_traces 90d/rate_limit_events 30d;admin_audit 显式
  // 永久,不允许出现在删除政策)。shared 域:删的是共享审计表,仅 leader 运行。
  if (process.env.COMMERCIAL_AUDIT_RETENTION_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "auditRetentionSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("auditRetentionSweep", "shared", startAuditRetentionSweeper({ runOnStart: true }));
        return { stop: () => h.stop() };
      },
    });
  }

  // Image journey recovery is operational state, not request-triggered
  // cleanup: one-shot users may never make another image call. The V5 leader
  // finalizes stale journeys/attempts globally in bounded batches.
  if (
    runtimeChannel === "v5" &&
    process.env.COMMERCIAL_IMAGE_USAGE_SWEEP_DISABLED !== "1"
  ) {
    leaderBundle.add({
      name: "imageUsageSweep",
      domain: "v5-owned",
      start: () => {
        const h = trackScheduler("imageUsageSweep", "v5-owned", startImageUsageSweeper({
          pool: getPool(),
          onError: (error) => rootLogger.warn("image usage sweep failed", {
            errorClass: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          }),
        }));
        return { stop: () => h.stop() };
      },
    });
  }

  // plan G2/G4 — codex token refresh actor(单进程独占,60s tick,unref)。
  // 扫 codex 账号 → 提前 15min refresh → 持锁逐容器写 per-container auth.json。
  // 永不写 master 文件 / legacy 共享 dir。详见 codexAccountActor.ts 头注。
  //
  // 【域归属 v5-owned(channel-scoped)】0098 起 codex 账号池权威按 runtime_channel
  // 划分:actor 只刷 runtime_channel=本 channel 的 claude_accounts 行、只写同 channel
  // 的容器 auth。沿旧 controlPlaneEnabled gate 会让 v5 的 codex 账号 token 无人续期
  // (v3 leader 只刷 v3 行)→ 池子静默烂掉;故 channel=v5 必须自己跑。
  // 单账号单刷新权威由 channel 列保证(v3/v5 各只见自己的行),无双刷 family 吊销风险。
  let codexRefreshActor: CodexRefreshActorHandle | undefined;
  if (
    (controlPlaneEnabled || runtimeChannel === "v5") &&
    process.env.COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED !== "1"
  ) {
    const codexContainerDir =
      process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
    // v1.0.72 多机:把 v3Deps 上的 putRemoteCodexAuth helper(已含
    // getHostById → hostRowToTarget → finally psk.fill(0) 三件套)透传给 actor,
    // actor 自己不持密钥 buffer,泄密面与 lazy migrate / provision 完全一致。
    codexRefreshActor = trackScheduler("codexRefresh", "v5-owned", startCodexRefreshActor({
      codexContainerDir,
      containerUid: V3_AGENT_UID,
      containerGid: V3_AGENT_GID,
      selfHostId: v3Deps?.selfHostId ?? null,
      writeRemoteFn: v3Deps?.putRemoteCodexAuth,
    }));
  }

  // 账号池 cooldown 半开恢复 actor —— 周期扫 cooldown_until 已过期的账号 → active。
  // 默认 5min tick(下限 1s 防 typo)。
  // 关闭:`COMMERCIAL_COOLDOWN_RECOVERY_DISABLED=1`(测试 / 应急)。
  if (process.env.COMMERCIAL_COOLDOWN_RECOVERY_DISABLED !== "1") {
    leaderBundle.add({
      name: "cooldownRecovery",
      domain: "shared",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_COOLDOWN_RECOVERY_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 5 * 60_000;
        const h = trackScheduler("cooldownRecovery", "shared", startCooldownRecoveryActor({ tracker: healthTracker, intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // Cursor account-pool → host auth-dir materializer. No-ops when
  // OC_V5_CURSOR_AUTH_DIR is unset (commercial hosts without a local key dir).
  if (process.env.COMMERCIAL_CURSOR_AUTH_SYNC_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorAuthSync",
      domain: "v5-owned",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_CURSOR_AUTH_SYNC_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
        const h = trackScheduler("cursorAuthSync", "v5-owned", startCursorAuthSyncActor({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // A1 — pending 订单 expirer(默认 60s tick,部署即 boot 跑一次清历史脏单)。
  // markOrderPaid 不在事务内对 expires_at 做硬防线(避免用户超时几秒扫码就硬失败
  // 的体验回归);过期清理由本 sweeper 负责,被推 expired 后 markOrderPaid 自然拒。
  // 非法 / 空 / NaN → 60s;下限 1s(防 typo 把 DB 打穿)
  if (process.env.COMMERCIAL_PENDING_ORDERS_EXPIRER_DISABLED !== "1") {
    leaderBundle.add({
      name: "pendingOrdersExpirer",
      domain: "shared",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_PENDING_ORDERS_EXPIRER_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
        const h = trackScheduler("pendingOrdersExpirer", "shared", startPendingOrdersExpirer({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // 0096 / 0115 — 订阅周期轮转 sweeper(默认 5min tick,boot 即结算已到期订阅)。
  // 每 tick 先排空个人订阅轮转(付费档到期→降级 free+重置 300;free→月度续期),再排空
  // org 席位订阅轮转(0115:到期→清零 org 期内池+status='expired',不降档/不动钱包/不踢成员)。
  // 钱包不动。非法/空/NaN→5min;下限 1s。
  //
  // 【域归属 v5-owned】0096/0115 订阅数据域(user_subscriptions/org_subscriptions/period_credits)
  // 只有 v5 树有对应代码 —— v3 现网树 grep period_credits 零命中。若沿用 controlPlaneEnabled gate,
  // v5 被禁跑、v3 没代码 → 全网无人执行:个人 free 月度 300 永不重置、付费/org 到期永不结算
  // (产品语义断供;spendTwoBucket 排除过期桶所以钱是安全的)。故 channel=v5 必须自己跑。
  // 并发安全:rollover 内部 FOR UPDATE SKIP LOCKED,多实例同跑无双重结算。
  // org 轮转并入本 sweeper(同 v5-owned 域/同 tick/同认领模式),不新建独立 scheduler。
  let subscriptionRolloverSweeper: SubscriptionRolloverHandle | undefined;
  if (
    (controlPlaneEnabled || runtimeChannel === "v5") &&
    process.env.COMMERCIAL_SUBSCRIPTION_ROLLOVER_DISABLED !== "1"
  ) {
    const raw = Number(process.env.COMMERCIAL_SUBSCRIPTION_ROLLOVER_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 300_000;
    subscriptionRolloverSweeper = trackScheduler("subscriptionRollover", "v5-owned", startSubscriptionRolloverSweeper({ intervalMs }));
  }

  // B7 — account-pool per-slot 租约泄漏回收 sweeper(60s tick)。回收进程存活期间
  // release 路径丢失/未执行的孤儿 slot,防虚假 429。TTL 在 scheduler 内夹到
  // max(CODEX_SESSION_MAX_MS,30min) 下界,不抢 Codex bridge timer。纯进程内、无 DB。
  //
  // 【域归属 local】纯进程内自愈,无任何共享-state 副作用 —— 此前 gate 在
  // controlPlaneEnabled 是一刀切误伤:v5 的聊天代理路径同样持有 slot 租约,
  // 泄漏后无人回收 → v5 侧虚假 429 永不自愈。任何 channel 都应运行。
  let accountSlotReaper: SlotReaperHandle | undefined;
  if (process.env.COMMERCIAL_ACCOUNT_SLOT_REAPER_DISABLED !== "1") {
    const raw = Number(process.env.COMMERCIAL_ACCOUNT_SLOT_REAPER_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
    accountSlotReaper = trackScheduler("accountSlotReaper", "local", startAccountSlotReaper({ scheduler, intervalMs }));
  }

  // B1 — request_finalize_journal reconciler + GC(migration 0015 承诺、之前漏接)。
  // 把崩溃后卡 inflight/finalizing 的 journal 行终态化并 GC 老终态行。legacy stuck
  // 阈值向上夹到 max(CODEX_SESSION_MAX_MS*3, 30min)；durable Codex 另用 ≥24h
  // evidence SLA，且只豁免无 usage 的 inflight，绝不抢 finalizing owner。
  if (process.env.COMMERCIAL_FINALIZE_RECONCILER_DISABLED !== "1") {
    leaderBundle.add({
      name: "finalizeReconciler",
      domain: "shared",
      start: () => {
        const rawInterval = Number(process.env.COMMERCIAL_FINALIZE_RECONCILER_INTERVAL_MS);
        const intervalMs =
          Number.isFinite(rawInterval) && rawInterval >= FINALIZE_RECONCILER_MIN_INTERVAL_MS
            ? rawInterval
            : DEFAULT_RECONCILE_INTERVAL_MS;
        const rawCodexMax = Number(process.env.CODEX_SESSION_MAX_MS);
        const thresholdMs = resolveStuckThresholdMs(
          process.env.COMMERCIAL_FINALIZE_RECONCILER_THRESHOLD_MS,
          Number.isFinite(rawCodexMax) ? rawCodexMax : undefined,
        );
        const durableWaiverAgeMs = resolveDurableWaiverAgeMs(
          process.env.COMMERCIAL_FINALIZE_DURABLE_WAIVER_AGE_MS,
          thresholdMs,
        );
        const h = trackScheduler("finalizeReconciler", "shared", startFinalizeJournalReconciler({
          intervalMs,
          thresholdMs,
          durableWaiverAgeMs,
        }));
        return { stop: () => h.stop() };
      },
    });
  }

  // live journal 帧表维护:删已投影且确有 tape 记录的流的帧,并给不可能再产帧的
  // live 流打 retired_at(帧仍可见,只从在飞 owner 集合剔除)。leaderBundle shared
  // 单跑(双 master 只 leader)。仅 v5(client_session_live_frames 是 v5 表)。
  // 失败只记日志,start() 同步返回,不挡 leadership / 监听端口。
  if (runtimeChannel === "v5" && !resolveLiveFrameMaintenanceDisabled()) {
    leaderBundle.add({
      name: "liveFrameMaintenance",
      domain: "shared",
      start: () => {
        const intervalMs = resolveLiveFrameMaintenanceIntervalMs(
          process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_INTERVAL_MS,
        );
        const pruneMaxBatches = resolvePruneMaxBatches(
          process.env.COMMERCIAL_LIVE_FRAME_PRUNE_MAX_BATCHES,
        );
        const retireMinAgeMs = resolveRetireMinAgeMs(
          process.env.COMMERCIAL_LIVE_FRAME_RETIRE_MIN_AGE_MS,
        );
        const h = trackScheduler("liveFrameMaintenance", "shared", startLiveFrameMaintenanceScheduler({
          pool: getPool(),
          intervalMs,
          pruneMaxBatches,
          retireMinAgeMs,
          runOnStart: true,
          onError: (err) => rootLogger.warn("[liveFrameMaintenance] tick failed", {
            err: (err as Error)?.message ?? String(err),
          }),
        }));
        return { stop: () => h.stop() };
      },
    });
  }

  // durable turn dispatch reconciler(RFC §2.3):open dispatch 周期收敛(admitted 过期租约 →
  // 容器求证 → terminal/accepted;terminal 未通知 → 财务联查 → 真实终态 / manual_reconcile)。
  // leaderBundle shared 单跑(双 master 只 leader)。仅 v5(turn_dispatches 由 0170 建)。
  if (runtimeChannel === "v5" && process.env.COMMERCIAL_TURN_DISPATCH_RECONCILER_DISABLED !== "1") {
    const dispatchBridgeSecret = bridgeSecret;
    leaderBundle.add({
      name: "turnDispatchReconciler",
      domain: "shared",
      start: () => {
        const rawInterval = Number(process.env.COMMERCIAL_TURN_DISPATCH_RECONCILER_INTERVAL_MS);
        const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 5000 ? rawInterval : 30_000;
        const rawCodexMax = Number(process.env.CODEX_SESSION_MAX_MS);
        const stuckThresholdMs = resolveDispatchStuckThresholdMs(
          process.env.COMMERCIAL_TURN_DISPATCH_STUCK_MS,
          Number.isFinite(rawCodexMax) ? rawCodexMax : undefined,
        );
        // 独立 transport 实例(keep-alive 池);无 bridgeSecret → resolveRunningEndpoint 恒 null,
        // 容器求证分支跳过,reconciler 仍跑纯 DB 的财务/告警分支(不静默丢终态)。
        const container = makeContainerDispatchClient({
          transport: makeNodeHttpContainerTransport(),
          bridgeSecret: dispatchBridgeSecret ?? "",
          resolveRunningEndpoint: async (uid) => {
            if (!dispatchBridgeSecret) return null;
            // M3:remote-host 容器的 bound_ip **不是** master 可直拨的地址(它在 node-agent
            // 隧道后)。join compute_hosts 拿 host 名:非 'self' = remote-host → 打 tunnel 标记,
            // 让 containerDispatchClient(supportsTunnel=false)归为 unreachable 保持 unknown +
            // 告警,**绝不**对 bound_ip 做 false-dial(可能误命中同网段无关主机 = 伪 negative proof)。
            // v1 self-host 范围;tunnel transport 支持登记在 RFC §8 债表。
            const r = await getPool().query<{
              id: string;
              bound_ip: string | null;
              port: number | null;
              host_name: string | null;
            }>(
              `SELECT ac.id::text AS id, host(ac.bound_ip) AS bound_ip, ac.port,
                      ch.name AS host_name
                 FROM agent_containers ac
                 LEFT JOIN compute_hosts ch ON ch.id = ac.host_uuid
                WHERE ac.user_id = $1 AND ac.state = 'active' AND ac.runtime_channel = $2
                  AND ac.bound_ip IS NOT NULL AND ac.port IS NOT NULL
                ORDER BY ac.updated_at DESC LIMIT 1`,
              [uid.toString(), getRuntimeChannel()],
            );
            const row = r.rows[0];
            if (!row || !row.bound_ip || row.port === null) return null;
            const isRemoteHost = row.host_name !== null && row.host_name !== "self";
            return {
              host: row.bound_ip,
              port: Number(row.port),
              containerId: Number(row.id),
              ...(isRemoteHost ? { tunnel: { kind: "remote-host" as const } } : {}),
            };
          },
        });
        const reconcilerDeps = {
          pool: getPool(),
          container,
          stuckThresholdMs,
          // B-R1-1:abort 掉从未执行的 pre-forward journal 后,提前释放其 preCheck reservation
          // (best-effort;reservation 本会自然过期)。
          releaseReservation: (ref: { userId: string; requestId: string }) =>
            releasePreCheck(preCheckRedis, { userId: ref.userId, requestId: ref.requestId }).then(() => {}),
          // M4:真实终态落库后 best-effort 实时 nudge —— 复用既有 turn_state_unknown
          // reconcile 帧型(前端收到即 forceSync 拉回该 dispatch 的权威状态卡)。
          // published≠delivered:用户离线/已切轮则无害吞掉,终态已持久,下次 sync 必达。
          nudgeClient: (uid: bigint, sessionId: string, clientMessageId: string) => {
            try {
              userChatBridge.broadcastToUser(uid, {
                type: "outbound.message",
                channel: "webchat",
                peer: { id: sessionId, kind: "dm" },
                clientMessageId,
                isFinal: false,
                meta: { reconcile: "turn_state_unknown" },
                ts: Date.now(),
              });
            } catch {
              /* best-effort */
            }
          },
        };
        const h = trackScheduler("turnDispatchReconciler", "shared", startTurnDispatchReconciler({
          ...reconcilerDeps,
          intervalMs,
          runOnStart: true,
        }));
        turnDispatchShutdownHandoff = () => runShutdownDispatchHandoff({
          ...reconcilerDeps,
          budgetMs: DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS,
          limit: 8,
        });
        return { stop: () => h.stop() };
      },
    });
  }

  // Onboarding inbox scheduler — 由 system_settings.onboarding_enabled 决定是否真发,
  // 默认 false 上线即静默,boss 显式开启后才触达用户。详见 inbox/onboarding.ts。P3:收口 LeaderBundle。
  if (process.env.COMMERCIAL_ONBOARDING_DISABLED !== "1") {
    leaderBundle.add({
      name: "onboarding",
      domain: "shared",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_ONBOARDING_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 60_000;
        const h = trackScheduler("onboarding", "shared", startOnboardingScheduler({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // Plan C — inbox 站内信邮件推送 worker.
  // 由 admin 创建消息时勾选「同时发邮件」触发,inbox_email_jobs 表持久化,
  // 本 scheduler 周期 drain;启动时一次 stale cleanup(sending>5min → interrupted).
  // 关闭:COMMERCIAL_INBOX_EMAIL_DISABLED=1.默认 30s tick / 50 条/batch / 600ms 间隔.
  // mailer 走 stub 也能跑(打 stdout),只有禁用 worker 时不跑.
  if (process.env.COMMERCIAL_INBOX_EMAIL_DISABLED !== "1") {
    leaderBundle.add({
      name: "inboxEmail",
      domain: "shared",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_INBOX_EMAIL_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 30_000;
        const h = trackScheduler("inboxEmail", "shared", startInboxEmailScheduler({ mailer, intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // 科研 durable job worker(v5 科研 agent 子系统)。
  // research_jobs 表持久化容器提交的重 master-side op(ingest/index/cite_check/...);
  // 本 scheduler 周期 drain;启动时一次 stale cleanup(running>30min → interrupted).
  //
  // 【域归属 v5-owned(channel-scoped)】claimNextJob/recoverStale 均按本实例
  // runtime_channel 过滤,createJob 默认落本实例 channel → scheduler 只 mutate 自己
  // channel 的行。若仍 gate 在 controlPlaneEnabled,v5 创建的 job(runtime_channel='v5')
  // 会永远无人认领(v5 不跑、v3 只认领 v3 行)—— 与 channel 纪律自相矛盾。
  // 关闭:COMMERCIAL_RESEARCH_JOBS_DISABLED=1.默认 5s tick.
  // handler map:Phase 0 暂空(无 proxy 创建 job);Phase 1/2 逐步注入 ingest/index/
  // cite_check/lit_search/render 真实 handler(DI seam,见 research/scheduler.ts).
  let researchJobScheduler: ResearchJobSchedulerHandle | undefined;
  if (
    (controlPlaneEnabled || runtimeChannel === "v5") &&
    process.env.COMMERCIAL_RESEARCH_JOBS_DISABLED !== "1"
  ) {
    const raw = Number(process.env.COMMERCIAL_RESEARCH_JOBS_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 2000 ? raw : 5_000;
    researchJobScheduler = trackScheduler("researchJobs", "v5-owned", startResearchJobScheduler({
      handlers: {},
      intervalMs,
    }));
  }

  // cron 触发权威上移 master:到点确保容器活着(方案 docs/plans/v5-cron-master-wake-2026-07-07.md §3)。
  // 【域归属 v5-owned(channel-scoped)】cron_wake_index 按 runtime_channel 行级隔离,due 查询/
  // upsert/rescan 全过滤 getRuntimeChannel();v3 现网不含本代码 → 永不读写该表,零影响。故 gate 同
  // researchJobs:(controlPlaneEnabled || channel==='v5')。ensureContainerReady 不可用(无 docker
  // 运行时,如 external-proxy-only 拓扑)则不启(唤醒无从谈起)。关停:COMMERCIAL_CRON_WAKE_DISABLED=1。
  // rescan 是 self-host 假设(v5 现状全本机卷);多机化时改走 node-agent 读卷(方案已登记为已知边界)。
  // P3:cronWake 需交接调度器(RFC §2)→ 收口 LeaderBundle(单 leader 唤醒,消双 master 双唤醒烧钱)。
  // membership = ensureContainerReady 在手 + !DISABLED(不含 leadership;lease/legacy 触发启动)。
  if (process.env.COMMERCIAL_CRON_WAKE_DISABLED !== "1" && ensureContainerReady) {
    const wakeFn = ensureContainerReady; // 已 guard 非空
    leaderBundle.add({
      name: "cronWake",
      domain: "v5-owned",
      start: () => {
    const cronWakeRunner = getPool() as unknown as CronWakeRunner;
    const maxRaw = Number(process.env.COMMERCIAL_CRON_WAKE_MAX_PER_TICK);
    const maxPerTick = Number.isFinite(maxRaw) && maxRaw >= 1 ? Math.trunc(maxRaw) : undefined;
    const cdRaw = Number(process.env.COMMERCIAL_CRON_WAKE_COOLDOWN_MIN);
    const cooldownMs = Number.isFinite(cdRaw) && cdRaw >= 0 ? Math.trunc(cdRaw) * 60_000 : undefined;
    const cronWakeScheduler = trackScheduler("cronWake", "v5-owned", startCronWakeScheduler({
      findDueUsers: (scanLimit, horizonSec) =>
        findDueCronWakeUsers(cronWakeRunner, {
          runtimeChannel: getRuntimeChannel(),
          horizonSec,
          scanLimit,
        }),
      // active 判定:**有在跑容器**(state='active' 且 cid 已落库)才跳过唤醒。
      // 修 Codex MAJOR:不再用 findUserDataHost(纯按 state 派生、不看 cid)—— 否则 saga
      // 孤儿(active+cid=NULL,master 在 Tx1/Tx2 间崩溃/重启留下)被当 active → skippedActive
      // → 永不唤醒 → 永不进 sharedEnsureRunning 自愈 → cron 驱动用户 cron 永不 fire。
      // userHasRunningContainer 用 cid IS NOT NULL 排除孤儿(返回 false),让 cronWake 照常
      // 唤醒:在途→join singleflight;孤儿→getV3ContainerStatus provisioning/missing 自愈。
      // (agent_containers 只做「跳过 active」优化,不做发现源;发现源=cron_wake_index。)
      isContainerActive: async (uid) => computeQueries.userHasRunningContainer(Number(uid)),
      wakeContainer: (uid) => wakeFn(uid),
      recordWakeOutcome: ({ userId, correlation, outcome, attempts }) => {
        void recordProductFrictionEvent({
          correlation,
          userId,
          surface: "cron",
          stage: "container_wake",
          code: "WAKE_FAILED",
          outcome,
          attempts,
        }, getPool()).catch(() => {});
      },
      runRescan: () => runCronWakeRescan({ runner: cronWakeRunner }),
      logger: rootLogger,
      maxPerTick,
      cooldownMs,
    }));
        return { stop: () => cronWakeScheduler.stop() };
      },
    });
  }

  // 市场发布 AI 自动审批 worker(deepseek-v4-pro)。仅 v5 启动:marketplace 表 v3/v5 共享
  // 无 channel 列,但 v3 跑旧代码不写 ai_review_state → 恒 NULL → 永不被 claim,故 v3 保持
  // 纯人审、零行为变更。domain 'v5-owned'(v5 合法后台职责;写共享 marketplace 表但由
  // FOR UPDATE SKIP LOCKED 协调,v3 不参与)。关停:OC_MARKETPLACE_AI_REVIEW_DISABLED=1。
  // key 缺席不崩:worker 把 queued backlog 转人工 + 启动 warn(fail-closed)。
  let marketplaceAiReviewScheduler: MarketplaceAiReviewSchedulerHandle | undefined;
  if (
    runtimeChannel === "v5" &&
    process.env.OC_MARKETPLACE_AI_REVIEW_DISABLED !== "1"
  ) {
    const raw = Number(process.env.OC_MARKETPLACE_AI_REVIEW_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 15_000;
    marketplaceAiReviewScheduler = trackScheduler("marketplaceAiReview", "v5-owned", startMarketplaceAiReviewScheduler({
      apiKey: cfg.DEEPSEEK_API_KEY,
      intervalMs,
      logger: {
        info: (m) => rootLogger.info(m, { subsys: "commercial", module: "marketplaceAiReview" }),
        warn: (m) => rootLogger.warn(m, { subsys: "commercial", module: "marketplaceAiReview" }),
      },
      onError: (err, versionId) =>
        rootLogger.warn(
          `[marketplace/aiReview] error${versionId ? ` (version ${versionId})` : ""}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { subsys: "commercial", module: "marketplaceAiReview" },
        ),
    }));
  }

  // provider 健康度自动探测判定器(P3.2)。egress 在流 settle 写 provider_health_samples,
  // 本 scheduler(master)每 60s 评估近窗口失败率/连续失败 → 写 provider_ops 健康列并在状态
  // 转移时告警(仅 health_mode='auto' 自动转移;forced_* 尊重 admin)。默认影子(判定+标注开,
  // 503 拦截另由 OC_PROVIDER_HEALTH_ENFORCE 控)。domain 'v5-owned':provider_ops /
  // provider_health_samples 是 v5 引入表、样本由 v5 egress 写、v3 树无对应代码。关停:
  // OC_PROVIDER_HEALTH_DISABLED=1。
  let providerHealthScheduler: ProviderHealthSchedulerHandle | undefined;
  if (
    runtimeChannel === "v5" &&
    process.env.OC_PROVIDER_HEALTH_DISABLED !== "1"
  ) {
    const raw = Number(process.env.OC_PROVIDER_HEALTH_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
    providerHealthScheduler = trackScheduler("providerHealth", "v5-owned", startProviderHealthScheduler({ intervalMs }));
  }

  // v5 全链路自愈体系(RFC-v5-selfheal-ops)切片① — incidentReconciler + deliveries sweeper。
  // 【域归属 v5-owned】gate 在 runtimeChannel==='v5'(**不是** controlPlaneEnabled——v5 是 follower
  // 恒 false 会让整链真空,RFC 已论证:incident/policy/deliveries 皆 v5 引入表,v3 无对应代码 →
  // 不写共享现网,v5 必须自跑)。reconciler 读 alert_conditions 当前值 level-triggered 投影 incidents;
  // sweeper durable 投递 WS(bridge broadcast forward-ref)+ inbox(同事务幂等)。tick 10s。
  // 关停:OC_SELFHEAL_DISABLED=1。派单(codex 修复)是切片②,sweeper 内 stub 默认关。
  if (runtimeChannel === "v5" && process.env.OC_SELFHEAL_DISABLED !== "1") {
    // M5+B3(收尾批):装配前配置硬校验——dispatch 启用时密钥长度/互异/派单 URL
    // loopback 钉死,违规 throw fail-fast 拒启;禁用时仅 warn。数值 env 解析统一
    // 收口 selfheal/config.ts。
    assertSelfhealConfig();
    leaderBundle.add({
      name: "incidentReconciler",
      domain: "v5-owned",
      start: () => {
        const h: IncidentReconcilerHandle = trackScheduler(
          "incidentReconciler",
          "v5-owned",
          startIncidentReconciler({ intervalMs: selfhealTickMs() }),
        );
        return { stop: () => h.stop() };
      },
    });
    leaderBundle.add({
      name: "incidentSweeper",
      domain: "v5-owned",
      start: () => {
        const h: IncidentSweeperHandle = trackScheduler("incidentSweeper", "v5-owned", startIncidentSweeper({
          intervalMs: selfhealTickMs(),
        }));
        return { stop: () => h.stop() };
      },
    });
  }

  // 应用连接器 sweeper(设计终稿 §3 护栏):独立定时器,**不挂**被钉死的 idleSweep。
  // 三职责(活跃态转换)=stale executing→unknown / pending|approved 过期→expired+销毁
  // params / OAuth 过期行 DELETE;全部 DB CAS+SKIP LOCKED 幂等。P1#11:connector_write_ledger
  // 90 天终态 retention 已迁至统一 auditRetention 注册表(带终态谓词),此处不再删。
  // 【域归属 v5-owned + P3 MAJOR 3:迁入 LeaderBundle】connectors 三表是 0130 v5 引入,v3 无代码。
  // 旧实现 eager-start + gate 在 controlPlaneEnabled(静态 env):双 master 下两 slot env 都=1 →
  // 双跑(双 expire / 双 DELETE 竞态)。收口进 bundle(单 leader 单跑,与 wecomAlert/cronWake 同),
  // 启停交给 lease。关停:OC_CONNECTOR_SWEEPER_DISABLED=1。
  if (runtimeChannel === "v5" && process.env.OC_CONNECTOR_SWEEPER_DISABLED !== "1") {
    leaderBundle.add({
      name: "connectorSweeper",
      domain: "v5-owned",
      start: async () => {
        const raw = Number(process.env.OC_CONNECTOR_SWEEPER_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 60_000;
        const h = trackScheduler("connectorSweeper", "v5-owned", startConnectorSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // 知识星球无人值守回复只写 v5 专属 0168 三表，并复用 Plugin 账号串行租约。
  // 默认产品开关仍为关闭；scheduler 仅处理用户明确接受独立免责声明且启用的规则。
  // 挂 LeaderBundle 保证双 slot 仅单 leader 扫描/生成/发送。关停：
  // OC_KNOWLEDGE_PLANET_AUTOMATION_DISABLED=1。
  if (
    runtimeChannel === 'v5' &&
    knowledgePlanetAutomation &&
    process.env.OC_KNOWLEDGE_PLANET_AUTOMATION_DISABLED !== '1'
  ) {
    leaderBundle.add({
      name: 'knowledgePlanetAutomation',
      domain: 'v5-owned',
      start: () => {
        const raw = Number(process.env.OC_KNOWLEDGE_PLANET_AUTOMATION_INTERVAL_MS)
        const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? raw : 5 * 60_000
        const scheduler = trackScheduler('knowledgePlanetAutomation', 'v5-owned', startKnowledgePlanetAutomationScheduler({
            runtime: pluginFacade,
            preCheckRedis,
            pricing,
            apiKey: cfg.DEEPSEEK_API_KEY,
            intervalMs,
            onError: (duty, error) =>
              rootLogger.warn('[knowledgePlanetAutomation] scheduler duty failed', {
                duty,
                error: error instanceof Error ? error.message : String(error),
              }),
          }))
        return { stop: () => scheduler.stop() }
      },
    })
  }

  if (runtimeChannel === "v5" && process.env.OC_GITHUB_WORKSPACE_SWEEPER_DISABLED !== "1") {
    leaderBundle.add({
      name: "githubWorkspaceSweeper",
      domain: "v5-owned",
      start: () => {
        const h = trackScheduler("githubWorkspaceSweeper", "v5-owned", startGithubWorkspaceSweeper(getPool()));
        return { stop: () => h.stop() };
      },
    });
  }

  // 企业微信群机器人告警投递(v5-owned)。偿「v5 告警只入库不推送」债(playbook 债表
  // af1b054f):iLink/Telegram 投递 worker 寄生 shared 域 startAlertScheduler,v5
  // controlPlaneEnabled=false 把整个 shared scheduler 关掉 → 告警只 enqueue 不推送。
  // 本 dispatcher 独立,直接把 admin_alert_outbox 里 channel_type='wecom_bot' 的行推企微 webhook。
  //
  // 【域归属 v5-owned】gate 在 runtimeChannel==='v5',**不加 controlPlaneEnabled 分支**:
  //   - v3 跑旧代码不认 'wecom_bot'(其 shared dispatcher else 分支 markFailed,从不发)→ 无双发。
  //   - 若 v5 也 gate 在 controlPlaneEnabled(v5 恒 false)则 v5 禁跑 + v3 不发 → wecom 告警全网真空。
  //   仅 v5 跑,消除双跑双发。claim 显式过滤 wecom_bot(对称只认领自己能处理的类型,详见 dispatcher 头注)。
  //   sender 走 directEgressDispatcher 直连(qyapi 国内域名)。关停:OC_WECOM_ALERT_DISABLED=1。
  // 企业微信智能机器人(aibot)长连接管理器 —— 随 wecomAlert 同一 v5-only gate 启停,
  // **不注册为 scheduler**(命名 *Manager,不进 schedulerRegistry / smoke 白名单)。每个
  // wecom_aibot 通道一条 wss 长连接;dispatcher 的 wecom_aibot 行经 aibotConn.send 投递。
  // 详见 wecomAibotConnection 头注(单连接约束 + 国内域名直连出口红线)。
  // P3:wecomAlert(+ wecomAibot 长连接)需交接(RFC §2)→ 收口 LeaderBundle 单 leader。
  // aibot 单连接约束:双 master 各起一条 wss = 双投递/连接抢占,故必须随 leader 单实例启停。
  // dispatcher/aibot/approval 同一 member 内有序启停；approval 经 loopback slot relay
  // 并行查询/投递 A/B 两槽，只记录真实 deliveredUids，peer down/half-open 有界降级为空。
  if (runtimeChannel === "v5" && process.env.OC_WECOM_ALERT_DISABLED !== "1") {
    leaderBundle.add({
      name: "wecomAlert",
      domain: "v5-owned",
      start: async () => {
        const raw = Number(process.env.OC_WECOM_ALERT_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 5_000;
        const aibotConn = getWecomAibotConnectionManager();
        let dispatcher: ReturnType<typeof startWecomAlertDispatcher> | undefined;
        let approval: ReturnType<typeof startUserNoticeApproval> | undefined;
        try {
          await aibotConn.start();
          dispatcher = trackScheduler("wecomAlert", "v5-owned", startWecomAlertDispatcher({
            dispatchIntervalMs: intervalMs,
            deps: { sendAibotAlert: (id, md) => aibotConn.send(id, md) },
          }));
          approval = trackScheduler("userNoticeApproval", "v5-owned", startUserNoticeApproval(
            aibotConn,
            {
              onlineUserSubset: (uids) => slotRelayClient.onlineUserSubset(uids),
              broadcastToUsers: (uids, payload) => slotRelayClient.broadcastToUsers(uids, payload),
            },
          ));
        } catch (err) {
          unregisterMutator("userNoticeApproval");
          unregisterMutator("wecomAlert");
          try { await approval?.stop(); } catch { /* ignore */ }
          try { await dispatcher?.stop(); } catch { /* ignore */ }
          try { await aibotConn.stop(); } catch { /* ignore */ }
          throw err;
        }
        if (!dispatcher || !approval) throw new Error("wecom leader member incomplete startup");
        return {
          stop: async () => {
            try { await approval.stop(); } catch { /* ignore */ }
            unregisterMutator("userNoticeApproval");
            try { await dispatcher.stop(); } catch { /* ignore */ }
            try { await aibotConn.stop(); } catch { /* ignore */ }
          },
        };
      },
    });
  }

  // v5 灰度可观测 — runtimeStatus 暴露给 gateway /healthz,作为"控制面静默 / 运行时隔离 /
  // 灰度归属"的只读断言面(P4 可观测前移)。
  // enabledSchedulers 由归属登记表派生 —— 不再手工维护清单(此前 subscriptionRollover /
  // imagePromote 漏登记,让下方 fail-closed 断言出现盲区)。
  // P3:schedulers 改 **live getter** —— LeaderBundle 的成员随 lease 竞得/让位动态启停,
  // schedulerRegistry 由 bundle onMemberStopped(drain)+ start 闭包内 trackScheduler(拉起)实时增删。
  // gateway 每次 /healthz 都 `body.runtime=c.runtimeStatus` 再 JSON.stringify(会调 getter)→ 实时反映。
  // leadership:非 v5(无 lease)给合成态(controlPlaneEnabled→leader);v5 走 leaseController.status()。
  const legacyLeadership = (): LeadershipStatus => ({
    state: controlPlaneEnabled ? "leader" : "ineligible",
    slot: ocSlot,
    generation: null,
    leasePid: controlPlaneEnabled ? process.pid : null,
  });
  const runtimeStatus: CommercialRuntimeStatus = {
    channel: runtimeChannel,
    controlPlaneEnabled,
    autoMigrate: autoMigrateEffective,
    agentRuntime: agentRuntime ? "enabled" : "disabled",
    containerRuntime: v3Deps ? "enabled" : "disabled",
    get schedulers(): string[] {
      return schedulerRegistry.map((s) => s.name);
    },
    capabilities: [...MASTER_CAPABILITIES],
    get leadership(): LeadershipStatus {
      return leaderLease ? leaderLease.status() : legacyLeadership();
    },
    // P3 放量观测(RFC D1):lane_evaluations(请求次)+lane_users((generation,uid) 去重),
    // operator 据此判断 promote N% 已覆盖多少活跃用户。只读快照,零成本。
    get laneMetrics(): ReturnType<typeof getLaneMetricsSnapshot> {
      return getLaneMetricsSnapshot();
    },
  };
  // fail-closed:非 leader 绝不允许 shared mutator 存活 —— 拦"gate 漏配让 follower 写共享现网"。
  // P3 MAJOR 5:判据从**静态 controlPlaneEnabled 改为实时 leadership**。原因:双 master 下两 slot 的
  // OC_CONTROL_PLANE_LEADER 都=1 → controlPlaneEnabled 两 slot 都 true,`!controlPlaneEnabled` 恒 false
  // → 断言对 v5 follower 完全失效(follower 带 shared mutator 也不报)。改用 leaseController.status()
  // 的实时 state:!=='leader' 即非 leader。
  // 【bundle deferred 语义】bundle 的 shared 成员仅在竞得 lease(onAcquire)后才 trackScheduler 注册,
  // 竞得那刻 state 已='leader' → 不违反。此刻(lease 未 start)state=standby/ineligible,bundle 成员必不在册;
  // 本同步断言据此拦"bundle shared 成员被漏配成 eager 存活"的情形。
  // eager 残留(compute-pool 三件套=imagePromote/preheat 已由 MAJOR 4 在 v5 双 master fail-loud 拒起;
  // lifecycle=agent 容器 GC 仍 eager 跑在所有 v5 slot,收口债未迁 bundle)——它们不是"follower 违规",
  // 对 v5 从覆盖集剔除;非 v5(无 lease)保持全覆盖旧语义。
  const liveLeader = leaderLease ? leaderLease.status().state === "leader" : controlPlaneEnabled;
  const eagerResidual = leaderLease ? new Set(["lifecycle", "imagePromote"]) : new Set<string>();
  const sharedOnFollower = schedulerRegistry
    .filter((s) => s.domain === "shared" && !eagerResidual.has(s.name))
    .map((s) => s.name);
  if (!liveLeader && sharedOnFollower.length > 0) {
    throw new Error(
      `[commercial] control-plane invariant violated: 非 leader(leadership=${
        leaderLease ? leaderLease.status().state : `env:${controlPlaneEnabled}`
      })却有 shared-domain 调度器在册=[${sharedOnFollower.join(",")}]。非 leader 只允许 v5-owned/local 域 mutator。`,
    );
  }
  rootLogger.info(
    `commercial runtime status: channel=${runtimeChannel} controlPlane=${controlPlaneEnabled} slot=${ocSlot} dualMaster=${dualMasterEnabled} agentRuntime=${runtimeStatus.agentRuntime} containerRuntime=${runtimeStatus.containerRuntime} schedulers=[${runtimeStatus.schedulers.join(",")}]`,
    { subsys: "commercial", runtimeStatus },
  );

  // ── P3 触发:LeaderBundle 启动时机(RFC D4/§5)────────────────────────────────
  // v5:交给 lease controller——env 资格 ∧ desired_leader_slot==本 slot → 竞 advisory → 安装 lease →
  //    onAcquire=bundle.start;fence=bundle.stopAndDrain。基建版(seed desired=A / slot=A / env=1)
  //    数秒内竞得并 start = 现状行为等价。
  // 非 v5(v3/个人版遗留):无 lease,保持旧 eager 语义——controlPlaneEnabled(leader)即同步 start 全部
  //    bundle 成员(与改造前"每个 shared 都 if(controlPlaneEnabled) eager-start"净效果一致)。
  if (dualMasterEnabled) {
    leaderLease!.start();
  } else if (controlPlaneEnabled) {
    await leaderBundle.start();
    await seedPlatformAgentsForLeadership();
  }

  return {
    handle: async (req, res) => {
      // A Quick Tunnel reaches the same listener with a trycloudflare Host.
      // Claim those requests before the ordinary commercial router so an
      // invalid/expired preview can never fall through to the main SPA/API.
      if (directContainerPreview && (await directContainerPreview.handleHttp(req, res))) {
        return true;
      }
      return await handler(req, res);
    },
    runtimeStatus,
    handleWsUpgrade: (req, socket, head) => {
      if (directContainerPreview?.handleUpgrade(req, socket, head)) return true;
      // Preview uses its own short-lived one-time ticket and must never fall
      // through to the ordinary cookie/JWT bridges.
      if (containerPreviewBridge?.handleUpgrade(req, socket, head)) return true;
      // V3: 优先匹配 voice input,再 /ws/user-chat-bridge(2E)。legacy /ws/agent 已删除。
      if (voiceTranscribeHandler.handleUpgrade(req, socket, head)) return true;
      if (userChatBridge.handleUpgrade(req, socket, head)) return true;
      return false;
    },
    shutdown: async () => {
      // P2:停 sessions GC sweeper —— 清 sweep timer、unlock advisory lease、还/销毁持锁连接
      // (否则残留 setInterval + 永不归还池的持锁连接会泄漏,且备 master 竞不到锁)。
      if (sessionsGcSweeper) {
        try {
          await sessionsGcSweeper.stop();
        } catch {
          /* ignore */
        }
      }
      // P1.7 slice 7c — broker 先停。它会清 reconcile / housekeeping timer +
      // stop outboxWorker;放在 listener 关之前是为了:进行中的 outbox flush
      // 还能借 listener 把已经 admitted 的 outbound 完成最后一搏;同样 broker
      // 内部 fire-and-forget reflection 也能在 listener 拆掉前发送完。
      if (wechatBroker) {
        try { await wechatBroker.stop(); } catch { /* ignore */ }
      }
      const previewBridge = containerPreviewBridge;
      containerPreviewBridge = undefined;
      const directPreview = directContainerPreview;
      directContainerPreview = undefined;
      try { await directPreview?.shutdown(); } catch { /* ignore */ }
      try { await previewBridge?.shutdown(); } catch { /* ignore */ }
      try { await voiceTranscribeHandler.shutdown(); } catch { /* ignore */ }
      try { await userChatBridge.shutdown(); } catch { /* ignore */ }
      // Managed setup/action workers must drain while PG/Redis and Docker control are alive.
      try {
        await Promise.all([knowledgePlanetSetup?.closeAndDrain(), weiboSetup?.closeAndDrain()])
      } catch {
        /* ignore */
      }
      // ── P3:LeaderBundle + lease + 控制口 teardown(RFC D4)──────────────────────
      // v5:leaderLease.shutdown() graceful=(若持 lease)drain bundle(有界 30s)+写本 epoch ACK
      //    +unlock advisory —— 新 holder 拿锁即见 ACK,零等待零重叠;非 leader 则只清连接/timer。
      // 非 v5:无 lease,直接 stopAndDrain bundle(幂等)。二者都把 shared+4 特例调度器逐个 stop。
      if (leaderLease) {
        try { await leaderLease.shutdown(); } catch { /* ignore */ }
      } else {
        try { await leaderBundle.stopAndDrain(); } catch { /* ignore */ }
      }
      // 停机收尾:先给在飞 journal/dispatch 落「进程退出」证据,预算内再容器求证。
      // 绝不盲 finalize(引擎可能仍在容器里)。超时只留证据,让重启 tick 立刻判定。
      try {
        if (turnDispatchShutdownHandoff) {
          await turnDispatchShutdownHandoff();
        } else {
          await markGatewayShutdownEvidence({ reason: "process_shutdown" });
        }
      } catch {
        /* ignore — 退出优先,证据写失败由重启后的保守阈值兜底 */
      }
      if (controlListener) {
        try { await controlListener.close(); } catch { /* ignore */ }
      }
      if (deployDesiredWatch) {
        try { deployDesiredWatch.stop(); } catch { /* ignore */ }
      }
      // 非 bundle 的常驻调度器(v5-owned 安全双跑 + local + eager shared 例外)照旧逐个 stop。
      if (lifecycleScheduler) {
        try { await lifecycleScheduler.stop(); } catch { /* ignore */ }
      }
      // 0042 — ImagePromoteScheduler 是 module 级单例,getImagePromoteScheduler() 拿到实例后调 stop
      // (compute-pool trio 保留 controlPlaneEnabled gate,未入 bundle——见文首 P3 residual 说明)
      try { getImagePromoteScheduler().stop(); } catch { /* ignore */ }
      if (codexRefreshActor) {
        try { codexRefreshActor.stop(); } catch { /* ignore */ }
      }
      if (subscriptionRolloverSweeper) {
        try { subscriptionRolloverSweeper.stop(); } catch { /* ignore */ }
      }
      if (accountSlotReaper) {
        try { accountSlotReaper.stop(); } catch { /* ignore */ }
      }
      if (codexDriftReconciler) {
        try { codexDriftReconciler.stop(); } catch { /* ignore */ }
      }
      if (researchJobScheduler) {
        try { researchJobScheduler.stop(); } catch { /* ignore */ }
      }
      if (marketplaceAiReviewScheduler) {
        try { marketplaceAiReviewScheduler.stop(); } catch { /* ignore */ }
      }
      if (providerHealthScheduler) {
        try { providerHealthScheduler.stop(); } catch { /* ignore */ }
      }
      // connector/selfheal/WeCom writers 已迁入 LeaderBundle，由 lease.shutdown→stopAndDrain 回收。
      if (baselineSrv) {
        try { await baselineSrv.stop(); } catch { /* ignore */ }
      }
      if (internalProxyServer) {
        await new Promise<void>((resolve) => {
          try {
            internalProxyServer!.close(() => resolve());
            // 主动断现有连接,close 才能尽快回调
            const closeAll = (internalProxyServer as unknown as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(internalProxyServer);
          } catch { resolve(); }
        });
      }
      if (externalMtlsServer) {
        await new Promise<void>((resolve) => {
          try {
            externalMtlsServer!.close(() => resolve());
            const closeAll = (externalMtlsServer as unknown as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(externalMtlsServer);
          } catch { resolve(); }
        });
      }
      // 0060 — 清空 model hint provider,避免 shutdown 后还有人持 stale closure
      // (用于测试热重启场景:同一进程多次 register/shutdown 不能让旧 cache 被新 cache 引用)
      try { setModelHintProvider(null); } catch { /* ignore */ }
      // MAJOR-1 — 清空 host 静态 provider key seam(同进程热重启场景,避免旧 key 表被新进程引用)
      try { setHostStaticProviderKeys(null); } catch { /* ignore */ }
      // 0069 — 同理清空 literature skill provider(同进程热重启场景,且 closure 持
      // pg pool 句柄,留着会阻止 closePool 释放最后引用)
      try { setLiteratureSkillProvider(null); } catch { /* ignore */ }
      try { await pricing.shutdown(); } catch { /* ignore */ }
      try { await redis.quit(); } catch { /* ignore */ }
      await closeModelCatalogAdminPool();
      await closePool();
    },
    /** V3 2H 测试 / /healthz 探测用:内部代理实际监听地址(undefined = 未启用)。 */
    internalProxyAddress,
    /** V3 D.1b 测试 / /healthz 探测用:外部 mTLS 监听地址(undefined = 未启用)。 */
    externalMtlsAddress,
    // 已规范化为 ≥32 byte Uint8Array,gateway 可直接喂 createHmac
    jwtSecret: secretToKey(jwtSecret),
    // V3 multi-tenant media resolver — 只有 agentRuntime 起得来(docker client 在手)
    // 才注入;否则 gateway 自动回退 paths.{uploads,generated}Dir(单租户兼容)。
    // 详见 RegisterCommercialResult 注释。
    //
    // 注:v1.0.131 起 createCommercialHandler 不再消费此 resolver(media-sign 改用
    // 容器内 ACL),所以唯一消费者是 gateway 自己的 /api/uploads 写路径(由 gateway
    // 持有这个 closure 调 _resolveMediaDirs)。
    resolveUserMediaDirs: userMediaResolver,
    // textual 谓词,无依赖,始终暴露 —— 仅供 orphan sweep 启动时按目录壳子
    // 迭代 user volumes 用。**不要**给 HTTP allowlist 用(cross-tenant IDOR)。
    isUserVolumeMediaPath,
    // v1.0.192 冷启动护栏 hook for gateway handleUpload。
    // 共享 sharedEnsureRunning 同一 per-uid singleflight(详见 line 1655 装配处)。
    // **结构化返回**:不把 ContainerUnreadyError 穿过 gateway 边界(后者零编译期
    // 依赖 commercial,见 server.ts 头部注释),把已知冷启动 "未就绪" 拍平成
    // 普通对象;其他 error(DB / docker daemon 抖)继续 throw 让 gateway 兜底 500。
    ensureContainerReady: ensureContainerEndpointReady
      ? async (uid) => {
          try {
            await ensureContainerEndpointReady(uid);
            return { ok: true as const };
          } catch (err) {
            if (err instanceof ContainerUnreadyError) {
              return {
                ok: false as const,
                retryAfterSec: err.retryAfterSec,
                reason: err.reason,
              };
            }
            throw err;
          }
        }
      : undefined,
    // remote-host media push hook(2026-05-16 hotfix):用户容器调度到 remote
    // compute host 时,master 收到 /api/uploads → 本地暂存 → 调本 hook 把字节
    // 推到 host 上的 docker volume(/var/lib/docker/volumes/oc-v3-data-u<uid>/
    // _data/uploads/<digest>.<ext>)。node-agent 的 AllowedDirRegexes 已经放行
    // 这一路径形态(files.go 同 hotfix),mode 0o644 + owner 1000:1000 与
    // self-host 分支等价(容器内 agent uid=1000,确保可读)。
    //
    // 错误语义:row 不存在/agent 不可达/HTTP >=400 都直接抛,gateway 自己
    // 转成 502 "remote storage push failed"。PSK buffer 在 finally 里 fill(0)
    // 清零,与 putRemoteCodexAuth 同纪律。
    pushRemoteHostUpload,
    // 2026-05-16 hotfix Phase 2 — remote-host 读路径对称 closure。
    // 与 pushRemoteHostUpload 同纪律(psk 清零)与同错误语义(throw → gateway 502)。
    // node-agent 404 → 返 null,让 gateway 决定 fallback 还是终态 404。
    pullRemoteHostMedia: async (args: {
      hostUuid: string;
      remotePath: string;
    }) => {
      // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒。
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await nodeAgentGetFile(target, args.remotePath);
      } finally {
        target.psk?.fill(0);
      }
    },
    // healthz 深度探活:gateway healthz 经此 seam 探 PG/Redis(gateway 对二者零编译依赖)。
    // 任一失败 → healthz body.ok=false(HTTP 仍 200,monitor 消费 ok 字段自动告警),补上
    // "PG/Redis 宕机但 healthz 仍绿零告警"的盲区(2026-07-06 sessions.db 事故的同构面)。
    // 2s 超时:探活不能被慢依赖拖住 healthz;timer unref 不阻止进程退出。
    probeDeps: async () => {
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`probe timeout ${ms}ms`)), ms);
          timer.unref?.();
        });
        return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
      };
      const out: Record<string, { ok: true } | { ok: false; error: string }> = {};
      try {
        await withTimeout(getPool().query("SELECT 1"), 2000);
        out.pg = { ok: true };
      } catch (err) {
        out.pg = { ok: false, error: (err as Error).message };
      }
      try {
        await withTimeout(redis.ping(), 2000);
        out.redis = { ok: true };
      } catch (err) {
        out.redis = { ok: false, error: (err as Error).message };
      }
      return out;
    },
    // P1.7 slice 7c — broker 装配成功(WECHAT_BROKER_ENABLED=1 + bridgeSecret 齐)
    // 才暴露。gateway cli 把 commercial.wechatBroker 作为 onInboundOverride 透传给
    // wechat manager;manager 命中普通文本路径时把 evt 喂给 broker.onInbound,
    // broker 自己 never-throw 并按 wsess-* 命名空间走 dispatcher → container 链路。
    //
    // 类型上只暴露 onInbound 的最小投影(不导出 BrokerInboundOutcome 等内部 union)—
    // gateway 不需要也不应消费 outcome 字段,broker 内部已做必要的 log。
    wechatBroker: wechatBroker
      ? {
          onInbound: (evt) => wechatBroker!.onInbound(evt),
          cleanupBinding: (bindingUserId) => wechatBroker!.cleanupBinding(bindingUserId),
        }
      : undefined,
  };
}

export const COMMERCIAL_VERSION = "0.1.0";
// 便于 gateway / 测试单独访问
export { runMigrations } from "./db/migrate.js";
export { shouldAutoMigrate };
export { createCommercialHandler } from "./http/router.js";
export type { CommercialHandler } from "./http/router.js";
export type { CommercialHttpDeps } from "./http/handlers.js";
export { PricingCache, perKtokCredits } from "./billing/pricing.js";
export type { ModelPricing, PublicModel } from "./billing/pricing.js";
export { computeCost } from "./billing/calculator.js";
export type { TokenUsage, PriceSnapshot, CostResult } from "./billing/calculator.js";
export {
  adminAdjust,
  listLedger,
  InsufficientCreditsError,
  LEDGER_REASONS,
} from "./billing/ledger.js";
export type {
  LedgerReason,
  LedgerRef,
  DebitResult,
  AdminAdjustResult,
  LedgerRow,
} from "./billing/ledger.js";
export {
  preCheck,
  preCheckWithCost,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError as PreCheckInsufficientCreditsError,
  InMemoryPreCheckRedis,
  wrapIoredisForPreCheck,
} from "./billing/preCheck.js";
export type {
  PreCheckRedis,
  PreCheckInput,
  PreCheckWithCostInput,
  PreCheckResult,
  ReservationHandle,
  AtomicReserveResult,
} from "./billing/preCheck.js";
export {
  signHupijiao,
  verifyHupijiao,
  buildSignBase,
} from "./payment/hupijiao/sign.js";
export type { SignParams } from "./payment/hupijiao/sign.js";
export {
  createHttpHupijiaoClient,
  HupijiaoError,
} from "./payment/hupijiao/client.js";
export type {
  HupijiaoClient,
  HupijiaoConfig,
  CreateQrInput,
  CreateQrResult,
} from "./payment/hupijiao/client.js";
export {
  listPlans,
  getPlanByCode,
  generateOrderNo,
  createPendingOrder,
  getOrderByNo,
  markOrderPaid,
  expirePendingOrders,
  ORDER_STATUSES,
  PlanNotFoundError,
  OrderNotFoundError,
  InvalidOrderStateError,
} from "./payment/orders.js";
export type {
  TopupPlan,
  OrderRow,
  OrderStatus,
  CreatePendingOrderInput,
  MarkOrderPaidInput,
  MarkOrderPaidResult,
} from "./payment/orders.js";
// T-30 账号池 store
export {
  createAccount,
  getAccount,
  listAccounts,
  getTokenForUse,
  updateAccount,
  deleteAccount,
  ACCOUNT_PLANS,
  ACCOUNT_STATUSES,
  AccountNotFoundError,
} from "./account-pool/store.js";
export type {
  AccountPlan,
  AccountStatus,
  AccountRow,
  AccountToken,
  CreateAccountInput,
  UpdateAccountPatch,
  ListAccountsOptions,
} from "./account-pool/store.js";
// T-31 账号池 health
export {
  AccountHealthTracker,
  InMemoryHealthRedis,
  wrapIoredisForHealth,
  healthKey,
  failKey,
  DEFAULT_FAIL_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HEALTH_TTL_SEC,
  DEFAULT_FAIL_WINDOW_SEC,
} from "./account-pool/health.js";
export type {
  AccountHealth,
  HealthRedis,
  HealthDeps,
} from "./account-pool/health.js";
// T-32 账号池 scheduler
export {
  AccountScheduler,
  AccountPoolUnavailableError,
  AccountPoolBusyError,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  ERR_ACCOUNT_POOL_BUSY,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  parseMaxConcurrentEnv,
  pickWRH,
  computeAccountWeight,
  defaultHash,
} from "./account-pool/scheduler.js";
export type {
  PickInput,
  PickResult,
  ReleaseInput,
  ReleaseResult,
  SchedulerDeps,
  CandidateRow,
} from "./account-pool/scheduler.js";
// T-33 账号池 refresh + proxy
export {
  refreshAccountToken,
  shouldRefresh,
  defaultHttp,
  RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_OAUTH_ENDPOINT,
  DEFAULT_FALLBACK_EXPIRES_MS,
} from "./account-pool/refresh.js";
export type {
  RefreshErrorCode,
  RefreshHttpClient,
  RefreshDeps,
  RefreshedTokens,
} from "./account-pool/refresh.js";
export {
  streamClaude,
  ProxyError,
  ProxyAuthError,
  DEFAULT_CLAUDE_ENDPOINT,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_MAX_SSE_BUFFER,
} from "./account-pool/proxy.js";
export type {
  ProxyEvent,
  ProxyDeps,
  StreamClaudeInput,
} from "./account-pool/proxy.js";
// V3 Phase 2: T-40/T-40b/T-41 v2 chat orchestrator(chat/orchestrator.ts、chat/debit.ts、
// ws/chat.ts、http/chat.ts)已删除 — v3 chat 不再走 commercial 进程出口,改由用户的
// docker 容器跑个人版 → 经 anthropicProxy(2D 待加)统一访问上游。
// ws/connections.ts 保留:ConnectionRegistry 仍是 /ws/user-chat-bridge 的连接注册表
// (legacy /ws/agent 入口已删除)。
export {
  ConnectionRegistry,
  DEFAULT_MAX_PER_USER,
} from "./ws/connections.js";
export type {
  Conn,
  RegisterResult,
} from "./ws/connections.js";
// V3 Phase 2 Task 2I-1: 结构化 logger
export {
  createLogger,
  rootLogger,
  parseLevel,
  SENSITIVE_KEYS,
} from "./logging/logger.js";
export type {
  Logger,
  LogLevel,
  LoggerOptions,
} from "./logging/logger.js";
// V3 Phase 2 Task 2C: 容器身份双因子校验
export {
  verifyContainerIdentity,
  parseContainerToken,
  hashSecret,
  compareHash,
  createPgIdentityRepo,
  ContainerIdentityError,
} from "./auth/containerIdentity.js";
export type {
  ContainerIdentity,
  ContainerIdentityRepo,
} from "./auth/containerIdentity.js";
// V3 anthropicProxy 拆分 Phase 2(2026-05-18):身份层 strategy 物理切出
export {
  makeContainerIdentityStrategy,
  IdentityError,
  AuthzLoadError,
  AuthzDeniedError,
} from "./auth/proxyIdentity.js";
export type {
  IdentityStrategy,
  ProxyIdentity,
  ContainerIdentityStrategyDeps,
} from "./auth/proxyIdentity.js";
// V3 Phase 2 Task 2D: 内部 Anthropic 中央代理(monolith)
export {
  makeAnthropicProxyHandler,
  proxyBodySchema,
  enforceFieldByteBudgets,
  estimateInputTokens,
  estimateMaxCostBothSides,
  buildSafeUpstreamHeaders,
  ConcurrencyLimiter,
  pipeStreamWithUsageCapture,
  DEFAULT_UPSTREAM_ENDPOINT,
  ANTHROPIC_VERSION,
  ALLOWED_BETA_VALUES,
  SIZE_LIMITS,
  MAX_BODY_BYTES_DEFAULT,
  MAX_MESSAGES_COUNT,
  MAX_TOOLS_COUNT,
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_PROXY_RATE_LIMIT,
  DEFAULT_MAX_CONCURRENT_PER_UID,
} from "./http/anthropicProxy.js";
export type {
  AnthropicProxyDeps,
  AnthropicProxyHandler,
  ProxyBody,
  UsageObservation,
  PipeStreamResult,
} from "./http/anthropicProxy.js";
// V3 Phase 1 split: billing 子模块(从 anthropicProxy.ts L956-1485 物理切出)
export {
  startInflightJournal,
  makeFinalizer,
} from "./billing/proxyBilling.js";
export type {
  FinalizeContext,
  FinalizeOutcome,
  FinalizerHandle,
} from "./billing/proxyBilling.js";
// V3 Phase 4 split: upstream round-trip 子模块(从 anthropicProxy.ts L1421-1639 物理切出)
export { runUpstreamRoundTrip } from "./http/proxy/core.js";
export type { RoundTripCtx } from "./http/proxy/core.js";
// V3 Phase 3 split: upstream session 子模块(从 anthropicProxy.ts §3.4 物理切出)
export {
  selectUpstreamRoute,
  validateUpstreamConfig,
  pickUpstream,
  releaseUpstreamSession,
} from "./http/proxy/upstream.js";
export type {
  UpstreamRoute,
  ConfigError,
  PreparedUpstreamSession,
  PickError,
  PickUpstreamDeps,
} from "./http/proxy/upstream.js";
// V3 Phase 2 Task 2E: 用户 WS ↔ 容器 WS 桥接
export {
  createUserChatBridge,
  ContainerUnreadyError,
  CLOSE_BRIDGE,
  BRIDGE_WS_PATH,
} from "./ws/userChatBridge.js";
export type {
  UserChatBridgeDeps,
  UserChatBridgeHandler,
  ResolveContainerEndpoint,
  BridgeMetricSink,
  BridgeCloseCause,
} from "./ws/userChatBridge.js";
// T-53: Agent 订阅 + 生命周期
export {
  openAgentSubscription,
  getAgentStatus,
  cancelAgentSubscription,
  markContainerRunning,
  markContainerError,
  markExpiredSubscriptions,
  markContainerStoppedAfterExpiry,
  listVolumeGcCandidates,
  markContainerRemoved,
  AgentInsufficientCreditsError,
  AgentAlreadyActiveError,
  AgentNotSubscribedError,
  AGENT_PLAN_BASIC,
  DEFAULT_AGENT_PLAN_PRICE_CREDITS,
  DEFAULT_AGENT_PLAN_DURATION_DAYS,
  DEFAULT_AGENT_VOLUME_GC_DAYS,
  provisionContainer,
  runLifecycleTick,
  startLifecycleScheduler,
} from "./agent/index.js";
export type {
  AgentPlan,
  AgentSubscriptionStatus,
  AgentContainerStatus,
  OpenAgentSubscriptionInput,
  OpenAgentSubscriptionResult,
  AgentStatusView,
  CancelAgentSubscriptionResult,
  ExpiredSubscriptionRow,
  GcCandidateRow,
  ProvisionContainerOptions,
  LifecycleTickOptions,
  LifecycleTickResult,
  LifecycleLogger,
  LifecycleScheduler,
  StartLifecycleSchedulerOptions,
} from "./agent/index.js";
export type { AgentHttpDeps } from "./http/agent.js";
// T-62 metrics + alerts
export {
  renderPrometheus,
  incrGatewayRequest,
  incrBillingDebit,
  incrClaudeApi,
  resetMetricsForTest,
  normalizeRoute,
  snapshotForAlerts,
} from "./admin/metrics.js";
export {
  startAlertScheduler,
  createTelegramSender,
  defaultRules,
  ruleAccountPoolAllDown,
  ruleNoAccountsConfigured,
} from "./admin/alerts.js";
export type {
  AlertScheduler,
  AlertSchedulerOptions,
  AlertRule,
  AlertSender,
  Snapshot,
} from "./admin/alerts.js";
// V5 prompt queue P1 repository/internal transport (feature remains opt-in).
export { PgPromptQueueStore, PromptQueueStoreError } from "./promptQueue/pgPromptQueueStore.js";
export type {
  PromptQueueOwner,
  PromptQueueDetail,
  PromptQueueClaimRequest,
  PromptQueueClaimResult,
} from "./promptQueue/pgPromptQueueStore.js";
