import { afterEach, describe, expect, test, mock } from "bun:test";

// glm-5.1(火山 Ark)与 MiniMax-M3 都是 thinking 模型:modelSupportsThinking 应为 true
// (其余 betas/effort/adaptive-thinking 仍关 —— 它们仍在 isCapabilityZeroStaticModel 集合)。
// mock thinking.ts 的重依赖,避免 import 链炸(测的函数对 glm-5.1/MiniMax 都早返回,不碰这些)。

mock.module("src/services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}));
mock.module("src/utils/settings/settings.js", () => ({
  getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
}));
mock.module("src/utils/model/modelSupportOverrides.js", () => ({
  get3PModelCapabilityOverride: () => undefined,
}));
mock.module("src/utils/model/providers.js", () => ({
  getAPIProvider: () => "firstParty",
}));
mock.module("src/utils/model/antModels.js", () => ({
  resolveAntModel: () => undefined,
  getAntModelOverrideConfig: () => undefined,
}));
mock.module("src/utils/model/model.js", () => ({
  getCanonicalName: (m: string) => m,
}));

const { modelSupportsThinking, modelSupportsAdaptiveThinking } = await import(
  "src/utils/thinking.js"
);
afterEach(() => { delete process.env.OC_MODEL_EXECUTION_DESCRIPTOR; });

describe("Ark GLM / OpenCode Go thinking capability", () => {
  test("catalog 新 id 的 thinking 只认 descriptor", () => {
    process.env.OC_MODEL_EXECUTION_DESCRIPTOR = JSON.stringify({
      canonicalModel: "new-ccb-model",
      contextWindow: null,
      capabilityZero: false,
      supportsThinking: false,
      supportsVision: false,
      supportedEfforts: [],
    });
    expect(modelSupportsThinking("new-ccb-model")).toBe(false);
  });
  test("modelSupportsThinking glm-5.1 = true(大小写不敏感)", () => {
    expect(modelSupportsThinking("glm-5.1")).toBe(true);
    expect(modelSupportsThinking("GLM-5.1")).toBe(true);
  });

  test("MiniMax-M3 thinking = true(2026-06-16 起,直连验证端点接受 thinking;大小写不敏感)", () => {
    expect(modelSupportsThinking("MiniMax-M3")).toBe(true);
    expect(modelSupportsThinking("minimax-m3")).toBe(true);
  });

  test("glm-5.2(火山 Ark,2026-06-17 主力)thinking = true(同 glm-5.1;大小写不敏感)", () => {
    expect(modelSupportsThinking("glm-5.2")).toBe(true);
    expect(modelSupportsThinking("GLM-5.2")).toBe(true);
  });

  test("glm-5.3 / Z.AI alias 与 OpenCode Go DeepSeek alias thinking=true、adaptive=false", () => {
    expect(modelSupportsThinking("glm-5.3")).toBe(true);
    expect(modelSupportsAdaptiveThinking("glm-5.3")).toBe(false);
    expect(modelSupportsThinking("glm-5.3-zai")).toBe(true);
    expect(modelSupportsAdaptiveThinking("glm-5.3-zai")).toBe(false);
    expect(modelSupportsThinking("deepseek-v4-flash-opencode-go")).toBe(true);
    expect(modelSupportsAdaptiveThinking("deepseek-v4-flash-opencode-go")).toBe(false);
  });

  test("kimi-k3-ark(火山 Agent Plan K3)thinking=true、adaptive=false", () => {
    expect(modelSupportsThinking("kimi-k3-ark")).toBe(true);
    expect(modelSupportsAdaptiveThinking("kimi-k3-ark")).toBe(false);
  });

  test("Moonshot kimi-k3/k3-256k thinking=true、adaptive=false", () => {
    for (const model of ["kimi-k3", "k3-256k"]) {
      expect(modelSupportsThinking(model)).toBe(true);
      expect(modelSupportsAdaptiveThinking(model)).toBe(false);
    }
  });

  test("qwen3.8-max(百炼 Token Plan)thinking=true、adaptive=false", () => {
    expect(modelSupportsThinking("qwen3.8-max")).toBe(true);
    expect(modelSupportsAdaptiveThinking("qwen3.8-max")).toBe(false);
  });

  test("glm-5.1/5.2/5.3 不支持 adaptive thinking → CCB 走 enabled+budget(Ark 实测可用的格式)", () => {
    expect(modelSupportsAdaptiveThinking("glm-5.1")).toBe(false);
    expect(modelSupportsAdaptiveThinking("glm-5.2")).toBe(false);
    expect(modelSupportsAdaptiveThinking("glm-5.3")).toBe(false);
    expect(modelSupportsAdaptiveThinking("MiniMax-M3")).toBe(false);
  });
});
