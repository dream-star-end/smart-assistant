/**
 * 集成:preCheckWithCost 的 cap-to-balance 行为(drain-to-zero)。
 *
 * 2026-05-06 移除 ceiling 后:balance > 0 即放行,reservation 始终 cap 到 balance。
 *
 * 覆盖:
 *   1. balance ≤ 0 → InsufficientCreditsError(hard reject,不调 atomicReserve)
 *   2. balance > 0, maxCost > balance(任意大)→ 放行,reservation = balance,capped=true
 *   3. balance > 0, maxCost ≤ balance → 正常路径,reservation = maxCost,capped=false
 *   4. 同一 uid 并发:第一笔 capped=true 占满 balance,第二笔被 Lua 拒
 *   5. boss 实测场景:balance=200 + maxCost=300 → 放行 cap 到 200(回归基线)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import {
  preCheckWithCost,
  releasePreCheck,
  InMemoryPreCheckRedis,
  InsufficientCreditsError,
} from "../billing/preCheck.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

async function cleanCommercialSchema(): Promise<void> {
  await resetTestSchemaForTest();
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
          "See packages/commercial/README.md for bootstrap.",
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

  test("maxCost > balance → 放行,reservation cap 到 balance", async (t) => {
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

  test("maxCost 远大于 balance(任意大)→ 放行,cap 到 balance(2026-05-06 移除 ceiling 后回归)", async (t) => {
    if (skipIfNoPg(t)) return;
    // 事故修复回归:¥12 余额 + 文件附件估算飙到 ¥17+ 的场景。原 ceiling=¥5 时被拒,
    // 现在余额 > 0 即放行,reservation cap 到 balance,真扣由 finalize clamp 兜底。
    const uid = await createUser("huge-estimate@example.com", 1213n);
    const redis = new InMemoryPreCheckRedis();
    const r = await preCheckWithCost(redis, {
      userId: uid,
      requestId: "req-1",
      maxCost: 100_000n, // ≈ ¥1000,远超 balance + 任何 ceiling
    });
    assert.equal(r.balance, 1213n);
    assert.equal(r.maxCost, 1213n, "reservation capped to balance");
    assert.equal(r.capped, true);
    assert.equal(r.originalMaxCost, 100_000n);
    assert.equal(redis.totalLocked(uid), 1213n);
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
    // 200 cents 是 v1.0.3 上线时的注册赠送基线,v1.0.4 已升到 300 cents。
    // 数字固定不动 — 这个用例验的是 cap 算法,不是注册赠送数额。
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
