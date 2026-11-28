import type IORedis from "ioredis";
import { appendServerAuthoredMessage, classifyClientSessions } from "@openclaude/storage";
import { createAccountPoolAdapter } from "../account-pool/accountPoolAdapter.js";
import { startAccountSlotReaper, type SlotReaperHandle } from "../account-pool/accountSlotReaper.js";
import { createApiKeyPoolAdapter, createRelayKeyPoolAdapter } from "../account-pool/apiKeyPool.js";
import { startCodexRefreshActor, type CodexRefreshActorHandle } from "../account-pool/codexAccountActor.js";
import {
  enqueueCodexDisableFanout,
  startCodexDisableDriftReconciler,
  type CodexDisableFanoutDeps,
  type CodexDriftReconcilerHandle,
} from "../account-pool/codexDisableFanout.js";
import { createGeminiPoolAdapter } from "../account-pool/geminiPoolAdapter.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import { configureAffinitySettings } from "../account-pool/policy/affinity.js";
import { registerPoolAdapter } from "../account-pool/policy/registry.js";
import { registerRemoteBrainPoolAdapter } from "../account-pool/remoteBrainPool.js";
import type { AccountScheduler } from "../account-pool/scheduler.js";
import { startProviderHealthScheduler, type ProviderHealthSchedulerHandle } from "../admin/providerHealthScheduler.js";
import { getSystemSetting } from "../admin/systemSettings.js";
import { getWecomAibotConnectionManager } from "../admin/wecomAibotConnection.js";
import { startWecomAlertDispatcher } from "../admin/wecomAlertDispatcher.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "../agent-sandbox/constants.js";
import type { UserMediaLocation, V3SupervisorDeps } from "../agent-sandbox/index.js";
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../agent-sandbox/v3supervisor.js";
import type { UserModelAuthzLoader } from "../auth/userModelAuthz.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { PricingCache } from "../billing/pricing.js";
import {
  startSubscriptionRolloverSweeper,
  type SubscriptionRolloverHandle,
} from "../billing/subscriptionRolloverSweeper.js";
import type { CommercialConfig } from "../config.js";
import { getPool } from "../db/index.js";
import type { LeaderBundle } from "../deploy/leaderBundle.js";
import type { createSlotRelayClient } from "../deploy/slotRelay.js";
import type { assertFlavorIdentity } from "../flavor/assertFlavor.js";
import { isSelfhostFlavor, shouldStartCommercialScheduler } from "../flavor/commercialSchedulerPolicy.js";
import { GoalStateService } from "../goal/goalStateService.js";
import { rootLogger } from "../logging/logger.js";
import {
  startMarketplaceAiReviewScheduler,
  type MarketplaceAiReviewSchedulerHandle,
} from "../marketplace/aiReview.js";
import { MediaGenerationService } from "../media-generation/service.js";
import { createStudioFromConfig } from "../media-studio/assemble.js";
import { createMuseFromConfig } from "../muse/assemble.js";
import { selectOpenAiPlatformKey } from "../openai/openAiPlatformKey.js";
import type { createCommercialPendingDecisionsRuntime } from "./pendingDecisionsBootstrap.js";
import { readQqBotConfig } from "../qqbot/config.js";
import type { makeQqOutboundReceiver, makeQqProactiveReceiver } from "../qqbot/receiver.js";
import type { QqBotService } from "../qqbot/service.js";
import { makeResearchFetchJobHandlers } from "../research/fetchJobs.js";
import { startResearchJobScheduler, type ResearchJobSchedulerHandle } from "../research/scheduler.js";
import { startUserNoticeApproval } from "../selfheal/userNoticeApproval.js";
import { createSitesFromConfig } from "../sites/assemble.js";
import { makeWechatBroker, type WechatBroker } from "../wechat/broker.js";
import type { ProactiveReceiverHandler } from "../wechat/proactiveReceiver.js";
import type { ResolveContainerEndpoint } from "../ws/userChatBridge.js";
import { createVoiceTranscribeHandler, type VoiceTranscribeHandler } from "../ws/voiceTranscribe.js";
import {
  buildQqBotServiceAndReceivers,
  buildWechatBrokerDeps,
  type createCommercialCodexAndWechatTurns,
} from "./channelsAndAutoDreamBootstrap.js";
import {
  parseSchedulerIntervalMs as parseInterval,
  type TrackSchedulerFn,
} from "./leaderBundleBootstrap.js";

