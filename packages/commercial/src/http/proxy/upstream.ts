/**
 * V3 Phase 3 — Upstream session 抽象。
 *
 * 物理切出自 http/anthropicProxy.ts(2026-05-18 V3_ANTHROPIC_PROXY_SPLIT_PLAN §3.4 / §5.4 / §6.3)。
 *
 * 把 handler 主流程里"upstream 选择 + dispatcher + refresh + 头注入 + body sanitize +
 * device_id pin + token 零化"等散落跨度收敛进:
 *
 *   - `selectUpstreamRoute(model)`     —— preCheck 前的纯路由判定(deepseek/minimax/oauth)
 *   - `validateUpstreamConfig(...)`    —— preCheck 前的轻校验(静态 API key 缺失)
 *   - `pickUpstream(deps, body, route, log)` —— preCheck **后**的真正 session 形成
 *   - `PreparedUpstreamSession`        —— 完整 session 接口:OAuth pool / DeepSeek / MiniMax
 *   - `releaseUpstreamSession(...)`    —— **仅** finalizer 创建前的 case (c) 补偿
 *
 * Release ownership(plan §5.4 4 段铁律):
 *   (a) pick 自身失败                          → 不调 release(无 account)
 *   (b₁) refresh 失败                          → upstream 层内部 release(transient_network|failure)
 *   (b₂) dispatcher / preparation 期其他 throw → upstream 层内部 release(failure)
 *   (c) session 已 ready 但 finalizer 建立前    → handler 调 releaseUpstreamSession(...)
 *   (d) finalizer 已建立                       → release 唯一权归 finalizer
 *
 * Secret hygiene:
 *   - refresh 成功时,**老** pick.token / pick.refresh 立即 fill(0)
 *   - 任何 (b) 失败路径,upstream 层在 release 后 fill(0)
 *   - handler finally 调 session.zeroizeSecrets() 处理 **新** pick(refresh 后的)的 token / refresh
 *   - DeepSeek / MiniMax session zeroizeSecrets 是 noop(apiKey 来自配置注入,不归 session)
 *   - zeroizeSecrets 幂等(内部 zeroized flag)
 *
 * Phase 3 不引 ProxyCore;`releaseUpstreamSession` 是自由函数,Phase 4 会 wrap 进
 * `ProxyCore.releaseBeforeFinalizer`。"仅 finalizer 前窗口"的硬约束直接 carry over。
 */

import type { Dispatcher } from "undici";

import type { Logger } from "../../logging/logger.js";
import type { AccountGroupKind, AccountGroupProvider, AccountGroupRow } from "../../account-pool/groups.js";
import { errMessageShort, errSummary } from "../util.js";
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  SessionPinUnboundError,
  SessionPinTemporarilyUnavailableError,
  type AccountScheduler,
  type PickResult,
  type SessionPinMode,
} from "../../account-pool/scheduler.js";
import {
  shouldRefresh,
  refreshAccountToken,
  RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
} from "../../account-pool/refresh.js";
import {
  getDispatcherForAccount,
  resolveAccountEgressDispatcher,
} from "../../account-pool/egressDispatcher.js";
import {
  DEFAULT_UPSTREAM_ENDPOINT,
  DEEPSEEK_UPSTREAM_ENDPOINT,
  MINIMAX_UPSTREAM_ENDPOINT,
  isDeepseekModel,
  isMiniMaxM3Model,
  extractSessionId,
  injectPersonaHeaders,
  isUuidLike,
  rewriteMetadataAccountUuid,
  rewriteMetadataDeviceId,
  stripMalformedThinkingBlocks,
  type ProxyBody,
} from "./shared.js";

// ─── 路由决策 + 早拒绝 ────────────────────────────────────────────────────────

export type UpstreamRoute =
  | { kind: "oauth" }
  | { kind: "deepseek" }
  | { kind: "minimax" };

/**
 * 纯函数,基于 model 决定走哪条 upstream。**preCheck 前**调用。
 *
 * isDeepseekModel(model) 命中 → deepseek;MiniMax-M3 → minimax;否则 oauth。
 */
