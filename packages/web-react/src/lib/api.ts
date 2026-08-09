import type {
  AgentCancelResult,
  AgentOpenResult,
  AgentStatus,
  ApiKeySummary,
  AuthSession,
  CreatedApiKey,
  CronCreateInput,
  CronJob,
  GithubBranch,
  GithubLink,
  GithubRepo,
  InboxMessage,
  RepoSelection,
  SkillDetail,
  ResearchLibraryDoc,
  ResearchLibraryUploadResult,
  SkillSummary,
  MarketplaceDetail,
  MarketplaceInstalled,
  MarketplaceAgentPublishInput,
  MarketplaceConnectorPublishInput,
  MarketplaceMyAgent,
  MarketplaceInstallResult,
  SkillDraftDetail,
  SkillDraftSummary,
  SkillEvalGenJob,
  SkillEvalRun,
  SkillEvalsFile,
  SkillRunUsage,
  SkillTrainRun,
  SkillTrainStartResult,
  MarketplaceAiReview,
  MarketplaceMyPublish,
  MarketplacePending,
  MarketplacePublishInput,
  MarketplacePublishResult,
  MarketplaceReviewBatchResult,
  MarketplaceSearchResult,
  HupiCreateResult,
  LoginResult,
  MediaSignResult,
  MemoryDocResponse,
  MemoryConflict,
  PutMemoryResult,
  MemoryIndexResponse,
  AutoDreamReportResponse,
  AutoDreamOptimizerState,
  MemoryFileContent,
  PutMemoryFileResult,
  PaymentOrder,
  PaymentPlan,
  Preferences,
  PublicConfig,
  PublicModel,
  PutSessionInput,
  PutSessionResult,
  RefreshOutcome,
  RefreshResult,
  RegisterResult,
  SessionArchivePage,
  SessionDetail,
  DurableLiveFramePage,
  SessionMeta,
  SessionTimelinePage,
  TapeRecordPayload,
  SubscriptionPlanWire,
  MySubscription,
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
import type {
  ConnectorBindResult,
  ConnectorConfirmationDetail,
  ConnectorDecisionResult,
  ConnectorOAuthStartResult,
  ConnectorsResponse,
  DeclarativeBindResult,
  DeclarativeCatalogResponse,
  DeclarativeConnectionsResponse,
  DeclarativeManagementResponse,
  DeclarativeOauthStartResult,
  KnowledgePlanetSetupView,
  PluginManagementResponse,
  KnowledgePlanetAutomationControl,
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from './connectors'
import { normalizeOrgPlan, normalizeOrgSubscription } from './orgBilling'
import { reportClientFriction } from './clientFriction'

export type QqBindingStatus = {
  available: boolean
  bound: boolean
  entry_url?: string
  maskedOpenid?: string
  boundAt?: number
  lastInteractionAt?: number
}

export type QqBindingStart = {
  available: true
  entry_url: string
  bind_code: string
  expires_at: number
}

/**
 * v5 商业版前端网络层。
 *
 * 鉴权模型（与后端 packages/commercial/src/http/{handlers,cookies}.ts 对齐）：
 * - 内存态 access JWT 是唯一在用凭据，绝不落地（XSS 拿不到）。
 * - refresh token 走 HttpOnly cookie（__Host-* / 同源），登录/刷新/登出全部
 *   `credentials:'include'`，由浏览器自动携带 + 后端轮换，前端永不接触其明文。
 * - 命中 401 时透明刷新一次并重放（singleflight 防刷新风暴）。
 *
 * v4-trial 时代的 SSE `/api/v4/chat/*` 对话传输已移除：v5 对话走 WS
 * user-chat-bridge（bearer 子协议），在 P4 接入；本文件保留清晰的 chat stub。
 */

// ─── 静默刷新 + epoch singleflight ───────────────────────────────────
// refresh cookie 每次使用都会轮换。这里恢复旧前端已经验证过的三道闸：
//   1) 同 AuthSession + 同 epoch 合并成一次网络调用；
//   2) REFRESH_RACE 只在 server grace 内有界重试；
//   3) 所有成功/失效都经 epoch fence，旧身份晚到响应只能 stale no-op。
const REFRESH_TIMEOUT_MS = 30_000;
const AUTH_COOKIE_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_RACE_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 1_750] as const;
const REFRESH_TRANSIENT_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

type RawRefreshOutcome =
  | { kind: "success"; result: RefreshResult; raceObserved?: boolean }
  | { kind: "invalid"; raceObserved?: boolean }
  | { kind: "race" }
  | { kind: "transient"; retryAfterMs: number; raceObserved?: boolean };

type RefreshSurface = "auth" | "admin_auth" | "ws_auth";
type RefreshFrictionState = {
  id: string;
  code: "REFRESH_RACE" | "REFRESH_TRANSIENT";
  attempts: number;
  surface: RefreshSurface;
};

type RefreshState = {
  epoch: number;
  flight: Promise<RefreshOutcome> | null;
  controller: AbortController | null;
  transientFailures: number;
  nextAllowedAt: number;
  friction: RefreshFrictionState | null;
};

const refreshStates = new WeakMap<AuthSession, RefreshState>();
const authResponseFences = new WeakMap<Response, { session: AuthSession; epoch: number }>();

// 本 tab 内所有会写 oc_rt 的调用按发起顺序落地。跨 tab 的 refresh 冲突由后端
// REFRESH_RACE 协议处理；主动 logout 另有 token-free 广播让其它 tab 立即撤退。
let authCookieMutationTail: Promise<void> = Promise.resolve();

function withAuthCookieMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = authCookieMutationTail.then(run, run);
  authCookieMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

function refreshStateFor(a: AuthSession, epoch: number): RefreshState {
  const current = refreshStates.get(a);
  if (current?.epoch === epoch) return current;
  const next: RefreshState = {
    epoch,
    flight: null,
    controller: null,
    transientFailures: 0,
    nextAllowedAt: 0,
    friction: null,
  };
  refreshStates.set(a, next);
  return next;
}

async function refreshAttempt(signal: AbortSignal): Promise<RawRefreshOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    return { kind: "transient", retryAfterMs: 0 };
  }

  if (res.ok) {
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (
        typeof body?.access_token !== "string" ||
        !body.access_token ||
        typeof body.access_exp !== "number" ||
        !Number.isFinite(body.access_exp) ||
        typeof body.remember !== "boolean"
      ) {
        return { kind: "transient", retryAfterMs: 0 };
      }
      return {
        kind: "success",
        result: {
          accessToken: body.access_token,
          accessExp: body.access_exp,
          remember: body.remember,
        },
      };
    } catch {
      return { kind: "transient", retryAfterMs: 0 };
    }
  }

  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    if (typeof body?.error?.code === "string") code = body.error.code;
  } catch {
    /* 非标准错误体属于瞬时/未知故障，绝不能据此清登录态。 */
  }
  if (code === "REFRESH_RACE") return { kind: "race" };
  if (code === "INVALID_REFRESH" || code === "VALIDATION") return { kind: "invalid" };
  return {
    kind: "transient",
    retryAfterMs: Math.max(0, (parseRetryAfter(res) ?? 0) * 1_000),
  };
}

async function refreshWithRaceRetry(signal: AbortSignal): Promise<RawRefreshOutcome> {
  let outcome = await refreshAttempt(signal);
  let raceObserved = false;
  for (const delayMs of REFRESH_RACE_RETRY_DELAYS_MS) {
    if (outcome.kind !== "race") {
      return raceObserved ? { ...outcome, raceObserved: true } : outcome;
    }
    raceObserved = true;
    try {
      await sleep(delayMs, signal);
    } catch {
      return { kind: "transient", retryAfterMs: 0 };
    }
    outcome = await refreshAttempt(signal);
  }
  return outcome.kind === "race"
    ? { kind: "transient", retryAfterMs: 0, raceObserved: true }
    : raceObserved ? { ...outcome, raceObserved: true } : outcome;
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
  return state.flight?.then(
    () => undefined,
    () => undefined,
  ) ?? Promise.resolve();
}

