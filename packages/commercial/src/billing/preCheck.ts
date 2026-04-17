/**
 * T-23 — 预检(pre-check)+ Redis 软预锁。
 *
 * 目标:**在真正扣费之前**,根据用户声明的 `max_tokens` 估一个上限成本(`max_cost`),
 * 把这份额度"预扣"到 Redis(TTL 5 分钟)。如果 `users.credits < 预扣总和` 就直接 403,
 * 避免 chat/agent 已经启动、消耗了账号池资源之后再告知用户没钱。
 *
 * 为什么是 "软" 预锁:
 *   - 真实余额仍在 Postgres 的 `users.credits` 列;Redis 只是个 "临时账本",
 *     记录一段时间内该用户"已承诺但未结算"的合计 max_cost
 *   - 扣费时还是以 pg 为准(T-22 debit)—— Redis 值只用来在预检时比对
 *   - Redis 预扣 TTL 5 分钟:若 LLM 请求走 3 分钟就结算了,`release()` 把预扣释放;
 *     若请求在 5 分钟内没 release(崩溃/超时/agent 长 session),TTL 到期自动清零
 *   - 极端场景:TTL 到期时实际扣费还没发生(长流式) —— 下一个预检会把当前锁当作 0
 *     让其通过,出现轻微的 "余额超卖"。可接受:长 session 边跑边扣本来就保证不了严格
 *     一致;我们需要的是 "多次并发请求同时预扣" 的 99% 场景下不打穿余额
 *
 * 不在本文件:
 *   - 真正的扣费(T-22 debit,由 chat handler 在结算时调用)
 *   - 按 usage 估算 max_cost 的公式由调用方传 `estimateMaxCost(req)` 决策 —— 放在这里会
 *     让不同入口(chat / agent)耦合太紧。本模块只负责"有个数字了,和余额比一比 + 锁 Redis"
 */

import type { PricingCache, ModelPricing } from "./pricing.js";
import { getBalance } from "./ledger.js";

/** Redis 最小接口,只用 get/set/del 三个命令,便于 mock。 */
export interface PreCheckRedis {
  /** SET key value EX seconds NX|XX —— 这里用普通 set with EX,不走 NX。 */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** 读字符串值,不存在返回 null。 */
  get(key: string): Promise<string | null>;
  /** 删除 key(返回删除条数)。 */
  del(key: string): Promise<number>;
  /**
   * 列出某个前缀下所有 key 的值。用于聚合"该用户当前已预扣多少"。
   * 实现可用 SCAN(生产)或 KEYS(测试库)。
   */
  sumByPrefix(prefix: string): Promise<bigint>;
}

export class InsufficientCreditsError extends Error {
  readonly code = "ERR_INSUFFICIENT_CREDITS" as const;
  readonly balance: bigint;
  readonly required: bigint;
  readonly shortfall: bigint;
  constructor(balance: bigint, required: bigint) {
    super(`insufficient credits: balance=${balance} required=${required}`);
    this.name = "PreCheckInsufficientCreditsError";
    this.balance = balance;
    this.required = required;
    this.shortfall = required - balance;
  }
}

export interface PreCheckInput {
  userId: bigint | number | string;
  requestId: string;
  model: string;
  /** 客户端声明 / gateway 补默认值的上限 token 数。以"token"为单位。 */
  maxTokens: number;
  /** 可选:显式注入 pricing,便于测试。生产走 deps.pricing。 */
  pricing?: PricingCache;
}

export interface PreCheckResult {
  /** 估算的上限成本,单位:分。 */
  maxCost: bigint;
  /** 当前 pg 实时余额(预检时刻)。仅供调用方日志/监控。 */
  balance: bigint;
  /** 本次预扣使用的 Redis key,调用方调 release() 时原样传回。 */
  lockKey: string;
}

/**
 * 计算该 model 下 maxTokens 的上限 cost(分)。
 *
 * 保守估算:`max_tokens * output_per_mtok * multiplier / 1_000_000`
 * 为什么用 output:LLM 里 output 通常是 input 单价的 5x,按 output 估最悲观、不会低估
 *
 * 向上取整到 1 分。输入 0 → cost=0。
 */
export function estimateMaxCost(maxTokens: number, pricing: ModelPricing): bigint {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new TypeError(`maxTokens must be non-negative finite number, got ${maxTokens}`);
  }
  if (!Number.isInteger(maxTokens)) {
    throw new TypeError(`maxTokens must be integer, got ${maxTokens}`);
  }
  if (maxTokens === 0) return 0n;

  const [intPart, fracRaw = ""] = pricing.multiplier.split(".");
  const frac = fracRaw.padEnd(3, "0").slice(0, 3);
  const mulScaled = BigInt(intPart + frac); // "2.000" → 2000n
  const tokens = BigInt(maxTokens);
  // 按 output 维度保守估:tokens * output_per_mtok * mul_scaled / (10^6 * 10^3)
  const num = tokens * pricing.output_per_mtok * mulScaled;
  const den = 1_000_000_000n;
  return (num + den - 1n) / den;
}

