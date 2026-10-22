export interface WorkspaceDraftHint {
  viewId: string
  revision: number
  sessionId: string
  agentId: string
  modelId: string
  effortLevel?: string | null
  cancel?: boolean
}

import type {
  AgentCancelResult,
  AgentOpenResult,
  AgentStatus,
  ApiKeyPatch,
  ApiKeySummary,
  ApiKeyUsageReport,
  AuthSession,
  CreatedApiKey,
  LoginResult,
  Preferences,
  PublicConfig,
  LockedPublicModel,
  PublicModel,
  PatchSessionMetaInput,
  SessionBatchInput,
  SessionBatchResult,
  SessionListPage,
  SessionListQuery,
  SessionSearchResponse,
  PutSessionInput,
  PutSessionResult,
  RefreshOutcome,
  RegisterResult,
  SessionArchivePage,
  SessionDetail,
  DurableLiveFramePage,
  SessionMeta,
  SessionTimelinePage,
  TapeRecordPayload,
  UsageQuery,
  UsageReport,
  UsageReportWindow,
  UsageResponse,
  User,
  VerifyEmailResult,
  OrgSummary,
  OrgMember,
  OrgInvitation,
  OrgRole,
  OrgUsageReport,
  OrgUsageWindow,
  OrgInvoiceProfile,
  OrgInvoiceProfileInput,
  OrgInvoiceRequest,
  OrgTopupResult,
  OrgOrder,
  OrgLedgerRow,
  OrgSkillsResponse,
  OrgPlan,
  OrgSubscriptionInfo,
  OrgPayResult,
} from "./types";
import type { ContainerPreviewViewport } from "@openclaude/protocol/containerPreview";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { normalizeOrgPlan, normalizeOrgSubscription } from "./orgBilling";
import {
  type RefreshSurface,
  refreshStates,
  withAuthCookieMutation,
  refreshAuth,
  callWithRefresh,
  AuthEpochStaleError,
  assertAuthResponseCurrent,
  sleep,
  bearerHeaders,
  ApiError,
  throwApi,
  jsonOrThrow,
} from "./api/http";
import { projectsApi } from "./api/projectsApi";
import { memorySkillsApi } from "./api/memorySkillsApi";
import { integrationsApi } from "./api/integrationsApi";
export {
  refreshAuth,
  callWithRefresh,
  AuthEpochStaleError,
  assertAuthResponseCurrent,
  bearerHeaders,
  ApiError,
  throwApi,
  jsonOrThrow,
} from "./api/http";
export type { ApiIssue } from "./api/http";

export type QqBindingStatus = {
  available: boolean;
  bound: boolean;
  entry_url?: string;
  maskedOpenid?: string;
  boundAt?: number;
  lastInteractionAt?: number;
};

export type QqBindingStart = {
  available: true;
  entry_url: string;
  bind_code: string;
  expires_at: number;
};
const AUTH_COOKIE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * login/logout 也是 FIFO 队首：必须自身有界，否则一个永不 settle 的 fetch 会永久饿死
 * 后续 refresh/login/logout。超时从真正出队、开始 fetch 时计算，不消耗排队时间。
 */
function authCookieFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("auth cookie request timeout", "TimeoutError")),
    AUTH_COOKIE_REQUEST_TIMEOUT_MS,
  );
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

/** 中止当前 session 的旧身份 refresh；返回值可用于需要等待其真正 settle 的调用点。 */
export function cancelAuthRefresh(a: AuthSession): Promise<void> {
  const state = refreshStates.get(a);
  if (!state) return Promise.resolve();
  try {
    state.controller?.abort(new DOMException("auth epoch changed", "AbortError"));
  } catch {
    state.controller?.abort();
  }
  return (
    state.flight?.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve()
  );
}

/** 逐条响应评价提交入参（camelCase body，照抄后端契约字段名）。 */
export type ResponseRatingInput = {
  messageId: string;
  rating: "up" | "down";
  sessionId?: string;
  traceId?: string;
  model?: string;
  tags?: string[];
  comment?: string;
};

/** 会话已评回读结果：messageId → {rating, tags}（不含 comment）。 */
export type SessionRatingsMap = Record<string, { rating: "up" | "down"; tags: string[] }>;

export type RatingNudgeState = "exposed" | "rated" | "dismissed";
export type SessionRatingSnapshot = {
  ratings: SessionRatingsMap;
  nudges: Record<string, RatingNudgeState>;
};

export type ResponseRatingNudgeInput = {
  messageId: string;
  sessionId?: string;
  traceId?: string;
  clientBuild?: string;
  sampleBucket: number;
  nudgeAction: "expose" | "dismiss";
};

/** 自由文本反馈：设置页与消息级入口用判别联合隔离各自允许发送的上下文。 */
export type FeedbackCategory = "bug" | "feature" | "ux" | "other";

type FeedbackEnvironment = {
  locale?: string;
  timezone?: string;
};

export type FeedbackSubmitInput =
  | {
      category: FeedbackCategory;
      description: string;
      version?: string;
      requestId?: string;
      sessionId?: string;
      meta: FeedbackEnvironment & { source: "settings" };
    }
  | {
      category: "response";
      description: string;
      requestId?: string;
      sessionId?: string;
      meta: {
        source: "message";
        messageId: string;
        role: string;
        errorCode?: string;
        reason?: string;
        /** 只有用户在弹窗中明确保持勾选时才存在。 */
        responseExcerpt?: string;
      };
    };

export type FeedbackSubmitResult = { ok: true; id: string };

/**
 * auth 错误族 code→中文文案的**单一权威表**（登录 / 注册 / 邮箱验证 / 找回·重置密码共用）。
 * 后端 message 是给开发者/日志看的英文（如 "invalid credentials"），面向用户的本地化在**前端层**
 * 做：命中已知 code → 展示友好中文、**不带追踪号**；未知 code → 保持原样（原 message + 追踪号），
 * 追踪号只服务未知错误的排障。code 全集与后端 packages/commercial/src/auth 的
 * LoginError / RegisterError / VerifyError + handlers 的 429 RATE_LIMITED 对齐（新增 auth code
 * 时在此补一行即可，勿在组件里散落第二套映射）。
 */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "邮箱或密码错误",
  EMAIL_NOT_VERIFIED: "邮箱尚未验证，请查收邮件完成验证后再登录",
  RATE_LIMITED: "尝试次数过多，请稍后再试",
  TURNSTILE_FAILED: "人机验证未通过，请刷新后重试",
  VALIDATION: "输入格式有误，请检查邮箱与密码",
  CONFLICT: "该邮箱已注册，可直接登录",
  EMAIL_DOMAIN_BLOCKED: "该邮箱域名不支持注册，请更换邮箱",
  REGISTRATION_DISABLED: "注册暂未开放，请稍后再来",
  WEAK_PASSWORD: "密码需为 8-72 位，请重新设置",
  INVALID_TOKEN: "验证码或重置链接无效或已过期，请重新获取",
  ACCOUNT_UNAVAILABLE: "账号当前不可用，请联系客服",
};

/**
 * 把 auth 端点抛出的 ApiError 按 code 换成友好中文（未知 code / 无 code 原样返回，保留追踪号）。
 * **只在 auth 端点边界用**：CONFLICT / VALIDATION 等通用 code 在会话/计费等非 auth 场景另有语义，
 * 全局映射会串味，故绝不下沉进通用 throwApi。
 */
function localizeAuthError(err: unknown): unknown {
  if (err instanceof ApiError && err.code) {
    const friendly = AUTH_ERROR_MESSAGES[err.code];
    if (friendly) {
      return new ApiError({
        status: err.status,
        message: friendly,
        code: err.code,
        requestId: err.requestId,
        issues: err.issues,
        retryAfterSec: err.retryAfterSec,
        body: err.body,
      });
    }
  }
  return err;
}

/**
 * auth 表单展示用：把任意错误解析成一句面向用户的 message。已知 auth code → 友好中文；
 * 未知 code / 其他 Error → 原 message（含追踪号，服务排障）。AuthGate 各表单（注册/验证/找回/
 * 重置）的错误展示统一走此入口；登录路径的 code 在 useAuth.login 里被拍平成 message，故在
 * api.login 边界先行 localize（见 login()）—— 二者共用同一张 AUTH_ERROR_MESSAGES，不搞第二套。
 */
export function authErrorMessage(err: unknown): string {
  const mapped = localizeAuthError(err);
  if (mapped instanceof Error && mapped.message) return mapped.message;
  if (typeof err === "string" && err) return err;
  return "操作失败，请稍后再试。";
}

// ─── 业务/管理面板展示层错误文案（apiErrorMessage）─────────────────────────
//
// authErrorMessage 只管 auth 端点（按 code 走 AUTH_ERROR_MESSAGES）。全站其余面板的
// catch 分支历史上直接 `(e as Error).message` / `ApiError.message` 怼给用户，凡后端返
// 英文/技术 message（"invalid credentials" / "sync failed" / "not found"）的路径都会把
// 内部实现细节裸露给终端用户。apiErrorMessage 是这一类问题的**单一收口**：把任意错误
// 解析成一句面向用户的中文，与 authErrorMessage 并列、职责互补，不搞第二套散落映射。
//
// 判据来自后端 packages/commercial 的真实 message 分布——**混用**两种 message：
//   · 面向用户的中文文案（校验/内容安全/业务语义，如 "未上架或不存在"、"智能体配置不合法,
//     请按提示修正"、"商品页文案被静态安全扫描拦截,请修正后重试"）——这些是后端有意写给用户看的。
//   · 面向开发者/日志的英文技术串（"invalid credentials"、"sync failed"、"POST required"…）。
// 故以「message 是否含中文」区分：含中文=后端面向用户文案→直接用；英文/技术=不外露→用
// 调用方语义化中文 fallback（+ 追踪号排障）。

