/**
 * v5 自愈批1b 集成测试(octest PG,真迁移 schema)——放行→部署 durable async。
 *
 *   §6.1 adminReleaseRepair 202 异步:pending_release 结构化门(malformed→400)/ 熔断门(423)/
 *        202 → 请求行 durable / 唯一活跃约束(重复放行 409)。
 *   §4   回调分流(detail.releaseRequestId):deploying→request deploying(repair 不动)/
 *        deployed→repair running→verifying(verify_after set)/ deploy_failed→repair 不动 /
 *        deploy_unknown→熔断 engage + 阻新放行 / manual_required→repair 不动 / 未知 rrid→200 仅事件。
 *   §6.3 getReleaseRequest / incident detail releaseRequests[] / fuse clear 审计(§3.3 收敛前的 v5 侧)。
 *   §3   resolve 与 deploying 请求互斥。
 *
 * pg 不可用时 skip。断言=行为(HTTP 码 + DB round-trip),非源码 regex。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { issueCapability } from "../selfheal/capability.js";
import { resolveIncident } from "../selfheal/incidents.js";
import { dispatchSelfhealRepairsRoute } from "../http/internal/selfhealRepairs.js";
import {
  adminReleaseRepair,
  adminResolveIncident,
  getReleaseRequest,
  getReleaseFuse,
  clearReleaseFuse,
  getIncidentDetail,
} from "../admin/selfhealOps.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
let pgAvailable = false;
let adminId = "0";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PLAN_HASH = "c".repeat(64);
const MANIFEST_HASH = "d".repeat(64);

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7b).toString("base64");
  process.env.OC_SELFHEAL_MASTER_SECRET = "b1b-integ-master-secret-0123456789";
  process.env.OC_SELFHEAL_WEBHOOK_HMAC = "b1b-integ-webhook-secret-0123456789";
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
     VALUES ('selfheal-b1b-admin@test.local', 'argon2$stub', 0, 'admin', 'active')
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
             selfheal_capability_uses, selfheal_webhook_nonces, selfheal_release_requests,
             selfheal_release_fuse_epochs, admin_audit
     RESTART IDENTITY CASCADE`,
  );
  // fuse 是单例行(migration seed),不 TRUNCATE,复位其字段。
  await query(
    `UPDATE selfheal_release_fuse
        SET engaged=FALSE, reason=NULL, release_request_id=NULL, engaged_at=NULL, engaged_by=NULL,
            cleared_at=NULL, cleared_by=NULL, personal_ack_at=NULL WHERE id=1`,
  );
  await query(`INSERT INTO selfheal_release_fuse (id, engaged) VALUES (1, FALSE) ON CONFLICT DO NOTHING`);
}

beforeEach(async () => { if (pgAvailable) await cleanup(); });

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

const adminInput = (eventId = "1") => ({
  adminId,
  ip: "127.0.0.1",
  userAgent: "integ",
  expectedPendingReleaseEventId: eventId,
});

// ─── fixtures ──────────────────────────────────────────────────────────

interface Seeded { incidentId: string; repairId: string; eventId: string | null; }

async function seedPendingRelease(
  opts: { status?: string; detail?: Record<string, unknown> | null; key?: string } = {},
): Promise<Seeded> {
  const key = opts.key ?? "k.b1b";
  const inc = await query<{ id: string }>(
    `INSERT INTO incidents (dedupe_key, condition_key, status, severity, surface, audience, user_title, user_message)
     VALUES ($1,$1,'repairing','critical','global','all','t','m') RETURNING id::text AS id`,
    [key],
  );
  const incidentId = inc.rows[0].id;
  const rep = await query<{ id: string }>(
    `INSERT INTO codex_repairs (incident_id, status, attempt, tier, dispatched_at)
     VALUES ($1::bigint, $2, 1, 'tier2', NOW()) RETURNING id::text AS id`,
    [incidentId, opts.status ?? "running"],
  );
  const repairId = rep.rows[0].id;
  const detail =
    opts.detail === null
      ? null
      : opts.detail ?? {
          phase: "pending_release", sha: SHA_A, baseSha: SHA_B,
          deployPlanHash: PLAN_HASH, manifestHash: MANIFEST_HASH,
          classification: { surfaces: ["master"] },
        };
  let eventId: string | null = null;
  if (detail) {
    const event = await query<{ id: string }>(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', '修复已验证,等待放行部署', $2::jsonb)
       RETURNING id::text AS id`,
      [repairId, JSON.stringify(detail)],
    );
    eventId = event.rows[0].id;
  }
  return { incidentId, repairId, eventId };
}

// ─── HTTP mocks(release callback 走 dispatchSelfhealRepairsRoute)────────

function mockReq(opts: { method: string; url: string; headers?: Record<string, string>; body?: string }): IncomingMessage {
  const r = Readable.from(opts.body !== undefined ? [Buffer.from(opts.body)] : []) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {};
  (r as unknown as { method: string }).method = opts.method;
  (r as unknown as { url: string }).url = opts.url;
  (r as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  return r;
}
function mockRes(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: "" };
  const res = {
    statusCode: 0,
    setHeader() { /* noop */ },
    end(b?: string) { captured.status = (res as unknown as { statusCode: number }).statusCode; captured.body = b ?? ""; },
  } as unknown as ServerResponse;
  return { res, captured };
}

