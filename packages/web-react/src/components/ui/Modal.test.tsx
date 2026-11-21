import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
