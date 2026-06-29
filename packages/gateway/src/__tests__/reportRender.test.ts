/**
 * reportRender 纯逻辑单测(确定性产物层):
 *   - verified claim → 引用顺序编号 [N];多源去重 [N,M]。
 *   - unsupported/unchecked/缺失 claim → 红标(不给假编号)+ warning(fail-closed)。
 *   - 参考文献按引用顺序编号 + GB/T7714 格式化。
 *   - missingClaimRefs 检出正文引用但 manifest 缺失的 claim。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReportDocument, missingClaimRefs } from "../reportRender.js";
import type { EvidenceManifest, ReportSchema } from "@openclaude/protocol/research";

function manifest(): EvidenceManifest {
  return {
    sources: [
      { id: "d1", title: "Paper One", authors: [{ name: "Alice Smith" }], year: 2021, venue: "Nature", doi: "10.1/a", identifiersVerified: true },
      { id: "d2", title: "论文二", authors: [{ name: "张三" }], year: 2020, venue: "计算机学报", doi: "10.2/b", identifiersVerified: true },
    ],
    quotes: [
      { id: "q1", sourceId: "d1", docId: "d1", spanId: "s1", charStart: 0, charEnd: 5, text: "hello" },
      { id: "q2", sourceId: "d2", docId: "d2", spanId: "s1", charStart: 0, charEnd: 5, text: "你好" },
    ],
    claims: [
      { id: "c1", text: "verified one", supports: [{ quoteId: "q1" }], status: "verified" },
      { id: "c2", text: "verified two src", supports: [{ quoteId: "q1" }, { quoteId: "q2" }], status: "verified" },
      { id: "c3", text: "bad", supports: [], status: "unsupported" },
      { id: "c4", text: "uncheck", supports: [], status: "unchecked" },
    ],
    coverage: { verifiedClaims: 2, totalClaims: 4 },
    gates: {
      quoteFirst: { passed: true, checked: 2, failed: 0 },
      claimBound: { passed: true, checked: 2, failed: 0 },
      identifier: { passed: true, checked: 2, failed: 0 },
      retraction: { passed: true, checked: 2, failed: 0 },
    },
  };
}

function schema(over?: Partial<ReportSchema>): ReportSchema {
  return {
    title: "研究报告",
    abstract: "摘要里也能引用 [[claim:c1]]。",
    sections: [
      { id: "intro", heading: "引言", level: 2, bodyMd: "第一点 [[claim:c1]]。第二点 [[claim:c2]]。", claimRefs: ["c1", "c2"] },
      { id: "disc", heading: "讨论", level: 2, bodyMd: "存疑 [[claim:c3]];待查 [[claim:c4]]。", claimRefs: ["c3", "c4"] },
    ],
    figures: [{ id: "f1", path: "/home/agent/.openclaude/research/r/fig1.png", caption: "图一", kind: "plot" }],
    bibliography: ["d1", "d2"],
    csl: "gb-t-7714-2015",
    ...over,
  };
}

describe("reportRender", () => {
  it("verified claim 编号 + 多源去重 + 引用顺序", () => {
    const r = buildReportDocument(schema(), manifest());
    // c1 → [1](d1);c2 → [1,2](d1,d2 顺序)
    assert.ok(r.markdown.includes("第一点 [1]。"), r.markdown);
    assert.ok(r.markdown.includes("第二点 [1,2]。"), r.markdown);
    assert.equal(r.stats.citations >= 2, true);
  });

  it("unsupported/unchecked → 红标,不给假编号", () => {
    const r = buildReportDocument(schema(), manifest());
    assert.ok(r.markdown.includes("存疑 **[未核查:无可信引用]**"));
    assert.ok(r.markdown.includes("待查 **[未核查]**"));
    assert.equal(r.stats.redFlags, 2);
    assert.ok(r.warnings.some((w) => w.includes("c3")));
    assert.ok(r.warnings.some((w) => w.includes("覆盖率") || w.includes("覆盖")));
  });

  it("参考文献按引用顺序编号 + GB/T7714", () => {
    const r = buildReportDocument(schema(), manifest());
    assert.ok(r.markdown.includes("## 参考文献"));
    assert.equal(r.references.length, 2);
    assert.ok(r.references[0].startsWith("1. "));
    assert.ok(r.references[0].includes("[J]"));
    assert.ok(r.references[0].includes("Nature"));
    // 第二条是中文文献
    assert.ok(r.references[1].includes("张三"));
  });

  it("图表 embed", () => {
    const r = buildReportDocument(schema(), manifest());
    assert.ok(r.markdown.includes("![图一](/home/agent/.openclaude/research/r/fig1.png){#fig-f1}"));
    assert.equal(r.stats.figures, 1);
  });

  it("缺失 claim → 红标 + warning", () => {
    const s = schema({
      sections: [{ id: "x", heading: "X", level: 2, bodyMd: "引用不存在 [[claim:ghost]]。", claimRefs: ["ghost"] }],
    });
    const r = buildReportDocument(s, manifest());
    assert.ok(r.markdown.includes("**[未核查:claim 缺失]**"));
    assert.ok(r.warnings.some((w) => w.includes("ghost")));
  });

  it("missingClaimRefs 检出正文缺失引用", () => {
    const s = schema({
      sections: [{ id: "x", heading: "X", level: 2, bodyMd: "[[claim:c1]] 和 [[claim:ghost]]", claimRefs: [] }],
    });
    assert.deepEqual(missingClaimRefs(s, manifest()), ["ghost"]);
  });

  it("Quarto frontmatter + number-sections", () => {
    const r = buildReportDocument(schema(), manifest());
    assert.ok(r.markdown.startsWith("---\ntitle:"));
    assert.ok(r.markdown.includes("number-sections: true"));
  });
});
