/**
 * oc-slides — 容器内确定性幻灯渲染 CLI(自建 Quarto/revealjs 流水线,多 design-token 主题)。
 *
 * 用法(baseline skill research-slides 文档化):
 *   oc-slides --deck <deck.json> [-o out.pptx|out.html]
 *
 * deck = SlideDeck(标题/主题/slides[heading,bullets,figure?,notes?])。引擎据主题排版,
 * PresAesth 软信号(每页要点过多/疑似生成式插画)进 warnings。无 quarto → 产 .qmd。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SlideDeck } from "@openclaude/protocol/research";
import { buildSlideDeck } from "./presentRender.js";
import { presAesthSlides } from "./presAesth.js";

const TOOL = "oc-slides";

function fail(msg: string): never {
  process.stderr.write(`${TOOL}: ${msg}\n`);
  process.exit(1);
}

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function which(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const deckFile = flagVal(args, "--deck");
  const output = flagVal(args, "-o") ?? flagVal(args, "--output") ?? "slides.html";
  if (!deckFile) fail("usage: oc-slides --deck <deck.json> [-o out.pptx|out.html]");
  let deck: SlideDeck;
  try {
    deck = JSON.parse(readFileSync(deckFile, "utf8")) as SlideDeck;
  } catch {
    fail(`cannot read/parse ${deckFile}`);
  }

  const built = buildSlideDeck(deck);
  const warnings = presAesthSlides(deck).findings.map((f) => `美学[${f.kind}] ${f.where}: ${f.hint}`);

  const ext = output.toLowerCase().split(".").pop() ?? "html";
  const dir = path.dirname(path.resolve(output));
  const stem = path.basename(output).replace(/\.[^.]+$/, "");
  const qmd = path.join(dir, `${stem}.qmd`);
  writeFileSync(qmd, built.markdown, "utf8");

  let finalPath = qmd;
  if (ext !== "qmd" && which("quarto")) {
    const to = ext === "pptx" ? "pptx" : "revealjs";
    try {
      execFileSync("quarto", ["render", qmd, "--to", to, "--output", path.basename(output)], {
        cwd: dir,
        stdio: "pipe",
      });
      finalPath = path.join(dir, path.basename(output));
    } catch {
      warnings.push(`quarto render → ${ext} 失败,已产出 .qmd`);
    }
  } else if (ext !== "qmd") {
    warnings.push("未检测到 quarto,产出 .qmd(降级)");
  }

  process.stdout.write(`${JSON.stringify({ output: finalPath, qmd, slideCount: built.slideCount, warnings }, null, 2)}\n`);
  process.stdout.write(`${finalPath}\n`);
}

main();
