import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a), adminSend: (...a: unknown[]) => adminSend(...a) };
});

import EgressProxiesPage from "../index";

const ROWS = [
  { id: "1", label: "tokyo-1", status: "active", notes: "residential", url_masked: "http://***@1.2.3.4:8080", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: "2", label: "osaka-2", status: "disabled", notes: null, url_masked: "socks5://***@5.6.7.8:1080", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  sessionStorage.clear();
  adminGet.mockResolvedValue({ rows: ROWS });
});
afterEach(cleanup);

describe("EgressProxiesPage", () => {
  test("渲染 KPI + 行(全量拉取)", async () => {
    renderPage(<EgressProxiesPage />);
    expect(await screen.findByText("tokyo-1")).toBeTruthy();
    expect(screen.getByText("osaka-2")).toBeTruthy();
    // 全量拉取(limit 500,无 status 参数)
    expect(adminGet).toHaveBeenCalledWith("/egress-proxies", { limit: 500 });
    // KPI total=2
    expect(screen.getByText("2")).toBeTruthy();
  });

  test("新建代理:打开创建模态", async () => {
    renderPage(<EgressProxiesPage />);
    await screen.findByText("tokyo-1");
    fireEvent.click(screen.getByRole("button", { name: /新建代理/ }));
    // 模态打开:create 模式独有的明文 URL 输入框出现
    expect(await screen.findByPlaceholderText(/user:pass@host/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
  });

  test("删除代理:确认后调用 DELETE", async () => {
    adminSend.mockResolvedValue({ deleted: true });
    renderPage(<EgressProxiesPage />);
    await screen.findByText("tokyo-1");
    // 第一行的删除按钮
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    await screen.findByText("删除代理 tokyo-1");
    const confirmBtn = screen.getAllByRole("button", { name: "删除" }).find((b) => b.className.includes("bg-danger"));
    fireEvent.click(confirmBtn!);
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("DELETE", "/egress-proxies/1"));
  });
});
