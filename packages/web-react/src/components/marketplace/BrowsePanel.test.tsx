import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

// api 网络层全 mock —— 只验证 BrowsePanel 的分区/筛选片行为,不打真实网络。
const searchMarketplace = vi.fn();
const listMarketplaceInstalled = vi.fn();
const reportClientFriction = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({
  api: {
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
    listMarketplaceInstalled: (...a: unknown[]) => listMarketplaceInstalled(...a),
  },
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
}));
vi.mock("../../lib/clientFriction", () => ({ reportClientFriction }));
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
  expect(reportClientFriction).toHaveBeenCalledWith(
    expect.objectContaining({
      surface: "marketplace",
      stage: "catalog_exposure",
      outcome: "succeeded",
    }),
    "tok",
  );
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
  const chips = screen.getByRole("region", { name: "市场分类，可横向滚动" });
  expect(chips).toHaveAttribute("tabindex", "0");
  expect(chips).toHaveClass("overflow-x-auto", "snap-x");
  // 「可以左右滑」改由右缘渐隐暗示,不再常驻一行小字吃掉移动端 24px
  expect(screen.queryByText("左右滑动查看更多分类")).not.toBeInTheDocument();
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
  expect(reportClientFriction).not.toHaveBeenCalled();
});

test("市场首次加载失败可原地重试并恢复目录", async () => {
  searchMarketplace
    .mockRejectedValueOnce(new Error("backend unavailable"))
    .mockResolvedValueOnce({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  expect(await screen.findByText("加载市场失败")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("heading", { name: "平台精选" })).toBeInTheDocument();
  expect(searchMarketplace).toHaveBeenCalledTimes(2);
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

test("卡片:rating 非 null → 「M/N」信号(lucide 图标,样本量进无障碍名而非 hover title)", async () => {
  searchMarketplace.mockResolvedValue({
    results: [
      card("rated", { name: "被评技能", category: "office-docs", rating: { up: 7, down: 1 } }),
    ],
    method: "all",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  // 原生 title 在触屏上根本触发不了,样本量说明改由 aria-label 承载
  const signal = await screen.findByLabelText("好评 7/8，来自 8 次真实使用的反馈");
  expect(signal).toHaveTextContent("7/8");
  // emoji 不跟随 currentColor、跨平台字形差异大 —— UI chrome 里不再出现
  expect(screen.queryByText(/👍/)).not.toBeInTheDocument();
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
  expect(screen.queryByLabelText(/次真实使用的反馈/)).not.toBeInTheDocument();
});

test("AI 导购入口:浏览态(空查询)也常驻在头带,点击带默认预填", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(<BrowsePanel auth={auth} onAskAiInChat={onAsk} />);
  await screen.findByRole("heading", { name: "平台精选" });

  // 最需要导购的正是"还不知道自己要装什么"的浏览态用户 —— 入口不能等敲了查询词才出现
  fireEvent.click(screen.getByRole("button", { name: "AI 帮我挑" }));
  expect(onAsk).toHaveBeenCalledTimes(1);
  expect(onAsk.mock.calls[0][0]).toContain("适合我的技能");
});

test("AI 导购入口:有查询词 → 头带入口带上查询词预填", async () => {
  searchMarketplace.mockResolvedValue({
    results: [card("t", { name: "翻译技能", category: "office-docs" })],
    method: "keyword",
  });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(<BrowsePanel auth={auth} onAskAiInChat={onAsk} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "翻译" } });

  // 等防抖落到查询词(入口一直在,变的只是它带走的预填内容)
  await waitFor(() => expect(searchMarketplace.mock.calls.at(-1)?.[1]).toBe("翻译"));
  fireEvent.click(screen.getByRole("button", { name: "AI 帮我挑" }));
  expect(onAsk).toHaveBeenCalledTimes(1);
  expect(onAsk.mock.calls[0][0]).toContain("我想要:翻译");
});

test("AI 导购入口:查询无结果 → 空态给「让 AI 帮我找」与「清空搜索」两个出口", async () => {
  searchMarketplace.mockResolvedValue({ results: [], method: "keyword" });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(<BrowsePanel auth={auth} onAskAiInChat={onAsk} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "不存在的东西" } });

  const btn = await screen.findByRole("button", { name: /让 AI 帮我找/ });
  expect(screen.getByText("没有匹配的技能")).toBeInTheDocument();
  fireEvent.click(btn);
  expect(onAsk.mock.calls[0][0]).toContain("不存在的东西");

  // 空态必须有下一步动作:清空搜索直接回到目录
  fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
  await waitFor(() => expect(screen.getByPlaceholderText(/搜索技能/)).toHaveValue(""));
});

test("AI 导购入口:未传 onAskAiInChat → 不渲染入口", async () => {
  searchMarketplace.mockResolvedValue({
    results: [card("t", { name: "翻译技能", category: "office-docs" })],
    method: "keyword",
  });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  fireEvent.change(screen.getByPlaceholderText(/搜索技能/), { target: { value: "翻译" } });
  await screen.findByText("翻译技能");
  expect(screen.queryByRole("button", { name: /AI 帮我/ })).not.toBeInTheDocument();
});

test("类目 Tabs:选中态可读,切换回调把存储层 kind 交回壳层", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);
  const onKindChange = vi.fn();

  render(<BrowsePanel auth={auth} kind="skill" onKindChange={onKindChange} />);
  await screen.findByRole("heading", { name: "平台精选" });

  // 走 Tabs 原语:有 tablist/aria-selected/方向键导航,不再是三个裸 button
  expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "插件" }));
  expect(onKindChange).toHaveBeenCalledWith("connector");
});

