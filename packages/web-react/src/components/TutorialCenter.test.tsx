import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "../lib/productCapabilities";
import type { TutorialCaseId } from "../lib/tutorialCaseCatalog";
import { api } from "../lib/api";
import { TutorialCenter } from "./TutorialCenter";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function Harness({
  initial = PRODUCT_CAPABILITIES.chatBasics.id,
  enabled = true,
  onRun = vi.fn<(feature: ProductCapability) => void>(),
}: {
  initial?: ProductFeatureId;
  enabled?: boolean;
  onRun?: (feature: ProductCapability) => void;
}) {
  const [topic, setTopic] = useState<ProductFeatureId>(initial);
  return (
    <TutorialCenter
      open
      topicId={topic}
      onTopicChange={setTopic}
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

function CaseHarness({
  initial = null,
  onRunCase = () => {},
}: {
  initial?: TutorialCaseId | null;
  onRunCase?: React.ComponentProps<typeof TutorialCenter>["onRunCase"];
}) {
  const [caseId, setCaseId] = useState<TutorialCaseId | null>(initial);
  const [topicId, setTopicId] = useState<ProductFeatureId | null>(null);
  return (
    <TutorialCenter
      open
      topicId={topicId}
      caseId={caseId}
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
      caseActionLabel="带着指令去对话"
      onRunCase={onRunCase}
      onClose={() => {}}
      actionState={() => ({ enabled: true, label: "回到功能位置" })}
      onRunAction={() => {}}
    />
  );
}

describe("TutorialCenter", () => {
  it("默认展示 10 分钟快速上手主线，而不是未采集案例", () => {
    render(<CaseHarness />);

    expect(screen.getByRole("heading", { name: "10 分钟走完第一次任务" })).toBeInTheDocument();
    expect(screen.getByText("发第一个任务")).toBeInTheDocument();
    expect(screen.getByText("补材料与约束")).toBeInTheDocument();
    expect(screen.getByText("选模型")).toBeInTheDocument();
    expect(screen.getByText("看执行过程")).toBeInTheDocument();
    expect(screen.getByText("拿交付并用反馈迭代")).toBeInTheDocument();
    expect(screen.getByText("用会话历史继续")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "搜索教程" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你不用守着它。回来时，过程和成果都还在。" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("先看一件难事");

    const tabs = screen.getAllByRole("button", { name: /快速上手|按场景学|功能参考|教程工作室|案例示例/ });
    expect(tabs.map((tab) => tab.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "快速上手",
      "按场景学",
      "功能参考",
      "教程工作室",
      "案例示例",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "打开步骤：发第一个任务" }));
    expect(
      screen.getByRole("heading", { name: "开始一场高质量对话" }),
    ).toBeInTheDocument();
  });

  it("按场景学串起现有功能章，并进入对应详情", () => {
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: "按场景学" }));
    expect(screen.getByRole("heading", { name: "按你现在要做的事学" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "写作与办公" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "编程与 GitHub" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编程与 GitHub：GitHub 仓库" }));
    expect(
      screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" }),
    ).toBeInTheDocument();
  });

  it("案例列表与详情都标明示例待真实运行采集", () => {
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: "案例示例" }));
    const pending = screen.getAllByText("示例待真实运行采集");
    expect(pending.length).toBeGreaterThanOrEqual(12);
    expect(screen.getByRole("heading", { name: "这些是待采集的任务脚本" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("先看完整故事");

    fireEvent.click(screen.getByRole("button", { name: /从 30 篇论文到可追溯证据图谱/ }));
    expect(screen.getAllByText("示例待真实运行采集").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("heading", { name: "从 30 篇论文到可追溯证据图谱" })).toBeInTheDocument();
  });

  it("社区 Tab 已改名为教程工作室，并提供四个入口", async () => {
    vi.spyOn(api, "listCommunityTutorials").mockResolvedValue({ tutorials: [], nextCursor: null });
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: "教程工作室" }));
    expect(await screen.findByRole("heading", { name: "探索教程，或把一次真实会话变成可复用方法" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "探索教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从当前会话生成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手写教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我的发布" })).toBeInTheDocument();
  });

  it("communityId 深链直接打开教程工作室并加载详情", async () => {
    vi.spyOn(api, "listCommunityTutorials").mockResolvedValue({ tutorials: [], nextCursor: null });
    vi.spyOn(api, "getCommunityTutorial").mockResolvedValue({
      id: "tut-7",
      title: "深链社区教程",
      summary: "从 URL 打开。",
      category: "general",
      authorName: "作者",
      publishedAt: "2026-08-20T00:00:00.000Z",
      bodyMarkdown: "深链正文",
    });
    render(
      <TutorialCenter
        open
        topicId={null}
        caseId={null}
        communityId="tut-7"
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name: "探索教程，或把一次真实会话变成可复用方法" })).toBeInTheDocument();
    await waitFor(() => expect(api.getCommunityTutorial).toHaveBeenCalledWith("tut-7"));
    expect(await screen.findByText("深链正文")).toBeInTheDocument();
  });

  it("阶段、成果预览和科研编码切换都是真实可操作的", () => {
    render(<CaseHarness initial="research-bike-demand" />);

    expect(screen.getByText("示例待真实运行采集")).toBeInTheDocument();
    const chapterNav = screen.getByRole("navigation", { name: "任务阶段" });
    fireEvent.click(within(chapterNav).getByRole("button", { name: "运行分析" }));
    expect(screen.getByText("当前阶段：运行分析")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /基线和非线性模型正面对照/ })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("tab", { name: "预览可复跑工程" }));
    expect(screen.getByText(/make reproduce/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编码" }));
    expect(screen.getByText(/15 分 49 秒 · Astropy #12906/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /真实 Issue 和固定基线已接收/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "预览修复内容" }));
    expect(screen.getByText(/matrix\[\.\.\., -right\.shape\[0\]:\] = right/)).toBeInTheDocument();
    expect(screen.getByText(/不冒充完整可下载 patch/)).toBeInTheDocument();
  });

  it("主操作只把选中的真实案例交给现有开工流程", () => {
    const onRunCase = vi.fn();
    render(<CaseHarness initial="coding-swe-bench-fix" onRunCase={onRunCase} />);

    fireEvent.click(screen.getByRole("button", { name: "用我的材料开始，带着指令去对话" }));
    expect(onRunCase).toHaveBeenCalledTimes(1);
    expect(onRunCase).toHaveBeenCalledWith(expect.objectContaining({ id: "coding-swe-bench-fix" }));
  });

  it("非精选案例深链继续展示自己的原详情，不会错误回落到单车案例", () => {
    render(<CaseHarness initial="coding-feature-delivery" />);

    expect(
      screen.getByRole("heading", { name: "从一条需求交付可合并的 API 功能" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你不用守着它。回来时，过程和成果都还在。" }),
    ).not.toBeInTheDocument();
  });

  it("展示详细步骤、本地演示媒体、风险提示与真实功能 CTA", () => {
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    expect(
      screen.getByRole("heading", { name: "开始一场高质量对话" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "跟着做" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    const video = screen.getByLabelText("对话入门演示视频");
    expect(video).toHaveAttribute("poster", "/tutorials/chat-basics.webp");
    expect(video.querySelector("source")).toHaveAttribute(
      "src",
      "/tutorials/chat-basics.webm",
    );
    expect(screen.getByText("真实界面录制 · 脱敏示例")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "回到功能位置" }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-basics" }),
    );
  });

  it("搜索功能、场景和别名后可直接切换教程", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索教程" }), {
      target: { value: "OAuth 仓库" },
    });
    fireEvent.click(screen.getByRole("button", { name: /GitHub 仓库/ }));
    expect(
      screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" }),
    ).toBeInTheDocument();
  });

  it("视频失败时显示同源截图兜底，不留下空白", () => {
    render(<Harness />);
    fireEvent.error(screen.getByLabelText("对话入门演示视频"));
    expect(
      screen.getByText("演示视频暂不可播放，已显示同一功能截图。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /输入目标并发送/ })).toHaveAttribute(
      "src",
      "/tutorials/chat-basics.webp",
    );
  });

  it("不可用动作保持教程打开并解释权限原因", () => {
    render(
      <Harness
        initial={PRODUCT_CAPABILITIES.organization.id}
        enabled={false}
      />,
    );
    expect(screen.getByText("只有组织管理员可以进入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开组织中心" })).toBeDisabled();
    expect(
      screen.getByRole("heading", { name: "组织、成员、共享额度与发票" }),
    ).toBeInTheDocument();
  });
});
