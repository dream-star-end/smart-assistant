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
import { setClientSessionsBackend } from "@openclaude/storage";
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
import { listModelUsageAggregates } from "../admin/modelOps.js";
import {
  recordProductFrictionEvent,
  transitionProductFrictionEventIfPresent,
} from "../productFriction/events.js";
import { createPgSessionsBackend } from "../db/pgSessionsBackend.js";
import { resetTestSchemaForTest } from "./helpers/db.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

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
  await resetTestSchemaForTest();
  await runMigrations();
  // Production injects this backend in the composition root. This handler
  // integration test builds the router directly, so mirror that one-time
  // injection or lifecycle classification would incorrectly hit test-host
  // SQLite instead of the freshly migrated PG authority.
  setClientSessionsBackend(createPgSessionsBackend(pool, { expectedGeneration: 0 }));

  redis = await probeRedis();

  // fixture fail-closed:缺 Redis 时此前静默降级(整份套件的 HTTP 路径不装配),

  // 于是"绿"只证明了没跑。REQUIRE_TEST_DB/CI 下必须红 —— 2026-07-26 门禁审计。

  if (!redis && REQUIRE_TEST_DB) {

    throw new Error("Redis test fixture required (TEST_REDIS_URL) — refusing to silently degrade");

  }
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
    try { await resetTestSchemaForTest(); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // users 被 model_pricing.updated_by 反向引用；TRUNCATE users CASCADE 会清空
  // 权威模型定价并触发 0144 必需运行模型保护。只清理每例断言涉及的用户态
  // 子表，用户用唯一邮箱追加，整文件结束时统一 DROP。
  await query(
    "TRUNCATE TABLE admin_audit, product_friction_events, image_generation_attempts, image_generation_usage_records, github_session_workspaces, request_finalize_journal, usage_records, credit_ledger, refresh_tokens, email_verifications RESTART IDENTITY CASCADE",
  );
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
  const uniqueEmail = email.replace("@", `+${Date.now()}-${Math.random().toString(16).slice(2)}@`);
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [uniqueEmail, role],
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
  test("product friction state is atomic/monotonic and never stores raw correlation", async (t) => {
    if (skipIfNoPg(t)) return;
    const user = await createUser("friction-state@x.com");
    const base = {
      correlation: "raw-session-secret-must-not-persist",
      userId: user,
      surface: "auth",
      stage: "refresh",
      code: "REFRESH_RACE",
    } as const;
    await recordProductFrictionEvent({ ...base, outcome: "pending", attempts: 1 });
    await recordProductFrictionEvent({ ...base, outcome: "failed", attempts: 2 });
    await recordProductFrictionEvent({ ...base, outcome: "recovered", attempts: 3 });
    await recordProductFrictionEvent({ ...base, outcome: "failed", attempts: 4 });
    const row = await query<{ event_key: string; outcome: string; attempts: number; recovered_at: Date | null }>(
      `SELECT event_key, outcome, attempts, recovered_at FROM product_friction_events
        WHERE user_id=$1 AND surface='auth' AND stage='refresh'`,
      [user.toString()],
    );
    assert.equal(row.rows.length, 1);
    assert.match(row.rows[0]!.event_key, /^[0-9a-f]{64}$/);
    assert.notEqual(row.rows[0]!.event_key, base.correlation);
    assert.equal(row.rows[0]!.outcome, "recovered", "late failure cannot overwrite recovery");
    assert.equal(row.rows[0]!.attempts, 4, "attempt count remains monotonic");
    assert.ok(row.rows[0]!.recovered_at instanceof Date);

    await recordProductFrictionEvent({
      ...base,
      correlation: "terminal-abandoned-journey",
      outcome: "abandoned",
    });
    await recordProductFrictionEvent({
      ...base,
      correlation: "terminal-abandoned-journey",
      outcome: "recovered",
      attempts: 2,
    });
    const terminal = await query<{ outcome: string; recovered_at: Date | null }>(
      `SELECT outcome, recovered_at FROM product_friction_events
        WHERE user_id=$1 AND outcome='abandoned'`,
      [user.toString()],
    );
    assert.equal(terminal.rows.length, 1);
    assert.equal(terminal.rows[0]!.outcome, "abandoned");
    assert.equal(terminal.rows[0]!.recovered_at, null, "late recovery cannot annotate a terminal abandonment");
  });

  test("durable recovery transition records failure once and terminal replay is immutable", async (t) => {
    if (skipIfNoPg(t)) return;
    const user = await createUser("friction-transition@x.com");
    const identity = {
      correlation: "durable-recovery-transition",
      surface: "ws",
      stage: "billing_recovery",
    } as const;
    await recordProductFrictionEvent({
      ...identity,
      userId: user,
      code: "USER_WS_DETACHED",
      outcome: "pending",
      attempts: 1,
    });
    assert.equal(await transitionProductFrictionEventIfPresent({
      ...identity,
      outcome: "failed",
    }), true);
    let state = await query<{
      outcome: string;
      attempts: number;
      updated_at: Date;
      recovered_at: Date | null;
    }>(
      `SELECT outcome,attempts,updated_at,recovered_at
         FROM product_friction_events WHERE user_id=$1 AND stage='billing_recovery'`,
      [user.toString()],
    );
    assert.equal(state.rows[0]!.outcome, "failed");
    assert.equal(state.rows[0]!.attempts, 2);

    assert.equal(await transitionProductFrictionEventIfPresent({
      ...identity,
      outcome: "recovered",
    }), true);
    state = await query(
      `SELECT outcome,attempts,updated_at,recovered_at
         FROM product_friction_events WHERE user_id=$1 AND stage='billing_recovery'`,
      [user.toString()],
    );
    assert.equal(state.rows[0]!.outcome, "recovered");
    assert.equal(state.rows[0]!.attempts, 3);
    assert.ok(state.rows[0]!.recovered_at instanceof Date);
    const terminalUpdatedAt = state.rows[0]!.updated_at;

    await query("SELECT pg_sleep(0.01)");
    assert.equal(await transitionProductFrictionEventIfPresent({
      ...identity,
      outcome: "recovered",
    }), false, "already-committed replay must not mutate a terminal journey");
    state = await query(
      `SELECT outcome,attempts,updated_at,recovered_at
         FROM product_friction_events WHERE user_id=$1 AND stage='billing_recovery'`,
      [user.toString()],
    );
    assert.equal(state.rows[0]!.attempts, 3);
    assert.equal(state.rows[0]!.updated_at.getTime(), terminalUpdatedAt.getTime());
  });

  test("model usage uses terminal journal attempts and joins usage by usage_id only", async (t) => {
    if (skipIfNoPg(t)) return;
    const user = await createUser("usage-attempts@x.com");
    const usage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',10,5,2,'{}'::jsonb,7,'usage-committed','success')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const codexErrorUsage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',3,1,0,'{"codex_status":"error"}'::jsonb,2,'usage-codex-error','success')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const partialUsage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',4,2,1,'{}'::jsonb,0,'usage-partial','billing_failed')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const waivedUsage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',6,0,0,'{"waived":"no_output"}'::jsonb,0,'usage-waived','success')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const usageError = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',2,0,0,'{}'::jsonb,0,'usage-error','error')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const legacyNoOutput = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',7,0,0,'{}'::jsonb,0,'usage-legacy-no-output','success')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    const codexCancelled = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, cache_read_tokens,
          price_snapshot, cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',8,3,1,
               '{"codex_status":"error","codex_terminal_code":"USER_CANCELLED"}'::jsonb,
               4,'usage-codex-cancelled','success')
       RETURNING id::text AS id`,
      [user.toString()],
    );
    await query(
      `INSERT INTO request_finalize_journal
         (request_id,user_id,state,ctx,precheck_credits,final_credits,usage_id,failure_code)
       VALUES
         ('usage-committed',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,7,7,$2,NULL),
         ('usage-codex-error',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,2,2,$3,NULL),
         ('usage-partial',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$4,NULL),
         ('usage-waived',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$5,NULL),
         ('usage-error',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$6,NULL),
         ('usage-legacy-no-output',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$7,NULL),
         ('usage-codex-cancelled',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,4,4,$8,NULL),
         ('usage-missing',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,NULL,NULL),
         ('usage-failed',$1,'aborted','{"model":"qwen3.7-max"}'::jsonb,7,0,NULL,'UPSTREAM_REJECTED'),
         ('usage-cancelled',$1,'aborted','{"model":"qwen3.7-max"}'::jsonb,7,0,NULL,'CLIENT_ABORT')`,
      [
        user.toString(), usage.rows[0]!.id, codexErrorUsage.rows[0]!.id,
        partialUsage.rows[0]!.id, waivedUsage.rows[0]!.id, usageError.rows[0]!.id,
        legacyNoOutput.rows[0]!.id, codexCancelled.rows[0]!.id,
      ],
    );
    // A usage row without a journal is not an additional request truth source.
    await query(
      `INSERT INTO usage_records
         (user_id, mode, model, input_tokens, output_tokens, price_snapshot,
          cost_credits, request_id, status)
       VALUES ($1,'chat','qwen3.7-max',999,999,'{}'::jsonb,999,'usage-orphan','success')`,
      [user.toString()],
    );

    const qwen = (await listModelUsageAggregates())["qwen3.7-max"];
    assert.deepEqual(qwen.d1, {
      attempts: 10,
      requests: 1,
      failures: 7,
      cancellations: 2,
      input_tokens: "40",
      output_tokens: "11",
      cache_read_tokens: "4",
      credits: "13",
    });
    assert.equal(
      qwen.d1.attempts,
      qwen.d1.requests + qwen.d1.failures + qwen.d1.cancellations,
      "terminal partition must be mutually exclusive and exhaustive",
    );
  });

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
    // 运行必需模型受 0144 防误停保护；此用例专门选非必需种子验证 enabled=false。
    const modelId = "claude-sonnet-4-6";

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
  test("GET /product-friction returns recovery-aware source-separated telemetry", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("friction-admin@x.com", "admin");
    const affected = await createUser("friction-user@x.com");
    await recordProductFrictionEvent({
      correlation: "refresh-journey-1",
      userId: affected,
      surface: "auth",
      stage: "refresh",
      code: "REFRESH_RACE",
      outcome: "recovered",
      attempts: 2,
    });
    const waivedUsage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,input_tokens,output_tokens,price_snapshot,cost_credits,request_id,status)
       VALUES ($1,'chat','qwen3.7-max',12,0,'{"waived":"no_output"}'::jsonb,0,'friction-model-waived','success')
       RETURNING id::text AS id`,
      [affected.toString()],
    );
    await query(
      `INSERT INTO request_finalize_journal
         (request_id,user_id,state,ctx,precheck_credits,final_credits,usage_id)
       VALUES ('friction-model-waived',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$2)`,
      [affected.toString(), waivedUsage.rows[0]!.id],
    );
    const legacyNoOutput = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,input_tokens,output_tokens,price_snapshot,cost_credits,request_id,status)
       VALUES ($1,'chat','qwen3.7-max',5,0,'{}'::jsonb,0,'friction-model-legacy-empty','success')
       RETURNING id::text AS id`,
      [affected.toString()],
    );
    const codexCancelled = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,input_tokens,output_tokens,price_snapshot,cost_credits,request_id,status)
       VALUES ($1,'chat','qwen3.7-max',9,2,
               '{"codex_status":"error","codex_terminal_code":"USER_CANCELLED"}'::jsonb,
               3,'friction-codex-cancelled','success')
       RETURNING id::text AS id`,
      [affected.toString()],
    );
    await query(
      `INSERT INTO request_finalize_journal
         (request_id,user_id,state,ctx,precheck_credits,final_credits,usage_id)
       VALUES
         ('friction-model-legacy-empty',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,0,0,$2),
         ('friction-codex-cancelled',$1,'committed','{"model":"qwen3.7-max"}'::jsonb,3,3,$3)`,
      [affected.toString(), legacyNoOutput.rows[0]!.id, codexCancelled.rows[0]!.id],
    );
    const imageUsage = await query<{ id: string }>(
      `INSERT INTO image_generation_usage_records
         (user_id,request_id,operation,status,error_code,attempt_count,last_attempt_at)
       VALUES ($1,'image:friction','generation','failed','IMAGE_UPSTREAM_RATE_LIMITED',1,NOW())
       RETURNING id::text AS id`,
      [affected.toString()],
    );
    await query(
      `INSERT INTO image_generation_attempts
         (usage_id,user_id,attempt_no,outcome,error_code,completed_at)
       VALUES ($1,$2,1,'failed','IMAGE_UPSTREAM_RATE_LIMITED',NOW())`,
      [imageUsage.rows[0]!.id, affected.toString()],
    );
    await query(
      `INSERT INTO image_generation_usage_records
         (user_id,request_id,operation,status,error_code)
       VALUES ($1,'image:legacy-window','generation','failed','relay_failed')`,
      [affected.toString()],
    );
    await query(
      `INSERT INTO github_session_workspaces
         (user_id,session_id,owner,repo,branch,status,error_code)
       VALUES
         ($1,'missing-session','dx','openclaude','main','failed','workspace_timeout'),
         ($1,'active-commercial-session','dx','openclaude','main','failed','workspace_timeout')`,
      [affected.toString()],
    );
    const nowMs = Date.now();
    await query(
      `INSERT INTO client_sessions
         (id,user_id,agent_id,title,created_at,last_at,updated_at)
       VALUES ('active-commercial-session',$1,'main','active',$2,$2,$2)
       ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,deleted_at=NULL`,
      [`c:${affected.toString()}`, nowMs],
    );
    const response = await fetch(`${baseUrl}/api/admin/product-friction`, {
      headers: { Authorization: `Bearer ${await tokenFor(admin, "admin")}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      windows: { operational_days: number; funnel_days: number };
      events: Array<{ surface: string; code: string; attempts_7d: string; recovered_7d: string }>;
      models: Array<{ model: string; attempts_7d: string; success_7d: string; failures_7d: string; cancellations_7d: string }>;
      model_failures: Array<{ model: string; code: string; failures_7d: string }>;
      images: Array<{ status: string; code: string; records: string }>;
      image_attempts: Array<{ outcome: string; code: string; attempts_7d: string }>;
      orders: unknown[]; github: Array<{ status: string; code: string; missing_session: string }>; ratings: unknown[];
    };
    assert.deepEqual(body.windows, { operational_days: 7, funnel_days: 30 });
    assert.ok(Array.isArray(body.models) && Array.isArray(body.images) && Array.isArray(body.orders));
    assert.ok(Array.isArray(body.github) && Array.isArray(body.ratings));
    const event = body.events.find((row) => row.surface === "auth" && row.code === "REFRESH_RACE");
    assert.ok(event, `missing auth refresh journey: ${JSON.stringify(body.events)}`);
    assert.equal(event.attempts_7d, "2");
    assert.equal(event.recovered_7d, "1");
    assert.deepEqual(body.models.find((row) => row.model === "qwen3.7-max"), {
      model: "qwen3.7-max", attempts_1d: "3", success_1d: "0", failures_1d: "2", cancellations_1d: "1",
      attempts_7d: "3", success_7d: "0", failures_7d: "2", cancellations_7d: "1",
    });
    const noOutput = body.model_failures.find((row) => row.code === "NO_OUTPUT");
    assert.ok(noOutput, `missing NO_OUTPUT breakdown: ${JSON.stringify(body.model_failures)}`);
    assert.equal(noOutput.failures_7d, "2");
    assert.equal(body.model_failures.some((row) => row.code === "CODEX_ERROR"), false);
    assert.equal(body.images.find((row) => row.code === "IMAGE_UPSTREAM_RATE_LIMITED")?.records, "1");
    assert.equal(body.images.find((row) => row.code === "IMAGE_RELAY_FAILED")?.records, "1");
    assert.equal(body.images.some((row) => row.code === "relay_failed"), false);
    assert.equal(body.image_attempts.find((row) => row.code === "IMAGE_UPSTREAM_RATE_LIMITED")?.attempts_7d, "1");
    assert.equal(
      body.github.find((row) => row.code === "workspace_timeout")?.missing_session,
      "1",
      "canonical c:<uid> active session must not be reported as missing",
    );
  });

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
