/**
 * 模型 catalog admin 入口 + 四面 capability 广播 —— 纯单元测试(无 DB)。
 *
 *   1. normalizeVersionInput:形状门(model_id / engine / provider / schema 版本 / capability 形状)
 *   2. validateVersionSemantics:激活期四条语义门
 *        provider_id ∈ 机制集 / matchesRoute 命中 / capability ⊆ 上限 / 有价格行
 *   3. 机制集 parity:ccbProviderIds() 与 proxy 的 selectUpstreamRoute 接受集不得漂移
 *      (两处若各抄一份枚举,新增 provider 时必然一处漏改 → 激活一个路由不出去的模型)
 *   4. capability 广播 + 步骤 5 兼容地板(runtimeCapabilities.ts ↔ release-metadata.json 同源)
 *   5. audit action 登记(catalog 是安全权威表 → 必须 tx fail-closed)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_EGRESS_CAPABILITY,
} from "@openclaude/protocol";

import {
  OAUTH_PROVIDER_ID,
  ccbProviderIds,
  codexProviderIds,
  normalizeVersionInput,
  validateVersionSemantics,
} from "../admin/modelCatalogOps.js";
import { UnroutableProviderError, selectUpstreamRoute } from "../http/proxy/upstream.js";
import {
  EGRESS_CAPABILITIES,
  MASTER_CAPABILITIES,
  MODEL_AUTHORITY_CUTOVER_ENV,
  assertModelAuthorityCutoverFloor,
  isModelAuthorityCutoverDone,
} from "../runtimeCapabilities.js";
import { ADMIN_AUDIT_ACTIONS } from "../admin/auditActions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** capability_profile 的 DB 形状(snake_case,与 0135 fn_model_catalog_capability 同源)。 */
function profile(
  supportsVision: boolean,
  supported: string[],
  codexDefault: string | null = null,
): unknown {
  return {
    supports_vision: supportsVision,
    reasoning: { supported, codex_model_default: codexDefault },
  };
}

/** 一个通过全部语义门的 ark(glm-5.2)行:ceiling = {vision:false, efforts:[high,max]}。 */
function glm52(over: Record<string, unknown> = {}): unknown {
  return {
    model_id: "glm-5.2",
    engine: "ccb",
    provider_id: "ark",
    upstream_model_id: null,
    context_window: 1_000_000,
    capability_profile: profile(false, ["high", "max"]),
    ...over,
  };
}

describe("model catalog admin — 形状门(normalizeVersionInput)", () => {
  test("合法行归一成功", () => {
    const v = normalizeVersionInput(glm52());
    assert.equal(v.model_id, "glm-5.2");
    assert.equal(v.engine, "ccb");
    assert.equal(v.provider_id, "ark");
    assert.equal(v.capability_schema_version, 1);
    assert.deepEqual(v.capability.reasoning.supported, ["high", "max"]);
  });

  test("非法 model_id / engine / provider 形态 → RangeError", () => {
    assert.throws(() => normalizeVersionInput(glm52({ model_id: "bad id!" })), RangeError);
    assert.throws(() => normalizeVersionInput(glm52({ engine: "vllm" })), RangeError);
    assert.throws(() => normalizeVersionInput(glm52({ provider_id: "Ark Cloud" })), RangeError);
  });

  test("engine='ccb' 必须带 provider_id(0135 CHECK 的应用层同构)", () => {
    assert.throws(() => normalizeVersionInput(glm52({ provider_id: null })), RangeError);
  });

  test("未来 capability schema 版本 → 拒(R2-m15 消费侧 fail-closed)", () => {
    assert.throws(() => normalizeVersionInput(glm52({ capability_schema_version: 2 })), RangeError);
  });

  test("capability_profile 形状不合法 → 拒(写进去的必须与读出来的同形)", () => {
    assert.throws(
      () => normalizeVersionInput(glm52({ capability_profile: { supports_vision: "yes" } })),
      RangeError,
    );
    assert.throws(
      () => normalizeVersionInput(glm52({ capability_profile: profile(false, ["turbo"]) })),
      RangeError,
    );
  });
});

