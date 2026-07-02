/**
 * GitHub REST API endpoints — `/api/me/github*` + `/api/me/sessions/:sid/github-selection`。
 *
 * 7 个 handlers:
 *   GET    /api/me/github                                       — link 元信息
 *   DELETE /api/me/github                                       — 撤销链接 + 级联清 sessions
 *   GET    /api/me/github/repos?...                             — 列 user repos(代理 GitHub)
 *   GET    /api/me/github/repos/:owner/:repo/branches?...       — 列 repo branches
 *   GET    /api/me/sessions/:sid/github-selection               — 读 session 选择
 *   PUT    /api/me/sessions/:sid/github-selection               — 设 session 选择(先验权限再落库)
 *   DELETE /api/me/sessions/:sid/github-selection               — 清 session 选择
 *
 * 测试可注入 deps overrides(fetchImpl + poolFactory)避免真 DB / 真 GitHub 调用。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import {
  GithubApiError,
  fetchGithubBranch,
  fetchGithubBranches,
  fetchGithubRepoMeta,
  fetchGithubRepos,
  type GithubApiDeps,
  type ListBranchesParams,
  type ListReposParams,
} from '../github/api.js'
import {
  clearSessionSelection,
  getSessionSelection,
  upsertSessionSelection,
} from '../github/sessionWorkspaces.js'
import {
  getGithubLinkPublic,
  getGithubLinkWithToken,
  revokeGithubLinkAndClearSessions,
  touchTokenChecked,
} from '../github/tokenStore.js'
import { getPool } from '../db/index.js'
import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

// ─── test overrides ───────────────────────────────────────────────────

export interface GithubApiHandlerOverrides {
  poolFactory?: () => Pool
  githubFetch?: typeof fetch
}

function resolveDeps(overrides?: GithubApiHandlerOverrides): {
  pool: Pool
  apiDeps: GithubApiDeps
} {
  return {
    pool: overrides?.poolFactory ? overrides.poolFactory() : getPool(),
    apiDeps: { fetchImpl: overrides?.githubFetch ?? fetch },
  }
}

// ─── 校验 helpers ──────────────────────────────────────────────────────

const OWNER_RE = /^[A-Za-z0-9._-]+$/
const REPO_RE = /^[A-Za-z0-9._-]+$/
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const SORT_VALUES = new Set(['created', 'updated', 'pushed', 'full_name'])

function parsePositiveInt(raw: string | null, def: number, max: number): number {
  if (raw === null || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, 'INVALID_QUERY', `value out of range [1,${max}]`)
  }
  return n
}

function validateOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_RE.test(owner) || owner.length > 39) {
    throw new HttpError(400, 'INVALID_OWNER', 'invalid owner format')
  }
  if (!REPO_RE.test(repo) || repo.length > 100) {
    throw new HttpError(400, 'INVALID_REPO', 'invalid repo format')
  }
}

function validateBranch(branch: string): void {
  // GitHub branch 命名比 owner/repo 宽松(允许 / .),但仍限长度 + 排除控制字符
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 250) {
    throw new HttpError(400, 'INVALID_BRANCH', 'invalid branch format')
  }
  // 排除明显非法字符(空白、控制字符)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(branch)) {
    throw new HttpError(400, 'INVALID_BRANCH', 'invalid branch format')
  }
}

function validateSessionId(sid: string): void {
  if (!SESSION_ID_RE.test(sid)) {
    throw new HttpError(400, 'INVALID_SESSION_ID', 'invalid session_id format')
  }
}

/** GitHub upstream error → HttpError(也含 token revoke 副作用) */
async function mapGithubErrToHttp(
  err: unknown,
  pool: Pool,
  userId: number,
  ctx: RequestContext,
): Promise<HttpError> {
  if (err instanceof GithubApiError) {
    if (err.code === 'token_invalid') {
      // 副作用:token 失效 → revoke link + 级联清 sessions(原子事务)
      //
      // 如果级联 revoke 自身失败(DB 挂 / 锁等),不能吞错继续返 401 GITHUB_TOKEN_INVALID:
      //   - 前端会以为 link 已被清,提示"请重新关联 GitHub"
      //   - 实际 DB 里 link 仍 active,下次调用会再走一次 GitHub→401→revoke 循环
      //   - 系统延迟自愈(下一次调用 + DB 恢复后)但用户体验是"我点了关联结果还是显示已关联"
      // 返回 503 HttpError(由 caller throw):让前端识别为"系统暂时性故障",
      // 触发 retry 而不是误导式"请重连"。
      try {
        await revokeGithubLinkAndClearSessions(pool, userId, 'link_revoked')
        ctx.log.warn('github_token_invalid_auto_revoked', { sub: userId })
      } catch (subErr) {
        ctx.log.error('github_token_invalid_revoke_failed', {
          sub: userId,
          err: subErr instanceof Error ? subErr.message : String(subErr),
        })
        return new HttpError(
          503,
          'GITHUB_TOKEN_REVOKE_FAILED',
          'GitHub token invalid but cleanup failed; please retry',
          { extraHeaders: { 'Retry-After': '5' } },
        )
      }
      return new HttpError(401, 'GITHUB_TOKEN_INVALID', 'GitHub token invalid; please relink')
    }
    if (err.code === 'not_found') {
      return new HttpError(404, 'GITHUB_NOT_FOUND', 'resource not found')
    }
    if (err.code === 'upstream_forbidden') {
      return new HttpError(403, 'GITHUB_UPSTREAM_FORBIDDEN', 'github denied (rate-limit / SSO?)')
    }
    if (err.code === 'upstream_invalid') {
      return new HttpError(422, 'GITHUB_UPSTREAM_INVALID', 'github rejected request')
    }
    if (err.code === 'network') {
      return new HttpError(502, 'GITHUB_NETWORK', 'github network error')
    }
    return new HttpError(502, 'GITHUB_UPSTREAM', `github upstream ${err.httpStatus ?? '?'}`)
  }
  return new HttpError(500, 'INTERNAL', 'github call failed')
}

