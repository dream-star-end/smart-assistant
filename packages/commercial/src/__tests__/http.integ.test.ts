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
import { setSystemSetting } from "../admin/systemSettings.js";
import { _resetAllowRegistrationCacheForTests } from "../http/handlers.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

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
    await resetTestSchemaForTest();
    await runMigrations();
    await warmupLoginDummyHash();
    // 2026-05-25:DEFAULTS.allow_registration 翻 false(生产关停)。这套 HTTP
    // 集成 case 大量用 POST /api/auth/register 走打通流;handler 前置门会先于
    // rate-limit / 业务逻辑判定 allow_registration,默认 false 会让所有 register
    // 路径直接 403 REGISTRATION_DISABLED。UPSERT row=true 让 row 命中覆盖默认,
    // beforeEach 只 TRUNCATE 业务表,不动 system_settings →
    // 单次设置全套共享。
    await query(
      `INSERT INTO system_settings(key, value, updated_at)
       VALUES ('allow_registration', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
    );
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
      // HIGH#4:测试跑在 http://127.0.0.1,不能用 Secure cookie 否则 fetch 不回带。
      refreshCookieSecure: false,
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
    try { await resetTestSchemaForTest(); } catch { /* ignore */ }
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

/**
 * HIGH#4 — 从一组 Set-Cookie 行里抠 `oc_rt`,返回 cookie 的属性 map(下游
 * 既可以拿 value 拼 Cookie 头,又能 assert HttpOnly/SameSite/Path/Max-Age 等
 * 安全属性是否齐全)。undici 的 headers.getSetCookie() 返回 string[],我们
 * 自己拆 `name=value; key=value; ...`,key 统一小写以便 case-insensitive 比对。
 */
function parseSetCookie(setCookieHeaders: string[], name: string): null | {
  value: string;
  attrs: Record<string, string>;
  flags: Set<string>;
} {
  for (const line of setCookieHeaders) {
    const segs = line.split(";").map((s) => s.trim());
    if (segs.length === 0) continue;
    const head = segs[0];
    const eq = head.indexOf("=");
    if (eq <= 0) continue;
    const cname = head.slice(0, eq);
    if (cname !== name) continue;
    const value = decodeURIComponent(head.slice(eq + 1));
    const attrs: Record<string, string> = {};
    const flags = new Set<string>();
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      const k = seg.indexOf("=");
      if (k < 0) flags.add(seg.toLowerCase());
      else attrs[seg.slice(0, k).toLowerCase()] = seg.slice(k + 1);
    }
    return { value, attrs, flags };
  }
  return null;
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

  test("feedback: anonymous stays anonymous, invalid Bearer is 401, valid Bearer binds user, short nonblank is accepted", async (t) => {
    if (skipIfMissing(t)) return;

    const anonymous = await postJson("/api/feedback", {
      category: "bug",
      description: "好",
      request_id: "anonymous-untrusted-trace",
      meta: { source: "settings" },
    });
    assert.equal(anonymous.status, 200, JSON.stringify(anonymous.json));

    const invalid = await postJson(
      "/api/feedback",
      { category: "bug", description: "无效 token 不得静默匿名" },
      { Authorization: "Bearer expired-or-invalid" },
    );
    assert.equal(invalid.status, 401, JSON.stringify(invalid.json));

    const insertedUser = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified)
       VALUES ('feedback-user@example.com', 'x', true) RETURNING id::text AS id`,
    );
    const userId = insertedUser.rows[0].id;
    await query(
      `INSERT INTO turn_traces(trace_id,user_id,session_key,agent_id,model)
       VALUES ('trace-feedback-1',$1::bigint,$2,'main','test-model')`,
      [userId, `c:${userId}:main:webchat:dm:feedback-session`],
    );
    const access = (await signAccess({ sub: userId, role: "user" }, JWT_SECRET)).token;
    const linked = await postJson(
      "/api/feedback",
      {
        category: "response",
        description: "短",
        request_id: "trace-feedback-1",
        session_id: "feedback-session",
      },
      { Authorization: `Bearer ${access}` },
    );
    assert.equal(linked.status, 200, JSON.stringify(linked.json));

    const rows = await query<{
      user_id: string | null;
      description: string;
      request_id: string | null;
    }>(
      "SELECT user_id::text AS user_id,description,request_id FROM feedback ORDER BY id",
    );
    assert.deepEqual(rows.rows, [
      { user_id: null, description: "好", request_id: null },
      { user_id: userId, description: "短", request_id: "trace-feedback-1" },
    ]);
  });

  test("admin response-ratings source defaults explicit, supports implicit/all, rejects unknown", async (t) => {
    if (skipIfMissing(t)) return;
    const insertedAdmin = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, email_verified, role)
       VALUES ('ratings-admin@example.com', 'x', true, 'admin') RETURNING id::text AS id`,
    );
    const adminId = insertedAdmin.rows[0].id;
    const insertedUser = await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,email_verified)
       VALUES ('ratings-user@example.com','x',true)
       RETURNING id::text AS id`,
    );
    const userId = insertedUser.rows[0].id;
    await query(
      `INSERT INTO response_rating
         (user_id, session_id, message_id, trace_id, model, rating, tags, comment)
       VALUES
         ($1::bigint, 's1', 'explicit-message', 'trace-explicit', 'model-a', 'down', ARRAY['不准确'], '显式反馈'),
         ($1::bigint, 's1', 'implicit-message', 'trace-implicit', 'model-a', 'down', ARRAY['implicit','中途打断'], '隐式信号')`,
      [userId],
    );
    await query(
      `INSERT INTO response_rating
         (user_id,session_id,message_id,model,rating,tags,comment)
       VALUES ($1::bigint,'s1','admin-noise','model-a','down',ARRAY['不准确'],'管理员噪音')`,
      [adminId],
    );
    const adminToken = (await signAccess({ sub: adminId, role: "admin" }, JWT_SECRET)).token;
    const headers = { Authorization: `Bearer ${adminToken}` };

    const explicit = await getJson("/api/admin/response-ratings", headers);
    assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
    const explicitRows = (explicit.json.down_ratings as { rows: Array<{ comment: string }>; source: string });
    assert.equal(explicitRows.source, "explicit");
    assert.deepEqual(explicitRows.rows.map((row) => row.comment), ["显式反馈"]);

    const implicit = await getJson("/api/admin/response-ratings?source=implicit", headers);
    assert.equal(implicit.status, 200, JSON.stringify(implicit.json));
    const implicitRows = implicit.json.down_ratings as { rows: Array<{ comment: string }>; source: string };
    assert.equal(implicitRows.source, "implicit");
    assert.deepEqual(implicitRows.rows.map((row) => row.comment), ["隐式信号"]);

    const all = await getJson("/api/admin/response-ratings?source=all", headers);
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal((all.json.down_ratings as { rows: unknown[] }).rows.length, 2);

    const invalid = await getJson("/api/admin/response-ratings?source=surprise", headers);
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
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

  test("refresh + logout via HttpOnly cookie (HIGH#4 happy path)", async (t) => {
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
    assert.equal(lr.status, 200);
    // body 不再回吐 refresh_token —— JS 拿不到才挡得住 XSS。
    assert.equal(
      lr.json.refresh_token,
      undefined,
      "login body must NOT carry refresh_token after HIGH#4",
    );
    const setCookies = lr.headers.getSetCookie();
    const cookie = parseSetCookie(setCookies, "oc_rt");
    assert.ok(cookie, "login must Set-Cookie oc_rt");
    assert.ok(cookie.flags.has("httponly"), "oc_rt must be HttpOnly");
    assert.equal(cookie.attrs["samesite"], "Strict");
    assert.equal(cookie.attrs["path"], "/api/auth");
    assert.ok(cookie.attrs["max-age"], "Max-Age must be set");
    // refreshCookieSecure=false 路径(http test) → 不应该有 Secure flag
    assert.equal(cookie.flags.has("secure"), false);
    const cookieHeader = `oc_rt=${encodeURIComponent(cookie.value)}`;

    // refresh 仅靠 cookie,body 不带任何东西
    const r1 = await postJson("/api/auth/refresh", undefined, { Cookie: cookieHeader });
    assert.equal(r1.status, 200);
    assert.ok(r1.json.access_token);

    // logout 同样仅靠 cookie + 必须返回一个清 cookie 指令(Max-Age=0)
    const lo = await postJson("/api/auth/logout", undefined, { Cookie: cookieHeader });
    assert.equal(lo.status, 200);
    assert.equal(lo.json.revoked, true);
    const clearCookie = parseSetCookie(lo.headers.getSetCookie(), "oc_rt");
    assert.ok(clearCookie, "logout must emit a clearing Set-Cookie");
    assert.equal(clearCookie.attrs["max-age"], "0", "clear cookie Max-Age must be 0");

    // logout 后用同 cookie 再 refresh → server 拒(refresh_tokens row 已删/吊销)
    const r2 = await postJson("/api/auth/refresh", undefined, { Cookie: cookieHeader });
    assert.equal(r2.status, 401);
  });

  test("refresh via legacy body (HIGH#4 migration window)", async (t) => {
    if (skipIfMissing(t)) return;
    await postJson("/api/auth/register", {
      email: "legacy-frank@example.com",
      password: "legacy good password",
      turnstile_token: "tok",
    });
    const lr = await postJson("/api/auth/login", {
      email: "legacy-frank@example.com",
      password: "legacy good password",
      turnstile_token: "tok",
    });
    assert.equal(lr.status, 200);
    // 老前端不会读 cookie,但我们能从测试侧拿到 raw refresh token。
    // 模拟"老用户 localStorage 里残留 refresh token"提交 body 而不带 cookie。
    const cookie = parseSetCookie(lr.headers.getSetCookie(), "oc_rt");
    assert.ok(cookie);
    const rawRefresh = cookie.value;

    const r1 = await postJson("/api/auth/refresh", { refresh_token: rawRefresh });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    // 迁移期 server 顺手把 cookie 种回来 — 下次浏览器就有 cookie,不再走 body
    const upgradedCookie = parseSetCookie(r1.headers.getSetCookie(), "oc_rt");
    assert.ok(upgradedCookie, "legacy body refresh must auto-upgrade by Set-Cookie");
    assert.ok(upgradedCookie.flags.has("httponly"));
    assert.equal(upgradedCookie.attrs["samesite"], "Strict");

    // logout 也得接受 legacy body
    const lo = await postJson("/api/auth/logout", { refresh_token: rawRefresh });
    assert.equal(lo.status, 200);
    assert.equal(lo.json.revoked, true);
  });

  test("refresh without cookie or body → 400 VALIDATION", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await postJson("/api/auth/refresh", undefined);
    assert.equal(r.status, 400);
    assert.equal((r.json.error as Record<string, unknown>).code, "VALIDATION");
  });

  test("A6: verify-email per-email rate limit caps total attempts on a single mailbox", async (t) => {
    if (skipIfMissing(t)) return;
    // 紧限流 server:IP 维度放松到 100/min(便于不被 IP 桶先打死),
    // email 维度紧到 3/30min,验证 4 次同邮箱(无论大小写)都计入同桶。
    const tight = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis!),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      rateLimits: {
        // IP 桶留宽,确保不是 IP 桶先 429 — 否则就测不到 email 桶
        verifyEmail: { scope: "verify_email_smoke_ip", windowSeconds: 60, max: 100 },
        // 把 email 桶钳到 3,4th 就该 429
        verifyEmailEmail: { scope: "verify_email_smoke_email", windowSeconds: 1800, max: 3 },
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
      const url = `http://127.0.0.1:${tightAddr}/api/auth/verify-email`;
      const sendVerify = (email: string, code: string) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
      const sendBadShape = () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 缺 code 字段,handler 应在 email 限流之前 throw VALIDATION
          body: JSON.stringify({ email: "a6-target@example.com" }),
        });
      // Codex 建议补:body shape 校验 不能 消耗 email 桶。先打 5 次缺字段
      // 请求(超过 max=3),仍允许后续 3 次合法 shape 通过 email 桶 —— 证明
      // 限流顺序是 IP → body 校验 → email,空 body 不进 email 桶。
      for (let i = 0; i < 5; i++) {
        const r = await sendBadShape();
        assert.equal(r.status, 400, `bad-shape #${i + 1} expected 400, got ${r.status}`);
      }
      // 前 3 次(大小写混合 + 前后空格,验证 trim+lowercase 归一化)都过限流
      // → 业务层 VerifyError(无 pending verification),返 400 INVALID_CODE 之类。
      const variants = [
        "a6-target@example.com",
        "A6-Target@Example.com",
        "  A6-TARGET@example.COM  ", // Codex 建议补:验证 trim() 归一化
      ];
      for (let i = 0; i < 3; i++) {
        const r = await sendVerify(variants[i], "000000");
        assert.notEqual(r.status, 429, `attempt ${i + 1} should not be rate-limited`);
        assert.notEqual(r.status, 200, `attempt ${i + 1} should fail business validation`);
      }
      // 第 4 次同邮箱(原始 lowercase)应 429 — 证明跨大小写/空格共享桶
      const r4 = await sendVerify("a6-target@example.com", "000000");
      assert.equal(r4.status, 429, "4th attempt on same email (any case/whitespace) must be rate-limited");
      assert.ok(r4.headers.get("retry-after"));
      // rate_limit_events 落库:scope=verify_email_smoke_email,key=sha256 前缀
      // (绝不是明文 email)
      const ev = await query<{ key: string }>(
        "SELECT key FROM rate_limit_events WHERE scope = $1 AND blocked = TRUE",
        ["verify_email_smoke_email"],
      );
      assert.equal(ev.rows.length, 1, "exactly 1 blocked event");
      const id = ev.rows[0].key;
      assert.match(id, /^[0-9a-f]{16}$/, `key must be 16-hex sha256 prefix, got: ${id}`);
      assert.ok(!id.includes("@"), "key must not contain plaintext email");
    } finally {
      await new Promise<void>((resolve) => tightServer.close(() => resolve()));
    }
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

  // ─── 邮箱域名黑名单 — HTTP 端到端接线(2026-05-22)────────────────────
  //
  // auth 层(register.integ / verify.integ)已锁住 isEmailDomainBlocked + 注入
  // 路径的纯函数行为。这里再补两条 HTTP 级用例,专门证明:
  //   - handler 真的读 system_settings.register_email_domain_blocklist
  //   - 真的把它作为 deps 传给 register() / verifyEmail()
  //   - RegisterError/VerifyError("EMAIL_DOMAIN_BLOCKED") 被映射成 400 + 标准 error.code
  //
  // 没有这两条用例,handlers.ts 里"接 setting → 注 deps"那段接线可以悄悄
  // 退化(比如忘读 setting / 传错 key)而 auth 层单测全绿。

  test("HTTP register reads system_settings blocklist → 400 EMAIL_DOMAIN_BLOCKED + no user row", async (t) => {
    if (skipIfMissing(t)) return;
    try {
      // 1) 先注册一个真用户充当 admin(setSystemSetting 走的 admin_audit
      //    FK 指向 users(id),不能凭空用一个不存在的 id)
      const adminReg = await postJson("/api/auth/register", {
        email: "admin-setter-reg@example.com",
        password: "admin good password 1",
        turnstile_token: "tok",
      });
      assert.equal(adminReg.status, 201, JSON.stringify(adminReg.json));
      const adminId = BigInt(adminReg.json.user_id as string);

      // 2) admin 写入黑名单。用合成域名而不是 DEFAULTS 里的真实垃圾邮箱域,
      //    避免与"行不存在 → 走 DEFAULTS"的兜底语义混在一起。
      await setSystemSetting(
        "register_email_domain_blocklist",
        ["tempmail-http-integ.test"],
        { adminId, ip: "127.0.0.1", userAgent: "integ-test" },
      );

      // 3) 用该域名 register → handler 必须读到上面写入的规则并拦下
      const r = await postJson("/api/auth/register", {
        email: "abuse@tempmail-http-integ.test",
        password: "abuse good password 1",
        turnstile_token: "tok",
      });
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(
        (r.json.error as Record<string, unknown>).code,
        "EMAIL_DOMAIN_BLOCKED",
        "HTTP error.code 必须透出 EMAIL_DOMAIN_BLOCKED",
      );

      // 4) 副作用:users 表无该 email 行(拦截在 hashPassword/INSERT 之前)
      const u = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM users WHERE email = $1",
        ["abuse@tempmail-http-integ.test"],
      );
      assert.equal(u.rows[0].cnt, "0", "blocked register 不应落用户行");
    } finally {
      // beforeEach 不 TRUNCATE system_settings → 必须显式清,免得污染后续 case
      await query(
        "DELETE FROM system_settings WHERE key = 'register_email_domain_blocklist'",
      );
    }
  });

  test("HTTP verify-email reads system_settings blocklist → 400 + no code consume / no bonus", async (t) => {
    if (skipIfMissing(t)) return;
    try {
      // 1) 空 blocklist 下注册存量用户 stash@http-disposable.test → 拿到验证码
      //    (这步成功必要,否则后续 verify 拿不到 pending 行)
      const stashReg = await postJson("/api/auth/register", {
        email: "stash@http-disposable.test",
        password: "stash good password 1",
        turnstile_token: "tok",
      });
      assert.equal(stashReg.status, 201, JSON.stringify(stashReg.json));
      const userId = stashReg.json.user_id as string;
      // mailer 由 beforeEach 清空 → mailer.sent[0] 一定是 stash 那封注册码邮件
      const stashMail = mailer.sent.find(
        (m) => m.to === "stash@http-disposable.test",
      );
      assert.ok(stashMail, "test setup: stash verify mail not captured");
      const code = stashMail.text.match(/\n {4}(\d{6})\n/)?.[1];
      assert.ok(code, "test setup: verify code not captured from mail body");

      // 2) 注册 admin 拿 user_id 当 admin_audit FK 持有者
      const adminReg = await postJson("/api/auth/register", {
        email: "admin-setter-verify@example.com",
        password: "admin good password 2",
        turnstile_token: "tok",
      });
      assert.equal(adminReg.status, 201, JSON.stringify(adminReg.json));
      const adminId = BigInt(adminReg.json.user_id as string);

      // 3) admin 把 stash 的域加入黑名单
      await setSystemSetting(
        "register_email_domain_blocklist",
        ["http-disposable.test"],
        { adminId, ip: "127.0.0.1", userAgent: "integ-test" },
      );

      // 4) verify-email HTTP → handler 必须读 setting,verifyEmail() 抛
      //    EMAIL_DOMAIN_BLOCKED,handler 映射到 400 + error.code 透传
      const r = await postJson("/api/auth/verify-email", {
        email: "stash@http-disposable.test",
        code,
      });
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(
        (r.json.error as Record<string, unknown>).code,
        "EMAIL_DOMAIN_BLOCKED",
      );

      // 5) 关键副作用断言 — Codex plan review 明确要求:
      //    a) 码 NOT consumed → admin 移规则后用户仍可走完 verify
      //    b) email_verified 仍 false → 没误授信任
      //    c) 没发促销赠金 → 反薅羊毛目标达成
      const ev = await query<{ used_at: string | null }>(
        "SELECT used_at::text AS used_at FROM email_verifications WHERE user_id = $1",
        [userId],
      );
      assert.equal(
        ev.rows[0].used_at,
        null,
        "blocked verify HTTP 不应消费验证码(避免合法用户被永久锁死)",
      );
      const usr = await query<{ email_verified: boolean; credits: string }>(
        "SELECT email_verified, credits::text AS credits FROM users WHERE id = $1",
        [userId],
      );
      assert.equal(
        usr.rows[0].email_verified,
        false,
        "blocked verify HTTP 不应翻 verified",
      );
      assert.equal(
        usr.rows[0].credits,
        "0",
        "blocked verify HTTP 不应发赠金 — 这正是反薅羊毛的目标",
      );
      const led = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1 AND reason = 'promotion'",
        [userId],
      );
      assert.equal(
        led.rows[0].cnt,
        "0",
        "blocked verify HTTP 不应写 promotion ledger 行",
      );
    } finally {
      await query(
        "DELETE FROM system_settings WHERE key = 'register_email_domain_blocklist'",
      );
    }
  });
});

