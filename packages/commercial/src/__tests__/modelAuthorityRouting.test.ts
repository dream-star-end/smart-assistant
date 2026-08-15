/**
 * 模型权威批次 · 切片 6 —— provider_id 驱动路由 + upstream_model_id 分离 + 能力上限。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/modelAuthorityRouting.test.ts
 *
 * 覆盖(方案 §1.3 / §4):
 *   - catalog hint 存在 → 按 provider_id 选 provider 机制(**不再**靠 matchesRoute 猜)
 *   - upstream_model_id ≠ model_id → session.upstreamModel 用前者(平台 id 与上游型号名解耦)
 *   - provider_id='anthropic' / null → OAuth;未知 provider → UnroutableProviderError(fail-closed)
 *   - 无 hint(legacy / 影子期)→ 行为与本批次之前逐字节一致
 *   - capability ⊆ provider 机制上限;且上限规则与 protocol modelReasoningPolicy 的 provider
 *     分支 **parity**(两处同源规则,任一侧改了这个测试就红)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  STATIC_KEY_PROVIDERS,
  getStaticProvider,
  modelReasoningPolicy,
} from "@openclaude/protocol";

import {
  UnroutableProviderError,
  checkCapabilityWithinCeiling,
  checkSnapshotCapabilities,
  pickUpstream,
  providerCapabilityCeiling,
  selectUpstreamRoute,
  type PickUpstreamDeps,
} from "../http/proxy/upstream.js";
import { rootLogger } from "../logging/logger.js";
import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";

const log = rootLogger.child({ subsys: "modelAuthorityRouting.test" });

const NOOP_DEPS: PickUpstreamDeps = {
  scheduler: {
    pick: async () => {
      throw new Error("scheduler.pick must not be called on the static path");
    },
    release: async () => {},
  },
  staticProviderKeys: {
    ark: "ark-key",
    deepseek: "ds-key",
    minimax: "mm-key",
    opencodego: "opencode-go-key",
    "ark-k3": "ark-plan-key",
    moonshot: "moonshot-key",
    bailian: "bailian-key",
  },
};

function body(model: string) {
  return { model, messages: [], max_tokens: 100 } as unknown as Parameters<typeof pickUpstream>[1];
}

describe("selectUpstreamRoute — provider_id 驱动(catalog hint)", () => {
  test("hint.provider_id 决定 provider 机制,与 model 字面量无关", () => {
    // 一个 matchesRoute 完全不认识的 model id(新上架模型),catalog 说它归 ark。
    const route = selectUpstreamRoute("brand-new-model-2027", {
      providerId: "ark",
      upstreamModelId: "brand-new-model-2027",
    });
    assert.equal(route.kind, "static");
    assert.equal(route.kind === "static" && route.provider.id, "ark");
    // legacy 判定对同一个 id 会回落 OAuth —— 这正是本批次要根治的"靠字符串猜 provider"。
    assert.equal(selectUpstreamRoute("brand-new-model-2027").kind, "oauth");
  });

  test("upstream_model_id ≠ model_id → 上游用 upstream_model_id", () => {
    const route = selectUpstreamRoute("glm-pro", {
      providerId: "ark",
      upstreamModelId: "glm-5.2-0715",
    });
    assert.equal(route.kind === "static" && route.upstreamModel, "glm-5.2-0715");
  });

  test("ark-k3 catalog descriptor 直接选机制，不依赖 alias matchesRoute", async () => {
    const route = selectUpstreamRoute("catalog-name-that-does-not-match", {
      providerId: "ark-k3",
      upstreamModelId: "kimi-k3",
    });
    assert.equal(route.kind, "static");
    assert.equal(route.kind === "static" && route.provider.id, "ark-k3");
    const r = await pickUpstream(NOOP_DEPS, body("kimi-k3-ark"), route, log);
    assert.ok(r.ok);
    assert.equal(r.session.endpoint, "https://ark.cn-beijing.volces.com/api/plan/v1/messages");
    assert.equal(r.session.upstreamModel, "kimi-k3");
    assert.equal(r.session.dispatcher, directEgressDispatcher());

    const headers: Record<string, string> = { "anthropic-beta": "should-strip" };
    const requestBody = {
      model: "kimi-k3-ark",
      output_config: { effort: "high" },
      context_management: { edits: [] },
      service_tier: "auto",
      thinking: { type: "disabled" },
    } as unknown as Parameters<typeof r.session.applyUpstreamAuth>[1];
    r.session.applyUpstreamAuth(headers, requestBody, log);
    assert.equal(headers.authorization, "Bearer ark-plan-key");
    assert.equal(headers["anthropic-beta"], undefined);
    assert.equal((requestBody as { output_config?: unknown }).output_config, undefined);
    assert.deepEqual((requestBody as { thinking?: unknown }).thinking, { type: "disabled" });
  });

  test("opencodego catalog descriptor 让 provider-neutral canonical id 走 Go transport", async () => {
    const route = selectUpstreamRoute("deepseek-v4-flash", {
      providerId: "opencodego",
      upstreamModelId: "deepseek-v4-flash",
    });
    const r = await pickUpstream(NOOP_DEPS, body("deepseek-v4-flash"), route, log);
    assert.ok(r.ok);
    const headers: Record<string, string> = {};
    r.session.applyUpstreamAuth(headers, body("deepseek-v4-flash"), log);
    assert.equal(r.session.upstreamModel, "deepseek-v4-flash");
    assert.equal(headers["x-api-key"], "opencode-go-key");
    assert.equal(headers.authorization, undefined);
  });

  test("bailian catalog descriptor 选择 qwen3.8-max 机制与 x-api-key", async () => {
    const route = selectUpstreamRoute("catalog-qwen-max", {
      providerId: "bailian",
      upstreamModelId: "qwen3.8-max",
    });
    const r = await pickUpstream(NOOP_DEPS, body("catalog-qwen-max"), route, log);
    assert.ok(r.ok);
    const headers: Record<string, string> = {};
    r.session.applyUpstreamAuth(headers, body("catalog-qwen-max"), log);
    assert.equal(headers["x-api-key"], "bailian-key");
    assert.equal(r.session.upstreamModel, "qwen3.8-max");
  });

  test("provider_id='anthropic' / null → OAuth 池", () => {
    assert.equal(
      selectUpstreamRoute("claude-x", { providerId: "anthropic", upstreamModelId: "claude-x" })
        .kind,
      "oauth",
    );
    assert.equal(
      selectUpstreamRoute("claude-x", { providerId: null, upstreamModelId: "claude-x" }).kind,
      "oauth",
    );
  });

  test("未知 provider 机制 → 抛 UnroutableProviderError(**不**静默回落 OAuth 烧真钱)", () => {
    assert.throws(
      () =>
        selectUpstreamRoute("weird", { providerId: "not-a-provider", upstreamModelId: "weird" }),
      UnroutableProviderError,
    );
  });

  test("无 hint(legacy / 影子期)→ 与本批次之前逐字节一致", () => {
    assert.equal(selectUpstreamRoute("deepseek-v4-pro").kind, "static");
    assert.equal(selectUpstreamRoute("glm-5.2").kind, "static");
    assert.equal(selectUpstreamRoute("glm-5.3").kind, "static");
    assert.equal(selectUpstreamRoute("deepseek-v4-flash").kind, "static");
    assert.equal(selectUpstreamRoute("deepseek-v4-flash-opencode-go").kind, "static");
    assert.equal(selectUpstreamRoute("MiniMax-M3").kind, "static");
    assert.equal(selectUpstreamRoute("claude-sonnet-4-5").kind, "oauth");
  });
});

describe("PreparedUpstreamSession.upstreamModel", () => {
  test("static:hint 给的 upstream_model_id 落到 session(转发用它,计费仍用平台 id)", async () => {
    const route = selectUpstreamRoute("glm-pro", {
      providerId: "ark",
      upstreamModelId: "glm-5.2-0715",
    });
    const r = await pickUpstream(NOOP_DEPS, body("glm-pro"), route, log);
    assert.ok(r.ok);
    assert.equal(r.session.upstreamModel, "glm-5.2-0715");
    assert.equal(r.session.endpoint, getStaticProvider("ark").upstreamEndpoint);
  });

  test("static:无 hint → upstreamModel == body.model(旧行为)", async () => {
    const route = selectUpstreamRoute("glm-5.2");
    const r = await pickUpstream(NOOP_DEPS, body("glm-5.2"), route, log);
    assert.ok(r.ok);
    assert.equal(r.session.upstreamModel, "glm-5.2");
  });

  test("static:ark alias 无 hint也只在 transport 改写为 kimi-k3", async () => {
    const route = selectUpstreamRoute("kimi-k3-ark");
    assert.equal(route.kind === "static" && route.provider.id, "ark-k3");
    assert.equal(route.kind === "static" && route.upstreamModel, "kimi-k3");
    const r = await pickUpstream(NOOP_DEPS, body("kimi-k3-ark"), route, log);
    assert.ok(r.ok);
    assert.equal(r.session.upstreamModel, "kimi-k3");
  });
});

describe("能力上限:catalog capability ⊆ provider 机制上限", () => {
  test("声明 vision 但 provider 纯文本 → 违规(图片进上游必 400 打死会话)", () => {
    const ceiling = providerCapabilityCeiling(selectUpstreamRoute("glm-5.2"));
    assert.equal(ceiling.supportsVision, false);
    assert.match(
      checkCapabilityWithinCeiling(
        { supportsVision: true, supportedEfforts: [] },
        ceiling,
      ) ?? "",
      /vision/,
    );
  });

  test("effort 超出 provider 白名单 → 违规;子集 → 通过", () => {
    const ark = providerCapabilityCeiling(selectUpstreamRoute("glm-5.2"));
    assert.deepEqual([...(ark.efforts ?? [])], ["high", "max"]);
    assert.match(
      checkCapabilityWithinCeiling(
        { supportsVision: false, supportedEfforts: ["high", "low"] },
        ark,
      ) ?? "",
      /beyond provider mechanism limit/,
    );
    assert.equal(
      checkCapabilityWithinCeiling({ supportsVision: false, supportedEfforts: ["high"] }, ark),
      null,
    );
  });

  test("整体 strip output_config 的 provider(minimax/kimi/opencodego)→ 机制上不支持任何 effort 档", () => {
    const mm = providerCapabilityCeiling(selectUpstreamRoute("MiniMax-M3"));
    assert.deepEqual([...(mm.efforts ?? [])], []);
    assert.equal(mm.supportsVision, true); // MiniMax-M3 原生多模态
    assert.match(
      checkCapabilityWithinCeiling(
        { supportsVision: true, supportedEfforts: ["high"] },
        mm,
      ) ?? "",
      /beyond provider mechanism limit/,
    );
  });

  test("ark-k3 机制 ceiling = vision=true / efforts=[]", () => {
    const ceiling = providerCapabilityCeiling(
      selectUpstreamRoute("kimi-k3-ark", { providerId: "ark-k3", upstreamModelId: "kimi-k3" }),
    );
    assert.equal(ceiling.supportsVision, true);
    assert.deepEqual([...(ceiling.efforts ?? [])], []);
  });

  test("moonshot 机制 ceiling = vision=true / efforts=[low,high,max]", () => {
    for (const model of ["kimi-k3", "k3-256k"]) {
      const ceiling = providerCapabilityCeiling(selectUpstreamRoute(model));
      assert.equal(ceiling.supportsVision, true);
      assert.deepEqual([...(ceiling.efforts ?? [])], ["low", "high", "max"]);
    }
  });

  test("deepseek(无白名单、不 strip output_config)→ 无 effort 机制限制", () => {
    const ds = providerCapabilityCeiling(selectUpstreamRoute("deepseek-v4-pro"));
    assert.equal(ds.efforts, null);
    assert.equal(
      checkCapabilityWithinCeiling(
        { supportsVision: false, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
        ds,
      ),
      null,
    );
  });

  test("OAuth 路由 → vision 可用、effort 无机制限制", () => {
    const oauth = providerCapabilityCeiling({ kind: "oauth" });
    assert.equal(oauth.supportsVision, true);
    assert.equal(oauth.efforts, null);
  });

  test("快照级体检(启动/激活期断言):列出所有 active 行的违规,codex 行不参与", () => {
    const snap = {
      entries: [
        // 合规:ark 的 high/max
        {
          modelId: "glm-5.2",
          engine: "ccb",
          providerId: "ark",
          state: "active",
          capabilityProfile: { supportsVision: false, reasoning: { supported: ["high", "max"] } },
        },
        // 违规:声明 vision,但 ark 是纯文本机制
        {
          modelId: "bad-vision",
          engine: "ccb",
          providerId: "ark",
          state: "active",
          capabilityProfile: { supportsVision: true, reasoning: { supported: [] } },
        },
        // 违规:provider 机制不存在
        {
          modelId: "bad-provider",
          engine: "ccb",
          providerId: "nope",
          state: "active",
          capabilityProfile: { supportsVision: false, reasoning: { supported: [] } },
        },
        // 不参与:codex engine(不走 anthropic proxy 机制)
        {
          modelId: "gpt-5.6-sol",
          engine: "codex",
          providerId: "codex",
          state: "active",
          capabilityProfile: { supportsVision: false, reasoning: { supported: ["low", "high"] } },
        },
        // 不参与:非 active 行(staged/disabled 的编辑不该拖垮启动)
        {
          modelId: "staged-bad",
          engine: "ccb",
          providerId: "nope",
          state: "staged",
          capabilityProfile: { supportsVision: true, reasoning: { supported: ["low"] } },
        },
      ],
    };
    const violations = checkSnapshotCapabilities(snap);
    assert.equal(violations.length, 2);
    assert.ok(violations.some((v) => v.startsWith("bad-vision:")));
    assert.ok(violations.some((v) => v.startsWith("bad-provider:")));
  });

  test("**parity**:上限规则与 protocol modelReasoningPolicy 的 provider 分支同源", () => {
    // 每个静态 provider 的每个 inbound 模型:providerCapabilityCeiling(spec) 得到的 effort 上限
    // 必须与 modelReasoningPolicy(modelId).supported 完全一致(后者是 per-model 入口,前者是
    // per-provider 机制上限 —— 现网所有模型都恰好取满机制上限,故应逐项相等)。
    for (const spec of STATIC_KEY_PROVIDERS) {
      const ceiling = providerCapabilityCeiling({ kind: "static", provider: spec });
      for (const modelId of spec.inboundModelIds) {
        const policy = modelReasoningPolicy(modelId);
        const expected = ceiling.efforts === null ? null : [...ceiling.efforts];
        const actual = [...policy.supported];
        if (expected === null) {
          assert.deepEqual(actual, ["low", "medium", "high", "xhigh", "max"], modelId);
        } else {
          assert.deepEqual(actual, expected, `${spec.id}/${modelId} effort 上限漂移`);
        }
      }
    }
  });
});
