import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InputPrediction } from "../lib/inputCompletion";
import { Composer } from "./Composer";

afterEach(cleanup);

const prediction: InputPrediction = {
  next: { text: "把木星的卫星也加上", source: "agent" },
  candidates: ["把木星的卫星也加上", "加上木星的四颗伽利略卫星"],
};

const flushFrames = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));

// OCV5-375:助手在回答末尾写的 next 预测显示在空输入框里。不打字直接点发送就发出这句;
// Tab / → 填入后再改,Esc 收起。输入框里不再有「填入」/「Tab」标记(round 2)。
// 浅色字浮层是懒加载的(不进首屏包),出现要 findBy 等它加载。
describe("Composer 输入预测", () => {
  test("空输入框显示整句预测,占位符让位,没有「填入」/「Tab」标记;读屏通过 aria-describedby 读到", async () => {
    render(<Composer onSend={() => {}} placeholder="和「全能助手」对话…" prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    expect(await screen.findByTestId("composer-prediction")).toHaveTextContent(/^把木星的卫星也加上/);
    expect(ta).toHaveAttribute("placeholder", "");
    expect(screen.queryByRole("button", { name: "采用输入预测" })).toBeNull();
    // 浮层里只有浅色字(和读屏提示),没有按钮或小标
    const overlay = screen.getByTestId("composer-prediction");
    expect(overlay.querySelectorAll("button")).toHaveLength(0);
    expect([...overlay.querySelectorAll('[aria-hidden="true"]')].map((n) => n.textContent).join("")).toBe(
      "把木星的卫星也加上",
    );
    const hint = document.getElementById(ta.getAttribute("aria-describedby") ?? "");
    expect(hint).toHaveTextContent("输入预测：把木星的卫星也加上。直接发送就发出这句；按 Tab 填入后可以修改。");
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute("aria-describedby", hint?.id);
  });

  test("不打字直接点发送 → 发出整句预测,输入框保持空", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} prediction={prediction} />);
    await screen.findByTestId("composer-prediction");
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute("title", "发送这句预测");
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("把木星的卫星也加上", undefined, undefined);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("");
    // 发出后这句立即作废:父层还没换掉 prediction 时连点也不会再发一次(Codex r1 P1)
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("空输入框按 Enter 不发预测(防误发,要先 Tab 填入)", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} prediction={prediction} />);
    await screen.findByTestId("composer-prediction");
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("打字后点发送只发自己打的字,不带补全", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.change(ta, { target: { value: "加上", selectionStart: 2, selectionEnd: 2 } });
    expect(await screen.findByTestId("composer-prediction")).toHaveTextContent("木星的四颗伽利略卫星");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("加上", undefined, undefined);
  });

  test("Esc 收起后发送按钮回到不可用;带引用时不显示整句预测", async () => {
    const onSend = vi.fn();
    const { unmount } = render(<Composer onSend={onSend} prediction={prediction} />);
    await screen.findByTestId("composer-prediction");
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    unmount();

    render(
      <Composer
        onSend={onSend}
        prediction={prediction}
        replyTo={{ messageId: "m1", role: "assistant", text: "上一条回答" }}
        onCancelReply={() => {}}
      />,
    );
    await flushFrames();
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  test("Tab 填入:填进输入框但不发送;再按 Enter 才发送", async () => {
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

  test("→ 也能填入", () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "ArrowRight" });
    expect(ta.value).toBe("把木星的卫星也加上");
  });

  test("打字时按候选补全剩下的部分", async () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "加上", selectionStart: 2, selectionEnd: 2 } });
    expect(await screen.findByTestId("composer-prediction")).toHaveTextContent("木星的四颗伽利略卫星");
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(ta.value).toBe("加上木星的四颗伽利略卫星");
  });

  test("Esc 收起本条预测;没有预测时 Tab 不拦截(焦点照常移动)", async () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    await screen.findByTestId("composer-prediction");
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("生成中、禁用、输入法组字中、没给 prediction 时都不显示", async () => {
    const { rerender } = render(<Composer onSend={() => {}} prediction={prediction} busy />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={prediction} disabled />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={null} />);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    rerender(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    await screen.findByTestId("composer-prediction");
    fireEvent.compositionStart(ta);
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    fireEvent.compositionEnd(ta);
    expect(screen.getByTestId("composer-prediction")).toBeInTheDocument();
  });

  // 线上白屏(React #185,round 2):浮层每次渲染都在 layout effect 里调 onShown → Composer setState。
  // 回答结束、预测显示着时页面空闲也会被计时器约 0.7 秒重渲一次,这些白排的同步更新被 React 记成嵌套更新,
  // 约 35–50 秒累计到 50 次就整页白屏。jsdom 里 React 的这种累计复现不出来,所以直接卡住机制:
  // 输入没变时重渲不能再报;Composer 收到相同的报告也不能 setState。
  test("浮层只在内容变化时报告,父层重渲不再触发报告(#185)", async () => {
    const { default: ComposerPrediction } = await import("./ComposerPrediction");
    const onShown = vi.fn();
    const el = (rest: string, value = "") => (
      <ComposerPrediction value={value} rest={rest} large={false} hintId="h" onShown={onShown} />
    );
    const { rerender } = render(el("把木星的卫星也加上"));
    expect(onShown).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) rerender(el("把木星的卫星也加上"));
    expect(onShown).toHaveBeenCalledTimes(1);
    rerender(el("另一句"));
    expect(onShown).toHaveBeenCalledTimes(2);
    expect(onShown).toHaveBeenLastCalledWith("另一句", expect.any(Number));
  });

  test("生成中(busy)不显示上一轮的整句预测,发送按钮是「停止」", async () => {
    render(<Composer onSend={() => {}} onStop={() => {}} prediction={prediction} busy />);
    await flushFrames();
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  test("Shift+Tab 等带修饰键的 Tab 不采用", () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    expect(ta.value).toBe("");
  });
});

