/**
 * settleUsageAndLedger 真 PG 集成测试。
 *
 * `settleUsageAndLedger`(`billing/proxyBilling.ts`)是计费链路的最后落库点:
 *   一个 PG 事务 = INSERT usage_records →(status='success' && cost>0)→
 *   SELECT FOR UPDATE users → INSERT credit_ledger → UPDATE usage_records.ledger_id。
 *
 * `codexFinalizer.test.ts` 用 fakePool 验调用栈;`ledger.integ.test.ts` 只测
 * debit/credit/adminAdjust 原语。本套件锁的是真 PG 行为:UNIQUE 约束、FOR UPDATE
 * 行锁、外键、JSONB 字段、事务回滚等"上层 mock 无法覆盖"的不变量。
 *
 * 覆盖:
 *   1. 正常 settle(success + cost>0)→ 3 表原子写入,debitedCredits/balanceAfter 正确
 *   2. 23505 幂等(同 user_id+request_id 二次进入)→ 返回已有行,debitedCredits/balanceAfter=null
 *   3. clamp(余额 < cost)→ debit 夹到 balance,status 仍 success,ledger memo 含 'clamped'
 *   4. DeepSeek path(accountId=null)→ usage_records.account_id IS NULL,其余正常 debit
 *   5. status='billing_failed' → 只写 usage_records,不写 ledger,users.credits 未变
 *   6. status='error' → 同上不走 ledger
 *   7. cost=0 + success → 写 usage_records 但不写 ledger
 *
 * 不覆盖(归 codexFinalizer.test fakePool / ledger.integ):
 *   - finalize 上层调用栈、release scheduler/redis 交互
 *   - ledger 原语本身的并发 / RULE / adminAdjust
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  loadUsageAttributionCredits,
  settleUsageAndLedger,
} from "../billing/proxyBilling.js";
import type { TokenUsage } from "../billing/calculator.js";
import { getPool } from "../db/index.js";
import { generatePersona } from "../account-pool/persona.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

/** 防线:DROP SCHEMA 一旦误指 staging/prod 杀伤面极大。强制要求 dbname 以 `_test`
 *  结尾,unmet 直接 throw,不去碰 schema。 */
function assertTestDatabase(url: string): void {
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error(`invalid TEST_DATABASE_URL: ${url}`);
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `refusing to reset non-test database: ${dbName} (must end with _test)`,
    );
  }
}

/** 重置 public schema —— 全量 migration 创建 40+ 表(含 system_settings、oauth_identities
 *  等多次新增),手工维护白名单成本高。DROP SCHEMA CASCADE 一次清干净,
 *  CREATE SCHEMA 后由 runMigrations() 全量重建。
 *  仅用于测试 DB,assertTestDatabase 阻挡 prod 误炸。 */
