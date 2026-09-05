#!/usr/bin/env node
// @generated-or-local codemod — 手工维护,零依赖,Node ≥ 18。
//
// 字号任意值 → 语义档位 token 的批量替换(web-react 设计系统收敛)。
//
//   node scripts/codemod-text-size-tokens.mjs --dry-run   # 只打印统计
//   node scripts/codemod-text-size-tokens.mjs             # 真改文件
//
// 范围:packages/web-react/src/**/*.{ts,tsx},排除 *.test.*、*.spec.*、
// Landing.tsx(营销页艺术排版)、tutorials/CaseArtwork.tsx(教程艺术场景)、
// browser-tests/**。
//
// 只处理 className 属性值区域(className="..." / className={cn(...)} /
// className={`...`},含 {} 内的嵌套字符串与 cn() 对象键如 {"text-[12px]": cond})。
// 变体前缀(md: / hover: / dark: …)原样保留,只把 text-[Npx] 段换成 token 类。
//
// 映射(styles.css @theme 为唯一权威,见「排版语义档位」注释):
//   10 / 10.5 → text-micro    11 / 11.5 → text-caption   12 / 12.5 → text-meta
//   13        → text-body     13.5      → text-section
//   14 / 15   → text-title
//   16px 刻意不映射:Tailwind v4 默认 text-lg(18px)已有 11 处标题用法,
//   覆盖 --text-lg: 16px 会把它们全部缩小;待单独定名(如 --text-lead)后再收敛。
//
// 行高语义:任意值 text-[Npx] 不带行高(继承父级),token 档带 @theme 行高。
// 这正是收敛目的之一(统一行高);但对已显式写 leading-* 的 className 串,
// 显式行高本来就会覆盖 token 行高、语义已完整,故整串保持不动,只计数。
// 未映射值(text-[9px] / text-[17px] / text-[clamp(...)] 等)不动,进 histogram。
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TARGET_ROOT = path.resolve(SCRIPT_DIR, "..", "packages", "web-react");

/** Npx 字面值 → 语义 token 工具类。 */
const TOKEN_BY_PX = {
  "10": "text-micro",
  "10.5": "text-micro",
  "11": "text-caption",
  "11.5": "text-caption",
  "12": "text-meta",
  "12.5": "text-meta",
  "13": "text-body",
  "13.5": "text-section",
  "14": "text-title",
  "15": "text-title",
};

/** 排除规则(相对 TARGET_ROOT 的 POSIX 路径或文件名)。 */
const EXCLUDE_FILES = new Set(["Landing.tsx", "CaseArtwork.tsx"]);
const EXCLUDE_DIRS = new Set(["browser-tests", "node_modules"]);
const isExcludedPath = (rel) =>
  rel.split("/").some((seg) => EXCLUDE_DIRS.has(seg)) ||
  /(\.test|\.spec)\.[cm]?[jt]sx?$/.test(rel) ||
  rel.endsWith("/Landing.tsx") ||
  rel.endsWith("/tutorials/CaseArtwork.tsx");

// ── 源码扫描:className 属性值区域 ─────────────────────────────────────────
// 不引 TS 解析器(零依赖)。区域 = className= 之后的 "…" / '…' / `…` / {…},
// {…} 与模板插值 ${…} 做配对扫描(识别嵌套字符串),保证区域边界可靠。

/** 从 src[start] 开始读一个"字符串/模板/花括号表达式"跨度,返回结束下标(开区间)。 */
function scanSpan(src, start) {
  const c = src[start];
  if (c === '"' || c === "'") {
    for (let i = start + 1; i < src.length; i++) {
      if (src[i] === "\\") i++; // 跳过转义
      else if (src[i] === c) return i + 1;
    }
    return src.length; // 未闭合(不应发生):吃到文件尾
  }
  if (c === "`") {
    for (let i = start + 1; i < src.length; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "$" && src[i + 1] === "{") i = scanSpan(src, i + 1); // 插值按表达式递归
      else if (src[i] === "`") return i + 1;
    }
    return src.length;
  }
  if (c === "{") {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        i = scanSpan(src, i) - 1; // 嵌套字符串整段跳过
      } else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i + 1;
      } else if (ch === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++; // 行注释
      } else if (ch === "/" && src[i + 1] === "*") {
        i = src.indexOf("*/", i + 2);
        if (i < 0) return src.length;
      }
    }
  }
  return start; // 不是可识别的值起点:零跨度,调用方跳过
}

