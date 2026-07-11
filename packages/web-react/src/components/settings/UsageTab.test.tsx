/**
 * UsageTab 测试。
 *
 * 覆盖：
 *   1. 图表化窗口口径（顶部 pill 切换调 getMyUsageReport、stat 卡渲染窗口数据、
 *      按模型 top5 + 「其他」合并逻辑、Token/趋势图桩化 canvas 不崩）；
 *   2. 组队(delegate)归组展示（原有用例全部保留）：
 *      - 无 delegate → 与现状一致；旧后端缺字段兼容；
 *      - 含 delegate 父行 → 徽标 + 展开 per-agent；delegate_only pill。
 *
 * api 网络层全 mock；chart.js/auto 走轻量桩（jsdom 无 canvas 2d）。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AuthSession,
  UsageReport,
  UsageReportWindow,
  UsageResponse,
  UsageSessionRow,
} from "../../lib/types";
import { UsageTab, topModelsWithOther } from "./UsageTab";

// chart.js 走 canvas，jsdom 无 2d context —— 轻量桩替掉，避免 useChart 抛错。
vi.mock("chart.js/auto", () => ({
  default: class {
    destroy() {}
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    getUsage: vi.fn(),
    getMyUsageReport: vi.fn(),
  },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { api } from "../../lib/api";

const mockedGetUsage = vi.mocked(api.getUsage);
const mockedGetReport = vi.mocked(api.getMyUsageReport);

const auth: AuthSession = {
  getToken: () => "t",
  setToken: () => {},
  onExpired: () => {},
};

function makeResponse(rows: UsageSessionRow[]): UsageResponse {
  return {
    summary: {
      input_tokens: "1000",
      output_tokens: "500",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      requests_total: "3",
      billed_credits: "220",
      // 累计实际扣费用独立值，避免与会话行 billed "220" 文本碰撞。
      debited_credits: "999",
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
    sessions: { rows, limit: 20, offset: 0, has_more: false },
    ledger: { rows: [], next_before: null },
    cutoff_started_at: "2026-07-01T00:00:00.000Z",
  };
}

function makeReport(window: UsageReportWindow = "7d"): UsageReport {
  return {
    window,
    summary: {
      requests: "42",
      input_tokens: "123456",
      output_tokens: "7890",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      credits: "888",
    },
    trend: [
      { bucket: "2026-07-04", requests: "10", credits: "200" },
      { bucket: "2026-07-05", requests: "32", credits: "688" },
    ],
    models: [
      { model: "glm-5.2", requests: "30", credits: "600" },
      { model: "gpt-5.5", requests: "12", credits: "288" },
    ],
    ledger: {
      trend: [
        { bucket: "2026-07-04", credited: "0", debited: "200" },
        { bucket: "2026-07-05", credited: "1000", debited: "688" },
      ],
      by_reason: [{ reason: "charge", debited: "888" }],
    },
  };
}

function chatRow(overrides: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return {
    session_id: "uuid-chat-1",
    requests: "2",
    input_tokens: "800",
    output_tokens: "400",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    billed_credits: "220",
    last_used_at: "2026-07-04T12:00:00.000Z",
    delegate_credits: "0",
    delegate_requests: "0",
    delegate_only: false,
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // 默认两端点都成功（个别用例可覆盖）。
  mockedGetUsage.mockResolvedValue(makeResponse([chatRow()]));
  mockedGetReport.mockResolvedValue(makeReport("7d"));
});

describe("UsageTab 图表化窗口口径", () => {
  test("首屏默认 7d 拉取，stat 卡渲染窗口数据", async () => {
    render(<UsageTab auth={auth} />);
    // 首屏默认窗口 7d
    await waitFor(() => expect(mockedGetReport).toHaveBeenCalledWith(auth, "7d"));
    // 窗口口径 stat 卡（请求 42 / 输入 123456→12.3万 / 输出 7890→7,890 / 积分 888）
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("12.3万")).toBeInTheDocument();
    expect(screen.getByText("7,890")).toBeInTheDocument();
    expect(screen.getByText("888 积分")).toBeInTheDocument();
  });

  test("切换窗口 pill → 以新窗口重拉 getMyUsageReport", async () => {
    render(<UsageTab auth={auth} />);
    await screen.findByText("42");
    mockedGetReport.mockResolvedValue(makeReport("30d"));
    fireEvent.click(screen.getByRole("tab", { name: "30 天" }));
    await waitFor(() => expect(mockedGetReport).toHaveBeenCalledWith(auth, "30d"));
  });

  test("累计口径不回退：累计请求 + 累计实际扣费保留（全生命周期）", async () => {
    render(<UsageTab auth={auth} />);
    // requests_total=3 / debited_credits=999（全量口径，独立于窗口）
    expect(await screen.findByText("累计请求")).toBeInTheDocument();
    expect(screen.getByText("累计实际扣费")).toBeInTheDocument();
    expect(screen.getByText("999")).toBeInTheDocument();
  });
});

describe("topModelsWithOther（按积分降序 top5 + 合并其他）", () => {
  test("不足 5 项：原样降序，丢弃 0 积分项", () => {
    const out = topModelsWithOther([
      { model: "a", requests: "1", credits: "30" },
      { model: "b", requests: "1", credits: "70" },
      { model: "c", requests: "1", credits: "0" },
    ]);
    expect(out).toEqual([
      { label: "b", credits: 70 },
      { label: "a", credits: 30 },
    ]);
  });

  test("超过 5 项：前 5 保留，其余合并为「其他」", () => {
    const models = Array.from({ length: 7 }, (_, i) => ({
      model: `m${i}`,
      requests: "1",
      credits: String((7 - i) * 10), // 70,60,50,40,30,20,10
    }));
    const out = topModelsWithOther(models);
    expect(out.map((o) => o.label)).toEqual(["m0", "m1", "m2", "m3", "m4", "其他"]);
    // 其他 = m5(20) + m6(10) = 30
    expect(out[5]).toEqual({ label: "其他", credits: 30 });
  });

  test("全零 → 空数组（调用方显示空态）", () => {
    expect(
      topModelsWithOther([{ model: "a", requests: "0", credits: "0" }]),
    ).toEqual([]);
  });
});

describe("UsageTab delegate 归组展示", () => {
  test("无 delegate 数据:UI 与现状一致,无组队徽标/展开按钮", async () => {
    mockedGetUsage.mockResolvedValue(makeResponse([chatRow()]));
    render(<UsageTab auth={auth} />);

    expect(await screen.findByText("uuid-chat-1")).toBeInTheDocument();
    expect(screen.queryByText(/含组队/)).not.toBeInTheDocument();
    expect(screen.queryByText("组队")).not.toBeInTheDocument();
    // 会话行不渲染任何可展开控件
    const buttons = screen.queryAllByRole("button");
    expect(buttons.filter((b) => b.getAttribute("aria-expanded") !== null)).toHaveLength(0);
  });

  test("旧后端兼容:行缺 delegate 字段也按无组队渲染", async () => {
    const legacy = chatRow();
    delete legacy.delegate_credits;
    delete legacy.delegate_requests;
    delete legacy.delegate_only;
    mockedGetUsage.mockResolvedValue(makeResponse([legacy]));
    render(<UsageTab auth={auth} />);

    expect(await screen.findByText("uuid-chat-1")).toBeInTheDocument();
    expect(screen.queryByText(/含组队/)).not.toBeInTheDocument();
    expect(screen.queryByText("组队")).not.toBeInTheDocument();
  });

  test("含组队父会话行:总额+徽标,点击展开 per-agent 明细并可收起", async () => {
    mockedGetUsage.mockResolvedValue(
      makeResponse([
        chatRow({
          session_id: "webmr-p1",
          requests: "5",
          billed_credits: "220",
          delegate_credits: "120",
          delegate_requests: "4",
          delegate_only: false,
          delegates: [
            {
              delegate_agent_id: "coder",
              model: "glm-5.2",
              requests: "2",
              billed_credits: "60",
            },
            {
              delegate_agent_id: "hidden-reviewer",
              model: "glm-5.2",
              requests: "1",
              billed_credits: "50",
            },
          ],
        }),
      ]),
    );
    render(<UsageTab auth={auth} />);

    expect(await screen.findByText("webmr-p1")).toBeInTheDocument();
    // 父行总额(含组队部分)照常显示
    expect(screen.getByText("220")).toBeInTheDocument();
    // 徽标 = 展开按钮
    const badge = screen.getByRole("button", { name: /含组队 120 积分/ });
    expect(badge).toHaveAttribute("aria-expanded", "false");
    // 未展开时明细不可见
    expect(screen.queryByText("质量审查员")).not.toBeInTheDocument();

    fireEvent.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "true");
    // hidden-reviewer 经共享静态映射显示中文名;coder 回退裸 id
    expect(screen.getByText("质量审查员")).toBeInTheDocument();
    expect(screen.getByText("coder")).toBeInTheDocument();
    expect(screen.getByText(/glm-5\.2 · 2 次/)).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();

    fireEvent.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("质量审查员")).not.toBeInTheDocument();
  });

  test("delegate_only 行:「组队」pill 标注 + 明细可展开", async () => {
    mockedGetUsage.mockResolvedValue(
      makeResponse([
        chatRow({
          session_id: "dlg-orphan-1",
          requests: "1",
          billed_credits: "25",
          delegate_credits: "25",
          delegate_requests: "1",
          delegate_only: true,
          delegates: [
            {
              delegate_agent_id: "coder",
              model: "glm-5.2",
              requests: "1",
              billed_credits: "25",
            },
          ],
        }),
      ]),
    );
    render(<UsageTab auth={auth} />);

    expect(await screen.findByText("dlg-orphan-1")).toBeInTheDocument();
    expect(screen.getByText("组队")).toBeInTheDocument();
    const badge = screen.getByRole("button", { name: /含组队 25 积分/ });
    fireEvent.click(badge);
    expect(screen.getByText("coder")).toBeInTheDocument();
  });
});
