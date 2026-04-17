/**
 * T-54 集成:admin agent_audit 查询 + requireAdmin 中间件。
 *
 * 覆盖:
 *   1. writeAgentAudit + listAgentAudit happy path(2 个用户,各自 1-2 条)
 *   2. user_id 过滤
 *   3. tool 过滤
 *   4. keyset 分页 before + limit + next_before
 *   5. 非法参数 → RangeError(HTTP 层转 400)
 *   6. requireAdmin:role=user → 403 FORBIDDEN
 *   7. requireAdmin:role=admin + 完整流程 → 200 + 序列化正确(含 ISO 时间)
 *
 * 不覆盖:
 *   - WS agent 层写 audit(T-52 已覆盖)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import {
  listAgentAudit,
  AGENT_AUDIT_MAX_LIMIT,
} from "../admin/agentAudit.js";
import { writeAgentAudit } from "../ws/agent.js";
import { requireAdmin } from "../admin/requireAdmin.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { HttpError } from "../http/util.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

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
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* ignore */ } return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
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
        register: { scope: "register_t54", windowSeconds: 60, max: 100 },
        login: { scope: "login_t54", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t54", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE agent_audit, agent_containers, agent_subscriptions, admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
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
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  );
  return BigInt(r.rows[0].id);
}

async function insertAudit(
  uid: bigint,
  session: string,
  tool: string,
  success: boolean,
  errorMsg: string | null = null,
): Promise<void> {
  const pool = { query: query } as unknown as import("pg").Pool;
  await writeAgentAudit(pool, {
    user_id: uid.toString(),
    session_id: session,
    tool,
    input_meta: { cmd: `echo ${tool}` },
    input_hash: null,
    output_hash: null,
    duration_ms: 42,
    success,
    error_msg: errorMsg,
  });
}

// ============================================================
//  listAgentAudit (DB 层)
// ============================================================

describe("listAgentAudit", () => {
  test("happy: 两用户各 2 条 → 默认按 id DESC 返回所有", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("a1@x.com");
    const u2 = await createUser("a2@x.com");
    await insertAudit(u1, "s1", "bash", true);
    await insertAudit(u1, "s1", "bash", false, "nonzero exit");
    await insertAudit(u2, "s2", "read", true);
    await insertAudit(u2, "s2", "write", true);

    const r = await listAgentAudit({});
    assert.equal(r.rows.length, 4);
    // id DESC
    for (let i = 1; i < r.rows.length; i++) {
      assert.ok(BigInt(r.rows[i - 1].id) > BigInt(r.rows[i].id));
    }
    assert.equal(r.next_before, null);
  });

  test("user_id 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("f1@x.com");
    const u2 = await createUser("f2@x.com");
    await insertAudit(u1, "s1", "bash", true);
    await insertAudit(u2, "s2", "bash", true);
    await insertAudit(u1, "s1", "read", true);

    const r = await listAgentAudit({ userId: u1 });
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) assert.equal(row.user_id, u1.toString());
  });

  test("tool 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("t1@x.com");
    await insertAudit(u1, "s1", "bash", true);
    await insertAudit(u1, "s1", "read", true);
    await insertAudit(u1, "s1", "bash", false, "boom");

    const r = await listAgentAudit({ tool: "bash" });
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) assert.equal(row.tool, "bash");
  });

  test("keyset 分页:limit=2 + before → 第二页", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("p1@x.com");
    for (let i = 0; i < 5; i++) {
      await insertAudit(u1, "s1", "bash", true);
    }
    const p1 = await listAgentAudit({ limit: 2 });
    assert.equal(p1.rows.length, 2);
    assert.ok(p1.next_before);

    const p2 = await listAgentAudit({ limit: 2, before: p1.next_before! });
    assert.equal(p2.rows.length, 2);
    // p2 所有 id 严格小于 p1.next_before
    for (const row of p2.rows) {
      assert.ok(BigInt(row.id) < BigInt(p1.next_before!));
    }

    const p3 = await listAgentAudit({ limit: 2, before: p2.next_before! });
    assert.equal(p3.rows.length, 1);
    // 最后一页:行数 < limit → next_before=null
    assert.equal(p3.next_before, null);
  });

  test("limit 上限被夹到 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("l1@x.com");
    await insertAudit(u1, "s", "bash", true);
    // 只传巨大 limit,verify 不抛(由 listAgentAudit 内部 clamp 到 200)
    const r = await listAgentAudit({ limit: 999 });
    assert.equal(r.rows.length, 1);
    assert.equal(AGENT_AUDIT_MAX_LIMIT, 200);
  });

  test("非法 tool → RangeError invalid_tool", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ tool: "bash; DROP TABLE users;--" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_tool",
    );
  });

  test("非法 user_id → RangeError invalid_user_id", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ userId: "abc" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_user_id",
    );
  });

  test("非法 before → RangeError invalid_before", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ before: "-1" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_before",
    );
  });
});

// ============================================================
//  requireAdmin 中间件
// ============================================================

