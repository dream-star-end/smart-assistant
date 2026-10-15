import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import { parseAdminHash } from "../../../router";
import { adminPages, getAdminPage } from "../../../registry";
import type { PoolMember, PoolsResponse } from "../../pools/types";
import type { AccountRow } from "../types";

vi.mock("chart.js/auto", () => ({ default: class { destroy() {} } }));

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a), adminSend: (...a: unknown[]) => adminSend(...a) };
});

import ServicePoolsPage from "../index";

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

const now = Date.now();
const base = {
  group_id: null, plan: "max", status: "active", health_score: 100, cooldown_until: null, oauth_expires_at: null,
  subscription_end_at: null, last_used_at: null, last_error: null, success_count: "1", fail_count: "0",
  quota_remaining: null, quota_5h_pct: null, quota_5h_resets_at: null, quota_7d_pct: null, quota_7d_resets_at: null,
  quota_updated_at: null, egress_proxy: null, has_egress_proxy: true, egress_proxy_id: "1", egress_proxy_pool_label: "e",
  egress_host_uuid: null, has_refresh_token: true, cursor_quota_class: null, cursor_credential_kind: null,
  created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), today_requests: 0, today_errors: 0,
};
const ROWS = [
  { ...base, id: "22", provider: "claude", label: "claude-main", quota_5h_pct: 23, quota_5h_resets_at: new Date(now + 3 * 3_600_000).toISOString(), quota_7d_pct: 41, quota_7d_resets_at: new Date(now + 4 * 86_400_000).toISOString(), quota_updated_at: new Date(now).toISOString() },
  { ...base, id: "26", provider: "codex", label: "codex-main", quota_7d_pct: 21, quota_7d_resets_at: new Date(now + 5 * 86_400_000).toISOString(), quota_updated_at: new Date(now).toISOString() },
  { ...base, id: "27", provider: "codex", label: "codex-idle" },
  { ...base, id: "24", provider: "grok", label: "grok-main", grok_credit_usage_pct: null, grok_usage_error: "http_401" },
] as unknown as AccountRow[];

function member(over: Partial<PoolMember>): PoolMember {
  return {
    service: "gemini", memberKind: "account", id: "1", credentialType: "subscription", label: "a@example.com",
    status: "active", disabledBy: null, healthScore: 100, cooldownReason: null, cooldownUntil: null, nextProbeAt: null,
    lastError: null, lastUsedAt: null, hints: {}, ...over,
  };
}
const POOLS: PoolsResponse = {
  pools: [
    { service: "claude", accepts_api_keys: true, members: [member({ service: "claude", id: "22" }), member({ service: "claude", memberKind: "api_key", credentialType: "api_key", id: "k1", label: "anthropic-key", hints: { key: "…abcd" } })], counts: { active: 2, cooldown: 0, disabled: 0, total: 2 } },
    {
      service: "gemini", accepts_api_keys: true, counts: { active: 1, cooldown: 0, disabled: 0, total: 1 },
      members: [member({
        id: "2", label: "eckersonhanner@gmail.com", hints: { plan: "Antigravity", name: "antigravity-2", bound_users: 1 },
        quota: { updatedAt: new Date(now).toISOString(), note: null, windows: [
          { label: "Gemini · 5 小时", usedPct: 0.1, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
          { label: "Claude/GPT · 每周", usedPct: 26.4, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
        ] },
      })],
    },
    { service: "deepseek", accepts_api_keys: true, counts: { active: 1, cooldown: 0, disabled: 0, total: 1 }, members: [member({ service: "deepseek", memberKind: "api_key", credentialType: "api_key", id: "k2", label: "deepseek-env", hints: { key: "…1234", source: "env" } })] },
  ],
  policy: { fail_threshold: 3, rate_limit_ms: [15_000, 900_000], auth_backoff_ms: [300_000, 21_600_000], credential_backoff_ms: [1_800_000, 86_400_000], upstream_backoff_ms: [600_000, 600_000], quota_default_ms: 3_600_000 },
};

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  sessionStorage.clear();
  adminSend.mockResolvedValue({});
  adminGet.mockImplementation((path: string) => {
    if (path === "/accounts") return Promise.resolve({ rows: ROWS });
    if (path === "/accounts/stats") return Promise.resolve({ total: 4, active: 4, cooldown: 0, disabled: 0, banned: 0, expired_refreshable: 0, expired_unrefreshable: 0, expiring_24h: 0, today_requests: 0, today_errors: 0 });
    if (path === "/stats/account-pool") return Promise.resolve({ total: 0, active: 0, cooldown: 0, disabled: 0, banned: 0, avg_health: 0, today_success_rate: 1 });
    if (path === "/pools") return Promise.resolve(POOLS);
    return Promise.resolve({ rows: [] });
  });
});
afterEach(cleanup);

