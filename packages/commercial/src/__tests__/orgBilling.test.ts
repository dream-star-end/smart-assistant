/**
 * 企业版(P3.1)批次 B 计费行为测试 —— 真 DB round-trip。
 *
 * 隔离策略:专属数据库 openclaude_orgb_test(before CREATE / after DROP),不碰共享
 * openclaude_test.public —— 与 orgEnterprise.test.ts 同手法,避开 unit 套件里 DROP SCHEMA
 * 型测试并发时的整库竞争(基线 ~72 失败即含此类跨文件 race)。
 *
 * 覆盖(方案 §2/§3/§5,计费面=错账风险区,断言宁多勿少):
 *   - spendTwoBucket 四桶组合:org 够 / org 落期内 / 三桶落钱包 / 三桶不足 clamp;扣费顺序
 *     org_wallet → period → wallet;org 行字段(bucket/org_id/balance_after/user_id)。
 *   - settle 集成:billing_enabled=false 打戳不扣 org(个人桶付);成员打戳 usage_records.org_id;
 *     非成员 org_id NULL;org active 成员 org 桶优先扣。
 *   - org suspended → spendTwoBucket fail-open 降级个人桶。
 *   - org topup fulfill 幂等(markOrderPaid 重放不重复入账);admin 调额流水 + 审计 + 负调下限。
 *   - 读路径 getOrgBalance / listOrgLedger / listOrgOrders。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createPool, closePool, getPool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { spendTwoBucket } from "../billing/spend.js";
import { settleUsageAndLedger } from "../billing/proxyBilling.js";
import { createOrg } from "../org/orgs.js";
import { createOrgTopupOrder, markOrderPaid } from "../payment/orders.js";
import { adjustOrgCredits } from "../admin/orgs.js";
import {
  resolveOrgBillingContext,
  getOrgBalance,
  listOrgLedger,
  listOrgOrders,
} from "../org/orgBilling.js";
import { OrgError } from "../org/types.js";
import type { TokenUsage } from "../billing/calculator.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orgb_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const MY_URL = withDb(BASE_URL, MY_DB);

let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  try {
    await adminExec("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`);
  await adminExec(`CREATE DATABASE ${MY_DB} TEMPLATE template0`);

  await resetPool();
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10 }));
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  await closePool();
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`).catch(() => {});
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE TABLE orders, credit_ledger, usage_records, org_memberships, orgs,
       user_subscriptions, users, admin_audit RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

// ─── fixtures ───────────────────────────────────────────────────────

async function createUser(email: string, walletCredits = 0n): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled, credits)
     VALUES ($1, 'argon2$stub', 'user', 'active', TRUE, TRUE, $2) RETURNING id::text AS id`,
    [email, walletCredits.toString()],
  );
  return r.rows[0].id;
}

let orgSeq = 0;

/**
 * 建 org(带内部 throwaway owner,避免与测试的"消费成员"撞 owner/PK 唯一约束)。
 * 测试的消费用户单独 addMember 为 member。返回 orgId。
 */
