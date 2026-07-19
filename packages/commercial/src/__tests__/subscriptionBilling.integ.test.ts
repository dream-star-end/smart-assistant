/**
 * 0096 集成：双钱包扣费 + 月度订阅履约/升档/轮转，在真 PG 上验证。
 *
 * 覆盖钱安全核心：
 *   1. ensureFreeSubscription — bootstrap free 行 + 期内桶发放 300 + ledger
 *   2. spendTwoBucket — 先扣期内桶后扣钱包；clamp 到总可用；不误删钱包
 *   3. subscription 履约 — 期内桶重置为档额度 + 周期顺延；钱包不动
 *   4. upgrade — 期内桶补到新档额度 + 周期不变
 *   5. pack — 进期内桶
 *   6. rollover — 付费到期降级 free + 期内桶重置 300；钱包不动
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { spendTwoBucket, getBalanceBreakdown } from "../billing/spend.js";
import {
  ensureFreeSubscription,
  getUserSubscription,
  rolloverExpiredSubscriptions,
} from "../billing/subscription.js";
import { createSubscriptionOrder, createPackOrder, markOrderPaid } from "../payment/orders.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

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
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    // 门禁审计批F 根治:teardown 不再掀 schema/迁移账本——结束时必须留全量迁移稳定态给后继文件(公民守则见 helpers/db.ts)
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE orders, credit_ledger, user_subscriptions, users RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

/** 建一个用户，初始钱包 credits。返回 user id 字符串。 */
async function mkUser(walletCredits: bigint): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, credits)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`u${Math.random().toString(36).slice(2)}@t.local`, walletCredits.toString()],
  );
  return r.rows[0].id;
}

async function periodCredits(uid: string): Promise<bigint> {
  const s = await getUserSubscription(uid);
  return s ? s.periodCredits : 0n;
}

