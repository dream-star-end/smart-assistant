// OpenClaude — Application state
export const state = {
  token: localStorage.getItem('openclaude_token') || '',
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
