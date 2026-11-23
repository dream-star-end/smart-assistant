/**
 * Billing-layer DML store for Box durable journal & usage_records writes.
 *
 * Pure structural extraction from `http/proxy/box*.ts` so all billing-table DML
 * (`request_finalize_journal`, `usage_records`) lives strictly inside the `billing`
 * module (`R3-billing-sql` single authority) without changing any SQL semantics,
 * transaction boundaries, advisory locks, fences, or error codes.
 */
import type { Pool } from "pg";
import { unadmittedToolRolloverFieldsSql } from "./boxToolRolloverIdentity.js";
import {
  CLEANUP_MODE_FENCE,
  CLEANUP_NATIVE_POINTER_GRACE,
  CLEANUP_PROOF_FENCE,
  CLEANUP_REPLAY_FENCE,
  CLEANUP_STATE_FENCE,
  OWNER_CONTAINER_GONE,
  STOP_MODE_FENCE,
  STOP_PROBE_STATE_FENCE,
  runBoxBillingQuery,
  type BoxBillingDb,
} from "./boxBillingQueries.js";

export {
  BOX_MODEL_IDS_SQL,
  BOX_MODEL_PAIR_SQL,
  CLEANUP_MODE_FENCE,
  CLEANUP_NATIVE_POINTER_GRACE,
  CLEANUP_PROOF_FENCE,
  CLEANUP_REPLAY_FENCE,
  CLEANUP_STATE_FENCE,
  OWNER_CONTAINER_GONE,
  STOP_MODE_FENCE,
  STOP_PROBE_STATE_FENCE,
  selectAdmitCapacityUsage,
  selectAdmitDuplicateExists,
  selectCancelableRunRow,
  selectCancelLeafRow,
  selectIdleProofExpiredRows,
  selectIdleProofOpenRows,
  selectIdleProofTurnRows,
  selectLatestNativeOwnerForAdmit,
  selectNativeCandidateRow,
  selectNativeGcCandidateRows,
  selectNativeTranscriptSourceRows,
  selectOrphanToolHandoffRows,
  selectPrelaunchCleanupDoneRow,
  selectPrelaunchRecoveryCandidateRows,
  selectRemoteCleanupCandidateRows,
  selectRemoteCleanupDoneRow,
  selectRemoteCleanupStatusRow,
  selectRemoteCleanedAlreadyExists,
  selectStoppedFailureProbeCandidateRows,
  selectTextUnknownCandidateRows,
  selectUsageRecordExists,
  selectWaitingToolHandoffRows,
  type BoxBillingDb,
  type BoxIdleQueryRow,
} from "./boxBillingQueries.js";

const UNADMITTED_TOOL_ROLLOVER_SQL = unadmittedToolRolloverFieldsSql();

// ── Orphan recovery & native GC (BoxDurableJournal) ───────────────────────────

export async function updateClaimOrphanRecovery(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; by: string; sessionId: string; replacing: string | null; resumingParentSql: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal handoff_row
        SET ctx = handoff_row.ctx || jsonb_build_object('boxRecoveredBy', $3::text),
            updated_at=NOW()
      WHERE handoff_row.request_id=$1 AND handoff_row.user_id=$2
        AND handoff_row.ctx->>'boxSessionId'=$4
        AND (NOT (handoff_row.ctx ? 'boxRecoveredBy') OR handoff_row.ctx->>'boxRecoveredBy' = $5)
        AND (handoff_row.ctx->>'boxState'='failed_stopped'
          OR ((handoff_row.ctx->>'boxState'='handoff'
            OR ${input.resumingParentSql})
            AND NOT (handoff_row.ctx ? 'boxCancelIntent')))`,
    [input.requestId, input.uid.toString(), input.by, input.sessionId, input.replacing],
  );
  return changed.rowCount === 1;
}

export async function clearOrphanRecoveryClaim(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; by: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx = ctx - 'boxRecoveredBy', updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxRecoveredBy'=$3`,
    [input.requestId, input.uid.toString(), input.by],
  );
}

export async function updateClaimNativeGc(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; pointerJson: string; updateJson: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $4::jsonb,updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->'boxNativePointer'=$3::jsonb
        AND COALESCE(ctx->>'boxNativeGcStatus','pending')<>'done'
        AND NOT (ctx ? 'boxNativeGcQuarantine')`,
    [input.requestId, input.uid.toString(), input.pointerJson, input.updateJson],
  );
  return changed.rowCount === 1;
}

export async function updateFinishNativeGc(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; pointerJson: string; updateJson: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $4::jsonb,updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2
        AND ctx->'boxNativePointer'=$3::jsonb
        AND ctx->>'boxNativeGcStatus'='claimed'
        AND NOT (ctx ? 'boxNativeGcQuarantine')`,
    [input.requestId, input.uid.toString(), input.pointerJson, input.updateJson],
  );
  return changed.rowCount === 1;
}

