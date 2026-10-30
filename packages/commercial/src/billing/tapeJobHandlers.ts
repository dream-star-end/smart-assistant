import type { DurableCodexBilling } from "@openclaude/protocol";
import type { Pool } from "pg";
import {
  _setAfterLosslessStageBatch,
  type LosslessTurnTapeStorage,
} from "../db/pgSessionsBackend.js";
import type { TapeJobSchedulerDeps } from "../db/tapeJobScheduler.js";
import type { Logger } from "../logging/logger.js";
import { applyTurnWaiver } from "./refund.js";

export interface TapeJobHandlerDeps {
  pool: Pool;
  materializeBackend: Pick<LosslessTurnTapeStorage, "finalizeLosslessTurnTape">;
  settleTapeEngineBilling: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  logger: Logger;
}

export function createTapeJobHandlers({
  pool,
  materializeBackend,
  settleTapeEngineBilling,
  logger,
}: TapeJobHandlerDeps): Required<Pick<TapeJobSchedulerDeps, "materializeTape" | "settleJob">> {
  return {
    materializeTape: async (job, renew) => {
      _setAfterLosslessStageBatch(renew);
      try {
        const header = await pool.query<{
          agent_id: string;
          turn_index: number;
          status: "completed" | "interrupted" | "crashed";
          turn_key: string;
          tape_sha256: string;
          total_bytes: string;
          part_count: number;
          created_at: string;
          waive_reason: string | null;
          model: string | null;
          dispatch_id: string | null;
          attempt_no: number | null;
          materialized: boolean;
        }>(
          `SELECT agent_id, turn_index, status, turn_key, tape_sha256, total_bytes::text,
                  part_count, created_at::text, waive_reason, NULL::text AS model,
                  dispatch_id::text, attempt_no,
                  (materialization_status='complete' OR finalized_at IS NOT NULL) AS materialized
             FROM client_session_turn_tapes
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
          [job.sessionId, job.userId, job.tapeId],
        );
        const row = header.rows[0];
        if (!row) throw new Error("tape header missing for materialization job");
        if (row.materialized) return;
        const result = await materializeBackend.finalizeLosslessTurnTape(job.userId, {
          protocolVersion: 2,
          action: "finalize",
          sessionId: job.sessionId,
          agentId: row.agent_id,
          turnIndex: row.turn_index,
          status: row.status,
          turnKey: row.turn_key,
          tapeId: job.tapeId,
          tapeSha256: row.tape_sha256,
          totalBytes: Number(row.total_bytes),
          partCount: row.part_count,
          createdAt: Number(row.created_at),
          ...(row.waive_reason ? { waiveReason: row.waive_reason as "idle_timeout" } : {}),
          ...(row.dispatch_id ? { dispatchId: row.dispatch_id, attemptNo: row.attempt_no ?? 1 } : {}),
        });
        if (result.applied === "incomplete") {
          throw new Error("tape materialization still incomplete");
        }
        const done = await pool.query<{ ok: boolean }>(
          `SELECT (materialization_status='complete' OR finalized_at IS NOT NULL) AS ok
             FROM client_session_turn_tapes
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
          [job.sessionId, job.userId, job.tapeId],
        );
        if (done.rows[0]?.ok !== true) {
          throw new Error("tape materialization pending after finalize");
        }
      } finally {
        _setAfterLosslessStageBatch(null);
      }
    },
    settleJob: async (job) => {
      const uidMatch = /^c:([1-9][0-9]*)$/.exec(job.userId);
      if (!uidMatch) throw new Error("settlement job requires commercial user");
      const uid = BigInt(uidMatch[1]!);
      if (job.kind === "billing") {
        const billings = Array.isArray((job.payload as { engineBillings?: unknown }).engineBillings)
          ? (job.payload as { engineBillings: import("@openclaude/protocol").DurableCodexBilling[] }).engineBillings
          : [];
        for (const billing of billings) {
          await settleTapeEngineBilling(uid, billing);
        }
        return;
      }
      const reason = (job.payload as { reason?: string; turnKey?: string }).reason;
      const turnKey = (job.payload as { turnKey?: string }).turnKey;
      if (!reason || !turnKey) throw new Error("waiver job payload missing reason/turnKey");
      const waiver = await applyTurnWaiver(pool, {
        userId: uid,
        turnKey,
        reason: reason as "idle_timeout",
        logger: logger.child({ subsys: "tapeWaiver" }),
      });
      if (waiver.disposition === 'deferred') {
        throw new Error(`turn waiver proof pending: ${waiver.reason}`);
      }
      // Denied is a completed proposal, with no fence/refund/receipt.
      // Billing jobs and later settlements retain their actual charges.
    },
  };
}
