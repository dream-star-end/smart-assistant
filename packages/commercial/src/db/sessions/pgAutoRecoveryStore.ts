import type { Pool, PoolClient } from "pg";
import {
  automaticRetryStatus,
  isClientMessageId,
  supportsAutomaticTurnRecovery,
} from "@openclaude/protocol";
import type { ClientSession, MessageLike } from "@openclaude/storage";
import type { AdmissionRestartStorageDeps } from "../../dispatch/admissionRestartRecovery.js";
import type { LosslessTurnPayload } from "../../http/losslessTurnTape.js";
import { terminalTurnRecordErrorCode } from "../sessionRecoveryEvidence.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import {
  buildAdmissionRestartDeps,
  loadAdmissionRestartSource,
  recoveryWithoutCheckpointIsProven,
  scheduleAutomaticRecoveryForFinalizedTurn,
  settleFinalizedTurnControls,
} from "./pgAutoRecoveryPolicy.js";
import { withTx } from "./sqlHelpers.js";
import type { DispatchAdmissionBackend } from "./types.js";

export {
  buildAdmissionRestartDeps,
  loadAdmissionRestartSource,
  recoveryWithoutCheckpointIsProven,
  scheduleAutomaticRecoveryForFinalizedTurn,
  settleFinalizedTurnControls,
};

// ── Reconcile negative-verdict skip cache (OCV5-94) ──────────────────────────

const AUTOMATIC_RECOVERY_RECONCILE_SKIP_MAX = 8192;
const AUTOMATIC_RECOVERY_RECONCILE_SKIP_TERMINAL_TTL_MS = 6 * 60 * 60 * 1000;
const AUTOMATIC_RECOVERY_RECONCILE_SKIP_TRANSIENT_TTL_MS = 10 * 60 * 1000;
const automaticRecoveryReconcileSkips = new Map<string, number>();

function automaticRecoveryReconcileSkipKey(
  sessionUserId: string,
  sessionId: string,
  tapeId: string,
): string {
  return `${sessionUserId}\0${sessionId}\0${tapeId}`;
}

function automaticRecoveryReconcileSkipped(key: string, now = Date.now()): boolean {
  const until = automaticRecoveryReconcileSkips.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  automaticRecoveryReconcileSkips.delete(key);
  return false;
}

function rememberAutomaticRecoveryReconcileSkip(key: string, ttlMs: number): void {
  if (automaticRecoveryReconcileSkips.size >= AUTOMATIC_RECOVERY_RECONCILE_SKIP_MAX) {
    const oldest = automaticRecoveryReconcileSkips.keys().next();
    if (!oldest.done) automaticRecoveryReconcileSkips.delete(oldest.value);
  }
  automaticRecoveryReconcileSkips.delete(key);
  automaticRecoveryReconcileSkips.set(key, Date.now() + ttlMs);
}

/** Test seam: forget every remembered negative reconcile verdict. */
export function _resetAutomaticRecoveryReconcileSkipsForTest(): void {
  automaticRecoveryReconcileSkips.clear();
}

async function automaticRecoveryCandidateCheapVerdict(
  pool: Pool,
  sessionUserId: string,
  candidate: { session_id: string; tape_id: string; client_message_id: string },
): Promise<"pass" | "terminal" | "transient"> {
  if (!isClientMessageId(candidate.client_message_id)) return "terminal";
  const terminal = (
    await pool.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND role='assistant'
        ORDER BY ordinal DESC
        LIMIT 1`,
      [candidate.session_id, sessionUserId, candidate.tape_id],
    )
  ).rows[0];
  let errorCode = "";
  if (terminal) {
    try {
      const parsed = JSON.parse(Buffer.from(terminal.payload).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "terminal";
      errorCode = terminalTurnRecordErrorCode([parsed]);
    } catch (err) {
      void err;
      return "terminal";
    }
  }
  if (!supportsAutomaticTurnRecovery(errorCode)) return "terminal";
  const session = (
    await pool.query<{ messages: string }>(
      `SELECT messages FROM client_sessions
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [candidate.session_id, sessionUserId],
    )
  ).rows[0];
  if (!session) return "transient";
  let latestUser: MessageLike | undefined;
  try {
    const parsed = JSON.parse(session.messages);
    if (!Array.isArray(parsed)) return "transient";
    latestUser = [...(parsed as MessageLike[])]
      .reverse()
      .find((message) => message?.role === "user");
  } catch (err) {
    void err;
    return "transient";
  }
  return latestUser && latestUser.id === candidate.client_message_id ? "pass" : "transient";
}

