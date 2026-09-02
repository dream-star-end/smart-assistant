/**
 * Durable Cursor (subscription engine, billingMode='external') settlement.
 *
 * Root cause fixed here (2026-09-02): cursor usage used to reach master only
 * through the volatile `outbound.external_engine_billing` WS frame. When the
 * user's socket was gone at turn end the frame was lost, the
 * `cursor_external_usage_audit` row stayed `pending`, no usage_records /
 * turn_tape_cost_components were written and the reply footer never showed
 * a credits badge.
 *
 * The gateway now also embeds the same evidence in the immutable turn tape as
 * `engine_billings[]` with `engine:'cursor'`. Master routes those frames
 * here instead of the Codex journal finalizer (cursor has no
 * request_finalize_journal row). The same routine is reused by the
 * pending-audit reconciler, which rebuilds the frame from the finalized tape
 * usage for turns whose tape predates the gateway fix.
 *
 * Money safety:
 *   - usage_records UNIQUE(user_id, request_id) is the duplicate-debit fence;
 *     a live-path settle that already happened makes this path idempotent
 *     (debitedCredits=null, attribution reused).
 *   - Historical rows (created before the operator cutoff) settle with
 *     costCredits forced to 0 and a `historical_backfill_no_charge` snapshot
 *     marker: the ledger/UI get the record, the wallet is never debited.
 */

import type { Pool } from "pg";
import type { DurableCodexBilling } from "@openclaude/protocol";

import type { Logger } from "../logging/logger.js";
import type { PricingCache } from "./pricing.js";
import { settleCursorExternalUsage, type CursorEngineStatus } from "./cursorExternalSettle.js";

export type AppendCostCreditsForUser = (
  requestId: string,
  rawUserId: string,
  costCredits: string,
  sessionId?: string | null,
  parentSessionId?: string | null,
  delegateAgentId?: string | null,
  turnKey?: string | null,
  parentTurnKey?: string | null,
) => Promise<unknown>;

export interface DurableCursorBillingDeps {
  pgPool: Pool;
  pricing: PricingCache;
  logger?: Logger;
  /** Folds the exact cost locator into the tape component so the UI badge
   * appears without waiting for the next full-sync. Optional: the settle
   * transaction already staged pending_usage_patches, which finalize / the
   * late-fold GC also fold. */
  appendCostCredits?: AppendCostCreditsForUser;
  /** Live `outbound.cost_charged` push; only fired on a real positive debit. */
  broadcastToUser?: (userId: bigint, payload: Record<string, unknown>) => void;
}

export type DurableCursorBillingSettleOutcome =
  | "committed"
  | "already_committed"
  | "waived"
  /** No audit row for this request (not a cursor turn admitted by this master). */
  | "no_audit";

export interface DurableCursorBillingOptions {
  /** Force 0-credit settlement (historical backfill). */
  zeroCharge?: boolean;
}

export function isCursorDurableBilling(frame: DurableCodexBilling): boolean {
  return frame.engine === "cursor";
}

function mapAuditStatus(frame: DurableCodexBilling): CursorEngineStatus {
  return frame.status === "success" ? "success" : "error";
}

/** cursor_external_usage_audit.terminal_code CHECK vocabulary (0208). The
 * durable wire contract only carries USER_CANCELLED | CODEX_ERROR. */
export function mapAuditTerminalCode(
  frame: Pick<DurableCodexBilling, "status" | "terminalCode">,
): "USER_CANCELLED" | "ENGINE_ERROR" | null {
  if (frame.status === "success") return null;
  return frame.terminalCode === "USER_CANCELLED" ? "USER_CANCELLED" : "ENGINE_ERROR";
}

/**
 * Settle one validated cursor tape billing frame. Throws on transient DB
 * failure or missing pricing so the settlement job / tape retry queue keeps
 * it; returns a stable outcome otherwise.
 */
