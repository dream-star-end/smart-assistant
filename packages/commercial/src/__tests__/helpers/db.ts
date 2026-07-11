import { query, type QueryRunner } from "../../db/queries.js";
import { getPool } from "../../db/index.js";

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
