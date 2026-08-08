import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "../lib/productCapabilities";
import type { TutorialCaseId } from "../lib/tutorialCaseCatalog";
import { TutorialCenter } from "./TutorialCenter";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
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

function CaseHarness({ initial = null }: { initial?: TutorialCaseId | null }) {
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
      onClose={() => {}}
      actionState={() => ({ enabled: true, label: "回到功能位置" })}
      onRunAction={() => {}}
    />
  );
}

describe("TutorialCenter", () => {
  it("默认以真实案例为主视图，并保留旧功能索引入口", () => {
    render(<CaseHarness />);

    expect(
      screen.getByRole("heading", { name: "你今天想完成什么？" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/从公开需求和可授权材料出发/)).not.toBeInTheDocument();
    expect(screen.getByText("12 个公开、可复查的任务场景")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /论文越读越多.*从 30 篇论文到可追溯证据图谱.*每个结论都能点回原文/ })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /成果示意/ })).toHaveLength(12);
    expect(new Set(Array.from(document.querySelectorAll("[data-artwork-kind]"), (node) => node.getAttribute("data-artwork-kind"))).size).toBe(12);
    expect(screen.queryByText(/个阶段 · .*项产物/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "功能索引" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "功能索引" }));
    expect(
      screen.getByRole("heading", { name: "开始一场高质量对话" }),
    ).toBeInTheDocument();
  });

  it("案例详情公开输入、全过程和验收，但待采集轨迹不伪装成实跑", () => {
    render(<CaseHarness initial="research-bike-demand" />);

    expect(
      screen.getByRole("heading", { name: "公开数据到可复现的单车需求分析" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "成果示意：可一键重跑的单车需求分析工程" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "准备材料" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "4 步完成" })).toBeInTheDocument();
    expect(screen.getAllByText("展开输入、操作与验收标准")).toHaveLength(4);
    expect(screen.getByText(/research-assistant · deepseek-v4-pro/)).toBeInTheDocument();
    expect(screen.getByText(/待真实运行采集/)).toBeInTheDocument();
    expect(screen.queryByText("加载真实完整过程")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /UCI Bike Sharing Dataset/ })).toHaveAttribute(
      "href",
      "https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset",
    );
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
    expect(
      screen.getByRole("img", { name: /输入目标并发送/ }),
    ).toHaveAttribute("src", "/tutorials/chat-basics.webp");
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
