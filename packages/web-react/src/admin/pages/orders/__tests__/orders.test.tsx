import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui";

vi.mock("../../../lib/adminApi", () => ({
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  adminText: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));
vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

import { adminGet, adminSend } from "../../../lib/adminApi";
import OrdersPage from "../index";

const order = {
  id: "5",
  order_no: "ORD-20260701-1",
  user_id: "1001",
  username: "alice",
  provider: "hupijiao",
  provider_order: "HJ-abc",
  amount_cents: "3800",
  credits: "4000",
  status: "paid",
  kind: "topup",
  org_id: null,
  paid_at: "2026-07-01T10:05:00Z",
  expires_at: "2026-07-01T11:00:00Z",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:05:00Z",
};
const kpi = {
  pending_overdue: 2,
  pending_overdue_24h: 1,
  callback_conflicts_24h: 0,
  paid_24h_count: 7,
  paid_24h_amount_cents: "26600",
};

function mockGet() {
  vi.mocked(adminGet).mockImplementation(async (path: string) => {
    if (path === "/orders") return { rows: [order], next_before_created_at: null, next_before_id: null };
    if (path === "/orders/kpi") return { kpi };
    if (path.startsWith("/orders/")) return {
      order: {
        ...order,
        callback_payload: { trade_status: "OK" },
        ledger_id: "77",
        refunded_ledger_id: null,
        refund_state: null,
        refund_reason: null,
        refund_requested_at: null,
        refund_hold_ledger_id: null,
        provider_refund_no: null,
        refund_payload: null,
        refunded_at: null,
      },
    };
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  window.location.hash = "";
  mockGet();
  vi.mocked(adminSend).mockResolvedValue({
    refund: { state: "channel_pending", provider_status: "RD" },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrdersPage", () => {
  test("首载渲染订单行 + KPI", async () => {
    render(
      <TooltipProvider>
        <OrdersPage />
      </TooltipProvider>,
    );
    expect(await screen.findByText("ORD-20260701-1")).toBeTruthy();
    expect(screen.getByText("24h 卡单")).toBeTruthy();
    expect(screen.getByText("已支付")).toBeTruthy();
  });

  test("user_id 过滤 → 查询按正确参数重拉", async () => {
    render(
      <TooltipProvider>
        <OrdersPage />
      </TooltipProvider>,
    );
    await screen.findByText("ORD-20260701-1");
    fireEvent.change(screen.getByPlaceholderText("user_id 过滤"), { target: { value: "1001" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => {
      expect(vi.mocked(adminGet)).toHaveBeenCalledWith(
        "/orders",
        expect.objectContaining({ user_id: "1001" }),
      );
    });
  });

  test("查看 → 打开详情 Modal 并拉取单订单(含 callback_payload)", async () => {
    render(
      <TooltipProvider>
        <OrdersPage />
      </TooltipProvider>,
    );
    await screen.findByText("ORD-20260701-1");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await waitFor(() => {
      expect(vi.mocked(adminGet)).toHaveBeenCalledWith(
        "/orders/ORD-20260701-1",
      );
    });
    expect(await screen.findByText(/callback_payload/)).toBeTruthy();
  });

  test("paid topup 原路退款经过原因输入与危险确认，只发送一次", async () => {
    render(
      <TooltipProvider>
        <OrdersPage />
      </TooltipProvider>,
    );
    await screen.findByText("ORD-20260701-1");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    const refundButton = await screen.findByRole("button", { name: "原路退款" });
    fireEvent.click(refundButton);
    fireEvent.click(await screen.findByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认并冻结积分" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith(
        "POST",
        "/orders/ORD-20260701-1/refund",
        { reason: "用户申请原路退款" },
      );
    });
  });
});
