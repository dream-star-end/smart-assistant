/**
 * T-23 — 预检(pre-check)+ Redis **原子预留**。
 *
 * 目标:在真正扣费之前,根据用户声明的 `max_tokens` 估一个上限成本(`max_cost`),
 * 把这份额度"预扣"到 Redis(TTL 5 分钟)。余额不足直接 402,避免 LLM 请求已启动、
 * 消耗了账号池资源之后再告知用户没钱。
 *
 * 2026-04-21 重构 — 原先的 `SCAN MATCH prefix*` + `SET lockKey` 是**非原子**的:
 * 两个并发请求同时看到相同 `alreadyLocked`,一起通过 `balance ≥ needed` 检查,
 * 一起 SET 成功,最终超额消费。修复:走单一 Lua 脚本,把「清过期 → 聚合已预扣 →
 * 与 balance 比较 → (成功)写入新 lock」锁在 Redis 单服务器串行原子语义里。
 *
 * 为什么是 "软" 预锁(重构后仍成立):
 *   - 真实余额仍在 Postgres 的 `users.credits` 列;Redis 只是临时账本。
 *   - 扣费时还是以 pg 为准(T-22 debit)—— Redis 值只用来在预检时比对。
 *   - Redis 预扣 TTL 5 分钟,到期自动回收;极长 session 可能出现轻微 "余额超卖",
 *     这是可接受的(长 session 本就不保证严格一致)。
 *
 * 存储模型(单 user,两个 key):
 *   - `precheck:u:<uid>:locks`   zset,score=expireAtMs,member=reqId
 *   - `precheck:u:<uid>:amounts` hash,field=reqId,value=cost(十进制 BigInt 字符串)
 *   - 两个 key 必须哈希到同 slot(集群部署时);形如 `precheck:u:{<uid>}:locks`
 *     的花括号 hash tag 由实现补齐,保证 Lua EVAL 合法。
 *
 * BigInt 精度约束:Lua 里 tonumber 走 double(53 位),我们要求 balance / maxCost /
 * 已预扣总和 ≤ Number.MAX_SAFE_INTEGER(~9e15 cents = 9e13 元),实际远超任何用户余额。
 * 超出会在 JS 侧 throw。
 */

import type Redis from "ioredis";
import type { PricingCache, ModelPricing } from "./pricing.js";
import { getBalance } from "./ledger.js";

/** Lua 及 JS 侧共同的 bigint 精度上限(2^53 - 1)。 */
const SAFE_INT_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** 默认预扣 TTL(秒)。 */
const DEFAULT_RESERVATION_TTL_SEC = 300;

/**
 * 单笔请求允许的"平台软超扣窗口"(分)。¥5 = 500.
 *
 * 2026-04-26 v1.0.3:之前 preCheck 用最坏 max_tokens × output 单价做 reservation,
 * 余额 < 估算 cost 一律 402。结果"注册赠送 ¥2 的用户连一句'你好'都发不出"
 * (60K max_tokens × opus 4.7 估算 ≈ ¥3 > ¥2)。
 *
 * 改成"放行 cost 在 (balance + ceiling) 以内的请求"+ "把 reservation cap 到 balance",
 * 让用户能把账户用到 0;真实 cost 由 finalize 阶段已有的 clamp 路径吃掉
 * (settleUsageAndLedger:1052,debit = min(balance, cost),balance_after=0,'clamped' memo)。
 *
 * 数值选 500 的依据:
 *   - opus 4.7 默认 max_tokens=64K 估算 ~¥3 < ¥5 → boss 实测场景过
 *   - 200K max_tokens 估算 ~¥10 > ¥5 → 余额 < ¥5 的用户会被拒,不让一笔吃穿
 *
 * 不变量(soft 一致性,非强保证):
 *   - per-request 放行窗口:input.maxCost ≤ snapshot_balance + ¥5,严格阈值
 *   - per-request 实际 overage:受 PG/Redis 边界窗口影响 + per-uid 并发 4(DEFAULT_MAX_CONCURRENT_PER_UID),
 *     最坏放大 4× ≈ ¥20。个人级 SaaS 量级可承受。
 *   - balance ≤ 0 hard reject 不受 race 影响(PG 单点权威)
 */
export const PRECHECK_OVERAGE_CEILING_CENTS = 500n;

/** 把用户 id 归一为字符串(支持 bigint/number/string)。 */
function uidToStr(uid: bigint | number | string): string {
  if (typeof uid === "bigint") return uid.toString();
  return String(uid);
}