/** POST 一次 release 回调(action=progress|done|failed;detail 带 releaseRequestId+releasePhase)。 */
async function releaseCallback(
  repairId: string,
  action: "progress" | "done" | "failed",
  detail: Record<string, unknown>,
  message = "release callback",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = issueCapability(repairId, 1).token;
  const req = mockReq({
    method: "POST",
    url: `/internal/v5/repairs/${repairId}/${action}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message, detail }),
  });
  const { res, captured } = mockRes();
  await dispatchSelfhealRepairsRoute(req, res, {} as never, {} as never);
  let json: Record<string, unknown> = {};
  try { json = captured.body ? JSON.parse(captured.body) : {}; } catch { /* */ }
  return { status: captured.status, json };
}

async function requestStatus(rrid: string): Promise<string | null> {
  const r = await query<{ status: string }>(
    `SELECT status FROM selfheal_release_requests WHERE release_request_id=$1`, [rrid]);
  return r.rows[0]?.status ?? null;
}
async function repairStatus(id: string): Promise<string> {
  const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
  return r.rows[0].status;
}
async function fuseEngaged(): Promise<boolean> {
  const r = await query<{ engaged: boolean }>(`SELECT engaged FROM selfheal_release_fuse WHERE id=1`);
  return r.rows[0].engaged;
}

function deployedReceipt(repairId: string, rrid: string): Record<string, unknown> {
  return {
    releaseRequestId: rrid,
    releasePhase: "deployed",
    approvedSha: SHA_A,
    planHash: PLAN_HASH,
    manifestHash: MANIFEST_HASH,
    candidateRef: `refs/heads/selfheal/candidates/${repairId}-${SHA_A.slice(0, 12)}`,
    proofs: { master: { ok: true } },
  };
}

// ═══ §6.1 — adminReleaseRepair 202 异步放行门 ═══════════════════════════

describe("§6.1 放行门(202 异步)", () => {
  test("pending_release 门通过 → 202 queued + durable 请求行(冻结字段来自事件 detail)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const r = await adminReleaseRepair(repairId, adminInput(eventId!));
    assert.equal(r.outcome, "queued");
    assert.ok(r.releaseRequestId, "返回 rrid");
    const row = await query<{
      status: string; approved_sha: string; base_sha: string | null;
      deploy_plan_hash: string; manifest_hash: string; incident_id: string; requested_by: string;
      source_event_id: string;
    }>(
      `SELECT status, approved_sha, base_sha, deploy_plan_hash, manifest_hash,
              incident_id::text AS incident_id, requested_by, source_event_id::text AS source_event_id
         FROM selfheal_release_requests WHERE release_request_id=$1`, [r.releaseRequestId]);
    assert.equal(row.rows[0].status, "queued");
    assert.equal(row.rows[0].approved_sha, SHA_A);
    assert.equal(row.rows[0].base_sha, SHA_B);
    assert.equal(row.rows[0].deploy_plan_hash, PLAN_HASH);
    assert.equal(row.rows[0].manifest_hash, MANIFEST_HASH);
    assert.equal(row.rows[0].incident_id, incidentId);
    assert.equal(row.rows[0].requested_by, adminId);
    assert.equal(row.rows[0].source_event_id, eventId);
    // 永久审计 outcome=queued 含 rrid。
    const a = await query<{ outcome: string | null; rrid: string | null }>(
      `SELECT after->>'outcome' AS outcome, after->>'release_request_id' AS rrid
         FROM admin_audit WHERE action='repair.release' ORDER BY id DESC LIMIT 1`);
    assert.equal(a.rows[0].outcome, "queued");
    assert.equal(a.rows[0].rrid, r.releaseRequestId);
  });

  test("source event 是全状态幂等键:重复放行返回原 rrid,零新增行/审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, eventId } = await seedPendingRelease();
    const first = await adminReleaseRepair(repairId, adminInput(eventId!));
    assert.equal(first.outcome, "queued");
    await query(
      `UPDATE selfheal_release_requests SET status='deploy_failed', resolved_at=NOW()
        WHERE release_request_id=$1`,
      [first.releaseRequestId],
    );
    await query(
      `UPDATE codex_repairs SET status='verifying', updated_at=NOW() WHERE id=$1::bigint`,
      [repairId],
    );
    await query(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'later candidate', $2::jsonb)`,
      [repairId, JSON.stringify({
        phase: "pending_release", sha: "e".repeat(40), baseSha: SHA_A,
        deployPlanHash: "f".repeat(64), manifestHash: "1".repeat(64),
        classification: { surfaces: ["master"] },
      })],
    );
    const again = await adminReleaseRepair(repairId, adminInput(eventId!));
    assert.equal(again.outcome, "existing");
    assert.equal(again.releaseRequestId, first.releaseRequestId);
    assert.equal(again.status, "deploy_failed");
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_release_requests`);
    assert.equal(n.rows[0].n, "1");
    const audits = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='repair.release'`,
    );
    assert.equal(audits.rows[0].n, "1", "幂等重试不重复写审批审计");
  });

  test("升级窗口旧 writer:省略 source_event_id 时 DB trigger 自动绑定 exact event", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const legacy = await query<{ release_request_id: string }>(
      `INSERT INTO selfheal_release_requests
         (repair_id, incident_id, requested_by, approved_sha, base_sha,
          deploy_plan_hash, manifest_hash, plan_detail, status)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,'deploy_failed')
       RETURNING release_request_id`,
      [
        repairId, incidentId, adminId, SHA_A, SHA_B, PLAN_HASH, MANIFEST_HASH,
        JSON.stringify({ phase: "pending_release", classification: { surfaces: ["master"] } }),
      ],
    );
    const bound = await query<{ source_event_id: string }>(
      `SELECT source_event_id::text AS source_event_id
         FROM selfheal_release_requests WHERE release_request_id=$1`,
      [legacy.rows[0].release_request_id],
    );
    assert.equal(bound.rows[0].source_event_id, eventId);
    await assert.rejects(
      query(
        `INSERT INTO selfheal_release_requests
           (repair_id, incident_id, requested_by, approved_sha, base_sha,
            deploy_plan_hash, manifest_hash, plan_detail, status)
         VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,'deploy_failed')`,
        [
          repairId, incidentId, adminId, SHA_A, SHA_B, PLAN_HASH, MANIFEST_HASH,
          JSON.stringify({ phase: "pending_release", classification: { surfaces: ["master"] } }),
        ],
      ),
      (err: unknown) => (err as { code?: string }).code === "23505",
      "old writer retry binds the same source event and is rejected by unique index",
    );
    const recovered = await adminReleaseRepair(repairId, adminInput(eventId!));
    assert.equal(recovered.outcome, "existing");
    assert.equal(recovered.releaseRequestId, legacy.rows[0].release_request_id);
    assert.equal(recovered.status, "deploy_failed");
    const rows = await query<{ n: string; source_event_id: string }>(
      `SELECT COUNT(*)::text AS n, MAX(source_event_id)::text AS source_event_id
         FROM selfheal_release_requests`,
    );
    assert.equal(rows.rows[0].n, "1");
    assert.equal(rows.rows[0].source_event_id, eventId);
    const audits = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='repair.release'`,
    );
    assert.equal(audits.rows[0].n, "0", "旧请求恢复不伪造一次新的人工审批");
  });

  test("pre-migration NULL source row 的 exact response-loss retry 被 runtime 原子补绑", async (t) => {
    if (skipIfNoPg(t)) return;
    const seeded = await seedPendingRelease();
    const legacy = await query<{ release_request_id: string }>(
      `INSERT INTO selfheal_release_requests
         (repair_id, incident_id, requested_by, approved_sha, base_sha,
          deploy_plan_hash, manifest_hash, plan_detail, status, source_event_id)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,$7,'{}'::jsonb,'deploy_failed',$8::bigint)
       RETURNING release_request_id`,
      [
        seeded.repairId, seeded.incidentId, adminId, SHA_A, SHA_B,
        PLAN_HASH, MANIFEST_HASH, seeded.eventId,
      ],
    );
    await query(
      `UPDATE selfheal_release_requests SET source_event_id=NULL
        WHERE release_request_id=$1`,
      [legacy.rows[0].release_request_id],
    );
    const recovered = await adminReleaseRepair(
      seeded.repairId,
      adminInput(seeded.eventId!),
    );
    assert.equal(recovered.outcome, "existing");
    assert.equal(recovered.releaseRequestId, legacy.rows[0].release_request_id);
    const rebound = await query<{ source_event_id: string }>(
      `SELECT source_event_id::text AS source_event_id
         FROM selfheal_release_requests WHERE release_request_id=$1`,
      [legacy.rows[0].release_request_id],
    );
    assert.equal(rebound.rows[0].source_event_id, seeded.eventId);
  });

  test("legacy fallback 不把 E1 的同 tuple 老请求误绑到后来 E2", async (t) => {
    if (skipIfNoPg(t)) return;
    const seeded = await seedPendingRelease();
    const old = await query<{ release_request_id: string }>(
      `INSERT INTO selfheal_release_requests
         (repair_id, incident_id, requested_by, approved_sha, base_sha,
          deploy_plan_hash, manifest_hash, plan_detail, status, source_event_id, created_at)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,'deploy_failed',$9::bigint,
               NOW() - INTERVAL '1 minute')
       RETURNING release_request_id`,
      [
        seeded.repairId, seeded.incidentId, adminId, SHA_A, SHA_B, PLAN_HASH, MANIFEST_HASH,
        JSON.stringify({ phase: "pending_release", classification: { surfaces: ["master"] } }),
        seeded.eventId,
      ],
    );
    await query(
      `UPDATE selfheal_release_requests SET source_event_id=NULL
        WHERE release_request_id=$1`,
      [old.rows[0].release_request_id],
    );
    const e2 = await query<{ id: string }>(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'same tuple, new review', $2::jsonb)
       RETURNING id::text AS id`,
      [seeded.repairId, JSON.stringify({
        phase: "pending_release", sha: SHA_A, baseSha: SHA_B,
        deployPlanHash: PLAN_HASH, manifestHash: MANIFEST_HASH,
        classification: { surfaces: ["master"] },
      })],
    );
    const approved = await adminReleaseRepair(seeded.repairId, adminInput(e2.rows[0].id));
    assert.equal(approved.outcome, "queued");
    assert.notEqual(approved.releaseRequestId, old.rows[0].release_request_id);
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM selfheal_release_requests`,
    );
    assert.equal(rows.rows[0].n, "2");
  });

  test("审批 exact event:页面看到 E1 后追加 E2，旧 E1 放行 409 语义且零请求/审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const seeded = await seedPendingRelease();
    const newer = await query<{ id: string }>(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'new candidate', $2::jsonb)
       RETURNING id::text AS id`,
      [seeded.repairId, JSON.stringify({
        phase: "pending_release",
        sha: "e".repeat(40),
        baseSha: SHA_A,
        deployPlanHash: "f".repeat(64),
        manifestHash: "1".repeat(64),
        classification: { surfaces: ["master"] },
      })],
    );
    const stale = await adminReleaseRepair(seeded.repairId, adminInput(seeded.eventId!));
    assert.equal(stale.outcome, "conflict");
    const none = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_release_requests`);
    assert.equal(none.rows[0].n, "0");
    const audits = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='repair.release'`,
    );
    assert.equal(audits.rows[0].n, "0");
    assert.equal(
      (await adminReleaseRepair(seeded.repairId, adminInput(newer.rows[0].id))).outcome,
      "queued",
    );
  });

  test("malformed pending_release(缺 hash / sha 非 40hex)→ malformed", async (t) => {
    if (skipIfNoPg(t)) return;
    const bad = await seedPendingRelease({ detail: { phase: "pending_release", sha: "abc123" } });
    assert.equal((await adminReleaseRepair(bad.repairId, adminInput(bad.eventId!))).outcome, "malformed");
    await cleanup();
    const noHash = await seedPendingRelease({
      detail: { phase: "pending_release", sha: SHA_A, deployPlanHash: PLAN_HASH },
    });
    assert.equal((await adminReleaseRepair(noHash.repairId, adminInput(noHash.eventId!))).outcome, "malformed");
    await cleanup();
    const badDigest = await seedPendingRelease({
      detail: {
        phase: "pending_release",
        sha: SHA_A,
        deployPlanHash: "g".repeat(64),
        manifestHash: "d".repeat(63),
      },
    });
    assert.equal(
      (await adminReleaseRepair(badDigest.repairId, adminInput(badDigest.eventId!))).outcome,
      "malformed",
    );
  });

  test("DB 直插也拒绝非 64hex frozen hash", async (t) => {
    if (skipIfNoPg(t)) return;
    const seeded = await seedPendingRelease();
    await assert.rejects(
      query(
        `INSERT INTO selfheal_release_requests
           (repair_id, incident_id, requested_by, approved_sha, base_sha,
            deploy_plan_hash, manifest_hash, plan_detail, source_event_id)
         VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,$7,'{}'::jsonb,$8::bigint)`,
        [
          seeded.repairId, seeded.incidentId, adminId, SHA_A, SHA_B,
          "z".repeat(64), MANIFEST_HASH, seeded.eventId,
        ],
      ),
      (err: unknown) => (err as { code?: string }).code === "23514",
    );
    await assert.rejects(
      query(
        `INSERT INTO selfheal_release_requests
           (repair_id, incident_id, requested_by, approved_sha, base_sha,
            deploy_plan_hash, manifest_hash, plan_detail, source_event_id)
         VALUES ($1::bigint,$2::bigint,$3,$4,$5,NULL,$6,'{}'::jsonb,$7::bigint)`,
        [seeded.repairId, seeded.incidentId, adminId, SHA_A, SHA_B, MANIFEST_HASH, seeded.eventId],
      ),
      (err: unknown) => (err as { code?: string }).code === "23514",
      "SQL CHECK must reject UNKNOWN/NULL for a source-bound frozen hash",
    );
  });

  test("无 pending_release 事件 / 非 running / 不存在 → conflict|not_found;零请求行零审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const noEvent = await seedPendingRelease({ detail: null });
    assert.equal((await adminReleaseRepair(noEvent.repairId, adminInput())).outcome, "conflict");
    await cleanup();
    const notRunning = await seedPendingRelease({ status: "verifying" });
    assert.equal((await adminReleaseRepair(notRunning.repairId, adminInput(notRunning.eventId!))).outcome, "conflict");
    assert.equal((await adminReleaseRepair("999999", adminInput())).outcome, "not_found");
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_release_requests`);
    assert.equal(n.rows[0].n, "0");
    const a = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='repair.release'`);
    assert.equal(a.rows[0].n, "0", "被拒路径零审计");
  });

  test("熔断 engaged → fuse_engaged(禁再放行)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, eventId } = await seedPendingRelease();
    await query(`UPDATE selfheal_release_fuse
                    SET engaged=TRUE, release_request_id='fuse-test', engaged_at=NOW() WHERE id=1`);
    assert.equal((await adminReleaseRepair(repairId, adminInput(eventId!))).outcome, "fuse_engaged");
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_release_requests`);
    assert.equal(n.rows[0].n, "0", "熔断时不建请求行");
  });
});

// ═══ §4 — 回调分流(detail.releaseRequestId)═══════════════════════════

describe("§4 回调分流", () => {
  async function seedQueuedRelease(): Promise<{ repairId: string; rrid: string; incidentId: string }> {
    const s = await seedPendingRelease();
    const r = await adminReleaseRepair(s.repairId, adminInput(s.eventId!));
    return { repairId: s.repairId, rrid: r.releaseRequestId!, incidentId: s.incidentId };
  }

  test("deploying(progress)→ request deploying,repair 仍 running", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    const cb = await releaseCallback(repairId, "progress", { releaseRequestId: rrid, releasePhase: "deploying" });
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deploying");
    assert.equal(await repairStatus(repairId), "running", "deploying 不动 repair");
  });

  test("deployed(done)→ request deployed + repair running→verifying(verify_after set)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    const cb = await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deployed");
    assert.equal(await repairStatus(repairId), "verifying", "deployed 收口 repair 到 verifying");
    const va = await query<{ verify_after: Date | null }>(
      `SELECT verify_after FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.ok(va.rows[0].verify_after, "verify_after 已 set");
    // getReleaseRequest 关联 events(detail.releaseRequestId=rrid)。
    const detail = await getReleaseRequest(rrid);
    assert.ok(detail);
    assert.equal(detail!.request.status, "deployed");
    assert.ok(detail!.events.length >= 1, "关联到 release 事件");
  });

  test("deployed + canonicalPush pending → 仍 deployed/verifying，但 V5 镜像 exact fuse", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    const receipt = deployedReceipt(repairId, rrid);
    receipt.canonicalPush = "pending";
    const cb = await releaseCallback(repairId, "done", receipt);
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deployed");
    assert.equal(await repairStatus(repairId), "verifying");
    assert.equal(await fuseEngaged(), true);
    const epoch = await query<{ reason: string; cleared_at: Date | null }>(
      `SELECT reason, cleared_at FROM selfheal_release_fuse_epochs
        WHERE release_request_id=$1`,
      [rrid],
    );
    assert.equal(epoch.rows[0].reason, "canonical_push_pending");
    assert.equal(epoch.rows[0].cleared_at, null);
  });

  test("deployed receipt 缺/错 frozen tuple 或计划 proof → deploy_unknown+fuse,不推进 repair", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    const invalid = deployedReceipt(repairId, rrid);
    invalid.planHash = "0".repeat(64);
    invalid.proofs = {};
    const cb = await releaseCallback(repairId, "done", invalid);
    assert.equal(cb.status, 200);
    assert.equal(cb.json.status, "deploy_unknown");
    assert.equal(await requestStatus(rrid), "deploy_unknown");
    assert.equal(await repairStatus(repairId), "running");
    assert.equal(await fuseEngaged(), true);
  });

  test("已终态 deployed 的不匹配重放仍在幂等短路前被审计并拉闸", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(await requestStatus(rrid), "deployed");
    const replay = deployedReceipt(repairId, rrid);
    replay.candidateRef = "refs/heads/selfheal/candidates/wrong";
    const cb = await releaseCallback(repairId, "done", replay);
    assert.equal(cb.status, 200);
    assert.equal(cb.json.status, "deploy_unknown");
    assert.equal(await requestStatus(rrid), "deploy_unknown");
    assert.equal(await fuseEngaged(), true);
  });

  test("跨 repair 强绑定:repair Y 的 capability + repair X 的 rrid → 409,X 请求/状态不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    // 第二个 repair(终态,绕开 singleflight 活跃唯一索引),持自己的合法 capability。
    const inc2 = await query<{ id: string }>(
      `INSERT INTO incidents (dedupe_key, condition_key, status, severity, surface, audience, user_title, user_message)
       VALUES ('k.b1b.xrepair','k.b1b.xrepair','resolved','critical','global','all','t','m') RETURNING id::text AS id`,
    );
    const rep2 = await query<{ id: string }>(
      `INSERT INTO codex_repairs (incident_id, status, attempt, tier, dispatched_at)
       VALUES ($1::bigint, 'succeeded', 1, 'tier2', NOW()) RETURNING id::text AS id`,
      [inc2.rows[0].id],
    );
    const attackerRepairId = rep2.rows[0].id;
    const cb = await releaseCallback(attackerRepairId, "done", {
      releaseRequestId: rrid, releasePhase: "deployed", sha: SHA_A,
    });
    assert.equal(cb.status, 409, "rrid 不属于该 capability 的 repair → 409");
    assert.equal(await requestStatus(rrid), "queued", "X 的请求不被跨界推进");
    assert.equal(await repairStatus(repairId), "running", "X 的 repair 不动");
  });

  test("deploy_failed(failed)→ request deploy_failed + failure_reason,repair 不动(停留 running)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    const cb = await releaseCallback(repairId, "failed", {
      releaseRequestId: rrid, releasePhase: "deploy_failed", reason: "smoke_failed", detailText: "smoke 未过",
    });
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deploy_failed");
    assert.equal(await repairStatus(repairId), "running", "deploy_failed 不把 repair 置 failed");
    const fr = await query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM selfheal_release_requests WHERE release_request_id=$1`, [rrid]);
    assert.equal(fr.rows[0].failure_reason, "smoke_failed");
  });

  test("manual_required(failed)→ request manual_required,repair 不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    await releaseCallback(repairId, "failed", { releaseRequestId: rrid, releasePhase: "manual_required", reason: "canonical_advanced" });
    assert.equal(await requestStatus(rrid), "manual_required");
    assert.equal(await repairStatus(repairId), "running");
  });

  test("deploy_unknown(failed)→ request deploy_unknown + 全局熔断 engage + 阻新放行", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    await releaseCallback(repairId, "failed", { releaseRequestId: rrid, releasePhase: "deploy_unknown", reason: "proof_inconclusive" });
    assert.equal(await requestStatus(rrid), "deploy_unknown");
    assert.equal(await fuseEngaged(), true, "deploy_unknown 拉全局熔断");
    assert.equal(await repairStatus(repairId), "running", "deploy_unknown 后 repair 停留 running");
    // 同 source event 仍幂等；真正的新候选则被全局 fuse 阻断。
    const source = await query<{ source_event_id: string }>(
      `SELECT source_event_id::text AS source_event_id
         FROM selfheal_release_requests WHERE release_request_id=$1`,
      [rrid],
    );
    assert.equal(
      (await adminReleaseRepair(repairId, adminInput(source.rows[0].source_event_id))).outcome,
      "existing",
      "同一 source event 永远只返回原 deploy_unknown 请求",
    );
    const newer = await query<{ id: string }>(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'progress', 'new candidate', $2::jsonb)
       RETURNING id::text AS id`,
      [repairId, JSON.stringify({
        phase: "pending_release", sha: "e".repeat(40), baseSha: SHA_A,
        deployPlanHash: "f".repeat(64), manifestHash: "1".repeat(64),
        classification: { surfaces: ["master"] },
      })],
    );
    assert.equal(
      (await adminReleaseRepair(repairId, adminInput(newer.rows[0].id))).outcome,
      "fuse_engaged",
    );
  });

  test("终态到达后重复回调 → 幂等 200,状态不回退", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueuedRelease();
    await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(await requestStatus(rrid), "deployed");
    // 迟到的 deploying(乱序)不得把 deployed 拉回。
    const late = await releaseCallback(repairId, "progress", { releaseRequestId: rrid, releasePhase: "deploying" });
    assert.equal(late.status, 200);
    assert.equal(await requestStatus(rrid), "deployed", "终态幂等,不回退");
  });

  test("未知 rrid deployed 无冻结行可核对 → deploy_unknown+fuse,repair 不推进 verifying", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease();
    const cb = await releaseCallback(repairId, "done", {
      releaseRequestId: "breakglass-999-1700000000", releasePhase: "deployed", sha: SHA_A,
    });
    assert.equal(cb.status, 200);
    assert.equal(cb.json.status, "deploy_unknown");
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_release_requests`);
    assert.equal(n.rows[0].n, "0", "未知 rrid 不建请求行");
    const ev = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND detail->>'releaseRequestId'='breakglass-999-1700000000'`, [repairId]);
    assert.ok(Number(ev.rows[0].n) >= 1, "事件仍记录(容忍 break-glass)");
    assert.equal(await repairStatus(repairId), "running", "未知 receipt 不得推进 repair");
    assert.equal(await fuseEngaged(), true, "无法归属的 deployed 事实必须熔断等待人工裁决");
  });

  test("F9a:未知 rrid deploy_unknown → 拉全局熔断(部署结果未知必须 engage)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease();
    const cb = await releaseCallback(repairId, "failed", {
      releaseRequestId: "breakglass-999-1700000001", releasePhase: "deploy_unknown", reason: "proof_inconclusive",
    });
    assert.equal(cb.status, 200);
    assert.equal(await fuseEngaged(), true, "F9a:未知 rrid deploy_unknown 同样 engage 全局熔断");
    // durable critical 事件已落库(F13①)。
    const crit = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND kind='note' AND message LIKE 'CRITICAL deploy_unknown%'`, [repairId]);
    assert.ok(Number(crit.rows[0].n) >= 1, "F13①:critical 熔断事件已落库");
  });

  test("无 rrid 的回调语义完全不变(普通 done → repair verifying)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease();
    const cb = await releaseCallback(repairId, "done", { commit: "abc" }); // 无 releaseRequestId
    assert.equal(cb.status, 200);
    assert.equal(await repairStatus(repairId), "verifying", "无 rrid = 原 repair done 语义");
  });
});

// ═══ §3 — resolve 与 deploying 请求互斥 ═══════════════════════════════════

describe("§3 resolve × release 互斥", () => {
  test("F8①:deploying 请求 → resolve 推迟(deferred),incident 保持 open,repair/请求不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const r = await adminReleaseRepair(repairId, adminInput(eventId!));
    await releaseCallback(repairId, "progress", { releaseRequestId: r.releaseRequestId, releasePhase: "deploying" });
    const res = await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
    assert.equal(res.resolved, false, "deploying 在途 → resolve 推迟");
    assert.equal(res.deferred, true);
    const inc = await query<{ status: string }>(`SELECT status FROM incidents WHERE id=$1::bigint`, [incidentId]);
    assert.equal(inc.rows[0].status, "repairing", "incident 未被 resolve(保持 open/repairing)");
    assert.equal(await repairStatus(repairId), "running", "deploying 在途 → repair 不取消");
    assert.equal(await requestStatus(r.releaseRequestId!), "deploying");
  });

  test("F2①:queued(delivered_at NULL)请求 → resolve 同事务:request cancelled + repair cancel_requested", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const r = await adminReleaseRepair(repairId, adminInput(eventId!));
    await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
    assert.equal(await requestStatus(r.releaseRequestId!), "cancelled");
    assert.equal(await repairStatus(repairId), "cancel_requested");
  });

  test("F2①:accepted(个人版已收)请求 → resolve **不**直接 cancelled,repair→cancel_requested(待 cancel webhook 收口)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const r = await adminReleaseRepair(repairId, adminInput(eventId!));
    // 模拟个人版已 202 收下:request accepted + delivered_at set。
    await query(
      `UPDATE selfheal_release_requests SET status='accepted', delivered_at=NOW() WHERE release_request_id=$1`,
      [r.releaseRequestId],
    );
    await tx((client: PoolClient) => resolveIncident(incidentId, "admin", client));
    assert.equal(await requestStatus(r.releaseRequestId!), "accepted",
      "accepted 请求不被单方 cancelled(交 sweeper postCancel 的 releaseCancel 裁决)");
    assert.equal(await repairStatus(repairId), "cancel_requested", "repair 仍进 cancel 流");
  });
});

// ═══ §6.3 — incident detail releaseRequests[] + fuse clear 审计 ═══════════

describe("§6.3 admin 读接口 + fuse clear", () => {
  test("getIncidentDetail:每 repair 附 releaseRequests[](字段名逐字)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, incidentId, eventId } = await seedPendingRelease();
    const r = await adminReleaseRepair(repairId, adminInput(eventId!));
    const detail = await getIncidentDetail(incidentId);
    assert.ok(detail);
    const rep = detail!.repairs.find((x) => x.id === repairId);
    assert.ok(rep);
    assert.equal(rep!.releaseRequests.length, 1);
    const rr = rep!.releaseRequests[0];
    assert.equal(rr.releaseRequestId, r.releaseRequestId);
    assert.equal(rr.sourceEventId, eventId);
    assert.equal(rr.status, "queued");
    assert.equal(rr.approvedSha, SHA_A);
    assert.equal(rr.baseSha, SHA_B);
    assert.equal(rr.deployPlanHash, PLAN_HASH);
    assert.equal(rr.failureReason, null);
    assert.ok(typeof rr.createdAt === "string" && typeof rr.updatedAt === "string");
  });

  test("getReleaseFuse + clearReleaseFuse:engaged→cleared + selfheal.fuse_clear 审计", async (t) => {
    if (skipIfNoPg(t)) return;
    const epoch = "rr-fuse-a";
    await query(
      `UPDATE selfheal_release_fuse
          SET engaged=TRUE, reason='deploy_unknown', release_request_id=$1,
              engaged_at=NOW(), engaged_by='callback' WHERE id=1`,
      [epoch],
    );
    const before = await getReleaseFuse();
    assert.equal(before.engaged, true);

    const r = await clearReleaseFuse({
      ...adminInput(),
      reason: "人工核对 /version 后清",
      expectedReleaseRequestId: epoch,
    });
    assert.equal(r.outcome, "cleared");
    const after = await getReleaseFuse();
    assert.equal(after.engaged, false);
    assert.ok(after.clearedAt, "cleared_at set");
    assert.equal(after.clearedBy, adminId);
    assert.equal(after.personalAckAt, null, "清后待 sweeper 双侧收敛(personal_ack_at 仍空)");

    const a = await query<{ n: string; reason: string | null }>(
      `SELECT COUNT(*)::text AS n, MAX(after->>'reason') AS reason
         FROM admin_audit WHERE action='selfheal.fuse_clear'`);
    assert.equal(a.rows[0].n, "1", "fuse_clear 审计一行");
    assert.equal(a.rows[0].reason, "人工核对 /version 后清");

    // 响应丢失后的同 epoch 重试幂等成功，零新审计。
    const again = await clearReleaseFuse({ ...adminInput(), expectedReleaseRequestId: epoch });
    assert.equal(again.outcome, "already_cleared");
    const a2 = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='selfheal.fuse_clear'`);
    assert.equal(a2.rows[0].n, "1", "幂等重试不重复写审计");
  });

  test("multi epoch:A/B 同时 pending→清 A 提升 B→各自清除；stale A 不复活", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease();
    const epochA = "breakglass-epoch-a";
    const epochB = "breakglass-epoch-b";
    await releaseCallback(repairId, "failed", {
      releaseRequestId: epochA, releasePhase: "deploy_unknown", reason: "A unknown",
    });
    assert.equal(await fuseEngaged(), true);
    await releaseCallback(repairId, "failed", {
      releaseRequestId: epochB, releasePhase: "deploy_unknown", reason: "B unknown",
    });
    assert.equal(await fuseEngaged(), true);
    const clearA = await clearReleaseFuse({
      ...adminInput(), expectedReleaseRequestId: epochA,
      reason: "A adjudicated",
    });
    assert.equal(clearA.outcome, "cleared");
    assert.equal(clearA.remainingReleaseRequestId, epochB);
    assert.equal(await fuseEngaged(), true);
    const projected = await getReleaseFuse();
    assert.equal(projected.releaseRequestId, epochB);
    const retryA = await clearReleaseFuse({
      ...adminInput(), expectedReleaseRequestId: epochA,
    });
    assert.equal(retryA.outcome, "already_cleared");
    assert.equal(retryA.remainingReleaseRequestId, epochB);
    assert.equal((await clearReleaseFuse({
      ...adminInput(), expectedReleaseRequestId: epochB,
    })).outcome, "cleared");

    const lateReplay = await releaseCallback(repairId, "failed", {
      releaseRequestId: epochA, releasePhase: "deploy_unknown", reason: "late A replay",
    });
    assert.equal(lateReplay.status, 200, "已裁决 epoch 的迟到 receipt 必须幂等成功而非内部 500");
    assert.equal(await fuseEngaged(), false, "A tombstone 永久阻止旧 callback 复活");
    const tombstones = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM selfheal_release_fuse_epochs
        WHERE release_request_id IN ($1,$2) AND cleared_at IS NOT NULL`,
      [epochA, epochB],
    );
    assert.equal(tombstones.rows[0].n, "2");
  });

  test("rolling upgrade triggers:旧 callback 丢不掉 B，旧 clear A 会提升 B，stale A 不复活", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease();
    const epochA = "legacy-overlap-a";
    const epochB = "legacy-overlap-b";
    for (const [rrid, reason] of [[epochA, "A unknown"], [epochB, "B unknown"]]) {
      await query(
        `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
         VALUES ($1::bigint, 'failed', 'legacy deploy unknown', $2::jsonb)`,
        [repairId, JSON.stringify({
          releaseRequestId: rrid,
          releasePhase: "deploy_unknown",
          reason,
        })],
      );
    }
    const pending = await query<{ release_request_id: string }>(
      `SELECT release_request_id FROM selfheal_release_fuse_epochs
        WHERE cleared_at IS NULL ORDER BY engaged_at, release_request_id`,
    );
    assert.deepEqual(pending.rows.map((r) => r.release_request_id), [epochA, epochB]);
    assert.equal((await getReleaseFuse()).releaseRequestId, epochA);

    // Exact SQL shape of the pre-0174 admin clear: singleton only.
    await query(
      `UPDATE selfheal_release_fuse
          SET engaged=FALSE, cleared_at=NOW(), cleared_by='legacy-admin', personal_ack_at=NULL
        WHERE id=1 AND engaged=TRUE AND release_request_id=$1`,
      [epochA],
    );
    const afterLegacyClear = await getReleaseFuse();
    assert.equal(afterLegacyClear.engaged, true);
    assert.equal(afterLegacyClear.releaseRequestId, epochB);
    const a = await query<{ cleared_at: Date | null }>(
      `SELECT cleared_at FROM selfheal_release_fuse_epochs WHERE release_request_id=$1`,
      [epochA],
    );
    assert.ok(a.rows[0].cleared_at);

    assert.equal((await clearReleaseFuse({
      ...adminInput(), expectedReleaseRequestId: epochB,
    })).outcome, "cleared");
    assert.equal(await fuseEngaged(), false);

    // Exact pre-0174 engage SQL from a delayed A callback (engaged=FALSE CAS).
    // The singleton trigger observes A's tombstone and immediately closes it.
    await query(
      `UPDATE selfheal_release_fuse
          SET engaged=TRUE, reason='late A', release_request_id=$1,
              engaged_at=NOW(), engaged_by='legacy-callback',
              cleared_at=NULL, cleared_by=NULL, personal_ack_at=NULL
        WHERE id=1 AND engaged=FALSE`,
      [epochA],
    );
    const afterStale = await getReleaseFuse();
    assert.equal(afterStale.engaged, false);
    assert.equal(afterStale.releaseRequestId, epochA);
  });
});

// ═══ 批1b 审查整改:F2③ receipt 胜 cancel / F8②③ / F8① admin deploy_in_progress ═══

describe("批1b 审查整改(F2③ / F8 / F13①)", () => {
  async function seedQueued(): Promise<{ repairId: string; rrid: string; incidentId: string }> {
    const s = await seedPendingRelease();
    const r = await adminReleaseRepair(s.repairId, adminInput(s.eventId!));
    return { repairId: s.repairId, rrid: r.releaseRequestId!, incidentId: s.incidentId };
  }

  test("F2③:请求已 cancelled 收到 deployed receipt → receipt 胜(request→deployed,repair 收口 verifying,留竞态警示)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    // 乐观 cancel(模拟 sweeper 收口后个人版实则已部署)。
    await query(`UPDATE selfheal_release_requests SET status='cancelled' WHERE release_request_id=$1`, [rrid]);
    const cb = await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deployed", "receipt 胜过乐观 cancel:request→deployed");
    assert.equal(await repairStatus(repairId), "verifying", "repair(running)照常收口 verifying");
    const race = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND kind='note' AND (detail->>'cancelReceiptRace')='true'`, [repairId]);
    assert.equal(race.rows[0].n, "1", "留一条 cancel/receipt 竞态警示事件");
  });

  test("R2-1②:repair 处于 cancel_requested 时收到 deployed receipt → verifying + cancelReceiptRace 事件", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    // 模拟:cancel 已发起(repair→cancel_requested)但 release 已 pre-claim 部署(too_late,request→deploying)。
    await query(`UPDATE selfheal_release_requests SET status='deploying' WHERE release_request_id=$1`, [rrid]);
    await query(`UPDATE codex_repairs SET status='cancel_requested' WHERE id=$1::bigint`, [repairId]);
    const cb = await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(cb.status, 200);
    assert.equal(await requestStatus(rrid), "deployed", "receipt 落库 request→deployed");
    assert.equal(await repairStatus(repairId), "verifying",
      "cancel 途中的 repair 被 deployed receipt 收口到 verifying(不永久卡 cancel_requested/cancelling)");
    const va = await query<{ verify_after: Date | null }>(
      `SELECT verify_after FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.ok(va.rows[0].verify_after, "verify_after 已 set(进入探测验证)");
    const race = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND kind='note' AND (detail->>'cancelReceiptRace')='true'`, [repairId]);
    assert.equal(race.rows[0].n, "1", "append 一条 cancelReceiptRace 警示事件");
  });

  test("R2-1②:repair 处于 cancelling 时收到 deployed receipt → 同样收口 verifying(扩展 CAS 覆盖 cancelling)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    await query(`UPDATE selfheal_release_requests SET status='deploying' WHERE release_request_id=$1`, [rrid]);
    await query(`UPDATE codex_repairs SET status='cancelling' WHERE id=$1::bigint`, [repairId]);
    const cb = await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(cb.status, 200);
    assert.equal(await repairStatus(repairId), "verifying", "cancelling 也被 deployed receipt 收口到 verifying");
  });

  test("F2③:请求已 cancelled 收到 deploy_unknown receipt → receipt 胜(request→deploy_unknown + 熔断 engage)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    await query(`UPDATE selfheal_release_requests SET status='cancelled' WHERE release_request_id=$1`, [rrid]);
    await releaseCallback(repairId, "failed", { releaseRequestId: rrid, releasePhase: "deploy_unknown", reason: "proof_inconclusive" });
    assert.equal(await requestStatus(rrid), "deploy_unknown", "receipt 胜:request→deploy_unknown");
    assert.equal(await fuseEngaged(), true, "deploy_unknown 仍拉全局熔断");
  });

  test("F8③:deployed receipt 但 repair 已终态(cancelled)→ casRepairToVerifying 0 行,只警示不失败(200)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    // request deploying(活跃),但 repair 已被独立置 cancelled(0 行收口场景)。
    await query(`UPDATE selfheal_release_requests SET status='deploying' WHERE release_request_id=$1`, [rrid]);
    await query(`UPDATE codex_repairs SET status='cancelled' WHERE id=$1::bigint`, [repairId]);
    const cb = await releaseCallback(repairId, "done", deployedReceipt(repairId, rrid));
    assert.equal(cb.status, 200, "0 行收口不失败");
    assert.equal(await requestStatus(rrid), "deployed");
    assert.equal(await repairStatus(repairId), "cancelled", "repair 不被 0 行收口复活");
    const warn = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND kind='note' AND message LIKE 'deployed 回调:repair 不在可收口态%'`, [repairId]);
    assert.equal(warn.rows[0].n, "1", "append 一条 verifying 收口跳过的警示事件");
  });

  test("F8②:活跃 release request 在途时,普通 done(无 rrid)→ 409,repair 不被终态", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedQueued(); // 建 queued 请求
    const cb = await releaseCallback(repairId, "done", { commit: "abc" }); // 无 rrid = 普通 done 路径
    assert.equal(cb.status, 409, "部署流程中模型不得普通 done 终态 repair");
    assert.equal(await repairStatus(repairId), "running", "repair 停留 running(未进 verifying)");
  });

  test("F8②:活跃 release request 在途时,普通 failed(无 rrid)→ 409,repair 不被终态", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedQueued();
    const cb = await releaseCallback(repairId, "failed", { note: "x" });
    assert.equal(cb.status, 409);
    assert.equal(await repairStatus(repairId), "running", "repair 停留 running(未 failed)");
  });

  test("F8②:无活跃 release request 时普通 done 语义不变(→ verifying)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedPendingRelease(); // 未放行,无 release request
    const cb = await releaseCallback(repairId, "done", { commit: "abc" });
    assert.equal(cb.status, 200);
    assert.equal(await repairStatus(repairId), "verifying");
  });

  test("F8①:admin 手动 resolve 遇 deploying 请求 → deploy_in_progress(不改 condition/不 resolve/不写审计)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid, incidentId } = await seedQueued();
    await releaseCallback(repairId, "progress", { releaseRequestId: rrid, releasePhase: "deploying" });
    const r = await adminResolveIncident(incidentId, adminInput());
    assert.equal(r.outcome, "deploy_in_progress");
    const inc = await query<{ status: string }>(`SELECT status FROM incidents WHERE id=$1::bigint`, [incidentId]);
    assert.equal(inc.rows[0].status, "repairing", "incident 未 resolve");
    const a = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_audit WHERE action='incident.resolve' AND target=$1`,
      [`incident:${incidentId}`]);
    assert.equal(a.rows[0].n, "0", "deploy_in_progress 路径零审计(tx 原子未落任何 mutation)");
  });

  test("F13①:known-rrid deploy_unknown → 落 durable critical 事件(kind=note,message 前缀 CRITICAL)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId, rrid } = await seedQueued();
    await releaseCallback(repairId, "failed", { releaseRequestId: rrid, releasePhase: "deploy_unknown", reason: "proof_inconclusive" });
    const crit = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM codex_repair_events
        WHERE repair_id=$1::bigint AND kind='note' AND message LIKE 'CRITICAL deploy_unknown%'`, [repairId]);
    assert.equal(crit.rows[0].n, "1", "同事务落一条 critical 熔断事件");
  });
});
