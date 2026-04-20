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
 *   `JOIN agent_containers`(大小写不敏感),其后 5 行内必须出现 `state` 字面量。
 *
 *   理由:v3 schema (0012) 把 agent_containers.state ∈ {active, vanished};
 *   user-facing reader 漏 state filter 会把 vanished 行渗给用户视图 / 计费聚合。
 *
 * 例外:LEGACY_V2_FILES 中的 v2 legacy 路径(用旧 `status` 列,不在 v3 reader
 * 契约范围),硬编码白名单,新增需 PR review。
 *
 * 不扫:`__tests__/`、`scripts/` 自身(测试 fixture / lint 自身)。
 *
 * 使用:
 *   tsx packages/commercial/scripts/lint-agent-containers-sql.ts
 *   退出 0 = 清洁;退出 1 = 有违规(printed to stderr)。
 *
 * 测试:packages/commercial/src/__tests__/lintAgentContainersSql.test.ts
 *   纯函数 lintFile 单测,fixture 含正负例。
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

export interface Violation {
  /** 相对 `packages/commercial/src/` 的路径,跨平台 `/` 分隔 */
  file: string;
  /** 1-based line number of the FROM/JOIN keyword */
  line: number;
  /** 命中的整行(去尾换行) */
  match: string;
}

/**
 * 纯函数:对单个文件源码跑 lint,返回违规列表。
 * @param relPath 相对 `commercial/src/` 的路径,跨平台 `/`
 * @param source 完整文件文本
 */
export function lintFile(relPath: string, source: string): Violation[] {
  if (LEGACY_V2_FILES.has(relPath)) return [];
  const lines = source.split(/\r?\n/);
  const violations: Violation[] = [];
  // 大小写不敏感,匹配 FROM/JOIN(JOIN 包括 LEFT/RIGHT/INNER 等前缀)+ 一个或多个空白 + agent_containers + 词边界
  const keywordRe = /\b(?:FROM|JOIN)\s+agent_containers\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!keywordRe.test(lines[i]!)) continue;
    // 5 行窗口:本行 + 后 STATE_WINDOW_LINES-1 行(共 5 行)
    const windowEnd = Math.min(lines.length, i + STATE_WINDOW_LINES);
    let hasState = false;
    for (let j = i; j < windowEnd; j++) {
      if (/\bstate\b/.test(lines[j]!)) {
        hasState = true;
        break;
      }
    }
    if (!hasState) {
      violations.push({ file: relPath, line: i + 1, match: lines[i]! });
    }
  }
  return violations;
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
  for (const abs of files) {
    const rel = relative(srcRoot, abs).split(sep).join("/");
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const v = lintFile(rel, source);
    allViolations.push(...v);
  }
  if (allViolations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[lint-agent-containers-sql] OK — scanned ${files.length} .ts files, 0 violations`,
    );
    return 0;
  }
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
    `\nReader of agent_containers must include explicit \`state\` filter within ` +
      `${STATE_WINDOW_LINES} lines (R6.7 (a),v3 schema state ∈ {'active','vanished'})。`,
  );
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
