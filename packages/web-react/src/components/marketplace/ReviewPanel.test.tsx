import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceAiReview, MarketplacePending } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider, TooltipProvider } from "../ui";
import { expectAriaControlsResolvable } from "../../test/ariaControls";

// api 网络层全 mock —— 只验证 ReviewPanel 与契约交互(待审 AI 意见区 + AI 审批记录折叠区)。
const adminMarketplacePending = vi.fn();
const adminMarketplaceAiReviews = vi.fn();
const searchMarketplace = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    adminMarketplacePending: (...a: unknown[]) => adminMarketplacePending(...a),
    adminMarketplaceAiReviews: (...a: unknown[]) => adminMarketplaceAiReviews(...a),
    searchMarketplace: (...a: unknown[]) => searchMarketplace(...a),
  },
}));
// 富介绍走既有 <Markdown>(懒加载)。测试里用轻量桩直出文本,避免异步 chunk flake。
vi.mock("../Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

import { ReviewPanel } from "./ReviewPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

/**
 * 面板挂载在两处(用户端市场弹窗 / admin 后台),两处的根都提供了
 * ToastProvider + TooltipProvider(main.tsx、admin/main.tsx)。日期走 TimeAgo、
 * 原始工件走 CopyChip 后,单测也必须给出同样的上下文,与 admin 页测试同构。
 */
function renderPanel(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

function pending(over: Partial<MarketplacePending> = {}): MarketplacePending {
  return {
    versionId: "1",
    slug: "my-skill",
    kind: "skill",
    version: "1.0.0",
    name: "示例技能",
    description: "一个技能",
    tags: [],
    rawArtifact: "# SKILL",
    artifactHash: "fixture-artifact-hash",
    submittedBy: "10",
    ownerUserId: "10",
    createdAt: new Date().toISOString(),
    riskFlags: [],
    aiNote: null,
    ...over,
  };
}
function aiReview(over: Partial<MarketplaceAiReview> = {}): MarketplaceAiReview {
  return {
    versionId: "9",
    slug: "auto-skill",
    kind: "skill",
    version: "1.0.0",
    name: "自动通过技能",
    status: "approved",
    aiNote: "内容合规,自动通过",
    reviewedAt: new Date().toISOString(),
    ...over,
  };
}

test("待审展开区展示 AI 意见(供参考)", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({ aiNote: "AI 判为通过,但存在风险信号(read_creds),转人工复核" }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  // 展开待审项(点击标题按钮)
  const row = await screen.findByText("示例技能");
  fireEvent.click(row);
  expect(await screen.findByText(/AI 意见（供参考）/)).toBeInTheDocument();
  expect(screen.getByText(/read_creds/)).toBeInTheDocument();
});

test("无 aiNote 的待审项不显示 AI 意见区", async () => {
  adminMarketplacePending.mockResolvedValue([pending({ aiNote: null })]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  const row = await screen.findByText("示例技能");
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByText("一个技能")).toBeInTheDocument());
  expect(screen.queryByText(/AI 意见（供参考）/)).not.toBeInTheDocument();
});

test("展开区展示人向元数据(分类/适用场景/效果示例/详细介绍)", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({
      category: "office-docs",
      useCases: ["把周报要点整理成 PPT"],
      outcomeExamples: ["给一段要点 → 得到成稿 PPT"],
      humanMd: "这是给人看的详细介绍",
    }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  fireEvent.click(await screen.findByText("示例技能"));

  expect(await screen.findByText("办公文档")).toBeInTheDocument();
  expect(screen.getByText("把周报要点整理成 PPT")).toBeInTheDocument();
  expect(screen.getByText("给一段要点 → 得到成稿 PPT")).toBeInTheDocument();
  expect(screen.getByText("这是给人看的详细介绍")).toBeInTheDocument();
});

test("缺 category/useCases 的存量行打「人向元数据缺失」徽章;补齐的不打", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({ versionId: "1", name: "存量技能", category: null, useCases: undefined }),
    pending({ versionId: "2", name: "补齐技能", category: "office-docs", useCases: ["场景一" ] }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  await screen.findByText("存量技能");
  // 缺失徽章恰出现一次(仅存量行)
  expect(screen.getAllByText("人向元数据缺失")).toHaveLength(1);
});

test("rawBundle 含 evals/ → 待审行头打「带 evals」徽章;不含则不打", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({
      versionId: "1",
      name: "带评测技能",
      rawBundle: { "evals/evals.json": '{"version":1,"cases":[]}' },
    }),
    pending({ versionId: "2", name: "无评测技能", rawBundle: { "references/a.md": "x" } }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  await screen.findByText("带评测技能");
  // 徽章恰出现一次(仅带 evals 的行)
  expect(screen.getAllByText("带 evals")).toHaveLength(1);
});

test("连接器未完成功能验收:行内不给「批准」,只给「展开审查」并写明原因", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({ kind: "connector", name: "某 API 插件", manifest: { proposedSecurityDecision: {} } }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  await screen.findByText("某 API 插件");
  // 前置条件未满足时,批准按钮根本不出现(旧实现是点了才在长列表顶部报错)
  expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
  expect(screen.getByText(/需先在展开区核对安全决策/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "展开审查" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /真实功能验收/ }));
  expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
});