describe("model catalog admin — 激活期四条语义门", () => {
  test("合法 ccb 行 + 有价格行 → 零违规", () => {
    assert.deepEqual(validateVersionSemantics(normalizeVersionInput(glm52()), true), []);
  });

  test("无价格行 → 拒激活(active 却无价 = 计费面 fail-closed 拒服务)", () => {
    const v = validateVersionSemantics(normalizeVersionInput(glm52()), false);
    assert.equal(v.length, 1);
    assert.match(v[0]!, /model_pricing 无 'glm-5\.2' 行/);
  });

  test("provider_id ∉ 机制集 → 拒", () => {
    const v = validateVersionSemantics(normalizeVersionInput(glm52({ provider_id: "bogus" })), true);
    assert.ok(v.some((x) => /∉ engine='ccb' 的服务端机制集/.test(x)));
  });

  test("matchesRoute 不符 → 拒(hint 缺失的回落路径会打到另一个上游)", () => {
    // minimax-m3 的 protocol 路由是 minimax,catalog 却声明 ark
    const v = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "minimax-m3",
        engine: "ccb",
        provider_id: "ark",
        upstream_model_id: null,
        context_window: 512_000,
        capability_profile: profile(false, []),
      }),
      true,
    );
    assert.ok(v.some((x) => /matchesRoute\(minimax-m3\) → 'minimax'/.test(x)));
  });

  test("未知 model + 静态 provider → 拒;未知 model + OAuth → 放行", () => {
    const staticClaim = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "brand-new-model",
        engine: "ccb",
        provider_id: "ark",
        upstream_model_id: "glm-5.2",
        context_window: null,
        capability_profile: profile(false, ["high"]),
      }),
      true,
    );
    assert.ok(staticClaim.some((x) => /matchesRoute\(brand-new-model\)/.test(x)));

    const oauthClaim = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "brand-new-model",
        engine: "ccb",
        provider_id: OAUTH_PROVIDER_ID,
        upstream_model_id: null,
        context_window: null,
        capability_profile: profile(true, ["low", "medium", "high", "xhigh", "max"]),
      }),
      true,
    );
    assert.deepEqual(oauthClaim, []);
  });

  test("capability > provider 机制上限 → 拒(vision / effort 两轴)", () => {
    const vision = validateVersionSemantics(
      normalizeVersionInput(glm52({ capability_profile: profile(true, ["high"]) })),
      true,
    );
    assert.ok(vision.some((x) => /vision but provider mechanism is text-only/.test(x)));

    const effort = validateVersionSemantics(
      normalizeVersionInput(glm52({ capability_profile: profile(false, ["low", "high"]) })),
      true,
    );
    assert.ok(effort.some((x) => /efforts \[low\] beyond provider mechanism limit/.test(x)));
  });

  test("ccb 行不得声明 codex_model_default", () => {
    const v = validateVersionSemantics(
      normalizeVersionInput(glm52({ capability_profile: profile(false, ["high"], "high") })),
      true,
    );
    assert.ok(v.some((x) => /不得声明 codex_model_default/.test(x)));
  });

  test("codex engine:白名单内型号放行,白名单外拒(容器 codex adapter 起不来)", () => {
    const sol = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "gpt-5.6-sol",
        engine: "codex",
        provider_id: "codex",
        upstream_model_id: null,
        context_window: null,
        capability_profile: profile(false, ["low", "medium", "high", "xhigh", "max"], "xhigh"),
      }),
      true,
    );
    assert.deepEqual(sol, []);

    const unknown = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "gpt-9-turbo",
        engine: "codex",
        provider_id: "codex",
        upstream_model_id: null,
        context_window: null,
        capability_profile: profile(false, ["high"], "high"),
      }),
      true,
    );
    assert.ok(unknown.some((x) => /∉ protocol CODEX_ENGINE_MODEL_IDS/.test(x)));
  });

  test("protocol 声明的 codex 型号不得挂 engine='ccb'", () => {
    const v = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "gpt-5.6-luna",
        engine: "ccb",
        provider_id: "anthropic",
        upstream_model_id: null,
        context_window: null,
        capability_profile: profile(false, ["medium"]),
      }),
      true,
    );
    assert.ok(v.some((x) => /engine 不能是 'ccb'/.test(x)));
  });

  test("codex_model_default 必须 ∈ reasoning.supported", () => {
    const v = validateVersionSemantics(
      normalizeVersionInput({
        model_id: "gpt-5.6-luna",
        engine: "codex",
        provider_id: "codex",
        upstream_model_id: null,
        context_window: null,
        capability_profile: profile(false, ["low", "medium"], "max"),
      }),
      true,
    );
    assert.ok(v.some((x) => /codex_model_default='max' ∉ reasoning\.supported/.test(x)));
  });
});

