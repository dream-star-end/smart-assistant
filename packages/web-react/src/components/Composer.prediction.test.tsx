import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InputPrediction } from "../lib/inputPrediction";
import { Composer } from "./Composer";

afterEach(cleanup);

const prediction: InputPrediction = {
  next: { text: "把木星的卫星也加上", source: "agent" },
  candidates: ["把木星的卫星也加上", "加上木星的四颗伽利略卫星"],
};

const flushFrames = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));

// OCV5-375:助手在回答末尾写的 next 预测显示在空输入框里,Tab / → / 「Tab」按钮采用,Esc 收起。
describe("Composer 输入预测", () => {
  test("空输入框显示整句预测,占位符让位;读屏通过 aria-describedby 读到", () => {
    render(<Composer onSend={() => {}} placeholder="和「全能助手」对话…" prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    expect(screen.getByTestId("composer-prediction")).toHaveTextContent("把木星的卫星也加上");
    expect(ta).toHaveAttribute("placeholder", "");
    const hint = document.getElementById(ta.getAttribute("aria-describedby") ?? "");
    expect(hint).toHaveTextContent("输入预测：把木星的卫星也加上。按 Tab 采用。");
  });

  test("Tab 采用:填进输入框但不发送;再按 Enter 才发送", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(ta.value).toBe("把木星的卫星也加上");
    expect(onSend).not.toHaveBeenCalled();
    await flushFrames();
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("把木星的卫星也加上", undefined, undefined);
  });

  test("→ 也能采用;点「Tab」按钮(触屏是「填入」)也能采用", () => {
    const { unmount } = render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "ArrowRight" });
    expect(ta.value).toBe("把木星的卫星也加上");
    unmount();

    render(<Composer onSend={() => {}} prediction={prediction} />);
    fireEvent.click(screen.getByRole("button", { name: "采用输入预测" }));
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("把木星的卫星也加上");
  });

  test("打字时按候选补全剩下的部分", () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "加上", selectionStart: 2, selectionEnd: 2 } });
    expect(screen.getByTestId("composer-prediction")).toHaveTextContent("木星的四颗伽利略卫星");
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(ta.value).toBe("加上木星的四颗伽利略卫星");
  });

  test("Esc 收起本条预测;没有预测时 Tab 不拦截(焦点照常移动)", () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("生成中、禁用、输入法组字中、没给 prediction 时都不显示", () => {
    const { rerender } = render(<Composer onSend={() => {}} prediction={prediction} busy />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={prediction} disabled />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={null} />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.compositionStart(ta);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    fireEvent.compositionEnd(ta);
    expect(screen.getByTestId("composer-prediction")).toBeInTheDocument();
  });

  test("Shift+Tab 等带修饰键的 Tab 不采用", () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    expect(ta.value).toBe("");
  });
});
