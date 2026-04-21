/**
 * T-15 — Redis 限流(滑动窗口的固定窗口近似版,MVP 足够)。
 *
 * 设计:
 *   - 框架无关:核心是 `checkRateLimit(...)` 纯函数,T-16 再包成 Express 中间件
 *   - 算法:固定窗口(`Math.floor(now / window) * window` 作为窗口起点)
 *     - 每个窗口 INCR 一次,首次 INCR 后立刻 EXPIRE 到窗口结束
 *     - INCR 是原子的,EXPIRE 失败不致命(下个窗口仍可正常 expire)
 *   - 超限:返回 `{allowed:false, retryAfterSeconds, count, limit}`
 *     调用方负责返 429 + Retry-After header + 写 `rate_limit_events`
 *   - keyBy:由调用方决定(IP / userId / email)
 *
 * 不在本文件:
 *   - HTTP 中间件 wrapping(T-16)
 *   - rate_limit_events 写入(由 helper 函数 `recordRateLimitEvent` 给出,
 *     调用方可选择是否调用 — 单元测试 mock redis 时不希望强制写 DB)
 */

import type Redis from "ioredis";
import { z } from "zod";
import { query } from "../db/queries.js";

/**
 * 限流配置 schema。
 *
 * - `scope`:限流域名("login" / "register" / "reset_password" 等),用于 redis key 命名空间
 * - `windowSeconds`:窗口长度,常用 60(每分钟)
 * - `max`:窗口内最大计数,超过即拒绝
 * - `keyPrefix`:可选,默认 `oc:rl`,便于在共享 redis 上隔离环境
 */
export const rateLimitConfigSchema = z.object({
  scope: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i, "scope must be [a-z0-9_]"),
  windowSeconds: z.number().int().min(1).max(86400),
  max: z.number().int().min(1).max(1_000_000),
  keyPrefix: z.string().min(1).max(32).optional(),
});

export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;

export interface RateLimitDecision {
  allowed: boolean;
  /** 当前窗口已计数 */
  count: number;
  /** 限流阈值 */
  limit: number;
  /** 当前窗口剩余秒数 */
  retryAfterSeconds: number;
  /** 完整 redis key,便于日志/排障 */
  key: string;
}

/** Redis 接口,只用到 incr / expire / pexpire 这几个,便于 mock。 */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

function buildKey(cfg: RateLimitConfig, identifier: string, windowStart: number): string {
  const prefix = cfg.keyPrefix ?? "oc:rl";
  return `${prefix}:${cfg.scope}:${identifier}:${windowStart}`;
}

/**
 * 核心函数:查询并自增。
 *
 * 流程:
 *   1) 计算当前窗口起点 windowStart = floor(now/window)*window
 *   2) INCR 计数器 → count
 *   3) 如果 count === 1(本窗口首次),EXPIRE 到 windowStart + windowSeconds
 *   4) 决策:count <= max → allowed=true;否则 allowed=false
 *
 * 安全细节:
 *   - identifier 由调用方决定如何提取(IP / user_id / email);本函数不洗
 *     但会校验长度避免 redis key 爆炸(超 256 字符抛错)
 *   - now 注入便于测试模拟时间窗
 */
export async function checkRateLimit(
  redis: RateLimitRedis,
  cfg: RateLimitConfig,
  identifier: string,
  options: { now?: () => number } = {},
): Promise<RateLimitDecision> {
  const parsed = rateLimitConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new Error(`rate limit config invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("rate limit identifier must be non-empty string");
  }
  if (identifier.length > 256) {
    throw new Error("rate limit identifier too long (>256 chars)");
  }

  const nowSec = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / cfg.windowSeconds) * cfg.windowSeconds;
  const key = buildKey(cfg, identifier, windowStart);

  const count = await redis.incr(key);
  // 2026-04-21 安全审计 Medium#1:EXPIRE 之前只在 count===1 时调用。如果 redis
  // 意外重启 / AOF rewrite 导致 PERSIST 残留(count>1 但无 TTL),key 将永远
  // 不过期,占 redis 内存 + 永久把该 identifier 锁成 count>max 被 429。
  // 修复:每次都 EXPIRE — 它是幂等的,只在 TTL<windowSeconds 时刷新不会破坏
  // 固定窗口语义(窗口仍按 windowStart 对齐,key 名带 windowStart 保证不同
  // 窗口 key 不同)。开销可忽略(redis 一次 RTT),换来永远不会有无 TTL 残留。
  try {
    await redis.expire(key, cfg.windowSeconds);
  } catch {
    // redis 偶发 EXPIRE 失败不应让请求失败;TTL 最坏下次 INCR 再兜底。监控另行采集。
  }

  const windowEnd = windowStart + cfg.windowSeconds;
  const retryAfterSeconds = Math.max(1, windowEnd - nowSec);
  return {
    allowed: count <= cfg.max,
    count,
    limit: cfg.max,
    retryAfterSeconds,
    key,
  };
}

/**
 * 把一次限流事件写到 `rate_limit_events`(schema 0006: scope/key/blocked/created_at)。
 *
 * `blocked` 区分两类事件:
 *   - true:本次请求被限流挡住(decision.allowed=false)
 *   - false:正常通过但记录(预留给 admin 看趋势,默认不写以省 IO)
 *
 * 失败只 console.error,不抛 — 写日志失败绝不应让正常拒绝路径报 500。
 * 调用方可 fire-and-forget(不 await),也可 await 串行写。
 */
export async function recordRateLimitEvent(
  scope: string,
  identifier: string,
  blocked: boolean,
): Promise<void> {
  try {
    await query(
      "INSERT INTO rate_limit_events(scope, key, blocked) VALUES ($1, $2, $3)",
      [scope, identifier, blocked],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial/rateLimit] failed to write rate_limit_events:", err);
  }
}

/**
 * 对接 ioredis 的便捷适配器。
 *
 * 由于直接接受 ioredis 客户端会让单测难 mock,这里把 ioredis 包成
 * `RateLimitRedis` 接口。生产 / 集成测试用 `wrapIoredis(client)`,
 * 单测可直接构造一个简单对象。
 */
export function wrapIoredis(client: Redis): RateLimitRedis {
  return {
    async incr(key) { return await client.incr(key); },
    async expire(key, seconds) { return await client.expire(key, seconds); },
  };
}
