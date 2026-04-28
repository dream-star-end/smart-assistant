/**
 * 0042 — compute-pool/queries.ts 全套 SQL 行为集成测试。
 *
 * 覆盖原子生命周期相关的所有写路径,确保:
 *   - markBootstrapResult: success/ready / success+softQuarantine / !success+broken 三条路径
 *     都正确写 status / loaded_image / quarantine_* / audit
 *   - applyHealthSnapshot: 3 连续失败 → soft quarantine + 优先级选 reason;3 连续成功 →
 *     ready;hard quarantine 不被覆盖;维度未知不动相应 last_*
 *   - setQuarantined: hard 总 apply;hard 不被 soft 覆盖;soft 仅 priority 更高才覆盖;
 *     bootstrapping/draining/broken 跳过 status 修改
 *   - clearQuarantine / clearQuarantineByReason 行为
 *   - setLoadedImage 写 loaded_image_id/at + audit
 *   - listSchedulableHosts gate: desired_image_id NULL / loaded mismatch / 任一维度 stale 或
 *     ok=false / capacity 满 都过滤掉;name='self' 跳过维度新鲜度
 *
 * 不在本测试覆盖:
 *   - imagePromote 端到端(spawn docker)→ 由生产链路 + 上层服务测试覆盖
 *   - mTLS http 路径 → wsAgent / nodeHealth 等
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool, getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  markBootstrapResult,
  applyHealthSnapshot,
  setQuarantined,
  clearQuarantine,
  clearQuarantineByReason,
  setLoadedImage,
  listSchedulableHosts,
  getSchedulableHostById,
  setDraining,
  getHostById,
} from "../compute-pool/queries.js";
import { setDesiredImage } from "../compute-pool/poolState.js";
import { listAuditEventsForHost } from "../compute-pool/audit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "compute_host_audit",
  "compute_pool_state",
  "agent_containers",
  "agent_subscriptions",
  "agent_audit",
  "rate_limit_events",
  "admin_audit",
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
  "compute_hosts",
  "users",
  "schema_migrations",
];

let pgAvailable = false;

async function probe(): Promise<boolean> {
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
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
    } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // compute_hosts 因 0030 migration init self host;清掉非 self 行 + audit + pool state row
  await query(
    `TRUNCATE TABLE compute_host_audit, agent_containers RESTART IDENTITY CASCADE`,
  );
  await query(`DELETE FROM compute_hosts WHERE name <> 'self'`);
  // 0042 migration 已 INSERT singleton row;reset 字段
  await query(
    `UPDATE compute_pool_state
        SET desired_image_id = NULL,
            desired_image_tag = NULL,
            master_epoch = 0,
            updated_at = NOW()
      WHERE singleton = 'singleton'`,
  );
  // self host 也清掉新加的字段(保持每个 test 独立)
  await query(
    `UPDATE compute_hosts
        SET loaded_image_id = NULL, loaded_image_at = NULL,
            quarantine_reason_code = NULL, quarantine_reason_detail = NULL, quarantine_at = NULL,
            last_health_endpoint_ok = NULL, last_health_poll_at = NULL,
            last_uplink_ok = NULL, last_uplink_at = NULL,
            last_egress_probe_ok = NULL, last_egress_probe_at = NULL,
            consecutive_health_fail = 0, consecutive_health_ok = 0,
            status = 'ready'
      WHERE name = 'self'`,
  );
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not available");
    return true;
  }
  return false;
}

/**
 * 创建一个测试用 host(非 self)。AEAD 字段填非空 bytea 满足 compute_hosts_aead_nonempty。
 * 默认 status='bootstrapping' 与生产路径一致。返回 host id。
 */
