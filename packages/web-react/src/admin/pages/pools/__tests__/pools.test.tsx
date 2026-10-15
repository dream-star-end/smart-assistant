import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import PoolsPage from "../index";
import type { PoolMember, PoolsResponse } from "../types";

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminSend: (...a: unknown[]) => adminSend(...a),
    adminText: vi.fn(),
  };
});

function member(over: Partial<PoolMember>): PoolMember {
  return {
    service: "claude", memberKind: "account", id: "1", credentialType: "subscription",
    label: "someone-with-a-long-name@example.com", status: "active", disabledBy: null,
    healthScore: 100, cooldownReason: null, cooldownUntil: null, nextProbeAt: null,
    lastError: null, lastUsedAt: null, hints: { plan: "pro" }, ...over,
  };
}

const RESP: PoolsResponse = {
  pools: [{
    service: "claude",
    accepts_api_keys: true,
    members: [
      member({ id: "1" }),
      member({ id: "2", status: "cooldown", cooldownReason: "auth", cooldownUntil: new Date(Date.now() + 3 * 3_600_000).toISOString() }),
      member({ id: "3", status: "disabled", disabledBy: "admin", lastError: "refresh failed: 400 invalid_grant ".repeat(6).trim() }),
    ],
    counts: { active: 1, cooldown: 1, disabled: 1, total: 3 },
  }],
  policy: {
    fail_threshold: 3, rate_limit_ms: [15_000, 900_000], auth_backoff_ms: [300_000, 21_600_000],
    credential_backoff_ms: [1_800_000, 86_400_000], upstream_backoff_ms: [600_000, 600_000], quota_default_ms: 3_600_000,
  },
};

function wrap(children: ReactNode) {
  return <ToastProvider><TooltipProvider>{children}</TooltipProvider></ToastProvider>;
}

describe("PoolsPage 手机宽度", () => {
  beforeEach(() => {
    adminGet.mockReset();
    adminGet.mockResolvedValue(RESP);
  });
  afterEach(cleanup);

  test("状态徽标、类型、名称和恢复时间都不换行(表格横向滚动)", async () => {
    render(wrap(<PoolsPage />));
    for (const text of ["可调度", "认证失效·自动探测", "管理员停用"]) {
      const chips = await screen.findAllByText(text, { selector: "span.rounded-full" });
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) expect(chip.className).toContain("whitespace-nowrap");
    }
    for (const el of screen.getAllByText("订阅账号", { selector: "td span" })) expect(el.className).toContain("whitespace-nowrap");
    expect(screen.getByText(/小时 .* 分后/).className).toContain("whitespace-nowrap");
    // 最近错误列在 390px 下曾被压到 72px、长报错竖排把每行撑到 160px:要有最小宽度并限三行,全文放 title。
    const err = screen.getByText(/^refresh failed: 400/);
    expect(err.className).toContain("min-w-[14rem]");
    expect(err.className).toContain("line-clamp-3");
    expect(err.getAttribute("title")).toMatch(/^refresh failed: 400/);
    for (const el of screen.getAllByText("someone-with-a-long-name@example.com")) {
      // break-all 会让名称列被压到两三个字符宽、邮箱逐字断行(#736 上线后实测),名称必须整行显示。
      expect(el.className).toContain("whitespace-nowrap");
      expect(el.className).not.toContain("break-all");
    }
  });
});

describe("PoolsPage Gemini 订阅账号与订阅账号页的关系", () => {
  const GEMINI: PoolsResponse = {
    pools: [
      { ...RESP.pools[0] },
      {
        service: "gemini",
        accepts_api_keys: true,
        members: [
          member({ service: "gemini", id: "2", label: "eckersonhanner@gmail.com", hints: { plan: "Antigravity", name: "eckersonhanner", manage: "antigravity" } }),
        ],
        counts: { active: 1, cooldown: 0, disabled: 0, total: 1 },
      },
    ],
    policy: RESP.policy,
  };
  beforeEach(() => {
    adminGet.mockReset();
    adminSend.mockReset();
    adminGet.mockResolvedValue(GEMINI);
    adminSend.mockResolvedValue({});
  });
  afterEach(cleanup);

  test("Gemini 组列出 Antigravity 订阅账号,可在本页停用(走 Antigravity 账号接口)", async () => {
    render(wrap(<PoolsPage />));
    const section = await screen.findByTestId("pool-gemini");
    const g = within(section);
    expect(g.getByText("eckersonhanner@gmail.com")).toBeTruthy();
    expect(g.getByText("订阅账号")).toBeTruthy();
    expect(g.getByText(/Antigravity · eckersonhanner/)).toBeTruthy();
    fireEvent.click(g.getByRole("button", { name: "停用" }));
    fireEvent.click(await screen.findByRole("button", { name: "停用", hidden: false }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("PATCH", "/antigravity-accounts/2", { status: "disabled" }));
  });

  test("其他服务的订阅账号在本页只看状态,「管理」跳到订阅账号页;页头指向订阅账号", async () => {
    render(wrap(<PoolsPage />));
    const section = await screen.findByTestId("pool-claude");
    const links = within(section).getAllByRole("link", { name: "管理" });
    expect(links.length).toBe(3);
    for (const a of links) expect(a.getAttribute("href")).toBe("#tab=accounts");
    expect(within(section).queryByRole("button", { name: "停用" })).toBeNull();
    const header = screen.getByRole("link", { name: "订阅账号" });
    expect(header.getAttribute("href")).toBe("#tab=accounts");
  });
});
