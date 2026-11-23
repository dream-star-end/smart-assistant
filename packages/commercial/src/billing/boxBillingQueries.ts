/**
 * Billing-layer read queries and SQL fence constants for Box durable journal.
 *
 * Companion to `boxBillingStore.ts` (same `billing` module). Pure structural
 * extraction from `http/proxy/boxDurableJournal.ts` with 100% verbatim SQL.
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { BOX_API_MODELS } from "@openclaude/protocol";

export type BoxBillingDb =
  | Pick<Pool, "query">
  | Pick<PoolClient, "query">
  | { query: (sql: string, params?: unknown[]) => Promise<any> };

export function runBoxBillingQuery<R extends QueryResultRow = Record<string, unknown>>(
  db: BoxBillingDb,
  sql: string,
  params?: unknown[],
): Promise<{ rowCount: number | null; rows: R[] }> {
  return (db as Pick<Pool, "query">).query<R>(sql, params);
}

// The listed Box models as SQL. The ids are fixed strings from the protocol
// table (charset checked there), never request data.
export const BOX_MODEL_IDS_SQL = BOX_API_MODELS.map((m) => `'${m.id}'`).join(",");
/** The row's upstream id is the one its own canonical model maps to. */
export const BOX_MODEL_PAIR_SQL = `(${BOX_API_MODELS.map((m) =>
  `(ctx->>'model'='${m.id}' AND ctx->>'boxUpstreamModel'='${m.upstreamModel}')`).join(" OR ")})`;

// A rejected_stream settlement (OCV5-300) carries the keeper's real proof,
// possibly worker_complete; it is never a cleanup candidate here.
export const CLEANUP_STATE_FENCE = `((ctx->>'boxState'='terminal'
  AND state IN ('inflight','finalizing','committed'))
  OR (ctx->>'boxState'='failed_stopped'
    AND ctx->>'boxStopOutcome' IS DISTINCT FROM 'rejected_stream'
    AND (state='aborted' OR (state IN ('inflight','finalizing','committed')
      AND ctx ? 'boxToolHandoff'))))`;

export const CLEANUP_PROOF_FENCE = `((ctx->>'boxState'='terminal'
  AND ctx->'boxTerminalProof'->>'reason'='worker_complete'
  AND state IN ('inflight','finalizing','committed'))
  OR (ctx->>'boxState'='failed_stopped'
    AND ctx->'boxTerminalProof'->>'reason' IN ('keeper_stopped','worker_failed')
      AND (state='aborted' OR (state IN ('inflight','finalizing','committed')
        AND ctx ? 'boxToolHandoff'))))`;

/** OCV5-384: a finished run that recorded a native start attaches its native pointer right
 * after the terminal proof lands (after a remote transcript inspection). Cleanup claimed in
 * between made attachNativePointer refuse, so the next turn found no candidate and re-staged the
 * whole conversation at cache-write price. Such a run waits for its pointer, or for this grace. */
export const CLEANUP_NATIVE_POINTER_GRACE = `(ctx->>'boxState'<>'terminal'
  OR NOT (ctx ? 'boxNativeSessionId')
  OR ctx ? 'boxNativePointer'
  OR updated_at <= NOW() - INTERVAL '20 seconds')`;

export const CLEANUP_REPLAY_FENCE = `(ctx->>'boxState'<>'terminal'
  OR ctx->>'boxReplayRequired' IS DISTINCT FROM 'true'
  OR ctx ? 'boxReplayMessage')`;

// Legacy connected text has no detached spool and must never enter the
// runner cleanup queue. Only the new, durably armed text lane shares it.
export const CLEANUP_MODE_FENCE = `(ctx->>'boxInvocationMode'='detached_tool'
  OR (ctx->>'boxInvocationMode'='text'
    AND ctx->>'boxLaunchPermit'='true'
    AND ${BOX_MODEL_PAIR_SQL}
    AND (ctx->>'boxDetachedRunnerHash') ~ '^[a-f0-9]{64}$'))`;

export const STOP_MODE_FENCE = CLEANUP_MODE_FENCE;

