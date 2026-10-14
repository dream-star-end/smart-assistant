import { describe, expect, test } from "vitest";
import { splitLiveMarkdown } from "./liveMarkdownChunks";

const para = (n: number) => `段落 ${n}：${"这是正文内容。".repeat(30)}`;
const join = (parts: string[]) => parts.join("");

describe("splitLiveMarkdown (OCV5-421)", () => {
  test("short text stays one chunk", () => {
    expect(splitLiveMarkdown("hello\n\nworld")).toEqual(["hello\n\nworld"]);
  });

  test("cuts only at blank lines before a fresh block, lossless", () => {
    const text = `${[para(1), para(2), para(3), para(4), para(5)].join("\n\n")}\n\n尾`;
    const parts = splitLiveMarkdown(text, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(join(parts)).toBe(text);
    for (const p of parts.slice(1)) expect(p.startsWith("段落") || p.startsWith("尾")).toBe(true);
  });

  test("emitted chunks never change as the text grows", () => {
    const full = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
    let prev: string[] = [];
    for (let end = 50; end <= full.length; end += 37) {
      const parts = splitLiveMarkdown(full.slice(0, end), 300);
      expect(join(parts)).toBe(full.slice(0, end));
      // every chunk except the previous tail must be identical
      for (let i = 0; i < prev.length - 1; i++) expect(parts[i]).toBe(prev[i]);
      prev = parts;
    }
  });

  test("never cuts inside fenced code (closed or streaming)", () => {
    const code = `\`\`\`js\n${Array.from({ length: 60 }, (_, i) => `line${i}\n\nafter${i}`).join("\n")}\n`;
    const text = `${para(1)}\n\n${code}`;
    const parts = splitLiveMarkdown(text, 100);
    for (const p of parts.slice(1)) expect(p.startsWith("```js")).toBe(true);
    expect(join(parts)).toBe(text);
  });

  test("never cuts inside $$ display math", () => {
    const text = `${para(1)}\n\n$$\n${"a+b\n\nc\n".repeat(40)}$$\n\n${para(2)}\n\n${para(3)}`;
    const parts = splitLiveMarkdown(text, 100);
    for (const p of parts) {
      const n = (p.match(/\$\$/g) ?? []).length;
      expect(n % 2).toBe(0);
    }
    expect(join(parts)).toBe(text);
  });

  test("does not split lists, tables, quotes or indented continuations", () => {
    const list = Array.from({ length: 30 }, (_, i) => `- item ${i} ${"x".repeat(40)}`).join("\n\n");
    const ol = Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${"y".repeat(40)}`).join("\n\n");
    const quote = Array.from({ length: 30 }, () => `> 引用 ${"z".repeat(40)}`).join("\n\n");
    const nested = `- top\n\n    continued paragraph inside the item ${"w".repeat(2000)}`;
    for (const body of [list, ol, quote, nested]) {
      const text = `${para(1)}\n\n${body}`;
      const parts = splitLiveMarkdown(text, 100);
      expect(parts.length).toBeLessThanOrEqual(2);
      if (parts.length === 2) expect(parts[1]).toBe(body);
    }
  });

  test("footnotes / reference definitions disable splitting", () => {
    const text = `${Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n")}\n\n[^1]: 来源`;
    expect(splitLiveMarkdown(text, 100)).toEqual([text]);
  });
});
