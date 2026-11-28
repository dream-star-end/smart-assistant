import type { Pool, PoolClient } from "pg";
import { parseSessionWorkspaceMode, type SessionWorkspaceMode } from "@openclaude/protocol";
import type {
  AppendForRequestResult,
  ClientSession,
  ClientSessionLifecycle,
  ClientSessionLifecycleRef,
  ClientSessionMetaPatch,
  ClientSessionOwnership,
  MessageLike,
  PatchClientSessionMetaResult,
  UpsertClientSessionResult,
} from "@openclaude/storage";
import {
  convergeFinalizedTapeLiveStreams as convergeDurableFinalizedTapeLiveStreams,
  readClientSessionLiveFrames as readDurableClientSessionLiveFrames,
  readClientSessionLiveUnits as readDurableClientSessionLiveUnits,
  readLiveOrTapeFramePayload as readDurableLiveOrTapeFramePayload,
} from "../liveTurnFrames.js";
import { computeSessionLastPreviewRaw } from "../pgTimelinePerf.js";
import { patchSessionMetadataInTx } from "../sessionMetadataApproval.js";
import { buildSessionSnapshot, type SessionSnapshotOptions } from "../sessionSnapshot.js";
import { execPgSpillPlan, filterOutArchivedIncoming, pgAppendServerAuthoredCore } from "./appendCore.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import {
  CLOCK_MS_SQL,
  PG_STALE_WRITE_ROLLBACK,
  bigIntNum,
  bigIntNumOr,
  escapeNulInSessionMessagesJson,
  notifySessionsDeleted,
  requestAdvisoryXactLock,
  withTx,
} from "./sqlHelpers.js";
import type { PgAppendCoreResult, PgSessionsBackendOptions } from "./types.js";

const UPSERT_CLIENT_SESSION_SQL = `INSERT INTO client_sessions
   (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count, model_id, history_revision, timeline_generation, last_preview)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, GREATEST($10, ${CLOCK_MS_SQL}), $11, $12, $13, $15, 0, 1, $18)
 ON CONFLICT (id) DO UPDATE SET
   agent_id = EXCLUDED.agent_id,
   title = EXCLUDED.title,
   pinned = EXCLUDED.pinned,
   last_at = EXCLUDED.last_at,
   messages = EXCLUDED.messages,
   message_count = EXCLUDED.message_count,
   model_id = COALESCE(EXCLUDED.model_id, client_sessions.model_id),
   updated_at = GREATEST(client_sessions.updated_at + 1, ${CLOCK_MS_SQL}, EXCLUDED.updated_at),
   next_seq = EXCLUDED.next_seq,
   archived_through_seq = EXCLUDED.archived_through_seq,
   archived_count = EXCLUDED.archived_count,
   history_revision = client_sessions.history_revision + $16,
   timeline_generation = client_sessions.timeline_generation + $17,
   last_preview = EXCLUDED.last_preview
 WHERE client_sessions.updated_at <= $14 AND client_sessions.user_id = $2`;

const SOFT_DELETE_SESSION_FOR_USER_SQL = `UPDATE client_sessions
   SET deleted_at = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       messages = '[]', message_count = 0, last_preview = ''
 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`;

const SOFT_DELETE_SESSION_ALL_SQL = `UPDATE client_sessions
   SET deleted_at = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       messages = '[]', message_count = 0, last_preview = ''
 WHERE id = $2 AND deleted_at IS NULL`;

const DELETE_USER_PAYLOADS_FOR_USER_SQL =
  "DELETE FROM client_session_user_payloads WHERE session_id=$1 AND user_id=$2";
const DELETE_USER_PAYLOADS_ALL_SQL =
  "DELETE FROM client_session_user_payloads WHERE session_id=$1";
const DELETE_PENDING_PARENT_FOR_USER_SQL =
  "DELETE FROM pending_usage_patches WHERE user_id = $2 AND parent_session_id = $1 AND parent_session_id IS NOT NULL";
const DELETE_PENDING_PARENT_ALL_SQL =
  "DELETE FROM pending_usage_patches WHERE parent_session_id = $1";

