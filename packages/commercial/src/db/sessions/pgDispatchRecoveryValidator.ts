import type { PoolClient } from "pg";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  allowUnsafeAutomaticCheckpoint,
  maxAutomaticTurnRetryAttempt,
  shouldDeclineLiveServiceRestartRecovery,
  shouldReplayOriginalAfterEmptyExecution,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
} from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import {
  isLeftoverRecoveryRecordsTruncated,
  loadLeftoverRecoveryRecords,
  mergeTapeAndLeftoverRecoveryAssessment,
  sessionTurnHasSuccessfulUsage,
  terminalTurnRecordErrorCode,
} from "../sessionRecoveryEvidence.js";
import { recoveryWithoutCheckpointIsProven } from "./pgAutoRecoveryPolicy.js";
import type { AdmitUserTurnInput, AdmitUserTurnResult } from "./types.js";

export type RecoveryConfig = NonNullable<AdmitUserTurnInput["recovery"]>;

type FinalizedTapeRow = {
  tape_id: string;
  status: string;
  waive_reason: string | null;
  turn_key: string | null;
};

function withRecoveryMetadata(
  message: MessageLike & { id: string },
  recovery: RecoveryConfig,
): MessageLike & { id: string } {
  return {
    ...message,
    _recoveryOfClientMessageId: recovery.sourceClientMessageId,
    _recoveryMode: recovery.mode,
    _automaticRecovery: recovery.automatic,
    ...(recovery.automatic
      ? {
          _automaticRecoveryRootClientMessageId: recovery.rootClientMessageId,
          _automaticRecoveryAttempt: recovery.attempt,
          _automaticRecoveryMax: recovery.max,
        }
      : {}),
  };
}

function validateExistingRecoveryMessage(
  existingRecovery: MessageLike,
  recovery: RecoveryConfig,
): AdmitUserTurnResult | null {
  const baseMismatch =
    existingRecovery._recoveryOfClientMessageId !== recovery.sourceClientMessageId ||
    existingRecovery._recoveryMode !== recovery.mode ||
    existingRecovery._automaticRecovery !== recovery.automatic;
  const autoMismatch =
    recovery.automatic &&
    (existingRecovery._automaticRecoveryRootClientMessageId !== recovery.rootClientMessageId ||
      existingRecovery._automaticRecoveryAttempt !== recovery.attempt ||
      existingRecovery._automaticRecoveryMax !== recovery.max);
  return baseMismatch || autoMismatch
    ? { kind: "recovery_conflict", reason: "identity_reused" }
    : null;
}

function resolveAutomaticRecoveryLineage(
  latestUser: MessageLike,
  recovery: RecoveryConfig,
):
  | { ok: true; automaticRoot: string; automaticSourceAttempt: number }
  | { ok: false; result: AdmitUserTurnResult } {
  if (!recovery.automatic) {
    return { ok: true, automaticRoot: String(latestUser.id ?? ""), automaticSourceAttempt: 0 };
  }
  const automaticRoot =
    typeof latestUser._automaticRecoveryRootClientMessageId === "string"
      ? latestUser._automaticRecoveryRootClientMessageId
      : latestUser._automaticRecovery === true &&
          typeof latestUser._recoveryOfClientMessageId === "string"
        ? latestUser._recoveryOfClientMessageId
        : String(latestUser.id ?? "");
  const automaticSourceAttempt =
    typeof latestUser._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(latestUser._automaticRecoveryAttempt) &&
    latestUser._automaticRecoveryAttempt >= 1
      ? latestUser._automaticRecoveryAttempt
      : latestUser._automaticRecovery === true
        ? 1
        : 0;
  if (
    recovery.rootClientMessageId !== automaticRoot ||
    recovery.max !== AUTOMATIC_TURN_RETRY_MAX
  ) {
    return {
      ok: false,
      result: { kind: "recovery_conflict", reason: "automatic_lineage_mismatch" },
    };
  }
  return { ok: true, automaticRoot, automaticSourceAttempt };
}

