import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import type { FeedbackRow } from "../types";

// chart.js 动态 import 在 jsdom 无 canvas context 会抛;桩成 no-op 类。
vi.mock("chart.js/auto", () => ({ default: class Chart {
  destroy() {}
} }));

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a), adminSend: (...a: unknown[]) => adminSend(...a) };
});

import FeedbackPage from "../index";

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

function fb(over: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "1",
    user_id: "42",
    username: "Alice",
    category: "bug",
    description: "页面加载很慢",
    request_id: "req-abc-123456",
    version: "v5",
    session_id: null,
    user_agent: null,
    meta: { foo: "bar" },
    status: "open",
    handled_by: null,
    handled_at: null,
    assigned_to: null,
    priority: null,
    resolution: null,
    created_at: new Date().toISOString(),
    traffic_class: "production_user",
    ...over,
  };
}

const TOTALS = {
  total: 2,
  by_status: { open: 1, acked: 1, closed: 0 },
  by_priority: { low: 0, normal: 0, high: 0, urgent: 0, unassigned: 2 },
};

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
});
afterEach(cleanup);

describe("FeedbackPage · 反馈队列", () => {
  test("渲染 KPI + 队列行", async () => {
    adminGet.mockResolvedValue({
      rows: [fb(), fb({ id: "2", status: "acked", description: "希望支持深色模式", traffic_class: "anonymous", user_id: null })],
      totals: { ...TOTALS, total: 99, by_status: { open: 91, acked: 8, closed: 0 } },
      next_before_created_at: null,
      next_before_id: null,
    });

    renderPage(<FeedbackPage />);

    expect(await screen.findByText("页面加载很慢")).toBeInTheDocument();
    expect(screen.getByText("希望支持深色模式")).toBeInTheDocument();
    // KPI 卡
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("反馈总数")).toBeInTheDocument();
    expect(screen.getByText("已关闭")).toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.getAllByText("匿名").length).toBeGreaterThanOrEqual(2);
    // 首拉命中 /feedback
    expect(adminGet).toHaveBeenCalledWith(
      "/feedback",
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("详情把负责人和确认操作人分离，并可关闭反馈", async () => {
    adminGet.mockResolvedValue({ rows: [fb()], totals: TOTALS, next_before_created_at: null, next_before_id: null });
    adminSend.mockImplementation((_method: string, path: string, body: Record<string, unknown>) => Promise.resolve({
      feedback: fb({
        assigned_to: path.endsWith("/assign") ? String(body.assigned_to) : "88",
        status: path.endsWith("/close") ? "closed" : "open",
        resolution: path.endsWith("/close") ? String(body.resolution) : null,
      }),
    }));
    renderPage(<FeedbackPage />);
    fireEvent.click(await screen.findByText("页面加载很慢"));
    fireEvent.change(await screen.findByLabelText("反馈负责人"), { target: { value: "88" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^保存$/ })[0]!);
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("POST", "/feedback/1/assign", { assigned_to: "88" }));
    fireEvent.change(screen.getByLabelText("反馈解决结论"), { target: { value: "已修复并验证" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈" }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("POST", "/feedback/1/close", { resolution: "已修复并验证" }));
  });

  test("点开行 → 详情抽屉 → 确认处理命中 ack 端点", async () => {
    adminGet
      .mockResolvedValueOnce({
        rows: [fb()],
        totals: TOTALS,
        next_before_created_at: null,
        next_before_id: null,
      })
      .mockResolvedValueOnce({
        trace: {
          trace_id: "req-abc-123456",
          user_id: "42",
          username: "Alice",
          session_key: "session-1",
          agent_id: "main",
          model: "glm-5.2",
          created_at: new Date().toISOString(),
        },
      });
    adminSend.mockResolvedValue({ feedback: fb({ status: "acked" }) });

    renderPage(<FeedbackPage />);

    fireEvent.click(await screen.findByText("页面加载很慢"));
    const lookup = await screen.findByRole("button", { name: "一键反查" });
    fireEvent.click(lookup);
    expect(await screen.findByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("glm-5.2")).toBeInTheDocument();
    expect(adminGet).toHaveBeenLastCalledWith("/trace/req-abc-123456");

    fireEvent.click(screen.getByRole("button", { name: /确认收到/ }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/feedback/1/ack", {}),
    );
  });

  test("加载更多 → 带复合游标翻下一页并追加", async () => {
    adminGet
      .mockResolvedValueOnce({
        rows: [fb()],
        totals: TOTALS,
        next_before_created_at: "2026-01-01T00:00:00.000Z",
        next_before_id: "1",
      })
      .mockResolvedValueOnce({
        rows: [fb({ id: "2", description: "第二页反馈" })],
        totals: TOTALS,
        next_before_created_at: null,
        next_before_id: null,
      });

    renderPage(<FeedbackPage />);
    await screen.findByText("页面加载很慢");

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("第二页反馈")).toBeInTheDocument();

    expect(adminGet).toHaveBeenLastCalledWith(
      "/feedback",
      expect.objectContaining({ before_id: "1", before_created_at: "2026-01-01T00:00:00.000Z" }),
    );
  });
});

describe("FeedbackPage · 响应评分", () => {
  test("切到评分 Tab → 拉 response-ratings 并展示好评率", async () => {
    adminGet.mockImplementation((path: string) => {
      if (path === "/feedback") {
        return Promise.resolve({ rows: [], totals: { ...TOTALS, total: 0, by_status: { open: 0, acked: 0, closed: 0 } }, next_before_created_at: null, next_before_id: null });
      }
      // /response-ratings
      return Promise.resolve({
        stats: {
          overall: {
            up: 8,
            down: 2,
            total: 10,
            up_rate: 0.8,
            ci95_low: 0.49,
            ci95_high: 0.943,
            sample_note: "small_sample",
          },
          last_7d: {
            up: 3,
            down: 1,
            total: 4,
            up_rate: 0.75,
            ci95_low: 0.301,
            ci95_high: 0.954,
            sample_note: "small_sample",
          },
          last_30d: {
            up: 8,
            down: 2,
            total: 10,
            up_rate: 0.8,
            ci95_low: 0.49,
            ci95_high: 0.943,
            sample_note: "small_sample",
          },
          by_model: [{
            model: "glm-5.2",
            up: 5,
            down: 1,
            total: 6,
            up_rate: 0.8333,
            ci95_low: 0.436,
            ci95_high: 0.97,
            sample_note: "small_sample",
          }],
          rating_users: 4,
          completed_turns: { last_7d: 40, last_30d: 100 },
          explicit_coverage: { last_7d: 0.1, last_30d: 0.1 },
          implicit_per_100_completed_turns: { last_7d: 2.5, last_30d: 3 },
          trace_completeness: { total: 10, with_trace: 8, missing_trace: 2 },
        },
        down_ratings: {
          source: "explicit",
          rows: [
            {
              id: "9",
              model: "glm-5.2",
              tags: ["hallucination"],
              comment: "答非所问",
              trace_id: "trace-xyz-1",
              session_id: null,
              created_at: new Date().toISOString(),
              username: "Bob",
              traffic_class: "production_user",
            },
          ],
          next_before_created_at: null,
          next_before_id: null,
        },
      });
    });

    renderPage(<FeedbackPage />);
    fireEvent.click(screen.getByRole("tab", { name: "响应评分" }));

    expect(await screen.findByText("总体好评率结论")).toBeInTheDocument();
    expect(screen.getByText("30 天显式样本")).toBeInTheDocument();
    expect(screen.getByText("Trace 完整率")).toBeInTheDocument();
    expect(screen.getByText("30 天显式覆盖率")).toBeInTheDocument();
    expect(screen.getByText("3/百 turn")).toBeInTheDocument();
    expect(await screen.findByText("答非所问")).toBeInTheDocument();
    expect(adminGet).toHaveBeenCalledWith(
      "/response-ratings",
      expect.objectContaining({ limit: 50, source: "explicit" }),
    );
  });

  test("最近差评默认显式来源，切换隐式后重置并按新来源拉取", async () => {
    adminGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === "/feedback") {
        return Promise.resolve({ rows: [], totals: { ...TOTALS, total: 0, by_status: { open: 0, acked: 0, closed: 0 } }, next_before_created_at: null, next_before_id: null });
      }
      const source = query?.source === "implicit" ? "implicit" : "explicit";
      return Promise.resolve({
        stats: {
          overall: {
            up: 1,
            down: 1,
            total: 2,
            up_rate: 0.5,
            ci95_low: 0.095,
            ci95_high: 0.905,
            sample_note: "small_sample",
          },
          last_7d: {
            up: 1,
            down: 1,
            total: 2,
            up_rate: 0.5,
            ci95_low: 0.095,
            ci95_high: 0.905,
            sample_note: "small_sample",
          },
          last_30d: {
            up: 1,
            down: 1,
            total: 2,
            up_rate: 0.5,
            ci95_low: 0.095,
            ci95_high: 0.905,
            sample_note: "small_sample",
          },
          by_model: [],
          rating_users: 1,
          completed_turns: { last_7d: 2, last_30d: 2 },
          explicit_coverage: { last_7d: 1, last_30d: 1 },
          implicit_per_100_completed_turns: { last_7d: 0, last_30d: 0 },
          trace_completeness: { total: 2, with_trace: 1, missing_trace: 1 },
        },
        down_ratings: {
          source,
          rows: [
            {
              id: source === "implicit" ? "2" : "1",
              model: null,
              tags: source === "implicit" ? ["implicit", "中途打断"] : ["不准确"],
              comment: source === "implicit" ? "隐式信号" : "显式反馈",
              trace_id: null,
              session_id: null,
              created_at: new Date().toISOString(),
              username: "Bob",
              traffic_class: "production_user",
            },
          ],
          next_before_created_at: null,
          next_before_id: null,
        },
      });
    });

    renderPage(<FeedbackPage />);
    fireEvent.click(screen.getByRole("tab", { name: "响应评分" }));
    expect(await screen.findByText("显式反馈")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("差评来源"), { target: { value: "implicit" } });
    expect(await screen.findByText("隐式信号")).toBeInTheDocument();
    expect(screen.queryByText("显式反馈")).not.toBeInTheDocument();
    expect(adminGet).toHaveBeenLastCalledWith(
      "/response-ratings",
      expect.objectContaining({ source: "implicit", before_id: undefined }),
    );
  });
});
