import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

// api 网络层全 mock —— 只验证 BrowsePanel 的分区/筛选片行为,不打真实网络。
const searchMarketplace = vi.fn();
const listMarketplaceInstalled = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
    listMarketplaceInstalled: (...a: unknown[]) => listMarketplaceInstalled(...a),
  },
}));
vi.mock("./DetailModal", () => ({
  DetailModal: ({ slug, onClose }: { slug: string | null; onClose: () => void }) =>
    slug ? (
      <div data-testid="detail-slug">
        {slug}
        <button type="button" onClick={onClose}>
          关闭详情
        </button>
      </div>
    ) : null,
}));

import { BrowsePanel } from "./BrowsePanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

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

test("卡片:users30d>0 → 以「30天 N 人在用」替代安装数徽章位", async () => {
  searchMarketplace.mockResolvedValue({
    results: [
      card("hot", { name: "热门技能", category: "office-docs", installCount: 50, users30d: 12 }),
    ],
    method: "all",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  expect(await screen.findByText("30天 12 人在用")).toBeInTheDocument();
  // 有真实使用信号时不再单独展示安装数
  expect(screen.queryByText("50 人在用")).not.toBeInTheDocument();
});

test("卡片:users30d=0/缺省 → 沿用安装数「N 人在用」", async () => {
  searchMarketplace.mockResolvedValue({
    results: [card("cold", { name: "冷门技能", category: "office-docs", installCount: 8 })],
    method: "all",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  expect(await screen.findByText("8 人在用")).toBeInTheDocument();
  expect(screen.queryByText(/30天/)).not.toBeInTheDocument();
});

test("卡片:rating 非 null → 中性「👍 M/N」徽章带真实反馈 title", async () => {
  searchMarketplace.mockResolvedValue({
    results: [
      card("rated", { name: "被评技能", category: "office-docs", rating: { up: 7, down: 1 } }),
    ],
    method: "all",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  const badge = await screen.findByText("👍 7/8");
  expect(badge).toBeInTheDocument();
  expect(badge).toHaveAttribute("title", "来自 8 次真实使用的反馈");
});

test("卡片:rating=null/缺省(服务端已按样本阈值收口)→ 不渲染评分徽章", async () => {
  searchMarketplace.mockResolvedValue({
    results: [
      card("norate", { name: "无评分", category: "office-docs", installCount: 3, rating: null }),
    ],
    method: "all",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByText("无评分");
  expect(screen.queryByText(/👍/)).not.toBeInTheDocument();
});

test("AI 导购入口:浏览态(空查询)不渲染操作行,不挤占分区视图", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} onAskAiInChat={() => {}} />);
  await screen.findByRole("heading", { name: "平台精选" });
  expect(screen.queryByRole("button", { name: /让 AI 帮我找并装好/ })).not.toBeInTheDocument();
});

test("AI 导购入口:有查询词 → 结果区顶部出操作行,点击回调带预填(含查询词)", async () => {
  searchMarketplace.mockResolvedValue({
    results: [card("t", { name: "翻译技能", category: "office-docs" })],
    method: "keyword",
  });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(<BrowsePanel auth={auth} onAskAiInChat={onAsk} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "翻译" } });

  const btn = await screen.findByRole("button", { name: /让 AI 帮我找并装好/ });
  fireEvent.click(btn);
  expect(onAsk).toHaveBeenCalledTimes(1);
  expect(onAsk.mock.calls[0][0]).toContain("我想要:翻译");
});

test("AI 导购入口:查询无结果(空态)仍给操作行(AI 可现场解决)", async () => {
  searchMarketplace.mockResolvedValue({ results: [], method: "keyword" });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(<BrowsePanel auth={auth} onAskAiInChat={onAsk} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "不存在的东西" } });

  const btn = await screen.findByRole("button", { name: /让 AI 帮我找并装好/ });
  expect(screen.getByText("没有匹配的技能")).toBeInTheDocument();
  fireEvent.click(btn);
  expect(onAsk.mock.calls[0][0]).toContain("不存在的东西");
});

test("AI 导购入口:未传 onAskAiInChat → 即便有查询词也不渲染操作行", async () => {
  searchMarketplace.mockResolvedValue({
    results: [card("t", { name: "翻译技能", category: "office-docs" })],
    method: "keyword",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "翻译" } });
  await screen.findByText("翻译技能");
  expect(screen.queryByRole("button", { name: /让 AI 帮我找并装好/ })).not.toBeInTheDocument();
});

test("审核 revision 变化与窗口重新聚焦都会重新拉取目录", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  const view = render(<BrowsePanel auth={auth} revision={0} />);
  await screen.findByRole("heading", { name: "平台精选" });
  expect(searchMarketplace).toHaveBeenCalledTimes(1);

  view.rerender(<BrowsePanel auth={auth} revision={1} />);
  await waitFor(() => expect(searchMarketplace).toHaveBeenCalledTimes(2));

  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(searchMarketplace).toHaveBeenCalledTimes(3));
});

test("审核通过 CTA 的 focusRequest 可直接打开新上架条目", async () => {
  searchMarketplace.mockResolvedValue({ results: [], method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onConsumed = vi.fn();

  const view = render(
    <BrowsePanel
      auth={auth}
      kind="connector"
      focusRequest={{ slug: "docs-plugin", nonce: 1 }}
      onFocusRequestConsumed={onConsumed}
    />,
  );

  expect(await screen.findByTestId("detail-slug")).toHaveTextContent("docs-plugin");
  expect(onConsumed).toHaveBeenCalledWith(1);
  expect(screen.getByPlaceholderText(/搜索插件/)).toBeInTheDocument();

  view.rerender(
    <BrowsePanel
      auth={auth}
      kind="connector"
      focusRequest={null}
      onFocusRequestConsumed={onConsumed}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  expect(screen.queryByTestId("detail-slug")).not.toBeInTheDocument();

  view.unmount();
  render(
    <BrowsePanel
      auth={auth}
      kind="connector"
      focusRequest={null}
      onFocusRequestConsumed={onConsumed}
    />,
  );
  expect(screen.queryByTestId("detail-slug")).not.toBeInTheDocument();
});
