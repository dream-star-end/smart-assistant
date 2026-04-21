// OpenClaude — API helpers
// Centralized HTTP client for all authenticated API calls.
// Contracts:
//   • Every request has a hard timeout (default 30s) — stale sockets are
//     aborted rather than hanging the UI forever.
//   • Callers may pass their own AbortSignal via opts.signal; it composes with
//     the timeout (whichever aborts first wins).
//   • A 401 response triggers the app-wide auth-expired handler exactly once
//     (idempotent across many concurrent failing requests during token
//     expiry). Callers that legitimately expect 401 without logging the user
//     out (login/logout probes) opt out with opts.suppressAuthRedirect=true.
//   • Errors thrown carry e.status (HTTP status code) so callers can branch
//     on it without parsing the message.
import { state } from './state.js'

const DEFAULT_TIMEOUT_MS = 30000

let _authExpiredHandler = null
// Idempotency: many in-flight requests may return 401 simultaneously during
// token expiry; only fire the handler once. Reset on successful login so a
// future expiry can trigger again.
let _authExpiredFired = false

export function onAuthExpired(handler) {
  _authExpiredHandler = handler
}

export function resetAuthExpired() {
  _authExpiredFired = false
}

function _notifyAuthExpired() {
  if (_authExpiredFired) return
  _authExpiredFired = true
  try {
    _authExpiredHandler?.()
  } catch {}
}

export function authHeaders(extra) {
  return { Authorization: `Bearer ${state.token}`, ...(extra || {}) }
}

// Compose a user-provided AbortSignal with a timeout. Returns a signal that
// aborts on whichever fires first, plus a cleanup() to cancel the timer and
// unregister the user-signal listener.
function _composeSignal(userSignal, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    const err = new DOMException('Request timeout', 'TimeoutError')
    ctrl.abort(err)
  }, timeoutMs)
  let onUserAbort = null
  if (userSignal) {
    if (userSignal.aborted) {
      clearTimeout(timer)
      ctrl.abort(userSignal.reason)
    } else {
      onUserAbort = () => ctrl.abort(userSignal.reason)
      userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
  }
  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer)
      if (onUserAbort) userSignal.removeEventListener('abort', onUserAbort)
    },
  }
}

function _httpError(label, status, msg, code, issues) {
  const e = new Error(msg ? `${label} failed: ${status} ${msg}` : `${label} failed: ${status}`)
  e.status = status
  if (code) e.code = code
  if (issues) e.issues = issues
  return e
}

// 后端标准错误体: { error: { code, message, request_id, issues? } }
// 旧/legacy 兼容: { error: string } 或 { message: string }
function _readStdError(d) {
  if (!d || typeof d !== 'object') return { code: undefined, message: undefined, issues: undefined }
  // 标准格式
  if (d.error && typeof d.error === 'object') {
    return {
      code: typeof d.error.code === 'string' ? d.error.code : undefined,
      message: typeof d.error.message === 'string' ? d.error.message : undefined,
      issues: Array.isArray(d.error.issues) ? d.error.issues : undefined,
    }
  }
  // legacy 字符串 error
  if (typeof d.error === 'string') return { code: undefined, message: d.error, issues: undefined }
  if (typeof d.message === 'string') return { code: undefined, message: d.message, issues: undefined }
  return { code: undefined, message: undefined, issues: undefined }
}

async function _extractErrorMessage(res) {
  try {
    const d = await res.clone().json()
    const std = _readStdError(d)
    return std.message ?? std.code
  } catch {
    return undefined
  }
}

// ── V3 commercial: silent refresh on 401 ──
//
// 2026-04-21 HIGH#4 改造:refresh token 已迁到 HttpOnly cookie(oc_rt,
// Path=/api/auth)。浏览器在 fetch('/api/auth/refresh') 时自动带 cookie,
// JS 看不到这个 cookie 也无法判断它是否存在。
//
// 行为:
//   • 401 → POST /api/auth/refresh(同源 fetch 默认 same-origin cookie 自动携带)。
//   • 迁移期(2 周):如果 state.refreshToken 还有值(老用户 localStorage 里
//     残留),用 body 兜底,让 server 同时把 cookie 种回来,然后清 localStorage
//     和 state.refreshToken,完成一次性升级。
//   • 多并发 401 共享同一 _refreshInflight,避免 N 个并行调用重复打 refresh。
//   • 失败(4xx / 网络挂)→ _notifyAuthExpired,原 401 透传给 caller。
//   • /api/auth/* 路径本身跳过:这些端点天然返 401 不该再触发递归。
//   • caller 传 suppressAuthRedirect=true(login/probe)整体跳过。
//   • 重试 pass 上 set _attemptedRefresh=true,避免无限循环。
let _refreshInflight = null

