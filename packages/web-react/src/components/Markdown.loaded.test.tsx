/**
 * Markdown 在 chunk 已到达后挂载(OCV5-373 follow-up):首帧即富文本,不先出纯文本占位再整块替换。
 * React.lazy 首帧必然挂起一次(它只经 .then 得知结果,哪怕 promise 早已兑现),曾让
 * loadBeforeAll(prefetchMarkdownImpl) 之后「先 findByText 再断言」拿到随即被换掉的占位节点
 * (TutorialCenter 深链用例偶发红)。本文件里这是第一次渲染 Markdown,不能再加先渲染的用例。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadBeforeAll } from "../test/moduleLoad";
import { Markdown, prefetchMarkdownImpl } from "./Markdown";

loadBeforeAll(prefetchMarkdownImpl);

afterEach(cleanup);

test("chunk 已到达后挂载:首帧即富文本,先找到的节点之后仍在文档里", async () => {
  render(<Markdown readOnly>深链正文</Markdown>);
  const first = screen.getByText("深链正文");
  expect(first.tagName).toBe("P");
  await act(async () => {});
  expect(first).toBeInTheDocument();
});
