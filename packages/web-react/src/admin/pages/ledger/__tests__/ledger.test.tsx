import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../lib/adminApi", () => ({
  adminGet: vi.fn(),
  adminText: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));
vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

import { adminGet, adminText } from "../../../lib/adminApi";
import LedgerPage from "../index";

const row = {
  id: "9001",
  user_id: "1001",
  delta: "1500",
  balance_after: "3000",
  reason: "topup",
  channel: "web",
  model: null,
  memo: "测试备注",
  created_at: "2026-07-01T10:00:00Z",
};

beforeEach(() => {
  window.location.hash = "";
  vi.mocked(adminGet).mockResolvedValue({ rows: [row], next_before: null });
  vi.mocked(adminText).mockResolvedValue("id,delta\n9001,1500\n");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LedgerPage", () => {
  test("首载渲染 KPI + 流水行", async () => {
    render(<LedgerPage />);
    expect(await screen.findByText("测试备注")).toBeTruthy();
    // reason 标签
    expect(screen.getByText("充值")).toBeTruthy();
    // KPI 标签
    expect(screen.getByText("总入账")).toBeTruthy();
    expect(vi.mocked(adminGet)).toHaveBeenCalledWith(
      "/ledger",
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("user_id 过滤 → 查询按正确参数重拉", async () => {
    render(<LedgerPage />);
    await screen.findByText("测试备注");
    fireEvent.change(screen.getByPlaceholderText("user_id 过滤"), { target: { value: "1001" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => {
      expect(vi.mocked(adminGet)).toHaveBeenCalledWith(
        "/ledger",
        expect.objectContaining({ user_id: "1001" }),
      );
    });
  });

  test("导出 CSV 调用 /ledger.csv 端点", async () => {
    // jsdom 无 createObjectURL / anchor.click —— 桩掉,只验证端点被调用。
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<LedgerPage />);
    await screen.findByText("测试备注");
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(vi.mocked(adminText)).toHaveBeenCalledWith("/ledger.csv", expect.any(Object));
    });

    clickSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
});