function parseTapePayloads(rows: Array<{ payload: Buffer }>): unknown[] | null {
  const records: unknown[] = [];
  try {
    for (const row of rows) {
      const record = JSON.parse(Buffer.from(row.payload).toString("utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      records.push(record);
    }
    return records;
  } catch (err) {
    void err;
    return null;
  }
}

function checkFinalizedRecoveryPolicy(params: {
  recovery: RecoveryConfig;
  latestUser: MessageLike;
  finalized: FinalizedTapeRow;
  records: unknown[];
  leftoverRecords: unknown[];
  assessment: ReturnType<typeof mergeTapeAndLeftoverRecoveryAssessment>;
  finalizedErrorCode: string;
  hasSuccessfulUpstreamUsage: boolean;
}): AdmitUserTurnResult | null {
  const {
    recovery,
    latestUser,
    finalized,
    records,
    leftoverRecords,
    assessment,
    finalizedErrorCode,
    hasSuccessfulUpstreamUsage,
  } = params;
  const combinedRecords = [...records, ...leftoverRecords];
  const emptyOriginalReplay =
    recovery.automatic === true &&
    recovery.mode === "replay" &&
    shouldReplayOriginalAfterEmptyExecution({
      errorCode: finalizedErrorCode,
      records: combinedRecords,
      sourceIsAutomaticRecovery: latestUser._automaticRecovery === true,
      hasSuccessfulUpstreamUsage,
    });
  const replayOverSyntheticCheckpoint = emptyOriginalReplay && assessment.mode === "checkpoint";
  if (finalized.status === "completed" && assessment.mode !== "checkpoint") {
    return { kind: "recovery_conflict", reason: "completed_replay_forbidden" };
  }
  if (assessment.mode !== recovery.mode && !replayOverSyntheticCheckpoint) {
    return { kind: "recovery_conflict", reason: "recovery_mode_mismatch" };
  }
  if (
    recovery.automatic &&
    shouldDeclineLiveServiceRestartRecovery({
      errorCode: finalizedErrorCode,
      records,
      leftoverRecords,
      hasSuccessfulUpstreamUsage,
    })
  ) {
    return { kind: "recovery_conflict", reason: "automatic_checkpoint_unsafe" };
  }
  const unsafeCheckpoint =
    recovery.automatic &&
    assessment.mode === "checkpoint" &&
    !assessment.checkpointSafe &&
    !replayOverSyntheticCheckpoint &&
    (isLeftoverRecoveryRecordsTruncated(leftoverRecords) ||
      !allowUnsafeAutomaticCheckpoint({
        status: finalized.status,
        errorCode: finalizedErrorCode,
        leftoverBacked: assessment.leftoverBacked,
        records: combinedRecords,
      }));
  if (unsafeCheckpoint) {
    return { kind: "recovery_conflict", reason: "automatic_checkpoint_unsafe" };
  }
  const unprovenReplay =
    assessment.mode === "replay" &&
    !emptyOriginalReplay &&
    (!assessment.checkpointSafe || !recoveryWithoutCheckpointIsProven(finalizedErrorCode));
  if (unprovenReplay) {
    return { kind: "recovery_conflict", reason: "automatic_replay_not_proven" };
  }
  return null;
}

async function validateFinalizedTapeRecovery(
  client: PoolClient,
  input: AdmitUserTurnInput,
  recovery: RecoveryConfig,
  latestUser: MessageLike,
  finalized: FinalizedTapeRow,
  automaticRoot: string,
  automaticSourceAttempt: number,
): Promise<{ ok: true; authoritativeRetryAttempt: number } | { ok: false; result: AdmitUserTurnResult }> {
  const recordRows = (
    await client.query<{ payload: Buffer }>(
      `SELECT payload
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY ordinal`,
      [input.sessionId, input.sessionUserId, finalized.tape_id],
    )
  ).rows;
  const records = parseTapePayloads(recordRows);
  if (!records) {
    return { ok: false, result: { kind: "recovery_conflict", reason: "source_tape_malformed" } };
  }
  const leftoverRecords = await loadLeftoverRecoveryRecords(
    client,
    input.sessionId,
    input.sessionUserId,
    recovery.sourceClientMessageId,
  );
  const assessment = mergeTapeAndLeftoverRecoveryAssessment(records, leftoverRecords);
  const terminalErrorCode = terminalTurnRecordErrorCode(records);
  const finalizedErrorCode =
    terminalErrorCode ||
    (finalized.status === "crashed" || finalized.status === "interrupted"
      ? finalized.waive_reason ?? ""
      : "");
  if (!supportsAutomaticTurnRecovery(finalizedErrorCode)) {
    return { ok: false, result: { kind: "recovery_conflict", reason: "source_not_recoverable" } };
  }
  const hasSuccessfulUpstreamUsage = await sessionTurnHasSuccessfulUsage(
    client,
    input.uid,
    typeof finalized.turn_key === "string" ? finalized.turn_key : undefined,
  );
  const policyConflict = checkFinalizedRecoveryPolicy({
    recovery,
    latestUser,
    finalized,
    records,
    leftoverRecords,
    assessment,
    finalizedErrorCode,
    hasSuccessfulUpstreamUsage,
  });
  if (policyConflict) return { ok: false, result: policyConflict };

  const authoritativeRetryAttempt = recovery.automatic
    ? Math.max(automaticSourceAttempt, maxAutomaticTurnRetryAttempt(records, automaticRoot))
    : automaticSourceAttempt;
  return { ok: true, authoritativeRetryAttempt };
}

async function validateNewRecoverySource(
  client: PoolClient,
  input: AdmitUserTurnInput,
  recovery: RecoveryConfig,
  current: MessageLike[],
): Promise<AdmitUserTurnResult | null> {
  const latestUser = [...current].reverse().find((item) => item?.role === "user");
  if (!latestUser || latestUser.id !== recovery.sourceClientMessageId) {
    return { kind: "recovery_conflict", reason: "source_not_latest" };
  }
  const lineage = resolveAutomaticRecoveryLineage(latestUser, recovery);
  if (!lineage.ok) return lineage.result;

  const sourceIndex = current.lastIndexOf(latestUser);
  const recoverableHotTapeError = current
    .slice(sourceIndex + 1)
    .some(
      (item) =>
        item?.role === "assistant" &&
        item._clientMessageId === recovery.sourceClientMessageId &&
        supportsAutomaticTurnRecovery(String(item._errorCode ?? "")),
    );
  const dispatchFailure = (
    await client.query<{ outcome: string; failure_code: string | null }>(
      `SELECT outcome, failure_code
         FROM turn_dispatches
        WHERE user_id=$1 AND session_id=$2 AND client_message_id=$3
          AND status='terminal'
        LIMIT 1`,
      [input.uid, input.sessionId, recovery.sourceClientMessageId],
    )
  ).rows[0];
  const finalized = (
    await client.query<FinalizedTapeRow>(
      `SELECT tape_id,status,waive_reason,turn_key
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2
          AND client_message_id=$3
          AND finalized_at IS NOT NULL
        ORDER BY finalized_at DESC,tape_id
        LIMIT 1`,
      [input.sessionId, input.sessionUserId, recovery.sourceClientMessageId],
    )
  ).rows[0];

  let authoritativeRetryAttempt = lineage.automaticSourceAttempt;
  if (finalized) {
    const validated = await validateFinalizedTapeRecovery(
      client,
      input,
      recovery,
      latestUser,
      finalized,
      lineage.automaticRoot,
      lineage.automaticSourceAttempt,
    );
    if (!validated.ok) return validated.result;
    authoritativeRetryAttempt = validated.authoritativeRetryAttempt;
  } else {
    const dispatchErrorCode = dispatchFailure?.failure_code ?? "";
    if (!recoverableHotTapeError && !supportsAutomaticTurnRecovery(dispatchErrorCode)) {
      return { kind: "recovery_conflict", reason: "source_not_recoverable" };
    }
    if (
      recovery.mode !== "replay" ||
      dispatchFailure?.outcome !== "not_accepted" ||
      !recoveryWithoutCheckpointIsProven(dispatchErrorCode)
    ) {
      return { kind: "recovery_conflict", reason: "source_not_safely_replayable" };
    }
  }
  if (
    recovery.automatic &&
    (authoritativeRetryAttempt >= AUTOMATIC_TURN_RETRY_MAX ||
      recovery.attempt !== authoritativeRetryAttempt + 1)
  ) {
    return {
      kind: "recovery_conflict",
      reason:
        authoritativeRetryAttempt >= AUTOMATIC_TURN_RETRY_MAX
          ? "automatic_retry_exhausted"
          : "automatic_attempt_mismatch",
    };
  }
  return null;
}

export async function validateAndPrepareRecoveryMessage(
  client: PoolClient,
  input: AdmitUserTurnInput,
  recovery: RecoveryConfig,
): Promise<{ ok: true; message: MessageLike & { id: string } } | { ok: false; result: AdmitUserTurnResult }> {
  const expected = recovery.automatic
    ? turnRecoveryAttemptIdentity(input.sessionId, recovery.rootClientMessageId, recovery.attempt)
    : turnRecoveryIdentity(input.sessionId, recovery.sourceClientMessageId);
  if (expected.clientMessageId !== input.clientMessageId) {
    return { ok: false, result: { kind: "recovery_conflict", reason: "identity_mismatch" } };
  }
  const locked = (
    await client.query<{ messages: string; deleted_at: string | null }>(
      `SELECT messages, deleted_at
         FROM client_sessions
        WHERE id=$1 AND user_id=$2
        FOR UPDATE`,
      [input.sessionId, input.sessionUserId],
    )
  ).rows[0];
  if (!locked) return { ok: false, result: { kind: "session_not_found" } };
  if (locked.deleted_at !== null) return { ok: false, result: { kind: "session_deleted" } };

  let current: MessageLike[];
  try {
    const parsed = JSON.parse(locked.messages);
    if (!Array.isArray(parsed)) throw new Error("not array");
    current = parsed as MessageLike[];
  } catch (err) {
    void err;
    return { ok: false, result: { kind: "recovery_conflict", reason: "session_history_malformed" } };
  }
  const existingRecovery = current.find(
    (item) => item?.role === "user" && item.id === input.clientMessageId,
  );
  const conflict = existingRecovery
    ? validateExistingRecoveryMessage(existingRecovery, recovery)
    : await validateNewRecoverySource(client, input, recovery, current);
  if (conflict) return { ok: false, result: conflict };
  return { ok: true, message: withRecoveryMetadata(input.message, recovery) };
}
