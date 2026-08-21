/**
 * 企业版(P3.1 二期 · 批次 E)org 席位订阅 + 四桶扣费行为测试 —— 真 DB round-trip。
 *
 * 隔离策略:专属数据库 openclaude_orge_test(before CREATE / after DROP),不碰共享
 * openclaude_test.public —— 与 orgBilling.test.ts 同手法,避开 unit 套件里 DROP SCHEMA
 * 型测试并发时的整库竞争(基线失败集含此类跨文件 race)。
 *
 * 覆盖(方案 §11-§13,计费面=错账风险区,断言宁多勿少):
 *   - spendTwoBucket 四桶顺序 org_period → org_wallet → user_period → user_wallet 与 clamp
 *     全组合;过期 org 订阅不可花(period_end>NOW() 谓词);org_period 流水字段完整。
 *   - grantOrgSubscriptionTx 新开/续费(旧池清零负流水 + 新池正流水 + period 顺延);
 *     min_seats / 非 org 档 校验。
 *   - addOrgSeatsTx 期中加席即时入池(period 不变);过期/无订阅拒绝。
 *   - rolloverExpiredOrgSubscriptions 清零 + expired + org 钱包不动 + 不认领 active。
 *   - getOrgSpendableForUser 预检含 org 期内池(与扣费参与条件成对);过期/关闭付费的口径。
 *   - credit_ledger org_period 完整性 CHECK(org_id 非空)生效。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { spendTwoBucket } from "../billing/spend.js";
import { createOrg } from "../org/orgs.js";
import { getOrgSpendableForUser } from "../org/orgBilling.js";
import {
  grantOrgSubscriptionTx,
  addOrgSeatsTx,
  getOrgSubscription,
  getOrgPlan,
  listOrgSubscriptionPlans,
  rolloverExpiredOrgSubscriptions,
} from "../org/orgSubscriptions.js";
import { OrgError } from "../org/types.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orge_test";
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
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10, statementTimeoutMs: 120_000 }));
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
    `TRUNCATE TABLE orders, credit_ledger, usage_records, org_subscriptions, org_memberships, orgs,
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

/** 建 org(带 owner membership)。返回 {orgId, ownerId}。 */
async function makeOrg(
  credits = 0n,
  opts: { name?: string; status?: string } = {},
): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await createUser(`org-owner-${++orgSeq}@x.com`);
  const orgId = await tx(async (client) => {
    const o = await createOrg(
      { name: opts.name ?? "Acme", ownerUserId: ownerId, createdBy: null, maxMembers: 100 },
      client,
    );
    return o.id;
  });
  await query(`UPDATE orgs SET credits = $1, status = $2 WHERE id = $3::bigint`, [
    credits.toString(),
    opts.status ?? "active",
    orgId,
  ]);
  return { orgId, ownerId };
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

/** 给用户设一个 active 个人期内桶(plan_code='free' 已由 0096 seed)。 */
async function setPeriod(userId: string, periodCredits: bigint): Promise<void> {
  await query(
    `INSERT INTO user_subscriptions(user_id, plan_code, status, period_start, period_end, period_credits)
     VALUES ($1::bigint, 'free', 'active', NOW(), NOW() + INTERVAL '30 days', $2)
     ON CONFLICT (user_id) DO UPDATE SET status='active',
       period_end = NOW() + INTERVAL '30 days', period_credits = EXCLUDED.period_credits`,
    [userId, periodCredits.toString()],
  );
}

