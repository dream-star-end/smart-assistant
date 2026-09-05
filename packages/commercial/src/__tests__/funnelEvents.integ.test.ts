/**
 * OCV5-104 — conversion funnel writes to product_friction_events.
 * Isolated from http.integ.test.ts so the 180s per-file timeout stays intact.
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
import { warmupLoginDummyHash } from "../auth/login.js";
import { signHupijiao } from "../payment/hupijiao/sign.js";
import type { HupijiaoClient } from "../payment/hupijiao/client.js";
import { HupijiaoError } from "../payment/hupijiao/client.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { signAccess } from "../auth/jwt.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "y".repeat(64);
const HUPI_APP_ID = "TEST_APP";
const HUPI_SECRET = "TEST_SECRET_12345";

class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";
const mailer = new CapturingMailer();

let mockNextCreate:
  | { kind: "ok"; qrcode: string; providerOrder?: string | null }
  | { kind: "err"; code: string; message: string }
  | null = null;

const mockHupi: HupijiaoClient = {
  async createQr() {
    const next = mockNextCreate ?? { kind: "ok" as const, qrcode: "weixin://wxpay/bizpayurl?pr=MOCK" };
    mockNextCreate = null;
    if (next.kind === "err") throw new HupijiaoError(next.code, next.message);
    return { qrcodeUrl: next.qrcode, mobileUrl: null, providerOrder: next.providerOrder ?? "MOCK_PX", raw: {} };
  },
};

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    try { r.disconnect(); } catch { /* ignore */ }
    return null;
  }
}

async function seedAllowRegistration(): Promise<void> {
  await query(
    `INSERT INTO system_settings(key, value, updated_at)
     VALUES ('allow_registration', 'true'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  );
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
    await resetTestSchemaForTest();
    await runMigrations();
    await warmupLoginDummyHash();
    await seedAllowRegistration();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }
  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) throw new Error("Redis test fixture required");
  if (pgAvailable && redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      refreshCookieSecure: false,
      hupijiao: mockHupi,
      hupijiaoConfig: { appId: HUPI_APP_ID, appSecret: HUPI_SECRET },
      rateLimits: {
        register: { scope: "funnel_reg", windowSeconds: 60, max: 100 },
        login: { scope: "funnel_login", windowSeconds: 60, max: 100 },
        requestReset: { scope: "funnel_reset", windowSeconds: 60, max: 100 },
        resendVerify: { scope: "funnel_resend", windowSeconds: 60, max: 100 },
        verifyEmail: { scope: "funnel_verify", windowSeconds: 60, max: 100 },
        verifyEmailEmail: { scope: "funnel_verify_email", windowSeconds: 1800, max: 100 },
        hupiCreate: { scope: "funnel_hupi", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (redis) {
    try { await redis.flushdb(); } catch { /* ignore */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  await query("TRUNCATE TABLE product_friction_events, orders, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  await seedAllowRegistration();
  await redis.flushdb();
  mailer.sent.length = 0;
  mockNextCreate = null;
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip("pg/redis/server not available");
    return true;
  }
  return false;
}

async function postJson(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try { json = (await resp.json()) as Record<string, unknown>; } catch { /* ignore */ }
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
  return { status: resp.status, text: await resp.text() };
}

describe("OCV5-104 funnel events (integ)", () => {
  test("auth register/resend/verify/login each write one row with user_id", async (t) => {
    if (skipIfMissing(t)) return;
    const email = "funnel-auth@example.com";
    const password = "funnel good password";
    const reg = await postJson("/api/auth/register", { email, password, turnstile_token: "tok" });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const userId = String(reg.json.user_id);
    const mail = mailer.sent.find((m) => m.to === email);
    assert.ok(mail);
    const code = mail.text.match(/\n {4}(\d{6})\n/)?.[1];
    assert.ok(code);

    const resend = await postJson("/api/auth/resend-verification", { email });
    assert.equal(resend.status, 200, JSON.stringify(resend.json));
    const latest = mailer.sent.filter((m) => m.to === email).at(-1);
    const resendCode = latest?.text.match(/\n {4}(\d{6})\n/)?.[1] ?? code;

    const verify = await postJson("/api/auth/verify-email", { email, code: resendCode });
    assert.equal(verify.status, 200, JSON.stringify(verify.json));

    const login = await postJson("/api/auth/login", { email, password, turnstile_token: "tok" });
    assert.equal(login.status, 200, JSON.stringify(login.json));

    const funnel = await query<{ stage: string; code: string; outcome: string; user_id: string }>(
      `SELECT stage, code, outcome, user_id::text AS user_id
         FROM product_friction_events
        WHERE user_id = $1 AND surface = 'auth'
        ORDER BY created_at`,
      [userId],
    );
    const keys = funnel.rows.map((row) => `${row.stage}/${row.outcome}/${row.code}`);
    assert.ok(keys.includes("register/succeeded/REGISTERED"), keys.join(","));
    assert.ok(keys.includes("resend/succeeded/RESEND"), keys.join(","));
    assert.ok(keys.includes("verify/succeeded/VERIFIED"), keys.join(","));
    assert.ok(keys.includes("login/succeeded/email"), keys.join(","));
    assert.ok(funnel.rows.every((row) => row.user_id === userId));
  });

  test("payment checkout then paid write kind_plan code and latency_ms", async (t) => {
    if (skipIfMissing(t)) return;
    const email = "funnel-pay@example.com";
    const ins = await query<{ id: string }>(
      "INSERT INTO users(email, password_hash, credits, email_verified, status) VALUES($1,'argon2$stub',0,true,'active') RETURNING id::text AS id",
      [email],
    );
    const uid = ins.rows[0].id;
    const issued = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
    mockNextCreate = { kind: "ok", qrcode: "weixin://wxpay/MOCK_QR_FUNNEL", providerOrder: "PX_F" };
    const created = await postJson("/api/payment/hupi/create", { plan_code: "plan-10" }, issued.token);
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const data = created.json.data as { order_no: string };
    const checkout = await query<{ stage: string; code: string; outcome: string }>(
      `SELECT stage, code, outcome FROM product_friction_events
        WHERE user_id = $1 AND surface = 'payment' AND stage = 'checkout'`,
      [uid],
    );
    assert.equal(checkout.rows.length, 1, JSON.stringify(checkout.rows));
    assert.equal(checkout.rows[0].outcome, "succeeded");
    assert.equal(checkout.rows[0].code, "topup_plan_10");

    const form: Record<string, string> = {
      version: "1.1",
      appid: HUPI_APP_ID,
      trade_order_id: data.order_no,
      transaction_id: "WX_TX_FUNNEL",
      total_fee: "10.00",
      status: "OD",
      nonce_str: "xxx",
      time: "1800000000",
    };
    form.hash = signHupijiao(form, HUPI_SECRET);
    const paid = await postForm("/api/payment/hupi/callback", form);
    assert.equal(paid.status, 200);
    assert.equal(paid.text, "success");
    const paidRow = await query<{ stage: string; outcome: string; latency_ms: number | null }>(
      `SELECT stage, outcome, latency_ms FROM product_friction_events
        WHERE user_id = $1 AND surface = 'payment' AND stage = 'paid'`,
      [uid],
    );
    assert.equal(paidRow.rows.length, 1, JSON.stringify(paidRow.rows));
    assert.equal(paidRow.rows[0].outcome, "succeeded");
    assert.ok(paidRow.rows[0].latency_ms == null || paidRow.rows[0].latency_ms >= 0);
  });
});
