/**
 * V3 站内信(in-app inbox)集成测试 — 真 PG。
 *
 * 跑法: REQUIRE_TEST_DB=1 npx tsx --test --test-concurrency=1 src/__tests__/inbox.integ.test.ts
 *
 * 覆盖:
 *  DB-level:
 *   - createInboxMessage(audience='all') / (audience='user') 双形态写入
 *   - listMyInbox 默认排序 + read 标志 + unread_count
 *   - countMyUnread 与 listMyInbox.unread_count 一致
 *   - markRead 幂等(二次返 already=true)
 *   - markRead 不可见消息 → InboxError(NOT_FOUND)
 *   - readAll 一次清光所有可见未读
 *   - 可见性:audience='all' 不补已注册前的广播
 *   - expires_at 过期消息不可见
 *   - 单发消息只有目标 user 可见
 *   - createInboxMessage USER_NOT_FOUND
 *   - createInboxMessage VALIDATION(audience='user' 缺 user_id)
 *   - adminListInbox read_count / recipients
 *   - adminDeleteInbox CASCADE 清 reads
 *
 *  HTTP:
 *   - GET  /api/me/messages 不带 Bearer → 401
 *   - GET  /api/me/messages?unread_only=1 仅返未读
 *   - POST /api/me/messages/:id/read → 200
 *   - POST /api/me/messages/read_all → 200 unread 归零
 *   - POST /api/admin/messages 非 admin → 403
 *   - POST /api/admin/messages 校验失败 → 400 VALIDATION
 *   - POST /api/admin/messages OK → 201,admin_audit 写 inbox.create
 *   - GET  /api/admin/messages → 200,total 累计
 *   - DELETE /api/admin/messages/:id → 200,admin_audit 写 inbox.delete
 *   - DELETE 不存在的 id → 404 NOT_FOUND
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { signAccess } from "../auth/jwt.js";
import {
  listMyInbox,
  countMyUnread,
  markRead,
  readAll,
  createInboxMessage,
  adminListInbox,
  adminDeleteInbox,
  InboxError,
} from "../inbox/inbox.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "i".repeat(64);

// 完整表列表(0001..0046)。`DROP TABLE IF EXISTS ... CASCADE` 对未列出的表
// 不会自动级联删表本身,只会断 FK,所以必须显式枚举所有表名。
const COMMERCIAL_TABLES = [
  "inbox_message_reads",
  "inbox_messages",
  "oauth_identities",
  "compute_host_audit",
  "compute_pool_state",
  "account_refresh_events",
  "feedback",
  "compute_hosts",
  "user_remote_hosts",
  "admin_alert_silences",
  "admin_alert_outbox",
  "admin_alert_rule_state",
  "admin_alert_channels",
  "system_settings",
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
        register: { scope: "register_inbox", windowSeconds: 60, max: 100 },
        login: { scope: "login_inbox", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_inbox", windowSeconds: 60, max: 100 },
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

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function makeUser(
  email: string,
  opts: { role?: "user" | "admin"; status?: string } = {},
): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified)
     VALUES ($1, 'x', $2, $3, TRUE)
     RETURNING id::text AS id`,
    [email, opts.role ?? "user", opts.status ?? "active"],
  );
  return BigInt(r.rows[0].id);
}

async function clearTables() {
  // TRUNCATE … CASCADE 会按 FK 链自动清依赖表(admin_audit / inbox_messages 等)。
  // 比按顺序 DELETE 更稳 —— FK 违规和写入并发都不会残留行。
  await query(
    "TRUNCATE TABLE admin_audit, inbox_message_reads, inbox_messages, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
}

// ─── DB 单元-as-integ ─────────────────────────────────────────────────────

describe("inbox DB ops (integ)", () => {
  let admin: bigint;
  let alice: bigint;
  let bob: bigint;

  beforeEach(async () => {
    if (!pgAvailable) return;
    await clearTables();
    admin = await makeUser(`admin-${Date.now()}@inbox.test`, { role: "admin" });
    alice = await makeUser(`alice-${Date.now()}-${Math.random()}@inbox.test`);
    bob = await makeUser(`bob-${Date.now()}-${Math.random()}@inbox.test`);
  });

  test("createInboxMessage audience='all' → list 双方都能看到", async (t) => {
    if (skipIfNoPg(t)) return;
    const m = await createInboxMessage(admin, {
      audience: "all",
      title: "全员公告",
      body_md: "**hello** _everyone_",
      level: "notice",
    });
    assert.equal(m.audience, "all");
    assert.equal(m.user_id, null);
    assert.equal(m.level, "notice");

    const a = await listMyInbox({ userId: alice });
    const b = await listMyInbox({ userId: bob });
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 1);
    assert.equal(a.unread_count, 1);
    assert.equal(b.unread_count, 1);
    assert.equal(a.messages[0]!.read, false);
  });

  test("createInboxMessage audience='user' 仅目标可见", async (t) => {
    if (skipIfNoPg(t)) return;
    const m = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "single",
      body_md: "for alice only",
    });
    assert.equal(m.audience, "user");
    assert.equal(m.user_id, alice.toString());

    const a = await listMyInbox({ userId: alice });
    const b = await listMyInbox({ userId: bob });
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 0);
    assert.equal(a.unread_count, 1);
    assert.equal(b.unread_count, 0);
  });

  test("audience='all' 不补已注册前的广播", async (t) => {
    if (skipIfNoPg(t)) return;
    // 先发广播
    await createInboxMessage(admin, {
      audience: "all",
      title: "before",
      body_md: "old",
    });
    // 然后才注册新用户
    await new Promise((r) => setTimeout(r, 50));
    const carol = await makeUser(`carol-${Date.now()}@inbox.test`);
    const c = await listMyInbox({ userId: carol });
    assert.equal(c.messages.length, 0, "新注册用户不应看到注册前的广播");
    // alice 是 beforeEach 时建的,早于广播,可见
    const a = await listMyInbox({ userId: alice });
    assert.equal(a.messages.length, 1);
  });

  test("expires_at 已过期 → 不可见", async (t) => {
    if (skipIfNoPg(t)) return;
    await createInboxMessage(admin, {
      audience: "all",
      title: "expired",
      body_md: "stale",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const a = await listMyInbox({ userId: alice });
    assert.equal(a.messages.length, 0);
    assert.equal(await countMyUnread(alice), 0);
  });

  test("markRead 幂等 + unread_count 减少", async (t) => {
    if (skipIfNoPg(t)) return;
    const m = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "ping",
      body_md: "x",
    });
    const r1 = await markRead(alice, m.id);
    assert.equal(r1.already, false);
    const r2 = await markRead(alice, m.id);
    assert.equal(r2.already, true);

    assert.equal(await countMyUnread(alice), 0);
    const list = await listMyInbox({ userId: alice });
    assert.equal(list.messages[0]!.read, true);
    assert.equal(list.unread_count, 0);
  });

  test("markRead 不可见消息 → InboxError(NOT_FOUND)", async (t) => {
    if (skipIfNoPg(t)) return;
    const m = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "x",
      body_md: "x",
    });
    // bob 看不到
    await assert.rejects(
      () => markRead(bob, m.id),
      (err: unknown) => err instanceof InboxError && err.code === "NOT_FOUND",
    );
  });

  test("markRead 非法 id → NOT_FOUND", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => markRead(alice, "abc"),
      (err: unknown) => err instanceof InboxError && err.code === "NOT_FOUND",
    );
  });

  test("readAll 一次清光所有可见未读", async (t) => {
    if (skipIfNoPg(t)) return;
    await createInboxMessage(admin, { audience: "all", title: "a", body_md: "1" });
    await createInboxMessage(admin, {
      audience: "user", user_id: alice.toString(), title: "b", body_md: "2",
    });
    await createInboxMessage(admin, {
      audience: "user", user_id: bob.toString(), title: "c", body_md: "3",
    });
    assert.equal(await countMyUnread(alice), 2);
    const r = await readAll(alice);
    assert.equal(r.inserted, 2);
    assert.equal(await countMyUnread(alice), 0);
    // bob 未受影响
    assert.equal(await countMyUnread(bob), 2);
  });

  test("createInboxMessage USER_NOT_FOUND", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => createInboxMessage(admin, {
        audience: "user", user_id: "9999999999999", title: "x", body_md: "x",
      }),
      (err: unknown) => err instanceof InboxError && err.code === "USER_NOT_FOUND",
    );
  });

  test("createInboxMessage VALIDATION(audience='user' 缺 user_id)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => createInboxMessage(admin, { audience: "user", title: "x", body_md: "x" }),
      (err: unknown) => err instanceof InboxError && err.code === "VALIDATION",
    );
  });

  test("createInboxMessage VALIDATION(audience='all' 带 user_id)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => createInboxMessage(admin, {
        audience: "all", user_id: alice.toString(), title: "x", body_md: "x",
      }),
      (err: unknown) => err instanceof InboxError && err.code === "VALIDATION",
    );
  });

  test("adminListInbox read_count / recipients", async (t) => {
    if (skipIfNoPg(t)) return;
    const m1 = await createInboxMessage(admin, { audience: "all", title: "a1", body_md: "x" });
    const m2 = await createInboxMessage(admin, {
      audience: "user", user_id: alice.toString(), title: "a2", body_md: "x",
    });
    await markRead(alice, m1.id);
    await markRead(bob, m1.id);
    await markRead(alice, m2.id);

    const r = await adminListInbox({ limit: 10 });
    assert.equal(r.total, 2);
    const byId = new Map(r.messages.map((x) => [x.id, x]));
    assert.equal(byId.get(m1.id)!.read_count, 2);
    assert.equal(byId.get(m2.id)!.read_count, 1);
    assert.equal(byId.get(m2.id)!.recipients, 1);
    // recipients='all' 至少应该有 admin/alice/bob 3 个 active
    assert.ok(byId.get(m1.id)!.recipients >= 3);
  });

  test("JWT 用户在 DB 中不存在 → 看不到任何广播(失败闭合)", async (t) => {
    if (skipIfNoPg(t)) return;
    // 先发广播
    await createInboxMessage(admin, { audience: "all", title: "for everyone", body_md: "x" });
    // alice 应该可见
    assert.equal(await countMyUnread(alice), 1);
    // 用一个不存在的 user_id 查询(模拟"账号被硬删但 JWT 仍有效"场景)
    const ghostUid = BigInt("9999999999999");
    const list = await listMyInbox({ userId: ghostUid });
    assert.equal(list.messages.length, 0, "幽灵用户不应看到广播");
    assert.equal(list.unread_count, 0);
    assert.equal(await countMyUnread(ghostUid), 0);
    // markRead 也应 NOT_FOUND
    const r = await query<{ id: string }>(
      `SELECT id::text AS id FROM inbox_messages ORDER BY id DESC LIMIT 1`,
    );
    await assert.rejects(
      () => markRead(ghostUid, r.rows[0]!.id),
      (err: unknown) => err instanceof InboxError && err.code === "NOT_FOUND",
    );
  });

  test("adminDeleteInbox CASCADE 清 reads", async (t) => {
    if (skipIfNoPg(t)) return;
    const m = await createInboxMessage(admin, { audience: "all", title: "rm", body_md: "x" });
    await markRead(alice, m.id);
    assert.equal((await query("SELECT 1 FROM inbox_message_reads WHERE message_id=$1", [m.id])).rows.length, 1);
    const removed = await adminDeleteInbox(m.id);
    assert.equal(removed.id, m.id);
    assert.equal((await query("SELECT 1 FROM inbox_message_reads WHERE message_id=$1", [m.id])).rows.length, 0);
    // 第二次删 → NOT_FOUND
    await assert.rejects(
      () => adminDeleteInbox(m.id),
      (err: unknown) => err instanceof InboxError && err.code === "NOT_FOUND",
    );
  });
});

// ─── HTTP 端到端 ──────────────────────────────────────────────────────────

describe("inbox HTTP (integ)", () => {
  let admin: bigint;
  let alice: bigint;
  let adminToken: string;
  let aliceToken: string;

  beforeEach(async () => {
    if (!pgAvailable || !redis || !server) return;
    await clearTables();
    admin = await makeUser(`admin-h-${Date.now()}@inbox.test`, { role: "admin" });
    alice = await makeUser(`alice-h-${Date.now()}-${Math.random()}@inbox.test`);
    adminToken = (await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET)).token;
    aliceToken = (await signAccess({ sub: alice.toString(), role: "user" }, JWT_SECRET)).token;
  });

  test("GET /api/me/messages 无 Bearer → 401", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/me/messages`);
    assert.equal(r.status, 401);
  });

  test("POST /api/admin/messages 非 admin → 403", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: "all", title: "t", body_md: "b" }),
    });
    assert.equal(r.status, 403);
  });

  test("POST /api/admin/messages 校验失败 → 400 VALIDATION", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: "user", title: "t", body_md: "b" }), // 缺 user_id
    });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: { code: string; issues?: unknown[] } };
    assert.equal(j.error.code, "VALIDATION");
    assert.ok(Array.isArray(j.error.issues));
  });

  test("POST /api/admin/messages OK → 201 + admin_audit inbox.create", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        audience: "user",
        user_id: alice.toString(),
        title: "hi alice",
        body_md: "**markdown** body",
        level: "promo",
      }),
    });
    assert.equal(r.status, 201);
    const j = (await r.json()) as { message: { id: string; audience: string } };
    assert.equal(j.message.audience, "user");
    const aud = await query<{ action: string; target: string }>(
      `SELECT action, target FROM admin_audit WHERE action='inbox.create' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(aud.rows.length, 1);
    assert.equal(aud.rows[0]!.target, `message:${j.message.id}`);
  });

  test("end-to-end: admin POST → alice GET → POST :id/read → unread 归 0", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    // admin 发
    const post = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: "all", title: "T", body_md: "B" }),
    });
    const created = (await post.json()) as { message: { id: string } };

    // alice 列表 + unread
    const list = await fetch(`${baseUrl}/api/me/messages`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(list.status, 200);
    const lj = (await list.json()) as { messages: Array<{ id: string; read: boolean }>; unread_count: number };
    assert.equal(lj.messages.length, 1);
    assert.equal(lj.messages[0]!.read, false);
    assert.equal(lj.unread_count, 1);

    // unread_count 单独端点
    const c = await fetch(`${baseUrl}/api/me/messages/unread_count`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const cj = (await c.json()) as { unread_count: number };
    assert.equal(cj.unread_count, 1);

    // 标已读
    const mr = await fetch(`${baseUrl}/api/me/messages/${created.message.id}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(mr.status, 200);

    // 再查 unread = 0
    const c2 = await fetch(`${baseUrl}/api/me/messages/unread_count`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(((await c2.json()) as { unread_count: number }).unread_count, 0);
  });

  test("POST /api/me/messages/:id/read 不可见 → 404", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const bob = await makeUser(`bob-h-${Date.now()}@inbox.test`);
    const post = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ audience: "user", user_id: bob.toString(), title: "T", body_md: "B" }),
    });
    const created = (await post.json()) as { message: { id: string } };
    const r = await fetch(`${baseUrl}/api/me/messages/${created.message.id}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(r.status, 404);
  });

  test("POST /api/me/messages/read_all → unread 归 0", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    await createInboxMessage(admin, { audience: "all", title: "1", body_md: "x" });
    await createInboxMessage(admin, { audience: "user", user_id: alice.toString(), title: "2", body_md: "x" });
    const r = await fetch(`${baseUrl}/api/me/messages/read_all`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean; inserted: number };
    assert.equal(j.ok, true);
    assert.equal(j.inserted, 2);
    const c = await fetch(`${baseUrl}/api/me/messages/unread_count`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(((await c.json()) as { unread_count: number }).unread_count, 0);
  });

  test("GET /api/admin/messages → total + read_count", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    await createInboxMessage(admin, { audience: "all", title: "x", body_md: "x" });
    await createInboxMessage(admin, { audience: "user", user_id: alice.toString(), title: "y", body_md: "y" });
    const r = await fetch(`${baseUrl}/api/admin/messages?limit=10`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { messages: Array<{ id: string; read_count: number; recipients: number }>; total: number };
    assert.equal(j.total, 2);
    assert.equal(j.messages.length, 2);
    for (const m of j.messages) {
      assert.ok(typeof m.read_count === "number");
      assert.ok(typeof m.recipients === "number");
    }
  });

  test("DELETE /api/admin/messages/:id → 200 + admin_audit", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const m = await createInboxMessage(admin, { audience: "all", title: "rm", body_md: "x" });
    const r = await fetch(`${baseUrl}/api/admin/messages/${m.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 200);
    const aud = await query<{ action: string }>(
      `SELECT action FROM admin_audit WHERE action='inbox.delete' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(aud.rows.length, 1);
  });

  test("DELETE /api/admin/messages/:id 不存在 → 404", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/admin/messages/9999999999`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 404);
  });
});
