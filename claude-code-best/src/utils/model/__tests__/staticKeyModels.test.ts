import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { modelSupportsThinking } from "../../thinking.js";
import { fileURLToPath } from "node:url";

import {
  isArkGlmModel,
  isArkPlanKimiK3Model,
  isArkPlanKimiModel,
  isBailianQwen38MaxModel,
  isMoonshotKimiK3Model,
  isCapabilityZeroStaticModel,
  isOpencodeGoModel,
  OPENCODE_GO_CHAT_MODEL_IDS,
  OPENCODE_GO_RESPONSES_MODEL_IDS,
  OPENCODE_GO_MESSAGES_MODEL_IDS,
  isOpencodeQwenModel,
  isZaiGlm53Model,
  getStaticModelContextWindow,
  getAuthorityModelCapabilities,
} from "../staticKeyModels";

const AUTH_ENV = "OC_MODEL_EXECUTION_DESCRIPTOR";
afterEach(() => { delete process.env[AUTH_ENV]; });

describe("signed execution descriptor override", () => {
  test("新 model id 不查 baked 表:context/capability 全取 descriptor", () => {
    process.env[AUTH_ENV] = JSON.stringify({
      canonicalModel: "oc-catalog-canary-glm52",
      contextWindow: 777_000,
      capabilityZero: true,
      supportsThinking: true,
      supportsVision: false,
      supportedEfforts: ["high", "max"],
    });
    expect(getAuthorityModelCapabilities("oc-catalog-canary-glm52")?.supportsThinking).toBe(true);
    expect(isCapabilityZeroStaticModel("oc-catalog-canary-glm52")).toBe(true);
    expect(getStaticModelContextWindow("oc-catalog-canary-glm52")).toBe(777_000);
  });

  test("畸形非空 descriptor fail-closed", () => {
    process.env[AUTH_ENV] = "{bad";
    expect(() => isCapabilityZeroStaticModel("glm-5.2")).toThrow();
  });
});

describe("isArkGlmModel", () => {
  test("精确匹配 glm-5.1 + glm-5.2 + glm-5.3,大小写/空白不敏感", () => {
    expect(isArkGlmModel("glm-5.1")).toBe(true);
    expect(isArkGlmModel("GLM-5.1")).toBe(true);
    expect(isArkGlmModel("  glm-5.1  ")).toBe(true);
    expect(isArkGlmModel("glm-5.2")).toBe(true);
    expect(isArkGlmModel("GLM-5.2")).toBe(true);
    expect(isArkGlmModel("  glm-5.2  ")).toBe(true);
    expect(isArkGlmModel("glm-5.3")).toBe(true);
    expect(isArkGlmModel(" GLM-5.3 ")).toBe(true);
    expect(isArkGlmModel("glm-5")).toBe(false);
    expect(isArkGlmModel("glm-5.4")).toBe(false);
  });
});

describe("isZaiGlm53Model", () => {
  test("精确匹配 glm-5.3-zai，不抢 Ark glm-5.3", () => {
    expect(isZaiGlm53Model("glm-5.3-zai")).toBe(true);
    expect(isZaiGlm53Model(" GLM-5.3-ZAI ")).toBe(true);
    expect(isZaiGlm53Model("glm-5.3")).toBe(false);
    expect(isZaiGlm53Model("glm-5.3-zai-preview")).toBe(false);
  });
});

describe("isOpencodeGoModel", () => {
  test("精确匹配 DeepSeek 平台 alias 与历史 Qwen", () => {
    expect(isOpencodeGoModel("deepseek-v4-flash-opencode-go")).toBe(true);
    expect(isOpencodeGoModel(" DeepSeek-V4-Flash-OpenCode-Go ")).toBe(true);
    expect(isOpencodeGoModel("deepseek-v4-flash")).toBe(false);
    expect(isOpencodeGoModel("qwen3.7-max")).toBe(true);
    expect(isOpencodeGoModel("qwen3.7-plus")).toBe(true);
  });
});

describe("isOpencodeQwenModel", () => {
  test("精确匹配 qwen3.7-max + qwen3.7-plus,大小写/空白不敏感", () => {
    expect(isOpencodeQwenModel("qwen3.7-max")).toBe(true);
    expect(isOpencodeQwenModel("Qwen3.7-Max")).toBe(true);
    expect(isOpencodeQwenModel("  qwen3.7-plus  ")).toBe(true);
    expect(isOpencodeQwenModel("qwen3.6-plus")).toBe(false);
    expect(isOpencodeQwenModel("qwen3.7")).toBe(false);
    expect(isOpencodeQwenModel("qwen3.7-max-preview")).toBe(false);
  });
});

