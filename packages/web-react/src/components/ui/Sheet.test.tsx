/**
 * Sheet 原语的显式关闭钮(media 审计 M-04 / X-M3):默认不渲染,开启后走 Radix Close 与遮罩 / Esc
 * 同一条 onOpenChange(false) 路径,可访问名由 closeLabel 给。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Sheet } from "./Sheet";

afterEach(cleanup);

test("默认不渲染关闭钮;内容与 sr 标题照常", () => {
  render(
    <Sheet open onOpenChange={() => {}} srTitle="测试面板">
      <p>抽屉内容</p>
    </Sheet>,
  );
  expect(screen.getByRole("dialog", { name: "测试面板" })).toBeInTheDocument();
  expect(screen.getByText("抽屉内容")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
});

test("closeButton 开启 → 右上角关闭钮,点击回调 onOpenChange(false);closeLabel 决定可访问名", () => {
  const onOpenChange = vi.fn();
  render(
    <Sheet open onOpenChange={onOpenChange} side="bottom" closeButton closeLabel="关闭任务中心">
      <p>抽屉内容</p>
    </Sheet>,
  );
  const close = screen.getByRole("button", { name: "关闭任务中心" });
  expect(close).toHaveAttribute("title", "关闭任务中心");
  expect(close.className).toContain("absolute");
  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("closeButton 不传 closeLabel → 默认「关闭」", () => {
  render(
    <Sheet open onOpenChange={() => {}} closeButton>
      <p>抽屉内容</p>
    </Sheet>,
  );
  expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
});

test("left / bottom 抽屉具备安全区与 CSS keyframes 滑入滑出类（OCV5-817）", () => {
  const { rerender } = render(
    <Sheet open onOpenChange={() => {}} side="left" srTitle="左抽屉">
      <p>左</p>
    </Sheet>,
  );
  const leftDialog = screen.getByRole("dialog", { name: "左抽屉" });
  expect(leftDialog.className).toContain("pt-[env(safe-area-inset-top)]");
  expect(leftDialog.className).toContain("pl-[env(safe-area-inset-left)]");
  expect(leftDialog.className).toContain("data-[state=open]:oc-sheet-in-left");
  expect(leftDialog.className).toContain("data-[state=closed]:oc-sheet-out-left");

  rerender(
    <Sheet open onOpenChange={() => {}} side="bottom" srTitle="底抽屉">
      <p>底</p>
    </Sheet>,
  );
  const bottomDialog = screen.getByRole("dialog", { name: "底抽屉" });
  expect(bottomDialog.className).toContain("data-[state=open]:oc-sheet-in-bottom");
  expect(bottomDialog.className).toContain("data-[state=closed]:oc-sheet-out-bottom");
});
