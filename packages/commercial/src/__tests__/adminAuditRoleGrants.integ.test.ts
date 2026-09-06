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
 *   Part 2(部署角色):枚举真实部署角色 openclaude_app / openclaude_model_admin,断言其能写
 *     admin_audit(属主 或 显式 INSERT)。测试库无安装 runbook → before() 按 runbook 临时建角色
 *     (2026-09-06 OCV5-123:nightly G2 钉死 skipped=0,原"缺席则 skip"在 0164 合入后已是死分支)。
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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  await provisionDeploymentRolesIfAbsent();
});

after(async () => {
  if (!pgAvailable) return;
  await dropProvisionedRoles();
  await closePool();
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

/**
 * 0164 已于 2026-07 合入,但 CI 测试库从不跑安装 runbook,部署角色永远缺席 → Part2 从未激活。
 * nightly integ 门 G2 钉死 skipped 必须为 0(OCV5-123 N2C 首跑即撞)。这里按 0144 尾 runbook +
 * migration0164.integ.test.ts 的同一路径把两个部署角色在测试库临时建出来:
 *   - openclaude_app:runbook 里 `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES ... TO openclaude_app`
 *     + fn_model_authority_grant_app_role(生产里它还是属主;这里用显式 INSERT 复刻可写性);
 *   - openclaude_model_admin:CREATE ROLE 后重放 0164,让 DO 块经 fn_model_authority_grant_admin_role 落地授权。
 * 只建缺席的角色并在 after 里 DROP OWNED + DROP ROLE;已存在的(本机跑过 runbook)一律不动。
 */
const provisionedRoles: string[] = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0164 = path.resolve(here, "../db/migrations/0164_admin_audit_model_admin_grant.sql");

async function provisionDeploymentRolesIfAbsent(): Promise<void> {
  for (const { role } of ADMIN_AUDIT_WRITER_ROLES) {
    if (await roleExists(role)) continue;
    await query(`CREATE ROLE ${role} NOLOGIN`);
    provisionedRoles.push(role);
    await query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    if (role === "openclaude_app") {
      await query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await query(`SELECT fn_model_authority_grant_app_role($1)`, [role]);
    }
  }
  if (provisionedRoles.includes("openclaude_model_admin")) {
    // role 存在后重放 0164:DO 块此时才真正 PERFORM fn_model_authority_grant_admin_role。
    await query(await readFile(MIGRATION_0164, "utf8"));
  }
}

async function dropProvisionedRoles(): Promise<void> {
  for (const role of provisionedRoles.splice(0)) {
    await query(`DROP OWNED BY ${role}`).catch(() => {});
    await query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
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

  test("Part2: 部署角色(app / model_admin)能写 admin_audit(测试库按 runbook 临时建角色;0164 已合入)", async (t) => {
    if (skipIfNoPg(t)) return;
    for (const { role, access } of ADMIN_AUDIT_WRITER_ROLES) {
      assert.equal(await roleExists(role), true, `部署角色 ${role} 应由 before() 按 runbook 建出;缺席是夹具 bug,不再 skip`);
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
  });
});
