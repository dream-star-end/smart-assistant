import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthSession, OrgUsageReport, OrgUsageTrendPoint } from "../../lib/types";

// chart.js 走 canvas，jsdom 无 2d context —— 轻量桩替掉，避免 useChart 抛错。
vi.mock("chart.js/auto", () => ({
  default: class {
    destroy() {}
  },
}));

vi.mock("../../lib/api", () => ({
  api: { getOrgUsage: vi.fn() },
}));

import { api } from "../../lib/api";
import { ReportsTab, sortByCreditsDesc, trendMax } from "./ReportsTab";

const mockedGetOrgUsage = vi.mocked(api.getOrgUsage);

const auth: AuthSession = {
  getToken: () => "t",
  setToken: () => {},
  onExpired: () => {},
};

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

describe("ReportsTab 趋势图（共享 charts，替代手写 CSS 竖条）", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  const report: OrgUsageReport = {
    window: "24h",
    summary: {
      requests: "10",
      input_tokens: "100",
      output_tokens: "50",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      credits: "500",
    },
    members: [
      {
        user_id: "u1",
        email: "a@b.c",
        display_name: "A",
        requests: "10",
        input_tokens: "100",
        output_tokens: "50",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        credits: "500",
      },
    ],
    models: [
      {
        model: "glm-5.2",
        requests: "10",
        input_tokens: "100",
        output_tokens: "50",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        credits: "500",
      },
    ],
    trend: [
      { bucket: "2026-07-06T00:00:00Z", requests: "3", credits: "200" },
      { bucket: "2026-07-06T01:00:00Z", requests: "7", credits: "300" },
    ],
  };

  test("趋势区渲染为共享 canvas 图表（非手写竖条），标题按扣费口径", async () => {
    mockedGetOrgUsage.mockResolvedValue(report);
    const { container } = render(<ReportsTab auth={auth} />);
    // 默认窗口 24h
    await waitFor(() => expect(mockedGetOrgUsage).toHaveBeenCalledWith(auth, "24h"));
    // 趋势卡标题（credits 非零 → 按扣费）
    expect(await screen.findByText("趋势 · 按扣费")).toBeInTheDocument();
    // 图表以 canvas 渲染（旧手写竖条无 canvas）
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
