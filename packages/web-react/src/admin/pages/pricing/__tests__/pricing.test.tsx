import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../lib/adminApi", () => ({
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));
vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

import { adminGet, adminSend } from "../../../lib/adminApi";
import PricingPage from "../index";

const zero = {
  requests: 0,
  input_tokens: "0",
  output_tokens: "0",
  cache_read_tokens: "0",
  credits: "0",
};
const model = {
  model_id: "gpt-5.6",
  display_name: "GPT X",
  input_per_mtok: "100",
  output_per_mtok: "200",
  cache_read_per_mtok: "10",
  cache_write_per_mtok: "20",
  multiplier: "2.000",
  enabled: true,
  sort_order: 0,
  updated_at: "2026-07-01T00:00:00Z",
  updated_by: null,
  visibility: "public",
  extra_system_prompt: null,
  default_effort: null,
  lock_version: 5,
  provider: { id: "codex" },
  effort: { applicable: false, allowed: [] },
  inflight: null,
  usage: { d1: zero, d7: zero },
};
const provider = {
  id: "deepseek",
  display_name: "DeepSeek",
  endpoint: "https://api.deepseek.com",
  egress: "proxy",
  keyConfigured: true,
  probeEnabled: true,
  subscription_expires_at: null,
  notes: null,
  concurrency_limit: null,
  ops_updated_at: null,
  health: { effective: "healthy", mode: "auto", observed: "healthy", since: null, reason: null },
  latest: null,
  samples: [],
  inflight_current: 0,
  usage_d1: { requests: 0, tokens: "0", credits: "0" },
};

function mockGet() {
  vi.mocked(adminGet).mockImplementation(async (path: string) => {
    if (path === "/model-ops") {
      return { models: [model], providers: [provider], stats: { source: "local", started_at: null } };
    }
    if (path === "/model-ops/stats") return { by_model: {}, source: "local", started_at: null };
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

describe("PricingPage", () => {
  test("渲染服务商卡片 + 模型行", async () => {
    render(<PricingPage />);
    expect(await screen.findByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("gpt-5.6")).toBeTruthy();
  });

  test("健康三态切换带确认 → PUT provider 只发 health_mode", async () => {
    render(<PricingPage />);
    await screen.findByText("DeepSeek");
    fireEvent.click(screen.getByRole("button", { name: "强制降级" }));
    // 确认弹窗
    expect(await screen.findByText(/降级策略改为/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith("PUT", "/providers/deepseek", {
        health_mode: "forced_degraded",
      });
    });
  });

  test("改价格 → 确认门 → PATCH 带 if_match_lock_version", async () => {
    render(<PricingPage />);
    await screen.findByText("gpt-5.6");
    const rowEl = screen.getByText("gpt-5.6").closest("tr") as HTMLElement;
    const priceInput = within(rowEl).getByDisplayValue("100");
    fireEvent.change(priceInput, { target: { value: "150" } });
    fireEvent.click(within(rowEl).getByRole("button", { name: "保存" }));
    // 价格确认门
    expect(await screen.findByText(/确认价格改动/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith(
        "PATCH",
        "/pricing/gpt-5.6",
        expect.objectContaining({ input_per_mtok: 150, if_match_lock_version: 5 }),
      );
    });
  });
});
