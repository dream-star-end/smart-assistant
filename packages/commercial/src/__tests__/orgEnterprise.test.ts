/**
 * 企业版(P3.1)批次 A 行为测试 —— 真 DB round-trip。
 *
 * 隔离策略:本文件用**专属数据库**(openclaude_orga_test,before 里 CREATE / after DROP),
 * 不碰共享 openclaude_test.public。原因:unit 套件里另有若干 `DROP SCHEMA public` 型测试
 * 并发跑,共享库上做整库重置会互相打架(基线 ~70 失败即含此类竞争)。专属库让本文件在
 * 并发 unit 运行下确定性通过,零跨文件干扰。
 *
 * 覆盖:requireOrgRole 角色序 + suspended → 403;邀请全生命周期(创建/邮箱不匹配/过期/
 * 席位满/已有 org/接受/撤销/重发覆盖);owner 唯一性与转让;踢人/改角色权限矩阵(经
 * dispatchOrgRoute 端到端);handleMe org 字段;admin 建 org(重复 owner 拒 + 审计)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Client } from "pg";
import { createPool, closePool, getPool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { requireOrgRole } from "../org/requireOrgRole.js";
import { createOrg } from "../org/orgs.js";
import { getActiveMembership, getMembership, transferOwner } from "../org/memberships.js";
import {
  createInvitation,
  acceptInvitation,
  listInvitations,
  revokeInvitation,
} from "../org/invitations.js";
import { createOrgByEmail, listOrgs, patchOrg } from "../admin/orgs.js";
import { OrgError } from "../org/types.js";
import { dispatchOrgRoute } from "../http/org/routes.js";
import { handleMe } from "../http/handlers.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orga_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const MY_URL = withDb(BASE_URL, MY_DB);

let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  try {
    await adminExec("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  // 专属库:先杀连接再重建,避免上次残留占用
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`);
  await adminExec(`CREATE DATABASE ${MY_DB} TEMPLATE template0`);

  await resetPool();
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10 }));
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  await closePool();
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`).catch(() => {});
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE TABLE orgs, org_memberships, org_invitations, users, admin_audit,
       inbox_messages, inbox_message_reads, user_subscriptions, credit_ledger, usage_records
     RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

// ─── fixtures ───────────────────────────────────────────────────────

async function createUser(
  email: string,
  opts: { role?: "user" | "admin"; status?: string } = {},
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled)
     VALUES ($1, 'argon2$stub', $2, $3, TRUE, TRUE) RETURNING id::text AS id`,
    [email, opts.role ?? "user", opts.status ?? "active"],
  );
  return r.rows[0].id;
}

async function makeOrg(ownerId: string, name = "Acme", maxMembers = 100): Promise<string> {
  return tx(async (client) => {
    const o = await createOrg({ name, ownerUserId: ownerId, createdBy: null, maxMembers }, client);
    return o.id;
  });
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
  status: "active" | "suspended" = "active",
): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, $3, $4, TRUE)`,
    [orgId, userId, role, status],
  );
}

async function token(uid: string, role: "user" | "admin" = "user"): Promise<string> {
  const r = await signAccess({ sub: uid, role }, JWT_SECRET);
  return r.token;
}

// ─── fake HTTP req/res 驱动 dispatchOrgRoute(免 Redis/HTTP server)────

function makeReq(method: string, path: string, tok?: string, body?: unknown): Readable {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(bodyStr.length > 0 ? [Buffer.from(bodyStr)] : []) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress: string };
  };
  req.method = method;
  req.url = path;
  req.headers = { host: "x.invalid", ...(tok ? { authorization: `Bearer ${tok}` } : {}) };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

interface FakeRes {
  statusCode: number;
  _body: string;
  headers: Record<string, unknown>;
  setHeader(k: string, v: unknown): void;
  getHeader(k: string): unknown;
  end(b?: string): void;
  headersSent: boolean;
}

function makeRes(): FakeRes {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 200,
    _body: "",
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    end(b) {
      this._body = b ?? "";
    },
    headersSent: false,
  };
}

const noopDeps = {
  jwtSecret: JWT_SECRET,
  mailer: { send: async () => {} },
  verifyEmailUrlBase: "https://test.local",
} as unknown as CommercialHttpDeps;

const fakeCtx = {
  requestId: "t",
  clientIp: "127.0.0.1",
  authBoundIp: "127.0.0.1",
  userAgent: "UA",
  log: { child: () => ({}), info() {}, warn() {}, error() {} },
} as unknown as RequestContext;

async function callOrg(
  method: string,
  path: string,
  tok: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const req = makeReq(method, path, tok, body) as never;
  const res = makeRes();
  try {
    await dispatchOrgRoute(req, res as never, fakeCtx, noopDeps);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e.status === "number") {
      res.statusCode = e.status;
      res._body = JSON.stringify({ error: { code: e.code, message: e.message } });
    } else {
      throw err;
    }
  }
  let json: unknown;
  try {
    json = res._body ? JSON.parse(res._body) : undefined;
  } catch {
    json = res._body;
  }
  return { status: res.statusCode, json };
}

function isOrgError(code: string) {
  return (err: unknown): boolean => err instanceof OrgError && err.code === code;
}

// ====================================================================
// requireOrgRole
// ====================================================================

describe("requireOrgRole — 角色序 + fail-closed", () => {
  test("owner 满足 owner/admin/member;返回上下文", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("owner@x.com");
    const orgId = await makeOrg(uid);
    const req = makeReq("GET", "/api/org", await token(uid)) as never;
    for (const min of ["member", "admin", "owner"] as const) {
      const c = await requireOrgRole(req, JWT_SECRET, getPool(), min);
      assert.equal(c.userId, uid);
      assert.equal(c.orgId, orgId);
      assert.equal(c.orgRole, "owner");
      assert.equal(c.billingEnabled, true);
    }
  });

  test("admin 满足 admin/member,不满足 owner → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const admin = await createUser("a@x.com");
    await addMember(orgId, admin, "admin");
    const req = makeReq("GET", "/api/org", await token(admin)) as never;
    assert.equal((await requireOrgRole(req, JWT_SECRET, getPool(), "admin")).orgRole, "admin");
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "owner"), (e: any) => e.status === 403);
  });

  test("member 满足 member,不满足 admin/owner → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const m = await createUser("m@x.com");
    await addMember(orgId, m, "member");
    const req = makeReq("GET", "/api/org", await token(m)) as never;
    assert.equal((await requireOrgRole(req, JWT_SECRET, getPool(), "member")).orgRole, "member");
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "admin"), (e: any) => e.status === 403);
  });

  test("非成员 → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const loner = await createUser("loner@x.com");
    const req = makeReq("GET", "/api/org", await token(loner)) as never;
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "member"), (e: any) => e.status === 403);
  });

  test("suspended org → 403(即便成员 active)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    await query(`UPDATE orgs SET status='suspended' WHERE id=$1::bigint`, [orgId]);
    const req = makeReq("GET", "/api/org", await token(owner)) as never;
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "member"), (e: any) => e.status === 403);
  });

  test("suspended 成员 → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const m = await createUser("m@x.com");
    await addMember(orgId, m, "member", "suspended");
    const req = makeReq("GET", "/api/org", await token(m)) as never;
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "member"), (e: any) => e.status === 403);
  });

  test("坏 token → 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const req = makeReq("GET", "/api/org", "garbage.token.here") as never;
    await assert.rejects(() => requireOrgRole(req, JWT_SECRET, getPool(), "member"), (e: any) => e.status === 401);
  });
});

// ====================================================================
// 邀请全生命周期
// ====================================================================

describe("org 邀请生命周期", () => {
  test("创建 → pending 出现在列表", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const r = await createInvitation({ orgId, email: "New@X.com", orgRole: "member", invitedBy: owner });
    assert.ok(r.rawToken.length > 0);
    assert.equal(r.email, "new@x.com"); // 归一化 lower
    const list = await listInvitations(orgId);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "pending");
    assert.equal(list[0].org_role, "member");
  });

  test("接受成功 → 建 membership + 标记 accepted", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const invitee = await createUser("invitee@x.com");
    const inv = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "admin", invitedBy: owner });
    const res = await acceptInvitation(inv.rawToken, invitee);
    assert.equal(res.orgId, orgId);
    assert.equal(res.orgRole, "admin");
    const m = await getActiveMembership(invitee);
    assert.equal(m?.org_role, "admin");
    assert.equal((await listInvitations(orgId))[0].status, "accepted");
  });

  test("邮箱不匹配 → EMAIL_MISMATCH", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const other = await createUser("other@x.com");
    const inv = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "member", invitedBy: owner });
    await assert.rejects(() => acceptInvitation(inv.rawToken, other), isOrgError("EMAIL_MISMATCH"));
  });

  test("过期 → INVITATION_EXPIRED", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const invitee = await createUser("invitee@x.com");
    const inv = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "member", invitedBy: owner });
    await query(`UPDATE org_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id=$1::bigint`, [inv.id]);
    await assert.rejects(() => acceptInvitation(inv.rawToken, invitee), isOrgError("INVITATION_EXPIRED"));
  });

  test("席位满 → SEATS_FULL", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner, "Tiny", 1); // 上限 1,owner 已占满
    const invitee = await createUser("invitee@x.com");
    const inv = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "member", invitedBy: owner });
    await assert.rejects(() => acceptInvitation(inv.rawToken, invitee), isOrgError("SEATS_FULL"));
  });

  test("已属于其他 org → ALREADY_IN_ORG", async (t) => {
    if (skipIfNoPg(t)) return;
    const ownerA = await createUser("oa@x.com");
    const orgA = await makeOrg(ownerA, "A");
    const ownerB = await createUser("ob@x.com");
    const orgB = await makeOrg(ownerB, "B");
    const dual = await createUser("dual@x.com");
    await addMember(orgA, dual, "member"); // 已在 A
    const inv = await createInvitation({ orgId: orgB, email: "dual@x.com", orgRole: "member", invitedBy: ownerB });
    await assert.rejects(() => acceptInvitation(inv.rawToken, dual), isOrgError("ALREADY_IN_ORG"));
  });

  test("撤销后接受 → INVITATION_INVALID", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const invitee = await createUser("invitee@x.com");
    const inv = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "member", invitedBy: owner });
    await revokeInvitation(orgId, inv.id);
    await assert.rejects(() => acceptInvitation(inv.rawToken, invitee), isOrgError("INVITATION_INVALID"));
    assert.equal((await listInvitations(orgId))[0].status, "revoked");
  });

  test("重发邀请撤销旧 pending(只最新可接受)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const invitee = await createUser("invitee@x.com");
    const first = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "member", invitedBy: owner });
    const second = await createInvitation({ orgId, email: "invitee@x.com", orgRole: "admin", invitedBy: owner });
    // 旧 token 已失效
    await assert.rejects(() => acceptInvitation(first.rawToken, invitee), isOrgError("INVITATION_INVALID"));
    // 新 token 生效(角色 admin)
    const res = await acceptInvitation(second.rawToken, invitee);
    assert.equal(res.orgRole, "admin");
  });
});

// ====================================================================
// owner 唯一性与转让
// ====================================================================

describe("owner 唯一性与转让", () => {
  test("uq_org_owner 阻止第二个 owner(23505)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const other = await createUser("o2@x.com");
    await assert.rejects(
      () => addMember(orgId, other, "owner"),
      (e: any) => e.code === "23505",
    );
  });

  test("transferOwner:先降后升,新 owner 就位、旧 owner 变 admin", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const admin = await createUser("a@x.com");
    await addMember(orgId, admin, "admin");
    await transferOwner(orgId, owner, admin);
    assert.equal((await getMembership(orgId, admin))?.org_role, "owner");
    assert.equal((await getMembership(orgId, owner))?.org_role, "admin");
  });

  test("transferOwner 非 owner 发起 → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const admin = await createUser("a@x.com");
    await addMember(orgId, admin, "admin");
    await assert.rejects(() => transferOwner(orgId, admin, owner), (e: any) => e.status === 403);
  });

  test("transferOwner 目标非成员 → 404", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("o@x.com");
    const orgId = await makeOrg(owner);
    const stranger = await createUser("s@x.com");
    await assert.rejects(() => transferOwner(orgId, owner, stranger), (e: any) => e.status === 404);
  });
});

// ====================================================================
// 踢人 / 改角色权限矩阵(经 dispatchOrgRoute 端到端)
// ====================================================================

describe("成员管理权限矩阵(HTTP 端到端)", () => {
  async function setupOrg() {
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    const admin = await createUser("admin@x.com");
    await addMember(orgId, admin, "admin");
    const admin2 = await createUser("admin2@x.com");
    await addMember(orgId, admin2, "admin");
    const member = await createUser("member@x.com");
    await addMember(orgId, member, "member");
    return { owner, orgId, admin, admin2, member };
  }

  test("admin 踢 member → 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, member } = await setupOrg();
    const r = await callOrg("DELETE", `/api/org/members/${member}`, await token(admin));
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, true);
  });

  test("admin 踢 admin → 403(平级不可)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, admin2 } = await setupOrg();
    const r = await callOrg("DELETE", `/api/org/members/${admin2}`, await token(admin));
    assert.equal(r.status, 403);
  });

  test("admin 踢 owner → 403(OWNER_IMMUTABLE)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, owner } = await setupOrg();
    const r = await callOrg("DELETE", `/api/org/members/${owner}`, await token(admin));
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "OWNER_IMMUTABLE");
  });

  test("owner 踢 admin → 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const { owner, admin } = await setupOrg();
    const r = await callOrg("DELETE", `/api/org/members/${admin}`, await token(owner));
    assert.equal(r.status, 200);
  });

  test("member 调 DELETE members → 403(requireOrgRole admin gate)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { member, admin2 } = await setupOrg();
    const r = await callOrg("DELETE", `/api/org/members/${admin2}`, await token(member));
    assert.equal(r.status, 403);
  });

  test("admin 改成员角色 → 403(仅 owner 可改角色)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, member } = await setupOrg();
    const r = await callOrg("PATCH", `/api/org/members/${member}`, await token(admin), { org_role: "admin" });
    assert.equal(r.status, 403);
  });

  test("owner 改成员角色 → 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const { owner, member } = await setupOrg();
    const r = await callOrg("PATCH", `/api/org/members/${member}`, await token(owner), { org_role: "admin" });
    assert.equal(r.status, 200);
    assert.equal(r.json.member.org_role, "admin");
  });

  test("admin 改 member 的 billing_enabled → 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, member } = await setupOrg();
    const r = await callOrg("PATCH", `/api/org/members/${member}`, await token(admin), { billing_enabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.member.billing_enabled, false);
  });

  test("owner 直接 leave → 403(须先转让)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { owner } = await setupOrg();
    const r = await callOrg("POST", "/api/org/leave", await token(owner));
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "OWNER_MUST_TRANSFER");
  });

  test("GET /api/org 概要(member 可见)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { member, orgId } = await setupOrg();
    const r = await callOrg("GET", "/api/org", await token(member));
    assert.equal(r.status, 200);
    assert.equal(r.json.org.id, orgId);
    assert.equal(r.json.org.role, "member");
    assert.equal(r.json.org.member_count, 4);
  });

  test("接受邀请路由 minRole=null:非成员也能调(坏 token → 401)", async (t) => {
    if (skipIfNoPg(t)) return;
    // 无 org 归属的用户 POST accept 一个不存在 token → 走到业务层 → INVITATION_INVALID(404)
    const loner = await createUser("loner@x.com");
    const r = await callOrg("POST", "/api/org/invitations/accept", await token(loner), { token: "nope" });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "INVITATION_INVALID");
  });
});

// ====================================================================
// handleMe org 注入
// ====================================================================

describe("handleMe org 字段", () => {
  async function callMe(uid: string): Promise<any> {
    const req = makeReq("GET", "/api/me", await token(uid)) as never;
    const res = makeRes();
    await handleMe(req, res as never, fakeCtx, noopDeps);
    return JSON.parse(res._body);
  }

  test("有 active 归属 → org 字段就绪", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner, "Acme");
    const body = await callMe(owner);
    assert.equal(body.user.org.id, orgId);
    assert.equal(body.user.org.name, "Acme");
    assert.equal(body.user.org.role, "owner");
    assert.equal(body.user.org.status, "active");
    assert.equal(body.user.org.billing_enabled, true);
  });

  test("无归属 → org null", async (t) => {
    if (skipIfNoPg(t)) return;
    const loner = await createUser("loner@x.com");
    const body = await callMe(loner);
    assert.equal(body.user.org, null);
  });

  test("suspended org 仍返回(带 status)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    await query(`UPDATE orgs SET status='suspended' WHERE id=$1::bigint`, [orgId]);
    const body = await callMe(owner);
    assert.equal(body.user.org.id, orgId);
    assert.equal(body.user.org.status, "suspended");
  });
});

// ====================================================================
// admin 建 org / 列表 / patch
// ====================================================================

describe("admin org 运维数据层", () => {
  test("createOrgByEmail:建 org + owner membership + 审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com", { role: "admin" });
    const owner = await createUser("owner@x.com");
    const org = await createOrgByEmail({
      name: "Acme",
      ownerEmail: "Owner@X.com",
      adminId: admin,
      ip: "1.2.3.4",
      userAgent: "UA",
    });
    assert.equal(org.name, "Acme");
    const m = await getActiveMembership(owner);
    assert.equal(m?.org_role, "owner");
    assert.equal(m?.org_id, org.id);
    const audit = await query<{ action: string; target: string }>(
      `SELECT action, target FROM admin_audit ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0].action, "org.create");
    assert.equal(audit.rows[0].target, `org:${org.id}`);
  });

  test("重复 owner(已属某 org)→ OWNER_ALREADY_IN_ORG", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com", { role: "admin" });
    const owner = await createUser("owner@x.com");
    await createOrgByEmail({ name: "First", ownerEmail: "owner@x.com", adminId: admin });
    await assert.rejects(
      () => createOrgByEmail({ name: "Second", ownerEmail: "owner@x.com", adminId: admin }),
      isOrgError("OWNER_ALREADY_IN_ORG"),
    );
  });

  test("owner 邮箱不存在 → OWNER_NOT_FOUND", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com", { role: "admin" });
    await assert.rejects(
      () => createOrgByEmail({ name: "X", ownerEmail: "ghost@x.com", adminId: admin }),
      isOrgError("OWNER_NOT_FOUND"),
    );
  });

  test("listOrgs 带成员数聚合", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    const extra = await createUser("m@x.com");
    await addMember(orgId, extra, "member");
    const r = await listOrgs({});
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].member_count, 2);
  });

  test("patchOrg status=suspended → 反映 + 审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com", { role: "admin" });
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner);
    const after = await patchOrg(orgId, { status: "suspended" }, { adminId: admin });
    assert.equal(after.status, "suspended");
    const audit = await query<{ action: string }>(
      `SELECT action FROM admin_audit ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0].action, "org.patch");
  });

  test("patchOrg 降 max_members 低于当前成员数 → SEAT_BELOW_ACTIVE", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com", { role: "admin" });
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner, "Acme", 5);
    const m = await createUser("m@x.com");
    await addMember(orgId, m, "member"); // 2 active
    await assert.rejects(
      () => patchOrg(orgId, { maxMembers: 1 }, { adminId: admin }),
      isOrgError("SEAT_BELOW_ACTIVE"),
    );
  });
});

// ─── Codex 审计修复回归(2026-07-06:P0 邀请提权 / P1 预检 org 余额)────────

describe("Codex 审计修复回归", () => {
  test("admin 邀请 admin → 403(仅 owner 可造 admin,P0)", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("audit-owner@x.com");
    const orgId = await makeOrg(owner, "AuditOrg");
    const admin = await createUser("audit-admin@x.com");
    await addMember(orgId, admin, "admin");
    const r = await callOrg("POST", "/api/org/invitations", await token(admin), {
      email: "newadmin@x.com",
      org_role: "admin",
    });
    assert.equal(r.status, 403);
  });

  test("owner 邀请 admin → 201;admin 邀请 member 仍可 → 201", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner = await createUser("audit-owner2@x.com");
    const orgId = await makeOrg(owner, "AuditOrg2");
    const admin = await createUser("audit-admin2@x.com");
    await addMember(orgId, admin, "admin");
    const r1 = await callOrg("POST", "/api/org/invitations", await token(owner), {
      email: "newadmin2@x.com",
      org_role: "admin",
    });
    assert.equal(r1.status, 201);
    const r2 = await callOrg("POST", "/api/org/invitations", await token(admin), {
      email: "newmember2@x.com",
      org_role: "member",
    });
    assert.equal(r2.status, 201);
  });

  test("getOrgSpendableForUser:enabled 成员见 org 余额;billing_enabled=false/org suspended → 0", async (t) => {
    if (skipIfNoPg(t)) return;
    const { getOrgSpendableForUser } = await import("../org/orgBilling.js");
    const owner = await createUser("audit-owner3@x.com");
    const orgId = await makeOrg(owner, "AuditOrg3");
    await query(`UPDATE orgs SET credits = 12345 WHERE id = $1::bigint`, [orgId]);
    // owner 默认 billing_enabled=true → 见 org 余额
    assert.equal(await getOrgSpendableForUser(owner), 12345n);
    // 关 billing_enabled → 0(org 钱包不参与该成员付费,预检与扣费口径一致)
    await query(
      `UPDATE org_memberships SET billing_enabled = FALSE WHERE org_id = $1::bigint AND user_id = $2::bigint`,
      [orgId, owner],
    );
    assert.equal(await getOrgSpendableForUser(owner), 0n);
    await query(
      `UPDATE org_memberships SET billing_enabled = TRUE WHERE org_id = $1::bigint AND user_id = $2::bigint`,
      [orgId, owner],
    );
    // org suspended → 0
    await query(`UPDATE orgs SET status = 'suspended' WHERE id = $1::bigint`, [orgId]);
    assert.equal(await getOrgSpendableForUser(owner), 0n);
    // 非成员 → 0
    const stranger = await createUser("audit-stranger@x.com");
    assert.equal(await getOrgSpendableForUser(stranger), 0n);
  });
});
