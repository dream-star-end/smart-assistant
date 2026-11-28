import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ListProjectAssetsOpts,
  ParsedProjectAssetCreate,
  PinnedAssetsPage,
  ProjectAsset,
  ProjectAssetCreateInput,
  ProjectAssetCreateResult,
  ProjectAssetDeleteResult,
  ProjectAssetUpdateInput,
  ProjectAssetUpdateResult,
  SearchChatProjectAssetsOpts,
  SearchProjectAssetsOpts,
} from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { CLOCK_MS_SQL, bigIntNum, withTx } from "./sqlHelpers.js";
import type { QueryRunner } from "./types.js";

const PG_PROJECT_ASSET_SELECT = `
  SELECT id, project_id, source, session_id, name, url, container_path, mime,
         size_bytes::text AS size_bytes, digest, excerpt, pinned,
         created_at::text AS created_at, updated_at::text AS updated_at
    FROM project_assets
`;

/**
 * 「是该源路径的最新版本」(上传与无源路径的行恒为真),与 SQLite 侧
 * SQLITE_ASSET_IS_LATEST_VERSION 同构:注入常用资产时只认最新版本。
 */
const PG_ASSET_IS_LATEST_VERSION = `NOT EXISTS (
  SELECT 1 FROM project_assets newer
   WHERE project_assets.source = 'output' AND project_assets.container_path IS NOT NULL
     AND newer.user_id = project_assets.user_id AND newer.deleted_at IS NULL
     AND newer.source = 'output' AND newer.project_id IS NOT DISTINCT FROM project_assets.project_id
     AND newer.container_path = project_assets.container_path
     AND (newer.created_at > project_assets.created_at
          OR (newer.created_at = project_assets.created_at AND newer.id > project_assets.id)))`;

const READ_PROJECT_ASSET_SQL = `${PG_PROJECT_ASSET_SELECT} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;

const LATEST_OUTPUT_VERSION_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND source = 'output'
    AND project_id IS NOT DISTINCT FROM $2 AND container_path = $3
  ORDER BY created_at DESC, id DESC
  LIMIT 1`;

const FIND_DUP_OUTPUT_REPLAY_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND source = 'output'
    AND project_id IS NOT DISTINCT FROM $2 AND container_path = $3 AND digest = $4
  ORDER BY created_at DESC, id DESC
  LIMIT 1`;

const FIND_DUP_BY_DIGEST_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND source = $2
    AND project_id IS NOT DISTINCT FROM $3 AND digest = $4
  LIMIT 1`;

const FIND_DUP_BY_CONTAINER_PATH_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND source = $2
    AND project_id IS NOT DISTINCT FROM $3 AND container_path = $4
  LIMIT 1`;

const LIST_PINNED_ASSETS_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND pinned IS TRUE
    AND project_id IS NOT DISTINCT FROM $2
    AND ${PG_ASSET_IS_LATEST_VERSION}
  ORDER BY created_at DESC
  LIMIT $3`;

const LIST_ASSET_VERSIONS_SQL = `${PG_PROJECT_ASSET_SELECT}
  WHERE user_id = $1 AND deleted_at IS NULL AND source = 'output'
    AND project_id IS NOT DISTINCT FROM $2 AND container_path = $3
  ORDER BY created_at DESC, id DESC
  LIMIT $4`;

const UNPIN_OLDER_OUTPUTS_SQL = `UPDATE project_assets
   SET pinned = FALSE, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE user_id = $1 AND deleted_at IS NULL AND source = 'output'
   AND project_id IS NOT DISTINCT FROM $2 AND container_path = $3 AND pinned IS TRUE`;

const INSERT_PROJECT_ASSET_SQL = `INSERT INTO project_assets (
   id, user_id, project_id, source, session_id, name, url, container_path,
   mime, size_bytes, digest, excerpt, pinned, created_at, updated_at, deleted_at
 ) VALUES (
   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
   GREATEST(LEAST(${CLOCK_MS_SQL}, $15::bigint), $14::bigint), GREATEST(${CLOCK_MS_SQL}, $14::bigint), NULL
 )`;