/** 把 reqId 做最小合法性检查(避免注入到 Redis key / Lua)。 */
function assertRequestId(reqId: string): void {
  if (typeof reqId !== "string" || reqId.length === 0 || reqId.length > 128) {
    throw new TypeError(`requestId must be 1-128 char string, got length=${String(reqId).length}`);
  }
}

/** 保证 bigint 能被 Lua tonumber 安全承接。 */
function assertSafeBigInt(name: string, v: bigint): void {
  if (v < 0n) throw new TypeError(`${name} must be non-negative, got ${v}`);
  if (v > SAFE_INT_BIGINT) {
    throw new TypeError(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1); precision would be lost`);
  }
}

/** Redis key 构造(用 `{uid}` hash tag,保证集群下两 key 同 slot)。 */
function locksKey(uid: string): string {
  return `precheck:u:{${uid}}:locks`;
}
function amountsKey(uid: string): string {
  return `precheck:u:{${uid}}:amounts`;
}

/**
 * 预检抽象接口。
 *
 * 只暴露两个原子原语:
 *   - `atomicReserve`:读余额后调用,Lua 单脚本完成 清过期 → 聚合 → 比较 → 写入。
 *   - `releaseReservation`:按 (uid, reqId) 删除本次预扣。
 *
 * 注:旧接口(`set/get/del/sumByPrefix`)已废弃;外部调用请走本接口 或 `preCheck()` / `releasePreCheck()` 高阶函数。
 */
export interface PreCheckRedis {
  /**
   * 原子预留。Lua 脚本内部:
   *   1. ZREMRANGEBYSCORE / HDEL 清过期 lock
   *   2. HVALS 求和当前已预扣总和 total
   *   3. 若存在同 reqId 的旧 lock,从 total 中减去(幂等覆写)
   *   4. 若 `balance < total + maxCost` → 返回 `{ok: false, locked, needed}`,不写
   *   5. 否则 HSET + ZADD 写入,并 EXPIRE 整体 key(防孤儿)
   *
   * 原子性:Redis 单线程执行 Lua,从步骤 1 到 5 中间**不会有其他请求插入**,
   * 彻底消除并发"都通过余额检查都写入"的 race。
   *
   * 幂等:同一 reqId 多次调用 → 最后一次的 maxCost 胜(覆写语义)。
   * 历史:重试和上游 idempotency 场景下上游可能重复提交,这里容忍。
   */
  atomicReserve(input: {
    userId: bigint | number | string;
    requestId: string;
    balance: bigint;
    maxCost: bigint;
    ttlSeconds: number;
  }): Promise<AtomicReserveResult>;

  /** 释放一个 lock。true = 删掉了 / false = 不存在(已过期或已释放)。 */
  releaseReservation(input: {
    userId: bigint | number | string;
    requestId: string;
  }): Promise<boolean>;
}

export type AtomicReserveResult =
  | { ok: true; locked: bigint; needed: bigint }
  | { ok: false; locked: bigint; needed: bigint };

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
  /** 可选:覆盖 TTL,默认 300s。 */
  ttlSeconds?: number;
}

/** 已算好 maxCost 的直接预留(跳过 estimateMaxCost,供 proxy 双侧估算路径用)。 */
export interface PreCheckWithCostInput {
  userId: bigint | number | string;
  requestId: string;
  maxCost: bigint;
  ttlSeconds?: number;
}

export interface PreCheckResult {
  /**
   * 本次实际写进 Redis lock 的额度(分)。
   *
   * 与调用方传入的 `input.maxCost` 不同:当余额 < 估算 cost 时会被 cap 到 balance
   * (drain-to-zero 语义),此字段反映"真正预扣了多少"。
   */
  maxCost: bigint;
  /** 当前 pg 实时余额(预检时刻,仅供日志/监控)。 */
  balance: bigint;
  /** reservation handle — 传给 releasePreCheck 释放本次预扣。 */
  reservation: ReservationHandle;
  /**
   * true = 估算 cost 超过余额,reservation 已被 cap 到 balance。
   *
   * 调用方据此打 metric / log 观察 cap 触发率。
   * 注:相对 preCheck snapshot 的"放行窗口"受 ceiling 限制;实际 overage 受
   * PG/Redis 边界窗口与 per-uid 并发(默认 4)放大,严格 hard limit 不成立 — 详见
   * PRECHECK_OVERAGE_CEILING_CENTS 注释里的"soft 一致性"不变量段。
   */
  capped: boolean;
  /** 调用方传入的原始估算 cost(分),用于对照 maxCost 看 cap 幅度。 */
  originalMaxCost: bigint;
}

/** 释放预扣需要的最小上下文。 */
export interface ReservationHandle {
  userId: string;
  requestId: string;
}

/**
 * 计算该 model 下 maxTokens 的上限 cost(分)。
 *
 * 保守估算:`max_tokens * output_per_mtok * multiplier / 1_000_000`
 * 为什么用 output:LLM 里 output 通常是 input 单价的 5x,按 output 估最悲观、不会低估。
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
  const num = tokens * pricing.output_per_mtok * mulScaled;
  const den = 1_000_000_000n;
  return (num + den - 1n) / den;
}

/**
 * 预检主流程(按 maxTokens + pricing)。
 *
 * 1. 估 maxCost
 * 2. 读 pg 余额
 * 3. atomicReserve — Lua 内部 聚合 + 校验 + 写入(非 SCAN,性能 O(#locks))
 * 4. 若余额不足 → 抛 InsufficientCreditsError
 *
 * 非原子的 getBalance + atomicReserve:balance 是从 PG 读到的瞬时值,
 * 传进 Lua 后可能比真实余额稍旧。不过在**并发预扣**视角下,这不是问题:
 *   - 同一 user 并发 N 路 → atomicReserve 串行,最后一条会看到前面所有预扣,
 *     按保守余额(上次读到的)校验 → 可能少通过几条(safe side)
 *   - 余额是扣费(T-22 debit)修改的,debit 本身走 PG 行锁,不受 preCheck 影响
 *   - 真正的"余额不准"只在 debit 和 preCheck 的边界窗口,且每次 preCheck 都重读余额
 */
export async function preCheck(
  redis: PreCheckRedis,
  input: PreCheckInput,
): Promise<PreCheckResult> {
  if (!input.pricing) throw new TypeError("preCheck: pricing cache is required");
  const model = input.pricing.get(input.model);
  if (!model) {
    throw new TypeError(`unknown model: ${input.model}`);
  }
  const maxCost = estimateMaxCost(input.maxTokens, model);
  return preCheckWithCost(redis, {
    userId: input.userId,
    requestId: input.requestId,
    maxCost,
    ttlSeconds: input.ttlSeconds,
  });
}

/**
 * 预检主流程(直接传 maxCost,跳过 pricing 估算)。
 *
 * 用于 anthropicProxy 的双侧 cost 估算路径(input+output 双管齐下)。
 */
export async function preCheckWithCost(
  redis: PreCheckRedis,
  input: PreCheckWithCostInput,
): Promise<PreCheckResult> {
  assertRequestId(input.requestId);
  assertSafeBigInt("maxCost", input.maxCost);

  const balance = await getBalance(input.userId);

  // 余额 ≤ 0 hard reject(不受 race 窗口影响 — PG 单点权威)。
  // 防止 0 余额用户绕过 cap 路径刷请求。负余额(adminAdjust 把人调过头)同走此路 →
  // InsufficientCreditsError 而非 assertSafeBigInt 的 TypeError(否则线上变 500)。
  if (balance <= 0n) {
    throw new InsufficientCreditsError(balance, input.maxCost);
  }
  assertSafeBigInt("balance", balance);

  // 单笔请求估算 cost 超出 (余额 + ceiling) → 拒,把单笔超扣面 bound 在 ceiling 内。
  // 例:balance=¥0.10、估算=¥10 → 拒(差 ¥9.9 远超 ¥5 ceiling);
  //     balance=¥2、估算=¥3 → 放行(差 ¥1 < ¥5)。
  if (input.maxCost > balance + PRECHECK_OVERAGE_CEILING_CENTS) {
    throw new InsufficientCreditsError(balance, input.maxCost);
  }

  // 放行:把 reservation cap 到 balance,确保 Lua check 必过(`balance ≥ total + needed`)。
  // 真实 cost 由 finalize 阶段已有的 clamp 路径处理(settleUsageAndLedger);
  // 实际 overage 是 soft 一致性,受 PG/Redis 边界窗口 + per-uid 并发放大,详见
  // PRECHECK_OVERAGE_CEILING_CENTS 注释里的不变量段。
  const capped = input.maxCost > balance;
  const effectiveMaxCost = capped ? balance : input.maxCost;

  const ttl = input.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SEC;
  const result = await redis.atomicReserve({
    userId: input.userId,
    requestId: input.requestId,
    balance,
    maxCost: effectiveMaxCost,
    ttlSeconds: ttl,
  });

  if (!result.ok) {
    throw new InsufficientCreditsError(balance, result.needed);
  }

  return {
    maxCost: effectiveMaxCost,
    balance,
    reservation: { userId: uidToStr(input.userId), requestId: input.requestId },
    capped,
    originalMaxCost: input.maxCost,
  };
}

/** 释放预扣(按 handle)。成功返回 true / 不存在(过期或已释放)返回 false。 */
export async function releasePreCheck(
  redis: PreCheckRedis,
  reservation: ReservationHandle,
): Promise<boolean> {
  return await redis.releaseReservation({
    userId: reservation.userId,
    requestId: reservation.requestId,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Lua 脚本

/**
 * 原子预留脚本。
 *
 * KEYS[1] = locks zset (precheck:u:{uid}:locks)
 * KEYS[2] = amounts hash (precheck:u:{uid}:amounts)
 * ARGV[1] = balance (十进制字符串)
 * ARGV[2] = maxCost
 * ARGV[3] = reqId
 * ARGV[4] = nowMs
 * ARGV[5] = expireMs
 *
 * 返回 {ok, locked, needed},三项都是字符串(以应对 bigint 边界)。
 */
const ATOMIC_RESERVE_SCRIPT = `
local lockKey = KEYS[1]
local amtKey  = KEYS[2]
local balance = tonumber(ARGV[1])
local maxCost = tonumber(ARGV[2])
local reqId   = ARGV[3]
local nowMs   = tonumber(ARGV[4])
local expMs   = tonumber(ARGV[5])

-- 1) 清过期:zset 里 score <= nowMs 的 member 先从 hash 删掉,再从 zset 删
local expired = redis.call('ZRANGEBYSCORE', lockKey, 0, nowMs)
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', lockKey, 0, nowMs)
  redis.call('HDEL', amtKey, unpack(expired))
end

-- 2) 当前所有 lock 求和
local vals = redis.call('HVALS', amtKey)
local total = 0
for i = 1, #vals do
  local c = tonumber(vals[i])
  if c then total = total + c end
