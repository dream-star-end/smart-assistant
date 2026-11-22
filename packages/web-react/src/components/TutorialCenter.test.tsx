import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "../lib/productCapabilities";
import type { TutorialCaseId } from "../lib/tutorialCaseCatalog";
import { TUTORIAL_PENDING_CAPTURE_LABEL } from "../lib/tutorialJourneys";
import { SIGNATURE_WORKS } from "../lib/tutorialSignatureWorks";
import { loadBeforeAll } from "../test/moduleLoad";
import { prefetchMarkdownImpl } from "./Markdown";
import { type TutorialBrowseView, TutorialCenter } from "./TutorialCenter";
import { preloadToolBody } from "./tool/lazyToolBody";

loadBeforeAll(preloadToolBody);
loadBeforeAll(prefetchMarkdownImpl);

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function mockEmptyBlogApi() {
  vi.spyOn(api, "listCommunityTutorials").mockResolvedValue({
    tutorials: [],
    nextCursor: null,
  });
}

function TopicHarness({
  initial = PRODUCT_CAPABILITIES.chatBasics.id,
  enabled = true,
  onRun = vi.fn<(feature: ProductCapability) => void>(),
}: {
  initial?: ProductFeatureId;
  enabled?: boolean;
  onRun?: (feature: ProductCapability) => void;
}) {
  const [topic, setTopic] = useState<ProductFeatureId | null>(initial);
  return (
    <TutorialCenter
      open
      topicId={topic}
      onTopicChange={setTopic}
      onShowCaseGallery={() => setTopic(null)}
      onClose={() => {}}
      actionState={() =>
        enabled
          ? { enabled: true, label: "回到功能位置" }
          : {
              enabled: false,
              label: "打开组织中心",
              disabledReason: "只有组织管理员可以进入。",
            }
      }
      onRunAction={onRun}
    />
  );
}

function InteractiveHarness({
  initialCase = null,
  initialBrowseView,
  blogEnabled = true,
  caseActionLabel = "带着指令去对话",
  onRunCase = () => {},
}: {
  initialCase?: TutorialCaseId | null;
  initialBrowseView?: TutorialBrowseView;
  blogEnabled?: boolean;
  caseActionLabel?: string;
  onRunCase?: React.ComponentProps<typeof TutorialCenter>["onRunCase"];
}) {
  const [caseId, setCaseId] = useState<TutorialCaseId | null>(initialCase);
  const [topicId, setTopicId] = useState<ProductFeatureId | null>(null);
  const [browseView, setBrowseView] = useState<TutorialBrowseView | undefined>(initialBrowseView);
  const [workId, setWorkId] = useState<(typeof SIGNATURE_WORKS)[number]["id"] | null>(null);
  return (
    <TutorialCenter
      open
      topicId={topicId}
      caseId={caseId}
      browseView={browseView}
      onBrowseViewChange={setBrowseView}
      signatureWorkId={workId}
      onSignatureWorkChange={setWorkId}
      blogEnabled={blogEnabled}
      onTopicChange={(id) => {
        setTopicId(id);
        setCaseId(null);
      }}
      onCaseChange={(id) => {
        setCaseId(id);
        setTopicId(null);
      }}
      onShowCaseGallery={() => {
        setCaseId(null);
        setTopicId(null);
      }}
      caseActionLabel={caseActionLabel}
      onRunCase={onRunCase}
      onClose={() => {}}
      actionState={() => ({ enabled: true, label: "回到功能位置" })}
      onRunAction={() => {}}
    />
  );
}

