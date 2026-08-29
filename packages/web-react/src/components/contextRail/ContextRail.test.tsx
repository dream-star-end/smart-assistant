import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ContextRail } from "./ContextRail";

afterEach(cleanup);

describe("ContextRail 壳", () => {
  test("全部模块无数据时返回 null，不占宽", () => {
    const { container } = render(
      <ContextRail
        renderers={{ "bound-repo": null, "pinned-tasks": null }}
        onHide={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("context-rail")).toBeNull();
  });

  test("按注册表顺序渲染有数据的模块，隐藏会回调", () => {
    const onHide = vi.fn();
    render(
      <ContextRail
        renderers={{
          "bound-repo": <div>仓库模块</div>,
          "pinned-tasks": <div>任务模块</div>,
        }}
        onHide={onHide}
      />,
    );
    const rail = screen.getByTestId("context-rail");
    expect(rail).toHaveAttribute("aria-label", "上下文");
    expect(rail.textContent).toMatch(/仓库模块[\s\S]*任务模块/);
    fireEvent.click(screen.getByRole("button", { name: "隐藏上下文" }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
