/**
 * 巡检修复(2026-07-16)行为断言:
 *
 * 1) claimReadyAlerts 类型分区 —— iLink/telegram 分区的 claim 绝不认领 wecom_* 行。
 *    背景:ilinkAlertWorker 此前用类型无关 claim,与 wecomAlertDispatcher 抢同一张
 *    outbox 表,抢到 wecom 行即 markFailed 'unsupported channel_type'(不再重试),
 *    生产已丢 ops.egress_node_down / system.pricing_changed 共 4 条重要告警。
 *
 * 2) putProviderOps health_mode 变更传导 condition(admin_alert_rule_state):
 *    forced_healthy → 关 firing(reconciler 据此 resolve 降级 incident);
 *    forced_degraded → 开 firing;auto / mode 未变 → 不动 condition。
 *    背景:scheduler 在 forced_* 模式下不再评估转移,不传导则 firing 冻结,
 *    minimax 降级 incident 曾因此悬挂 3 天(用户端"回复可能变慢"横幅不撤)。
 *
 * pg 不可用时 skip(对齐 alertOutboxAck.integ.test.ts)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { claimReadyAlerts, transitionRuleState } from "../admin/alertOutbox.js";
import { putProviderOps } from "../admin/modelOps.js";
import { providerDegradedKey } from "../selfheal/conditionKeys.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;
let adminId = "";

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7c).toString("base64");
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
  const u = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ('patrol-admin@test.local', 'x', 0, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role = 'admin'
     RETURNING id::text AS id`,
  );
  adminId = u.rows[0].id;
});

after(async () => {
  if (!pgAvailable) return;
  try {
    await query(
      "TRUNCATE admin_alert_outbox, admin_alert_rule_state RESTART IDENTITY CASCADE",
    );
    await query("DELETE FROM provider_ops WHERE provider_id = 'minimax'");
  } catch { /* */ }
  await closePool();
  await resetPool();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE admin_alert_outbox RESTART IDENTITY CASCADE");
  await query("DELETE FROM admin_alert_channels WHERE label LIKE 'patrol-%'");
  await query("DELETE FROM admin_alert_rule_state WHERE rule_id = $1", [
    providerDegradedKey("minimax"),
  ]);
  await query("DELETE FROM provider_ops WHERE provider_id = 'minimax'");
});

async function seedChannel(channelType: string, label: string): Promise<string> {
  // chk_channel_type_fields:wecom_aibot 必须带 aibot_bot_id,其余类型该列必须为 NULL。
  const aibotBotId = channelType === "wecom_aibot" ? "aib-patrol-test" : null;
  const r = await query<{ id: string }>(
    `INSERT INTO admin_alert_channels (admin_id, channel_type, label, enabled, severity_min, event_types, activation_status, aibot_bot_id)
     VALUES ($1::bigint, $2, $3, TRUE, 'info', '[]'::jsonb, 'active', $4)
     RETURNING id::text AS id`,
    [adminId, channelType, label, aibotBotId],
  );
  return r.rows[0].id;
}

async function seedOutboxRow(channelId: string, title: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO admin_alert_outbox (event_type, severity, title, body, payload, channel_id, status, attempts, next_attempt_at)
     VALUES ('ops.egress_node_down', 'critical', $1, 'body', '{}'::jsonb, $2::bigint, 'pending', 0, NOW() - interval '1 minute')
     RETURNING id::text AS id`,
    [title, channelId],
  );
  return r.rows[0].id;
}

describe("claimReadyAlerts 类型分区(ilink worker 不误吃 wecom 行)", { concurrency: false }, () => {
  test("ilink/telegram 分区只认领自己类型;wecom 行留在 outbox 且状态不变", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");
    const wecomCh = await seedChannel("wecom_aibot", "patrol-wecom");
    const ilinkCh = await seedChannel("ilink_wechat", "patrol-ilink");
    const wecomRow = await seedOutboxRow(wecomCh, "wecom 行");
    const ilinkRow = await seedOutboxRow(ilinkCh, "ilink 行");

    const ilinkClaimed = await claimReadyAlerts(20, ["ilink_wechat", "telegram"]);
    assert.deepEqual(
      ilinkClaimed.map((r) => r.id).sort(),
      [ilinkRow],
      "ilink 分区 claim 只能拿到 ilink 行",
    );

    const wecomClaimed = await claimReadyAlerts(20, ["wecom_bot", "wecom_aibot"]);
    assert.deepEqual(
      wecomClaimed.map((r) => r.id).sort(),
      [wecomRow],
      "wecom 分区 claim 只能拿到 wecom 行",
    );

    const st = await query<{ status: string }>(
      "SELECT status FROM admin_alert_outbox WHERE id = $1::bigint",
      [wecomRow],
    );
    assert.equal(st.rows[0].status, "pending", "wecom 行不得被别的分区标 failed");
  });

  test("空数组分区认领无(防 = ANY('{}') 反直觉语义)", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");
    const ch = await seedChannel("ilink_wechat", "patrol-ilink-2");
    await seedOutboxRow(ch, "row");
    const claimed = await claimReadyAlerts(20, []);
    assert.equal(claimed.length, 0);
  });
});

describe("putProviderOps health_mode → condition 传导", { concurrency: false }, () => {
  const key = providerDegradedKey("minimax");
  const ctx = { adminId: 0 as unknown as bigint, ip: null, userAgent: null };

  async function firing(): Promise<boolean | null> {
    const r = await query<{ firing: boolean }>(
      "SELECT firing FROM admin_alert_rule_state WHERE rule_id = $1",
      [key],
    );
    return r.rows.length ? r.rows[0].firing : null;
  }

  test("forced_healthy 关 firing;forced_degraded 开 firing;auto/未变不动", async (t) => {
    if (!pgAvailable) return t.skip("pg fixture unavailable");
    const c = { ...ctx, adminId };

    // 模拟 scheduler 观测降级:condition firing=true(生产 minimax 事故同态)
    await transitionRuleState(key, true, key, { provider_id: "minimax", reason: "观测降级" });
    assert.equal(await firing(), true);

    // admin 强制恢复 → firing 必须被关(reconciler 才能 resolve incident)
    await putProviderOps("minimax", { health_mode: "forced_healthy" }, c);
    assert.equal(await firing(), false, "forced_healthy 必须传导关 firing");

    // mode 未变(只改 notes)→ 不碰 condition
    await transitionRuleState(key, true, key, { provider_id: "minimax", reason: "再次降级" });
    await putProviderOps("minimax", { notes: "备注" }, c);
    assert.equal(await firing(), true, "mode 未变不得动 condition");

    // 重复设同一 mode(forced_healthy → forced_healthy)→ no-op 不传导:
    // 上一段已把 firing 重新置 true 且 mode 已是 forced_healthy,重复提交不得把它关掉。
    await putProviderOps("minimax", { health_mode: "forced_healthy" }, c);
    assert.equal(await firing(), true, "同 mode 重复提交是 no-op,不得动 condition");

    // admin 强制降级 → firing 开
    await query("DELETE FROM admin_alert_rule_state WHERE rule_id = $1", [key]);
    await putProviderOps("minimax", { health_mode: "forced_degraded" }, c);
    assert.equal(await firing(), true, "forced_degraded 必须传导开 firing");

    // 切回 auto → 不强写 condition(交还 scheduler 观测)
    await putProviderOps("minimax", { health_mode: "auto" }, c);
    assert.equal(await firing(), true, "auto 交还 scheduler,不在 putProviderOps 强写");
  });
});
