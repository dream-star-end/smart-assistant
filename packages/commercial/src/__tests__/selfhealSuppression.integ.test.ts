/**
 * v5 自愈体系收尾批 集成测试(octest PG,真迁移 schema)——
 *   A1 suppression 全场景(压制不重开/恢复自动清/恢复后再故障重开/unsuppress 重开/
 *      latched 关闭路径/already-clear/reconciler 兜底 resolve)
 *   A2 resolveIncident 同事务取消活跃修复(verifying 不动;批1b:deploying release request
 *      的 repair 不取消 / queued|accepted request 同事务置 cancelled)
 *   A1 dispatcher 压制守卫(suppressed 不派单)
 *   A9/L1 inbox 幂等键带 rev(updated:N 各一条,同 rev 重放仍一条)
 *   M1 writer-guard 兼容覆盖(已部署 trigger 时验证检测列拒绝/operator 列放行)
 *   B1 policy 覆盖契约(每个生产 producer key 必命中 policy,防 key 域再漂移)
 *
 * 批1b 放行链(202 异步 / 回调分流 / fuse)的集成覆盖见 selfhealReleaseRequests.integ.test.ts。
 * pg 不可用时 skip。断言=行为(DB round-trip / HTTP 副作用),非源码 regex。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { reconcileOnce } from "../selfheal/reconciler.js";
import { sweepOnce } from "../selfheal/sweeper.js";
import { resolveIncident } from "../selfheal/incidents.js";
import { dispatchRepair, type FetchLike } from "../selfheal/repairDispatcher.js";
import { matchPolicy, _resetPolicyCacheForTest } from "../selfheal/policy.js";
import {
  opsMonitorKey,
  providerDegradedKey,
  sessionOversizedKey,
  SYSTEM_MAINTENANCE_ON,
} from "../selfheal/conditionKeys.js";
import {
  adminResolveIncident,
  adminUnsuppressCondition,
  getIncidentDetail,
  listConditions,
  listIncidents,
} from "../admin/selfhealOps.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const WEBHOOK_SECRET = "suppression-integ-webhook-secret-0123456789";
let pgAvailable = false;
let adminId = "0";

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7d).toString("base64");
  process.env.OC_SELFHEAL_MASTER_SECRET = "suppression-integ-master-secret-0123456789";
  process.env.OC_SELFHEAL_WEBHOOK_HMAC = WEBHOOK_SECRET;
  // dispatchRepair 的 not_configured 检查需要 URL;网络面全部注入 fake fetch,不真出站。
  process.env.OC_SELFHEAL_DISPATCH_URL = "http://127.0.0.1:59999";
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await resetTestSchemaForTest();
  await runMigrations();
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ('selfheal-suppression-admin@test.local', 'argon2$stub', 0, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role='admin', status='active'
     RETURNING id::text AS id`,
  );
  adminId = r.rows[0].id;
});

after(async () => {
  if (pgAvailable) {
    try { await cleanup(); } catch { /* */ }
    await closePool();
  }
});

async function cleanup(): Promise<void> {
  await query(
    `TRUNCATE incidents, codex_repairs, codex_repair_events, admin_alert_rule_state,
             selfheal_capability_uses, selfheal_webhook_nonces, admin_audit, inbox_messages
     RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  if (!pgAvailable) return;
  await cleanup();
  _resetPolicyCacheForTest();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

// ─── helpers ───────────────────────────────────────────────────────────

const noAlert = () => {};

async function writeCond(
  key: string,
  firing: boolean,
  opts: { mode?: string; level?: string; snapshot?: Record<string, unknown>; occ?: number } = {},
): Promise<void> {
  await query(
    `SELECT * FROM write_alert_condition($1,$2,$3,$4,$5::jsonb,NOW(),NULL,$6)`,
    [key, opts.mode ?? "probe", firing, opts.level ?? "warning",
     JSON.stringify(opts.snapshot ?? {}), opts.occ ?? 0],
  );
}

async function reconcile() {
  return reconcileOnce({ safeEnqueueAlert: noAlert });
}

async function activeIncidents(): Promise<Array<{ id: string; condition_key: string; severity: string }>> {
  const r = await query<{ id: string; condition_key: string; severity: string }>(
    `SELECT id::text AS id, condition_key, severity FROM incidents WHERE status <> 'resolved'`,
  );
  return r.rows;
}

async function condRow(key: string) {
  const r = await query<{
    firing: boolean; suppressed_until_clear: boolean;
    suppressed_at: Date | null; suppressed_by: string | null;
  }>(
    `SELECT firing, suppressed_until_clear, suppressed_at, suppressed_by
       FROM admin_alert_rule_state WHERE rule_id = $1`,
    [key],
  );
  return r.rows[0];
}

async function auditRows(action: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action = $1`, [action]);
  return Number(r.rows[0].n);
}