export async function updateAttachNativePointer(
  db: BoxBillingDb,
  input: {
    requestId: string; uid: bigint; accountId: bigint; proofJson: string; pointerPatchJson: string;
    cliCwd: string; runNonce: string; nativeSessionId: string;
    contextHashBeforeFinal: string; catalogHash: string | null; ownerCwd: string;
  },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $5::jsonb
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxState'='terminal'
        AND (ctx->>'boxInvocationMode'='text' OR
          (ctx->>'boxInvocationMode'='detached_tool'
            AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
            AND ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
            AND NOT (ctx ? 'boxRemoteCleanupQuarantine')))
        AND ctx->'boxTerminalProof'=$4::jsonb
        AND ctx ? 'boxUsage' AND NOT (ctx ? 'boxNativePointer')
        AND ((ctx ? 'boxNativeCliCwd' AND ctx->>'boxNativeCliCwd'=$6)
          OR (NOT (ctx ? 'boxNativeCliCwd')
            AND $6=$11 AND ctx->>'boxRunNonce'=$7))
        AND (ctx->>'boxNativeSessionId' IS NULL
          OR ctx->>'boxNativeSessionId'=$8)
        AND (ctx->>'boxContextHash' IS NULL
          OR ctx->>'boxContextHash'=$9)
        AND (ctx->>'boxCatalogHash' IS NULL
          OR ctx->>'boxCatalogHash'=$10)`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.proofJson,
      input.pointerPatchJson, input.cliCwd, input.runNonce, input.nativeSessionId,
      input.contextHashBeforeFinal, input.catalogHash, input.ownerCwd],
  );
  return changed.rowCount === 1;
}

// ── Text observer, admission & launch lifecycle (BoxDurableJournal) ───────────

export async function updateClaimTextUnknownCandidate(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; detachedRunnerHash: string; upstreamModel: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object(
          'boxTextObserverLastAttemptMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
          'boxTextObserverRetryAfterMs',
            (EXTRACT(EPOCH FROM NOW()+INTERVAL '1 minute')*1000)::bigint)
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='unknown'
        AND ctx->>'boxLaunchPermit'='true'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxDetachedRunnerHash'=$6
        AND ctx->>'boxUpstreamModel'=$7
        AND NOT (ctx ? 'boxOwnerRequestId')
        AND NOT (ctx ? 'boxReplayMessage') AND NOT (ctx ? 'boxTerminalProof')
        AND (NOT (ctx ? 'boxTextObserverRetryAfterMs')
          OR (jsonb_typeof(ctx->'boxTextObserverRetryAfterMs')='number'
            AND (ctx->>'boxTextObserverRetryAfterMs') ~ '^[0-9]{13}$'
            AND (ctx->>'boxTextObserverRetryAfterMs')::bigint
              <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.detachedRunnerHash, input.upstreamModel],
  );
  return changed.rowCount === 1;
}

export async function updateClaimNativeOwnerForAdmit(
  db: BoxBillingDb,
  input: { ownerRequestId: string; uid: bigint; claimRequestId: string },
): Promise<boolean> {
  const claimed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $3::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxState'='terminal' AND NOT (ctx ? 'boxNativeClaimRequestId')`,
    [input.ownerRequestId, input.uid.toString(), JSON.stringify({ boxNativeClaimRequestId: input.claimRequestId })],
  );
  return claimed.rowCount === 1;
}

export async function updateAdmitJournalRow(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; model: string; identityJson: string },
): Promise<{ rowCount: number | null; ctx: Record<string, unknown> | undefined }> {
  const updated = await runBoxBillingQuery<{ ctx: Record<string, unknown> }>(
    db,
    `UPDATE request_finalize_journal
        SET ctx = ctx || $4::jsonb, updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
        AND ctx->>'model' = $3 AND ctx->>'boxInvocationRecovery' = 'v1'
        AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
        AND NOT (ctx ? 'boxState')
      RETURNING ctx`,
    [input.requestId, input.uid.toString(), input.model, input.identityJson],
  );
  return { rowCount: updated.rowCount, ctx: updated.rows[0]?.ctx };
}

export async function updateJournalMarkRunning(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx = jsonb_set(ctx, '{boxState}', '"running"'::jsonb), updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
        AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxState' = 'reserved'
        AND NOT (ctx->>'boxInvocationMode'='text'
          AND ctx ? 'boxDetachedRunnerHash')
        AND NOT (ctx ? 'boxPrelaunchControl')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch],
  );
  return changed.rowCount === 1;
}

export async function updateJournalArmTextLaunch(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; detachedRunnerHash: string; upstreamModel: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || '{"boxState":"running","boxLaunchPermit":true}'::jsonb,
            updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='reserved'
        AND ctx->>'boxDetachedRunnerHash'=$6
        AND ctx->>'boxUpstreamModel'=$7
        AND NOT (ctx ? 'boxLaunchPermit')
        AND NOT (ctx ? 'boxPrelaunchControl')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.detachedRunnerHash, input.upstreamModel],
  );
  return changed.rowCount === 1;
}

export async function updateJournalMarkPrestartStopped(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx = jsonb_set(ctx, '{boxState}', '"prestart_stopped"'::jsonb),
            updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
        AND ctx->>'boxLeaseEpoch' = $3
        AND ctx->>'boxState' IN ('reserved', 'running')
        AND NOT (ctx ? 'boxPrelaunchControl')
        AND NOT (ctx ? 'boxLaunchPermit')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch],
  );
  return changed.rowCount === 1;
}

