import type { Pool, PoolClient } from "pg";
import { WebSocket } from "ws";
import { isClientMessageId, MODEL_AUTHORITY_FIELD } from "@openclaude/protocol";
import { releasePreCheck } from "../../billing/preCheck.js";
import {
  abortNeverExecutedJournalForDispatch,
  type AbortedJournalRef,
} from "../../dispatch/turnDispatchReconciler.js";
import {
  casAdmittedToRejecting,
  casToTerminal,
  DISPATCH_LEASE_TTL_MS,
  heartbeatLease,
} from "../../dispatch/turnDispatchStore.js";
import {
  pauseRecoveryPreReceipt,
  releaseRecoveryPreReceipt,
  type ClaimedRecoveryJob,
} from "../../dispatch/turnRecoveryStore.js";
import { recordProductFrictionEvent } from "../../productFriction/events.js";
import { systemHelpDispatchFields } from "../../system-assistant/helpBridge.js";
import { _recoveryRefusalAction } from "../modelSwitchCostGuard.js";
import { extractCrossPoolCheckpointGeneration } from "../userChatBridgeRemotePoolSeal.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { CRON_ORIGIN_RECEIPT_WAIT_MS } from "./constants.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  CodexTurnSnapshot,
  CronOriginExecutorClaimResult,
  EnrichmentDispatchState,
  PreForwardFailOpts,
} from "./types.js";

export function trackSealedMigration(
  ctx: BridgeConnectionCtx,
  rec: AdmittedDispatch | undefined,
  sk: string | null | undefined,
  sealed: Record<string, unknown>,
): void {
  const envelope = sealed[MODEL_AUTHORITY_FIELD] as
    | { payload?: { poolMigration?: { migrationId?: string; placementEpoch?: number; continuityTier?: string } } }
    | undefined;
  const pm = envelope?.payload?.poolMigration;
  if (!rec || !pm?.migrationId || typeof pm.placementEpoch !== "number" || typeof sk !== "string" || !sk) {
    return;
  }
  const cpGen = extractCrossPoolCheckpointGeneration(sealed);
  rec.pendingMigrationInstall = {
    sessionKey: sk,
    placementEpoch: pm.placementEpoch,
    migrationId: pm.migrationId,
    ...(pm.continuityTier ? { continuityTier: pm.continuityTier } : {}),
    ...(cpGen ? { checkpointGeneration: cpGen } : {}),
  };
  ctx.pendingMigrationInstalls.set(rec.clientMessageId, rec);
}

