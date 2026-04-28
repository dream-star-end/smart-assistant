/**
 * A1 unit:pendingOrdersExpirer 调度行为(不依赖 PG)。
 *
 * 通过注入 expireFn 验证:
 *   - runOnStart 默认 true(boot 立即跑)
 *   - intervalMs 触发 tick
 *   - stop 后 tick 不再调
 *   - expire 抛错被 onError 接住,不冒泡
 *   - intervalMs < 1000 钳到下限
 *   - runNow 同步暴露
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startPendingOrdersExpirer } from "../payment/pendingOrdersExpirer.js";

describe("pendingOrdersExpirer", () => {
  test("runOnStart 默认 true,boot 立即跑一次", async () => {
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 60_000,
      expireFn: async () => {
        n++;
        return 3;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 1);
    h.stop();
  });

  test("runOnStart=false 时 boot 不跑", async () => {
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 60_000,
      runOnStart: false,
      expireFn: async () => {
        n++;
        return 0;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 0);
    h.stop();
  });

  test("intervalMs 到点 tick", async () => {
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 1000,
      runOnStart: false,
      expireFn: async () => {
        n++;
        return 0;
      },
    });
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(n >= 1, `expected at least 1 tick, got ${n}`);
    h.stop();
  });

  test("stop 后不再 tick", async () => {
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 1000,
      runOnStart: false,
      expireFn: async () => {
        n++;
        return 0;
      },
    });
    h.stop();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(n, 0);
  });

  test("expire 抛错走 onError,sweeper 不挂", async () => {
    const errs: unknown[] = [];
    const h = startPendingOrdersExpirer({
      intervalMs: 60_000,
      runOnStart: true,
      expireFn: async () => {
        throw new Error("boom");
      },
      onError: (e) => errs.push(e),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errs.length, 1);
    assert.equal((errs[0] as Error).message, "boom");
    h.stop();
  });

  test("intervalMs < 1000 → 取下限 1000", async () => {
    // 防止 typo "5" 被解读成 5ms 把 DB 打爆
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 1, // 远低于下限
      runOnStart: false,
      expireFn: async () => {
        n++;
        return 0;
      },
    });
    // 等 50ms 内不该触发任何 tick(下限被钳到 1000)
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(n, 0);
    h.stop();
  });

  test("runNow 同步暴露,可被测试主动驱动", async () => {
    let n = 0;
    const h = startPendingOrdersExpirer({
      intervalMs: 60_000,
      runOnStart: false,
      expireFn: async () => {
        n++;
        return 7;
      },
    });
    const affected = await h.runNow();
    assert.equal(affected, 7);
    assert.equal(n, 1);
    h.stop();
  });
});