export async function updateJournalPrelaunchControl(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; receiptJson: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $6::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState'='reserved'
        AND NOT (ctx ? 'boxPrelaunchControl')
        AND NOT (ctx ? 'boxLaunchPermit')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.receiptJson],
  );
  return changed.rowCount === 1;
}

export async function updateJournalArmGuardedLaunch(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; receiptJson: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || '{"boxState":"running","boxLaunchPermit":true}'::jsonb,
            updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState'='reserved'
        AND ctx->'boxPrelaunchControl'=$6::jsonb
        AND NOT (ctx ? 'boxLaunchPermit')
        AND NOT (ctx ? 'boxPrelaunchCleanup')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.receiptJson],
  );
  return changed.rowCount === 1;
}

export async function updateJournalGuardedPrestartStopped(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; receiptJson: string; cleanupPatchJson: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $7::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState' IN ('reserved','unknown')
        AND ctx->'boxPrelaunchControl'=$6::jsonb
        AND NOT (ctx ? 'boxLaunchPermit')
        AND NOT (ctx ? 'boxTerminalProof')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.receiptJson, input.cleanupPatchJson],
  );
  return changed.rowCount === 1;
}

export async function updateJournalMarkUnknown(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; activeStates: readonly string[] },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx = ctx || $4::jsonb, updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2
        AND ctx->>'boxLeaseEpoch' = $3
        AND ctx->>'boxState' = ANY($5::text[])
        AND NOT (ctx ? 'boxToolHandoff')
        AND NOT (ctx ? 'boxReplayMessage')
        AND NOT (ctx ? 'boxTerminalProof')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.activeStates],
  );
  return changed.rowCount === 1;
}

// ── Cancel, stop, completion, handoff & expired close (BoxDurableJournal) ─────

export async function updateJournalCancelIntent(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; runNonce: string; leaseEpoch: string; intentPatchJson: string; activeStates: readonly string[] },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $5::jsonb
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
        AND ctx->>'boxState'=ANY($6::text[])
        AND NOT (ctx ? 'boxCancelIntent')`,
    [input.requestId, input.uid.toString(), input.runNonce, input.leaseEpoch,
      input.intentPatchJson, input.activeStates],
  );
  return changed.rowCount === 1;
}

export async function updateFirstRoundHandoffStoppedFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState' IN ('handoff','unknown')
        AND ctx ? 'boxToolHandoff' AND NOT (ctx ? 'boxOwnerRequestId')
        AND NOT (ctx ? 'boxResumeRequestId')
        AND state IN ('inflight','finalizing','committed')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.runNonce],
  );
  return changed.rowCount === 1;
}

export async function updateFirstRoundUnbilledStoppedFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET state='aborted', failure_code='STREAM_FAILED',
            final_credits=0,
            error_msg=COALESCE(NULLIF(error_msg, ''), 'box_stopped:' || COALESCE($4::jsonb#>>'{boxTerminalProof,reason}', 'failed')),
            ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
        AND ${STOP_MODE_FENCE}
        AND ctx->>'boxState' IN ('running','unknown')
        AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxOwnerRequestId')
        AND NOT (ctx ? 'boxResumeRequestId')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.runNonce],
  );
  return changed.rowCount === 1;
}

export async function updateFirstRoundRejectedStream(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET state='aborted', failure_code='STREAM_FAILED',
            final_credits=0,
            error_msg=COALESCE(NULLIF(error_msg, ''), 'box_rejected_stream:' || COALESCE($4::jsonb#>>'{boxTerminalProof,reason}', 'rejected')),
            ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState' IN ('running','unknown')
        AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxOwnerRequestId')
        AND NOT (ctx ? 'boxResumeRequestId')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.runNonce],
  );
  return changed.rowCount === 1;
}

export async function updateJournalComplete(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string; hasPointer: boolean },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx = ctx || $4::jsonb, updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
         AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxRunNonce' = $5
         AND ctx->>'boxState' IN ('running', 'unknown')
         AND ($6::boolean = false OR (
           COALESCE(ctx->>'boxRoundNo','1')='1'
           AND NOT (ctx ? 'boxToolHandoff')
           AND NOT (ctx ? 'boxReplayMessage')))
         AND (ctx->>'boxReplayRequired' IS DISTINCT FROM 'true' OR $6::boolean = true)
         AND ctx ? 'billingPricing'`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson,
      input.runNonce, input.hasPointer],
  );
  return changed.rowCount === 1;
}

