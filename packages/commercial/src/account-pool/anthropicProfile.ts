/**
 * Anthropic `/api/oauth/profile` fetch helper —— 给定 access token 拿账号 UUID。
 *
 * 用于两条路径:
 *   1. `admin/accounts.ts` 新建 claude 账号路径:在 INSERT 之前同步获取 uuid,
 *      作为 0070 migration `claude_accounts.account_uuid` 列的初值,跳过 Phase 6
 *      fail_closed scheduler 过滤 NULL uuid 的门(否则新账号一律不可用,见
 *      2026-05 P1 事故,memory: v3_new_claude_account_needs_uuid_backfill.md)。
 *   2. `scripts/backfill-account-uuid.ts` 存量回填路径:针对 admin UI 在本 PR
 *      之前创建的、`account_uuid IS NULL` 的活跃 claude 账号,周期性 backfill。
 *
 * 两个调用方共享解析/错误分类/日志脱敏逻辑,差异:
 *   - admin 路径:fail hard(任一 kind 都让 admin create 失败),retryOnTransient=true
 *     给一次 network/5xx 重试机会
 *   - backfill 路径:fail soft(把 Error 翻译成 outcome 后继续下一个账号),不重试
 *
 * 设计原则:
 *   - 纯函数式调用:接受 `accessToken` + 可选 `dispatcher`(undici Dispatcher),
 *     **不查 DB**,**不持有任何全局状态**;dispatcher 的构造/缓存由调用方决定
 *   - 日志安全:错误 detail 经 `safeErrMsg` 脱敏(去 uuid / email),200 字符截断;
 *     **绝不**在返回值或异常里复述 raw token / refresh / uuid 值
 *   - 401/403 单独归为 `token_invalid`(admin 输入问题,不是上游抖动),
 *     便于上层 metric / alert 区分
 *   - bad_shape 包含 JSON parse 错 / 缺 `account.uuid` / uuid 不符合 `isUuidLike`
 */

import type { Dispatcher } from "undici";

import { isUuidLike } from "../http/proxy/shared.js";

/** Anthropic OAuth profile 端点,与 CCB `getOauthProfile.ts:40` 保持一致。 */
export const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";

/** 默认 fetch 超时(ms)。 */
export const PROFILE_DEFAULT_TIMEOUT_MS = 10_000;

/** transient retry 间隔(network / 5xx 之间)。 */
export const PROFILE_RETRY_DELAY_MS = 1_000;

/**
 * 错误分类:
 *   - `token_invalid`  : 401 / 403(admin 输入的 token 无效或权限不够,人工介入)
 *   - `http_4xx`       : 其它 4xx(Anthropic 主动拒绝,如 429)
 *   - `http_5xx`       : 5xx(Anthropic 抖动,可重试)
 *   - `network`        : 连接 / TLS / timeout / DNS(可重试)
 *   - `bad_shape`      : 200 但 JSON / shape 异常(uuid 字段缺或不是 UUID 形)
 */
export type FetchAccountUuidErrorKind =
  | "token_invalid"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "bad_shape";

export interface FetchAccountUuidOk {
  kind: "ok";
  /** lowercased canonical form,已通过 `isUuidLike` 校验。 */
  uuid: string;
}

export interface FetchAccountUuidErr {
  kind: FetchAccountUuidErrorKind;
  /** HTTP status(network/bad_shape 时可能不存在)。 */
  status?: number;
  /** safeErrMsg 脱敏后的简短描述,≤200 字符。 */
  detail: string;
}

export type FetchAccountUuidResult = FetchAccountUuidOk | FetchAccountUuidErr;

export interface FetchAccountUuidOptions {
  /** 单次请求超时,默认 10 秒。 */
  timeoutMs?: number;
  /**
   * true → network/5xx 错误后 sleep `PROFILE_RETRY_DELAY_MS` 重试一次(再失败返回)。
   * admin 路径建议开,backfill 路径不开(后者无人值守 + 已有节流)。
   */
  retryOnTransient?: boolean;
}

