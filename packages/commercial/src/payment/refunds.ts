/**
 * Admin-initiated, one-shot Hupijiao full refunds.
 *
 * Only wallet top-ups are automated because their paid entitlement is one
 * immutable positive ledger row whose bucket and owner can be proved. Pack,
 * subscription, upgrade and org-provision orders do not persist enough
 * pre-fulfilment state to restore them without guessing, so they remain a
 * truthful manual-review path.
 *
 * Money safety:
 *   orders FOR UPDATE -> orgs/users FOR UPDATE -> append-only negative hold
 *   -> order refund request + admin_audit, all in one transaction.
 *
 * The provider has no documented caller idempotency key. We therefore send at
 * most one refund POST per order. Every non-CD outcome keeps the hold in place
 * for channel review; only a signed, order-matched CD completes the refund.
 */

import type { PoolClient } from "pg";
import { writeAdminAudit } from "../admin/audit.js";
import { tx } from "../db/queries.js";
import type {
  HupijiaoRefundStatus,
  RefundResult as HupijiaoRefundResult,
} from "./hupijiao/client.js";

export const ORDER_REFUND_STATES = [
  "requested",
  "channel_pending",
  "failed_review",
  "completed",
] as const;
export type OrderRefundState = (typeof ORDER_REFUND_STATES)[number];

type RefundBucket = "wallet" | "org_wallet";

interface RefundOrderDbRow {
  id: string;
  order_no: string;
  user_id: string;
  org_id: string | null;
  kind: string;
  status: string;
  amount_cents: string;
  credits: string;
  ledger_id: string | null;
  refunded_ledger_id: string | null;
  refund_state: OrderRefundState | null;
  refund_reason: string | null;
  refund_requested_by: string | null;
  refund_hold_ledger_id: string | null;
  provider_refund_no: string | null;
}

interface OriginalLedgerRow {
  id: string;
  user_id: string;
  org_id: string | null;
  delta: string;
  bucket: string;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
}

const REFUND_ORDER_COLS = `
  id::text AS id,
  order_no,
  user_id::text AS user_id,
  org_id::text AS org_id,
  kind,
  status,
  amount_cents::text AS amount_cents,
  credits::text AS credits,
  ledger_id::text AS ledger_id,
  refunded_ledger_id::text AS refunded_ledger_id,
  refund_state,
  refund_reason,
  refund_requested_by::text AS refund_requested_by,
  refund_hold_ledger_id::text AS refund_hold_ledger_id,
  provider_refund_no
`;

export type OrderRefundErrorCode =
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PAID"
  | "ORDER_REFUND_REQUIRES_MANUAL_REVIEW"
  | "ORDER_REFUND_ALREADY_REQUESTED"
  | "ORDER_REFUND_LEDGER_INVALID"
  | "ORDER_REFUND_BALANCE_INSUFFICIENT";

export class OrderRefundError extends Error {
  readonly code: OrderRefundErrorCode;
  readonly currentState?: string;

  constructor(code: OrderRefundErrorCode, message: string, currentState?: string) {
    super(message);
    this.name = "OrderRefundError";
    this.code = code;
    this.currentState = currentState;
  }
}

export class OrderRefundProviderMismatchError extends Error {
  readonly orderNo: string;
  readonly expectedAmountCents: bigint;
  readonly receivedAmountCents: bigint | null;

  constructor(orderNo: string, expected: bigint, received: bigint | null) {
    super(
      `refund amount mismatch for ${orderNo}: expected=${expected} received=${received ?? "<missing>"}`,
    );
    this.name = "OrderRefundProviderMismatchError";
    this.orderNo = orderNo;
    this.expectedAmountCents = expected;
    this.receivedAmountCents = received;
  }
}

