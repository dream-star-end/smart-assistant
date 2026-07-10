import { describe, expect, test } from "vitest";
import { fmtCompactNum, subCountdown, usageLine, utilTone } from "../helpers";

describe("fmtCompactNum", () => {
  test("K / M 缩写与 BIGINT 字符串", () => {
    expect(fmtCompactNum(999)).toBe("999");
    expect(fmtCompactNum(1500)).toBe("1.5K");
    expect(fmtCompactNum("2500000")).toBe("2.5M");
    expect(fmtCompactNum(null)).toBe("0");
    expect(fmtCompactNum("abc")).toBe("—");
  });
});

describe("subCountdown", () => {
  test("null=长期,已过期=danger,<7天=danger,<30天=warning", () => {
    expect(subCountdown(null)).toEqual({ label: "长期/未登记", tone: "neutral" });
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(subCountdown(past).tone).toBe("danger");
    const in3 = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(subCountdown(in3).tone).toBe("danger");
    const in20 = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect(subCountdown(in20).tone).toBe("warning");
    const in60 = new Date(Date.now() + 60 * 86_400_000).toISOString();
    expect(subCountdown(in60).tone).toBe("neutral");
  });
});

describe("utilTone", () => {
  test(">80% danger / >50% warning / 其余 success", () => {
    expect(utilTone(9, 10)).toEqual({ pct: 90, tone: "danger" });
    expect(utilTone(6, 10)).toEqual({ pct: 60, tone: "warning" });
    expect(utilTone(2, 10)).toEqual({ pct: 20, tone: "success" });
    expect(utilTone(1, 0).tone).toBe("success");
  });
});

describe("usageLine", () => {
  test("tokens = in + out 自加", () => {
    expect(
      usageLine({ requests: 12, input_tokens: "1000", output_tokens: "500", credits: "30" }),
    ).toBe("12 请求 · 1.5K tok · 30 积分");
    expect(usageLine(null)).toBe("—");
  });
});
