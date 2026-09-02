/**
 * Cursor pending-audit reconciler (master, leader-only, v5).
 *
 * `cursor_external_usage_audit` rows are inserted `pending` in the dispatch
 * transaction and closed by the live `external_engine_billing` frame or, since
 * the 2026-09-02 fix, by the durable tape `engine_billings[]` frame. Rows can
 * still be left pending by:
 *   - tapes written by a gateway image predating the fix (no engine_billings),
 *   - a master crash between tape finalize and settlement job execution
 *     (already retried by the job scheduler, but this closes the loop),
 *   - dispatches that never produced a tape (container crash before flush).
 *
 * Each tick joins pending audits -> turn_dispatches (billing_request_id) ->
 * client_session_turn_tapes (dispatch_id, finalized). The tape `usage` column
 * is the same engine-reported final usage the live frame would have carried
 * (its traceId is the client-visible trace chip, not the billing requestId; the
 * dispatch join is the authoritative link), so a DurableCodexBilling frame is
 * rebuilt from it and handed to settleDurableCursorBilling. Rows created before the operator
 * cutoff are settled with costCredits forced to 0 (record, never debit).
 *
 * Rows whose dispatch is still open are skipped (turn in flight). Rows with a
 * terminal dispatch but no finalized tape after the grace window are closed as
 * `unavailable` with a snapshot marker so they stop being re-scanned; nothing
 * is charged because no usage evidence exists.
 */

import type { Pool } from "pg";
import type { DurableCodexBilling } from "@openclaude/protocol";

import type { Logger } from "../logging/logger.js";
import {
  settleDurableCursorBilling,
  type DurableCursorBillingDeps,
  type DurableCursorBillingSettleOutcome,
} from "./durableCursorBilling.js";

export interface CursorAuditReconcilerDeps extends DurableCursorBillingDeps {
  pool: Pool;
  /** Audit rows created strictly before this instant settle at 0 credits. */
  zeroChargeBefore: Date | null;
  /** Pending age before a row is eligible (live/tape paths get this long). */
  minAgeMs?: number;
  /** Terminal dispatch without any finalized tape for this long -> close as unavailable. */
  noTapeGraceMs?: number;
  batchSize?: number;
}

export interface CursorAuditReconcileTick {
  scanned: number;
  settled: number;
  alreadySettled: number;
  waived: number;
  zeroCharged: number;
  closedNoEvidence: number;
  skippedInFlight: number;
  errors: number;
}

const DEFAULT_MIN_AGE_MS = 10 * 60_000;
const DEFAULT_NO_TAPE_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_BATCH = 50;

type PendingAuditRow = {
  request_id: string;
  user_id: string;
  session_id: string | null;
  model_id: string;
  created_at: string;
  dispatch_id: string | null;
  attempt_no: number | null;
  dispatch_status: string | null;
  dispatch_outcome: string | null;
  terminal_at: string | null;
  tape_turn_key: string | null;
  tape_status: "completed" | "interrupted" | "crashed" | null;
  tape_usage: Record<string, unknown> | null;
  tape_created_at: string | null;
  tape_finalized_at: string | null;
  tape_engine_billing: Record<string, unknown> | null;
};

function tokenOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Rebuild the durable billing frame for a legacy tape (no engine_billings).
 * Exported for tests. Returns null when the tape has no usable usage.
 */
