import { describe, expect, test } from "vitest";
import type { OrgUsageTrendPoint } from "../../lib/types";
import { sortByCreditsDesc, trendMax } from "./ReportsTab";

describe("sortByCreditsDesc（按扣费降序，BigInt 精确）", () => {
  test("大数降序（越过 2^53 仍正确，不 Number 化）", () => {
    const rows = [
      { credits: "100" },
      { credits: "9007199254740993" }, // > MAX_SAFE_INTEGER
      { credits: "9007199254740992" },
      { credits: "0" },
    ];
    const out = sortByCreditsDesc(rows).map((r) => r.credits);
    expect(out).toEqual(["9007199254740993", "9007199254740992", "100", "0"]);
  });

  test("非纯数字项按 0 处理，不抛错", () => {
    const rows = [{ credits: "abc" }, { credits: "50" }, { credits: "" }];
    expect(sortByCreditsDesc(rows).map((r) => r.credits)).toEqual(["50", "abc", ""]);
  });

  test("不修改原数组（返回新数组）", () => {
    const rows = [{ credits: "1" }, { credits: "2" }];
    const out = sortByCreditsDesc(rows);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.credits)).toEqual(["1", "2"]);
  });
});

describe("trendMax（趋势字段最大值，字符串大数）", () => {
  const mk = (credits: string, requests: string): OrgUsageTrendPoint => ({
    bucket: "2026-07-06T00:00:00Z",
    credits,
    requests,
  });

  test("取 credits 最大值", () => {
    const trend = [mk("30", "5"), mk("120", "2"), mk("7", "9")];
    expect(trendMax(trend, "credits")).toBe("120");
  });

  test("取 requests 最大值", () => {
    const trend = [mk("30", "5"), mk("120", "2"), mk("7", "9")];
    expect(trendMax(trend, "requests")).toBe("9");
  });

  test("全零 / 空 → '0'", () => {
    expect(trendMax([], "credits")).toBe("0");
    expect(trendMax([mk("0", "0"), mk("0", "0")], "credits")).toBe("0");
  });

  test("超大值不丢精度", () => {
    const trend = [mk("9007199254740993", "0"), mk("100", "0")];
    expect(trendMax(trend, "credits")).toBe("9007199254740993");
  });
});
