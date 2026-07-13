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
  UnroutableProviderError,
  checkCapabilityWithinCeiling,
  pickUpstream,
  providerCapabilityCeiling,
  releaseUpstreamSession,
  selectUpstreamRoute,
  validateUpstreamConfig,
  type PreparedUpstreamSession,
  type UpstreamRoute,
} from "./upstream.js";
import {
  ModelGateReject,
  enforceModelAuthority,
  type GateRejectKind,
  type ModelAuthorityDecision,
} from "./modelAuthorityGate.js";
import { STATIC_PROVIDER_META } from "./staticProviderMeta.js";
import { findRouteProviderForModel } from "@openclaude/protocol";
import { getDegradedProviders } from "../../admin/providerHealthGate.js";
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
import { trackModelRequestStart, trackModelRequestEnd } from "./inflightTracker.js";

import { runUpstreamRoundTrip } from "./core.js";
import { buildPlatformEnvelope } from "../../platform/platformEnvelopeBuilder.js";
import { recordUserImpactBestEffort } from "../../selfheal/userImpact.js";

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

/** 建议清单上限(错误文案里列太多反而没人看)。 */
const MAX_DEGRADED_ALTERNATIVES = 8;

/**
 * provider 降级时的"建议改用"清单(MINOR-4,2026-07-12)。
 *
 * **归属权威 = catalog 的 provider_id**(gate 生效时)。此前这里用 legacy
 * `findRouteProviderForModel(m.id)` —— 那是**静态 route registry 的名字前缀推断**:catalog 里
 * 自定义了 provider_id 的行会被推断成另一个(甚至 undefined)provider,于是"建议改用"里可能
 * 塞回**同一个已降级 provider** 的模型 —— 把用户从坑里指回坑里(而且是在他刚被 503 的那一刻)。
 *
 * 范围 = public 可见集(与 legacy listPublic 同口径:不泄漏 admin/hidden 模型的存在)。
 * 不按 engine 过滤:codex 模型对**用户**是合法替代(前端可切),只是不走本代理。
 *
 * 导出仅为单测(纯函数,不碰 DB);handler 之外无其它调用方。
 */
export function degradedAlternatives(args: {
  gate: ModelAuthorityDecision | null;
  pricing: AnthropicProxyDeps["pricing"];
  uid: bigint;
  degraded: ReadonlySet<string>;
}): string[] {
  if (args.gate) {
    return args.gate.snapshot
      .listForUser({ uid: args.uid.toString(), role: "user", grantedModelIds: new Set<string>() })
      .filter((m) => !m.providerId || !args.degraded.has(m.providerId))
      .map((m) => m.modelId)
      .slice(0, MAX_DEGRADED_ALTERNATIVES);
  }
  // legacy(catalog 未接线):route registry 推断归属,保持本批次之前的行为。
  return args.pricing
    .listPublic()
    .filter((m) => {
      const pid = findRouteProviderForModel(m.id)?.id;
      return !pid || !args.degraded.has(pid);
    })
    .map((m) => m.id)
    .slice(0, MAX_DEGRADED_ALTERNATIVES);
}

/** 模型权威 gate 的拒绝类型 → reject metric 标签(运维仪表盘按这个分流告警)。 */
const GATE_REJECT_METRIC: Record<GateRejectKind, ProxyRejectReason> = {
  not_available: "model_not_available",
  authority_invalid: "model_authority_invalid",
  config_changed: "model_config_changed",
  catalog_unavailable: "model_catalog_unavailable",
};

/**
 * 影子双读(方案 §7 步 2 的"零漂移锚"):catalog 判定 vs legacy 判定,只对比、只打日志,
 * **绝不改变行为**。开 flag 前用它证明"切判定源不会改变任何一个请求的命运"。
 *
 * 全程 fail-soft:影子对比自身出任何问题(快照 unknown / DB 抖动)都不能影响正在跑的请求。
 */