const adminInput = () => ({ adminId, ip: "127.0.0.1", userAgent: "integ" });

// ═══ A1 — suppression 全场景 ═══════════════════════════════════════════

describe("A1 suppression(probe resolve 风暴根治)", () => {
  const KEY = opsMonitorKey("svc_v5"); // probe + auto_repair 策略

  test("probe 仍 firing 时 admin resolve → suppression;后续探测+N 轮 reconcile 不重开", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    assert.ok(inc, "incident 已打开");

    const r = await adminResolveIncident(inc.id, adminInput());
    assert.equal(r.outcome, "resolved");
    assert.equal(r.resolution, "suppressed_until_clear", "probe 判定表 → 压制");

    const c = await condRow(KEY);
    assert.equal(c.firing, true, "检测权威不被篡改(仍 firing)");
    assert.equal(c.suppressed_until_clear, true);
    assert.equal(c.suppressed_by, adminId);

    // 探测继续写 firing=true(风暴场景),3 轮 reconcile 均不得重开。
    for (let i = 0; i < 3; i++) {
      await writeCond(KEY, true, { level: "critical" });
      const rr = await reconcile();
      assert.deepEqual(rr.opened, [], `第 ${i + 1} 轮不重开`);
    }
    assert.equal((await activeIncidents()).length, 0);
    assert.equal(await auditRows("incident.resolve"), 1, "audit tx 落账");
  });

  test("condition 真实恢复 → suppression 自动清;恢复后再故障 → 正常重开", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    await adminResolveIncident(inc.id, adminInput());

    // 真实恢复:true→false 翻转,write_alert_condition 自动清三列。
    await writeCond(KEY, false);
    const c = await condRow(KEY);
    assert.equal(c.suppressed_until_clear, false, "翻转自动清压制");
    assert.equal(c.suppressed_at, null);
    assert.equal(c.suppressed_by, null);

    // 新一轮故障必须重新告警。
    await writeCond(KEY, true, { level: "critical" });
    const rr = await reconcile();
    assert.deepEqual(rr.opened, [KEY], "恢复后再故障 → 重开");
  });

  test("unsuppress(误压回滚)→ 下轮 reconcile 重开 + audit", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    await adminResolveIncident(inc.id, adminInput());

    const u = await adminUnsuppressCondition(KEY, adminInput());
    assert.equal(u.outcome, "unsuppressed");
    assert.equal(await auditRows("condition.unsuppress"), 1);

    const rr = await reconcile();
    assert.deepEqual(rr.opened, [KEY], "解除压制后重开");

    // 幂等面:未压制/不存在
    assert.equal((await adminUnsuppressCondition(KEY, adminInput())).outcome, "not_suppressed");
    assert.equal((await adminUnsuppressCondition("no.such.key", adminInput())).outcome, "not_found");
  });

  test("latched(session_oversized per-user)→ resolve 走 writeCondition(false) 关闭", async (t) => {
    if (skipIfNoPg(t)) return;
    const key = sessionOversizedKey("42");
    await writeCond(key, true, { mode: "latched", snapshot: { kind: "assistant", user_id: "42" }, occ: 1 });
    const rr = await reconcile();
    assert.deepEqual(rr.opened, [key], "prefix policy(0135 seed 对齐)命中,per-user incident");

    const [inc] = await activeIncidents();
    const r = await adminResolveIncident(inc.id, adminInput());
    assert.equal(r.resolution, "condition_closed", "latched 判定表 → CAS 关 condition");
    const c = await condRow(key);
    assert.equal(c.firing, false);
    assert.equal((await reconcile()).opened.length, 0, "关掉后不重开");
  });

  test("condition 已 !firing 时 resolve → condition_already_clear(仅 resolve)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    await writeCond(KEY, false); // 探测先恢复了
    const r = await adminResolveIncident(inc.id, adminInput());
    assert.equal(r.resolution, "condition_already_clear");
    assert.equal((await activeIncidents()).length, 0);
  });

  test("reconciler 兜底:suppressed+firing 的遗留 open incident 被 resolve(source=admin)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    // 直接压制(operator 列直写合法),不走 adminResolve —— 模拟崩溃残留。
    await query(
      `UPDATE admin_alert_rule_state SET suppressed_until_clear=TRUE, suppressed_at=NOW(), suppressed_by=$2
        WHERE rule_id=$1`, [KEY, adminId]);
    const rr = await reconcile();
    assert.deepEqual(rr.resolved, [KEY]);
    const src = await query<{ resolve_source: string }>(
      `SELECT resolve_source FROM incidents ORDER BY id DESC LIMIT 1`);
    assert.equal(src.rows[0].resolve_source, "admin");
  });

  test("listConditions(suppressedOnly)只回压制行", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond(KEY, true);
    await writeCond(opsMonitorKey("mail"), true);
    await query(
      `UPDATE admin_alert_rule_state SET suppressed_until_clear=TRUE, suppressed_at=NOW(), suppressed_by=$2
        WHERE rule_id=$1`, [KEY, adminId]);
    const all = await listConditions({});
    assert.equal(all.rows.length, 2);
    const sup = await listConditions({ suppressedOnly: true });
    assert.equal(sup.rows.length, 1);
    assert.equal(sup.rows[0].condition_key, KEY);
    assert.equal(sup.rows[0].suppressed_by, adminId);
  });
});

