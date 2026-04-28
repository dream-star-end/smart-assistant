/**
 * LINUX DO Connect (LDC) OAuth 2.0 客户端 — Authorization Code Flow 的服务端实现。
 *
 * 用于 claudeai.chat 实现"用 linux.do 一键登录",合规接入 linux.do 普通推广要求。
 *
 * 与 admin/oauth.ts(Claude OAuth) 区别:
 *   - LDC 是 client_secret flow,**不是 PKCE** —— LDC 后台没法装 PKCE
 *   - LDC 接受 form-urlencoded(OAuth 2.0 标准),admin 那边用 JSON
 *   - LDC userinfo 在 connect.linux.do/api/user
 *
 * Login CSRF 防御(2026-04-28 codex review R2):
 *   - server 端 pending Map 校验 state(防重放、防过期)
 *   - **同时**种 HttpOnly + SameSite=Lax + Path=/api/auth/linuxdo/callback 的
 *     state cookie,callback 时双因素校验:query.state == cookie.state
 *   - 仅靠 server Map 不足以防"攻击者把自己的 callback URL 诱导受害者打开 →
 *     登录成攻击者账号"——攻击者 Map 里那条会被合法消费,受害者无侵害
 *     感知。cookie 把 state 绑定到发起 OAuth 的浏览器,攻击者浏览器和受害者
 *     浏览器的 cookie 不同,跨浏览器拼凑 callback 永远 mismatch。
 *
 * 跨站 fetch 行为说明(SameSite=Lax):
 *   - LDC → claudeai.chat/api/auth/linuxdo/callback 是 GET 顶层导航(<a> /
 *     302 redirect),浏览器视为"用户主动操作",Lax cookie 允许携带。Strict 会
 *     拒绝 → cookie 失效,SSO 链路崩。所以这里**必须 Lax 不能 Strict**。
 *   - 业务 cookie oc_rt 仍维持 SameSite=Strict + Path=/api/auth(由 cookies.ts
 *     setRefreshCookie 写入)—— 那是已登录后的会话,不需要跨站语义。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { appendSetCookie } from '../http/cookies.js'

// ─── Config ──────────────────────────────────────────────────────────

/**
 * LDC 端点常量 — 不会变,硬编码即可(部署后多年不动)。
 *   - authorize/token/userinfo 域名都是 connect.linux.do(LDC 文档确认,无 CDN
 *     跳板,不会有 claude.ai 那种"中间域被墙"问题)
 */
const LDC_ENDPOINTS = {
  authUrl: 'https://connect.linux.do/oauth2/authorize',
  tokenUrl: 'https://connect.linux.do/oauth2/token',
  userinfoUrl: 'https://connect.linux.do/api/user',
} as const

const DEFAULT_REDIRECT = 'https://claudeai.chat/api/auth/linuxdo/callback'

/**
 * LDC scope 留空(默认就够拿 user.id/username/email/avatar/trust_level)。
 * 文档实测:不传 scope LDC 接受;传非法 scope 反而 400。
 */
const LDC_SCOPES = ''

interface LdcConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * 从 env 读 LDC 配置,任何一项缺失抛 ConfigMissingError —— handler 转 503。
 * 不在模块加载时校验,允许 commercial-v3 没配 LDC 也能起服务(SSO 入口
 * 走到才报错;邮箱密码登录不受影响)。
 */
export class LinuxdoConfigMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LinuxdoConfigMissingError'
  }
}

export function readLinuxdoConfig(env: NodeJS.ProcessEnv = process.env): LdcConfig {
  const clientId = env.LINUXDO_CLIENT_ID
  const clientSecret = env.LINUXDO_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new LinuxdoConfigMissingError('LINUXDO_CLIENT_ID / LINUXDO_CLIENT_SECRET not set')
  }
  const redirectUri = env.LINUXDO_REDIRECT_URI || DEFAULT_REDIRECT
  return { clientId, clientSecret, redirectUri }
}

// ─── Pending state(server-side anti-replay / TTL)──────────────────────

