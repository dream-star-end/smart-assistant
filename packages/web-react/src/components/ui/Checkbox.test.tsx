import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Checkbox } from "./Checkbox";

afterEach(cleanup);

describe("Checkbox 原语(market K-27)", () => {
  test("label 即可访问名称;点文字切换,onChange 收到新值", () => {
    const onChange = vi.fn();
    render(<Checkbox label="全选" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "全选" });
    expect(box).not.toBeChecked();
    expect(box).toHaveAttribute("data-ui", "checkbox");
    fireEvent.click(screen.getByText("全选"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(box).toBeChecked();
  });

  test("无文字时可访问名称来自 aria-label,外层 label 撑触控靶", () => {
    const { container } = render(<Checkbox aria-label="选择 编程助手" />);
    const box = screen.getByRole("checkbox", { name: "选择 编程助手" });
    const label = container.querySelector("label");
    expect(label).toBeTruthy();
    expect(label?.contains(box)).toBe(true);
    // 触屏:min-h-11 恒有;无文字时再补 min-w-11 撑到 44×44。
    expect(label?.className).toContain("[@media(hover:none)]:min-h-11");
    expect(label?.className).toContain("[@media(hover:none)]:min-w-11");
  });

  test("有文字时不补 min-w-11(文字本身已撑宽),min-h-11 仍在", () => {
    const { container } = render(<Checkbox label="我已完成真实功能验收" />);
    const label = container.querySelector("label");
    expect(label?.className).toContain("[@media(hover:none)]:min-h-11");
    expect(label?.className).not.toContain("min-w-11");
  });

  test("description 通过 aria-describedby 关联,并与调用方自带的 describedby 合并", () => {
    render(
      <Checkbox
        label="批量批准"
        description="API 插件需逐个确认"
        aria-describedby="extra-hint"
      />,
    );
    const box = screen.getByRole("checkbox", { name: "批量批准" });
    const ids = (box.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("extra-hint");
    const descId = ids.find((id) => id !== "extra-hint");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId as string)).toHaveTextContent("API 插件需逐个确认");
    expect(box).toHaveAccessibleDescription(/API 插件需逐个确认/);
  });

  test("indeterminate 落到 DOM 属性(读屏 mixed),视觉为减号;取消后回到勾", () => {
    const { rerender, container } = render(<Checkbox label="全选" indeterminate />);
    const box = screen.getByRole("checkbox", { name: "全选" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toBePartiallyChecked();
    expect(container.querySelector("svg.lucide-minus")).toBeTruthy();
    expect(container.querySelector("svg.lucide-check")).toBeNull();

    rerender(<Checkbox label="全选" indeterminate={false} checked onChange={() => {}} />);
    expect(box.indeterminate).toBe(false);
    expect(box).toBeChecked();
    expect(container.querySelector("svg.lucide-check")).toBeTruthy();
    expect(container.querySelector("svg.lucide-minus")).toBeNull();
  });

  test("受控用法:checked 由父级驱动,键盘 Space(原生 click)也走 onChange", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return (
        <Checkbox
          label={on ? "已选" : "未选"}
          checked={on}
          onChange={(e) => setOn(e.currentTarget.checked)}
        />
      );
    }
    render(<Harness />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box).not.toBeChecked();
    // 原生 checkbox 的 Space 在浏览器里派发 click;这里直接派发 click 覆盖同一条路径。
    box.focus();
    expect(box).toHaveFocus();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText("已选")).toBeInTheDocument();
  });

  test("disabled:控件禁用、点文字不切换、外层不再是 pointer 光标", () => {
    const onChange = vi.fn();
    const { container } = render(<Checkbox label="必选" disabled onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "必选" });
    expect(box).toBeDisabled();
    fireEvent.click(screen.getByText("必选"));
    expect(onChange).not.toHaveBeenCalled();
    expect(box).not.toBeChecked();
    expect(container.querySelector("label")?.className).toContain("cursor-not-allowed");
  });

  test("ref 透传到 <input>", () => {
    let node: HTMLInputElement | null = null;
    render(
      <Checkbox
        label="引用"
        ref={(el) => {
          node = el;
        }}
      />,
    );
    expect(node).toBeInstanceOf(HTMLInputElement);
    expect((node as HTMLInputElement | null)?.type).toBe("checkbox");
  });

  test("className 落在外层 label(卡片式外观由调用方决定),控件盒接受 controlClassName", () => {
    const { container } = render(
      <Checkbox label="工具集" className="rounded-lg border px-3" controlClassName="mt-0.5" />,
    );
    const label = container.querySelector("label");
    expect(label?.className).toContain("rounded-lg border px-3");
    const box = screen.getByRole("checkbox");
    expect(box.parentElement?.className).toContain("mt-0.5");
  });
});
