/**
 * BINV-3 并发幂等 — Phase 1.A 锁不变量。
 *
 * 锁的不变量(`PHASE1-TEST-COVERAGE-PLAN.md` Audit 表 BINV-3 行):
 *   两个 worker 同时以同一 (user_id, request_id) 进入 `settleUsageAndLedger` 时,
 *   PG `usage_records` 的 UNIQUE 约束让其中一个吃 23505 → 走幂等 SELECT 路径,
 *   最终 `credits` 只被扣一次,`credit_ledger` 只有一行。
 *
 * 与 `settleUsage.integ.test.ts:262` 的"顺序二次进入幂等"互补:那里测的是
 * 序列化场景(同一 worker 顺序调两次),本测试锁的是真正并发场景 —
 * INSERT 同时撞 UNIQUE 约束,只有 PG 单点能区分赢家与输家。
 *
 * 不覆盖:
 *   - 同 request_id 但不同 cost / accountId / status:线上不会出现(`requestId`
 *     由 finalize 调度器与 `request_finalize_journal` 单点串行驱动),只测内核
 *     UNIQUE 防线本身
 *
 * 跑法: `npx tsx --test src/__tests__/settleUsageConcurrent.integ.test.ts`
 *   需 PG fixture(同 `settleUsage.integ.test.ts`),CI 上 `REQUIRE_TEST_DB=1`
 *   强制运行,本地无 PG 时自动 skip。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
  getPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { settleUsageAndLedger } from "../billing/proxyBilling.js";
import { reserveImageUsage, settleImageCharge } from "../billing/imageBilling.js";
import { settleMiniMaxMediaSuccess } from "../minimax/mediaBilling.js";
import type { MiniMaxMediaCostResult } from "../minimax/mediaPricing.js";
import type { TokenUsage } from "../billing/calculator.js";
import { generatePersona } from "../account-pool/persona.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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
  // max=20 高于 settleUsage.integ 的 10 — 并发 settle 同时持有 client 不能饿死
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
  await query(
    "TRUNCATE TABLE admin_audit, usage_records, credit_ledger, claude_accounts, egress_proxies, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
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

async function createEgressProxy(label: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce)
     VALUES ($1, '\\x00'::bytea, '\\x00'::bytea)
     RETURNING id::text AS id`,
    [label],
  );
  return BigInt(r.rows[0].id);
}

async function createClaudeAccount(label: string): Promise<bigint> {
  const epId = await createEgressProxy(`${label}-ep`);
  // 0074 把 persona 锁 NOT NULL + shape CHECK,raw INSERT 必须塞合法 persona。
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

describe("settleUsageAndLedger — 并发幂等 (BINV-3)", () => {
  test("两个 worker 同时 settle 同 (uid, request_id) → 只扣一次 + 仅一行 ledger + 一个返回 debit, 另一个返回 null", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("concurrent@example.com", 1000n);
    const acctId = await createClaudeAccount("concurrent-acct");
    const REQUEST_ID = "req-concurrent-1";

    // Promise.all 两笔并发,PG 内核串行化 INSERT,只有一个能拿到新行,
    // 另一个吃 23505 → 走 SELECT 幂等路径。
    const [a, b] = await Promise.all([
      settleUsageAndLedger(getPool(), {
        userId: uid,
        accountId: acctId,
        requestId: REQUEST_ID,
        model: "test-model",
        usage: makeUsage(),
        snapshotJson: SNAPSHOT_JSON,
        costCredits: 200n,
        status: "success",
        sessionId: null,
      }),
      settleUsageAndLedger(getPool(), {
        userId: uid,
        accountId: acctId,
        requestId: REQUEST_ID,
        model: "test-model",
        usage: makeUsage(),
        snapshotJson: SNAPSHOT_JSON,
        costCredits: 200n,
        status: "success",
        sessionId: null,
      }),
    ]);

    // 同一 usage / ledger 行(winner 写 + loser 走幂等 SELECT 返回同 id)
    assert.equal(a.usageId, b.usageId, "并发两笔应返回同 usage_id");
    assert.equal(a.ledgerId, b.ledgerId, "并发两笔应返回同 ledger_id");

    // 恰好一笔标记为 winner(debit 非 null),另一笔 idempotent (null)
    const debits = [a.debitedCredits, b.debitedCredits];
    const balanceAfters = [a.balanceAfter, b.balanceAfter];
    const nonNullDebits = debits.filter((d): d is bigint => d !== null);
    const nullDebits = debits.filter((d) => d === null);
    assert.equal(nonNullDebits.length, 1, "应只有一笔 debit 非 null");
    assert.equal(nullDebits.length, 1, "另一笔必须走幂等 null 路径");
    assert.equal(nonNullDebits[0], 200n);
    // winner 的 balanceAfter 对应扣完,loser 的为 null
    const nonNullBalances = balanceAfters.filter((b): b is bigint => b !== null);
    assert.equal(nonNullBalances.length, 1);
    assert.equal(nonNullBalances[0], 800n);

    // users.credits 只被扣一次 → 1000 - 200 = 800
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid.toString()],
    );
    assert.equal(u.rows[0].credits, "800", "余额必须只扣一次");

    // credit_ledger 只有一行
    const led = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows[0].c, "1", "ledger 必须只有 1 行");

    // usage_records 只有一行
    const ur = await query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM usage_records WHERE user_id=$1 AND request_id=$2",
      [uid.toString(), REQUEST_ID],
    );
    assert.equal(ur.rows[0].c, "1", "usage 必须只有 1 行");
  });
});

// P2b 资金原子性 T5(docs/ARCH_P2B_FUND_ENTRY_GATES.md):同一用户、不同 request 并发扣费,总额超过余额。
// F8 修复前:usage_records 外键让 INSERT 先拿 users 行 KEY SHARE,随后 spendTwoBucket 才 FOR UPDATE,
// 并发互等 → 40P01(一次运行 8 笔中止 7 笔)。修复后先锁钱包行再 INSERT,8 笔都必须成功。
describe("settleUsageAndLedger — 不同 request 并发扣费 (P2b T5)", () => {
  test("8 笔并发、总额 1600 > 余额 1000:全部成功,余额落到 0 不为负,流水 delta 之和 = 实扣之和 = 1000", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p2b-t5@example.com", 1000n);
    const acctId = await createClaudeAccount("p2b-t5-acct");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        settleUsageAndLedger(getPool(), {
          userId: uid,
          accountId: acctId,
          requestId: `p2b-t5-req-${i}`,
          model: "test-model",
          usage: makeUsage(),
          snapshotJson: SNAPSHOT_JSON,
          costCredits: 200n,
          status: "success",
          sessionId: null,
        }),
      ),
    );
    const debited = results.reduce((sum, r) => sum + (r.debitedCredits ?? 0n), 0n);
    assert.equal(debited, 1000n);
    assert.ok(results.some((r) => r.clamped), "at least one settle is clamped");
    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid.toString()]);
    assert.equal(u.rows[0].credits, "0");
    const led = await query<{ delta: string; balance_after: string }>(
      "SELECT delta::text AS delta, balance_after::text AS balance_after FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows.reduce((sum, r) => sum + BigInt(r.delta), 0n), -1000n);
    for (const r of led.rows) assert.ok(BigInt(r.balance_after) >= 0n, `balance_after ${r.balance_after} >= 0`);
    const ur = await query<{ c: string }>("SELECT COUNT(*)::text AS c FROM usage_records WHERE user_id=$1", [uid.toString()]);
    assert.equal(ur.rows[0].c, "8");
  });
});

// P2b P6(OCV5-631):自带事务、直接调 spendTwoBucket 的两个计费变体,与 T5 同一并发形状。
// mediaBilling 先 INSERT minimax_media_usage_records(user_id 外键 → users FOR KEY SHARE),再在
// spendTwoBucket 里 FOR UPDATE 同一行:同一用户并发结算互等升级 → 40P01,与 F8 同形。
// imageBilling 结算前不 INSERT 引用 users 的行,锁序是「本行 → 钱包」;同一用户同时只能有一张在飞的图
// (uq_image_usage_one_inflight),所以它只会与对话/媒体结算并发,T8 固定这种混跑不死锁。
const MEDIA_COST = (credits: bigint): MiniMaxMediaCostResult => ({
  operation: "speech",
  model: "speech-test",
  units: { characters: 100 },
  costCredits: credits,
  snapshot: { source: "test" } as unknown as MiniMaxMediaCostResult["snapshot"],
});

describe("P6 自带事务计费变体 — 同一用户并发 (OCV5-631)", () => {
  test("T6 media:8 笔并发、总额 1600 > 余额 1000:全部成功,余额 0,流水 = 实扣 = 1000", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p6-t6@example.com", 1000n);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        settleMiniMaxMediaSuccess(getPool(), {
          userId: uid, containerId: null, requestId: `p6-t6-req-${i}`, cost: MEDIA_COST(200n),
        }),
      ),
    );
    const debited = results.reduce((sum, r) => sum + (r.debitedCredits ?? 0n), 0n);
    assert.equal(debited, 1000n);
    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid.toString()]);
    assert.equal(u.rows[0].credits, "0");
    const led = await query<{ delta: string; balance_after: string }>(
      "SELECT delta::text AS delta, balance_after::text AS balance_after FROM credit_ledger WHERE user_id=$1",
      [uid.toString()],
    );
    assert.equal(led.rows.reduce((sum, r) => sum + BigInt(r.delta), 0n), -1000n);
    for (const r of led.rows) assert.ok(BigInt(r.balance_after) >= 0n, `balance_after ${r.balance_after} >= 0`);
    const mr = await query<{ c: string }>("SELECT COUNT(*)::text AS c FROM minimax_media_usage_records WHERE user_id=$1", [uid.toString()]);
    assert.equal(mr.rows[0].c, "8");
  });

  test("T8 混跑:对话结算 ×4 + 媒体 ×4 + 一张已预留生图的结算,同一用户并发,全部成功且余额 = 流水", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p6-t8@example.com", 10_000n);
    const acctId = await createClaudeAccount("p6-t8-acct");
    await reserveImageUsage(getPool(), { userId: uid, containerId: null, requestId: "p6-t8-img", operation: "generation" });
    const [, , image] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, (_, i) =>
        settleUsageAndLedger(getPool(), {
          userId: uid, accountId: acctId, requestId: `p6-t8-chat-${i}`, model: "test-model",
          usage: makeUsage(), snapshotJson: SNAPSHOT_JSON, costCredits: 100n, status: "success", sessionId: null,
        }))),
      Promise.all(Array.from({ length: 4 }, (_, i) =>
        settleMiniMaxMediaSuccess(getPool(), { userId: uid, containerId: null, requestId: `p6-t8-media-${i}`, cost: MEDIA_COST(70n) }))),
      settleImageCharge(getPool(), { userId: uid, containerId: null, requestId: "p6-t8-img", operation: "generation", responseBody: Buffer.from("{}") }),
    ]);
    assert.equal(image.duplicate, false);
    const expected = 4n * 100n + 4n * 70n + 50n;
    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid.toString()]);
    assert.equal(BigInt(u.rows[0].credits), 10_000n - expected);
    const led = await query<{ s: string }>("SELECT COALESCE(SUM(delta),0)::text AS s FROM credit_ledger WHERE user_id=$1", [uid.toString()]);
    assert.equal(BigInt(led.rows[0].s), -expected);
  });
});
