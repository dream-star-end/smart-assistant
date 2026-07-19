/**
 * 集成:0164 迁移 —— openclaude_model_admin 对 admin_audit 的三项授权就位后,
 * writeAdminAudit 形态的 `INSERT ... RETURNING id` 在该窄角色下必须成功(止血批 A · A2)。
 *
 * 背景(止血批 A · A1):/api/admin/model-catalog 的写走 getModelCatalogAdminPool()
 * (= openclaude_model_admin 角色);writeAdminAudit 是 mode='tx' 的 fail-closed 审计,
 * 执行 `INSERT INTO admin_audit(...) RETURNING id::text`。该语句在 PG 下需要三项权限:
 * ① INSERT ② 列级 SELECT(id)(RETURNING 用)③ admin_audit_id_seq 的 USAGE/SELECT。
 * 现网该角色缺 ② → RETURNING 被拒 → 审计写失败 → 业务回滚 → POST 500。
 *
 * 为什么现有 modelCatalogAdmin.integ.test.ts 抓不到:它 setModelCatalogAdminPoolOverride(owner pool),
 * 以**表 owner**(全权限)落库,从不以真正的 openclaude_model_admin 窄角色走一遍 —— 本文件补这个洞:
 * 真建角色 → 跑 0164 → 以该角色 SET LOCAL ROLE 实打实 INSERT..RETURNING。
 *
 * pg 不可用 → skip;并发写共享 octest PG 必经 test-mutex(见 v5-feature-workflow)。
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
// 迁移/config import 前先把最小必填键喂上,避免 loadConfig 在 import 期抛(与本测试无关的假红)。
process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL ??= "redis://127.0.0.1:56379/0";
process.env.JWT_SECRET ??= "z".repeat(64);
process.env.OC_MODEL_AUTHORITY = "1";

const { createPool, closePool, setPoolOverride, resetPool } = await import("../db/index.js");
const { query } = await import("../db/queries.js");
const { runMigrations } = await import("../db/migrate.js");
const { resetTestSchemaForTest } = await import("./helpers/db.js");

const ROLE = "openclaude_model_admin";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0164 = path.resolve(here, "../db/migrations/0164_admin_audit_model_admin_grant.sql");

let pgAvailable = false;
let pool: Pool;

/** 幂等清掉本测试角色:先 DROP OWNED(撤销其在本库所有授权),再 DROP ROLE。 */
async function dropRoleIfExists(): Promise<void> {
  await query(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    EXECUTE 'DROP OWNED BY ${ROLE}';
    EXECUTE 'DROP ROLE ${ROLE}';
  END IF;
END $$;`);
}

before(async () => {
  const probe = createPool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    pgAvailable = true;
  } catch {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!pgAvailable) return;

  await resetPool();
  pool = createPool({ connectionString: TEST_DB_URL, max: 4 });
  setPoolOverride(pool);
  // 全量重放迁移(0164 依赖 0006 admin_audit + 0144/0154 的 grant 函数)。此时 ROLE 不存在,
  // 0164 的 DO 块空跑 —— 顺带证明「role 缺席时 0164 是干净 no-op」。
  await resetTestSchemaForTest();
  await runMigrations();

  // 建窄角色后**重跑 0164**(此刻 role 已存在 → DO 块经权威 grant 函数落地三项授权)。
  await dropRoleIfExists();
  await query(`CREATE ROLE ${ROLE} NOLOGIN`);
  // 复刻生产前置:public schema 的 USAGE。生产里 openclaude_model_admin 经 bootstrap public
  // schema(默认 PUBLIC 有 USAGE)/ 割接 runbook 已具备;本测试 resetTestSchemaForTest 重建的
  // public 不带该默认 grant,不补则角色连 public.admin_audit 都解析不到(42P01)。schema USAGE
  // 属安装/割接职责,**不在 0164 的每表审计授权范围内**,故只在测试夹具里补。
  await query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  const sql = await readFile(MIGRATION_0164, "utf8");
  await query(sql);
});

after(async () => {
  if (!pgAvailable) return;
  try {
    await dropRoleIfExists();
  } catch {
    /* best-effort */
  }
  await closePool();
});

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip("Postgres unavailable");
    await fn();
  });
}

describe("0164 — admin_audit grants for openclaude_model_admin", () => {
  maybe("catalog 授权就位:INSERT + 列级 SELECT(id) + 序列 USAGE,且不给整表 SELECT(最小权限)", async () => {
    const r = await query<{
      ins: boolean;
      sel_id: boolean;
      seq: boolean;
      tbl_sel: boolean;
    }>(
      `SELECT
         has_table_privilege($1, 'admin_audit', 'INSERT')            AS ins,
         has_column_privilege($1, 'admin_audit', 'id', 'SELECT')     AS sel_id,
         has_sequence_privilege($1, 'admin_audit_id_seq', 'USAGE')   AS seq,
         has_table_privilege($1, 'admin_audit', 'SELECT')            AS tbl_sel`,
      [ROLE],
    );
    const row = r.rows[0]!;
    assert.equal(row.ins, true, "缺 INSERT → 无法写审计");
    assert.equal(row.sel_id, true, "缺列级 SELECT(id) → RETURNING id 被拒(0164 的核心洞)");
    assert.equal(row.seq, true, "缺序列 USAGE → BIGSERIAL 默认值取号被拒");
    assert.equal(row.tbl_sel, false, "最小权限:不得开放整表 SELECT(审计正文对该窄角色不可见)");
  });

  maybe("端到端:以 openclaude_model_admin 角色执行 writeAdminAudit 形态的 INSERT..RETURNING id 必须成功", async () => {
    // FK admin_audit.admin_id → users(id):先以 owner 造一个 user(RI 检查不走 grantee 权限)。
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, credits, role, status)
       VALUES ('mc0164@test.local','argon2$stub',0,'admin','active')
       RETURNING id::text AS id`,
    );
    const adminId = u.rows[0]!.id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // SET LOCAL ROLE:后续语句以 openclaude_model_admin 身份执行,事务结束自动复位。
      await client.query(`SET LOCAL ROLE ${ROLE}`);
      const r = await client.query<{ id: string }>(
        `INSERT INTO admin_audit(admin_id, action, target, before, after, ip, user_agent)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING id::text AS id`,
        [adminId, "model_catalog.stage", "model:mc-0164", null, JSON.stringify({ state: "staged" }), null, null],
      );
      assert.ok(r.rows[0]?.id, "RETURNING id 必须返回自增主键(证明 INSERT + 列级 SELECT(id) + seq 三项齐全)");
      assert.match(r.rows[0]!.id, /^[1-9][0-9]*$/);
      // 回滚:本测试不留审计脏数据(端到端只验权限,不验持久化)。
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
