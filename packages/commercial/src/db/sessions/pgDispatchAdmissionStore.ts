import type { Pool, PoolClient } from "pg";
import type { ClientSession, MessageLike } from "@openclaude/storage";
import type { AdmitDispatchInput, AdmitDispatchResult } from "../../dispatch/turnDispatchStore.js";
import { attachAdmissionRestartSnapshot, pgAppendServerAuthoredCore } from "./appendCore.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { buildAdmissionRestartDeps, loadAdmissionRestartSource } from "./pgAutoRecoveryPolicy.js";
import { validateAndPrepareRecoveryMessage } from "./pgDispatchRecoveryValidator.js";
import { CLOCK_MS_SQL, withTx } from "./sqlHelpers.js";
import {
  RecoveryJobAdmissionConflict,
  type AdmitUserTurnInput,
  type AdmitUserTurnResult,
  type DispatchAdmissionBackend,
  type PgAppendCoreResult,
  type TurnTapeStateResult,
} from "./types.js";

export { loadAdmissionRestartSource };

// ── SQL statements (static constants for SAST compliance) ────────────────────

const INSERT_INITIAL_SESSION_SQL = `INSERT INTO client_sessions (id, user_id, agent_id, title, created_at, last_at, updated_at)
 VALUES ($1, $2, $3, $4, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL})
 ON CONFLICT (id) DO NOTHING`;

const TURN_TAPE_STATE_BY_DISPATCH_SQL = `SELECT
   (tape.tape_id IS NOT NULL) AS tape_found,
   tape.finalized_at,
   tape.visible_at,
   tape.status AS tape_status,
   COALESCE(dispatch.status, 'absent') AS dispatch_status,
   dispatch.outcome AS dispatch_outcome,
   (dispatch.producer_fenced_at IS NOT NULL) AS producer_fenced,
   COALESCE(
     dispatch.status IN ('admitted','accepted')
       AND dispatch.lease_until > statement_timestamp(),
     FALSE
   ) AS dispatch_lease_active,
   COALESCE(dispatch.shutdown_ctx->>$5, '') <> '' AS gateway_shutdown_evidence
 FROM (VALUES (1)) AS singleton(n)
 LEFT JOIN LATERAL (
   SELECT tape_id, finalized_at, visible_at, status
     FROM client_session_turn_tapes
    WHERE user_id = $1 AND dispatch_id = $3 AND attempt_no = $4
    ORDER BY (visible_at IS NOT NULL OR finalized_at IS NOT NULL) DESC
    LIMIT 1
 ) AS tape ON TRUE
 LEFT JOIN LATERAL (
   SELECT status, outcome, producer_fenced_at, lease_until, shutdown_ctx
     FROM turn_dispatches
    WHERE user_id = $2 AND dispatch_id = $3 AND attempt_no = $4
    LIMIT 1
 ) AS dispatch ON TRUE`;

// ── Session read helpers (open dispatch & permission prompts) ────────────────

export async function readOpenDispatchForSession(
  queryable: Pool | PoolClient,
  sessionId: string,
  userId: string,
): Promise<{ openDispatch?: ClientSession["openDispatch"] }> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uidMatch) return {};
  const row = (
    await queryable.query<{
      dispatch_id: string;
      client_message_id: string;
      status: string;
      accepted_at: Date | null;
      last_attempt_at: Date | null;
      model: string | null;
      last_frame_at: Date | null;
    }>(
      `SELECT d.dispatch_id, d.client_message_id, d.status, d.accepted_at, d.last_attempt_at, d.model,
              (
                SELECT MAX(f.created_at)
                  FROM client_session_live_streams s
                  JOIN client_session_live_frames f ON f.stream_key=s.stream_key
                 WHERE s.dispatch_id=d.dispatch_id
              ) AS last_frame_at
         FROM turn_dispatches d
        WHERE d.user_id=$1::bigint AND d.session_id=$2
          AND d.status IN ('admitted','accepted','rejecting')
        ORDER BY d.admitted_at DESC
        LIMIT 1`,
      [uidMatch[1], sessionId],
    )
  ).rows[0];
  if (!row) return {};
  return {
    openDispatch: {
      dispatchId: row.dispatch_id,
      clientMessageId: row.client_message_id,
      status: row.status,
      acceptedAt: row.accepted_at ? row.accepted_at.getTime() : null,
      lastFrameAt: (row.last_frame_at ?? row.last_attempt_at)?.getTime() ?? null,
      ...(row.model ? { model: row.model } : {}),
    },
  };
}