/* OCV5-488 (user-approved deviation from a gateway keepalive lease, 10-17):
 * whether the turn that handed a tool call to a Box run can still answer it
 * is decided server-side. A user has at most one active container; a run
 * whose turn ran in any other (rebuilt, swept, removed) can never be
 * answered, while one in the active container is left alone however long
 * its tools run. A keepalive would only cover containers already running a
 * new runtime. */
// lint-agent-containers-kind: allow — 按本行自己的 container_id 查它是否仍 active;与容器种类无关
export const OWNER_CONTAINER_GONE = `(container_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_containers ac
   WHERE ac.id = request_finalize_journal.container_id AND ac.state = 'active'))`;

export const STOP_PROBE_STATE_FENCE = `((state='inflight'
  AND ctx->>'boxState' IN ('running','unknown','linked')
  AND NOT (ctx ? 'boxToolHandoff'))
  OR (state IN ('inflight','finalizing','committed')
    AND ctx->>'boxState' IN ('handoff','unknown')
    AND ctx ? 'boxToolHandoff'))`;

export interface BoxIdleQueryRow {
  request_id: string;
  state: string;
  final_credits: string | null;
  failure_code: string | null;
  ctx: Record<string, unknown>;
}

export async function selectUsageRecordExists(
  db: BoxBillingDb,
  requestId: string,
  uid: bigint,
): Promise<boolean> {
  const usage = await runBoxBillingQuery(
    db,
    "SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=$2 LIMIT 1",
    [requestId, uid.toString()],
  );
  return Boolean(usage.rowCount);
}

export async function selectWaitingToolHandoffRows(
  db: BoxBillingDb,
  input: {
    uid: bigint;
    sessionId: string;
    turnKey: string;
    unsentChildStopInflightSql: string;
    resumingParentSql: string;
  },
): Promise<{ request_id: string; ctx: Record<string, unknown>; unsent_stop_inflight: boolean }[]> {
  const rows = await runBoxBillingQuery<{
    request_id: string;
    ctx: Record<string, unknown>;
    unsent_stop_inflight: boolean;
  }>(
    db,
    `SELECT handoff_row.request_id, handoff_row.ctx,
        ${input.unsentChildStopInflightSql} AS unsent_stop_inflight
      FROM request_finalize_journal handoff_row
      WHERE handoff_row.user_id=$1 AND handoff_row.ctx->>'boxSessionId'=$2
        AND handoff_row.ctx->>'boxTurnKey'=$3
        AND (handoff_row.ctx->>'boxState'='handoff'
          OR ${input.resumingParentSql})
        AND handoff_row.state IN ('inflight','finalizing','committed')`,
    [input.uid.toString(), input.sessionId, input.turnKey],
  );
  return rows.rows;
}

export async function selectOrphanToolHandoffRows(
  db: BoxBillingDb,
  input: {
    uid: bigint;
    sessionId: string;
    turnKey: string;
    unsentChildStopInflightSql: string;
    stoppedUnsentChildCtxSql: string;
    resumingParentSql: string;
  },
): Promise<{
  request_id: string;
  ctx: Record<string, unknown>;
  unsent_stop_inflight: boolean;
  stopped_unsent_child_ctx: Record<string, unknown> | null;
}[]> {
  const rows = await runBoxBillingQuery<{
    request_id: string;
    ctx: Record<string, unknown>;
    unsent_stop_inflight: boolean;
    stopped_unsent_child_ctx: Record<string, unknown> | null;
  }>(
    db,
    `SELECT handoff_row.request_id, handoff_row.ctx,
        ${input.unsentChildStopInflightSql} AS unsent_stop_inflight,
        ${input.stoppedUnsentChildCtxSql} AS stopped_unsent_child_ctx
      FROM request_finalize_journal handoff_row
      WHERE handoff_row.user_id=$1 AND handoff_row.ctx->>'boxSessionId'=$2
        AND (handoff_row.ctx->>'boxState' IN ('handoff','failed_stopped')
          OR ${input.resumingParentSql})
        AND (handoff_row.ctx->>'boxTurnKey' IS DISTINCT FROM $3
          OR handoff_row.ctx->>'boxState'='failed_stopped')
        AND handoff_row.state IN ('inflight','finalizing','committed','aborted')`,
    [input.uid.toString(), input.sessionId, input.turnKey],
  );
  return rows.rows;
}