/** REST、boot、admin、WS 共用的唯一静默续期入口。 */
export function refreshAuth(
  a: AuthSession,
  expectedEpoch = a.snapshot().epoch,
  surface: RefreshSurface = "auth",
): Promise<RefreshOutcome> {
  const snapshot = a.snapshot();
  if (snapshot.epoch !== expectedEpoch) {
    return Promise.resolve({ kind: "stale", epoch: expectedEpoch });
  }

  const state = refreshStateFor(a, expectedEpoch);
  if (state.flight) return state.flight;
  const now = Date.now();
  if (state.nextAllowedAt > now) {
    // 限频早返:没发真实网络请求,throttled 标记让消费方不把它计入重试次数
    // (消费层 setTimeout 亚毫秒早醒会撞进本分支,若当失败计数会"只发一次网络就放弃恢复")。
    return Promise.resolve({
      kind: "transient",
      epoch: expectedEpoch,
      retryAfterMs: state.nextAllowedAt - now,
      throttled: true,
    });
  }

  const controller = new AbortController();
  state.controller = controller;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const flight = withAuthCookieMutation(async (): Promise<RefreshOutcome> => {
    // 排队不计入 refresh 自身网络期限；login/logout 队首也各自有同样的 30s 上限。
    timeout = setTimeout(
      () => controller.abort(new DOMException("refresh timeout", "TimeoutError")),
      REFRESH_TIMEOUT_MS,
    );
    let raw: RawRefreshOutcome;
    try {
      raw = await refreshWithRaceRetry(controller.signal);
    } catch {
      raw = { kind: "transient", retryAfterMs: 0 };
    }

    if (a.snapshot().epoch !== expectedEpoch) return { kind: "stale", epoch: expectedEpoch };
    if (raw.kind === "success") {
      state.transientFailures = 0;
      state.nextAllowedAt = 0;
      const prior = state.friction;
      if (prior || raw.raceObserved) {
        reportClientFriction({
          eventId: prior?.id,
          surface: prior?.surface ?? surface,
          stage: "refresh",
          code: prior?.code ?? "REFRESH_RACE",
          outcome: "recovered",
          attempts: Math.min(32, (prior?.attempts ?? 0) + 1),
        }, raw.result.accessToken);
      }
      state.friction = null;
      return a.commitToken(expectedEpoch, raw.result.accessToken)
        ? { kind: "success", epoch: expectedEpoch, result: raw.result }
        : { kind: "stale", epoch: expectedEpoch };
    }
    if (raw.kind === "invalid") {
      state.transientFailures = 0;
      state.nextAllowedAt = 0;
      state.friction = null;
      return { kind: "invalid", epoch: expectedEpoch };
    }

    state.transientFailures = Math.min(state.transientFailures + 1, REFRESH_TRANSIENT_BACKOFF_MS.length);
    const backoff = REFRESH_TRANSIENT_BACKOFF_MS[state.transientFailures - 1] ?? 10_000;
    const retryAfterMs = Math.max(raw.kind === "transient" ? raw.retryAfterMs : 0, backoff);
    state.nextAllowedAt = Date.now() + retryAfterMs;
    const prior = state.friction;
    const code = prior?.code ??
      (raw.kind === "race" || raw.raceObserved ? "REFRESH_RACE" : "REFRESH_TRANSIENT");
    const attempts = Math.min(32, (prior?.attempts ?? 0) + 1);
    const id = reportClientFriction({
      eventId: prior?.id,
      surface: prior?.surface ?? surface,
      stage: "refresh",
      code,
      outcome: "failed",
      attempts,
    }, a.snapshot().token);
    state.friction = { id, code, attempts, surface: prior?.surface ?? surface };
    return { kind: "transient", epoch: expectedEpoch, retryAfterMs };
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (state.flight === flight) state.flight = null;
    if (state.controller === controller) state.controller = null;
  });
  state.flight = flight;
  return flight;
}

// export：admin 数据层（src/admin/lib/adminApi.ts）复用同一套透明刷新重放，
// 不新建第二套鉴权/刷新机制。仅加导出，实现不动。
export async function callWithRefresh(
  a: AuthSession,
  make: (token: string) => Promise<Response>,
): Promise<Response> {
  const used = a.snapshot();
  const res = await make(used.token);
  // 普通 2xx/4xx 也可能在换号后才返回；旧身份响应不得交给调用方解析、写入当前 UI。
  if (a.snapshot().epoch !== used.epoch) throw new AuthEpochStaleError();
  if (res.status !== 401) return fenceAuthResponse(res, a, used.epoch);
  // 旧请求绝不能借 token-changed shortcut 跑到新账号名下。
  const current = a.snapshot();
  if (current.epoch !== used.epoch) throw new AuthEpochStaleError();
  if (current.token && current.token !== used.token) {
    const replay = await make(current.token);
    if (a.snapshot().epoch !== used.epoch) throw new AuthEpochStaleError();
    return fenceAuthResponse(replay, a, used.epoch);
  }

  const refreshed = await refreshAuth(a, used.epoch);
  if (refreshed.kind === "invalid") {
    a.expire(used.epoch); // session 内部幂等：并发消费者只通知 UI 一次。
    return fenceAuthResponse(res, a, used.epoch);
  }
  if (refreshed.kind === "stale") throw new AuthEpochStaleError();
  if (refreshed.kind !== "success") return fenceAuthResponse(res, a, used.epoch);

  const beforeReplay = a.snapshot();
  if (beforeReplay.epoch !== used.epoch) throw new AuthEpochStaleError();
  if (beforeReplay.token !== refreshed.result.accessToken) return fenceAuthResponse(res, a, used.epoch);
  // 最多重放一次；重放仍 401 不递归刷新。
  const replay = await make(beforeReplay.token);
  if (a.snapshot().epoch !== used.epoch) throw new AuthEpochStaleError();
  return fenceAuthResponse(replay, a, used.epoch);
}

/** 身份在请求期间切换；旧响应必须静默丢弃，绝不能进入新身份的数据层。 */
export class AuthEpochStaleError extends Error {
  constructor() {
    super("auth identity changed while request was in flight");
    this.name = "AuthEpochStaleError";
  }
}

function fenceAuthResponse(res: Response, session: AuthSession, epoch: number): Response {
  authResponseFences.set(res, { session, epoch });
  return res;
}

/** body 读取也可能跨越换号边界；解析前后都调用，避免大响应迟到污染新身份。 */
export function assertAuthResponseCurrent(res: Response): void {
  const fence = authResponseFences.get(res);
  if (fence && fence.session.snapshot().epoch !== fence.epoch) throw new AuthEpochStaleError();
}

/** 可中断 sleep（用于冷启轮询退避）。abort 时 reject AbortError 并清理定时器。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 拼鉴权头：身份完全由 access JWT(sub) 决定，只带 Bearer。 */
// export：admin 数据层复用（见 callWithRefresh 注释）。仅加导出。
export function bearerHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (json) h["content-type"] = "application/json";
  return h;
}

/** 把 x-request-id 拼到错误信息末尾，方便用户反馈、运维追溯。 */
function withReqId(msg: string, res: Response): string {
  const id = res.headers.get("x-request-id");
  return id ? `${msg}（追踪号 ${id}）` : msg;
}

/** 后端错误 issue（commercial HttpError.issues：path+message 键值对）。 */
export type ApiIssue = { path: string; message: string };

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
 * 统一的网络错误类型 —— 唯一权威，承载 status / code / issues / requestId，
 * 让上层按 **状态码 + 机器码** 分支（402 余额不足 / 409 已订阅 / 409 conflict /
 * 413 too large / 404 not found …），而不是去 parse 中文 message 字符串。
 *
 * 兼容两套后端错误信封：
 *   - commercial REST：`{ error: { code, message, issues? } }`
 *   - gateway（会话历史等）：`{ error: "<string>" }`
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly issues?: ApiIssue[];
  /** 503 / 4503 冷启场景的建议重试秒数（Retry-After 头或 body）。 */
  readonly retryAfterSec?: number;
  /** 原始解析后的 body（调试 / 提取 commercial issues 的额外字段）。 */
  readonly body?: unknown;
  constructor(init: {
    status: number;
    message: string;
    code?: string;
    requestId?: string;
    issues?: ApiIssue[];
    retryAfterSec?: number;
    body?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.issues = init.issues;
    this.retryAfterSec = init.retryAfterSec;
    this.body = init.body;
  }
  /** 从 issues 里取某个字段值（如 402 的 shortfall、409 的 subscription_id）。 */
  issue(path: string): string | undefined {
    return this.issues?.find((i) => i.path === path)?.message;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

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
function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(err.message)
  );
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
    const base = err.message.replace(REQ_ID_SUFFIX_RE, "").trim();
    if (base && hasCjk(base) && !GENERIC_HTTP_MESSAGE_RE.test(base)) return base;
    return err.requestId ? `${fallback}（追踪号 ${err.requestId}）` : fallback;
  }

  if (err instanceof Error && hasCjk(err.message)) return err.message;
  return fallback;
}

/** 读 !res.ok 的响应体，组装并抛出 ApiError（绝不返回）。 */
// export：admin 数据层（adminText CSV 导出等非 JSON 路径）复用统一错误信封解包。仅加导出。
export async function throwApi(res: Response): Promise<never> {
  assertAuthResponseCurrent(res);
  let message = `请求失败 (${res.status})`;
  let code: string | undefined;
  let issues: ApiIssue[] | undefined;
  let body: unknown;
  try {
    body = await res.json();
    const b = body as Record<string, unknown> | null;
    const err = b?.error;
    if (err && typeof err === "object") {
      // commercial：{ error: { code, message, issues } }
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.code === "string") code = e.code;
      if (Array.isArray(e.issues)) issues = e.issues as ApiIssue[];
    } else if (typeof err === "string") {
      // gateway：{ error: "<string>" }
      message = err;
    } else if (typeof b?.message === "string") {
      message = b.message as string;
    }
  } catch {
    /* 非 JSON 响应：保留默认 message */
  }
  assertAuthResponseCurrent(res);
  throw new ApiError({
    status: res.status,
    message: withReqId(message, res),
    code,
    issues,
    requestId: res.headers.get("x-request-id") ?? undefined,
    retryAfterSec: parseRetryAfter(res),
    body,
  });
}

