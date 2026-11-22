/**
 * OCV5-811 交付物富预览纯函数与轻量解析器单测：
 * 分类元数据、RFC4180 CSV/TSV 解析与筛选排序、Markdown 幻灯片与长文档大纲提取、批注回填提示词生成。
 */
import { describe, expect, test } from "vitest";
import {
  buildAnnotationPrompt,
  classifyDeliverable,
  extractMarkdownOutline,
  filterAndSortTableRows,
  formatAnchorLabel,
  parseDelimitedTable,
  parseMarkdownSlides,
  serializeCsvSlice,
  summarizeDeliverableCategories,
} from "./deliverablePreview";

describe("classifyDeliverable & summarizeDeliverableCategories", () => {
  test("准确识别表格、演示文稿、长文档、Word、PDF、网页、代码、媒体与二进制", () => {
    expect(classifyDeliverable("/w/metrics.csv")).toMatchObject({
      category: "spreadsheet",
      format: "csv",
      shortBadge: "CSV",
      canInlinePreview: true,
      isBinaryOffice: false,
    });
    expect(classifyDeliverable("/w/data.tsv")).toMatchObject({
      category: "spreadsheet",
      format: "tsv",
      shortBadge: "TSV",
    });
    const xlsx = classifyDeliverable("/w/budget.xlsx");
    expect(xlsx).toMatchObject({
      category: "spreadsheet",
      format: "excel",
      isBinaryOffice: true,
    });
    expect(xlsx.agentConvertPrompt).toContain("/w/budget.xlsx");
    expect(xlsx.agentConvertPrompt).toContain("CSV");

    const pptx = classifyDeliverable("/w/q4-review.pptx");
    expect(pptx).toMatchObject({
      category: "slides",
      format: "pptx",
      isBinaryOffice: true,
    });
    expect(pptx.agentConvertPrompt).toContain("预览图");

    const marpMd = "---\nmarp: true\ntheme: default\n---\n# 封面\n\n---\n\n## 第二页\n内容";
    expect(classifyDeliverable("/w/talk.md", marpMd)).toMatchObject({
      category: "slides",
      format: "markdown-slides",
      shortBadge: "SLIDES",
    });

    expect(classifyDeliverable("/w/report.md", "# 调研报告\n\n正文内容")).toMatchObject({
      category: "document",
      format: "markdown",
      shortBadge: "MD",
    });
    expect(classifyDeliverable("/w/paper.pdf")).toMatchObject({
      category: "pdf",
      format: "pdf",
      canInlinePreview: true,
    });
    expect(classifyDeliverable("/w/spec.docx")).toMatchObject({
      category: "document",
      format: "word",
      isBinaryOffice: true,
    });
    expect(classifyDeliverable("/w/demo.html")).toMatchObject({ category: "html", format: "html" });
    expect(classifyDeliverable("/w/train.py")).toMatchObject({ category: "code", format: "code", shortBadge: "PY" });
    expect(classifyDeliverable("/w/chart.png")).toMatchObject({ category: "media", format: "media" });
    expect(classifyDeliverable("/w/archive.bin")).toMatchObject({
      category: "file",
      format: "binary",
      canInlinePreview: false,
    });
  });

  test("按稳定顺序统计各类型交付物数量（含媒体）", () => {
    const counts = summarizeDeliverableCategories(
      [
        { path: "/w/app.ts" },
        { path: "/w/a.csv" },
        { path: "/w/b.xlsx" },
        { path: "/w/deck.pptx" },
        { path: "/w/paper.pdf" },
        { path: "/w/report.md" },
      ],
      2,
    );
    expect(counts.map((c) => [c.category, c.count])).toEqual([
      ["slides", 1],
      ["spreadsheet", 2],
      ["document", 1],
      ["pdf", 1],
      ["code", 1],
      ["media", 2],
    ]);
  });
});