const SET_CLIENT_SESSION_MODEL_SQL = `UPDATE client_sessions
   SET model_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING updated_at`;

const BUMP_HISTORY_REVISION_SQL = `UPDATE client_sessions
   SET history_revision = history_revision + 1, timeline_generation = timeline_generation + 1,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;

const INSERT_MASTER_CLIENT_SESSION_SQL = `INSERT INTO client_sessions
   (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
 VALUES ($1, $2, $3, $4, $5, $6, GREATEST($6, ${CLOCK_MS_SQL}), $7)`;

const CLAIM_SESSION_SQL = `UPDATE client_sessions
   SET user_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $2 AND user_id = 'default' AND deleted_at IS NULL`;

type AppendFailureReason =
  | "session_not_found"
  | "session_deleted"
  | "already_exists"
  | "malformed"
  | "oversized";

type ServerAuthoredMessageInput = {
  id: string;
  role: "assistant" | "user" | "system" | "thinking" | "tool" | "agent-group" | "permission";
  text?: string;
  ts?: number;
  [k: string]: unknown;
};

type ExistingSessionUpsertRow = {
  messages: string;
  updated_at: string;
  next_seq: number | null;
  archived_through_seq: number | null;
  archived_count: number | null;
  history_revision: string;
};

type LiveUnitsOptions = {
  n?: number;
  k?: number;
  before?: string | null;
  group?: string | null;
  nestedBefore?: string | null;
  deadlineMs?: number;
  maxBytes?: number;
};

type MasterClientSessionInput = {
  sessionId: string;
  userId: string;
  agentId: string;
  originChannel: "wechat" | "qqbot";
  title: string;
  createdAt: number;
  lastAt: number;
};

function toAppendFailureReason(reason: string | undefined): AppendFailureReason {
  if (
    reason === "session_not_found" ||
    reason === "session_deleted" ||
    reason === "already_exists" ||
    reason === "malformed" ||
    reason === "oversized"
  ) {
    return reason;
  }
  return "malformed";
}

function toAppendForRequestResult(r: PgAppendCoreResult): AppendForRequestResult {
  if (r.applied) return { applied: true };
  const reason = toAppendFailureReason(r.reason);
  const res: AppendForRequestResult & { seq?: number } =
    r.seq !== undefined ? { applied: false, reason, seq: r.seq } : { applied: false, reason };
  return res;
}

function parseExistingMessages(raw: string): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
  } catch (err) {
    void err;
    return [];
  }
}

async function runUpsertClientSessionTx(
  client: PoolClient,
  session: ClientSession,
  baseSyncedAt: number,
  deps: PgSessionsDeps,
): Promise<UpsertClientSessionResult> {
  const existing = (
    await client.query<ExistingSessionUpsertRow>(
      "SELECT messages, updated_at, next_seq, archived_through_seq, archived_count, history_revision FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
      [session.id, session.userId],
    )
  ).rows[0];
  // stale 检测:FOR UPDATE 后做 → 竞态消失(悲观化)。此时尚未 spill,直接返回干净。
  if (existing && bigIntNum(existing.updated_at, "updated_at") > baseSyncedAt) {
    return "rejected_stale";
  }
  const oldMsgs = existing ? parseExistingMessages(existing.messages) : [];
  const clientMsgsRaw = deps.storage._stripClientPutMessages(session.messages as unknown[], oldMsgs);
  const clientMsgs = await filterOutArchivedIncoming(client, session.id, clientMsgsRaw);
  const merged = deps.storage.mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[];
  const currentNextSeq =
    existing && typeof existing.next_seq === "number" && existing.next_seq > 0
      ? existing.next_seq
      : 1;
  const archivedThrough = bigIntNumOr(existing?.archived_through_seq, 0);
  const { messages: finalMessages, nextSeq } = deps.storage.normalizeAndAssignSeqs(
    oldMsgs,
    merged,
    currentNextSeq,
    deps.storage._warnSeqAnomaly,
    archivedThrough,
  );
  const now = Date.now();
  const plan = deps.storage.planSpillOverflow(finalMessages, archivedThrough);
  const tail = plan.tail;
  const finalJson = escapeNulInSessionMessagesJson(JSON.stringify(tail));
  // size guard 在 spill 执行前(理论不可达;命中则不落孤儿 chunk,ROLLBACK 更干净)。
  if (Buffer.byteLength(finalJson, "utf8") > deps.storage.MAX_SESSION_BYTES) return "oversized";
  const archivedDelta = await execPgSpillPlan(
    client,
    session.id,
    session.userId,
    plan.chunksToInsert,
    plan.idsToInsert,
    now,
  );
  const newArchivedCount = bigIntNumOr(existing?.archived_count, 0) + archivedDelta;
  const historyRevisionDelta =
    existing && (deps.storage.hasInvisibleHistoryMutation(oldMsgs, finalMessages, tail) || archivedDelta > 0)
      ? 1
      : 0;
  const timelineGenerationDelta =
    existing && deps.storage.hasInvisibleMessageRemoval(oldMsgs, finalMessages) ? 1 : 0;

  const res = await client.query(UPSERT_CLIENT_SESSION_SQL, [
    session.id, session.userId, session.agentId, session.title, session.pinned ? 1 : 0,
    session.createdAt, session.lastAt, finalJson, tail.length + newArchivedCount,
    session.updatedAt, nextSeq, plan.archivedThroughSeq, newArchivedCount, baseSyncedAt,
    session.modelId ?? null, historyRevisionDelta, timelineGenerationDelta,
    computeSessionLastPreviewRaw(tail),
  ]);
  if ((res.rowCount ?? 0) > 0) return "applied";
  throw PG_STALE_WRITE_ROLLBACK;
}

async function upsertClientSessionImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  session: ClientSession,
  baseSyncedAt = 0,
): Promise<UpsertClientSessionResult> {
  try {
    return await withTx(pool, (client) => runUpsertClientSessionTx(client, session, baseSyncedAt, deps));
  } catch (err) {
    if (err === PG_STALE_WRITE_ROLLBACK) return "rejected_stale";
    throw err;
  }
}

async function appendServerAuthoredMessageImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  sessId: string,
  userId: string,
  message: ServerAuthoredMessageInput,
): Promise<{ applied: boolean; reason?: AppendFailureReason }> {
  const r = await withTx(pool, (client) =>
    pgAppendServerAuthoredCore(client, sessId, userId, message as MessageLike & { id: string }, deps),
  );
  return r.applied ? { applied: true } : { applied: false, reason: toAppendFailureReason(r.reason) };
}

async function runPatchServerAuthoredMessageTx(
  client: PoolClient,
  sessId: string,
  userId: string,
  msgId: string,
  patch: Record<string, unknown>,
): Promise<{ applied: true } | { applied: false; reason: "session_not_found" | "session_deleted" | "not_found" }> {
  const row = await client.query<{ messages: unknown; next_seq: number | null; deleted_at: Date | string | null }>(
    "SELECT messages, next_seq, deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [sessId, userId],
  );
  if (row.rowCount === 0) return { applied: false, reason: "session_not_found" };
  const rec = row.rows[0]!;
  if (rec.deleted_at != null) return { applied: false, reason: "session_deleted" };
  const msgs = Array.isArray(rec.messages) ? (rec.messages as Array<Record<string, unknown>>) : null;
  if (!msgs) return { applied: false, reason: "not_found" };
  const idx = msgs.findIndex((m) => m && m.id === msgId);
  if (idx < 0) return { applied: false, reason: "not_found" };
  const nextSeq = typeof rec.next_seq === "number" && rec.next_seq > 0 ? rec.next_seq : 1;
  msgs[idx] = { ...msgs[idx], ...patch, id: msgId, _source: "server", _seq: nextSeq };
  const upd = await client.query(
    "UPDATE client_sessions SET messages = $1::jsonb, updated_at = GREATEST(updated_at + 1, $2), next_seq = $3, history_revision = history_revision + 1, last_preview = $6 WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL",
    [
      escapeNulInSessionMessagesJson(JSON.stringify(msgs)),
      Date.now(),
      nextSeq + 1,
      sessId,
      userId,
      computeSessionLastPreviewRaw(msgs),
    ],
  );
  return upd.rowCount === 1 ? { applied: true } : { applied: false, reason: "session_deleted" };
}

async function runAppendForRequestTx(
  client: PoolClient,
  requestId: string,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
  deps: PgSessionsDeps,
): Promise<AppendForRequestResult> {
  await requestAdvisoryXactLock(client, userId, requestId);
  // 锁序:advisory → client_sessions 行 → server_authored_request_map → pending_usage_patches。
  await client.query("SELECT id FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessId, userId]);
  const existingMap = (
    await client.query<{ session_id: string; msg_id: string }>(
      "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
      [requestId, userId],
    )
  ).rows[0];
  if (existingMap && (existingMap.session_id !== sessId || existingMap.msg_id !== message.id)) {
    throw new Error(
      `[pgSessions] server_authored_request_map 拒绝重映射: (requestId=${requestId},userId=${userId}) ` +
        `已映射 (${existingMap.session_id},${existingMap.msg_id}),本次欲映射 (${sessId},${message.id})`,
    );
  }
  const pending = (
    await client.query<{ cost_credits: string }>(
      "SELECT cost_credits FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
      [requestId, userId],
    )
  ).rows[0];
  let msgToWrite: MessageLike & { id: string } = message;
  if (pending) {
    const existingUsage =
      message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : {};
    msgToWrite = { ...message, usage: { ...existingUsage, costCredits: pending.cost_credits } };
  }
  const r = await pgAppendServerAuthoredCore(client, sessId, userId, msgToWrite, deps);
  if (!r.applied) {
    if (pending && (r.reason === "session_deleted" || r.reason === "oversized")) {
      await client.query("DELETE FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2", [requestId, userId]);
    }
    return toAppendForRequestResult(r);
  }
  if (!existingMap) {
    await client.query(
      `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id, user_id) DO NOTHING`,
      [requestId, userId, sessId, message.id],
    );
  }
  if (pending) {
    await client.query("DELETE FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2", [requestId, userId]);
  }
  return { applied: true };
}

function sumPendingCostCredits(pendings: ReadonlyArray<{ cost_credits: string }>): bigint {
  let sum = 0n;
  for (const p of pendings) {
    try {
      const v = BigInt(p.cost_credits);
      if (v > 0n) sum += v;
    } catch (err) {
      void err;
    }
  }
  return sum;
}

function mergePendingCostSum(
  message: MessageLike & { id: string },
  sum: bigint,
): MessageLike & { id: string } {
  if (sum <= 0n) return message;
  const existingUsage =
    message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : {};
  let base = 0n;
  try {
    base = BigInt((existingUsage.costCredits as string) ?? "0");
  } catch (err) {
    void err;
    base = 0n;
  }
  return { ...message, usage: { ...existingUsage, costCredits: (base + sum).toString() } };
}

async function runAppendDrainByUserTx(
  client: PoolClient,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
  agentSessionId: string | null | undefined,
  deps: PgSessionsDeps,
): Promise<AppendForRequestResult> {
  // 锁序:先锁会话行,再 FOR UPDATE 本批 pending(SELECT 后新 park 的行留给下一轮)。
  await client.query("SELECT id FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessId, userId]);
  const pendings = (
    agentSessionId
      ? await client.query<{ request_id: string; cost_credits: string }>(
          "SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = $1 AND session_id = $2 ORDER BY request_id FOR UPDATE",
          [userId, agentSessionId],
        )
      : await client.query<{ request_id: string; cost_credits: string }>(
          "SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = $1 ORDER BY request_id FOR UPDATE",
          [userId],
        )
  ).rows;
  const msgToWrite = mergePendingCostSum(message, sumPendingCostCredits(pendings));
  const r = await pgAppendServerAuthoredCore(client, sessId, userId, msgToWrite, deps);
  if (!r.applied) return toAppendForRequestResult(r);
  if (pendings.length > 0) {
    await client.query(
      "DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = ANY($2::text[])",
      [userId, pendings.map((p) => p.request_id)],
    );
  }
  return { applied: true };
}

async function runDeleteClientSessionTx(
  client: PoolClient,
  id: string,
  userId: string | undefined,
  now: number,
): Promise<boolean> {
  const softDeleteSql = userId ? SOFT_DELETE_SESSION_FOR_USER_SQL : SOFT_DELETE_SESSION_ALL_SQL;
  const result = await client.query(softDeleteSql, userId ? [now, id, userId] : [now, id]);
  if ((result.rowCount ?? 0) === 0) return false;
  const userPayloadsSql = userId ? DELETE_USER_PAYLOADS_FOR_USER_SQL : DELETE_USER_PAYLOADS_ALL_SQL;
  await client.query(userPayloadsSql, userId ? [id, userId] : [id]);
  await client.query("DELETE FROM client_session_archive_chunks WHERE session_id = $1", [id]);
  await client.query("DELETE FROM client_session_archived_ids WHERE session_id = $1", [id]);
  await client.query("DELETE FROM turn_tape_recovery_links WHERE session_id = $1", [id]);
  await client.query("DELETE FROM client_session_turn_tapes WHERE session_id = $1", [id]);
  const pendingParentSql = userId ? DELETE_PENDING_PARENT_FOR_USER_SQL : DELETE_PENDING_PARENT_ALL_SQL;
  await client.query(pendingParentSql, userId ? [id, userId] : [id]);
  return true;
}

async function deleteClientSessionImpl(
  pool: Pool,
  options: PgSessionsBackendOptions,
  id: string,
  userId?: string,
): Promise<boolean> {
  const now = Date.now();
  const deleted = await withTx(pool, (client) => runDeleteClientSessionTx(client, id, userId, now));
  if (deleted) notifySessionsDeleted(options.onClientSessionsDeleted, userId, [id]);
  return deleted;
}

async function renameClientSessionImpl(
  pool: Pool,
  id: string,
  userId: string,
  title: string,
): Promise<{ ok: boolean; updatedAt: number }> {
  const now = Date.now();
  const result = await withTx(pool, (client) => patchSessionMetadataInTx(client, id, userId, { title }));
  return { ok: result.ok, updatedAt: result.ok ? result.updatedAt : now };
}

async function setClientSessionModelImpl(
  pool: Pool,
  id: string,
  userId: string,
  modelId: string,
): Promise<{ ok: boolean; updatedAt: number }> {
  const now = Date.now();
  const row = (
    await pool.query<{ updated_at: string }>(SET_CLIENT_SESSION_MODEL_SQL, [modelId, id, userId])
  ).rows[0];
  return { ok: !!row, updatedAt: row ? bigIntNum(row.updated_at, "updated_at") : now };
}

async function patchClientSessionMetaImpl(
  pool: Pool,
  id: string,
  userId: string,
  patch: ClientSessionMetaPatch,
): Promise<PatchClientSessionMetaResult> {
  return withTx(pool, async (client) => {
    const result = await patchSessionMetadataInTx(client, id, userId, patch);
    return result.ok ? { ok: true, updatedAt: result.updatedAt } : result;
  });
}

function summarizeUnclaimedMessages(raw: string): string {
  try {
    const msgs = JSON.parse(raw) as Array<{ role?: string; text?: string }>;
    const userMsgs = msgs.filter((m) => m.role === "user").slice(0, 3);
    const summary = userMsgs.map((m) => (m.text || "").slice(0, 80)).join(" / ");
    return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
  } catch (err) {
    void err;
    return "";
  }
}

async function listUnclaimedSessionsImpl(pool: Pool) {
  const rows = (
    await pool.query<{
      id: string; agent_id: string; title: string; created_at: string;
      last_at: string; messages: string; msg_count: number;
    }>(
      `SELECT id, agent_id, title, created_at, last_at, messages, message_count AS msg_count
         FROM client_sessions WHERE user_id = 'default' AND deleted_at IS NULL ORDER BY last_at DESC`,
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    createdAt: bigIntNum(r.created_at, "created_at"),
    lastAt: bigIntNum(r.last_at, "last_at"),
    messageCount: r.msg_count,
    summary: summarizeUnclaimedMessages(r.messages),
  }));
}

async function allMasterWsessRowsImpl(pool: Pool) {
  const rows = (
    await pool.query<{ id: string; userId: string; createdAt: string }>(
      `SELECT id, user_id AS "userId", created_at AS "createdAt"
         FROM client_sessions
        WHERE id ~ '^wsess-[0-9a-f]{16}$' AND origin_channel = 'wechat' AND deleted_at IS NULL`,
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    createdAt: bigIntNum(r.createdAt, "created_at"),
  }));
}

async function getClientSessionCollabParentImpl(pool: Pool, sessionId: string, userId: string) {
  const row = (
    await pool.query<{ id: string; user_id: string; agent_id: string; model_id: string | null }>(
      `SELECT id, user_id, agent_id, model_id FROM client_sessions
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [sessionId, userId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
  };
}

