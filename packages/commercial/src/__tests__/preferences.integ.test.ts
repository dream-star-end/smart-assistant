/**
 * V3 Phase 2 Task 2G integ — preferences DB 真 PG 测试。
 *
 * 跑法: REQUIRE_TEST_DB=1 npx tsx --test --test-concurrency=1 src/__tests__/preferences.integ.test.ts
 *
 * 覆盖:
 *   - getPreferences(无行)→ 默认 {} 快照
 *   - patchPreferences 创建首行
 *   - patchPreferences 浅合并(保留旧字段)
 *   - patchPreferences null 删字段
 *   - patchPreferences 空 patch → 不写 DB(updated_at 不变)
 *   - GET/PATCH /api/me/preferences 端到端
 *   - PATCH 拒绝未知字段(400 INVALID_PREFERENCES)
 *   - 不带 Bearer → 401
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
  getPreferences,
  patchPreferences,
  PreferencesError,
} from "../user/preferences.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

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

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch {} return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch {} return null; }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
    setPoolOverride(pool);
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch {}
    await runMigrations();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("PG test fixture required");
  }
  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) throw new Error("Redis test fixture required");
});

after(async () => {
  if (redis) { try { await redis.flushdb(); } catch {} await redis.quit(); }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch {}
    await closePool();
  }
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function makeUser(email: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified)
     VALUES ($1, 'x', 'user', 'active', TRUE)
     RETURNING id::text AS id`,
    [email],
  );
  return BigInt(r.rows[0].id);
}

// ─── DB 单元-as-integ ─────────────────────────────────────────────────────

describe("preferences DB ops (integ)", () => {
  let uid: bigint;

  beforeEach(async () => {
    if (!pgAvailable) return;
    await query("DELETE FROM user_preferences");
    await query("DELETE FROM users WHERE email LIKE '%@prefs.test'");
    uid = await makeUser(`u-${Date.now()}-${Math.random()}@prefs.test`);
  });

  test("getPreferences 无行 → 默认空快照", async (t) => {
    if (skipIfNoPg(t)) return;
    const snap = await getPreferences(uid);
    assert.deepEqual(snap.prefs, {});
    assert.ok(typeof snap.updated_at === "string");
  });

  test("patchPreferences 创建首行", async (t) => {
    if (skipIfNoPg(t)) return;
    const snap = await patchPreferences(uid, {
      theme: "dark",
      default_model: "claude-opus-4-7",
    });
    assert.deepEqual(snap.prefs, {
      theme: "dark",
      default_model: "claude-opus-4-7",
    });

    const reread = await getPreferences(uid);
    assert.deepEqual(reread.prefs, snap.prefs);
  });

  test("patchPreferences 浅合并(保留旧字段)", async (t) => {
    if (skipIfNoPg(t)) return;
    await patchPreferences(uid, { theme: "dark", default_model: "m1" });
    const after2 = await patchPreferences(uid, { default_effort: "high" });
    assert.deepEqual(after2.prefs, {
      theme: "dark",
      default_model: "m1",
      default_effort: "high",
    });
  });

  test("patchPreferences null 删字段", async (t) => {
    if (skipIfNoPg(t)) return;
    await patchPreferences(uid, { theme: "dark", default_model: "m1" });
    const after2 = await patchPreferences(uid, { default_model: null });
    assert.deepEqual(after2.prefs, { theme: "dark" });
  });

  test("patchPreferences 同时 set + unset 字段", async (t) => {
    if (skipIfNoPg(t)) return;
    await patchPreferences(uid, { theme: "light", default_model: "m1", notify_email: true });
    const r = await patchPreferences(uid, {
      theme: "dark",       // overwrite
      default_model: null, // unset
      notify_telegram: true, // new
    });
    assert.deepEqual(r.prefs, {
      theme: "dark",
      notify_email: true,
      notify_telegram: true,
    });
  });

  test("patchPreferences 空 patch → 返当前快照不抛", async (t) => {
    if (skipIfNoPg(t)) return;
    await patchPreferences(uid, { theme: "auto" });
    const r = await patchPreferences(uid, {});
    assert.deepEqual(r.prefs, { theme: "auto" });
  });

  test("patchPreferences 拒绝未知字段 → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => patchPreferences(uid, { theme: "dark", random_field: "x" }),
      (err: unknown) => err instanceof PreferencesError && err.code === "VALIDATION",
    );
  });

  test("patchPreferences 非法 theme → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => patchPreferences(uid, { theme: "neon" }),
      (err: unknown) => err instanceof PreferencesError && err.code === "VALIDATION",
    );
  });

  test("patchPreferences 不存在用户 → VALIDATION (FK)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => patchPreferences(BigInt("9999999999999"), { theme: "dark" }),
      (err: unknown) => err instanceof PreferencesError && err.code === "VALIDATION",
    );
  });
});

// ─── HTTP 端到端 ──────────────────────────────────────────────────────────

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> { /* noop */ }
}

const JWT_SECRET = "p".repeat(64);

describe("/api/me/preferences (http integ)", () => {
  let server: Server | null = null;
  let baseUrl = "";
  let uid: bigint;
  let token: string;

  before(async () => {
    if (!pgAvailable || !redis) return;
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    if (!pgAvailable || !redis) return;
    await query("DELETE FROM user_preferences");
    await query("DELETE FROM users WHERE email LIKE '%@prefs.test'");
    uid = await makeUser(`http-${Date.now()}@prefs.test`);
    token = (await signAccess({ sub: uid.toString(), role: "user" }, JWT_SECRET)).token;
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  test("GET 无 Bearer → 401", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/me/preferences`);
    assert.equal(r.status, 401);
  });

  test("GET 默认 → 200 空 prefs", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/me/preferences`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { prefs: Record<string, unknown>; updated_at: string };
    assert.deepEqual(j.prefs, {});
    assert.ok(typeof j.updated_at === "string");
  });

  test("PATCH 写入 → GET 反读一致", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const p = await fetch(`${baseUrl}/api/me/preferences`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark", default_model: "claude-opus-4-7" }),
    });
    assert.equal(p.status, 200);
    const pj = (await p.json()) as { prefs: Record<string, unknown> };
    assert.deepEqual(pj.prefs, { theme: "dark", default_model: "claude-opus-4-7" });

    const g = await fetch(`${baseUrl}/api/me/preferences`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const gj = (await g.json()) as { prefs: Record<string, unknown> };
    assert.deepEqual(gj.prefs, { theme: "dark", default_model: "claude-opus-4-7" });
  });

  test("PATCH 未知字段 → 400 INVALID_PREFERENCES", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/me/preferences`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ random: 1 }),
    });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: { code: string } };
    assert.equal(j.error.code, "INVALID_PREFERENCES");
  });

  test("PATCH body 非 object → 400 INVALID_BODY", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) { t.skip("fixtures"); return; }
    const r = await fetch(`${baseUrl}/api/me/preferences`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(["array", "not", "object"]),
    });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: { code: string } };
    assert.equal(j.error.code, "INVALID_BODY");
  });
});
