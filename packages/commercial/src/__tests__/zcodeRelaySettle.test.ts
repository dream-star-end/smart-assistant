import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  _resetZcodeRelayRoutesForTests,
  expireZcodeRelayRoute,
  mintZcodeRelayRoute,
  resolveZcodeRelayRoute,
} from "../billing/zcodeRouteContext.js";
import { mapZcodeReportedUsage, planZcodeCatalogSettle } from "../billing/zcodeCatalogSettle.js";
import { evaluateGlm53ZaiSwitch } from "../admin/zcodeCanonicalSwitch.js";
import { CatalogConflictError } from "../admin/modelCatalogOps.js";

describe("zcode relay routes", () => {
  test("binds token to container/user/request/model and rejects mismatches", () => {
    _resetZcodeRelayRoutesForTests();
    const minted = mintZcodeRelayRoute({
      containerId: 9,
      userId: 3,
      requestId: "a".repeat(32),
      modelId: "glm-5.3-zai",
      relayPort: 18791,
      nowMs: 1_000,
    });
    assert.match(minted.token, /^[0-9a-f]{64}$/);
    assert.equal(
      minted.baseUrl,
      `http://127.0.0.1:18791/internal/v5/zcode-relay/route/${minted.token}`,
    );
    assert.equal(
      resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 9,
        userId: 3,
        nowMs: 1_000,
      })?.requestId,
      "a".repeat(32),
    );
    assert.equal(
      resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 8,
        userId: 3,
        nowMs: 1_000,
      }),
      null,
    );
    expireZcodeRelayRoute(minted.token);
    assert.equal(
      resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 9,
        userId: 3,
        nowMs: 1_000,
      }),
      null,
    );
  });

  test("refuses user-supplied upstream ids", () => {
    _resetZcodeRelayRoutesForTests();
    assert.throws(
      () =>
        mintZcodeRelayRoute({
          containerId: 1,
          userId: 1,
          requestId: "b".repeat(32),
          modelId: "zai-coding-plan/glm-5.3",
          relayPort: 1,
        }),
      /not allowlisted/,
    );
  });
});

describe("zcode catalog settle", () => {
  test("maps 0.16.3 usage fields and waives zero output", () => {
    const usage = mapZcodeReportedUsage({
      inputTokens: 10197,
      outputTokens: 19,
      cacheReadTokens: 8448,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 10216,
    });
    assert.equal(usage.input_tokens, 10197);
    assert.equal(usage.output_tokens, 19);
    assert.equal(usage.cache_read_tokens, 8448);
    const pricing = {
      model_id: "glm-5.3-zai",
      display_name: "GLM-5.3 (Z.AI)",
      input_per_mtok: 100n,
      output_per_mtok: 100n,
      cache_read_per_mtok: 0n,
      cache_write_per_mtok: 0n,
      multiplier: "1",
    } as never;
    const waived = planZcodeCatalogSettle({
      engineStatus: "success",
      usage: { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      pricing,
    });
    assert.equal(waived.costCredits, 0n);
    const failed = planZcodeCatalogSettle({
      engineStatus: "error",
      usage,
      pricing,
    });
    assert.equal(failed.settleStatus, "error");
    assert.equal(failed.costCredits, 0n);
  });
});

describe("0227 pre-cutover migration", () => {
  test("does not switch public glm-5.3-zai and pins 0.16.3 canary", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("../db/migrations/0227_zcode_engine.sql", import.meta.url), "utf8");
    assert.match(sql, /0\.16\.3/);
    assert.match(sql, /zcode-experimental/);
    assert.match(sql, /1000000/);
    assert.match(sql, /zcode-glm53-cutover/);
    assert.match(sql, /INSERT INTO model_catalog[\s\S]*staged/);
    assert.doesNotMatch(sql, /INSERT INTO model_catalog[\s\S]*disabled/i);
    assert.match(sql, /INSERT INTO model_pricing[\s\S]*FALSE[\s\S]*hidden/);
    assert.doesNotMatch(sql, /UPDATE\s+model_catalog[\s\S]*glm-5\.3-zai/i);
    assert.doesNotMatch(sql, /engine\s*=\s*'zcode'[\s\S]*glm-5\.3-zai/);
  });
});

describe("glm-5.3-zai engine switch", () => {
  const live = {
    entry_id: "1",
    engine: "ccb",
    provider_id: "zai",
    upstream_model_id: "glm-5.3",
    context_window: 1000000,
    capability_profile: {},
    capability_schema_version: 1,
    state: "active",
    lock_version: 4,
  };
  test("cutover and rollback preconditions", () => {
    assert.deepEqual(evaluateGlm53ZaiSwitch(live, "ccb-to-zcode", 4), {
      engine: "zcode",
      provider_id: "zcode",
    });
    assert.deepEqual(
      evaluateGlm53ZaiSwitch({ ...live, engine: "zcode", provider_id: "zcode" }, "zcode-to-ccb", 4),
      { engine: "ccb", provider_id: "zai" },
    );
  });
  test("refuses switching while still ccb in old-code window shape", () => {
    assert.throws(() => evaluateGlm53ZaiSwitch(live, "zcode-to-ccb", 4), CatalogConflictError);
    assert.throws(
      () => evaluateGlm53ZaiSwitch({ ...live, engine: "ccb" }, "ccb-to-zcode", 3),
      /lock_version/,
    );
    assert.throws(
      () => evaluateGlm53ZaiSwitch({ ...live, upstream_model_id: "zai/glm-5.1" }, "ccb-to-zcode", 4),
      /upstream/,
    );
  });
});