/** Durable permission/ask-user snapshot for session GET
 *  (INC-20260907-PERMISSION-ROOTFIX). Device B reconciles prompts device A
 *  already answered and re-materialises lost permission_request frames.
 *  A read failure must never 500 the whole session GET. */
export async function readPermissionPromptsForSession(
  queryable: Pool | PoolClient,
  sessionId: string,
  userId: string,
  deps: PgSessionsDeps,
  lookupIds?: string[],
): Promise<{ permissionPrompts?: ClientSession["permissionPrompts"] }> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uidMatch) return {};
  try {
    const userIdBig = BigInt(uidMatch[1]);
    const snapshot = await deps.dispatch.readPermissionPromptSnapshot(queryable, {
      userId: userIdBig,
      sessionId,
    });
    const lookups =
      lookupIds && lookupIds.length > 0
        ? await deps.dispatch.readPermissionPromptsByRequestIds(queryable, {
            userId: userIdBig,
            sessionId,
            requestIds: lookupIds,
          })
        : [];
    if (snapshot.items.length === 0 && lookups.length === 0) {
      return {
        permissionPrompts: {
          items: [],
          completeness: snapshot.completeness,
          source: snapshot.source,
        },
      };
    }
    return {
      permissionPrompts: {
        items: snapshot.items.map(deps.dispatch.serializePermissionPromptEntry),
        completeness: snapshot.completeness,
        source: snapshot.source,
        ...(lookups.length > 0
          ? { lookups: lookups.map(deps.dispatch.serializePermissionPromptEntry) }
          : {}),
      },
    };
  } catch (error) {
    console.warn(
      "pgSessionsBackend: readPermissionPromptsForSession failed; omitting permissionPrompts",
      { sessionId, userId, error: error instanceof Error ? error.message : String(error) },
    );
    return {
      permissionPrompts: {
        items: [],
        completeness: "unavailable",
        source: "pg",
      },
    };
  }
}

// ── Turn admission transaction helpers ───────────────────────────────────────

async function checkExclusiveSessionLock(
  client: PoolClient,
  input: AdmitUserTurnInput,
): Promise<AdmitUserTurnResult | null> {
  const locked = (
    await client.query<{ deleted_at: string | null }>(
      `SELECT deleted_at
         FROM client_sessions
        WHERE id=$1 AND user_id=$2
        FOR UPDATE`,
      [input.sessionId, input.sessionUserId],
    )
  ).rows[0];
  if (!locked) return { kind: "session_not_found" };
  if (locked.deleted_at !== null) return { kind: "session_deleted" };
  const busy = (
    await client.query<{ client_message_id: string }>(
      `SELECT client_message_id
         FROM turn_dispatches
        WHERE user_id=$1::bigint AND session_id=$2
          AND status IN ('admitted','accepted','rejecting')
          AND client_message_id <> $3
        LIMIT 1`,
      [input.uid.toString(), input.sessionId, input.clientMessageId],
    )
  ).rows[0];
  return busy ? { kind: "session_busy" } : null;
}

async function ensureInitialSessionRow(
  client: PoolClient,
  input: AdmitUserTurnInput,
  message: MessageLike,
): Promise<void> {
  const firstUserText = typeof message.text === "string" ? message.text : "";
  const initialTitle =
    firstUserText.length > 50 ? `${firstUserText.slice(0, 50)}…` : firstUserText || "新会话";
  await client.query(INSERT_INITIAL_SESSION_SQL, [
    input.sessionId,
    input.sessionUserId,
    input.agentId,
    initialTitle,
  ]);
}

function mapAppendRejection(appended: PgAppendCoreResult): AdmitUserTurnResult | null {
  if (appended.applied) return null;
  if (appended.reason === "session_not_found") return { kind: "session_not_found" };
  if (appended.reason === "session_deleted") return { kind: "session_deleted" };
  if (appended.reason === "already_exists") return null;
  return { kind: "append_error", reason: appended.reason ?? "unknown" };
}

