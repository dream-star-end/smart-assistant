/**
 * T-24 集成:orders 模块在真 PG 上的行为。
 *
 * 覆盖:
 *   1. listPlans / getPlanByCode — 种子数据可读
 *   2. createPendingOrder — INSERT pending + expires_at = now+15min
 *   3. createPendingOrder 传入 disabled plan → PlanNotFoundError
 *   4. markOrderPaid 首次 — status→paid + credit + ledger(reason=topup) + users.credits 增加
 *   5. markOrderPaid 重放 — 幂等,不重复加积分
 *   6. markOrderPaid 对 expired 订单 — InvalidOrderStateError
 *   7. expirePendingOrders — 过期订单一次性推到 expired
 *   8. 并发 markOrderPaid(同一订单 2 次)— 只加一次积分(行锁)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  listPlans,
  getPlanByCode,
  createPendingOrder,
  markOrderPaid,
  getOrderByNo,
  expirePendingOrders,
  PlanNotFoundError,
  InvalidOrderStateError,
} from "../payment/orders.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

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
  await query("TRUNCATE TABLE orders, credit_ledger, users RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

async function makeUser(email: string, credits = 0n): Promise<string> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, email_verified, status) VALUES($1,'argon2$stub',$2, true, 'active') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  return r.rows[0].id;
}

describe("plans", () => {
  test("listPlans 种子 4 档,按 sort_order DESC", async (t) => {
    if (skipIfNoDb(t)) return;
    const plans = await listPlans();
    assert.ok(plans.length >= 4, `expected >=4 plans, got ${plans.length}`);
    // sort_order DESC → 100 先于 70。第一条应是 plan-10(sort=100)
    assert.equal(plans[0].code, "plan-10");
    assert.equal(plans[0].amount_cents, 1000n);
    assert.equal(plans[0].credits, 1000n);
  });

  test("getPlanByCode 命中 / 不存在", async (t) => {
    if (skipIfNoDb(t)) return;
    const p = await getPlanByCode("plan-50");
    assert.ok(p);
    assert.equal(p.credits, 5500n);
    assert.equal(await getPlanByCode("nonexistent"), null);
  });
});

describe("createPendingOrder", () => {
  test("INSERT pending + expires_at ≈ now + 15min + credits/amount 来自 plan", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("order-create@example.com");
    const fixedNow = new Date("2026-04-17T12:00:00Z");
    const { order, plan } = await createPendingOrder({
      userId: uid,
      planCode: "plan-50",
      nowFn: () => fixedNow,
    });
    assert.equal(order.status, "pending");
    assert.equal(order.amount_cents, 5000n);
    assert.equal(order.credits, 5500n);
    assert.equal(plan.code, "plan-50");
    // 15min default
    const diff = order.expires_at.getTime() - fixedNow.getTime();
    assert.equal(diff, 15 * 60 * 1000);
  });

  test("PLAN 未启用 → PlanNotFoundError", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("disabled-plan@example.com");
    // 把 plan-10 临时 disable
    await query("UPDATE topup_plans SET enabled = FALSE WHERE code = 'plan-10'");
    try {
      await assert.rejects(
        createPendingOrder({ userId: uid, planCode: "plan-10" }),
        (err: unknown) => err instanceof PlanNotFoundError,
      );
    } finally {
      await query("UPDATE topup_plans SET enabled = TRUE WHERE code = 'plan-10'");
    }
  });
});

describe("markOrderPaid", () => {
  test("首次回调:pending → paid + credit + ledger(topup) + users.credits 增加", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("pay-ok@example.com", 100n);
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    const r = await markOrderPaid({
      orderNo: order.order_no,
      providerOrder: "WX_TX_1",
      callbackPayload: { status: "OD", total_fee: "10.00" },
    });
    assert.equal(r.newlyPaid, true);
    assert.equal(r.order.status, "paid");
    assert.ok(r.order.paid_at, "paid_at should be set");
    assert.equal(r.order.provider_order, "WX_TX_1");
    assert.ok(r.ledgerId);

    // users.credits += plan.credits(1000)
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "1100");

    // ledger 一行 delta=+1000 reason=topup ref=order:order_id
    const l = await query<{
      delta: string; reason: string; ref_type: string; ref_id: string;
    }>(
      "SELECT delta::text AS delta, reason, ref_type, ref_id FROM credit_ledger WHERE user_id=$1",
      [uid],
    );
    assert.equal(l.rows.length, 1);
    assert.equal(l.rows[0].delta, "1000");
    assert.equal(l.rows[0].reason, "topup");
    assert.equal(l.rows[0].ref_type, "order");
    assert.equal(l.rows[0].ref_id, r.order.id.toString());

    // orders.ledger_id 指向该 ledger
    const saved = await getOrderByNo(order.order_no);
    assert.equal(saved?.ledger_id, r.ledgerId);
    // callback_payload 留证
    const cb = await query<{ payload: Record<string, unknown> }>(
      "SELECT callback_payload AS payload FROM orders WHERE order_no=$1", [order.order_no],
    );
    assert.equal((cb.rows[0].payload as Record<string, unknown>).status, "OD");
  });

  test("幂等回调:再调一次不重复加积分,newlyPaid=false", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("pay-idempotent@example.com", 0n);
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    const r1 = await markOrderPaid({
      orderNo: order.order_no, providerOrder: "TX_1", callbackPayload: { status: "OD" },
    });
    const r2 = await markOrderPaid({
      orderNo: order.order_no, providerOrder: "TX_1", callbackPayload: { status: "OD", dup: true },
    });
    assert.equal(r1.newlyPaid, true);
    assert.equal(r2.newlyPaid, false);
    assert.equal(r2.ledgerId, r1.ledgerId); // 返已存在的 ledger_id

    // users.credits 只增加一次
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "1000");
    const cnt = await query<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid],
    );
    assert.equal(cnt.rows[0].cnt, "1");
  });

  test("expired 订单收到回调:InvalidOrderStateError,不扣不加", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("pay-expired@example.com", 0n);
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    // 手动把订单推到 expired
    await query("UPDATE orders SET status='expired' WHERE id=$1", [order.id.toString()]);
    await assert.rejects(
      markOrderPaid({ orderNo: order.order_no, callbackPayload: { status: "OD" } }),
      (err: unknown) => err instanceof InvalidOrderStateError && (err as InvalidOrderStateError).currentStatus === "expired",
    );
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "0");
  });

  test("并发同单 2 次:只加一次积分(行锁)", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("pay-race@example.com", 0n);
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    const results = await Promise.all([
      markOrderPaid({ orderNo: order.order_no, callbackPayload: { i: 1 } }),
      markOrderPaid({ orderNo: order.order_no, callbackPayload: { i: 2 } }),
    ]);
    const firsts = results.filter((r) => r.newlyPaid);
    assert.equal(firsts.length, 1, "exactly 1 should be newlyPaid");
    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1", [uid],
    );
    assert.equal(u.rows[0].credits, "1000");
  });
});

describe("expirePendingOrders", () => {
  test("pending 且 expires_at<now → expired;已 paid 不动", async (t) => {
    if (skipIfNoDb(t)) return;
    const uid = await makeUser("exp-user@example.com");
    // 造一个立即过期的 pending
    const { order: expSoon } = await createPendingOrder({
      userId: uid, planCode: "plan-10",
      nowFn: () => new Date(Date.now() - 30 * 60 * 1000), // 30min 前的"现在",ttl 15min → expires_at 是 15min 前
    });
    // 另一个未来到期的 pending
    const { order: future } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    // 已 paid 的订单(造一个 pending 然后 markPaid)
    const { order: paid } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    await markOrderPaid({ orderNo: paid.order_no, callbackPayload: { ok: 1 } });

    const affected = await expirePendingOrders();
    assert.ok(affected >= 1);

    const sexp = await getOrderByNo(expSoon.order_no);
    const sfut = await getOrderByNo(future.order_no);
    const spaid = await getOrderByNo(paid.order_no);
    assert.equal(sexp?.status, "expired");
    assert.equal(sfut?.status, "pending");
    assert.equal(spaid?.status, "paid");
  });
});
