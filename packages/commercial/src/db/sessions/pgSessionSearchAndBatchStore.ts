import type { Pool, PoolClient } from "pg";
import type {
  BatchClientSessionsInput,
  BatchClientSessionsResult,
  ClientSessionMeta,
  ListClientSessionsOpts,
  ListClientSessionsResult,
  MarkClientSessionReadResult,
  SearchClientSessionsOpts,
  SearchClientSessionsResult,
} from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import {
  CLOCK_MS_SQL,
  LAST_D_TERMINAL_MS_SQL,
  bigIntNum,
  buildLastReadAtMsSql,
  buildUnreadOutcomeSql,
  dispatchUidForList,
  notifySessionsDeleted,
  pgUnreadBySessionIds,
  withTx,
} from "./sqlHelpers.js";
import type { PgSessionsBackendOptions } from "./types.js";

const BATCH_SOFT_DELETE_SESSIONS_SQL = `UPDATE client_sessions
   SET deleted_at = ${CLOCK_MS_SQL},
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       messages = '[]', message_count = 0, last_preview = ''
 WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL
 RETURNING id`;

const BATCH_ARCHIVE_SESSIONS_SQL = `UPDATE client_sessions
   SET archived_at = COALESCE(archived_at, ${CLOCK_MS_SQL}),
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
   AND id = ANY($2::text[])`;

const BATCH_UNARCHIVE_SESSIONS_SQL = `UPDATE client_sessions
   SET archived_at = NULL,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $1 AND deleted_at IS NULL AND archived_at IS NOT NULL
   AND id = ANY($2::text[])`;

const BATCH_MOVE_EXPECTED_SESSION_SQL = `UPDATE client_sessions
   SET project_id = $1,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $2 AND user_id = $3
   AND deleted_at IS NULL AND archived_at IS NULL
   AND updated_at = $4
   AND project_id IS NOT DISTINCT FROM $5
 RETURNING id, project_id, updated_at`;

const BATCH_MOVE_SESSIONS_SQL = `UPDATE client_sessions
   SET project_id = $1,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
   AND id = ANY($3::text[])`;

const MARK_CLIENT_SESSION_READ_SQL = `UPDATE client_sessions SET last_read_at = ${CLOCK_MS_SQL}
 WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`;

const MARK_ALL_CLIENT_SESSIONS_READ_SQL = `UPDATE client_sessions SET last_read_at = ${CLOCK_MS_SQL}
 WHERE user_id = $1 AND deleted_at IS NULL`;

type ListedSessionRow = {
  id: string;
  agent_id: string;
  title: string;
  pinned: number;
  created_at: string;
  last_at: string;
  updated_at: string;
  msg_count: number;
  model_id: string | null;
  project_id: string | null;
  archived_at: string | null;
  last_preview_raw: string | null;
  run_state: string;
  last_outcome: string | null;
  last_error_code: string | null;
  unread: boolean;
};

type SearchTitleRow = {
  id: string;
  title: string;
  project_id: string | null;
  last_at: string;
};

type SearchMessageRow = {
  id: string;
  title: string;
  project_id: string | null;
  matched_at: string;
  msg_text: string;
};

type ExpectedSessionRef = {
  id: string;
  updatedAt: number;
  projectId: string | null;
};

type ParsedSessionBatch = {
  ids: string[];
  action: "delete" | "archive" | "unarchive" | "move";
  projectId?: string | null;
  operationId?: string;
  expectedSessions?: ExpectedSessionRef[];
};

class BatchStaleSessionError extends Error {
  constructor(readonly staleIds: string[]) {
    super("stale_session");
    this.name = "BatchStaleSessionError";
  }
}