// OCV5-642:体验官「输入框残留上一轮草稿，Backspace 清不掉」。框里那句恰好也是补全候选:每删一个字,
// 浅色补全就把删掉的尾巴补回来,整句看着纹丝不动;删空后又冒出浅色整句预测。
describe("Composer 删除时不叠预测(OCV5-642)", () => {
  const backspaceTo = (ta: HTMLElement, value: string) =>
    fireEvent.input(ta, { target: { value, selectionStart: value.length, selectionEnd: value.length }, inputType: "deleteContentBackward" });

  test("按 Backspace 删字后不再把删掉的尾巴用浅色补回来;再打字补全照常", async () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "加上木星", selectionStart: 4, selectionEnd: 4 } });
    expect(await screen.findByTestId("composer-prediction")).toHaveTextContent("的四颗伽利略卫星");
    backspaceTo(ta, "加上木");
    expect(ta.value).toBe("加上木");
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    backspaceTo(ta, "");
    // 删空了也不冒整句预测:用户刚把框清掉。
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    expect(ta).toHaveAttribute("placeholder");
    fireEvent.input(ta, { target: { value: "加上", selectionStart: 2, selectionEnd: 2 }, inputType: "insertText" });
    expect(await screen.findByTestId("composer-prediction")).toHaveTextContent("木星的四颗伽利略卫星");
  });

  test("空输入框按 Backspace 收起浅色整句预测(和 Esc 一样)", async () => {
    render(<Composer onSend={() => {}} prediction={prediction} />);
    const ta = screen.getByLabelText("消息输入框");
    await screen.findByTestId("composer-prediction");
    fireEvent.keyDown(ta, { key: "Backspace" });
    expect(screen.queryByTestId("composer-prediction")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  test("同一个预填只盖一次:输入框卸载重挂(切到项目主页再回来)不会把删掉的旧文字再填回去", async () => {
    const prefill = { text: "上一轮要编辑重发的那句", nonce: 1 };
    const first = render(<Composer onSend={() => {}} prefill={prefill} />);
    const ta = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    expect(ta.value).toBe("上一轮要编辑重发的那句");
    fireEvent.change(ta, { target: { value: "" } });
    first.unmount();
    render(<Composer onSend={() => {}} prefill={prefill} />);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("");
    cleanup();
    // 新的预填(新对象)照常生效。
    render(<Composer onSend={() => {}} prefill={{ text: "新的预填", nonce: 2 }} />);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("新的预填");
  });
});
