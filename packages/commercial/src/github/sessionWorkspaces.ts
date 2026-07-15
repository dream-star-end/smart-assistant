/**
 * github_session_workspaces 数据访问 — 用户每个 session 选定的 GitHub repo+branch。
 *
 * status 状态机:
 *   pending → cloning → ready
 *   pending → cloning → failed
 *   * → cleared(用户主动取消 / GitHub link revoked)
 *
 * Phase 3 只走 master DB 落库,不涉及 master→container RPC(那是 Phase 4)。
 * PUT 创建/覆盖时 status 设为 'pending';DELETE 设为 'cleared';
 * Phase 4 容器 ack 后再 transition 到 cloning/ready/failed。
 *
 * selection_version 单调递增 — Phase 4 RPC 用它给容器做幂等去重;
 * 只在**行语义实际变化**时 bump(per Codex amendment),避免重复 PUT 同值刷版本号。
 */

import {
  classifyClientSessions,
  type ClientSessionLifecycle,
  type ClientSessionLifecycleRef,
} from '@openclaude/storage'
import type { Pool } from 'pg'

export type GithubSelectionStatus = 'pending' | 'cloning' | 'ready' | 'failed' | 'cleared'

export interface GithubSelectionRow {
  userId: number
  sessionId: string
  selectionVersion: number
  owner: string
  repo: string
  branch: string
  defaultBranch: string | null
  status: GithubSelectionStatus
  headSha: string | null
  errorCode: string | null
  errorMessage: string | null
  selectedAt: Date
  updatedAt: Date
}

interface RawRow {
  user_id: string
  session_id: string
  selection_version: string
  owner: string
  repo: string
  branch: string
  default_branch: string | null
  status: string
  head_sha: string | null
  error_code: string | null
  error_message: string | null
  selected_at: Date
  updated_at: Date
}

function rowToSelection(row: RawRow): GithubSelectionRow {
  return {
    userId: Number(row.user_id),
    sessionId: row.session_id,
    selectionVersion: Number(row.selection_version),
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    defaultBranch: row.default_branch,
    status: row.status as GithubSelectionStatus,
    headSha: row.head_sha,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    selectedAt: row.selected_at,
    updatedAt: row.updated_at,
  }
}

/** 读取单 session 的当前选择;不存在返 null。 */
export async function getSessionSelection(
  pool: Pool,
  userId: number,
  sessionId: string,
): Promise<GithubSelectionRow | null> {
  const res = await pool.query<RawRow>(
    `SELECT user_id::text AS user_id,
            session_id,
            selection_version::text AS selection_version,
            owner, repo, branch, default_branch,
            status, head_sha, error_code, error_message,
            selected_at, updated_at
       FROM github_session_workspaces
      WHERE user_id = $1 AND session_id = $2
      LIMIT 1`,
    [userId, sessionId],
  )
  if (res.rowCount === 0) return null
  return rowToSelection(res.rows[0]!)
}

/**
 * UPSERT 选择。语义:
 *
 *   1. 行不存在 → INSERT version=1, status='pending'
 *   2. (owner,repo,branch) 与现有不同 / 或现状是 cleared/failed → 视为"新选择",
 *      重置 status='pending',清 error 字段,bump version
 *   3. (owner,repo,branch) 与现有相同 且 现状 IN ('pending','cloning','ready') →
 *      noop:**不**重置 status,不 bump version,不改 head_sha
 *      (避免重复 PUT 把已 ready 的容器工作树打回 pending → 触发不必要的重 clone)
 *
 * 返回 UPSERT 后的整行(noop 情况返回现状)。
 */
