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
import { confirmPasswordReset, requestPasswordReset } from "../auth/verify.js";
import { patchUser } from "../admin/users.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

/**
 * T-14 集成:登录 + Refresh + Logout 端到端打通真 Postgres。
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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
  await resetTestSchemaForTest();
  await runMigrations();
  // 预热 dummy hash 一次性,后面测试看到的 timing 才公平
  await warmupLoginDummyHash();
});

after(async () => {
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* ignore */ }
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

async function requestResetToken(email: string): Promise<string> {
  const mailer = new CapturingMailer();
  await requestPasswordReset(email, {
    mailer,
    resetUrlBase: "https://claudeai.chat",
  });
  const raw = mailer.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
  if (!raw) throw new Error("test setup:reset URL not captured");
  return raw;
}

async function waitForAdvisoryWait(queryPattern: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const waiting = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query ILIKE $1`,
      [queryPattern],
    );
    if (Number(waiting.rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for PostgreSQL advisory lock:${queryPattern}`);
}

async function installRefreshInsertBarrier(
  target: { familyId?: string; userId?: string },
  lockKey: string,
): Promise<{
  waitUntilRefreshInsertBlocked: () => Promise<void>;
  waitUntilFamilyMutationBlocked: () => Promise<void>;
  release: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  await query("DROP TRIGGER IF EXISTS auth_refresh_insert_barrier_trigger ON refresh_tokens");
  await query("DROP FUNCTION IF EXISTS auth_refresh_insert_barrier_fn()");
  await query("DROP TABLE IF EXISTS auth_refresh_insert_barrier");
  await query(
    `CREATE TABLE auth_refresh_insert_barrier (
       family_id uuid,
       user_id bigint,
       lock_key bigint NOT NULL
     )`,
  );
  await query(
    `INSERT INTO auth_refresh_insert_barrier(family_id, user_id, lock_key)
     VALUES ($1::uuid, $2::bigint, $3::bigint)`,
    [target.familyId ?? null, target.userId ?? null, lockKey],
  );
  await query(
    `CREATE FUNCTION auth_refresh_insert_barrier_fn() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
     DECLARE barrier_key bigint;
     BEGIN
       SELECT lock_key INTO barrier_key
         FROM auth_refresh_insert_barrier
        WHERE (family_id IS NULL OR family_id = NEW.family_id)
          AND (user_id IS NULL OR user_id = NEW.user_id);
       IF barrier_key IS NOT NULL THEN
         PERFORM pg_advisory_xact_lock(barrier_key);
       END IF;
       RETURN NEW;
     END
     $fn$`,
  );
  await query(
    `CREATE TRIGGER auth_refresh_insert_barrier_trigger
       BEFORE INSERT ON refresh_tokens
       FOR EACH ROW EXECUTE FUNCTION auth_refresh_insert_barrier_fn()`,
  );

  const blockerPool = createPool({
    connectionString: TEST_DB_URL,
    max: 1,
    statementTimeoutMs: 30_000,
  });
  const blocker = await blockerPool.connect();
  await blocker.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
  let released = false;

  return {
    waitUntilRefreshInsertBlocked: () => waitForAdvisoryWait("%INSERT INTO refresh_tokens%"),
    waitUntilFamilyMutationBlocked: () =>
      waitForAdvisoryWait("SELECT pg_advisory_xact_lock(hashtextextended%"),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
      } finally {
        blocker.release();
        await blockerPool.end();
      }
    },
    cleanup: async () => {
      await query("DROP TRIGGER IF EXISTS auth_refresh_insert_barrier_trigger ON refresh_tokens");
      await query("DROP FUNCTION IF EXISTS auth_refresh_insert_barrier_fn()");
      await query("DROP TABLE IF EXISTS auth_refresh_insert_barrier");
    },
  };
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

  test("successful login bootstraps free subscription before the response and stays idempotent", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId } = await setupUser("bootstrap@example.com", "bootstrap password");

    const first = await login(
      { email: "bootstrap@example.com", password: "bootstrap password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const second = await login(
      { email: "bootstrap@example.com", password: "bootstrap password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );

    assert.equal(first.user.credits, "300", "login response must not depend on a later /api/me call");
    assert.equal(second.user.credits, "300");
    const state = await query<{
      settled: boolean;
      plan_code: string;
      period_credits: string;
      ledger_count: string;
    }>(
      `SELECT u.free_bootstrap_settled AS settled,
              us.plan_code,
              us.period_credits::text AS period_credits,
              (SELECT COUNT(*)::text FROM credit_ledger cl
                WHERE cl.user_id=u.id AND cl.reason='subscription') AS ledger_count
         FROM users u
         JOIN user_subscriptions us ON us.user_id=u.id
        WHERE u.id=$1`,
      [userId],
    );
    assert.deepEqual(state.rows[0], {
      settled: true,
      plan_code: "free",
      period_credits: "300",
      ledger_count: "1",
    });
  });

  test("replacement login revokes a stale cookie's whole rotated family", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("old-tab@example.com", "old tab password");
    await setupUser("new-tab@example.com", "new tab password");
    const oldLogin = await login(
      { email: "old-tab@example.com", password: "old tab password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.5", userAgent: "browser" },
    );
    // Model a refresh response whose Set-Cookie is still in flight while the
    // other tab starts a replacement login carrying the original cookie.
    const lateRefresh = await refresh(oldLogin.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.5",
      userAgent: "browser",
    });
    const newLogin = await login(
      { email: "new-tab@example.com", password: "new tab password", turnstile_token: "tok" },
      {
        jwtSecret: JWT_SECRET,
        turnstileBypass: true,
        remoteIp: "10.0.0.5",
        userAgent: "browser",
        replaceRefreshToken: oldLogin.refresh_token,
      },
    );

    await assert.rejects(
      refresh(lateRefresh.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.5",
        userAgent: "browser",
      }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
    const validNewIdentity = await refresh(newLogin.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.5",
      userAgent: "browser",
    });
    const claims = await verifyAccess(validNewIdentity.access_token, JWT_SECRET);
    assert.equal(claims.sub, newLogin.user.id);
  });

  test("replacement login waits for descendant rotation and revokes the late token", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("concurrent-old@example.com", "concurrent old password");
    await setupUser("concurrent-new@example.com", "concurrent new password");
    const oldLogin = await login(
      { email: "concurrent-old@example.com", password: "concurrent old password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.8", userAgent: "browser" },
    );
    const firstDescendant = await refresh(oldLogin.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.8",
      userAgent: "browser",
    });
    const family = await query<{ family_id: string }>(
      "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash=$1",
      [refreshTokenHash(oldLogin.refresh_token)],
    );
    const barrier = await installRefreshInsertBarrier(
      { familyId: family.rows[0].family_id },
      "9151001",
    );
    let descendantPromise: ReturnType<typeof refresh> | null = null;
    let replacementPromise: ReturnType<typeof login> | null = null;
    try {
      descendantPromise = refresh(firstDescendant.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.8",
        userAgent: "browser",
      });
      await barrier.waitUntilRefreshInsertBlocked();

      replacementPromise = login(
        { email: "concurrent-new@example.com", password: "concurrent new password", turnstile_token: "tok" },
        {
          jwtSecret: JWT_SECRET,
          turnstileBypass: true,
          remoteIp: "10.0.0.8",
          userAgent: "browser",
          replaceRefreshToken: oldLogin.refresh_token,
        },
      );
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateDescendant, newLogin] = await Promise.all([descendantPromise, replacementPromise]);
      await assert.rejects(
        refresh(lateDescendant.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.8",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      const validNewIdentity = await refresh(newLogin.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.8",
        userAgent: "browser",
      });
      assert.equal((await verifyAccess(validNewIdentity.access_token, JWT_SECRET)).sub, newLogin.user.id);
    } finally {
      await barrier.release();
      await Promise.allSettled([descendantPromise, replacementPromise].filter(Boolean));
      await barrier.cleanup();
    }
  });

  test("verified old-password login cannot escape a concurrent password reset", async (t) => {
    if (skipIfNoPg(t)) return;
    const email = "login-reset-race@example.com";
    const oldPassword = "login reset old password";
    const { userId } = await setupUser(email, oldPassword);
    const resetToken = await requestResetToken(email);
    const barrier = await installRefreshInsertBarrier({ userId }, "9151003");
    let loginPromise: ReturnType<typeof login> | null = null;
    let resetPromise: ReturnType<typeof confirmPasswordReset> | null = null;
    try {
      loginPromise = login(
        { email, password: oldPassword, turnstile_token: "tok" },
        { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.10", userAgent: "browser" },
      );
      // The INSERT trigger fires only after the old password has been verified
      // and the login transaction owns the user mutation lock.
      await barrier.waitUntilRefreshInsertBlocked();
      resetPromise = confirmPasswordReset(resetToken, "login reset new password");
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateLogin] = await Promise.all([loginPromise, resetPromise]);
      await assert.rejects(
        refresh(lateLogin.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.10",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      const active = await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      assert.equal(active.rows[0].count, "0");
    } finally {
      await barrier.release();
      await Promise.allSettled([loginPromise, resetPromise].filter(Boolean));
      await barrier.cleanup();
    }
  });

  test("verified old-password login cannot escape a concurrent admin ban", async (t) => {
    if (skipIfNoPg(t)) return;
    const email = "login-ban-race@example.com";
    const oldPassword = "login ban old password";
    const { userId } = await setupUser(email, oldPassword);
    const { userId: adminId } = await setupUser("login-ban-admin@example.com", "admin password");
    const barrier = await installRefreshInsertBarrier({ userId }, "9151004");
    let loginPromise: ReturnType<typeof login> | null = null;
    let banPromise: ReturnType<typeof patchUser> | null = null;
    try {
      loginPromise = login(
        { email, password: oldPassword, turnstile_token: "tok" },
        { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.11", userAgent: "browser" },
      );
      await barrier.waitUntilRefreshInsertBlocked();
      banPromise = patchUser(userId, { status: "banned" }, { adminId });
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateLogin, banned] = await Promise.all([loginPromise, banPromise]);
      assert.equal(banned.status, "banned");
      await assert.rejects(
        refresh(lateLogin.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.11",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      const active = await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      assert.equal(active.rows[0].count, "0");
    } finally {
      await barrier.release();
      await Promise.allSettled([loginPromise, banPromise].filter(Boolean));
      await barrier.cleanup();
    }
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

// ─── 2026-04-21 LOW:refresh rotation + family + theft detection ─────
//
// Migration 0019 上线后,refresh 每次必须 rotate(旧 row revoked + 新 row
// INSERT,family_id 沿用)。盗用检测:revoked_reason='rotated' 但未到期
// 的 token 被 reuse → 整个 family 全 revoke,reason='theft'。logout 也
// revoke 整个 family,reason='logout'(避免某个 tab 留在飞中)。
describe("auth.refresh rotation (integ, LOW)", () => {
  test("refresh rotates: returns new refresh_token != old, old hash revoked='rotated'", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("nina@example.com", "nina good password");
    const lr = await login(
      { email: "nina@example.com", password: "nina good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const oldHash = refreshTokenHash(lr.refresh_token);

    const rr = await refresh(lr.refresh_token, { jwtSecret: JWT_SECRET });
    assert.ok(rr.refresh_token, "refresh must return a new refresh_token");
    assert.notEqual(rr.refresh_token, lr.refresh_token, "rotation must change the token");
    assert.ok(rr.refresh_exp > Math.floor(Date.now() / 1000), "new refresh_exp in future");

    const oldRow = await query<{ revoked_at: string | null; revoked_reason: string | null; rotated_to_id: string | null }>(
      "SELECT revoked_at::text AS revoked_at, revoked_reason, rotated_to_id::text AS rotated_to_id FROM refresh_tokens WHERE token_hash = $1",
      [oldHash],
    );
    assert.notEqual(oldRow.rows[0].revoked_at, null, "old row must be revoked");
    assert.equal(oldRow.rows[0].revoked_reason, "rotated");
    assert.notEqual(oldRow.rows[0].rotated_to_id, null, "old row should chain to new row");

    const newRow = await query<{ id: string; family_id: string; revoked_at: string | null }>(
      "SELECT id::text AS id, family_id::text AS family_id, revoked_at::text AS revoked_at FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(rr.refresh_token)],
    );
    assert.equal(newRow.rows.length, 1, "new row must exist");
    assert.equal(newRow.rows[0].revoked_at, null, "new row must be active");
    assert.equal(oldRow.rows[0].rotated_to_id, newRow.rows[0].id, "rotated_to_id must point at new row");
  });

  test("family_id is preserved across multiple rotations", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("oliver@example.com", "oliver good password");
    const lr = await login(
      { email: "oliver@example.com", password: "oliver good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const familyOriginal = await query<{ family_id: string }>(
      "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(lr.refresh_token)],
    );
    const family = familyOriginal.rows[0].family_id;

    const r1 = await refresh(lr.refresh_token, { jwtSecret: JWT_SECRET });
    const r2 = await refresh(r1.refresh_token, { jwtSecret: JWT_SECRET });
    const r3 = await refresh(r2.refresh_token, { jwtSecret: JWT_SECRET });

    for (const t of [r1.refresh_token, r2.refresh_token, r3.refresh_token]) {
      const f = await query<{ family_id: string }>(
        "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash = $1",
        [refreshTokenHash(t)],
      );
      assert.equal(f.rows[0].family_id, family, "family_id must be preserved across rotations");
    }
  });

  test("reuse old (rotated) refresh OUTSIDE grace → INVALID_REFRESH + WHOLE family revoked='theft'", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("paul@example.com", "paul good password");
    const lr = await login(
      { email: "paul@example.com", password: "paul good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const oldRaw = lr.refresh_token;
    const r1 = await refresh(oldRaw, { jwtSecret: JWT_SECRET });
    // 把 oldRaw 行的 revoked_at 推到远古 → 模拟"超出 grace 的真盗用复用"
    await query(
      "UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1",
      [refreshTokenHash(oldRaw)],
    );
    // Now r1.refresh_token is the live one, oldRaw is revoked='rotated' & 1 小时前.
    // Attacker re-uses oldRaw → must mass-revoke entire family.
    let theftFired = false;
    let revokedCountSeen = 0;
    await assert.rejects(
      refresh(oldRaw, {
        jwtSecret: JWT_SECRET,
        onTheftDetected: (ev) => {
          theftFired = true;
          revokedCountSeen = ev.revoked_count;
        },
      }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
    assert.equal(theftFired, true, "onTheftDetected must fire");
    assert.ok(revokedCountSeen >= 1, "theft must mass-revoke ≥1 live row");

    // r1 (the legitimate live token) is now also dead — attacker AND victim
    // both kicked off; victim must re-login.
    await assert.rejects(
      refresh(r1.refresh_token, { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );

    const rows = await query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM refresh_tokens
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
        ORDER BY id`,
      [refreshTokenHash(oldRaw)],
    );
    // At least the formerly-live r1 row must show theft.
    const theftRows = rows.rows.filter((r) => r.revoked_reason === "theft");
    assert.ok(theftRows.length >= 1, "at least one row must be marked theft");
  });

  // 2026-04-21 codex round 1 finding #7 修复回归:多 tab 同时 silent refresh
  // 时,后到的 request 会在 GRACE 内复用刚被 rotated 的 token —— 必须
  // 返回 REFRESH_RACE 而**不**触发 theft + 不 mass-revoke family。
  test("reuse old (rotated) refresh INSIDE grace → REFRESH_RACE, family NOT touched", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("paula-race@example.com", "paula good password");
    const lr = await login(
      { email: "paula-race@example.com", password: "paula good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.1.2.3", userAgent: "race-test-ua" },
    );
    const oldRaw = lr.refresh_token;
    // 第一次 rotation,r1 是新 live token,oldRaw 刚被 revoked='rotated'(刚刚)
    const r1 = await refresh(oldRaw, { jwtSecret: JWT_SECRET, remoteIp: "10.1.2.3", userAgent: "race-test-ua" });

    // 立刻再 reuse oldRaw —— grace 内 + UA/IP 一致,应判 RACE 不是 theft
    let theftFired = false;
    await assert.rejects(
      refresh(oldRaw, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.1.2.3",
        userAgent: "race-test-ua",
        onTheftDetected: () => { theftFired = true; },
      }),
      (err: unknown) =>
        err instanceof RefreshError && err.code === "REFRESH_RACE",
    );
    assert.equal(theftFired, false, "race window must NOT fire theft callback");

    // r1(合法 live token)必须仍能正常 refresh —— family 没有被牵连
    const r2 = await refresh(r1.refresh_token, { jwtSecret: JWT_SECRET, remoteIp: "10.1.2.3", userAgent: "race-test-ua" });
    assert.ok(typeof r2.refresh_token === "string" && r2.refresh_token.length > 0);

    // family 内不应该有任何 'theft' 行
    const rows = await query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM refresh_tokens
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [refreshTokenHash(oldRaw)],
    );
    const theftRows = rows.rows.filter((r) => r.revoked_reason === "theft");
    assert.equal(theftRows.length, 0, "race must not produce any theft-marked rows");
  });

  // R2 finding 加固:grace 窗口内但 UA/IP 不一致 → 视作攻击者从异地 replay,
  // 仍走 theft 路径。哪怕攻击者抢在 10s 内复用,只要 fingerprint 不匹配,
  // family 就被砍。
  test("reuse INSIDE grace 但 UA/IP 不一致 → theft (fingerprint mismatch)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("quincy-fp@example.com", "quincy good password");
    const lr = await login(
      { email: "quincy-fp@example.com", password: "quincy good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.1.2.3", userAgent: "browser-A" },
    );
    const oldRaw = lr.refresh_token;
    await refresh(oldRaw, { jwtSecret: JWT_SECRET, remoteIp: "10.1.2.3", userAgent: "browser-A" });

    // 立刻 reuse oldRaw,但从不同 IP/UA 来 → 不算 race,算 theft
    let theftFired = false;
    await assert.rejects(
      refresh(oldRaw, {
        jwtSecret: JWT_SECRET,
        remoteIp: "1.2.3.4",  // 异地
        userAgent: "evil-ua",
        onTheftDetected: () => { theftFired = true; },
      }),
      (err: unknown) =>
        err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
    assert.equal(theftFired, true, "fingerprint mismatch in grace must still fire theft");
  });

  // R2 finding 加固:grace=0 时关掉 race 行为(同 token 任何复用都视为 theft)
  test("REFRESH_ROTATION_GRACE_SECONDS=0 → 任何 rotated reuse 都判 theft", async (t) => {
    if (skipIfNoPg(t)) return;
    const prev = process.env.REFRESH_ROTATION_GRACE_SECONDS;
    process.env.REFRESH_ROTATION_GRACE_SECONDS = "0";
    try {
      await setupUser("ronan-grace0@example.com", "ronan good password");
      const lr = await login(
        { email: "ronan-grace0@example.com", password: "ronan good password", turnstile_token: "tok" },
        { jwtSecret: JWT_SECRET, turnstileBypass: true },
      );
      const oldRaw = lr.refresh_token;
      await refresh(oldRaw, { jwtSecret: JWT_SECRET });

      // 立刻 reuse — grace=0 应该跳过 race 直接 theft
      let theftFired = false;
      await assert.rejects(
        refresh(oldRaw, {
          jwtSecret: JWT_SECRET,
          onTheftDetected: () => { theftFired = true; },
        }),
        (err: unknown) =>
          err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      assert.equal(theftFired, true, "grace=0 must disable race window entirely");
    } finally {
      if (prev === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
      else process.env.REFRESH_ROTATION_GRACE_SECONDS = prev;
    }
  });

  test("expired+rotated reuse does NOT trigger theft (token natural-dead, no signal)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("quinn@example.com", "quinn good password");
    const lr = await login(
      { email: "quinn@example.com", password: "quinn good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const oldRaw = lr.refresh_token;
    await refresh(oldRaw, { jwtSecret: JWT_SECRET });
    // 强制把 oldRaw 行 expires_at 推过去 → 同时 revoked + expired
    await query(
      "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1",
      [refreshTokenHash(oldRaw)],
    );
    let theftFired = false;
    await assert.rejects(
      refresh(oldRaw, {
        jwtSecret: JWT_SECRET,
        onTheftDetected: () => { theftFired = true; },
      }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
    assert.equal(theftFired, false, "expired token reuse is not a theft signal");
  });

  test("logout-revoked reuse does NOT fire theft (logout is intentional, not stolen)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("rita@example.com", "rita good password");
    const lr = await login(
      { email: "rita@example.com", password: "rita good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    await logout(lr.refresh_token);
    let theftFired = false;
    await assert.rejects(
      refresh(lr.refresh_token, {
        jwtSecret: JWT_SECRET,
        onTheftDetected: () => { theftFired = true; },
      }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
    assert.equal(theftFired, false, "logout-revoked reuse must NOT classify as theft");
  });

  test("logout revokes ENTIRE family (all live rotations across tabs)", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("sam@example.com", "sam good password");
    const lr = await login(
      { email: "sam@example.com", password: "sam good password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true },
    );
    const r1 = await refresh(lr.refresh_token, { jwtSecret: JWT_SECRET });
    const r2 = await refresh(r1.refresh_token, { jwtSecret: JWT_SECRET });
    // r2 是当前 live 的;logout 用任意 family member 都要把整族干掉
    const out = await logout(r1.refresh_token);
    assert.equal(out.revoked, true);
    // r2 现在也应失效
    await assert.rejects(
      refresh(r2.refresh_token, { jwtSecret: JWT_SECRET }),
      (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
    );
  });

  test("logout waits for descendant rotation and revokes the late token", async (t) => {
    if (skipIfNoPg(t)) return;
    await setupUser("concurrent-logout@example.com", "concurrent logout password");
    const original = await login(
      { email: "concurrent-logout@example.com", password: "concurrent logout password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.9", userAgent: "browser" },
    );
    const firstDescendant = await refresh(original.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.9",
      userAgent: "browser",
    });
    const family = await query<{ family_id: string }>(
      "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash=$1",
      [refreshTokenHash(original.refresh_token)],
    );
    const barrier = await installRefreshInsertBarrier(
      { familyId: family.rows[0].family_id },
      "9151002",
    );
    let descendantPromise: ReturnType<typeof refresh> | null = null;
    let logoutPromise: ReturnType<typeof logout> | null = null;
    try {
      descendantPromise = refresh(firstDescendant.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.9",
        userAgent: "browser",
      });
      await barrier.waitUntilRefreshInsertBlocked();

      logoutPromise = logout(original.refresh_token);
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateDescendant, logoutResult] = await Promise.all([descendantPromise, logoutPromise]);
      assert.equal(logoutResult.revoked, true);
      await assert.rejects(
        refresh(lateDescendant.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.9",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
    } finally {
      await barrier.release();
      await Promise.allSettled([descendantPromise, logoutPromise].filter(Boolean));
      await barrier.cleanup();
    }
  });

  test("password reset waits for descendant rotation and revokes the late token", async (t) => {
    if (skipIfNoPg(t)) return;
    const email = "rotation-reset-race@example.com";
    const { userId } = await setupUser(email, "rotation reset old password");
    const resetToken = await requestResetToken(email);
    const original = await login(
      { email, password: "rotation reset old password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.12", userAgent: "browser" },
    );
    const firstDescendant = await refresh(original.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.12",
      userAgent: "browser",
    });
    const family = await query<{ family_id: string }>(
      "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash=$1",
      [refreshTokenHash(original.refresh_token)],
    );
    const barrier = await installRefreshInsertBarrier(
      { familyId: family.rows[0].family_id },
      "9151005",
    );
    let descendantPromise: ReturnType<typeof refresh> | null = null;
    let resetPromise: ReturnType<typeof confirmPasswordReset> | null = null;
    try {
      descendantPromise = refresh(firstDescendant.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.12",
        userAgent: "browser",
      });
      await barrier.waitUntilRefreshInsertBlocked();
      resetPromise = confirmPasswordReset(resetToken, "rotation reset new password");
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateDescendant] = await Promise.all([descendantPromise, resetPromise]);
      await assert.rejects(
        refresh(lateDescendant.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.12",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      const active = await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      assert.equal(active.rows[0].count, "0");
    } finally {
      await barrier.release();
      await Promise.allSettled([descendantPromise, resetPromise].filter(Boolean));
      await barrier.cleanup();
    }
  });

  test("admin ban waits for descendant rotation and revokes the late token", async (t) => {
    if (skipIfNoPg(t)) return;
    const email = "rotation-ban-race@example.com";
    const { userId } = await setupUser(email, "rotation ban password");
    const { userId: adminId } = await setupUser("rotation-ban-admin@example.com", "admin password");
    const original = await login(
      { email, password: "rotation ban password", turnstile_token: "tok" },
      { jwtSecret: JWT_SECRET, turnstileBypass: true, remoteIp: "10.0.0.13", userAgent: "browser" },
    );
    const firstDescendant = await refresh(original.refresh_token, {
      jwtSecret: JWT_SECRET,
      remoteIp: "10.0.0.13",
      userAgent: "browser",
    });
    const family = await query<{ family_id: string }>(
      "SELECT family_id::text AS family_id FROM refresh_tokens WHERE token_hash=$1",
      [refreshTokenHash(original.refresh_token)],
    );
    const barrier = await installRefreshInsertBarrier(
      { familyId: family.rows[0].family_id },
      "9151006",
    );
    let descendantPromise: ReturnType<typeof refresh> | null = null;
    let banPromise: ReturnType<typeof patchUser> | null = null;
    try {
      descendantPromise = refresh(firstDescendant.refresh_token, {
        jwtSecret: JWT_SECRET,
        remoteIp: "10.0.0.13",
        userAgent: "browser",
      });
      await barrier.waitUntilRefreshInsertBlocked();
      banPromise = patchUser(userId, { status: "banned" }, { adminId });
      await barrier.waitUntilFamilyMutationBlocked();
      await barrier.release();

      const [lateDescendant, banned] = await Promise.all([descendantPromise, banPromise]);
      assert.equal(banned.status, "banned");
      await assert.rejects(
        refresh(lateDescendant.refresh_token, {
          jwtSecret: JWT_SECRET,
          remoteIp: "10.0.0.13",
          userAgent: "browser",
        }),
        (err: unknown) => err instanceof RefreshError && err.code === "INVALID_REFRESH",
      );
      const active = await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      assert.equal(active.rows[0].count, "0");
    } finally {
      await barrier.release();
      await Promise.allSettled([descendantPromise, banPromise].filter(Boolean));
      await barrier.cleanup();
    }
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
