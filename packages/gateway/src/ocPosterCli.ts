/**
 * oc-poster — 容器内确定性学术海报渲染 CLI(自建 Quarto/typst 流水线)。
 *
 * 用法(baseline skill research-slides 文档化):
 *   oc-poster --spec <poster.json> [-o out.pdf]
 *
 * spec = PosterSpec(标题/作者/列数/sections[heading,bodyMd,figure?])。Quarto≥1.4 内置
 * typst,无需单独装。PresAesth 软信号进 warnings。无 quarto → 产 .qmd。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Figure, PosterSpec } from "@openclaude/protocol/research";
import { buildPoster } from "./presentRender.js";
import { presAesthFigures } from "./presAesth.js";

const TOOL = "oc-poster";

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
  const specFile = flagVal(args, "--spec");
  const output = flagVal(args, "-o") ?? flagVal(args, "--output") ?? "poster.pdf";
  if (!specFile) fail("usage: oc-poster --spec <poster.json> [-o out.pdf]");
  let spec: PosterSpec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8")) as PosterSpec;
  } catch {
    fail(`cannot read/parse ${specFile}`);
  }

  const built = buildPoster(spec);
  // 海报配图复用图表美学闸(禁生成式插画)
  const figs: Figure[] = spec.sections
    .filter((s) => s.figure)
    .map((s, i) => ({ id: `p${i}`, path: s.figure as string, caption: s.heading, kind: "plot" as const }));
  const warnings = presAesthFigures(figs).findings.map((f) => `美学[${f.kind}] ${f.where}: ${f.hint}`);

  const ext = output.toLowerCase().split(".").pop() ?? "pdf";
  const dir = path.dirname(path.resolve(output));
  const stem = path.basename(output).replace(/\.[^.]+$/, "");
  const qmd = path.join(dir, `${stem}.qmd`);
  writeFileSync(qmd, built.markdown, "utf8");

  let finalPath = qmd;
  if (ext !== "qmd" && which("quarto")) {
    try {
      execFileSync("quarto", ["render", qmd, "--to", "typst", "--output", path.basename(output)], {
        cwd: dir,
        stdio: "pipe",
      });
      finalPath = path.join(dir, path.basename(output));
    } catch {
      warnings.push("quarto render → pdf(typst) 失败,已产出 .qmd");
    }
  } else if (ext !== "qmd") {
    warnings.push("未检测到 quarto,产出 .qmd(降级)");
  }

  process.stdout.write(
    `${JSON.stringify({ output: finalPath, qmd, sectionCount: built.sectionCount, warnings }, null, 2)}\n`,
  );
  process.stdout.write(`${finalPath}\n`);
}

main();