test("排队超过 1 天的待审项打「等待 N 天」徽章", async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  adminMarketplacePending.mockResolvedValue([
    pending({ versionId: "1", name: "积压技能", createdAt: threeDaysAgo }),
    pending({ versionId: "2", name: "新提交技能" }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  await screen.findByText("积压技能");
  expect(screen.getAllByText("等待 3 天")).toHaveLength(1);
});

test("AI 审批记录折叠区:展开后拉取并展示 approved/rejected 记录", async () => {
  adminMarketplacePending.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });
  adminMarketplaceAiReviews.mockResolvedValue([
    aiReview({ slug: "ok-skill", name: "通过技能", status: "approved", aiNote: "合规" }),
    aiReview({ versionId: "10", slug: "bad-skill", name: "被拒技能", status: "rejected", aiNote: "垃圾内容" }),
  ]);

  renderPanel(<ReviewPanel auth={auth} />);
  const header = await screen.findByText("AI 审批记录");
  // 折叠时不应已拉取
  expect(adminMarketplaceAiReviews).not.toHaveBeenCalled();
  fireEvent.click(header);
  await waitFor(() => expect(adminMarketplaceAiReviews).toHaveBeenCalled());
  expect(await screen.findByText("通过技能")).toBeInTheDocument();
  expect(screen.getByText("被拒技能")).toBeInTheDocument();
  expect(screen.getByText("已批准")).toBeInTheDocument();
  expect(screen.getByText("已拒绝")).toBeInTheDocument();
});

test("触控靶:待审勾选框、AI 记录折叠头、功能验收确认都由真正接收点击的元素撑到 44px", async () => {
  adminMarketplacePending.mockResolvedValue([
    pending({
      kind: "connector",
      name: "某 API 插件",
      manifest: { proposedSecurityDecision: {} },
      rawBundle: { "evals/case.md": "case" },
    }),
  ]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);

  // ① 逐行勾选框:裸 input 的命中区只有十几像素,外层卡片的 px-3.5/py-3 扩的是卡片、
  //    不是 input 自己的命中区 —— 必须由包住它的 label 撑到 44×44。
  const box = await screen.findByRole("checkbox", { name: "选择 某 API 插件" });
  const boxTarget = box.closest("label");
  expect(boxTarget).not.toBeNull();
  expect(boxTarget).toHaveClass(
    "[@media(hover:none)]:min-h-11",
    "[@media(hover:none)]:min-w-11",
  );

  // ② 「功能验收」确认:label 即点击目标,窄屏折行未必够 44px,显式兜底。
  fireEvent.click(screen.getByRole("button", { name: "展开审查" }));
  const verify = await screen.findByRole("checkbox", { name: /真实功能验收/ });
  expect(verify.closest("label")).toHaveClass("[@media(hover:none)]:min-h-11");

  // ③ 展开区的附属文件折叠头(<summary> 无内距,只有一行 text-caption ≈16px)。
  expect(screen.getByText(/附属文件：evals\/case\.md/).closest("summary")).toHaveClass(
    "[@media(hover:none)]:min-h-11",
  );

  // ④ AI 审批记录折叠头是手写 button(不是 Button 原语),原语的触控靶兜不到它。
  expect(screen.getByRole("button", { name: /AI 审批记录/ })).toHaveClass(
    "[@media(hover:none)]:min-h-11",
  );
});

test("折叠态不落悬空 aria-controls:待审详情与 AI 记录都是展开才挂载", async () => {
  adminMarketplacePending.mockResolvedValue([pending()]);
  adminMarketplaceAiReviews.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });

  renderPanel(<ReviewPanel auth={auth} />);
  await screen.findByText("示例技能");

  // 收起状态:两处折叠区的容器都不在 DOM 里,IDREF 必须一并撤掉
  //(与 Tabs/SkillsPanel 同一条约定:悬空 IDREF 在读屏上是静默失败)。
  expect(screen.getByRole("button", { name: /示例技能/ })).not.toHaveAttribute("aria-controls");
  expect(screen.getByRole("button", { name: /AI 审批记录/ })).not.toHaveAttribute("aria-controls");
  expectAriaControlsResolvable();

  // 展开后 IDREF 必须补回来,并且解析得到真实节点。
  fireEvent.click(screen.getByText("示例技能"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /示例技能/ })).toHaveAttribute("aria-controls"),
  );
  expectAriaControlsResolvable();
});