// ─── GET /api/public/config — allow_registration 透传 + 5s cache 验证 ─────
//
// 2026-05-25:handleGetPublicConfig 新增 allow_registration 字段。匿名公开热路径,
// 加 5s in-memory cache 避免每次匿名请求都打 system_settings。这里:
//   1) 锁住 wiring(handler 真的 read getSystemSetting + 写到响应)
//   2) 锁住 cache(改 DB 不重置 cache 时,5s 内仍返旧值;reset 后立即读新值)
describe("commercial HTTP /api/public/config — allow_registration", () => {
  test("exposes allow_registration; cache hides DB flip until reset", async (t) => {
    if (skipIfMissing(t)) return;
    // 1) 设 row = true,reset cache → 第一次拉应该是 true
    await query(
      `INSERT INTO system_settings(key, value, updated_at)
       VALUES ('allow_registration', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
    );
    _resetAllowRegistrationCacheForTests();
    const r1 = await getJson("/api/public/config");
    assert.equal(r1.status, 200);
    assert.equal(r1.json.allow_registration, true, "row=true → 响应应 true");

    // 2) DB 翻 false 但不 reset cache → 5s 内仍读到旧值 true(锁住 cache 行为)
    await query(
      `UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'allow_registration'`,
    );
    const r2 = await getJson("/api/public/config");
    assert.equal(r2.json.allow_registration, true, "cache 未失效时应仍返旧值");

    // 3) reset cache → 读新值 false
    _resetAllowRegistrationCacheForTests();
    const r3 = await getJson("/api/public/config");
    assert.equal(r3.json.allow_registration, false, "cache 重置后应反映新值");

    // 4) 还原 row=true + reset(免得污染后续依赖 register 端点的 case)
    await query(
      `UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'allow_registration'`,
    );
    _resetAllowRegistrationCacheForTests();
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
