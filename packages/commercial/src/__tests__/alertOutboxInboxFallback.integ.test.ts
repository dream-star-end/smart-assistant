/**
 * 方案 §2.3-1 集成:enqueueAlert 送达不变量 —— inbox 兜底 + critical 镜像。
 *
 * 覆盖:
 *   - 零订阅通道 → inbox_fallback=true,写一条 inbox(uid=1),无 outbox 行
 *   - 通道存在但无人订阅(severity_min 太高)→ 同样兜底
 *   - critical + 订阅通道 → outbox 落行 + 一条 inbox 镜像(inbox_mirror=true)
 *   - critical 重复 enqueue(同 dedupe_key 全去重)→ 不再镜像(inbox_mirror=false,inbox 不增)
 *   - warning + 订阅通道 → 只落 outbox,不写 inbox
 *   - critical 被 silence 抑制(suppressed)→ 仍写镜像(双落点不受 silence 影响)
 *   - enqueueAlertToChannel(测试送达路径)→ 不写 inbox
 *   - inbox 写失败(uid=1 缺失)→ 不抛,inbox_fallback=false
 *
 * pg 不可用时 skip(遵循仓内 REQUIRE_TEST_DB 约定)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { enqueueAlert, enqueueAlertToChannel, type AlertEventInput } from "../admin/alertOutbox.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

/** 造 uid=1 boss(inbox FK 需要);幂等 upsert,不 truncate users。 */
async function ensureBoss(): Promise<void> {
  await query(
    `INSERT INTO users(id, email, password_hash, credits, role, status)
     VALUES (1, 'boss-fallback@test.local', 'stub', 0, 'admin', 'active')
     ON CONFLICT (id) DO UPDATE SET role='admin', status='active'`,
  );
}

