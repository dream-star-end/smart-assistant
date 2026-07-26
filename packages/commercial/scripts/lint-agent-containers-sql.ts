#!/usr/bin/env tsx
/**
 * V3 Phase 3M — agent_containers reader audit lint(MVP single-track 版)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9 Task 3M(R6.7 (a) 子集 — MVP 仅保留
 * "5 行内显式 state filter"硬规则;R6.11 (b)(c)(d) 二选一 + open-migration
 * predicate + RECONCILER_WHITELIST + 负例 fixture 全部为 multi-host migration
 * 服务,推迟到 P1 一并落地)。
 *
 * 规则:
 *   `commercial/src/**` 下任意 .ts 文件中,凡出现 `FROM agent_containers` 或
 *   `JOIN agent_containers`(大小写不敏感),必须有显式 `state` 字面量为伴。
 *
 *   理由:v3 schema (0012) 把 agent_containers.state ∈ {active, vanished};
 *   user-facing reader 漏 state filter 会把 vanished 行渗给用户视图 / 计费聚合。
 *
 * 判定作用域(2026-07-26 修正 —— 见下「窗口方向盲区」):
 *   ① 若关键词落在一段 JS 字符串字面量(模板串 / 引号串)里,该字面量即 SQL 语句
 *      的自然边界:
 *        · 字面量内只有 1 处关键词 → 整条语句里出现 `state` 即算显式(SELECT 列表
 *          里的 `ac.state` 也算数);
 *        · 字面量内有 ≥2 处关键词(多 CTE / UNION 多腿)→ 退回逐处 ±N 行窗口
 *          (窗口裁剪到该字面量范围内),避免"一条腿过滤了 state 就替另一条腿背书"。
 *   ② 关键词不在任何字符串字面量里(注释、拼接片段)→ 沿用原「本行 + 后 N-1 行」窗口。
 *
 *   为什么要改:原规则只向下看 5 行,而 SQL 最常见写法是
 *   `SELECT ac.state ... FROM agent_containers ac` —— state 在 FROM **上方**。
 *   这是一整类系统性误报(实测 7 处违规里有 3 处属此类),不修就只能靠白名单堆,
 *   白名单一堆这门就名存实亡。
 *
 * 例外(两级,都要求写明理由):
 *   · LEGACY_V2_FILES:整文件走 v2 老 schema 的 `status` 列,硬编码白名单;
 *   · 行内 waiver:在关键词行本身、或其上方 WAIVER_LOOKBEHIND_LINES 行内写注释
 *     `lint-agent-containers-sql: allow — <理由>`。理由不能为空。
 *     **未被任何违规消费的 waiver 一律报错**(stale waiver = 假安全感),
 *     代码改好了就必须把 waiver 删掉。
 *
 * 新增 waiver 的判据(review 时逐条对照,任一不满足就不许加):
 *   (1) 该读取**不进用户可见视图、不进计费/配额聚合**(运维回收、拓扑反推、
 *       admin 明确按 v2 `status` 分腿统计等);
 *   (2) 若确实需要看到 vanished 行,理由里写清"为什么必须看到";
 *   (3) 理由里写清读取结果流向何处(谁消费),让下一个人能复核。
 *
 * 不扫:`__tests__/`、`scripts/` 自身(测试 fixture / lint 自身)。
 *
 * 使用:
 *   tsx packages/commercial/scripts/lint-agent-containers-sql.ts
 *   退出 0 = 清洁;退出 1 = 有违规或 stale waiver(printed to stderr)。
 *
 * 测试:packages/commercial/src/__tests__/lintAgentContainersSql.test.ts
 *   纯函数 lintFile / lintFileDetailed 单测,fixture 含正负例。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** 显式 state 检查的"下方"窗口大小,sql 多行写法 5 行足够。 */
export const STATE_WINDOW_LINES = 5;

/**
 * v2 legacy 文件白名单 — 这些文件用 0005 老 schema 的 `status` 列,与 v3
 * `state` 列正交,本 lint 不管。MVP 单轨期内 v2 product 仍在线,不删。
 *
 * 路径相对 `packages/commercial/src/`。
 */
export const LEGACY_V2_FILES: ReadonlySet<string> = new Set([
  "admin/containers.ts",
  "admin/metrics.ts",
  "agent/subscriptions.ts",
]);

/**
 * 行内 waiver 允许写在关键词行本身,或其上方这么多行以内。
 * 取 6 是为了容得下"marker + 2~3 行理由 + 一两行代码"这种常见排版。
 */
export const WAIVER_LOOKBEHIND_LINES = 6;

/** 行内 waiver 标记;后面必须跟非空理由。 */
export const WAIVER_MARKER = "lint-agent-containers-sql: allow";

export interface Violation {
  /** 相对 `packages/commercial/src/` 的路径,跨平台 `/` 分隔 */
  file: string;
  /** 1-based line number of the FROM/JOIN keyword */
  line: number;
  /** 命中的整行(去尾换行) */
  match: string;
}

