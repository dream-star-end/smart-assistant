/**
 * T-22 集成:ledger(debit/credit/adminAdjust)在真 Postgres 上的行为。
 *
 * 覆盖:
 *   1. debit 正常:users.credits 减少,credit_ledger 新增一行 delta<0 / balance_after 正确
 *   2. debit 余额不足:抛 InsufficientCreditsError,users.credits 未变,ledger 无新增
 *   3. credit 正常:users.credits 增加,ledger 正向 delta
 *   4. 并发 debit:10 个并发,余额仅够 5 次 → 严格 5 成功 5 失败(FOR UPDATE 行锁验证)
 *   5. ledger 的 UPDATE/DELETE 被 RULE 拦住:执行成功但行实际未变
 *   6. adminAdjust 正向 & 负向:users.credits 变更,同时写 admin_audit
 *   7. adminAdjust 会把余额打成负值 → InsufficientCreditsError,事务回滚
 *   8. user 不存在 → TypeError
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  debit,
  credit,
  adminAdjust,
  getBalance,
  listLedger,
  InsufficientCreditsError,
} from "../billing/ledger.js";

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
  // 并发测试要 >=15 个连接(10 并发 + 主线程 + pool 余量)
  const pool = createPool({ connectionString: TEST_DB_URL, max: 20 });
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
  // 只 truncate 涉及 ledger/audit 的表,保留 model_pricing / topup_plans 种子
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

async function createUser(email: string, credits = 0n, role = "user"): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', $2, $3) RETURNING id::text AS id",
    [email, credits.toString(), role],
  );
  return BigInt(r.rows[0].id);
}

describe("ledger.debit (integ)", () => {
  test("happy path: users.credits 扣减 + ledger 新增一行", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("debit-ok@example.com", 1000n);
    const r = await debit(uid, 300n, "chat", { type: "usage_record", id: "42" }, "test memo");
    assert.equal(r.balance_after, 700n);
    assert.ok(r.ledger_id > 0n);

    assert.equal(await getBalance(uid), 700n);
    const rows = await listLedger(uid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delta, -300n);
    assert.equal(rows[0].balance_after, 700n);
    assert.equal(rows[0].reason, "chat");
    assert.equal(rows[0].ref_type, "usage_record");
    assert.equal(rows[0].ref_id, "42");
    assert.equal(rows[0].memo, "test memo");
  });

  test("余额不足:抛 InsufficientCreditsError,users.credits 未变,ledger 无新增", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("debit-short@example.com", 100n);
    await assert.rejects(
      () => debit(uid, 500n, "chat"),
      (err: unknown) =>
        err instanceof InsufficientCreditsError &&
        err.balance === 100n &&
        err.required === 500n &&
        err.shortfall === 400n,
    );
    assert.equal(await getBalance(uid), 100n, "credits must be untouched after failure");
    const rows = await listLedger(uid);
    assert.equal(rows.length, 0, "no ledger row on failure");
  });

  test("reason 'agent_chat' 正常写入并可读回", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("debit-agent@example.com", 1000n);
    await debit(uid, 50n, "agent_chat", { type: "agent", id: "sess-1" });
    const rows = await listLedger(uid);
    assert.equal(rows[0].reason, "agent_chat");
  });
});

describe("ledger.credit (integ)", () => {
  test("加积分 + ledger 正向 delta", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("credit-ok@example.com", 100n);
    const r = await credit(uid, 50n, "topup", { type: "order", id: "ord-1" });
    assert.equal(r.balance_after, 150n);
    assert.equal(await getBalance(uid), 150n);
    const rows = await listLedger(uid);
    assert.equal(rows[0].delta, 50n);
    assert.equal(rows[0].balance_after, 150n);
    assert.equal(rows[0].reason, "topup");
  });
});

describe("ledger 并发:FOR UPDATE 保证扣减原子性", () => {
  test("10 并发 debit,余额 500 每次 100 → 严格 5 成功 / 5 失败", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("concurrent@example.com", 500n);
    const promises = Array.from({ length: 10 }, () =>
      debit(uid, 100n, "chat").then(
        () => ({ ok: true }) as const,
        (err: unknown) =>
          err instanceof InsufficientCreditsError
            ? ({ ok: false, code: err.code }) as const
            : Promise.reject(err),
      ),
    );
    const results = await Promise.all(promises);
    const success = results.filter((r) => r.ok).length;
    const failure = results.filter((r) => !r.ok).length;
    assert.equal(success, 5, "must have exactly 5 successes");
    assert.equal(failure, 5, "must have exactly 5 failures");
    assert.equal(await getBalance(uid), 0n);
    const ledger = await listLedger(uid);
    assert.equal(ledger.length, 5);
    // 每行 balance_after 严格递减(400 → 300 → 200 → 100 → 0),且顺序确定
    const balances = ledger.map((r) => r.balance_after).slice().reverse();
    assert.deepEqual(balances, [400n, 300n, 200n, 100n, 0n]);
  });
});

describe("credit_ledger append-only RULE 仍生效(T-02 回归)", () => {
  test("UPDATE / DELETE 被拦,实际行不变", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("rule@example.com", 100n);
    await debit(uid, 10n, "chat");
    await query("UPDATE credit_ledger SET memo = 'hacked' WHERE user_id = $1", [uid.toString()]);
    await query("DELETE FROM credit_ledger WHERE user_id = $1", [uid.toString()]);
    const rows = await listLedger(uid);
    assert.equal(rows.length, 1, "DELETE must be no-op");
    assert.equal(rows[0].memo, null, "UPDATE must be no-op");
    assert.equal(rows[0].delta, -10n);
  });
});

describe("ledger.adminAdjust (integ)", () => {
  test("正向调整:余额 +,ledger + admin_audit 各出一行", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin@example.com", 0n, "admin");
    const uid = await createUser("adj-target@example.com", 100n);

    const r = await adminAdjust(uid, 50n, "bonus credits", adminId, { type: "promo", id: "p-1" }, "127.0.0.1", "test/1.0");
    assert.equal(r.balance_after, 150n);
    assert.ok(r.audit_id > 0n);

    assert.equal(await getBalance(uid), 150n);

    const ledger = await query<{ delta: string; reason: string; balance_after: string }>(
      "SELECT delta::text AS delta, reason, balance_after::text AS balance_after FROM credit_ledger WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].delta, "50");
    assert.equal(ledger.rows[0].reason, "admin_adjust");
    assert.equal(ledger.rows[0].balance_after, "150");

    const audit = await query<{
      action: string; target: string; before: { credits: string }; after: { credits: string; delta: string }; ip: string; user_agent: string;
    }>(
      // INET 默认带网段掩码,host() 只取地址部分
      "SELECT action, target, before, after, host(ip) AS ip, user_agent FROM admin_audit WHERE admin_id = $1",
      [adminId.toString()],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, "credits.adjust");
    assert.equal(audit.rows[0].target, `user:${uid}`);
    assert.equal(audit.rows[0].before.credits, "100");
    assert.equal(audit.rows[0].after.credits, "150");
    assert.equal(audit.rows[0].after.delta, "50");
    assert.equal(audit.rows[0].ip, "127.0.0.1");
    assert.equal(audit.rows[0].user_agent, "test/1.0");
  });

  test("负向调整合法(余额足够)", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin-neg@example.com", 0n, "admin");
    const uid = await createUser("adj-neg@example.com", 200n);
    const r = await adminAdjust(uid, -80n, "penalty", adminId);
    assert.equal(r.balance_after, 120n);
    assert.equal(await getBalance(uid), 120n);
    const ledger = await query<{ delta: string }>(
      "SELECT delta::text AS delta FROM credit_ledger WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(ledger.rows[0].delta, "-80");
  });

  test("负调整会让余额 < 0 → InsufficientCreditsError,整事务回滚(ledger 和 audit 都没写)", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin-over@example.com", 0n, "admin");
    const uid = await createUser("adj-over@example.com", 50n);
    await assert.rejects(
      () => adminAdjust(uid, -100n, "too much", adminId),
      (err: unknown) =>
        err instanceof InsufficientCreditsError &&
        err.balance === 50n &&
        err.required === 100n,
    );
    assert.equal(await getBalance(uid), 50n, "credits unchanged");
    const ledger = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id = $1",
      [uid.toString()],
    );
    assert.equal(ledger.rows[0].cnt, "0", "no ledger row on rollback");
    const audit = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM admin_audit WHERE admin_id = $1",
      [adminId.toString()],
    );
    assert.equal(audit.rows[0].cnt, "0", "no audit row on rollback");
  });
});

describe("ledger — user 不存在", () => {
  test("debit 不存在的 user → TypeError(事务回滚)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(() => debit(999999999n, 10n, "chat"), /user not found/);
  });

  test("adminAdjust 不存在的 user → TypeError", async (t) => {
    if (skipIfNoPg(t)) return;
    const adminId = await createUser("admin-notfound@example.com", 0n, "admin");
    await assert.rejects(() => adminAdjust(999999999n, 10n, "memo", adminId), /user not found/);
  });
});

describe("listLedger 分页", () => {
  test("limit 参数生效,按时间倒序", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("paging@example.com", 10_000n);
    for (let i = 0; i < 5; i++) {
      await debit(uid, 10n, "chat", { id: String(i) });
    }
    const top3 = await listLedger(uid, { limit: 3 });
    assert.equal(top3.length, 3);
    // 倒序:最新一条 ref_id='4' 在最前
    assert.equal(top3[0].ref_id, "4");
    assert.equal(top3[2].ref_id, "2");
  });
});