const DELETE_PROJECT_ASSET_SQL = `UPDATE project_assets
   SET deleted_at = ${CLOCK_MS_SQL},
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;

type PgProjectAssetRow = {
  id: string;
  project_id: string | null;
  source: string;
  session_id: string | null;
  name: string;
  url: string | null;
  container_path: string | null;
  mime: string | null;
  size_bytes: string | null;
  digest: string | null;
  excerpt: string | null;
  pinned: boolean | number | string;
  created_at: string;
  updated_at: string;
};

type PreparedAssetUpdate = {
  sets: string[];
  params: unknown[];
  nextParam: number;
  nextProjectId: { present: true; value: string | null } | undefined;
};

function mapPgProjectAssetRow(r: PgProjectAssetRow): ProjectAsset {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    source: r.source === "output" ? "output" : "upload",
    sessionId: r.session_id ?? null,
    name: r.name,
    url: r.url ?? null,
    containerPath: r.container_path ?? null,
    mime: r.mime ?? null,
    sizeBytes: r.size_bytes == null ? null : bigIntNum(r.size_bytes, "size_bytes"),
    digest: r.digest ?? null,
    excerpt: r.excerpt ?? null,
    pinned: r.pinned === true || r.pinned === 1 || r.pinned === "t",
    createdAt: bigIntNum(r.created_at, "created_at"),
    updatedAt: bigIntNum(r.updated_at, "updated_at"),
  };
}

async function readPgProjectAsset(
  queryable: QueryRunner,
  userId: string,
  id: string,
): Promise<ProjectAsset | null> {
  const row = (
    await queryable.query<PgProjectAssetRow>(READ_PROJECT_ASSET_SQL, [id, userId])
  ).rows[0];
  return row ? mapPgProjectAssetRow(row) : null;
}

async function pgOwnedChatProjectExists(
  queryable: QueryRunner,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const row = (
    await queryable.query(
      "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [projectId, userId],
    )
  ).rows[0];
  return !!row;
}

async function pgCountProjectAssets(
  queryable: QueryRunner,
  userId: string,
  projectId: string | null,
): Promise<number> {
  const row = (
    await queryable.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM project_assets
        WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT DISTINCT FROM $2`,
      [userId, projectId],
    )
  ).rows[0];
  return Number(row?.n ?? 0);
}

/** 同一项目里某个产出源路径的最新未删版本(无则 null)。 */
async function pgLatestOutputVersion(
  queryable: QueryRunner,
  userId: string,
  projectId: string | null,
  containerPath: string,
): Promise<ProjectAsset | null> {
  const row = (
    await queryable.query<PgProjectAssetRow>(LATEST_OUTPUT_VERSION_SQL, [
      userId,
      projectId,
      containerPath,
    ])
  ).rows[0];
  return row ? mapPgProjectAssetRow(row) : null;
}

/**
 * 去重规则与 SQLite 侧 _sqliteFindDuplicateAsset 同构:
 *   - 带字节副本的产出(output + containerPath + digest):先与该源路径的最新版本比,
 *     digest 相同 = 同一版本,不同 = 新版本(返回 null)。
 *     例外是重放:带 capturedAt(源文件 mtime)且不晚于最新版本的 created_at,而这个
 *     digest 已是某个旧版本 → 返回那个旧版本,不出新版本。
 *   - 其它(上传、旧容器只报路径的产出):同 digest,digest 空则同 container_path。
 */
async function pgFindDuplicateAsset(
  queryable: QueryRunner,
  userId: string,
  projectId: string | null,
  source: ParsedProjectAssetCreate["source"],
  digest: string | null,
  containerPath: string | null,
  capturedAt: number | null,
): Promise<ProjectAsset | null> {
  if (source === "output" && containerPath && digest) {
    const latest = await pgLatestOutputVersion(queryable, userId, projectId, containerPath);
    if (!latest) return null;
    if (latest.digest === digest) return latest;
    if (capturedAt !== null && capturedAt <= latest.createdAt) {
      const row = (
        await queryable.query<PgProjectAssetRow>(FIND_DUP_OUTPUT_REPLAY_SQL, [
          userId,
          projectId,
          containerPath,
          digest,
        ])
      ).rows[0];
      if (row) return mapPgProjectAssetRow(row);
    }
    return null;
  }
  if (digest) {
    const row = (
      await queryable.query<PgProjectAssetRow>(FIND_DUP_BY_DIGEST_SQL, [
        userId,
        source,
        projectId,
        digest,
      ])
    ).rows[0];
    return row ? mapPgProjectAssetRow(row) : null;
  }
  if (containerPath) {
    const row = (
      await queryable.query<PgProjectAssetRow>(FIND_DUP_BY_CONTAINER_PATH_SQL, [
        userId,
        source,
        projectId,
        containerPath,
      ])
    ).rows[0];
    return row ? mapPgProjectAssetRow(row) : null;
  }
  return null;
}

