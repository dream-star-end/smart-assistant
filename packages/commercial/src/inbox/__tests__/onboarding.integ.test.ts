/**
 * onboarding inbox 自动触达集成测试 — 真 PG。
 *
 * 跑法: REQUIRE_TEST_DB=1 npx tsx --test --test-concurrency=1 src/inbox/__tests__/onboarding.integ.test.ts
 *
 * 覆盖:
 *  - R1..R6 各自的触发谓词:符合条件的用户被插入,不符合的不被插入
 *  - 幂等:同一用户同一规则二次 tick 不重发
 *  - dry-run:走完 INSERT 但事务回滚,DB 内不留行
 *  - disabled:enabled=false → ran=false,不查 DB
 *  - 无 admin:resolveSystemAdminId 返 null → ran=false skipReason='no-admin'
 *  - 跨 tick advisory lock 生效(用第二条手动占住 advisory lock 的连接验证)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
  getPool,
} from "../../db/index.js";
import { query } from "../../db/queries.js";
import { runMigrations } from "../../db/migrate.js";
import { runOnboardingTick, _internal } from "../onboarding.js";
import { resetTestSchemaForTest } from "../../__tests__/helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* */ }
    return false;
  }
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
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* */ }
    await closePool();
  }
});

function skip(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

// ─── helpers ──────────────────────────────────────────────────────

async function wipe(): Promise<void> {
  // 谨慎:保留 schema_migrations
  await query("TRUNCATE inbox_message_reads, inbox_messages, agent_audit, agent_containers, agent_subscriptions, request_finalize_journal, orders, usage_records, credit_ledger, claude_accounts, refresh_tokens, email_verifications, oauth_identities, user_preferences, user_remote_hosts, users RESTART IDENTITY CASCADE");
}

interface SeedUserOpts {
  email: string;
  createdAgo?: string; // PG interval, e.g. '2 hours'
  emailVerified?: boolean;
  role?: "user" | "admin";
}

async function seedUser(o: SeedUserOpts): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, email_verified, created_at, updated_at)
     VALUES ($1, '$2b$10$dummyhashfortest_____________________', $2, $3,
             now() - $4::interval, now() - $4::interval)
     RETURNING id::text AS id`,
    [o.email, o.role ?? "user", o.emailVerified ?? false, o.createdAgo ?? "0"],
  );
  return r.rows[0].id;
}

async function insertUsage(
  userId: string,
  mode: "chat" | "agent",
  createdAgo: string = "10 minutes",
): Promise<void> {
  // usage_records 必须有 price_snapshot/cost_credits/request_id/status
  // 用最小合法 row。reason='chat' 的 ledger 行也是必需的(ledger_id 是 nullable 但
  // 我们这里用最简模板,直接 ledger_id=null)。
  await query(
    `INSERT INTO usage_records
       (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        price_snapshot, cost_credits, request_id, status, created_at)
     VALUES ($1::bigint, $2, 'claude-sonnet-test', 100, 100, 0, 0,
             '{"in":1,"out":1}'::jsonb, 1, $3, 'success', now() - $4::interval)`,
    [userId, mode, `req-${userId}-${mode}-${Date.now()}-${Math.random()}`, createdAgo],
  );
}

async function insertExpiredOrder(userId: string, updatedAgo: string): Promise<void> {
  await query(
    `INSERT INTO orders
       (order_no, user_id, provider, amount_cents, credits, status, expires_at, created_at, updated_at)
     VALUES ($1, $2::bigint, 'hupijiao', 1000, 1000, 'expired',
             now() - $3::interval - interval '15 minutes',
             now() - $3::interval - interval '30 minutes',
             now() - $3::interval)`,
    [`ord-${userId}-${Date.now()}-${Math.random()}`, userId, updatedAgo],
  );
}

async function insertPaidOrder(userId: string): Promise<void> {
  await query(
    `INSERT INTO orders
       (order_no, user_id, provider, amount_cents, credits, status, expires_at, paid_at, created_at, updated_at)
     VALUES ($1, $2::bigint, 'hupijiao', 1000, 1000, 'paid',
             now() + interval '1 hour', now(), now(), now())`,
    [`ord-paid-${userId}-${Date.now()}-${Math.random()}`, userId],
  );
}

async function countMessagesByMarker(marker: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inbox_messages WHERE body_md LIKE $1`,
    [`%${marker}%`],
  );
  return Number(r.rows[0].n);
}

