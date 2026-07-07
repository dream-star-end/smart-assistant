/**
 * v5 审计整改 —— 纯单元测试(无 PG，用假 PoolClient 记录/回放 SQL)。
 *
 * 覆盖:
 *   §2  updateMember — billing_enabled 变更 owner-only 守卫(事务内、行锁后判定)
 *   §3b updateOrg   — status 置 'deleted' 时级联把 active 成员挂起(释放 uq_user_active_org)
 *   §5  config      — COMMERCIAL_JWT_SECRET / JWT_SECRET 长度 < 32 启动期 fail-closed
 *
 * §1(router 通配)/§3a(acceptInvitation JOIN)/§4(封号撤 token)走真 PG,见
 * orgAuditRemediation.integ.test.ts。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { loadConfig, ConfigError } from "../config.js";
import { updateMember, type MembershipRow } from "../org/memberships.js";
import { updateOrg } from "../org/orgs.js";
import { OrgError } from "../org/types.js";

// ─── 假 PoolClient:按 SQL 内容回放 canned rows,记录全部调用 ────────────

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeFakeClient(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number }): {
  client: PoolClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client = {
    // updateMember/updateOrg 只用 client.query(sql, params)
    query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return Promise.resolve(handler(sql, params));
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const MEMBER: MembershipRow = {
  org_id: "10",
  user_id: "20",
  org_role: "member",
  status: "active",
  billing_enabled: false, // owner 已关掉计费
  billing_delegate: false,
  monthly_org_budget: null,
  invited_by: null,
  joined_at: new Date(),
};

function memberClient() {
  return makeFakeClient((sql) => {
    if (/^\s*SELECT/i.test(sql) && /org_memberships/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: [{ ...MEMBER }], rowCount: 1 };
    }
    if (/UPDATE org_memberships SET/.test(sql)) {
      // 回放"更新后"行(不精确解析 sets，测试断言以 SQL/params 为准)
      return { rows: [{ ...MEMBER, billing_enabled: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("§2 updateMember billing_enabled owner-only", () => {
  test("admin 改 billing_enabled 被拒(FORBIDDEN),且不发 UPDATE", async () => {
    const { client, calls } = memberClient();
    await assert.rejects(
      () =>
        updateMember("10", "20", { billingEnabled: true }, client, {
          role: "admin",
          userId: "99",
        }),
      (err: unknown) => {
        assert.ok(err instanceof OrgError, "expected OrgError");
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      },
    );
    // 只跑了 SELECT ... FOR UPDATE，绝不能落 UPDATE
    assert.ok(
      !calls.some((c) => /UPDATE org_memberships SET/.test(c.sql)),
      "admin 被拒时不应发出任何 UPDATE",
    );
  });

  test("owner 改 billing_enabled 通过并落 UPDATE(含 billing_enabled 列)", async () => {
    const { client, calls } = memberClient();
    const row = await updateMember("10", "20", { billingEnabled: true }, client, {
      role: "owner",
      userId: "1",
    });
    const upd = calls.find((c) => /UPDATE org_memberships SET/.test(c.sql));
    assert.ok(upd, "owner 应发出 UPDATE");
    assert.ok(/billing_enabled = \$/.test(upd.sql), "UPDATE 应包含 billing_enabled 列");
    assert.ok(upd.params.includes(true), "参数里应带 billing_enabled=true");
    assert.equal(row.billing_enabled, true);
  });

  test("admin 改 status(非 billing)仍可通过 —— 守卫只收紧 billing", async () => {
    const { client, calls } = memberClient();
    await updateMember("10", "20", { status: "suspended" }, client, {
      role: "admin",
      userId: "99",
    });
    assert.ok(
      calls.some((c) => /UPDATE org_memberships SET/.test(c.sql)),
      "admin 改 status 应正常 UPDATE(未被 billing 守卫误伤)",
    );
  });
});

// ─── §3b updateOrg 软删除级联 ───────────────────────────────────────

const ORG_ROW = {
  id: "10",
  name: "Acme",
  status: "active",
  credits: "0",
  max_members: 100,
  created_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function orgClient(nextStatus: string) {
  return makeFakeClient((sql) => {
    if (/FROM orgs\s+WHERE id/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: [{ ...ORG_ROW }], rowCount: 1 };
    }
    if (/UPDATE orgs SET/.test(sql)) {
      return { rows: [{ ...ORG_ROW, status: nextStatus }], rowCount: 1 };
    }
    if (/UPDATE org_memberships/.test(sql)) {
      return { rows: [], rowCount: 3 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("§3b updateOrg status='deleted' 级联挂起成员", () => {
  test("置 deleted → 发出 org_memberships 挂起级联(WHERE status='active')", async () => {
    const { client, calls } = orgClient("deleted");
    await updateOrg("10", { status: "deleted" }, client);
    const cascade = calls.find((c) => /UPDATE org_memberships/.test(c.sql));
    assert.ok(cascade, "deleted 应触发成员挂起级联");
    assert.ok(/status = 'suspended'/.test(cascade.sql), "级联应把成员 status 置 suspended");
    assert.ok(/status = 'active'/.test(cascade.sql), "级联只挂起当前 active 成员");
    assert.deepEqual(cascade.params, ["10"]);
  });

  test("置 suspended → 不级联(仅 deleted 才解锁)", async () => {
    const { client, calls } = orgClient("suspended");
    await updateOrg("10", { status: "suspended" }, client);
    assert.ok(
      !calls.some((c) => /UPDATE org_memberships/.test(c.sql)),
      "suspended 不应触发成员级联(org 可能恢复)",
    );
  });

  test("仅改 name → 不级联", async () => {
    const { client, calls } = orgClient("active");
    await updateOrg("10", { name: "NewName" }, client);
    assert.ok(!calls.some((c) => /UPDATE org_memberships/.test(c.sql)));
  });
});

// ─── §5 JWT secret 长度校验 ─────────────────────────────────────────

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/openclaude_test",
  REDIS_URL: "redis://localhost:6379/0",
  COMMERCIAL_ENABLED: "1",
};

describe("§5 config JWT secret min length (fail-closed)", () => {
  test("COMMERCIAL_JWT_SECRET < 32 字符 → ConfigError", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, COMMERCIAL_JWT_SECRET: "x".repeat(31) }),
      ConfigError,
    );
  });

  test("JWT_SECRET < 32 字符 → ConfigError", () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, JWT_SECRET: "short" }), ConfigError);
  });

  test("COMMERCIAL_JWT_SECRET == 32 字符 → 通过", () => {
    const cfg = loadConfig({ ...VALID_ENV, COMMERCIAL_JWT_SECRET: "x".repeat(32) });
    assert.equal(cfg.COMMERCIAL_JWT_SECRET, "x".repeat(32));
  });

  test("两者都缺省 → 通过(optional;非空由 index.ts 兜底)", () => {
    const cfg = loadConfig(VALID_ENV);
    assert.equal(cfg.COMMERCIAL_JWT_SECRET, undefined);
    assert.equal(cfg.JWT_SECRET, undefined);
  });
});
