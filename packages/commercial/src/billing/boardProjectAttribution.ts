/**
 * Immutable board-project attribution for usage_records.
 * Snapshot at settle; later session moves must not rewrite the columns.
 */

export type BoardProjectSource =
  | "session_bind"
  | "delegate_parent"
  | "explicit"
  | "migration_backfill";

export type BoardProjectAttribution = {
  boardProjectId: string | null;
  source: BoardProjectSource | null;
  capturedAt: Date | null;
};

export type AttributionQuery = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

const BOARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function usageSessionOwnerCandidates(usageUserId: bigint | string): string[] {
  const n = typeof usageUserId === "bigint" ? usageUserId.toString() : String(usageUserId).trim();
  if (!n) return [];
  return [`c:${n}`, n];
}

export function sessionOwnerMatchesUsageUser(
  sessionUserId: string | null | undefined,
  usageUserId: bigint | string,
): boolean {
  if (!sessionUserId) return false;
  const owners = usageSessionOwnerCandidates(usageUserId);
  if (owners.includes(sessionUserId)) return true;
  // selfhost single-tenant sqlite default is not a foreign tenant
  return sessionUserId === "default" && owners.includes("c:3");
}

export function parseBoardProjectIdAttr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return BOARD_ID_RE.test(v) ? v.toLowerCase() : null;
}

/** Query-string helper: missing = no filter, "none" = NULL rows, uuid = exact. */
export function parseUsageBoardProjectQuery(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw == null || raw === "") return undefined;
  const v = raw.trim();
  if (!v || v === "all") return undefined;
  if (v === "none") return null;
  return v;
}

export async function lookupSessionBoardProject(
  client: AttributionQuery,
  sessionId: string,
  usageUserId: bigint | string,
): Promise<{ boardProjectId: string | null; sessionUserId: string } | null> {
  const id = sessionId.trim();
  if (!id) return null;
  const res = await client.query(
    `SELECT cs.user_id AS user_id, p.board_project_id AS board_project_id
       FROM client_sessions cs
       LEFT JOIN chat_projects p
         ON p.id = cs.project_id AND p.user_id = cs.user_id AND p.deleted_at IS NULL
      WHERE cs.id = $1 AND cs.deleted_at IS NULL
      LIMIT 1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const sessionUserId = typeof row.user_id === "string" ? row.user_id : String(row.user_id ?? "");
  if (!sessionOwnerMatchesUsageUser(sessionUserId, usageUserId)) {
    return null;
  }
  return {
    sessionUserId,
    boardProjectId: parseBoardProjectIdAttr(row.board_project_id),
  };
}

export async function resolveBoardProjectAttribution(
  client: AttributionQuery,
  args: {
    usageUserId: bigint | string;
    sessionId?: string | null;
    parentSessionId?: string | null;
    mode?: string | null;
    explicit?: { boardProjectId: string | null; source?: BoardProjectSource } | null;
  },
): Promise<BoardProjectAttribution> {
  const now = new Date();
  if (args.explicit) {
    return {
      boardProjectId: parseBoardProjectIdAttr(args.explicit.boardProjectId),
      source: args.explicit.source ?? "explicit",
      capturedAt: now,
    };
  }
  const parentId = args.parentSessionId?.trim() || "";
  if (args.mode === "delegate" && parentId) {
    const parent = await lookupSessionBoardProject(client, parentId, args.usageUserId);
    if (parent) {
      return {
        boardProjectId: parent.boardProjectId,
        source: parent.boardProjectId ? "delegate_parent" : null,
        capturedAt: parent.boardProjectId ? now : null,
      };
    }
  }
  if (args.sessionId) {
    const row = await lookupSessionBoardProject(client, args.sessionId, args.usageUserId);
    if (row) {
      return {
        boardProjectId: row.boardProjectId,
        source: row.boardProjectId ? "session_bind" : null,
        capturedAt: row.boardProjectId ? now : null,
      };
    }
  }
  return { boardProjectId: null, source: null, capturedAt: null };
}

export function usageBoardProjectSql(
  boardProjectId: string | null | undefined,
  alias = "",
): { sql: string; params: unknown[] } {
  const col = alias ? `${alias}.board_project_id` : "board_project_id";
  if (boardProjectId === undefined) return { sql: "", params: [] };
  if (boardProjectId === null || boardProjectId === "none") {
    return { sql: ` AND ${col} IS NULL`, params: [] };
  }
  const id = parseBoardProjectIdAttr(boardProjectId);
  if (!id) return { sql: " AND FALSE", params: [] };
  return { sql: ` AND ${col} = ?`, params: [id] };
}

export function pgUsageBoardProjectSql(
  boardProjectId: string | null | undefined,
  paramIndex: number,
  alias = "",
): { sql: string; params: unknown[]; nextIndex: number } {
  const col = alias ? `${alias}.board_project_id` : "board_project_id";
  if (boardProjectId === undefined) return { sql: "", params: [], nextIndex: paramIndex };
  if (boardProjectId === null || boardProjectId === "none") {
    return { sql: ` AND ${col} IS NULL`, params: [], nextIndex: paramIndex };
  }
  const id = parseBoardProjectIdAttr(boardProjectId);
  if (!id) return { sql: " AND FALSE", params: [], nextIndex: paramIndex };
  return { sql: ` AND ${col} = $${paramIndex}`, params: [id], nextIndex: paramIndex + 1 };
}