// ═══ A2 — resolveIncident 同事务取消活跃修复 ═══════════════════════════

describe("A2 resolveIncident → 活跃修复 cancel_requested(verifying 不动)", () => {
  async function seedIncidentWithRepair(status: string): Promise<{ incidentId: string; repairId: string }> {
    const inc = await query<{ id: string }>(
      `INSERT INTO incidents (dedupe_key, condition_key, status, severity, surface, audience, user_title, user_message)
       VALUES ('k.a2','k.a2','repairing','critical','global','all','t','m') RETURNING id::text AS id`,
    );
    const rep = await query<{ id: string }>(
      `INSERT INTO codex_repairs (incident_id, status, attempt, tier)
       VALUES ($1::bigint, $2, 1, 'tier2') RETURNING id::text AS id`,
      [inc.rows[0].id, status],
    );
    return { incidentId: inc.rows[0].id, repairId: rep.rows[0].id };
  }

  async function insertBoundReleaseRequest(
    repairId: string,
    incidentId: string,
    status: "queued" | "accepted" | "deploying",
    delivered = false,
  ): Promise<void> {
    const approvedSha = "a".repeat(40);
    const planHash = "b".repeat(64);
    const manifestHash = "c".repeat(64);
    const event = await query<{ id: string }>(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'test pending release', $2::jsonb)
       RETURNING id::text AS id`,
      [repairId, JSON.stringify({
        phase: "pending_release",
        sha: approvedSha,
        deployPlanHash: planHash,
        manifestHash,
        classification: { surfaces: ["master"] },
      })],
    );
    await query(
      `INSERT INTO selfheal_release_requests
         (repair_id, incident_id, requested_by, approved_sha, status,
          deploy_plan_hash, manifest_hash, plan_detail, source_event_id, delivered_at)
       VALUES ($1::bigint, $2::bigint, '1', $3, $4, $5, $6, '{}'::jsonb,
               $7::bigint, CASE WHEN $8::boolean THEN NOW() ELSE NULL END)`,
      [repairId, incidentId, approvedSha, status, planHash, manifestHash, event.rows[0].id, delivered],
    );
  }

  for (const st of ["pending", "dispatched", "acked", "running"]) {
    test(`${st} → cancel_requested + repair_event(kind=cancel)`, async (t) => {
      if (skipIfNoPg(t)) return;
      const { incidentId, repairId } = await seedIncidentWithRepair(st);
      await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
      const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
      assert.equal(r.rows[0].status, "cancel_requested");
      const ev = await query<{ kind: string; message: string }>(
        `SELECT kind, message FROM codex_repair_events WHERE repair_id=$1::bigint ORDER BY id DESC LIMIT 1`, [repairId]);
      assert.equal(ev.rows[0].kind, "cancel");
      assert.match(ev.rows[0].message, /incident resolved/);
    });
  }

  test("verifying 不取消(成功归因路径,verify fence 裁决)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { incidentId, repairId } = await seedIncidentWithRepair("verifying");
    await tx((client: PoolClient) => resolveIncident(incidentId, "codex", client));
    const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.equal(r.rows[0].status, "verifying");
  });

  test("批1b:deploying release request 的 running repair:resolve 不取消(receipt 裁决)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { incidentId, repairId } = await seedIncidentWithRepair("running");
    await insertBoundReleaseRequest(repairId, incidentId, "deploying");
    await tx((client: PoolClient) => resolveIncident(incidentId, "probe", client));
    const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.equal(r.rows[0].status, "running", "deploying 在途 → resolve 不取消 repair,交 receipt 裁决");
    const rr = await query<{ status: string }>(
      `SELECT status FROM selfheal_release_requests WHERE repair_id=$1::bigint`, [repairId]);
    assert.equal(rr.rows[0].status, "deploying", "deploying 请求不被 resolve 置 cancelled");
  });

  test("批1b F2:queued(未交付)request resolve 同事务置 cancelled;accepted(已交付)保持 accepted;两者 repair 均 cancel_requested", async (t) => {
    if (skipIfNoPg(t)) return;
    // queued(delivered_at NULL,个人版从未收到)→ 乐观撤单安全,同事务直接置 cancelled。
    {
      const { incidentId, repairId } = await seedIncidentWithRepair("running");
      await insertBoundReleaseRequest(repairId, incidentId, "queued");
      await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
      const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
      assert.equal(r.rows[0].status, "cancel_requested", "queued:repair → cancel_requested");
      const rr = await query<{ status: string; resolved_by: string | null }>(
        `SELECT status, resolved_by FROM selfheal_release_requests WHERE repair_id=$1::bigint`, [repairId]);
      assert.equal(rr.rows[0].status, "cancelled", "queued:request 同事务置 cancelled");
      assert.equal(rr.rows[0].resolved_by, "admin");
      await cleanup();
    }
    // accepted(个人版已 202 收下,delivered_at set)→ F2:不单方 cancelled(可能已 pre-claim/在途),
    // 交 sweeper postCancel 的 releaseCancel 裁决收口;repair 仍进 cancel 流。
    {
      const { incidentId, repairId } = await seedIncidentWithRepair("running");
      await insertBoundReleaseRequest(repairId, incidentId, "accepted", true);
      await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
      const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
      assert.equal(r.rows[0].status, "cancel_requested", "accepted:repair 仍进 cancel 流");
      const rr = await query<{ status: string }>(
        `SELECT status FROM selfheal_release_requests WHERE repair_id=$1::bigint`, [repairId]);
      assert.equal(rr.rows[0].status, "accepted", "accepted:request 不被单方 cancelled(交 cancel webhook 收口)");
      await cleanup();
    }
  });

  test("admin resolve 全链:suppression + 修复取消同一事务", async (t) => {
    if (skipIfNoPg(t)) return;
    const KEY = opsMonitorKey("svc_v5");
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    await query(
      `INSERT INTO codex_repairs (incident_id, status, attempt, tier) VALUES ($1::bigint,'running',1,'tier2')`,
      [inc.id],
    );
    const r = await adminResolveIncident(inc.id, adminInput());
    assert.equal(r.resolution, "suppressed_until_clear");
    const rep = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE incident_id=$1::bigint`, [inc.id]);
    assert.equal(rep.rows[0].status, "cancel_requested");
  });
});