async function cleanCommercialSchema(): Promise<void> {
  assertTestDatabase(TEST_DB_URL);
  await query("DROP SCHEMA IF EXISTS public CASCADE");
  await query("CREATE SCHEMA public");
  await query("GRANT ALL ON SCHEMA public TO public");
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
    try { await cleanCommercialSchema(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // claude_accounts 加入 TRUNCATE — usage_records.account_id FK → claude_accounts(id)
  // (0004 + 0044),fixture 每个 test 重建 account,避免 id 跨 test 漂移。
  // egress_proxies 一并 TRUNCATE — 0055 CHECK 强制 claude_accounts.egress_proxy_id
  // NOT NULL,FK 指向 egress_proxies(id),所以 fixture 必须一起重建。
  await query(
    "TRUNCATE TABLE pending_usage_patches, admin_audit, usage_records, credit_ledger, claude_accounts, egress_proxies, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
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

/** 创建一个最小可用的 egress_proxies 行,返回 id。
 *  0052 定义:label TEXT UNIQUE NOT NULL, url_enc/url_nonce BYTEA NOT NULL,
 *  status 默认 'active'。本测试不发真实流量,塞 stub 字节即可。 */
async function createEgressProxy(label: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce)
     VALUES ($1, '\\x00'::bytea, '\\x00'::bytea)
     RETURNING id::text AS id`,
    [label],
  );
  return BigInt(r.rows[0].id);
}

/** 创建一个最小可用的 claude_accounts 行,返回 id。
 *  usage_records.account_id FK → claude_accounts(id),Claude 路径 case 必须用真 id。
 *  oauth_token_enc / oauth_nonce 是 BYTEA NOT NULL,塞 stub 字节即可,不参与本测试。
 *  0055 加了 CHECK (egress_proxy IS NULL AND egress_proxy_id IS NOT NULL),
 *  所以必须先建 egress_proxies 行再把 id 灌进 egress_proxy_id。
 *  0074 把 persona 锁 NOT NULL + shape CHECK,所以 raw INSERT 必须塞合法 persona。 */
async function createClaudeAccount(label: string): Promise<bigint> {
  const epId = await createEgressProxy(`${label}-ep`);
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, oauth_token_enc, oauth_nonce, egress_proxy_id, persona)
     VALUES ($1, 'pro', '\\x00'::bytea, '\\x00'::bytea, $2, $3::jsonb)
     RETURNING id::text AS id`,
    [label, epId.toString(), JSON.stringify(generatePersona())],
  );
  return BigInt(r.rows[0].id);
}

function makeUsage(input = 1000, output = 500): TokenUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
}

const SNAPSHOT_JSON = JSON.stringify({
  model_id: "test-model",
  display_name: "Test",
  input_per_mtok: "1000",
  output_per_mtok: "5000",
  cache_read_per_mtok: "0",
  cache_write_per_mtok: "0",
  multiplier: "1.000",
  captured_at: new Date(0).toISOString(),
});

describe("settleUsageAndLedger (integ)", () => {
  test("happy path: status=success + cost>0 → 3 表原子写入", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("happy@example.com", 1000n);
    const acctId = await createClaudeAccount("happy-acct");

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-happy-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 300n,
      status: "success",
      sessionId: "sess-1",
    });

    assert.equal(result.debitedCredits, 300n);
    assert.equal(result.balanceAfter, 700n);
    assert.equal(result.clamped, false);
    assert.ok(result.ledgerId !== null && result.ledgerId > 0n);
    assert.ok(result.usageId > 0n);

    // users.credits 减少
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "700");

    // credit_ledger 一行
    const led = await query<{
      delta: string;
      balance_after: string;
      reason: string;
      ref_type: string;
      ref_id: string;
      memo: string | null;
    }>(
      "SELECT delta::text AS delta, balance_after::text AS balance_after, reason, ref_type, ref_id::text AS ref_id, memo FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rowCount, 1);
    assert.equal(led.rows[0].delta, "-300");
    assert.equal(led.rows[0].balance_after, "700");
    assert.equal(led.rows[0].reason, "chat");
    assert.equal(led.rows[0].ref_type, "usage_record");
    assert.equal(led.rows[0].ref_id, result.usageId.toString());
    assert.equal(led.rows[0].memo, null); // 非 clamp → memo NULL

    // usage_records ledger_id 反写
    const ur = await query<{
      ledger_id: string | null;
      status: string;
      account_id: string | null;
      session_id: string | null;
      cost_credits: string;
    }>(
      "SELECT ledger_id::text AS ledger_id, status, account_id::text AS account_id, session_id, cost_credits::text AS cost_credits FROM usage_records WHERE id=$1",
      [result.usageId.toString()],
    );
    assert.equal(ur.rows[0].ledger_id, result.ledgerId!.toString());
    assert.equal(ur.rows[0].status, "success");
    assert.equal(ur.rows[0].account_id, acctId.toString());
    assert.equal(ur.rows[0].session_id, "sess-1");
    assert.equal(ur.rows[0].cost_credits, "300");
  });

  test("lossless locator is committed atomically with the real ledger debit", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("lossless-cost@example.com", 1000n);
    const turnKey = "a".repeat(64);
    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: null,
      requestId: "req-lossless-cost-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 300n,
      status: "success",
      sessionId: "ccb-lossless-1",
      turnKey,
    });
    assert.equal(result.debitedCredits, 300n);
    const pending = await query<{
      user_id: string;
      session_id: string | null;
      turn_key: string | null;
      cost_credits: string;
    }>(
      `SELECT user_id,session_id,turn_key,cost_credits
         FROM pending_usage_patches WHERE request_id=$1`,
      ["req-lossless-cost-1"],
    );
    assert.deepEqual(pending.rows, [{
      user_id: `c:${uid.toString()}`,
      session_id: "ccb-lossless-1",
      turn_key: turnKey,
      cost_credits: "300",
    }]);

    // Simulate process loss after COMMIT but before appendCostCredits folds the
    // pending locator. The idempotent retry must recover the exact attribution
    // amount so its caller can fold and broadcast without another debit.
    const replay = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: null,
      requestId: "req-lossless-cost-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 300n,
      status: "success",
      sessionId: "ccb-lossless-1",
      turnKey,
    });
    assert.equal(replay.debitedCredits, null);
    assert.equal(replay.attributionCredits, 300n);
    assert.equal(
      await loadUsageAttributionCredits(getPool(), uid, "req-lossless-cost-1"),
      300n,
    );
    const ledgerCount = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(ledgerCount.rows[0].count, "1");
  });

  test("zero-debit usage commits a zero locator atomically for GoalState attribution", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("lossless-zero@example.com", 1000n);
    const turnKey = "c".repeat(64);
    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: null,
      requestId: "req-lossless-zero-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 300n,
      status: "billing_failed",
      sessionId: "ccb-lossless-zero",
      turnKey,
    });
    assert.equal(result.debitedCredits, null);
    assert.equal(result.attributionCredits, 0n);
    const pending = await query<{
      user_id: string;
      turn_key: string | null;
      cost_credits: string;
    }>(
      `SELECT user_id,turn_key,cost_credits
         FROM pending_usage_patches WHERE request_id=$1`,
      ["req-lossless-zero-1"],
    );
    assert.deepEqual(pending.rows, [{
      user_id: `c:${uid.toString()}`,
      turn_key: turnKey,
      cost_credits: "0",
    }]);
    const truth = await query<{ input_tokens: string; ledger_id: string | null }>(
      `SELECT input_tokens::text,ledger_id::text
         FROM usage_records WHERE id=$1`,
      [result.usageId.toString()],
    );
    assert.equal(truth.rows[0].input_tokens, String(makeUsage().input_tokens));
    assert.equal(truth.rows[0].ledger_id, null);
  });

  test("immutable lossless locator conflict rolls back usage and debit together", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("lossless-conflict@example.com", 1000n);
    await query(
      `INSERT INTO pending_usage_patches
         (request_id,user_id,turn_key,cost_credits)
       VALUES ($1,$2,$3,$4)`,
      ["req-lossless-conflict", `c:${uid.toString()}`, "b".repeat(64), "999"],
    );
    await assert.rejects(
      settleUsageAndLedger(getPool(), {
        userId: uid,
        accountId: null,
        requestId: "req-lossless-conflict",
        model: "test-model",
        usage: makeUsage(),
        snapshotJson: SNAPSHOT_JSON,
        costCredits: 300n,
        status: "success",
        sessionId: "ccb-lossless-2",
        turnKey: "a".repeat(64),
      }),
      /immutable lossless cost locator conflict/,
    );
    const user = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(user.rows[0].credits, "1000");
    const usage = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM usage_records WHERE user_id=$1",
      [uid.toString()],
    );
    const ledger = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(usage.rows[0].count, "0");
    assert.equal(ledger.rows[0].count, "0");
  });

  test("23505 幂等: 同 (user_id, request_id) 二次进入 → 返回已有行 + debitedCredits=null", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("idem@example.com", 1000n);
    const acctId = await createClaudeAccount("idem-acct");

    const first = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-idem-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 200n,
      status: "success",
      sessionId: null,
    });
    assert.equal(first.debitedCredits, 200n);
    assert.equal(first.balanceAfter, 800n);

    // 二次:同 requestId
    const second = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-idem-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 999n, // 故意改成不同 cost,看是否被 SELECT 路径覆盖
      status: "success",
      sessionId: null,
    });
    assert.equal(second.usageId, first.usageId, "应返回已有 usage 行");
    assert.equal(second.ledgerId, first.ledgerId, "应返回已有 ledger 行");
    assert.equal(second.debitedCredits, null);
    assert.equal(second.balanceAfter, null);
    assert.equal(second.clamped, false);

    // users.credits 没被二次扣 → 仍 800
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "800");

    // ledger 仅 1 行
    const led = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].c, "1");
  });

  test("clamp: 余额 < cost → debit 夹到 balance, balanceAfter=0, ledger memo 含 'clamped'", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("clamp@example.com", 100n);
    const acctId = await createClaudeAccount("clamp-acct");

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-clamp-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 300n,
      status: "success",
      sessionId: null,
    });

    assert.equal(result.debitedCredits, 100n, "debit 夹到 balance");
    assert.equal(result.balanceAfter, 0n);
    assert.equal(result.clamped, true);

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "0");

    const led = await query<{ delta: string; memo: string | null }>(
      "SELECT delta::text AS delta, memo FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].delta, "-100");
    assert.ok(led.rows[0].memo !== null);
    assert.match(led.rows[0].memo!, /clamped/);
    assert.match(led.rows[0].memo!, /cost=300/);
    assert.match(led.rows[0].memo!, /balance=100/);
  });

  test("DeepSeek path: accountId=null → usage_records.account_id IS NULL, debit 正常", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("deepseek@example.com", 500n);

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: null,
      requestId: "req-ds-1",
      model: "deepseek-chat",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 150n,
      status: "success",
      sessionId: null,
    });

    assert.equal(result.debitedCredits, 150n);
    assert.equal(result.balanceAfter, 350n);

    const ur = await query<{ account_id: string | null }>(
      "SELECT account_id::text AS account_id FROM usage_records WHERE id=$1",
      [result.usageId.toString()],
    );
    assert.equal(ur.rows[0].account_id, null);

    // ledger 仍写
    const led = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].c, "1");
  });

  test("status='billing_failed': 只写 usage_records, 不走 ledger, users.credits 未变", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("bf@example.com", 1000n);
    const acctId = await createClaudeAccount("bf-acct");

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-bf-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 200n,
      status: "billing_failed",
      sessionId: null,
    });

    assert.equal(result.ledgerId, null);
    assert.equal(result.debitedCredits, null);
    assert.equal(result.balanceAfter, null);
    assert.equal(result.clamped, false);
    assert.ok(result.usageId > 0n);

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "1000", "users.credits 未变");

    const led = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].c, "0");

    const ur = await query<{ status: string; ledger_id: string | null }>(
      "SELECT status, ledger_id::text AS ledger_id FROM usage_records WHERE id=$1",
      [result.usageId.toString()],
    );
    assert.equal(ur.rows[0].status, "billing_failed");
    assert.equal(ur.rows[0].ledger_id, null);
  });

  test("status='error': 同 billing_failed,不走 ledger", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("err@example.com", 1000n);
    const acctId = await createClaudeAccount("err-acct");

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-err-1",
      model: "test-model",
      usage: makeUsage(),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 200n,
      status: "error",
      sessionId: null,
    });

    assert.equal(result.ledgerId, null);
    assert.equal(result.debitedCredits, null);
    assert.equal(result.balanceAfter, null);
    assert.ok(result.usageId > 0n);

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "1000");
  });

  test("cost=0 + success: 写 usage_records 但不写 ledger", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("zero@example.com", 1000n);
    const acctId = await createClaudeAccount("zero-acct");

    const result = await settleUsageAndLedger(getPool(), {
      userId: uid,
      accountId: acctId,
      requestId: "req-zero-1",
      model: "test-model",
      usage: makeUsage(0, 0),
      snapshotJson: SNAPSHOT_JSON,
      costCredits: 0n,
      status: "success",
      sessionId: null,
    });

    assert.equal(result.ledgerId, null);
    assert.equal(result.debitedCredits, null);
    assert.equal(result.balanceAfter, null);
    assert.ok(result.usageId > 0n);

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "1000");

    const led = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].c, "0");
  });
});
