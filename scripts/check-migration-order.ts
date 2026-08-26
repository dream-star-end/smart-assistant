#!/usr/bin/env tsx
// check-migration-order.ts — 并行会话的迁移编号 / 登记漂移门。
//
// 背景(2026-08-15 并行开发审计):
//   V5 仓库同时挂着 80+ worktree,迁移是"每人新建一个文件"的形态,**git 永远不报冲突**。
//   但 packages/commercial/src/db/migrate.ts 的 out-of-order 完整性门要求「任何未应用
//   版本严格 > max(applied)」,于是两支并行分支各占 0218 / 0219 时:
//     * 0218 先 apply → 一切正常;
//     * 0219 先 apply → 0218 被判 out-of-order,**整个迁移运行 fail-closed**,卡死部署。
//   毁坏与否取决于合并顺序,而且失败点落在无辜的一方。实测一次这样的撞号吃掉了一个
//   完整会话:先花时间发现重号,让号之后又误以为"让号 = 顺序无关"(错的,完整性门要的
//   就是严格递增),最后只能把顺序依赖写进 PR 正文靠人保证。
//
//   本门把这三件事从"靠人记得"变成机制:重号当场红、缺口必须显式声明依赖、
//   新迁移必须登记进部署硬门清单。声明本身由 migrate.ts 在 apply 前再断言一次
//   (packages/commercial/src/db/migrationOrder.ts 是两侧共用的唯一解析权威)。
//
// 规则:
//   R1  迁移文件名必须是 `NNNN_snake_case.sql`
//   R2  新迁移不得重号(两支迁移共用同一个 4 位前缀)
//   R3  新迁移的编号相对前一支存在缺口时,必须在文件头声明
//       `-- order-dependency: <version>` 或 `-- order-dependency: none <理由>`
//       —— 缺口意味着中间号被另一支分支占着,那就是一条必须显式化的发布顺序依赖
//   R4  声明语法合法,且每条依赖的编号严格小于自身 —— 这两项都要在 PR 期判掉,
//       否则 `-- order-dependency: 9999_future` 这类声明会一路绿到部署期才被
//       migrate.ts 的断言拒绝(fail-closed 落在最贵的时刻)
//   R5  磁盘上 >= minimumRequiredMigration 的迁移必须登记进 release-metadata.json
//       的 requiredMigrations(它是 deploy/dist/rollback/canary/finalize 的统一硬门,
//       漏登记 = 部署期才 fail-closed)
//   R6  requiredMigrations 里的每一条都必须在磁盘上存在
//   R7  requiredMigrations 必须字典序升序(= 真实 apply 顺序,便于人工核对)
//   R8  新迁移不得取基线里已用到的编号或更小的号 —— 往历史空洞里插号(如 0013→0015
//       之间补一支 0014)不重号也不产生缺口,能安静过完 R2/R3,却必然在部署期被
//       out-of-order 门判死
//
// 「新迁移」= 不在 scripts/migration-order-baseline.json 冻结快照里的文件。
//
// 用法:npm run lint:migration-order   (退出 0 = 全过;1 = 有违规)

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIGRATION_VERSION_RE,
  parseOrderDependency,
} from "../packages/commercial/src/db/migrationOrder.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/commercial/src/db/migrations");
const RELEASE_METADATA = join(REPO_ROOT, "deploy/v5/release-metadata.json");
const BASELINE_FILE = join(REPO_ROOT, "scripts/migration-order-baseline.json");

interface Problem {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";
  message: string;
}

/**
 * 存量豁免:门引入时磁盘上已有的那一批文件的**冻结名单**。
 *
 * 这里刻意不用「编号阈值」(最初写的是 `ENFORCE_FROM = "0220"`)。阈值豁免的是一个
 * 区间,而不是具体文件 —— 新迁移只要把自己命名成 `0219_*`,就能同时绕过 R2/R3/R4,
 * 而 R5..R7 只看登记是否完整,识别不出这是个新插进来的历史编号。名单则只豁免当时
 * 确实存在的那 217 支:任何后来新增的文件,无论取什么号,都落在约束内。
 */
export interface Baseline {
  versions: ReadonlySet<string>;
  /** 快照里的最高 4 位编号;新迁移必须严格大于它(R8)。 */
  maxNumber: string;
}

export function loadBaseline(file: string): Baseline {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { versions: string[] };
  const versions = new Set(raw.versions);
  if (versions.size === 0) throw new Error(`${file}:基线快照为空,门会把所有存量判成新迁移`);
  const maxNumber = [...versions].sort().at(-1)!.slice(0, 4);
  return { versions, maxNumber };
}

export interface MigrationFile {
  version: string;
  number: string;
  file: string;
}

export function listMigrationFiles(dir: string): { files: MigrationFile[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const version = file.slice(0, -".sql".length);
    if (!MIGRATION_VERSION_RE.test(version)) {
      problems.push({
        rule: "R1",
        message: `${file}:文件名不符合 NNNN_snake_case.sql(4 位数字前缀 + 小写下划线)`,
      });
      continue;
    }
    files.push({ version, number: version.slice(0, 4), file });
  }
  return { files, problems };
}

