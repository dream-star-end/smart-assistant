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
 *   7) pickUpstream(scheduler.pick + refresh / 静态 key 合成 session)
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
import { STATIC_PROVIDER_META } from "./staticProviderMeta.js";
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
  extractUsageAttribution,
  stripUsageAttributionKeys,
  readBoundedJson,
  sendJsonError,
  stripNonTextContentBlocks,
  errMessageShort,
  errSummary,
  applyModelDefaultEffort,
} from "./shared.js";

import { runUpstreamRoundTrip } from "./core.js";
import { buildPlatformEnvelope } from "../../platform/platformEnvelopeBuilder.js";

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

      // 5b') per-model 默认思考深度注入(0105 model_pricing.default_effort,admin 运维页可配)。
      // client 显式 effort 优先、合并不覆盖;详见 shared.applyModelDefaultEffort 注释。
      applyModelDefaultEffort(body, pricing.default_effort);

      // 5c) Upstream route 选择 + 配置早拒绝(2026-05-18 Phase 3 §3.4 切出)。
      //
      // **必须在 preCheck 之前**:静态 provider 路由缺 key 直接 503,不能 reserve credits 再 rollback。
      // 详见 `proxy/upstream.ts` selectUpstreamRoute / validateUpstreamConfig 注释 + plan 行为锁。
      const route = selectUpstreamRoute(body.model);
      const cfgErr = validateUpstreamConfig(route, {
        staticProviderKeys: deps.staticProviderKeys,
      });
      if (cfgErr) {
        // cfgErr.kind === "static_not_configured" —— 由 provider 的 commercial 语义映射决定
        // 503 错误码 + reject metric(deepseek/minimax/ark 各自一套，新增 provider 零改本处)。
        const meta = STATIC_PROVIDER_META[cfgErr.providerId];
        userLog.warn("proxy_static_provider_not_configured", {
          provider: cfgErr.providerId,
          model: body.model,
        });
        incrAnthropicProxyReject(meta.rejectMetricLabel);
        sendJsonError(
          res,
          503,
          meta.notConfiguredHttpCode,
          `${cfgErr.providerId} upstream not configured`,
          requestId,
        );
        return;
      }

      // 5d) Phase 5 platform envelope rewriter(2026-05-21,外接 ApiKey 路径
      // envelope rewrite 唯一入口;早期 Phase 4/7 同位置曾有 v1 helper,Step 8
      // 已整合删除)。
      //
      // 仅"外接 ApiKey 路径(containerId===null)+ OAuth 上游(route.kind==='oauth')"
      // 双重命中才走。容器路径(containerId !== null)/ 静态 key 路径(route.kind==='static',
      // deepseek/minimax/ark)绝不触发 —— 容器内 CCB 已构造好 body,静态 provider 用独立 API key
      // 无 OAuth 池无 anti-abuse 反风控,任一注入只浪费 token 或破坏既有缓存。
      //
      // **必须在 `estimateInputTokens(body)` 之前** + `selectUpstreamRoute` 之后
      // (Phase 7 §3.5.2 行为锁):注入的 sysprompt prefix + platform context
      // attribution + system-reminder 替换全部进 preCheck 估算 —— 任何 mutate body
      // 的步骤都要先于 input token 估算,账务边界干净。
      //
      // 跟 Phase 5 builder 的契约对齐:
      //   - 在 pickUpstream **之前** 调用(OAuth account 尚未选定,派生不能依赖
      //     account.id;用 HMAC(serverSecret, userId) 跨 master 派生稳定 fp3)
      //   - loader/secret 缺一 → fail-closed 503,避免装配 bug 让客户端 raw body
      //     透传到 Anthropic(PII 泄露 + 形态漂移触发整池 429)
      //   - loader.load 与 builder 内部均吞错不抛(plan §3.7/§3.1 H1 不变量),
      //     这里不加 try/catch 显式 noise(CLAUDE.md "Don't add error handling
      //     for scenarios that can't happen")
      if (identity.containerId === null && route.kind === "oauth") {
        if (!deps.platformContextLoader || !deps.platformServerSecret) {
          userLog.error("phase5_envelope_misconfigured", {
            hasLoader: Boolean(deps.platformContextLoader),
            hasSecret: Boolean(deps.platformServerSecret),
          });
          incrAnthropicProxyReject("platform_envelope");
          sendJsonError(
            res,
            503,
            "PLATFORM_ENVELOPE_UNAVAILABLE",
            "platform envelope misconfigured",
            requestId,
          );
          return;
        }
        const platformCtx = await deps.platformContextLoader.load(uid);
        const envelopeResult = buildPlatformEnvelope({
          body,
          ctx: platformCtx,
          userId: uid,
          serverSecret: deps.platformServerSecret,
          log: userLog,
        });
        userLog.info("phase5_envelope_built", {
          systemBlocks: envelopeResult.systemBlocks,
          piiHits: envelopeResult.piiStrippedIndexes.length,
          reminderReplaced: envelopeResult.systemReminderReplaced,
          ctxAvailable: platformCtx !== null,
          fp3: envelopeResult.fp3,
        });
      }

      // 5e) 静态 key **文本 provider**(deepseek/minimax/ark)text-only 输入兜底。
      //
      // 这些上游全是纯文本模型(代码通篇命名即"文本 provider"):ark glm-5.1 Coding Plan
      // 端点实测对含 image 的请求返回 400 `{"code":"InvalidParameter","message":"...Model
      // only support text input..."}`。图片为何会到这:gateway 入站已把用户**上传**的图转成
      // 纯文本提示(server.ts "No image content blocks"),但 image 仍会经**工具结果**(Read
      // 图片 / 浏览器截图 / 返图 MCP)写进 CCB 历史 transcript,作为 tool_result.content[]
      // 内嵌 block 长期驻留,每个 turn 重放 → 永久 400 + 重试风暴。
      //
      // **必须在 `estimateInputTokens(body)` / 静态 input cap / preCheck 之前**:否则历史里
      // 的大 base64 图会(a)被下方静态 provider 200k/512k input cap 误判 413(本地卡死,
      // 与上游 400 同样卡会话),(b)高估 preCheck 预留 cost。strip 后估算/cap/上游 body 同口径。
      // 注:**多模态静态 provider(supportsVision=true,如 MiniMax-M3)不 strip 图** —— 它原生识图;
      // 其余纯文本静态 provider(deepseek/ark glm-5.x)仍 strip(模型看不到图,靠 understand_image 工具兜底)。
      if (route.kind === "static" && !route.provider.supportsVision) {
        const stripped = stripNonTextContentBlocks(body.messages);
        if (stripped.imagesStripped + stripped.documentsStripped > 0) {
          body.messages = stripped.messages as typeof body.messages;
          userLog.warn("proxy_static_text_only_nontext_stripped", {
            provider: route.provider.id,
            model: body.model,
            images: stripped.imagesStripped,
            documents: stripped.documentsStripped,
          });
        }
      }

      // 6) 双侧 cost 估算 + preCheck(原子预留:Lua 一次完成 余额比对 + 写入)
      const inputTokens = estimateInputTokens(body);
      // 静态 provider input 上限 guard(注册表 spec.maxInputTokens；deepseek 无 cap=undefined)。
      // 注意 inputTokens 是 estimateInputTokens 的**估算值**(JSON.length/4，非真 tokenizer)，
      // 故此 cap 是粗 guardrail：防超模型上下文窗(如 glm-5.1 200k / MiniMax-M3 512k)无声进更贵档。
      // **supportsVision provider(MiniMax-M3)跳过此 cap**:vision 请求含大 base64 image，
      // JSON.length/4 会把图当文本 token 严重高估(2MB 图≈725k「token」)而误撞文本 context cap →
      // understand_image 永远 413。图请求的真正体积上限由下游 enforceFieldByteBudgets(messages 8MB)兜底。
      if (
        route.kind === "static" &&
        !route.provider.supportsVision &&
        route.provider.maxInputTokens != null &&
        inputTokens > route.provider.maxInputTokens
      ) {
        userLog.warn("proxy_static_provider_input_tokens_too_large", {
          provider: route.provider.id,
          model: body.model,
          estimatedInputTokens: inputTokens,
          limit: route.provider.maxInputTokens,
        });
        incrAnthropicProxyReject("too_large");
        sendJsonError(res, 413, "BODY_FIELD_TOO_LARGE", "request body too large", requestId);
        return;
      }
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
      // 静态 key 路径(route.kind==='static'):pickUpstream 直接合成 session(无 pool 访问)。
      // v3 反关联根治 UX 闭环 — 解析客户端 force_repin 头:
      //   `x-force-repin: 1` → 客户端在收到 409 SessionPinUnbound 后选择"保留对话历史"
      //   路径,要求 scheduler 在同 session 上覆盖原 unbound pin 选新账号。仅在
      //   sessionPinMode='enforce' 路径有意义,其它模式静默忽略。
      //
      // 严格只接受 '1' / 'true'(大小写不敏感)以防意外触发。Node 默认 header 名 lowercased。
      const forceRepinHeader = req.headers["x-force-repin"];
      const forceRepin =
        typeof forceRepinHeader === "string" &&
        (forceRepinHeader === "1" || forceRepinHeader.toLowerCase() === "true");

      const pickRes = await pickUpstream(
        {
          scheduler: deps.scheduler,
          refreshDeps: deps.refreshDeps,
          staticProviderKeys: deps.staticProviderKeys,
          upstreamEndpoint: deps.upstreamEndpoint,
          // Phase 6 account_uuid 锚定 flag(plan §3.0)— v1.0.207 起从 system_settings
          // 表读取的 getter,handler 透传给 pickUpstream;入口 await 一次冻结到
          // 局部常量,scheduler.pick 与 hook 同值消费(plan §5.5.4 防热改竞态)。
          getPhase6AccountUuidEnforce: deps.getPhase6AccountUuidEnforce,
          // v3 反关联根治 — session pin 三态(off/observe/enforce)同型 getter。
          // 30s TTL cache,admin UI 改完立即 invalidate 本机进程的 cache。
          getSessionPinMode: deps.getSessionPinMode,
          listEnabledAccountGroupsForModel: deps.listEnabledAccountGroupsForModel,
        },
        body,
        route,
        userLog,
        uid,
        forceRepin,
      );
      if (!pickRes.ok) {
        // 释放失败仅告警不阻断(TTL 300s 自愈兜底);但 Redis 故障时预留泄漏必须可观测。
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch((e: unknown) => {
          userLog.warn("precheck_release_failed", { msg: (e as Error)?.message ?? String(e) });
        });
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
          case "pool_unavailable": {
            // Codex round 1 MAJOR 4:Phase 6 fail_closed 把没回填 uuid 的账号
            // 从候选池滤掉,导致全池为空时 scheduler 会抛 AccountPoolUnavailableError
            // ('no_uuid') —— 跟"账号全 disabled"的 'no_active' 共用 metric label
            // 会让运维看仪表盘分不清"backfill 没跑完"和"账号全爆"。按 err.reason
            // 拆 label;message 本身带 "account pool unavailable: " 前缀,用结构化
            // 字段而非 substring-match,避免维护漂移。
            // 'no_uuid_post_scheduler' 是 pickUpstream 层 race-condition 防御性
            // reject(scheduler 应已过滤 NULL,这里是 defense-in-depth)。
            const reason = pickRes.error.err.reason;
            const label =
              reason === "no_uuid" || reason === "no_uuid_post_scheduler"
                ? "account_pool_no_uuid"
                : reason === "egress_unavailable"
                  ? // A2 — 已绑账号出口解析失败被 fail-closed 拒发(非账号池耗尽),
                    // 单独打标签让运维仪表盘区分"出口/代理坏了"与"账号全爆"。
                    "account_pool_egress_unavailable"
                  : "account_pool";
            userLog.warn("proxy_account_pool_unavailable", {
              msg: pickRes.error.err.message,
              reason,
            });
            incrAnthropicProxyReject(label);
            sendJsonError(res, 503, "ACCOUNT_POOL_UNAVAILABLE", "account pool unavailable, try again", requestId);
            return;
          }
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
          case "session_pin_unbound": {
            // v3 反关联根治 — pin 已 cascade unbind(绑定账号被 ban)。
            //
            // 推荐客户端走 `retry_strategy='force_repin'`:同 session 重发请求 + 加
            // `x-force-repin: 1` 头,scheduler 会在同 session 上覆盖 unbound pin
            // 选新账号 → 保留对话历史,用户感知只是"上一轮慢"。
            //
            // 老客户端不识别 retry_strategy 字段时回落 `action='reset_session'`
            // (走"开新会话"路径),两边都不会卡死。
            userLog.warn("proxy_session_pin_unbound", { msg: pickRes.error.err.message });
            incrAnthropicProxyReject("session_pin_unbound");
            sendJsonError(
              res,
              409,
              "SESSION_PIN_UNBOUND",
              pickRes.error.err.message,
              requestId,
              undefined,
              {
                type: "session_pin_unbound",
                action: pickRes.error.err.action, // 'reset_session' — 老 client fallback
                retry_strategy: pickRes.error.err.retryStrategy, // 'force_repin' — 新 client 路径
              },
            );
            return;
          }
          case "session_pin_temporarily_unavailable": {
            // v3 反关联根治 — pin 指向账号瞬时不可用(cooldown / cap / race-lost
            // winner 不在 pool)。scheduler.pick() facade 已在 server 内吃掉短
            // cooldown(<3s);走到这里说明:
            //   - cooldown 超过 SHORT_BACKOFF_MS(3s),或
            //   - 累计已用满 HARD_TIMEOUT_MS(5s)预算,或
            //   - immediateRetries 用尽
            //
            // 给客户端两个层次的 hint:
            //   - Retry-After 秒(老客户端友好,标准 HTTP 重试头),
            //     Math.max(1) 防 Retry-After:0 这种 RFC 灰区。
            //   - retry_after_ms / fallback_strategy(新客户端精确控制 + 二次升级路径)。
            const retryMs = pickRes.error.err.retryAfterMs;
            const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
            userLog.warn("proxy_session_pin_temporarily_unavailable", {
              msg: pickRes.error.err.message,
              retryAfterMs: retryMs,
            });
            incrAnthropicProxyReject("session_pin_temporarily_unavailable");
            sendJsonError(
              res,
              503,
              "SESSION_PIN_TEMPORARILY_UNAVAILABLE",
              "session pinned account temporarily unavailable, retry shortly",
              requestId,
              { "Retry-After": String(retrySec) },
              {
                type: "session_pin_temporarily_unavailable",
                retry_after_ms: retryMs,
                fallback_strategy: pickRes.error.err.fallbackStrategy, // 'force_repin_after_retry'
              },
            );
            return;
          }
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
        await releasePreCheck(deps.preCheckRedis, pre.reservation).catch((e: unknown) => {
          userLog.warn("precheck_release_failed", { msg: (e as Error)?.message ?? String(e) });
        });
        userLog.error("proxy_journal_insert_failed", { err: errSummary(err) });
        sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
        return;
      }

      // 9) 装 finalizer(从此 release 唯一调用点 = finalize)
      //
      // 归因四元组(sessionId/mode/parentSessionId/delegateAgentId)由
      // extractUsageAttribution(body.metadata) 算一次,sessionId 既作为 finalize
      // 配置也作为 RoundTripCtx.sessionId 传给 core.ts —— 单一权威源,避免后续
      // 广播与 finalize ledger 提取出不同结果(Codex plan v3 修订 J 锁定)。
      const attribution = extractUsageAttribution(body.metadata);
      const sessionId = attribution.sessionId;
      // 归因键已提取完毕 → 从 user_id JSON 剥掉 oc_ 内部键再转发上游
      // (内部会话拓扑不出代理;普通 chat 请求无 oc_ 键,原串零改写)。
      if (body.metadata?.user_id !== undefined) {
        body.metadata.user_id = stripUsageAttributionKeys(body.metadata.user_id);
      }
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
          // B7 per-slot 租约:slotId 随 session 带到 finalize → 权威 release 精确还槽。
          // OAuth 非 null;DeepSeek/MiniMax null(与 accountId 同生死,finalize 跳过 release)。
          slotId: session.slotId,
          model: body.model,
          pricing,
          precheckCredits: pre.maxCost,
          preCheckReservation: pre.reservation,
          log: userLog,
          sessionId,
          // delegate 子会话计费归因(mode='delegate' + 父客户端会话 + 目标 agent);
          // 普通 chat 恒 ('chat', null, null),settle 落库行为与旧版一致。
          mode: attribution.mode,
          parentSessionId: attribution.parentSessionId,
          delegateAgentId: attribution.delegateAgentId,
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
        // delegate 子会话的父客户端会话 id(web-*);普通 chat 恒 null
        // (extractUsageAttribution 保证)。core 据此 park 委派成本(durable)+ 广播路由。
        parentSessionId: attribution.parentSessionId,
        // P2 债D — 委派目标 agent id(与 parentSessionId 同源 attribution);普通 chat 恒 null。
        // core park 进 pending.delegate_agent_id,drain 产出 usage.delegates[] 明细。
        delegateAgentId: attribution.delegateAgentId,
        userLog,
      });
    } finally {
      releaseSlot();
    }
  };
}
