import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

// chart.js 动态 import 在 jsdom 无 canvas 上下文 —— stub 掉，避免异步噪声。
vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

const adminGet = vi.fn();
const adminText = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminText: (...a: unknown[]) => adminText(...a),
  };
});

import HealthPage from "../index";

const METRICS = [
  "# HELP gateway_http_requests_total total",
  'gateway_http_requests_total{status="200"} 100',
  'gateway_http_requests_total{status="500"} 5',
  'billing_debit_total{result="success"} 90',
  'billing_debit_total{result="insufficient"} 2',
  'claude_api_requests_total{status="success"} 80',
  "agent_containers_running 7",
  'anthropic_proxy_reject_total{reason="quota_exceeded"} 3',
  'account_pool_health{account_id="57",status="active"} 95',
  'anthropic_proxy_ttft_seconds_sum{model="opus"} 4',
  'anthropic_proxy_ttft_seconds_count{model="opus"} 2',
].join("\n");

// 真实嵌套形状（alerts.rules.firing / account_pool.active）—— 验证读的是嵌套字段。
const DIAGNOSTICS = {
  server: { version: { tag: "v5-test-abc", builtAt: "2026-07-10", commit: "deadbeef" }, node: "v20", uptime_sec: 3600, now: "2026-07-10T00:00:00Z" },
  db: { pool_total: 20, pool_idle: 15, pool_waiting: 0, pg_version: "PostgreSQL 16.2 on x86_64" },
  alerts: {
    rules: { firing: 2, normal: 8, recent_firing: [] },
    outbox: { pending: 1, failed: 0, sent_24h: 30, oldest_pending_age_sec: 12 },
    events_24h_by_severity: { critical: 0, warning: 1, info: 4 },
  },
  account_pool: { total: 10, active: 8, cooldown: 1, disabled: 1, banned: 0, avg_health: 88, today_requests: 500, today_success_rate: 0.99 },
};

beforeEach(() => {
  adminGet.mockReset();
  adminText.mockReset();
  adminText.mockResolvedValue(METRICS);
  adminGet.mockImplementation((path: string) => {
    if (path === "/diagnostics") return Promise.resolve(DIAGNOSTICS);
    return Promise.resolve(null);
  });
});
afterEach(cleanup);

describe("HealthPage", () => {
  test("渲染 KPI 总请求 + 页头", async () => {
    renderPage(<HealthPage />);
    // KPI 总请求 = 100 + 5 = 105
    expect(await screen.findByText("105")).toBeTruthy();
    expect(screen.getByText("健康面板")).toBeTruthy();
    // metrics 走 adminText('/metrics')，diagnostics 走 adminGet('/diagnostics')
    expect(adminText).toHaveBeenCalledWith("/metrics");
    expect(adminGet).toHaveBeenCalledWith("/diagnostics");
  });

  test("诊断卡读真实嵌套形状：版本 tag / firing / active", async () => {
    renderPage(<HealthPage />);
    // 版本 tag
    expect(await screen.findByText("v5-test-abc")).toBeTruthy();
    // 告警 firing 读的是 alerts.rules.firing=2（而非 vanilla 误读的 alerts.open→undefined）
    expect(screen.getByText("2 触发中")).toBeTruthy();
    // 账号池 active 读的是 account_pool.active=8 / total=10
    expect(screen.getByText("8 / 10 可用")).toBeTruthy();
  });

  test("账号池健康表渲染 account_id", async () => {
    renderPage(<HealthPage />);
    expect(await screen.findByText("57")).toBeTruthy();
  });

  test("diagnostics 失败不致命：仍渲染 KPI + 失败提示", async () => {
    adminGet.mockImplementation(() => Promise.reject(new Error("boom")));
    renderPage(<HealthPage />);
    // metrics 仍展示（KPI 总请求）
    expect(await screen.findByText("105")).toBeTruthy();
    // 诊断区落失败提示
    expect(screen.getByText(/diagnostics 加载失败/)).toBeTruthy();
  });
});
