import type { Pool, PoolClient } from "pg";
import type {
  ClientSession,
  ClientSessionPartial,
  ClientSessionReadOptions,
  ClientSessionsBackend,
  MessageLike,
  ReadArchivedMessagesResult,
  UploadReferenceRow,
} from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { readAutomaticRecoveriesForSession } from "./pgAutoRecoveryStore.js";
import {
  readOpenDispatchForSession,
  readPermissionPromptsForSession,
} from "./pgDispatchAdmissionStore.js";
import {
  hydrateTurnTapeMessages,
  mergeVerifiedTurnStatusRows,
} from "./pgTapeHydrateReader.js";
import { readUserMessagePayloadImpl } from "./pgTapeRecordReader.js";
import { readClientTimelinePageImpl } from "./pgTimelinePageReader.js";
import { bigIntNum, bigIntNumOr, withTimelineSnapshot } from "./sqlHelpers.js";

type SessionDetailRow = {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  pinned: number;
  created_at: string;
  last_at: string;
  messages: string;
  updated_at: string;
  archived_through_seq: number | null;
  archived_count: string;
  history_revision: string;
  timeline_generation: string;
  model_id: string | null;
};

const SESSION_DETAIL_WITH_USER_SQL = `SELECT cs.id, cs.user_id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at,
       cs.messages, cs.updated_at, cs.archived_through_seq, cs.history_revision,
       cs.timeline_generation, cs.model_id,
       COALESCE((
         SELECT SUM(ac.message_count) FROM client_session_archive_chunks ac
          WHERE ac.session_id=cs.id AND ac.user_id=cs.user_id
       ), 0)::text AS archived_count
  FROM client_sessions cs
 WHERE cs.id=$1 AND cs.user_id=$2 AND cs.deleted_at IS NULL`;

const SESSION_DETAIL_ANY_USER_SQL = `SELECT cs.id, cs.user_id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at,
       cs.messages, cs.updated_at, cs.archived_through_seq, cs.history_revision,
       cs.timeline_generation, cs.model_id,
       COALESCE((
         SELECT SUM(ac.message_count) FROM client_session_archive_chunks ac
          WHERE ac.session_id=cs.id AND ac.user_id=cs.user_id
       ), 0)::text AS archived_count
  FROM client_sessions cs
 WHERE cs.id=$1 AND cs.deleted_at IS NULL`;

const DECLARE_UPLOAD_REFERENCE_CURSOR_SQL = `DECLARE upload_reference_rows NO SCROLL CURSOR FOR
  SELECT id AS "sessionId", user_id AS "userId",
         CASE WHEN octet_length(messages::text) < $3 THEN messages::text ELSE NULL END AS messages
    FROM client_sessions WHERE last_at >= $1 AND deleted_at IS NULL AND ($2::text IS NULL OR user_id = $2)
  UNION ALL
  SELECT s.id AS "sessionId", s.user_id AS "userId",
         CASE WHEN octet_length(c.messages::text) < $3 THEN c.messages::text ELSE NULL END AS messages
    FROM client_session_archive_chunks c JOIN client_sessions s ON s.id = c.session_id AND s.user_id = c.user_id
   WHERE s.last_at >= $1 AND s.deleted_at IS NULL AND ($2::text IS NULL OR s.user_id = $2)`;

const READ_UPLOAD_TAPE_BYTES_SQL = `SELECT SUM(octet_length(r.payload))::text AS bytes, COUNT(*)::text AS records
  FROM client_session_turn_tapes t JOIN client_session_turn_tape_records r
    ON r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
 WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])
   AND t.materialization_status='complete' AND t.finalized_at IS NOT NULL
   AND t.record_payload_bytes>0 AND t.physical_record_count>0 AND t.logical_record_count>0
 GROUP BY t.tape_id,t.record_payload_bytes,t.physical_record_count
HAVING SUM(octet_length(r.payload))=t.record_payload_bytes AND COUNT(*)=t.physical_record_count`;

