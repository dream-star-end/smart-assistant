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

function _httpError(label, status, msg) {
  const e = new Error(msg ? `${label} failed: ${status} ${msg}` : `${label} failed: ${status}`)
  e.status = status
  return e
}

async function _extractErrorMessage(res) {
  try {
    const d = await res.clone().json()
    return d?.error || d?.message
  } catch {
    return undefined
  }
}

// ── V3 commercial: silent refresh on 401 ──
//
// Behavior:
//   • On 401, attempt POST /api/auth/refresh once with state.refreshToken;
//     if it returns a new access_token, retry the original request once.
//   • Concurrent 401s share a single in-flight refresh promise (_refreshInflight)
//     so 5 parallel calls don't all spam the refresh endpoint.
//   • If refresh fails (no token / 4xx) → fall through to _notifyAuthExpired
//     and the caller sees the original 401 response.
//   • Skipped for /api/auth/* paths to avoid recursion (login/refresh/logout
//     legitimately return 401 and we don't want to refresh-loop on them).
//   • Skipped when caller passes suppressAuthRedirect=true (login/probe paths).
//   • Skipped on the retry pass itself (set _attemptedRefresh on the init).
let _refreshInflight = null
function _silentRefresh() {
  if (_refreshInflight) return _refreshInflight
  // Lazy-import to avoid an import cycle (state.js doesn't import api.js, but
  // some modules may transitively).
  _refreshInflight = (async () => {
    if (!state.refreshToken) return false
    try {
      const r = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: state.refreshToken }),
      })
      if (!r.ok) return false
      const data = await r.json().catch(() => ({}))
      if (typeof data?.access_token !== 'string' || !data.access_token) return false
      state.token = data.access_token
      if (typeof data.access_exp === 'number') state.tokenExp = data.access_exp
      try {
        localStorage.setItem('openclaude_access_token', data.access_token)
        if (typeof data.access_exp === 'number') {
          localStorage.setItem('openclaude_access_exp', String(data.access_exp))
        }
      } catch {}
      return true
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
  // Auth endpoint or already retried → propagate 401 + maybe trigger logout
  if (_attemptedRefresh || _isAuthEndpoint(path) || suppressAuthRedirect === false && !state.refreshToken) {
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
  if (!res.ok) throw _httpError(`${method} ${path}`, res.status, data?.error || data?.message)
  return data
}
