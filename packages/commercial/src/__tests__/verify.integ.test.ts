import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { register } from "../auth/register.js";
import {
  verifyEmail,
  requestPasswordReset,
  confirmPasswordReset,
  VerifyError,
} from "../auth/verify.js";
import { verifyPassword } from "../auth/passwords.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

/**
 * T-13 集成测试。
 *
 * 验收(对应 07-TASKS T-13):
 *   1. 正确 token verify 成功;复用同 token 失败;过期 token 失败。
 *   2. 不存在邮箱的 reset 申请返回 accepted=true 且 email_verifications 不长行。
 *   3. confirmPasswordReset 成功后,该用户所有未吊销的 refresh_tokens 全部被 revoke。
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

class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1).",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

/**
 * 注册 + 抓出验证邮件中的 raw token(URL 末尾)。
 * 比直接读 DB 拿 token_hash 更接近真实流程(用户拿到的是 raw token)。
 */
async function registerAndCaptureVerifyToken(email: string, password: string): Promise<{
  userId: string;
  rawToken: string;
}> {
  const mailer = new CapturingMailer();
  const r = await register(
    { email, password, turnstile_token: "tok" },
    {
      mailer,
      turnstileBypass: true,
      verifyEmailUrlBase: "https://claudeai.chat",
    },
  );
  const url = mailer.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
  if (!url) throw new Error("test setup: verify URL not captured");
  return { userId: r.user_id, rawToken: url };
}

describe("auth.verify.verifyEmail (integ)", () => {
  test("happy path: marks user email_verified=true and consumes token", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawToken } = await registerAndCaptureVerifyToken(
      "alice@example.com",
      "good password 1",
    );

    const before = await query<{ ev: boolean }>(
      "SELECT email_verified AS ev FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(before.rows[0].ev, false);

    const r = await verifyEmail(rawToken);
    assert.equal(r.user_id, userId);
    assert.equal(r.newly_verified, true);

    const after = await query<{ ev: boolean }>(
      "SELECT email_verified AS ev FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(after.rows[0].ev, true);

    const ev = await query<{ used_at: string | null }>(
      "SELECT used_at::text AS used_at FROM email_verifications WHERE user_id = $1",
      [userId],
    );
    assert.notEqual(ev.rows[0].used_at, null, "token must be marked used");
  });

  test("token reuse: second call → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { rawToken } = await registerAndCaptureVerifyToken(
      "bob@example.com",
      "good password 2",
    );
    await verifyEmail(rawToken);
    await assert.rejects(
      verifyEmail(rawToken),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("expired token → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawToken } = await registerAndCaptureVerifyToken(
      "carol@example.com",
      "good password 3",
    );
    // 把 expires_at 改到过去 → 模拟过期
    await query(
      "UPDATE email_verifications SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1",
      [userId],
    );
    await assert.rejects(
      verifyEmail(rawToken),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
    const u = await query<{ ev: boolean }>(
      "SELECT email_verified AS ev FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(u.rows[0].ev, false, "user must remain unverified");
  });

  test("garbage token → INVALID_TOKEN (not VALIDATION)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      verifyEmail("totally-not-a-real-token"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("empty token → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      verifyEmail(""),
      (err: unknown) => err instanceof VerifyError && err.code === "VALIDATION",
    );
  });
});

describe("auth.verify.requestPasswordReset (integ)", () => {
  test("existing email: writes reset row + sends mail", async (t) => {
    if (skipIfNoPg(t)) return;
    await registerAndCaptureVerifyToken("dan@example.com", "pwd dan original");

    const mailer = new CapturingMailer();
    const r = await requestPasswordReset("dan@example.com", {
      mailer,
      resetUrlBase: "https://claudeai.chat",
    });
    assert.equal(r.accepted, true);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "dan@example.com");
    assert.match(mailer.sent[0].text, /https:\/\/claudeai\.chat\/reset-password\?token=/);

    const ev = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE purpose = 'reset_password'",
    );
    assert.equal(ev.rows[0].cnt, "1");
  });

  test("non-existing email: accepted=true, NO reset row, NO mail (anti-enumeration)", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    const r = await requestPasswordReset("ghost@example.com", { mailer });
    assert.equal(r.accepted, true);
    assert.equal(mailer.sent.length, 0);
    const ev = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE purpose = 'reset_password'",
    );
    assert.equal(ev.rows[0].cnt, "0");
  });

  test("malformed email: still accepted=true (no oracle)", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    const r = await requestPasswordReset("not-an-email", { mailer });
    assert.equal(r.accepted, true);
    assert.equal(mailer.sent.length, 0);
  });

  test("email is normalized (case-insensitive lookup)", async (t) => {
    if (skipIfNoPg(t)) return;
    await registerAndCaptureVerifyToken("eve@example.com", "pwd eve original");
    const mailer = new CapturingMailer();
    await requestPasswordReset("  EVE@Example.COM  ", { mailer });
    assert.equal(mailer.sent.length, 1, "uppercased email must still find user");
  });
});

