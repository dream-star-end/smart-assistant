import { describe, expect, test } from "bun:test";
import { smartTruncateMarkdown } from "../truncate";

const MAX = 100_000;

function bigDoc(): string {
  // head, then many sections, then a distinctive tail — well over MAX.
  const head = "# Intro\n\n" + "H".repeat(60_000);
  const sections: string[] = [];
  for (let i = 0; i < 40; i++) {
    sections.push(
      `## Section ${i}\n\nLead paragraph ${i} with the number ${1000 + i}.\n\n` +
        `FILLER_${i}_`.repeat(300),
    );
  }
  const tail = "## Conclusion\n\nFINAL_CONCLUSION_MARKER value 4242.\n" + "T".repeat(5_000);
  return [head, ...sections, tail].join("\n\n");
}

describe("smartTruncateMarkdown", () => {
  test("short content returned verbatim (<= maxLen)", () => {
    const s = "# Title\n\nshort body";
    expect(smartTruncateMarkdown(s, MAX)).toBe(s);
  });

  test("never exceeds maxLen budget", () => {
    const out = smartTruncateMarkdown(bigDoc(), MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  test("keeps the head", () => {
    const out = smartTruncateMarkdown(bigDoc(), MAX);
    expect(out.startsWith("# Intro")).toBe(true);
  });

  test("preserves the tail (old head-only cut dropped it)", () => {
    const out = smartTruncateMarkdown(bigDoc(), MAX);
    expect(out.includes("FINAL_CONCLUSION_MARKER value 4242.")).toBe(true);
    // and the old behavior (hard head slice) would NOT have contained it:
    const oldCut = bigDoc().slice(0, MAX);
    expect(oldCut.includes("FINAL_CONCLUSION_MARKER")).toBe(false);
  });

  test("keeps mid-document section headings + their lead paragraph (outline)", () => {
    const out = smartTruncateMarkdown(bigDoc(), MAX);
    // A mid-document section (far past the head budget, before the tail) still
    // shows up via the outline as heading + first paragraph only.
    expect(out.includes("## Section 30")).toBe(true);
    expect(out.includes("Lead paragraph 30 with the number 1030.")).toBe(true);
    // ...but that section's bulk filler body is elided (outline keeps lead only).
    expect(out.includes("FILLER_30_")).toBe(false);
  });

  test("emits elision markers so the model knows content was removed", () => {
    const out = smartTruncateMarkdown(bigDoc(), MAX);
    expect(out.includes("中段省略")).toBe(true);
    expect(out.includes("原文结尾")).toBe(true);
  });

  test("plain text (no headings): still keeps head + tail, no fabricated outline", () => {
    const doc = "A".repeat(70_000) + "\n\n" + "Z_TAIL_MARKER" + "B".repeat(60_000);
    const out = smartTruncateMarkdown(doc, MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.startsWith("A")).toBe(true);
    expect(out.includes("原文结尾")).toBe(true);
    // no outline section since there are no headings
    expect(out.includes("各节标题与首段")).toBe(false);
  });

  test("boundary: content exactly at maxLen returned verbatim", () => {
    const s = "x".repeat(MAX);
    expect(smartTruncateMarkdown(s, MAX)).toBe(s);
  });

  test("boundary: content one over maxLen is reshaped and bounded", () => {
    const s = "# H\n\n" + "x".repeat(MAX);
    const out = smartTruncateMarkdown(s, MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });
});
