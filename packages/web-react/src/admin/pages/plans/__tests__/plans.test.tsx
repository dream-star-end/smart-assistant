import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../lib/adminApi", () => ({
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));

import { adminGet, adminSend } from "../../../lib/adminApi";
import PlansPage from "../index";

const plan = {
  id: "1",
  code: "lite",
  label: "Lite 档",
  amount_cents: "3800",
  credits: "4000",
  sort_order: 1,
  enabled: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(adminGet).mockResolvedValue({ rows: [plan] });
  vi.mocked(adminSend).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlansPage", () => {
  test("渲染套餐卡片(金额格式化)", async () => {
    render(<PlansPage />);
    expect(await screen.findByText("Lite 档")).toBeTruthy();
    expect(screen.getByText("¥38.00")).toBeTruthy();
    expect(screen.getByText("¥40.00")).toBeTruthy();
  });

  test("下架走确认 → PATCH { enabled:false }", async () => {
    render(<PlansPage />);
    await screen.findByText("Lite 档");
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText(/下架套餐 lite/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认下架" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith("PATCH", "/plans/lite", { enabled: false });
    });
  });

  test("编辑套餐 → PATCH 全字段", async () => {
    render(<PlansPage />);
    await screen.findByText("Lite 档");
    fireEvent.click(screen.getByRole("button", { name: /编辑/ }));
    // 修改 label
    const labelInput = await screen.findByDisplayValue("Lite 档");
    fireEvent.change(labelInput, { target: { value: "Lite 尊享" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith(
        "PATCH",
        "/plans/lite",
        expect.objectContaining({ label: "Lite 尊享", amount_cents: "3800" }),
      );
    });
  });
});
