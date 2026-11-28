import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ChatProject,
  ChatProjectCreateResult,
  ChatProjectDeleteResult,
  ChatProjectDeletedManifest,
  ChatProjectRestoreResult,
  ChatProjectRuntimeBind,
  ChatProjectTemplate,
  ChatProjectUpdateResult,
  DeletedChatProject,
} from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { CLOCK_MS_SQL, bigIntNum, withTx } from "./sqlHelpers.js";
import type { QueryRunner } from "./types.js";

const PG_CHAT_PROJECT_SELECT = `
  SELECT p.id, p.name, p.instructions, p.color, p.sort_order, p.created_at, p.updated_at,
         p.board_project_id, p.archived_at, p.pinned_at, p.template,
         COALESCE(c.cnt, 0)::text AS session_count
    FROM chat_projects p
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt
        FROM client_sessions
       WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT NULL
       GROUP BY project_id
    ) c ON c.project_id = p.id
`;

const READ_CHAT_PROJECT_SQL = `${PG_CHAT_PROJECT_SELECT} WHERE p.id = $2 AND p.user_id = $3 AND p.deleted_at IS NULL`;
const LIST_CHAT_PROJECTS_SQL = `${PG_CHAT_PROJECT_SELECT}
  WHERE p.user_id = $2 AND p.deleted_at IS NULL
  ORDER BY p.sort_order ASC, p.created_at ASC`;

const INSERT_CHAT_PROJECT_SQL = `INSERT INTO chat_projects
   (id, user_id, name, instructions, color, sort_order, created_at, updated_at, deleted_at,
    is_research_default, template, board_project_id)
 VALUES ($1, $2, $3, $4, $5, COALESCE((
   SELECT MAX(sort_order) + 1 FROM chat_projects WHERE user_id = $2 AND deleted_at IS NULL
 ), 0), ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, NULL, $6, $7, $8)`;

const SOFT_DELETE_CHAT_PROJECT_SQL = `UPDATE chat_projects
   SET deleted_at = ${CLOCK_MS_SQL},
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;

const UNLINK_PROJECT_SESSIONS_SQL = `UPDATE client_sessions
   SET project_id = NULL,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL
 RETURNING id`;

const UNLINK_PROJECT_ASSETS_SQL = `UPDATE project_assets
   SET project_id = NULL,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL
 RETURNING id`;

const RESTORE_CHAT_PROJECT_SQL = `UPDATE chat_projects
   SET deleted_at = NULL, deleted_manifest = NULL,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $1 AND user_id = $2`;

const RELINK_RESTORED_SESSIONS_SQL = `UPDATE client_sessions
   SET project_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $2 AND id = ANY($3::text[]) AND project_id IS NULL AND deleted_at IS NULL
 RETURNING id`;

const RELINK_RESTORED_ASSETS_SQL = `UPDATE project_assets
   SET project_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $2 AND id = ANY($3::text[]) AND project_id IS NULL AND deleted_at IS NULL`;

type PgChatProjectRow = {
  id: string;
  name: string;
  instructions: string | null;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  session_count: string;
  board_project_id: string | null;
  archived_at: string | null;
  pinned_at: string | null;
  template: string | null;
};

type CreateChatProjectInput = {
  name?: unknown;
  instructions?: unknown;
  color?: unknown;
  isResearchDefault?: unknown;
  template?: unknown;
  reserveBoard?: boolean;
};

type UpdateChatProjectInput = {
  name?: unknown;
  instructions?: unknown;
  color?: unknown;
  sortOrder?: unknown;
  boardProjectId?: unknown;
  archived?: unknown;
  pinned?: unknown;
};

type PreparedChatProjectCreate = {
  id: string;
  name: string;
  instructions: string | null;
  color: string | null;
  isDefault: boolean;
  template: ChatProjectTemplate | null;
  boardProjectId: string | null;
};

type PreparedChatProjectUpdate = {
  sets: string[];
  params: unknown[];
  nextParam: number;
  bindGuard: string | null;
};

export function pgTemplate(
  raw: string | null | undefined,
  deps: PgSessionsDeps,
): ChatProjectTemplate | null {
  const t = deps.storage.parseChatProjectTemplate(raw);
  return t === "invalid" ? null : t;
}

function mapPgChatProjectRow(r: PgChatProjectRow, deps: PgSessionsDeps): ChatProject {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: bigIntNum(r.created_at, "created_at"),
    updatedAt: bigIntNum(r.updated_at, "updated_at"),
    sessionCount: Number(r.session_count) || 0,
    boardProjectId: r.board_project_id ?? null,
    archivedAt: r.archived_at == null ? null : bigIntNum(r.archived_at, "archived_at"),
    pinnedAt: r.pinned_at == null ? null : bigIntNum(r.pinned_at, "pinned_at"),
    template: pgTemplate(r.template, deps),
  };
}

export async function readPgChatProject(
  queryable: QueryRunner,
  userId: string,
  id: string,
  deps: PgSessionsDeps,
): Promise<ChatProject | null> {
  const row = (
    await queryable.query<PgChatProjectRow>(READ_CHAT_PROJECT_SQL, [userId, id, userId])
  ).rows[0];
  return row ? mapPgChatProjectRow(row, deps) : null;
}

async function getSessionProjectInstructionsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  sessionId: string,
): Promise<string | null> {
  const row = (
    await pool.query<{ instructions: string | null }>(
      `SELECT p.instructions
         FROM client_sessions cs
         JOIN chat_projects p ON p.id = cs.project_id AND p.user_id = cs.user_id
        WHERE cs.id = $1 AND cs.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [sessionId],
    )
  ).rows[0];
  if (!row?.instructions) return null;
  const cleaned = deps.storage.sanitizeProjectInstructions(row.instructions).trim();
  return cleaned.length > 0 ? cleaned : null;
}

async function getChatProjectBindBySessionIdImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  sessionId: string,
): Promise<ChatProjectRuntimeBind | null> {
  const row = (
    await pool.query<{
      user_id: string;
      chat_project_id: string;
      board_project_id: string | null;
      name: string;
      instructions: string | null;
      template: string | null;
    }>(
      `SELECT cs.user_id, p.id AS chat_project_id, p.board_project_id, p.name, p.instructions, p.template
         FROM client_sessions cs
         JOIN chat_projects p ON p.id = cs.project_id AND p.user_id = cs.user_id
        WHERE cs.id = $1 AND cs.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [sessionId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    chatProjectId: row.chat_project_id,
    boardProjectId: row.board_project_id ?? null,
    name: row.name,
    instructions: row.instructions,
    template: pgTemplate(row.template, deps),
  };
}

async function getChatProjectBindByBoardProjectIdImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  boardProjectId: string,
): Promise<ChatProjectRuntimeBind | null> {
  const parsed = deps.storage.parseBoardProjectId(boardProjectId);
  if (!("present" in parsed) || !parsed.present || !parsed.value) return null;
  const row = (
    await pool.query<{
      user_id: string;
      id: string;
      board_project_id: string | null;
      name: string;
      instructions: string | null;
      template: string | null;
    }>(
      `SELECT user_id, id, board_project_id, name, instructions, template
         FROM chat_projects
        WHERE user_id = $1 AND board_project_id = $2 AND deleted_at IS NULL`,
      [userId, parsed.value],
    )
  ).rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    chatProjectId: row.id,
    boardProjectId: row.board_project_id ?? null,
    name: row.name,
    instructions: row.instructions,
    template: pgTemplate(row.template, deps),
  };
}

async function listChatProjectsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
): Promise<ChatProject[]> {
  const rows = (
    await pool.query<PgChatProjectRow>(LIST_CHAT_PROJECTS_SQL, [userId, userId])
  ).rows;
  return rows.map((r) => mapPgChatProjectRow(r, deps));
}

function validateCreateChatProjectInput(
  input: CreateChatProjectInput,
  deps: PgSessionsDeps,
): { ok: true; value: PreparedChatProjectCreate } | ChatProjectCreateResult {
  const name = deps.storage.parseChatProjectName(input.name);
  if (!name) return { ok: false, error: "invalid_name" };
  const instructions = deps.storage.parseChatProjectOptionalText(
    input.instructions,
    deps.storage.CHAT_PROJECT_INSTRUCTIONS_MAX,
  );
  if ("invalid" in instructions) return { ok: false, error: "invalid_instructions" };
  const color = deps.storage.parseChatProjectOptionalText(
    input.color,
    deps.storage.CHAT_PROJECT_COLOR_MAX,
  );
  if ("invalid" in color) return { ok: false, error: "invalid_color" };
  const template = deps.storage.parseChatProjectTemplate(input.template);
  if (template === "invalid") return { ok: false, error: "invalid_template" };
  const isDefault = input.isResearchDefault === true;
  // Project layer on: reserve the work-project id now; the container creates that board on first use.
  const boardProjectId = input.reserveBoard === true && !isDefault ? randomUUID() : null;
  return {
    ok: true,
    value: {
      id: randomUUID(),
      name,
      instructions: instructions.present ? instructions.value : null,
      color: color.present ? color.value : null,
      isDefault,
      template,
      boardProjectId,
    },
  };
}

async function readExistingResearchDefaultProject(
  client: PoolClient,
  userId: string,
  deps: PgSessionsDeps,
): Promise<ChatProject | null> {
  const existing = (
    await client.query<{ id: string }>(
      `SELECT id FROM chat_projects
        WHERE user_id = $1 AND is_research_default IS TRUE AND deleted_at IS NULL`,
      [userId],
    )
  ).rows[0];
  return existing ? readPgChatProject(client, userId, existing.id, deps) : null;
}

async function runCreateChatProjectTx(
  client: PoolClient,
  userId: string,
  prepared: PreparedChatProjectCreate,
  deps: PgSessionsDeps,
): Promise<ChatProjectCreateResult> {
  const countRow = (
    await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM chat_projects WHERE user_id = $1 AND deleted_at IS NULL",
      [userId],
    )
  ).rows[0];
  if (Number(countRow?.n ?? 0) >= deps.storage.CHAT_PROJECT_PER_USER_LIMIT) {
    return { ok: false, error: "limit_exceeded" };
  }
  try {
    await client.query(INSERT_CHAT_PROJECT_SQL, [
      prepared.id,
      userId,
      prepared.name,
      prepared.instructions,
      prepared.color,
      prepared.isDefault,
      prepared.template,
      prepared.boardProjectId,
    ]);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (prepared.isDefault && code === "23505") {
      const existing = await readExistingResearchDefaultProject(client, userId, deps);
      if (existing) return { ok: true, project: existing };
    }
    throw err;
  }
  const project = await readPgChatProject(client, userId, prepared.id, deps);
  if (!project) throw new Error("chat project insert vanished");
  return { ok: true, project };
}

async function createChatProjectImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  input: CreateChatProjectInput,
): Promise<ChatProjectCreateResult> {
  const validated = validateCreateChatProjectInput(input, deps);
  if (!validated.ok) return validated;
  if ("project" in validated) return validated;
  return withTx(pool, (client) => runCreateChatProjectTx(client, userId, validated.value, deps));
}

function appendBooleanFlagSets(
  input: UpdateChatProjectInput,
  sets: string[],
): ChatProjectUpdateResult | null {
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") return { ok: false, error: "invalid_flag" };
    sets.push(
      input.archived ? `archived_at = COALESCE(archived_at, ${CLOCK_MS_SQL})` : "archived_at = NULL",
    );
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== "boolean") return { ok: false, error: "invalid_flag" };
    sets.push(
      input.pinned ? `pinned_at = COALESCE(pinned_at, ${CLOCK_MS_SQL})` : "pinned_at = NULL",
    );
  }
  return null;
}

async function isBoardBoundAfterUpdate(
  pool: Pool,
  userId: string,
  id: string,
  boardProjectId: unknown,
  deps: PgSessionsDeps,
): Promise<boolean> {
  const existing = await readPgChatProject(pool, userId, id, deps);
  const nextBoard =
    boardProjectId !== undefined
      ? deps.storage.parseBoardProjectId(boardProjectId)
      : { present: true as const, value: existing?.boardProjectId ?? null };
  return (
    "present" in nextBoard &&
    nextBoard.present &&
    typeof nextBoard.value === "string" &&
    nextBoard.value.length > 0
  );
}

function appendRemainingProjectUpdateFields(
  input: UpdateChatProjectInput,
  state: PreparedChatProjectUpdate,
  deps: PgSessionsDeps,
): ChatProjectUpdateResult | null {
  if (input.color !== undefined) {
    const color = deps.storage.parseChatProjectOptionalText(
      input.color,
      deps.storage.CHAT_PROJECT_COLOR_MAX,
    );
    if ("invalid" in color || !color.present) return { ok: false, error: "invalid_color" };
    state.sets.push(`color = $${state.nextParam++}`);
    state.params.push(color.value);
  }
  if (input.sortOrder !== undefined) {
    const sortOrder = deps.storage.parseChatProjectSortOrder(input.sortOrder);
    if (sortOrder === null) return { ok: false, error: "invalid_sort_order" };
    state.sets.push(`sort_order = $${state.nextParam++}`);
    state.params.push(sortOrder);
  }
  if (input.boardProjectId !== undefined) {
    const bound = deps.storage.parseBoardProjectId(input.boardProjectId);
    if ("invalid" in bound) return { ok: false, error: "invalid_board_project_id" };
    if (bound.present) {
      // A project keeps its work project for life (memory, skills, cron, billing hang off it);
      // enforced in the UPDATE itself so concurrent binds cannot both win.
      if (bound.value === null) return { ok: false, error: "board_project_bound" };
      state.sets.push(`board_project_id = $${state.nextParam++}`);
      state.params.push(bound.value);
      state.bindGuard = bound.value;
    }
  }
  return null;
}

async function prepareUpdateChatProject(
  pool: Pool,
  userId: string,
  id: string,
  input: UpdateChatProjectInput,
  deps: PgSessionsDeps,
): Promise<{ ok: true; state: PreparedChatProjectUpdate } | ChatProjectUpdateResult> {
  const state: PreparedChatProjectUpdate = {
    sets: [`updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})`],
    params: [],
    nextParam: 1,
    bindGuard: null,
  };
  const flagErr = appendBooleanFlagSets(input, state.sets);
  if (flagErr) return flagErr;
  if (input.name !== undefined) {
    const name = deps.storage.parseChatProjectName(input.name);
    if (!name) return { ok: false, error: "invalid_name" };
    state.sets.push(`name = $${state.nextParam++}`);
    state.params.push(name);
  }
  if (input.instructions !== undefined) {
    const instructions = deps.storage.parseChatProjectOptionalText(
      input.instructions,
      deps.storage.CHAT_PROJECT_INSTRUCTIONS_MAX,
    );
    if ("invalid" in instructions || !instructions.present) {
      return { ok: false, error: "invalid_instructions" };
    }
    if (!(await isBoardBoundAfterUpdate(pool, userId, id, input.boardProjectId, deps))) {
      state.sets.push(`instructions = $${state.nextParam++}`);
      state.params.push(instructions.value);
    }
  }
  const restErr = appendRemainingProjectUpdateFields(input, state, deps);
  if (restErr) return restErr;
  return { ok: true, state };
}

function buildUpdateChatProjectSql(
  sets: readonly string[],
  idParam: number,
  userParam: number,
  guardParam: number | null,
): string {
  const guardSql =
    guardParam !== null ? ` AND (board_project_id IS NULL OR board_project_id = $${guardParam})` : "";
  return `UPDATE chat_projects SET ${sets.join(", ")}
    WHERE id = $${idParam} AND user_id = $${userParam} AND deleted_at IS NULL${guardSql}`;
}

async function runUpdateChatProjectTx(
  client: PoolClient,
  userId: string,
  id: string,
  state: PreparedChatProjectUpdate,
  deps: PgSessionsDeps,
): Promise<ChatProjectUpdateResult> {
  const params = [...state.params, id, userId];
  let n = state.nextParam;
  const idParam = n++;
  const userParam = n++;
  let guardParam: number | null = null;
  if (state.bindGuard) {
    params.push(state.bindGuard);
    guardParam = n;
  }
  const sql = buildUpdateChatProjectSql(state.sets, idParam, userParam, guardParam);
  try {
    const res = await client.query(sql, params);
    if ((res.rowCount ?? 0) === 0) {
      if (state.bindGuard) {
        const exists = await client.query(
          "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [id, userId],
        );
        if ((exists.rowCount ?? 0) > 0) return { ok: false, error: "board_project_bound" };
      }
      return { ok: false, error: "not_found" };
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return { ok: false, error: "board_project_bound" };
    throw err;
  }
  const project = await readPgChatProject(client, userId, id, deps);
  if (!project) return { ok: false, error: "not_found" };
  return { ok: true, project };
}

async function updateChatProjectImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  id: string,
  input: UpdateChatProjectInput,
): Promise<ChatProjectUpdateResult> {
  const prepared = await prepareUpdateChatProject(pool, userId, id, input, deps);
  if (!prepared.ok) return prepared;
  if ("project" in prepared) return prepared;
  if (prepared.state.sets.length === 1) {
    const existing = await readPgChatProject(pool, userId, id, deps);
    return existing ? { ok: true, project: existing } : { ok: false, error: "not_found" };
  }
  return withTx(pool, (client) => runUpdateChatProjectTx(client, userId, id, prepared.state, deps));
}

async function runDeleteChatProjectTx(
  client: PoolClient,
  userId: string,
  id: string,
  opts: { pausedCronJobIds?: string[] },
): Promise<ChatProjectDeleteResult> {
  const live = await client.query(
    "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [id, userId],
  );
  if ((live.rowCount ?? 0) === 0) return { ok: false, error: "not_found" };
  // Mark deleted first: asset/session filing checks the project is live, so
  // nothing new can attach after this; the manifest is exactly what the
  // UPDATEs below unlink (RETURNING), not a separate earlier read.
  await client.query(SOFT_DELETE_CHAT_PROJECT_SQL, [id, userId]);
  const sessionIds = (
    await client.query<{ id: string }>(UNLINK_PROJECT_SESSIONS_SQL, [userId, id])
  ).rows.map((r) => r.id);
  const assetIds = (
    await client.query<{ id: string }>(UNLINK_PROJECT_ASSETS_SQL, [userId, id])
  ).rows.map((r) => r.id);
  const manifest: ChatProjectDeletedManifest = {
    sessionIds,
    assetIds,
    pausedCronJobIds: opts.pausedCronJobIds ?? [],
    at: Date.now(),
  };
  await client.query(
    "UPDATE chat_projects SET deleted_manifest = $3 WHERE id = $1 AND user_id = $2",
    [id, userId, JSON.stringify(manifest)],
  );
  return { ok: true };
}

async function listDeletedChatProjectsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
): Promise<DeletedChatProject[]> {
  const rows = (
    await pool.query<{
      id: string;
      name: string;
      deleted_at: string;
      deleted_manifest: string | null;
    }>(
      `SELECT id, name, deleted_at, deleted_manifest FROM chat_projects
        WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2
          AND is_research_default IS NOT TRUE
        ORDER BY deleted_at DESC`,
      [userId, Date.now() - deps.storage.CHAT_PROJECT_RESTORE_WINDOW_MS],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    deletedAt: bigIntNum(r.deleted_at, "deleted_at"),
    sessionCount: deps.storage.parseDeletedManifest(r.deleted_manifest).sessionIds.length,
  }));
}

async function runRestoreChatProjectTx(
  client: PoolClient,
  userId: string,
  id: string,
  deps: PgSessionsDeps,
): Promise<ChatProjectRestoreResult> {
  const row = (
    await client.query<{
      deleted_at: string;
      deleted_manifest: string | null;
      board_project_id: string | null;
    }>(
      `SELECT deleted_at, deleted_manifest, board_project_id FROM chat_projects
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL FOR UPDATE`,
      [id, userId],
    )
  ).rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (Date.now() - bigIntNum(row.deleted_at, "deleted_at") > deps.storage.CHAT_PROJECT_RESTORE_WINDOW_MS) {
    return { ok: false, error: "expired" };
  }
  const count = (
    await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM chat_projects WHERE user_id = $1 AND deleted_at IS NULL",
      [userId],
    )
  ).rows[0];
  if (Number(count?.n ?? 0) >= deps.storage.CHAT_PROJECT_PER_USER_LIMIT) {
    return { ok: false, error: "limit_exceeded" };
  }
  if (row.board_project_id) {
    const taken = await client.query(
      "SELECT 1 FROM chat_projects WHERE user_id = $1 AND board_project_id = $2 AND deleted_at IS NULL",
      [userId, row.board_project_id],
    );
    if ((taken.rowCount ?? 0) > 0) return { ok: false, error: "board_project_bound" };
  }
  const manifest = deps.storage.parseDeletedManifest(row.deleted_manifest);
  await client.query(RESTORE_CHAT_PROJECT_SQL, [id, userId]);
  // Only items still ungrouped come back; anything the user moved since stays where it is.
  const relinkedSessionIds = manifest.sessionIds.length
    ? (
        await client.query<{ id: string }>(RELINK_RESTORED_SESSIONS_SQL, [
          id,
          userId,
          manifest.sessionIds,
        ])
      ).rows.map((r) => r.id)
    : [];
  const ra = manifest.assetIds.length
    ? await client.query(RELINK_RESTORED_ASSETS_SQL, [id, userId, manifest.assetIds])
    : { rowCount: 0 };
  const project = await readPgChatProject(client, userId, id, deps);
  if (!project) throw new Error("restored chat project vanished");
  return {
    ok: true,
    project,
    pausedCronJobIds: manifest.pausedCronJobIds,
    relinkedSessions: relinkedSessionIds.length,
    relinkedSessionIds,
    relinkedAssets: ra.rowCount ?? 0,
  };
}

export function createPgChatProjectsStore(ctx: PgSessionsCtx) {
  const { pool, deps } = ctx;
  return {
    getSessionProjectInstructions: (sessionId: string) =>
      getSessionProjectInstructionsImpl(pool, deps, sessionId),
    getChatProjectBindBySessionId: (sessionId: string) =>
      getChatProjectBindBySessionIdImpl(pool, deps, sessionId),
    getChatProjectBindByBoardProjectId: (userId: string, boardProjectId: string) =>
      getChatProjectBindByBoardProjectIdImpl(pool, deps, userId, boardProjectId),
    listChatProjects: (userId: string) => listChatProjectsImpl(pool, deps, userId),
    createChatProject: (userId: string, input: CreateChatProjectInput) =>
      createChatProjectImpl(pool, deps, userId, input),
    updateChatProject: (userId: string, id: string, input: UpdateChatProjectInput) =>
      updateChatProjectImpl(pool, deps, userId, id, input),
    deleteChatProject: (userId: string, id: string, opts: { pausedCronJobIds?: string[] } = {}) =>
      withTx(pool, (client) => runDeleteChatProjectTx(client, userId, id, opts)),
    listDeletedChatProjects: (userId: string) => listDeletedChatProjectsImpl(pool, deps, userId),
    restoreChatProject: (userId: string, id: string) =>
      withTx(pool, (client) => runRestoreChatProjectTx(client, userId, id, deps)),
  };
}
