/**
 * oc-slides sidecar 安全发布 + --patch-slide 局部修订 + 诚实 QA 摘要单测(OCV5-828 R2 · B9 + N5)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ocSlidesCli.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { SlideDeck } from "@openclaude/protocol/research";
import {
  filterFindingsForSlide,
  patchSlideInDeck,
  resolveDeckSidecarPath,
  runOcSlides,
  validateSlidePatch,
} from "../ocSlidesCli.js";

describe("ocSlidesCli sidecar, --patch-slide, B9 safety & N5 QA honesty", () => {
  it("writes sibling .deck.json sidecar AFTER render succeeds, patches a single slide, and preserves sidecar on render failure (B9)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-slides-test-"));
    try {
      const deckPath = path.join(dir, "input.json");
      const outPptx = path.join(dir, "report.pptx");
      const initialDeck: SlideDeck = {
        title: "年度研究汇报",
        theme: "nature",
        slides: [
          { heading: "背景", bullets: ["问题定义", "研究动机"], notes: "开场白" },
          {
            heading: "实验结果",
            bullets: ["1", "2", "3", "4", "5", "6", "7"], // triggers dense-bullets
            figure: "/figs/result.png",
          },
          { heading: "总结", bullets: ["核心结论"] },
        ],
      };
      writeFileSync(deckPath, JSON.stringify(initialDeck, null, 2));

      let quartoCalls = 0;
      let shouldFailQuarto = false;
      const deps = {
        whichImpl: (bin: string) => bin === "quarto" || bin === "oc-artifact-qa",
        runQuartoImpl: (_args: string[], cwd: string) => {
          quartoCalls += 1;
          if (shouldFailQuarto) throw new Error("quarto exploded");
          writeFileSync(path.join(cwd, "report.pptx"), "PK\x03\x04fake-pptx");
        },
        runArtifactQaImpl: () => ({
          status: "passed" as const,
          ran: true,
          passed: true,
          failures: [],
          warnings: [],
        }),
      };

      // 1) Initial full render
      const r1 = runOcSlides(["--deck", deckPath, "-o", outPptx], deps);
      const expectedSidecar = resolveDeckSidecarPath(outPptx);
      assert.equal(r1.sidecar, expectedSidecar);
      assert.equal(r1.sidecarUpdated, true);
      assert.equal(r1.renderStatus, "ok");
      assert.equal(existsSync(expectedSidecar), true);
      assert.equal(r1.qa.status, "failed"); // dense-bullets
      assert.equal(r1.qa.passed, false);
      assert.equal(r1.qa.artifactQa.status, "passed");

      // 2) Patch slide 2 → succeeds and updates sidecar
      const r2 = runOcSlides(
        [
          "--patch-slide",
          "2",
          "--patch-json",
          JSON.stringify({
            heading: "核心实验结果",
            bullets: ["精度提升 12.4%", "延迟下降 35%"],
            notes: "重点强调消融实验",
          }),
          "-o",
          outPptx,
        ],
        deps,
      );
      assert.equal(r2.renderStatus, "ok");
      assert.equal(r2.sidecarUpdated, true);
      assert.equal(r2.qa.status, "passed");
      assert.equal(r2.qa.passed, true);
      assert.equal(quartoCalls, 2);

      // 3) B9: Render failure during --patch-slide MUST NOT overwrite existing sidecar!
      shouldFailQuarto = true;
      const r3 = runOcSlides(
        ["--patch-slide", "2", "--heading", "失败草稿标题", "-o", outPptx],
        deps,
      );
      assert.equal(r3.renderStatus, "failed");
      assert.equal(r3.sidecarUpdated, false);
      assert.equal(r3.qa.status, "failed");
      assert.equal(r3.qa.passed, false);
      const persistedAfterFail = JSON.parse(readFileSync(expectedSidecar, "utf8")) as SlideDeck;
      assert.equal(persistedAfterFail.slides[1]?.heading, "核心实验结果"); // unchanged!

      // 4) N5: --skip-artifact-qa reports qa.status === 'skipped' (NEVER falsely 'passed')
      shouldFailQuarto = false;
      const r4 = runOcSlides(
        ["--patch-slide", "1", "--heading", "研究背景", "--skip-artifact-qa", "-o", outPptx],
        deps,
      );
      assert.equal(r4.qa.artifactQa.status, "skipped");
      assert.equal(r4.qa.status, "skipped");
      assert.equal(r4.qa.passed, false);

      // 5) B9: Normal `--deck v2.json -o report.pptx` when report.pptx ALREADY EXISTS and Quarto is missing
      //    MUST NOT overwrite existing report.deck.json sidecar with v2!
      const v2DeckPath = path.join(dir, "v2.json");
      writeFileSync(
        v2DeckPath,
        JSON.stringify({
          title: "第二版未渲染草稿",
          slides: [{ heading: "V2 新标题", bullets: ["新要点"] }],
        }),
      );
      const r5 = runOcSlides(["--deck", v2DeckPath, "-o", outPptx], {
        whichImpl: () => false, // Quarto unavailable
      });
      assert.equal(r5.renderStatus, "degraded_qmd");
      assert.equal(r5.sidecarUpdated, false);
      const sidecarAfterDegraded = JSON.parse(readFileSync(expectedSidecar, "utf8")) as SlideDeck;
      assert.equal(sidecarAfterDegraded.title, "年度研究汇报"); // STILL matches existing report.pptx!
      assert.equal(sidecarAfterDegraded.slides[0]?.heading, "研究背景");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B9: refuses overwriting a symlinked .deck.json sidecar", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-slides-sym-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oc-slides-out-"));
    try {
      const secretTarget = path.join(outside, "victim.json");
      writeFileSync(secretTarget, '{"untouched":true}');
      const deckPath = path.join(dir, "in.json");
      writeFileSync(deckPath, JSON.stringify({ title: "T", slides: [{ heading: "H", bullets: ["a"] }] }));
      const outPptx = path.join(dir, "deck.pptx");
      symlinkSync(secretTarget, resolveDeckSidecarPath(outPptx));

      assert.throws(
        () =>
          runOcSlides(["--deck", deckPath, "-o", outPptx], {
            whichImpl: () => false,
          }),
        /symlink/i,
      );
      assert.equal(readFileSync(secretTarget, "utf8"), '{"untouched":true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("N5: exact slide number matching (slide 1 does not match slide 10) and runtime patch validation", () => {
    const findings = [
      { kind: "dense-bullets" as const, where: "slide 1「背景」", hint: "h1" },
      { kind: "dense-bullets" as const, where: "slide 10「附录」", hint: "h10" },
      { kind: "no-heading" as const, where: "slide 1", hint: "h1b" },
    ];
    assert.deepEqual(
      filterFindingsForSlide(findings, 1).map((f) => f.where),
      ["slide 1「背景」", "slide 1"],
    );
    assert.deepEqual(
      filterFindingsForSlide(findings, 10).map((f) => f.where),
      ["slide 10「附录」"],
    );

    assert.throws(() => validateSlidePatch("not-an-object"), /JSON object/);
    assert.throws(() => validateSlidePatch({ bullets: "bad" }), /string array/);
    assert.throws(() => validateSlidePatch({ removeBulletIndices: [-1] }), /non-negative integer/);

    const deck: SlideDeck = { title: "T", slides: [{ heading: "H1", bullets: ["a"] }] };
    assert.throws(() => patchSlideInDeck(deck, 0, { heading: "X" }), /out of range/);
    assert.throws(() => patchSlideInDeck(deck, 2, { heading: "X" }), /out of range/);
  });
});
