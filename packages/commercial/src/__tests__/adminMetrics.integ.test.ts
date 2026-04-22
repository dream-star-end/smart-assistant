/**
 * T-62 集成:/api/admin/metrics + alertScheduler。
 *
 * 覆盖验收点(07-TASKS T-62):
 *   1. 单元:normalizeRoute 折叠动态段
 *   2. 集成:curl /api/admin/metrics 看到 counters(含 gateway_http_requests_total)
 *   3. 集成:账号池全部 down → alert scheduler 触发 Telegram(assert sender 收到消息)
 *   4. 集成:无账号 → no_accounts_configured 触发
 *   5. 集成:非 admin 请求 /metrics → 403
 *   6. 单元:firing → resolved 转换
 *
 * pg/redis 不可用时 skip。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";
import {
  normalizeRoute,
  renderPrometheus,
  incrGatewayRequest,
  incrBillingDebit,
  incrClaudeApi,
  resetMetricsForTest,
  snapshotForAlerts,
} from "../admin/metrics.js";
import {
  ruleAccountPoolAllDown,
  ruleNoAccountsConfigured,
  type Snapshot,
} from "../admin/alerts.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
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
  "users",
  "schema_migrations",
];

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> { /* drop */ }
}

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1,
  });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch { /* */ } return null; }
}

before(async () => {
  // AEAD key 必须先于任何 account 插入
  process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x7a).toString("base64");

  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();

  redis = await probeRedis();
  if (redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      rateLimits: {
        register: { scope: "register_t62", windowSeconds: 60, max: 100 },
        login: { scope: "login_t62", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t62", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.statusCode = 404; res.end("nope"); }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    try { server.closeAllConnections(); } catch { /* */ }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  resetMetricsForTest();
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE admin_audit, usage_records, credit_ledger, claude_accounts, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  // model_pricing seed 不需要(本测试没走 chat);但部分 FK 依赖 users.updated_by 重放
  if (redis) await redis.flushdb();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}
function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUser(
  email: string, role: "user" | "admin" = "user",
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  );
  return BigInt(r.rows[0].id);
}

async function tokenFor(uid: bigint, role: "user" | "admin"): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET);
  return r.token;
}