interface PendingState {
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000
/**
 * 容量上限 200 — codex R4 NB:50 偏紧,生产偶发短时高并发 OAuth start 会
 * 把合法 state 挤出。200 仍是常数级内存(~11KB),配合 IP rate limit 双兜底。
 */
const PENDING_MAX = 200
const pending = new Map<string, PendingState>()

function gcPending(): void {
  while (pending.size >= PENDING_MAX) {
    const oldest = pending.keys().next().value
    if (!oldest) break
    pending.delete(oldest)
  }
}

/** 测试 hook:清空 Map(每个 test 之间隔离) */
export function _resetPendingForTesting(): void {
  pending.clear()
}

/** 测试 hook:观察 size */
export function _pendingSizeForTesting(): number {
  return pending.size
}

// ─── State cookie helpers(CSRF 双因素的"绑浏览器"那一极)──────────────

const STATE_COOKIE_NAME = 'oc_oauth_ld_state'
const STATE_COOKIE_PATH = '/api/auth/linuxdo/callback'
const STATE_COOKIE_MAX_AGE_SECONDS = 600 // 10min,匹配 pending Map TTL

export function setOAuthStateCookie(
  res: ServerResponse,
  state: string,
  opts: { secure?: boolean } = {},
): void {
  const secure = opts.secure ?? true
  // SameSite=Lax 必需:LDC → callback 是跨站顶层 GET 导航,Strict 会丢
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

export function clearOAuthStateCookie(res: ServerResponse, opts: { secure?: boolean } = {}): void {
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

export function readOAuthStateCookie(req: IncomingMessage): string | null {
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

export interface OAuthStartResult {
  authUrl: string
  state: string
}

/**
 * 生成 state、写 pending Map、返回 LDC authorize URL + state(handler 用 state
 * 写 cookie)。**handler 必须**:
 *   1. setOAuthStateCookie(res, result.state)
 *   2. 302 Location: result.authUrl
 *
 * 若 env 缺失抛 LinuxdoConfigMissingError,handler 转 503 Service Unavailable。
 */
export function startLinuxdoOAuth(config: LdcConfig = readLinuxdoConfig()): OAuthStartResult {
  const state = randomBytes(16).toString('hex')
  gcPending()
  const now = Date.now()
  pending.set(state, { createdAt: now })
  // best-effort 自动 GC(双层防御)
  setTimeout(() => {
    const cur = pending.get(state)
    if (cur && cur.createdAt === now) pending.delete(state)
  }, PENDING_TTL_MS).unref?.()

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
  })
  if (LDC_SCOPES.length > 0) params.set('scope', LDC_SCOPES)

  return {
    authUrl: `${LDC_ENDPOINTS.authUrl}?${params.toString()}`,
    state,
  }
}

// ─── Exchange code → userinfo ────────────────────────────────────────

export interface LdcUserInfo {
  /** LDC 数字 user_id,字符串化以避开 JS Number 64bit 风险 */
  providerUserId: string
  username: string
  /** LDC 可能不返(取决于用户隐私设置 / scope),为空就空 */
  email: string | null
  trustLevel: number | null
  avatarUrl: string | null
}

export class LinuxdoOAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'INVALID_STATE'
      | 'INVALID_CODE'
      | 'TOKEN_FAILED'
      | 'USERINFO_FAILED'
      | 'USERINFO_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'LinuxdoOAuthError'
  }
}

const FETCH_TIMEOUT_MS = 8000

export interface ExchangeDeps {
  /** 测试可注入 fetch */
  fetchImpl?: typeof fetch
  /** 测试可注入 config(默认 readLinuxdoConfig) */
  config?: LdcConfig
}

/**
 * 用 callback 收到的 code 换 LDC userinfo。
 *
 * 流程:
 *   1. 校 state 是否在 pending Map(server 端一次性 + TTL 校验)
 *      —— **删除**这条 entry,后续重放无效
 *   2. POST tokenUrl(form-urlencoded)拿 access_token
 *   3. GET userinfoUrl(Bearer)拿 user 信息
 *   4. 解析返合法字段,失败抛 USERINFO_INVALID
 *
 * **不**在这里写 cookie / DB —— 业务编排留给 socialLogin.ts。
 *
 * **不**校验 query.state == cookie.state —— 那是 handler 的责任(handler 既能拿
 * cookie 又能拿 query;此函数纯业务)。
 *
 * 错误语义:全部 status >= 400 但具体 code 让 handler 区分(map LDC error → 用户友好提示)。
 */
