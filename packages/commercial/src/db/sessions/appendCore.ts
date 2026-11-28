import type { PoolClient } from "pg";
import {
  estimateModelHistoryTokens,
  getUserError,
  modelHistorySemanticText,
  parseSessionWorkspaceMode,
} from "@openclaude/protocol";
import type {
  MessageLike,
  ServerAuthoredAppendResult,
  SpillChunkPlan,
} from "@openclaude/storage";
import { computeSessionLastPreviewRaw } from "../pgTimelinePerf.js";
import type { PgSessionsDeps } from "./deps.js";
import {
  CLOCK_MS_SQL,
  USER_MESSAGE_INLINE_BYTES,
  bigIntNum,
  bigIntNumOr,
  escapeNulInSessionMessagesJson,
  hydrateRecoverySourceUser,
  pgModelSidecarText,
  seqOfMessage,
  sha256Bytes,
  stripWorkspaceMode,
} from "./sqlHelpers.js";
import type { PgAppendCoreResult, SessionWriteRow } from "./types.js";

// ── Spill execution (PG dialect) ─────────────────────────────────────────────

export async function execPgSpillPlan(
  client: PoolClient,
  sessId: string,
  userId: string,
  chunksToInsert: SpillChunkPlan[],
  idsToInsert: string[],
  now: number,
): Promise<number> {
  if (chunksToInsert.length === 0) return 0;
  const chunkRes = await client.query<{ message_count: number }>(
    `INSERT INTO client_session_archive_chunks
       (session_id, user_id, first_seq, last_seq, message_count, messages, created_at)
     SELECT $1, $2, t.first_seq, t.last_seq, t.message_count, t.messages, $3
       FROM unnest($4::int[], $5::int[], $6::int[], $7::text[])
         AS t(first_seq, last_seq, message_count, messages)
     ON CONFLICT (session_id, first_seq) DO NOTHING
     RETURNING message_count`,
    [
      sessId,
      userId,
      now,
      chunksToInsert.map((c) => c.firstSeq),
      chunksToInsert.map((c) => c.lastSeq),
      chunksToInsert.map((c) => c.messageCount),
      chunksToInsert.map((c) => JSON.stringify(c.messages)),
    ],
  );
  let archivedDelta = 0;
  for (const row of chunkRes.rows) archivedDelta += Number(row.message_count);
  if (idsToInsert.length > 0) {
    await client.query(
      `INSERT INTO client_session_archived_ids (session_id, msg_id)
       SELECT $1, t.msg_id FROM unnest($2::text[]) AS t(msg_id)
       ON CONFLICT (session_id, msg_id) DO NOTHING`,
      [sessId, idsToInsert],
    );
  }
  return archivedDelta;
}

/** PUT 防复活:从 incoming 里剔除 id 已归档的消息(参数化 ANY($2::text[]),纯读)。 */
export async function filterOutArchivedIncoming(
  client: PoolClient,
  sessId: string,
  msgs: MessageLike[],
): Promise<MessageLike[]> {
  const ids: string[] = [];
  for (const m of msgs) if (typeof m?.id === "string") ids.push(m.id);
  if (ids.length === 0) return msgs;

  const rows = await client.query<{ msg_id: string }>(
    `SELECT msg_id FROM client_session_archived_ids
      WHERE session_id = $1 AND msg_id = ANY($2::text[])`,
    [sessId, ids],
  );
  if (rows.rows.length === 0) return msgs;
  const archived = new Set(rows.rows.map((r) => r.msg_id));
  return msgs.filter((m) => !(typeof m?.id === "string" && archived.has(m.id)));
}

// ── Oversized user payload deferral ──────────────────────────────────────────

const DEFERRED_RECOVERY_LINEAGE_KEYS = [
  "_recoveryOfClientMessageId",
  "_recoveryMode",
  "_automaticRecovery",
  "_automaticRecoveryRootClientMessageId",
  "_automaticRecoveryAttempt",
  "_automaticRecoveryMax",
] as const;

function extractDeferredRouting(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as {
    model?: unknown;
    teamMode?: unknown;
    swarmMode?: unknown;
    effortLevel?: unknown;
  };
  const out: Record<string, unknown> = {};
  if (typeof src.model === "string") out.model = src.model;
  if (typeof src.teamMode === "boolean") out.teamMode = src.teamMode;
  if (typeof src.swarmMode === "boolean") out.swarmMode = src.swarmMode;
  if (typeof src.effortLevel === "string" || src.effortLevel === null) {
    out.effortLevel = src.effortLevel;
  }
  return out;
}

function isMediaRefDurable(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const ref = item as { url?: unknown; base64?: unknown };
  const hasUrl = typeof ref.url === "string" && ref.url.length > 0;
  const hasBase64 = typeof ref.base64 === "string" && ref.base64.length > 0;
  return hasUrl || hasBase64;
}

