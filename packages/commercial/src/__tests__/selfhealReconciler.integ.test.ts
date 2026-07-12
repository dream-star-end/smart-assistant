/**
 * v5 自愈体系切片① 集成测试 — reconciler(投影)+ sweeper(投递)行为断言。
 *
 * 覆盖 RFC §10 关键场景(行为断言,非 regex):
 *   - condition firing=true → open incident(severity=max(level, severity_floor))
 *   - 同 condition 再对账 → 不重开(幂等)
 *   - condition firing=false → resolve incident(source='probe',level-triggered 当前值对账)
 *   - open 建 ws+inbox(audience='all')durable delivery;sweeper 投递 + 标 sent + 幂等
 *   - inbox source 唯一键 (source_type,source_id,source_phase) 挡重复
 *   - condition.level 变(warning→critical)→ update incident severity + rev++
 *
 * pg 不可用时 skip(本机无 PG 时结构正确但不跑)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { writeCondition } from "../selfheal/conditions.js";
import { reconcileOnce } from "../selfheal/reconciler.js";
import { sweepOnce, type IncidentPayload } from "../selfheal/sweeper.js";
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
  await runMigrations(); // 幂等;含 0133(condition function + incident_policies seed)
});

after(async () => {
  if (pgAvailable) {
    try {
      await query(
        `TRUNCATE incidents, codex_repairs, codex_repair_events, incident_deliveries,
                  incident_recipients, admin_alert_rule_state, inbox_messages
         RESTART IDENTITY CASCADE`,
      );
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
  _resetPolicyCacheForTest();
  await ensureAdmin();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

/** 建一个 active admin(inbox created_by = MIN active admin 需要它)。 */
async function ensureAdmin(email = "selfheal-admin@test.local"): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, credits, role, status)
     VALUES ($1, 'argon2$stub', 0, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET role='admin', status='active'
     RETURNING id::text AS id`,
    [email],
  );
  return BigInt(r.rows[0].id);
}

/** 注入 no-op enqueue,避免 safeEnqueueAlert fire-and-forget 副作用干扰断言。 */
const NOOP_DEPS = { safeEnqueueAlert: (() => {}) as unknown as never };

async function activeIncidentFor(conditionKey: string): Promise<
  { id: string; status: string; severity: string; rev: string } | null
> {
  const r = await query<{ id: string; status: string; severity: string; rev: string }>(
    `SELECT id::text AS id, status, severity, rev::text AS rev
       FROM incidents WHERE condition_key = $1 ORDER BY id DESC LIMIT 1`,
    [conditionKey],
  );
  return r.rows[0] ?? null;
}

const KEY = "account_pool.all_down"; // seeded policy: exact / audience=all / probe / floor=critical

describe("selfheal reconciler — open/resolve/idempotent projection", () => {
  test("condition firing=true → open incident (severity=critical)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    const r = await reconcileOnce(NOOP_DEPS);
    assert.ok(r.opened.includes(KEY), "reconciler opened the incident");
    const inc = await activeIncidentFor(KEY);
    assert.ok(inc);
    assert.equal(inc.status, "open");
    assert.equal(inc.severity, "critical");
  });

  test("same firing condition → 不重开(幂等)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);
    const r2 = await reconcileOnce(NOOP_DEPS);
    assert.equal(r2.opened.length, 0, "no re-open");
    const count = (await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM incidents WHERE condition_key = $1`, [KEY],
    )).rows[0].c;
    assert.equal(count, "1", "exactly one incident row");
  });

  test("condition firing=false → resolve(source='probe',当前值对账)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);
    await writeCondition(KEY, { mode: "probe", firing: false, level: "critical", snapshot: {} });
    const r = await reconcileOnce(NOOP_DEPS);
    assert.ok(r.resolved.includes(KEY), "reconciler resolved the incident");
    const inc = await activeIncidentFor(KEY);
    assert.ok(inc);
    assert.equal(inc.status, "resolved");
    const src = (await query<{ resolve_source: string }>(
      `SELECT resolve_source FROM incidents WHERE condition_key = $1 ORDER BY id DESC LIMIT 1`, [KEY],
    )).rows[0].resolve_source;
    assert.equal(src, "probe");
  });

  test("condition.level warning→critical(同 phase)→ update severity + rev++", async (t) => {
    if (skipIfNoPg(t)) return;
    // low_capacity: floor=warning,先以 warning 开;再升级 condition level → critical。
    const K2 = "account_pool.low_capacity";
    await writeCondition(K2, { mode: "probe", firing: true, level: "warning", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);
    const before = await activeIncidentFor(K2);
    assert.ok(before);
    assert.equal(before.severity, "warning");
    await writeCondition(K2, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    const r = await reconcileOnce(NOOP_DEPS);
    assert.ok(r.updated.includes(K2), "severity change bumped incident");
    const after = await activeIncidentFor(K2);
    assert.ok(after);
    assert.equal(after.severity, "critical");
    assert.ok(Number(after.rev) > Number(before.rev), "rev incremented");
  });
});