/** 直接落一行 org 期内订阅(精确控制 pool/过期,不经 grant)。 */
async function setOrgSub(
  orgId: string,
  opts: { planCode?: string; seats?: number; periodCredits: bigint; expired?: boolean },
): Promise<void> {
  const endExpr = opts.expired ? "NOW() - INTERVAL '1 day'" : "NOW() + INTERVAL '30 days'";
  await query(
    `INSERT INTO org_subscriptions(org_id, plan_code, seats, status, period_start, period_end, period_credits)
     VALUES ($1::bigint, $2, $3, 'active', NOW() - INTERVAL '30 days', ${endExpr}, $4)
     ON CONFLICT (org_id) DO UPDATE SET plan_code=EXCLUDED.plan_code, seats=EXCLUDED.seats,
       status='active', period_end=EXCLUDED.period_end, period_credits=EXCLUDED.period_credits`,
    [orgId, opts.planCode ?? "org-pro", opts.seats ?? 2, opts.periodCredits.toString()],
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
async function personalPeriod(uid: string): Promise<bigint> {
  const r = await query<{ p: string }>(
    `SELECT COALESCE(period_credits,0)::text AS p FROM user_subscriptions WHERE user_id=$1::bigint`,
    [uid],
  );
  return r.rows[0] ? BigInt(r.rows[0].p) : 0n;
}
async function orgPeriod(orgId: string): Promise<bigint> {
  const r = await query<{ p: string }>(
    `SELECT COALESCE(period_credits,0)::text AS p FROM org_subscriptions WHERE org_id=$1::bigint`,
    [orgId],
  );
  return r.rows[0] ? BigInt(r.rows[0].p) : 0n;
}
async function ledgerRows(bucket?: string): Promise<
  Array<{ bucket: string; org_id: string | null; user_id: string; delta: string; balance_after: string; reason: string; memo: string | null }>
> {
  const r = await query<{ bucket: string; org_id: string | null; user_id: string; delta: string; balance_after: string; reason: string; memo: string | null }>(
    `SELECT bucket, org_id::text AS org_id, user_id::text AS user_id, delta::text AS delta,
            balance_after::text AS balance_after, reason, memo
       FROM credit_ledger ${bucket ? "WHERE bucket=$1" : ""} ORDER BY id ASC`,
    bucket ? [bucket] : [],
  );
  return r.rows;
}

// ====================================================================
// spendTwoBucket — 四桶顺序 org_period → org_wallet → period → wallet
// ====================================================================

describe("spendTwoBucket — org 期内池(四桶最优先)顺序 + clamp", () => {
  test("org 期内池够:全额从 org_period 扣,其余桶不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("a@x.com", 500n);
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 500n);
    await setOrgSub(orgId, { periodCredits: 1000n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }));
    assert.equal(r.debited, 300n);
    assert.equal(r.clamped, false);
    assert.equal(r.fromOrgPeriod, 300n);
    assert.equal(r.fromOrg, 0n);
    assert.equal(r.fromPeriod, 0n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(r.orgPeriodAfter, 700n);
    assert.equal(r.orgAfter, 1000n);
    assert.equal(r.periodAfter, 500n);
    assert.equal(r.walletAfter, 500n);
    // DB 落地
    assert.equal(await orgPeriod(orgId), 700n);
    assert.equal(await orgCredits(orgId), 1000n);
    assert.equal(await personalPeriod(uid), 500n);
    assert.equal(await userCredits(uid), 500n);
    // 仅 1 条 org_period 流水,字段完整
    const led = await ledgerRows();
    assert.equal(led.length, 1);
    assert.equal(led[0].bucket, "org_period");
    assert.equal(led[0].org_id, orgId);
    assert.equal(led[0].user_id, uid); // 消费成员经办
    assert.equal(led[0].delta, "-300");
    assert.equal(led[0].balance_after, "700");
    assert.equal(led[0].reason, "chat");
    // org 独付(仅动 org_period)→ 主流水 = org_period 行,回退链垫底仍非 null
    assert.equal(r.ledgerOrgPeriodId !== null && r.ledgerOrgPeriodId > 0n, true);
    assert.equal(r.primaryLedgerId, r.ledgerOrgPeriodId);
    assert.equal(r.ledgerOrgId, null);
    assert.equal(r.ledgerPeriodId, null);
    assert.equal(r.ledgerWalletId, null);
  });

  test("org 期内池不够 → 溢到 org 钱包(org_period → org_wallet)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("b@x.com", 500n);
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member");
    await setOrgSub(orgId, { periodCredits: 100n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }));
    assert.equal(r.fromOrgPeriod, 100n);
    assert.equal(r.fromOrg, 200n);
    assert.equal(r.fromPeriod, 0n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(r.orgPeriodAfter, 0n);
    assert.equal(r.orgAfter, 800n);
    assert.equal(await orgPeriod(orgId), 0n);
    assert.equal(await orgCredits(orgId), 800n);
    const led = await ledgerRows();
    assert.equal(led.length, 2);
    assert.equal(led[0].bucket, "org_period");
    assert.equal(led[1].bucket, "org_wallet");
    // 主流水回退链:org_wallet 优先于 org_period
    assert.equal(r.primaryLedgerId, r.ledgerOrgId);
  });

  test("org 两桶不够 → 溢到个人期内桶(org_period → org_wallet → period)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("c@x.com", 500n);
    const { orgId } = await makeOrg(100n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 500n);
    await setOrgSub(orgId, { periodCredits: 100n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }));
    assert.equal(r.fromOrgPeriod, 100n);
    assert.equal(r.fromOrg, 100n);
    assert.equal(r.fromPeriod, 100n);
    assert.equal(r.fromWallet, 0n);
    assert.equal(await orgPeriod(orgId), 0n);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await personalPeriod(uid), 400n);
    assert.equal(await userCredits(uid), 500n);
    // 主流水回退链:个人 period 优先于 org 两桶
    assert.equal(r.primaryLedgerId, r.ledgerPeriodId);
  });

  test("四桶全部参与 → 溢到个人钱包(org_period → org_wallet → period → wallet)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("d@x.com", 500n);
    const { orgId } = await makeOrg(50n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 50n);
    await setOrgSub(orgId, { periodCredits: 50n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }));
    assert.equal(r.debited, 300n);
    assert.equal(r.clamped, false);
    assert.equal(r.fromOrgPeriod, 50n);
    assert.equal(r.fromOrg, 50n);
    assert.equal(r.fromPeriod, 50n);
    assert.equal(r.fromWallet, 150n);
    assert.equal(await orgPeriod(orgId), 0n);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await personalPeriod(uid), 0n);
    assert.equal(await userCredits(uid), 350n);
    const led = await ledgerRows();
    assert.equal(led.length, 4);
    assert.deepEqual(led.map((l) => l.bucket), ["org_period", "org_wallet", "period", "wallet"]);
    // 个人钱包动了 → 主流水 = wallet 行(个人位次最前)
    assert.equal(r.primaryLedgerId, r.ledgerWalletId);
  });

  test("四桶总额不足 → clamp 到总可用,org_period 行 memo 标 clamped", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("e@x.com", 50n);
    const { orgId } = await makeOrg(50n);
    await addMember(orgId, uid, "member");
    await setPeriod(uid, 50n);
    await setOrgSub(orgId, { periodCredits: 50n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 300n, reason: "chat", orgId }));
    assert.equal(r.debited, 200n);
    assert.equal(r.clamped, true);
    assert.equal(r.fromOrgPeriod, 50n);
    assert.equal(r.fromOrg, 50n);
    assert.equal(r.fromPeriod, 50n);
    assert.equal(r.fromWallet, 50n);
    assert.equal(await orgPeriod(orgId), 0n);
    assert.equal(await orgCredits(orgId), 0n);
    assert.equal(await personalPeriod(uid), 0n);
    assert.equal(await userCredits(uid), 0n);
    const op = await ledgerRows("org_period");
    assert.match(op[0].memo!, /clamped/);
    assert.match(op[0].memo!, /requested=300/);
    assert.match(op[0].memo!, /total=200/);
  });

  test("过期 org 订阅不可花(period_end>NOW() 谓词):org_period 不参与,落 org 钱包", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("f@x.com", 500n);
    const { orgId } = await makeOrg(500n);
    await addMember(orgId, uid, "member");
    await setOrgSub(orgId, { periodCredits: 1000n, expired: true }); // 过期未轮转的大池

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat", orgId }));
    assert.equal(r.fromOrgPeriod, 0n, "过期 org 池不计入");
    assert.equal(r.orgPeriodAfter, 0n, "org 参与但期内池未锁到(过期)→ 0");
    assert.equal(r.fromOrg, 200n, "落 org 钱包");
    assert.equal(await orgPeriod(orgId), 1000n, "过期池原封不动(等 sweeper 清)");
    assert.equal(await orgCredits(orgId), 300n);
    const op = await ledgerRows("org_period");
    assert.equal(op.length, 0, "过期池不产生 org_period 流水");
  });

  test("无 orgId → 纯个人两桶(org 期内池字段全归零/null)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("g@x.com", 500n);
    await setPeriod(uid, 100n);
    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat" }));
    assert.equal(r.fromOrgPeriod, 0n);
    assert.equal(r.orgPeriodAfter, null);
    assert.equal(r.ledgerOrgPeriodId, null);
    assert.equal(r.fromPeriod, 100n);
    assert.equal(r.fromWallet, 100n);
  });

  test("org suspended → fail-open 跳过 org 两桶(含期内池)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("h@x.com", 500n);
    const { orgId } = await makeOrg(1000n, { status: "suspended" });
    await addMember(orgId, uid, "member");
    await setOrgSub(orgId, { periodCredits: 1000n });

    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat", orgId }));
    assert.equal(r.fromOrgPeriod, 0n);
    assert.equal(r.orgPeriodAfter, null, "org 未参与 → null");
    assert.equal(r.orgAfter, null);
    assert.equal(r.fromWallet, 200n);
    assert.equal(await orgPeriod(orgId), 1000n, "suspended org 期内池不动");
    assert.equal(await orgCredits(orgId), 1000n);
  });
});

