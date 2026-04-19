/**
 * T-40 — Claude chat 编排器。
 *
 * 把 T-32(scheduler)、T-33(refresh + proxy)三件套组合成一个"发一次 chat 请求并流式拿回结果"
 * 的 AsyncGenerator。`/ws/chat`(流式)和 `/api/chat`(T-41,非流式)都基于这一个编排器。
 *
 * 职责边界(**关键**):
 *   ✓ 从账号池挑账号(scheduler.pick)
 *   ✓ token 即将过期 → 提前 refresh;stream 中遇 401 → refresh + 重试一次
 *   ✓ 流式拉 SSE → 转发给调用方(含 delta/usage/done/error 语义事件)
 *   ✓ 统计 usage(message_start.input + cache_* / message_delta.output)
 *   ✓ release 账号(health.onSuccess / onFailure)
 *   ✓ Buffer 生命周期:本模块 fill(0) token/refresh Buffer,调用方无需管
 *
 *   ✗ 不做 preCheck / debit / 写 usage_records —— 那是上层 handler(ws/chat.ts 或 http/chat.ts)的事
 *   ✗ 不做 per-user 连接数限制 —— 同上
 *   ✗ 不认识 JWT / 用户身份 —— 只接收 userId 用于日志
 *
 * 事件流:
 *   `meta` (1x)  → { account_id, plan }   —— stream 开始前发给调用方作为"已选中账号"标记
 *   `delta` (N)  → { text }                —— 来自 content_block_delta.delta.text
 *   `usage` (1x) → { usage, stop_reason }  —— 拼好的最终 usage + 停止原因;stream 结束前
 *   `done`  (1x) → 成功收尾
 *   `error` (1x) → 失败收尾(不抛,通过事件送达)
 *
 * 一次 runClaudeChat 调用必然以 `done` 或 `error` 中的**一个**作为最后事件。
 *
 * refresh-and-retry 语义:
 *   - pick 出来的 token 若 `shouldRefresh` → 先 refresh 再 stream
 *   - stream 中途抛 `ProxyAuthError` → refresh 同一账号 → 再 stream 一次
 *   - 第二次再 401 → 放弃,account disabled(refresh 失败时已 disable),yield error
 *   - 重试**只做一次**。refresh 本身失败(RefreshError)→ yield error,不再试
 *
 * health 统计:
 *   - 成功跑完 → scheduler.release({success})
 *   - 上游报错(非 401)或 refresh 失败 → scheduler.release({failure, error})
 *   - 401 → refresh 成功 → 不计 failure(是 token 问题不是账号问题);refresh 失败 → failure
 */

import {
  type AccountScheduler,
  AccountPoolUnavailableError,
} from "../account-pool/scheduler.js";
import {
  streamClaude as defaultStreamClaude,
  ProxyError,
  ProxyAuthError,
  type ProxyEvent,
  type ProxyDeps,
} from "../account-pool/proxy.js";
import {
  refreshAccountToken as defaultRefreshAccountToken,
  shouldRefresh,
  DEFAULT_REFRESH_SKEW_MS,
  RefreshError,
  type RefreshDeps,
} from "../account-pool/refresh.js";
import type { AccountPlan } from "../account-pool/store.js";
import type { TokenUsage } from "../billing/calculator.js";
import { AeadError } from "../crypto/aead.js";
import { ProxyAgent } from "undici";

export const ERR_ACCOUNT_POOL_UNAVAILABLE = "ERR_ACCOUNT_POOL_UNAVAILABLE";
export const ERR_REFRESH_FAILED = "ERR_REFRESH_FAILED";
export const ERR_UPSTREAM = "ERR_UPSTREAM";
export const ERR_UPSTREAM_AUTH = "ERR_UPSTREAM_AUTH";
export const ERR_ACCOUNT_BROKEN = "ERR_ACCOUNT_BROKEN";
export const ERR_INTERNAL = "ERR_INTERNAL";

export interface RunChatInput {
  /** 仅用于日志;不影响行为 */
  userId: bigint | string;
  /** agent 模式必传(sticky 需要);chat 模式无所谓 */
  sessionId?: string;
  mode: "chat" | "agent";
  /** Claude 模型 id,透传到 API body */
  model: string;
  /** Messages API body.messages(由上层保证结构) */
  messages: unknown[];
  max_tokens: number;
  /** 可选:system prompt(透传) */
  system?: string;
  /** 可选:temperature / top_p 等全部透传;未来扩展也从这里走 */
  extra?: Record<string, unknown>;
  /** 可选:取消信号 */
  signal?: AbortSignal;
}

