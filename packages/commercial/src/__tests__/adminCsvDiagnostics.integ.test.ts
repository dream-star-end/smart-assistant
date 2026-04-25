/**
 * M8.4 / P2-20 集成:users.csv / orders.csv 导出 + diagnostics endpoint。
 *
 * 覆盖 Codex plan review v2 列出的边界:
 *   - csvEscapeCell 公式注入(`=SUM()` / 含 `,` / 换行 / `"`)正确转义
 *   - users.csv / orders.csv:鉴权(401 / 403 / 200)+ admin_audit 写入
 *   - status filter 校验(400 VALIDATION)
 *   - 50000 行硬上限不触发(测试只用 < 10 行)
 *   - diagnostics:server / db / alerts / account_pool 字段都在
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
import { csvEscapeCell, csvFilename } from "../admin/csvHelper.js";
import { buildUsersCsv } from "../admin/users.js";
import { buildOrdersCsv } from "../admin/orders.js";

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
        register: { scope: "register_m84", windowSeconds: 60, max: 100 },
        login: { scope: "login_m84", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_m84", windowSeconds: 60, max: 100 },
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
    try { await query("TRUNCATE users, orders, admin_audit RESTART IDENTITY CASCADE"); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // CSV 测试需要确定行数 — 清干净 users / orders / audit。
  await query("TRUNCATE users, orders, admin_audit RESTART IDENTITY CASCADE");
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

async function ensureAdmin(email = "csv-admin@test.local"): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ($1, 'argon2$stub', 0, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role='admin', status='active'
     RETURNING id::text AS id`,
    [email],
  );
  return BigInt(r.rows[0].id);
}

async function ensureUser(email: string, displayName: string | null = null): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status, display_name)
     VALUES ($1, 'argon2$stub', 100, 'user', 'active', $2)
     ON CONFLICT (email) DO UPDATE SET display_name = $2
     RETURNING id::text AS id`,
    [email, displayName],
  );
  return BigInt(r.rows[0].id);
}

async function adminToken(): Promise<{ id: bigint; token: string }> {
  const id = await ensureAdmin();
  const r = await signAccess({ sub: id.toString(), role: "admin" }, JWT_SECRET);
  return { id, token: r.token };
}

async function userToken(email: string): Promise<{ id: bigint; token: string }> {
  const id = await ensureUser(email);
  const r = await signAccess({ sub: id.toString(), role: "user" }, JWT_SECRET);
  return { id, token: r.token };
}

// ─── csvEscapeCell 公式注入 + RFC4180 ────────────────────────────────

describe("csvEscapeCell", () => {
  test("normal value passes through", () => {
    assert.equal(csvEscapeCell("hello"), "hello");
    assert.equal(csvEscapeCell(123), "123");
  });
  test("null/undefined → empty", () => {
    assert.equal(csvEscapeCell(null), "");
    assert.equal(csvEscapeCell(undefined), "");
  });
  test("formula injection chars get prefixed with '", () => {
    assert.equal(csvEscapeCell("=SUM(A1:A10)"), "'=SUM(A1:A10)");
    assert.equal(csvEscapeCell("+1+1"), "'+1+1");
    assert.equal(csvEscapeCell("-cmd"), "'-cmd");
    assert.equal(csvEscapeCell("@Mention"), "'@Mention");
    // \t 仅触发 formula prefix(不在 RFC 4180 quote-trigger 集合)
    assert.equal(csvEscapeCell("\tTab"), "'\tTab");
    // \r 同时触发 formula prefix + RFC 4180 quote
    assert.equal(csvEscapeCell("\rCR"), '"\'\rCR"');
  });
  test("comma / quote / newline triggers RFC 4180 quoting", () => {
    assert.equal(csvEscapeCell("a,b"), '"a,b"');
    assert.equal(csvEscapeCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscapeCell("line1\nline2"), '"line1\nline2"');
  });
  test("formula + comma:both rules apply, formula prefix first then quote", () => {
    assert.equal(csvEscapeCell("=A,B"), '"\'=A,B"');
  });
});

describe("csvFilename", () => {
  test("matches <prefix>-YYYYMMDDTHHmm.csv pattern", () => {
    const f = csvFilename("users");
    assert.match(f, /^users-\d{8}T\d{4}\.csv$/);
  });
});

// ─── buildUsersCsv ──────────────────────────────────────────────────

describe("buildUsersCsv", () => {
  test("空表 → 仅 header,rowCount=0", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await buildUsersCsv();
    assert.equal(r.rowCount, 0);
    const lines = r.csv.split("\r\n");
    assert.equal(lines[0], "id,email,email_verified,display_name,role,status,credits_cents,created_at,updated_at");
    assert.equal(lines[1], ""); // 末尾 CRLF
  });

  test("含 formula 字符的 display_name 被正确 escape", async (t) => {
    if (skipIfNoPg(t)) return;
    await ensureUser("csv1@test.local", "=SUM(A1)");
    const r = await buildUsersCsv();
    assert.equal(r.rowCount, 1);
    // header + 1 row + trailing CRLF
    const lines = r.csv.split("\r\n");
    assert.equal(lines.length, 3);
    // display_name column index = 3 in header
    assert.match(lines[1], /,'=SUM\(A1\),/);
  });

  test("status filter 限制行数", async (t) => {
    if (skipIfNoPg(t)) return;
    await ensureUser("u1@test.local");
    const banned = await ensureUser("banned@test.local");
    await query(`UPDATE users SET status='banned' WHERE id=$1`, [banned.toString()]);
    const r = await buildUsersCsv({ status: "banned" });
    assert.equal(r.rowCount, 1);
  });

  test("invalid status → RangeError(invalid_status)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      buildUsersCsv({ status: "wat" as never }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_status",
    );
  });
});

// ─── buildOrdersCsv ─────────────────────────────────────────────────

async function insertOrder(userId: bigint, orderNo: string, status: string): Promise<void> {
  await query(
    `INSERT INTO orders(order_no, user_id, provider, amount_cents, credits, status, expires_at)
     VALUES ($1, $2::bigint, 'hupijiao', 100, 100, $3, NOW() + INTERVAL '1 day')`,
    [orderNo, userId.toString(), status],
  );
}

describe("buildOrdersCsv", () => {
  test("空表 → 仅 header", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await buildOrdersCsv();
    assert.equal(r.rowCount, 0);
    const header = r.csv.split("\r\n")[0];
    assert.equal(header, "id,order_no,user_id,username,provider,provider_order,amount_cents,credits_cents,status,paid_at,expires_at,created_at");
  });

  test("status filter", async (t) => {
    if (skipIfNoPg(t)) return;
    const u = await ensureUser("orders@test.local");
    await insertOrder(u, "O1", "pending");
    await insertOrder(u, "O2", "paid");
    const r = await buildOrdersCsv({ status: "paid" });
    assert.equal(r.rowCount, 1);
  });

  test("user_id filter", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await ensureUser("ou1@test.local");
    const u2 = await ensureUser("ou2@test.local");
    await insertOrder(u1, "O3", "pending");
    await insertOrder(u2, "O4", "pending");
    const r = await buildOrdersCsv({ user_id: u1.toString() });
    assert.equal(r.rowCount, 1);
  });

  test("invalid status / user_id / from / to → RangeError", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(buildOrdersCsv({ status: "wat" as never }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_status");
    await assert.rejects(buildOrdersCsv({ user_id: "abc" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_user_id");
    // bigint 上界:9223372036854775808 > PG bigint max,模块层应拦截而非交给 PG 抛 22003
    await assert.rejects(buildOrdersCsv({ user_id: "9223372036854775808" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_user_id");
    await assert.rejects(buildOrdersCsv({ from: "not-a-date" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_from");
    await assert.rejects(buildOrdersCsv({ to: "not-a-date" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_to");
  });
});

// ─── HTTP /api/admin/users.csv ──────────────────────────────────────

describe("GET /api/admin/users.csv", () => {
  test("无 token → 401", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetch(`${baseUrl}/api/admin/users.csv`);
    assert.equal(r.status, 401);
  });

  test("普通用户 token → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await userToken("plainuser@test.local");
    const r = await fetch(`${baseUrl}/api/admin/users.csv`, {
      headers: { authorization: `Bearer ${u.token}` },
    });
    assert.equal(r.status, 403);
  });

  test("admin token → 200 + CSV body + audit 写入", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await adminToken();
    await ensureUser("export-target@test.local", "Bob");
    const r = await fetch(`${baseUrl}/api/admin/users.csv`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(r.headers.get("content-disposition") ?? "", /attachment;\s*filename="users-\d{8}T\d{4}\.csv"/);
    const body = await r.text();
    assert.match(body.split("\r\n")[0], /^id,email,/);

    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM admin_audit
       WHERE action = 'users.export_csv' AND admin_id = $1`,
      [a.id.toString()],
    );
    assert.equal(audit.rows[0].count, "1");
  });

  test("invalid status → 400 VALIDATION", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/users.csv?status=wat`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "VALIDATION");
  });
});

// ─── HTTP /api/admin/orders.csv ─────────────────────────────────────

describe("GET /api/admin/orders.csv", () => {
  test("无 token → 401", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetch(`${baseUrl}/api/admin/orders.csv`);
    assert.equal(r.status, 401);
  });

  test("普通用户 → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await userToken("orders-plain@test.local");
    const r = await fetch(`${baseUrl}/api/admin/orders.csv`, {
      headers: { authorization: `Bearer ${u.token}` },
    });
    assert.equal(r.status, 403);
  });

  test("admin → 200 + audit 写入", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/orders.csv`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /filename="orders-\d{8}T\d{4}\.csv"/);
    const body = await r.text();
    assert.match(body.split("\r\n")[0], /^id,order_no,user_id,username,/);

    const audit = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM admin_audit
       WHERE action = 'orders.export_csv' AND admin_id = $1`,
      [a.id.toString()],
    );
    assert.equal(audit.rows[0].count, "1");
  });

  test("invalid status → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/orders.csv?status=wat`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(r.status, 400);
  });
});

// ─── HTTP /api/admin/diagnostics ────────────────────────────────────

describe("GET /api/admin/diagnostics", () => {
  test("无 token → 401", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetch(`${baseUrl}/api/admin/diagnostics`);
    assert.equal(r.status, 401);
  });

  test("普通用户 → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await userToken("diag-plain@test.local");
    const r = await fetch(`${baseUrl}/api/admin/diagnostics`, {
      headers: { authorization: `Bearer ${u.token}` },
    });
    assert.equal(r.status, 403);
  });

  test("admin → 200 + 包含 server / db / alerts / account_pool", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await adminToken();
    const r = await fetch(`${baseUrl}/api/admin/diagnostics`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as {
      server: { version: { tag: string }; node: string; uptime_sec: number; now: string };
      db: { pool_total: number; pool_idle: number; pool_waiting: number; pg_version: string | null };
      alerts: unknown;
      account_pool: unknown;
    };
    assert.ok(body.server, "server present");
    assert.ok(body.server.version, "version present");
    assert.equal(typeof body.server.node, "string");
    assert.equal(typeof body.server.uptime_sec, "number");
    assert.ok(body.db, "db present");
    assert.equal(typeof body.db.pool_total, "number");
    assert.equal(typeof body.db.pool_idle, "number");
    assert.equal(typeof body.db.pool_waiting, "number");
    assert.ok(body.db.pg_version && body.db.pg_version.includes("PostgreSQL"));
    assert.ok(body.alerts !== undefined);
    assert.ok(body.account_pool !== undefined);
  });
});
