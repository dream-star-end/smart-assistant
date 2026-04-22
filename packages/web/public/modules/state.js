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
// localStorage 仍存:openclaude_access_token / openclaude_access_exp。
// 旧 `openclaude_token` 单 bearer 自动迁移到 access_token,避免老 personal-version 用户被踢。
const _legacy = localStorage.getItem('openclaude_token') || ''
const _access = localStorage.getItem('openclaude_access_token') || _legacy || ''
if (_legacy && !localStorage.getItem('openclaude_access_token')) {
  localStorage.setItem('openclaude_access_token', _legacy)
  localStorage.removeItem('openclaude_token')
}
export const state = {
  token: _access,
  // HIGH#4 迁移期:仅承载 localStorage 里的旧 refresh token,api.js 用完一次后清空。
  // 新 login 不再写它(refresh token 走 HttpOnly cookie)。
  refreshToken: localStorage.getItem('openclaude_refresh_token') || '',
  tokenExp: Number(localStorage.getItem('openclaude_access_exp') || '0') || 0,
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
