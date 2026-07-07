/**
 * v5 审计整改 —— 真 PG(+ Redis/HTTP,§1)集成测试。
 *
 * 覆盖:
 *   §1  router 通配转发 — PUT /api/org/invoice-profile 能到达 dispatchOrgRoute(此前
 *       router 未注册 PUT → 405 死路由);且 405 的 Allow 由 ORG_ROUTES 决定(method 权威下放)。
 *   §3a acceptInvitation JOIN orgs — org 软删/停用后成员不再被 uq_user_active_org 永久锁死,
 *       能接受新 org 邀请;stale active membership 指向非 active org 时被挂起后再 INSERT。
 *   §4  patchUser 封号即时生效 — status 改为非 active 时同事务撤销全部未撤销 refresh token。
 *
 * 隔离:专属库(orgEnterprise 同款),before CREATE / after DROP,不碰共享 openclaude_test。
 * PG/Redis 不可用则各自 skip(与既有 integ 套件一致)。
 */

import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { Client } from "pg";
import IORedis from "ioredis";
import type { MailMessage, Mailer } from "../auth/mail.js";
import { signAccess } from "../auth/jwt.js";
import { closePool, createPool, resetPool, setPoolOverride } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { createOrg } from "../org/orgs.js";
import { getActiveMembership, getMembership } from "../org/memberships.js";
import { createInvitation, acceptInvitation } from "../org/invitations.js";
import { patchOrg } from "../admin/orgs.js";
import { patchUser } from "../admin/users.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/0";
const MY_DB = "openclaude_audit_remed_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const MY_URL = withDb(BASE_URL, MY_DB);

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> {}
}

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function probeRedis(): Promise<IORedis | null> {
  try {
    const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await r.connect();
    await r.ping();
    return r;
  } catch {
    return null;
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
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`);
  await adminExec(`CREATE DATABASE ${MY_DB} TEMPLATE template0`);

  await resetPool();
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10 }));
  await runMigrations();

  // §1 需要完整 router(含 redis 限流中间件)+ HTTP server;redis 缺失则 §1 skip。
  redis = await probeRedis();
  if (redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      rateLimits: {
        register: { scope: "reg_ar", windowSeconds: 60, max: 1000 },
        login: { scope: "login_ar", windowSeconds: 60, max: 1000 },
        requestReset: { scope: "rr_ar", windowSeconds: 60, max: 1000 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  }
});

after(async () => {
  if (server) {
    try {
      server.closeAllConnections();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  if (redis) {
    try {
      await redis.flushdb();
    } catch {
      /* ignore */
    }
    await redis.quit();
  }
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
    `TRUNCATE TABLE orgs, org_memberships, org_invitations, org_invoice_profiles,
       refresh_tokens, users, admin_audit RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}
function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip("pg/redis/server not available");
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
    `INSERT INTO users(email, password_hash, role, status, email_verified)
     VALUES ($1, 'argon2$stub', $2, $3, TRUE) RETURNING id::text AS id`,
    [email, opts.role ?? "user", opts.status ?? "active"],
  );
  return r.rows[0].id;
}

async function makeOrg(ownerId: string, name = "Acme"): Promise<string> {
  return tx(async (client) => {
    const o = await createOrg({ name, ownerUserId: ownerId, createdBy: null, maxMembers: 100 }, client);
    return o.id;
  });
}

async function token(uid: string): Promise<string> {
  const r = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
  return r.token;
}

async function insertRefreshToken(userId: string, hash: string): Promise<void> {
  await query(
    `INSERT INTO refresh_tokens(user_id, token_hash, expires_at)
     VALUES ($1::bigint, $2, NOW() + INTERVAL '30 days')`,
    [userId, hash],
  );
}

// ─── §1 router 通配:PUT /api/org/invoice-profile 到达 dispatcher ─────