describe("requireAdmin", () => {
  test("role=user → 403 FORBIDDEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const token = await signAccess({ sub: "42", role: "user" }, JWT_SECRET);
    const fakeReq = {
      headers: { authorization: `Bearer ${token.token}` },
    } as unknown as IncomingMessage;
    await assert.rejects(
      () => requireAdmin(fakeReq, JWT_SECRET),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "FORBIDDEN",
    );
  });

  test("role=admin → 通过,返回 user", async (t) => {
    if (skipIfNoPg(t)) return;
    const token = await signAccess({ sub: "99", role: "admin" }, JWT_SECRET);
    const fakeReq = {
      headers: { authorization: `Bearer ${token.token}` },
    } as unknown as IncomingMessage;
    const u = await requireAdmin(fakeReq, JWT_SECRET);
    assert.equal(u.id, "99");
    assert.equal(u.role, "admin");
  });

  test("无 token → 401 UNAUTHORIZED(仍然由 requireAuth 判,不是 403)", async (t) => {
    if (skipIfNoPg(t)) return;
    const fakeReq = { headers: {} } as unknown as IncomingMessage;
    await assert.rejects(
      () => requireAdmin(fakeReq, JWT_SECRET),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );
  });
});

// ============================================================
//  HTTP end-to-end(GET /api/admin/agent-audit)
// ============================================================

describe("GET /api/admin/agent-audit (integ)", () => {
  async function getJson(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${baseUrl}${path}`, { headers });
    let json: Record<string, unknown> = {};
    try { json = (await r.json()) as Record<string, unknown>; } catch { /* */ }
    return { status: r.status, json };
  }

  test("未认证 → 401", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await getJson("/api/admin/agent-audit");
    assert.equal(r.status, 401);
  });

  test("非 admin → 403 FORBIDDEN", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser("reader@x.com", "user");
    const tok = await signAccess({ sub: uid.toString(), role: "user" }, JWT_SECRET);
    const r = await getJson("/api/admin/agent-audit", {
      Authorization: `Bearer ${tok.token}`,
    });
    assert.equal(r.status, 403);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "FORBIDDEN");
  });

  test("admin 查询全表:按 id DESC + ISO 时间", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin@x.com", "admin");
    const u1 = await createUser("op@x.com", "user");
    await insertAudit(u1, "sA", "bash", true);
    await insertAudit(u1, "sA", "read", true);
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson("/api/admin/agent-audit", {
      Authorization: `Bearer ${tok.token}`,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    // ISO 时间格式
    assert.match(String(rows[0].created_at), /^\d{4}-\d{2}-\d{2}T/);
    // 按 id DESC
    assert.ok(BigInt(rows[0].id as string) > BigInt(rows[1].id as string));
    // next_before(本页只有 2 条 + 默认 limit=50 未满 → null)
    assert.equal(r.json.next_before, null);
  });

  test("admin 查询:user_id + tool 过滤联合作用", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin2@x.com", "admin");
    const u1 = await createUser("f1@x.com", "user");
    const u2 = await createUser("f2@x.com", "user");
    await insertAudit(u1, "s", "bash", true);
    await insertAudit(u1, "s", "read", true);
    await insertAudit(u2, "s", "bash", true);
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u1}&tool=bash`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, u1.toString());
    assert.equal(rows[0].tool, "bash");
  });

  test("admin 查询:非法 tool → 400 VALIDATION", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin3@x.com", "admin");
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      "/api/admin/agent-audit?tool=bash%3B%20--", // "bash; --" URL-encoded
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 400);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "VALIDATION");
  });

  test("admin 查询:limit 超上限 → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin4@x.com", "admin");
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?limit=${AGENT_AUDIT_MAX_LIMIT + 1}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 400);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "VALIDATION");
  });

  test("admin 查询:keyset 分页 limit=2 → next_before 可继续翻", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin5@x.com", "admin");
    const u = await createUser("kop@x.com", "user");
    for (let i = 0; i < 5; i++) {
      await insertAudit(u, "s", "bash", true);
    }
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r1 = await getJson(
      "/api/admin/agent-audit?limit=2",
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r1.status, 200);
    const p1Rows = r1.json.rows as Array<Record<string, unknown>>;
    assert.equal(p1Rows.length, 2);
    assert.ok(r1.json.next_before);

    const r2 = await getJson(
      `/api/admin/agent-audit?limit=2&before=${r1.json.next_before}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r2.status, 200);
    const p2Rows = r2.json.rows as Array<Record<string, unknown>>;
    assert.equal(p2Rows.length, 2);
    for (const row of p2Rows) {
      assert.ok(BigInt(row.id as string) < BigInt(r1.json.next_before as string));
    }
  });

  // ----- Acceptance (07-TASKS.md T-54) -----

  test("Acceptance 1: audit 包含 tool=bash success=true 可查", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin-acc1@x.com", "admin");
    const u = await createUser("u-ls@x.com", "user");
    // 模拟 "ls /workspace" → 由 gateway 写入 agent_audit(T-52 流程)
    const pool = { query: query } as unknown as import("pg").Pool;
    await writeAgentAudit(pool, {
      user_id: u.toString(),
      session_id: "sess-ls-1",
      tool: "bash",
      input_meta: { cmd: "ls /workspace" },
      input_hash: null,
      output_hash: null,
      duration_ms: 15,
      success: true,
      error_msg: null,
    });
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u}&tool=bash`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "bash");
    assert.equal(rows[0].success, true);
  });

  test("Acceptance 2: 错误命令 → success=false + error_msg", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin-acc2@x.com", "admin");
    const u = await createUser("u-bad@x.com", "user");
    const pool = { query: query } as unknown as import("pg").Pool;
    await writeAgentAudit(pool, {
      user_id: u.toString(),
      session_id: "sess-bad-1",
      tool: "bash",
      input_meta: { cmd: "notacmd" },
      input_hash: null,
      output_hash: null,
      duration_ms: 5,
      success: false,
      error_msg: "command not found",
    });
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].error_msg, "command not found");
  });
});