async function insertTestHost(
  name: string,
  opts: {
    status?: string;
    maxContainers?: number;
    loadedImageId?: string | null;
    /** 直接给若干维度打 OK + NOW(),方便 placement gate 测试。 */
    healthy?: boolean;
  } = {},
): Promise<string> {
  const status = opts.status ?? "bootstrapping";
  const maxC = opts.maxContainers ?? 50;
  const loaded = opts.loadedImageId ?? null;
  const healthy = opts.healthy ?? false;
  const r = await query<{ id: string }>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status,
       loaded_image_id, loaded_image_at,
       last_health_endpoint_ok, last_health_poll_at,
       last_uplink_ok, last_uplink_at,
       last_egress_probe_ok, last_egress_probe_at
     )
     VALUES (
       $1, '10.0.0.1', 22, 'root', 9443,
       '\\x01'::bytea, '\\x01'::bytea,
       '\\x01'::bytea, '\\x01'::bytea,
       $2, '172.30.99.0/24', $3,
       $4, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END,
       $5, CASE WHEN $5::boolean IS NULL THEN NULL ELSE NOW() END,
       $5, CASE WHEN $5::boolean IS NULL THEN NULL ELSE NOW() END,
       $5, CASE WHEN $5::boolean IS NULL THEN NULL ELSE NOW() END
     )
     RETURNING id`,
    [name, maxC, status, loaded, healthy ? true : null],
  );
  return r.rows[0]!.id;
}

// ─── markBootstrapResult ────────────────────────────────────────────────

describe("markBootstrapResult", () => {
  test("success → ready + 写 loaded_image + audit", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-mb-1");
    const r = await markBootstrapResult(id, {
      success: true,
      loadedImage: { id: "sha256:aaa", tag: "openclaude-runtime:v3.0.42" },
      operationId: "op-mb-1",
      actor: "system:bootstrap",
    });
    assert.equal(r.status, "ready");
    const row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.loaded_image_id, "sha256:aaa");
    assert.ok(row!.loaded_image_at !== null);
    assert.equal(row!.quarantine_reason_code, null);
    assert.equal(row!.last_bootstrap_err, null);

    const events = await listAuditEventsForHost(getPool(), id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.operation, "bootstrap.result");
    assert.equal(events[0]!.operationId, "op-mb-1");
    assert.equal(events[0]!.actor, "system:bootstrap");
    assert.equal(events[0]!.detail.nextStatus, "ready");
    assert.equal(events[0]!.detail.loadedImageId, "sha256:aaa");
  });

  test("success + softQuarantine → quarantined + reason + audit", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-mb-2");
    const r = await markBootstrapResult(id, {
      success: true,
      loadedImage: { id: "sha256:bbb", tag: "tag" },
      softQuarantine: { reason: "egress-probe-failed", detail: "9444 unreachable" },
      operationId: "op-mb-2",
      actor: "system:bootstrap",
    });
    assert.equal(r.status, "quarantined");
    const row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "egress-probe-failed");
    assert.equal(row!.quarantine_reason_detail, "9444 unreachable");
    assert.ok(row!.quarantine_at !== null);
    // loaded_image 仍写(image 已就位,只是 egress 探活没过)
    assert.equal(row!.loaded_image_id, "sha256:bbb");
  });

  test("!success → broken + last_bootstrap_err,不动 loaded_image", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-mb-3", {
      loadedImageId: "sha256:old",
    });
    const r = await markBootstrapResult(id, {
      success: false,
      err: "ssh dial timeout",
      operationId: "op-mb-3",
      actor: "system:bootstrap",
    });
    assert.equal(r.status, "broken");
    const row = await getHostById(id);
    assert.equal(row!.status, "broken");
    assert.equal(row!.last_bootstrap_err, "ssh dial timeout");
    // loaded_image_id 不被覆盖(没传新 image)
    assert.equal(row!.loaded_image_id, "sha256:old");
    // 新失败路径 quarantine_* 应清空
    assert.equal(row!.quarantine_reason_code, null);
  });
});

// ─── applyHealthSnapshot ────────────────────────────────────────────────

describe("applyHealthSnapshot", () => {
  test("ready → 3 连续 endpoint fail → quarantined health-poll-fail", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-h-1", { status: "ready" });

    for (let i = 0; i < 2; i++) {
      const r = await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "ECONNREFUSED",
        operationId: `op-h-${i}`,
        actor: "system:health",
      });
      assert.equal(r.nextStatus, "ready", `iteration ${i} 仍应 ready`);
    }
    const last = await applyHealthSnapshot(id, {
      endpointOk: false,
      endpointErr: "ECONNREFUSED",
      operationId: "op-h-2",
      actor: "system:health",
    });
    assert.equal(last.nextStatus, "quarantined");
    assert.equal(last.appliedReason, "health-poll-fail");

    const row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "health-poll-fail");
  });

  test("3 连续多维度同时失败 → 选 priority 最高(uplink > health > egress)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-h-2", { status: "ready" });
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "endpoint err",
        uplinkOk: false,
        uplinkErr: "uplink err",
        egressOk: false,
        egressErr: "egress err",
        operationId: `op-x-${i}`,
        actor: "system:health",
      });
    }
    const row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(
      row!.quarantine_reason_code,
      "uplink-probe-failed",
      "uplink 失败应优先于 endpoint/egress",
    );
    assert.equal(row!.quarantine_reason_detail, "uplink err");
  });

  test("quarantined(soft)+ 3 连续 ok → ready + cleared", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-h-3", { status: "ready" });
    // 先打到 quarantined
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "x",
        operationId: `f-${i}`,
        actor: "system:health",
      });
    }
    let row = await getHostById(id);
    assert.equal(row!.status, "quarantined");

    // 三轮全 OK
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: true,
        operationId: `o-${i}`,
        actor: "system:health",
      });
    }
    row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.quarantine_reason_code, null);
    assert.equal(row!.quarantine_reason_detail, null);
    assert.equal(row!.quarantine_at, null);
  });

  test("hard quarantine 不被 health 自愈覆盖", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-h-4", { status: "ready" });
    // 直接置 hard quarantine
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "config id差异",
      operationId: "h-set",
      actor: "system:imagePromote",
    });
    let row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "image-mismatch");

    // 即使 endpoint 连续 OK 3 次也不该自愈到 ready
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: true,
        operationId: `ok-${i}`,
        actor: "system:health",
      });
    }
    row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "image-mismatch", "hard reason 必须保留");
    assert.equal(row!.last_health_endpoint_ok, true, "维度仍记录");
  });

  test("uplinkOk/egressOk undefined → 不更新对应 last_*", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-h-5", {
      status: "ready",
      healthy: true, // 预填 last_uplink_ok=true 等
    });
    // 仅传 endpointOk false
    await applyHealthSnapshot(id, {
      endpointOk: false,
      endpointErr: "x",
      operationId: "no-dim",
      actor: "system:health",
    });
    const row = await getHostById(id);
    // last_uplink_* / last_egress_* 应保持原值(true)
    assert.equal(row!.last_uplink_ok, true);
    assert.equal(row!.last_egress_probe_ok, true);
    // endpoint 这次写了
    assert.equal(row!.last_health_endpoint_ok, false);
  });
});

// ─── setQuarantined ────────────────────────────────────────────────────

describe("setQuarantined", () => {
  test("ready → hard 总 apply", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-q-1", { status: "ready" });
    const r = await setQuarantined(id, {
      reason: "image-distribute-failed",
      detail: "EPIPE",
      operationId: "op",
      actor: "system",
    });
    assert.equal(r.applied, true);
    assert.equal(r.previousStatus, "ready");
    assert.equal(r.nextStatus, "quarantined");
    const row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "image-distribute-failed");
  });

  test("hard → soft 不能覆盖", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-q-2", { status: "ready" });
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "h",
      operationId: "h",
      actor: "system",
    });
    const r = await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "s",
      operationId: "s",
      actor: "system",
    });
    assert.equal(r.applied, false);
    const row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "image-mismatch");
  });

  test("soft → soft:仅 priority 更高才覆盖", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-q-3", { status: "ready" });
    // 先放 egress(优先级 3)
    await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "old",
      operationId: "1",
      actor: "system",
    });
    // 试图替换为 health-poll-fail(优先级 2 < 3)→ 应 apply
    let r = await setQuarantined(id, {
      reason: "health-poll-fail",
      detail: "new",
      operationId: "2",
      actor: "system",
    });
    assert.equal(r.applied, true);
    let row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "health-poll-fail");

    // 再用更低优先级 egress 试图覆盖 → 不应 apply
    r = await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "lower",
      operationId: "3",
      actor: "system",
    });
    assert.equal(r.applied, false);
    row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "health-poll-fail");
  });

  test("bootstrapping/draining/broken 不动 status", async (t) => {
    if (skipIfNoDb(t)) return;
    for (const s of ["bootstrapping", "draining", "broken"] as const) {
      const id = await insertTestHost(`host-q-skip-${s}`, { status: s });
      const r = await setQuarantined(id, {
        reason: "image-mismatch",
        detail: "x",
        operationId: `op-${s}`,
        actor: "system",
      });
      assert.equal(r.applied, false, `${s} 不能被 setQuarantined 改 status`);
      assert.equal(r.nextStatus, s);
      const row = await getHostById(id);
      assert.equal(row!.status, s);
      assert.equal(row!.quarantine_reason_code, null);
    }
  });
});

// ─── clearQuarantine / clearQuarantineByReason ──────────────────────────

describe("clearQuarantine", () => {
  test("quarantined → ready,清 reason + 写 audit", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-c-1", { status: "ready" });
    await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "x",
      operationId: "1",
      actor: "system",
    });
    const ok = await clearQuarantine(id, { actor: "admin:1", operationId: "clr-1" });
    assert.equal(ok, true);
    const row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.quarantine_reason_code, null);
    assert.equal(row!.quarantine_reason_detail, null);
    assert.equal(row!.quarantine_at, null);

    const events = await listAuditEventsForHost(getPool(), id);
    assert.ok(events.some((e) => e.operation === "quarantine.clear"));
  });

  test("非 quarantined 状态 → 返 false,不动 row", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-c-2", { status: "ready" });
    const ok = await clearQuarantine(id, { actor: "admin:1" });
    assert.equal(ok, false);
    const row = await getHostById(id);
    assert.equal(row!.status, "ready");
  });
});

describe("clearQuarantineByReason", () => {
  test("当前 reason === 入参 reason → 清", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-cr-1", { status: "ready" });
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "x",
      operationId: "1",
      actor: "system",
    });
    const ok = await clearQuarantineByReason(id, "image-mismatch", { actor: "system:promote" });
    assert.equal(ok, true);
    const row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.quarantine_reason_code, null);
  });

  test("当前 reason !== 入参 → 不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-cr-2", { status: "ready" });
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "x",
      operationId: "1",
      actor: "system",
    });
    const ok = await clearQuarantineByReason(id, "image-distribute-failed", {
      actor: "system:promote",
    });
    assert.equal(ok, false);
    const row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "image-mismatch");
  });
});

// ─── setLoadedImage ────────────────────────────────────────────────────

describe("setLoadedImage", () => {
  test("写 loaded_image_id/at + audit operation='image.loaded'", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-li-1");
    await setLoadedImage(id, "sha256:zzz", "openclaude-runtime:v3.0.42", {
      actor: "system:imagePromote",
      operationId: "op-li-1",
      source: "distribute",
    });
    const row = await getHostById(id);
    assert.equal(row!.loaded_image_id, "sha256:zzz");
    assert.ok(row!.loaded_image_at !== null);
    const events = await listAuditEventsForHost(getPool(), id);
    const ev = events.find((e) => e.operation === "image.loaded");
    assert.ok(ev, "应有 image.loaded audit");
    assert.equal(ev!.detail.imageId, "sha256:zzz");
    assert.equal(ev!.detail.source, "distribute");
  });
});

// ─── listSchedulableHosts (placement gate) ─────────────────────────────

describe("listSchedulableHosts placement gate", () => {
  test("desired_image_id NULL → 空集(gate 关闭)", async (t) => {
    if (skipIfNoDb(t)) return;
    // 即使有 ready+健康 host 也应空集
    await insertTestHost("host-g-0", {
      status: "ready",
      loadedImageId: "sha256:any",
      healthy: true,
    });
    const r = await listSchedulableHosts();
    assert.equal(r.length, 0);
  });

  test("loaded_image_id 与 desired 不一致 → 排除", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:expected", "tag");
    const idMismatch = await insertTestHost("host-g-mm", {
      status: "ready",
      loadedImageId: "sha256:other",
      healthy: true,
    });
    const idMatch = await insertTestHost("host-g-ok", {
      status: "ready",
      loadedImageId: "sha256:expected",
      healthy: true,
    });
    const r = await listSchedulableHosts();
    const ids = r.map((h) => h.row.id);
    assert.ok(!ids.includes(idMismatch));
    assert.ok(ids.includes(idMatch));
  });

  test("任一维度 ok=false 排除", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-g-bad", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
    });
    // 把 uplink 设 false
    await query(
      `UPDATE compute_hosts SET last_uplink_ok = FALSE, last_uplink_at = NOW() WHERE id = $1`,
      [id],
    );
    const r = await listSchedulableHosts();
    assert.ok(!r.some((h) => h.row.id === id));
  });

  test("维度过期(>fresh window)排除", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-g-stale", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
    });
    // 把 last_egress_probe_at 推到 5 分钟前
    await query(
      `UPDATE compute_hosts SET last_egress_probe_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
      [id],
    );
    const r = await listSchedulableHosts();
    assert.ok(!r.some((h) => h.row.id === id));
  });

  test("name='self' 跳过维度新鲜度,但仍要求 loaded_image 一致", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    // self 行的 last_*_at 全 NULL,但 loaded_image_id 与 desired 一致 → 应入选
    await query(
      `UPDATE compute_hosts SET loaded_image_id='sha256:img', loaded_image_at=NOW(), status='ready' WHERE name='self'`,
    );
    const r = await listSchedulableHosts();
    assert.ok(r.some((h) => h.row.name === "self"), "self 应被纳入调度");

    // 把 self 的 loaded_image_id 改成不一致 → 应被排除
    await query(
      `UPDATE compute_hosts SET loaded_image_id='sha256:other' WHERE name='self'`,
    );
    const r2 = await listSchedulableHosts();
    assert.ok(!r2.some((h) => h.row.name === "self"), "self loaded mismatch 也要排除");
  });

  test("active_containers >= max_containers 过滤", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-g-full", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
      maxContainers: 1,
    });
    // 创建一个 user + active 容器占满 host
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@t.local`],
    );
    await query(
      `INSERT INTO agent_containers(user_id, host_uuid, bound_ip, state, secret_hash)
       VALUES ($1, $2, '172.30.99.10', 'active',
               decode('${"00".repeat(32)}', 'hex'))`,
      [Number.parseInt(u.rows[0]!.id, 10), id],
    );
    const r = await listSchedulableHosts();
    assert.ok(!r.some((h) => h.row.id === id));
  });
});

// ─── plan v4 round-2 — applyHealthSnapshot legacy field semantics ───────

describe("applyHealthSnapshot — legacy field 与 endpoint 维度一致(round-2)", () => {
  test("endpointOk=true + uplink=false → last_health_ok=true(endpoint 维度) + err=null", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-leg-1", { status: "ready" });
    await applyHealthSnapshot(id, {
      endpointOk: true,
      uplinkOk: false,
      uplinkErr: "uplink dial timeout",
      egressOk: true,
      operationId: "r2-leg-1",
      actor: "system:health",
    });
    const row = await getHostById(id);
    // last_health_ok 反映 endpoint 维度
    assert.equal(row!.last_health_ok, true, "last_health_ok 仅看 endpointOk");
    // last_health_err endpoint OK 时为 null,即使 uplink 出错
    assert.equal(row!.last_health_err, null, "endpoint OK 时 last_health_err=NULL,避免 ok=true/err=msg 不一致");
    // 维度细字段单独记录
    assert.equal(row!.last_uplink_ok, false);
  });

  test("endpointOk=false + 其他维度全 true → last_health_ok=false + err=endpointErr", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-leg-2", { status: "ready" });
    await applyHealthSnapshot(id, {
      endpointOk: false,
      endpointErr: "ECONNREFUSED",
      uplinkOk: true,
      egressOk: true,
      operationId: "r2-leg-2",
      actor: "system:health",
    });
    const row = await getHostById(id);
    assert.equal(row!.last_health_ok, false);
    assert.equal(row!.last_health_err, "ECONNREFUSED");
  });
});

// ─── plan v4 round-2 — applyHealthSnapshot consecutive_health_ok 严格 ───

describe("applyHealthSnapshot — consecutive_health_ok 严格(round-2)", () => {
  test("uplink/egress undefined → 不递增 consecutive_health_ok,quarantined 不被翻牌", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-strict-1", { status: "ready" });
    // 先打到 quarantined
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "x",
        operationId: `f-${i}`,
        actor: "system:health",
      });
    }
    let row = await getHostById(id);
    assert.equal(row!.status, "quarantined");

    // 仅传 endpointOk=true(uplink/egress undefined) — 旧实现会算 allOk=true 并递增
    // consecutive_health_ok,3 轮后 quarantined 翻 ready;新实现应保持 quarantined
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        // uplinkOk/egressOk 留空 = undefined
        operationId: `o-${i}`,
        actor: "system:health",
      });
    }
    row = await getHostById(id);
    assert.equal(
      row!.status,
      "quarantined",
      "缺数据(uplink/egress undefined)不应触发 quarantined→ready 自愈",
    );
    assert.equal(row!.consecutive_health_ok, 0, "未全报 → consecutive_health_ok 必须保持 0");
  });

  test("三维度全 true 才递增,3 连成功才回 ready", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-strict-2", { status: "ready" });
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "x",
        operationId: `f-${i}`,
        actor: "system:health",
      });
    }
    assert.equal((await getHostById(id))!.status, "quarantined");
    // 三维度全 true × 3
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: true,
        operationId: `ok-${i}`,
        actor: "system:health",
      });
    }
    const row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.quarantine_reason_code, null);
  });
});

// ─── plan v4 round-2 / Codex round-3 BLOCKER B —
// applyHealthSnapshot quarantined → quarantined reason 升级 ──────

describe("applyHealthSnapshot — soft reason 升级(round-2/round-3)", () => {
  test("quarantined+egress-probe-failed → 3 轮 uplink fail → 升级到 uplink-probe-failed", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r3-upg-1", { status: "ready" });
    // 先打成 egress-probe-failed:endpoint OK + uplink OK + egress fail × 3
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: false,
        egressErr: "egress fail",
        operationId: `eg-${i}`,
        actor: "system:health",
      });
    }
    let row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(row!.quarantine_reason_code, "egress-probe-failed");

    // 现在 uplink 也开始挂(egress 仍挂):endpoint OK + uplink fail + egress fail × 3
    // → uplink-probe-failed priority(1) > egress-probe-failed(3),应升级
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: false,
        uplinkErr: "uplink dead",
        egressOk: false,
        egressErr: "still bad",
        operationId: `up-${i}`,
        actor: "system:health",
      });
    }
    row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(
      row!.quarantine_reason_code,
      "uplink-probe-failed",
      "soft reason priority 升级:egress-probe-failed → uplink-probe-failed",
    );
    assert.equal(row!.quarantine_reason_detail, "uplink dead");
  });

  test("低优先级 reason 不能覆盖高优先级 reason", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r3-upg-2", { status: "ready" });
    // 先升到 uplink-probe-failed
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: false,
        uplinkErr: "uplink dead",
        egressOk: true,
        operationId: `u-${i}`,
        actor: "system:health",
      });
    }
    let row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "uplink-probe-failed");

    // 现在 uplink 恢复但 egress 挂 × 3 — 不应"降级"到 egress-probe-failed
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: false,
        egressErr: "egress now",
        operationId: `e-${i}`,
        actor: "system:health",
      });
    }
    row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(
      row!.quarantine_reason_code,
      "uplink-probe-failed",
      "uplink-probe-failed(prio 1)不被 egress-probe-failed(prio 3)覆盖",
    );
  });

  test("hard reason 已隔离 → 不被 soft reason 覆盖", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r3-upg-3", { status: "ready" });
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "hard",
      operationId: "h-1",
      actor: "system:test",
    });
    // 3 轮全维度失败 → 仍保持 image-mismatch hard reason
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: false,
        endpointErr: "x",
        uplinkOk: false,
        egressOk: false,
        operationId: `s-${i}`,
        actor: "system:health",
      });
    }
    const row = await getHostById(id);
    assert.equal(row!.status, "quarantined");
    assert.equal(
      row!.quarantine_reason_code,
      "image-mismatch",
      "hard reason 不被 soft 覆盖",
    );
  });

  test("reason 升级写一行 health.transition audit(reason-only)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r3-upg-4", { status: "ready" });
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: true,
        egressOk: false,
        egressErr: "e",
        operationId: `e-${i}`,
        actor: "system:health",
      });
    }
    for (let i = 0; i < 3; i++) {
      await applyHealthSnapshot(id, {
        endpointOk: true,
        uplinkOk: false,
        uplinkErr: "u",
        egressOk: false,
        operationId: `u-${i}`,
        actor: "system:health",
      });
    }
    const events = await listAuditEventsForHost(getPool(), id, 200);
    const transitions = events.filter((e) => e.operation === "health.transition");
    // 至少两条:ready→quarantined(egress)和 quarantined→quarantined(reason 升级到 uplink)
    assert.ok(
      transitions.length >= 2,
      `expected ≥2 health.transition rows, got ${transitions.length}`,
    );
    const upgrade = transitions.find(
      (e) =>
        (e.detail.previousReason as unknown) === "egress-probe-failed" &&
        (e.detail.nextReason as unknown) === "uplink-probe-failed",
    );
    assert.ok(upgrade, "应有一条 reason-only upgrade 的 transition 行");
  });
});

// ─── plan v4 round-2 — applyHealthSnapshot loadedImageId 写回保护 ──────

describe("applyHealthSnapshot — loadedImageId 写回保护(round-2)", () => {
  test("loadedImageId undefined → 保留 DB 已知值(不清成 NULL)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-img-1", {
      status: "ready",
      loadedImageId: "sha256:dbknown",
    });
    await applyHealthSnapshot(id, {
      endpointOk: true,
      uplinkOk: true,
      egressOk: true,
      // loadedImageId 字段不传 = undefined
      operationId: "r2-img-1",
      actor: "system:health",
    });
    const row = await getHostById(id);
    assert.equal(
      row!.loaded_image_id,
      "sha256:dbknown",
      "agent 未报 loadedImageId 时不能把 DB 已知值清成 NULL",
    );
  });

  test("loadedImageId string 且与 DB 不同 → 写回 + 更新 loaded_image_at", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-img-2", {
      status: "ready",
      loadedImageId: "sha256:old",
    });
    // 把 loaded_image_at 推到很久以前,验证写回时被刷新
    await query(
      `UPDATE compute_hosts SET loaded_image_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [id],
    );
    const before = await getHostById(id);
    const oldAt = before!.loaded_image_at;

    await applyHealthSnapshot(id, {
      endpointOk: true,
      uplinkOk: true,
      egressOk: true,
      loadedImageId: "sha256:fresh",
      operationId: "r2-img-2",
      actor: "system:health",
    });
    const row = await getHostById(id);
    assert.equal(row!.loaded_image_id, "sha256:fresh");
    assert.ok(row!.loaded_image_at !== null);
    assert.ok(
      row!.loaded_image_at!.getTime() > (oldAt?.getTime() ?? 0),
      "loaded_image_at 应被刷新到 NOW()",
    );
  });

  test("loadedImageId string 与 DB 相同 → 不更新 loaded_image_at(避免无谓刷新)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-img-3", {
      status: "ready",
      loadedImageId: "sha256:same",
    });
    await query(
      `UPDATE compute_hosts SET loaded_image_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [id],
    );
    const before = await getHostById(id);
    const oldAt = before!.loaded_image_at;

    await applyHealthSnapshot(id, {
      endpointOk: true,
      uplinkOk: true,
      egressOk: true,
      loadedImageId: "sha256:same",
      operationId: "r2-img-3",
      actor: "system:health",
    });
    const row = await getHostById(id);
    assert.equal(row!.loaded_image_id, "sha256:same");
    assert.equal(
      row!.loaded_image_at?.getTime(),
      oldAt?.getTime(),
      "id 未变 → loaded_image_at 不应被刷新(避免无意义 churn)",
    );
  });
});

// ─── plan v4 round-2 — clearQuarantine audit previousReason ────────────

describe("clearQuarantine — audit previousReason(round-2)", () => {
  test("audit detail.previousReason 是 UPDATE 前的真实 reason(非 NULL)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-clr-1", { status: "ready" });
    await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "9444 unreachable",
      operationId: "set-1",
      actor: "system:test",
    });
    const ok = await clearQuarantine(id, { actor: "admin:42", operationId: "clr-r2-1" });
    assert.equal(ok, true);

    const events = await listAuditEventsForHost(getPool(), id);
    const ev = events.find(
      (e) => e.operation === "quarantine.clear" && e.operationId === "clr-r2-1",
    );
    assert.ok(ev, "应有 clear 审计行");
    assert.equal(
      ev!.detail.previousReason,
      "egress-probe-failed",
      "previousReason 必须是 UPDATE 前的值(SELECT FOR UPDATE 拿到),不能 NULL",
    );
  });
});

// ─── plan v4 round-2 — setDraining 状态机 + audit ──────────────────────

describe("setDraining(round-2)", () => {
  test("ready → draining,audit detail.from='ready'", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-drn-1", { status: "ready" });
    const ok = await setDraining(id, { actor: "admin:1", operationId: "drn-1" });
    assert.equal(ok, true);
    const row = await getHostById(id);
    assert.equal(row!.status, "draining");
    const events = await listAuditEventsForHost(getPool(), id);
    const ev = events.find(
      (e) => e.operation === "admin.set-draining" && e.operationId === "drn-1",
    );
    assert.ok(ev);
    assert.equal(
      ev!.detail.from,
      "ready",
      "detail.from 必须是 UPDATE 前的 status(两步 tx 拿 SELECT FOR UPDATE)",
    );
    assert.equal(ev!.detail.to, "draining");
  });

  test("quarantined → draining + audit detail.from='quarantined'", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-drn-2", { status: "ready" });
    await setQuarantined(id, {
      reason: "image-mismatch",
      detail: "x",
      operationId: "qq",
      actor: "system",
    });
    const ok = await setDraining(id, { actor: "admin:1", operationId: "drn-2" });
    assert.equal(ok, true);
    const events = await listAuditEventsForHost(getPool(), id);
    const ev = events.find(
      (e) => e.operation === "admin.set-draining" && e.operationId === "drn-2",
    );
    assert.equal(
      ev!.detail.from,
      "quarantined",
      "draining 之前是 quarantined,不能因 UPDATE 后再 SELECT 而失真为 draining",
    );
  });

  test("broken → draining(允许 admin 把 broken 节点切到 draining 走下架流程)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-drn-3", { status: "broken" });
    const ok = await setDraining(id, { actor: "admin:1", operationId: "drn-3" });
    assert.equal(ok, true);
    const row = await getHostById(id);
    assert.equal(row!.status, "draining");
  });

  test("bootstrapping → 拒绝(返 false,不 audit,不动 row)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-drn-4", { status: "bootstrapping" });
    const ok = await setDraining(id, { actor: "admin:1", operationId: "drn-4" });
    assert.equal(ok, false);
    const row = await getHostById(id);
    assert.equal(row!.status, "bootstrapping");
    const events = await listAuditEventsForHost(getPool(), id);
    assert.equal(
      events.filter((e) => e.operation === "admin.set-draining").length,
      0,
      "失败的 setDraining 不应留 audit",
    );
  });

  test("draining 已是 draining → 拒绝(idempotency 不能伪造 transition)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await insertTestHost("host-r2-drn-5", { status: "draining" });
    const ok = await setDraining(id, { actor: "admin:1", operationId: "drn-5" });
    assert.equal(ok, false);
  });

  test("id 不存在 → 返 false", async (t) => {
    if (skipIfNoDb(t)) return;
    const ok = await setDraining("00000000-0000-0000-0000-000000000999", {
      actor: "admin:1",
      operationId: "drn-6",
    });
    assert.equal(ok, false);
  });
});

// ─── plan v4 round-2 — getSchedulableHostById ──────────────────────────

describe("getSchedulableHostById(round-2)", () => {
  test("通过 gate → 返回 row + activeContainers", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-r2-gby-1", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
    });
    const r = await getSchedulableHostById(id);
    assert.ok(r, "通过 gate 时应返 SchedulableHost");
    assert.equal(r!.row.id, id);
    assert.equal(typeof r!.activeContainers, "number");
  });

  test("status='quarantined' → null(gate fail)", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-r2-gby-2", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
    });
    await setQuarantined(id, {
      reason: "egress-probe-failed",
      detail: "x",
      operationId: "q",
      actor: "system",
    });
    const r = await getSchedulableHostById(id);
    assert.equal(r, null);
  });

  test("loaded_image_id 与 desired 不一致 → null", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:want", "tag");
    const id = await insertTestHost("host-r2-gby-3", {
      status: "ready",
      loadedImageId: "sha256:other",
      healthy: true,
    });
    const r = await getSchedulableHostById(id);
    assert.equal(r, null);
  });

  test("uplink stale(>fresh window)→ null", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-r2-gby-4", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
    });
    await query(
      `UPDATE compute_hosts SET last_uplink_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
      [id],
    );
    const r = await getSchedulableHostById(id);
    assert.equal(r, null);
  });

  test("name='self' 即使 dim 全 NULL,只要 loaded_image 对齐就通过", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    await query(
      `UPDATE compute_hosts SET loaded_image_id='sha256:img', loaded_image_at=NOW(), status='ready' WHERE name='self'`,
    );
    const selfRow = await query<{ id: string }>(`SELECT id FROM compute_hosts WHERE name='self'`);
    const selfId = selfRow.rows[0]!.id;
    const r = await getSchedulableHostById(selfId);
    assert.ok(r, "self host dim NULL 也应通过 gate");
    assert.equal(r!.row.name, "self");
  });

  test("capacity 满仍返 row(由 caller 决定 throw busy / fall-through)", async (t) => {
    if (skipIfNoDb(t)) return;
    await setDesiredImage("sha256:img", "tag");
    const id = await insertTestHost("host-r2-gby-6", {
      status: "ready",
      loadedImageId: "sha256:img",
      healthy: true,
      maxContainers: 1,
    });
    // 占满
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`gby-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@t.local`],
    );
    await query(
      `INSERT INTO agent_containers(user_id, host_uuid, bound_ip, state, secret_hash)
       VALUES ($1, $2, '172.30.99.10', 'active',
               decode('${"00".repeat(32)}', 'hex'))`,
      [Number.parseInt(u.rows[0]!.id, 10), id],
    );
    const r = await getSchedulableHostById(id);
    assert.ok(r, "capacity-full 仍要返回 row(差别于 listSchedulableHosts 整体过滤)");
    assert.equal(r!.activeContainers, 1);
    assert.equal(r!.row.max_containers, 1);
  });

  test("id 不存在 → null", async (t) => {
    if (skipIfNoDb(t)) return;
    const r = await getSchedulableHostById("00000000-0000-0000-0000-000000000999");
    assert.equal(r, null);
  });
});

// ─── plan v4 round-2 — clearQuarantineByReason 兼容 hard reason ────────

describe("clearQuarantineByReason — hard reason(round-2)", () => {
  test("runtime-image-missing 可被 clearQuarantineByReason 清(imagePromote 路径)", async (t) => {
    if (skipIfNoDb(t)) return;
    // imagePromote round-2 BLOCKER 2: distribute 成功后清 runtime-image-missing
    const id = await insertTestHost("host-r2-cqr-1", { status: "ready" });
    await setQuarantined(id, {
      reason: "runtime-image-missing",
      detail: "ImageNotFound at docker run",
      operationId: "set",
      actor: "system",
    });
    let row = await getHostById(id);
    assert.equal(row!.quarantine_reason_code, "runtime-image-missing");

    const ok = await clearQuarantineByReason(id, "runtime-image-missing", {
      actor: "system:imagePromote",
      operationId: "promote-cleared",
    });
    assert.equal(ok, true);
    row = await getHostById(id);
    assert.equal(row!.status, "ready");
    assert.equal(row!.quarantine_reason_code, null);
  });
});