// ====================================================================
// grantOrgSubscriptionTx — 新开 / 续费
// ====================================================================

describe("grantOrgSubscriptionTx — 新开/续费(池化 seats×每席积分)", () => {
  test("新开:建 org_subscriptions + 发 seats×monthly 入池 + subscription 正流水", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(0n);

    const res = await tx((c) =>
      grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 3, operatorUserId: ownerId, orderRef: "ord-1" }),
    );
    assert.equal(res.seats, 3);
    assert.equal(res.periodCreditsAfter, 30000n); // 3 × 10000

    const sub = await getOrgSubscription(orgId);
    assert.ok(sub);
    assert.equal(sub!.planCode, "org-pro");
    assert.equal(sub!.seats, 3);
    assert.equal(sub!.status, "active");
    assert.equal(sub!.periodCredits, 30000n);
    assert.equal(sub!.periodEnd.getTime() > Date.now(), true);

    const led = await ledgerRows();
    assert.equal(led.length, 1);
    assert.equal(led[0].bucket, "org_period");
    assert.equal(led[0].org_id, orgId);
    assert.equal(led[0].user_id, ownerId); // 经办人=owner
    assert.equal(led[0].delta, "30000");
    assert.equal(led[0].balance_after, "30000");
    assert.equal(led[0].reason, "subscription");
  });

  test("续费(换档):清零旧池 subscription_expire 负流水 + 新池正流水 + period 顺延", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(0n);
    // 先开 org-pro seats=2 → 20000
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));
    const sub1 = await getOrgSubscription(orgId);
    const end1 = sub1!.periodEnd.getTime();

    // 再续 org-max seats=2 → 70000(旧池 20000 先清零)
    const res = await tx((c) =>
      grantOrgSubscriptionTx(c, { orgId, planCode: "org-max", seats: 2, operatorUserId: ownerId, orderRef: "ord-2" }),
    );
    assert.equal(res.periodCreditsAfter, 70000n); // 2 × 35000

    const sub2 = await getOrgSubscription(orgId);
    assert.equal(sub2!.planCode, "org-max");
    assert.equal(sub2!.periodCredits, 70000n);
    assert.equal(sub2!.periodEnd.getTime() >= end1, true, "period 顺延(不早于旧期末)");

    // 流水:grant(+20000) → expire(-20000,balance 0) → grant(+70000)
    const led = await ledgerRows();
    assert.equal(led.length, 3);
    assert.equal(led[0].reason, "subscription");
    assert.equal(led[0].delta, "20000");
    assert.equal(led[1].reason, "subscription_expire");
    assert.equal(led[1].delta, "-20000");
    assert.equal(led[1].balance_after, "0");
    assert.equal(led[1].org_id, orgId);
    assert.equal(led[2].reason, "subscription");
    assert.equal(led[2].delta, "70000");
    assert.equal(led[2].balance_after, "70000");
  });

  test("seats < min_seats → SEAT_BELOW_MIN;非 org 档 → PLAN_NOT_ORG;org 不存在 → NOT_FOUND", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(0n);
    await assert.rejects(
      () => tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 1, operatorUserId: ownerId })),
      (e: unknown) => e instanceof OrgError && e.code === "SEAT_BELOW_MIN",
    );
    await assert.rejects(
      () => tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "pro", seats: 2, operatorUserId: ownerId })),
      (e: unknown) => e instanceof OrgError && e.code === "PLAN_NOT_ORG",
    );
    await assert.rejects(
      () => tx((c) => grantOrgSubscriptionTx(c, { orgId: "999999", planCode: "org-pro", seats: 2, operatorUserId: ownerId })),
      (e: unknown) => e instanceof OrgError && e.code === "NOT_FOUND",
    );
    // 全部拒绝后无 org 订阅、无流水
    assert.equal(await getOrgSubscription(orgId), null);
    assert.equal((await ledgerRows()).length, 0);
  });
});