function buildListClientSessionsSql(
  includeArchived: boolean,
  hasBefore: boolean,
  limit: number | undefined,
  deps: PgSessionsDeps,
): string {
  const archiveSql = includeArchived ? "" : " AND cs.archived_at IS NULL";
  const beforeSql = hasBefore ? " AND cs.last_at < $3" : "";
  const limitSql = limit !== undefined ? ` LIMIT ${limit + 1}` : "";
  const expandMaxBytes = deps.storage.SESSION_SEARCH_JSON_EXPAND_MAX_BYTES;
  const previewTailMax = deps.storage.LAST_MESSAGE_PREVIEW_TAIL_MAX;
  const unreadOutcomeSql = buildUnreadOutcomeSql(deps);
  const lastReadAtMsSql = buildLastReadAtMsSql(deps);
  return `SELECT cs.id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at, cs.updated_at,
          cs.message_count AS msg_count, cs.model_id, cs.project_id, cs.archived_at,
          CASE WHEN cs.last_preview IS NOT NULL THEN cs.last_preview
               WHEN octet_length(cs.messages) > ${expandMaxBytes}
                    OR left(COALESCE(cs.messages, ''), 1) <> '['
                    OR position((chr(92) || 'u0000') in cs.messages) > 0 THEN NULL
               ELSE (
                 SELECT LEFT(txt, 240)
                   FROM (
                     SELECT btrim(elem->>'text') AS txt
                       FROM json_array_elements(cs.messages::json)
                            WITH ORDINALITY AS t(elem, n)
                      ORDER BY n DESC
                      LIMIT ${previewTailMax}
                   ) tail
                  WHERE txt IS NOT NULL AND length(txt) > 0
                  LIMIT 1
               ) END AS last_preview_raw,
          CASE WHEN open_d.session_id IS NOT NULL THEN 'running' ELSE 'idle' END AS run_state,
          last_d.outcome AS last_outcome,
          last_d.failure_code AS last_error_code,
          COALESCE(
            last_d.outcome IN (${unreadOutcomeSql})
              AND ${LAST_D_TERMINAL_MS_SQL} > ${lastReadAtMsSql},
            FALSE
          ) AS unread
     FROM client_sessions cs
     LEFT JOIN (
       SELECT session_id FROM turn_dispatches
        WHERE user_id = $2
          AND status IN ('admitted', 'accepted', 'rejecting')
        GROUP BY session_id
     ) open_d ON open_d.session_id = cs.id
     LEFT JOIN LATERAL (
       SELECT outcome, failure_code, terminal_at
         FROM turn_dispatches
        WHERE user_id = $2
          AND session_id = cs.id
          AND status = 'terminal'
        ORDER BY terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC
        LIMIT 1
     ) last_d ON TRUE
    WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}${beforeSql}
    ORDER BY cs.last_at DESC${limitSql}`;
}

function mapListedSessionRow(r: ListedSessionRow, deps: PgSessionsDeps): ClientSessionMeta {
  const preview = deps.storage.toLastMessagePreview(r.last_preview_raw);
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    pinned: r.pinned === 1,
    createdAt: bigIntNum(r.created_at, "created_at"),
    lastAt: bigIntNum(r.last_at, "last_at"),
    messageCount: r.msg_count,
    updatedAt: bigIntNum(r.updated_at, "updated_at"),
    projectId: r.project_id ?? null,
    runState: r.run_state === "running" ? "running" : "idle",
    lastOutcome: deps.storage.mapClientSessionLastOutcome(r.last_outcome),
    lastErrorCode: r.last_error_code ?? null,
    unread: r.unread === true,
    archived: r.archived_at != null,
    ...(preview ? { lastMessagePreview: preview } : {}),
    ...(r.model_id ? { modelId: r.model_id } : {}),
  };
}