function isDeferredRetryEligible(
  routing: Record<string, unknown> | undefined,
  message: MessageLike,
): boolean {
  if (!routing) return false;
  const media = Array.isArray(message._media) ? message._media : undefined;
  const retryMedia = Array.isArray(message._retryMedia) ? message._retryMedia : undefined;
  const hadAttachments = (media?.length ?? 0) > 0 || (retryMedia?.length ?? 0) > 0;
  if (!hadAttachments) return true;
  const retrySource = retryMedia ?? media;
  return !!retrySource && retrySource.length > 0 && retrySource.every(isMediaRefDurable);
}

export function deferredUserReplayMetadata(message: MessageLike): MessageLike {
  const routing = extractDeferredRouting(message._routing);
  const meta: Record<string, unknown> = {
    _deferredRetryEligible: isDeferredRetryEligible(routing, message),
  };
  if (routing) meta._routing = routing;
  if (
    typeof message._sendAttempt === "number" &&
    Number.isSafeInteger(message._sendAttempt) &&
    message._sendAttempt >= 0
  ) {
    meta._sendAttempt = message._sendAttempt;
  }
  if (typeof message._isAutoRetry === "boolean") meta._isAutoRetry = message._isAutoRetry;
  if (typeof message._idem === "string" && message._idem.length <= 256) meta._idem = message._idem;
  for (const key of DEFERRED_RECOVERY_LINEAGE_KEYS) {
    if (message[key] !== undefined) meta[key] = message[key];
  }
  return meta as MessageLike;
}