async function setStatementTimeoutForDeadline(client: PoolClient, deadline: number): Promise<void> {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("upload reference scan deadline");
  await client.query("SELECT set_config('statement_timeout', $1, true)", [`${ms}ms`]);
}

async function fetchNextUploadReferenceRow(client: PoolClient): Promise<UploadReferenceRow | undefined> {
  return (await client.query<UploadReferenceRow>("FETCH FORWARD 1 FROM upload_reference_rows")).rows[0];
}

async function* uploadReferenceRowBodies(
  client: PoolClient,
  opts: { sinceMs: number; userId?: string | null; maxBytes?: number },
  deadline: number,
  budget: { remainingRows: number },
  deps: PgSessionsDeps,
): AsyncGenerator<UploadReferenceRow> {
  await setStatementTimeoutForDeadline(client, deadline);
  const maxBytes = Math.min(
    opts.maxBytes ?? deps.storage.UPLOAD_REFERENCE_MAX_BYTES,
    deps.storage.UPLOAD_REFERENCE_MAX_BYTES,
  );
  await client.query(DECLARE_UPLOAD_REFERENCE_CURSOR_SQL, [opts.sinceMs, opts.userId ?? null, maxBytes]);
  for (;;) {
    await setStatementTimeoutForDeadline(client, deadline);
    const row = await fetchNextUploadReferenceRow(client);
    if (!row) return;
    if (--budget.remainingRows < 0) throw new Error("upload reference row budget");
    yield row;
  }
}

async function readUploadTapeBytesWithBudget(
  client: PoolClient,
  row: UploadReferenceRow,
  ids: string[],
  budget: { remainingRows: number },
): Promise<number[]> {
  const rows = (
    await client.query<{ bytes: string; records: string }>(READ_UPLOAD_TAPE_BYTES_SQL, [
      row.sessionId,
      row.userId,
      ids,
    ])
  ).rows;
  if (rows.length !== ids.length) throw new Error("upload reference tape metadata missing");
  for (const item of rows) {
    const count = Number(item.records);
    if (!Number.isSafeInteger(count) || count <= 0 || (budget.remainingRows -= count) < 0) {
      throw new Error("upload reference tape row budget");
    }
  }
  return rows.map((r) => Number(r.bytes));
}

async function scanRecentClientSessionMessagesImpl(
  ctx: PgSessionsCtx,
  opts: Parameters<ClientSessionsBackend["scanRecentClientSessionMessages"]>[0],
  visit: Parameters<ClientSessionsBackend["scanRecentClientSessionMessages"]>[1],
): Promise<boolean> {
  const { pool, deps } = ctx;
  try {
    return await withTimelineSnapshot(pool, async (client) => {
      const budget = {
        remainingRows: Math.min(
          opts.maxRows ?? deps.storage.UPLOAD_REFERENCE_MAX_ROWS,
          deps.storage.UPLOAD_REFERENCE_MAX_ROWS,
        ),
      };
      const deadline = Date.now() + Math.min(
        opts.maxMs ?? deps.storage.UPLOAD_REFERENCE_MAX_MS,
        deps.storage.UPLOAD_REFERENCE_MAX_MS,
      );
      const bodies = uploadReferenceRowBodies(client, opts, deadline, budget, deps);
      return deps.storage.scanUploadReferenceRows(bodies, visit, opts, async (row, messages, bytes) => {
        await setStatementTimeoutForDeadline(client, deadline);
        return deps.storage.hydrateUploadReferenceMessages(messages, bytes, {
          tapeBytes: (ids) => readUploadTapeBytesWithBudget(client, row, ids, budget),
          tapes: async (raw, maxTapeBytes) => {
            await setStatementTimeoutForDeadline(client, deadline);
            return hydrateTurnTapeMessages(client, row.sessionId, row.userId, raw, {
              view: "exact",
              uploadReferenceMaxBytes: maxTapeBytes,
            });
          },
          user: async (id, maxUserBytes) => {
            await setStatementTimeoutForDeadline(client, deadline);
            return readUserMessagePayloadImpl(client, row.sessionId, row.userId, id, 0, maxUserBytes);
          },
        });
      });
    });
  } catch (err) {
    void err;
    return false;
  }
}