describe("isArkPlanKimiModel", () => {
  test("精确匹配 kimi-k2.7-code,大小写/空白不敏感", () => {
    expect(isArkPlanKimiModel("kimi-k2.7-code")).toBe(true);
    expect(isArkPlanKimiModel("Kimi-K2.7-Code")).toBe(true);
    expect(isArkPlanKimiModel("  kimi-k2.7-code  ")).toBe(true);
    expect(isArkPlanKimiModel("kimi-k2.7")).toBe(false);
    expect(isArkPlanKimiModel("kimi-k2.6")).toBe(false);
    expect(isArkPlanKimiModel("kimi-k2.7-code-preview")).toBe(false);
  });
});

describe("isArkPlanKimiK3Model", () => {
  test("精确匹配平台 alias kimi-k3-ark，不抢官方 kimi-k3", () => {
    expect(isArkPlanKimiK3Model("kimi-k3-ark")).toBe(true);
    expect(isArkPlanKimiK3Model(" Kimi-K3-Ark ")).toBe(true);
    expect(isArkPlanKimiK3Model("kimi-k3")).toBe(false);
  });
});

describe("isMoonshotKimiK3Model", () => {
  test("精确匹配官方 kimi-k3 / k3-256k，不扩放前后缀", () => {
    expect(isMoonshotKimiK3Model("kimi-k3")).toBe(true);
    expect(isMoonshotKimiK3Model(" K3-256K ")).toBe(true);
    expect(isMoonshotKimiK3Model(" K3.1-PRO ")).toBe(true);
    expect(isMoonshotKimiK3Model("k3.1-pro-highspeed")).toBe(false);
    expect(isMoonshotKimiK3Model("kimi-k3.1")).toBe(false);
    expect(isMoonshotKimiK3Model("k3-256k-preview")).toBe(false);
    expect(isMoonshotKimiK3Model("kimi-k3-ark")).toBe(false);
  });
});

describe("isBailianQwen38MaxModel", () => {
  test("精确匹配正式 qwen3.8-max，不放过 preview/旧型号", () => {
    expect(isBailianQwen38MaxModel("qwen3.8-max")).toBe(true);
    expect(isBailianQwen38MaxModel(" Qwen3.8-Max ")).toBe(true);
    expect(isBailianQwen38MaxModel("qwen3.8-max-preview")).toBe(false);
    expect(isBailianQwen38MaxModel("qwen3.7-max")).toBe(false);
  });
});

