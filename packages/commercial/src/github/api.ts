/**
 * GitHub REST API 客户端 helpers — 用 user 自己的 access_token 调 GitHub。
 *
 * 设计约束:
 *   - 所有调用统一注入 Bearer Authorization + UA `OpenClaude/v3` + Accept `application/vnd.github+json`
 *   - 8 秒超时(AbortSignal.timeout),与 OAuth exchange 对齐
 *   - 错误分桶:
 *       401 → GithubApiError(code='token_invalid')(token 失效 / 撤销)— 调用方负责级联 revoke
 *       404 → GithubApiError(code='not_found')(repo / branch / user 不存在)
 *       403 → GithubApiError(code='upstream_forbidden')(rate-limit / SSO 阻拦,不等价 no-write)
 *       422 → GithubApiError(code='upstream_invalid')(参数互斥等)
 *       其它 → GithubApiError(code='upstream')(原始 status 透传 detail)
 *       网络错 → GithubApiError(code='network')
 *   - 不在这里做 token revocation 副作用 — 那是上层 handler 的责任(因为需要 pool 句柄)
 *   - fetchImpl 注入便于单测
 */

import {
  REQUIRED_GITHUB_HEADERS,
  // 故意不从这里导出真 fetch 实例 — 单测注入 fetchImpl
} from './apiConsts.js'

const FETCH_TIMEOUT_MS = 8000

/** GitHub `/repos/:owner/:repo` 精简返回 */
export interface GithubRepoMeta {
  id: number
  name: string
  full_name: string
  owner: { login: string; avatar_url: string | null }
  private: boolean
  default_branch: string
  description: string | null
  language: string | null
  stargazers_count: number
  updated_at: string | null
  html_url: string
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean }
}

export interface GithubRepoListItem {
  id: number
  name: string
  full_name: string
  owner: { login: string; avatar_url: string | null }
  private: boolean
  default_branch: string
  description: string | null
  language: string | null
  stargazers_count: number
  updated_at: string | null
  html_url: string
}

export interface GithubBranchMeta {
  name: string
  commit: { sha: string }
  protected: boolean
}

export class GithubApiError extends Error {
  constructor(
    public readonly code:
      | 'token_invalid'
      | 'not_found'
      | 'upstream_forbidden'
      | 'upstream_invalid'
      | 'upstream'
      | 'network',
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'GithubApiError'
  }
}

export interface GithubApiDeps {
  fetchImpl?: typeof fetch
}

/** 构建 Authorization + UA + Accept 头 */
function buildHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: REQUIRED_GITHUB_HEADERS.accept,
    'User-Agent': REQUIRED_GITHUB_HEADERS.userAgent,
    'X-GitHub-Api-Version': REQUIRED_GITHUB_HEADERS.apiVersion,
  }
}

/** 把 fetch Response 状态码 map 到 GithubApiError code */
function classifyStatus(status: number): GithubApiError['code'] | null {
  if (status >= 200 && status < 300) return null
  if (status === 401) return 'token_invalid'
  if (status === 403) return 'upstream_forbidden'
  if (status === 404) return 'not_found'
  if (status === 422) return 'upstream_invalid'
  return 'upstream'
}

async function callGithub(
  url: string,
  accessToken: string,
  deps?: GithubApiDeps,
): Promise<unknown> {
  const fetchImpl = deps?.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: buildHeaders(accessToken),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new GithubApiError('network', `github fetch error: ${(err as Error).message}`)
  }
  const code = classifyStatus(res.status)
  if (code !== null) {
    throw new GithubApiError(code, `github ${url} returned ${res.status}`, res.status)
  }
  try {
    return (await res.json()) as unknown
  } catch {
    throw new GithubApiError('upstream', `github ${url} returned non-JSON body`, res.status)
  }
}

// ─── /user/repos ──────────────────────────────────────────────────────

export interface ListReposParams {
  /**
   * 业务语义:'owner' = 仅本人为 owner 的 repo;'all' = owner + collaborator + org member 全部。
   * GitHub `/user/repos` 不接受 type=all + affiliation 同传(422),所以 'all' 时只用
   * affiliation,不传 type;'owner' 时传 type=owner,不传 affiliation。
   */
  scope: 'owner' | 'all'
  page: number
  perPage: number
  sort: 'created' | 'updated' | 'pushed' | 'full_name'
}

const REPO_SHAPE_KEYS = [
  'id',
  'name',
  'full_name',
  'private',
  'default_branch',
  'description',
  'language',
  'stargazers_count',
  'updated_at',
  'html_url',
] as const

