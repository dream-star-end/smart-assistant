/**
 * providers/github — 只读 adapter(设计终稿 §4 裁决)。
 *
 * github_links 仍是 repo-bind 域权威源;连接器目录中的 GitHub 项**复用**
 * getGithubLinkWithToken,v1 只读(search_issues / get_issue),写能力留 GitHub App 债。
 * 401 复用现有 revoke/清 session 语义(revokeGithubLinkAndClearSessions)。
 *
 * 出站:固定域 api.github.com(静态白名单)+ 默认全局出口 + redirect:'error'。
 */

import type { Pool } from 'pg'
import { fetch as undiciFetch } from 'undici'
import {
  getGithubLinkWithToken,
  revokeGithubLinkAndClearSessions,
} from '../../github/tokenStore.js'
import { ConnectorError } from '../errors.js'
import { TOTAL_TIMEOUT_MS, assertFixedDomainUrl } from '../outboundPolicy.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  TEXT_FIELD_MAX_CHARS,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedJson,
  truncateText,
} from './shared.js'

const GITHUB_BASE = 'https://api.github.com'

export interface GithubDeps {
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
}

/** RPC list 中 GitHub 虚拟连接的 id(github 无 connections 行,§4)。 */
export const GITHUB_VIRTUAL_CONNECTION_ID = 'github'

async function ghFetch(
  pool: Pool,
  userId: number,
  path: string,
  deps: GithubDeps,
): Promise<unknown> {
  const link = await getGithubLinkWithToken(pool, userId)
  if (!link) {
    throw new ConnectorError('CONNECTION_NOT_FOUND', 'github not linked')
  }
  const url = assertFixedDomainUrl('github', `${GITHUB_BASE}${path}`)
  const doFetch =
    deps.fetchImpl ??
    ((input: string, i: Record<string, unknown>) =>
      undiciFetch(input, i as never) as unknown as Promise<Response>)
  let res: Response
  try {
    res = await doFetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${link.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenClaude/v3',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    })
  } catch (err) {
    throw mapFetchFailure(err, 'github')
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {})
    // 复用既有 revoke/清 session 语义(同 githubApi 的 link_revoked 路径)。
    // P1#9:本地 revoke+清 session **失败不得吞掉** —— 若吞掉仍返回 RELINK_REQUIRED,
    // DB link 可能仍 active → 前端引导重绑但底层没清,反复 401 反复失败。只有清干净了
    // 才返回 RELINK_REQUIRED;失败返回稳定可重试码(UPSTREAM_ERROR),详情不透传。
    try {
      await revokeGithubLinkAndClearSessions(pool, userId, 'link_revoked')
    } catch {
      throw new ConnectorError('UPSTREAM_ERROR', 'github local revoke failed after upstream 401')
    }
    throw new ConnectorError('RELINK_REQUIRED', 'github token revoked upstream')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw mapUpstreamStatus(res.status, 'github')
  }
  return readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, 'github')
}

// ─── actions(v1 只读) ───────────────────────────────────────────────────

export async function githubSearchIssues(
  pool: Pool,
  userId: number,
  params: { query: string; limit?: number },
  deps: GithubDeps = {},
): Promise<unknown> {
  const perPage = params.limit ?? 10
  const data = (await ghFetch(
    pool,
    userId,
    `/search/issues?q=${encodeURIComponent(params.query)}&per_page=${perPage}`,
    deps,
  )) as { total_count?: number; items?: unknown[] }
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 30).map((raw) => {
    const it = raw as Record<string, unknown>
    const repoUrl = String(it.repository_url ?? '')
    const repo = repoUrl.replace(/^.*\/repos\//, '')
    const [title] = truncateText(String(it.title ?? ''), 500)
    return {
      repo,
      number: Number(it.number ?? 0),
      title,
      state: String(it.state ?? ''),
      url: String(it.html_url ?? ''),
      isPullRequest: it.pull_request !== undefined,
      ...(typeof it.updated_at === 'string' ? { updatedAt: it.updated_at } : {}),
    }
  })
  return { totalCount: Number(data.total_count ?? items.length), items }
}

export async function githubGetIssue(
  pool: Pool,
  userId: number,
  params: { repo: string; number: number },
  deps: GithubDeps = {},
): Promise<unknown> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(params.repo)) {
    throw new ConnectorError('VALIDATION_FAILED', 'repo must be owner/name')
  }
  const [owner, name] = params.repo.split('/', 2)
  const it = (await ghFetch(
    pool,
    userId,
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues/${params.number}`,
    deps,
  )) as Record<string, unknown>
  const [body, bodyTruncated] = truncateText(String(it.body ?? ''), TEXT_FIELD_MAX_CHARS)
  const [title] = truncateText(String(it.title ?? ''), 500)
  const labels = (Array.isArray(it.labels) ? it.labels : [])
    .map((l) => String((l as { name?: unknown })?.name ?? ''))
    .filter(Boolean)
    .slice(0, 50)
  return {
    repo: params.repo,
    number: Number(it.number ?? params.number),
    title,
    state: String(it.state ?? ''),
    url: String(it.html_url ?? ''),
    body,
    bodyTruncated,
    labels,
    ...(typeof it.updated_at === 'string' ? { updatedAt: it.updated_at } : {}),
    ...(typeof it.comments === 'number' ? { comments: it.comments } : {}),
  }
}

export async function executeGithub(
  pool: Pool,
  userId: number,
  action: string,
  params: Record<string, unknown>,
  deps: GithubDeps = {},
): Promise<unknown> {
  switch (action) {
    case 'search_issues':
      return githubSearchIssues(pool, userId, params as never, deps)
    case 'get_issue':
      return githubGetIssue(pool, userId, params as never, deps)
    default:
      throw new ConnectorError('ACTION_UNKNOWN', `github adapter has no action ${action}`)
  }
}