function buildLockKey(userId: string | number | bigint, requestId: string): string {
  // requestId 已由上游 gateway 保证唯一(X-Request-Id / UUID),
  // 这里只做长度兜底;避免构造 key 过长把 redis 打爆
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    throw new TypeError(`requestId must be 1-128 char string, got length=${String(requestId).length}`);
  }
  return `precheck:user:${userId}:${requestId}`;
}

function buildUserPrefix(userId: string | number | bigint): string {
  return `precheck:user:${userId}:`;
}

/**
 * 预检主流程。
 *
 * 1. 估 maxCost = estimateMaxCost(maxTokens, pricing)
 * 2. 读 pg 余额 + Redis 聚合 "已预扣"
 * 3. 若 balance < locked + maxCost → 抛 InsufficientCreditsError(调用方映射 402/403)
 * 4. Redis SET key=maxCost EX 300
 *
 * 幂等提示:同一个 requestId 多次调用会**覆写**之前的值(SET 不走 NX),
 * 这让上游重试更宽容;但也意味着同一 requestId 两次不同 maxTokens 会后者胜。
 * 上游保证每个请求 requestId 唯一即可。
 */
export async function preCheck(
  redis: PreCheckRedis,
  input: PreCheckInput,
): Promise<PreCheckResult> {
  if (!input.pricing) throw new TypeError("preCheck: pricing cache is required");
  const model = input.pricing.get(input.model);
  if (!model) {
    // 价格未知 → 无法估算上限;上游应该更早就拦住(公开模型列表)。这里抛 TypeError 让
    // 调用方映射 400 UNKNOWN_MODEL,不吞
    throw new TypeError(`unknown model: ${input.model}`);
  }

  const maxCost = estimateMaxCost(input.maxTokens, model);
  const balance = await getBalance(input.userId);
  const uidKey = typeof input.userId === "bigint" ? input.userId.toString() : String(input.userId);
  const prefix = buildUserPrefix(uidKey);
  const alreadyLocked = await redis.sumByPrefix(prefix);
  const needTotal = alreadyLocked + maxCost;
  if (balance < needTotal) {
    throw new InsufficientCreditsError(balance, needTotal);
  }

  const lockKey = buildLockKey(uidKey, input.requestId);
  // TTL 5 分钟:足够大多数 LLM 请求完成 + 回调 release
  await redis.set(lockKey, maxCost.toString(), 300);
  return { maxCost, balance, lockKey };
}

/** 释放预扣。成功返回 true(删掉了),false(key 已不存在 / 已到期)。 */
export async function releasePreCheck(redis: PreCheckRedis, lockKey: string): Promise<boolean> {
  const n = await redis.del(lockKey);
  return n > 0;
}

// ─────────────────────────────────────────────────────────────────────
// ioredis adapter + 内存版(测试用)

import type Redis from "ioredis";

/**
 * 把 ioredis 客户端包成 PreCheckRedis。
 *
 * sumByPrefix 用 SCAN(生产安全,O(N) 增量);每批 MGET 读 value。
 * 对每用户前缀下 key 数量通常 < 10(并发请求上限),性能无忧。
 */
export function wrapIoredisForPreCheck(client: Redis): PreCheckRedis {
  return {
    async set(key, value, ttl) {
      await client.set(key, value, "EX", ttl);
    },
    async get(key) {
      return await client.get(key);
    },
    async del(key) {
      return await client.del(key);
    },
    async sumByPrefix(prefix) {
      let cursor = "0";
      let total = 0n;
      const matched: string[] = [];
      do {
        const [next, batch] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        cursor = next;
        matched.push(...batch);
      } while (cursor !== "0");
      if (matched.length === 0) return 0n;
      // MGET 批量拿 value;null 表示刚过期
      const vals = await client.mget(matched);
      for (const v of vals) {
        if (typeof v === "string" && v.length > 0) {
          try {
            total += BigInt(v);
          } catch {
            // 非 BigInt 值忽略 — 这是脏数据(人为写入),宁可低估也不让预检 throw
          }
        }
      }
      return total;
    },
  };
}

/** 测试专用:纯内存实现。 */
export class InMemoryPreCheckRedis implements PreCheckRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private now: () => number = () => Date.now();
  setNowFn(fn: () => number): void { this.now = fn; }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.store) if (v.expiresAt <= t) this.store.delete(k);
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
  async get(key: string): Promise<string | null> {
    this.sweep();
    return this.store.get(key)?.value ?? null;
  }
  async del(key: string): Promise<number> {
    this.sweep();
    return this.store.delete(key) ? 1 : 0;
  }
  async sumByPrefix(prefix: string): Promise<bigint> {
    this.sweep();
    let total = 0n;
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) {
        try { total += BigInt(v.value); } catch { /* ignore */ }
      }
    }
    return total;
  }
  /** 测试观察用。 */
  snapshot(): Record<string, string> {
    this.sweep();
    const out: Record<string, string> = {};
    for (const [k, v] of this.store) out[k] = v.value;
    return out;
  }
}
