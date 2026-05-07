/**
 * GitHub OAuth 2.0 客户端 — Authorization Code Flow 服务端实现。
 *
 * 用于 GitHub 账号关联:已登录用户将本地账号与 GitHub 账号绑定,后续
 * 可用 GitHub token 拉取仓库。这是"账号关联",不是"一键登录"。
 *
 * 关键区别:
 *   - start 端点为 POST(需要已登录用户 Bearer JWT),不是 GET 302
 *   - callback 仍是 GET(GitHub 回跳)
 *   - 成功后 302 回 /?github_linked=1,前端 toast 提示
 *   - GitHub OAuth App 不发 refresh token,token 有效期极长(一年不操作过期)
 *
 * CSRF 防御:
 *   - server 端 pending Map 绑定 state → userId(防重放、防过期)
 *   - HttpOnly + SameSite=Lax + Path=/api/auth/github/callback state cookie,
 *     callback 时 query.state == cookie.state 双因素验证
 *
 * 安全约束:
 *   - GitHub API 调用必须携带 User-Agent: OpenClaude/v3 (GitHub API 强制要求)
 *   - Accept: application/vnd.github+json (GitHub 推荐的 versioned API header)
 *   - 失败信息不泄露 client_secret 或 token 任何片段
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendSetCookie } from '../http/cookies.js'

// ─── Config ──────────────────────────────────────────────────────────

const GITHUB_ENDPOINTS = {
  authUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userUrl: 'https://api.github.com/user',
} as const

const DEFAULT_SCOPES: string[] = ['repo', 'read:user']

// 业务必需 scope:repo (写仓库) 必须授予;read:user 用于拉取 login,
// 缺失时也无法走通 /user 端点(已由 user fetch 兜底校验)。
const REQUIRED_SCOPES = ['repo'] as const

/**
 * 解析 GitHub 在 token 响应里返回的 scope 字符串。
 *
 * GitHub OAuth App 实际返回 **逗号分隔**(如 "repo,read:user"),
 * 但旧文档片段误传过"空格分隔"——保险起见按 `[,\s]+` 同时处理两种分隔符。
 * 返回去重 + 去空白的 scope 数组。
 */
export function parseGithubScopes(raw: string): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const s of raw.split(/[,\s]+/)) {
    const t = s.trim()
    if (t.length > 0) seen.add(t)
  }
  return Array.from(seen)
}

/** 把解析后的 scope 数组规整化为空格分隔(对齐 DB schema 注释 + downstream 使用)。 */
export function canonicalizeGithubScopes(raw: string): string {
  return parseGithubScopes(raw).join(' ')
}

export interface GithubOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string[]
}

export class GithubConfigMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubConfigMissingError'
  }
}

export class GithubOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GithubOAuthError'
  }
}

/**
 * 从 env 读 GitHub OAuth 配置。任一必填项缺失抛 GithubConfigMissingError。
 * 不在模块加载时校验 — 允许未配 GitHub OAuth 时服务正常启动。
 */
export function readGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubOAuthConfig {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET
  const redirectUri = env.GITHUB_OAUTH_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GithubConfigMissingError(
      'GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET / GITHUB_OAUTH_REDIRECT_URI not set',
    )
  }
  return { clientId, clientSecret, redirectUri, scopes: DEFAULT_SCOPES }
}

// ─── Pending state(server-side anti-replay + userId 绑定)────────────

export interface PendingGithubOAuth {
  state: string
  userId: number
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000 // 600s
const PENDING_MAX = 200
const pending = new Map<string, PendingGithubOAuth>()

function gcPending(): void {
  while (pending.size >= PENDING_MAX) {
    const oldest = pending.keys().next().value
    if (!oldest) break
    pending.delete(oldest)
  }
}

/** 测试 hook:清空 pending Map */
export function _test_clearPending(): void {
  pending.clear()
}

/** 测试 hook:查看 pending Map 大小 */
export function _test_pendingSize(): number {
  return pending.size
}

// ─── State cookie(CSRF 双因素的"绑浏览器"那一极)─────────────────────

const STATE_COOKIE_NAME = 'oc_oauth_gh_state'
const STATE_COOKIE_PATH = '/api/auth/github/callback'
const STATE_COOKIE_MAX_AGE_SECONDS = 600

export function setGithubStateCookie(
  res: ServerResponse,
  state: string,
  opts: { secure?: boolean } = {},
): void {
  const secure = opts.secure ?? true
  const parts = [
    `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}`,
    `Max-Age=${STATE_COOKIE_MAX_AGE_SECONDS}`,
    `Path=${STATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  appendSetCookie(res, parts.join('; '))
}

export function clearGithubStateCookie(res: ServerResponse, opts: { secure?: boolean } = {}): void {
  const secure = opts.secure ?? true
  const parts = [
    `${STATE_COOKIE_NAME}=`,
    'Max-Age=0',
    `Path=${STATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  appendSetCookie(res, parts.join('; '))
}

export function readGithubStateCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length === 0) return null
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.length === 0) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const name = trimmed.slice(0, eqIdx)
    if (name !== STATE_COOKIE_NAME) continue
    const value = trimmed.slice(eqIdx + 1)
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return null
}

// ─── Start OAuth ─────────────────────────────────────────────────────

/**
 * 生成 state、绑定 userId、写 pending Map,返回 GitHub authorize URL + state。
 * handler 负责:
 *   1. setGithubStateCookie(res, result.state)
 *   2. 返回 JSON { authorizeUrl, state }
 */
