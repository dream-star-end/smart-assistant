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
import { warmupLoginDummyHash } from "../auth/login.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

/**
 * T-16 集成:把 createCommercialHandler 装到一个真 http.Server 上,跑端到端
 * 注册→登录→/api/me。
 *
 * 用真 Redis(限流)+ 真 PG(用户/refresh_tokens),Mailer 用本地捕获。
 */

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

const JWT_SECRET = "y".repeat(64);

class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";
const mailer = new CapturingMailer();

async function probePg(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
  });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    try { r.disconnect(); } catch { /* ignore */ }
    return null;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
    setPoolOverride(pool);
    await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
    await runMigrations();
    await warmupLoginDummyHash();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }

  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required");
  }

  if (pgAvailable && redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      // 限流放宽,免得 8 个 case 互相影响(每个 test 之前清 redis)
      rateLimits: {
        register: { scope: "register_test", windowSeconds: 60, max: 100 },
        login: { scope: "login_test", windowSeconds: 60, max: 100 },
        requestReset: { scope: "request_reset_test", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("not handled by commercial");
      }
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* ignore */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  await query("TRUNCATE TABLE refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  await redis.flushdb();
  mailer.sent.length = 0;
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip("pg/redis/server not available");
    return true;
  }
  return false;
}

async function postJson(path: string, body: unknown, headers?: Record<string, string>): Promise<{
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: r.status, json, headers: r.headers };
}

async function getJson(path: string, headers?: Record<string, string>): Promise<{
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}> {
  const r = await fetch(`${baseUrl}${path}`, { headers });
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: r.status, json, headers: r.headers };
}

describe("commercial HTTP router (integ)", () => {
  test("end-to-end: register → login → GET /api/me returns user", async (t) => {
    if (skipIfMissing(t)) return;

    const reg = await postJson("/api/auth/register", {
      email: "alice@example.com",
      password: "alice good password",
      turnstile_token: "tok",
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    assert.ok(reg.json.user_id);

    const login = await postJson("/api/auth/login", {
      email: "alice@example.com",
      password: "alice good password",
      turnstile_token: "tok",
    });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    const accessToken = login.json.access_token as string;
    assert.ok(accessToken);

    const me = await getJson("/api/me", { Authorization: `Bearer ${accessToken}` });
    assert.equal(me.status, 200, JSON.stringify(me.json));
    const user = me.json.user as Record<string, unknown>;
    assert.equal(user.email, "alice@example.com");
    assert.equal(user.role, "user");
  });

  test("/api/me without token → 401 UNAUTHORIZED + standard error body", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await getJson("/api/me");
    assert.equal(r.status, 401);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "UNAUTHORIZED");
    assert.ok(err.request_id, "request_id must be present");
  });

  test("/api/me with expired token → 401 UNAUTHORIZED", async (t) => {
    if (skipIfMissing(t)) return;
    // 注册一个用户拿到 user_id
    const reg = await postJson("/api/auth/register", {
      email: "bob@example.com",
      password: "bob good password",
      turnstile_token: "tok",
    });
    const userId = reg.json.user_id as string;
    // 手工签一个已过期的 access(now=过去 1h)
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = await signAccess({ sub: userId, role: "user" }, JWT_SECRET, {
      now: past, ttlSeconds: 60,
    });
    const r = await getJson("/api/me", { Authorization: `Bearer ${expired.token}` });
    assert.equal(r.status, 401);
  });

  test("/api/me with garbage token → 401", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await getJson("/api/me", { Authorization: "Bearer not-a-jwt" });
    assert.equal(r.status, 401);
  });

  test("response carries security headers (HSTS / X-Content-Type-Options / CSP)", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await getJson("/api/me");
    assert.equal(r.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.ok(r.headers.get("x-request-id"), "x-request-id must be set");
  });

  test("X-Request-Id is propagated when client provides one", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await getJson("/api/me", { "X-Request-Id": "client-trace-abc-123" });
    assert.equal(r.headers.get("x-request-id"), "client-trace-abc-123");
  });

  test("non-/api/auth/* path → handler returns false (fall-through)", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await fetch(`${baseUrl}/healthz`);
    assert.equal(r.status, 404, "fall-through 404 from outer wrapper");
    const text = await r.text();
    assert.match(text, /not handled by commercial/);
  });

  test("wrong HTTP method → 405 METHOD_NOT_ALLOWED with Allow header", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await fetch(`${baseUrl}/api/auth/register`, { method: "GET" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST");
  });

  test("unknown /api/auth/<random> → 404 NOT_FOUND", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await postJson("/api/auth/totally-unknown", {});
    assert.equal(r.status, 404);
  });

  test("oversized body → 413 PAYLOAD_TOO_LARGE", async (t) => {
    if (skipIfMissing(t)) return;
    const big = "x".repeat(70 * 1024); // > 64 KiB
    const r = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "c@example.com", password: big, turnstile_token: "tok" }),
    });
    assert.equal(r.status, 413);
  });

  test("malformed JSON → 400 INVALID_JSON", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal((j as Record<string, { code: string }>).error.code, "INVALID_JSON");
  });

  test("register CONFLICT → 409", async (t) => {
    if (skipIfMissing(t)) return;
    await postJson("/api/auth/register", {
      email: "dan@example.com",
      password: "dan good password",
      turnstile_token: "tok",
    });
    const r = await postJson("/api/auth/register", {
      email: "dan@example.com",
      password: "another good password",
      turnstile_token: "tok",
    });
    assert.equal(r.status, 409);
    assert.equal((r.json.error as Record<string, unknown>).code, "CONFLICT");
  });

  test("login wrong password → 401 INVALID_CREDENTIALS", async (t) => {
    if (skipIfMissing(t)) return;
    await postJson("/api/auth/register", {
      email: "eve@example.com",
      password: "eve good password",
      turnstile_token: "tok",
    });
    const r = await postJson("/api/auth/login", {
      email: "eve@example.com",
      password: "WRONG password!",
      turnstile_token: "tok",
    });
    assert.equal(r.status, 401);
    assert.equal((r.json.error as Record<string, unknown>).code, "INVALID_CREDENTIALS");
  });

  test("refresh + logout: refresh works once, then logout, then refresh fails", async (t) => {
    if (skipIfMissing(t)) return;
    await postJson("/api/auth/register", {
      email: "frank@example.com",
      password: "frank good password",
      turnstile_token: "tok",
    });
    const lr = await postJson("/api/auth/login", {
      email: "frank@example.com",
      password: "frank good password",
      turnstile_token: "tok",
    });
    const refreshTok = lr.json.refresh_token as string;
    const r1 = await postJson("/api/auth/refresh", { refresh_token: refreshTok });
    assert.equal(r1.status, 200);
    assert.ok(r1.json.access_token);

    const lo = await postJson("/api/auth/logout", { refresh_token: refreshTok });
    assert.equal(lo.status, 200);
    assert.equal(lo.json.revoked, true);

    const r2 = await postJson("/api/auth/refresh", { refresh_token: refreshTok });
    assert.equal(r2.status, 401);
  });

  test("rate limit returns 429 + Retry-After header (with tight limit)", async (t) => {
    if (skipIfMissing(t)) return;
    // 临时构造一个紧限流的 server,只允许 2 次/分钟 register
    const tight = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis!),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      rateLimits: {
        register: { scope: "register_tight", windowSeconds: 60, max: 2 },
      },
    });
    const tightServer = createServer(async (req, res) => {
      const handled = await tight(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => tightServer.listen(0, "127.0.0.1", () => resolve()));
    const tightAddr = (tightServer.address() as AddressInfo).port;
    try {
      const url = `http://127.0.0.1:${tightAddr}/api/auth/register`;
      // 前 2 个命中(不同 email 避免 CONFLICT,且会通过)
      for (let i = 0; i < 2; i++) {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: `tight-${i}@example.com`,
            password: "tight password ok",
            turnstile_token: "tok",
          }),
        });
        assert.equal(r.status, 201, `call ${i + 1} should succeed`);
      }
      // 第 3 个被拦
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "tight-3@example.com",
          password: "tight password ok",
          turnstile_token: "tok",
        }),
      });
      assert.equal(r.status, 429);
      assert.ok(r.headers.get("retry-after"));
      const ev = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM rate_limit_events WHERE scope = $1 AND blocked = TRUE",
        ["register_tight"],
      );
      assert.equal(ev.rows[0].cnt, "1", "blocked event must be recorded");
    } finally {
      await new Promise<void>((resolve) => tightServer.close(() => resolve()));
    }
  });
});