export async function bootstrapMediaAndGoalServices(args: {
  cfg: CommercialConfig;
  runtimeChannel: string;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  preCheckRedis: PreCheckRedis;
  leaderBundle: LeaderBundle;
  bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void };
  goalBroadcastRef: { current: (uid: bigint, payload: unknown) => void };
  goalSyncRef: { current: (uid: bigint, payload: unknown) => void };
  goalUsageRefreshRef: { current: (userId: string, sessionId: string) => void | Promise<void> };
}) {
  const mediaGenerationService = new MediaGenerationService({
    workerUrl: args.cfg.MEDIA_GENERATION_WORKER_URL,
    workerToken: args.cfg.MEDIA_GENERATION_WORKER_TOKEN,
    stateRoot: args.cfg.MEDIA_GENERATION_STATE_ROOT,
    allowUserIds: args.cfg.MEDIA_GENERATION_ALLOW_USER_IDS,
    maxInputBytes: args.cfg.MEDIA_GENERATION_MAX_INPUT_BYTES,
    maxUserStoredInputBytes: args.cfg.MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES,
    broadcast: (uid, frame) => args.bridgeBroadcastRef.current(uid, frame),
  });
  if (args.runtimeChannel === "v5" && mediaGenerationService.configured()) {
    args.leaderBundle.add({
      name: "mediaGeneration",
      domain: "v5-owned",
      start: () => mediaGenerationService.start(),
    });
  }
  const museDeliveryRefs: {
    pushRemote?: (a: { hostUuid: string; remotePath: string; content: Buffer }) => Promise<void>;
    resolveMedia?: (userId: string) => Promise<UserMediaLocation>;
  } = {};
  const { hub: museHub, bridgeHttp: museBridgeHttp, closePublic: closeMusePublic } =
    await createMuseFromConfig(
      args.cfg,
      getPool(),
      args.flavorIdentity.status === "ok" && args.flavorIdentity.flavor === "commercial"
        ? {
            append: appendServerAuthoredMessage,
            originActive: async (sessionId, userId) =>
              (await classifyClientSessions([{ sessionId, userId }]))[0]?.state === "active",
            resolveMedia: async (userId) => {
              if (!museDeliveryRefs.resolveMedia) throw new Error("Muse media resolver not ready");
              return museDeliveryRefs.resolveMedia(userId);
            },
            pushRemote: async (a) => {
              if (!museDeliveryRefs.pushRemote) throw new Error("Muse remote uploader not ready");
              await museDeliveryRefs.pushRemote(a);
            },
            broadcast: (uid, frame) => args.bridgeBroadcastRef.current(uid, frame),
          }
        : undefined,
    );
  const studioHttp = await createStudioFromConfig(args.cfg, getPool(), {
    preCheckRedis: args.preCheckRedis,
    museHub,
  });
  const sitesService = createSitesFromConfig(args.cfg, getPool());
  const goalStateService = new GoalStateService({
    pool: getPool(),
    broadcast: (uid, snapshot) =>
      args.goalBroadcastRef.current(uid, { type: "sys.goal_snapshot", goal: snapshot }),
    syncEngine: (uid, snapshot) => args.goalSyncRef.current(uid, snapshot),
  });
  args.goalUsageRefreshRef.current = async (userId, sessionId) => {
    if (!/^c:\d+$/.test(userId)) return;
    await goalStateService.refreshUsage(BigInt(userId.slice(2)), sessionId);
  };
  return {
    mediaGenerationService,
    museDeliveryRefs,
    museHub,
    museBridgeHttp,
    closeMusePublic,
    studioHttp,
    sitesService,
    goalStateService,
  };
}