// ====================================================================
// addOrgSeatsTx — 期中加席即时入池
// ====================================================================

describe("addOrgSeatsTx — 期中加席(整份即时入池,period 不变)", () => {
  test("加席:seats += n,pool += n×monthly,period_end 不变,subscription 正流水注明加席", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(0n);
    await tx((c) => grantOrgSubscriptionTx(c, { orgId, planCode: "org-pro", seats: 2, operatorUserId: ownerId }));
    const before = await getOrgSubscription(orgId);
    const endBefore = before!.periodEnd.getTime();

    const res = await tx((c) =>
      addOrgSeatsTx(c, { orgId, seats: 3, operatorUserId: ownerId, orderRef: "ord-seat" }),
    );
    assert.equal(res.seatsAfter, 5);
    assert.equal(res.periodCreditsAfter, 50000n); // 20000 + 3×10000

    const after = await getOrgSubscription(orgId);
    assert.equal(after!.seats, 5);
    assert.equal(after!.periodCredits, 50000n);
    assert.equal(after!.periodEnd.getTime(), endBefore, "period 不变");

    const led = await ledgerRows();
    // grant(+20000) → add(+30000)
    assert.equal(led.length, 2);
    assert.equal(led[1].reason, "subscription");
    assert.equal(led[1].delta, "30000");
    assert.equal(led[1].balance_after, "50000");
    assert.equal(led[1].org_id, orgId);
    assert.equal(led[1].user_id, ownerId);
    assert.match(led[1].memo!, /add 3 seats/);
  });

  test("过期订阅加席 → ORG_SUBSCRIPTION_INACTIVE;无订阅加席 → NO_ORG_SUBSCRIPTION", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(0n);
    // 无订阅
    await assert.rejects(
      () => tx((c) => addOrgSeatsTx(c, { orgId, seats: 1, operatorUserId: ownerId })),
      (e: unknown) => e instanceof OrgError && e.code === "NO_ORG_SUBSCRIPTION",
    );
    // 过期订阅
    await setOrgSub(orgId, { periodCredits: 5000n, expired: true });
    await assert.rejects(
      () => tx((c) => addOrgSeatsTx(c, { orgId, seats: 1, operatorUserId: ownerId })),
      (e: unknown) => e instanceof OrgError && e.code === "ORG_SUBSCRIPTION_INACTIVE",
    );
    // 过期池未被改动
    assert.equal(await orgPeriod(orgId), 5000n);
  });
});

