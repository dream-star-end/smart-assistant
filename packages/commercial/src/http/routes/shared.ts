import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { PromptPrivacySupport } from "@openclaude/protocol";
import type { readSessionMetadata } from "../../db/sessionMetadataApproval.js";
import type { LiteratureArtifactStore } from "../../plugins/literatureDb/artifactStore.js";
import type { LiteratureSetupService } from "../../plugins/literatureDb/setupService.js";
import type { EngineHttpDeps as ConnectorEngineHttpDeps } from "../../connectors/engine/driver.js";
import type { Mailer } from "../../auth/mail.js";
import type { PricingCache } from "../../billing/pricing.js";
import type { UserModelAuthzLoader } from "../../auth/userModelAuthz.js";
import type { CatalogSource } from "../internalModelCatalog.js";
import type { PreCheckRedis } from "../../billing/preCheck.js";
import { rootLogger, type Logger } from "../../logging/logger.js";
import type { HupijiaoClient, HupijiaoConfig } from "../../payment/hupijiao/client.js";
import type { AgentHttpDeps } from "../agent.js";
import type { V3SupervisorDeps } from "../../agent-sandbox/v3supervisor.js";
import type { RemoteHostTester } from "../../remoteHosts/service.js";
import type { AccountHealthTracker } from "../../account-pool/health.js";
import type { AnthropicProxyHandler, FallbackRateLimiter as _FallbackType } from "../proxy/shared.js";
import { FallbackRateLimiter } from "../proxy/shared.js";
import type { ExternalModelsHandler } from "../proxy/externalModels.js";
import type { ExternalUsageHandler } from "../proxy/externalUsage.js";
import type { ContainerPreviewTicketStore } from "../../ws/containerPreviewTickets.js";
import type { DirectContainerPreviewService } from "../../ws/directContainerPreview.js";
import type { LiveBrowserTicketStore } from "../../ws/liveBrowserTickets.js";
import type { ChatGptProxyHttpDeps } from "../chatgptProxy.js";
import type { PluginRuntimeFacade } from "../../plugins/runtime.js";
import type { KnowledgePlanetSetupManager } from "../../plugins/knowledgePlanetSetup.js";
import type { WeiboSetupManager } from "../../plugins/weiboSetup.js";
import type { ZhihuSetupManager } from "../../plugins/zhihuSetup.js";
import type { BiliAccountSetupManager } from "../../plugins/biliAccountSetup.js";
import type { DouyinSetupManager } from "../../plugins/douyinSetup.js";
import type { KnowledgePlanetAutomationService } from "../../plugins/knowledgePlanetAutomation.js";
import type { GoalStateService } from "../../goal/goalStateService.js";
import type { MediaGenerationService } from "../../media-generation/service.js";
import type { SitesService } from "../../sites/service.js";
import type { MuseBridgeHttpHandler } from "../../muse/bridgeHttp.js";
import type { MuseBridgeHub } from "../../muse/hub.js";
import type { StudioHttpDeps } from "../../media-studio/http.js";
import type { PendingDecisionsService } from "../../pendingDecisions/index.js";
import type { ResearchLibraryRouteDeps } from "../../research/libraryRoutes.js";
import type { CommercialOfficePreviewDeps } from "../containerOfficePreviewProxy.js";
import type { CommercialSwarmCommandDeps } from "../containerSwarmCommandProxy.js";
import type { CommercialSessionBackgroundTasksDeps } from "../sessionBackgroundTasksProxy.js";
import type { ThumbnailDiskCache } from "../mediaThumbnail.js";
import {
  checkRateLimit,
  recordRateLimitEvent,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimitRedis,
} from "../../middleware/rateLimit.js";
import { HttpError, refreshClientIpFromRequest } from "../util.js";
import { clearLaneCookie, readLaneCookie, setLaneCookie } from "../cookies.js";
import { evaluateLaneForUser } from "../../deploy/laneEvaluate.js";

export type AuthenticatedHttpUser = {
  id: string;
  role: "user" | "admin";
};