export async function upsertSessionSelection(
  pool: Pool,
  args: {
    userId: number
    sessionId: string
    owner: string
    repo: string
    branch: string
    defaultBranch: string | null
    headSha: string | null
  },
): Promise<GithubSelectionRow> {
  const { userId, sessionId, owner, repo, branch, defaultBranch, headSha } = args
  // 表别名 'g' 让 ON CONFLICT 子句里的 CASE 短一些
  const res = await pool.query<RawRow>(
    `INSERT INTO github_session_workspaces AS g
       (user_id, session_id, selection_version, owner, repo, branch,
        default_branch, status, head_sha, error_code, error_message,
        selected_at, updated_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, 'pending', $7, NULL, NULL, now(), now())
     ON CONFLICT (user_id, session_id) DO UPDATE SET
       -- 共用条件:语义变化 = (owner/repo/branch 变化) OR 现状是 cleared/failed
       owner             = EXCLUDED.owner,
       repo              = EXCLUDED.repo,
       branch            = EXCLUDED.branch,
       -- default_branch 跟随实际(GitHub 可能改默认分支),但 status/version 不动 if noop
       default_branch    = EXCLUDED.default_branch,
       status = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN 'pending'
         ELSE g.status
       END,
       head_sha = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN EXCLUDED.head_sha
         ELSE g.head_sha
       END,
       error_code = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN NULL
         ELSE g.error_code
       END,
       error_message = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN NULL
         ELSE g.error_message
       END,
       selected_at = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN now()
         ELSE g.selected_at
       END,
       updated_at = now(),
       selection_version = CASE
         WHEN g.owner  IS DISTINCT FROM EXCLUDED.owner
           OR g.repo   IS DISTINCT FROM EXCLUDED.repo
           OR g.branch IS DISTINCT FROM EXCLUDED.branch
           OR g.status IN ('cleared','failed')
         THEN g.selection_version + 1
         ELSE g.selection_version
       END
     RETURNING user_id::text AS user_id,
               session_id,
               selection_version::text AS selection_version,
               owner, repo, branch, default_branch,
               status, head_sha, error_code, error_message,
               selected_at, updated_at`,
    [userId, sessionId, owner, repo, branch, defaultBranch, headSha],
  )
  return rowToSelection(res.rows[0]!)
}

/**
 * 用户主动 DELETE 单 session 选择。行不存在 → 幂等 noop(返 null)。
 *
 * 只在行语义实际变化时 bump version + UPDATE 时间戳。"语义变化" =
 *   - status <> 'cleared',或
 *   - 已是 cleared 但残留 error_code / error_message(对称性 — 否则 GET 还能看到 stale last_error_*)
 * 后两种情况是"用户主动清错误状态"语义,需要把错误字段归零。
 */
export async function clearSessionSelection(
  pool: Pool,
  userId: number,
  sessionId: string,
): Promise<GithubSelectionRow | null> {
  const res = await pool.query<RawRow>(
    `UPDATE github_session_workspaces
        SET status            = 'cleared',
            error_code        = NULL,
            error_message     = NULL,
            selection_version = selection_version + 1,
            updated_at        = now()
      WHERE user_id = $1 AND session_id = $2
        AND (status <> 'cleared'
             OR error_code IS NOT NULL
             OR error_message IS NOT NULL)
      RETURNING user_id::text AS user_id,
                session_id,
                selection_version::text AS selection_version,
                owner, repo, branch, default_branch,
                status, head_sha, error_code, error_message,
                selected_at, updated_at`,
    [userId, sessionId],
  )
  if (res.rowCount === 0) return null
  return rowToSelection(res.rows[0]!)
}

/**
 * Phase 4 — bridge `containerWs.on('open')` 时调,拉该 user 当前所有"活跃"
 * (status IN ('pending','cloning','ready'))selection,用于 hello-triggered auto-rebind。
 *
 * 'failed' / 'cleared' 不 rebind:
 *   - 'failed' 是终态错误(token 失效 / 仓库不存在等),要等用户主动重 PUT
 *   - 'cleared' 是用户主动 DELETE 或 link 被 revoke,无需也不应再 push
 *
 * 返回顺序:updated_at ASC(老的先 push,符合用户预期"先选的先就绪")。
 */
