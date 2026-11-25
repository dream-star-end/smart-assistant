/**
 * Internal proxy, internal container route dispatcher, control listener (healthz /
 * control-probe / VIP), external API-key proxy, and external mTLS listener bootstrap.
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 */
import * as fs from "node:fs";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import type { Server as HttpsServer } from "node:https";
import { SITES_AGENT_INTERNAL_PREFIX, type DurableCodexBilling } from "@openclaude/protocol";
import {
  appendServerAuthoredMessage,
  appendServerAuthoredMessageDrainByUser,
  appendServerAuthoredMessageForRequest,
  drainDelegateCostForClientSession,
  getClientSession,
  patchServerAuthoredMessage,
  readArchivedMessages,
} from "@openclaude/storage";
import type IORedis from "ioredis";
import {
  apiKeyPoolConfiguredServices,
  apiKeyPoolHasMembers,
  importEnvApiKeys,
  primeApiKeyPool,
  selectApiKey,
  startApiKeyPoolCache,
} from "../account-pool/apiKeyPool.js";
import {
  expireCodexRouteContext,
  expireGrokRouteContextByLease,
  listEnabledGroupsForModel,
  resolveGrokRouteContext,
} from "../account-pool/groups.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import type { AccountScheduler } from "../account-pool/scheduler.js";
import { getProviderRoutingAvailability } from "../admin/providerHealthGate.js";
import { getResearchConfigPublic } from "../admin/researchConfig.js";
import { getPhase6AccountUuidEnforce, getSessionPinMode } from "../admin/runtimeFlags.js";
import type { CronWakeRunner } from "../agent-sandbox/cronWake.js";
import { V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { makeApiKeyIdentityStrategy, resolveApiKeyIdentity } from "../auth/apiKeyIdentity.js";
import { makePgApiKeyRepo } from "../auth/apiKeyRepo.js";
import { createPgIdentityRepo } from "../auth/containerIdentity.js";
import { makeDesktopIdentityStrategy } from "../auth/desktopIdentity.js";
import { stubMailer } from "../auth/mail.js";
import { makeContainerIdentityStrategy } from "../auth/proxyIdentity.js";
import type { makeLoadUserModelAuthz } from "../auth/userModelAuthz.js";
import {
  selectAdvisorCodexAdmitRoute,
  type AdvisorCodexSelectorDecision,
} from "../billing/advisorCodexAdmitRoute.js";
import { listAgentCostOverrides } from "../billing/agentMultiplier.js";
import {
  openCursorExternalApiOutbox,
  type CursorExternalApiOutbox,
} from "../billing/cursorExternalApiOutbox.js";
import { createDelegateEngineBillingRuntime } from "../billing/delegateEngineBillingRuntime.js";
import {
  authorityKeyringProvider,
  getModelCatalogCache,
  isModelAuthorityEnforced,
  peekModelCatalogCache,
} from "../billing/modelCatalogRuntime.js";
import { readTotalSpendableBalance, type PreCheckRedis } from "../billing/preCheck.js";
import type { PricingCache } from "../billing/pricing.js";
import { applyTurnWaiver } from "../billing/refund.js";
import {
  ensureCa,
  ensureMasterLeaf,
  extractHostUuidFromSpiffe,
  extractSpiffeUris,
} from "../compute-pool/certAuthority.js";
import * as computeQueries from "../compute-pool/queries.js";
import type { CommercialConfig } from "../config.js";
import { seedDefaultConnectors } from "../connectors/declarativeSeed.js";
import {
  CONNECTORS_RPC_PREFIX,
  PLUGINS_RPC_PREFIX,
  makeConnectorsRpcHandler,
  type ConnectorsRpcHandler,
} from "../connectors/rpc.js";
import { makeCcbTranscriptRestoreReader } from "../db/ccbTranscriptRestoreReader.js";
import { getPool } from "../db/index.js";
import {
  lookupLeaseCallbackSession,
  type DispatchAdmissionBackend,
  type LosslessTurnTapeStorage,
} from "../db/pgSessionsBackend.js";
import {
  createControlListener,
  privatePortForSlot,
  type ControlListener,
} from "../deploy/controlListener.js";
import {
  defaultCutoverInFlightTracker,
  handleCutoverControlRequest,
  rejectIfCutoverFencing,
} from "../deploy/cutoverReadiness.js";
import type { DesiredWatch, Slot } from "../deploy/deployState.js";
import type { LeaderLeaseController, LeadershipStatus } from "../deploy/leaderLease.js";
import {
  handleSlotRelayRequest,
  type SlotRelayLocal,
  type createSlotRelayClient,
} from "../deploy/slotRelay.js";
import { getDesktopFlagSnapshot } from "../desktop/flags.js";
import { extractDesktopTlsContext } from "../desktop/tlsContext.js";
import type { assertFlavorIdentity } from "../flavor/assertFlavor.js";
import {
  GROK_VISION_PATH,
  grokRunMaxCost,
  makeGrokRunner,
  makeGrokVisionHandler,
  resettleGrokRun,
  type GrokVisionHandler,
} from "../grok/visionProxy.js";
import {
  GROK_WEB_SEARCH_PATH,
  makeGrokWebSearchHandler,
  type GrokWebSearchHandler,
} from "../grok/webSearchProxy.js";
import {
  ConcurrencyLimiter,
  DEFAULT_MAX_CONCURRENT_PER_UID,
  DEFAULT_PROXY_RATE_LIMIT,
  FallbackRateLimiter,
  makeAnthropicProxyHandler,
  type AnthropicProxyHandler,
} from "../http/anthropicProxy.js";
import {
  antigravityRelayConcurrencyFromConfig,
  createAntigravityRouteRuntime,
} from "../http/antigravityRouteRuntime.js";
import {
  buildCodexRelayHandler,
  buildCodexTokenRefreshHandler,
} from "../http/codexInternalAssembly.js";
import { handleDesktopRuntimeManifest } from "../http/desktopBootstrap.js";
import {
  createPgDesktopIdentityRepo,
  desktopTokenRequestContext,
  handleDesktopTokenMint,
  handleDesktopTokenRefresh,
} from "../http/desktopEnroll.js";
import {
  makeDesktopRequestVerifier,
  startDesktopTlsListener,
} from "../http/desktopTlsListener.js";
import type { CommercialHttpDeps } from "../http/handlers.js";
import { ANTIGRAVITY_RELAY_PREFIX } from "../http/internalAntigravityRelay.js";
import {
  isAutoDreamOptimizerInternalPath,
  makeAutoDreamOptimizerHandler,
  type AutoDreamOptimizerRuntime,
} from "../http/internalAutoDreamOptimizer.js";
import {
  AUTO_DREAM_POLICY_PATH,
  makeAutoDreamPolicyHandler,
  type AutoDreamPolicyHandler,
} from "../http/internalAutoDreamPolicy.js";
import {
  CCB_TRANSCRIPT_RESTORE_PATH,
  makeCcbTranscriptRestoreHandler,
} from "../http/internalCcbTranscriptRestore.js";
import {
  CODEX_RELAY_PREFIX,
  makeDefaultCodexRelayDb,
  type CodexRelayHandler,
} from "../http/internalCodexRelay.js";
import {
  CODEX_TOKEN_REFRESH_PATH,
  type CodexTokenRefreshHandler,
} from "../http/internalCodexTokenRefresh.js";
import {
  CORE_MEMORY_RANK_PATH,
  makeCoreMemoryRankHandler,
  type CoreMemoryRankHandler,
} from "../http/internalCoreMemoryRank.js";
import {
  COST_EVENT_PATH,
  makeCostEventHandler,
  type CostEventHandler,
} from "../http/internalCostEvent.js";
import {
  CRON_INDEX_PATH,
  makeCronIndexHandler,
  type CronIndexHandler,
} from "../http/internalCronIndex.js";
import {
  CRON_ORIGIN_INJECT_PATH,
  makeCronOriginInjectHandler,
  type CronOriginInjectHandler,
} from "../http/internalCronOriginInject.js";
import { DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH, isDelegateAntigravityRoutePath } from "../http/internalDelegateAntigravityRoute.js";
import {
  isDelegateEngineBillingInternalPath,
  makeDelegateEngineBillingHandler,
  type DelegateEngineBillingRuntime,
} from "../http/internalDelegateEngineBilling.js";
import {
  isDelegateRemoteLaneInternalPath,
  makeDelegateRemoteLaneHandler,
} from "../http/internalDelegateRemoteLane.js";
import type { createMasterCc5Runtime } from "../agent-sandbox/cc5Runtime.js";
import {
  isDelegateGrokRoutePath,
  makeDelegateGrokRouteHandler,
  type DelegateGrokRouteHandler,
} from "../http/internalDelegateGrokRoute.js";
import { DELEGATE_TRACE_PATH, makeDelegateTraceHandler } from "../http/internalDelegateTrace.js";
import {
  GROK_RELAY_PREFIX,
  makeGrokRelayHealthRecorder,
  type GrokRelayHandler,
} from "../http/internalGrokRelay.js";
import {
  INBOX_ALERT_PATH,
  INBOX_POST_PATH,
  makeInboxPostHandler,
  type InboxPostHandler,
} from "../http/internalInboxPost.js";
import {
  LEASE_CALLBACK_PATH,
  LEASE_CALLBACK_VALIDATE_PATH,
  makeLeaseCallbackHandler,
} from "../http/internalLeaseCallback.js";
import {
  MARKETPLACE_AGENT_PREFIX,
  makeMarketplaceAgentHandler,
  type MarketplaceAgentHandler,
} from "../http/internalMarketplaceAgent.js";
import {
  MARKETPLACE_SYNC_PATH,
  makeMarketplaceSyncHandler,
  type MarketplaceSyncHandler,
} from "../http/internalMarketplaceSync.js";
import { MEMORY_USAGE_PATH, makeMemoryUsageHandler } from "../http/internalMemoryUsage.js";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  assertSeedModelsActive,
  makeModelCatalogHandler,
  type ModelCatalogHandler,
} from "../http/internalModelCatalog.js";
import {
  PLATFORM_PROMPT_SLOTS_PATH,
  makePlatformPromptSlotsHandler,
  type PlatformPromptSlotsHandler,
} from "../http/internalPlatformPromptSlots.js";
import {
  PROJECT_ASSETS_REGISTER_PATH,
  makeInternalProjectAssetsHandler,
  type InternalProjectAssetsHandler,
} from "../http/internalProjectAssets.js";
import {
  PROJECT_CONTEXT_PATH,
  makeInternalProjectContextHandler,
  type InternalProjectContextHandler,
} from "../http/internalProjectContext.js";
import {
  PROJECT_SEARCH_PATH,
  makeInternalProjectSearchHandler,
  type InternalProjectSearchHandler,
} from "../http/internalProjectSearch.js";
import {
  PROMPT_QUEUE_CLAIM_PATH,
  PROMPT_QUEUE_DETAIL_PATH,
  PROMPT_QUEUE_MUTATION_PATH,
  PROMPT_QUEUE_SNAPSHOT_PATH,
  isPromptQueueV1Enabled,
  makePromptQueueHandler,
  type PromptQueueHandler,
} from "../http/internalPromptQueue.js";
import {
  SERVER_AUTHORED_PATH,
  TURN_TAPE_STATE_PATH,
  makeServerAuthoredHandler,
  makeTurnTapeStateHandler,
  type ServerAuthoredHandler,
} from "../http/internalServerAuthored.js";
import {
  SKILL_EMBED_PREFIX,
  makeSkillEmbedHandler,
  type SkillEmbedHandler,
} from "../http/internalSkillEmbed.js";
import {
  SKILL_FEEDBACK_PATH,
  makeSkillFeedbackHandler,
  type SkillFeedbackHandler,
} from "../http/internalSkillFeedback.js";
import {
  SKILL_SHADOW_PATH,
  isSkillShadowEnabled,
  makeSkillShadowHandler,
  type SkillShadowHandler,
} from "../http/internalSkillShadow.js";
import {
  SKILL_USAGE_PATH,
  isSkillUsageEnabled,
  makeSkillUsageHandler,
  type SkillUsageHandler,
} from "../http/internalSkillUsage.js";
import {
  TOOL_CALL_ROLLUP_PATH,
  TOOL_FAILURE_AUDIT_PATH,
  isToolFailureAuditEnabled,
  makeToolCallRollupHandler,
  makeToolFailureAuditHandler,
  type ToolCallRollupHandler,
  type ToolFailureAuditHandler,
} from "../http/internalToolFailureAudit.js";
import {
  TURN_LEASE_RENEW_PATH,
  makeTurnLeaseRenewHandler,
  type TurnLeaseRenewHandler,
} from "../http/internalTurnLeaseRenew.js";
import {
  TURN_OBSERVATION_PATH,
  makeTurnObservationHandler,
} from "../http/internalTurnObservation.js";
import {
  TURN_WAIVE_PATH,
  makeTurnWaiveHandler,
  type TurnWaiveHandler,
} from "../http/internalTurnWaive.js";
import {
  ZCODE_RELAY_PREFIX,
  makeZcodeRelayHandler,
  type ZcodeRelayHandler,
} from "../http/internalZcodeRelay.js";
import { makeCursorExternalRoute, type CursorExternalRoute } from "../http/proxy/cursorExternal.js";
import { makeExternalModelsHandler, type ExternalModelsHandler } from "../http/proxy/externalModels.js";
import { makeExternalUsageHandler, type ExternalUsageHandler } from "../http/proxy/externalUsage.js";
import {
  assertPlatformDefaultModelConfigured,
  staticProviderKeysFromConfig,
} from "../http/proxy/staticProviderMeta.js";
import { makePgSkillEmbedCache, makePgSkillSearchLogger } from "../http/skillEmbedCachePg.js";
import { sendJson } from "../http/util.js";
import { createCronDeliveryInboxMessage, createInboxMessage } from "../inbox/inbox.js";
import {
  LITERATURE_SEARCH_PATH,
  makeLiteratureProxyHandler,
  type LiteratureProxyHandler,
} from "../literatureProxy.js";
import { rootLogger } from "../logging/logger.js";
import {
  seedPlatformGeneralAgents,
  seedPlatformResearchAgents,
} from "../marketplace/seedPlatformAgents.js";
import {
  MEDIA_GENERATION_INTERNAL_PREFIX,
  makeMediaGenerationInternalHandler,
  type MediaGenerationInternalHandler,
} from "../media-generation/http.js";
import type { MediaGenerationService } from "../media-generation/service.js";
import type { createStudioFromConfig } from "../media-studio/assemble.js";
import { startStudioOrchestrator } from "../media-studio/orchestrator/assemble.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { mediaProxyKey } from "../minimax/mediaKey.js";
import {
  MINIMAX_MEDIA_PATH,
  makeMiniMaxMediaHandler,
  type MiniMaxMediaHandler,
} from "../minimax/mediaProxy.js";
import {
  MINIMAX_WEB_SEARCH_PATH,
  makeMiniMaxWebSearchHandler,
  type MiniMaxWebSearchHandler,
} from "../minimax/webSearchProxy.js";
import type { createMuseFromConfig } from "../muse/assemble.js";
import { makeMuseInternalHandler } from "../muse/internalHttp.js";
import { MUSE_INTERNAL_PREFIX } from "../muse/protocol.js";
import { OCR_PREFIX, makeOcrProxyHandler, type OcrProxyHandler } from "../ocr/ocrProxy.js";
import { PgOcrJobStore } from "../ocr/ocrStore.js";
import { makePlatformContextLoader } from "../platform/platformContextLoader.js";
import { makeDefaultVolumeContextReader } from "../platform/volumeContextReader.js";
import { PREFS_PLUGIN_ENABLEMENT } from "../plugins/enablement.js";
import type { PluginRuntimeFacade } from "../plugins/runtime.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";
import { PgPromptQueueStore } from "../promptQueue/pgPromptQueueStore.js";
import {
  QQ_OUTBOUND_PATH,
  QQ_PROACTIVE_PATH,
  type makeQqOutboundReceiver,
  type makeQqProactiveReceiver,
} from "../qqbot/receiver.js";
import {
  RESEARCH_PREFIX,
  makeResearchProxyHandler,
  type ResearchProxyHandler,
} from "../research/researchProxy.js";
import type { createSitesFromConfig } from "../sites/assemble.js";
import { makeSitesInternalHandler } from "../sites/internalHttp.js";
import type { assembleSystemActions } from "../system-assistant/assemble.js";
import { INTERNAL_SYSTEM_ACTIONS_PATH } from "../system-assistant/internalHttp.js";
import {
  TAVILY_WEB_SEARCH_PATH,
  makeTavilyWebSearchHandler,
  type TavilyWebSearchHandler,
} from "../tavily/webSearchProxy.js";
import type { WechatBroker } from "../wechat/broker.js";
import { WECHAT_OUTBOUND_PATH } from "../wechat/outboundReceiver.js";
import { WECHAT_PROACTIVE_PATH, type ProactiveReceiverHandler } from "../wechat/proactiveReceiver.js";
import type { AuthoritySigner } from "../ws/authoritySigner.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import type { UserChatBridgeHandler } from "../ws/userChatBridge.js";

