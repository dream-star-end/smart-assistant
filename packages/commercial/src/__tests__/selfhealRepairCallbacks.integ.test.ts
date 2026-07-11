/**
 * v5 自愈体系切片②ⓐ 集成测试 — codex 回调端点(dispatchSelfhealRepairsRoute)对真 0133 schema
 * 的状态机 CAS + capability/webhook HMAC 鉴权 + context 只读。
 *
 * pg 不可用时 skip。断言=行为(HTTP 码 + DB round-trip),非源码 regex。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { issueCapability } from "../selfheal/capability.js";
import { dispatchSelfhealRepairsRoute } from "../http/internal/selfhealRepairs.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const WEBHOOK_SECRET = "callbacks-webhook-secret";
let pgAvailable = false;

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7c).toString("base64");
  process.env.OC_SELFHEAL_MASTER_SECRET = "integ-master-secret";
  process.env.OC_SELFHEAL_WEBHOOK_HMAC = WEBHOOK_SECRET;
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query(`TRUNCATE incidents, codex_repairs, codex_repair_events, admin_alert_rule_state RESTART IDENTITY CASCADE`);
    } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(`TRUNCATE incidents, codex_repairs, codex_repair_events, admin_alert_rule_state RESTART IDENTITY CASCADE`);
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

// ─── fixtures ──────────────────────────────────────────────────────────

async function seedRepair(status: string): Promise<{ incidentId: string; repairId: string }> {
  const inc = await query<{ id: string }>(
    `INSERT INTO incidents (dedupe_key, condition_key, policy_id, status, severity, surface, audience, user_title, user_message, ops_detail)
     VALUES ('ops.monitor:svc_v5','ops.monitor:svc_v5',
             (SELECT id FROM incident_policies WHERE match_key='ops.monitor:svc_v5' LIMIT 1),
             'repairing','critical','global','all','服务中断','恢复中','master down')
     RETURNING id::text AS id`,
  );
  const incidentId = inc.rows[0].id;
  const rep = await query<{ id: string }>(
    `INSERT INTO codex_repairs (incident_id, status, attempt, tier, dispatched_at)
     VALUES ($1::bigint, $2, 1, 'tier2', NOW()) RETURNING id::text AS id`,
    [incidentId, status],
  );
  return { incidentId, repairId: rep.rows[0].id };
}

// ─── HTTP mocks ────────────────────────────────────────────────────────

function mockReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  ip?: string;
}): IncomingMessage {
  const r = Readable.from(opts.body !== undefined ? [Buffer.from(opts.body)] : []) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {};
  (r as unknown as { method: string }).method = opts.method;
  (r as unknown as { url: string }).url = opts.url;
  (r as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: opts.ip ?? "127.0.0.1" };
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

async function call(opts: Parameters<typeof mockReq>[0]): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = mockReq(opts);
  const { res, captured } = mockRes();
  await dispatchSelfhealRepairsRoute(req, res, {} as never, {} as never);
  let json: Record<string, unknown> = {};
  try { json = captured.body ? JSON.parse(captured.body) : {}; } catch { /* */ }
  return { status: captured.status, json };
}

function capHeader(repairId: string, attempt = 1): Record<string, string> {
  return { authorization: `Bearer ${issueCapability(repairId, attempt).token}` };
}

async function repairStatus(id: string): Promise<string> {
  const r = await query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
  return r.rows[0].status;
}

// ─── tests ─────────────────────────────────────────────────────────────

describe("selfheal repair callbacks (integ)", () => {
  test("ack:dispatched → acked", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/ack`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "codex 已接单" }),
    });
    assert.equal(r.status, 200);
    assert.equal(await repairStatus(repairId), "acked");
  });

  test("done:running → verifying(不直接 succeeded)+ verify_after 落点", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/done`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "已提交修复", detail: { commit: "abc123" } }),
    });
    assert.equal(r.status, 200);
    assert.equal(await repairStatus(repairId), "verifying");
    const va = await query<{ verify_after: Date | null; verify_deadline: Date | null }>(
      `SELECT verify_after, verify_deadline FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.ok(va.rows[0].verify_after, "verify_after 已设");
    assert.ok(va.rows[0].verify_deadline, "verify_deadline 已设");
  });

  test("failed:running → failed + fail_reason", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/failed`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "无法定位根因" }),
    });
    assert.equal(r.status, 200);
    assert.equal(await repairStatus(repairId), "failed");
    const fr = await query<{ fail_reason: string }>(`SELECT fail_reason FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.equal(fr.rows[0].fail_reason, "无法定位根因");
  });

  test("capability 绑 repairId:换 id 的 token → 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/ack`,
      headers: { ...capHeader("999999"), "content-type": "application/json" }, // 别的 repair 的 token
      body: JSON.stringify({ message: "x" }),
    });
    assert.equal(r.status, 401);
    assert.equal(await repairStatus(repairId), "dispatched"); // 未被改
  });

  test("progress 追加 codex_repair_events(kind=progress)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("acked");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/progress`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "正在跑测试" }),
    });
    assert.equal(r.status, 200);
    const ev = await query<{ kind: string; message: string }>(
      `SELECT kind, message FROM codex_repair_events WHERE repair_id=$1::bigint ORDER BY id DESC LIMIT 1`, [repairId]);
    assert.equal(ev.rows[0].kind, "progress");
    assert.equal(await repairStatus(repairId), "running");
  });

  test("detail 脱敏:回传含 secret 的 detail → 事件里被 __redacted", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/progress`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "步骤", detail: { api_key: "sk-verysecretlongvalue" } }),
    });
    const ev = await query<{ detail: { api_key?: unknown } }>(
      `SELECT detail FROM codex_repair_events WHERE repair_id=$1::bigint ORDER BY id DESC LIMIT 1`, [repairId]);
    const d = ev.rows[0].detail as { api_key?: { __redacted?: boolean } };
    assert.equal(d.api_key?.__redacted, true, "明文 secret 不入库");
  });

  test("GET context:capability 校验 + 结构化只读(eventType=policy.match_key)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const r = await call({
      method: "GET", url: `/internal/v5/repairs/${repairId}/context`,
      headers: capHeader(repairId),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.eventType, "ops.monitor:svc_v5");
    assert.equal(r.json.conditionKey, "ops.monitor:svc_v5");
    assert.equal(r.json.surface, "global");
    assert.equal(r.json.tier, "tier2");
    assert.ok("repairHint" in r.json);
  });

  test("claim-capability:webhook HMAC 有效 → 发 token,该 token 可用于回调", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const body = "{}";
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const bodySha = createHash("sha256").update(body).digest("hex");
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${nonce}.${repairId}.${bodySha}`).digest("hex");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers: { "x-selfheal-ts": ts, "x-selfheal-nonce": nonce, "x-selfheal-sig": sig, "content-type": "application/json" },
      body,
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.json.token === "string");
    // 用换来的 token 直接回调 ack。
    const ack = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/ack`,
      headers: { authorization: `Bearer ${r.json.token as string}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "ok" }),
    });
    assert.equal(ack.status, 200);
    assert.equal(await repairStatus(repairId), "acked");
  });

  test("claim-capability:伪造 sig → 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers: { "x-selfheal-ts": String(Date.now()), "x-selfheal-nonce": "n", "x-selfheal-sig": "0".repeat(64) },
      body: "{}",
    });
    assert.equal(r.status, 401);
  });

  test("非 loopback 来源 → 403", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/ack`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
      ip: "8.8.8.8",
    });
    assert.equal(r.status, 403);
  });
});
