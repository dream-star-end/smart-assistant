import { createCommercialProbeDeps, createCommercialShutdown } from "./bootstrap/shutdownBootstrap.js";
import {
  buildCronWakeSchedulerOptions,
  buildTapeJobSchedulerSetup,
  buildTurnDispatchReconcilerConfig,
  recordRecoveryJobTerminalFriction,
  wireTapeSchedulerKick,
} from "./bootstrap/v5WorkersBootstrap.js";
import { createCodexBindingHandle, createCommercialUserChatBridge } from "./bootstrap/chatBridgeBootstrap.js";
import {
  buildQqBotServiceAndReceivers,
  buildWechatBrokerDeps,
  createAutoDreamOptimizerRuntime,
  createCommercialCodexAndWechatTurns,
} from "./bootstrap/channelsAndAutoDreamBootstrap.js";
import { createCommercialPendingDecisionsRuntime } from "./bootstrap/pendingDecisionsBootstrap.js";
import {
  assembleV3SupervisorCore,
  bootstrapMailerBridgeAndAuthority,
  bootstrapPluginsRuntime,
  buildContainerHelpersAndPreview,
  claimUnavailableLiveBrowserUpgrade,
  createGrokRelayRouteAllocator,
  createOptionalContainerPreviewBridge,
  createOptionalDirectContainerPreview,
  createPreviewAndLiveBrowserTickets,
  wireRemoteMuxDeps,
} from "./bootstrap/runtimeSupervisorBootstrap.js";
import {
  bootstrapExternalApiKeyProxy,
  bootstrapExternalMtlsListener,
  bootstrapInternalProxyAndListeners,
} from "./bootstrap/internalProxyBootstrap.js";
import { createBoxFailureDiagnostics } from "./http/proxy/boxFailureDiagnostic.js";
import { containerLinkEnabled } from "./ws/containerLinkPolicy.js";
import { configurePluginCatalog } from './plugins/catalogPolicy.js';
import { configureModelAvailability } from './billing/modelAvailability.js';
import { makeSystemRuntimeStatusRead } from './system-assistant/runtimeStatusRead.js';
import { assembleSystemActions, type SystemSessionReadBackend } from './system-assistant/assemble.js';
import { makePromptPrivacySupportResolver } from './user/promptPrivacySupport.js';
import { getV3ContainerStatus } from './agent-sandbox/v3supervisor.js';
import type { LocalCasArtifactBlobStore } from './agent-sandbox/artifactBlobStore.js';
import { startLogTimingReporter } from './logging/logTimingReporter.js';
import { setContentReviewAlerter, setContentReviewPrefilter } from '@openclaude/gateway';
import { omniHardHit } from './openai/omniModeration.js';
import { selectOpenAiPlatformKey } from './openai/openAiPlatformKey.js';
import { alertContentReview } from './admin/contentReviewAlert.js';
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

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
// P3 双 master 蓝绿交接 + cohort 分批切流(RFC-v5-dual-master-cohort)。
import type { Slot } from "./deploy/deployState.js";
import { startDesiredWatch, type DesiredWatch } from "./deploy/deployState.js";
import { createLeaderBundle, type LeaderBundle } from "./deploy/leaderBundle.js";
import {
  createLeaderLeaseController,
  resolveLeaderEnvEligibility,
  type LeaderLeaseController,
  type LeadershipStatus,
} from "./deploy/leaderLease.js";
import { type ControlListener } from "./deploy/controlListener.js";
import { createSlotRelayClient, type SlotRelayLocal } from "./deploy/slotRelay.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import * as fs from "node:fs";
import IORedis from "ioredis";
import Docker from "dockerode";
import { runMigrations } from "./db/migrate.js";
import { assertFlavorIdentity } from "./flavor/assertFlavor.js";
import { shouldStartCommercialScheduler } from "./flavor/commercialSchedulerPolicy.js";
import { createMasterCc5Runtime } from "./agent-sandbox/cc5Runtime.js";
import { recoverRemoteNativeTurnBilling } from "./billing/remoteNativeTurnBilling.js";
import { cursorExternalApiOutboxDirForFlavor } from "./billing/cursorExternalApiOutbox.js";
import { getPool } from "./db/index.js";
import { reconcileBoxBillingBatch } from "./billing/boxBillingRecovery.js";
import { BoxDurableJournal } from "./http/proxy/boxDurableJournal.js";
import { createProductionBoxAccountResolver } from "./http/proxy/boxAccountResolver.js";
import { BoxRemoteCleanupWorker } from "./http/proxy/boxRemoteCleanupWorker.js";
import { BoxHoldRelease } from "./http/proxy/boxHoldRelease.js";
import { createBoxReplayRecoveryWriter } from "./egress/boxReplaySetup.js";
import { loadConfig, type CommercialConfig } from "./config.js";
import { wrapIoredis } from "./middleware/rateLimit.js";
import { CodexCommissioning } from "./account-pool/codexCommissioning.js";
import { RemoteDriverV4CommissioningService, startRemoteDriverDriftScheduler } from "./account-pool/remotePool/index.js";
import { makeAdminCommissionContainerSource } from "./account-pool/codexCommissioningContainer.js";
import { createCommercialHandler } from "./http/router.js";
import { rootLogger } from "./logging/logger.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { secretToKey } from "./auth/jwt.js";
import { PricingCache, createModelHintProvider } from "./billing/pricing.js";
import {
  ALLOWED_INBOUND_MODELS,
  setModelHintProvider,
  setLiteratureSkillProvider,
  setHostStaticProviderKeys,
} from "@openclaude/gateway";
import { setPlatformFlashFallbackKey } from "./http/proxy/shared.js";
import { literatureSkillSlotProvider } from "./literatureSkill.js";
import { releasePreCheck, wrapIoredisForPreCheck } from "./billing/preCheck.js";
import { createHttpHupijiaoClient, type HupijiaoClient, type HupijiaoConfig } from "./payment/hupijiao/client.js";
import { AccountScheduler } from "./account-pool/scheduler.js";
import {
  type CodexDisableFanoutDeps,
  type CodexDriftReconcilerHandle,
  enqueueCodexDisableFanout,
  startCodexDisableDriftReconciler,
} from "./account-pool/codexDisableFanout.js";
import { AccountHealthTracker, wrapIoredisForHealth } from "./account-pool/health.js";
import { GoalStateService } from './goal/goalStateService.js';
import { startLifecycleScheduler, type LifecycleScheduler, type LifecycleLogger } from "./agent/index.js";
import type { AgentHttpDeps } from "./http/agent.js";
import { startAlertScheduler } from "./admin/alerts.js";
import { EVENTS as ALERT_EVENTS } from "./admin/alertEvents.js";
import { safeEnqueueAlert } from "./admin/alertOutbox.js";
import { startRefreshEventsSweeper } from "./account-pool/refreshEventsSweeper.js";
import { startDesktopEnrollmentSweep } from "./http/desktopEnroll.js";
import { startAuditRetentionSweeper } from "./admin/auditRetention.js";
import { startGithubWorkspaceSweeper } from "./github/sessionWorkspaces.js";
import { startImageUsageSweeper } from "./billing/imageBilling.js";
import { startCodexRefreshActor, type CodexRefreshActorHandle } from "./account-pool/codexAccountActor.js";
import { createAccountPoolAdapter } from "./account-pool/accountPoolAdapter.js";
import { createApiKeyPoolAdapter, createRelayKeyPoolAdapter } from "./account-pool/apiKeyPool.js";
import { createGeminiPoolAdapter } from "./account-pool/geminiPoolAdapter.js";
import { registerRemoteBrainPoolAdapter } from "./account-pool/remoteBrainPool.js";
import { registerPoolAdapter, startPoolRecoveryActor } from "./account-pool/policy/registry.js";
import { configureAffinitySettings } from "./account-pool/policy/affinity.js";
import { getSystemSetting } from "./admin/systemSettings.js";
import { startLogLevelSyncPoller } from "./logging/logLevelSync.js";
import { startCursorAuthSyncActor } from "./account-pool/cursorMaterializer.js";
import { startCursorSandPreparationActor } from "./account-pool/cursorSandActor.js";
import { startCursorUsageSweeper } from "./account-pool/cursorUsageSweeper.js";
import { startGrokUsageSweeper } from "./account-pool/grokUsageSweeper.js";
import {
  DEFAULT_V3_CODEX_CONTAINER_DIR,
  V3_CONTAINER_PORT,
  ocGatewayIpForChannel,
  ocInternalProxyPortForChannel,
} from "./agent-sandbox/v3supervisor.js";
import { AuthoritySigner } from "./ws/authoritySigner.js";
import { ModelCatalogCache } from "./billing/modelCatalog.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "./agent-sandbox/constants.js";
import { startPendingOrdersExpirer } from "./payment/pendingOrdersExpirer.js";
import { startSubscriptionRolloverSweeper, type SubscriptionRolloverHandle } from "./billing/subscriptionRolloverSweeper.js";
import { startAccountSlotReaper, type SlotReaperHandle } from "./account-pool/accountSlotReaper.js";
import {
  startFinalizeJournalReconciler,
  resolveStuckThresholdMs,
  resolveDurableWaiverAgeMs,
  DEFAULT_RECONCILE_INTERVAL_MS,
  MIN_INTERVAL_MS as FINALIZE_RECONCILER_MIN_INTERVAL_MS,
} from "./billing/finalizeJournalReconciler.js";
import { startTapeJobScheduler } from "./db/tapeJobScheduler.js";
import {
  startLiveFrameMaintenanceScheduler,
  resolveLiveFrameMaintenanceDisabled,
  resolveLiveFrameMaintenanceIntervalMs,
  resolvePruneMaxBatches,
  resolveRetireMinAgeMs,
} from "./db/liveFrameMaintenanceScheduler.js";
import { startOnboardingScheduler } from "./inbox/onboarding.js";
import { startInboxEmailScheduler } from "./inbox/email.js";
import { startResearchJobScheduler, type ResearchJobSchedulerHandle } from "./research/scheduler.js";
import { makeResearchFetchJobHandlers } from "./research/fetchJobs.js";
import { startCronWakeScheduler } from "./agent-sandbox/cronWake.js";
import { startMarketplaceAiReviewScheduler, type MarketplaceAiReviewSchedulerHandle } from "./marketplace/aiReview.js";
import { startTutorialModerationScheduler } from "./tutorials/tutorialModeration.js";
import { startProviderHealthScheduler, type ProviderHealthSchedulerHandle } from "./admin/providerHealthScheduler.js";
import {
  startIncidentReconciler,
  startIncidentSweeper,
  assertSelfhealConfig,
  selfhealTickMs,
  type IncidentReconcilerHandle,
  type IncidentSweeperHandle,
} from "./selfheal/index.js";
import { startWecomAlertDispatcher } from "./admin/wecomAlertDispatcher.js";
import { getWecomAibotConnectionManager } from "./admin/wecomAibotConnection.js";
import { startUserNoticeApproval } from "./selfheal/userNoticeApproval.js";
import { type AnthropicProxyHandler } from "./http/anthropicProxy.js";
import { staticProviderKeysFromConfig } from "./http/proxy/staticProviderMeta.js";
import type { DurableCodexBilling, StaticProviderKeys } from "@openclaude/protocol";
import { isGrokEngineModel } from "@openclaude/protocol";
import { createSitesFromConfig } from "./sites/assemble.js";
import {
  createCodexRouteContextForModel,
  hasActiveOfficialOAuthAccountInGroup,
  listEnabledGroupsForModel,
} from "./account-pool/groups.js";
import { type AdvisorCodexSelectorDecision } from "./billing/advisorCodexAdmitRoute.js";
import { makeGrokRelayHandler, makeGrokRelayHealthRecorder } from "./http/internalGrokRelay.js";
import { configureZcodeRelayKv, createIoredisZcodeRelayKv } from "./billing/zcodeRouteContext.js";
import { configureAntigravityRouteStores } from "./http/antigravityRouteRuntime.js";
import { type AutoDreamOptimizerRuntime } from "./http/internalAutoDreamOptimizer.js";
import { type DelegateEngineBillingRuntime } from "./http/internalDelegateEngineBilling.js";
import { makeCommercialRuntimeStatus, type CommercialRuntimeStatus } from "./runtimeStatus.js";
export type { CommercialRuntimeStatus } from "./runtimeStatus.js";
import { peekModelCatalogCache } from "./billing/modelCatalogRuntime.js";
import { assertModelAuthorityCutoverFloor } from "./runtimeCapabilities.js";
import {
  appendCostCredits,
  appendServerAuthoredMessage,
  classifyClientSessions,
  setClientSessionsBackend,
} from "@openclaude/storage";
import {
  createPgSessionsBackend,
  readPgChatProject,
  type AutomaticRecoveryDecision,
  type DispatchAdmissionBackend,
  startSessionsGcSweeper,
  type LosslessTurnTapeStorage,
} from "./db/pgSessionsBackend.js";
import {
  startTurnDispatchReconciler,
  runShutdownDispatchHandoff,
  DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS,
} from "./dispatch/turnDispatchReconciler.js";
import { resolveSessionsStoreAuthority } from "./db/sessionsStoreAuthority.js";
import { type ProactiveReceiverHandler } from "./wechat/proactiveReceiver.js";
import { MASTER_USER_PREFIX } from "./wechat/userIds.js";
import { startKnowledgePlanetAutomationScheduler } from './plugins/knowledgePlanetAutomationScheduler.js';
import { startConnectorSweeper } from './connectors/sweeper.js';
import { createMuseFromConfig } from "./muse/assemble.js";
import { createStudioFromConfig } from "./media-studio/assemble.js";
import { MediaGenerationService } from "./media-generation/service.js";
import { makeWechatBroker, type WechatBroker } from "./wechat/broker.js";
import { readQqBotConfig } from "./qqbot/config.js";
import { type QqBotService } from "./qqbot/service.js";
import { makeQqOutboundReceiver, makeQqProactiveReceiver } from "./qqbot/receiver.js";
import { createPgIdentityRepo } from "./auth/containerIdentity.js";
import { makeLoadUserModelAuthz } from "./auth/userModelAuthz.js";
import { getDegradedProviders } from "./admin/providerHealthGate.js";
import {
  ContainerUnreadyError,
  type CodexBindingHandle,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
} from "./ws/userChatBridge.js";
import { createVoiceTranscribeHandler, type VoiceTranscribeHandler } from "./ws/voiceTranscribe.js";
import { settleDurableCodexBilling } from "./billing/durableCodexBilling.js";
import { makeModelSwitchCostService } from './billing/modelSwitchCostTarget.js';
import { isCursorDurableBilling, settleDurableCursorBilling } from "./billing/durableCursorBilling.js";
import { parseZeroChargeCutoff, startCursorAuditReconciler } from "./billing/cursorAuditReconciler.js";
import { isAntigravityDurableBilling, settleDurableAntigravityBilling, startAntigravityTurnReconciler } from "./billing/durableAntigravityBilling.js";
import { type ContainerPreviewBridgeHandler } from "./ws/containerPreviewBridge.js";
import { type DirectContainerPreviewService } from "./ws/directContainerPreview.js";
import {
  DEFAULT_V3_CCB_BASELINE_DIR,
  makeDesktopOrDockerResolver,
  makeInboundChannelResolver,
  preheatV3Image,
  startIdleSweepScheduler,
  INITIAL_SWEEP_BATCH_LIMIT,
  startMigrationReconcileScheduler,
  startOrphanReconcileScheduler,
  startV3ContainerEventsWorker,
  startVolumeGcScheduler,
  isUserVolumeMediaPath,
  type UserMediaLocation,
  type V3SupervisorDeps,
} from "./agent-sandbox/index.js";
import * as computeQueries from "./compute-pool/queries.js";
import { resolveServiceableHostTarget, getFile as nodeAgentGetFile } from "./compute-pool/nodeAgentClient.js";
import { createRemoteHostChunkHooks } from "./compute-pool/remoteHostChunkHooks.js";
import { getHealthPoller } from "./compute-pool/nodeHealth.js";
import { initComputePool } from "./compute-pool/poolInit.js";
import { getImagePromoteScheduler } from "./compute-pool/imagePromote.js";
import { getBaselineServer, type BaselineServer } from "./compute-pool/baselineServer.js";

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
import type { RegisterCommercialResult } from "./commercialRegistrationTypes.js";
export type { RegisterCommercialResult } from "./commercialRegistrationTypes.js";

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
  return staticProviderKeysFromConfig(cfg);
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
  const flavorIdentity = assertFlavorIdentity();
  configurePluginCatalog(flavorIdentity);
  configureModelAvailability(flavorIdentity);
  const cursorExternalOutboxDir =
    flavorIdentity.status === "ok"
      ? cursorExternalApiOutboxDirForFlavor(flavorIdentity.flavor)
      : null;

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

  // 第三阶段 P1(OCV5-559):日志级别热改。system_settings.log_level 驱动 gateway / 商用版的共享级别
  // (kernel registerLevelRef);启动立即应用、admin PUT 立即应用、每 5 秒轮询收敛。纯进程内(只读一行)→ local。
  const logLevelSync = trackScheduler("logLevelSync", "local", startLogLevelSyncPoller({ read: async () => (await getSystemSetting("log_level")).value }));

  // ── P2:master 会话权威 backend 选择(RFC-v5-sessions-pg D1 启动矩阵)────────────
  // 放在 config 加载 + auto-migrate(0134 表须先在)之后、一切 schedulers/backend 消费之前。
  // channel=v5 = master 形态(容器内 gateway / 个人版不加载 commercial → 天然 SQLite,零变化)。
  // 依 OC_SESSIONS_STORE + PG 状态行 + 本地 manifest 三元组裁决 sqlite/pg;矩阵之外 fail-closed
  // 拒起(resolveSessionsStoreAuthority 抛错即 registerCommercial 抛错 = master 拒起)。
  // 驱动选择权威在此一处(composition root),函数内禁 if(pg) 分支;pg 则一次性 setClientSessionsBackend。
  let sessionsGcSweeper: { stop: () => Promise<void> } | null = null;
  let turnDispatchShutdownHandoff: (() => Promise<unknown>) | undefined;
  let losslessTurnTapeStorage: LosslessTurnTapeStorage | undefined;
  let systemSessionReadBackend: SystemSessionReadBackend | undefined;
  // durable turn dispatch(RFC §2):受理、tape-state 与真实终态读需 DispatchAdmissionBackend 面。
  let dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  const goalUsageRefreshRef: {
    current: (userId: string, sessionId: string) => void | Promise<void>;
  } = { current: () => { /* GoalState service is assembled below. */ } };
  const sessionsDeletedRef: {
    current: (userId: string, sessionIds: readonly string[]) => void;
  } = { current: () => { /* the remote lane runtime is assembled below */ } };
  // Phase B finalize decides (inside its tx) whether the master will retry the
  // terminal turn. The browser learns the verdict through this post-commit
  // sideband so it can keep showing 「正在重试中」 instead of flashing a red card
  // until outbound.ack{recovery} arrives — or materialize the red card at once
  // when no recovery will follow. Forward-ref: the bridge is assembled below.
  const recoveryDecisionBroadcastRef: {
    current: (userId: string, sessionId: string, decision: AutomaticRecoveryDecision) => void;
  } = { current: () => { /* bridge not assembled yet — browser converges via ack/history */ } };
  // HTTP finalize (Phase A) nudges the leader-owned tape job scheduler so Phase B
  // (and therefore the recovery verdict above) runs now, not on the next 5s tick.
  // Non-leader masters keep the noop: the leader's interval still converges.
  const tapeSchedulerKickRef: { current: () => void } = { current: () => { /* no scheduler here */ } };
  let sessionsStoreGeneration = 0;
  if (runtimeChannel === "v5") {
    const decision = await resolveSessionsStoreAuthority({ pool: getPool() });
    if (decision.store === "pg") {
      sessionsStoreGeneration = decision.generation;
      const pgSessionsBackend = createPgSessionsBackend(getPool(), {
        expectedGeneration: decision.generation,
        admissionRestartRecovery: {
          releaseReservation: (ref) => releasePreCheck(preCheckRedis, ref).then(() => {}),
        },
        onGoalUsageChanged: (userId, sessionId) => goalUsageRefreshRef.current(userId, sessionId),
        onAutomaticRecoveryDecision: (userId, sessionId, verdict) =>
          recoveryDecisionBroadcastRef.current(userId, sessionId, verdict),
        onRecoveryJobTerminal: (userId, sessionId, info) =>
          recordRecoveryJobTerminalFriction(userId, sessionId, info),
        onClientSessionsDeleted: (userId, sessionIds) => sessionsDeletedRef.current(userId, sessionIds),
      });
      setClientSessionsBackend(pgSessionsBackend);
      systemSessionReadBackend = pgSessionsBackend;
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
  let cronOriginBridgeRef: UserChatBridgeHandler | null = null;
  if (dualMasterEnabled) {
    deployDesiredWatch = startDesiredWatch({
      pool: getPool(),
      onError: (err) => rootLogger.warn("[deployDesiredWatch] poll 失败(保留旧缓存)", { err: (err as Error)?.message ?? String(err) }),
    });
    const eligibleEnv = resolveLeaderEnvEligibility(process.env);
    leaderLease = createLeaderLeaseController({
      pool: getPool(),
      slot: ocSlot,
      desiredWatch: deployDesiredWatch,
      eligibleEnv,
      callbacks: {
        onAcquire: async () => {
          await leaderBundle.start();
          await seedPlatformAgentsForLeadership();
          await cronOriginBridgeRef?.setBackgroundRoleActive?.(true);
        },
        onFence: async (reason) => {
          rootLogger.warn(`[leaderLease] fence → stopAndDrain bundle(${reason})`, { subsys: "leaderLease" });
          await cronOriginBridgeRef?.setBackgroundRoleActive?.(false);
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
  configureZcodeRelayKv(createIoredisZcodeRelayKv(redis));
  configureAntigravityRouteStores({ redis, pool: getPool() });

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
  // 非 codex 静态模型(默认 deepseek-v4-flash)后,host CCB 子进程需平台静态 key 直连上游
  // (见 gateway/hostStaticProviders + subprocessRunner 注入点)。个人版不 import commercial →
  // seam 恒 null = 整块 no-op,settings.json 继续掌权。与 setModelHintProvider 同注册/清理生命周期。
  setHostStaticProviderKeys(buildHostStaticProviderKeys(cfg));
  // OCV5-482:平台直连 flash(市场审核/语音润色/知识星球)Go 不可用时回落 DeepSeek 官方。
  setPlatformFlashFallbackKey(cfg.DEEPSEEK_API_KEY);

  // 0069 — SKILLS_LITERATURE slot 反向钩子(provider 见 literatureSkill.ts,fail-soft、不解密 token)。
  setLiteratureSkillProvider(literatureSkillSlotProvider);

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
    current: ((userId: string) => Promise<UserMediaLocation>) | undefined;
  } = { current: undefined };
  const {
    pluginFacade,
    knowledgePlanetSetup,
    weiboSetup,
    zhihuSetup,
    biliAccountSetup,
    douyinSetup,
    knowledgePlanetAutomation,
    literatureSetup,
    literatureArtifacts,
  } = bootstrapPluginsRuntime({
    cfg,
    runtimeChannel,
    redis,
    knowledgePlanetMediaResolverRef,
  });

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
  let desktopTlsClose: (() => Promise<void>) | undefined;
  // 2026-05-05 v3 commercial server-authored persistence:18791 plain + 18443 mTLS
  // 共享同一个 dispatcher,按 url path 分流到 anthropicProxy 或 internalServerAuthored。
  // 在 internalProxyHandler 构造完毕后赋值;mTLS listener 读它而不是 internalProxyHandler。
  let dispatchInternal: AnthropicProxyHandler | undefined;

  // ── grok relay route allocation(浏览器 turn 与 delegate turn 共用)──────
  // createCommercialCodexRoute 原 grok 分支的原样抽取:bridge(每帧铸 route)
  // 与下方 delegateGrokRouteHandler(容器本地 delegate turn 主动申请)必须走
  // 同一账号池、同一 grok_route_contexts durable 并发权威,不允许各自解释。
  const allocateGrokRelayRoute = createGrokRelayRouteAllocator(scheduler);
  // Internal listeners are assembled before model-authority startup. Renewal
  // reads this forward ref at request time; startup windows fail closed 503.
  let modelAuthoritySigner: AuthoritySigner | undefined;
  let modelCatalogCache: ModelCatalogCache | undefined;
  let artifactBlobStore: LocalCasArtifactBlobStore | undefined;
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
  // OCV5-561 Muse media bridge (selfhost). Off unless OC_MUSE_BRIDGE_ENABLED=1; see muse/assemble.ts.
  const museDeliveryRefs: {
    pushRemote?: (args: { hostUuid: string; remotePath: string; content: Buffer }) => Promise<void>;
    resolveMedia?: (userId: string) => Promise<UserMediaLocation>;
  } = {};
  const { hub: museHub, bridgeHttp: museBridgeHttp, closePublic: closeMusePublic } = await createMuseFromConfig(cfg, getPool(),
    flavorIdentity.status === "ok" && flavorIdentity.flavor === "commercial" ? {
      append: appendServerAuthoredMessage,
      originActive: async (sessionId, userId) =>
        (await classifyClientSessions([{ sessionId, userId }]))[0]?.state === "active",
      resolveMedia: async (userId) => {
        if (!museDeliveryRefs.resolveMedia) throw new Error("Muse media resolver not ready");
        return museDeliveryRefs.resolveMedia(userId);
      },
      pushRemote: async (args) => {
        if (!museDeliveryRefs.pushRemote) throw new Error("Muse remote uploader not ready");
        await museDeliveryRefs.pushRemote(args);
      },
      broadcast: (uid, frame) => bridgeBroadcastRef.current(uid, frame),
    } : undefined);
  // OCV5-591 media studio. Off unless OC_STUDIO_ENABLED=1 (→ /api/studio/* 404, no GC tick).
  const studioHttp = await createStudioFromConfig(cfg, getPool(), { preCheckRedis, museHub });
  const sitesService = createSitesFromConfig(cfg, getPool());
  let stopStudioOrchestrator: (() => Promise<void>) | undefined;
  // OCV5-591 A2-1c-2: studio activity to this slot's connections (assigned once the bridge exists).
  const studioPushRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge not assembled yet */ },
  };
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
      rawUserId.startsWith(MASTER_USER_PREFIX) ? rawUserId : MASTER_USER_PREFIX + rawUserId,
      costCredits, sessionId, parentSessionId, delegateAgentId, turnKey, parentTurnKey,
    );
  const makeDurableEngineBillingDeps = (subsys: string) => ({
    pgPool: getPool(),
    preCheckRedis,
    pricing,
    logger: rootLogger.child({ subsys }),
    appendCostCredits: appendCostCreditsForUser,
    broadcastToUser: (uid: bigint, payload: Record<string, unknown>) => bridgeBroadcastRef.current(uid, payload),
  });
  const durableCursorBillingDeps = () => makeDurableEngineBillingDeps("durableCursorBilling");
  const durableAntigravityBillingDeps = () => makeDurableEngineBillingDeps("durableAntigravityBilling");
  const settleTapeEngineBilling = async (
    userId: bigint,
    billing: import("@openclaude/protocol").DurableCodexBilling,
  ): Promise<void> => {
    if (isCursorDurableBilling(billing)) return void (await settleDurableCursorBilling(durableCursorBillingDeps(), userId, billing));
    if (isAntigravityDurableBilling(billing)) return void (await settleDurableAntigravityBilling(durableAntigravityBillingDeps(), userId, billing));
    await settleDurableCodexBilling(
      { pgPool: getPool(), preCheckRedis, pricing, logger: rootLogger.child({ subsys: "durableCodexBilling" }) },
      userId,
      billing,
    );
  };
  // P1.7 slice 7c — broker 前向引用。dispatchInternal 在 line ~883 装配,需要路由
  // `/internal/v3/wechat-outbound` → broker.outboundHandler;但 broker 本身依赖
  // resolveContainerEndpoint(line ~1529)装配完才能 makeInboundDispatcher → makeWechatBroker。
  // 这层 ref 把"路由表"(dispatchInternal)与"broker 实例"装配顺序解耦,与
  // bridgeBroadcastRef 同型:proxy 闭包总读 ref.current,broker 未就绪时短路 404 不 throw。
  const wechatBrokerRef: { current: WechatBroker | null } = { current: null };
  const autoDreamOptimizerRuntimeRef: { current: AutoDreamOptimizerRuntime | null } = {
    current: null,
  };
  const commercialCodexRouteRef: {
    current: ((args: {
      containerId: number
      userId: bigint
      modelId: string
      sessionId?: string
    }) => Promise<AdvisorCodexSelectorDecision>) | null
  } = { current: null }
  const delegateEngineBillingRuntimeRef: { current: DelegateEngineBillingRuntime | null } = {
    current: null,
  };
  const cc5RuntimeRef: { current: ReturnType<typeof createMasterCc5Runtime> } = {
    current: undefined,
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
  let systemActions: ReturnType<typeof assembleSystemActions> | undefined;

  ({
    internalProxyServer,
    internalProxyHandler,
    internalProxyAddress,
    dispatchInternal,
    controlListener,
  } = await bootstrapInternalProxyAndListeners({
    env: process.env,
    cfg,
    runtimeChannel,
    ocSlot,
    dualMasterEnabled,
    egressSplitEnabled,
    skipInternalProxy: options.skipInternalProxy,
    proxyBind,
    proxyPort,
    selfHostUuid,
    flavorIdentity,
    jwtSecret,
    redis,
    sharedRateLimitRedis,
    preCheckRedis,
    pricing,
    scheduler,
    healthTracker,
    loadUserModelAuthz,
    triggerCodexDisableFanout,
    appendCostCreditsForUser,
    losslessTurnTapeStorage,
    dispatchAdmissionBackend,
    settleTapeEngineBilling,
    pluginFacade,
    mediaGenerationService,
    museHub,
    sitesService,
    studioHttp,
    allocateGrokRelayRoute,
    createGrokRelayHandler: (identityRepo) =>
      makeGrokRelayHandler({
        identityRepo,
        logger: rootLogger.child({ subsys: "grokRelay" }),
        recordStatus: makeGrokRelayHealthRecorder({ health: healthTracker }),
        renewSlot: (accountId, slotId) => {
          if (!scheduler.renewCodexSlot(accountId, slotId)) {
            scheduler.restoreCodexSlot(accountId, slotId);
          }
          return true;
        },
      }),
    verifyEgressSecret: (presented, expected) => {
      const pBuf = Buffer.from(presented, "utf8");
      const eBuf = Buffer.from(expected, "utf8");
      return pBuf.length === eBuf.length && pBuf.length > 0 && timingSafeEqual(pBuf, eBuf);
    },
    createHttpServer,
    deployDesiredWatch,
    leaderLease,
    slotRelayClient,
    slotRelayLocalRef,
    bridgeBroadcastRef,
    studioPushRef,
    tapeSchedulerKickRef,
    autoDreamOptimizerRuntimeRef,
    commercialCodexRouteRef,
    delegateEngineBillingRuntimeRef,
    cc5RuntimeRef,
    wechatBrokerRef,
    wechatProactiveRef,
    qqOutboundRef,
    qqProactiveRef,
    getModelAuthoritySigner: () => modelAuthoritySigner,
    getArtifactBlobStore: () => artifactBlobStore,
    getCronOriginBridge: () => cronOriginBridgeRef,
    getSystemActions: () => systemActions,
    setDesktopTlsClose: (fn) => { desktopTlsClose = fn; },
    setSeedPlatformAgentsForLeadership: (fn) => { seedPlatformAgentsForLeadership = fn; },
    setStopStudioOrchestrator: (fn) => { stopStudioOrchestrator = fn; },
  }));

  const {
    externalApiKeyProxy,
    externalApiKeyModels,
    externalApiKeyUsage,
    cursorExternalRoute,
    cursorExternalOutbox,
  } = await bootstrapExternalApiKeyProxy({
    skipInternalProxy: options.skipInternalProxy,
    cfg,
    pricing,
    preCheckRedis,
    scheduler,
    healthTracker,
    loadUserModelAuthz,
    sharedRateLimitRedis,
    triggerCodexDisableFanout,
    bridgeBroadcastRef,
    appendCostCreditsForUser,
    cursorExternalOutboxDir,
  });

  ({ externalMtlsServer, externalMtlsAddress } = await bootstrapExternalMtlsListener({
    cfg,
    internalProxyHandler,
    dispatchInternal,
    createHttpsServer,
    constantTimeEqual: timingSafeEqual,
    isIPv4,
  }));

  const {
    mailer,
    bridgeSecret,
    mediaSignKey,
    wechatLiveLinkKey,
    thumbnailCache,
    artifactBlobStore: bootArtifactBlobStore,
    modelAuthorityProvisionRequired,
    modelAuthoritySigner: bootModelAuthoritySigner,
    modelCatalogCache: bootModelCatalogCache,
  } = await bootstrapMailerBridgeAndAuthority({ env: process.env });
  artifactBlobStore = bootArtifactBlobStore;
  modelAuthoritySigner = bootModelAuthoritySigner;
  modelCatalogCache = bootModelCatalogCache;

  // V3 Phase 3 supervisor 装配 —— 必须在 createCommercialHandler 之前构造,
  // 因为 admin/containers HIGH#6 路径要在 deps.v3Supervisor 上 dispatch v3 行。
  // 见下方 idleSweep / volumeGc / orphanReconcile / makeV3EnsureRunning 都复用 v3Deps。
  let v3Deps: V3SupervisorDeps | undefined;
  let cc5Runtime: ReturnType<typeof createMasterCc5Runtime>;
  if (cfg.OC_RUNTIME_IMAGE) {
    const assembled = assembleV3SupervisorCore({
      env: process.env,
      cfg,
      flavorIdentity,
      bridgeSecret,
      modelAuthoritySigner,
      modelAuthorityProvisionRequired,
      modelCatalogCache,
      preCheckRedis,
      loadUserModelAuthz,
      selfHostUuid,
      sessionsDeletedRef,
    });
    const v3Docker = assembled.v3Docker;
    v3Deps = assembled.v3Deps;
    cc5Runtime = assembled.cc5Runtime;
    cc5RuntimeRef.current = cc5Runtime;

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

    if (controlPlaneEnabled && process.env.OC_PREHEAT_DISABLED !== "1") {
      void preheatV3Image(v3Docker, cfg.OC_RUNTIME_IMAGE, {
        info: (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn: (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
      }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[commercial] v3 preheat unexpectedly threw", { error: (err as Error)?.message ?? String(err) });
      });

      if (process.env.OC_IMAGE_DISTRIBUTE_DISABLED !== "1") {
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
            trackScheduler("imagePromote", "shared", getImagePromoteScheduler({ imageTag: cfg.OC_RUNTIME_IMAGE })).start();
          })
          .catch((err: unknown) => {
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
  wireRemoteMuxDeps();

  const containerPreviewBaseUrl = process.env.COMMERCIAL_BASE_URL?.trim();
  const { containerPreviewTickets, liveBrowserTickets } = createPreviewAndLiveBrowserTickets({ runtimeChannel, modelAuthoritySigner, v3Deps, baseUrl: containerPreviewBaseUrl });

  const {
    sharedEnsureRunning,
    ensureContainerEndpointReady,
    preheatUserContainer,
    prepareWorkspaceContainer,
    prewarmContainer,
    userMediaResolver,
    pushRemoteHostUpload,
    chatgptProxyServer: initialChatgptProxyServer,
    chatgptProxyHttp,
  } = buildContainerHelpersAndPreview({
    env: process.env,
    runtimeChannel,
    v3Deps,
    agentRuntimeDocker: agentRuntime?.docker,
    bridgeSecret,
    loadUserModelAuthz,
    dispatchAdmissionBackend,
    modelAuthoritySigner,
    gatewayPort: options.gatewayPort,
    containerPreviewTickets,
    containerPreviewBaseUrl,
  });
  let chatgptProxyServer = initialChatgptProxyServer;
  const ensureContainerReady: ((uid: bigint) => Promise<void>) | undefined =
    ensureContainerEndpointReady;
  museDeliveryRefs.resolveMedia = userMediaResolver;
  knowledgePlanetMediaResolverRef.current = userMediaResolver;
  museDeliveryRefs.pushRemote = pushRemoteHostUpload;

  const chunkHooks = createRemoteHostChunkHooks();
  const dockerEnsureRunning: ResolveContainerEndpoint =
    makeInboundChannelResolver(sharedEnsureRunning);
  const resolveContainerEndpoint: ResolveContainerEndpoint =
    options.resolveContainerEndpoint
    ?? makeDesktopOrDockerResolver(sharedEnsureRunning);
  let directContainerPreview: DirectContainerPreviewService | undefined =
    createOptionalDirectContainerPreview({
      env: process.env,
      containerPreviewTickets,
      modelAuthoritySigner,
      containerPreviewBaseUrl,
      dockerEnsureRunning,
      gatewayPort: options.gatewayPort,
    });

  const resolvePromptPrivacySupport = makePromptPrivacySupportResolver({
    inspect: async userId => v3Deps ? getV3ContainerStatus(v3Deps, userId) : null,
    validatedReleasePath: v3Deps?.runtimeTuple?.releaseResolvedPath,
  });
  const modelSwitchCost = makeModelSwitchCostService({pool:getPool(),pricing,secret:jwtSecret}, loadUserModelAuthz);
  if (process.env.OC_SYSTEM_ACTIONS_ENABLED === '1') {
    if (runtimeChannel !== 'v5' || flavorIdentity.status !== 'ok' || flavorIdentity.flavor !== 'selfhost' || !v3Deps) {
      throw new Error('System actions require the verified personal Docker deployment');
    }
    systemActions = assembleSystemActions({
      stateParent: '/var/lib/openclaude-v5-selfhost',
      jwtSecret,
      firstPartyOrigin: process.env.COMMERCIAL_BASE_URL ?? '',
      runner: getPool(),
      identityRepo: createPgIdentityRepo(),
      privacySupported: async userId => (await resolvePromptPrivacySupport(userId)).state === 'ready',
      modelReads: { catalog: peekModelCatalogCache() ?? undefined, loadUserModelAuthz, getDegradedProviders },
      stateReads: { sessions: systemSessionReadBackend, readProject: (uid, id) => readPgChatProject(getPool(), uid, id), readRuntimeStatus: makeSystemRuntimeStatusRead(v3Deps) },
    });
  }
  // Commissioning needs a live v3 runtime: the container identity it binds must come from the
  // same getV3ContainerStatus source as live lane admission. Without v3Deps the service stays
  // undefined (503) rather than falling back to any other container source.
  const codexCommissioning = runtimeChannel === "v5" && flavorIdentity.status === "ok" && flavorIdentity.flavor === "selfhost"
    && modelAuthoritySigner && modelAuthorityProvisionRequired && modelCatalogCache && v3Deps
    ? new CodexCommissioning({pool:getPool(),preCheckRedis,catalog:modelCatalogCache,keyring:()=>modelAuthoritySigner!.publicKeyring(),
      signer:modelAuthoritySigner,loadUserModelAuthz,log:rootLogger.child({subsys:"codexCommissioning"}),
      containerSource:makeAdminCommissionContainerSource(v3Deps)}) : undefined;
  const v4ExecutorDeps = runtimeChannel === "v5" && flavorIdentity.status === "ok" && flavorIdentity.flavor === "selfhost"
    && modelAuthoritySigner && modelAuthorityProvisionRequired && modelCatalogCache && v3Deps
    ? { pool: getPool(), preCheckRedis, catalog: modelCatalogCache, keyring: () => modelAuthoritySigner!.publicKeyring(),
        signer: modelAuthoritySigner, loadUserModelAuthz, log: rootLogger.child({ subsys: "remoteDriverV4" }),
        containerSource: makeAdminCommissionContainerSource(v3Deps) }
    : undefined;
  const remoteDriverV4 = v4ExecutorDeps
    ? new RemoteDriverV4CommissioningService({ executorDeps: v4ExecutorDeps })
    : undefined;
  const qqBotServiceRef: { current: QqBotService | undefined } = { current: undefined };
  const pendingDecisionsRuntime = createCommercialPendingDecisionsRuntime({
    pool: getPool(),
    v3Supervisor: v3Deps,
    bridgeSecret,
    onControlAdmitted: (uid) => cronOriginBridgeRef?.drainControlsForUser?.(uid) ?? Promise.resolve(),
    pushToWechat: (item) => wechatBrokerRef.current?.pushPendingDecision(item) ?? Promise.resolve(),
    pushToQq: (item) => qqBotServiceRef.current?.pushPendingDecision(item) ?? Promise.resolve(),
  });
  const handler = createCommercialHandler({
    codexCommissioning,
    remoteDriverV4,
    modelSwitchCost,
    jwtSecret,
    ...systemActions?.http,
    mediaGeneration: mediaGenerationService,
    sites: sitesService,
    museBridgeHttp,
    museHub,
    studio: studioHttp,
    goalStateService,
    pendingDecisionsService: pendingDecisionsRuntime.service,
    containerPreviewTickets,
    containerPreviewAvailable: () => containerPreviewBridge !== undefined,
    liveBrowserTickets,
    liveBrowserStreamAvailable: () => containerPreviewBridge !== undefined,
    directContainerPreview,
    chatgptProxy: chatgptProxyHttp,
    pluginRuntime: pluginFacade,
    knowledgePlanetSetup,
    weiboSetup,
    literatureSetup,
    literatureArtifacts,
    zhihuSetup,
    biliAccountSetup,
    douyinSetup,
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
    resolvePromptPrivacySupport,
    prewarmContainer,
    prepareWorkspaceContainer,
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
    externalApiKeyModels,
    externalApiKeyUsage,
  });

  // legacy /ws/agent(T-52 老 agent runtime WS 入口)已删除;v5 一律走 /ws/user-chat-bridge。

  // V3 Phase 2 Task 2H + Phase 3D:用户 WS ↔ 容器 WS 桥接(/ws/user-chat-bridge)。
  //
  // userChatBridge resolveContainerEndpoint 的解析顺序(高优先 → 低优先):
  //   1. options.resolveContainerEndpoint(测试 / 显式覆盖;只覆盖 chat,不覆盖渠道 inbound)
  //   2. makeDesktopOrDockerResolver(sharedEnsureRunning)(生产默认)
  //   3. 无 docker ensure → stub `supervisor_not_wired`
  // WeChat / QQ / preview 走 dockerEnsureRunning,不受 options stub 影响。
  //
  // 注:v3Deps 已在 createCommercialHandler 之前装配(HIGH#6 admin v3 dispatch 需要)。

  // ── P3:容器面 shared 调度器收口 LeaderBundle(RFC D4)──────────────────────────
  // 旧模型每个都 `if (controlPlaneEnabled && ...)` eager-start;双 master 下会双跑(双误杀/双删卷/
  // 双对账竞态)。改造:membership = 各自 deps(v3Deps)+ *_DISABLED(不含 leadership),启动时机
  // 交给 lease(v5)/ controlPlaneEnabled(legacy)统一触发。trackScheduler 留在 start 闭包内
  // (注册进 schedulerRegistry + 满足 scheduler-wiring lint);drain 时 bundle 经 onMemberStopped 摘除。
  // orphanReconcile 曾以 v5-owned `||v5` 双跑(错峰缓解),P3 归入 leader 单跑=正解(消错峰假设)。
  if (cursorExternalOutbox) {
    const outbox = cursorExternalOutbox;
    leaderBundle.add({
      name: "cursorExternalApiOutbox",
      domain: "v5-owned",
      required: false,
      start: () => {
        const h = trackScheduler(
          "cursorExternalApiOutbox",
          "v5-owned",
          outbox.startScanner({
            pool: getPool(),
            pricing,
            logger: rootLogger.child({ subsys: "cursorExternalApiOutbox" }),
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }

  if (v3Deps && process.env.OC_IDLE_SWEEP_DISABLED !== "1") {
    const deps = v3Deps;
    leaderBundle.add({
      name: "idleSweep",
      domain: "shared",
      start: () => {
        const idleSweepLog = rootLogger.child({ subsys: "v3/idleSweep" });
        const h = trackScheduler("idleSweep", "shared", startIdleSweepScheduler(deps, { logger: idleSweepLog, runOnStart: false, batchLimit: INITIAL_SWEEP_BATCH_LIMIT }));
        idleSweepLog.info("scheduler started", { tickSec: 60, idleCutoffMin: 30, batchLimit: INITIAL_SWEEP_BATCH_LIMIT });
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

  let containerPreviewBridge: ContainerPreviewBridgeHandler | undefined =
    createOptionalContainerPreviewBridge({
      env: process.env,
      containerPreviewTickets,
      liveBrowserTickets,
      modelAuthoritySigner,
      containerPreviewBaseUrl,
      dockerEnsureRunning,
    });

  // ─── wechat codex(gpt-*) turn + Auto-Dream V2 + QQ Official Bot + WeChat broker ───
  const {
    readCodexSessionMaxMs,
    newCodexRequestId,
    expireCodexRouteToken,
    failWechatCodexTurn,
    handleWechatCodexBilling,
    prepareWechatCodexTurn,
  } = createCommercialCodexAndWechatTurns({
    env: process.env,
    pricing,
    preCheckRedis,
    randomBytesHex: (size) => randomBytes(size).toString("hex"),
  });
  const createCommercialCodexRoute = async ({
    containerId,
    userId,
    modelId,
    sessionId,
  }: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
  }) => {
    if (isGrokEngineModel(modelId)) {
      return allocateGrokRelayRoute({ containerId, userId, modelId, sessionId });
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
  commercialCodexRouteRef.current = (args) => createCommercialCodexRoute(args);

  autoDreamOptimizerRuntimeRef.current = createAutoDreamOptimizerRuntime({
    pricing,
    preCheckRedis,
    createCommercialCodexRoute,
    expireCodexRouteToken,
    newCodexRequestId,
    readCodexSessionMaxMs,
    hmacSha256Hex: (input) => createHmac("sha256", jwtSecret).update(input).digest("hex"),
  });

  const qqConfig = readQqBotConfig(process.env);
  let qqBotService: QqBotService | undefined;
  if (qqConfig) {
    if (!bridgeSecret) {
      throw new Error("QQ Bot is configured but the container bridge secret is unavailable");
    }
    const qqBuilt = buildQqBotServiceAndReceivers({
      qqConfig,
      bridgeSecret,
      dockerEnsureRunning,
      pricing,
      loadUserModelAuthz,
      allowedInboundModels: ALLOWED_INBOUND_MODELS,
      prepareWechatCodexTurn,
      failWechatCodexTurn,
      handleWechatCodexBilling,
      userMediaResolver,
      ensureContainerEndpointReady,
      pushRemoteHostUpload,
      remoteControl: pendingDecisionsRuntime.qqRemoteControl,
    });
    qqBotService = qqBuilt.qqBotService;
    qqBotServiceRef.current = qqBotService;
    qqOutboundRef.current = qqBuilt.qqOutbound;
    qqProactiveRef.current = qqBuilt.qqProactive;
    leaderBundle.add({
      name: "qqBot",
      domain: "shared",
      start: async () => {
        await qqBotService!.start();
        return { stop: () => qqBotService!.stop() };
      },
    });
  }

  let wechatBroker: WechatBroker | undefined;
  if (controlPlaneEnabled && cfg.WECHAT_BROKER_ENABLED && bridgeSecret) {
    const wechatLog = rootLogger.child({ subsys: "wechatBrokerAssembly" });
    const { wechatProactive, brokerConfig } = buildWechatBrokerDeps({
      bridgeSecret,
      redis,
      dockerEnsureRunning,
      pricing,
      loadUserModelAuthz,
      allowedInboundModels: ALLOWED_INBOUND_MODELS,
      prepareWechatCodexTurn,
      failWechatCodexTurn,
      handleWechatCodexBilling,
      userMediaResolver,
      pushRemoteHostUpload,
      wechatLiveLinkKey,
      remoteControl: pendingDecisionsRuntime.wechatRemoteControl,
    });
    wechatProactiveRef.current = wechatProactive;
    wechatBroker = trackScheduler("wechatBroker", "shared", makeWechatBroker(brokerConfig));
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

  const codexBinding: CodexBindingHandle | undefined = createCodexBindingHandle({
    env: process.env,
    v3Deps,
    scheduler,
  });

  const containerLinkOn = containerLinkEnabled(flavorIdentity.status === "ok" ? flavorIdentity.flavor : undefined);
  const { userChatBridge, recoveryDecisionBroadcast } = createCommercialUserChatBridge({
    env: process.env,
    cfg,
    runtimeChannel,
    dualMasterEnabled,
    flavorIdentity,
    v3Deps,
    cc5Runtime,
    containerLinkOn,
    modelSwitchCost,
    jwtSecret,
    systemActions,
    resolveContainerEndpoint,
    modelAuthoritySigner,
    modelCatalogCache,
    webDistDir: options.webDistDir,
    loadUserModelAuthz,
    pricing,
    goalStateService,
    dispatchAdmissionBackend,
    codexBinding,
    createCommercialCodexRoute,
    scheduler,
    preCheckRedis,
    selfHostUuid,
    appendCostCreditsForUser,
    slotRelayClient,
  });
  cronOriginBridgeRef = userChatBridge;
  bridgeBroadcastRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };
  recoveryDecisionBroadcastRef.current = recoveryDecisionBroadcast;
  goalBroadcastRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };
  studioPushRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };
  goalSyncRef.current = (uid, payload) => {
    userChatBridge.syncGoalToContainers(uid, payload);
  };
  slotRelayLocalRef.current = {
    onlineUserSubset: (uids) => userChatBridge.onlineUserSubset(uids),
    broadcastToUsers: (uids, payload) => userChatBridge.broadcastToUsers(uids, payload),
  };

  // Browser voice input. A usable OpenAI key buffers the clip and posts it to
  // gpt-transcribe. Otherwise MediaRecorder streams to Deepgram Nova-3.
  // Then one-shot DeepSeek V4 Flash (OpenCode Go) context polish after stop.
  // Master-only commercial path: no runtime image rebuild required.
  const voiceTranscribeHandler: VoiceTranscribeHandler = createVoiceTranscribeHandler({
    jwtSecret,
    deepgramApiKey: cfg.DEEPGRAM_API_KEY,
    resolveOpenAiApiKey: () => selectOpenAiPlatformKey("voice-transcribe"),
    openCodeGoApiKey: cfg.OPENCODE_GO_API_KEY,
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

  if (process.env.OC_DESKTOP_ENROLL_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "desktopEnrollSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("desktopEnrollSweep", "shared", startDesktopEnrollmentSweep());
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

  // OCV5-424 — 各服务池共用的唯一恢复 actor(policy/registry):到期普通冷却半开、
  // 认证/凭证冷却到期探测(成功回 active,失败加大退避,不确定则稍后再探)。
  // 各池只注册适配器,不各自起定时器。默认 60s tick(下限 1s 防 typo)。
  // 关闭:`COMMERCIAL_COOLDOWN_RECOVERY_DISABLED=1`(测试 / 应急)。
  registerPoolAdapter(createAccountPoolAdapter({ health: healthTracker, triggerCodexDisableFanout }));
  registerPoolAdapter(createApiKeyPoolAdapter());
  registerPoolAdapter(createRelayKeyPoolAdapter());
  // OCV5-424 user affinity caps: admin system settings, cached 60s in policy/affinity.
  configureAffinitySettings(async () => ({
    maxUsersPerSubscription: (await getSystemSetting("pool_affinity_max_users_per_subscription")).value,
    ratePerMin: (await getSystemSetting("pool_affinity_rate_per_min")).value,
    antigravityInflight: (await getSystemSetting("pool_affinity_antigravity_inflight")).value,
    antigravityRatePerMin: (await getSystemSetting("pool_affinity_antigravity_rate_per_min")).value,
  }));
  registerPoolAdapter(createGeminiPoolAdapter({
    clientSecret: () => process.env.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ?? "",
  }));
  registerRemoteBrainPoolAdapter();
  if (process.env.COMMERCIAL_COOLDOWN_RECOVERY_DISABLED !== "1") {
    leaderBundle.add({
      name: "cooldownRecovery",
      domain: "shared",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_COOLDOWN_RECOVERY_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
        const h = trackScheduler("cooldownRecovery", "shared", startPoolRecoveryActor({ intervalMs }));
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
        const preparation = trackScheduler("cursorAuthSync", "v5-owned", startCursorSandPreparationActor());
        const h = trackScheduler("cursorAuthSync", "v5-owned", startCursorAuthSyncActor({ intervalMs }));
        return { stop: async () => { await Promise.all([h.stop(), preparation.stop()]); } };
      },
    });
  }

  // 0262 — Cursor Sand (Grok Bot) usage sweeper. Hourly, per session row:
  // cursor.com get-sand-usage-status → claude_accounts.cursor_sand_* columns
  // → `.slot-weight` sidecar via the materializer. Leader-only (one set of
  // cursor.com calls per pool, and the materializer already runs here).
  if (process.env.COMMERCIAL_CURSOR_USAGE_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorUsageSweep",
      domain: "v5-owned",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_CURSOR_USAGE_SWEEP_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000;
        const h = trackScheduler("cursorUsageSweep", "v5-owned", startCursorUsageSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // 0276 — Grok Build (xAI subscription) usage sweeper. Hourly, per grok
  // row: cli-chat-proxy /billing + /user → claude_accounts.grok_* columns.
  // Leader-only (one set of xAI calls per pool). No materializer: grok has
  // no sidecar. Direct egress only (sing-box IPv6 RST).
  if (process.env.COMMERCIAL_GROK_USAGE_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "grokUsageSweep",
      domain: "v5-owned",
      start: () => {
        const raw = Number(process.env.COMMERCIAL_GROK_USAGE_SWEEP_INTERVAL_MS);
        const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000;
        const h = trackScheduler("grokUsageSweep", "v5-owned", startGrokUsageSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }

  // A1 — pending 订单 expirer(默认 60s tick,部署即 boot 跑一次清历史脏单)。
  // markOrderPaid 不在事务内对 expires_at 做硬防线(避免用户超时几秒扫码就硬失败
  // 的体验回归);过期清理由本 sweeper 负责,被推 expired 后 markOrderPaid 自然拒。
  // 非法 / 空 / NaN → 60s;下限 1s(防 typo 把 DB 打穿)
  if (shouldStartCommercialScheduler("pendingOrdersExpirer", { flavorIdentity, runtimeChannel, paymentEnabled: Boolean(hupijiao) })) {
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
    // Local ProxyAgent cleanup state must outlive a temporary loss of shared
    // leadership. Only the scheduler starts/stops on each leader term.
    const boxFailureDiagnostics = createBoxFailureDiagnostics(process.env.OC_PLATFORM_ROOT);
    const boxRemoteCleanup = new BoxRemoteCleanupWorker({
      beforeCleanup: boxFailureDiagnostics?.beforeCleanup,
      sweepDiagnostics: boxFailureDiagnostics ? () => boxFailureDiagnostics.sweep() : undefined,
      journal: new BoxDurableJournal(getPool()),
      resolver: createProductionBoxAccountResolver(),
      writeRecoveryMessage: createBoxReplayRecoveryWriter(process.env.OC_PLATFORM_ROOT),
      holds: new BoxHoldRelease(getPool()),
      // OCV5-488: every automatic release of a run gone from the Box is told once.
      onProcessAbsentClosed: (closed) => safeEnqueueAlert({
        event_type: ALERT_EVENTS.OPS_BOX_HOLD_RELEASED, severity: "info",
        title: `Box 占位已自动释放(账号 ${closed.accountId})`,
        body: `运行 ${closed.requestId.slice(0, 12)} 在 Box 上已无进程`
          + `${closed.rebooted ? "(Box 重启过)" : "(两次确认)"},按 ${closed.shape} 收口,金额未变。`,
        payload: { requestId: closed.requestId, accountId: closed.accountId.toString(),
          shape: closed.shape, rebooted: closed.rebooted },
        dedupe_key: `${ALERT_EVENTS.OPS_BOX_HOLD_RELEASED}:${closed.requestId}`,
      }),
    });
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
          boxRecoveryFn: async () => {
            const results = await Promise.allSettled([
              reconcileBoxBillingBatch(getPool(), 20, preCheckRedis),
              boxRemoteCleanup.reconcileBatch(10),
              recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis,
                log: rootLogger.child({ subsys: "remoteNativeBillingRecovery" }) }, { limit: 20 }),
            ]);
            if (results.some((result) => result.status === "rejected")) {
              throw new Error("BOX_RECOVERY_PARTIAL_FAILURE");
            }
          },
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

  // tape materialization + settlement jobs (design 2026-08-19 rev2). Dedicated pool
  // uses 120s statement_timeout so 67MB finalize is not the request-path 30s cap.
  if (runtimeChannel === "v5" && process.env.COMMERCIAL_TAPE_MATERIALIZATION_DISABLED !== "1") {
    leaderBundle.add({
      name: "tapeJobScheduler",
      domain: "shared",
      start: () => {
        const { materializePool, schedulerOpts } = buildTapeJobSchedulerSetup({
          env: process.env,
          sessionsStoreGeneration,
          recoveryDecisionBroadcastRef,
          settleTapeEngineBilling,
        });
        const h = trackScheduler("tapeJobScheduler", "shared", startTapeJobScheduler(schedulerOpts));
        wireTapeSchedulerKick(tapeSchedulerKickRef, () => h.runNow());
        return {
          stop: async () => {
            tapeSchedulerKickRef.current = () => { /* scheduler stopped */ };
            await h.stop();
            await materializePool.end();
          },
        };
      },
    });
  }

  if (runtimeChannel === "v5" && process.env.COMMERCIAL_TURN_DISPATCH_RECONCILER_DISABLED !== "1") {
    const dispatchBridgeSecret = bridgeSecret;
    leaderBundle.add({
      name: "turnDispatchReconciler",
      domain: "shared",
      start: () => {
        const { intervalMs, reconcilerDeps } = buildTurnDispatchReconcilerConfig({
          env: process.env,
          bridgeSecret: dispatchBridgeSecret,
          dispatchAdmissionBackend,
          containerLinkOn,
          preCheckRedis,
          userChatBridge,
        });
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

  // Cursor pending-audit & Antigravity stale-turn reconcilers.
  if (runtimeChannel === "v5" && process.env.COMMERCIAL_CURSOR_AUDIT_RECONCILER_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorAuditReconciler",
      domain: "shared",
      start: () => {
        const rawInterval = Number(process.env.COMMERCIAL_CURSOR_AUDIT_RECONCILER_INTERVAL_MS);
        const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 5000 ? rawInterval : 60_000;
        const zeroChargeBefore =
          parseZeroChargeCutoff(process.env.COMMERCIAL_CURSOR_AUDIT_BACKFILL_ZERO_CHARGE_BEFORE)
          ?? new Date();
        const h = trackScheduler("cursorAuditReconciler", "shared", startCursorAuditReconciler({
          ...durableCursorBillingDeps(),
          pool: getPool(),
          zeroChargeBefore,
          intervalMs,
          runOnStart: true,
        }));
        rootLogger.info("cursorAuditReconciler started", { intervalMs, zeroChargeBefore: zeroChargeBefore.toISOString() });
        return { stop: () => h.stop() };
      },
    });
  }
  if (runtimeChannel === "v5" && !cfg.COMMERCIAL_ANTIGRAVITY_RECONCILER_DISABLED) {
    leaderBundle.add({
      name: "antigravityTurnReconciler",
      domain: "shared",
      start: () => {
        const rawInterval = cfg.COMMERCIAL_ANTIGRAVITY_RECONCILER_INTERVAL_MS;
        const intervalMs = typeof rawInterval === "number" && rawInterval >= 5000 ? rawInterval : 60_000;
        const h = trackScheduler("antigravityTurnReconciler", "shared", startAntigravityTurnReconciler({ ...durableAntigravityBillingDeps(), intervalMs, runOnStart: true }));
        rootLogger.info("antigravityTurnReconciler started", { intervalMs });
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
  // handler map:R5 Phase A 起接 research_task(mode=fetch 批量全文下载,见
  // research/fetchJobs.ts);其余 kind 仍留 DI seam 待后续期注入.
  let researchJobScheduler: ResearchJobSchedulerHandle | undefined;
  if (
    (controlPlaneEnabled || runtimeChannel === "v5") &&
    process.env.COMMERCIAL_RESEARCH_JOBS_DISABLED !== "1"
  ) {
    const raw = Number(process.env.COMMERCIAL_RESEARCH_JOBS_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 2000 ? raw : 5_000;
    researchJobScheduler = trackScheduler("researchJobs", "v5-owned", startResearchJobScheduler({
      // R5 Phase A:research_task(mode=fetch)批量全文下载 —— dormant scheduler 的
      // 第一个真实 handler(逐条容错 + pdf_ingested 相位 checkpoint 续跑)。
      handlers: makeResearchFetchJobHandlers(),
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
    const wakeFn = ensureContainerReady;
    leaderBundle.add({
      name: "cronWake",
      domain: "v5-owned",
      start: () => {
        const cronWakeScheduler = trackScheduler("cronWake", "v5-owned", startCronWakeScheduler(buildCronWakeSchedulerOptions({ env: process.env, wakeFn })));
        return { stop: () => cronWakeScheduler.stop() };
      },
    });
  }

  if (shouldStartCommercialScheduler("tutorialModeration", { flavorIdentity, runtimeChannel })) trackScheduler("tutorialModeration", "v5-owned", startTutorialModerationScheduler({ apiKey: cfg.OPENCODE_GO_API_KEY, logger: rootLogger })); // OCV5-577/825
  let marketplaceAiReviewScheduler: MarketplaceAiReviewSchedulerHandle | undefined;
  if (shouldStartCommercialScheduler("marketplaceAiReview", { flavorIdentity, runtimeChannel })) {
    const raw = Number(process.env.OC_MARKETPLACE_AI_REVIEW_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 15_000;
    marketplaceAiReviewScheduler = trackScheduler("marketplaceAiReview", "v5-owned", startMarketplaceAiReviewScheduler({
      apiKey: cfg.OPENCODE_GO_API_KEY,
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
            apiKey: cfg.OPENCODE_GO_API_KEY,
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

  if (
    runtimeChannel === "v5" &&
    flavorIdentity.status === "ok" &&
    flavorIdentity.flavor === "selfhost" &&
    v4ExecutorDeps &&
    process.env.OC_REMOTE_DRIVER_DRIFT_DISABLED !== "1"
  ) {
    leaderBundle.add({
      name: "remoteDriverDrift",
      domain: "v5-owned",
      start: () => {
        const h = trackScheduler("remoteDriverDrift", "v5-owned", startRemoteDriverDriftScheduler({ pool: getPool(), executorDeps: v4ExecutorDeps, log: rootLogger.child({ subsys: "remoteDriverDrift" }) }));
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
  const runtimeStatus = makeCommercialRuntimeStatus({
    channel: runtimeChannel,
    controlPlaneEnabled,
    autoMigrate: autoMigrateEffective,
    agentRuntime: agentRuntime ? "enabled" : "disabled",
    containerRuntime: v3Deps ? "enabled" : "disabled",
    schedulers: () => schedulerRegistry.map((s) => s.name),
    leadership: () => leaderLease ? leaderLease.status() : legacyLeadership(),
  });
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

  setContentReviewAlerter((event) => { void alertContentReview(event) })
  setContentReviewPrefilter(async (text) => {
    try {
      const key = await selectOpenAiPlatformKey('omni-moderate')
      const result = await omniHardHit({ apiKey: key, text, timeoutMs: 2_000 })
      return result.hit
    } catch {
      return false
    }
  })

  if (!dualMasterEnabled) void userChatBridge.rebuildContainerLinks?.();
  const stopLogTiming = startLogTimingReporter(rootLogger);
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
      // Preview & live-browser use short-lived tickets and must never fall through.
      if (containerPreviewBridge?.handleUpgrade(req, socket, head)) return true;
      if (claimUnavailableLiveBrowserUpgrade(req, socket)) return true;
      // V3: 优先匹配 voice input,再 /ws/user-chat-bridge(2E)。legacy /ws/agent 已删除。
      if (voiceTranscribeHandler.handleUpgrade(req, socket, head)) return true;
      if (userChatBridge.handleUpgrade(req, socket, head)) return true;
      return false;
    },
    shutdown: createCommercialShutdown({
      stopLogTiming,
      closeSystemActionsAdmission: systemActions ? () => systemActions!.runtime.closeAdmission() : undefined,
      sessionsGcSweeper,
      wechatBroker,
      getContainerPreviewBridge: () => containerPreviewBridge,
      clearContainerPreviewBridge: () => { containerPreviewBridge = undefined; },
      getDirectContainerPreview: () => directContainerPreview,
      clearDirectContainerPreview: () => { directContainerPreview = undefined; },
      getChatgptProxyServer: () => chatgptProxyServer,
      clearChatgptProxyServer: () => { chatgptProxyServer = undefined; },
      closeMusePublic,
      stopStudioOrchestrator,
      museHub,
      voiceTranscribeHandler,
      userChatBridge,
      cursorExternalRoute,
      drainManagedWorkers: () => [
        systemActions?.runtime.closeAndDrain(),
        knowledgePlanetSetup?.closeAndDrain(),
        weiboSetup?.closeAndDrain(),
        literatureSetup.close(),
        Promise.resolve().then(() => literatureArtifacts?.close()),
        zhihuSetup?.closeAndDrain(),
        biliAccountSetup?.closeAndDrain(),
        douyinSetup?.closeAndDrain(),
      ],
      leaderLease,
      leaderBundle,
      getTurnDispatchShutdownHandoff: () => turnDispatchShutdownHandoff,
      controlListener,
      deployDesiredWatch,
      lifecycleScheduler,
      codexRefreshActor,
      subscriptionRolloverSweeper,
      accountSlotReaper,
      logLevelSync,
      codexDriftReconciler,
      researchJobScheduler,
      marketplaceAiReviewScheduler,
      providerHealthScheduler,
      baselineSrv,
      internalProxyServer,
      externalMtlsServer,
      getDesktopTlsClose: () => desktopTlsClose,
      disposePendingDecisions: () => pendingDecisionsRuntime.dispose(),
      clearGatewayProviders: () => {
        try { setModelHintProvider(null); } catch { /* ignore */ }
        try { setHostStaticProviderKeys(null); } catch { /* ignore */ }
        try { setLiteratureSkillProvider(null); } catch { /* ignore */ }
      },
      pricing,
      redis,
    }),
    /** V3 2H 测试 / /healthz 探测用:内部代理实际监听地址(undefined = 未启用)。 */
    internalProxyAddress,
    /** V3 D.1b 测试 / /healthz 探测用:外部 mTLS 监听地址(undefined = 未启用)。 */
    externalMtlsAddress,
    // 已规范化为 ≥32 byte Uint8Array,gateway 可直接喂 createHmac
    jwtSecret: secretToKey(jwtSecret),
    resolveUserMediaDirs: userMediaResolver,
    isUserVolumeMediaPath,
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
    preheatUserContainer,
    pushRemoteHostUpload,
    pullRemoteHostMedia: async (args: {
      hostUuid: string;
      remotePath: string;
    }) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await nodeAgentGetFile(target, args.remotePath);
      } finally {
        target.psk?.fill(0);
      }
    },
    ...chunkHooks,
    probeDeps: createCommercialProbeDeps(redis),
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
export { adminAdjust, listLedger, InsufficientCreditsError, LEDGER_REASONS } from "./billing/ledger.js";
export type { LedgerReason, LedgerRef, DebitResult, AdminAdjustResult, LedgerRow } from "./billing/ledger.js";
export { preCheck, preCheckWithCost, readTotalSpendableBalance, releasePreCheck, estimateMaxCost, InsufficientCreditsError as PreCheckInsufficientCreditsError, InMemoryPreCheckRedis, wrapIoredisForPreCheck } from "./billing/preCheck.js";
export type { PreCheckRedis, PreCheckInput, PreCheckWithCostInput, PreCheckResult, ReservationHandle, AtomicReserveResult } from "./billing/preCheck.js";
export { signHupijiao, verifyHupijiao, buildSignBase } from "./payment/hupijiao/sign.js";
export type { SignParams } from "./payment/hupijiao/sign.js";
export { createHttpHupijiaoClient, HupijiaoError } from "./payment/hupijiao/client.js";
export type { HupijiaoClient, HupijiaoConfig, CreateQrInput, CreateQrResult } from "./payment/hupijiao/client.js";
export { listPlans, getPlanByCode, generateOrderNo, createPendingOrder, getOrderByNo, markOrderPaid, expirePendingOrders, ORDER_STATUSES, PlanNotFoundError, OrderNotFoundError, InvalidOrderStateError } from "./payment/orders.js";
export type { TopupPlan, OrderRow, OrderStatus, CreatePendingOrderInput, MarkOrderPaidInput, MarkOrderPaidResult } from "./payment/orders.js";
export { createAccount, getAccount, listAccounts, getTokenForUse, updateAccount, deleteAccount, ACCOUNT_PLANS, ACCOUNT_STATUSES, AccountNotFoundError } from "./account-pool/store.js";
export type { AccountPlan, AccountStatus, AccountRow, AccountToken, CreateAccountInput, UpdateAccountPatch, ListAccountsOptions } from "./account-pool/store.js";
export { AccountHealthTracker, InMemoryHealthRedis, wrapIoredisForHealth, healthKey, failKey, DEFAULT_FAIL_THRESHOLD, DEFAULT_COOLDOWN_MS, DEFAULT_HEALTH_TTL_SEC, DEFAULT_FAIL_WINDOW_SEC } from "./account-pool/health.js";
export type { AccountHealth, HealthRedis, HealthDeps } from "./account-pool/health.js";
export { AccountScheduler, AccountPoolUnavailableError, AccountPoolBusyError, ERR_ACCOUNT_POOL_UNAVAILABLE, ERR_ACCOUNT_POOL_BUSY, DEFAULT_MAX_CONCURRENT_PER_ACCOUNT, parseMaxConcurrentEnv, pickWRH, computeAccountWeight, defaultHash } from "./account-pool/scheduler.js";
export type { PickInput, PickResult, ReleaseInput, ReleaseResult, SchedulerDeps, CandidateRow } from "./account-pool/scheduler.js";
export { refreshAccountToken, shouldRefresh, defaultHttp, RefreshError, DEFAULT_REFRESH_SKEW_MS, DEFAULT_OAUTH_ENDPOINT, DEFAULT_FALLBACK_EXPIRES_MS } from "./account-pool/refresh.js";
export type { RefreshErrorCode, RefreshHttpClient, RefreshDeps, RefreshedTokens } from "./account-pool/refresh.js";
export { streamClaude, ProxyError, ProxyAuthError, DEFAULT_CLAUDE_ENDPOINT, DEFAULT_ANTHROPIC_VERSION, DEFAULT_MAX_SSE_BUFFER } from "./account-pool/proxy.js";
export type { ProxyEvent, ProxyDeps, StreamClaudeInput } from "./account-pool/proxy.js";
export { ConnectionRegistry, DEFAULT_MAX_PER_USER } from "./ws/connections.js";
export type { Conn, RegisterResult } from "./ws/connections.js";
export { createLogger, rootLogger, parseLevel, SENSITIVE_KEYS } from "./logging/logger.js";
export type { Logger, LogLevel, LoggerOptions } from "./logging/logger.js";
export { verifyContainerIdentity, parseContainerToken, hashSecret, compareHash, createPgIdentityRepo, ContainerIdentityError } from "./auth/containerIdentity.js";
export type { ContainerIdentity, ContainerIdentityRepo } from "./auth/containerIdentity.js";
export { makeContainerIdentityStrategy, IdentityError, AuthzLoadError, AuthzDeniedError } from "./auth/proxyIdentity.js";
export type { IdentityStrategy, ProxyIdentity, ContainerIdentityStrategyDeps } from "./auth/proxyIdentity.js";
export { makeAnthropicProxyHandler, proxyBodySchema, enforceFieldByteBudgets, estimateInputTokens, estimateMaxCostBothSides, buildSafeUpstreamHeaders, ConcurrencyLimiter, pipeStreamWithUsageCapture, DEFAULT_UPSTREAM_ENDPOINT, ANTHROPIC_VERSION, ALLOWED_BETA_VALUES, SIZE_LIMITS, MAX_BODY_BYTES_DEFAULT, MAX_MESSAGES_COUNT, MAX_TOOLS_COUNT, CHARS_PER_TOKEN_ESTIMATE, DEFAULT_PROXY_RATE_LIMIT, DEFAULT_MAX_CONCURRENT_PER_UID } from "./http/anthropicProxy.js";
export type { AnthropicProxyDeps, AnthropicProxyHandler, ProxyBody, UsageObservation, PipeStreamResult } from "./http/anthropicProxy.js";
export { startInflightJournal, makeFinalizer } from "./billing/proxyBilling.js";
export type { FinalizeContext, FinalizeOutcome, FinalizerHandle } from "./billing/proxyBilling.js";
export { runUpstreamRoundTrip } from "./http/proxy/core.js";
export type { RoundTripCtx } from "./http/proxy/core.js";
export { selectUpstreamRoute, validateUpstreamConfig, pickUpstream, releaseUpstreamSession } from "./http/proxy/upstream.js";
export type { UpstreamRoute, ConfigError, PreparedUpstreamSession, PickError, PickUpstreamDeps } from "./http/proxy/upstream.js";
export { createUserChatBridge, ContainerUnreadyError, CLOSE_BRIDGE, BRIDGE_WS_PATH } from "./ws/userChatBridge.js";
export type { UserChatBridgeDeps, UserChatBridgeHandler, ResolveContainerEndpoint, BridgeMetricSink, BridgeCloseCause } from "./ws/userChatBridge.js";
export { openAgentSubscription, getAgentStatus, cancelAgentSubscription, markContainerRunning, markContainerError, markExpiredSubscriptions, markContainerStoppedAfterExpiry, listVolumeGcCandidates, markContainerRemoved, AgentInsufficientCreditsError, AgentAlreadyActiveError, AgentNotSubscribedError, AGENT_PLAN_BASIC, DEFAULT_AGENT_PLAN_PRICE_CREDITS, DEFAULT_AGENT_PLAN_DURATION_DAYS, DEFAULT_AGENT_VOLUME_GC_DAYS, provisionContainer, runLifecycleTick, startLifecycleScheduler } from "./agent/index.js";
export type { AgentPlan, AgentSubscriptionStatus, AgentContainerStatus, OpenAgentSubscriptionInput, OpenAgentSubscriptionResult, AgentStatusView, CancelAgentSubscriptionResult, ExpiredSubscriptionRow, GcCandidateRow, ProvisionContainerOptions, LifecycleTickOptions, LifecycleTickResult, LifecycleLogger, LifecycleScheduler, StartLifecycleSchedulerOptions } from "./agent/index.js";
export type { AgentHttpDeps } from "./http/agent.js";
export { renderPrometheus, incrGatewayRequest, incrBillingDebit, incrClaudeApi, resetMetricsForTest, normalizeRoute, snapshotForAlerts } from "./admin/metrics.js";
export { startAlertScheduler, createTelegramSender, defaultRules, ruleAccountPoolAllDown, ruleNoAccountsConfigured } from "./admin/alerts.js";
export type { AlertScheduler, AlertSchedulerOptions, AlertRule, AlertSender, Snapshot } from "./admin/alerts.js";
export { PgPromptQueueStore, PromptQueueStoreError } from "./promptQueue/pgPromptQueueStore.js";
export type { PromptQueueOwner, PromptQueueDetail, PromptQueueClaimRequest, PromptQueueClaimResult } from "./promptQueue/pgPromptQueueStore.js";