/** 造一个可投递、全订阅的 wecom_bot 通道。severity_min 可调。 */
async function insertChannel(opts: { severity_min?: string; event_types?: string; fp: string }): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO admin_alert_channels(
       admin_id, channel_type, label, enabled, severity_min, event_types,
       activation_status, wecom_key_fp, updated_by
     ) VALUES (
       1, 'wecom_bot', 'c', TRUE, $1, $2::jsonb, 'active', $3, 1
     ) RETURNING id::text AS id`,
    [opts.severity_min ?? "info", opts.event_types ?? "[]", opts.fp],
  );
  return r.rows[0].id;
}

async function inboxCount(): Promise<number> {
  const r = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM inbox_messages`);
  return Number(r.rows[0].c);
}
async function outboxCount(): Promise<number> {
  const r = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM admin_alert_outbox`);
  return Number(r.rows[0].c);
}

function critEvent(dedupe?: string): AlertEventInput {
  return {
    event_type: "ops.monitor_check_failed",
    severity: "critical",
    title: "svc_v5 异常",
    body: "❌ svc_v5 inactive",
    dedupe_key: dedupe ?? null,
  };
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 6 }));
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query("TRUNCATE admin_alert_outbox, admin_alert_channels, admin_alert_silences, inbox_messages RESTART IDENTITY CASCADE");
    } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE admin_alert_outbox, admin_alert_channels, admin_alert_silences, inbox_messages RESTART IDENTITY CASCADE");
  await ensureBoss();
});

describe("enqueueAlert — inbox 兜底(零订阅通道)", () => {
  test("零通道 → inbox_fallback=true,写 1 条 inbox,0 条 outbox", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await enqueueAlert(critEvent());
    assert.equal(r.skipped_no_channels, true);
    assert.equal(r.inbox_fallback, true);
    assert.equal(r.inbox_mirror, false);
    assert.equal(await outboxCount(), 0);
    assert.equal(await inboxCount(), 1);
    const row = (await query<{ audience: string; user_id: string; level: string; body_md: string }>(
      `SELECT audience, user_id::text AS user_id, level, body_md FROM inbox_messages`,
    )).rows[0];
    assert.equal(row.audience, "user");
    assert.equal(row.user_id, "1");
    assert.equal(row.level, "warning"); // critical → warning(level 枚举无 critical)
    assert.match(row.body_md, /站内信兜底/);
  });

  test("有通道但 severity_min 太高(无人订阅)→ 仍兜底", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ severity_min: "critical", fp: "fp-high" });
    // info 事件被 severity_min=critical 拦 → subscribed=0 → 兜底
    const r = await enqueueAlert({
      event_type: "ops.daily_report", severity: "info", title: "日报", body: "ok", dedupe_key: null,
    });
    assert.equal(r.inbox_fallback, true);
    assert.equal(await outboxCount(), 0);
    assert.equal(await inboxCount(), 1);
  });
});

describe("enqueueAlert — critical 双落点镜像", () => {
  test("critical + 订阅通道 → outbox 落行 + 1 条 inbox 镜像", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ fp: "fp-m1" });
    const r = await enqueueAlert(critEvent("ops.monitor_check_failed:svc_v5:b1"));
    assert.equal(r.enqueued, 1);
    assert.equal(r.inbox_fallback, false);
    assert.equal(r.inbox_mirror, true);
    assert.equal(await outboxCount(), 1);
    assert.equal(await inboxCount(), 1);
    assert.match(
      (await query<{ b: string }>(`SELECT body_md AS b FROM inbox_messages`)).rows[0].b,
      /双落点/,
    );
  });

  test("critical 多通道 → outbox N 行,但只镜像 1 条 inbox(与 fan-out 行数无关)", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ fp: "fp-a" });
    await insertChannel({ fp: "fp-b" });
    const r = await enqueueAlert(critEvent("ops.monitor_check_failed:svc_v5:b2"));
    assert.equal(r.enqueued, 2, "两通道各一行");
    assert.equal(r.inbox_mirror, true);
    assert.equal(await outboxCount(), 2);
    assert.equal(await inboxCount(), 1, "镜像只一条");
  });

  test("critical 重复 enqueue(同 dedupe_key 全去重)→ 不再镜像,inbox 不增", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ fp: "fp-dup" });
    const ev = critEvent("ops.monitor_check_failed:svc_v5:dup");
    const r1 = await enqueueAlert(ev);
    assert.equal(r1.inbox_mirror, true);
    assert.equal(await inboxCount(), 1);
    const r2 = await enqueueAlert(ev); // 同 dedupe_key → ON CONFLICT 全去重
    assert.equal(r2.deduped, 1);
    assert.equal(r2.enqueued, 0);
    assert.equal(r2.inbox_mirror, false, "全去重不再刷 inbox");
    assert.equal(await inboxCount(), 1, "inbox 未增第二条");
  });

  test("critical 被 silence 抑制(suppressed)→ 仍写镜像(双落点不受 silence 影响)", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ fp: "fp-sil" });
    await query(
      `INSERT INTO admin_alert_silences(matcher, starts_at, ends_at, reason, created_by)
       VALUES ('{"severity":"critical"}'::jsonb, NOW()-interval '1 min', NOW()+interval '1 hour', 'maint', 1)`,
    );
    const r = await enqueueAlert(critEvent("ops.monitor_check_failed:svc_v5:sil"));
    assert.equal(r.suppressed, 1, "outbox 行 suppressed");
    assert.equal(r.enqueued, 0);
    assert.equal(r.inbox_mirror, true, "critical 镜像不受 silence 影响");
    assert.equal(await inboxCount(), 1);
  });
});

describe("enqueueAlert — 非 critical 不镜像", () => {
  test("warning + 订阅通道 → 只落 outbox,不写 inbox", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertChannel({ fp: "fp-w" });
    const r = await enqueueAlert({
      event_type: "ops.daily_anomaly", severity: "warning", title: "异常", body: "x", dedupe_key: null,
    });
    assert.equal(r.enqueued, 1);
    assert.equal(r.inbox_fallback, false);
    assert.equal(r.inbox_mirror, false);
    assert.equal(await outboxCount(), 1);
    assert.equal(await inboxCount(), 0, "warning 不写 inbox");
  });
});

describe("enqueueAlertToChannel — 测试送达路径不写 inbox", () => {
  test("即便 critical 也不镜像/兜底(测试语义纯净)", async (t) => {
    if (skipIfNoPg(t)) return;
    const chId = await insertChannel({ fp: "fp-test" });
    const r = await enqueueAlertToChannel(chId, critEvent("ops.monitor_check_failed:svc_v5:direct"));
    assert.equal(r.enqueued, true);
    assert.equal(await outboxCount(), 1);
    assert.equal(await inboxCount(), 0, "test send 不碰 inbox");
  });
});

describe("enqueueAlert — inbox 写失败不抛", () => {
  test("uid=1 缺失时兜底写库失败 → 不抛,inbox_fallback=false", async (t) => {
    if (skipIfNoPg(t)) return;
    // 删掉 boss:inbox FK(user_id/created_by → users)失效,writeSystemInbox catch 掉
    await query(`DELETE FROM users WHERE id = 1`);
    const r = await enqueueAlert(critEvent()); // 零通道 → 走兜底,但写库会 FK 失败
    assert.equal(r.skipped_no_channels, true);
    assert.equal(r.inbox_fallback, false, "写库失败,兜底标记为 false");
    assert.equal(await inboxCount(), 0);
    // 关键:没有抛异常(能走到这里即证明)。恢复 boss 供后续 beforeEach。
    await ensureBoss();
  });
});
