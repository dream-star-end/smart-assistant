import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Markdown } from "./Markdown";

vi.mock("./MarkdownImpl", () => ({
  default: function SuspendedMarkdownImpl() {
    throw new Promise(() => {});
  },
}));

afterEach(cleanup);

describe("Markdown fallback", () => {
  test("未闭合 htmlpreview fence 在重 chunk 加载中仍渲染沙盒预览而不是源码", () => {
    const text = "说明\n```htmlpreview\n<style>body{color:red}</style>\n<div>hi</div>";
    const { container } = render(<Markdown>{text}</Markdown>);

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox") || "").not.toContain("allow-same-origin");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.getAttribute("srcdoc")).toContain("<style>body{color:red}</style>");
    expect(container.textContent).toContain("说明");
    expect(container.textContent).toContain("HTML 预览");
    expect(container.textContent).not.toContain("body{color:red}");
  });

  test("live htmlpreview fallback 使用稳定占位，避免流式期反复重载半截 iframe", () => {
    const text = "```htmlpreview\n<style>body{color:red}</style>\n<div>hi</div>";
    const { container } = render(<Markdown live>{text}</Markdown>);

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("HTML 预览(生成中)");
    expect(container.textContent).toContain("生成完成后显示 HTML 预览");
    expect(container.textContent).not.toContain("body{color:red}");
  });
});