async function insertAccount(label: string, status: "active" | "cooldown" | "disabled" | "banned", health: number): Promise<bigint> {
  // 不走 store.createAccount 的 AEAD 加密(label 可变,简化测试) —— 直接插 dummy 密文
  const dummy = Buffer.alloc(32, 0x11);
  const nonce = Buffer.alloc(12, 0x22);
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, oauth_token_enc, oauth_nonce, status, health_score)
     VALUES ($1, 'pro', $2, $3, $4, $5) RETURNING id::text AS id`,
    [label, dummy, nonce, status, health],
  );
  return BigInt(r.rows[0].id);
}

// ============================================================
// 单元:normalizeRoute
// ============================================================

describe("admin metrics — normalizeRoute", () => {
  test("折叠用户 id / credits / model_id / plan code / account id / order no", () => {
    assert.equal(normalizeRoute("/api/admin/users/42"), "/api/admin/users/:id");
    assert.equal(normalizeRoute("/api/admin/users/42/credits"), "/api/admin/users/:id/credits");
    assert.equal(normalizeRoute("/api/admin/pricing/claude-sonnet-4-6"), "/api/admin/pricing/:model_id");
    assert.equal(normalizeRoute("/api/admin/plans/plan-10"), "/api/admin/plans/:code");
    assert.equal(normalizeRoute("/api/admin/accounts/7"), "/api/admin/accounts/:id");
    assert.equal(normalizeRoute("/api/admin/agent-containers/3/restart"), "/api/admin/agent-containers/:id/:action");
    assert.equal(normalizeRoute("/api/payment/orders/ORD_abc_123"), "/api/payment/orders/:order_no");
  });

  test("未识别路径原样返回", () => {
    assert.equal(normalizeRoute("/api/me"), "/api/me");
    assert.equal(normalizeRoute("/healthz"), "/healthz");
  });
});

// ============================================================
// 单元:render Prometheus 文本
// ============================================================

describe("admin metrics — render", () => {
  test("计数器累加 + 标签渲染,help/type 行都在", async () => {
    resetMetricsForTest();
    incrGatewayRequest("/api/me", "GET", 200);
    incrGatewayRequest("/api/me", "GET", 200);
    incrGatewayRequest("/api/me", "GET", 401);
    incrBillingDebit("success");
    incrBillingDebit("insufficient");
    incrClaudeApi(42n, "success");
    incrClaudeApi(null, "error");

    const text = await renderPrometheus({ override: { accountHealth: [], agentContainersRunning: 0 } });
    // HELP/TYPE
    assert.ok(text.includes("# HELP gateway_http_requests_total"), "gateway HELP line");
    assert.ok(text.includes("# TYPE gateway_http_requests_total counter"));
    // 累加值
    assert.ok(/gateway_http_requests_total\{.*status="200".*\} 2/.test(text), "counter sum = 2");
    assert.ok(/gateway_http_requests_total\{.*status="401".*\} 1/.test(text));
    // billing
    assert.ok(/billing_debit_total\{result="success"\} 1/.test(text));
    assert.ok(/billing_debit_total\{result="insufficient"\} 1/.test(text));
    // claude
    assert.ok(/claude_api_requests_total\{account_id="42",status="success"\} 1/.test(text));
    assert.ok(/claude_api_requests_total\{account_id="",status="error"\} 1/.test(text));
    // gauges
    assert.ok(text.includes("# TYPE account_pool_health gauge"));
    assert.ok(text.includes("# TYPE agent_containers_running gauge"));
    assert.ok(/agent_containers_running 0/.test(text));
  });

  test("gauges 从 override 抽 —— account_pool_health 带 label", async () => {
    resetMetricsForTest();
    const text = await renderPrometheus({
      override: {
        accountHealth: [
          { account_id: "1", health_score: 80, status: "active" },
          { account_id: "2", health_score: 0, status: "disabled" },
        ],
        agentContainersRunning: 3,
      },
    });
    assert.ok(/account_pool_health\{account_id="1",status="active"\} 80/.test(text));
    assert.ok(/account_pool_health\{account_id="2",status="disabled"\} 0/.test(text));
    assert.ok(/agent_containers_running 3/.test(text));
  });
});

// ============================================================
// 集成:HTTP /api/admin/metrics 端到端
// ============================================================

describe("admin metrics — HTTP", () => {
  test("非 admin GET /api/admin/metrics → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await createUser("u1@t.com", "user");
    const tk = await tokenFor(u, "user");
    const r = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { authorization: `Bearer ${tk}` },
    });
    assert.equal(r.status, 403);
  });

  test("admin GET /api/admin/metrics → text/plain + Prometheus 体", async (t) => {
    if (skipIfNoHttp(t)) return;
    resetMetricsForTest();
    const admin = await createUser("adm@t.com", "admin");
    const tk = await tokenFor(admin, "admin");
    // 先敲几次别的端点,让 gateway counter 非零
    await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${tk}` } });
    await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${tk}` } });

    const r = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { authorization: `Bearer ${tk}` },
    });
    assert.equal(r.status, 200);
    const ct = r.headers.get("content-type") ?? "";
    assert.ok(ct.startsWith("text/plain"), `content-type must be text/plain, got: ${ct}`);
    const body = await r.text();
    assert.ok(body.includes("# HELP gateway_http_requests_total"));
    // route label 应为折叠后的固定值 /api/me(精确路由定义)
    assert.ok(/gateway_http_requests_total\{route="\/api\/me"/.test(body), body);
    // 至少一条账号池 gauge(空 fleet 时没有 series,只有 HELP/TYPE —— 也是合法)
    assert.ok(body.includes("# TYPE account_pool_health gauge"));
    // agent_containers_running 为 0(无容器)
    assert.ok(/agent_containers_running 0/.test(body));
  });

  test("metrics 体积合理 —— 响应头包含 no-store", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("adm2@t.com", "admin");
    const tk = await tokenFor(admin, "admin");
    const r = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { authorization: `Bearer ${tk}` },
    });
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
});

// ============================================================
// 集成:snapshotForAlerts 从 DB 抽
// ============================================================

describe("admin metrics — snapshotForAlerts", () => {
  test("空账号池 → accountHealth=[],agentContainersRunning=0", async (t) => {
    if (skipIfNoPg(t)) return;
    const s = await snapshotForAlerts();
    assert.deepEqual(s.accountHealth, []);
    assert.equal(s.agentContainersRunning, 0);
  });

  test("插 3 个不同状态账号 → snapshot 按 id 排序完整返回", async (t) => {
    if (skipIfNoPg(t)) return;
    await insertAccount("a1", "active", 90);
    await insertAccount("a2", "cooldown", 50);
    await insertAccount("a3", "disabled", 0);
    const s = await snapshotForAlerts();
    assert.equal(s.accountHealth.length, 3);
    assert.equal(s.accountHealth[0].status, "active");
    assert.equal(s.accountHealth[0].health_score, 90);
    assert.equal(s.accountHealth[2].status, "disabled");
  });
});

// ============================================================
// 单元:rules
// ============================================================

describe("admin metrics — rules", () => {
  test("ruleAccountPoolAllDown:全部账号 disabled → firing", () => {
    const s: Snapshot = {
      accountHealth: [
        { account_id: "1", health_score: 0, status: "disabled" },
        { account_id: "2", health_score: 50, status: "cooldown" },
      ],
      agentContainersRunning: 0,
    };
    assert.equal(ruleAccountPoolAllDown.evaluate(s), true);
    const msg = ruleAccountPoolAllDown.firingMessage(s);
    assert.ok(msg.includes("账号池全部失效"));
    assert.ok(msg.includes("#1"));
  });

  test("ruleAccountPoolAllDown:有一个 active+health>0 → 不 firing", () => {
    const s: Snapshot = {
      accountHealth: [
        { account_id: "1", health_score: 0, status: "disabled" },
        { account_id: "2", health_score: 80, status: "active" },
      ],
      agentContainersRunning: 0,
    };
    assert.equal(ruleAccountPoolAllDown.evaluate(s), false);
  });

  test("ruleAccountPoolAllDown:账号池空 → 由 no_accounts 管,不 firing", () => {
    const s: Snapshot = { accountHealth: [], agentContainersRunning: 0 };
    assert.equal(ruleAccountPoolAllDown.evaluate(s), false);
  });

  test("ruleNoAccountsConfigured:空 → firing", () => {
    const s: Snapshot = { accountHealth: [], agentContainersRunning: 0 };
    assert.equal(ruleNoAccountsConfigured.evaluate(s), true);
  });

  test("ruleNoAccountsConfigured:有账号 → 不 firing", () => {
    const s: Snapshot = {
      accountHealth: [{ account_id: "1", health_score: 0, status: "disabled" }],
      agentContainersRunning: 0,
    };
    assert.equal(ruleNoAccountsConfigured.evaluate(s), false);
  });
});

// NOTE: T-62 的 "alertScheduler fire → resolve" 集成测试已删除。T-63 把 scheduler
// 重构成 runRulesOnce()(写 outbox)+ iLink worker(读 outbox 发微信),旧的
// sender/rules 注入 + firingRules() 接口不再存在。相应集成测试见
// `alertOutbox.integ.test.ts` + `alertRules.integ.test.ts`(T-63 新增)。
