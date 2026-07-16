/**
 * 2026-07-16 巡检批:durable 终态有界 GC + retention 注册表扩展的行为断言。
 *
 * 1) gcFinalizeJournal 三分区:
 *    - 非 durable 终态行:入参窗口(既有行为,不回归);
 *    - durable committed:30d 且 usage_records 证据仍在才删(settle 兜底路径靠
 *      usage 证幂等;无证据的 committed 行保留 = 可见异常);
 *    - durable aborted(含永久免单 waiver):90d。
 *    背景:此前 durable 行永不删,每个 codex turn 永久留一行(生产 203 行/两天)。
 *
 * 2) auditRetention 注册表新增两表:
 *    - refresh_tokens:expires_at 过期 30d 才删;revoked 未过期行保留(重用检测依赖);
 *    - admin_alert_outbox:sent/failed 终态行 90d;pending 永不在此删。
 *
 * pg 不可用时 skip(对齐 patrolClaimPartition.integ.test.ts)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  gcFinalizeJournal,
} from "../billing/finalizeJournalReconciler.js";
import { startAuditRetentionSweeper } from "../admin/auditRetention.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const DURABLE = "lossless_turn_tape_v2";
const DAY_MS = 24 * 3_600_000;

let pgAvailable = false;
let userId = "";

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x6b).toString("base64");
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await runMigrations();
  const u = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ('gc-closure@test.local', 'x', 0, 'user', 'active')
     ON CONFLICT (email) DO UPDATE SET status = 'active'
     RETURNING id::text AS id`,
  );
  userId = u.rows[0].id;
});

after(async () => {
  if (!pgAvailable) return;
  try {
    await query("DELETE FROM request_finalize_journal WHERE request_id LIKE 'gcc-%'");
    await query("DELETE FROM usage_records WHERE request_id LIKE 'gcc-%'");
    await query("DELETE FROM refresh_tokens WHERE user_id = $1::bigint", [userId]);
    await query("DELETE FROM admin_alert_outbox WHERE title LIKE 'gcc-%'");
    await query("DELETE FROM admin_alert_channels WHERE label LIKE 'gcc-%'");
  } catch { /* */ }
  await closePool();
  await resetPool();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("DELETE FROM request_finalize_journal WHERE request_id LIKE 'gcc-%'");
  await query("DELETE FROM usage_records WHERE request_id LIKE 'gcc-%'");
  await query("DELETE FROM refresh_tokens WHERE user_id = $1::bigint", [userId]);
  await query("DELETE FROM admin_alert_outbox WHERE title LIKE 'gcc-%'");
});

async function seedJournal(args: {
  requestId: string;
  state: "committed" | "aborted" | "inflight";
  durable: boolean;
  ageDays: number;
}): Promise<void> {
  const ctx = args.durable ? { model: "gpt-5.6-sol", durableBillingRecovery: DURABLE } : { model: "glm-5.2" };
  await query(
    `INSERT INTO request_finalize_journal
       (request_id, user_id, state, ctx, precheck_credits, created_at, updated_at)
     VALUES ($1, $2::bigint, $3, $4::jsonb, 10,
             NOW() - ($5::bigint * INTERVAL '1 day'),
             NOW() - ($5::bigint * INTERVAL '1 day'))`,
    [args.requestId, userId, args.state, JSON.stringify(ctx), String(args.ageDays)],
  );
}

async function seedUsage(requestId: string): Promise<void> {
  await query(
    `INSERT INTO usage_records (user_id, mode, model, price_snapshot, cost_credits, request_id, status)
     VALUES ($1::bigint, 'chat', 'gpt-5.6-sol', '{}'::jsonb, 10, $2, 'success')
     ON CONFLICT DO NOTHING`,
    [userId, requestId],
  );
}

async function journalExists(requestId: string): Promise<boolean> {
  const r = await query("SELECT 1 FROM request_finalize_journal WHERE request_id = $1", [requestId]);
  return (r.rowCount ?? 0) > 0;
}

