import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui";

// 页面在真实 admin 根(src/admin/main.tsx)下被 TooltipProvider 包裹;TimeAgo 用 Tooltip,
// 测试须复刻该 provider,否则 radix Tooltip Root 在无 Provider 上下文时抛错。
const renderPage = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminSend: (...a: unknown[]) => adminSend(...a),
  };
});

import LiteraturePage from "../index";

const CONFIG_SET = {
  enabled: true,
  base_url: "https://data.rag.ac.cn",
  token_set: true,
  token_hint: "****ab12",
  daily_cap: 10000,
  default_size: 10,
  timeout_sec: 20,
  updated_at: new Date(Date.now() - 60_000).toISOString(),
  updated_by: "root@admin",
};

const CONFIG_UNSET = { ...CONFIG_SET, token_set: false, token_hint: null, updated_by: null };
const OPERATIONS = {
  daily: { utc_day: "2026-08-10", used: 42, cap: 10000, source: "redis" },
  metrics: {
    scope: "since_process_start",
    since: "2026-08-10T02:00:00Z",
    counts: { allowed: 38, rejected_daily_cap: 1, upstream_5xx: 2, timeout: 1 },
    last_success_at: "2026-08-10T03:00:00Z",
    latency_ms: { p50: 320, p95: 880 },
  },
};

function mockConfig(cfg: Record<string, unknown>) {
  adminGet.mockImplementation((path: string) => {
    if (path === "/literature") return Promise.resolve({ config: cfg, operations: OPERATIONS });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  mockConfig(CONFIG_SET);
});
afterEach(cleanup);

describe("LiteraturePage", () => {
  test("渲染 base_url 值 + 已配置掩码", async () => {
    renderPage(<LiteraturePage />);
    expect(await screen.findByDisplayValue("https://data.rag.ac.cn")).toBeTruthy();
    expect(screen.getByText("****ab12")).toBeTruthy();
    expect(screen.getByText("已配置")).toBeTruthy();
    // 数值字段按配置播种
    expect(screen.getByDisplayValue("10000")).toBeTruthy();
  });

  test("token 未设置时显示「未设置」徽标", async () => {
    mockConfig(CONFIG_UNSET);
    renderPage(<LiteraturePage />);
    await screen.findByDisplayValue("https://data.rag.ac.cn");
    expect(screen.getByText("未设置")).toBeTruthy();
  });

  test("展示 UTC 日用量与自进程启动运行指标，不伪装 24h", async () => {
    renderPage(<LiteraturePage />);
    expect(await screen.findByText("42 / 10,000 · redis")).toBeTruthy();
    expect(screen.getByText(/请求指标窗口：自本进程启动/)).toBeTruthy();
    expect(screen.getByText("38")).toBeTruthy();
    expect(screen.getByText(/延迟 p50：320 ms/)).toBeTruthy();
    expect(screen.queryByText(/24h/)).toBeNull();
  });

  test("测试连接：打 POST /literature/test 并渲染 ok 摘要", async () => {
    adminSend.mockResolvedValue({
      result: { ok: true, status: 200, result_count: 1, elapsed_ms: 42 },
    });
    renderPage(<LiteraturePage />);
    await screen.findByDisplayValue("https://data.rag.ac.cn");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/literature/test", {}),
    );
    expect(await screen.findByText("连接正常")).toBeTruthy();
    expect(screen.getByText("42ms")).toBeTruthy();
  });

  test("保存：数值字段为空时拦截，不发 PATCH 请求", async () => {
    renderPage(<LiteraturePage />);
    const capInput = await screen.findByDisplayValue("10000");
    fireEvent.change(capInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 给潜在异步一个机会，随后断言从未打 PATCH
    await waitFor(() => expect(adminSend).not.toHaveBeenCalled());
    expect(adminSend.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
  });

  test("保存：选「写入新值」时带正确的 token set patch", async () => {
    adminSend.mockResolvedValue({ config: CONFIG_SET });
    renderPage(<LiteraturePage />);
    await screen.findByDisplayValue("https://data.rag.ac.cn");

    const setRadio = screen
      .getAllByRole("radio")
      .find((r) => (r as HTMLInputElement).value === "set") as HTMLInputElement;
    fireEvent.click(setRadio);

    const tokenInput = screen.getByLabelText("新 token");
    fireEvent.change(tokenInput, { target: { value: "secrettoken123" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith(
        "PATCH",
        "/literature",
        expect.objectContaining({
          token: { action: "set", value: "secrettoken123" },
          base_url: "https://data.rag.ac.cn",
          daily_cap: 10000,
          default_size: 10,
          timeout_sec: 20,
          enabled: true,
        }),
      ),
    );
  });
});