/** 声明了但没有任何违规去消费的 waiver —— 说明代码已修好,waiver 该删。 */
export interface StaleWaiver {
  file: string;
  /** 1-based line number of the waiver comment */
  line: number;
  reason: string;
}

export interface LintFileResult {
  violations: Violation[];
  staleWaivers: StaleWaiver[];
}

/** 大小写不敏感:FROM/JOIN(LEFT/RIGHT/INNER 等前缀由 \b 兜住)+ 空白 + agent_containers。 */
const KEYWORD_RE = /\b(?:FROM|JOIN)\s+agent_containers\b/i;
/** `deploy_state` 这类不算(`_` 是词字符,\b 不会在其间成立)。 */
const STATE_RE = /\bstate\b/;
/** 整行是注释(JS `//`、SQL `--`、块注释续行 `*`)—— 这种行不算 state 证据。 */
const COMMENT_LINE_RE = /^\s*(?:\/\/|--|\*\/?|\/\*)/;

/**
 * 该行能否作为"显式 state filter"的证据。
 *
 * 代码平面上的关键词,证据也必须来自代码行 —— 否则一句散文("v2 行的 state 列
 * 不承载语义……")就能把门刷绿,而这正是 waiver 理由里最容易出现的词。
 * 关键词本身写在注释里(文档/设计说明里的 SQL 范例)时,证据同样允许来自注释行:
 * 两者在同一个平面上,拿代码平面的标准去要求文档没有意义。
 */
function isStateEvidence(line: string, keywordInComment: boolean): boolean {
  if (!keywordInComment && COMMENT_LINE_RE.test(line)) return false;
  return STATE_RE.test(line);
}

interface StringLiteralSpan {
  /** 0-based inclusive */
  startLine: number;
  /** 0-based inclusive */
  endLine: number;
}

/**
 * 扫出源码里所有 JS 字符串字面量(', ", `)覆盖的行区间。
 *
 * 只求"够用":跳过行注释与块注释,处理反斜杠转义;模板串里的 `${}` 一律当作
 * 字面量内部(SQL 里 `${where.join(...)}` 拼接就是这样,不需要再往里递归)。
 */