export async function listActiveGithubWorkspaceSelections(
  pool: Pool,
  userId: number,
): Promise<GithubSelectionRow[]> {
  const res = await pool.query<RawRow>(
    `SELECT user_id::text AS user_id,
            session_id,
            selection_version::text AS selection_version,
            owner, repo, branch, default_branch,
            status, head_sha, error_code, error_message,
            selected_at, updated_at
       FROM github_session_workspaces
      WHERE user_id = $1
        AND status IN ('pending','cloning','ready')
      ORDER BY updated_at ASC`,
    [userId],
  )
  return res.rows.map(rowToSelection)
}

/**
 * Phase 4 — 容器 outbound.control.session_repo_status 帧 ack 时,把对应行 UPDATE
 * 为新 status。
 *
 * **stale ack 防护**:WHERE 同时锁 selection_version 必须等于 ack 携带的 version,
 * 任何已被 PUT 推到更高 version 的行都不会被 stale ack 覆盖回旧状态。
 *
 * **'cleared' 锁定**:WHERE status <> 'cleared' 防止 cleared 终态被 ack 拉回 ready/failed。
 * 用户已 DELETE 或 link revoked 后,容器即使把旧 clone 跑完了也不能复活该选择。
 *
 * 返回 { updated: true } 当行被 UPDATE,false 当被 stale 防护过滤。caller(bridge)
 * 据此决定是否继续透传 status 帧给 userWs(stale 也透传,前端日志能看到容器在干什么)。
 */
export async function updateGithubWorkspaceStatusIfVersion(
  pool: Pool,
  args: {
    userId: number
    sessionId: string
    selectionVersion: number
    status: 'cloning' | 'ready' | 'failed'
    headSha?: string | null
    errorCode?: string | null
    errorMessage?: string | null
  },
): Promise<{ updated: boolean }> {
  const { userId, sessionId, selectionVersion, status, headSha, errorCode, errorMessage } = args
  // head_sha 用 COALESCE:caller 不提供时保留原值(只有 ready/failed 才会带 sha,
  // cloning 中间态 sha 仍未知)。error_code / error_message:caller 显式传 null 即清空,
  // 不传则保留(用 undefined→null 区分"清空" vs "保持")。
  const res = await pool.query(
    `UPDATE github_session_workspaces
        SET status        = $4,
            head_sha      = COALESCE($5, head_sha),
            error_code    = $6,
            error_message = $7,
            updated_at    = now()
      WHERE user_id           = $1
        AND session_id        = $2
        AND selection_version = $3
        AND status            <> 'cleared'`,
    [
      userId,
      sessionId,
      selectionVersion,
      status,
      headSha ?? null,
      errorCode ?? null,
      errorMessage ?? null,
    ],
  )
  return { updated: (res.rowCount ?? 0) > 0 }
}

/**
 * GitHub link revoke 时调用 — 把该 user 全部非 cleared 行设为 cleared,bump version,
 * 写一致的 error_code(默认 'link_revoked')。返回受影响行数。
 *
 * Codex amendment: 只对**语义会变化**的行做 UPDATE,避免重复 revoke 空转 version。
 * 语义变化 = status<>'cleared' OR error_code 不一致 OR error_message 残留(SET 写 NULL,
 * 历史行可能带值)。三个条件取并集,保证 UPDATE 后 (status,error_code,error_message)
 * 统一收敛到 ('cleared',$errorCode,NULL)。
 */
export async function clearAllSessionSelections(
  pool: Pool,
  userId: number,
  errorCode: string,
): Promise<number> {
  const res = await pool.query(
    `UPDATE github_session_workspaces
        SET status            = 'cleared',
            error_code        = $2,
            error_message     = NULL,
            selection_version = selection_version + 1,
            updated_at        = now()
      WHERE user_id = $1
        AND (status <> 'cleared'
             OR error_code IS DISTINCT FROM $2
             OR error_message IS NOT NULL)`,
    [userId, errorCode],
  )
  return res.rowCount ?? 0
}

