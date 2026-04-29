import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { register, RegisterError } from "../auth/register.js";
import { verifyPassword } from "../auth/passwords.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

/**
 * T-12 集成测试:注册流程端到端打通真 Postgres。
 *
 * 验收(对应 07-TASKS T-12):
 *   1. 成功注册 → users 出 1 行(email_verified=false), email_verifications 出 1 行
 *      (purpose=verify_email, used_at IS NULL),mailer 被调用一次,正文含验证 URL。
 *   2. 同邮箱重复注册 → RegisterError code=CONFLICT,且数据库不出现第二行 user。
 *   3. 弱密码(<8) → RegisterError code=VALIDATION,无副作用。
 *
 * 全部用 turnstileBypass=true 跳过外部 CF 调用。
 * Mailer 用本地 capture 实现,不污染 stdout。
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

async function cleanCommercialSchema(): Promise<void> {
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`;
  await query(sql);
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

class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** 设为 true 让下一次 send 抛错(测试 mailer 失败的非致命行为) */
  failNext = false;
  async send(msg: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated SMTP outage");
    }
    this.sent.push(msg);
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "Start it: docker compose -f tests/fixtures/docker-compose.test.yml up -d",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // 只清 user 相关表,保留种子(model_pricing/topup_plans),避免每次重跑迁移
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

