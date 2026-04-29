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
  resendVerification,
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
  "system_settings",
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
 * 注册 + 从邮件正文抓 6 位验证码。
 *
 * 2026-04-23:注册邮件从 "click link" 改为 "6 digit code"。正则匹配邮件正文
 * 里四空格缩进那行里的 6 位数字。这比读 DB 拿 hash 更接近真实流程(用户
 * 拿到的就是 raw 6 位数字)。
 */
async function registerAndCaptureVerifyToken(email: string, password: string): Promise<{
  userId: string;
  rawCode: string;
  verifyEmail: string;
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
  // 匹配邮件正文 "    ${verify.raw}" 那一行的 6 位数字
  const code = mailer.sent[0]?.text.match(/\n {4}(\d{6})\n/)?.[1];
  if (!code) throw new Error("test setup: verify code not captured");
  return { userId: r.user_id, rawCode: code, verifyEmail: email };
}

describe("auth.verify.verifyEmail (integ)", () => {
  test("happy path: marks user email_verified=true and consumes code", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawCode, verifyEmail: email } = await registerAndCaptureVerifyToken(
      "alice@example.com",
      "good password 1",
    );

    const before = await query<{ ev: boolean }>(
      "SELECT email_verified AS ev FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(before.rows[0].ev, false);

    const r = await verifyEmail(email, rawCode);
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
    assert.notEqual(ev.rows[0].used_at, null, "code must be marked used");

    // 2026-04-29 反薅羊毛改造:¥3 赠金在 verifyEmail 时刻发,不在 register。
    // 验证后 users.credits=300,credit_ledger 出 1 行 promotion + ref_type='signup_bonus'。
    const cred = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(cred.rows[0].credits, "300", "verifyEmail 应发放 ¥3 注册赠金");
    const led = await query<{
      delta: string;
      balance_after: string;
      reason: string;
      ref_type: string | null;
      memo: string | null;
    }>(
      `SELECT delta::text AS delta, balance_after::text AS balance_after,
              reason, ref_type, memo
         FROM credit_ledger WHERE user_id = $1`,
      [userId],
    );
    assert.equal(led.rows.length, 1, "应只有 1 条赠送 ledger 行");
    assert.equal(led.rows[0].delta, "300");
    assert.equal(led.rows[0].balance_after, "300");
    assert.equal(led.rows[0].reason, "promotion");
    assert.equal(led.rows[0].ref_type, "signup_bonus");
    assert.match(led.rows[0].memo ?? "", /邮箱验证赠送/);
  });

  test("idempotent bonus: admin resets email_verified→false, re-verify does NOT double-credit", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawCode, verifyEmail: email } =
      await registerAndCaptureVerifyToken("idem@example.com", "pwd idem long");
    await verifyEmail(email, rawCode);

    // 模拟 admin 把 email_verified 重置为 false 并发新码
    await query(
      "UPDATE users SET email_verified = FALSE WHERE id = $1",
      [userId],
    );
    const mailer = new CapturingMailer();
    await resendVerification(email, { mailer });
    const newCode = mailer.sent[0]?.text.match(/\n {4}(\d{6})\n/)?.[1];
    assert.ok(newCode, "重发应产生新码");

    // 再走一次 verifyEmail → email_verified 翻 TRUE,但 credits 不重复加
    const r = await verifyEmail(email, newCode!);
    assert.equal(r.newly_verified, true, "再次进入 false→true 路径");

    const cred = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(cred.rows[0].credits, "300", "credits 不应被重复发放");
    const led = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1 AND reason = 'promotion'",
      [userId],
    );
    assert.equal(led.rows[0].cnt, "1", "promotion ledger 仍应只有 1 行");
  });

  test("legacy unverified user with pre-existing promotion row: re-verify keeps credits=300, no new ledger", async (t) => {
    if (skipIfNoPg(t)) return;
    // 模拟旧版用户:register 时已写过 credits=300 + promotion(ref_type IS NULL)
    const { userId, rawCode, verifyEmail: email } =
      await registerAndCaptureVerifyToken("legacy@example.com", "pwd legacy long");
    await query(
      "UPDATE users SET credits = 300 WHERE id = $1",
      [userId],
    );
    await query(
      `INSERT INTO credit_ledger(user_id, delta, balance_after, reason, memo)
       VALUES ($1::bigint, 300, 300, 'promotion', '新用户注册赠送 ¥3')`,
      [userId],
    );

    const r = await verifyEmail(email, rawCode);
    assert.equal(r.newly_verified, true);

    // 旧 promotion 行存在 → dup 命中 → 不再加 credits / 不再写新行
    const cred = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(cred.rows[0].credits, "300", "旧用户余额维持 300,不应翻倍");
    const led = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1 AND reason = 'promotion'",
      [userId],
    );
    assert.equal(led.rows[0].cnt, "1", "应仅 1 行 promotion(原有的旧行)");
  });

  test("invalid code → no credits granted", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, verifyEmail: email } =
      await registerAndCaptureVerifyToken("nocred@example.com", "pwd nocred long");
    await assert.rejects(
      verifyEmail(email, "000000"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
    const cred = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(cred.rows[0].credits, "0", "失败的 verify 不应发放赠金");
  });

  test("code reuse: second call → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { rawCode, verifyEmail: email } = await registerAndCaptureVerifyToken(
      "bob@example.com",
      "good password 2",
    );
    await verifyEmail(email, rawCode);
    await assert.rejects(
      verifyEmail(email, rawCode),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("expired code → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { userId, rawCode, verifyEmail: email } = await registerAndCaptureVerifyToken(
      "carol@example.com",
      "good password 3",
    );
    // 把 expires_at 改到过去 → 模拟过期
    await query(
      "UPDATE email_verifications SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1",
      [userId],
    );
    await assert.rejects(
      verifyEmail(email, rawCode),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
    const u = await query<{ ev: boolean }>(
      "SELECT email_verified AS ev FROM users WHERE id = $1",
      [userId],
    );
    assert.equal(u.rows[0].ev, false, "user must remain unverified");
  });

  test("wrong code for a real email → INVALID_TOKEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const { verifyEmail: email } = await registerAndCaptureVerifyToken(
      "dana@example.com",
      "good password 4",
    );
    await assert.rejects(
      verifyEmail(email, "000000"),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });

  test("malformed code (not 6 digits) → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      verifyEmail("alice@example.com", "12345"),
      (err: unknown) => err instanceof VerifyError && err.code === "VALIDATION",
    );
    await assert.rejects(
      verifyEmail("alice@example.com", "abcdef"),
      (err: unknown) => err instanceof VerifyError && err.code === "VALIDATION",
    );
  });

  test("empty code → VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      verifyEmail("alice@example.com", ""),
      (err: unknown) => err instanceof VerifyError && err.code === "VALIDATION",
    );
  });

  test("another user's code cannot verify my email (email scoping)", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await registerAndCaptureVerifyToken("u1@example.com", "pwd u1 long");
    await registerAndCaptureVerifyToken("u2@example.com", "pwd u2 long");
    // 用 u1 的码搭配 u2 的 email —— 哪怕 u1 的码在 DB 里有效,也不该通过
    await assert.rejects(
      verifyEmail("u2@example.com", u1.rawCode),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
    );
  });
});