describe("TutorialCenter 新版极简三页签壳层", () => {
  it("默认标题固定为「帮助与经验」，个人版默认首屏为「经验分享」，移除旧下拉与营销展厅", () => {
    mockEmptyBlogApi();
    render(<InteractiveHarness blogEnabled />);

    expect(screen.getByRole("dialog", { name: "帮助与经验" })).toBeInTheDocument();
    const tablist = screen.getByRole("tablist", { name: "帮助与经验导航" });
    const tabs = screen.getAllByRole("tab");
    expect(tablist).toBeInTheDocument();
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "经验分享",
      "实战指南",
      "功能速查",
    ]);
    expect(screen.getByRole("tab", { name: "经验分享" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "经验分享" })).toBeInTheDocument();

    // 旧杂乱入口彻底移除
    expect(screen.queryByRole("button", { name: /帮助与创作/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /让它做给你看/ })).not.toBeInTheDocument();
    expect(screen.queryByText("教程工作室")).not.toBeInTheDocument();
    expect(screen.queryByText("案例脚本")).not.toBeInTheDocument();
    expect(screen.queryByText("新")).not.toBeInTheDocument();

    // Dialog 层级迁至 z-(--z-modal)，不再出现裸 z-50
    const dialog = screen.getByRole("dialog", { name: "帮助与经验" });
    expect(dialog.className).toContain("z-(--z-modal)");
    expect(dialog.className).not.toMatch(/\bz-50\b/);
  });

  it("三枚一级页签可在「经验分享」「实战指南」「功能速查」间自由切换并支持方向键", () => {
    mockEmptyBlogApi();
    render(<InteractiveHarness blogEnabled />);

    const guideTab = screen.getByRole("tab", { name: "实战指南" });
    fireEvent.click(guideTab);
    expect(guideTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "4 件事，马上用顺手" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "按真实任务直接开工" })).toBeInTheDocument();

    const lookupTab = screen.getByRole("tab", { name: "功能速查" });
    fireEvent.click(lookupTab);
    expect(lookupTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "常用命令与快捷键" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "高频核心能力直达" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择教程" })).not.toBeInTheDocument();

    // 键盘方向键切换回「经验分享」
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "经验分享" })).toHaveAttribute("aria-selected", "true");
  });

  it("实战指南点击场景卡后经 onRunCase 带入可修改开工指令（未登录态文案清晰）", () => {
    const onRunCase = vi.fn();
    render(
      <InteractiveHarness
        blogEnabled={false}
        caseActionLabel="登录后试用"
        onRunCase={onRunCase}
      />,
    );

    expect(screen.getByRole("tab", { name: "实战指南" })).toHaveAttribute("aria-selected", "true");
    const ctaButtons = screen.getAllByRole("button", { name: /登录后带入对话/ });
    expect(ctaButtons.length).toBeGreaterThan(0);
    fireEvent.click(ctaButtons[0]!);

    expect(onRunCase).toHaveBeenCalledTimes(1);
    expect(onRunCase).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        title: expect.any(String),
        starterPrompt: expect.any(String),
      }),
    );
  });

  it("功能速查支持进入功能操作卡，点「返回速查板」清掉 topicId 回到速查板", () => {
    render(<TopicHarness initial={PRODUCT_CAPABILITIES.chatBasics.id} />);

    expect(screen.getByRole("tab", { name: "功能速查" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "开始一场高质量对话" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /返回速查板/ })[0]!);
    expect(screen.getByRole("heading", { name: "常用命令与快捷键" })).toBeInTheDocument();
  });

  it("功能速查支持真实功能 CTA、不可用权限原因以及 ?step=N 深链聚焦", async () => {
    const onRun = vi.fn();
    const { rerender } = render(
      <TutorialCenter
        open
        topicId={PRODUCT_CAPABILITIES.chatBasics.id}
        stepIndex={3}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={onRun}
      />,
    );

    const steps = screen
      .getAllByRole("listitem")
      .filter((li) => li.hasAttribute("data-tutorial-step"));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const target = steps.find((li) => li.getAttribute("data-tutorial-step") === "3");
    expect(target).toBeDefined();
    expect(target).toHaveAttribute("aria-current", "step");
    expect(target).toHaveAttribute("id", "tutorial-step-3");
    await waitFor(() => expect(document.activeElement).toBe(target));

    fireEvent.click(screen.getByRole("button", { name: "回到功能位置" }));
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-basics" }));

    // 越界 step 不抛错也不标记
    rerender(
      <TutorialCenter
        open
        topicId={PRODUCT_CAPABILITIES.organization.id}
        stepIndex={42}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({
          enabled: false,
          label: "打开组织中心",
          disabledReason: "只有组织管理员可以进入。",
        })}
        onRunAction={onRun}
      />,
    );
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(screen.getByText("只有组织管理员可以进入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开组织中心" })).toBeDisabled();
  });
});

