/**
 * oc-report — 容器内确定性报告渲染 CLI。
 *
 * 输入 ReportSchema(LLM 产的结构)+ master 已检 EvidenceManifest → 引擎排版:
 * 章节/编号/交叉引用/参考文献由引擎保证,未接地 claim 红标(fail-closed)。
 * 用法(baseline skill research-report 文档化):
 *   oc-report --schema <schema.json> --manifest <manifest.json> [-o out.pdf|out.docx|out.md|out.html]
 *
 * 渲染:有 quarto/pandoc(运行时镜像内常驻)→ PDF/docx/HTML;否则产出 .md(降级,仍可读)。
 * 引用接地是确定性层职责 —— 不让 LLM 即兴排版或编造引用。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceManifest, ReportSchema } from "@openclaude/protocol/research";
import { buildReportDocument } from "./reportRender.js";

const TOOL = "oc-report";

function fail(msg: string): never {
  process.stderr.write(`${TOOL}: ${msg}\n`);
  process.exit(1);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) flags[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("-") ? args[(i += 1)] : "true";
    else if (a === "-o") flags.output = args[(i += 1)] ?? "";
  }
  return flags;
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    fail(`cannot read/parse ${file}`);
  }
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
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.schema || !flags.manifest) fail("usage: oc-report --schema <f> --manifest <f> [-o out.{pdf,docx,html,md}]");
  const schema = readJson<ReportSchema>(flags.schema);
  // oc-cite check/fix 的输出是 { manifest: {...} }(外层包了一层);直接传它即可,这里自动取
  // 内层 .manifest(省去用户手动 extract——boss #faa3c041 折腾的步骤)。已是裸 manifest 则原样用。
  const rawManifest = readJson<Record<string, unknown>>(flags.manifest);
  const manifest = (
    rawManifest && typeof rawManifest === "object" && !Array.isArray(rawManifest) && rawManifest.manifest
      ? rawManifest.manifest
      : rawManifest
  ) as EvidenceManifest;

  const built = buildReportDocument(schema, manifest);
  const output = flags.output && flags.output !== "true" ? flags.output : "report.md";
  const ext = output.toLowerCase().split(".").pop() ?? "md";
  const dir = path.dirname(path.resolve(output));
  const stem = path.basename(output).replace(/\.[^.]+$/, "");
  const mdPath = path.join(dir, `${stem}.qmd`);
  writeFileSync(mdPath, built.markdown, "utf8");
  // manifest sidecar:前端产物卡经 /api/media-sign 取它渲染引用接地视图(claim↔证据/闸门/文献库)。
  // 走文件而非 stdout —— manifest 含全文 quote,可到几十 KB,stdout preview 会被截断。
  const manifestPath = path.join(dir, `${stem}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  let finalPath = mdPath;
  if (ext === "md" || ext === "qmd") {
    finalPath = mdPath;
  } else if (which("quarto")) {
    try {
      execFileSync("quarto", ["render", mdPath, "--to", ext === "pdf" ? "pdf" : ext, "--output", path.basename(output)], {
        cwd: dir,
        stdio: "pipe",
      });
      finalPath = path.join(dir, path.basename(output));
    } catch {
      built.warnings.push(`quarto render → ${ext} 失败,已产出 .qmd(可手动渲染)`);
    }
  } else if (which("pandoc")) {
    try {
      execFileSync("pandoc", [mdPath, "-o", path.resolve(output), "--toc", "--number-sections"], { stdio: "pipe" });
      finalPath = path.resolve(output);
    } catch {
      built.warnings.push(`pandoc → ${ext} 失败,已产出 .qmd`);
    }
  } else {
    built.warnings.push("未检测到 quarto/pandoc,产出 .qmd(降级)");
  }

  process.stdout.write(
    `${JSON.stringify({ output: finalPath, qmd: mdPath, manifestPath, coverage: manifest.coverage, stats: built.stats, references: built.references.length, warnings: built.warnings }, null, 2)}\n`,
  );
  // 把产物绝对路径单独成行打印,前端渲染成文件卡片(与 scansci-pdf 约定一致)
  process.stdout.write(`${finalPath}\n`);
}

try {
  main();
} catch (e) {
  // 任何错误(含 buildReportDocument 的 manifest 校验)都走 fail() 输出干净可操作信息,
  // 不再向用户/agent 抛裸 TypeError 栈(boss #faa3c041 见过 3 次)。
  fail(e instanceof Error ? e.message : String(e));
}