export function settleCronOriginClaim(
  ctx: BridgeConnectionCtx,
  dispatchId: string,
  result: CronOriginExecutorClaimResult,
): void {
  const waiter = ctx.cronOriginClaimWaiters.get(dispatchId);
  if (!waiter) return;
  ctx.cronOriginClaimWaiters.delete(dispatchId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
}

export function beginCronOriginClaim(
  ctx: BridgeConnectionCtx,
  dispatchId: string,
): Promise<CronOriginExecutorClaimResult> {
  const existing = ctx.cronOriginClaimWaiters.get(dispatchId);
  if (existing) return existing.promise;
  let resolve!: (result: CronOriginExecutorClaimResult) => void;
  const promise = new Promise<CronOriginExecutorClaimResult>((done) => {
    resolve = done;
  });
  const timer = setTimeout(
    () => settleCronOriginClaim(ctx, dispatchId, { kind: "delivery_unknown" }),
    CRON_ORIGIN_RECEIPT_WAIT_MS,
  );
  timer.unref?.();
  ctx.cronOriginClaimWaiters.set(dispatchId, { promise, resolve, timer });
  return promise;
}

export function hasPendingDispatchWork(ctx: BridgeConnectionCtx): boolean {
  return (
    ctx.preparationInFlight > 0 ||
    ctx.admittedDispatches.size > 0 ||
    ctx.enrichmentDispatches.size > 0 ||
    ctx.inFlightOutboundPersists > 0
  );
}

export function hasPreTransferDispatchWork(ctx: BridgeConnectionCtx): boolean {
  return ctx.preparationInFlight > 0 || ctx.enrichmentDispatches.size > 0;
}

export function hasOpenDispatchStreams(ctx: BridgeConnectionCtx): boolean {
  return ctx.linkHandle?.hasOpenDispatches ?? false;
}

export function noteDispatchStreamFrame(
  ctx: BridgeConnectionCtx,
  sessionId: string,
  clientMessageId: string,
  isFinal: boolean,
): void {
  ctx.linkHandle?.noteStream(sessionId, clientMessageId, isFinal);
}

export function dropAdmittedDispatch(
  ctx: BridgeConnectionCtx,
  clientMessageId: string,
): void {
  if (ctx.admittedDispatches.delete(clientMessageId)) ctx.checkDrainComplete();
}

export function isEnriching(
  state: EnrichmentDispatchState | null | undefined,
): state is EnrichmentDispatchState {
  return state !== null && state !== undefined && state.phase === "enriching";
}

export function claimEnrichmentTerminalization(
  ctx: BridgeConnectionCtx,
  state: EnrichmentDispatchState,
): boolean {
  if (state.phase !== "enriching" && state.phase !== "transferring") return false;
  state.phase = "terminalizing";
  ctx.enrichmentDeadlineChecks.delete(state);
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return true;
}

export function broadcastRecoveryJobRefused(
  ctx: BridgeConnectionCtx,
  job: ClaimedRecoveryJob,
  reason: string,
): void {
  const rawReq = job.request as { clientMessageId?: unknown; idempotencyKey?: unknown };
  const cmid = isClientMessageId(rawReq.clientMessageId) ? rawReq.clientMessageId : undefined;
  if (!cmid) return;
  try {
    ctx.shared.broadcastToUser(ctx.uid, {
      type: "outbound.ack",
      admitted: false,
      recoverySkipped: true,
      recoverySkippedReason: reason,
      sourceClientMessageId: job.sourceClientMessageId,
      ...(typeof rawReq.idempotencyKey === "string"
        ? { idempotencyKey: rawReq.idempotencyKey }
        : {}),
      peer: { id: job.sessionId, kind: "dm" },
      clientMessageId: cmid,
    });
  } catch (err) {
    void err;
  }
}

async function resolveRecoveryPreReceiptFailure(
  ctx: BridgeConnectionCtx,
  pool: Pool,
  record: AdmittedDispatch,
  failureCode: string,
  opts?: PreForwardFailOpts,
): Promise<void> {
  const job = record.recoveryJob;
  if (!job) return;
  const refusalKey = `${job.jobId}:${job.leaseEpoch}`;
  const refusal =
    ctx.refusedRecoveryJobs.get(refusalKey) ??
    (_recoveryRefusalAction(failureCode) === "pause" ? failureCode : undefined);
  ctx.refusedRecoveryJobs.delete(refusalKey);
  const fenced = {
    job,
    dispatchId: record.dispatchId,
    dispatchOwner: record.leaseOwnerId,
    dispatchLeaseEpoch: record.leaseEpoch,
  };
  if (refusal !== undefined) {
    const paused = await pauseRecoveryPreReceipt(pool, { ...fenced, reason: refusal });
    if (paused) {
      broadcastRecoveryJobRefused(ctx, job, refusal);
      opts?.onTerminal?.();
    }
  } else {
    await releaseRecoveryPreReceipt(pool, fenced);
  }
}

export async function settlePreForwardDispatch(
  ctx: BridgeConnectionCtx,
  pool: Pool,
  record: AdmittedDispatch,
  failureCode: string,
  opts: Omit<PreForwardFailOpts, "onTerminal"> = {},
): Promise<boolean> {
  const txCapable = typeof (pool as { connect?: unknown }).connect === "function";
  let txClient: PoolClient | null = null;
  let aborted: AbortedJournalRef[] = [];
  let committed = false;
  let terminalHit = false;
  try {
    txClient = txCapable ? await pool.connect() : null;
    const runner: Pool | PoolClient = txClient ?? pool;
    if (txClient !== null) await txClient.query("BEGIN");
    const terminal = await casToTerminal(runner, {
      dispatchId: record.dispatchId,
      outcome: "executed_error",
      failureCode,
      clientNotified: false,
      expectedEpoch: record.leaseEpoch,
      ...(opts.fromStatuses === undefined ? {} : { fromStatuses: opts.fromStatuses }),
    });
    if (terminal !== null && opts.abortNeverExecutedJournal === true && txClient !== null) {
      aborted = await abortNeverExecutedJournalForDispatch(txClient, record.dispatchId);
    }
    if (txClient !== null) await txClient.query("COMMIT");
    committed = true;
    terminalHit = terminal !== null;
  } catch (error) {
    if (txClient !== null) {
      try {
        await txClient.query("ROLLBACK");
      } catch (rollbackErr) {
        void rollbackErr;
      }
    }
    ctx.bridgeLog?.warn("user-chat-bridge: pre-forward terminalize failed", {
      dispatchId: record.dispatchId,
      failureCode,
      error,
    });
  } finally {
    if (txClient !== null) txClient.release();
  }
  if (!committed) return false;
  const redis = ctx.shared.deps.preCheckRedis;
  if (redis !== undefined) {
    for (const ref of aborted) {
      await releasePreCheck(redis, ref).catch((err) => {
        void err;
      });
    }
  }
  return terminalHit;
}

export function terminalizeEnrichmentDispatch(
  ctx: BridgeConnectionCtx,
  state: EnrichmentDispatchState,
  failureCode: string,
  opts?: PreForwardFailOpts,
): boolean {
  const wasTransferring = state.phase === "transferring";
  if (!claimEnrichmentTerminalization(ctx, state)) return false;
  const record = state.record;
  const pool = ctx.shared.deps.pgPool;
  void (async (): Promise<void> => {
    try {
      if (!pool) return;
      if (
        failureCode === "bridge_closed_during_admission" &&
        (!record.recoveryJob || wasTransferring)
      ) {
        await casAdmittedToRejecting(pool, {
          dispatchId: record.dispatchId,
          expectedEpoch: record.leaseEpoch,
          ownerId: "bridge-admission-handoff",
        });
      } else if (record.recoveryJob) {
        await resolveRecoveryPreReceiptFailure(ctx, pool, record, failureCode, opts);
      } else {
        const settled = await settlePreForwardDispatch(ctx, pool, record, failureCode, {
          abortNeverExecutedJournal: opts?.abortNeverExecutedJournal === true,
          fromStatuses: ["admitted"],
        });
        if (settled) opts?.onTerminal?.();
      }
    } catch (err) {
      ctx.bridgeLog?.error("user-chat-bridge: pre-transfer dispatch terminalization failed", {
        dispatchId: record.dispatchId,
        failureCode,
        err,
      });
    } finally {
      settleCronOriginClaim(ctx, record.dispatchId, { kind: "delivery_unknown" });
      if (ctx.enrichmentDispatches.get(record.clientMessageId) === state) {
        ctx.enrichmentDispatches.delete(record.clientMessageId);
      }
      dropAdmittedDispatch(ctx, record.clientMessageId);
    }
  })();
  return true;
}

export function trackEnrichmentDispatch(
  ctx: BridgeConnectionCtx,
  record: AdmittedDispatch,
  closedFailureCode = "bridge_closed_during_admission",
): EnrichmentDispatchState {
  const existing = ctx.enrichmentDispatches.get(record.clientMessageId);
  if (existing && existing.record === record) return existing;
  const state: EnrichmentDispatchState = {
    record,
    phase: "enriching",
    closedFailureCode,
    deadlineAt: Date.now() + ctx.shared.config.promptQueuePreparationTimeoutMs,
    timer: null,
  };
  ctx.enrichmentDispatches.set(record.clientMessageId, state);
  const expireIfDue = (): boolean => {
    if (state.phase !== "enriching" || Date.now() < state.deadlineAt) return false;
    if (!terminalizeEnrichmentDispatch(ctx, state, "dispatch_enrichment_timeout")) return false;
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs,
        "DISPATCH_ENRICHMENT_TIMEOUT",
        "session context took too long to prepare; retry this turn",
        { peerId: record.sessionId, clientMessageId: record.clientMessageId },
      );
    }
    return true;
  };
  ctx.enrichmentDeadlineChecks.set(state, expireIfDue);
  const armDeadlineTimer = (): void => {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.phase !== "enriching") return;
      if (Date.now() < state.deadlineAt) {
        armDeadlineTimer();
        return;
      }
      expireIfDue();
    }, Math.max(0, state.deadlineAt - Date.now()));
    state.timer.unref?.();
  };
  armDeadlineTimer();
  if (ctx.cleaned) {
    terminalizeEnrichmentDispatch(ctx, state, closedFailureCode);
  }
  return state;
}