async function listClientSessionsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  opts: ListClientSessionsOpts = {},
): Promise<ListClientSessionsResult> {
  // runState / lastOutcome / lastErrorCode 从 turn_dispatches 一条 SQL 派生。
  const dispatchUid = dispatchUidForList(userId);
  const includeArchived = opts.includeArchived === true;
  const before =
    typeof opts.before === "number" && Number.isFinite(opts.before) && opts.before > 0
      ? Math.floor(opts.before)
      : undefined;
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(deps.storage.SESSION_LIST_LIMIT_MAX, Math.floor(opts.limit))
      : undefined;
  const params: unknown[] =
    before !== undefined ? [userId, dispatchUid, before] : [userId, dispatchUid];
  const sql = buildListClientSessionsSql(includeArchived, before !== undefined, limit, deps);
  const rows = (await pool.query<ListedSessionRow>(sql, params)).rows;
  let sliced = rows;
  let nextCursor: number | undefined;
  if (limit !== undefined && rows.length > limit) {
    sliced = rows.slice(0, limit);
    const last = sliced[sliced.length - 1];
    if (last) nextCursor = bigIntNum(last.last_at, "last_at");
  }
  return {
    sessions: sliced.map((r) => mapListedSessionRow(r, deps)),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function projectFilterSql(projectId: string | null | undefined, paramIndex: number): string {
  if (projectId === undefined) return "";
  if (projectId === null) return " AND cs.project_id IS NULL";
  return ` AND cs.project_id = $${paramIndex}`;
}

function buildSearchTitleSql(
  includeArchived: boolean,
  projectId: string | null | undefined,
): string {
  const archiveSql = includeArchived ? "" : " AND cs.archived_at IS NULL";
  const projSql = projectFilterSql(projectId, 3);
  return `SELECT id, title, project_id, last_at
     FROM client_sessions cs
    WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}${projSql}
      AND cs.title ILIKE $2 ESCAPE '\\'`;
}

function buildSearchMessagesSql(
  source: "hot" | "archive",
  includeArchived: boolean,
  projectId: string | null | undefined,
): string {
  const archiveSql = includeArchived ? "" : " AND cs.archived_at IS NULL";
  const projSql = projectFilterSql(projectId, 6);
  const cte =
    source === "hot"
      ? `SELECT cs.id, cs.title, cs.project_id, cs.last_at, cs.messages,
                octet_length(cs.messages) AS msg_bytes
           FROM client_sessions cs
          WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}${projSql}
            AND cs.messages ILIKE $2 ESCAPE '\\'`
      : `SELECT cs.id, cs.title, cs.project_id, cs.last_at, ch.messages,
                octet_length(ch.messages) AS msg_bytes
           FROM client_session_archive_chunks ch
           JOIN client_sessions cs ON cs.id = ch.session_id AND cs.user_id = ch.user_id
          WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}${projSql}
            AND ch.messages ILIKE $2 ESCAPE '\\'`;
  return `WITH text_hits AS (
     ${cte}
      ORDER BY cs.last_at DESC
      LIMIT $3
   )
   SELECT c.id, c.title, c.project_id,
          COALESCE((elem->>'ts')::bigint, c.last_at)::text AS matched_at,
          LEFT(COALESCE(elem->>'text', ''), 400) AS msg_text
     FROM text_hits c
     CROSS JOIN LATERAL json_array_elements(
       CASE WHEN left(c.messages, 1) = '['
                  AND position((chr(92) || 'u0000') in c.messages) = 0
            THEN c.messages::json ELSE '[]'::json END
     ) elem
    WHERE c.msg_bytes <= $4
      AND position((chr(92) || 'u0000') in c.messages) = 0
      AND elem->>'text' ILIKE $2 ESCAPE '\\'
   UNION ALL
   SELECT c.id, c.title, c.project_id,
          c.last_at::text AS matched_at,
          substring(c.messages FROM GREATEST(1, strpos(lower(c.messages), lower($5)) - 80) FOR 400) AS msg_text
     FROM text_hits c
    WHERE c.msg_bytes > $4
       OR position((chr(92) || 'u0000') in c.messages) > 0`;
}

function mapMessageSearchRows(rows: SearchMessageRow[], q: string, deps: PgSessionsDeps) {
  return rows.map((r) => ({
    sessionId: r.id,
    title: r.title,
    projectId: r.project_id ?? null,
    snippet: deps.storage.buildSearchSnippet(r.msg_text, q),
    matchedAt: bigIntNum(r.matched_at, "matched_at"),
    kind: "message" as const,
  }));
}

async function searchClientSessionsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  opts: SearchClientSessionsOpts,
): Promise<SearchClientSessionsResult> {
  const q = opts.q.trim();
  if (!q) return { results: [] };
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(deps.storage.SESSION_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
      : deps.storage.SESSION_SEARCH_LIMIT_DEFAULT;
  const includeArchived = opts.includeArchived === true;
  const like = `%${deps.storage.escapeLikePattern(q)}%`;
  const candMax = deps.storage.SESSION_SEARCH_JSON_CANDIDATE_MAX;
  const expandMax = deps.storage.SESSION_SEARCH_JSON_EXPAND_MAX_BYTES;
  const titleParams: unknown[] =
    typeof opts.projectId === "string" ? [userId, like, opts.projectId] : [userId, like];
  const msgParams: unknown[] =
    typeof opts.projectId === "string"
      ? [userId, like, candMax, expandMax, q, opts.projectId]
      : [userId, like, candMax, expandMax, q];

  const titleSql = buildSearchTitleSql(includeArchived, opts.projectId);
  const hotMsgSql = buildSearchMessagesSql("hot", includeArchived, opts.projectId);
  const chunkMsgSql = buildSearchMessagesSql("archive", includeArchived, opts.projectId);
  const titleRows = (await pool.query<SearchTitleRow>(titleSql, titleParams)).rows;
  const msgRows = (await pool.query<SearchMessageRow>(hotMsgSql, msgParams)).rows;
  const chunkRows = (await pool.query<SearchMessageRow>(chunkMsgSql, msgParams)).rows;

  const hits = [
    ...titleRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: deps.storage.buildSearchSnippet(r.title, q),
      matchedAt: bigIntNum(r.last_at, "last_at"),
      kind: "title" as const,
    })),
    ...mapMessageSearchRows(msgRows, q, deps),
    ...mapMessageSearchRows(chunkRows, q, deps),
  ];
  const ranked = deps.storage.rankSessionSearchHits(hits, limit);
  const unreadMap = await pgUnreadBySessionIds(
    pool,
    userId,
    ranked.map((h) => h.sessionId),
    deps,
  );
  return {
    results: ranked.map((h) => ({ ...h, unread: unreadMap.get(h.sessionId) === true })),
  };
}