async function makeOrg(
  credits = 0n,
  opts: { name?: string; status?: string } = {},
): Promise<string> {
  const owner = await createUser(`org-owner-${++orgSeq}@x.com`);
  const orgId = await tx(async (client) => {
    const o = await createOrg(
      { name: opts.name ?? "Acme", ownerUserId: owner, createdBy: null, maxMembers: 100 },
      client,
    );
    return o.id;
  });
  await query(`UPDATE orgs SET credits = $1, status = $2 WHERE id = $3::bigint`, [
    credits.toString(),
    opts.status ?? "active",
    orgId,
  ]);
  return orgId;
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
  billingEnabled = true,
): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, $3, 'active', $4)`,
    [orgId, userId, role, billingEnabled],
  );
}

/** 给用户设一个 active 期内桶(plan_code='free' 已由 0096 seed)。 */
async function setPeriod(userId: string, periodCredits: bigint): Promise<void> {
  await query(
    `INSERT INTO user_subscriptions(user_id, plan_code, status, period_start, period_end, period_credits)
     VALUES ($1::bigint, 'free', 'active', NOW(), NOW() + INTERVAL '30 days', $2)
     ON CONFLICT (user_id) DO UPDATE SET status='active',
       period_end = NOW() + INTERVAL '30 days', period_credits = EXCLUDED.period_credits`,
    [userId, periodCredits.toString()],
  );
}

async function orgCredits(orgId: string): Promise<bigint> {
  const r = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM orgs WHERE id=$1::bigint`,
    [orgId],
  );
  return BigInt(r.rows[0].credits);
}
async function userCredits(uid: string): Promise<bigint> {
  const r = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM users WHERE id=$1::bigint`,
    [uid],
  );
  return BigInt(r.rows[0].credits);
}
async function periodCredits(uid: string): Promise<bigint> {
  const r = await query<{ p: string }>(
    `SELECT COALESCE(period_credits,0)::text AS p FROM user_subscriptions WHERE user_id=$1::bigint`,
    [uid],
  );
  return r.rows[0] ? BigInt(r.rows[0].p) : 0n;
}

function usage(input = 100, output = 50): TokenUsage {
  return { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 };
}

// ====================================================================
// spendTwoBucket — 四桶组合扣费顺序 + clamp
// ====================================================================

describe("spendTwoBucket — org 桶(第 0 优先)扣费顺序", () => {
  test("org 够:全额从 org 扣,period/wallet 不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("a@x.com", 500n);
    const orgId = await makeOrg(1000n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 500n);

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }),
    );
    assert.equal(r.debited, 300n);
    assert.equal(r.clamped, false);
    assert.equal(r.fromOrg, 300n);
    assert.equal(r.fromPeriod, 0n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(r.orgAfter, 700n);
    assert.equal(r.periodAfter, 500n);
    assert.equal(r.walletAfter, 500n);
    // DB 落地
    assert.equal(await orgCredits(orgId), 700n);
    assert.equal(await periodCredits(uid), 500n);
    assert.equal(await userCredits(uid), 500n);
    // org 桶只 1 条 org_wallet 流水,字段完整
    const led = await query<{
      bucket: string; org_id: string; user_id: string; delta: string; balance_after: string;
    }>(
      `SELECT bucket, org_id::text AS org_id, user_id::text AS user_id,
              delta::text AS delta, balance_after::text AS balance_after
         FROM credit_ledger WHERE org_id IS NOT NULL`,
    );
    assert.equal(led.rowCount, 1);
    assert.equal(led.rows[0].bucket, "org_wallet");
    assert.equal(led.rows[0].org_id, orgId);
    assert.equal(led.rows[0].user_id, uid); // 消费成员
    assert.equal(led.rows[0].delta, "-300");
    assert.equal(led.rows[0].balance_after, "700");
    assert.equal(r.ledgerOrgId !== null && r.ledgerOrgId > 0n, true);
    assert.equal(r.primaryLedgerId, r.ledgerOrgId); // org 独付 → 主流水=org 行
  });

  test("org 不够 → 溢到期内桶(org → period)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("b@x.com", 500n);
    const orgId = await makeOrg(100n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 500n);

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }),
    );
    assert.equal(r.debited, 300n);
    assert.equal(r.clamped, false);
    assert.equal(r.fromOrg, 100n);
    assert.equal(r.fromPeriod, 200n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(r.orgAfter, 0n);
    assert.equal(r.periodAfter, 300n);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await periodCredits(uid), 300n);
    assert.equal(await userCredits(uid), 500n);
    const led = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM credit_ledger`);
    assert.equal(led.rows[0].c, "2"); // org_wallet + period
  });

  test("org + period 不够 → 溢到持久钱包(org → period → wallet)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("c@x.com", 500n);
    const orgId = await makeOrg(100n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 100n);

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }),
    );
    assert.equal(r.fromOrg, 100n);
    assert.equal(r.fromPeriod, 100n);
    assert.equal(r.fromWallet, 100n);
    assert.equal(r.clamped, false);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await periodCredits(uid), 0n);
    assert.equal(await userCredits(uid), 400n);
    // 主流水优先钱包行
    assert.equal(r.primaryLedgerId, r.ledgerWalletId);
  });

  test("三桶都不够 → clamp 到总可用,memo 标 clamped", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("d@x.com", 50n);
    const orgId = await makeOrg(50n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 50n);

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }),
    );
    assert.equal(r.debited, 150n);
    assert.equal(r.clamped, true);
    assert.equal(r.fromOrg, 50n);
    assert.equal(r.fromPeriod, 50n);
    assert.equal(r.fromWallet, 50n);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await userCredits(uid), 0n);
    assert.equal(await periodCredits(uid), 0n);
    const led = await query<{ memo: string | null }>(
      `SELECT memo FROM credit_ledger WHERE bucket='org_wallet'`,
    );
    assert.match(led.rows[0].memo!, /clamped/);
    assert.match(led.rows[0].memo!, /requested=300/);
  });

  test("org 余额为 0(参与但空)→ 无 org_wallet 流水,全走个人", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("e@x.com", 500n);
    const orgId = await makeOrg(0n);
    await addMember(orgId, uid, "member");

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat", orgId }),
    );
    assert.equal(r.fromOrg, 0n);
    assert.equal(r.orgAfter, 0n); // 参与但扣 0
    assert.equal(r.fromWallet, 200n);
    const led = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM credit_ledger WHERE bucket='org_wallet'`,
    );
    assert.equal(led.rows[0].c, "0"); // fromOrg=0 不写 org 流水
  });

  test("org suspended → fail-open 跳过 org 桶,个人钱包付", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("f@x.com", 500n);
    const orgId = await makeOrg(1000n, { status: "suspended" });
    await addMember(orgId, uid, "member");

    const r = await tx((c) =>
      spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat", orgId }),
    );
    assert.equal(r.fromOrg, 0n);
    assert.equal(r.orgAfter, null, "org 未参与 → orgAfter null");
    assert.equal(r.fromWallet, 200n);
    assert.equal(await orgCredits(orgId), 1000n, "suspended org 余额不动");
    assert.equal(await userCredits(uid), 300n);
  });

  test("无 orgId → 纯个人两桶(org 桶字段全归零/null)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("g@x.com", 500n);
    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat" }));
    assert.equal(r.fromOrg, 0n);
    assert.equal(r.orgAfter, null);
    assert.equal(r.ledgerOrgId, null);
    assert.equal(r.fromWallet, 200n);
  });
});

// ====================================================================
// settle 集成 — usage_records.org_id 打戳 + 桶解耦
// ====================================================================

describe("settleUsageAndLedger — org 打戳与扣费桶", () => {
  test("active 成员(billing_enabled=true):打戳 org_id + org 桶优先扣", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m1@x.com", 1000n);
    const orgId = await makeOrg(1000n);
    await addMember(orgId, uid, "member", true);

    const res = await settleUsageAndLedger(getPool(), {
      userId: BigInt(uid),
      accountId: null,
      requestId: "req-org-1",
      model: "test-model",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 300n,
      status: "success",
      sessionId: null,
    });
    assert.equal(res.debitedCredits, 300n);
    // usage_records 打戳
    const ur = await query<{ org_id: string | null }>(
      `SELECT org_id::text AS org_id FROM usage_records WHERE id=$1`,
      [res.usageId.toString()],
    );
    assert.equal(ur.rows[0].org_id, orgId);
    // org 桶被扣,个人钱包不动
    assert.equal(await orgCredits(orgId), 700n);
    assert.equal(await userCredits(uid), 1000n);
    const led = await query<{ bucket: string; org_id: string | null }>(
      `SELECT bucket, org_id::text AS org_id FROM credit_ledger`,
    );
    assert.equal(led.rowCount, 1);
    assert.equal(led.rows[0].bucket, "org_wallet");
    assert.equal(led.rows[0].org_id, orgId);
  });

  test("billing_enabled=false:打戳 org_id 但个人桶付(org 钱包不动)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m2@x.com", 1000n);
    const orgId = await makeOrg(1000n);
    await addMember(orgId, uid, "member", false); // 关闭 org 付费

    const res = await settleUsageAndLedger(getPool(), {
      userId: BigInt(uid),
      accountId: null,
      requestId: "req-org-2",
      model: "test-model",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 300n,
      status: "success",
      sessionId: null,
    });
    assert.equal(res.debitedCredits, 300n);
    const ur = await query<{ org_id: string | null }>(
      `SELECT org_id::text AS org_id FROM usage_records WHERE id=$1`,
      [res.usageId.toString()],
    );
    assert.equal(ur.rows[0].org_id, orgId, "仍打戳(成员在 org 语境)");
    assert.equal(await orgCredits(orgId), 1000n, "org 钱包不动");
    assert.equal(await userCredits(uid), 700n, "个人钱包付");
    // 个人 wallet 流水 org_id NULL
    const led = await query<{ bucket: string; org_id: string | null }>(
      `SELECT bucket, org_id::text AS org_id FROM credit_ledger`,
    );
    assert.equal(led.rows[0].bucket, "wallet");
    assert.equal(led.rows[0].org_id, null);
  });

  test("非成员:org_id NULL,纯个人扣费", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("loner@x.com", 1000n);
    const res = await settleUsageAndLedger(getPool(), {
      userId: BigInt(uid),
      accountId: null,
      requestId: "req-org-3",
      model: "test-model",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 200n,
      status: "success",
      sessionId: null,
    });
    const ur = await query<{ org_id: string | null }>(
      `SELECT org_id::text AS org_id FROM usage_records WHERE id=$1`,
      [res.usageId.toString()],
    );
    assert.equal(ur.rows[0].org_id, null);
    assert.equal(await userCredits(uid), 800n);
  });

  test("suspended org 成员:resolveOrgBillingContext → null(不打戳,个人付)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("m4@x.com", 1000n);
    const orgId = await makeOrg(1000n, { status: "suspended" });
    await addMember(orgId, uid, "member", true);

    const ctx = await resolveOrgBillingContext(getPool() as never, uid);
    assert.equal(ctx, null, "org 非 active → 解析为 null");

    const res = await settleUsageAndLedger(getPool(), {
      userId: BigInt(uid),
      accountId: null,
      requestId: "req-org-4",
      model: "test-model",
      usage: usage(),
      snapshotJson: "{}",
      costCredits: 200n,
      status: "success",
      sessionId: null,
    });
    const ur = await query<{ org_id: string | null }>(
      `SELECT org_id::text AS org_id FROM usage_records WHERE id=$1`,
      [res.usageId.toString()],
    );
    assert.equal(ur.rows[0].org_id, null);
    assert.equal(await orgCredits(orgId), 1000n);
    assert.equal(await userCredits(uid), 800n);
  });
});

// ====================================================================
// org topup 履约幂等
// ====================================================================

describe("org topup — createOrgTopupOrder + markOrderPaid 幂等", () => {
  test("首次履约:orgs.credits 入账 + org_wallet 流水;重放不重复入账", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("op@x.com");
    const orgId = await makeOrg(200n);
    await addMember(orgId, uid, "admin");

    const order = await createOrgTopupOrder({ orgId, operatorUserId: uid, amountCents: 5000n });
    assert.equal(order.org_id?.toString(), orgId);
    assert.equal(order.kind, "topup");
    assert.equal(order.credits, 5000n); // 1 分 = 1 积分
    assert.equal(order.user_id.toString(), uid); // 经办人

    const first = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 5000n });
    assert.equal(first.newlyPaid, true);
    assert.equal(await orgCredits(orgId), 5200n); // 200 + 5000
    const led1 = await query<{ bucket: string; org_id: string; reason: string; balance_after: string; user_id: string }>(
      `SELECT bucket, org_id::text AS org_id, reason, balance_after::text AS balance_after, user_id::text AS user_id
         FROM credit_ledger WHERE ref_type='order'`,
    );
    assert.equal(led1.rowCount, 1);
    assert.equal(led1.rows[0].bucket, "org_wallet");
    assert.equal(led1.rows[0].org_id, orgId);
    assert.equal(led1.rows[0].reason, "topup");
    assert.equal(led1.rows[0].balance_after, "5200");
    assert.equal(led1.rows[0].user_id, uid);

    // 重放:幂等,不重复入账/流水
    const replay = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 5000n });
    assert.equal(replay.newlyPaid, false);
    assert.equal(await orgCredits(orgId), 5200n, "重放不再加钱");
    const led2 = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM credit_ledger WHERE ref_type='order'`);
    assert.equal(led2.rows[0].c, "1", "重放不再写流水");
  });

  test("金额篡改:expectedAmountCents 不匹配 → 抛错,不入账", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("op2@x.com");
    const orgId = await makeOrg(0n);
    await addMember(orgId, uid, "admin");
    const order = await createOrgTopupOrder({ orgId, operatorUserId: uid, amountCents: 5000n });
    await assert.rejects(
      () => markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 100n }),
      (e: any) => e.code === "PAYMENT_CALLBACK_TAMPERED",
    );
    assert.equal(await orgCredits(orgId), 0n);
  });

  test("listOrgOrders / getOrgBalance 读路径", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("op3@x.com");
    const orgId = await makeOrg(0n);
    await addMember(orgId, uid, "admin");
    const order = await createOrgTopupOrder({ orgId, operatorUserId: uid, amountCents: 5000n });
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: {}, expectedAmountCents: 5000n });

    assert.equal(await getOrgBalance(orgId), 5000n);
    const orders = await listOrgOrders(orgId);
    assert.equal(orders.rows.length, 1);
    assert.equal(orders.rows[0].status, "paid");
    assert.equal(orders.rows[0].order_no, order.order_no);
    const ledger = await listOrgLedger(orgId);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].reason, "topup");
    assert.equal(ledger.rows[0].balance_after, "5000");
  });
});

