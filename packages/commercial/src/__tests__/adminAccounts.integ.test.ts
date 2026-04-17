/**
 * T-60(3/3) 集成:/api/admin/{accounts,agent-containers,ledger}。
 *
 * 覆盖:
 *   1. accounts: 非 admin → 403;POST 创建 → 加密入库 + admin_audit(无明文 token)
 *   2. accounts: PATCH(status/label/health_score/rotate token)→ 更新 + admin_audit
 *   3. accounts: DELETE → 行消失 + admin_audit;不存在 → 404
 *   4. accounts: GET list + GET by id
 *   5. agent-containers GET list;POST action 未挂载 agent runtime → 503
 *   6. ledger GET list + user_id/reason/before 过滤 + next_before 游标
 *
 * agent-containers 的 docker 实际操作留给 lifecycle 的集成测试覆盖;这里只测
 * route 派发 + 503/404/params 校验,避免本测试 depend on docker。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { listAdminAudit } from "../admin/audit.js";
import {
  adminCreateAccount,
  adminGetAccount,
  adminListAccounts,
  adminPatchAccount,
  adminDeleteAccount,
} from "../admin/accounts.js";
import { listLedger } from "../admin/ledger.js";
import { adminAdjust } from "../billing/ledger.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
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

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> { /* drop */ }
}

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1,
  });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch { /* */ } return null; }
}

// 测试用的 AEAD 密钥:32 字节固定值,避免依赖真实 KMS。
process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x9a).toString("base64");

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();

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
        register: { scope: "register_t603", windowSeconds: 60, max: 100 },
        login: { scope: "login_t603", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t603", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.statusCode = 404; res.end("nope"); }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    try { server.closeAllConnections(); } catch { /* */ }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE admin_audit, agent_audit, agent_containers, agent_subscriptions, usage_records, credit_ledger, claude_accounts, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
  if (redis) await redis.flushdb();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}
function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUser(email: string, role: "user" | "admin" = "user"): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  );
  return BigInt(r.rows[0].id);
}

async function tokenFor(uid: bigint, role: "user" | "admin"): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET);
  return r.token;
}

// ============================================================
// accounts — DB
// ============================================================

describe("admin accounts — DB 层", () => {
  test("create + get + list + patch + delete 流程", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");

    const created = await adminCreateAccount(
      { label: "pro-1", plan: "pro", oauth_token: "sk-ant-oat-PLAINTEXT" },
      { adminId: admin },
    );
    assert.equal(created.label, "pro-1");
    assert.equal(created.plan, "pro");
    assert.equal(created.status, "active");

    // 1 条审计:account.create,before=null,after 不含明文 token
    let audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].action, "account.create");
    const createdAuditAfter = audits.rows[0].after as Record<string, unknown>;
    assert.equal(createdAuditAfter.has_refresh_token, false);
    assert.ok(!("oauth_token" in createdAuditAfter), "明文 token 绝对不进 audit");

    const got = await adminGetAccount(created.id);
    assert.ok(got);
    assert.equal(got.label, "pro-1");

    const list = await adminListAccounts();
    assert.equal(list.length, 1);

    const patched = await adminPatchAccount(
      created.id,
      { status: "disabled", health_score: 50 },
      { adminId: admin },
    );
    assert.equal(patched.status, "disabled");
    assert.equal(patched.health_score, 50);

    audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 2);
    const patchAudit = audits.rows[0];
    assert.equal(patchAudit.action, "account.patch");
    assert.deepEqual(
      Object.keys(patchAudit.after as Record<string, unknown>).sort(),
      ["health_score", "status"],
    );

    const del = await adminDeleteAccount(created.id, { adminId: admin });
    assert.equal(del, true);
    audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 3);
    assert.equal(audits.rows[0].action, "account.delete");
  });

  test("patch:rotate token/refresh → audit 只记 _changed 布尔,不落明文", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const a = await adminCreateAccount(
      { label: "pro-1", plan: "pro", oauth_token: "tok1", oauth_refresh_token: "ref1" },
      { adminId: admin },
    );
    await adminPatchAccount(
      a.id,
      { oauth_token: "tok2", oauth_refresh_token: null },
      { adminId: admin },
    );
    const audits = await listAdminAudit({ action: "account.patch" });
    assert.equal(audits.rows.length, 1);
    const after = audits.rows[0].after as Record<string, unknown>;
    assert.equal(after.oauth_token_changed, true);
    assert.equal(after.oauth_refresh_token, "<cleared>");
    // 确认明文永远不在
    const js = JSON.stringify(audits.rows[0]);
    assert.ok(!js.includes("tok1"));
    assert.ok(!js.includes("tok2"));
    assert.ok(!js.includes("ref1"));
  });

  test("delete 不存在 → false", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    assert.equal(await adminDeleteAccount(999999n, { adminId: admin }), false);
    const a = await listAdminAudit({});
    assert.equal(a.rows.length, 0);
  });
});

