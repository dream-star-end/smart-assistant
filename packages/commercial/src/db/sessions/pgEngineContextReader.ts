import type { Pool } from "pg";
import { resolveModelHistoryContextWindow } from "@openclaude/protocol";
import type {
  ClientSessionsBackend,
  EngineContextReadOptions,
  MessageLike,
} from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { computeFiniteEngineContextMessages } from "./pgFiniteModelContextReader.js";
import { hydrateTurnTapeMessages } from "./pgTapeHydrateReader.js";
import { bigIntNum, bigIntNumOr } from "./sqlHelpers.js";

const READ_ARCHIVE_CHUNK_PAGE_SQL = `SELECT messages, last_seq FROM client_session_archive_chunks
  WHERE session_id=$1 AND user_id=$2
    AND ($3::bigint IS NULL OR last_seq < $3)
  ORDER BY last_seq DESC
  LIMIT $4`;

async function fetchArchiveChunkPage(
  pool: Pool,
  sessionId: string,
  userId: string,
  beforeLastSeq: number | null,
  limit: number,
): Promise<Array<{ messages: string; last_seq: string }>> {
  return (
    await pool.query<{ messages: string; last_seq: string }>(READ_ARCHIVE_CHUNK_PAGE_SQL, [
      sessionId,
      userId,
      beforeLastSeq,
      limit,
    ])
  ).rows;
}

function parseHotSessionMessages(
  raw: string,
  archivedThroughSeq: number,
  deps: PgSessionsDeps,
): MessageLike[] {
  let hot: MessageLike[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      hot = deps.storage.deriveOrderSeqsForRead(parsed as MessageLike[], archivedThroughSeq);
    }
  } catch (err) {
    // A malformed hot legacy row contributes no synthetic context. Valid
    // archives remain independently readable below.
    void err;
  }
  hot.sort(deps.storage.compareMessagesByOrder);
  return hot;
}

function parseArchivedContextChunk(raw: string, deps: PgSessionsDeps): MessageLike[] {
  let archived: MessageLike[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      archived = deps.storage.deriveArchivedOrderSeqsForRead(parsed as MessageLike[]);
    }
  } catch (err) {
    // Match the existing archive contract: skip only the malformed chunk.
    void err;
  }
  archived.sort(deps.storage.compareMessagesByOrder);
  return archived;
}

async function hydratePrivateContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
): Promise<MessageLike[]> {
  const tapeHydrated = await hydrateTurnTapeMessages(pool, sessionId, userId, messages, {
    view: "timeline",
    deferTimelineNarrative: false,
    engineContext: true,
  });
  const deferredIds = tapeHydrated.flatMap((message) =>
    message._userPayloadDeferred === true && typeof message.id === "string"
      ? [message.id]
      : []);
  if (deferredIds.length === 0) return tapeHydrated;
  const payloads = (
    await pool.query<{ msg_id: string; text_payload: string }>(
      `SELECT msg_id,text_payload
         FROM client_session_user_payloads
        WHERE session_id=$1 AND user_id=$2 AND msg_id=ANY($3::text[])`,
      [sessionId, userId, deferredIds],
    )
  ).rows;
  const byId = new Map(payloads.map((row) => [row.msg_id, row.text_payload]));
  return tapeHydrated.map((message) => {
    if (message._userPayloadDeferred !== true || typeof message.id !== "string") return message;
    const text = byId.get(message.id);
    if (text === undefined) {
      throw new Error(`[pgSessions] deferred user payload missing: ${sessionId}\0${message.id}`);
    }
    return {
      id: message.id,
      role: "user",
      text,
      ts: message.ts,
      _source: "server",
      ...(typeof message._clientMessageId === "string"
        ? { _clientMessageId: message._clientMessageId }
        : {}),
      ...(typeof message._seq === "number" ? { _seq: message._seq } : {}),
      ...(typeof message._orderSeq === "number" ? { _orderSeq: message._orderSeq } : {}),
    };
  });
}

async function walkArchiveForUnboundedContext(
  pool: Pool,
  sessionId: string,
  userId: string,
  initialMessages: MessageLike[],
  options: EngineContextReadOptions,
  deps: PgSessionsDeps,
): Promise<MessageLike[]> {
  // Walk archive chunks newest-to-oldest in small SQL pages. As soon as the
  // selected model's actual context window is full, older chunks are never
  // parsed or hydrated and never cross the master->container wire.
  let selectedMessages = initialMessages;
  let beforeLastSeq: number | null = null;
  for (;;) {
    const archiveRows = await fetchArchiveChunkPage(pool, sessionId, userId, beforeLastSeq, 4);
    if (archiveRows.length === 0) break;
    for (const archive of archiveRows) {
      beforeLastSeq = bigIntNum(archive.last_seq, "archive last_seq");
      const archived = parseArchivedContextChunk(archive.messages, deps);
      const hydrated = await hydratePrivateContextMessages(pool, sessionId, userId, archived);
      const combined = [...hydrated, ...selectedMessages];
      combined.sort(deps.storage.compareMessagesByOrder);
      const next = deps.storage.selectEngineContextSuffix(combined, options);
      selectedMessages = next.messages;
      if (next.truncated) return selectedMessages;
    }
    if (archiveRows.length < 4) break;
  }
  return selectedMessages;
}