export interface RunChatDeps {
  scheduler: AccountScheduler;
  /** 注入 proxy streamClaude(测试用);默认 account-pool/proxy.streamClaude */
  streamFn?: typeof defaultStreamClaude;
  /** 注入 refreshAccountToken(测试用);默认 account-pool/refresh.refreshAccountToken */
  refreshFn?: typeof defaultRefreshAccountToken;
  /** 透传给 streamFn 的 proxy deps(endpoint/version/fetch) */
  proxyDeps?: ProxyDeps;
  /** 透传给 refreshFn 的 deps(endpoint/http/keyFn) */
  refreshDeps?: Omit<RefreshDeps, "health">;
  /** 判 token 是否将过期的阈值;默认 5min */
  refreshSkewMs?: number;
  now?: () => Date;
  /** 可选 logger(结构化;未来接 pino) */
  logger?: ChatLogger;
}

export interface ChatLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export type ChatEvent =
  | { type: "meta"; account_id: bigint; plan: AccountPlan }
  | { type: "delta"; text: string }
  | {
      type: "usage";
      usage: TokenUsage;
      stop_reason: string | null;
    }
  | { type: "done" }
  | {
      type: "error";
      code: string;
      message: string;
      /** 仅当错误源自上游 HTTP 时填 */
      upstreamStatus?: number;
    };

interface AccountHandle {
  account_id: bigint;
  plan: AccountPlan;
  token: Buffer;
  /** 该账号专属出口代理 URL(明文,内含密码);null = 走本机出口 */
  egress_proxy: string | null;
}

/**
 * 按 egress_proxy URL 构造 undici ProxyAgent。null 输入返 null —— 调用方据此
 * 决定是否给 fetchInit 加 dispatcher 字段(给了 null 也会被 undici 当成"取消默认 dispatcher"
 * 而失败,所以宁可不加字段)。
 *
 * 每次 chat 调用单独 new + finally close —— 避免长寿 socket 被多账号串用,
 * 也避免一个账号的代理凭据轮换后,旧 dispatcher 仍在 keep-alive 池里复用旧 IP。
 * 高频场景下未来可改为按 (proxyUrl) 缓存,目前个位数账号无需。
 */
function buildDispatcher(egressProxy: string | null): ProxyAgent | null {
  if (!egressProxy) return null;
  return new ProxyAgent(egressProxy);
}

/**
 * 初始化累加器:全部 0n。后续按 SSE 事件累加。
 */
function emptyUsage(): TokenUsage {
  return {
    input_tokens: 0n,
    output_tokens: 0n,
    cache_read_tokens: 0n,
    cache_write_tokens: 0n,
  };
}

/**
 * 从 Claude SSE 事件里抽 usage 片段(宽容:字段不在就跳过)。
 *
 * - `message_start.message.usage` 提供 input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * - `message_delta.usage.output_tokens` 提供 output 增量
 *
 * Anthropic 的 usage 在 message_delta 里是 **累积值**(非增量),所以我们每次都覆盖而不是累加。
 * 文档: https://docs.anthropic.com/en/api/messages-streaming
 */
function mergeUsageFromEvent(acc: TokenUsage, ev: ProxyEvent): TokenUsage {
  const data = ev.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return acc;
  const type = typeof data.type === "string" ? data.type : "";
  if (type === "message_start") {
    const msg = data.message as Record<string, unknown> | undefined;
    const u = msg?.usage as Record<string, unknown> | undefined;
    if (u) {
      if (typeof u.input_tokens === "number") {
        acc = { ...acc, input_tokens: BigInt(u.input_tokens) };
      }
      if (typeof u.cache_read_input_tokens === "number") {
        acc = { ...acc, cache_read_tokens: BigInt(u.cache_read_input_tokens) };
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        acc = { ...acc, cache_write_tokens: BigInt(u.cache_creation_input_tokens) };
      }
    }
  } else if (type === "message_delta") {
    const u = data.usage as Record<string, unknown> | undefined;
    if (u && typeof u.output_tokens === "number") {
      acc = { ...acc, output_tokens: BigInt(u.output_tokens) };
    }
  }
  return acc;
}

