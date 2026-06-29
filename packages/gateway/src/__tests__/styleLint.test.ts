/**
 * 去 AI 味 style lint 单测(软信号):套话/空泛堆叠/千篇一律结构/emoji;干净文本零命中。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lintAiTone } from "../styleLint.js";

describe("lintAiTone", () => {
  it("套话命中", () => {
    const r = lintAiTone("在当今快速发展的时代,本文将深入探讨这一问题。综上所述,结论如下。");
    assert.ok(r.findings.some((f) => f.kind === "cliche"));
    assert.ok(r.score > 0);
  });

  it("空泛强调词堆叠(≥2)命中", () => {
    const r = lintAiTone("这项工作至关重要,且不可或缺,意义重大。");
    assert.ok(r.findings.some((f) => f.kind === "filler-emphasis"));
  });

  it("单个空泛词不算堆叠", () => {
    const r = lintAiTone("样本量为 120,效应量 d=0.8,该差异至关重要。");
    assert.ok(!r.findings.some((f) => f.kind === "filler-emphasis"));
  });

  it("千篇一律分点结构(≥3)命中", () => {
    const r = lintAiTone("首先,数据来自 A。其次,方法为 B。最后,结论为 C。");
    assert.ok(r.findings.some((f) => f.kind === "formulaic"));
  });

  it("emoji 滥用(≥3)命中", () => {
    const r = lintAiTone("结果很好 🚀🎉✨,值得高兴 😀。");
    assert.ok(r.findings.some((f) => f.kind === "emoji"));
  });

  it("干净的学术文本零命中", () => {
    const r = lintAiTone(
      "我们在 ImageNet 上训练 ResNet-50,top-1 准确率达 76.3%(95% CI [75.8, 76.8]),较基线提升 1.2 个百分点。消融显示数据增强贡献主要增益。",
    );
    assert.equal(r.findings.length, 0);
    assert.equal(r.score, 0);
  });

  it("空文本零命中", () => {
    assert.equal(lintAiTone("").findings.length, 0);
    assert.equal(lintAiTone("   ").score, 0);
  });
});