async function loadSessionOverlayMetadata(
  queryable: Pool | PoolClient,
  snapshotClient: PoolClient | undefined,
  row: Pick<SessionDetailRow, "id" | "user_id">,
  options: ClientSessionReadOptions,
  deps: PgSessionsDeps,
) {
  const [automaticRecoveries, openDispatch, permissionPrompts] = await Promise.all([
    snapshotClient ? readAutomaticRecoveriesForSession(snapshotClient, row.id, row.user_id) : Promise.resolve({}),
    readOpenDispatchForSession(queryable, row.id, row.user_id),
    readPermissionPromptsForSession(queryable, row.id, row.user_id, deps, options.permissionLookupIds),
  ]);
  return { automaticRecoveries, openDispatch, permissionPrompts };
}

async function readClientSessionRow(
  ctx: PgSessionsCtx,
  queryable: Pool | PoolClient,
  snapshotClient: PoolClient | undefined,
  id: string,
  userId: string | undefined,
  options: ClientSessionReadOptions,
): Promise<ClientSession | null> {
  const { pool, deps } = ctx;
  const sql = userId ? SESSION_DETAIL_WITH_USER_SQL : SESSION_DETAIL_ANY_USER_SQL;
  const row = (await queryable.query<SessionDetailRow>(sql, userId ? [id, userId] : [id])).rows[0];
  if (!row) return null;
  const archivedThroughOrderSeq = bigIntNumOr(row.archived_through_seq, 0);
  const timelinePage = options.view === "timeline"
    ? await readClientTimelinePageImpl(pool, row.id, row.user_id, null, 100, deps, snapshotClient, row)
    : null;
  const messages = timelinePage
    ? timelinePage.messages
    : await hydrateTurnTapeMessages(
        pool,
        row.id,
        row.user_id,
        deps.storage.deriveOrderSeqsForRead(JSON.parse(row.messages) as MessageLike[], archivedThroughOrderSeq),
        options,
      );
  const overlay = await loadSessionOverlayMetadata(queryable, snapshotClient, row, options, deps);
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: bigIntNum(row.created_at, "created_at"),
    lastAt: bigIntNum(row.last_at, "last_at"),
    messages,
    updatedAt: bigIntNum(row.updated_at, "updated_at"),
    historyRevision: timelinePage?.historyRevision ?? bigIntNum(row.history_revision, "history_revision"),
    timelineGeneration: timelinePage?.timelineGeneration ?? bigIntNum(row.timeline_generation, "timeline_generation"),
    ...(timelinePage
      ? {
          timelineCursor: timelinePage.nextCursor,
          timelineHasMore: timelinePage.hasMore,
          timelineSnapshotMaxSeq: timelinePage.snapshotMaxSeq,
        }
      : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    archivedCount: bigIntNum(row.archived_count, "archived chunk message count"),
    archivedThroughSeq: archivedThroughOrderSeq,
    ...overlay.automaticRecoveries,
    ...overlay.openDispatch,
    ...overlay.permissionPrompts,
  };
}

function parseSessionMessagesSafe(raw: string): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
  } catch (err) {
    void err;
    return [];
  }
}

async function buildTimelinePartialSession(
  ctx: PgSessionsCtx,
  queryable: Pool | PoolClient,
  snapshotClient: PoolClient | undefined,
  row: SessionDetailRow,
  archivedCount: number,
  archivedThroughSeq: number,
  options: ClientSessionReadOptions,
): Promise<ClientSessionPartial | null> {
  const { pool, deps } = ctx;
  const page = await readClientTimelinePageImpl(pool, row.id, row.user_id, null, 100, deps, snapshotClient, row);
  if (!page) return null;
  const overlay = await loadSessionOverlayMetadata(queryable, snapshotClient, row, options, deps);
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: bigIntNum(row.created_at, "created_at"),
    lastAt: bigIntNum(row.last_at, "last_at"),
    messages: page.messages,
    updatedAt: bigIntNum(row.updated_at, "updated_at"),
    historyRevision: page.historyRevision,
    timelineGeneration: page.timelineGeneration,
    timelineCursor: page.nextCursor,
    timelineHasMore: page.hasMore,
    timelineSnapshotMaxSeq: page.snapshotMaxSeq,
    ...overlay.automaticRecoveries,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    totalMessageCount: page.messages.length + archivedCount,
    maxSeq: page.snapshotMaxSeq,
    isPartial: false,
    archivedCount,
    archivedThroughSeq,
    ...overlay.openDispatch,
    ...overlay.permissionPrompts,
  };
}