test("目录不再硬截断:装满一页给「加载更多」,点击按 +50 重新拉取", async () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    card(`s${i}`, { name: `技能 ${i}`, category: "office-docs" }),
  );
  searchMarketplace.mockResolvedValue({ results: many, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "办公文档" });
  expect(searchMarketplace.mock.calls[0][3]).toBe(50);
  expect(screen.getByText(/共 50 个技能/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await waitFor(() => expect(searchMarketplace.mock.calls.at(-1)?.[3]).toBe(100));
});

test("目录未装满一页 → 不出现「加载更多」", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "平台精选" });
  expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
});

test("分区视图:精选卡不在所属分类区重复出现(同一屏不出现两张同名卡)", async () => {
  searchMarketplace.mockResolvedValue({ results: CATALOG, method: "all" });
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "平台精选" });

  expect(screen.getAllByText("PPT 生成器")).toHaveLength(1);
  // 分类区仍在(同类的非精选条目照常展示)
  expect(screen.getByRole("heading", { name: "办公文档" })).toBeInTheDocument();
  expect(screen.getByText("Word 排版")).toBeInTheDocument();

  // 点进该分类的平铺视图时,精选条目仍属于这个分类(成员数如实)
  fireEvent.click(screen.getByRole("button", { name: "办公文档" }));
  await waitFor(() => expect(screen.getByText("PPT 生成器")).toBeInTheDocument());
  expect(screen.getByText("Word 排版")).toBeInTheDocument();
});

test("静默校准失败不打扰:保留旧列表 + 头带给重试,不弹红条", async () => {
  searchMarketplace
    .mockResolvedValueOnce({ results: CATALOG, method: "all" })
    .mockRejectedValueOnce(new Error("network blip"));
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<BrowsePanel auth={auth} />);
  await screen.findByRole("heading", { name: "平台精选" });

  window.dispatchEvent(new Event("focus"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "同步失败，点击重试" })).toBeInTheDocument(),
  );
  // 用户什么都没点,不该跳出整条红色错误把内容往下推
  expect(screen.queryByText("加载市场失败")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "平台精选" })).toBeInTheDocument();
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
