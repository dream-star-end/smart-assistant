import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { getPool } from "./index.js";

/**
 * 参数化查询封装。
 *
 * 05-SECURITY §8 强制要求:全部查询走 `$1, $2 ...` 参数化。
 * 禁止 `` `SELECT ... WHERE id = ${id}` `` 这种拼接形式。
 *
 * 本模块仅暴露 `query(sql, params)` 和 `tx(fn)`,不提供任何接受运行时表名/列名的 API,
 * 如果未来需要动态表/列,必须走白名单映射,不能直接拼接。
 */

export type Params = ReadonlyArray<unknown>;

export interface QueryRunner {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: Params,
  ): Promise<QueryResult<Row>>;
}

/** 在 pool 上执行单条参数化查询。 */
export async function query<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: Params = [],
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<QueryResult<Row>> {
  return runner.query<Row>(sql, params as unknown[]);
}

/**
 * 事务辅助:`BEGIN → fn(client) → COMMIT`。
 * fn 抛出时自动 `ROLLBACK` 并透传错误。
 *
 * `fn` 收到的 client 是同一个 PoolClient,保证语句都在同一事务中。
 * 如果 fn 中想执行参数化查询,直接 `client.query(sql, params)` 即可。
 */
export async function tx<T>(
  fn: (client: PoolClient) => Promise<T>,
  pool: Pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // rollback 本身失败(连接已断等)不应遮蔽原始错误
    }
    throw err;
  } finally {
    client.release();
  }
}

// 生产模块不提供 TRUNCATE / DROP 之类的批量破坏性工具;
// 测试专用的 `truncateAllForTest` 见 `src/__tests__/helpers/db.ts`。
