import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice, collapseRepeats } from "./Notice";

afterEach(cleanup);

describe("Notice 时间线内提示", () => {
  it("一句标题 + 正文 + 最多两个动作", () => {
    const retry = vi.fn();
    const swap = vi.fn();
    const { container } = render(
      <Notice
        tone="failed"
        title="这次没完成：模型服务暂时不可用"
        actions={[
          { label: "重试", onClick: retry },
          { label: "换个模型", onClick: swap },
        ]}
      >
        你的消息还在。
      </Notice>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-notice-tone", "failed");
    expect(screen.getByText("这次没完成：模型服务暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("你的消息还在。")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveClass("text-status-failed");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(screen.getByRole("button", { name: "换个模型" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it("技术详情默认收起,展开后才出现", () => {
    render(<Notice title="自动恢复已停止" details="request_id=abc123 · upstream 502" />);
    const toggle = screen.getByRole("button", { name: "技术详情" });
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent("request_id=abc123");
    expect(panel).toHaveClass("font-mono");
  });

  it("没有动作也没有详情时不渲染操作行", () => {
    render(<Notice tone="stopped" title="已停止" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("进行中用呼吸点;同样的提示 ×N", () => {
    const { container, rerender } = render(<Notice tone="progress" title="正在压缩上下文" count={1} />);
    expect(container.querySelector(".oc-status-breathe")).not.toBeNull();
    expect(screen.queryByText(/×/)).toBeNull();
    rerender(<Notice tone="progress" title="正在压缩上下文" count={3} />);
    expect(screen.getByText("×3")).toBeInTheDocument();
  });
});

describe("collapseRepeats", () => {
  it("只合并相邻的相同提示,保留最后一条,顺序不变", () => {
    const items = [
      { key: "a", n: 1 },
      { key: "a", n: 2 },
      { key: "a", n: 3 },
      { key: "b", n: 4 },
      { key: "a", n: 5 },
    ];
    expect(collapseRepeats(items, (i) => i.key)).toEqual([
      { item: { key: "a", n: 3 }, count: 3 },
      { item: { key: "b", n: 4 }, count: 1 },
      { item: { key: "a", n: 5 }, count: 1 },
    ]);
    expect(collapseRepeats([], String)).toEqual([]);
  });
});