export async function updateJournalRecordToolHandoff(
  db: BoxBillingDb,
  input: {
    requestId: string; uid: bigint; leaseEpoch: string; patchJson: string;
    roundNo: number; catalogHash: string; detachedRunnerHash: string;
    messageId: string; spoolOffset: number; pointerRunNonce: string | null;
  },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal AS handoff_row
        SET ctx = handoff_row.ctx || $4::jsonb, updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
         AND ctx->>'boxLeaseEpoch' = $3
         AND ($10::text IS NULL OR ctx->>'boxRunNonce' = $10)
         AND (ctx->>'boxReplayRequired' IS DISTINCT FROM 'true' OR $10::text IS NOT NULL)
         AND ctx->>'boxInvocationMode' = 'detached_tool'
        AND NOT (ctx ? 'boxCancelIntent')
         AND NOT (ctx ? 'boxToolHandoff')
         AND NOT (ctx ? 'boxReplayMessage')
         AND NOT (ctx ? 'boxTerminalProof')
         AND ((($5::int = 1) AND (ctx->>'boxState' = 'running'
           OR (ctx->>'boxState'='unknown'
             AND ctx->>'boxReplayRequired'='true'
             AND ctx->>'boxLaunchPermit'='true')))
           OR (($5::int > 1) AND (ctx->>'boxState' = 'linked'
             OR (ctx->>'boxState'='unknown'
               AND ctx->>'boxReplayRequired'='true'
               AND EXISTS (SELECT 1 FROM request_finalize_journal root
                 WHERE root.user_id=$2
                   AND root.ctx->>'boxRunNonce'=handoff_row.ctx->>'boxRunNonce'
                   AND root.ctx->>'boxLeaseEpoch'=$3
                   AND root.ctx->>'boxAccountId'=handoff_row.ctx->>'boxAccountId'
                   AND root.ctx->>'boxSessionId'=handoff_row.ctx->>'boxSessionId'
                   AND root.ctx->>'boxTurnKey'=handoff_row.ctx->>'boxTurnKey'
                   AND root.ctx->>'boxLaunchPermit'='true'
                   AND NOT (root.ctx ? 'boxOwnerRequestId'))))
             AND ctx->>'boxRoundNo' = $5::text
            AND ctx->>'boxCatalogHash' = $6
            AND ctx->>'boxDetachedRunnerHash' = $7
            AND jsonb_typeof(ctx->'boxResumeSpoolOffset') = 'number'
            AND (ctx->>'boxResumeSpoolOffset')::bigint < $9::bigint
            AND jsonb_typeof(ctx->'boxPriorMessageIds') = 'array'
            AND jsonb_array_length(ctx->'boxPriorMessageIds') = $5::int - 1
            AND NOT (ctx->'boxPriorMessageIds' ? $8)))
        AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson,
      input.roundNo, input.catalogHash, input.detachedRunnerHash, input.messageId,
      input.spoolOffset, input.pointerRunNonce],
  );
  return changed.rowCount === 1;
}

export async function updateToolChainFinalTerminal(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string },
): Promise<boolean> {
  const final = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxState' IN ('linked','unknown')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson],
  );
  return final.rowCount === 1;
}

export async function updateToolChainAncestorTerminal(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=jsonb_set(ctx,'{boxState}','"terminal"'::jsonb), updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxState' IN ('resuming','unknown')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch],
  );
  return changed.rowCount === 1;
}

export async function updateToolChainHandoffStoppedFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string },
): Promise<boolean> {
  const stopped = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
        AND ctx->>'boxState' IN ('handoff','unknown')
        AND ctx ? 'boxToolHandoff' AND NOT (ctx ? 'boxResumeRequestId')
        AND state IN ('inflight','finalizing','committed')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.runNonce],
  );
  return stopped.rowCount === 1;
}

export async function updateToolChainUnbilledStoppedFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string; patchJson: string; runNonce: string },
): Promise<boolean> {
  const stopped = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET state='aborted', failure_code='STREAM_FAILED', final_credits=0,
            error_msg=COALESCE(NULLIF(error_msg, ''), 'box_toolchain_stopped:' || COALESCE($4::jsonb#>>'{boxTerminalProof,reason}', 'failed')),
            ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
        AND ctx->>'boxState' IN ('linked','unknown')
        AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'boxToolHandoff')`,
    [input.requestId, input.uid.toString(), input.leaseEpoch, input.patchJson, input.runNonce],
  );
  return stopped.rowCount === 1;
}

export async function updateToolChainAncestorStoppedFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; leaseEpoch: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || '{"boxState":"failed_stopped","boxStopOutcome":"failed"}'::jsonb,
            updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxState' IN ('resuming','unknown')
        AND ctx ? 'boxToolHandoff'`,
    [input.requestId, input.uid.toString(), input.leaseEpoch],
  );
  return changed.rowCount === 1;
}

function expiredUnprovenMarkerSql(): string {
  return `ctx || jsonb_build_object('boxState',$6::text,
          'boxExpiredClose',jsonb_build_object('v',1,
            'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
            'priorBoxState',$7::text,'cause',$8::text))`;
}

function expiredUnprovenFenceSql(requireRunAbsent: boolean): string {
  return `request_id=$1 AND user_id=$2
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxState'=$5
        AND NOT (ctx ? 'boxTerminalProof') AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'settlementClaimId') AND NOT (ctx ? 'boxExpiredClose')${
          requireRunAbsent ? "\n        AND ctx ? 'boxRunAbsent'" : ""}
        AND created_at <= NOW() - make_interval(secs => $9::double precision)`;
}