async function readClientSessionPartialRow(
  ctx: PgSessionsCtx,
  queryable: Pool | PoolClient,
  snapshotClient: PoolClient | undefined,
  id: string,
  userId: string,
  sinceSeq: number,
  options: ClientSessionReadOptions,
): Promise<ClientSessionPartial | null> {
  const { pool, deps } = ctx;
  const row = (await queryable.query<SessionDetailRow>(SESSION_DETAIL_WITH_USER_SQL, [id, userId])).rows[0];
  if (!row) return null;
  const archivedCount = bigIntNum(row.archived_count, "archived chunk message count");
  const archivedThroughSeq = bigIntNumOr(row.archived_through_seq, 0);
  if (options.view === "timeline") {
    return buildTimelinePartialSession(ctx, queryable, snapshotClient, row, archivedCount, archivedThroughSeq, options);
  }
  const allMsgs = deps.storage.deriveOrderSeqsForRead(parseSessionMessagesSafe(row.messages), archivedThroughSeq);
  const anyMissingSeq = allMsgs.some((m) => !m || typeof m._seq !== "number" || !Number.isFinite(m._seq));
  let maxSeq = 0;
  for (const m of allMsgs) {
    const s = typeof m?._seq === "number" ? m._seq : 0;
    if (s > maxSeq) maxSeq = s;
  }
  const historyRevision = bigIntNum(row.history_revision, "history_revision");
  const canSlice = !anyMissingSeq && Number.isFinite(sinceSeq) && sinceSeq > 0 &&
    Number.isSafeInteger(options.sinceHistoryRevision) && options.sinceHistoryRevision === historyRevision;
  const rawMessages = canSlice
    ? allMsgs.filter((m) => typeof m?._seq === "number" && m._seq > sinceSeq)
    : allMsgs;
  const messages = await hydrateTurnTapeMessages(pool, row.id, row.user_id, rawMessages, options);
  const [openDispatch, permissionPrompts] = await Promise.all([
    readOpenDispatchForSession(queryable, row.id, row.user_id),
    readPermissionPromptsForSession(queryable, row.id, row.user_id, deps, options.permissionLookupIds),
  ]);
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: bigIntNum(row.created_at, "created_at"),
    lastAt: bigIntNum(row.last_at, "last_at"),
    messages,
    updatedAt: bigIntNum(row.updated_at, "updated_at"),
    historyRevision,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    totalMessageCount: allMsgs.length + archivedCount,
    maxSeq,
    isPartial: canSlice,
    archivedCount,
    archivedThroughSeq,
    ...openDispatch,
    ...permissionPrompts,
  };
}

async function fetchArchiveChunkBatch(
  pool: Pool,
  sessId: string,
  userId: string,
  effectiveBefore: number,
  beforeLastSeq: number | null,
): Promise<Array<{ messages: string; last_seq: string }>> {
  return (
    await pool.query<{ messages: string; last_seq: string }>(
      `SELECT messages, last_seq FROM client_session_archive_chunks
        WHERE session_id = $1 AND user_id = $2 AND first_seq < $3::bigint
          AND ($4::bigint IS NULL OR last_seq < $4)
        ORDER BY last_seq DESC
        LIMIT 4`,
      [sessId, userId, effectiveBefore, beforeLastSeq],
    )
  ).rows;
}