/** 获取 user 的活跃 token + login,无 → throw 401。GitHub call 后 touchTokenChecked。 */
async function loadUserToken(
  pool: Pool,
  userId: number,
): Promise<{ accessToken: string; login: string }> {
  const link = await getGithubLinkWithToken(pool, userId)
  if (!link) {
    throw new HttpError(401, 'GITHUB_NOT_LINKED', 'no active GitHub link')
  }
  return { accessToken: link.accessToken, login: link.login }
}

// ─── handlers ──────────────────────────────────────────────────────────

/** GET /api/me/github */
export async function handleGetMyGithub(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const { pool } = resolveDeps(overrides)
  const info = await getGithubLinkPublic(pool, Number(user.id))
  sendJson(res, 200, info)
}

/** DELETE /api/me/github */
export async function handleDeleteMyGithub(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const { pool } = resolveDeps(overrides)
  const { sessionsCleared } = await revokeGithubLinkAndClearSessions(
    pool,
    Number(user.id),
    'user_revoked',
  )
  ctx.log.info('github_link_revoked', { sub: user.id, sessionsCleared })
  sendJson(res, 200, { revoked: true, sessionsCleared })
}

// repos 列表 60s TTL 缓存:GitHub API 经出站代理往返实测 3-6s(现网慢请求 top1),
// 而仓库列表是低频变更数据(新建仓库最迟 1min 可见,重开弹窗即刷新)。仅缓存成功结果;
// 测试注入 overrides 时跳过(不破坏用例隔离)。size 防御性 clear(键空间=用户×分页参数)。
const REPOS_CACHE_TTL_MS = 60_000
const reposCache = new Map<string, { items: unknown; exp: number }>()

