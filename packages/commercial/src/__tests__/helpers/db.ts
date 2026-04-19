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