// ====================================================================
// admin 调额
// ====================================================================

describe("adjustOrgCredits — 平台超管调 org 余额", () => {
  test("正调:credits += delta + org_wallet 流水 + admin_audit", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com");
    const orgId = await makeOrg(1000n);

    const r = await adjustOrgCredits({ orgId, delta: 500n, memo: "seed grant", adminId: admin });
    assert.equal(r.balance_after, 1500n);
    assert.equal(await orgCredits(orgId), 1500n);
    const led = await query<{ bucket: string; reason: string; org_id: string; user_id: string; delta: string }>(
      `SELECT bucket, reason, org_id::text AS org_id, user_id::text AS user_id, delta::text AS delta
         FROM credit_ledger WHERE id=$1`,
      [r.ledger_id.toString()],
    );
    assert.equal(led.rows[0].bucket, "org_wallet");
    assert.equal(led.rows[0].reason, "admin_adjust");
    assert.equal(led.rows[0].org_id, orgId);
    assert.equal(led.rows[0].user_id, admin); // 操作 admin
    assert.equal(led.rows[0].delta, "500");
    const audit = await query<{ action: string; target: string }>(
      `SELECT action, target FROM admin_audit ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0].action, "org.credits.adjust");
    assert.equal(audit.rows[0].target, `org:${orgId}`);
  });

  test("负调:扣减入账;打到负 → INSUFFICIENT_ORG_CREDITS 且不改余额", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com");
    const orgId = await makeOrg(300n);

    const r = await adjustOrgCredits({ orgId, delta: -100n, memo: "clawback", adminId: admin });
    assert.equal(r.balance_after, 200n);
    assert.equal(await orgCredits(orgId), 200n);

    await assert.rejects(
      () => adjustOrgCredits({ orgId, delta: -9999n, memo: "too much", adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.code === "INSUFFICIENT_ORG_CREDITS",
    );
    assert.equal(await orgCredits(orgId), 200n, "越界负调不改余额");
  });

  test("delta=0 / 空 memo / org 不存在 → 拒", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("admin@x.com");
    const orgId = await makeOrg(100n);
    await assert.rejects(
      () => adjustOrgCredits({ orgId, delta: 0n, memo: "x", adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.code === "VALIDATION",
    );
    await assert.rejects(
      () => adjustOrgCredits({ orgId, delta: 10n, memo: "  ", adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.code === "VALIDATION",
    );
    await assert.rejects(
      () => adjustOrgCredits({ orgId: "999999", delta: 10n, memo: "x", adminId: admin }),
      (e: unknown) => e instanceof OrgError && e.code === "NOT_FOUND",
    );
  });
});