export function bootstrapQqAndWechatChannels(args: {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  controlPlaneEnabled: boolean;
  bridgeSecret: string | undefined;
  redis: IORedis;
  dockerEnsureRunning: ResolveContainerEndpoint;
  pricing: PricingCache;
  loadUserModelAuthz: UserModelAuthzLoader;
  allowedInboundModels: ReadonlySet<string>;
  codexTurns: ReturnType<typeof createCommercialCodexAndWechatTurns>;
  userMediaResolver: ((userId: string) => Promise<UserMediaLocation>) | undefined;
  ensureContainerEndpointReady: ((uid: bigint) => Promise<void>) | undefined;
  pushRemoteHostUpload: (a: { hostUuid: string; remotePath: string; content: Buffer }) => Promise<void>;
  wechatLiveLinkKey: Buffer | undefined;
  pendingDecisionsRuntime: ReturnType<typeof createCommercialPendingDecisionsRuntime>;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
  qqBotServiceRef: { current: QqBotService | undefined };
  qqOutboundRef: { current: ReturnType<typeof makeQqOutboundReceiver> | null };
  qqProactiveRef: { current: ReturnType<typeof makeQqProactiveReceiver> | null };
  wechatProactiveRef: { current: ProactiveReceiverHandler | null };
  wechatBrokerRef: { current: WechatBroker | null };
}): { qqBotService: QqBotService | undefined; wechatBroker: WechatBroker | undefined } {
  const qqConfig = readQqBotConfig(args.env);
  let qqBotService: QqBotService | undefined;
  if (qqConfig) {
    if (!args.bridgeSecret) {
      throw new Error("QQ Bot is configured but the container bridge secret is unavailable");
    }
    const qqBuilt = buildQqBotServiceAndReceivers({
      qqConfig,
      bridgeSecret: args.bridgeSecret,
      dockerEnsureRunning: args.dockerEnsureRunning,
      pricing: args.pricing,
      loadUserModelAuthz: args.loadUserModelAuthz,
      allowedInboundModels: args.allowedInboundModels,
      prepareWechatCodexTurn: args.codexTurns.prepareWechatCodexTurn,
      failWechatCodexTurn: args.codexTurns.failWechatCodexTurn,
      handleWechatCodexBilling: args.codexTurns.handleWechatCodexBilling,
      userMediaResolver: args.userMediaResolver,
      ensureContainerEndpointReady: args.ensureContainerEndpointReady,
      pushRemoteHostUpload: args.pushRemoteHostUpload,
      remoteControl: args.pendingDecisionsRuntime.qqRemoteControl,
    });
    qqBotService = qqBuilt.qqBotService;
    args.qqBotServiceRef.current = qqBotService;
    args.qqOutboundRef.current = qqBuilt.qqOutbound;
    args.qqProactiveRef.current = qqBuilt.qqProactive;
    const svc = qqBotService;
    args.leaderBundle.add({
      name: "qqBot",
      domain: "shared",
      start: async () => {
        await svc.start();
        return { stop: () => svc.stop() };
      },
    });
  }

  let wechatBroker: WechatBroker | undefined;
  if (args.controlPlaneEnabled && args.cfg.WECHAT_BROKER_ENABLED && args.bridgeSecret) {
    const wechatLog = rootLogger.child({ subsys: "wechatBrokerAssembly" });
    const { wechatProactive, brokerConfig } = buildWechatBrokerDeps({
      bridgeSecret: args.bridgeSecret,
      redis: args.redis,
      dockerEnsureRunning: args.dockerEnsureRunning,
      pricing: args.pricing,
      loadUserModelAuthz: args.loadUserModelAuthz,
      allowedInboundModels: args.allowedInboundModels,
      prepareWechatCodexTurn: args.codexTurns.prepareWechatCodexTurn,
      failWechatCodexTurn: args.codexTurns.failWechatCodexTurn,
      handleWechatCodexBilling: args.codexTurns.handleWechatCodexBilling,
      userMediaResolver: args.userMediaResolver,
      pushRemoteHostUpload: args.pushRemoteHostUpload,
      wechatLiveLinkKey: args.wechatLiveLinkKey,
      remoteControl: args.pendingDecisionsRuntime.wechatRemoteControl,
    });
    args.wechatProactiveRef.current = wechatProactive;
    wechatBroker = args.trackScheduler("wechatBroker", "shared", makeWechatBroker(brokerConfig));
    wechatBroker.start();
    args.wechatBrokerRef.current = wechatBroker;
    wechatLog.info("wechat_broker_assembled");
  } else if (args.cfg.WECHAT_BROKER_ENABLED && !args.bridgeSecret) {
    rootLogger.warn("[commercial] WECHAT_BROKER_ENABLED=1 but bridgeSecret missing; broker NOT assembled");
  } else {
    rootLogger.info("[commercial] wechat broker disabled (WECHAT_BROKER_ENABLED!=1)");
  }

  return { qqBotService, wechatBroker };
}

