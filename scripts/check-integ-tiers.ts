#!/usr/bin/env tsx
// check-integ-tiers.ts — 防"新增 integ 用例没人跑"的漂移门。
//
// 背景(2026-07-26 门禁审计):110 个 *.integ.test.ts / 1549 个用例在 CI、deploy、
// playbook 三处都不跑,而单测层白纸黑字把"SQL 真行为"delegate 给它们
// (turnDispatchStore.test.ts / turnDispatchReconciler.test.ts / preferences.test.ts
// 的头注释都写着"由 integ 覆盖")—— 委派链的下游根本不存在。近 30 天新增了 59 个
// integ 文件,全部落进这个黑洞。
//
// 光把 integ 接进 CI 不够:分层清单是手工维护的,不加门,一年后又会攒出一堆
// 谁也不跑的用例(这正是本次审计发现的那 110 个的成因)。本 linter 把
// "每个 integ 文件必须属于某一梯队"变成机制。
//
// 规则(范式参考 scripts/check-schedulers.ts):
//   R1  磁盘上每个 *.integ.test.ts 必须被 .github/integ-tiers/*.txt 之一收录
//   R2  清单里的每条路径必须在磁盘上存在(删文件忘删登记 → 门里 file-not-found)
//   R3  同一路径不得出现在两个清单(会被跑两遍,且判绿下界失真)
//   R4  每个清单必须声明 `# min-tests: N` 与 `# max-minutes: N` 指令
//   R5  至少有一个 pr-* 清单(PR 门不能被整片摘掉)
//
// 出口码:0 = 全过;1 = 有违规。

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TIER_DIR = join(REPO_ROOT, ".github", "integ-tiers");
const SCAN_ROOT = join(REPO_ROOT, "packages");

interface Tier {
  name: string; // pr-1 / nightly-2
  file: string; // 仓根相对
  entries: string[]; // 仓根相对测试路径
  minTests: number | null;
  maxMinutes: number | null;
}

function listIntegFilesOnDisk(): string[] {
  const all = readdirSync(SCAN_ROOT, { recursive: true, encoding: "utf8" }) as string[];
  return all
    .filter((p) => p.endsWith(".integ.test.ts"))
    .filter((p) => !p.includes("node_modules/"))
    .map((p) => `packages/${p}`)
    .sort();
}

function parseTier(fileName: string): Tier {
  const abs = join(TIER_DIR, fileName);
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
    file: relative(REPO_ROOT, abs),
    entries,
    minTests,
    maxMinutes,
  };
}

const violations: string[] = [];

if (!existsSync(TIER_DIR)) {
  console.error(`✗ integ 分层清单目录不存在:${relative(REPO_ROOT, TIER_DIR)}`);
  process.exit(1);
}

const tiers = readdirSync(TIER_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort()
  .map(parseTier);

// R5
if (!tiers.some((t) => t.name.startsWith("pr-"))) {
  violations.push("R5  没有任何 pr-* 清单 —— PR 阻塞门被整片摘掉了");
}

// R4
for (const t of tiers) {
  if (t.minTests === null) violations.push(`R4  ${t.file} 缺 \`# min-tests: N\` 指令(判绿的执行下界)`);
  if (t.maxMinutes === null) violations.push(`R4  ${t.file} 缺 \`# max-minutes: N\` 指令(CI timeout 预算)`);
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
    if (!existsSync(join(REPO_ROOT, e))) {
      violations.push(`R2  ${t.file} 登记了不存在的文件:${e}(删测试时忘了删登记)`);
    }
  }
}

// R1
const onDisk = listIntegFilesOnDisk();
const unlisted = onDisk.filter((p) => !owner.has(p));
for (const p of unlisted) {
  violations.push(`R1  ${p} 没有被任何梯队收录 —— 它永远不会被执行`);
}

if (violations.length > 0) {
  console.error(`✗ check-integ-tiers: ${violations.length} 处违规\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("");
  console.error("修法:把文件登记进 .github/integ-tiers/ 下某个清单。选梯队的判据只有一条 ——");
  console.error("  这个文件绿了能证明哪一条**用户可见事实**?");
  console.error("  能直接证明「能注册/能登录/能收信/钱只扣一次/会话能落库读回」→ pr-*(每 PR 阻塞)");
  console.error("  管理面、连接器、自愈、账号池、单条 migration 回放 → nightly-*(失败开工单)");
  console.error("登记进 pr-* 时必须同步上调该清单的 min-tests,否则新用例能被 skip 悄悄绕过。");
  console.error("详见 .github/integ-tiers/README.md。");
  process.exit(1);
}

const prCount = tiers.filter((t) => t.name.startsWith("pr-")).reduce((n, t) => n + t.entries.length, 0);
const nightlyCount = onDisk.length - prCount;
console.log(
  `✓ check-integ-tiers: ${onDisk.length} 个 integ 文件全部登记(PR 门 ${prCount} / 夜跑 ${nightlyCount},${tiers.length} 片)`,
);