/**
 * 跨域**通用**机器码 → 标准中文。只放各业务域同义的 code：RATE_LIMITED（任何域都=太频繁）。
 * ⚠️ CONFLICT / VALIDATION / NOT_FOUND 等在 auth/订阅/会话/市场各有不同语义，严禁进此表
 * （会串味），由各调用点自带的 fallback 承担。
 */
const CROSS_DOMAIN_ERROR_MESSAGES: Record<string, string> = {
  RATE_LIMITED: "操作过于频繁，请稍后再试",
};

/** 管理台 VALIDATION issues.path → 中文。不进 CROSS_DOMAIN（VALIDATION 跨域语义不同）。 */
const ADMIN_ISSUE_MESSAGES: Record<string, string> = {
  egress_proxy_already_bound_to_claude:
    "该出口已绑定其他启用中的 Claude 账号（已停用的号不占坑）",
};

/** throwApi→withReqId 烙进 message 尾部的「（追踪号 …）」后缀（withReqId 的确定格式）。 */
const REQ_ID_SUFFIX_RE = /（追踪号\s+[^）]+）\s*$/;

/** throwApi 在后端无 message 时写入的通用兜底「请求失败 (NNN)」——视作“无有效后端文案”。 */
const GENERIC_HTTP_MESSAGE_RE = /^请求失败 \(\d+\)$/;

/** 含常见中日韩汉字（判断某条 message 是否为后端面向用户的中文文案）。 */
function hasCjk(s: string): boolean {
  return /[一-鿿]/.test(s);
}

/**
 * fetch 网络层失败（断网/DNS/CORS/被拦截）：浏览器/undici 抛 TypeError
 * （"Failed to fetch" / "NetworkError…" / "fetch failed" / "Load failed"），非 ApiError。
 */
export function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(
      err.message,
    )
  );
}

/**
 * 读请求的瞬时失败(OCV5-421):断网 / 弱网下的 fetch 失败、5xx、408、429。这类失败自动重试几次,
 * 用户看不到;4xx(权限、不存在、参数)立即如实报告。
 */
export function isTransientReadError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (!(err instanceof ApiError)) return false;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

/** 静默重试读请求:瞬时失败按 delays 退避重试,`stillWanted()` 为假(换会话 / 被新请求取代)即停。 */
export async function retryTransientRead<T>(
  run: () => Promise<T>,
  stillWanted: () => boolean,
  delays: readonly number[] = [1000, 3000, 8000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= delays.length || !isTransientReadError(err) || !stillWanted()) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      if (!stillWanted()) throw err;
    }
  }
}

/** 启动恢复可重试错误：网络/解析异常，以及 401、限流和服务端故障。 */
export function isAuthRecoveryTransient(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500;
  }
  if (err instanceof TypeError || err instanceof SyntaxError) return true;
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * 展示层错误文案的**单一权威**（面向所有业务/管理面板的 catch）。判据（见上方注释）：
 *   1. 网络失败（TypeError: Failed to fetch 等）        → 标准中文「网络不可用」，绝不外露英文。
 *   2. ApiError 且命中跨域通用 code（RATE_LIMITED）      → 标准中文（各域同义）。
 *   3. ApiError 且 message 含中文（先剥掉「（追踪号 …）」后缀再判，避免被后缀里的“追踪号”
 *      三字误判）且非通用兜底「请求失败 (NNN)」        → 后端已写好面向用户文案，**直接用**。
 *   4. 其余 ApiError（英文/技术 message，或仅通用兜底） → **不外露**，用调用方中文 fallback；
 *      有 requestId 时尾部补「（追踪号 …）」便于用户反馈、运维排障。
 *   5. 非 ApiError 的其它 Error：message 恰为中文 → 直接用；否则（英文/技术）→ fallback。
 *   6. 其它（字符串 / undefined / 未知）              → fallback。
 *
 * @param fallback 贴合该操作语义的中文（如「加载订阅信息失败」「创建定时任务失败」），
 *                 不要千篇一律「操作失败」。
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (isNetworkError(err)) return "网络连接不可用，请检查网络后重试";

  if (err instanceof ApiError) {
    if (err.code && CROSS_DOMAIN_ERROR_MESSAGES[err.code]) {
      return CROSS_DOMAIN_ERROR_MESSAGES[err.code];
    }
    if (err.issues) {
      for (const issue of err.issues) {
        const zh = ADMIN_ISSUE_MESSAGES[issue.path] ?? ADMIN_ISSUE_MESSAGES[issue.message];
        if (zh) return zh;
      }
    }
    const base = err.message.replace(REQ_ID_SUFFIX_RE, "").trim();
    if (base && hasCjk(base) && !GENERIC_HTTP_MESSAGE_RE.test(base)) return base;
    return err.requestId ? `${fallback}（追踪号 ${err.requestId}）` : fallback;
  }

  if (err instanceof Error && hasCjk(err.message)) return err.message;
  return fallback;
}

/**
 * 企业席位订单下单响应 → OrgPayResult。与批次 F issueOrderQr 同形：
 * `{ ok, data: { order_no, qrcode_url, mobile_url, amount_cents, credits, expires_at } }`。
 * 归一为 {orderNo, qr, mobileUrl};到账轮询走 getOrder。
 */
function parseOrgOrder(p: Promise<Response>): Promise<OrgPayResult> {
  return jsonOrThrow<{
    ok?: boolean;
    data?: {
      order_no: string;
      qrcode_url: string;
      mobile_url: string | null;
      amount_cents?: string;
    };
  }>(p).then((b) => ({
    orderNo: b.data?.order_no ?? "",
    qr: b.data?.qrcode_url ?? "",
    mobileUrl: b.data?.mobile_url ?? null,
    amountCents: b.data?.amount_cents,
  }));
}

// ─── v5 后端 wire 形态 → 前端类型适配 ────────────────────────────────
type WireUser = {
  id: string;
  email?: string;
  email_verified?: boolean;
  role?: "user" | "admin";
  display_name?: string | null;
  avatar_url?: string | null;
  credits?: string;
  created_at?: string;
  // 企业版(P3.1):org 归属(handleMe LEFT JOIN;无归属 → null)。
  org?: {
    id: string;
    name: string;
    role: "owner" | "admin" | "member";
    status: "active" | "suspended" | "deleting" | "deleted";
    billing_enabled: boolean;
    billing_delegate?: boolean;
  } | null;
  /** cohort lane（P3 RFC D1）：兼容后端把 lane 嵌进 user 对象的情形（body 级优先）。 */
  lane?: string | null;
};

/** v5 `/api/me` / login user → 前端 User。displayName/roles 由后端字段适配，组件层零改动。 */
function adaptUser(u: WireUser): User {
  return {
    id: u.id,
    displayName: u.display_name || u.email || "用户",
    roles: u.role ? [u.role] : ["user"],
    email: u.email,
    role: u.role,
    emailVerified: u.email_verified,
    avatarUrl: u.avatar_url ?? null,
    credits: u.credits, // 字符串大数，原样保留，绝不数值化
    createdAt: u.created_at,
    // org 字段原样透传(大数已是字符串);无归属 → null。
    org: u.org ?? null,
    // cohort lane（P3 RFC D1）：兼容 lane 嵌在 user 对象内的情形；body 级 lane 由调用点覆盖。
    lane: u.lane ?? null,
  };
}

export type ContainerPreviewTicketResponse = {
  ticket: string;
  expiresAt: number;
  url: string;
  viewport: ContainerPreviewViewport;
  protocol: "preview-v1";
  direct?: {
    sessionId: string;
    url: string;
    expiresAt: number;
  };
};

/** GET /api/chatgpt-proxy/access — unentitled users only ever see `{ enabled: false }`. */
export type ChatGptProxyAccess =
  | { enabled: false }
  | {
      enabled: true;
      proxyHost: string;
      proxyPort: number;
      pacUrl: string;
      homeUrl: string;
      username: string;
      hasCredential: boolean;
      createdAt: string | null;
      rotatedAt: string | null;
      lastUsedAt: string | null;
    };

/** POST /api/chatgpt-proxy/credential — plaintext password is returned exactly once. */
export type ChatGptProxyCredential = {
  username: string;
  password: string;
  rotatedAt: string;
};

function decodeCanonicalBase64urlUtf8(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid immutable deferred payload record id encoding");
  }
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary = "";
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid immutable deferred payload record id encoding");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let decoded = "";
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid immutable deferred payload record id encoding");
  }
  const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (canonical !== value) {
    throw new Error("invalid immutable deferred payload record id encoding");
  }
  return decoded;
}

function immutableRecordIdFromHeaders(headers: Headers): string {
  const encoded = headers.get("x-openclaude-record-id-base64url");
  if (encoded !== null) return decodeCanonicalBase64urlUtf8(encoded);
  return headers.get("x-openclaude-record-id") ?? "";
}