/** 从 content_block_delta 抽文本;其他 delta(如 input_json_delta)暂忽略。 */
function extractDeltaText(ev: ProxyEvent): string | null {
  const data = ev.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "content_block_delta") return null;
  const delta = data.delta as Record<string, unknown> | undefined;
  if (!delta) return null;
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return null;
}

/** 从 message_delta 抽 stop_reason。 */
function extractStopReason(ev: ProxyEvent): string | null {
  const data = ev.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "message_delta") return null;
  const delta = data.delta as Record<string, unknown> | undefined;
  return typeof delta?.stop_reason === "string" ? delta.stop_reason : null;
}

/**
 * 构造上游 Messages API body。我们不 mutate 调用方的对象;把关键字段直接拼一份。
 * `stream` 被 streamClaude 强制置 true,这里不管。
 */
function buildClaudeBody(input: RunChatInput): Record<string, unknown> {
  const b: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.max_tokens,
    messages: input.messages,
  };
  if (input.system) b.system = input.system;
  if (input.extra) {
    for (const [k, v] of Object.entries(input.extra)) {
      // 不允许覆写 model/max_tokens/messages/system/stream
      if (k === "model" || k === "max_tokens" || k === "messages" || k === "system" || k === "stream") continue;
      b[k] = v;
    }
  }
  return b;
}

/**
 * 主入口。调用模式:
 *
 * ```
 * for await (const ev of runClaudeChat(input, deps)) {
 *   if (ev.type === "delta") ws.send(ev.text);
 *   else if (ev.type === "usage") finalUsage = ev.usage;
 *   else if (ev.type === "error") ws.sendError(ev);
 *   else if (ev.type === "done") break;
 * }
 * ```
 *
 * 不 throw —— 所有失败都以 `error` 事件告知。这样调用方不用分别处理
 * 同步/异步错误路径。唯一例外:`TypeError` 的参数错(mode 非法等)会向上传 ——
 * 那是调用方代码 bug,不应该吞。
 */