function observeCatalogShadow(
  catalog: NonNullable<AnthropicProxyDeps["modelCatalog"]>,
  model: string,
  pricing: AnthropicProxyDeps["pricing"],
  log: ReturnType<typeof rootLogger.child>,
): void {
  try {
    // peek():影子面允许 unknown(不 fence、不重建);拿不到快照就跳过本次对比。
    const snapshot = catalog.peek();
    if (!snapshot) return;
    const canonical = snapshot.aliasToCanonical(model);
    const catalogRoutable = snapshot.isRoutable(canonical);
    const legacyRow = pricing.get(model);
    const legacyRoutable = Boolean(legacyRow?.enabled);
    const catalogProvider = catalogRoutable ? (snapshot.resolve(canonical)?.providerId ?? null) : null;
    // legacy 的 OAuth 路径没有 provider id(matchesRoute 不命中 = OAuth);catalog 用虚拟条目
    // 'anthropic' 表达同一件事 → 归一后再比,否则每个 OAuth 模型都会报一次假漂移。
    const legacyProvider = catalogRoutable
      ? (findRouteProviderForModel(model)?.id ?? "anthropic")
      : null;
    if (catalogRoutable !== legacyRoutable || catalogProvider !== legacyProvider) {
      log.warn("model_authority_shadow_drift", {
        model,
        canonical,
        catalogRoutable,
        legacyRoutable,
        catalogProvider,
        legacyProvider,
      });
    }
  } catch (err) {
    log.warn("model_authority_shadow_failed", { err: errSummary(err) });
  }
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

      // 4b) 模型执行权威 gate(模型权威批次 · 方案 §1.2/§4)。
      //
      // **必须在授权 / 路由 / preCheck 之前**:它做三件事 ——
      //   ① 每请求 epoch fence(单行 SELECT,不做时间微缓存)→ 拿到与 DB 线性化的 catalog 快照;
      //   ② 可用性判定(catalog active + 有价 + capability schema 可理解);
      //   ③ 校验请求携带的凭据(bridge 签名 envelope/lease,或本地路径 local_catalog token)。
      //
      // 三态:
      //   - 未注入 catalog        → 完全 legacy(本批次之前的行为,零变化);
      //   - 注入但 enforce=false  → **影子期**:catalog 判定与 legacy 判定对比打日志(零漂移锚),
      //                             拒绝权仍在 legacy(§7 步 2 部署基建不改变用户可见行为);
      //   - enforce=true          → 判定权在 catalog,拒绝一律 fail-closed(§7 步 4)。
      let gate: ModelAuthorityDecision | null = null;
      if (deps.modelCatalog && deps.modelAuthorityEnforce) {
        try {
          gate = await enforceModelAuthority({
            catalog: deps.modelCatalog,
            keyring: deps.authorityKeyring?.() ?? null,
            headers: req.headers,
            uid,
            containerId: containerIdBig,
            model: body.model,
            loadUserModelAuthz: deps.loadUserModelAuthz,
          });
        } catch (err) {
          if (err instanceof ModelGateReject) {
            userLog.warn("proxy_model_authority_rejected", {
              kind: err.kind,
              code: err.code,
              // detail 只进日志,不出网(错误响应统一通用文案,不回显 engine/provider/revision)。
              detail: err.detail,
              model: body.model,
            });
            incrAnthropicProxyReject(GATE_REJECT_METRIC[err.kind]);
            sendJsonError(res, err.status, err.code, err.clientMessage, requestId);
            return;
          }
          throw err;
        }
        // alias 归一到 master 权威的 canonical id:此后**全链**(pricing/授权/限流指标/journal/
        // usage_records/广播)都用 canonical,避免"用户传 alias、计费落 alias"的双 id 面。
        // 发往上游的 model 名另由 session.upstreamModel 决定(core.ts)。
        body.model = gate.canonicalModel;
      } else if (deps.modelCatalog) {
        observeCatalogShadow(deps.modelCatalog, body.model, deps.pricing, userLog);
      }

      // 5) 取 pricing。authority 路径必须消费 gate 所在**同一 fenced snapshot**里的价格，
      // 不再回读异步 PricingCache；否则改价 NOTIFY 延迟时会以另一 generation 结算。
      //
      // enforce 路径不再看 `pricing.enabled`:可用性的唯一权威是 catalog.state(0143 起
      // enabled 只是派生镜像),且 gate 的 isRoutable 已经断言"有价格行"。snapshot 投影为空
      // 代表内部不变量破坏；legacy cache miss 则仍按 unknown_model 拒(fail-closed)。
      const pricing = gate
        ? gate.snapshot.billingPricingFor(body.model)
        : deps.pricing.get(body.model);
      if (!pricing || (!gate && !pricing.enabled)) {
        userLog.warn("proxy_unknown_model", { model: body.model, catalogGated: gate !== null });
        incrAnthropicProxyReject("unknown_model");
        sendJsonError(res, 400, "UNKNOWN_MODEL", `model '${body.model}' not enabled`, requestId);
        return;
      }

      // 5a') provider 健康度拦截(P3.2)。**默认影子模式放行**:仅 OC_PROVIDER_HEALTH_ENFORCE=1
      // 才对 degraded provider 的模型 503(误判降级=拦好模型是最坏 UX,故拦截显式开关控)。
      // degraded 权威 = provider_ops 健康列(effectiveHealth 派生,与 pricing.enabled/visibility
      // 正交,红线②)。只治理静态 provider;OAuth/claude 归 account-pool。fail-soft:读失败空集放行。
      // 不做隐式换模型(红线①):只 503 + 建议同类可用清单,用户/客户端自己换。
      if (process.env.OC_PROVIDER_HEALTH_ENFORCE === "1") {
        // provider 归属:catalog 判定生效时以 catalog 的 provider_id 为准(数据驱动);
        // legacy 期仍走 matchesRoute 推断。
        const providerId = gate
          ? (gate.descriptor.providerId ?? undefined)
          : findRouteProviderForModel(body.model)?.id;
        if (providerId) {
          const degradedSet = await getDegradedProviders();
          if (degradedSet.has(providerId)) {
            const alts = degradedAlternatives({
              gate,
              pricing: deps.pricing,
              uid,
              degraded: degradedSet,
            });
            userLog.warn("proxy_provider_degraded", { model: body.model, provider: providerId });
            incrAnthropicProxyReject("provider_degraded");
            recordUserImpactBestEffort({
              conditionKey: `health.provider_degraded:${providerId}`,
              userId: uid,
              requestId,
              target: `provider:${providerId}`,
              failureCode: "PROVIDER_DEGRADED",
              detail: { model: body.model, provider: providerId },
            });
            sendJsonError(
              res,
              503,
              "PROVIDER_DEGRADED",
              `${providerId} 服务商暂时不可用,建议改用:${alts.join("、") || "(暂无同类可用模型)"}`,
              requestId,
              { "retry-after": "60" },
              { provider: providerId, alternatives: alts, retry_after_ms: 60_000 },
            );
            return;
          }
        }
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
        await deps.identity.authorize(identity, pricing, body.model, gate?.securityEpoch);
      } catch (err) {
        if (err instanceof AuthzLoadError) {
          userLog.error("proxy_authz_load_failed", { err: errSummary(err.cause) });
          recordUserImpactBestEffort({
            conditionKey: "ops.monitor:svc_v5", userId: uid, requestId,
            target: "service:v5", failureCode: "INTERNAL_AUTHZ_LOAD",
          });
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

      // 5b'') per-model 在飞计量(0106,admin 容量面)。res 'close' 在正常完结/断流/超时都
      // 恰好触发一次 → 单次递减无泄漏;放在模型校验/授权之后,计的是真正进入上游链路的请求。
      trackModelRequestStart(body.model);
      {
        const inflightModel = body.model;
        res.once("close", () => trackModelRequestEnd(inflightModel));
      }

      // 5c) Upstream route 选择 + 配置早拒绝(2026-05-18 Phase 3 §3.4 切出)。
      //
      // **必须在 preCheck 之前**:静态 provider 路由缺 key 直接 503,不能 reserve credits 再 rollback。
      // 详见 `proxy/upstream.ts` selectUpstreamRoute / validateUpstreamConfig 注释 + plan 行为锁。
      //
      // 模型权威批次:gate 生效时按 **catalog 的 provider_id** 选 provider 机制、按
      // **upstream_model_id ?? model_id** 决定上游 model 名(matchesRoute 降级为迁移期回落)。
      let route: UpstreamRoute;
      try {
        route = selectUpstreamRoute(
          body.model,
          gate
            ? {
                providerId: gate.descriptor.providerId,
                upstreamModelId: gate.descriptor.upstreamModelId,
              }
            : undefined,
        );
      } catch (err) {
        if (err instanceof UnroutableProviderError) {
          // 配置事故:catalog 里写了本进程不认识的 provider 机制。静默回落 OAuth 会把它发到
          // Anthropic 账号池上烧真钱 → 响亮 503 + error 日志(运维必须去修 catalog 行)。
          userLog.error("proxy_unroutable_provider", {
            provider: err.providerId,
            model: body.model,
          });
          incrAnthropicProxyReject("model_config_invalid");
          sendJsonError(res, 503, "MODEL_NOT_AVAILABLE", "model not available", requestId);
          return;
        }
        throw err;
      }

      // 5c') 能力上限:catalog 声明的 capability ⊆ provider **机制**上限(方案 §4)。
      // 声明 vision 而上游纯文本 → 图片进上游必 400 打死会话;声明 effort 而上游 strip
      // output_config → 用户选了没效果。两者都是配置事故,fail-closed 拒而不是"尽力跑"。
      if (gate) {
        const violation = checkCapabilityWithinCeiling(
          {
            supportsVision: gate.descriptor.capabilityProfile.supportsVision,
            supportedEfforts: gate.descriptor.capabilityProfile.reasoning.supported,
          },
          providerCapabilityCeiling(route),
        );
        if (violation) {
          userLog.error("proxy_capability_exceeds_provider", {
            model: body.model,
            provider: gate.descriptor.providerId,
            violation,
          });
          incrAnthropicProxyReject("model_config_invalid");
          sendJsonError(res, 503, "MODEL_NOT_AVAILABLE", "model not available", requestId);
          return;
        }
      }

      /**
       * 该**模型**是否原生识图。
       *
       * gate 生效 → 取 catalog 行的 per-model capability(方案 §4 "proxy 清洗消费 catalog 行
       * per-model");legacy → 沿用 provider 级 spec.supportsVision(现状)。
       * 二者的差别正是本批次要解决的一类问题:同一 provider 下未来会同时有多模态与纯文本型号,
       * provider 级 flag 表达不了。
       */
      const modelSupportsVision = gate
        ? gate.descriptor.capabilityProfile.supportsVision
        : route.kind === "static"
          ? route.provider.supportsVision === true
          : true;
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
      if (route.kind === "static" && !modelSupportsVision) {
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
        !modelSupportsVision &&
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
            recordUserImpactBestEffort({
              conditionKey: "account_pool.all_down",
              userId: uid,
              requestId,
              target: `model:${body.model}`,
              failureCode: "ACCOUNT_POOL_UNAVAILABLE",
              detail: { model: body.model, reason },
            });
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
          ctxJson: gate
            ? {
                authorityKind: gate.authorityKind,
                executionRevision: gate.executionRevision,
                projectionRevision: gate.projectionRevision,
                billingRevision: gate.snapshot.billingRevision,
                securityEpoch: gate.securityEpoch.toString(),
                source: "ccb_proxy",
              }
            : undefined,
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
        recordUserImpactBestEffort({
          conditionKey: "ops.monitor:svc_v5", userId: uid, requestId,
          target: "service:v5", failureCode: "INTERNAL_JOURNAL_WRITE",
        });
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
          // 模型权威留证(0143 四列;方案 §4 / R3-m11)。gate 未生效(legacy / 影子期)→ 全 NULL,
          // 与本批次之前的落库形状一致。有值时可事后回答:这一笔是按哪个执行快照、哪个 epoch、
          // 凭哪类权威扣的钱。
          authority: gate
            ? {
                executionRevision: gate.executionRevision,
                projectionRevision: gate.projectionRevision,
                securityEpoch: gate.securityEpoch,
                kind: gate.authorityKind,
              }
            : null,
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
