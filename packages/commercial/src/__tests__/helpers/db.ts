import { after, before } from "node:test";
import { Client } from "pg";
import { query, type QueryRunner } from "../../db/queries.js";
import { closePool, createPool, getPool, resetPool, setPoolOverride } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";

/**
 * 测试专用 DB helper。
 *
 * 故意不放在生产 `src/db/` 目录下,避免被业务代码误 import。
 * 任何批量破坏性操作(TRUNCATE / DROP ...)都必须通过这里,且必须带
 * "当前库名以 `_test` 结尾" 的硬防护,以防 `.env` 配错指向生产库时
 * 清空真实数据(用户/积分流水等)。
 */

const SAFE_DB_NAME = /_test$/;
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * 一次性 TRUNCATE 指定表(CASCADE),重置序列。仅测试库可用。
 *
 * 防护:
 *  1. 运行时查询 `current_database()`,库名必须以 `_test` 结尾,否则抛。
 *  2. 每个表名必须匹配 `/^[a-z_][a-z0-9_]*$/`,拒绝任何拼接注入。
 */
export async function truncateAllForTest(
  tables: ReadonlyArray<string>,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<void> {
  if (tables.length === 0) return;

  const dbResult = await runner.query<{ db: string }>("SELECT current_database() AS db");
  const db = dbResult.rows[0]?.db;
  if (!db || !SAFE_DB_NAME.test(db)) {
    throw new Error(
      `truncateAllForTest refuses to run against non-test database: ${JSON.stringify(db)}`,
    );
  }

  for (const t of tables) {
    if (!TABLE_NAME.test(t)) {
      throw new Error(`truncateAllForTest: invalid table name ${JSON.stringify(t)}`);
    }
  }

  const sql = `TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`;
  await query(sql, [], runner);
}

/**
 * 整库 schema 重置(DROP SCHEMA public CASCADE + 重建),供"重放全部迁移"型套件的
 * before 钩子使用。
 *
 * 动机(2026-07-11):此前这类套件各自维护一份 COMMERCIAL_TABLES 手工清单,DROP 清单
 * 后重放迁移 —— 新迁移加的表(如 admin_alert_channels)没进清单就撞"already exists",
 * 且该清单在 33 个测试文件里各复制一份、独立漂移(一类必然复发的坑)。schema 级重置
 * 零清单维护,迁移从零重放,确定性成立。其余仍用手工清单的套件属登记债,逐个迁移时
 * 改用本函数。
 *
 * 防护与 truncateAllForTest 同源:库名必须以 `_test` 结尾,防 .env 配错清了生产库。
 */
export async function resetTestSchemaForTest(
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<void> {
  const dbResult = await runner.query<{ db: string }>("SELECT current_database() AS db");
  const db = dbResult.rows[0]?.db;
  if (!db || !SAFE_DB_NAME.test(db)) {
    throw new Error(
      `resetTestSchemaForTest refuses to run against non-test database: ${JSON.stringify(db)}`,
    );
  }
  await query("DROP SCHEMA public CASCADE", [], runner);
  await query("CREATE SCHEMA public", [], runner);
}

// ───────────────────────────────────────────────────────────────────────
//  每文件一库(dedicated database per test file)
// ───────────────────────────────────────────────────────────────────────

/** 基准连接串:既是"管理连接"(建/删库),也是默认库名的来源。 */
const BASE_TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";

/** 与 gate 脚本同一判据:CI 或 REQUIRE_TEST_DB=1 时,PG 不可达必须 fail-loud。 */
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

/** 库名硬约束:小写标识符 + 必须 `_test` 结尾(拼进 DDL,不能有注入面)。 */
const DEDICATED_DB_NAME = /^[a-z][a-z0-9_]*_test$/;

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_TEST_DB_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

export interface DedicatedTestDatabase {
  /** PG fixture 是否可达。false 时(且非 REQUIRE_TEST_DB)套件应逐 test skip。 */
  readonly available: boolean;
  /** 本文件专属库的连接串。 */
  readonly url: string;
  /** `if (db.skipIfUnavailable(t)) return;` 惯用法。 */
  skipIfUnavailable(t: { skip: (reason: string) => void }): boolean;
}

/**
 * 给**单个测试文件**开一个专属数据库,并把全局 pool 指过去;文件跑完删库。
 *
 * 动机(2026-07-26,本批):v3MigrationLedger / v3MigrationReconciler /
 * v3EnsureRunningMigrationGuard 三个文件各自对**共享**的 openclaude_test 做
 * `DROP SCHEMA public CASCADE; CREATE SCHEMA public`。commercial unit 套件 300+
 * 文件由 node:test 并发调度(默认按 CPU 数并行跑文件),三者一旦重叠,
 * 后者的 `CREATE SCHEMA public` 会撞上前者刚建好的 schema → `42P06 schema "public"
 * already exists`,before 钩子直接 hookFailed,整文件的 test 变 cancelled。
 * 这就是这三个文件长期躺在 .github/known-failures/commercial-unit.txt 里的原因
 * —— 不是产品坏,是夹具互相毒化,代价是 6 条 ledger 契约(open-migration 闸门)
 * 完全没有门禁。
 *
 * 正解仓内已有先例:org 系 7 个文件用"每文件一库"(orgBilling.test.ts / orgEnterprise
 * .test.ts)长期全绿。本函数把那段样板收成单一权威,避免第 8、9 份复制体各自漂移。
 *
 * 语义:
 *   - 注册 root 级 before/after —— 必须在测试文件**顶层**调用(与其它 before 的
 *     相对顺序 = 注册顺序,请第一个调)。
 *   - before:探活 → DROP/CREATE DATABASE → setPoolOverride(专属库) → runMigrations()
 *   - after :closePool → DROP DATABASE(尽力而为,失败不影响退出码)
 *   - PG 不可达:REQUIRE_TEST_DB 下抛(fail-loud,不静默变绿);否则 available=false。
 */
export function useDedicatedTestDatabase(dbName: string): DedicatedTestDatabase {
  if (!DEDICATED_DB_NAME.test(dbName)) {
    throw new Error(
      `useDedicatedTestDatabase: 库名必须匹配 ${DEDICATED_DB_NAME} (小写 + _test 结尾),收到 ${JSON.stringify(dbName)}`,
    );
  }
  const url = withDatabase(BASE_TEST_DB_URL, dbName);
  let available = false;

  const terminateBackends = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`;

  before(async () => {
    try {
      await adminExec("SELECT 1");
      available = true;
    } catch {
      available = false;
    }
    if (!available) {
      if (REQUIRE_TEST_DB) {
        throw new Error(
          `Postgres test fixture required (${BASE_TEST_DB_URL}) —— REQUIRE_TEST_DB/CI 下不允许静默 skip`,
        );
      }
      return;
    }
    await adminExec(terminateBackends).catch(() => {});
    await adminExec(`DROP DATABASE IF EXISTS ${dbName}`);
    await adminExec(`CREATE DATABASE ${dbName} TEMPLATE template0`);

    await resetPool();
    setPoolOverride(createPool({ connectionString: url, max: 5 }));
    await runMigrations();
  });

  after(async () => {
    if (!available) return;
    await closePool();
    await adminExec(terminateBackends).catch(() => {});
    await adminExec(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  });

  return {
    get available() {
      return available;
    },
    url,
    skipIfUnavailable(t: { skip: (reason: string) => void }): boolean {
      if (!available) {
        t.skip(`pg not available (${BASE_TEST_DB_URL})`);
        return true;
      }
      return false;
    },
  };
}
