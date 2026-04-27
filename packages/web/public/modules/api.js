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
import { _writeStoredAccessToken, state } from './state.js?v=786e500'

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

function _httpError(label, status, msg, code, issues, requestId) {
  const e = new Error(msg ? `${label} failed: ${status} ${msg}` : `${label} failed: ${status}`)
  e.status = status
  if (code) e.code = code
  if (issues) e.issues = issues
  if (requestId) e.requestId = requestId
  return e
}

// 后端标准错误体: { error: { code, message, request_id, issues? } }
// 旧/legacy 兼容: { error: string } 或 { message: string }
//
// requestId 从 2026-04-23 前端改造开始 end-to-end 打通 —— catch 分支 e.requestId
// 可直接塞进 toast 尾徽章,用户点一下就复制,运维用这串能精确回 grep journalctl。
function _readStdError(d) {
  if (!d || typeof d !== 'object') {
    return { code: undefined, message: undefined, issues: undefined, requestId: undefined }
  }
  if (d.error && typeof d.error === 'object') {
    return {
      code: typeof d.error.code === 'string' ? d.error.code : undefined,
      message: typeof d.error.message === 'string' ? d.error.message : undefined,
      issues: Array.isArray(d.error.issues) ? d.error.issues : undefined,
      requestId: typeof d.error.request_id === 'string' ? d.error.request_id : undefined,
    }
  }
  if (typeof d.error === 'string') {
    return { code: undefined, message: d.error, issues: undefined, requestId: undefined }
  }
  if (typeof d.message === 'string') {
    return { code: undefined, message: d.message, issues: undefined, requestId: undefined }
  }
  return { code: undefined, message: undefined, issues: undefined, requestId: undefined }
}

// 诊断面包屑环形 buffer:前端最近 N 条 API 错误,用于"复制诊断信息"按钮
// dump 给 admin。裸 Error.message 不够,这里带完整 route/status/code/requestId。
// WS 帧解析/派发异常只打 console.warn —— 为避免把 outbound.message 里的用户输入
// /模型输出误入诊断 dump,目前不接入 _diagBuffer(见 websocket.js onmessage)。
const _DIAG_MAX = 50
const _diagBuffer = []
function _pushDiag(entry) {
  _diagBuffer.push({ ts: Date.now(), ...entry })
  if (_diagBuffer.length > _DIAG_MAX) _diagBuffer.shift()
}
export function snapshotDiagnostics() {
  return _diagBuffer.slice()
}

// 统一结构化 log:non-2xx 路径都走这里,前端 F12 截图即可作为工单线索。
function _logApiError(ctx) {
  try {
    console.error('[api]', ctx)
  } catch {}
  _pushDiag({ kind: 'api', ...ctx })
}

