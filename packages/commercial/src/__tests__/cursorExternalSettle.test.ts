import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CURSOR_SETTLE_SURCHARGE_ENV,
  cursorSettleMultiplier,
  mapCursorReportedUsage,
  parseCursorSettleSurcharge,
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

  test("zeroCharge (historical backfill) records would-have-charged but settles at 0", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
    const plan = planCursorExternalSettle({ engineStatus: "success", usage, pricing: grok, zeroCharge: true });
    assert.equal(plan.settleStatus, "success");
    assert.equal(plan.costCredits, 0n);
    assert.match(plan.snapshotJson, /"waived":"historical_backfill_no_charge"/);
    assert.match(plan.snapshotJson, /"wouldHaveCharged":"800"/);
    // zeroCharge is a no-op when nothing would have been charged anyway.
    const zeroOut = planCursorExternalSettle({
      engineStatus: "success",
      usage: { ...usage, output_tokens: 0 },
      pricing: grok,
      zeroCharge: true,
    });
    assert.match(zeroOut.snapshotJson, /"waived":"no_output"/);
    assert.doesNotMatch(zeroOut.snapshotJson, /historical_backfill_no_charge/);
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

  test("user Stop (error + USER_CANCELLED) charges the tokens actually consumed", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
    const plan = planCursorExternalSettle({ engineStatus: "error", usage, pricing: grok, terminalCode: "USER_CANCELLED" });
    assert.equal(plan.settleStatus, "success");
    assert.equal(plan.costCredits, 800n);
    assert.match(plan.snapshotJson, /"cursor_status":"error"/);
    assert.match(plan.snapshotJson, /"cursor_terminal_code":"USER_CANCELLED"/);
    assert.match(plan.snapshotJson, /"charged_on_user_cancel":true/);
    assert.doesNotMatch(plan.snapshotJson, /cursor_engine_not_success/);
  });

  test("user Stop with zero output is still waived as no_output", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const plan = planCursorExternalSettle({ engineStatus: "error", usage, pricing: grok, terminalCode: "USER_CANCELLED" });
    assert.equal(plan.settleStatus, "success");
    assert.equal(plan.costCredits, 0n);
    assert.match(plan.snapshotJson, /"waived":"no_output"/);
  });

  test("user Stop under historical zeroCharge still settles at 0", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
    const plan = planCursorExternalSettle({
      engineStatus: "error",
      usage,
      pricing: grok,
      terminalCode: "USER_CANCELLED",
      zeroCharge: true,
    });
    assert.equal(plan.costCredits, 0n);
    assert.match(plan.snapshotJson, /"waived":"historical_backfill_no_charge"/);
  });

  test("USER_CANCELLED does not rescue an unavailable (auth/quota) engine", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 };
    const plan = planCursorExternalSettle({ engineStatus: "unavailable", usage, pricing: grok, terminalCode: "USER_CANCELLED" });
    assert.equal(plan.settleStatus, "error");
    assert.equal(plan.costCredits, 0n);
  });

  test("cursor opus/fable settle at 2x catalog price without touching the catalog multiplier", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 };
    const fable = pricing({
      model_id: "cursor-fable-5.1-high",
      multiplier: "1.000",
      input_per_mtok: 1524n,
      output_per_mtok: 7621n,
      cache_read_per_mtok: 152n,
      cache_write_per_mtok: 1905n,
    });
    const opusFast = pricing({ model_id: "cursor-opus-5-high-fast", multiplier: "2.000" });
    assert.equal(cursorSettleMultiplier("cursor-fable-5.1-high"), "2.000");
    assert.equal(cursorSettleMultiplier("cursor-opus-5-high"), "2.000");
    assert.equal(cursorSettleMultiplier("cursor-grok-4.6-high"), null);
    assert.equal(cursorSettleMultiplier("claude-opus-5"), null);

    const plan = planCursorExternalSettle({ engineStatus: "success", usage, pricing: fable });
    // (1524 + 7621 + 152 + 1905) * 2
    assert.equal(plan.costCredits, 22_404n);
    assert.match(plan.snapshotJson, /"multiplier":"2.000"/);
    assert.match(plan.snapshotJson, /"cursor_settle_multiplier":"2.000"/);
    assert.match(plan.snapshotJson, /"catalog_multiplier":"1.000"/);
    assert.equal(fable.multiplier, "1.000");

    // -fast sibling composes: catalog 2x * surcharge 2x = 4x of base
    const noCache = { ...usage, cache_read_tokens: 0, cache_write_tokens: 0 };
    const fast = planCursorExternalSettle({ engineStatus: "success", usage: noCache, pricing: opusFast });
    assert.equal(fast.costCredits, 3_200n);
    assert.match(fast.snapshotJson, /"multiplier":"4.000"/);

    // grok untouched
    const g = planCursorExternalSettle({ engineStatus: "success", usage: noCache, pricing: grok });
    assert.equal(g.costCredits, 800n);
    assert.doesNotMatch(g.snapshotJson, /cursor_settle_multiplier/);

    // waiver bookkeeping reflects the surcharged amount
    const err = planCursorExternalSettle({ engineStatus: "error", usage, pricing: fable });
    assert.equal(err.costCredits, 0n);
    assert.match(err.snapshotJson, /"wouldHaveCharged":"22404"/);
  });

  describe("COMMERCIAL_CURSOR_SETTLE_SURCHARGE_MULTIPLIER override", () => {
    test("parses canonical NUMERIC(6,3) strings and rejects garbage", () => {
      assert.equal(parseCursorSettleSurcharge(undefined), null);
      assert.equal(parseCursorSettleSurcharge(""), null);
      assert.equal(parseCursorSettleSurcharge("0"), null);
      assert.equal(parseCursorSettleSurcharge("-1"), null);
      assert.equal(parseCursorSettleSurcharge("abc"), null);
      assert.equal(parseCursorSettleSurcharge("1e3"), null);
      assert.equal(parseCursorSettleSurcharge("1"), "1.000");
      assert.equal(parseCursorSettleSurcharge(" 1.5 "), "1.500");
      assert.equal(parseCursorSettleSurcharge("2.000"), "2.000");
    });

    test("1.000 disables the surcharge: selfhost 0269 catalog price is the debited price", () => {
      const env = { [CURSOR_SETTLE_SURCHARGE_ENV]: "1.000" };
      assert.equal(cursorSettleMultiplier("cursor-fable-5.1-high", env), null);
      assert.equal(cursorSettleMultiplier("cursor-opus-5-high-fast", env), null);
      assert.equal(cursorSettleMultiplier("cursor-grok-4.6-high", env), null);
    });

    test("other values override the default; invalid falls back to 2.000", () => {
      assert.equal(cursorSettleMultiplier("cursor-fable-5.1-high", { [CURSOR_SETTLE_SURCHARGE_ENV]: "1.5" }), "1.500");
      assert.equal(cursorSettleMultiplier("cursor-fable-5.1-high", { [CURSOR_SETTLE_SURCHARGE_ENV]: "nope" }), "2.000");
      assert.equal(cursorSettleMultiplier("cursor-fable-5.1-high", {}), "2.000");
      // Non-surcharged families never pick it up regardless of env.
      assert.equal(cursorSettleMultiplier("cursor-grok-4.6-high", { [CURSOR_SETTLE_SURCHARGE_ENV]: "3" }), null);
    });

    test("planCursorExternalSettle honours the override through process.env (0269 fable at 150 credits/USD)", () => {
      const prev = process.env[CURSOR_SETTLE_SURCHARGE_ENV];
      process.env[CURSOR_SETTLE_SURCHARGE_ENV] = "1.000";
      try {
        // 0269 Fable 5.1 fen/MTok: 1500 / 7500 / 38 / 1875.
        const fable = pricing({
          model_id: "cursor-fable-5.1-high",
          multiplier: "1.000",
          input_per_mtok: 1500n,
          output_per_mtok: 7500n,
          cache_read_per_mtok: 38n,
          cache_write_per_mtok: 1875n,
        });
        // A real Cursor Fable 5.1 cycle row from the pool snapshot:
        // 23_532 in / 3_447_104 out / 28_139_627 cw / 410_126_070 cr = 626.52 USD.
        const usage = {
          input_tokens: 23_532,
          output_tokens: 3_447_104,
          cache_read_tokens: 410_126_070,
          cache_write_tokens: 28_139_627,
        };
        const plan = planCursorExternalSettle({ engineStatus: "success", usage, pricing: fable });
        // cost_credits debits the ledger 1:1 (what the UI shows as 积分):
        // ≈ 94_235 credits → 150.4 credits per USD.
        const perUsd = Number(plan.costCredits) / 626.52;
        assert.ok(perUsd > 148 && perUsd < 153, `expected ~150 credits/USD, got ${perUsd}`);
        assert.match(plan.snapshotJson, /"multiplier":"1.000"/);
        assert.doesNotMatch(plan.snapshotJson, /cursor_settle_multiplier/);
        assert.doesNotMatch(plan.snapshotJson, /catalog_multiplier/);

        // Fast sibling keeps its own catalog 2x and nothing more.
        const opusFast = pricing({
          model_id: "cursor-opus-5-high-fast",
          multiplier: "2.000",
          input_per_mtok: 1050n,
          output_per_mtok: 3750n,
          cache_read_per_mtok: 27n,
          cache_write_per_mtok: 1313n,
        });
        const fast = planCursorExternalSettle({
          engineStatus: "success",
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
          pricing: opusFast,
        });
        assert.equal(fast.costCredits, 9_600n);
        assert.match(fast.snapshotJson, /"multiplier":"2.000"/);
        assert.doesNotMatch(fast.snapshotJson, /cursor_settle_multiplier/);
      } finally {
        if (prev === undefined) delete process.env[CURSOR_SETTLE_SURCHARGE_ENV];
        else process.env[CURSOR_SETTLE_SURCHARGE_ENV] = prev;
      }
    });
  });
});