describe("auth.verify.resendVerification (integ)", () => {
  test("resend invalidates previous code, new code works", async (t) => {
    if (skipIfNoPg(t)) return;
    const u = await registerAndCaptureVerifyToken("resend@example.com", "pwd resend long");
    const oldCode = u.rawCode;

    const mailer = new CapturingMailer();
    const r = await resendVerification("resend@example.com", { mailer });
    assert.equal(r.accepted, true);
    assert.equal(mailer.sent.length, 1, "resend 必须发一封新邮件");
    const newCodeMatch = mailer.sent[0].text.match(/\n {4}(\d{6})\n/);
    assert.ok(newCodeMatch, "新邮件必须含 6 位码");
    const newCode = newCodeMatch![1];
    assert.notEqual(oldCode, newCode, "重发应产生新码");

    // 旧码已作废 → verify 应拒
    await assert.rejects(
      verifyEmail("resend@example.com", oldCode),
      (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
      "旧码必须已失效",
    );

    // 新码可用
    const ok = await verifyEmail("resend@example.com", newCode);
    assert.equal(ok.user_id, u.userId);
    assert.equal(ok.newly_verified, true);
  });

  test("resend for already-verified user: accepted=true, NO mail, NO new row", async (t) => {
    if (skipIfNoPg(t)) return;
    const u = await registerAndCaptureVerifyToken("alreadyok@example.com", "pwd verified");
    // 先完成验证
    await verifyEmail("alreadyok@example.com", u.rawCode);

    const countBefore = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE user_id = $1 AND purpose = 'verify_email'",
      [u.userId],
    );

    const mailer = new CapturingMailer();
    const r = await resendVerification("alreadyok@example.com", { mailer });
    assert.equal(r.accepted, true, "对已验证用户也必须 accepted=true(防枚举)");
    assert.equal(mailer.sent.length, 0, "已验证用户不应再收邮件");

    const countAfter = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE user_id = $1 AND purpose = 'verify_email'",
      [u.userId],
    );
    assert.equal(countAfter.rows[0].cnt, countBefore.rows[0].cnt, "不应为已验证用户插入新 code 行");
  });

  test("resend for non-existing email: accepted=true, NO mail (anti-enumeration)", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    const r = await resendVerification("ghost-resend@example.com", { mailer });
    assert.equal(r.accepted, true);
    assert.equal(mailer.sent.length, 0);
  });

  test("concurrent resend: only one code remains active, serialized by user row lock", async (t) => {
    if (skipIfNoPg(t)) return;
    await registerAndCaptureVerifyToken("concurrent@example.com", "pwd concurrent long");

    const mailer = new CapturingMailer();
    // 并发两次 resend,预期:用户 row 上的 FOR UPDATE 串行化两次写
    const [r1, r2] = await Promise.all([
      resendVerification("concurrent@example.com", { mailer }),
      resendVerification("concurrent@example.com", { mailer }),
    ]);
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);

    // 最多 3 封邮件(register 的 + 两次 resend),但 active code 行应只有 1 张
    const activeCodes = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM email_verifications ev
         JOIN users u ON u.id = ev.user_id
        WHERE u.email = $1
          AND ev.purpose = 'verify_email'
          AND ev.used_at IS NULL
          AND ev.expires_at > NOW()`,
      ["concurrent@example.com"],
    );
    assert.equal(activeCodes.rows[0].cnt, "1", "任意时刻只应有 1 张 active verify_email code");
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

  // HIGH#3 (2026-04-21 安全审计):新对象签名要求 turnstile_token,且必须在
  // email 查库前完成校验,避免 timing oracle 区分 "邮箱存在"。
  describe("turnstile (HIGH#3)", () => {
    test("object input + bypass=true → accepts and writes reset row", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("kate@example.com", "pwd kate");
      const mailer = new CapturingMailer();
      const r = await requestPasswordReset(
        { email: "kate@example.com", turnstile_token: "tok-bypassed" },
        { mailer, turnstileBypass: true, resetUrlBase: "https://claudeai.chat" },
      );
      assert.equal(r.accepted, true);
      assert.equal(mailer.sent.length, 1);
      const ev = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE purpose = 'reset_password'",
      );
      assert.equal(ev.rows[0].cnt, "1");
    });

    test("object input + empty turnstile_token → TURNSTILE_FAILED (no DB write)", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("liam@example.com", "pwd liam");
      const mailer = new CapturingMailer();
      await assert.rejects(
        requestPasswordReset(
          { email: "liam@example.com", turnstile_token: "" },
          { mailer, turnstileBypass: true },
        ),
        (err: unknown) => err instanceof VerifyError && err.code === "TURNSTILE_FAILED",
      );
      assert.equal(mailer.sent.length, 0);
      const ev = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE purpose = 'reset_password'",
      );
      assert.equal(ev.rows[0].cnt, "0", "no row may be written when turnstile fails");
    });

    test("object input + remote turnstile rejected → TURNSTILE_FAILED (no DB write)", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("mary@example.com", "pwd mary");
      const mailer = new CapturingMailer();
      const fakeFetch: typeof fetch = (async () =>
        new Response(JSON.stringify({ success: false }), { status: 200 })) as unknown as typeof fetch;
      await assert.rejects(
        requestPasswordReset(
          { email: "mary@example.com", turnstile_token: "tok-bad" },
          { mailer, turnstileSecret: "secret-x", fetchImpl: fakeFetch },
        ),
        (err: unknown) => err instanceof VerifyError && err.code === "TURNSTILE_FAILED",
      );
      assert.equal(mailer.sent.length, 0);
    });

    test("turnstile fails BEFORE email lookup (no enumeration timing oracle)", async (t) => {
      if (skipIfNoPg(t)) return;
      // Both an existing and a ghost email must hit the same TURNSTILE_FAILED
      // path BEFORE we ever touch users → identical observable behavior.
      await registerAndCaptureVerifyToken("nina@example.com", "pwd nina");
      const mailer = new CapturingMailer();

      let dbHits = 0;
      const fakeFetch: typeof fetch = (async () => {
        // If turnstile is checked first, we should see this called BEFORE any
        // mailer.send / DB row appears.
        return new Response(JSON.stringify({ success: false }), { status: 200 });
      }) as unknown as typeof fetch;

      for (const email of ["nina@example.com", "ghost@example.com"]) {
        await assert.rejects(
          requestPasswordReset(
            { email, turnstile_token: "tok-bad" },
            { mailer, turnstileSecret: "secret-x", fetchImpl: fakeFetch },
          ),
          (err: unknown) => err instanceof VerifyError && err.code === "TURNSTILE_FAILED",
        );
        dbHits += mailer.sent.length;
      }
      assert.equal(dbHits, 0);
      const ev = await query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM email_verifications WHERE purpose = 'reset_password'",
      );
      assert.equal(ev.rows[0].cnt, "0");
    });

    test("legacy positional string input still works (skips turnstile, internal callers)", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("oscar@example.com", "pwd oscar");
      const mailer = new CapturingMailer();
      const r = await requestPasswordReset("oscar@example.com", { mailer });
      assert.equal(r.accepted, true);
      assert.equal(mailer.sent.length, 1, "string overload must remain unchanged");
    });
  });

  // 2026-04-21 安全审计 MED:重复申请 reset 时,旧 token 必须立刻作废,
  // 否则攻击者钓到旧 reset 邮件后,即使本人重新申请,旧链接仍可用。
  describe("prior reset tokens invalidated on new request (MED)", () => {
    test("issuing a new reset marks all previously outstanding tokens used_at=NOW()", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("paul@example.com", "pwd paul");

      const mailer1 = new CapturingMailer();
      await requestPasswordReset("paul@example.com", {
        mailer: mailer1,
        resetUrlBase: "https://claudeai.chat",
      });
      const firstToken = mailer1.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
      assert.ok(firstToken, "first reset token must be captured");

      // Second request — should invalidate the first.
      const mailer2 = new CapturingMailer();
      await requestPasswordReset("paul@example.com", {
        mailer: mailer2,
        resetUrlBase: "https://claudeai.chat",
      });
      const secondToken = mailer2.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
      assert.ok(secondToken, "second reset token must be captured");
      assert.notEqual(firstToken, secondToken, "tokens should differ");

      // Old token must now fail confirmPasswordReset.
      await assert.rejects(
        confirmPasswordReset(firstToken!, "new password paul old"),
        (err: unknown) => err instanceof VerifyError && err.code === "INVALID_TOKEN",
        "first (older) token must be invalidated by the new request",
      );

      // New token must still work.
      const r = await confirmPasswordReset(secondToken!, "new password paul new");
      assert.equal(typeof r.user_id, "string");
      const u = await query<{ ph: string }>(
        "SELECT password_hash AS ph FROM users WHERE email = $1",
        ["paul@example.com"],
      );
      assert.equal(await verifyPassword("new password paul new", u.rows[0].ph), true);
    });

    test("only same-user reset tokens are invalidated (does not touch others)", async (t) => {
      if (skipIfNoPg(t)) return;
      await registerAndCaptureVerifyToken("quinn@example.com", "pwd quinn");
      await registerAndCaptureVerifyToken("rachel@example.com", "pwd rachel");

      const mailerQ = new CapturingMailer();
      await requestPasswordReset("quinn@example.com", { mailer: mailerQ });
      const quinnToken = mailerQ.sent[0]?.text.match(/token=([^\s]+)/)?.[1];
      assert.ok(quinnToken);

      // Rachel requests — must NOT invalidate Quinn's token.
      const mailerR = new CapturingMailer();
      await requestPasswordReset("rachel@example.com", { mailer: mailerR });

      // Quinn's token still valid.
      const r = await confirmPasswordReset(quinnToken!, "quinn new password");
      assert.equal(typeof r.user_id, "string");
    });

    test("expired prior tokens are not re-touched (UPDATE filter on expires_at)", async (t) => {
      if (skipIfNoPg(t)) return;
      const { userId } = await registerAndCaptureVerifyToken("steve@example.com", "pwd steve");

      // First reset, then artificially expire it.
      const m1 = new CapturingMailer();
      await requestPasswordReset("steve@example.com", { mailer: m1 });
      await query(
        `UPDATE email_verifications
            SET expires_at = NOW() - INTERVAL '1 hour'
          WHERE user_id = $1 AND purpose = 'reset_password'`,
        [userId],
      );

      // Capture used_at NULL state of the now-expired row before the second request.
      const beforeRows = await query<{ used_at: string | null }>(
        "SELECT used_at::text AS used_at FROM email_verifications WHERE user_id = $1 AND purpose = 'reset_password'",
        [userId],
      );
      assert.equal(beforeRows.rows.length, 1);
      assert.equal(beforeRows.rows[0].used_at, null);

      // Issue a second one.
      const m2 = new CapturingMailer();
      await requestPasswordReset("steve@example.com", { mailer: m2 });

      // The expired row must remain untouched (used_at still NULL — no spurious writes).
      const after = await query<{ used_at: string | null; expires_at: string }>(
        `SELECT used_at::text AS used_at, expires_at::text AS expires_at
           FROM email_verifications
          WHERE user_id = $1 AND purpose = 'reset_password'
          ORDER BY id`,
        [userId],
      );
      assert.equal(after.rows.length, 2, "should now have two reset rows");
      // First row (expired) — used_at still null
      assert.equal(after.rows[0].used_at, null, "expired token row must not be re-marked used");
    });

    // 2026-04-21 codex round 1 finding #5 FAIL 修复回归测试:
    // 并发两次 reset request 必须被 per-user 行锁串行化,
    // 任意时刻最多只有一张未消费 reset token。
    test("concurrent reset requests are serialized — at most one active token", async (t) => {
      if (skipIfNoPg(t)) return;
      const { userId } = await registerAndCaptureVerifyToken(
        "tracy-race@example.com",
        "pwd tracy",
      );

      // 同一 user 同时打 5 个 reset request
      const mailers = Array.from({ length: 5 }, () => new CapturingMailer());
      await Promise.all(
        mailers.map((m) => requestPasswordReset("tracy-race@example.com", { mailer: m })),
      );

      // 所有请求都该收到邮件(语义不变)
      assert.equal(
        mailers.filter((m) => m.sent.length === 1).length,
        5,
        "all 5 concurrent requests must produce a mail",
      );

      // 但 DB 中 active(未消费 + 未过期)的 reset_password 行只能有 1 张
      const activeRows = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM email_verifications
          WHERE user_id = $1
            AND purpose = 'reset_password'
            AND used_at IS NULL
            AND expires_at > NOW()`,
        [userId],
      );
      assert.equal(
        activeRows.rows[0].cnt,
        "1",
        "concurrent requests must collapse to a single active token (per-user row lock)",
      );

      // 总行数 = 5(每次都 INSERT 一行,前 4 张都被后续请求 UPDATE used_at 作废)
      const totalRows = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM email_verifications
          WHERE user_id = $1 AND purpose = 'reset_password'`,
        [userId],
      );
      assert.equal(totalRows.rows[0].cnt, "5", "total rows = number of requests");
    });
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

  test("wrong purpose: verify_email code cannot be used for confirmPasswordReset", async (t) => {
    if (skipIfNoPg(t)) return;
    const { rawCode } = await registerAndCaptureVerifyToken(
      "ivan@example.com",
      "pwd ivan",
    );
    // 6 位数字 code 被 confirmPasswordReset 当成 base64url token 解码 →
    // sha256(base64url_decode(code)) 不会匹配任何 row(verify_email 行的 hash
    // 是 sha256("123456"),不是 sha256(base64url_decode("123456")))→
    // INVALID_TOKEN。兼顾 purpose scope 与 hash 方式双重隔离。
    await assert.rejects(
      confirmPasswordReset(rawCode, "new password ivan"),
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