async function countMessagesForUser(userId: string, marker: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inbox_messages
      WHERE user_id = $1::bigint AND body_md LIKE $2`,
    [userId, `%${marker}%`],
  );
  return Number(r.rows[0].n);
}

// ─── tests ─────────────────────────────────────────────────────────

describe("onboarding tick", () => {
  beforeEach(async () => {
    if (!pgAvailable) return;
    await wipe();
  });

  test("disabled: tick 立即返回 ran=false 不查 DB", async (t) => {
    if (skip(t)) return;
    const r = await runOnboardingTick({ enabled: false });
    assert.equal(r.ran, false);
    assert.equal(r.skipReason, "disabled");
  });

  test("无 admin 用户时 skipReason=no-admin", async (t) => {
    if (skip(t)) return;
    // 无 admin —— 注入 systemAdminId=null 模拟 resolveSystemAdminId 返 null
    const r = await runOnboardingTick({ enabled: true, systemAdminId: null });
    assert.equal(r.ran, false);
    assert.equal(r.skipReason, "no-admin");
  });

  test("R1: 注册 +30min 内的 active 用户被触达,且仅一次", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u1 = await seedUser({ email: "u1@x.com", createdAgo: "30 minutes" });
    const u2 = await seedUser({ email: "u2@x.com", createdAgo: "2 hours" });   // R1 不抓(>1h)

    const r1 = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r1.ran, true);
    const r1Inserted = r1.results.find((x) => x.rule === "R1")!.inserted;
    assert.equal(r1Inserted, 1, "R1 应只命中 u1");
    assert.equal(await countMessagesForUser(u1, "<!-- ob:R1 -->"), 1);
    assert.equal(await countMessagesForUser(u2, "<!-- ob:R1 -->"), 0);

    // 二次 tick 应幂等 — R1 inserted=0
    const r2 = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r2.results.find((x) => x.rule === "R1")!.inserted, 0);
    assert.equal(await countMessagesForUser(u1, "<!-- ob:R1 -->"), 1);
  });

  test("R2: 注册 +30min..24h 且未验邮箱;已验的不抓", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u_unverified = await seedUser({ email: "u@x.com", createdAgo: "2 hours", emailVerified: false });
    const u_verified = await seedUser({ email: "v@x.com", createdAgo: "2 hours", emailVerified: true });
    const u_too_new = await seedUser({ email: "n@x.com", createdAgo: "10 minutes", emailVerified: false }); // <30min
    const u_too_old = await seedUser({ email: "o@x.com", createdAgo: "26 hours", emailVerified: false });    // >24h

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R2")!.inserted, 1);
    assert.equal(await countMessagesForUser(u_unverified, "<!-- ob:R2 -->"), 1);
    assert.equal(await countMessagesForUser(u_verified, "<!-- ob:R2 -->"), 0);
    assert.equal(await countMessagesForUser(u_too_new, "<!-- ob:R2 -->"), 0);
    assert.equal(await countMessagesForUser(u_too_old, "<!-- ob:R2 -->"), 0);
  });

  test("R3: 注册 +1h..24h 且 0 条 usage_records", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u_silent = await seedUser({ email: "s@x.com", createdAgo: "3 hours" });
    const u_active = await seedUser({ email: "a@x.com", createdAgo: "3 hours" });
    await insertUsage(u_active, "chat");

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R3")!.inserted, 1);
    assert.equal(await countMessagesForUser(u_silent, "<!-- ob:R3 -->"), 1);
    assert.equal(await countMessagesForUser(u_active, "<!-- ob:R3 -->"), 0);
  });

  test("R4: 注册 +24h..7d 且仍未验", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u = await seedUser({ email: "u@x.com", createdAgo: "3 days", emailVerified: false });
    const u_too_old = await seedUser({ email: "o@x.com", createdAgo: "10 days", emailVerified: false });

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R4")!.inserted, 1);
    assert.equal(await countMessagesForUser(u, "<!-- ob:R4 -->"), 1);
    assert.equal(await countMessagesForUser(u_too_old, "<!-- ob:R4 -->"), 0);
  });

  test("R5: 订单过期 +1h..7d,从未付过,DISTINCT 同用户多过期单只发 1 条", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u_targeted = await seedUser({ email: "t@x.com", createdAgo: "1 day" });
    const u_paid = await seedUser({ email: "p@x.com", createdAgo: "1 day" });
    const u_too_recent = await seedUser({ email: "r@x.com", createdAgo: "1 day" });

    // u_targeted: 两个 expired 订单 —— DISTINCT 应只发一条
    await insertExpiredOrder(u_targeted, "3 hours");
    await insertExpiredOrder(u_targeted, "5 hours");
    // u_paid: 既有 expired 又付过 —— 不发
    await insertExpiredOrder(u_paid, "3 hours");
    await insertPaidOrder(u_paid);
    // u_too_recent: expired 才 30 分钟 —— 不发(<1h)
    await insertExpiredOrder(u_too_recent, "30 minutes");

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R5")!.inserted, 1);
    assert.equal(await countMessagesForUser(u_targeted, "<!-- ob:R5 -->"), 1);
    assert.equal(await countMessagesForUser(u_paid, "<!-- ob:R5 -->"), 0);
    assert.equal(await countMessagesForUser(u_too_recent, "<!-- ob:R5 -->"), 0);
  });

  test("R6: 注册 +6h..7d,有 chat 但无 agent usage", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u_chat_only = await seedUser({ email: "c@x.com", createdAgo: "1 day" });
    const u_chat_and_agent = await seedUser({ email: "ca@x.com", createdAgo: "1 day" });
    const u_no_usage = await seedUser({ email: "n@x.com", createdAgo: "1 day" });

    await insertUsage(u_chat_only, "chat");
    await insertUsage(u_chat_and_agent, "chat");
    await insertUsage(u_chat_and_agent, "agent");

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R6")!.inserted, 1);
    assert.equal(await countMessagesForUser(u_chat_only, "<!-- ob:R6 -->"), 1);
    assert.equal(await countMessagesForUser(u_chat_and_agent, "<!-- ob:R6 -->"), 0);
    assert.equal(await countMessagesForUser(u_no_usage, "<!-- ob:R6 -->"), 0);
  });

  test("dryRun: 走完所有 INSERT 但事务回滚,DB 内不留行", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    await seedUser({ email: "u@x.com", createdAgo: "30 minutes" });

    const r = await runOnboardingTick({ enabled: true, dryRun: true, systemAdminId: adminId });
    assert.equal(r.ran, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.results.find((x) => x.rule === "R1")!.inserted, 1, "RETURNING 报告 1 条会被插入");
    // 但 DB 里不应有任何 inbox_messages
    assert.equal(await countMessagesByMarker("<!-- ob:R"), 0);
  });

  test("inactive/banned 用户不被任何 rule 抓到", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    const u_active = await seedUser({ email: "a@x.com", createdAgo: "30 minutes" });
    const u_banned_id = await seedUser({ email: "b@x.com", createdAgo: "30 minutes" });
    await query(`UPDATE users SET status='banned' WHERE id=$1::bigint`, [u_banned_id]);

    const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    assert.equal(r.results.find((x) => x.rule === "R1")!.inserted, 1);
    assert.equal(await countMessagesForUser(u_active, "<!-- ob:R1 -->"), 1);
    assert.equal(await countMessagesForUser(u_banned_id, "<!-- ob:R1 -->"), 0);
  });

  test("advisory lock 排他:第二条连接占住 lock 时,新 tick 报 lock-busy", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    await seedUser({ email: "u@x.com", createdAgo: "30 minutes" });

    // 用独立连接占住 advisory lock(session-level,事务外也保留)
    const blocker = await getPool().connect();
    try {
      const got = await blocker.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::int, $2::int) AS ok`,
        [_internal.LOCK_KEY_HI, _internal.LOCK_KEY_LO],
      );
      assert.equal(got.rows[0].ok, true, "blocker 必须先抢到 lock");

      const r = await runOnboardingTick({ enabled: true, systemAdminId: adminId });
      assert.equal(r.ran, false);
      assert.equal(r.skipReason, "lock-busy");
      assert.equal(await countMessagesByMarker("<!-- ob:R1 -->"), 0);
    } finally {
      try {
        await blocker.query(
          `SELECT pg_advisory_unlock($1::int, $2::int)`,
          [_internal.LOCK_KEY_HI, _internal.LOCK_KEY_LO],
        );
      } catch { /* */ }
      blocker.release();
    }
  });

  test("marker 末尾 trim 与 newline 不破:body_md 不为空且 LIKE 命中", async (t) => {
    if (skip(t)) return;
    const adminId = await seedUser({ email: "admin@x.com", role: "admin" });
    await seedUser({ email: "u@x.com", createdAgo: "30 minutes" });

    await runOnboardingTick({ enabled: true, systemAdminId: adminId });
    const r = await query<{ body_md: string }>(
      `SELECT body_md FROM inbox_messages WHERE body_md LIKE '%<!-- ob:R1 -->%' LIMIT 1`,
    );
    assert.ok(r.rows[0]);
    assert.match(r.rows[0].body_md, /<!-- ob:R1 -->\s*$/);
    assert.ok(r.rows[0].body_md.length > 100, "body 应当包含完整文案");
  });
});