function buildAdmitDispatchArgs(
  input: AdmitUserTurnInput,
  anchorSeq: bigint | null,
): AdmitDispatchInput {
  const args: AdmitDispatchInput = {
    dispatchId: input.dispatchId,
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    agentId: input.agentId,
    model: input.model,
    requestHash: input.requestHash,
    billingRequestId: input.billingRequestId,
    ownerId: input.ownerId,
    anchorSeq,
  };
  if (input.leaseTtlMs !== undefined) args.leaseTtlMs = input.leaseTtlMs;
  if (input.now !== undefined) args.now = input.now;
  if (input.agentContainerId !== undefined) args.agentContainerId = input.agentContainerId;
  if (input.runtimeKind !== undefined) args.runtimeKind = input.runtimeKind;
  if (input.traceId !== undefined) args.traceId = input.traceId;
  return args;
}

async function bindAndSettleRecoveryJobAfterAdmit(
  client: PoolClient,
  input: AdmitUserTurnInput,
  dispatch: AdmitDispatchResult,
  deps: PgSessionsDeps,
): Promise<void> {
  const job = input.recoveryJob!;
  const bound = await deps.dispatch.bindRecoveryJobDispatch(client, {
    jobId: job.jobId,
    userId: input.uid,
    sessionId: input.sessionId,
    rootClientMessageId: input.recovery!.automatic ? input.recovery!.rootClientMessageId : "",
    semanticRecoveryAttempt: input.recovery!.automatic ? input.recovery!.attempt : 0,
    leaseOwner: job.leaseOwner,
    leaseEpoch: job.leaseEpoch,
    dispatchId: dispatch.dispatch.dispatchId,
    dispatchAttemptNo: dispatch.dispatch.attemptNo,
  });
  if (!bound) throw new RecoveryJobAdmissionConflict("scheduler_lease_lost");
  if (dispatch.kind === "in_flight") {
    await client.query(
      `UPDATE turn_recovery_jobs
          SET status='forwarded',container_receipt_at=COALESCE(container_receipt_at,NOW()),
              lease_owner=NULL,lease_until=NULL,updated_at=NOW()
        WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
      [job.jobId, job.leaseOwner, job.leaseEpoch],
    );
  } else if (
    dispatch.kind === "deduplicated" ||
    dispatch.kind === "previously_failed" ||
    dispatch.kind === "manual_hold"
  ) {
    await client.query(
      `UPDATE turn_recovery_jobs
          SET status=CASE WHEN $4='manual_hold' THEN 'manual_reconcile' ELSE 'completed' END,
              lease_owner=NULL,lease_until=NULL,updated_at=NOW()
        WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
      [job.jobId, job.leaseOwner, job.leaseEpoch, dispatch.kind],
    );
  }
}

async function admitUserTurnInTx(
  client: PoolClient,
  input: AdmitUserTurnInput,
  deps: PgSessionsDeps,
): Promise<AdmitUserTurnResult> {
  if (input.recoveryJob) {
    if (!input.recovery?.automatic) {
      throw new RecoveryJobAdmissionConflict("scheduler_lineage_missing");
    }
    await deps.dispatch.lockRecoveryRoot(client, {
      userId: input.uid,
      sessionId: input.sessionId,
      rootClientMessageId: input.recovery.rootClientMessageId,
    });
  }
  let message = input.message;
  if (input.exclusiveSession) {
    const busyOrGone = await checkExclusiveSessionLock(client, input);
    if (busyOrGone) return busyOrGone;
  }
  if (input.recovery) {
    const prepared = await validateAndPrepareRecoveryMessage(client, input, input.recovery);
    if (!prepared.ok) return prepared.result;
    message = prepared.message;
  } else {
    await ensureInitialSessionRow(client, input, message);
  }
  const appended = await pgAppendServerAuthoredCore(
    client,
    input.sessionId,
    input.sessionUserId,
    message,
    deps,
  );
  const rejected = mapAppendRejection(appended);
  if (rejected) return rejected;

  const anchorSeq = typeof appended.seq === "number" ? BigInt(appended.seq) : null;
  const dispatch = await deps.dispatch.admitDispatch(
    client,
    buildAdmitDispatchArgs(input, anchorSeq),
  );
  if (
    dispatch.kind === "admitted" &&
    !dispatch.takeover &&
    !appended.applied &&
    message._admissionRestartRequest !== undefined
  ) {
    await attachAdmissionRestartSnapshot(client, input.sessionId, input.sessionUserId, message);
  }
  if (input.recoveryJob) {
    await bindAndSettleRecoveryJobAfterAdmit(client, input, dispatch, deps);
  }
  if (appended.workspaceMode === undefined) {
    throw new Error(`workspace mode missing after append for ${input.sessionId}`);
  }
  return { ...dispatch, workspaceMode: appended.workspaceMode };
}

