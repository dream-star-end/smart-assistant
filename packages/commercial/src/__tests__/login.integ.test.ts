import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { register } from "../auth/register.js";
import {
  login,
  refresh,
  logout,
  LoginError,
  RefreshError,
  warmupLoginDummyHash,
} from "../auth/login.js";
import { verifyAccess, refreshTokenHash, REFRESH_TOKEN_TTL_SECONDS } from "../auth/jwt.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

/**
 * T-14 集成:登录 + Refresh + Logout 端到端打通真 Postgres。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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

const JWT_SECRET = "x".repeat(64); // ≥32 bytes

class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

async function probe(): Promise<boolean> {
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

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error("Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1).");
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
  // 预热 dummy hash 一次性,后面测试看到的 timing 才公平
  await warmupLoginDummyHash();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function setupUser(email: string, password: string): Promise<{ userId: string }> {
  const mailer = new CapturingMailer();
  const r = await register(
    { email, password, turnstile_token: "tok" },
    { mailer, turnstileBypass: true },
  );
  return { userId: r.user_id };
}

describe("auth.login (integ)", () => {
  test("happy path: returns access+refresh, refresh row inserted with sha256 hash", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("alice@example.com", "alice good password");

    const result = await login(
      {
        email: "alice@example.com",
        password: "alice good password",
        turnstile_token: "tok",
      },
      {
        jwtSecret: JWT_SECRET,
        turnstileBypass: true,
        remoteIp: "10.0.0.5",
        userAgent: "node-test",
      },
    );

    assert.equal(result.user.id, userId);
    assert.equal(result.user.email, "alice@example.com");
    assert.equal(result.user.role, "user");
    assert.equal(result.user.email_verified, false);
    assert.ok(result.access_token);
    assert.ok(result.refresh_token);
    assert.ok(result.access_exp > Math.floor(Date.now() / 1000));

    // access JWT 真的可被 verifyAccess 解
    const claims = await verifyAccess(result.access_token, JWT_SECRET);
    assert.equal(claims.sub, userId);
    assert.equal(claims.role, "user");

    // refresh row 入库,且 token_hash 等于 sha256(raw)
    const expectedHash = refreshTokenHash(result.refresh_token);
    const rt = await query<{
      cnt: string;
      ua: string | null;
      ip: string | null;
      revoked_at: string | null;
    }>(
      "SELECT COUNT(*)::text AS cnt, MAX(user_agent) AS ua, MAX(host(ip)) AS ip, MAX(revoked_at::text) AS revoked_at FROM refresh_tokens WHERE token_hash = $1",
      [expectedHash],
    );
    assert.equal(rt.rows[0].cnt, "1");
    assert.equal(rt.rows[0].ua, "node-test");
    assert.equal(rt.rows[0].ip, "10.0.0.5");
    assert.equal(rt.rows[0].revoked_at, null);
  });

  test("email_verified flag is reflected in user object", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("bob@example.com", "bob good password");
    await query("UPDATE users SET email_verified = TRUE WHERE id = $1", [userId]);

    const r = await login(
      { email: "bob@example.com", password: "bob good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    assert.equal(r.user.email_verified, true);
  });

  test("wrong password → INVALID_CREDENTIALS, no refresh row", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("carol@example.com", "carol good password");
    await assert.rejects(
      login(
        {
          email: "carol@example.com",
          password: "WRONG password",
          turnstile_token: "tok",
        },
        { jwtSecret: JWT_SECRET, turnstileBypass: true },
      ),
      (err: unknown) => err instanceof LoginError && err.code === "INVALID_CREDENTIALS",
    );
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM refresh_tokens",
    );
    assert.equal(cnt.rows[0].cnt, "0");
  });

  test("nonexistent email → INVALID_CREDENTIALS (anti-enumeration)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      login(
        {
          email: "ghost@example.com",
          password: "anything goes here",
          turnstile_token: "tok",
        },
        { jwtSecret: JWT_SECRET, turnstileBypass: true },
      ),
      (err: unknown) => err instanceof LoginError && err.code === "INVALID_CREDENTIALS",
    );
  });

  test("banned user → INVALID_CREDENTIALS (no info leak)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("dan@example.com", "dan good password");
    await query("UPDATE users SET status = 'banned' WHERE id = $1", [userId]);
    await assert.rejects(
      login(
        { email: "dan@example.com", password: "dan good password", turnstile_token: "tok" },
        { jwtSecret: JWT_SECRET, turnstileBypass: true },
      ),
      (err: unknown) => err instanceof LoginError && err.code === "INVALID_CREDENTIALS",
    );
  });

  test("turnstile failure → TURNSTILE_FAILED, no refresh row", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("eve@example.com", "eve good password");
    const fetchImpl = ((_url: string) =>
      Promise.resolve(new Response(JSON.stringify({ success: false }), { status: 200 }))) as unknown as typeof fetch;

    await assert.rejects(
      login(
        { email: "eve@example.com", password: "eve good password", turnstile_token: "x" },
        {
          jwtSecret: JWT_SECRET,
          turnstileBypass: false,
          turnstileSecret: "fake-secret",
          fetchImpl,
        },
      ),
      (err: unknown) => err instanceof LoginError && err.code === "TURNSTILE_FAILED",
    );
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM refresh_tokens",
    );
    assert.equal(cnt.rows[0].cnt, "0");
  });

  test("malformed input → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      login(
        { email: "not-an-email", password: "p", turnstile_token: "" },
        { jwtSecret: JWT_SECRET, turnstileBypass: true },
      ),
      (err: unknown) => err instanceof LoginError && err.code === "VALIDATION",
    );
  });

  test("multiple successful logins create independent refresh rows", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("frank@example.com", "frank good password");
    const r1 = await login(
      { email: "frank@example.com", password: "frank good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const r2 = await login(
      { email: "frank@example.com", password: "frank good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    assert.notEqual(r1.refresh_token, r2.refresh_token);
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM refresh_tokens",
    );
    assert.equal(cnt.rows[0].cnt, "2");
  });
});

describe("auth.refresh (integ)", () => {
  test("happy path: valid refresh → new access for same user", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("grace@example.com", "grace good password");
    const lr = await login(
      { email: "grace@example.com", password: "grace good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );

    const rr = await refresh(lr.refresh_token, { jwtSecret: JWT_SECRET });
    assert.ok(rr.access_token);
    assert.notEqual(rr.access_token, lr.access_token, "new access token expected");
    const claims = await verifyAccess(rr.access_token, JWT_SECRET);
    assert.equal(claims.sub, userId);
  });

  test("expired refresh → INVALID_REFRESH", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("henry@example.com", "henry good password");
    const lr = await login(
      { email: "henry@example.com", password: "henry good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    await query(
      "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1",
      [refreshTokenHash(lr.refresh_token)],
    );
    await assert.rejects(
      refresh(lr.refresh_token, { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
  });

  test("revoked refresh → INVALID_REFRESH", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("ivan@example.com", "ivan good password");
    const lr = await login(
      { email: "ivan@example.com", password: "ivan good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    await logout(lr.refresh_token);
    await assert.rejects(
      refresh(lr.refresh_token, { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
  });

  test("garbage refresh token → INVALID_REFRESH", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      refresh("not-a-real-refresh-token-just-some-base64url-chars", { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
  });

  test("empty refresh → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      refresh("", { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "VALIDATION",
    );
  });

  test("user banned after login → refresh fails INVALID_REFRESH", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("judy@example.com", "judy good password");
    const lr = await login(
      { email: "judy@example.com", password: "judy good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    await query("UPDATE users SET status = 'banned' WHERE id = $1", [userId]);
    await assert.rejects(
      refresh(lr.refresh_token, { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
  });

  test("refresh respects TTL ceiling: expires_at ~ login + 30 days (default)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("kim@example.com", "kim good password");
    const lr = await login(
      { email: "kim@example.com", password: "kim good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const expectedNow = Math.floor(Date.now() / 1000);
    // 允许 +/- 5s 漂移
    assert.ok(
      Math.abs(lr.refresh_exp - (expectedNow + REFRESH_TOKEN_TTL_SECONDS)) < 5,
      `expected refresh_exp ≈ now+${REFRESH_TOKEN_TTL_SECONDS}, got delta ${lr.refresh_exp - expectedNow}`,
    );
  });
});

describe("auth.logout (integ)", () => {
  test("happy path: revokes refresh row, returns revoked=true", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("leo@example.com", "leo good password");
    const lr = await login(
      { email: "leo@example.com", password: "leo good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const out = await logout(lr.refresh_token);
    assert.equal(out.revoked, true);
    const rt = await query<{ revoked_at: string | null }>(
      "SELECT revoked_at::text AS revoked_at FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(lr.refresh_token)],
    );
    assert.notEqual(rt.rows[0].revoked_at, null);
  });

  test("idempotent: second logout returns revoked=false (not error)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("mia@example.com", "mia good password");
    const lr = await login(
      { email: "mia@example.com", password: "mia good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    await logout(lr.refresh_token);
    const second = await logout(lr.refresh_token);
    assert.equal(second.revoked, false);
  });

  test("unknown token → revoked=false (does not error)", async (t) => {
    if (skipIfNoPg(t)) return;
    const out = await logout("totally-unknown-but-syntactically-fine");
    assert.equal(out.revoked, false);
  });

  test("empty token → revoked=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const out = await logout("");
    assert.equal(out.revoked, false);
  });
});