/**
 * R2:不得重号。
 *
 * 只有「整组都是基线存量」的重号才放行(那几对已 apply 到生产,改不动了)。只要组里
 * 有一支是新迁移,就报 —— 包括新迁移去撞一个历史编号的情况。
 */
/**
 * 2026-08-26 双向同步前，两套已上线数据库各自占用了 0246/0247：
 * commercial=ungate/open，selfhost=project-bind/opus48。两边 ledger 都已不可改写。
 * 这里只豁免四个精确 version 组成的两组冲突；不豁免编号区间，也不允许第三支。
 * 合并发布前仍须在双锁下交叉执行/验证并补齐另一条 lineage 的 ledger。
 */
const FROZEN_APPLIED_FORK_DUPLICATES = new Map<string, ReadonlySet<string>>([
  ["0246", new Set([
    "0246_chat_project_board_bind",
    "0246_ungate_cursor_opus_fable_picker",
  ])],
  ["0247", new Set([
    "0247_cursor_opus_48",
    "0247_open_cursor_grok_opus48",
  ])],
]);

function isFrozenAppliedForkDuplicate(number: string, versions: readonly string[]): boolean {
  const expected = FROZEN_APPLIED_FORK_DUPLICATES.get(number);
  if (expected === undefined || expected.size !== versions.length) return false;
  return versions.every((version) => expected.has(version));
}

export function checkDuplicateNumbers(
  files: ReadonlyArray<MigrationFile>,
  baseline: Baseline,
): Problem[] {
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const list = byNumber.get(f.number) ?? [];
    list.push(f.version);
    byNumber.set(f.number, list);
  }
  const problems: Problem[] = [];
  for (const [number, versions] of byNumber) {
    if (versions.length < 2) continue;
    if (versions.every((v) => baseline.versions.has(v))) continue;
    if (isFrozenAppliedForkDuplicate(number, versions)) continue;
    problems.push({
      rule: "R2",
      message:
        `编号 ${number} 被 ${versions.join(" 与 ")} 同时占用。git 不会报这种冲突,但 apply 顺序` +
        `一反就 MigrationIntegrityError 并让整个迁移运行 fail-closed。` +
        `先跑 scripts/v5-migration-claim.sh 看清占号,再把自己让到未被占用的编号。`,
    });
  }
  return problems;
}

/**
 * R3/R4:缺口必须显式声明顺序依赖,且声明本身必须站得住。
 *
 * 缺口 = 本支编号不是"磁盘上前一支编号 + 1",说明中间那些号被别的分支占着(或曾被占过)。
 * 这正是"谁先 apply"会决定成败的场景,必须写下来,而不是留在某个会话的记忆里。
 *
 * 依赖的**有效性**在这里判(编号必须更小),而不是留给 runtime:声明一个更大或等于自身
 * 的编号在任何应用顺序下都不可能被满足,让它绿到部署期才 fail-closed 是最贵的失败方式。
 * 但**不要求依赖已经在目录里** —— 依赖分支尚未合并正是这条声明存在的理由。
 *
 * R3 只对新迁移生效(历史缺口已 apply,补不回来了);R4 对所有文件生效 —— 一条写坏的
 * 声明不会因为文件年代久远就变得能被满足。
 */
export function checkOrderDeclarations(
  files: ReadonlyArray<MigrationFile>,
  readSql: (file: string) => string,
  baseline: Baseline,
): Problem[] {
  const problems: Problem[] = [];
  const sorted = [...files].sort((a, b) => (a.version < b.version ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1];

    let declared = false;
    try {
      const decl = parseOrderDependency(readSql(cur.file));
      declared = decl.declared;
      for (const dep of decl.dependsOn) {
        if (dep >= cur.version) {
          problems.push({
            rule: "R4",
            message:
              `${cur.file}:声明依赖 ${dep},但依赖编号必须严格小于自身 —— 顺序门只保证"小号先 apply",` +
              `更大或相等的编号在任何顺序下都不可能被满足。`,
          });
        }
      }
    } catch (err) {
      problems.push({ rule: "R4", message: `${cur.file}:${(err as Error).message}` });
      continue;
    }

    if (baseline.versions.has(cur.version)) continue;

    // 编号相等 = 重号,已由 R2 报;这里不再重复报一条 R3,免得同一个错出两种说法。
    const hasGap =
      prev !== undefined &&
      Number(cur.number) !== Number(prev.number) &&
      Number(cur.number) !== Number(prev.number) + 1;
    if (hasGap && !declared) {
      problems.push({
        rule: "R3",
        message:
          `${cur.file}:编号相对上一支 ${prev!.version} 有缺口(${prev!.number} → ${cur.number}),` +
          `说明中间号被另一支分支占着。必须在文件头声明顺序依赖:\n` +
          `      -- order-dependency: <必须先 apply 的 version>\n` +
          `    若那支已被放弃、本支可独立 apply,则声明:\n` +
          `      -- order-dependency: none  (<编号> 曾由 <分支> 保留,已放弃)`,
      });
    }
  }
  return problems;
}

