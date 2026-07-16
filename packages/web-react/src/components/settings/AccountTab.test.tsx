/**
 * AccountTab 测试。
 *
 * 覆盖：
 *   1. 本期套餐积分 Progress —— 仅订阅有月度额度(monthly>0)时渲染，
 *      label「本期剩余 X / Y」，已用百分比按 monthly-period 精确算；free 档不显示。
 *   2. 积分收支卡 —— 默认窗口 30d 拉 getMyUsageReport，收支趋势 / 支出构成图桩化 canvas。
 *
 * api 网络层全 mock；chart.js/auto 走轻量桩（jsdom 无 canvas 2d）。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AuthSession,
  MySubscription,
  UsageReport,
  UsageReportWindow,
  UsageResponse,
  User,
} from "../../lib/types";
import { AccountTab } from "./AccountTab";
import { createMemoryAuthSession } from "../../lib/authSession";

vi.mock("chart.js/auto", () => ({
  default: class {
    destroy() {}
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    getMySubscription: vi.fn(),
    getUsage: vi.fn(),
    getMyUsageReport: vi.fn(),
  },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { api } from "../../lib/api";

const mockedGetSub = vi.mocked(api.getMySubscription);
const mockedGetUsage = vi.mocked(api.getUsage);
const mockedGetReport = vi.mocked(api.getMyUsageReport);

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

const user = {
  id: "u1",
  credits: "5000",
  displayName: "测试用户",
  org: null,
} as unknown as User;

function makeSub(monthlyCredits: string, period: string): MySubscription {
  return {
    planCode: "lite",
    planName: "Lite",
    status: "active",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    periodCredits: period,
    monthlyCredits,
    priceCents: "3800",
    tier: 1,
    paid: true,
    balance: { wallet: "1000", period, total: "0" },
  };
}

function makeUsage(): UsageResponse {
  return {
    summary: {
      input_tokens: "0",
      output_tokens: "0",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      requests_total: "0",
      billed_credits: "0",
      debited_credits: "0",
    },
    legacy_unattributed: {
      requests: "0",
      input_tokens: "0",
      output_tokens: "0",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      billed_credits: "0",
    },
    savings: {
      savings_credits: "0",
      savings_is_estimate: false,
      savings_unavailable: false,
      savings_rows_skipped: 0,
    },
    cache: { hit_rate: null },
    sessions: { rows: [], limit: 20, offset: 0, has_more: false },
    ledger: { rows: [], next_before: null },
    cutoff_started_at: null,
  };
}

function makeReport(window: UsageReportWindow = "30d"): UsageReport {
  return {
    window,
    summary: {
      requests: "1",
      input_tokens: "1",
      output_tokens: "1",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      credits: "1",
    },
    trend: [],
    models: [],
    ledger: {
      trend: [
        { bucket: "2026-07-04", credited: "1000", debited: "200" },
        { bucket: "2026-07-05", credited: "0", debited: "688" },
      ],
      by_reason: [{ reason: "charge", debited: "888" }],
    },
  };
}

function renderTab() {
  return render(
    <AccountTab auth={auth} user={user} onManageSub={() => {}} reloadKey={0} />,
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mockedGetUsage.mockResolvedValue(makeUsage());
  mockedGetReport.mockResolvedValue(makeReport("30d"));
});

describe("AccountTab 本期套餐积分进度", () => {
  test("订阅有月度额度 → 显示进度条 + 「本期剩余 X / Y」", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    renderTab();
    // 已用 = 4000 - 3000 = 1000 → 25%
    expect(await screen.findByText("本期套餐积分")).toBeInTheDocument();
    expect(screen.getByText("本期剩余 3,000 / 4,000")).toBeInTheDocument();
    const bar = screen.getByLabelText("本期套餐积分已用");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  test("免费档(monthly=0) → 不显示进度条", async () => {
    mockedGetSub.mockResolvedValue(makeSub("0", "0"));
    renderTab();
    // 等收支卡拉完，确保组件稳定后再断言进度条不存在
    await waitFor(() => expect(mockedGetReport).toHaveBeenCalled());
    expect(screen.queryByText("本期套餐积分")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("本期套餐积分已用")).not.toBeInTheDocument();
  });
});

describe("AccountTab 积分收支卡", () => {
  test("账单流水失败不显示假空态，可重试后恢复真实空态", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    mockedGetUsage
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce(makeUsage());
    renderTab();
    expect(await screen.findByText("加载账单流水失败")).toBeInTheDocument();
    expect(screen.queryByText("暂无账单记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试账单流水" }));
    expect(await screen.findByText("暂无账单记录")).toBeInTheDocument();
    expect(mockedGetUsage).toHaveBeenCalledTimes(2);
  });

  test("默认窗口 30d 拉 getMyUsageReport，收支/支出图渲染 canvas", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    const { container } = renderTab();
    await waitFor(() => expect(mockedGetReport).toHaveBeenCalledWith(auth, "30d"));
    expect(await screen.findByText("收支趋势")).toBeInTheDocument();
    expect(screen.getByText("支出构成")).toBeInTheDocument();
    // 两张图均以 canvas 渲染
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(2);
    const flowTable = screen.getByRole("table", { name: "收支趋势，近 30 天" });
    expect(within(flowTable).getByRole("cell", { name: "1,000" })).toBeInTheDocument();
  });
});
