/**
 * AINV-6 — auth endpoints rate-limit wiring(整合测试,真 PG + 真 Redis)
 *
 * 现状:`rateLimit.integ.test.ts` 只测了 sliding-window primitive
 * (`checkRateLimit` / Lua atomic);三个 auth 端点(register / login / verify-email)
 * 的 handler 路由级 wiring 没被端到端验证 — 谁要是把 `enforceRateLimit(...)` 那行
 * 误删 / 顺序错位都不会被这套覆盖网捕获。Phase 1.A audit 把 AINV-6 标 ❌。
 *
 * 本测试装一台 ephemeral http.Server 跑真 `createCommercialHandler`,**注入低 cap**
 * (max=3, windowSeconds=60)的 rateLimits override 让 429 在第 4 次必然触发。
 * 用空 body `{}` 发请求 —— 因为 rate-limit 在 body 校验/业务逻辑之前 fire(见
 * handlers.ts:391/434/680),前 3 次返业务错(400/403/422 等)但桶 +1;第 4 次返 429。
 *
 * 锁的三点:
 *   1. status === 429
 *   2. header `Retry-After` 是 ≥ 1 的整数
 *   3. body `error.code === "RATE_LIMITED"`
 *
 * 每个端点用独立 scope 避免桶串扰。`/api/auth/register` 依赖
 * `allow_registration=true`；本文件在每个 case 前显式写入，避免生产默认关停
 * 让请求在 rate-limit 之前返回 403。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { warmupLoginDummyHash } from "../auth/login.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const JWT_SECRET = "z".repeat(64);

/** 全量 migration 创建 40+ 表,手工维护白名单成本高 + 容易遗漏新表(如
 *  admin_alert_channels)。DROP SCHEMA CASCADE 一次清干净,
 *  CREATE SCHEMA 后由 runMigrations() 全量重建。
 *  仅用于测试 DB,resetTestSchemaForTest 按实际 current_database() 阻挡 prod 误炸。 */
async function cleanCommercialSchema(): Promise<void> {
  await resetTestSchemaForTest();
  await query("GRANT ALL ON SCHEMA public TO public");
}

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

