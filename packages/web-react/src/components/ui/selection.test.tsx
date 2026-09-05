import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chip } from "./Chip";
import { SegmentedControl } from "./SegmentedControl";

afterEach(cleanup);

describe("Chip", () => {
  it("是 button 且用 aria-pressed 表达选中态", () => {
    const { rerender } = render(<Chip selected={false}>全部</Chip>);
    const el = screen.getByRole("button", { name: "全部" });
    expect(el).toHaveAttribute("type", "button");
    expect(el).toHaveAttribute("aria-pressed", "false");
    rerender(<Chip selected>全部</Chip>);
    expect(el).toHaveAttribute("aria-pressed", "true");
    expect(el.className).toContain("bg-accent-soft");
  });

  it("字号只走语义 token,不出现任意值", () => {
    render(
      <>
        <Chip>甲</Chip>
        <Chip size="sm">乙</Chip>
      </>,
    );
    expect(screen.getByRole("button", { name: "甲" }).className).toContain("text-meta");
    expect(screen.getByRole("button", { name: "乙" }).className).toContain("text-caption");
    for (const b of screen.getAllByRole("button")) expect(b.className).not.toMatch(/text-\[/);
  });

  it("disabled 时不触发 onClick", () => {
    const onClick = vi.fn();
    render(
      <Chip disabled onClick={onClick}>
        禁
      </Chip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "禁" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

const OPTS = [
  { value: "list", label: "列表" },
  { value: "grid", label: "宫格" },
  { value: "map", label: "地图" },
] as const;

function Controlled({ initial = "list", disabledValue }: { initial?: string; disabledValue?: string }) {
  const [v, setV] = useState<string>(initial);
  const opts = OPTS.map((o) => ({ ...o, disabled: o.value === disabledValue }));
  return <SegmentedControl value={v} onValueChange={setV} options={opts} aria-label="视图" />;
}

describe("SegmentedControl", () => {
  it("是 radiogroup + radio,aria-checked 跟随 value,roving tabindex 只有选中项可 Tab 到", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "视图" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveAttribute("tabindex", "0");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
    expect(radios[1]).toHaveAttribute("tabindex", "-1");
    // 不能把它当 tablist 用:没有 tab 角色。
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("点击切换值;重复点击已选中项不重复触发", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="list" onValueChange={onChange} options={OPTS} aria-label="视图" />);
    fireEvent.click(screen.getByRole("radio", { name: "宫格" }));
    expect(onChange).toHaveBeenCalledWith("grid");
    fireEvent.click(screen.getByRole("radio", { name: "列表" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("←/→ 循环切换并移动焦点,Home/End 到首尾,禁用项被跳过", () => {
    render(<Controlled disabledValue="grid" />);
    const list = screen.getByRole("radio", { name: "列表" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    // 「宫格」禁用 → 直接到「地图」
    const map = screen.getByRole("radio", { name: "地图" });
    expect(map).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(map);
    fireEvent.keyDown(map, { key: "ArrowRight" });
    expect(list).toHaveAttribute("aria-checked", "true"); // 循环回首项
    fireEvent.keyDown(list, { key: "End" });
    expect(map).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(map, { key: "Home" });
    expect(list).toHaveAttribute("aria-checked", "true");
  });

  it("字号只走语义 token;窄屏容器可横滑", () => {
    render(<SegmentedControl value="list" onValueChange={() => {}} options={OPTS} aria-label="视图" size="sm" />);
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("overflow-x-auto");
    expect(group.className).toContain("no-scrollbar");
    for (const r of screen.getAllByRole("radio")) {
      expect(r.className).toContain("text-meta");
      expect(r.className).not.toMatch(/text-\[/);
    }
  });
});
