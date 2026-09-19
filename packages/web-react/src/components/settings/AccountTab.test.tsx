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
import { resetSubscribeUiState } from "./SubscriptionDialog";
import { createMemoryAuthSession } from "../../lib/authSession";

// 记录每次构造图表的 config，供断言双 y 轴等配置（审计 SET-17）。
const chartConfigs = vi.hoisted(() => [] as Array<{ data?: { datasets?: unknown[] }; options?: unknown }>);
vi.mock("chart.js/auto", () => ({
  default: class {
    constructor(_el: unknown, config: { data?: { datasets?: unknown[] }; options?: unknown }) {
      chartConfigs.push(config);
    }
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

function makeSub(monthlyCredits: string, period: string, paid = true): MySubscription {
  return {
    planCode: paid ? "lite" : "free",
    planName: paid ? "Lite" : "免费版",
    status: "active",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    periodCredits: period,
    monthlyCredits,
    priceCents: paid ? "3800" : "0",
    tier: paid ? 1 : 0,
    paid,
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

afterEach(() => {
  cleanup();
  resetSubscribeUiState();
});
beforeEach(() => {
  vi.clearAllMocks();
  mockedGetUsage.mockResolvedValue(makeUsage());
  mockedGetReport.mockResolvedValue(makeReport("30d"));
});

describe("AccountTab 耗尽红条分层", () => {
  test("免费用户余额为 0 → Lite 引导文案", async () => {
    mockedGetSub.mockResolvedValue(makeSub("300", "0", false));
    render(
      <AccountTab
        auth={auth}
        user={{ ...user, credits: "0" }}
        onManageSub={() => {}}
        reloadKey={0}
      />,
    );
    expect(
      await screen.findByText("免费额度已用完，开通任意订阅套餐（Lite 及以上任一档）即可继续"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开通 Lite" })).toBeInTheDocument();
    // 红卡已给出主 CTA，套餐行不再重复挂一个开同一弹层的按钮（审计 SET-14）
    expect(screen.queryByRole("button", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加量包" })).toBeInTheDocument();
  });

  test("付费用户余额为 0 → 加量包引导文案", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "0", true));
    render(
      <AccountTab
        auth={auth}
        user={{ ...user, credits: "0" }}
        onManageSub={() => {}}
        reloadKey={0}
      />,
    );
    expect(await screen.findByText("本期积分已用完，可购买加量包或升级套餐")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "购买加量包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "升级套餐" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "套餐与加量包" })).not.toBeInTheDocument();
  });
});

describe("AccountTab 本期套餐积分进度", () => {
  test("订阅有月度额度 → 显示进度条 + 「本期剩余 X / Y」,条与字同为剩余语义", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    renderTab();
    // 剩余 3000 / 4000 → 75%(审计 SET-13:此前条画已用 25%,与右侧「剩余」文字相反)
    expect(await screen.findByText("本期套餐积分")).toBeInTheDocument();
    expect(screen.getByText("本期剩余 3,000 / 4,000")).toBeInTheDocument();
    const bar = screen.getByLabelText("本期套餐积分剩余");
    expect(bar).toHaveAttribute("aria-valuenow", "75");
    expect(screen.queryByText(/含加量包积分/)).not.toBeInTheDocument();
  });

  test("加量包使剩余高于月度额度 → 进度 100% 并加注", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "9000"));
    renderTab();
    expect(await screen.findByText("本期剩余 9,000 / 4,000")).toBeInTheDocument();
    expect(screen.getByLabelText("本期套餐积分剩余")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("含加量包积分，剩余高于月度额度。")).toBeInTheDocument();
  });

  test("免费档(monthly=0) → 不显示进度条", async () => {
    mockedGetSub.mockResolvedValue(makeSub("0", "0"));
    renderTab();
    // 等收支卡拉完，确保组件稳定后再断言进度条不存在
    await waitFor(() => expect(mockedGetReport).toHaveBeenCalled());
    expect(screen.queryByText("本期套餐积分")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("本期套餐积分剩余")).not.toBeInTheDocument();
  });
});

describe("AccountTab 套餐入口", () => {
  test("余额充足时只保留套餐行一个入口,余额区不再堆三个按钮", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000", true));
    renderTab();
    expect(await screen.findByRole("button", { name: "套餐与加量包" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "购买加量包" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开通 Lite" })).not.toBeInTheDocument();
  });

  test("免费用户套餐行显示「升级套餐」", async () => {
    mockedGetSub.mockResolvedValue(makeSub("300", "300", false));
    renderTab();
    expect(await screen.findByRole("button", { name: "升级套餐" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开通 Lite" })).not.toBeInTheDocument();
  });
});

describe("AccountTab 账单流水文案", () => {
  test("未知 reason 显示「其他」并把原值留在 title", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    const usage = makeUsage();
    usage.ledger = {
      rows: [
        {
          id: "l1",
          delta: "-12",
          balance_after: "4988",
          reason: "mystery_backend_reason",
          ref_type: null,
          ref_id: null,
          memo: null,
          created_at: "2026-07-05T10:00:00.000Z",
        },
      ],
      next_before: null,
    };
    mockedGetUsage.mockResolvedValue(usage);
    renderTab();
    const label = await screen.findByText("其他");
    expect(label).toHaveAttribute("title", "mystery_backend_reason");
    expect(screen.queryByText("mystery_backend_reason")).not.toBeInTheDocument();
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
    expect(screen.getByText("充值/赠送为收入（右轴），扣费为支出（左轴）")).toBeInTheDocument();
    expect(screen.getByText("按扣费类型")).toBeInTheDocument();
    // 两张图均以 canvas 渲染
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(2);
    const flowTable = screen.getByRole("table", { name: "收支趋势，近 30 天" });
    expect(within(flowTable).getByRole("cell", { name: "1,000" })).toBeInTheDocument();
    // 审计 SET-17：收入（百万级）走右轴 y1，支出留左轴 y，不再同轴压成一条线
    await waitFor(() => expect(chartConfigs.some((c) => c.data?.datasets?.length === 2)).toBe(true));
    const flow = chartConfigs.find((c) => c.data?.datasets?.length === 2);
    const axes = (flow?.data?.datasets as Array<{ label: string; yAxisID: string }>).map((d) => [
      d.label,
      d.yAxisID,
    ]);
    expect(axes).toEqual([
      ["收入（右轴）", "y1"],
      ["支出（左轴）", "y"],
    ]);
    expect((flow?.options as { scales: { y1?: { position?: string } } }).scales.y1?.position).toBe("right");
  });

  test("套餐加载失败展示重试而非破折号", async () => {
    mockedGetSub.mockRejectedValueOnce(new Error("sub down"));
    renderTab();
    expect(await screen.findByRole("button", { name: "套餐信息加载失败 · 重试" })).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    mockedGetSub.mockResolvedValueOnce(makeSub("4000", "3000"));
    fireEvent.click(screen.getByRole("button", { name: "套餐信息加载失败 · 重试" }));
    expect(await screen.findByText("Lite")).toBeInTheDocument();
  });

  test("账单流水行同时渲染金额与「积分」单位", async () => {
    mockedGetSub.mockResolvedValue(makeSub("4000", "3000"));
    const usage = makeUsage();
    usage.ledger.rows = [
      {
        id: "led-1",
        delta: "1000",
        balance_after: "6000",
        reason: "topup",
        ref_type: null,
        ref_id: null,
        memo: null,
        created_at: "2026-07-04T12:00:00.000Z",
      },
    ];
    mockedGetUsage.mockResolvedValue(usage);
    renderTab();
    const amount = await screen.findByText("+1,000");
    const row = amount.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("积分")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/余额 6,000 积分/)).toBeInTheDocument();
  });
});