export async function updateExpiredUnprovenLeaf(
  db: BoxBillingDb,
  input: {
    requestId: string; uid: string; leaseEpoch: string; runNonce: string;
    actualState: string; expiredState: string; priorState: string; cause: string;
    ageSec: number; hasHandoff: boolean; requireRunAbsent: boolean;
  },
): Promise<boolean> {
  const params = [input.requestId, input.uid, input.leaseEpoch, input.runNonce,
    input.actualState, input.expiredState, input.priorState, input.cause, input.ageSec];
  const marker = expiredUnprovenMarkerSql();
  const fence = expiredUnprovenFenceSql(input.requireRunAbsent);
  const changed = input.hasHandoff
    ? await runBoxBillingQuery(
        db,
        `UPDATE request_finalize_journal SET ctx=${marker}
          WHERE ${fence} AND ctx ? 'boxToolHandoff'
            AND state IN ('inflight','finalizing','committed')`,
        params,
      )
    : await runBoxBillingQuery(
        db,
        `UPDATE request_finalize_journal
            SET state='aborted', failure_code='STREAM_FAILED', final_credits=0,
                error_msg=COALESCE(NULLIF(error_msg, ''), 'box_expired_unproven:' || COALESCE($8::text, 'expired')),
                ctx=${marker}, updated_at=NOW()
          WHERE ${fence} AND NOT (ctx ? 'boxToolHandoff')
            AND state='inflight' AND final_credits IS NULL`,
        params,
      );
  return changed.rowCount === 1;
}

export async function updateExpiredUnprovenAncestor(
  db: BoxBillingDb,
  input: { requestId: string; uid: string; leaseEpoch: string; expiredState: string },
): Promise<boolean> {
  const moved = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object('boxState',$4::text), updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxState' IN ('resuming','unknown')
        AND ctx ? 'boxToolHandoff' AND NOT (ctx ? 'boxTerminalProof')`,
    [input.requestId, input.uid, input.leaseEpoch, input.expiredState],
  );
  return moved.rowCount === 1;
}

// ── Stop probe, prelaunch & remote cleanup writes (BoxDurableJournal) ─────────

export async function updateRecordStaleResumeStop(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; phase: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object('boxStaleResumeStop',
          COALESCE(ctx->'boxStaleResumeStop', jsonb_build_object('phase',$6::text,
            'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint)))
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState'='unknown' AND ctx->>'boxUnknownPhase'=$6
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxTerminalProof')
        AND NOT (ctx ? 'boxResumeRequestId')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.phase],
  );
  return changed.rowCount === 1;
}

export async function updateClaimStoppedFailureProbe(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; linked: boolean },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object(
          'boxStopProbeLastAttemptMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
          'boxStopProbeAfterMs',
            (EXTRACT(EPOCH FROM NOW()+INTERVAL '2 minutes')*1000)::bigint)
      WHERE request_id=$1 AND user_id=$2 AND ${STOP_PROBE_STATE_FENCE}
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ${STOP_MODE_FENCE}
        AND jsonb_typeof(ctx->'boxAccountId')='string'
        AND jsonb_typeof(ctx->'boxRunNonce')='string'
        AND jsonb_typeof(ctx->'boxLeaseEpoch')='string'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'boxTerminalProof')
        AND (NOT (ctx ? 'boxOwnerRequestId')
          OR (jsonb_typeof(ctx->'boxOwnerRequestId')='string'
            AND ctx->>'boxOwnerRequestId' ~ '^[A-Za-z0-9_-]{1,64}$'))
        AND (($6::boolean AND ctx->>'boxOwnerRequestId' IS NOT NULL)
          OR (NOT $6::boolean AND NOT (ctx ? 'boxOwnerRequestId')))
        AND (NOT (ctx ? 'boxStopProbeAfterMs')
          OR (jsonb_typeof(ctx->'boxStopProbeAfterMs')='number'
            AND (ctx->>'boxStopProbeAfterMs') ~ '^[0-9]{13}$'
            AND (ctx->>'boxStopProbeAfterMs')::bigint
              <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.linked],
  );
  return changed.rowCount === 1;
}

export async function updateQuarantinePrelaunchRecovery(
  db: BoxBillingDb,
  input: { requestId: string; userId: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
       SET ctx=ctx || '{"boxPrelaunchRecoveryQuarantine":"invalid_evidence"}'::jsonb
     WHERE request_id=$1 AND user_id=$2 AND state='inflight'
       AND ctx->>'boxInvocationMode'='detached_tool'
       AND ctx ? 'boxPrelaunchControl' AND NOT (ctx ? 'boxLaunchPermit')
       AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')`,
    [input.requestId, input.userId],
  );
}

export async function updateClaimPrelaunchRecovery(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; receiptJson: string; patchJson: string; nowMs: number },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $7::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->'boxPrelaunchControl'=$6::jsonb
        AND NOT (ctx ? 'boxLaunchPermit') AND NOT (ctx ? 'boxTerminalProof')
        AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')
        AND ((ctx->>'boxState'='unknown') OR
          (ctx->>'boxState'='reserved' AND updated_at < NOW() - INTERVAL '16 minutes'))
        AND (NOT (ctx ? 'boxPrelaunchRetryAfterMs') OR
          (jsonb_typeof(ctx->'boxPrelaunchRetryAfterMs')='number'
           AND (ctx->>'boxPrelaunchRetryAfterMs') ~ '^[0-9]{13}$'
           AND (ctx->>'boxPrelaunchRetryAfterMs')::bigint <= $8))`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.receiptJson, input.patchJson, input.nowMs],
  );
  return changed.rowCount === 1;
}

export async function updateQuarantineRemoteCleanup(
  db: BoxBillingDb,
  input: { requestId: string; userId: string; terminalProofJson: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || '{"boxRemoteCleanupQuarantine":"invalid_evidence"}'::jsonb
      WHERE request_id=$1 AND user_id=$2
        AND ctx->'boxTerminalProof'=$3::jsonb
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ${CLEANUP_MODE_FENCE}
        AND ${CLEANUP_STATE_FENCE} AND ctx ? 'boxTerminalProof'
        AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
        AND NOT (ctx ? 'boxRemoteCleanupQuarantine')`,
    [input.requestId, input.userId, input.terminalProofJson],
  );
}