export async function computeEngineContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  options: EngineContextReadOptions,
  deps: PgSessionsDeps,
): Promise<MessageLike[] | null> {
  const row = (
    await pool.query<{ messages: string; archived_through_seq: number | null }>(
      "SELECT messages, archived_through_seq FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    )
  ).rows[0];
  if (!row) return null;
  const hot = parseHotSessionMessages(row.messages, bigIntNumOr(row.archived_through_seq, 0), deps);
  const contextWindow = resolveModelHistoryContextWindow(options.contextWindow, options.engine);
  if (contextWindow !== null) {
    return computeFiniteEngineContextMessages(
      pool,
      sessionId,
      userId,
      hot,
      options,
      deps,
      contextWindow,
    );
  }
  const hydratedHot = await hydratePrivateContextMessages(pool, sessionId, userId, hot);
  const selected = deps.storage.selectEngineContextSuffix(hydratedHot, options);
  if (selected.truncated) return selected.messages;
  return walkArchiveForUnboundedContext(pool, sessionId, userId, selected.messages, options, deps);
}

// ── Completed client turn lookup ─────────────────────────────────────────────

function containsCompletedClientTurn(messages: MessageLike[], clientMessageId: string): boolean {
  return messages.some((message) =>
    message?.role === "assistant" &&
    message._clientMessageId === clientMessageId &&
    message.status === "completed" &&
    message._errorCode === undefined &&
    message._isError !== true);
}

function inspectHotForCompletedClientTurn(
  raw: string,
  clientMessageId: string,
): { completed: boolean; hotContainsClientMessage: boolean } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hot = parsed as MessageLike[];
      if (containsCompletedClientTurn(hot, clientMessageId)) {
        return { completed: true, hotContainsClientMessage: true };
      }
      const hotContainsClientMessage = hot.some((message) =>
        message?.id === clientMessageId || message?._clientMessageId === clientMessageId);
      return { completed: false, hotContainsClientMessage };
    }
  } catch (err) {
    void err;
  }
  return { completed: false, hotContainsClientMessage: false };
}

function chunkContainsCompletedClientTurn(raw: string, clientMessageId: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) &&
      containsCompletedClientTurn(parsed as MessageLike[], clientMessageId);
  } catch (err) {
    void err;
    return false;
  }
}

export async function hasCompletedClientTurnImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  clientMessageId: string,
): Promise<boolean> {
  const tape = (
    await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND client_message_id=$3
            AND status='completed' AND (visible_at IS NOT NULL OR finalized_at IS NOT NULL)
       ) AS present`,
      [sessionId, userId, clientMessageId],
    )
  ).rows[0];
  if (tape?.present === true) return true;

  // Compatibility for completed pre-tape rows. Keep this predicate in the DB
  // backend so a retry never transports the whole session through the bridge.
  const session = (
    await pool.query<{ messages: string }>(
      `SELECT messages FROM client_sessions
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [sessionId, userId],
    )
  ).rows[0];
  if (!session) return false;
  const hotCheck = inspectHotForCompletedClientTurn(session.messages, clientMessageId);
  if (hotCheck.completed) return true;
  // Archive spill is a frozen prefix. If this user/client id is still in the
  // hot suffix, a later completed assistant cannot be in an older chunk.
  if (hotCheck.hotContainsClientMessage) return false;

  const archivedId = (
    await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM client_session_archived_ids
          WHERE session_id=$1 AND msg_id=$2
       ) AS present`,
      [sessionId, clientMessageId],
    )
  ).rows[0];
  if (archivedId?.present !== true) return false;

  let beforeLastSeq: number | null = null;
  for (;;) {
    const chunks = await fetchArchiveChunkPage(pool, sessionId, userId, beforeLastSeq, 8);
    if (chunks.length === 0) return false;
    for (const chunk of chunks) {
      beforeLastSeq = bigIntNum(chunk.last_seq, "archive last_seq");
      if (chunkContainsCompletedClientTurn(chunk.messages, clientMessageId)) return true;
    }
    if (chunks.length < 8) return false;
  }
}

export function createPgEngineContextReader(
  ctx: PgSessionsCtx,
): Pick<ClientSessionsBackend, "getEngineContextMessages" | "hasCompletedClientTurn"> {
  return {
    getEngineContextMessages(sessionId, userId, options = {}) {
      return computeEngineContextMessages(ctx.pool, sessionId, userId, options, ctx.deps);
    },
    hasCompletedClientTurn(sessionId, userId, clientMessageId) {
      return hasCompletedClientTurnImpl(ctx.pool, sessionId, userId, clientMessageId);
    },
  };
}
