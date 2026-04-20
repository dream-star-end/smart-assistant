/**
 * T-24 集成:/api/payment/* HTTP 路由。
 *
 * 用 mock HupijiaoClient(返回固定 qrcode),避免外网请求。
 * 用虎皮椒 MD5 签名工具自签回调 body → 校验 path。
 *
 * 覆盖:
 *   - GET  /api/payment/plans                     → 200,4 档
 *   - POST /api/payment/hupi/create 正常          → 200,订单 pending,qrcode_url 来自 mock
 *   - POST /api/payment/hupi/create 未知 plan     → 400 PLAN_NOT_FOUND
 *   - POST /api/payment/hupi/create 缺 Authorization → 401
 *   - POST /api/payment/hupi/create mock 抛 → 502
 *   - POST /api/payment/hupi/callback 签名错       → 400 SIGNATURE_INVALID
 *   - POST /api/payment/hupi/callback 正确        → 200 "success" + orders paid + credits 到账
 *   - POST /api/payment/hupi/callback status != OD → 200 "success" + 订单仍 pending(不推进)
 *   - POST /api/payment/hupi/callback 重复        → 200 "success" + 积分只加一次
 *   - GET  /api/payment/orders/:order_no 属主     → 200
 *   - GET  /api/payment/orders/:order_no 非属主   → 404
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { signAccess } from "../auth/jwt.js";
import { signHupijiao } from "../payment/hupijiao/sign.js";
import type { HupijiaoClient } from "../payment/hupijiao/client.js";
import { HupijiaoError } from "../payment/hupijiao/client.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "user_preferences", "request_finalize_journal",
  "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

const JWT_SECRET = "p".repeat(64);
const HUPI_APP_ID = "TEST_APP";
const HUPI_SECRET = "TEST_SECRET_12345";

class NullMailer implements Mailer { async send(_msg: MailMessage): Promise<void> {} }

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

// mock hupijiao client 的可变状态
let mockNextCreate:
  | { kind: "ok"; qrcode: string; providerOrder?: string | null }
  | { kind: "err"; code: string; message: string }
  | null = null;

const mockHupi: HupijiaoClient = {
  async createQr(_input) {
    const next = mockNextCreate ?? { kind: "ok" as const, qrcode: "weixin://wxpay/bizpayurl?pr=MOCK" };
    mockNextCreate = null;
    if (next.kind === "err") throw new HupijiaoError(next.code, next.message);
    return { qrcodeUrl: next.qrcode, mobileUrl: null, providerOrder: next.providerOrder ?? "MOCK_PX", raw: {} };
  },
};

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}
async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch { /* */ } return null; }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
    await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
    await runMigrations();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }

  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) throw new Error("Redis test fixture required");

  if (pgAvailable && redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NullMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      hupijiao: mockHupi,
      hupijiaoConfig: { appId: HUPI_APP_ID, appSecret: HUPI_SECRET },
      rateLimits: {
        register: { scope: "rg_pt", windowSeconds: 60, max: 100 },
        login: { scope: "lg_pt", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_pt", windowSeconds: 60, max: 100 },
        hupiCreate: { scope: "hc_pt", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const ok = await handler(req, res);
      if (!ok) { res.statusCode = 404; res.end("nope"); }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
});

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (redis) { try { await redis.flushdb(); } catch { /* */ } await redis.quit(); }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  await query("TRUNCATE TABLE orders, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  await redis.flushdb();
  mockNextCreate = null;
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUserWithToken(email: string, credits = 0n): Promise<{ id: string; token: string }> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, email_verified, status) VALUES($1,'argon2$stub',$2,true,'active') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  const id = r.rows[0].id;
  const issued = await signAccess({ sub: id, role: "user" as const }, JWT_SECRET);
  return { id, token: issued.token };
}

async function postJson(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await resp.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: resp.status, json };
}

async function postForm(path: string, form: Record<string, string>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) sp.set(k, v);
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: sp.toString(),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

describe("GET /api/payment/plans", () => {
  test("公开访问,返回所有 enabled 档", async (t) => {
    if (skipIfMissing(t)) return;
    const resp = await fetch(`${baseUrl}/api/payment/plans`);
    assert.equal(resp.status, 200);
    const json = await resp.json() as { ok: boolean; data: { plans: Array<{ code: string }> } };
    assert.equal(json.ok, true);
    const codes = json.data.plans.map((p) => p.code).sort();
    assert.deepEqual(codes, ["plan-10", "plan-1000", "plan-200", "plan-50"]);
  });
});

