/**
 * V3 Phase 4(2026-05-18 anthropicProxy.ts 三层拆分 §4.7):handler 工厂。
 *
 * 物理迁移自 anthropicProxy.ts L1066-1644(makeAnthropicProxyHandler 函数体)。
 * 步骤 0-9 留在 handler:
 *   0) 路径白名单
 *   1) 容器身份双因子(strategy.resolve)
 *   2) per-uid rate-limit(主 Redis + fallback in-process)
 *   3) per-uid 并发上限(ConcurrencyLimiter.acquire)
 *   4) 读 body + zod strict + byte budgets
 *   5) pricing.get + enabled
 *   5b) strategy.authorize(role + grants + canUseModel)
 *   5c) selectUpstreamRoute + validateUpstreamConfig
 *   6) preCheckWithCost(estimated_input + max_output)
 *   7) pickUpstream(scheduler.pick + refresh / DeepSeek 合成 session)
 *   8) startInflightJournal(case (c) release ownership 在这里 fail-only)
 *   9) makeFinalizer(从此 release 唯一调用点 = finalize)
 *
 * 步骤 10-11(upstream round-trip)切到 proxy/core.ts 的 runUpstreamRoundTrip。
 *
 * **httpErrToReject 故意保留私有**:那是 handler 决定怎么把 body parse 的 HttpError
 * 映射到 reject reason metric 标签的策略,跟其他模块无关。core.ts 不会用,所以
 * 不下沉到 shared.ts(plan v3 Codex 反馈,见 §4 修订 H)。
 */

import { rootLogger } from "../../logging/logger.js";
import { ensureRequestId, setSecurityHeaders } from "../util.js";
import {
  IdentityError,
  AuthzLoadError,
  AuthzDeniedError,
  type ProxyIdentity,
} from "../../auth/proxyIdentity.js";
import {
  preCheckWithCost,
  releasePreCheck,
  InsufficientCreditsError,
} from "../../billing/preCheck.js";
import {
  makeFinalizer,
  startInflightJournal,
} from "../../billing/proxyBilling.js";
import { checkRateLimit } from "../../middleware/rateLimit.js";
import {
  pickUpstream,
  releaseUpstreamSession,
  selectUpstreamRoute,
  validateUpstreamConfig,
  type PreparedUpstreamSession,
} from "./upstream.js";
import {
  incrAnthropicProxyReject,
  incrPrecheckCapped,
  type ProxyRejectReason,
} from "../../admin/metrics.js";

import {
  type AnthropicProxyDeps,
  type AnthropicProxyHandler,
  type ProxyBody,
  HttpError,
  REQUEST_ID_HEADER,
  ConcurrencyLimiter,
  FallbackRateLimiter,
  DEFAULT_PROXY_RATE_LIMIT,
  DEFAULT_MAX_CONCURRENT_PER_UID,
  MAX_BODY_BYTES_DEFAULT,
  proxyBodySchema,
  enforceFieldByteBudgets,
  estimateInputTokens,
  estimateMaxCostBothSides,
  extractSessionId,
  readBoundedJson,
  sendJsonError,
  errMessageShort,
  errSummary,
} from "./shared.js";

import { runUpstreamRoundTrip } from "./core.js";
import { normalizeExternalApiKeyEnvelope } from "./externalEnvelope.js";

// ─── 私有 helper ──────────────────────────────────────────────────────────

/**
 * 把 readBoundedJson / enforceFieldByteBudgets 抛的 HttpError 折射到 reject 标签。
 *
 * 故意保留私有:只有本 handler 关心这个映射,core.ts 不用,shared.ts 不收。
 */
function httpErrToReject(err: HttpError): ProxyRejectReason {
  if (err.status === 413) return "too_large";
  return "bad_body";
}

// ─── handler 工厂 ─────────────────────────────────────────────────────────

