/**
 * M8.3 / P2-21 集成:retryOutbox + ackRule + transitionRuleState ack 重置 + HTTP 路由。
 *
 * 覆盖 Codex code review 列出的测试边界:
 *   - retryOutbox: failed && attempts<MAX 可重试;>=MAX / pending / sent / 不存在 → false
 *   - ackRule: 不存在 / firing=false → NOT_FIRING;首次 ack → audit 写一条;已 ack → idempotent 不写 audit
 *   - transitionRuleState: no-op 保留 ack;true→false 清 ack;false→true 清 ack
 *   - HTTP: invalid id → 400;路由走 requireAdminVerifyDb
 *
 * pg 不可用时 skip。
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
import {
  retryOutbox,
  ackRule,
  transitionRuleState,
  listRuleStates,
  MAX_ATTEMPTS,
} from "../admin/alertOutbox.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

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
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7c).toString("base64");
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  // 不 DROP 全表 — 假设 schema 已存在;只清 admin_alert_* 数据。runMigrations() 幂等。
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
        register: { scope: "register_m83", windowSeconds: 60, max: 100 },
        login: { scope: "login_m83", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_m83", windowSeconds: 60, max: 100 },
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
    try { await query("TRUNCATE admin_alert_outbox, admin_alert_rule_state, admin_audit RESTART IDENTITY CASCADE"); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // 不 truncate users(怕影响别的并发测试),只清 alert 表 + audit
  await query("TRUNCATE admin_alert_outbox, admin_alert_rule_state, admin_audit RESTART IDENTITY CASCADE");
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

async function ensureAdmin(email = "ack-admin@test.local"): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ($1, 'argon2$stub', 0, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role='admin', status='active'
     RETURNING id::text AS id`,
    [email],
  );
  return BigInt(r.rows[0].id);
}

async function adminToken(): Promise<{ id: bigint; token: string }> {
  const id = await ensureAdmin();
  const r = await signAccess({ sub: id.toString(), role: "admin" }, JWT_SECRET);
  return { id, token: r.token };
}

/** 构造一条 outbox 行(不依赖 channel,channel_id NULL 即可)。 */
async function insertOutbox(opts: {
  status: string;
  attempts: number;
  next_attempt_at?: Date;
}): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO admin_alert_outbox(
       event_type, severity, title, body, payload,
       channel_id, status, attempts, next_attempt_at
     ) VALUES (
       'test.event', 'warning', 't', 'b', '{}'::jsonb,
       NULL, $1, $2, $3
     ) RETURNING id::text AS id`,
    [opts.status, opts.attempts, opts.next_attempt_at ?? new Date()],
  );
  return r.rows[0].id;
}

// ─── retryOutbox ────────────────────────────────────────────────────

describe("retryOutbox", () => {
  test("failed && attempts < MAX_ATTEMPTS → retried=true, next_attempt_at <= now, attempts unchanged", async (t) => {
    if (skipIfNoPg(t)) return;
    const future = new Date(Date.now() + 10 * 60_000);
    const id = await insertOutbox({ status: "failed", attempts: 9, next_attempt_at: future });
    const before = Date.now();
    const r = await retryOutbox(id);
    assert.equal(r.retried, true);
    const row = (await query<{ attempts: number; next_attempt_at: Date; status: string }>(
      `SELECT attempts, next_attempt_at, status FROM admin_alert_outbox WHERE id = $1`, [id],
    )).rows[0];
    assert.equal(row.attempts, 9, "attempts not reset");
    assert.equal(row.status, "failed", "status not changed");
    assert.ok(row.next_attempt_at.getTime() <= Date.now() + 1000, "next_attempt_at moved to <= now");
    assert.ok(row.next_attempt_at.getTime() >= before - 1000);
  });

  test("attempts >= MAX_ATTEMPTS → retried=false (dead-letter)", async (t) => {
    if (skipIfNoPg(t)) return;
    const id = await insertOutbox({ status: "failed", attempts: MAX_ATTEMPTS });
    const r = await retryOutbox(id);
    assert.equal(r.retried, false);
  });

  test("status=pending → retried=false (not in failed state)", async (t) => {
    if (skipIfNoPg(t)) return;
    const id = await insertOutbox({ status: "pending", attempts: 0 });
    const r = await retryOutbox(id);
    assert.equal(r.retried, false);
  });

  test("status=sent → retried=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const id = await insertOutbox({ status: "sent", attempts: 1 });
    const r = await retryOutbox(id);
    assert.equal(r.retried, false);
  });

  test("不存在 id → retried=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await retryOutbox("999999999");
    assert.equal(r.retried, false);
  });
});

// ─── ackRule ────────────────────────────────────────────────────────

describe("ackRule", () => {
  test("不存在的 rule → NOT_FIRING", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    await assert.rejects(
      ackRule("nonexistent.rule", adminId),
      (err: unknown) =>
        err instanceof RangeError && (err as { code?: string }).code === "NOT_FIRING",
    );
  });

  test("rule 已 resolved (firing=false) → NOT_FIRING", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    await transitionRuleState("test.rule", true, "k1", { v: 1 });
    await transitionRuleState("test.rule", false, null, { v: 2 });
    await assert.rejects(
      ackRule("test.rule", adminId),
      (err: unknown) =>
        err instanceof RangeError && (err as { code?: string }).code === "NOT_FIRING",
    );
  });

  test("firing=true, acked=false → 写 acked=true + audit 一条", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    await transitionRuleState("test.rule", true, "k1", { v: 1 });
    const r = await ackRule("test.rule", String(adminId), "127.0.0.1", "test-ua");
    assert.equal(r.acked, true);
    assert.equal(r.alreadyAcked, false);
    const row = (await query<{ acked: boolean; acked_by: string | null; acked_at: Date | null }>(
      `SELECT acked, acked_by::text AS acked_by, acked_at FROM admin_alert_rule_state WHERE rule_id = 'test.rule'`,
    )).rows[0];
    assert.equal(row.acked, true);
    assert.equal(row.acked_by, String(adminId));
    assert.ok(row.acked_at);

    const audits = await query<{ action: string; target: string; admin_id: string }>(
      `SELECT action, target, admin_id::text AS admin_id FROM admin_audit WHERE action = 'alert_rule.ack'`,
    );
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].target, "rule:test.rule");
    assert.equal(audits.rows[0].admin_id, String(adminId));
  });

  test("已 ack → idempotent: alreadyAcked=true, 不刷 acked_at/acked_by, 不写新 audit", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    const otherId = await ensureAdmin("other-admin@test.local");
    await transitionRuleState("test.rule", true, "k1", {});
    await ackRule("test.rule", adminId);
    const before = (await query<{ acked_at: Date; acked_by: string }>(
      `SELECT acked_at, acked_by::text AS acked_by FROM admin_alert_rule_state WHERE rule_id='test.rule'`,
    )).rows[0];
    // 用别的 admin 再 ack 一次,确保 acked_at / acked_by 不刷
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await ackRule("test.rule", otherId);
    assert.equal(r2.alreadyAcked, true);
    const after = (await query<{ acked_at: Date; acked_by: string }>(
      `SELECT acked_at, acked_by::text AS acked_by FROM admin_alert_rule_state WHERE rule_id='test.rule'`,
    )).rows[0];
    assert.equal(after.acked_by, before.acked_by);
    assert.equal(after.acked_at.getTime(), before.acked_at.getTime());
    const auditCount = (await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM admin_audit WHERE action='alert_rule.ack'`,
    )).rows[0].c;
    assert.equal(auditCount, "1", "no new audit on idempotent ack");
  });
});

