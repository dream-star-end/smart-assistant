/**
 * 角色 × admin_audit 写权限契约(批D D4;2026-07-16 catalog switch 全量 500 事故根治)。
 *
 * admin 路由模块经**两个连接池角色**写 admin_audit:
 *   - app 角色(默认池 db/index.ts getPool;生产里是 admin_audit 的**属主**,靠所有权 INSERT);
 *   - model_admin 角色(模型目录管理池 db/modelCatalogAdmin.ts;**非属主最小权限**角色,
 *     靠 fn_model_authority_grant_admin_role 的**显式** GRANT INSERT 才能写)。
 * 2026-07-16 事故:model_admin 缺 `SELECT (id)` 列权限 → INSERT..RETURNING permission denied
 * → 业务事务连带回滚 → catalog switch 全量 500。0154 补了列权限。本契约把"每个写 admin_audit
 * 的角色都真的有 INSERT(+ RETURNING 所需列 SELECT)"钉成 integ 门,防同类权限回退。
 *
 * 结构:
 *   Part 1(自足,连库即跑):对临时角色跑 fn_model_authority_grant_admin_role,查
 *     information_schema.role_table_grants / column_privileges 断言拿到 admin_audit
 *     INSERT + SELECT(id) —— 直接验证 model_admin 的**授权函数**契约。
 *   Part 2(部署角色,0164 前 skip):枚举真实部署角色 openclaude_app / openclaude_model_admin,
 *     存在才断言其能写 admin_audit(属主 或 显式 INSERT);不存在则 skip 并注明依赖。
 *
 * ⚠ 合并顺序依赖:批A 的迁移 0164 补 model_admin 的 grant。0164 合并前,本 worktree 无 0164、
 * 部署角色也未建 → Part 2 走 skip(不误红);Part 1 自足验证授权函数,现在即绿。
 * **合并顺序:A 先 D 后**(0164 到位后 Part 2 自动激活校验部署角色)。
 *
 * 跑法(需测试 PG,见 packages/commercial/README.md):
 *   TEST_DATABASE_URL=... npx tsx --test packages/commercial/src/__tests__/adminAuditRoleGrants.integ.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

/**
 * admin 路由模块使用的写 admin_audit 的池角色(名字来自安装约定,见迁移 0144 尾 runbook)。
 *   - app       = 默认池,生产里是 admin_audit 属主(靠所有权写);
 *   - model_admin = 模型目录管理池,非属主最小权限角色(靠显式 GRANT 写)。
 */
const ADMIN_AUDIT_WRITER_ROLES = [
  { role: "openclaude_app", access: "owner-or-grant" as const },
  { role: "openclaude_model_admin", access: "grant" as const },
];

let pgAvailable = false;
let migrated = false;

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
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
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1).");
    }
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
  // 清库 + 全量迁移一次,后续断言共用。
  await resetTestSchemaForTest();
  await runMigrations();
  migrated = true;
});

after(async () => {
  if (pgAvailable) await closePool();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function hasInsertGrant(role: string): Promise<boolean> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='admin_audit'
        AND grantee=$1 AND privilege_type='INSERT'`,
    [role],
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

async function hasColumnSelect(role: string, column: string): Promise<boolean> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name='admin_audit'
        AND column_name=$2 AND grantee=$1 AND privilege_type='SELECT'`,
    [role, column],
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

async function roleExists(role: string): Promise<boolean> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pg_roles WHERE rolname=$1`,
    [role],
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

async function isTableOwner(role: string): Promise<boolean> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pg_tables
      WHERE schemaname='public' AND tablename='admin_audit' AND tableowner=$1`,
    [role],
  );
  return Number(r.rows[0]?.n ?? "0") > 0;
}

describe("角色 × admin_audit 写权限契约", () => {
  test("Part1: fn_model_authority_grant_admin_role 给 model_admin 授足 admin_audit INSERT + RETURNING 列", async (t) => {
    if (skipIfNoPg(t)) return;
    assert.ok(migrated, "迁移应已在 before() 跑完");
    const tempRole = `d4_madmin_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await query(`CREATE ROLE "${tempRole}" NOLOGIN`);
    try {
      await query(`SELECT fn_model_authority_grant_admin_role($1)`, [tempRole]);
      assert.equal(
        await hasInsertGrant(tempRole),
        true,
        "model_admin 授权函数必须给 admin_audit INSERT",
      );
      assert.equal(
        await hasColumnSelect(tempRole, "id"),
        true,
        "model_admin 授权函数必须给 admin_audit.id 列级 SELECT(INSERT..RETURNING id 所需;2026-07-16 事故点)",
      );
    } finally {
      // 先撤销该角色的所有授权/属权,再 DROP(cluster-global 角色,清理要彻底)。
      await query(`DROP OWNED BY "${tempRole}"`).catch(() => {});
      await query(`DROP ROLE IF EXISTS "${tempRole}"`).catch(() => {});
    }
  });

  test("Part1b: fn_model_authority_grant_app_role 对 app 角色成功(不误授 admin_audit;app 靠属主写)", async (t) => {
    if (skipIfNoPg(t)) return;
    const tempRole = `d4_app_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    await query(`CREATE ROLE "${tempRole}" NOLOGIN`);
    try {
      // 授权函数存在 & 幂等可跑(role 不存在会 RAISE;此处角色已建)。
      await query(`SELECT fn_model_authority_grant_app_role($1)`, [tempRole]);
      // app 授权策略**不**显式授 admin_audit INSERT(生产里 app 是属主,靠所有权写)——
      // 钉住这条,防未来把 app 的最小权限策略与 model_admin 混淆。
      assert.equal(
        await hasInsertGrant(tempRole),
        false,
        "grant_app_role 不应显式授 admin_audit INSERT(app 靠属主;混入会破坏最小权限边界)",
      );
    } finally {
      await query(`DROP OWNED BY "${tempRole}"`).catch(() => {});
      await query(`DROP ROLE IF EXISTS "${tempRole}"`).catch(() => {});
    }
  });

  test("Part2: 部署角色(app / model_admin)能写 admin_audit —— 存在才断言,缺失则 skip(依赖批A 0164)", async (t) => {
    if (skipIfNoPg(t)) return;
    const skipped: string[] = [];
    for (const { role, access } of ADMIN_AUDIT_WRITER_ROLES) {
      if (!(await roleExists(role))) {
        skipped.push(role);
        continue;
      }
      const owner = await isTableOwner(role);
      const insert = await hasInsertGrant(role);
      const ok = access === "grant" ? insert : owner || insert;
      assert.equal(
        ok,
        true,
        `部署角色 ${role} 无法写 admin_audit(owner=${owner} insert=${insert});` +
          `admin 路由经该角色 writeAdminAudit 会 permission denied → 事务回滚(2026-07-16 同类事故)`,
      );
    }
    if (skipped.length > 0) {
      // 0164 合并前部署角色未建 → 显式记录跳过原因,不误报绿也不误报红。
      t.skip(
        `部署角色 ${skipped.join(", ")} 在测试库不存在(未跑安装 runbook / 批A 0164 未合并);` +
          `合并顺序 A 先 D 后:0164 到位后本断言自动激活。Part1 已自足验证授权函数契约。`,
      );
    }
  });
});