export function terminalizeAllEnriching(ctx: BridgeConnectionCtx): void {
  for (const state of [...ctx.enrichmentDispatches.values()]) {
    terminalizeEnrichmentDispatch(ctx, state, state.closedFailureCode);
  }
}

export function beginEnrichmentTransfer(
  ctx: BridgeConnectionCtx,
  record: AdmittedDispatch | undefined,
): EnrichmentDispatchState | null {
  if (record === undefined) return null;
  const state = ctx.enrichmentDispatches.get(record.clientMessageId);
  if (!state || state.record !== record) return null;
  if (ctx.enrichmentDeadlineChecks.get(state)?.() === true) return null;
  if (state.phase !== "enriching") return null;
  state.phase = "transferring";
  ctx.enrichmentDeadlineChecks.delete(state);
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return state;
}

export function acceptEnrichmentReceipt(
  ctx: BridgeConnectionCtx,
  record: AdmittedDispatch,
): boolean {
  const state = ctx.enrichmentDispatches.get(record.clientMessageId);
  if (!state) return true;
  if (state.record !== record || state.phase === "terminalizing") return false;
  if (state.phase !== "enriching" && state.phase !== "transferring") {
    return state.phase === "transferred";
  }
  state.phase = "transferred";
  ctx.enrichmentDeadlineChecks.delete(state);
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  ctx.enrichmentDispatches.delete(record.clientMessageId);
  ctx.checkDrainComplete();
  return true;
}