export interface GithubWorkspaceSweeperHandle {
  stop(): void
  runNow(): Promise<{ timedOut: number; orphaned: number }>
}

/** Fail bounded clone attempts and clear selections whose master session was
 * explicitly deleted. A selection may legitimately be created before the
 * session row is materialized, so a merely missing row is not deletion proof.
 * error_message is always erased; only stable error_code stays. */
export function startGithubWorkspaceSweeper(
  pool: Pool,
  intervalMs = 5 * 60_000,
  classify: (
    refs: readonly ClientSessionLifecycleRef[],
  ) => Promise<ClientSessionLifecycle[]> = classifyClientSessions,
): GithubWorkspaceSweeperHandle {
  let stopped = false
  let cursor: { updatedAt: Date; userId: string; sessionId: string } | null = null
  const runNow = async () => {
    const timedOut = await pool.query(
      `UPDATE github_session_workspaces
          SET status='failed', error_code='workspace_timeout', error_message=NULL, updated_at=NOW()
        WHERE status IN ('pending','cloning') AND updated_at < NOW()-interval '30 minutes'`,
    )
    const candidates = await pool.query<{ session_id: string; user_id: string; updated_at: Date }>(
      `SELECT session_id,user_id::text AS user_id,updated_at
         FROM github_session_workspaces
        WHERE status<>'cleared'
          AND ($1::timestamptz IS NULL
               OR (updated_at,user_id,session_id) > ($1::timestamptz,$2::bigint,$3::text))
        ORDER BY updated_at ASC,user_id ASC,session_id ASC
        LIMIT 500`,
      [cursor?.updatedAt.toISOString() ?? null, cursor?.userId ?? '0', cursor?.sessionId ?? ''],
    )
    if (candidates.rows.length === 500) {
      const last = candidates.rows[candidates.rows.length - 1]!
      cursor = { updatedAt: last.updated_at, userId: last.user_id, sessionId: last.session_id }
    } else {
      // End of keyspace: the next tick starts a fresh bounded cycle so rows
      // created/updated behind the prior cursor are not skipped forever.
      cursor = null
    }
    const lifecycleRefs = candidates.rows.map((row) => ({
      sessionId: row.session_id,
      // client_sessions is a shared storage namespace. Commercial users are
      // stored as c:<uid>; github_session_workspaces intentionally keeps the
      // numeric uid, so translate only at the lifecycle boundary.
      userId: `c:${row.user_id}`,
    }))
    const lifecycles = await classify(lifecycleRefs)
    const deletedKeys = new Set(
      lifecycles
        .filter((row) => row.state === 'deleted')
        .map((row) => `${row.userId}\0${row.sessionId}`),
    )
    const deleted = candidates.rows.filter((row) =>
      deletedKeys.has(`c:${row.user_id}\0${row.session_id}`))
    let orphaned = 0
    if (deleted.length > 0) {
      const cleared = await pool.query(
        `UPDATE github_session_workspaces g
            SET status='cleared', error_code='session_deleted', error_message=NULL,
                selection_version=selection_version+1, updated_at=NOW()
           FROM unnest($1::text[], $2::bigint[]) AS dead(session_id,user_id)
          WHERE g.session_id=dead.session_id AND g.user_id=dead.user_id
            AND g.status<>'cleared'`,
        [deleted.map((row) => row.session_id), deleted.map((row) => row.user_id)],
      )
      orphaned = cleared.rowCount ?? 0
    }
    return { timedOut: timedOut.rowCount ?? 0, orphaned }
  }
  const timer = setInterval(() => {
    if (!stopped) void runNow().catch(() => {})
  }, Math.max(60_000, intervalMs))
  timer.unref?.()
  return {
    stop() { stopped = true; clearInterval(timer) },
    runNow,
  }
}
