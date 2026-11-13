import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { setRefreshCookie } from "../http/cookies.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { refreshTokenHash, REFRESH_TOKEN_TTL_SECONDS } from "../auth/jwt.js";
import { warmupLoginDummyHash } from "../auth/login.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { prepareAuthRowResetForTest } from "./helpers/authRows.js";

/**
 * sec-authrefresh (PR #1288) HTTP-level checks: Set-Cookie on normal rotation and on the
 * new reissue path, and the theft paths still clear the cookie. Fake fixtures only.
 * Harness mirrors http.integ.test.ts (real PG + Redis, real createCommercialHandler).
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "w".repeat(64);
const PASSWORD = "sec http fake password";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";

class NullMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> { this.sent.push(msg); }
}

let pgAvailable = false;
let resetAuthRows: (() => Promise<void>) | undefined;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

before(async () => {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); pgAvailable = true; } catch { pgAvailable = false; }
  try { await p.end(); } catch { /* ignore */ }
  if (pgAvailable) {
    await resetPool();
    setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
    await resetTestSchemaForTest();
    await runMigrations();
    resetAuthRows = await prepareAuthRowResetForTest(async (client) => {
      await client.query("DELETE FROM feedback");
      await client.query("DELETE FROM system_settings");
      await client.query("DELETE FROM product_friction_events");
      await client.query("DELETE FROM turn_traces");
    });
    await warmupLoginDummyHash();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try { await r.connect(); await r.ping(); redis = r; } catch { try { r.disconnect(); } catch { /* */ } }
  if (!redis && REQUIRE_TEST_DB) throw new Error("Redis test fixture required");
  if (pgAvailable && redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NullMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      refreshCookieSecure: false, // plain-http test server; Secure is checked on the helper below
      rateLimits: {
        register: { scope: "sec_register_test", windowSeconds: 60, max: 100 },
        login: { scope: "sec_login_test", windowSeconds: 60, max: 100 },
        requestReset: { scope: "sec_request_reset_test", windowSeconds: 60, max: 100 },
        refresh: { scope: "sec_refresh_test", windowSeconds: 60, max: 200 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.statusCode = 404; res.end("not handled"); }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (redis) { try { await redis.flushdb(); } catch { /* */ } await redis.quit(); }
  if (pgAvailable) { try { await resetTestSchemaForTest(); } catch { /* */ } await closePool(); }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  process.env.REFRESH_ROTATION_GRACE_SECONDS = ""; // empty = default 45s
  await resetAuthRows!();
  await query(
    `INSERT INTO system_settings(key, value, updated_at) VALUES ('allow_registration', 'true'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  );
  await redis.flushdb();
});

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

type Cookie = { value: string; attrs: Record<string, string>; flags: Set<string> };
function parseCookie(lines: string[], name: string): Cookie | null {
  for (const line of lines) {
    const segs = line.split(";").map((s) => s.trim());
    const eq = segs[0].indexOf("=");
    if (eq <= 0 || segs[0].slice(0, eq) !== name) continue;
    const attrs: Record<string, string> = {};
    const flags = new Set<string>();
    for (const seg of segs.slice(1)) {
      const k = seg.indexOf("=");
      if (k < 0) flags.add(seg.toLowerCase());
      else attrs[seg.slice(0, k).toLowerCase()] = seg.slice(k + 1);
    }
    return { value: decodeURIComponent(segs[0].slice(eq + 1)), attrs, flags };
  }
  return null;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: r.status, json, cookie: parseCookie(r.headers.getSetCookie(), "oc_rt") };
}

const victimNet = { "X-Forwarded-For": "203.0.113.10", "CF-Connecting-IP": "203.0.113.10" };
const attackerNet = { "X-Forwarded-For": "198.51.100.66", "CF-Connecting-IP": "198.51.100.66" };

async function loginCookie(email: string, remember?: boolean): Promise<string> {
  const reg = await post("/api/auth/register", { email, password: PASSWORD, turnstile_token: "tok" }, victimNet);
  assert.ok(reg.status === 200 || reg.status === 201, `register ${reg.status} ${JSON.stringify(reg.json)}`);
  const lr = await post("/api/auth/login", { email, password: PASSWORD, turnstile_token: "tok", ...(remember === undefined ? {} : { remember }) }, victimNet);
  assert.equal(lr.status, 200, JSON.stringify(lr.json));
  assert.ok(lr.cookie);
  return lr.cookie.value;
}
const cookieHeader = (raw: string) => ({ Cookie: `oc_rt=${encodeURIComponent(raw)}` });

function assertRefreshCookie(c: Cookie | null, persistent: boolean, label: string) {
  assert.ok(c, `${label}: Set-Cookie oc_rt present`);
  assert.ok(c.value.length > 0, `${label}: non-empty value`);
  assert.ok(c.flags.has("httponly"), `${label}: HttpOnly`);
  assert.equal(c.attrs.samesite, "Strict", `${label}: SameSite=Strict`);
  assert.equal(c.attrs.path, "/api/auth", `${label}: Path=/api/auth`);
  assert.equal(c.attrs.domain, undefined, `${label}: host-only`);
  if (persistent) {
    const maxAge = Number(c.attrs["max-age"]);
    assert.ok(Math.abs(maxAge - REFRESH_TOKEN_TTL_SECONDS) <= 10, `${label}: Max-Age≈30d, got ${maxAge}`);
  } else {
    assert.equal(c.attrs["max-age"], undefined, `${label}: session cookie has no Max-Age`);
  }
}
function assertCleared(c: Cookie | null, label: string) {
  assert.ok(c, `${label}: clearing Set-Cookie present`);
  assert.equal(c.value, "");
  assert.equal(c.attrs["max-age"], "0");
  assert.equal(c.attrs.path, "/api/auth");
}

describe("sec-authrefresh HTTP Set-Cookie regression", () => {
  test("H-00 setRefreshCookie default (production) adds Secure; attribute set unchanged", () => {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    setRefreshCookie(res, "fake-token-value", 2592000, { persistent: true });
    const raw = res.getHeader("Set-Cookie");
    const lines = (Array.isArray(raw) ? raw : [String(raw)]).map(String);
    const c = parseCookie(lines, "oc_rt");
    assertRefreshCookie(c, true, "helper");
    assert.ok(c!.flags.has("secure"), "Secure in production default");
  });

  for (const remember of [true, false]) {
    test(`H-01 normal rotation (remember=${remember}) re-sets oc_rt with the same attributes`, async (t) => {
      if (skip(t)) return;
      const x = await loginCookie(`h01-${remember}@example.com`, remember);
      const r = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.json.access_token);
      assert.equal(r.json.remember, remember);
      assertRefreshCookie(r.cookie, remember, "rotation");
      assert.notEqual(r.cookie!.value, x);
    });
  }

  test("H-02 reissue requires the stored CF-Connecting-IP; XFF spoof and a different IP are theft", async (t) => {
    if (skip(t)) return;
    const x = await loginCookie("h02@example.com");
    const y = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    assert.equal(y.status, 200);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '6 hours' WHERE token_hash = $1", [refreshTokenHash(x)]);
    const spoof = await post("/api/auth/refresh", undefined, {
      ...cookieHeader(x),
      "X-Forwarded-For": "203.0.113.10",
      "CF-Connecting-IP": "198.51.100.66",
    });
    assert.equal(spoof.status, 401, JSON.stringify(spoof.json));
    assert.equal((spoof.json.error as Record<string, unknown>).code, "INVALID_REFRESH");
    assertCleared(spoof.cookie, "xff-spoof");

    const x2 = await loginCookie("h02b@example.com");
    const y2 = await post("/api/auth/refresh", undefined, { ...cookieHeader(x2), ...victimNet });
    assert.equal(y2.status, 200);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '6 hours' WHERE token_hash = $1", [refreshTokenHash(x2)]);
    const missing = await post("/api/auth/refresh", undefined, {
      ...cookieHeader(x2),
      "X-Forwarded-For": "203.0.113.10",
    });
    assert.equal(missing.status, 401, JSON.stringify(missing.json));
    assert.equal((missing.json.error as Record<string, unknown>).code, "INVALID_REFRESH");
    assertCleared(missing.cookie, "missing-cf");

    const x3 = await loginCookie("h02c@example.com");
    const y3 = await post("/api/auth/refresh", undefined, { ...cookieHeader(x3), ...victimNet });
    assert.equal(y3.status, 200);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '6 hours' WHERE token_hash = $1", [refreshTokenHash(x3)]);
    const other = await post("/api/auth/refresh", undefined, { ...cookieHeader(x3), ...attackerNet });
    assert.equal(other.status, 401, JSON.stringify(other.json));
    assertCleared(other.cookie, "other-ip");

    const x4 = await loginCookie("h02d@example.com");
    const y4 = await post("/api/auth/refresh", undefined, { ...cookieHeader(x4), ...victimNet });
    assert.equal(y4.status, 200);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '6 hours' WHERE token_hash = $1", [refreshTokenHash(x4)]);
    const z = await post("/api/auth/refresh", undefined, { ...cookieHeader(x4), ...victimNet });
    assert.equal(z.status, 200, `same CF-Connecting-IP reissues: ${JSON.stringify(z.json)}`);
    assert.ok(z.json.access_token);
    assertRefreshCookie(z.cookie, true, "reissue");
    assert.notEqual(z.cookie!.value, y4.cookie!.value);
    const row = await query<{ ip: string | null; client_ip: string | null }>(
      "SELECT host(ip) AS ip, host(client_ip) AS client_ip FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(z.cookie!.value)],
    );
    assert.equal(row.rows[0].ip, "127.0.0.1", "bound ip stays the socket peer");
    assert.equal(row.rows[0].client_ip, "203.0.113.10", "client_ip is CF-Connecting-IP");
    const yReason = await query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(y4.cookie!.value)],
    );
    assert.equal(yReason.rows[0].revoked_reason, "reissued");
  });

  test("H-03 used successor → 401 INVALID_REFRESH, cookie cleared, family dead", async (t) => {
    if (skip(t)) return;
    const x = await loginCookie("h03@example.com");
    const y = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    const z = await post("/api/auth/refresh", undefined, { ...cookieHeader(y.cookie!.value), ...victimNet });
    assert.equal(z.status, 200);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '50 seconds' WHERE token_hash = $1", [refreshTokenHash(x)]);
    const r = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    assert.equal(r.status, 401);
    assert.equal((r.json.error as Record<string, unknown>).code, "INVALID_REFRESH");
    assertCleared(r.cookie, "theft");
    const after = await post("/api/auth/refresh", undefined, { ...cookieHeader(z.cookie!.value), ...victimNet });
    assert.equal(after.status, 401, "live tip revoked with the family");
  });

  test("H-04 UA mismatch with unused successor → 401, cookie cleared, family dead", async (t) => {
    if (skip(t)) return;
    const x = await loginCookie("h04@example.com");
    const y = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '50 seconds' WHERE token_hash = $1", [refreshTokenHash(x)]);
    const r = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet, "User-Agent": "python-requests/2.32" });
    assert.equal(r.status, 401);
    assertCleared(r.cookie, "ua-mismatch");
    const after = await post("/api/auth/refresh", undefined, { ...cookieHeader(y.cookie!.value), ...victimNet });
    assert.equal(after.status, 401);
  });

  test("H-05 within grace → 401 REFRESH_RACE and the cookie is NOT cleared", async (t) => {
    if (skip(t)) return;
    const x = await loginCookie("h05@example.com");
    await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    const r = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    assert.equal(r.status, 401);
    assert.equal((r.json.error as Record<string, unknown>).code, "REFRESH_RACE");
    assert.equal(r.cookie, null);
  });

  test("H-06 explicit logout clears the cookie and the old ticket cannot be reissued afterwards", async (t) => {
    if (skip(t)) return;
    const x = await loginCookie("h06@example.com");
    const y = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    const lo = await post("/api/auth/logout", undefined, { ...cookieHeader(y.cookie!.value), ...victimNet });
    assert.equal(lo.status, 200);
    assertCleared(lo.cookie, "logout");
    await query("UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '6 hours' WHERE token_hash = $1 AND revoked_reason = 'rotated'", [refreshTokenHash(x)]);
    const r = await post("/api/auth/refresh", undefined, { ...cookieHeader(x), ...victimNet });
    assert.equal(r.status, 401, "logged-out family must not be resurrected by the reissue path");
    assertCleared(r.cookie, "post-logout");
  });
});
