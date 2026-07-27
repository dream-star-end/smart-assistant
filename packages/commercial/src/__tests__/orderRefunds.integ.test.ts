import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  closePool,
  createPool,
  resetPool,
  setPoolOverride,
} from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import {
  createOrgTopupOrder,
  createPendingOrder,
  markOrderPaid,
} from "../payment/orders.js";
import {
  applyProviderRefundStatus,
  OrderRefundError,
  reserveOrderRefund,
} from "../payment/refunds.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_DB = "openclaude_order_refund_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

function withDb(url: string, db: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

const TEST_URL = withDb(BASE_URL, TEST_DB);
let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const client = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

before(async () => {
  try {
    await adminExec("SELECT 1");
    pgAvailable = true;
  } catch {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}' AND pid<>pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await adminExec(`CREATE DATABASE ${TEST_DB} TEMPLATE template0`);
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_URL, max: 8 }));
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  await closePool();
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB}' AND pid<>pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => {});
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE TABLE orders, credit_ledger, org_memberships, orgs,
       user_subscriptions, users, admin_audit RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (pgAvailable) return false;
  t.skip("pg not running");
  return true;
}

async function createUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled)
     VALUES ($1, 'argon2$stub', $2, 'active', TRUE, TRUE)
     RETURNING id::text AS id`,
    [email, role],
  );
  return r.rows[0].id;
}

function providerResult(orderNo: string, status: "OD" | "CD" | "RD" | "UD") {
  return {
    orderNo,
    status,
    providerRefundNo: "RF-1",
    refundAmountCents: 1000n,
    safePayload: {
      trade_order_id: orderNo,
      refund_status: status,
      out_refund_no: "RF-1",
    },
  };
}

describe("order refunds", () => {
  test("个人 topup：原桶 hold + 单调状态 + CD 原子完成 + completion audit 幂等", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("refund-user@example.com");
    const adminId = await createUser("refund-admin@example.com", "admin");
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: { status: "OD" } });

    const held = await reserveOrderRefund({
      orderNo: order.order_no,
      reason: "用户申请退款",
      adminId,
    });
    assert.equal(held.creditsHeld, 1000n);
    const userAfterHold = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id=$1",
      [uid],
    );
    assert.equal(userAfterHold.rows[0].credits, "0");
    const hold = await query<{ delta: string; bucket: string; reason: string }>(
      `SELECT delta::text AS delta, bucket, reason
         FROM credit_ledger
        WHERE reason='refund' AND ref_type='order'`,
    );
    assert.deepEqual(hold.rows[0], { delta: "-1000", bucket: "wallet", reason: "refund" });

    assert.equal(
      (await applyProviderRefundStatus(providerResult(order.order_no, "RD"))).state,
      "channel_pending",
    );
    assert.equal(
      (await applyProviderRefundStatus(providerResult(order.order_no, "UD"))).state,
      "failed_review",
    );
    assert.equal(
      (await applyProviderRefundStatus(providerResult(order.order_no, "RD"))).state,
      "failed_review",
      "late RD must not downgrade failed_review",
    );
    assert.equal(
      (await applyProviderRefundStatus(providerResult(order.order_no, "CD"))).outcome,
      "completed",
    );
    assert.equal(
      (await applyProviderRefundStatus(providerResult(order.order_no, "UD"))).outcome,
      "already_completed",
      "completed is absorbing",
    );

    const saved = await query<{
      status: string;
      refund_state: string;
      same_ledger: boolean;
    }>(
      `SELECT status, refund_state,
              refunded_ledger_id = refund_hold_ledger_id AS same_ledger
         FROM orders WHERE order_no=$1`,
      [order.order_no],
    );
    assert.deepEqual(saved.rows[0], {
      status: "refunded",
      refund_state: "completed",
      same_ledger: true,
    });
    const audits = await query<{ action: string; n: string }>(
      `SELECT action, COUNT(*)::text AS n
         FROM admin_audit
        WHERE target=$1
        GROUP BY action
        ORDER BY action`,
      [`order:${order.order_no}`],
    );
    assert.deepEqual(audits.rows, [
      { action: "order.refund.complete", n: "1" },
      { action: "order.refund.request", n: "1" },
    ]);
  });

  test("余额不足与非 topup 均在外呼前诚实拒绝且不写退款流水", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("refund-blocked@example.com");
    const adminId = await createUser("refund-admin2@example.com", "admin");
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: { status: "OD" } });
    await query("UPDATE users SET credits=999 WHERE id=$1", [uid]);
    await assert.rejects(
      reserveOrderRefund({ orderNo: order.order_no, reason: "退款", adminId }),
      (err: unknown) =>
        err instanceof OrderRefundError && err.code === "ORDER_REFUND_BALANCE_INSUFFICIENT",
    );

    const manual = await query<{ order_no: string }>(
      `INSERT INTO orders
        (order_no,user_id,provider,amount_cents,credits,status,kind,plan_code,paid_at,expires_at)
       VALUES ('SUB-MANUAL-1',$1,'hupijiao',8800,10000,'paid','subscription','pro',NOW(),NOW())
       RETURNING order_no`,
      [uid],
    );
    await assert.rejects(
      reserveOrderRefund({ orderNo: manual.rows[0].order_no, reason: "退款", adminId }),
      (err: unknown) =>
        err instanceof OrderRefundError
        && err.code === "ORDER_REFUND_REQUIRES_MANUAL_REVIEW",
    );
    const refundRows = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM credit_ledger WHERE reason='refund'",
    );
    assert.equal(refundRows.rows[0].n, "0");
  });

  test("org topup：从原 org_wallet 冻结，不误扣经办人个人钱包", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("refund-org-owner@example.com");
    const adminId = await createUser("refund-org-admin@example.com", "admin");
    const org = await query<{ id: string }>(
      `INSERT INTO orgs(name,credits,created_by)
       VALUES ('Refund Org',100,$1)
       RETURNING id::text AS id`,
      [uid],
    );
    const order = await createOrgTopupOrder({
      orgId: org.rows[0].id,
      operatorUserId: uid,
      amountCents: 5000n,
    });
    await markOrderPaid({
      orderNo: order.order_no,
      expectedAmountCents: 5000n,
      callbackPayload: { status: "OD" },
    });
    await reserveOrderRefund({
      orderNo: order.order_no,
      reason: "企业退款",
      adminId,
    });

    const balances = await query<{ org_credits: string; user_credits: string }>(
      `SELECT o.credits::text AS org_credits, u.credits::text AS user_credits
         FROM orgs o CROSS JOIN users u
        WHERE o.id=$1 AND u.id=$2`,
      [org.rows[0].id, uid],
    );
    assert.deepEqual(balances.rows[0], { org_credits: "100", user_credits: "0" });
    const hold = await query<{ delta: string; bucket: string; org_id: string }>(
      `SELECT delta::text AS delta, bucket, org_id::text AS org_id
         FROM credit_ledger
        WHERE reason='refund'`,
    );
    assert.deepEqual(hold.rows[0], {
      delta: "-5000",
      bucket: "org_wallet",
      org_id: org.rows[0].id,
    });
  });

  test("admin_audit 写失败时 hold、余额与订单状态同事务回滚", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("refund-audit-user@example.com");
    const adminId = await createUser("refund-audit-admin@example.com", "admin");
    const { order } = await createPendingOrder({ userId: uid, planCode: "plan-10" });
    await markOrderPaid({ orderNo: order.order_no, callbackPayload: { status: "OD" } });
    await query(`
      CREATE OR REPLACE FUNCTION reject_refund_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'order.refund.request' THEN
          RAISE EXCEPTION 'fixture audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await query(`
      CREATE TRIGGER reject_refund_audit_trigger
      BEFORE INSERT ON admin_audit
      FOR EACH ROW EXECUTE FUNCTION reject_refund_audit()
    `);
    try {
      await assert.rejects(
        reserveOrderRefund({ orderNo: order.order_no, reason: "退款", adminId }),
        /fixture audit failure/,
      );
    } finally {
      await query("DROP TRIGGER reject_refund_audit_trigger ON admin_audit");
      await query("DROP FUNCTION reject_refund_audit()");
    }

    const state = await query<{
      credits: string;
      refund_state: string | null;
      refunds: string;
    }>(
      `SELECT u.credits::text AS credits,
              o.refund_state,
              (SELECT COUNT(*)::text FROM credit_ledger WHERE reason='refund') AS refunds
         FROM users u
         JOIN orders o ON o.user_id=u.id
        WHERE o.order_no=$1`,
      [order.order_no],
    );
    assert.deepEqual(state.rows[0], {
      credits: "1000",
      refund_state: null,
      refunds: "0",
    });
  });
});
