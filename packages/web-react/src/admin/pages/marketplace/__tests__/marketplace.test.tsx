import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

// ReviewPanel（被复用组件）依赖用户端 api 网络层 —— 全 mock，只验证 admin 页把
// adminSession 作为 AuthSession 传入后能干净挂载出审核台 + 下架框。
const adminMarketplacePending = vi.fn();
const adminMarketplaceAiReviews = vi.fn();
const searchMarketplace = vi.fn();
vi.mock("../../../../lib/api", () => ({
  api: {
    adminMarketplacePending: (...a: unknown[]) => adminMarketplacePending(...a),
    adminMarketplaceAiReviews: (...a: unknown[]) => adminMarketplaceAiReviews(...a),
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
  },
}));

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
});
afterEach(cleanup);

describe("MarketplacePage", () => {
  test("PageHeader + 复用 ReviewPanel（空待审 + 下架框）", async () => {
    renderPage(<MarketplacePage />);

    expect(screen.getByText("技能市场")).toBeInTheDocument();
    expect(await screen.findByText("暂无待审版本")).toBeInTheDocument();
    // ReviewPanel 内的 AI 审批记录折叠区 + 下架 kill-switch
    expect(screen.getByText("AI 审批记录")).toBeInTheDocument();
    expect(screen.getByText(/下架已上架条目/)).toBeInTheDocument();
  });

  test("挂载即用 admin 会话拉取待审队列", async () => {
    renderPage(<MarketplacePage />);
    await screen.findByText("暂无待审版本");
    expect(adminMarketplacePending).toHaveBeenCalledTimes(1);
    // 传入的 auth 即 adminSession（getToken/setToken/onExpired 三件套）
    const passed = adminMarketplacePending.mock.calls[0][0] as {
      getToken?: unknown;
      onExpired?: unknown;
    };
    expect(typeof passed.getToken).toBe("function");
    expect(typeof passed.onExpired).toBe("function");
  });
});
