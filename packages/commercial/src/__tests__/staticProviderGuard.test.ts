/**
 * fail-closed guard 单测:平台默认模型(2026-06-16 起 MiniMax-M3 / minimax)缺 key 时 master 装配
 * internal proxy 必须 loud-fail(throw),而非全员默认模型静默 503。(Codex plan review #4)
 *
 * 跑法: npx tsx --test packages/commercial/src/__tests__/staticProviderGuard.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertPlatformDefaultModelConfigured } from "../http/proxy/staticProviderMeta.js";
import { PLATFORM_DEFAULT_MODEL } from "../platformDefaults.js";
import { findRouteProviderForModel } from "@openclaude/protocol";

describe("assertPlatformDefaultModelConfigured", () => {
  test("默认模型(MiniMax-M3)路由到 minimax,缺 MINIMAX_TOKEN_PLAN_KEY → throw", () => {
    assert.throws(
      () => assertPlatformDefaultModelConfigured({}),
      /MINIMAX_TOKEN_PLAN_KEY/,
      "缺 minimax key 必须 throw",
    );
    assert.throws(
      () => assertPlatformDefaultModelConfigured({ MINIMAX_TOKEN_PLAN_KEY: "   " }),
      /MINIMAX_TOKEN_PLAN_KEY/,
      "空白 key 视为未配置,必须 throw",
    );
  });

  test("默认模型 minimax key 已配 → 不 throw(无关 provider 的 key 不影响)", () => {
    assert.doesNotThrow(() =>
      assertPlatformDefaultModelConfigured({ MINIMAX_TOKEN_PLAN_KEY: "mm-rotated-key" }),
    );
    // 注入别家 key 但缺 minimax → 仍 throw(只认默认模型自己 provider 的 key)
    assert.throws(() =>
      assertPlatformDefaultModelConfigured({ ARK_CODING_PLAN_KEY: "ark" }),
    );
  });

  test("不变量:PLATFORM_DEFAULT_MODEL 当前确实路由到一个静态 provider(否则 guard 形同虚设)", () => {
    const p = findRouteProviderForModel(PLATFORM_DEFAULT_MODEL);
    assert.ok(p, `PLATFORM_DEFAULT_MODEL=${PLATFORM_DEFAULT_MODEL} 应命中静态 provider`);
    assert.equal(p?.id, "minimax");
  });

  // 结构守护(Codex diff review Blocker):guard 调用必须在 internal-proxy 装配的 try **之前**,
  // 否则缺 key 的 throw 会被该 try 的 catch("internal proxy ... disabling")降级吞掉 → 变成
  // "internal proxy 禁用但 master 照跑",违反 loud-fail。这里用源码文本结构断言钉死调用位置。
  test("index.ts 把 assertPlatformDefaultModelConfigured(cfg) 放在 internal-proxy try 之外(之前)", () => {
    const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const src = readFileSync(indexPath, "utf-8");

    const guardIdx = src.indexOf("assertPlatformDefaultModelConfigured(cfg)");
    assert.ok(guardIdx >= 0, "必须存在 assertPlatformDefaultModelConfigured(cfg) 调用");

    const handlerIdx = src.indexOf("internalProxyHandler = makeAnthropicProxyHandler({");
    assert.ok(handlerIdx > guardIdx, "internal proxy 装配应在 guard 之后");

    // guard 与 handler 装配之间必须出现一个 `try {`,证明 try 在 guard 之后开 → guard 在 try 外。
    const between = src.slice(guardIdx, handlerIdx);
    assert.match(
      between,
      /\btry\s*\{/,
      "guard 调用与 makeAnthropicProxyHandler 之间必须有 try{ —— 即 guard 在 internal-proxy try 之外(之前)",
    );
  });
});
