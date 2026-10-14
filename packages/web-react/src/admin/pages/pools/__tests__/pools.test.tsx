import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import PoolsPage from "../index";
import type { PoolMember, PoolsResponse } from "../types";

const adminGet = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminSend: vi.fn(),
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
      member({ id: "3", status: "disabled", disabledBy: "admin" }),
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
    for (const el of screen.getAllByText("订阅账号")) expect(el.className).toContain("whitespace-nowrap");
    expect(screen.getByText(/小时 .* 分后/).className).toContain("whitespace-nowrap");
    for (const el of screen.getAllByText("someone-with-a-long-name@example.com")) {
      // break-all 会让名称列被压到两三个字符宽、邮箱逐字断行(#736 上线后实测),名称必须整行显示。
      expect(el.className).toContain("whitespace-nowrap");
      expect(el.className).not.toContain("break-all");
    }
  });
});
