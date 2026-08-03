/**
 * fail-closed guard 单测:平台默认模型(2026-06-17 起 glm-5.2 / ark;曾为 MiniMax-M3)缺 key 时
 * master 装配 internal proxy 必须 loud-fail(throw),而非全员默认模型静默 503。(Codex plan review #4)
 *
 * 2026-07-05 修正:本测试曾滞留在 MiniMax-M3 时代的断言,与 platformDefaults 权威(glm-5.2)
 * 漂移导致常年红。改为**跟随权威推导**:从 PLATFORM_DEFAULT_MODEL → provider → keyConfigField
 * 动态取字段名断言,未来再切默认模型时本测试自动跟随,不再硬编码某一家。
 *
 * 跑法: npx tsx --test packages/commercial/src/__tests__/staticProviderGuard.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertPlatformDefaultModelConfigured,
  STATIC_PROVIDER_META,
} from "../http/proxy/staticProviderMeta.js";
import { PLATFORM_DEFAULT_MODEL } from "../platformDefaults.js";
import { findRouteProviderForModel, STATIC_KEY_PROVIDERS } from "@openclaude/protocol";

// 跟随权威推导默认模型的 provider 与 key 字段(当前 glm-5.2 → ark → ARK_CODING_PLAN_KEY)。
const defaultProvider = findRouteProviderForModel(PLATFORM_DEFAULT_MODEL);
const defaultMeta = defaultProvider ? STATIC_PROVIDER_META[defaultProvider.id] : undefined;
const defaultKeyField = defaultMeta?.keyConfigField;

describe("assertPlatformDefaultModelConfigured", () => {
  test("默认模型路由到静态 provider,缺其 key → throw(报文含字段名)", () => {
    assert.ok(defaultKeyField, "默认模型必须命中静态 provider(下方不变量测试详述)");
    const keyFieldRe = new RegExp(defaultKeyField!);
    assert.throws(
      () => assertPlatformDefaultModelConfigured({}),
      keyFieldRe,
      `缺 ${defaultKeyField} 必须 throw`,
    );
    assert.throws(
      () => assertPlatformDefaultModelConfigured({ [defaultKeyField!]: "   " }),
      keyFieldRe,
      "空白 key 视为未配置,必须 throw",
    );
  });

  test("默认模型自家 key 已配 → 不 throw;只配别家 key → 仍 throw", () => {
    assert.doesNotThrow(() =>
      assertPlatformDefaultModelConfigured({ [defaultKeyField!]: "rotated-key" }),
    );
    // 注入一个"非默认模型 provider"的 key,但缺默认模型自家 key → 仍 throw。
    const otherField =
      defaultKeyField === "DEEPSEEK_API_KEY" ? "ARK_CODING_PLAN_KEY" : "DEEPSEEK_API_KEY";
    assert.throws(() =>
      assertPlatformDefaultModelConfigured({ [otherField]: "other-provider-key" }),
    );
  });

  test("不变量:PLATFORM_DEFAULT_MODEL 当前确实路由到一个静态 provider(否则 guard 形同虚设)", () => {
    const p = findRouteProviderForModel(PLATFORM_DEFAULT_MODEL);
    assert.ok(p, `PLATFORM_DEFAULT_MODEL=${PLATFORM_DEFAULT_MODEL} 应命中静态 provider`);
    // 2026-06-17 起平台默认 = glm-5.2 → ark(此前 MiniMax-M3 时代本行曾硬编码 minimax 导致漂移红)。
    assert.equal(p?.id, "ark");
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

describe("STATIC_PROVIDER_META 完整性", () => {
  test("覆盖每个 protocol provider；ark-k3 使用独立错误/metric 与共享 Agent Plan key", () => {
    assert.deepEqual(Object.keys(STATIC_PROVIDER_META), STATIC_KEY_PROVIDERS.map((p) => p.id));
    assert.deepEqual(STATIC_PROVIDER_META["ark-k3"], {
      keyConfigField: "ARK_AGENT_PLAN_KEY",
      notConfiguredHttpCode: "ARK_K3_NOT_CONFIGURED",
      rejectMetricLabel: "ark_k3_config",
      egress: "direct",
    });
    assert.deepEqual(STATIC_PROVIDER_META.bailian, {
      keyConfigField: "BAILIAN_TOKEN_PLAN_KEY",
      notConfiguredHttpCode: "BAILIAN_NOT_CONFIGURED",
      rejectMetricLabel: "bailian_config",
      egress: "direct",
    });
  });
});
