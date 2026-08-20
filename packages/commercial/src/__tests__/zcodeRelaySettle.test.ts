import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  _resetZcodeRelayRoutesForTests,
  configureZcodeRelayKv,
  expireZcodeRelayRoute,
  mintZcodeRelayRoute,
  resolveZcodeRelayRoute,
} from "../billing/zcodeRouteContext.js";
import {
  mapZcodeReportedUsage,
  planZcodeCatalogSettle,
  publishZcodeCatalogSettle,
} from "../billing/zcodeCatalogSettle.js";
import {
  evaluateGlm53ZaiSwitch,
  glm53ZaiCapabilityProfileForEngine,
  glm53ZaiSupportedEfforts,
} from "../admin/zcodeCanonicalSwitch.js";
import { CatalogConflictError } from "../admin/modelCatalogOps.js";

describe("zcode relay routes", () => {
  test("binds token to container/user/request/model and rejects mismatches", async () => {
    _resetZcodeRelayRoutesForTests();
    const minted = await mintZcodeRelayRoute({
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
      (await resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 9,
        userId: 3,
        nowMs: 1_000,
      }))?.requestId,
      "a".repeat(32),
    );
    assert.equal(
      await resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 8,
        userId: 3,
        nowMs: 1_000,
      }),
      null,
    );
    await expireZcodeRelayRoute(minted.token);
    assert.equal(
      await resolveZcodeRelayRoute({
        token: minted.token,
        containerId: 9,
        userId: 3,
        nowMs: 1_000,
      }),
      null,
    );
  });

  test("refuses user-supplied upstream ids", async () => {
    _resetZcodeRelayRoutesForTests();
    await assert.rejects(
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

  test("shared KV remains visible after a process-local map reset", async () => {
    _resetZcodeRelayRoutesForTests();
    const data = new Map<string, string>();
    configureZcodeRelayKv({
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => {
        data.set(key, value);
      },
      del: async (key) => {
        data.delete(key);
      },
    });
    const minted = await mintZcodeRelayRoute({
      containerId: 9,
      userId: 3,
      requestId: "c".repeat(32),
      modelId: "zcode-experimental",
      relayPort: 18789,
      nowMs: 1_000,
    });
    assert.equal(data.size, 1);
    for (const key of data.keys()) {
      assert.match(key, /^oc:v5:zcode-relay:[0-9a-f]{64}$/);
      assert.doesNotMatch(key, new RegExp(minted.token));
    }
    const isolated = await resolveZcodeRelayRoute({
      token: minted.token,
      containerId: 9,
      userId: 3,
      nowMs: 1_000,
    });
    assert.equal(isolated?.requestId, "c".repeat(32));
    assert.equal(isolated?.modelId, "zcode-experimental");
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

  test("folds the actual debit and publishes one exact cost event", async () => {
    const persisted: unknown[][] = [];
    const published: unknown[] = [];
    await publishZcodeCatalogSettle({
      settled: {
        usageId: 1n,
        ledgerId: 2n,
        clamped: false,
        debitedCredits: 24n,
        attributionCredits: 24n,
        balanceAfter: 900n,
      },
      requestId: "a".repeat(32),
      userId: "3",
      modelId: "glm-5.3-zai",
      sessionId: "web-session",
      traceId: "trace-1",
      persist: async (...args) => { persisted.push(args); },
      publish: (event) => { published.push(event); },
    });
    assert.deepEqual(persisted, [["a".repeat(32), "3", "24", "web-session"]]);
    assert.deepEqual(published, [{
      type: "outbound.cost_charged",
      requestId: "a".repeat(32),
      model: "glm-5.3-zai",
      sessionId: "web-session",
      costCredits: "24",
      balanceAfter: "900",
      traceId: "trace-1",
    }]);
  });

  test("persist failure is fail-soft and zero debit never publishes a charge", async () => {
    const published: unknown[] = [];
    const errors: unknown[] = [];
    await publishZcodeCatalogSettle({
      settled: {
        usageId: 1n,
        ledgerId: 2n,
        clamped: false,
        debitedCredits: 7n,
        attributionCredits: 7n,
        balanceAfter: null,
      },
      requestId: "b".repeat(32),
      userId: "3",
      modelId: "glm-5.3-zai",
      sessionId: "web-session",
      traceId: null,
      persist: async () => { throw new Error("disk unavailable"); },
      publish: (event) => { published.push(event); },
      onPersistError: (error) => { errors.push(error); },
    });
    assert.equal(errors.length, 1);
    assert.equal(published.length, 1);

    published.length = 0;
    await publishZcodeCatalogSettle({
      settled: {
        usageId: 2n,
        ledgerId: null,
        clamped: false,
        debitedCredits: null,
        attributionCredits: 0n,
        balanceAfter: null,
      },
      requestId: "c".repeat(32),
      userId: "3",
      modelId: "glm-5.3-zai",
      sessionId: "web-session",
      traceId: null,
      publish: (event) => { published.push(event); },
    });
    assert.deepEqual(published, []);
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
    capability_profile: {
      supports_vision: false,
      reasoning: { supported: ["high", "max"], codex_model_default: null },
      ccb: { capability_zero: true, supports_thinking: true },
    },
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
  test("engine-specific profile removes the fake ZCode effort knob and restores it on CCB rollback", () => {
    const zcode = glm53ZaiCapabilityProfileForEngine(live.capability_profile, "zcode");
    assert.deepEqual(glm53ZaiSupportedEfforts(zcode), []);
    assert.deepEqual(
      glm53ZaiSupportedEfforts(glm53ZaiCapabilityProfileForEngine(zcode, "ccb")),
      ["high", "max"],
    );
    assert.throws(() => glm53ZaiCapabilityProfileForEngine({}, "zcode"), /reasoning/);
  });
});

describe("0242 zcode capability versioning", () => {
  test("uses immutable version switches for forward and guarded rollback", async () => {
    const { readFile } = await import("node:fs/promises");
    const forward = await readFile(
      new URL("../db/migrations/0242_zcode_platform_capabilities.sql", import.meta.url),
      "utf8",
    );
    const rollback = await readFile(
      new URL("../db/manual/0242_zcode_platform_capabilities_rollback.sql", import.meta.url),
      "utf8",
    );
    assert.match(forward, /fn_model_switch_version/);
    assert.match(forward, /engine='ccb'.*provider_id='zai'/s);
    assert.match(forward, /reasoning,supported.*\["high","max"\]/s);
    assert.match(forward, /postcondition failed/);
    assert.doesNotMatch(forward, /UPDATE\s+model_catalog/i);
    assert.match(rollback, /openclaude\.expected_lock_version/);
    assert.match(rollback, /v_live\.lock_version <> v_expected/);
    assert.match(rollback, /fn_model_switch_version/);
    assert.match(rollback, /postcondition failed/);
    assert.doesNotMatch(rollback, /UPDATE\s+model_catalog/i);
  });
});