export function selectUpstreamRoute(model: string): UpstreamRoute {
  if (isMiniMaxM3Model(model)) return { kind: "minimax" };
  return isDeepseekModel(model) ? { kind: "deepseek" } : { kind: "oauth" };
}

/**
 * 路由配置错误:静态 API-key upstream 未配置。
 *
 * handler 拿到后映射:503 + 对应结构化 log + reject metric。
 */
export type ConfigError =
  | { kind: "deepseek_not_configured" }
  | { kind: "minimax_not_configured" };

/**
 * preCheck **前**调:路由级早拒绝。返回 null 表示该路由当前部署可走。
 *
 * 行为锁(对应原 handler L1262-1272):deepseek 缺 key 必须**在 preCheck 之前**返回,
 * 不能让请求先 reserve credits 再 rollback。
 */
export function validateUpstreamConfig(
  route: UpstreamRoute,
  deps: { deepseekApiKey?: string; minimaxTokenPlanKey?: string },
): ConfigError | null {
  if (route.kind === "deepseek" && !deps.deepseekApiKey) {
    return { kind: "deepseek_not_configured" };
  }
  if (route.kind === "minimax" && !deps.minimaxTokenPlanKey) {
    return { kind: "minimax_not_configured" };
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
  /** account_pool account_id;`null` = DeepSeek/MiniMax 路径(无 OAuth 池) */
  readonly accountId: bigint | null;
  /**
   * pick() 的 per-slot 租约 id。OAuth 路径 = pick.slotId(非 null);
   * DeepSeek/MiniMax(无池)= null。release/finalizer 必须按此精确还槽。
   * 不变量:accountId 与 slotId 同生死 —— 两者皆非 null 或皆 null。
   */
  readonly slotId: string | null;
  /** 反风控锚定 device_id;`null` = DeepSeek */
  readonly pinnedUserId: string | null;
  /** 上游 URL;OAuth = `deps.upstreamEndpoint ?? DEFAULT`;DeepSeek = `DEEPSEEK_UPSTREAM_ENDPOINT` */
  readonly endpoint: string;
  /** undici dispatcher;OAuth 绑账号 egress IP;DeepSeek = undefined(默认出口) */
  readonly dispatcher: Dispatcher | undefined;
  /** 上游响应是否值得抓 quota(OAuth=true;DeepSeek=false) */
  readonly shouldUpdateQuotaFromResponse: boolean;

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
  | { kind: "preparation_failed"; err: unknown }
  /**
   * v3 反关联根治 — session pin 已 unbind(账号被 ban → cascade)。
   * handler 映射 409 + `{ error: { type: 'session_pin_unbound', action: 'reset_session' } }`。
   * 前端必须新建一个 chat session 才能继续(不允许同 session 切到新账号)。
   */
  | { kind: "session_pin_unbound"; err: SessionPinUnboundError }
  /**
   * v3 反关联根治 — session pin 指向账号瞬时不可用(cooldown / cap)。
   * handler 映射 503 + Retry-After,前端 backoff retry。
   */
  | { kind: "session_pin_temporarily_unavailable"; err: SessionPinTemporarilyUnavailableError };

export interface PickUpstreamDeps {
  scheduler: Pick<AccountScheduler, "pick" | "release">;
  /** refreshAccountToken 内部 http+pg 依赖。undefined → 即使到期也不刷(测试场景)。 */
  refreshDeps?: RefreshDeps;
  /** DeepSeek 静态 API key;production 由 wiring 从 config 注入。OAuth route 不消费。 */
  deepseekApiKey?: string;
  /** MiniMax Token Plan key;production 由 systemd env 注入。OAuth/DeepSeek route 不消费。 */
  minimaxTokenPlanKey?: string;
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
  /**
   * Phase 6 H6 — `phase6_account_uuid_enforce` 运行时 getter(v1.0.207 起从
   * `system_settings` 表读取,30s TTL cache,admin UI 立即可改)。
   *   - `off`(默认):applyUpstreamAuth account_uuid 分支早退,builder HMAC 占位透出
   *   - `fail_open`:hook 重写非 null;null 时跳过(HMAC 占位)
   *   - `fail_closed`:hook 强制重写;scheduler 已过滤掉 null 候选,理论上不到 null 分支
   *
   * pickUpstream 入口 `await` 一次后冻结到局部常量 — scheduler.pick({...,enforceAccountUuid})
   * 和闭包给 makeOAuthPoolUpstream 同值消费,避免运行期 admin 切换时两处读不一致
   * (plan §5.5.4 race guard 仍生效)。
   */
  getPhase6AccountUuidEnforce?: () => Promise<"off" | "fail_open" | "fail_closed">;
  /**
   * v3 反关联根治 — chat_session_account_pin 三态执行模式的运行时 getter
   * (v1.0.207 起从 system_settings 读取,30s TTL cache)。
   *
   * `off`(默认):scheduler 走旧 WRH-only 路径,不查/不写 csap。
   * `observe`:    跑 WRH + 对比 pin 是否一致,打点日志,**不**写 csap。
   * `enforce`:    pin 命中走 sticky;pin unbound 抛 SessionPinUnboundError(409);
   *                pin miss 走"既往足迹优先"WRH + race-safe INSERT 持久化 pin。
   *
   * 灰度路线见 SessionPinMode 注释。observe/enforce 需要 caller 同时透传 userId,
   * 否则 scheduler 内部降级 off + warn。
   */
  getSessionPinMode?: () => Promise<SessionPinMode>;
  listEnabledAccountGroupsForModel?: (args: {
    modelId: string;
    kind?: AccountGroupKind;
    provider?: AccountGroupProvider;
  }) => Promise<AccountGroupRow[]>;
}

type Phase6AccountUuidEnforce = "off" | "fail_open" | "fail_closed";

// ─── 内部工厂 ──────────────────────────────────────────────────────────────────
//
// 这两个工厂**不导出** —— production 只通过 pickUpstream 拿到 session,test 内部 import
// 也走 pickUpstream(plan Codex round 1 反馈:测试覆盖统一走 pickUpstream,避免测试触达
// 内部工厂导致"抽象信号"与"被测内部"边界混淆)。

function makeDeepSeekUpstream(apiKey: string): PreparedUpstreamSession {
  return {
    accountId: null,
    slotId: null,
    pinnedUserId: null,
    endpoint: DEEPSEEK_UPSTREAM_ENDPOINT,
    dispatcher: undefined,
    shouldUpdateQuotaFromResponse: false,
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

function makeMiniMaxUpstream(apiKey: string): PreparedUpstreamSession {
  return {
    accountId: null,
    slotId: null,
    pinnedUserId: null,
    endpoint: MINIMAX_UPSTREAM_ENDPOINT,
    dispatcher: undefined,
    shouldUpdateQuotaFromResponse: false,
    applyUpstreamAuth(safeHeaders, body, _log) {
      safeHeaders.authorization = `Bearer ${apiKey}`;
      // MiniMax 的 Anthropic 兼容层不需要 Anthropic 私有 beta；CCB 在
      // firstParty+proxy 形态下会带 interleaved/context/effort 等 beta,
      // 这里和 DeepSeek 一样 fail-closed strip,避免 strict proxy 报未知 beta。
      delete safeHeaders["anthropic-beta"];
      // MiniMax-M3 标准档只接普通 messages 参数。CCB 对 unknown firstParty
      // model 可能默认带 output_config / context_management / thinking /
      // service_tier;这些不是用户显式输入的业务内容,strip 后保留核心工具调用
      // / messages / system,避免上游按高价 priority 或未知参数拒绝。
      delete body.output_config;
      delete body.context_management;
      delete body.thinking;
      delete body.service_tier;
    },
    sanitizeMessages(messages, _model, _log) {
      return messages;
    },
    zeroizeSecrets() {
      /* noop: minimaxTokenPlanKey 来自配置注入,不归 session */
    },
  };
}

function makeOAuthPoolUpstream(
  pick: PickResult,
  dispatcher: Dispatcher | undefined,
  endpoint: string,
  phase6Enforce: Phase6AccountUuidEnforce,
): PreparedUpstreamSession {
  // 注意 `pick` 通过闭包持有;refresh 成功后 pickUpstream 内部 **rebind** 旧引用
  // 已经被 fill(0) → 这里持有的就是新 buffer。zeroizeSecrets idempotent 由 flag 守。
  // phase6Enforce 也通过闭包持有 — pickUpstream 入口读一次 config,确保 scheduler.pick
  // 和 hook 拿到的是同一个值(plan §5.5.4 防止热改竞态)。
  let zeroized = false;
  return {
    accountId: pick.account_id,
    slotId: pick.slotId,
    pinnedUserId: pick.pinned_user_id,
    endpoint,
    dispatcher,
    shouldUpdateQuotaFromResponse: true,
    applyUpstreamAuth(safeHeaders, body, log) {
      // (i) Bearer
      safeHeaders.authorization = `Bearer ${pick.token.toString("utf8")}`;
      // (ii) v3 反关联根治 — persona 差异化注入(必须早于 anthropic-beta merge)
      //   每个 account 持有自己的稳定 persona(0073/0074 migration + persona.ts);
      //   把 user-agent / x-stainless-* / accept-language 9 个头按账号差异化,
      //   让 Anthropic 网关看到的指纹**按账号差异化**(不再 byte-identical 全池)。
      //   顺序选择:authorization → persona → anthropic-beta —— 跟原生 stainless
      //   SDK 自然发包顺序对齐(标识头先于功能头);HTTP/2 wire 层 hash map 本不
      //   敏感顺序,这里求"语义对齐"避免未来网关侧出现"按顺序签名/校验"型
      //   反检测策略时落坑。
      //   null = 0074 SET NOT NULL 前的 backfill 窗口或 schema drift。fail-open
      //   (不注入,落回 undici 默认头),配 log.warn 让 ops 看到 backfill 进度。
      if (pick.persona === null) {
        log.warn("account_persona_missing", {
          account_id: pick.account_id.toString(),
        });
      } else {
        injectPersonaHeaders(safeHeaders, pick.persona);
      }
      // (iii) anthropic-beta merge "oauth-2025-04-20"(persona 之后,语义对齐)
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
      // (iv) Phase 6 account_uuid pin —— 锚定 OAuth account 真 UUID(0070 migration)。
      //
      //   off          → hook 不跑(builder HMAC 占位透出,deploy 1 默认值)
      //   fail_open    → pick.account_uuid 存在则重写;NULL 时跳过(HMAC 占位透出)
      //   fail_closed  → pickUpstream 上游已 defense-in-depth reject NULL → 这里 NULL
      //                  分支理论不可达;若到这 = 上游逻辑被人改坏,fail-close 兜底
      //                  (Codex round 2 MINOR 1)
      //
      // 脏数据(非 null 但非合法 UUID)→ 不重写 + log.warn,fail-open 防把诡异输入
      // 推到 Anthropic 网关引发新风控。
      if (phase6Enforce !== "off") {
        const pinnedAcct = pick.account_uuid;
        if (typeof pinnedAcct === "string" && isUuidLike(pinnedAcct)) {
          body.metadata ??= {};
          // strict=true 仅在 fail_closed:H6 invariant 强保证,malformed / 非
          // object metadata.user_id 也强制 normalize 到 {account_uuid}。
          // fail_open 保留客户端原值,避免诡异输入推上游引发风控。
          // (Codex round 1 BLOCKER 1)
          body.metadata.user_id = rewriteMetadataAccountUuid(
            body.metadata.user_id,
            pinnedAcct,
            phase6Enforce === "fail_closed",
          );
        } else if (pinnedAcct === null) {
          // fail_open + null → 静默跳过,符合预期(HMAC 占位透出)
          // fail_closed + null → 上游 pickUpstream defense-in-depth 已拦,此分支
          //   理论不可达;若到这是 H6 invariant 真被破坏,抛错让请求 500 而非静默放过,
          //   绝不允许 fail_closed 模式下 NULL uuid 推到 Anthropic 上游。
          if (phase6Enforce === "fail_closed") {
            log.error("account_uuid_null_reached_apply_in_fail_closed", {
              account_id: pick.account_id.toString(),
            });
            throw new Error(
              "fail_closed invariant breach: account_uuid is null at applyUpstreamAuth",
            );
          }
        } else {
          log.warn("account_uuid_invariant_breach", {
            account_id: pick.account_id.toString(),
            pinned_type: typeof pinnedAcct,
          });
        }
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

// ─── pickUpstream ─────────────────────────────────────────────────────────────

/**
 * preCheck **后**调用。返回 `{ ok: true, session }` 或 `{ ok: false, error }`。
 *
 * **任何已持有 account 后的失败(case b₁/b₂)**,本函数内部完成:
 *   - `scheduler.release({account_id, result: {kind, error}})`(catch swallow)
 *   - 旧 pick 的 token / refresh 零化
 * 然后转 `PickError` 返回。handler 不再需要(也不应)处理 release。
 *
 * pool_busy / pool_unavailable(case a)无 account 持有,直接转 PickError 无副作用。
 *
 * DeepSeek / MiniMax 路径:直接返回静态 API-key upstream,无 pool 访问。
 */
export async function pickUpstream(
  deps: PickUpstreamDeps,
  body: ProxyBody,
  route: UpstreamRoute,
  log: Logger,
  /**
   * v3 反关联根治 — 已认证用户 id。csap pin 强制锚定到 (userId, sessionId);
   * runtime flag `session_pin_mode='off'` 时调用方可省略,但建议**始终传**(灰度切到
   * observe 不需要改 handler)。route='deepseek' 路径完全不消费 — 透传 undefined 安全。
   */
  userId?: bigint,
  /**
   * v3 反关联根治 UX 闭环 — 客户端"强制 repin"信号(来自 HTTP 头 `x-force-repin: 1`)。
   *
   * 仅在 runtime flag `session_pin_mode='enforce'` 路径有意义:
   *   - true → 跳过 prelude unbound 检查,允许 scheduler 在同 session 上覆盖原 unbound pin
   *     直接选新账号,无需用户走"开新会话"路径(保留对话历史)。
   *   - false / 未传 → 走正常 prelude(unbound → 抛 SessionPinUnboundError 让客户端决策)。
   *
   * deepseek / non-OAuth / `session_pin_mode != 'enforce'` 路径透传也安全(scheduler 静默忽略)。
   */
  forceRepin?: boolean,
): Promise<
  | { ok: true; session: PreparedUpstreamSession }
  | { ok: false; error: PickError }
> {
  if (route.kind === "deepseek") {
    // validateUpstreamConfig 已保证 deepseekApiKey 非空(handler preCheck 前 gate)。
    // 这里若仍 undefined 是 wiring bug — 退化为空字符串 Bearer 比 throw 安全(让上游 401)。
    return { ok: true, session: makeDeepSeekUpstream(deps.deepseekApiKey ?? "") };
  }
  if (route.kind === "minimax") {
    // validateUpstreamConfig 已保证 minimaxTokenPlanKey 非空(handler preCheck 前 gate)。
    // 这里若仍 undefined 是 wiring bug — 退化为空字符串 Bearer 比 throw 安全(让上游 401)。
    return { ok: true, session: makeMiniMaxUpstream(deps.minimaxTokenPlanKey ?? "") };
  }

  // Phase 6 flag 在 OAuth 路径开头 await 一次,scheduler.pick + makeOAuthPoolUpstream
  // 同值传入,避免热改时两处读不一致(plan §5.5.4)。默认 "off" — getter 未注入
  // 或 cache miss 后 DB row 缺失时,getSystemSetting 内部已兜底 DEFAULTS["off"]。
  // v1.0.207:从 env-only 迁移到 system_settings 后,这两次 await 是 30s TTL cache
  // hit 同步路径(<1ms),cache miss 1-2ms DB,可接受。
  const phase6Enforce: Phase6AccountUuidEnforce =
    (await deps.getPhase6AccountUuidEnforce?.()) ?? "off";
  const sessionPinMode: SessionPinMode =
    (await deps.getSessionPinMode?.()) ?? "off";

  // OAuth path —— account groups are tried by priority when a resolver is injected.
  // Tests and legacy wiring may omit it, in which case scheduler keeps historical whole-pool behavior.
  let groupIds: Array<bigint | null> = [null];
  if (deps.listEnabledAccountGroupsForModel) {
    const groups = await deps.listEnabledAccountGroupsForModel({
      modelId: body.model,
      kind: "official_oauth",
      provider: "claude",
    });
    if (groups.length === 0) {
      return {
        ok: false,
        error: {
          kind: "pool_unavailable",
          err: new AccountPoolUnavailableError("no_enabled_group"),
        },
      };
    }
    groupIds = groups.map((g) => g.id);
  }

  let pick: PickResult | null = null;
  let lastBusy: AccountPoolBusyError | null = null;
  let lastUnavailable: AccountPoolUnavailableError | null = null;
  let lastPinTemporarilyUnavailable: SessionPinTemporarilyUnavailableError | null = null;
  for (const groupId of groupIds) {
    try {
      pick = await deps.scheduler.pick({
        mode: "chat",
        sessionId: extractSessionId(body.metadata) ?? undefined,
        model: body.model,
        groupId,
        enforceAccountUuid: phase6Enforce === "fail_closed",
        pinMode: sessionPinMode,
        userId,
        forceRepin,
      });
      break;
    } catch (err) {
      if (err instanceof AccountPoolBusyError) {
        lastBusy = err;
        continue;
      }
      if (err instanceof AccountPoolUnavailableError) {
        lastUnavailable = err;
        continue;
      }
      if (err instanceof SessionPinUnboundError) {
        return { ok: false, error: { kind: "session_pin_unbound", err } };
      }
      if (err instanceof SessionPinTemporarilyUnavailableError) {
        lastPinTemporarilyUnavailable = err;
        continue;
      }
      throw err; // unknown — handler 外层 500
    }
  }
  if (pick === null) {
    if (lastBusy) return { ok: false, error: { kind: "pool_busy", err: lastBusy } };
    if (lastPinTemporarilyUnavailable) {
      return {
        ok: false,
        error: {
          kind: "session_pin_temporarily_unavailable",
          err: lastPinTemporarilyUnavailable,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "pool_unavailable",
        err: lastUnavailable ?? new AccountPoolUnavailableError("no_group_candidate"),
      },
    };
  }

  // Phase 6 H6 — fail_closed defense-in-depth(Codex round 2 MINOR 1):
  //
  // scheduler 在 enforceAccountUuid=true 时已过滤 account_uuid IS NULL 候选,理论上
  // pick.account_uuid 必非空。但若 scheduler / hook 之间 flag 读不一致 / 未来代码
  // 路径漂移 → race condition 可能让 NULL 漏到这里。fail_closed 必须 fail closed,
  // 而不是 log + 继续。把 pick release + 返回 pool_unavailable("no_uuid_post_scheduler"),
  // 复用现有 503 ACCOUNT_POOL_UNAVAILABLE 契约,index.ts 把 reason 映射到
  // account_pool_no_uuid metric label。
  if (phase6Enforce === "fail_closed" && pick.account_uuid === null) {
    log.warn("account_uuid_null_post_scheduler_in_fail_closed", {
      accountId: pick.account_id.toString(),
    });
    await deps.scheduler
      .release({
        account_id: pick.account_id,
        slotId: pick.slotId,
        result: { kind: "failure", error: "account_uuid_null_in_fail_closed" },
      })
      .catch(() => {
        /* best-effort */
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
      error: {
        kind: "pool_unavailable",
        err: new AccountPoolUnavailableError("no_uuid_post_scheduler"),
      },
    };
  }

  // pick 后到 session 返回前 —— 整段单一 preparation guard。
  // (b₁) refresh 失败有专属 catch:release kind 区分 transient/failure。
  // (b₂) dispatcher 或其他 preparation throw —— outer guard 统一 release(failure)。
  try {
    const getDispatcher = deps.getDispatcher ?? getDispatcherForAccount;
    // A2 fail-closed:已绑账号若解析不出 dispatcher,绝不退默认/全局出口(去匿名化泄露)。
    // resolver 用绑定权威源(egress_proxy_id/egress_host_uuid)消歧"未绑"与"已绑但解析失败"。
    const egress = await resolveAccountEgressDispatcher(
      pick.account_id,
      {
        egressProxy: pick.egress_proxy,
        egressTarget: pick.egress_target,
        egressProxyId: pick.egress_proxy_id,
        egressHostUuid: pick.egress_host_uuid,
      },
      getDispatcher,
    );
    if (egress.kind === "unavailable") {
      // 已绑但出口不可用 → fail-closed。release(transient_network):纯出口/网络层
      // 故障不扣账号健康分(避免"代理一抖烧全池"),仅 dec inflight 槽位。
      log.warn("proxy_egress_unavailable", {
        accountId: pick.account_id.toString(),
        reason: egress.reason,
      });
      await deps.scheduler
        .release({
          account_id: pick.account_id,
          slotId: pick.slotId,
          result: { kind: "transient_network", error: "egress_unavailable" },
        })
        .catch(() => {
          /* best-effort, swallow */
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
        error: {
          kind: "pool_unavailable",
          err: new AccountPoolUnavailableError("egress_unavailable"),
        },
      };
    }
    const dispatcher = egress.kind === "ready" ? egress.dispatcher : undefined;

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
          // refresh rebind:槽未释放(同账号仅换 token)→ slotId 必须原样保留,
          // 否则 finalizer 拿不到 slotId → 还槽失败 → 泄漏(B7 自伤)。
          slotId: pick.slotId,
          plan: pick.plan,
          token: r.token,
          refresh: r.refresh,
          expires_at: r.expires_at,
          egress_proxy: pick.egress_proxy,
          egress_target: pick.egress_target,
          // A2 — refresh rebind 必须保留出口绑定权威源,否则续期后 pick 丢失
          // egress_proxy_id/egress_host_uuid(类型不完整 + 下游若再判定 fail-closed 会误判未绑)。
          egress_proxy_id: pick.egress_proxy_id,
          egress_host_uuid: pick.egress_host_uuid,
          pinned_user_id: pick.pinned_user_id,
          // Phase 6 H6.D — refresh rebind 必须显式带 account_uuid。仅依赖
          // PickResult 字段约束不够,测试 mock/`as` 容易绕过去(Codex round 2 反馈)。
          account_uuid: pick.account_uuid,
          // v3 反关联根治 0073/0074 — refresh rebind 必须保留 persona,
          // 否则 token 续期后该 turn 的 stainless 头会丢失漂移属性。
          persona: pick.persona,
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
            slotId: pick.slotId,
            result: isTransient
              ? { kind: "transient_network", error: errMessageShort(err) }
              : { kind: "failure", error: errMessageShort(err) },
          })
          .catch(() => {
            /* best-effort, swallow */
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
    return {
      ok: true,
      session: makeOAuthPoolUpstream(pick, dispatcher, endpoint, phase6Enforce),
    };
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
        slotId: pick.slotId,
        result: { kind: "failure", error: errMessageShort(err) },
      })
      .catch(() => {
        /* best-effort, swallow */
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
export async function releaseUpstreamSession(
  scheduler: Pick<AccountScheduler, "release">,
  session: PreparedUpstreamSession,
  reason: { kind: "failure"; error: string },
  log: Logger,
): Promise<void> {
  // accountId 与 slotId 同生死(OAuth 两者非 null;DeepSeek/MiniMax 两者 null)。
  // 配对判 null 既保 DeepSeek noop 语义,又让 TS 收窄 slotId 为非 null(避免裸 `!`)。
  if (session.accountId === null || session.slotId === null) return;
  try {
    await scheduler.release({
      account_id: session.accountId,
      slotId: session.slotId,
      result: reason,
    });
  } catch (err) {
    log.warn("proxy_release_upstream_failed", { err: errSummary(err) });
  }
}
