/**
 * V3 Phase 3 — Upstream session 抽象。
 *
 * 物理切出自 http/anthropicProxy.ts(2026-05-18 V3_ANTHROPIC_PROXY_SPLIT_PLAN §3.4 / §5.4 / §6.3)。
 *
 * 把 handler 主流程里"upstream 选择 + dispatcher + refresh + 头注入 + body sanitize +
 * device_id pin + token 零化"等散落跨度收敛进:
 *
 *   - `selectUpstreamRoute(model)`     —— preCheck 前的纯路由判定(deepseek vs oauth)
 *   - `validateUpstreamConfig(...)`    —— preCheck 前的轻校验(deepseek api key 缺失)
 *   - `pickAccountForUpstream(...)`    —— V3 envv2 Phase 4(2026-05-21,Codex code-review
 *     FAIL #1 采纳)两阶段第一段:**只** scheduler.pick(不 refresh / 不 dispatcher)。
 *     normalize/preCheck 在两阶段之间运行 — v2 normalize 需要 account_id + salt,
 *     但 InsufficientCredits 用户不该触发 OAuth refresh 副作用。
 *   - `prepareUpstreamSession(...)`    —— 两阶段第二段:接 AccountCtx → dispatcher
 *     + (按需) refresh → PreparedUpstreamSession;失败本函数内部 release + zeroize。
 *   - `pickUpstream(deps, body, route, log)` —— backward-compat wrapper,直接串两阶段;
 *     既有单测 + handler 早期路径仍可用,但 normalize/preCheck 在两阶段之间的场景必须
 *     直接用 `pickAccountForUpstream` + `prepareUpstreamSession`(见 handler index.ts)。
 *   - `PreparedUpstreamSession`        —— 完整 session 接口,两实现:OAuth pool / DeepSeek
 *   - `releaseUpstreamSession(...)`    —— **仅** finalizer 创建前的 case (c) 补偿
 *
 * Release ownership(plan §5.4 4 段铁律 → Phase 4 拆两阶段后扩):
 *   (a) pickAccount 自身失败                   → 不调 release(无 account)
 *   (a.5) pickAccount 成功 / prepareSession 前(normalize/preCheck 期间)失败
 *                                              → **handler finally** 调 scheduler.release
 *                                                (kind: failure / client_error 视错因)
 *                                                + 直接 fill(0) pick.token / pick.refresh
 *   (b₁) prepareSession 内 refresh 失败        → 本模块内部 release(transient_network|failure)
 *   (b₂) prepareSession 内 dispatcher / 其他 throw → 本模块内部 release(failure)
 *   (c) session 已 ready 但 finalizer 建立前    → handler 调 releaseUpstreamSession(...)
 *   (d) finalizer 已建立                       → release 唯一权归 finalizer
 *
 * Secret hygiene:
 *   - refresh 成功时,**老** pick.token / pick.refresh 立即 fill(0)
 *   - 任何 (b) 失败路径,upstream 层在 release 后 fill(0)
 *   - handler finally 调 session.zeroizeSecrets() 处理 **新** pick(refresh 后的)的 token / refresh
 *   - DeepSeek session zeroizeSecrets 是 noop(apiKey 来自配置注入,不归 session)
 *   - zeroizeSecrets 幂等(内部 zeroized flag)
 *
 * Phase 3 不引 ProxyCore;`releaseUpstreamSession` 是自由函数,Phase 4 会 wrap 进
 * `ProxyCore.releaseBeforeFinalizer`。"仅 finalizer 前窗口"的硬约束直接 carry over。
 */

import type { Dispatcher } from "undici";

import type { Logger } from "../../logging/logger.js";
import { errMessageShort, errSummary } from "../util.js";
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  type AccountScheduler,
  type PickResult,
} from "../../account-pool/scheduler.js";
import type { AccountKind } from "../../account-pool/store.js";
import {
  shouldRefresh,
  refreshAccountToken,
  RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
} from "../../account-pool/refresh.js";
import { getDispatcherForAccount } from "../../account-pool/egressDispatcher.js";
import {
  DEFAULT_UPSTREAM_ENDPOINT,
  DEEPSEEK_UPSTREAM_ENDPOINT,
  isDeepseekModel,
  extractSessionId,
  rewriteMetadataDeviceId,
  stripMalformedThinkingBlocks,
  type ProxyBody,
} from "./shared.js";

