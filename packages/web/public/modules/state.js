// OpenClaude — Application state
//
// Token storage (Phase 4A, v3 commercial):
//   - state.token         = access JWT (short-lived, ~15min) — sent as Bearer
//   - state.refreshToken  = refresh JWT (long-lived, ~30d)   — used by api.js auto-refresh
//   - state.tokenExp      = unix seconds when access expires (proactive pre-expiry refresh)
//
// localStorage keys (kept stable so a user reload restores session):
//   openclaude_access_token / openclaude_refresh_token / openclaude_access_exp
//
// Legacy `openclaude_token` (single bearer) is migrated on read so existing personal-version
// users don't get logged out by an upgrade. New writes ONLY use the new keys.
const _legacy = localStorage.getItem('openclaude_token') || ''
const _access = localStorage.getItem('openclaude_access_token') || _legacy || ''
if (_legacy && !localStorage.getItem('openclaude_access_token')) {
  localStorage.setItem('openclaude_access_token', _legacy)
  localStorage.removeItem('openclaude_token')
}
export const state = {
  token: _access,
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