describe("auth.register (integ)", () => {
  test("happy path: user + email_verifications inserted, mailer called with verify URL", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    const result = await register(
      {
        email: "alice@example.com",
        password: "correct horse battery staple",
        turnstile_token: "ignored-because-bypass",
      },
      {
        mailer,
        turnstileBypass: true,
        verifyEmailUrlBase: "https://claudeai.chat",
      },
    );

    assert.ok(result.user_id);
    assert.equal(result.verify_email_sent, true);

    const u = await query<{
      id: string;
      email: string;
      email_verified: boolean;
      password_hash: string;
      role: string;
      status: string;
    }>(
      "SELECT id::text AS id, email, email_verified, password_hash, role, status FROM users WHERE email = $1",
      ["alice@example.com"],
    );
    assert.equal(u.rows.length, 1);
    assert.equal(u.rows[0].id, result.user_id);
    assert.equal(u.rows[0].email_verified, false);
    assert.equal(u.rows[0].role, "user");
    assert.equal(u.rows[0].status, "active");

    // 2026-04-29 反薅羊毛改造:注册时不再发赠金,credits=0,ledger 0 行。
    // 赠金延后到 verifyEmail 时刻发(防"批量注册不读邮件"的薅羊毛 pipeline)。
    const credRow = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1",
      [result.user_id],
    );
    assert.equal(credRow.rows[0].credits, "0", "register 不再即时发赠金,credits=0");
    const ledRows = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1",
      [result.user_id],
    );
    assert.equal(ledRows.rows[0].cnt, "0", "register 不应写任何 ledger 行");
    // password 真的被 argon2 哈希了
    assert.match(u.rows[0].password_hash, /^\$argon2id\$/);
    assert.equal(
      await verifyPassword("correct horse battery staple", u.rows[0].password_hash),
      true,
    );

    const ev = await query<{
      cnt: string;
      purpose: string;
      used_at: string | null;
    }>(
      `SELECT COUNT(*)::text AS cnt, MIN(purpose) AS purpose, MIN(used_at::text) AS used_at
         FROM email_verifications WHERE user_id = $1`,
      [result.user_id],
    );
    assert.equal(ev.rows[0].cnt, "1");
    assert.equal(ev.rows[0].purpose, "verify_email");
    assert.equal(ev.rows[0].used_at, null);

    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "alice@example.com");
    // 2026-04-23:注册邮件从 link 改为 6 位数字 code。正文必须:
    //   (a) 含 6 位数字验证码(四空格缩进行)
    //   (b) 主动提示检查垃圾邮件箱(boss 明确要求)
    //   (c) 不再出现 http/https 链接(别再留旧模板残骸混淆用户)
    assert.match(mailer.sent[0].text, /\n {4}(\d{6})\n/, "邮件必须含 6 位验证码");
    assert.match(mailer.sent[0].text, /垃圾邮件|Spam/, "邮件必须提示检查垃圾邮箱");
    assert.doesNotMatch(mailer.sent[0].text, /https?:\/\//, "不应再有 URL 链接");
    // 邮件正文中的 raw code 不能等于 DB 里的 token_hash(存的是 sha256 hex)
    const code = mailer.sent[0].text.match(/\n {4}(\d{6})\n/)?.[1] ?? "";
    assert.ok(code.length === 6);
    const hashRow = await query<{ token_hash: string }>(
      "SELECT token_hash FROM email_verifications WHERE user_id = $1",
      [result.user_id],
    );
    assert.notEqual(code, hashRow.rows[0].token_hash, "raw code must not equal stored hash");
  });

  test("email is normalized: trim + toLowerCase before insert", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    await register(
      {
        email: "  Bob@Example.COM  ",
        password: "another good one",
        turnstile_token: "tok",
      },
      { mailer, turnstileBypass: true },
    );
    const u = await query<{ email: string }>("SELECT email FROM users");
    assert.equal(u.rows.length, 1);
    assert.equal(u.rows[0].email, "bob@example.com");
  });

  test("duplicate email → RegisterError code=CONFLICT, no second row inserted", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    await register(
      {
        email: "carol@example.com",
        password: "first password ok",
        turnstile_token: "tok",
      },
      { mailer, turnstileBypass: true },
    );

    await assert.rejects(
      register(
        {
          email: "carol@example.com",
          password: "second password also ok",
          turnstile_token: "tok",
        },
        { mailer, turnstileBypass: true },
      ),
      (err: unknown) =>
        err instanceof RegisterError && err.code === "CONFLICT",
    );

    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM users WHERE email = $1",
      ["carol@example.com"],
    );
    assert.equal(cnt.rows[0].cnt, "1");
    // 也不应留下"幽灵" verification 记录
    const ev = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications",
    );
    assert.equal(ev.rows[0].cnt, "1", "second register must not leave dangling verification");
    // 2026-04-29 反薅羊毛改造后:register 完全不写 ledger,无论第一次还是
    // 第二次(23505 回滚)都不会留 promotion 行。
    const ledCnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE reason = 'promotion'",
    );
    assert.equal(ledCnt.rows[0].cnt, "0", "register 不应写任何 promotion ledger 行");
  });

  test("weak password (<8 chars) → RegisterError code=VALIDATION, no DB writes", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    await assert.rejects(
      register(
        {
          email: "dan@example.com",
          password: "short",
          turnstile_token: "tok",
        },
        { mailer, turnstileBypass: true },
      ),
      (err: unknown) => {
        if (!(err instanceof RegisterError)) return false;
        if (err.code !== "VALIDATION") return false;
        // issues 应该指出 password 字段
        return Array.isArray(err.issues) && err.issues.some((i) => i.path === "password");
      },
    );

    const u = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM users",
    );
    assert.equal(u.rows[0].cnt, "0");
    assert.equal(mailer.sent.length, 0);
  });

  test("invalid email format → RegisterError code=VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    await assert.rejects(
      register(
        {
          email: "not-an-email",
          password: "long enough password",
          turnstile_token: "tok",
        },
        { mailer, turnstileBypass: true },
      ),
      (err: unknown) =>
        err instanceof RegisterError &&
        err.code === "VALIDATION" &&
        Array.isArray(err.issues) &&
        err.issues.some((i) => i.path === "email"),
    );
  });

  test("missing turnstile token → RegisterError code=VALIDATION", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    await assert.rejects(
      register(
        {
          email: "eve@example.com",
          password: "reasonable password",
          turnstile_token: "",
        },
        { mailer, turnstileBypass: true },
      ),
      (err: unknown) =>
        err instanceof RegisterError && err.code === "VALIDATION",
    );
  });

  test("mailer failure does NOT roll back user creation; result.verify_email_sent=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    mailer.failNext = true;
    const result = await register(
      {
        email: "frank@example.com",
        password: "yet another password",
        turnstile_token: "tok",
      },
      { mailer, turnstileBypass: true },
    );
    assert.equal(result.verify_email_sent, false);
    const u = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM users WHERE email = $1",
      ["frank@example.com"],
    );
    assert.equal(u.rows[0].cnt, "1", "user must persist even when mail fails");
    const ev = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM email_verifications",
    );
    assert.equal(ev.rows[0].cnt, "1", "verification token must still be created");
  });

  test("turnstile failure → RegisterError code=TURNSTILE_FAILED, no DB writes", async (t) => {
    if (skipIfNoPg(t)) return;
    const mailer = new CapturingMailer();
    // 不开 bypass,提供一个 fetch 返回 success=false
    const fetchImpl = ((_url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false }), { status: 200 }),
      )) as unknown as typeof fetch;

    await assert.rejects(
      register(
        {
          email: "grace@example.com",
          password: "this is fine",
          turnstile_token: "anything",
        },
        {
          mailer,
          turnstileBypass: false,
          turnstileSecret: "fake-secret",
          fetchImpl,
        },
      ),
      (err: unknown) =>
        err instanceof RegisterError && err.code === "TURNSTILE_FAILED",
    );

    const u = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM users",
    );
    assert.equal(u.rows[0].cnt, "0");
    assert.equal(mailer.sent.length, 0);
  });
});