// ====================================================================
// rolloverExpiredOrgSubscriptions — 到期清零 + expired
// ====================================================================

describe("rolloverExpiredOrgSubscriptions — 清零池 + expired,不动钱包/成员", () => {
  test("过期订阅:清零池 subscription_expire 负流水 + status=expired + org 钱包不动", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId, ownerId } = await makeOrg(5000n);
    await setOrgSub(orgId, { periodCredits: 20000n, expired: true });

    const processed = await rolloverExpiredOrgSubscriptions(200);
    assert.deepEqual(processed, [BigInt(orgId)]);

    const sub = await getOrgSubscription(orgId);
    assert.equal(sub!.status, "expired");
    assert.equal(sub!.periodCredits, 0n);
    assert.equal(await orgCredits(orgId), 5000n, "org 钱包(orgs.credits)不动");
    // 成员不踢:owner membership 仍在
    const m = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM org_memberships WHERE org_id=$1::bigint AND status='active'`,
      [orgId],
    );
    assert.equal(m.rows[0].c, "1");

    const led = await ledgerRows("org_period");
    assert.equal(led.length, 1);
    assert.equal(led[0].reason, "subscription_expire");
    assert.equal(led[0].delta, "-20000");
    assert.equal(led[0].balance_after, "0");
    assert.equal(led[0].org_id, orgId);
    assert.equal(led[0].user_id, ownerId); // 经办人=owner
  });

  test("active(未过期)订阅不被认领", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId } = await makeOrg(0n);
    await setOrgSub(orgId, { periodCredits: 10000n }); // 未过期

    const processed = await rolloverExpiredOrgSubscriptions(200);
    assert.deepEqual(processed, []);
    const sub = await getOrgSubscription(orgId);
    assert.equal(sub!.status, "active");
    assert.equal(sub!.periodCredits, 10000n);
    assert.equal((await ledgerRows()).length, 0);
  });

  test("空池过期订阅:无流水但仍 expired", async (t) => {
    if (skipIfNoPg(t)) return;
    const { orgId } = await makeOrg(0n);
    await setOrgSub(orgId, { periodCredits: 0n, expired: true });

    const processed = await rolloverExpiredOrgSubscriptions(200);
    assert.deepEqual(processed, [BigInt(orgId)]);
    const sub = await getOrgSubscription(orgId);
    assert.equal(sub!.status, "expired");
    assert.equal((await ledgerRows()).length, 0, "空池不写流水");
  });
});

// ====================================================================
// getOrgSpendableForUser — 预检口径含 org 期内池
// ====================================================================

describe("getOrgSpendableForUser — 预检含 org 期内池(与扣费参与条件成对)", () => {
  test("active 成员 billing_enabled:org 钱包 + org 期内池", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p1@x.com");
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member", true);
    await setOrgSub(orgId, { periodCredits: 5000n });
    assert.equal(await getOrgSpendableForUser(uid), 6000n); // 1000 + 5000
  });

  test("过期 org 订阅:只算 org 钱包(池被 period_end>NOW() 排除)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p2@x.com");
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member", true);
    await setOrgSub(orgId, { periodCredits: 5000n, expired: true });
    assert.equal(await getOrgSpendableForUser(uid), 1000n);
  });

  test("billing_enabled=false → 0(org 桶不参与该成员)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p3@x.com");
    const { orgId } = await makeOrg(1000n);
    await addMember(orgId, uid, "member", false);
    await setOrgSub(orgId, { periodCredits: 5000n });
    assert.equal(await getOrgSpendableForUser(uid), 0n);
  });

  test("org suspended → 0", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("p4@x.com");
    const { orgId } = await makeOrg(1000n, { status: "suspended" });
    await addMember(orgId, uid, "member", true);
    await setOrgSub(orgId, { periodCredits: 5000n });
    assert.equal(await getOrgSpendableForUser(uid), 0n);
  });
});

// ====================================================================
// org 档 plans 分区 + credit_ledger org_period 完整性 CHECK
// ====================================================================

describe("org plans 分区 + org_period 完整性 CHECK", () => {
  test("listOrgSubscriptionPlans 只列 scope='org' 三档;getOrgPlan 拒个人档", async (t) => {
    if (skipIfNoPg(t)) return;
    const plans = await listOrgSubscriptionPlans();
    const codes = plans.map((p) => p.code).sort();
    assert.deepEqual(codes, ["org-max", "org-pro", "org-ultra"]);
    const pro = await getOrgPlan("org-pro");
    assert.equal(pro!.monthlyCredits, 10000n);
    assert.equal(pro!.minSeats, 2);
    assert.equal(pro!.priceCents, 8800n); // 0117 与个人版对齐
    // 个人档不被当 org 档
    assert.equal(await getOrgPlan("pro"), null);
    assert.equal(await getOrgPlan("free"), null);
  });

  test("credit_ledger bucket='org_period' 缺 org_id → CHECK 拒绝(ck_cl_org_wallet_has_org)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("ck@x.com");
    await assert.rejects(
      () =>
        query(
          `INSERT INTO credit_ledger(user_id, delta, balance_after, reason, bucket, org_id)
           VALUES ($1::bigint, -1, 0, 'subscription', 'org_period', NULL)`,
          [uid],
        ),
      (e: any) => /ck_cl_org_wallet_has_org|check constraint/i.test(String(e.message)),
    );
  });
});
