import { describe, expect, test } from "vitest";
import type { PublicModel } from "./types";
import {
  effectiveEffortModelId,
  effortForModel,
  extractAutoDreamFeature,
  extractPrefs,
  initialModelFromPreferences,
  resolveSessionModel,
} from "./modelPreferences";

const MODELS: PublicModel[] = [
  {
    id: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.6-terra",
    display_name: "GPT-5.6-Terra",
    supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "glm-5.2", display_name: "GLM-5.2", supported_efforts: ["high", "max"] },
  { id: "MiniMax-M3", display_name: "MiniMax M3", supported_efforts: [] },
];

describe("model preferences", () => {
  test("extracts wrapped snapshots and preferred visible model wins", () => {
    const prefs = extractPrefs({
      prefs: { default_model: "gpt-5.6-terra", default_effort: "max" },
      updated_at: "x",
    });
    expect(initialModelFromPreferences(MODELS, prefs)).toBe("gpt-5.6-terra");
  });

  test("degraded/stale preference falls back to first healthy model", () => {
    const degraded = MODELS.map((m) =>
      m.id === "gpt-5.6-terra" ? { ...m, degraded: true } : m,
    );
    expect(initialModelFromPreferences(degraded, { default_model: "gpt-5.6-terra" })).toBe(
      "gpt-5.6-sol",
    );
    expect(initialModelFromPreferences(MODELS, { default_model: "gpt-5.5" })).toBe(
      "gpt-5.6-sol",
    );
  });

  test("unsupported or cleared effort explicitly resets a warm runner to its model default", () => {
    expect(effortForModel(MODELS, "gpt-5.6-sol", "max")).toBe("max");
    expect(effortForModel(MODELS, "glm-5.2", "xhigh")).toBeNull();
    expect(effortForModel(MODELS, "MiniMax-M3", "high")).toBeNull();
    expect(effortForModel(MODELS, "gpt-5.6-sol", undefined)).toBeNull();
    expect(effortForModel(MODELS, "missing", "max")).toBeUndefined();
  });

  test("team leader effort is resolved against the actual Sol execution model", () => {
    expect(effectiveEffortModelId("MiniMax-M3", true)).toBe("gpt-5.6-sol");
    expect(effectiveEffortModelId("gpt-5.6-terra", false)).toBe("gpt-5.6-terra");
  });

  test("per-session 恢复解析:会话选择 > default_model > 首个健康模型", () => {
    // 会话自己的持久化选择优先(即使与 default_model 不同)
    expect(
      resolveSessionModel(MODELS, "glm-5.2", { default_model: "gpt-5.6-terra" }),
    ).toBe("glm-5.2");
    // 会话无选择 → default_model
    expect(
      resolveSessionModel(MODELS, undefined, { default_model: "gpt-5.6-terra" }),
    ).toBe("gpt-5.6-terra");
    // 会话无选择且无 default → 首个健康模型
    expect(resolveSessionModel(MODELS, undefined, {})).toBe("gpt-5.6-sol");
  });

  test("per-session 恢复解析:会话模型下架/降级不粘死,回落默认", () => {
    // 下架(不在列表)→ 回落 default_model
    expect(
      resolveSessionModel(MODELS, "retired-model", { default_model: "gpt-5.6-terra" }),
    ).toBe("gpt-5.6-terra");
    // 降级(degraded)→ 同样回落;default 也降级 → 首个健康模型
    const degraded = MODELS.map((m) =>
      m.id === "glm-5.2" || m.id === "gpt-5.6-terra" ? { ...m, degraded: true } : m,
    );
    expect(
      resolveSessionModel(degraded, "glm-5.2", { default_model: "gpt-5.6-terra" }),
    ).toBe("gpt-5.6-sol");
  });

  test("extracts Auto-Dream feature projection from preference snapshots", () => {
    const feature = {
      eligible: true,
      available: true,
      enabled: true,
      effective: true,
      minimum_plan_code: "max",
      min_interval_hours: 24,
      min_new_sessions: 5,
    };
    expect(extractAutoDreamFeature({ prefs: {}, features: { auto_dream: feature } })).toEqual(feature);
    expect(
      extractAutoDreamFeature({
        prefs: {},
        features: {
          auto_dream: {
            ...feature,
            model_id: "must-not-leak",
            model_name: "Must Not Leak",
          },
        },
      }),
    ).toEqual(feature);
    expect(extractAutoDreamFeature({ prefs: {} })).toBeNull();
  });
});