async function admitUserTurnImpl(
  ctx: PgSessionsCtx,
  input: AdmitUserTurnInput,
): Promise<AdmitUserTurnResult> {
  try {
    return await withTx(ctx.pool, (client) => admitUserTurnInTx(client, input, ctx.deps));
  } catch (error) {
    if (error instanceof RecoveryJobAdmissionConflict) {
      return { kind: "recovery_conflict", reason: error.reason };
    }
    throw error;
  }
}

// ── Dispatch tape state snapshot ─────────────────────────────────────────────

async function getTurnTapeStateByDispatchImpl(
  pool: Pool,
  userId: string,
  dispatchId: string,
  attemptNo: number,
): Promise<TurnTapeStateResult> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uidMatch) {
    return {
      state: "none",
      status: null,
      dispatchLeaseActive: false,
      gatewayShutdownEvidence: false,
    };
  }
  const dispatchUserId = uidMatch[1]!;
  const res = await pool.query<{
    tape_found: boolean;
    finalized_at: string | null;
    visible_at: string | null;
    tape_status: string | null;
    dispatch_lease_active: boolean;
    gateway_shutdown_evidence: boolean;
    dispatch_status: TurnTapeStateResult["dispatchStatus"];
    dispatch_outcome: TurnTapeStateResult["dispatchOutcome"];
    producer_fenced: boolean;
  }>(TURN_TAPE_STATE_BY_DISPATCH_SQL, [
    userId,
    dispatchUserId,
    dispatchId,
    attemptNo,
    "gatewayExitedAt",
  ]);
  const row = res.rows[0]!;
  const dispatchLeaseActive = row.dispatch_lease_active === true;
  const gatewayShutdownEvidence = row.gateway_shutdown_evidence === true;
  const authority = {
    dispatchStatus: row.dispatch_status,
    dispatchOutcome: row.dispatch_outcome,
    producerFenced: row.producer_fenced === true,
  };
  if (!row.tape_found) {
    return {
      state: "none",
      status: null,
      dispatchLeaseActive,
      gatewayShutdownEvidence,
      ...authority,
    };
  }
  return {
    state: row.visible_at !== null || row.finalized_at !== null ? "finalized" : "partial",
    status: row.tape_status ?? null,
    ...authority,
    dispatchLeaseActive,
    gatewayShutdownEvidence,
  };
}

// ── Store factory ────────────────────────────────────────────────────────────

export function createPgDispatchAdmissionStore(
  ctx: PgSessionsCtx,
): Pick<
  DispatchAdmissionBackend,
  "admitUserTurn" | "getTurnTapeStateByDispatch" | "recoverInterruptedAdmission"
> {
  const admissionRestartDeps = buildAdmissionRestartDeps(ctx.options);
  return {
    admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult> {
      return admitUserTurnImpl(ctx, input);
    },
    getTurnTapeStateByDispatch(
      userId: string,
      dispatchId: string,
      attemptNo: number,
    ): Promise<TurnTapeStateResult> {
      return getTurnTapeStateByDispatchImpl(ctx.pool, userId, dispatchId, attemptNo);
    },
    recoverInterruptedAdmission(dispatchId: string): Promise<boolean> {
      return admissionRestartDeps
        ? ctx.deps.dispatch.recoverAdmissionAfterRestart(ctx.pool, dispatchId, admissionRestartDeps)
        : Promise.resolve(false);
    },
  };
}
