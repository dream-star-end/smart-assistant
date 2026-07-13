import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceAiReview, MarketplacePending } from "../../lib/types";

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

const auth: AuthSession = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };

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

  render(<ReviewPanel auth={auth} />);
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

  render(<ReviewPanel auth={auth} />);
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

  render(<ReviewPanel auth={auth} />);
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

  render(<ReviewPanel auth={auth} />);
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

  render(<ReviewPanel auth={auth} />);
  await screen.findByText("带评测技能");
  // 徽章恰出现一次(仅带 evals 的行)
  expect(screen.getAllByText("带 evals")).toHaveLength(1);
});

test("AI 审批记录折叠区:展开后拉取并展示 approved/rejected 记录", async () => {
  adminMarketplacePending.mockResolvedValue([]);
  searchMarketplace.mockResolvedValue({ results: [] });
  adminMarketplaceAiReviews.mockResolvedValue([
    aiReview({ slug: "ok-skill", name: "通过技能", status: "approved", aiNote: "合规" }),
    aiReview({ versionId: "10", slug: "bad-skill", name: "被拒技能", status: "rejected", aiNote: "垃圾内容" }),
  ]);

  render(<ReviewPanel auth={auth} />);
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