export async function selectNativeCandidateRow(
  db: BoxBillingDb,
  input: { uid: bigint; sessionId: string; canonicalModel: string; currentRequestId: string },
): Promise<{ rowCount: number | null; row: { request_id: string; ctx: Record<string, unknown> } | undefined }> {
  const found = await runBoxBillingQuery<{ request_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,ctx FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
        AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
        AND request_id<>$4
      ORDER BY updated_at DESC, (ctx ? 'boxNativePointer') DESC,
        request_id DESC LIMIT 1`,
    [input.uid.toString(), input.sessionId, input.canonicalModel, input.currentRequestId],
  );
  return { rowCount: found.rowCount, row: found.rows[0] };
}

export async function selectNativeTranscriptSourceRows(
  db: BoxBillingDb,
  input: { uid: bigint; sessionId: string; canonicalModel: string; currentRequestId: string },
): Promise<{ cwd: unknown; sid: unknown; version: unknown }[]> {
  const found = await runBoxBillingQuery<{ cwd: unknown; sid: unknown; version: unknown }>(
    db,
    `(SELECT ctx->>'boxNativeCliCwd' AS cwd, ctx->>'boxNativeSessionId' AS sid,
             ctx->>'boxNativeCliVersion' AS version, 0 AS rank
        FROM request_finalize_journal
       WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'model'=$3
         AND ctx->>'boxInvocationRecovery'='v1' AND request_id<>$4
         AND ctx ? 'boxNativeCliCwd' AND ctx ? 'boxNativeSessionId' AND ctx ? 'boxNativeCliVersion'
       ORDER BY created_at ASC, request_id ASC LIMIT 1)
     UNION ALL
     (SELECT ctx->>'boxNativeCliCwd', ctx->>'boxNativeSessionId', ctx->>'boxNativeCliVersion', 1
        FROM request_finalize_journal
       WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'model'=$3
         AND ctx->>'boxInvocationRecovery'='v1' AND request_id<>$4
         AND ctx ? 'boxNativeCliCwd' AND ctx ? 'boxNativeSessionId' AND ctx ? 'boxNativeCliVersion'
       ORDER BY created_at DESC, request_id DESC LIMIT 1)
     ORDER BY rank`,
    [input.uid.toString(), input.sessionId, input.canonicalModel, input.currentRequestId],
  );
  return found.rows;
}

export async function selectNativeGcCandidateRows(
  db: BoxBillingDb,
  limit: number,
): Promise<{ request_id: string; user_id: string; ctx: Record<string, unknown> }[]> {
  const found = await runBoxBillingQuery<{ request_id: string; user_id: string; ctx: Record<string, unknown> }>(
    db,
    `WITH pointers AS (
       SELECT request_id,user_id,ctx,
         row_number() OVER (PARTITION BY user_id,ctx->>'boxAccountId',
           ctx->'boxNativePointer'->>'cliCwd',
           ctx->'boxNativePointer'->>'nativeSessionId'
           ORDER BY (ctx->'boxNativePointer'->>'expiresAtMs')::bigint DESC,
             request_id DESC) AS rn
         FROM request_finalize_journal
        WHERE ctx ? 'boxNativePointer'
          AND jsonb_typeof(ctx->'boxNativePointer'->'expiresAtMs')='number'
          AND (ctx->'boxNativePointer'->>'expiresAtMs') ~ '^[0-9]{13}$'
     ) SELECT request_id,user_id::text,ctx FROM pointers
       WHERE rn=1
         AND (ctx->'boxNativePointer'->>'expiresAtMs')::bigint
           <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint
         AND NOT (ctx ? 'boxNativeGcQuarantine')
         AND COALESCE(ctx->>'boxNativeGcStatus','pending')<>'done'
         AND (ctx->>'boxNativeGcStatus' IS DISTINCT FROM 'claimed'
           OR (jsonb_typeof(ctx->'boxNativeGcRetryAfterMs')='number'
             AND (ctx->>'boxNativeGcRetryAfterMs') ~ '^[0-9]{13}$'
             AND (ctx->>'boxNativeGcRetryAfterMs')::bigint
               <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
       ORDER BY (ctx->'boxNativePointer'->>'expiresAtMs')::bigint ASC
       LIMIT $1`,
    [limit],
  );
  return found.rows;
}

export async function selectTextUnknownCandidateRows(
  db: BoxBillingDb,
  limit: number,
): Promise<{ request_id: string; user_id: string; ctx: Record<string, unknown> }[]> {
  const found = await runBoxBillingQuery<{ request_id: string; user_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
      WHERE state='inflight' AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='unknown'
        AND ctx->>'boxLaunchPermit'='true'
        AND ${BOX_MODEL_PAIR_SQL}
        AND (ctx->>'boxDetachedRunnerHash') ~ '^[a-f0-9]{64}$'
        AND (ctx->>'boxAccountId') ~ '^[1-9][0-9]{0,19}$'
        AND (ctx->>'boxRunNonce') ~ '^[a-f0-9]{24}$'
        AND (ctx->>'boxLeaseEpoch') ~ '^[a-f0-9]{32}$'
        AND NOT (ctx ? 'boxOwnerRequestId')
        AND NOT (ctx ? 'boxReplayMessage') AND NOT (ctx ? 'boxTerminalProof')
        AND (NOT (ctx ? 'boxTextObserverRetryAfterMs')
          OR (jsonb_typeof(ctx->'boxTextObserverRetryAfterMs')='number'
            AND (ctx->>'boxTextObserverRetryAfterMs') ~ '^[0-9]{13}$'
            AND (ctx->>'boxTextObserverRetryAfterMs')::bigint
              <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
      ORDER BY CASE WHEN jsonb_typeof(ctx->'boxTextObserverLastAttemptMs')='number'
        AND (ctx->>'boxTextObserverLastAttemptMs') ~ '^[0-9]{13}$'
        THEN (ctx->>'boxTextObserverLastAttemptMs')::bigint ELSE 0 END ASC,
        updated_at ASC LIMIT $1`,
    [limit],
  );
  return found.rows;
}

export async function selectAdmitDuplicateExists(
  db: BoxBillingDb,
  input: { replayFingerprint: string; fallbackAlias: string | null; uid: bigint },
): Promise<boolean> {
  const duplicate = await runBoxBillingQuery(
    db,
    `SELECT 1 FROM request_finalize_journal
      WHERE user_id = $3 AND ctx->>'boxInvocationRecovery' = 'v1'
        AND (ctx->>'boxReplayFingerprint' = $1
         OR ctx->>'boxFallbackAlias' = $2)
        AND NOT (state = 'aborted' AND NOT (ctx ? 'boxReplayMessage')
          AND COALESCE(ctx->>'boxState', '') IN ('failed_stopped', 'prestart_stopped'))
      LIMIT 1`,
    [input.replayFingerprint, input.fallbackAlias, input.uid.toString()],
  );
  return Boolean(duplicate.rowCount);
}

export async function selectAdmitCapacityUsage(
  db: BoxBillingDb,
  input: {
    activeStates: readonly string[];
    accountId: bigint;
    uid: bigint;
    sessionId: string;
    expiredAfterSec: number;
    requestId: string;
  },
): Promise<{
  same_session: boolean;
  account_occupied: string;
  user_occupied: string;
  malformed_ids: string[] | null;
} | undefined> {
  const occupied = await runBoxBillingQuery<{
    same_session: boolean;
    account_occupied: string;
    user_occupied: string;
    malformed_ids: string[] | null;
  }>(
    db,
    `WITH rows AS (
       SELECT request_id, user_id, created_at,
         ctx->>'boxSessionId' AS session_id, COALESCE(ctx->>'boxAccountId',ctx#>>'{boxRolloverFrom,accountId}') AS account_id,
         (state='inflight' AND ctx ? 'boxRolloverFrom' AND NOT (ctx ? 'boxState')) AS rollover_pending,
         CASE WHEN COALESCE(COALESCE(ctx->>'boxRunNonce',ctx#>>'{boxRolloverFrom,runNonce}'),'') ~ '^[a-f0-9]{24}$'
                AND COALESCE(COALESCE(ctx->>'boxLeaseEpoch',ctx#>>'{boxRolloverFrom,leaseEpoch}'),'') ~ '^[a-f0-9]{32}$'
                AND COALESCE(ctx->>'boxAccountId',ctx#>>'{boxRolloverFrom,accountId}') IS NOT NULL
                AND ctx->>'boxSessionId' IS NOT NULL
              THEN 'run:' || (COALESCE(ctx->>'boxRunNonce',ctx#>>'{boxRolloverFrom,runNonce}')) || ':' || (COALESCE(ctx->>'boxLeaseEpoch',ctx#>>'{boxRolloverFrom,leaseEpoch}'))
              ELSE 'row:' || request_id END AS run_key,
         NOT (COALESCE(COALESCE(ctx->>'boxRunNonce',ctx#>>'{boxRolloverFrom,runNonce}'),'') ~ '^[a-f0-9]{24}$'
                AND COALESCE(COALESCE(ctx->>'boxLeaseEpoch',ctx#>>'{boxRolloverFrom,leaseEpoch}'),'') ~ '^[a-f0-9]{32}$'
                AND COALESCE(ctx->>'boxAccountId',ctx#>>'{boxRolloverFrom,accountId}') IS NOT NULL
                AND ctx->>'boxSessionId' IS NOT NULL) AS malformed
       FROM request_finalize_journal
       WHERE (ctx->>'boxState' = ANY($1::text[])
          OR (state='inflight' AND ctx ? 'boxRolloverFrom' AND NOT (ctx ? 'boxState') AND request_id<>$6))
         AND (COALESCE(ctx->>'boxAccountId',ctx#>>'{boxRolloverFrom,accountId}') = $2 OR user_id = $3)),
     active AS (
       SELECT * FROM rows
        WHERE rollover_pending OR run_key IN (SELECT run_key FROM rows GROUP BY run_key
          HAVING MIN(created_at) > NOW() - make_interval(secs => $5::double precision)))
     SELECT
       COALESCE(bool_or(user_id = $3 AND session_id = $4), false) AS same_session,
       COUNT(DISTINCT run_key) FILTER (WHERE account_id = $2) AS account_occupied,
       COUNT(DISTINCT run_key) FILTER (WHERE user_id = $3) AS user_occupied,
       (array_agg(request_id ORDER BY request_id) FILTER (WHERE malformed))[1:5] AS malformed_ids
     FROM active`,
    [
      input.activeStates,
      input.accountId.toString(),
      input.uid.toString(),
      input.sessionId,
      input.expiredAfterSec,
      input.requestId,
    ],
  );
  return occupied.rows[0];
}

export async function selectLatestNativeOwnerForAdmit(
  db: BoxBillingDb,
  input: { uid: bigint; sessionId: string; model: string; requestId: string },
): Promise<{ rowCount: number | null; requestId: string | undefined }> {
  const latest = await runBoxBillingQuery<{ request_id: string }>(
    db,
    `SELECT request_id FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
        AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
        AND request_id<>$4
      ORDER BY updated_at DESC, (ctx ? 'boxNativePointer') DESC,
        request_id DESC LIMIT 1 FOR UPDATE`,
    [input.uid.toString(), input.sessionId, input.model, input.requestId],
  );
  return { rowCount: latest.rowCount, requestId: latest.rows[0]?.request_id };
}

export async function selectStoppedFailureProbeCandidateRows(
  db: BoxBillingDb,
  input: { limit: number; expiredAfterSec: number },
): Promise<{
  request_id: string;
  user_id: string;
  state: string;
  unknown_for_ms: string;
  expired: boolean;
  owner_gone: boolean;
  ctx: Record<string, unknown>;
}[]> {
  const found = await runBoxBillingQuery<{
    request_id: string;
    user_id: string;
    state: string;
    unknown_for_ms: string;
    expired: boolean;
    owner_gone: boolean;
    ctx: Record<string, unknown>;
  }>(
    db,
    `SELECT request_id,user_id::text,state,ctx,
        GREATEST(0,(EXTRACT(EPOCH FROM (NOW()-updated_at))*1000))::bigint::text AS unknown_for_ms,
        created_at <= NOW() - make_interval(secs => $2::double precision) AS expired,
        ${OWNER_CONTAINER_GONE} AS owner_gone
      FROM request_finalize_journal
      WHERE ${STOP_PROBE_STATE_FENCE} AND ctx->>'boxInvocationRecovery'='v1'
        AND ${STOP_MODE_FENCE}
        AND request_id ~ '^[A-Za-z0-9_-]{1,64}$' AND user_id>0
        AND jsonb_typeof(ctx->'boxAccountId')='string'
        AND ctx->>'boxAccountId' ~ '^[1-9][0-9]{0,19}$'
        AND jsonb_typeof(ctx->'boxRunNonce')='string'
        AND ctx->>'boxRunNonce' ~ '^[a-f0-9]{24}$'
        AND jsonb_typeof(ctx->'boxLeaseEpoch')='string'
        AND ctx->>'boxLeaseEpoch' ~ '^[a-f0-9]{32}$'
        AND (NOT (ctx ? 'boxOwnerRequestId')
          OR (jsonb_typeof(ctx->'boxOwnerRequestId')='string'
            AND ctx->>'boxOwnerRequestId' ~ '^[A-Za-z0-9_-]{1,64}$'))
        AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'boxTerminalProof')
        AND (NOT (ctx ? 'boxStopProbeAfterMs')
          OR (jsonb_typeof(ctx->'boxStopProbeAfterMs')='number'
            AND (ctx->>'boxStopProbeAfterMs') ~ '^[0-9]{13}$'
            AND (ctx->>'boxStopProbeAfterMs')::bigint
              <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
      ORDER BY CASE WHEN jsonb_typeof(ctx->'boxStopProbeLastAttemptMs')='number'
          AND (ctx->>'boxStopProbeLastAttemptMs') ~ '^[0-9]{13}$'
        THEN (ctx->>'boxStopProbeLastAttemptMs')::bigint ELSE 0 END ASC,
        updated_at ASC LIMIT $1`,
    [input.limit, input.expiredAfterSec],
  );
  return found.rows;
}

export async function selectCancelLeafRow(
  db: BoxBillingDb,
  input: { uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string },
): Promise<{
  rowCount: number | null;
  row: { request_id: string; user_id: string; ctx: Record<string, unknown> } | undefined;
}> {
  const found = await runBoxBillingQuery<{ request_id: string; user_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
        AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ${STOP_MODE_FENCE}
        AND ${STOP_PROBE_STATE_FENCE}
        AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'boxTerminalProof')
        AND ctx ? 'boxCancelIntent'`,
    [input.uid.toString(), input.accountId.toString(), input.runNonce, input.leaseEpoch],
  );
  return { rowCount: found.rowCount, row: found.rows[0] };
}

export async function selectCancelableRunRow(
  db: BoxBillingDb,
  input: { uid: bigint; containerId: bigint; sessionId: string; turnKey: string },
): Promise<{
  rowCount: number | null;
  row: { request_id: string; ctx: Record<string, unknown> } | undefined;
}> {
  const found = await runBoxBillingQuery<{ request_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,ctx FROM request_finalize_journal
      WHERE user_id=$1 AND container_id=$2
        AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
        AND ctx->>'model' IN (${BOX_MODEL_IDS_SQL})
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ${STOP_MODE_FENCE}
        AND ${STOP_PROBE_STATE_FENCE}
        AND NOT (ctx ? 'boxResumeRequestId')
        AND NOT (ctx ? 'boxTerminalProof')`,
    [input.uid.toString(), input.containerId.toString(), input.sessionId, input.turnKey],
  );
  return { rowCount: found.rowCount, row: found.rows[0] };
}

export async function selectIdleProofTurnRows(
  db: BoxBillingDb,
  input: {
    uid: bigint;
    containerId: bigint;
    sessionId: string;
    turnKey: string;
    retiredRolloverSql: string;
    supersededUnsentSql: string;
  },
): Promise<BoxIdleQueryRow[]> {
  const found = await runBoxBillingQuery<BoxIdleQueryRow>(
    db,
    `SELECT current_row.request_id,current_row.state,current_row.final_credits::text AS final_credits,current_row.failure_code,current_row.ctx
       FROM request_finalize_journal current_row
      WHERE user_id=$1 AND container_id=$2
        AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
        AND ctx->>'model' IN (${BOX_MODEL_IDS_SQL})
        AND ctx->>'boxInvocationRecovery'='v1'
        AND NOT ${input.retiredRolloverSql}
        AND NOT ${input.supersededUnsentSql} LIMIT 129`,
    [input.uid.toString(), input.containerId.toString(), input.sessionId, input.turnKey],
  );
  return found.rows;
}

export async function selectIdleProofOpenRows(
  db: BoxBillingDb,
  input: { uid: bigint; containerId: bigint; sessionId: string },
): Promise<{ request_id: string }[]> {
  const open = await runBoxBillingQuery<{ request_id: string }>(
    db,
    `SELECT request_id FROM request_finalize_journal
      WHERE user_id=$1 AND container_id=$2
        AND ctx->>'boxSessionId'=$3
        AND ctx->>'boxInvocationRecovery'='v1'
        AND (
          COALESCE(ctx->>'boxState','') NOT IN ('terminal','failed_stopped','prestart_stopped')
          OR (ctx->>'boxState'='terminal' AND state <> 'committed')
          -- A prestart stop is closed only under its own fence (never launched).
          OR (ctx->>'boxState'='prestart_stopped' AND ctx ? 'boxLaunchPermit')
        )`,
    [input.uid.toString(), input.containerId.toString(), input.sessionId],
  );
  return open.rows;
}

export async function selectIdleProofExpiredRows(
  db: BoxBillingDb,
  input: { uid: bigint; containerId: bigint; sessionId: string; expiredState: string },
): Promise<BoxIdleQueryRow[]> {
  const expired = await runBoxBillingQuery<BoxIdleQueryRow>(
    db,
    `SELECT request_id,state,final_credits::text AS final_credits,failure_code,ctx
       FROM request_finalize_journal
      WHERE user_id=$1 AND container_id=$2
        AND ctx->>'boxSessionId'=$3
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxState'=$4`,
    [input.uid.toString(), input.containerId.toString(), input.sessionId, input.expiredState],
  );
  return expired.rows;
}

export async function selectPrelaunchRecoveryCandidateRows(
  db: BoxBillingDb,
  input: { limit: number; nowMs: number },
): Promise<{ request_id: string; user_id: string; ctx: Record<string, unknown> }[]> {
  const found = await runBoxBillingQuery<{ request_id: string; user_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,user_id,ctx FROM request_finalize_journal
      WHERE state='inflight' AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx ? 'boxPrelaunchControl' AND NOT (ctx ? 'boxLaunchPermit')
        AND NOT (ctx ? 'boxTerminalProof')
        AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')
        AND ((ctx->>'boxState'='unknown') OR
          (ctx->>'boxState'='reserved' AND updated_at < NOW() - INTERVAL '16 minutes'))
        AND (NOT (ctx ? 'boxPrelaunchRetryAfterMs') OR
          (jsonb_typeof(ctx->'boxPrelaunchRetryAfterMs')='number'
           AND (ctx->>'boxPrelaunchRetryAfterMs') ~ '^[0-9]{13}$'
           AND (ctx->>'boxPrelaunchRetryAfterMs')::bigint <= $2))
      ORDER BY updated_at ASC LIMIT $1`,
    [input.limit, input.nowMs],
  );
  return found.rows;
}

export async function selectRemoteCleanupCandidateRows(
  db: BoxBillingDb,
  limit: number,
): Promise<{ request_id: string; user_id: string; ctx: Record<string, unknown> }[]> {
  const found = await runBoxBillingQuery<{ request_id: string; user_id: string; ctx: Record<string, unknown> }>(
    db,
    `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
      WHERE ctx->>'boxInvocationRecovery'='v1'
        AND ${CLEANUP_MODE_FENCE}
         AND ${CLEANUP_STATE_FENCE} AND ctx ? 'boxTerminalProof'
         AND ${CLEANUP_REPLAY_FENCE}
         AND ${CLEANUP_NATIVE_POINTER_GRACE}
        AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
        AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
         AND (ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
           OR (jsonb_typeof(ctx->'boxRemoteCleanupRetryAfterMs')='number'
             AND (ctx->>'boxRemoteCleanupRetryAfterMs') ~ '^[0-9]{13}$'
             AND (ctx->>'boxRemoteCleanupRetryAfterMs')::bigint
               <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
           OR (NOT (ctx ? 'boxRemoteCleanupRetryAfterMs')
             AND updated_at <= NOW()-INTERVAL '2 minutes'))
       ORDER BY CASE WHEN jsonb_typeof(ctx->'boxRemoteCleanupLastAttemptMs')='number'
           AND (ctx->>'boxRemoteCleanupLastAttemptMs') ~ '^[0-9]{13}$'
         THEN (ctx->>'boxRemoteCleanupLastAttemptMs')::bigint ELSE 0 END ASC,
         updated_at ASC LIMIT $1`,
    [limit],
  );
  return found.rows;
}

export async function selectRemoteCleanupStatusRow(
  db: BoxBillingDb,
  input: {
    requestId: string;
    uid: bigint;
    accountId: bigint;
    runNonce: string;
    leaseEpoch: string;
    proofJson: string;
  },
): Promise<{ rowCount: number | null; status: string | null | undefined }> {
  const found = await runBoxBillingQuery<{ status: string | null }>(
    db,
    `SELECT ctx->>'boxRemoteCleanup' AS status FROM request_finalize_journal
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
        AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
        AND ${CLEANUP_MODE_FENCE}
        AND ${CLEANUP_PROOF_FENCE} AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
        AND ctx->'boxTerminalProof'=$6::jsonb`,
    [
      input.requestId,
      input.uid.toString(),
      input.accountId.toString(),
      input.runNonce,
      input.leaseEpoch,
      input.proofJson,
    ],
  );
  return { rowCount: found.rowCount, status: found.rows[0]?.status };
}

export async function selectRemoteCleanupDoneRow(
  db: BoxBillingDb,
  input: { uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string },
): Promise<{ rowCount: number | null; ctx: Record<string, unknown> | undefined }> {
  const found = await runBoxBillingQuery<{ ctx: Record<string, unknown> }>(
    db,
    `SELECT ctx FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
        AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ${CLEANUP_MODE_FENCE}
        AND ctx->>'boxRemoteCleanup'='done'
        AND ${CLEANUP_PROOF_FENCE}`,
    [input.uid.toString(), input.accountId.toString(), input.runNonce, input.leaseEpoch],
  );
  return { rowCount: found.rowCount, ctx: found.rows[0]?.ctx };
}

export async function selectPrelaunchCleanupDoneRow(
  db: BoxBillingDb,
  input: { uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string },
): Promise<{ rowCount: number | null; ctx: Record<string, unknown> | undefined }> {
  const found = await runBoxBillingQuery<{ ctx: Record<string, unknown> }>(
    db,
    `SELECT ctx FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
        AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
        AND ctx->>'boxInvocationRecovery'='v1'
        AND ctx->>'boxInvocationMode'='detached_tool'
        AND ctx->>'boxState'='prestart_stopped'
        AND ctx ? 'boxPrelaunchControl' AND ctx ? 'boxPrelaunchCleanup'
        AND NOT (ctx ? 'boxLaunchPermit')`,
    [input.uid.toString(), input.accountId.toString(), input.runNonce, input.leaseEpoch],
  );
  return { rowCount: found.rowCount, ctx: found.rows[0]?.ctx };
}

export async function selectRemoteCleanedAlreadyExists(
  db: BoxBillingDb,
  input: {
    requestId: string;
    uid: bigint;
    accountId: bigint;
    runNonce: string;
    leaseEpoch: string;
    proofJson: string;
    nativePointerJson: string | null;
  },
): Promise<boolean> {
  const already = await runBoxBillingQuery(
    db,
    `SELECT 1 FROM request_finalize_journal
      WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
        AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
        AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
        AND ${CLEANUP_MODE_FENCE}
        AND ctx->'boxTerminalProof'->>'runNonce'=$4
        AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
        AND ctx->'boxTerminalProof'=$6::jsonb
        AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
        AND ctx->>'boxRemoteCleanup'='done'`,
    [
      input.requestId,
      input.uid.toString(),
      input.accountId.toString(),
      input.runNonce,
      input.leaseEpoch,
      input.proofJson,
      input.nativePointerJson,
    ],
  );
  return already.rowCount === 1;
}