export async function updateClaimRemoteCleanup(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; proofJson: string; nativePointerJson: string | null },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object(
           'boxRemoteCleanupClaimed',true,
           'boxRemoteCleanupLastAttemptMs',
             (EXTRACT(EPOCH FROM NOW())*1000)::bigint,
           'boxRemoteCleanupRetryAfterMs',
            (EXTRACT(EPOCH FROM NOW()+INTERVAL '2 minutes')*1000)::bigint)
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
        AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
        AND ${CLEANUP_MODE_FENCE}
         AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
         AND ${CLEANUP_REPLAY_FENCE}
         AND ${CLEANUP_NATIVE_POINTER_GRACE}
        AND ctx->'boxTerminalProof'->>'runNonce'=$4
        AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
         AND ctx->'boxTerminalProof'=$6::jsonb
         AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
        AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
        AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
         AND (ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
           OR (jsonb_typeof(ctx->'boxRemoteCleanupRetryAfterMs')='number'
             AND (ctx->>'boxRemoteCleanupRetryAfterMs') ~ '^[0-9]{13}$'
             AND (ctx->>'boxRemoteCleanupRetryAfterMs')::bigint
               <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
           OR (NOT (ctx ? 'boxRemoteCleanupRetryAfterMs')
             AND updated_at <= NOW()-INTERVAL '2 minutes'))`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.proofJson, input.nativePointerJson],
  );
  return changed.rowCount === 1;
}

export async function updateMarkRemoteCleaned(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; proofJson: string; nativePointerJson: string | null },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || '{"boxRemoteCleanup":"done"}'::jsonb
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
        AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
        AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
        AND ${CLEANUP_MODE_FENCE}
        AND ctx->'boxTerminalProof'->>'runNonce'=$4
        AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
        AND ctx->'boxTerminalProof'=$6::jsonb
        AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
        AND ctx->>'boxRemoteCleanupClaimed'='true'
        AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
        AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.proofJson, input.nativePointerJson],
  );
  return changed.rowCount === 1;
}

// ── Hold release, failure, switch compaction, resume, rollover & temp mirror ──

export async function updateRecordRunAbsence(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; boot: string },
): Promise<{ rowCount: number | null; seen: unknown }> {
  const changed = await runBoxBillingQuery<{ seen: unknown }>(
    db,
    `WITH prior AS (
       SELECT ctx->'boxRunAbsent' AS seen FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE)
     UPDATE request_finalize_journal
        SET ctx=CASE WHEN ctx ? 'boxRunAbsent' THEN ctx
          ELSE ctx || jsonb_build_object('boxRunAbsent',jsonb_build_object('v',1,
            'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,'boot',$6::text)) END
       FROM prior
      WHERE request_id=$1 AND user_id=$2 AND ${STOP_PROBE_STATE_FENCE}
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND NOT (ctx ? 'boxResumeRequestId') AND NOT (ctx ? 'boxTerminalProof')
      RETURNING prior.seen`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.boot],
  );
  return { rowCount: changed.rowCount, seen: changed.rows[0]?.seen };
}

export async function updateClearRunAbsence(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; runNonce: string; leaseEpoch: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx - 'boxRunAbsent'
      WHERE request_id=$1 AND user_id=$2 AND ctx ? 'boxRunAbsent'
        AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4`,
    [input.requestId, input.uid.toString(), input.runNonce, input.leaseEpoch],
  );
}

export async function updateRecordAbandonedHandoffStop(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object('boxAbandonedHandoffStop',
          COALESCE(ctx->'boxAbandonedHandoffStop', jsonb_build_object(
            'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint)))
      WHERE request_id=$1 AND user_id=$2
        AND state IN ('inflight','finalizing','committed')
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxState'='handoff' AND ctx ? 'boxToolHandoff'
        AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
        AND ctx->>'boxLeaseEpoch'=$5
        AND NOT (ctx ? 'boxTerminalProof') AND NOT (ctx ? 'boxResumeRequestId')
        AND ${OWNER_CONTAINER_GONE}`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce, input.leaseEpoch],
  );
  return changed.rowCount === 1;
}

export async function updateRecordBoxFirstFailure(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string; evidenceJson: string; ownerRequestId: string | null },
): Promise<boolean> {
  const changed = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || jsonb_build_object('boxFirstFailure',$6::jsonb),updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
        AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
        AND ctx->>'boxOwnerRequestId' IS NOT DISTINCT FROM $7::text
        AND NOT (ctx ? 'boxFirstFailure') AND NOT (ctx ? 'boxReplayMessage')
        AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxUsage')`,
    [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
      input.leaseEpoch, input.evidenceJson, input.ownerRequestId],
  );
  return changed.rowCount === 1;
}

/** The compaction runs before the request's dispatch identity is known, so its usage row first
 * carries the container's session id. Once the proxy has the final (server-owned) session id it
 * relabels that one row, so per-session usage counts the compaction with its chat. Statistics
 * only: cost, ledger and journal are untouched. */
export async function relabelBoxSwitchSession(
  pool: Pick<Pool, "query">,
  input: { uid: bigint; billingRequestId: string; sessionId: string },
): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE usage_records SET session_id = $3
       WHERE user_id = $1 AND request_id = $2 AND session_id IS DISTINCT FROM $3`,
    [input.uid.toString(), input.billingRequestId, input.sessionId],
  );
  return updated.rowCount === 1;
}

export async function updateRetireUnsentResumeChild(
  db: BoxBillingDb,
  input: { unsentChildId: string; uid: bigint; ownerRequestId: string; unsentRevision: string; supersededByRequestId: string; unsentChildClaimSql: string },
): Promise<boolean> {
  const retiredChild = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal resume_child
        SET state='aborted',
            failure_code=COALESCE(failure_code,'UPSTREAM_UNAVAILABLE'),
            final_credits=0,
            error_msg=COALESCE(NULLIF(error_msg,''),'box_resume_unsent_superseded'),
            ctx=(resume_child.ctx
              - ARRAY['boxOwnerRequestId','boxInvocationMode','boxAccountId','boxRunNonce',
                'boxLeaseEpoch','boxResumeSpoolOffset','boxRoundNo','boxPriorMessageIds',
                'boxDetachedRunnerHash','boxCatalogHash','boxReplayFingerprint',
                'boxFallbackAlias','boxReplayRequired','boxRequestHash','boxContextHash',
                'boxImageIdentity','boxParentResumeRevision','boxUnknownPhase',
                'boxNativeSessionId','boxNativeCliCwd','boxNativeCliVersion',
                'boxNativePromptLayout']::text[])
              || jsonb_build_object('boxState','prestart_stopped','boxUnsentSupersededBy',$5::text),
            updated_at=NOW()
      WHERE resume_child.request_id=$1 AND resume_child.user_id=$2
        AND resume_child.ctx->>'boxOwnerRequestId'=$3
        AND resume_child.ctx->>'boxParentResumeRevision'=$4
        AND ${input.unsentChildClaimSql}`,
    [input.unsentChildId, input.uid.toString(), input.ownerRequestId,
      input.unsentRevision, input.supersededByRequestId],
  );
  return retiredChild.rowCount === 1;
}

export async function updateReclaimResumeOwner(
  db: BoxBillingDb,
  input: { ownerRequestId: string; uid: bigint; handoffRevision: unknown; unsentChildId: string; unsentRevision: string },
): Promise<boolean> {
  const reclaimedOwner = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=(ctx - ARRAY['boxResumeRequestId','boxResumeRevision','boxResumeResultHashes']::text[])
          || '{"boxState":"handoff"}'::jsonb,
            updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxState'='resuming' AND NOT (ctx ? 'boxCancelIntent')
        AND NOT (ctx ? 'boxRecoveredBy')
        AND state IN ('inflight','finalizing','committed')
        AND ctx->>'boxHandoffRevision'=$3
        AND ctx->>'boxResumeRequestId'=$4
        AND ctx->>'boxResumeRevision'=$5`,
    [input.ownerRequestId, input.uid.toString(), input.handoffRevision,
      input.unsentChildId, input.unsentRevision],
  );
  return reclaimedOwner.rowCount === 1;
}

export async function updateClaimResumeOwner(
  db: BoxBillingDb,
  input: { ownerRequestId: string; uid: bigint; handoffRevision: unknown; patchJson: string },
): Promise<boolean> {
  const claimedOwner = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
        AND state IN ('inflight','finalizing','committed')
        AND ctx->>'boxHandoffRevision'=$3`,
    [input.ownerRequestId, input.uid.toString(), input.handoffRevision, input.patchJson],
  );
  return claimedOwner.rowCount === 1;
}