export interface InternalProxyBootstrapDeps {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  runtimeChannel: string;
  ocSlot: Slot;
  dualMasterEnabled: boolean;
  egressSplitEnabled: boolean;
  skipInternalProxy: boolean | undefined;
  proxyBind: string | undefined;
  proxyPort: number | undefined;
  selfHostUuid: string | undefined;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  jwtSecret: string | Uint8Array;
  redis: IORedis;
  sharedRateLimitRedis: ReturnType<typeof wrapIoredis>;
  preCheckRedis: PreCheckRedis;
  pricing: PricingCache;
  scheduler: AccountScheduler;
  healthTracker: AccountHealthTracker;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  triggerCodexDisableFanout: (accountId: bigint) => void;
  appendCostCreditsForUser: NonNullable<Parameters<typeof makeAnthropicProxyHandler>[0]["appendCostCredits"]>;
  losslessTurnTapeStorage: LosslessTurnTapeStorage | undefined;
  dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  settleTapeEngineBilling: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  pluginFacade: PluginRuntimeFacade;
  mediaGenerationService: MediaGenerationService;
  museHub: Awaited<ReturnType<typeof createMuseFromConfig>>["hub"];
  sitesService: ReturnType<typeof createSitesFromConfig>;
  studioHttp: Awaited<ReturnType<typeof createStudioFromConfig>>;
  allocateGrokRelayRoute: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
    origin?: "bridge" | "delegate";
  }) => Promise<any>;
  createGrokRelayHandler: (identityRepo: ReturnType<typeof createPgIdentityRepo>) => GrokRelayHandler;
  verifyEgressSecret: (presented: string, expected: string) => boolean;
  createHttpServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => HttpServer;
  deployDesiredWatch: DesiredWatch | undefined;
  leaderLease: LeaderLeaseController | undefined;
  slotRelayClient: ReturnType<typeof createSlotRelayClient>;
  slotRelayLocalRef: { current: SlotRelayLocal };
  bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void };
  studioPushRef: { current: (uid: bigint, payload: unknown) => void };
  tapeSchedulerKickRef: { current: () => void };
  autoDreamOptimizerRuntimeRef: { current: AutoDreamOptimizerRuntime | null };
  commercialCodexRouteRef: {
    current: ((args: {
      containerId: number;
      userId: bigint;
      modelId: string;
      sessionId?: string;
    }) => Promise<AdvisorCodexSelectorDecision>) | null;
  };
  delegateEngineBillingRuntimeRef: { current: DelegateEngineBillingRuntime | null };
  cc5RuntimeRef: { current: ReturnType<typeof createMasterCc5Runtime> };
  wechatBrokerRef: { current: WechatBroker | null };
  wechatProactiveRef: { current: ProactiveReceiverHandler | null };
  qqOutboundRef: { current: ReturnType<typeof makeQqOutboundReceiver> | null };
  qqProactiveRef: { current: ReturnType<typeof makeQqProactiveReceiver> | null };
  getModelAuthoritySigner: () => AuthoritySigner | undefined;
  getCronOriginBridge: () => UserChatBridgeHandler | null;
  getSystemActions: () => ReturnType<typeof assembleSystemActions> | undefined;
  setDesktopTlsClose: (fn: () => Promise<void>) => void;
  setSeedPlatformAgentsForLeadership: (fn: () => Promise<void>) => void;
  setStopStudioOrchestrator: (fn: (() => Promise<void>) | undefined) => void;
}

