import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { OptionsBlock } from "./RichBlocks";
import { ChatInteractionContext } from "./tool/context";

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
