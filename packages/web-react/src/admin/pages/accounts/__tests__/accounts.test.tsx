import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

// chart.js 动态 import 在 jsdom 无 canvas 上下文 —— stub 掉,避免异步噪声。
vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

// 页面依赖 Toast/Tooltip Provider(main.tsx 提供),测试内等价包裹。
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

import AccountsPage from "../index";

const ROW = {
  id: "7",
  provider: "claude",
  group_id: null,
  label: "acct-tokyo",
  plan: "max",
  status: "cooldown",
  health_score: 50,
  cooldown_until: new Date(Date.now() + 3600_000).toISOString(),
  oauth_expires_at: null,
  subscription_end_at: null,
  last_used_at: new Date(Date.now() - 120_000).toISOString(),
  last_error: null,
  success_count: "100",
  fail_count: "3",
  quota_remaining: null,
  quota_5h_pct: 42,
  quota_5h_resets_at: null,
  quota_7d_pct: null,
  quota_7d_resets_at: null,
  quota_updated_at: new Date().toISOString(),
  egress_proxy: null,
  has_egress_proxy: true,
  egress_proxy_id: "1",
  egress_proxy_pool_label: "tokyo-1",
  egress_host_uuid: null,
  has_refresh_token: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  today_requests: 20,
  today_errors: 1,
};

const STATS = {
  total: 12, active: 8, cooldown: 1, disabled: 2, banned: 1,
  expired_refreshable: 0, expired_unrefreshable: 0, expiring_24h: 2,
  today_requests: 500, today_errors: 5,
};

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  sessionStorage.clear();
  adminGet.mockImplementation((path: string) => {
    if (path === "/accounts") return Promise.resolve({ rows: [ROW] });
    if (path === "/accounts/stats") return Promise.resolve(STATS);
    // 空快照 → donut 走占位,不渲染 canvas
    if (path === "/stats/account-pool")
      return Promise.resolve({ total: 0, active: 0, cooldown: 0, disabled: 0, banned: 0, avg_health: 0, today_success_rate: 1 });
    return Promise.resolve({ rows: [] });
  });
});
afterEach(cleanup);

describe("AccountsPage", () => {
  test("渲染 KPI + 账号行,列表带 status 参数拉取", async () => {
    renderPage(<AccountsPage />);
    expect(await screen.findByText("acct-tokyo")).toBeTruthy();
    // KPI:可用 / 冷却
    expect(screen.getByText("8 / 1")).toBeTruthy();
    // 总账号
    expect(screen.getByText("12")).toBeTruthy();
    // 列表请求带上默认(空)status 与 with_stats
    const listCall = adminGet.mock.calls.find((c) => c[0] === "/accounts");
    expect(listCall?.[1]).toMatchObject({ with_stats: 1, limit: 500 });
  });

  test("删除账号:确认后调用 DELETE 端点", async () => {
    adminSend.mockResolvedValue({ deleted: true });
    renderPage(<AccountsPage />);
    await screen.findByText("acct-tokyo");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 确认框出现
    const dialog = await screen.findByText("删除账号 #7");
    expect(dialog).toBeTruthy();
    // 点确认(confirmText=删除)
    const confirmBtn = screen.getAllByRole("button", { name: "删除" }).find((b) =>
      b.className.includes("bg-danger"),
    );
    fireEvent.click(confirmBtn!);
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("DELETE", "/accounts/7"),
    );
  });

  test("点击编辑打开编辑模态(拉表单依赖)", async () => {
    renderPage(<AccountsPage />);
    await screen.findByText("acct-tokyo");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑账号 #7")).toBeTruthy();
    // 模态开窗即拉 egress-proxies + account-groups 依赖
    await waitFor(() => {
      expect(adminGet.mock.calls.some((c) => c[0] === "/egress-proxies")).toBe(true);
      expect(adminGet.mock.calls.some((c) => c[0] === "/account-groups")).toBe(true);
    });
  });
});
