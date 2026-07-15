import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

// api 网络层全 mock —— 只验证 FeaturedPanel 的排序渲染 + 保存回写契约,不打真实网络。
const searchMarketplace = vi.fn();
const setMarketplaceFeatured = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
    setMarketplaceFeatured: (...a: unknown[]) => setMarketplaceFeatured(...a),
  },
}));

import { FeaturedPanel } from "./FeaturedPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

function card(slug: string, over: Partial<MarketplaceCard> = {}): MarketplaceCard {
  return { slug, kind: "skill", name: slug, description: "", tags: [], ...over };
}

/** kind=skill / agent 各拉一次 —— mock 按 kind 分流返回。 */
function mockCatalog(skills: MarketplaceCard[], agents: MarketplaceCard[] = []) {
  searchMarketplace.mockImplementation((_a: unknown, _q: unknown, kind: string) =>
    Promise.resolve({ results: kind === "agent" ? agents : skills }),
  );
}

beforeEach(() => {
  searchMarketplace.mockReset();
  setMarketplaceFeatured.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

test("合并技能+智能体两源,按 rank 升序在前、非精选按使用数降序在后渲染", async () => {
  mockCatalog(
    [card("bHot", { name: "热门非精选", users30d: 40 }), card("aRank2", { name: "精选二", featuredRank: 2 })],
    [card("agRank1", { name: "精选一", kind: "agent", featuredRank: 1 })],
  );

  render(<FeaturedPanel auth={auth} />);
  await screen.findByText("精选一");

  const items = screen.getAllByRole("listitem");
  const names = items.map((li) => {
    if (li.textContent?.includes("精选一")) return "精选一";
    if (li.textContent?.includes("精选二")) return "精选二";
    return "热门非精选";
  });
  expect(names).toEqual(["精选一", "精选二", "热门非精选"]);
  // 两源各拉一次
  expect(searchMarketplace).toHaveBeenCalledTimes(2);
});

test("改 rank 输入并保存 → 调 setMarketplaceFeatured(slug, 数字) 并刷新目录", async () => {
  mockCatalog([card("plain", { name: "待精选技能", users30d: 3 })]);

  render(<FeaturedPanel auth={auth} />);
  await screen.findByText("待精选技能");
  expect(searchMarketplace).toHaveBeenCalledTimes(2); // 首载

  const input = screen.getByLabelText("待精选技能 精选排序");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 待精选技能 精选排序" }));

  await waitFor(() => expect(setMarketplaceFeatured).toHaveBeenCalledTimes(1));
  expect(setMarketplaceFeatured.mock.calls[0][1]).toBe("plain");
  expect(setMarketplaceFeatured.mock.calls[0][2]).toBe(5);
  // 成功即刷新(再拉两源)
  await waitFor(() => expect(searchMarketplace).toHaveBeenCalledTimes(4));
});

test("清空 rank(留空)保存 → featuredRank=null(取消精选)", async () => {
  mockCatalog([card("feat", { name: "已精选技能", featuredRank: 2 })]);

  render(<FeaturedPanel auth={auth} />);
  await screen.findByText("已精选技能");

  const input = screen.getByLabelText("已精选技能 精选排序");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 已精选技能 精选排序" }));

  await waitFor(() => expect(setMarketplaceFeatured).toHaveBeenCalledTimes(1));
  expect(setMarketplaceFeatured.mock.calls[0][2]).toBeNull();
});

test("未改动时保存按钮禁用(草稿=服务端值)", async () => {
  mockCatalog([card("feat", { name: "已精选技能", featuredRank: 2 })]);

  render(<FeaturedPanel auth={auth} />);
  await screen.findByText("已精选技能");
  expect(screen.getByRole("button", { name: "保存 已精选技能 精选排序" })).toBeDisabled();
});

test("非法 rank(超范围/非整数)→ 报错且不调 API", async () => {
  mockCatalog([card("plain", { name: "待精选技能" })]);

  render(<FeaturedPanel auth={auth} />);
  await screen.findByText("待精选技能");

  const input = screen.getByLabelText("待精选技能 精选排序");
  fireEvent.change(input, { target: { value: "99999" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 待精选技能 精选排序" }));

  expect(await screen.findByText(/精选排序需为 1–9999 的整数/)).toBeInTheDocument();
  expect(setMarketplaceFeatured).not.toHaveBeenCalled();
});

test("空目录 → 空态,不渲染保存行", async () => {
  mockCatalog([], []);

  render(<FeaturedPanel auth={auth} />);
  expect(await screen.findByText("市场还没有可精选的条目")).toBeInTheDocument();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

test("已精选行显示「精选 #N」徽章", async () => {
  mockCatalog([card("feat", { name: "已精选技能", featuredRank: 3 })]);

  render(<FeaturedPanel auth={auth} />);
  const row = (await screen.findByText("已精选技能")).closest("li") as HTMLElement;
  expect(within(row).getByText(/精选 #3/)).toBeInTheDocument();
});
