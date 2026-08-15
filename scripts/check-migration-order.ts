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
//   R2  ENFORCE_FROM 起不得重号(两支迁移共用同一个 4 位前缀)
//   R3  ENFORCE_FROM 起,编号相对前一支存在缺口时,必须在文件头声明
//       `-- order-dependency: <version>` 或 `-- order-dependency: none <理由>`
//       —— 缺口意味着中间号被另一支分支占着,那就是一条必须显式化的发布顺序依赖
//   R4  声明语法合法,且依赖编号小于自身(migrationOrder.ts 解析)
//   R5  磁盘上 >= minimumRequiredMigration 的迁移必须登记进 release-metadata.json
//       的 requiredMigrations(它是 deploy/dist/rollback/canary/finalize 的统一硬门,
//       漏登记 = 部署期才 fail-closed)
//   R6  requiredMigrations 里的每一条都必须在磁盘上存在
//   R7  requiredMigrations 必须字典序升序(= 真实 apply 顺序,便于人工核对)
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

/**
 * 存量豁免线。0220 之前的历史里既有重号(0102/0103/0130/0134/0135)也有缺口
 * (0013→0015、0115→0117、0164→0166、0170→0173),都已 apply 到生产,追溯改名会
 * 破坏 schema_migrations 记账。门禁引入时在途的 0218/0219 同样不追溯 —— 让在途分支
 * 因为一道新门变红,只会逼人绕门。**新迁移从这里开始受约束。**
 */
const ENFORCE_FROM = "0220";

interface Problem {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
  message: string;
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

/** R2:受约束区间内不得重号。 */
export function checkDuplicateNumbers(files: ReadonlyArray<MigrationFile>): Problem[] {
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    if (f.version < ENFORCE_FROM) continue;
    const list = byNumber.get(f.number) ?? [];
    list.push(f.version);
    byNumber.set(f.number, list);
  }
  const problems: Problem[] = [];
  for (const [number, versions] of byNumber) {
    if (versions.length < 2) continue;
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
 * R3/R4:缺口必须显式声明顺序依赖。
 *
 * 缺口 = 本支编号不是"磁盘上前一支编号 + 1",说明中间那些号被别的分支占着(或曾被占过)。
 * 这正是"谁先 apply"会决定成败的场景,必须写下来,而不是留在某个会话的记忆里。
 */
export function checkGapDeclarations(
  files: ReadonlyArray<MigrationFile>,
  readSql: (file: string) => string,
): Problem[] {
  const problems: Problem[] = [];
  const sorted = [...files].sort((a, b) => (a.version < b.version ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur.version < ENFORCE_FROM) continue;
    const prev = sorted[i - 1];

    let declared = false;
    try {
      declared = parseOrderDependency(readSql(cur.file)).declared;
    } catch (err) {
      problems.push({ rule: "R4", message: `${cur.file}:${(err as Error).message}` });
      continue;
    }

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

  const all = [
    ...problems,
    ...checkDuplicateNumbers(files),
    ...checkGapDeclarations(files, (file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8")),
    ...checkRequiredMigrations(files, metadata),
  ];

  if (all.length > 0) {
    console.error(`✗ 迁移编号/登记门发现 ${all.length} 项违规:\n`);
    for (const p of all) console.error(`  [${p.rule}] ${p.message}`);
    console.error(
      `\n  参考 docs/V5_DEV_PLAYBOOK.md §2.1a「迁移编号申领」。` +
        `强制区间从 ${ENFORCE_FROM} 起(更早的重号/缺口是已 apply 的历史,不追溯)。`,
    );
    process.exit(1);
  }

  const enforced = files.filter((f) => f.version >= ENFORCE_FROM).length;
  console.log(
    `✓ 迁移编号/登记门通过:${files.length} 支迁移(其中 ${enforced} 支在 ${ENFORCE_FROM}+ 强制区间),` +
      `requiredMigrations ${metadata.requiredMigrations.length} 条登记完整且有序。`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