// ─── 路由决策 + 早拒绝 ────────────────────────────────────────────────────────

export type UpstreamRoute =
  | { kind: "oauth" }
  | { kind: "deepseek" };

/**
 * 纯函数,基于 model 决定走哪条 upstream。**preCheck 前**调用。
 *
 * isDeepseekModel(model) 命中 → deepseek;否则 oauth。当前没有 third route。
 */
export function selectUpstreamRoute(model: string): UpstreamRoute {
  return isDeepseekModel(model) ? { kind: "deepseek" } : { kind: "oauth" };
}

/**
 * 路由配置错误。当前只有一种:deepseek model 但部署未配 `DEEPSEEK_API_KEY`。
 *
 * handler 拿到后映射:503 + `proxy_deepseek_not_configured` log + reject `deepseek_config` metric。
 */
export type ConfigError = { kind: "deepseek_not_configured" };

/**
 * preCheck **前**调:路由级早拒绝。返回 null 表示该路由当前部署可走。
 *
 * 行为锁(对应原 handler L1262-1272):deepseek 缺 key 必须**在 preCheck 之前**返回,
 * 不能让请求先 reserve credits 再 rollback。
 */
export function validateUpstreamConfig(
  route: UpstreamRoute,
  deps: { deepseekApiKey?: string },
): ConfigError | null {
  if (route.kind === "deepseek" && !deps.deepseekApiKey) {
    return { kind: "deepseek_not_configured" };
  }
  return null;
}

// ─── PreparedUpstreamSession ──────────────────────────────────────────────────

/**
 * `pickUpstream` 成功返回后的完整 upstream 会话。
 *
 * 副作用契约:
 *   - `applyUpstreamAuth` mutate `safeHeaders` + `body.metadata`(in-place,与原 handler 字节等价)
 *   - `sanitizeMessages` 不 mutate 入参,返回新数组(strip 时)或原 ref(无 strip 时)
 *   - `zeroizeSecrets` mutate 内部持有的 token / refresh Buffer,idempotent
 */
export interface PreparedUpstreamSession {
  /** account_pool account_id;`null` = DeepSeek 路径(无 OAuth 池) */
  readonly accountId: bigint | null;
  /** 反风控锚定 device_id;`null` = DeepSeek */
  readonly pinnedUserId: string | null;
  /** 上游 URL;OAuth = `deps.upstreamEndpoint ?? DEFAULT`;DeepSeek = `DEEPSEEK_UPSTREAM_ENDPOINT` */
  readonly endpoint: string;
  /** undici dispatcher;OAuth 绑账号 egress IP;DeepSeek = undefined(默认出口) */
  readonly dispatcher: Dispatcher | undefined;
  /** 上游响应是否值得抓 quota(OAuth=true;DeepSeek=false) */
  readonly shouldUpdateQuotaFromResponse: boolean;
  /**
   * V3 envv2 Phase 4(2026-05-21):outbound envelope 版本派发位。
   * OAuth pool 路径 = `pick.envelope_version`(prod default 1,boss 手动 UPDATE 灰度到 2);
   * DeepSeek 路径 = 1(handler 在 DeepSeek 路径下不调任何 envelope normalizer,字段值实际不读)。
   */
  readonly envelopeVersion: number;
  /**
   * V3 envv2 Phase 4(2026-05-21):v2 normalize 派生输入。
   * OAuth pool 路径 = `pick.fingerprint_salt`(16 byte BYTEA);
   * DeepSeek 路径 = `null`。handler 派发 v2 时,必须先验 envelopeVersion === 2 && fingerprintSalt !== null
   * 再调 normalize(防数据异常 — schema 已约束 NOT NULL,但兜底保好习惯)。
   */
  readonly fingerprintSalt: Buffer | null;
  /**
   * V3 envv2 Phase 4(2026-05-21):account.id 的 string 形式。v2 normalize 入参签名要 string
   * (sha256 输入要稳定的字节序);accountId 是 bigint | null,这里给 string seam 让 handler
   * 不必在站现 toString。OAuth 路径 = `pick.account_id.toString()`;DeepSeek 路径 = ""(空串
   * 实际不读)。
   */
  readonly accountIdStr: string;

