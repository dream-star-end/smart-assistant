import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isArkGlmModel,
  isCapabilityZeroStaticModel,
  getStaticModelContextWindow,
} from "../staticKeyModels";

describe("isArkGlmModel", () => {
  test("精确匹配 glm-5.1 + glm-5.2,大小写/空白不敏感", () => {
    expect(isArkGlmModel("glm-5.1")).toBe(true);
    expect(isArkGlmModel("GLM-5.1")).toBe(true);
    expect(isArkGlmModel("  glm-5.1  ")).toBe(true);
    expect(isArkGlmModel("glm-5.2")).toBe(true);
    expect(isArkGlmModel("GLM-5.2")).toBe(true);
    expect(isArkGlmModel("  glm-5.2  ")).toBe(true);
    expect(isArkGlmModel("glm-5")).toBe(false);
    expect(isArkGlmModel("glm-5.3")).toBe(false);
  });
});

describe("isCapabilityZeroStaticModel — minimax + ark(不含 deepseek)", () => {
  test("MiniMax-M3 / glm-5.1 / glm-5.2 → true", () => {
    expect(isCapabilityZeroStaticModel("MiniMax-M3")).toBe(true);
    expect(isCapabilityZeroStaticModel("minimax-m3")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.1")).toBe(true);
    expect(isCapabilityZeroStaticModel("GLM-5.1")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.2")).toBe(true);
    expect(isCapabilityZeroStaticModel("GLM-5.2")).toBe(true);
  });
  test("deepseek **不在**能力全关集(保留 effort=max 等默认路径能力)", () => {
    expect(isCapabilityZeroStaticModel("deepseek-v4-pro")).toBe(false);
    expect(isCapabilityZeroStaticModel("deepseek-v4-flash")).toBe(false);
  });
  test("claude / gpt → false", () => {
    expect(isCapabilityZeroStaticModel("claude-opus-4-7")).toBe(false);
    expect(isCapabilityZeroStaticModel("gpt-5.5")).toBe(false);
  });
});

describe("getStaticModelContextWindow", () => {
  test("minimax=512k, ark(glm-5.1/glm-5.2)=200k", () => {
    expect(getStaticModelContextWindow("MiniMax-M3")).toBe(512_000);
    expect(getStaticModelContextWindow("glm-5.1")).toBe(200_000);
    expect(getStaticModelContextWindow("GLM-5.1")).toBe(200_000);
    expect(getStaticModelContextWindow("glm-5.2")).toBe(200_000);
    expect(getStaticModelContextWindow("GLM-5.2")).toBe(200_000);
  });
  test("deepseek 无特判 → undefined(由 caller 落 MODEL_CONTEXT_WINDOW_DEFAULT,等价现状)", () => {
    expect(getStaticModelContextWindow("deepseek-v4-pro")).toBeUndefined();
    expect(getStaticModelContextWindow("deepseek-v4-flash")).toBeUndefined();
  });
  test("非静态模型 → undefined", () => {
    expect(getStaticModelContextWindow("claude-opus-4-7")).toBeUndefined();
  });
});

// 漂移守护(CCB 侧):capabilityZero / contextWindow 与仓库根 snapshot 一致。
// CANONICAL 路由元数据源在 packages/protocol;CCB 因包边界本地镜像,靠本测试 + protocol 侧测试
// 共同钉死同一份 static-key-providers.snapshot.json。
describe("staticKeyModels — snapshot 漂移守护(CCB-owned)", () => {
  test("每个 provider 的 capabilityZero / contextWindow 与 snapshot 一致", () => {
    const snapshotPath = fileURLToPath(
      new URL("../../../../../static-key-providers.snapshot.json", import.meta.url),
    );
    const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      providers: Array<{
        id: string;
        inboundModelIds: string[];
        capabilityZero: boolean;
        contextWindow: number | null;
      }>;
    };
    for (const p of snap.providers) {
      // 用该 provider 的第一个 inbound 字面量作为代表模型 id。
      const sampleModel = p.inboundModelIds[0];
      expect(isCapabilityZeroStaticModel(sampleModel)).toBe(p.capabilityZero);
      expect(getStaticModelContextWindow(sampleModel) ?? null).toBe(p.contextWindow);
    }
  });
});
