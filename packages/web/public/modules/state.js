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
