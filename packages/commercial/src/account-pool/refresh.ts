/**
 * T-33 — Claude OAuth Token 刷新。
 *
 * 规约(见 01-SPEC F-6.7,02-ARCH §2.7):
 *   - `shouldRefresh(expiresAt, now, skewMs)` — 纯函数:token 是否即将过期
 *   - `refreshAccountToken(accountId, deps)`:
 *       1. 读 refresh_token(解密明文 Buffer,用完清零)
 *       2. 调 OAuth refresh endpoint(form-urlencoded grant_type=refresh_token)
 *       3. 2xx + 返回含 access_token → 重新加密写回 DB,返回新 token Buffer
 *       4. 失败(任意)→ manualDisable 账号 + throw RefreshError(code 不同)
 *
 * 失败都通过 `RefreshError` 抛,调用方据 `code` 分类:
 *   - `account_not_found` — 读账号返 null(也许被并发删了)
 *   - `no_refresh_token` — DB 里没 refresh_token,无法自救
 *   - `http_error` — 网络错 / 非 2xx(含 status 字段)
 *   - `bad_response` — 2xx 但 JSON 解析失败 / 缺 access_token
 *   - `persist_error` — 远端 refresh 成功了,但本地 updateAccount 抛了;
 *     为避免"本地仍是旧 token 但账号还 active"的失控场面,一律禁用并抛
 *
 * 安全规约:
 *   - 明文 refresh_token 仅短暂生存在 JS 字符串内(为 form-urlencode),encode 后立即失去引用
 *   - 调用方收到的 token Buffer **必须 `.fill(0)`**(同 getTokenForUse 规约)
 *   - 错误消息不回显 refresh_token / 密文
 */

import { getTokenForUse, updateAccount, type AccountPlan } from "./store.js";
import { loadKmsKey } from "../crypto/keys.js";
import type { AccountHealthTracker } from "./health.js";

/** token 过期时间与当前时间差小于此值 → 应 refresh。5 分钟。 */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 默认 OAuth refresh endpoint。生产部署可通过 deps.endpoint 覆盖。 */
export const DEFAULT_OAUTH_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

/** refresh 成功但服务器没给 expires_in/expires_at 时的保底:1 小时。 */
export const DEFAULT_FALLBACK_EXPIRES_MS = 60 * 60 * 1000;

export type RefreshErrorCode =
  | "account_not_found"
  | "no_refresh_token"
  | "http_error"
  | "bad_response"
  | "persist_error";

export class RefreshError extends Error {
  readonly code: RefreshErrorCode;
  readonly status?: number;
  constructor(
    code: RefreshErrorCode,
    message: string,
    opts?: { status?: number; cause?: unknown },
  ) {
    super(message, opts);
    this.name = "RefreshError";
    this.code = code;
    this.status = opts?.status;
  }
}

/**
 * HTTP client 抽象。生产注入 `defaultHttp`(基于 fetch),测试用可控 mock。
 * 把"网络层"抽出来便于在集成测试里不真的去打 Anthropic。
 */
export interface RefreshHttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    /**
     * 可选 undici Dispatcher(常为 ProxyAgent),按账号粒度指定出口。
     * 默认实现透传给 fetch 的 dispatcher 字段(undici 实现 / Node 18+)。
     */
    dispatcher?: unknown,
  ): Promise<{ status: number; body: string }>;
}

export interface RefreshedTokens {
  token: Buffer;
  refresh: Buffer | null;
  expires_at: Date;
  plan: AccountPlan;
}

export interface RefreshDeps {
  /** HTTP 客户端(默认 fetch 实现)。 */
  http?: RefreshHttpClient;
  keyFn?: () => Buffer;
  now?: () => Date;
  endpoint?: string;
  /** OAuth 公共客户端 id。给了就写进 form。 */
  clientId?: string;
  /** 判"即将过期"的 skew;仅供 `shouldRefresh` 方便 threading。 */
  skewMs?: number;
  /**
   * 若给,失败时用 `health.manualDisable(id, reason)` 禁用账号;
   * 否则降级为直接 UPDATE status='disabled'(避开 health 依赖)。
   */
  health?: AccountHealthTracker;
  /**
   * 出口 dispatcher(undici ProxyAgent 等)。给则刷 token 也走该代理,
   * 否则走默认出口。chat orchestrator 应该按账号 egress_proxy 构造后透传进来。
   */
  dispatcher?: unknown;
}

/**
 * 纯判断:token 是否应刷新。
 *
 * - `expiresAt === null` → 视为永不过期(refresh_token 流或未知期限),返 false
 * - 否则:`expiresAt - now ≤ skewMs` → true
 *
 * 调用方通常:先 pick → 再 shouldRefresh → 若 true 则先 refresh 再用。
 */
export function shouldRefresh(
  expiresAt: Date | null,
  now: Date,
  skewMs: number,
): boolean {
  if (expiresAt === null) return false;
  return expiresAt.getTime() - now.getTime() <= skewMs;
}

/** 基于全局 fetch 的默认实现。生产走 globalThis.fetch。 */
export const defaultHttp: RefreshHttpClient = {
  async post(url, headers, body, dispatcher) {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch(url, init);
    const text = await res.text();
    return { status: res.status, body: text };
  },
};

interface OAuthRefreshJson {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  token_type?: unknown;
}