describe("§1 router forwards ALL methods for /api/org to dispatcher", () => {
  test("PUT /api/org/invoice-profile(owner)→ 200 存抬头(此前 405 死路由)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const owner = await createUser("owner1@x.com");
    await makeOrg(owner);
    const tok = await token(owner);
    const res = await fetch(`${baseUrl}/api/org/invoice-profile`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "示例科技有限公司", tax_id: "91330000MA00" }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as { profile: { title: string } };
    assert.equal(body.profile.title, "示例科技有限公司");
  });

  test("非-owner(member)PUT → 403(经 dispatcher 的 owner gate,非 router 405)", async (t) => {
    if (skipIfNoHttp(t)) return;
    // 建一个 owner 的 org,再造一个不属于该 org 的用户 —— requireOrgRole 对无 membership → 403/404
    const other = await createUser("nomember@x.com");
    const tok = await token(other);
    const res = await fetch(`${baseUrl}/api/org/invoice-profile`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    // 关键:不是 405(router 层不再拦 PUT);由 org 鉴权层给出 4xx(非 200/非 405)
    assert.notEqual(res.status, 405, "PUT 不应再被 router 判 405");
    assert.notEqual(res.status, 200, "无 membership 不应成功");
  });

  test("未声明 method(PATCH invoice-profile)→ 405,Allow 来自 ORG_ROUTES(含 GET+PUT)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const owner = await createUser("owner2@x.com");
    await makeOrg(owner);
    const tok = await token(owner);
    const res = await fetch(`${baseUrl}/api/org/invoice-profile`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${tok}` },
    });
    assert.equal(res.status, 405);
    const allow = res.headers.get("allow") ?? "";
    assert.ok(/GET/.test(allow) && /PUT/.test(allow), `Allow 应含 GET+PUT,实为: ${allow}`);
  });
});

// ─── §3a org 软删/停用后成员可接受新 org 邀请 ───────────────────────

describe("§3a acceptInvitation not blocked by membership in non-active org", () => {
  test("org 软删(cascade 挂起成员)后,原成员能接受新 org 邀请", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin@x.com", { role: "admin" });
    const a = await createUser("a@x.com");
    const org1 = await makeOrg(a, "Org1"); // a = owner
    // 软删 org1 → updateOrg 级联把 a 的 membership 挂起(§3b)
    await patchOrg(org1, { status: "deleted" }, { adminId });
    const m1 = await getMembership(org1, a);
    assert.equal(m1?.status, "suspended", "org 删除后 owner membership 应被挂起");
    assert.equal(await getActiveMembership(a), null, "a 不应再有 active membership");

    // 新 org2 邀请 a
    const b = await createUser("b@x.com");
    const org2 = await makeOrg(b, "Org2");
    const inv = await createInvitation({ orgId: org2, email: "a@x.com", orgRole: "member", invitedBy: b });
    const res = await acceptInvitation(inv.rawToken, a); // 此前会 ALREADY_IN_ORG / 23505
    assert.equal(res.orgId, org2);
    const act = await getActiveMembership(a);
    assert.equal(act?.org_id, org2, "a 现应是 org2 的 active 成员");
  });

  test("stale active membership 指向 suspended org(未级联)→ accept 挂起旧行后成功", async (t) => {
    if (skipIfNoPg(t)) return;
    const owner3 = await createUser("owner3@x.com");
    const c = await createUser("c@x.com");
    const org3 = await makeOrg(owner3, "Org3");
    // c 作为 member 加入 org3
    await query(
      `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
       VALUES ($1::bigint, $2::bigint, 'member', 'active', TRUE)`,
      [org3, c],
    );
    // 直接把 org3 置 suspended(不走 updateOrg 级联)→ c 仍是 active membership(stale)
    await query(`UPDATE orgs SET status = 'suspended' WHERE id = $1::bigint`, [org3]);
    assert.equal((await getActiveMembership(c))?.org_id, org3, "前置:c 仍 active 于 suspended org3");

    // 邀请 c 进 org4
    const owner4 = await createUser("owner4@x.com");
    const org4 = await makeOrg(owner4, "Org4");
    const inv = await createInvitation({ orgId: org4, email: "c@x.com", orgRole: "member", invitedBy: owner4 });
    const res = await acceptInvitation(inv.rawToken, c);
    assert.equal(res.orgId, org4);
    assert.equal((await getActiveMembership(c))?.org_id, org4, "c 现应 active 于 org4");
    assert.equal((await getMembership(org3, c))?.status, "suspended", "org3 里的 stale 行应被挂起");
  });
});

// ─── §4 封号即时撤销 refresh token ──────────────────────────────────

describe("§4 patchUser ban revokes refresh tokens", () => {
  test("status→banned:同事务撤销该用户全部未撤销 refresh token(reason=admin)", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin4@x.com", { role: "admin" });
    const u = await createUser("victim@x.com");
    await insertRefreshToken(u, "hash-1");
    await insertRefreshToken(u, "hash-2");

    await patchUser(u, { status: "banned" }, { adminId });

    const r = await query<{ n: string; active: string }>(
      `SELECT COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE revoked_at IS NULL)::text AS active
         FROM refresh_tokens WHERE user_id = $1::bigint`,
      [u],
    );
    assert.equal(r.rows[0].n, "2");
    assert.equal(r.rows[0].active, "0", "封号后不应再有未撤销 token");
    const reason = await query<{ revoked_reason: string }>(
      `SELECT DISTINCT revoked_reason FROM refresh_tokens WHERE user_id = $1::bigint`,
      [u],
    );
    assert.deepEqual(
      reason.rows.map((x) => x.revoked_reason),
      ["admin"],
    );
  });

  test("非 status 变更(仅 email_verified)不撤销 token", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin4b@x.com", { role: "admin" });
    const u = await createUser("keep@x.com");
    await insertRefreshToken(u, "hash-keep");

    await patchUser(u, { email_verified: false }, { adminId });

    const r = await query<{ active: string }>(
      `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::text AS active
         FROM refresh_tokens WHERE user_id = $1::bigint`,
      [u],
    );
    assert.equal(r.rows[0].active, "1", "未改 status 的 patch 不应撤销 token");
  });
});