async function pgResolveAssetProjectId(
  queryable: QueryRunner,
  userId: string,
  parsed: ParsedProjectAssetCreate,
): Promise<{ ok: true; projectId: string | null } | { ok: false; error: "project_not_found" }> {
  let projectId = parsed.projectIdPresent ? parsed.projectId : null;
  if (!parsed.projectIdPresent && parsed.sessionId) {
    const sess = (
      await queryable.query<{ user_id: string; project_id: string | null }>(
        "SELECT user_id, project_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL",
        [parsed.sessionId],
      )
    ).rows[0];
    if (sess?.user_id === userId) projectId = sess.project_id ?? null;
  }
  if (projectId !== null && !(await pgOwnedChatProjectExists(queryable, userId, projectId))) {
    return { ok: false, error: "project_not_found" };
  }
  return { ok: true, projectId };
}

function buildListProjectAssetsSql(versionGroupSql: string): string {
  return `SELECT id, project_id, source, session_id, name, url, container_path, mime,
          size_bytes::text AS size_bytes, digest, excerpt, pinned,
          created_at::text AS created_at, updated_at::text AS updated_at,
          version_count::text AS version_count
     FROM (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY ${versionGroupSql}
                                 ORDER BY created_at DESC, id DESC) AS version_rank,
              COUNT(*) OVER (PARTITION BY ${versionGroupSql}) AS version_count
         FROM project_assets
        WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT DISTINCT FROM $2
     ) AS versioned
    WHERE version_rank = 1
    ORDER BY created_at DESC
    LIMIT $3`;
}

function buildSearchProjectAssetsSql(versionGroupSql: string, hasSource: boolean): string {
  const sourceFilter = hasSource ? " AND source = $4" : "";
  return `${PG_PROJECT_ASSET_SELECT}
    WHERE user_id = $1 AND deleted_at IS NULL
      AND id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id, ${versionGroupSql}
                                        ORDER BY created_at DESC, id DESC) AS version_rank
            FROM project_assets WHERE user_id = $1 AND deleted_at IS NULL
        ) AS versioned WHERE version_rank = 1
      )
      AND (name ILIKE $2 ESCAPE '\\' OR COALESCE(excerpt, '') ILIKE $2 ESCAPE '\\')${sourceFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT $3`;
}

function buildSearchChatProjectAssetsSql(versionGroupSql: string, hasSource: boolean): string {
  const sourceFilter = hasSource ? " AND source = $5" : "";
  return `SELECT id, project_id, source, session_id, name, url, container_path, mime,
          size_bytes::text AS size_bytes, digest, excerpt, pinned,
          created_at::text AS created_at, updated_at::text AS updated_at
     FROM (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY ${versionGroupSql}
                                 ORDER BY created_at DESC, id DESC) AS version_rank
         FROM project_assets
        WHERE user_id = $1 AND deleted_at IS NULL AND project_id = $2
     ) AS versioned
    WHERE version_rank = 1
      AND (name ILIKE $3 ESCAPE '\\' OR COALESCE(excerpt, '') ILIKE $3 ESCAPE '\\')${sourceFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT $4`;
}

function buildUpdateProjectAssetSql(
  sets: readonly string[],
  idParam: number,
  userParam: number,
): string {
  return `UPDATE project_assets SET ${sets.join(", ")}
    WHERE id = $${idParam} AND user_id = $${userParam} AND deleted_at IS NULL`;
}

async function listPinnedAssetsForProject(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  chatProjectId: string | null,
): Promise<ProjectAsset[]> {
  const rows = (
    await pool.query<PgProjectAssetRow>(LIST_PINNED_ASSETS_SQL, [
      userId,
      chatProjectId,
      deps.storage.PROJECT_ASSET_PINNED_INJECT_MAX,
    ])
  ).rows;
  return rows.map(mapPgProjectAssetRow);
}

async function listPinnedProjectAssetsForChatProjectImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  chatProjectId: string | null,
): Promise<PinnedAssetsPage> {
  const assets = await listPinnedAssetsForProject(pool, deps, userId, chatProjectId);
  return { assets, revision: deps.storage.assetsRevision(assets) };
}

async function listProjectAssetsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  opts: ListProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(deps.storage.PROJECT_ASSET_LIST_LIMIT_MAX, Math.floor(opts.limit))
      : deps.storage.PROJECT_ASSET_LIST_LIMIT_DEFAULT;
  // 产出物按源路径折叠成一条(最新版本)并带版本数;与 SQLite 同一分组键。
  const sql = buildListProjectAssetsSql(deps.storage.PROJECT_ASSET_VERSION_GROUP_SQL);
  const rows = (
    await pool.query<PgProjectAssetRow & { version_count: string }>(sql, [
      userId,
      opts.projectId,
      limit,
    ])
  ).rows;
  return rows.map((r) => deps.storage.withVersionCount(mapPgProjectAssetRow(r), Number(r.version_count)));
}

async function listProjectAssetVersionsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  assetId: string,
): Promise<ProjectAsset[] | null> {
  const asset = await readPgProjectAsset(pool, userId, assetId);
  if (!asset) return null;
  if (asset.source !== "output" || !asset.containerPath) return [asset];
  const rows = (
    await pool.query<PgProjectAssetRow>(LIST_ASSET_VERSIONS_SQL, [
      userId,
      asset.projectId,
      asset.containerPath,
      deps.storage.PROJECT_ASSET_PER_PROJECT_LIMIT,
    ])
  ).rows;
  return rows.map(mapPgProjectAssetRow);
}

async function searchProjectAssetsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  opts: SearchProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const q =
    typeof opts.q === "string"
      ? opts.q.trim().slice(0, deps.storage.PROJECT_ASSET_SEARCH_QUERY_MAX)
      : "";
  if (!q) return [];
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(deps.storage.PROJECT_ASSET_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
      : deps.storage.PROJECT_ASSET_SEARCH_LIMIT_DEFAULT;
  const like = `%${deps.storage.escapeLikePattern(q)}%`;
  const hasSource = opts.source === "upload" || opts.source === "output";
  const params: unknown[] = [userId, like, limit];
  if (hasSource) params.push(opts.source);
  // Outputs fold to their latest version (per project and source path), as in listProjectAssets.
  const sql = buildSearchProjectAssetsSql(deps.storage.PROJECT_ASSET_VERSION_GROUP_SQL, hasSource);
  const rows = (await pool.query<PgProjectAssetRow>(sql, params)).rows;
  return rows.map(mapPgProjectAssetRow);
}

async function inheritLatestOutputPin(
  client: PoolClient,
  userId: string,
  projectId: string | null,
  parsed: ParsedProjectAssetCreate,
): Promise<{ createdAtFloor: number; pinned: boolean }> {
  let createdAtFloor = 0;
  let pinned = parsed.pinned;
  if (parsed.source === "output" && parsed.containerPath) {
    const latest = await pgLatestOutputVersion(client, userId, projectId, parsed.containerPath);
    if (latest) {
      createdAtFloor = latest.createdAt + 1;
      pinned = pinned || latest.pinned;
      await client.query(UNPIN_OLDER_OUTPUTS_SQL, [userId, projectId, parsed.containerPath]);
    }
  }
  return { createdAtFloor, pinned };
}