async function classifyClientSessionsImpl(
  pool: Pool,
  refs: readonly ClientSessionLifecycleRef[],
): Promise<ClientSessionLifecycle[]> {
  if (refs.length === 0) return [];
  const rows = (
    await pool.query<{ ordinal: string; session_id: string; user_id: string; state: "active" | "deleted" | "missing" }>(
      `SELECT entry.ordinal::text AS ordinal,
              entry.value->>'sessionId' AS session_id,
              entry.value->>'userId' AS user_id,
              CASE WHEN cs.id IS NULL THEN 'missing'
                   WHEN cs.deleted_at IS NULL THEN 'active'
                   ELSE 'deleted' END AS state
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entry(value, ordinal)
         LEFT JOIN client_sessions cs
           ON cs.id=entry.value->>'sessionId' AND cs.user_id=entry.value->>'userId'
        ORDER BY entry.ordinal`,
      [JSON.stringify(refs)],
    )
  ).rows;
  return rows.map((row) => ({ sessionId: row.session_id, userId: row.user_id, state: row.state }));
}

async function verifyClientSessionOwnershipImpl(
  pool: Pool,
  id: string,
  expectedUserId: string,
): Promise<ClientSessionOwnership> {
  const row = (
    await pool.query<{ user_id: string }>(
      "SELECT user_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
      [id],
    )
  ).rows[0];
  if (!row) return "not_found";
  return row.user_id === expectedUserId ? "owner" : "forbidden";
}

