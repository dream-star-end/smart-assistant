import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  checkRateLimit,
  recordRateLimitEvent,
  wrapIoredis,
} from "../middleware/rateLimit.js";

/**
 * T-15 集成:真 Redis + 真 PG 验证
 *  - 6 次连续请求(配 5/min)第 6 次被拒
 *  - recordRateLimitEvent 写入 rate_limit_events 表
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;
let redis: IORedis | null = null;

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
    await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
    await runMigrations();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }
  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required");
  }
});

after(async () => {
  if (redis) {
    try { await redis.flushdb(); } catch { /* ignore */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (redis) await redis.flushdb();
  if (pgAvailable) await query("TRUNCATE TABLE rate_limit_events RESTART IDENTITY");
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis) {
    t.skip("pg or redis not available");
    return true;
  }
  return false;
}

describe("rateLimit (integ, real Redis + PG)", () => {
  test("first 5 calls allowed; 6th call denied (5/min config)", async (t) => {
    if (skipIfMissing(t)) return;
    const wrapped = wrapIoredis(redis!);
    const cfg = {
      scope: "login",
      windowSeconds: 60,
      max: 5,
      keyPrefix: "octest:rl",
    };

    for (let i = 1; i <= 5; i++) {
      const d = await checkRateLimit(wrapped, cfg, "10.0.0.1");
      assert.equal(d.allowed, true, `call ${i} should be allowed (count=${d.count})`);
    }
    const blocked = await checkRateLimit(wrapped, cfg, "10.0.0.1");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.count, 6);
    assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  });

  test("recordRateLimitEvent writes a row to rate_limit_events", async (t) => {
    if (skipIfMissing(t)) return;
    await recordRateLimitEvent("login", "10.0.0.2", true);
    const r = await query<{ scope: string; key: string; blocked: boolean }>(
      "SELECT scope, key, blocked FROM rate_limit_events ORDER BY id DESC LIMIT 1",
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].scope, "login");
    assert.equal(r.rows[0].key, "10.0.0.2");
    assert.equal(r.rows[0].blocked, true);
  });

  test("redis key TTL is set to windowSeconds (verified via TTL command)", async (t) => {
    if (skipIfMissing(t)) return;
    const wrapped = wrapIoredis(redis!);
    const cfg = { scope: "test_ttl", windowSeconds: 30, max: 100, keyPrefix: "octest:rl" };
    const d = await checkRateLimit(wrapped, cfg, "ttl-check");
    const ttl = await redis!.ttl(d.key);
    assert.ok(ttl > 0 && ttl <= 30, `expected TTL in (0,30], got ${ttl}`);
  });

  test("two different identifiers do not share counter (real redis)", async (t) => {
    if (skipIfMissing(t)) return;
    const wrapped = wrapIoredis(redis!);
    const cfg = { scope: "login", windowSeconds: 60, max: 2, keyPrefix: "octest:rl" };
    await checkRateLimit(wrapped, cfg, "ip-A");
    await checkRateLimit(wrapped, cfg, "ip-A");
    const aBlocked = await checkRateLimit(wrapped, cfg, "ip-A");
    assert.equal(aBlocked.allowed, false);

    const b = await checkRateLimit(wrapped, cfg, "ip-B");
    assert.equal(b.allowed, true, "ip-B should not be affected by ip-A's counter");
  });
});