export interface ReserveOrderRefundInput {
  orderNo: string;
  reason: string;
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ReservedOrderRefund {
  orderNo: string;
  amountCents: bigint;
  creditsHeld: bigint;
  bucket: RefundBucket;
  state: "requested";
}

async function selectOrderForUpdate(
  client: PoolClient,
  orderNo: string,
): Promise<RefundOrderDbRow | null> {
  const r = await client.query<RefundOrderDbRow>(
    `SELECT ${REFUND_ORDER_COLS}
       FROM orders
      WHERE order_no = $1
      FOR UPDATE`,
    [orderNo],
  );
  return r.rows[0] ?? null;
}

function assertRefundableOrder(order: RefundOrderDbRow): void {
  if (order.status !== "paid") {
    throw new OrderRefundError(
      "ORDER_NOT_PAID",
      `order ${order.order_no} is ${order.status}, expected paid`,
      order.status,
    );
  }
  if (order.refund_state !== null || order.refunded_ledger_id !== null) {
    throw new OrderRefundError(
      "ORDER_REFUND_ALREADY_REQUESTED",
      `order ${order.order_no} already has refund state ${order.refund_state ?? "legacy"}`,
      order.refund_state ?? "legacy",
    );
  }
  if (order.kind !== "topup") {
    throw new OrderRefundError(
      "ORDER_REFUND_REQUIRES_MANUAL_REVIEW",
      `order kind ${order.kind} does not have a safely reversible entitlement snapshot`,
      order.kind,
    );
  }
  if (order.ledger_id === null) {
    throw new OrderRefundError(
      "ORDER_REFUND_LEDGER_INVALID",
      `topup order ${order.order_no} is missing ledger_id`,
    );
  }
}

async function loadOriginalLedger(
  client: PoolClient,
  order: RefundOrderDbRow,
): Promise<{ row: OriginalLedgerRow; amount: bigint; bucket: RefundBucket }> {
  const r = await client.query<OriginalLedgerRow>(
    `SELECT id::text AS id,
            user_id::text AS user_id,
            org_id::text AS org_id,
            delta::text AS delta,
            bucket,
            reason,
            ref_type,
            ref_id
       FROM credit_ledger
      WHERE id = $1::bigint`,
    [order.ledger_id],
  );
  const row = r.rows[0];
  const amount = row ? BigInt(row.delta) : 0n;
  const expectedBucket: RefundBucket = order.org_id === null ? "wallet" : "org_wallet";
  const valid =
    row !== undefined
    && amount > 0n
    && amount === BigInt(order.credits)
    && row.user_id === order.user_id
    && row.org_id === order.org_id
    && row.bucket === expectedBucket
    && row.reason === "topup"
    && row.ref_type === "order"
    && row.ref_id === order.id;
  if (!valid) {
    throw new OrderRefundError(
      "ORDER_REFUND_LEDGER_INVALID",
      `order ${order.order_no} original topup ledger does not match its immutable entitlement`,
    );
  }
  return { row, amount, bucket: expectedBucket };
}

async function holdPersonalWallet(
  client: PoolClient,
  order: RefundOrderDbRow,
  amount: bigint,
  reason: string,
): Promise<bigint> {
  const balanceRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1::bigint FOR UPDATE",
    [order.user_id],
  );
  if (!balanceRow.rows[0]) {
    throw new OrderRefundError("ORDER_REFUND_LEDGER_INVALID", `user ${order.user_id} is missing`);
  }
  const before = BigInt(balanceRow.rows[0].credits);
  if (before < amount) {
    throw new OrderRefundError(
      "ORDER_REFUND_BALANCE_INSUFFICIENT",
      `wallet balance ${before} is lower than refundable entitlement ${amount}`,
    );
  }
  const after = before - amount;
  await client.query("UPDATE users SET credits = $1 WHERE id = $2::bigint", [
    after.toString(),
    order.user_id,
  ]);
  const ledger = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1::bigint, $2, $3, 'refund', 'wallet', 'order', $4, $5)
     RETURNING id::text AS id`,
    [
      order.user_id,
      (-amount).toString(),
      after.toString(),
      order.id,
      `order refund hold order_no=${order.order_no} reason=${reason}`,
    ],
  );
  return BigInt(ledger.rows[0].id);
}

async function holdOrgWallet(
  client: PoolClient,
  order: RefundOrderDbRow,
  amount: bigint,
  reason: string,
): Promise<bigint> {
  const balanceRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM orgs WHERE id = $1::bigint FOR UPDATE",
    [order.org_id],
  );
  if (!balanceRow.rows[0]) {
    throw new OrderRefundError("ORDER_REFUND_LEDGER_INVALID", `org ${order.org_id} is missing`);
  }
  const before = BigInt(balanceRow.rows[0].credits);
  if (before < amount) {
    throw new OrderRefundError(
      "ORDER_REFUND_BALANCE_INSUFFICIENT",
      `org wallet balance ${before} is lower than refundable entitlement ${amount}`,
    );
  }
  const after = before - amount;
  await client.query(
    "UPDATE orgs SET credits = $1, updated_at = NOW() WHERE id = $2::bigint",
    [after.toString(), order.org_id],
  );
  const ledger = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, org_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1::bigint, $2::bigint, $3, $4, 'refund', 'org_wallet', 'order', $5, $6)
     RETURNING id::text AS id`,
    [
      order.user_id,
      order.org_id,
      (-amount).toString(),
      after.toString(),
      order.id,
      `org order refund hold order_no=${order.order_no} reason=${reason}`,
    ],
  );
  return BigInt(ledger.rows[0].id);
}