describe("auth.verify.confirmPasswordReset (integ)", () => {
  /** 注册 + 申请 reset + 抓 raw reset token */
  async function setupResetFlow(email: string, oldPassword: string): Promise<{
    userId: string;
    rawResetToken: string;
  }> {
    const reg = await registerAndCaptureVerifyToken(email, oldPassword);
    const mailer = new CapturingMailer();
    await requestPasswordReset(email, { mailer, resetUrlBase: "https://claudeai.chat" });
    const url = mailer.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
    if (!url) throw new Error("test setup: reset URL not captured");
    return { userId: reg.userId, rawResetToken: url };
  }

  test("happy path: password updated + reset token consumed + ALL refresh tokens revoked", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawResetToken } = await setupResetFlow(
      "frank@example.com",
      "old password 1",
    );
    // 先种 3 个 refresh_tokens(2 active + 1 already revoked)
    await query(
      `INSERT INTO refresh_tokens(user_id, token_hash, expires_at)
       VALUES ($1, 'h-active-1', NOW() + INTERVAL '30 days'),
              ($1, 'h-active-2', NOW() + INTERVAL '30 days'),
              ($1, 'h-old-revoked', NOW() + INTERVAL '30 days')`,
      [userId],
    );
    await query(
      "UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '1 day' WHERE token_hash = 'h-old-revoked'",
    );

    const r = await confirmPasswordReset(rawResetToken, "new password 1");
    assert.equal(r.user_id, userId);
    assert.equal(r.revoked_refresh_tokens, 2, "should revoke only the 2 active tokens");

    // 密码真的改了
    const u = await query<{ ph: string }>(
      "SELECT password_hash AS ph FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(await verifyPassword("new password 1", u.rows[0].ph), true);
    assert.equal(await verifyPassword("old password 1", u.rows[0].ph), false);

    // reset token 已消费
    const ev = await query<{ used_at: string | null }>(
      "SELECT used_at::text AS used_at FROM email_verifications WHERE purpose = 'reset_password' AND user_id = $1",
      [userId],
    );
    assert.notEqual(ev.rows[0].used_at, null);

    // 所有 active 都被吊销了,old revoked 时间戳没被覆盖
    const rt = await query<{ token_hash: string; revoked_at: string | null }>(
      "SELECT token_hash, revoked_at::text AS revoked_at FROM refresh_tokens WHERE user_id = $1 ORDER BY token_hash",
      [userId],
    );
    assert.equal(rt.rows.length, 3);
    for (const row of rt.rows) {
      assert.notEqual(row.revoked_at, null, `${row.token_hash} should be revoked`);
    }
  });

  test("re-using reset token → INVALID_TOKEN, password not changed twice", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawResetToken } = await setupResetFlow(
      "grace@example.com",
      "old password 2",
    );
    await confirmPasswordReset(rawResetToken, "new password 2");
    await assert.rejects(
      confirmPasswordReset(rawResetToken, "another new password"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
    const u = await query<{ ph: string }>(
      "SELECT password_hash AS ph FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(await verifyPassword("new password 2", u.rows[0].ph), true);
    assert.equal(
      await verifyPassword("another new password", u.rows[0].ph),
      false,
      "second reset must be a no-op",
    );
  });

  test("expired reset token → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawResetToken } = await setupResetFlow(
      "henry@example.com",
      "old password 3",
    );
    await query(
      "UPDATE email_verifications SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1 AND purpose = 'reset_password'",
      [userId],
    );
    await assert.rejects(
      confirmPasswordReset(rawResetToken, "new password 3"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("wrong purpose: verify_email token cannot be used for confirmPasswordReset", async (t) => {
    if (skipIfNoPg(t)) return;
    const { rawToken } = await registerAndCaptureVerifyToken(
      "ivan@example.com",
      "pwd ivan",
    );
    await assert.rejects(
      confirmPasswordReset(rawToken, "new password ivan"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("weak new password → WEAK_PASSWORD, no DB writes", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawResetToken } = await setupResetFlow(
      "judy@example.com",
      "old password 4",
    );
    const before = await query<{ ph: string }>(
      "SELECT password_hash AS ph FROM users WHERE id = $1",
      [userId],
    );
    await assert.rejects(
      confirmPasswordReset(rawResetToken, "short"),
      (err: unknown) => err instanceof VerifyError && err.code === "WEAK_PASSWORD",
    );
    const after = await query<{ ph: string; used_at: string | null }>(
      `SELECT u.password_hash AS ph, ev.used_at::text AS used_at
         FROM users u
         JOIN email_verifications ev ON ev.user_id = u.id AND ev.purpose='reset_password'
        WHERE u.id = $1`,
      [userId],
    );
    assert.equal(after.rows[0].ph, before.rows[0].ph, "password must not be touched");
    assert.equal(after.rows[0].used_at, null, "reset token must remain unconsumed");
  });

  test("empty token → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      confirmPasswordReset("", "good new password"),
      (err: unknown) => err instanceof VerifyError && err.code === "VALIDATION",
    );
  });
});
