/**
 * v1.0.3 集成:preCheckWithCost 的 cap-to-balance 行为(drain-to-zero)。
 *
 * 覆盖:
 *   1. balance ≤ 0 → InsufficientCreditsError(hard reject,不调 atomicReserve)
 *   2. balance > 0, maxCost > balance + ceiling → 拒(单笔超扣面 bound)
 *   3. balance > 0, maxCost ∈ (balance, balance+ceiling] → 放行,reservation = balance,capped=true
 *   4. balance > 0, maxCost ≤ balance → 正常路径,reservation = maxCost,capped=false
 *   5. 同一 uid 并发:第一笔 capped=true 占满 balance,第二笔被 Lua 拒
 *   6. boss 实测场景:balance=200 (¥2 注册赠送), maxCost=300 (opus 4.7 60K 估算) → 放行
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  preCheckWithCost,
  releasePreCheck,
  InMemoryPreCheckRedis,
  InsufficientCreditsError,
  PRECHECK_OVERAGE_CEILING_CENTS,
} from "../billing/preCheck.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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

async function cleanCommercialSchema(): Promise<void> {
  const sql = `DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`;
  await query(sql);
}

async function probe(): Promise<boolean> {
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

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "Start it: docker compose -f tests/fixtures/docker-compose.test.yml up -d",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function createUser(email: string, credits = 0n): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', $2, 'user') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  return BigInt(r.rows[0].id);
}

describe("preCheckWithCost cap-to-balance (v1.0.3)", () => {
  test("balance=0 → 拒,InMemory 没记录 lock", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("zero-balance@example.com", 0n);
    const redis = new InMemoryPreCheckRedis();
    await assert.rejects(
      () => preCheckWithCost(redis, { userId: uid, requestId: "req-1", maxCost: 50n }),
      (err: unknown) =>
        err instanceof InsufficientCreditsError &&
        err.balance === 0n &&
        err.required === 50n,
    );
    assert.equal(redis.totalLocked(uid), 0n, "no lock recorded on hard reject");
  });

  test("balance < 0(管理员调过头)→ 拒", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("neg-balance@example.com", 0n);
    // 直接 UPDATE users 模拟极端 — adminAdjust 拒负数,这里手动绕过
    await query("UPDATE users SET credits = -1 WHERE id = $1", [uid.toString()]);
    const redis = new InMemoryPreCheckRedis();
    await assert.rejects(
      () => preCheckWithCost(redis, { userId: uid, requestId: "req-1", maxCost: 100n }),
      (err: unknown) => err instanceof InsufficientCreditsError,
    );
  });

  test("maxCost > balance + ceiling → 拒(超 ceiling)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("over-ceiling@example.com", 100n);
    const redis = new InMemoryPreCheckRedis();
    // 100 + 500 = 600,1000 > 600 → 拒
    await assert.rejects(
      () => preCheckWithCost(redis, { userId: uid, requestId: "req-1", maxCost: 1000n }),
      (err: unknown) =>
        err instanceof InsufficientCreditsError &&
        err.balance === 100n &&
        err.required === 1000n,
    );
    assert.equal(redis.totalLocked(uid), 0n);
  });

  test("maxCost > balance 但 ≤ balance + ceiling → 放行,cap 到 balance", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("cap-ok@example.com", 200n);
    const redis = new InMemoryPreCheckRedis();
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 300n,
    });
    assert.equal(r.balance, 200n);
    assert.equal(r.maxCost, 200n, "reservation capped to balance");
    assert.equal(r.capped, true);
    assert.equal(r.originalMaxCost, 300n);
    assert.equal(redis.totalLocked(uid), 200n);
  });

  test("maxCost = balance + ceiling 边界 → 放行(`>` 判定)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("ceiling-edge@example.com", 100n);
    const redis = new InMemoryPreCheckRedis();
    // 边界:maxCost = balance + ceiling = 100 + 500 = 600
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 100n + PRECHECK_OVERAGE_CEILING_CENTS,
    });
    assert.equal(r.maxCost, 100n);
    assert.equal(r.capped, true);
  });

  test("maxCost ≤ balance → 正常路径,reservation = maxCost,capped=false", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("normal@example.com", 1000n);
    const redis = new InMemoryPreCheckRedis();
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 300n,
    });
    assert.equal(r.maxCost, 300n);
    assert.equal(r.capped, false);
    assert.equal(r.originalMaxCost, 300n);
    assert.equal(redis.totalLocked(uid), 300n);
  });

  test("同 uid 并发:第一笔 cap 占满 balance,第二笔被 Lua 拒", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("concurrent-cap@example.com", 200n);
    const redis = new InMemoryPreCheckRedis();
    // 第一笔:cap 到 200
    const r1 = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 300n,
    });
    assert.equal(r1.maxCost, 200n);
    // 第二笔:Lua 看到 total=200,balance=200,任何 needed > 0 都过不了
    await assert.rejects(
      () => preCheckWithCost(redis, { userId: uid, requestId: "req-2", maxCost: 100n }),
      (err: unknown) => err instanceof InsufficientCreditsError,
    );
    assert.equal(redis.totalLocked(uid), 200n, "only first reservation held");
  });

  test("boss 实测场景:¥2 余额发送 opus 4.7 默认 60K max_tokens 请求 → 放行", async (t) => {
    if (skipIfNoPg(t)) return;
    // 注册赠送 ¥2 = 200 cents
    const uid = await createUser("boss-scenario@example.com", 200n);
    const redis = new InMemoryPreCheckRedis();
    // (~30 input + 60_000 output) * 2500 (output price) * 2.0 (multiplier) / 10^9 ≈ 300 cents
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-boss",
      maxCost: 300n,
    });
    assert.equal(r.capped, true, "余额不足全额预扣 → cap");
    assert.equal(r.maxCost, 200n, "reservation = balance,后续 finalize 按真实 cost 扣");
    // 真实 "你好" output ~50 tokens,真实 cost ≈ 0.4 cents,完全在 balance 内
    // (这部分由 finalize / settleUsageAndLedger 验证,这里不重复)
  });

  test("releasePreCheck 释放后,余额可重新预扣", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("release-cycle@example.com", 200n);
    const redis = new InMemoryPreCheckRedis();
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 300n,
    });
    assert.equal(redis.totalLocked(uid), 200n);
    const released = await releasePreCheck(redis, r.reservation);
    assert.equal(released, true);
    assert.equal(redis.totalLocked(uid), 0n);
    // 释放后可以再发一笔
    const r2 = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-2",
      maxCost: 50n,
    });
    assert.equal(r2.capped, false);
    assert.equal(r2.maxCost, 50n);
  });
});