export interface InternalProxyBootstrapResult {
  internalProxyServer: HttpServer | undefined;
  internalProxyHandler: AnthropicProxyHandler | undefined;
  internalProxyAddress: { host: string; port: number } | undefined;
  dispatchInternal: AnthropicProxyHandler | undefined;
  controlListener: ControlListener | undefined;
}

export async function bootstrapInternalProxyAndListeners(
  deps: InternalProxyBootstrapDeps,
): Promise<InternalProxyBootstrapResult> {
  let internalProxyServer: HttpServer | undefined;
  let internalProxyHandler: AnthropicProxyHandler | undefined;
  let internalProxyAddress: { host: string; port: number } | undefined;
  let dispatchInternal: AnthropicProxyHandler | undefined;
  let controlListener: ControlListener | undefined;

  if (
    !deps.skipInternalProxy &&
    deps.proxyBind &&
    deps.proxyPort !== undefined &&
    deps.selfHostUuid
  ) {
    await importEnvApiKeys(staticProviderKeysFromConfig(deps.cfg)).catch((err) =>
      console.warn("[commercial] api-key pool env import failed:", (err as Error)?.message ?? err),
    );
    await primeApiKeyPool().catch(() => {});
    startApiKeyPoolCache();
    assertPlatformDefaultModelConfigured(deps.cfg, {
      apiKeyPoolConfigured: (service) => apiKeyPoolConfiguredServices().has(service),
    });
    try {
      const identityRepo = createPgIdentityRepo();
      const rateLimitRedis = deps.sharedRateLimitRedis;
      const identityStrategy = makeContainerIdentityStrategy({
        repo: identityRepo,
        pricing: deps.pricing,
        loadUserModelAuthz: deps.loadUserModelAuthz,
      });
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
      const sharedProxyConcurrency = new ConcurrencyLimiter(DEFAULT_MAX_CONCURRENT_PER_UID);
      const sharedProxyFallback = new FallbackRateLimiter(
        DEFAULT_PROXY_RATE_LIMIT.windowSeconds,
        Math.max(1, Math.floor(DEFAULT_PROXY_RATE_LIMIT.max / 3)),
      );
      internalProxyHandler = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing: deps.pricing,
        preCheckRedis: deps.preCheckRedis,
        scheduler: deps.scheduler,
        modelCatalog: modelCatalogForProxy,
        modelAuthorityEnforce,
        authorityKeyring: authorityKeyringProvider(),
        identity: identityStrategy,
        loadUserModelAuthz: deps.loadUserModelAuthz,
        rateLimitRedis,
        concurrencyLimiter: sharedProxyConcurrency,
        fallbackLimiter: sharedProxyFallback,
        refreshDeps: {
          health: deps.healthTracker,
          triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
        },
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
        appendCostCredits: deps.appendCostCreditsForUser,
        staticProviderKeys: staticProviderKeysFromConfig(deps.cfg),
        apiKeyPoolEnabled: true,
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      const serverAuthoredHandler: ServerAuthoredHandler = makeServerAuthoredHandler({
        identityRepo,
        losslessTurnTapeStorage: deps.losslessTurnTapeStorage,
        settleCodexBilling: deps.settleTapeEngineBilling,
        applyTurnWaiver: (input) => applyTurnWaiver(getPool(), input),
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
        onTapeFinalized: () => deps.tapeSchedulerKickRef.current(),
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
          void recordProductFrictionEvent(
            {
              correlation: requestId,
              userId,
              surface: "session",
              stage: "persist",
              code: "SESSION_OVERSIZED",
              outcome: "failed",
              sessionId,
            },
            getPool(),
          ).catch(() => {});
        },
      });
      const codexTokenRefreshHandler: CodexTokenRefreshHandler = buildCodexTokenRefreshHandler({
        identityRepo,
        rateLimitRedis,
        healthTracker: deps.healthTracker,
        selfHostId: deps.selfHostUuid,
        triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
      });
      const literatureProxyHandler: LiteratureProxyHandler = makeLiteratureProxyHandler({
        identityRepo,
        redis: deps.redis,
      });
      const connectorsRpcHandler: ConnectorsRpcHandler = makeConnectorsRpcHandler({
        identityRepo,
        redis: deps.redis,
        pluginFacade: deps.pluginFacade,
        pluginEnablement: PREFS_PLUGIN_ENABLEMENT,
      });
      const researchProxyHandler: ResearchProxyHandler = makeResearchProxyHandler({
        identityRepo,
        redis: deps.redis,
      });
      const ocrProxyHandler: OcrProxyHandler = makeOcrProxyHandler({
        identityRepo,
        store: new PgOcrJobStore(getPool()),
      });
      const platformPromptSlotsHandler: PlatformPromptSlotsHandler = makePlatformPromptSlotsHandler({
        identityRepo,
        pricingCache: deps.pricing,
        catalog: modelCatalogForProxy,
      });
      const projectContextHandler: InternalProjectContextHandler =
        makeInternalProjectContextHandler({ identityRepo });
      const projectAssetsHandler: InternalProjectAssetsHandler =
        makeInternalProjectAssetsHandler({ identityRepo });
      const projectSearchHandler: InternalProjectSearchHandler =
        makeInternalProjectSearchHandler({ identityRepo });
      const minimaxMediaHandler: MiniMaxMediaHandler = makeMiniMaxMediaHandler({
        identityRepo,
        pgPool: getPool(),
        tokenPlanKey: mediaProxyKey(deps.cfg),
        windowCap: deps.cfg.OC_MINIMAX_MEDIA_WINDOW_MAX_CALLS,
      });
      const mediaGenerationInternalHandler: MediaGenerationInternalHandler =
        makeMediaGenerationInternalHandler({
          identityRepo,
          service: deps.mediaGenerationService,
        });
      const museInternalHandler = makeMuseInternalHandler({ identityRepo, hub: deps.museHub });
      defaultCutoverInFlightTracker.setMuseJobsGetter(
        () => deps.museHub?.activeNonDurableJobCount() ?? 0,
      );
      const sitesInternalHandler = makeSitesInternalHandler({
        identityRepo,
        sites: deps.sitesService,
      });
      const tavilyWebSearchHandler: TavilyWebSearchHandler = makeTavilyWebSearchHandler({
        identityRepo,
        apiKey: deps.cfg.TAVILY_API_KEY,
      });
      const minimaxWebSearchHandler: MiniMaxWebSearchHandler = makeMiniMaxWebSearchHandler({
        identityRepo,
        tokenPlanKey: deps.cfg.MINIMAX_TOKEN_PLAN_KEY,
      });
      const grokWebSearchHandler: GrokWebSearchHandler = makeGrokWebSearchHandler({ identityRepo });
      const visionStaticProviderKeys = staticProviderKeysFromConfig(deps.cfg);
      const grokVisionHandler: GrokVisionHandler = makeGrokVisionHandler({
        identityRepo,
        getPool,
        preCheckRedis: deps.preCheckRedis,
        pricing: deps.pricing,
        catalog: {
          async assertFresh() {
            const cache = modelCatalogForProxy ?? peekModelCatalogCache();
            if (!cache) throw new Error("GROK_VISION_CATALOG_UNAVAILABLE");
            return cache.assertFresh();
          },
        },
        loadUserModelAuthz: deps.loadUserModelAuthz,
        recordStatus: makeGrokRelayHealthRecorder({ health: deps.healthTracker }),
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
        staticProviderKeys: visionStaticProviderKeys,
        resolveStaticApiKey: async (providerId, userId) => {
          const picked = await selectApiKey(providerId, `vision:u:${userId.toString()}`, undefined, { userId });
          return picked?.apiKey ?? null;
        },
        apiKeyPoolHasMembers: (providerId) => apiKeyPoolHasMembers(providerId),
      });
      if (deps.studioHttp) {
        const studioGrokCatalog = {
          async assertFresh() {
            const cache = modelCatalogForProxy ?? peekModelCatalogCache();
            if (!cache) throw new Error("GROK_VISION_CATALOG_UNAVAILABLE");
            return cache.assertFresh();
          },
        };
        deps.setStopStudioOrchestrator(
          startStudioOrchestrator({
            cfg: deps.cfg,
            pool: getPool(),
            studio: deps.studioHttp,
            museHub: deps.museHub,
            push: (uid, frame) => deps.studioPushRef.current(uid, frame),
            grok: makeGrokRunner({
              getPool,
              preCheckRedis: deps.preCheckRedis,
              pricing: deps.pricing,
              catalog: studioGrokCatalog,
              loadUserModelAuthz: deps.loadUserModelAuthz,
              recordStatus: makeGrokRelayHealthRecorder({ health: deps.healthTracker }),
            }),
            grokMaxCost: (model) => grokRunMaxCost(studioGrokCatalog, model),
            grokResettle: (i) =>
              resettleGrokRun(
                { getPool, preCheckRedis: deps.preCheckRedis, pricing: deps.pricing },
                { ...i, containerId: null, durationMs: 0 },
              ),
          })?.stop,
        );
      }
      const codexRelayHandler: CodexRelayHandler = buildCodexRelayHandler({
        identityRepo,
        preCheckRedis: deps.preCheckRedis,
        pgPool: getPool(),
        onImageCharge: (uid, charge) => {
          deps.bridgeBroadcastRef.current(uid, {
            type: "outbound.cost_charged",
            costCredits: charge.costCredits,
            balanceAfter: charge.balanceAfter,
          });
        },
      });
      const grokRelayHandler = deps.createGrokRelayHandler(identityRepo);
      const delegateGrokRouteHandler: DelegateGrokRouteHandler = makeDelegateGrokRouteHandler({
        identityRepo,
        allocate: (input) => deps.allocateGrokRelayRoute({ ...input, origin: "delegate" }),
        release: async ({ routeToken, containerId, userId }) => {
          const context = await resolveGrokRouteContext({ token: routeToken, containerId, userId });
          if (!context) return false;
          await expireGrokRouteContextByLease(context.accountId, context.slotId);
          deps.scheduler.releaseCodexSlot(context.accountId, context.slotId);
          return true;
        },
        renew: async ({ routeToken, containerId, userId }) => {
          const context = await resolveGrokRouteContext({ token: routeToken, containerId, userId });
          if (!context) return false;
          if (!deps.scheduler.renewCodexSlot(context.accountId, context.slotId)) {
            deps.scheduler.restoreCodexSlot(context.accountId, context.slotId);
          }
          return true;
        },
        logger: rootLogger.child({ subsys: "delegateGrokRoute" }),
      });
      const antigravityRouteRuntime = createAntigravityRouteRuntime({
        identityRepo,
        pool: getPool(),
        relayPort: V3_CONTAINER_PORT,
        clientSecret: deps.cfg.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? "",
        readBalance: readTotalSpendableBalance,
        rootLogger,
        pricing: deps.pricing,
        appendCostCredits: deps.appendCostCreditsForUser,
        ...antigravityRelayConcurrencyFromConfig(deps.cfg),
      });
      // B8: Mount RENEW_PATH unconditionally so Commercial main Antigravity turns & FIFO queued
      // swarms can renew already-minted route leases, while keeping MINT/RELEASE selfhost-only.
      const allowDelegateAntigravityMint = deps.env.OC_SELFHOST_ENGINE_LOCAL_TURNS === "1";
      const delegateAntigravityRouteHandler = antigravityRouteRuntime.makeDelegateHandler();
      const zcodeRelayHandler: ZcodeRelayHandler = makeZcodeRelayHandler({
        identityRepo,
        codingPlanKey: deps.cfg.ZAI_CODING_PLAN_KEY ?? "",
      });
      const antigravityRelayHandler = antigravityRouteRuntime.relayHandler;
      const skillEmbedHandler: SkillEmbedHandler = makeSkillEmbedHandler({
        identityRepo,
        cache: makePgSkillEmbedCache(),
        recordSearch: makePgSkillSearchLogger(),
      });
      const coreMemoryRankHandler: CoreMemoryRankHandler = makeCoreMemoryRankHandler({
        identityRepo,
      });
      const marketplaceSyncHandler: MarketplaceSyncHandler = makeMarketplaceSyncHandler({
        identityRepo,
        flavorIdentity: deps.flavorIdentity,
      });
      const turnWaiveHandler: TurnWaiveHandler = makeTurnWaiveHandler({
        identityRepo,
        pgPool: getPool(),
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
      });
      const turnLeaseRenewHandler: TurnLeaseRenewHandler = makeTurnLeaseRenewHandler({
        identityRepo,
        pgPool: getPool(),
        getSigner: deps.getModelAuthoritySigner,
      });
      const ccbTranscriptRestoreHandler = makeCcbTranscriptRestoreHandler({
        identityRepo,
        read: makeCcbTranscriptRestoreReader(getPool()),
      });
      const turnTapeStateHandler: ServerAuthoredHandler = makeTurnTapeStateHandler({
        identityRepo,
        storage: deps.dispatchAdmissionBackend,
      });
      const promptQueueHandler: PromptQueueHandler | null = isPromptQueueV1Enabled()
        ? makePromptQueueHandler({
            identityRepo,
            store: new PgPromptQueueStore(getPool()),
          })
        : null;
      const marketplaceAgentHandler: MarketplaceAgentHandler = makeMarketplaceAgentHandler({
        identityRepo,
        listPublicModels: () => deps.pricing.listPublic(),
      });
      const toolFailureAuditHandler: ToolFailureAuditHandler | null = isToolFailureAuditEnabled()
        ? makeToolFailureAuditHandler({ identityRepo, queryRunner: getPool() })
        : null;
      const toolCallRollupHandler: ToolCallRollupHandler | null = isToolFailureAuditEnabled()
        ? makeToolCallRollupHandler({ identityRepo, queryRunner: getPool() })
        : null;
      const turnObservationHandler = isToolFailureAuditEnabled()
        ? makeTurnObservationHandler({ identityRepo, queryRunner: getPool() })
        : null;
      const memoryUsageHandler = makeMemoryUsageHandler({ identityRepo, queryRunner: getPool() });
      const skillUsageHandler: SkillUsageHandler | null = isSkillUsageEnabled()
        ? makeSkillUsageHandler({ identityRepo, queryRunner: getPool() })
        : null;
      const skillShadowHandler: SkillShadowHandler | null = isSkillShadowEnabled()
        ? makeSkillShadowHandler({ identityRepo, queryRunner: getPool() })
        : null;
      const skillFeedbackHandler: SkillFeedbackHandler = makeSkillFeedbackHandler({
        identityRepo,
        queryRunner: getPool(),
      });
      const autoDreamPolicyHandler: AutoDreamPolicyHandler = makeAutoDreamPolicyHandler({
        identityRepo,
      });
      const autoDreamOptimizerHandler = makeAutoDreamOptimizerHandler({
        identityRepo,
        runtimeRef: deps.autoDreamOptimizerRuntimeRef,
      });
      const advisorCodexRelayDb = makeDefaultCodexRelayDb();
      deps.delegateEngineBillingRuntimeRef.current = createDelegateEngineBillingRuntime({
        getPool,
        preCheckRedis: deps.preCheckRedis,
        pricing: deps.pricing,
        catalog: {
          async assertFresh() {
            const cache = modelCatalogForProxy ?? peekModelCatalogCache();
            if (!cache) throw new Error("DELEGATE_ENGINE_BILLING_CATALOG_UNAVAILABLE");
            return cache.assertFresh();
          },
        },
        loadUserModelAuthz: deps.loadUserModelAuthz,
        createCodexDelegateRoute: async ({ containerId, userId, modelId }) => {
          const createRoute = deps.commercialCodexRouteRef.current;
          if (!createRoute) return { kind: "unavailable" as const, reason: "selector_unwired" };
          return selectAdvisorCodexAdmitRoute({
            containerId,
            userId,
            modelId,
            createRoute,
            readBinding: (id) => advisorCodexRelayDb.readContainerBinding(id),
          });
        },
        expireCodexDelegateRoute: (token) => expireCodexRouteContext(token).then(() => {}),
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
        logger: rootLogger.child({ subsys: "openTurnAttribution" }),
      });
      const delegateTraceHandler = makeDelegateTraceHandler({ pool: getPool(), identityRepo });
      const delegateEngineBillingHandler = makeDelegateEngineBillingHandler({
        identityRepo,
        runtimeRef: deps.delegateEngineBillingRuntimeRef,
      });
      const delegateRemoteLaneHandler = makeDelegateRemoteLaneHandler({
        identityRepo,
        pool: getPool(),
        flavorIdentity: deps.flavorIdentity,
        env: process.env,
        loadUserModelAuthz: deps.loadUserModelAuthz,
        cc5RuntimeRef: deps.cc5RuntimeRef,
        getModelAuthoritySigner: deps.getModelAuthoritySigner,
        getModelCatalog: () => modelCatalogForProxy ?? peekModelCatalogCache(),
      });
      if (deps.runtimeChannel === "v5") {
        deps.setSeedPlatformAgentsForLeadership(async () => {
          try {
            const rc = await getResearchConfigPublic();
            if (rc.enabled) {
              const seeded = await seedPlatformResearchAgents({
                listPublicModels: () => deps.pricing.listPublic(),
              });
              console.log("[commercial] platform research agents seed:", JSON.stringify(seeded));
            }
          } catch (err) {
            console.error("[commercial] seedPlatformResearchAgents failed:", err);
          }
          try {
            const seeded = await seedPlatformGeneralAgents({
              listPublicModels: () => deps.pricing.listPublic(),
            });
            console.log("[commercial] platform general agents seed:", JSON.stringify(seeded));
          } catch (err) {
            console.error("[commercial] seedPlatformGeneralAgents failed:", err);
          }
        });
      }
      void (async () => {
        try {
          const seeded = await seedDefaultConnectors(getPool());
          console.log("[commercial] default connectors seed:", JSON.stringify(seeded));
        } catch (err) {
          console.error("[commercial] seedDefaultConnectors failed:", err);
        }
      })();
      const costEventHandler: CostEventHandler = makeCostEventHandler({
        secret: deps.cfg.OC_EGRESS_SECRET,
        appendCostCredits: deps.appendCostCreditsForUser,
        broadcastToUser: async (uid, payload) => {
          if (deps.dualMasterEnabled) {
            await deps.slotRelayClient.broadcastToUsers([uid.toString()], payload);
            return;
          }
          deps.bridgeBroadcastRef.current(uid, payload);
        },
      });
      const cronIndexHandler: CronIndexHandler = makeCronIndexHandler({
        identityRepo,
        runner: getPool() as unknown as CronWakeRunner,
      });
      const cronOriginInjectHandler: CronOriginInjectHandler = makeCronOriginInjectHandler({
        identityRepo,
        inject: (input) => {
          const bridge = deps.getCronOriginBridge();
          return bridge
            ? bridge.injectCronOriginTurn(input)
            : Promise.resolve({ kind: "no_transport" as const });
        },
      });
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
      const inboxAlertHandler: InboxPostHandler = makeInboxPostHandler({
        identityRepo,
        postMessage: postInboxToUser,
        allowWarning: true,
      });
      const modelCatalogHandler: ModelCatalogHandler | null = modelCatalogForProxy
        ? makeModelCatalogHandler({
            identityRepo,
            catalog: modelCatalogForProxy,
            loadUserModelAuthz: deps.loadUserModelAuthz,
            loadRoutingAvailability: () =>
              getProviderRoutingAvailability(Date.now(), undefined, undefined, true),
            loadAgentCostOverrides: () => listAgentCostOverrides(getPool()),
          })
        : null;
      void (async () => {
        const deskFlags = await getDesktopFlagSnapshot();
        if (!deskFlags.assembled) return;
        const deskRepo = createPgDesktopIdentityRepo();
        const deskVerify = makeDesktopRequestVerifier(deskRepo);
        const deskIdentity = makeDesktopIdentityStrategy({
          repo: deskRepo,
          tlsFromReq: (req) => extractDesktopTlsContext(req),
          pricing: deps.pricing,
          loadUserModelAuthz: deps.loadUserModelAuthz,
        });
        const deskMessages = makeAnthropicProxyHandler({
          pgPool: getPool(),
          pricing: deps.pricing,
          preCheckRedis: deps.preCheckRedis,
          scheduler: deps.scheduler,
          identity: deskIdentity,
          loadUserModelAuthz: deps.loadUserModelAuthz,
          rateLimitRedis,
          runtimeKind: "desktop",
          modelCatalog: modelCatalogForProxy,
          modelAuthorityEnforce,
          authorityKeyring: authorityKeyringProvider(),
          refreshDeps: {
            health: deps.healthTracker,
            triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
          },
          broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
          appendCostCredits: deps.appendCostCreditsForUser,
          getPhase6AccountUuidEnforce,
          getSessionPinMode,
          listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
          concurrencyLimiter: sharedProxyConcurrency,
          fallbackLimiter: sharedProxyFallback,
        });
        const deskHttpDeps = {
          jwtSecret: deps.jwtSecret,
          mailer: stubMailer,
          redis: wrapIoredis(deps.redis),
          desktopTunnelRegistry: getDesktopTunnelRegistry(),
        } as CommercialHttpDeps;
        const listener = await startDesktopTlsListener({
          role: "master",
          allowRegister: true,
          handlers: {
            messages: deskMessages,
            tokenMint: (req, res) =>
              handleDesktopTokenMint(req, res, desktopTokenRequestContext(req), deskHttpDeps),
            tokenRefresh: (req, res) =>
              handleDesktopTokenRefresh(req, res, desktopTokenRequestContext(req), deskHttpDeps),
            runtimeManifest: (req, res) =>
              handleDesktopRuntimeManifest(req, res, desktopTokenRequestContext(req), deskHttpDeps),
            serverAuthored: makeServerAuthoredHandler({
              identityRepo,
              verify: deskVerify,
              losslessTurnTapeStorage: deps.losslessTurnTapeStorage,
              storage: {
                appendServerAuthoredMessage,
                appendServerAuthoredMessageForRequest,
                appendServerAuthoredMessageDrainByUser,
                drainDelegateCostForClientSession,
                getClientSession,
                readArchivedMessages,
                patchServerAuthoredMessage,
              },
            }),
            turnTape: makeTurnTapeStateHandler({
              identityRepo,
              verify: deskVerify,
              storage: deps.dispatchAdmissionBackend,
            }),
            turnLease: makeTurnLeaseRenewHandler({
              identityRepo,
              pgPool: getPool(),
              getSigner: deps.getModelAuthoritySigner,
              verify: deskVerify,
            }),
            catalog: modelCatalogHandler
              ? makeModelCatalogHandler({
                  identityRepo,
                  verify: deskVerify,
                  catalog: modelCatalogForProxy!,
                  loadUserModelAuthz: deps.loadUserModelAuthz,
                })
              : async (_req, res) => {
                  res.statusCode = 503;
                  res.end();
                },
          },
          identityRepo: deskRepo,
        });
        if (listener) deps.setDesktopTlsClose(() => listener.close());
      })().catch((err) => {
        rootLogger.warn("[commercial] desktop TLS listener not started", {
          err: (err as Error)?.message,
        });
      });
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
        if (path === INTERNAL_SYSTEM_ACTIONS_PATH) {
          const sa = deps.getSystemActions();
          if (!sa) {
            sendJson(res, 503, { error: { code: "UNAVAILABLE", message: "系统操作尚未就绪。" } });
            return Promise.resolve();
          }
          return sa.handleInternal(req, res, ctx);
        }
        if (deps.egressSplitEnabled && path === COST_EVENT_PATH) {
          return costEventHandler(req, res);
        }
        if (
          modelCatalogHandler &&
          (path === MODEL_CATALOG_PATH || path === MODEL_CATALOG_EPOCH_PATH)
        ) {
          return modelCatalogHandler(req, res, ctx);
        }
        if (path === SERVER_AUTHORED_PATH) return serverAuthoredHandler(req, res, ctx);
        if (path === CCB_TRANSCRIPT_RESTORE_PATH) return ccbTranscriptRestoreHandler(req, res, ctx);
        if (path === TURN_TAPE_STATE_PATH) return turnTapeStateHandler(req, res, ctx);
        if (path === LITERATURE_SEARCH_PATH) return literatureProxyHandler(req, res, ctx);
        if (path.startsWith(CONNECTORS_RPC_PREFIX) || path.startsWith(PLUGINS_RPC_PREFIX)) {
          return connectorsRpcHandler(req, res, ctx);
        }
        if (path.startsWith(RESEARCH_PREFIX)) return researchProxyHandler(req, res, ctx);
        if (path.startsWith(OCR_PREFIX)) return ocrProxyHandler(req, res, ctx);
        if (path === PLATFORM_PROMPT_SLOTS_PATH) return platformPromptSlotsHandler(req, res, ctx);
        if (path === PROJECT_CONTEXT_PATH) return projectContextHandler(req, res, ctx);
        if (path === PROJECT_ASSETS_REGISTER_PATH) return projectAssetsHandler(req, res, ctx);
        if (path === PROJECT_SEARCH_PATH) return projectSearchHandler(req, res, ctx);
        if (path === MINIMAX_MEDIA_PATH) return minimaxMediaHandler(req, res, ctx);
        if (
          path === MEDIA_GENERATION_INTERNAL_PREFIX ||
          path.startsWith(`${MEDIA_GENERATION_INTERNAL_PREFIX}/`)
        ) {
          return mediaGenerationInternalHandler(req, res, ctx);
        }
        if (path === MUSE_INTERNAL_PREFIX || path.startsWith(`${MUSE_INTERNAL_PREFIX}/`)) {
          return museInternalHandler(req, res, ctx);
        }
        if (path.startsWith(SITES_AGENT_INTERNAL_PREFIX)) {
          return sitesInternalHandler(req, res, ctx);
        }
        if (path === TAVILY_WEB_SEARCH_PATH) return tavilyWebSearchHandler(req, res, ctx);
        if (path === MINIMAX_WEB_SEARCH_PATH) return minimaxWebSearchHandler(req, res, ctx);
        if (path === GROK_WEB_SEARCH_PATH) return grokWebSearchHandler(req, res, ctx);
        if (path === GROK_VISION_PATH) return grokVisionHandler(req, res, ctx);
        if (path === CODEX_TOKEN_REFRESH_PATH) return codexTokenRefreshHandler(req, res, ctx);
        if (path === CODEX_RELAY_PREFIX || path.startsWith(`${CODEX_RELAY_PREFIX}/`)) {
          return codexRelayHandler(req, res, ctx);
        }
        if (path === GROK_RELAY_PREFIX || path.startsWith(`${GROK_RELAY_PREFIX}/`)) {
          return grokRelayHandler(req, res, ctx);
        }
        if (path === ZCODE_RELAY_PREFIX || path.startsWith(`${ZCODE_RELAY_PREFIX}/`)) {
          return zcodeRelayHandler(req, res, ctx);
        }
        if (path === ANTIGRAVITY_RELAY_PREFIX || path.startsWith(`${ANTIGRAVITY_RELAY_PREFIX}/`)) {
          return antigravityRelayHandler(req, res, ctx);
        }
        if (path === SKILL_EMBED_PREFIX) return skillEmbedHandler(req, res, ctx);
        if (path === CORE_MEMORY_RANK_PATH) return coreMemoryRankHandler(req, res, ctx);
        if (path === MARKETPLACE_SYNC_PATH) return marketplaceSyncHandler(req, res, ctx);
        if (path === TURN_WAIVE_PATH) return turnWaiveHandler(req, res, ctx);
        if (path === TURN_LEASE_RENEW_PATH) return turnLeaseRenewHandler(req, res, ctx);
        if (delegateGrokRouteHandler && isDelegateGrokRoutePath(path)) {
          return delegateGrokRouteHandler(req, res, ctx);
        }
        if (
          delegateAntigravityRouteHandler &&
          (allowDelegateAntigravityMint
            ? isDelegateAntigravityRoutePath(path)
            : path === DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH)
        ) {
          return delegateAntigravityRouteHandler(req, res, ctx);
        }
        if (
          promptQueueHandler &&
          (path === PROMPT_QUEUE_MUTATION_PATH ||
            path === PROMPT_QUEUE_SNAPSHOT_PATH ||
            path === PROMPT_QUEUE_DETAIL_PATH ||
            path === PROMPT_QUEUE_CLAIM_PATH)
        ) {
          return promptQueueHandler(req, res, ctx);
        }
        if (toolFailureAuditHandler && path === TOOL_FAILURE_AUDIT_PATH) {
          return toolFailureAuditHandler(req, res, ctx);
        }
        if (toolCallRollupHandler && path === TOOL_CALL_ROLLUP_PATH) {
          return toolCallRollupHandler(req, res, ctx);
        }
        if (turnObservationHandler && path === TURN_OBSERVATION_PATH) {
          return turnObservationHandler(req, res, ctx);
        }
        if (path === MEMORY_USAGE_PATH) return memoryUsageHandler(req, res, ctx);
        if (skillUsageHandler && path === SKILL_USAGE_PATH) return skillUsageHandler(req, res, ctx);
        if (skillShadowHandler && path === SKILL_SHADOW_PATH) {
          return skillShadowHandler(req, res, ctx);
        }
        if (path === SKILL_FEEDBACK_PATH) return skillFeedbackHandler(req, res, ctx);
        if (path === AUTO_DREAM_POLICY_PATH) return autoDreamPolicyHandler(req, res, ctx);
        if (isAutoDreamOptimizerInternalPath(path)) {
          return autoDreamOptimizerHandler(req, res, ctx, path);
        }
        if (path === DELEGATE_TRACE_PATH) return delegateTraceHandler(req, res, ctx);
        if (isDelegateEngineBillingInternalPath(path)) {
          return delegateEngineBillingHandler(req, res, ctx, path);
        }
        if (isDelegateRemoteLaneInternalPath(path)) {
          return delegateRemoteLaneHandler(req, res, ctx, path);
        }
        if (path === CRON_INDEX_PATH) return cronIndexHandler(req, res, ctx);
        if (path === CRON_ORIGIN_INJECT_PATH) return cronOriginInjectHandler(req, res, ctx);
        if (path === INBOX_POST_PATH) return inboxPostHandler(req, res, ctx);
        if (path === INBOX_ALERT_PATH) return inboxAlertHandler(req, res, ctx);
        if (path.startsWith(MARKETPLACE_AGENT_PREFIX)) {
          return marketplaceAgentHandler(req, res, ctx);
        }
        if (path === WECHAT_OUTBOUND_PATH) {
          const broker = deps.wechatBrokerRef.current;
          if (!broker) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: { code: "WECHAT_BROKER_NOT_ASSEMBLED", message: "wechat broker not assembled" },
              }),
            );
            return Promise.resolve();
          }
          return broker.outboundHandler(req, res, ctx);
        }
        if (path === WECHAT_PROACTIVE_PATH) {
          const proactive = deps.wechatProactiveRef.current;
          if (!proactive) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: { code: "WECHAT_BROKER_NOT_ASSEMBLED", message: "wechat broker not assembled" },
              }),
            );
            return Promise.resolve();
          }
          return proactive(req, res, ctx);
        }
        if (path === QQ_OUTBOUND_PATH) {
          const receiver = deps.qqOutboundRef.current;
          if (!receiver) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: { code: "QQ_BOT_NOT_ASSEMBLED", message: "QQ Bot not assembled" },
              }),
            );
            return Promise.resolve();
          }
          return receiver(req, res, ctx);
        }
        if (path === QQ_PROACTIVE_PATH) {
          const receiver = deps.qqProactiveRef.current;
          if (!receiver) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: { code: "QQ_BOT_NOT_ASSEMBLED", message: "QQ Bot not assembled" },
              }),
            );
            return Promise.resolve();
          }
          return receiver(req, res, ctx);
        }
        return internalProxyHandler!(req, res, ctx);
      };

      // ── P3 控制口只读端点 ────────────────────────────────────────────────
      const currentLeadership = (): LeadershipStatus =>
        deps.leaderLease
          ? deps.leaderLease.status()
          : { state: "ineligible", slot: deps.ocSlot, generation: null, leasePid: null };
      const respondControlHealthz = (res: ServerResponse): void => {
        const vip = controlListener?.status().vipBound ? "owner" : "released";
        const body = {
          ok: true,
          channel: deps.runtimeChannel,
          slot: deps.ocSlot,
          leadership: currentLeadership(),
          vip,
        };
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
      };
      const respondControlProbe = async (
        req: IncomingMessage,
        res: ServerResponse,
      ): Promise<void> => {
        const reply = (code: number, obj: Record<string, unknown>): void => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(obj));
        };
        const secret = deps.cfg.OC_EGRESS_SECRET;
        if (!secret) return reply(503, { ok: false, error: "EGRESS_SECRET_UNSET" });
        const presented = req.headers["x-oc-egress-secret"];
        const okSecret = typeof presented === "string" && deps.verifyEgressSecret(presented, secret);
        if (!okSecret) return reply(401, { ok: false, error: "UNAUTHORIZED" });
        const routeTable =
          typeof dispatchInternal === "function" && typeof internalProxyHandler === "function";
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
          slot: deps.ocSlot,
          leadership: currentLeadership(),
        });
      };
      const leaseCallbackHandler = makeLeaseCallbackHandler({
        secret: deps.cfg.OC_LEASE_CALLBACK_SECRET,
        lookupSession: (uid, sid) => lookupLeaseCallbackSession(getPool(), uid, sid),
        inject: (input) => {
          const bridge = deps.getCronOriginBridge();
          return bridge
            ? bridge.injectCronOriginTurn(input)
            : Promise.resolve({ kind: "no_transport" as const });
        },
      });
      const internalRequestHandler = (req: IncomingMessage, res: ServerResponse): void => {
        const urlPath = (req.url ?? "").split("?")[0];
        if (urlPath === LEASE_CALLBACK_PATH || urlPath === LEASE_CALLBACK_VALIDATE_PATH) {
          void leaseCallbackHandler(req, res, urlPath === LEASE_CALLBACK_VALIDATE_PATH).catch(() => {
            if (!res.headersSent) res.statusCode = 503;
            res.end();
          });
          return;
        }
        if (req.method === "GET" && urlPath === "/healthz") {
          try {
            respondControlHealthz(res);
          } catch {
            /* socket gone */
          }
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
              } catch {
                /* socket gone */
              }
            }
          });
          return;
        }
        if (
          req.socket.localPort === privatePortForSlot(deps.ocSlot) &&
          handleCutoverControlRequest(req, res, {
            slot: deps.ocSlot,
            secret: deps.cfg.OC_EGRESS_SECRET,
            verifySecret: deps.verifyEgressSecret,
            getLeadership: currentLeadership,
            getControlListener: () => controlListener,
            desiredWatch: deps.deployDesiredWatch,
            getActiveBrowserWs: () => deps.getCronOriginBridge()?.registry.total() ?? 0,
            drainBrowserWebSockets: () => deps.getCronOriginBridge()?.drainBrowserWebSockets?.() ?? 0,
            getContainerLinkEnabled: () => deps.getCronOriginBridge()?.containerLinkEnabled === true,
          })
        ) {
          return;
        }
        if (
          deps.dualMasterEnabled &&
          req.socket.localPort === privatePortForSlot(deps.ocSlot) &&
          handleSlotRelayRequest(req, res, {
            secret: deps.cfg.OC_EGRESS_SECRET ?? "",
            local: {
              onlineUserSubset: (uids) => deps.slotRelayLocalRef.current.onlineUserSubset(uids),
              broadcastToUsers: (uids, payload) =>
                deps.slotRelayLocalRef.current.broadcastToUsers(uids, payload),
            },
            logger: rootLogger.child({ subsys: "commercial", module: "slotRelayServer" }),
          })
        ) {
          return;
        }
        const fwdPeer = deps.egressSplitEnabled ? req.headers["x-v5-egress-peer-ip"] : undefined;
        const peerIp =
          (typeof fwdPeer === "string" && fwdPeer.trim()) || req.socket.remoteAddress || "";
        Promise.resolve(
          dispatchInternal!(req, res, { hostUuid: deps.selfHostUuid!, boundIp: peerIp }),
        ).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[commercial] internal listener handler threw:", err);
          if (!res.headersSent) {
            try {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({ error: { code: "INTERNAL", message: "internal listener error" } }),
              );
            } catch {
              /* socket gone */
            }
          } else {
            try {
              res.end();
            } catch {
              /* */
            }
          }
        });
      };

      if (deps.dualMasterEnabled && deps.egressSplitEnabled && deps.deployDesiredWatch) {
        controlListener = createControlListener({
          slot: deps.ocSlot,
          desiredWatch: deps.deployDesiredWatch,
          handler: internalRequestHandler,
          vip: { host: deps.proxyBind, port: deps.proxyPort },
          logger: {
            info: (m, meta) => rootLogger.info(m, { subsys: "controlListener", meta }),
            warn: (m, meta) => rootLogger.warn(m, { subsys: "controlListener", meta }),
            error: (m, meta) => rootLogger.error(m, { subsys: "controlListener", meta }),
          },
        });
        try {
          await deps.deployDesiredWatch.refreshNow();
        } catch {
          /* retry via watch */
        }
        await controlListener.start();
        internalProxyAddress = { host: deps.proxyBind, port: deps.proxyPort };
        // eslint-disable-next-line no-console
        console.log(
          `[commercial] P3 控制口 VIP+私有双 listener 就绪 (slot=${deps.ocSlot}, vip=${deps.proxyBind}:${deps.proxyPort})`,
        );
      } else {
        internalProxyServer = deps.createHttpServer(internalRequestHandler);
        await new Promise<void>((resolve, reject) => {
          internalProxyServer!.once("error", reject);
          internalProxyServer!.listen(deps.proxyPort, deps.proxyBind, () => {
            internalProxyServer!.removeListener("error", reject);
            resolve();
          });
        });
        internalProxyAddress = { host: deps.proxyBind, port: deps.proxyPort };
        // eslint-disable-next-line no-console
        console.log(
          `[commercial] internal anthropic proxy listening on ${deps.proxyBind}:${deps.proxyPort}`,
        );
      }
    } catch (err) {
      if (deps.dualMasterEnabled && deps.egressSplitEnabled) {
        try {
          await controlListener?.close();
        } catch {
          /* */
        }
        controlListener = undefined;
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error("[commercial] internal proxy listener failed; disabling:", err);
      try {
        internalProxyServer?.close();
      } catch {
        /* */
      }
      internalProxyServer = undefined;
      internalProxyHandler = undefined;
      internalProxyAddress = undefined;
      dispatchInternal = undefined;
    }
  } else if (!deps.skipInternalProxy) {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] internal anthropic proxy disabled; missing INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT",
    );
  }

  return {
    internalProxyServer,
    internalProxyHandler,
    internalProxyAddress,
    dispatchInternal,
    controlListener,
  };
}