export function findStringLiteralSpans(source: string): StringLiteralSpan[] {
  const spans: StringLiteralSpan[] = [];
  let line = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const startLine = line;
      i++;
      while (i < n) {
        const c = source[i]!;
        if (c === "\\") {
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (c === "\n") {
          line++;
          // 非模板串遇到裸换行 = 词法上不可能,当作字面量在此结束(容错)。
          if (quote !== "`") {
            i++;
            break;
          }
          i++;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      spans.push({ startLine, endLine: line });
      continue;
    }
    i++;
  }
  return spans;
}

function spanContaining(spans: StringLiteralSpan[], lineIdx: number): StringLiteralSpan | null {
  // 取最窄的覆盖区间(模板串里嵌 '...' 时,内层更贴近真实语句边界)。
  let best: StringLiteralSpan | null = null;
  for (const s of spans) {
    if (lineIdx < s.startLine || lineIdx > s.endLine) continue;
    if (best === null || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

/** 关键词行 `keywordIdx` 附近有没有带理由的行内 waiver;有则返回 waiver 行号(0-based)。 */
function findWaiverFor(lines: string[], keywordIdx: number): number | null {
  const from = Math.max(0, keywordIdx - WAIVER_LOOKBEHIND_LINES);
  for (let j = keywordIdx; j >= from; j--) {
    const idx = lines[j]!.indexOf(WAIVER_MARKER);
    if (idx === -1) continue;
    const reason = lines[j]!.slice(idx + WAIVER_MARKER.length).replace(/^[\s—:-]+/u, "").trim();
    if (reason.length > 0) return j;
  }
  return null;
}

/**
 * 纯函数:对单个文件源码跑 lint,返回违规 + stale waiver。
 * @param relPath 相对 `commercial/src/` 的路径,跨平台 `/`
 * @param source 完整文件文本
 */
export function lintFileDetailed(relPath: string, source: string): LintFileResult {
  if (LEGACY_V2_FILES.has(relPath)) return { violations: [], staleWaivers: [] };
  const lines = source.split(/\r?\n/);
  const spans = findStringLiteralSpans(source);

  // 先定位所有关键词行,再按"所属字面量"分组,决定判定作用域。
  const keywordIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (KEYWORD_RE.test(lines[i]!)) keywordIdxs.push(i);
  }
  const perSpanCount = new Map<StringLiteralSpan, number>();
  const spanOf = new Map<number, StringLiteralSpan | null>();
  for (const idx of keywordIdxs) {
    const span = spanContaining(spans, idx);
    spanOf.set(idx, span);
    if (span) perSpanCount.set(span, (perSpanCount.get(span) ?? 0) + 1);
  }

  const violations: Violation[] = [];
  const consumedWaivers = new Set<number>();
  for (const idx of keywordIdxs) {
    const span = spanOf.get(idx) ?? null;
    let scanFrom: number;
    let scanTo: number; // exclusive
    if (span !== null && (perSpanCount.get(span) ?? 0) === 1) {
      // 单腿语句:整条 SQL 都算作用域(state 在 SELECT 列表里也算数)。
      scanFrom = span.startLine;
      scanTo = span.endLine + 1;
    } else if (span !== null) {
      // 多腿语句:逐处 ±窗口,裁剪到语句范围内 —— 一条腿的 state 不替另一条腿背书。
      scanFrom = Math.max(span.startLine, idx - (STATE_WINDOW_LINES - 1));
      scanTo = Math.min(span.endLine + 1, idx + STATE_WINDOW_LINES);
    } else {
      // 不在字面量里(注释 / 拼接片段):沿用原「本行 + 后 N-1 行」窗口。
      scanFrom = idx;
      scanTo = Math.min(lines.length, idx + STATE_WINDOW_LINES);
    }
    const keywordInComment = COMMENT_LINE_RE.test(lines[idx]!);
    let hasState = false;
    for (let j = scanFrom; j < scanTo; j++) {
      if (isStateEvidence(lines[j]!, keywordInComment)) {
        hasState = true;
        break;
      }
    }
    if (hasState) continue;
    const waiverLine = findWaiverFor(lines, idx);
    if (waiverLine !== null) {
      consumedWaivers.add(waiverLine);
      continue;
    }
    violations.push({ file: relPath, line: idx + 1, match: lines[idx]! });
  }

  const staleWaivers: StaleWaiver[] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i]!.indexOf(WAIVER_MARKER);
    if (at === -1 || consumedWaivers.has(i)) continue;
    const reason = lines[i]!.slice(at + WAIVER_MARKER.length).replace(/^[\s—:-]+/u, "").trim();
    staleWaivers.push({ file: relPath, line: i + 1, reason });
  }

  return { violations, staleWaivers };
}

/** 向后兼容的薄封装:只要违规列表。 */
export function lintFile(relPath: string, source: string): Violation[] {
  return lintFileDetailed(relPath, source).violations;
}

/** 递归列出目录下所有 .ts 文件,跳过 `__tests__/` 与 `scripts/`。 */
function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "__tests__" || name === "scripts") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (st.isFile() && p.endsWith(".ts")) {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * 主入口:扫整个 commercial/src/。被 npm script / CI 直接调用。
 */
export function main(srcRoot: string): number {
  const files = listTsFiles(srcRoot);
  const allViolations: Violation[] = [];
  const allStale: StaleWaiver[] = [];
  for (const abs of files) {
    const rel = relative(srcRoot, abs).split(sep).join("/");
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const res = lintFileDetailed(rel, source);
    allViolations.push(...res.violations);
    allStale.push(...res.staleWaivers);
  }
  if (allViolations.length === 0 && allStale.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[lint-agent-containers-sql] OK — scanned ${files.length} .ts files, 0 violations`,
    );
    return 0;
  }
  if (allViolations.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[lint-agent-containers-sql] FAIL — ${allViolations.length} violation(s):`,
    );
    for (const v of allViolations) {
      // eslint-disable-next-line no-console
      console.error(`  ${v.file}:${v.line}: ${v.match.trim()}`);
    }
    // eslint-disable-next-line no-console
    console.error(
      `\nReader of agent_containers must carry an explicit \`state\` filter ` +
        `(R6.7 (a),v3 schema state ∈ {'active','vanished'})。` +
        `\n作用域:关键词所在 SQL 字面量整条;同一字面量里有多处关键词时退回 ` +
        `${STATE_WINDOW_LINES} 行窗口。` +
        `\n确属合法例外就在关键词行上方 ${WAIVER_LOOKBEHIND_LINES} 行内加注释:` +
        `\n  // ${WAIVER_MARKER} — <理由:读取流向何处、为什么必须看到 vanished 行>`,
    );
  }
  if (allStale.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[lint-agent-containers-sql] FAIL — ${allStale.length} stale/无理由 waiver:`,
    );
    for (const w of allStale) {
      // eslint-disable-next-line no-console
      console.error(
        `  ${w.file}:${w.line}: ${w.reason === "" ? "waiver 缺理由(marker 后必须写明理由)" : `没有违规消费它,代码已修好就删掉本行 — ${w.reason}`}`,
      );
    }
  }
  return 1;
}

// 直接 `tsx ./this-file.ts` 跑(node esm import.meta.url 探测)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  // 默认扫 packages/commercial/src/(脚本位于 packages/commercial/scripts/)
  const __dirname = dirname(__filename);
  const srcRoot = join(__dirname, "..", "src");
  process.exit(main(srcRoot));
}