/**
 * R8:新迁移不得取基线最高号或更小的号。
 *
 * 这条堵的是 R2/R3 都看不见的一类:往历史空洞里插号。基线里 0013 与 0015 之间是空的,
 * 新加一支 0014 既不重号、也不制造缺口(反倒把缺口填上了),R2/R3 全绿 —— 但 0015 及
 * 其之后的两百支早已 applied,这支 0014 在部署期必然被 out-of-order 门判死,而且是让
 * **整个迁移运行** fail-closed。同理,`0219_*` 这种「取一个刚好在基线之下的号」的写法
 * 也在这里被截住,不再能靠编号绕过前面几条。
 */
export function checkBaselineInsertion(
  files: ReadonlyArray<MigrationFile>,
  baseline: Baseline,
): Problem[] {
  const problems: Problem[] = [];
  for (const f of files) {
    if (baseline.versions.has(f.version)) continue;
    if (f.number > baseline.maxNumber) continue;
    problems.push({
      rule: "R8",
      message:
        `${f.file}:编号 ${f.number} 不高于基线最高号 ${baseline.maxNumber},但它不是基线里的文件 —— ` +
        `即新迁移占用了历史编号。基线之下的迁移都已 apply,这支在部署期会被 out-of-order 门判死并让` +
        `整个迁移运行 fail-closed。跑 scripts/v5-migration-claim.sh 申领一个未被占用的新号。`,
    });
  }
  return problems;
}

/** R5/R6/R7:release-metadata.json 的 requiredMigrations 登记完整性。 */
export function checkRequiredMigrations(
  files: ReadonlyArray<MigrationFile>,
  metadata: { minimumRequiredMigration: string; requiredMigrations: string[] },
): Problem[] {
  const problems: Problem[] = [];
  const { minimumRequiredMigration: min, requiredMigrations: req } = metadata;
  const onDisk = new Set(files.map((f) => f.version));
  const registered = new Set(req);

  for (const f of files) {
    if (f.version < min) continue;
    if (!registered.has(f.version)) {
      problems.push({
        rule: "R5",
        message:
          `${f.file} 未登记进 deploy/v5/release-metadata.json.requiredMigrations。` +
          `该清单是 deploy/dist/rollback/canary/finalize 的统一硬门,漏登记要到部署期才 fail-closed。`,
      });
    }
  }
  for (const v of req) {
    if (!onDisk.has(v)) {
      problems.push({
        rule: "R6",
        message: `requiredMigrations 登记了 ${v},但迁移目录里没有这个文件(改名/删除忘了同步?)`,
      });
    }
  }
  const sorted = [...req].sort();
  if (JSON.stringify(req) !== JSON.stringify(sorted)) {
    const firstBad = req.findIndex((v, i) => v !== sorted[i]);
    problems.push({
      rule: "R7",
      message:
        `requiredMigrations 不是字典序升序(第 ${firstBad + 1} 项 ${req[firstBad]} 应为 ${sorted[firstBad]})。` +
        `清单顺序应与真实 apply 顺序一致,否则人工核对会读出错误的先后关系。`,
    });
  }
  return problems;
}

function main(): void {
  const { files, problems } = listMigrationFiles(MIGRATIONS_DIR);
  const metadata = JSON.parse(readFileSync(RELEASE_METADATA, "utf8")) as {
    minimumRequiredMigration: string;
    requiredMigrations: string[];
  };
  const baseline = loadBaseline(BASELINE_FILE);

  const all = [
    ...problems,
    ...checkDuplicateNumbers(files, baseline),
    ...checkOrderDeclarations(
      files,
      (file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      baseline,
    ),
    ...checkBaselineInsertion(files, baseline),
    ...checkRequiredMigrations(files, metadata),
  ];

  if (all.length > 0) {
    console.error(`✗ 迁移编号/登记门发现 ${all.length} 项违规:\n`);
    for (const p of all) console.error(`  [${p.rule}] ${p.message}`);
    console.error(
      `\n  参考 docs/V5_DEV_PLAYBOOK.md §2.1a「迁移编号申领」。` +
        `存量豁免只覆盖 scripts/migration-order-baseline.json 里冻结的那批文件` +
        `(最高号 ${baseline.maxNumber}),新增文件一律受约束。`,
    );
    process.exit(1);
  }

  const fresh = files.filter((f) => !baseline.versions.has(f.version)).length;
  console.log(
    `✓ 迁移编号/登记门通过:${files.length} 支迁移(其中 ${fresh} 支在基线 ${baseline.maxNumber} 之后新增),` +
      `requiredMigrations ${metadata.requiredMigrations.length} 条登记完整且有序。`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
