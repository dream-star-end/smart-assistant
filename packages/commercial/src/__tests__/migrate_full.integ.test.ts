import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";

/**
 * T-03 集成测试:完整跑一次所有内置迁移,验证
 *   - 关键业务表和索引都落地
 *   - 关键种子数据存在且不会重复
 *   - usage_records.account_id 的 FK 在 0004 之后挂上
 *   - credit_ledger 的 append-only RULE 仍生效(回归)
 *   - admin_audit 的 append-only RULE 生效(新增)
 *
 * 复用 T-02 integ 的 fixture(同一 PG 实例),但用独立 suite 做隔离。
 * fixture 启动方式见 packages/commercial/README.md。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function cleanCommercialSchema(): Promise<void> {
  const rows = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'`,
  );
  if (rows.rows.length === 0) return;
  const quoted = rows.rows
    .map((r) => `"${r.table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await query(`DROP TABLE IF EXISTS ${quoted} CASCADE`);
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
          "See packages/commercial/README.md for bootstrap.",
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

describe("full migration suite", () => {
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

  test("seed: key model pricing and topup rows exist", async (t) => {
    if (skipIfNoPg(t)) return;
    await runMigrations();
    const duplicatedModels = await query<{ model_id: string; cnt: string }>(
      `SELECT model_id, COUNT(*)::text AS cnt
         FROM model_pricing
        GROUP BY model_id
       HAVING COUNT(*) > 1`,
    );
    assert.equal(duplicatedModels.rows.length, 0, "model_pricing must not duplicate model_id rows");

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

    const minimax = await query<{ enabled: boolean; visibility: string }>(
      "SELECT enabled, visibility FROM model_pricing WHERE model_id=$1",
      ["MiniMax-M3"],
    );
    assert.equal(minimax.rows.length, 1);
    assert.equal(minimax.rows[0].enabled, true);
    assert.equal(minimax.rows[0].visibility, "public");

    // 0082→0083: glm-5.1(火山方舟 Ark)定价不变;但 0083 把 visibility public→hidden(被 glm-5.2 替换,
    // 退 picker 但保留 enabled 兼容存量会话)。
    const glm = await query<{
      enabled: boolean;
      visibility: string;
      input_per_mtok: string;
      output_per_mtok: string;
      cache_read_per_mtok: string;
      cache_write_per_mtok: string;
      multiplier: string;
    }>(
      `SELECT enabled, visibility,
              input_per_mtok::text AS input_per_mtok,
              output_per_mtok::text AS output_per_mtok,
              cache_read_per_mtok::text AS cache_read_per_mtok,
              cache_write_per_mtok::text AS cache_write_per_mtok,
              multiplier::text AS multiplier
         FROM model_pricing WHERE model_id=$1`,
      ["glm-5.1"],
    );
    assert.equal(glm.rows.length, 1);
    assert.equal(glm.rows[0].enabled, true);
    assert.equal(glm.rows[0].visibility, "hidden");
    assert.equal(glm.rows[0].input_per_mtok, "600");
    assert.equal(glm.rows[0].output_per_mtok, "2400");
    assert.equal(glm.rows[0].cache_read_per_mtok, "120");
    assert.equal(glm.rows[0].cache_write_per_mtok, "0");
    assert.equal(glm.rows[0].multiplier, "1.000");

    // 0083: glm-5.2(火山方舟 Ark,2026-06-17 起平台默认/主力)public + enabled,定价参照 glm-5.1。
    const glm52 = await query<{
      enabled: boolean;
      visibility: string;
      input_per_mtok: string;
      output_per_mtok: string;
      multiplier: string;
    }>(
      `SELECT enabled, visibility,
              input_per_mtok::text AS input_per_mtok,
              output_per_mtok::text AS output_per_mtok,
              multiplier::text AS multiplier
         FROM model_pricing WHERE model_id=$1`,
      ["glm-5.2"],
    );
    assert.equal(glm52.rows.length, 1);
    assert.equal(glm52.rows[0].enabled, true);
    assert.equal(glm52.rows[0].visibility, "public");
    assert.equal(glm52.rows[0].input_per_mtok, "600");
    assert.equal(glm52.rows[0].output_per_mtok, "2400");
    assert.equal(glm52.rows[0].multiplier, "1.000");

    const plan1000 = await query<{ amount_cents: string; credits: string }>(
      "SELECT amount_cents::text AS amount_cents, credits::text AS credits FROM topup_plans WHERE code=$1",
      ["plan-1000"],
    );
    assert.equal(plan1000.rows[0].amount_cents, "100000");
    assert.equal(plan1000.rows[0].credits, "130000");
  });

  test("0123 atomically replaces GPT-5.5 with all GPT-5.6 models and migrates preferences", async (t) => {
    if (skipIfNoPg(t)) return;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sourceDir = path.resolve(here, "../db/migrations");
    const stagedDir = await mkdtemp(path.join(tmpdir(), "oc-gpt56-migrations-"));
    try {
      const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((name) => name < "0123_gpt56_models.sql")) {
        await copyFile(path.join(sourceDir, file), path.join(stagedDir, file));
      }
      await runMigrations({ dir: stagedDir });

      const user = await query<{ id: string }>(
        "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id::text AS id",
        ["gpt56-migration@example.com", "argon2$stub"],
      );
      const userId = user.rows[0].id;
      await query(
        `INSERT INTO user_preferences(user_id, prefs)
         VALUES ($1, '{"default_model":"gpt-5.5","default_effort":"xhigh","theme":"dark"}'::jsonb)`,
        [userId],
      );
      await query(
        "INSERT INTO model_visibility_grants(user_id, model_id) VALUES ($1, 'gpt-5.5')",
        [userId],
      );
      const oldGroupMappings = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM account_group_models WHERE model_id='gpt-5.5'",
      );

      await copyFile(
        path.join(sourceDir, "0123_gpt56_models.sql"),
        path.join(stagedDir, "0123_gpt56_models.sql"),
      );
      const applied = await runMigrations({ dir: stagedDir });
      assert.deepEqual(applied.applied, ["0123_gpt56_models"]);

      const models = await query<{
        model_id: string;
        enabled: boolean;
        visibility: string;
        input_per_mtok: string;
        output_per_mtok: string;
        multiplier: string;
      }>(
        `SELECT model_id, enabled, visibility,
                input_per_mtok::text AS input_per_mtok,
                output_per_mtok::text AS output_per_mtok,
                multiplier::text AS multiplier
           FROM model_pricing
          WHERE model_id IN ('gpt-5.5','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
          ORDER BY model_id`,
      );
      assert.deepEqual(models.rows.map((row) => row.model_id), [
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ]);
      const old = models.rows.find((row) => row.model_id === "gpt-5.5")!;
      assert.equal(old.enabled, false);
      assert.equal(old.visibility, "hidden");
      for (const model of models.rows.filter((row) => row.model_id !== "gpt-5.5")) {
        assert.equal(model.enabled, true);
        assert.equal(model.visibility, "public");
        assert.equal(model.input_per_mtok, old.input_per_mtok);
        assert.equal(model.output_per_mtok, old.output_per_mtok);
        assert.equal(model.multiplier, old.multiplier);
      }

      const prefs = await query<{ prefs: Record<string, unknown> }>(
        "SELECT prefs FROM user_preferences WHERE user_id=$1",
        [userId],
      );
      assert.deepEqual(prefs.rows[0].prefs, {
        theme: "dark",
        default_model: "gpt-5.6-sol",
        default_effort: "xhigh",
      });
      const mappings = await query<{ model_id: string; cnt: string }>(
        `SELECT model_id, COUNT(*)::text AS cnt
           FROM account_group_models
          WHERE model_id IN ('gpt-5.5','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
          GROUP BY model_id ORDER BY model_id`,
      );
      assert.deepEqual(mappings.rows, [
        { model_id: "gpt-5.6-luna", cnt: oldGroupMappings.rows[0].cnt },
        { model_id: "gpt-5.6-sol", cnt: oldGroupMappings.rows[0].cnt },
        { model_id: "gpt-5.6-terra", cnt: oldGroupMappings.rows[0].cnt },
      ]);
      const grants = await query<{ model_id: string }>(
        `SELECT model_id FROM model_visibility_grants
          WHERE user_id=$1 ORDER BY model_id`,
        [userId],
      );
      assert.deepEqual(grants.rows.map((row) => row.model_id), [
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ]);
    } finally {
      await rm(stagedDir, { recursive: true, force: true });
    }
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
    const beforeMp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM model_pricing",
    );
    const beforeTp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM topup_plans",
    );
    await query(seedSql);

    const mp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM model_pricing",
    );
    assert.equal(mp.rows[0].cnt, beforeMp.rows[0].cnt, "0007 re-run must not add model_pricing rows");
    const duplicatedModels = await query<{ model_id: string; cnt: string }>(
      `SELECT model_id, COUNT(*)::text AS cnt
         FROM model_pricing
        GROUP BY model_id
       HAVING COUNT(*) > 1`,
    );
    assert.equal(duplicatedModels.rows.length, 0, "model_pricing must not have duplicate model_id rows");

    const tp = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM topup_plans",
    );
    assert.equal(tp.rows[0].cnt, beforeTp.rows[0].cnt, "0007 re-run must not add topup_plans rows");
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