export function completeEnrichmentTransfer(
  ctx: BridgeConnectionCtx,
  state: EnrichmentDispatchState | null,
): void {
  if (state) acceptEnrichmentReceipt(ctx, state.record);
}

export function ensureDispatchHeartbeat(ctx: BridgeConnectionCtx): void {
  if (ctx.dispatchHeartbeatTimer !== null || !ctx.shared.deps.pgPool) return;
  ctx.dispatchHeartbeatTimer = setInterval(() => {
    const pool = ctx.shared.deps.pgPool;
    if (!pool) return;
    const now = Date.now();
    for (const rec of [...ctx.admittedDispatches.values()]) {
      const enrichState = ctx.enrichmentDispatches.get(rec.clientMessageId);
      const isEnrichingPhase = enrichState?.phase === "enriching";
      if (!isEnrichingPhase) {
        if (rec.wireSent === false) continue;
        if (
          rec.admittedAtMs !== undefined &&
          now - rec.admittedAtMs > ctx.shared.config.admittedRenewMaxAgeMs
        ) {
          continue;
        }
      }
      void heartbeatLease(pool, {
        dispatchId: rec.dispatchId,
        ownerId: rec.leaseOwnerId,
        leaseEpoch: rec.leaseEpoch,
        leaseTtlMs: DISPATCH_LEASE_TTL_MS,
      })
        .then((held) => {
          if (!held) dropAdmittedDispatch(ctx, rec.clientMessageId);
        })
        .catch((err) => {
          void err;
        });
    }
  }, ctx.shared.config.dispatchLeaseHeartbeatMs);
  ctx.dispatchHeartbeatTimer.unref?.();
}