export async function bootstrapExternalApiKeyProxy(deps: {
  skipInternalProxy: boolean | undefined;
  cfg: CommercialConfig;
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
  healthTracker: AccountHealthTracker;
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>;
  sharedRateLimitRedis: ReturnType<typeof wrapIoredis>;
  triggerCodexDisableFanout: (accountId: bigint) => void;
  bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void };
  appendCostCreditsForUser: NonNullable<Parameters<typeof makeAnthropicProxyHandler>[0]["appendCostCredits"]>;
  cursorExternalOutboxDir: string | null;
}): Promise<{
  externalApiKeyProxy: AnthropicProxyHandler | undefined;
  externalApiKeyModels: ExternalModelsHandler | undefined;
  externalApiKeyUsage: ExternalUsageHandler | undefined;
  cursorExternalRoute: CursorExternalRoute | undefined;
  cursorExternalOutbox: CursorExternalApiOutbox | undefined;
}> {
  let externalApiKeyProxy: AnthropicProxyHandler | undefined;
  let externalApiKeyModels: ExternalModelsHandler | undefined;
  let externalApiKeyUsage: ExternalUsageHandler | undefined;
  let cursorExternalRoute: CursorExternalRoute | undefined;
  let cursorExternalOutbox: CursorExternalApiOutbox | undefined;

  if (!deps.skipInternalProxy) {
    try {
      const apiKeyRepo = makePgApiKeyRepo(getPool());
      const apiKeyIdentityDeps = {
        repo: apiKeyRepo,
        pricing: deps.pricing,
        loadUserModelAuthz: deps.loadUserModelAuthz,
        logger: rootLogger.child({ subsys: "apiKeyIdentity" }),
      };
      const apiKeyStrategy = makeApiKeyIdentityStrategy(apiKeyIdentityDeps);
      externalApiKeyModels = makeExternalModelsHandler({
        resolveIdentity: (req) =>
          resolveApiKeyIdentity(apiKeyIdentityDeps, req, { enforceUserAgent: false }),
        pricing: deps.pricing,
        loadUserModelAuthz: deps.loadUserModelAuthz,
        ownedBy: "clarvy",
        logger: rootLogger.child({ subsys: "externalModels" }),
      });
      externalApiKeyUsage = makeExternalUsageHandler({
        resolveIdentity: (req) =>
          resolveApiKeyIdentity(apiKeyIdentityDeps, req, { enforceUserAgent: false }),
        repo: apiKeyRepo,
        logger: rootLogger.child({ subsys: "externalUsage" }),
      });
      if (!deps.cfg.PLATFORM_HMAC_SECRET) {
        throw new Error(
          "PLATFORM_HMAC_SECRET required for external ApiKey proxy (Phase 5 envelope)",
        );
      }
      const platformContextLoader = makePlatformContextLoader({
        reader: makeDefaultVolumeContextReader(),
      });
      if (deps.cursorExternalOutboxDir) {
        try {
          cursorExternalOutbox = await openCursorExternalApiOutbox({
            directory: deps.cursorExternalOutboxDir,
            logger: rootLogger.child({ subsys: "cursorExternalOutbox" }),
          });
          cursorExternalRoute = makeCursorExternalRoute({
            pgPool: getPool(),
            pricing: deps.pricing,
            logger: rootLogger.child({ subsys: "cursorExternal" }),
            outbox: cursorExternalOutbox,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            "[commercial] cursor external API outbox failed; cursor engine models unavailable on api-key proxy:",
            err,
          );
          cursorExternalOutbox = undefined;
          const staleCursor = cursorExternalRoute;
          cursorExternalRoute = undefined;
          void staleCursor?.close().catch(() => undefined);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(
          "[commercial] cursor external API outbox not configured; cursor engine models unavailable on api-key proxy",
        );
      }
      const rawExternalApiKeyProxy = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing: deps.pricing,
        preCheckRedis: deps.preCheckRedis,
        scheduler: deps.scheduler,
        identity: apiKeyStrategy,
        cursorExternal: cursorExternalRoute,
        allowCountTokens: true,
        loadUserModelAuthz: deps.loadUserModelAuthz,
        rateLimitRedis: deps.sharedRateLimitRedis,
        refreshDeps: {
          health: deps.healthTracker,
          triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
        },
        broadcastToUser: (uid, payload) => deps.bridgeBroadcastRef.current(uid, payload),
        appendCostCredits: deps.appendCostCreditsForUser,
        staticProviderKeys: { deepseek: deps.cfg.DEEPSEEK_API_KEY },
        platformContextLoader,
        platformServerSecret: deps.cfg.PLATFORM_HMAC_SECRET,
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      externalApiKeyProxy = async (req, res, ctx) => {
        if (rejectIfCutoverFencing(res)) return;
        const release = defaultCutoverInFlightTracker.begin("externalApi", res);
        try {
          await rawExternalApiKeyProxy(req, res, ctx);
        } finally {
          release();
        }
      };
      // eslint-disable-next-line no-console
      console.log(
        "[commercial] external api-key anthropic proxy assembled (POST /api/anthropic/v1/messages + GET /v1/models + GET /v1/usage, engine models via relay)",
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[commercial] external api-key proxy failed to assemble; endpoint will return 503:",
        err,
      );
      externalApiKeyProxy = undefined;
      externalApiKeyModels = undefined;
      externalApiKeyUsage = undefined;
      const stale = cursorExternalRoute;
      cursorExternalRoute = undefined;
      void stale?.close().catch(() => undefined);
    }
  }

  return {
    externalApiKeyProxy,
    externalApiKeyModels,
    externalApiKeyUsage,
    cursorExternalRoute,
    cursorExternalOutbox,
  };
}

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
    try {
      res.end();
    } catch {
      /* socket gone */
    }
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { code, ...(extra ?? {}) } }));
}

