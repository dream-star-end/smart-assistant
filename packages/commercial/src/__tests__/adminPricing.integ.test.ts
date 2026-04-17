/**
 * T-60 集成:/api/admin/pricing + /api/admin/plans 端到端。
 *
 * 覆盖验收点:
 *   1. admin GET /pricing → 列表
 *   2. admin PATCH /pricing/:model_id(multiplier + enabled) → 行更新 + admin_audit
 *   3. 关键验收:"admin 改倍率 → pricing 更新 + admin_audit 记录"
 *      LISTEN/NOTIFY:PricingCache 开监听,patch 后收到 pricing_changed → onReload 触发
 *   4. 非 admin → 403;未知 model → 404;非法 multiplier → 400
 *   5. admin GET /plans → 列表;PATCH /plans/:code → label/amount/credits/sort/enabled 更新 + audit
 *   6. PATCH /plans/:code 不存在 → 404;非法 amount_cents → 400
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
import { PricingCache } from "../billing/pricing.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";
import {
  listPricing,
  patchPricing,
  normalizeMultiplier,
  PricingNotFoundError,
} from "../admin/pricing.js";
import {
  listPlans,
  patchPlan,
  PlanNotFoundError,
} from "../admin/plans.js";
import { listAdminAudit } from "../admin/audit.js";

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
        register: { scope: "register_t60p", windowSeconds: 60, max: 100 },
        login: { scope: "login_t60p", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t60p", windowSeconds: 60, max: 100 },
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
  if (!pgAvailable) return;
  // 说明:users 有 FK 反向挂 model_pricing.updated_by → TRUNCATE CASCADE 会顺带清空
  // model_pricing(以及 credit_ledger/usage_records)。因此每次重放 0007 种子保证:
  //   - 本次测试永远有至少 2 条 model_pricing / 4 条 topup_plans
  //   - multiplier/enabled 回到初始值
  await query("TRUNCATE TABLE admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  await query(
    `INSERT INTO model_pricing(
       model_id, display_name, input_per_mtok, output_per_mtok,
       cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order
     ) VALUES
       ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 300, 1500,  30,  375, 2.0, TRUE, 100),
       ('claude-opus-4-7',   'Claude Opus 4.7',  1500, 7500, 150, 1875, 2.0, TRUE,  90)
     ON CONFLICT (model_id) DO UPDATE SET
       multiplier = EXCLUDED.multiplier,
       enabled = EXCLUDED.enabled,
       updated_by = NULL`,
  );
  await query(
    `INSERT INTO topup_plans(code, label, amount_cents, credits, sort_order, enabled) VALUES
       ('plan-10',   '¥10 → 10 积分',              1000,   1000, 100, TRUE),
       ('plan-50',   '¥50 → 55 积分(赠 10%)',     5000,   5500,  90, TRUE),
       ('plan-200',  '¥200 → 240 积分(赠 20%)',  20000,  24000,  80, TRUE),
       ('plan-1000', '¥1000 → 1300 积分(赠 30%)',100000, 130000,  70, TRUE)
     ON CONFLICT (code) DO UPDATE SET
       label = EXCLUDED.label,
       amount_cents = EXCLUDED.amount_cents,
       credits = EXCLUDED.credits,
       sort_order = EXCLUDED.sort_order,
       enabled = EXCLUDED.enabled`,
  );
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

// ============================================================
// DB 层:normalizeMultiplier / patchPricing / patchPlan
// ============================================================

describe("admin pricing — DB layer", () => {
  test("normalizeMultiplier: 合法/非法边界", () => {
    assert.equal(normalizeMultiplier(1.5), "1.500");
    assert.equal(normalizeMultiplier("2.1"), "2.1");
    assert.equal(normalizeMultiplier("0.001"), "0.001");
    assert.equal(normalizeMultiplier("999.999"), "999.999");
    assert.equal(normalizeMultiplier(10), "10.000");

    assert.throws(() => normalizeMultiplier(0), RangeError);
    assert.throws(() => normalizeMultiplier(-1), RangeError);
    assert.throws(() => normalizeMultiplier(1000), RangeError);
    assert.throws(() => normalizeMultiplier("abc"), RangeError);
    assert.throws(() => normalizeMultiplier("1.2345"), RangeError);
    assert.throws(() => normalizeMultiplier(null), RangeError);
    assert.throws(() => normalizeMultiplier(NaN), RangeError);
  });

  test("listPricing: 返 seed 数据(多条,含 multiplier 字符串)", async (t) => {
    if (skipIfNoPg(t)) return;
    const rows = await listPricing();
    assert.ok(rows.length > 0, "至少一条种子");
    // multiplier 是 NUMERIC(6,3) → text
    assert.ok(/^\d+\.\d{1,3}$/.test(rows[0].multiplier));
  });

  test("patchPricing: multiplier + enabled → 更新 + admin_audit 记录", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    // 挑第一条 seed
    const before = await listPricing();
    const modelId = before[0].model_id;

    const after = await patchPricing(modelId, { multiplier: "2.500", enabled: false }, {
      adminId: admin, ip: "1.2.3.4", userAgent: "UA",
    });
    assert.equal(after.multiplier, "2.500");
    assert.equal(after.enabled, false);
    assert.equal(after.updated_by, admin.toString());

    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].action, "pricing.patch");
    assert.equal(audits.rows[0].target, `model:${modelId}`);
    assert.equal((audits.rows[0].after as Record<string, unknown>).multiplier, "2.500");
    assert.equal((audits.rows[0].after as Record<string, unknown>).enabled, false);
  });

  test("patchPricing: 空 patch → 返当前行,不写 audit", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const before = await listPricing();
    const r = await patchPricing(before[0].model_id, {}, { adminId: admin });
    assert.equal(r.model_id, before[0].model_id);
    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 0);
  });

  test("patchPricing: 不存在 → PricingNotFoundError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    await assert.rejects(
      () => patchPricing("nope-xyz", { multiplier: "2.000" }, { adminId: admin }),
      (e) => e instanceof PricingNotFoundError,
    );
  });

  test("patchPricing: 非法 multiplier → RangeError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const before = await listPricing();
    await assert.rejects(
      () => patchPricing(before[0].model_id, { multiplier: "2000" }, { adminId: admin }),
      (e) => e instanceof RangeError,
    );
  });
});

describe("admin plans — DB layer", () => {
  test("listPlans: 返 seed,sort_order DESC", async (t) => {
    if (skipIfNoPg(t)) return;
    const rows = await listPlans();
    assert.ok(rows.length > 0);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].sort_order >= rows[i].sort_order);
    }
  });

  test("patchPlan: label + enabled → 更新 + audit(只含 changed 字段)", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const before = await listPlans();
    const code = before[0].code;
    const origLabel = before[0].label;

    const after = await patchPlan(code, { label: "新标签", enabled: false }, {
      adminId: admin, ip: "8.8.8.8", userAgent: "UA2",
    });
    assert.equal(after.label, "新标签");
    assert.equal(after.enabled, false);

    const audits = await listAdminAudit({});
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].action, "plan.patch");
    assert.equal(audits.rows[0].target, `plan:${code}`);
    // before 只含变更字段
    const bObj = audits.rows[0].before as Record<string, unknown>;
    assert.deepEqual(Object.keys(bObj).sort(), ["enabled", "label"]);
    assert.equal(bObj.label, origLabel);
    assert.equal(bObj.enabled, true);
  });

  test("patchPlan: amount_cents + credits → 更新", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const before = await listPlans();
    const code = before[0].code;

    const after = await patchPlan(code, { amount_cents: 1999, credits: "50000" }, {
      adminId: admin,
    });
    assert.equal(after.amount_cents, "1999");
    assert.equal(after.credits, "50000");
  });

  test("patchPlan: 非法 amount_cents → RangeError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const before = await listPlans();
    await assert.rejects(
      () => patchPlan(before[0].code, { amount_cents: -1 }, { adminId: admin }),
      (e) => e instanceof RangeError,
    );
    await assert.rejects(
      () => patchPlan(before[0].code, { amount_cents: "abc" }, { adminId: admin }),
      (e) => e instanceof RangeError,
    );
  });

  test("patchPlan: 不存在 code → PlanNotFoundError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    await assert.rejects(
      () => patchPlan("nope-plan", { label: "x" }, { adminId: admin }),
      (e) => e instanceof PlanNotFoundError,
    );
  });
});

// ============================================================
// NOTIFY pricing_changed:核心验收
// ============================================================

describe("admin pricing — NOTIFY 联动", () => {
  test("关键验收:admin 改倍率 → pricing_changed → PricingCache.onReload 触发", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const cache = new PricingCache();
    let reloadCount = 0;
    const reloadedOnce = new Promise<void>((resolve) => {
      cache.onReload = (_n) => {
        reloadCount += 1;
        if (reloadCount >= 2) resolve(); // 1=initial load, 2=after patch
      };
    });
    await cache.load();
    await cache.startListener(TEST_DB_URL);

    try {
      const before = await listPricing();
      await patchPricing(before[0].model_id, { multiplier: "3.000" }, { adminId: admin });

      // 最多等 3 秒,够 NOTIFY 回路
      await Promise.race([
        reloadedOnce,
        new Promise((_, rej) => setTimeout(() => rej(new Error("NOTIFY timeout")), 3000)),
      ]);
      // 缓存内应该也变了
      const p = cache.get(before[0].model_id);
      assert.ok(p);
      assert.equal(p.multiplier, "3.000");
    } finally {
      await cache.shutdown();
    }
  });
});

// ============================================================
// HTTP:/api/admin/pricing + /api/admin/plans
// ============================================================

describe("admin pricing/plans — HTTP", () => {
  test("非 admin → 403;admin GET /pricing → 列表", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await createUser("u@x.com");
    const a = await createUser("a@x.com", "admin");
    const uTok = await tokenFor(u, "user");
    const aTok = await tokenFor(a, "admin");

    const r1 = await fetch(`${baseUrl}/api/admin/pricing`, {
      headers: { Authorization: `Bearer ${uTok}` },
    });
    assert.equal(r1.status, 403);

    const r2 = await fetch(`${baseUrl}/api/admin/pricing`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r2.status, 200);
    const body = (await r2.json()) as { rows: unknown[] };
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.rows.length > 0);
  });

  test("PATCH /pricing/:model_id:合法 → 200,非法 → 400,unknown → 404", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");
    const seed = await listPricing();
    const modelId = seed[0].model_id;

    // 合法
    const ok = await fetch(`${baseUrl}/api/admin/pricing/${modelId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ multiplier: "2.250" }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { pricing: { multiplier: string } };
    assert.equal(okBody.pricing.multiplier, "2.250");

    // 非法 multiplier
    const bad = await fetch(`${baseUrl}/api/admin/pricing/${modelId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ multiplier: "1000" }),
    });
    assert.equal(bad.status, 400);

    // 未知 model
    const notFound = await fetch(`${baseUrl}/api/admin/pricing/nope-xyz`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ multiplier: "2.000" }),
    });
    assert.equal(notFound.status, 404);
  });

  test("GET /plans + PATCH /plans/:code → 200 + audit", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");

    const list = await fetch(`${baseUrl}/api/admin/plans`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { rows: Array<{ code: string }> };
    assert.ok(body.rows.length > 0);
    const code = body.rows[0].code;

    const p = await fetch(`${baseUrl}/api/admin/plans/${code}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, sort_order: 999 }),
    });
    assert.equal(p.status, 200);
    const pBody = (await p.json()) as { plan: { enabled: boolean; sort_order: number } };
    assert.equal(pBody.plan.enabled, false);
    assert.equal(pBody.plan.sort_order, 999);

    const audits = await listAdminAudit({ action: "plan.patch" });
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].target, `plan:${code}`);
  });

  test("PATCH /plans/:code unknown → 404;bad amount → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");

    const nf = await fetch(`${baseUrl}/api/admin/plans/nope-plan`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    assert.equal(nf.status, 404);

    const seed = await listPlans();
    const bad = await fetch(`${baseUrl}/api/admin/plans/${seed[0].code}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: -5 }),
    });
    assert.equal(bad.status, 400);
  });

  test("非法 method 到 /pricing/:x → 405 Allow: PATCH", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");
    const seed = await listPricing();
    const r = await fetch(`${baseUrl}/api/admin/pricing/${seed[0].model_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r.status, 405);
    assert.ok(r.headers.get("allow")?.includes("PATCH"));
  });
});
