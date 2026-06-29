/**
 * 演示产物 builder + PresAesth 美学闸 单测(纯逻辑):
 *   - buildSlideDeck:revealjs frontmatter + 主题映射 + bullets/figure/notes。
 *   - buildPoster:typst format + 列数 + sections。
 *   - presAesthSlides/Figures:要点过多/过长/无标题/生成式插画/无 caption;干净零命中。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPoster, buildSlideDeck } from "../presentRender.js";
import { presAesthFigures, presAesthSlides } from "../presAesth.js";
import type { Figure, PosterSpec, SlideDeck } from "@openclaude/protocol/research";

describe("buildSlideDeck", () => {
  it("revealjs frontmatter + 主题映射 + 内容", () => {
    const deck: SlideDeck = {
      title: "研究汇报",
      subtitle: "子标题",
      author: "团队",
      theme: "nature",
      slides: [
        { heading: "背景", bullets: ["要点一", "要点二"], figure: "/r/fig1.png", notes: "讲稿" },
        { heading: "结论", bullets: [] },
      ],
    };
    const r = buildSlideDeck(deck);
    assert.ok(r.markdown.startsWith('---\ntitle: "研究汇报"'));
    assert.ok(r.markdown.includes("theme: serif")); // nature → serif
    assert.ok(r.markdown.includes("format:\n  revealjs:"));
    assert.ok(r.markdown.includes("## 背景"));
    assert.ok(r.markdown.includes("- 要点一"));
    assert.ok(r.markdown.includes("![](/r/fig1.png)"));
    assert.ok(r.markdown.includes("::: notes"));
    assert.equal(r.slideCount, 2);
  });

  it("未知主题回落 default", () => {
    const r = buildSlideDeck({ title: "T", slides: [{ heading: "H", bullets: [] }] });
    assert.ok(r.markdown.includes("theme: default"));
  });
});

describe("buildPoster", () => {
  it("typst format + 列数 + sections", () => {
    const spec: PosterSpec = {
      title: "海报",
      authors: "甲, 乙",
      columns: 3,
      sections: [{ heading: "方法", bodyMd: "正文", figure: "/r/f.png" }],
    };
    const r = buildPoster(spec);
    assert.ok(r.markdown.includes("format:\n  typst:"));
    assert.ok(r.markdown.includes("#set page(columns: 3)"));
    assert.ok(r.markdown.includes("## 方法"));
    assert.ok(r.markdown.includes("![](/r/f.png)"));
    assert.equal(r.sectionCount, 1);
  });

  it("列数越界/NaN clamp 到 1~4", () => {
    const r = buildPoster({ title: "T", columns: 99, sections: [] });
    assert.ok(r.markdown.includes("#set page(columns: 4)"));
  });
});

describe("presAesthSlides", () => {
  it("要点过多 + 过长 + 生成式插画命中", () => {
    const deck: SlideDeck = {
      title: "T",
      slides: [
        { heading: "H", bullets: ["a", "b", "c", "d", "e", "f", "g"], figure: "/r/midjourney_cover.png" },
        { heading: "H2", bullets: ["很长".repeat(70)] },
      ],
    };
    const r = presAesthSlides(deck);
    assert.ok(r.findings.some((f) => f.kind === "dense-bullets"));
    assert.ok(r.findings.some((f) => f.kind === "long-bullet"));
    assert.ok(r.findings.some((f) => f.kind === "generated-illustration"));
    assert.ok(r.score > 0);
  });

  it("无标题命中", () => {
    const r = presAesthSlides({ title: "T", slides: [{ heading: "  ", bullets: ["x"] }] });
    assert.ok(r.findings.some((f) => f.kind === "no-heading"));
  });

  it("规范 deck 零命中", () => {
    const r = presAesthSlides({
      title: "T",
      slides: [{ heading: "背景", bullets: ["简短要点", "另一要点"], figure: "/r/fig1.png" }],
    });
    assert.equal(r.findings.length, 0);
    assert.equal(r.score, 0);
  });
});

describe("presAesthFigures", () => {
  it("生成式插画 + 无 caption 命中", () => {
    const figs: Figure[] = [
      { id: "f1", path: "/r/dalle-3-art.png", caption: "x", kind: "plot" },
      { id: "f2", path: "/r/plot.png", caption: "  ", kind: "plot" },
    ];
    const r = presAesthFigures(figs);
    assert.ok(r.findings.some((f) => f.kind === "generated-illustration"));
    assert.ok(r.findings.some((f) => f.kind === "no-figure"));
  });

  it("SciencePlots 图零命中", () => {
    const r = presAesthFigures([{ id: "f1", path: "/r/accuracy.png", caption: "准确率曲线", kind: "plot" }]);
    assert.equal(r.findings.length, 0);
  });
});
