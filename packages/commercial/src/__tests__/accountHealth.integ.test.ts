/**
 * T-31 集成:account-pool/health 在真 PG + InMemoryHealthRedis 上的行为。
 *
 * 覆盖:
 *   1. 新账号 health_score 初始 100 / status='active'
 *   2. onSuccess:success_count+=1 / health cap 100 / last_used_at 更新 /
 *      last_error 清空 / Redis 缓存 health_score
 *   3. onFailure 1 次:fail_count+=1 / health -20 / last_error 写入 / fail counter=1
 *   4. onFailure 3 次连续:在第 3 次触发 cooldown + cooldown_until≈now+10min +
 *      fail counter 被清空
 *   5. onFailure 已 cooldown 账号:计数继续但状态不变
 *   6. onFailure 2 次 + onSuccess → fail counter 清 → 再连续 3 次才熔断
 *   7. halfOpen:cooldown_until < NOW() 的账号 recover,其他账号不变 +
 *      Redis health 被设 50 + fail counter 清
 *   8. halfOpen 无符合 → 返 []
 *   9. halfOpen 幂等:第二次调用空集
 *  10. manualDisable:status='disabled' / 清 Redis 两个 key
 *  11. manualEnable:status='active' / health=100 / cooldown_until=null / Redis 缓存 100
 *  12. getHealthScore:miss 回 DB 并回填 / 命中 Redis 不触 DB
 *  13. 操作不存在 id 都返 null 且清 Redis
 *  14. onSuccess 后 health cap 不超过 100
 *  15. onFailure health 降到 0 后不继续减
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { createAccount, getAccount, updateAccount } from "../account-pool/store.js";
import {
  AccountHealthTracker,
  InMemoryHealthRedis,
  healthKey,
  failKey,
} from "../account-pool/health.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "user_preferences", "request_finalize_journal",
  "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

let pgAvailable = false;
const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY);

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function freshAccount(): Promise<bigint> {
  const a = await createAccount({ label: "h-test", plan: "pro", token: "T" }, keyFn);
  return a.id;
}

describe("onSuccess", () => {
  test("清连续失败计数 + success_count++ + health cap 100 + Redis 缓存", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    // 预先放 2 次失败计数
    await redis.set(failKey(id), "2");
    const tracker = new AccountHealthTracker({ redis });
    const before = await getAccount(id);
    const h = await tracker.onSuccess(id);
    assert.ok(h);
    assert.equal(h.health_score, 100); // 原 100 + 10 = 110, cap 100
    // DB 验证
    const after = await getAccount(id);
    assert.ok(after);
    assert.equal(after.success_count, (before!.success_count) + 1n);
    assert.equal(after.health_score, 100);
    assert.ok(after.last_used_at); // 被设了
    assert.equal(after.last_error, null);
    // Redis 验证
    assert.equal(await redis.get(healthKey(id)), "100");
    assert.equal(await redis.get(failKey(id)), null);
  });
});

describe("onFailure", () => {
  test("1 次失败:fail_count+=1 / health -20 / last_error 写入 / Redis fail=1", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    const h = await tracker.onFailure(id, "timeout");
    assert.ok(h);
    assert.equal(h.health_score, 80);
    assert.equal(h.status, "active");
    const after = await getAccount(id);
    assert.equal(after!.fail_count, 1n);
    assert.equal(after!.last_error, "timeout");
    assert.equal(await redis.get(failKey(id)), "1");
    assert.equal(await redis.get(healthKey(id)), "80");
  });

  test("连续 3 次失败:第 3 次触发 cooldown + cooldown_until≈now+10min + fail counter 清", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    const frozen = new Date("2026-04-17T12:00:00.000Z");
    const tracker = new AccountHealthTracker({
      redis,
      now: () => frozen,
    });
    await tracker.onFailure(id, "e1");
    let a = await getAccount(id);
    assert.equal(a!.status, "active");
    await tracker.onFailure(id, "e2");
    a = await getAccount(id);
    assert.equal(a!.status, "active");
    const h3 = await tracker.onFailure(id, "e3");
    assert.equal(h3!.status, "cooldown");
    a = await getAccount(id);
    assert.equal(a!.status, "cooldown");
    assert.ok(a!.cooldown_until);
    // ≈ frozen + 10min
    const diff = a!.cooldown_until!.getTime() - frozen.getTime();
    assert.equal(diff, 10 * 60 * 1000);
    // Redis fail counter 清空
    assert.equal(await redis.get(failKey(id)), null);
    // health 从 100 -> 80 -> 60 -> 40
    assert.equal(a!.health_score, 40);
  });

  test("2 次失败后 onSuccess 会清计数 → 再 3 次才熔断", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    await tracker.onFailure(id, "e1");
    await tracker.onFailure(id, "e2");
    assert.equal(await redis.get(failKey(id)), "2");
    await tracker.onSuccess(id);
    assert.equal(await redis.get(failKey(id)), null);
    // 现在再 2 次失败应不熔断
    await tracker.onFailure(id, "e3");
    const a1 = await getAccount(id);
    assert.equal(a1!.status, "active");
    await tracker.onFailure(id, "e4");
    const a2 = await getAccount(id);
    assert.equal(a2!.status, "active");
    // 第 3 次才熔断
    await tracker.onFailure(id, "e5");
    const a3 = await getAccount(id);
    assert.equal(a3!.status, "cooldown");
  });

  test("已 cooldown 账号:onFailure 继续记计数但状态保持 cooldown", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    await updateAccount(id, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 60_000),
    }, keyFn);
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    for (let i = 0; i < 5; i++) {
      await tracker.onFailure(id, `e${i}`);
    }
    const a = await getAccount(id);
    assert.equal(a!.status, "cooldown");
    assert.equal(a!.fail_count, 5n);
  });

  test("health 降到 0 后继续失败不变为负", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    await updateAccount(id, { health_score: 10 }, keyFn);
    const redis = new InMemoryHealthRedis();
    // 把阈值调到很大,单测 floor 逻辑
    const tracker = new AccountHealthTracker({ redis, failThreshold: 999 });
    await tracker.onFailure(id, "a"); // 10 - 20 = -10 → floor 0
    const a = await getAccount(id);
    assert.equal(a!.health_score, 0);
    await tracker.onFailure(id, "b"); // 0 - 20 = -20 → floor 0
    const a2 = await getAccount(id);
    assert.equal(a2!.health_score, 0);
  });

  test("onSuccess 后 health 不超过 100", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount(); // 初始 100
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    await tracker.onSuccess(id);
    const a = await getAccount(id);
    assert.equal(a!.health_score, 100);
  });
});

describe("halfOpen", () => {
  test("把 cooldown_until < NOW() 的账号恢复 active + health=50,其他不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const idReady = await freshAccount();
    const idFuture = await freshAccount();
    const idStillActive = await freshAccount();
    // Ready 到期
    await updateAccount(idReady, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() - 60_000),
      health_score: 40,
    }, keyFn);
    // Future 未到期
    await updateAccount(idFuture, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 60_000),
      health_score: 40,
    }, keyFn);
    // StillActive 保持 active
    const redis = new InMemoryHealthRedis();
    // 预写脏 fail counter
    await redis.set(failKey(idReady), "5");
    const tracker = new AccountHealthTracker({ redis });
    const recovered = await tracker.halfOpen();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, idReady);
    assert.equal(recovered[0].status, "active");
    assert.equal(recovered[0].health_score, 50);
    // DB
    assert.equal((await getAccount(idReady))!.status, "active");
    assert.equal((await getAccount(idReady))!.health_score, 50);
    assert.equal((await getAccount(idReady))!.cooldown_until, null);
    assert.equal((await getAccount(idFuture))!.status, "cooldown");
    assert.equal((await getAccount(idStillActive))!.status, "active");
    // Redis
    assert.equal(await redis.get(healthKey(idReady)), "50");
    assert.equal(await redis.get(failKey(idReady)), null);
  });

  test("无可恢复账号 → 返空数组", async (t) => {
    if (skipIfNoDb(t)) return;
    const tracker = new AccountHealthTracker({ redis: new InMemoryHealthRedis() });
    assert.deepEqual(await tracker.halfOpen(), []);
  });

  test("幂等:再调一次依然空", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    await updateAccount(id, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() - 1000),
    }, keyFn);
    const tracker = new AccountHealthTracker({ redis: new InMemoryHealthRedis() });
    const r1 = await tracker.halfOpen();
    assert.equal(r1.length, 1);
    const r2 = await tracker.halfOpen();
    assert.equal(r2.length, 0);
  });
});

describe("manualDisable / manualEnable", () => {
  test("manualDisable:status='disabled' + 清 Redis", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    await redis.set(healthKey(id), "80");
    await redis.set(failKey(id), "2");
    const tracker = new AccountHealthTracker({ redis });
    const h = await tracker.manualDisable(id, "banned by admin");
    assert.ok(h);
    assert.equal(h.status, "disabled");
    const a = await getAccount(id);
    assert.equal(a!.status, "disabled");
    assert.equal(a!.last_error, "banned by admin");
    // 两个 Redis key 都清空
    assert.equal(await redis.get(healthKey(id)), null);
    assert.equal(await redis.get(failKey(id)), null);
  });

  test("manualEnable:status='active' + health=100 + cooldown_until=null + Redis 缓存 100", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    await updateAccount(id, {
      status: "cooldown",
      health_score: 20,
      cooldown_until: new Date(Date.now() + 60_000),
      last_error: "before",
    }, keyFn);
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    const h = await tracker.manualEnable(id);
    assert.ok(h);
    assert.equal(h.status, "active");
    assert.equal(h.health_score, 100);
    const a = await getAccount(id);
    assert.equal(a!.status, "active");
    assert.equal(a!.health_score, 100);
    assert.equal(a!.cooldown_until, null);
    assert.equal(a!.last_error, null);
    assert.equal(await redis.get(healthKey(id)), "100");
  });
});

describe("getHealthScore", () => {
  test("miss → 回 DB + 回填 Redis;二次调用命中 Redis(回填值)", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount(); // 100
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    assert.equal(await redis.get(healthKey(id)), null);
    const s1 = await tracker.getHealthScore(id);
    assert.equal(s1, 100);
    assert.equal(await redis.get(healthKey(id)), "100");
    // 手动在 Redis 写 77,二次读应拿 Redis 的(即使 DB 还是 100)
    await redis.set(healthKey(id), "77");
    const s2 = await tracker.getHealthScore(id);
    assert.equal(s2, 77);
  });

  test("Redis 里脏值非数字 → 回 DB", async (t) => {
    if (skipIfNoDb(t)) return;
    const id = await freshAccount();
    const redis = new InMemoryHealthRedis();
    await redis.set(healthKey(id), "corrupt");
    const tracker = new AccountHealthTracker({ redis });
    const s = await tracker.getHealthScore(id);
    assert.equal(s, 100);
  });
});

describe("不存在的账号", () => {
  test("onSuccess/onFailure/manualDisable/manualEnable 返 null 且清 Redis 缓存", async (t) => {
    if (skipIfNoDb(t)) return;
    const ghost = 999_999n;
    const redis = new InMemoryHealthRedis();
    await redis.set(healthKey(ghost), "stale");
    await redis.set(failKey(ghost), "stale");
    const tracker = new AccountHealthTracker({ redis });
    assert.equal(await tracker.onSuccess(ghost), null);
    assert.equal(await redis.get(healthKey(ghost)), null);
    await redis.set(healthKey(ghost), "stale"); // 重置一次验证 onFailure 也清
    await redis.set(failKey(ghost), "stale");
    assert.equal(await tracker.onFailure(ghost), null);
    assert.equal(await redis.get(healthKey(ghost)), null);
    assert.equal(await redis.get(failKey(ghost)), null);
    assert.equal(await tracker.manualDisable(ghost), null);
    assert.equal(await tracker.manualEnable(ghost), null);
    assert.equal(await tracker.getHealthScore(ghost), null);
  });
});
