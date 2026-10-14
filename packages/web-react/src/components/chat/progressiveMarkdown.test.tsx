// OCV5-421 (Codex r1/r2): chunked live Markdown must never remount content that is already on
// screen — a stateful block (option card) keeps its exact DOM node while the text grows, when a
// footnote definition arrives, and when streaming ends.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { loadBeforeAll } from "../../test/moduleLoad";
import { prefetchMarkdownImpl } from "../Markdown";
import { ProgressiveMarkdown } from "./cards";

afterEach(cleanup);
loadBeforeAll(() => prefetchMarkdownImpl());

const options = '```options\n{"question":"风格?","options":[{"label":"正式"},{"label":"轻松"}]}\n```';
const para = (n: number) => `段落 ${n}：${"这是正文内容。".repeat(30)}`;

describe("ProgressiveMarkdown chunked live render (OCV5-421)", () => {
  test("option card keeps its DOM node through growth, a late definition and stream end", async () => {
    const head = `${"x".repeat(1250)}\n\n${options}\n\n`;
    const { rerender } = render(<ProgressiveMarkdown text={head} live caret />);
    const before = await screen.findByRole("button", { name: /正式/ });
    let text = head;
    for (let i = 1; i <= 4; i++) {
      text += `${para(i)}\n\n`;
      rerender(<ProgressiveMarkdown text={text} live caret />);
    }
    text += "结论[^1]。\n\n[^1]: 来源\n";
    rerender(<ProgressiveMarkdown text={text} live caret />);
    rerender(<ProgressiveMarkdown text={text} live={false} caret={false} />);
    const after = await screen.findByRole("button", { name: /正式/ });
    expect(after).toBe(before);
    expect(before.isConnected).toBe(true);
  });

  test("without stateful blocks, a message with footnotes renders them resolved after the stream", async () => {
    let text = "";
    const { rerender, container } = render(<ProgressiveMarkdown text={text} live caret />);
    for (let i = 1; i <= 5; i++) {
      text += `${para(i)}\n\n`;
      rerender(<ProgressiveMarkdown text={text} live caret />);
    }
    text += "结论[^1]。\n\n[^1]: 来源说明\n";
    rerender(<ProgressiveMarkdown text={text} live={false} caret={false} />);
    await screen.findByText(/来源说明/);
    expect(container.querySelector('a[href^="#user-content-fn-"]')).not.toBeNull();
  });
});
