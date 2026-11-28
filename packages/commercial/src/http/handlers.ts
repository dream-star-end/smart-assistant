/**
 * T-16 — /api/auth/* + /api/me 业务 handler 门面。
 *
 * 路由实现按业务域拆分至 `./routes/*.ts`；本文件保留 100% 具名兼容导出、
 * 统一 `requireAuth` 边界装配以及公开配置入口。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSystemSetting } from "../admin/systemSettings.js";
import { communityBlogEnabled } from "../tutorials/tutorialImages.js";
import { tutorialModerationMode } from "../tutorials/tutorialModerationQueue.js";
import { resolveAuthorizedTeamLeaderModel } from "../ws/teamModeForwarding.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { requireAuth } from "./auth.js";
import { BufferingResponseSink, type CapturedResponse } from "./bufferingResponseSink.js";
import { clientIpOf, sendJson, userAgentOf } from "./util.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  hashEmailForRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "./routes/shared.js";
import {
  handleCheckVerification,
  handleClearSession,
  handleConfirmPasswordReset,
  handleCreateSession,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleRegister,
  handleRequestPasswordReset,
  handleResendVerification,
  handleVerifyEmail,
  mapRegisterFunnelCode,
} from "./routes/authRoutes.js";
import { serveListPublicModels } from "./routes/publicCatalogRoutes.js";
import {
  serveDeleteMyQqBinding,
  serveGetMyPreferences,
  serveGetMyQqBinding,
  serveMe,
  servePatchMyPreferences,
  serveStartMyQqBinding,
} from "./routes/meAndPrefsRoutes.js";
import { serveGetMyUsage, serveGetMyUsageReport } from "./routes/usageRoutes.js";
import {
  handleSubmitFeedback,
  serveCountMyInboxUnread,
  serveListMyInbox,
  serveMarkInboxRead,
  serveReadAllInbox,
} from "./routes/inboxAndFeedbackRoutes.js";
import {
  extractRawQueryParam,
  handleMediaSign,
  serveMediaSigned,
  type MediaSignedHelpers,
} from "./routes/mediaSignedRoutes.js";
import {
  serveDeleteResearchLibraryDoc,
  serveListResearchLibrary,
  serveUploadResearchLibraryDoc,
} from "./routes/researchLibraryRoutes.js";

export type {
  LockedPublicModelProjection,
  PublicModelProjection,
} from "../billing/modelPublicProjection.js";
export type { CommercialHttpDeps, RequestContext };
export {
  DEFAULT_RATE_LIMITS,
  clientIpOf,
  enforceRateLimit,
  extractRawQueryParam,
  handleCheckVerification,
  handleClearSession,
  handleConfirmPasswordReset,
  handleCreateSession,
  handleLogin,
  handleLogout,
  handleMediaSign,
  handleRefresh,
  handleRegister,
  handleRequestPasswordReset,
  handleResendVerification,
  handleSubmitFeedback,
  handleVerifyEmail,
  hashEmailForRateLimit,
  mapRegisterFunnelCode,
  userAgentOf,
};

// ─── GET /api/public/config ─────────────────────────────────────────

let _allowRegCache: { value: boolean; expiresAt: number } | null = null;
const _ALLOW_REG_CACHE_TTL_MS = 5_000;

async function _readAllowRegistrationCached(): Promise<boolean> {
  const now = Date.now();
  if (_allowRegCache && _allowRegCache.expiresAt > now) {
    return _allowRegCache.value;
  }
  const r = await getSystemSetting("allow_registration");
  const value = r.value === true;
  _allowRegCache = { value, expiresAt: now + _ALLOW_REG_CACHE_TTL_MS };
  return value;
}

/** 测试专用:清掉 cache,让下一次读 DB。production 代码不应调用。 */
export function _resetAllowRegistrationCacheForTests(): void {
  _allowRegCache = null;
}

/**
 * 与 gateway isDelegateInflightSurfaceEnabled 同一谓词（1|true|on）。
 * 复制在这里，不 import gateway（循环依赖）。缺省 / 其它值 = 关。
 */
export function delegateInflightSurfaceAdvertised(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_INFLIGHT_SURFACE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export async function handleGetPublicConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const allow_registration = await _readAllowRegistrationCached();
  sendJson(res, 200, {
    turnstile_site_key: deps.turnstileSiteKey ?? "",
    turnstile_bypass: deps.turnstileBypass === true || deps.turnstileEnforce === false,
    require_email_verified: deps.requireEmailVerified === true,
    feature_remote_ssh: deps.remoteSshEnabled === true,
    feature_image2: process.env.OC_IMAGE2_ENABLED === "true",
    feature_community_blog: communityBlogEnabled(),
    feature_community_blog_ai_review: tutorialModerationMode() === "on",
    feature_delegate_inflight: delegateInflightSurfaceAdvertised(),
    allow_registration,
  });
}

// ─── GET /api/public/models ─────────────────────────────────────────

export async function handleListPublicModels(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await serveListPublicModels(req, res, deps, resolveAuthorizedTeamLeaderModel);
}

// ─── /api/me & preferences & QQ binding ─────────────────────────────

export async function handleMe(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveMe(req, res, deps, user);
}

export async function handleGetMyPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveGetMyPreferences(res, deps, user);
}

export async function handlePatchMyPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await servePatchMyPreferences(req, res, deps, user);
}

export async function handleGetMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveGetMyQqBinding(res, user);
}

export async function handleStartMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveStartMyQqBinding(res, user);
}

export async function handleDeleteMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveDeleteMyQqBinding(res, user);
}

// ─── /api/me/usage ──────────────────────────────────────────────────

export async function handleGetMyUsage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveGetMyUsage(req, res, user);
}

export async function handleGetMyUsageReport(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveGetMyUsageReport(req, res, user);
}

// ─── /api/me/messages (in-app inbox) ────────────────────────────────

export async function handleListMyInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveListMyInbox(req, res, user);
}

export async function handleCountMyInboxUnread(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveCountMyInboxUnread(res, user);
}

export async function handleMarkInboxRead(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveMarkInboxRead(req, res, user);
}

export async function handleReadAllInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveReadAllInbox(res, user);
}

// ─── /api/media-signed ──────────────────────────────────────────────

const mediaSignedHelpers: MediaSignedHelpers = {
  extractContainerUnready: (err) =>
    err instanceof ContainerUnreadyError
      ? { retryAfterSec: err.retryAfterSec, reason: err.reason }
      : null,
  captureProxyToSink: async (runProxy, maxBytes): Promise<CapturedResponse> => {
    const sink = new BufferingResponseSink(maxBytes);
    await runProxy(sink as unknown as ServerResponse);
    return sink.completion;
  },
};

export async function handleMediaSigned(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await serveMediaSigned(req, res, ctx, deps, mediaSignedHelpers);
}

// ─── /api/me/research/library ───────────────────────────────────────

export async function handleListResearchLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveListResearchLibrary(req, res, user);
}

export async function handleDeleteResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveDeleteResearchLibraryDoc(req, res, user);
}

export async function handleUploadResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  await serveUploadResearchLibraryDoc(req, res, user);
}
