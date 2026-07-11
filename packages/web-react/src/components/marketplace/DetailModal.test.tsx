import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceDetail, MarketplaceMyAgent } from "../../lib/types";

const getMarketplaceDetail = vi.fn();
const listMyAgents = vi.fn();
vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    getMarketplaceDetail: (...a: unknown[]) => getMarketplaceDetail(...a),
    listMyAgents: (...a: unknown[]) => listMyAgents(...a),
  },
}));
// 富介绍走既有 <Markdown>(懒加载真实实现)。测试里用轻量桩直出文本,避免异步 chunk flake。
vi.mock("../Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

import { DetailModal } from "./DetailModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };

function detail(over: Partial<MarketplaceDetail> = {}): MarketplaceDetail {
  return {
    slug: "academic-translate",
    kind: "skill",
    state: "active",
    ownerUserId: "1",
    version: "1.0.0",
    versionId: "v1",
    name: "学术翻译",
    description: "一句话描述",
    tags: ["翻译"],
    artifactHash: "h",
    rawArtifact: "# SKILL\nMODEL-FACING-BODY",
    riskFlags: [],
    installCount: 3,
    category: "office-docs",
    useCases: ["把中文论文摘要翻译成地道英文", "润色英文摘要"],
    outcomeExamples: ["给中文摘要 → 得到地道英文摘要"],
    humanMd: "这是富介绍正文段落",
    ...over,
  };
}

test("详情页人向重排:适用场景 / 效果 / 详细介绍 / 分类徽章都渲染", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([] as MarketplaceMyAgent[]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("适用场景")).toBeInTheDocument();
  expect(screen.getByText("把中文论文摘要翻译成地道英文")).toBeInTheDocument();
  expect(screen.getByText("能达成什么效果")).toBeInTheDocument();
  expect(screen.getByText("给中文摘要 → 得到地道英文摘要")).toBeInTheDocument();
  expect(screen.getByText("详细介绍")).toBeInTheDocument();
  expect(screen.getByText("这是富介绍正文段落")).toBeInTheDocument();
  // 分类 label 徽章
  expect(screen.getByText("办公文档")).toBeInTheDocument();
});

test("SKILL.md 原文默认折叠进「技术详情」<details>(默认收起)", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  const summary = await screen.findByText("技术详情（SKILL.md 原文）");
  const details = summary.closest("details") as HTMLDetailsElement | null;
  expect(details).not.toBeNull();
  // 默认收起(无 open 属性)
  expect(details?.open).toBe(false);
});

test("缺人向字段的存量详情不白屏,只渲染已有内容(无适用场景块)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ useCases: undefined, outcomeExamples: undefined, humanMd: null, category: null }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  // description 仍在(未白屏),但没有「适用场景」块
  expect(await screen.findByText("一句话描述")).toBeInTheDocument();
  expect(screen.queryByText("适用场景")).not.toBeInTheDocument();
});

test("信号徽章:usage30d/users30d/安装数/rating 都渲染,rating 文案诚实(非背书百分比)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ installCount: 20, usage30d: 42, users30d: 9, rating: { up: 8, down: 1 } }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("30天 42 次使用")).toBeInTheDocument();
  expect(screen.getByText("30天 9 人在用")).toBeInTheDocument();
  expect(screen.getByText("已安装 20")).toBeInTheDocument();
  // 评分徽章 + 诚实旁注,不做「好评率 89%」式背书大字
  const badge = screen.getByText("👍 8/9");
  expect(badge).toHaveAttribute("title", "来自 9 次使用反馈");
  expect(screen.getByText("来自 9 次使用反馈")).toBeInTheDocument();
  expect(screen.queryByText(/好评率/)).not.toBeInTheDocument();
});

test("footer「在对话中试用」→ 回调带预填(含名称与 slug),供 AI 装好并给示例", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(
    <DetailModal
      slug="academic-translate"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
      onAskAiInChat={onAsk}
    />,
  );

  const btn = await screen.findByRole("button", { name: "在对话中试用" });
  fireEvent.click(btn);
  expect(onAsk).toHaveBeenCalledTimes(1);
  const text = onAsk.mock.calls[0][0] as string;
  expect(text).toContain("「学术翻译」");
  expect(text).toContain("slug: academic-translate");
});

test("未传 onAskAiInChat → 不渲染「在对话中试用」按钮", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);
  await screen.findByText("适用场景");
  expect(screen.queryByRole("button", { name: "在对话中试用" })).not.toBeInTheDocument();
});

test("信号徽章:旧后端缺字段 → 不渲染 usage/rating,仅保留安装数(优雅降级)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ installCount: 5, usage30d: undefined, users30d: undefined, rating: null }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("已安装 5")).toBeInTheDocument();
  expect(screen.queryByText(/次使用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/👍/)).not.toBeInTheDocument();
});