// 单次 refresh 调用(不含 race retry)。
async function _doRefreshOnce() {
  const legacyBody = state.refreshToken
    ? JSON.stringify({ refresh_token: state.refreshToken })
    : undefined
  const r = await fetch('/api/auth/refresh', {
    method: 'POST',
    // same-origin 是默认值,显式写出来表明"我们依赖浏览器自动带 cookie"。
    credentials: 'same-origin',
    headers: legacyBody ? { 'Content-Type': 'application/json' } : undefined,
    body: legacyBody,
  })
  if (r.ok) {
    const data = await r.json().catch(() => ({}))
    if (typeof data?.access_token !== 'string' || !data.access_token) {
      return { ok: false, race: false }
    }
    state.token = data.access_token
    if (typeof data.access_exp === 'number') state.tokenExp = data.access_exp
    try {
      localStorage.setItem('openclaude_access_token', data.access_token)
      if (typeof data.access_exp === 'number') {
        localStorage.setItem('openclaude_access_exp', String(data.access_exp))
      }
      // 升级成功:server 已把 cookie 种回来,本地 localStorage / state 里的旧
      // refresh token 不再需要 —— 留着只会在下次 refresh 又被当 body fallback
      // 重新提交,徒增 XSS 时被 dump 的可能。一次性清零。
      if (legacyBody) {
        localStorage.removeItem('openclaude_refresh_token')
        state.refreshToken = ''
      }
    } catch {}
    return { ok: true, race: false }
  }
  // 401 + REFRESH_RACE = 多 tab race,server 没清 cookie,稍后 retry 一次
  // 大概率因为浏览器已收到 sibling tab 的 set-cookie 而成功。
  // R3 finding: 后端标准错误体是 { error: { code, ... } },不是顶层 code。
  // 必须经 _readStdError 解析,否则 race 永远 false → bounded retry 死代码。
  let race = false
  if (r.status === 401) {
    try {
      const errBody = await r.json()
      const std = _readStdError(errBody)
      if (std.code === 'REFRESH_RACE') race = true
    } catch {}
  }
  return { ok: false, race }
}

// race grace 内 bounded retry:server 默认 grace=10s,我们用约一半时间
// (250/500/1000/1500/1750 共 5 次 retry,累计 ~5s)。这样 sibling tab
// 即使比平时慢几倍仍能覆盖,但不会无限等(避免在 grace 已过的情况下
// 把 INVALID_REFRESH 也轮询过去 — 内部 if (!last.race) 会即时退出)。
// R3 finding 加固:R2 用的 [250,500,1000,2000] 累计 3.75s 偏短。
const _RACE_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 1750]

function _silentRefresh() {
  if (_refreshInflight) return _refreshInflight
  _refreshInflight = (async () => {
    try {
      let last = await _doRefreshOnce()
      if (last.ok) return true
      if (!last.race) return false
      for (const delay of _RACE_RETRY_DELAYS_MS) {
        await new Promise(r => setTimeout(r, delay))
        last = await _doRefreshOnce()
        if (last.ok) return true
        // 中途 server 停 race(如 grace 已过 → INVALID_REFRESH)直接放弃
        if (!last.race) return false
      }
      return false
    } catch {
      return false
    }
  })().finally(() => { _refreshInflight = null })
  return _refreshInflight
}

function _isAuthEndpoint(path) {
  // Don't refresh-loop on auth endpoints themselves
  if (typeof path !== 'string') return false
  return path.startsWith('/api/auth/login')
      || path.startsWith('/api/auth/refresh')
      || path.startsWith('/api/auth/logout')
      || path.startsWith('/api/auth/register')
      || path.startsWith('/api/auth/verify-email')
      || path.startsWith('/api/auth/resend-verification')
      || path.startsWith('/api/auth/request-password-reset')
      || path.startsWith('/api/auth/confirm-password-reset')
}

// Rewrite Authorization header on retry. Caller may pass init.headers as plain
// object OR as Headers; we normalize to plain object since most callers do.
function _rewriteAuthHeader(headers) {
  if (!headers) return { Authorization: `Bearer ${state.token}` }
  if (headers instanceof Headers) {
    const out = {}
    headers.forEach((v, k) => { out[k] = v })
    out.Authorization = `Bearer ${state.token}`
    return out
  }
  return { ...headers, Authorization: `Bearer ${state.token}` }
}

// Low-level fetch wrapper. Exposes the raw Response so callers that care
// about streaming, status codes, or custom parsing can still use it.
export async function apiFetch(path, init = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    signal: userSignal,
    suppressAuthRedirect = false,
    _attemptedRefresh = false,
    ...rest
  } = init
  const { signal, cleanup } = _composeSignal(userSignal, timeout)
  let res
  try {
    res = await fetch(path, { ...rest, signal })
  } finally {
    cleanup()
  }
  if (res.status !== 401) return res
  // Auth endpoint or already retried → propagate 401 + maybe trigger logout。
  // 注意:HIGH#4 之后 refresh token 在 HttpOnly cookie 里,JS 看不到 → 不能再像
  // 旧版那样 "!state.refreshToken 直接放弃 refresh"。无脑 try 一次,失败再走
  // _notifyAuthExpired,代价就是无 cookie 的访客也会多一次 /api/auth/refresh
  // 401(同源,无业务副作用)。
  if (_attemptedRefresh || _isAuthEndpoint(path)) {
    if (!suppressAuthRedirect) _notifyAuthExpired()
    return res
  }
  if (suppressAuthRedirect) {
    // Caller explicitly opted out of redirect — don't refresh either, just return.
    return res
  }
  // Try one refresh + retry
  const refreshed = await _silentRefresh()
  if (!refreshed) {
    _notifyAuthExpired()
    return res
  }
  // Retry once with the new access token. Reuse caller's init (sans signal/timeout
  // bookkeeping) and replace Authorization header.
  return apiFetch(path, {
    ...rest,
    timeout,
    signal: userSignal,
    suppressAuthRedirect,
    _attemptedRefresh: true,
    headers: _rewriteAuthHeader(rest.headers),
  })
}

export async function apiGet(path, opts = {}) {
  const res = await apiFetch(path, { ...opts, headers: authHeaders(opts.headers) })
  if (!res.ok) {
    const msg = await _extractErrorMessage(res)
    throw _httpError(`GET ${path}`, res.status, msg)
  }
  return res.json()
}

export async function apiJson(method, path, body, opts = {}) {
  const res = await apiFetch(path, {
    ...opts,
    method,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(opts.headers || {}) }),
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const std = _readStdError(data)
    throw _httpError(`${method} ${path}`, res.status, std.message ?? std.code, std.code, std.issues)
  }
  return data
}
