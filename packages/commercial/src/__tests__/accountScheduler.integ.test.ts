/**
 * T-32 集成:AccountScheduler 在真 PG + InMemoryHealthRedis 上的行为。
 *
 * 覆盖:
 *   1. 无 active 账号 → AccountPoolUnavailableError
 *   2. 全部 cooldown → AccountPoolUnavailableError
 *   3. mode=agent sticky:同 sessionId 多次调用 → 同一账号 + 返真解密后的 token
 *   4. sticky 账号改 cooldown → 下一次 pick 返另一账号(迁移 + fallback)
 *   5. mode=chat weighted:注入固定 random 可重现地选某账号
 *   6. mode=agent 缺 sessionId → TypeError
 *   7. mode 非法 → TypeError
 *   8. pick 返 token 解密正确(还原成明文)
 *   9. release(success) → DB success_count++ + Redis health set
 *  10. release(failure) → DB fail_count++ + last_error 写入
 *  11. account 在 pick 和 readToken 之间被删 → AccountPoolUnavailableError
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import {
  createAccount,
  getAccount,
  updateAccount,
  deleteAccount,
} from "../account-pool/store.js";
import {
  AccountHealthTracker,
  InMemoryHealthRedis,
  healthKey,
} from "../account-pool/health.js";
import {
  AccountScheduler,
  AccountPoolUnavailableError,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
} from "../account-pool/scheduler.js";

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

function mkTracker(): { tracker: AccountHealthTracker; redis: InMemoryHealthRedis } {
  const redis = new InMemoryHealthRedis();
  return { tracker: new AccountHealthTracker({ redis }), redis };
}

function mkScheduler(
  tracker: AccountHealthTracker,
  overrides: { random?: () => number } = {},
): AccountScheduler {
  return new AccountScheduler({
    health: tracker,
    keyFn,
    random: overrides.random,
  });
}

describe("pick — 可用性", () => {
  test("无 active 账号 → AccountPoolUnavailableError(code=ERR_ACCOUNT_POOL_UNAVAILABLE)", async (t) => {
    if (skipIfNoDb(t)) return;
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    await assert.rejects(
      s.pick({ mode: "chat" }),
      (err: unknown) =>
        err instanceof AccountPoolUnavailableError &&
        (err as AccountPoolUnavailableError).code === ERR_ACCOUNT_POOL_UNAVAILABLE,
    );
  });

  test("全部 cooldown → AccountPoolUnavailableError", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "c1", plan: "pro", token: "T1" }, keyFn);
    const b = await createAccount({ label: "c2", plan: "pro", token: "T2" }, keyFn);
    await updateAccount(a.id, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 60_000),
    }, keyFn);
    await updateAccount(b.id, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 60_000),
    }, keyFn);
    const { tracker } = mkTracker();
    await assert.rejects(
      mkScheduler(tracker).pick({ mode: "chat" }),
      AccountPoolUnavailableError,
    );
  });

  test("disabled / banned 不计入可选", async (t) => {
    if (skipIfNoDb(t)) return;
    const active = await createAccount({ label: "active", plan: "pro", token: "T-ACTIVE" }, keyFn);
    const dis = await createAccount({ label: "dis", plan: "pro", token: "T-DIS" }, keyFn);
    const ban = await createAccount({ label: "ban", plan: "pro", token: "T-BAN" }, keyFn);
    await updateAccount(dis.id, { status: "disabled" }, keyFn);
    await updateAccount(ban.id, { status: "banned" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    const p = await s.pick({ mode: "chat" });
    assert.equal(p.account_id, active.id);
    p.token.fill(0);
  });
});

describe("pick — mode=agent sticky", () => {
  test("同 sessionId 多次返同一账号", async (t) => {
    if (skipIfNoDb(t)) return;
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ label: `a${i}`, plan: "pro", token: `T${i}` }, keyFn);
    }
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    const first = await s.pick({ mode: "agent", sessionId: "sess-A" });
    first.token.fill(0);
    for (let i = 0; i < 5; i += 1) {
      const p = await s.pick({ mode: "agent", sessionId: "sess-A" });
      assert.equal(p.account_id, first.account_id);
      p.token.fill(0);
    }
  });

  test("sticky 账号切 cooldown → 下次 pick fallback 到另一账号", async (t) => {
    if (skipIfNoDb(t)) return;
    for (let i = 0; i < 3; i += 1) {
      await createAccount({ label: `a${i}`, plan: "pro", token: `T${i}` }, keyFn);
    }
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    const sess = "sess-mig";
    const first = await s.pick({ mode: "agent", sessionId: sess });
    first.token.fill(0);
    await updateAccount(first.account_id, {
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 60_000),
    }, keyFn);
    const second = await s.pick({ mode: "agent", sessionId: sess });
    assert.notEqual(second.account_id, first.account_id);
    second.token.fill(0);
  });

  test("mode=agent 缺 sessionId → TypeError", async (t) => {
    if (skipIfNoDb(t)) return;
    await createAccount({ label: "a1", plan: "pro", token: "T" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    await assert.rejects(s.pick({ mode: "agent" }), TypeError);
    await assert.rejects(s.pick({ mode: "agent", sessionId: "" }), TypeError);
  });
});

describe("pick — mode=chat weighted", () => {
  test("注入固定 random → 落到确定性账号", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "w1", plan: "pro", token: "T-1" }, keyFn);
    const b = await createAccount({ label: "w2", plan: "pro", token: "T-2" }, keyFn);
    const c = await createAccount({ label: "w3", plan: "pro", token: "T-3" }, keyFn);
    const { tracker } = mkTracker();
    // 三个账号都 health=100 → 总权重 300;random=0 → 选 ORDER BY id ASC 首个
    const s0 = mkScheduler(tracker, { random: () => 0 });
    const p0 = await s0.pick({ mode: "chat" });
    assert.equal(p0.account_id, a.id);
    p0.token.fill(0);
    // random=0.999 → 选最后
    const s2 = mkScheduler(tracker, { random: () => 0.9999 });
    const p2 = await s2.pick({ mode: "chat" });
    assert.equal(p2.account_id, c.id);
    p2.token.fill(0);
    // 中间:random=0.5 → acc 走到 200(第二个),选 b
    const s1 = mkScheduler(tracker, { random: () => 0.5 });
    const p1 = await s1.pick({ mode: "chat" });
    assert.equal(p1.account_id, b.id);
    p1.token.fill(0);
  });

  test("mode 非法 → TypeError", async (t) => {
    if (skipIfNoDb(t)) return;
    await createAccount({ label: "a1", plan: "pro", token: "T" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    await assert.rejects(
      s.pick({ mode: "bogus" as unknown as "chat" }),
      TypeError,
    );
  });
});

describe("pick — token 解密正确", () => {
  test("返的 token Buffer 还原为明文", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "enc", plan: "max", token: "SECRET-ABC-xyz-999", refresh: "REF-XYZ" },
      keyFn,
    );
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker, { random: () => 0 });
    const p = await s.pick({ mode: "chat" });
    assert.equal(p.account_id, a.id);
    assert.equal(p.plan, "max");
    assert.equal(p.token.toString("utf8"), "SECRET-ABC-xyz-999");
    assert.equal(p.refresh?.toString("utf8"), "REF-XYZ");
    p.token.fill(0);
    p.refresh?.fill(0);
  });
});

describe("release", () => {
  test("success → health.onSuccess:success_count++ + Redis health set", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "r1", plan: "pro", token: "T" }, keyFn);
    const { tracker, redis } = mkTracker();
    const s = mkScheduler(tracker);
    await s.release({ account_id: a.id, result: { kind: "success" } });
    const row = await getAccount(a.id);
    assert.equal(row!.success_count, 1n);
    assert.equal(row!.last_error, null);
    assert.equal(await redis.get(healthKey(a.id)), "100");
  });

  test("failure → health.onFailure:fail_count++ + last_error", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "r2", plan: "pro", token: "T" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    await s.release({
      account_id: a.id,
      result: { kind: "failure", error: "rate-limited 429" },
    });
    const row = await getAccount(a.id);
    assert.equal(row!.fail_count, 1n);
    assert.equal(row!.last_error, "rate-limited 429");
    // health 从 100 → 80
    assert.equal(row!.health_score, 80);
  });

  test("failure 无 error msg → last_error 不被覆盖(COALESCE)", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount({ label: "r3", plan: "pro", token: "T" }, keyFn);
    await updateAccount(a.id, { last_error: "previous" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    await s.release({ account_id: a.id, result: { kind: "failure" } });
    const row = await getAccount(a.id);
    assert.equal(row!.last_error, "previous");
  });
});

describe("并发/边界", () => {
  test("pick 后立即删账号 → 再 pick 选其他 / 若仅一个 → 可用性错误", async (t) => {
    if (skipIfNoDb(t)) return;
    const only = await createAccount({ label: "solo", plan: "pro", token: "T" }, keyFn);
    const { tracker } = mkTracker();
    const s = mkScheduler(tracker);
    const p = await s.pick({ mode: "chat" });
    p.token.fill(0);
    await deleteAccount(only.id);
    await assert.rejects(s.pick({ mode: "chat" }), AccountPoolUnavailableError);
  });
});
