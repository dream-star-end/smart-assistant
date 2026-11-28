import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LosslessTurnTapeFinalizeRequest } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import type { RecoveryJobTerminalRow } from "../../dispatch/turnRecoveryStore.js";
import { settlementAuthorityHash } from "../visibleFinalize.js";
import type { PgSessionsDeps } from "./deps.js";
import type {
  GoalUsageChange,
  PgAppendCoreResult,
  PgSessionsBackendOptions,
  QueryRunner,
} from "./types.js";

// ── BIGINT codec (RFC D7) ────────────────────────────────────────────────────

export function bigIntNum(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`[pgSessions] ${field} 非有限数值(BIGINT codec): ${String(v)}`);
  }
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`[pgSessions] ${field} 超 Number.MAX_SAFE_INTEGER(BIGINT codec): ${String(v)}`);
  }
  return n;
}

export function bigIntNumOr(v: unknown, dflt: number): number {
  return v === null || v === undefined ? dflt : bigIntNum(v, "value");
}

export function bigIntNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : bigIntNum(v, "value");
}

// ── Transaction wrappers ─────────────────────────────────────────────────────

function releaseCorruptedClient(client: PoolClient, err: unknown): void {
  try {
    client.release(err instanceof Error ? err : new Error(String(err)));
  } catch (releaseErr) {
    void releaseErr;
  }
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      destroyed = true;
      releaseCorruptedClient(client, rollbackErr);
    }
    throw err;
  } finally {
    if (!destroyed) client.release();
  }
}

/** One immutable browser page must observe the session row, archive chunks,
 * tape identity and dispatch-status overlay from the same snapshot. */
export async function withTimelineSnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroyed = true;
      releaseCorruptedClient(client, rollbackError);
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}

// ── Shared sentinels, advisory locks & SQL fragments ─────────────────────────

export const PG_STALE_WRITE_ROLLBACK = new Error("__pg_stale_write_rollback__");

