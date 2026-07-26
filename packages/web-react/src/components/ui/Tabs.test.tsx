import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectAriaControlsResolvable } from "../../test/ariaControls";
import { Tabs } from "./Tabs";

afterEach(cleanup);

const ITEMS = [
  { value: "a", label: "概览" },
  { value: "b", label: "账单" },
  { value: "c", label: "记录" },
];

/** 仓内最普遍的调用形态:tablist 常在,但**只渲染当前面板**。 */
function OnlyActivePanel({ value }: { value: string }) {
  return (
    <>
      <Tabs value={value} onValueChange={() => {}} items={ITEMS} idBase="demo" aria-label="演示" />
      <div role="tabpanel" id={`demo-panel-${value}`} aria-labelledby={`demo-tab-${value}`}>
        面板内容
      </div>
    </>
  );
}

describe("Tabs aria-controls 只指向真实挂载的面板", () => {
  it("默认(调用方只渲染当前面板)不给未挂载的面板落悬空 IDREF", () => {
    render(<OnlyActivePanel value="a" />);
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-controls", "demo-panel-a");
    // 「账单」「记录」的面板此刻根本不在 DOM 里:落 aria-controls 等于给读屏一个死链。
    expect(screen.getByRole("tab", { name: "账单" })).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("tab", { name: "记录" })).not.toHaveAttribute("aria-controls");
    expectAriaControlsResolvable();
  });

  it("mountedPanels 声明的面板(常挂 hidden / 惰性保活)都拿到可解析的 aria-controls", () => {
    render(
      <>
        <Tabs
          value="a"
          onValueChange={() => {}}
          items={ITEMS}
          idBase="demo"
          mountedPanels={["a", "b"]}
          aria-label="演示"
        />
        <div role="tabpanel" id="demo-panel-a" aria-labelledby="demo-tab-a">
          A
        </div>
        <div role="tabpanel" id="demo-panel-b" aria-labelledby="demo-tab-b" hidden>
          B
        </div>
      </>,
    );
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-controls", "demo-panel-a");
    expect(screen.getByRole("tab", { name: "账单" })).toHaveAttribute("aria-controls", "demo-panel-b");
    // 未挂载的第三个面板仍然不落。
    expect(screen.getByRole("tab", { name: "记录" })).not.toHaveAttribute("aria-controls");
    expectAriaControlsResolvable();
  });

  it("加载态(一个面板都没挂)传 [] 时,连当前项也不落 aria-controls", () => {
    render(
      <Tabs
        value="a"
        onValueChange={() => {}}
        items={ITEMS}
        idBase="demo"
        mountedPanels={[]}
        aria-label="演示"
      />,
    );
    for (const name of ["概览", "账单", "记录"]) {
      expect(screen.getByRole("tab", { name })).not.toHaveAttribute("aria-controls");
    }
    // id 仍然要落:面板挂上来之后要靠它做 aria-labelledby 回指。
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("id", "demo-tab-a");
    expectAriaControlsResolvable();
  });

  it("不传 idBase 时两个属性都不落(向后兼容)", () => {
    render(<Tabs value="a" onValueChange={() => {}} items={ITEMS} aria-label="演示" />);
    const tab = screen.getByRole("tab", { name: "概览" });
    expect(tab).not.toHaveAttribute("aria-controls");
    expect(tab).not.toHaveAttribute("id");
  });
});