async function findStaleExpectedSessions(
  client: PoolClient,
  userId: string,
  expectedSessions: readonly ExpectedSessionRef[],
): Promise<string[]> {
  const liveRows = (
    await client.query<{
      id: string;
      project_id: string | null;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `SELECT id, project_id, updated_at, deleted_at
         FROM client_sessions
        WHERE user_id = $1 AND id = ANY($2::text[])`,
      [userId, expectedSessions.map((r) => r.id)],
    )
  ).rows;
  const liveMap = new Map(liveRows.map((r) => [r.id, r]));
  const staleIds: string[] = [];
  for (const exp of expectedSessions) {
    const live = liveMap.get(exp.id);
    const liveUpdated = live ? Number(live.updated_at) : Number.NaN;
    if (
      !live ||
      live.deleted_at ||
      liveUpdated !== exp.updatedAt ||
      (live.project_id ?? null) !== (exp.projectId ?? null)
    ) {
      staleIds.push(exp.id);
    }
  }
  return staleIds;
}

async function deleteBatchSessionsInTx(
  client: PoolClient,
  userId: string,
  targetIds: string[],
  deletedIds: string[],
): Promise<number> {
  const result = await client.query<{ id: string }>(BATCH_SOFT_DELETE_SESSIONS_SQL, [
    targetIds,
    userId,
  ]);
  const actuallyDeleted = result.rows.map((r) => r.id);
  if (actuallyDeleted.length === 0) return 0;
  await client.query(
    "DELETE FROM client_session_user_payloads WHERE session_id = ANY($1::text[]) AND user_id = $2",
    [actuallyDeleted, userId],
  );
  await client.query(
    "DELETE FROM client_session_archive_chunks WHERE session_id = ANY($1::text[])",
    [actuallyDeleted],
  );
  await client.query(
    "DELETE FROM client_session_archived_ids WHERE session_id = ANY($1::text[])",
    [actuallyDeleted],
  );
  await client.query(
    "DELETE FROM turn_tape_recovery_links WHERE session_id = ANY($1::text[])",
    [actuallyDeleted],
  );
  await client.query(
    "DELETE FROM client_session_turn_tapes WHERE session_id = ANY($1::text[])",
    [actuallyDeleted],
  );
  await client.query(
    "DELETE FROM pending_usage_patches WHERE user_id = $2 AND parent_session_id = ANY($1::text[]) AND parent_session_id IS NOT NULL",
    [actuallyDeleted, userId],
  );
  deletedIds.push(...actuallyDeleted);
  return actuallyDeleted.length;
}

