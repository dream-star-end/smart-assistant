/**
 * web-react API transport core: bearer headers, request ids, auth refresh singleflight with epoch fences, retry/backoff, ApiError and JSON error unwrapping.
 *
 * Moved verbatim out of api.ts — FINDINGS §8 (cc2), OCV5-475. api.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type { AuthSession, RefreshOutcome, RefreshResult } from "../types";
import { reportClientFriction } from "../clientFriction";

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

const REFRESH_RACE_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 1_750] as const;

const REFRESH_TRANSIENT_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

type RawRefreshOutcome =
  | { kind: "success"; result: RefreshResult; raceObserved?: boolean }
  | { kind: "invalid"; raceObserved?: boolean }
  | { kind: "race" }
  | { kind: "transient"; retryAfterMs: number; raceObserved?: boolean; superseded?: boolean };

export type RefreshSurface = "auth" | "admin_auth" | "ws_auth";

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

export const refreshStates = new WeakMap<AuthSession, RefreshState>();

const authResponseFences = new WeakMap<Response, { session: AuthSession; epoch: number }>();

// 本 tab 内所有会写 oc_rt 的调用按发起顺序落地。跨 tab 的 refresh 冲突由后端
// REFRESH_RACE 协议处理；主动 logout 另有 token-free 广播让其它 tab 立即撤退。
let authCookieMutationTail: Promise<void> = Promise.resolve();

export function withAuthCookieMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = authCookieMutationTail.then(run, run);
  authCookieMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
    // keepalive（OCV5-636）：refresh 在途时页面被关/跳走/F5，普通 fetch 会被取消，但服务端已轮换
    // oc_rt —— Set-Cookie 丢失后浏览器一直带旧 token，45s 宽限一过就被判 theft 整族吊销（所有
    // tab 一起掉登录）。keepalive 让请求在文档卸载后照常完成，新 cookie 仍落进 cookie 罐。
    res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      keepalive: true,
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
    ? { kind: "transient", retryAfterMs: 0, raceObserved: true, superseded: true }
    : raceObserved
      ? { ...outcome, raceObserved: true }
      : outcome;
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
        reportClientFriction(
          {
            eventId: prior?.id,
            surface: prior?.surface ?? surface,
            stage: "refresh",
            code: prior?.code ?? "REFRESH_RACE",
            outcome: "recovered",
            attempts: Math.min(32, (prior?.attempts ?? 0) + 1),
          },
          raw.result.accessToken,
        );
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

    state.transientFailures = Math.min(
      state.transientFailures + 1,
      REFRESH_TRANSIENT_BACKOFF_MS.length,
    );
    const backoff = REFRESH_TRANSIENT_BACKOFF_MS[state.transientFailures - 1] ?? 10_000;
    const retryAfterMs = Math.max(raw.kind === "transient" ? raw.retryAfterMs : 0, backoff);
    state.nextAllowedAt = Date.now() + retryAfterMs;
    const prior = state.friction;
    const code =
      prior?.code ??
      (raw.kind === "race" || raw.raceObserved ? "REFRESH_RACE" : "REFRESH_TRANSIENT");
    const attempts = Math.min(32, (prior?.attempts ?? 0) + 1);
    const id = reportClientFriction(
      {
        eventId: prior?.id,
        surface: prior?.surface ?? surface,
        stage: "refresh",
        code,
        outcome: "failed",
        attempts,
      },
      a.snapshot().token,
    );
    state.friction = { id, code, attempts, surface: prior?.surface ?? surface };
    return raw.kind === "transient" && raw.superseded
      ? { kind: "transient", epoch: expectedEpoch, retryAfterMs, superseded: true }
      : { kind: "transient", epoch: expectedEpoch, retryAfterMs };
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
  if (beforeReplay.token !== refreshed.result.accessToken)
    return fenceAuthResponse(res, a, used.epoch);
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
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
  const h: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (json) h["content-type"] = "application/json";
  return h;
}

/** 把 x-request-id 拼到错误信息末尾，方便用户反馈、运维追溯。 */
export function withReqId(msg: string, res: Response): string {
  const id = res.headers.get("x-request-id");
  return id ? `${msg}（追踪号 ${id}）` : msg;
}

/** 后端错误 issue（commercial HttpError.issues：path+message 键值对）。 */
export type ApiIssue = { path: string; message: string };

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

export function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
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
