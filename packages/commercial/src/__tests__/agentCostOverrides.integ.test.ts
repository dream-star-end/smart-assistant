/**
 * PR2 v1.0.66 — 0056_agent_cost_overrides.sql 集成测试。
 *
 * 覆盖:
 *   - 表结构(列名 / 类型 / 默认值 / PK)
 *   - CHECK 约束:multiplier ∈ [0.001, 10.000] 范围,边界 +1 / -1 拒
 *   - DEFAULT 行为:不写 cost_multiplier 时取 1.000
 *   - 幂等:0056 跑两次不报错(由 runMigrations 框架保证,这里只验数据持久)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";

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
  } catch {
    try { await p.end(); } catch { /* */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1)");
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  await query("DROP TABLE IF EXISTS agent_cost_overrides CASCADE");
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query("DROP TABLE IF EXISTS agent_cost_overrides CASCADE"); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("DELETE FROM agent_cost_overrides");
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

describe("0056_agent_cost_overrides", () => {
  test("表结构正确:agent_id PK + cost_multiplier NUMERIC(8,3) + updated_at", async (t) => {
    if (skipIfNoPg(t)) return;
    const cols = await query<{
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      column_default: string | null;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale,
              column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'agent_cost_overrides'
        ORDER BY ordinal_position`,
    );
    assert.equal(cols.rows.length, 3);

    const byName = new Map(cols.rows.map((c) => [c.column_name, c]));
    const idCol = byName.get("agent_id")!;
    assert.equal(idCol.data_type, "text");
    assert.equal(idCol.is_nullable, "NO");

    const mulCol = byName.get("cost_multiplier")!;
    assert.equal(mulCol.data_type, "numeric");
    assert.equal(mulCol.numeric_precision, 8);
    assert.equal(mulCol.numeric_scale, 3);
    assert.equal(mulCol.is_nullable, "NO");

    const tsCol = byName.get("updated_at")!;
    assert.equal(tsCol.data_type, "timestamp with time zone");
    assert.equal(tsCol.is_nullable, "NO");
  });

  test("DEFAULT 1.000 + 不写 cost_multiplier 时生效", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("INSERT INTO agent_cost_overrides(agent_id) VALUES ($1)", ["codex"]);
    const r = await query<{ cost_multiplier: string }>(
      "SELECT cost_multiplier::text AS cost_multiplier FROM agent_cost_overrides WHERE agent_id=$1",
      ["codex"],
    );
    assert.equal(r.rows[0].cost_multiplier, "1.000");
  });

  test("CHECK 约束:接受 0.001 / 1.000 / 10.000 边界", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
      ["a", "0.001"],
    );
    await query(
      "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
      ["b", "1.000"],
    );
    await query(
      "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
      ["c", "10.000"],
    );
    const r = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM agent_cost_overrides",
    );
    assert.equal(r.rows[0].cnt, "3");
  });

  test("CHECK 约束:拒 0 / 负值 / >10", async (t) => {
    if (skipIfNoPg(t)) return;
    // 0 (低于下限 0.001)
    await assert.rejects(
      () => query(
        "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
        ["a", "0.000"],
      ),
      /check constraint/i,
    );
    // 负值
    await assert.rejects(
      () => query(
        "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
        ["b", "-1.000"],
      ),
      /check constraint/i,
    );
    // >10
    await assert.rejects(
      () => query(
        "INSERT INTO agent_cost_overrides(agent_id, cost_multiplier) VALUES ($1, $2)",
        ["c", "10.001"],
      ),
      /check constraint/i,
    );
  });

  test("PK:同 agent_id 重复 INSERT 抛 23505", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("INSERT INTO agent_cost_overrides(agent_id) VALUES ($1)", ["codex"]);
    await assert.rejects(
      () => query("INSERT INTO agent_cost_overrides(agent_id) VALUES ($1)", ["codex"]),
      /duplicate key/i,
    );
  });

  test("UPDATE 更新 updated_at(显式写 now())", async (t) => {
    if (skipIfNoPg(t)) return;
    await query("INSERT INTO agent_cost_overrides(agent_id) VALUES ($1)", ["codex"]);
    const before = await query<{ updated_at: Date }>(
      "SELECT updated_at FROM agent_cost_overrides WHERE agent_id=$1",
      ["codex"],
    );
    // 等 1ms 保证时间戳不同
    await new Promise((r) => setTimeout(r, 5));
    await query(
      "UPDATE agent_cost_overrides SET cost_multiplier=$2, updated_at=NOW() WHERE agent_id=$1",
      ["codex", "1.500"],
    );
    const after = await query<{ updated_at: Date; cost_multiplier: string }>(
      "SELECT updated_at, cost_multiplier::text AS cost_multiplier FROM agent_cost_overrides WHERE agent_id=$1",
      ["codex"],
    );
    assert.equal(after.rows[0].cost_multiplier, "1.500");
    assert.ok(
      after.rows[0].updated_at.getTime() > before.rows[0].updated_at.getTime(),
      "updated_at must advance after explicit NOW()",
    );
  });
});