async function runCreateProjectAssetTx(
  client: PoolClient,
  userId: string,
  id: string,
  parsed: ParsedProjectAssetCreate,
  deps: PgSessionsDeps,
): Promise<ProjectAssetCreateResult> {
  const resolved = await pgResolveAssetProjectId(client, userId, parsed);
  if (!resolved.ok) return resolved;
  const { projectId } = resolved;
  // 同一 (user_id, project_id) 桶的 去重+count+INSERT 必须串行:默认 READ COMMITTED
  // 下无行锁,并发事务都会读到 count<500 再各自写入 → 上限被突破;同一产出的两个
  // 新版本并发登记也会各自看不到对方。锁放在去重之前,与 SQLite 的单事务一致。
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || coalesce($2, '')))",
    [`oc_proj_asset:${userId}`, projectId],
  );
  const dup = await pgFindDuplicateAsset(
    client,
    userId,
    projectId,
    parsed.source,
    parsed.digest,
    parsed.containerPath,
    parsed.capturedAt,
  );
  if (dup) return { ok: true, asset: dup, created: false };
  if ((await pgCountProjectAssets(client, userId, projectId)) >= deps.storage.PROJECT_ASSET_PER_PROJECT_LIMIT) {
    return { ok: false, error: "limit_exceeded" };
  }
  // 同一源路径的版本按 created_at 排序,新版本严格晚于上一版(同毫秒也不并列)。
  // 「常用」只挂在最新版本上:新版本(登记或恢复)继承上一版的 pinned,旧版本一律取消。
  const { createdAtFloor, pinned } = await inheritLatestOutputPin(client, userId, projectId, parsed);
  // 只插索引行,绝不写/删磁盘文件(内容寻址,可能被其它消息/资产共用)。
  await client.query(INSERT_PROJECT_ASSET_SQL, [
    id,
    userId,
    projectId,
    parsed.source,
    parsed.sessionId,
    parsed.name,
    parsed.url,
    parsed.containerPath,
    parsed.mime,
    parsed.sizeBytes,
    parsed.digest,
    parsed.excerpt,
    pinned,
    createdAtFloor,
    parsed.source === "output" ? parsed.capturedAt : null,
  ]);
  const asset = await readPgProjectAsset(client, userId, id);
  if (!asset) throw new Error("project asset insert vanished");
  return { ok: true, asset, created: true };
}

async function createProjectAssetImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  input: ProjectAssetCreateInput,
): Promise<ProjectAssetCreateResult> {
  const parsed = deps.storage.parseProjectAssetCreateInput(input);
  if (!parsed.ok) return parsed;
  const id = randomUUID();
  return withTx(pool, (client) => runCreateProjectAssetTx(client, userId, id, parsed.value, deps));
}

function prepareUpdateProjectAsset(
  patch: ProjectAssetUpdateInput,
  deps: PgSessionsDeps,
): { ok: true; state: PreparedAssetUpdate } | ProjectAssetUpdateResult {
  const sets: string[] = [`updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})`];
  const params: unknown[] = [];
  let n = 1;
  let nextProjectId: { present: true; value: string | null } | undefined;
  if (patch.name !== undefined) {
    const name = deps.storage.parseProjectAssetName(patch.name);
    if (!name) return { ok: false, error: "invalid_name" };
    sets.push(`name = $${n++}`);
    params.push(name);
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== "boolean") return { ok: false, error: "invalid_name" };
    sets.push(`pinned = $${n++}`);
    params.push(patch.pinned);
  }
  if (patch.projectId !== undefined) {
    const parsed = deps.storage.parseProjectAssetProjectId(patch.projectId);
    if ("invalid" in parsed) return { ok: false, error: "project_not_found" };
    nextProjectId = { present: true, value: parsed.present ? parsed.value : null };
    sets.push(`project_id = $${n++}`);
    params.push(nextProjectId.value);
  }
  return { ok: true, state: { sets, params, nextParam: n, nextProjectId } };
}

async function runUpdateProjectAssetTx(
  client: PoolClient,
  userId: string,
  assetId: string,
  state: PreparedAssetUpdate,
  deps: PgSessionsDeps,
): Promise<ProjectAssetUpdateResult> {
  const existing = await readPgProjectAsset(client, userId, assetId);
  if (!existing) return { ok: false, error: "not_found" };
  if (state.nextProjectId) {
    if (
      state.nextProjectId.value !== null &&
      !(await pgOwnedChatProjectExists(client, userId, state.nextProjectId.value))
    ) {
      return { ok: false, error: "project_not_found" };
    }
    if (state.nextProjectId.value !== existing.projectId) {
      // 跨项目移动走同一份 500 上限;锁目标桶,键编码与 createProjectAsset 相同。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || coalesce($2, '')))",
        [`oc_proj_asset:${userId}`, state.nextProjectId.value],
      );
      if (
        (await pgCountProjectAssets(client, userId, state.nextProjectId.value)) >=
        deps.storage.PROJECT_ASSET_PER_PROJECT_LIMIT
      ) {
        return { ok: false, error: "limit_exceeded" };
      }
    }
  }
  const params = [...state.params, assetId, userId];
  const idParam = state.nextParam;
  const userParam = state.nextParam + 1;
  const sql = buildUpdateProjectAssetSql(state.sets, idParam, userParam);
  const res = await client.query(sql, params);
  if ((res.rowCount ?? 0) === 0) return { ok: false, error: "not_found" };
  const asset = await readPgProjectAsset(client, userId, assetId);
  if (!asset) return { ok: false, error: "not_found" };
  return { ok: true, asset };
}

