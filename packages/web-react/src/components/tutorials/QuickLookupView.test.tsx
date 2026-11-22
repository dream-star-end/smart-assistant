import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_CAPABILITY_LIST } from "../../lib/productCapabilities";
import { QuickLookupView } from "./QuickLookupView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QuickLookupView", () => {
  it("未搜索且未选 topic 时展示高频速查板：命令与快捷键（无 /compact）、高频能力直达与全部 26 项能力索引", () => {
    const onSelectTopic = vi.fn();
    const onOpenGuide = vi.fn();

    render(
      <QuickLookupView
        topicId={null}
        onSelectTopic={onSelectTopic}
        onOpenGuide={onOpenGuide}
      />,
    );

    const searchInput = screen.getByRole("searchbox", { name: "搜索功能、命令或场景" });
    expect(searchInput).toHaveClass("text-base");
    expect(searchInput).toHaveClass("md:text-body");

    // 常用命令与快捷键卡
    expect(screen.getByText("/btw")).toBeInTheDocument();
    expect(screen.getByText("/ask")).toBeInTheDocument();
    expect(screen.getByText("/swarm")).toBeInTheDocument();
    expect(screen.getByText("⌘/Ctrl+K")).toBeInTheDocument();
    expect(screen.getByText("⌥/Alt+S")).toBeInTheDocument();
    expect(screen.getByText("⌘/Ctrl+\\")).toBeInTheDocument();
    // 宪章 3.1 红线：绝不允许 /compact
    expect(document.body.textContent).not.toContain("/compact");

    // 全部 26 项能力全覆盖
    expect(PRODUCT_CAPABILITY_LIST).toHaveLength(26);
    expect(screen.getByText(/共 26 项能力/)).toBeInTheDocument();
    for (const feature of PRODUCT_CAPABILITY_LIST) {
      expect(screen.getAllByText(feature.shortTitle).length).toBeGreaterThanOrEqual(1);
    }

    // 点击高频直达能力进入详情
    fireEvent.click(screen.getAllByRole("button", { name: /模型与思考/ })[0]);
    expect(onSelectTopic).toHaveBeenCalledWith("models-reasoning");

    // 底部跳转实战指南
    fireEvent.click(screen.getByRole("button", { name: "去看实战指南" }));
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
  });

  it("支持口语词、命令词与场景词即时检索并一键打开对应能力", () => {
    const onSelectTopic = vi.fn();
    render(<QuickLookupView topicId={null} onSelectTopic={onSelectTopic} />);

    const searchInput = screen.getByRole("searchbox", { name: "搜索功能、命令或场景" });

    fireEvent.change(searchInput, { target: { value: "/btw" } });
    expect(screen.getByText("支线快问，不打断主线")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "建站" } });
    expect(screen.getByText("容器网页预览")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "审批" } });
    expect(screen.getByText("任务面板")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /任务面板/ }));
    expect(onSelectTopic).toHaveBeenCalledWith("taskboard");
    expect(searchInput).toHaveValue("");

    // 无命中兜底
    fireEvent.change(searchInput, { target: { value: "完全不存在的关键词xyz" } });
    expect(screen.getByText(/没有找到与「完全不存在的关键词xyz」匹配的命令或功能/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置搜索" }));
    expect(searchInput).toHaveValue("");
  });

  it("选中 topic 时保留核心契约：h2 标题、step 深链标记与焦点、无原生 select、视频出错自动降级 poster、真实 CTA 与不可用原因", async () => {
    const onSelectTopic = vi.fn();
    const onRunAction = vi.fn();

    const { rerender } = render(
      <QuickLookupView
        topicId="chat-basics"
        stepNumber={3}
        onSelectTopic={onSelectTopic}
        onRunAction={onRunAction}
        actionState={() => ({ available: true, label: "回到功能位置" })}
      />,
    );

    // 严禁原生 <select>
    expect(document.querySelector("select")).toBeNull();
    // 标题为 h2 且精确匹配 feature.title
    expect(
      screen.getByRole("heading", { level: 2, name: "开始一场高质量对话" }),
    ).toBeInTheDocument();

    // 步骤契约：id / data-tutorial-step / aria-current="step" / 自动落焦点
    const steps = screen
      .getAllByRole("listitem")
      .filter((li) => li.hasAttribute("data-tutorial-step"));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const step3 = steps.find((li) => li.getAttribute("data-tutorial-step") === "3");
    expect(step3).toBeDefined();
    expect(step3).toHaveAttribute("id", "tutorial-step-3");
    expect(step3).toHaveAttribute("aria-current", "step");
    await waitFor(() => expect(document.activeElement).toBe(step3));

    // 默认收为 poster 轻封面，按需点播；播放失败自动降级展示 poster 截图说明
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "播放界面演示" }));
    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    fireEvent.error(video!);
    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByText("演示视频暂不可播放，已显示同一功能截图。")).toBeInTheDocument();

    // 真实功能 CTA 回调与文案
    const cta = screen.getByRole("button", { name: "回到功能位置" });
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    expect(onRunAction).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "chat-basics" }),
    );

    // 返回速查板
    fireEvent.click(screen.getAllByRole("button", { name: "返回速查板" })[0]);
    expect(onSelectTopic).toHaveBeenCalledWith(null);

    // 切换到 feedback-support + 越界 stepNumber + 不可用状态 reason 展示
    rerender(
      <QuickLookupView
        topicId="feedback-support"
        stepNumber={99}
        onSelectTopic={onSelectTopic}
        onRunAction={onRunAction}
        actionState={() => ({
          available: false,
          reason: "登录后即可进入这个功能。",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "提交问题、建议与体验反馈" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    // 未传 label 时自动兜底「打开设置」
    const disabledCta = screen.getByRole("button", { name: "打开设置" });
    expect(disabledCta).toBeDisabled();
    expect(screen.getByText("登录后即可进入这个功能。")).toBeInTheDocument();
  });
});
