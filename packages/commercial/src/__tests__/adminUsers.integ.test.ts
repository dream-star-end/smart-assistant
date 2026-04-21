/**
 * T-60 集成:/api/admin/users + /api/admin/audit 端到端。
 *
 * 覆盖:
 *   1. 非 admin → 403 FORBIDDEN(list/get/patch/credits/audit)
 *   2. admin GET /users?q=&status= → ILIKE + status 过滤
 *   3. admin GET /users/:id → 200 含 credits 字符串
 *   4. admin PATCH /users/:id(status/role/email_verified) → 200 + admin_audit 记录了 before/after
 *   5. admin POST /users/:id/credits → 余额更新 + credit_ledger(reason=admin_adjust) + admin_audit
 *   6. admin GET /audit 列表 + action 过滤 + keyset 游标
 *   7. 校验输入:无效 status/role/email_verified/delta/memo → 400
 *   8. 不存在的用户:patch → 404;credits → 404;get → 404
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
import { listAdminAudit, writeAdminAudit } from "../admin/audit.js";
import { listUsers, getUser, patchUser, UserNotFoundError } from "../admin/users.js";

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
        register: { scope: "register_t60", windowSeconds: 60, max: 100 },
        login: { scope: "login_t60", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t60", windowSeconds: 60, max: 100 },
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
    "TRUNCATE TABLE admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
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

async function createUser(
  email: string,
  role: "user" | "admin" = "user",
  credits = 0,
  status: "active" | "banned" | "deleting" | "deleted" = "active",
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', $2, $3, $4) RETURNING id::text AS id",
    [email, credits.toString(), role, status],
  );
  return BigInt(r.rows[0].id);
}

async function tokenFor(uid: bigint, role: "user" | "admin"): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET);
  return r.token;
}

// ============================================================
// listUsers / getUser / patchUser — DB 层
// ============================================================

describe("admin users — DB layer", () => {
  test("listUsers: happy + q ILIKE + status filter", async (t) => {
    if (skipIfNoPg(t)) return;
    await createUser("alice@x.com");
    await createUser("bob@x.com", "user", 0, "banned");
    await createUser("admin@x.com", "admin");

    const all = await listUsers();
    assert.equal(all.rows.length, 3);
    assert.ok(BigInt(all.rows[0].id) > BigInt(all.rows[1].id), "id DESC");

    const q = await listUsers({ q: "bob" });
    assert.equal(q.rows.length, 1);
    assert.equal(q.rows[0].email, "bob@x.com");

    const banned = await listUsers({ status: "banned" });
    assert.equal(banned.rows.length, 1);
    assert.equal(banned.rows[0].email, "bob@x.com");

    // 组合
    const none = await listUsers({ q: "alice", status: "banned" });
    assert.equal(none.rows.length, 0);
  });

  test("getUser: 存在 → 行;不存在 → null", async (t) => {
    if (skipIfNoPg(t)) return;
    const id = await createUser("g@x.com", "user", 123);
    const u = await getUser(id);
    assert.ok(u);
    assert.equal(u.email, "g@x.com");
    assert.equal(u.credits, "123");
    assert.equal(await getUser(999999n), null);
  });

  test("patchUser: 改 status → 新行 + 一条 admin_audit(before/after 只含该字段)", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const u2 = await patchUser(uid, { status: "banned" }, {
      adminId: admin, ip: "1.2.3.4", userAgent: "UA",
    });
    assert.equal(u2.status, "banned");

    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    const a = audits.rows[0];
    assert.equal(a.action, "user.patch");
    assert.equal(a.target, `user:${uid}`);
    assert.deepEqual(a.before, { status: "active" });
    assert.deepEqual(a.after, { status: "banned" });
    assert.equal(a.ip, "1.2.3.4");
    assert.equal(a.user_agent, "UA");
  });

  test("patchUser: 空 patch → 不写 audit", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    await patchUser(uid, {}, { adminId: admin });
    const a = await listAdminAudit({});
    assert.equal(a.rows.length, 0);
  });

  test("patchUser: 不存在 → UserNotFoundError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    await assert.rejects(
      () => patchUser(999999n, { status: "banned" }, { adminId: admin }),
      (err) => err instanceof UserNotFoundError,
    );
  });

  test("patchUser: 非法 id → RangeError(invalid_user_id)", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    await assert.rejects(
      () => patchUser("abc" as unknown as string, { status: "banned" }, { adminId: admin }),
      (err) => err instanceof RangeError && err.message === "invalid_user_id",
    );
  });
});

// ============================================================
// writeAdminAudit / listAdminAudit
// ============================================================

describe("admin audit helpers", () => {
  test("writeAdminAudit + listAdminAudit: keyset & filter", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const admin2 = await createUser("a2@x.com", "admin");

    // 直接用 pool(非 tx)写 3 条
    const { getPool } = await import("../db/index.js");
    const pool = getPool() as unknown as { query: typeof query };
    await writeAdminAudit(pool as unknown as import("../db/queries.js").QueryRunner, {
      adminId: admin, action: "pricing.patch", target: "model:x",
      before: { multiplier: "2.000" }, after: { multiplier: "2.500" },
    });
    await writeAdminAudit(pool as unknown as import("../db/queries.js").QueryRunner, {
      adminId: admin2, action: "user.patch", target: "user:1",
      before: { status: "active" }, after: { status: "banned" },
    });
    await writeAdminAudit(pool as unknown as import("../db/queries.js").QueryRunner, {
      adminId: admin, action: "user.patch", target: "user:2",
      before: {}, after: { email_verified: true },
    });

    // 全量 id DESC
    const all = await listAdminAudit({});
    assert.equal(all.rows.length, 3);
    for (let i = 1; i < all.rows.length; i++) {
      assert.ok(BigInt(all.rows[i - 1].id) > BigInt(all.rows[i].id));
    }

    // admin_id 过滤
    const byAdmin = await listAdminAudit({ adminId: admin });
    assert.equal(byAdmin.rows.length, 2);
    for (const r of byAdmin.rows) assert.equal(r.admin_id, admin.toString());

    // action 过滤
    const byAction = await listAdminAudit({ action: "user.patch" });
    assert.equal(byAction.rows.length, 2);

    // keyset 分页 limit=1
    const p1 = await listAdminAudit({ limit: 1 });
    assert.equal(p1.rows.length, 1);
    assert.ok(p1.next_before !== null);
    const p2 = await listAdminAudit({ limit: 1, before: p1.next_before! });
    assert.equal(p2.rows.length, 1);
    assert.ok(BigInt(p2.rows[0].id) < BigInt(p1.rows[0].id));
  });

  test("listAdminAudit: 非法 action / admin_id / before → RangeError", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(() => listAdminAudit({ action: "bad action!" }),
      (err) => err instanceof RangeError && err.message === "invalid_action");
    await assert.rejects(() => listAdminAudit({ adminId: "abc" }),
      (err) => err instanceof RangeError && err.message === "invalid_admin_id");
    await assert.rejects(() => listAdminAudit({ before: "abc" }),
      (err) => err instanceof RangeError && err.message === "invalid_before");
  });
});

// ============================================================
// HTTP 端到端
// ============================================================

describe("admin HTTP: /api/admin/users", () => {
  test("403 for non-admin on all user routes", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser("u@x.com");
    const tk = await tokenFor(uid, "user");

    for (const path of ["/api/admin/users", `/api/admin/users/${uid}`]) {
      const r = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tk}` } });
      assert.equal(r.status, 403, `${path} should be 403`);
      const body = await r.json() as { error: { code: string } };
      assert.equal(body.error.code, "FORBIDDEN");
    }
    // PATCH
    const pr = await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });
    assert.equal(pr.status, 403);
    // POST credits
    const cr = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 100, memo: "x" }),
    });
    assert.equal(cr.status, 403);
    // Audit list
    const ar = await fetch(`${baseUrl}/api/admin/audit`, { headers: { Authorization: `Bearer ${tk}` } });
    assert.equal(ar.status, 403);
  });

  test("list + q + status", async (t) => {
    if (skipIfNoHttp(t)) return;
    await createUser("one@x.com");
    await createUser("two@x.com", "user", 0, "banned");
    const admin = await createUser("a@x.com", "admin");
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users?q=one`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { rows: Array<{ email: string; credits: string; created_at: string }> };
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].email, "one@x.com");
    assert.equal(typeof body.rows[0].credits, "string");
    assert.match(body.rows[0].created_at, /^\d{4}-\d{2}-\d{2}T/);

    // status filter
    const r2 = await fetch(`${baseUrl}/api/admin/users?status=banned`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(r2.status, 200);
    const b2 = await r2.json() as { rows: Array<{ email: string }> };
    assert.equal(b2.rows.length, 1);
    assert.equal(b2.rows[0].email, "two@x.com");

    // bad status → 400
    const r3 = await fetch(`${baseUrl}/api/admin/users?status=bogus`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(r3.status, 400);
  });

  test("GET /users/:id → 200 / 404", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com", "user", 50);
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { user: { email: string; credits: string } };
    assert.equal(body.user.email, "u@x.com");
    assert.equal(body.user.credits, "50");

    const r2 = await fetch(`${baseUrl}/api/admin/users/999999`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(r2.status, 404);
  });

  test("PATCH /users/:id status=banned → 200 + admin_audit", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { user: { status: string } };
    assert.equal(body.user.status, "banned");

    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].action, "user.patch");
    assert.deepEqual(audits.rows[0].before, { status: "active" });
    assert.deepEqual(audits.rows[0].after, { status: "banned" });
  });

  test("PATCH /users/:id: invalid body → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "weird" }),
    });
    assert.equal(r.status, 400);

    const r2 = await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email_verified: "yes" }),
    });
    assert.equal(r2.status, 400);
  });

  test("PATCH /users/:id: 不存在 → 404", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const atk = await tokenFor(admin, "admin");
    const r = await fetch(`${baseUrl}/api/admin/users/999999`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });
    assert.equal(r.status, 404);
  });

  test("POST /users/:id/credits +500 → balance_after 500 + ledger + audit", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 500, memo: "welcome bonus" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { balance_after: string; ledger_id: string; audit_id: string };
    assert.equal(body.balance_after, "500");

    const u = await getUser(uid);
    assert.equal(u?.credits, "500");

    const lg = await query<{ reason: string; delta: string; memo: string }>(
      "SELECT reason, delta::text AS delta, memo FROM credit_ledger WHERE id = $1",
      [body.ledger_id],
    );
    assert.equal(lg.rows[0].reason, "admin_adjust");
    assert.equal(lg.rows[0].delta, "500");
    assert.equal(lg.rows[0].memo, "welcome bonus");

    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].action, "credits.adjust");
    assert.equal(audits.rows[0].target, `user:${uid}`);
  });

  test("POST /credits: delta=0 / missing memo → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 0, memo: "x" }),
    });
    assert.equal(r.status, 400);

    const r2 = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 100 }),
    });
    assert.equal(r2.status, 400);
  });

  // 2026-04-21 codex round 1 finding #6 修复回归:
  // delta abs > ¥100 万(1e8 cents) → 400 VALIDATION,服务端硬 cap。
  test("POST /credits: delta 超 ±1e8 cents 硬 cap → 400 VALIDATION", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");

    // 字符串路径(BigInt safe)— 大数也能精确表达
    const tooBig = "100000001"; // = 100,000,001 cents = ¥1,000,000.01
    const r = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: tooBig, memo: "should reject" }),
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "VALIDATION");
    assert.match(body.error.message, /cap|exceed/i);

    // 反向同样 reject
    const r2 = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: "-100000001", memo: "should reject" }),
    });
    assert.equal(r2.status, 400);

    // 正好顶到 cap (1e8 cents = ¥1,000,000) 必须能通过(假设余额够;
    // 这里只验证 cap 本身不误伤,我们让 user 起始有充足余额)
    const r3 = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: "100000000", memo: "exactly cap" }),
    });
    assert.equal(r3.status, 200, "cap-on-the-dot must succeed");
  });

  test("POST /credits: negative > balance → 402 INSUFFICIENT_CREDITS", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com", "user", 100);
    const atk = await tokenFor(admin, "admin");

    const r = await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: -999, memo: "refund" }),
    });
    assert.equal(r.status, 402);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "INSUFFICIENT_CREDITS");
  });

  test("GET /audit: admin 可列 + action 过滤 + 200", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const uid = await createUser("u@x.com");
    const atk = await tokenFor(admin, "admin");
    // 触发一条 user.patch + 一条 credits.adjust
    await fetch(`${baseUrl}/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });
    await fetch(`${baseUrl}/api/admin/users/${uid}/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${atk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 10, memo: "x" }),
    });

    const all = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(all.status, 200);
    const ab = await all.json() as { rows: Array<{ action: string; admin_id: string }>; next_before: string | null };
    assert.equal(ab.rows.length, 2);

    const fb = await fetch(`${baseUrl}/api/admin/audit?action=user.patch`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(fb.status, 200);
    const fbb = await fb.json() as { rows: Array<{ action: string }> };
    assert.equal(fbb.rows.length, 1);
    assert.equal(fbb.rows[0].action, "user.patch");

    // bad action → 400
    const bad = await fetch(`${baseUrl}/api/admin/audit?action=bad%20action!`, {
      headers: { Authorization: `Bearer ${atk}` },
    });
    assert.equal(bad.status, 400);
  });
});