export async function* runClaudeChat(
  input: RunChatInput,
  deps: RunChatDeps,
): AsyncGenerator<ChatEvent, void, void> {
  const streamFn = deps.streamFn ?? defaultStreamClaude;
  const refreshFn = deps.refreshFn ?? defaultRefreshAccountToken;
  const now = deps.now ?? ((): Date => new Date());
  const skew = deps.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const logger = deps.logger;
  const claudeBody = buildClaudeBody(input);

  // 1) pick
  let handle: AccountHandle;
  let refreshBuffer: Buffer | null = null;
  let expiresAt: Date | null;
  try {
    const picked = await deps.scheduler.pick({
      mode: input.mode,
      sessionId: input.sessionId,
      model: input.model,
    });
    handle = {
      account_id: picked.account_id,
      plan: picked.plan,
      token: picked.token,
      egress_proxy: picked.egress_proxy,
    };
    refreshBuffer = picked.refresh;
    expiresAt = picked.expires_at;
    logger?.info("chat.pick.ok", {
      userId: String(input.userId),
      account_id: String(picked.account_id),
      plan: picked.plan,
      egress_proxied: picked.egress_proxy !== null,
    });
  } catch (err) {
    if (err instanceof AccountPoolUnavailableError) {
      yield { type: "error", code: ERR_ACCOUNT_POOL_UNAVAILABLE, message: err.message };
      return;
    }
    if (err instanceof AeadError) {
      // 密文损坏 —— scheduler 的 pick 里会抛 AeadError 而不是 null;上层应 disable
      logger?.error("chat.pick.aead_error", { error: String(err) });
      yield { type: "error", code: ERR_ACCOUNT_BROKEN, message: "account token decryption failed" };
      return;
    }
    // 其他异常(DB 断链、query 炸):视作内部错误
    logger?.error("chat.pick.internal", { error: String(err) });
    yield { type: "error", code: ERR_INTERNAL, message: "internal error during account pick" };
    return;
  }

  // 2) 可选 refresh(即将过期)
  //
  // release kind 说明:
  //   - "success": 账号正常服务了本次请求 → health onSuccess(重置失败计数)
  //   - "failure": 账号确实出问题(401 两次、refresh 失败、429 rate-limit)→ onFailure(升级计数)
  //   - "neutral": 错误不归因到此账号(上游 5xx、网络断、客户端 abort、bad request)→ 什么都不做,
  //                保持原有 health 状态。avoids 把"客户端主动断" 误算成账号故障
  const release = async (
    kind: "success" | "failure" | "neutral",
    errMsg?: string,
  ): Promise<void> => {
    if (kind === "neutral") return;
    try {
      await deps.scheduler.release({
        account_id: handle.account_id,
        result: kind === "success" ? { kind: "success" } : { kind: "failure", error: errMsg ?? null },
      });
    } catch (err) {
      logger?.warn("chat.release.failed", { error: String(err), account_id: String(handle.account_id) });
    }
  };

  /**
   * 错误是否归咎到当前账号。保守策略:只有"显式 account-scoped 信号"才算 failure,
   * 其他一律 neutral(保持 health 不动)。
   *   - AbortError / signal.aborted → neutral
   *   - ProxyError 5xx / 网络 → neutral(Claude 全局问题或链路抖动)
   *   - ProxyError 429 → account-scoped rate-limit,failure
   *   - ProxyError 4xx(非 401/429)→ neutral(请求构造问题,与账号无关)
   *   - ProxyAuthError 第一次 → 由调用方决定 refresh(不经过这里);二次 401 → failure
   *   - RefreshError / AeadError → failure(已显式标示 token 坏)
   *   - 其他非 ProxyError 异常 → neutral(避免把 bug 当账号问题)
   */
  function classifyError(err: unknown, signal?: AbortSignal): "failure" | "neutral" {
    if (signal?.aborted) return "neutral";
    if (err instanceof Error && (err.name === "AbortError" || err.name === "DOMException" && err.message.includes("aborted"))) {
      return "neutral";
    }
    if (err instanceof ProxyAuthError) return "failure"; // 401 after refresh
    if (err instanceof ProxyError) {
      if (err.status === 429) return "failure";
      return "neutral";
    }
    if (err instanceof AeadError) return "failure";
    if (err instanceof RefreshError) return "failure";
    return "neutral";
  }
  void classifyError; // 预留给后面的错误路径使用
  const cleanupBuffers = (): void => {
    try { handle.token.fill(0); } catch { /* */ }
    if (refreshBuffer) {
      try { refreshBuffer.fill(0); } catch { /* */ }
      refreshBuffer = null;
    }
  };

  // 构造该账号的出口 dispatcher(如配)。proxy/refresh 共用同一个,finally 统一关。
  const dispatcher = buildDispatcher(handle.egress_proxy);
  const proxyDepsForCall: ProxyDeps = dispatcher
    ? { ...(deps.proxyDeps ?? {}), dispatcher }
    : (deps.proxyDeps ?? {});
  const refreshDepsForCall: Omit<RefreshDeps, "health"> = dispatcher
    ? { ...(deps.refreshDeps ?? {}), dispatcher }
    : (deps.refreshDeps ?? {});
  const closeDispatcher = async (): Promise<void> => {
    if (!dispatcher) return;
    try { await dispatcher.close(); }
    catch (err) { logger?.warn("chat.dispatcher.close_failed", { error: String(err) }); }
  };

  try {
    if (shouldRefresh(expiresAt, now(), skew)) {
      logger?.info("chat.refresh.preemptive", {
        account_id: String(handle.account_id),
        expires_at: expiresAt?.toISOString() ?? null,
      });
      const rfOk = await tryRefresh(handle, refreshFn, refreshDepsForCall);
      if (!rfOk.ok) {
        // refresh 失败:refreshAccountToken 内部已 disable 账号,这里只需报错 + release
        await release("failure", `refresh failed: ${rfOk.code}`);
        cleanupBuffers();
        yield { type: "error", code: ERR_REFRESH_FAILED, message: rfOk.message };
        return;
      }
      // 替换 token 引用
      cleanupBuffers_oldToken(handle);
      handle.token = rfOk.token;
      if (refreshBuffer) { try { refreshBuffer.fill(0); } catch { /* */ } }
      refreshBuffer = rfOk.refresh;
    }

    yield { type: "meta", account_id: handle.account_id, plan: handle.plan };

    // 3) stream(含 401 重试一次)
    const stream1 = streamAttempt(streamFn, handle.token, claudeBody, proxyDepsForCall, input.signal);
    let usage = emptyUsage();
    let stopReason: string | null = null;
    let gotAuthError = false;

    try {
      for await (const ev of stream1) {
        const text = extractDeltaText(ev);
        if (text !== null) {
          yield { type: "delta", text };
        }
        usage = mergeUsageFromEvent(usage, ev);
        const sr = extractStopReason(ev);
        if (sr !== null) stopReason = sr;
      }
    } catch (err) {
      if (err instanceof ProxyAuthError) {
        gotAuthError = true;
      } else if (err instanceof ProxyError) {
        const msg = err.message.length > 0 ? err.message : "upstream error";
        await release(classifyError(err, input.signal), `upstream ${err.status}`);
        cleanupBuffers();
        yield {
          type: "error",
          code: ERR_UPSTREAM,
          message: msg,
          upstreamStatus: err.status,
        };
        return;
      } else {
        // 网络/abort/其他:按 classifyError 决定。client abort / 链路抖不归账号。
        await release(classifyError(err, input.signal), "stream runtime error");
        cleanupBuffers();
        yield { type: "error", code: ERR_INTERNAL, message: `stream error: ${String(err)}` };
        return;
      }
    }

    if (gotAuthError) {
      // 401 → refresh + retry 一次
      logger?.info("chat.auth_error.refresh_retry", { account_id: String(handle.account_id) });
      const rfOk = await tryRefresh(handle, refreshFn, refreshDepsForCall);
      if (!rfOk.ok) {
        await release("failure", `refresh_after_401: ${rfOk.code}`);
        cleanupBuffers();
        yield { type: "error", code: ERR_REFRESH_FAILED, message: rfOk.message };
        return;
      }
      cleanupBuffers_oldToken(handle);
      handle.token = rfOk.token;
      if (refreshBuffer) { try { refreshBuffer.fill(0); } catch { /* */ } }
      refreshBuffer = rfOk.refresh;

      usage = emptyUsage();
      stopReason = null;
      const stream2 = streamAttempt(streamFn, handle.token, claudeBody, proxyDepsForCall, input.signal);
      try {
        for await (const ev of stream2) {
          const text = extractDeltaText(ev);
          if (text !== null) {
            yield { type: "delta", text };
          }
          usage = mergeUsageFromEvent(usage, ev);
          const sr = extractStopReason(ev);
          if (sr !== null) stopReason = sr;
        }
      } catch (err) {
        if (err instanceof ProxyAuthError) {
          // 第二次再 401:放弃(refresh 刚成功还是被拒,账号层面有问题)
          await release("failure", "upstream_401_after_refresh");
          cleanupBuffers();
          yield {
            type: "error",
            code: ERR_UPSTREAM_AUTH,
            message: "upstream returned 401 even after token refresh",
            upstreamStatus: 401,
          };
          return;
        }
        if (err instanceof ProxyError) {
          await release(classifyError(err, input.signal), `upstream ${err.status}`);
          cleanupBuffers();
          yield {
            type: "error",
            code: ERR_UPSTREAM,
            message: err.message,
            upstreamStatus: err.status,
          };
          return;
        }
        await release(classifyError(err, input.signal), "stream runtime error after refresh");
        cleanupBuffers();
        yield { type: "error", code: ERR_INTERNAL, message: `stream error: ${String(err)}` };
        return;
      }
    }

    yield { type: "usage", usage, stop_reason: stopReason };
    yield { type: "done" };
    await release("success");
  } finally {
    cleanupBuffers();
    await closeDispatcher();
  }
}