describe("POST /api/payment/hupi/create", () => {
  test("正常:200 + 订单 pending + qrcode_url 来自 mock", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithToken("create-ok@example.com");
    mockNextCreate = { kind: "ok", qrcode: "weixin://wxpay/MOCK_QR_1", providerOrder: "PX_A" };
    const r = await postJson("/api/payment/hupi/create", { plan_code: "plan-10" }, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const data = r.json.data as { order_no: string; qrcode_url: string; amount_cents: string; credits: string };
    assert.equal(data.qrcode_url, "weixin://wxpay/MOCK_QR_1");
    assert.equal(data.amount_cents, "1000");
    assert.equal(data.credits, "1000");
    assert.match(data.order_no, /^\d{8}-[0-9a-f]{8}$/);

    // DB 有 pending 订单
    const dbo = await query<{ status: string; user_id: string }>(
      "SELECT status, user_id::text AS user_id FROM orders WHERE order_no=$1",
      [data.order_no],
    );
    assert.equal(dbo.rows.length, 1);
    assert.equal(dbo.rows[0].status, "pending");
    assert.equal(dbo.rows[0].user_id, uid);
  });

  test("plan_code 不存在:400 PLAN_NOT_FOUND", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithToken("create-badplan@example.com");
    const r = await postJson("/api/payment/hupi/create", { plan_code: "nonexistent" }, token);
    assert.equal(r.status, 400);
    assert.equal((r.json.error as Record<string, unknown>).code, "PLAN_NOT_FOUND");
  });

  test("缺 plan_code:400 VALIDATION", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithToken("create-noplan@example.com");
    const r = await postJson("/api/payment/hupi/create", {}, token);
    assert.equal(r.status, 400);
    assert.equal((r.json.error as Record<string, unknown>).code, "VALIDATION");
  });

  test("缺 Authorization:401", async (t) => {
    if (skipIfMissing(t)) return;
    const r = await postJson("/api/payment/hupi/create", { plan_code: "plan-10" });
    assert.equal(r.status, 401);
    assert.equal((r.json.error as Record<string, unknown>).code, "UNAUTHORIZED");
  });

  test("mock 抛 HupijiaoError → 502 UPSTREAM_*", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithToken("create-upfail@example.com");
    mockNextCreate = { kind: "err", code: "UPSTREAM_BAD_JSON", message: "bad" };
    const r = await postJson("/api/payment/hupi/create", { plan_code: "plan-10" }, token);
    assert.equal(r.status, 502);
    assert.equal((r.json.error as Record<string, unknown>).code, "UPSTREAM_BAD_JSON");
    // 订单依然 pending(未来 expire 扫到)
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM orders WHERE status='pending'",
    );
    assert.equal(cnt.rows[0].cnt, "1");
  });
});

