/**
 * LINUX DO Connect (LDC) OAuth handlers — `/api/auth/linuxdo/{start,callback}`。
 *
 * 与其他 auth handler 不同:
 *   - 这两个端点都是 **GET**,不是 JSON,响应是 302 重定向
 *   - 失败不返 JSON 错误,把错误码塞进重定向 URL 的 query(`?login=1&oauth_error=<code>`),
 *     前端登录页根据该码 toast 提示。原因:OAuth 失败时浏览器在跨站 GET 流里,
 *     展示 JSON 体验糟糕,SPA 接管 toast 才是用户能理解的姿态
 *   - 成功一律 302 到 `/?source=linuxdo`,前端 main.js 的 oauthCallback 分支识别
 *     该 query 后强制 silentRefresh 拿 access token(此时 refresh token 已经
 *     在 HttpOnly cookie 里),完成与现有登录态的一致化
 *
 * 限流:custom 60s / 30/IP(不复用 DEFAULT_RATE_LIMITS.login,因为 OAuth start 是
 * GET 顶层导航,刷新页/多 tab 会产生比 POST login 更频繁的请求,但又是用户主动行为
 * 不该太严)。callback 不限流 —— state cookie 双因素 + pending Map 一次性消费,
 * 攻击者拼不出有效 callback;限流反而会误伤合法用户。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './util.js'
import { setRefreshCookie } from './cookies.js'
import {
  startLinuxdoOAuth,
  exchangeLinuxdoOAuth,
  readLinuxdoConfig,
  setOAuthStateCookie,
  readOAuthStateCookie,
  clearOAuthStateCookie,
  LinuxdoConfigMissingError,
  LinuxdoOAuthError,
} from '../auth/linuxdo.js'
import { socialLoginOrCreate, SocialLoginError } from '../auth/socialLogin.js'
import { enforceRateLimit, type CommercialHttpDeps, type RequestContext } from './handlers.js'
import type { RateLimitConfig } from '../middleware/rateLimit.js'

const LINUXDO_START_RATE_LIMIT: RateLimitConfig = {
  scope: 'linuxdo_start',
  windowSeconds: 60,
  max: 30,
}

/**
 * 302 helper —— 不走 JSON。浏览器要 Set-Cookie + Location,所以必须在 redirect
 * 前把 cookie / 安全头都写好。
 *
 * Cache-Control: no-store —— OAuth 流程的 302 回到登录页,绝不缓存(各家代理 / CF
 * 一旦缓存了带 Set-Cookie 的 302 会让登录态串号)。
 */
function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(`Redirecting to ${location}\n`)
}

/**
 * 把 LDC error code 翻译成前端 toast 友好的短码。原始 LDC code 不直接暴露给用户:
 *   - `access_denied` 是用户在 LDC 同意页点了"拒绝",不是错误,前端只 toast"已取消"
 *   - 其他 LDC server 错都归 `provider_error`,前端统一显示"LINUX DO 登录失败,请稍后再试"
 *   - 我们自己的 INVALID_STATE / TOKEN_FAILED 等映射到具体 user-friendly 码
 */
function mapErrorCode(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'denied'
    case 'INVALID_STATE':
      return 'invalid_state'
    case 'INVALID_CODE':
    case 'TOKEN_FAILED':
      return 'token_failed'
    case 'USERINFO_FAILED':
    case 'USERINFO_INVALID':
      return 'userinfo_failed'
    case 'USER_DISABLED':
      return 'disabled'
    case 'CONFIG_MISSING':
      return 'unavailable'
    default:
      return 'provider_error'
  }
}

function loginErrorRedirect(code: string): string {
  return `/?login=1&oauth_error=${encodeURIComponent(code)}`
}

// ─── GET /api/auth/linuxdo/start ─────────────────────────────────────

export async function handleLinuxdoStart(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await enforceRateLimit(deps, LINUXDO_START_RATE_LIMIT, ctx.clientIp)

  let result: ReturnType<typeof startLinuxdoOAuth>
  try {
    const cfg = readLinuxdoConfig()
    result = startLinuxdoOAuth(cfg)
  } catch (err) {
    if (err instanceof LinuxdoConfigMissingError) {
      // 503:服务方未配 LDC client。前端按 unavailable toast 处理
      ctx.log.warn('linuxdo_start_config_missing', { err: err.message })
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'linuxdo SSO not configured')
    }
    throw err
  }

  setOAuthStateCookie(res, result.state, { secure: deps.refreshCookieSecure })
  ctx.log.info('linuxdo_start', {})
  sendRedirect(res, result.authUrl)
}