export function startGithubOAuth(opts: {
  userId: number
  cfg: GithubOAuthConfig
}): { authorizeUrl: string; state: string } {
  const { userId, cfg } = opts
  const state = randomBytes(16).toString('hex')
  gcPending()
  const now = Date.now()
  const entry: PendingGithubOAuth = { state, userId, createdAt: now }
  pending.set(state, entry)
  // best-effort 自动 GC
  setTimeout(() => {
    const cur = pending.get(state)
    if (cur && cur.createdAt === now) pending.delete(state)
  }, PENDING_TTL_MS).unref?.()

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    state,
    scope: cfg.scopes.join(' '),
  })

  return {
    authorizeUrl: `${GITHUB_ENDPOINTS.authUrl}?${params.toString()}`,
    state,
  }
}

// ─── Exchange code → access_token + user profile ─────────────────────

export interface GithubExchangeResult {
  accessToken: string
  scopes: string // 空格分隔,GitHub 原始格式
  githubUser: { id: number; login: string; avatar_url: string | null }
}

const FETCH_TIMEOUT_MS = 8000

export interface ExchangeGithubDeps {
  fetchImpl?: typeof fetch
}

/**
 * 用 callback 收到的 code 换 GitHub access_token + user profile。
 *
 * 流程:
 *   1. 校 state 是否在 pending Map(server 端一次性 + TTL + userId 绑定)
 *   2. POST https://github.com/login/oauth/access_token 拿 access_token
 *   3. GET https://api.github.com/user (Bearer) 拿 user profile
 *   4. 返回 { result, userId }
 */
export async function exchangeGithubOAuth(opts: {
  code: string
  state: string
  cfg: GithubOAuthConfig
  deps?: ExchangeGithubDeps
}): Promise<{ result: GithubExchangeResult; userId: number }> {
  const { code, state, cfg, deps = {} } = opts
  const fetchImpl = deps.fetchImpl ?? fetch

  // 1) state 校验(server side 一次性消费)
  const entry = pending.get(state)
  if (!entry) {
    throw new GithubOAuthError('state_mismatch', 'invalid or expired state')
  }
  pending.delete(state)
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    throw new GithubOAuthError('state_mismatch', 'state expired')
  }

  // 2) Token exchange — GitHub 接受 JSON 或 form,Accept: application/json 拿 JSON 响应
  let tokenRes: Response
  try {
    tokenRes = await fetchImpl(GITHUB_ENDPOINTS.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'OpenClaude/v3',
      },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new GithubOAuthError(
      'exchange_failed',
      `token endpoint network error: ${(err as Error).message}`,
    )
  }

  if (!tokenRes.ok) {
    throw new GithubOAuthError('exchange_failed', `token endpoint returned ${tokenRes.status}`)
  }

  let tokenJson: { access_token?: unknown; error?: unknown; scope?: unknown }
  try {
    tokenJson = (await tokenRes.json()) as typeof tokenJson
  } catch {
    throw new GithubOAuthError('exchange_failed', 'token endpoint returned non-JSON')
  }

  if (tokenJson.error) {
    throw new GithubOAuthError('exchange_failed', `GitHub token error: ${String(tokenJson.error)}`)
  }

  if (typeof tokenJson.access_token !== 'string' || tokenJson.access_token.length === 0) {
    throw new GithubOAuthError('exchange_failed', 'token endpoint missing access_token')
  }
  const accessToken = tokenJson.access_token
  // GitHub OAuth App 在 token 响应里以 'scope' 字段返回**逗号分隔**的 scope 串,
  // 用 parseGithubScopes 兼容 `,` 和空格两种分隔。最终落库统一空格分隔。
  const rawScope = typeof tokenJson.scope === 'string' ? tokenJson.scope : ''
  const grantedScopes = parseGithubScopes(rawScope)
  const missingScopes = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s))
  if (missingScopes.length > 0) {
    throw new GithubOAuthError(
      'exchange_failed',
      `missing required scopes: ${missingScopes.join(',')}`,
    )
  }
  const scopes = grantedScopes.join(' ')

  // 3) GET /user
  let userRes: Response
  try {
    userRes = await fetchImpl(GITHUB_ENDPOINTS.userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenClaude/v3',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new GithubOAuthError(
      'exchange_failed',
      `user endpoint network error: ${(err as Error).message}`,
    )
  }

  if (!userRes.ok) {
    throw new GithubOAuthError('exchange_failed', `user endpoint returned ${userRes.status}`)
  }

  let userJson: Record<string, unknown>
  try {
    userJson = (await userRes.json()) as Record<string, unknown>
  } catch {
    throw new GithubOAuthError('exchange_failed', 'user endpoint returned non-JSON')
  }

  // Parse user profile — id 必须是正整数
  const rawId = userJson.id
  if (
    typeof rawId !== 'number' ||
    !Number.isFinite(rawId) ||
    rawId <= 0 ||
    !Number.isInteger(rawId)
  ) {
    throw new GithubOAuthError('exchange_failed', 'user endpoint missing or invalid id')
  }

  const login = typeof userJson.login === 'string' ? userJson.login.trim() : ''
  if (login.length === 0) {
    throw new GithubOAuthError('exchange_failed', 'user endpoint missing login')
  }

  const avatar_url =
    typeof userJson.avatar_url === 'string' && userJson.avatar_url.length > 0
      ? userJson.avatar_url
      : null

  return {
    result: {
      accessToken,
      scopes,
      githubUser: { id: rawId, login, avatar_url },
    },
    userId: entry.userId,
  }
}