export async function updateLinkResumeChild(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; canonicalModel: string; patchJson: string },
): Promise<{ rowCount: number | null; ctx: Record<string, unknown> | undefined }> {
  const linked = await runBoxBillingQuery<{ ctx: Record<string, unknown> }>(
    db,
    `UPDATE request_finalize_journal
        SET ctx=ctx || $4::jsonb, updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
        AND NOT (ctx ? 'boxState') RETURNING ctx`,
    [input.requestId, input.uid.toString(), input.canonicalModel, input.patchJson],
  );
  return { rowCount: linked.rowCount, ctx: linked.rows[0]?.ctx };
}

export async function updateRolloverMarkOwner(
  db: BoxBillingDb,
  input: { ownerRequestId: string; uid: bigint; handoffRevision: unknown; patchJson: string },
): Promise<boolean> {
  const owner = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb,updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxHandoffRevision'=$3
        AND ctx->>'boxState'='handoff' AND state IN ('inflight','finalizing','committed')
        AND NOT (ctx ? 'boxCancelIntent') AND NOT (ctx ? 'boxRecoveredBy')`,
    [input.ownerRequestId, input.uid.toString(), input.handoffRevision, input.patchJson],
  );
  return owner.rowCount === 1;
}

export async function updateRolloverMarkChild(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; patchJson: string; model: string },
): Promise<boolean> {
  const child = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $3::jsonb,updated_at=NOW()
      WHERE request_id=$1 AND user_id=$2 AND state='inflight'
        AND ctx->>'model'=$4 AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
        AND NOT (ctx ? 'boxState') AND NOT (ctx ? 'boxRolloverFrom')`,
    [input.requestId, input.uid.toString(), input.patchJson, input.model],
  );
  return child.rowCount === 1;
}

