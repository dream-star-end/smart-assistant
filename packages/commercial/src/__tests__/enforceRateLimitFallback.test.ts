/**
 * B9 — enforceRateLimit 在 Redis 不可用时降级到 per-process 兜底限流。
 *
 * 此前 checkRateLimit 内 `redis.incr` 无兜底:Redis 挂 → throw → enforceRateLimit 透出 →
 * register/login/reset/refresh 全 500(鉴权整体宕机)。修复后:Redis 错误 → 降级到
 * FallbackRateLimiter(cap=ceil(max/3),"降级而非开闸"),鉴权仍可用、不再全 500。
 *
 * 纯单元:mock RateLimitRedis(incr 抛错=Redis 宕机),直接调 enforceRateLimit。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CommercialHttpDeps, enforceRateLimit } from "../http/handlers.js";
import { HttpError } from "../http/util.js";
import type { RateLimitConfig, RateLimitRedis } from "../middleware/rateLimit.js";

/** Redis 正常:计数自增。 */
class UpRedis implements RateLimitRedis {
  private store = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const c = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, c);
    return c;
  }
  async expire(): Promise<number> {
    return 1;
  }
}

/** Redis 宕机:incr/expire 抛错(模拟连接失败)。 */
class DownRedis implements RateLimitRedis {
  async incr(): Promise<number> {
    throw new Error("redis ECONNREFUSED (simulated down)");
  }
  async expire(): Promise<number> {
    throw new Error("redis ECONNREFUSED (simulated down)");
  }
}

function depsWith(redis: RateLimitRedis): CommercialHttpDeps {
  // enforceRateLimit 只用 deps.redis;其余字段不涉及。
  return { redis } as unknown as CommercialHttpDeps;
}

async function is429(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof HttpError && e.status === 429;
  }
}

describe("B9 enforceRateLimit fallback", () => {
  test("Redis 正常:max 内放行,超出 429(原行为不变)", async () => {
    const deps = depsWith(new UpRedis());
    const cfg: RateLimitConfig = { scope: "b9_up", windowSeconds: 60, max: 3 };
    for (let i = 0; i < 3; i++) {
      await enforceRateLimit(deps, cfg, "ip-up");
    }
    assert.equal(await is429(() => enforceRateLimit(deps, cfg, "ip-up")), true);
  });

  test("Redis 宕机:降级到兜底 cap=ceil(max/3),前 cap 次放行(鉴权可用,不 500)", async () => {
    const deps = depsWith(new DownRedis());
    // max=9 → fallback cap=3
    const cfg: RateLimitConfig = { scope: "b9_down_a", windowSeconds: 60, max: 9 };
    for (let i = 0; i < 3; i++) {
      await assert.doesNotReject(
        () => enforceRateLimit(deps, cfg, "ip-a"),
        `第 ${i + 1} 次应放行(不抛 500/429)`,
      );
    }
    // 第 4 次命中兜底 cap → 429(收紧,不开闸)
    assert.equal(await is429(() => enforceRateLimit(deps, cfg, "ip-a")), true);
  });

  test("Redis 宕机:不同 identifier 各自独立计数", async () => {
    const deps = depsWith(new DownRedis());
    const cfg: RateLimitConfig = { scope: "b9_down_b", windowSeconds: 60, max: 3 }; // cap=ceil(3/3)=1
    await enforceRateLimit(deps, cfg, "ip-x"); // x 第 1 次放行
    assert.equal(await is429(() => enforceRateLimit(deps, cfg, "ip-x")), true); // x 第 2 次 429(cap=1)
    await assert.doesNotReject(() => enforceRateLimit(deps, cfg, "ip-y")); // y 独立,第 1 次放行
  });

  test("Redis 宕机:绝不抛非-429 错误(不再整体 500)", async () => {
    const deps = depsWith(new DownRedis());
    const cfg: RateLimitConfig = { scope: "b9_down_c", windowSeconds: 60, max: 30 };
    await assert.doesNotReject(() => enforceRateLimit(deps, cfg, "ip-z"));
  });

  test("非法 identifier(空):直接抛编程错误,不被 Redis 兜底掩盖(Finding 1)", async () => {
    const deps = depsWith(new DownRedis());
    const cfg: RateLimitConfig = { scope: "b9_inv", windowSeconds: 60, max: 9 };
    await assert.rejects(
      () => enforceRateLimit(deps, cfg, ""),
      (e: unknown) => e instanceof Error && !(e instanceof HttpError),
    );
  });
});