/**
 * 辅助:保留 handle.token 的旧引用以便 caller 置零后再替换新 token。
 * 单独抽出是为了让循环里"换 token 前清旧"这步不被遗忘。
 */
function cleanupBuffers_oldToken(handle: AccountHandle): void {
  try { handle.token.fill(0); } catch { /* */ }
}

function streamAttempt(
  streamFn: typeof defaultStreamClaude,
  token: Buffer,
  body: Record<string, unknown>,
  proxyDeps: ProxyDeps | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<ProxyEvent, void, void> {
  return streamFn(
    { account: { token }, body, signal },
    proxyDeps ?? {},
  );
}

interface RefreshOk {
  ok: true;
  token: Buffer;
  refresh: Buffer | null;
}
interface RefreshFail {
  ok: false;
  code: string;
  message: string;
}

async function tryRefresh(
  handle: AccountHandle,
  refreshFn: typeof defaultRefreshAccountToken,
  refreshDeps: Omit<RefreshDeps, "health"> | undefined,
): Promise<RefreshOk | RefreshFail> {
  try {
    const rf = await refreshFn(handle.account_id, refreshDeps ?? {});
    return { ok: true, token: rf.token, refresh: rf.refresh };
  } catch (err) {
    if (err instanceof RefreshError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: "unknown", message: String(err) };
  }
}