export interface CommercialHttpDeps {
  codexCommissioning?: import("../../account-pool/codexCommissioning.js").CodexCommissioning;
  selfhostGovernance?: import("../../admin/selfhostGovernanceService.js").SelfhostGovernanceService;
  remoteDriverV4?: import("../../account-pool/remotePool/commissioningService.js").RemoteDriverV4CommissioningService;
  sessionMetadataRead?: typeof readSessionMetadata;
  modelSwitchCost?: import("../../billing/modelSwitchCost.js").ModelSwitchCostService;
  /** Master-private system actions; absent until explicit composition has initialized the ledger. */
  systemActionsHttp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  resolvePromptPrivacySupport?: (userId: string) => Promise<PromptPrivacySupport>;
  literatureSetup?: LiteratureSetupService;
  literatureArtifacts?: LiteratureArtifactStore;
  jwtSecret: string | Uint8Array;
  mediaGeneration?: MediaGenerationService;
  sites?: SitesService;
  museBridgeHttp?: MuseBridgeHttpHandler;
  museHub?: MuseBridgeHub;
  studio?: StudioHttpDeps;
  goalStateService?: GoalStateService;
  pendingDecisionsService?: PendingDecisionsService;
  researchLibraryRouteDeps?: Omit<ResearchLibraryRouteDeps, "jwtSecret">;
  officePreviewRouteDeps?: CommercialOfficePreviewDeps;
  swarmCommandRouteDeps?: CommercialSwarmCommandDeps;
  sessionBackgroundTasksRouteDeps?: CommercialSessionBackgroundTasksDeps;
  verifyActiveAccount?: (userId: string) => Promise<boolean>;
  containerPreviewTickets?: ContainerPreviewTicketStore;
  containerPreviewAvailable?: () => boolean;
  liveBrowserTickets?: LiveBrowserTicketStore;
  liveBrowserStreamAvailable?: () => boolean;
  directContainerPreview?: DirectContainerPreviewService;
  chatgptProxy?: ChatGptProxyHttpDeps;
  pluginRuntime?: PluginRuntimeFacade;
  knowledgePlanetSetup?: KnowledgePlanetSetupManager;
  weiboSetup?: WeiboSetupManager;
  zhihuSetup?: ZhihuSetupManager;
  biliAccountSetup?: BiliAccountSetupManager;
  douyinSetup?: DouyinSetupManager;
  knowledgePlanetAutomation?: KnowledgePlanetAutomationService;
  mailer: Mailer;
  redis: RateLimitRedis;
  literatureDailyUsage?: (key: string) => Promise<number | null>;
  turnstileSecret?: string;
  turnstileEnforce?: boolean;
  turnstileBypass?: boolean;
  turnstileBypassAccounts?: readonly string[];
  turnstileSiteKey?: string;
  fetchImpl?: typeof fetch;
  verifyEmailUrlBase?: string;
  resetPasswordUrlBase?: string;
  pricing?: PricingCache;
  modelCatalog?: CatalogSource;
  loadUserModelAuthz?: UserModelAuthzLoader;
  preCheckRedis?: PreCheckRedis;
  hupijiao?: HupijiaoClient;
  hupijiaoConfig?: Pick<HupijiaoConfig, "appSecret" | "appId">;
  desktopTunnelRegistry?: { drop(containerId: number, reason?: string): boolean };
  desktopPeerCert?: (req: IncomingMessage) => { raw?: Buffer; subjectaltname?: string } | null;
  rateLimits?: Partial<{
    register: RateLimitConfig;
    login: RateLimitConfig;
    loginEmail: RateLimitConfig;
    requestReset: RateLimitConfig;
    resendVerify: RateLimitConfig;
    verifyEmail: RateLimitConfig;
    verifyEmailEmail: RateLimitConfig;
    hupiCreate: RateLimitConfig;
    refresh: RateLimitConfig;
    logout: RateLimitConfig;
    feedback: RateLimitConfig;
    clientErrors: RateLimitConfig;
    responseRating: RateLimitConfig;
  }>;
  requireEmailVerified?: boolean;
  refreshCookieSecure?: boolean;
  connectorEngineDeps?: ConnectorEngineHttpDeps;
  agentRuntime?: AgentHttpDeps;
  containerRuntimeReady?: boolean;
  v3Supervisor?: V3SupervisorDeps;
  bridgeSecret?: string;
  fileProxyEnabled?: boolean;
  remoteSshEnabled?: boolean;
  remoteHostTester?: RemoteHostTester;
  accountHealth?: AccountHealthTracker;
  prewarmContainer?: (uid: bigint) => void;
  prepareWorkspaceContainer?: (
    uid: bigint,
    draft?: import("../../agent-sandbox/draftPreparation.js").DraftPreparationHint,
  ) => Promise<boolean>;
  triggerCodexDisableFanout?: (accountId: bigint) => void;
  mediaSignKey?: Buffer;
  thumbnailCache?: ThumbnailDiskCache;
  wechatLiveLinkKey?: Buffer;
  ensureContainerReady?: (uid: bigint) => Promise<void>;
  externalApiKeyProxy?: AnthropicProxyHandler;
  externalApiKeyModels?: ExternalModelsHandler;
  externalApiKeyUsage?: ExternalUsageHandler;
}