export function makeAnthropicProxyHandler(
  deps: AnthropicProxyDeps,
): AnthropicProxyHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "anthropicProxy" });
  const fetchFn = deps.fetchImpl ?? fetch;
  // upstream endpoint(默认 / 覆盖)由 pickUpstream 内部按 route 选择,详见 proxy/upstream.ts。
  const rateLimitCfg = deps.rateLimit ?? DEFAULT_PROXY_RATE_LIMIT;
  const concurrency = new ConcurrencyLimiter(
    deps.maxConcurrentPerUid ?? DEFAULT_MAX_CONCURRENT_PER_UID,
  );
  // 2026-04-21 安全审计 HIGH#3:Redis 抖动时的兜底限流(cap = Redis cap 的 1/3,
  // 向下取整至少 1;窗口同 Redis 以便行为连续)。Redis 正常时这个 map 始终空,
  // 不占资源;Redis 异常时它是最后一道防线。
  const fallbackCap = Math.max(1, Math.floor(rateLimitCfg.max / 3));
  const fallbackLimiter = new FallbackRateLimiter(rateLimitCfg.windowSeconds, fallbackCap);
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES_DEFAULT;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? "GET",
      path: req.url ?? "",
    });

    // 0) 路径白名单 — 这个 handler 只挂在 POST /v1/messages
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      reqLog.warn("proxy_bad_path", { method: req.method, path: url.pathname });
      incrAnthropicProxyReject("bad_path");
      sendJsonError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
      return;
    }

    // 1) 容器身份双因子 + post-auth 流量计数(strategy 内部完成 verify + recordHostRequest)
    //
    // Strategy 失败模式:
    //   IdentityError → 401 UNAUTHORIZED(errcode 进 log 不外泄)
    //
    // 注:recordHostRequest 已搬入 IdentityStrategy.resolve(只在 verify 成功后 fire),
    // 详见 auth/proxyIdentity.ts 中的契约注释。
    let identity: ProxyIdentity;
    try {
      identity = await deps.identity.resolve(req, ctx);
    } catch (err) {
      if (err instanceof IdentityError) {
        reqLog.warn("proxy_identity_failed", { errcode: err.code });
        incrAnthropicProxyReject("identity");
        sendJsonError(
          res,
          401,
          "UNAUTHORIZED",
          "container identity verification failed",
          requestId,
        );
        return;
      }
      throw err;
    }
    const uid = identity.uid;
    const containerIdBig = identity.containerId;
    // 2026-05-18 CC 外接 plan Phase 0:containerId 可为 null(非容器 strategy 如 API key)。
    // 结构化日志字段保留真值类型:null 维持 ID-or-null 形状,不引入 sentinel string,
    // 避免聚合/筛选时字段类型从 "ID 或 null" 漂成 "ID 或标签"。未来若需区分路径,
    // 走独立 `identityKind` 字段(Phase 1 ApiKeyIdentityStrategy 引入)。
    const userLog = reqLog.child({
      uid: uid.toString(),
      containerId: containerIdBig === null ? null : containerIdBig.toString(),
    });

    // 2) 限流(per-uid 滑动固定窗口)
    try {
      const decision = await checkRateLimit(
        deps.rateLimitRedis,
        rateLimitCfg,
        `uid:${uid.toString()}`,
      );
      if (!decision.allowed) {
        userLog.warn("proxy_rate_limited", { count: decision.count });
        incrAnthropicProxyReject("rate_limited");
        sendJsonError(
          res,
          429,
          "RATE_LIMITED",
          "too many requests, slow down",
          requestId,
          { "Retry-After": String(decision.retryAfterSeconds) },
        );
        return;
      }
    } catch (err) {
      // 2026-04-21 安全审计 HIGH#3 修复:Redis 抖动不再 fail-open 无脑放行。
      // 退到进程内 FallbackRateLimiter(cap = Redis cap/3),保底防止"Redis 持续
      // 宕掉 → proxy 变成无限流 open relay → 盗用 token 秒级烧钱"。
      // Fallback 放行 → 继续(记 error log);Fallback 也拒 → 429 RATE_LIMITED。
      userLog.error("proxy_rate_limit_redis_failed", { err: errSummary(err) });
      if (!fallbackLimiter.tryAcquire(`uid:${uid.toString()}`)) {
        userLog.warn("proxy_rate_limit_fallback_blocked", {
          fallbackCap,
          fallbackCount: fallbackLimiter.count(`uid:${uid.toString()}`),
        });
        incrAnthropicProxyReject("rate_limited");
        sendJsonError(
          res,
          429,
          "RATE_LIMITED",
          "rate limit fallback engaged (redis degraded)",
          requestId,
          { "Retry-After": String(rateLimitCfg.windowSeconds) },
        );
        return;
      }
    }

    // 3) per-uid 并发上限
    const releaseSlot = concurrency.acquire(`uid:${uid.toString()}`);
    if (!releaseSlot) {
      userLog.warn("proxy_concurrency_full", { max: deps.maxConcurrentPerUid ?? DEFAULT_MAX_CONCURRENT_PER_UID });
      incrAnthropicProxyReject("concurrency");
      sendJsonError(res, 429, "CONCURRENT_LIMIT", "too many concurrent requests", requestId);
      return;
    }

    try {
      // 4) 读 + parse + 校验 body
      let body: ProxyBody;
      try {
        const raw = await readBoundedJson(req, maxBodyBytes);
        const parsed = proxyBodySchema.safeParse(raw);
        if (!parsed.success) {
          userLog.warn("proxy_body_schema_failed", { issues: parsed.error.issues });
          incrAnthropicProxyReject("bad_body");
          sendJsonError(res, 400, "BAD_BODY", "invalid request body", requestId);
          return;
        }
        body = parsed.data;
        enforceFieldByteBudgets(body);
      } catch (err) {
        if (err instanceof HttpError) {
          userLog.warn("proxy_body_rejected", { status: err.status, code: err.code });
          incrAnthropicProxyReject(httpErrToReject(err));
          sendJsonError(res, err.status, err.code, err.message, requestId);
          return;
        }
        throw err;
      }

      // 5) 取 pricing
      const pricing = deps.pricing.get(body.model);
      if (!pricing || !pricing.enabled) {
        userLog.warn("proxy_unknown_model", { model: body.model });
        incrAnthropicProxyReject("unknown_model");
        sendJsonError(res, 400, "UNKNOWN_MODEL", `model '${body.model}' not enabled`, requestId);
        return;
      }

      // 5b) 模型授权(2026-05-02 deepseek 接入引入,Codex review BLOCKER 修)。
      //
      // 历史:proxy 只校验 pricing.enabled,不查 visibility/grants。结果:
      //   - 用户拿到容器后可直接 POST { model: 'deepseek-v4-pro' } 绕过前端 modelPicker
      //     的 admin/hidden 隐藏 → 越权使用 admin 模型(同样影响 gpt-5.5 / haiku-4-5)。
      //
      // 修复:取 pricing 后、preCheck 前,strategy.authorize 内部从服务端权威源(DB)
      // 拿 role + grants 并跑 canUseModel;失败 403。位置选 preCheck 之前是为了避免引入
      // reservation release 复杂度 — fail-closed 直接 sendJsonError 退出,无需 release。
      //
      // 容器请求**不**传 role / grants(即使 header / body / metadata),容器可伪造。
      // strategy.authorize 失败模式:
      //   AuthzLoadError(loadUserModelAuthz throw) → 500 INTERNAL
      //   AuthzDeniedError(canUseModel false)     → 403 NOT_AUTHORIZED
      try {
        await deps.identity.authorize(identity, pricing, body.model);
      } catch (err) {
        if (err instanceof AuthzLoadError) {
          userLog.error("proxy_authz_load_failed", { err: errSummary(err.cause) });
          sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
          return;
        }
        if (err instanceof AuthzDeniedError) {
          userLog.warn("proxy_unauthorized_model", {
            model: err.modelId,
            role: err.role,
          });
          incrAnthropicProxyReject("unauthorized_model");
          sendJsonError(res, 403, "NOT_AUTHORIZED", "model not authorized", requestId);
          return;
        }
        throw err;
      }

      // 5c) Upstream route 选择 + 配置早拒绝(2026-05-18 Phase 3 §3.4 切出)。
      //
      // **必须在 preCheck 之前**:deepseek 路由缺 key 直接 503,不能 reserve credits 再 rollback。
      // 详见 `proxy/upstream.ts` selectUpstreamRoute / validateUpstreamConfig 注释 + plan 行为锁。
      const route = selectUpstreamRoute(body.model);
      const cfgErr = validateUpstreamConfig(route, { deepseekApiKey: deps.deepseekApiKey });
      if (cfgErr) {
        // 当前只有 deepseek_not_configured 一种;未来加新 kind 时这里要扩 switch。
        userLog.warn("proxy_deepseek_not_configured", { model: body.model });
        incrAnthropicProxyReject("deepseek_config");
        sendJsonError(
          res,
          503,
          "DEEPSEEK_NOT_CONFIGURED",
          "deepseek upstream not configured",
          requestId,
        );
        return;
      }

      // 5d) CC 外接出站 envelope 归一化(2026-05-20 Phase 7 §3.5.2)。
      //
      // 仅"外接 ApiKey 路径 + OAuth 上游"双重命中才注入。强制把 outbound `body.system`
      // 归一化成 CC 容器形态(含官方 sysprompt prefix),让上游 Anthropic anti-abuse
      // 把外接请求和容器内 CC CLI 请求视作同源,防"同一 OAuth account 同时出现
      // CC-shaped 和非 CC-shaped 流量"触发整池 429。
      //
      // **route.kind === "oauth" 判别**:DeepSeek 上游用独立 API key,无 OAuth pool /
      // 无 anti-abuse fingerprinting,注入 CC prefix 只浪费 13 tokens 且对 deepseek 端
      // 是"语义无关 prompt 污染"。容器路径(`containerId !== null`)同理跳过 — 容器
      // 内 CCB 已自带 sysprompt,多余 mutate 反而破坏既有缓存命中。
      //
      // **必须在 `estimateInputTokens(body)` 之前**(Codex Phase 7 plan-review MINOR):
      // 注入的 sysprompt prefix(~13 tokens)必须进 preCheck 估算 — 任何 mutate body 的
      // 步骤都在 input token 估算之前,账务边界干净。详见 plan §3.5.2 / externalEnvelope.ts。
      //
      // V3 envv2 Phase 1.5(2026-05-21):此 boolean 同时驱动 step 7 的 pickUpstream
      // `accountKind: 'external_api'` 注入。两处共用同一 discriminator —— 现状下
      // `identity.containerId === null` 唯一来自 ApiKeyIdentityStrategy(参见
      // auth/apiKeyIdentity.ts L263、auth/proxyIdentity.ts L45 类型注释)。**未来若
      // 再接入非容器 OAuth identity strategy,本 discriminator 会误归到外接池,
      // 届时必须切换到显式 identity.kind 字段重审**(Codex Phase 1.5 plan-review MINOR
      // R1 采纳)。
      const isExternalApiKeyOAuthPath = identity.containerId === null && route.kind === "oauth";
      if (isExternalApiKeyOAuthPath) {
        normalizeExternalApiKeyEnvelope(body, userLog);
      }

      // 6) 双侧 cost 估算 + preCheck(原子预留:Lua 一次完成 余额比对 + 写入)
      const inputTokens = estimateInputTokens(body);
      const totalMaxCost = estimateMaxCostBothSides(inputTokens, body.max_tokens, pricing);
      let pre;
      try {
        // 走 preCheckWithCost(已知 maxCost,跳过 estimateMaxCost 重算)。
        // 内部:getBalance(PG) → atomicReserve(Lua: 清过期 + HVALS 求和 + 比 balance + HSET/ZADD)
        // balance > 0 即放行;余额 < 估算 cost 时 cap 到 balance(drain-to-zero by cap-to-balance)。
        // 真实 cost 由 finalize 阶段已有的 clamp 路径吃(settleUsageAndLedger)。
        pre = await preCheckWithCost(deps.preCheckRedis, {
          userId: uid,
          requestId,
          maxCost: totalMaxCost,
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          userLog.warn("proxy_insufficient_credits", {
            balance: err.balance.toString(),
            required: err.required.toString(),
          });
          incrAnthropicProxyReject("insufficient");
          sendJsonError(
            res,
            402,
            "INSUFFICIENT_CREDITS",
            `insufficient credits: balance=${err.balance} required=${err.required}`,
            requestId,
          );
          return;
        }
        throw err;
      }

      if (pre.capped) {
        incrPrecheckCapped(body.model);
        userLog.info("precheck_capped", {
          balance: pre.balance.toString(),
          originalMaxCost: pre.originalMaxCost.toString(),
          effectiveMaxCost: pre.maxCost.toString(),
        });
      }

      // 7) 取账号 + dispatcher + (按需)刷 token —— 全部收敛进 pickUpstream(plan §3.4)。
      //
      // 失败模式 → 一一映射(release 已在 upstream 层 fire,handler 只做 preCheck rollback):
      //   pool_busy          → 429 ACCOUNT_POOL_BUSY     reject account_pool_busy
      //   pool_unavailable   → 503 ACCOUNT_POOL_UNAVAILABLE reject account_pool
      //   refresh_failed     → 502 UPSTREAM_AUTH_REFRESH_FAILED reject upstream_auth
      //   preparation_failed → 502 UPSTREAM_PREPARATION_FAILED  reject upstream_auth
      //
      // DeepSeek 路径:pickUpstream 直接合成 session(无 pool 访问)。
      //
      // V3 envv2 Phase 1.5(2026-05-21):外接 ApiKey + OAuth 路径(`isExternalApiKeyOAuthPath`)
      // 显式注入 `accountKind: 'external_api'`,scheduler.pick 走外接专属池;容器 OAuth
      // 路径传 undefined → scheduler 内部默认 'platform' 池,与历史等价。DeepSeek 路径在
      // pickUpstream 内早返(L341 附近),**根本不调用 scheduler.pick** —— opts 透传与否
      // 无影响,见上面"DeepSeek 路径:pickUpstream 直接合成 session"注释。
      // 外接池空抛 AccountPoolUnavailableError,handler 这里照原逻辑映 503 ACCOUNT_POOL_UNAVAILABLE
      // —— **不**降级回 platform 池(plan §1.4 隔离决策)。
      const pickRes = await pickUpstream(
        {
          scheduler: deps.scheduler,
          refreshDeps: deps.refreshDeps,
          deepseekApiKey: deps.deepseekApiKey,
          upstreamEndpoint: deps.upstreamEndpoint,
        },
        body,
        route,
        userLog,
        { accountKind: isExternalApiKeyOAuthPath ? "external_api" : undefined },
      );
      if (!pickRes.ok) {
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
        switch (pickRes.error.kind) {
          case "pool_busy":
            userLog.warn("proxy_account_pool_busy", { msg: pickRes.error.err.message });
            incrAnthropicProxyReject("account_pool_busy");
            sendJsonError(
              res,
              429,
              "ACCOUNT_POOL_BUSY",
              "all accounts busy, retry later",
              requestId,
              { "Retry-After": "5" },
            );
            return;
          case "pool_unavailable":
            userLog.warn("proxy_account_pool_unavailable", { msg: pickRes.error.err.message });
            incrAnthropicProxyReject("account_pool");
            sendJsonError(res, 503, "ACCOUNT_POOL_UNAVAILABLE", "account pool unavailable, try again", requestId);
            return;
          case "refresh_failed":
            // upstream 层已 log proxy_refresh_failed + release(transient_network|failure) + zero token。
            incrAnthropicProxyReject("upstream_auth");
            sendJsonError(res, 502, "UPSTREAM_AUTH_REFRESH_FAILED", "failed to refresh upstream token", requestId);
            return;
          case "preparation_failed":
            // upstream 层已 log proxy_upstream_preparation_failed + release(failure) + zero token。
            incrAnthropicProxyReject("upstream_auth");
            sendJsonError(res, 502, "UPSTREAM_PREPARATION_FAILED", "failed to prepare upstream session", requestId);
            return;
        }
      }
      const session: PreparedUpstreamSession = pickRes.session;

      // 8) 写 inflight journal(必须先于 fetch — 进程在 fetch 时 crash 也有线索)
      //
      // case (c) release ownership:journal fail 时 session 已 ready 但 finalizer 还没装,
      // 由 handler 调 releaseUpstreamSession(session) + session.zeroizeSecrets() 补偿。
      // DeepSeek session 的 release 是 noop(accountId=null),zeroize 也是 noop。
      try {
        await startInflightJournal(deps.pgPool, {
          requestId,
          userId: uid,
          containerId: containerIdBig,
          model: body.model,
          precheckCredits: pre.maxCost,
        });
      } catch (err) {
        await releaseUpstreamSession(
          deps.scheduler,
          session,
          { kind: "failure", error: errMessageShort(err) },
          userLog,
        );
        session.zeroizeSecrets();
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch(() => {});
        userLog.error("proxy_journal_insert_failed", { err: errSummary(err) });
        sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
        return;
      }

      // 9) 装 finalizer(从此 release 唯一调用点 = finalize)
      //
      // sessionId 由 extractSessionId(body.metadata) 算一次,既作为 finalize 配置
      // 也作为 RoundTripCtx.sessionId 传给 core.ts —— 单一权威源,避免后续广播
      // 与 finalize ledger 提取出不同结果(Codex plan v3 修订 J 锁定)。
      const sessionId = extractSessionId(body.metadata);
      const finalize = makeFinalizer(
        {
          pgPool: deps.pgPool,
          preCheckRedis: deps.preCheckRedis,
          scheduler: deps.scheduler,
        },
        {
          requestId,
          userId: uid,
          containerId: containerIdBig,
          // 2026-05-02:deepseek 路径无 OAuth 池,session.accountId=null。
          // settleUsageAndLedger / runFinalizeAndRelease 已支持 nullable。
          accountId: session.accountId,
          model: body.model,
          pricing,
          precheckCredits: pre.maxCost,
          preCheckReservation: pre.reservation,
          log: userLog,
          sessionId,
        },
      );

      // 10-11) upstream round-trip(切到 proxy/core.ts):abort 绑定 + fetch +
      // SSE 透传 + finalize + post-commit 广播 + zeroize。release 责任已在 finalize。
      await runUpstreamRoundTrip({
        pgPool: deps.pgPool,
        fetchFn,
        appendCostCredits: deps.appendCostCredits,
        broadcastToUser: deps.broadcastToUser,
        req,
        res,
        requestId,
        uid,
        body,
        session,
        finalize,
        sessionId,
        userLog,
      });
    } finally {
      releaseSlot();
    }
  };
}