// Wait for the rows first: before the data arrives every section renders "· 0 条" and would match.
const section = async (desc: RegExp) => {
  await screen.findByText("claude-main");
  await screen.findByText("codex-idle");
  return screen.getByText(desc).closest("section") as HTMLElement;
};

describe("服务池(合并后的一个 tab)", () => {
  test("导航只有一个服务池入口;旧的 #tab=accounts 链接打开它", () => {
    expect(adminPages.filter((p) => p.group === "账号与调度").map((p) => p.title)).toEqual(["服务池", "账号分组", "代理池"]);
    expect(parseAdminHash("#tab=accounts").tab).toBe("pools");
    expect(getAdminPage("accounts").key).toBe("pools");
  });

  test("每个服务一组:订阅账号带使用额度,同组列出 API key", async () => {
    renderPage(<ServicePoolsPage />);
    const claude = await section(/Claude Code 订阅账号/);
    expect(within(claude).getByText("claude-main")).toBeTruthy();
    expect(within(claude).getByText("5 小时")).toBeTruthy();
    expect(within(claude).getByText("已用 23%")).toBeTruthy();
    expect(within(claude).getByText("已用 41%")).toBeTruthy();
    expect(within(claude).getByText(/3h 后重置/)).toBeTruthy();
    expect(within(claude).getByText("anthropic-key")).toBeTruthy();
    expect(within(claude).getByText("按量计费,没有订阅额度")).toBeTruthy();
  });

  test("拿不到额度时写明原因,不留空", async () => {
    renderPage(<ServicePoolsPage />);
    const codex = await section(/Codex 订阅账号/);
    expect(within(codex).getByText("已用 21%")).toBeTruthy();
    expect(within(codex).getByText("上游未返回 5 小时窗口")).toBeTruthy();
    expect(within(codex).getByText("尚无数据:额度随上游响应更新,账号被调用后出现")).toBeTruthy();
    const grok = await section(/Grok Build 订阅账号/);
    expect(within(grok).getByText("读取失败:http_401")).toBeTruthy();
  });

  test("Gemini 组:Antigravity 订阅账号显示两组模型的额度,可在本页停用", async () => {
    renderPage(<ServicePoolsPage />);
    const gemini = await screen.findByTestId("pool-gemini");
    const g = within(gemini);
    expect(g.getByText("eckersonhanner@gmail.com")).toBeTruthy();
    expect(g.getByText("Antigravity · antigravity-2 · 绑定 1 人")).toBeTruthy();
    expect(g.getByText("Gemini · 5 小时")).toBeTruthy();
    expect(g.getByText("已用 0.1%")).toBeTruthy();
    expect(g.getByText("已用 26.4%")).toBeTruthy();
    fireEvent.click(g.getByRole("button", { name: "停用" }));
    fireEvent.click(await screen.findByRole("button", { name: "停用", hidden: false }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("PATCH", "/antigravity-accounts/2", { status: "disabled" }));
    expect(await screen.findByTestId("pool-deepseek")).toBeTruthy();
  });

  test("手机宽度:状态徽标、名称、类型不换行", async () => {
    renderPage(<ServicePoolsPage />);
    const gemini = await screen.findByTestId("pool-gemini");
    for (const chip of within(gemini).getAllByText("可调度", { selector: "span.rounded-full" })) {
      expect(chip.className).toContain("whitespace-nowrap");
    }
    expect(within(gemini).getByText("eckersonhanner@gmail.com").className).toContain("whitespace-nowrap");
    expect(within(gemini).getByText("订阅账号").className).toContain("whitespace-nowrap");
  });
});
