import type { LosslessTurnTapeFinalizeRequest } from "@openclaude/protocol";
import { isTransientTapeError } from "../visibleFinalize.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import {
  runFinalizeLosslessTurnTapeTx,
  type FinalizeTxOutcome,
} from "./pgTurnTapeFinalizeTx.js";
import {
  backfillEmptyVisibleHeadFromPrepared,
  commitVisibleLosslessTurnPhaseA,
} from "./pgTurnTapePhaseAStore.js";
import {
  _prepareLosslessTurnTapeOutsideLocks,
  acquireFinalizeMemoryAdmission,
  claimLosslessTurnTapeStorageFormat,
  inspectLateDelegateContinuationAgainstRoot,
  isLateDelegateContinuationAgentId,
  isLosslessTurnTapeReadyForPreparation,
  preparedModelSidecarManifest,
  readTurnTapeRecoveryLink,
} from "./pgTurnTapePrepAndInspect.js";
import { _stagePreparedLosslessTurnRecords } from "./pgTurnTapeStageStore.js";
import {
  _losslessFinalizeSingleflightKey,
  notifyGoalUsageChanges,
  notifyRecoveryJobTerminals,
  withTx,
} from "./sqlHelpers.js";
import {
  TurnTapeRecoveryLockUpgrade,
  type LosslessTurnTapeFinalizeResult,
  type PgSessionsBackendOptions,
  type PreparedLosslessTurnTape,
} from "./types.js";

type PreparedStageOutcome =
  | { kind: "early"; result: LosslessTurnTapeFinalizeResult }
  | {
      kind: "ready";
      prepared: PreparedLosslessTurnTape | null;
      preparedModelRecordCount: number;
      releaseAdmission: (() => void) | null;
    };

async function prepareAndStageForFinalize(
  ctx: PgSessionsCtx,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  phaseA: LosslessTurnTapeFinalizeResult | null,
): Promise<PreparedStageOutcome> {
  let releaseAdmission: (() => void) | null = acquireFinalizeMemoryAdmission(request.totalBytes);
  try {
    const recordStorageFormat = await claimLosslessTurnTapeStorageFormat(
      ctx.pool,
      userId,
      request,
      ctx.deps,
    );
    const prepared = recordStorageFormat === null
      ? null
      : await _prepareLosslessTurnTapeOutsideLocks(
          ctx.pool,
          userId,
          request,
          recordStorageFormat,
          ctx.deps,
        );
    if (!prepared) {
      releaseAdmission();
      releaseAdmission = null;
      return { kind: "ready", prepared: null, preparedModelRecordCount: 0, releaseAdmission: null };
    }
    const preparedModelRecordCount = preparedModelSidecarManifest(prepared).length;
    await backfillEmptyVisibleHeadFromPrepared(ctx.pool, userId, request, prepared);
    await _stagePreparedLosslessTurnRecords(ctx.pool, userId, request, prepared);
    return { kind: "ready", prepared, preparedModelRecordCount, releaseAdmission };
  } catch (err) {
    releaseAdmission?.();
    releaseAdmission = null;
    if (
      err &&
      typeof err === "object" &&
      (err as { lateDelegateRootIdempotent?: unknown }).lateDelegateRootIdempotent === true
    ) {
      return {
        kind: "early",
        result: { applied: "idempotent", recordCount: 0, engineBillings: [] },
      };
    }
    if (phaseA && phaseA.applied === "finalized" && isTransientTapeError(err)) {
      return { kind: "early", result: { ...phaseA, settlementHandoff: true } };
    }
    throw err;
  }
}

async function executeFinalizeTxWithLockUpgrade(
  ctx: PgSessionsCtx,
  input: {
    userId: string;
    request: LosslessTurnTapeFinalizeRequest;
    billingUserId: bigint | null;
    phaseA: LosslessTurnTapeFinalizeResult | null;
    prepared: PreparedLosslessTurnTape | null;
    preparedModelRecordCount: number;
  },
): Promise<FinalizeTxOutcome> {
  let recoveryLockHint = await readTurnTapeRecoveryLink(
    ctx.pool,
    input.request.sessionId,
    input.userId,
    input.request.tapeId,
  );
  for (let lockAttempt = 0; lockAttempt < 2; lockAttempt++) {
    try {
      return await withTx(ctx.pool, (client) =>
        runFinalizeLosslessTurnTapeTx(client, {
          userId: input.userId,
          request: input.request,
          billingUserId: input.billingUserId,
          recoveryLockHint,
          phaseA: input.phaseA,
          prepared: input.prepared,
          preparedModelRecordCount: input.preparedModelRecordCount,
          deps: ctx.deps,
        }));
    } catch (error) {
      if (error instanceof TurnTapeRecoveryLockUpgrade && lockAttempt === 0) {
        recoveryLockHint = error.link;
        continue;
      }
      throw error;
    }
  }
  throw new Error("lossless turn tape recovery lock upgrade exhausted");
}

