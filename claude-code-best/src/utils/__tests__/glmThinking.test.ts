import { describe, expect, test, mock } from "bun:test";

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

describe("glm-5.1 (Ark) thinking capability", () => {
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

  test("glm-5.1/glm-5.2 不支持 adaptive thinking → CCB 走 enabled+budget(Ark 实测可用的格式)", () => {
    expect(modelSupportsAdaptiveThinking("glm-5.1")).toBe(false);
    expect(modelSupportsAdaptiveThinking("glm-5.2")).toBe(false);
    expect(modelSupportsAdaptiveThinking("MiniMax-M3")).toBe(false);
  });
});
