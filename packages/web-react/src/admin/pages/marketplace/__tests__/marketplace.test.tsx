import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

// ReviewPanel / FeaturedPanel（被复用组件）依赖用户端 api 网络层 —— 全 mock，只验证
// admin 页把 adminSession 作为 AuthSession 传入后能干净挂载出两 tab(审核 + 精选管理)。
const adminMarketplacePending = vi.fn();
const adminMarketplaceAiReviews = vi.fn();
const searchMarketplace = vi.fn();
const setMarketplaceFeatured = vi.fn();
const adminGet = vi.fn();
vi.mock("../../../../lib/api", () => ({
  api: {
    adminMarketplacePending: (...a: unknown[]) => adminMarketplacePending(...a),
    adminMarketplaceAiReviews: (...a: unknown[]) => adminMarketplaceAiReviews(...a),
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
    setMarketplaceFeatured: (...a: unknown[]) => setMarketplaceFeatured(...a),
  },
}));
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
  };
});

import MarketplacePage from "../index";

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  adminMarketplacePending.mockReset().mockResolvedValue([]);
  adminMarketplaceAiReviews.mockReset().mockResolvedValue([]);
  searchMarketplace.mockReset().mockResolvedValue({ results: [] });
  setMarketplaceFeatured.mockReset().mockResolvedValue({ ok: true });
  adminGet.mockReset().mockResolvedValue({
    traffic_class: "production_user",
    funnel: {
      exposure_users: 12,
      exposure_events: 20,
      detail_users: 8,
      detail_events: 10,
      install_users: 5,
      installs: 6,
      first_use_users: 4,
      used_pairs: 4,
      repeat_pairs: 2,
    },
    uninstall_reasons: [{ reason: "missing_capability", count: 1 }],
  });
});
afterEach(cleanup);

describe("MarketplacePage", () => {
  test("默认「审核」tab:PageHeader + 复用 ReviewPanel（空待审 + 下架框）", async () => {
    renderPage(<MarketplacePage />);

    expect(screen.getByText("技能市场")).toBeInTheDocument();
    expect(await screen.findByText("暂无待审版本")).toBeInTheDocument();
    // ReviewPanel 内的 AI 审批记录折叠区 + 下架 kill-switch
    expect(screen.getByText("AI 审批记录")).toBeInTheDocument();
    expect(screen.getByText(/下架已上架条目/)).toBeInTheDocument();
  });

  test("使用漏斗默认只拉真实用户并展示阶段与卸载原因", async () => {
    renderPage(<MarketplacePage />);
    fireEvent.click(screen.getByRole("tab", { name: "使用漏斗" }));

    expect(await screen.findByText("目录曝光用户")).toBeInTheDocument();
    expect(await screen.findByText("缺少能力 · 1")).toBeInTheDocument();
    await waitFor(() =>
      expect(adminGet).toHaveBeenCalledWith("/marketplace/funnel", {
        traffic_class: "production_user",
      }),
    );
  });

  test("切到「精选管理」tab → 挂载 FeaturedPanel(空目录空态)", async () => {
    renderPage(<MarketplacePage />);
    await screen.findByText("暂无待审版本");

    fireEvent.click(screen.getByRole("tab", { name: "精选管理" }));
    expect(await screen.findByText("市场还没有可精选的条目")).toBeInTheDocument();
  });

  test("挂载即用 admin 会话拉取待审队列", async () => {
    renderPage(<MarketplacePage />);
    await screen.findByText("暂无待审版本");
    expect(adminMarketplacePending).toHaveBeenCalledTimes(1);
    // 传入的 auth 即 epoch-fenced adminSession。
    const passed = adminMarketplacePending.mock.calls[0][0] as {
      snapshot?: unknown;
      commitToken?: unknown;
      expire?: unknown;
    };
    expect(typeof passed.snapshot).toBe("function");
    expect(typeof passed.commitToken).toBe("function");
    expect(typeof passed.expire).toBe("function");
  });
});
