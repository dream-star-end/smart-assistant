import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

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

import AccountGroupsPage from "../index";

const GROUPS = [
  { id: "1", label: "Yunwu 中转站", kind: "api_relay", provider: "claude", enabled: true, priority: 100, models: ["gpt-5.5"], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: "2", label: "官方订阅组", kind: "official_oauth", provider: "claude", enabled: false, priority: 50, models: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  adminGet.mockImplementation((path: string) => {
    if (path === "/account-groups") return Promise.resolve({ rows: GROUPS });
    if (path.endsWith("/relay-credentials")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
});
afterEach(cleanup);

describe("AccountGroupsPage", () => {
  test("渲染分组卡片 + KPI", async () => {
    renderPage(<AccountGroupsPage />);
    expect(await screen.findByText("Yunwu 中转站")).toBeTruthy();
    expect(screen.getByText("官方订阅组")).toBeTruthy();
    // KPI 分组总数=2
    expect(screen.getByText("分组总数")).toBeTruthy();
    // 模型路由边界芯片
    expect(screen.getByText("gpt-5.5")).toBeTruthy();
  });

  test("切换启用:调用 PATCH enabled 取反", async () => {
    adminSend.mockResolvedValue({ group: {} });
    renderPage(<AccountGroupsPage />);
    await screen.findByText("Yunwu 中转站");
    // 第一组的启用开关(当前 enabled=true → 期望 patch false)
    const switches = screen.getAllByLabelText("启用分组");
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("PATCH", "/account-groups/1", { enabled: false }),
    );
  });

  test("api_relay 组打开凭据子区,拉取 relay-credentials", async () => {
    renderPage(<AccountGroupsPage />);
    await screen.findByText("Yunwu 中转站");
    // 第一组(api_relay)有「中转站凭据」内联按钮;官方订阅组无
    const credBtns = screen.getAllByRole("button", { name: "中转站凭据" });
    expect(credBtns.length).toBe(1);
    fireEvent.click(credBtns[0]);
    await waitFor(() =>
      expect(adminGet).toHaveBeenCalledWith("/account-groups/1/relay-credentials"),
    );
  });

  test("删除分组:确认后调用 DELETE", async () => {
    adminSend.mockResolvedValue({ deleted: true });
    renderPage(<AccountGroupsPage />);
    await screen.findByText("Yunwu 中转站");
    // 每组底部有一个 ghost「删除」按钮
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    await screen.findByText("删除账号分组 #1");
    const confirmBtn = screen.getAllByRole("button", { name: "删除" }).find((b) => b.className.includes("bg-danger"));
    fireEvent.click(confirmBtn!);
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("DELETE", "/account-groups/1"));
  });
});