export function billingFrameFromTape(row: {
  request_id: string;
  session_id: string | null;
  tape_turn_key: string | null;
  tape_status: "completed" | "interrupted" | "crashed" | null;
  tape_usage: Record<string, unknown> | null;
  tape_created_at: string | null;
  tape_finalized_at: string | null;
}): DurableCodexBilling | null {
  const usage = row.tape_usage;
  if (!usage || typeof usage !== "object") return null;
  // NOTE: tape usage.traceId is the client-visible trace id (the `#xxxx`
  // footer chip), NOT the server-authored billing requestId, so it must not
  // be compared against audit.request_id. The authoritative link is the join
  // the caller already made: audit.request_id = turn_dispatches.
  // billing_request_id (UNIQUE) -> client_session_turn_tapes.dispatch_id.
  const interrupted = row.tape_status === "interrupted";
  const crashed = row.tape_status === "crashed";
  const createdAt = Number(row.tape_created_at ?? 0);
  const finalizedAt = Number(row.tape_finalized_at ?? 0);
  const durationMs = createdAt > 0 && finalizedAt >= createdAt ? finalizedAt - createdAt : 0;
  return {
    requestId: row.request_id,
    engine: "cursor",
    ...(row.tape_turn_key && /^[0-9a-f]{64}$/.test(row.tape_turn_key) ? { turnKey: row.tape_turn_key } : {}),
    engineSessionId: row.session_id ?? "",
    status: interrupted || crashed ? "error" : "success",
    ...(interrupted ? { terminalCode: "USER_CANCELLED" as const } : crashed ? { terminalCode: "CODEX_ERROR" as const } : {}),
    durationMs,
    usage: {
      input_tokens: tokenOr0(usage.inputTokens),
      output_tokens: tokenOr0(usage.outputTokens),
      cache_read_input_tokens: tokenOr0(usage.cacheReadTokens),
      cache_creation_input_tokens: tokenOr0(usage.cacheCreationTokens),
    },
  };
}

export async function runCursorAuditReconcileTick(
  deps: CursorAuditReconcilerDeps,
): Promise<CursorAuditReconcileTick> {
  const counts: CursorAuditReconcileTick = {
    scanned: 0,
    settled: 0,
    alreadySettled: 0,
    waived: 0,
    zeroCharged: 0,
    closedNoEvidence: 0,
    skippedInFlight: 0,
    errors: 0,
  };
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const noTapeGraceMs = deps.noTapeGraceMs ?? DEFAULT_NO_TAPE_GRACE_MS;
  const batch = deps.batchSize ?? DEFAULT_BATCH;
  const log = deps.logger;

  const rows = (
    await deps.pool.query<PendingAuditRow>(
      `SELECT a.request_id, a.user_id::text AS user_id, a.session_id, a.model_id,
              a.created_at::text AS created_at,
              d.dispatch_id::text AS dispatch_id, d.attempt_no,
              d.status AS dispatch_status, d.outcome AS dispatch_outcome,
              d.terminal_at::text AS terminal_at,
              t.turn_key AS tape_turn_key, t.status AS tape_status, t.usage AS tape_usage,
              t.created_at::text AS tape_created_at, t.finalized_at::text AS tape_finalized_at,
              (SELECT eb FROM jsonb_array_elements(COALESCE(t.engine_billings, '[]'::jsonb)) eb
                WHERE eb->>'requestId' = a.request_id LIMIT 1) AS tape_engine_billing
         FROM cursor_external_usage_audit a
         LEFT JOIN turn_dispatches d ON d.billing_request_id = a.request_id
         LEFT JOIN LATERAL (
           SELECT t.turn_key, t.status, t.usage, t.created_at, t.finalized_at, t.engine_billings
             FROM client_session_turn_tapes t
            WHERE t.dispatch_id = d.dispatch_id AND t.finalized_at IS NOT NULL
            ORDER BY t.finalized_at ASC LIMIT 1
         ) t ON TRUE
        WHERE a.status = 'pending'
          AND a.created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        ORDER BY a.created_at ASC
        LIMIT $2`,
      [minAgeMs, batch],
    )
  ).rows;
  counts.scanned = rows.length;

  for (const row of rows) {
    const uid = BigInt(row.user_id);
    const rowLog = log?.child({ requestId: row.request_id, userId: row.user_id });
    try {
      const createdAt = new Date(row.created_at);
      const zeroCharge = deps.zeroChargeBefore !== null && createdAt < deps.zeroChargeBefore;

      // Prefer the durable frame written by the fixed gateway; rebuild from
      // tape usage for legacy tapes.
      let frame: DurableCodexBilling | null = null;
      if (row.tape_engine_billing && row.tape_engine_billing.engine === "cursor") {
        frame = row.tape_engine_billing as unknown as DurableCodexBilling;
      } else if (row.tape_finalized_at) {
        frame = billingFrameFromTape(row);
      }

      if (frame === null) {
        const dispatchOpen =
          row.dispatch_status !== null
          && row.dispatch_status !== "terminal"
          && row.dispatch_status !== "manual_reconcile";
        if (dispatchOpen) {
          counts.skippedInFlight++;
          continue;
        }
        // Terminal/absent dispatch and no tape evidence. Wait the grace window
        // (tape retry queue), then close as unavailable so the row stops
        // re-scanning. Nothing to charge without usage evidence.
        const ageMs = Date.now() - createdAt.getTime();
        if (ageMs < noTapeGraceMs) {
          counts.skippedInFlight++;
          continue;
        }
        const closed = await deps.pool.query(
          `UPDATE cursor_external_usage_audit
              SET status='unavailable', completed_at=NOW(),
                  reported_usage=jsonb_build_object(
                    'reconciler', 'no_usage_evidence',
                    'dispatch_status', $3::text, 'dispatch_outcome', $4::text)
            WHERE request_id=$1 AND user_id=$2 AND status='pending'`,
          [row.request_id, row.user_id, row.dispatch_status, row.dispatch_outcome],
        );
        if ((closed.rowCount ?? 0) === 1) {
          counts.closedNoEvidence++;
          rowLog?.warn("cursor audit reconciler: closed pending audit without usage evidence", {
            dispatchStatus: row.dispatch_status,
            dispatchOutcome: row.dispatch_outcome,
          });
        }
        continue;
      }

      const outcome: DurableCursorBillingSettleOutcome = await settleDurableCursorBilling(
        deps,
        uid,
        frame,
        { zeroCharge },
      );
      if (zeroCharge && outcome !== "no_audit") counts.zeroCharged++;
      if (outcome === "committed") counts.settled++;
      else if (outcome === "already_committed") counts.alreadySettled++;
      else if (outcome === "waived") counts.waived++;
      rowLog?.info("cursor audit reconciler: settled pending audit", {
        outcome,
        zeroCharge,
        model: row.model_id,
        source: row.tape_engine_billing ? "tape_engine_billing" : "tape_usage",
        dispatchId: row.dispatch_id,
      });
    } catch (err) {
      counts.errors++;
      rowLog?.warn("cursor audit reconciler: settle failed, will retry next tick", {
        err: (err as Error)?.message,
      });
    }
  }
  return counts;
}