export async function reserveOrderRefund(
  input: ReserveOrderRefundInput,
): Promise<ReservedOrderRefund> {
  return tx(async (client) => {
    const order = await selectOrderForUpdate(client, input.orderNo);
    if (!order) {
      throw new OrderRefundError("ORDER_NOT_FOUND", `order not found: ${input.orderNo}`);
    }
    assertRefundableOrder(order);
    const original = await loadOriginalLedger(client, order);
    const holdLedgerId =
      original.bucket === "wallet"
        ? await holdPersonalWallet(client, order, original.amount, input.reason)
        : await holdOrgWallet(client, order, original.amount, input.reason);

    await client.query(
      `UPDATE orders
          SET refund_state = 'requested',
              refund_reason = $2,
              refund_requested_by = $3::bigint,
              refund_requested_at = NOW(),
              refund_hold_ledger_id = $4::bigint,
              updated_at = NOW()
        WHERE id = $1::bigint`,
      [order.id, input.reason, String(input.adminId), holdLedgerId.toString()],
    );
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "order.refund.request",
      target: `order:${order.order_no}`,
      before: {
        status: order.status,
        refund_state: null,
        bucket: original.bucket,
        credits: original.amount.toString(),
      },
      after: {
        status: order.status,
        refund_state: "requested",
        bucket: original.bucket,
        credits_held: original.amount.toString(),
        hold_ledger_id: holdLedgerId.toString(),
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      orderNo: order.order_no,
      amountCents: BigInt(order.amount_cents),
      creditsHeld: original.amount,
      bucket: original.bucket,
      state: "requested",
    };
  });
}

export type ApplyRefundStatusOutcome =
  | "completed"
  | "already_completed"
  | "channel_pending"
  | "failed_review"
  | "unmanaged";

export interface ApplyRefundStatusResult {
  outcome: ApplyRefundStatusOutcome;
  state: OrderRefundState | null;
}

function nextNonTerminalState(
  current: OrderRefundState,
  status: HupijiaoRefundStatus,
): OrderRefundState {
  if (status === "UD") return "failed_review";
  if (current === "failed_review") return current;
  return "channel_pending";
}

/**
 * Monotonic provider state application. `completed` is absorbing; duplicate CD
 * is idempotent and never writes a second completion audit.
 */
export async function applyProviderRefundStatus(
  result: HupijiaoRefundResult,
): Promise<ApplyRefundStatusResult> {
  return tx(async (client) => {
    const order = await selectOrderForUpdate(client, result.orderNo);
    if (!order || order.refund_state === null || order.refund_hold_ledger_id === null) {
      return { outcome: "unmanaged", state: order?.refund_state ?? null };
    }
    if (order.refund_state === "completed") {
      return { outcome: "already_completed", state: "completed" };
    }

    if (result.status === "CD") {
      const expectedAmount = BigInt(order.amount_cents);
      if (result.refundAmountCents !== expectedAmount) {
        throw new OrderRefundProviderMismatchError(
          order.order_no,
          expectedAmount,
          result.refundAmountCents,
        );
      }
      await client.query(
        `UPDATE orders
            SET status = 'refunded',
                refund_state = 'completed',
                refunded_ledger_id = refund_hold_ledger_id,
                provider_refund_no = COALESCE($2, provider_refund_no),
                refund_payload = $3::jsonb,
                refunded_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::bigint`,
        [order.id, result.providerRefundNo, JSON.stringify(result.safePayload)],
      );
      await writeAdminAudit(client, {
        adminId: order.refund_requested_by!,
        action: "order.refund.complete",
        target: `order:${order.order_no}`,
        before: {
          status: order.status,
          refund_state: order.refund_state,
          refunded_ledger_id: order.refunded_ledger_id,
        },
        after: {
          status: "refunded",
          refund_state: "completed",
          refunded_ledger_id: order.refund_hold_ledger_id,
          provider_refund_no: result.providerRefundNo,
        },
      });
      return { outcome: "completed", state: "completed" };
    }

    const next = nextNonTerminalState(order.refund_state, result.status);
    await client.query(
      `UPDATE orders
          SET refund_state = $2,
              provider_refund_no = COALESCE($3, provider_refund_no),
              refund_payload = $4::jsonb,
              updated_at = NOW()
        WHERE id = $1::bigint`,
      [order.id, next, result.providerRefundNo, JSON.stringify(result.safePayload)],
    );
    return {
      outcome: next === "failed_review" ? "failed_review" : "channel_pending",
      state: next,
    };
  });
}

export async function markRefundChannelUnknown(
  orderNo: string,
  code: string,
): Promise<ApplyRefundStatusResult> {
  return tx(async (client) => {
    const order = await selectOrderForUpdate(client, orderNo);
    if (!order || order.refund_state === null) {
      return { outcome: "unmanaged", state: order?.refund_state ?? null };
    }
    if (order.refund_state === "completed") {
      return { outcome: "already_completed", state: "completed" };
    }
    const next =
      order.refund_state === "failed_review" ? "failed_review" : "channel_pending";
    await client.query(
      `UPDATE orders
          SET refund_state = $2,
              refund_payload = $3::jsonb,
              updated_at = NOW()
        WHERE id = $1::bigint`,
      [
        order.id,
        next,
        JSON.stringify({ source: "refund_request", outcome: "unknown", code }),
      ],
    );
    return {
      outcome: next === "failed_review" ? "failed_review" : "channel_pending",
      state: next,
    };
  });
}
