/**
 * oc-slides — 容器内确定性幻灯渲染 CLI(自建 Quarto/revealjs 流水线,多 design-token 主题)。
 *
 * 用法(baseline skill research-slides 文档化):
 *   oc-slides --deck <deck.json> [-o out.pptx|out.html]
 *   oc-slides --patch-slide <N> (--patch-json '<json>' | --patch-file <p.json> | --heading ... --bullets-json ... --figure ... --notes ...) [-o out.pptx|out.html] [--deck <deck.json>]
 *
 * 能力与安全红线(B9 + N5):
 *   - 安全 sidecar 发布(B9):校验输出目录与目标文件非符号链接;仅在 Quarto 渲染成功
 *     (或目标本身为 `.qmd`)后,通过同目录独占临时文件(`O_CREAT|O_EXCL|O_NOFOLLOW`) +
 *     原子 `renameSync` 发布 `<stem>.deck.json`,渲染失败绝不覆盖既有 sidecar;
 *   - 诚实 QA 摘要(N5):明确区分 `passed / failed / skipped`,绝不把“未运行或无法解析报告”
 *     伪装成 `passed`;页级 findings 按精确页码正则匹配(`^slide N(?:$|[^0-9])`),不把
 *     slide 10 混进 slide 1;对 patch JSON 执行运行时形状校验。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Slide, SlideDeck } from "@openclaude/protocol/research";
import { buildSlideDeck } from "./presentRender.js";
import { type AesthFinding, presAesthSlides } from "./presAesth.js";

const TOOL = "oc-slides";

export interface SlidePatch {
  heading?: string;
  bullets?: string[];
  addBullets?: string[];
  removeBulletIndices?: number[];
  figure?: string | null;
  clearFigure?: boolean;
  notes?: string | null;
  clearNotes?: boolean;
}

export type QaStatus = "passed" | "failed" | "skipped";

export interface ArtifactQaSummary {
  status: QaStatus;
  ran: boolean;
  passed?: boolean;
  failures?: Array<{ code: string; message: string }>;
  warnings?: Array<{ code: string; message: string }>;
  reason?: string;
}

export interface SlideQaSummary {
  status: QaStatus;
  passed: boolean;
  aesthPassed: boolean;
  score: number;
  issueCount: number;
  findings: AesthFinding[];
  patchedSlide?: number;
  patchedSlideFindings?: AesthFinding[];
  artifactQa: ArtifactQaSummary;
}

export interface OcSlidesRunResult {
  output: string;
  qmd: string;
  sidecar: string;
  sidecarUpdated: boolean;
  renderStatus: "ok" | "degraded_qmd" | "failed";
  slideCount: number;
  patchedSlide?: number;
  warnings: string[];
  qa: SlideQaSummary;
}

export interface OcSlidesDeps {
  whichImpl?: (bin: string) => boolean;
  runQuartoImpl?: (args: string[], cwd: string) => void;
  runArtifactQaImpl?: (outputPath: string) => ArtifactQaSummary;
}

function defaultWhich(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseArtifactQaJson(raw: string): {
  passed: boolean;
  failures: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
} | null {
  const startIdx = raw.indexOf("{");
  const endIdx = raw.lastIndexOf("}");
  if (startIdx < 0 || endIdx <= startIdx) return null;
  try {
    const parsed = JSON.parse(raw.slice(startIdx, endIdx + 1)) as {
      passed?: unknown;
      failures?: unknown;
      warnings?: unknown;
    };
    if (typeof parsed.passed !== "boolean") return null;
    return {
      passed: parsed.passed,
      failures: Array.isArray(parsed.failures) ? (parsed.failures as Array<{ code: string; message: string }>) : [],
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as Array<{ code: string; message: string }>) : [],
    };
  } catch {
    return null;
  }
}

function defaultRunArtifactQa(outputPath: string): ArtifactQaSummary {
  try {
    const out = execFileSync("oc-artifact-qa", ["deliver", "--input", outputPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseArtifactQaJson(out);
    if (!parsed) {
      // N5: 绝不把无法解析的 QA 输出默认判为 passed
      return {
        status: "failed",
        ran: true,
        passed: false,
        failures: [{ code: "artifact-qa-unparseable", message: "oc-artifact-qa produced unparseable report" }],
        warnings: [],
      };
    }
    return {
      status: parsed.passed ? "passed" : "failed",
      ran: true,
      passed: parsed.passed,
      failures: parsed.failures,
      warnings: parsed.warnings,
    };
  } catch (err) {
    const execErr = err as { stdout?: string };
    const parsed = parseArtifactQaJson(execErr.stdout ?? "");
    if (parsed) {
      return {
        status: parsed.passed ? "passed" : "failed",
        ran: true,
        passed: parsed.passed,
        failures: parsed.failures,
        warnings: parsed.warnings,
      };
    }
    return {
      status: "failed",
      ran: true,
      passed: false,
      failures: [{ code: "artifact-qa-failed", message: "oc-artifact-qa deliver returned non-zero" }],
      warnings: [],
    };
  }
}

function flagVal(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/** 计算与输出文件同目录的 `.deck.json` sidecar 路径。 */
export function resolveDeckSidecarPath(outputPath: string): string {
  const abs = path.resolve(outputPath);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const stem = base.endsWith(".deck.json")
    ? base.slice(0, -".deck.json".length)
    : base.replace(/\.[^.]+$/, "");
  return path.join(dir, `${stem}.deck.json`);
}