export async function settleDurableCursorBilling(
  deps: DurableCursorBillingDeps,
  userId: bigint,
  frame: DurableCodexBilling,
  opts: DurableCursorBillingOptions = {},
): Promise<DurableCursorBillingSettleOutcome> {
  const requestId = frame.requestId;
  const uid = userId.toString();
  const log = deps.logger?.child({ requestId, userId: uid });
  const engineStatus = mapAuditStatus(frame);
  const terminalCode = mapAuditTerminalCode(frame);
  const usage = frame.usage ?? {};

  // 1. Audit row = master-owned truth for (user, model, session). It was
  //    inserted in the dispatch tx before the prompt was forwarded, so it
  //    must exist for any genuine cursor turn. Close it if still pending.
  const updated = await deps.pgPool.query<{ model_id: string; session_id: string | null }>(
    `UPDATE cursor_external_usage_audit
        SET status=$2, terminal_code=$3, duration_ms=$4, reported_usage=$5::jsonb, completed_at=NOW()
      WHERE request_id=$1 AND user_id=$6 AND status='pending'
    RETURNING model_id, session_id`,
    [requestId, engineStatus, terminalCode, frame.durationMs, JSON.stringify(usage), uid],
  );
  let modelId = updated.rows[0]?.model_id ?? null;
  let auditSessionId = updated.rows[0]?.session_id ?? null;
  if (modelId === null) {
    const existing = await deps.pgPool.query<{ model_id: string; session_id: string | null; user_id: string }>(
      `SELECT model_id, session_id, user_id::text AS user_id
         FROM cursor_external_usage_audit WHERE request_id=$1`,
      [requestId],
    );
    const row = existing.rows[0];
    if (!row) {
      log?.warn("durable cursor billing: no audit row, skipped", {});
      return "no_audit";
    }
    if (row.user_id !== uid) {
      // Container serves one user; a foreign audit row means a forged/replayed
      // requestId. Never settle against another user's wallet.
      log?.error("durable cursor billing: audit user mismatch — refusing settle", {
        auditUserId: row.user_id,
      });
      return "no_audit";
    }
    modelId = row.model_id;
    auditSessionId = row.session_id;
  }

  // 2. Dispatch identity (exact durable-turn locator on usage_records).
  const dispatch = await deps.pgPool.query<{ dispatch_id: string; attempt_no: number }>(
    `SELECT dispatch_id::text AS dispatch_id, attempt_no
       FROM turn_dispatches WHERE billing_request_id=$1 AND user_id=$2`,
    [requestId, uid],
  );
  const dispatchId = dispatch.rows[0]?.dispatch_id ?? null;
  const attemptNo = dispatch.rows[0]?.attempt_no ?? null;

  // 3. Settle. usage_records.session_id mirrors the live cursor bridge path
  //    (audit row = client session id) so both paths write identical rows;
  //    the engine session id is only a fallback for audit rows without one.
  const sessionId = auditSessionId ?? (frame.engineSessionId || null);
  const turnKey = frame.turnKey ?? null;
  const parentTurnKey = frame.parentTurnKey ?? null;
  const parentSessionId = frame.parentSessionId ?? null;
  const delegateAgentId = frame.delegateAgentId ?? null;
  const settled = await settleCursorExternalUsage({
    pool: deps.pgPool,
    pricing: deps.pricing,
    userId,
    requestId,
    modelId,
    sessionId,
    engineStatus,
    terminalCode,
    usage,
    // Account attribution needs the live slot results; the durable frame has
    // none. usage_records.account_id stays NULL (0044 SET NULL semantics).
    accountId: null,
    turnKey,
    parentTurnKey,
    parentSessionId,
    delegateAgentId,
    dispatchId,
    attemptNo,
    zeroCharge: opts.zeroCharge === true,
  });
  if (settled === null) {
    // Pricing cache miss is transient (cache reload) or a catalog gap; both
    // must keep the job queued rather than silently forgetting the turn.
    throw new Error(`durable cursor billing: pricing missing for model ${modelId}`);
  }

  // 4. Persist/fold the exact cost locator even when the debit is zero, so
  //    the tape component (and therefore the UI badge) exists. Same rule as
  //    the codex live bridge path.
  const persistedCredits =
    settled.attributionCredits !== null && settled.attributionCredits !== undefined
      ? settled.attributionCredits
      : settled.debitedCredits !== null && settled.debitedCredits > 0n
        ? settled.debitedCredits
        : null;
  if (persistedCredits !== null && deps.appendCostCredits) {
    try {
      await deps.appendCostCredits(
        requestId,
        uid,
        persistedCredits.toString(),
        sessionId,
        parentSessionId,
        delegateAgentId,
        turnKey,
        parentTurnKey,
      );
    } catch (err) {
      // Component fold is a projection; usage/ledger truth is committed and
      // finalize / late-fold GC will still fold pending_usage_patches.
      log?.warn("durable cursor billing: appendCostCredits threw", {
        err: (err as Error)?.message,
      });
    }
  }

  if (settled.debitedCredits !== null && settled.debitedCredits > 0n) {
    deps.broadcastToUser?.(userId, {
      type: "outbound.cost_charged",
      requestId,
      model: modelId,
      costCredits: settled.debitedCredits.toString(),
      debitedCredits: settled.debitedCredits.toString(),
      balanceAfter: settled.balanceAfter !== null ? settled.balanceAfter.toString() : null,
      clamped: settled.clamped,
    });
    log?.info("durable cursor billing: committed", {
      model: modelId,
      debitedCredits: settled.debitedCredits.toString(),
      dispatchId,
      zeroCharge: opts.zeroCharge === true,
    });
    return "committed";
  }
  if (settled.debitedCredits === null) {
    log?.info("durable cursor billing: already settled (idempotent)", { model: modelId });
    return "already_committed";
  }
  log?.info("durable cursor billing: settled at zero", {
    model: modelId,
    engineStatus,
    zeroCharge: opts.zeroCharge === true,
  });
  return "waived";
}