/** GET /api/me/github/repos */
export async function handleListMyGithubRepos(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const { pool, apiDeps } = resolveDeps(overrides)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const page = parsePositiveInt(url.searchParams.get('page'), 1, 100)
  const perPage = parsePositiveInt(url.searchParams.get('per_page'), 30, 100)
  const sortRaw = url.searchParams.get('sort') ?? 'updated'
  if (!SORT_VALUES.has(sortRaw)) {
    throw new HttpError(400, 'INVALID_SORT', `sort must be one of ${[...SORT_VALUES].join(',')}`)
  }
  const scopeRaw = url.searchParams.get('type') ?? 'all'
  if (scopeRaw !== 'owner' && scopeRaw !== 'all') {
    throw new HttpError(400, 'INVALID_TYPE', "type must be 'owner' or 'all'")
  }
  const params: ListReposParams = {
    scope: scopeRaw,
    page,
    perPage,
    sort: sortRaw as ListReposParams['sort'],
  }
  const cacheable = !overrides
  const cacheKey = `${user.id}:${scopeRaw}:${page}:${perPage}:${sortRaw}`
  if (cacheable) {
    const hit = reposCache.get(cacheKey)
    if (hit && hit.exp > Date.now()) {
      sendJson(res, 200, { items: hit.items, page, per_page: perPage })
      return
    }
  }
  const { accessToken } = await loadUserToken(pool, Number(user.id))
  let repos
  try {
    repos = await fetchGithubRepos(accessToken, params, apiDeps)
  } catch (err) {
    throw await mapGithubErrToHttp(err, pool, Number(user.id), ctx)
  }
  if (cacheable) {
    if (reposCache.size > 2000) reposCache.clear()
    reposCache.set(cacheKey, { items: repos, exp: Date.now() + REPOS_CACHE_TTL_MS })
  }
  // 成功 → mark token healthy(best-effort)
  touchTokenChecked(pool, Number(user.id)).catch(() => {})
  sendJson(res, 200, { items: repos, page, per_page: perPage })
}

/** GET /api/me/github/repos/:owner/:repo/branches */
export async function handleListMyGithubBranches(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const { pool, apiDeps } = resolveDeps(overrides)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  // Path: /api/me/github/repos/:owner/:repo/branches
  const m = url.pathname.match(/^\/api\/me\/github\/repos\/([^/]+)\/([^/]+)\/branches$/)
  if (!m) {
    throw new HttpError(404, 'NOT_FOUND', 'endpoint not found')
  }
  const owner = decodeURIComponent(m[1] ?? '')
  const repo = decodeURIComponent(m[2] ?? '')
  validateOwnerRepo(owner, repo)
  const page = parsePositiveInt(url.searchParams.get('page'), 1, 100)
  const perPage = parsePositiveInt(url.searchParams.get('per_page'), 30, 100)
  const params: ListBranchesParams = { page, perPage }
  const { accessToken } = await loadUserToken(pool, Number(user.id))
  let branches
  try {
    branches = await fetchGithubBranches(accessToken, owner, repo, params, apiDeps)
  } catch (err) {
    throw await mapGithubErrToHttp(err, pool, Number(user.id), ctx)
  }
  touchTokenChecked(pool, Number(user.id)).catch(() => {})
  sendJson(res, 200, { items: branches, page, per_page: perPage })
}

/** Path 解析:/api/me/sessions/:sid/github-selection */
function parseSessionSelectionPath(rawPath: string): { sid: string } | null {
  const m = rawPath.match(/^\/api\/me\/sessions\/([^/]+)\/github-selection$/)
  if (!m) return null
  return { sid: m[1] ?? '' }
}

/** GET /api/me/sessions/:sid/github-selection */
export async function handleGetSessionGithubSelection(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const parsed = parseSessionSelectionPath(url.pathname)
  if (!parsed) throw new HttpError(404, 'NOT_FOUND', 'endpoint not found')
  validateSessionId(parsed.sid)
  const { pool } = resolveDeps(overrides)
  const row = await getSessionSelection(pool, Number(user.id), parsed.sid)
  if (!row) {
    sendJson(res, 200, { selected: false })
    return
  }
  if (row.status === 'cleared') {
    // 内部已清除,但保留行作审计 — 对外仍当作 selected:false(且带 last_error 用于前端 toast)
    sendJson(res, 200, {
      selected: false,
      last_error_code: row.errorCode,
      last_error_message: row.errorMessage,
    })
    return
  }
  sendJson(res, 200, {
    selected: true,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    default_branch: row.defaultBranch,
    status: row.status,
    head_sha: row.headSha,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    selection_version: row.selectionVersion,
  })
}

