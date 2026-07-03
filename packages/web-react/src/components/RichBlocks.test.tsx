import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { HtmlPreview, OptionsBlock } from "./RichBlocks";
import { ChatInteractionContext } from "./tool/context";
import { OptionsGroupFooter, OptionsGroupProvider } from "./optionsGroup";

const single = JSON.stringify({
  question: "选一个部署方式?",
  options: [
    { label: "灰度发布", desc: "先小流量" },
    { label: "全量发布" },
  ],
});

afterEach(cleanup);

describe("OptionsBlock", () => {
  it("renders question + option cards and sends on single-select click", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText("选一个部署方式?")).toBeTruthy();
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度发布");
    // 已发送后锁定,不能再点
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/已选择:灰度发布/)).toBeTruthy();
  });

  it("multi-select requires confirm and joins labels", () => {
    const sendUserText = vi.fn();
    const code = JSON.stringify({
      question: "要哪些能力?",
      multi: true,
      options: [{ label: "浏览器" }, { label: "研究检索" }, { label: "网页提取" }],
    });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("浏览器"));
    fireEvent.click(screen.getByText("网页提取"));
    fireEvent.click(screen.getByText(/确认选择/));
    expect(sendUserText).toHaveBeenCalledWith("我选择:浏览器、网页提取");
  });

  it("falls back to source on invalid/partial JSON and to display-only without provider", () => {
    const { container } = render(<OptionsBlock code={'{"question":"半截'} />);
    expect(container.querySelector("pre")).toBeTruthy();
    render(<OptionsBlock code={single} />);
    expect(screen.getByText(/此会话中不可交互/)).toBeTruthy();
  });

  it("busy disables clicking", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).not.toHaveBeenCalled();
  });
});

describe("OptionsBlock in a multi-question message (group mode)", () => {
  const q1 = JSON.stringify({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] });
  const q2 = JSON.stringify({ question: "输出?", multi: true, options: [{ label: "要点" }, { label: "全文" }] });

  it("does NOT send on first click; aggregates and sends via footer after all answered", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={q1} />
          <OptionsBlock code={q2} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    // 点第一题不发送(boss 踩坑场景)
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByText(/已作答/).textContent).toContain("1");
    // 发送按钮在答完前禁用
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    // 答第二题(多选)后可发
    fireEvent.click(screen.getByText("要点"));
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sentText = sendUserText.mock.calls[0][0] as string;
    expect(sentText).toContain("风格?:正式");
    expect(sentText).toContain("输出?:要点");
    // 发送后锁定
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
  });

  it("single block inside a group keeps click-to-send", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={q1} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("轻松"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:轻松");
  });
});

describe("HtmlPreview streaming throttle (anti-flicker)", () => {
  const html = "<h1>hi</h1>";

  it("renders the iframe immediately (first frame) even while streaming", () => {
    const { container } = render(<HtmlPreview code={html} live />);
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("srcdoc")).toBe(html);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByText(/预览\(生成中\)/)).toBeTruthy();
  });

  it("mounts the iframe with final srcDoc when not live", () => {
    const { container } = render(<HtmlPreview code={html} />);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).toBe(html);
    expect(screen.getByText(/预览\(沙盒\)/)).toBeTruthy();
  });

  it("throttles srcDoc updates while streaming (delta within window not reflected until interval fires)", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<HtmlPreview code="<p>A</p>" live />);
      const srcdoc = () => container.querySelector("iframe")?.getAttribute("srcdoc");
      expect(srcdoc()).toBe("<p>A</p>"); // 首帧立即显示
      // 流式来了新 delta,但未到节流窗口 → iframe 仍是旧帧(不逐 token 重载)
      rerender(<HtmlPreview code="<p>AB</p>" live />);
      expect(srcdoc()).toBe("<p>A</p>");
      // 越过节流窗口后,提交最新代码
      act(() => vi.advanceTimersByTime(800));
      expect(srcdoc()).toBe("<p>AB</p>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-live callers (no live signal) sync every code update immediately — no throttle, no freeze", () => {
    // 回归:子 agent / 静态调用方不传 live,code prop 变化必须立即反映,不能卡在首帧。
    const { container, rerender } = render(<HtmlPreview code="<p>A</p>" />);
    rerender(<HtmlPreview code="<p>AB</p>" />);
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toBe("<p>AB</p>");
  });

  it("commits the final code immediately when streaming ends (live → false)", () => {
    const { container, rerender } = render(<HtmlPreview code="<p>partial</p>" live />);
    rerender(<HtmlPreview code="<p>final</p>" />); // live 撤销:立即提交最终帧
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toBe("<p>final</p>");
  });

  it("source view shows the latest (un-throttled) code while streaming", () => {
    const { container } = render(<HtmlPreview code={html} live />);
    fireEvent.click(screen.getByText("看源码"));
    expect(container.querySelector("pre")?.textContent).toContain(html);
  });
});