function computeExpiresAt(parsed: OAuthRefreshJson, now: Date): Date {
  if (typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)) {
    return new Date(now.getTime() + parsed.expires_in * 1000);
  }
  if (typeof parsed.expires_at === "number" && Number.isFinite(parsed.expires_at)) {
    // 兼容 epoch seconds 与 ms(> 1e12 视为 ms)
    const raw = parsed.expires_at;
    return new Date(raw > 1e12 ? raw : raw * 1000);
  }
  return new Date(now.getTime() + DEFAULT_FALLBACK_EXPIRES_MS);
}

async function disableOnFailure(
  deps: RefreshDeps,
  accountId: bigint | string,
  reason: string,
): Promise<void> {
  if (deps.health) {
    try {
      await deps.health.manualDisable(accountId, reason);
    } catch {
      /* 禁用尽力而为,不要把 refresh 的原错误覆盖掉 */
    }
    return;
  }
  try {
    await updateAccount(
      accountId,
      { status: "disabled", last_error: reason },
      deps.keyFn ?? loadKmsKey,
    );
  } catch {
    /* 同理 */
  }
}

/**
 * 刷新账号 token,成功 → 写回 DB + 返新 token;失败 → 禁用账号 + throw。
 *
 * @throws {@link RefreshError}
 */
export async function refreshAccountToken(
  accountId: bigint | string,
  deps: RefreshDeps = {},
): Promise<RefreshedTokens> {
  const http = deps.http ?? defaultHttp;
  const keyFn = deps.keyFn ?? loadKmsKey;
  const endpoint = deps.endpoint ?? DEFAULT_OAUTH_ENDPOINT;
  const now = (deps.now ?? ((): Date => new Date()))();

  // 1. 读 refresh_token —— 同一 Buffer 用完立即清零
  const current = await getTokenForUse(accountId, keyFn);
  if (!current) {
    throw new RefreshError(
      "account_not_found",
      `account ${String(accountId)} not found`,
    );
  }
  // 我们只需 refresh_token;access_token Buffer 立即清零
  current.token.fill(0);
  if (!current.refresh) {
    await disableOnFailure(deps, accountId, "refresh_no_token_on_record");
    throw new RefreshError(
      "no_refresh_token",
      `account ${String(accountId)} has no refresh_token on record`,
    );
  }
  const refreshStr = current.refresh.toString("utf8");
  current.refresh.fill(0);

  // 2. 调 OAuth refresh endpoint
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshStr,
  });
  if (deps.clientId) form.set("client_id", deps.clientId);

  let result: { status: number; body: string };
  try {
    result = await http.post(
      endpoint,
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      form.toString(),
      deps.dispatcher,
    );
  } catch (err) {
    await disableOnFailure(deps, accountId, "refresh_network_error");
    // 不把底层 err.message 拼进 message:未来如果 endpoint 可带凭据,
    // 上游 fetch 错误的 url 片段可能泄露;完整异常走 cause 链。
    throw new RefreshError(
      "http_error",
      "refresh network call failed",
      { cause: err },
    );
  }

  if (result.status < 200 || result.status >= 300) {
    await disableOnFailure(deps, accountId, `refresh_http_${result.status}`);
    throw new RefreshError(
      "http_error",
      `refresh endpoint returned ${result.status}`,
      { status: result.status },
    );
  }

  let parsed: OAuthRefreshJson;
  try {
    parsed = JSON.parse(result.body);
  } catch (err) {
    await disableOnFailure(deps, accountId, "refresh_bad_json");
    throw new RefreshError(
      "bad_response",
      "refresh response body is not valid JSON",
      { cause: err },
    );
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    await disableOnFailure(deps, accountId, "refresh_no_access_token");
    throw new RefreshError(
      "bad_response",
      "refresh response missing access_token",
    );
  }

  const expiresAt = computeExpiresAt(parsed, now);
  const newAccessToken = parsed.access_token;
  const newRefreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : null;

  // 3. 加密写回 DB
  // refresh_token 轮换:服务器返了新的就写入;没返则保留原值(patch.refresh = undefined)
  const patch: Parameters<typeof updateAccount>[1] = {
    token: newAccessToken,
    oauth_expires_at: expiresAt,
    last_error: null,
  };
  if (newRefreshToken !== null) {
    patch.refresh = newRefreshToken;
  }
  // 持久化失败是特殊分类:远端 token 已轮换,本地却没存下,账号若仍 active
  // 会继续发旧 token,场面失控。按"失败一律禁用"的规约走 disableOnFailure。
  // 唯一例外:updateAccount 返 null 说明账号并发删了(不抛也无法禁用,
  // 就按 account_not_found 抛,不算 persist 错)。
  let updated: Awaited<ReturnType<typeof updateAccount>>;
  try {
    updated = await updateAccount(accountId, patch, keyFn);
  } catch (err) {
    await disableOnFailure(deps, accountId, "refresh_persist_error");
    throw new RefreshError(
      "persist_error",
      "failed to persist refreshed token to DB",
      { cause: err },
    );
  }
  if (!updated) {
    throw new RefreshError(
      "account_not_found",
      `account ${String(accountId)} vanished after successful refresh`,
    );
  }

  return {
    token: Buffer.from(newAccessToken, "utf8"),
    refresh: newRefreshToken !== null ? Buffer.from(newRefreshToken, "utf8") : null,
    expires_at: expiresAt,
    plan: current.plan,
  };
}