/** 找出文件里所有 className 属性值区域(含嵌套表达式)。 */
function findClassNameRegions(src) {
  const regions = [];
  const re = /\bclassName\s*=/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++; // className = "…" 的空格
    if (i >= src.length) continue;
    const end = scanSpan(src, i);
    if (end > i) regions.push([i, end]);
  }
  return regions;
}

// ── 替换与统计 ─────────────────────────────────────────────────────────────

const ARBITRARY = /text-\[([^\]]*)\]/g;
const LEADING = /\bleading-[A-Za-z0-9[(]/; // 显式行高工具类(含任意值/中括号)

function codemodFile(src, stats, relPath) {
  const regions = findClassNameRegions(src);
  if (!regions.length) return null;
  // 先在整个区域文本上判定与计数,再统一替换;leading 命中的区域整段跳过。
  const edits = [];
  for (const [start, end] of regions) {
    const text = src.slice(start, end);
    ARBITRARY.lastIndex = 0;
    let m;
    const regionEdits = [];
    while ((m = ARBITRARY.exec(text))) {
      const raw = m[1].trim();
      // 映射只认 Npx 字面量(10 / 10.5 / 12.5…);clamp()/rem/颜色 hex 等进未映射统计。
      const px = /^-?\d+(\.\d+)?px$/.test(raw) ? raw.slice(0, -2) : null;
      const token = px !== null ? TOKEN_BY_PX[px] : undefined;
      if (token) {
        regionEdits.push([m.index, m.index + m[0].length, token, raw]);
      } else {
        stats.unmapped.set(raw, (stats.unmapped.get(raw) ?? 0) + 1);
      }
    }
    if (!regionEdits.length) continue;
    if (LEADING.test(text)) {
      stats.leadingSkipped += regionEdits.length;
      for (const [, , token, raw] of regionEdits) {
        const key = `text-[${raw}] → ${token}(串含 leading-*,整串跳过)`;
        stats.byMapping.set(key, (stats.byMapping.get(key) ?? 0) + 1);
      }
      continue;
    }
    // 区域内逐个替换(倒序应用保下标有效)。
    let out = text;
    for (const [from, to, token, raw] of [...regionEdits].sort((a, b) => b[0] - a[0])) {
      out = out.slice(0, from) + token + out.slice(to);
      stats.totalReplacements++;
      const key = `text-[${raw}] → ${token}`;
      stats.byMapping.set(key, (stats.byMapping.get(key) ?? 0) + 1);
    }
    edits.push([start, end, out]);
  }
  if (!edits.length) return null;
  let out = src;
  for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  stats.filesChanged.add(relPath);
  return out;
}

// ── 遍历与 CLI ─────────────────────────────────────────────────────────────

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.[cm]?tsx?$/.test(name) && !/\.d\.ts$/.test(name)) acc.push(full);
  }
  return acc;
}

const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");

const stats = {
  byMapping: new Map(),
  unmapped: new Map(),
  leadingSkipped: 0,
  totalReplacements: 0,
  filesChanged: new Set(),
};
const srcRoot = path.join(TARGET_ROOT, "src");
const files = walk(srcRoot).filter((f) => !isExcludedPath(path.relative(srcRoot, f).split(path.sep).join("/")));
let scanned = 0;
for (const file of files) {
  scanned++;
  const src = readFileSync(file, "utf8");
  const out = codemodFile(src, stats, path.relative(TARGET_ROOT, file));
  if (out !== null && out !== src && !dryRun) writeFileSync(file, out);
}

const lines = [];
lines.push(dryRun ? "== dry-run(未写文件)==" : "== 已写文件 ==");
lines.push(`扫描文件: ${scanned}(packages/web-react/src,排除 *.test.* / Landing.tsx / tutorials/CaseArtwork.tsx / browser-tests)`);
lines.push(`有替换的文件: ${stats.filesChanged.size}`);
lines.push(`替换总数: ${stats.totalReplacements}`);
lines.push(`含 leading-* 而整串跳过的替换: ${stats.leadingSkipped}`);
lines.push("");
lines.push("按映射明细(降序):");
for (const [k, v] of [...stats.byMapping.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${k}: ${v}`);
lines.push("");
lines.push("未映射值 histogram(降序,保持任意值不动):");
if (!stats.unmapped.size) lines.push("  (无)");
for (const [k, v] of [...stats.unmapped.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  text-[${k}]: ${v}`);
if (verbose) {
  lines.push("");
  lines.push("改动文件清单:");
  for (const f of [...stats.filesChanged].sort()) lines.push(`  ${f}`);
}
console.log(lines.join("\n"));
