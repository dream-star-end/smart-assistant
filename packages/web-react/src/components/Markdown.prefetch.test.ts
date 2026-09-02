import { describe, expect, test } from "vitest";
import { prefetchMarkdownImpl } from "./Markdown";

describe("prefetchMarkdownImpl", () => {
  test("进会话预取会加载 MarkdownImpl chunk，且同一 promise 复用", async () => {
    const first = prefetchMarkdownImpl();
    const second = prefetchMarkdownImpl();
    expect(second).toBe(first);
    const mod = await first;
    expect(typeof mod.default).toBe("function");
  });
});