async function probePg(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
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
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
  });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    try { r.disconnect(); } catch { /* ignore */ }
    return null;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
    setPoolOverride(pool);
    await cleanCommercialSchema();
    await runMigrations();
    await warmupLoginDummyHash();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }

  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required");
  }

  if (pgAvailable && redis) {
    // 关键:cap=3 让第 4 次必然 429。每个 endpoint 独立 scope,避免共享桶。
    // verifyEmailEmail 也注入,否则 verifyEmail handler 在 IP 限流过了之后会
    // 走默认 verifyEmailEmail(10/30min),不影响 IP 维度断言,但拉低不必要的
    // 状态空间复杂度,统一拉到 cap=3 让"任何 auth 速率限流回归都被同一阈值捕获"。
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer,
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      refreshCookieSecure: false,
      rateLimits: {
        register: { scope: "register_ainv6", windowSeconds: 60, max: 3 },
        login: { scope: "login_ainv6", windowSeconds: 60, max: 3 },
        verifyEmail: { scope: "verify_email_ainv6", windowSeconds: 60, max: 3 },
        verifyEmailEmail: { scope: "verify_email_email_ainv6", windowSeconds: 60, max: 3 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("not handled by commercial");
      }
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* ignore */ }
    await redis.quit();
  }
  if (pgAvailable) {
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  await query("TRUNCATE TABLE refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  // users 的 TRUNCATE ... CASCADE 会连带清掉带 updated_by FK 的 system_settings；
  // 每个 case 都重新开启注册，确保请求能越过开关并真正命中 rate-limit wiring。
  await query(
    `INSERT INTO system_settings(key, value, updated_at)
     VALUES ('allow_registration', 'true'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
  );
  await redis.flushdb();
  mailer.sent.length = 0;
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip("pg/redis/server not available");
    return true;
  }
  return false;
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* empty */ }
  return { status: r.status, json, headers: r.headers };
}

/**
 * 通用断言:第 N+1 次请求返 429 + Retry-After + error.code RATE_LIMITED。
 * 注意桶用 ctx.clientIp 标识,fetch from 127.0.0.1 是稳定来源,4 次都同 IP 桶。
 */
function assertRateLimited(r: { status: number; json: Record<string, unknown>; headers: Headers }, label: string): void {
  assert.equal(r.status, 429, `${label}: 第 4 次必须 429,实际 ${r.status}`);
  const retryAfter = r.headers.get("retry-after");
  assert.ok(retryAfter, `${label}: 必须含 Retry-After header,实际缺失`);
  const retryAfterNum = Number(retryAfter);
  assert.ok(
    Number.isInteger(retryAfterNum) && retryAfterNum >= 1,
    `${label}: Retry-After 应是 ≥1 的整数,实际 "${retryAfter}"`,
  );
  const errorObj = r.json.error as Record<string, unknown> | undefined;
  assert.equal(
    errorObj?.code,
    "RATE_LIMITED",
    `${label}: error.code 必须 RATE_LIMITED,实际 ${JSON.stringify(errorObj)}`,
  );
}

describe("AINV-6 — auth endpoints rate-limit wired", () => {
  test("/api/auth/register: 第 4 次返 429 RATE_LIMITED + Retry-After", async (t) => {
    if (skipIfMissing(t)) return;
    // beforeEach 显式开启 allow_registration；前 3 次走业务
    // (空 body → register zod 拒,400/422 等)并让桶 +1。
    for (let i = 0; i < 3; i++) {
      const r = await postJson("/api/auth/register", {});
      assert.notEqual(r.status, 429, `第 ${i + 1} 次不该已经 429`);
    }
    // 第 4 次 → 429
    const r4 = await postJson("/api/auth/register", {});
    assertRateLimited(r4, "register");
  });

  test("/api/auth/login: 第 4 次返 429 RATE_LIMITED + Retry-After", async (t) => {
    if (skipIfMissing(t)) return;
    // login handler 第一行就是 enforceRateLimit,无前置门;空 body 直接进 rate-limit。
    for (let i = 0; i < 3; i++) {
      const r = await postJson("/api/auth/login", {});
      assert.notEqual(r.status, 429, `第 ${i + 1} 次不该已经 429`);
    }
    const r4 = await postJson("/api/auth/login", {});
    assertRateLimited(r4, "login");
  });

  test("/api/auth/verify-email: 第 4 次返 429 RATE_LIMITED + Retry-After", async (t) => {
    if (skipIfMissing(t)) return;
    // verifyEmail handler:IP rate-limit 在 body shape 校验之前(handlers.ts:680)。
    // 空 body 也能消耗 IP 桶。
    for (let i = 0; i < 3; i++) {
      const r = await postJson("/api/auth/verify-email", {});
      assert.notEqual(r.status, 429, `第 ${i + 1} 次不该已经 429`);
    }
    const r4 = await postJson("/api/auth/verify-email", {});
    assertRateLimited(r4, "verify-email");
  });

  test("三端点桶相互独立(同 IP 注册满 cap 不影响 login/verify-email)", async (t) => {
    if (skipIfMissing(t)) return;
    // 注册路径由 beforeEach 的 allow_registration=true 放行。
    // register 打满 4 次(第 4 次本身就 429)
    for (let i = 0; i < 3; i++) await postJson("/api/auth/register", {});
    const reg4 = await postJson("/api/auth/register", {});
    assertRateLimited(reg4, "register cross-scope");

    // 同一 IP 第一次 login → 不该 429(login 桶仍为 0)
    const login1 = await postJson("/api/auth/login", {});
    assert.notEqual(login1.status, 429, "login 桶应与 register 独立");
    // 同一 IP 第一次 verify-email → 不该 429
    const ve1 = await postJson("/api/auth/verify-email", {});
    assert.notEqual(ve1.status, 429, "verify-email 桶应与 register 独立");
  });
});
