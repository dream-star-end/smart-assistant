/**
 * chunk 到达前挂载的 Markdown(如正在流式的消息,OCV5-373 follow-up):占位换成富文本后,
 * 再渲染不因组件类型变化被再次整块重挂(HTML 预览 iframe 会因此重载)。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadBeforeAll } from "../test/moduleLoad";
import { Markdown, prefetchMarkdownImpl } from "./Markdown";

// 在用例窗口外把实现模块编译进缓存,但不经 prefetchMarkdownImpl:这条用例要的是「chunk 还没到」。
loadBeforeAll(() => import("./MarkdownImpl"));

afterEach(cleanup);

test("chunk 到达前挂载的实例:占位换成富文本后,再渲染不重挂", async () => {
  const { rerender } = render(<Markdown>早挂载正文</Markdown>);
  expect(screen.getByText("早挂载正文").tagName).toBe("DIV");
  await act(async () => {
    await prefetchMarkdownImpl();
  });
  const rich = screen.getByText("早挂载正文");
  expect(rich.tagName).toBe("P");
  rerender(<Markdown signMedia={false}>早挂载正文</Markdown>);
  expect(screen.getByText("早挂载正文")).toBe(rich);
});
