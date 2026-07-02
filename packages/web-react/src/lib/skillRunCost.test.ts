import { describe, expect, it } from "vitest";
import {
  creditsForUsage,
  estimateEvalRunCredits,
  fmtCreditRange,
  fmtCredits,
  ratesFromPublicModel,
} from "./skillRunCost";

const PRO = {
  id: "deepseek-v4-pro",
  display_name: "DeepSeek V4 Pro (1M)",
  input_per_ktok_credits: "0.006280",
  output_per_ktok_credits: "0.012540",
  cache_read_per_ktok_credits: "0.000060",
  cache_write_per_ktok_credits: "0.000000",
  multiplier: "2.000",
};

describe("ratesFromPublicModel", () => {
  it("parses string rates (already multiplier-applied) and rejects garbage", () => {
    const r = ratesFromPublicModel(PRO);
    expect(r?.inputPerKtok).toBeCloseTo(0.00628);
    expect(r?.displayName).toBe("DeepSeek V4 Pro (1M)");
    expect(ratesFromPublicModel({ id: "x" })).toBeNull();
    expect(ratesFromPublicModel(undefined)).toBeNull();
  });
});

describe("creditsForUsage", () => {
  it("matches the billing formula Σ tokens/1000 × per_ktok", () => {
    const r = ratesFromPublicModel(PRO);
    if (!r) throw new Error("rates");
    const credits = creditsForUsage(
      { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 50_000, cacheCreationTokens: 0 },
      r,
    );
    // 100×0.00628 + 10×0.01254 + 50×0.00006 = 0.628 + 0.1254 + 0.003
    expect(credits).toBeCloseTo(0.7564, 4);
  });
});

describe("estimateEvalRunCredits", () => {
  it("scales with case count and returns a low<high range", () => {
    const r = ratesFromPublicModel(PRO);
    if (!r) throw new Error("rates");
    const one = estimateEvalRunCredits(1, 2, r);
    const three = estimateEvalRunCredits(3, 2, r);
    expect(one.low).toBeGreaterThan(0);
    expect(one.low).toBeLessThan(one.high);
    expect(three.low).toBeCloseTo(one.low * 3, 6);
  });
});

describe("fmtCredits", () => {
  it("formats by magnitude", () => {
    expect(fmtCredits(2.34)).toBe("2.3");
    expect(fmtCredits(0.256)).toBe("0.26");
    expect(fmtCredits(0.004)).toBe("<0.01");
    expect(fmtCredits(Number.NaN)).toBe("?");
    expect(fmtCreditRange({ low: 0.5, high: 2 })).toBe("0.50 ~ 2.0 积分");
  });
});