describe("isCapabilityZeroStaticModel — minimax + ark + opencodego qwen(不含 deepseek)", () => {
  test("MiniMax-M3 / glm-5.x / OpenCode Go models → true", () => {
    expect(isCapabilityZeroStaticModel("MiniMax-M3")).toBe(true);
    expect(isCapabilityZeroStaticModel("minimax-m3")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.1")).toBe(true);
    expect(isCapabilityZeroStaticModel("GLM-5.1")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.2")).toBe(true);
    expect(isCapabilityZeroStaticModel("GLM-5.2")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.3")).toBe(true);
    expect(isCapabilityZeroStaticModel("glm-5.3-zai")).toBe(true);
    expect(isCapabilityZeroStaticModel("deepseek-v4-flash-opencode-go")).toBe(true);
    expect(isCapabilityZeroStaticModel("qwen3.7-max")).toBe(true);
    expect(isCapabilityZeroStaticModel("qwen3.7-plus")).toBe(true);
    expect(isCapabilityZeroStaticModel("kimi-k2.7-code")).toBe(true);
    expect(isCapabilityZeroStaticModel("kimi-k3-ark")).toBe(true);
    expect(isCapabilityZeroStaticModel("kimi-k3")).toBe(true);
    expect(isCapabilityZeroStaticModel("k3-256k")).toBe(true);
    expect(isCapabilityZeroStaticModel("k3.1-pro")).toBe(true);
    expect(isCapabilityZeroStaticModel("qwen3.8-max")).toBe(true);
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
  test("minimax=512k, ark glm-5.1=200k / glm-5.2+5.3=1M, OpenCode Go=1M", () => {
    expect(getStaticModelContextWindow("MiniMax-M3")).toBe(512_000);
    expect(getStaticModelContextWindow("glm-5.1")).toBe(200_000);
    expect(getStaticModelContextWindow("GLM-5.1")).toBe(200_000);
    expect(getStaticModelContextWindow("glm-5.2")).toBe(1_000_000);
    expect(getStaticModelContextWindow("GLM-5.2")).toBe(1_000_000);
    expect(getStaticModelContextWindow("glm-5.3")).toBe(1_000_000);
    expect(getStaticModelContextWindow("glm-5.3-zai")).toBe(1_000_000);
    expect(getStaticModelContextWindow("deepseek-v4-flash-opencode-go")).toBe(1_000_000);
    expect(getStaticModelContextWindow("qwen3.7-max")).toBe(1_000_000);
    expect(getStaticModelContextWindow("qwen3.7-plus")).toBe(1_000_000);
    expect(getStaticModelContextWindow("kimi-k2.7-code")).toBe(256_000);
    expect(getStaticModelContextWindow("kimi-k3-ark")).toBe(1_048_576);
    expect(getStaticModelContextWindow("kimi-k3")).toBe(1_048_576);
    expect(getStaticModelContextWindow("k3.1-pro")).toBe(1_048_576);
    expect(modelSupportsThinking("k3.1-pro")).toBe(true);
    expect(getStaticModelContextWindow("k3-256k")).toBe(262_144);
    expect(getStaticModelContextWindow("qwen3.8-max")).toBe(983_616);
  });
  test("deepseek V4 Flash / Pro 精确命中 1M，未声明的 deepseek-* 不扩放", () => {
    expect(getStaticModelContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(getStaticModelContextWindow("  DEEPSEEK-V4-FLASH  ")).toBe(1_000_000);
    expect(getStaticModelContextWindow("deepseek-v4-preview")).toBeUndefined();
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

 test("Gemini Go is capability-zero with a conservative 1M window", () => {
  expect(isOpencodeGoModel('gemini-4-argon-contributor')).toBe(true);
  expect(isCapabilityZeroStaticModel('gemini-4-argon-contributor')).toBe(true);
  expect(getStaticModelContextWindow('gemini-4-argon-contributor')).toBe(1000000);
  expect(isOpencodeGoModel('gemini-4-argon')).toBe(false);
 });

describe("OCV5-425 OpenCode Go /messages models (CCB fallback)", () => {
  test("the CCB id list mirrors protocol OPENCODE_GO_MESSAGES_MODELS", async () => {
    const protocol = await import("../../../../../packages/protocol/src/staticKeyProviders.ts");
    expect([...OPENCODE_GO_MESSAGES_MODEL_IDS].sort()).toEqual(
      Object.keys(protocol.OPENCODE_GO_MESSAGES_MODELS).sort(),
    );
    expect([...OPENCODE_GO_CHAT_MODEL_IDS].sort()).toEqual(
      Object.keys(protocol.OPENCODE_GO_CHAT_MODELS).sort(),
    );
    expect([...OPENCODE_GO_RESPONSES_MODEL_IDS].sort()).toEqual(
      Object.keys(protocol.OPENCODE_GO_RESPONSES_MODELS).sort(),
    );
    for (const id of OPENCODE_GO_RESPONSES_MODEL_IDS) {
      expect(isOpencodeGoModel(id)).toBe(true);
      expect(modelSupportsThinking(id)).toBe(false);
    }
    expect(getStaticModelContextWindow("opencode-grok-4.7")).toBe(200_000);
    expect(getStaticModelContextWindow("opencode-gpt-6-luna")).toBe(272_000);
    expect(getStaticModelContextWindow("muse-spark-1.3-go")).toBe(1_048_576);
  });

  test("chat bridge models: capability-zero, no Anthropic thinking, catalog windows", () => {
    for (const id of OPENCODE_GO_CHAT_MODEL_IDS) {
      expect(isOpencodeGoModel(id)).toBe(true);
      expect(isCapabilityZeroStaticModel(id)).toBe(true);
      expect(modelSupportsThinking(id)).toBe(false);
    }
    expect(getStaticModelContextWindow("hy3-go")).toBe(192_000);
    expect(getStaticModelContextWindow("kimi-k2.7-code-go")).toBe(262_144);
    expect(getStaticModelContextWindow("mimo-v2.6-pro-go")).toBe(1_048_576);
    expect(getStaticModelContextWindow("glm-5.3-go")).toBe(1_000_000);
    expect(isOpencodeGoModel("glm-5.3")).toBe(false);
  });

  test("capability-zero Go models; thinking except Claude Haiku; windows capped at the price tier", () => {
    for (const id of OPENCODE_GO_MESSAGES_MODEL_IDS) {
      expect(isOpencodeGoModel(id)).toBe(true);
      expect(isCapabilityZeroStaticModel(id)).toBe(true);
      expect(modelSupportsThinking(id)).toBe(id !== "claude-haiku-5-5-go");
    }
    expect(getStaticModelContextWindow("claude-haiku-5-5-go")).toBe(100_000);
    expect(getStaticModelContextWindow("minimax-m3-go")).toBe(200_000);
    expect(getStaticModelContextWindow("qwen3.7-plus-go")).toBe(200_000);
    expect(getStaticModelContextWindow("minimax-m2.7-go")).toBe(204_800);
    expect(getStaticModelContextWindow("qwen3.8-max-go")).toBe(262_144);
    expect(getStaticModelContextWindow("kimi-k3-go")).toBe(1_048_576);
    expect(getStaticModelContextWindow("deepseek-v4-pro-go")).toBe(1_000_000);
    expect(getStaticModelContextWindow("qwen3.8-flash-go")).toBe(1_000_000);
    // bare names keep their own providers' rows
    expect(isOpencodeGoModel("kimi-k3")).toBe(false);
    expect(getStaticModelContextWindow("deepseek-v4-pro")).toBe(1_000_000);
  });
});