describe("model catalog admin — provider 机制集 parity(禁止第二份枚举)", () => {
  test("ccbProviderIds() 的每个 id 都能被 proxy 的 selectUpstreamRoute 接受", () => {
    for (const id of ccbProviderIds()) {
      const route = selectUpstreamRoute("x", { providerId: id, upstreamModelId: "x" });
      assert.ok(route.kind === "oauth" || route.kind === "static", `provider ${id} 无法路由`);
    }
    assert.ok(ccbProviderIds().includes(OAUTH_PROVIDER_ID));
    assert.deepEqual(codexProviderIds(), ["codex"]);
  });

  test("机制集之外的 provider 在 proxy 侧必抛 UnroutableProviderError", () => {
    assert.ok(!ccbProviderIds().includes("bogus"));
    assert.throws(
      () => selectUpstreamRoute("x", { providerId: "bogus", upstreamModelId: "x" }),
      UnroutableProviderError,
    );
  });
});

describe("四面 capability 广播 + 步骤 5 兼容地板", () => {
  test("master / egress 广播各自的 capability token(protocol 常量单一权威)", () => {
    assert.deepEqual(MASTER_CAPABILITIES, [MODEL_AUTHORITY_CAPABILITY]);
    assert.deepEqual(EGRESS_CAPABILITIES, [MODEL_AUTHORITY_EGRESS_CAPABILITY]);
  });

  test("release-metadata.json 与进程广播同源(制品面 ⊇ 进程面)", () => {
    const meta = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "deploy/v5/release-metadata.json"), "utf8"),
    ) as { capabilities: string[]; runtimeCapabilities: string[]; requiredMigrations: string[] };
    for (const cap of [...MASTER_CAPABILITIES, ...EGRESS_CAPABILITIES]) {
      assert.ok(
        meta.capabilities.includes(cap),
        `release-metadata.capabilities 缺 ${cap} —— deploy 守卫会拒绝激活本 release`,
      );
    }
    assert.deepEqual(meta.runtimeCapabilities, [MODEL_AUTHORITY_CAPABILITY]);
    assert.ok(meta.requiredMigrations.includes("0135_model_catalog"));
  });

  test("cutover marker 置位 + flag 关 → 拒启(不可逆地板);其余组合放行", () => {
    const done = { [MODEL_AUTHORITY_CUTOVER_ENV]: "1" } as NodeJS.ProcessEnv;
    assert.ok(isModelAuthorityCutoverDone(done));
    assert.throws(() => assertModelAuthorityCutoverFloor(done), /compat floor violated/);

    assert.doesNotThrow(() =>
      assertModelAuthorityCutoverFloor({
        [MODEL_AUTHORITY_CUTOVER_ENV]: "1",
        OC_MODEL_AUTHORITY: "1",
      } as NodeJS.ProcessEnv),
    );
    // 步骤 4(flag 开、marker 未置位)与步骤 3 之前(两者都关)都合法
    assert.doesNotThrow(() =>
      assertModelAuthorityCutoverFloor({ OC_MODEL_AUTHORITY: "1" } as NodeJS.ProcessEnv),
    );
    assert.doesNotThrow(() => assertModelAuthorityCutoverFloor({} as NodeJS.ProcessEnv));
    assert.ok(!isModelAuthorityCutoverDone({} as NodeJS.ProcessEnv));
  });
});

describe("model catalog admin — 审计登记", () => {
  test("四个 catalog action 均已登记且为 tx fail-closed(安全权威表)", () => {
    for (const action of [
      "model_catalog.stage",
      "model_catalog.activate",
      "model_catalog.disable",
      "model_catalog.switch",
    ] as const) {
      const spec = ADMIN_AUDIT_ACTIONS[action];
      assert.ok(spec, `${action} 未在 auditActions.ts 登记`);
      assert.equal(spec.kind, "write");
      assert.equal(spec.mode, "tx", `${action} 必须 tx:审计写不下去 = 业务回滚`);
    }
  });
});