describe("parseDelimitedTable / filterAndSortTableRows / serializeCsvSlice", () => {
  test("RFC4180 引号转义、字段内逗号与换行、BOM 清理、列统计", () => {
    const csv = [
      '\uFEFF"模型","准确率","延迟(ms)","备注"',
      '"GPT-5","94.5%","1,200","强推理，""高精度"""',
      '"Claude 4","96.2%","980","第一行',
      '第二行说明"',
      '"Baseline","81.0%","420","对照基线"',
    ].join("\r\n");

    const parsed = parseDelimitedTable(csv);
    expect(parsed.delimiter).toBe(",");
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.headers).toEqual(["模型", "准确率", "延迟(ms)", "备注"]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.totalColumns).toBe(4);
    expect(parsed.rows[0]).toEqual({
      rowNumber: 2,
      cells: ["GPT-5", "94.5%", "1,200", '强推理，"高精度"'],
    });
    expect(parsed.rows[1].cells[3]).toBe("第一行\n第二行说明");

    // 准确率与延迟识别为数值列并算出 min/max/avg
    expect(parsed.columnStats[1]).toMatchObject({ isNumeric: true, min: 81, max: 96.2 });
    expect(parsed.columnStats[2]).toMatchObject({ isNumeric: true, min: 420, max: 1200 });
    expect(parsed.columnStats[0].isNumeric).toBe(false);
  });

  test("TSV 自动识别、无表头纯数字矩阵、以及前 N 行安全截断", () => {
    const tsv = "10\t20\n30\t40\n50\t60\n";
    const parsed = parseDelimitedTable(tsv, { maxRows: 2 });
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.headers).toEqual(["列 1", "列 2"]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(2);
  });

  test("关键词过滤、数值列升降序排序（空值沉底）与 RFC4180 CSV 切片序列化", () => {
    const table = parseDelimitedTable("name,score\nAlpha,10\nBeta,2\nGamma,\nDelta,100\n");
    const asc = filterAndSortTableRows(table, { sortCol: 1, sortDir: "asc" });
    expect(asc.map((r) => r.cells[0])).toEqual(["Beta", "Alpha", "Delta", "Gamma"]);

    const desc = filterAndSortTableRows(table, { sortCol: 1, sortDir: "desc" });
    expect(desc.map((r) => r.cells[0])).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);

    const filtered = filterAndSortTableRows(table, { query: "ta" });
    expect(filtered.map((r) => r.cells[0])).toEqual(["Beta", "Delta"]);

    const slice = serializeCsvSlice(["列A", "列B"], [
      { rowNumber: 2, cells: ['a,b', 'say "hi"'] },
    ]);
    expect(slice).toBe('列A,列B\n"a,b","say ""hi"""');
  });
});

describe("parseMarkdownSlides & extractMarkdownOutline", () => {
  test("解析 Marp 幻灯片：剥离 frontmatter、忽略代码块内的 ---、提取演讲备注", () => {
    const md = [
      "---",
      "marp: true",
      "title: 季度科研进展",
      "---",
      "",
      "# 季度科研进展",
      "副标题",
      "",
      "<!-- _class: lead -->",
      "<!-- notes: 开场介绍背景 -->",
      "",
      "---",
      "",
      "## 核心实验",
      "```yaml",
      "---",
      "key: value",
      "---",
      "```",
      "",
      "---",
      "",
      "## 下一步计划",
      "- 扩展数据集",
    ].join("\n");

    const deck = parseMarkdownSlides(md, "/w/progress.md");
    expect(deck.isSlideDeck).toBe(true);
    expect(deck.hasFrontmatter).toBe(true);
    expect(deck.title).toBe("季度科研进展");
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[0]).toMatchObject({ index: 1, title: "季度科研进展", notes: "开场介绍背景" });
    expect(deck.slides[1].markdown).toContain("key: value");
    expect(deck.slides[2]).toMatchObject({ index: 3, title: "下一步计划" });
  });

  test("提取长文档 H1–H3 大纲（跳过代码块内 # 注释）与中英混排字数/阅读时长", () => {
    const md = [
      "# 研究综述",
      "",
      "本文对比了 Transformer 与 SSM 架构。",
      "",
      "## 1. 背景介绍",
      "```python",
      "# 这不是标题",
      "print('hello')",
      "```",
      "",
      "### 1.1 指标表",
      "| 模型 | 分数 |",
      "| --- | --- |",
      "| A | 90 |",
      "",
      "## 2. 结论",
      "最终建议采用混合架构。",
    ].join("\n");

    const analysis = extractMarkdownOutline(md);
    expect(analysis.headings.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, "研究综述", 1],
      [2, "1. 背景介绍", 5],
      [3, "1.1 指标表", 11],
      [2, "2. 结论", 16],
    ]);
    expect(analysis.stats.codeBlockCount).toBe(1);
    expect(analysis.stats.tableCount).toBe(1);
    expect(analysis.stats.wordCount).toBeGreaterThan(20);
    expect(analysis.stats.readingMinutes).toBeGreaterThanOrEqual(1);
    expect(analysis.hasSlideDividers).toBe(false);
  });
});

describe("formatAnchorLabel & buildAnnotationPrompt", () => {
  test("按不同位置锚点生成结构化精修提示词", () => {
    expect(formatAnchorLabel({ kind: "slide", page: 3, title: "消融实验" })).toBe("第 3 页（消融实验）");
    expect(formatAnchorLabel({ kind: "table-row", rowNumber: 12, columnsSummary: "模型: GPT-5" })).toBe(
      "第 12 行（模型: GPT-5）",
    );
    expect(formatAnchorLabel({ kind: "section", heading: "实验结论", line: 42 })).toBe("章节「实验结论」（第 42 行）");
    expect(formatAnchorLabel({ kind: "code-line", lineStart: 18, lineEnd: 25 })).toBe("第 18–25 行");
    expect(formatAnchorLabel({ kind: "file" })).toBe("整份交付物");

    const prompt = buildAnnotationPrompt({
      filePath: "/workspace/deck.md",
      anchor: { kind: "slide", page: 3, title: "消融实验" },
      comment: "补充 P 值并压缩要点长度",
      excerpt: "## 消融实验\n- 基线 81%",
    });
    expect(prompt).toContain("`/workspace/deck.md`");
    expect(prompt).toContain("第 3 页（消融实验）");
    expect(prompt).toContain("补充 P 值并压缩要点长度");
    expect(prompt).toContain("定位参考：## 消融实验 - 基线 81%");
  });
});
