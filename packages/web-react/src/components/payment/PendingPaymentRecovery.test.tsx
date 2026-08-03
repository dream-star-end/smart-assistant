import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { PendingPaymentRecovery } from "./PendingPaymentRecovery";

const apiMocks = vi.hoisted(() => ({ getOrder: vi.fn() }));

vi.mock("../../lib/api", () => ({ api: apiMocks }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

test("手机支付返回后立即查单、清理 pending 并刷新余额", async () => {
  sessionStorage.setItem(
    "openclaude_pending_order",
    JSON.stringify({ order_no: "order-1", label: "订阅专业版" }),
  );
  apiMocks.getOrder.mockResolvedValue({ status: "paid" });
  const onPaid = vi.fn();
  const billingPaid = vi.fn();
  window.addEventListener("openclaude:billing-paid", billingPaid);

  render(
    <PendingPaymentRecovery
      auth={createMemoryAuthSession(() => {}, "t")}
      onPaid={onPaid}
    />,
  );

  expect(screen.getByTestId("payment-recovery-pending")).toHaveTextContent("正在确认订阅专业版结果");
  expect(await screen.findByTestId("payment-recovery-paid")).toHaveTextContent("订阅专业版成功");
  await waitFor(() => expect(onPaid).toHaveBeenCalledOnce());
  expect(apiMocks.getOrder).toHaveBeenCalledWith(expect.anything(), "order-1");
  expect(billingPaid).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem("openclaude_pending_order")).toBeNull();

  window.removeEventListener("openclaude:billing-paid", billingPaid);
});

test("旧前端遗留的最小订单结构也能恢复，pending 状态不被提前清掉", async () => {
  sessionStorage.setItem(
    "openclaude_pending_order",
    JSON.stringify({ order_no: "legacy-order-1", expires_at: "2099-01-01T00:00:00.000Z" }),
  );
  apiMocks.getOrder.mockResolvedValue({ status: "pending" });

  render(
    <PendingPaymentRecovery
      auth={createMemoryAuthSession(() => {}, "t")}
      onPaid={() => {}}
    />,
  );

  expect(screen.getByTestId("payment-recovery-pending")).toHaveTextContent("正在确认微信支付结果");
  await waitFor(() => expect(apiMocks.getOrder).toHaveBeenCalledOnce());
  expect(sessionStorage.getItem("openclaude_pending_order")).not.toBeNull();
});