async function getClientSessionWorkspaceModeImpl(
  pool: Pool,
  sessionId: string,
  sessionUserId: string,
): Promise<SessionWorkspaceMode | null> {
  const row = (
    await pool.query<{ workspace_mode: string }>(
      "SELECT workspace_mode FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, sessionUserId],
    )
  ).rows[0];
  if (!row) return null;
  const workspaceMode = parseSessionWorkspaceMode(row.workspace_mode);
  if (workspaceMode === null) throw new Error(`client_sessions.workspace_mode invalid for ${sessionId}`);
  return workspaceMode;
}

async function readClientSessionLiveFramesImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  afterRecordId = 0,
  limit = 200,
  options?: { seekTail?: boolean } & SessionSnapshotOptions,
) {
  return readDurableClientSessionLiveFrames(pool, sessionId, userId, afterRecordId, limit, {
    ...options,
    readSnapshot: (client) => {
      const uid = /^c:([1-9][0-9]*)$/.exec(userId)?.[1];
      return uid
        ? buildSessionSnapshot(client, uid, sessionId, { ...options, limit })
        : Promise.resolve(null);
    },
  });
}

async function bumpHistoryRevisionImpl(pool: Pool, id: string, userId: string): Promise<boolean> {
  const result = await pool.query(BUMP_HISTORY_REVISION_SQL, [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

async function upsertMasterSessionImpl(pool: Pool, input: MasterClientSessionInput): Promise<void> {
  await pool.query(INSERT_MASTER_CLIENT_SESSION_SQL, [
    input.sessionId, input.userId, input.agentId, input.title,
    input.createdAt, input.lastAt, input.originChannel,
  ]);
}

async function claimSessionImpl(pool: Pool, sessionId: string, userId: string): Promise<boolean> {
  const result = await pool.query(CLAIM_SESSION_SQL, [userId, sessionId]);
  return (result.rowCount ?? 0) > 0;
}

export function createPgSessionClaimAndMetaStore(ctx: PgSessionsCtx) {
  const { pool, options, deps } = ctx;
  return {
    upsertClientSession: (session: ClientSession, baseSyncedAt = 0) =>
      upsertClientSessionImpl(pool, deps, session, baseSyncedAt),
    appendServerAuthoredMessage: (sessId: string, userId: string, message: ServerAuthoredMessageInput) =>
      appendServerAuthoredMessageImpl(pool, deps, sessId, userId, message),
    patchServerAuthoredMessage: (sessId: string, userId: string, msgId: string, patch: Record<string, unknown>) =>
      withTx(pool, (client) => runPatchServerAuthoredMessageTx(client, sessId, userId, msgId, patch)),
    appendServerAuthoredMessageForRequest: (
      requestId: string, sessId: string, userId: string, message: MessageLike & { id: string },
    ) => withTx(pool, (client) => runAppendForRequestTx(client, requestId, sessId, userId, message, deps)),
    appendServerAuthoredMessageDrainByUser<T extends MessageLike & { id: string }>(
      sessId: string, userId: string, message: T, agentSessionId?: string | null,
    ): Promise<AppendForRequestResult> {
      return withTx(pool, (client) => runAppendDrainByUserTx(client, sessId, userId, message, agentSessionId, deps));
    },
    deleteClientSession: (id: string, userId?: string) => deleteClientSessionImpl(pool, options, id, userId),
    renameClientSession: (id: string, userId: string, title: string) => renameClientSessionImpl(pool, id, userId, title),
    setClientSessionModel: (id: string, userId: string, modelId: string) => setClientSessionModelImpl(pool, id, userId, modelId),
    patchClientSessionMeta: (id: string, userId: string, patch: ClientSessionMetaPatch) =>
      patchClientSessionMetaImpl(pool, id, userId, patch),
    bumpClientSessionHistoryRevision: (id: string, userId: string) => bumpHistoryRevisionImpl(pool, id, userId),
    listUnclaimedSessions: () => listUnclaimedSessionsImpl(pool),
    allMasterWsessRows: () => allMasterWsessRowsImpl(pool),
    upsertMasterClientSession: (input: MasterClientSessionInput) => upsertMasterSessionImpl(pool, input),
    softDeleteMasterSession: (sessionId: string, userId: string) => deleteClientSessionImpl(pool, options, sessionId, userId),
    claimSession: (sessionId: string, userId: string) => claimSessionImpl(pool, sessionId, userId),
    getClientSessionCollabParent: (sessionId: string, userId: string) => getClientSessionCollabParentImpl(pool, sessionId, userId),
    classifyClientSessions: (refs: readonly ClientSessionLifecycleRef[]) => classifyClientSessionsImpl(pool, refs),
    verifyClientSessionOwnership: (id: string, expectedUserId: string) => verifyClientSessionOwnershipImpl(pool, id, expectedUserId),
    getClientSessionWorkspaceMode: (sessionId: string, sessionUserId: string) =>
      getClientSessionWorkspaceModeImpl(pool, sessionId, sessionUserId),
    readClientSessionLiveFrames: (
      sessionId: string, userId: string, afterRecordId = 0, limit = 200,
      liveOptions?: { seekTail?: boolean } & SessionSnapshotOptions,
    ) => readClientSessionLiveFramesImpl(pool, sessionId, userId, afterRecordId, limit, liveOptions),
    readClientSessionLiveUnits: (sessionId: string, userId: string, liveOptions?: LiveUnitsOptions) =>
      readDurableClientSessionLiveUnits(pool, sessionId, userId, liveOptions),
    readLiveOrTapeFramePayload: (
      sessionId: string, userId: string, ref: { recordId?: string | null; sha256?: string | null },
    ) => readDurableLiveOrTapeFramePayload(pool, sessionId, userId, ref),
    convergeFinalizedTapeLiveStreams: () => convergeDurableFinalizedTapeLiveStreams(pool),
  };
}