describe("历史深链与 feature_community_blog 开关兼容", () => {
  const base = {
    open: true,
    topicId: null,
    onTopicChange: () => {},
    onClose: () => {},
    actionState: () => ({ enabled: true, label: "回到功能位置" }),
    onRunAction: () => {},
  } as const;

  it("?tab=start 与 ?tab=cases 优雅映射到「实战指南」", () => {
    const { rerender } = render(<TutorialCenter {...base} browseView="start" blogEnabled />);
    expect(screen.getByRole("tab", { name: "实战指南" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "4 件事，马上用顺手" })).toBeInTheDocument();

    rerender(<TutorialCenter {...base} browseView="cases" blogEnabled />);
    expect(screen.getByRole("tab", { name: "实战指南" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "按真实任务直接开工" })).toBeInTheDocument();
  });

  it("开关关闭时隐藏「经验分享」并默认落「实战指南」，异步变开后平滑切到「经验分享」", () => {
    mockEmptyBlogApi();
    const { rerender } = render(<TutorialCenter {...base} browseView="showcase" blogEnabled={false} />);
    expect(screen.queryByRole("tab", { name: "经验分享" })).toBeNull();
    expect(screen.getByRole("tab", { name: "实战指南" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "4 件事，马上用顺手" })).toBeInTheDocument();

    rerender(<TutorialCenter {...base} browseView="showcase" blogEnabled />);
    expect(screen.getByRole("tab", { name: "经验分享" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "经验分享" })).toBeInTheDocument();
  });

  it("开关关闭时 tab=blog&community=<id> 不进旧教程工作室；配置晚到为开时切到经验分享详情", async () => {
    mockEmptyBlogApi();
    const detail = vi.spyOn(api, "getCommunityTutorial").mockRejectedValue(new Error("not loaded"));
    const { rerender } = render(
      <TutorialCenter {...base} browseView="blog" communityId="42" blogEnabled={false} />,
    );
    expect(screen.getByRole("heading", { name: "4 件事，马上用顺手" })).toBeInTheDocument();
    expect(screen.queryByText("教程工作室")).toBeNull();
    expect(detail).not.toHaveBeenCalled();

    rerender(<TutorialCenter {...base} browseView="blog" communityId="42" blogEnabled />);
    expect(screen.getByRole("tab", { name: "经验分享" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(detail).toHaveBeenCalledWith("42"));
  });

  it("?case=research-bike-demand 静默渲染公开数据实作详情并保留 onRunCase 闭环", () => {
    const onRunCase = vi.fn();
    render(<InteractiveHarness initialCase="research-bike-demand" onRunCase={onRunCase} />);
    expect(
      screen.getByRole("heading", { name: "一堆出行数据，变成看得懂的需求规律。" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/非完整会话回放/)).toBeInTheDocument();
  });

  it("?case=coding-swe-bench-fix 与非精选案例深链保留原案例详情与 onRunCase", () => {
    const onRunCase = vi.fn();
    const { rerender } = render(
      <TutorialCenter
        {...base}
        caseId="coding-swe-bench-fix"
        caseActionLabel="带着指令去对话"
        onRunCase={onRunCase}
      />,
    );
    expect(screen.getAllByText(new RegExp(TUTORIAL_PENDING_CAPTURE_LABEL))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "带着我的材料开始，带着指令去对话" }));
    expect(onRunCase).toHaveBeenCalledWith(
      expect.objectContaining({ id: "coding-swe-bench-fix" }),
    );

    rerender(<TutorialCenter {...base} caseId="coding-feature-delivery" />);
    expect(
      screen.getByRole("heading", { name: "从一条需求交付可合并的 API 功能" }),
    ).toBeInTheDocument();
  });

  it("?community=tut-7（无 tab=blog）静默渲染旧社区教程公开详情", async () => {
    mockEmptyBlogApi();
    vi.spyOn(api, "getCommunityTutorial").mockResolvedValue({
      id: "tut-7",
      title: "深链社区教程",
      summary: "从 URL 打开。",
      category: "general",
      authorName: "作者",
      publishedAt: "2026-08-20T00:00:00.000Z",
      bodyMarkdown: "深链正文",
    });
    render(<TutorialCenter {...base} communityId="tut-7" />);
    await waitFor(() => expect(api.getCommunityTutorial).toHaveBeenCalledWith("tut-7"));
    expect(await screen.findByText("深链正文")).toBeInTheDocument();
  });

  it("?work=planet 静默渲染精选作品详情，标题保持「帮助与经验」，返回回调清空 signatureWorkId", () => {
    const onSignatureWorkChange = vi.fn();
    render(
      <TutorialCenter
        {...base}
        signatureWorkId={SIGNATURE_WORKS[0].id}
        onSignatureWorkChange={onSignatureWorkChange}
      />,
    );
    expect(screen.getByRole("dialog", { name: "帮助与经验" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: SIGNATURE_WORKS[0].title }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回案例展厅" }));
    expect(onSignatureWorkChange).toHaveBeenLastCalledWith(null);
  });
});
