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
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import sharp from "sharp";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { signAccess } from "../auth/jwt.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import { deriveMediaSignKey } from "../http/mediaSign.js";
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
import {
  canAccessInboxAsset,
  readInboxAssetForViewer,
} from "../inbox/assets.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "i".repeat(64);
const TEST_BRIDGE_SECRET = "a".repeat(64);
const TEST_MEDIA_SIGN_KEY = deriveMediaSignKey(TEST_BRIDGE_SECRET);

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
  await resetTestSchemaForTest();
  await runMigrations();

  redis = await probeRedis();

  // fixture fail-closed:缺 Redis 时此前静默降级(整份套件的 HTTP 路径不装配),

  // 于是"绿"只证明了没跑。REQUIRE_TEST_DB/CI 下必须红 —— 2026-07-26 门禁审计。

  if (!redis && REQUIRE_TEST_DB) {

    throw new Error("Redis test fixture required (TEST_REDIS_URL) — refusing to silently degrade");

  }
  if (redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      v3Supervisor: { pool } as unknown as V3SupervisorDeps,
      bridgeSecret: TEST_BRIDGE_SECRET,
      mediaSignKey: TEST_MEDIA_SIGN_KEY,
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
    try { await resetTestSchemaForTest(); } catch { /* */ }
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

  test("富图片与消息同事务写入，按收件人隔离且删除级联失效", async (t) => {
    if (skipIfNoPg(t)) return;
    const source = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 10, g: 120, b: 220 } },
    })
      .png()
      .toBuffer();
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    const message = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "带图单发",
      body_md: `![示意图](inbox-asset://${clientId})`,
      assets: [
        {
          client_id: clientId,
          filename: "demo.png",
          mime_type: "image/png",
          data_base64: source.toString("base64"),
        },
      ],
    });
    const match = /\/api\/inbox-assets\/([0-9a-f-]{36})/.exec(message.body_md);
    assert.ok(match, "正文必须只保存平台资产 URL");
    const assetId = match[1]!;
    const row = await query<{ mime_type: string; size_bytes: number; data: Buffer }>(
      `SELECT mime_type, size_bytes, data FROM inbox_message_assets WHERE id=$1::uuid`,
      [assetId],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]!.mime_type, "image/webp");
    assert.equal(row.rows[0]!.size_bytes, row.rows[0]!.data.length);
    assert.equal(await canAccessInboxAsset(alice.toString(), "user", assetId), true);
    assert.equal(await canAccessInboxAsset(bob.toString(), "user", assetId), false);
    assert.equal(await canAccessInboxAsset(admin.toString(), "admin", assetId), true);
    assert.ok(await readInboxAssetForViewer(alice.toString(), "user", assetId));

    await query("UPDATE users SET status='banned' WHERE id=$1::bigint", [alice.toString()]);
    assert.equal(await canAccessInboxAsset(alice.toString(), "user", assetId), false);
    assert.equal(await readInboxAssetForViewer(alice.toString(), "user", assetId), null);
    await query("UPDATE users SET status='active' WHERE id=$1::bigint", [alice.toString()]);

    await adminDeleteInbox(message.id);
    assert.equal(await canAccessInboxAsset(alice.toString(), "user", assetId), false);
    assert.equal(
      (await query(`SELECT 1 FROM inbox_message_assets WHERE id=$1::uuid`, [assetId])).rows.length,
      0,
    );
  });

  test("图片引用校验失败时不留下消息或资产；过期后用户立即不可读", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () =>
        createInboxMessage(admin, {
          audience: "all",
          title: "坏引用",
          body_md: "![](inbox-asset://550e8400-e29b-41d4-a716-446655440000)",
        }),
      (error: unknown) => error instanceof InboxError && error.code === "VALIDATION",
    );
    assert.equal((await query(`SELECT 1 FROM inbox_messages`)).rows.length, 0);
    assert.equal((await query(`SELECT 1 FROM inbox_message_assets`)).rows.length, 0);

    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#111827" },
    })
      .png()
      .toBuffer();
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    const message = await createInboxMessage(admin, {
      audience: "all",
      title: "过期图片",
      body_md: `![](inbox-asset://${clientId})`,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      assets: [
        {
          client_id: clientId,
          filename: "expired.png",
          mime_type: "image/png",
          data_base64: source.toString("base64"),
        },
      ],
    });
    const assetId = /\/api\/inbox-assets\/([0-9a-f-]{36})/.exec(message.body_md)![1]!;
    assert.equal(await canAccessInboxAsset(alice.toString(), "user", assetId), false);
    assert.equal(await readInboxAssetForViewer(alice.toString(), "user", assetId), null);
    assert.equal(await canAccessInboxAsset(admin.toString(), "admin", assetId), true);
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
    const m1 = await createInboxMessage(admin, {
      audience: "all", title: "a1", body_md: "x", category: "marketing",
    });
    const m2 = await createInboxMessage(admin, {
      audience: "user", user_id: alice.toString(), title: "a2", body_md: "x",
      category: "automation",
    });
    await query(
      `UPDATE inbox_messages
          SET thread_key=$2,source_type='cron_delivery',source_id=$3,source_phase='delivery-1'
        WHERE id=$1`,
      [m2.id, `cron:user:${alice.toString()}`, alice.toString()],
    );
    await markRead(alice, m1.id);
    await markRead(bob, m1.id);
    await markRead(alice, m2.id);

    const r = await adminListInbox({ limit: 10 });
    assert.equal(r.total, 2);
    const byId = new Map(r.messages.map((x) => [x.id, x]));
    assert.equal(byId.get(m1.id)!.read_count, 2);
    assert.equal(byId.get(m2.id)!.read_count, 1);
    assert.equal(byId.get(m2.id)!.recipients, 1);
    assert.equal(byId.get(m2.id)!.category, "automation");
    assert.equal(byId.get(m2.id)!.thread_key, `cron:user:${alice.toString()}`);
    assert.equal(byId.get(m2.id)!.thread_count, 1);
    assert.equal(byId.get(m2.id)!.source_type, "cron_delivery");
    // recipients='all' 至少应该有 admin/alice/bob 3 个 active
    assert.ok(byId.get(m1.id)!.recipients >= 3);

    const filtered = await adminListInbox({ limit: 10, category: "automation" });
    assert.equal(filtered.total, 1);
    assert.deepEqual(
      filtered.messages.map((message) => message.id),
      [m2.id],
    );
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

  test("POST /api/admin/messages 图片 payload 可超过默认 64 KiB，响应不泄露 base64/BYTEA", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const pixels = randomBytes(256 * 256 * 3);
    const source = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } })
      .png()
      .toBuffer();
    assert.ok(source.length > 65_536, "fixture 应越过默认 JSON 64 KiB 上限");
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    const dataBase64 = source.toString("base64");
    const response = await fetch(`${baseUrl}/api/admin/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        audience: "user",
        user_id: alice.toString(),
        title: "图片消息",
        body_md: `![随机图](inbox-asset://${clientId})`,
        assets: [
          {
            client_id: clientId,
            filename: "noise.png",
            mime_type: "image/png",
            data_base64: dataBase64,
          },
        ],
      }),
    });
    assert.equal(response.status, 201);
    const raw = await response.text();
    assert.ok(!raw.includes(dataBase64.slice(0, 128)), "创建响应不得回显图片字节");
    const json = JSON.parse(raw) as { message: { body_md: string } };
    assert.match(json.message.body_md, /\/api\/inbox-assets\/[0-9a-f-]{36}/);

    const list = await fetch(`${baseUrl}/api/admin/messages?limit=10`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const listRaw = await list.text();
    assert.ok(!listRaw.includes(dataBase64.slice(0, 128)), "列表响应不得回显图片字节");
  });

  test("站内信图片经短期签名读取，其他用户签不到且删除后旧 URL 立即失效", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const source = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#2563eb" },
    })
      .png()
      .toBuffer();
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    const message = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "签名图片",
      body_md: `![私有图](inbox-asset://${clientId})`,
      assets: [
        {
          client_id: clientId,
          filename: "private.png",
          mime_type: "image/png",
          data_base64: source.toString("base64"),
        },
      ],
    });
    const assetPath = /\/api\/inbox-assets\/[0-9a-f-]{36}/.exec(message.body_md)?.[0];
    assert.ok(assetPath);

    const sign = await fetch(`${baseUrl}/api/media-sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: [assetPath] }),
    });
    assert.equal(sign.status, 200);
    const signedUrl = ((await sign.json()) as { urls: Record<string, string> }).urls[assetPath];
    assert.ok(signedUrl?.startsWith("/api/media-signed?t="));

    const image = await fetch(`${baseUrl}${signedUrl}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type") ?? "", /^image\/webp/);
    assert.match(image.headers.get("cache-control") ?? "", /private/);
    assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, "webp");

    const bob = await makeUser(`bob-media-${Date.now()}@inbox.test`);
    const bobToken = (await signAccess({ sub: bob.toString(), role: "user" }, JWT_SECRET)).token;
    const denied = await fetch(`${baseUrl}/api/media-sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: [assetPath] }),
    });
    assert.equal(denied.status, 200);
    assert.deepEqual((await denied.json() as { urls: Record<string, string> }).urls, {});

    await adminDeleteInbox(message.id);
    assert.equal((await fetch(`${baseUrl}${signedUrl}`)).status, 403);
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

  test("GET /api/me/messages 返回用户侧分类和线程元数据", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const first = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "automation-1",
      body_md: "B1",
      category: "automation",
    });
    const second = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "automation-2",
      body_md: "B2",
      category: "automation",
    });
    const normal = await createInboxMessage(admin, {
      audience: "user",
      user_id: alice.toString(),
      title: "normal",
      body_md: "B3",
    });
    const threadKey = `cron:user:${alice.toString()}`;
    await query(
      `UPDATE inbox_messages
          SET thread_key=$2,
              source_type='cron_delivery',
              source_id=$3,
              source_phase=CASE WHEN id=$1::bigint THEN 'delivery-1' ELSE 'delivery-2' END
        WHERE id IN ($1::bigint, $4::bigint)`,
      [first.id, threadKey, alice.toString(), second.id],
    );
    await markRead(alice, first.id);

    const response = await fetch(`${baseUrl}/api/me/messages`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      messages: Array<{
        id: string;
        read: boolean;
        category: string;
        thread_key: string | null;
        thread_count: number;
        source_type: string | null;
        source_id: string | null;
        source_phase: string | null;
      }>;
      unread_count: number;
    };
    const byId = new Map(body.messages.map((message) => [message.id, message]));
    for (const id of [first.id, second.id]) {
      assert.equal(byId.get(id)!.category, "automation");
      assert.equal(byId.get(id)!.thread_key, threadKey);
      assert.equal(byId.get(id)!.thread_count, 2);
      assert.equal(byId.get(id)!.source_type, "cron_delivery");
      assert.equal(byId.get(id)!.source_id, alice.toString());
    }
    assert.equal(byId.get(first.id)!.source_phase, "delivery-1");
    assert.equal(byId.get(second.id)!.source_phase, "delivery-2");
    assert.equal(byId.get(first.id)!.read, true);
    assert.equal(byId.get(second.id)!.read, false);
    assert.equal(byId.get(normal.id)!.category, "user");
    assert.equal(byId.get(normal.id)!.thread_key, null);
    assert.equal(byId.get(normal.id)!.thread_count, 1);
    assert.equal(byId.get(normal.id)!.source_type, null);
    assert.equal(byId.get(normal.id)!.source_id, null);
    assert.equal(byId.get(normal.id)!.source_phase, null);
    assert.equal(body.unread_count, 2);
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