describe("selfheal sweeper — durable delivery + 幂等", () => {
  test("open 建 ws+inbox delivery;sweep 投递 + 标 sent + 幂等", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);

    const pend = await query<{ channel: string; phase: string; status: string }>(
      `SELECT channel, phase, status FROM incident_deliveries ORDER BY channel`,
    );
    const channels = pend.rows.map((r) => r.channel).sort();
    assert.deepEqual(channels, ["inbox", "ws"], "audience=all 建 ws + inbox delivery");
    assert.ok(pend.rows.every((r) => r.status === "pending"));

    const wsCalls: IncidentPayload[] = [];
    const deps = {
      broadcastAll: (p: unknown) => { wsCalls.push(p as IncidentPayload); return 3; },
      broadcastToUsers: () => 0,
    };
    const s1 = await sweepOnce(deps);
    assert.equal(s1.ws, 1);
    assert.equal(s1.inbox, 1);
    assert.equal(wsCalls.length, 1);
    assert.equal(wsCalls[0].type, "sys.incident");
    assert.equal(wsCalls[0].status, "open");
    assert.equal(wsCalls[0].severity, "critical");
    assert.equal(typeof wsCalls[0].incidentId, "string");

    // 全部 sent
    const sent = (await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM incident_deliveries WHERE status = 'sent'`,
    )).rows[0].c;
    assert.equal(sent, "2");

    // inbox 落一条 opened 广播
    const inbox = await query<{ audience: string; source_phase: string; level: string }>(
      `SELECT audience, source_phase, level FROM inbox_messages WHERE source_type = 'incident'`,
    );
    assert.equal(inbox.rows.length, 1);
    assert.equal(inbox.rows[0].audience, "all");
    assert.equal(inbox.rows[0].source_phase, "opened");
    assert.equal(inbox.rows[0].level, "warning");

    // 再 sweep:无 pending → 无副作用(幂等)
    const s2 = await sweepOnce(deps);
    assert.equal(s2.ws, 0);
    assert.equal(s2.inbox, 0);
    assert.equal(wsCalls.length, 1, "no re-broadcast");
  });

  test("inbox source 唯一键挡重复(同 source_phase 只一条)", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);
    const inc = await activeIncidentFor(KEY);
    assert.ok(inc);

    const deps = { broadcastAll: () => 1, broadcastToUsers: () => 0 };
    await sweepOnce(deps); // 投递 opened(rev1)inbox 一条

    // 人造第二条 inbox delivery(同 incident,不同 rev,phase='opened')→ sweep 应被 inbox 唯一键挡
    await query(
      `INSERT INTO incident_deliveries (incident_id, incident_rev, channel, phase, status)
       VALUES ($1::bigint, 999, 'inbox', 'opened', 'pending')`,
      [inc.id],
    );
    const s = await sweepOnce(deps);
    assert.equal(s.inbox, 1, "claimed + processed the injected delivery");

    const cnt = (await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM inbox_messages
        WHERE source_type='incident' AND source_id=$1::bigint AND source_phase='opened'`,
      [inc.id],
    )).rows[0].c;
    assert.equal(cnt, "1", "inbox source 唯一键:同 (incident,phase) 仍只一条");
  });
});
