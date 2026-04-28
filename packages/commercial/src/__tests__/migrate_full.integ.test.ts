import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";

/**
 * T-03 集成测试:完整跑一次所有内置迁移(0001-0007),验证
 *   - 所有业务表和索引都落地
 *   - 种子数据:model_pricing 2 条,topup_plans 4 条
 *   - usage_records.account_id 的 FK 在 0004 之后挂上
 *   - credit_ledger 的 append-only RULE 仍生效(回归)
 *   - admin_audit 的 append-only RULE 生效(新增)
 *
 * 复用 T-02 integ 的 fixture(同一 docker compose),但用独立 suite 做隔离。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

/** 涉及的所有商业化表,按 FK 依赖的逆序 DROP(child 在前)。 */
const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
  "user_preferences",
  "request_finalize_journal",
  "orders",
  "topup_plans",
  "usage_records",
  "credit_ledger",
  "model_pricing",
  "claude_accounts",
  "refresh_tokens",
  "email_verifications",
  "users",
  "schema_migrations",
];

async function cleanCommercialSchema(): Promise<void> {
  // DROP CASCADE 一条搞定(即使 FK 顺序反了也会被 CASCADE 拉平)
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`;
  await query(sql);
}

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
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "Start it: docker compose -f tests/fixtures/docker-compose.test.yml up -d",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await cleanCommercialSchema();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

describe("full migration suite 0001-0007", () => {
  test("all expected tables exist after running built-in migrations", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const rows = await query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = new Set(rows.rows.map((r) => r.table_name));
    const expected = [
      "admin_audit",
      "agent_audit",
      "agent_containers",
      "agent_subscriptions",
      "claude_accounts",
      "credit_ledger",
      "email_verifications",
      "model_pricing",
      "orders",
      "rate_limit_events",
      "refresh_tokens",
      "schema_migrations",
      "topup_plans",
      "usage_records",
      "users",
    ];
    for (const t of expected) {
      assert.ok(names.has(t), `missing table: ${t}`);
    }
  });

  test("seed: model_pricing=2 rows, topup_plans=4 rows", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const mp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM model_pricing",
    );
    assert.equal(mp.rows[0].cnt, "2");
    const tp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM topup_plans",
    );
    assert.equal(tp.rows[0].cnt, "4");

    // 验证关键种子值(防止单价被误改)
    const sonnet = await query<{ input_per_mtok: string; multiplier: string }>(
      "SELECT input_per_mtok::text AS input_per_mtok, multiplier::text AS multiplier FROM model_pricing WHERE model_id=$1",
      ["claude-sonnet-4-6"],
    );
    assert.equal(sonnet.rows.length, 1);
    assert.equal(sonnet.rows[0].input_per_mtok, "300");
    assert.equal(sonnet.rows[0].multiplier, "2.000");

    const plan1000 = await query<{ amount_cents: string; credits: string }>(
      "SELECT amount_cents::text AS amount_cents, credits::text AS credits FROM topup_plans WHERE code=$1",
      ["plan-1000"],
    );
    assert.equal(plan1000.rows[0].amount_cents, "100000");
    assert.equal(plan1000.rows[0].credits, "130000");
  });

  test("re-running migrations is still idempotent (applied=0 skipped=7)", async (t) => {
    if (skipIfNoPg(t)) return;
    const r1 = await runMigrations();
    const total = r1.applied.length;
    assert.ok(total >= 7, `expected >=7 applied, got ${total}`);
    const r2 = await runMigrations();
    assert.equal(r2.applied.length, 0);
    assert.equal(r2.skipped.length, total);
  });

  test("seed migrations are idempotent on re-run: no duplicate-key failures, no duplicated rows", async (t) => {
    if (skipIfNoPg(t)) return;
    // 第一次:完整 migrate
    await runMigrations();
    // 要测 0007_seed_pricing 的 ON CONFLICT DO NOTHING 是否幂等。
    // 直接走 runMigrations 二次 apply 0007 不可行:框架按 version 顺序记账,
    // 0008+ 已 applied,删 0007 会触发 out-of-order 守卫;不删 0007 又不会重跑。
    // 所以这里**直接** 读 0007 的 SQL body,在新事务里再执行一次 —— 这正是
    // 该 SQL 必须幂等的真实场景(运维误手 / 部署回滚 / 跨环境复制)。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const seedSqlPath = path.resolve(here, "../db/migrations/0007_seed_pricing.sql");
    const seedSql = await readFile(seedSqlPath, "utf8");
    await query(seedSql);

    const mp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM model_pricing",
    );
    assert.equal(mp.rows[0].cnt, "2", "model_pricing must not have duplicates");
    const tp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM topup_plans",
    );
    assert.equal(tp.rows[0].cnt, "4", "topup_plans must not have duplicates");
  });

  test("FK: usage_records.account_id references claude_accounts after 0004 + SET NULL after 0044", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const fkRows = await query<{
      conname: string; conrelid: string; confrelid: string; convalidated: boolean;
    }>(
      `SELECT conname,
              conrelid::regclass::text AS conrelid,
              confrelid::regclass::text AS confrelid,
              convalidated
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'usage_records'::regclass
          AND confrelid = 'claude_accounts'::regclass`,
    );
    assert.equal(fkRows.rows.length, 1, "expected exactly one FK from usage_records to claude_accounts");
    assert.equal(fkRows.rows[0].convalidated, true, "FK must be validated (not NOT VALID)");

    // 0044 把 fk_usage_records_account 的 delete_rule 从 RESTRICT 改成 SET NULL,
    // 让 admin 删除账号时历史 usage_records 自动孤儿化。
    const ruleRows = await query<{ delete_rule: string }>(
      `SELECT delete_rule
         FROM information_schema.referential_constraints
        WHERE constraint_name = 'fk_usage_records_account'`,
    );
    assert.equal(ruleRows.rows.length, 1, "fk_usage_records_account must exist");
    assert.equal(ruleRows.rows[0].delete_rule, "SET NULL", "0044 must change delete_rule to SET NULL");
  });

  test("admin_audit RULE blocks UPDATE and DELETE (append-only)", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    // 先造一个 admin user
    const admin = await query<{ id: string }>(
      "INSERT INTO users(email, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
      ["admin-rule-test@example.com", "argon2$stub", "admin"],
    );
    const adminId = admin.rows[0].id;

    await query(
      "INSERT INTO admin_audit(admin_id, action, target) VALUES ($1, $2, $3)",
      [adminId, "user.ban", "user:42"],
    );

    await query(
      "UPDATE admin_audit SET action = $1 WHERE admin_id = $2",
      ["HACKED", adminId],
    );
    await query("DELETE FROM admin_audit WHERE admin_id = $1", [adminId]);

    const rows = await query<{ action: string }>(
      "SELECT action FROM admin_audit WHERE admin_id = $1",
      [adminId],
    );
    assert.equal(rows.rows.length, 1, "DELETE must be a no-op");
    assert.equal(rows.rows[0].action, "user.ban", "UPDATE must be a no-op");
  });

  test("agent_subscriptions unique-active-per-user constraint", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    const u = await query<{ id: string }>(
      "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id",
      ["agent-sub-test@example.com", "argon2$stub"],
    );
    const userId = u.rows[0].id;

    await query(
      "INSERT INTO agent_subscriptions(user_id, plan, end_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [userId, "basic"],
    );

    // 同一用户再插 active 订阅 → unique index 挡住
    await assert.rejects(
      query(
        "INSERT INTO agent_subscriptions(user_id, plan, end_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
        [userId, "basic"],
      ),
      /duplicate key value|idx_as_one_active_per_user/i,
    );

    // 但如果把第一个标成 canceled,就可以再插 active(partial unique 只管 status='active')
    await query(
      "UPDATE agent_subscriptions SET status = 'canceled' WHERE user_id = $1",
      [userId],
    );
    await query(
      "INSERT INTO agent_subscriptions(user_id, plan, end_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [userId, "basic"],
    );
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM agent_subscriptions WHERE user_id=$1",
      [userId],
    );
    assert.equal(cnt.rows[0].cnt, "2");
  });

  test("agent_containers unique user_id (each user at most 1 container)", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();

    const u = await query<{ id: string }>(
      "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id",
      ["agent-ctn-test@example.com", "argon2$stub"],
    );
    const userId = u.rows[0].id;
    const sub = await query<{ id: string }>(
      "INSERT INTO agent_subscriptions(user_id, plan, end_at) VALUES ($1, $2, NOW() + INTERVAL '30 days') RETURNING id",
      [userId, "basic"],
    );
    const subId = sub.rows[0].id;

    await query(
      `INSERT INTO agent_containers(user_id, subscription_id, docker_name, workspace_volume, home_volume, image)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, subId, `agent-u${userId}`, `agent-u${userId}-workspace`, `agent-u${userId}-home`, "openclaude/agent:v1"],
    );

    await assert.rejects(
      query(
        `INSERT INTO agent_containers(user_id, subscription_id, docker_name, workspace_volume, home_volume, image)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, subId, `agent-u${userId}-2`, `agent-u${userId}-ws2`, `agent-u${userId}-home2`, "openclaude/agent:v1"],
      ),
      /duplicate key value|agent_containers_user_id_key/i,
    );
  });
});