/** PUT /api/me/sessions/:sid/github-selection */
export async function handlePutSessionGithubSelection(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const parsed = parseSessionSelectionPath(url.pathname)
  if (!parsed) throw new HttpError(404, 'NOT_FOUND', 'endpoint not found')
  validateSessionId(parsed.sid)

  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'body must be JSON object')
  }
  const b = body as Record<string, unknown>
  const owner = typeof b.owner === 'string' ? b.owner : ''
  const repo = typeof b.repo === 'string' ? b.repo : ''
  const branch = typeof b.branch === 'string' ? b.branch : ''
  validateOwnerRepo(owner, repo)
  validateBranch(branch)

  const { pool, apiDeps } = resolveDeps(overrides)
  const { accessToken } = await loadUserToken(pool, Number(user.id))

  // 1) 拉 repo meta — 验存在 + push 权限 + default_branch
  let repoMeta
  try {
    repoMeta = await fetchGithubRepoMeta(accessToken, owner, repo, apiDeps)
  } catch (err) {
    if (err instanceof GithubApiError && err.code === 'not_found') {
      throw new HttpError(404, 'GITHUB_REPO_NOT_FOUND', `repo ${owner}/${repo} not found`)
    }
    throw await mapGithubErrToHttp(err, pool, Number(user.id), ctx)
  }
  if (!repoMeta.permissions || repoMeta.permissions.push !== true) {
    throw new HttpError(
      403,
      'GITHUB_REPO_NO_WRITE',
      'no push permission on this repo (need write access)',
    )
  }

  // 2) 拉 branch meta — 验存在 + 拿 head sha
  let branchMeta
  try {
    branchMeta = await fetchGithubBranch(accessToken, owner, repo, branch, apiDeps)
  } catch (err) {
    if (err instanceof GithubApiError && err.code === 'not_found') {
      throw new HttpError(
        404,
        'GITHUB_BRANCH_NOT_FOUND',
        `branch ${branch} not found in ${owner}/${repo}`,
      )
    }
    throw await mapGithubErrToHttp(err, pool, Number(user.id), ctx)
  }

  // 3) 落库
  const row = await upsertSessionSelection(pool, {
    userId: Number(user.id),
    sessionId: parsed.sid,
    owner,
    repo,
    branch,
    defaultBranch: repoMeta.default_branch,
    headSha: branchMeta.commit.sha || null,
  })
  touchTokenChecked(pool, Number(user.id)).catch(() => {})
  ctx.log.info('github_selection_set', {
    sub: user.id,
    sid: parsed.sid,
    owner,
    repo,
    branch,
    version: row.selectionVersion,
    status: row.status,
  })
  sendJson(res, 200, {
    selected: true,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    default_branch: row.defaultBranch,
    status: row.status,
    head_sha: row.headSha,
    selection_version: row.selectionVersion,
  })
}

/** DELETE /api/me/sessions/:sid/github-selection */
export async function handleDeleteSessionGithubSelection(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides?: GithubApiHandlerOverrides,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const parsed = parseSessionSelectionPath(url.pathname)
  if (!parsed) throw new HttpError(404, 'NOT_FOUND', 'endpoint not found')
  validateSessionId(parsed.sid)
  const { pool } = resolveDeps(overrides)
  const cleared = await clearSessionSelection(pool, Number(user.id), parsed.sid)
  if (cleared) {
    ctx.log.info('github_selection_cleared', {
      sub: user.id,
      sid: parsed.sid,
      version: cleared.selectionVersion,
    })
  }
  sendJson(res, 200, { cleared: true })
}
