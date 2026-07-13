/**
 * v5 自愈体系切片① 集成测试 — reconciler(投影)+ sweeper(投递)行为断言。
 *
 * 覆盖 RFC §10 关键场景(行为断言,非 regex):
 *   - condition firing=true → open incident(severity=max(level, severity_floor))
 *   - 同 condition 再对账 → 不重开(幂等)
 *   - condition firing=false → resolve incident(source='probe',level-triggered 当前值对账)
 *   - incident 生命周期绝不直接创建用户 delivery / inbox / 全员广播
 *   - condition.level 变(warning→critical)→ update incident severity + rev++
 *
 * pg 不可用时 skip(本机无 PG 时结构正确但不跑)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { writeCondition } from "../selfheal/conditions.js";
import { reconcileOnce } from "../selfheal/reconciler.js";
import { sweepOnce } from "../selfheal/sweeper.js";
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

describe("selfheal user notification exit is closed by default", () => {
  test("0145 清掉历史 incident 站内信且不影响普通消息", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await ensureAdmin();
    const inserted = await query<{ id: string }>(
      `INSERT INTO inbox_messages
         (audience, title, body_md, level, created_by, source_type, source_id, source_phase)
       VALUES
         ('all', 'legacy incident', 'must be retired', 'warning', $1, 'incident', 9001, 'opened'),
         ('all', 'normal notice', 'must remain', 'info', $1, 'manual', 9002, 'published')
       RETURNING id::text AS id`,
      [String(adminId)],
    );
    assert.equal(inserted.rows.length, 2);

    const migration = await readFile(
      new URL("../db/migrations/0145_retire_legacy_incident_notices.sql", import.meta.url),
      "utf8",
    );
    await query(migration);

    const remaining = await query<{ title: string; source_type: string }>(
      `SELECT title, source_type FROM inbox_messages ORDER BY id`,
    );
    assert.deepEqual(remaining.rows, [{ title: "normal notice", source_type: "manual" }]);
  });

  test("open 不建 delivery;sweep 不广播且不写全员 inbox", async (t) => {
    if (skipIfNoPg(t)) return;
    await writeCondition(KEY, { mode: "probe", firing: true, level: "critical", snapshot: {} });
    await reconcileOnce(NOOP_DEPS);

    const pend = await query<{ channel: string; phase: string; status: string }>(
      `SELECT channel, phase, status FROM incident_deliveries ORDER BY channel`,
    );
    assert.deepEqual(pend.rows, [], "incident lifecycle must not enqueue user notifications");

    // 模拟升级前遗留的 all-user WS + inbox delivery。新版只允许永久封存为 failed，
    // SweeperDeps 已没有任何用户广播出口，因此旧客户端也收不到普通 incident。
    await query(
      `INSERT INTO incident_deliveries (incident_id,incident_rev,channel,phase)
       SELECT id,rev,'ws','opened' FROM incidents WHERE condition_key=$1 ORDER BY id DESC LIMIT 1`,
      [KEY],
    );
    await query(
      `INSERT INTO incident_deliveries (incident_id,incident_rev,channel,phase)
       SELECT id,rev,'inbox','opened' FROM incidents WHERE condition_key=$1 ORDER BY id DESC LIMIT 1`,
      [KEY],
    );
    const s1 = await sweepOnce({});
    assert.equal(s1.ws, 0);
    assert.equal(s1.inbox, 0);

    const failed = (await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM incident_deliveries WHERE status = 'failed'`,
    )).rows[0].c;
    assert.equal(failed, "2", "legacy user deliveries are permanently retired");

    // 不写任何用户 inbox。
    const inbox = await query<{ audience: string; source_phase: string; level: string }>(
      `SELECT audience, source_phase, level FROM inbox_messages WHERE source_type = 'incident'`,
    );
    assert.equal(inbox.rows.length, 0);

    // 再 sweep:无 pending → 无副作用(幂等)
    const s2 = await sweepOnce({});
    assert.equal(s2.ws, 0);
    assert.equal(s2.inbox, 0);
  });
});