/** Resolve immutable metadata with a one-byte Range GET, then assemble the
 * exact JSON with byte-range requests. A public proxy may transparently gzip a
 * HEAD response and rewrite Content-Length/ETag; a 206 range response preserves
 * the origin byte identity. The 1 MiB quantum is transport backpressure, not a
 * record-size limit; every byte is retained and verified by the payload parser. */
export async function getExactDeferredPayload(
  a: AuthSession,
  url: string,
  signal?: AbortSignal,
): Promise<TapeRecordPayload> {
  const probe = await callWithRefresh(a, (token) =>
    fetch(url, {
      credentials: "include",
      headers: { ...bearerHeaders(token), Range: "bytes=0-0" },
      signal,
    }),
  );
  assertAuthResponseCurrent(probe);
  if (!probe.ok) await throwApi(probe);
  const rangeMatch = /^bytes 0-0\/([1-9][0-9]*)$/.exec(probe.headers.get("content-range") ?? "");
  const totalBytes = rangeMatch ? Number(rangeMatch[1]) : Number.NaN;
  const contentSha256 = probe.headers.get("x-openclaude-content-sha256") ?? "";
  const recordId = immutableRecordIdFromHeaders(probe.headers);
  const role = probe.headers.get("x-openclaude-record-role") ?? "";
  const probeEncoding = probe.headers.get("content-encoding")?.toLowerCase();
  if (
    probe.status !== 206 ||
    (probeEncoding !== undefined && probeEncoding !== "identity") ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    recordId.length === 0 ||
    role.length === 0
  ) {
    void probe.body?.cancel().catch(() => {});
    throw new Error("invalid immutable deferred payload metadata");
  }
  const probeBytes = new Uint8Array(await probe.arrayBuffer());
  assertAuthResponseCurrent(probe);
  if (probeBytes.byteLength !== 1) {
    throw new Error("invalid immutable deferred payload probe length");
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");

  const target = new Uint8Array(totalBytes);
  target[0] = probeBytes[0]!;
  const quantum = 1024 * 1024;
  for (let offset = 1; offset < totalBytes; offset += quantum) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(totalBytes, offset + quantum) - 1;
    const res = await callWithRefresh(a, (token) =>
      fetch(url, {
        credentials: "include",
        headers: { ...bearerHeaders(token), Range: `bytes=${offset}-${end}` },
        signal,
      }),
    );
    assertAuthResponseCurrent(res);
    if (!res.ok) await throwApi(res);
    const rangeEncoding = res.headers.get("content-encoding")?.toLowerCase();
    if (
      res.status !== 206 ||
      (rangeEncoding !== undefined && rangeEncoding !== "identity") ||
      res.headers.get("content-range") !== `bytes ${offset}-${end}/${totalBytes}` ||
      res.headers.get("x-openclaude-content-sha256") !== contentSha256 ||
      immutableRecordIdFromHeaders(res.headers) !== recordId ||
      res.headers.get("x-openclaude-record-role") !== role
    ) {
      void res.body?.cancel().catch(() => {});
      throw new Error("immutable deferred payload range identity mismatch");
    }
    const chunk = new Uint8Array(await res.arrayBuffer());
    assertAuthResponseCurrent(res);
    if (chunk.byteLength !== end - offset + 1) {
      throw new Error("immutable deferred payload range length mismatch");
    }
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    target.set(chunk, offset);
  }
  return { bytes: target.buffer, contentSha256, recordId, role };
}

/** Per live-frames HTTP request. Journal hydrate adds its own page/time cap. */
export const LIVE_FRAMES_REQUEST_TIMEOUT_MS = 12_000;

/** /api/me/api-keys 线上形状（snake_case）；list / PATCH 共用。 */
type ApiKeyWire = {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  disabled_at?: string | null;
  credit_limit?: string | null;
  spent_credits?: string;
};

function apiKeyFromWire(k: ApiKeyWire): ApiKeySummary {
  return {
    id: k.id,
    label: k.label,
    keyPrefix: k.key_prefix,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    disabledAt: k.disabled_at ?? null,
    creditLimit: k.credit_limit ?? null,
    spentCredits: k.spent_credits ?? "0",
  };
}

