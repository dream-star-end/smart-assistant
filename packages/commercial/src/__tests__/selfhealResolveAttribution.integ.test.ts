/**
 * v5 自愈批0 集成测试 — resolve 归因让位 + 派单 enabled 过滤 + drill seed。
 *
 * 覆盖(真 PG,行为断言):
 *   - P3:verifying repair 存在时 reconciler 的 probe resolve CAS 落空(归因
 *     让位),sweeper 在同事务完成 succeeded + resolve(source='codex');
 *   - P3:repair 离开 verifying(失败终态)后,probe resolve 正常收口(无死锁);
 *   - P3:suppression(admin)收口不受 verifying 守卫阻塞;
 *   - P4:policy enabled=FALSE 时即使 auto_repair=TRUE 也不派单;
 *   - P5:0154 drill policy seed 姿态(exact/enabled/auto_repair=F/notice=F)。
 *
 * pg 不可用时 skip(与 selfhealReconciler.integ.test.ts 同款门)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { writeCondition } from "../selfheal/conditions.js";
import { reconcileOnce } from "../selfheal/reconciler.js";
import { sweepRepairsOnce } from "../selfheal/sweeper.js";
import { resolveIncidentByProbe } from "../selfheal/incidents.js";
import { SELFHEAL_DRILL_TRANSPORT } from "../selfheal/conditionKeys.js";
import { _resetPolicyCacheForTest } from "../selfheal/policy.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query(
        `TRUNCATE incidents, codex_repairs, codex_repair_events, incident_deliveries,
                  incident_recipients, admin_alert_rule_state, inbox_messages
         RESTART IDENTITY CASCADE`,
      );
      await query(`UPDATE incident_policies SET enabled = TRUE WHERE match_key = 'ops.monitor:svc_v5'`);
    } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE incidents, codex_repairs, codex_repair_events, incident_deliveries,
              incident_recipients, admin_alert_rule_state, inbox_messages
     RESTART IDENTITY CASCADE`,
  );
  await query(`UPDATE incident_policies SET enabled = TRUE WHERE match_key = 'ops.monitor:svc_v5'`);
  _resetPolicyCacheForTest();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

const NOOP_DEPS = { safeEnqueueAlert: (() => {}) as unknown as never };
const KEY = "ops.monitor:svc_v5"; // seeded prefix policy, auto_repair=TRUE

/** 建 firing condition + 开 incident,返回 incidentId。 */
async function openIncident(key = KEY): Promise<string> {
  await writeCondition(key, { mode: "probe", firing: true, level: "critical", snapshot: {} });
  await reconcileOnce(NOOP_DEPS);
  const r = await query<{ id: string }>(
    `SELECT id::text AS id FROM incidents WHERE condition_key = $1 AND status <> 'resolved'
      ORDER BY id DESC LIMIT 1`,
    [key],
  );
  assert.ok(r.rows[0], "incident opened");
  return r.rows[0].id;
}

/** 直插一个 repair 行(测试专用;生产只经 dispatchRepair)。 */
async function insertRepair(
  incidentId: string,
  status: string,
  opts: { verifyAfterOffsetMs?: number } = {},
): Promise<string> {
  const off = opts.verifyAfterOffsetMs ?? -2_000; // 默认 verify_after 在过去 → 观测天然新鲜
  const r = await query<{ id: string }>(
    `INSERT INTO codex_repairs (incident_id, status, attempt, tier, verify_after, verify_deadline, created_at, updated_at)
     VALUES ($1::bigint, $2, 1, 'tier2', NOW() + ($3 || ' milliseconds')::interval, NOW() + interval '10 minutes', NOW(), NOW())
     RETURNING id::text AS id`,
    [incidentId, status, String(off)],
  );
  return r.rows[0].id;
}

