/** OCV5-488: the journal writes and reads that release a Box run held by
 * nothing (its processes are gone from the Box, or its turn has ended): the
 * cleanup worker's looks at the Box and the idle route's parked-turn lookup.
 * The close itself stays in BoxDurableJournal (markRunExpiredUnproven and the
 * proof-based closers); kept apart from it under the file-size ratchet. */
import type { Pool } from "pg";
import { updateClearRunAbsence, updateRecordAbandonedHandoffStop,
  updateRecordRunAbsence } from "../../billing/boxBillingStore.js";
import { BOX_MODEL_IDS_SQL, BoxDurableJournalError, STOP_MODE_FENCE, STOP_PROBE_STATE_FENCE,
  type BoxJournalAdmission, type BoxStoppedFailureProbeCandidate } from "./boxDurableJournal.js";
import { isBoxBootId, parseBoxRunAbsent, type BoxRunAbsent } from "./boxExpiredClose.js";

export class BoxHoldRelease {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  /** OCV5-488: the first look that found nothing of the run on the Box
   * (boxRunLiveness `absent`). Keeps an existing look and returns it; the
   * caller closes only on a confirming second look. Never changes billing
   * age. */
  async recordRunAbsence(input: BoxStoppedFailureProbeCandidate & { boot: string }):
    Promise<BoxRunAbsent | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch) || !isBoxBootId(input.boot)) {
      throw new BoxDurableJournalError("BOX_RUN_ABSENT_IDENTITY_INVALID");
    }
    const changed = await updateRecordRunAbsence(this.pool, {
      requestId: input.requestId, uid: input.uid, accountId: input.accountId,
      runNonce: input.runNonce, leaseEpoch: input.leaseEpoch, boot: input.boot,
    });
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_RUN_ABSENT_FENCE_LOST");
    return parseBoxRunAbsent(changed.seen);
  }

  /** OCV5-488: a later look found the run alive again; the next absence
   * starts over. */
  async clearRunAbsence(input: BoxStoppedFailureProbeCandidate): Promise<void> {
    await updateClearRunAbsence(this.pool, {
      requestId: input.requestId, uid: input.uid,
      runNonce: input.runNonce, leaseEpoch: input.leaseEpoch,
    });
  }

  /** OCV5-488: durable intent before the worker asks the original keeper to
   * stop a handoff leaf whose container is gone (same rule as the user stop:
   * intent commits before the remote stop). Re-checks the container under the
   * write; only the first marker is kept. A stop request is never terminal
   * evidence. Does not change billing age. */
  async recordAbandonedHandoffStop(input: BoxStoppedFailureProbeCandidate): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_ABANDONED_STOP_IDENTITY_INVALID");
    }
    return updateRecordAbandonedHandoffStop(this.pool, {
      requestId: input.requestId, uid: input.uid, accountId: input.accountId,
      runNonce: input.runNonce, leaseEpoch: input.leaseEpoch,
    });
  }

  /** OCV5-488: the container reads a turn's idle proof only after that turn
   * ended on its side (under the session lock, before the next submit). A
   * leaf of that turn still parked on a tool handoff can then never be
   * answered; it is the run to stop. Same container-scoped identity as
   * findCancelableRun; null when the turn has no such leaf. */
  async findParkedHandoffRun(input: { uid: bigint; containerId: bigint;
    sessionId: string; turnKey: string }): Promise<Pick<BoxJournalAdmission,
      "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> | null> {
    if (input.uid <= 0n || input.containerId <= 0n
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.sessionId)
      || !/^[a-f0-9]{64}$/.test(input.turnKey)) {
      throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
    }
    const found = await this.pool.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE user_id=$1 AND container_id=$2
          AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
          AND ctx->>'model' IN (${BOX_MODEL_IDS_SQL})
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ${STOP_MODE_FENCE}
          AND ${STOP_PROBE_STATE_FENCE}
          AND ctx->>'boxState'='handoff' AND ctx ? 'boxToolHandoff'
          AND NOT (ctx ? 'boxResumeRequestId')
          AND NOT (ctx ? 'boxTerminalProof')`,
      [input.uid.toString(), input.containerId.toString(),
        input.sessionId, input.turnKey]);
    const row = found.rows[0];
    const ctx = row?.ctx;
    if (found.rowCount !== 1 || !row || !ctx
      || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
      || typeof ctx.boxAccountId !== "string"
      || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
      || typeof ctx.boxRunNonce !== "string"
      || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
      || typeof ctx.boxLeaseEpoch !== "string"
      || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)) return null;
    return { requestId: row.request_id, uid: input.uid,
      accountId: BigInt(ctx.boxAccountId), runNonce: ctx.boxRunNonce,
      leaseEpoch: ctx.boxLeaseEpoch };
  }
}
