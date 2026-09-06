// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStickToBottomController } from "./stickToBottom";
import { attachWheelFence } from "./wheelFence";

function fire(el: HTMLElement, type: string) {
  el.dispatchEvent(new Event(type));
}

describe("wheelFence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("scrollend 提前释放时不留孤儿 timer：detach 后重接线，旧回调不能提前清掉新篱笆", () => {
    const stick = createStickToBottomController();
    const el = document.createElement("div");
    const now = () => Date.now();

    const detach1 = attachWheelFence(el, stick, { quietMs: 200, now });
    fire(el, "wheel");
    expect(stick.wheelFence.current).toBe(true);
    // 静默 200ms 后 scrollend 到达 → tryEnd 直接释放。旧实现在这里只把 timer
    // 句柄置 null，setTimeout 仍排队。
    vi.advanceTimersByTime(150);
    fire(el, "scroll");
    vi.advanceTimersByTime(60);
    fire(el, "scrollend");
    // 输入静默已满 200ms，scrollEnded=true → 立即释放
    expect(stick.wheelFence.current).toBe(false);
    detach1();

    // 同一 controller 重新挂上篱笆，用户立刻开始新的滚轮序列
    const detach2 = attachWheelFence(el, stick, { quietMs: 200, now });
    fire(el, "wheel");
    expect(stick.wheelFence.current).toBe(true);
    // 旧闭包遗留的 timer（t=350）会用它自己的 lastInputAt=0 / scrollEnded=true
    // 判定"可释放"，把新篱笆提前 end 掉；新输入到此只静默了 150ms，必须仍在篱笆内。
    vi.advanceTimersByTime(150);
    expect(stick.wheelFence.current).toBe(true);
    vi.advanceTimersByTime(60);
    expect(stick.wheelFence.current).toBe(false);
    detach2();
  });

  test("连续滚轮 tick 之间的 scrollend 不释放；最后一次输入静默 quietMs 后才释放", () => {
    const stick = createStickToBottomController();
    const el = document.createElement("div");
    attachWheelFence(el, stick, { quietMs: 200, now: () => Date.now() });

    fire(el, "wheel");
    vi.advanceTimersByTime(50);
    fire(el, "scroll");
    vi.advanceTimersByTime(60);
    fire(el, "scrollend"); // Chromium 在离散 tick 间发 scrollend
    expect(stick.wheelFence.current).toBe(true);
    fire(el, "wheel");
    vi.advanceTimersByTime(199);
    expect(stick.wheelFence.current).toBe(true);
    vi.advanceTimersByTime(2);
    expect(stick.wheelFence.current).toBe(false);
  });

  test("Safari 无 scrollend：滚动事件静默 quietMs 后释放", () => {
    const stick = createStickToBottomController();
    const el = document.createElement("div");
    attachWheelFence(el, stick, { quietMs: 200, now: () => Date.now() });

    fire(el, "wheel");
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(100);
      fire(el, "scroll");
    }
    expect(stick.wheelFence.current).toBe(true);
    vi.advanceTimersByTime(199);
    expect(stick.wheelFence.current).toBe(true);
    vi.advanceTimersByTime(2);
    expect(stick.wheelFence.current).toBe(false);
  });

  test("detach 释放篱笆并移除监听", () => {
    const stick = createStickToBottomController();
    const el = document.createElement("div");
    const detach = attachWheelFence(el, stick, { quietMs: 200, now: () => Date.now() });
    fire(el, "wheel");
    expect(stick.wheelFence.current).toBe(true);
    detach();
    expect(stick.wheelFence.current).toBe(false);
    fire(el, "wheel");
    expect(stick.wheelFence.current).toBe(false);
  });
});
