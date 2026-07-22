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
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
});
afterEach(cleanup);

describe("FeedbackPage · 反馈队列", () => {
  test("渲染 KPI + 队列行", async () => {
    adminGet.mockResolvedValue({
      rows: [fb(), fb({ id: "2", status: "acked", description: "希望支持深色模式" })],
      next_before_created_at: null,
      next_before_id: null,
    });

    renderPage(<FeedbackPage />);

    expect(await screen.findByText("页面加载很慢")).toBeInTheDocument();
    expect(screen.getByText("希望支持深色模式")).toBeInTheDocument();
    // KPI 卡
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("24h 新增")).toBeInTheDocument();
    // 首拉命中 /feedback
    expect(adminGet).toHaveBeenCalledWith(
      "/feedback",
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("点开行 → 详情抽屉 → 确认处理命中 ack 端点", async () => {
    adminGet
      .mockResolvedValueOnce({
        rows: [fb()],
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

    fireEvent.click(screen.getByRole("button", { name: /确认处理/ }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/feedback/1/ack", {}),
    );
  });

  test("加载更多 → 带复合游标翻下一页并追加", async () => {
    adminGet
      .mockResolvedValueOnce({
        rows: [fb()],
        next_before_created_at: "2026-01-01T00:00:00.000Z",
        next_before_id: "1",
      })
      .mockResolvedValueOnce({
        rows: [fb({ id: "2", description: "第二页反馈" })],
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
        return Promise.resolve({ rows: [], next_before_created_at: null, next_before_id: null });
      }
      // /response-ratings
      return Promise.resolve({
        stats: {
          overall: { up: 8, down: 2, total: 10, up_rate: 0.8 },
          last_7d: { up: 3, down: 1, total: 4, up_rate: 0.75 },
          last_30d: { up: 8, down: 2, total: 10, up_rate: 0.8 },
          by_model: [{ model: "glm-5.2", up: 5, down: 1, total: 6, up_rate: 0.8333 }],
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
            },
          ],
          next_before_created_at: null,
          next_before_id: null,
        },
      });
    });

    renderPage(<FeedbackPage />);
    fireEvent.click(screen.getByRole("tab", { name: "响应评分" }));

    expect(await screen.findByText("总好评率")).toBeInTheDocument();
    expect(await screen.findByText("答非所问")).toBeInTheDocument();
    expect(adminGet).toHaveBeenCalledWith(
      "/response-ratings",
      expect.objectContaining({ limit: 50, source: "explicit" }),
    );
  });

  test("最近差评默认显式来源，切换隐式后重置并按新来源拉取", async () => {
    adminGet.mockImplementation((path: string, query?: Record<string, unknown>) => {
      if (path === "/feedback") {
        return Promise.resolve({ rows: [], next_before_created_at: null, next_before_id: null });
      }
      const source = query?.source === "implicit" ? "implicit" : "explicit";
      return Promise.resolve({
        stats: {
          overall: { up: 1, down: 1, total: 2, up_rate: 0.5 },
          last_7d: { up: 1, down: 1, total: 2, up_rate: 0.5 },
          last_30d: { up: 1, down: 1, total: 2, up_rate: 0.5 },
          by_model: [],
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
