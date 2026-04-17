/**
 * @openclaude/commercial — OpenClaude 商业化模块入口
 *
 * 启用方式:在 Gateway 中通过环境变量 COMMERCIAL_ENABLED=1 启用,
 * 然后在 gateway/src/server.ts 中条件挂载(见 docs/commercial/02-ARCHITECTURE §8)。
 *
 * T-02 起,本文件在挂载时会自动跑 schema migration(除非 COMMERCIAL_AUTO_MIGRATE=0)。
 * T-16 起,registerCommercial 还会:
 *   - 装配 redis 客户端(REDIS_URL,用于限流)
 *   - 实例化 HTTP 路由处理器,通过 result.handle 暴露给 gateway
 */

import IORedis from "ioredis";
import { runMigrations } from "./db/migrate.js";
import { closePool } from "./db/index.js";
import { loadConfig } from "./config.js";
import { stubMailer } from "./auth/mail.js";
import { wrapIoredis } from "./middleware/rateLimit.js";
import { createCommercialHandler, type CommercialHandler } from "./http/router.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { PricingCache } from "./billing/pricing.js";
import { wrapIoredisForPreCheck } from "./billing/preCheck.js";
import { createHttpHupijiaoClient, type HupijiaoClient, type HupijiaoConfig } from "./payment/hupijiao/client.js";

/**
 * T-02: 是否在 registerCommercial 时自动执行 migrations。
 *
 * 规约:
 *   - 未设 / "" / "1" → true(默认开)
 *   - "0" → false(关)
 *   - 其他值(如 "true"/"false"/"yes"/"no")→ true,但打 warning,
 *     提示运维该值不会被识别为 "关",避免 "以为自己关掉了但其实没关" 的脚枪
 */
function shouldAutoMigrate(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => {
    // eslint-disable-next-line no-console
    console.warn(m);
  },
): boolean {
  const raw = env.COMMERCIAL_AUTO_MIGRATE;
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  // 无法识别的值:运维最常见的失误是写成 "true"/"false"/"no" —— 我们继续
  // 执行 migration(默认开),但要 warn。坚持 "只有 0 才关" 的严格口径,
  // 但不让它 fail hard(和 COMMERCIAL_ENABLED 的严格枚举不同)。
  warn(
    `[commercial] COMMERCIAL_AUTO_MIGRATE=${JSON.stringify(raw)} not recognized; ` +
      "auto-migrate remains ON. Use exactly '0' to disable.",
  );
  return true;
}

export interface RegisterCommercialResult {
  /**
   * HTTP 处理器:gateway 在自身 handleHttp 入口前调用,
   * 返回 true 表示已处理完毕,gateway 不再继续路由。
   */
  handle: CommercialHandler;
  /** 关闭所有商业化资源(pool / redis)。 */
  shutdown: () => Promise<void>;
}

/**
 * 注册商业化模块。
 *
 * 1. 校验 env(loadConfig)— 缺失/非法直接抛 ConfigError
 * 2. 自动跑 schema migrations(除非 COMMERCIAL_AUTO_MIGRATE=0)
 * 3. 装配 ioredis 客户端 + HTTP 处理器
 * 4. warmupLoginDummyHash 提前算 dummy argon2 hash(否则首个错登录请求要等 ~80ms)
 * 5. 返回 { handle, shutdown }
 *
 * @param app — gateway 应用对象;预留参数,目前未直接使用,以便后续 hook
 * @returns 包含 handle 和 shutdown 的对象
 */