async function _readStdErrorFromRes(res) {
  try {
    const d = await res.clone().json()
    return _readStdError(d)
  } catch {
    return { code: undefined, message: undefined, issues: undefined, requestId: undefined }
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
// 2026-04-22 Codex R3:inflight 必须按 authEpoch 绑定 —— 不同身份不能共享 inflight
// promise(否则新身份起的 refresh 会复用旧身份的响应)。同 epoch 多并发仍然合并
// 成一次网络调用。finally 里只清 "如果还是我" 的槽位,防止旧 inflight 归零时把
// 新 inflight 的引用误清。
let _refreshInflight = null // { epoch, promise }
// 2026-04-22 Codex R3 E 缓解:refresh fetch 挂 AbortController 的 signal,身份
// 变更(login/logout/tearDown)路径 call abortInflightRefresh() 发 abort,让浏览器
// 终止正在路上的请求 —— 最大限度减少旧 refresh 响应的 Set-Cookie 覆盖新账号
// oc_rt cookie 的时间窗。注:浏览器 header 解析和 cookie jar 更新是原子的,
// 已完成 response header 的 Set-Cookie 仍可能生效,这是前端能做到的最稳方案;
// 彻底解决需要后端对 refresh/logout rotate race 做 revision 化(follow-up)。
let _refreshAbort = null

export function abortInflightRefresh() {
  try {
    _refreshAbort?.abort(new DOMException('auth epoch changed', 'AbortError'))
  } catch {}
}

// 单次 refresh 调用(不含 race retry)。expectedEpoch 由 caller 传入,绑定整个
// _silentRefresh() 生命周期 —— 这样 retry 循环跨多次 _doRefreshOnce 仍然对齐
// 同一个起始身份,避免 retry N+1 在 retry N 和 N+1 之间发生的身份变更中捡到
// 新 epoch 后 commit(R3 finding C)。
async function _doRefreshOnce(expectedEpoch) {
  const legacyBody = state.refreshToken
    ? JSON.stringify({ refresh_token: state.refreshToken })
    : undefined
  let r
  try {
    r = await fetch('/api/auth/refresh', {
      method: 'POST',
      // same-origin 是默认值,显式写出来表明"我们依赖浏览器自动带 cookie"。
      credentials: 'same-origin',
      headers: legacyBody ? { 'Content-Type': 'application/json' } : undefined,
      body: legacyBody,
      signal: _refreshAbort?.signal,
    })
  } catch (err) {
    // 2026-04-22 Codex R4:三种 abort 情况都不走 race retry,让 _silentRefresh
    // 立即 bail:
    //   1) AbortError — 身份变更主动 abort(_forceLogout / login / _tearDownWsAuth)
    //   2) TimeoutError — _silentRefresh 自己挂的 30s 兜底 timer 到期(见下方)
    //   3) 其他网络异常 — DNS fail / connection refused 等,race retry 也救不了
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError'
    return { ok: false, race: false, aborted }
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({}))
    if (typeof data?.access_token !== 'string' || !data.access_token) {
      return { ok: false, race: false }
    }
    const newExp = typeof data.access_exp === 'number' ? data.access_exp : null
    // ① Epoch check 在 commit 前:当前 epoch 和 caller 预期的不一致 → 身份已变,
    // 抛弃响应,不写 state.token / localStorage。Codex 强调:必须先做 epoch 再做 stale,
    // 否则旧 epoch 的响应会借 stale 路径返回 ok:true,绕过 epoch fence 语义。
    if ((state.authEpoch || 0) !== expectedEpoch) {
      return { ok: false, race: false }
    }
    // ② Stale-response guard(M5):同 epoch 多个并发 refresh(本 tab 主动 + reactive
    // 撞了 / 跨 tab 广播 + 本 tab race retry)收到一个旧响应时,旧 access_exp <= 当前
    // state.tokenExp。整个响应丢弃:不写 state、不写 storage、不 mint cookie、不广播。
    // 否则会把已被广播 / race winner 更新的新 token 覆盖回旧的。
    if (state.token && newExp != null && newExp <= (state.tokenExp || 0)) {
      return { ok: true, race: false }
    }
    state.token = data.access_token
    if (newExp != null) state.tokenExp = newExp
    // Codex R1:reactive refresh 成功后也重排主动续期 timer,让下一次主动续期
    // 对齐新 exp —— 避免 timer 还按旧 exp 排期,和 reactive 路径状态打架。
    scheduleProactiveRefresh()
    const remember = data?.remember !== false
    try {
      // 2026-04-24 "记住我":server 把原登录选择(refresh_tokens.remember_me)
      // 回带,前端据此决定 access token 写入 localStorage(持久)还是
      // sessionStorage(关窗口即清)。data.remember 缺失(老 server 或迁移期
      // 老 body)→ 默认 true,等同旧行为。
      _writeStoredAccessToken(data.access_token, newExp, remember)
      // 升级成功:server 已把 cookie 种回来,本地 localStorage / state 里的旧
      // refresh token 不再需要 —— 留着只会在下次 refresh 又被当 body fallback
      // 重新提交,徒增 XSS 时被 dump 的可能。一次性清零。
      if (legacyBody) {
        localStorage.removeItem('openclaude_refresh_token')
        state.refreshToken = ''
      }
    } catch {}
    // V3 file-proxy:access JWT 已轮换,oc_session cookie 也跟着对应的 exp 续期。
    // fire-and-forget,避免阻塞 401-retry pipeline。传入 expectedEpoch = 本次
    // refresh 绑定的 myEpoch —— mint 响应回来后若 epoch 变过会 self-clear,
    // 防止旧身份的 session cookie 被新身份 inheritance。
    // 用 dynamic import 避开与 auth.js 的循环依赖(auth.js 也 import 了 api.js)。
    void import('./auth.js?v=786e500')
      .then(({ mintSessionCookie }) => {
        mintSessionCookie(data.access_token, expectedEpoch).catch(() => {})
      })
      .catch(() => {})
    // M5:广播给同源其他 tab,让它们直接接管新 token,免去各自再打 /api/auth/refresh。
    // userId 缺失(早期 race,/api/me 还没回)时 publishTokenRefresh 内部会 skip,
    // 不广播是安全降级 —— 接收方走 reactive 401 兜底。fire-and-forget。
    if (state.userId != null) {
      void import('./broadcast.js?v=786e500')
        .then(({ publishTokenRefresh }) => {
          publishTokenRefresh({
            access_token: data.access_token,
            access_exp: newExp,
            remember,
            userId: state.userId,
          })
        })
        .catch(() => {})
    }
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

// Exported for non-fetch callers (e.g. websocket.js needs to refresh the
// access token after a 1008 close without falling through to showLogin).
// Returns Promise<boolean>:true = state.token now holds a fresh access JWT.
// Shares the same inflight promise as apiFetch's internal 401-retry path,
// so a burst of HTTP 401 + WS 1008 only fires one /api/auth/refresh.
export function silentRefresh() {
  return _silentRefresh()
}

// ── Proactive refresh timer ──
//
// 2026-04-23:手机浏览器长时间后台回来被踢登录问题。原架构是反应式——等 401/WS 1008
// 再 silentRefresh。手机 resume 瞬间多个入口(WS 重连 / maybeSyncNow / mintSessionCookie
// / restore 请求)并发用旧 expired token 打请求,并发 401 撞上 _tearDownWsAuth /
// _notifyAuthExpired 就会误踢登录。
//
// 主动式:tab 活着时,access token 到期前 2 分钟就续一次,reactive 路径只是兜底。
// 手机后台 timer 被浏览器挂起无副作用,靠 visibilitychange 路径补刷(见 main.js)。
//
// Codex R1:
//   - callback 执行时重新检查 tokenExp—— resume 时挂起的 setTimeout 可能被立即补跑,
//     若 visibility 路径已先刷新过,旧 callback 不该再打一次 refresh
//   - _doRefreshOnce 成功后也顺手重排 timer,让 reactive refresh 后的下一次主动续期
//     对齐新 exp,状态不漂
const PROACTIVE_REFRESH_LEAD_SECONDS = 120 // 到期前 2min 续,留 race grace 余量
const PROACTIVE_REFRESH_RETRY_MS = 60_000 // 失败后 1min 重试
let _proactiveTimer = null

function _cancelProactiveTimer() {
  if (_proactiveTimer) {
    clearTimeout(_proactiveTimer)
    _proactiveTimer = null
  }
}

export function clearProactiveRefresh() {
  _cancelProactiveTimer()
}

export function scheduleProactiveRefresh() {
  _cancelProactiveTimer()
  if (!state.token || !state.tokenExp) return
  const nowSec = Math.floor(Date.now() / 1000)
  const secondsUntil = state.tokenExp - nowSec - PROACTIVE_REFRESH_LEAD_SECONDS
  // 已过了预警窗口(或本身已过期)→ 立即跑一次;否则按预警时间排
  const delayMs = Math.max(0, secondsUntil) * 1000
  _proactiveTimer = setTimeout(() => {
    _proactiveTimer = null
    void _runProactiveRefresh()
  }, delayMs)
}

async function _runProactiveRefresh() {
  // Callback 保护:手机浏览器 resume 时被压抑的 setTimeout 可能立即补跑,
  // 若 visibility 路径已先刷过,tokenExp 此刻距今天已远,不该再打一次 refresh。
  if (!state.token) return
  // Codex R2:绑启动时的 epoch。_silentRefresh() await 期间用户可能切账号
  // (_forceLogout → new login),旧 run 返回时看到新账号的 state.token 会给新账号
  // 错误地排 60s retry timer,覆盖 login 分支刚排好的正确 timer handle。
  const epochAtStart = state.authEpoch || 0
  const nowSec = Math.floor(Date.now() / 1000)
  const secondsUntil = (state.tokenExp || 0) - nowSec
  if (secondsUntil > PROACTIVE_REFRESH_LEAD_SECONDS) {
    // 已被别的路径刷过,按新 exp 重排即可
    scheduleProactiveRefresh()
    return
  }
  const ok = await _silentRefresh().catch(() => false)
  if (!state.token) return // 期间被 _forceLogout / _tearDownWsAuth 清了
  if ((state.authEpoch || 0) !== epochAtStart) return // 身份变了,别碰新账号的 timer
  if (ok) {
    // 按新 tokenExp 重排
    scheduleProactiveRefresh()
  } else {
    // 失败不 teardown —— 保留 state.token 给 apiFetch 的 401 路径再试;
    // 1 min 后重试主动路径。真 cookie 丢了会在反应式路径走 _forceLogout。
    // 先 cancel 兜底:虽然进入这条分支时 _proactiveTimer 理应已是 null(schedule/run
    // 两处都会清),但显式 cancel 更稳,避免任何 future race 泄漏 timer。
    _cancelProactiveTimer()
    _proactiveTimer = setTimeout(() => {
      _proactiveTimer = null
      void _runProactiveRefresh()
    }, PROACTIVE_REFRESH_RETRY_MS)
  }
}

function _silentRefresh() {
  const myEpoch = state.authEpoch || 0
  // 同 epoch 且还有 inflight → 合并。跨 epoch 不合并(旧 inflight 注定被 abort/
  // 拒绝,新的得独立跑)。
  if (_refreshInflight && _refreshInflight.epoch === myEpoch) {
    return _refreshInflight.promise
  }
  const myAbort = new AbortController()
  // 2026-04-22 Codex R4:refresh fetch 没 timeout,网络层卡住会让 WS IIFE
  // 永远等,`_wsAuthRefreshInFlight` 一直 true,所有 connect 入口都被 gate,
  // 用户停在 "会话续期中…" —— WS 状态机卡死。30s 兜底:到期主动 abort fetch,
  // `_doRefreshOnce` 的 catch 识别 TimeoutError 为 aborted,_silentRefresh bail,
  // WS IIFE 收尾走 _tearDownWsAuth → showLogin,比挂住好。
  const refreshTimer = setTimeout(() => {
    try {
      myAbort.abort(new DOMException('refresh timeout', 'TimeoutError'))
    } catch {}
  }, DEFAULT_TIMEOUT_MS)
  _refreshAbort = myAbort
  const promise = (async () => {
    try {
      let last = await _doRefreshOnce(myEpoch)
      if (last.ok) return true
      if (last.aborted) return false
      if (!last.race) return false
      for (const delay of _RACE_RETRY_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay))
        // 每次 delay 后先 check epoch,身份变了立即 bail —— 即便本次还会走 fetch
        // 拿到 200,也会被 _doRefreshOnce 内 epoch check 拦下;这里提前退出
        // 省掉一次网络调用。
        if ((state.authEpoch || 0) !== myEpoch) return false
        last = await _doRefreshOnce(myEpoch)
        if (last.ok) return true
        if (last.aborted) return false
        // 中途 server 停 race(如 grace 已过 → INVALID_REFRESH)直接放弃
        if (!last.race) return false
      }
      return false
    } catch {
      return false
    }
  })().finally(() => {
    // R4 timeout timer 一定要清(成功 / race bail / abort 三条出路都得走这里),
    // 否则 30s 后 abort 一个已经 resolve 的 AbortController 虽无副作用,但若 finally
    // 之后用户又起新 refresh,arr myAbort 已无引用 —— 仍然不会误 abort,但 timer
    // 本身占资源,及时清干净。
    clearTimeout(refreshTimer)
    // 只清 "是我" 的槽位,防止旧 inflight 归零时踩掉已经创建的新 inflight。
    if (_refreshInflight?.promise === promise) _refreshInflight = null
    if (_refreshAbort === myAbort) _refreshAbort = null
  })
  _refreshInflight = { epoch: myEpoch, promise }
  return promise
}

function _isAuthEndpoint(path) {
  // Don't refresh-loop on auth endpoints themselves
  if (typeof path !== 'string') return false
  return (
    path.startsWith('/api/auth/login') ||
    path.startsWith('/api/auth/refresh') ||
    path.startsWith('/api/auth/logout') ||
    path.startsWith('/api/auth/register') ||
    path.startsWith('/api/auth/verify-email') ||
    path.startsWith('/api/auth/resend-verification') ||
    path.startsWith('/api/auth/request-password-reset') ||
    path.startsWith('/api/auth/confirm-password-reset')
  )
}

// Rewrite Authorization header on retry. Caller may pass init.headers as plain
// object OR as Headers; we normalize to plain object since most callers do.
function _rewriteAuthHeader(headers) {
  if (!headers) return { Authorization: `Bearer ${state.token}` }
  if (headers instanceof Headers) {
    const out = {}
    headers.forEach((v, k) => {
      out[k] = v
    })
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
    const std = await _readStdErrorFromRes(res)
    _logApiError({
      route: path,
      method: 'GET',
      status: res.status,
      code: std.code,
      requestId: std.requestId,
      message: std.message,
    })
    throw _httpError(
      `GET ${path}`,
      res.status,
      std.message ?? std.code,
      std.code,
      std.issues,
      std.requestId,
    )
  }
  return res.json()
}

// 同 apiGet,但响应体读成 text —— /api/admin/metrics 这种 Prometheus 格式走这里。
// 过去 health 页直接 apiFetch + `throw new Error("HTTP " + status)`,rich error
// (code / request_id)全丢,toast 尾徽章拿不到 reqId。codex R2 #2 要求改走 std 路径。
export async function apiText(path, opts = {}) {
  const res = await apiFetch(path, { ...opts, headers: authHeaders(opts.headers) })
  if (!res.ok) {
    const std = await _readStdErrorFromRes(res)
    _logApiError({
      route: path,
      method: 'GET',
      status: res.status,
      code: std.code,
      requestId: std.requestId,
      message: std.message,
    })
    throw _httpError(
      `GET ${path}`,
      res.status,
      std.message ?? std.code,
      std.code,
      std.issues,
      std.requestId,
    )
  }
  return res.text()
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
    _logApiError({
      route: path,
      method,
      status: res.status,
      code: std.code,
      requestId: std.requestId,
      message: std.message,
    })
    throw _httpError(
      `${method} ${path}`,
      res.status,
      std.message ?? std.code,
      std.code,
      std.issues,
      std.requestId,
    )
  }
  return data
}
