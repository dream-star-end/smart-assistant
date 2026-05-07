/**
 * GitHub OAuth handlers — `/api/auth/github/{start,callback}`。
 *
 * 与 LDC (linuxdo) 的关键区别:
 *   - start 是 **POST**(需要已登录用户 Bearer JWT),不是 GET 302
 *     → 返回 JSON { authorizeUrl, state },同时 Set-Cookie state cookie
 *   - callback 仍是 GET(GitHub 回跳),302 回 /?github_linked=1 或 /?github_error=<code>
 *   - 这是"账号关联",不是"一键登录":用户必须已有本地账号才能绑定 GitHub
 *
 * CSRF 防御:
 *   - start 时生成 state 写入 pending Map(绑定 userId + TTL 600s)
 *   - 同时 Set-Cookie: oc_oauth_gh_state(HttpOnly + SameSite=Lax + Path=callback)
 *   - callback 时双因素校验:query.state == cookie.state,且 state 在 pending Map
 *
 * 失败处理:
 *   - start:JSON 错误(已登录用户在 SPA 里用,不走浏览器导航)
 *   - callback:302 → /?github_error=<code>(前端 toast)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import {
  GithubConfigMissingError,
  GithubOAuthError,
  clearGithubStateCookie,
  exchangeGithubOAuth,
  readGithubConfig,
  readGithubStateCookie,
  setGithubStateCookie,
  startGithubOAuth,
} from '../auth/github.js'
import { getPool } from '../db/index.js'
import { saveGithubLink } from '../github/tokenStore.js'
import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError } from './util.js'

// ─── test-injectable overrides ────────────────────────────────────────
// Production code passes nothing; tests inject mocks to avoid real DB / fetch.
export interface GithubCallbackOverrides {
  exchanger?: typeof exchangeGithubOAuth
  poolFactory?: () => Pool
}

// ─── helper ──────────────────────────────────────────────────────────

function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(`Redirecting to ${location}\n`)
}

function githubErrorRedirect(code: string): string {
  return `/?github_error=${encodeURIComponent(code)}`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  res.end(payload)
}

// ─── POST /api/auth/github/start ─────────────────────────────────────

/**
 * 发起 GitHub OAuth 流程。
 *
 * 要求:已登录用户(Bearer JWT)。
 * 成功返回:200 JSON { authorizeUrl, state } + Set-Cookie oc_oauth_gh_state
 * 失败:
 *   - 未登录 → 401 UNAUTHORIZED (requireAuth 抛出)
 *   - GitHub OAuth env 未配 → 503 GITHUB_OAUTH_NOT_CONFIGURED
 */
export async function handleGithubStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)

  let cfg: ReturnType<typeof readGithubConfig>
  try {
    cfg = readGithubConfig()
  } catch (err) {
    if (err instanceof GithubConfigMissingError) {
      ctx.log.warn('github_start_config_missing', { err: (err as Error).message })
      throw new HttpError(503, 'GITHUB_OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured')
    }
    throw err
  }

  const result = startGithubOAuth({ userId: Number(user.id), cfg })
  setGithubStateCookie(res, result.state, { secure: deps.refreshCookieSecure })
  ctx.log.info('github_start', { sub: user.id })
  sendJson(res, 200, { authorizeUrl: result.authorizeUrl, state: result.state })
}

// ─── GET /api/auth/github/callback ────────────────────────────────────

/**
 * GitHub OAuth callback。
 *
 * 1. state 双因素校验(query.state == cookie.state)
 * 2. exchangeGithubOAuth → access_token + GitHub user profile
 * 3. saveGithubLink → 写入 github_links 表
 * 4. 302 → /?github_linked=1
 *
 * 任何失败:302 → /?github_error=<code>
 *   code: state_mismatch | exchange_failed | account_already_linked | server_error
 */
export async function handleGithubCallback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  overrides: GithubCallbackOverrides = {},
): Promise<void> {
  const exchanger = overrides.exchanger ?? exchangeGithubOAuth
  const poolFactory = overrides.poolFactory ?? getPool
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const queryState = url.searchParams.get('state') ?? ''
  const queryCode = url.searchParams.get('code') ?? ''
  const queryError = url.searchParams.get('error')
  const cookieState = readGithubStateCookie(req)

  // 1) state 双因素校验先于一切分支
  // (同 LDC 设计:state 不匹配不写 Set-Cookie,不消费 nonce)
  if (!queryState || !cookieState || queryState !== cookieState) {
    ctx.log.warn('github_callback_invalid_state', {
      hasQuery: !!queryState,
      hasCookie: !!cookieState,
      hasErrorParam: !!queryError,
    })
    sendRedirect(res, githubErrorRedirect('state_mismatch'))
    return
  }

  // state 通过,清除 nonce(一次性消费防 replay)
  clearGithubStateCookie(res, { secure: deps.refreshCookieSecure })

  // 2) GitHub 把用户带回时带 ?error=… (如用户拒绝授权)
  if (queryError) {
    ctx.log.info('github_callback_provider_error', { error: queryError })
    sendRedirect(res, githubErrorRedirect('exchange_failed'))
    return
  }
  if (!queryCode) {
    ctx.log.warn('github_callback_missing_code', {})
    sendRedirect(res, githubErrorRedirect('state_mismatch'))
    return
  }

  // 3) 读 GitHub OAuth config
  let cfg: ReturnType<typeof readGithubConfig>
  try {
    cfg = readGithubConfig()
  } catch (err) {
    if (err instanceof GithubConfigMissingError) {
      ctx.log.warn('github_callback_config_missing', {})
      sendRedirect(res, githubErrorRedirect('server_error'))
      return
    }
    throw err
  }

  // 4) 用 code 换 access_token + user profile
  let exchanged: Awaited<ReturnType<typeof exchangeGithubOAuth>>
  try {
    exchanged = await exchanger({ code: queryCode, state: queryState, cfg })
  } catch (err) {
    if (err instanceof GithubOAuthError) {
      ctx.log.warn('github_callback_exchange_failed', { code: err.code })
      sendRedirect(res, githubErrorRedirect('exchange_failed'))
      return
    }
    throw err
  }

  // 5) 写 github_links
  const pool = poolFactory()
  try {
    await saveGithubLink({
      pool,
      userId: exchanged.userId,
      profile: {
        githubUserId: exchanged.result.githubUser.id,
        login: exchanged.result.githubUser.login,
        avatarUrl: exchanged.result.githubUser.avatar_url,
        scopes: exchanged.result.scopes,
      },
      accessToken: exchanged.result.accessToken,
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'GITHUB_ACCOUNT_ALREADY_LINKED') {
      ctx.log.warn('github_callback_account_conflict', { sub: exchanged.userId })
      sendRedirect(res, githubErrorRedirect('account_already_linked'))
      return
    }
    ctx.log.error('github_callback_save_failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    sendRedirect(res, githubErrorRedirect('server_error'))
    return
  }

  ctx.log.info('github_callback_success', {
    sub: exchanged.userId,
    ghId: exchanged.result.githubUser.id,
    login: exchanged.result.githubUser.login,
  })
  sendRedirect(res, '/?github_linked=1')
}
