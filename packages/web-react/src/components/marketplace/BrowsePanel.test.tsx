import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceCard } from "../../lib/types";

// api 网络层全 mock —— 只验证 BrowsePanel 的分区/筛选片行为,不打真实网络。
const searchMarketplace = vi.fn();
const listMarketplaceInstalled = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
    listMarketplaceInstalled: (...a: unknown[]) => listMarketplaceInstalled(...a),
  },
}));

import { BrowsePanel } from "./BrowsePanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };

function card(slug: string, over: Partial<MarketplaceCard> = {}): MarketplaceCard {
  return { slug, kind: "skill", name: slug, description: "d", tags: [], ...over };
}

const CATALOG: MarketplaceCard[] = [
  card("ppt", { name: "PPT 生成器", category: "office-docs", featuredRank: 0 }),
  card("word", { name: "Word 排版", category: "office-docs" }),
  card("excel", { name: "Excel 分析", category: "data-analysis" }),
  card("misc", { name: "杂项工具", category: null }),
];

test("空查询渲染分区视图:平台精选 + 分类分区 + 未分类兜底", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);

  // 分区区头(heading 角色,不与同名 chip 冲突)
  expect(await screen.findByRole("heading", { name: "平台精选" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "办公文档" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "数据分析" })).toBeInTheDocument();
  // 无分类卡片进入「未分类」兜底分区
  expect(screen.getByRole("heading", { name: "未分类" })).toBeInTheDocument();
});

test("分类筛选片只渲染有条目的分类(+全部/未分类)", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "平台精选" });

  expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "办公文档" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "数据分析" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "未分类" })).toBeInTheDocument();
  // 没有条目的分类不出 chip
  expect(screen.queryByRole("button", { name: "编程开发" })).not.toBeInTheDocument();
});

test("选中某个分类筛选片 → 平铺该类,其余分类/区头消失", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "平台精选" });

  fireEvent.click(screen.getByRole("button", { name: "数据分析" }));

  await waitFor(() => {
    // 平铺态:区头(平台精选/办公文档)不再渲染
    expect(screen.queryByRole("heading", { name: "平台精选" })).not.toBeInTheDocument();
  });
  // 只剩数据分析类的卡片
  expect(screen.getByText("Excel 分析")).toBeInTheDocument();
  expect(screen.queryByText("PPT 生成器")).not.toBeInTheDocument();
  expect(screen.queryByText("Word 排版")).not.toBeInTheDocument();
});

test("空目录时给空态,不渲染分区/筛选片", async () => {
  searchMarketplace.mockResolvedValue({ results: [], method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  expect(await screen.findByText("市场还没有上架的技能")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "全部" })).not.toBeInTheDocument();
});