export async function exchangeLinuxdoOAuth(
  code: string,
  state: string,
  deps: ExchangeDeps = {},
): Promise<LdcUserInfo> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const config = deps.config ?? readLinuxdoConfig()

  // 1) state 校验(server side)
  const entry = pending.get(state)
  if (!entry) {
    throw new LinuxdoOAuthError(400, 'INVALID_STATE', 'invalid or expired state')
  }
  pending.delete(state)
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    throw new LinuxdoOAuthError(400, 'INVALID_STATE', 'state expired')
  }

  // 2) Token exchange — OAuth 2.0 标准 form-urlencoded
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }).toString()

  let tokenRes: Response
  try {
    tokenRes = await fetchImpl(LDC_ENDPOINTS.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new LinuxdoOAuthError(
      502,
      'TOKEN_FAILED',
      `token endpoint network error: ${(err as Error).message}`,
    )
  }

  if (!tokenRes.ok) {
    // 不把 LDC 原始响应透给上层(避免泄露 client_secret 类敏感字段),只记 status
    throw new LinuxdoOAuthError(502, 'TOKEN_FAILED', `token endpoint returned ${tokenRes.status}`)
  }

  let tokenJson: { access_token?: unknown }
  try {
    tokenJson = (await tokenRes.json()) as { access_token?: unknown }
  } catch {
    throw new LinuxdoOAuthError(502, 'TOKEN_FAILED', 'token endpoint returned non-JSON')
  }
  if (typeof tokenJson.access_token !== 'string' || tokenJson.access_token.length === 0) {
    throw new LinuxdoOAuthError(502, 'TOKEN_FAILED', 'token endpoint missing access_token')
  }
  const accessToken = tokenJson.access_token

  // 3) Userinfo
  let userRes: Response
  try {
    userRes = await fetchImpl(LDC_ENDPOINTS.userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new LinuxdoOAuthError(
      502,
      'USERINFO_FAILED',
      `userinfo endpoint network error: ${(err as Error).message}`,
    )
  }

  if (!userRes.ok) {
    throw new LinuxdoOAuthError(
      502,
      'USERINFO_FAILED',
      `userinfo endpoint returned ${userRes.status}`,
    )
  }

  let userJson: Record<string, unknown>
  try {
    userJson = (await userRes.json()) as Record<string, unknown>
  } catch {
    throw new LinuxdoOAuthError(502, 'USERINFO_FAILED', 'userinfo endpoint returned non-JSON')
  }

  // 4) Parse — id 必须是 number 或 numeric string,转为 string 落库
  const rawId = userJson.id
  let providerUserId: string
  if (typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0) {
    providerUserId = String(rawId)
  } else if (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)) {
    providerUserId = rawId
  } else {
    throw new LinuxdoOAuthError(502, 'USERINFO_INVALID', 'userinfo missing or invalid id')
  }

  const username = typeof userJson.username === 'string' ? userJson.username.trim() : ''
  if (username.length === 0) {
    throw new LinuxdoOAuthError(502, 'USERINFO_INVALID', 'userinfo missing username')
  }

  const email =
    typeof userJson.email === 'string' && userJson.email.trim().length > 0
      ? userJson.email.trim().toLowerCase()
      : null

  const trustLevel =
    typeof userJson.trust_level === 'number' && Number.isFinite(userJson.trust_level)
      ? userJson.trust_level
      : null

  const avatarUrl =
    typeof userJson.avatar_url === 'string' && userJson.avatar_url.length > 0
      ? userJson.avatar_url
      : null

  return {
    providerUserId,
    username,
    email,
    trustLevel,
    avatarUrl,
  }
}