// ═══ A1 — dispatcher 压制守卫 ══════════════════════════════════════════

describe("A1 dispatcher:suppressed 不派单", () => {
  const fetch202: FetchLike = async () => ({ status: 202, text: async () => "" });

  test("suppressed+firing → dispatchRepair 0 行插入(incident_recovered);unsuppress 后可派", async (t) => {
    if (skipIfNoPg(t)) return;
    const KEY = opsMonitorKey("svc_v5");
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    const [inc] = await activeIncidents();
    await query(
      `UPDATE admin_alert_rule_state SET suppressed_until_clear=TRUE WHERE rule_id=$1`, [KEY]);

    const r1 = await dispatchRepair(inc.id, { fetch: fetch202 });
    assert.deepEqual(r1, { status: "skipped", reason: "incident_recovered" });
    const n1 = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM codex_repairs`);
    assert.equal(n1.rows[0].n, "0", "压制中零派单");

    await query(`UPDATE admin_alert_rule_state SET suppressed_until_clear=FALSE WHERE rule_id=$1`, [KEY]);
    const r2 = await dispatchRepair(inc.id, { fetch: fetch202 });
    assert.equal(r2.status, "dispatched", "解除压制后正常派单");
  });
});

// ═══ 用户通知出口默认关闭 ═════════════════════════════════════════════

describe("incident 生命周期不再写全员 inbox", () => {
  test("opened/updated 都只留运维账本，不创建用户 delivery", async (t) => {
    if (skipIfNoPg(t)) return;
    const KEY = opsMonitorKey("mem"); // severity_floor=warning → level 变化才可观察 update
    const sweep = () => sweepOnce({});

    await writeCond(KEY, true, { level: "warning" });
    await reconcile();
    await sweep();
    // level 升级 → rev2;再降回 → rev3。
    await writeCond(KEY, true, { level: "critical" });
    await reconcile();
    await sweep();
    await writeCond(KEY, true, { level: "warning" });
    await reconcile();
    await sweep();

    const rows = await query<{ source_phase: string }>(
      `SELECT source_phase FROM inbox_messages WHERE source_type='incident' ORDER BY id`,
    );
    assert.deepEqual(rows.rows, []);
    const deliveries = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM incident_deliveries`);
    assert.equal(deliveries.rows[0].n, "0");
  });
});