async function handleExternalMtlsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  proxyHandler: AnthropicProxyHandler,
  helpers: {
    constantTimeEqual: (a: Buffer, b: Buffer) => boolean;
    isIPv4: (input: string) => boolean;
  },
): Promise<void> {
  const socket = req.socket as unknown as {
    authorized?: boolean;
    authorizationError?: { message?: string };
    getPeerCertificate?: (detailed: true) => { raw?: Buffer; fingerprint256?: string };
  };
  if (!socket.authorized) {
    sendMtlsError(res, 401, "PEER_UNAUTHORIZED", { reason: socket.authorizationError?.message });
    return;
  }
  const peerCert = socket.getPeerCertificate?.(true);
  if (!peerCert || !peerCert.raw || peerCert.raw.length === 0) {
    sendMtlsError(res, 401, "NO_PEER_CERT");
    return;
  }

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

  const row = await computeQueries.getHostById(hostUuid);
  if (!row) {
    sendMtlsError(res, 403, "HOST_NOT_FOUND");
    return;
  }
  if (row.status === "revoked") {
    sendMtlsError(res, 403, "HOST_REVOKED");
    return;
  }
  const expectedFp = row.agent_cert_fingerprint_sha256;
  if (!expectedFp) {
    sendMtlsError(res, 403, "NO_PINNED_FP");
    return;
  }
  if (!peerCert.fingerprint256 || typeof peerCert.fingerprint256 !== "string") {
    sendMtlsError(res, 401, "NO_PEER_FINGERPRINT");
    return;
  }
  const presentedFp = peerCert.fingerprint256.replace(/:/g, "").toLowerCase();
  const pBuf = Buffer.from(presentedFp, "hex");
  const eBuf = Buffer.from(expectedFp.toLowerCase(), "hex");
  if (pBuf.length !== eBuf.length || pBuf.length === 0 || !helpers.constantTimeEqual(pBuf, eBuf)) {
    sendMtlsError(res, 403, "FINGERPRINT_MISMATCH");
    return;
  }

  if (req.method === "GET" && req.url === "/v3/agent-uplink-probe") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, hostUuid }));
    return;
  }

  if (row.status !== "ready") {
    sendMtlsError(res, 503, "HOST_NOT_READY", { status: row.status });
    return;
  }

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
  if (!helpers.isIPv4(rawIp)) {
    sendMtlsError(res, 400, "IP_HEADER_NOT_IPV4");
    return;
  }

  delete req.headers["x-v3-container-ip"];
  await proxyHandler(req, res, { hostUuid, boundIp: rawIp });
}