  /**
   * 写入 Authorization + Anthropic beta 头 + (OAuth)body.metadata.user_id device_id pin。
   *
   * OAuth:
   *   - `safeHeaders.authorization = Bearer ${pick.token utf8}`
   *   - `anthropic-beta` merge `oauth-2025-04-20`(允许多 token 共存,不覆盖)
   *   - `body.metadata.user_id` rewrite via `rewriteMetadataDeviceId`(pinned hex 合法时);
   *     pinned schema breach 时 fail-open + log.warn `pinned_user_id_invariant_breach`。
   *
   * DeepSeek:
   *   - `safeHeaders.authorization = Bearer ${deepseekApiKey}`
   *   - `delete safeHeaders["anthropic-beta"]`(DeepSeek 兼容端点不识别该头)
   *   - 不动 body.metadata
   *
   * @param safeHeaders 已经过 `buildSafeUpstreamHeaders` 白名单的 fetch headers,mutate in-place
   * @param body fetch body 的解析后视图;OAuth path 可能 mutate `body.metadata`
   * @param log scoped logger(uid/containerId 等已 child)
   */
  applyUpstreamAuth(
    safeHeaders: Record<string, string>,
    body: ProxyBody,
    log: Logger,
  ): void;

  /**
   * 对历史 messages 做上游特定 sanitize。
   *
   * OAuth:`stripMalformedThinkingBlocks` 清掉 signature 不足的 thinking / redacted_thinking
   *        block(Anthropic 风控会拒)。strip > 0 → log.warn `proxy_malformed_thinking_blocks_stripped`。
   * DeepSeek:返回原引用(DeepSeek 兼容端点不校验 Anthropic signature,strip 无收益)。
   */
  sanitizeMessages(messages: unknown[], model: string, log: Logger): unknown[];

  /**
   * 零化所有内存中的 secret。**idempotent** —— handler finally 必调一次,refresh/release
   * 失败路径上游层也会调,二次调用安全。
   *
   * OAuth:`pick.token.fill(0)` + `pick.refresh?.fill(0)`(若 refresh 不为 null)。
   * DeepSeek:noop(`deepseekApiKey` 是配置注入,生命周期归配置不归 session)。
   */
  zeroizeSecrets(): void;
}

// ─── PickError + Deps ─────────────────────────────────────────────────────────

/**
 * pickUpstream 失败模式。handler 一对一映射到状态码/log/metric:
 *
 * - `pool_busy`            → 429 ACCOUNT_POOL_BUSY     reject `account_pool_busy`
 * - `pool_unavailable`     → 503 ACCOUNT_POOL_UNAVAILABLE reject `account_pool`
 * - `refresh_failed`       → 502 UPSTREAM_AUTH_REFRESH_FAILED reject `upstream_auth`
 * - `preparation_failed`   → 502 UPSTREAM_PREPARATION_FAILED  reject `upstream_auth`
 *
 * release 已在 upstream 层 fire(case b₁/b₂),handler 只做 preCheck rollback + 错误响应。
 * pool_busy / pool_unavailable(case a)无 account 持有,release 自然不调。
 */
export type PickError =
  | { kind: "pool_busy"; err: AccountPoolBusyError }
  | { kind: "pool_unavailable"; err: AccountPoolUnavailableError }
  | { kind: "refresh_failed"; transient: boolean; err: unknown }
  | { kind: "preparation_failed"; err: unknown };