export async function registerCommercial(
  app: unknown,
  options: {
    /** 测试可注入 jwt secret 而非从 env 读 */
    jwtSecret?: string | Uint8Array;
  } = {},
): Promise<RegisterCommercialResult> {
  void app;

  const cfg = loadConfig();

  if (shouldAutoMigrate()) {
    // eslint-disable-next-line no-console
    console.log("[commercial] auto-migrate: running...");
    const r = await runMigrations({
      // eslint-disable-next-line no-console
      onApply: (v) => console.log(`[commercial] auto-migrate applied ${v}`),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] auto-migrate done. applied=${r.applied.length} skipped=${r.skipped.length}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log("[commercial] auto-migrate disabled (COMMERCIAL_AUTO_MIGRATE=0)");
  }

  const jwtSecret =
    options.jwtSecret ??
    process.env.COMMERCIAL_JWT_SECRET ??
    process.env.JWT_SECRET ??
    "";
  if (typeof jwtSecret === "string" && jwtSecret.length === 0) {
    throw new Error(
      "[commercial] COMMERCIAL_JWT_SECRET (or JWT_SECRET) must be set when COMMERCIAL_ENABLED=1",
    );
  }

  const redis = new IORedis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  // 预热 dummy hash:第一次登录无影响
  await warmupLoginDummyHash();

  // T-20: 初始化定价缓存。启动时 load,并开启 LISTEN pricing_changed
  // 以便 admin UI 改价时自动 reload。两步失败都不阻塞启动,让 gateway
  // 继续上线;HTTP handler 在 cache 空时会返 503 PRICING_NOT_READY,
  // 而 pricing 热路径(T-21 计费)会直接得到 "unknown model" —— 比把
  // 整个服务卡死更好。
  const pricing = new PricingCache();
  try {
    await pricing.load();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing initial load failed:", err);
  }
  try {
    await pricing.startListener(cfg.DATABASE_URL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing LISTEN setup failed:", err);
  }

  // T-24 虎皮椒:三件套齐全 → 生产 client;否则 undefined(handler 会 503)
  let hupijiao: HupijiaoClient | undefined;
  let hupijiaoConfig: Pick<HupijiaoConfig, "appId" | "appSecret"> | undefined;
  if (cfg.HUPIJIAO_APP_ID && cfg.HUPIJIAO_APP_SECRET && cfg.HUPIJIAO_CALLBACK_URL) {
    const fullCfg: HupijiaoConfig = {
      appId: cfg.HUPIJIAO_APP_ID,
      appSecret: cfg.HUPIJIAO_APP_SECRET,
      notifyUrl: cfg.HUPIJIAO_CALLBACK_URL,
      returnUrl: cfg.HUPIJIAO_RETURN_URL,
      endpoint: cfg.HUPIJIAO_ENDPOINT,
    };
    hupijiao = createHttpHupijiaoClient(fullCfg);
    hupijiaoConfig = { appId: fullCfg.appId, appSecret: fullCfg.appSecret };
  }

  const handler = createCommercialHandler({
    jwtSecret,
    mailer: stubMailer,
    redis: wrapIoredis(redis),
    turnstileSecret: cfg.TURNSTILE_SECRET,
    turnstileBypass: cfg.TURNSTILE_TEST_BYPASS,
    verifyEmailUrlBase: process.env.COMMERCIAL_BASE_URL,
    resetPasswordUrlBase: process.env.COMMERCIAL_BASE_URL,
    pricing,
    // T-23 preCheck 复用限流用的 ioredis 客户端(SCAN / SET EX 都 OK)
    preCheckRedis: wrapIoredisForPreCheck(redis),
    hupijiao,
    hupijiaoConfig,
  });

  return {
    handle: handler,
    shutdown: async () => {
      try { await pricing.shutdown(); } catch { /* ignore */ }
      try { await redis.quit(); } catch { /* ignore */ }
      await closePool();
    },
  };
}

export const COMMERCIAL_VERSION = "0.1.0";
// 便于 gateway / 测试单独访问
export { runMigrations } from "./db/migrate.js";
export { shouldAutoMigrate };
export { createCommercialHandler } from "./http/router.js";
export type { CommercialHandler } from "./http/router.js";
export type { CommercialHttpDeps } from "./http/handlers.js";
export { PricingCache, perKtokCredits } from "./billing/pricing.js";
export type { ModelPricing, PublicModel } from "./billing/pricing.js";
export { computeCost } from "./billing/calculator.js";
export type { TokenUsage, PriceSnapshot, CostResult } from "./billing/calculator.js";
export {
  debit,
  credit,
  adminAdjust,
  getBalance,
  listLedger,
  InsufficientCreditsError,
  LEDGER_REASONS,
} from "./billing/ledger.js";
export type {
  LedgerReason,
  LedgerRef,
  DebitResult,
  AdminAdjustResult,
  LedgerRow,
} from "./billing/ledger.js";
export {
  preCheck,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError as PreCheckInsufficientCreditsError,
  InMemoryPreCheckRedis,
  wrapIoredisForPreCheck,
} from "./billing/preCheck.js";
export type {
  PreCheckRedis,
  PreCheckInput,
  PreCheckResult,
} from "./billing/preCheck.js";
export { stubChatLLM } from "./http/chat.js";
export type { ChatLLM, ChatBody } from "./http/chat.js";
export {
  signHupijiao,
  verifyHupijiao,
  buildSignBase,
} from "./payment/hupijiao/sign.js";
export type { SignParams } from "./payment/hupijiao/sign.js";
export {
  createHttpHupijiaoClient,
  HupijiaoError,
} from "./payment/hupijiao/client.js";
export type {
  HupijiaoClient,
  HupijiaoConfig,
  CreateQrInput,
  CreateQrResult,
} from "./payment/hupijiao/client.js";
export {
  listPlans,
  getPlanByCode,
  generateOrderNo,
  createPendingOrder,
  getOrderByNo,
  markOrderPaid,
  expirePendingOrders,
  ORDER_STATUSES,
  PlanNotFoundError,
  OrderNotFoundError,
  InvalidOrderStateError,
} from "./payment/orders.js";
export type {
  TopupPlan,
  OrderRow,
  OrderStatus,
  CreatePendingOrderInput,
  MarkOrderPaidInput,
  MarkOrderPaidResult,
} from "./payment/orders.js";