export async function bootstrapExternalMtlsListener(deps: {
  cfg: CommercialConfig;
  internalProxyHandler: AnthropicProxyHandler | undefined;
  dispatchInternal: AnthropicProxyHandler | undefined;
  createHttpsServer: (
    opts: {
      key: string;
      cert: string;
      ca: string;
      requestCert: boolean;
      rejectUnauthorized: boolean;
      minVersion: "TLSv1.3";
    },
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) => HttpsServer;
  constantTimeEqual: (a: Buffer, b: Buffer) => boolean;
  isIPv4: (input: string) => boolean;
}): Promise<{
  externalMtlsServer: HttpsServer | undefined;
  externalMtlsAddress: { host: string; port: number } | undefined;
}> {
  let externalMtlsServer: HttpsServer | undefined;
  let externalMtlsAddress: { host: string; port: number } | undefined;

  if (
    deps.internalProxyHandler &&
    deps.dispatchInternal &&
    deps.cfg.EXTERNAL_MTLS_ENABLED &&
    deps.cfg.EXTERNAL_MTLS_BIND &&
    deps.cfg.EXTERNAL_MTLS_PORT !== undefined
  ) {
    const mtlsBind = deps.cfg.EXTERNAL_MTLS_BIND;
    const mtlsPort = deps.cfg.EXTERNAL_MTLS_PORT;
    try {
      const caMat = await ensureCa();
      const masterLeaf = await ensureMasterLeaf();
      const caPem = await fs.promises.readFile(caMat.caCertPath, "utf8");
      const masterKey = await fs.promises.readFile(masterLeaf.keyPath, "utf8");
      const capturedHandler = deps.dispatchInternal;
      externalMtlsServer = deps.createHttpsServer(
        {
          key: masterKey,
          cert: masterLeaf.certPem,
          ca: caPem,
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
        },
        (req, res) => {
          Promise.resolve(
            handleExternalMtlsRequest(req, res, capturedHandler, {
              constantTimeEqual: deps.constantTimeEqual,
              isIPv4: deps.isIPv4,
            }),
          ).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[commercial] external mTLS handler threw:", err);
            if (!res.headersSent) {
              try {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: { code: "INTERNAL", message: "mtls error" } }));
              } catch {
                /* socket gone */
              }
            } else {
              try {
                res.end();
              } catch {
                /* */
              }
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
      console.log(`[commercial] external mTLS listening on ${mtlsBind}:${mtlsPort}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] external mTLS listener failed; disabling:", err);
      try {
        externalMtlsServer?.close();
      } catch {
        /* */
      }
      externalMtlsServer = undefined;
      externalMtlsAddress = undefined;
    }
  } else if (deps.internalProxyHandler && !deps.cfg.EXTERNAL_MTLS_ENABLED) {
    // eslint-disable-next-line no-console
    console.log("[commercial] external mTLS listener disabled (EXTERNAL_MTLS_ENABLED != 1)");
  }

  return { externalMtlsServer, externalMtlsAddress };
}