// ─── transitionRuleState ack 重置语义 ────────────────────────────

describe("transitionRuleState ack 重置", () => {
  test("no-op (firing 未变) 保留 ack", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    await transitionRuleState("test.rule", true, "k1", {});
    await ackRule("test.rule", adminId);
    // scheduler 又跑了一轮,firing 仍是 true → no-op
    await transitionRuleState("test.rule", true, "k1", { tick: 2 });
    const row = (await listRuleStates()).find((r) => r.rule_id === "test.rule");
    assert.ok(row);
    assert.equal(row.acked, true, "ack preserved on no-op");
    assert.equal(row.acked_by, String(adminId));
  });

  test("true → false 清 ack(resolved 下 ack 字段无意义)", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    await transitionRuleState("test.rule", true, "k1", {});
    await ackRule("test.rule", adminId);
    await transitionRuleState("test.rule", false, null, {});
    const row = (await listRuleStates()).find((r) => r.rule_id === "test.rule");
    assert.ok(row);
    assert.equal(row.firing, false);
    assert.equal(row.acked, false, "ack cleared on resolve");
    assert.equal(row.acked_at, null);
    assert.equal(row.acked_by, null);
  });

  test("false → true 清 ack(新一轮告警不继承旧确认)", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    // 先制造 acked=true 状态(虽然实际上 transition 不会留 acked,但作为防御性测试)
    await transitionRuleState("test.rule", true, "k1", {});
    await ackRule("test.rule", adminId);
    await transitionRuleState("test.rule", false, null, {});
    // 再触发一次 firing
    await transitionRuleState("test.rule", true, "k2", {});
    const row = (await listRuleStates()).find((r) => r.rule_id === "test.rule");
    assert.ok(row);
    assert.equal(row.firing, true);
    assert.equal(row.acked, false, "fresh fire starts unacked");
  });
});

// ─── HTTP smoke ─────────────────────────────────────────────────────

describe("HTTP /api/admin/alerts/{outbox/:id/retry, rules/:rule_id/ack}", () => {
  test("invalid outbox id → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/alerts/outbox/abc/retry`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 400);
  });

  test("invalid rule_id → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/alerts/rules/INVALID-Rule/ack`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 400);
  });

  test("retry 不存在的 outbox → 409 NOT_RETRYABLE", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/alerts/outbox/999999/retry`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 409);
    const body = (await r.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "NOT_RETRYABLE");
  });

  test("ack 未 firing 的 rule → 409 NOT_FIRING", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/alerts/rules/never.fired/ack`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 409);
    const body = (await r.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "NOT_FIRING");
  });

  test("无 token → 401(requireAuth missing bearer)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetch(`${baseUrl}/api/admin/alerts/outbox/1/retry`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  test("retry happy path: failed + attempts<MAX → 200 retried=true", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    const id = await insertOutbox({ status: "failed", attempts: 1 });
    const r = await fetch(`${baseUrl}/api/admin/alerts/outbox/${id}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { retried: boolean };
    assert.equal(body.retried, true);
  });

  test("ack happy path: firing rule → 200 acked=true", async (t) => {
    if (skipIfNoHttp(t)) return;
    const { token } = await adminToken();
    await transitionRuleState("happy.rule", true, "k", {});
    const r = await fetch(`${baseUrl}/api/admin/alerts/rules/happy.rule/ack`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { acked: boolean; already_acked: boolean };
    assert.equal(body.acked, true);
    assert.equal(body.already_acked, false);
  });
});