async function publishFinalizePostCommitCallbacks(
  options: PgSessionsBackendOptions,
  userId: string,
  sessionId: string,
  outcome: FinalizeTxOutcome,
): Promise<void> {
  if (outcome.result.applied !== "finalized") return;
  if (outcome.goalUsageChanged) {
    await notifyGoalUsageChanges(options.onGoalUsageChanged, [{ userId, sessionId }]);
  }
  // Includes recoveryDecision == null (clean completed child / recovered path).
  await notifyRecoveryJobTerminals(
    options.onRecoveryJobTerminal,
    userId,
    sessionId,
    outcome.recoveryJobTerminals,
  );
  if (outcome.recoveryDecision && options.onAutomaticRecoveryDecision) {
    // Sideband only: a failed broadcast must not fail the finalize (the
    // durable job / terminal card already committed; the browser will
    // converge via outbound.ack{recovery} or history sync instead).
    await Promise.allSettled([
      Promise.resolve(
        options.onAutomaticRecoveryDecision(userId, sessionId, outcome.recoveryDecision),
      ),
    ]);
  }
}

async function runLateDelegateGate(
  ctx: PgSessionsCtx,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  deps: PgSessionsDeps,
): Promise<LosslessTurnTapeFinalizeResult | null> {
  if (!isLateDelegateContinuationAgentId(request.agentId)) return null;
  const lateDelegateRoot = await inspectLateDelegateContinuationAgainstRoot(
    ctx.pool,
    userId,
    request,
    deps,
  );
  if (lateDelegateRoot === "retry") return { applied: "incomplete" };
  if (lateDelegateRoot === "idempotent") {
    return { applied: "idempotent", recordCount: 0, engineBillings: [] };
  }
  return null;
}

async function runFinalizeLosslessTurnTape(
  ctx: PgSessionsCtx,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  finalizeOptions?: { materialize?: boolean },
): Promise<LosslessTurnTapeFinalizeResult> {
  // Personal/test namespaces also use this backend in some deployments,
  // but only `c:<uid>` sessions participate in commercial settlement.
  const billingUserId = /^c:[1-9][0-9]*$/.test(userId)
    ? ctx.deps.billing.numericCommercialUserId(userId)
    : null;
  if (request.waiveReason !== undefined && billingUserId === null) {
    throw new Error("turn waiver requires a commercial c:<uid> session owner");
  }
  // Validate the cheap immutable header + part manifest before reserving
  // physical materialization memory. A partial upload must return
  // `incomplete`; it must never occupy admission and stall unrelated
  // completed turns.
  const readyForPreparation = await isLosslessTurnTapeReadyForPreparation(
    ctx.pool,
    userId,
    request,
  );
  let phaseA: LosslessTurnTapeFinalizeResult | null = null;
  if (readyForPreparation) {
    const lateGate = await runLateDelegateGate(ctx, userId, request, ctx.deps);
    if (lateGate) return lateGate;
    // HTTP action:finalize (materialize:false) is the job's creation point.
    // Worker Phase B must not re-enqueue, or ON CONFLICT would stomp a live lease.
    phaseA = await commitVisibleLosslessTurnPhaseA(ctx.pool, userId, request, ctx.deps, {
      enqueueMaterialization: finalizeOptions?.materialize === false,
    });
    if (
      phaseA.applied === "session_not_found" ||
      phaseA.applied === "session_deleted" ||
      phaseA.applied === "incomplete"
    ) {
      return phaseA;
    }
  }
  if (finalizeOptions?.materialize === false) {
    return phaseA ?? { applied: "incomplete" };
  }

  let prepared: PreparedLosslessTurnTape | null = null;
  let preparedModelRecordCount = 0;
  let releaseAdmission: (() => void) | null = null;
  if (readyForPreparation) {
    const staged = await prepareAndStageForFinalize(ctx, userId, request, phaseA);
    if (staged.kind === "early") return staged.result;
    prepared = staged.prepared;
    preparedModelRecordCount = staged.preparedModelRecordCount;
    releaseAdmission = staged.releaseAdmission;
  }

  let outcome: FinalizeTxOutcome;
  try {
    outcome = await executeFinalizeTxWithLockUpgrade(ctx, {
      userId,
      request,
      billingUserId,
      phaseA,
      prepared,
      preparedModelRecordCount,
    });
  } finally {
    releaseAdmission?.();
  }
  await publishFinalizePostCommitCallbacks(ctx.options, userId, request.sessionId, outcome);
  return outcome.result;
}

export function createPgTurnTapeFinalizeStore(ctx: PgSessionsCtx): {
  finalizeLosslessTurnTape(
    userId: string,
    request: LosslessTurnTapeFinalizeRequest,
    finalizeOptions?: { materialize?: boolean },
  ): Promise<LosslessTurnTapeFinalizeResult>;
} {
  return {
    async finalizeLosslessTurnTape(userId, request, finalizeOptions) {
      const flight = ctx.finalizeSingleflight(
        _losslessFinalizeSingleflightKey(userId, request),
        () => runFinalizeLosslessTurnTape(ctx, userId, request, finalizeOptions),
      );
      const completed = await flight.promise;
      return flight.shared && completed.applied === "finalized"
        ? { ...completed, applied: "idempotent" }
        : completed;
    },
  };
}
