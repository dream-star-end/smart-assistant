import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, type RateLimitRedis } from "../middleware/rateLimit.js";

/**
 * T-15 单元测试:用 mock Redis 验证计数 + 过期 + 滑动窗口。
 *
 * 不需要真 redis,只验算法逻辑(INCR / EXPIRE 调用次数 / 决策正确性 / 时间窗滚动)。
 */

class MockRedis implements RateLimitRedis {
  /** key -> count(简化:不模拟 TTL,因为时间由测试控制 now()) */
  readonly store = new Map<string, number>();
  readonly expireCalls: Array<{ key: string; seconds: number }> = [];
  /** 设为 true 让 expire 抛错(测 EXPIRE 失败的容错) */
  failExpire = false;

  async incr(key: string): Promise<number> {
    const cur = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, cur);
    return cur;
  }
  async expire(key: string, seconds: number): Promise<number> {
    if (this.failExpire) {
      throw new Error("simulated EXPIRE failure");
    }
    this.expireCalls.push({ key, seconds });
    return 1;
  }
}

const CFG = { scope: "login", windowSeconds: 60, max: 5 };

describe("rateLimit.checkRateLimit", () => {
  test("first call: allowed, count=1, EXPIRE called once with windowSeconds", async () => {
    const r = new MockRedis();
    const d = await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
    assert.equal(d.allowed, true);
    assert.equal(d.count, 1);
    assert.equal(d.limit, 5);
    assert.equal(r.expireCalls.length, 1);
    assert.equal(r.expireCalls[0].seconds, 60);
    // key 包含 windowStart=floor(1000/60)*60=960
    assert.match(d.key, /:960$/);
  });

  test("calls 2..5: still allowed, EXPIRE called per INCR (security: PERSIST drift fix)", async () => {
    const r = new MockRedis();
    for (let i = 1; i <= 5; i++) {
      const d = await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
      assert.equal(d.allowed, true, `call #${i} should be allowed`);
      assert.equal(d.count, i);
    }
    // 2026-04-21 安全审计 Medium#1:每次 INCR 后都 EXPIRE,防 Redis AOF rewrite
    // / PERSIST 残留把 key 锁成「count>max 永不过期」状态。详见
    // src/middleware/rateLimit.ts:99-109 注释。原 first-call-only 已退役。
    assert.equal(
      r.expireCalls.length,
      5,
      "EXPIRE 每次 INCR 都刷 — 防 PERSIST 残留把 key 锁死(rateLimit.ts:99-109)",
    );
  });

  test("call 6 in same window: denied, retryAfter > 0", async () => {
    const r = new MockRedis();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
    }
    const d = await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
    assert.equal(d.allowed, false);
    assert.equal(d.count, 6);
    // 窗口起点 960,结束 1020,now=1000 → retryAfter = 20
    assert.equal(d.retryAfterSeconds, 20);
  });

  test("rolling into next window resets counter", async () => {
    const r = new MockRedis();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
    }
    // now 跳到 1020(下一个窗口起点),应当被允许 + count=1
    const d = await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1020 });
    assert.equal(d.allowed, true);
    assert.equal(d.count, 1);
    // 5(window 1) + 1(window 2) = 6 次 EXPIRE,每次 INCR 都刷一次(详见前一测试注释)
    assert.equal(r.expireCalls.length, 6, "每次 INCR 一次 EXPIRE,跨窗口累加");
  });

  test("different identifiers are isolated", async () => {
    const r = new MockRedis();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(r, CFG, "1.2.3.4", { now: () => 1000 });
    }
    // 同一窗口,另一个 IP 全新计数
    const d = await checkRateLimit(r, CFG, "9.9.9.9", { now: () => 1000 });
    assert.equal(d.allowed, true);
    assert.equal(d.count, 1);
  });

  test("different scopes are isolated", async () => {
    const r = new MockRedis();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(r, CFG, "x", { now: () => 1000 });
    }
    const d = await checkRateLimit(
      r,
      { ...CFG, scope: "register" },
      "x",
      { now: () => 1000 },
    );
    assert.equal(d.allowed, true);
    assert.equal(d.count, 1);
  });

  test("retryAfterSeconds: at last second of window → 1; at start of next window → full window", async () => {
    const r = new MockRedis();
    // 同一 key 连两次,max=1:第 2 次拒,now=1019 → windowEnd=1020 → retryAfter=1
    await checkRateLimit(r, { ...CFG, max: 1 }, "x", { now: () => 1019 });
    const d1 = await checkRateLimit(r, { ...CFG, max: 1 }, "x", { now: () => 1019 });
    assert.equal(d1.allowed, false);
    assert.equal(d1.retryAfterSeconds, 1);

    // 不同 key,now=1020 落到下一窗口起点;max=1 第 2 次拒 → retryAfter=60
    await checkRateLimit(r, { ...CFG, max: 1 }, "y", { now: () => 1020 });
    const d2 = await checkRateLimit(r, { ...CFG, max: 1 }, "y", { now: () => 1020 });
    assert.equal(d2.allowed, false);
    assert.equal(d2.retryAfterSeconds, 60);
  });

  test("EXPIRE failure does not throw / does not block decision", async () => {
    const r = new MockRedis();
    r.failExpire = true;
    const d = await checkRateLimit(r, CFG, "x", { now: () => 1000 });
    assert.equal(d.allowed, true);
    assert.equal(d.count, 1);
  });

  test("invalid scope (with /) throws", async () => {
    const r = new MockRedis();
    await assert.rejects(
      checkRateLimit(r, { ...CFG, scope: "bad/scope" }, "x"),
      /scope must be/,
    );
  });

  test("empty identifier throws", async () => {
    const r = new MockRedis();
    await assert.rejects(checkRateLimit(r, CFG, ""), /identifier must be non-empty/);
  });

  test("identifier > 256 chars throws", async () => {
    const r = new MockRedis();
    await assert.rejects(
      checkRateLimit(r, CFG, "x".repeat(257)),
      /identifier too long/,
    );
  });

  test("custom keyPrefix is honored", async () => {
    const r = new MockRedis();
    const d = await checkRateLimit(
      r,
      { ...CFG, keyPrefix: "myprefix" },
      "abc",
      { now: () => 1000 },
    );
    assert.match(d.key, /^myprefix:login:abc:/);
  });
});
