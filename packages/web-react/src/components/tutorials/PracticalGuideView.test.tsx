import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUIDE_BASICS_STORAGE_KEY,
  PRACTICAL_GUIDE_SCENARIOS,
} from "./practicalGuideData";
import { PracticalGuideView } from "./PracticalGuideView";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PracticalGuideView", () => {
  it("渲染「4 件事，马上用顺手」并持久化折叠状态到 localStorage", () => {
    const { unmount } = render(<PracticalGuideView onTryScenario={() => {}} />);

    expect(screen.getByRole("heading", { name: "4 件事，马上用顺手" })).toBeInTheDocument();
    expect(screen.getByText("左聊右看，直接批注")).toBeInTheDocument();
    expect(screen.getByText("按活选模型，大活开蜂群")).toBeInTheDocument();
    expect(screen.getByText("拖文件、建项目、设定时")).toBeInTheDocument();
    expect(screen.getByText("关键动作会等你拍板")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "收起" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);

    expect(localStorage.getItem(GUIDE_BASICS_STORAGE_KEY)).toBe("1");
    expect(screen.queryByText("左聊右看，直接批注")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    unmount();

    // 重新挂载时保持折叠态
    render(<PracticalGuideView onTryScenario={() => {}} />);
    expect(screen.queryByText("左聊右看，直接批注")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("展示 8 张高频实战场景卡，支持 5 档分类胶囊筛选且绝不出现 /compact", () => {
    render(<PracticalGuideView onTryScenario={() => {}} />);

    expect(PRACTICAL_GUIDE_SCENARIOS).toHaveLength(8);
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(8);
    expect(document.body.textContent).not.toContain("/compact");

    fireEvent.click(screen.getByRole("button", { name: "科研" }));
    expect(screen.getByRole("button", { name: "科研" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "科研读论文与写综述" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "表格与公开数据分析" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编程" }));
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: "代码开发、修 Bug 与 PR 审查" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "多线并行：蜂群分工 + /btw 快问" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "办公交付" }));
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "建站与自动" }));
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(document.querySelectorAll("article[data-scenario-id]")).toHaveLength(8);
  });

  it("主按钮随登录态与 actionLabel 变化，展开后支持编辑开工指令、一键复制并带入修改后指令", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const onTryScenario = vi.fn();
    const onOpenTopic = vi.fn();
    const onOpenQuickLookup = vi.fn();

    const { rerender } = render(
      <PracticalGuideView
        authenticated={false}
        onTryScenario={onTryScenario}
        onOpenTopic={onOpenTopic}
        onOpenQuickLookup={onOpenQuickLookup}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "登录后带入对话" }),
    ).toHaveLength(8);

    rerender(
      <PracticalGuideView
        authenticated
        onTryScenario={onTryScenario}
        onOpenTopic={onOpenTopic}
        onOpenQuickLookup={onOpenQuickLookup}
      />,
    );

    const firstCard = document.querySelector<HTMLElement>(
      'article[data-scenario-id="research-paper-review"]',
    );
    expect(firstCard).not.toBeNull();
    const cardScope = within(firstCard!);

    fireEvent.click(cardScope.getByRole("button", { name: /看指令与要点/ }));

    const textarea = cardScope.getByLabelText("开工指令（可直接修改后带入）");
    expect(textarea).toHaveClass("text-base");
    expect(textarea).toHaveClass("md:text-body");
    expect(cardScope.getAllByRole("listitem")).toHaveLength(3);

    fireEvent.change(textarea, { target: { value: "请按时间线对比这 3 篇多模态论文并标注页码。" } });

    fireEvent.click(cardScope.getByRole("button", { name: "复制指令" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("请按时间线对比这 3 篇多模态论文并标注页码。"),
    );
    expect(cardScope.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    fireEvent.click(cardScope.getByRole("button", { name: "带入对话直接试" }));
    expect(onTryScenario).toHaveBeenCalledWith({
      id: "research-paper-review",
      title: "科研读论文与写综述",
      prompt: "请按时间线对比这 3 篇多模态论文并标注页码。",
    });

    fireEvent.click(cardScope.getByRole("button", { name: "联网与研究" }));
    expect(onOpenTopic).toHaveBeenCalledWith("web-research");

    fireEvent.click(screen.getByRole("button", { name: "打开功能速查" }));
    expect(onOpenQuickLookup).toHaveBeenCalledTimes(1);

    rerender(
      <PracticalGuideView
        actionLabel="立即试用该模板"
        onTryScenario={onTryScenario}
      />,
    );
    expect(screen.getAllByRole("button", { name: "立即试用该模板" })).toHaveLength(8);
  });

  it("商业版关闭 taskboardEnabled 时隐藏实战场景卡中的任务面板相关能力入口", () => {
    const onOpenTopic = vi.fn();
    const { rerender } = render(
      <PracticalGuideView
        taskboardEnabled
        onTryScenario={() => {}}
        onOpenTopic={onOpenTopic}
      />,
    );

    const swarmCard = document.querySelector<HTMLElement>(
      'article[data-scenario-id="swarm-parallel-btw"]',
    );
    expect(swarmCard).not.toBeNull();
    const scope = within(swarmCard!);
    fireEvent.click(scope.getByRole("button", { name: /看指令与要点/ }));
    expect(scope.getByRole("button", { name: "任务面板" })).toBeInTheDocument();

    rerender(
      <PracticalGuideView
        taskboardEnabled={false}
        onTryScenario={() => {}}
        onOpenTopic={onOpenTopic}
      />,
    );
    expect(scope.queryByRole("button", { name: "任务面板" })).not.toBeInTheDocument();
    expect(scope.getByRole("button", { name: "团队模式" })).toBeInTheDocument();
    expect(scope.getByRole("button", { name: "模型与思考" })).toBeInTheDocument();
  });
});
