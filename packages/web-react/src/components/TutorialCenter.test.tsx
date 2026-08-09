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
      caseActionLabel="带着指令去对话"
      onRunCase={() => {}}
      onClose={() => {}}
      actionState={() => ({ enabled: true, label: "回到功能位置" })}
      onRunAction={() => {}}
    />
  );
}

describe("TutorialCenter", () => {
  it("默认用问题、结果和两个主案例吸引用户，并保留功能索引入口", () => {
    render(<CaseHarness />);

    expect(
      screen.getByRole("heading", { name: "看 V5 怎样把一件难事真正做完" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "不讲功能清单。直接看真实场景里的材料、过程和最后能拿走的成果。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "你的问题，也可以这样交给 V5" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "更多可直接套用的场景" }),
    ).toBeInTheDocument();
    expect(screen.getByText("科研实战 · 案例演示")).toBeInTheDocument();
    expect(screen.getByText("编码实战 · 案例演示")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /论文越读越多.*从 30 篇论文到可追溯证据图谱.*每个结论都能点回原文.*看它怎么完成/,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /案例成果预览/ })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole("img", { name: /成果示意/ })).toHaveLength(10);
    expect(
      screen.getByRole("button", {
        name: /科研实战.*分析跑完了.*公开数据到可复现的单车需求分析.*可一键重跑的单车需求分析工程.*看它怎么完成/,
      }),
    ).toBeInTheDocument();
    expect(
      new Set(
        Array.from(document.querySelectorAll("[data-artwork-kind]"), (node) =>
          node.getAttribute("data-artwork-kind"),
        ),
      ).size,
    ).toBe(12);
    for (const forbidden of [
      "实跑观察",
      "尚未公开验证",
      "真实运行重放",
      "待真实运行采集",
      "这次没有装作完美",
      "内容版本",
    ]) {
      expect(document.body.textContent).not.toContain(forbidden);
    }
    expect(
      screen.getByRole("button", { name: "功能索引" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "功能索引" }));
    expect(
      screen.getByRole("heading", { name: "开始一场高质量对话" }),
    ).toBeInTheDocument();
  });

  it("科研案例首屏先展示用户问题、最终成果和主操作，方法资料默认收起", () => {
    render(<CaseHarness initial="research-bike-demand" />);

    expect(
      screen.getByRole("heading", { name: "公开数据到可复现的单车需求分析" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("分析跑完了，换台电脑却复现不了？"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("可一键重跑的单车需求分析工程"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "带着我的材料开始" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("img", { name: /案例成果预览/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "从材料到成果，只看这三步" }),
    ).toBeInTheDocument();
    expect(screen.getByText("交给 V5")).toBeInTheDocument();
    expect(screen.getByText("看它工作")).toBeInTheDocument();
    expect(screen.getByText("拿走成果")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "这些成果会直接交到你手里" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /reproducible-project\.zip/ }),
    );
    expect(
      screen.getByRole("img", { name: /成果预览：reproducible-project\.zip/ }),
    ).toBeInTheDocument();
    const methods = screen.getByText("案例资料与方法").closest("details");
    expect(methods).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("案例资料与方法"));
    expect(methods).toHaveAttribute("open");
    expect(screen.getAllByText("0.904").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("68.36").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/非负 IAD 指标/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "准备材料" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "详细执行步骤" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/research-assistant · deepseek-v4-pro/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /UCI Bike Sharing Dataset/ }),
    ).toHaveAttribute(
      "href",
      "https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset",
    );
    for (const forbidden of [
      "实跑观察",
      "尚未公开验证",
      "真实运行重放",
      "待真实运行采集",
      "这次没有装作完美",
      "内容版本",
    ]) {
      expect(document.body.textContent).not.toContain(forbidden);
    }
  });

  it("编码案例展示补丁结果与可点击成果，同时把边界留在资料折叠区", () => {
    render(<CaseHarness initial="coding-swe-bench-fix" />);

    expect(
      screen.getByText("Bug 修好了，怎么证明没破坏正常路径？"),
    ).toBeInTheDocument();
    expect(screen.getByText("带回归测试的最小修复提交")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "带着我的材料开始" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("img", { name: /案例成果预览/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("2 → 13").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("− = 1")).toBeInTheDocument();
    expect(screen.getByText("+ = right")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /root-cause\.md/ }));
    expect(
      screen.getByRole("img", { name: /成果预览：root-cause\.md/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/没有运行官方 SWE-bench/)).toBeInTheDocument();
    expect(
      screen.getByText(/完整 diff.*漏掉了未跟踪的回归测试文件/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Astropy #12906 真实开源问题/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/astropy/astropy/issues/12906",
    );
    expect(document.body.textContent).not.toContain("尚未公开验证");
    expect(document.body.textContent).not.toContain("待真实运行采集");
  });

  it("可以用案例指标和处理证据搜索案例", () => {
    render(<CaseHarness />);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索教程" }), {
      target: { value: "15:49 right" },
    });

    expect(
      screen.getByRole("heading", {
        name: "像真实维护者一样修一个 SWE-bench Bug",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("先看完整故事")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("先看两个完整故事");
    expect(
      screen.queryByRole("heading", { name: "公开数据到可复现的单车需求分析" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /案例成果预览/ })).toHaveLength(
      1,
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
