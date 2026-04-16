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

// Low-level fetch wrapper. Exposes the raw Response so callers that care
// about streaming, status codes, or custom parsing can still use it.
export async function apiFetch(path, init = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    signal: userSignal,
    suppressAuthRedirect = false,
    ...rest
  } = init
  const { signal, cleanup } = _composeSignal(userSignal, timeout)
  try {
    const res = await fetch(path, { ...rest, signal })
    if (res.status === 401 && !suppressAuthRedirect) _notifyAuthExpired()
    return res
  } finally {
    cleanup()
  }
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