async function moveSingleExpectedSessionInTx(
  client: PoolClient,
  userId: string,
  projectId: string | null,
  exp: ExpectedSessionRef,
): Promise<{ id: string; projectId: string | null; updatedAt: number }> {
  const res = await client.query<{
    id: string;
    project_id: string | null;
    updated_at: string;
  }>(BATCH_MOVE_EXPECTED_SESSION_SQL, [projectId, exp.id, userId, exp.updatedAt, exp.projectId]);
  if ((res.rowCount ?? 0) !== 1) throw new BatchStaleSessionError([exp.id]);
  const row = res.rows[0]!;
  return {
    id: row.id,
    projectId: row.project_id,
    updatedAt: Number(row.updated_at),
  };
}

async function moveExpectedSessionsInTx(
  client: PoolClient,
  userId: string,
  parsed: ParsedSessionBatch,
  skipped: number,
): Promise<BatchClientSessionsResult> {
  const expected = parsed.expectedSessions!;
  if (expected.length !== parsed.ids.length) {
    throw new BatchStaleSessionError(parsed.ids);
  }
  const post: Array<{ id: string; projectId: string | null; updatedAt: number }> = [];
  for (const exp of expected) {
    post.push(await moveSingleExpectedSessionInTx(client, userId, parsed.projectId ?? null, exp));
  }
  if (post.length !== expected.length) {
    throw new BatchStaleSessionError(parsed.ids);
  }
  return { ok: true, updated: post.length, skipped, operationId: parsed.operationId, post };
}