function appendArchivedChunkMessages(
  chunks: Array<{ messages: string; last_seq: string }>,
  effectiveBefore: number,
  cappedLimit: number,
  messagePool: MessageLike[],
  deps: PgSessionsDeps,
): number | null {
  let lastSeq: number | null = null;
  for (const cr of chunks) {
    lastSeq = bigIntNum(cr.last_seq, "archive last_seq");
    const arr = parseSessionMessagesSafe(cr.messages);
    for (const m of deps.storage.deriveArchivedOrderSeqsForRead(arr)) {
      const s = typeof m?._orderSeq === "number" ? m._orderSeq : -1;
      if (s >= 0 && s < effectiveBefore) messagePool.push(m);
    }
    if (messagePool.length > cappedLimit) break;
  }
  return lastSeq;
}

async function readArchivedMessagesImpl(
  ctx: PgSessionsCtx,
  sessId: string,
  userId: string,
  beforeSeq: number,
  limit: number,
  options: ClientSessionReadOptions,
): Promise<ReadArchivedMessagesResult> {
  const { pool, deps } = ctx;
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)));
  const row = (
    await pool.query<{ archived_through_seq: number | null; history_revision: string }>(
      "SELECT archived_through_seq, history_revision FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [sessId, userId],
    )
  ).rows[0];
  if (!row) return { messages: [], hasMore: false, oldestSeq: null };
  const watermark = bigIntNumOr(row.archived_through_seq, 0);
  const historyRevision = bigIntNum(row.history_revision, "history_revision");
  const effectiveBefore = Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : watermark + 1;
  if (effectiveBefore <= 1) return { messages: [], hasMore: false, oldestSeq: null, historyRevision };

  const messagePool: MessageLike[] = [];
  let beforeLastSeq: number | null = null;
  for (;;) {
    const chunkRows = await fetchArchiveChunkBatch(pool, sessId, userId, effectiveBefore, beforeLastSeq);
    if (chunkRows.length === 0) break;
    beforeLastSeq = appendArchivedChunkMessages(chunkRows, effectiveBefore, cappedLimit, messagePool, deps);
    if (messagePool.length > cappedLimit || chunkRows.length < 4) break;
  }
  messagePool.sort(deps.storage.compareMessagesByOrder);
  const hasMore = messagePool.length > cappedLimit;
  const page = messagePool.slice(Math.max(0, messagePool.length - cappedLimit));
  const oldestSeq = page.length > 0 && typeof page[0]!._orderSeq === "number" ? page[0]!._orderSeq : null;
  let hydrated = await hydrateTurnTapeMessages(pool, sessId, userId, page, options);
  if (options.view === "timeline" && page.length > 0 && oldestSeq !== null) {
    hydrated = await mergeVerifiedTurnStatusRows(pool, userId, sessId, hydrated, {
      minInclusive: oldestSeq,
      maxExclusive: effectiveBefore,
    });
  }
  return { messages: hydrated, hasMore, oldestSeq, historyRevision };
}

export function createPgSessionReadAndArchiveStore(
  ctx: PgSessionsCtx,
): Pick<
  ClientSessionsBackend,
  | "scanRecentClientSessionMessages"
  | "getClientSession"
  | "getClientSessionPartial"
  | "readArchivedMessages"
> {
  return {
    scanRecentClientSessionMessages(opts, visit) {
      return scanRecentClientSessionMessagesImpl(ctx, opts, visit);
    },
    getClientSession(id, userId, options = {}) {
      return options.view === "timeline"
        ? withTimelineSnapshot(ctx.pool, (client) => readClientSessionRow(ctx, client, client, id, userId, options))
        : readClientSessionRow(ctx, ctx.pool, undefined, id, userId, options);
    },
    getClientSessionPartial(id, userId, sinceSeq, options = {}) {
      return options.view === "timeline"
        ? withTimelineSnapshot(ctx.pool, (client) =>
            readClientSessionPartialRow(ctx, client, client, id, userId, sinceSeq, options))
        : readClientSessionPartialRow(ctx, ctx.pool, undefined, id, userId, sinceSeq, options);
    },
    readArchivedMessages(sessId, userId, beforeSeq = 0, limit = 100, options = {}) {
      return readArchivedMessagesImpl(ctx, sessId, userId, beforeSeq, limit, options);
    },
  };
}