function pickRepoListItem(raw: unknown): GithubRepoListItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'number' || typeof r.name !== 'string') return null
  const owner = r.owner as Record<string, unknown> | null
  return {
    id: r.id,
    name: r.name,
    full_name: typeof r.full_name === 'string' ? r.full_name : `${r.name}`,
    owner: {
      login: typeof owner?.login === 'string' ? owner.login : '',
      avatar_url: typeof owner?.avatar_url === 'string' ? owner.avatar_url : null,
    },
    private: r.private === true,
    default_branch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    description: typeof r.description === 'string' ? r.description : null,
    language: typeof r.language === 'string' ? r.language : null,
    stargazers_count: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    html_url: typeof r.html_url === 'string' ? r.html_url : '',
  }
}
// keep REPO_SHAPE_KEYS referenced (for future shape validation / typed assertion)
void REPO_SHAPE_KEYS

export async function fetchGithubRepos(
  accessToken: string,
  params: ListReposParams,
  deps?: GithubApiDeps,
): Promise<GithubRepoListItem[]> {
  const u = new URL('https://api.github.com/user/repos')
  if (params.scope === 'owner') {
    u.searchParams.set('type', 'owner')
  } else {
    // 'all' — 不要传 type=all,与 affiliation 互斥(GitHub 422)
    u.searchParams.set('affiliation', 'owner,collaborator,organization_member')
  }
  u.searchParams.set('sort', params.sort)
  u.searchParams.set('per_page', String(params.perPage))
  u.searchParams.set('page', String(params.page))

  const json = await callGithub(u.toString(), accessToken, deps)
  if (!Array.isArray(json)) {
    throw new GithubApiError('upstream', '/user/repos did not return array')
  }
  const out: GithubRepoListItem[] = []
  for (const item of json) {
    const picked = pickRepoListItem(item)
    if (picked) out.push(picked)
  }
  return out
}

// ─── /repos/:owner/:repo ───────────────────────────────────────────────

function parseRepoMeta(raw: unknown): GithubRepoMeta {
  if (!raw || typeof raw !== 'object') {
    throw new GithubApiError('upstream', '/repos/:owner/:repo did not return object')
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'number' || typeof r.name !== 'string') {
    throw new GithubApiError('upstream', '/repos response missing id/name')
  }
  const owner = r.owner as Record<string, unknown> | null
  const perms = (r.permissions ?? null) as Record<string, unknown> | null
  return {
    id: r.id,
    name: r.name,
    full_name: typeof r.full_name === 'string' ? r.full_name : '',
    owner: {
      login: typeof owner?.login === 'string' ? owner.login : '',
      avatar_url: typeof owner?.avatar_url === 'string' ? owner.avatar_url : null,
    },
    private: r.private === true,
    default_branch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    description: typeof r.description === 'string' ? r.description : null,
    language: typeof r.language === 'string' ? r.language : null,
    stargazers_count: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    html_url: typeof r.html_url === 'string' ? r.html_url : '',
    permissions: perms
      ? {
          admin: perms.admin === true,
          maintain: perms.maintain === true,
          push: perms.push === true,
          triage: perms.triage === true,
          pull: perms.pull === true,
        }
      : undefined,
  }
}

/**
 * 调 `/repos/:owner/:repo`,带 permissions 字段。
 * GitHub 对 OAuth Bearer + 调用者是 owner/collab 时返 permissions 块。
 */
export async function fetchGithubRepoMeta(
  accessToken: string,
  owner: string,
  repo: string,
  deps?: GithubApiDeps,
): Promise<GithubRepoMeta> {
  const u = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const json = await callGithub(u, accessToken, deps)
  return parseRepoMeta(json)
}

// ─── /repos/:owner/:repo/branches ──────────────────────────────────────

function parseBranchListItem(raw: unknown): GithubBranchMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.name !== 'string') return null
  const commit = b.commit as Record<string, unknown> | null
  return {
    name: b.name,
    commit: { sha: typeof commit?.sha === 'string' ? commit.sha : '' },
    protected: b.protected === true,
  }
}

export interface ListBranchesParams {
  page: number
  perPage: number
}

export async function fetchGithubBranches(
  accessToken: string,
  owner: string,
  repo: string,
  params: ListBranchesParams,
  deps?: GithubApiDeps,
): Promise<GithubBranchMeta[]> {
  const u = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
  )
  u.searchParams.set('per_page', String(params.perPage))
  u.searchParams.set('page', String(params.page))
  const json = await callGithub(u.toString(), accessToken, deps)
  if (!Array.isArray(json)) {
    throw new GithubApiError('upstream', '/branches did not return array')
  }
  const out: GithubBranchMeta[] = []
  for (const item of json) {
    const picked = parseBranchListItem(item)
    if (picked) out.push(picked)
  }
  return out
}

/** 获取单个 branch 元数据(含 head sha)。branch 名可含 `/`,需 encodeURIComponent。 */
export async function fetchGithubBranch(
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
  deps?: GithubApiDeps,
): Promise<GithubBranchMeta> {
  const u = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
  const json = await callGithub(u, accessToken, deps)
  const picked = parseBranchListItem(json)
  if (!picked) {
    throw new GithubApiError('upstream', '/branches/:branch did not return valid branch object')
  }
  return picked
}
