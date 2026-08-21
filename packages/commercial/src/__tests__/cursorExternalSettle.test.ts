import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mapCursorReportedUsage,
  planCursorExternalSettle,
} from "../billing/cursorExternalSettle.js";
import type { ModelPricing } from "../billing/pricing.js";

function pricing(partial: Partial<ModelPricing> & Pick<ModelPricing, "model_id" | "multiplier">): ModelPricing {
  return {
    display_name: partial.model_id,
    input_per_mtok: 200n,
    output_per_mtok: 600n,
    cache_read_per_mtok: 50n,
    cache_write_per_mtok: 0n,
    enabled: true,
    sort_order: 1,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    ...partial,
  } as ModelPricing;
}

describe("mapCursorReportedUsage", () => {
  test("maps CLI observation fields and floors unsafe values to 0", () => {
    assert.deepEqual(
      mapCursorReportedUsage({
        input_tokens: 10.9,
        output_tokens: 3,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
      }),
      { input_tokens: 10, output_tokens: 3, cache_read_tokens: 8, cache_write_tokens: 2 },
    );
    assert.deepEqual(mapCursorReportedUsage({ input_tokens: -1, output_tokens: "x" }), {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });
});

describe("planCursorExternalSettle", () => {
  const grok = pricing({ model_id: "cursor-grok-4.6-high", multiplier: "1.000" });
  const grokFast = pricing({ model_id: "cursor-grok-4.6-high-fast", multiplier: "2.000" });

  test("success charges official Grok price", () => {
    const plan = planCursorExternalSettle({
      engineStatus: "success",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
      pricing: grok,
    });
    assert.equal(plan.settleStatus, "success");
    assert.equal(plan.costCredits, 800n);
  });

  test("fast multiplier doubles consumption vs sibling", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
    const high = planCursorExternalSettle({ engineStatus: "success", usage, pricing: grok });
    const fast = planCursorExternalSettle({ engineStatus: "success", usage, pricing: grokFast });
    assert.equal(high.costCredits, 800n);
    assert.equal(fast.costCredits, 1600n);
  });

  test("zero output waives a successful turn", () => {
    const plan = planCursorExternalSettle({
      engineStatus: "success",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      pricing: grok,
    });
    assert.equal(plan.costCredits, 0n);
    assert.match(plan.snapshotJson, /"waived":"no_output"/);
  });

  test("error/unavailable never debit even with tokens", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 };
    for (const engineStatus of ["error", "unavailable"] as const) {
      const plan = planCursorExternalSettle({ engineStatus, usage, pricing: grok, terminalCode: "ENGINE_ERROR" });
      assert.equal(plan.settleStatus, "error");
      assert.equal(plan.costCredits, 0n);
      assert.match(plan.snapshotJson, /cursor_engine_not_success/);
    }
  });
});