async function safeStopHandle(label: string, fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    rootLogger.warn(`[wecomAlert] stop failed (${label})`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerWecomAlertLeaderMember(args: {
  env: NodeJS.ProcessEnv;
  runtimeChannel: string;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
  unregisterMutator: (name: string) => void;
  slotRelayClient: ReturnType<typeof createSlotRelayClient>;
}): void {
  if (args.runtimeChannel !== "v5" || args.env.OC_WECOM_ALERT_DISABLED === "1") return;
  args.leaderBundle.add({
    name: "wecomAlert",
    domain: "v5-owned",
    start: async () => {
      const intervalMs = parseInterval(args.env.OC_WECOM_ALERT_INTERVAL_MS, 1000, 5_000);
      const aibotConn = getWecomAibotConnectionManager();
      let dispatcher: ReturnType<typeof startWecomAlertDispatcher> | undefined;
      let approval: ReturnType<typeof startUserNoticeApproval> | undefined;
      try {
        await aibotConn.start();
        dispatcher = args.trackScheduler(
          "wecomAlert",
          "v5-owned",
          startWecomAlertDispatcher({
            dispatchIntervalMs: intervalMs,
            deps: { sendAibotAlert: (id, md) => aibotConn.send(id, md) },
          }),
        );
        approval = args.trackScheduler(
          "userNoticeApproval",
          "v5-owned",
          startUserNoticeApproval(aibotConn, {
            onlineUserSubset: (uids) => args.slotRelayClient.onlineUserSubset(uids),
            broadcastToUsers: (uids, payload) => args.slotRelayClient.broadcastToUsers(uids, payload),
          }),
        );
      } catch (err) {
        args.unregisterMutator("userNoticeApproval");
        args.unregisterMutator("wecomAlert");
        await safeStopHandle("approval", () => approval?.stop());
        await safeStopHandle("dispatcher", () => dispatcher?.stop());
        await safeStopHandle("aibotConn", () => aibotConn.stop());
        throw err;
      }
      const activeDispatcher = dispatcher;
      const activeApproval = approval;
      return {
        stop: async () => {
          await safeStopHandle("approval", () => activeApproval.stop());
          args.unregisterMutator("userNoticeApproval");
          await safeStopHandle("dispatcher", () => activeDispatcher.stop());
          await safeStopHandle("aibotConn", () => aibotConn.stop());
        },
      };
    },
  });
}

export function createCommercialVoiceTranscribe(args: {
  jwtSecret: string | Uint8Array;
  cfg: CommercialConfig;
}): VoiceTranscribeHandler {
  return createVoiceTranscribeHandler({
    jwtSecret: args.jwtSecret,
    deepgramApiKey: args.cfg.DEEPGRAM_API_KEY,
    resolveOpenAiApiKey: () => selectOpenAiPlatformKey("voice-transcribe"),
    openCodeGoApiKey: args.cfg.OPENCODE_GO_API_KEY,
    asrModel: args.cfg.VOICE_ASR_MODEL,
    asrLanguage: args.cfg.VOICE_ASR_LANGUAGE,
    voicePolishModel: args.cfg.VOICE_POLISH_MODEL,
    maxSeconds: args.cfg.VOICE_MAX_SECONDS,
    maxPerUser: args.cfg.VOICE_MAX_PER_USER,
    maxGlobal: args.cfg.VOICE_MAX_GLOBAL,
    logger: rootLogger.child({ subsys: "commercial", module: "voiceTranscribe" }),
  });
}

export function registerAllPoolAdapters(args: {
  env: NodeJS.ProcessEnv;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  healthTracker: AccountHealthTracker;
  triggerCodexDisableFanout: (accountId: bigint) => void;
}): void {
  registerPoolAdapter(
    createAccountPoolAdapter({
      health: args.healthTracker,
      triggerCodexDisableFanout: args.triggerCodexDisableFanout,
    }),
  );
  registerPoolAdapter(createApiKeyPoolAdapter());
  registerPoolAdapter(createRelayKeyPoolAdapter());
  configureAffinitySettings(
    async () => ({
      maxUsersPerSubscription: (await getSystemSetting("pool_affinity_max_users_per_subscription")).value,
      ratePerMin: (await getSystemSetting("pool_affinity_rate_per_min")).value,
      antigravityInflight: (await getSystemSetting("pool_affinity_antigravity_inflight")).value,
      antigravityRatePerMin: (await getSystemSetting("pool_affinity_antigravity_rate_per_min")).value,
    }),
    isSelfhostFlavor(args.flavorIdentity),
  );
  registerPoolAdapter(
    createGeminiPoolAdapter({
      clientSecret: () => args.env.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ?? "",
    }),
  );
  registerRemoteBrainPoolAdapter();
}

export function startCodexFanoutAndDriftReconciler(args: {
  env: NodeJS.ProcessEnv;
  controlPlaneEnabled: boolean;
  runtimeChannel: string;
  v3Deps: V3SupervisorDeps | undefined;
  triggerCodexDisableFanoutRef: { current: (accountId: bigint) => void };
  trackScheduler: TrackSchedulerFn;
}): CodexDriftReconcilerHandle | undefined {
  const codexContainerDirForFanout =
    args.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
  const fanoutDeps: CodexDisableFanoutDeps = {
    writeAuth: {
      selfHostId: args.v3Deps?.selfHostId ?? null,
      containerUid: V3_AGENT_UID,
      containerGid: V3_AGENT_GID,
      codexContainerDir: codexContainerDirForFanout,
      putRemoteCodexAuth: args.v3Deps?.putRemoteCodexAuth,
    },
    concurrency: 4,
    logger: rootLogger.child({ subsys: "commercial", module: "codexDisableFanout" }),
  };
  args.triggerCodexDisableFanoutRef.current = (accountId: bigint) => {
    enqueueCodexDisableFanout(accountId, fanoutDeps);
  };
  if (
    (args.controlPlaneEnabled || args.runtimeChannel === "v5") &&
    args.env.COMMERCIAL_CODEX_DRIFT_RECONCILER_DISABLED !== "1"
  ) {
    const intervalMs = parseInterval(args.env.COMMERCIAL_CODEX_DRIFT_RECONCILER_INTERVAL_MS, 30_000, 300_000);
    return args.trackScheduler(
      "codexDriftReconciler",
      "v5-owned",
      startCodexDisableDriftReconciler({ deps: fanoutDeps, intervalMs }),
    );
  }
  return undefined;
}

export function startEagerDomainSchedulers(args: {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  controlPlaneEnabled: boolean;
  runtimeChannel: string;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  v3Deps: V3SupervisorDeps | undefined;
  scheduler: AccountScheduler;
  trackScheduler: TrackSchedulerFn;
}): {
  codexRefreshActor: CodexRefreshActorHandle | undefined;
  subscriptionRolloverSweeper: SubscriptionRolloverHandle | undefined;
  accountSlotReaper: SlotReaperHandle | undefined;
  researchJobScheduler: ResearchJobSchedulerHandle | undefined;
  marketplaceAiReviewScheduler: MarketplaceAiReviewSchedulerHandle | undefined;
  providerHealthScheduler: ProviderHealthSchedulerHandle | undefined;
} {
  const { env, cfg, controlPlaneEnabled, runtimeChannel, flavorIdentity, v3Deps, scheduler, trackScheduler } = args;
  let codexRefreshActor: CodexRefreshActorHandle | undefined;
  if ((controlPlaneEnabled || runtimeChannel === "v5") && env.COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED !== "1") {
    const codexContainerDir = env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
    codexRefreshActor = trackScheduler(
      "codexRefresh",
      "v5-owned",
      startCodexRefreshActor({
        codexContainerDir,
        containerUid: V3_AGENT_UID,
        containerGid: V3_AGENT_GID,
        selfHostId: v3Deps?.selfHostId ?? null,
        writeRemoteFn: v3Deps?.putRemoteCodexAuth,
      }),
    );
  }

  let subscriptionRolloverSweeper: SubscriptionRolloverHandle | undefined;
  if ((controlPlaneEnabled || runtimeChannel === "v5") && env.COMMERCIAL_SUBSCRIPTION_ROLLOVER_DISABLED !== "1") {
    const intervalMs = parseInterval(env.COMMERCIAL_SUBSCRIPTION_ROLLOVER_INTERVAL_MS, 1000, 300_000);
    subscriptionRolloverSweeper = trackScheduler(
      "subscriptionRollover",
      "v5-owned",
      startSubscriptionRolloverSweeper({ intervalMs }),
    );
  }

  let accountSlotReaper: SlotReaperHandle | undefined;
  if (env.COMMERCIAL_ACCOUNT_SLOT_REAPER_DISABLED !== "1") {
    const intervalMs = parseInterval(env.COMMERCIAL_ACCOUNT_SLOT_REAPER_INTERVAL_MS, 1000, 60_000);
    accountSlotReaper = trackScheduler("accountSlotReaper", "local", startAccountSlotReaper({ scheduler, intervalMs }));
  }

  let researchJobScheduler: ResearchJobSchedulerHandle | undefined;
  if ((controlPlaneEnabled || runtimeChannel === "v5") && env.COMMERCIAL_RESEARCH_JOBS_DISABLED !== "1") {
    const intervalMs = parseInterval(env.COMMERCIAL_RESEARCH_JOBS_INTERVAL_MS, 2000, 5_000);
    researchJobScheduler = trackScheduler(
      "researchJobs",
      "v5-owned",
      startResearchJobScheduler({ handlers: makeResearchFetchJobHandlers(), intervalMs }),
    );
  }

  let marketplaceAiReviewScheduler: MarketplaceAiReviewSchedulerHandle | undefined;
  if (shouldStartCommercialScheduler("marketplaceAiReview", { flavorIdentity, runtimeChannel })) {
    const intervalMs = parseInterval(env.OC_MARKETPLACE_AI_REVIEW_INTERVAL_MS, 5000, 15_000);
    marketplaceAiReviewScheduler = trackScheduler(
      "marketplaceAiReview",
      "v5-owned",
      startMarketplaceAiReviewScheduler({
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
      }),
    );
  }

  let providerHealthScheduler: ProviderHealthSchedulerHandle | undefined;
  if (runtimeChannel === "v5" && env.OC_PROVIDER_HEALTH_DISABLED !== "1") {
    const intervalMs = parseInterval(env.OC_PROVIDER_HEALTH_INTERVAL_MS, 10_000, 60_000);
    providerHealthScheduler = trackScheduler("providerHealth", "v5-owned", startProviderHealthScheduler({ intervalMs }));
  }

  return {
    codexRefreshActor,
    subscriptionRolloverSweeper,
    accountSlotReaper,
    researchJobScheduler,
    marketplaceAiReviewScheduler,
    providerHealthScheduler,
  };
}
