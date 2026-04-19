import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import { createPool, closePool, setPoolOverride } from "../db/index.js";
import { query, tx, type QueryRunner } from "../db/queries.js";
import { truncateAllForTest } from "./helpers/db.js";

/**
 * T-01f db 集成测试。
 *
 * 需要启动 tests/fixtures/docker-compose.test.yml:
 *   docker compose -f tests/fixtures/docker-compose.test.yml up -d
 *
 * 默认情况下,pg 未启动时测试自动 skip(不算失败),方便本地开发。
 * 但在 CI(`CI=true`)或 `REQUIRE_TEST_DB=1` 时,直接 fail 而不是静默 skip —
 * 防止基础设施事务/参数化/连接池这些"关键假设"在没跑的情况下被合入。
 *
 * 约定的测试库连接:`postgres://test:test@127.0.0.1:55432/openclaude_test`
 * 库名必须以 `_test` 结尾,否则 truncateAllForTest 会拒绝,避免误清生产库。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function probe(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch (err) {
    // 打印到 stderr 便于诊断;仍按策略决定是 fail 还是 skip
    if (process.env.DEBUG_DB_PROBE) {
      console.error("[db.integ probe] failed:", err);
    }
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture is required (CI=true or REQUIRE_TEST_DB=1) but probe failed. " +
          "Start it via: docker compose -f tests/fixtures/docker-compose.test.yml up -d",
      );
    }
    return;
  }
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  // 准备一张临时表供本套件使用
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _db_integ_demo (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query("TRUNCATE TABLE _db_integ_demo RESTART IDENTITY");
});

after(async () => {
  if (pgAvailable) {
    try {
      await query("DROP TABLE IF EXISTS _db_integ_demo");
    } catch { /* ignore */ }
    await closePool();
  }
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running; run `docker compose -f tests/fixtures/docker-compose.test.yml up -d` then re-test");
    return true;
  }
  return false;
}

describe("db.integ", () => {
  test("pool connects and SELECT 1 works", async (t) => {
    if (skipIfNoPg(t)) return;
    const res = await query<{ "?column?": number }>("SELECT 1");
    assert.equal(res.rows[0]["?column?"], 1);
  });

  test("parameterized query rejects injection attempts", async (t) => {
    if (skipIfNoPg(t)) return;
    const nasty = "'); DROP TABLE _db_integ_demo; --";
    const inserted = await query<{ id: number; name: string }>(
      "INSERT INTO _db_integ_demo(name) VALUES ($1) RETURNING id, name",
      [nasty],
    );
    assert.equal(inserted.rows[0].name, nasty);
    const check = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM _db_integ_demo",
    );
    assert.equal(check.rows[0].cnt, "1");
  });

  test("tx commits when callback resolves", async (t) => {
    if (skipIfNoPg(t)) return;
    await truncateAllForTest(["_db_integ_demo"]);
    await tx(async (c) => {
      await c.query("INSERT INTO _db_integ_demo(name, n) VALUES ($1, $2)", ["a", 1]);
      await c.query("INSERT INTO _db_integ_demo(name, n) VALUES ($1, $2)", ["b", 2]);
    });
    const res = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM _db_integ_demo",
    );
    assert.equal(res.rows[0].cnt, "2");
  });

  test("tx rolls back when callback throws", async (t) => {
    if (skipIfNoPg(t)) return;
    await truncateAllForTest(["_db_integ_demo"]);
    await assert.rejects(
      tx(async (c) => {
        await c.query("INSERT INTO _db_integ_demo(name, n) VALUES ($1, $2)", ["x", 99]);
        throw new Error("boom");
      }),
      /boom/,
    );
    const res = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM _db_integ_demo",
    );
    assert.equal(res.rows[0].cnt, "0", "inserted row must be rolled back");
  });

  test("truncateAllForTest rejects invalid table names", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      truncateAllForTest(["users; DROP TABLE orders"]),
      /invalid table name/,
    );
  });

  test("truncateAllForTest refuses to run against non-test database", async () => {
    // 显式实现 QueryRunner,类型完整覆盖,比 `as never` 更能暴露接口漂移。
    // 这个 case 不依赖真实 pg —— 只用 stub 验证 guard 逻辑,所以不 skip。
    const stub: QueryRunner = {
      async query<Row extends QueryResultRow = QueryResultRow>(
        sql: string,
      ): Promise<QueryResult<Row>> {
        if (/current_database/i.test(sql)) {
          return {
            rows: [{ db: "production_db" } as unknown as Row],
            rowCount: 1,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        throw new Error(`stub should not see SQL: ${sql}`);
      },
    };
    await assert.rejects(
      truncateAllForTest(["_db_integ_demo"], stub),
      /refuses to run against non-test database/,
    );
  });

  test("statement_timeout is set on new connections", async (t) => {
    if (skipIfNoPg(t)) return;
    // pg 的 SHOW 返回的列名就是参数名本身
    const res = await query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    // pg 15 返回 "30s"
    assert.match(res.rows[0].statement_timeout, /^30\s*s(ec)?$|^30000$/i);
  });

  test("setPoolOverride refuses to replace an existing pool without closePool", async (t) => {
    if (skipIfNoPg(t)) return;
    const other = createPool({ connectionString: TEST_DB_URL, max: 1 });
    try {
      assert.throws(
        () => setPoolOverride(other),
        /pool already initialized/,
      );
    } finally {
      await other.end();
    }
  });
});