export interface PickUpstreamDeps {
  scheduler: Pick<AccountScheduler, "pick" | "release">;
  /** refreshAccountToken 内部 http+pg 依赖。undefined → 即使到期也不刷(测试场景)。 */
  refreshDeps?: RefreshDeps;
  /** DeepSeek 静态 API key;production 由 wiring 从 config 注入。OAuth route 不消费。 */
  deepseekApiKey?: string;
  /** OAuth 上游 URL 覆盖;undefined → DEFAULT_UPSTREAM_ENDPOINT。测试 seam。 */
  upstreamEndpoint?: string;
  /**
   * Dispatcher 工厂 test seam(同 Phase 2 recordHostRequest 模式)。
   * Production wiring **不**注入,upstream 层走默认 `getDispatcherForAccount`,
   * 该函数有模块级 dispatcher cache。测试注入 stub 避免 cache 污染 + 验证 dispatcher
   * 真的被传给 refreshAccountToken(HIGH#5 同出口锚定)。
   */
  getDispatcher?: typeof getDispatcherForAccount;
  /**
   * refreshAccountToken test seam。Production wiring **不**注入,upstream 层走默认
   * `refreshAccountToken`(内部要 PG + KMS,unit test 拉这套依赖代价过高)。
   *
   * 仅测试场景注入:用于直接验证"upstream 层在 refresh 成功/transient/non-transient
   * 各分支下的协调行为"(release kind / token zeroization / dispatcher 覆盖),
   * 不再耦合到真实 refresh 实现的 DB / KMS / OAuth http 细节(那是 refresh.ts 自己的
   * unit/integ 责任)。
   *
   * 真实 refresh 行为本身由 refresh.ts 的测试覆盖,本 seam 只验"调用边界"。
   */
  refreshAccountTokenImpl?: typeof refreshAccountToken;
}

// ─── 内部工厂 ──────────────────────────────────────────────────────────────────
//
// 这两个工厂**不导出** —— production 只通过 pickUpstream 拿到 session,test 内部 import
// 也走 pickUpstream(plan Codex round 1 反馈:测试覆盖统一走 pickUpstream,避免测试触达
// 内部工厂导致"抽象信号"与"被测内部"边界混淆)。

function makeDeepSeekUpstream(apiKey: string): PreparedUpstreamSession {
  return {
    accountId: null,
    pinnedUserId: null,
    endpoint: DEEPSEEK_UPSTREAM_ENDPOINT,
    dispatcher: undefined,
    shouldUpdateQuotaFromResponse: false,
    // V3 envv2 Phase 4:DeepSeek 不走 envelope normalizer,值为占位且 handler 不读。
    envelopeVersion: 1,
    fingerprintSalt: null,
    accountIdStr: "",
    applyUpstreamAuth(safeHeaders, _body, _log) {
      safeHeaders.authorization = `Bearer ${apiKey}`;
      delete safeHeaders["anthropic-beta"];
    },
    sanitizeMessages(messages, _model, _log) {
      return messages;
    },
    zeroizeSecrets() {
      /* noop: deepseekApiKey 来自配置注入,不归 session */
    },
  };
}

