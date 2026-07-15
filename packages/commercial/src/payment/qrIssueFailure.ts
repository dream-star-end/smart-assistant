import type { OrderRow } from "./orders.js";
import { markOrderCanceled } from "./orders.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";

/** A provider error before a QR reaches the user is not an abandoned checkout.
 * Terminalize the otherwise-orphaned pending order immediately and record only
 * a stable product stage. Both writes are best-effort so the original provider
 * error remains the HTTP response; the pending-order sweeper is the fallback. */
export async function recordQrIssueFailure(order: OrderRow): Promise<void> {
  await markOrderCanceled({
    orderNo: order.order_no,
    callbackPayload: { source: "qr_issue_failed" },
  }).catch(() => {});
  await recordProductFrictionEvent({
    correlation: order.order_no,
    userId: order.user_id,
    surface: "payment",
    stage: "qr_issue",
    code: "QR_ISSUE_FAILED",
    outcome: "failed",
  }).catch(() => {});
}