describe("0096 双钱包 + 订阅计费 (integ)", () => {
  test("ensureFreeSubscription bootstrap free 300 + 幂等", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    await ensureFreeSubscription(uid);
    let sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "free");
    assert.equal(sub?.periodCredits.toString(), "300");
    // 幂等：再次 ensure 不重复发放
    await ensureFreeSubscription(uid);
    sub = await getUserSubscription(uid);
    assert.equal(sub?.periodCredits.toString(), "300");
    const bal = await getBalanceBreakdown(uid);
    assert.equal(bal.wallet.toString(), "0");
    assert.equal(bal.period.toString(), "300");
    assert.equal(bal.total.toString(), "300");
  });

  test("spendTwoBucket 先扣期内桶后扣钱包，不误删钱包", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(1000n); // 钱包 1000
    await ensureFreeSubscription(uid); // 期内桶 300
    // 扣 200 → 全走期内桶
    let r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 200n, reason: "chat" }));
    assert.equal(r.fromPeriod.toString(), "200");
    assert.equal(r.fromWallet.toString(), "0");
    assert.equal((await periodCredits(uid)).toString(), "100");
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "1000"); // 钱包没动
    // 扣 250 → 期内桶 100 + 钱包 150
    r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 250n, reason: "chat" }));
    assert.equal(r.fromPeriod.toString(), "100");
    assert.equal(r.fromWallet.toString(), "150");
    assert.equal((await periodCredits(uid)).toString(), "0");
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "850");
    // 扣 5000（超总额 850）→ clamp 到 850
    r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 5000n, reason: "chat" }));
    assert.equal(r.clamped, true);
    assert.equal(r.debited.toString(), "850");
    assert.equal((await getBalanceBreakdown(uid)).total.toString(), "0");
  });

  test("subscription 履约：期内桶重置为档额度 + 周期顺延；钱包不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(500n);
    await ensureFreeSubscription(uid); // free 300
    const order = await createSubscriptionOrder({
      userId: uid, kind: "subscription", planCode: "pro", amountCents: 8800n, credits: 10000n,
    });
    const res = await markOrderPaid({ orderNo: order.order_no, callbackPayload: {} });
    assert.equal(res.newlyPaid, true);
    const sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "pro");
    assert.equal(sub?.periodCredits.toString(), "10000"); // 重置(旧 300 清零，发 10000)
    assert.ok(sub!.periodEnd.getTime() > Date.now() + 25 * 86400_000); // ~30 天
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "500"); // 钱包不动
  });

  test("upgrade：期内桶补到新档额度 + 周期不变", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    await ensureFreeSubscription(uid);
    // 先订阅 pro
    const o1 = await createSubscriptionOrder({ userId: uid, kind: "subscription", planCode: "pro", amountCents: 8800n, credits: 10000n });
    await markOrderPaid({ orderNo: o1.order_no, callbackPayload: {} });
    // 消耗一些期内桶
    await tx((c) => spendTwoBucket(c, { userId: uid, amount: 7000n, reason: "chat" }));
    const before = await getUserSubscription(uid);
    assert.equal(before?.periodCredits.toString(), "3000");
    const endBefore = before!.periodEnd.getTime();
    // 升档 max（补差价 amountCents = 29800-8800=21000；credits=35000；源档 pro）
    const o2 = await createSubscriptionOrder({ userId: uid, kind: "upgrade", planCode: "max", fromPlanCode: "pro", amountCents: 21000n, credits: 35000n });
    await markOrderPaid({ orderNo: o2.order_no, callbackPayload: {} });
    const after = await getUserSubscription(uid);
    assert.equal(after?.planCode, "max");
    assert.equal(after?.periodCredits.toString(), "35000"); // 补到新档额度
    assert.equal(after!.periodEnd.getTime(), endBefore); // 周期不变
  });

  test("pack 加量包：进期内桶", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    await ensureFreeSubscription(uid); // free 300
    const { order } = await createPackOrder({ userId: uid });
    assert.equal(order.kind, "pack");
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: {} });
    assert.equal((await periodCredits(uid)).toString(), "5300"); // 300 + 5000
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "0"); // 钱包不动
  });

  test("过期期内桶不可消费/不计入余额（sweeper 跑前的窗口）", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(100n); // 钱包 100
    await ensureFreeSubscription(uid); // 期内桶 300
    // 人为把订阅拨到过期（active 但 period_end < now）
    await query("UPDATE user_subscriptions SET period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1", [uid]);
    // 余额只算钱包 100（过期期内桶 300 不计）
    assert.equal((await getBalanceBreakdown(uid)).total.toString(), "100");
    // 扣 250：过期期内桶不可用 → clamp 到钱包 100
    const r = await tx((c) => spendTwoBucket(c, { userId: uid, amount: 250n, reason: "chat" }));
    assert.equal(r.fromPeriod.toString(), "0");
    assert.equal(r.debited.toString(), "100");
    assert.equal(r.clamped, true);
  });

  test("stale 升档：到期降级后再支付差价单 → 实付退回钱包，不白嫖高档", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    await ensureFreeSubscription(uid);
    const o1 = await createSubscriptionOrder({ userId: uid, kind: "subscription", planCode: "pro", amountCents: 8800n, credits: 10000n });
    await markOrderPaid({ orderNo: o1.order_no, callbackPayload: {} });
    // 创建 pro→max 升档差价单（pending，源档 pro）
    const o2 = await createSubscriptionOrder({ userId: uid, kind: "upgrade", planCode: "max", fromPlanCode: "pro", amountCents: 21000n, credits: 35000n });
    // 订阅到期 → rollover 降级 free
    await query("UPDATE user_subscriptions SET period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1", [uid]);
    await rolloverExpiredSubscriptions(100);
    assert.equal((await getUserSubscription(uid))?.planCode, "free");
    // 现在才支付那张升档单 → 应退款入钱包，订阅保持 free（不变 max）
    await markOrderPaid({ orderNo: o2.order_no, callbackPayload: {} });
    const sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "free"); // 没被 stale 升档买成 max
    assert.equal(sub?.periodCredits.toString(), "300");
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "21000"); // 实付差价退回钱包
  });

  test("stale 升档(源档不匹配)：Max 期下 Max→Ultra 单，换成 Pro 后支付 → 退款，不把 Pro 升 Ultra", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    await ensureFreeSubscription(uid);
    // 先订 Max
    const oMax = await createSubscriptionOrder({ userId: uid, kind: "subscription", planCode: "max", amountCents: 29800n, credits: 35000n });
    await markOrderPaid({ orderNo: oMax.order_no, callbackPayload: {} });
    // 在 Max 期创建 Max→Ultra 升档单（差价 49800-29800=20000）
    const oUp = await createSubscriptionOrder({ userId: uid, kind: "upgrade", planCode: "ultra", fromPlanCode: "max", amountCents: 20000n, credits: 60000n });
    // 用户改买 Pro（当前订阅变 pro，tier 1，仍 < ultra(3)，但源档已不是 max）
    const oPro = await createSubscriptionOrder({ userId: uid, kind: "subscription", planCode: "pro", amountCents: 8800n, credits: 10000n });
    await markOrderPaid({ orderNo: oPro.order_no, callbackPayload: {} });
    assert.equal((await getUserSubscription(uid))?.planCode, "pro");
    // 现在支付那张 Max→Ultra 升档单：源档 max != 当前 pro → 必须退款，不升 ultra
    await markOrderPaid({ orderNo: oUp.order_no, callbackPayload: {} });
    const sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "pro"); // 没被低价升成 ultra
    assert.equal(sub?.periodCredits.toString(), "10000");
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "20000"); // 差价退回钱包
  });

  test("pack 无有效周期 → 就地新开 free 周期再加，绝不落进永久钱包", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(0n);
    // 不 ensureFree：用户完全无订阅行
    const { order } = await createPackOrder({ userId: uid });
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: {} });
    const sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "free"); // 就地新开 free 周期
    assert.equal(sub?.periodCredits.toString(), "5300"); // free 300 + pack 5000，全在期内桶
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "0"); // 钱包没收到 pack
  });

  test("rollover：付费到期降级 free 300，钱包不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await mkUser(700n);
    await ensureFreeSubscription(uid);
    const o = await createSubscriptionOrder({ userId: uid, kind: "subscription", planCode: "max", amountCents: 29800n, credits: 35000n });
    await markOrderPaid({ orderNo: o.order_no, callbackPayload: {} });
    // 人为把 period_end 拨到过去
    await query("UPDATE user_subscriptions SET period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1", [uid]);
    const ids = await rolloverExpiredSubscriptions(100);
    assert.equal(ids.map((x) => x.toString()).includes(uid), true);
    const sub = await getUserSubscription(uid);
    assert.equal(sub?.planCode, "free");
    assert.equal(sub?.periodCredits.toString(), "300"); // 重置 free 300（旧 35000 清零）
    assert.ok(sub!.periodEnd.getTime() > Date.now() + 25 * 86400_000);
    assert.equal((await getBalanceBreakdown(uid)).wallet.toString(), "700"); // 钱包不动
  });
});