end

-- 3) 同 reqId 幂等覆写:若存在旧值,从 total 中减掉
local old = redis.call('HGET', amtKey, reqId)
if old then
  local oldN = tonumber(old)
  if oldN then total = total - oldN end
end

-- 4) 比较 balance(注意:total/maxCost 可能是非整数 float;但我们在 JS 侧已经保证
--    balance/maxCost <= 2^53-1,所以 total+maxCost 仍可精确表达)
local needed = total + maxCost
if balance < needed then
  return {0, tostring(total), tostring(needed)}
end

-- 5) 写入/覆写
redis.call('ZADD', lockKey, nowMs + expMs, reqId)
redis.call('HSET', amtKey, reqId, tostring(maxCost))
-- safety net:避免 zset/hash 永留(即使所有 reservation 过期,也在 2×ttl 后删)
local safetyTtlSec = math.floor(expMs / 1000) * 2
if safetyTtlSec < 60 then safetyTtlSec = 60 end
redis.call('EXPIRE', lockKey, safetyTtlSec)
redis.call('EXPIRE', amtKey,  safetyTtlSec)

return {1, tostring(needed), tostring(needed)}
`;

/**
 * 释放预留脚本。
 *
 * KEYS[1], KEYS[2] 同上。ARGV[1] = reqId。
 * 返回删掉的 hash field 数(0 或 1)。
 */
const ATOMIC_RELEASE_SCRIPT = `
local removed = redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
return removed
`;

// ─────────────────────────────────────────────────────────────────────
// ioredis 实现

/**
 * 把 ioredis 客户端包成 PreCheckRedis。
 *
 * 使用 `EVAL` 直接发送脚本(不做 EVALSHA 缓存) — 单 user 并发量可控,
 * Redis 会自动缓存最近脚本的 SHA,EVAL 本身已经很快。引入 EVALSHA + NOSCRIPT 兜底
 * 会让代码复杂度上去但 benefit 几乎为零。
 */
export function wrapIoredisForPreCheck(client: Redis): PreCheckRedis {
  return {
    async atomicReserve({ userId, requestId, balance, maxCost, ttlSeconds }) {
      assertRequestId(requestId);
      assertSafeBigInt("balance", balance);
      assertSafeBigInt("maxCost", maxCost);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
        throw new TypeError(`ttlSeconds must be (0, 3600], got ${ttlSeconds}`);
      }
      const uid = uidToStr(userId);
      const nowMs = Date.now();
      const expMs = ttlSeconds * 1000;

      // ioredis 的 eval 返回 unknown,我们这里按照脚本约定解码
      const raw = (await client.eval(
        ATOMIC_RESERVE_SCRIPT,
        2,
        locksKey(uid),
        amountsKey(uid),
        balance.toString(),
        maxCost.toString(),
        requestId,
        nowMs.toString(),
        expMs.toString(),
      )) as [number, string, string];

      const [okFlag, lockedStr, neededStr] = raw;
      return {
        ok: okFlag === 1,
        locked: BigInt(lockedStr),
        needed: BigInt(neededStr),
      };
    },

    async releaseReservation({ userId, requestId }) {
      assertRequestId(requestId);
      const uid = uidToStr(userId);
      const n = (await client.eval(
        ATOMIC_RELEASE_SCRIPT,
        2,
        locksKey(uid),
        amountsKey(uid),
        requestId,
      )) as number;
      return n > 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 内存实现(测试用,完全等价语义)

interface MemLock {
  cost: bigint;
  expiresAt: number;
}

export class InMemoryPreCheckRedis implements PreCheckRedis {
  private buckets = new Map<string, Map<string, MemLock>>();
  private now: () => number = () => Date.now();
  setNowFn(fn: () => number): void {
    this.now = fn;
  }

  private getBucket(uid: string): Map<string, MemLock> {
    let b = this.buckets.get(uid);
    if (!b) {
      b = new Map();
      this.buckets.set(uid, b);
    }
    return b;
  }

  private sweep(uid: string): void {
    const b = this.buckets.get(uid);
    if (!b) return;
    const t = this.now();
    for (const [k, v] of b) {
      if (v.expiresAt <= t) b.delete(k);
    }
    if (b.size === 0) this.buckets.delete(uid);
  }

  async atomicReserve({ userId, requestId, balance, maxCost, ttlSeconds }: {
    userId: bigint | number | string;
    requestId: string;
    balance: bigint;
    maxCost: bigint;
    ttlSeconds: number;
  }): Promise<AtomicReserveResult> {
    assertRequestId(requestId);
    assertSafeBigInt("balance", balance);
    assertSafeBigInt("maxCost", maxCost);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
      throw new TypeError(`ttlSeconds must be (0, 3600], got ${ttlSeconds}`);
    }
    const uid = uidToStr(userId);
    this.sweep(uid);

    const bucket = this.getBucket(uid);
    let total = 0n;
    for (const [rid, lock] of bucket) {
      if (rid !== requestId) total += lock.cost;
    }
    const needed = total + maxCost;
    if (balance < needed) {
      return { ok: false, locked: total, needed };
    }

    bucket.set(requestId, {
      cost: maxCost,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return { ok: true, locked: needed, needed };
  }

  async releaseReservation({ userId, requestId }: {
    userId: bigint | number | string;
    requestId: string;
  }): Promise<boolean> {
    assertRequestId(requestId);
    const uid = uidToStr(userId);
    this.sweep(uid);
    const bucket = this.buckets.get(uid);
    if (!bucket) return false;
    const existed = bucket.delete(requestId);
    if (bucket.size === 0) this.buckets.delete(uid);
    return existed;
  }

  /** 测试观察用:拿某 user 当前所有未过期 lock 的总和。 */
  totalLocked(uid: bigint | number | string): bigint {
    const k = uidToStr(uid);
    this.sweep(k);
    const bucket = this.buckets.get(k);
    if (!bucket) return 0n;
    let sum = 0n;
    for (const lock of bucket.values()) sum += lock.cost;
    return sum;
  }

  /** 测试观察用:dump 所有 user 的 lock(已过期会在读取时被清)。 */
  snapshot(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [uid] of this.buckets) this.sweep(uid);
    for (const [uid, bucket] of this.buckets) {
      const u: Record<string, string> = {};
      for (const [rid, lock] of bucket) u[rid] = lock.cost.toString();
      out[uid] = u;
    }
    return out;
  }
}
