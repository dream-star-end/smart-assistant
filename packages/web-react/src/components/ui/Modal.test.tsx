import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("F4 Modal 最大高度 dvh 收口", () => {
  test("内容节带 max-h-[88dvh]（收口移动端动态工具栏；桌面 dvh≡vh 零回退）", () => {
    render(
      <Modal open onOpenChange={() => {}} srTitle="测试对话框">
        <p>hi</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("max-h-[88dvh]");
    // cn(tailwind-merge)会把同属性折叠为最后一个：不得再遗留 max-h-[88vh]（否则说明双类未被折叠、
    // 反成隐患）。dvh 是唯一 max-h 权威。
    expect(dialog.className).not.toContain("max-h-[88vh]");
  });

  test("调用方 className 的 max-h 仍能覆盖（共享组件不破坏既有 override 用法）", () => {
    render(
      <Modal open onOpenChange={() => {}} srTitle="测试对话框" className="max-h-[56rem] max-w-md">
        <p>hi</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    // 调用方 max-h 后置覆盖，默认 88dvh 被让位（对齐 SessionViewerModal 等既有 override）。
    expect(dialog).toHaveClass("max-h-[56rem]", "max-w-md");
    expect(dialog.className).not.toContain("max-h-[88dvh]");
  });

  test("mobile=fullscreen 绑定 visualViewport 变量与安全区（OCV5-817）", () => {
    render(
      <Modal open onOpenChange={() => {}} mobile="fullscreen" srTitle="全屏弹层">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "全屏弹层" });
    expect(dialog.className).toContain("top-[var(--oc-visual-offset-top,0px)]");
    expect(dialog.className).toContain("h-[var(--oc-visual-height,100dvh)]");
    expect(dialog.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(dialog.className).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  test("接入微焦距进退场与遮罩柔淡退场动画类（OCV5-838）", () => {
    render(
      <Modal open onOpenChange={() => {}} srTitle="动效弹层">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "动效弹层" });
    expect(dialog.className).toContain("data-[state=open]:oc-dialog-in");
    expect(dialog.className).toContain("data-[state=closed]:oc-dialog-out");
    const overlay = document.querySelector(".bg-black\\/40");
    expect(overlay?.className).toContain("data-[state=open]:oc-backdrop-in");
    expect(overlay?.className).toContain("data-[state=closed]:oc-backdrop-out");
  });
});

function StackedModalsHarness({ initialTopOpen = false }: { initialTopOpen?: boolean }) {
  const [baseOpen, setBaseOpen] = useState(true);
  const [topOpen, setTopOpen] = useState(initialTopOpen);
  return (
    <>
      <Modal open={baseOpen} onOpenChange={setBaseOpen} title="设置">
        <button type="button" onClick={() => setTopOpen(true)}>
          打开订阅
        </button>
      </Modal>
      <Modal open={topOpen} onOpenChange={setTopOpen} title="套餐订阅">
        <p>订阅详情</p>
      </Modal>
    </>
  );
}

async function openStackedTop() {
  await flushRadixTimers();
  const btn = screen.getByRole("button", { name: "打开订阅" });
  await act(async () => {
    fireEvent.click(btn);
  });
  await flushRadixTimers();
}

async function flushRadixTimers() {
  await act(async () => {
    await new Promise((r) => window.setTimeout(r, 20));
  });
}

function realClick(target: Element) {
  // 真实浏览器中 React 19 在 document.body（Portal 根）上对离散 click 同步 flush，
  // 顶层 Modal 会在 click 冒泡到 document 之前就被卸载。TestingLibrary 的 fireEvent
  // 外层包了 act()，会人为推迟 React flush 到事件冒泡结束之后，掩盖这一真实竞态。
  // 这里用原生 dispatchEvent 复现真实浏览器的事件冒泡与同步提交顺序。
  const PointerCtor = typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
  target.dispatchEvent(new PointerCtor("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new PointerCtor("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("多层叠开 Modal 关闭顶层不级联关闭底层（OCV5-845）", () => {
  test("点顶层 Modal 关闭按钮只关闭顶层，底层 Modal 保持打开且随后可正常关闭", async () => {
    render(<StackedModalsHarness />);
    await openStackedTop();

    const subDialog = screen.getByRole("dialog", { name: "套餐订阅" });
    const closeSub = within(subDialog).getByRole("button", { name: "关闭" });

    // 分步派发（不把整个指针序列裹进单个 act），贴近真实浏览器里 pointerdown → click 独立事件循环。
    realClick(closeSub);
    await flushRadixTimers();

    expect(screen.queryByRole("dialog", { name: "套餐订阅" })).toBeNull();
    const settingsDialog = screen.getByRole("dialog", { name: "设置" });
    expect(settingsDialog).toBeInTheDocument();

    const closeSettings = within(settingsDialog).getByRole("button", { name: "关闭" });
    realClick(closeSettings);
    await flushRadixTimers();
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });

  test("点顶层 Modal 遮罩只关闭顶层，底层 Modal 保持打开且随后点底层遮罩可关闭", async () => {
    render(<StackedModalsHarness />);
    await openStackedTop();

    const overlays = document.querySelectorAll(".bg-black\\/40");
    expect(overlays.length).toBe(2);
    const topOverlay = overlays[overlays.length - 1];

    realClick(topOverlay);
    await flushRadixTimers();

    expect(screen.queryByRole("dialog", { name: "套餐订阅" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();

    const baseOverlay = document.querySelector(".bg-black\\/40");
    expect(baseOverlay).toBeTruthy();
    if (baseOverlay) realClick(baseOverlay);
    await flushRadixTimers();
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });

  test("按 Escape 只关闭顶层 Modal，底层保持打开，再按一次才关闭底层", async () => {
    render(<StackedModalsHarness />);
    await openStackedTop();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await flushRadixTimers();

    expect(screen.queryByRole("dialog", { name: "套餐订阅" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await flushRadixTimers();
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });
});