// export：admin 数据层复用统一 JSON 解包 + 错误抛出。仅加导出。
export async function jsonOrThrow<T>(p: Promise<Response> | Response): Promise<T> {
  const res = await p;
  assertAuthResponseCurrent(res);
  if (!res.ok) await throwApi(res);
  const body = (await res.json()) as T;
  assertAuthResponseCurrent(res);
  return body;
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

/** 订阅/升档下单响应 → HupiCreateResult（与 hupi/create 同形，复用 QR + 订单轮询）。 */
function parseSubscriptionOrder(p: Promise<Response>): Promise<HupiCreateResult> {
  return jsonOrThrow<{
    ok: boolean;
    data: {
      order_no: string; qrcode_url: string; mobile_url: string | null;
      amount_cents: string; credits: string; expires_at: string;
    };
  }>(p).then((b) => ({
    orderNo: b.data.order_no,
    qrcodeUrl: b.data.qrcode_url,
    mobileUrl: b.data.mobile_url,
    amountCents: b.data.amount_cents,
    credits: b.data.credits,
    expiresAt: b.data.expires_at,
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
  const rangeMatch = /^bytes 0-0\/([1-9][0-9]*)$/.exec(
    probe.headers.get("content-range") ?? "",
  );
  const totalBytes = rangeMatch ? Number(rangeMatch[1]) : Number.NaN;
  const contentSha256 = probe.headers.get("x-openclaude-content-sha256") ?? "";
  const recordId = probe.headers.get("x-openclaude-record-id") ?? "";
  const role = probe.headers.get("x-openclaude-record-role") ?? "";
  const probeEncoding = probe.headers.get("content-encoding")?.toLowerCase();
  if (
    probe.status !== 206 || (probeEncoding !== undefined && probeEncoding !== "identity") ||
    !Number.isSafeInteger(totalBytes) || totalBytes < 1 ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    recordId.length === 0 || role.length === 0
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
      res.headers.get("x-openclaude-record-id") !== recordId ||
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
  refresh(a: AuthSession, expectedEpoch?: number, surface?: RefreshSurface): Promise<RefreshOutcome> {
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

  /** 邮箱验证（POST /api/auth/verify-email）：{email, code} → 验证结果。 */
  verifyEmail(email: string, code: string): Promise<VerifyEmailResult> {
    return jsonOrThrow<{ user_id: string; newly_verified: boolean }>(
      fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      }),
    ).then((b) => ({ userId: b.user_id, newlyVerified: b.newly_verified }));
  },

  /** 重发验证邮件（POST /api/auth/resend-verification）。后端防枚举，恒 200 + accepted。 */
  resendVerification(email: string): Promise<{ accepted: boolean }> {
    return jsonOrThrow<{ accepted: boolean }>(
      fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
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
  submitFeedback: (
    a: AuthSession,
    input: FeedbackSubmitInput,
  ): Promise<FeedbackSubmitResult> =>
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
  getMyUsageReport: (a: AuthSession, window: UsageReportWindow): Promise<UsageReport> =>
    jsonOrThrow<UsageReport>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/usage/report?window=${encodeURIComponent(window)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── API Keys（注意：当前后端 admin-only rollout，普通用户调用返 403） ─────────

  /** 列出我的 API key（GET /api/me/api-keys，Bearer）。不含明文。 */
  listApiKeys: (a: AuthSession): Promise<ApiKeySummary[]> =>
    jsonOrThrow<{
      keys: Array<{
        id: string;
        label: string;
        key_prefix: string;
        created_at: string;
        last_used_at: string | null;
      }>;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/api-keys", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) =>
      b.keys.map((k) => ({
        id: k.id,
        label: k.label,
        keyPrefix: k.key_prefix,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
      })),
    ),

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
    }>(fetch("/api/public/config", { headers: { Accept: "application/json" } })).then((b) => ({
      turnstileSiteKey: b.turnstile_site_key,
      turnstileBypass: b.turnstile_bypass,
      requireEmailVerified: b.require_email_verified,
      featureRemoteSsh: b.feature_remote_ssh,
      featureImage2: b.feature_image2,
      allowRegistration: b.allow_registration,
    })),

  /**
   * 公开模型列表（GET /api/public/models）。可选带 Bearer（登录用户走
   * visibility/grants 视图）；每项含后端投影的 supported_efforts 能力。
   */
  async getPublicModels(a?: AuthSession): Promise<PublicModel[]> {
    const run = (t?: string) =>
      fetch("/api/public/models", {
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{ models: PublicModel[] }>(res);
    return b.models || [];
  },

  // ── 对话前置（Agent 订阅 / 容器） ────────────────────────────────────

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

  /** 列出我的会话（GET /api/sessions/list，Bearer）。无 messages 的元数据列表。 */
  listSessions: (a: AuthSession): Promise<SessionMeta[]> =>
    jsonOrThrow<{ sessions: SessionMeta[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/sessions/list", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.sessions || []),

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
  ): Promise<SessionDetail> => {
    const params = new URLSearchParams();
    if (sinceSeq > 0) {
      params.set("since", String(sinceSeq));
      if (Number.isSafeInteger(sinceHistoryRevision) && (sinceHistoryRevision as number) >= 0) {
        params.set("since_history_revision", String(sinceHistoryRevision));
      }
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    const request = (requestSuffix: string) => jsonOrThrow<SessionDetail>(
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
      if (
        !Number.isSafeInteger(detail.historyRevision)
        || (detail.historyRevision as number) < 0
      ) {
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
   * delivery.  Callers keep paging until hasMore=false; there is no total cap. */
  getSessionLiveFrames: (
    a: AuthSession,
    id: string,
    after = "0",
    limit = 200,
  ): Promise<DurableLiveFramePage> => {
    const params = new URLSearchParams({ after, limit: String(limit) });
    return jsonOrThrow<DurableLiveFramePage>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/live-frames?${params.toString()}`, {
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
   * 会话重命名（PATCH /api/sessions/:id，Bearer，元数据专用）。不走 putSession 的
   * 整 blob 替换语义：rename 不携带 messages，骑 PUT 要么 409 要么丢消息。
   */
  patchSessionTitle: (a: AuthSession, id: string, title: string): Promise<{ ok: true; updatedAt: number }> =>
    jsonOrThrow<{ ok: true; updatedAt: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ title }),
        }),
      ),
    ),

  /**
   * 会话级模型选择持久化（PATCH /api/sessions/:id，Bearer，元数据专用，与 rename 同款）。
   * best-effort 失败契约同 rename：本地已改,服务端失败则下次 listSessions server-wins
   * 盖回,用户重选即重试。会话行尚未建（新会话未发首条消息）时 404,同样吞掉——建行
   * PUT(ensureServerSession)会随体携带 modelId 收敛。
   */
  patchSessionModel: (a: AuthSession, id: string, modelId: string): Promise<{ ok: true; updatedAt: number }> =>
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

  // ── 文件上传（gateway /api/uploads，Bearer；写入用户容器工作区，返回内容寻址 URL） ──

  /**
   * 上传单个文件（POST /api/uploads，Bearer）。原始二进制 body + x-filename 头。
   * 返回 `{ url, digest, size, mimeType }`——url 形如 `/api/media/<digest>.<ext>`，
   * 可直接作为 MediaRef.url 放进对话 inbound.message.content.media。
   * File/Blob body 可重发，故 401 透明刷新重放安全。
   */
  uploadFile: (
    a: AuthSession,
    file: File,
  ): Promise<{ url: string; digest?: string; size?: number; mimeType?: string }> =>
    jsonOrThrow(
      callWithRefresh(a, (t) =>
        fetch("/api/uploads", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${t}`,
            "content-type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name || "file"),
          },
          body: file,
        }),
      ),
    ),

  // ── 媒体签名（commercial REST） ──────────────────────────────────────────

  /**
   * 批量签名容器内媒体路径（POST /api/media-sign，Bearer + cookie dual-verify）。
   * 返回 path→opaque签名URL 映射（被 ACL 拒的路径静默缺失，需自行判断）。
   * 签出的 URL 可直接用于 `<img src>` / `<a href>`（无需鉴权头，opaque token 自证）。
   */
  mediaSign: (a: AuthSession, paths: string[]): Promise<MediaSignResult> =>
    jsonOrThrow<MediaSignResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/media-sign", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ paths }),
        }),
      ),
    ),

  /**
   * 按签名 URL 取媒体二进制（GET /api/media-signed，公开端点，无需鉴权头）。
   * 多数场景下 mediaSign 返回的 URL 直接挂到元素 src 即可；此 helper 仅用于需要
   * 程序化拿到 Blob 的场景（如下载 / 转存）。
   * 冷启容器未就绪 → 503 + Retry-After：自动按 Retry-After 退避重试（上限 maxRetries）。
   */
  async fetchSignedMedia(
    signedUrl: string,
    opts?: { maxRetries?: number; signal?: AbortSignal },
  ): Promise<Blob> {
    const maxRetries = opts?.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const res = await fetch(signedUrl, { headers: { Accept: "*/*" }, signal: opts?.signal });
      if (res.ok) return res.blob();
      // 容器冷启：503 + Retry-After（见 commercial handleMediaSigned ensureContainerReady）。
      if (res.status === 503 && attempt < maxRetries) {
        const retryAfterSec = parseRetryAfter(res) ?? 2;
        await sleep(retryAfterSec * 1000, opts?.signal);
        continue;
      }
      await throwApi(res);
    }
  },

  // ── 充值 / 计费（虎皮椒扫码，commercial REST） ────────────────────────────

  /**
   * 充值套餐列表（GET /api/payment/plans）。公开端点，可选带 Bearer（登录用户首充档
   * 按是否用过过滤）。金额/积分均字符串大数。
   */
  async listPlans(a?: AuthSession): Promise<PaymentPlan[]> {
    const run = (t?: string) =>
      fetch("/api/payment/plans", {
        credentials: "include",
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{ code: string; label: string; amount_cents: string; credits: string }>;
      };
    }>(res);
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      label: p.label,
      amountCents: p.amount_cents,
      credits: p.credits,
    }));
  },

  /**
   * 创建虎皮椒充值订单（POST /api/payment/hupi/create，Bearer）。
   * 返回扫码 URL + 订单号（随后用 getOrder 轮询到账）。
   * 409 FIRST_TOPUP_USED = 老用户企图复用首充档（经 ApiError 抛）。
   */
  createHupiOrder: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        qrcode_url: string;
        mobile_url: string | null;
        amount_cents: string;
        credits: string;
        expires_at: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/payment/hupi/create", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      qrcodeUrl: b.data.qrcode_url,
      mobileUrl: b.data.mobile_url,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
    })),

  /**
   * 查询订单（GET /api/payment/orders/:orderNo，Bearer）。轮询用：status 转 'paid'
   * 即到账。404 ORDER_NOT_FOUND（非本人 / 不存在）经 ApiError 抛。
   */
  getOrder: (a: AuthSession, orderNo: string): Promise<PaymentOrder> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        status: string;
        amount_cents: string;
        credits: string;
        expires_at: string;
        paid_at: string | null;
        created_at: string;
        provider: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/payment/orders/${encodeURIComponent(orderNo)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      status: b.data.status,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
      paidAt: b.data.paid_at,
      createdAt: b.data.created_at,
      provider: b.data.provider,
    })),

  // ── 月度订阅（0096，commercial REST） ──────────────────────────────────────

  /** 套餐档列表（GET /api/subscription/plans，公开）。金额/积分字符串大数。 */
  async listSubscriptionPlans(): Promise<SubscriptionPlanWire[]> {
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{
          code: string; name: string; price_cents: string;
          monthly_credits: string; period_days: number; tier: number;
        }>;
      };
    }>(fetch("/api/subscription/plans", { headers: { Accept: "application/json" } }));
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      name: p.name,
      priceCents: p.price_cents,
      monthlyCredits: p.monthly_credits,
      periodDays: p.period_days,
      tier: p.tier,
    }));
  },

  /**
   * 企业套餐档(GET /api/subscription/plans?scope=org,公开;登录不必需)——落地页锚点价用。
   * 定价本就是公开信息,故走公开端点。响应形容错:兼容 `{ ok, data: { plans } }` 包裹与
   * 裸 `{ plans }`;字段名经 normalizeOrgPlan 归一(含 min_seats)。失败/空由调用方静态兜底。
   */
  async listOrgPlansPublic(): Promise<OrgPlan[]> {
    const b = await jsonOrThrow<{
      ok?: boolean;
      plans?: unknown[];
      data?: { plans?: unknown[] };
    }>(
      fetch("/api/subscription/plans?scope=org", { headers: { Accept: "application/json" } }),
    );
    const raw = Array.isArray(b.data?.plans)
      ? b.data.plans
      : Array.isArray(b.plans)
        ? b.plans
        : [];
    return raw.map(normalizeOrgPlan);
  },

  /** 当前订阅 + 双钱包余额明细（GET /api/subscription/me，Bearer）。 */
  getMySubscription: (a: AuthSession): Promise<MySubscription> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        subscription: {
          plan_code: string; plan_name: string; status: string;
          period_start: string; period_end: string; period_credits: string;
          monthly_credits: string; price_cents: string; tier: number; paid: boolean;
        };
        balance: { wallet: string; period: string; total: string };
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      planCode: b.data.subscription.plan_code,
      planName: b.data.subscription.plan_name,
      status: b.data.subscription.status,
      periodStart: b.data.subscription.period_start,
      periodEnd: b.data.subscription.period_end,
      periodCredits: b.data.subscription.period_credits,
      monthlyCredits: b.data.subscription.monthly_credits,
      priceCents: b.data.subscription.price_cents,
      tier: b.data.subscription.tier,
      paid: b.data.subscription.paid,
      balance: {
        wallet: b.data.balance.wallet,
        period: b.data.balance.period,
        total: b.data.balance.total,
      },
    })),

  /** 购买/续费某档（POST /api/subscription/subscribe，Bearer）→ 虎皮椒扫码（同 hupi/create 形）。 */
  subscribe: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/subscribe", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 升档（补差价，POST /api/subscription/upgrade，Bearer）→ 扫码。 */
  upgradeSubscription: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/upgrade", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 购买积分加量包（进期内桶，POST /api/subscription/pack，Bearer）→ 扫码。v5 专属，与 v3 隔离。 */
  buyPack: (a: AuthSession): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/pack", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  // ── 容器内管理（记忆 / 定时任务 / 技能；经 commercial router 自动代理进用户容器） ──
  //
  // 这些 host 级路径对商业用户本会 403 BLOCKED，但命中 bridgeApiAllowlist 的
  // proxyFromCommercial 条目后由 router 注入 bridge nonce 转发到用户容器内 gateway
  // (127.0.0.1:18789，按 userId 隔离)。前端只需普通 Bearer fetch，无需特殊 header。
  // 容器未就绪时 router 会先 ensureContainerReady（可能冷启 ~40s），失败返 503/4503。

  /** 取用户画像文档（GET /api/agents/:id/memory/user）。
   *  用户画像 = 共享的 user.md,单文档纯 markdown;limit = 字符预算(后端权威,前端展示)；
   *  version = 乐观锁令牌,PUT 回传以检测并发写。核心记忆走 getMemoryIndex/文件子路由。 */
  getMemory: (a: AuthSession, agentId: string, target: "user") =>
    jsonOrThrow<MemoryDocResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 写用户画像文档（PUT /api/agents/:id/memory/user）。核心记忆 PUT 已 410(改文件子路由)。
   * 带乐观锁 version：后端在 version 落后时返 409 `{ conflict }`（智能体在用户编辑期间改了画像）。
   * 409 不当作错误抛,解析 conflict 交回上层刷新基线；其余非 2xx 仍走统一 ApiError。
   */
  putMemory: async (
    a: AuthSession,
    agentId: string,
    target: "user",
    text: string,
    version?: string,
  ): Promise<PutMemoryResult> => {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
        method: "PUT",
        credentials: "include",
        headers: bearerHeaders(t, true),
        body: JSON.stringify(version !== undefined ? { text, version } : { text }),
      }),
    );
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { conflict?: Partial<MemoryConflict> } | null;
      assertAuthResponseCurrent(res);
      const c = body?.conflict;
      if (c && typeof c.text === "string") {
        return {
          ok: false,
          conflict: {
            text: c.text,
            version: String(c.version ?? ""),
            charCount: Number(c.charCount ?? 0),
            limit: Number(c.limit ?? 0),
          },
        };
      }
      // 非预期的 409（无 conflict 载荷）：按普通错误抛，保持统一错误信封。
      throw new ApiError({ status: 409, message: withReqId("记忆写入冲突", res), body });
    }
    const out = await jsonOrThrow<{ ok: boolean; version: string; charCount?: number; limit?: number }>(res);
    return { ok: true, version: out.version, charCount: out.charCount, limit: out.limit };
  },

  /** 取某 agent 的核心记忆索引 + 文件列表（GET /api/agents/:id/memory/memory）。
   *  memdir 范式:返回只读索引文本 + 每条记忆文件的元数据(name/description/type/mtime)。
   *  正文按需经 getMemoryFile 单取(渐进披露,不一次拉全部正文)。 */
  getMemoryIndex: (a: AuthSession, agentId: string) =>
    jsonOrThrow<MemoryIndexResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/memory`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** Auto-Dream 最近一次梦境报告与当前进度；响应经过容器端严格白名单投影。 */
  getAutoDreamReport: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamReportResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-report`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  getAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  runAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  cancelAutoDreamOptimizer: (a: AuthSession, agentId: string) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer/cancel`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  mutateAutoDreamProposal: (
    a: AuthSession,
    agentId: string,
    proposalId: string,
    action: "apply" | "dismiss",
  ) =>
    jsonOrThrow<AutoDreamOptimizerState>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/auto-dream-optimizer/proposals/${proposalId}/${action}`,
          {
            method: "POST",
            credentials: "include",
            headers: bearerHeaders(t, true),
            body: "{}",
          },
        ),
      ),
    ),

  /** 取单个记忆文件正文（GET /api/agents/:id/memory/files/:file）。version=乐观锁令牌。 */
  getMemoryFile: (a: AuthSession, agentId: string, file: string) =>
    jsonOrThrow<MemoryFileContent>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /**
   * 写单个记忆文件（PUT /api/agents/:id/memory/files/:file，body `{ content, version? }`）。
   * 新建传 version=undefined(不做版本校验)；编辑带 version 做乐观锁。version 落后 → 409
   * `{ conflict:{ content|current|text, version } }`(文件已被别处修改):不当错误抛,交回上层
   * 刷新基线并保留用户未保存文本。其余非 2xx 走统一 ApiError。
   */
  putMemoryFile: async (
    a: AuthSession,
    agentId: string,
    file: string,
    content: string,
    version?: string,
  ): Promise<PutMemoryFileResult> => {
    const res = await callWithRefresh(a, (t) =>
      fetch(
        `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(version !== undefined ? { content, version } : { content }),
        },
      ),
    );
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        conflict?: { content?: string; current?: string; text?: string; version?: unknown };
      } | null;
      assertAuthResponseCurrent(res);
      const c = body?.conflict;
      // 存储层 conflict 用 `current`,路由若对齐 user 用 `text`,一律兼容取正文。
      const latest = c ? (c.content ?? c.current ?? c.text) : undefined;
      if (c && typeof latest === "string") {
        return { ok: false, conflict: { content: latest, version: String(c.version ?? "") } };
      }
      throw new ApiError({ status: 409, message: withReqId("记忆文件写入冲突", res), body });
    }
    const out = await jsonOrThrow<{ ok: boolean; version: string }>(res);
    return { ok: true, version: out.version };
  },

  /** 删除单个记忆文件（DELETE /api/agents/:id/memory/files/:file）。返回是否删除成功。 */
  deleteMemoryFile: async (a: AuthSession, agentId: string, file: string): Promise<boolean> => {
    const out = await jsonOrThrow<{ ok?: boolean; deleted?: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memory/files/${encodeURIComponent(file)}`,
          { method: "DELETE", credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    );
    return out.deleted ?? out.ok ?? true;
  },

  /** 定时任务列表（GET /api/cron）。 */
  listCron: (a: AuthSession) =>
    jsonOrThrow<{ jobs: CronJob[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.jobs || []),

  /** 新建定时任务（POST /api/cron）。 */
  createCron: (a: AuthSession, body: CronCreateInput) =>
    jsonOrThrow<{ ok: boolean; job?: CronJob }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 改定时任务（PUT /api/cron/:id，如 {enabled}）。 */
  updateCron: (a: AuthSession, id: string, patch: Record<string, unknown>) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  /** 删除定时任务（DELETE /api/cron/:id）。 */
  deleteCron: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 文献库列表(GET /api/me/research/library,master 直存,非容器代理)。 */
  listResearchLibrary: (a: AuthSession) =>
    jsonOrThrow<{ documents: ResearchLibraryDoc[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/research/library", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.documents || []),

  /** 文献库删单篇(DELETE /api/me/research/library/:docId)。 */
  deleteResearchDoc: (a: AuthSession, docId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/research/library/${encodeURIComponent(docId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 文献库上传入库(POST /api/me/research/library?filename=,raw bytes ≤25MiB)。 */
  uploadResearchDoc: (a: AuthSession, file: File) =>
    jsonOrThrow<ResearchLibraryUploadResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/research/library?filename=${encodeURIComponent(file.name)}`, {
          method: "POST",
          credentials: "include",
          headers: {
            ...bearerHeaders(t),
            "content-type": file.type || "application/octet-stream",
          },
          body: file,
        }),
      ),
    ),

  /** 技能列表（GET /api/skills）。 */
  listSkills: (a: AuthSession) =>
    jsonOrThrow<{ skills: SkillSummary[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.skills || []),

  /** 技能详情（GET /api/skills/:name）。 */
  getSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ skill: SkillDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.skill),

  /** 删除技能（DELETE /api/skills/:name）。 */
  deleteSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 更新技能(描述/正文/标签;PUT /api/skills/:name,旧版自动入 history)。 */
  updateSkill: (
    a: AuthSession,
    name: string,
    body: { description?: string; body?: string; tags?: string[]; agentIds?: string[] },
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 读技能目录内单个文件（GET /api/skills/:name?file=<rel>）。 */
  getSkillFile: (a: AuthSession, name: string, path: string) =>
    jsonOrThrow<{ path: string; content: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(path)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 写技能辅助文件（PUT /api/skills/:name/files;references/assets/evals/scripts）。 */
  putSkillFile: (a: AuthSession, name: string, path: string, content: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/files`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ path, content }),
        }),
      ),
    ),

  /** 删技能辅助文件。 */
  deleteSkillFile: (a: AuthSession, name: string, path: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 技能版本历史（GET /api/skills/:name/history;快照覆盖 SKILL.md 正文）。 */
  getSkillHistory: (a: AuthSession, name: string) =>
    jsonOrThrow<{ history: Array<{ version: string; timestamp: string }>; writable: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/history`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 恢复历史版本（POST /api/skills/:name/restore;以新版本号写回,可再回滚）。 */
  restoreSkillVersion: (a: AuthSession, name: string, version: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ version }),
        }),
      ),
    ),

  // ── 技能评测 + 训练(SkillOpt;经容器代理,消耗积分的操作在 UI 层强制成本确认) ──

  /** 评测用例 + 上次结果（GET /api/skills/:name/evals）。 */
  getSkillEvals: (a: AuthSession, name: string) =>
    jsonOrThrow<{
      evals: SkillEvalsFile | null;
      parseErrors?: string[];
      lastRun: { runId: string; finishedAt: number; benchmark: SkillEvalRun["benchmark"]; usage: SkillRunUsage } | null;
      writable: boolean;
    }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 保存评测用例（PUT /api/skills/:name/evals）。 */
  putSkillEvals: (a: AuthSession, name: string, evals: SkillEvalsFile) =>
    jsonOrThrow<{ ok: boolean; evals: SkillEvalsFile }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ evals }),
        }),
      ),
    ),

  /** 启动评测 run（POST /api/skills/:name/eval-run;消耗积分,调用前必须已过成本确认）。 */
  startSkillEvalRun: (a: AuthSession, name: string, body?: { mode?: "baseline" | "draft"; trainRunId?: string }) =>
    jsonOrThrow<{ ok: boolean; runId: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/eval-run`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body ?? {}),
        }),
      ),
    ),

  /** 评测 run 状态（GET /api/skill-eval/:runId）。 */
  getSkillEvalRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ run: SkillEvalRun }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-eval/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.run),

  /** 启动 AI 生成评测用例 job（POST /api/skills/:name/evals/generate;消耗积分,调用前必须
   *  已过成本确认）。生成绝不落库,只回草稿由前端灌进编辑器。经 ApiError 抛:409=同技能已有
   *  生成/评测在跑;403=非自建技能;404=技能不存在。 */
  generateSkillEvals: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean; runId: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/evals/generate`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({}),
        }),
      ),
    ),

  /** AI 生成 job 状态（GET /api/skill-eval-gen/:runId;直接回 job,cases 仅 done）。 */
  getSkillEvalGen: (a: AuthSession, runId: string) =>
    jsonOrThrow<SkillEvalGenJob>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-eval-gen/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 启动训练 run（POST /api/skills/:name/train;消耗积分,调用前必须已过成本确认）。
   *  响应可带 feedbackRefs(命中的差评真实使用记录条数;旧后端缺省)。 */
  startSkillTrain: (a: AuthSession, name: string, body?: { focus?: string; autoEval?: boolean }) =>
    jsonOrThrow<SkillTrainStartResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}/train`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body ?? {}),
        }),
      ),
    ),

  /** 训练 run 列表（GET /api/skill-training，按 startedAt 降序）。
   *  用于页面刷新/服务重启后找回未完成或有草稿(diff_ready)的训练 run。 */
  listSkillTrainRuns: (a: AuthSession) =>
    jsonOrThrow<{ runs: SkillTrainRun[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/skill-training", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.runs || []),

  /** 训练 run 状态（GET /api/skill-training/:runId）。 */
  getSkillTrainRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ run: SkillTrainRun }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.run),

  /** 放弃训练 run(DELETE,连同草稿一起清)。 */
  discardSkillTrainRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 草稿列表。 */
  listSkillDrafts: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ drafts: SkillDraftSummary[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}/drafts`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.drafts || []),

  /** 草稿详情(草稿+现版两个 diff 侧)。 */
  getSkillDraft: (a: AuthSession, runId: string, name: string) =>
    jsonOrThrow<SkillDraftDetail>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}/drafts/${encodeURIComponent(name)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 对草稿留评论 → AI 修订(消耗积分,UI 层须再次确认)。 */
  commentSkillDraft: (a: AuthSession, runId: string, name: string, comment: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/skill-training/${encodeURIComponent(runId)}/drafts/${encodeURIComponent(name)}/comment`,
          {
            method: "POST",
            credentials: "include",
            headers: bearerHeaders(t, true),
            body: JSON.stringify({ comment }),
          },
        ),
      ),
    ),

  /** 合并草稿到权威技能库(唯一写入)。 */
  mergeSkillTrainRun: (a: AuthSession, runId: string, name?: string) =>
    jsonOrThrow<{ ok: boolean; results: Array<{ name: string; ok: boolean; error?: string }> }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skill-training/${encodeURIComponent(runId)}/merge`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(name ? { name } : {}),
        }),
      ),
    ),

  // ── AI 市场（marketplace，见 packages/commercial/src/marketplace） ─────────

  /** 市场检索/浏览（GET /api/marketplace/search?q=&limit=&kind=，空 q 返该 kind 全部目录）。 */
  searchMarketplace: (a: AuthSession, q = "", kind?: "skill" | "agent" | "connector", limit = 50) =>
    jsonOrThrow<MarketplaceSearchResult>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/marketplace/search?q=${encodeURIComponent(q)}&limit=${limit}${kind ? `&kind=${kind}` : ""}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** Opaque market invalidation token; compare equality only. */
  getMarketplaceRevision: (a: AuthSession) =>
    jsonOrThrow<{ revision: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/revision", {
          credentials: "include",
          cache: "no-store",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 市场条目详情（GET /api/marketplace/:slug，含完整 SKILL.md 供安装确认）。 */
  getMarketplaceDetail: (a: AuthSession, slug: string) =>
    jsonOrThrow<{ detail: MarketplaceDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/${encodeURIComponent(slug)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.detail),

  /** 安装一个已批准版本（POST /api/marketplace/install）。 */
  installMarketplace: (
    a: AuthSession,
    versionId: string,
    agentIds?: string[],
    preserveManualScope = false,
  ) => {
    if (preserveManualScope && agentIds === undefined) {
      throw new Error("preserveManualScope requires the current compatibility scope");
    }
    return jsonOrThrow<MarketplaceInstallResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/install", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({
            versionId,
            ...(agentIds !== undefined
              ? {
                  agentIds,
                  // Normal edits are explicitly manual. Version updates instead send the
                  // legacy union without this flag: old servers preserve that union, while
                  // new servers subtract dependency-owned bindings before writing provenance.
                  ...(!preserveManualScope ? { manualAgentScope: true } : {}),
                }
              : {}),
          }),
        }),
      ),
    ).then((result) => ({
      ...result,
      // A tab may outlive a server rollback. The previous response shape omitted
      // composition outcomes, so normalize once at the API boundary for all callers.
      installedCapabilities: result.installedCapabilities ?? [],
      skippedOptional: result.skippedOptional ?? [],
      needsAuthorization: result.needsAuthorization ?? [],
      ready: result.ready ?? true,
      installedDeps: result.installedDeps ?? 0,
    }));
  },

  /** 修改已安装市场技能归属（PATCH /api/marketplace/installed/:slug）。 */
  updateMarketplaceInstallAgents: (a: AuthSession, slug: string, agentIds: string[]) =>
    jsonOrThrow<{ ok: boolean; agentIds: string[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/installed/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ agentIds }),
        }),
      ),
    ),

  /** 我的已安装（GET /api/marketplace/installed）。 */
  listMarketplaceInstalled: (a: AuthSession) =>
    jsonOrThrow<{ installed: MarketplaceInstalled[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/installed", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.installed || []),

  /** 卸载（DELETE /api/marketplace/installed/:slug）。 */
  uninstallMarketplace: (
    a: AuthSession,
    slug: string,
    reason:
      | "not_needed"
      | "poor_quality"
      | "missing_capability"
      | "install_error"
      | "other"
      | "prefer_not_say" = "prefer_not_say",
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/installed/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /**
   * 发布（POST /api/marketplace/publish）。整个 input 原样序列化为请求体,
   * 含 storefront 元数据 category/useCases/outcomeExamples/humanMd（后端在 SKILL.md
   * 工件之外单独入库）。被静态扫描拦截时抛 ApiError(status 422, code SCAN_BLOCKED,
   * body 含 riskFlags)，人向元数据校验失败时 400(code BAD_CATEGORY/BAD_USE_CASES 等)，
   * 上层据此做友好提示。
   */
  publishMarketplace: (a: AuthSession, input: MarketplacePublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /**
   * 发布智能体（POST /api/marketplace/agent/publish）。manifest 走后端严格白名单
   * 校验(模型∈公开目录/工具集∈vetted/skillDeps 须已上架),422 带 errors/riskFlags;
   * storefront 元数据 category/useCases/outcomeExamples/humanMd 随 input 原样上传,
   * 后端在 manifest 校验前剔除、单独入库(与 skill 发布同规则),校验失败 400。
   */
  publishMarketplaceAgent: (a: AuthSession, input: MarketplaceAgentPublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/agent/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /** 发布声明式连接器（进入 AI 自动审核；不确定或高风险项转人工复核）。 */
  publishMarketplaceConnector: (a: AuthSession, input: MarketplaceConnectorPublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/connector/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /** 我的发布记录（GET /api/marketplace/my-publishes：状态 + 审核理由，发布闭环）。 */
  listMarketplaceMyPublishes: (a: AuthSession) =>
    jsonOrThrow<{ publishes: MarketplaceMyPublish[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/my-publishes", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.publishes || []),

  /** 撤销自己的待审发布（POST /api/marketplace/my-publishes/:id/withdraw）。 */
  withdrawMarketplacePublish: (a: AuthSession, versionId: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/my-publishes/${encodeURIComponent(versionId)}/withdraw`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({}),
        }),
      ),
    ),

  /** 发布者自助下架自己的当前上架条目（POST /api/marketplace/:slug/unlist）。 */
  unlistMarketplaceListing: (a: AuthSession, slug: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; affectedInstalls: number; affectedUserIds: number[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/${encodeURIComponent(slug)}/unlist`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /** 我的智能体（GET /api/marketplace/my-agents：默认全能助手 + 已安装市场智能体）。 */
  listMyAgents: (a: AuthSession) =>
    jsonOrThrow<{ agents: MarketplaceMyAgent[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/my-agents", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.agents || []),

  // ── 管理员审核（admin；后端 requireAdminVerifyDb 二次把关） ────────────────

  /** 待审版本列表（GET /api/admin/marketplace/pending）。 */
  adminMarketplacePending: (a: AuthSession) =>
    jsonOrThrow<{ pending: MarketplacePending[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/pending", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.pending || []),

  /** AI 自动审批记录（GET /api/admin/marketplace/ai-reviews；review_source='ai'）。 */
  adminMarketplaceAiReviews: (a: AuthSession) =>
    jsonOrThrow<{ reviews: MarketplaceAiReview[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/ai-reviews", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.reviews || []),

  /** 审核(批准/拒绝)一个版本（POST /api/admin/marketplace/:id/review）。 */
  adminMarketplaceReview: (
    a: AuthSession,
    versionId: string,
    decision: "approve" | "reject",
    note?: string,
    connectorReview?: {
      securityDecision: Record<string, unknown>;
      expectedSpecHash: string;
      functionalVerified: true;
    },
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(versionId)}/review`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ decision, note, ...(connectorReview ?? {}) }),
        }),
      ),
    ),

  /** 批量审核(批准/拒绝)多个待审版本（POST /api/admin/marketplace/review-batch）。 */
  adminMarketplaceReviewBatch: (
    a: AuthSession,
    versionIds: string[],
    decision: "approve" | "reject",
    note?: string,
  ) =>
    jsonOrThrow<MarketplaceReviewBatchResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/review-batch", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ versionIds, decision, note }),
        }),
      ),
    ),

  /** 下架(kill-switch)一个条目（POST /api/admin/marketplace/:slug/revoke）。 */
  adminMarketplaceRevoke: (a: AuthSession, slug: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; affectedInstalls: number; affectedUserIds: number[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(slug)}/revoke`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  /**
   * 设置/取消精选（POST /api/admin/marketplace/:slug/featured；requireAdminVerifyDb）。
   * featuredRank：1..9999 精选排序（越小越靠前）；null=取消精选。listing 不存在/非
   * active 时后端返 404/409，上层据此提示。服务端契约见批3简报（并行 agent 实现）。
   */
  setMarketplaceFeatured: (a: AuthSession, slug: string, featuredRank: number | null) =>
    jsonOrThrow<{ ok: boolean; slug: string; featuredRank: number | null }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(slug)}/featured`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ featuredRank }),
        }),
      ),
    ),

  // ── 站内信（inbox，用户侧） ───────────────────────────────────────────

  /** 拉站内信列表 + 未读数（GET /api/me/messages，Bearer）。unreadOnly 仅返未读。 */
  listInboxMessages: (
    a: AuthSession,
    opts?: { unreadOnly?: boolean; limit?: number; offset?: number },
  ): Promise<{ messages: InboxMessage[]; unread_count: number }> => {
    const qs = new URLSearchParams();
    if (opts?.unreadOnly) qs.set("unread_only", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<{ messages: InboxMessage[]; unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  /** 仅未读数（GET /api/me/messages/unread_count，Bearer）。铃铛红点轮询用，轻量。 */
  getInboxUnreadCount: (a: AuthSession): Promise<number> =>
    jsonOrThrow<{ unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/unread_count", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.unread_count),

  /** 标记单条已读（POST /api/me/messages/:id/read，Bearer，幂等）。 */
  markInboxRead: (a: AuthSession, id: string): Promise<{ ok: boolean; already: boolean }> =>
    jsonOrThrow<{ ok: boolean; already: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages/${encodeURIComponent(id)}/read`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 全部标记已读（POST /api/me/messages/read_all，Bearer）。返插入行数。 */
  markAllInboxRead: (a: AuthSession): Promise<{ ok: boolean; inserted: number }> =>
    jsonOrThrow<{ ok: boolean; inserted: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/read_all", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── GitHub 仓库绑定 ──────────────────────────────────────────────────

  /**
   * 启动 GitHub 账号关联 OAuth（POST /api/auth/github/start，Bearer）。
   * 返回 authorizeUrl + state（同时 Set-Cookie state 做双因素校验），调用方
   * `location.href = authorizeUrl` 跳转 GitHub 授权页；授权后后端 302 回
   * `/?github_linked=1` 或 `/?github_error=<code>`。未配 OAuth 时后端 503。
   */
  startGithubOAuth: (a: AuthSession): Promise<{ authorizeUrl: string; state: string }> =>
    jsonOrThrow<{ authorizeUrl: string; state: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/auth/github/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  /** 读 GitHub 账号关联状态（GET /api/me/github，Bearer）。 */
  getGithubLink: (a: AuthSession): Promise<GithubLink> =>
    jsonOrThrow<GithubLink>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 解绑 GitHub 账号（DELETE /api/me/github，Bearer）。级联清所有会话选择。 */
  unlinkGithub: (a: AuthSession): Promise<{ revoked: boolean; sessionsCleared: number }> =>
    jsonOrThrow<{ revoked: boolean; sessionsCleared: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 列我的 GitHub 仓库（GET /api/me/github/repos，Bearer）。默认按 pushed 倒序、owner 类型。 */
  listGithubRepos: (a: AuthSession): Promise<GithubRepo[]> =>
    jsonOrThrow<{ items: GithubRepo[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github/repos?per_page=100&sort=pushed&type=owner", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.items ?? []),

  /** 列某仓库分支（GET /api/me/github/repos/:owner/:repo/branches，Bearer）。 */
  listGithubBranches: (a: AuthSession, owner: string, repo: string): Promise<GithubBranch[]> =>
    jsonOrThrow<{ items: GithubBranch[] }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/me/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ).then((b) => b.items ?? []),

  /** 读某会话的仓库选择（GET /api/me/sessions/:sid/github-selection，Bearer）。 */
  getRepoSelection: (a: AuthSession, sid: string): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 设置某会话的仓库选择（PUT /api/me/sessions/:sid/github-selection，Bearer）。
   * 后端校验写权限/分支存在，返回权威 selection_version + status:'pending'。
   * 调用方拿到版本后经 WS 发 inbound.control.session_repo_bind 触发容器克隆。
   */
  putRepoSelection: (
    a: AuthSession,
    sid: string,
    body: { owner: string; repo: string; branch: string },
  ): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 清某会话的仓库选择（DELETE /api/me/sessions/:sid/github-selection，Bearer）。不返新版本号。 */
  deleteRepoSelection: (a: AuthSession, sid: string): Promise<{ cleared: boolean }> =>
    jsonOrThrow<{ cleared: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── 应用连接器（App Connectors） ─────────────────────────────────────
  // 契约与后端钉死（类型权威在 lib/connectors.ts）；错误码经 ApiError.code 上抛，
  // 由调用方走 connectorErrorText 映射中文，本层不做文案。

  /** 目录 + 已绑合并视图（GET /api/connectors，Bearer）。 */
  getConnectors: (a: AuthSession): Promise<ConnectorsResponse> =>
    jsonOrThrow<ConnectorsResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 表单绑定（token/basic_form；POST /api/connectors/:provider，Bearer）。 */
  bindConnector: (
    a: AuthSession,
    provider: string,
    body: { fields: Record<string, string>; displayName?: string },
  ): Promise<ConnectorBindResult> =>
    jsonOrThrow<ConnectorBindResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(provider)}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /**
   * BYOA OAuth 发起（POST /api/connectors/:provider/oauth/start，Bearer）。
   * 返回 authorizeUrl，调用方整页跳转（window.location.href）；授权后后端 302 回
   * `/?connector_linked=<provider>` 或 `/?connector_error=<code>`（照 GitHub 范式）。
   */
  startConnectorOAuth: (
    a: AuthSession,
    provider: string,
    body: { clientId: string; clientSecret: string; displayName?: string },
  ): Promise<ConnectorOAuthStartResult> =>
    jsonOrThrow<ConnectorOAuthStartResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(provider)}/oauth/start`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 写操作确认完整详情（GET /api/connectors/confirmations/:id，服务端解密渲染）。 */
  getConnectorConfirmation: (a: AuthSession, id: string): Promise<ConnectorConfirmationDetail> =>
    jsonOrThrow<ConnectorConfirmationDetail>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/confirmations/${encodeURIComponent(id)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 批准 / 拒绝写操作（POST /api/connectors/confirmations/:id/approve|deny）。 */
  decideConnectorConfirmation: (
    a: AuthSession,
    id: string,
    decision: "approve" | "deny",
  ): Promise<ConnectorDecisionResult> =>
    jsonOrThrow<ConnectorDecisionResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/confirmations/${encodeURIComponent(id)}/${decision}`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  /** 重命名连接（PATCH /api/connectors/:id）。 */
  renameConnector: (a: AuthSession, id: string, displayName: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ displayName }),
        }),
      ),
    ).then(() => undefined),

  /** 解绑连接（DELETE /api/connectors/:id，解绑 saga 由后端执行）。 */
  deleteConnector: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 声明式连接器引擎（未来单一权威；REST 前缀 /api/connectors/declarative/*） ──
  // 契约与后端钉死（类型权威在 lib/connectors.ts）；错误码经 ApiError.code 上抛，
  // 由调用方走 connectorErrorText 映射中文，本层不做文案。

  /** 声明式目录（GET /api/connectors/declarative/catalog，Bearer）。 */
  getDeclarativeCatalog: (a: AuthSession): Promise<DeclarativeCatalogResponse> =>
    jsonOrThrow<DeclarativeCatalogResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/catalog", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 已绑声明式连接（GET /api/connectors/declarative/connections，Bearer）。 */
  getDeclarativeConnections: (a: AuthSession): Promise<DeclarativeConnectionsResponse> =>
    jsonOrThrow<DeclarativeConnectionsResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/connections", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 管理中心统一读模型（官方默认 + 市场安装 + 历史绑定 fallback）。 */
  getDeclarativeManagement: (a: AuthSession): Promise<DeclarativeManagementResponse> =>
    jsonOrThrow<DeclarativeManagementResponse>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/management", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 绑定声明式连接器（POST /api/connectors/declarative/bind，Bearer）。 */
  bindDeclarativeConnector: (
    a: AuthSession,
    body: { versionId: number; secrets: Record<string, string>; displayName?: string },
  ): Promise<DeclarativeBindResult> =>
    jsonOrThrow<DeclarativeBindResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/bind", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /**
   * oauth2-auth-code 授权流起点（POST /api/connectors/declarative/oauth/start，Bearer）。
   * body 带用户 BYOA 自建应用的 client 凭据（clientSecret 只进服务端 AEAD 加密的 pending
   * draft，绝不进 authorize URL）。返回 authorizeUrl，调用方**整页跳转**；授权后后端 302 回
   * `/?connector_linked=<slug>` 或 `/?connector_error=<code>`（App 层统一 toast）。
   * 注：oauth2-auth-code 连接器走直填 bind 会被后端硬拒，必须走本端点。
   */
  startDeclarativeOauth: (
    a: AuthSession,
    body: { versionId: number; clientId: string; clientSecret: string; displayName?: string },
  ): Promise<DeclarativeOauthStartResult> =>
    jsonOrThrow<DeclarativeOauthStartResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/connectors/declarative/oauth/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 解绑声明式连接（DELETE /api/connectors/declarative/connections/:id，Bearer）。 */
  unbindDeclarativeConnector: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/connectors/declarative/connections/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 通用 Plugin 运行时（账号授权与隔离执行）────────────────────────────

  getPluginManagement: (a: AuthSession): Promise<PluginManagementResponse> =>
    jsonOrThrow<PluginManagementResponse>(
      callWithRefresh(a, (t) =>
        fetch('/api/plugins/management', {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startKnowledgePlanetSetup: (a: AuthSession): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch('/api/plugins/knowledge-planet/setup', {
          method: 'POST',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true }),
        }),
      ),
    ),

  getKnowledgePlanetSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}`, {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getKnowledgePlanetSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: 'include',
        headers: { ...bearerHeaders(t), Accept: 'image/png' },
      }),
    )
    assertAuthResponseCurrent(res)
    if (!res.ok) await throwApi(res)
    const blob = await res.blob()
    assertAuthResponseCurrent(res)
    return blob
  },

  cancelKnowledgePlanetSetup: (
    a: AuthSession,
    sessionId: string,
  ): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/knowledge-planet/setup/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startWeiboSetup: (
    a: AuthSession,
    accountId?: string,
  ): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch('/api/plugins/weibo/setup', {
          method: 'POST',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getWeiboSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}`, {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getWeiboSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: 'include',
        headers: { ...bearerHeaders(t), Accept: 'image/png' },
      }),
    )
    assertAuthResponseCurrent(res)
    if (!res.ok) await throwApi(res)
    const blob = await res.blob()
    assertAuthResponseCurrent(res)
    return blob
  },

  cancelWeiboSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/weibo/setup/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  startZhihuSetup: (
    a: AuthSession,
    accountId?: string,
  ): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch('/api/plugins/zhihu/setup', {
          method: 'POST',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ acceptTerms: true, ...(accountId ? { accountId } : {}) }),
        }),
      ),
    ),

  getZhihuSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}`, {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  async getZhihuSetupQr(a: AuthSession, sessionId: string): Promise<Blob> {
    const res = await callWithRefresh(a, (t) =>
      fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}/qr`, {
        credentials: 'include',
        headers: { ...bearerHeaders(t), Accept: 'image/png' },
      }),
    )
    assertAuthResponseCurrent(res)
    if (!res.ok) await throwApi(res)
    const blob = await res.blob()
    assertAuthResponseCurrent(res)
    return blob
  },

  cancelZhihuSetup: (a: AuthSession, sessionId: string): Promise<KnowledgePlanetSetupView> =>
    jsonOrThrow<KnowledgePlanetSetupView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/zhihu/setup/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  revokePluginAccount: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  setPluginWriteAccess: (
    a: AuthSession,
    id: string,
    input:
      | { enabled: false }
      | { enabled: true; accepted: true; disclaimerVersion: number },
  ): Promise<RuntimePluginAccount['writeControl']> =>
    jsonOrThrow<{ writeControl: RuntimePluginAccount['writeControl'] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/write-access`, {
          method: 'PATCH',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.writeControl),

  setPluginWritePreapproval: (
    a: AuthSession,
    id: string,
    input:
      | { enabled: false }
      | { enabled: true; accepted: true; disclaimerVersion: number },
  ): Promise<RuntimePluginAccount['writeControl']> =>
    jsonOrThrow<{ writeControl: RuntimePluginAccount['writeControl'] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/write-preapproval`, {
          method: 'PATCH',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.writeControl),

  getKnowledgePlanetAutomation: (
    a: AuthSession,
    id: string,
  ): Promise<KnowledgePlanetAutomationView> =>
    jsonOrThrow<KnowledgePlanetAutomationView>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation`, {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ),

  setKnowledgePlanetAutomation: (
    a: AuthSession,
    id: string,
    input:
      | { enabled: false; accountDailyLimit?: number }
      | {
          enabled: true
          accepted: true
          disclaimerVersion: number
          accountDailyLimit?: number
        },
  ): Promise<KnowledgePlanetAutomationControl> =>
    jsonOrThrow<{ control: KnowledgePlanetAutomationControl }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation`, {
          method: 'PATCH',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.control),

  listKnowledgePlanetAutomationGroups: (
    a: AuthSession,
    id: string,
  ): Promise<KnowledgePlanetAutomationGroup[]> =>
    jsonOrThrow<{ groups: KnowledgePlanetAutomationGroup[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/groups`, {
          credentials: 'include',
          headers: bearerHeaders(t),
        }),
      ),
    ).then((result) => result.groups),

  createKnowledgePlanetAutomationRulesBatch: (
    a: AuthSession,
    id: string,
    input: {
      groupIds: string[]
      name: string
      instructions: string
      triggerKind: 'new_topic' | 'new_question'
      dailyLimit: number
      cooldownMinutes: number
      maxReplyChars: number
    },
  ): Promise<KnowledgePlanetAutomationRule[]> =>
    jsonOrThrow<{ rules: KnowledgePlanetAutomationRule[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/batch`, {
          method: 'POST',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.rules),

  createKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    input: {
      groupId: string
      name: string
      instructions: string
      triggerKind: 'new_topic' | 'new_question'
      dailyLimit: number
      cooldownMinutes: number
      maxReplyChars: number
    },
  ): Promise<KnowledgePlanetAutomationRule> =>
    jsonOrThrow<{ rule: KnowledgePlanetAutomationRule }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules`, {
          method: 'POST',
          credentials: 'include',
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((result) => result.rule),

  patchKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    ruleId: string,
    patch: Partial<{
      name: string
      instructions: string
      triggerKind: 'new_topic' | 'new_question'
      enabled: boolean
      dailyLimit: number
      cooldownMinutes: number
      maxReplyChars: number
    }>,
  ): Promise<KnowledgePlanetAutomationRule> =>
    jsonOrThrow<{ rule: KnowledgePlanetAutomationRule }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/${encodeURIComponent(ruleId)}`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers: bearerHeaders(t, true),
            body: JSON.stringify(patch),
          },
        ),
      ),
    ).then((result) => result.rule),

  deleteKnowledgePlanetAutomationRule: (
    a: AuthSession,
    id: string,
    ruleId: string,
  ): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/plugins/accounts/${encodeURIComponent(id)}/automation/rules/${encodeURIComponent(ruleId)}`,
          {
            method: 'DELETE',
            credentials: 'include',
            headers: bearerHeaders(t),
          },
        ),
      ),
    ).then(() => undefined),

  // ── 企业版(P3.1)org 自助后台 ─────────────────────────────────────────
  // org 由服务端从 caller membership 推导,前端**不带** org_id。批次 D 端点(usage/
  // invoice)本文件权威;批次 B(topup/balance/orders/ledger)、批次 C(skills)按方案契约
  // 调用(字段名以后端为准)。大数一律字符串贯穿。

  /** GET /api/org 概要(member+)。403=无 org 归属 / org 停用。 */
  getOrg: (a: AuthSession): Promise<OrgSummary> =>
    jsonOrThrow<{ org: OrgSummary }>(
      callWithRefresh(a, (t) => fetch("/api/org", { credentials: "include", headers: bearerHeaders(t) })),
    ).then((b) => b.org),

  // ── 成员(A 批次后端已就绪) ──────────────────────────────────────────
  listOrgMembers: (a: AuthSession): Promise<OrgMember[]> =>
    jsonOrThrow<{ members: OrgMember[] }>(
      callWithRefresh(a, (t) => fetch("/api/org/members", { credentials: "include", headers: bearerHeaders(t) })),
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
      callWithRefresh(a, (t) => fetch("/api/org/invitations", { credentials: "include", headers: bearerHeaders(t) })),
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
  acceptOrgInvitation: (a: AuthSession, token: string): Promise<{ org_id: string; org_role: OrgRole }> =>
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

  putOrgInvoiceProfile: (a: AuthSession, input: OrgInvoiceProfileInput): Promise<OrgInvoiceProfile> =>
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
      callWithRefresh(a, (t) => fetch("/api/org/invoices", { credentials: "include", headers: bearerHeaders(t) })),
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
      callWithRefresh(a, (t) => fetch("/api/org/balance", { credentials: "include", headers: bearerHeaders(t) })),
    ).then((b) => b.credits),

  listOrgOrders: (a: AuthSession): Promise<OrgOrder[]> =>
    jsonOrThrow<{ rows: OrgOrder[] }>(
      callWithRefresh(a, (t) => fetch("/api/org/orders", { credentials: "include", headers: bearerHeaders(t) })),
    ).then((b) => b.rows ?? []),

  listOrgLedger: (a: AuthSession): Promise<OrgLedgerRow[]> =>
    jsonOrThrow<{ rows: OrgLedgerRow[] }>(
      callWithRefresh(a, (t) => fetch("/api/org/ledger", { credentials: "include", headers: bearerHeaders(t) })),
    ).then((b) => b.rows ?? []),

  // ── 技能(批次 C 契约) ───────────────────────────────────────────────
  getOrgSkills: (a: AuthSession): Promise<OrgSkillsResponse> =>
    jsonOrThrow<OrgSkillsResponse>(
      callWithRefresh(a, (t) => fetch("/api/org/skills", { credentials: "include", headers: bearerHeaders(t) })),
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
          body: JSON.stringify({ org_name: input.orgName, plan_code: input.planCode, seats: input.seats }),
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
  getSessionRatings: (a: AuthSession, sessionId: string): Promise<SessionRatingsMap> =>
    jsonOrThrow<{ ratings?: SessionRatingsMap }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/response-rating?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.ratings || {}),

  // ── 对话传输（P4 已接入：WS user-chat-bridge） ────────────────────────
  //
  // v5 对话传输走 WebSocket（/ws/user-chat-bridge，bearer 子协议
  // `new WebSocket(url, ['bearer', accessJWT])`，inbound.message 帧），不再是
  // v4-trial 的 SSE。实现不在 api.ts（REST 专属），而在渲染树之外的单例 service
  // `lib/chat/socket.ts`（ChatSocket：safeWsSend 2MB 背压 + per-sessionKey frameSeq
  // 去重 + 三层断点续传 + 离线队列三段式 drain），由 React 绑定 `hooks/useChatSocket.ts`
  // 消费。会话历史的 REST 全量 sync（断点续传最终权威源）走上面的 getSession。
};