/**
 * err.message 可能含 token / refresh / uuid / email 等敏感片段(尤其 PG 唯一冲突
 * "Key (account_uuid)=(...)" 或 Anthropic 错误体被 undici 透传),日志层强制脱敏一次。
 *
 *   - UUID(36 chars dashed hex):全部替换为 `<uuid>`
 *   - Email(简化 RFC 模式):替换为 `<email>`
 *   - 截断到 200 字符,防异常带堆栈刷屏
 */
export function safeErrMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>");
  return stripped.slice(0, 200);
}

/**
 * 单次 HTTP 调用(无 retry)—— 内部使用。
 *
 * 注意:即使 4xx/5xx 也读 body 取调试线索,但**不**打印 body(可能含 email);
 * body.length 仅用于 bad_shape 检测,不入 log。
 */
async function _profileOnce(
  accessToken: string,
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
): Promise<FetchAccountUuidResult> {
  let status: number;
  let bodyText: string;
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch(PROFILE_ENDPOINT, init);
    status = res.status;
    bodyText = await res.text();
  } catch (err) {
    return { kind: "network", detail: safeErrMsg(err) };
  }

  if (status === 401 || status === 403) {
    return { kind: "token_invalid", status, detail: `http_${status}` };
  }
  if (status >= 500) {
    return { kind: "http_5xx", status, detail: `http_${status}` };
  }
  if (status >= 400) {
    return { kind: "http_4xx", status, detail: `http_${status}` };
  }
  if (status !== 200) {
    return { kind: "bad_shape", status, detail: `unexpected_status_${status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: "bad_shape", status, detail: "json_parse_error" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "bad_shape", status, detail: "not_object" };
  }
  const account = (parsed as Record<string, unknown>).account;
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    return { kind: "bad_shape", status, detail: "no_account_field" };
  }
  const uuid = (account as Record<string, unknown>).uuid;
  if (typeof uuid !== "string") {
    return { kind: "bad_shape", status, detail: "uuid_not_string" };
  }
  // canonicalize:PG `uuid` 类型 INSERT 时会规范化,但 ts 层保持 lowercase 一致,
  // 后续比较 / log filter 不必再处理 case mismatch
  const canonical = uuid.toLowerCase();
  if (!isUuidLike(canonical)) {
    return { kind: "bad_shape", status, detail: "uuid_not_uuid_like" };
  }
  return { kind: "ok", uuid: canonical };
}

/**
 * 调 Anthropic `/api/oauth/profile`,解析返回 JSON 取 `account.uuid`。
 *
 * 不抛:任何失败都返回 `FetchAccountUuidErr`,kind 字段告诉调用方语义,
 * detail 已脱敏可直接入 log。
 *
 * `retryOnTransient=true` 时 network/5xx 错误会在 sleep 1s 后重试一次;
 * `token_invalid` / `http_4xx` / `bad_shape` 永不重试(语义上没指望)。
 *
 * @param accessToken Anthropic OAuth access token (明文)
 * @param dispatcher  可选 undici Dispatcher;给定时走该出口(账号专属 proxy),
 *                    否则走 master 默认出口
 * @param options     timeoutMs / retryOnTransient
 */
export async function fetchAnthropicAccountUuid(
  accessToken: string,
  dispatcher: Dispatcher | undefined,
  options: FetchAccountUuidOptions = {},
): Promise<FetchAccountUuidResult> {
  const timeoutMs = options.timeoutMs ?? PROFILE_DEFAULT_TIMEOUT_MS;
  const retryOnTransient = options.retryOnTransient ?? false;

  const first = await _profileOnce(accessToken, dispatcher, timeoutMs);
  if (first.kind === "ok") return first;
  if (!retryOnTransient) return first;
  if (first.kind !== "network" && first.kind !== "http_5xx") return first;

  // transient retry:sleep 一段再试一次,再失败返回第二次的结果
  await new Promise((r) => setTimeout(r, PROFILE_RETRY_DELAY_MS));
  return _profileOnce(accessToken, dispatcher, timeoutMs);
}