export async function requestAdvisoryXactLock(
  client: PoolClient,
  userId: string,
  requestId: string,
): Promise<void> {
  const key = `oc_sarm:${userId}:${requestId}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const CLOCK_MS_SQL = "(floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT";
export const LAST_D_TERMINAL_MS_SQL = "(floor(EXTRACT(EPOCH FROM last_d.terminal_at)*1000))::BIGINT";
export const USER_MESSAGE_INLINE_BYTES = 256 * 1024;

export function buildUnreadOutcomeSql(deps: PgSessionsDeps): string {
  return deps.storage.CLIENT_SESSION_UNREAD_OUTCOMES.map((o) => `'${o}'`).join(",");
}

export function buildLastReadAtMsSql(deps: PgSessionsDeps): string {
  return deps.storage.lastReadAtWatermarkMsSql("cs.last_read_at");
}

export function dispatchUidForList(userId: string): string {
  return /^c:([1-9][0-9]*)$/.exec(userId)?.[1] ?? "-1";
}

function buildUnreadBySessionIdsSql(deps: PgSessionsDeps): string {
  const unreadOutcomeSql = buildUnreadOutcomeSql(deps);
  const lastReadAtMsSql = buildLastReadAtMsSql(deps);
  return `SELECT cs.id,
                 (last_d.outcome IN (${unreadOutcomeSql})
                  AND ${LAST_D_TERMINAL_MS_SQL} > ${lastReadAtMsSql}) AS unread
            FROM client_sessions cs
            LEFT JOIN LATERAL (
              SELECT outcome, terminal_at
                FROM turn_dispatches
               WHERE user_id = $2
                 AND session_id = cs.id
                 AND status = 'terminal'
               ORDER BY terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC
               LIMIT 1
            ) last_d ON TRUE
           WHERE cs.user_id = $1 AND cs.deleted_at IS NULL AND cs.id = ANY($3::text[])`;
}

export async function pgUnreadBySessionIds(
  pool: Pool,
  userId: string,
  ids: string[],
  deps: PgSessionsDeps,
): Promise<Map<string, boolean>> {
  const unread = new Map<string, boolean>();
  if (ids.length === 0) return unread;
  const sql = buildUnreadBySessionIdsSql(deps);
  const rows = (
    await pool.query<{ id: string; unread: boolean }>(sql, [
      userId,
      dispatchUidForList(userId),
      ids,
    ])
  ).rows;
  for (const r of rows) unread.set(r.id, r.unread === true);
  return unread;
}

const ADVANCE_TIMELINE_IDENTITY_SQL = `UPDATE client_sessions
    SET history_revision = history_revision + 1,
        timeline_generation = timeline_generation + 1,
        updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
  WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;

/** Publish a new browser-timeline identity on the caller's existing transaction. */
export async function advanceClientTimelineIdentityInTransaction(
  q: QueryRunner,
  sessionId: string,
  userId: string,
): Promise<void> {
  await q.query(ADVANCE_TIMELINE_IDENTITY_SQL, [sessionId, userId]);
}

export function pgModelSidecarText(text: string): string {
  return text.replaceAll("\u0000", "\\u0000");
}

export function escapeNulInSessionMessagesJson(json: string): string {
  return json.replace(/(\\+)u0000/g, (whole, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes}\\u0000` : whole,
  );
}

export function seqOfMessage(msgs: MessageLike[], id: string): number | undefined {
  const hit = msgs.find((m) => m && m.id === id);
  return typeof hit?._seq === "number" ? hit._seq : undefined;
}

export function stripWorkspaceMode(
  result: PgAppendCoreResult,
): Omit<PgAppendCoreResult, "workspaceMode"> {
  const { workspaceMode: _workspaceMode, ...publicResult } = result;
  return publicResult;
}

// ── Post-commit callback notifications ───────────────────────────────────────

export function notifySessionsDeleted(
  callback: PgSessionsBackendOptions["onClientSessionsDeleted"],
  userId: string | undefined,
  sessionIds: readonly string[],
): void {
  if (!callback || !userId || sessionIds.length === 0) return;
  try {
    void Promise.resolve(callback(userId, sessionIds)).catch((err) => {
      void err;
    });
  } catch (err) {
    void err;
  }
}

export async function notifyGoalUsageChanges(
  callback: PgSessionsBackendOptions["onGoalUsageChanged"],
  changes: readonly GoalUsageChange[],
): Promise<void> {
  if (!callback || changes.length === 0) return;
  const unique = new Map(changes.map((change) => [`${change.userId}\0${change.sessionId}`, change]));
  await Promise.allSettled(
    [...unique.values()].map((change) => Promise.resolve(callback(change.userId, change.sessionId))),
  );
}

export async function notifyRecoveryJobTerminals(
  callback: PgSessionsBackendOptions["onRecoveryJobTerminal"],
  userId: string,
  sessionId: string,
  rows: readonly RecoveryJobTerminalRow[],
): Promise<void> {
  if (!callback || rows.length === 0) return;
  await Promise.allSettled(
    rows
      .filter((row): row is RecoveryJobTerminalRow & { status: "completed" | "paused" } =>
        row.status === "completed" || row.status === "paused")
      .map((row) =>
        Promise.resolve().then(() =>
          callback(userId, sessionId, {
            rootClientMessageId: row.rootClientMessageId,
            errorCode: row.errorCode,
            semanticAttempt: row.semanticAttempt,
            terminalStatus: row.status,
            pauseReason: row.pauseReason,
          }),
        ),
      ),
  );
}

// ── Singleflight & finalize dispatch convergence ─────────────────────────────

export function _createFinalizeSingleflight<T>(): (
  key: string,
  run: () => Promise<T>,
) => { promise: Promise<T>; shared: boolean } {
  const inFlight = new Map<string, Promise<T>>();
  return (key, run) => {
    const existing = inFlight.get(key);
    if (existing) return { promise: existing, shared: true };
    const promise = Promise.resolve().then(run);
    inFlight.set(key, promise);
    const cleanup = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    void promise.then(cleanup, cleanup);
    return { promise, shared: false };
  };
}

export function _losslessFinalizeSingleflightKey(
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
): string {
  return JSON.stringify([
    userId,
    request.sessionId,
    request.tapeId,
    request.agentId,
    request.turnIndex,
    request.status,
    request.turnKey,
    request.tapeSha256,
    request.totalBytes,
    request.partCount,
    request.createdAt,
    request.waiveReason ?? null,
    request.dispatchId ?? null,
    request.attemptNo ?? null,
    request.settlement
      ? settlementAuthorityHash({
          billingAnchorId: request.settlement.billingAnchorId,
          requestId: request.settlement.requestId,
          engineBillings: request.settlement.engineBillings,
        })
      : null,
  ]);
}

export function errorCodeFromVisibleHead(head: unknown): string | null {
  if (!head || typeof head !== "object") return null;
  const code = (head as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function failureCodeForTapeOutcome(
  tapeStatus: string,
  errorCode?: string | null,
): string | null {
  const outcome =
    tapeStatus === "completed" ? "completed" :
    tapeStatus === "interrupted" ? "interrupted" : "crashed";
  if (outcome === "completed") return null;
  if (typeof errorCode === "string" && errorCode.length > 0) return errorCode;
  return outcome;
}

export async function convergeDispatchOnFinalize(
  client: PoolClient,
  dispatchId: string,
  tapeStatus: string,
  deps: PgSessionsDeps,
  failureCode?: string | null,
): Promise<{ lateTape: boolean; removedVisibleStatus: boolean }> {
  const outcome =
    tapeStatus === "completed" ? "completed" :
    tapeStatus === "interrupted" ? "interrupted" : "crashed";
  const nextFailureCode = failureCodeForTapeOutcome(tapeStatus, failureCode);
  await client.query(
    "SELECT 1 FROM turn_dispatches WHERE dispatch_id=$1::uuid FOR UPDATE",
    [dispatchId],
  );
  const fenced = await client.query<{ producer_fenced_at: Date | null }>(
    "SELECT producer_fenced_at FROM turn_dispatches WHERE dispatch_id=$1::uuid",
    [dispatchId],
  );
  if (fenced.rows[0]?.producer_fenced_at) {
    await client.query(
      `UPDATE turn_tape_settlement_jobs
          SET status='held', last_error='late_tape_after_fence', updated_at=NOW()
        WHERE dispatch_id=$1::uuid AND status IN ('queued','leased','failed')`,
      [dispatchId],
    );
    const held = await deps.dispatch.casToManualReconcile(client, {
      dispatchId,
      conflictReason: "late_tape_after_fence",
      fromStatuses: ["admitted", "accepted", "rejecting", "terminal"],
    });
    return { lateTape: held !== null, removedVisibleStatus: false };
  }
  const converged = await deps.dispatch.casToTerminal(client, {
    dispatchId,
    outcome,
    failureCode: nextFailureCode,
    fromStatuses: ["admitted", "accepted", "rejecting"],
  });
  if (converged !== null) return { lateTape: false, removedVisibleStatus: false };
  return convergeTerminalFallbackDispatch(client, dispatchId, outcome, nextFailureCode, deps);
}

async function convergeTerminalFallbackDispatch(
  client: PoolClient,
  dispatchId: string,
  outcome: "completed" | "interrupted" | "crashed",
  nextFailureCode: string | null,
  deps: PgSessionsDeps,
): Promise<{ lateTape: boolean; removedVisibleStatus: boolean }> {
  const d = await deps.dispatch.getDispatch(client, dispatchId);
  if (
    d && d.status === "terminal" && d.outcome === "executed_error" &&
    (d.failureCode === "RESULT_RECOVERY_PENDING" || d.failureCode === "SERVICE_RESTART")
  ) {
    await client.query(
      `UPDATE turn_dispatches
          SET outcome=$2, failure_code=$3, client_notified=FALSE,
              terminal_at=clock_timestamp()
        WHERE dispatch_id=$1 AND status='terminal'
          AND outcome='executed_error'
          AND failure_code IN ('RESULT_RECOVERY_PENDING','SERVICE_RESTART')`,
      [dispatchId, outcome, nextFailureCode],
    );
    return { lateTape: false, removedVisibleStatus: d.clientNotified };
  }
  if (d && d.status === "terminal" && d.outcome === "not_accepted") {
    const held = await deps.dispatch.casToManualReconcile(client, {
      dispatchId,
      conflictReason: "late_tape",
      fromStatuses: ["terminal"],
    });
    return {
      lateTape: held !== null,
      removedVisibleStatus: held !== null && d.clientNotified,
    };
  }
  return { lateTape: false, removedVisibleStatus: false };
}

// ── Shared user payload hydration & lightweight lookups ──────────────────────

export async function hydrateRecoverySourceUser(
  client: Pool | PoolClient,
  sessionId: string,
  userId: string,
  source: MessageLike,
): Promise<MessageLike | null> {
  if (source._userPayloadDeferred !== true) return source;
  if (typeof source.id !== "string") return null;
  const row = (
    await client.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_user_payloads
        WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
      [sessionId, userId, source.id],
    )
  ).rows[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.id !== source.id || parsed.role !== "user"
    ) return null;
    return parsed as MessageLike;
  } catch (err) {
    void err;
    return null;
  }
}

export async function readClientSessionModelId(
  pool: Pick<Pool, "query">,
  sessionId: string,
  sessionUserId: string,
): Promise<string | null> {
  const res = await pool.query<{ model_id: string | null }>(
    "SELECT model_id FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [sessionId, sessionUserId],
  );
  return res.rows[0]?.model_id ?? null;
}

export async function lookupLeaseCallbackSession(
  pool: Pick<Pool, "query">,
  uid: string,
  sessionId: string,
): Promise<"owned" | "gone" | "foreign"> {
  const own = await pool.query<{ deleted_at: unknown }>(
    "SELECT deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, `c:${uid}`],
  );
  if (own.rows.length) return own.rows[0]!.deleted_at == null ? "owned" : "gone";
  const other = await pool.query(
    "SELECT 1 FROM client_sessions WHERE id = $1 LIMIT 1",
    [sessionId],
  );
  return other.rows.length ? "foreign" : "gone";
}

// ── Schema & migration state probe (RFC D5) ──────────────────────────────────

export const PROBE_EXPECTED_COLUMNS: ReadonlyArray<[string, string, string]> = [
  ["client_sessions", "id", "text"],
  ["client_sessions", "updated_at", "bigint"],
  ["client_sessions", "messages", "text"],
  ["client_sessions", "pinned", "smallint"],
  ["client_sessions", "next_seq", "integer"],
  ["client_sessions", "archived_through_seq", "integer"],
  ["client_sessions", "archived_at", "bigint"],
  ["client_sessions", "last_read_at", "bigint"],
  ["client_sessions", "history_revision", "bigint"],
  ["client_sessions", "timeline_generation", "bigint"],
  ["client_session_archive_chunks", "session_id", "text"],
  ["client_session_archive_chunks", "first_seq", "integer"],
  ["client_session_archive_chunks", "messages", "text"],
  ["client_session_archived_ids", "session_id", "text"],
  ["client_session_archived_ids", "msg_id", "text"],
  ["server_authored_request_map", "request_id", "text"],
  ["server_authored_request_map", "user_id", "text"],
  ["server_authored_request_map", "session_id", "text"],
  ["server_authored_request_map", "written_at", "bigint"],
  ["pending_usage_patches", "request_id", "text"],
  ["pending_usage_patches", "cost_credits", "text"],
  ["pending_usage_patches", "created_at", "bigint"],
  ["pending_usage_patches", "turn_key", "text"],
  ["client_session_turn_tapes", "tape_id", "text"],
  ["client_session_turn_tapes", "turn_key", "text"],
  ["client_session_turn_tapes", "engine_billings", "jsonb"],
  ["client_session_turn_tapes", "goal_id", "uuid"],
  ["client_session_turn_tapes", "goal_state_revision", "bigint"],
  ["client_session_turn_tapes", "goal_tokens_used", "bigint"],
  ["client_session_turn_tapes", "record_storage_format", "smallint"],
  ["client_session_turn_tapes", "client_message_id", "text"],
  ["client_session_turn_tapes", "continuation_of_turn_key", "text"],
  ["client_session_turn_tapes", "physical_record_count", "integer"],
  ["client_session_turn_tapes", "logical_record_count", "integer"],
  ["client_session_turn_tapes", "record_payload_bytes", "bigint"],
  ["client_session_turn_tapes", "model_record_count", "integer"],
  ["client_session_turn_tapes", "visible_at", "bigint"],
  ["client_session_turn_tapes", "visible_head", "jsonb"],
  ["client_session_turn_tapes", "materialization_status", "text"],
  ["client_session_turn_tapes", "settlement_hash", "text"],
  ["turn_dispatches", "visible_head", "jsonb"],
  ["turn_dispatches", "visible_at", "bigint"],
  ["turn_dispatches", "producer_fenced_at", "timestamp with time zone"],
  ["turn_dispatches", "shutdown_ctx", "jsonb"],
  ["turn_tape_materialization_jobs", "job_id", "uuid"],
  ["turn_tape_settlement_jobs", "job_id", "uuid"],
  ["client_session_turn_tape_parts", "payload", "bytea"],
  ["client_session_turn_tape_records", "payload", "bytea"],
  ["client_session_turn_tape_records", "visible_payload", "bytea"],
  ["client_session_turn_tape_records", "visible_content_sha256", "text"],
  ["client_session_turn_tape_records", "model_sidecar_complete", "boolean"],
  ["client_session_turn_tape_model_records", "semantic_text", "text"],
  ["client_session_turn_tape_model_records", "token_estimate", "integer"],
  ["client_session_user_payloads", "model_token_estimate", "integer"],
  ["server_authored_turn_anchor_map", "turn_key", "text"],
  ["turn_tape_cost_components", "request_id", "text"],
  ["turn_tape_recovery_links", "source_tape_id", "text"],
  ["turn_tape_recovery_links", "recovery_tape_id", "text"],
  ["turn_tape_recovery_links", "source_turn_key", "text"],
  ["turn_tape_recovery_links", "recovery_turn_key", "text"],
  ["session_goals", "session_id", "text"],
  ["session_goals", "goal_id", "uuid"],
  ["session_goals", "state_revision", "bigint"],
  ["session_goals", "snapshot_revision", "bigint"],
  ["wechat_bindings", "user_id", "text"],
  ["wechat_bindings", "account_id", "text"],
  ["wechat_bindings", "bot_token", "text"],
];

const PROBE_TABLES = [
  "client_sessions",
  "client_session_archive_chunks",
  "client_session_archived_ids",
  "server_authored_request_map",
  "pending_usage_patches",
  "client_session_turn_tapes",
  "client_session_turn_tape_parts",
  "client_session_turn_tape_records",
  "client_session_turn_tape_model_records",
  "client_session_user_payloads",
  "server_authored_turn_anchor_map",
  "turn_tape_cost_components",
  "turn_tape_recovery_links",
  "turn_dispatches",
  "turn_tape_materialization_jobs",
  "turn_tape_settlement_jobs",
  "session_goals",
  "wechat_bindings",
];

export async function probeSessionsDb(
  pool: Pool,
  expectedGeneration: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await pool.query("SELECT 1");
    const cols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = ANY(current_schemas(false))
          AND table_name = ANY($1::text[])`,
      [PROBE_TABLES],
    );
    const typeOf = new Map<string, string>();
    for (const r of cols.rows) typeOf.set(`${r.table_name}.${r.column_name}`, r.data_type);
    for (const [t, c, expected] of PROBE_EXPECTED_COLUMNS) {
      const actual = typeOf.get(`${t}.${c}`);
      if (actual !== expected) {
        return { ok: false, error: `column ${t}.${c} type=${actual ?? "(missing)"} expected=${expected}` };
      }
    }
    const st = (
      await pool.query<{ authority: string; generation: string }>(
        "SELECT authority, generation FROM sessions_store_migration_state WHERE singleton = true",
      )
    ).rows[0];
    if (!st) return { ok: false, error: "sessions_store_migration_state 无 singleton 行" };
    if (st.authority !== "pg_authoritative") {
      return { ok: false, error: `authority=${st.authority} 非 pg_authoritative` };
    }
    const gen = bigIntNum(st.generation, "migration_state.generation");
    if (gen !== expectedGeneration) {
      return { ok: false, error: `generation 漂移: 现 ${gen} 启动快照 ${expectedGeneration}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
