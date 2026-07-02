/**
 * Per-turn idle watchdog 阈值选择策略测试。
 *
 * 锁住 `pickIdleTimeoutMs` 的真值表 —— 防止以后有人把"compacting → TOOL 档"
 * 这个 OR 分支无意识地"清理"掉,从而再次让 auto-compact 期间被 5min 看门狗
 * 误杀(参见 sessionManager.ts 顶部 IDLE_TIMEOUT_*_MS 注释里的 2026-05-25
 * 触发记录)。
 *
 * 这里**只测纯函数**,不引 fakeTimer,不构造真 runner,不模拟 reject 行为。
 * watchdog 生命周期由 `submit()` 的 setInterval 拥有,与阈值选择策略解耦。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerIdleTimeout.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_TIMEOUT_DEFAULT_MS,
  IDLE_TIMEOUT_TOOL_MS,
  pickIdleTimeoutMs,
} from "../sessionManager.js";

describe("pickIdleTimeoutMs", () => {
  test("没有 pending tool 且非 compacting → DEFAULT 档(5min)", () => {
    assert.equal(pickIdleTimeoutMs(null, 0), IDLE_TIMEOUT_DEFAULT_MS);
    assert.equal(pickIdleTimeoutMs(undefined, 0), IDLE_TIMEOUT_DEFAULT_MS);
  });

  test("pending tool > 0 → TOOL 档(15min)", () => {
    assert.equal(pickIdleTimeoutMs(null, 1), IDLE_TIMEOUT_TOOL_MS);
    assert.equal(pickIdleTimeoutMs(null, 5), IDLE_TIMEOUT_TOOL_MS);
    assert.equal(pickIdleTimeoutMs(undefined, 1), IDLE_TIMEOUT_TOOL_MS);
  });

  test("compacting 且无 pending tool → TOOL 档(本次修复核心 case)", () => {
    assert.equal(pickIdleTimeoutMs("compacting", 0), IDLE_TIMEOUT_TOOL_MS);
  });

  test("compacting 且有 pending tool → TOOL 档(两条件都命中)", () => {
    assert.equal(pickIdleTimeoutMs("compacting", 2), IDLE_TIMEOUT_TOOL_MS);
  });

  test("codex engine 高推理/长上下文首帧前静默 → TOOL 档(15min)", () => {
    // M1a:第三参从 providerTag('codex-native')泛化为 engine id('codex')。
    assert.equal(pickIdleTimeoutMs(null, 0, "codex"), IDLE_TIMEOUT_TOOL_MS);
    assert.equal(pickIdleTimeoutMs(undefined, 0, "codex"), IDLE_TIMEOUT_TOOL_MS);
    // 旧 provider 语义 tag 不再命中 codex 档(engine tag 是唯一入口)。
    assert.equal(pickIdleTimeoutMs(null, 0, "codex-native"), IDLE_TIMEOUT_DEFAULT_MS);
    // ccb engine 走 DEFAULT 档不变。
    assert.equal(pickIdleTimeoutMs(null, 0, "ccb"), IDLE_TIMEOUT_DEFAULT_MS);
  });

  test("两档常量值正确(防止有人随手调小 DEFAULT)", () => {
    assert.equal(IDLE_TIMEOUT_TOOL_MS, 15 * 60_000);
    assert.equal(IDLE_TIMEOUT_DEFAULT_MS, 5 * 60_000);
  });
});
