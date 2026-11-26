#!/usr/bin/env tsx
// check-integ-tiers.ts — 防"新增 integ 用例没人跑"的漂移门 (OCV5-903 B4: 严格以 --root 为数据根 + symlink 安全遍历)。
//
// 规则(范式参考 scripts/check-schedulers.ts):
//   R1  磁盘上每个 *.integ.test.ts 必须被 .github/integ-tiers/*.txt 之一收录
//   R2  清单里的每条路径必须在磁盘上存在(删文件忘删登记 → 门里 file-not-found)
//   R3  同一路径不得出现在两个清单(会被跑两遍,且判绿下界失真)
//   R4  每个清单必须声明 `# min-tests: N` 与 `# max-minutes: N` 指令
//   R5  至少有一个 pr-* 清单(PR 门不能被整片摘掉)
//
// Usage:
//   npx tsx scripts/check-integ-tiers.ts [--root <candidateDir>]
//
// 出口码:0 = 全过;1 = 有违规;2 = 参数错误。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path, { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseShardBudget } from "../.github/scripts/integ-shard-budget.ts";
import { statFollowSafe, walkDirectorySymlinkSafe } from "./lib/prodFileDiscovery.js";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTEG_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-types", "build", "coverage"]);

interface Tier {
  name: string; // pr-1 / nightly-2
  file: string; // 仓根相对
  entries: string[]; // 仓根相对测试路径
  minTests: number | null;
  maxMinutes: number | null;
}

export function listIntegFilesOnDisk(root: string): string[] {
  const pkgRoot = join(root, "packages");
  if (!statFollowSafe(pkgRoot)?.isDirectory()) return [];
  const out: string[] = [];
  const visitedDirs = new Set<string>();
  walkDirectorySymlinkSafe({
    root,
    relDir: "packages",
    skipDirs: INTEG_SKIP_DIRS,
    includeFile: (relPosix) => relPosix.endsWith(".integ.test.ts"),
    out,
    visitedDirs,
  });
  return out.sort();
}

function parseTier(repoRoot: string, tierDir: string, fileName: string): Tier {
  const abs = join(tierDir, fileName);
  const raw = readFileSync(abs, "utf8");
  const entries: string[] = [];
  let minTests: number | null = null;
  let maxMinutes: number | null = null;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("#")) {
      const min = /^#\s*min-tests:\s*(\d+)\s*$/.exec(t);
      if (min) minTests = Number(min[1]);
      const max = /^#\s*max-minutes:\s*(\d+)\s*$/.exec(t);
      if (max) maxMinutes = Number(max[1]);
      continue;
    }
    entries.push(t);
  }
  return {
    name: fileName.replace(/\.txt$/, ""),
    file: relative(repoRoot, abs).replace(/\\/g, "/"),
    entries,
    minTests,
    maxMinutes,
  };
}

export function checkIntegTiers(repoRoot: string): {
  ok: boolean;
  onDisk: string[];
  prCount: number;
  nightlyCount: number;
  tierCount: number;
  violations: string[];
} {
  const tierDir = join(repoRoot, ".github", "integ-tiers");
  const violations: string[] = [];

  if (!existsSync(tierDir)) {
    return {
      ok: false,
      onDisk: [],
      prCount: 0,
      nightlyCount: 0,
      tierCount: 0,
      violations: [`integ 分层清单目录不存在:${relative(repoRoot, tierDir)}`],
    };
  }

  const tiers = readdirSync(tierDir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => parseTier(repoRoot, tierDir, f));

  // R5
  if (!tiers.some((t) => t.name.startsWith("pr-"))) {
    violations.push("R5  没有任何 pr-* 清单 —— PR 阻塞门被整片摘掉了");
  }

  // R4
  for (const t of tiers) {
    if (t.minTests === null) violations.push(`R4  ${t.file} 缺 \`# min-tests: N\` 指令(判绿的执行下界)`);
    if (t.maxMinutes === null) violations.push(`R4  ${t.file} 缺 \`# max-minutes: N\` 指令(CI timeout 预算)`);
    try {
      parseShardBudget(readFileSync(join(repoRoot, t.file), "utf8"), {});
    } catch (error) {
      violations.push(`R4  ${t.file} 预算无效: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // R3 + R2
  const owner = new Map<string, string>();
  for (const t of tiers) {
    for (const e of t.entries) {
      const prev = owner.get(e);
      if (prev) {
        violations.push(`R3  ${e} 同时登记在 ${prev} 与 ${t.name} —— 会被跑两遍且判绿下界失真`);
        continue;
      }
      owner.set(e, t.name);
      if (!existsSync(join(repoRoot, e))) {
        violations.push(`R2  ${t.file} 登记了不存在的文件:${e}(删测试时忘了删登记)`);
      }
    }
  }

  // R1 + coverage fail-closed
  const onDisk = listIntegFilesOnDisk(repoRoot);
  if (onDisk.length === 0 && owner.size > 0) {
    violations.push(`R0  磁盘扫描发现 0 个 *.integ.test.ts，但清单登记了 ${owner.size} 项（--root=${repoRoot} 可能漏扫或断链）`);
  }
  const unlisted = onDisk.filter((p) => !owner.has(p));
  for (const p of unlisted) {
    violations.push(`R1  ${p} 没有被任何梯队收录 —— 它永远不会被执行`);
  }

  const prCount = tiers.filter((t) => t.name.startsWith("pr-")).reduce((n, t) => n + t.entries.length, 0);
  const nightlyCount = Math.max(0, onDisk.length - prCount);
  return {
    ok: violations.length === 0,
    onDisk,
    prCount,
    nightlyCount,
    tierCount: tiers.length,
    violations,
  };
}

export function main(argv = process.argv.slice(2)): number {
  let root = DEFAULT_REPO_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root") {
      const v = argv[++i];
      if (!v) {
        console.error("✗ check-integ-tiers: --root requires a directory path");
        return 2;
      }
      root = path.resolve(v);
    } else if (arg === "-h" || arg === "--help") {
      console.log("Usage: npx tsx scripts/check-integ-tiers.ts [--root <candidateDir>]");
      return 0;
    } else {
      console.error(`✗ check-integ-tiers: unknown argument: ${arg}`);
      return 2;
    }
  }

  const res = checkIntegTiers(root);
  if (!res.ok) {
    console.error(`✗ check-integ-tiers: ${res.violations.length} 处违规\n`);
    for (const v of res.violations) console.error(`  ${v}`);
    console.error("");
    console.error("修法:把文件登记进 .github/integ-tiers/ 下某个清单。选梯队的判据只有一条 ——");
    console.error("  这个文件绿了能证明哪一条**用户可见事实**?");
    console.error("  能直接证明「能注册/能登录/能收信/钱只扣一次/会话能落库读回」→ pr-*(每 PR 阻塞)");
    console.error("  管理面、连接器、自愈、账号池、单条 migration 回放 → nightly-*(失败开工单)");
    console.error("登记进 pr-* 时必须同步上调该清单的 min-tests,否则新用例能被 skip 悄悄绕过。");
    console.error("详见 .github/integ-tiers/README.md。");
    return 1;
  }

  console.log(
    `✓ check-integ-tiers: ${res.onDisk.length} 个 integ 文件全部登记(PR 门 ${res.prCount} / 夜跑 ${res.nightlyCount},${res.tierCount} 片)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