async function updateProjectAssetImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  assetId: string,
  patch: ProjectAssetUpdateInput,
): Promise<ProjectAssetUpdateResult> {
  const prepared = prepareUpdateProjectAsset(patch, deps);
  if (!prepared.ok) return prepared;
  if ("asset" in prepared) return prepared;
  if (prepared.state.sets.length === 1) {
    const existing = await readPgProjectAsset(pool, userId, assetId);
    return existing ? { ok: true, asset: existing } : { ok: false, error: "not_found" };
  }
  return withTx(pool, (client) =>
    runUpdateProjectAssetTx(client, userId, assetId, prepared.state, deps),
  );
}

async function deleteProjectAssetImpl(
  pool: Pool,
  userId: string,
  assetId: string,
): Promise<ProjectAssetDeleteResult> {
  // 软删只标 deleted_at,绝不 unlink 磁盘文件。
  const res = await pool.query(DELETE_PROJECT_ASSET_SQL, [assetId, userId]);
  return (res.rowCount ?? 0) === 0 ? { ok: false, error: "not_found" } : { ok: true };
}

async function listPinnedProjectAssetsForSessionImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  sessionId: string,
): Promise<ProjectAsset[]> {
  const sess = (
    await pool.query<{ user_id: string; project_id: string | null }>(
      "SELECT user_id, project_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL",
      [sessionId],
    )
  ).rows[0];
  if (!sess) return [];
  return listPinnedAssetsForProject(pool, deps, sess.user_id, sess.project_id ?? null);
}

async function searchChatProjectAssetsImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  userId: string,
  chatProjectId: string,
  opts: SearchChatProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const norm = deps.storage.normalizeChatProjectAssetSearch(opts);
  if (!norm || !chatProjectId) return [];
  const params: unknown[] = [userId, chatProjectId, norm.like, norm.limit];
  if (norm.source) params.push(norm.source);
  // Same fold as listProjectAssets: only the latest version of an output is searched.
  const sql = buildSearchChatProjectAssetsSql(
    deps.storage.PROJECT_ASSET_VERSION_GROUP_SQL,
    !!norm.source,
  );
  const rows = (await pool.query<PgProjectAssetRow>(sql, params)).rows;
  return rows.map(mapPgProjectAssetRow);
}

export function createPgProjectAssetsStore(ctx: PgSessionsCtx) {
  const { pool, deps } = ctx;
  return {
    listPinnedProjectAssetsForChatProject: (userId: string, chatProjectId: string | null) =>
      listPinnedProjectAssetsForChatProjectImpl(pool, deps, userId, chatProjectId),
    listProjectAssets: (userId: string, opts: ListProjectAssetsOpts) =>
      listProjectAssetsImpl(pool, deps, userId, opts),
    listProjectAssetVersions: (userId: string, assetId: string) =>
      listProjectAssetVersionsImpl(pool, deps, userId, assetId),
    searchProjectAssets: (userId: string, opts: SearchProjectAssetsOpts) =>
      searchProjectAssetsImpl(pool, deps, userId, opts),
    createProjectAsset: (userId: string, input: ProjectAssetCreateInput) =>
      createProjectAssetImpl(pool, deps, userId, input),
    updateProjectAsset: (userId: string, assetId: string, patch: ProjectAssetUpdateInput) =>
      updateProjectAssetImpl(pool, deps, userId, assetId, patch),
    deleteProjectAsset: (userId: string, assetId: string) =>
      deleteProjectAssetImpl(pool, userId, assetId),
    listPinnedProjectAssetsForSession: (sessionId: string) =>
      listPinnedProjectAssetsForSessionImpl(pool, deps, sessionId),
    searchChatProjectAssets: (
      userId: string,
      chatProjectId: string,
      opts: SearchChatProjectAssetsOpts,
    ) => searchChatProjectAssetsImpl(pool, deps, userId, chatProjectId, opts),
  };
}