async function runBatchClientSessionsTx(
  client: PoolClient,
  userId: string,
  parsed: ParsedSessionBatch,
  deletedIds: string[],
): Promise<BatchClientSessionsResult> {
  const { ids, action } = parsed;
  if (parsed.expectedSessions && parsed.expectedSessions.length > 0) {
    const staleIds = await findStaleExpectedSessions(client, userId, parsed.expectedSessions);
    if (staleIds.length) return { ok: false, error: "stale_session", staleIds };
  }
  if (action === "move" && parsed.projectId) {
    const owned = (
      await client.query(
        "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        [parsed.projectId, userId],
      )
    ).rows[0];
    if (!owned) return { ok: false, error: "project_not_found" };
  }
  const ownedRows = (
    await client.query<{ id: string }>(
      `SELECT id FROM client_sessions
        WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])`,
      [userId, ids],
    )
  ).rows;
  const owned = new Set(ownedRows.map((r) => r.id));
  const skipped = ids.length - owned.size;
  const targetIds = ids.filter((id) => owned.has(id));
  if (targetIds.length === 0) return { ok: true, updated: 0, skipped };

  if (action === "delete") {
    const updated = await deleteBatchSessionsInTx(client, userId, targetIds, deletedIds);
    return { ok: true, updated, skipped, operationId: parsed.operationId };
  }
  if (action === "archive") {
    const res = await client.query(BATCH_ARCHIVE_SESSIONS_SQL, [userId, targetIds]);
    return { ok: true, updated: res.rowCount ?? 0, skipped, operationId: parsed.operationId };
  }
  if (action === "unarchive") {
    const res = await client.query(BATCH_UNARCHIVE_SESSIONS_SQL, [userId, targetIds]);
    return { ok: true, updated: res.rowCount ?? 0, skipped, operationId: parsed.operationId };
  }
  if (parsed.expectedSessions && parsed.expectedSessions.length > 0) {
    return moveExpectedSessionsInTx(client, userId, parsed, skipped);
  }
  const res = await client.query(BATCH_MOVE_SESSIONS_SQL, [
    parsed.projectId ?? null,
    userId,
    targetIds,
  ]);
  return { ok: true, updated: res.rowCount ?? 0, skipped, operationId: parsed.operationId };
}

async function batchClientSessionsImpl(
  pool: Pool,
  options: PgSessionsBackendOptions,
  deps: PgSessionsDeps,
  userId: string,
  input: BatchClientSessionsInput,
): Promise<BatchClientSessionsResult> {
  const parsed = deps.storage.parseSessionBatchInput(input);
  if ("ok" in parsed) return parsed;
  if (parsed.ids.length === 0) {
    return { ok: true, updated: 0, skipped: 0, operationId: parsed.operationId };
  }
  const deletedIds: string[] = [];
  let batch: BatchClientSessionsResult;
  try {
    batch = await withTx(pool, (client) =>
      runBatchClientSessionsTx(client, userId, parsed, deletedIds),
    );
  } catch (err) {
    if (err instanceof BatchStaleSessionError) {
      return { ok: false, error: "stale_session", staleIds: err.staleIds };
    }
    throw err;
  }
  if (batch.ok && parsed.action === "delete") {
    notifySessionsDeleted(options.onClientSessionsDeleted, userId, deletedIds);
  }
  return batch;
}

async function markClientSessionReadImpl(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<MarkClientSessionReadResult> {
  // last_read_at 单位 = epoch milliseconds（与 CLOCK_MS_SQL / terminal_at 派生相同）。
  const res = await pool.query(MARK_CLIENT_SESSION_READ_SQL, [userId, sessionId]);
  const updated = res.rowCount ?? 0;
  if (updated === 0) return { ok: false, error: "not_found" };
  return { ok: true, updated };
}

async function markAllClientSessionsReadImpl(
  pool: Pool,
  userId: string,
): Promise<{ updated: number }> {
  const res = await pool.query(MARK_ALL_CLIENT_SESSIONS_READ_SQL, [userId]);
  return { updated: res.rowCount ?? 0 };
}

export function createPgSessionSearchAndBatchStore(ctx: PgSessionsCtx) {
  const { pool, options, deps } = ctx;
  return {
    listClientSessions: (userId: string, opts: ListClientSessionsOpts = {}) =>
      listClientSessionsImpl(pool, deps, userId, opts),
    searchClientSessions: (userId: string, opts: SearchClientSessionsOpts) =>
      searchClientSessionsImpl(pool, deps, userId, opts),
    batchClientSessions: (userId: string, input: BatchClientSessionsInput) =>
      batchClientSessionsImpl(pool, options, deps, userId, input),
    markClientSessionRead: (userId: string, sessionId: string) =>
      markClientSessionReadImpl(pool, userId, sessionId),
    markAllClientSessionsRead: (userId: string) => markAllClientSessionsReadImpl(pool, userId),
  };
}