export function failDispatchPreForward(
  ctx: BridgeConnectionCtx,
  record: AdmittedDispatch | undefined,
  failureCode: string,
  opts?: PreForwardFailOpts,
): void {
  if (record === undefined) return;
  const enrichment = ctx.enrichmentDispatches.get(record.clientMessageId);
  if (enrichment?.record === record) {
    if (enrichment.phase === "terminalizing") return;
    if (terminalizeEnrichmentDispatch(ctx, enrichment, failureCode, opts)) return;
  }
  const pool = ctx.shared.deps.pgPool;
  settleCronOriginClaim(ctx, record.dispatchId, { kind: "delivery_unknown" });
  dropAdmittedDispatch(ctx, record.clientMessageId);
  if (!pool) return;
  if (record.recoveryJob) {
    const refusalKey = `${record.recoveryJob.jobId}:${record.recoveryJob.leaseEpoch}`;
    const refusal =
      ctx.refusedRecoveryJobs.get(refusalKey) ??
      (_recoveryRefusalAction(failureCode) === "pause" ? failureCode : undefined);
    ctx.refusedRecoveryJobs.delete(refusalKey);
    const fenced = {
      job: record.recoveryJob,
      dispatchId: record.dispatchId,
      dispatchOwner: record.leaseOwnerId,
      dispatchLeaseEpoch: record.leaseEpoch,
    };
    if (refusal !== undefined) {
      const pausedJob = record.recoveryJob;
      void pauseRecoveryPreReceipt(pool, { ...fenced, reason: refusal })
        .then((paused) => {
          if (!paused) return;
          broadcastRecoveryJobRefused(ctx, pausedJob, refusal);
          opts?.onTerminal?.();
        })
        .catch((err) => {
          void err;
        });
    } else {
      ctx.shared.trackRecoveryPromise(releaseRecoveryPreReceipt(pool, fenced));
    }
    return;
  }
  const { onTerminal, ...settleOpts } = opts ?? {};
  void settlePreForwardDispatch(ctx, pool, record, failureCode, settleOpts)
    .then((settled) => {
      if (settled) onTerminal?.();
    })
    .catch((err) => {
      void err;
    });
}

export function lookupAdmittedDispatch(
  ctx: BridgeConnectionCtx,
  frameObj: Record<string, unknown>,
): AdmittedDispatch | undefined {
  const prepared = ctx.preparedEnrichmentFrames.get(frameObj);
  if (prepared !== undefined) {
    ctx.preparedEnrichmentFrames.delete(frameObj);
    if (prepared.phase !== "enriching") return undefined;
    if (ctx.enrichmentDeadlineChecks.get(prepared)?.() === true) return undefined;
    if (prepared.phase !== "enriching") return undefined;
    return prepared.record;
  }
  const cmid = isClientMessageId(frameObj.clientMessageId) ? frameObj.clientMessageId : null;
  return cmid === null ? undefined : ctx.admittedDispatches.get(cmid);
}

export function dispatchAuthorityField(
  ctx: BridgeConnectionCtx,
  record: AdmittedDispatch | undefined,
): Record<string, unknown> {
  return systemHelpDispatchFields({
    record,
    signer: ctx.authorityDeps?.signer,
    uid: ctx.uid,
    containerId: ctx.containerId,
    connectionChallenge: ctx.containerChallenge,
    supported: ctx.containerHasSystemHelp,
    issueBootstrap: ctx.shared.deps.issueSystemHelpBootstrap,
    onUnavailable: () => ctx.shared.log?.warn("system help unavailable for admitted turn"),
  });
}

export function recordBillingRecovery(
  ctx: BridgeConnectionCtx,
  requestId: string,
  outcome: "pending" | "failed" | "recovered" | "abandoned",
  snap?: Pick<CodexTurnSnapshot, "model" | "traceId">,
  attempts = 1,
): void {
  if (!ctx.shared.deps.pgPool) return;
  void recordProductFrictionEvent(
    {
      correlation: requestId,
      userId: ctx.uid,
      surface: "ws",
      stage: "billing_recovery",
      code: "USER_WS_DETACHED",
      outcome,
      attempts,
      model: snap?.model ?? null,
      traceId: snap?.traceId ?? null,
    },
    ctx.shared.deps.pgPool,
  ).catch((err) => {
    void err;
  });
}

export function trackBridgePreparation(
  ctx: BridgeConnectionCtx,
  work: () => Promise<void>,
  recoveryJob?: ClaimedRecoveryJob,
): void {
  ctx.preparationInFlight++;
  const promise = work().finally(() => {
    ctx.preparationInFlight--;
    ctx.checkDrainComplete();
  });
  if (recoveryJob) ctx.shared.trackRecoveryPromise(promise);
  else void promise;
}