function makeOAuthPoolUpstream(
  pick: PickResult,
  dispatcher: Dispatcher | undefined,
  endpoint: string,
): PreparedUpstreamSession {
  // 注意 `pick` 通过闭包持有;refresh 成功后 pickUpstream 内部 **rebind** 旧引用
  // 已经被 fill(0) → 这里持有的就是新 buffer。zeroizeSecrets idempotent 由 flag 守。
  let zeroized = false;
  return {
    accountId: pick.account_id,
    pinnedUserId: pick.pinned_user_id,
    endpoint,
    dispatcher,
    shouldUpdateQuotaFromResponse: true,
    // V3 envv2 Phase 4(2026-05-21):outbound envelope 派发位 + 派生 salt + accountId 字符串形。
    // pick.envelope_version 由 0070 migration NOT NULL DEFAULT 1,boss 手动 UPDATE 灰度到 2。
    // pick.fingerprint_salt 由 0072 migration NOT NULL DEFAULT gen_random_bytes(16),v2 normalizer
    // 用其作 sha256 prefix(同账号跨进程稳定、跨账号不可关联)。
    envelopeVersion: pick.envelope_version,
    fingerprintSalt: pick.fingerprint_salt,
    accountIdStr: pick.account_id.toString(),
    applyUpstreamAuth(safeHeaders, body, log) {
      // (i) Bearer
      safeHeaders.authorization = `Bearer ${pick.token.toString("utf8")}`;
      // (ii) anthropic-beta merge "oauth-2025-04-20"
      const existing = (safeHeaders["anthropic-beta"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!existing.includes("oauth-2025-04-20")) existing.unshift("oauth-2025-04-20");
      safeHeaders["anthropic-beta"] = existing.join(",");
      // (iii) device_id pin —— pinned_user_id 由 0067 migration schema 强约束;
      //       breach 时 fail-open 不阻塞请求(运维介入修脏数据)。
      const pinned = pick.pinned_user_id;
      if (typeof pinned === "string" && /^[0-9a-f]{64}$/.test(pinned)) {
        body.metadata ??= {};
        body.metadata.user_id = rewriteMetadataDeviceId(body.metadata.user_id, pinned);
      } else {
        log.warn("pinned_user_id_invariant_breach", {
          account_id: pick.account_id.toString(),
          pinned_type: typeof pinned,
        });
      }
    },
    sanitizeMessages(messages, model, log) {
      const r = stripMalformedThinkingBlocks(messages);
      if (r.thinkingStripped + r.redactedThinkingStripped > 0) {
        log.warn("proxy_malformed_thinking_blocks_stripped", {
          model,
          thinking: r.thinkingStripped,
          redactedThinking: r.redactedThinkingStripped,
        });
      }
      return r.messages;
    },
    zeroizeSecrets() {
      if (zeroized) return;
      zeroized = true;
      try {
        pick.token.fill(0);
      } catch {
        /* ignore */
      }
      try {
        pick.refresh?.fill(0);
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── pickAccountForUpstream + prepareUpstreamSession(两阶段拆分)─────────────
//
// V3 envv2 Phase 4 (2026-05-21,Codex code-review FAIL #1 采纳):pickUpstream 拆成
// 两阶段。动机:v2 envelope normalize 需要 account.fingerprint_salt + account.id,
// 但**不需要**已 refresh 的 token / dispatcher;同时 InsufficientCredits 用户不应
// 触发 OAuth refresh 副作用(DB write + http endpoint call + 401 时账号被错误扣健康分)。
//
// 拆分:
//   - `pickAccountForUpstream`:scheduler.pick → AccountCtx(static metadata only,
//     **不**做 refresh / dispatcher)。失败转 PickError(pool_busy / pool_unavailable),
//     无 account 持有,无副作用。
//   - `prepareUpstreamSession`:接 AccountCtx → 跑 dispatcher / refresh →
//     PreparedUpstreamSession。任何失败本函数内部 release + zeroize 旧 pick,转 PickError。
//
// Handler 顺序:
//   pickAccountForUpstream → envelope normalize → preCheck → prepareUpstreamSession
//
//   ↑ normalize/preCheck 之间任何 throw,handler 负责调 scheduler.release(account_id, ...)
//     + zero pick.token / refresh —— 不调 refresh,无 token 旋转,只是把账号 inflight 退回。
//   ↑ prepareUpstreamSession 失败 → 本函数内部已 release + zeroize,handler 不再操作 pool。
//
// `pickUpstream` 作为既有 production callers / 不需要两阶段的测试场景兜底,委托给两阶段。

/**
 * V3 envv2 Phase 1.5 (2026-05-21):pickAccountForUpstream / pickUpstream 共享 options。
 *
 * 目前唯一字段 `accountKind` 由 handler 在外接 ApiKey + OAuth upstream 路径上注入
 * `'external_api'`,其它路径(容器 / DeepSeek)不传 → scheduler 走 default 'platform'
 * 与历史等价。
 */
export interface PickUpstreamOptions {
  /** 账号池分区(0070 / Phase 1.5)。undefined → scheduler default 'platform' 池。 */
  accountKind?: AccountKind;
}

/**
 * V3 envv2 Phase 4(2026-05-21):pickAccountForUpstream 输出的 account context。
 *
 * - `kind: 'oauth'`:OAuth pool 路径,持有 PickResult(account_id / salt / version / token / ...)
 *   handler 拿到此 ctx 时,scheduler.pick 已 fire(inflight+1),release ownership 在 handler。
 *   pick.token 此刻是 DB 原始值(可能已过期),**未** refresh。
 * - `kind: 'deepseek'`:DeepSeek 路径,无 pool 状态。release 是 noop。
 *
 * 用途:handler 在 prepareUpstreamSession 之前需要的字段(envelope normalize 用 salt /
 * account_id / envelope_version / pinned_user_id)全部从这里取。
 */
export type AccountCtx =
  | { kind: "oauth"; pick: PickResult }
  | { kind: "deepseek" };

/**
 * 阶段 1:account 选号(scheduler.pick),**不**做 refresh / dispatcher。
 *
 * 失败模式(对应 PickError 的 pool_busy / pool_unavailable):无 account 持有,handler
 * 无需 release。其它非预期 throw → 上抛交给 handler 500 兜底。
 *
 * 成功后 handler 持有 ctx + release ownership;直到 prepareUpstreamSession 成功
 * (release 移交给 session)、或显式调 scheduler.release(account_id, ...)。
 */
export async function pickAccountForUpstream(
  deps: PickUpstreamDeps,
  body: ProxyBody,
  route: UpstreamRoute,
  _log: Logger,
  opts?: PickUpstreamOptions,
): Promise<
  | { ok: true; ctx: AccountCtx }
  | { ok: false; error: PickError }
> {
  if (route.kind === "deepseek") {
    return { ok: true, ctx: { kind: "deepseek" } };
  }
  // OAuth path —— scheduler.pick(只选号,不 refresh)。
  let pick: PickResult;
  try {
    pick = await deps.scheduler.pick({
      mode: "chat",
      sessionId: extractSessionId(body.metadata) ?? undefined,
      model: body.model,
      kind: opts?.accountKind,
    });
  } catch (err) {
    if (err instanceof AccountPoolBusyError) {
      return { ok: false, error: { kind: "pool_busy", err } };
    }
    if (err instanceof AccountPoolUnavailableError) {
      return { ok: false, error: { kind: "pool_unavailable", err } };
    }
    throw err; // unknown — handler 外层 500
  }
  return { ok: true, ctx: { kind: "oauth", pick } };
}

/**
 * 阶段 2:基于 AccountCtx 跑 dispatcher + refresh,组装 PreparedUpstreamSession。
 *
 * 失败模式(refresh_failed / preparation_failed):**本函数内部** scheduler.release
 * + zero 旧 pick.token / refresh,然后转 PickError 返回。Handler 看到这里失败时,
 * 既无 token 也无 inflight 残留,只需把 release ownership flag 翻掉。
 *
 * DeepSeek 路径:直接合成 makeDeepSeekUpstream,无 pool 访问、无 refresh。
 */
export async function prepareUpstreamSession(
  deps: PickUpstreamDeps,
  ctx: AccountCtx,
  log: Logger,
): Promise<
  | { ok: true; session: PreparedUpstreamSession }
  | { ok: false; error: PickError }
> {
  if (ctx.kind === "deepseek") {
    return { ok: true, session: makeDeepSeekUpstream(deps.deepseekApiKey ?? "") };
  }
  let pick = ctx.pick;
  // pick 后到 session 返回前 —— 整段单一 preparation guard。
  // (b₁) refresh 失败有专属 catch:release kind 区分 transient/failure。
  // (b₂) dispatcher 或其他 preparation throw —— outer guard 统一 release(failure)。
  try {
    const getDispatcher = deps.getDispatcher ?? getDispatcherForAccount;
    const dispatcher = await getDispatcher(
      pick.account_id,
      pick.egress_proxy,
      pick.egress_target,
    );

    if (
      deps.refreshDeps &&
      pick.expires_at &&
      shouldRefresh(pick.expires_at, new Date(), DEFAULT_REFRESH_SKEW_MS)
    ) {
      try {
        // HIGH#5:同 account 的 chat 与 refresh 必须从同一出口 IP 出去 —— 显式覆盖
        // refreshDeps.dispatcher,即使 caller 塞了别的 dispatcher 也用 account 固定出口。
        const refreshImpl = deps.refreshAccountTokenImpl ?? refreshAccountToken;
        const r = await refreshImpl(pick.account_id, {
          ...deps.refreshDeps,
          dispatcher,
        });
        // 释放老 token(零化),用新 token rebind pick(闭包持有的是 const 局部变量,
        // 这里 reassign 后续 makeOAuthPoolUpstream 闭包就抓到 new)。
        try {
          pick.token.fill(0);
        } catch {
          /* ignore */
        }
        try {
          pick.refresh?.fill(0);
        } catch {
          /* ignore */
        }
        pick = {
          account_id: pick.account_id,
          plan: pick.plan,
          token: r.token,
          refresh: r.refresh,
          expires_at: r.expires_at,
          egress_proxy: pick.egress_proxy,
          egress_target: pick.egress_target,
          pinned_user_id: pick.pinned_user_id,
          // V3 envv2 Phase 4:envelope_version + fingerprint_salt 是 account 静态属性,
          // 跨 refresh 不变,从老 pick 透传(refresh 不返回这两字段,SELECT 它们是 scheduler 责任)。
          envelope_version: pick.envelope_version,
          fingerprint_salt: pick.fingerprint_salt,
        };
      } catch (err) {
        // (b₁) refresh 失败:
        //   - network_transient(#H9):纯网络抖动,不扣健康分,仅 dec inflight
        //   - 其它(http_error / bad_response / persist_error / 未知):failure 扣分
        const isTransient =
          err instanceof RefreshError && err.code === "network_transient";
        log.warn("proxy_refresh_failed", {
          accountId: pick.account_id.toString(),
          code: err instanceof RefreshError ? err.code : "unknown",
          msg: err instanceof Error ? err.message : String(err),
          transient: isTransient,
        });
        await deps.scheduler
          .release({
            account_id: pick.account_id,
            result: isTransient
              ? { kind: "transient_network", error: errMessageShort(err) }
              : { kind: "failure", error: errMessageShort(err) },
          })
          .catch((relErr) => {
            // best-effort:补偿失败不能覆盖主错误(refresh_failed),否则丢 ReleaseError
            // diagnose 不出来。warn 一下让 inflight 泄漏或 release 后端故障可观测。
            log.warn("proxy_release_account_failed", {
              stage: "refresh_fail",
              accountId: pick.account_id.toString(),
              err: errSummary(relErr),
            });
          });
        try {
          pick.token.fill(0);
        } catch {
          /* ignore */
        }
        try {
          pick.refresh?.fill(0);
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          error: { kind: "refresh_failed", transient: isTransient, err },
        };
      }
    }

    const endpoint = deps.upstreamEndpoint ?? DEFAULT_UPSTREAM_ENDPOINT;
    return { ok: true, session: makeOAuthPoolUpstream(pick, dispatcher, endpoint) };
  } catch (err) {
    // (b₂) preparation 期任意 throw 兜底:
    //   - getDispatcherForAccount throw(plain proxy URL parse / PSK 解密 / mTLS load 等;
    //     实际上 egressDispatcher 内部已 fail-soft 返 undefined,理论不抛 — 但我们仍兜底)
    //   - makeOAuthPoolUpstream 自身 throw(理论不会,但合约级保险)
    //   - 任何未来加进 preparation 段的代码默认走 failure 释放
    log.warn("proxy_upstream_preparation_failed", {
      accountId: pick.account_id.toString(),
      err: errSummary(err),
    });
    await deps.scheduler
      .release({
        account_id: pick.account_id,
        result: { kind: "failure", error: errMessageShort(err) },
      })
      .catch((relErr) => {
        // 同 (b₁):补偿失败不能覆盖 preparation 主错误,但需要 log warn 让 release
        // 后端故障可观测,不能完全 silent。
        log.warn("proxy_release_account_failed", {
          stage: "preparation_fail",
          accountId: pick.account_id.toString(),
          err: errSummary(relErr),
        });
      });
    try {
      pick.token.fill(0);
    } catch {
      /* ignore */
    }
    try {
      pick.refresh?.fill(0);
    } catch {
      /* ignore */
    }
    return { ok: false, error: { kind: "preparation_failed", err } };
  }
}

/**
 * Backward-compat wrapper:既有 callers(unit tests / handler 早期版本 / `src/index.ts`
 * re-export)继续通过单入口 `pickUpstream` 拿 PreparedUpstreamSession。V3 envv2 Phase 4
 * 后,handler 自身走 `pickAccountForUpstream` → normalize → preCheck → `prepareUpstreamSession`
 * 两阶段以让 v2 envelope normalize 拿到 account_id/salt 而**不**先做 refresh。其它 caller
 * 只需 happy/fail aggregate 行为,这里串联两阶段不改变对外契约。
 *
 * 关键性质保持:
 *   - 选号失败 → 无 release(`pool_busy` / `pool_unavailable` 同 pickAccountForUpstream)
 *   - prepareUpstreamSession 失败 → 内部已 release + zeroize,这里只是透传 PickError
 *   - DeepSeek 路径 → ctx.kind==='deepseek',prepareUpstreamSession 直接合 session
 */
export async function pickUpstream(
  deps: PickUpstreamDeps,
  body: ProxyBody,
  route: UpstreamRoute,
  log: Logger,
  opts?: PickUpstreamOptions,
): Promise<
  | { ok: true; session: PreparedUpstreamSession }
  | { ok: false; error: PickError }
> {
  const a = await pickAccountForUpstream(deps, body, route, log, opts);
  if (!a.ok) return a;
  return prepareUpstreamSession(deps, a.ctx, log);
}

// ─── releaseUpstreamSession(case c)──────────────────────────────────────────

/**
 * **仅** finalizer 创建前的 case (c) 窗口(目前 = `startInflightJournal` fail)使用。
 *
 * 不变量:finalizer **已**创建后,release 唯一权归 finalizer,**绝不**再调本函数。
 * Phase 4 会把本函数 wrap 进 `ProxyCore.releaseBeforeFinalizer`,该约束直接 carry over。
 *
 * 行为:
 *   - OAuth session(`accountId !== null`)→ `scheduler.release({account_id, result})`
 *   - DeepSeek session(`accountId === null`)→ noop(无 pool 状态可释放)
 *   - scheduler.release 失败 → 不抛,log `proxy_release_upstream_failed`(原 `.catch(() => {})` + 等价 log)
 *
 * **不**调 `session.zeroizeSecrets()` —— token 生命周期归 session 内部 + handler finally,
 * 此函数只管 pool 释放,职责单一。caller(handler)负责自己调 zeroizeSecrets。
 */
/**
 * V3 envv2 Phase 4(2026-05-21):reason 类型从 `{kind:"failure"}` 拓宽到 ReleaseResult 全集
 * (除 'success' — 那是 finalizer 的活)。动机:case (c) 窗口不止 finalizer 创建失败一种,
 * 还有 preCheck attachment / InsufficientCredits 等"账号无辜"的 client_error 路径需要
 * release 槽位但**不**扣账号健康分。当前 caller(handler.ts)若传 client_error,scheduler
 * 端见 scheduler.ts ReleaseResult 注释:dec inflight 不扣健康分。
 */
export type ReleaseBeforeFinalizerReason =
  | { kind: "failure"; error?: string | null }
  | { kind: "transient_network"; error?: string | null }
  | { kind: "client_error"; error?: string | null };

export async function releaseUpstreamSession(
  scheduler: Pick<AccountScheduler, "release">,
  session: PreparedUpstreamSession,
  reason: ReleaseBeforeFinalizerReason,
  log: Logger,
): Promise<void> {
  if (session.accountId === null) return;
  try {
    await scheduler.release({ account_id: session.accountId, result: reason });
  } catch (err) {
    log.warn("proxy_release_upstream_failed", { err: errSummary(err) });
  }
}