// ============================================================
// accounts — HTTP
// ============================================================

describe("admin accounts — HTTP", () => {
  test("非 admin → 403;admin POST 创建 → 201;GET list 1 条", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await createUser("u@x.com");
    const admin = await createUser("a@x.com", "admin");
    const uTok = await tokenFor(u, "user");
    const aTok = await tokenFor(admin, "admin");

    const forbid = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${uTok}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "x", plan: "pro", oauth_token: "t" }),
    });
    assert.equal(forbid.status, 403);

    const created = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "pro-1", plan: "pro", oauth_token: "sk-SECRET-TOKEN" }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { account: { id: string; label: string } };
    assert.equal(body.account.label, "pro-1");

    // list
    const list = await fetch(`${baseUrl}/api/admin/accounts`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(list.status, 200);
    const ls = (await list.json()) as { rows: unknown[] };
    assert.equal(ls.rows.length, 1);

    // GET by id
    const byId = await fetch(`${baseUrl}/api/admin/accounts/${body.account.id}`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(byId.status, 200);
    // 响应里不含 oauth_token 明文(serializer 不返)
    const bodyStr = await byId.text();
    assert.ok(!bodyStr.includes("sk-SECRET-TOKEN"));
  });

  test("PATCH + DELETE + 404", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(admin, "admin");
    const a = await adminCreateAccount(
      { label: "pro-1", plan: "pro", oauth_token: "tok" },
      { adminId: admin },
    );

    const p = await fetch(`${baseUrl}/api/admin/accounts/${a.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });
    assert.equal(p.status, 200);

    const d = await fetch(`${baseUrl}/api/admin/accounts/${a.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(d.status, 200);

    // 再删 → 404
    const dAgain = await fetch(`${baseUrl}/api/admin/accounts/${a.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(dAgain.status, 404);
  });

  test("POST 缺字段 → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(admin, "admin");
    const r = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    assert.equal(r.status, 400);
  });
});

// ============================================================
// agent-containers — HTTP(docker 层未挂 → 503)
// ============================================================

describe("admin agent-containers — HTTP", () => {
  test("GET list(未挂 runtime 也可读)+ POST :id/action → 503", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(admin, "admin");

    // DB 里塞一行 subscription + container 来证明 list 可读
    const uid = await createUser("owner@x.com");
    const sub = await query<{ id: string }>(
      `INSERT INTO agent_subscriptions(user_id, plan, status, end_at)
       VALUES ($1, 'basic', 'active', NOW() + INTERVAL '30 days') RETURNING id::text AS id`,
      [uid.toString()],
    );
    const subId = sub.rows[0].id;
    const con = await query<{ id: string }>(
      `INSERT INTO agent_containers(user_id, subscription_id, docker_name, workspace_volume, home_volume, image, status)
       VALUES ($1, $2, 'agent-u-1', 'vol-ws', 'vol-home', 'test/image', 'running')
       RETURNING id::text AS id`,
      [uid.toString(), subId],
    );

    const list = await fetch(`${baseUrl}/api/admin/agent-containers`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { rows: Array<{ user_email: string; docker_name: string }> };
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].user_email, "owner@x.com");
    assert.equal(body.rows[0].docker_name, "agent-u-1");

    // POST :id/restart → 503(未挂 runtime)
    const r = await fetch(`${baseUrl}/api/admin/agent-containers/${con.rows[0].id}/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r.status, 503);

    // 非法 action → 404
    const bad = await fetch(`${baseUrl}/api/admin/agent-containers/${con.rows[0].id}/explode`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(bad.status, 404);
  });
});