// ── Session read helper for active automatic recoveries ──────────────────────

/** Read only scalar recovery metadata, never the stored prompt/attachments.
 * Call only inside the timeline's REPEATABLE READ transaction: absence and
 * finalized source rows must describe the same committed state. */
export async function readAutomaticRecoveriesForSession(
  queryable: PoolClient,
  sessionId: string,
  userId: string,
): Promise<{ automaticRecoveries: NonNullable<ClientSession["automaticRecoveries"]> }> {
  const uid = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uid) return { automaticRecoveries: [] };
  const result = await queryable.query<{
    source_client_message_id: string;
    root_client_message_id: string;
    client_message_id: string;
    error_code: string;
    recovery_mode: "replay" | "checkpoint";
    semantic_recovery_attempt: number;
    status: string;
    retry_limit: number | null;
  }>(
    `SELECT source_client_message_id,root_client_message_id,
            request_json->>'clientMessageId' AS client_message_id,
            error_code,recovery_mode,semantic_recovery_attempt,status,
            request_json->'_automaticRecoveryRetryLimit' AS retry_limit
       FROM turn_recovery_jobs
      WHERE user_id=$1::bigint AND session_id=$2
        AND status IN ('queued','leased','sent','forwarded')
      ORDER BY created_at,job_id`,
    [uid[1], sessionId],
  );
  return {
    automaticRecoveries: result.rows.map((row) => ({
      sourceClientMessageId: row.source_client_message_id,
      rootClientMessageId: row.root_client_message_id,
      clientMessageId: row.client_message_id,
      errorCode: row.error_code,
      mode: row.recovery_mode,
      attempt: row.semantic_recovery_attempt,
      retryStatus: automaticRetryStatus(
        row.status === "forwarded" ? "running" : "scheduled",
        row.semantic_recovery_attempt,
        row.retry_limit ?? undefined,
      ),
    })),
  };
}

// ── Periodic reconcile sweeper ───────────────────────────────────────────────

interface ReconcileCandidateRow {
  session_id: string;
  tape_id: string;
  tape_sha256: string;
  agent_id: string;
  status: "interrupted" | "crashed";
  turn_key: string;
  waive_reason: string | null;
  client_message_id: string;
}

function parseTapeRecordRows(rows: Array<{ payload: Buffer }>): Array<{ payload: MessageLike }> | null {
  const records: Array<{ payload: MessageLike }> = [];
  try {
    for (const row of rows) {
      const parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      records.push({ payload: parsed as MessageLike });
    }
    return records;
  } catch (err) {
    void err;
    return null;
  }
}

