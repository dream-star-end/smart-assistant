// OpenClaude — Application state
//
// Token storage (Phase 4A → 2026-04-21 安全审计 HIGH#4):
//   - state.token         = access JWT (short-lived, ~15min) — sent as Bearer
//   - state.tokenExp      = unix seconds when access expires (proactive pre-expiry refresh)
//   - refresh token       = HttpOnly cookie (oc_rt, Path=/api/auth, SameSite=Strict)
//                           浏览器自动随 /api/auth/* 携带,JS 读不到、写不到。
//
// 迁移期(2 周):state.refreshToken 仅用来"消费"老用户 localStorage 里残留的 refresh token,
// 让他们在升级后第一次 silentRefresh / logout 还能走 body 兼容路径,server 同时把 cookie
// 种回去之后,localStorage 立刻清掉。新登录不再产生这个字段。
//
// 2026-04-24 "记住我" 语义:
//   - 勾选 (remember=true,默认)→ access token 存 localStorage(持久,关浏览器还在)
//   - 不勾(remember=false)→ access token 存 sessionStorage(会话 only,关窗口即清)
// refresh token 是 HttpOnly cookie,persistent 属性也跟着 remember 走(handlers.ts)。
// 两边必须同生命周期 —— 如果 access 存 localStorage 但 cookie 是 session,关浏览器后
// access 还在、cookie 没了,刷新走不通;反之亦然。

/**
 * 读取 access token(冷启动 / 刷新页面时)。
 * 优先 localStorage(持久会话),回退 sessionStorage("不记住我")。
 * 不会同时读取两个,避免身份漂移。
 */
export function _readStoredAccessToken() {
  const tokL = localStorage.getItem('openclaude_access_token') || ''
  if (tokL) {
    return {
      token: tokL,
      exp: Number(localStorage.getItem('openclaude_access_exp') || '0') || 0,
    }
  }
  return {
    token: sessionStorage.getItem('openclaude_access_token') || '',
    exp: Number(sessionStorage.getItem('openclaude_access_exp') || '0') || 0,
  }
}

/**
 * 写入 access token。根据 remember 决定 storage,并清对侧以避免双写出现脏数据
 * (例如 remember=true→false 切换时 localStorage 老值残留会让冷启动读到错的身份)。
 */
export function _writeStoredAccessToken(token, exp, remember) {
  // 清对侧
  try {
    sessionStorage.removeItem('openclaude_access_token')
    sessionStorage.removeItem('openclaude_access_exp')
  } catch {}
  try {
    localStorage.removeItem('openclaude_access_token')
    localStorage.removeItem('openclaude_access_exp')
  } catch {}
  const store = remember === false ? sessionStorage : localStorage
  try {
    store.setItem('openclaude_access_token', token || '')
    if (exp != null) store.setItem('openclaude_access_exp', String(exp))
  } catch {}
}

/** 退出登录 / auth-expired 时清两处,防止漏清导致冷启动又被认证。 */
export function _clearStoredAccessToken() {
  for (const s of [localStorage, sessionStorage]) {
    try { s.removeItem('openclaude_access_token') } catch {}
    try { s.removeItem('openclaude_access_exp') } catch {}
  }
}

// 冷启动读取:localStorage 优先,其次 sessionStorage,最后回退老 openclaude_token。
// 旧 `openclaude_token` 单 bearer 自动迁移到 access_token,避免老 personal-version 用户被踢。
const _legacy = localStorage.getItem('openclaude_token') || ''
if (_legacy && !localStorage.getItem('openclaude_access_token')) {
  localStorage.setItem('openclaude_access_token', _legacy)
  localStorage.removeItem('openclaude_token')
}
const _initial = _readStoredAccessToken()
const _access = _initial.token || _legacy || ''
export const state = {
  token: _access,
  // HIGH#4 迁移期:仅承载 localStorage 里的旧 refresh token,api.js 用完一次后清空。
  // 新 login 不再写它(refresh token 走 HttpOnly cookie)。
  refreshToken: localStorage.getItem('openclaude_refresh_token') || '',
  tokenExp: _initial.exp || (Number(localStorage.getItem('openclaude_access_exp') || '0') || 0),
  // 2026-04-22 Codex R2 finding:silentRefresh 的异步期间可能跟 _forceLogout /
  // 登另一个账号撞车,导致旧 refresh 响应回来时把已经 logout/切换的 state.token
  // 又写回来。每次 login 成功 / _forceLogout / _tearDownWsAuth 递增这个计数,
  // _doRefreshOnce 在 commit 前比对,epoch 变了就丢掉响应,别覆盖当前身份。
  // 仅 in-memory:新 tab 从 0 起不会干扰其他 tab(那边独立 JS 上下文)。
  authEpoch: 0,
  // 2026-04-21 安全审计 HIGH#F1:changelog_seen / user-bucketed localStorage 此前
  // 用 `state.token.slice(-8)` 做身份桶,但 JWT 末 8 字节并非稳定身份(每次
  // refresh 会变成新 JWT,导致 "已读标志" 在同一用户下反复丢失)。改用真实
  // user.id(来自 /api/me)。refreshBalance 成功时由 billing.js 写入。
  userId: null,
  ws: null,
  wsStatus: 'disconnected',
  sessions: new Map(),
  currentSessionId: null,
  reconnectTimer: null,
  sendingInFlight: false,
  agentsList: [],
  defaultAgentId: 'main',
  attachments: [],
  recognition: null,
  recognizing: false,
  windowFocused: document.hasFocus(),
  offlineQueue: [], // messages queued while disconnected
}

// P2-24 — offlineQueue 软上限。
// 长时间离线下用户狂发,offlineQueue 无界堆积会:1) 占内存 2) 重连后一次性 drain
// 卡死 UI / 后端。设 200 条,达到时拒收新消息,UI 提示重试。
// _offlineQueuePending 不计入(那是正在 drain 的副本,不会无限增长)。
export const MAX_OFFLINE_QUEUE = 200
export function tryEnqueueOffline(item) {
  if (state.offlineQueue.length >= MAX_OFFLINE_QUEUE) return false
  state.offlineQueue.push(item)
  return true
}

export function getSession(id) {
  return state.sessions.get(id || state.currentSessionId)
}

export function isSending() {
  const sess = getSession()
  return sess?._sendingInFlight || false
}

export function setSending(val) {
  const sess = getSession()
  if (sess) sess._sendingInFlight = val
  state.sendingInFlight = val
}
