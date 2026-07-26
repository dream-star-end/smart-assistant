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
import { resetTestSchemaForTest } from "./helpers/db.js";

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
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query(`TRUNCATE incidents, codex_repairs, codex_repair_events, admin_alert_rule_state, selfheal_capability_uses, selfheal_webhook_nonces RESTART IDENTITY CASCADE`);
    } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(`TRUNCATE incidents, codex_repairs, codex_repair_events, admin_alert_rule_state, selfheal_capability_uses, selfheal_webhook_nonces RESTART IDENTITY CASCADE`);
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

  /** M3 路由绑定签名(跨仓契约):`${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`。 */
  function signClaim(opts: { repairId: string; method?: string; path?: string; body?: string; ts?: string; nonce?: string }) {
    const body = opts.body ?? "{}";
    const ts = opts.ts ?? String(Date.now());
    const nonce = opts.nonce ?? randomBytes(16).toString("hex");
    const method = opts.method ?? "POST";
    const path = opts.path ?? `/internal/v5/repairs/${opts.repairId}/claim-capability`;
    const bodySha = createHash("sha256").update(body).digest("hex");
    const sig = createHmac("sha256", WEBHOOK_SECRET)
      .update(`${method}.${path}.${ts}.${nonce}.${opts.repairId}.${bodySha}`)
      .digest("hex");
    return { body, headers: { "x-selfheal-ts": ts, "x-selfheal-nonce": nonce, "x-selfheal-sig": sig, "content-type": "application/json" } };
  }

  test("claim-capability:webhook HMAC 有效 → 发 token,该 token 可用于回调", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const { body, headers } = signClaim({ repairId });
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers,
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

  // ── 收尾批 M3:HMAC 路由绑定 + nonce 落库重放拒 ──────────────────────

  test("M3 负例:sig 按别的 path 计算(跨端点重放)→ 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const { body, headers } = signClaim({ repairId, path: "/api/webhooks/v5-selfheal-cancel" });
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers, body,
    });
    assert.equal(r.status, 401, "签名串绑 path,换端点必败");
  });

  test("M3 负例:sig 按别的 METHOD 计算 → 401", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const { body, headers } = signClaim({ repairId, method: "GET" });
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers, body,
    });
    assert.equal(r.status, 401, "签名串绑 METHOD,method 不符必败");
  });

  test("M3 nonce 落库:同一签名请求原样重放 → 第一次 200,第二次 401(nonce 已消费)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("dispatched");
    const { body, headers } = signClaim({ repairId });
    const r1 = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers, body,
    });
    assert.equal(r1.status, 200);
    const r2 = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/claim-capability`,
      headers, body,
    });
    assert.equal(r2.status, 401, "nonce 原子判重(PG selfheal_webhook_nonces),重放必拒");
    const nrow = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM selfheal_webhook_nonces`);
    assert.equal(nrow.rows[0].n, "1", "nonce 落库恰一行");
  });

  // ── 收尾批 M2:capability jti 一次性消费(done/failed)──────────────

  test("M2 done 重放:同一 token 第二次 done → 409;换新 token 的 done 幂等可过", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const token = issueCapability(repairId, 1).token;
    const mk = (tok: string) => call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/done`,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "已修复" }),
    });
    const r1 = await mk(token);
    assert.equal(r1.status, 200);
    assert.equal(await repairStatus(repairId), "verifying");
    const r2 = await mk(token);
    assert.equal(r2.status, 409, "同 jti 重放 → 409");
    // 新 token(新 jti)在 verifying 态重报 done:CAS 仍匹配 verifying → 200(幂等语义)。
    const r3 = await mk(issueCapability(repairId, 1).token);
    assert.equal(r3.status, 200);
    assert.equal(await repairStatus(repairId), "verifying");
  });

  test("M2 failed 重放:同一 token 第二次 failed → 409", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const token = issueCapability(repairId, 1).token;
    const mk = () => call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/failed`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "修不了" }),
    });
    const r1 = await mk();
    assert.equal(r1.status, 200);
    assert.equal(await repairStatus(repairId), "failed");
    const r2 = await mk();
    assert.equal(r2.status, 409);
  });

  // ── 收尾批 M2:verify 窗口 set-once(重复 verify 不延窗)────────────

  test("verify set-once:第二次 verify 200 但 verify_after/deadline 不变(不续命)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("running");
    const mkVerify = () => call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/verify`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "请开始验证" }),
    });
    const r1 = await mkVerify();
    assert.equal(r1.status, 200);
    const w1 = await query<{ va: Date; vd: Date }>(
      `SELECT verify_after AS va, verify_deadline AS vd FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    await new Promise((r) => setTimeout(r, 30));
    const r2 = await mkVerify();
    assert.equal(r2.status, 200, "重复 verify 幂等(200)");
    const w2 = await query<{ va: Date; vd: Date }>(
      `SELECT verify_after AS va, verify_deadline AS vd FROM codex_repairs WHERE id=$1::bigint`, [repairId]);
    assert.equal(w2.rows[0].va.getTime(), w1.rows[0].va.getTime(), "verify_after 不变");
    assert.equal(w2.rows[0].vd.getTime(), w1.rows[0].vd.getTime(), "verify_deadline 不变(不延窗)");
  });

  // ── 收尾批 M4:message 值级凭据清洗 ─────────────────────────────────

  test("M4 message 清洗:自由文本里的 sk-key/Bearer 入库前被替换", async (t) => {
    if (skipIfNoPg(t)) return;
    const { repairId } = await seedRepair("acked");
    const r = await call({
      method: "POST", url: `/internal/v5/repairs/${repairId}/progress`,
      headers: { ...capHeader(repairId), "content-type": "application/json" },
      body: JSON.stringify({ message: "调用了 sk-abcdef1234567890 与 Bearer eyJhbGciOi.payload" }),
    });
    assert.equal(r.status, 200);
    const ev = await query<{ message: string }>(
      `SELECT message FROM codex_repair_events WHERE repair_id=$1::bigint ORDER BY id DESC LIMIT 1`, [repairId]);
    assert.ok(!ev.rows[0].message.includes("sk-abcdef1234567890"), "sk- key 不入库");
    assert.ok(!ev.rows[0].message.includes("eyJhbGciOi"), "Bearer token 不入库");
    assert.ok(ev.rows[0].message.includes("[redacted"), "留 redact 痕迹");
  });
});
