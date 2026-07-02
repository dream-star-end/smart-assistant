import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { OptionsBlock } from "./RichBlocks";
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