describe("P3 归因让位 — verifying 守卫", () => {
  test("verifying repair 在场:probe resolve 落空;sweeper 以 codex 收口", async (t) => {
    if (skipIfNoPg(t)) return;
    const incidentId = await openIncident();
    const repairId = await insertRepair(incidentId, "verifying");

    // condition 恢复(观测晚于 verify_after)。
    await writeCondition(KEY, { mode: "probe", firing: false, level: "critical", snapshot: {} });

    // reconciler 先跑:probe resolve 必须让位(CAS 落空,incident 保持非 resolved)。
    const r1 = await reconcileOnce(NOOP_DEPS);
    assert.ok(!r1.resolved.includes(KEY), "verifying 窗口内 probe 不收口");
    const midway = await query<{ status: string }>(
      `SELECT status FROM incidents WHERE id = $1::bigint`, [incidentId]);
    assert.notEqual(midway.rows[0].status, "resolved");

    // sweeper 跑:succeeded + resolve(source='codex')同事务。
    await sweepRepairsOnce({ enqueueAlert: () => {} });
    const fin = await query<{ istatus: string; source: string; rstatus: string }>(
      `SELECT i.status AS istatus, i.resolve_source AS source, r.status AS rstatus
         FROM incidents i JOIN codex_repairs r ON r.id = $2::bigint
        WHERE i.id = $1::bigint`,
      [incidentId, repairId],
    );
    assert.equal(fin.rows[0].rstatus, "succeeded");
    assert.equal(fin.rows[0].istatus, "resolved");
    assert.equal(fin.rows[0].source, "codex", "自愈成功必须归因 codex,不能被 probe 抢跑");
  });

  test("直接 CAS 语义:verifying 在场 resolveIncidentByProbe 返回 resolved=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const incidentId = await openIncident();
    await insertRepair(incidentId, "verifying");
    const r = await tx((c: PoolClient) => resolveIncidentByProbe(incidentId, c));
    assert.equal(r.resolved, false);
    // repair 离场(失败终态)后,同一调用立即可收口 —— 无死锁。
    await query(`UPDATE codex_repairs SET status='verification_failed' WHERE incident_id=$1::bigint`, [incidentId]);
    const r2 = await tx((c: PoolClient) => resolveIncidentByProbe(incidentId, c));
    assert.equal(r2.resolved, true);
    const src = await query<{ s: string }>(
      `SELECT resolve_source AS s FROM incidents WHERE id=$1::bigint`, [incidentId]);
    assert.equal(src.rows[0].s, "probe");
  });

  test("suppression(admin)收口压过 verifying 守卫", async (t) => {
    if (skipIfNoPg(t)) return;
    const incidentId = await openIncident();
    await insertRepair(incidentId, "verifying");
    // 仍 firing + 被压制(operator 列直写在测试里合法;生产走 adminResolveIncident)。
    await query(
      `UPDATE admin_alert_rule_state
          SET suppressed_until_clear = TRUE, suppressed_at = NOW(), suppressed_by = 'test-admin'
        WHERE rule_id = $1`,
      [KEY],
    );
    const r = await reconcileOnce(NOOP_DEPS);
    assert.ok(r.resolved.includes(KEY), "suppression 兜底收口不被 verifying 阻塞");
    const src = await query<{ s: string; st: string }>(
      `SELECT resolve_source AS s, status AS st FROM incidents WHERE id=$1::bigint`, [incidentId]);
    assert.equal(src.rows[0].st, "resolved");
    assert.equal(src.rows[0].s, "admin");
  });
});

describe("P4 派单过滤 — policy.enabled", () => {
  test("enabled=FALSE 时 auto_repair=TRUE 的 incident 不派单", async (t) => {
    if (skipIfNoPg(t)) return;
    const incidentId = await openIncident();
    await query(`UPDATE incident_policies SET enabled = FALSE WHERE match_key = $1`, [KEY]);
    const dispatched: string[] = [];
    await sweepRepairsOnce({
      enqueueAlert: () => {},
      dispatchRepair: (async (id: string) => {
        dispatched.push(id);
        return { status: "dispatched", repairId: "999", attempt: 1 };
      }) as never,
    });
    assert.equal(dispatched.length, 0, "disabled policy 的 incident 绝不进派单候选");
    const rep = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repairs WHERE incident_id=$1::bigint`, [incidentId]);
    assert.equal(rep.rows[0].n, "0");
  });
});

describe("P5 drill policy seed(0154)", () => {
  test("常驻姿态:exact + enabled + auto_repair=F + user_notice=F", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await query<{
      match_kind: string; enabled: boolean; auto_repair: boolean; user_notice_enabled: boolean;
    }>(
      `SELECT match_kind, enabled, auto_repair, user_notice_enabled
         FROM incident_policies WHERE match_key = $1`,
      [SELFHEAL_DRILL_TRANSPORT],
    );
    assert.equal(r.rows.length, 1, "0154 seed 恰一行");
    assert.equal(r.rows[0].match_kind, "exact");
    assert.equal(r.rows[0].enabled, true);
    assert.equal(r.rows[0].auto_repair, false, "常态不派单——只有演练脚本持锁期间临时翻开");
    assert.equal(r.rows[0].user_notice_enabled, false, "演练绝不触达用户");
  });
});
