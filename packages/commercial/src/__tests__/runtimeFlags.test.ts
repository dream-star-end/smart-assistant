/**
 * v3 v1.0.207 — runtime flag cache 行为单测。
 *
 * 覆盖:
 *   1. 默认 fallback:DB row 缺失 → "off"(getSystemSetting 兜底 DEFAULTS)
 *   2. cache hit:第二次调用不触发 reader
 *   3. invalidateRuntimeFlagsCache:cache.clear 后下次调用重读
 *   4. 不同 key 之间 cache 独立
 *
 * 注入 fake reader 走 `__setReaderForTest` seam — 不依赖 node:test 实验性 module mock,
 * 也不需要起 PG。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getSessionPinMode,
  getPhase6AccountUuidEnforce,
  invalidateRuntimeFlagsCache,
  __setReaderForTest,
  __test_only_cache,
} from "../admin/runtimeFlags.js";
import type { SystemSettingKey } from "../admin/systemSettings.js";

beforeEach(() => {
  // 每个 test 前重置 reader + cache,避免 test 间状态污染
  __setReaderForTest(null);
  invalidateRuntimeFlagsCache();
});

describe("runtimeFlags — default fallback", () => {
  test("session_pin_mode 默认走 reader('off')", async () => {
    let calls = 0;
    __setReaderForTest(async (key) => {
      calls++;
      assert.equal(key, "session_pin_mode");
      return { value: "off" as never };
    });
    const v = await getSessionPinMode();
    assert.equal(v, "off");
    assert.equal(calls, 1);
  });

  test("phase6_account_uuid_enforce 默认走 reader('off')", async () => {
    let calls = 0;
    __setReaderForTest(async (key) => {
      calls++;
      assert.equal(key, "phase6_account_uuid_enforce");
      return { value: "off" as never };
    });
    const v = await getPhase6AccountUuidEnforce();
    assert.equal(v, "off");
    assert.equal(calls, 1);
  });
});

describe("runtimeFlags — cache hit avoids second DB read", () => {
  test("两次连续 getSessionPinMode 只走 reader 一次", async () => {
    let calls = 0;
    __setReaderForTest(async () => {
      calls++;
      return { value: "observe" as never };
    });
    const v1 = await getSessionPinMode();
    const v2 = await getSessionPinMode();
    assert.equal(v1, "observe");
    assert.equal(v2, "observe");
    assert.equal(calls, 1, "cache hit:第二次不应调 reader");
  });
});

describe("runtimeFlags — invalidate forces re-read", () => {
  test("invalidateRuntimeFlagsCache 后下一次 get 重走 reader", async () => {
    let current: "off" | "observe" | "enforce" = "off";
    let calls = 0;
    __setReaderForTest(async () => {
      calls++;
      return { value: current as never };
    });

    assert.equal(await getSessionPinMode(), "off");
    assert.equal(calls, 1);

    // 模拟 admin PUT — 改 system_settings 后调 invalidate
    current = "enforce";
    invalidateRuntimeFlagsCache();

    assert.equal(await getSessionPinMode(), "enforce");
    assert.equal(calls, 2, "invalidate 后必须重读");
  });

  test("invalidate 清掉**所有** flag 的 cache", async () => {
    __setReaderForTest(async (key) => {
      if (key === "session_pin_mode") return { value: "observe" as never };
      if (key === "phase6_account_uuid_enforce") return { value: "fail_open" as never };
      throw new Error(`unexpected key: ${key}`);
    });
    await getSessionPinMode();
    await getPhase6AccountUuidEnforce();
    assert.equal(__test_only_cache.size, 2);
    invalidateRuntimeFlagsCache();
    assert.equal(__test_only_cache.size, 0);
  });
});

describe("runtimeFlags — keys 之间独立 cache", () => {
  test("session_pin_mode cache hit 不影响 phase6_account_uuid_enforce 仍走 reader", async () => {
    const callsByKey: Record<string, number> = {};
    __setReaderForTest(async (key: SystemSettingKey) => {
      callsByKey[key] = (callsByKey[key] ?? 0) + 1;
      if (key === "session_pin_mode") return { value: "observe" as never };
      return { value: "fail_closed" as never };
    });

    await getSessionPinMode();
    await getSessionPinMode(); // cache hit
    await getPhase6AccountUuidEnforce(); // 独立,不应受 session 影响

    assert.equal(callsByKey.session_pin_mode, 1);
    assert.equal(callsByKey.phase6_account_uuid_enforce, 1);
  });
});

// Codex round 2 BLOCK 回归 — PG 瞬时不可用导致 reader throw 时,readCached 必须
// fail-open 到 DEFAULTS('off')且**不 cache 失败**,否则:
//   1. 30s 内一直 fail-open(应是窗口最小化),
//   2. throw 跨过 pickUpstream 的 PickError 契约 → leak preCheck reservation。
describe("runtimeFlags — reader throw 时 fail-open 到 DEFAULTS,不 cache", () => {
  test("PG 抛错 → 返 'off',下次 call 重试 reader(不 cache 失败)", async () => {
    let calls = 0;
    __setReaderForTest(async () => {
      calls++;
      throw new Error("PG connection refused");
    });
    const v1 = await getSessionPinMode();
    assert.equal(v1, "off");
    assert.equal(calls, 1);
    // 失败不进 cache → 下次 call 仍打 reader
    const v2 = await getSessionPinMode();
    assert.equal(v2, "off");
    assert.equal(calls, 2);
    assert.equal(__test_only_cache.size, 0, "failed read 不应 cache");
  });

  test("phase6_account_uuid_enforce 同样 fail-open 到 'off'", async () => {
    __setReaderForTest(async () => {
      throw new Error("PG timeout");
    });
    const v = await getPhase6AccountUuidEnforce();
    assert.equal(v, "off");
    assert.equal(__test_only_cache.size, 0);
  });

  test("reader 先 throw 后恢复:第二次 call 拿到真值并写 cache", async () => {
    let shouldThrow = true;
    let calls = 0;
    __setReaderForTest(async () => {
      calls++;
      if (shouldThrow) throw new Error("transient");
      return { value: "enforce" as never };
    });
    assert.equal(await getSessionPinMode(), "off"); // fail-open
    assert.equal(__test_only_cache.size, 0);
    shouldThrow = false;
    assert.equal(await getSessionPinMode(), "enforce");
    assert.equal(__test_only_cache.size, 1);
    assert.equal(calls, 2);
  });
});