export interface CursorAuditReconcilerHandle {
  stop(): void;
  /** Test/ops hook: run one tick now. */
  runOnce(): Promise<CursorAuditReconcileTick>;
}

export function startCursorAuditReconciler(
  deps: CursorAuditReconcilerDeps & { intervalMs: number; runOnStart?: boolean },
): CursorAuditReconcilerHandle {
  let stopped = false;
  let running = false;
  const empty: CursorAuditReconcileTick = {
    scanned: 0, settled: 0, alreadySettled: 0, waived: 0, zeroCharged: 0,
    closedNoEvidence: 0, skippedInFlight: 0, errors: 0,
  };
  const runOnce = async (): Promise<CursorAuditReconcileTick> => {
    if (running || stopped) return empty;
    running = true;
    try {
      const counts = await runCursorAuditReconcileTick(deps);
      if (counts.scanned > 0) {
        deps.logger?.info("cursor audit reconciler tick", { ...counts });
      }
      return counts;
    } catch (err) {
      deps.logger?.warn("cursor audit reconciler tick failed", { err: (err as Error)?.message });
      return empty;
    } finally {
      running = false;
    }
  };
  const jitter = Math.floor(Math.random() * Math.min(5_000, deps.intervalMs));
  const timer = setInterval(() => {
    if (!stopped) void runOnce();
  }, deps.intervalMs + jitter);
  if (typeof timer.unref === "function") timer.unref();
  if (deps.runOnStart !== false) void runOnce();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}

/** Parse COMMERCIAL_CURSOR_AUDIT_BACKFILL_ZERO_CHARGE_BEFORE (ISO-8601). */
export function parseZeroChargeCutoff(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