// ═══ writer guard deferred ═══════════════════════════════════════════

describe("writer-guard 在 rollback 历史收敛前保持 deferred", () => {
  test("function 权威写路径仍工作，operator 列保持可写", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCond("t.guard.ts", true); // function 路径 INSERT ✓
    // operator 列(ack + suppression)直写放行。
    await query(`UPDATE admin_alert_rule_state SET acked=TRUE, acked_at=NOW() WHERE rule_id='t.guard.ts'`);
    await query(`UPDATE admin_alert_rule_state SET suppressed_until_clear=TRUE, suppressed_at=NOW(), suppressed_by='1' WHERE rule_id='t.guard.ts'`);
    const c = await condRow("t.guard.ts");
    assert.equal(c.suppressed_until_clear, true);
    // function 路径 UPDATE 仍放行(GUC 标记)。
    await writeCond("t.guard.ts", false);
    assert.equal((await condRow("t.guard.ts")).firing, false);
  });
});

// ═══ B1 — policy 覆盖契约(防 key 域再漂移)═════════════════════════════

describe("B1 policy 覆盖契约:每个生产 producer key 必命中 policy", () => {
  test("monitor/provider/oversized/maintenance/账号池 key 全部命中", async (t) => {
    if (skipIfNoPg(t)) return;
    _resetPolicyCacheForTest();
    const keys = [
      opsMonitorKey("svc_v5"), opsMonitorKey("http_v5"), opsMonitorKey("public_route"),
      opsMonitorKey("svc_egress"), opsMonitorKey("http_egress"), opsMonitorKey("mail"),
      opsMonitorKey("disk_root"), opsMonitorKey("pool"),
      opsMonitorKey("mem"), opsMonitorKey("image"), // 0135 新 seed
      providerDegradedKey("kimi"),                    // 0135 exact→prefix
      sessionOversizedKey("42"),                      // 0135 exact→prefix(per-user)
      SYSTEM_MAINTENANCE_ON,
      "account_pool.all_down", "account_pool.low_capacity",
    ];
    for (const k of keys) {
      const p = await matchPolicy(k);
      assert.ok(p, `key '${k}' 必须命中 policy(命不中=用户无感,B1 漂移回归)`);
    }
    // 反例:未登记 key 不命中(policy 域收敛)。
    assert.equal(await matchPolicy("random.unknown.key"), null);
  });
});

