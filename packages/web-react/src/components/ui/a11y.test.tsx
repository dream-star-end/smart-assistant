import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealFocusedElement, useScrollBodyTabbable } from "./a11y";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rect(top: number, bottom: number, left = 0, right = 100): DOMRect {
  return { top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect;
}

describe("revealFocusedElement(弹层 Tab 回绕后焦点滚回可视区,a11y shell#8)", () => {
  function setup(targetRect: DOMRect) {
    const container = document.createElement("div");
    const target = document.createElement("button");
    container.appendChild(target);
    document.body.appendChild(container);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 400));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(targetRect);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView as unknown as HTMLElement["scrollIntoView"];
    const event = { target, currentTarget: container } as unknown as React.FocusEvent<HTMLElement>;
    return { event, scrollIntoView, cleanup: () => container.remove() };
  }

  it("目标滚出容器可视区(如 header 按钮 rect.y < 0)时按 nearest 滚回", () => {
    const { event, scrollIntoView, cleanup: done } = setup(rect(-432, -400));
    revealFocusedElement(event);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    done();
  });

  it("目标已在可视区内时不滚动(不引起列表跳动)", () => {
    const { event, scrollIntoView, cleanup: done } = setup(rect(120, 152));
    revealFocusedElement(event);
    expect(scrollIntoView).not.toHaveBeenCalled();
    done();
  });
});

function Probe({ open, children }: { open: boolean; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const tabbable = useScrollBodyTabbable(ref, open);
  return (
    <div ref={ref} data-testid="body" tabIndex={tabbable ? 0 : undefined}>
      {children}
    </div>
  );
}

function fakeOverflow(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
}

describe("useScrollBodyTabbable(纯文本长内容的滚动正文可键盘聚焦,a11y shell#7)", () => {
  it("溢出且没有可聚焦子孙 → tabIndex=0;放进一个按钮后自动撤掉(不多占 Tab 停靠点)", async () => {
    const { getByTestId, rerender } = render(
      <Probe open>
        <p>很长的协议正文</p>
      </Probe>,
    );
    const body = getByTestId("body");
    fakeOverflow(body, 2500, 600);
    // 触发一次内容变化让观察者重算(jsdom 没有 ResizeObserver,靠 MutationObserver)。
    await act(async () => {
      body.appendChild(document.createElement("span"));
      await Promise.resolve();
    });
    expect(body.getAttribute("tabindex")).toBe("0");
    rerender(
      <Probe open>
        <p>很长的协议正文</p>
        <button type="button">同意</button>
      </Probe>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(body.getAttribute("tabindex")).toBeNull();
  });

  it("不溢出的正文不进 Tab 序", async () => {
    const { getByTestId } = render(
      <Probe open>
        <p>一句话</p>
      </Probe>,
    );
    const body = getByTestId("body");
    fakeOverflow(body, 200, 600);
    await act(async () => {
      body.appendChild(document.createElement("span"));
      await Promise.resolve();
    });
    expect(body.getAttribute("tabindex")).toBeNull();
  });
});