/**
 * 安全原子写入(B9):拒绝输出目录或目标路径为符号链接,写独占临时文件后原子 rename 发布。
 */
function writeDerivedFileSafely(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`refusing to write derived file into symlinked directory: ${dir}`);
  }
  if (existsSync(targetPath)) {
    const existing = lstatSync(targetPath);
    if (existing.isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink target: ${targetPath}`);
    }
    if (!existing.isFile()) {
      throw new Error(`refusing to overwrite non-regular file target: ${targetPath}`);
    }
  }
  const tmpName = `.${path.basename(targetPath)}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, flags, 0o600);
    writeSync(fd, content, null, "utf8");
    closeSync(fd);
    fd = null;
    // rename 前再次确认目标非符号链接
    if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink target: ${targetPath}`);
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** 运行时校验 SlidePatch JSON 形状(N5)。 */
export function validateSlidePatch(raw: unknown): SlidePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("slide patch must be a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  const out: SlidePatch = {};
  if (rec.heading !== undefined) {
    if (typeof rec.heading !== "string") throw new Error("patch.heading must be a string");
    out.heading = rec.heading;
  }
  if (rec.bullets !== undefined) {
    if (!Array.isArray(rec.bullets) || !rec.bullets.every((b) => typeof b === "string")) {
      throw new Error("patch.bullets must be a string array");
    }
    out.bullets = rec.bullets;
  }
  if (rec.addBullets !== undefined) {
    if (!Array.isArray(rec.addBullets) || !rec.addBullets.every((b) => typeof b === "string")) {
      throw new Error("patch.addBullets must be a string array");
    }
    out.addBullets = rec.addBullets;
  }
  if (rec.removeBulletIndices !== undefined) {
    if (
      !Array.isArray(rec.removeBulletIndices) ||
      !rec.removeBulletIndices.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0)
    ) {
      throw new Error("patch.removeBulletIndices must be a non-negative integer array");
    }
    out.removeBulletIndices = rec.removeBulletIndices;
  }
  if (rec.figure !== undefined) {
    if (rec.figure !== null && typeof rec.figure !== "string") {
      throw new Error("patch.figure must be a string or null");
    }
    out.figure = rec.figure;
  }
  if (rec.clearFigure !== undefined) {
    if (typeof rec.clearFigure !== "boolean") throw new Error("patch.clearFigure must be a boolean");
    out.clearFigure = rec.clearFigure;
  }
  if (rec.notes !== undefined) {
    if (rec.notes !== null && typeof rec.notes !== "string") {
      throw new Error("patch.notes must be a string or null");
    }
    out.notes = rec.notes;
  }
  if (rec.clearNotes !== undefined) {
    if (typeof rec.clearNotes !== "boolean") throw new Error("patch.clearNotes must be a boolean");
    out.clearNotes = rec.clearNotes;
  }
  return out;
}

/**
 * 纯函数:对 1-based 指定页 `slideNumber` 做不可变局部 patch,其余页原样保留。
 */
export function patchSlideInDeck(
  deck: SlideDeck,
  slideNumber: number,
  patch: SlidePatch,
): SlideDeck {
  if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > deck.slides.length) {
    throw new Error(
      `slide index ${slideNumber} out of range (deck has ${deck.slides.length} slides; 1-based)`,
    );
  }
  const targetIdx = slideNumber - 1;
  const orig = deck.slides[targetIdx]!;

  let nextBullets = patch.bullets !== undefined ? [...patch.bullets] : [...orig.bullets];
  if (Array.isArray(patch.removeBulletIndices) && patch.removeBulletIndices.length > 0) {
    const removeSet = new Set(patch.removeBulletIndices);
    nextBullets = nextBullets.filter((_, idx) => !removeSet.has(idx));
  }
  if (Array.isArray(patch.addBullets) && patch.addBullets.length > 0) {
    nextBullets.push(...patch.addBullets);
  }

  const nextSlide: Slide = {
    heading: patch.heading !== undefined ? patch.heading : orig.heading,
    bullets: nextBullets,
    ...(patch.clearFigure || patch.figure === null
      ? {}
      : patch.figure !== undefined
        ? { figure: patch.figure }
        : orig.figure !== undefined
          ? { figure: orig.figure }
          : {}),
    ...(patch.clearNotes || patch.notes === null
      ? {}
      : patch.notes !== undefined
        ? { notes: patch.notes }
        : orig.notes !== undefined
          ? { notes: orig.notes }
          : {}),
  };

  return {
    ...deck,
    slides: deck.slides.map((s, idx) => (idx === targetIdx ? nextSlide : { ...s, bullets: [...s.bullets] })),
  };
}

function parsePatchFromArgs(args: readonly string[]): SlidePatch {
  const patchFile = flagVal(args, "--patch-file");
  const patchJson = flagVal(args, "--patch-json");
  let base: SlidePatch = {};
  if (patchFile) {
    base = validateSlidePatch(JSON.parse(readFileSync(patchFile, "utf8")));
  } else if (patchJson) {
    base = validateSlidePatch(JSON.parse(patchJson));
  }

  const heading = flagVal(args, "--heading");
  const bulletsJson = flagVal(args, "--bullets-json");
  const figure = flagVal(args, "--figure");
  const notes = flagVal(args, "--notes");
  const clearFigure = hasFlag(args, "--clear-figure");
  const clearNotes = hasFlag(args, "--clear-notes");

  const merged: SlidePatch = { ...base };
  if (heading !== undefined) merged.heading = heading;
  if (bulletsJson !== undefined) {
    const parsed = JSON.parse(bulletsJson) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((b) => typeof b === "string")) {
      throw new Error("--bullets-json must be a JSON string array");
    }
    merged.bullets = parsed;
  }
  if (figure !== undefined) merged.figure = figure;
  if (notes !== undefined) merged.notes = notes;
  if (clearFigure) merged.clearFigure = true;
  if (clearNotes) merged.clearNotes = true;

  if (
    merged.heading === undefined &&
    merged.bullets === undefined &&
    merged.addBullets === undefined &&
    merged.removeBulletIndices === undefined &&
    merged.figure === undefined &&
    merged.notes === undefined &&
    !merged.clearFigure &&
    !merged.clearNotes
  ) {
    throw new Error("--patch-slide requires --patch-json, --patch-file, or at least one slide field flag");
  }
  return merged;
}

/** 精确按 1-based 页码过滤 PresAesth findings(防 `slide 1` 误匹配 `slide 10`)。 */
export function filterFindingsForSlide(findings: readonly AesthFinding[], slideNum: number): AesthFinding[] {
  const re = new RegExp(`^slide ${slideNum}(?:$|[^0-9])`);
  return findings.filter((f) => re.test(f.where));
}

/** 执行 oc-slides 核心逻辑(可注入 deps 单测,不调用 process.exit)。 */
export function runOcSlides(args: readonly string[], deps: OcSlidesDeps = {}): OcSlidesRunResult {
  const output = flagVal(args, "-o") ?? flagVal(args, "--output") ?? "slides.html";
  const deckFileFlag = flagVal(args, "--deck");
  const patchSlideRaw = flagVal(args, "--patch-slide");
  const skipArtifactQa = hasFlag(args, "--skip-artifact-qa");

  const sidecarPath = resolveDeckSidecarPath(output);
  const patchSlideNum = patchSlideRaw !== undefined ? Number(patchSlideRaw) : undefined;
  if (patchSlideRaw !== undefined && (!Number.isInteger(patchSlideNum) || (patchSlideNum as number) < 1)) {
    throw new Error(`invalid --patch-slide value: ${patchSlideRaw} (must be a positive 1-based integer)`);
  }

  const sourceDeckPath = deckFileFlag ?? (patchSlideNum !== undefined ? sidecarPath : undefined);
  if (!sourceDeckPath) {
    throw new Error("usage: oc-slides --deck <deck.json> [-o out.pptx|out.html]");
  }
  if (!existsSync(sourceDeckPath)) {
    throw new Error(`deck source not found: ${sourceDeckPath}`);
  }

  let deck: SlideDeck;
  try {
    deck = JSON.parse(readFileSync(sourceDeckPath, "utf8")) as SlideDeck;
  } catch {
    throw new Error(`cannot read/parse ${sourceDeckPath}`);
  }

  if (patchSlideNum !== undefined) {
    const patch = parsePatchFromArgs(args);
    deck = patchSlideInDeck(deck, patchSlideNum, patch);
  }

  const built = buildSlideDeck(deck);
  const aesth = presAesthSlides(deck);
  const warnings = aesth.findings.map((f) => `美学[${f.kind}] ${f.where}: ${f.hint}`);

  const absOut = path.resolve(output);
  const ext = absOut.toLowerCase().split(".").pop() ?? "html";
  const dir = path.dirname(absOut);
  const stem = path.basename(absOut).replace(/\.[^.]+$/, "");
  const existingDeliveryPresent = ext !== "qmd" && existsSync(absOut);

  // 先做输出目录与目标 sidecar 符号链接前置校验(B9)
  if (existsSync(sidecarPath) && lstatSync(sidecarPath).isSymbolicLink()) {
    throw new Error(`refusing to overwrite symlink sidecar: ${sidecarPath}`);
  }

  const qmd = path.join(dir, `${stem}.qmd`);
  writeDerivedFileSafely(qmd, built.markdown);

  const whichFn = deps.whichImpl ?? defaultWhich;
  const runQuarto =
    deps.runQuartoImpl ??
    ((qArgs: string[], cwd: string) => {
      execFileSync("quarto", qArgs, { cwd, stdio: "pipe" });
    });

  let finalPath = qmd;
  let renderStatus: "ok" | "degraded_qmd" | "failed" = "ok";
  if (ext !== "qmd") {
    if (whichFn("quarto")) {
      const to = ext === "pptx" ? "pptx" : "revealjs";
      try {
        runQuarto(["render", qmd, "--to", to, "--output", path.basename(absOut)], dir);
        finalPath = path.join(dir, path.basename(absOut));
        renderStatus = "ok";
      } catch {
        // B9: 渲染失败时绝不覆盖既有 .deck.json sidecar,防止旧产物与新源错配!
        renderStatus = "failed";
        warnings.push(`quarto render → ${ext} 失败,已保留既有 sidecar 未覆盖`);
      }
    } else {
      renderStatus = "degraded_qmd";
      warnings.push(
        existingDeliveryPresent
          ? `未检测到 quarto 且输出位置已有 ${path.basename(absOut)},产出 .qmd 草稿并保留既有 sidecar 未覆盖`
          : "未检测到 quarto,产出 .qmd(降级)",
      );
    }
  }

  // B9: 仅在目标交付本次实际渲染成功(或目标就是 .qmd / 首次生成 .qmd 草稿且尚无既有交付物)时
  // 安全原子发布 .deck.json sidecar;既有 PPTX/HTML 保留而未执行新渲染时绝不覆写既有 sidecar!
  let sidecarUpdated = false;
  const shouldWriteSidecar =
    renderStatus === "ok" ||
    (renderStatus === "degraded_qmd" && patchSlideNum === undefined && !existingDeliveryPresent);
  if (shouldWriteSidecar) {
    writeDerivedFileSafely(sidecarPath, `${JSON.stringify(deck, null, 2)}\n`);
    sidecarUpdated = true;
  }

  // N5: 诚实区分 artifactQa 的 passed / failed / skipped
  let artifactQa: ArtifactQaSummary;
  if (renderStatus === "failed") {
    artifactQa = {
      status: "failed",
      ran: false,
      passed: false,
      failures: [{ code: "render-failed", message: `quarto render → ${ext} failed` }],
      warnings: [],
    };
  } else if (ext !== "pptx" || !finalPath.endsWith(".pptx")) {
    artifactQa = {
      status: "skipped",
      ran: false,
      reason: ext === "pptx" ? "pptx not produced (degraded to qmd)" : `artifact QA only applies to .pptx (got .${ext})`,
    };
  } else if (skipArtifactQa) {
    artifactQa = { status: "skipped", ran: false, reason: "skipped by --skip-artifact-qa" };
  } else if (deps.runArtifactQaImpl) {
    artifactQa = deps.runArtifactQaImpl(finalPath);
  } else if (whichFn("oc-artifact-qa")) {
    artifactQa = defaultRunArtifactQa(finalPath);
  } else {
    artifactQa = { status: "skipped", ran: false, reason: "oc-artifact-qa unavailable" };
  }

  const patchedSlideFindings =
    patchSlideNum !== undefined ? filterFindingsForSlide(aesth.findings, patchSlideNum) : undefined;

  const aesthPassed = aesth.findings.length === 0;
  let qaStatus: QaStatus;
  if (!aesthPassed || renderStatus === "failed" || artifactQa.status === "failed") {
    qaStatus = "failed";
  } else if (ext === "pptx" && artifactQa.status === "skipped") {
    qaStatus = "skipped";
  } else {
    qaStatus = "passed";
  }

  const qa: SlideQaSummary = {
    status: qaStatus,
    passed: qaStatus === "passed",
    aesthPassed,
    score: aesth.score,
    issueCount: aesth.findings.length + (artifactQa.failures?.length ?? 0),
    findings: aesth.findings,
    ...(patchSlideNum !== undefined ? { patchedSlide: patchSlideNum, patchedSlideFindings } : {}),
    artifactQa,
  };

  return {
    output: finalPath,
    qmd,
    sidecar: sidecarPath,
    sidecarUpdated,
    renderStatus,
    slideCount: built.slideCount,
    ...(patchSlideNum !== undefined ? { patchedSlide: patchSlideNum } : {}),
    warnings,
    qa,
  };
}

function fail(msg: string): never {
  process.stderr.write(`${TOOL}: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(
      "usage: oc-slides --deck <deck.json> [-o out.pptx|out.html]\n" +
        "       oc-slides --patch-slide <N> --patch-json '<json>' [-o out.pptx|out.html] [--deck <deck.json>]\n",
    );
    process.exit(0);
  }
  try {
    const result = runOcSlides(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${result.output}\n`);
    if (result.renderStatus === "failed") {
      process.exit(1);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}