describe("gcFinalizeJournal durable 终态有界 GC", { concurrency: false }, () => {
  test("三分区各按窗口删;无 usage 证据的 durable committed 保留", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");

    // durable committed 31d + usage → 删
    await seedJournal({ requestId: "gcc-dc-old", state: "committed", durable: true, ageDays: 31 });
    await seedUsage("gcc-dc-old");
    // durable committed 31d 无 usage → 留(可见异常,绝不静默消失)
    await seedJournal({ requestId: "gcc-dc-noproof", state: "committed", durable: true, ageDays: 31 });
    // durable committed 10d + usage → 留(未到 30d)
    await seedJournal({ requestId: "gcc-dc-young", state: "committed", durable: true, ageDays: 10 });
    await seedUsage("gcc-dc-young");
    // durable aborted 91d → 删;10d → 留
    await seedJournal({ requestId: "gcc-da-old", state: "aborted", durable: true, ageDays: 91 });
    await seedJournal({ requestId: "gcc-da-young", state: "aborted", durable: true, ageDays: 10 });
    // 非 durable committed 8d → 删(既有 7d 窗口不回归)
    await seedJournal({ requestId: "gcc-nd-old", state: "committed", durable: false, ageDays: 8 });
    // durable inflight 40d → 任何分区都不碰(inflight 归 reconciler,不归 GC)
    await seedJournal({ requestId: "gcc-inflight", state: "inflight", durable: true, ageDays: 40 });

    const total = await gcFinalizeJournal(7 * DAY_MS, 100);
    assert.equal(total, 3, "应删 durable committed 老行 + durable aborted 老行 + 非 durable 老行");

    assert.equal(await journalExists("gcc-dc-old"), false);
    assert.equal(await journalExists("gcc-dc-noproof"), true, "无 usage 证据的 committed 必须保留");
    assert.equal(await journalExists("gcc-dc-young"), true);
    assert.equal(await journalExists("gcc-da-old"), false);
    assert.equal(await journalExists("gcc-da-young"), true);
    assert.equal(await journalExists("gcc-nd-old"), false);
    assert.equal(await journalExists("gcc-inflight"), true);
  });
});

describe("auditRetention 注册表扩展", { concurrency: false }, () => {
  test("refresh_tokens:过期 30d 删;近期过期/吊销未过期留", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");
    const seedToken = (hash: string, expiresOffsetDays: number, revoked: boolean) =>
      query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at, created_at, family_id, remember_me)
         VALUES ($1::bigint, $2,
                 NOW() + ($3::bigint * INTERVAL '1 day'),
                 CASE WHEN $4 THEN NOW() - INTERVAL '1 day' ELSE NULL END,
                 NOW() - INTERVAL '60 days', gen_random_uuid(), false)`,
        [userId, hash, String(expiresOffsetDays), revoked],
      );
    await seedToken("gcc-expired-old", -31, false); // 过期 31d → 删
    await seedToken("gcc-expired-new", -1, false); // 过期 1d → 留
    await seedToken("gcc-revoked-live", +10, true); // 吊销但未过期 → 留(重用检测)

    const sweeper = startAuditRetentionSweeper({ runOnStart: false });
    const deleted = await sweeper.runNow();
    sweeper.stop();
    assert.ok((deleted.refresh_tokens ?? 0) >= 1, "应至少删掉过期 31d 的死 token");

    const left = await query<{ token_hash: string }>(
      "SELECT token_hash FROM refresh_tokens WHERE user_id = $1::bigint ORDER BY token_hash",
      [userId],
    );
    assert.deepEqual(
      left.rows.map((r) => r.token_hash),
      ["gcc-expired-new", "gcc-revoked-live"],
    );
  });

  test("admin_alert_outbox:sent/failed 终态 90d 删;pending 永不删", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");
    const admin = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, credits, role, status)
       VALUES ('gcc-admin@test.local', 'x', 0, 'admin', 'active')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'
       RETURNING id::text AS id`,
    );
    const ch = await query<{ id: string }>(
      `INSERT INTO admin_alert_channels (admin_id, channel_type, label, enabled, severity_min, event_types, activation_status)
       VALUES ($1::bigint, 'ilink_wechat', 'gcc-ch', TRUE, 'info', '[]'::jsonb, 'active')
       RETURNING id::text AS id`,
      [admin.rows[0].id],
    );
    const seedOutbox = (title: string, status: string, ageDays: number) =>
      query(
        `INSERT INTO admin_alert_outbox (event_type, severity, title, body, payload, channel_id, status, attempts, next_attempt_at, created_at)
         VALUES ('ops.test', 'info', $1, 'b', '{}'::jsonb, $2::bigint, $3, 0, NOW(),
                 NOW() - ($4::bigint * INTERVAL '1 day'))`,
        [title, ch.rows[0].id, status, String(ageDays)],
      );
    await seedOutbox("gcc-sent-old", "sent", 91); // → 删
    await seedOutbox("gcc-failed-old", "failed", 91); // → 删
    await seedOutbox("gcc-sent-new", "sent", 10); // → 留
    await seedOutbox("gcc-pending-old", "pending", 91); // → 留(活跃队列行)

    const sweeper = startAuditRetentionSweeper({ runOnStart: false });
    const deleted = await sweeper.runNow();
    sweeper.stop();
    assert.ok((deleted.admin_alert_outbox ?? 0) >= 2);

    const left = await query<{ title: string }>(
      "SELECT title FROM admin_alert_outbox WHERE title LIKE 'gcc-%' ORDER BY title",
    );
    assert.deepEqual(left.rows.map((r) => r.title), ["gcc-pending-old", "gcc-sent-new"]);
  });
});