// ─── GET /api/auth/linuxdo/callback ──────────────────────────────────

export async function handleLinuxdoCallback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const queryState = url.searchParams.get('state') ?? ''
  const queryCode = url.searchParams.get('code') ?? ''
  const queryError = url.searchParams.get('error')
  const cookieState = readOAuthStateCookie(req)

  // ── 1) state 双因素校验先于一切分支(包括 provider error)
  // (Codex R6 NON_BLOCKING #1):之前不论走哪条分支都先 clearOAuthStateCookie,
  // 攻击者拿一个跨站链接 `/callback?error=access_denied` 让受害者打开,就能擦
  // 掉受害者正在 in-flight 的 oc_oauth_ld_state — 一种 OAuth-DoS。修法:state
  // 不匹配的请求**不写 Set-Cookie**(不消费 nonce),原 cookie 留着等真 callback
  // 回来配对;同时也不告诉攻击者多余信息,统一 redirect 'invalid_state'。
  if (!queryState || !cookieState || queryState !== cookieState) {
    ctx.log.warn('linuxdo_callback_invalid_state', {
      hasQuery: !!queryState,
      hasCookie: !!cookieState,
      hasErrorParam: !!queryError,
    })
    sendRedirect(res, loginErrorRedirect('invalid_state'))
    return
  }

  // 通过 state 校验后,无论后续是 provider error 还是成功,这条 nonce 都用过了,
  // 必须清(一次性消费防 replay)。
  clearOAuthStateCookie(res, { secure: deps.refreshCookieSecure })

  // ── 2) LDC 把用户回退过来时带 ?error=… —— 多半是用户在 LDC 上拒绝授权
  if (queryError) {
    ctx.log.info('linuxdo_callback_provider_error', { error: queryError })
    sendRedirect(res, loginErrorRedirect(mapErrorCode(queryError)))
    return
  }
  if (!queryCode) {
    ctx.log.warn('linuxdo_callback_missing_code', {})
    sendRedirect(res, loginErrorRedirect('invalid_state'))
    return
  }

  // ── 3) 用 code 换 LDC userinfo
  let userInfo
  try {
    userInfo = await exchangeLinuxdoOAuth(queryCode, queryState)
  } catch (err) {
    if (err instanceof LinuxdoOAuthError) {
      // 只 log code + status,不带 err.message —— 网络/SDK error.message 不是稳定
      // 的脱敏边界,虽然当前实现不直接拼 client_secret/access_token,但保守处理
      // (Codex R6 NON_BLOCKING #2)。
      ctx.log.warn('linuxdo_callback_exchange_failed', {
        code: err.code,
        status: err.status,
      })
      sendRedirect(res, loginErrorRedirect(mapErrorCode(err.code)))
      return
    }
    if (err instanceof LinuxdoConfigMissingError) {
      ctx.log.warn('linuxdo_callback_config_missing', {})
      sendRedirect(res, loginErrorRedirect('unavailable'))
      return
    }
    throw err
  }

  // ── 4) 落库 + 签 token
  let result
  try {
    result = await socialLoginOrCreate(
      {
        provider: 'linuxdo',
        providerUserId: userInfo.providerUserId,
        username: userInfo.username,
        email: userInfo.email,
        trustLevel: userInfo.trustLevel,
        avatarUrl: userInfo.avatarUrl,
      },
      {
        jwtSecret: deps.jwtSecret,
        userAgent: ctx.userAgent ?? undefined,
        bindIp: ctx.authBoundIp,
      },
    )
  } catch (err) {
    if (err instanceof SocialLoginError) {
      // 同 exchange 路径,只 log code(R6 NON_BLOCKING #2 一致处理)。
      ctx.log.warn('linuxdo_callback_social_login_failed', {
        code: err.code,
      })
      sendRedirect(res, loginErrorRedirect(mapErrorCode(err.code)))
      return
    }
    throw err
  }

  // ── 5) 写 refresh cookie + 302 回前端
  // SSO 默认"记住我"=true(persistent cookie,30 天),与 socialLogin.ts 里
  // INSERT refresh_tokens(remember_me=TRUE) 对齐。前端 main.js oauthCallback
  // 分支会侦测到 ?source=linuxdo 强制 silentRefresh 拿 access token。
  const ttl = Math.max(1, result.refresh_exp - Math.floor(Date.now() / 1000))
  setRefreshCookie(res, result.refresh_token, ttl, {
    secure: deps.refreshCookieSecure,
    persistent: true,
  })
  ctx.log.info('linuxdo_callback_success', {
    sub: result.user.id,
    isNew: result.isNew,
  })
  sendRedirect(res, '/?source=linuxdo')
}