describe("POST /api/payment/hupi/callback", () => {
  async function seedPendingOrder(uid: string, planCode = "plan-10"): Promise<string> {
    const { order } = await (await import("../payment/orders.js")).createPendingOrder({
      userId: uid, planCode,
    });
    return order.order_no;
  }

  test("签名错:400 SIGNATURE_INVALID + 订单仍 pending", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid } = await createUserWithToken("cb-badsig@example.com");
    const orderNo = await seedPendingOrder(uid);
    const r = await postForm("/api/payment/hupi/callback", {
      trade_order_id: orderNo,
      total_fee: "10.00",
      status: "OD",
      transaction_id: "WX1",
      hash: "a".repeat(32), // 胡写
    });
    assert.equal(r.status, 400);
    const json = JSON.parse(r.text) as { error: { code: string } };
    assert.equal(json.error.code, "SIGNATURE_INVALID");
    const o = await query<{ status: string; credits: string }>(
      "SELECT status FROM orders WHERE order_no=$1", [orderNo],
    );
    assert.equal(o.rows[0].status, "pending");
  });

  test("正确签名 + status=OD:200 'success' + paid + credits 到账", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid } = await createUserWithToken("cb-ok@example.com", 0n);
    const orderNo = await seedPendingOrder(uid, "plan-50");
    const form: Record<string, string> = {
      version: "1.1",
      appid: HUPI_APP_ID,
      trade_order_id: orderNo,
      transaction_id: "WX_TX_OK",
      total_fee: "50.00",
      status: "OD",
      nonce_str: "xxx",
      time: "1800000000",
    };
    form.hash = signHupijiao(form, HUPI_SECRET);
    const r = await postForm("/api/payment/hupi/callback", form);
    assert.equal(r.status, 200);
    assert.equal(r.text, "success");

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "5500"); // plan-50 credits

    const o = await query<{ status: string; provider_order: string }>(
      "SELECT status, provider_order FROM orders WHERE order_no=$1", [orderNo],
    );
    assert.equal(o.rows[0].status, "paid");
    assert.equal(o.rows[0].provider_order, "WX_TX_OK");
  });

  test("status != OD (如 PN) + 签名正确:200 'success' + 订单仍 pending", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid } = await createUserWithToken("cb-pn@example.com", 0n);
    const orderNo = await seedPendingOrder(uid);
    const form: Record<string, string> = {
      trade_order_id: orderNo,
      total_fee: "10.00",
      status: "PN",
      transaction_id: "WX_PN",
      appid: HUPI_APP_ID,
    };
    form.hash = signHupijiao(form, HUPI_SECRET);
    const r = await postForm("/api/payment/hupi/callback", form);
    assert.equal(r.status, 200);
    assert.equal(r.text, "success");
    const o = await query<{ status: string }>(
      "SELECT status FROM orders WHERE order_no=$1", [orderNo],
    );
    assert.equal(o.rows[0].status, "pending");
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "0");
  });

  test("重复回调:200 'success',积分只加一次", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid } = await createUserWithToken("cb-dup@example.com", 0n);
    const orderNo = await seedPendingOrder(uid);
    const form1: Record<string, string> = {
      trade_order_id: orderNo, total_fee: "10.00", status: "OD", transaction_id: "X", appid: HUPI_APP_ID,
    };
    form1.hash = signHupijiao(form1, HUPI_SECRET);
    const r1 = await postForm("/api/payment/hupi/callback", form1);
    assert.equal(r1.status, 200);
    // 重放完全相同的 payload
    const r2 = await postForm("/api/payment/hupi/callback", form1);
    assert.equal(r2.status, 200);
    assert.equal(r2.text, "success");

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "1000");
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid],
    );
    assert.equal(cnt.rows[0].cnt, "1");
  });

  test("订单不存在:400 ORDER_NOT_FOUND", async (t) => {
    if (skipIfMissing(t)) return;
    const form: Record<string, string> = {
      trade_order_id: "NOPE-12345678", status: "OD", total_fee: "10.00", appid: HUPI_APP_ID,
    };
    form.hash = signHupijiao(form, HUPI_SECRET);
    const r = await postForm("/api/payment/hupi/callback", form);
    assert.equal(r.status, 400);
    const json = JSON.parse(r.text) as { error: { code: string } };
    assert.equal(json.error.code, "ORDER_NOT_FOUND");
  });
});

describe("GET /api/payment/orders/:order_no", () => {
  test("属主可读:200", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithToken("get-own@example.com");
    const { order } = await (await import("../payment/orders.js")).createPendingOrder({
      userId: uid, planCode: "plan-10",
    });
    const resp = await fetch(`${baseUrl}/api/payment/orders/${order.order_no}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json() as { data: { order_no: string; status: string } };
    assert.equal(json.data.order_no, order.order_no);
    assert.equal(json.data.status, "pending");
  });

  test("非属主:404 ORDER_NOT_FOUND", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uidOwner } = await createUserWithToken("owner@example.com");
    const { token: otherToken } = await createUserWithToken("intruder@example.com");
    const { order } = await (await import("../payment/orders.js")).createPendingOrder({
      userId: uidOwner, planCode: "plan-10",
    });
    const resp = await fetch(`${baseUrl}/api/payment/orders/${order.order_no}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    assert.equal(resp.status, 404);
  });

  test("非法 order_no 字符:400 VALIDATION", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithToken("badchar@example.com");
    const resp = await fetch(`${baseUrl}/api/payment/orders/ab%20cd`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // route 能匹配但 handler 里 extractOrderNoFromUrl → null → 400
    assert.equal(resp.status, 400);
  });
});
