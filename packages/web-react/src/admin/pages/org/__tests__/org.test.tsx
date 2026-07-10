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
import OrgPage from "../index";

const org = {
  id: "3",
  name: "Acme",
  status: "active",
  credits: "10000",
  max_members: 5,
  member_count: 2,
  created_at: "2026-07-01T00:00:00Z",
};
const invoice = {
  id: "11",
  org_id: "3",
  org_name: "Acme",
  order_ids: ["o1", "o2"],
  amount_cents: "5000",
  status: "pending",
  admin_note: null,
  created_at: "2026-07-01T00:00:00Z",
};

function mockGet() {
  vi.mocked(adminGet).mockImplementation(async (path: string) => {
    if (path === "/orgs") return { rows: [org] };
    if (path === "/org-invoices") return { rows: [invoice] };
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  mockGet();
  vi.mocked(adminSend).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrgPage", () => {
  test("渲染组织卡片 + 开票申请", async () => {
    render(<OrgPage />);
    // org 卡片 + 发票行都含 Acme
    expect((await screen.findAllByText(/Acme/)).length).toBeGreaterThan(0);
    expect(screen.getByText("¥100.00")).toBeTruthy(); // 组织余额 10000 分
    expect(screen.getByText("¥50.00")).toBeTruthy(); // 开票金额 5000 分
  });

  test("开票走确认 → PATCH { status:issued }", async () => {
    render(<OrgPage />);
    await screen.findByText("待处理");
    fireEvent.click(screen.getByRole("button", { name: "开票" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认开票" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith("PATCH", "/org-invoices/11", {
        status: "issued",
      });
    });
  });

  test("新建组织 → POST /orgs", async () => {
    render(<OrgPage />);
    await screen.findByText("待处理");
    fireEvent.click(screen.getByRole("button", { name: /新建组织/ }));
    fireEvent.change(await screen.findByPlaceholderText("owner@example.com"), {
      target: { value: "owner@x.com" },
    });
    // 组织名称输入(Modal 内第一个文本框)
    const nameInputs = screen.getAllByRole("textbox");
    fireEvent.change(nameInputs[0], { target: { value: "NewCo" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith(
        "POST",
        "/orgs",
        expect.objectContaining({ name: "NewCo", owner_email: "owner@x.com" }),
      );
    });
  });
});