export async function updateRolloverRetireOldChain(
  db: BoxBillingDb,
  input: { uid: bigint; runNonce: string; leaseEpoch: string; patchJson: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb,updated_at=NOW()
      WHERE user_id=$1 AND ctx->>'boxRunNonce'=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxInvocationMode'='detached_tool' AND ctx->>'boxState'='failed_stopped'`,
    [input.uid.toString(), input.runNonce, input.leaseEpoch, input.patchJson],
  );
}

export async function updateRolloverMarkChildReady(
  db: BoxBillingDb,
  input: { uid: bigint; requestId: string; patchJson: string },
): Promise<boolean> {
  const ready = await runBoxBillingQuery(
    db,
    `UPDATE request_finalize_journal SET ctx=ctx || $3::jsonb,updated_at=NOW()
      WHERE user_id=$1 AND request_id=$2 AND state='inflight'
        AND NOT (ctx ? 'boxRolloverCancelled') AND NOT (ctx ? 'boxCancelIntent') AND NOT (ctx ? 'boxState')`,
    [input.uid.toString(), input.requestId, input.patchJson],
  );
  return ready.rowCount === 1;
}

export async function updateCancelToolRollovers(
  db: BoxBillingDb,
  input: { uid: bigint; containerId: bigint; sessionId: string; turnKey: string },
): Promise<{
  rowCount: number | null;
  rows: { request_id: string; state: string; ctx: Record<string, unknown> }[];
}> {
  return runBoxBillingQuery<{ request_id: string; state: string; ctx: Record<string, unknown> }>(
    db,
    `UPDATE request_finalize_journal
      SET ctx=ctx || '{"boxRolloverCancelled":true}'::jsonb ||
        CASE WHEN NOT (ctx ? 'boxState') AND ${UNADMITTED_TOOL_ROLLOVER_SQL}
        THEN '{"boxState":"prestart_stopped"}'::jsonb ELSE '{}'::jsonb END,updated_at=NOW()
      WHERE user_id=$1 AND container_id=$2 AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
        AND (state='inflight' OR (state='aborted' AND final_credits=0 AND ${UNADMITTED_TOOL_ROLLOVER_SQL}
          AND (NOT (ctx ? 'boxState') OR (ctx->>'boxState'='prestart_stopped'
            AND ctx->>'boxRolloverCancelled'='true'))))
        AND jsonb_typeof(ctx->'boxRolloverFrom')='object'
        AND ctx#>>'{boxRolloverFrom,requestId}'=request_id
        AND ctx#>>'{boxRolloverFrom,v}'='1'
        AND ctx#>>'{boxRolloverFrom,sessionId}'=$3 AND ctx#>>'{boxRolloverFrom,turnKey}'=$4
        AND ctx#>>'{boxRolloverFrom,model}'=ctx->>'model'
      RETURNING request_id,state,ctx`,
    [input.uid.toString(), input.containerId.toString(), input.sessionId, input.turnKey],
  );
}

export async function insertTempBoxJournalInflightRow(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; ctxJson: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    "INSERT INTO request_finalize_journal(request_id,user_id,state,precheck_credits,ctx) VALUES ($1,$2,'inflight',0,$3::jsonb)",
    [input.requestId, input.uid.toString(), input.ctxJson],
  );
}

export async function insertTempBoxJournalCommittedRow(
  db: BoxBillingDb,
  input: { requestId: string; uid: bigint; ctxJson: string },
): Promise<void> {
  await runBoxBillingQuery(
    db,
    "INSERT INTO request_finalize_journal(request_id,user_id,state,precheck_credits,ctx) VALUES ($1,$2,'committed',0,$3::jsonb)",
    [input.requestId, input.uid.toString(), input.ctxJson],
  );
}

export async function deleteTempBoxJournalRow(db: BoxBillingDb, requestId: string): Promise<void> {
  await runBoxBillingQuery(db, "DELETE FROM request_finalize_journal WHERE request_id=$1", [requestId]);
}

export async function deleteTempBoxJournalRowsForUser(
  db: BoxBillingDb,
  input: { uid: bigint; requestIds: readonly string[] },
): Promise<{ rowCount: number | null }> {
  const removed = await runBoxBillingQuery(
    db,
    "DELETE FROM request_finalize_journal WHERE user_id=$1 AND request_id=ANY($2::text[])",
    [input.uid.toString(), [...input.requestIds]],
  );
  return { rowCount: removed.rowCount };
}
