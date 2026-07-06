/**
 * 0105「模型与服务商」运维页 — 纯函数校验单测(无 DB)。
 *
 * 跑法: npx tsx --test packages/commercial/src/__tests__/modelOpsValidation.unit.test.ts
 *
 * 覆盖:
 *   - effortMetaForModel:按 protocol spec 推导思考深度适用性(ark 白名单/capability-zero
 *     不适用/deepseek 透传/OAuth 全枚举)
 *   - normalizeDefaultEffort:值域 + per-model 适用性拒绝
 *   - normalizePriceCents:整数分/边界/垃圾输入
 *   - applyModelDefaultEffort:注入合并语义(client 显式优先/保留其他子字段)
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effortMetaForModel, EFFORT_ENUM } from "../admin/modelOps.js";
import {
  normalizeDefaultEffort,
  normalizePriceCents,
  normalizeVisibility,
  normalizeDisplayName,
} from "../admin/pricing.js";
import { applyModelDefaultEffort, type ProxyBody } from "../http/proxy/shared.js";

describe("effortMetaForModel — protocol 推导适用性", () => {
  it("ark glm-5.2:白名单 high/max", () => {
    assert.deepEqual(effortMetaForModel("glm-5.2"), { applicable: true, allowed: ["high", "max"] });
  });
  it("capability-zero 静态(strip output_config):kimi/qwen/minimax → 不适用", () => {
    for (const m of ["kimi-k2.7-code", "qwen3.7-max", "qwen3.7-plus", "MiniMax-M3"]) {
      assert.deepEqual(effortMetaForModel(m), { applicable: false, allowed: [] }, m);
    }
  });
  it("deepseek(静态但不 strip,透传)→ 全枚举", () => {
    assert.deepEqual(effortMetaForModel("deepseek-v4-pro"), {
      applicable: true,
      allowed: EFFORT_ENUM,
    });
  });
  it("非静态路由(gpt-5.5 / 未知)→ 全枚举", () => {
    assert.deepEqual(effortMetaForModel("gpt-5.5"), { applicable: true, allowed: EFFORT_ENUM });
    assert.deepEqual(effortMetaForModel("some-future-model"), {
      applicable: true,
      allowed: EFFORT_ENUM,
    });
  });
});

describe("normalizeDefaultEffort", () => {
  it("null=清除;合法档位通过", () => {
    assert.equal(normalizeDefaultEffort("glm-5.2", null), null);
    assert.equal(normalizeDefaultEffort("glm-5.2", "high"), "high");
    assert.equal(normalizeDefaultEffort("gpt-5.5", "xhigh"), "xhigh");
    assert.equal(normalizeDefaultEffort("deepseek-v4-pro", "max"), "max");
  });
  it("ark 白名单外档位拒(medium 不在 glm-5.2 的 high/max)", () => {
    assert.throws(() => normalizeDefaultEffort("glm-5.2", "medium"), /effort_not_allowed_for_provider/);
  });
  it("capability-zero 模型拒(配了也会被 upstream strip,不做静默无效配置)", () => {
    assert.throws(() => normalizeDefaultEffort("kimi-k2.7-code", "high"), /effort_not_applicable_for_model/);
    assert.throws(() => normalizeDefaultEffort("MiniMax-M3", "low"), /effort_not_applicable_for_model/);
  });
  it("非法值域拒", () => {
    assert.throws(() => normalizeDefaultEffort("gpt-5.5", "turbo"), /invalid_default_effort/);
    assert.throws(() => normalizeDefaultEffort("gpt-5.5", 3 as unknown), /invalid_default_effort/);
  });
});

describe("normalizePriceCents — 整数分 + 边界", () => {
  it("合法:0 / 正整数 / 数字字符串", () => {
    assert.equal(normalizePriceCents(0, "input_per_mtok"), "0");
    assert.equal(normalizePriceCents(684, "input_per_mtok"), "684");
    assert.equal(normalizePriceCents("2880", "output_per_mtok"), "2880");
    assert.equal(normalizePriceCents(100_000_000, "output_per_mtok"), "100000000");
  });
  it("拒:负数/小数/超上限/垃圾", () => {
    for (const bad of [-1, 1.5, 100_000_001, "abc", "", null, undefined, NaN, "1.2"]) {
      assert.throws(() => normalizePriceCents(bad, "input_per_mtok"), /invalid_input_per_mtok/, String(bad));
    }
  });
  it("字符串只认十进制数字(拒 1e3/0x10 等 Number() 旁门写法)", () => {
    for (const bad of ["1e3", "0x10", "+12", "12.0", "１２"]) {
      assert.throws(() => normalizePriceCents(bad, "input_per_mtok"), /invalid_input_per_mtok/, bad);
    }
  });
});

describe("patchPricing — 价格列强制乐观锁(同步抛,零 DB 交互)", () => {
  it("带价格列但缺 if_match_lock_version → 拒", async () => {
    const { patchPricing } = await import("../admin/pricing.js");
    await assert.rejects(
      patchPricing("glm-5.2", { input_per_mtok: 1 }, { adminId: 1 }),
      /if_match_required_for_price_changes/,
    );
  });
  it("if_match_lock_version 非法值 → 拒", async () => {
    const { patchPricing } = await import("../admin/pricing.js");
    await assert.rejects(
      patchPricing("glm-5.2", { input_per_mtok: 1, if_match_lock_version: -1 }, { adminId: 1 }),
      /invalid_if_match_lock_version/,
    );
    await assert.rejects(
      patchPricing("glm-5.2", { input_per_mtok: 1, if_match_lock_version: 1.5 }, { adminId: 1 }),
      /invalid_if_match_lock_version/,
    );
  });
});

describe("normalizeVisibility / normalizeDisplayName", () => {
  it("visibility 枚举", () => {
    assert.equal(normalizeVisibility("public"), "public");
    assert.throws(() => normalizeVisibility("everyone"), /invalid_visibility/);
  });
  it("display_name trim + 1..128", () => {
    assert.equal(normalizeDisplayName("  Kimi K2.7 Code (256k) "), "Kimi K2.7 Code (256k)");
    assert.throws(() => normalizeDisplayName("   "), /invalid_display_name/);
    assert.throws(() => normalizeDisplayName("x".repeat(129)), /invalid_display_name/);
  });
});

describe("applyModelDefaultEffort — 注入合并语义", () => {
  const mk = (oc?: unknown): ProxyBody =>
    ({ model: "glm-5.2", max_tokens: 64, messages: [], ...(oc !== undefined ? { output_config: oc } : {}) }) as unknown as ProxyBody;

  it("无 output_config → 注入 { effort }", () => {
    const b = mk();
    applyModelDefaultEffort(b, "high");
    assert.deepEqual(b.output_config, { effort: "high" });
  });
  it("client 显式 effort → 不动(client 优先)", () => {
    const b = mk({ effort: "low" });
    applyModelDefaultEffort(b, "high");
    assert.deepEqual(b.output_config, { effort: "low" });
  });
  it("有其他子字段无 effort → 合并保留(OAuth 透传路径不能丢字段)", () => {
    const b = mk({ task_budget: 5 });
    applyModelDefaultEffort(b, "max");
    assert.deepEqual(b.output_config, { task_budget: 5, effort: "max" });
  });
  it("default 为空/null → noop", () => {
    const b = mk({ task_budget: 5 });
    applyModelDefaultEffort(b, null);
    applyModelDefaultEffort(b, undefined);
    assert.deepEqual(b.output_config, { task_budget: 5 });
  });
  it("output_config 为 null → 视为缺失,注入", () => {
    const b = mk(null);
    applyModelDefaultEffort(b, "high");
    assert.deepEqual(b.output_config, { effort: "high" });
  });
});