export const api = {
  // ── 鉴权 ───────────────────────────────────────────────────────────

  /**
   * 邮箱+密码登录（POST /api/auth/login）。成功返回内存态 accessToken + 用户信息。
   * credentials:'include' 让浏览器接收并存下 HttpOnly refresh cookie（同源），后续 refresh 才能用。
   * turnstileToken 可选：开启 Turnstile 时由调用方传入（生产必填）。
   */
  async login(email: string, password: string, turnstileToken?: string): Promise<LoginResult> {
    const res = await withAuthCookieMutation(() =>
      authCookieFetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
        }),
      }),
    );
    if (!res.ok) {
      // 登录错误的 code 会在 useAuth.login 的 catch 里被拍平成 message，故在此 auth 边界
      // 先按 code 换友好中文（单一权威表 AUTH_ERROR_MESSAGES）；未知 code 原样（带追踪号）。
      try {
        await throwApi(res);
      } catch (e) {
        throw localizeAuthError(e);
      }
    }
    const b = (await res.json()) as {
      user: WireUser;
      access_token: string;
      access_exp: number;
      refresh_exp: number;
      remember: boolean;
      /** cohort lane（P3 RFC D1）：body 级下发；缺失=后端未部署 lane（向后兼容，见 useLaneGate）。 */
      lane?: string | null;
    };
    const user = adaptUser(b.user);
    // body 级 lane 优先于嵌套在 user 内的 lane；两者皆缺=null（向后兼容视为已就绪）。
    const lane = b.lane ?? user.lane ?? null;
    return {
      accessToken: b.access_token,
      accessExp: b.access_exp,
      refreshExp: b.refresh_exp,
      remember: b.remember,
      user: { ...user, lane },
      lane,
    };
  },

  /**
   * 静默刷新（POST /api/auth/refresh）：无 body、无 Authorization，仅凭同源 HttpOnly refresh
   * cookie 换新 access token。浏览器在同源 fetch 上自动带 Origin（满足后端 CSRF 校验）。
   * v5 仅回 access token（不回 user）。所有调用面共享 epoch-bound singleflight；调用方必须
   * 按 outcome.kind 区分真正失效与瞬时故障。
   * 该调用绝不经 callWithRefresh 包装，避免 401 时自我递归。
   */
  refresh(
    a: AuthSession,
    expectedEpoch?: number,
    surface?: RefreshSurface,
  ): Promise<RefreshOutcome> {
    return refreshAuth(a, expectedEpoch, surface);
  },

  /** 主动登出（POST /api/auth/logout）：吊销 refresh cookie。错误一律吞掉（前端清状态即视为已登出）。 */
  async logout(a?: AuthSession): Promise<void> {
    // abort 是同步触发的；logout 随即排到同 tab mutation FIFO 尾部，因此一定在旧 refresh
    // 真正 settle 之后才发出，避免晚到 refresh Set-Cookie 覆盖 logout 的清 cookie。
    if (a) void cancelAuthRefresh(a);
    try {
      await withAuthCookieMutation(() =>
        authCookieFetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers: { Accept: "application/json" },
        }),
      );
    } catch {
      /* ignore */
    }
  },

  /** 注册（POST /api/auth/register，201）。turnstileToken 开启 Turnstile 时必填。 */
  register(input: {
    email: string;
    password: string;
    turnstileToken?: string;
    displayName?: string;
    /** 勾选同意的协议版本（lib/legal TERMS_VERSION），后端落 users.terms_version 留证。 */
    termsVersion?: string;
  }): Promise<RegisterResult> {
    return jsonOrThrow<{ user_id: string; verify_email_sent: boolean }>(
      fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          ...(input.turnstileToken ? { turnstile_token: input.turnstileToken } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
          ...(input.termsVersion ? { terms_version: input.termsVersion } : {}),
        }),
      }),
    ).then((b) => ({ userId: b.user_id, verifyEmailSent: b.verify_email_sent }));
  },

  /** 邮箱验证（POST /api/auth/verify-email）：成功同时签发 session(同 login cookie 语义)。 */
  async verifyEmail(email: string, code: string): Promise<VerifyEmailResult> {
    const res = await withAuthCookieMutation(() =>
      authCookieFetch("/api/auth/verify-email", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      }),
    );
    if (!res.ok) {
      try {
        await throwApi(res);
      } catch (e) {
        throw localizeAuthError(e);
      }
    }
    const b = (await res.json()) as {
      user_id: string;
      newly_verified: boolean;
      user: WireUser;
      access_token: string;
      access_exp: number;
      refresh_exp: number;
      remember: boolean;
      lane?: string | null;
    };
    const user = adaptUser(b.user);
    const lane = b.lane ?? user.lane ?? null;
    return {
      userId: b.user_id,
      newlyVerified: b.newly_verified,
      accessToken: b.access_token,
      accessExp: b.access_exp,
      refreshExp: b.refresh_exp,
      remember: b.remember,
      user: { ...user, lane },
      lane,
    };
  },

  /** 重发验证邮件（POST /api/auth/resend-verification）。恒 200;email_sent 区分真实发信失败。 */
  resendVerification(email: string): Promise<{ accepted: boolean; emailSent: boolean }> {
    return jsonOrThrow<{ accepted: boolean; email_sent?: boolean }>(
      fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    ).then((b) => ({ accepted: b.accepted, emailSent: b.email_sent !== false }));
  },

  /** 跨设备查邮箱验证态（GET /api/auth/check-verification?email=）。后端防枚举，恒 200。 */
  checkVerification(email: string): Promise<{ verified: boolean }> {
    return jsonOrThrow<{ verified: boolean }>(
      fetch(`/api/auth/check-verification?email=${encodeURIComponent(email)}`, {
        headers: { Accept: "application/json" },
      }),
    );
  },

  /**
   * 发起密码重置（POST /api/auth/request-password-reset）。后端防枚举：无论邮箱是否存在
   * 恒返 200 + accepted（仅 turnstile 校验失败会 400 TURNSTILE_FAILED）。校验通过后后端给
   * 该邮箱发一封含 `/reset-password?token=…` 链接的邮件，用户点链接回站内走 confirmPasswordReset。
   * turnstileToken：开启 Turnstile 时必填（生产）；canary bypass 发占位串即可。
   */
  requestPasswordReset(email: string, turnstileToken?: string): Promise<{ accepted: boolean }> {
    return jsonOrThrow<{ accepted: boolean }>(
      fetch("/api/auth/request-password-reset", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email,
          ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
        }),
      }),
    );
  },

  /**
   * 完成密码重置（POST /api/auth/confirm-password-reset）。token 来自重置邮件链接的
   * `?token=` 参数；成功后该用户**所有未吊销的 refresh token 全部被撤销**（强制各端重登）。
   * token 失效 / 过期 / 已用 / 新密码不合规 → 400（经 ApiError 抛，调用方据 message 提示）。
   */
  confirmPasswordReset(
    token: string,
    newPassword: string,
  ): Promise<{ userId: string; revokedRefreshTokens: number }> {
    return jsonOrThrow<{ user_id: string; revoked_refresh_tokens: number }>(
      fetch("/api/auth/confirm-password-reset", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ token, new_password: newPassword }),
      }),
    ).then((b) => ({ userId: b.user_id, revokedRefreshTokens: b.revoked_refresh_tokens }));
  },

  // ── 账户 ───────────────────────────────────────────────────────────

  /** 当前用户（GET /api/me，Bearer）。credits 为字符串大数，adaptUser 原样保留。
   *  P3 RFC D1：响应体附带 cohort `lane`（body 级优先，兼容嵌套在 user 内）；缺失=后端未部署=null。 */
  getMe: (a: AuthSession) =>
    jsonOrThrow<{ user: WireUser; lane?: string | null }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((r) => {
      const user = adaptUser(r.user);
      return { ...user, lane: r.lane ?? user.lane ?? null };
    }),

  /** 偏好快照（GET /api/me/preferences，Bearer）。 */
  getPreferences: (a: AuthSession) =>
    jsonOrThrow<Preferences>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/preferences", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  getCollaborationConfig: (a: AuthSession, sessionId?: string, opts?: { signal?: AbortSignal }) =>
    jsonOrThrow<{
      rev: number
      defaultMode: "solo" | "advisor" | "team"
      defaultAdvisorModel: string | null
      session: {
        mode: "solo" | "advisor" | "team"
        advisorModel: string | null
        configVersion: string
        source: "session" | "default"
      }
      advisorModels?: Array<{ id: string; label: string; engine: string }>
      advisorUnavailableReason?: string
      advisorConsultParents?: string[]
      advisorConsultParentReason?: string
      advisorConsultAllowed?: boolean
      parentEngine?: string
    }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/collaboration-config${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
          { credentials: "include", headers: bearerHeaders(t), signal: opts?.signal },
        ),
      ),
    ),

  putCollaborationConfig: (
    a: AuthSession,
    body: {
      sessionId?: string
      mode: "solo" | "advisor" | "team"
      advisorModel?: string | null
      expectedRev?: number
      asDefault?: boolean
    },
  ) =>
    jsonOrThrow<{
      rev: number
      defaultMode: "solo" | "advisor" | "team"
      defaultAdvisorModel: string | null
      session: {
        mode: "solo" | "advisor" | "team"
        advisorModel: string | null
        configVersion: string
        source: "session" | "default"
      }
      advisorModels?: Array<{ id: string; label: string; engine: string }>
      advisorUnavailableReason?: string
      advisorConsultParents?: string[]
      advisorConsultParentReason?: string
      advisorConsultAllowed?: boolean
      parentEngine?: string
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/collaboration-config", {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 改偏好（PATCH /api/me/preferences，Bearer）→ 新快照。 */
  patchPreferences: (a: AuthSession, patch: Preferences) =>
    jsonOrThrow<Preferences>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/preferences", {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  getQqBinding: (a: AuthSession) =>
    jsonOrThrow<QqBindingStatus>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/qq-binding", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startQqBinding: (a: AuthSession) =>
    jsonOrThrow<QqBindingStart>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/qq-binding/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  deleteQqBinding: (a: AuthSession) =>
    jsonOrThrow<{ ok: boolean; unbound: boolean }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/qq-binding", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 自由文本反馈（POST /api/feedback）。缺 Bearer 的公共调用仍可匿名；浏览器登录态提供
   * 无效 Bearer 时后端返回 401，callWithRefresh 刷新重放，避免把登录用户静默记成匿名。
   * 两种 source 分支分别重建 payload，消息上下文不会意外泄漏到设置反馈，反之亦然。
   */
  submitFeedback: (a: AuthSession, input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> =>
    jsonOrThrow<FeedbackSubmitResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/feedback", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(
            input.category !== "response"
              ? {
                  category: input.category,
                  description: input.description,
                  ...(input.version ? { version: input.version } : {}),
                  ...(input.requestId ? { request_id: input.requestId } : {}),
                  ...(input.sessionId ? { session_id: input.sessionId } : {}),
                  meta: {
                    source: "settings",
                    ...(input.meta.locale ? { locale: input.meta.locale } : {}),
                    ...(input.meta.timezone ? { timezone: input.meta.timezone } : {}),
                  },
                }
              : {
                  category: "response",
                  description: input.description,
                  ...(input.requestId ? { request_id: input.requestId } : {}),
                  ...(input.sessionId ? { session_id: input.sessionId } : {}),
                  meta: {
                    source: "message",
                    message_id: input.meta.messageId,
                    role: input.meta.role,
                    ...(input.meta.errorCode ? { error_code: input.meta.errorCode } : {}),
                    ...(input.meta.reason ? { reason: input.meta.reason } : {}),
                    ...(input.meta.responseExcerpt
                      ? { response_excerpt: input.meta.responseExcerpt }
                      : {}),
                  },
                },
          ),
        }),
      ),
    ),

  /**
   * 用量统计（GET /api/me/usage，Bearer）。summary + 分页 sessions（offset）+
   * keyset ledger（before）+ savings。**所有大数字段为字符串，勿数值化。**
   * 抛 ApiError（含 400 INVALID_USAGE_QUERY）—— 调用方自行兜底，不再吞成 null。
   */
  getUsage: (a: AuthSession, q?: UsageQuery): Promise<UsageResponse> => {
    const qs = new URLSearchParams();
    if (q?.sessionsLimit != null) qs.set("sessions_limit", String(q.sessionsLimit));
    if (q?.sessionsOffset != null) qs.set("sessions_offset", String(q.sessionsOffset));
    if (q?.ledgerLimit != null) qs.set("ledger_limit", String(q.ledgerLimit));
    if (q?.ledgerBefore) qs.set("ledger_before", q.ledgerBefore);
    if (q?.boardProjectId) qs.set("boardProjectId", q.boardProjectId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<UsageResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/usage${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  /**
   * 用量报表（GET /api/me/usage/report，Bearer，图表化窗口口径）。summary + 趋势 +
   * 按模型 + 账本（收支趋势 / 支出构成），window 默认由后端取 7d。trend 已补零升序。
   * **所有数字字段为字符串大数，勿数值化后当权威。** 抛 ApiError 由调用方兜底。
   */
  getMyUsageReport: (
    a: AuthSession,
    window: UsageReportWindow,
    q?: { boardProjectId?: string },
  ): Promise<UsageReport> => {
    const qs = new URLSearchParams({ window });
    if (q?.boardProjectId) qs.set("boardProjectId", q.boardProjectId);
    return jsonOrThrow<UsageReport>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/usage/report?${qs.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  // ── API Keys（注意：当前后端 admin-only rollout，普通用户调用返 403） ─────────

  /** 列出我的 API key（GET /api/me/api-keys，Bearer）。不含明文。 */
  listApiKeys: (a: AuthSession): Promise<ApiKeySummary[]> =>
    jsonOrThrow<{ keys: ApiKeyWire[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/api-keys", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.keys.map(apiKeyFromWire)),

  /**
   * 0277：改名 / 临时禁用 / 单 key 上限（PATCH /api/me/api-keys/:id，Bearer）。
   * 400 INVALID_LABEL / INVALID_LIMIT / INVALID_BODY，404 不存在或非本人，经 ApiError 抛。
   */
  updateApiKey: (a: AuthSession, id: string, patch: ApiKeyPatch): Promise<ApiKeySummary> => {
    const body: Record<string, unknown> = {};
    if (patch.label !== undefined) body.label = patch.label;
    if (patch.disabled !== undefined) body.disabled = patch.disabled;
    if (patch.creditLimit !== undefined) body.credit_limit = patch.creditLimit;
    return jsonOrThrow<ApiKeyWire>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/api-keys/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ).then(apiKeyFromWire);
  },

  /**
   * 0277：经 API key 的消耗报表（GET /api/me/api-keys/usage，Bearer）。
   * summary + 趋势 + 按 key + 按模型 + 最近明细；keyId 可选钉单 key。
   * **所有数字字段为字符串大数。**
   */
  getApiKeyUsage: (
    a: AuthSession,
    window: UsageReportWindow,
    keyId?: string | null,
  ): Promise<ApiKeyUsageReport> => {
    const qs = new URLSearchParams({ window });
    if (keyId) qs.set("key_id", keyId);
    return jsonOrThrow<ApiKeyUsageReport>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/api-keys/usage?${qs.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  /**
   * 新建 API key（POST /api/me/api-keys，201，Bearer）。返完整明文 plaintext **仅一次**，
   * 必须立即引导用户复制保存；后端永远无法重新生成。400 INVALID_LABEL 经 ApiError 抛。
   */
  createApiKey: (a: AuthSession, label: string): Promise<CreatedApiKey> =>
    jsonOrThrow<{
      id: string;
      label: string;
      key_prefix: string;
      plaintext: string;
      created_at: string;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/api-keys", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ label }),
        }),
      ),
    ).then((b) => ({
      id: b.id,
      label: b.label,
      keyPrefix: b.key_prefix,
      plaintext: b.plaintext,
      createdAt: b.created_at,
    })),

  /**
   * 撤销 API key（DELETE /api/me/api-keys/:id，Bearer）。软撤销，幂等。
   * 不存在 / 已撤销 / 非本人一律 404（不暴露存在性），经 ApiError 抛。
   */
  deleteApiKey: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/api-keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 公开（匿名可读） ────────────────────────────────────────────────

  /** 公开配置（GET /api/public/config）：Turnstile site key / 注册开关等。 */
  getPublicConfig: (): Promise<PublicConfig> =>
    jsonOrThrow<{
      turnstile_site_key: string;
      turnstile_bypass: boolean;
      require_email_verified: boolean;
      feature_remote_ssh: boolean;
      feature_image2: boolean;
      allow_registration: boolean;
      feature_community_blog?: boolean;
      feature_community_blog_ai_review?: boolean;
    }>(fetch("/api/public/config", { headers: { Accept: "application/json" } })).then((b) => ({
      turnstileSiteKey: b.turnstile_site_key,
      turnstileBypass: b.turnstile_bypass,
      requireEmailVerified: b.require_email_verified,
      featureRemoteSsh: b.feature_remote_ssh,
      featureImage2: b.feature_image2,
      featureCommunityBlog: b.feature_community_blog === true,
      featureCommunityBlogAiReview: b.feature_community_blog_ai_review === true,
      allowRegistration: b.allow_registration,
    })),

  /**
   * 公开模型列表（GET /api/public/models）。可选带 Bearer（登录用户走
   * visibility/grants 视图）；每项含后端投影的 supported_efforts 能力。
   * `locked_models` 是订阅门槛挡住的可见行，缺省/非数组时按 []，永不并入 models。
   */
  async getPublicModels(
    a?: AuthSession,
  ): Promise<{ models: PublicModel[]; lockedModels: LockedPublicModel[] }> {
    const run = (t?: string) =>
      fetch("/api/public/models", {
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{ models?: PublicModel[]; locked_models?: LockedPublicModel[] }>(
      res,
    );
    return {
      models: Array.isArray(b.models) ? b.models : [],
      lockedModels: Array.isArray(b.locked_models) ? b.locked_models : [],
    };
  },

  // ── 对话前置（Agent 订阅 / 容器） ────────────────────────────────────

  /** Workspace-open hint: no subscription, message, or model request. */
  prepareWorkspace: (a: AuthSession, signal?: AbortSignal, draft?: WorkspaceDraftHint): Promise<{ accepted: boolean }> =>
    jsonOrThrow<{ accepted: boolean }>(callWithRefresh(a, t => fetch('/api/agent/prepare', {
      method: 'POST', headers: { Authorization: `Bearer ${t}`,
        ...(draft ? { 'Content-Type': 'application/json' } : {}) }, signal,
      ...(draft ? { body: JSON.stringify(draft) } : {}),
    }))),

  /** Agent 订阅/容器状态（GET /api/agent/status，Bearer）。 */
  getAgentStatus: (a: AuthSession): Promise<AgentStatus> =>
    jsonOrThrow<{
      runtime_ready: boolean;
      ondemand?: boolean;
      subscription: {
        id: string;
        plan: string;
        status: string;
        start_at: string;
        end_at: string;
        auto_renew: boolean;
        last_renewed_at: string | null;
      } | null;
      container: {
        id: string;
        subscription_id: string | null;
        docker_id: string | null;
        docker_name: string | null;
        image: string | null;
        status: string;
        last_started_at: string | null;
        last_stopped_at: string | null;
        volume_gc_at: string | null;
        last_error: string | null;
      } | null;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/status", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      runtimeReady: b.runtime_ready,
      ondemand: Boolean(b.ondemand),
      subscription: b.subscription
        ? {
            id: b.subscription.id,
            plan: b.subscription.plan,
            status: b.subscription.status,
            startAt: b.subscription.start_at,
            endAt: b.subscription.end_at,
            autoRenew: b.subscription.auto_renew,
            lastRenewedAt: b.subscription.last_renewed_at,
          }
        : null,
      container: b.container
        ? {
            id: b.container.id,
            subscriptionId: b.container.subscription_id,
            dockerId: b.container.docker_id,
            dockerName: b.container.docker_name,
            image: b.container.image,
            status: b.container.status,
            lastStartedAt: b.container.last_started_at,
            lastStoppedAt: b.container.last_stopped_at,
            volumeGcAt: b.container.volume_gc_at,
            lastError: b.container.last_error,
          }
        : null,
    })),

  /**
   * 开通 Agent 订阅（POST /api/agent/open，Bearer）。成功 202（status='provisioning'，
   * 容器异步开机，需随后 pollAgentReady）。失败经 ApiError 抛：
   *   - 402（issues.shortfall = 缺口积分字符串）→ 余额不足
   *   - 409（issues.subscription_id / issues.end_at）→ 已有有效订阅
   * balanceAfter 为字符串大数，勿数值化。
   */
  openAgent: (a: AuthSession): Promise<AgentOpenResult> =>
    jsonOrThrow<{
      subscription_id: string;
      container_id: string;
      status: string;
      start_at: string;
      end_at: string;
      balance_after: string;
      ledger_id: string;
      docker_name: string;
      workspace_volume: string;
      home_volume: string;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/open", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      subscriptionId: b.subscription_id,
      containerId: b.container_id,
      status: b.status,
      startAt: b.start_at,
      endAt: b.end_at,
      balanceAfter: b.balance_after,
      ledgerId: b.ledger_id,
      dockerName: b.docker_name,
      workspaceVolume: b.workspace_volume,
      homeVolume: b.home_volume,
    })),

  /** 退订 Agent（POST /api/agent/cancel，Bearer）。404 = 未订阅（经 ApiError 抛）。 */
  agentCancel: (a: AuthSession): Promise<AgentCancelResult> =>
    jsonOrThrow<{
      subscription_id: string;
      end_at: string;
      auto_renew: false;
      was_auto_renew: boolean;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/cancel", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      subscriptionId: b.subscription_id,
      endAt: b.end_at,
      autoRenew: false as const,
      wasAutoRenew: b.was_auto_renew,
    })),

  /**
   * 容器冷启轮询封装（对话前置）。openAgent 返 202 provisioning 后，容器在后台异步开机，
   * 此 helper 轮询 getAgentStatus 直到容器 'running'。
   *
   * 终态语义：
   *   - container.status==='running'         → resolve(status)
   *   - container.status==='error'           → reject(ApiError 503 CONTAINER_ERROR, 带 lastError)
   *   - 超时（timeoutMs）                     → reject(ApiError 504 PROVISION_TIMEOUT)
   *   - signal abort                          → reject(AbortError)
   * 其余态（provisioning/stopped/无容器）继续按 intervalMs 轮询。
   *
   * 说明：WS user-chat-bridge 的容器未就绪用 **WS close code 4503 + retryAfterSec**
   * 表达（非 HTTP 状态），其重连节流由 P4 useChatSocket 负责；此处只覆盖 REST 侧的
   * open→running 过渡，供对话前置 UI 展示「正在开机」。
   */
  async pollAgentReady(
    a: AuthSession,
    opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentStatus> {
    const intervalMs = opts?.intervalMs ?? 2000;
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const status = await api.getAgentStatus(a);
      const cs = status.container?.status;
      if (cs === "running") return status;
      if (cs === "error") {
        throw new ApiError({
          status: 503,
          code: "CONTAINER_ERROR",
          message: status.container?.lastError || "容器开机失败，请稍后重试或联系支持。",
        });
      }
      if (Date.now() + intervalMs >= deadline) {
        throw new ApiError({
          status: 504,
          code: "PROVISION_TIMEOUT",
          message: "容器开机超时，请稍后重试。",
        });
      }
      await sleep(intervalMs, opts?.signal);
    }
  },

  // ── 会话历史（权威源 = gateway，camelCase wire；走 Bearer + callWithRefresh） ──

  /** 列出我的会话（GET /api/sessions/list，Bearer）。无 messages 的元数据列表。
   *  无参时与历史行为一致（返回数组，忽略 nextCursor），供既有调用方 / App 测试桩继续工作。 */
  listSessions: (a: AuthSession): Promise<SessionMeta[]> =>
    api.listSessionsPage(a).then((page) => page.sessions),

  /**
   * 会话列表分页（GET /api/sessions/list?limit=&before=&includeArchived=1）。
   * 不传 query 时后端行为与全量列表一致；有 nextCursor 则可继续用 before 拉下一页。
   */
  listSessionsPage: (a: AuthSession, query?: SessionListQuery): Promise<SessionListPage> => {
    const params = new URLSearchParams();
    if (query?.limit != null) params.set("limit", String(query.limit));
    if (query?.before != null) params.set("before", String(query.before));
    if (query?.includeArchived) params.set("includeArchived", "1");
    const qs = params.toString();
    return jsonOrThrow<{ sessions: SessionMeta[]; nextCursor?: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/list${qs ? `?${qs}` : ""}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({ sessions: b.sessions || [], nextCursor: b.nextCursor }));
  },

  /**
   * 全文搜索会话（GET /api/sessions/search?q=&limit=30&includeArchived=0）。
   * signal 用于输入变更取消在途请求。
   */
  searchSessions: (
    a: AuthSession,
    q: string,
    opts?: {
      limit?: number;
      includeArchived?: boolean;
      signal?: AbortSignal;
      projectId?: string | null;
    },
  ): Promise<SessionSearchResponse> => {
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("limit", String(opts?.limit ?? 30));
    params.set("includeArchived", opts?.includeArchived ? "1" : "0");
    if (opts && "projectId" in opts) {
      params.set(
        "projectId",
        opts.projectId === null || opts.projectId === undefined ? "none" : opts.projectId,
      );
    }
    return jsonOrThrow<SessionSearchResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/search?${params.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
          signal: opts?.signal,
        }),
      ),
    ).then((b) => ({ results: Array.isArray(b.results) ? b.results : [] }));
  },

  /**
   * 批量归档 / 取消归档 / 删除 / 移动项目（POST /api/sessions/batch）。
   */
  batchSessions: (a: AuthSession, body: SessionBatchInput): Promise<SessionBatchResult> =>
    jsonOrThrow<SessionBatchResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/sessions/batch", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /**
   * 打开会话标已读（POST /api/sessions/:id/read）。不挂 GET :id，避免预取/搜索误标。
   */
  markSessionRead: (a: AuthSession, id: string): Promise<{ ok: true; updated: number }> =>
    jsonOrThrow<{ ok: true; updated: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/read`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
        }),
      ),
    ),

  /** 全部标已读（POST /api/sessions/read-all）。 */
  markAllSessionsRead: (a: AuthSession): Promise<{ ok: true; updated: number }> =>
    jsonOrThrow<{ ok: true; updated: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/sessions/read-all", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
        }),
      ),
    ),

  /**
   * 取单个会话（GET /api/sessions/:id，Bearer）。
   * sinceSeq>0 且 revision 匹配 → 增量同步；缺失/不匹配由后端降级全量。
   * 不存在 → 404（经 ApiError 抛）。id 形态须匹配后端 `[A-Za-z0-9_-]{8,50}`。
   */
  getSession: (
    a: AuthSession,
    id: string,
    sinceSeq = 0,
    sinceHistoryRevision?: number,
    permissionLookupIds?: string[],
  ): Promise<SessionDetail> => {
    const params = new URLSearchParams();
    if (sinceSeq > 0) {
      params.set("since", String(sinceSeq));
      if (Number.isSafeInteger(sinceHistoryRevision) && (sinceHistoryRevision as number) >= 0) {
        params.set("since_history_revision", String(sinceHistoryRevision));
      }
    }
    if (permissionLookupIds && permissionLookupIds.length > 0) {
      params.set("permission_lookup", permissionLookupIds.slice(0, 16).join(","));
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    const request = (requestSuffix: string) =>
      jsonOrThrow<SessionDetail>(
        callWithRefresh(a, (t) =>
          fetch(`/api/sessions/${encodeURIComponent(id)}${requestSuffix}`, {
            credentials: "include",
            headers: bearerHeaders(t),
          }),
        ),
      );
    return request(suffix).then(async (initial) => {
      let detail = initial;
      let historyRevisionUnsupported = false;
      if (!Number.isSafeInteger(detail.historyRevision) || (detail.historyRevision as number) < 0) {
        // A legacy backend can return a plausible `_seq` partial without the
        // history revision. Never retain that cursor: retry an incremental
        // request once as full, and mark every legacy full so callers evict
        // hydrated history caches during a coordinated downgrade.
        if (sinceSeq > 0) {
          detail = await request("");
        }
        historyRevisionUnsupported = true;
      }
      if (
        !Number.isSafeInteger(detail.timelineGeneration) ||
        (detail.timelineGeneration as number) < 1
      ) {
        // New bundles must never consume the predecessor's “final locator +
        // process control” wire: this build deliberately has no substitute
        // process card. During an atomic release rollback, keep the current
        // real timeline untouched; the existing WS build handshake performs
        // the bounded safe reload to the matching predecessor bundle.
        throw new ApiError({
          status: 409,
          code: "TIMELINE_CAPABILITY_MISMATCH",
          message: "版本切换中，正在恢复匹配的会话界面。",
        });
      }
      return historyRevisionUnsupported
        ? { ...detail, _historyRevisionUnsupported: true as const }
        : detail;
    });
  },

  /** Cursor-paged exact runtime frames persisted before their original WS
   * delivery. Callers page until hasMore=false; hydrateDurableLiveFrameJournal
   * owns the total page/time cap. Each request has a timeout so a stuck SQL
   * plan cannot pin the restore loop forever. */
  getSessionLiveFrames: (
    a: AuthSession,
    id: string,
    after = "0",
    limit = 200,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DurableLiveFramePage> => {
    const params = new URLSearchParams();
    // First shot uses after=0 (LIVE_JOURNAL_OPEN_CURSOR). seek=tail is
    // opt-in only — do not send it as the open-session default.
    if (after === "tail") {
      params.set("seek", "tail");
      params.set("limit", String(limit));
    } else {
      params.set("after", after);
      params.set("limit", String(limit));
    }
    const timeoutMs = opts?.timeoutMs ?? LIVE_FRAMES_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("live-frames request timeout", "TimeoutError")),
      timeoutMs,
    );
    const parent = opts?.signal;
    const onParentAbort = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", onParentAbort);
    return jsonOrThrow<DurableLiveFramePage>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/live-frames?${params.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
          signal: controller.signal,
        }),
      ),
    ).finally(() => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    });
  },

  getSessionLiveUnits: (
    a: AuthSession,
    id: string,
    query?: {
      n?: number;
      before?: string | null;
      group?: string | null;
      nestedBefore?: string | null;
    },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> => {
    const params = new URLSearchParams();
    params.set("view", "units");
    params.set("n", String(query?.n ?? 20));
    if (query?.before) params.set("before", query.before);
    if (query?.group) params.set("group", query.group);
    if (query?.nestedBefore) params.set("nestedBefore", query.nestedBefore);
    const timeoutMs = opts?.timeoutMs ?? LIVE_FRAMES_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("live-frames request timeout", "TimeoutError")),
      timeoutMs,
    );
    const parent = opts?.signal;
    const onParentAbort = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", onParentAbort);
    return jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/live-frames?${params.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
          signal: controller.signal,
        }),
      ),
    ).finally(() => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    });
  },

  getLiveFramePayload: (
    a: AuthSession,
    id: string,
    ref: { recordId?: string; sha256?: string },
  ): Promise<{ source: "live" | "tape"; payload: unknown; sha256?: string }> => {
    const params = new URLSearchParams();
    if (ref.recordId) params.set("recordId", ref.recordId);
    if (ref.sha256) params.set("sha256", ref.sha256);
    return jsonOrThrow(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/live-frames/payload?${params.toString()}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  getSessionGoal: (a: AuthSession, id: string): Promise<GoalStateSnapshot | null> =>
    jsonOrThrow<{ goal: GoalStateSnapshot | null }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/session-goals/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((body) => body.goal),

  setSessionGoal: (
    a: AuthSession,
    id: string,
    input: {
      objective: string;
      tokenBudget: number | null;
      creditBudget: string | null;
      expectedStateRevision: number;
    },
  ): Promise<GoalStateSnapshot> =>
    jsonOrThrow<{ goal: GoalStateSnapshot }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/session-goals/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((body) => body.goal),

  transitionSessionGoal: (
    a: AuthSession,
    id: string,
    action: "pause" | "resume" | "complete" | "clear",
    expectedStateRevision: number,
  ): Promise<GoalStateSnapshot | null> =>
    jsonOrThrow<{ goal: GoalStateSnapshot | null }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/session-goals/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ expectedStateRevision }),
        }),
      ),
    ).then((body) => body.goal),

  /**
   * 取归档分页（GET /api/sessions/:id/archive，Bearer）——点击后从归档 chunk 读取一页更早历史。
   * `beforeSeq>0` → 只返 `_seq < beforeSeq` 的最近 `limit` 条（升序，上翻游标）；
   * 缺省(0) → server 从 archivedThroughSeq+1 起（最新归档页）。`limit` 默认 100、后端上限 200。
   */
  getSessionArchive: (
    a: AuthSession,
    id: string,
    beforeSeq = 0,
    limit = 100,
  ): Promise<SessionArchivePage> => {
    const params = new URLSearchParams();
    if (beforeSeq > 0) params.set("before", String(beforeSeq));
    if (limit > 0) params.set("limit", String(limit));
    const qs = params.toString();
    return jsonOrThrow<SessionArchivePage>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/archive${qs ? `?${qs}` : ""}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  /** Explicit older-page read for the one real history timeline. No scroll
   * observer calls this method; the user-facing top button is the sole trigger. */
  getSessionTimelinePage: (
    a: AuthSession,
    id: string,
    cursor: string,
    limit = 100,
  ): Promise<SessionTimelinePage> => {
    const params = new URLSearchParams({ cursor });
    if (limit > 0) params.set("limit", String(limit));
    return jsonOrThrow<SessionTimelinePage>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/timeline?${params}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  /** 读取单条真实、脱敏后不可变 JSON；Range 分块，不发整条巨型响应。 */
  getTapeRecordPayload: async (
    a: AuthSession,
    id: string,
    tapeId: string,
    recordOrdinal: number,
    signal?: AbortSignal,
  ): Promise<TapeRecordPayload> => {
    return getExactDeferredPayload(
      a,
      `/api/sessions/${encodeURIComponent(id)}/tape/${encodeURIComponent(tapeId)}` +
        `/records/${recordOrdinal}/payload`,
      signal,
    );
  },

  /** 超长 user 行的原始 JSON。与 tape payload 共用 Range + SHA 契约。 */
  getUserMessagePayload: async (
    a: AuthSession,
    id: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<TapeRecordPayload> => {
    return getExactDeferredPayload(
      a,
      `/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/payload`,
      signal,
    );
  },

  /**
   * 写入会话（PUT /api/sessions/:id，Bearer）。乐观并发：传 `_baseSyncedAt`（上次同步
   * 到的 updatedAt），服务端发现被他人抢先 → 409 conflict（经 ApiError 抛，调用方需
   * 重新拉取合并后重试）。wire body 上限 2MB / 存储 blob 上限 4MB，超出 413。
   */
  putSession: (a: AuthSession, id: string, input: PutSessionInput): Promise<PutSessionResult> =>
    jsonOrThrow<PutSessionResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /**
   * 会话元数据 PATCH（title / projectId / pinned）。当前打 PATCH /api/sessions/:id；
   * 后端若换成 PATCH /api/sessions/:id/meta，只改这一处。
   */
  patchSessionMeta: (
    a: AuthSession,
    id: string,
    patch: PatchSessionMetaInput,
  ): Promise<{ ok: true; updatedAt: number }> =>
    jsonOrThrow<{ ok: true; updatedAt: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  /**
   * 会话重命名。走 patchSessionMeta，后端换 /meta 端点时不必再改这里。
   */
  patchSessionTitle: (
    a: AuthSession,
    id: string,
    title: string,
  ): Promise<{ ok: true; updatedAt: number }> => api.patchSessionMeta(a, id, { title }),

  /**
   * 会话级模型选择持久化（PATCH /api/sessions/:id，Bearer，元数据专用，与 rename 同款）。
   * best-effort 失败契约同 rename：本地已改,服务端失败则下次 listSessions server-wins
   * 盖回,用户重选即重试。会话行尚未建（新会话未发首条消息）时 404,同样吞掉——建行
   * PUT(ensureServerSession)会随体携带 modelId 收敛。
   */
  patchSessionModel: (
    a: AuthSession,
    id: string,
    modelId: string,
  ): Promise<{ ok: true; updatedAt: number }> =>
    jsonOrThrow<{ ok: true; updatedAt: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ modelId }),
        }),
      ),
    ),

  /**
   * 跨设备持久化「用户发送的消息」（POST /api/sessions/:id/user-message，Bearer）。
   * 带前端 client 消息 id；服务端直写(role:'user',绕乐观并发,scoped by userId),
   * getSession 回带同 id → 前端合并去重。best-effort，调用方吞错不阻断发送。
   */
  appendUserMessage: (
    a: AuthSession,
    id: string,
    msg: {
      id: string;
      text: string;
      ts: number;
      media?: unknown;
      _retryMedia?: unknown;
      _imageEdit?: unknown;
      _modelText?: string;
      _replyTo?: unknown;
      _routing?: unknown;
      _sendAttempt?: number;
      _isAutoRetry?: boolean;
      _recoveryOfClientMessageId?: string;
      _recoveryMode?: "checkpoint" | "replay";
      _automaticRecovery?: boolean;
      _idem?: string;
    },
  ): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/user-message`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(msg),
        }),
      ),
    ).then(() => undefined),

  /** 删除会话（DELETE /api/sessions/:id，Bearer）。幂等，恒 200。 */
  deleteSession: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),
  ...projectsApi,
  ...memorySkillsApi,
  ...integrationsApi,

  // ── 企业版(P3.1)org 自助后台 ─────────────────────────────────────────
  // org 由服务端从 caller membership 推导,前端**不带** org_id。批次 D 端点(usage/
  // invoice)本文件权威;批次 B(topup/balance/orders/ledger)、批次 C(skills)按方案契约
  // 调用(字段名以后端为准)。大数一律字符串贯穿。

  /** GET /api/org 概要(member+)。403=无 org 归属 / org 停用。 */
  getOrg: (a: AuthSession): Promise<OrgSummary> =>
    jsonOrThrow<{ org: OrgSummary }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.org),

  // ── 成员(A 批次后端已就绪) ──────────────────────────────────────────
  listOrgMembers: (a: AuthSession): Promise<OrgMember[]> =>
    jsonOrThrow<{ members: OrgMember[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/members", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.members),

  patchOrgMember: (
    a: AuthSession,
    uid: string,
    patch: {
      org_role?: OrgRole;
      billing_enabled?: boolean;
      status?: "active" | "suspended";
      /** 财务委派(三期):仅 owner 可改。 */
      billing_delegate?: boolean;
      /** 月度组织用量限额(积分;null=不限,字符串大数或数值;admin 可改)。 */
      monthly_org_budget?: string | number | null;
    },
  ): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/org/members/${encodeURIComponent(uid)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ).then(() => undefined),

  removeOrgMember: (a: AuthSession, uid: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/org/members/${encodeURIComponent(uid)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  listOrgInvitations: (a: AuthSession): Promise<OrgInvitation[]> =>
    jsonOrThrow<{ invitations: OrgInvitation[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invitations", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.invitations),

  createOrgInvitation: (a: AuthSession, email: string, orgRole: OrgRole): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invitations", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ email, org_role: orgRole }),
        }),
      ),
    ).then(() => undefined),

  revokeOrgInvitation: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/org/invitations/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  /** POST /api/org/invitations/accept(受邀者尚非成员,仅 requireAuth)。 */
  acceptOrgInvitation: (
    a: AuthSession,
    token: string,
  ): Promise<{ org_id: string; org_role: OrgRole }> =>
    jsonOrThrow<{ joined: boolean; org_id: string; org_role: OrgRole }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invitations/accept", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ token }),
        }),
      ),
    ).then((b) => ({ org_id: b.org_id, org_role: b.org_role })),

  // ── 报表(D 批次,本文件权威) ────────────────────────────────────────
  getOrgUsage: (a: AuthSession, window: OrgUsageWindow): Promise<OrgUsageReport> =>
    jsonOrThrow<OrgUsageReport>(
      callWithRefresh(a, (t) =>
        fetch(`/api/org/usage?window=${encodeURIComponent(window)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── 发票(D 批次,本文件权威) ────────────────────────────────────────
  getOrgInvoiceProfile: (a: AuthSession): Promise<OrgInvoiceProfile | null> =>
    jsonOrThrow<{ profile: OrgInvoiceProfile | null }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invoice-profile", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.profile),

  putOrgInvoiceProfile: (
    a: AuthSession,
    input: OrgInvoiceProfileInput,
  ): Promise<OrgInvoiceProfile> =>
    jsonOrThrow<{ profile: OrgInvoiceProfile }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invoice-profile", {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((b) => b.profile),

  listOrgInvoices: (a: AuthSession): Promise<OrgInvoiceRequest[]> =>
    jsonOrThrow<{ invoices: OrgInvoiceRequest[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invoices", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.invoices),

  createOrgInvoice: (a: AuthSession, orderIds: string[]): Promise<OrgInvoiceRequest> =>
    jsonOrThrow<{ invoice: OrgInvoiceRequest }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/invoices", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ order_ids: orderIds }),
        }),
      ),
    ).then((b) => b.invoice),

  // ── 充值(统一支付契约;topup 返 {ok,data:{order_no,qrcode_url,mobile_url}},轮询到账) ──
  orgTopup: (a: AuthSession, amountCents: string): Promise<OrgTopupResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/org/topup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ amount_cents: amountCents }),
        }),
      ),
    ),

  /** GET /api/org/balance → {credits}(批次 B)。轮询到账用。 */
  getOrgBalance: (a: AuthSession): Promise<string> =>
    jsonOrThrow<{ credits: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/balance", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.credits),

  listOrgOrders: (a: AuthSession): Promise<OrgOrder[]> =>
    jsonOrThrow<{ rows: OrgOrder[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/orders", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.rows ?? []),

  listOrgLedger: (a: AuthSession): Promise<OrgLedgerRow[]> =>
    jsonOrThrow<{ rows: OrgLedgerRow[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/ledger", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.rows ?? []),

  // ── 技能(批次 C 契约) ───────────────────────────────────────────────
  getOrgSkills: (a: AuthSession): Promise<OrgSkillsResponse> =>
    jsonOrThrow<OrgSkillsResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({ installed: b.installed ?? [], available: b.available ?? [] })),

  installOrgSkill: (a: AuthSession, slug: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/skills/install", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ slug }),
        }),
      ),
    ).then(() => undefined),

  uninstallOrgSkill: (a: AuthSession, slug: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/org/skills/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 席位订阅 + 自助开通(二期批次 F 契约;已按 F 实际响应形对齐,normalizeOrg* 适配字段名)──
  //
  // 到账判定统一复用 GET /api/payment/orders/:order_no(getOrder,status→'paid')。
  // 下单响应形(与 F issueOrderQr 对齐):{ ok, data: { order_no, qrcode_url, ... } }。
  // 经 parseOrgOrder 归一为 {orderNo, qr, mobileUrl};现行 UI 仅消费 qr，mobileUrl 只保留协议兼容。
  // GET plans / subscription 为顶层裸对象(无 ok/data 包裹)。大数全字符串贯穿。
  // owner 门在 UI 层按 role 控制,403 响应兜底 toast(防降权窗口)。

  /** GET /api/org/plans:企业套餐档(无 org 也可读,创建向导用)。normalizeOrgPlan 适配字段名。 */
  getOrgPlans: (a: AuthSession): Promise<OrgPlan[]> =>
    jsonOrThrow<{ plans?: unknown[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/plans", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => (Array.isArray(b.plans) ? b.plans : []).map(normalizeOrgPlan)),

  /** POST /api/org/provision:自助开通(组织名+档+席位)→ 扫码。401 未登录;已有 org → 结构化错。 */
  provisionOrg: (
    a: AuthSession,
    input: { orgName: string; planCode: string; seats: number },
  ): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/org/provision", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({
            org_name: input.orgName,
            plan_code: input.planCode,
            seats: input.seats,
          }),
        }),
      ),
    ),

  /** GET /api/org/subscription:当前订阅 + 档列表(member 可读)。normalizeOrg* 适配。 */
  getOrgSubscription: (a: AuthSession): Promise<OrgSubscriptionInfo> =>
    jsonOrThrow<{ subscription?: unknown; plans?: unknown[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/org/subscription", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      subscription: normalizeOrgSubscription(b.subscription),
      plans: (Array.isArray(b.plans) ? b.plans : []).map(normalizeOrgPlan),
    })),

  /** POST /api/org/subscribe(owner):订阅 / 续费(档+**总席位**)→ 扫码。403 非 owner。 */
  subscribeOrg: (
    a: AuthSession,
    input: { planCode: string; seats: number },
  ): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/org/subscribe", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: input.planCode, seats: input.seats }),
        }),
      ),
    ),

  /** POST /api/org/seats(owner):加席。**seats = 席位增量(>0)**,对齐 F createOrgSeatsOrder
   *  「席位增量」语义(kind='upgrade',整份即时入池,period 不变)。403 非 owner。 */
  addOrgSeats: (a: AuthSession, seatsDelta: number): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/org/seats", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ seats: seatsDelta }),
        }),
      ),
    ),

  /** Mint a 30-second, single-use ticket for a container-local Chromium preview. */
  createContainerPreviewTicket: (
    a: AuthSession,
    url: string,
    viewport: ContainerPreviewViewport,
    options?: { direct?: boolean },
  ): Promise<ContainerPreviewTicketResponse> =>
    jsonOrThrow<ContainerPreviewTicketResponse>(
      callWithRefresh(a, (token) =>
        fetch("/api/container-preview/ticket", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ url, viewport, ...options }),
        }),
      ),
    ),

  heartbeatContainerPreview: (a: AuthSession, sessionId: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetch("/api/container-preview/heartbeat", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ sessionId }),
        }),
      ),
    ).then(() => undefined),

  revokeContainerPreview: (a: AuthSession, sessionId: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetch("/api/container-preview/revoke", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token, true),
          body: JSON.stringify({ sessionId }),
          keepalive: true,
        }),
      ),
    ).then(() => undefined),

  // ── ChatGPT 直连代理（仅管理员 + system_settings 白名单用户） ───────────────

  /** GET /api/chatgpt-proxy/access：授权状态 + 连接信息。未授权 → `{ enabled: false }`。 */
  getChatGptProxyAccess: (a: AuthSession): Promise<ChatGptProxyAccess> =>
    jsonOrThrow<ChatGptProxyAccess>(
      callWithRefresh(a, (token) =>
        fetch("/api/chatgpt-proxy/access", {
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  /** POST /api/chatgpt-proxy/credential：生成 / 轮换代理凭据，明文密码只返回这一次。 */
  createChatGptProxyCredential: (a: AuthSession): Promise<ChatGptProxyCredential> =>
    jsonOrThrow<ChatGptProxyCredential>(
      callWithRefresh(a, (token) =>
        fetch("/api/chatgpt-proxy/credential", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ),

  /** DELETE /api/chatgpt-proxy/credential：吊销当前凭据。 */
  revokeChatGptProxyCredential: (a: AuthSession): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (token) =>
        fetch("/api/chatgpt-proxy/credential", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(token),
        }),
      ),
    ).then(() => undefined),

  // ── 逐条响应评价反馈（commercial REST，需登录 401，限流 60/60s） ──────────────
  //
  // 提交/更新走同一 POST（(user,messageId) upsert，无 DELETE）；回读只用于标「已评」高亮。
  // 维护期端点返 503 —— 调用方(App)静默吞错，不弹错、不打断对话。

  /**
   * 提交/更新一条响应评价（POST /api/response-rating，Bearer）。语义 upsert：重发覆盖
   * rating/tags/comment/model/traceId/sessionId。成功 200 `{ok:true}`；失败经 ApiError 抛
   * （VALIDATION / UNAUTHORIZED / RATE_LIMITED），调用方静默处理。
   */
  submitResponseRating: (a: AuthSession, input: ResponseRatingInput): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch("/api/response-rating", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then(() => undefined),

  /**
   * 回读某会话已评状态（GET /api/response-rating?sessionId=，Bearer）。返回
   * `{ [messageId]: {rating, tags} }`（无则 `{}`，不含 comment）。仅用于重开会话时标
   * 「已评」高亮、避免重复采集。失败/503 由调用方兜底为空。
   */
  submitResponseRatingNudge: (
    a: AuthSession,
    input: ResponseRatingNudgeInput,
  ): Promise<{ state: RatingNudgeState; newlyExposed: boolean }> =>
    jsonOrThrow<{ ok: true; state: RatingNudgeState; newlyExposed: boolean }>(
      callWithRefresh(a, (t) =>
        fetch("/api/response-rating", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((body) => ({ state: body.state, newlyExposed: body.newlyExposed })),

  getSessionRatings: (a: AuthSession, sessionId: string): Promise<SessionRatingSnapshot> =>
    jsonOrThrow<{ ratings?: SessionRatingsMap; nudges?: Record<string, RatingNudgeState> }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/response-rating?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({ ratings: b.ratings || {}, nudges: b.nudges || {} })),

  /**
   * 视频生成能力（GET /api/media-generation/capabilities，Bearer）。仅用于账号菜单
   * 「视频任务」入口门控：`available:false` 时不渲染入口，未知/失败保持入口可见
   * （由任务中心内部兜底提示），避免网络抖动误藏功能。
   */
  getMediaCapabilities: (a: AuthSession): Promise<{ available?: boolean }> =>
    jsonOrThrow<{ available?: boolean }>(
      callWithRefresh(a, (t) =>
        fetch("/api/media-generation/capabilities", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 确认桌面 enrollment（POST /api/desktop/enroll/confirm，Bearer）。
   * 成功 200 `{enrollment_id, code, deep_link}`；sim 平台 `deep_link` 为 null。
   * `code` 只用于服务端拼深链，本 helper **不**把 code 交给调用方，以免误渲染。
   * 失败经 ApiError 抛（401 / 403 DESKTOP_NOT_ENTITLED / 409 DEVICE_LIMIT|ENROLL_INVALID / 404 / 429）。
   */
  confirmDesktopEnroll: (
    a: AuthSession,
    enrollmentId: string,
  ): Promise<{ enrollmentId: string; deepLink: string | null }> =>
    jsonOrThrow<{ enrollment_id: string; code?: string; deep_link?: string | null }>(
      callWithRefresh(a, (t) =>
        fetch("/api/desktop/enroll/confirm", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ enrollment_id: enrollmentId }),
        }),
      ),
    ).then((b) => ({
      enrollmentId: b.enrollment_id,
      deepLink: typeof b.deep_link === "string" && b.deep_link ? b.deep_link : null,
    })),

  // ── 对话传输（P4 已接入：WS user-chat-bridge） ────────────────────────
  //
  // v5 对话传输走 WebSocket（/ws/user-chat-bridge，bearer 子协议
  // `new WebSocket(url, ['bearer', accessJWT])`，inbound.message 帧），不再是
  // v4-trial 的 SSE。实现不在 api.ts（REST 专属），而在渲染树之外的单例 service
  // `lib/chat/socket.ts`（ChatSocket：safeWsSend 2MB 背压 + per-sessionKey frameSeq
  // 去重 + 三层断点续传 + 离线队列三段式 drain），由 React 绑定 `hooks/useChatSocket.ts`
  // 消费。会话历史的 REST 全量 sync（断点续传最终权威源）走上面的 getSession。
};
