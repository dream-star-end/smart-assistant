/**
 * 架构测试(RFC-v5-sessions-pg D6b 防漂移)——**master 六张权威表的 SQL 字面量白名单**。
 *
 * 迁 PG 后,master 六表(client_sessions / client_session_archive_chunks /
 * client_session_archived_ids / server_authored_request_map / pending_usage_patches /
 * wechat_bindings)的权威被 backend 抽象收口:SQLite 实现在 storage、PG 实现在 commercial,
 * 业务决策在引擎中立的 plan 层。**任何 backend / 迁移工具以外的代码直接对这六张表写 SQL,
 * 都会绕过该抽象、在双 backend 之间制造漂移(一边改了另一边没跟上)或直连权威表破坏单一权威**。
 *
 * 本测试 grep 全仓 `.ts`(排除 __tests__ 测试文件),断言:除下面白名单外,无源码含对六张表名
 * 的 SQL **语句上下文**字面量(FROM/INTO/UPDATE/JOIN/TABLE/TRUNCATE + 表名)。白名单 = 合法的
 * backend / 迁移 / 已裁决 deprecated 的 SQLite-only 工具:
 *   - storage backend:sessionsDb.ts(SQLite 六表)、wechatBindings.ts(SQLite wechat)、
 *     clientSessionsPlan.ts(纯决策层,无 SQL,防御性列入)
 *   - commercial backend:db/pgSessionsBackend.ts(PG 六表)、db/sessionsStoreAuthority.ts
 *     (只触状态机表,防御性列入)
 *   - commercial GoalState PG 权威:goal/goalStateService.ts。mutation 必须在同一事务内先锁
 *     client_sessions 归属行,再跨 session_goals/tape/pending 聚合并 CAS;拆到普通 backend
 *     调用会丢失同事务 ownership fence,因此只对白名单中的该权威服务保留直读
 *   - 迁移/割接工具:scripts/v5-sessions-backfill-pg.ts
 *   - RFC §5b 已裁决 deprecated 的 SQLite-only 运维/迁移工具(master 割接后不用于生产,仅
 *     个人版/留档库):storage/sessionsMigrate.ts、scripts/v5-sessions-spill-archive.ts、
 *     scripts/sessions-fix-oversized.ts
 *   -(.sql 迁移文件不在扫描面 —— schema 权威本就该 CREATE 这些表;shell 脚本 .sh 亦不扫。)
 *
 * 加新的权威表读写点 → **必须走 backend 接口**(sessionsDb.ts 导出的委托函数),而非直连 SQL;
 * 若确有新的合法 backend/工具文件,显式加进下方白名单并说明理由(而非放宽正则)。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sixTablesSqlArchitecture.test.ts
 */
import assert from "node:assert/strict"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, "../../../..")

// 六张 master 权威表(RFC 范围)。
const AUTH_TABLES = [
  "client_sessions",
  "client_session_archive_chunks",
  "client_session_archived_ids",
  "server_authored_request_map",
  "pending_usage_patches",
  "wechat_bindings",
] as const

// SQL 语句上下文正则:表名紧跟 SQL 关键字(可带双引号标识符)。case-insensitive。只匹配"真 SQL"
// 上下文,避免把注释/字段名里的裸表名当违规(client_sessions\b 的 \b 也天然不误伤单数留档表
// client_sessions_archive)。
const SQL_CONTEXT = new RegExp(
  `\\b(?:FROM|INTO|UPDATE|JOIN|TRUNCATE|TABLE)\\s+"?(?:${AUTH_TABLES.join("|")})"?\\b`,
  "i",
)

// 白名单(相对 REPO_ROOT 的 POSIX 路径)。理由见文件顶注。
const WHITELIST = new Set<string>([
  "packages/storage/src/sessionsDb.ts",
  "packages/storage/src/wechatBindings.ts",
  "packages/storage/src/clientSessionsPlan.ts",
  "packages/storage/src/sessionsMigrate.ts",
  "packages/commercial/src/db/pgSessionsBackend.ts",
  "packages/commercial/src/db/sessionsStoreAuthority.ts",
  "packages/commercial/src/goal/goalStateService.ts",
  // 批D D3:session_goals 终态离场 sweeper(retention 单一权威模块)。对 client_sessions 仅
  // **只读 JOIN deleted_at**(判定"会话已软删")——不写六表、不绕 ownership fence;放 backend
  // 反而把 goal 域的离场语义搬进 sessions backend,内聚更差。写入面仍只经白名单 backend。
  "packages/commercial/src/admin/auditRetention.ts",
  "scripts/v5-sessions-backfill-pg.ts",
  "scripts/v5-sessions-spill-archive.ts",
  "scripts/sessions-fix-oversized.ts",
])

// 扫描根目录(仓内一级)。node_modules/dist/.git 等在遍历时剪掉。
const SCAN_ROOTS = ["packages", "scripts"]
const PRUNE_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", ".turbo", "__tests__"])

function walkTsFiles(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (PRUNE_DIRS.has(e.name)) continue
      walkTsFiles(full, out)
    } else if (e.isFile()) {
      // 只扫 .ts(非 .tsx / 非 .d.ts / 非 .test.ts);SQL 权威是后端 .ts 的事。
      if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) {
        out.push(full)
      }
    }
  }
}

describe("架构:master 六张权威表 SQL 字面量白名单(RFC D6b)", () => {
  test("除 backend / 迁移 / deprecated 工具白名单外,无代码直接对六表写 SQL", () => {
    const files: string[] = []
    for (const root of SCAN_ROOTS) walkTsFiles(join(REPO_ROOT, root), files)
    // 遍历自洽性:至少扫到若干文件(防路径推导错导致空扫而假绿)。
    assert.ok(files.length > 50, `扫描面异常小(${files.length} 文件),REPO_ROOT 可能推导错: ${REPO_ROOT}`)

    const violations: string[] = []
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs).split("\\").join("/")
      if (WHITELIST.has(rel)) continue
      let text: string
      try {
        text = readFileSync(abs, "utf8")
      } catch {
        continue
      }
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (SQL_CONTEXT.test(lines[i])) {
          violations.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`)
        }
      }
    }

    assert.equal(
      violations.length,
      0,
      "以下非白名单文件含对 master 六张权威表的直接 SQL(应走 backend 接口,或若确系合法" +
        " backend/工具则显式加入白名单并注明理由):\n" +
        violations.join("\n"),
    )
  })

  test("白名单自洽:每个白名单文件都真实存在(防陈旧路径)", () => {
    for (const rel of WHITELIST) {
      const abs = join(REPO_ROOT, rel)
      assert.doesNotThrow(() => readFileSync(abs, "utf8"), `白名单文件不存在(路径陈旧?): ${rel}`)
    }
  })
})