export async function deferOversizedUserMessage(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<(MessageLike & { id: string }) | null> {
  if (message.role !== "user" || typeof message.text !== "string") return message;
  const exact = { ...message, _source: "server" };
  const payload = Buffer.from(JSON.stringify(exact), "utf8");
  if (payload.length <= USER_MESSAGE_INLINE_BYTES) return message;
  const modelText = pgModelSidecarText(modelHistorySemanticText(message));
  const contentSha256 = sha256Bytes(payload);
  const ts = typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : Date.now();
  const inserted = await client.query(
    `INSERT INTO client_session_user_payloads
       (session_id,user_id,msg_id,payload,text_payload,content_sha256,payload_bytes,
        model_token_estimate,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (session_id,user_id,msg_id) DO NOTHING
     RETURNING msg_id`,
    [
      sessionId,
      userId,
      message.id,
      payload,
      modelText,
      contentSha256,
      payload.length,
      estimateModelHistoryTokens(modelText),
      ts,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    const existing = (
      await client.query<{ content_sha256: string; payload_bytes: string }>(
        `SELECT content_sha256,payload_bytes::text AS payload_bytes
           FROM client_session_user_payloads
          WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
        [sessionId, userId, message.id],
      )
    ).rows[0];
    if (
      !existing ||
      existing.content_sha256 !== contentSha256 ||
      bigIntNum(existing.payload_bytes, "user payload bytes") !== payload.length
    ) return null;
  }
  return {
    id: message.id,
    role: "user",
    text: "",
    ts,
    _source: "server",
    _payloadDeferred: true,
    _userPayloadDeferred: true,
    _userPayloadId: message.id,
    _payloadBytes: payload.length,
    _payloadSha256: contentSha256,
    ...deferredUserReplayMetadata(message),
  };
}

// ── Admission restart snapshot & core server-authored append ─────────────────

export async function attachAdmissionRestartSnapshot(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<void> {
  const row = (await client.query<{ messages: string }>(
    "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE",
    [sessionId, userId],
  )).rows[0];
  const messages = JSON.parse(row.messages) as MessageLike[];
  const index = messages.findIndex((item) => item?.id === message.id && item.role === "user");
  if (index < 0) throw new Error("admission snapshot source missing");
  const hot = messages[index]!;
  const source = await hydrateRecoverySourceUser(client, sessionId, userId, hot);
  if (!source) throw new Error("admission snapshot source payload missing");
  if (source._admissionRestartRequest !== undefined) return;
  const exact = { ...source, _source: "server", _admissionRestartRequest: message._admissionRestartRequest };
  if (hot._userPayloadDeferred === true) {
    const payload = Buffer.from(JSON.stringify(exact));
    const digest = sha256Bytes(payload);
    await client.query(
      `UPDATE client_session_user_payloads SET payload=$4,content_sha256=$5,payload_bytes=$6
        WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
      [sessionId, userId, message.id, payload, digest, payload.length],
    );
    messages[index] = { ...hot, _source: "server", _payloadSha256: digest, _payloadBytes: payload.length };
  } else {
    const deferred = await deferOversizedUserMessage(client, sessionId, userId, exact as MessageLike & { id: string });
    if (!deferred) throw new Error("admission snapshot payload conflict");
    messages[index] = { ...deferred, _seq: hot._seq, _orderSeq: hot._orderSeq };
  }
  await client.query(
    "UPDATE client_sessions SET messages=$3, last_preview=$4 WHERE id=$1 AND user_id=$2",
    [sessionId, userId, escapeNulInSessionMessagesJson(JSON.stringify(messages)), computeSessionLastPreviewRaw(messages)],
  );
}

const UPDATE_APPENDED_SESSION_SQL = `UPDATE client_sessions
   SET messages = $1, message_count = $2, last_at = $3,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       next_seq = $4, archived_through_seq = $5, archived_count = $6,
       history_revision = history_revision + $9,
       last_preview = $10
 WHERE id = $7 AND user_id = $8 AND deleted_at IS NULL`;

function parseHotMessagesArray(raw: string): MessageLike[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : null;
  } catch (err) {
    void err;
    return null;
  }
}

export async function pgAppendServerAuthoredCore(
  client: PoolClient,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
  deps: PgSessionsDeps,
): Promise<PgAppendCoreResult> {
  const row = (
    await client.query<SessionWriteRow>(
      "SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count, workspace_mode FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [sessId, userId],
    )
  ).rows[0];
  if (!row) return { applied: false, reason: "session_not_found" };
  if (row.deleted_at !== null) return { applied: false, reason: "session_deleted" };
  const workspaceMode = parseSessionWorkspaceMode(row.workspace_mode);
  if (workspaceMode === null) {
    throw new Error(`client_sessions.workspace_mode invalid for ${sessId}`);
  }
  const archivedHit = await client.query(
    "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
    [sessId, message.id],
  );
  if ((archivedHit.rowCount ?? 0) > 0) {
    return { applied: false, reason: "already_exists", workspaceMode };
  }
  const msgs = parseHotMessagesArray(row.messages);
  if (!msgs) return { applied: false, reason: "malformed" };

  const hotExisting = msgs.some((item) => item && item.id === message.id);
  const plannedMessage = hotExisting
    ? message
    : await deferOversizedUserMessage(client, sessId, userId, message);
  if (plannedMessage === null) return { applied: false, reason: "malformed" };

  const currentNextSeq = typeof row.next_seq === "number" && row.next_seq > 0 ? row.next_seq : 1;
  const plan = deps.storage.planAppendServerAuthored(
    msgs,
    plannedMessage,
    currentNextSeq,
    bigIntNumOr(row.archived_through_seq, 0),
  );
  if (plan.kind === "already_exists") {
    return { applied: false, reason: "already_exists", seq: seqOfMessage(msgs, message.id), workspaceMode };
  }
  if (plan.kind === "oversized") return { applied: false, reason: "oversized" };

  const now = Date.now();
  const archivedDelta = await execPgSpillPlan(client, sessId, userId, plan.chunksToInsert, plan.idsToInsert, now);
  const newArchivedCount = bigIntNumOr(row.archived_count, 0) + archivedDelta;
  const tail = plan.tail;
  const historyRevisionDelta = deps.storage.hasInvisibleMessageRemoval(msgs, tail) || archivedDelta > 0 ? 1 : 0;

  const upd = await client.query(UPDATE_APPENDED_SESSION_SQL, [
    escapeNulInSessionMessagesJson(plan.finalJson),
    tail.length + newArchivedCount,
    now,
    plan.nextSeq,
    plan.archivedThroughSeq,
    newArchivedCount,
    sessId,
    userId,
    historyRevisionDelta,
    computeSessionLastPreviewRaw(tail),
  ]);
  if (upd.rowCount !== 1) return { applied: false, reason: "session_deleted" };
  return { applied: true, seq: seqOfMessage(tail, message.id), workspaceMode };
}

export async function appendPromptQueueUserMessageInTransaction(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string; role: "user" },
  deps: PgSessionsDeps,
): Promise<ServerAuthoredAppendResult> {
  return stripWorkspaceMode(await pgAppendServerAuthoredCore(client, sessionId, userId, message, deps)) as ServerAuthoredAppendResult;
}

export async function appendRecoveryGiveUpTerminalCard(
  client: PoolClient,
  input: {
    sessionId: string;
    sessionUserId: string;
    rootClientMessageId: string;
    reason: "silent_no_progress" | "retry_exhausted" | "recovery_refused";
  },
  deps: PgSessionsDeps,
): Promise<boolean> {
  const text = input.reason === "silent_no_progress"
    ? "自动恢复已停止：连续多次从断点恢复都没有取得进展，为避免重复执行已暂停。请直接再发一条消息继续，或新开一个会话。"
    : input.reason === "recovery_refused"
      ? "自动恢复已停止：从断点继续的那一轮没能开始执行（这一轮续接未计费）。请直接再发一条消息继续，或新开一个会话。"
      : "自动恢复已停止：已达到自动恢复次数上限。请直接再发一条消息继续，或新开一个会话。";
  const appended = await pgAppendServerAuthoredCore(client, input.sessionId, input.sessionUserId, {
    id: `m-recovery-giveup-${input.rootClientMessageId}`,
    role: "assistant",
    text,
    _userError: getUserError(
      input.reason === "retry_exhausted"
        ? "automatic_retry_exhausted"
        : input.reason === "recovery_refused"
          ? "automatic_retry_refused"
          : "automatic_retry_paused",
    ),
    ts: Date.now(),
    status: "completed",
    _source: "server",
    _clientMessageId: input.rootClientMessageId,
  }, deps);
  return appended.applied;
}
