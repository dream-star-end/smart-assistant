/**
 * agentModelAuthority.test.ts —— master 侧 agentId → 模型权威快照。
 *
 * 两条 seed 权威路径(模型权威批次 §5,flag OC_SEED_AUTHORITY_BY_REV):
 *   - 旧(flag 未开):seed = master 常量镜像(platformDefaults + protocol);
 *   - 新(flag=1,阶段 B):seed = **该容器 bundle rev 的 platform-seed 声明**;
 *     rev 缺失/坏 bundle → fail-closed 抛 SeedDeclarationError,**绝不回落常量**
 *     (回落 = 滚动窗口计费分叉重现)。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";

import { PLATFORM_DEFAULT_MODEL, PLATFORM_HIDDEN_REVIEWER_MODEL } from "../platformDefaults.js";
import {
  SEED_AUTHORITY_BY_REV_ENV,
  buildAgentModelSnapshot,
  loadAgentModelResolverForUser,
  runtimeDeniedAgentIds,
  seedAuthorityByRevEnabled,
} from "../ws/agentModelAuthority.js";
import { SeedDeclarationError, type SeedAgentExecution } from "../ws/seedDeclarationLoader.js";

/** marketplace InstalledAgent 的最小形状(快照只读 slug + rawManifest)。 */
const installed = (slug: string, model: string) =>
  ({ slug, rawManifest: JSON.stringify({ model }) }) as never;

describe("agentModelAuthority — 旧路径(flag 未开:seed = master 常量镜像)", () => {
  test("master snapshot includes all runtime builtin seed agents", () => {
    const snapshot = buildAgentModelSnapshot([], []);

    assert.equal(snapshot.get("main"), PLATFORM_DEFAULT_MODEL);
    assert.equal(snapshot.get("codex"), DEFAULT_CODEX_ENGINE_MODEL);
    assert.equal(snapshot.get("hidden-reviewer"), PLATFORM_HIDDEN_REVIEWER_MODEL);
  });

  test("优先级:installed < presets < 内置 seed(reserved id 不被市场同名项顶掉)", () => {
    const snapshot = buildAgentModelSnapshot(
      [installed("main", "hacked-model"), installed("mine", "deepseek-v4-pro")],
      [installed("main", "preset-model"), installed("coder", "glm-5.2")],
    );
    assert.equal(snapshot.get("main"), PLATFORM_DEFAULT_MODEL, "内置 seed 最高优先");
    assert.equal(snapshot.get("mine"), "deepseek-v4-pro");
    assert.equal(snapshot.get("coder"), "glm-5.2");
  });

  test("市场未就绪同名项不能 deny 内置 seed Agent", () => {
    assert.deepEqual(
      [...runtimeDeniedAgentIds(new Set(["main", "codex", "hidden-reviewer", "mine"]))],
      ["mine"],
    );
  });
});

describe("agentModelAuthority — 阶段 B(flag=1:seed = 该容器 bundle rev 的声明)", () => {
  test("flag 解析:仅 '1' 开启(未设/其它值 = 旧路径,零行为变化)", () => {
    assert.equal(seedAuthorityByRevEnabled({}), false);
    assert.equal(seedAuthorityByRevEnabled({ [SEED_AUTHORITY_BY_REV_ENV]: "0" }), false);
    assert.equal(seedAuthorityByRevEnabled({ [SEED_AUTHORITY_BY_REV_ENV]: "true" }), false);
    assert.equal(seedAuthorityByRevEnabled({ [SEED_AUTHORITY_BY_REV_ENV]: "1" }), true);
  });

  test("传入 seed 声明 → seed 层完全由声明决定(master 侧无 seed 硬编码)", () => {
    const seedExecutions = new Map<string, SeedAgentExecution>([
      // 模拟滚动窗口里跑**旧 bundle** 的容器:其声明指向旧模型,master 必须按它计费。
      ["main", { model: "glm-5.1", provider: "ark" }],
      ["codex", { model: "gpt-5.6-terra", provider: "codex-native", runnerKind: "app-server" }],
      ["hidden-reviewer", { model: "glm-5.1", provider: "ark" }],
    ]);
    const snapshot = buildAgentModelSnapshot(
      [installed("mine", "deepseek-v4-pro")],
      [installed("coder", "glm-5.2")],
      seedExecutions,
    );
    assert.equal(snapshot.get("main"), "glm-5.1", "seed 层按该 rev 的声明,而非 master 常量");
    assert.equal(snapshot.get("codex"), "gpt-5.6-terra");
    assert.equal(snapshot.get("hidden-reviewer"), "glm-5.1");
    // marketplace 层不受影响。
    assert.equal(snapshot.get("mine"), "deepseek-v4-pro");
    assert.equal(snapshot.get("coder"), "glm-5.2");
  });

  test("声明里没有的 seed id 不再凭空出现(权威 = 声明,不做常量兜底)", () => {
    const snapshot = buildAgentModelSnapshot([], [], new Map([["main", { model: "glm-5.2", provider: "ark" }]]));
    assert.equal(snapshot.get("main"), "glm-5.2");
    assert.equal(
      snapshot.get("codex"),
      undefined,
      "该 rev 的声明没有 codex → resolver 返 null → bridge 对无 model 的帧 fail-closed",
    );
  });

  test("deny 过滤跟随该 bundle rev 的 seed id 集合", () => {
    const seedExecutions = new Map<string, SeedAgentExecution>([
      ["main", { model: "glm-5.2", provider: "ark" }],
      ["review-v2", { model: "glm-5.2", provider: "ark" }],
    ]);
    assert.deepEqual(
      [...runtimeDeniedAgentIds(new Set(["main", "review-v2", "codex", "mine"]), seedExecutions)],
      ["codex", "mine"],
    );
  });

  test("fail-closed:flag=1 但 bundleRev 缺失/非法 → SeedRevInvalid(且不打 DB)", async () => {
    for (const bad of [undefined, "", "BADREV"]) {
      await assert.rejects(
        () =>
          loadAgentModelResolverForUser(1n, {
            env: { [SEED_AUTHORITY_BY_REV_ENV]: "1" },
            bundleRev: bad,
            platformRoot: "/nonexistent-platform-root",
          }),
        (err: unknown) => err instanceof SeedDeclarationError && err.code === "SeedRevInvalid",
        `bundleRev=${JSON.stringify(bad)} 必须 fail-closed(绝不回落 master 常量)`,
      );
    }
  });

  test("fail-closed:flag=1 且 rev 合法但 bundle 不存在 → SeedRevUnavailable", async () => {
    await assert.rejects(
      () =>
        loadAgentModelResolverForUser(1n, {
          env: { [SEED_AUTHORITY_BY_REV_ENV]: "1" },
          bundleRev: "0123456789ab",
          platformRoot: "/nonexistent-platform-root",
        }),
      (err: unknown) => err instanceof SeedDeclarationError && err.code === "SeedRevUnavailable",
    );
  });
});