// ─── gateway-style wiring smoke test ────────────────────────────────────
// 模拟 packages/gateway/src/server.ts 的挂载方式:商业化 handle 先跑,
// 未命中则 fall-through 到 gateway 自有路由(这里用 /healthz 代表)。
// 验收 T-16 的 "COMMERCIAL_ENABLED=1 下 /healthz 仍然正常响应"。
describe("commercial + gateway fall-through smoke", () => {
  let hzServer: Server | null = null;
  let hzPort = 0;
  let fallthroughHitCount = 0;

  before(async () => {
    if (!pgAvailable || !redis) return;
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      rateLimits: {
        register: { scope: "smoke_register", windowSeconds: 60, max: 100 },
        login: { scope: "smoke_login", windowSeconds: 60, max: 100 },
        requestReset: { scope: "smoke_reset", windowSeconds: 60, max: 100 },
      },
    });
    // Gateway 风格的外层 wrapper:commercial 没接就走自有路由。
    hzServer = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (handled) return;
      fallthroughHitCount += 1;
      const url = new URL(req.url ?? "/", "http://x.invalid");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => hzServer!.listen(0, "127.0.0.1", () => resolve()));
    hzPort = (hzServer!.address() as AddressInfo).port;
  });

  after(async () => {
    if (hzServer) {
      await new Promise<void>((resolve) => hzServer!.close(() => resolve()));
    }
  });

  test("/healthz falls through to gateway and returns 200 even with commercial mounted", async (t) => {
    if (skipIfMissing(t) || !hzServer) {
      t.skip("server not ready");
      return;
    }
    fallthroughHitCount = 0;
    const r = await fetch(`http://127.0.0.1:${hzPort}/healthz`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean };
    assert.equal(j.ok, true);
    assert.equal(fallthroughHitCount, 1, "gateway fallback must be invoked exactly once");
  });

  test("/api/auth/register is captured by commercial, NOT the gateway fallback", async (t) => {
    if (skipIfMissing(t) || !hzServer) {
      t.skip("server not ready");
      return;
    }
    fallthroughHitCount = 0;
    const r = await fetch(`http://127.0.0.1:${hzPort}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "smoke-routed@example.com",
        password: "smoke password ok",
        turnstile_token: "tok",
      }),
    });
    assert.equal(r.status, 201, "commercial handled register");
    assert.equal(fallthroughHitCount, 0, "gateway fallback must NOT fire for /api/auth/*");
  });
});