// ═══ M4 — admin 出口脱敏(自由文本值级清洗)═══════════════════════════

describe("M4 admin 出口:ops_detail/summary/fail_reason/event message 值级脱敏", () => {
  test("ops_detail 含 sk- 令牌在列表+详情输出被清;summary/fail_reason/event message 同口径", async (t) => {
    if (skipIfNoPg(t)) return;
    const inc = await query<{ id: string }>(
      `INSERT INTO incidents (dedupe_key, condition_key, status, severity, surface, audience,
                              user_title, user_message, ops_detail)
       VALUES ('k.m4','k.m4','open','critical','global','all','t','m',
               'probe saw Authorization: Bearer eyJhbGciOi.abc and key sk-live0123456789abcdef')
       RETURNING id::text AS id`,
    );
    const rep = await query<{ id: string }>(
      `INSERT INTO codex_repairs (incident_id, status, attempt, tier, summary, fail_reason, detail)
       VALUES ($1::bigint, 'failed', 1, 'tier2',
               'patched config with token=sk-live0123456789abcdef',
               'redeploy failed: password=hunter2sEcret unreachable',
               '{"note":"used sk-live0123456789abcdef"}'::jsonb)
       RETURNING id::text AS id`,
      [inc.rows[0].id],
    );
    await query(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'calling api with sk-live0123456789abcdef now', '{}'::jsonb)`,
      [rep.rows[0].id],
    );

    const detail = await getIncidentDetail(inc.rows[0].id);
    assert.ok(detail);
    const flat = JSON.stringify(detail);
    assert.ok(!flat.includes("sk-live0123456789abcdef"), "sk- 令牌不得出现在 admin 详情任何字段");
    assert.ok(!flat.includes("hunter2sEcret"), "password= 尾随值不得泄漏");
    assert.ok(!flat.includes("eyJhbGciOi.abc"), "Bearer 值不得泄漏");
    assert.match(detail.incident.ops_detail ?? "", /\[redacted:key\]/);
    assert.match(detail.repairs[0].summary ?? "", /\[redacted\]/);
    assert.match(detail.repairs[0].fail_reason ?? "", /\[redacted\]/);
    assert.match(detail.events[0].message, /\[redacted:key\]/);

    const list = await listIncidents({});
    const row = list.rows.find((x) => x.id === inc.rows[0].id);
    assert.ok(row);
    assert.ok(!(row.ops_detail ?? "").includes("sk-live0123456789abcdef"), "列表出口同样被清");
    assert.ok(list.total >= 1);
    assert.ok(list.open_total >= 1);
    assert.equal(row.latest_repair_status, "failed");
    assert.ok(row.latest_repair_at);
  });
});
