import { describe, expect, test } from "vitest";
import { hasMarkdownDefinitions, hasStatefulBlock, splitLiveMarkdown } from "./liveMarkdownChunks";

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

  test("definitions are reported for the end-of-stream single render, but never re-split live text", () => {
    const head = `${Array.from({ length: 4 }, (_, i) => para(i)).join("\n\n")}\n\n`;
    const before = splitLiveMarkdown(head, 300);
    const after = splitLiveMarkdown(`${head}[^1]: 来源\n`, 300);
    for (let i = 0; i < before.length - 1; i++) expect(after[i]).toBe(before[i]);
    expect(hasMarkdownDefinitions(`${head}[^1]: 来源`)).toBe(true);
    expect(hasMarkdownDefinitions(head)).toBe(false);
  });

  // Codex r1: a cut must never appear later at an earlier position (rich blocks already mounted
  // in the tail would remount and lose state).
  test("a cut is fixed when its line completes; growing past any length never moves earlier text", () => {
    const options = "```options\n{\"options\":[\"A\",\"B\"]}\n```";
    const full = `${"x".repeat(1250)}\n\n${options}\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}`;
    let prev: string[] = [];
    for (let end = 1; end <= full.length; end += 7) {
      const parts = splitLiveMarkdown(full.slice(0, end));
      // the start offset of every earlier chunk boundary stays put
      let off = 0;
      const starts = parts.map((p) => { const s = off; off += p.length; return s; });
      let poff = 0;
      const pstarts = prev.map((p) => { const s = poff; poff += p.length; return s; });
      for (const s of pstarts) expect(starts).toContain(s);
      // a new cut only ever lands on the line that just completed (nothing mounted earlier moves)
      const prevText = full.slice(0, Math.max(0, end - 7));
      for (const s of starts) if (!pstarts.includes(s)) expect(s).toBeGreaterThan(prevText.lastIndexOf("\n", prevText.length - 2));
      prev = parts;
    }
  });

  test("$$ inside inline code never leads to a cut inside a formula", () => {
    const math = "$$\na=1+2+3+4\n\nb=2\n$$";
    const text = `\`$$\` 是行内代码\n\n${para(1)}\n\n${math}\n\n${para(2)}\n\n${para(3)}`;
    const parts = splitLiveMarkdown(text, 100);
    expect(parts.join("")).toBe(text);
    // when the two readings disagree the chunker just stops cutting; the formula stays whole
    expect(parts.some((p) => p.includes(math))).toBe(true);
  });

  test("never cuts inside \\[ … \\] display math", () => {
    const text = `${para(1)}\n\n\\[\n${"a+b\n\nc\n".repeat(40)}\\]\n\n${para(2)}`;
    const parts = splitLiveMarkdown(text, 100);
    for (const p of parts) {
      expect((p.match(/\\\[/g) ?? []).length).toBe((p.match(/\\\]/g) ?? []).length);
    }
    expect(parts.join("")).toBe(text);
  });
  // Codex r2: a code span may continue over several lines of one paragraph.
  test("$$ inside a multi-line inline code span does not open display math", () => {
    const math = "$$\na=1+2+3+4\n\nb=2\n$$";
    const text = `\`a\nb $$\` 是行内代码\n\n${"x".repeat(1190)}\n\n${math}\n\n${"y".repeat(1280)}\n\n${para(2)}`;
    const parts = splitLiveMarkdown(text);
    expect(parts.join("")).toBe(text);
    // the formula is never split across chunks
    expect(parts.some((p) => p.includes(math))).toBe(true);
  });

  test("hasStatefulBlock spots option / ui / html fences only", () => {
    expect(hasStatefulBlock("前文\n\n```options\n{}\n```")).toBe(true);
    expect(hasStatefulBlock("```UI\n{}\n```")).toBe(true);
    expect(hasStatefulBlock("```htmlpreview\n<p>x</p>\n```")).toBe(true);
    expect(hasStatefulBlock("```python\nprint(1)\n```")).toBe(false);
  });
  // Codex r3: an unpaired backtick must not hide a real $$ opener.
  test("an unpaired backtick before display math never lets a cut land inside the formula", () => {
    const math = "$$\na=1+2+3+4\n\nb=2\n$$";
    // Codex r3 repro: single newlines, so the formula follows inside the same paragraph.
    const text = `普通文本以反引号结尾 \`\n${"x".repeat(1190)}\n${math}\n${"y".repeat(1280)}\n\n${para(2)}\n\n${para(3)}`;
    const parts = splitLiveMarkdown(text);
    expect(parts.join("")).toBe(text);
    expect(parts.some((p) => p.includes(math))).toBe(true);
  });

  test("hasStatefulBlock also sees fences inside quotes and list items", () => {
    expect(hasStatefulBlock("> ```options\n> {}\n> ```")).toBe(true);
    expect(hasStatefulBlock("- 选项：\n\n    ```options\n    {}\n    ```")).toBe(true);
  });
});