async function tryScheduleCandidateInTx(
  client: PoolClient,
  userId: bigint,
  sessionUserId: string,
  candidate: ReconcileCandidateRow,
  deps: PgSessionsDeps,
): Promise<boolean> {
  const tape = (
    await client.query<ReconcileCandidateRow & { finalized_at: string | null }>(
      `SELECT session_id,tape_id,tape_sha256,agent_id,status,turn_key,
              waive_reason,client_message_id,finalized_at
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        FOR UPDATE`,
      [candidate.session_id, sessionUserId, candidate.tape_id],
    )
  ).rows[0];
  if (!tape || tape.finalized_at === null) return false;
  const session = (
    await client.query<{ messages: string; deleted_at: string | null }>(
      `SELECT messages,deleted_at FROM client_sessions
        WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [candidate.session_id, sessionUserId],
    )
  ).rows[0];
  if (!session || session.deleted_at !== null) return false;
  let currentMessages: MessageLike[];
  try {
    const parsed = JSON.parse(session.messages);
    if (!Array.isArray(parsed)) return false;
    currentMessages = parsed as MessageLike[];
  } catch (err) {
    void err;
    return false;
  }
  const rows = await client.query<{ payload: Buffer }>(
    `SELECT payload FROM client_session_turn_tape_records
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
      ORDER BY ordinal`,
    [candidate.session_id, sessionUserId, candidate.tape_id],
  );
  const records = parseTapeRecordRows(rows.rows);
  if (!records) return false;

  const recordError = terminalTurnRecordErrorCode(records.map((record) => record.payload));
  await scheduleAutomaticRecoveryForFinalizedTurn(
    client,
    {
      uid: userId,
      sessionUserId,
      sessionId: candidate.session_id,
      clientMessageId: candidate.client_message_id,
      tapeSha256: candidate.tape_sha256,
      currentMessages,
      turn: {
        payload: {
          clientMessageId: candidate.client_message_id,
          status: candidate.status,
          agentId: candidate.agent_id,
          turnKey: candidate.turn_key,
          ...(typeof recordError === "string"
            ? { errorCode: recordError }
            : candidate.waive_reason
              ? { waiveReason: candidate.waive_reason as LosslessTurnPayload["waiveReason"] }
              : {}),
        },
        records,
      },
    },
    deps,
  );
  const exists = await client.query(
    `SELECT 1 FROM turn_recovery_jobs
      WHERE user_id=$1 AND session_id=$2 AND source_turn_key=$3 LIMIT 1`,
    [userId.toString(), candidate.session_id, candidate.turn_key],
  );
  return (exists.rowCount ?? 0) === 1;
}

async function reconcileOneRecoveryCandidate(
  ctx: PgSessionsCtx,
  userId: bigint,
  sessionUserId: string,
  candidate: ReconcileCandidateRow,
): Promise<boolean> {
  const skipKey = automaticRecoveryReconcileSkipKey(
    sessionUserId,
    candidate.session_id,
    candidate.tape_id,
  );
  if (automaticRecoveryReconcileSkipped(skipKey)) return false;
  const verdict = await automaticRecoveryCandidateCheapVerdict(ctx.pool, sessionUserId, candidate);
  if (verdict !== "pass") {
    if (isClientMessageId(candidate.client_message_id)) {
      await withTx(ctx.pool, (client) =>
        settleFinalizedTurnControls(
          client,
          {
            uid: userId,
            sessionId: candidate.session_id,
            clientMessageId: candidate.client_message_id,
            outcome: candidate.status,
          },
          ctx.deps,
        ),
      );
    }
    rememberAutomaticRecoveryReconcileSkip(
      skipKey,
      verdict === "terminal"
        ? AUTOMATIC_RECOVERY_RECONCILE_SKIP_TERMINAL_TTL_MS
        : AUTOMATIC_RECOVERY_RECONCILE_SKIP_TRANSIENT_TTL_MS,
    );
    return false;
  }
  const inserted = await withTx(ctx.pool, (client) =>
    tryScheduleCandidateInTx(client, userId, sessionUserId, candidate, ctx.deps),
  );
  if (!inserted) {
    rememberAutomaticRecoveryReconcileSkip(
      skipKey,
      AUTOMATIC_RECOVERY_RECONCILE_SKIP_TRANSIENT_TTL_MS,
    );
  }
  return inserted;
}

async function reconcileAutomaticRecoveryJobsImpl(
  ctx: PgSessionsCtx,
  admissionRestartDeps: AdmissionRestartStorageDeps | undefined,
  userId: bigint,
  limit = 100,
): Promise<number> {
  const sessionUserId = `c:${userId.toString()}`;
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const candidates = await ctx.pool.query<ReconcileCandidateRow>(
    `SELECT t.session_id,t.tape_id,t.tape_sha256,t.agent_id,t.status,
            t.turn_key,t.waive_reason,t.client_message_id
       FROM client_session_turn_tapes t
      WHERE t.user_id=$1 AND t.finalized_at IS NOT NULL
        AND t.status IN ('interrupted','crashed')
        AND t.client_message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM turn_recovery_jobs j
           WHERE j.user_id=$2 AND j.session_id=t.session_id
             AND j.source_turn_key=t.turn_key
        )
      ORDER BY t.finalized_at DESC
      LIMIT $3`,
    [sessionUserId, userId.toString(), boundedLimit],
  );
  let scheduled = admissionRestartDeps
    ? await ctx.deps.dispatch.reconcileAdmissionRestarts(
        ctx.pool,
        userId,
        boundedLimit,
        admissionRestartDeps,
      )
    : 0;
  for (const candidate of candidates.rows) {
    if (await reconcileOneRecoveryCandidate(ctx, userId, sessionUserId, candidate)) {
      scheduled++;
    }
  }
  return scheduled;
}

// ── Store factory ────────────────────────────────────────────────────────────

export function createPgAutoRecoveryStore(
  ctx: PgSessionsCtx,
): Pick<DispatchAdmissionBackend, "reconcileAutomaticRecoveryJobs"> {
  const admissionRestartDeps = buildAdmissionRestartDeps(ctx.options);
  return {
    reconcileAutomaticRecoveryJobs(userId: bigint, limit = 100): Promise<number> {
      return reconcileAutomaticRecoveryJobsImpl(ctx, admissionRestartDeps, userId, limit);
    },
  };
}