// ============================================================
// ledger — DB + HTTP
// ============================================================

describe("admin ledger — list + 过滤", () => {
  test("adminAdjust + listLedger + reason/user_id/before 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const u1 = await createUser("u1@x.com");
    const u2 = await createUser("u2@x.com");
    await adminAdjust(u1.toString(), 100n, "boost u1", admin, {});
    await adminAdjust(u2.toString(), 50n, "boost u2", admin, {});
    await adminAdjust(u1.toString(), -20n, "take u1", admin, {});

    const all = await listLedger({});
    assert.equal(all.rows.length, 3);
    // id DESC
    assert.ok(BigInt(all.rows[0].id) > BigInt(all.rows[1].id));
    // 均为 admin_adjust
    for (const r of all.rows) assert.equal(r.reason, "admin_adjust");

    // user_id 过滤
    const onlyU1 = await listLedger({ userId: u1.toString() });
    assert.equal(onlyU1.rows.length, 2);
    for (const r of onlyU1.rows) assert.equal(r.user_id, u1.toString());

    // reason 过滤
    const onlyAdj = await listLedger({ reason: "admin_adjust", limit: 2 });
    assert.equal(onlyAdj.rows.length, 2);
    assert.ok(onlyAdj.next_before !== null);

    // before 游标
    const pageTwo = await listLedger({ reason: "admin_adjust", before: onlyAdj.next_before!, limit: 2 });
    assert.equal(pageTwo.rows.length, 1);
  });

  test("listLedger invalid reason/user_id/before → RangeError", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(() => listLedger({ reason: "bad" as never }), (e) => e instanceof RangeError);
    await assert.rejects(() => listLedger({ userId: "0" }), (e) => e instanceof RangeError);
    await assert.rejects(() => listLedger({ before: "-1" }), (e) => e instanceof RangeError);
  });

  test("HTTP GET /api/admin/ledger 过滤 + next_before", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const u = await createUser("u@x.com");
    await adminAdjust(u.toString(), 100n, "m", admin, {});
    await adminAdjust(u.toString(), 50n, "m", admin, {});
    const aTok = await tokenFor(admin, "admin");
    const r = await fetch(`${baseUrl}/api/admin/ledger?user_id=${u}&limit=1`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { rows: unknown[]; next_before: string | null };
    assert.equal(body.rows.length, 1);
    assert.ok(body.next_before);

    const r2 = await fetch(
      `${baseUrl}/api/admin/ledger?user_id=${u}&limit=1&before=${body.next_before}`,
      { headers: { Authorization: `Bearer ${aTok}` } },
    );
    assert.equal(r2.status, 200);
    const body2 = (await r2.json()) as { rows: Array<{ id: string }>; next_before: string | null };
    assert.equal(body2.rows.length, 1);
    // next_before 的语义是 "rows.length === limit 就给,调用方自己再请求一次才能确定真的是空"
    // 这里 limit=1 且最后一页正好 1 条,所以 API 会返 id(不是 null)。第 3 次请求才会空。
    const r3 = await fetch(
      `${baseUrl}/api/admin/ledger?user_id=${u}&limit=1&before=${body2.next_before!}`,
      { headers: { Authorization: `Bearer ${aTok}` } },
    );
    const body3 = (await r3.json()) as { rows: unknown[]; next_before: string | null };
    assert.equal(body3.rows.length, 0);
    assert.equal(body3.next_before, null);
  });

  test("HTTP GET /api/admin/ledger 非法 reason → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(admin, "admin");
    const r = await fetch(`${baseUrl}/api/admin/ledger?reason=nope`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r.status, 400);
  });
});
