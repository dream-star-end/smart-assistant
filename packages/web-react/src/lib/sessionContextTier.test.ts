import { beforeEach, describe, expect, test } from "vitest";
import {
  CONTEXT_TIER_GLOBAL_KEY,
  clearContextTierForSession,
  contextTierSessionKey,
  readContextTierForSession,
  writeContextTier,
} from "./sessionContextTier";

// Cursor Opus/Fable 上下文档位(300k / 1m)会话级持久化的纯逻辑单测。
// 语义与 teamMode 同模式:per-session 键优先 → 全局偏好 → 产品默认 300k。
describe("sessionContextTier 会话级持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("键名:per-session 键在全局键后缀会话 id", () => {
    expect(CONTEXT_TIER_GLOBAL_KEY).toBe("oc_v5_context_tier");
    expect(contextTierSessionKey("s1")).toBe(`${CONTEXT_TIER_GLOBAL_KEY}:s1`);
  });

  test("全空:任何会话都读到产品默认 300k", () => {
    expect(readContextTierForSession(undefined)).toBe("300k");
    expect(readContextTierForSession("s1")).toBe("300k");
  });

  test("切档同时写 per-session 键 + 全局默认键", () => {
    writeContextTier("s1", "1m");
    expect(localStorage.getItem(contextTierSessionKey("s1"))).toBe("1m");
    expect(localStorage.getItem(CONTEXT_TIER_GLOBAL_KEY)).toBe("1m");
    expect(readContextTierForSession("s1")).toBe("1m");
  });

  test("新会话继承全局偏好(上次选 1m → 新会话默认 1m)", () => {
    writeContextTier("prev", "1m");
    expect(readContextTierForSession("brandNew")).toBe("1m");
    expect(readContextTierForSession(undefined)).toBe("1m");
  });

  test("会话一旦有自己的键,后续别处切换不再影响它", () => {
    writeContextTier("pinned", "1m");
    writeContextTier("other", "300k");
    expect(localStorage.getItem(CONTEXT_TIER_GLOBAL_KEY)).toBe("300k");
    expect(readContextTierForSession("pinned")).toBe("1m");
    expect(readContextTierForSession("other")).toBe("300k");
  });

  test("非法值不透传:回退全局偏好或默认档", () => {
    localStorage.setItem(contextTierSessionKey("bad"), "1M");
    expect(readContextTierForSession("bad")).toBe("300k");
    localStorage.setItem(CONTEXT_TIER_GLOBAL_KEY, "huge");
    expect(readContextTierForSession("bad")).toBe("300k");
    localStorage.setItem(CONTEXT_TIER_GLOBAL_KEY, "1m");
    expect(readContextTierForSession("bad")).toBe("1m");
  });

  test("sessionId 为空:只写全局默认,不产生 per-session 键", () => {
    writeContextTier(undefined, "1m");
    expect(localStorage.getItem(CONTEXT_TIER_GLOBAL_KEY)).toBe("1m");
    const sessionKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith(`${CONTEXT_TIER_GLOBAL_KEY}:`),
    );
    expect(sessionKeys).toEqual([]);
  });

  test("clearContextTierForSession 删除 per-session 键,不动全局默认", () => {
    writeContextTier("gone", "1m");
    clearContextTierForSession("gone");
    expect(localStorage.getItem(contextTierSessionKey("gone"))).toBeNull();
    expect(localStorage.getItem(CONTEXT_TIER_GLOBAL_KEY)).toBe("1m");
    expect(readContextTierForSession("gone")).toBe("1m");
  });
});