export interface RequestContext {
  requestId: string;
  clientIp: string;
  authBoundIp: string;
  userAgent: string | null;
  log: Logger;
}

export const DEFAULT_RATE_LIMITS = {
  register: { scope: "register", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  login: { scope: "login", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  loginEmail: { scope: "login_email", windowSeconds: 1800, max: 20 } satisfies RateLimitConfig,
  requestReset: { scope: "request_reset", windowSeconds: 60, max: 3 } satisfies RateLimitConfig,
  resendVerify: { scope: "resend_verify", windowSeconds: 60, max: 3 } satisfies RateLimitConfig,
  verifyEmail: { scope: "verify_email", windowSeconds: 60, max: 10 } satisfies RateLimitConfig,
  verifyEmailEmail: { scope: "verify_email_email", windowSeconds: 1800, max: 10 } satisfies RateLimitConfig,
  hupiCreate: { scope: "hupi_create", windowSeconds: 3600, max: 10 } satisfies RateLimitConfig,
  refresh: { scope: "refresh", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  logout: { scope: "logout", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  feedback: { scope: "feedback", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  clientErrors: { scope: "client_errors", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  responseRating: { scope: "response_rating", windowSeconds: 60, max: 60 } satisfies RateLimitConfig,
};

export function hashEmailForRateLimit(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const _rlFallbacks = new Map<string, _FallbackType>();
let _lastRlFallbackWarnAt = 0;

function fallbackLimiterFor(cfg: RateLimitConfig): FallbackRateLimiter {
  const key = `${cfg.scope}:${cfg.windowSeconds}:${cfg.max}:${cfg.keyPrefix ?? ""}`;
  let limiter = _rlFallbacks.get(key);
  if (!limiter) {
    const cap = Math.max(1, Math.ceil(cfg.max / 3));
    limiter = new FallbackRateLimiter(cfg.windowSeconds, cap);
    _rlFallbacks.set(key, limiter);
  }
  return limiter;
}

export async function enforceRateLimit(
  deps: CommercialHttpDeps,
  cfg: RateLimitConfig,
  identifier: string,
): Promise<void> {
  if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 256) {
    throw new Error(
      `enforceRateLimit: invalid identifier (length=${typeof identifier === "string" ? identifier.length : "non-string"})`,
    );
  }
  let decision: RateLimitDecision;
  try {
    decision = await checkRateLimit(deps.redis, cfg, identifier);
  } catch (err) {
    const limiter = fallbackLimiterFor(cfg);
    const allowed = limiter.tryAcquire(identifier);
    decision = {
      allowed,
      count: 0,
      limit: limiter.maxPerKey,
      retryAfterSeconds: cfg.windowSeconds,
      key: `fallback:${cfg.scope}`,
    };
    const now = Date.now();
    if (now - _lastRlFallbackWarnAt > 30_000) {
      _lastRlFallbackWarnAt = now;
      rootLogger.warn("rate-limit Redis unavailable; using per-process fallback (degraded, blue-green not aggregated)", {
        scope: cfg.scope,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!decision.allowed) {
    void recordRateLimitEvent(cfg.scope, identifier, true);
    throw new HttpError(429, "RATE_LIMITED", "too many requests, slow down", {
      extraHeaders: { "Retry-After": decision.retryAfterSeconds },
    });
  }
}

export async function resolveLaneAndApply(
  req: IncomingMessage,
  res: ServerResponse,
  uid: string,
  secure: boolean | undefined,
): Promise<"active" | "candidate"> {
  try {
    const decision = await evaluateLaneForUser(uid);
    if (decision.lane === "candidate" && decision.cookieValue) {
      setLaneCookie(res, decision.cookieValue, { secure });
    } else if (readLaneCookie(req) !== null) {
      clearLaneCookie(res, { secure });
    }
    return decision.lane;
  } catch (err) {
    rootLogger.child({ subsys: "laneCookie" }).warn("lane_apply_failed", {
      err: (err as Error).message,
    });
    return "active";
  }
}

export function reissueClientIp(req: IncomingMessage, ctx: RequestContext): string | null {
  return refreshClientIpFromRequest(ctx.authBoundIp, req.headers["cf-connecting-ip"]);
}
