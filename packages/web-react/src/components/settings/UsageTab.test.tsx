/**
 * UsageTab 组队(delegate)归组展示测试。
 *
 * api 网络层全 mock,只验组件与契约的交互:
 *   1. 无 delegate 数据 → UI 与现状完全一致(无「组队」pill / 无「含组队」徽标 /
 *      无展开按钮)
 *   2. 含 delegate 的父会话行 → 总额 +「含组队 X 积分」徽标;点击展开 per-agent
 *      明细(hidden-reviewer 经 agentNames 静态映射显示「质量审查员」,用户级
 *      agent id 回退裸 id),再点收起
 *   3. delegate_only 孤儿/纯组队行 →「组队」pill 标注
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthSession, UsageResponse, UsageSessionRow } from "../../lib/types";
import { UsageTab } from "./UsageTab";

vi.mock("../../lib/api", () => ({
  api: {
    getUsage: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const mockedGetUsage = vi.mocked(api.getUsage);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

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
      debited_credits: "220",
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

function chatRow(overrides: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return {
    session_id: "uuid-chat-1",
    requests: "2",
    input_tokens: "800",
    output_tokens: "400",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    billed_credits: "100",
    last_used_at: "2026-07-04T12:00:00.000Z",
    delegate_credits: "0",
    delegate_requests: "0",
    delegate_only: false,
    ...overrides,
  };
}

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
